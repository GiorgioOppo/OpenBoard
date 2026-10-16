/* Authorized cross-board reporting. SPDX-License-Identifier: MIT */
#include "portfolio.h"
#include "auth.h"
#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void portfolio_schema(sqlite3 *connection) {
  const char *schema =
      "CREATE TABLE saved_reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id "
      "INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT "
      "NULL,filters TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(filters) AND "
      "json_type(filters)='object'),pinned INTEGER NOT NULL DEFAULT 0 "
      "CHECK(pinned IN(0,1)),version INTEGER NOT NULL DEFAULT 1,created_at "
      "TEXT "
      "NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT "
      "NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));CREATE INDEX "
      "reports_owner ON saved_reports(user_id,pinned DESC,id DESC);";
  char *error = NULL;
  if (sqlite3_exec(connection, schema, NULL, NULL, &error) != SQLITE_OK) {
    fprintf(stderr, "Schema portfolio non disponibile: %s\n",
            error ? error : sqlite3_errmsg(connection));
    sqlite3_free(error);
    exit(EXIT_FAILURE);
  }
}
typedef struct {
  char q[801], status[24], priority[16], label[101], from[11], to[11];
  int64_t assignee, board, before, limit;
  bool archived;
} Filters;
static Response row(sqlite3_stmt *s) {
  int rc = sqlite3_step(s);
  Response out =
      rc == SQLITE_ROW
          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
          : error_response(rc == SQLITE_DONE ? 404 : 503,
                           rc == SQLITE_DONE ? "Report non trovato."
                                             : "Archivio non disponibile.");
  sqlite3_finalize(s);
  return out;
}
static bool done(sqlite3_stmt *s) {
  bool ok = sqlite3_step(s) == SQLITE_DONE;
  sqlite3_finalize(s);
  return ok;
}
static bool date_valid(const char *date) {
  if (strlen(date) != 10 || date[4] != '-' || date[7] != '-')
    return false;
  for (int i = 0; i < 10; i++)
    if (i != 4 && i != 7 && !isdigit((unsigned char)date[i]))
      return false;
  int y = (date[0] - '0') * 1000 + (date[1] - '0') * 100 +
          (date[2] - '0') * 10 + date[3] - '0';
  int m = (date[5] - '0') * 10 + date[6] - '0';
  int d = (date[8] - '0') * 10 + date[9] - '0';
  const int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return y >= 1900 && m >= 1 && m <= 12 && d >= 1 &&
         d <=
             days[m] + (m == 2 && y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
}
static bool choices(const char *value, const char *const *options) {
  for (int i = 0; options[i]; i++)
    if (!strcmp(value, options[i]))
      return true;
  return false;
}
static bool valid_filters(Filters *f) {
  const char *const statuses[] = {"all",        "open",    "completed",
                                  "blocked",    "overdue", "due_soon",
                                  "unassigned", NULL};
  const char *const priorities[] = {"",     "low",    "normal",
                                    "high", "urgent", NULL};
  const char *const labels[] = {"",          "design",  "sviluppo", "ricerca",
                                "marketing", "urgente", NULL};
  /* Search is a literal substring; SQL LIKE wildcards carry no special meaning.
   */
  sqlite3_stmt *s = prepare("SELECT length(?1)");
  bind_text(s, 1, f->q);
  bool q_valid =
      sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0) <= 200;
  sqlite3_finalize(s);
  return q_valid && valid_utf8(f->q, strlen(f->q)) &&
         choices(f->status, statuses) && choices(f->priority, priorities) &&
         choices(f->label, labels) && (!f->from[0] || date_valid(f->from)) &&
         (!f->to[0] || date_valid(f->to)) &&
         (!f->from[0] || !f->to[0] || strcmp(f->from, f->to) <= 0);
}
static void defaults(Filters *f) {
  memset(f, 0, sizeof *f);
  snprintf(f->status, sizeof f->status, "all");
  f->before = INT64_MAX;
  f->limit = 30;
}
static bool query_filters(Request *r, Filters *f) {
  defaults(f);
  struct {
    const char *key;
    char *out;
    size_t size;
  } strings[] = {{"q", f->q, sizeof f->q},
                 {"status", f->status, sizeof f->status},
                 {"priority", f->priority, sizeof f->priority},
                 {"label", f->label, sizeof f->label},
                 {"from", f->from, sizeof f->from},
                 {"to", f->to, sizeof f->to}};
  for (size_t i = 0; i < sizeof strings / sizeof *strings; i++) {
    char value[801];
    int n = ob_query(r, strings[i].key, value, strings[i].size);
    if (n < 0)
      return false;
    if (n)
      snprintf(strings[i].out, strings[i].size, "%s", value);
  }
  struct {
    const char *key;
    int64_t *out;
  } numbers[] = {{"assignee_id", &f->assignee},
                 {"board_id", &f->board},
                 {"before", &f->before},
                 {"limit", &f->limit}};
  for (size_t i = 0; i < sizeof numbers / sizeof *numbers; i++) {
    char value[40];
    int n = ob_query(r, numbers[i].key, value, sizeof value);
    if (n < 0 || (n && !(*numbers[i].out = parse_id(value))))
      return false;
  }
  char value[8];
  int n = ob_query(r, "include_archived", value, sizeof value);
  if (n < 0 || (n && strcmp(value, "0") && strcmp(value, "1")))
    return false;
  f->archived = n && !strcmp(value, "1");
  return f->limit <= 100 && valid_filters(f);
}
static void bind_filters(sqlite3_stmt *s, const Filters *f) {
  sqlite3_bind_int(s, 1, f->archived);
  bind_text(s, 2, f->q);
  bind_text(s, 3, f->status);
  sqlite3_bind_int64(s, 4, f->assignee);
  bind_text(s, 5, f->priority);
  bind_text(s, 6, f->label);
  sqlite3_bind_int64(s, 7, f->board);
  bind_text(s, 8, f->from);
  bind_text(s, 9, f->to);
  sqlite3_bind_int64(s, 10, f->before);
  sqlite3_bind_int64(s, 11, f->limit);
}
/* Every aggregate is based on live, currently authorized ancestry. Access is
 * evaluated for each request, including when applying previously saved filters.
 */
#define VISIBLE                                                                \
  "WITH visible_boards AS(SELECT * FROM boards WHERE deleted_at IS NULL "      \
  "AND (?1 OR archived=0) AND ob_allowed(id) AND (?7=0 OR id=?7)),"            \
  "visible AS(SELECT k.*,b.id board_id,b.name board_name,b.color board_color," \
  "c.title column_title,c.wip_limit,coalesce((SELECT sum(minutes) FROM "       \
  "worklogs WHERE card_id=k.id AND deleted_at IS NULL),0) logged_minutes,"     \
  "json_array_length(k.checklist) checklist_total,(SELECT count(*) FROM "      \
  "json_each(k.checklist) WHERE json_extract(value,'$.done')=1) "              \
  "checklist_done,NOT EXISTS(SELECT 1 FROM card_assignees WHERE "              \
  "card_id=k.id) "                                                             \
  "AND trim(k.assignee)='' unassigned,(SELECT count(*) FROM "                  \
  "card_dependencies "                                                         \
  "d JOIN cards dep ON dep.id=d.required_card_id JOIN columns dc ON "          \
  "dc.id=dep.column_id JOIN boards dbb ON dbb.id=dc.board_id WHERE "           \
  "d.card_id=k.id AND dep.completed=0 AND dep.deleted_at IS NULL AND "         \
  "dc.deleted_at IS NULL AND dbb.deleted_at IS NULL AND ob_allowed(dbb.id) "   \
  "AND (?1 OR (dep.archived=0 AND dbb.archived=0))) dependency_remaining "     \
  "FROM cards k JOIN columns c ON c.id=k.column_id JOIN visible_boards b "     \
  "ON b.id=c.board_id WHERE k.deleted_at IS NULL AND c.deleted_at IS NULL "    \
  "AND (?1 OR k.archived=0)),eligible AS(SELECT * FROM visible k WHERE "       \
  "(?2='' OR instr(lower(k.title||' '||k.description),lower(?2))>0) AND "      \
  "(?3='all' OR (?3='open' AND completed=0) OR (?3='completed' AND "           \
  "completed=1) OR (?3='blocked' AND completed=0 AND (blocked_reason<>'' "     \
  "OR dependency_remaining>0)) OR (?3='overdue' AND completed=0 AND "          \
  "due_date<>'' AND due_date<date('now')) OR (?3='due_soon' AND completed=0 "  \
  "AND due_date BETWEEN date('now') AND date('now','+7 days')) OR "            \
  "(?3='unassigned' AND completed=0 AND unassigned)) AND (?4=0 OR "            \
  "EXISTS(SELECT 1 FROM card_assignees WHERE card_id=k.id AND user_id=?4)) "   \
  "AND (?5='' OR priority=?5) AND (?6='' OR EXISTS(SELECT 1 FROM "             \
  "json_each(k.labels) WHERE value=?6)) AND (?8='' OR due_date>=?8) AND "      \
  "(?9='' OR (due_date<>'' AND due_date<=?9))) "
#define COUNTS                                                                 \
  "'total',count(*),'open',coalesce(sum(completed=0),0),'completed',"          \
  "coalesce(sum(completed=1),0),'blocked',coalesce(sum(completed=0 AND "       \
  "(blocked_reason<>'' OR dependency_remaining>0)),0),'overdue',"              \
  "coalesce(sum(completed=0 AND due_date<>'' AND due_date<date('now')),0),"    \
  "'due_soon',coalesce(sum(completed=0 AND due_date BETWEEN date('now') "      \
  "AND date('now','+7 days')),0),'unassigned',coalesce(sum(completed=0 "       \
  "AND unassigned),0),'estimate_minutes',coalesce(sum(estimate_minutes),0),"   \
  "'total_minutes',coalesce(sum(actual_minutes+logged_minutes),0),"            \
  "'checklist_total',coalesce(sum(checklist_total),0),'checklist_done',"       \
  "coalesce(sum(checklist_done),0)"
static Response filtered(const char *query, Filters *f) {
  char *sql = sqlite3_mprintf("%s%s", VISIBLE, query);
  if (!sql)
    return error_response(503, "Memoria non disponibile.");
  sqlite3_stmt *s = prepare(sql);
  sqlite3_free(sql);
  bind_filters(s, f);
  return row(s);
}
static Response summary(Filters *f) {
  return filtered(
      "SELECT json_object('summary',json((SELECT json_object('boards',"
      "(SELECT count(*) FROM visible_boards)," COUNTS " ) FROM eligible)),"
      "'boards',json((SELECT json_group_array(json(item)) FROM(SELECT "
      "json_set(coalesce((SELECT json_object(" COUNTS ") FROM eligible "
      "WHERE "
      "board_id=b.id),'{}'),'$.id',b.id,'$.name',b.name,'$.color',b.color) "
      "item FROM visible_boards b ORDER BY b.id DESC LIMIT 100))),"
      "'users',json((SELECT json_group_array(json(item)) FROM(SELECT "
      "json_object('id',u.id,'name',u.name,'username',u.username) item FROM "
      "users u WHERE u.active=1 AND (EXISTS(SELECT 1 FROM board_members m "
      "JOIN visible_boards b ON b.id=m.board_id WHERE m.user_id=u.id) OR "
      "EXISTS(SELECT 1 FROM card_assignees a JOIN eligible k ON k.id=a.card_id "
      "WHERE a.user_id=u.id)) ORDER BY u.name,u.id LIMIT 100))),"
      "'boards_truncated',json(CASE WHEN(SELECT count(*) FROM visible_boards)"
      ">100 THEN 'true' ELSE 'false' END))",
      f);
}
#define PAGE_CTE                                                               \
  ",page AS(SELECT * FROM eligible WHERE id<?10 ORDER BY id DESC LIMIT "       \
  "?11+1) "
#define NEXT_CURSOR                                                            \
  "CASE WHEN(SELECT count(*) FROM page)>?11 THEN(SELECT min(id) FROM("         \
  "SELECT id FROM page ORDER BY id DESC LIMIT ?11)) ELSE NULL END"
static Response cards(Filters *f) {
  return filtered(
      PAGE_CTE
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT json_set(json(o.summary),'$.board_id',k.board_id,"
      "'$.board_name',k.board_name,'$.column_title',k.column_title,"
      "'$.dependency_blocked',json(CASE WHEN k.dependency_remaining>0 THEN "
      "'true' ELSE 'false' END)) item FROM page k JOIN ob_card_objects o ON "
      "o.id=k.id ORDER BY k.id DESC LIMIT ?11))),'next_cursor'," NEXT_CURSOR
      ")",
      f);
}
static Response insights(Filters *f) {
  return filtered(
      ",days(date) AS(SELECT date('now','-29 days') UNION ALL SELECT "
      "date(date,'+1 day') FROM days WHERE date<date('now')),"
      "aging AS(SELECT CASE WHEN julianday(date('now'))-julianday(due_date)<=7 "
      "THEN '1-7' WHEN julianday(date('now'))-julianday(due_date)<=30 THEN "
      "'8-30' ELSE '31+' END bucket FROM eligible WHERE completed=0 AND "
      "due_date<>'' AND due_date<date('now')),assignments AS(SELECT k.*,"
      "a.user_id FROM eligible k JOIN card_assignees a ON a.card_id=k.id "
      "WHERE k.completed=0 UNION ALL SELECT k.*,0 FROM eligible k WHERE "
      "k.completed=0 AND NOT EXISTS(SELECT 1 FROM card_assignees a WHERE "
      "a.card_id=k.id)) SELECT json_object('activity',json((SELECT "
      "json_group_array(json(item)) FROM(SELECT json_object('date',d.date,"
      "'count',(SELECT count(*) FROM activity a JOIN visible_boards b ON "
      "b.id=a.board_id WHERE substr(a.created_at,1,10)=d.date)) item FROM "
      "days d ORDER BY d.date))),'overdue_buckets',json((SELECT "
      "json_group_array(json(item)) FROM(SELECT json_object('bucket',bucket,"
      "'count',(SELECT count(*) FROM aging a WHERE a.bucket=bucket_name)) item "
      "FROM(SELECT '1-7' bucket,'1-7' bucket_name UNION ALL SELECT '8-30',"
      "'8-30' UNION ALL SELECT '31+','31+')))),"
      "'capacity',json((SELECT json_group_array(json(item)) FROM(SELECT "
      "json_object('user_id',a.user_id,'name',coalesce(u.name,'Non assegnate'),"
      "'cards',count(*),'estimate_minutes',sum(a.estimate_minutes),"
      "'total_minutes',sum(a.actual_minutes+a.logged_minutes)) item FROM "
      "assignments a LEFT JOIN users u ON u.id=a.user_id GROUP BY a.user_id "
      "ORDER BY count(*) DESC,a.user_id LIMIT 100))),"
      "'time',json((SELECT json_object('estimate_minutes',coalesce(sum("
      "estimate_minutes),0),'manual_minutes',coalesce(sum(actual_minutes),0),"
      "'logged_minutes',coalesce(sum(logged_minutes),0),'total_minutes',"
      "coalesce(sum(actual_minutes+logged_minutes),0),'variance_minutes',"
      "coalesce(sum(actual_minutes+logged_minutes-estimate_minutes),0)) "
      "FROM eligible)),'bottlenecks',json((SELECT json_group_array(json(item)) "
      "FROM(SELECT "
      "json_object('column_id',c.id,'title',c.title,'board_id',b.id,"
      "'board_name',b.name,'wip_limit',c.wip_limit,'open',count(k.id),"
      "'over_limit',max(0,count(k.id)-c.wip_limit)) item FROM columns c JOIN "
      "visible_boards b ON b.id=c.board_id LEFT JOIN eligible k ON "
      "k.column_id=c.id AND k.completed=0 WHERE c.deleted_at IS NULL AND "
      "c.wip_limit>0 GROUP BY c.id HAVING count(k.id)>=c.wip_limit ORDER BY "
      "count(k.id)-c.wip_limit DESC,c.id LIMIT 100))),"
      "'checklists',json((SELECT json_object('total',coalesce(sum("
      "checklist_total),0),'done',coalesce(sum(checklist_done),0)) FROM "
      "eligible)),'dependency_blocks',json((SELECT "
      "json_group_array(json(item)) "
      "FROM(SELECT json_object('id',id,'title',title,'board_id',board_id,"
      "'board_name',board_name,'remaining',dependency_remaining) item FROM "
      "eligible WHERE completed=0 AND dependency_remaining>0 ORDER BY "
      "dependency_remaining DESC,id DESC LIMIT 100))),"
      "'milestones',json((SELECT json_group_array(json(item)) FROM(SELECT "
      "json_object('id',m.id,'key',m.key,'title',m.title,'board_id',b.id,"
      "'board_name',b.name,'due_date',m.due_date,'completed',json(CASE "
      "m.completed WHEN 1 THEN 'true' ELSE 'false' END),'total',count(k.id),"
      "'done',coalesce(sum(k.completed),0),'overdue',json(CASE WHEN "
      "m.completed=0 AND m.due_date<>'' AND m.due_date<date('now') THEN 'true' "
      "ELSE 'false' END)) item FROM milestones m JOIN visible_boards b ON "
      "b.id=m.board_id LEFT JOIN eligible k ON k.board_id=m.board_id AND "
      "k.milestone_key=m.key WHERE m.deleted_at IS NULL GROUP BY m.id ORDER "
      "BY m.due_date='',m.due_date,m.id LIMIT 100))))",
      f);
}
#define CSV_TEXT(expr)                                                         \
  "char(34)||replace(CASE WHEN substr(ltrim(" expr                             \
  ",char(9)||char(10)||char(13)||' '),1,1)IN('=','+','-','@') THEN "           \
  "char(39)||" expr " ELSE " expr                                              \
  " END,char(34),char(34)||char(34))||char(34)"
static Response export_cards(Filters *f) {
  return filtered(
      PAGE_CTE
      ",lines AS(SELECT id||','||" CSV_TEXT("board_name") "||','||" CSV_TEXT(
          "c"
          "o"
          "l"
          "u"
          "m"
          "n"
          "_"
          "t"
          "i"
          "t"
          "l"
          "e") "||','||" CSV_TEXT("title") "||','||" CSV_TEXT("priority") "||',"
                                                                          "'|"
                                                                          "|" CSV_TEXT("due_date") "||','||completed||"
                                                                                                   "','||estimate_minutes||',"
                                                                                                   "'||(actual_minutes+"
                                                                                                   "logged_minutes) line "
                                                                                                   "FROM page ORDER BY id "
                                                                                                   "DESC LIMIT ?11) SELECT "
                                                                                                   "json_object('filename',"
                                                                                                   "'portfolio.csv','csv','"
                                                                                                   "id,board,column,title,"
                                                                                                   "priority,due_date,"
                                                                                                   "completed,"
                                                                                                   "estimate_minutes,total_"
                                                                                                   "minutes'||char(13)||char("
                                                                                                   "10)||coalesce((SELECT "
                                                                                                   "group_concat(line,char("
                                                                                                   "13)||char(10)) FROM "
                                                                                                   "lines),'')||char(13)||"
                                                                                                   "char(10),"
                                                                                                   "'next_cursor'"
                                                                                                   "," NEXT_CURSOR
                                                                                                   ")",
      f);
}

#define REPORT_JSON                                                            \
  "json_object('id',id,'name',name,'filters',json(filters),'pinned',json("     \
  "CASE pinned WHEN 1 THEN 'true' ELSE 'false' END),'version',version,"        \
  "'created_at',created_at,'updated_at',updated_at)"
static Response report_row(int64_t id, int64_t user, int status) {
  sqlite3_stmt *s = prepare("SELECT " REPORT_JSON " FROM saved_reports WHERE "
                            "id=?1 AND user_id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, user);
  Response out = row(s);
  if (out.status == 200)
    out.status = status;
  return out;
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
static bool strict_keys(const char *json, const char *allowed) {
  sqlite3_stmt *s =
      prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) "
              "WHERE instr(key,'|')>0 OR instr(?2,'|'||key||'|')=0)");
  bind_text(s, 1, json);
  bind_text(s, 2, allowed);
  bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  return valid;
}
static bool stored_filters(const char *json) {
  if (!valid_object(json) || strlen(json) > 4096 ||
      !strict_keys(json,
                   "|q|status|assignee_id|priority|label|board_id|from|to|"
                   "limit|include_archived|"))
    return false;
  Filters f;
  defaults(&f);
  struct {
    const char *key;
    char *out;
    size_t size, chars;
  } strings[] = {{"q", f.q, sizeof f.q, 200},
                 {"status", f.status, sizeof f.status, 23},
                 {"priority", f.priority, sizeof f.priority, 15},
                 {"label", f.label, sizeof f.label, 25},
                 {"from", f.from, sizeof f.from, 10},
                 {"to", f.to, sizeof f.to, 10}};
  for (size_t i = 0; i < sizeof strings / sizeof *strings; i++) {
    char *value = NULL;
    int rc = json_string(json, strings[i].key, &value, strings[i].chars);
    if (rc == 1)
      snprintf(strings[i].out, strings[i].size, "%s", value);
    ob_free(value);
    if (rc < 0)
      return false;
  }
  int64_t archived = 0;
  return json_integer(json, "assignee_id", &f.assignee, 1, INT64_MAX, false) >=
             0 &&
         json_integer(json, "board_id", &f.board, 1, INT64_MAX, false) >= 0 &&
         json_integer(json, "limit", &f.limit, 1, 100, false) >= 0 &&
         json_integer(json, "include_archived", &archived, 0, 1, true) >= 0 &&
         valid_filters(&f);
}
static int filters_body(const char *body, char **out) {
  sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.filters'),"
                            "json_extract(?1,'$.filters')");
  bind_text(s, 1, body);
  int rc = -1;
  if (sqlite3_step(s) == SQLITE_ROW) {
    const char *type = (const char *)sqlite3_column_text(s, 0);
    if (!type)
      rc = 0;
    else if (!strcmp(type, "object")) {
      const char *value = (const char *)sqlite3_column_text(s, 1);
      if (stored_filters(value)) {
        *out = strdup(value);
        if (*out)
          rc = 1;
      }
    }
  }
  sqlite3_finalize(s);
  return rc;
}
static bool name_valid(const char *name) {
  if (!name)
    return false;
  for (const unsigned char *p = (const unsigned char *)name; *p; p++)
    if (!isspace(*p))
      return true;
  return false;
}
static bool report_quota(int64_t user) {
  sqlite3_stmt *s =
      prepare("SELECT count(*)<100 FROM saved_reports WHERE user_id=?1");
  sqlite3_bind_int64(s, 1, user);
  bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  return ok;
}
static Response reports(Request *r, bool post) {
  if (!post) {
    sqlite3_stmt *s =
        prepare("SELECT json_object('reports',json((SELECT "
                "json_group_array(json(item)) FROM(SELECT " REPORT_JSON
                " item FROM saved_reports WHERE "
                "user_id=?1 ORDER BY pinned DESC,id DESC))))");
    sqlite3_bind_int64(s, 1, r->user_id);
    return row(s);
  }
  char *name = NULL, *filters = NULL;
  int64_t pinned = 0;
  bool valid = strict_keys(r->body, "|name|filters|pinned|") &&
               json_string(r->body, "name", &name, 100) == 1 &&
               name_valid(name) && filters_body(r->body, &filters) >= 0 &&
               json_integer(r->body, "pinned", &pinned, 0, 1, true) >= 0;
  if (!valid || !report_quota(r->user_id)) {
    ob_free(name);
    free(filters);
    return error_response(valid ? 409 : 400,
                          valid ? "Limite di 100 report raggiunto."
                                : "Nome o filtri non validi.");
  }
  sqlite3_stmt *s =
      prepare("INSERT INTO saved_reports(user_id,name,filters,pinned) "
              "VALUES(?1,?2,?3,?4)");
  sqlite3_bind_int64(s, 1, r->user_id);
  bind_text(s, 2, name);
  bind_text(s, 3, filters ? filters : "{}");
  sqlite3_bind_int64(s, 4, pinned);
  bool ok = done(s);
  ob_free(name);
  free(filters);
  return ok ? report_row(sqlite3_last_insert_rowid(db), r->user_id, 201)
            : error_response(503, "Report non salvato.");
}
static Response modify_report(Request *r, int64_t id, bool remove,
                              bool duplicate) {
  sqlite3_stmt *s =
      prepare("SELECT version FROM saved_reports WHERE id=?1 AND user_id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  if (sqlite3_step(s) != SQLITE_ROW) {
    sqlite3_finalize(s);
    return error_response(404, "Report non trovato.");
  }
  int match = matched(r, sqlite3_column_int64(s, 0));
  sqlite3_finalize(s);
  if (match)
    return error_response(match, match == 412
                                     ? "Versione del report non aggiornata."
                                     : "If-Match non valido.");
  if (remove) {
    s = prepare("DELETE FROM saved_reports WHERE id=?1 AND user_id=?2");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, r->user_id);
    return done(s) ? success(200, id)
                   : error_response(503, "Report non eliminato.");
  }
  char *name = NULL, *filters = NULL;
  int64_t pinned = 0;
  int n = json_string(r->body, "name", &name, 100),
      f = duplicate ? 0 : filters_body(r->body, &filters),
      p = duplicate ? 0 : json_integer(r->body, "pinned", &pinned, 0, 1, true);
  bool valid =
      strict_keys(r->body, duplicate ? "|name|" : "|name|filters|pinned|") &&
      n >= 0 && (!n || name_valid(name)) && f >= 0 && p >= 0 &&
      (duplicate || n || f || p);
  if (!valid || (duplicate && !report_quota(r->user_id))) {
    ob_free(name);
    free(filters);
    return error_response(valid ? 409 : 400,
                          valid ? "Limite di 100 report raggiunto."
                                : "Modifica del report non valida.");
  }
  s = prepare(
      duplicate
          ? "INSERT INTO saved_reports(user_id,name,filters) SELECT user_id,"
            "coalesce(?3,substr(name,1,92)||' (copia)'),filters FROM "
            "saved_reports WHERE id=?1 AND user_id=?2"
          : "UPDATE saved_reports SET name=coalesce(?3,name),"
            "filters=coalesce(?4,filters),pinned=coalesce(?5,pinned),"
            "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',"
            "'now') WHERE id=?1 AND user_id=?2");
  sqlite3_bind_int64(s, 1, id);
  sqlite3_bind_int64(s, 2, r->user_id);
  if (n)
    bind_text(s, 3, name);
  if (!duplicate) {
    if (f)
      bind_text(s, 4, filters);
    if (p)
      sqlite3_bind_int64(s, 5, pinned);
  }
  bool ok = done(s);
  ob_free(name);
  free(filters);
  return ok ? report_row(duplicate ? sqlite3_last_insert_rowid(db) : id,
                         r->user_id, duplicate ? 201 : 200)
            : error_response(503, "Report non salvato.");
}
bool portfolio_handle(Request *r, Response *out) {
  bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
       patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
  if (get && (!strcmp(r->path, "/api/portfolio") ||
              !strcmp(r->path, "/api/portfolio/cards") ||
              !strcmp(r->path, "/api/portfolio/insights") ||
              !strcmp(r->path, "/api/portfolio/export"))) {
    Filters f;
    if (!query_filters(r, &f)) {
      *out = error_response(400, "Filtri portfolio non validi.");
      return true;
    }
    *out = !strcmp(r->path, "/api/portfolio")            ? summary(&f)
           : !strcmp(r->path, "/api/portfolio/cards")    ? cards(&f)
           : !strcmp(r->path, "/api/portfolio/insights") ? insights(&f)
                                                         : export_cards(&f);
    return true;
  }
  if (!strcmp(r->path, "/api/me/reports") && (get || post)) {
    *out =
        !ob_config.auth_enabled || !r->user_id
            ? error_response(403, "I report personali richiedono un account.")
            : reports(r, post);
    return true;
  }
  const char *prefix = "/api/reports/";
  if (strncmp(r->path, prefix, strlen(prefix)))
    return false;
  const char *p = r->path + strlen(prefix), *slash = strchr(p, '/');
  char number[24];
  size_t len = slash ? (size_t)(slash - p) : strlen(p);
  if (!len || len >= sizeof number)
    return false;
  memcpy(number, p, len);
  number[len] = 0;
  int64_t id = parse_id(number);
  bool duplicate = slash && !strcmp(slash, "/duplicate") && post;
  if (!id || (slash && !duplicate) || (!get && !patch && !del && !duplicate))
    return false;
  *out = !ob_config.auth_enabled || !r->user_id
             ? error_response(403, "I report personali richiedono un account.")
         : get ? report_row(id, r->user_id, 200)
               : modify_report(r, id, del, duplicate);
  return true;
}
