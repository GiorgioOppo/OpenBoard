/* OpenBoard time tracking and team discussion tools. SPDX-License-Identifier:
 * MIT */
#define _POSIX_C_SOURCE 200809L
#include "teamwork.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void teamwork_schema(sqlite3 *connection) {
  const char *schema =
      "CREATE TABLE worklogs(id INTEGER PRIMARY KEY AUTOINCREMENT,card_id "
      "INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,user_id INTEGER "
      "NOT NULL DEFAULT 0,author TEXT NOT NULL,date TEXT NOT NULL,minutes "
      "INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1000000),note TEXT NOT "
      "NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT "
      "NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT "
      "NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),deleted_at TEXT);"
      "CREATE INDEX worklogs_card ON worklogs(card_id,id DESC);"
      "CREATE INDEX worklogs_date ON worklogs(date,user_id) WHERE deleted_at "
      "IS NULL;"
      "ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES "
      "comments(id) ON DELETE SET NULL;"
      "ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 "
      "CHECK(pinned IN(0,1));"
      "CREATE INDEX comments_parent ON comments(parent_id,id);"
      "CREATE TABLE comment_reactions(comment_id INTEGER NOT NULL REFERENCES "
      "comments(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES "
      "users(id) ON DELETE CASCADE,reaction TEXT NOT NULL CHECK(reaction "
      "IN('like','heart','celebrate','eyes','question','done')),created_at "
      "TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY "
      "KEY(comment_id,user_id,reaction));"
      "CREATE TABLE card_bookmarks(user_id INTEGER NOT NULL REFERENCES "
      "users(id) ON DELETE CASCADE,card_id INTEGER NOT NULL REFERENCES "
      "cards(id) ON DELETE CASCADE,created_at TEXT NOT NULL "
      "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY "
      "KEY(user_id,card_id));";
  char *error = NULL;
  if (sqlite3_exec(connection, schema, NULL, NULL, &error) != SQLITE_OK) {
    fprintf(stderr, "Schema strumenti team non disponibile: %s\n",
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
static Response row(sqlite3_stmt *s) {
  int rc = sqlite3_step(s);
  Response out =
      rc == SQLITE_ROW
          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
          : error_response(rc == SQLITE_DONE ? 404 : 503,
                           rc == SQLITE_DONE
                               ? "Risorsa non trovata."
                               : "Database temporaneamente non disponibile.");
  sqlite3_finalize(s);
  return out;
}
static Response unavailable(void) {
  return error_response(503, "Salvataggio temporaneamente non disponibile.");
}
static bool personal(Request *r, Response *out) {
  if (ob_config.auth_enabled && r->user_id)
    return true;
  *out = error_response(403,
                        "Questa funzione richiede account e avvio con --auth.");
  return false;
}
static int64_t card_board(int64_t card) {
  sqlite3_stmt *s = prepare(
      "SELECT c.board_id FROM cards k JOIN columns c ON c.id=k.column_id JOIN "
      "boards b ON b.id=c.board_id WHERE k.id=?1 AND k.deleted_at IS NULL AND "
      "c.deleted_at IS NULL AND b.deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, card);
  int64_t id = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
  sqlite3_finalize(s);
  return id;
}
static bool card_allowed(Request *r, int64_t card, bool write, int64_t *board) {
  *board = card_board(card);
  return *board && auth_board_allowed(r, *board, write);
}
static bool board_allowed(Request *r, int64_t board) {
  sqlite3_stmt *s =
      prepare("SELECT 1 FROM boards WHERE id=?1 AND deleted_at IS NULL");
  sqlite3_bind_int64(s, 1, board);
  bool live = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return live && auth_board_allowed(r, board, false);
}
static bool event(Request *r, int64_t card, int64_t board, const char *action) {
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
static bool date_valid(const char *date) {
  if (!date || strlen(date) != 10 || date[4] != '-' || date[7] != '-')
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
static bool flag_query(Request *r, const char *key, bool *out) {
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
static Response match_error(int status) {
  return error_response(
      status, status == 412
                  ? "Versione non aggiornata. Ricarica prima di riprovare."
                  : "If-Match deve contenere una versione positiva.");
}
#define WORKLOG_JSON                                                           \
  "json_object('id',w.id,'card_id',w.card_id,'user_id',w.user_id,'author',w."  \
  "author,'date',w.date,'minutes',w.minutes,'note',w.note,'version',w."        \
  "version,'created_at',w.created_at,'updated_at',w.updated_at,'deleted_at',"  \
  "w.deleted_at)"
static Response worklog_response(int64_t id, int status) {
  sqlite3_stmt *s =
      prepare("SELECT " WORKLOG_JSON " FROM worklogs w WHERE w.id=?1");
  sqlite3_bind_int64(s, 1, id);
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
}
static Response worklogs(Request *r, int64_t card, bool post) {
  int64_t board;
  if (!card_allowed(r, card, post, &board))
    return error_response(404, "Scheda non trovata.");
  if (!post) {
    int64_t before, limit;
    bool deleted;
    if (!pagination(r, &before, &limit) ||
        !flag_query(r, "include_deleted", &deleted))
      return error_response(400, "Paginazione non valida.");
    sqlite3_stmt *s = prepare(
        "WITH page AS(SELECT w.* FROM worklogs w WHERE w.card_id=?1 AND "
        "w.id<?2 AND (?4 OR w.deleted_at IS NULL) ORDER BY w.id DESC LIMIT "
        "?3+1) SELECT json_object('items',json((SELECT "
        "json_group_array(json(item)) FROM(SELECT " WORKLOG_JSON
        " item FROM page w ORDER BY w.id DESC LIMIT ?3))),'next_cursor',CASE "
        "WHEN(SELECT count(*) FROM page)>?3 THEN(SELECT min(id) FROM(SELECT id "
        "FROM page ORDER BY id DESC LIMIT ?3))ELSE NULL END)");
    sqlite3_bind_int64(s, 1, card);
    sqlite3_bind_int64(s, 2, before);
    sqlite3_bind_int64(s, 3, limit);
    sqlite3_bind_int(s, 4, deleted);
    return row(s);
  }
  int64_t minutes;
  char *date = NULL, *note = NULL;
  int a = json_string(r->body, "date", &date, 10),
      b = json_string(r->body, "note", &note, 2000);
  if (a != 1 || !date_valid(date) || b < 0 ||
      json_integer(r->body, "minutes", &minutes, 1, 1000000, false) != 1) {
    ob_free(date);
    ob_free(note);
    return error_response(400, "Indica minuti da 1 a 1000000, una data valida "
                               "e una nota fino a 2000 caratteri.");
  }
  sqlite3_stmt *s = prepare("SELECT count(*) FROM worklogs WHERE card_id=?1");
  sqlite3_bind_int64(s, 1, card);
  bool full =
      sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int64(s, 0) >= 10000;
  sqlite3_finalize(s);
  if (full) {
    ob_free(date);
    ob_free(note);
    return error_response(
        409, "Limite di 10000 registrazioni per scheda raggiunto.");
  }
  s = prepare("INSERT INTO worklogs(card_id,user_id,author,date,minutes,note) "
              "VALUES(?1,?2,coalesce((SELECT name FROM users WHERE "
              "id=?2),'Locale'),?3,?4,?5)");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, r->user_id);
  bind_text(s, 3, date);
  sqlite3_bind_int64(s, 4, minutes);
  bind_text(s, 5, note ? note : "");
  bool ok = done(s);
  ob_free(date);
  ob_free(note);
  int64_t id = sqlite3_last_insert_rowid(db);
  if (!ok || !event(r, card, board, "time_logged"))
    return unavailable();
  return worklog_response(id, 201);
}
static Response modify_worklog(Request *r, int64_t id, bool remove,
                               bool restore) {
  sqlite3_stmt *s = prepare(
      "SELECT card_id,user_id,version,deleted_at FROM worklogs WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    return error_response(404, "Registrazione non trovata.");
  }
  int64_t card = sqlite3_column_int64(s, 0), owner = sqlite3_column_int64(s, 1),
          version = sqlite3_column_int64(s, 2);
  bool deleted = sqlite3_column_type(s, 3) != SQLITE_NULL;
  sqlite3_finalize(s);
  int64_t board;
  if (!card_allowed(r, card, true, &board) || (!restore && deleted))
    return error_response(404, "Registrazione non trovata.");
  if (owner != r->user_id && !auth_is_admin(r))
    return error_response(403, "Puoi modificare solo le tue registrazioni.");
  int match = matched(r, version);
  if (match)
    return match_error(match);
  if (restore && !deleted)
    return worklog_response(id, 200);
  if (remove || restore) {
    s = prepare(
        restore
            ? "UPDATE worklogs SET "
              "deleted_at=NULL,version=version+1,updated_at=strftime('%Y-%m-%"
              "dT%H:%M:%fZ','now')WHERE id=?1"
            : "UPDATE worklogs SET "
              "deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+"
              "1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    if (!done(s) ||
        !event(r, card, board, restore ? "time_restored" : "time_deleted"))
      return unavailable();
    return worklog_response(id, 200);
  }
  char *date = NULL, *note = NULL;
  int64_t minutes = 0;
  int a = json_string(r->body, "date", &date, 10),
      b = json_string(r->body, "note", &note, 2000),
      c = json_integer(r->body, "minutes", &minutes, 1, 1000000, false);
  if (a < 0 || b < 0 || c < 0 || (!a && !b && !c) || (a && !date_valid(date))) {
    ob_free(date);
    ob_free(note);
    return error_response(400, "Minuti, data o nota non validi.");
  }
  s = prepare(
      "UPDATE worklogs SET date=CASE WHEN ?2 THEN ?3 ELSE date END,note=CASE "
      "WHEN ?4 THEN ?5 ELSE note END,minutes=CASE WHEN ?6 THEN ?7 ELSE minutes "
      "END,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
      "WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int(s, 2, a);
  bind_text(s, 3, date ? date : "");
  sqlite3_bind_int(s, 4, b);
  bind_text(s, 5, note ? note : "");
  sqlite3_bind_int(s, 6, c);
  sqlite3_bind_int64(s, 7, minutes);
  bool ok = done(s);
  ob_free(date);
  ob_free(note);
  if (!ok || !event(r, card, board, "time_edited"))
    return unavailable();
  return worklog_response(id, 200);
}
static Response time_summary(Request *r, int64_t card) {
  int64_t board;
  if (!card_allowed(r, card, false, &board))
    return error_response(404, "Scheda non trovata.");
  return query_json(
      "SELECT "
      "json_object('manual_minutes',actual_minutes,'logged_minutes',coalesce(("
      "SELECT sum(minutes)FROM worklogs WHERE card_id=?1 AND deleted_at IS "
      "NULL),0),'total_minutes',actual_minutes+coalesce((SELECT "
      "sum(minutes)FROM worklogs WHERE card_id=?1 AND deleted_at IS NULL),0)) "
      "FROM cards WHERE id=?1",
      card);
}
#define TIME_ROWS                                                              \
  "json_object('id',w.id,'card_id',w.card_id,'user_id',w.user_id,'author',w."  \
  "author,'date',w.date,'minutes',w.minutes,'note',w.note,'version',w."        \
  "version,'created_at',w.created_at,'updated_at',w.updated_at,'deleted_at',"  \
  "w.deleted_at,'card_title',w.card_title,'board_id',w.board_id,'board_name'," \
  "w.board_name)"
static Response time_report(Request *r, int64_t board, bool own) {
  char from[11] = "", to[11] = "", week[11] = "", value[40];
  int64_t user = 0;
  if (!own && !board_allowed(r, board))
    return error_response(404, "Bacheca non trovata.");
  if (own) {
    int n = ob_query(r, "week", week, sizeof week);
    if (n < 0 || (n && !date_valid(week)))
      return error_response(400, "Settimana non valida.");
    sqlite3_stmt *s =
        prepare("SELECT "
                "date(coalesce(nullif(?1,''),date('now')),'-'||((cast(strftime("
                "'%w',coalesce(nullif(?1,''),date('now')))AS INTEGER)+6)%7)||' "
                "days'),date(coalesce(nullif(?1,''),date('now')),'-'||((cast("
                "strftime('%w',coalesce(nullif(?1,''),date('now')))AS "
                "INTEGER)+6)%7)||' days','+6 days')");
    bind_text(s, 1, week);
    if (sqlite3_step(s) == SQLITE_ROW &&
        sqlite3_column_type(s, 0) != SQLITE_NULL &&
        sqlite3_column_type(s, 1) != SQLITE_NULL) {
      snprintf(from, sizeof from, "%s", sqlite3_column_text(s, 0));
      snprintf(to, sizeof to, "%s", sqlite3_column_text(s, 1));
    }
    sqlite3_finalize(s);
    user = r->user_id;
  } else {
    int a = ob_query(r, "from", from, sizeof from),
        b = ob_query(r, "to", to, sizeof to),
        c = ob_query(r, "user_id", value, sizeof value);
    if (a < 0 || b < 0 || c < 0 || (a && !date_valid(from)) ||
        (b && !date_valid(to)) || (c && !(user = parse_id(value))))
      return error_response(400, "Intervallo o utente non valido.");
    if (!a || !b) {
      sqlite3_stmt *s =
          prepare("SELECT date('now','start of month'),date('now','start of "
                  "month','+1 month','-1 day')");
      if (sqlite3_step(s) == SQLITE_ROW) {
        if (!a)
          snprintf(from, sizeof from, "%s", sqlite3_column_text(s, 0));
        if (!b)
          snprintf(to, sizeof to, "%s", sqlite3_column_text(s, 1));
      }
      sqlite3_finalize(s);
    }
  }
  if (!date_valid(from) || !date_valid(to))
    return error_response(400, "Intervallo di date non valido.");
  sqlite3_stmt *s = prepare("SELECT julianday(?2)-julianday(?1)");
  bind_text(s, 1, from);
  bind_text(s, 2, to);
  bool valid = sqlite3_step(s) == SQLITE_ROW &&
               sqlite3_column_double(s, 0) >= 0 &&
               sqlite3_column_double(s, 0) <= 365;
  sqlite3_finalize(s);
  if (!valid)
    return error_response(
        400,
        "L'intervallo deve essere ordinato e durare al massimo 366 giorni.");
  s = prepare(
      "WITH eligible AS(SELECT w.*,k.title card_title,b.id board_id,b.name "
      "board_name FROM worklogs w JOIN cards k ON k.id=w.card_id JOIN columns "
      "c ON c.id=k.column_id JOIN boards b ON b.id=c.board_id WHERE "
      "w.deleted_at IS NULL AND k.deleted_at IS NULL AND c.deleted_at IS NULL "
      "AND b.deleted_at IS NULL AND (?1=0 OR b.id=?1) AND (?2=0 OR "
      "w.user_id=?2) AND w.date BETWEEN ?3 AND ?4 AND (?5 OR EXISTS(SELECT 1 "
      "FROM board_members m WHERE m.board_id=b.id AND m.user_id=?6))) SELECT "
      "json_object('from',?3,'to',?4,'week_start',?3,'week_end',?4,'rows',json("
      "(SELECT json_group_array(json(item))FROM(SELECT " TIME_ROWS
      " item FROM eligible w ORDER BY w.date,w.id LIMIT "
      "10000))),'truncated',json(CASE WHEN(SELECT count(*)FROM eligible)>10000 "
      "THEN 'true' ELSE 'false'END),'by_user',json((SELECT "
      "json_group_array(json(item))FROM(SELECT "
      "json_object('user_id',user_id,'author',max(author),'minutes',sum("
      "minutes))item FROM eligible GROUP BY user_id ORDER BY "
      "user_id))),'daily',json((SELECT json_group_array(json(item))FROM(SELECT "
      "json_object('date',date,'minutes',sum(minutes))item FROM eligible GROUP "
      "BY date ORDER BY "
      "date))),'totals',json_object('logged_minutes',coalesce((SELECT "
      "sum(minutes)FROM eligible),0),'entries',(SELECT count(*)FROM "
      "eligible)),'total_minutes',coalesce((SELECT sum(minutes)FROM "
      "eligible),0))");
  sqlite3_bind_int64(s, 1, own ? 0 : board);
  sqlite3_bind_int64(s, 2, user);
  bind_text(s, 3, from);
  bind_text(s, 4, to);
  sqlite3_bind_int(s, 5, !ob_config.auth_enabled || auth_is_admin(r));
  sqlite3_bind_int64(s, 6, r->user_id);
  return row(s);
}
/* Quote every text cell; neutralize spreadsheet formula prefixes, including
 * whitespace before a formula. Export reports are bounded independently of HTTP
 * request size. */
#define CSV_TEXT(expr)                                                         \
  "char(34)||replace(CASE WHEN substr(ltrim(" expr                             \
  ",char(9)||char(10)||char(13)||' '),1,1)IN('=','+','-','@')THEN "            \
  "char(39)||" expr " ELSE " expr                                              \
  " END,char(34),char(34)||char(34))||char(34)"
static Response time_export(Request *r, int64_t board) {
  Response report = time_report(r, board, false);
  if (report.status != 200)
    return report;
  if (strlen(report.body) > 2097152) {
    ob_free(report.body);
    return error_response(413,
                          "Esportazione troppo grande. Riduci l'intervallo.");
  }
  sqlite3_stmt *s = prepare("SELECT json_extract(?1,'$.truncated')");
  bind_text(s, 1, report.body);
  bool truncated = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  if (truncated) {
    ob_free(report.body);
    return error_response(413, "Esportazione incompleta. Riduci l'intervallo.");
  }
  s = prepare(
      "WITH records AS(SELECT "
      "json_extract(value,'$.date')date,json_extract(value,'$.card_id')"
      "card_id,json_extract(value,'$.card_title')title,json_extract(value,'"
      "$.user_id')user_id,json_extract(value,'$.author')author,json_"
      "extract(value,'$.minutes')minutes,json_extract(value,'$.note')note "
      "FROM json_each(?1,'$.rows')),lines AS(SELECT "
      "date||','||card_id||','||" CSV_TEXT(
          "title") "||','||user_id||','|"
                   "|" CSV_TEXT("author") "||','||minutes||','||" CSV_TEXT(
                       "note") "line FROM "
                               "records)"
                               "SELECT "
                               "json_"
                               "object('"
                               "filename',"
                               "'tempo-"
                               "bacheca-'|"
                               "|?2||'."
                               "csv','csv'"
                               ",'date,"
                               "card_id,"
                               "card_"
                               "title,"
                               "user_id,"
                               "author,"
                               "minutes,"
                               "note'||"
                               "char(13)||"
                               "char(10)||"
                               "coalesce(("
                               "SELECT "
                               "group_"
                               "concat("
                               "line,char("
                               "13)||char("
                               "10))FROM "
                               "lines),'')"
                               "||char(13)"
                               "||char(10)"
                               ")");
  bind_text(s, 1, report.body);
  sqlite3_bind_int64(s, 2, board);
  Response out = row(s);
  ob_free(report.body);
  snprintf(out.headers, sizeof out.headers, "Cache-Control: no-store\r\n");
  return out;
}

#define REACTIONS_JSON                                                         \
  "(SELECT json_group_array(json(item))FROM(SELECT "                           \
  "json_object('reaction',reaction,'count',count(*),'mine',json(CASE WHEN "    \
  "sum(user_id=?2)>0 THEN 'true' ELSE 'false'END))item FROM "                  \
  "comment_reactions WHERE comment_id=c.id GROUP BY reaction ORDER BY "        \
  "reaction))"
#define COMMENT_JSON                                                           \
  "json_object('id',c.id,'card_id',c.card_id,'author_id',c.author_id,'author'" \
  ",c.author,'body',c.body,'created_at',c.created_at,'version',c.version,'"    \
  "edited_at',c.edited_at,'parent_id',c.parent_id,'pinned',json(CASE WHEN "    \
  "c.pinned THEN 'true'ELSE 'false'END),'reactions',json(" REACTIONS_JSON "))"
static int64_t comment_card(int64_t id) {
  sqlite3_stmt *s = prepare("SELECT card_id FROM comments WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  int64_t card = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
  sqlite3_finalize(s);
  return card;
}
static Response comments(Request *r, int64_t card, bool pinned) {
  int64_t board;
  if (!card_allowed(r, card, false, &board))
    return error_response(404, "Scheda non trovata.");
  sqlite3_stmt *s =
      prepare("SELECT json_object('comments',json((SELECT "
              "json_group_array(json(item))FROM(SELECT " COMMENT_JSON
              " item FROM comments c WHERE c.card_id=?1 AND (?3=0 OR "
              "c.pinned=1)ORDER BY c.id))))");
  sqlite3_bind_int64(s, 1, card);
  sqlite3_bind_int64(s, 2, r->user_id);
  sqlite3_bind_int(s, 3, pinned);
  return row(s);
}
static bool reaction_valid(const char *reaction) {
  static const char *allowed[] = {"like", "heart",    "celebrate",
                                  "eyes", "question", "done"};
  for (size_t i = 0; i < sizeof allowed / sizeof *allowed; i++)
    if (!strcmp(reaction, allowed[i]))
      return true;
  return false;
}
static Response reactions(Request *r, int64_t id, bool get, bool remove) {
  int64_t card = comment_card(id), board;
  if (!card || !card_allowed(r, card, false, &board))
    return error_response(404, "Commento non trovato.");
  if (!get) {
    char *reaction = NULL;
    if (json_string(r->body, "reaction", &reaction, 16) != 1 ||
        !reaction_valid(reaction)) {
      ob_free(reaction);
      return error_response(400, "Reazione non valida.");
    }
    sqlite3_stmt *s = prepare(
        remove
            ? "DELETE FROM comment_reactions WHERE comment_id=?1 AND "
              "user_id=?2 AND reaction=?3"
            : "INSERT OR IGNORE INTO "
              "comment_reactions(comment_id,user_id,reaction)VALUES(?1,?2,?3)");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, r->user_id);
    bind_text(s, 3, reaction);
    bool ok = done(s);
    ob_free(reaction);
    if (!ok)
      return unavailable();
    if (sqlite3_changes(db) &&
        !event(r, card, board, remove ? "reaction_removed" : "reacted"))
      return unavailable();
  }
  sqlite3_stmt *s = prepare("SELECT json_object('items',json(" REACTIONS_JSON
                            "))FROM comments c WHERE c.id=?1");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  return row(s);
}
static Response pin(Request *r, int64_t id) {
  int64_t card = comment_card(id), board;
  if (!card || !card_allowed(r, card, true, &board))
    return error_response(404, "Commento non trovato.");
  int64_t pinned;
  if (json_integer(r->body, "pinned", &pinned, 0, 1, true) != 1)
    return error_response(400, "Il campo pinned deve essere booleano.");
  sqlite3_stmt *s = prepare("SELECT version,pinned FROM comments WHERE id=?1");
  sqlite3_bind_int64(s, 1, id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    return error_response(404, "Commento non trovato.");
  }
  int64_t version = sqlite3_column_int64(s, 0);
  bool same = sqlite3_column_int64(s, 1) == pinned;
  sqlite3_finalize(s);
  int match = matched(r, version);
  if (match)
    return match_error(match);
  if (!same) {
    s = prepare("UPDATE comments SET pinned=?2,version=version+1 WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, pinned);
    if (!done(s) ||
        !event(r, card, board, pinned ? "comment_pinned" : "comment_unpinned"))
      return unavailable();
  }
  s = prepare("SELECT " COMMENT_JSON " FROM comments c WHERE c.id=?1");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  return row(s);
}
static Response thread(Request *r, int64_t id, bool post) {
  int64_t card = comment_card(id), board;
  if (!card || !card_allowed(r, card, post, &board))
    return error_response(404, "Commento non trovato.");
  if (post) {
    char *body = NULL;
    if (json_string(r->body, "body", &body, 5000) != 1) {
      ob_free(body);
      return error_response(
          400, "La risposta deve contenere da 1 a 5000 caratteri.");
    }
    bool nonspace = false;
    for (const unsigned char *p = (unsigned char *)body; *p; p++)
      if (!isspace(*p)) {
        nonspace = true;
        break;
      }
    if (!nonspace) {
      ob_free(body);
      return error_response(400, "La risposta non può essere vuota.");
    } /* One-level threads keep replies visible when their original parent is
         removed. */
    sqlite3_stmt *s =
        prepare("SELECT coalesce(parent_id,id) FROM comments WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    int64_t parent =
        sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : id;
    sqlite3_finalize(s);
    s = prepare(
        "INSERT INTO "
        "comments(card_id,author_id,author,body,parent_id)VALUES(?1,?2,"
        "coalesce((SELECT name FROM users WHERE id=?2),'Locale'),?3,?4)");
    sqlite3_bind_int64(s, 1, card);
    sqlite3_bind_int64(s, 2, r->user_id);
    bind_text(s, 3, body);
    sqlite3_bind_int64(s, 4, parent);
    bool ok = done(s);
    ob_free(body);
    int64_t reply = sqlite3_last_insert_rowid(db);
    if (!ok || !event(r, card, board, "comment_replied"))
      return unavailable();
    char json[128];
    snprintf(json, sizeof json, "{\"ok\":true,\"id\":%lld,\"version\":1}",
             (long long)reply);
    return json_response(201, json);
  }
  sqlite3_stmt *s = prepare(
      "WITH root AS(SELECT coalesce(parent_id,id)id FROM comments WHERE "
      "id=?1)SELECT json_object('parent',json((SELECT " COMMENT_JSON
      " FROM comments c WHERE c.id=(SELECT id FROM "
      "root))),'replies',json((SELECT "
      "json_group_array(json(item))FROM(SELECT " COMMENT_JSON
      " item FROM comments c WHERE c.parent_id=(SELECT id FROM root)ORDER BY "
      "c.id))))");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  return row(s);
}
static Response bookmark(Request *r, int64_t card, bool get) {
  int64_t board;
  if (!card_allowed(r, card, false, &board))
    return error_response(404, "Scheda non trovata.");
  if (get) {
    sqlite3_stmt *s =
        prepare("SELECT json_object('id',?1,'bookmarked',json(CASE WHEN "
                "EXISTS(SELECT 1 FROM card_bookmarks WHERE card_id=?1 AND "
                "user_id=?2)THEN 'true'ELSE 'false'END))");
    sqlite3_bind_int64(s, 1, card);
    sqlite3_bind_int64(s, 2, r->user_id);
    return row(s);
  }
  int64_t marked;
  if (json_integer(r->body, "bookmarked", &marked, 0, 1, true) != 1)
    return error_response(400, "Il campo bookmarked deve essere booleano.");
  sqlite3_stmt *s = prepare(
      marked
          ? "INSERT OR IGNORE INTO card_bookmarks(user_id,card_id)VALUES(?1,?2)"
          : "DELETE FROM card_bookmarks WHERE user_id=?1 AND card_id=?2");
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int64(s, 2, card);
  if (!done(s))
    return unavailable();
  char json[100];
  snprintf(json, sizeof json, "{\"ok\":true,\"id\":%lld,\"bookmarked\":%s}",
           (long long)card, marked ? "true" : "false");
  return json_response(200, json);
}
static Response bookmarks(Request *r) {
  int64_t before, limit;
  if (!pagination(r, &before, &limit))
    return error_response(400, "Paginazione non valida.");
  sqlite3_stmt *s = prepare(
      "WITH eligible AS(SELECT k.id,k.title,k.column_id,c.title "
      "column_name,b.id board_id,b.name board_name,x.created_at FROM "
      "card_bookmarks x JOIN cards k ON k.id=x.card_id JOIN columns c ON "
      "c.id=k.column_id JOIN boards b ON b.id=c.board_id WHERE x.user_id=?1 "
      "AND k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS "
      "NULL AND (?2 OR EXISTS(SELECT 1 FROM board_members m WHERE m.user_id=?1 "
      "AND m.board_id=b.id))),page AS(SELECT * FROM eligible WHERE id<?3 ORDER "
      "BY id DESC LIMIT ?4+1)SELECT json_object('items',json((SELECT "
      "json_group_array(json(item))FROM(SELECT "
      "json_object('id',id,'card_id',id,'title',title,'column_id',column_id,'"
      "column_name',column_name,'board_id',board_id,'board_name',board_name,'"
      "created_at',created_at)item FROM page ORDER BY id DESC LIMIT "
      "?4))),'next_cursor',CASE WHEN(SELECT count(*)FROM page)>?4 THEN(SELECT "
      "min(id)FROM(SELECT id FROM page ORDER BY id DESC LIMIT ?4))ELSE NULL "
      "END)");
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int(s, 2, auth_is_admin(r));
  sqlite3_bind_int64(s, 3, before);
  sqlite3_bind_int64(s, 4, limit);
  return row(s);
}
static Response notifications_filtered(Request *r) {
  int64_t before, limit;
  bool unread;
  char q[801] = "";
  int found = ob_query(r, "q", q, sizeof q);
  if (!pagination(r, &before, &limit) || !flag_query(r, "unread", &unread) ||
      found < 0 || !valid_utf8(q, strlen(q)))
    return error_response(400, "Filtri notifiche non validi.");
  size_t chars = 0;
  for (const unsigned char *p = (unsigned char *)q; *p; p++)
    if ((*p & 0xc0) != 0x80)
      chars++;
  if (chars > 200)
    return error_response(400, "La ricerca ammette al massimo 200 caratteri.");
  sqlite3_stmt *s = prepare(
      "WITH visible AS(SELECT "
      "n.id,n.read_at,json_object('id',n.id,'activity_id',a.id,'board_id',a."
      "board_id,'actor',a.actor,'actor_id',a.actor_id,'action',a.action,'"
      "entity_type',a.entity_type,'entity_id',a.entity_id,'title',a.title,'"
      "created_at',a.created_at,'read',json(CASE WHEN n.read_at IS NULL THEN "
      "'false'ELSE'true'END))item,a.title||' '||a.actor||' '||a.action "
      "haystack FROM notifications n JOIN activity a ON a.id=n.activity_id "
      "JOIN boards b ON b.id=a.board_id WHERE n.user_id=?1 AND b.deleted_at IS "
      "NULL AND (?2 OR EXISTS(SELECT 1 FROM board_members m WHERE m.user_id=?1 "
      "AND m.board_id=b.id))),eligible AS(SELECT * FROM visible WHERE (?5=0 OR "
      "read_at IS NULL)AND (?6=''OR instr(lower(haystack),lower(?6))>0)),page "
      "AS(SELECT * FROM eligible WHERE id<?3 ORDER BY id DESC LIMIT "
      "?4+1)SELECT json_object('items',json((SELECT "
      "json_group_array(json(item))FROM(SELECT item FROM page ORDER BY id DESC "
      "LIMIT ?4))),'next_cursor',CASE WHEN(SELECT count(*)FROM page)>?4 "
      "THEN(SELECT min(id)FROM(SELECT id FROM page ORDER BY id DESC LIMIT "
      "?4))ELSE NULL END,'unread_count',(SELECT count(*)FROM visible WHERE "
      "read_at IS NULL),'filtered_count',(SELECT count(*)FROM eligible))");
  sqlite3_bind_int64(s, 1, r->user_id);
  sqlite3_bind_int(s, 2, auth_is_admin(r));
  sqlite3_bind_int64(s, 3, before);
  sqlite3_bind_int64(s, 4, limit);
  sqlite3_bind_int(s, 5, unread);
  bind_text(s, 6, q);
  Response out = row(s);
  snprintf(out.headers, sizeof out.headers, "Cache-Control: no-store\r\n");
  return out;
}

bool teamwork_handle(Request *r, Response *out) {
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  if (!strcmp(r->path, "/api/me/time-report") ||
      !strcmp(r->path, "/api/me/bookmarks") ||
      !strcmp(r->path, "/api/notifications-filtered")) {
    if (!personal(r, out))
      return true;
    *out = !get ? error_response(405, "Metodo non consentito.")
           : !strcmp(r->path, "/api/me/time-report") ? time_report(r, 0, true)
           : !strcmp(r->path, "/api/me/bookmarks")   ? bookmarks(r)
                                                   : notifications_filtered(r);
    return true;
  }
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
  int64_t id = parse_id(parts[2]);
  if (!id)
    return false;
  if (!strcmp(parts[1], "cards") && n == 4) {
    if (!strcmp(parts[3], "worklogs")) {
      *out = (get || post) ? worklogs(r, id, post)
                           : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "time-summary")) {
      *out = get ? time_summary(r, id)
                 : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "comments") && get) {
      *out = comments(r, id, false);
      return true;
    }
    if (!strcmp(parts[3], "pinned-comments")) {
      *out = get ? comments(r, id, true)
                 : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "bookmark")) {
      if (!personal(r, out))
        return true;
      *out = (patch || get) ? bookmark(r, id, get)
                            : error_response(405, "Metodo non consentito.");
      return true;
    }
  }
  if (!strcmp(parts[1], "boards") && n == 4 &&
      (!strcmp(parts[3], "time-report") || !strcmp(parts[3], "time-export"))) {
    *out = get ? (!strcmp(parts[3], "time-export") ? time_export(r, id)
                                                   : time_report(r, id, false))
               : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(parts[1], "worklogs") &&
      (n == 3 || (n == 4 && !strcmp(parts[3], "restore")))) {
    *out = (n == 3 && (patch || del)) || (n == 4 && post)
               ? modify_worklog(r, id, del, n == 4)
               : error_response(405, "Metodo non consentito.");
    return true;
  }
  if (!strcmp(parts[1], "comments") && n == 4) {
    if (!strcmp(parts[3], "reactions")) {
      if (!personal(r, out))
        return true;
      *out = (get || post || del)
                 ? reactions(r, id, get, del)
                 : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "pin")) {
      *out = patch ? pin(r, id) : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "replies")) {
      *out = post ? thread(r, id, true)
                  : error_response(405, "Metodo non consentito.");
      return true;
    }
    if (!strcmp(parts[3], "thread")) {
      *out = get ? thread(r, id, false)
                 : error_response(405, "Metodo non consentito.");
      return true;
    }
  }
  return false;
}
