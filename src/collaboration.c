/* OpenBoard watches, notifications, files and personal account tools.
 * SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "collaboration.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void collaboration_schema(sqlite3 *connection) {
  const char *schema =
      "CREATE TABLE board_watches(user_id INTEGER NOT NULL REFERENCES "
      "users(id) ON DELETE CASCADE,board_id INTEGER NOT NULL REFERENCES "
      "boards(id) ON DELETE CASCADE,PRIMARY KEY(user_id,board_id));"
      "CREATE TABLE card_watches(user_id INTEGER NOT NULL REFERENCES users(id) "
      "ON DELETE CASCADE,card_id INTEGER NOT NULL REFERENCES cards(id) ON "
      "DELETE CASCADE,PRIMARY KEY(user_id,card_id));"
      "CREATE INDEX card_watches_card ON card_watches(card_id,user_id);"
      "CREATE INDEX board_watches_board ON board_watches(board_id,user_id);"
      "CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id "
      "INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,activity_id "
      "INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE,read_at "
      "TEXT,UNIQUE(user_id,activity_id));"
      "CREATE INDEX notifications_user ON notifications(user_id,id DESC);"
      "CREATE TRIGGER activity_notifications AFTER INSERT ON activity BEGIN "
      "INSERT OR IGNORE INTO notifications(user_id,activity_id) SELECT "
      "DISTINCT u.id,NEW.id FROM users u JOIN boards b ON b.id=NEW.board_id "
      "WHERE u.active=1 AND u.id<>NEW.actor_id AND b.deleted_at IS NULL AND "
      "(u.role='admin' OR EXISTS(SELECT 1 FROM board_members m WHERE "
      "m.board_id=NEW.board_id AND m.user_id=u.id)) "
      "AND (EXISTS(SELECT 1 FROM board_watches w WHERE w.user_id=u.id AND "
      "w.board_id=NEW.board_id) OR (NEW.entity_type='cards' AND EXISTS(SELECT "
      "1 FROM card_watches w WHERE w.user_id=u.id AND "
      "w.card_id=NEW.entity_id)));END;"
      "CREATE TABLE attachments(id INTEGER PRIMARY KEY AUTOINCREMENT,card_id "
      "INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,author_id "
      "INTEGER NOT NULL DEFAULT 0,name TEXT NOT NULL,mime TEXT NOT "
      "NULL,data_base64 TEXT NOT NULL,size INTEGER NOT NULL CHECK(size BETWEEN "
      "0 AND 1048576),created_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),deleted_at TEXT);"
      "CREATE INDEX attachments_card ON attachments(card_id,id);"
      "ALTER TABLE comments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;"
      "ALTER TABLE comments ADD COLUMN edited_at TEXT;"
      "ALTER TABLE sessions ADD COLUMN public_id TEXT NOT NULL DEFAULT '';"
      "UPDATE sessions SET public_id=lower(hex(randomblob(16)));"
      "CREATE UNIQUE INDEX sessions_public ON sessions(public_id);"
      "CREATE TRIGGER session_public_id AFTER INSERT ON sessions WHEN "
      "NEW.public_id='' BEGIN UPDATE sessions SET "
      "public_id=lower(hex(randomblob(16))) WHERE "
      "token_hash=NEW.token_hash;END;";
  char *error = NULL;
  if (sqlite3_exec(connection, schema, NULL, NULL, &error) != SQLITE_OK) {
    fprintf(stderr, "Schema collaborazione non disponibile: %s\n",
            error ? error : sqlite3_errmsg(connection));
    sqlite3_free(error);
    exit(EXIT_FAILURE);
  }
}

static bool done(sqlite3_stmt *s) {
  bool ok = sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static Response row_json(sqlite3_stmt *s) {
  int rc = sqlite3_step(s);
  Response response =
      rc == SQLITE_ROW
          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
          : error_response(rc == SQLITE_DONE ? 404 : 503,
                           rc == SQLITE_DONE
                               ? "Risorsa non trovata."
                               : "Database temporaneamente non disponibile.");
  sqlite3_finalize(s);
  return response;
}
static Response unavailable(void) {
  return error_response(503, "Salvataggio temporaneamente non disponibile.");
}
static bool signed_in(Request *r, Response *response) {
  if (ob_config.auth_enabled && r->user_id)
    return true;
  *response = error_response(
      403, "Questa funzione richiede account e avvio con --auth.");
  return false;
}
static int64_t card_board(int64_t id) {
  sqlite3_stmt *s = prepare(
      "SELECT c.board_id FROM cards k JOIN columns c ON c.id=k.column_id JOIN "
      "boards b ON b.id=c.board_id WHERE k.id=?1 AND k.deleted_at IS NULL AND "
      "c.deleted_at IS NULL AND b.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, id);
  int64_t board =
      sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
  sqlite3_finalize(s);
  return board;
}
static bool board_live(int64_t id) {
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, id);
  bool live = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return live;
}
static bool allowed_card(Request *r, int64_t id, bool write, int64_t *board) {
  *board = card_board(id);
  return *board && auth_board_allowed(r, *board, write);
}
static bool record_event(Request *r, int64_t card, int64_t board,
                         const char *action) {
  sqlite3_stmt *s =
      prepare("INSERT INTO "
              "activity(board_id,actor_id,actor,action,entity_type,entity_id,"
              "title) SELECT ?1,?2,coalesce((SELECT name FROM users WHERE "
              "id=?2),'Locale'),?3,'cards',id,title FROM cards WHERE id=?4");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, action);
  sqlite3_bind_int64(s, 4, card);
  if (!done(s))
    return false;
  s = prepare("UPDATE boards SET "
              "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
              ") WHERE id=?1");
  sqlite3_bind_int64(s, 1, board);
  return done(s);
}
static bool pagination(Request *r, int64_t *before, int64_t *limit) {
  char value[40];
  *before = INT64_MAX;
  *limit = 30;
  int found = ob_query(r, "before", value, sizeof value);
  if (found < 0 || (found && !(*before = parse_id(value))))
    return false;
  found = ob_query(r, "limit", value, sizeof value);
  if (found < 0 || (found && (!(*limit = parse_id(value)) || *limit > 100)))
    return false;
  return true;
}
static Response watch(Request *r, int64_t id, bool card) {
  int64_t board = card ? card_board(id) : id;
  if (!board || (!card && !board_live(board)) ||
      !auth_board_allowed(r, board, false))
    return error_response(404, "Risorsa non trovata.");
  int64_t watching;
  if (json_integer(r->body, "watching", &watching, 0, 1, true) != 1)
    return error_response(400, "Il campo watching deve essere booleano.");
  const char *sql =
      card ? (watching
                  ? "INSERT OR IGNORE INTO card_watches(user_id,card_id) "
                    "VALUES(?1,?2)"
                  : "DELETE FROM card_watches WHERE user_id=?1 AND card_id=?2")
           : (watching ? "INSERT OR IGNORE INTO "
                         "board_watches(user_id,board_id) VALUES(?1,?2)"
                       : "DELETE FROM board_watches WHERE user_id=?1 AND "
                         "board_id=?2");
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int64(s, 2, id);
  if (!done(s))
    return unavailable();
  char result[128];
  snprintf(result, sizeof result, "{\"ok\":true,\"id\":%lld,\"watching\":%s}",
           (long long)id, watching ? "true" : "false");
  return json_response(200, result);
}
static Response watches(Request *r) {
  sqlite3_stmt *s = prepare(
      "SELECT json_object('boards',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT json_object('id',b.id,'name',b.name)item FROM board_watches "
      "w JOIN boards b ON b.id=w.board_id WHERE w.user_id=?1 AND b.deleted_at "
      "IS NULL AND (?2 OR EXISTS(SELECT 1 FROM board_members m WHERE "
      "m.user_id=?1 AND m.board_id=b.id)) ORDER BY "
      "b.id))),'cards',json((SELECT json_group_array(json(item))FROM(SELECT "
      "json_object('id',k.id,'title',k.title,'board_id',b.id)item FROM "
      "card_watches w JOIN cards k ON k.id=w.card_id JOIN columns c ON "
      "c.id=k.column_id JOIN boards b ON b.id=c.board_id WHERE w.user_id=?1 "
      "AND k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS "
      "NULL AND (?2 OR EXISTS(SELECT 1 FROM board_members m WHERE m.user_id=?1 "
      "AND m.board_id=b.id)) ORDER BY k.id))))");
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int(s, 2, auth_is_admin(r));
  return row_json(s);
}
#define NOTIFICATION_VISIBLE                                                   \
  "n.user_id=?1 AND b.deleted_at IS NULL AND (?2 OR EXISTS(SELECT 1 FROM "     \
  "board_members m WHERE m.user_id=?1 AND m.board_id=b.id))"
static Response notifications(Request *r, bool count_only) {
  int64_t before, limit;
  if (!pagination(r, &before, &limit))
    return error_response(400,
                          "Cursore positivo e limite da 1 a 100 richiesti.");
  const char *sql =
      count_only
          ? "SELECT json_object('unread_count',count(*)) FROM notifications n "
            "JOIN activity a ON a.id=n.activity_id JOIN boards b ON "
            "b.id=a.board_id WHERE " NOTIFICATION_VISIBLE
            " AND n.read_at IS NULL"
          : "WITH eligible AS(SELECT "
            "n.id,n.read_at,json_object('id',n.id,'activity_id',a.id,'board_id'"
            ",a.board_id,'actor',a.actor,'actor_id',a.actor_id,'action',a."
            "action,'entity_type',a.entity_type,'entity_id',a.entity_id,'title'"
            ",a.title,'created_at',a.created_at,'read',json(CASE WHEN "
            "n.read_at IS NULL THEN 'false' ELSE 'true' END))item FROM "
            "notifications n JOIN activity a ON a.id=n.activity_id JOIN boards "
            "b ON b.id=a.board_id WHERE " NOTIFICATION_VISIBLE
            "),page AS(SELECT * FROM eligible WHERE id<?3 ORDER BY id DESC "
            "LIMIT ?4+1) SELECT json_object('items',json((SELECT "
            "json_group_array(json(item)) FROM(SELECT item FROM page ORDER BY "
            "id DESC LIMIT ?4))),'next_cursor',CASE WHEN(SELECT count(*) FROM "
            "page)>?4 THEN(SELECT min(id) FROM(SELECT id FROM page ORDER BY id "
            "DESC LIMIT ?4)) ELSE NULL END,'unread_count',(SELECT count(*) "
            "FROM eligible WHERE read_at IS NULL))";
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int(s, 2, auth_is_admin(r));
  if (!count_only) {
    sqlite3_bind_int64(s, 3, before);
    sqlite3_bind_int64(s, 4, limit);
  }
  Response response = row_json(s);
  snprintf(response.headers, sizeof response.headers,
           "Cache-Control: no-store\r\n");
  return response;
}
static Response read_notification(Request *r, int64_t id, bool all) {
  int64_t read = 1;
  if (!all && json_integer(r->body, "read", &read, 0, 1, true) != 1)
    return error_response(400, "Il campo read deve essere booleano.");
  sqlite3_stmt *s =
      prepare("UPDATE notifications SET read_at=CASE WHEN ?3 THEN "
              "strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE "
              "user_id=?1 AND (?4=0 OR id=?4) AND activity_id IN(SELECT a.id "
              "FROM activity a JOIN boards b ON b.id=a.board_id WHERE "
              "b.deleted_at IS NULL AND (?2 OR EXISTS(SELECT 1 FROM "
              "board_members m WHERE m.user_id=?1 AND m.board_id=b.id)))");
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int(s, 2, auth_is_admin(r));
  sqlite3_bind_int64(s, 3, read);
  sqlite3_bind_int64(s, 4, all ? 0 : id);
  if (!done(s))
    return unavailable();
  if (!all && !sqlite3_changes(db))
    return error_response(404, "Notifica non trovata.");
  return success(200, all ? 0 : id);
}
/* Canonical padded RFC 4648 base64: reject whitespace, invalid alphabet and
 * unused set bits. */
static int base64_digit(unsigned char c) {
  if (c >= 'A' && c <= 'Z')
    return c - 'A';
  if (c >= 'a' && c <= 'z')
    return c - 'a' + 26;
  if (c >= '0' && c <= '9')
    return c - '0' + 52;
  return c == '+' ? 62 : c == '/' ? 63 : -1;
}
static bool base64_size(const char *value, int64_t *size) {
  size_t length = strlen(value);
  if (length % 4 || length > 1398104)
    return false;
  if (!length) {
    *size = 0;
    return true;
  }
  size_t pad = value[length - 1] == '=' ? 1 : 0;
  if (pad && value[length - 2] == '=')
    pad++;
  for (size_t i = 0; i < length - pad; i++)
    if (base64_digit((unsigned char)value[i]) < 0)
      return false;
  if ((pad == 1 && (base64_digit((unsigned char)value[length - 2]) & 3)) ||
      (pad == 2 && (base64_digit((unsigned char)value[length - 3]) & 15)))
    return false;
  *size = (int64_t)(length / 4 * 3 - pad);
  return *size <= 1048576;
}
static bool filename_valid(const char *name) {
  if (!*name || !strcmp(name, ".") || !strcmp(name, ".."))
    return false;
  for (const unsigned char *p = (const unsigned char *)name; *p; p++)
    if (*p < 32 || *p == 127 || *p == '/' || *p == '\\')
      return false;
  return true;
}
static bool mime_valid(const char *mime) {
  const char *slash = strchr(mime, '/');
  if (!slash || slash == mime || !slash[1] || strchr(slash + 1, '/'))
    return false;
  for (const unsigned char *p = (const unsigned char *)mime; *p; p++)
    if (*p != '/' && !(isalnum(*p) || strchr("!#$&^_.+-", *p)))
      return false;
  return true;
}
static bool attachment_quota(int64_t card, int64_t added) {
  sqlite3_stmt *s =
      prepare("SELECT count(*)<10 AND coalesce(sum(size),0)+?2<=5242880 FROM "
              "attachments WHERE card_id=?1 AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, added);
  bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  return ok;
}
static Response attachments(Request *r, int64_t card, bool upload) {
  int64_t board;
  if (!allowed_card(r, card, upload, &board))
    return error_response(404, "Scheda non trovata.");
  if (!upload)
    return query_json(
        "SELECT json_object('attachments',json((SELECT "
        "json_group_array(json(item)) FROM(SELECT "
        "json_object('id',id,'card_id',card_id,'name',name,'mime',mime,'size',"
        "size,'created_at',created_at,'deleted_at',deleted_at)item FROM "
        "attachments WHERE card_id=?1 ORDER BY id DESC))))",
        card);
  char *name = NULL, *mime = NULL, *data = NULL;
  int64_t size = 0;
  bool valid =
      json_string(r->body, "name", &name, 180) == 1 && filename_valid(name) &&
      json_string(r->body, "mime", &mime, 100) == 1 && mime_valid(mime) &&
      json_string(r->body, "data_base64", &data, 1398104) == 1 &&
      base64_size(data, &size);
  if (!valid) {
    ob_free(name);
    ob_free(mime);
    ob_free(data);
    return error_response(
        400, "Nome, MIME o base64 non valido; massimo 1 MiB per file.");
  }
  if (!attachment_quota(card, size)) {
    ob_free(name);
    ob_free(mime);
    ob_free(data);
    return error_response(
        409, "Limite della scheda: 10 file attivi e 5 MiB totali.");
  }
  sqlite3_stmt *s = prepare(
      "INSERT INTO attachments(card_id,author_id,name,mime,data_base64,size) "
      "VALUES(?1,?2,?3,?4,?5,?6)");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, name);
  bind_text(s, 4, mime);
  bind_text(s, 5, data);
  sqlite3_bind_int64(s, 6, size);
  ob_free(name);
  ob_free(mime);
  ob_free(data);
  if (!done(s))
    return unavailable();
  int64_t id = sqlite3_last_insert_rowid(db);
  return record_event(r, card, board, "attachment_added") ? success(201, id)
                                                          : unavailable();
}
static Response attachment(Request *r, int64_t id, bool get, bool restore) {
  sqlite3_stmt *s = prepare("SELECT card_id,size,deleted_at IS NOT NULL FROM "
                            "attachments WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  int rc = sqlite3_step(s);
  int64_t card = rc == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0,
          size = rc == SQLITE_ROW ? sqlite3_column_int64(s, 1) : 0;
  bool deleted = rc == SQLITE_ROW && sqlite3_column_int(s, 2);
  sqlite3_finalize(s);
  int64_t board;
  if (!card || !allowed_card(r, card, !get, &board) || (get && deleted))
    return error_response(404, "Allegato non trovato.");
  if (get) {
    Response response = query_json(
        "SELECT "
        "json_object('id',id,'name',name,'mime',mime,'data_base64',data_base64)"
        " FROM attachments WHERE id=?1 AND deleted_at IS NULL",
        id);
    snprintf(response.headers, sizeof response.headers,
             "Cache-Control: no-store\r\nContent-Disposition: attachment; "
             "filename=\"attachment.json\"\r\n");
    return response;
  }
  if (restore && !deleted)
    return success(200, id);
  if (!restore && deleted)
    return success(200, id);
  if (restore && !attachment_quota(card, size))
    return error_response(
        409, "Limite della scheda: 10 file attivi e 5 MiB totali.");
  s = prepare(
      restore ? "UPDATE attachments SET deleted_at=NULL WHERE id=?1"
              : "UPDATE attachments SET "
                "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (!done(s))
    return unavailable();
  return record_event(r, card, board,
                      restore ? "attachment_restored" : "attachment_deleted")
             ? success(200, id)
             : unavailable();
}
static Response edit_comment(Request *r, int64_t id) {
  char *body = NULL;
  if (json_string(r->body, "body", &body, 5000) != 1 || !body || !*body) {
    ob_free(body);
    return error_response(400,
                          "Il commento deve contenere da 1 a 5000 caratteri.");
  }
  bool content = false;
  for (const unsigned char *p = (const unsigned char *)body; *p; p++)
    if (!isspace(*p))
      content = true;
  if (!content) {
    ob_free(body);
    return error_response(400, "Il commento non può essere vuoto.");
  }
  sqlite3_stmt *s =
      prepare("SELECT card_id,author_id,version FROM comments WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  int rc = sqlite3_step(s);
  int64_t card = rc == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0,
          author = rc == SQLITE_ROW ? sqlite3_column_int64(s, 1) : 0,
          version = rc == SQLITE_ROW ? sqlite3_column_int64(s, 2) : 0;
  sqlite3_finalize(s);
  int64_t board;
  if (!card || !allowed_card(r, card, true, &board)) {
    ob_free(body);
    return error_response(404, "Commento non trovato.");
  }
  if (ob_config.auth_enabled && !auth_is_admin(r) && author != r->user_id) {
    ob_free(body);
    return error_response(403, "Puoi modificare solo i tuoi commenti.");
  }
  char plain[40], quoted[44];
  snprintf(plain, sizeof plain, "%lld", (long long)version);
  snprintf(quoted, sizeof quoted, "\"%s\"", plain);
  if (r->if_match[0] && strcmp(r->if_match, plain) &&
      strcmp(r->if_match, quoted)) {
    ob_free(body);
    return error_response(412, "Commento modificato da un'altra sessione. "
                               "Ricarica prima di riprovare.");
  }
  s = prepare("UPDATE comments SET "
              "body=?2,version=version+1,edited_at=strftime('%Y-%m-%dT%H:%M:%"
              "fZ','now') WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  bind_text(s, 2, body);
  ob_free(body);
  if (!done(s) || !record_event(r, card, board, "comment_edited"))
    return unavailable();
  return query_json(
      "SELECT json_object('ok',json('true'),'id',id,'version',version) FROM "
      "comments WHERE id=?1",
      id);
}
static Response profile(Request *r, bool patch) {
  if (patch) {
    char *name = NULL;
    if (json_string(r->body, "name", &name, 100) != 1 || !name || !*name) {
      ob_free(name);
      return error_response(400, "Nome richiesto, massimo 100 caratteri.");
    }
    bool content = false;
    for (const unsigned char *p = (const unsigned char *)name; *p; p++)
      if (!isspace(*p))
        content = true;
    if (!content) {
      ob_free(name);
      return error_response(400, "Il nome non può essere vuoto.");
    }
    sqlite3_stmt *s =
        prepare("UPDATE users SET name=?2 WHERE id=?1 AND active=1");
    sqlite3_bind_int64(s, 1, r->user_id);
    bind_text(s, 2, name);
    ob_free(name);
    if (!done(s))
      return unavailable();
  }
  return query_json(
      "SELECT json_object('id',id,'name',name,'username',username,'role',role) "
      "FROM users WHERE id=?1 AND active=1",
      r->user_id);
}
static bool current_hash(Request *r, char hash[65]) {
  const char *p = r->cookie;
  while (*p) {
    while (*p == ' ' || *p == ';' || *p == '\t')
      p++;
    const char *end = strchr(p, ';');
    if (!end)
      end = p + strlen(p);
    if (end - p == 75 && !strncmp(p, "ob_session=", 11)) {
      unsigned char digest[32];
      unsigned length = 0;
      if (!EVP_Digest(p + 11, 64, digest, &length, EVP_sha256(), NULL) ||
          length != 32)
        return false;
      for (size_t i = 0; i < 32; i++)
        snprintf(hash + i * 2, 3, "%02x", digest[i]);
      OPENSSL_cleanse(digest, sizeof digest);
      return true;
    }
    p = end;
  }
  return false;
}
static Response sessions(Request *r, const char *id, bool revoke_others) {
  char hash[65];
  if (!current_hash(r, hash))
    return error_response(401, "Sessione non disponibile.");
  if (!id && !revoke_others) {
    sqlite3_stmt *s =
        prepare("SELECT json_object('sessions',json((SELECT "
                "json_group_array(json(item)) FROM(SELECT "
                "json_object('id',public_id,'created_at',created_at,'last_seen'"
                ",last_seen,'expires_at',expires_at,'current',json(CASE WHEN "
                "token_hash=?2 THEN 'true' ELSE 'false' END))item FROM "
                "sessions WHERE user_id=?1 AND expires_at>?3 AND "
                "last_seen>?3-1800 ORDER BY created_at DESC,public_id))))");
    sqlite3_bind_int64(s, 1, r->user_id);
    bind_text(s, 2, hash);
    sqlite3_bind_int64(s, 3, time(NULL));
    Response response = row_json(s);
    OPENSSL_cleanse(hash, sizeof hash);
    snprintf(response.headers, sizeof response.headers,
             "Cache-Control: no-store\r\n");
    return response;
  }
  if (id) {
    if (strlen(id) != 32) {
      OPENSSL_cleanse(hash, sizeof hash);
      return error_response(404, "Sessione non trovata.");
    }
    for (size_t i = 0; i < 32; i++)
      if (!isxdigit((unsigned char)id[i])) {
        OPENSSL_cleanse(hash, sizeof hash);
        return error_response(404, "Sessione non trovata.");
      }
    sqlite3_stmt *s = prepare(
        "SELECT token_hash=?3 FROM sessions WHERE user_id=?1 AND public_id=?2");
    sqlite3_bind_int64(s, 1, r->user_id);
    bind_text(s, 2, id);
    bind_text(s, 3, hash);
    int rc = sqlite3_step(s);
    bool current = rc == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (rc != SQLITE_ROW || current) {
      OPENSSL_cleanse(hash, sizeof hash);
      return error_response(current ? 409 : 404,
                            current
                                ? "Per revocare la sessione corrente usa Esci."
                                : "Sessione non trovata.");
    }
  }
  sqlite3_stmt *s = prepare(
      revoke_others ? "DELETE FROM sessions WHERE user_id=?1 AND token_hash<>?2"
                    : "DELETE FROM sessions WHERE user_id=?1 AND public_id=?3 "
                      "AND token_hash<>?2");
  sqlite3_bind_int64(s, 1, r->user_id);
  bind_text(s, 2, hash);
  if (id)
    bind_text(s, 3, id);
  OPENSSL_cleanse(hash, sizeof hash);
  return done(s) ? success(200, 0) : unavailable();
}
static Response activity_page(Request *r, int64_t board) {
  if (!board_live(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  int64_t before, limit;
  if (!pagination(r, &before, &limit))
    return error_response(400,
                          "Cursore positivo e limite da 1 a 100 richiesti.");
  sqlite3_stmt *s = prepare(
      "WITH page AS(SELECT * FROM activity WHERE board_id=?1 AND id<?2 ORDER "
      "BY id DESC LIMIT ?3+1) SELECT json_object('items',json((SELECT "
      "json_group_array(json(item))FROM(SELECT "
      "json_object('id',id,'action',action,'entity_type',entity_type,'entity_"
      "id',entity_id,'title',title,'actor',actor,'actor_id',actor_id,'created_"
      "at',created_at)item FROM page ORDER BY id DESC LIMIT "
      "?3))),'next_cursor',CASE WHEN(SELECT count(*)FROM page)>?3 THEN(SELECT "
      "min(id)FROM(SELECT id FROM page ORDER BY id DESC LIMIT ?3))ELSE NULL "
      "END)");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  return row_json(s);
}
bool collaboration_handle(Request *r, Response *response) {
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  if (!strcmp(r->path, "/api/me/watches")) {
    if (!signed_in(r, response))
      return true;
    *response =
        get ? watches(r) : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/notifications") ||
      !strcmp(r->path, "/api/notifications/unread-count")) {
    if (!signed_in(r, response))
      return true;
    *response = get ? notifications(r, strstr(r->path, "unread-count") != NULL)
                    : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/notifications/read-all")) {
    if (!signed_in(r, response))
      return true;
    *response = post ? read_notification(r, 0, true)
                     : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/me/profile")) {
    if (!signed_in(r, response))
      return true;
    *response = (get || patch) ? profile(r, patch)
                               : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/me/sessions")) {
    if (!signed_in(r, response))
      return true;
    *response = get ? sessions(r, NULL, false)
                    : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/me/sessions/revoke-others")) {
    if (!signed_in(r, response))
      return true;
    *response = post ? sessions(r, NULL, true)
                     : error_response(405, "Metodo non consentito.");
    return true;
  }
  const char *prefix = "/api/me/sessions/";
  if (!strncmp(r->path, prefix, strlen(prefix))) {
    if (!signed_in(r, response))
      return true;
    *response = del ? sessions(r, r->path + strlen(prefix), false)
                    : error_response(405, "Metodo non consentito.");
    return true;
  }
  char path[1024];
  snprintf(path, sizeof path, "%s", r->path);
  char *parts[6] = {0}, *state = NULL;
  size_t count = 0;
  if (strstr(r->path, "//") || r->path[strlen(r->path) - 1] == '/')
    return false;
  for (char *part = strtok_r(path, "/", &state); part && count < 6;
       part = strtok_r(NULL, "/", &state))
    parts[count++] = part;
  if (count < 3 || strcmp(parts[0], "api"))
    return false;
  int64_t id = parse_id(parts[2]);
  if (!id)
    return false;
  bool card = !strcmp(parts[1], "cards"), board = !strcmp(parts[1], "boards");
  if (count == 4 && (card || board) && !strcmp(parts[3], "watch")) {
    if (!signed_in(r, response))
      return true;
    *response = (patch || post) ? watch(r, id, card)
                                : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (count == 4 && card && !strcmp(parts[3], "attachments")) {
    *response = (get || post) ? attachments(r, id, post)
                              : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(parts[1], "attachments") &&
      (count == 3 || (count == 4 && !strcmp(parts[3], "restore")))) {
    *response = (count == 3 && (get || del)) || (count == 4 && post)
                    ? attachment(r, id, get, count == 4)
                    : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (count == 3 && !strcmp(parts[1], "notifications")) {
    if (!signed_in(r, response))
      return true;
    *response = patch ? read_notification(r, id, false)
                      : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (count == 3 && !strcmp(parts[1], "comments") && patch) {
    *response = edit_comment(r, id);
    return true;
  }
  if (count == 4 && board && !strcmp(parts[3], "activity-page")) {
    *response = get ? activity_page(r, id)
                    : error_response(405, "Metodo non consentito.");
    return true;
  }
  return false;
}
