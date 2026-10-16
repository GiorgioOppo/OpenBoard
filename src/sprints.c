/* OpenBoard iterations and capacity. SPDX-License-Identifier: MIT */
#include "sprints.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void sprints_schema(sqlite3 *connection) {
  const char *schema[] = {
      "CREATE TABLE sprints(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id "
      "INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,name TEXT NOT "
      "NULL,goal TEXT NOT NULL DEFAULT '',start_date TEXT NOT NULL DEFAULT '',"
      "end_date TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'planned' "
      "CHECK(state IN('planned','active','closed')),creator_id INTEGER NOT "
      "NULL "
      "REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,"
      "created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
      "updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
      "CREATE INDEX sprints_board ON sprints(board_id,id DESC);"
      "CREATE UNIQUE INDEX sprints_one_active ON sprints(board_id) WHERE "
      "state='active' AND deleted_at IS NULL;"
      "CREATE TABLE sprint_cards(sprint_id INTEGER NOT NULL REFERENCES "
      "sprints(id) ON DELETE CASCADE,card_id INTEGER NOT NULL REFERENCES "
      "cards(id) ON DELETE CASCADE,added_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
      "PRIMARY KEY(sprint_id,card_id));"
      "CREATE INDEX sprint_cards_card ON sprint_cards(card_id,sprint_id);"
      "CREATE TABLE sprint_capacity(sprint_id INTEGER NOT NULL REFERENCES "
      "sprints(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES "
      "users(id) ON DELETE CASCADE,minutes INTEGER NOT NULL "
      "CHECK(minutes BETWEEN 0 AND 1000000),PRIMARY KEY(sprint_id,user_id));",
      "CREATE TABLE sprint_snapshots(sprint_id INTEGER NOT NULL REFERENCES "
      "sprints(id) ON DELETE CASCADE,day TEXT NOT NULL,total INTEGER NOT NULL,"
      "completed INTEGER NOT NULL,estimate_minutes INTEGER NOT NULL,"
      "completed_estimate_minutes INTEGER NOT NULL,remaining_minutes INTEGER "
      "NOT NULL,logged_minutes INTEGER NOT NULL,captured_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY "
      "KEY(sprint_id,day));"
      "CREATE TABLE sprint_events(id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,"
      "actor_id INTEGER REFERENCES users(id),actor TEXT NOT NULL,action TEXT "
      "NOT NULL,subject_id INTEGER,note TEXT NOT NULL DEFAULT '',created_at "
      "TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
      "CREATE INDEX sprint_events_sprint ON sprint_events(sprint_id,id DESC);"
      /* A removed or downgraded member must not regain a stale capacity later.
       */
      "CREATE TRIGGER sprint_capacity_member_removed AFTER DELETE ON "
      "board_members BEGIN DELETE FROM sprint_capacity WHERE "
      "user_id=OLD.user_id "
      "AND sprint_id IN(SELECT id FROM sprints WHERE "
      "board_id=OLD.board_id);END;"
      "CREATE TRIGGER sprint_capacity_member_observer AFTER UPDATE OF role ON "
      "board_members WHEN NEW.role='observer' BEGIN DELETE FROM "
      "sprint_capacity "
      "WHERE user_id=NEW.user_id AND sprint_id IN(SELECT id FROM sprints WHERE "
      "board_id=NEW.board_id);END;"
      "CREATE TRIGGER sprint_capacity_user_ineligible AFTER UPDATE OF "
      "active,role "
      "ON users WHEN NEW.active=0 OR NEW.role='observer' BEGIN DELETE FROM "
      "sprint_capacity WHERE user_id=NEW.id;END;"};
  for (size_t i = 0; i < sizeof schema / sizeof schema[0]; i++) {
    char *error = NULL;
    if (sqlite3_exec(connection, schema[i], NULL, NULL, &error) != SQLITE_OK) {
      fprintf(stderr, "Schema sprint non disponibile: %s\n",
              error ? error : sqlite3_errmsg(connection));
      sqlite3_free(error);
      exit(EXIT_FAILURE);
    }
  }
}

typedef struct {
  int64_t board, version;
  bool deleted;
  char state[12];
} Context;
static bool done(sqlite3_stmt *s) {
  bool ok = sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static Response unavailable(void) {
  return error_response(503,
                        "Archivio sprint temporaneamente non disponibile.");
}
static Response row(sqlite3_stmt *s) {
  int rc = sqlite3_step(s);
  Response out =
      rc == SQLITE_ROW
          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
          : error_response(rc == SQLITE_DONE ? 404 : 503,
                           "Sprint non disponibile.");
  sqlite3_finalize(s);
  return out;
}
static int64_t scalar(const char *sql, int64_t id) {
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, id);
  int64_t out = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
  sqlite3_finalize(s);
  return out;
}
static bool live_board(Request *r, int64_t board, bool write) {
  return scalar("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL",
                board) &&
         auth_board_allowed(r, board, write);
}
static bool manager(Request *r, int64_t board) {
  if (!auth_board_allowed(r, board, true))
    return false;
  if (auth_is_admin(r))
    return true;
  sqlite3_stmt *s = prepare("SELECT 1 FROM board_members WHERE board_id=?1 "
                            "AND user_id=?2 AND role='admin'");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, r->user_id);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool fields(const char *body, const char *allowed) {
  if (!body)
    return false;
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM json_each(?1) WHERE instr(key,'|')>0 OR "
              "instr(?2,'|'||key||'|')=0 LIMIT 1");
  bind_text(s, 1, body);
  bind_text(s, 2, allowed);
  bool ok = sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static bool nonblank(const char *value) {
  if (value)
    for (; *value; value++)
      if (!isspace((unsigned char)*value))
        return true;
  return false;
}
static bool date_valid(const char *date) {
  if (!date || !*date)
    return true;
  if (strlen(date) != 10 || date[4] != '-' || date[7] != '-')
    return false;
  for (int i = 0; i < 10; i++)
    if (i != 4 && i != 7 && !isdigit((unsigned char)date[i]))
      return false;
  int y = (date[0] - '0') * 1000 + (date[1] - '0') * 100 +
          (date[2] - '0') * 10 + date[3] - '0';
  int m = (date[5] - '0') * 10 + date[6] - '0',
      d = (date[8] - '0') * 10 + date[9] - '0';
  const int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return y >= 1900 && m >= 1 && m <= 12 && d >= 1 &&
         d <=
             days[m] + (m == 2 && y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
}
static int matched(Request *r, int64_t current) {
  if (!r->if_match[0])
    return 0;
  const char *p = r->if_match;
  char value[80];
  if (*p == '"') {
    size_t n = strlen(p);
    if (n < 3 || p[n - 1] != '"')
      return 400;
    memcpy(value, p + 1, n - 2);
    value[n - 2] = 0;
    p = value;
  }
  int64_t expected = parse_id(p);
  return !expected ? 400 : expected == current ? 0 : 412;
}
static bool context(Request *r, int64_t id, bool include_deleted, bool write,
                    Context *c, Response *out) {
  sqlite3_stmt *s = prepare("SELECT board_id,version,deleted_at IS NOT "
                            "NULL,state FROM sprints WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    *out = error_response(404, "Sprint non trovato.");
    return false;
  }
  c->board = sqlite3_column_int64(s, 0);
  c->version = sqlite3_column_int64(s, 1);
  c->deleted = sqlite3_column_int(s, 2);
  snprintf(c->state, sizeof c->state, "%s", sqlite3_column_text(s, 3));
  sqlite3_finalize(s);
  if ((!include_deleted && c->deleted) || !live_board(r, c->board, false)) {
    *out = error_response(404, "Sprint non trovato.");
    return false;
  }
  if (write) {
    if (!auth_board_allowed(r, c->board, true)) {
      *out =
          error_response(403, "È richiesto accesso in scrittura alla bacheca.");
      return false;
    }
    int code = matched(r, c->version);
    if (code) {
      *out =
          error_response(code, code == 412 ? "Versione dello sprint superata."
                                           : "If-Match non valido.");
      return false;
    }
    if (scalar("SELECT count(*) FROM sprint_events WHERE sprint_id=?1", id) >=
        10000) {
      *out =
          error_response(409, "Limite di 10000 eventi dello sprint raggiunto.");
      return false;
    }
  }
  return true;
}
static bool event(Request *r, int64_t id, int64_t board, const char *action,
                  int64_t subject, const char *note, bool bump) {
  sqlite3_stmt *s =
      prepare("INSERT INTO "
              "sprint_events(sprint_id,actor_id,actor,action,subject_id,note) "
              "SELECT ?1,id,name,?3,?4,?5 FROM users WHERE id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, action);
  if (subject)
    sqlite3_bind_int64(s, 4, subject);
  bind_text(s, 5, note);
  if (!done(s))
    return false;
  if (bump) {
    s = prepare("UPDATE sprints SET "
                "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','"
                "now') WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (!done(s))
      return false;
  }
  s = prepare(
      "INSERT INTO "
      "activity(board_id,actor_id,actor,action,entity_type,entity_id,title) "
      "SELECT ?1,u.id,u.name,?3,'sprints',s.id,s.name FROM users u JOIN "
      "sprints s ON s.id=?4 WHERE u.id=?2");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, action);
  sqlite3_bind_int64(s, 4, id);
  if (!done(s))
    return false;
  s = prepare("UPDATE boards SET "
              "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
              ") WHERE id=?1");
  sqlite3_bind_int64(s, 1, board);
  return done(s);
}
#define SPRINT_JSON                                                            \
  "json_object('id',s.id,'board_id',s.board_id,'name',s.name,'goal',s.goal,"   \
  "'start_date',s.start_date,'end_date',s.end_date,'state',s.state,'creator_"  \
  "id',s.creator_id,"                                                          \
  "'version',s.version,'deleted_at',s.deleted_at,'created_at',s.created_at,'"  \
  "updated_at',s.updated_at,"                                                  \
  "'permissions',json_object('manage',json(CASE WHEN ?8 AND (?9 OR "           \
  "EXISTS(SELECT 1 FROM board_members "                                        \
  "m WHERE m.board_id=s.board_id AND m.user_id=?7 AND m.role='admin')) THEN "  \
  "'true' ELSE 'false' END),"                                                  \
  "'schedule',json(CASE WHEN ?8 AND s.state<>'closed' AND s.deleted_at IS "    \
  "NULL THEN 'true' ELSE 'false' END)))"
static void actor(sqlite3_stmt *s, Request *r, bool write) {
  sqlite3_bind_int64(s, 7, r->user_id);
  sqlite3_bind_int(s, 8, write);
  sqlite3_bind_int(s, 9, auth_is_admin(r));
}
static Response detail(Request *r, int64_t id, int64_t board, int status) {
  sqlite3_stmt *s =
      prepare("SELECT " SPRINT_JSON " FROM sprints s WHERE s.id=?1");
  sqlite3_bind_int64(s, 1, id);
  actor(s, r, auth_board_allowed(r, board, true));
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static bool pagination(Request *r, int64_t *before, int64_t *limit) {
  char v[40];
  *before = INT64_MAX;
  *limit = 30;
  int n = ob_query(r, "before", v, sizeof v);
  if (n < 0 || (n && !(*before = parse_id(v))))
    return false;
  n = ob_query(r, "limit", v, sizeof v);
  return n >= 0 && (!n || ((*limit = parse_id(v)) && *limit <= 100));
}
static bool flag(Request *r, const char *key, bool *out) {
  char v[8];
  int n = ob_query(r, key, v, sizeof v);
  if (n < 0 || (n && strcmp(v, "0") && strcmp(v, "1")))
    return false;
  *out = n && !strcmp(v, "1");
  return true;
}
static Response create_or_edit(Request *r, int64_t scope, bool create) {
  Context c;
  Response out;
  int64_t board = scope;
  if (create) {
    if (!live_board(r, board, false))
      return error_response(404, "Bacheca non trovata.");
  } else {
    if (!context(r, scope, false, true, &c, &out))
      return out;
    board = c.board;
    if (!strcmp(c.state, "closed"))
      return error_response(409, "Riapri lo sprint prima di modificarlo.");
  }
  if (!manager(r, board))
    return error_response(403, "È richiesto un amministratore della bacheca.");
  char *name = NULL, *goal = NULL, *start = NULL, *end = NULL;
  int a = json_string(r->body, "name", &name, 120),
      b = json_string(r->body, "goal", &goal, 4000),
      d = json_string(r->body, "start_date", &start, 10),
      e = json_string(r->body, "end_date", &end, 10);
  if (!fields(r->body, "|name|goal|start_date|end_date|") || a < 0 || b < 0 ||
      d < 0 || e < 0 || (create && a != 1) || (name && !nonblank(name)) ||
      !date_valid(start) || !date_valid(end) ||
      (!create && !(a || b || d || e))) {
    out =
        error_response(400, "Nome, obiettivo o date dello sprint non validi.");
    goto cleanup;
  }
  sqlite3_stmt *s;
  if (!create && (!start || !end)) {
    s = prepare("SELECT start_date,end_date FROM sprints WHERE id=?1");
    sqlite3_bind_int64(s, 1, scope);
    if (sqlite3_step(s) == SQLITE_ROW) {
      if (!start)
        start = strdup((const char *)sqlite3_column_text(s, 0));
      if (!end)
        end = strdup((const char *)sqlite3_column_text(s, 1));
    }
    sqlite3_finalize(s);
    if (!start || !end) {
      out = unavailable();
      goto cleanup;
    }
  }
  if (start && *start && end && *end && strcmp(start, end) > 0) {
    out =
        error_response(400, "La data iniziale deve precedere la data finale.");
    goto cleanup;
  }
  if (create &&
      scalar("SELECT count(*) FROM sprints WHERE board_id=?1", board) >= 200) {
    out = error_response(409, "Limite di 200 sprint per bacheca raggiunto.");
    goto cleanup;
  }
  s = prepare(create ? "INSERT INTO "
                       "sprints(board_id,creator_id,name,goal,start_date,end_"
                       "date) VALUES(?1,?2,?3,?4,?5,?6)"
                     : "UPDATE sprints SET "
                       "name=coalesce(?3,name),goal=coalesce(?4,goal),start_"
                       "date=?5,end_date=?6 WHERE id=?1");
  sqlite3_bind_int64(s, 1, scope);
  sqlite3_bind_int64(s, 2, r->user_id);
  if (name)
    bind_text(s, 3, name);
  if (goal || create)
    bind_text(s, 4, goal ? goal : "");
  bind_text(s, 5, start ? start : "");
  bind_text(s, 6, end ? end : "");
  bool ok = done(s);
  int64_t id = create ? sqlite3_last_insert_rowid(db) : scope;
  out = ok && event(r, id, board, create ? "sprint_created" : "sprint_edited",
                    0, "", !create)
            ? detail(r, id, board, create ? 201 : 200)
            : unavailable();
cleanup:
  ob_free(name);
  ob_free(goal);
  ob_free(start);
  ob_free(end);
  return out;
}

/* Only live cards still belonging to the sprint's board participate in plans.
 * A move to another board cannot disclose the destination through old history.
 */
#define LIVE_CARDS                                                             \
  " FROM sprint_cards sc JOIN sprints sp ON sp.id=sc.sprint_id "               \
  "JOIN cards k ON k.id=sc.card_id JOIN columns c ON c.id=k.column_id JOIN "   \
  "boards b ON b.id=c.board_id "                                               \
  "WHERE sc.sprint_id=?1 AND c.board_id=sp.board_id AND k.deleted_at IS NULL " \
  "AND k.archived=0 "                                                          \
  "AND c.deleted_at IS NULL AND b.deleted_at IS NULL "
static bool membership_conflict(int64_t id) {
  /* Hidden cards and lists may later be restored. They still reserve their
   * current planned membership, so reopening history must not duplicate it. */
  return scalar(
      "SELECT 1 FROM sprint_cards sc JOIN sprints sp ON sp.id=sc.sprint_id "
      "JOIN cards k ON k.id=sc.card_id JOIN columns c ON c.id=k.column_id "
      "WHERE sc.sprint_id=?1 AND c.board_id=sp.board_id "
      "AND EXISTS(SELECT 1 FROM sprint_cards other JOIN sprints os ON "
      "os.id=other.sprint_id WHERE other.card_id=k.id AND os.id<>sp.id AND "
      "os.board_id=sp.board_id "
      "AND os.deleted_at IS NULL AND os.state<>'closed') LIMIT 1",
      id);
}
static bool active_other(int64_t board, int64_t id) {
  sqlite3_stmt *s = prepare("SELECT 1 FROM sprints WHERE board_id=?1 AND "
                            "id<>?2 AND state='active' AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, id);
  bool exists = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return exists;
}
static Response lifecycle(Request *r, int64_t id, const char *operation) {
  bool restore = !strcmp(operation, "restore");
  Context c;
  Response out;
  if (!context(r, id, restore, true, &c, &out))
    return out;
  if (!manager(r, c.board))
    return error_response(403, "È richiesto un amministratore della bacheca.");
  if ((strcmp(operation, "delete") || r->body_len) && !fields(r->body, "|"))
    return error_response(400, "Questa operazione richiede un oggetto vuoto.");
  const char *sql = NULL, *action = NULL;
  bool schedule = false;
  if (!strcmp(operation, "activate")) {
    if (strcmp(c.state, "planned"))
      return error_response(409,
                            "Puoi attivare soltanto uno sprint pianificato.");
    if (active_other(c.board, id))
      return error_response(409, "La bacheca ha già uno sprint attivo.");
    schedule = true;
    sql = "UPDATE sprints SET state='active' WHERE id=?1";
    action = "sprint_activated";
  } else if (!strcmp(operation, "close")) {
    if (strcmp(c.state, "active"))
      return error_response(409, "Puoi chiudere soltanto uno sprint attivo.");
    sql = "UPDATE sprints SET state='closed' WHERE id=?1";
    action = "sprint_closed";
  } else if (!strcmp(operation, "reopen")) {
    if (strcmp(c.state, "closed"))
      return error_response(409, "Puoi riaprire soltanto uno sprint chiuso.");
    schedule = true;
    sql = "UPDATE sprints SET state='planned' WHERE id=?1";
    action = "sprint_reopened";
  } else if (restore) {
    if (!c.deleted)
      return error_response(409, "Lo sprint non è eliminato.");
    if (!strcmp(c.state, "active") && active_other(c.board, id))
      return error_response(409, "La bacheca ha già uno sprint attivo.");
    schedule = strcmp(c.state, "closed") != 0;
    sql = "UPDATE sprints SET deleted_at=NULL WHERE id=?1";
    action = "sprint_restored";
  } else {
    sql = "UPDATE sprints SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
          "WHERE id=?1";
    action = "sprint_deleted";
  }
  if (schedule && membership_conflict(id))
    return error_response(
        409,
        "Una scheda appartiene già a un altro sprint pianificato o attivo.");
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, id);
  return done(s) && event(r, id, c.board, action, 0, "", true)
             ? detail(r, id, c.board, 200)
             : unavailable();
}
static bool search_valid(const char *q) {
  if (!valid_utf8(q, strlen(q)))
    return false;
  sqlite3_stmt *s = prepare("SELECT length(?1)<=200");
  bind_text(s, 1, q);
  bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  return ok;
}
static Response list_sprints(Request *r, int64_t board) {
  if (!live_board(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  int64_t before, limit;
  bool deleted;
  char state[16] = "", q[801] = "";
  if (!pagination(r, &before, &limit) ||
      !flag(r, "include_deleted", &deleted) ||
      ob_query(r, "state", state, sizeof state) < 0 ||
      ob_query(r, "q", q, sizeof q) < 0 ||
      (state[0] && strcmp(state, "planned") && strcmp(state, "active") &&
       strcmp(state, "closed")) ||
      !search_valid(q))
    return error_response(400, "Filtri dello sprint non validi.");
  sqlite3_stmt *s = prepare(
      "WITH page AS(SELECT s.* FROM sprints s WHERE board_id=?1 AND "
      "(?4 OR deleted_at IS NULL) AND (?5='' OR state=?5) AND "
      "(?6='' OR instr(lower(name||' '||goal),lower(?6))>0) AND id<?2 ORDER BY "
      "id DESC LIMIT ?3+1) "
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT " SPRINT_JSON
      " item FROM page s ORDER BY id DESC LIMIT ?3))),'next_cursor',CASE WHEN "
      "(SELECT count(*) FROM page)>?3 THEN(SELECT min(id) FROM(SELECT id FROM "
      "page ORDER BY id DESC LIMIT ?3)) ELSE NULL END)");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  sqlite3_bind_int(s, 4, deleted);
  bind_text(s, 5, state);
  bind_text(s, 6, q);
  actor(s, r, auth_board_allowed(r, board, true));
  return row(s);
}
static bool card_in_board(int64_t card, int64_t board) {
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM cards k JOIN columns c ON c.id=k.column_id WHERE "
              "k.id=?1 AND c.board_id=?2 AND k.deleted_at IS NULL AND "
              "k.archived=0 AND c.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, board);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool card_scheduled(int64_t card, int64_t board) {
  sqlite3_stmt *s = prepare(
      "SELECT 1 FROM sprint_cards sc JOIN sprints s ON s.id=sc.sprint_id "
      "WHERE sc.card_id=?1 AND s.board_id=?2 AND s.deleted_at IS NULL AND "
      "s.state<>'closed'");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, board);
  bool exists = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return exists;
}
static bool card_ids(const char *body, int64_t ids[100], int *count) {
  if (!fields(body, "|card_ids|"))
    return false;
  sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.card_ids')='array'");
  bind_text(s, 1, body);
  bool array = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  if (!array)
    return false;
  s = prepare("SELECT value,type FROM json_each(?1,'$.card_ids')");
  bind_text(s, 1, body);
  *count = 0;
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    int64_t id = sqlite3_column_int64(s, 0);
    if (*count == 100 || id <= 0 ||
        strcmp((const char *)sqlite3_column_text(s, 1), "integer")) {
      sqlite3_finalize(s);
      return false;
    }
    for (int i = 0; i < *count; i++)
      if (ids[i] == id) {
        sqlite3_finalize(s);
        return false;
      }
    ids[(*count)++] = id;
  }
  sqlite3_finalize(s);
  return rc == SQLITE_DONE && *count > 0;
}
static Response membership(Request *r, int64_t id, int64_t card, bool bulk,
                           bool remove) {
  Context c;
  Response out;
  if (!context(r, id, false, true, &c, &out))
    return out;
  if (!strcmp(c.state, "closed"))
    return error_response(409,
                          "Riapri lo sprint prima di modificarne le schede.");
  int64_t ids[100];
  int count = 1;
  if (bulk) {
    if (!card_ids(r->body, ids, &count))
      return error_response(
          400,
          "card_ids deve contenere da 1 a 100 ID interi positivi distinti.");
  } else if (!remove) {
    if (!fields(r->body, "|card_id|") ||
        json_integer(r->body, "card_id", &card, 1, INT64_MAX, false) != 1)
      return error_response(400, "card_id non valido.");
    ids[0] = card;
  } else {
    if (r->body_len && !fields(r->body, "|"))
      return error_response(
          400, "La rimozione singola non accetta campi aggiuntivi.");
    ids[0] = card;
  }
  if (!remove &&
      scalar("SELECT count(*) FROM sprint_cards WHERE sprint_id=?1", id) +
              count >
          1000)
    return error_response(409, "Limite di 1000 schede per sprint raggiunto.");
  for (int i = 0; i < count; i++) {
    if (!card_in_board(ids[i], c.board))
      return error_response(404,
                            "Scheda non trovata nella bacheca dello sprint.");
    sqlite3_stmt *s =
        prepare("SELECT 1 FROM sprint_cards WHERE sprint_id=?1 AND card_id=?2");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, ids[i]);
    bool exists = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    if ((remove && !exists) || (!remove && card_scheduled(ids[i], c.board)))
      return error_response(
          409, remove ? "Una scheda non appartiene allo sprint."
                      : "Una scheda è già pianificata in uno sprint.");
  }
  for (int i = 0; i < count; i++) {
    sqlite3_stmt *s = prepare(
        remove ? "DELETE FROM sprint_cards WHERE sprint_id=?1 AND card_id=?2"
               : "INSERT INTO sprint_cards(sprint_id,card_id) VALUES(?1,?2)");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, ids[i]);
    if (!done(s))
      return unavailable();
  }
  char note[64];
  snprintf(note, sizeof note, "%d schede", count);
  return event(r, id, c.board,
               remove ? "sprint_cards_removed" : "sprint_cards_added",
               bulk ? 0 : ids[0], note, true)
             ? detail(r, id, c.board, 200)
             : unavailable();
}

typedef struct {
  char q[801], status[16], priority[16];
  int64_t assignee, before, limit;
} CardFilters;
static bool card_filters(Request *r, CardFilters *f) {
  memset(f, 0, sizeof *f);
  int status = ob_query(r, "status", f->status, sizeof f->status);
  if (!status)
    snprintf(f->status, sizeof f->status, "all");
  if (!pagination(r, &f->before, &f->limit) ||
      ob_query(r, "q", f->q, sizeof f->q) < 0 || status < 0 ||
      ob_query(r, "priority", f->priority, sizeof f->priority) < 0)
    return false;
  if (strcmp(f->status, "all") && strcmp(f->status, "open") &&
      strcmp(f->status, "completed") && strcmp(f->status, "blocked"))
    return false;
  if (f->priority[0] && strcmp(f->priority, "low") &&
      strcmp(f->priority, "normal") && strcmp(f->priority, "high") &&
      strcmp(f->priority, "urgent"))
    return false;
  char v[40];
  int n = ob_query(r, "assignee_id", v, sizeof v);
  if (n < 0 || (n && !(f->assignee = parse_id(v))))
    return false;
  return search_valid(f->q);
}
/* Scope 0: selected sprint; 1: board backlog; 2: current user's active tasks.
 */
#define CARD_CTE                                                               \
  "WITH eligible AS(SELECT k.*,c.board_id,b.name board_name,c.title "          \
  "column_title,"                                                              \
  "(SELECT sp.id FROM sprint_cards sc JOIN sprints sp ON sp.id=sc.sprint_id "  \
  "WHERE sc.card_id=k.id "                                                     \
  "AND sp.board_id=c.board_id AND sp.deleted_at IS NULL AND ((?2=0 AND "       \
  "sp.id=?1) OR (?2=2 AND sp.state='active')) LIMIT 1) sprint_id "             \
  "FROM cards k JOIN columns c ON c.id=k.column_id JOIN boards b ON "          \
  "b.id=c.board_id WHERE k.deleted_at IS NULL "                                \
  "AND k.archived=0 AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND "    \
  "ob_allowed(b.id) AND "                                                      \
  "((?2=0 AND EXISTS(SELECT 1 FROM sprint_cards sc JOIN sprints sp ON "        \
  "sp.id=sc.sprint_id WHERE sc.sprint_id=?1 "                                  \
  "AND sc.card_id=k.id AND sp.board_id=c.board_id)) OR (?2=1 AND "             \
  "c.board_id=?1 AND NOT EXISTS(SELECT 1 "                                     \
  "FROM sprint_cards sc JOIN sprints sp ON sp.id=sc.sprint_id WHERE "          \
  "sc.card_id=k.id AND sp.board_id=c.board_id "                                \
  "AND sp.deleted_at IS NULL AND sp.state<>'closed')) OR (?2=2 AND "           \
  "b.archived=0 AND EXISTS(SELECT 1 FROM "                                     \
  "card_assignees ca WHERE ca.card_id=k.id AND ca.user_id=?3) AND "            \
  "EXISTS(SELECT 1 FROM sprint_cards sc JOIN "                                 \
  "sprints sp ON sp.id=sc.sprint_id WHERE sc.card_id=k.id AND "                \
  "sp.board_id=c.board_id AND sp.deleted_at IS NULL "                          \
  "AND sp.state='active'))) AND (?4='' OR instr(lower(k.title||' "             \
  "'||k.description),lower(?4))>0) "                                           \
  "AND (?5='all' OR (?5='open' AND k.completed=0) OR (?5='completed' AND "     \
  "k.completed=1) OR (?5='blocked' "                                           \
  "AND k.completed=0 AND (k.blocked_reason<>'' OR EXISTS(SELECT 1 FROM "       \
  "card_dependencies d JOIN cards dep "                                        \
  "ON dep.id=d.required_card_id JOIN columns dc ON dc.id=dep.column_id JOIN "  \
  "boards dbb ON dbb.id=dc.board_id "                                          \
  "WHERE d.card_id=k.id AND dep.completed=0 AND dep.deleted_at IS NULL AND "   \
  "dep.archived=0 AND dc.deleted_at "                                          \
  "IS NULL AND dbb.deleted_at IS NULL AND dbb.archived=0 AND "                 \
  "ob_allowed(dbb.id))))) AND (?6='' OR k.priority=?6) "                       \
  "AND (?7=0 OR EXISTS(SELECT 1 FROM card_assignees ca WHERE ca.card_id=k.id " \
  "AND ca.user_id=?7))) "
static void card_bind(sqlite3_stmt *s, Request *r, CardFilters *f,
                      int64_t scope, int mode) {
  sqlite3_bind_int64(s, 1, scope);
  sqlite3_bind_int(s, 2, mode);
  sqlite3_bind_int64(s, 3, r->user_id);
  bind_text(s, 4, f->q);
  bind_text(s, 5, f->status);
  bind_text(s, 6, f->priority);
  sqlite3_bind_int64(s, 7, f->assignee);
  sqlite3_bind_int64(s, 8, f->before);
  sqlite3_bind_int64(s, 9, f->limit);
}
static Response card_listing(Request *r, int64_t scope, int mode) {
  Context c;
  Response out;
  if (mode == 0 && !context(r, scope, false, false, &c, &out))
    return out;
  if (mode == 1 && !live_board(r, scope, false))
    return error_response(404, "Bacheca non trovata.");
  CardFilters f;
  if (!card_filters(r, &f))
    return error_response(400, "Filtri delle schede non validi.");
  sqlite3_stmt *s = prepare(
      CARD_CTE
      ",page AS(SELECT * FROM eligible WHERE id<?8 ORDER BY id DESC LIMIT "
      "?9+1) "
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT json_set(json(o.summary),"
      "'$.board_id',k.board_id,'$.board_name',k.board_name,'$.column_title',k."
      "column_title,'$.sprint_id',k.sprint_id,"
      "'$.sprint_name',(SELECT name FROM sprints WHERE id=k.sprint_id)) item "
      "FROM page k JOIN ob_card_objects o "
      "ON o.id=k.id ORDER BY k.id DESC LIMIT ?9))),'next_cursor',CASE "
      "WHEN(SELECT count(*) FROM page)>?9 "
      "THEN(SELECT min(id) FROM(SELECT id FROM page ORDER BY id DESC LIMIT "
      "?9)) ELSE NULL END)");
  card_bind(s, r, &f, scope, mode);
  return row(s);
}
#define PROGRESS_CTE                                                           \
  "WITH visible AS(SELECT k.*,coalesce((SELECT sum(minutes) FROM worklogs "    \
  "WHERE "                                                                     \
  "card_id=k.id AND deleted_at IS NULL),0) worklog_minutes" LIVE_CARDS "),"    \
  "progress AS(SELECT count(*) total,coalesce(sum(completed),0) "              \
  "completed,coalesce(sum(completed=0),0) open,"                               \
  "coalesce(sum(estimate_minutes),0) estimate_minutes,coalesce(sum(CASE WHEN " \
  "completed THEN estimate_minutes ELSE 0 END),0) completed_estimate_minutes," \
  "coalesce(sum(CASE WHEN completed=0 THEN "                                   \
  "max(0,estimate_minutes-actual_minutes-worklog_minutes) ELSE 0 END),0) "     \
  "remaining_minutes,"                                                         \
  "coalesce(sum(actual_minutes+worklog_minutes),0) "                           \
  "logged_minutes,coalesce(sum(completed=0 AND estimate_minutes=0),0) "        \
  "estimate_missing FROM visible) "
#define PROGRESS_JSON                                                          \
  "'total',total,'completed',completed,'open',open,'estimate_minutes',"        \
  "estimate_minutes,"                                                          \
  "'completed_estimate_minutes',completed_estimate_minutes,'remaining_"        \
  "minutes',remaining_minutes,'logged_minutes',logged_minutes,"                \
  "'completion_percent',CASE WHEN total=0 THEN 0 ELSE "                        \
  "round(completed*100.0/total,2) END"
static Response progress(Request *r, int64_t id, bool forecast) {
  Context c;
  Response out;
  if (!context(r, id, false, false, &c, &out))
    return out;
  const char *sql =
      forecast ? PROGRESS_CTE
          "SELECT json_object(" PROGRESS_JSON
          ",'capacity_minutes',coalesce((SELECT sum(cap.minutes) "
          "FROM sprint_capacity cap JOIN users u ON u.id=cap.user_id JOIN "
          "board_members bm ON bm.user_id=u.id "
          "WHERE cap.sprint_id=?1 AND bm.board_id=?2 AND u.active=1 AND "
          "u.role<>'observer' AND bm.role<>'observer'),0),"
          "'capacity_gap_minutes',max(0,remaining_minutes-coalesce((SELECT "
          "sum(cap.minutes) FROM sprint_capacity cap "
          "JOIN users u ON u.id=cap.user_id JOIN board_members bm ON "
          "bm.user_id=u.id WHERE cap.sprint_id=?1 AND "
          "bm.board_id=?2 AND u.active=1 AND u.role<>'observer' AND "
          "bm.role<>'observer'),0)),"
          "'estimate_missing',estimate_missing,'unestimated_cards',estimate_"
          "missing,"
          "'capacity_user_count',(SELECT count(*) FROM sprint_capacity cap "
          "JOIN users u ON u.id=cap.user_id "
          "JOIN board_members bm ON bm.user_id=u.id WHERE cap.sprint_id=?1 AND "
          "bm.board_id=?2 AND u.active=1 "
          "AND u.role<>'observer' AND bm.role<>'observer'),"
          "'capacity_configured',json(CASE WHEN EXISTS(SELECT 1 FROM "
          "sprint_capacity cap JOIN users u ON u.id=cap.user_id "
          "JOIN board_members bm ON bm.user_id=u.id WHERE cap.sprint_id=?1 AND "
          "bm.board_id=?2 AND u.active=1 "
          "AND u.role<>'observer' AND bm.role<>'observer') THEN 'true' ELSE "
          "'false' END),"
          "'description','Confronto tra "
          "lavoro residuo stimato e capacità dichiarata; non è una previsione "
          "di data.') FROM progress"
               : PROGRESS_CTE "SELECT json_object(" PROGRESS_JSON
                              ") FROM progress";
  sqlite3_stmt *s = prepare(sql);
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, c.board);
  return row(s);
}
static Response capacity(Request *r, int64_t id, int64_t user, bool write) {
  Context c;
  Response out;
  if (!context(r, id, false, write, &c, &out))
    return out;
  if (!write) {
    sqlite3_stmt *s =
        prepare("SELECT json_object('items',json((SELECT "
                "json_group_array(json(item)) FROM(SELECT "
                "json_object('user_id',u.id,'name',u.name,'minutes',coalesce("
                "cap.minutes,0)) item FROM board_members bm "
                "JOIN users u ON u.id=bm.user_id LEFT JOIN sprint_capacity cap "
                "ON cap.user_id=u.id AND cap.sprint_id=?1 "
                "WHERE bm.board_id=?2 AND u.active=1 AND u.role<>'observer' "
                "AND bm.role<>'observer' ORDER BY u.name,u.id))))");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, c.board);
    return row(s);
  }
  if (!manager(r, c.board))
    return error_response(403, "È richiesto un amministratore della bacheca.");
  if (!strcmp(c.state, "closed"))
    return error_response(409,
                          "Riapri lo sprint prima di modificarne la capacità.");
  int64_t minutes;
  if (!fields(r->body, "|minutes|") ||
      json_integer(r->body, "minutes", &minutes, 0, 1000000, false) != 1)
    return error_response(400,
                          "minutes deve essere un intero tra 0 e 1000000.");
  sqlite3_stmt *s = prepare("SELECT 1 FROM board_members bm JOIN users u ON "
                            "u.id=bm.user_id WHERE bm.board_id=?1 "
                            "AND u.id=?2 AND u.active=1 AND u.role<>'observer' "
                            "AND bm.role<>'observer'");
  sqlite3_bind_int64(s, 1, c.board);
  sqlite3_bind_int64(s, 2, user);
  bool eligible = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  if (!eligible)
    return error_response(
        400, "La capacità richiede un membro attivo con accesso in scrittura.");
  s = prepare(
      "INSERT INTO sprint_capacity(sprint_id,user_id,minutes) VALUES(?1,?2,?3) "
      "ON CONFLICT(sprint_id,user_id) DO UPDATE SET minutes=excluded.minutes");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, user);
  sqlite3_bind_int64(s, 3, minutes);
  char note[64];
  snprintf(note, sizeof note, "%lld minuti", (long long)minutes);
  return done(s) &&
                 event(r, id, c.board, "sprint_capacity_set", user, note, true)
             ? detail(r, id, c.board, 200)
             : unavailable();
}

/* Shared estimates are split evenly among currently eligible assignees. The
 * smallest user IDs receive the remainder, preserving exact integer totals. */
#define CAPACITY_CTE                                                           \
  "WITH visible AS(SELECT k.*,coalesce((SELECT sum(minutes) FROM worklogs "    \
  "WHERE card_id=k.id "                                                        \
  "AND deleted_at IS NULL),0) worklog_minutes" LIVE_CARDS                      \
  "),members AS(SELECT u.id,u.name,coalesce(cap.minutes,0) minutes "           \
  "FROM board_members bm JOIN users u ON u.id=bm.user_id LEFT JOIN "           \
  "sprint_capacity cap ON cap.user_id=u.id "                                   \
  "AND cap.sprint_id=?1 WHERE bm.board_id=?2 AND u.active=1 AND "              \
  "u.role<>'observer' AND bm.role<>'observer'),"                               \
  "assignments AS(SELECT "                                                     \
  "k.id,k.estimate_minutes,k.actual_minutes+k.worklog_minutes logged_minutes," \
  "CASE WHEN k.completed THEN 0 ELSE "                                         \
  "max(0,k.estimate_minutes-k.actual_minutes-k.worklog_minutes) END "          \
  "remaining_minutes,"                                                         \
  "a.user_id,count(*) OVER(PARTITION BY k.id) n,row_number() OVER(PARTITION "  \
  "BY k.id ORDER BY a.user_id) rank "                                          \
  "FROM visible k JOIN card_assignees a ON a.card_id=k.id JOIN members m ON "  \
  "m.id=a.user_id),loads AS(SELECT "                                           \
  "user_id,sum(estimate_minutes/n+(rank<=estimate_minutes%n)) "                \
  "assigned_minutes,"                                                          \
  "sum(logged_minutes/n+(rank<=logged_minutes%n)) logged_minutes,"             \
  "sum(remaining_minutes/n+(rank<=remaining_minutes%n)) remaining_minutes "    \
  "FROM assignments GROUP BY user_id),"                                        \
  "records AS(SELECT m.id user_id,m.name,m.minutes "                           \
  "capacity_minutes,coalesce(l.assigned_minutes,0) assigned_minutes,"          \
  "coalesce(l.logged_minutes,0) "                                              \
  "logged_minutes,coalesce(l.remaining_minutes,0) remaining_minutes "          \
  "FROM members m LEFT JOIN loads l ON l.user_id=m.id) "
static Response capacity_report(Request *r, int64_t id) {
  Context c;
  Response out;
  if (!context(r, id, false, false, &c, &out))
    return out;
  sqlite3_stmt *s = prepare(
      CAPACITY_CTE
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM("
      "SELECT "
      "json_object('user_id',user_id,'name',name,'capacity_minutes',capacity_"
      "minutes,'assigned_minutes',assigned_minutes,"
      "'logged_minutes',logged_minutes,'remaining_minutes',remaining_minutes,'"
      "over_capacity',json(CASE WHEN remaining_minutes>capacity_minutes "
      "THEN 'true' ELSE 'false' END)) item FROM records ORDER BY "
      "name,user_id))),"
      "'totals',json_object('capacity_minutes',coalesce((SELECT "
      "sum(capacity_minutes) FROM records),0),"
      "'assigned_minutes',coalesce((SELECT sum(estimate_minutes) FROM "
      "visible),0),"
      "'remaining_minutes',coalesce((SELECT sum(CASE WHEN completed THEN 0 "
      "ELSE max(0,estimate_minutes-actual_minutes-worklog_minutes) END) FROM "
      "visible),0),"
      "'unassigned_minutes',coalesce((SELECT sum(estimate_minutes) FROM "
      "visible k WHERE NOT EXISTS(SELECT 1 FROM assignments a WHERE "
      "a.id=k.id)),0)))");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, c.board);
  return row(s);
}
static Response snapshots(Request *r, int64_t id, const char *day, bool write,
                          bool remove) {
  Context c;
  Response out;
  if (!context(r, id, false, write, &c, &out))
    return out;
  sqlite3_stmt *s;
  if (!write) {
    s = prepare(
        "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
        "FROM(SELECT "
        "json_object('day',day,'total',total,'completed',completed,'estimate_"
        "minutes',estimate_minutes,"
        "'completed_estimate_minutes',completed_estimate_minutes,'remaining_"
        "minutes',remaining_minutes,"
        "'logged_minutes',logged_minutes,'captured_at',captured_at) item FROM "
        "sprint_snapshots WHERE sprint_id=?1 ORDER BY day))))");
    sqlite3_bind_int64(s, 1, id);
    return row(s);
  }
  if (!manager(r, c.board))
    return error_response(403, "È richiesto un amministratore della bacheca.");
  if (!remove && strcmp(c.state, "active"))
    return error_response(409, "La fotografia richiede uno sprint attivo.");
  if (remove) {
    if (r->body_len && !fields(r->body, "|"))
      return error_response(
          400, "La rimozione della fotografia non accetta campi aggiuntivi.");
    if (!day || !*day || !date_valid(day))
      return error_response(400, "Data della fotografia non valida.");
    s = prepare("DELETE FROM sprint_snapshots WHERE sprint_id=?1 AND day=?2");
    sqlite3_bind_int64(s, 1, id);
    bind_text(s, 2, day);
    if (!done(s))
      return unavailable();
    if (!sqlite3_changes(db))
      return error_response(404, "Fotografia non trovata.");
  } else {
    if (!fields(r->body, "|"))
      return error_response(400, "La fotografia usa la data UTC corrente e "
                                 "richiede un oggetto vuoto.");
    bool replace = scalar(
        "SELECT 1 FROM sprint_snapshots WHERE sprint_id=?1 AND day=date('now')",
        id);
    if (replace && !r->if_match[0])
      return error_response(409,
                            "Per sostituire la fotografia di oggi invia "
                            "If-Match con la versione corrente dello sprint.");
    if (!replace &&
        scalar("SELECT count(*) FROM sprint_snapshots WHERE sprint_id=?1",
               id) >= 366)
      return error_response(409,
                            "Limite di 366 fotografie per sprint raggiunto.");
    s = prepare(
        PROGRESS_CTE
        "INSERT INTO "
        "sprint_snapshots(sprint_id,day,total,completed,estimate_minutes,"
        "completed_estimate_minutes,remaining_minutes,logged_minutes) "
        "SELECT "
        "?1,date('now'),total,completed,estimate_minutes,completed_estimate_"
        "minutes,remaining_minutes,logged_minutes FROM progress WHERE true "
        "ON CONFLICT(sprint_id,day) DO UPDATE SET "
        "total=excluded.total,completed=excluded.completed,estimate_minutes="
        "excluded.estimate_minutes,"
        "completed_estimate_minutes=excluded.completed_estimate_minutes,"
        "remaining_minutes=excluded.remaining_minutes,logged_minutes=excluded."
        "logged_minutes,"
        "captured_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    sqlite3_bind_int64(s, 1, id);
    if (!done(s))
      return unavailable();
  }
  return event(r, id, c.board,
               remove ? "sprint_snapshot_deleted" : "sprint_snapshot_captured",
               0, day ? day : "UTC corrente", true)
             ? detail(r, id, c.board, 200)
             : unavailable();
}
static Response history(Request *r, int64_t id) {
  Context c;
  Response out;
  if (!context(r, id, true, false, &c, &out))
    return out;
  int64_t before, limit;
  if (!pagination(r, &before, &limit))
    return error_response(400, "Paginazione dello storico non valida.");
  sqlite3_stmt *s = prepare(
      "WITH page AS(SELECT * FROM sprint_events WHERE sprint_id=?1 AND id<?2 "
      "ORDER BY id DESC LIMIT ?3+1) "
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT json_object('id',id,'actor_id',actor_id,'actor',actor,"
      "'action',action,'subject_id',subject_id,'note',note,'created_at',"
      "created_at) item FROM page ORDER BY id DESC LIMIT ?3))),"
      "'next_cursor',CASE WHEN(SELECT count(*) FROM page)>?3 THEN(SELECT "
      "min(id) FROM(SELECT id FROM page ORDER BY id DESC LIMIT ?3)) ELSE NULL "
      "END)");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  return row(s);
}
#define CSV_TEXT(expr)                                                         \
  "char(34)||replace(CASE WHEN substr(ltrim(" expr                             \
  ",char(9)||char(10)||char(13)||' '),1,1)"                                    \
  "IN('=','+','-','@') THEN char(39)||" expr " ELSE " expr                     \
  " END,char(34),char(34)||char(34))||char(34)"
static Response export_plan(Request *r, int64_t id) {
  Context c;
  Response out;
  if (!context(r, id, false, false, &c, &out))
    return out;
  CardFilters f;
  if (!card_filters(r, &f))
    return error_response(400, "Filtri CSV non validi.");
  const char *format =
      "%s,records AS(SELECT * FROM eligible ORDER BY id DESC LIMIT 1001),"
      "lines AS(SELECT "
      "id||','||%s||','||%s||','||priority||','||completed||','||"
      "estimate_minutes||','||(actual_minutes+coalesce((SELECT sum(minutes) "
      "FROM worklogs WHERE card_id=records.id AND deleted_at IS "
      "NULL),0))||','||"
      "%s||','||due_date line FROM records ORDER BY id DESC) "
      "SELECT json_object('filename','sprint-'||?1||'.csv','csv',"
      "'id,title,column,priority,completed,estimate_minutes,logged_minutes,"
      "assignee,due_date'"
      "||char(13)||char(10)||coalesce((SELECT "
      "group_concat(line,char(13)||char(10)) "
      "FROM lines),''),'truncated',json('false'),'record_count',(SELECT "
      "count(*) FROM records))";
  char *sql = sqlite3_mprintf(format, CARD_CTE, CSV_TEXT("title"),
                              CSV_TEXT("column_title"), CSV_TEXT("assignee"));
  if (!sql)
    return unavailable();
  sqlite3_stmt *s = prepare(sql);
  sqlite3_free(sql);
  card_bind(s, r, &f, id, 0);
  out = row(s);
  if (out.status == 200) {
    int64_t count = 0;
    json_integer(out.body, "record_count", &count, 0, INT64_MAX, false);
    if (count > 1000 || strlen(out.body) > OB_BODY_LIMIT) {
      ob_free(out.body);
      return error_response(413, "Esportazione troppo grande: restringi i "
                                 "filtri (massimo 1000 schede e 2 MiB).");
    }
  }
  return out;
}
static bool path_scope(const char *path, const char *prefix, int64_t *id,
                       const char **tail) {
  size_t n = strlen(prefix);
  if (strncmp(path, prefix, n))
    return false;
  const char *p = path + n, *end = strchr(p, '/');
  size_t length = end ? (size_t)(end - p) : strlen(p);
  char number[32];
  if (!length || length >= sizeof number)
    return false;
  memcpy(number, p, length);
  number[length] = 0;
  *id = parse_id(number);
  *tail = end ? end : p + length;
  return *id > 0;
}
bool sprints_handle(Request *r, Response *out) {
  int64_t id = 0;
  const char *tail = NULL;
  bool board = path_scope(r->path, "/api/boards/", &id, &tail) &&
               (!strcmp(tail, "/sprints") || !strcmp(tail, "/backlog"));
  bool sprint = !strncmp(r->path, "/api/sprints/", 13);
  bool personal = !strcmp(r->path, "/api/me/sprint-tasks");
  if (!board && !sprint && !personal)
    return false;
  if (!r->user_id || !ob_config.auth_enabled) {
    *out = error_response(403, "Gli sprint richiedono un account autenticato.");
    return true;
  }
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  if (personal) {
    *out = get ? card_listing(r, 0, 2)
               : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (board) {
    *out = !strcmp(tail, "/backlog")
               ? (get ? card_listing(r, id, 1)
                      : error_response(405, "Metodo non consentito."))
           : get  ? list_sprints(r, id)
           : post ? create_or_edit(r, id, true)
                  : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!path_scope(r->path, "/api/sprints/", &id, &tail)) {
    *out = error_response(404, "Sprint non trovato.");
    return true;
  }
  *out = error_response(405, "Metodo non consentito.");
  if (!*tail) {
    if (get) {
      Context c;
      bool deleted;
      if (!flag(r, "include_deleted", &deleted)) {
        ob_free(out->body);
        *out = error_response(400, "Filtro include_deleted non valido.");
      } else {
        ob_free(out->body);
        if (context(r, id, deleted, false, &c, out))
          *out = detail(r, id, c.board, 200);
      }
    } else if (patch || del) {
      ob_free(out->body);
      *out = patch ? create_or_edit(r, id, false) : lifecycle(r, id, "delete");
    }
  } else if (!strcmp(tail, "/activate") || !strcmp(tail, "/close") ||
             !strcmp(tail, "/reopen") || !strcmp(tail, "/restore")) {
    if (post) {
      ob_free(out->body);
      *out = lifecycle(r, id, tail + 1);
    }
  } else if (!strcmp(tail, "/cards")) {
    if (get || post) {
      ob_free(out->body);
      *out = get ? card_listing(r, id, 0) : membership(r, id, 0, false, false);
    }
  } else if (!strcmp(tail, "/cards/bulk")) {
    if (post || del) {
      ob_free(out->body);
      *out = membership(r, id, 0, true, del);
    }
  } else if (!strncmp(tail, "/cards/", 7)) {
    int64_t card = parse_id(tail + 7);
    if (card && del) {
      ob_free(out->body);
      *out = membership(r, id, card, false, true);
    }
  } else if (!strcmp(tail, "/capacity")) {
    if (get) {
      ob_free(out->body);
      *out = capacity(r, id, 0, false);
    }
  } else if (!strncmp(tail, "/capacity/", 10)) {
    int64_t user = parse_id(tail + 10);
    if (user && patch) {
      ob_free(out->body);
      *out = capacity(r, id, user, true);
    }
  } else if (!strcmp(tail, "/snapshots")) {
    if (get || post) {
      ob_free(out->body);
      *out = snapshots(r, id, NULL, post, false);
    }
  } else if (!strncmp(tail, "/snapshots/", 11)) {
    if (del) {
      ob_free(out->body);
      *out = snapshots(r, id, tail + 11, true, true);
    }
  } else if (get) {
    ob_free(out->body);
    if (!strcmp(tail, "/progress") || !strcmp(tail, "/forecast"))
      *out = progress(r, id, !strcmp(tail, "/forecast"));
    else if (!strcmp(tail, "/capacity-report"))
      *out = capacity_report(r, id);
    else if (!strcmp(tail, "/history"))
      *out = history(r, id);
    else if (!strcmp(tail, "/export"))
      *out = export_plan(r, id);
    else
      *out = error_response(404, "Endpoint sprint non trovato.");
  }
  return true;
}
