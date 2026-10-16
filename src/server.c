/* OpenBoard domain/storage API. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "auth.h"
#include "collaboration.h"
#include "cloud.h"
#include "openboard.h"
#include "intake.h"
#include "portfolio.h"
#include "reviews.h"
#include "sprints.h"
#include "teamwork.h"
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
#define SCHEMA_VERSION 7
_Thread_local sqlite3 *db;
static _Thread_local jmp_buf request_recovery;
static _Thread_local jmp_buf *failure_target;
static _Thread_local bool recovering, outer_transaction, importing_plan;
/* Cloud lock state must survive the SQL recovery longjmp. The external store
 * remains authoritative until cloud_request_finish acknowledges its commit. */
static _Thread_local bool cloud_request_active;
static _Thread_local sqlite3_int64 cloud_changes_before;
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
    Response r =
        rc == SQLITE_ROW
            ? json_response(200, (const char *)sqlite3_column_text(s, 0))
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
            if (length - i < 2 || (s[i] & 0xc0) != 0x80 || (s[i + 1] & 0xc0) != 0x80 ||
                (c == 0xe0 && s[i] < 0xa0) || (c == 0xed && s[i] >= 0xa0))
                return false;
            i += 2;
        } else if (c >= 0xf0 && c <= 0xf4) {
            if (length - i < 3 || (s[i] & 0xc0) != 0x80 || (s[i + 1] & 0xc0) != 0x80 ||
                (s[i + 2] & 0xc0) != 0x80 || (c == 0xf0 && s[i] < 0x90) ||
                (c == 0xf4 && s[i] >= 0x90))
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
    s = prepare("SELECT json_type(?1)='object' AND NOT EXISTS(SELECT 1 FROM "
                "json_each(?1) GROUP BY key HAVING count(*)>1)");
    bind_text(s, 1, json);
    valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return valid;
}
/* Returns 0 for absent, 1 for a string, -1 for a wrong type or embedded NUL. */
int json_string(const char *json, const char *field, char **out, size_t limit) {
    char path[80];
    snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT "
                              "json_type(?1,?2),json_extract(?1,?2),length(json_extract(?1,?2))");
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
            if (v && n >= 0 && (size_t)n <= limit * 4 &&
                (size_t)sqlite3_column_int64(s, 2) <= limit && strlen(v) == (size_t)n &&
                valid_utf8(v, (size_t)n)) {
                *out = copy_string(v);
                result = 1;
            }
        }
    }
    sqlite3_finalize(s);
    return result;
}
int json_integer(const char *json, const char *field, int64_t *out, int64_t min, int64_t max,
                 bool boolean) {
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
    s = prepare("SELECT json_array_length(?1)<=100 AND NOT EXISTS(SELECT 1 FROM "
                "json_each(?1) WHERE type<>'object')");
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
        s = prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY "
                    "json_extract(value,'$.id') HAVING count(*)>1)");
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

static int64_t seed_board(const char *name, const char *description, const char *color,
                          int starred) {
    sqlite3_stmt *s =
        prepare("INSERT INTO boards(name,description,color,starred) VALUES(?1,?2,?3,?4)");
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
static void seed_card(int64_t column, const char *title, const char *description, const char *label,
                      const char *date, const char *assignee, const char *cover, int position,
                      int completed, const char *checklist) {
    sqlite3_stmt *s = prepare("INSERT INTO "
                              "cards(column_id,title,description,label,due_date,assignee,cover,"
                              "position,completed,checklist,labels) "
                              "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,CASE WHEN ?4='' THEN '[]' "
                              "ELSE json_array(?4) END)");
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
/* Callback recovery returns through SQLite normally; never jump out of
 * sqlite3_step. */
#define SQL_CALLBACK_GUARD(context)                                                                \
    jmp_buf callback_recovery;                                                                     \
    jmp_buf *previous_recovery = failure_target;                                                   \
    failure_target = &callback_recovery;                                                           \
    if (setjmp(callback_recovery)) {                                                               \
        failure_target = previous_recovery;                                                        \
        sqlite3_result_error(context, "Database temporaneamente non disponibile", -1);             \
        return;                                                                                    \
    }
#define SQL_CALLBACK_END() failure_target = previous_recovery

static void allowed_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    sqlite3_result_int(
        c, current_request ? auth_board_allowed(current_request, sqlite3_value_int64(v[0]), false)
                           : 1);
    SQL_CALLBACK_END();
}
static void starred_sql(sqlite3_context *c, int n, sqlite3_value **v) {
    SQL_CALLBACK_GUARD(c);
    (void)n;
    sqlite3_result_int(c, current_request ? auth_starred(current_request, sqlite3_value_int64(v[0]),
                                                         sqlite3_value_int(v[1]))
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
    sqlite3_result_int(
        c, current_request ? !auth_board_allowed(current_request, sqlite3_value_int64(v[0]), true)
                           : 0);
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
        source_stat.st_dev == destination_stat.st_dev &&
        source_stat.st_ino == destination_stat.st_ino)
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
    "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT "
    "NULL);"
    "CREATE TABLE IF NOT EXISTS boards(id INTEGER PRIMARY KEY "
    "AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT "
    "NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'sage',starred INTEGER NOT "
    "NULL DEFAULT 0 CHECK(starred IN(0,1)));"
    "CREATE TABLE IF NOT EXISTS columns(id INTEGER PRIMARY KEY "
    "AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES "
    "boards(id) ON DELETE CASCADE,title TEXT NOT NULL,position INTEGER NOT "
    "NULL);CREATE INDEX IF NOT EXISTS "
    "columns_board ON columns(board_id,position);"
    "CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY "
    "AUTOINCREMENT,column_id INTEGER NOT NULL REFERENCES "
    "columns(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT "
    "NULL DEFAULT '',label TEXT NOT NULL "
    "DEFAULT '',due_date TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL "
    "DEFAULT '',cover TEXT NOT NULL DEFAULT "
    "'',position INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0 "
    "CHECK(completed IN(0,1)),checklist TEXT NOT "
    "NULL DEFAULT '[]' CHECK(json_valid(checklist)));CREATE INDEX IF NOT "
    "EXISTS cards_column ON "
    "cards(column_id,position);";
static void migration_two(void) {
    const char *tables[] = {"boards", "columns", "cards"};
    char sql[2048];
    for (size_t i = 0; i < COUNT_OF(tables); i++) {
        const char *t = tables[i];
        snprintf(sql, sizeof sql,
                 "ALTER TABLE %s ADD COLUMN created_at TEXT NOT NULL DEFAULT "
                 "'';ALTER TABLE %s ADD COLUMN updated_at "
                 "TEXT NOT NULL DEFAULT '';ALTER TABLE %s ADD COLUMN version "
                 "INTEGER NOT NULL DEFAULT 1;ALTER TABLE %s "
                 "ADD COLUMN deleted_at TEXT;UPDATE %s SET "
                 "created_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now'),updated_at="
                 "strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
                 "'now');",
                 t, t, t, t, t);
        sql_exec(sql);
        snprintf(sql, sizeof sql,
                 "CREATE TRIGGER %s_timestamps_insert AFTER INSERT ON %s BEGIN "
                 "UPDATE %s SET created_at=CASE WHEN "
                 "NEW.created_at='' THEN "
                 "strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') ELSE NEW.created_at "
                 "END,updated_at=CASE WHEN NEW.updated_at='' THEN "
                 "strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') ELSE "
                 "NEW.updated_at END WHERE id=NEW.id; END;CREATE TRIGGER "
                 "%s_timestamps_update AFTER UPDATE ON %s WHEN "
                 "NEW.version=OLD.version AND NEW.created_at=OLD.created_at BEGIN "
                 "UPDATE %s SET "
                 "version=OLD.version+1,updated_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%"
                 "fZ','now') WHERE id=NEW.id; END;",
                 t, t, t, t, t, t);
        sql_exec(sql);
    }
    sql_exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 "
             "CHECK(archived IN(0,1));ALTER TABLE "
             "cards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 "
             "CHECK(archived IN(0,1));ALTER TABLE columns ADD "
             "COLUMN wip_limit INTEGER NOT NULL DEFAULT 0 CHECK(wip_limit "
             "BETWEEN 0 AND 100000);ALTER TABLE cards ADD "
             "COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority "
             "IN('low','normal','high','urgent'));ALTER "
             "TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]' "
             "CHECK(json_valid(labels));ALTER TABLE cards ADD "
             "COLUMN estimate_minutes INTEGER NOT NULL DEFAULT 0 "
             "CHECK(estimate_minutes BETWEEN 0 AND 100000);UPDATE "
             "cards SET labels=CASE WHEN label='' THEN '[]' ELSE "
             "json_array(label) END;");
}
static const char *schema_three =
    "CREATE TABLE comments(id INTEGER PRIMARY KEY AUTOINCREMENT,card_id "
    "INTEGER NOT NULL REFERENCES cards(id) ON "
    "DELETE CASCADE,author_id INTEGER NOT NULL DEFAULT 0,author TEXT NOT "
    "NULL,body TEXT NOT NULL,created_at TEXT NOT "
    "NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));CREATE INDEX "
    "comments_card ON comments(card_id,id);"
    "CREATE TABLE activity(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id "
    "INTEGER NOT NULL REFERENCES boards(id) ON "
    "DELETE CASCADE,actor_id INTEGER NOT NULL DEFAULT 0,actor TEXT NOT "
    "NULL,action TEXT NOT NULL,entity_type TEXT NOT "
    "NULL,entity_id INTEGER NOT NULL,title TEXT NOT NULL,created_at TEXT NOT "
    "NULL "
    "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));CREATE INDEX "
    "activity_board ON activity(board_id,id DESC);"
    "CREATE TABLE idempotency(user_id INTEGER NOT NULL,path TEXT NOT NULL,key "
    "TEXT NOT NULL,request_body TEXT NOT "
    "NULL,status INTEGER NOT NULL,response_body TEXT NOT NULL,created_at TEXT "
    "NOT NULL "
    "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY "
    "KEY(user_id,path,key));"
    "CREATE INDEX cards_due ON cards(due_date) WHERE deleted_at IS NULL;CREATE "
    "INDEX cards_active ON "
    "cards(column_id,archived,position) WHERE deleted_at IS NULL;CREATE INDEX "
    "boards_active ON boards(archived,id) "
    "WHERE deleted_at IS NULL;";
static void migration_four(void) {
    sql_exec("ALTER TABLE cards ADD COLUMN start_date TEXT NOT NULL DEFAULT '';"
             "ALTER TABLE cards ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';"
             "ALTER TABLE cards ADD COLUMN actual_minutes INTEGER NOT NULL DEFAULT 0 "
             "CHECK(actual_minutes BETWEEN 0 AND 1000000);"
             "ALTER TABLE cards ADD COLUMN reference_url TEXT NOT NULL DEFAULT '';"
             "CREATE TABLE card_assignees(card_id INTEGER NOT NULL REFERENCES "
             "cards(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES "
             "users(id) ON DELETE CASCADE,PRIMARY KEY(card_id,user_id));"
             "CREATE INDEX assignees_user ON card_assignees(user_id,card_id);"
             "CREATE TABLE card_dependencies(card_id INTEGER NOT NULL REFERENCES "
             "cards(id) ON DELETE CASCADE,required_card_id INTEGER NOT NULL "
             "REFERENCES cards(id) ON DELETE "
             "CASCADE,CHECK(card_id<>required_card_id),PRIMARY "
             "KEY(card_id,required_card_id));"
             "CREATE INDEX dependencies_required ON "
             "card_dependencies(required_card_id,card_id);"
             "CREATE TABLE templates(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id "
             "INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL CHECK(kind "
             "IN('cards','boards')),name TEXT NOT NULL,payload TEXT NOT NULL "
             "CHECK(json_valid(payload)),created_at TEXT NOT NULL "
             "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
             "CREATE INDEX templates_owner ON templates(owner_id,kind,id);"
             "CREATE TABLE saved_views(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id "
             "INTEGER NOT NULL DEFAULT 0,board_id INTEGER NOT NULL REFERENCES "
             "boards(id) ON DELETE CASCADE,name TEXT NOT NULL,filters TEXT NOT NULL "
             "CHECK(json_valid(filters)),created_at TEXT NOT NULL "
             "DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));"
             "CREATE INDEX saved_views_owner ON saved_views(user_id,board_id,id);");
}
static void migration_five(void) {
    sql_exec("ALTER TABLE boards ADD COLUMN guidelines TEXT NOT NULL DEFAULT '';"
             "ALTER TABLE cards ADD COLUMN custom_values TEXT NOT NULL DEFAULT '{}' "
             "CHECK(json_valid(custom_values));"
             "ALTER TABLE cards ADD COLUMN milestone_key TEXT NOT NULL DEFAULT '';"
             "CREATE TABLE custom_fields(id INTEGER PRIMARY KEY "
             "AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE "
             "CASCADE,"
             "key TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL CHECK(type "
             "IN('text','number','date','boolean','select')),"
             "options TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(options)),position "
             "INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,UNIQUE(board_id,key));"
             "CREATE INDEX custom_fields_board ON custom_fields(board_id,position,id);"
             "CREATE TABLE milestones(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id "
             "INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,"
             "key TEXT NOT NULL,title TEXT NOT NULL,due_date TEXT NOT NULL DEFAULT "
             "'',completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),"
             "deleted_at TEXT,UNIQUE(board_id,key));CREATE INDEX milestones_board ON "
             "milestones(board_id,due_date,id);");
    teamwork_schema(db);
}
static const char *json_views =
    "CREATE VIEW IF NOT EXISTS ob_card_objects AS SELECT "
    "k.*,json_object('id',k.id,'column_id',k.column_id,'title',k.title,'"
    "description',k.description,'label',k.label,'"
    "labels',json(k.labels),'due_date',k.due_date,'assignee',k.assignee,'cover'"
    ",k.cover,'position',k.position,'"
    "completed',json(CASE k.completed WHEN 1 THEN 'true' ELSE 'false' "
    "END),'checklist',json(k.checklist),'priority',k.priority,'estimate_"
    "minutes',k.estimate_minutes,'archived',json("
    "CASE k.archived WHEN 1 THEN 'true' ELSE 'false' "
    "END),'version',k.version,'created_at',k.created_at,'updated_at',k.updated_"
    "at,'start_date',k.start_date,'blocked_reason',k.blocked_reason,'actual_"
    "minutes',k.actual_minutes,'reference_url',k.reference_url,'assignee_ids',"
    "json((SELECT json_group_array(user_id) FROM card_assignees WHERE "
    "card_id=k.id)),'assignees',json((SELECT "
    "json_group_array(json_object('id',u.id,'name',u.name,'username',u."
    "username)) FROM card_assignees a JOIN users u ON u.id=a.user_id WHERE "
    "a.card_id=k.id)),'custom_values',json(k.custom_values),'milestone_key',k."
    "milestone_key,'logged_minutes',coalesce((SELECT sum(minutes) FROM "
    "worklogs WHERE card_id=k.id AND deleted_at IS "
    "NULL),0),'total_minutes',k.actual_minutes+coalesce((SELECT sum(minutes) "
    "FROM worklogs WHERE card_id=k.id AND deleted_at IS NULL),0)) data,"
    "json_object('id',k.id,'column_id',k.column_id,'title',k.title,'"
    "description_preview',substr(k.description,1,160),'"
    "checklist_total',json_array_length(k.checklist),'checklist_done',(SELECT "
    "count(*) FROM json_each(k.checklist) "
    "WHERE "
    "json_extract(value,'$.done')=1),'label',k.label,'labels',json(k.labels),'"
    "due_date',k.due_date,'assignee',k."
    "assignee,'cover',k.cover,'position',k.position,'completed',json(CASE "
    "k.completed WHEN 1 THEN 'true' ELSE 'false' "
    "END),'priority',k.priority,'estimate_minutes',k.estimate_minutes,'"
    "archived',json(CASE k.archived WHEN 1 THEN "
    "'true' ELSE 'false' "
    "END),'version',k.version,'created_at',k.created_at,'updated_at',k.updated_"
    "at,'start_date',k.start_date,'blocked_reason',k.blocked_reason,'actual_"
    "minutes',k.actual_minutes,'reference_url',k.reference_url,'assignee_ids',"
    "json((SELECT json_group_array(user_id) FROM card_assignees WHERE "
    "card_id=k.id)),'assignees',json((SELECT "
    "json_group_array(json_object('id',u.id,'name',u.name,'username',u."
    "username)) FROM card_assignees a JOIN users u ON u.id=a.user_id WHERE "
    "a.card_id=k.id)),'custom_values',json(k.custom_values),'milestone_key',k."
    "milestone_key,'logged_minutes',coalesce((SELECT sum(minutes) FROM "
    "worklogs WHERE card_id=k.id AND deleted_at IS "
    "NULL),0),'total_minutes',k.actual_minutes+coalesce((SELECT sum(minutes) "
    "FROM worklogs WHERE card_id=k.id AND deleted_at IS NULL),0)) summary FROM "
    "cards k;";
static const char *json_board_view =
    "CREATE VIEW IF NOT EXISTS ob_board_objects AS SELECT "
    "b.*,json_object('id',b.id,'name',b.name,'description',b.description,'"
    "guidelines',b.guidelines,'custom_fields',json((SELECT "
    "json_group_array(json_object('id',id,'key',key,'name',name,'type',type,'"
    "options',json(options),'position',position,'deleted_at',deleted_at)) FROM "
    "(SELECT * FROM custom_fields WHERE board_id=b.id ORDER BY "
    "position,id))),'milestones',json((SELECT "
    "json_group_array(json_object('id',id,'key',key,'title',title,'due_date',"
    "due_date,'completed',json(CASE completed WHEN 1 THEN 'true' ELSE 'false' "
    "END),'deleted_at',deleted_at)) FROM milestones WHERE board_id=b.id)),'"
    "color',b.color,'starred',json(CASE "
    "ob_starred(b.id,b.starred) WHEN 1 THEN 'true' ELSE 'false' "
    "END),'archived',json(CASE b.archived WHEN 1 THEN "
    "'true' ELSE 'false' "
    "END),'version',b.version,'created_at',b.created_at,'updated_at',b.updated_"
    "at,'role',ob_role(b.id),'membership_"
    "role',ob_role(b.id),'readonly',json(CASE ob_readonly(b.id) WHEN 1 THEN "
    "'true' ELSE 'false' "
    "END),'columns',json((SELECT json_group_array(json(col)) FROM(SELECT "
    "json_object('id',c.id,'title',c.title,'position',c.position,'wip_limit',c."
    "wip_limit,'version',c.version,'created_"
    "at',c.created_at,'updated_at',c.updated_at,'cards',json((SELECT "
    "json_group_array(json(item)) FROM(SELECT CASE "
    "ob_summary() WHEN 1 THEN k.summary ELSE k.data END item FROM "
    "ob_card_objects k WHERE k.column_id=c.id AND "
    "k.deleted_at IS NULL AND (ob_archived() OR k.archived=0) ORDER BY "
    "k.position,k.id)))) col FROM columns c WHERE "
    "c.board_id=b.id AND c.deleted_at IS NULL ORDER BY c.position,c.id)))) "
    "data FROM boards b;";
int ob_worker_init(void) {
    if (sqlite3_open_v2(ob_config.db_path, &db,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX,
                        NULL) != SQLITE_OK)
        return -1;
    if (chmod(ob_config.db_path, 0600) < 0)
        return -1;
    sqlite3_busy_timeout(db, ob_config.busy_timeout_ms);
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
        else if (next == 3)
            sql_exec(schema_three);
        else if (next == 4) {
            auth_schema(db);
            migration_four();
            collaboration_schema(db);
        } else if (next == 5)
            migration_five();
        else if (next == 6) {
            reviews_schema(db);
            portfolio_schema(db);
        } else {
            sprints_schema(db);
            intake_schema(db);
        }
        char p[64];
        snprintf(p, sizeof p, "PRAGMA user_version=%d;COMMIT", next);
        sql_exec(p);
        version = next;
    }
    auth_schema(db);
    /* Repair legacy primary labels produced before the multi-label seed was
     * introduced. */
    sql_exec("BEGIN IMMEDIATE;UPDATE boards SET "
             "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
             "WHERE id IN(SELECT c.board_id FROM cards k JOIN columns c ON "
             "c.id=k.column_id WHERE k.labels='[]' AND "
             "k.label<>'');"
             "UPDATE cards SET labels=json_array(label) WHERE labels='[]' AND "
             "label<>'';COMMIT;");
    sql_exec("DROP VIEW IF EXISTS ob_board_objects;DROP VIEW IF EXISTS "
             "ob_card_objects;");
    sql_exec(json_views);
    sql_exec(json_board_view);
    bool initialized = scalar_id("SELECT count(*) FROM metadata WHERE key='initialized'", 0) > 0;
    if (!initialized) {
        sql_exec("BEGIN IMMEDIATE");
        if (!ob_config.no_demo && scalar_id("SELECT count(*) FROM boards", 0) == 0) {
            int64_t board = seed_board("Lancio di OpenBoard",
                                       "Uno spazio condiviso per dare forma alle "
                                       "idee. Costruiamo qualcosa di bello, insieme.",
                                       "sage", 1);
            int64_t ideas = seed_column(board, "Idee", 0), todo = seed_column(board, "Da fare", 1),
                    doing = seed_column(board, "In corso", 2),
                    done = seed_column(board, "Completato", 3);
            seed_card(ideas, "Una casa per tutte le nostre idee",
                      "Raccogliere spunti, ispirazioni e piccoli esperimenti per il "
                      "futuro di OpenBoard.",
                      "ricerca", "", "Sofia", "lavender", 0, 0, "[]");
            seed_card(ideas, "Modalità scura",
                      "Esplorare una palette scura morbida, accessibile e piacevole "
                      "da usare la sera.",
                      "design", "2026-10-28", "Giulia", "", 1, 0, "[]");
            seed_card(ideas, "Importa le tue bacheche",
                      "Studiare un formato aperto per importare progetti da altri "
                      "strumenti Kanban.",
                      "sviluppo", "", "Marco", "", 2, 0, "[]");
            seed_card(todo, "Disegnare la nuova pagina di benvenuto",
                      "Una prima impressione semplice: il valore del progetto, una "
                      "demo e un invito a contribuire.",
                      "design", "2026-10-20", "Giulia", "peach", 0, 0,
                      "[{\"id\":\"welcome-1\",\"text\":\"Raccogliere "
                      "riferimenti\",\"done\":true},{\"id\":\"welcome-2\",\"text\":"
                      "\"Preparare il "
                      "wireframe\",\"done\":false},{\"id\":\"welcome-3\",\"text\":"
                      "\"Revisione con il "
                      "team\",\"done\":false}]");
            seed_card(todo, "Scrivere la guida per contribuire",
                      "Documentare come avviare il progetto, segnalare problemi e "
                      "proporre miglioramenti.",
                      "marketing", "2026-10-22", "Luca", "", 1, 0, "[]");
            seed_card(todo, "Test di accessibilità",
                      "Verificare navigazione da tastiera, contrasto e annunci per "
                      "gli screen reader.",
                      "urgente", "2026-10-19", "Sofia", "", 2, 0,
                      "[{\"id\":\"a11y-1\",\"text\":\"Navigazione con "
                      "Tab\",\"done\":false},{\"id\":\"a11y-2\",\"text\":\"Contrasto "
                      "dei colori\",\"done\":false}]");
            seed_card(doing, "Trascina, sposta, organizza",
                      "Spostare le schede fra le liste e mantenere il nuovo ordine "
                      "anche dopo un riavvio.",
                      "sviluppo", "2026-10-18", "Marco", "blue", 0, 0,
                      "[{\"id\":\"drag-1\",\"text\":\"API di "
                      "spostamento\",\"done\":true},{\"id\":\"drag-2\",\"text\":"
                      "\"Interazioni drag & "
                      "drop\",\"done\":false}]");
            seed_card(doing, "Dare un'identità a OpenBoard",
                      "Definire logo, colori e tono di voce per un progetto aperto e "
                      "accogliente.",
                      "design", "2026-10-21", "Giulia", "", 1, 0, "[]");
            seed_card(done, "Il progetto è open source!",
                      "Codice disponibile con licenza MIT. Ogni contributo, grande o "
                      "piccolo, è benvenuto.",
                      "marketing", "2026-10-14", "Luca", "sage", 0, 1, "[]");
            seed_card(done, "Preparare le fondamenta in C",
                      "Server HTTP leggero, API JSON e database SQLite. Poche "
                      "dipendenze, tanta sostanza.",
                      "sviluppo", "2026-10-13", "Marco", "", 1, 1,
                      "[{\"id\":\"base-1\",\"text\":\"Server "
                      "HTTP\",\"done\":true},{\"id\":\"base-2\",\"text\":"
                      "\"Persistenza SQLite\",\"done\":true}]");
            int64_t inspiration = seed_board(
                "Idee & ispirazioni",
                "Uno spazio per i prossimi esperimenti e le cose che ci ispirano.", "lavender", 0);
            seed_column(inspiration, "Raccolta", 0);
            seed_column(inspiration, "Da esplorare", 1);
            seed_column(inspiration, "Preferiti", 2);
            int64_t website = seed_board(
                "Sito web", "Dal primo wireframe alla pubblicazione del nostro nuovo sito.", "blue",
                0);
            seed_column(website, "Da fare", 0);
            seed_column(website, "In corso", 1);
            seed_column(website, "Pubblicato", 2);
        }
        sql_exec("INSERT INTO metadata(key,value) VALUES('initialized','1');COMMIT;");
    }
    return cloud_bootstrap(db);
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
        snprintf(sql, sizeof sql, "SELECT id FROM boards WHERE id=?1 %s",
                 deleted ? "" : "AND deleted_at IS NULL");
    else if (!strcmp(kind, "columns"))
        snprintf(sql, sizeof sql,
                 "SELECT c.board_id FROM columns c JOIN boards b ON "
                 "b.id=c.board_id WHERE c.id=?1 %s",
                 deleted ? "" : "AND c.deleted_at IS NULL AND b.deleted_at IS NULL");
    else
        snprintf(sql, sizeof sql,
                 "SELECT c.board_id FROM cards k JOIN columns c ON "
                 "c.id=k.column_id JOIN boards b ON b.id=c.board_id "
                 "WHERE k.id=?1 %s",
                 deleted ? ""
                         : "AND k.deleted_at IS NULL AND c.deleted_at IS NULL AND "
                           "b.deleted_at IS NULL");
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
    char *name = copy_string(sqlite3_step(s) == SQLITE_ROW ? (const char *)sqlite3_column_text(s, 0)
                                                           : "Utente");
    sqlite3_finalize(s);
    return name;
}
static void record_event(Request *r, int64_t board, const char *action, const char *kind,
                         int64_t id, const char *title) {
    char *actor = actor_name(r);
    sqlite3_stmt *s =
        prepare("INSERT INTO "
                "activity(board_id,actor_id,actor,action,entity_type,entity_id,title) "
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
    if (!run_id("UPDATE boards SET "
                "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
                ") WHERE id=?1",
                board))
        db_die("Aggiornamento versione fallito");
}
static char *resource_title(const char *kind, int64_t id) {
    char sql[100];
    snprintf(sql, sizeof sql, "SELECT %s FROM %s WHERE id=?1",
             !strcmp(kind, "boards") ? "name" : "title", kind);
    sqlite3_stmt *s = prepare(sql);
    sqlite3_bind_int64(s, 1, id);
    char *t =
        copy_string(sqlite3_step(s) == SQLITE_ROW ? (const char *)sqlite3_column_text(s, 0) : "");
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
    return run_id("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY "
                  "archived,position,id)-1 n FROM cards WHERE "
                  "column_id=?1 AND "
                  "deleted_at IS NULL)UPDATE cards SET position=(SELECT n FROM "
                  "ranked WHERE ranked.id=cards.id) WHERE "
                  "column_id=?1 AND deleted_at IS NULL AND position<>(SELECT n "
                  "FROM ranked WHERE ranked.id=cards.id)",
                  id);
}
static bool normalize_columns(int64_t id) {
    return run_id("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY "
                  "position,id)-1 n FROM columns WHERE board_id=?1 AND "
                  "deleted_at IS NULL)UPDATE columns SET position=(SELECT n FROM "
                  "ranked WHERE ranked.id=columns.id) WHERE "
                  "board_id=?1 AND deleted_at IS NULL AND position<>(SELECT n "
                  "FROM ranked WHERE ranked.id=columns.id)",
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
    s = prepare("SELECT json_array_length(?1)<=5 AND NOT EXISTS(SELECT 1 FROM "
                "json_each(?1) WHERE type<>'text' OR "
                "value NOT IN('design','sviluppo','ricerca','marketing','urgente'))AND "
                "NOT EXISTS(SELECT 1 FROM "
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
    char *name = NULL, *description = NULL, *color = NULL, *guidelines = NULL;
    int64_t starred = 0, archived = 0;
    int g = json_string(r->body, "guidelines", &guidelines, 10000),
        n = json_string(r->body, "name", &name, 200),
        d = json_string(r->body, "description", &description, 2000),
        c = json_string(r->body, "color", &color, 20),
        t = json_integer(r->body, "starred", &starred, 0, 1, true),
        a = json_integer(r->body, "archived", &archived, 0, 1, true);
    Response result;
    if (g < 0 || n < 0 || d < 0 || c < 0 || t < 0 || a < 0 || (create && n != 1) ||
        (name && !nonblank(name)) || (color && !one_of(color, colors, COUNT_OF(colors)))) {
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
        s = prepare("INSERT INTO "
                    "boards(name,description,color,starred,archived,guidelines)"
                    "VALUES(?1,?2,?"
                    "3,?4,?5,?6)");
        bind_text(s, 1, name);
        bind_text(s, 2, description);
        bind_text(s, 3, color ? color : "sage");
        sqlite3_bind_int64(s, 4, starred);
        sqlite3_bind_int64(s, 5, archived);
        bind_text(s, 6, guidelines);
    } else {
        s = prepare("UPDATE boards SET "
                    "name=coalesce(?2,name),description=coalesce(?3,description),color="
                    "coalesce(?4,color),starred="
                    "coalesce(?5,starred),archived=coalesce(?6,archived),guidelines="
                    "coalesce(?7,guidelines)WHERE id=?1");
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
        if (g)
            bind_text(s, 7, guidelines);
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
    ob_free(guidelines);
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
    int64_t count =
        scalar_id("SELECT count(*) FROM columns WHERE board_id=?1 AND deleted_at IS NULL", board);
    if (!create)
        count--;
    if (p && position > count) {
        ob_free(title);
        return error_response(400, "Posizione della lista non valida.");
    }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO "
                    "columns(board_id,title,position,wip_limit)VALUES(?1,?2,?3,?4)");
        sqlite3_bind_int64(s, 1, board);
        bind_text(s, 2, title);
        sqlite3_bind_int64(s, 3, count);
        sqlite3_bind_int64(s, 4, wip);
    } else {
        s = prepare("UPDATE columns SET "
                    "title=coalesce(?2,title),wip_limit=coalesce(?3,wip_limit)WHERE id=?1");
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
        s = prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n "
                    "FROM columns WHERE "
                    "board_id=?1 AND id<>?2 AND deleted_at IS NULL)UPDATE columns SET "
                    "position=(SELECT n FROM ranked "
                    "WHERE ranked.id=columns.id)+CASE WHEN (SELECT n FROM ranked WHERE "
                    "ranked.id=columns.id)>=?3 THEN "
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
static bool valid_reference_url(const char *url) {
    if (!*url)
        return true;
    const char *host = !strncasecmp(url, "https://", 8)  ? url + 8
                       : !strncasecmp(url, "http://", 7) ? url + 7
                                                         : NULL;
    if (!host || !*host || *host == '/' || *host == '?' || *host == '#')
        return false;
    for (const unsigned char *p = (const unsigned char *)url; *p; p++)
        if (*p <= 32 || *p == 127 || *p == '\\')
            return false;
    const char *end = host + strcspn(host, "/?#");
    for (const char *p = host; p < end; p++)
        if (*p == '@')
            return false;
    return end > host;
}
/* Only numeric IDs are accepted; role/membership is validated inside the write
 * transaction. */
static int json_assignee_ids(const char *body, const char *field, char **out) {
    char path[80];
    snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2)");
    bind_text(s, 1, body);
    bind_text(s, 2, path);
    int p = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *t = (const char *)sqlite3_column_text(s, 0);
        if (!t)
            p = 0;
        else if (!strcmp(t, "array")) {
            *out = copy_string((const char *)sqlite3_column_text(s, 1));
            p = 1;
        }
    }
    sqlite3_finalize(s);
    if (p != 1)
        return p;
    s = prepare("SELECT json_array_length(?1)<=100 AND NOT EXISTS(SELECT 1 FROM "
                "json_each(?1) WHERE type<>'integer' OR value<=0) AND NOT EXISTS(SELECT "
                "1 FROM json_each(?1) GROUP BY value HAVING count(*)>1)");
    bind_text(s, 1, *out);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok ? 1 : -1;
}
static bool valid_assignees(int64_t board, const char *ids) {
    if (!ob_config.auth_enabled)
        return !strcmp(ids, "[]");
    sqlite3_stmt *s = prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?2) j LEFT JOIN users "
                              "u ON u.id=j.value WHERE u.id IS NULL OR u.active=0 OR "
                              "(u.role<>'admin' AND NOT EXISTS(SELECT 1 FROM board_members m "
                              "WHERE m.board_id=?1 AND m.user_id=u.id)))");
    sqlite3_bind_int64(s, 1, board);
    bind_text(s, 2, ids);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok;
}
static void write_assignees(int64_t card, const char *ids) {
    if (!run_id("DELETE FROM card_assignees WHERE card_id=?1", card))
        db_die("Assegnatari non salvati");
    sqlite3_stmt *s = prepare("INSERT INTO card_assignees(card_id,user_id)SELECT "
                              "?1,value FROM json_each(?2)");
    sqlite3_bind_int64(s, 1, card);
    bind_text(s, 2, ids);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Assegnatari non salvati");
    sqlite3_finalize(s);
    if (!run_id("UPDATE cards SET "
                "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
                ") WHERE id=?1",
                card))
        db_die("Versione scheda non salvata");
}
/* A deleted prerequisite remains unsatisfied until it is restored and
 * completed. */
static bool dependencies_complete(int64_t card, const char *completed_ids) {
    sqlite3_stmt *s =
        prepare("SELECT NOT EXISTS(SELECT 1 FROM card_dependencies d JOIN cards k ON "
                "k.id=d.required_card_id JOIN columns c ON c.id=k.column_id WHERE "
                "d.card_id=?1 AND (k.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL "
                "OR (k.completed=0 AND NOT EXISTS(SELECT 1 FROM "
                "json_each(coalesce(?2,'[]')) j WHERE j.value=k.id))))");
    sqlite3_bind_int64(s, 1, card);
    if (completed_ids)
        bind_text(s, 2, completed_ids);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok;
}
/* Stable board-scoped keys are portable between databases; SQL paths are bound.
 */
static bool valid_plan_key(const char *key) {
    if (!key || key[0] < 'a' || key[0] > 'z' || strlen(key) > 40)
        return false;
    for (const char *p = key + 1; *p; p++)
        if (!(*p >= 'a' && *p <= 'z') && !(*p >= '0' && *p <= '9') && *p != '_')
            return false;
    return true;
}
static int json_object_field(const char *body, const char *field, char **out) {
    char path[80];
    snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2)");
    bind_text(s, 1, body);
    bind_text(s, 2, path);
    int p = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type)
            p = 0;
        else if (!strcmp(type, "object")) {
            *out = copy_string((const char *)sqlite3_column_text(s, 1));
            p = 1;
        }
    }
    sqlite3_finalize(s);
    return p == 1 && !valid_object(*out) ? -1 : p;
}
static bool custom_text_valid(const char *value, int bytes) {
    if (!value || bytes < 0 || strlen(value) != (size_t)bytes || bytes > 8000 ||
        !valid_utf8(value, (size_t)bytes))
        return false;
    size_t characters = 0;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++)
        if ((*p & 0xc0) != 0x80)
            characters++;
    return characters <= 2000;
}
static bool valid_custom_values(int64_t board, const char *values) {
    sqlite3_stmt *s = prepare("SELECT j.key,j.type,j.value,f.type,f.options,f.deleted_at "
                              "FROM json_each(?1) j LEFT JOIN custom_fields f ON f.board_id=?2 "
                              "AND f.key=j.key");
    bind_text(s, 1, values);
    sqlite3_bind_int64(s, 2, board);
    bool valid = true;
    int count = 0;
    while (sqlite3_step(s) == SQLITE_ROW) {
        const char *key = (const char *)sqlite3_column_text(s, 0),
                   *type = (const char *)sqlite3_column_text(s, 1),
                   *value = (const char *)sqlite3_column_text(s, 2),
                   *expected = (const char *)sqlite3_column_text(s, 3);
        if (++count > 100 || !valid_plan_key(key) || !expected ||
            (!importing_plan && sqlite3_column_type(s, 5) != SQLITE_NULL)) {
            valid = false;
            break;
        }
        if (!strcmp(type, "null"))
            continue;
        if (!strcmp(type, "text") &&
            (!value || strlen(value) != (size_t)sqlite3_column_bytes(s, 2) ||
             !valid_utf8(value, strlen(value)))) {
            valid = false;
            break;
        }
        if (!strcmp(expected, "text"))
            valid = !strcmp(type, "text") && custom_text_valid(value, sqlite3_column_bytes(s, 2));
        else if (!strcmp(expected, "number"))
            valid = (!strcmp(type, "integer") || !strcmp(type, "real")) &&
                    sqlite3_column_double(s, 2) >= -1e12 && sqlite3_column_double(s, 2) <= 1e12;
        else if (!strcmp(expected, "date"))
            valid = !strcmp(type, "text") && value && strlen(value) == 10 && valid_date(value);
        else if (!strcmp(expected, "boolean"))
            valid = !strcmp(type, "true") || !strcmp(type, "false");
        else {
            valid = !strcmp(type, "text") && value &&
                    strlen(value) == (size_t)sqlite3_column_bytes(s, 2);
            if (valid) {
                sqlite3_stmt *option =
                    prepare("SELECT EXISTS(SELECT 1 FROM json_each(?1) WHERE value=?2)");
                bind_text(option, 1, (const char *)sqlite3_column_text(s, 4));
                bind_text(option, 2, value);
                valid = sqlite3_step(option) == SQLITE_ROW && sqlite3_column_int(option, 0);
                sqlite3_finalize(option);
            }
        }
        if (!valid)
            break;
    }
    sqlite3_finalize(s);
    return valid;
}
static bool valid_milestone(int64_t board, const char *key) {
    if (!key || !*key)
        return true;
    if (!valid_plan_key(key))
        return false;
    sqlite3_stmt *s = prepare("SELECT EXISTS(SELECT 1 FROM milestones WHERE board_id=?1 AND "
                              "key=?2 AND (?3 OR deleted_at IS NULL))");
    sqlite3_bind_int64(s, 1, board);
    bind_text(s, 2, key);
    sqlite3_bind_int(s, 3, importing_plan);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok;
}
static Response save_card(Request *r, int64_t id, bool create) {
    const char *fields[] = {"title",          "description",  "label",    "due_date",
                            "assignee",       "cover",        "priority", "start_date",
                            "blocked_reason", "reference_url"};
    size_t limits[] = {300, 10000, 30, 10, 100, 20, 10, 10, 1000, 2000};
    const char *priorities[] = {"low", "normal", "high", "urgent"};
    char *values[10] = {0}, *checklist = NULL, *multi_labels = NULL, *assignee_ids = NULL,
         *custom_values = NULL, *milestone = NULL;
    int64_t completed = 0, target_column = 0, position = 0, archived = 0, estimate = 0, actual = 0;
    int cp = json_integer(r->body, "completed", &completed, 0, 1, true),
        colp = json_integer(r->body, "column_id", &target_column, 1, INT64_MAX, false),
        pp = json_integer(r->body, "position", &position, 0, INT_MAX, false),
        ap = json_integer(r->body, "archived", &archived, 0, 1, true),
        ep = json_integer(r->body, "estimate_minutes", &estimate, 0, 100000, false),
        kp = json_checklist(r->body, &checklist), lp = json_labels(r->body, &multi_labels),
        acp = json_integer(r->body, "actual_minutes", &actual, 0, 1000000, false),
        aip = json_assignee_ids(r->body, "assignee_ids", &assignee_ids),
        cvp = json_object_field(r->body, "custom_values", &custom_values),
        mp = json_string(r->body, "milestone_key", &milestone, 40);
    bool valid = cp >= 0 && colp >= 0 && pp >= 0 && ap >= 0 && ep >= 0 && kp >= 0 && lp >= 0 &&
                 acp >= 0 && aip >= 0 && cvp >= 0 && mp >= 0;
    int titlep = 0;
    for (size_t i = 0; i < 10; i++) {
        int p = json_string(r->body, fields[i], &values[i], limits[i]);
        valid = valid && p >= 0;
        if (i == 0)
            titlep = p;
    }
    valid = valid && (!create || titlep == 1) && (!values[0] || nonblank(values[0])) &&
            (!values[2] || one_of(values[2], labels, COUNT_OF(labels))) &&
            (!values[3] || valid_date(values[3])) &&
            (!values[5] || one_of(values[5], covers, COUNT_OF(covers))) &&
            (!values[6] || one_of(values[6], priorities, 4)) &&
            (!values[7] || valid_date(values[7])) && (!values[9] || valid_reference_url(values[9]));
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
    int64_t source_column = create ? id
                                   : scalar_id("SELECT column_id FROM cards WHERE "
                                               "id=?1 AND deleted_at IS NULL",
                                               id);
    if (!source_column || !accessible(r, create ? "columns" : "cards", id, true, false)) {
        result = error_response(404, "Scheda o lista non trovata.");
        goto done;
    }
    if (!create && !precondition(r, "cards", id)) {
        result =
            error_response(412, "Scheda modificata da un altro utente. Ricarica prima di salvare.");
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
    if (assignee_ids && !valid_assignees(source_board, assignee_ids)) {
        result = error_response(400, "Gli assegnatari devono essere utenti attivi della bacheca.");
        goto done;
    }
    if ((custom_values && !valid_custom_values(source_board, custom_values)) ||
        (milestone && !valid_milestone(source_board, milestone))) {
        result = error_response(400, "Campi personalizzati o traguardo non validi per la bacheca.");
        goto done;
    }
    char *stored_start = NULL, *stored_due = NULL;
    if (!create && (!values[3] || !values[7])) {
        sqlite3_stmt *dates = prepare("SELECT start_date,due_date FROM cards WHERE id=?1");
        sqlite3_bind_int64(dates, 1, id);
        if (sqlite3_step(dates) != SQLITE_ROW)
            db_die("Lettura date fallita");
        stored_start = copy_string((const char *)sqlite3_column_text(dates, 0));
        stored_due = copy_string((const char *)sqlite3_column_text(dates, 1));
        sqlite3_finalize(dates);
    }
    const char *start = values[7] ? values[7] : stored_start ? stored_start : "";
    const char *due = values[3] ? values[3] : stored_due ? stored_due : "";
    bool dates_valid = !*start || !*due || strcmp(start, due) <= 0;
    ob_free(stored_start);
    ob_free(stored_due);
    if (!dates_valid) {
        result = error_response(400, "La data di inizio deve precedere la scadenza.");
        goto done;
    }
    if (!create && cp && completed && !dependencies_complete(id, NULL)) {
        result = error_response(409, "Completa prima tutte le dipendenze della scheda.");
        goto done;
    }
    int64_t count = scalar_id(
        "SELECT count(*) FROM cards WHERE column_id=?1 AND deleted_at IS NULL", target_column);
    if (!create && source_column == target_column)
        count--;
    if (pp && position > count) {
        result = error_response(400, "Posizione della scheda non valida.");
        goto done;
    }
    int64_t old_completed = create ? 0 : scalar_id("SELECT completed FROM cards WHERE id=?1", id),
            old_archived = create ? 0 : scalar_id("SELECT archived FROM cards WHERE id=?1", id);
    bool active = !(cp ? completed : old_completed) && !(ap ? archived : old_archived);
    bool adds =
        active && (create || target_column != source_column || old_completed || old_archived);
    int64_t wip = scalar_id("SELECT wip_limit FROM columns WHERE id=?1", target_column);
    if (adds && wip &&
        scalar_id("SELECT count(*) FROM cards WHERE column_id=?1 AND deleted_at "
                  "IS NULL AND archived=0 AND completed=0",
                  target_column) >= wip) {
        result = error_response(409, "Limite WIP della lista raggiunto.");
        goto done;
    }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO "
                    "cards(column_id,title,description,label,due_date,assignee,"
                    "cover,completed,checklist,position,"
                    "priority,labels,estimate_minutes,archived,start_date,blocked_"
                    "reason,actual_minutes,reference_url)VALUES(?1,?2,?3,?4,?5,?6,?"
                    "7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)");
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
        bind_text(s, 15, values[7]);
        bind_text(s, 16, values[8]);
        sqlite3_bind_int64(s, 17, actual);
        bind_text(s, 18, values[9]);
    } else {
        s = prepare("UPDATE cards SET "
                    "title=coalesce(?2,title),description=coalesce(?3,description),label="
                    "coalesce(?4,label),due_date=coalesce(?"
                    "5,due_date),assignee=coalesce(?6,assignee),cover=coalesce(?7,cover),"
                    "completed=coalesce(?8,completed),"
                    "checklist=coalesce(?9,checklist),priority=coalesce(?10,priority),"
                    "labels=CASE WHEN ?11 IS NOT NULL THEN "
                    "?11 WHEN ?4 IS NOT NULL THEN CASE WHEN ?4='' THEN '[]' ELSE "
                    "json_array(?4) END ELSE labels "
                    "END,estimate_minutes=coalesce(?12,estimate_minutes),archived=coalesce("
                    "?13,archived),start_date=coalesce(?14,start_date),blocked_reason="
                    "coalesce(?15,blocked_reason),actual_minutes=coalesce(?16,actual_"
                    "minutes),reference_url=coalesce(?17,reference_url)WHERE id=?1");
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
        if (values[7])
            bind_text(s, 14, values[7]);
        if (values[8])
            bind_text(s, 15, values[8]);
        if (acp)
            sqlite3_bind_int64(s, 16, actual);
        if (values[9])
            bind_text(s, 17, values[9]);
    }
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    if (!ok) {
        result = error_response(503, "Impossibile salvare la scheda.");
        goto done;
    }
    if (create)
        id = sqlite3_last_insert_rowid(db);
    if (custom_values || milestone) {
        s = prepare("UPDATE cards SET "
                    "custom_values=json_patch(custom_values,coalesce(?2,'{}')),"
                    "milestone_key=coalesce(?3,milestone_key) WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (custom_values)
            bind_text(s, 2, custom_values);
        if (milestone)
            bind_text(s, 3, milestone);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Pianificazione scheda non salvata");
        sqlite3_finalize(s);
    }
    if (assignee_ids)
        write_assignees(id, assignee_ids);
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
        s = prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY "
                    "position,id)-1 n FROM cards WHERE column_id=?1 "
                    "AND id<>?2 AND deleted_at IS NULL)UPDATE cards SET "
                    "position=(SELECT n FROM ranked WHERE "
                    "ranked.id=cards.id)+CASE WHEN (SELECT n FROM ranked WHERE "
                    "ranked.id=cards.id)>=?3 THEN 1 ELSE 0 "
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
    for (size_t i = 0; i < 10; i++)
        ob_free(values[i]);
    ob_free(assignee_ids);
    ob_free(checklist);
    ob_free(multi_labels);
    ob_free(custom_values);
    ob_free(milestone);
    return result;
}
Response ob_create_card(Request *request, int64_t column, const char *payload) {
    if (!outer_transaction || sqlite3_get_autocommit(db) || !payload || !valid_object(payload))
        return error_response(503, "Creazione della scheda fuori transazione.");
    Request child = *request;
    child.body = (char *)payload;
    child.body_len = strlen(payload);
    child.if_match[0] = 0;
    child.idempotency_key[0] = 0;
    return save_card(&child, column, true);
}
static Response delete_resource(Request *r, const char *kind, int64_t id) {
    if (!accessible(r, kind, id, true, false))
        return error_response(404, "Risorsa non trovata.");
    if (!precondition(r, kind, id))
        return error_response(412, "Risorsa modificata da un altro utente.");
    int64_t board = resource_board(kind, id, false),
            parent = !strcmp(kind, "columns") ? board
                     : !strcmp(kind, "cards")
                         ? scalar_id("SELECT column_id FROM cards WHERE id=?1", id)
                         : 0;
    char sql[200];
    snprintf(sql, sizeof sql,
             "UPDATE %s SET "
             "deleted_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') WHERE id=?1",
             kind);
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
    snprintf(sql, sizeof sql, "SELECT count(*) FROM %s WHERE id=?1 AND deleted_at IS NOT NULL",
             kind);
    if (!scalar_id(sql, id))
        return error_response(409, "Risorsa già ripristinata.");
    if (strcmp(kind, "boards") &&
        scalar_id("SELECT count(*) FROM boards WHERE id=?1 AND deleted_at IS NOT NULL", board))
        return error_response(409, "Ripristina prima la bacheca.");
    int64_t parent = 0;
    if (!strcmp(kind, "cards")) {
        parent = scalar_id("SELECT column_id FROM cards WHERE id=?1", id);
        if (scalar_id("SELECT count(*) FROM columns WHERE id=?1 AND deleted_at IS "
                      "NOT NULL",
                      parent))
            return error_response(409, "Ripristina prima la lista.");
        int64_t wip = scalar_id("SELECT wip_limit FROM columns WHERE id=?1", parent);
        if (wip && !scalar_id("SELECT completed OR archived FROM cards WHERE id=?1", id) &&
            scalar_id("SELECT count(*) FROM cards WHERE column_id=?1 AND "
                      "deleted_at IS NULL AND archived=0 AND completed=0",
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
    /* Historical assignments remain on the source. A copy keeps only users who
     * can still read its board. */
    sqlite3_stmt *s = prepare("SELECT "
                              "json_set(json_remove(data,'$.position'),'$.assignee_ids',json(("
                              "SELECT json_group_array(a.user_id) "
                              "FROM card_assignees a JOIN users u ON u.id=a.user_id WHERE "
                              "a.card_id=?1 AND ?2 AND u.active=1 AND "
                              "(u.role='admin' OR EXISTS(SELECT 1 FROM board_members m WHERE "
                              "m.user_id=u.id AND m.board_id=?3))))) "
                              "FROM ob_card_objects WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int(s, 2, ob_config.auth_enabled);
    sqlite3_bind_int64(s, 3, resource_board("cards", id, false));
    sqlite3_step(s);
    char *body = copy_string((const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    s = prepare("SELECT json_set(?1,'$.custom_values',json(coalesce((SELECT "
                "'{'||group_concat(json_quote(j.key)||':'||CASE j.type WHEN 'true' THEN "
                "'true' WHEN 'false' THEN 'false' ELSE json_quote(j.value) END)||'}' "
                "FROM json_each(?1,'$.custom_values') j JOIN custom_fields f ON "
                "f.key=j.key AND f.board_id=?2 AND f.deleted_at IS "
                "NULL),'{}')),'$.milestone_key',CASE WHEN EXISTS(SELECT 1 FROM "
                "milestones WHERE board_id=?2 AND key=json_extract(?1,'$.milestone_key') "
                "AND deleted_at IS NULL) THEN json_extract(?1,'$.milestone_key') ELSE '' "
                "END)");
    bind_text(s, 1, body);
    sqlite3_bind_int64(s, 2, resource_board("cards", id, false));
    sqlite3_step(s);
    char *filtered = copy_string((const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    ob_free(body);
    body = filtered;
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
    sqlite3_stmt *s = prepare("INSERT INTO boards(name,description,color,guidelines)SELECT "
                              "coalesce(?2,substr(name,1,192)||' "
                              "(copia)'),description,color,guidelines FROM boards WHERE id=?1");
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
    s = prepare("INSERT INTO "
                "custom_fields(board_id,key,name,type,options,position,deleted_"
                "at) SELECT ?2,key,name,type,options,position,deleted_at FROM "
                "custom_fields WHERE board_id=?1");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, newboard);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Duplicazione campi fallita");
    sqlite3_finalize(s);
    s = prepare("INSERT INTO "
                "milestones(board_id,key,title,due_date,completed,deleted_at) "
                "SELECT ?2,key,title,due_date,completed,deleted_at FROM "
                "milestones WHERE board_id=?1");
    sqlite3_bind_int64(s, 1, id);
    sqlite3_bind_int64(s, 2, newboard);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Duplicazione traguardi fallita");
    sqlite3_finalize(s);
    s = prepare("SELECT id,title,position,wip_limit FROM columns WHERE "
                "board_id=?1 AND deleted_at IS NULL ORDER BY "
                "position,id");
    sqlite3_bind_int64(s, 1, id);
    while (sqlite3_step(s) == SQLITE_ROW) {
        sqlite3_stmt *c = prepare("INSERT INTO "
                                  "columns(board_id,title,position,wip_limit)VALUES(?1,?2,?3,?4)");
        sqlite3_bind_int64(c, 1, newboard);
        bind_text(c, 2, (const char *)sqlite3_column_text(s, 1));
        sqlite3_bind_int64(c, 3, sqlite3_column_int64(s, 2));
        sqlite3_bind_int64(c, 4, sqlite3_column_int64(s, 3));
        if (sqlite3_step(c) != SQLITE_DONE)
            db_die("Duplicazione lista fallita");
        sqlite3_finalize(c);
        int64_t nc = sqlite3_last_insert_rowid(db);
        c = prepare("INSERT INTO "
                    "cards(column_id,title,description,label,due_date,assignee,cover,"
                    "position,completed,checklist,"
                    "priority,labels,estimate_minutes,archived,start_date,blocked_reason,"
                    "actual_minutes,reference_url,custom_values,milestone_key)SELECT "
                    "?2,title,description,label,due_date,assignee,cover,position,completed,"
                    "checklist,priority,labels,"
                    "estimate_minutes,archived,start_date,blocked_reason,actual_minutes,"
                    "reference_url,custom_values,milestone_key FROM cards WHERE "
                    "column_id=?1 AND deleted_at IS NULL");
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
        return query_json("SELECT json_object('comments',json((SELECT "
                          "json_group_array(json(item))FROM(SELECT "
                          "json_object('id',id,'body',body,'author_id',author_id,'"
                          "author',author,'created_at',created_"
                          "at,'version',version,'edited_at',edited_at)item FROM "
                          "comments WHERE card_id=?1 ORDER BY id))))",
                          id);
    char *body = NULL;
    if (json_string(r->body, "body", &body, 5000) != 1 || !body || !nonblank(body)) {
        ob_free(body);
        return error_response(400, "Il commento deve contenere da 1 a 5000 caratteri.");
    }
    char *actor = actor_name(r);
    sqlite3_stmt *s =
        prepare("INSERT INTO comments(card_id,author_id,author,body)VALUES(?1,?2,?3,?4)");
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
    return query_json("SELECT json_object('events',json((SELECT "
                      "json_group_array(json(item))FROM(SELECT "
                      "json_object('id',id,'action',action,'entity_type',entity_"
                      "type,'entity_id',entity_id,'title',"
                      "title,'actor',actor,'actor_id',actor_id,'created_at',"
                      "created_at)item FROM activity WHERE "
                      "board_id=?1 ORDER BY id DESC LIMIT 200))))",
                      id);
}
static Response board_stats(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    return query_json("WITH active AS(SELECT k.* FROM cards k JOIN columns c ON "
                      "c.id=k.column_id WHERE c.board_id=?1 AND "
                      "k.deleted_at IS NULL AND k.archived=0 AND c.deleted_at IS NULL)SELECT "
                      "json_object('total',(SELECT "
                      "count(*)FROM active),'completed',(SELECT count(*)FROM active WHERE "
                      "completed=1),'overdue',(SELECT "
                      "count(*)FROM active WHERE completed=0 AND due_date<>'' AND "
                      "due_date<date('now')),'estimate_minutes',(SELECT "
                      "coalesce(sum(estimate_minutes),0)FROM active),'by_label',json((SELECT "
                      "json_group_object(label,n)FROM(SELECT "
                      "j.value label,count(*)n FROM active a,json_each(a.labels)j GROUP BY "
                      "j.value))),'by_assignee',json((SELECT "
                      "json_group_object(assignee,n)FROM(SELECT CASE WHEN assignee='' THEN "
                      "'Non assegnato' ELSE assignee END "
                      "assignee,count(*)n FROM active GROUP BY CASE WHEN assignee='' THEN 'Non "
                      "assegnato' ELSE assignee "
                      "END))),'by_priority',json((SELECT "
                      "json_group_object(priority,n)FROM(SELECT priority,count(*)n FROM active "
                      "GROUP BY priority))))",
                      id);
}
static Response trash_api(void) {
    return query_json("SELECT json_object('items',json((SELECT "
                      "json_group_array(json(item))FROM(SELECT "
                      "json_object('kind','boards','id',id,'title',name,'deleted_at',deleted_"
                      "at,'board_id',id)item,"
                      "deleted_at FROM boards WHERE deleted_at IS NOT NULL AND ob_allowed(id) "
                      "UNION ALL SELECT "
                      "json_object('kind','columns','id',id,'title',title,'deleted_at',deleted_"
                      "at,'board_id',board_id),"
                      "deleted_at FROM columns WHERE deleted_at IS NOT NULL AND "
                      "ob_allowed(board_id) UNION ALL SELECT "
                      "json_object('kind','cards','id',k.id,'title',k.title,'deleted_at',k."
                      "deleted_at,'board_id',c."
                      "board_id),k.deleted_at FROM cards k JOIN columns c ON c.id=k.column_id "
                      "WHERE k.deleted_at IS "
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
    sqlite3_stmt *s = prepare("SELECT json_object('cards',json((SELECT "
                              "json_group_array(json(item))FROM(SELECT "
                              "json_object('id',k.id,'title',k.title,'board_id',b.id,'board_"
                              "name',b.name,'column_title',c.title,'"
                              "priority',k.priority,'due_date',k.due_date)item FROM cards k "
                              "JOIN columns c ON c.id=k.column_id JOIN "
                              "boards b ON b.id=c.board_id WHERE k.deleted_at IS NULL AND "
                              "c.deleted_at IS NULL AND b.deleted_at IS "
                              "NULL AND (ob_archived() OR(k.archived=0 AND b.archived=0))AND "
                              "ob_allowed(b.id) "
                              "AND(instr(lower(k.title),lower(?1))>0 OR "
                              "instr(lower(k.description),lower(?1))>0 OR "
                              "instr(lower(k.assignee),lower(?1))>0)ORDER BY k.updated_at DESC "
                              "LIMIT 200))))");
    bind_text(s, 1, term);
    Response result = sqlite3_step(s) == SQLITE_ROW
                          ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                          : error_response(503, "Ricerca temporaneamente non disponibile.");
    sqlite3_finalize(s);
    return result;
}
static Response fields_list(Request *r, int64_t board) {
    if (!accessible(r, "boards", board, false, false))
        return error_response(404, "Bacheca non trovata.");
    char option[32];
    bool deleted = query_value(r, "include_deleted", option, sizeof option) && !strcmp(option, "1");
    sqlite3_stmt *s = prepare("SELECT json_object('fields',json((SELECT "
                              "json_group_array(json(item)) FROM ("
                              "SELECT "
                              "json_object('id',id,'key',key,'name',name,'type',type,'options',"
                              "json(options),'position',position,'deleted_at',deleted_at) item "
                              "FROM custom_fields WHERE board_id=?1 AND (?2 OR deleted_at IS "
                              "NULL) ORDER BY position,id))))");
    sqlite3_bind_int64(s, 1, board);
    sqlite3_bind_int(s, 2, deleted);
    Response out = sqlite3_step(s) == SQLITE_ROW
                       ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                       : error_response(503, "Campi non disponibili.");
    sqlite3_finalize(s);
    return out;
}
static Response field_save(Request *r, int64_t id, bool create) {
    int64_t board = create ? id
                           : scalar_id("SELECT board_id FROM custom_fields WHERE "
                                       "id=?1 AND deleted_at IS NULL",
                                       id);
    if (!board || !accessible(r, "boards", board, true, false))
        return error_response(404, "Campo o bacheca non trovati.");
    char *key = NULL, *name = NULL, *type = NULL, *options = NULL;
    int64_t position = 0;
    int kp = json_string(r->body, "key", &key, 40), np = json_string(r->body, "name", &name, 100),
        tp = json_string(r->body, "type", &type, 10),
        pp = json_integer(r->body, "position", &position, 0, INT_MAX, false);
    Response out;
    if (kp < 0 || np < 0 || tp < 0 || pp < 0 || (name && !nonblank(name)) ||
        (create && (kp != 1 || np != 1 || tp != 1 || !valid_plan_key(key))) ||
        (!create && (kp || tp))) {
        out = error_response(400, "Definizione campo non valida; chiave e tipo sono immutabili.");
        goto done;
    }
    if (create) {
        const char *types[] = {"text", "number", "date", "boolean", "select"};
        if (!one_of(type, types, COUNT_OF(types))) {
            out = error_response(400, "Tipo campo non valido.");
            goto done;
        }
        sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.options'),json_extract(?1,'$.options')");
        bind_text(s, 1, r->body);
        bool valid = sqlite3_step(s) == SQLITE_ROW;
        const char *ot = valid ? (const char *)sqlite3_column_text(s, 0) : NULL;
        if (ot && strcmp(ot, "array"))
            valid = false;
        options = copy_string(ot && valid ? (const char *)sqlite3_column_text(s, 1) : "[]");
        sqlite3_finalize(s);
        s = prepare("SELECT json_array_length(?1)<=30 AND NOT EXISTS(SELECT 1 FROM "
                    "json_each(?1) WHERE type<>'text' OR length(value) NOT BETWEEN "
                    "1 AND 100 OR instr(value,char(0))>0) AND NOT EXISTS(SELECT 1 "
                    "FROM json_each(?1) GROUP BY value HAVING count(*)>1)");
        bind_text(s, 1, options);
        valid = valid && sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        if (valid) {
            s = prepare("SELECT value FROM json_each(?1)");
            bind_text(s, 1, options);
            while (sqlite3_step(s) == SQLITE_ROW) {
                const char *value = (const char *)sqlite3_column_text(s, 0);
                if (!value || strlen(value) != (size_t)sqlite3_column_bytes(s, 0) ||
                    !valid_utf8(value, strlen(value))) {
                    valid = false;
                    break;
                }
            }
            sqlite3_finalize(s);
        }
        if (!valid || (!strcmp(type, "select") ? !strcmp(options, "[]") : strcmp(options, "[]"))) {
            out = error_response(400, "Opzioni campo non valide.");
            goto done;
        }
        if (scalar_id("SELECT count(*) FROM custom_fields WHERE board_id=?1", board) >= 100 ||
            (!importing_plan &&
             scalar_id("SELECT count(*) FROM custom_fields WHERE board_id=?1 AND "
                       "deleted_at IS NULL",
                       board) >= 20)) {
            out = error_response(409, "Limite campi della bacheca raggiunto.");
            goto done;
        }
        int64_t count = scalar_id("SELECT count(*) FROM custom_fields WHERE "
                                  "board_id=?1 AND deleted_at IS NULL",
                                  board);
        if (pp && position > count) {
            out = error_response(400, "Posizione campo non valida.");
            goto done;
        }
        s = prepare("INSERT INTO custom_fields(board_id,key,name,type,options,position) "
                    "VALUES(?1,?2,?3,?4,?5,?6)");
        sqlite3_bind_int64(s, 1, board);
        bind_text(s, 2, key);
        bind_text(s, 3, name);
        bind_text(s, 4, type);
        bind_text(s, 5, options);
        sqlite3_bind_int64(s, 6, count);
        int rc = sqlite3_step(s);
        sqlite3_finalize(s);
        if (rc != SQLITE_DONE) {
            out = error_response(rc == SQLITE_CONSTRAINT ? 409 : 503,
                                 "Chiave campo già presente o salvataggio non disponibile.");
            goto done;
        }
        id = sqlite3_last_insert_rowid(db);
    } else {
        sqlite3_stmt *s = prepare("UPDATE custom_fields SET name=coalesce(?2,name) WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (name)
            bind_text(s, 2, name);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Campo non salvato");
        sqlite3_finalize(s);
    }
    if (pp) {
        int64_t count = scalar_id("SELECT count(*) FROM custom_fields WHERE "
                                  "board_id=?1 AND deleted_at IS NULL",
                                  board);
        if (position >= count) {
            out = error_response(400, "Posizione campo non valida.");
            goto done;
        }
        sqlite3_stmt *s =
            prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n "
                    "FROM custom_fields WHERE board_id=?1 AND id<>?2 AND deleted_at IS "
                    "NULL) UPDATE custom_fields SET position=(SELECT n FROM ranked WHERE "
                    "ranked.id=custom_fields.id)+CASE WHEN(SELECT n FROM ranked WHERE "
                    "ranked.id=custom_fields.id)>=?3 THEN 1 ELSE 0 END WHERE board_id=?1 "
                    "AND id<>?2 AND deleted_at IS NULL");
        sqlite3_bind_int64(s, 1, board);
        sqlite3_bind_int64(s, 2, id);
        sqlite3_bind_int64(s, 3, position);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino campi fallito");
        sqlite3_finalize(s);
        s = prepare("UPDATE custom_fields SET position=?2 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, position);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino campo fallito");
        sqlite3_finalize(s);
    }
    record_event(r, board, create ? "field_created" : "field_updated", "custom_fields", id,
                 name ? name : "");
    out = success(create ? 201 : 200, id);
done:
    ob_free(key);
    ob_free(name);
    ob_free(type);
    ob_free(options);
    return out;
}
static Response plan_delete_restore(Request *r, const char *table, int64_t id, bool restore) {
    char sql[400];
    snprintf(sql, sizeof sql, "SELECT board_id FROM %s WHERE id=?1 AND deleted_at IS %s NULL",
             table, restore ? "NOT" : "");
    int64_t board = scalar_id(sql, id);
    if (!board || !accessible(r, "boards", board, true, false))
        return error_response(404, "Elemento o bacheca non trovati.");
    if (restore) {
        snprintf(sql, sizeof sql,
                 "SELECT count(*) FROM %s WHERE board_id=?1 AND deleted_at IS NULL", table);
        if (scalar_id(sql, board) >= (!strcmp(table, "custom_fields") ? 20 : 100))
            return error_response(409, "Limite elementi attivi raggiunto.");
    }
    snprintf(sql, sizeof sql, "UPDATE %s SET deleted_at=%s WHERE id=?1", table,
             restore ? "NULL" : "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    if (!run_id(sql, id))
        db_die("Elemento non salvato");
    if (!strcmp(table, "custom_fields")) {
        sqlite3_stmt *s;
        if (restore) {
            s = prepare("UPDATE custom_fields SET position=(SELECT count(*)-1 FROM "
                        "custom_fields WHERE board_id=?2 AND deleted_at IS NULL) "
                        "WHERE id=?1");
            sqlite3_bind_int64(s, 1, id);
            sqlite3_bind_int64(s, 2, board);
            if (sqlite3_step(s) != SQLITE_DONE)
                db_die("Riordino campo ripristinato fallito");
            sqlite3_finalize(s);
        }
        s = prepare("WITH ranked AS(SELECT id,row_number()OVER(ORDER BY position,id)-1 n "
                    "FROM custom_fields WHERE board_id=?1 AND deleted_at IS NULL) UPDATE "
                    "custom_fields SET position=(SELECT n FROM ranked WHERE "
                    "ranked.id=custom_fields.id) WHERE board_id=?1 AND deleted_at IS NULL");
        sqlite3_bind_int64(s, 1, board);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Riordino campi fallito");
        sqlite3_finalize(s);
    }
    record_event(r, board, restore ? "restored" : "deleted", table, id, "");
    return success(200, id);
}
static Response milestones_list(Request *r, int64_t board) {
    if (!accessible(r, "boards", board, false, false))
        return error_response(404, "Bacheca non trovata.");
    char option[32];
    bool deleted = query_value(r, "include_deleted", option, sizeof option) && !strcmp(option, "1"),
         overdue = query_value(r, "overdue", option, sizeof option) && !strcmp(option, "1");
    sqlite3_stmt *s =
        prepare("SELECT json_object('milestones',json((SELECT "
                "json_group_array(json(item)) FROM(SELECT "
                "json_object('id',m.id,'key',m.key,'title',m.title,'due_date',m.due_date,"
                "'completed',json(CASE m.completed WHEN 1 THEN 'true' ELSE 'false' "
                "END),'deleted_at',m.deleted_at,'total',(SELECT count(*) FROM cards k "
                "JOIN columns c ON c.id=k.column_id WHERE c.board_id=m.board_id AND "
                "k.milestone_key=m.key AND c.deleted_at IS NULL AND k.deleted_at IS NULL "
                "AND k.archived=0),'done',(SELECT count(*) FROM cards k JOIN columns c "
                "ON c.id=k.column_id WHERE c.board_id=m.board_id AND "
                "k.milestone_key=m.key AND c.deleted_at IS NULL AND k.deleted_at IS NULL "
                "AND k.archived=0 AND k.completed=1),'overdue',json(CASE WHEN "
                "m.completed=0 AND m.deleted_at IS NULL AND m.due_date<>'' AND "
                "m.due_date<date('now') THEN 'true' ELSE 'false' END))item FROM "
                "milestones m WHERE board_id=?1 AND (?2 OR deleted_at IS NULL) AND (NOT "
                "?3 OR(m.completed=0 AND m.deleted_at IS NULL AND m.due_date<>'' AND "
                "m.due_date<date('now'))) ORDER BY m.due_date='',m.due_date,m.id))))");
    sqlite3_bind_int64(s, 1, board);
    sqlite3_bind_int(s, 2, deleted);
    sqlite3_bind_int(s, 3, overdue);
    Response out = sqlite3_step(s) == SQLITE_ROW
                       ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                       : error_response(503, "Traguardi non disponibili.");
    sqlite3_finalize(s);
    return out;
}
static Response milestone_save(Request *r, int64_t id, bool create) {
    int64_t board = create ? id
                           : scalar_id("SELECT board_id FROM milestones WHERE "
                                       "id=?1 AND deleted_at IS NULL",
                                       id);
    if (!board || !accessible(r, "boards", board, true, false))
        return error_response(404, "Traguardo o bacheca non trovati.");
    char *key = NULL, *title = NULL, *due = NULL;
    int64_t completed = 0;
    int kp = json_string(r->body, "key", &key, 40), tp = json_string(r->body, "title", &title, 200),
        dp = json_string(r->body, "due_date", &due, 10),
        cp = json_integer(r->body, "completed", &completed, 0, 1, true);
    Response out;
    if (kp < 0 || tp < 0 || dp < 0 || cp < 0 || (create && tp != 1) ||
        (title && !nonblank(title)) || (due && !valid_date(due)) || (key && !valid_plan_key(key)) ||
        (!create && kp)) {
        out = error_response(400, "Traguardo non valido; la chiave è immutabile.");
        goto done;
    }
    sqlite3_stmt *s;
    if (create) {
        if (scalar_id("SELECT count(*) FROM milestones WHERE board_id=?1", board) >= 200 ||
            (!importing_plan && scalar_id("SELECT count(*) FROM milestones WHERE "
                                          "board_id=?1 AND deleted_at IS NULL",
                                          board) >= 100)) {
            out = error_response(409, "Limite traguardi raggiunto.");
            goto done;
        }
        if (!key) {
            s = prepare("SELECT 'm_'||lower(hex(randomblob(8)))");
            sqlite3_step(s);
            key = copy_string((const char *)sqlite3_column_text(s, 0));
            sqlite3_finalize(s);
        }
        s = prepare("INSERT INTO milestones(board_id,key,title,due_date,completed) "
                    "VALUES(?1,?2,?3,?4,?5)");
        sqlite3_bind_int64(s, 1, board);
        bind_text(s, 2, key);
        bind_text(s, 3, title);
        bind_text(s, 4, due);
        sqlite3_bind_int64(s, 5, completed);
    } else {
        s = prepare("UPDATE milestones SET "
                    "title=coalesce(?2,title),due_date=coalesce(?3,due_date),"
                    "completed=coalesce(?4,completed) WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (title)
            bind_text(s, 2, title);
        if (due)
            bind_text(s, 3, due);
        if (cp)
            sqlite3_bind_int64(s, 4, completed);
    }
    int rc = sqlite3_step(s);
    sqlite3_finalize(s);
    if (rc != SQLITE_DONE) {
        out = error_response(rc == SQLITE_CONSTRAINT ? 409 : 503,
                             "Chiave traguardo già presente o salvataggio non disponibile.");
        goto done;
    }
    if (create)
        id = sqlite3_last_insert_rowid(db);
    record_event(r, board, create ? "milestone_created" : "milestone_updated", "milestones", id,
                 title ? title : "");
    out = success(create ? 201 : 200, id);
done:
    ob_free(key);
    ob_free(title);
    ob_free(due);
    return out;
}
static Response custom_values_api(Request *r, int64_t id, bool get) {
    if (!accessible(r, "cards", id, !get, false))
        return error_response(404, "Scheda non trovata.");
    if (get)
        return query_json("SELECT json_object('values',json(custom_values),'version',version) "
                          "FROM cards WHERE id=?1",
                          id);
    char *values = NULL;
    if (json_object_field(r->body, "values", &values) != 1 ||
        !valid_custom_values(resource_board("cards", id, false), values)) {
        ob_free(values);
        return error_response(400, "Valori campo non validi.");
    }
    if (!precondition(r, "cards", id)) {
        ob_free(values);
        return error_response(412, "Scheda modificata da un altro utente.");
    }
    sqlite3_stmt *s = prepare("UPDATE cards SET custom_values=json_patch(custom_values,?2) "
                              "WHERE id=?1");
    sqlite3_bind_int64(s, 1, id);
    bind_text(s, 2, values);
    ob_free(values);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Valori campo non salvati");
    sqlite3_finalize(s);
    record_event(r, resource_board("cards", id, false), "fields_updated", "cards", id, "");
    return mutation_success(200, "cards", id);
}
static Response field_search(Request *r, int64_t board) {
    if (!accessible(r, "boards", board, false, false))
        return error_response(404, "Bacheca non trovata.");
    char key[164], value[8192];
    if (!query_value(r, "key", key, sizeof key) || !valid_plan_key(key) ||
        !query_value(r, "value", value, sizeof value))
        return error_response(400, "Chiave e valore JSON richiesti.");
    sqlite3_stmt *s = prepare("SELECT json_valid(?1)");
    bind_text(s, 1, value);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid)
        return error_response(400, "Valore JSON non valido.");
    s = prepare("SELECT json_object(?1,json(?2))");
    bind_text(s, 1, key);
    bind_text(s, 2, value);
    sqlite3_step(s);
    char *check = copy_string((const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    valid = valid_custom_values(board, check);
    ob_free(check);
    if (!valid)
        return error_response(400, "Campo o valore non valido.");
    s = prepare("SELECT json_object('cards',json((SELECT "
                "json_group_array(json(k.summary)) FROM ob_card_objects k JOIN columns c "
                "ON c.id=k.column_id WHERE c.board_id=?1 AND c.deleted_at IS NULL AND "
                "k.deleted_at IS NULL AND k.archived=0 AND EXISTS(SELECT 1 FROM "
                "json_each(k.custom_values) j WHERE j.key=?2 AND (j.type=json_type(?3) "
                "OR(j.type IN('integer','real') AND json_type(?3) IN('integer','real'))) "
                "AND j.value IS json_extract(?3,'$')))))");
    sqlite3_bind_int64(s, 1, board);
    bind_text(s, 2, key);
    bind_text(s, 3, value);
    Response out = sqlite3_step(s) == SQLITE_ROW
                       ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                       : error_response(503, "Ricerca campi non disponibile.");
    sqlite3_finalize(s);
    return out;
}
static Response workload_api(Request *r, int64_t board) {
    if (!accessible(r, "boards", board, false, false))
        return error_response(404, "Bacheca non trovata.");
    return query_json("WITH active AS(SELECT k.*,coalesce((SELECT sum(minutes) FROM worklogs "
                      "WHERE card_id=k.id AND deleted_at IS NULL),0) logged FROM cards k JOIN "
                      "columns c ON c.id=k.column_id WHERE c.board_id=?1 AND c.deleted_at IS "
                      "NULL AND k.deleted_at IS NULL AND k.archived=0) SELECT "
                      "json_object('total',count(*),'completed',coalesce(sum(completed),0),'"
                      "blocked',coalesce(sum(blocked_reason<>'' OR EXISTS(SELECT 1 FROM "
                      "card_dependencies d JOIN cards p ON p.id=d.required_card_id JOIN "
                      "columns pc ON pc.id=p.column_id WHERE d.card_id=active.id AND "
                      "(p.completed=0 OR p.deleted_at IS NOT NULL OR pc.deleted_at IS NOT "
                      "NULL))),0),'estimate_minutes',coalesce(sum(estimate_minutes),0),'actual_"
                      "minutes',coalesce(sum(actual_minutes),0),'logged_minutes',coalesce(sum("
                      "logged),0),'total_minutes',coalesce(sum(actual_minutes+logged),0),'by_"
                      "priority',json((SELECT json_group_object(priority,n) FROM(SELECT "
                      "priority,count(*) n FROM active GROUP BY "
                      "priority))),'by_milestone',json((SELECT "
                      "json_group_array(json_object('key',milestone_key,'title',coalesce(("
                      "SELECT title FROM milestones m WHERE m.board_id=?1 AND "
                      "m.key=milestone_key),'Senza "
                      "traguardo'),'total',n,'completed',done,'estimate_minutes',estimate,'"
                      "total_minutes',actual)) FROM(SELECT milestone_key,count(*) "
                      "n,sum(completed) done,sum(estimate_minutes) "
                      "estimate,sum(actual_minutes+logged) actual FROM active GROUP BY "
                      "milestone_key))),'cards',json((SELECT "
                      "json_group_array(json_object('id',id,'title',title,'priority',priority,'"
                      "milestone_key',milestone_key,'estimate_minutes',estimate_minutes,'"
                      "actual_minutes',actual_minutes,'logged_minutes',logged,'total_minutes',"
                      "actual_minutes+logged,'completed',json(CASE completed WHEN 1 THEN "
                      "'true' ELSE 'false' END),'blocked_reason',blocked_reason)) FROM "
                      "active))) FROM active",
                      board);
}
static Response export_board(Request *r, int64_t id) {
    if (!accessible(r, "boards", id, false, false))
        return error_response(404, "Bacheca non trovata.");
    bool old_summary = summary_mode, old_archive = include_archived;
    summary_mode = false;
    include_archived = true;
    Response out = query_json("SELECT "
                              "json_object('format','openboard','version',2,'board',json("
                              "data))FROM ob_board_objects WHERE id=?1",
                              id);
    summary_mode = old_summary;
    include_archived = old_archive;
    snprintf(out.headers, sizeof out.headers,
             "Content-Disposition: attachment; filename=\"openboard-%lld.json\"\r\n",
             (long long)id);
    return out;
}
/* Exports retain deleted definitions so hidden values can be restored after
 * transfer. */
static Response import_plan(Request *r, const char *board, int64_t bid) {
    const char *fields[] = {"custom_fields", "milestones"};
    bool old = importing_plan;
    importing_plan = true;
    Response out = {0};
    for (size_t i = 0; i < 2; i++) {
        char path[40];
        snprintf(path, sizeof path, "$.%s", fields[i]);
        sqlite3_stmt *check = prepare("SELECT json_type(?1,?2),json_array_length(?1,?2)");
        bind_text(check, 1, board);
        bind_text(check, 2, path);
        int rc = sqlite3_step(check);
        const char *type = rc == SQLITE_ROW ? (const char *)sqlite3_column_text(check, 0) : NULL;
        bool exists = type != NULL,
             valid = !exists ||
                     (!strcmp(type, "array") && sqlite3_column_int(check, 1) <= (i ? 200 : 100));
        sqlite3_finalize(check);
        if (!valid) {
            out = error_response(400, "Definizioni di pianificazione importate non valide.");
            break;
        }
        if (!exists)
            continue;
        sqlite3_stmt *s = prepare("SELECT value,type FROM json_each(?1,?2)");
        bind_text(s, 1, board);
        bind_text(s, 2, path);
        while (sqlite3_step(s) == SQLITE_ROW) {
            const char *item = (const char *)sqlite3_column_text(s, 0);
            if (strcmp((const char *)sqlite3_column_text(s, 1), "object") || !valid_object(item)) {
                out = error_response(400, "Definizione importata non valida.");
                break;
            }
            check = prepare("SELECT json_type(?1,'$.deleted_at'),json_remove(?1,'$.position')");
            bind_text(check, 1, item);
            sqlite3_step(check);
            const char *deleted_type = (const char *)sqlite3_column_text(check, 0);
            bool deleted = deleted_type && !strcmp(deleted_type, "text"),
                 dtvalid = !deleted_type || deleted || !strcmp(deleted_type, "null");
            char *body = copy_string((const char *)sqlite3_column_text(check, 1));
            sqlite3_finalize(check);
            if (!dtvalid) {
                ob_free(body);
                out = error_response(400, "Stato eliminazione importato non valido.");
                break;
            }
            Request part = *r;
            part.body = body;
            Response created = i ? milestone_save(&part, bid, true) : field_save(&part, bid, true);
            ob_free(body);
            if (created.status != 201) {
                out = created;
                break;
            }
            int64_t id = 0;
            json_integer(created.body, "id", &id, 1, INT64_MAX, false);
            ob_free(created.body);
            if (deleted) {
                char sql[200];
                snprintf(sql, sizeof sql,
                         "UPDATE %s SET "
                         "deleted_at=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now') WHERE id=?1",
                         i ? "milestones" : "custom_fields");
                if (!run_id(sql, id))
                    db_die("Importazione definizione eliminata fallita");
            }
        }
        sqlite3_finalize(s);
        if (out.status)
            break;
        char sql[160];
        snprintf(sql, sizeof sql,
                 "SELECT count(*) FROM %s WHERE board_id=?1 AND deleted_at IS NULL",
                 i ? "milestones" : "custom_fields");
        if (scalar_id(sql, bid) > (i ? 100 : 20)) {
            out = error_response(400, "Troppi elementi attivi nella pianificazione importata.");
            break;
        }
    }
    importing_plan = old;
    return out;
}
static Response import_board(Request *r) {
    char *format = NULL;
    int64_t version = 0;
    int fp = json_string(r->body, "format", &format, 20),
        vp = json_integer(r->body, "version", &version, 2, 2, false);
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
    s = prepare("SELECT json_type(?1,'$.columns')='array' AND "
                "json_array_length(?1,'$.columns')<=100");
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
    result = import_plan(r, board, bid);
    if (result.status) {
        ob_free(board);
        return result;
    }
    bool old_importing = importing_plan;
    importing_plan = true;
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
        sqlite3_stmt *j = prepare("SELECT "
                                  "json_type(?1,'$.cards')='array',json_remove(?1,'"
                                  "$.cards','$.position','$.wip_limit')");
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
                result = error_response(
                    400, "Scheda importata non valida o limite di 10000 schede superato.");
                bad = true;
                break;
            }
            sqlite3_stmt *k =
                prepare("SELECT json_remove(?1,'$.position','$.column_id','$.assignee_ids')");
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
    importing_plan = old_importing;
    if (result.status == 201) {
        ob_free(result.body);
        char *title = resource_title("boards", bid);
        record_event(r, bid, "imported", "boards", bid, title);
        ob_free(title);
        return mutation_success(201, "boards", bid);
    }
    return result;
}
static Response assignees_api(Request *r, int64_t id, bool get) {
    if (!accessible(r, "cards", id, !get, false))
        return error_response(404, "Scheda non trovata.");
    if (get)
        return query_json("SELECT json_object('assignees',json((SELECT "
                          "json_group_array(json_object('id',u.id,'name',u.name,'"
                          "username',u.username)) FROM card_assignees a JOIN users "
                          "u ON u.id=a.user_id WHERE a.card_id=?1)))",
                          id);
    if (!precondition(r, "cards", id))
        return error_response(412, "Scheda modificata da un altro utente.");
    char *ids = NULL;
    int p = json_assignee_ids(r->body, "user_ids", &ids);
    if (p != 1 || !valid_assignees(resource_board("cards", id, false), ids)) {
        ob_free(ids);
        return error_response(400, "Assegnatari non validi o non autorizzati alla bacheca.");
    }
    write_assignees(id, ids);
    ob_free(ids);
    char *title = resource_title("cards", id);
    record_event(r, resource_board("cards", id, false), "assigned", "cards", id, title);
    ob_free(title);
    return mutation_success(200, "cards", id);
}
static Response my_tasks(Request *r) {
    sqlite3_stmt *s =
        prepare("SELECT json_object('cards',json((SELECT json_group_array(json(item)) "
                "FROM(SELECT "
                "json_patch(k.data,json_object('board_id',b.id,'board_name',b.name,'"
                "column_title',c.title)) item FROM ob_card_objects k JOIN card_assignees "
                "a ON a.card_id=k.id JOIN columns c ON c.id=k.column_id JOIN boards b ON "
                "b.id=c.board_id WHERE a.user_id=?1 AND ob_allowed(b.id) AND "
                "b.deleted_at IS NULL AND c.deleted_at IS NULL AND k.deleted_at IS NULL "
                "AND b.archived=0 AND k.archived=0 AND k.completed=0 ORDER BY "
                "k.due_date='',k.due_date,k.id))))");
    sqlite3_bind_int64(s, 1, r->user_id);
    Response out = sqlite3_step(s) == SQLITE_ROW
                       ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                       : error_response(503, "Attività non disponibili.");
    sqlite3_finalize(s);
    return out;
}
static Response dependencies_api(Request *r, int64_t id, int64_t required, bool get, bool del) {
    if (!accessible(r, "cards", id, !get, false))
        return error_response(404, "Scheda non trovata.");
    if (get)
        return query_json("SELECT json_object('dependencies',json((SELECT "
                          "json_group_array(json_object('id',k.id,'title',k.title,'completed',"
                          "json(CASE WHEN k.completed=1 AND k.deleted_at IS NULL AND "
                          "c.deleted_at IS NULL THEN 'true' ELSE 'false' END))) FROM "
                          "card_dependencies d JOIN cards k ON k.id=d.required_card_id JOIN "
                          "columns c ON c.id=k.column_id WHERE d.card_id=?1)))",
                          id);
    if (!precondition(r, "cards", id))
        return error_response(412, "Scheda modificata da un altro utente.");
    if (del) {
        sqlite3_stmt *s = prepare("DELETE FROM card_dependencies WHERE card_id=?1 "
                                  "AND required_card_id=?2");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, required);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Dipendenza non rimossa");
        sqlite3_finalize(s);
    } else {
        if (json_integer(r->body, "required_card_id", &required, 1, INT64_MAX, false) != 1 ||
            required == id)
            return error_response(400, "La dipendenza deve indicare un'altra scheda.");
        int64_t board = resource_board("cards", id, false);
        if (resource_board("cards", required, false) != board)
            return error_response(400, "Le dipendenze devono appartenere alla stessa bacheca.");
        sqlite3_stmt *s =
            prepare("WITH RECURSIVE chain(id) AS(SELECT ?2 UNION SELECT d.required_card_id "
                    "FROM card_dependencies d JOIN chain c ON d.card_id=c.id)SELECT "
                    "EXISTS(SELECT 1 FROM chain WHERE id=?1)");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, required);
        bool cycle = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        if (cycle)
            return error_response(409, "La dipendenza creerebbe un ciclo.");
        if (scalar_id("SELECT completed FROM cards WHERE id=?1", id) &&
            !scalar_id("SELECT completed FROM cards WHERE id=?1", required))
            return error_response(
                409, "Riapri la scheda prima di aggiungere una dipendenza incompleta.");
        s = prepare("INSERT OR IGNORE INTO "
                    "card_dependencies(card_id,required_card_id)VALUES(?1,?2)");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, required);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Dipendenza non salvata");
        sqlite3_finalize(s);
    }
    if (!run_id("UPDATE cards SET "
                "version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'"
                ") WHERE id=?1",
                id))
        db_die("Versione non salvata");
    char *title = resource_title("cards", id);
    record_event(r, resource_board("cards", id, false),
                 del ? "dependency_removed" : "dependency_added", "cards", id, title);
    ob_free(title);
    return mutation_success(del ? 200 : 201, "cards", id);
}
static Response template_api(Request *r, const char *kind, int64_t id, bool instantiate, bool get,
                             bool post, bool del) {
    if (!id) {
        if (get) {
            sqlite3_stmt *s =
                prepare("SELECT json_object('templates',json((SELECT "
                        "json_group_array(json(item)) FROM(SELECT "
                        "json_object('id',id,'name',name,'created_at',created_at) item FROM "
                        "templates WHERE owner_id=?1 AND kind=?2 ORDER BY id DESC))))");
            sqlite3_bind_int64(s, 1, r->user_id);
            bind_text(s, 2, kind);
            Response out = sqlite3_step(s) == SQLITE_ROW
                               ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                               : error_response(503, "Modelli non disponibili.");
            sqlite3_finalize(s);
            return out;
        }
        if (!post)
            return error_response(405, "Metodo non consentito.");
        char *name = NULL;
        int64_t source = 0;
        const char *field = !strcmp(kind, "cards") ? "card_id" : "board_id";
        if (json_string(r->body, "name", &name, 200) != 1 || !nonblank(name) ||
            json_integer(r->body, field, &source, 1, INT64_MAX, false) != 1) {
            ob_free(name);
            return error_response(400, "Nome e origine del modello obbligatori.");
        }
        if (!accessible(r, kind, source, false, false)) {
            ob_free(name);
            return error_response(404, "Origine non trovata.");
        }
        bool old_summary = summary_mode, old_archive = include_archived;
        summary_mode = false;
        include_archived = true;
        const char *query = !strcmp(kind, "cards")
                                ? "SELECT "
                                  "json_remove(data,'$.id','$.column_id','$.position','$.version','"
                                  "$.created_at','$.updated_at','$.assignee_ids','$.assignees','$."
                                  "archived','$.custom_values','$.milestone_key') FROM "
                                  "ob_card_objects WHERE id=?1"
                                : "SELECT "
                                  "json_object('format','openboard','version',2,'board',json(data))"
                                  " FROM ob_board_objects WHERE id=?1";
        sqlite3_stmt *s = prepare(query);
        sqlite3_bind_int64(s, 1, source);
        if (sqlite3_step(s) != SQLITE_ROW)
            db_die("Modello non disponibile");
        char *payload = copy_string((const char *)sqlite3_column_text(s, 0));
        sqlite3_finalize(s);
        summary_mode = old_summary;
        include_archived = old_archive;
        s = prepare("INSERT INTO templates(owner_id,kind,name,payload)VALUES(?1,?2,?3,?4)");
        sqlite3_bind_int64(s, 1, r->user_id);
        bind_text(s, 2, kind);
        bind_text(s, 3, name);
        bind_text(s, 4, payload);
        ob_free(name);
        ob_free(payload);
        if (sqlite3_step(s) != SQLITE_DONE)
            db_die("Modello non salvato");
        sqlite3_finalize(s);
        return success(201, sqlite3_last_insert_rowid(db));
    }
    sqlite3_stmt *s = prepare("SELECT payload,owner_id FROM templates WHERE id=?1 AND kind=?2");
    sqlite3_bind_int64(s, 1, id);
    bind_text(s, 2, kind);
    if (sqlite3_step(s) != SQLITE_ROW) {
        sqlite3_finalize(s);
        return error_response(404, "Modello non trovato.");
    }
    int64_t owner = sqlite3_column_int64(s, 1);
    bool mine = owner == r->user_id;
    char *payload = copy_string((const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s);
    if (!mine && !(del && auth_is_admin(r))) {
        ob_free(payload);
        return error_response(404, "Modello non trovato.");
    }
    if (del && !instantiate) {
        ob_free(payload);
        if (!run_id("DELETE FROM templates WHERE id=?1", id))
            db_die("Modello non eliminato");
        return success(200, id);
    }
    if (!post || !instantiate) {
        ob_free(payload);
        return error_response(405, "Metodo non consentito.");
    }
    Request part = *r;
    part.if_match[0] = 0;
    part.body = payload;
    Response out;
    if (!strcmp(kind, "cards")) {
        int64_t column = 0;
        if (json_integer(r->body, "column_id", &column, 1, INT64_MAX, false) != 1) {
            ob_free(payload);
            return error_response(400, "Lista di destinazione obbligatoria.");
        }
        out = save_card(&part, column, true);
    } else {
        char *name = NULL;
        int np = json_string(r->body, "name", &name, 200);
        if (np < 0 || (name && !nonblank(name))) {
            ob_free(payload);
            ob_free(name);
            return error_response(400, "Nome non valido.");
        }
        s = prepare("SELECT "
                    "json_set(?1,'$.board.name',coalesce(?2,json_extract(?1,'$.board.name')"
                    "),'$.board.archived',json('false'),'$.board.starred',json('false'))");
        bind_text(s, 1, payload);
        if (name)
            bind_text(s, 2, name);
        if (sqlite3_step(s) != SQLITE_ROW)
            db_die("Modello non disponibile");
        char *renamed = copy_string((const char *)sqlite3_column_text(s, 0));
        sqlite3_finalize(s);
        ob_free(payload);
        payload = renamed;
        part.body = payload;
        ob_free(name);
        out = import_board(&part);
    }
    ob_free(payload);
    return out;
}
static int json_filters(const char *body, char **out) {
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.filters'),json_extract(?1,'$.filters')");
    bind_text(s, 1, body);
    int p = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *t = (const char *)sqlite3_column_text(s, 0);
        if (!t)
            p = 0;
        else if (!strcmp(t, "object")) {
            *out = copy_string((const char *)sqlite3_column_text(s, 1));
            p = 1;
        }
    }
    sqlite3_finalize(s);
    if (p != 1)
        return p;
    if (!valid_object(*out))
        return -1;
    s = prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) WHERE key NOT "
                "IN('query','search','label','assignee','priority','status','sort') OR "
                "type<>'text' OR length(value)>200 OR instr(value,char(0))>0 OR "
                "(key='priority' AND value NOT IN('','low','normal','high','urgent')) OR "
                "(key='label' AND value NOT "
                "IN('','design','sviluppo','ricerca','marketing','urgente')) OR "
                "(key='status' AND value NOT "
                "IN('','open','completed','overdue','due-soon','blocked')) OR "
                "(key='sort' AND value NOT "
                "IN('manual','due','priority','title','created','updated')))");
    bind_text(s, 1, *out);
    bool ok = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    return ok ? 1 : -1;
}
static Response views_api(Request *r, int64_t board, int64_t id, bool get, bool post, bool patch,
                          bool del) {
    if (!id) {
        if (!accessible(r, "boards", board, false, false))
            return error_response(404, "Bacheca non trovata.");
        if (get) {
            sqlite3_stmt *s =
                prepare("SELECT json_object('views',json((SELECT "
                        "json_group_array(json_object('id',id,'name',name,'filters',json("
                        "filters))) FROM saved_views WHERE board_id=?1 AND user_id=?2)))");
            sqlite3_bind_int64(s, 1, board);
            sqlite3_bind_int64(s, 2, r->user_id);
            Response out = sqlite3_step(s) == SQLITE_ROW
                               ? json_response(200, (const char *)sqlite3_column_text(s, 0))
                               : error_response(503, "Viste non disponibili.");
            sqlite3_finalize(s);
            return out;
        }
        if (!post)
            return error_response(405, "Metodo non consentito.");
    } else {
        sqlite3_stmt *s = prepare("SELECT board_id FROM saved_views WHERE id=?1 AND user_id=?2");
        sqlite3_bind_int64(s, 1, id);
        sqlite3_bind_int64(s, 2, r->user_id);
        board = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
        sqlite3_finalize(s);
        if (!board || !accessible(r, "boards", board, false, false))
            return error_response(404, "Vista non trovata.");
        if (del) {
            if (!run_id("DELETE FROM saved_views WHERE id=?1", id))
                db_die("Vista non eliminata");
            return success(200, id);
        }
        if (!patch)
            return error_response(405, "Metodo non consentito.");
    }
    char *name = NULL, *filters = NULL;
    int np = json_string(r->body, "name", &name, 200), fp = json_filters(r->body, &filters);
    if (np < 0 || fp < 0 || (!id && (np != 1 || fp != 1)) || (name && !nonblank(name))) {
        ob_free(name);
        ob_free(filters);
        return error_response(400, "Nome o filtri della vista non validi.");
    }
    sqlite3_stmt *s =
        prepare(!id ? "INSERT INTO "
                      "saved_views(board_id,user_id,name,filters)VALUES(?1,?2,?3,?4)"
                    : "UPDATE saved_views SET "
                      "name=coalesce(?3,name),filters=coalesce(?4,filters) WHERE id=?1 "
                      "AND user_id=?2");
    sqlite3_bind_int64(s, 1, id ? id : board);
    sqlite3_bind_int64(s, 2, r->user_id);
    if (name)
        bind_text(s, 3, name);
    if (filters)
        bind_text(s, 4, filters);
    ob_free(name);
    ob_free(filters);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Vista non salvata");
    sqlite3_finalize(s);
    return success(id ? 200 : 201, id ? id : sqlite3_last_insert_rowid(db));
}
static Response bulk_api(Request *r, int64_t board) {
    if (!accessible(r, "boards", board, true, false))
        return error_response(404, "Bacheca non trovata.");
    char *action = NULL, *string_value = NULL, *batch_labels = NULL;
    int64_t value = 0;
    bool action_valid = json_string(r->body, "action", &action, 20) == 1;
    bool flag_action = action_valid && (!strcmp(action, "complete") || !strcmp(action, "archive"));
    if (flag_action)
        action_valid = json_integer(r->body, "value", &value, 0, 1, true) == 1;
    else if (action_valid && (!strcmp(action, "priority") || !strcmp(action, "milestone"))) {
        action_valid = json_string(r->body, "value", &string_value, 40) == 1;
        if (action_valid && !strcmp(action, "priority")) {
            const char *p[] = {"low", "normal", "high", "urgent"};
            action_valid = one_of(string_value, p, 4);
        }
        if (action_valid && !strcmp(action, "milestone"))
            action_valid = valid_milestone(board, string_value);
    } else if (action_valid && !strcmp(action, "labels")) {
        sqlite3_stmt *j = prepare("SELECT json_object('labels',json_extract(?1,'$.value'))");
        bind_text(j, 1, r->body);
        sqlite3_step(j);
        char *labelbody = copy_string((const char *)sqlite3_column_text(j, 0));
        sqlite3_finalize(j);
        action_valid = json_labels(labelbody, &batch_labels) == 1;
        ob_free(labelbody);
    } else
        action_valid = false;
    if (!action_valid) {
        ob_free(action);
        ob_free(string_value);
        ob_free(batch_labels);
        return error_response(400, "Azione collettiva non valida.");
    }
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.cards')='array' AND "
                              "json_array_length(?1,'$.cards') BETWEEN 1 AND "
                              "500,json_extract(?1,'$.cards')");
    bind_text(s, 1, r->body);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    char *cards = valid ? copy_string((const char *)sqlite3_column_text(s, 1)) : NULL, *ids = NULL;
    sqlite3_finalize(s);
    if (valid) {
        s = prepare("SELECT value,type FROM json_each(?1)");
        bind_text(s, 1, cards);
        while (sqlite3_step(s) == SQLITE_ROW) {
            const char *item = (const char *)sqlite3_column_text(s, 0),
                       *type = (const char *)sqlite3_column_text(s, 1);
            int64_t cid = 0, revision = 0;
            if (strcmp(type, "object") || !valid_object(item) ||
                json_integer(item, "id", &cid, 1, INT64_MAX, false) != 1 ||
                json_integer(item, "version", &revision, 1, INT64_MAX, false) != 1) {
                valid = false;
                break;
            }
        }
        sqlite3_finalize(s);
    }
    if (valid) {
        s = prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY "
                    "json_extract(value,'$.id') HAVING count(*)>1),(SELECT "
                    "json_group_array(json_extract(value,'$.id')) FROM json_each(?1))");
        bind_text(s, 1, cards);
        valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
        if (valid)
            ids = copy_string((const char *)sqlite3_column_text(s, 1));
        sqlite3_finalize(s);
    }
    if (!valid) {
        ob_free(action);
        ob_free(cards);
        ob_free(string_value);
        ob_free(batch_labels);
        return error_response(400, "Indica da 1 a 500 schede con ID e versione univoci.");
    }
    s = prepare("SELECT json_extract(value,'$.id'),json_extract(value,'$.version') FROM "
                "json_each(?1)");
    bind_text(s, 1, cards);
    int count = 0;
    Response out = {0};
    while (sqlite3_step(s) == SQLITE_ROW) {
        int64_t id = sqlite3_column_int64(s, 0), version = sqlite3_column_int64(s, 1);
        if (resource_board("cards", id, false) != board) {
            out = error_response(404, "Una scheda non appartiene alla bacheca.");
            break;
        }
        if (scalar_id("SELECT version FROM cards WHERE id=?1", id) != version) {
            out = error_response(412, "Una scheda è stata modificata: nessuna modifica applicata.");
            break;
        }
        if (!strcmp(action, "complete") && value && !dependencies_complete(id, ids)) {
            out =
                error_response(409, "Una dipendenza non è completata: nessuna modifica applicata.");
            break;
        }
        count++;
    }
    sqlite3_finalize(s);
    if (out.status)
        goto done;
    /* Validate the final state collectively, so reopening several cards cannot
     * bypass WIP. */
    if (flag_action && !value) {
        s = prepare(!strcmp(action, "complete")
                        ? "SELECT count(*) FROM columns c WHERE c.board_id=?1 AND "
                          "c.deleted_at IS NULL AND c.wip_limit>0 AND c.id IN(SELECT "
                          "column_id FROM cards "
                          "WHERE id IN(SELECT value FROM json_each(?2))) AND (SELECT "
                          "count(*) "
                          "FROM cards k WHERE k.column_id=c.id AND k.deleted_at IS NULL "
                          "AND k.archived=0 AND (k.completed=0 OR k.id IN(SELECT value "
                          "FROM json_each(?2))))>c.wip_limit"
                        : "SELECT count(*) FROM columns c WHERE c.board_id=?1 AND "
                          "c.deleted_at IS NULL AND c.wip_limit>0 AND c.id IN(SELECT "
                          "column_id FROM cards "
                          "WHERE id IN(SELECT value FROM json_each(?2))) AND (SELECT "
                          "count(*) "
                          "FROM cards k WHERE k.column_id=c.id AND k.deleted_at IS NULL "
                          "AND k.completed=0 AND (k.archived=0 OR k.id IN(SELECT value "
                          "FROM json_each(?2))))>c.wip_limit");
        sqlite3_bind_int64(s, 1, board);
        bind_text(s, 2, ids);
        bool exceeded = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        if (exceeded) {
            out = error_response(409, "Limite WIP superato: nessuna modifica applicata.");
            goto done;
        }
    }
    const char *update = !strcmp(action, "complete")   ? "UPDATE cards SET completed=?1 WHERE id "
                                                         "IN(SELECT value FROM json_each(?2))"
                         : !strcmp(action, "archive")  ? "UPDATE cards SET archived=?1 WHERE id "
                                                         "IN(SELECT value FROM json_each(?2))"
                         : !strcmp(action, "priority") ? "UPDATE cards SET priority=?1 WHERE id "
                                                         "IN(SELECT value FROM json_each(?2))"
                         : !strcmp(action, "milestone")
                             ? "UPDATE cards SET milestone_key=?1 WHERE id IN(SELECT value FROM "
                               "json_each(?2))"
                             : "UPDATE cards SET "
                               "labels=?1,label=coalesce(json_extract(?1,'$[0]'),'') WHERE id "
                               "IN(SELECT value FROM json_each(?2))";
    s = prepare(update);
    if (flag_action)
        sqlite3_bind_int64(s, 1, value);
    else
        bind_text(s, 1, batch_labels ? batch_labels : string_value);
    bind_text(s, 2, ids);
    if (sqlite3_step(s) != SQLITE_DONE)
        db_die("Modifica collettiva fallita");
    sqlite3_finalize(s);
    s = prepare("SELECT id,title FROM cards WHERE id IN(SELECT value FROM "
                "json_each(?1))");
    bind_text(s, 1, ids);
    while (sqlite3_step(s) == SQLITE_ROW)
        record_event(r, board,
                     !strcmp(action, "complete")  ? (value ? "completed" : "reopened")
                     : !strcmp(action, "archive") ? (value ? "archived" : "unarchived")
                                                  : "planning_updated",
                     "cards", sqlite3_column_int64(s, 0), (const char *)sqlite3_column_text(s, 1));
    sqlite3_finalize(s);
    if (!strcmp(action, "archive")) {
        s = prepare("SELECT id FROM columns WHERE board_id=?1 AND deleted_at IS NULL");
        sqlite3_bind_int64(s, 1, board);
        while (sqlite3_step(s) == SQLITE_ROW)
            if (!normalize_cards(sqlite3_column_int64(s, 0)))
                db_die("Riordino fallito");
        sqlite3_finalize(s);
    }
    char body[100];
    snprintf(body, sizeof body, "{\"ok\":true,\"updated\":%d}", count);
    out = json_response(200, body);
done:
    ob_free(action);
    ob_free(cards);
    ob_free(ids);
    ob_free(string_value);
    ob_free(batch_labels);
    return out;
}
static Response route_domain(Request *r) {
    bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
         patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
    if (!strcmp(r->path, "/api/boards")) {
        if (get)
            return query_json("SELECT json_object('boards',json((SELECT "
                              "json_group_array(json(item))FROM(SELECT "
                              "json_object('id',id,'name',name,'description',description,'color',"
                              "color,'starred',json(CASE "
                              "ob_starred(id,starred)WHEN 1 THEN 'true' ELSE 'false' "
                              "END),'archived',json(CASE archived WHEN 1 THEN "
                              "'true' ELSE 'false' "
                              "END),'version',version,'created_at',created_at,'updated_at',updated_"
                              "at,'role',ob_role(id),'membership_"
                              "role',ob_role(id),'readonly',json(CASE ob_readonly(id)WHEN 1 THEN "
                              "'true' ELSE 'false' END))item FROM "
                              "boards WHERE deleted_at IS NULL AND(ob_archived() OR archived=0)AND "
                              "ob_allowed(id)ORDER BY id))))",
                              0);
        if (post)
            return save_board(r, 0, true);
        return error_response(405, "Metodo non consentito.");
    }
    if (!strcmp(r->path, "/api/me/tasks"))
        return get ? my_tasks(r) : error_response(405, "Metodo non consentito.");
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
    for (char *p = strtok_r(path, "/", &state); p && count < COUNT_OF(parts);
         p = strtok_r(NULL, "/", &state))
        parts[count++] = p;
    if (count < 3 || strcmp(parts[0], "api") || strstr(r->path, "//") ||
        r->path[strlen(r->path) - 1] == '/')
        return error_response(404, "Percorso non trovato.");
    if (!strcmp(parts[1], "templates") &&
        (!strcmp(parts[2], "cards") || !strcmp(parts[2], "boards"))) {
        int64_t tid = count >= 4 ? parse_id(parts[3]) : 0;
        if (count == 3 || (tid && count == 4) ||
            (tid && count == 5 && !strcmp(parts[4], "instantiate")))
            return template_api(r, parts[2], tid, count == 5, get, post, del);
        return error_response(404, "Modello non trovato.");
    }
    if (count == 5 && !strcmp(parts[1], "trash") && !strcmp(parts[4], "restore") && post) {
        int64_t id = parse_id(parts[3]);
        return id ? restore_resource(r, parts[2], id) : error_response(404, "Risorsa non trovata.");
    }
    int64_t id = parse_id(parts[2]);
    if (!id)
        return error_response(404, "Risorsa non trovata.");
    if (!strcmp(parts[1], "fields") || !strcmp(parts[1], "milestones")) {
        bool field = !strcmp(parts[1], "fields");
        if (count == 3 && patch)
            return field ? field_save(r, id, false) : milestone_save(r, id, false);
        if (count == 3 && del)
            return plan_delete_restore(r, field ? "custom_fields" : "milestones", id, false);
        if (count == 4 && post && !strcmp(parts[3], "restore"))
            return plan_delete_restore(r, field ? "custom_fields" : "milestones", id, true);
        return error_response(405, "Metodo non consentito.");
    }
    if (!strcmp(parts[1], "views") && count == 3)
        return views_api(r, 0, id, get, post, patch, del);
    if (!strcmp(parts[1], "comments") && count == 3)
        return del ? delete_comment(r, id) : error_response(405, "Metodo non consentito.");
    bool board = !strcmp(parts[1], "boards"), column = !strcmp(parts[1], "columns"),
         card = !strcmp(parts[1], "cards");
    if (!board && !column && !card)
        return error_response(404, "Percorso non trovato.");
    if (card && count == 5 && !strcmp(parts[3], "dependencies") && del) {
        int64_t required = parse_id(parts[4]);
        return required ? dependencies_api(r, id, required, false, true)
                        : error_response(404, "Dipendenza non trovata.");
    }
    if (count == 4) {
        if (card && !strcmp(parts[3], "assignees") && (get || patch))
            return assignees_api(r, id, get);
        if (card && !strcmp(parts[3], "dependencies") && (get || post))
            return dependencies_api(r, id, 0, get, false);
        if (board && !strcmp(parts[3], "views"))
            return views_api(r, id, 0, get, post, patch, del);
        if (board && !strcmp(parts[3], "fields"))
            return get    ? fields_list(r, id)
                   : post ? field_save(r, id, true)
                          : error_response(405, "Metodo non consentito.");
        if (board && !strcmp(parts[3], "milestones"))
            return get    ? milestones_list(r, id)
                   : post ? milestone_save(r, id, true)
                          : error_response(405, "Metodo non consentito.");
        if (board && !strcmp(parts[3], "field-search"))
            return get ? field_search(r, id) : error_response(405, "Metodo non consentito.");
        if (board && !strcmp(parts[3], "workload"))
            return get ? workload_api(r, id) : error_response(405, "Metodo non consentito.");
        if (card && !strcmp(parts[3], "fields"))
            return get     ? custom_values_api(r, id, true)
                   : patch ? custom_values_api(r, id, false)
                           : error_response(405, "Metodo non consentito.");
        if (board && !strcmp(parts[3], "bulk") && post)
            return bulk_api(r, id);
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
                return query_json("SELECT json_object('version',version)FROM boards WHERE id=?1",
                                  id);
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
            return query_json("SELECT data FROM ob_board_objects WHERE id=?1 AND "
                              "deleted_at IS NULL",
                              id);
        if (card)
            return query_json("SELECT data FROM ob_card_objects WHERE id=?1 AND deleted_at IS NULL",
                              id);
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
    sqlite3_stmt *s = prepare("SELECT request_body,status,response_body FROM idempotency WHERE "
                              "user_id=?1 AND path=?2 AND key=?3");
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
    sqlite3_stmt *s = prepare("INSERT INTO "
                              "idempotency(user_id,path,key,request_body,status,"
                              "response_body)VALUES(?1,?2,?3,?4,?5,?6)");
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
/* Personal filters require board read access; they never mutate shared board
 * content. */
static bool personal_view_route(Request *r) {
    const char *prefix = "/api/views/";
    if (!strncmp(r->path, prefix, strlen(prefix)))
        return parse_id(r->path + strlen(prefix)) &&
               (!strcmp(r->method, "PATCH") || !strcmp(r->method, "DELETE"));
    prefix = "/api/boards/";
    if (strncmp(r->path, prefix, strlen(prefix)) || strcmp(r->method, "POST"))
        return false;
    const char *id = r->path + strlen(prefix), *slash = strchr(id, '/');
    if (!slash || strcmp(slash, "/views") || (size_t)(slash - id) > 20)
        return false;
    char number[24];
    memcpy(number, id, (size_t)(slash - id));
    number[slash - id] = 0;
    return parse_id(number) > 0;
}
Response ob_route(Request *r) {
    current_request = r;
    cloud_request_active = false;
    outer_transaction = false;
    importing_plan = false;
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
        if (cloud_request_active) {
            cloud_request_active = false;
            cloud_request_abort(db);
        }
        current_request = NULL;
        failure_target = NULL;
        release_request_allocations();
        return error_response(503, "Database temporaneamente non disponibile. Riprova.");
    }
    bool get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST"),
         patch = !strcmp(r->method, "PATCH"), del = !strcmp(r->method, "DELETE");
    Response result;
    /* Refresh before every SQLite-backed callback, including authentication and
     * session reads: those callbacks can also commit session changes. */
    if (cloud_request_begin(db)) {
        result = error_response(503, "Archivio esterno temporaneamente non disponibile. Riprova.");
        goto done;
    }
    cloud_request_active = true;
    cloud_changes_before = sqlite3_total_changes64(db);
    if (!get && !post && !patch && !del) {
        result = error_response(405, "Metodo non consentito.");
        goto done;
    }
    if (!get) {
        if (!del || r->body_len) {
            if (strncasecmp(r->content_type, "application/json", 16) ||
                (r->content_type[16] && r->content_type[16] != ';' &&
                 !isspace((unsigned char)r->content_type[16]))) {
                result = error_response(415, "Usa il formato application/json.");
                goto done;
            }
            if (!r->body_len || !valid_object(r->body)) {
                result = error_response(400, "Il corpo deve essere un oggetto JSON valido.");
                goto done;
            }
            if (cloud_validate_json(db, r->body)) {
                result = error_response(400, "JSON non supportato: massimo 90 livelli e nessun NUL nelle chiavi.");
                goto done;
            }
        }
    }
    if (!strcmp(r->path, "/api/health")) {
        result = get ? json_response(200, "{\"status\":\"ok\"}")
                     : error_response(405, "Metodo non consentito.");
        goto done;
    }
    if (auth_handle(r, &result))
        goto done;
    if (!auth_authorize(r, &result))
        goto done;
    char option[32];
    include_archived =
        query_value(r, "include_archived", option, sizeof option) && !strcmp(option, "1");
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
    if (!strcmp(r->path, "/api/catalog")) {
        result = get ? json_response(200,
            "{\"labels\":{\"design\":\"Design\",\"sviluppo\":\"Sviluppo\","
            "\"ricerca\":\"Ricerca\",\"marketing\":\"Marketing\",\"urgente\":\"Urgente\"},"
            "\"priorities\":{\"low\":\"Bassa\",\"normal\":\"Normale\",\"high\":\"Alta\",\"urgent\":\"Urgente\"},"
            "\"covers\":[\"\",\"sage\",\"peach\",\"lavender\",\"blue\"],"
            "\"custom_field_types\":[{\"value\":\"text\",\"label\":\"Testo\"},"
            "{\"value\":\"number\",\"label\":\"Numero\"},{\"value\":\"date\",\"label\":\"Data\"},"
            "{\"value\":\"boolean\",\"label\":\"Sì/No\"},{\"value\":\"select\",\"label\":\"Scelta\"}],"
            "\"review_statuses\":[{\"value\":\"pending\",\"label\":\"In attesa\"},"
            "{\"value\":\"approved\",\"label\":\"Approvata\"},"
            "{\"value\":\"changes_requested\",\"label\":\"Modifiche richieste\"},"
            "{\"value\":\"cancelled\",\"label\":\"Annullata\"}],"
            "\"review_policies\":[{\"value\":\"all\",\"label\":\"Tutti i revisori\"},"
            "{\"value\":\"any\",\"label\":\"Almeno un revisore\"}],"
            "\"review_decisions\":[{\"value\":\"approved\",\"label\":\"Approva\"},"
            "{\"value\":\"changes_requested\",\"label\":\"Richiedi modifiche\"}],"
            "\"portfolio_statuses\":[{\"value\":\"all\",\"label\":\"Tutte\"},"
            "{\"value\":\"open\",\"label\":\"Aperte\"},"
            "{\"value\":\"completed\",\"label\":\"Completate\"},"
            "{\"value\":\"blocked\",\"label\":\"Bloccate\"},"
            "{\"value\":\"overdue\",\"label\":\"Scadute\"},"
            "{\"value\":\"due_soon\",\"label\":\"In scadenza\"},"
            "{\"value\":\"unassigned\",\"label\":\"Non assegnate\"}],"
            "\"sprint_states\":[{\"value\":\"planned\",\"label\":\"Pianificato\"},"
            "{\"value\":\"active\",\"label\":\"In corso\"},{\"value\":\"closed\",\"label\":\"Chiuso\"}],"
            "\"sprint_card_statuses\":[{\"value\":\"all\",\"label\":\"Tutte\"},"
            "{\"value\":\"open\",\"label\":\"Aperte\"},{\"value\":\"completed\",\"label\":\"Completate\"},"
            "{\"value\":\"blocked\",\"label\":\"Bloccate\"}],"
            "\"intake_field_types\":[{\"value\":\"text\",\"label\":\"Testo\"},"
            "{\"value\":\"number\",\"label\":\"Numero\"},{\"value\":\"date\",\"label\":\"Data\"},"
            "{\"value\":\"boolean\",\"label\":\"Sì / No\"},{\"value\":\"select\",\"label\":\"Scelta\"}],"
            "\"intake_request_states\":[{\"value\":\"new\",\"label\":\"Nuova\"},"
            "{\"value\":\"in_review\",\"label\":\"In valutazione\"},"
            "{\"value\":\"accepted\",\"label\":\"Accettata\"},"
            "{\"value\":\"rejected\",\"label\":\"Respinta\"}]}"
        ) : error_response(405, "Metodo non consentito.");
    } else if (!strcmp(r->path, "/api/metrics")) {
        result = get ? ob_metrics(r) : error_response(405, "Metodo non consentito.");
    } else if (!sprints_handle(r, &result) && !intake_handle(r, &result) &&
               !reviews_handle(r, &result) && !portfolio_handle(r, &result) &&
               !teamwork_handle(r, &result) && !collaboration_handle(r, &result)) {
        if (!get && !strcmp(r->role, "observer") && !personal_view_route(r))
            result = error_response(403, "Il ruolo osservatore consente solo la lettura.");
        else
            result = route_domain(r);
    }
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
    /* All helpers finalize their normal paths. Also collect statements abandoned
     * by a recoverable failure. */
    {
        sqlite3_stmt *statement;
        while ((statement = sqlite3_next_stmt(db, NULL)))
            sqlite3_finalize(statement);
    }
    if (cloud_request_active) {
        bool changed = sqlite3_total_changes64(db) != cloud_changes_before;
        cloud_request_active = false;
        if (cloud_request_finish(db, changed)) {
            ob_free(result.body);
            result = error_response(503, "Salvataggio esterno temporaneamente non disponibile. Riprova.");
        }
    }
    /* The HTTP layer owns the response body after this return. */
    forget_allocation(result.body);
    release_request_allocations();
    recovering = false;
    failure_target = NULL;
    current_request = NULL;
    return result;
}
