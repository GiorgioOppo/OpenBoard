/* Authenticated internal request forms. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "intake.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void intake_schema(sqlite3 *connection) {
  const char *schema[] = {
      "CREATE TABLE intake_forms(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id "
      "INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,name TEXT NOT "
      "NULL,description TEXT NOT NULL DEFAULT '',column_id INTEGER "
      "REFERENCES columns(id) ON DELETE SET NULL,published INTEGER NOT NULL "
      "DEFAULT 0 "
      "CHECK(published IN(0,1)),version INTEGER NOT NULL DEFAULT 1,created_at "
      "TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at "
      "TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),deleted_at "
      "TEXT);"
      "CREATE INDEX intake_forms_board ON intake_forms(board_id,id DESC);"
      "CREATE TABLE intake_fields(id INTEGER PRIMARY KEY AUTOINCREMENT,form_id "
      "INTEGER NOT NULL REFERENCES intake_forms(id) ON DELETE CASCADE,key TEXT "
      "NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL CHECK(type "
      "IN('text','number','date','boolean','select')),required INTEGER NOT "
      "NULL DEFAULT 0 CHECK(required IN(0,1)),options TEXT NOT NULL DEFAULT "
      "'[]' CHECK(json_valid(options)),position INTEGER NOT NULL DEFAULT "
      "0,version INTEGER NOT NULL DEFAULT 1,deleted_at "
      "TEXT,UNIQUE(form_id,key));"
      "CREATE INDEX intake_fields_form ON intake_fields(form_id,position,id);",
      "CREATE TABLE intake_requests(id INTEGER PRIMARY KEY "
      "AUTOINCREMENT,form_id INTEGER NOT NULL REFERENCES intake_forms(id) ON "
      "DELETE CASCADE,board_id INTEGER NOT NULL REFERENCES "
      "boards(id),author_id INTEGER NOT NULL REFERENCES users(id),title TEXT "
      "NOT NULL,answers TEXT NOT NULL DEFAULT '{}' "
      "CHECK(json_valid(answers)),schema_snapshot TEXT NOT NULL DEFAULT '[]' "
      "CHECK(json_valid(schema_snapshot)),form_version INTEGER NOT NULL,state "
      "TEXT NOT NULL DEFAULT 'new' CHECK(state "
      "IN('new','in_review','accepted','rejected')),converted_card_id INTEGER "
      "DEFAULT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT "
      "NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT "
      "NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),deleted_at TEXT);"
      "CREATE INDEX intake_requests_board ON intake_requests(board_id,id DESC);"
      "CREATE INDEX intake_requests_author ON intake_requests(author_id,id "
      "DESC);"
      "CREATE TABLE intake_notes(id INTEGER PRIMARY KEY "
      "AUTOINCREMENT,request_id INTEGER NOT NULL REFERENCES "
      "intake_requests(id) ON DELETE CASCADE,author_id INTEGER NOT NULL "
      "REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
      "CREATE INDEX intake_notes_request ON intake_notes(request_id,id);",
      "CREATE TABLE intake_events(id INTEGER PRIMARY KEY AUTOINCREMENT,form_id "
      "INTEGER NOT NULL REFERENCES intake_forms(id) ON DELETE "
      "CASCADE,request_id INTEGER REFERENCES intake_requests(id) ON DELETE "
      "CASCADE,actor_id INTEGER REFERENCES users(id),actor TEXT NOT "
      "NULL,action TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT "
      "NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
      "CREATE INDEX intake_events_request ON intake_events(request_id,id DESC);"
      "CREATE INDEX intake_events_form ON intake_events(form_id,id DESC);"
      "CREATE TRIGGER intake_target_removed AFTER UPDATE OF column_id ON "
      "intake_forms "
      "WHEN NEW.column_id IS NULL AND OLD.column_id IS NOT NULL BEGIN "
      "UPDATE intake_forms SET "
      "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE "
      "id=NEW.id;"
      "INSERT INTO intake_events(form_id,actor,action,note) SELECT "
      "NEW.id,'Sistema','target_column_removed','Colonna di destinazione "
      "rimossa definitivamente.' WHERE (SELECT count(*) FROM intake_events "
      "WHERE form_id=NEW.id)<10000;"
      "UPDATE boards SET "
      "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE "
      "id=NEW.board_id;END;"};
  for (size_t i = 0; i < sizeof schema / sizeof schema[0]; i++) {
    char *error = NULL;
    if (sqlite3_exec(connection, schema[i], NULL, NULL, &error) != SQLITE_OK) {
      fprintf(stderr, "Schema richieste non disponibile: %s\n",
              error ? error : sqlite3_errmsg(connection));
      sqlite3_free(error);
      exit(EXIT_FAILURE);
    }
  }
}
static bool done(sqlite3_stmt *s) {
  bool ok = sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static Response unavailable(void) {
  return error_response(503, "Salvataggio temporaneamente non disponibile.");
}
static Response row(sqlite3_stmt *s) {
  int rc = sqlite3_step(s);
  Response out =
      rc == SQLITE_ROW
          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
          : error_response(rc == SQLITE_DONE ? 404 : 503,
                           "Richiesta o modulo non disponibile.");
  sqlite3_finalize(s);
  return out;
}
static bool nonblank(const char *p) {
  if (!p)
    return false;
  for (; *p; p++)
    if (!isspace((unsigned char)*p))
      return true;
  return false;
}
static bool live_board(int64_t board) {
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, board);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool target_valid(int64_t column, int64_t board) {
  sqlite3_stmt *s = prepare("SELECT 1 FROM columns WHERE id=?1 AND board_id=?2 "
                            "AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, column);
  sqlite3_bind_int64(s, 2, board);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool manager(Request *r, int64_t board) {
  if (!auth_board_allowed(r, board, true))
    return false;
  if (auth_is_admin(r))
    return true;
  sqlite3_stmt *s = prepare("SELECT 1 FROM board_members WHERE board_id=?1 AND "
                            "user_id=?2 AND role='admin'");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, r->user_id);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool allowed_keys(const char *body, const char *keys) {
  if (!body || !valid_object(body))
    return false;
  sqlite3_stmt *s =
      prepare("SELECT key,count(*) FROM json_each(?1) GROUP BY key");
  bind_text(s, 1, body);
  bool ok = true;
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    const char *key = (const char *)sqlite3_column_text(s, 0);
    char token[100];
    if (!key || !*key || strchr(key, ',') ||
        strlen(key) != (size_t)sqlite3_column_bytes(s, 0) || strlen(key) > 90 ||
        sqlite3_column_int(s, 1) != 1) {
      ok = false;
      break;
    }
    snprintf(token, sizeof token, ",%s,", key);
    if (!strstr(keys, token)) {
      ok = false;
      break;
    }
  }
  sqlite3_finalize(s);
  return ok && rc == SQLITE_DONE;
}
static int raw_field(const char *body, const char *key, const char *type,
                     char **out, size_t max) {
  *out = NULL;
  sqlite3_stmt *s =
      prepare("SELECT type,value FROM json_each(?1) WHERE key=?2");
  bind_text(s, 1, body);
  bind_text(s, 2, key);
  int rc = sqlite3_step(s), result = 0;
  if (rc == SQLITE_ROW) {
    const char *kind = (const char *)sqlite3_column_text(s, 0),
               *value = (const char *)sqlite3_column_text(s, 1);
    size_t n = (size_t)sqlite3_column_bytes(s, 1);
    if (!kind || strcmp(kind, type) || !value || strlen(value) != n || n > max)
      result = -1;
    else {
      *out = strdup(value);
      result = *out ? 1 : -1;
    }
  } else if (rc != SQLITE_DONE)
    result = -1;
  sqlite3_finalize(s);
  return result;
}
static bool flag(Request *r, const char *key, bool *value) {
  char text[8];
  int n = ob_query(r, key, text, sizeof text);
  *value = false;
  if (n < 0)
    return false;
  if (!n)
    return true;
  if (strcmp(text, "0") && strcmp(text, "1"))
    return false;
  *value = !strcmp(text, "1");
  return true;
}
static bool page(Request *r, int64_t *before, int64_t *limit) {
  char text[40];
  *before = INT64_MAX;
  *limit = 30;
  int n = ob_query(r, "before", text, sizeof text);
  if (n < 0 || (n && !(*before = parse_id(text))))
    return false;
  n = ob_query(r, "limit", text, sizeof text);
  return n >= 0 && (!n || ((*limit = parse_id(text)) && *limit <= 100));
}
static int match(Request *r, int64_t version) {
  if (!*r->if_match)
    return 0;
  const char *p = r->if_match;
  char text[80];
  size_t n = strlen(p);
  if (*p == '"') {
    if (n < 3 || p[n - 1] != '"')
      return 400;
    memcpy(text, p + 1, n - 2);
    text[n - 2] = 0;
    p = text;
  }
  int64_t requested = parse_id(p);
  return !requested ? 400 : requested == version ? 0 : 412;
}
static Response conflict(int status) {
  return error_response(
      status, status == 412 ? "Versione non aggiornata. Ricarica i dati."
                            : "If-Match deve contenere una versione positiva.");
}
static bool quota(const char *sql, int64_t id, int64_t max) {
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, id);
  bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int64(s, 0) < max;
  sqlite3_finalize(s);
  return ok;
}
static bool event(Request *r, int64_t form, int64_t request, int64_t board,
                  const char *action, const char *note) {
  sqlite3_stmt *s =
      prepare("INSERT INTO "
              "intake_events(form_id,request_id,actor_id,actor,action,note) "
              "SELECT ?1,?2,?3,name,?4,?5 FROM users WHERE id=?3");
  sqlite3_bind_int64(s, 1, form);
  if (request)
    sqlite3_bind_int64(s, 2, request);
  sqlite3_bind_int64(s, 3, r->user_id);
  bind_text(s, 4, action);
  bind_text(s, 5, note);
  if (!done(s))
    return false;
  s = prepare("UPDATE boards SET "
              "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
              ") WHERE id=?1");
  sqlite3_bind_int64(s, 1, board);
  return done(s);
}
static bool bump_form(int64_t id) {
  sqlite3_stmt *s = prepare("UPDATE intake_forms SET "
                            "version=version+1,updated_at=strftime('%Y-%m-%dT%"
                            "H:%M:%fZ','now') WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  return done(s);
}
static bool bump_request(int64_t id) {
  sqlite3_stmt *s = prepare("UPDATE intake_requests SET "
                            "version=version+1,updated_at=strftime('%Y-%m-%dT%"
                            "H:%M:%fZ','now') WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  return done(s);
}
typedef struct {
  int64_t id, board, column, version, author, form;
  bool deleted, published;
  char state[16];
} Context;
static bool form_context(Request *r, int64_t id, bool deleted, Context *c,
                         Response *out) {
  sqlite3_stmt *s = prepare("SELECT board_id,column_id,version,deleted_at IS "
                            "NOT NULL,published FROM intake_forms WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  bool found = sqlite3_step(s) == SQLITE_ROW;
  if (found) {
    c->id = id;
    c->board = sqlite3_column_int64(s, 0);
    c->column = sqlite3_column_int64(s, 1);
    c->version = sqlite3_column_int64(s, 2);
    c->deleted = sqlite3_column_int(s, 3);
    c->published = sqlite3_column_int(s, 4);
  }
  sqlite3_finalize(s);
  if (!found || (!deleted && c->deleted) || !live_board(c->board) ||
      !auth_board_allowed(r, c->board, false)) {
    *out = error_response(404, "Modulo non trovato.");
    return false;
  }
  if (deleted && c->deleted && !manager(r, c->board)) {
    *out = error_response(404, "Modulo non trovato.");
    return false;
  }
  return true;
}
static bool request_context(Request *r, int64_t id, bool deleted, Context *c,
                            Response *out) {
  sqlite3_stmt *s = prepare(
      "SELECT q.form_id,q.board_id,q.author_id,q.version,q.deleted_at IS NOT "
      "NULL,q.state,f.column_id FROM intake_requests q JOIN intake_forms f ON "
      "f.id=q.form_id JOIN boards b ON b.id=q.board_id WHERE q.id=?1 AND "
      "f.deleted_at IS NULL AND b.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, id);
  bool found = sqlite3_step(s) == SQLITE_ROW;
  if (found) {
    c->id = id;
    c->form = sqlite3_column_int64(s, 0);
    c->board = sqlite3_column_int64(s, 1);
    c->author = sqlite3_column_int64(s, 2);
    c->version = sqlite3_column_int64(s, 3);
    c->deleted = sqlite3_column_int(s, 4);
    snprintf(c->state, sizeof c->state, "%s", sqlite3_column_text(s, 5));
    c->column = sqlite3_column_int64(s, 6);
  }
  sqlite3_finalize(s);
  if (!found || (!deleted && c->deleted) ||
      !auth_board_allowed(r, c->board, false) ||
      (c->deleted && c->author != r->user_id &&
       !auth_board_allowed(r, c->board, true))) {
    *out = error_response(404, "Richiesta non trovata.");
    return false;
  }
  return true;
}
#define FIELD_JSON                                                             \
  "json_object('id',x.id,'key',x.key,'name',x.name,'type',x.type,'required',"  \
  "json(CASE WHEN x.required THEN 'true' ELSE 'false' "                        \
  "END),'options',json(x.options),'position',x.position,'version',x.version,'" \
  "deleted_at',x.deleted_at)"
#define FIELDS_JSON                                                            \
  "(SELECT json_group_array(json(item)) FROM(SELECT " FIELD_JSON               \
  " item FROM intake_fields x WHERE x.form_id=f.id AND (?7 OR x.deleted_at "   \
  "IS NULL) ORDER BY x.position,x.id))"
#define FORM_JSON                                                              \
  "json_object('id',f.id,'board_id',f.board_id,'name',f.name,'description',f." \
  "description,'column_id',f.column_id,'published',json(CASE WHEN "            \
  "f.published THEN 'true' ELSE 'false' "                                      \
  "END),'version',f.version,'created_at',f.created_at,'updated_at',f.updated_" \
  "at,'deleted_at',f.deleted_at,'can_manage',json(CASE WHEN ?10 AND (?9 OR "   \
  "EXISTS(SELECT 1 FROM board_members m WHERE m.board_id=f.board_id AND "      \
  "m.user_id=?8 AND m.role='admin')) THEN 'true' ELSE 'false' "                \
  "END),'fields',json(" FIELDS_JSON "))"
#define NOTES_JSON                                                             \
  "(SELECT json_group_array(json(item)) FROM(SELECT "                          \
  "json_object('id',n.id,'author_id',n.author_id,'author',u.name,'body',n."    \
  "body,'created_at',n.created_at) item FROM intake_notes n JOIN users u ON "  \
  "u.id=n.author_id WHERE n.request_id=q.id ORDER BY n.id))"
#define REQUEST_PROPERTIES                                                     \
  "'id',q.id,'form_id',q.form_id,'form_name',f.name,'board_id',q."             \
  "board_id,'author_id',q.author_id,'author',u.name,'title',q.title,'answers'" \
  ",json(q.answers),'schema_snapshot',json(q.schema_snapshot),'state',q."      \
  "state,'converted_card_id',q.converted_card_id,'converted_card_available',"  \
  "json(CASE WHEN EXISTS(SELECT 1 FROM cards k JOIN columns c ON "             \
  "c.id=k.column_id "                                                          \
  "JOIN boards b ON b.id=c.board_id WHERE k.id=q.converted_card_id AND "       \
  "c.board_id=q.board_id "                                                     \
  "AND k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS "     \
  "NULL) THEN 'true' ELSE 'false' END),"                                       \
  "'version',q.version,'form_"                                                 \
  "version',q.form_version,'form_changed',json(CASE WHEN "                     \
  "f.version<>q.form_version THEN 'true' ELSE 'false' "                        \
  "END),'created_at',q.created_at,'updated_at',q.updated_at,'deleted_at',q."   \
  "deleted_at,'can_triage',json(CASE WHEN ?10 AND (?9 OR EXISTS(SELECT 1 "     \
  "FROM board_members m WHERE m.board_id=q.board_id AND m.user_id=?8 AND "     \
  "m.role<>'observer')) THEN 'true' ELSE 'false' "                             \
  "END),'can_edit',json(CASE WHEN q.author_id=?8 AND q.state "                 \
  "IN('new','in_review') AND q.converted_card_id IS NULL AND q.deleted_at IS " \
  "NULL THEN 'true' ELSE 'false' END),'notes_count',(SELECT count(*) FROM "    \
  "intake_notes n WHERE n.request_id=q.id)"
#define REQUEST_JSON                                                           \
  "json_object(" REQUEST_PROPERTIES ",'notes',json(" NOTES_JSON "))"
#define REQUEST_LIST_JSON "json_object(" REQUEST_PROPERTIES ")"
static void actor_bind(sqlite3_stmt *s, Request *r, int64_t board,
                       bool include) {
  sqlite3_bind_int(s, 7, include);
  sqlite3_bind_int64(s, 8, r->user_id);
  sqlite3_bind_int(s, 9, auth_is_admin(r));
  (void)board;
  sqlite3_bind_int(s, 10, strcmp(r->role, "observer") != 0);
}
static Response form_detail(Request *r, int64_t id, int64_t board, bool include,
                            int status) {
  sqlite3_stmt *s =
      prepare("SELECT " FORM_JSON " FROM intake_forms f WHERE f.id=?1");
  sqlite3_bind_int64(s, 1, id);
  actor_bind(s, r, board, include);
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static Response request_detail(Request *r, int64_t id, int64_t board,
                               int status) {
  sqlite3_stmt *s =
      prepare("SELECT " REQUEST_JSON
              " FROM intake_requests q JOIN intake_forms f ON f.id=q.form_id "
              "JOIN users u ON u.id=q.author_id WHERE q.id=?1");
  sqlite3_bind_int64(s, 1, id);
  actor_bind(s, r, board, false);
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static bool mutation_allowed(Request *r, Context *c, bool form, Response *out) {
  if (form && !manager(r, c->board)) {
    *out = error_response(
        403, "Solo gli amministratori della bacheca gestiscono i moduli.");
    return false;
  }
  int status = match(r, c->version);
  if (status) {
    *out = conflict(status);
    return false;
  }
  if (!quota(form ? "SELECT count(*) FROM intake_events WHERE form_id=?1"
                  : "SELECT count(*) FROM intake_events WHERE request_id=?1",
             c->id, 10000)) {
    *out = error_response(409, "Limite dello storico raggiunto.");
    return false;
  }
  return true;
}
static Response create_form(Request *r, int64_t board) {
  if (!live_board(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  if (!manager(r, board))
    return error_response(
        403, "Solo gli amministratori della bacheca gestiscono i moduli.");
  char *name = NULL, *description = NULL;
  int64_t column = 0;
  int a = json_string(r->body, "name", &name, 200),
      b = json_string(r->body, "description", &description, 4000),
      c = json_integer(r->body, "column_id", &column, 1, INT64_MAX, false);
  Response out;
  if (!allowed_keys(r->body, ",name,,description,,column_id,") || a != 1 ||
      !nonblank(name) || b < 0 || c != 1 || !target_valid(column, board))
    out = error_response(400,
                         "Nome, descrizione o colonna del modulo non validi.");
  else if (!quota("SELECT count(*) FROM intake_forms WHERE board_id=?1", board,
                  100))
    out = error_response(409, "Limite di 100 moduli per bacheca raggiunto.");
  else {
    sqlite3_stmt *s =
        prepare("INSERT INTO intake_forms(board_id,name,description,column_id) "
                "VALUES(?1,?2,?3,?4)");
    sqlite3_bind_int64(s, 1, board);
    bind_text(s, 2, name);
    bind_text(s, 3, description ? description : "");
    sqlite3_bind_int64(s, 4, column);
    bool ok = done(s);
    int64_t id = sqlite3_last_insert_rowid(db);
    out = ok && event(r, id, 0, board, "form_created", "")
              ? form_detail(r, id, board, false, 201)
              : unavailable();
  }
  ob_free(name);
  ob_free(description);
  return out;
}
static Response mutate_form(Request *r, int64_t id, const char *op) {
  Context c;
  Response out;
  bool restore = !strcmp(op, "restore"), get = !strcmp(op, "get"),
       include = false;
  if (get && !flag(r, "include_deleted", &include))
    return error_response(400, "Filtro non valido.");
  if (!form_context(r, id, restore || include, &c, &out))
    return out;
  if (get) {
    if (include && !manager(r, c.board))
      return error_response(403, "Il cestino è riservato agli amministratori.");
    return form_detail(r, id, c.board, include, 200);
  }
  if (!mutation_allowed(r, &c, true, &out))
    return out;
  if (!strcmp(op, "edit")) {
    char *name = NULL, *description = NULL;
    int64_t column = 0;
    int a = json_string(r->body, "name", &name, 200),
        b = json_string(r->body, "description", &description, 4000),
        d = json_integer(r->body, "column_id", &column, 1, INT64_MAX, false);
    if (!allowed_keys(r->body, ",name,,description,,column_id,") || a < 0 ||
        (a && !nonblank(name)) || b < 0 || d < 0 || !(a || b || d) ||
        (d && !target_valid(column, c.board)))
      out = error_response(400, "Dettagli del modulo non validi.");
    else {
      sqlite3_stmt *s =
          prepare("UPDATE intake_forms SET "
                  "name=coalesce(?2,name),description=coalesce(?3,description),"
                  "column_id=coalesce(?4,column_id) WHERE id=?1");
      sqlite3_bind_int64(s, 1, id);
      if (a)
        bind_text(s, 2, name);
      if (b)
        bind_text(s, 3, description);
      if (d)
        sqlite3_bind_int64(s, 4, column);
      out = done(s) && bump_form(id) &&
                    event(r, id, 0, c.board, "form_edited", "")
                ? form_detail(r, id, c.board, false, 200)
                : unavailable();
    }
    ob_free(name);
    ob_free(description);
    return out;
  }
  if (!allowed_keys(r->body && *r->body ? r->body : "{}", ","))
    return error_response(400, "Payload non valido.");
  const char *sql = NULL, *action = NULL;
  if (!strcmp(op, "publish") || !strcmp(op, "pause")) {
    bool publish = !strcmp(op, "publish");
    if (c.published == publish)
      return error_response(409, "Il modulo è già nello stato richiesto.");
    if (publish && !target_valid(c.column, c.board))
      return error_response(409,
                            "Seleziona una colonna di destinazione attiva.");
    sql = publish ? "UPDATE intake_forms SET published=1 WHERE id=?1"
                  : "UPDATE intake_forms SET published=0 WHERE id=?1";
    action = publish ? "form_published" : "form_paused";
  } else if (!strcmp(op, "delete")) {
    sql = "UPDATE intake_forms SET "
          "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1";
    action = "form_deleted";
  } else if (restore) {
    if (!c.deleted)
      return error_response(409, "Modulo già attivo.");
    sql = "UPDATE intake_forms SET deleted_at=NULL WHERE id=?1";
    action = "form_restored";
  } else
    return error_response(405, "Metodo non consentito.");
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, id);
  return done(s) && bump_form(id) && event(r, id, 0, c.board, action, "")
             ? form_detail(r, id, c.board, restore || !strcmp(op, "delete"),
                           200)
             : unavailable();
}
static bool field_type(const char *type) {
  return type && (!strcmp(type, "text") || !strcmp(type, "number") ||
                  !strcmp(type, "date") || !strcmp(type, "boolean") ||
                  !strcmp(type, "select"));
}
static bool field_key(const char *key) {
  if (!key || !*key || strlen(key) > 40 || key[0] < 'a' || key[0] > 'z' ||
      !strcmp(key, "constructor") || !strcmp(key, "prototype") ||
      !strcmp(key, "__proto__"))
    return false;
  for (; *key; key++)
    if (!(*key >= 'a' && *key <= 'z') && !isdigit((unsigned char)*key) &&
        *key != '_')
      return false;
  return true;
}
static bool valid_options(const char *options, const char *type) {
  sqlite3_stmt *s = prepare(
      "SELECT type,value,count(*) FROM json_each(?1) GROUP BY value,type");
  bind_text(s, 1, options);
  int rc, count = 0;
  bool ok = true;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    const char *v = (const char *)sqlite3_column_text(s, 1);
    if (strcmp((const char *)sqlite3_column_text(s, 0), "text") || !v ||
        strlen(v) != (size_t)sqlite3_column_bytes(s, 1) || strlen(v) > 400 ||
        !valid_utf8(v, strlen(v)) || !nonblank(v) ||
        sqlite3_column_int(s, 2) != 1 || ++count > 30) {
      ok = false;
      break;
    }
  }
  sqlite3_finalize(s);
  return ok && rc == SQLITE_DONE &&
         (!strcmp(type, "select") ? count > 0 : count == 0);
}
static Response field_detail(int64_t id, int status) {
  sqlite3_stmt *s =
      prepare("SELECT " FIELD_JSON " FROM intake_fields x WHERE x.id=?1");
  sqlite3_bind_int64(s, 1, id);
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static Response create_field(Request *r, int64_t form) {
  Context c;
  Response out;
  if (!form_context(r, form, false, &c, &out) ||
      !mutation_allowed(r, &c, true, &out))
    return out;
  char *key = NULL, *name = NULL, *type = NULL, *options = NULL;
  int64_t required = 0;
  int a = json_string(r->body, "key", &key, 40),
      b = json_string(r->body, "name", &name, 200),
      d = json_string(r->body, "type", &type, 10),
      e = json_integer(r->body, "required", &required, 0, 1, true),
      f = raw_field(r->body, "options", "array", &options, 14000);
  if (!allowed_keys(r->body, ",key,,name,,type,,required,,options,") ||
      a != 1 || !field_key(key) || b != 1 || !nonblank(name) || d != 1 ||
      !field_type(type) || e < 0 || f < 0 ||
      !valid_options(options ? options : "[]", type))
    out = error_response(400,
                         "Campo, tipo, obbligatorietà o opzioni non validi.");
  else if (!quota("SELECT count(*) FROM intake_fields WHERE form_id=?1 AND "
                  "deleted_at IS NULL",
                  form, 20))
    out = error_response(409, "Limite di 20 campi attivi raggiunto.");
  else {
    sqlite3_stmt *s =
        prepare("SELECT 1 FROM intake_fields WHERE form_id=?1 AND key=?2");
    sqlite3_bind_int64(s, 1, form);
    bind_text(s, 2, key);
    bool duplicate = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    if (duplicate)
      out =
          error_response(409, "Chiave campo già presente, anche nel cestino.");
    else {
      s = prepare(
          "INSERT INTO "
          "intake_fields(form_id,key,name,type,required,options,position) "
          "SELECT ?1,?2,?3,?4,?5,?6,coalesce(max(position)+1,0) FROM "
          "intake_fields WHERE form_id=?1");
      sqlite3_bind_int64(s, 1, form);
      bind_text(s, 2, key);
      bind_text(s, 3, name);
      bind_text(s, 4, type);
      sqlite3_bind_int64(s, 5, required);
      bind_text(s, 6, options ? options : "[]");
      bool ok = done(s);
      int64_t id = sqlite3_last_insert_rowid(db);
      out = ok && bump_form(form) &&
                    event(r, form, 0, c.board, "field_created", key)
                ? field_detail(id, 201)
                : unavailable();
    }
  }
  ob_free(key);
  ob_free(name);
  ob_free(type);
  ob_free(options);
  return out;
}
static Response mutate_field(Request *r, int64_t id, const char *op) {
  sqlite3_stmt *s = prepare("SELECT form_id,version,deleted_at IS NOT "
                            "NULL,type,options FROM intake_fields WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    return error_response(404, "Campo non trovato.");
  }
  int64_t form = sqlite3_column_int64(s, 0),
          version = sqlite3_column_int64(s, 1);
  bool deleted = sqlite3_column_int(s, 2);
  char *old_type = strdup((const char *)sqlite3_column_text(s, 3)),
       *old_options = strdup((const char *)sqlite3_column_text(s, 4));
  sqlite3_finalize(s);
  Response out;
  Context c;
  bool restore = !strcmp(op, "restore");
  if ((deleted && !restore) || !form_context(r, form, false, &c, &out)) {
    if (deleted && !restore)
      out = error_response(404, "Campo non trovato.");
    goto cleanup;
  }
  if (!manager(r, c.board)) {
    out = error_response(403, "Solo gli amministratori gestiscono i campi.");
    goto cleanup;
  }
  int status = match(r, version);
  if (status) {
    out = conflict(status);
    goto cleanup;
  }
  if (!quota("SELECT count(*) FROM intake_events WHERE form_id=?1", form,
             10000)) {
    out = error_response(409, "Limite dello storico raggiunto.");
    goto cleanup;
  }
  const char *action;
  if (!strcmp(op, "edit")) {
    char *name = NULL, *type = NULL, *options = NULL;
    int64_t required = 0;
    int a = json_string(r->body, "name", &name, 200),
        b = json_string(r->body, "type", &type, 10),
        d = json_integer(r->body, "required", &required, 0, 1, true),
        e = raw_field(r->body, "options", "array", &options, 14000);
    if (!allowed_keys(r->body, ",name,,type,,required,,options,") || a < 0 ||
        (a && !nonblank(name)) || b < 0 || (b && !field_type(type)) || d < 0 ||
        e < 0 || !(a || b || d || e) ||
        !valid_options(options ? options : old_options,
                       type ? type : old_type)) {
      out = error_response(400, "Dettagli del campo non validi.");
      ob_free(name);
      ob_free(type);
      ob_free(options);
      goto cleanup;
    }
    s = prepare(
        "UPDATE intake_fields SET "
        "name=coalesce(?2,name),type=coalesce(?3,type),required=coalesce(?4,"
        "required),options=coalesce(?5,options),version=version+1 WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (a)
      bind_text(s, 2, name);
    if (b)
      bind_text(s, 3, type);
    if (d)
      sqlite3_bind_int64(s, 4, required);
    if (e)
      bind_text(s, 5, options);
    bool ok = done(s);
    ob_free(name);
    ob_free(type);
    ob_free(options);
    if (!ok) {
      out = unavailable();
      goto cleanup;
    }
    action = "field_edited";
  } else {
    if (!allowed_keys(r->body && *r->body ? r->body : "{}", ",")) {
      out = error_response(400, "Payload non valido.");
      goto cleanup;
    }
    if (restore) {
      if (!deleted) {
        out = error_response(409, "Campo già attivo.");
        goto cleanup;
      }
      if (!quota("SELECT count(*) FROM intake_fields WHERE form_id=?1 AND "
                 "deleted_at IS NULL",
                 form, 20)) {
        out = error_response(409, "Limite di 20 campi attivi raggiunto.");
        goto cleanup;
      }
      s = prepare("UPDATE intake_fields SET deleted_at=NULL,version=version+1 "
                  "WHERE id=?1");
      action = "field_restored";
    } else {
      s = prepare("UPDATE intake_fields SET "
                  "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version="
                  "version+1 WHERE id=?1");
      action = "field_deleted";
    }
    sqlite3_bind_int64(s, 1, id);
    if (!done(s)) {
      out = unavailable();
      goto cleanup;
    }
  }
  out = bump_form(form) && event(r, form, 0, c.board, action, "")
            ? field_detail(id, 200)
            : unavailable();
cleanup:
  ob_free(old_type);
  ob_free(old_options);
  return out;
}
static Response reorder_fields(Request *r, int64_t form) {
  Context c;
  Response out;
  if (!form_context(r, form, false, &c, &out) ||
      !mutation_allowed(r, &c, true, &out))
    return out;
  char *array = NULL;
  int a = raw_field(r->body, "field_ids", "array", &array, 2000);
  if (!allowed_keys(r->body, ",field_ids,") || a != 1) {
    ob_free(array);
    return error_response(400, "Ordine campi non valido.");
  }
  int64_t ids[20];
  int count = 0, rc;
  bool valid = true;
  sqlite3_stmt *s = prepare("SELECT value,type FROM json_each(?1)");
  bind_text(s, 1, array);
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    int64_t id = sqlite3_column_int64(s, 0);
    if (count >= 20 ||
        strcmp((const char *)sqlite3_column_text(s, 1), "integer") || id <= 0) {
      valid = false;
      break;
    }
    for (int i = 0; i < count; i++)
      if (ids[i] == id)
        valid = false;
    if (!valid)
      break;
    ids[count++] = id;
  }
  sqlite3_finalize(s);
  ob_free(array);
  if (rc != SQLITE_DONE)
    valid = false;
  s = prepare("SELECT count(*) FROM intake_fields WHERE form_id=?1 AND "
              "deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, form);
  valid = valid && sqlite3_step(s) == SQLITE_ROW &&
          sqlite3_column_int(s, 0) == count;
  sqlite3_finalize(s);
  for (int i = 0; valid && i < count; i++) {
    s = prepare("SELECT 1 FROM intake_fields WHERE id=?1 AND form_id=?2 AND "
                "deleted_at IS NULL");
    sqlite3_bind_int64(s, 1, ids[i]);
    sqlite3_bind_int64(s, 2, form);
    valid = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
  }
  if (!valid)
    return error_response(400, "Invia ogni campo attivo una sola volta.");
  for (int i = 0; i < count; i++) {
    s = prepare(
        "UPDATE intake_fields SET position=?2,version=version+1 WHERE id=?1");
    sqlite3_bind_int64(s, 1, ids[i]);
    sqlite3_bind_int(s, 2, i);
    if (!done(s))
      return unavailable();
  }
  return bump_form(form) && event(r, form, 0, c.board, "fields_reordered", "")
             ? form_detail(r, form, c.board, false, 200)
             : unavailable();
}
static bool date_valid(const char *date) {
  if (!date || strlen(date) != 10 || date[4] != '-' || date[7] != '-')
    return false;
  for (int i = 0; i < 10; i++)
    if (i != 4 && i != 7 && !isdigit((unsigned char)date[i]))
      return false;
  int year = (date[0] - '0') * 1000 + (date[1] - '0') * 100 +
             (date[2] - '0') * 10 + date[3] - '0',
      month = (date[5] - '0') * 10 + date[6] - '0',
      day = (date[8] - '0') * 10 + date[9] - '0';
  static const int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
         day <= days[month] + (month == 2 && year % 4 == 0 &&
                               (year % 100 != 0 || year % 400 == 0));
}
static char *snapshot(int64_t form) {
  sqlite3_stmt *s =
      prepare("SELECT " FIELDS_JSON " FROM intake_forms f WHERE f.id=?1");
  sqlite3_bind_int64(s, 1, form);
  sqlite3_bind_int(s, 7, 0);
  char *out = sqlite3_step(s) == SQLITE_ROW
                  ? strdup((const char *)sqlite3_column_text(s, 0))
                  : NULL;
  sqlite3_finalize(s);
  return out;
}
/* Match literal object keys through json_each; never turn user keys into paths.
 */
static bool valid_answers(const char *answers, const char *schema) {
  if (!valid_object(answers) || strlen(answers) > 50000)
    return false;
  sqlite3_stmt *s = prepare("SELECT a.key,a.type,a.value,count(*) FROM "
                            "json_each(?1) a GROUP BY a.key");
  bind_text(s, 1, answers);
  bool valid = true;
  int count = 0, rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    const char *key = (const char *)sqlite3_column_text(s, 0),
               *type = (const char *)sqlite3_column_text(s, 1),
               *value = (const char *)sqlite3_column_text(s, 2);
    if (++count > 20 || sqlite3_column_int(s, 3) != 1 || !key ||
        strlen(key) != (size_t)sqlite3_column_bytes(s, 0)) {
      valid = false;
      break;
    }
    sqlite3_stmt *f =
        prepare("SELECT "
                "json_extract(value,'$.type'),json_extract(value,'$.required'),"
                "json_extract(value,'$.options') FROM json_each(?1) WHERE "
                "json_extract(value,'$.key')=?2");
    bind_text(f, 1, schema);
    bind_text(f, 2, key);
    if (sqlite3_step(f) != SQLITE_ROW) {
      sqlite3_finalize(f);
      valid = false;
      break;
    }
    const char *expected = (const char *)sqlite3_column_text(f, 0);
    bool required = sqlite3_column_int(f, 1);
    if (!strcmp(expected, "number"))
      valid = (!strcmp(type, "integer") || !strcmp(type, "real")) &&
              isfinite(sqlite3_column_double(s, 2));
    else if (!strcmp(expected, "boolean"))
      valid = !strcmp(type, "true") || !strcmp(type, "false");
    else {
      valid = !strcmp(type, "text") && value &&
              strlen(value) == (size_t)sqlite3_column_bytes(s, 2) &&
              strlen(value) <= 8000 && valid_utf8(value, strlen(value)) &&
              (!required || nonblank(value));
      if (valid && !strcmp(expected, "date"))
        valid = !*value && !required ? true : date_valid(value);
      if (valid && !strcmp(expected, "select")) {
        sqlite3_stmt *o = prepare(
            "SELECT 1 FROM json_each(?1) WHERE type='text' AND value=?2");
        bind_text(o, 1, (const char *)sqlite3_column_text(f, 2));
        bind_text(o, 2, value);
        valid = sqlite3_step(o) == SQLITE_ROW;
        sqlite3_finalize(o);
      }
    }
    sqlite3_finalize(f);
    if (!valid)
      break;
  }
  sqlite3_finalize(s);
  if (!valid || rc != SQLITE_DONE)
    return false;
  s = prepare(
      "SELECT 1 FROM json_each(?1) f WHERE "
      "json_extract(f.value,'$.required')=1 AND NOT EXISTS(SELECT 1 FROM "
      "json_each(?2) a WHERE a.key=json_extract(f.value,'$.key')) LIMIT 1");
  bind_text(s, 1, schema);
  bind_text(s, 2, answers);
  bool missing = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return !missing;
}
static Response submit(Request *r, int64_t form) {
  Context c;
  Response out;
  if (!form_context(r, form, false, &c, &out))
    return out;
  int status = match(r, c.version);
  if (status)
    return conflict(status);
  if (!c.published)
    return error_response(409, "Il modulo non accetta nuove richieste.");
  char *title = NULL, *answers = NULL, *schema = snapshot(form);
  int a = json_string(r->body, "title", &title, 300),
      b = raw_field(r->body, "answers", "object", &answers, 50000);
  if (!schema)
    out = unavailable();
  else if (!allowed_keys(r->body, ",title,,answers,") || a != 1 ||
           !nonblank(title) || b != 1 || !valid_answers(answers, schema))
    out = error_response(
        400, "Titolo o risposte non validi per i campi del modulo.");
  else if (!quota("SELECT count(*) FROM intake_requests WHERE board_id=?1",
                  c.board, 10000))
    out =
        error_response(409, "Limite di 10000 richieste per bacheca raggiunto.");
  else {
    sqlite3_stmt *s =
        prepare("INSERT INTO "
                "intake_requests(form_id,board_id,author_id,title,answers,"
                "schema_snapshot,form_version) VALUES(?1,?2,?3,?4,?5,?6,?7)");
    sqlite3_bind_int64(s, 1, form);
    sqlite3_bind_int64(s, 2, c.board);
    sqlite3_bind_int64(s, 3, r->user_id);
    bind_text(s, 4, title);
    bind_text(s, 5, answers);
    bind_text(s, 6, schema);
    sqlite3_bind_int64(s, 7, c.version);
    bool ok = done(s);
    int64_t id = sqlite3_last_insert_rowid(db);
    out = ok && event(r, form, id, c.board, "request_submitted", "")
              ? request_detail(r, id, c.board, 201)
              : unavailable();
  }
  ob_free(title);
  ob_free(answers);
  ob_free(schema);
  return out;
}
static Response convert_request(Request *r, Context *c) {
  if (!auth_board_allowed(r, c->board, true))
    return error_response(
        403, "Solo i membri scriventi possono convertire le richieste.");
  if (strcmp(c->state, "accepted"))
    return error_response(409, "Accetta la richiesta prima della conversione.");
  if (!target_valid(c->column, c->board))
    return error_response(409, "La colonna di destinazione non è attiva.");
  sqlite3_stmt *s =
      prepare("SELECT title,answers,schema_snapshot,converted_card_id FROM "
              "intake_requests WHERE id=?1");
  sqlite3_bind_int64(s, 1, c->id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    return unavailable();
  }
  if (sqlite3_column_type(s, 3) != SQLITE_NULL) {
    sqlite3_finalize(s);
    return error_response(409, "Richiesta già convertita.");
  }
  char *title = strdup((const char *)sqlite3_column_text(s, 0)),
       *answers = strdup((const char *)sqlite3_column_text(s, 1)),
       *schema = strdup((const char *)sqlite3_column_text(s, 2));
  sqlite3_finalize(s);
  if (!title || !answers || !schema) {
    ob_free(title);
    ob_free(answers);
    ob_free(schema);
    return unavailable();
  }
  sqlite3_str *text = sqlite3_str_new(db);
  sqlite3_str_appendf(text, "Richiesta interna #%lld\n\n", (long long)c->id);
  s = prepare(
      "SELECT json_extract(f.value,'$.name'),CASE a.type WHEN 'true' THEN "
      "'true' WHEN 'false' THEN 'false' ELSE a.value END FROM json_each(?1) f "
      "JOIN json_each(?2) a ON a.key=json_extract(f.value,'$.key') ORDER BY "
      "CAST(f.key AS INTEGER)");
  bind_text(s, 1, schema);
  bind_text(s, 2, answers);
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW)
    sqlite3_str_appendf(text, "%s: %s\n", sqlite3_column_text(s, 0),
                        sqlite3_column_text(s, 1));
  sqlite3_finalize(s);
  char *description = sqlite3_str_finish(text);
  char *override = NULL;
  int provided = json_string(r->body, "description", &override, 10000);
  if (provided < 0) {
    ob_free(title);
    ob_free(answers);
    ob_free(schema);
    sqlite3_free(description);
    return error_response(400, "Descrizione della conversione non valida.");
  }
  if (provided) {
    sqlite3_free(description);
    description = sqlite3_mprintf("%s", override);
    ob_free(override);
  }
  ob_free(answers);
  ob_free(schema);
  if (rc != SQLITE_DONE || !description) {
    ob_free(title);
    sqlite3_free(description);
    return unavailable();
  }
  if (!provided && strlen(description) > 10000) {
    ob_free(title);
    sqlite3_free(description);
    return error_response(
        413,
        "La descrizione supera il limite di 10000 byte della conversione.");
  }
  s = prepare("SELECT json_object('title',?1,'description',?2)");
  bind_text(s, 1, title);
  bind_text(s, 2, description);
  char *payload = sqlite3_step(s) == SQLITE_ROW
                      ? strdup((const char *)sqlite3_column_text(s, 0))
                      : NULL;
  sqlite3_finalize(s);
  ob_free(title);
  sqlite3_free(description);
  if (!payload)
    return unavailable();
  Response created = ob_create_card(r, c->column, payload);
  ob_free(payload);
  if (created.status >= 400)
    return created;
  int64_t card = 0;
  bool parsed =
      json_integer(created.body, "id", &card, 1, INT64_MAX, false) == 1;
  ob_free(created.body);
  if (!parsed)
    return unavailable();
  s = prepare("UPDATE intake_requests SET converted_card_id=?2 WHERE id=?1 AND "
              "converted_card_id IS NULL");
  sqlite3_bind_int64(s, 1, c->id);
  sqlite3_bind_int64(s, 2, card);
  if (!done(s) || sqlite3_changes(db) != 1 || !bump_request(c->id) ||
      !event(r, c->form, c->id, c->board, "request_converted", ""))
    return unavailable();
  return request_detail(r, c->id, c->board, 200);
}
static Response mutate_request(Request *r, int64_t id, const char *op) {
  Context c;
  Response out;
  bool restore = !strcmp(op, "restore"), get = !strcmp(op, "get"),
       include = false;
  if (get && !flag(r, "include_deleted", &include))
    return error_response(400, "Filtro non valido.");
  if (!request_context(r, id, restore || include, &c, &out))
    return out;
  if (get)
    return request_detail(r, id, c.board, 200);
  if (!mutation_allowed(r, &c, false, &out))
    return out;
  bool writer = auth_board_allowed(r, c.board, true),
       owner = c.author == r->user_id;
  if (!strcmp(op, "edit")) {
    if (!owner)
      return error_response(403, "Solo l'autore può modificare le risposte.");
    sqlite3_stmt *s = prepare("SELECT schema_snapshot,converted_card_id IS NOT "
                              "NULL FROM intake_requests WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (sqlite3_step(s) != SQLITE_ROW) {
      sqlite3_finalize(s);
      return unavailable();
    }
    char *schema = strdup((const char *)sqlite3_column_text(s, 0));
    bool converted = sqlite3_column_int(s, 1);
    sqlite3_finalize(s);
    if ((strcmp(c.state, "new") && strcmp(c.state, "in_review")) || converted) {
      ob_free(schema);
      return error_response(
          409, "Solo richieste nuove o in esame possono essere modificate.");
    }
    char *title = NULL, *answers = NULL;
    int a = json_string(r->body, "title", &title, 300),
        b = raw_field(r->body, "answers", "object", &answers, 50000);
    if (!schema)
      out = unavailable();
    else if (!allowed_keys(r->body, ",title,,answers,") || a < 0 ||
             (a && !nonblank(title)) || b < 0 || !(a || b) ||
             (b && !valid_answers(answers, schema)))
      out = error_response(
          400,
          "Risposte non valide per la struttura originale della richiesta.");
    else {
      s = prepare(
          "UPDATE intake_requests SET "
          "title=coalesce(?2,title),answers=coalesce(?3,answers) WHERE id=?1");
      sqlite3_bind_int64(s, 1, id);
      if (a)
        bind_text(s, 2, title);
      if (b)
        bind_text(s, 3, answers);
      out = done(s) && bump_request(id) &&
                    event(r, c.form, id, c.board, "request_edited", "")
                ? request_detail(r, id, c.board, 200)
                : unavailable();
    }
    ob_free(title);
    ob_free(answers);
    ob_free(schema);
    return out;
  }
  if (!strcmp(op, "note")) {
    if (!owner && !writer)
      return error_response(
          403,
          "Solo l'autore e i membri scriventi possono discutere la richiesta.");
    char *body = NULL;
    int a = json_string(r->body, "body", &body, 2000);
    if (!allowed_keys(r->body, ",body,") || a != 1 || !nonblank(body))
      out = error_response(400, "Testo della nota non valido.");
    else if (!quota("SELECT count(*) FROM intake_notes WHERE request_id=?1", id,
                    1000))
      out = error_response(409, "Limite di 1000 note raggiunto.");
    else {
      sqlite3_stmt *s =
          prepare("INSERT INTO intake_notes(request_id,author_id,body) "
                  "VALUES(?1,?2,?3)");
      sqlite3_bind_int64(s, 1, id);
      sqlite3_bind_int64(s, 2, r->user_id);
      bind_text(s, 3, body);
      out = done(s) && bump_request(id) &&
                    event(r, c.form, id, c.board, "request_note_added", "")
                ? request_detail(r, id, c.board, 201)
                : unavailable();
    }
    ob_free(body);
    return out;
  }
  if (!strcmp(op, "state")) {
    if (!writer)
      return error_response(403,
                            "Solo i membri scriventi gestiscono lo stato.");
    char *state = NULL;
    int a = json_string(r->body, "state", &state, 16);
    if (!allowed_keys(r->body, ",state,") || a != 1 || (!state) ||
        (strcmp(state, "new") && strcmp(state, "in_review") &&
         strcmp(state, "accepted") && strcmp(state, "rejected")))
      out = error_response(400, "Stato richiesta non valido.");
    else {
      sqlite3_stmt *s = prepare("SELECT converted_card_id IS NOT NULL FROM "
                                "intake_requests WHERE id=?1");
      sqlite3_bind_int64(s, 1, id);
      bool converted =
          sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
      sqlite3_finalize(s);
      if (converted || !strcmp(state, c.state))
        out = error_response(
            409, "Richiesta già convertita o nello stato richiesto.");
      else {
        s = prepare("UPDATE intake_requests SET state=?2 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        bind_text(s, 2, state);
        out = done(s) && bump_request(id) &&
                      event(r, c.form, id, c.board, "request_state_changed",
                            state)
                  ? request_detail(r, id, c.board, 200)
                  : unavailable();
      }
    }
    ob_free(state);
    return out;
  }
  if (!strcmp(op, "convert")) {
    if (!allowed_keys(r->body && *r->body ? r->body : "{}", ",description,"))
      return error_response(400, "Payload non valido.");
    return convert_request(r, &c);
  }
  if (!allowed_keys(r->body && *r->body ? r->body : "{}", ","))
    return error_response(400, "Payload non valido.");
  if (!owner && !writer)
    return error_response(
        403, "Solo l'autore e i membri scriventi possono gestire il cestino.");
  sqlite3_stmt *s;
  const char *action;
  if (restore) {
    if (!c.deleted)
      return error_response(409, "Richiesta già attiva.");
    s = prepare("UPDATE intake_requests SET deleted_at=NULL WHERE id=?1");
    action = "request_restored";
  } else {
    s = prepare("UPDATE intake_requests SET "
                "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1");
    action = "request_deleted";
  }
  sqlite3_bind_int64(s, 1, id);
  return done(s) && bump_request(id) &&
                 event(r, c.form, id, c.board, action, "")
             ? request_detail(r, id, c.board, 200)
             : unavailable();
}
static Response list_forms(Request *r, int64_t board) {
  if (!live_board(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  int64_t before, limit;
  bool include;
  if (!page(r, &before, &limit) || !flag(r, "include_deleted", &include))
    return error_response(400, "Paginazione o filtro non valido.");
  if (include && !manager(r, board))
    return error_response(
        403, "Il cestino dei moduli è riservato agli amministratori.");
  sqlite3_stmt *s =
      prepare("WITH page AS(SELECT f.id," FORM_JSON
              " item FROM intake_forms f WHERE f.board_id=?1 AND f.id<?2 AND "
              "(?7 OR f.deleted_at IS NULL) ORDER BY f.id DESC LIMIT ?3+1) "
              "SELECT json_object('items',json((SELECT "
              "json_group_array(json(item)) FROM(SELECT item FROM page ORDER "
              "BY id DESC LIMIT ?3))),'next_cursor',CASE WHEN (SELECT count(*) "
              "FROM page)>?3 THEN (SELECT min(id) FROM(SELECT id FROM page "
              "ORDER BY id DESC LIMIT ?3)) ELSE NULL END)");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  actor_bind(s, r, board, include);
  return row(s);
}
static bool request_filter(Request *r, char state[20]) {
  int n = ob_query(r, "state", state, 20);
  return n >= 0 &&
         (!n || !strcmp(state, "new") || !strcmp(state, "in_review") ||
          !strcmp(state, "accepted") || !strcmp(state, "rejected"));
}
static Response list_requests(Request *r, int64_t board) {
  if (board && (!live_board(board) || !auth_board_allowed(r, board, false)))
    return error_response(404, "Bacheca non trovata.");
  int64_t before, limit;
  bool include;
  char search[801] = {0};
  int search_length = ob_query(r, "q", search, sizeof search), characters = 0;
  for (const unsigned char *p = (const unsigned char *)search; *p; p++)
    if ((*p & 0xc0) != 0x80)
      characters++;
  if (search_length < 0 || characters > 200 ||
      !valid_utf8(search, strlen(search)))
    return error_response(400, "Ricerca non valida o oltre 200 caratteri.");
  char state[20] = {0};
  if (!page(r, &before, &limit) || !flag(r, "include_deleted", &include) ||
      !request_filter(r, state))
    return error_response(400, "Paginazione o filtro non valido.");
  sqlite3_stmt *s = prepare(
      "WITH page AS(SELECT q.id," REQUEST_LIST_JSON
      " item FROM intake_requests q JOIN intake_forms f ON f.id=q.form_id JOIN "
      "boards b ON b.id=q.board_id JOIN users u ON u.id=q.author_id WHERE "
      "(?1=0 OR q.board_id=?1) AND (?1<>0 OR q.author_id=?8) AND b.deleted_at "
      "IS NULL AND f.deleted_at IS NULL AND (?9 OR EXISTS(SELECT 1 FROM "
      "board_members m WHERE m.board_id=q.board_id AND m.user_id=?8)) AND "
      "q.id<?2 AND (q.deleted_at IS NULL OR (?7 AND (q.author_id=?8 OR (?10 "
      "AND (?9 OR EXISTS(SELECT 1 FROM board_members m WHERE "
      "m.board_id=q.board_id AND m.user_id=?8 AND m.role<>'observer')))))) AND "
      "(?4='' OR q.state=?4) AND (?5='' OR instr(lower(q.title||' '||u.name||' "
      "'||f.name),lower(?5))>0) ORDER BY q.id DESC LIMIT ?3+1) SELECT "
      "json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT item FROM page ORDER BY id DESC LIMIT "
      "?3))),'next_cursor',CASE WHEN (SELECT count(*) FROM page)>?3 THEN "
      "(SELECT min(id) FROM(SELECT id FROM page ORDER BY id DESC LIMIT ?3)) "
      "ELSE NULL END)");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  bind_text(s, 4, state);
  bind_text(s, 5, search);
  actor_bind(s, r, board, include);
  sqlite3_bind_int(s, 10, strcmp(r->role, "observer") != 0);
  return row(s);
}
static Response history(Request *r, int64_t id, bool form) {
  Context c;
  Response out;
  if (form ? !form_context(r, id, true, &c, &out)
           : !request_context(r, id, true, &c, &out))
    return out;
  int64_t before, limit;
  if (!page(r, &before, &limit))
    return error_response(400, "Paginazione non valida.");
  sqlite3_stmt *s = prepare(
      form ? "WITH page AS(SELECT "
             "id,json_object('id',id,'actor_id',actor_id,'actor',actor,'action'"
             ",action,'note',note,'created_at',created_at,'request_id',request_"
             "id) item FROM intake_events WHERE form_id=?1 AND id<?2 ORDER BY "
             "id DESC LIMIT ?3+1) SELECT json_object('items',json((SELECT "
             "json_group_array(json(item)) FROM(SELECT item FROM page ORDER BY "
             "id DESC LIMIT ?3))),'next_cursor',CASE WHEN (SELECT count(*) "
             "FROM page)>?3 THEN (SELECT min(id) FROM(SELECT id FROM page "
             "ORDER BY id DESC LIMIT ?3)) ELSE NULL END)"
           : "WITH page AS(SELECT "
             "id,json_object('id',id,'actor_id',actor_id,'actor',actor,'action'"
             ",action,'note',note,'created_at',created_at) item FROM "
             "intake_events WHERE request_id=?1 AND id<?2 ORDER BY id DESC "
             "LIMIT ?3+1) SELECT json_object('items',json((SELECT "
             "json_group_array(json(item)) FROM(SELECT item FROM page ORDER BY "
             "id DESC LIMIT ?3))),'next_cursor',CASE WHEN (SELECT count(*) "
             "FROM page)>?3 THEN (SELECT min(id) FROM(SELECT id FROM page "
             "ORDER BY id DESC LIMIT ?3)) ELSE NULL END)");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  return row(s);
}
static Response stats(Request *r, int64_t board) {
  if (!live_board(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  sqlite3_stmt *s = prepare(
      "SELECT "
      "json_object('total',count(*),'new',coalesce(sum(q.state='new'),0),'in_"
      "review',coalesce(sum(q.state='in_review'),0),'accepted',coalesce(sum(q."
      "state='accepted'),0),'rejected',coalesce(sum(q.state='rejected'),0),'"
      "converted',coalesce(sum(q.converted_card_id IS NOT NULL),0)) FROM "
      "intake_requests q JOIN intake_forms f ON f.id=q.form_id WHERE "
      "q.board_id=?1 AND q.deleted_at IS NULL AND f.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, board);
  return row(s);
}
static void csv_cell(sqlite3_str *out, const char *value) {
  if (!value)
    value = "";
  sqlite3_str_appendchar(out, 1, '"');
  const unsigned char *p = (const unsigned char *)value;
  while (*p && isspace(*p))
    p++;
  if (*p == '=' || *p == '+' || *p == '-' || *p == '@' || *value == '\t' ||
      *value == '\r' || *value == '\n')
    sqlite3_str_appendchar(out, 1, '\'');
  for (; *value; value++) {
    sqlite3_str_appendchar(out, 1, *value);
    if (*value == '"')
      sqlite3_str_appendchar(out, 1, '"');
  }
  sqlite3_str_appendchar(out, 1, '"');
}
static Response export_requests(Request *r, int64_t board) {
  if (!live_board(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  sqlite3_stmt *s =
      prepare("SELECT "
              "q.id,f.name,u.name,q.title,q.state,q.answers,q.schema_snapshot,"
              "q.converted_card_id,q.created_at FROM intake_requests q JOIN "
              "intake_forms f ON f.id=q.form_id JOIN users u ON "
              "u.id=q.author_id WHERE q.board_id=?1 AND q.deleted_at IS NULL "
              "AND f.deleted_at IS NULL ORDER BY q.id DESC LIMIT 1001");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_str *text = sqlite3_str_new(db);
  sqlite3_str_appendall(text, "id,form,author,title,state,answers_json,schema_"
                              "snapshot_json,converted_card_id,created_at\r\n");
  int rc, count = 0;
  bool full = false;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    if (++count > 1000) {
      full = true;
      break;
    }
    for (int i = 0; i < 9; i++) {
      if (i)
        sqlite3_str_appendchar(text, 1, ',');
      csv_cell(text, (const char *)sqlite3_column_text(s, i));
    }
    sqlite3_str_appendall(text, "\r\n");
    if (sqlite3_str_length(text) > 2097152) {
      full = true;
      break;
    }
  }
  sqlite3_finalize(s);
  char *csv = sqlite3_str_finish(text);
  if (full) {
    sqlite3_free(csv);
    return error_response(
        413,
        "Esportazione oltre 1000 righe o 2 MiB. Riduci i dati della bacheca.");
  }
  if (rc != SQLITE_DONE || !csv) {
    sqlite3_free(csv);
    return unavailable();
  }
  Response out = json_response(200, csv);
  sqlite3_free(csv);
  out.type = "text/csv; charset=utf-8";
  snprintf(out.headers, sizeof out.headers,
           "Content-Disposition: attachment; "
           "filename=\"openboard-richieste-%lld.csv\"\r\n",
           (long long)board);
  return out;
}
static int64_t resource(const char *path, const char *prefix,
                        const char **tail) {
  size_t n = strlen(prefix);
  if (strncmp(path, prefix, n))
    return 0;
  const char *p = path + n, *end = p;
  while (isdigit((unsigned char)*end))
    end++;
  if (end == p || (*end && *end != '/') || (size_t)(end - p) >= 30)
    return 0;
  char number[32];
  memcpy(number, p, (size_t)(end - p));
  number[end - p] = 0;
  *tail = end;
  return parse_id(number);
}
bool intake_handle(Request *r, Response *out) {
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  const char *tail = NULL;
  int64_t id = resource(r->path, "/api/boards/", &tail);
  bool own_route =
      !strncmp(r->path, "/api/intake/", 12) ||
      !strcmp(r->path, "/api/me/intake/requests") ||
      (id &&
       (!strcmp(tail, "/intake/forms") || !strcmp(tail, "/intake/requests") ||
        !strcmp(tail, "/intake/stats") || !strcmp(tail, "/intake/export")));
  if (own_route && (!ob_config.auth_enabled || !r->user_id)) {
    *out = error_response(
        403, "Le richieste interne richiedono un account autenticato.");
    return true;
  }
  if (id &&
      (!strcmp(tail, "/intake/forms") || !strcmp(tail, "/intake/requests") ||
       !strcmp(tail, "/intake/stats") || !strcmp(tail, "/intake/export"))) {
    if (!strcmp(tail, "/intake/forms"))
      *out = get    ? list_forms(r, id)
             : post ? create_form(r, id)
                    : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/intake/requests"))
      *out = get ? list_requests(r, id)
                 : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/intake/stats"))
      *out = get ? stats(r, id) : error_response(405, "Metodo non consentito.");
    else
      *out = get ? export_requests(r, id)
                 : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(r->path, "/api/me/intake/requests")) {
    *out = get ? list_requests(r, 0)
               : error_response(405, "Metodo non consentito.");
    return true;
  }
  id = resource(r->path, "/api/intake/forms/", &tail);
  if (id) {
    if (!*tail)
      *out = get     ? mutate_form(r, id, "get")
             : patch ? mutate_form(r, id, "edit")
             : del   ? mutate_form(r, id, "delete")
                     : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/fields"))
      *out = post ? create_field(r, id)
                  : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/fields/reorder"))
      *out = post ? reorder_fields(r, id)
                  : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/requests"))
      *out =
          post ? submit(r, id) : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/history"))
      *out = get ? history(r, id, true)
                 : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/publish") || !strcmp(tail, "/pause") ||
             !strcmp(tail, "/restore"))
      *out = post ? mutate_form(r, id, tail + 1)
                  : error_response(405, "Metodo non consentito.");
    else
      *out = error_response(404, "Risorsa non trovata.");
    return true;
  }
  id = resource(r->path, "/api/intake/fields/", &tail);
  if (id) {
    if (!*tail)
      *out = patch ? mutate_field(r, id, "edit")
             : del ? mutate_field(r, id, "delete")
                   : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/restore"))
      *out = post ? mutate_field(r, id, "restore")
                  : error_response(405, "Metodo non consentito.");
    else
      *out = error_response(404, "Risorsa non trovata.");
    return true;
  }
  id = resource(r->path, "/api/intake/requests/", &tail);
  if (id) {
    if (!*tail)
      *out = get     ? mutate_request(r, id, "get")
             : patch ? mutate_request(r, id, "edit")
             : del   ? mutate_request(r, id, "delete")
                     : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/history"))
      *out = get ? history(r, id, false)
                 : error_response(405, "Metodo non consentito.");
    else if (!strcmp(tail, "/notes")) {
      if (post)
        *out = mutate_request(r, id, "note");
      else if (get) {
        Context c;
        if (request_context(r, id, false, &c, out)) {
          sqlite3_stmt *s =
              prepare("SELECT json_object('items',json(" NOTES_JSON
                      ")) FROM intake_requests q WHERE q.id=?1");
          sqlite3_bind_int64(s, 1, id);
          *out = row(s);
        }
      } else
        *out = error_response(405, "Metodo non consentito.");
    } else if (!strcmp(tail, "/state") || !strcmp(tail, "/convert") ||
               !strcmp(tail, "/restore"))
      *out = post ? mutate_request(r, id, tail + 1)
                  : error_response(405, "Metodo non consentito.");
    else
      *out = error_response(404, "Risorsa non trovata.");
    return true;
  }
  return false;
}
