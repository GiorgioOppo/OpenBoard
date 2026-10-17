/* OpenBoard review requests. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "reviews.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Additive, layout-neutral protection for existing schema-7 installations.
 * The guard is disabled together with all other triggers during cloud replay.
 * Ordering, workflow state and time logging do not change reviewed content. */
void reviews_install_content_guard(sqlite3 *connection) {
  const char *sql =
      "CREATE TRIGGER IF NOT EXISTS review_card_content_changed AFTER UPDATE OF "
      "title,description,checklist,custom_values,reference_url ON cards WHEN "
      "NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR "
      "NEW.checklist IS NOT OLD.checklist OR NEW.custom_values IS NOT OLD.custom_values OR "
      "NEW.reference_url IS NOT OLD.reference_url BEGIN "
      "INSERT INTO review_events(review_id,actor,action,note) "
      "SELECT r.id,'Sistema','review_content_changed',"
      "'Il contenuto della scheda è cambiato; è necessaria una nuova revisione.' "
      "FROM reviews r WHERE r.card_id=NEW.id AND EXISTS(SELECT 1 FROM review_votes v "
      "WHERE v.review_id=r.id) AND (SELECT count(*) FROM review_events e "
      "WHERE e.review_id=r.id)<10000;"
      "UPDATE reviews SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
      "WHERE card_id=NEW.id AND EXISTS(SELECT 1 FROM review_votes v WHERE v.review_id=reviews.id);"
      "DELETE FROM review_votes WHERE review_id IN(SELECT id FROM reviews WHERE card_id=NEW.id);END;";
  if (sqlite3_exec(connection, sql, NULL, NULL, NULL) != SQLITE_OK) {
    fputs("Review content protection unavailable.\n", stderr);
    exit(EXIT_FAILURE);
  }
}

void reviews_schema(sqlite3 *connection) {
  const char *schema[] = {
      "CREATE TABLE reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,card_id "
      "INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,requester_id "
      "INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,description "
      "TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',policy TEXT "
      "NOT NULL DEFAULT 'all' CHECK(policy IN('all','any')),version INTEGER "
      "NOT "
      "NULL DEFAULT 1,created_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:"
      "%fZ','now')),updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:"
      "%fZ','now')),cancelled_at TEXT,deleted_at TEXT);"
      "CREATE INDEX reviews_card ON reviews(card_id,id DESC);"
      "CREATE INDEX reviews_requester ON reviews(requester_id,id DESC);"
      "CREATE TABLE review_members(review_id INTEGER NOT NULL REFERENCES "
      "reviews(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES "
      "users(id),PRIMARY KEY(review_id,user_id));"
      "CREATE INDEX review_members_user ON review_members(user_id,review_id);"
      "CREATE TABLE review_votes(review_id INTEGER NOT NULL,user_id INTEGER "
      "NOT NULL,decision TEXT NOT NULL CHECK(decision IN('approved',"
      "'changes_requested')),note TEXT NOT NULL DEFAULT '',voted_at TEXT NOT "
      "NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY "
      "KEY(review_id,"
      "user_id),FOREIGN KEY(review_id,user_id) REFERENCES "
      "review_members(review_id,user_id) ON DELETE CASCADE);"
      "CREATE TABLE review_events(id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,"
      "actor_id INTEGER REFERENCES users(id),actor TEXT NOT NULL,subject_id "
      "INTEGER REFERENCES users(id),"
      "action TEXT NOT NULL,decision TEXT NOT NULL DEFAULT '',note TEXT NOT "
      "NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:"
      "%M:%fZ','now')));"
      "CREATE INDEX review_events_review ON review_events(review_id,id DESC);",
      /* Revocation invalidates stored votes, even if the user later returns. */
      "CREATE TRIGGER review_membership_removed AFTER DELETE ON board_members "
      "BEGIN UPDATE reviews SET version=version+1,updated_at="
      "strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(SELECT m.review_id "
      "FROM review_members m JOIN reviews r ON r.id=m.review_id JOIN cards k "
      "ON k.id=r.card_id JOIN columns c ON c.id=k.column_id WHERE "
      "m.user_id=OLD.user_id AND c.board_id=OLD.board_id);INSERT INTO "
      "review_events(review_id,actor,subject_id,action,note) SELECT "
      "m.review_id,"
      "'Sistema',OLD.user_id,'review_eligibility_changed','Membro rimosso "
      "dalla "
      "bacheca; i suoi voti sono invalidati.' FROM review_members m JOIN "
      "reviews "
      "r ON r.id=m.review_id JOIN cards k ON k.id=r.card_id JOIN columns c ON "
      "c.id=k.column_id WHERE m.user_id=OLD.user_id AND "
      "c.board_id=OLD.board_id "
      "AND (SELECT count(*) FROM review_events e WHERE e.review_id=m.review_id)"
      "<10000;DELETE FROM "
      "review_votes WHERE user_id=OLD.user_id AND review_id IN(SELECT r.id "
      "FROM reviews r JOIN cards k ON k.id=r.card_id JOIN columns c ON "
      "c.id=k.column_id WHERE c.board_id=OLD.board_id);END;"
      "CREATE TRIGGER review_membership_role AFTER UPDATE OF role ON "
      "board_members WHEN NEW.role<>OLD.role BEGIN UPDATE reviews SET "
      "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
      "WHERE id IN(SELECT m.review_id FROM review_members m JOIN reviews r "
      "ON r.id=m.review_id JOIN cards k ON k.id=r.card_id JOIN columns c ON "
      "c.id=k.column_id WHERE m.user_id=NEW.user_id AND "
      "c.board_id=NEW.board_id);INSERT INTO review_events(review_id,actor,"
      "subject_id,action,note) SELECT m.review_id,'Sistema',NEW.user_id,"
      "'review_eligibility_changed','Ruolo del membro modificato.' FROM "
      "review_members m JOIN reviews r ON r.id=m.review_id JOIN cards k ON "
      "k.id=r.card_id JOIN columns c ON c.id=k.column_id WHERE "
      "m.user_id=NEW.user_id AND c.board_id=NEW.board_id AND (SELECT count(*) "
      "FROM review_events e WHERE e.review_id=m.review_id)<10000;DELETE FROM "
      "review_votes WHERE "
      "user_id=NEW.user_id AND NEW.role='observer' AND review_id IN(SELECT "
      "r.id FROM reviews r JOIN cards k ON k.id=r.card_id JOIN columns c ON "
      "c.id=k.column_id WHERE c.board_id=NEW.board_id);END;"
      "CREATE TRIGGER review_user_eligibility AFTER UPDATE OF active,role ON "
      "users WHEN NEW.active<>OLD.active OR NEW.role<>OLD.role BEGIN UPDATE "
      "reviews SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',"
      "'now') WHERE id IN(SELECT review_id FROM review_members WHERE "
      "user_id=NEW.id);INSERT INTO review_events(review_id,actor,subject_id,"
      "action,note) SELECT review_id,'Sistema',NEW.id,"
      "'review_eligibility_changed','Stato o ruolo globale del revisore "
      "modificato.' FROM review_members m WHERE user_id=NEW.id AND (SELECT "
      "count(*) FROM review_events e WHERE e.review_id=m.review_id)<10000;"
      "DELETE FROM review_votes WHERE user_id=NEW.id AND "
      "(NEW.active=0 OR NEW.role='observer');END;",
      "CREATE VIEW review_eligibility AS SELECT m.review_id,m.user_id,"
      "CASE WHEN u.active=1 AND u.role<>'observer' AND bm.role IS NOT NULL AND "
      "bm.role<>'observer' AND m.user_id<>r.requester_id THEN 1 ELSE 0 END "
      "eligible FROM review_members m JOIN reviews r ON r.id=m.review_id "
      "JOIN cards k ON k.id=r.card_id JOIN columns c ON c.id=k.column_id "
      "JOIN users u ON u.id=m.user_id LEFT JOIN board_members bm ON "
      "bm.board_id=c.board_id AND bm.user_id=m.user_id;"
      "CREATE VIEW review_resolved AS SELECT a.*,CASE WHEN due_date<>'' AND "
      "due_date<date('now') AND status IN('pending','changes_requested') THEN "
      "1 ELSE 0 END overdue FROM(SELECT r.*,c.board_id,k.title card_title,"
      "u.name requester,(SELECT count(*) FROM review_members m WHERE "
      "m.review_id=r.id) reviewer_count,(SELECT count(*) FROM review_votes v "
      "JOIN review_eligibility e ON e.review_id=v.review_id AND e.user_id="
      "v.user_id WHERE v.review_id=r.id AND e.eligible=1 AND v.decision="
      "'approved') approved_count,(SELECT count(*) FROM review_votes v JOIN "
      "review_eligibility e ON e.review_id=v.review_id AND e.user_id=v.user_id "
      "WHERE v.review_id=r.id AND e.eligible=1 AND v.decision="
      "'changes_requested') changes_count,CASE WHEN r.cancelled_at IS NOT NULL "
      "THEN 'cancelled' WHEN EXISTS(SELECT 1 FROM review_votes v JOIN "
      "review_eligibility e ON e.review_id=v.review_id AND e.user_id=v.user_id "
      "WHERE v.review_id=r.id AND e.eligible=1 AND v.decision="
      "'changes_requested') THEN 'changes_requested' WHEN EXISTS(SELECT 1 FROM "
      "review_votes v JOIN review_eligibility e ON e.review_id=v.review_id AND "
      "e.user_id=v.user_id WHERE v.review_id=r.id AND e.eligible=1 AND "
      "v.decision='approved') AND(r.policy='any' OR (SELECT count(*) FROM "
      "review_votes v JOIN review_eligibility e ON e.review_id=v.review_id AND "
      "e.user_id=v.user_id WHERE v.review_id=r.id AND e.eligible=1 AND "
      "v.decision='approved')=(SELECT count(*) FROM review_members m WHERE "
      "m.review_id=r.id)) THEN 'approved' ELSE 'pending' END status FROM "
      "reviews r JOIN cards k ON k.id=r.card_id JOIN columns c ON "
      "c.id=k.column_id JOIN users u ON u.id=r.requester_id)a;"};
  for (size_t i = 0; i < sizeof schema / sizeof schema[0]; i++) {
    char *error = NULL;
    if (sqlite3_exec(connection, schema[i], NULL, NULL, &error) != SQLITE_OK) {
      fprintf(stderr, "Schema revisioni non disponibile: %s\n",
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
                           "Revisione non disponibile.");
  sqlite3_finalize(s);
  return out;
}
static int64_t card_board(int64_t card) {
  sqlite3_stmt *s = prepare("SELECT c.board_id FROM cards k JOIN columns c ON "
                            "c.id=k.column_id JOIN boards b ON b.id=c.board_id "
                            "WHERE k.id=?1 AND k.deleted_at IS NULL AND "
                            "c.deleted_at IS NULL AND b.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, card);
  int64_t board =
      sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
  sqlite3_finalize(s);
  return board;
}
static bool board_live(int64_t board) {
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, board);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool manager(Request *r, int64_t board, int64_t requester) {
  if (auth_is_admin(r) || r->user_id == requester)
    return true;
  sqlite3_stmt *s = prepare("SELECT 1 FROM board_members WHERE board_id=?1 AND "
                            "user_id=?2 AND role='admin'");
  sqlite3_bind_int64(s, 1, board);
  sqlite3_bind_int64(s, 2, r->user_id);
  bool ok = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return ok;
}
static bool nonblank(const char *value) {
  if (!value)
    return false;
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
  int year = (date[0] - '0') * 1000 + (date[1] - '0') * 100 +
             (date[2] - '0') * 10 + date[3] - '0';
  int month = (date[5] - '0') * 10 + date[6] - '0',
      day = (date[8] - '0') * 10 + date[9] - '0';
  static const int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return year >= 1900 && month >= 1 && month <= 12 && day >= 1 &&
         day <= days[month] + (month == 2 && year % 4 == 0 &&
                               (year % 100 != 0 || year % 400 == 0));
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
static Response conflict(int code) {
  return error_response(
      code, code == 412 ? "Versione non aggiornata. Ricarica la revisione."
                        : "If-Match deve contenere una versione positiva.");
}
static bool pagination(Request *r, int64_t *before, int64_t *limit) {
  char value[40];
  *before = INT64_MAX;
  *limit = 30;
  int n = ob_query(r, "before", value, sizeof value);
  if (n < 0 || (n && !(*before = parse_id(value))))
    return false;
  n = ob_query(r, "limit", value, sizeof value);
  return n >= 0 && (!n || ((*limit = parse_id(value)) && *limit <= 100));
}
static bool flag(Request *r, const char *key, bool *out) {
  char value[8];
  int n = ob_query(r, key, value, sizeof value);
  *out = false;
  if (n < 0)
    return false;
  if (!n)
    return true;
  if (strcmp(value, "0") && strcmp(value, "1"))
    return false;
  *out = !strcmp(value, "1");
  return true;
}
/* An absent membership never silently lowers the number of required votes. */
static bool reviewers_valid(const char *body, int64_t board, int64_t requester,
                            int64_t ids[20], int *count) {
  sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.reviewer_ids')");
  bind_text(s, 1, body);
  bool array = sqlite3_step(s) == SQLITE_ROW &&
               sqlite3_column_type(s, 0) != SQLITE_NULL &&
               !strcmp((const char *)sqlite3_column_text(s, 0), "array");
  sqlite3_finalize(s);
  if (!array)
    return false;
  s = prepare("SELECT value,type FROM json_each(?1,'$.reviewer_ids')");
  bind_text(s, 1, body);
  *count = 0;
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    int64_t id = sqlite3_column_int64(s, 0);
    if (*count >= 20 ||
        strcmp((const char *)sqlite3_column_text(s, 1), "integer") || id <= 0 ||
        id == requester) {
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
  if (rc != SQLITE_DONE || !*count)
    return false;
  for (int i = 0; i < *count; i++) {
    s = prepare("SELECT 1 FROM users u JOIN board_members m ON m.user_id=u.id "
                "WHERE u.id=?1 AND m.board_id=?2 AND u.active=1 AND "
                "u.role<>'observer' AND m.role<>'observer'");
    sqlite3_bind_int64(s, 1, ids[i]);
    sqlite3_bind_int64(s, 2, board);
    bool ok = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    if (!ok)
      return false;
  }
  return true;
}
static bool members_insert(int64_t id, const int64_t ids[20], int count) {
  for (int i = 0; i < count; i++) {
    sqlite3_stmt *s =
        prepare("INSERT INTO review_members(review_id,user_id) VALUES(?1,?2)");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, ids[i]);
    if (!done(s))
      return false;
  }
  return true;
}
static bool event(Request *r, int64_t id, int64_t card, int64_t board,
                  const char *action, const char *decision, const char *note) {
  sqlite3_stmt *s =
      prepare("INSERT INTO review_events(review_id,actor_id,actor,"
              "action,decision,note) SELECT ?1,?2,name,?3,?4,?5 FROM users "
              "WHERE id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, action);
  bind_text(s, 4, decision);
  bind_text(s, 5, note);
  if (!done(s))
    return false;
  s = prepare(
      "INSERT INTO activity(board_id,actor_id,actor,action,entity_type,"
      "entity_id,title) SELECT ?1,?2,u.name,?3,'cards',k.id,k.title FROM "
      "cards k JOIN users u ON u.id=?2 WHERE k.id=?4");
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
static bool room(int64_t card) {
  sqlite3_stmt *s = prepare("SELECT count(*) FROM reviews WHERE card_id=?1");
  sqlite3_bind_int64(s, 1, card);
  bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int64(s, 0) < 200;
  sqlite3_finalize(s);
  return ok;
}
#define REVIEW_JSON                                                            \
  "json_object('id',r.id,'card_id',r.card_id,'board_id',r.board_id,'card_"     \
  "title',r.card_title,"                                                       \
  "'requester_id',r.requester_id,'requester',r.requester,'title',r.title,'"    \
  "description',r.description,"                                                \
  "'due_date',r.due_date,'policy',r.policy,'status',r.status,'version',r."     \
  "version,"                                                                   \
  "'created_at',r.created_at,'updated_at',r.updated_at,'cancelled_at',r."      \
  "cancelled_at,"                                                              \
  "'deleted_at',r.deleted_at,'overdue',json(CASE WHEN r.overdue THEN 'true' "  \
  "ELSE 'false' END),"                                                         \
  "'reviewer_count',r.reviewer_count,'approved_count',r.approved_count,'"      \
  "changes_count',r.changes_count,"                                            \
  "'can_manage',json(CASE WHEN (?9 OR r.requester_id=?8 OR EXISTS(SELECT 1 "   \
  "FROM board_members bm "                                                     \
  "WHERE bm.board_id=r.board_id AND bm.user_id=?8 AND bm.role='admin')) AND "  \
  "?10 AND (?9 OR EXISTS(SELECT 1 FROM board_members bm WHERE "                \
  "bm.board_id=r.board_id AND bm.user_id=?8 AND bm.role<>'observer')) "        \
  "THEN 'true' ELSE 'false' END),"                                             \
  "'can_vote',json(CASE WHEN r.deleted_at IS NULL AND r.cancelled_at IS NULL " \
  "AND EXISTS(SELECT 1 FROM "                                                  \
  "review_eligibility e WHERE e.review_id=r.id AND e.user_id=?8 AND "          \
  "e.eligible=1) THEN 'true' ELSE 'false' END),"                               \
  "'reviewers',json((SELECT json_group_array(json(item)) FROM(SELECT "         \
  "json_object('user_id',u.id,"                                                \
  "'name',u.name,'username',u.username,'eligible',json(CASE WHEN e.eligible "  \
  "THEN 'true' ELSE 'false' END),"                                             \
  "'decision',v.decision,'note',coalesce(v.note,''),'voted_at',v.voted_at)"    \
  "item FROM review_members m "                                                \
  "JOIN users u ON u.id=m.user_id JOIN review_eligibility e ON "               \
  "e.review_id=m.review_id AND e.user_id=m.user_id "                           \
  "LEFT JOIN review_votes v ON v.review_id=m.review_id AND "                   \
  "v.user_id=m.user_id WHERE m.review_id=r.id ORDER BY u.id))))"
static void actor_bind(sqlite3_stmt *s, Request *r, bool write) {
  sqlite3_bind_int64(s, 8, r->user_id);
  sqlite3_bind_int(s, 9, auth_is_admin(r));
  sqlite3_bind_int(s, 10, write);
}
static Response detail(Request *r, int64_t id, int status, int64_t board) {
  sqlite3_stmt *s =
      prepare("SELECT " REVIEW_JSON " FROM review_resolved r WHERE r.id=?1");
  sqlite3_bind_int64(s, 1, id);
  actor_bind(s, r, auth_board_allowed(r, board, true));
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static Response create(Request *r, int64_t card) {
  int64_t board = card_board(card);
  if (!board || !auth_board_allowed(r, board, true))
    return error_response(404, "Scheda non trovata.");
  char *title = NULL, *description = NULL, *due = NULL, *policy = NULL;
  int64_t ids[20];
  int count;
  int a = json_string(r->body, "title", &title, 200),
      b = json_string(r->body, "description", &description, 4000),
      c = json_string(r->body, "due_date", &due, 10),
      d = json_string(r->body, "policy", &policy, 8);
  Response out;
  if (a != 1 || !nonblank(title) || b < 0 || c < 0 || !date_valid(due) ||
      d < 0 || (policy && strcmp(policy, "all") && strcmp(policy, "any")) ||
      !reviewers_valid(r->body, board, r->user_id, ids, &count)) {
    out = error_response(
        400, "Titolo, data, policy o revisori non validi. Seleziona da 1 a 20 "
             "membri scriventi diversi dal richiedente.");
    goto cleanup;
  }
  if (!room(card)) {
    out = error_response(409, "Limite di 200 revisioni per scheda raggiunto.");
    goto cleanup;
  }
  sqlite3_stmt *s = prepare("INSERT INTO "
                            "reviews(card_id,requester_id,title,description,"
                            "due_date,policy) VALUES(?1,?2,?3,?4,?5,?6)");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, title);
  bind_text(s, 4, description);
  bind_text(s, 5, due);
  bind_text(s, 6, policy ? policy : "all");
  bool ok = done(s);
  int64_t id = sqlite3_last_insert_rowid(db);
  if (!ok || !members_insert(id, ids, count) ||
      !event(r, id, card, board, "review_created", "", ""))
    out = unavailable();
  else
    out = detail(r, id, 201, board);
cleanup:
  ob_free(title);
  ob_free(description);
  ob_free(due);
  ob_free(policy);
  return out;
}

typedef struct {
  int64_t card, board, requester, version;
  bool deleted, cancelled;
} Context;
static bool context(Request *r, int64_t id, bool deleted, bool write,
                    Context *c, Response *out) {
  sqlite3_stmt *s =
      prepare("SELECT card_id,requester_id,version,deleted_at IS NOT "
              "NULL,cancelled_at IS NOT NULL FROM reviews WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    *out = error_response(404, "Revisione non trovata.");
    return false;
  }
  c->card = sqlite3_column_int64(s, 0);
  c->requester = sqlite3_column_int64(s, 1);
  c->version = sqlite3_column_int64(s, 2);
  c->deleted = sqlite3_column_int(s, 3);
  c->cancelled = sqlite3_column_int(s, 4);
  sqlite3_finalize(s);
  c->board = card_board(c->card);
  if (!c->board || (!deleted && c->deleted) ||
      !auth_board_allowed(r, c->board, write)) {
    *out = error_response(404, "Revisione non trovata.");
    return false;
  }
  if (write) {
    int match = matched(r, c->version);
    if (match) {
      *out = conflict(match);
      return false;
    }
    s = prepare("SELECT count(*) FROM review_events WHERE review_id=?1");
    sqlite3_bind_int64(s, 1, id);
    bool full =
        sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int64(s, 0) >= 10000;
    sqlite3_finalize(s);
    if (full) {
      *out =
          error_response(409, "Limite dello storico di revisione raggiunto.");
      return false;
    }
  }
  return true;
}
static bool bump(int64_t id) {
  sqlite3_stmt *s = prepare("UPDATE reviews SET "
                            "version=version+1,updated_at=strftime('%Y-%m-%dT%"
                            "H:%M:%fZ','now') WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  return done(s);
}
static Response modify(Request *r, int64_t id, const char *operation) {
  Context c;
  Response out;
  bool restore = !strcmp(operation, "restore"), get = !strcmp(operation, "get");
  bool include = false;
  if (get && !flag(r, "include_deleted", &include))
    return error_response(400, "Filtro include_deleted non valido.");
  if (!context(r, id, restore || include, !get, &c, &out))
    return out;
  if (get)
    return detail(r, id, 200, c.board);
  if (!manager(r, c.board, c.requester))
    return error_response(
        403, "Solo richiedente e amministratori possono gestire la revisione.");
  const char *action = NULL;
  sqlite3_stmt *s = NULL;
  if (!strcmp(operation, "edit")) {
    char *title = NULL, *description = NULL, *due = NULL, *policy = NULL;
    int a = json_string(r->body, "title", &title, 200),
        b = json_string(r->body, "description", &description, 4000),
        d = json_string(r->body, "due_date", &due, 10),
        p = json_string(r->body, "policy", &policy, 8);
    if (a < 0 || (title && !nonblank(title)) || b < 0 || d < 0 ||
        !date_valid(due) || p < 0 ||
        (policy && strcmp(policy, "all") && strcmp(policy, "any")) ||
        !(a || b || d || p)) {
      out = error_response(400, "Dettagli di revisione non validi.");
      goto edit_cleanup;
    }
    if (policy) {
      s = prepare("DELETE FROM review_votes WHERE review_id=?1 AND "
                  "EXISTS(SELECT 1 FROM reviews WHERE id=?1 AND policy<>?2)");
      sqlite3_bind_int64(s, 1, id);
      bind_text(s, 2, policy);
      if (!done(s)) {
        out = unavailable();
        goto edit_cleanup;
      }
    }
    s = prepare(
        "UPDATE reviews SET "
        "title=coalesce(?2,title),description=coalesce(?3,description),due_"
        "date=coalesce(?4,due_date),policy=coalesce(?5,policy) WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (title)
      bind_text(s, 2, title);
    if (description)
      bind_text(s, 3, description);
    if (due)
      bind_text(s, 4, due);
    if (policy)
      bind_text(s, 5, policy);
    if (!done(s) || !bump(id) ||
        !event(r, id, c.card, c.board, "review_edited", "", ""))
      out = unavailable();
    else
      out = detail(r, id, 200, c.board);
  edit_cleanup:
    ob_free(title);
    ob_free(description);
    ob_free(due);
    ob_free(policy);
    return out;
  }
  if (!strcmp(operation, "reviewers")) {
    int64_t ids[20];
    int count;
    if (!reviewers_valid(r->body, c.board, c.requester, ids, &count))
      return error_response(400, "Seleziona da 1 a 20 revisori attivi "
                                 "scriventi diversi dal richiedente.");
    s = prepare("DELETE FROM review_members WHERE review_id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (!done(s) || !members_insert(id, ids, count) || !bump(id) ||
        !event(r, id, c.card, c.board, "review_reviewers_changed", "", ""))
      return unavailable();
    return detail(r, id, 200, c.board);
  }
  if (!strcmp(operation, "delete")) {
    s = prepare("UPDATE reviews SET "
                "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1");
    action = "review_deleted";
  } else if (restore) {
    if (!c.deleted)
      return error_response(409, "La revisione è già attiva.");
    s = prepare("UPDATE reviews SET deleted_at=NULL WHERE id=?1");
    action = "review_restored";
  } else if (!strcmp(operation, "cancel")) {
    if (c.cancelled)
      return error_response(409, "La revisione è già annullata.");
    s = prepare(
        "UPDATE reviews SET cancelled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
        "WHERE id=?1");
    action = "review_cancelled";
  } else if (!strcmp(operation, "reopen")) {
    s = prepare("DELETE FROM review_votes WHERE review_id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (!done(s))
      return unavailable();
    s = prepare("UPDATE reviews SET cancelled_at=NULL WHERE id=?1");
    action = "review_reopened";
  }
  if (!s)
    return error_response(405, "Metodo non consentito.");
  sqlite3_bind_int64(s, 1, id);
  if (!done(s) || !bump(id) || !event(r, id, c.card, c.board, action, "", ""))
    return unavailable();
  return detail(r, id, 200, c.board);
}
static Response vote(Request *r, int64_t id, bool withdraw) {
  Context c;
  Response out;
  if (!context(r, id, false, true, &c, &out))
    return out;
  if (c.cancelled)
    return error_response(409, "Riapri la revisione prima di votare.");
  sqlite3_stmt *s = prepare("SELECT 1 FROM review_eligibility WHERE "
                            "review_id=?1 AND user_id=?2 AND eligible=1");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  bool eligible = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  if (!eligible)
    return error_response(403, "Puoi votare soltanto come revisore attivo "
                               "della richiesta di un altro utente.");
  char *decision = NULL, *note = NULL;
  if (!withdraw) {
    int a = json_string(r->body, "decision", &decision, 32),
        b = json_string(r->body, "note", &note, 2000);
    if (a != 1 || b < 0 ||
        (strcmp(decision, "approved") &&
         strcmp(decision, "changes_requested")) ||
        (!strcmp(decision, "changes_requested") && !nonblank(note))) {
      out = error_response(400, "Indica approved oppure changes_requested; per "
                                "richiedere modifiche serve una nota.");
      goto cleanup;
    }
    s = prepare(
        "INSERT INTO review_votes(review_id,user_id,decision,note) "
        "VALUES(?1,?2,?3,?4) ON CONFLICT(review_id,user_id) DO UPDATE SET "
        "decision=excluded.decision,note=excluded.note,voted_at=strftime('%Y-%"
        "m-%dT%H:%M:%fZ','now')");
    bind_text(s, 3, decision);
    bind_text(s, 4, note);
  } else
    s = prepare("DELETE FROM review_votes WHERE review_id=?1 AND user_id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  if (!done(s)) {
    out = unavailable();
    goto cleanup;
  }
  if (withdraw && sqlite3_changes(db) == 0) {
    out = error_response(409, "Nessun voto da ritirare.");
    goto cleanup;
  }
  if (!bump(id) || !event(r, id, c.card, c.board,
                          withdraw ? "review_vote_withdrawn" : "review_voted",
                          decision, note))
    out = unavailable();
  else
    out = detail(r, id, 200, c.board);
cleanup:
  ob_free(decision);
  ob_free(note);
  return out;
}
static Response history(Request *r, int64_t id) {
  Context c;
  Response out;
  if (!context(r, id, true, false, &c, &out))
    return out;
  int64_t before, limit;
  if (!pagination(r, &before, &limit))
    return error_response(400, "Paginazione non valida.");
  sqlite3_stmt *s = prepare(
      "WITH page AS(SELECT * FROM review_events WHERE review_id=?1 AND id<?2 "
      "ORDER BY id DESC LIMIT ?3+1) SELECT json_object('items',json((SELECT "
      "json_group_array(json(item)) FROM(SELECT "
      "json_object('id',id,'review_id',review_id,'actor_id',actor_id,'actor',"
      "actor,'subject_id',subject_id,'action',action,'decision',decision,'note'"
      ",note,'created_at',"
      "created_at)item FROM page ORDER BY id DESC LIMIT "
      "?3))),'next_cursor',CASE WHEN(SELECT count(*) FROM page)>?3 THEN(SELECT "
      "min(id) FROM(SELECT id FROM page ORDER BY id DESC LIMIT ?3))ELSE NULL "
      "END)");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, before);
  sqlite3_bind_int64(s, 3, limit);
  return row(s);
}
static Response duplicate(Request *r, int64_t id) {
  Context c;
  Response out;
  if (!context(r, id, false, true, &c, &out))
    return out;
  if (!manager(r, c.board, c.requester))
    return error_response(
        403,
        "Solo richiedente e amministratori possono duplicare la revisione.");
  int64_t card;
  if (json_integer(r->body, "card_id", &card, 1, INT64_MAX, false) != 1)
    return error_response(400, "Indica una scheda di destinazione.");
  if (card_board(card) != c.board || !auth_board_allowed(r, c.board, true))
    return error_response(404,
                          "Scheda di destinazione non trovata nella bacheca.");
  if (!room(card))
    return error_response(409, "Limite di revisioni per scheda raggiunto.");
  int64_t ids[20];
  int count = 0;
  sqlite3_stmt *s =
      prepare("SELECT user_id FROM review_eligibility WHERE review_id=?1 AND "
              "eligible=1 AND user_id<>?2 ORDER BY user_id");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  int rc;
  while ((rc = sqlite3_step(s)) == SQLITE_ROW && count < 20)
    ids[count++] = sqlite3_column_int64(s, 0);
  sqlite3_finalize(s);
  if (rc != SQLITE_DONE || !count)
    return error_response(409, "La copia richiede almeno un revisore attivo "
                               "diverso dal nuovo richiedente.");
  s = prepare(
      "INSERT INTO "
      "reviews(card_id,requester_id,title,description,due_date,policy) SELECT "
      "?2,?3,title,description,due_date,policy FROM reviews WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, card);
  sqlite3_bind_int64(s, 3, r->user_id);
  bool ok = done(s);
  int64_t copy = sqlite3_last_insert_rowid(db);
  if (!ok || !members_insert(copy, ids, count) ||
      !event(r, copy, card, c.board, "review_duplicated", "", ""))
    return unavailable();
  return detail(r, copy, 201, c.board);
}

typedef struct {
  int64_t before, limit, reviewer, requester;
  bool deleted, overdue;
  char status[32];
} Filters;
static bool filters(Request *r, Filters *f) {
  memset(f, 0, sizeof *f);
  if (!pagination(r, &f->before, &f->limit) ||
      !flag(r, "include_deleted", &f->deleted) ||
      !flag(r, "overdue", &f->overdue))
    return false;
  int n = ob_query(r, "status", f->status, sizeof f->status);
  if (n < 0 ||
      (n && strcmp(f->status, "pending") && strcmp(f->status, "approved") &&
       strcmp(f->status, "changes_requested") &&
       strcmp(f->status, "cancelled")))
    return false;
  char value[40];
  n = ob_query(r, "reviewer_id", value, sizeof value);
  if (n < 0 || (n && !(f->reviewer = parse_id(value))))
    return false;
  n = ob_query(r, "requester_id", value, sizeof value);
  return n >= 0 && (!n || (f->requester = parse_id(value)));
}
#define FILTER_SQL                                                             \
  "r.id<?2 AND (?4 OR r.deleted_at IS NULL) AND (?5='' OR r.status=?5) AND "   \
  "(NOT ?6 OR r.overdue=1) AND (?7=0 OR EXISTS(SELECT 1 FROM review_members "  \
  "m WHERE "                                                                   \
  "m.review_id=r.id AND m.user_id=?7)) AND (?11=0 OR r.requester_id=?11) AND " \
  "k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL "    \
  "AND "                                                                       \
  "(?9 OR EXISTS(SELECT 1 FROM board_members bm WHERE bm.board_id=r.board_id " \
  "AND bm.user_id=?8))"
static void filter_bind(sqlite3_stmt *s, Request *r, const Filters *f,
                        int64_t scope, bool personal) {
  sqlite3_bind_int64(s, 1, scope);
  sqlite3_bind_int64(s, 2, f->before);
  sqlite3_bind_int64(s, 3, f->limit);
  sqlite3_bind_int(s, 4, f->deleted);
  bind_text(s, 5, f->status);
  sqlite3_bind_int(s, 6, f->overdue);
  sqlite3_bind_int64(s, 7, f->reviewer);
  actor_bind(s, r, strcmp(r->role, "observer") != 0);
  sqlite3_bind_int64(s, 11, f->requester);
  sqlite3_bind_int(s, 12, personal);
}
#define REVIEW_JOIN                                                            \
  " FROM review_resolved r JOIN cards k ON k.id=r.card_id JOIN columns c ON "  \
  "c.id=k.column_id JOIN boards b ON b.id=c.board_id "
#define SCOPE_SQL                                                              \
  "((NOT ?12 AND r.board_id=?1) OR (?12 AND EXISTS(SELECT 1 FROM "             \
  "review_members m WHERE m.review_id=r.id AND m.user_id=?8)))"
static Response listing(Request *r, int64_t scope, bool personal, bool card) {
  if (!personal) {
    int64_t board = card ? card_board(scope) : scope;
    if (!board || !board_live(board) || !auth_board_allowed(r, board, false))
      return error_response(404, "Risorsa non trovata.");
  }
  Filters f;
  if (!filters(r, &f))
    return error_response(400, "Filtri o paginazione non validi.");
  const char *sql_card =
      "WITH page AS(SELECT r.*" REVIEW_JOIN "WHERE r.card_id=?1 AND " FILTER_SQL
      " ORDER BY r.id DESC LIMIT ?3+1) SELECT json_object('items',json((SELECT "
      "json_group_array(json(item)) FROM(SELECT " REVIEW_JSON
      " item FROM page r ORDER BY r.id DESC LIMIT ?3))),'next_cursor',CASE "
      "WHEN(SELECT count(*) FROM page)>?3 THEN(SELECT min(id) FROM(SELECT id "
      "FROM page ORDER BY id DESC LIMIT ?3))ELSE NULL END)";
  const char *sql_board =
      "WITH page AS(SELECT r.*" REVIEW_JOIN "WHERE " SCOPE_SQL
      " AND " FILTER_SQL
      " ORDER BY r.id DESC LIMIT ?3+1) SELECT json_object('items',json((SELECT "
      "json_group_array(json(item)) FROM(SELECT " REVIEW_JSON
      " item FROM page r ORDER BY r.id DESC LIMIT ?3))),'next_cursor',CASE "
      "WHEN(SELECT count(*) FROM page)>?3 THEN(SELECT min(id) FROM(SELECT id "
      "FROM page ORDER BY id DESC LIMIT ?3))ELSE NULL END)";
  sqlite3_stmt *s = prepare(card ? sql_card : sql_board);
  filter_bind(s, r, &f, scope, personal);
  return row(s);
}
static Response stats(Request *r, int64_t scope, bool card) {
  int64_t board = card ? card_board(scope) : scope;
  if (!board || !board_live(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Risorsa non trovata.");
  sqlite3_stmt *s =
      prepare("SELECT "
              "json_object('total',count(*),'pending',coalesce(sum(r.status='"
              "pending'),0),'approved',coalesce(sum(r.status='approved'),0),'"
              "changes_requested',coalesce(sum(r.status='changes_requested'),0)"
              ",'cancelled',coalesce(sum(r.status='cancelled'),0),'overdue',"
              "coalesce(sum(r.overdue),0))" REVIEW_JOIN
              "WHERE ((?2 AND r.card_id=?1) OR (NOT ?2 AND r.board_id=?1)) AND "
              "r.deleted_at IS NULL AND k.deleted_at IS NULL AND c.deleted_at "
              "IS NULL AND b.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, scope);
  sqlite3_bind_int(s, 2, card);
  return row(s);
}
#define CSV_TEXT(expr)                                                         \
  "char(34)||replace(CASE WHEN substr(ltrim(" expr                             \
  ",char(9)||char(10)||char(13)||' '),1,1)IN('=','+','-','@')THEN "            \
  "char(39)||" expr " ELSE " expr                                              \
  " END,char(34),char(34)||char(34))||char(34)"
static Response export_reviews(Request *r, int64_t board) {
  if (!board_live(board) || !auth_board_allowed(r, board, false))
    return error_response(404, "Bacheca non trovata.");
  Filters f;
  if (!filters(r, &f))
    return error_response(400, "Filtri non validi.");
  f.before = INT64_MAX;
  f.limit = 1000;
  sqlite3_stmt *s = prepare(
      "WITH records AS(SELECT r.*" REVIEW_JOIN
      "WHERE r.board_id=?1 AND " FILTER_SQL
      " ORDER BY r.id DESC LIMIT 1001),lines AS(SELECT "
      "id||','||card_id||','||" CSV_TEXT("card_title") "||','||" CSV_TEXT(
          "titl"
          "e") "||','||" CSV_TEXT("description") "||','||" CSV_TEXT("reques"
                                                                    "ter") "||'"
                                                                           ",'|"
                                                                           "|st"
                                                                           "atu"
                                                                           "s||"
                                                                           "','"
                                                                           "||"
                                                                           "pol"
                                                                           "icy"
                                                                           "||'"
                                                                           ",'|"
                                                                           "|du"
                                                                           "e_"
                                                                           "dat"
                                                                           "e||"
                                                                           "','"
                                                                           "||"
                                                                           "rev"
                                                                           "iew"
                                                                           "er_"
                                                                           "cou"
                                                                           "nt|"
                                                                           "|',"
                                                                           "'||"
                                                                           "app"
                                                                           "rov"
                                                                           "ed_"
                                                                           "cou"
                                                                           "nt|"
                                                                           "|',"
                                                                           "'||"
                                                                           "cha"
                                                                           "nge"
                                                                           "s_"
                                                                           "cou"
                                                                           "nt "
                                                                           "lin"
                                                                           "e "
                                                                           "FRO"
                                                                           "M "
                                                                           "rec"
                                                                           "ord"
                                                                           "s "
                                                                           "ORD"
                                                                           "ER "
                                                                           "BY "
                                                                           "id "
                                                                           "DES"
                                                                           "C) "
                                                                           "SEL"
                                                                           "ECT"
                                                                           " "
                                                                           "jso"
                                                                           "n_"
                                                                           "obj"
                                                                           "ect"
                                                                           "('"
                                                                           "fil"
                                                                           "ena"
                                                                           "me'"
                                                                           ",'"
                                                                           "rev"
                                                                           "isi"
                                                                           "oni"
                                                                           "-"
                                                                           "bac"
                                                                           "hec"
                                                                           "a-'"
                                                                           "||?"
                                                                           "1||"
                                                                           "'."
                                                                           "csv"
                                                                           "'"
                                                                           ",'"
                                                                           "tru"
                                                                           "nca"
                                                                           "ted"
                                                                           "',("
                                                                           "SEL"
                                                                           "ECT"
                                                                           " "
                                                                           "cou"
                                                                           "nt("
                                                                           "*) "
                                                                           "FRO"
                                                                           "M "
                                                                           "rec"
                                                                           "ord"
                                                                           "s)>"
                                                                           "100"
                                                                           "0,'"
                                                                           "csv"
                                                                           "','"
                                                                           "id,"
                                                                           "car"
                                                                           "d_"
                                                                           "id,"
                                                                           "car"
                                                                           "d_"
                                                                           "tit"
                                                                           "le,"
                                                                           "tit"
                                                                           "le,"
                                                                           "des"
                                                                           "cri"
                                                                           "pti"
                                                                           "on,"
                                                                           "req"
                                                                           "ues"
                                                                           "ter"
                                                                           ",st"
                                                                           "atu"
                                                                           "s,"
                                                                           "pol"
                                                                           "icy"
                                                                           ",du"
                                                                           "e_"
                                                                           "dat"
                                                                           "e,"
                                                                           "rev"
                                                                           "iew"
                                                                           "er_"
                                                                           "cou"
                                                                           "nt,"
                                                                           "app"
                                                                           "rov"
                                                                           "ed_"
                                                                           "cou"
                                                                           "nt,"
                                                                           "cha"
                                                                           "nge"
                                                                           "s_"
                                                                           "cou"
                                                                           "nt'"
                                                                           "||"
                                                                           "cha"
                                                                           "r("
                                                                           "13)"
                                                                           "||"
                                                                           "cha"
                                                                           "r("
                                                                           "10)"
                                                                           "||"
                                                                           "coa"
                                                                           "les"
                                                                           "ce("
                                                                           "(SE"
                                                                           "LEC"
                                                                           "T "
                                                                           "gro"
                                                                           "up_"
                                                                           "con"
                                                                           "cat"
                                                                           "(li"
                                                                           "ne,"
                                                                           "cha"
                                                                           "r("
                                                                           "13)"
                                                                           "||"
                                                                           "cha"
                                                                           "r("
                                                                           "10)"
                                                                           ") "
                                                                           "FRO"
                                                                           "M "
                                                                           "lin"
                                                                           "es)"
                                                                           ",''"
                                                                           ")||"
                                                                           "cha"
                                                                           "r("
                                                                           "13)"
                                                                           "|"
                                                                           "|ch"
                                                                           "ar("
                                                                           "10)"
                                                                           ")");
  filter_bind(s, r, &f, board, false);
  Response out = row(s);
  if (out.status != 200)
    return out;
  s = prepare("SELECT json_extract(?1,'$.truncated')");
  bind_text(s, 1, out.body);
  bool truncated = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  if (truncated || strlen(out.body) > 2097152) {
    ob_free(out.body);
    return error_response(413, "Esportazione troppo grande. Riduci i filtri.");
  }
  snprintf(out.headers, sizeof out.headers, "Cache-Control: no-store\r\n");
  return out;
}
bool reviews_handle(Request *r, Response *out) {
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  char path[1024];
  snprintf(path, sizeof path, "%s", r->path);
  if (strstr(path, "//") || !path[0] || path[strlen(path) - 1] == '/')
    return false;
  char *parts[6] = {0}, *state = NULL;
  size_t n = 0;
  for (char *p = strtok_r(path, "/", &state); p && n < 6;
       p = strtok_r(NULL, "/", &state))
    parts[n++] = p;
  if (n < 3 || strcmp(parts[0], "api"))
    return false;
  bool personal =
      n == 3 && !strcmp(parts[1], "me") && !strcmp(parts[2], "reviews");
  int64_t id = personal ? 0 : parse_id(parts[2]);
  bool cards =
      id && n == 4 && !strcmp(parts[1], "cards") &&
      (!strcmp(parts[3], "reviews") || !strcmp(parts[3], "review-summary"));
  bool boards =
      id && n == 4 && !strcmp(parts[1], "boards") &&
      (!strcmp(parts[3], "reviews") || !strcmp(parts[3], "review-stats") ||
       !strcmp(parts[3], "review-export"));
  bool review =
      id && !strcmp(parts[1], "reviews") &&
      (n == 3 ||
       (n == 4 &&
        (!strcmp(parts[3], "reviewers") || !strcmp(parts[3], "vote") ||
         !strcmp(parts[3], "cancel") || !strcmp(parts[3], "reopen") ||
         !strcmp(parts[3], "restore") || !strcmp(parts[3], "history") ||
         !strcmp(parts[3], "duplicate"))));
  if (!personal && !cards && !boards && !review)
    return false;
  if (!ob_config.auth_enabled || !r->user_id) {
    *out = error_response(403, "Le revisioni richiedono account autenticati.");
    return true;
  }
  *out = error_response(405, "Metodo non consentito.");
  if (personal && get) {
    *out = listing(r, 0, true, false);
    return true;
  }
  if (cards) {
    if (!strcmp(parts[3], "reviews") && (get || post))
      *out = post ? create(r, id) : listing(r, id, false, true);
    else if (!strcmp(parts[3], "review-summary") && get)
      *out = stats(r, id, true);
  } else if (boards && get) {
    *out = !strcmp(parts[3], "reviews")        ? listing(r, id, false, false)
           : !strcmp(parts[3], "review-stats") ? stats(r, id, false)
                                               : export_reviews(r, id);
  } else if (review) {
    if (n == 3 && (get || patch || del))
      *out = modify(r, id, get ? "get" : patch ? "edit" : "delete");
    else if (n == 4) {
      if (!strcmp(parts[3], "history") && get)
        *out = history(r, id);
      else if (!strcmp(parts[3], "vote") && (post || del))
        *out = vote(r, id, del);
      else if (!strcmp(parts[3], "duplicate") && post)
        *out = duplicate(r, id);
      else if ((!strcmp(parts[3], "reviewers") && patch) ||
               (post &&
                (!strcmp(parts[3], "cancel") || !strcmp(parts[3], "reopen") ||
                 !strcmp(parts[3], "restore"))))
        *out = modify(r, id, parts[3]);
    }
  }
  return true;
}
