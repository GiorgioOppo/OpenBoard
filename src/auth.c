/* OpenBoard account, session and board authorization. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "auth.h"
#include "storage.h"
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define PASSWORD_ITERATIONS 600000
#define SESSION_LIFETIME (8 * 60 * 60)
#define SESSION_IDLE (30 * 60)
#define SESSION_TOUCH_INTERVAL 60
#define RATE_WINDOW 300
#define RATE_ROWS 4
#define RATE_PEER_SLOTS 2048
#define RATE_USER_SLOTS 8192

/* Fixed-size count-min counters reserve attempts before password work. Four
 * keyed indices make accidental sharing unlikely. Collisions
 * can only reject too early, never reset a quota or admit extra attempts. No
 * pool of account names can fill up and deny unrelated clients globally. */
typedef struct { time_t window; unsigned attempts; } RateCounter;
static RateCounter peer_rates[RATE_ROWS * RATE_PEER_SLOTS];
static RateCounter user_rates[RATE_ROWS * RATE_USER_SLOTS];
static unsigned char rate_secret[32];
static bool rate_seeded;
static time_t rate_current_window;
static pthread_mutex_t rate_mutex = PTHREAD_MUTEX_INITIALIZER;

static bool is_write(const Request *r) {
    return strcmp(r->method, "GET") && strcmp(r->method, "HEAD") && strcmp(r->method, "OPTIONS");
}
static bool role_valid(const char *role) {
    return role && (!strcmp(role, "admin") || !strcmp(role, "member") || !strcmp(role, "observer"));
}
static bool has_text(const char *value) {
    for (; value && *value; value++) if (!isspace((unsigned char)*value)) return true;
    return false;
}
static bool username_valid(char *username) {
    size_t n = username ? strlen(username) : 0;
    if (n < 3 || n > 64) return false;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)username[i];
        if (c >= 'A' && c <= 'Z') c = (unsigned char)(c + ('a' - 'A'));
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
        username[i] = (char)c;
    }
    return true;
}
static bool password_valid(const char *password) {
    size_t n = password ? strlen(password) : 0;
    return n >= 12 && n <= 256 && valid_utf8(password, n);
}
static void secret_free(char *value) {
    if (value) { OPENSSL_cleanse(value, strlen(value)); ob_free(value); }
}
static void hex_encode(const unsigned char *data, size_t length, char *out) {
    static const char alphabet[] = "0123456789abcdef";
    for (size_t i = 0; i < length; i++) { out[i * 2] = alphabet[data[i] >> 4]; out[i * 2 + 1] = alphabet[data[i] & 15]; }
    out[length * 2] = 0;
}
static bool hex_decode(const char *text, unsigned char *out, size_t length) {
    if (!text || strlen(text) != length * 2) return false;
    for (size_t i = 0; i < length; i++) {
        unsigned value = 0;
        for (size_t j = 0; j < 2; j++) {
            unsigned char c = (unsigned char)text[i * 2 + j];
            if (c >= '0' && c <= '9') value = value * 16 + (c - '0');
            else if (c >= 'a' && c <= 'f') value = value * 16 + (c - 'a' + 10);
            else return false;
        }
        out[i] = (unsigned char)value;
    }
    return true;
}
static bool random_hex(char *out, size_t bytes) {
    unsigned char raw[32];
    if (bytes > sizeof raw || RAND_bytes(raw, (int)bytes) != 1) return false;
    hex_encode(raw, bytes, out); OPENSSL_cleanse(raw, sizeof raw); return true;
}
static bool token_digest(const char *token, char out[65]) {
    unsigned char digest[32]; unsigned length = 0;
    if (!EVP_Digest(token, strlen(token), digest, &length, EVP_sha256(), NULL) || length != sizeof digest) return false;
    hex_encode(digest, sizeof digest, out); OPENSSL_cleanse(digest, sizeof digest); return true;
}
static bool password_hash(const char *password, const char salt[33], char out[65]) {
    unsigned char raw_salt[16], result[32];
    if (!hex_decode(salt, raw_salt, sizeof raw_salt)) return false;
    bool ok = PKCS5_PBKDF2_HMAC(password, (int)strlen(password), raw_salt, sizeof raw_salt,
        PASSWORD_ITERATIONS, EVP_sha256(), sizeof result, result) == 1;
    if (ok) hex_encode(result, sizeof result, out);
    OPENSSL_cleanse(raw_salt, sizeof raw_salt); OPENSSL_cleanse(result, sizeof result); return ok;
}
static bool password_matches(const char *password, const char *salt, const char *expected) {
    char actual[65];
    bool ok = salt && expected && strlen(expected) == 64 && password_hash(password, salt, actual) &&
        CRYPTO_memcmp(actual, expected, 64) == 0;
    OPENSSL_cleanse(actual, sizeof actual); return ok;
}
static bool rate_indices(const char *key, size_t width, size_t indices[RATE_ROWS]) {
    unsigned char digest[EVP_MAX_MD_SIZE]; unsigned length = 0;
    bool ok = HMAC(EVP_sha256(), rate_secret, sizeof rate_secret,
        (const unsigned char *)key, strlen(key), digest, &length) != NULL && length == 32;
    if (ok) for (size_t row = 0; row < RATE_ROWS; row++) {
        size_t offset = row * 4;
        uint32_t hash = ((uint32_t)digest[offset] << 24) | ((uint32_t)digest[offset + 1] << 16) |
            ((uint32_t)digest[offset + 2] << 8) | digest[offset + 3];
        indices[row] = row * width + hash % width;
    }
    OPENSSL_cleanse(digest, sizeof digest); return ok;
}
static bool rate_available(RateCounter *rates, const size_t indices[RATE_ROWS], unsigned maximum, time_t now) {
    unsigned minimum = UINT_MAX;
    for (size_t row = 0; row < RATE_ROWS; row++) {
        RateCounter *entry = &rates[indices[row]];
        if (now != entry->window) {
            entry->window = now; entry->attempts = 0;
        }
        if (entry->attempts < minimum) minimum = entry->attempts;
    }
    return minimum < maximum;
}
static void rate_reserve(RateCounter *rates, const size_t indices[RATE_ROWS]) {
    for (size_t row = 0; row < RATE_ROWS; row++)
        if (rates[indices[row]].attempts < UINT_MAX) rates[indices[row]].attempts++;
}
static bool rate_allowed_at(const Request *r, const char *scope, const char *username, time_t now) {
    char user_key[180], peer_key[80];
    const char *peer = r->peer[0] ? r->peer : "local";
    snprintf(user_key, sizeof user_key, "user:%s|%s|%s", peer, scope, username ? username : "");
    snprintf(peer_key, sizeof peer_key, "peer:%s", peer);
    size_t peer_indices[RATE_ROWS], user_indices[RATE_ROWS];
    pthread_mutex_lock(&rate_mutex);
    /* A request sampled before the window boundary may acquire this mutex
     * after a newer request. Never let it roll counters back to an old window. */
    if (now < rate_current_window) now = rate_current_window;
    else rate_current_window = now;
    if (!rate_seeded) rate_seeded = RAND_bytes(rate_secret, sizeof rate_secret) == 1;
    bool ok = rate_seeded && rate_indices(peer_key, RATE_PEER_SLOTS, peer_indices) &&
        rate_indices(user_key, RATE_USER_SLOTS, user_indices) &&
        rate_available(peer_rates, peer_indices, 60, now) && rate_available(user_rates, user_indices, 10, now);
    if (ok) { rate_reserve(peer_rates, peer_indices); rate_reserve(user_rates, user_indices); }
    pthread_mutex_unlock(&rate_mutex); return ok;
}
static bool rate_allowed(const Request *r, const char *scope, const char *username) {
    struct timespec stamp;
    if (clock_gettime(CLOCK_MONOTONIC, &stamp) != 0) return false;
    /* Every row uses the same fixed monotonic five-minute window. A collision
     * must not expire one row early and let an existing key reset its quota. */
    return rate_allowed_at(r, scope, username, stamp.tv_sec / RATE_WINDOW);
}
static Response auth_error(int status, const char *message) {
    Response r = error_response(status, message);
    snprintf(r.headers, sizeof r.headers, "Cache-Control: no-store\r\n%s", status == 429 ? "Retry-After: 300\r\n" : "");
    return r;
}
/* Authentication owns a transaction or a nested savepoint, never commits a caller's transaction. */
typedef struct { bool outer, begun; } AuthTransaction;
static AuthTransaction transaction_begin(void) {
    AuthTransaction t = { sqlite3_get_autocommit(db) != 0, false };
    t.begun = sqlite3_exec(db, t.outer ? "BEGIN IMMEDIATE" : "SAVEPOINT auth_op", NULL, NULL, NULL) == SQLITE_OK;
    if (t.begun && !ob_storage_cache_write_allowed()) {
        sqlite3_exec(db, t.outer ? "ROLLBACK" : "ROLLBACK TO auth_op", NULL, NULL, NULL);
        if (!t.outer) sqlite3_exec(db, "RELEASE auth_op", NULL, NULL, NULL);
        t.begun = false;
    }
    return t;
}
static bool transaction_end(AuthTransaction t, bool ok) {
    if (!t.begun) return false;
    if (ok && sqlite3_exec(db, t.outer ? "COMMIT" : "RELEASE auth_op", NULL, NULL, NULL) == SQLITE_OK) return true;
    sqlite3_exec(db, t.outer ? "ROLLBACK" : "ROLLBACK TO auth_op", NULL, NULL, NULL);
    if (!t.outer) sqlite3_exec(db, "RELEASE auth_op", NULL, NULL, NULL);
    return false;
}
static int64_t count_users(void) {
    sqlite3_stmt *s = prepare("SELECT count(*) FROM users");
    int64_t n = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : -1;
    sqlite3_finalize(s); return n;
}
static bool board_exists(int64_t id) {
    sqlite3_stmt *s = prepare("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL"); sqlite3_bind_int64(s, 1, id);
    bool exists = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s); return exists;
}
void auth_schema(sqlite3 *connection) {
    static const char *schema =
        "CREATE TABLE IF NOT EXISTS users("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT NOT NULL COLLATE NOCASE UNIQUE,"
        "password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member' CHECK(role IN('admin','member','observer')),"
        "active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
        "CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
        "expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,created_at INTEGER NOT NULL);"
        "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);"
        "CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);"
        "CREATE TABLE IF NOT EXISTS board_members(board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,"
        "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN('admin','member','observer')),PRIMARY KEY(board_id,user_id));"
        "CREATE INDEX IF NOT EXISTS board_members_user ON board_members(user_id,board_id);"
        "CREATE TABLE IF NOT EXISTS user_stars(board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,"
        "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(board_id,user_id));";
    char *error = NULL;
    if (sqlite3_exec(connection, schema, NULL, NULL, &error) != SQLITE_OK) {
        fprintf(stderr, "Schema account non disponibile: %s\n", error ? error : sqlite3_errmsg(connection));
        sqlite3_free(error); exit(EXIT_FAILURE);
    }
}
/* Reject duplicate or malformed session cookies rather than choosing one ambiguously. */
static bool session_cookie(const Request *r, char token[65]) {
    const char *p = r->cookie; bool found = false;
    while (*p) {
        while (*p == ' ' || *p == ';' || *p == '\t') p++;
        const char *end = strchr(p, ';'); if (!end) end = p + strlen(p);
        const char *equal = memchr(p, '=', (size_t)(end - p));
        if (equal && (size_t)(equal - p) == 10 && !strncmp(p, "ob_session", 10)) {
            if (found || end - equal - 1 != 64) return false;
            memcpy(token, equal + 1, 64); token[64] = 0; unsigned char raw[32];
            if (!hex_decode(token, raw, sizeof raw)) return false;
            OPENSSL_cleanse(raw, sizeof raw); found = true;
        }
        p = end;
    }
    return found;
}
static bool session_load(Request *r, char csrf[65], char hash[65]) {
    r->user_id = 0; r->role[0] = 0;
    char token[65]; time_t now = time(NULL);
    if (!session_cookie(r, token) || !token_digest(token, hash)) return false;
    OPENSSL_cleanse(token, sizeof token);
    sqlite3_stmt *s = prepare("SELECT u.id,u.role,s.csrf,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.token_hash=?1 AND u.active=1 AND s.expires_at>?2 AND s.last_seen>?3");
    bind_text(s, 1, hash); sqlite3_bind_int64(s, 2, now); sqlite3_bind_int64(s, 3, now - SESSION_IDLE);
    bool valid = sqlite3_step(s) == SQLITE_ROW;
    bool touch = valid && sqlite3_column_int64(s, 3) <= now - SESSION_TOUCH_INTERVAL;
    if (valid) {
        r->user_id = sqlite3_column_int64(s, 0);
        snprintf(r->role, sizeof r->role, "%s", sqlite3_column_text(s, 1));
        snprintf(csrf, 65, "%s", sqlite3_column_text(s, 2));
    }
    sqlite3_finalize(s);
    if (touch && ob_storage_cache_write_allowed()) {
        s = prepare("UPDATE sessions SET last_seen=?2 WHERE token_hash=?1 AND last_seen<?2");
        bind_text(s, 1, hash); sqlite3_bind_int64(s, 2, now); sqlite3_step(s); sqlite3_finalize(s);
    }
    return valid;
}
bool auth_authorize(Request *r, Response *response) {
    if (!ob_config.auth_enabled) { r->user_id = 0; snprintf(r->role, sizeof r->role, "admin"); return true; }
    char csrf[65] = "", hash[65] = "";
    if (!session_load(r, csrf, hash)) { *response = auth_error(401, "Accedi per continuare."); return false; }
    if (is_write(r) && (strlen(r->csrf) != 64 || CRYPTO_memcmp(csrf, r->csrf, 64))) {
        *response = auth_error(403, "Token CSRF mancante o non valido. Ricarica la pagina."); return false;
    }
    return true;
}
bool auth_is_admin(const Request *r) { return !ob_config.auth_enabled || !strcmp(r->role, "admin"); }
/* Recheck the live session and role while holding the same writer transaction
 * as the protected mutation. A preceding password hash or lock wait can outlive
 * an administrator's session revocation, deactivation or role change. */
static bool reauthorize_transaction(AuthTransaction t, Request *r, Response *response,
                                    bool admin) {
    if (!auth_authorize(r, response)) {
        transaction_end(t, false);
        return false;
    }
    if (admin && !auth_is_admin(r)) {
        *response = auth_error(403, "È richiesto il ruolo amministratore.");
        transaction_end(t, false);
        return false;
    }
    return true;
}
bool auth_board_allowed(const Request *r, int64_t board_id, bool write) {
    if (!ob_config.auth_enabled) return true;
    if (!r->user_id) return false;
    if (write && !strcmp(r->role, "observer")) return false;
    if (auth_is_admin(r)) return true;
    sqlite3_stmt *s = prepare("SELECT role FROM board_members WHERE board_id=?1 AND user_id=?2");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, r->user_id);
    bool allowed = false;
    if (sqlite3_step(s) == SQLITE_ROW) allowed = !write || strcmp((const char *)sqlite3_column_text(s, 0), "observer");
    sqlite3_finalize(s); return allowed;
}
static bool board_admin(const Request *r, int64_t board_id) {
    if (auth_is_admin(r)) return true;
    if (!r->user_id || !strcmp(r->role, "observer")) return false;
    sqlite3_stmt *s = prepare("SELECT 1 FROM board_members WHERE board_id=?1 AND user_id=?2 AND role='admin'");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, r->user_id);
    bool allowed = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s); return allowed;
}
bool auth_add_board_owner(const Request *r, int64_t board_id) {
    if (!ob_config.auth_enabled) return true;
    sqlite3_stmt *s = prepare("INSERT INTO board_members(board_id,user_id,role) VALUES(?1,?2,'admin')");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, r->user_id);
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); return ok;
}
bool auth_starred(const Request *r, int64_t board_id, bool local_starred) {
    if (!ob_config.auth_enabled) return local_starred;
    sqlite3_stmt *s = prepare("SELECT 1 FROM user_stars WHERE board_id=?1 AND user_id=?2");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, r->user_id);
    bool starred = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s); return starred;
}
bool auth_set_star(const Request *r, int64_t board_id, bool starred) {
    const char *sql = !ob_config.auth_enabled ? "UPDATE boards SET starred=?2 WHERE id=?1" :
        starred ? "INSERT OR IGNORE INTO user_stars(board_id,user_id) VALUES(?1,?2)" : "DELETE FROM user_stars WHERE board_id=?1 AND user_id=?2";
    sqlite3_stmt *s = prepare(sql); sqlite3_bind_int64(s, 1, board_id);
    sqlite3_bind_int64(s, 2, ob_config.auth_enabled ? r->user_id : starred);
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); return ok;
}
static Response session_response(const Request *r, const char *csrf, bool setup) {
    sqlite3_stmt *s = prepare("SELECT json_object('enabled',json(?1),'setup_required',json(?2),'user',json("
        "(SELECT json_object('id',id,'name',name,'username',username,'role',role) FROM users WHERE id=?3 AND active=1)),'csrf',?4)");
    bind_text(s, 1, ob_config.auth_enabled ? "true" : "false"); bind_text(s, 2, setup ? "true" : "false");
    sqlite3_bind_int64(s, 3, r->user_id); bind_text(s, 4, csrf ? csrf : "");
    Response response = sqlite3_step(s) == SQLITE_ROW ? json_response(200, (const char *)sqlite3_column_text(s, 0)) : auth_error(500, "Sessione non disponibile.");
    sqlite3_finalize(s); snprintf(response.headers, sizeof response.headers, "Cache-Control: no-store\r\n"); return response;
}
static void set_cookie(Response *r, const char *token, bool clear) {
    const char *secure = ob_config.public_url && !strncmp(ob_config.public_url, "https://", 8) ? "; Secure" : "";
    snprintf(r->headers, sizeof r->headers,
        "Cache-Control: no-store\r\nSet-Cookie: ob_session=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s\r\n",
        clear ? "" : token, clear ? 0 : SESSION_LIFETIME, secure);
}
static bool session_create(int64_t user_id, char token[65], char csrf[65]) {
    char hash[65]; time_t now = time(NULL);
    if (!random_hex(token, 32) || !random_hex(csrf, 32) || !token_digest(token, hash)) return false;
    sqlite3_stmt *s = prepare("DELETE FROM sessions WHERE expires_at<=?1 OR last_seen<=?2");
    sqlite3_bind_int64(s, 1, now); sqlite3_bind_int64(s, 2, now - SESSION_IDLE); sqlite3_step(s); sqlite3_finalize(s);
    /* Keep no more than ten concurrent sessions per account. */
    s = prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=?1 ORDER BY created_at DESC,token_hash LIMIT -1 OFFSET 9)");
    sqlite3_bind_int64(s, 1, user_id); sqlite3_step(s); sqlite3_finalize(s);
    s = prepare("INSERT INTO sessions(token_hash,csrf,user_id,expires_at,last_seen,created_at) VALUES(?1,?2,?3,?4,?5,?5)");
    bind_text(s, 1, hash); bind_text(s, 2, csrf); sqlite3_bind_int64(s, 3, user_id);
    sqlite3_bind_int64(s, 4, now + SESSION_LIFETIME); sqlite3_bind_int64(s, 5, now);
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); OPENSSL_cleanse(hash, sizeof hash); return ok;
}
static Response setup_account(Request *r) {
    if (count_users() != 0) return auth_error(409, "La configurazione iniziale è già completa.");
    char *name = NULL, *username = NULL, *password = NULL;
    bool valid = json_string(r->body, "name", &name, 100) == 1 && has_text(name) &&
        json_string(r->body, "username", &username, 64) == 1 && username_valid(username) &&
        json_string(r->body, "password", &password, 256) == 1 && password_valid(password);
    if (!valid) { ob_free(name); ob_free(username); secret_free(password); return auth_error(400, "Nome, username (3–64 caratteri a-z, 0-9, . _ -) e password (12–256 byte) sono obbligatori."); }
    if (!rate_allowed(r, "setup", "")) { ob_free(name); ob_free(username); secret_free(password); return auth_error(429, "Troppi tentativi. Riprova tra cinque minuti."); }
    char salt[33], hash[65], token[65] = "", csrf[65] = "";
    bool ok = random_hex(salt, 16) && password_hash(password, salt, hash); secret_free(password);
    AuthTransaction t = transaction_begin(); bool already = t.begun && count_users() != 0;
    ok = ok && t.begun && !already;
    if (ok) {
        sqlite3_stmt *s = prepare("INSERT INTO users(name,username,password_hash,salt,role) VALUES(?1,?2,?3,?4,'admin')");
        bind_text(s, 1, name); bind_text(s, 2, username); bind_text(s, 3, hash); bind_text(s, 4, salt);
        ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        if (ok) {
            r->user_id = sqlite3_last_insert_rowid(db); snprintf(r->role, sizeof r->role, "admin");
            s = prepare("INSERT INTO board_members(board_id,user_id,role) SELECT id,?1,'admin' FROM boards");
            sqlite3_bind_int64(s, 1, r->user_id); ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
            if (ok) ok = session_create(r->user_id, token, csrf);
        }
    }
    ok = transaction_end(t, ok); ob_free(name); ob_free(username); OPENSSL_cleanse(hash, sizeof hash); OPENSSL_cleanse(salt, sizeof salt);
    if (!ok) return auth_error(already ? 409 : 503, already ? "La configurazione iniziale è già completa." : "Configurazione non riuscita. Riprova.");
    Response response = session_response(r, csrf, false); response.status = 201; set_cookie(&response, token, false);
    OPENSSL_cleanse(token, sizeof token); return response;
}
static Response login_account(Request *r) {
    char *username = NULL, *password = NULL;
    bool valid = json_string(r->body, "username", &username, 64) == 1 && username_valid(username) &&
        json_string(r->body, "password", &password, 256) == 1 && password && strlen(password) <= 256;
    if (!valid) { ob_free(username); secret_free(password); return auth_error(400, "Username o password non validi."); }
    if (!rate_allowed(r, "login", username)) { ob_free(username); secret_free(password); return auth_error(429, "Troppi tentativi. Riprova tra cinque minuti."); }
    sqlite3_stmt *s = prepare("SELECT id,role,salt,password_hash,active FROM users WHERE username=?1 COLLATE NOCASE");
    bind_text(s, 1, username); ob_free(username);
    bool exists = sqlite3_step(s) == SQLITE_ROW;
    /* A fake hash preserves the expensive verification path for unknown usernames. */
    const char *salt = exists ? (const char *)sqlite3_column_text(s, 2) : "00000000000000000000000000000000";
    const char *expected = exists ? (const char *)sqlite3_column_text(s, 3) : "0000000000000000000000000000000000000000000000000000000000000000";
    bool matches = password_matches(password, salt, expected);
    bool ok = exists && matches && sqlite3_column_int(s, 4) == 1;
    int64_t id = ok ? sqlite3_column_int64(s, 0) : 0;
    char verified_hash[65] = ""; if (ok) snprintf(verified_hash, sizeof verified_hash, "%s", expected);
    char role[16] = ""; if (ok) snprintf(role, sizeof role, "%s", sqlite3_column_text(s, 1));
    sqlite3_finalize(s); secret_free(password);
    if (!ok) return auth_error(401, "Username o password non corretti.");
    AuthTransaction t = transaction_begin(); char token[65] = "", csrf[65] = "";
    /* Recheck activation after hashing; an administrator may have revoked access. */
    s = prepare("SELECT 1 FROM users WHERE id=?1 AND active=1 AND password_hash=?2");
    sqlite3_bind_int64(s, 1, id); bind_text(s, 2, verified_hash);
    bool active = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s);
    OPENSSL_cleanse(verified_hash, sizeof verified_hash);
    ok = t.begun && active && session_create(id, token, csrf); ok = transaction_end(t, ok);
    if (!ok) return auth_error(active ? 503 : 401, active ? "Accesso temporaneamente non disponibile." : "Username o password non corretti.");
    r->user_id = id; snprintf(r->role, sizeof r->role, "%s", role);
    Response response = session_response(r, csrf, false); set_cookie(&response, token, false);
    OPENSSL_cleanse(token, sizeof token); return response;
}
static Response logout_account(Request *r) {
    char token[65], hash[65];
    if (session_cookie(r, token) && token_digest(token, hash)) {
        sqlite3_stmt *s = prepare("DELETE FROM sessions WHERE token_hash=?1"); bind_text(s, 1, hash);
        bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); OPENSSL_cleanse(token, sizeof token);
        if (!ok) return auth_error(503, "Uscita non riuscita. Riprova.");
    }
    Response response = success(200, 0); set_cookie(&response, "", true); return response;
}
static Response change_password(Request *r) {
    char *current = NULL, *password = NULL;
    bool valid = json_string(r->body, "current_password", &current, 256) == 1 && current && strlen(current) <= 256 &&
        json_string(r->body, "password", &password, 256) == 1 && password_valid(password);
    if (!valid) { secret_free(current); secret_free(password); return auth_error(400, "Fornisci la password attuale e una nuova password di 12–256 byte."); }
    char rate_key[64]; snprintf(rate_key, sizeof rate_key, "password:%lld", (long long)r->user_id);
    if (!rate_allowed(r, "password", rate_key)) { secret_free(current); secret_free(password); return auth_error(429, "Troppi tentativi. Riprova tra cinque minuti."); }
    sqlite3_stmt *s = prepare("SELECT salt,password_hash FROM users WHERE id=?1 AND active=1"); sqlite3_bind_int64(s, 1, r->user_id);
    bool ok = sqlite3_step(s) == SQLITE_ROW && password_matches(current, (const char *)sqlite3_column_text(s, 0), (const char *)sqlite3_column_text(s, 1));
    char verified_hash[65] = ""; if (ok) snprintf(verified_hash, sizeof verified_hash, "%s", sqlite3_column_text(s, 1));
    sqlite3_finalize(s); secret_free(current);
    if (!ok) { secret_free(password); return auth_error(401, "La password attuale non è corretta."); }
    char salt[33], hash[65], token[65], session_hash[65];
    ok = random_hex(salt, 16) && password_hash(password, salt, hash) && session_cookie(r, token) && token_digest(token, session_hash);
    secret_free(password); OPENSSL_cleanse(token, sizeof token); AuthTransaction t = transaction_begin(); ok = ok && t.begun;
    Response denied;
    if (t.begun && !reauthorize_transaction(t, r, &denied, false)) {
        OPENSSL_cleanse(hash, sizeof hash); OPENSSL_cleanse(salt, sizeof salt); OPENSSL_cleanse(verified_hash, sizeof verified_hash);
        return denied;
    }
    if (ok) {
        s = prepare("UPDATE users SET password_hash=?2,salt=?3 WHERE id=?1 AND active=1 AND password_hash=?4");
        sqlite3_bind_int64(s, 1, r->user_id); bind_text(s, 2, hash); bind_text(s, 3, salt); bind_text(s, 4, verified_hash);
        ok = sqlite3_step(s) == SQLITE_DONE && sqlite3_changes(db) == 1; sqlite3_finalize(s);
        if (ok) {
            s = prepare("DELETE FROM sessions WHERE user_id=?1 AND token_hash<>?2"); sqlite3_bind_int64(s, 1, r->user_id); bind_text(s, 2, session_hash);
            ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        }
    }
    ok = transaction_end(t, ok); OPENSSL_cleanse(hash, sizeof hash); OPENSSL_cleanse(salt, sizeof salt); OPENSSL_cleanse(verified_hash, sizeof verified_hash);
    return ok ? success(200, r->user_id) : auth_error(503, "Password non aggiornata. Riprova.");
}
static Response list_users(void) {
    return query_json("SELECT json_object('users',json((SELECT json_group_array(json(item)) FROM ("
        "SELECT json_object('id',id,'name',name,'username',username,'role',role,'active',json(CASE active WHEN 1 THEN 'true' ELSE 'false' END),'created_at',created_at) item FROM users ORDER BY name,id))))", 0);
}
static Response create_user(Request *r) {
    char *name = NULL, *username = NULL, *password = NULL, *role = NULL;
    bool valid = json_string(r->body, "name", &name, 100) == 1 && has_text(name) &&
        json_string(r->body, "username", &username, 64) == 1 && username_valid(username) &&
        json_string(r->body, "password", &password, 256) == 1 && password_valid(password);
    int role_field = json_string(r->body, "role", &role, 16); valid = valid && role_field >= 0 && (!role_field || role_valid(role));
    if (!valid) { ob_free(name); ob_free(username); secret_free(password); ob_free(role); return auth_error(400, "Dati utente non validi. Password: 12–256 byte; username: 3–64 caratteri a-z, 0-9, . _ -."); }
    char salt[33], hash[65]; bool ok = random_hex(salt, 16) && password_hash(password, salt, hash); secret_free(password);
    AuthTransaction t = transaction_begin(); ok = ok && t.begun; int code = SQLITE_ERROR; int64_t id = 0;
    Response denied;
    if (t.begun && !reauthorize_transaction(t, r, &denied, true)) {
        ob_free(name); ob_free(username); ob_free(role); OPENSSL_cleanse(hash, sizeof hash); OPENSSL_cleanse(salt, sizeof salt);
        return denied;
    }
    if (ok) {
        sqlite3_stmt *s = prepare("INSERT INTO users(name,username,password_hash,salt,role) VALUES(?1,?2,?3,?4,?5)");
        bind_text(s, 1, name); bind_text(s, 2, username); bind_text(s, 3, hash); bind_text(s, 4, salt); bind_text(s, 5, role ? role : "member");
        code = sqlite3_step(s); ok = code == SQLITE_DONE; if (ok) id = sqlite3_last_insert_rowid(db); sqlite3_finalize(s);
    }
    ok = transaction_end(t, ok); ob_free(name); ob_free(username); ob_free(role); OPENSSL_cleanse(hash, sizeof hash); OPENSSL_cleanse(salt, sizeof salt);
    if (!ok) return auth_error((code & 255) == SQLITE_CONSTRAINT ? 409 : 503, (code & 255) == SQLITE_CONSTRAINT ? "Username già utilizzato." : "Utente non creato. Riprova.");
    return success(201, id);
}
static Response update_user(Request *r, int64_t id) {
    char *name = NULL, *role = NULL; int64_t active = 1;
    int nf = json_string(r->body, "name", &name, 100), rf = json_string(r->body, "role", &role, 16);
    int af = json_integer(r->body, "active", &active, 0, 1, true);
    bool valid = nf >= 0 && rf >= 0 && af >= 0 && (nf || rf || af) && (!nf || has_text(name)) && (!rf || role_valid(role));
    if (!valid) { ob_free(name); ob_free(role); return auth_error(400, "Indica nome, ruolo o stato attivo validi."); }
    AuthTransaction t = transaction_begin(); if (!t.begun) { ob_free(name); ob_free(role); return auth_error(503, "Utente non aggiornato. Riprova."); }
    Response denied;
    if (!reauthorize_transaction(t, r, &denied, true)) { ob_free(name); ob_free(role); return denied; }
    sqlite3_stmt *s = prepare("SELECT role,active,(SELECT count(*) FROM users WHERE role='admin' AND active=1) FROM users WHERE id=?1");
    sqlite3_bind_int64(s, 1, id); bool found = sqlite3_step(s) == SQLITE_ROW;
    bool protected_admin = found && !strcmp((const char *)sqlite3_column_text(s, 0), "admin") && sqlite3_column_int(s, 1) == 1 &&
        sqlite3_column_int64(s, 2) <= 1 && ((rf && strcmp(role, "admin")) || (af && !active));
    sqlite3_finalize(s);
    if (!found || protected_admin) {
        transaction_end(t, false); ob_free(name); ob_free(role);
        return auth_error(found ? 409 : 404, found ? "Deve rimanere almeno un amministratore attivo." : "Utente non trovato.");
    }
    s = prepare("UPDATE users SET name=CASE WHEN ?2 THEN ?3 ELSE name END,role=CASE WHEN ?4 THEN ?5 ELSE role END,active=CASE WHEN ?6 THEN ?7 ELSE active END WHERE id=?1");
    sqlite3_bind_int64(s, 1, id); sqlite3_bind_int(s, 2, nf); bind_text(s, 3, name); sqlite3_bind_int(s, 4, rf); bind_text(s, 5, role);
    sqlite3_bind_int(s, 6, af); sqlite3_bind_int64(s, 7, active); bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    if (ok && af && !active) {
        s = prepare("DELETE FROM sessions WHERE user_id=?1"); sqlite3_bind_int64(s, 1, id); ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    }
    ok = transaction_end(t, ok); ob_free(name); ob_free(role); return ok ? success(200, id) : auth_error(503, "Utente non aggiornato. Riprova.");
}
static Response list_members(int64_t board_id) {
    return query_json("SELECT json_object('members',json((SELECT json_group_array(json(item)) FROM ("
        "SELECT json_object('user_id',u.id,'name',u.name,'username',u.username,'role',m.role,'global_role',u.role,'active',json(CASE u.active WHEN 1 THEN 'true' ELSE 'false' END)) item "
        "FROM board_members m JOIN users u ON u.id=m.user_id WHERE m.board_id=?1 ORDER BY u.name,u.id))))", board_id);
}
static bool membership_event(const Request *r, int64_t board_id, int64_t user_id, const char *action) {
    sqlite3_stmt *s = prepare("INSERT INTO activity(board_id,actor_id,actor,action,entity_type,entity_id,title) "
        "SELECT ?1,actor.id,actor.name,?3,'members',member.id,member.name FROM users actor JOIN users member "
        "WHERE actor.id=?2 AND member.id=?4");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, r->user_id); bind_text(s, 3, action); sqlite3_bind_int64(s, 4, user_id);
    bool ok = sqlite3_step(s) == SQLITE_DONE && sqlite3_changes(db) == 1; sqlite3_finalize(s);
    if (!ok) return false;
    s = prepare("UPDATE boards SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND deleted_at IS NULL");
    sqlite3_bind_int64(s, 1, board_id); ok = sqlite3_step(s) == SQLITE_DONE && sqlite3_changes(db) == 1; sqlite3_finalize(s); return ok;
}
static Response save_member(Request *r, int64_t board_id) {
    int64_t user_id = 0; char *role = NULL;
    bool valid = json_integer(r->body, "user_id", &user_id, 1, INT64_MAX, false) == 1 &&
        json_string(r->body, "role", &role, 16) == 1 && role_valid(role);
    if (!valid) { ob_free(role); return auth_error(400, "Indica utente e ruolo admin, member oppure observer."); }
    AuthTransaction t = transaction_begin(); if (!t.begun) { ob_free(role); return auth_error(503, "Membro non aggiornato. Riprova."); }
    Response denied;
    if (!reauthorize_transaction(t, r, &denied, false)) { ob_free(role); return denied; }
    if (!board_exists(board_id) || !board_admin(r, board_id)) {
        transaction_end(t, false); ob_free(role); return auth_error(403, "Non puoi modificare i membri di questa bacheca.");
    }
    sqlite3_stmt *s = prepare("SELECT 1 FROM users WHERE id=?1 AND active=1"); sqlite3_bind_int64(s, 1, user_id);
    bool found = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s);
    if (!found) { transaction_end(t, false); ob_free(role); return auth_error(404, "Utente attivo non trovato."); }
    s = prepare("INSERT INTO board_members(board_id,user_id,role) VALUES(?1,?2,?3) ON CONFLICT(board_id,user_id) DO UPDATE SET role=excluded.role");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, user_id); bind_text(s, 3, role);
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    if (ok) ok = membership_event(r, board_id, user_id, "membership_updated");
    ok = transaction_end(t, ok); ob_free(role);
    return ok ? success(200, user_id) : auth_error(503, "Membro non aggiornato. Riprova.");
}
static Response delete_member(Request *r, int64_t board_id, int64_t user_id) {
    AuthTransaction t = transaction_begin(); if (!t.begun) return auth_error(503, "Membro non rimosso. Riprova.");
    Response denied;
    if (!reauthorize_transaction(t, r, &denied, false)) return denied;
    if (!board_exists(board_id) || !board_admin(r, board_id)) {
        transaction_end(t, false); return auth_error(403, "Non puoi modificare i membri di questa bacheca.");
    }
    sqlite3_stmt *s = prepare("DELETE FROM board_members WHERE board_id=?1 AND user_id=?2");
    sqlite3_bind_int64(s, 1, board_id); sqlite3_bind_int64(s, 2, user_id);
    bool ok = sqlite3_step(s) == SQLITE_DONE; int changed = sqlite3_changes(db); sqlite3_finalize(s);
    if (ok && changed) ok = membership_event(r, board_id, user_id, "membership_removed");
    ok = transaction_end(t, ok);
    if (!ok) return auth_error(503, "Membro non rimosso. Riprova.");
    return changed ? success(200, user_id) : auth_error(404, "Membro non trovato.");
}
static bool path_id(const char *path, const char *prefix, int64_t *id, const char **suffix) {
    size_t n = strlen(prefix); if (strncmp(path, prefix, n)) return false;
    const char *p = path + n; if (!isdigit((unsigned char)*p)) return false;
    errno = 0; char *end = NULL; long long value = strtoll(p, &end, 10);
    if (errno || value <= 0 || !end || (*end && *end != '/')) return false;
    *id = (int64_t)value; *suffix = end; return true;
}
bool auth_handle(Request *r, Response *response) {
    bool auth_path = !strncmp(r->path, "/api/auth/", 10);
    bool users_path = !strcmp(r->path, "/api/users") || !strncmp(r->path, "/api/users/", 11);
    int64_t board_id = 0, user_id = 0; const char *suffix = "", *tail = "";
    bool board_path = path_id(r->path, "/api/boards/", &board_id, &suffix);
    bool members_path = board_path && (!strcmp(suffix, "/members") || path_id(suffix, "/members/", &user_id, &tail));
    bool star_path = board_path && !strcmp(suffix, "/star");
    if (!auth_path && !users_path && !members_path && !star_path) return false;
    if (!strcmp(r->path, "/api/auth/session") && !strcmp(r->method, "GET")) {
        char csrf[65] = "", hash[65] = "";
        if (ob_config.auth_enabled) session_load(r, csrf, hash); else { r->user_id = 0; snprintf(r->role, sizeof r->role, "admin"); }
        *response = session_response(r, csrf, ob_config.auth_enabled && count_users() == 0); return true;
    }
    if (!ob_config.auth_enabled && !star_path) { *response = auth_error(403, "Gli account richiedono l'avvio con --auth."); return true; }
    if (is_write(r) && ((strcmp(r->method, "DELETE") && (!r->body || !valid_object(r->body))) ||
        (!strcmp(r->method, "DELETE") && r->body && *r->body && !valid_object(r->body)))) {
        *response = auth_error(400, "Il corpo deve essere un oggetto JSON valido."); return true;
    }
    if (auth_path && !strcmp(r->method, "POST") && !strcmp(r->path, "/api/auth/setup")) { *response = setup_account(r); return true; }
    if (auth_path && !strcmp(r->method, "POST") && !strcmp(r->path, "/api/auth/login")) { *response = login_account(r); return true; }
    if (!auth_authorize(r, response)) return true;
    if (auth_path) {
        if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/auth/logout")) *response = logout_account(r);
        else if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/auth/password")) *response = change_password(r);
        else *response = auth_error(404, "Endpoint account non trovato.");
        return true;
    }
    if (users_path) {
        if (!auth_is_admin(r)) { *response = auth_error(403, "È richiesto il ruolo amministratore."); return true; }
        if (!strcmp(r->path, "/api/users") && !strcmp(r->method, "GET")) *response = list_users();
        else if (!strcmp(r->path, "/api/users") && !strcmp(r->method, "POST")) *response = create_user(r);
        else if (path_id(r->path, "/api/users/", &user_id, &tail) && !*tail && !strcmp(r->method, "PATCH")) *response = update_user(r, user_id);
        else *response = auth_error(404, "Endpoint utenti non trovato.");
        return true;
    }
    if (!auth_board_allowed(r, board_id, false) || !board_exists(board_id)) { *response = auth_error(404, "Bacheca non trovata."); return true; }
    if (star_path) {
        int64_t starred = 0;
        if (strcmp(r->method, "PATCH")) *response = auth_error(405, "Usa PATCH per modificare i preferiti.");
        else if (json_integer(r->body, "starred", &starred, 0, 1, true) != 1) *response = auth_error(400, "Il campo starred deve essere booleano.");
        else {
            AuthTransaction t = transaction_begin();
            if (!t.begun) *response = auth_error(503, "Preferito non aggiornato. Riprova.");
            else if (!reauthorize_transaction(t, r, response, false)) return true;
            else if (!auth_board_allowed(r, board_id, false) || !board_exists(board_id)) {
                transaction_end(t, false);
                *response = auth_error(404, "Bacheca non trovata.");
            } else {
                bool ok = auth_set_star(r, board_id, starred != 0);
                ok = transaction_end(t, ok);
                *response = ok ? success(200, board_id) : auth_error(503, "Preferito non aggiornato. Riprova.");
            }
        }
        return true;
    }
    if (!strcmp(suffix, "/members") && !strcmp(r->method, "GET")) { *response = list_members(board_id); return true; }
    if (!board_admin(r, board_id)) { *response = auth_error(403, "È richiesto il ruolo amministratore della bacheca."); return true; }
    if (!strcmp(suffix, "/members") && !strcmp(r->method, "POST")) *response = save_member(r, board_id);
    else if (user_id && !*tail && !strcmp(r->method, "DELETE")) *response = delete_member(r, board_id, user_id);
    else *response = auth_error(404, "Endpoint membri non trovato.");
    return true;
}
