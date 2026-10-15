/* OpenBoard domain/storage API. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "openboard.h"
#include "auth.h"
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#define COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))
#define SCHEMA_VERSION 3
_Thread_local sqlite3 *db;
static _Thread_local jmp_buf request_recovery;
static _Thread_local jmp_buf *failure_target;
static _Thread_local bool recovering, outer_transaction;
static _Thread_local Request *current_request;
static void die(const char *s) {
    fprintf(stderr, "%s: %s\n", s, strerror(errno));
    exit(EXIT_FAILURE);
}
static void db_die(const char *s) {
    fprintf(stderr, "%s: %s\n", s, sqlite3_errmsg(db));
    if (recovering && failure_target)
        longjmp(*failure_target, 1);
    exit(EXIT_FAILURE);
}
/* Request allocations survive a SQL error only until the recovery boundary. */
typedef struct RequestAllocation {
    void *pointer;
    size_t length;
    struct RequestAllocation *next;
} RequestAllocation;
static _Thread_local RequestAllocation *request_allocations;
static void forget_allocation(void *pointer) {
    RequestAllocation **link = &request_allocations;
    while (*link) {
        if ((*link)->pointer == pointer) {
            RequestAllocation *removed = *link;
            *link = removed->next;
            free(removed);
            return;
        }
        link = &(*link)->next;
    }
}
void ob_free(void *pointer) {
    forget_allocation(pointer);
    free(pointer);
}
static void release_request_allocations(void) {
    while (request_allocations) {
        RequestAllocation *allocation = request_allocations;
        request_allocations = allocation->next;
        volatile unsigned char *bytes = allocation->pointer;
        for (size_t i = 0; i < allocation->length; i++)
            bytes[i] = 0;
        free(allocation->pointer);
        free(allocation);
    }
}
static char *copy_string(const char *s) {
    char *p = strdup(s ? s : "");
    if (!p)
        die("Memoria insufficiente");
    if (recovering) {
        RequestAllocation *allocation = malloc(sizeof *allocation);
        if (!allocation) {
            free(p);
            die("Memoria insufficiente");
        }
        allocation->pointer = p;
        allocation->length = strlen(p) + 1;
        allocation->next = request_allocations;
        request_allocations = allocation;
    }
    return p;
}
void sql_exec(const char *sql) {
    if (sqlite3_exec(db, sql, NULL, NULL, NULL) != SQLITE_OK)
        db_die("Errore SQLite");
}
sqlite3_stmt *prepare(const char *sql) {
    sqlite3_stmt *s = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &s, NULL) != SQLITE_OK)
        db_die("Preparazione SQL fallita");
    return s;
}
void bind_text(sqlite3_stmt *s, int i, const char *v) {
    if (sqlite3_bind_text(s, i, v ? v : "", -1, SQLITE_TRANSIENT) != SQLITE_OK)
        db_die("Parametro SQL non valido");
}
static int64_t scalar_id(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    if (sqlite3_bind_parameter_count(s))
        sqlite3_bind_int64(s, 1, id);
    int rc = sqlite3_step(s);
    if (rc != SQLITE_ROW && rc != SQLITE_DONE) {
        sqlite3_finalize(s);
        db_die("Lettura SQL fallita");
    }
    int64_t v = rc == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
    sqlite3_finalize(s);
    return v;
}
static bool run_id(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    sqlite3_bind_int64(s, 1, id);
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    return ok;
}
Response json_response(int status, const char *json) {
    Response r = {0};
    r.status = status;
    r.body = copy_string(json);
    r.type = "application/json; charset=utf-8";
    return r;
}
Response error_response(int status, const char *message) {
    size_t n = strlen(message), at = 0;
    char *j = malloc(n * 6 + 32);
    if (!j)
        die("Memoria insufficiente");
    memcpy(j, "{\"error\":\"", 10);
    at = 10;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)message[i];
        if (c == '"' || c == '\\') {
            j[at++] = '\\';
            j[at++] = (char)c;
        } else if (c < 32) {
            at += (size_t)sprintf(j + at, "\\u%04x", c);
        } else
            j[at++] = (char)c;
    }
    memcpy(j + at, "\"}", 3);
    Response r = json_response(status, j);
    ob_free(j);
    return r;
}
Response success(int status, int64_t id) {
    char b[128];
    snprintf(b, sizeof b, "{\"ok\":true,\"id\":%lld}", (long long)id);
    return json_response(status, b);
}
Response query_json(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    if (sqlite3_bind_parameter_count(s))
        sqlite3_bind_int64(s, 1, id);
    int rc = sqlite3_step(s);
    Response r = rc == SQLITE_ROW ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                                  : error_response(rc == SQLITE_DONE ? 404 : 503,
                                                   rc == SQLITE_DONE ? "Risorsa non trovata."
                                                                     : "Database temporaneamente non disponibile.");
    sqlite3_finalize(s);
    return r;
}
static bool begin_transaction(void) {
    return outer_transaction || sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) == SQLITE_OK;
}
/* JSON text and persisted strings must contain valid UTF-8 Unicode scalars. */
bool valid_utf8(const char *text, size_t length) {
    const unsigned char *s = (const unsigned char *)text;
    for (size_t i = 0; i < length;) {
        unsigned c = s[i++];
        if (c < 0x80)
            continue;
        if (c >= 0xc2 && c <= 0xdf) {
            if (i >= length || (s[i++] & 0xc0) != 0x80)
                return false;
        } else if (c >= 0xe0 && c <= 0xef) {
            if (length - i < 2 || (s[i] & 0xc0) != 0x80 || (s[i + 1] & 0xc0) != 0x80 || (c == 0xe0 && s[i] < 0xa0) ||
                (c == 0xed && s[i] >= 0xa0))
                return false;
            i += 2;
        } else if (c >= 0xf0 && c <= 0xf4) {
            if (length - i < 3 || (s[i] & 0xc0) != 0x80 || (s[i + 1] & 0xc0) != 0x80 || (s[i + 2] & 0xc0) != 0x80 ||
                (c == 0xf0 && s[i] < 0x90) || (c == 0xf4 && s[i] >= 0x90))
                return false;
            i += 3;
        } else
            return false;
    }
    return true;
}
/* Parse JSON with SQLite JSON1. Bind all data, including the field path. */
bool valid_object(const char *json) {
    sqlite3_stmt *s = prepare("SELECT json_valid(?1)");
    bind_text(s, 1, json);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid)
        return false;
    s = prepare(
        "SELECT json_type(?1)='object' AND NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY key HAVING count(*)>1)");
    bind_text(s, 1, json);
    valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return valid;
}
/* Returns 0 for absent, 1 for a string, -1 for a wrong type or embedded NUL. */
int json_string(const char *json, const char *field, char **out, size_t limit) {
    char path[80];
    snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2),length(json_extract(?1,?2))");
    bind_text(s, 1, json);
    bind_text(s, 2, path);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type)
            result = 0;
        else if (!strcmp(type, "text")) {
            const char *v = (const char *)sqlite3_column_text(s, 1);
            int n = sqlite3_column_bytes(s, 1);
            if (v && n >= 0 && (size_t)n <= limit * 4 && (size_t)sqlite3_column_int64(s, 2) <= limit &&
                strlen(v) == (size_t)n && valid_utf8(v, (size_t)n)) {
                *out = copy_string(v);
                result = 1;
            }
        }
    }
    sqlite3_finalize(s);
    return result;
}
int json_integer(const char *json, const char *field, int64_t *out, int64_t min, int64_t max, bool boolean) {
    char path[80];
    snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2)");
    bind_text(s, 1, json);
    bind_text(s, 2, path);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type)
            result = 0;
        else if ((!boolean && !strcmp(type, "integer")) ||
                 (boolean && (!strcmp(type, "true") || !strcmp(type, "false")))) {
            int64_t v = sqlite3_column_int64(s, 1);
            if (sqlite3_column_type(s, 1) == SQLITE_INTEGER && v >= min && v <= max) {
                *out = v;
                result = 1;
            }
        }
    }
    sqlite3_finalize(s);
    return result;
}
static int json_checklist(const char *json, char **out) {
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.checklist'),json_extract(?1,'$.checklist')");
    bind_text(s, 1, json);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type)
            result = 0;
        else if (!strcmp(type, "array")) {
            *out = copy_string((const char *)sqlite3_column_text(s, 1));
            result = 1;
        }
    }
    sqlite3_finalize(s);
    if (result != 1)
        return result;
    s = prepare("SELECT json_array_length(?1)<=100 AND NOT EXISTS(SELECT 1 FROM json_each(?1) WHERE type<>'object')");
    bind_text(s, 1, *out);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid)
        return -1;
    s = prepare("SELECT value FROM json_each(?1)");
    bind_text(s, 1, *out);
    while (sqlite3_step(s) == SQLITE_ROW && valid) {
        const char *item = (const char *)sqlite3_column_text(s, 0);
        char *id = NULL, *text = NULL;
        int64_t done = 0;
        valid = valid_object(item) && json_string(item, "id", &id, 100) == 1 && id && id[0] &&
                json_string(item, "text", &text, 500) == 1 && text && text[0] &&
                json_integer(item, "done", &done, 0, 1, true) == 1;
        ob_free(id);
        ob_free(text);
    }
    sqlite3_finalize(s);
    if (valid) {
        s = prepare(
            "SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY json_extract(value,'$.id') HAVING count(*)>1)");
        bind_text(s, 1, *out);
        valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
    }
    return valid ? 1 : -1;
}
static bool nonblank(const char *s) {
    for (; *s; s++)
        if (!isspace((unsigned char)*s))
            return true;
    return false;
}
static bool one_of(const char *value, const char *const *items, size_t n) {
    for (size_t i = 0; i < n; i++)
        if (!strcmp(value, items[i]))
            return true;
    return false;
}
static bool valid_date(const char *s) {
    if (!*s)
        return true;
    if (strlen(s) != 10 || s[4] != '-' || s[7] != '-')
        return false;
    for (int i = 0; i < 10; i++)
        if (i != 4 && i != 7 && !isdigit((unsigned char)s[i]))
            return false;
    int year = (s[0] - '0') * 1000 + (s[1] - '0') * 100 + (s[2] - '0') * 10 + s[3] - '0';
    int month = (s[5] - '0') * 10 + s[6] - '0', day = (s[8] - '0') * 10 + s[9] - '0';
    int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (year < 1 || month < 1 || month > 12)
        return false;
    if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))
        days[2] = 29;
    return day >= 1 && day <= days[month];
}
static const char *const colors[] = {"sage", "peach", "lavender", "blue"};
static const char *const labels[] = {"", "design", "sviluppo", "ricerca", "marketing", "urgente"};
static const char *const covers[] = {"", "sage", "peach", "lavender", "blue"};

static int64_t seed_board(const char *name, const char *description, const char *color, int starred) {
    sqlite3_stmt *s = prepare("INSERT INTO boards(name,description,color,starred) VALUES(?1,?2,?3,?4)");
    bind_text(s, 1, name);
    bind_text(s, 2, description);
    bind_text(s, 3, color);
    sqlite3_bind_int(s, 4, starred);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Creazione bacheca demo fallita");
    sqlite3_finalize(s);
    return sqlite3_last_insert_rowid(db);
}
static int64_t seed_column(int64_t board, const char *title, int position) {
    sqlite3_stmt *s = prepare("INSERT INTO columns(board_id,title,position) VALUES(?1,?2,?3)");
    sqlite3_bind_int64(s, 1, board);
    bind_text(s, 2, title);
    sqlite3_bind_int(s, 3, position);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Creazione lista demo fallita");
    sqlite3_finalize(s);
    return sqlite3_last_insert_rowid(db);
}
static void seed_card(int64_t column, const char *title, const char *description, const char *label, const char *date,
                      const char *assignee, const char *cover, int position, int completed, const char *checklist) {
    sqlite3_stmt *s =
        prepare("INSERT INTO "
                "cards(column_id,title,description,label,due_date,assignee,cover,position,completed,checklist,labels) "
                "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,CASE WHEN ?4='' THEN '[]' ELSE json_array(?4) END)");
    sqlite3_bind_int64(s, 1, column);
    bind_text(s, 2, title);
    bind_text(s, 3, description);
    bind_text(s, 4, label);
    bind_text(s, 5, date);
    bind_text(s, 6, assignee);
    bind_text(s, 7, cover);
    sqlite3_bind_int(s, 8, position);
    sqlite3_bind_int(s, 9, completed);
    bind_text(s, 10, checklist);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Creazione scheda demo fallita");
    sqlite3_finalize(s);
}
static _Thread_local bool include_archived, summary_mode;
/* Callback recovery returns through SQLite normally; never jump out of sqlite3_step. */
#define SQL_CALLBACK_GUARD(context)                                                                                    \
    jmp_buf callback_recovery;                                                                                         \
    jmp_buf *previous_recovery = failure_target;                                                                       \
    failure_target = &callback_recovery;                                                                               \
    if (setjmp(callback_recovery)) {                                                                                   \
        failure_target = previous_recovery;                                                                            \
        sqlite3_result_error(context, "Database temporaneamente non disponibile", -1);                                 \
        return;                                                                                                        \
    }
#define SQL_CALLBACK_END() failure_target = previous_recovery

static void allowed_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    sqlite3_result_int(c, current_request ? auth_board_allowed(current_request, sqlite3_value_int64(v[0]), false) : 1);
    SQL_CALLBACK_END();
}
static void starred_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    sqlite3_result_int(c, current_request
                              ? auth_starred(current_request, sqlite3_value_int64(v[0]), sqlite3_value_int(v[1]))
                              : sqlite3_value_int(v[1]));
    SQL_CALLBACK_END();
}
static void archived_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    (void)n;
    (void)v;
    sqlite3_result_int(c, include_archived);
}
static void summary_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    (void)n;
    (void)v;
    sqlite3_result_int(c, summary_mode);
}
static void role_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    const char *role = "admin";
    sqlite3_stmt *s = NULL;
    if (ob_config.auth_enabled && current_request) {
        role = current_request->role;
        if (strcmp(role, "admin")) {
            s = prepare("SELECT role FROM board_members WHERE board_id=?1 AND user_id=?2");
            sqlite3_bind_int64(s, 1, sqlite3_value_int64(v[0]));
            sqlite3_bind_int64(s, 2, current_request->user_id);
            if (sqlite3_step(s) == SQLITE_ROW)
                role = (const char *)sqlite3_column_text(s, 0);
        }
    }
    sqlite3_result_text(c, role, -1, SQLITE_TRANSIENT);
    if (s)
        sqlite3_finalize(s);
    SQL_CALLBACK_END();
}
static void readonly_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    sqlite3_result_int(c, current_request ? !auth_board_allowed(current_request, sqlite3_value_int64(v[0]), true) : 0);
    SQL_CALLBACK_END();
}
static void register_functions(void) {
    sqlite3_create_function(db, "ob_allowed", 1, SQLITE_UTF8, NULL, allowed_sql, NULL, NULL);
    sqlite3_create_function(db, "ob_starred", 2, SQLITE_UTF8, NULL, starred_sql, NULL, NULL);
    sqlite3_create_function(db, "ob_archived", 0, SQLITE_UTF8, NULL, archived_sql, NULL, NULL);
    sqlite3_create_function(db, "ob_summary", 0, SQLITE_UTF8, NULL, summary_sql, NULL, NULL);
    sqlite3_create_function(db, "ob_role", 1, SQLITE_UTF8, NULL, role_sql, NULL, NULL);
    sqlite3_create_function(db, "ob_readonly", 1, SQLITE_UTF8, NULL, readonly_sql, NULL, NULL);
}
static void make_parent_dirs(const char *path) {
    if (!path || !*path)
        die("Percorso database vuoto");
    char *p = copy_string(path);
    for (char *q = p + 1; *q; q++)
        if (*q == '/') {
            *q = 0;
            if (mkdir(p, 0700) < 0 && errno != EEXIST)
                die("Creazione cartella dati fallita");
            *q = '/';
        }
    ob_free(p);
}
int ob_backup(const char *path) {
    if (!path || !*path || !strcmp(path, ob_config.db_path))
        return -1;
    struct stat source_stat, destination_stat;
    if (stat(ob_config.db_path, &source_stat) == 0 && stat(path, &destination_stat) == 0 &&
        source_stat.st_dev == destination_stat.st_dev && source_stat.st_ino == destination_stat.st_ino)
        return -1;
    make_parent_dirs(path);
    sqlite3 *dest = NULL;
    if (sqlite3_open(path, &dest) != SQLITE_OK) {
        if (dest)
            sqlite3_close(dest);
        return -1;
    }
    if (chmod(path, 0600) < 0) {
        sqlite3_close(dest);
        return -1;
    }
    sqlite3_backup *b = sqlite3_backup_init(dest, "main", db, "main");
    int rc = SQLITE_ERROR, finish_rc = SQLITE_ERROR;
    if (b) {
        for (int attempt = 0; attempt < 300;) {
            rc = sqlite3_backup_step(b, 256);
            if (rc == SQLITE_DONE || (rc != SQLITE_OK && rc != SQLITE_BUSY && rc != SQLITE_LOCKED))
                break;
            if (rc != SQLITE_OK) {
                sqlite3_sleep(10);
                attempt++;
            }
        }
        finish_rc = sqlite3_backup_finish(b);
    }
    int close_rc = sqlite3_close(dest);
    return rc == SQLITE_DONE && finish_rc == SQLITE_OK && close_rc == SQLITE_OK ? 0 : -1;
}
static const char *schema_one =
    "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
    "CREATE TABLE IF NOT EXISTS boards(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT "
    "NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'sage',starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN(0,1)));"
    "CREATE TABLE IF NOT EXISTS columns(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES "
    "boards(id) ON DELETE CASCADE,title TEXT NOT NULL,position INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS "
    "columns_board ON columns(board_id,position);"
    "CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY AUTOINCREMENT,column_id INTEGER NOT NULL REFERENCES "
    "columns(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',label TEXT NOT NULL "
    "DEFAULT '',due_date TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',cover TEXT NOT NULL DEFAULT "
    "'',position INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),checklist TEXT NOT "
    "NULL DEFAULT '[]' CHECK(json_valid(checklist)));CREATE INDEX IF NOT EXISTS cards_column ON "
    "cards(column_id,position);";
static void migration_two(void) {
    const char *tables[] = {"boards", "columns", "cards"};
    char sql[2048];
    for (size_t i = 0; i < COUNT_OF(tables); i++) {
        const char *t = tables[i];
        snprintf(sql, sizeof sql,
                 "ALTER TABLE %s ADD COLUMN created_at TEXT NOT NULL DEFAULT '';ALTER TABLE %s ADD COLUMN updated_at "
                 "TEXT NOT NULL DEFAULT '';ALTER TABLE %s ADD COLUMN version INTEGER NOT NULL DEFAULT 1;ALTER TABLE %s "
                 "ADD COLUMN deleted_at TEXT;UPDATE %s SET "
                 "created_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now'),updated_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
                 "'now');",
                 t, t, t, t, t);
        sql_exec(sql);
        snprintf(sql, sizeof sql,
                 "CREATE TRIGGER %s_timestamps_insert AFTER INSERT ON %s BEGIN UPDATE %s SET created_at=CASE WHEN "
                 "NEW.created_at='' THEN strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') ELSE NEW.created_at "
                 "END,updated_at=CASE WHEN NEW.updated_at='' THEN strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') ELSE "
                 "NEW.updated_at END WHERE id=NEW.id; END;CREATE TRIGGER %s_timestamps_update AFTER UPDATE ON %s WHEN "
                 "NEW.version=OLD.version AND NEW.created_at=OLD.created_at BEGIN UPDATE %s SET "
                 "version=OLD.version+1,updated_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') WHERE id=NEW.id; END;",
                 t, t, t, t, t, t);
        sql_exec(sql);
    }
    sql_exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1));ALTER TABLE "
             "cards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1));ALTER TABLE columns ADD "
             "COLUMN wip_limit INTEGER NOT NULL DEFAULT 0 CHECK(wip_limit BETWEEN 0 AND 100000);ALTER TABLE cards ADD "
             "COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high','urgent'));ALTER "
             "TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(labels));ALTER TABLE cards ADD "
             "COLUMN estimate_minutes INTEGER NOT NULL DEFAULT 0 CHECK(estimate_minutes BETWEEN 0 AND 100000);UPDATE "
             "cards SET labels=CASE WHEN label='' THEN '[]' ELSE json_array(label) END;");
}
static const char *schema_three =
    "CREATE TABLE comments(id INTEGER PRIMARY KEY AUTOINCREMENT,card_id INTEGER NOT NULL REFERENCES cards(id) ON "
    "DELETE CASCADE,author_id INTEGER NOT NULL DEFAULT 0,author TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT "
    "NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));CREATE INDEX comments_card ON comments(card_id,id);"
    "CREATE TABLE activity(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES boards(id) ON "
    "DELETE CASCADE,actor_id INTEGER NOT NULL DEFAULT 0,actor TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT "
    "NULL,entity_id INTEGER NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL "
    "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));CREATE INDEX activity_board ON activity(board_id,id DESC);"
    "CREATE TABLE idempotency(user_id INTEGER NOT NULL,path TEXT NOT NULL,key TEXT NOT NULL,request_body TEXT NOT "
    "NULL,status INTEGER NOT NULL,response_body TEXT NOT NULL,created_at TEXT NOT NULL "
    "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(user_id,path,key));"
    "CREATE INDEX cards_due ON cards(due_date) WHERE deleted_at IS NULL;CREATE INDEX cards_active ON "
    "cards(column_id,archived,position) WHERE deleted_at IS NULL;CREATE INDEX boards_active ON boards(archived,id) "
    "WHERE deleted_at IS NULL;";
static const char *json_views =
    "CREATE VIEW IF NOT EXISTS ob_card_objects AS SELECT "
    "k.*,json_object('id',k.id,'column_id',k.column_id,'title',k.title,'description',k.description,'label',k.label,'"
    "labels',json(k.labels),'due_date',k.due_date,'assignee',k.assignee,'cover',k.cover,'position',k.position,'"
    "completed',json(CASE k.completed WHEN 1 THEN 'true' ELSE 'false' "
    "END),'checklist',json(k.checklist),'priority',k.priority,'estimate_minutes',k.estimate_minutes,'archived',json("
    "CASE k.archived WHEN 1 THEN 'true' ELSE 'false' "
    "END),'version',k.version,'created_at',k.created_at,'updated_at',k.updated_at) data,"
    "json_object('id',k.id,'column_id',k.column_id,'title',k.title,'description_preview',substr(k.description,1,160),'"
    "checklist_total',json_array_length(k.checklist),'checklist_done',(SELECT count(*) FROM json_each(k.checklist) "
    "WHERE "
    "json_extract(value,'$.done')=1),'label',k.label,'labels',json(k.labels),'due_date',k.due_date,'assignee',k."
    "assignee,'cover',k.cover,'position',k.position,'completed',json(CASE k.completed WHEN 1 THEN 'true' ELSE 'false' "
    "END),'priority',k.priority,'estimate_minutes',k.estimate_minutes,'archived',json(CASE k.archived WHEN 1 THEN "
    "'true' ELSE 'false' END),'version',k.version,'created_at',k.created_at,'updated_at',k.updated_at) summary FROM "
    "cards k;"
    "CREATE VIEW IF NOT EXISTS ob_board_objects AS SELECT "
    "b.*,json_object('id',b.id,'name',b.name,'description',b.description,'color',b.color,'starred',json(CASE "
    "ob_starred(b.id,b.starred) WHEN 1 THEN 'true' ELSE 'false' END),'archived',json(CASE b.archived WHEN 1 THEN "
    "'true' ELSE 'false' "
    "END),'version',b.version,'created_at',b.created_at,'updated_at',b.updated_at,'role',ob_role(b.id),'membership_"
    "role',ob_role(b.id),'readonly',json(CASE ob_readonly(b.id) WHEN 1 THEN 'true' ELSE 'false' "
    "END),'columns',json((SELECT json_group_array(json(col)) FROM(SELECT "
    "json_object('id',c.id,'title',c.title,'position',c.position,'wip_limit',c.wip_limit,'version',c.version,'created_"
    "at',c.created_at,'updated_at',c.updated_at,'cards',json((SELECT json_group_array(json(item)) FROM(SELECT CASE "
    "ob_summary() WHEN 1 THEN k.summary ELSE k.data END item FROM ob_card_objects k WHERE k.column_id=c.id AND "
    "k.deleted_at IS NULL AND (ob_archived() OR k.archived=0) ORDER BY k.position,k.id)))) col FROM columns c WHERE "
    "c.board_id=b.id AND c.deleted_at IS NULL ORDER BY c.position,c.id)))) data FROM boards b;";
int ob_worker_init(void) {
    if (sqlite3_open_v2(ob_config.db_path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX,
                        NULL) != SQLITE_OK)
        return -1;
    if (chmod(ob_config.db_path, 0600) < 0)
        return -1;
    sqlite3_busy_timeout(db, 3000);
    if (sqlite3_exec(db, "PRAGMA foreign_keys=ON", NULL, NULL, NULL) != SQLITE_OK)
        return -1;
    register_functions();
    return 0;
}
void ob_worker_close(void) {
    if (db) {
        sqlite3_close(db);
        db = NULL;
    }
}
int ob_initialize_database(void) {
    make_parent_dirs(ob_config.db_path);
    if (ob_worker_init())
        return -1;
    int version = (int)scalar_id("PRAGMA user_version", 0);
    if (version > SCHEMA_VERSION) {
        fprintf(stderr, "Schema futuro %d non supportato (max %d).\n", version, SCHEMA_VERSION);
        return -1;
    }
    sqlite3_exec(db, "PRAGMA journal_mode=WAL", NULL, NULL, NULL);
    if (version > 0 && version < SCHEMA_VERSION) {
        size_t n = strlen(ob_config.db_path) + 48;
        char *p = malloc(n);
        if (!p)
            return -1;
        snprintf(p, n, "%s.pre-v%d.bak", ob_config.db_path, version);
        int rc = ob_backup(p);
        ob_free(p);
        if (rc)
            return -1;
    }
    while (version < SCHEMA_VERSION) {
        if (sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) != SQLITE_OK)
            return -1;
        int next = version + 1;
        if (next == 1)
            sql_exec(schema_one);
        else if (next == 2)
            migration_two();
        else
            sql_exec(schema_three);
        char p[64];
        snprintf(p, sizeof p, "PRAGMA user_version=%d;COMMIT", next);
        sql_exec(p);
        version = next;
    }
    auth_schema(db);
    /* Repair legacy primary labels produced before the multi-label seed was introduced. */
    sql_exec("BEGIN IMMEDIATE;UPDATE boards SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
             "WHERE id IN(SELECT c.board_id FROM cards k JOIN columns c ON c.id=k.column_id WHERE k.labels='[]' AND "
             "k.label<>'');"
             "UPDATE cards SET labels=json_array(label) WHERE labels='[]' AND label<>'';COMMIT;");
    sql_exec("DROP VIEW IF EXISTS ob_board_objects;DROP VIEW IF EXISTS ob_card_objects;");
    sql_exec(json_views);
    bool initialized = scalar_id("SELECT count(*) FROM metadata WHERE key='initialized'", 0) > 0;
    if (!initialized) {
        sql_exec("BEGIN IMMEDIATE");
        if (!ob_config.no_demo && scalar_id("SELECT count(*) FROM boards", 0) == 0) {
            int64_t board = seed_board(
                "Lancio di OpenBoard",
                "Uno spazio condiviso per dare forma alle idee. Costruiamo qualcosa di bello, insieme.", "sage", 1);
            int64_t ideas = seed_column(board, "Idee", 0), todo = seed_column(board, "Da fare", 1),
                    doing = seed_column(board, "In corso", 2), done = seed_column(board, "Completato", 3);
            seed_card(ideas, "Una casa per tutte le nostre idee",
                      "Raccogliere spunti, ispirazioni e piccoli esperimenti per il futuro di OpenBoard.", "ricerca",
                      "", "Sofia", "lavender", 0, 0, "[]");
            seed_card(ideas, "Modalità scura",
                      "Esplorare una palette scura morbida, accessibile e piacevole da usare la sera.", "design",
                      "2026-10-28", "Giulia", "", 1, 0, "[]");
            seed_card(ideas, "Importa le tue bacheche",
                      "Studiare un formato aperto per importare progetti da altri strumenti Kanban.", "sviluppo", "",
                      "Marco", "", 2, 0, "[]");
            seed_card(todo, "Disegnare la nuova pagina di benvenuto",
                      "Una prima impressione semplice: il valore del progetto, una demo e un invito a contribuire.",
                      "design", "2026-10-20", "Giulia", "peach", 0, 0,
                      "[{\"id\":\"welcome-1\",\"text\":\"Raccogliere "
                      "riferimenti\",\"done\":true},{\"id\":\"welcome-2\",\"text\":\"Preparare il "
                      "wireframe\",\"done\":false},{\"id\":\"welcome-3\",\"text\":\"Revisione con il "
                      "team\",\"done\":false}]");
            seed_card(todo, "Scrivere la guida per contribuire",
                      "Documentare come avviare il progetto, segnalare problemi e proporre miglioramenti.", "marketing",
                      "2026-10-22", "Luca", "", 1, 0, "[]");
            seed_card(todo, "Test di accessibilità",
                      "Verificare navigazione da tastiera, contrasto e annunci per gli screen reader.", "urgente",
                      "2026-10-19", "Sofia", "", 2, 0,
                      "[{\"id\":\"a11y-1\",\"text\":\"Navigazione con "
                      "Tab\",\"done\":false},{\"id\":\"a11y-2\",\"text\":\"Contrasto dei colori\",\"done\":false}]");
            seed_card(doing, "Trascina, sposta, organizza",
                      "Spostare le schede fra le liste e mantenere il nuovo ordine anche dopo un riavvio.", "sviluppo",
                      "2026-10-18", "Marco", "blue", 0, 0,
                      "[{\"id\":\"drag-1\",\"text\":\"API di "
                      "spostamento\",\"done\":true},{\"id\":\"drag-2\",\"text\":\"Interazioni drag & "
                      "drop\",\"done\":false}]");
            seed_card(doing, "Dare un'identità a OpenBoard",
                      "Definire logo, colori e tono di voce per un progetto aperto e accogliente.", "design",
                      "2026-10-21", "Giulia", "", 1, 0, "[]");
            seed_card(done, "Il progetto è open source!",
                      "Codice disponibile con licenza MIT. Ogni contributo, grande o piccolo, è benvenuto.",
                      "marketing", "2026-10-14", "Luca", "sage", 0, 1, "[]");
            seed_card(done, "Preparare le fondamenta in C",
                      "Server HTTP leggero, API JSON e database SQLite. Poche dipendenze, tanta sostanza.", "sviluppo",
                      "2026-10-13", "Marco", "", 1, 1,
                      "[{\"id\":\"base-1\",\"text\":\"Server "
                      "HTTP\",\"done\":true},{\"id\":\"base-2\",\"text\":\"Persistenza SQLite\",\"done\":true}]");
            int64_t inspiration =
                seed_board("Idee & ispirazioni", "Uno spazio per i prossimi esperimenti e le cose che ci ispirano.",
                           "lavender", 0);
            seed_column(inspiration, "Raccolta", 0);
            seed_column(inspiration, "Da esplorare", 1);
            seed_column(inspiration, "Preferiti", 2);
            int64_t website =
                seed_board("Sito web", "Dal primo wireframe alla pubblicazione del nostro nuovo sito.", "blue", 0);
            seed_column(website, "Da fare", 0);
            seed_column(website, "In corso", 1);
            seed_column(website, "Pubblicato", 2);
        }
        sql_exec("INSERT INTO metadata(key,value) VALUES('initialized','1');COMMIT;");
    }
    return 0;
}
int64_t parse_id(const char *s) {
    if (!s || !*s || *s == '0')
        return 0;
    uint64_t n = 0;
    for (; *s; s++) {
        if (*s < '0' || *s > '9')
            return 0;
        unsigned d = (unsigned)(*s - '0');
        if (n > ((uint64_t)INT64_MAX - d) / 10)
            return 0;
        n = n * 10 + d;
    }
    return (int64_t)n;
}
static int64_t resource_board(const char *kind, int64_t id, bool deleted) {
    char sql[512];
    if (!strcmp(kind, "boards"))
        snprintf(sql, sizeof sql, "SELECT id FROM boards WHERE id=?1 %s", deleted ? "" : "AND deleted_at IS NULL");
    else if (!strcmp(kind, "columns"))
        snprintf(sql, sizeof sql, "SELECT c.board_id FROM columns c JOIN boards b ON b.id=c.board_id WHERE c.id=?1 %s",
                 deleted ? "" : "AND c.deleted_at IS NULL AND b.deleted_at IS NULL");
    else
        snprintf(sql, sizeof sql,
                 "SELECT c.board_id FROM cards k JOIN columns c ON c.id=k.column_id JOIN boards b ON b.id=c.board_id "
                 "WHERE k.id=?1 %s",
                 deleted ? "" : "AND k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL");
    return scalar_id(sql, id);
}
static bool accessible(Request *r, const char *kind, int64_t id, bool write, bool deleted) {
    int64_t b = resource_board(kind, id, deleted);
    return b && auth_board_allowed(r, b, write);
}
static char *actor_name(Request *r) {
    if (!ob_config.auth_enabled || !r->user_id)
        return copy_string("Locale");
    sqlite3_stmt *s = prepare("SELECT name FROM users WHERE id=?1");
    sqlite3_bind_int64(s, 1, r->user_id);
    char *name = copy_string(sqlite3_step(s) == SQLITE_ROW ? (const char *)sqlite3_column_text(s, 0) : "Utente");
    sqlite3_finalize(s);
    return name;
}
static void record_event(Request *r, int64_t board, const char *action, const char *kind, int64_t id,
                         const char *title) {
    char *actor = actor_name(r);
    sqlite3_stmt *s = prepare("INSERT INTO activity(board_id,actor_id,actor,action,entity_type,entity_id,title) "
                              "VALUES(?1,?2,?3,?4,?5,?6,?7)");
    sqlite3_bind_int64(s, 1, board);
    sqlite3_bind_int64(s, 2, r->user_id);
    bind_text(s, 3, actor);
    bind_text(s, 4, action);
    bind_text(s, 5, kind);
    sqlite3_bind_int64(s, 6, id);
    bind_text(s, 7, title);
    if (sqlite3_step(s) != SQLITE_DONE) {
        sqlite3_finalize(s);
        ob_free(actor);
        db_die("Registrazione attività fallita");
    }
    sqlite3_finalize(s);
    ob_free(actor);
    if (!run_id("UPDATE boards SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                board))
        db_die("Aggiornamento versione fallito");
}
static char *resource_title(const char *kind, int64_t id) {
    char sql[100];
    snprintf(sql, sizeof sql, "SELECT %s FROM %s WHERE id=?1", !strcmp(kind, "boards") ? "name" : "title", kind);
    sqlite3_stmt *s = prepare(sql);
    sqlite3_bind_int64(s, 1, id);
    char *t = copy_string(sqlite3_step(s) == SQLITE_ROW ? (const char *)sqlite3_column_text(s, 0) : "");
    sqlite3_finalize(s);
    return t;
}
static bool precondition(Request *r, const char *kind, int64_t id) {
    if (!r->if_match[0])
        return true;
    char sql[100];
    snprintf(sql, sizeof sql, "SELECT version FROM %s WHERE id=?1", kind);
    int64_t version = scalar_id(sql, id);
    char a[80], b[80];
    snprintf(a, sizeof a, "\"%lld\"", (long long)version);
    snprintf(b, sizeof b, "%lld", (long long)version);
    return !strcmp(r->if_match, a) || !strcmp(r->if_match, b);
}
static bool normalize_cards(int64_t id) {
    return run_id("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY archived,position,id)-1 n FROM cards WHERE "
                  "column_id=?1 AND "
                  "deleted_at IS NULL)UPDATE cards SET position=(SELECT n FROM ranked WHERE ranked.id=cards.id) WHERE "
                  "column_id=?1 AND deleted_at IS NULL AND position<>(SELECT n FROM ranked WHERE ranked.id=cards.id)",
                  id);
}
static bool normalize_columns(int64_t id) {
    return run_id(
        "WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n FROM columns WHERE board_id=?1 AND "
        "deleted_at IS NULL)UPDATE columns SET position=(SELECT n FROM ranked WHERE ranked.id=columns.id) WHERE "
        "board_id=?1 AND deleted_at IS NULL AND position<>(SELECT n FROM ranked WHERE ranked.id=columns.id)",
        id);
}
static int json_labels(const char *json, char **out) {
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.labels'),json_extract(?1,'$.labels')");
    bind_text(s, 1, json);
    int rc = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *t = (const char *)sqlite3_column_text(s, 0);
        if (!t)
            rc = 0;
        else if (!strcmp(t, "array")) {
            *out = copy_string((const char *)sqlite3_column_text(s, 1));
            rc = 1;
        }
    }
    sqlite3_finalize(s);
    if (rc != 1)
        return rc;
    s = prepare("SELECT json_array_length(?1)<=5 AND NOT EXISTS(SELECT 1 FROM json_each(?1) WHERE type<>'text' OR "
                "value NOT IN('design','sviluppo','ricerca','marketing','urgente'))AND NOT EXISTS(SELECT 1 FROM "
                "json_each(?1) GROUP BY value HAVING count(*)>1)");
    bind_text(s, 1, *out);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok ? 1 : -1;
}
static Response mutation_success(int status, const char *kind, int64_t id) {
    char sql[120], body[160];
    snprintf(sql, sizeof sql, "SELECT version FROM %s WHERE id=?1", kind);
    snprintf(body, sizeof body, "{\"ok\":true,\"id\":%lld,\"version\":%lld}", (long long)id,
             (long long)scalar_id(sql, id));
    return json_response(status, body);
}
static Response save_board(Request *r, int64_t id, bool create) {
    char *name = NULL, *description = NULL, *color = NULL;
    int64_t starred = 0, archived = 0;
    int n = json_string(r->body, "name", &name, 200), d = json_string(r->body, "description", &description, 2000),
        c = json_string(r->body, "color", &color, 20), t = json_integer(r->body, "starred", &starred, 0, 1, true),
        a = json_integer(r->body, "archived", &archived, 0, 1, true);
    Response result;
    if (n < 0 || d < 0 || c < 0 || t < 0 || a < 0 || (create && n != 1) || (name && !nonblank(name)) ||
        (color && !one_of(color, colors, COUNT_OF(colors)))) {
        result = error_response(400, "Dati della bacheca non validi.");
        goto done;
    }
    if (!create && !accessible(r, "boards", id, true, false)) {
        result = error_response(404, "Bacheca non trovata.");
        goto done;
    }
    if (!create && !precondition(r, "boards", id)) {
        result = error_response(412, "Bacheca modificata da un altro utente.");
        goto done;
    }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO boards(name,description,color,starred,archived)VALUES(?1,?2,?3,?4,?5)");
        bind_text(s, 1, name);
        bind_text(s, 2, description);
        bind_text(s, 3, color ? color : "sage");
        sqlite3_bind_int64(s, 4, starred);
        sqlite3_bind_int64(s, 5, archived);
    } else {
        s = prepare("UPDATE boards SET "
                    "name=coalesce(?2,name),description=coalesce(?3,description),color=coalesce(?4,color),starred="
                    "coalesce(?5,starred),archived=coalesce(?6,archived)WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (name)
            bind_text(s, 2, name);
        if (description)
            bind_text(s, 3, description);
        if (color)
            bind_text(s, 4, color);
        if (t)
            sqlite3_bind_int64(s, 5, starred);
        if (a)
            sqlite3_bind_int64(s, 6, archived);
    }
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok) {
        result = error_response(503, "Impossibile salvare la bacheca.");
        goto done;
    }
    if (create) {
        id = sqlite3_last_insert_rowid(db);
        if (!auth_add_board_owner(r, id))
            db_die("Assegnazione proprietario fallita");
        const char *titles[] = {"Da fare", "In corso", "Completato"};
        s = prepare("INSERT INTO columns(board_id,title,position)VALUES(?1,?2,?3)");
        for (size_t i = 0; i < 3; i++) {
            sqlite3_bind_int64(s, 1, id);
            bind_text(s, 2, titles[i]);
            sqlite3_bind_int(s, 3, (int)i);
            if (sqlite3_step(s) != SQLITE_DONE)
                db_die("Creazione liste fallita");
            sqlite3_reset(s);
            sqlite3_clear_bindings(s);
        }
        sqlite3_finalize(s);
    }
    if (t && !auth_set_star(r, id, (int)starred))
        db_die("Salvataggio preferito fallito");
    char *title = resource_title("boards", id);
    record_event(r, id,
                 create ? "created"
                 : a    ? (archived ? "archived" : "unarchived")
                        : "updated",
                 "boards", id, title);
    ob_free(title);
    result = mutation_success(create ? 201 : 200, "boards", id);
done:
    ob_free(name);
    ob_free(description);
    ob_free(color);
    return result;
}
static Response save_column(Request *r, int64_t id, bool create) {
    char *title = NULL;
    int64_t position = 0, wip = 0;
    int t = json_string(r->body, "title", &title, 200),
        p = json_integer(r->body, "position", &position, 0, INT_MAX, false),
        w = json_integer(r->body, "wip_limit", &wip, 0, 100000, false);
    if (t < 0 || p < 0 || w < 0 || (create && t != 1) || (title && !nonblank(title))) {
        ob_free(title);
        return error_response(400, "Dati della lista non validi.");
    }
    int64_t board = create ? id : resource_board("columns", id, false);
    if (!board || !accessible(r, create ? "boards" : "columns", id, true, false)) {
        ob_free(title);
        return error_response(404, "Lista o bacheca non trovata.");
    }
    if (!create && !precondition(r, "columns", id)) {
        ob_free(title);
        return error_response(412, "Lista modificata da un altro utente.");
    }
    int64_t count = scalar_id("SELECT count(*) FROM columns WHERE board_id=?1 AND deleted_at IS NULL", board);
    if (!create)
        count--;
    if (p && position > count) {
        ob_free(title);
        return error_response(400, "Posizione della lista non valida.");
    }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO columns(board_id,title,position,wip_limit)VALUES(?1,?2,?3,?4)");
        sqlite3_bind_int64(s, 1, board);
        bind_text(s, 2, title);
        sqlite3_bind_int64(s, 3, count);
        sqlite3_bind_int64(s, 4, wip);
    } else {
        s = prepare("UPDATE columns SET title=coalesce(?2,title),wip_limit=coalesce(?3,wip_limit)WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (title)
            bind_text(s, 2, title);
        if (w)
            sqlite3_bind_int64(s, 3, wip);
    }
    ob_free(title);
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok)
        return error_response(503, "Impossibile salvare la lista.");
    if (create)
        id = sqlite3_last_insert_rowid(db);
    if (p) {
        s = prepare("UPDATE columns SET position=-1 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_step(s);
        sqlite3_finalize(s);
        s = prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n FROM columns WHERE "
                    "board_id=?1 AND id<>?2 AND deleted_at IS NULL)UPDATE columns SET position=(SELECT n FROM ranked "
                    "WHERE ranked.id=columns.id)+CASE WHEN (SELECT n FROM ranked WHERE ranked.id=columns.id)>=?3 THEN "
                    "1 ELSE 0 END WHERE board_id=?1 AND id<>?2 AND deleted_at IS NULL");
        sqlite3_bind_int64(s, 1, board);
        sqlite3_bind_int64(s, 2, id);
        sqlite3_bind_int64(s, 3, position);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino fallito");
        sqlite3_finalize(s);
        s = prepare("UPDATE columns SET position=?2 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, position);
        sqlite3_step(s);
        sqlite3_finalize(s);
    }
    title = resource_title("columns", id);
    record_event(r, board, create ? "created" : "updated", "columns", id, title);
    ob_free(title);
    return mutation_success(create ? 201 : 200, "columns", id);
}
static Response save_card(Request *r, int64_t id, bool create) {
    const char *fields[] = {"title", "description", "label", "due_date", "assignee", "cover", "priority"};
    size_t limits[] = {300, 10000, 30, 10, 100, 20, 10};
    const char *priorities[] = {"low", "normal", "high", "urgent"};
    char *values[7] = {0}, *checklist = NULL, *multi_labels = NULL;
    int64_t completed = 0, target_column = 0, position = 0, archived = 0, estimate = 0;
    int cp = json_integer(r->body, "completed", &completed, 0, 1, true),
        colp = json_integer(r->body, "column_id", &target_column, 1, INT64_MAX, false),
        pp = json_integer(r->body, "position", &position, 0, INT_MAX, false),
        ap = json_integer(r->body, "archived", &archived, 0, 1, true),
        ep = json_integer(r->body, "estimate_minutes", &estimate, 0, 100000, false),
        kp = json_checklist(r->body, &checklist), lp = json_labels(r->body, &multi_labels);
    bool valid = cp >= 0 && colp >= 0 && pp >= 0 && ap >= 0 && ep >= 0 && kp >= 0 && lp >= 0;
    int titlep = 0;
    for (size_t i = 0; i < 7; i++) {
        int p = json_string(r->body, fields[i], &values[i], limits[i]);
        valid = valid && p >= 0;
        if (i == 0)
            titlep = p;
    }
    valid = valid && (!create || titlep == 1) && (!values[0] || nonblank(values[0])) &&
            (!values[2] || one_of(values[2], labels, COUNT_OF(labels))) && (!values[3] || valid_date(values[3])) &&
            (!values[5] || one_of(values[5], covers, COUNT_OF(covers))) &&
            (!values[6] || one_of(values[6], priorities, 4));
    Response result;
    if (!valid) {
        result = error_response(400, "Dati della scheda non validi.");
        goto done;
    }
    if (multi_labels) {
        sqlite3_stmt *primary_label = prepare("SELECT coalesce(json_extract(?1,'$[0]'),'')");
        bind_text(primary_label, 1, multi_labels);
        if (sqlite3_step(primary_label) != SQLITE_ROW)
            db_die("Etichette non disponibili");
        ob_free(values[2]);
        values[2] = copy_string((const char *)sqlite3_column_text(primary_label, 0));
        sqlite3_finalize(primary_label);
    }
    int64_t source_column =
        create ? id : scalar_id("SELECT column_id FROM cards WHERE id=?1 AND deleted_at IS NULL", id);
    if (!source_column || !accessible(r, create ? "columns" : "cards", id, true, false)) {
        result = error_response(404, "Scheda o lista non trovata.");
        goto done;
    }
    if (!create && !precondition(r, "cards", id)) {
        result = error_response(412, "Scheda modificata da un altro utente. Ricarica prima di salvare.");
        goto done;
    }
    if (!colp || create)
        target_column = source_column;
    int64_t source_board = resource_board("columns", source_column, false),
            target_board = resource_board("columns", target_column, false);
    if (!target_board) {
        result = error_response(404, "Lista di destinazione non trovata.");
        goto done;
    }
    if (source_board != target_board) {
        result = error_response(400, "Puoi spostare le schede solo nella stessa bacheca.");
        goto done;
    }
    int64_t count = scalar_id("SELECT count(*) FROM cards WHERE column_id=?1 AND deleted_at IS NULL", target_column);
    if (!create && source_column == target_column)
        count--;
    if (pp && position > count) {
        result = error_response(400, "Posizione della scheda non valida.");
        goto done;
    }
    int64_t old_completed = create ? 0 : scalar_id("SELECT completed FROM cards WHERE id=?1", id),
            old_archived = create ? 0 : scalar_id("SELECT archived FROM cards WHERE id=?1", id);
    bool active = !(cp ? completed : old_completed) && !(ap ? archived : old_archived);
    bool adds = active && (create || target_column != source_column || old_completed || old_archived);
    int64_t wip = scalar_id("SELECT wip_limit FROM columns WHERE id=?1", target_column);
    if (adds && wip &&
        scalar_id("SELECT count(*) FROM cards WHERE column_id=?1 AND deleted_at IS NULL AND archived=0 AND completed=0",
                  target_column) >= wip) {
        result = error_response(409, "Limite WIP della lista raggiunto.");
        goto done;
    }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO "
                    "cards(column_id,title,description,label,due_date,assignee,cover,completed,checklist,position,"
                    "priority,labels,estimate_minutes,archived)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)");
        sqlite3_bind_int64(s, 1, source_column);
        for (int i = 0; i < 6; i++)
            bind_text(s, i + 2, values[i]);
        sqlite3_bind_int64(s, 8, completed);
        bind_text(s, 9, checklist ? checklist : "[]");
        sqlite3_bind_int64(s, 10, count);
        bind_text(s, 11, values[6] ? values[6] : "normal");
        if (multi_labels)
            bind_text(s, 12, multi_labels);
        else if (values[2] && *values[2]) {
            sqlite3_stmt *j = prepare("SELECT json_array(?1)");
            bind_text(j, 1, values[2]);
            sqlite3_step(j);
            bind_text(s, 12, (const char *)sqlite3_column_text(j, 0));
            sqlite3_finalize(j);
        } else
            bind_text(s, 12, "[]");
        sqlite3_bind_int64(s, 13, estimate);
        sqlite3_bind_int64(s, 14, archived);
    } else {
        s = prepare(
            "UPDATE cards SET "
            "title=coalesce(?2,title),description=coalesce(?3,description),label=coalesce(?4,label),due_date=coalesce(?"
            "5,due_date),assignee=coalesce(?6,assignee),cover=coalesce(?7,cover),completed=coalesce(?8,completed),"
            "checklist=coalesce(?9,checklist),priority=coalesce(?10,priority),labels=CASE WHEN ?11 IS NOT NULL THEN "
            "?11 WHEN ?4 IS NOT NULL THEN CASE WHEN ?4='' THEN '[]' ELSE json_array(?4) END ELSE labels "
            "END,estimate_minutes=coalesce(?12,estimate_minutes),archived=coalesce(?13,archived)WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        for (int i = 0; i < 6; i++)
            if (values[i])
                bind_text(s, i + 2, values[i]);
        if (cp)
            sqlite3_bind_int64(s, 8, completed);
        if (checklist)
            bind_text(s, 9, checklist);
        if (values[6])
            bind_text(s, 10, values[6]);
        if (multi_labels)
            bind_text(s, 11, multi_labels);
        if (ep)
            sqlite3_bind_int64(s, 12, estimate);
        if (ap)
            sqlite3_bind_int64(s, 13, archived);
    }
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok) {
        result = error_response(503, "Impossibile salvare la scheda.");
        goto done;
    }
    if (create)
        id = sqlite3_last_insert_rowid(db);
    if ((!create && target_column != source_column) || pp) {
        s = prepare("UPDATE cards SET column_id=?2,position=-1 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, target_column);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Spostamento fallito");
        sqlite3_finalize(s);
        if (source_column != target_column && !normalize_cards(source_column))
            db_die("Riordino fallito");
        if (!pp)
            position = count;
        s = prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n FROM cards WHERE column_id=?1 "
                    "AND id<>?2 AND deleted_at IS NULL)UPDATE cards SET position=(SELECT n FROM ranked WHERE "
                    "ranked.id=cards.id)+CASE WHEN (SELECT n FROM ranked WHERE ranked.id=cards.id)>=?3 THEN 1 ELSE 0 "
                    "END WHERE column_id=?1 AND id<>?2 AND deleted_at IS NULL");
        sqlite3_bind_int64(s, 1, target_column);
        sqlite3_bind_int64(s, 2, id);
        sqlite3_bind_int64(s, 3, position);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino fallito");
        sqlite3_finalize(s);
        s = prepare("UPDATE cards SET position=?2 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, position);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino fallito");
        sqlite3_finalize(s);
    }
    if (!normalize_cards(target_column))
        db_die("Riordino fallito");
    char *title = resource_title("cards", id);
    record_event(r, source_board,
                 create                           ? "created"
                 : ap                             ? (archived ? "archived" : "unarchived")
                 : target_column != source_column ? "moved"
                                                  : "updated",
                 "cards", id, title);
    ob_free(title);
    result = mutation_success(create ? 201 : 200, "cards", id);
done:
    for (size_t i = 0; i < 7; i++)
        ob_free(values[i]);
    ob_free(checklist);
    ob_free(multi_labels);
    return result;
}
static Response delete_resource(Request *r, const char *kind, int64_t id) {
    if (!accessible(r, kind, id, true, false))
        return error_response(404, "Risorsa non trovata.");
    if (!precondition(r, kind, id))
        return error_response(412, "Risorsa modificata da un altro utente.");
    int64_t board = resource_board(kind, id, false),
            parent = !strcmp(kind, "columns") ? board
                     : !strcmp(kind, "cards") ? scalar_id("SELECT column_id FROM cards WHERE id=?1", id)
                                              : 0;
    char sql[200];
    snprintf(sql, sizeof sql, "UPDATE %s SET deleted_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') WHERE id=?1", kind);
    if (!run_id(sql, id))
        return error_response(503, "Impossibile spostare nel cestino.");
    if (parent) {
        bool ok = !strcmp(kind, "cards") ? normalize_cards(parent) : normalize_columns(parent);
        if (!ok)
            db_die("Riordino fallito");
    }
    char *title = resource_title(kind, id);
    record_event(r, board, "deleted", kind, id, title);
    ob_free(title);
    return mutation_success(200, kind, id);
}
static Response restore_resource(Request *r, const char *kind, int64_t id) {
    if (strcmp(kind, "boards") && strcmp(kind, "columns") && strcmp(kind, "cards"))
        return error_response(404, "Risorsa non trovata.");
    if (!accessible(r, kind, id, true, true))
        return error_response(404, "Risorsa non trovata.");
    int64_t board = resource_board(kind, id, true);
    char sql[256];
    snprintf(sql, sizeof sql, "SELECT count(*) FROM %s WHERE id=?1 AND deleted_at IS NOT NULL", kind);
    if (!scalar_id(sql, id))
        return error_response(409, "Risorsa già ripristinata.");
    if (strcmp(kind, "boards") &&
        scalar_id("SELECT count(*) FROM boards WHERE id=?1 AND deleted_at IS NOT NULL", board))
        return error_response(409, "Ripristina prima la bacheca.");
    int64_t parent = 0;
    if (!strcmp(kind, "cards")) {
        parent = scalar_id("SELECT column_id FROM cards WHERE id=?1", id);
        if (scalar_id("SELECT count(*) FROM columns WHERE id=?1 AND deleted_at IS NOT NULL", parent))
            return error_response(409, "Ripristina prima la lista.");
        int64_t wip = scalar_id("SELECT wip_limit FROM columns WHERE id=?1", parent);
        if (wip && !scalar_id("SELECT completed OR archived FROM cards WHERE id=?1", id) &&
            scalar_id(
                "SELECT count(*) FROM cards WHERE column_id=?1 AND deleted_at IS NULL AND archived=0 AND completed=0",
                parent) >= wip)
            return error_response(409, "Limite WIP della lista raggiunto.");
    } else if (!strcmp(kind, "columns"))
        parent = board;
    snprintf(sql, sizeof sql, "UPDATE %s SET deleted_at=NULL WHERE id=?1", kind);
    if (!run_id(sql, id))
        return error_response(503, "Ripristino fallito.");
    if (parent) {
        bool ok = !strcmp(kind, "cards") ? normalize_cards(parent) : normalize_columns(parent);
        if (!ok)
            db_die("Riordino fallito");
    }
    char *title = resource_title(kind, id);
    record_event(r, board, "restored", kind, id, title);
    ob_free(title);
    return mutation_success(200, kind, id);
}
static Response duplicate_card(Request *r, int64_t id) {
    if (!accessible(r, "cards", id, true, false))
        return error_response(404, "Scheda non trovata.");
    int64_t target = scalar_id("SELECT column_id FROM cards WHERE id=?1", id);
    int p = json_integer(r->body, "column_id", &target, 1, INT64_MAX, false);
    if (p < 0)
        return error_response(400, "Lista non valida.");
    if (resource_board("columns", target, false) != resource_board("cards", id, false))
        return error_response(400, "La lista deve appartenere alla stessa bacheca.");
    sqlite3_stmt *s = prepare("SELECT json_remove(data,'$.position') FROM ob_card_objects WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_step(s);
    char *body = copy_string((const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    Request duplicate = *r;
    duplicate.body = body;
    duplicate.if_match[0] = 0;
    Response res = save_card(&duplicate, target, true);
    ob_free(body);
    return res;
}
static Response duplicate_board(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    char *name = NULL;
    int np = json_string(r->body, "name", &name, 200);
    if (np < 0 || (name && !nonblank(name))) {
        ob_free(name);
        return error_response(400, "Nome non valido.");
    }
    sqlite3_stmt *s = prepare("INSERT INTO boards(name,description,color)SELECT coalesce(?2,substr(name,1,192)||' "
                              "(copia)'),description,color FROM boards WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (name)
        bind_text(s, 2, name);
    ob_free(name);
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok)
        return error_response(503, "Duplicazione fallita.");
    int64_t newboard = sqlite3_last_insert_rowid(db);
    if (!auth_add_board_owner(r, newboard))
        db_die("Assegnazione proprietario fallita");
    s = prepare("SELECT id,title,position,wip_limit FROM columns WHERE board_id=?1 AND deleted_at IS NULL ORDER BY "
                "position,id");
    sqlite3_bind_int64(s, 1, id);
    while (sqlite3_step(s) == SQLITE_ROW) {
        sqlite3_stmt *c = prepare("INSERT INTO columns(board_id,title,position,wip_limit)VALUES(?1,?2,?3,?4)");
        sqlite3_bind_int64(c, 1, newboard);
        bind_text(c, 2, (const char *)sqlite3_column_text(s, 1));
        sqlite3_bind_int64(c, 3, sqlite3_column_int64(s, 2));
        sqlite3_bind_int64(c, 4, sqlite3_column_int64(s, 3));
        if (sqlite3_step(c) != SQLITE_DONE)
            db_die("Duplicazione lista fallita");
        sqlite3_finalize(c);
        int64_t nc = sqlite3_last_insert_rowid(db);
        c = prepare("INSERT INTO "
                    "cards(column_id,title,description,label,due_date,assignee,cover,position,completed,checklist,"
                    "priority,labels,estimate_minutes,archived)SELECT "
                    "?2,title,description,label,due_date,assignee,cover,position,completed,checklist,priority,labels,"
                    "estimate_minutes,archived FROM cards WHERE column_id=?1 AND deleted_at IS NULL");
        sqlite3_bind_int64(c, 1, sqlite3_column_int64(s, 0));
        sqlite3_bind_int64(c, 2, nc);
        if (sqlite3_step(c) != SQLITE_DONE)
            db_die("Duplicazione schede fallita");
        sqlite3_finalize(c);
    }
    sqlite3_finalize(s);
    char *title = resource_title("boards", newboard);
    record_event(r, newboard, "duplicated", "boards", newboard, title);
    ob_free(title);
    return mutation_success(201, "boards", newboard);
}
static Response comments_api(Request *r, int64_t id, bool post) {
    if (!accessible(r, "cards", id, post, false))
        return error_response(404, "Scheda non trovata.");
    if (!post)
        return query_json("SELECT json_object('comments',json((SELECT json_group_array(json(item))FROM(SELECT "
                          "json_object('id',id,'body',body,'author_id',author_id,'author',author,'created_at',created_"
                          "at)item FROM comments WHERE card_id=?1 ORDER BY id))))",
                          id);
    char *body = NULL;
    if (json_string(r->body, "body", &body, 5000) != 1 || !body || !nonblank(body)) {
        ob_free(body);
        return error_response(400, "Il commento deve contenere da 1 a 5000 caratteri.");
    }
    char *actor = actor_name(r);
    sqlite3_stmt *s = prepare("INSERT INTO comments(card_id,author_id,author,body)VALUES(?1,?2,?3,?4)");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, r->user_id);
    bind_text(s, 3, actor);
    bind_text(s, 4, body);
    ob_free(actor);
    ob_free(body);
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok)
        return error_response(503, "Commento non salvato.");
    int64_t cid = sqlite3_last_insert_rowid(db);
    char *title = resource_title("cards", id);
    record_event(r, resource_board("cards", id, false), "commented", "cards", id, title);
    ob_free(title);
    return success(201, cid);
}
static Response delete_comment(Request *r, int64_t id) {
    int64_t card = scalar_id("SELECT card_id FROM comments WHERE id=?1", id);
    if (!card || !accessible(r, "cards", card, true, false))
        return error_response(404, "Commento non trovato.");
    if (ob_config.auth_enabled && !auth_is_admin(r) &&
        scalar_id("SELECT author_id FROM comments WHERE id=?1", id) != r->user_id)
        return error_response(403, "Puoi eliminare solo i tuoi commenti.");
    if (!run_id("DELETE FROM comments WHERE id=?1", id))
        return error_response(503, "Commento non eliminato.");
    char *title = resource_title("cards", card);
    record_event(r, resource_board("cards", card, false), "comment_deleted", "cards", card, title);
    ob_free(title);
    return success(200, id);
}
static Response board_activity(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    return query_json("SELECT json_object('events',json((SELECT json_group_array(json(item))FROM(SELECT "
                      "json_object('id',id,'action',action,'entity_type',entity_type,'entity_id',entity_id,'title',"
                      "title,'actor',actor,'actor_id',actor_id,'created_at',created_at)item FROM activity WHERE "
                      "board_id=?1 ORDER BY id DESC LIMIT 200))))",
                      id);
}
static Response board_stats(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    return query_json(
        "WITH active AS(SELECT k.* FROM cards k JOIN columns c ON c.id=k.column_id WHERE c.board_id=?1 AND "
        "k.deleted_at IS NULL AND k.archived=0 AND c.deleted_at IS NULL)SELECT json_object('total',(SELECT "
        "count(*)FROM active),'completed',(SELECT count(*)FROM active WHERE completed=1),'overdue',(SELECT "
        "count(*)FROM active WHERE completed=0 AND due_date<>'' AND due_date<date('now')),'estimate_minutes',(SELECT "
        "coalesce(sum(estimate_minutes),0)FROM active),'by_label',json((SELECT json_group_object(label,n)FROM(SELECT "
        "j.value label,count(*)n FROM active a,json_each(a.labels)j GROUP BY j.value))),'by_assignee',json((SELECT "
        "json_group_object(assignee,n)FROM(SELECT CASE WHEN assignee='' THEN 'Non assegnato' ELSE assignee END "
        "assignee,count(*)n FROM active GROUP BY CASE WHEN assignee='' THEN 'Non assegnato' ELSE assignee "
        "END))),'by_priority',json((SELECT "
        "json_group_object(priority,n)FROM(SELECT priority,count(*)n FROM active GROUP BY priority))))",
        id);
}
static Response trash_api(void) {
    return query_json("SELECT json_object('items',json((SELECT json_group_array(json(item))FROM(SELECT "
                      "json_object('kind','boards','id',id,'title',name,'deleted_at',deleted_at,'board_id',id)item,"
                      "deleted_at FROM boards WHERE deleted_at IS NOT NULL AND ob_allowed(id) UNION ALL SELECT "
                      "json_object('kind','columns','id',id,'title',title,'deleted_at',deleted_at,'board_id',board_id),"
                      "deleted_at FROM columns WHERE deleted_at IS NOT NULL AND ob_allowed(board_id) UNION ALL SELECT "
                      "json_object('kind','cards','id',k.id,'title',k.title,'deleted_at',k.deleted_at,'board_id',c."
                      "board_id),k.deleted_at FROM cards k JOIN columns c ON c.id=k.column_id WHERE k.deleted_at IS "
                      "NOT NULL AND ob_allowed(c.board_id) ORDER BY deleted_at DESC))))",
                      0);
}
static bool query_value(Request *r, const char *key, char *out, size_t cap) {
    return ob_query(r, key, out, cap) == 1;
}
static Response search_api(Request *r) {
    char term[801];
    if (!query_value(r, "q", term, sizeof term) || !nonblank(term))
        return error_response(400, "Specifica un testo di ricerca valido (max 200 caratteri).");
    size_t characters = 0;
    for (const unsigned char *p = (const unsigned char *)term; *p; p++)
        if ((*p & 0xc0) != 0x80)
            characters++;
    if (characters > 200)
        return error_response(400, "Il testo di ricerca può contenere al massimo 200 caratteri.");
    sqlite3_stmt *s =
        prepare("SELECT json_object('cards',json((SELECT json_group_array(json(item))FROM(SELECT "
                "json_object('id',k.id,'title',k.title,'board_id',b.id,'board_name',b.name,'column_title',c.title,'"
                "priority',k.priority,'due_date',k.due_date)item FROM cards k JOIN columns c ON c.id=k.column_id JOIN "
                "boards b ON b.id=c.board_id WHERE k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS "
                "NULL AND (ob_archived() OR(k.archived=0 AND b.archived=0))AND ob_allowed(b.id) "
                "AND(instr(lower(k.title),lower(?1))>0 OR instr(lower(k.description),lower(?1))>0 OR "
                "instr(lower(k.assignee),lower(?1))>0)ORDER BY k.updated_at DESC LIMIT 200))))");
    bind_text(s, 1, term);
    Response result = sqlite3_step(s) == SQLITE_ROW ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                                                    : error_response(503, "Ricerca temporaneamente non disponibile.");
    sqlite3_finalize(s);
    return result;
}
static Response export_board(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    bool old_summary = summary_mode, old_archive = include_archived;
    summary_mode = false;
    include_archived = true;
    Response out = query_json(
        "SELECT json_object('format','openboard','version',2,'board',json(data))FROM ob_board_objects WHERE id=?1", id);
    summary_mode = old_summary;
    include_archived = old_archive;
    snprintf(out.headers, sizeof out.headers, "Content-Disposition: attachment; filename=\"openboard-%lld.json\"\r\n",
             (long long)id);
    return out;
}
static Response import_board(Request *r) {
    char *format = NULL;
    int64_t version = 0;
    int fp = json_string(r->body, "format", &format, 20), vp = json_integer(r->body, "version", &version, 2, 2, false);
    bool valid = fp == 1 && !strcmp(format, "openboard") && vp == 1;
    ob_free(format);
    if (!valid)
        return error_response(400, "Formato di importazione non valido: usa OpenBoard versione 2.");
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.board'),json_extract(?1,'$.board')");
    bind_text(s, 1, r->body);
    char *board = NULL;
    if (sqlite3_step(s) == SQLITE_ROW && sqlite3_column_text(s, 0) &&
        !strcmp((const char *)sqlite3_column_text(s, 0), "object"))
        board = copy_string((const char *)sqlite3_column_text(s, 1));
    sqlite3_finalize(s);
    if (!board)
        return error_response(400, "Bacheca da importare non valida.");
    if (!valid_object(board)) {
        ob_free(board);
        return error_response(400, "Bacheca da importare non valida.");
    }
    s = prepare("SELECT json_type(?1,'$.columns')='array' AND json_array_length(?1,'$.columns')<=100");
    bind_text(s, 1, board);
    valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid) {
        ob_free(board);
        return error_response(400, "L'importazione richiede un array di massimo 100 liste.");
    }
    Request part = *r;
    part.body = board;
    part.if_match[0] = 0;
    Response result = save_board(&part, 0, true);
    if (result.status != 201) {
        ob_free(board);
        return result;
    }
    int64_t bid = 0;
    json_integer(result.body, "id", &bid, 1, INT64_MAX, false);
    ob_free(result.body);
    if (!run_id("DELETE FROM columns WHERE board_id=?1", bid))
        db_die("Preparazione importazione fallita");
    s = prepare("SELECT value,type FROM json_each(?1,'$.columns')");
    bind_text(s, 1, board);
    size_t total = 0;
    result = success(201, bid);
    while (sqlite3_step(s) == SQLITE_ROW) {
        if (strcmp((const char *)sqlite3_column_text(s, 1), "object")) {
            ob_free(result.body);
            result = error_response(400, "Lista importata non valida.");
            break;
        }
        char *column = copy_string((const char *)sqlite3_column_text(s, 0));
        sqlite3_stmt *j =
            prepare("SELECT json_type(?1,'$.cards')='array',json_remove(?1,'$.cards','$.position','$.wip_limit')");
        bind_text(j, 1, column);
        bool cards_ok = sqlite3_step(j) == SQLITE_ROW && sqlite3_column_int(j, 0);
        char *colbody = copy_string((const char *)sqlite3_column_text(j, 1));
        sqlite3_finalize(j);
        int64_t wip = 0;
        int wp = json_integer(column, "wip_limit", &wip, 0, 100000, false);
        if (!cards_ok || wp < 0 || !valid_object(column)) {
            ob_free(column);
            ob_free(colbody);
            ob_free(result.body);
            result = error_response(400, "Schede o limite WIP importati non validi.");
            break;
        }
        part.body = colbody;
        Response colres = save_column(&part, bid, true);
        ob_free(colbody);
        if (colres.status != 201) {
            ob_free(column);
            ob_free(result.body);
            result = colres;
            break;
        }
        int64_t cid = 0;
        json_integer(colres.body, "id", &cid, 1, INT64_MAX, false);
        ob_free(colres.body);
        j = prepare("SELECT value,type FROM json_each(?1,'$.cards')");
        bind_text(j, 1, column);
        bool bad = false;
        while (sqlite3_step(j) == SQLITE_ROW) {
            if (++total > 10000 || strcmp((const char *)sqlite3_column_text(j, 1), "object")) {
                ob_free(result.body);
                result = error_response(400, "Scheda importata non valida o limite di 10000 schede superato.");
                bad = true;
                break;
            }
            sqlite3_stmt *k = prepare("SELECT json_remove(?1,'$.position','$.column_id')");
            bind_text(k, 1, (const char *)sqlite3_column_text(j, 0));
            sqlite3_step(k);
            char *body = copy_string((const char *)sqlite3_column_text(k, 0));
            sqlite3_finalize(k);
            if (!valid_object(body)) {
                ob_free(body);
                ob_free(result.body);
                result = error_response(400, "Scheda importata non valida.");
                bad = true;
                break;
            }
            part.body = body;
            Response cardres = save_card(&part, cid, true);
            ob_free(body);
            if (cardres.status != 201) {
                ob_free(result.body);
                result = cardres;
                bad = true;
                break;
            }
            ob_free(cardres.body);
        }
        sqlite3_finalize(j);
        ob_free(column);
        if (bad)
            break;
        j = prepare("UPDATE columns SET wip_limit=?2 WHERE id=?1");
        sqlite3_bind_int64(j, 1, cid);
        sqlite3_bind_int64(j, 2, wip);
        if (sqlite3_step(j) != SQLITE_DONE)
            db_die("Importazione limite WIP fallita");
        sqlite3_finalize(j);
    }
    sqlite3_finalize(s);
    ob_free(board);
    if (result.status == 201) {
        ob_free(result.body);
        char *title = resource_title("boards", bid);
        record_event(r, bid, "imported", "boards", bid, title);
        ob_free(title);
        return mutation_success(201, "boards", bid);
    }
    return result;
}
static Response route_domain(Request *r) {
    bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"), patch = !strcmp(r->method, "PATCH"),
         del = !strcmp(r->method, "DELETE");
    if (!strcmp(r->path, "/api/boards")) {
        if (get)
            return query_json(
                "SELECT json_object('boards',json((SELECT json_group_array(json(item))FROM(SELECT "
                "json_object('id',id,'name',name,'description',description,'color',color,'starred',json(CASE "
                "ob_starred(id,starred)WHEN 1 THEN 'true' ELSE 'false' END),'archived',json(CASE archived WHEN 1 THEN "
                "'true' ELSE 'false' "
                "END),'version',version,'created_at',created_at,'updated_at',updated_at,'role',ob_role(id),'membership_"
                "role',ob_role(id),'readonly',json(CASE ob_readonly(id)WHEN 1 THEN 'true' ELSE 'false' END))item FROM "
                "boards WHERE deleted_at IS NULL AND(ob_archived() OR archived=0)AND ob_allowed(id)ORDER BY id))))",
                0);
        if (post)
            return save_board(r, 0, true);
        return error_response(405, "Metodo non consentito.");
    }
    if (!strcmp(r->path, "/api/trash"))
        return get ? trash_api() : error_response(405, "Metodo non consentito.");
    if (!strcmp(r->path, "/api/search"))
        return get ? search_api(r) : error_response(405, "Metodo non consentito.");
    if (!strcmp(r->path, "/api/import"))
        return post ? import_board(r) : error_response(405, "Metodo non consentito.");
    char path[1024];
    snprintf(path, sizeof path, "%s", r->path);
    char *parts[7] = {0}, *state = NULL;
    size_t count = 0;
    for (char *p = strtok_r(path, "/", &state); p && count < COUNT_OF(parts); p = strtok_r(NULL, "/", &state))
        parts[count++] = p;
    if (count < 3 || strcmp(parts[0], "api") || strstr(r->path, "//") || r->path[strlen(r->path) - 1] == '/')
        return error_response(404, "Percorso non trovato.");
    if (count == 5 && !strcmp(parts[1], "trash") && !strcmp(parts[4], "restore") && post) {
        int64_t id = parse_id(parts[3]);
        return id ? restore_resource(r, parts[2], id) : error_response(404, "Risorsa non trovata.");
    }
    int64_t id = parse_id(parts[2]);
    if (!id)
        return error_response(404, "Risorsa non trovata.");
    if (!strcmp(parts[1], "comments") && count == 3)
        return del ? delete_comment(r, id) : error_response(405, "Metodo non consentito.");
    bool board = !strcmp(parts[1], "boards"), column = !strcmp(parts[1], "columns"), card = !strcmp(parts[1], "cards");
    if (!board && !column && !card)
        return error_response(404, "Percorso non trovato.");
    if (count == 4) {
        if (post && !strcmp(parts[3], "restore"))
            return restore_resource(r, parts[1], id);
        if (post && !strcmp(parts[3], "duplicate")) {
            if (board)
                return duplicate_board(r, id);
            if (card)
                return duplicate_card(r, id);
        }
        if (board) {
            if (post && !strcmp(parts[3], "columns"))
                return save_column(r, id, true);
            if (get && !strcmp(parts[3], "revision")) {
                if (!accessible(r, "boards", id, false, false))
                    return error_response(404, "Bacheca non trovata.");
                return query_json("SELECT json_object('version',version)FROM boards WHERE id=?1", id);
            }
            if (get && !strcmp(parts[3], "activity"))
                return board_activity(r, id);
            if (get && !strcmp(parts[3], "stats"))
                return board_stats(r, id);
            if (get && !strcmp(parts[3], "export"))
                return export_board(r, id);
        }
        if (column && post && !strcmp(parts[3], "cards"))
            return save_card(r, id, true);
        if (card && !strcmp(parts[3], "comments") && (get || post))
            return comments_api(r, id, post);
        return error_response(404, "Percorso non trovato.");
    }
    if (count != 3)
        return error_response(404, "Percorso non trovato.");
    if (get) {
        if (!accessible(r, parts[1], id, false, false))
            return error_response(404, "Risorsa non trovata.");
        if (board)
            return query_json("SELECT data FROM ob_board_objects WHERE id=?1 AND deleted_at IS NULL", id);
        if (card)
            return query_json("SELECT data FROM ob_card_objects WHERE id=?1 AND deleted_at IS NULL", id);
        return error_response(405, "Metodo non consentito.");
    }
    if (patch) {
        if (board)
            return save_board(r, id, false);
        if (column)
            return save_column(r, id, false);
        return save_card(r, id, false);
    }
    if (del)
        return delete_resource(r, parts[1], id);
    return error_response(405, "Metodo non consentito.");
}
static bool replay_idempotency(Request *r, Response *out) {
    sqlite3_stmt *s =
        prepare("SELECT request_body,status,response_body FROM idempotency WHERE user_id=?1 AND path=?2 AND key=?3");
    sqlite3_bind_int64(s, 1, r->user_id);
    bind_text(s, 2, r->path);
    bind_text(s, 3, r->idempotency_key);
    bool found = sqlite3_step(s) == SQLITE_ROW;
    if (found) {
        if (strcmp((const char *)sqlite3_column_text(s, 0), r->body))
            *out = error_response(409, "Idempotency-Key già usata con un corpo differente.");
        else {
            *out = json_response(sqlite3_column_int(s, 1), (const char *)sqlite3_column_text(s, 2));
            snprintf(out->headers, sizeof out->headers, "Idempotency-Replayed: true\r\n");
        }
    }
    sqlite3_finalize(s);
    return found;
}
static void store_idempotency(Request *r, Response *out) {
    sqlite3_stmt *s =
        prepare("INSERT INTO idempotency(user_id,path,key,request_body,status,response_body)VALUES(?1,?2,?3,?4,?5,?6)");
    sqlite3_bind_int64(s, 1, r->user_id);
    bind_text(s, 2, r->path);
    bind_text(s, 3, r->idempotency_key);
    bind_text(s, 4, r->body);
    sqlite3_bind_int(s, 5, out->status);
    bind_text(s, 6, out->body);
    if (sqlite3_step(s) != SQLITE_DONE) {
        sqlite3_finalize(s);
        db_die("Idempotency non salvata");
    }
    sqlite3_finalize(s);
}
Response ob_route(Request *r) {
    current_request = r;
    outer_transaction = false;
    include_archived = false;
    summary_mode = false;
    recovering = true;
    failure_target = &request_recovery;
    if (setjmp(request_recovery)) {
        recovering = false;
        outer_transaction = false;
        sqlite3_stmt *s;
        while ((s = sqlite3_next_stmt(db, NULL)))
            sqlite3_finalize(s);
        sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
        current_request = NULL;
        failure_target = NULL;
        release_request_allocations();
        return error_response(503, "Database temporaneamente non disponibile. Riprova.");
    }
    bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"), patch = !strcmp(r->method, "PATCH"),
         del = !strcmp(r->method, "DELETE");
    Response result;
    if (!get && !post && !patch && !del) {
        result = error_response(405, "Metodo non consentito.");
        goto done;
    }
    if (!get) {
        if (!del || r->body_len) {
            if (strncasecmp(r->content_type, "application/json", 16) ||
                (r->content_type[16] && r->content_type[16] != ';' && !isspace((unsigned char)r->content_type[16]))) {
                result = error_response(415, "Usa il formato application/json.");
                goto done;
            }
            if (!r->body_len || !valid_object(r->body)) {
                result = error_response(400, "Il corpo deve essere un oggetto JSON valido.");
                goto done;
            }
        }
    }
    if (!strcmp(r->path, "/api/health")) {
        result = get ? json_response(200, "{\"status\":\"ok\"}") : error_response(405, "Metodo non consentito.");
        goto done;
    }
    if (auth_handle(r, &result))
        goto done;
    if (!auth_authorize(r, &result))
        goto done;
    if (!get && !strcmp(r->role, "observer")) {
        result = error_response(403, "Il ruolo osservatore consente solo la lettura.");
        goto done;
    }
    char option[32];
    include_archived = query_value(r, "include_archived", option, sizeof option) && !strcmp(option, "1");
    summary_mode = query_value(r, "summary", option, sizeof option) && !strcmp(option, "1");
    if (!get) {
        if (!begin_transaction()) {
            result = error_response(503, "Database occupato. Riprova.");
            goto done;
        }
        outer_transaction = true;
        if (post && r->idempotency_key[0] && replay_idempotency(r, &result)) {
            sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
            outer_transaction = false;
            goto done;
        }
    }
    result = route_domain(r);
    if (outer_transaction) {
        if (result.status < 400) {
            if (post && r->idempotency_key[0])
                store_idempotency(r, &result);
            if (sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) != SQLITE_OK) {
                sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
                ob_free(result.body);
                result = error_response(503, "Salvataggio temporaneamente non disponibile.");
            }
        } else
            sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
        outer_transaction = false;
    }
done:
    /* All helpers finalize their normal paths. Also collect statements abandoned by a recoverable failure. */
    {
        sqlite3_stmt *statement;
        while ((statement = sqlite3_next_stmt(db, NULL)))
            sqlite3_finalize(statement);
    }
    /* The HTTP layer owns the response body after this return. */
    forget_allocation(result.body);
    release_request_allocations();
    recovering = false;
    failure_target = NULL;
    current_request = NULL;
    return result;
}
