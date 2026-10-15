/* OpenBoard: a small, local-first Kanban application. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>
#include <sqlite3.h>

#define HEADER_LIMIT 16384
#define BODY_LIMIT 65536
#define CHECKLIST_LIMIT 100
#define COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))

static sqlite3 *db;
static volatile sig_atomic_t stopping;
static int listen_fd = -1;
static int server_port = 8080;
static const char *web_root = "web";
static const char *db_path = "data/openboard.db";

typedef struct {
    char method[12], path[1024], host[256], origin[512], content_type[128], fetch_site[32];
    char *body;
    size_t body_len;
} Request;

typedef struct {
    int status;
    char *body;
    const char *type;
} Response;

static void on_signal(int sig) { (void)sig; stopping = 1; }
static void die(const char *message) { fprintf(stderr, "%s: %s\n", message, strerror(errno)); exit(EXIT_FAILURE); }
static void db_die(const char *message) { fprintf(stderr, "%s: %s\n", message, sqlite3_errmsg(db)); exit(EXIT_FAILURE); }
static char *copy_string(const char *s) {
    char *r = strdup(s ? s : "");
    if (!r) die("Memoria insufficiente");
    return r;
}
static void sql_exec(const char *sql) {
    char *error = NULL;
    if (sqlite3_exec(db, sql, NULL, NULL, &error) != SQLITE_OK) {
        fprintf(stderr, "Errore SQLite: %s\n", error ? error : sqlite3_errmsg(db));
        sqlite3_free(error);
        exit(EXIT_FAILURE);
    }
}
static sqlite3_stmt *prepare(const char *sql) {
    sqlite3_stmt *s = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &s, NULL) != SQLITE_OK) db_die("Preparazione SQL fallita");
    return s;
}
static void bind_text(sqlite3_stmt *s, int index, const char *value) {
    if (sqlite3_bind_text(s, index, value ? value : "", -1, SQLITE_TRANSIENT) != SQLITE_OK) db_die("Parametro SQL non valido");
}
static int64_t scalar_id(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    sqlite3_bind_int64(s, 1, id);
    int64_t value = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int64(s, 0) : 0;
    sqlite3_finalize(s);
    return value;
}
static bool run_id(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    sqlite3_bind_int64(s, 1, id);
    bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    return ok;
}
static Response json_response(int status, const char *json) {
    Response r = {status, copy_string(json), "application/json; charset=utf-8"}; return r;
}
static Response error_response(int status, const char *message) {
    sqlite3_stmt *s = prepare("SELECT json_object('error',?1)");
    bind_text(s, 1, message);
    sqlite3_step(s);
    Response r = json_response(status, (const char *)sqlite3_column_text(s, 0));
    sqlite3_finalize(s); return r;
}
static Response success(int status, int64_t id) {
    char text[96]; snprintf(text, sizeof text, "{\"ok\":true,\"id\":%lld}", (long long)id);
    return json_response(status, text);
}
static Response query_json(const char *sql, int64_t id) {
    sqlite3_stmt *s = prepare(sql);
    if (sqlite3_bind_parameter_count(s)) sqlite3_bind_int64(s, 1, id);
    int code = sqlite3_step(s);
    Response r;
    if (code == SQLITE_ROW) r = json_response(200, (const char *)sqlite3_column_text(s, 0));
    else if (code == SQLITE_DONE) r = error_response(404, "Risorsa non trovata.");
    else r = error_response(500, "Impossibile leggere i dati.");
    sqlite3_finalize(s); return r;
}
static bool begin_transaction(void) { return sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) == SQLITE_OK; }
static bool end_transaction(bool ok) {
    if (ok && sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) == SQLITE_OK) return true;
    sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL); return false;
}

/* JSON text and persisted strings must contain valid UTF-8 Unicode scalars. */
static bool valid_utf8(const char *text, size_t length) {
    const unsigned char *s = (const unsigned char *)text;
    for (size_t i = 0; i < length;) {
        unsigned c = s[i++];
        if (c < 0x80) continue;
        if (c >= 0xc2 && c <= 0xdf) {
            if (i >= length || (s[i++] & 0xc0) != 0x80) return false;
        } else if (c >= 0xe0 && c <= 0xef) {
            if (length - i < 2 || (s[i] & 0xc0) != 0x80 || (s[i+1] & 0xc0) != 0x80 ||
                (c == 0xe0 && s[i] < 0xa0) || (c == 0xed && s[i] >= 0xa0)) return false;
            i += 2;
        } else if (c >= 0xf0 && c <= 0xf4) {
            if (length - i < 3 || (s[i] & 0xc0) != 0x80 || (s[i+1] & 0xc0) != 0x80 || (s[i+2] & 0xc0) != 0x80 ||
                (c == 0xf0 && s[i] < 0x90) || (c == 0xf4 && s[i] >= 0x90)) return false;
            i += 3;
        } else return false;
    }
    return true;
}
/* Parse JSON with SQLite JSON1. Bind all data, including the field path. */
static bool valid_object(const char *json) {
    sqlite3_stmt *s = prepare("SELECT json_valid(?1)");
    bind_text(s, 1, json);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid) return false;
    s = prepare("SELECT json_type(?1)='object' AND NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY key HAVING count(*)>1)");
    bind_text(s, 1, json);
    valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s); return valid;
}
/* Returns 0 for absent, 1 for a string, -1 for a wrong type or embedded NUL. */
static int json_string(const char *json, const char *field, char **out, size_t limit) {
    char path[80]; snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2),length(json_extract(?1,?2))");
    bind_text(s, 1, json); bind_text(s, 2, path);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type) result = 0;
        else if (!strcmp(type, "text")) {
            const char *v = (const char *)sqlite3_column_text(s, 1);
            int n = sqlite3_column_bytes(s, 1);
            if (v && n >= 0 && (size_t)n <= limit * 4 && (size_t)sqlite3_column_int64(s, 2) <= limit && strlen(v) == (size_t)n && valid_utf8(v, (size_t)n)) { *out = copy_string(v); result = 1; }
        }
    }
    sqlite3_finalize(s); return result;
}
static int json_integer(const char *json, const char *field, int64_t *out, int64_t min, int64_t max, bool boolean) {
    char path[80]; snprintf(path, sizeof path, "$.%s", field);
    sqlite3_stmt *s = prepare("SELECT json_type(?1,?2),json_extract(?1,?2)");
    bind_text(s, 1, json); bind_text(s, 2, path);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type) result = 0;
        else if ((!boolean && !strcmp(type, "integer")) || (boolean && (!strcmp(type, "true") || !strcmp(type, "false")))) {
            int64_t v = sqlite3_column_int64(s, 1);
            if (sqlite3_column_type(s, 1) == SQLITE_INTEGER && v >= min && v <= max) { *out = v; result = 1; }
        }
    }
    sqlite3_finalize(s); return result;
}
static int json_checklist(const char *json, char **out) {
    sqlite3_stmt *s = prepare("SELECT json_type(?1,'$.checklist'),json_extract(?1,'$.checklist')");
    bind_text(s, 1, json);
    int result = -1;
    if (sqlite3_step(s) == SQLITE_ROW) {
        const char *type = (const char *)sqlite3_column_text(s, 0);
        if (!type) result = 0;
        else if (!strcmp(type, "array")) { *out = copy_string((const char *)sqlite3_column_text(s, 1)); result = 1; }
    }
    sqlite3_finalize(s);
    if (result != 1) return result;
    s = prepare("SELECT json_array_length(?1)<=100 AND NOT EXISTS(SELECT 1 FROM json_each(?1) WHERE type<>'object')");
    bind_text(s, 1, *out);
    bool valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0);
    sqlite3_finalize(s);
    if (!valid) return -1;
    s = prepare("SELECT value FROM json_each(?1)"); bind_text(s, 1, *out);
    while (sqlite3_step(s) == SQLITE_ROW && valid) {
        const char *item = (const char *)sqlite3_column_text(s, 0);
        char *id = NULL, *text = NULL; int64_t done = 0;
        valid = valid_object(item) && json_string(item, "id", &id, 100) == 1 && id && id[0] &&
            json_string(item, "text", &text, 500) == 1 && text && text[0] && json_integer(item, "done", &done, 0, 1, true) == 1;
        free(id); free(text);
    }
    sqlite3_finalize(s);
    if (valid) {
        s = prepare("SELECT NOT EXISTS(SELECT 1 FROM json_each(?1) GROUP BY json_extract(value,'$.id') HAVING count(*)>1)");
        bind_text(s, 1, *out); valid = sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0); sqlite3_finalize(s);
    }
    return valid ? 1 : -1;
}
static bool nonblank(const char *s) { for (; *s; s++) if (!isspace((unsigned char)*s)) return true; return false; }
static bool one_of(const char *value, const char *const *items, size_t n) {
    for (size_t i = 0; i < n; i++) if (!strcmp(value, items[i])) return true;
    return false;
}
static bool valid_date(const char *s) {
    if (!*s) return true;
    if (strlen(s) != 10 || s[4] != '-' || s[7] != '-') return false;
    for (int i = 0; i < 10; i++) if (i != 4 && i != 7 && !isdigit((unsigned char)s[i])) return false;
    int year = (s[0]-'0')*1000+(s[1]-'0')*100+(s[2]-'0')*10+s[3]-'0';
    int month = (s[5]-'0')*10+s[6]-'0', day = (s[8]-'0')*10+s[9]-'0';
    int days[] = {0,31,28,31,30,31,30,31,31,30,31,30,31};
    if (year < 1 || month < 1 || month > 12) return false;
    if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) days[2] = 29;
    return day >= 1 && day <= days[month];
}
static const char *const colors[] = {"sage", "peach", "lavender", "blue"};
static const char *const labels[] = {"", "design", "sviluppo", "ricerca", "marketing", "urgente"};
static const char *const covers[] = {"", "sage", "peach", "lavender", "blue"};

static const char *boards_json =
    "SELECT json_object('boards',json((SELECT json_group_array(json(item)) FROM ("
    "SELECT json_object('id',id,'name',name,'description',description,'color',color,'starred',json(CASE starred WHEN 1 THEN 'true' ELSE 'false' END)) item FROM boards ORDER BY id))))";
static const char *board_json =
    "SELECT json_object('id',b.id,'name',b.name,'description',b.description,'color',b.color,'starred',json(CASE b.starred WHEN 1 THEN 'true' ELSE 'false' END),"
    "'columns',json((SELECT json_group_array(json(col)) FROM (SELECT json_object('id',c.id,'title',c.title,'position',c.position,"
    "'cards',json((SELECT json_group_array(json(card)) FROM (SELECT json_object('id',k.id,'column_id',k.column_id,'title',k.title,'description',k.description,"
    "'label',k.label,'due_date',k.due_date,'assignee',k.assignee,'cover',k.cover,'position',k.position,'completed',json(CASE k.completed WHEN 1 THEN 'true' ELSE 'false' END),'checklist',json(k.checklist)) card "
    "FROM cards k WHERE k.column_id=c.id ORDER BY k.position,k.id)))) col FROM columns c WHERE c.board_id=b.id ORDER BY c.position,c.id)))) FROM boards b WHERE b.id=?1";

static bool normalize_cards(int64_t column_id) {
    sqlite3_stmt *s = prepare("WITH ranked AS (SELECT id,row_number() OVER (ORDER BY position,id)-1 n FROM cards WHERE column_id=?1) UPDATE cards SET position=(SELECT n FROM ranked WHERE ranked.id=cards.id) WHERE column_id=?1");
    sqlite3_bind_int64(s, 1, column_id); bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); return ok;
}
static bool normalize_columns(int64_t board_id) {
    sqlite3_stmt *s = prepare("WITH ranked AS (SELECT id,row_number() OVER (ORDER BY position,id)-1 n FROM columns WHERE board_id=?1) UPDATE columns SET position=(SELECT n FROM ranked WHERE ranked.id=columns.id) WHERE board_id=?1");
    sqlite3_bind_int64(s, 1, board_id); bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s); return ok;
}
static Response save_board(Request *r, int64_t id, bool create) {
    char *name = NULL, *description = NULL, *color = NULL; int64_t starred = 0;
    int n = json_string(r->body, "name", &name, 200), d = json_string(r->body, "description", &description, 2000);
    int c = json_string(r->body, "color", &color, 20), t = json_integer(r->body, "starred", &starred, 0, 1, true);
    bool valid = n >= 0 && d >= 0 && c >= 0 && t >= 0 && (!create || n == 1) && (!name || nonblank(name)) && (!color || one_of(color, colors, COUNT_OF(colors)));
    Response result;
    if (!valid) { result = error_response(400, "Dati della bacheca non validi."); goto done; }
    if (!create && !scalar_id("SELECT id FROM boards WHERE id=?1", id)) { result = error_response(404, "Bacheca non trovata."); goto done; }
    if (!begin_transaction()) { result = error_response(500, "Impossibile salvare la bacheca."); goto done; }
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO boards(name,description,color) VALUES(?1,?2,?3)");
        bind_text(s, 1, name); bind_text(s, 2, description); bind_text(s, 3, color ? color : "sage");
    } else {
        s = prepare("UPDATE boards SET name=coalesce(?2,name),description=coalesce(?3,description),color=coalesce(?4,color),starred=coalesce(?5,starred) WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        if (name) bind_text(s, 2, name); if (description) bind_text(s, 3, description); if (color) bind_text(s, 4, color);
        if (t) sqlite3_bind_int64(s, 5, starred);
    }
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    if (create && ok) {
        id = sqlite3_last_insert_rowid(db);
        const char *titles[] = {"Da fare", "In corso", "Completato"};
        s = prepare("INSERT INTO columns(board_id,title,position) VALUES(?1,?2,?3)");
        for (size_t i = 0; i < COUNT_OF(titles) && ok; i++) {
            sqlite3_bind_int64(s, 1, id); bind_text(s, 2, titles[i]); sqlite3_bind_int(s, 3, (int)i);
            ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_reset(s); sqlite3_clear_bindings(s);
        }
        sqlite3_finalize(s);
    }
    result = end_transaction(ok) ? success(create ? 201 : 200, id) : error_response(500, "Impossibile salvare la bacheca.");
done:
    free(name); free(description); free(color); return result;
}
static Response save_column(Request *r, int64_t id, bool create) {
    char *title = NULL;
    if (json_string(r->body, "title", &title, 200) != 1 || !title || !nonblank(title)) { free(title); return error_response(400, "Il titolo della lista deve contenere da 1 a 200 caratteri."); }
    if (!scalar_id(create ? "SELECT id FROM boards WHERE id=?1" : "SELECT id FROM columns WHERE id=?1", id)) { free(title); return error_response(404, create ? "Bacheca non trovata." : "Lista non trovata."); }
    if (!begin_transaction()) { free(title); return error_response(500, "Impossibile salvare la lista."); }
    sqlite3_stmt *s = prepare(create ? "INSERT INTO columns(board_id,title,position) SELECT ?1,?2,count(*) FROM columns WHERE board_id=?1" : "UPDATE columns SET title=?2 WHERE id=?1");
    sqlite3_bind_int64(s, 1, id); bind_text(s, 2, title); free(title);
    bool ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    if (create && ok) id = sqlite3_last_insert_rowid(db);
    return end_transaction(ok) ? success(create ? 201 : 200, id) : error_response(500, "Impossibile salvare la lista.");
}
static Response save_card(Request *r, int64_t id, bool create) {
    const char *fields[] = {"title", "description", "label", "due_date", "assignee", "cover"};
    size_t limits[] = {300, 10000, 30, 10, 100, 20};
    char *values[6] = {0}; char *checklist = NULL;
    int64_t completed = 0, target_column = 0, position = 0;
    int completed_present = json_integer(r->body, "completed", &completed, 0, 1, true);
    int column_present = json_integer(r->body, "column_id", &target_column, 1, INT64_MAX, false);
    int position_present = json_integer(r->body, "position", &position, 0, INT_MAX, false);
    int checklist_present = json_checklist(r->body, &checklist);
    bool valid = completed_present >= 0 && column_present >= 0 && position_present >= 0 && checklist_present >= 0;
    int title_present = 0;
    for (size_t i = 0; i < 6; i++) { int p = json_string(r->body, fields[i], &values[i], limits[i]); valid = valid && p >= 0; if (i == 0) title_present = p; }
    valid = valid && (!create || title_present == 1) && (!values[0] || nonblank(values[0])) && (!values[2] || one_of(values[2], labels, COUNT_OF(labels))) &&
        (!values[3] || valid_date(values[3])) && (!values[5] || one_of(values[5], covers, COUNT_OF(covers)));
    Response result;
    if (!valid) { result = error_response(400, "Dati della scheda non validi."); goto done; }
    int64_t source_column = create ? id : scalar_id("SELECT column_id FROM cards WHERE id=?1", id);
    if (!source_column || !scalar_id("SELECT id FROM columns WHERE id=?1", source_column)) { result = error_response(404, create ? "Lista non trovata." : "Scheda non trovata."); goto done; }
    if (!column_present || create) target_column = source_column;
    int64_t source_board = scalar_id("SELECT board_id FROM columns WHERE id=?1", source_column);
    int64_t target_board = scalar_id("SELECT board_id FROM columns WHERE id=?1", target_column);
    if (!target_board) { result = error_response(404, "Lista di destinazione non trovata."); goto done; }
    if (source_board != target_board) { result = error_response(400, "Puoi spostare le schede solo nella stessa bacheca."); goto done; }
    int64_t target_count = scalar_id("SELECT count(*) FROM cards WHERE column_id=?1", target_column);
    if (!create && source_column == target_column) target_count--;
    if (position_present && position > target_count) { result = error_response(400, "Posizione della scheda non valida."); goto done; }
    if (!begin_transaction()) { result = error_response(500, "Impossibile salvare la scheda."); goto done; }
    bool ok = true;
    sqlite3_stmt *s;
    if (create) {
        s = prepare("INSERT INTO cards(column_id,title,description,label,due_date,assignee,cover,completed,checklist,position) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,count(*) FROM cards WHERE column_id=?1");
        sqlite3_bind_int64(s, 1, source_column);
        for (int i = 0; i < 6; i++) bind_text(s, i + 2, values[i]);
        sqlite3_bind_int64(s, 8, completed); bind_text(s, 9, checklist ? checklist : "[]");
        ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        if (ok) id = sqlite3_last_insert_rowid(db);
    } else {
        s = prepare("UPDATE cards SET title=coalesce(?2,title),description=coalesce(?3,description),label=coalesce(?4,label),due_date=coalesce(?5,due_date),assignee=coalesce(?6,assignee),cover=coalesce(?7,cover),completed=coalesce(?8,completed),checklist=coalesce(?9,checklist) WHERE id=?1");
        sqlite3_bind_int64(s, 1, id);
        for (int i = 0; i < 6; i++) if (values[i]) bind_text(s, i + 2, values[i]);
        if (completed_present) sqlite3_bind_int64(s, 8, completed);
        if (checklist) bind_text(s, 9, checklist);
        ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    }
    if (ok && ((!create && target_column != source_column) || position_present)) {
        /* Temporarily remove this card from ordering, then insert at the requested slot. */
        s = prepare("UPDATE cards SET column_id=?2,position=-1 WHERE id=?1");
        sqlite3_bind_int64(s, 1, id); sqlite3_bind_int64(s, 2, target_column);
        ok = sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        if (ok && source_column != target_column) ok = normalize_cards(source_column);
        /* Rank other cards without the moving card, which has position -1. */
        s = prepare("WITH ranked AS (SELECT id,row_number() OVER(ORDER BY position,id)-1 n FROM cards WHERE column_id=?1 AND id<>?2) UPDATE cards SET position=(SELECT n FROM ranked WHERE ranked.id=cards.id) WHERE column_id=?1 AND id<>?2");
        sqlite3_bind_int64(s, 1, target_column); sqlite3_bind_int64(s, 2, id);
        ok = ok && sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        int64_t count = scalar_id("SELECT count(*)-1 FROM cards WHERE column_id=?1", target_column);
        if (!position_present || position > count) position = count;
        s = prepare("UPDATE cards SET position=position+1 WHERE column_id=?1 AND id<>?2 AND position>=?3");
        sqlite3_bind_int64(s, 1, target_column); sqlite3_bind_int64(s, 2, id); sqlite3_bind_int64(s, 3, position);
        ok = ok && sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
        s = prepare("UPDATE cards SET position=?2 WHERE id=?1"); sqlite3_bind_int64(s, 1, id); sqlite3_bind_int64(s, 2, position);
        ok = ok && sqlite3_step(s) == SQLITE_DONE; sqlite3_finalize(s);
    }
    result = end_transaction(ok) ? success(create ? 201 : 200, id) : error_response(500, "Impossibile salvare la scheda.");
done:
    for (int i = 0; i < 6; i++) free(values[i]); free(checklist); return result;
}
static Response delete_resource(const char *kind, int64_t id) {
    const char *find_sql, *delete_sql; int64_t parent = 0;
    if (!strcmp(kind, "boards")) { find_sql = "SELECT id FROM boards WHERE id=?1"; delete_sql = "DELETE FROM boards WHERE id=?1"; }
    else if (!strcmp(kind, "columns")) { find_sql = "SELECT board_id FROM columns WHERE id=?1"; delete_sql = "DELETE FROM columns WHERE id=?1"; }
    else { find_sql = "SELECT column_id FROM cards WHERE id=?1"; delete_sql = "DELETE FROM cards WHERE id=?1"; }
    parent = scalar_id(find_sql, id);
    if (!parent) return error_response(404, "Risorsa non trovata.");
    if (!begin_transaction()) return error_response(500, "Impossibile eliminare la risorsa.");
    bool ok = run_id(delete_sql, id);
    if (ok && !strcmp(kind, "columns")) ok = normalize_columns(parent);
    if (ok && !strcmp(kind, "cards")) ok = normalize_cards(parent);
    return end_transaction(ok) ? success(200, id) : error_response(500, "Impossibile eliminare la risorsa.");
}

static int64_t parse_id(const char *s) {
    if (!s || !*s || *s == '0') return 0;
    uint64_t n = 0;
    for (; *s; s++) { if (*s < '0' || *s > '9') return 0; unsigned digit = (unsigned)(*s - '0'); if (n > ((uint64_t)INT64_MAX - digit) / 10) return 0; n = n * 10 + digit; }
    return (int64_t)n;
}
static Response route_api(Request *r) {
    bool get = !strcmp(r->method, "GET");
    bool write = !strcmp(r->method, "POST") || !strcmp(r->method, "PATCH") || !strcmp(r->method, "DELETE");
    if (!get && !write) return error_response(405, "Metodo non consentito.");
    if (write) {
        char expected[600]; snprintf(expected, sizeof expected, "http://%s", r->host);
        if ((r->origin[0] && strcmp(r->origin, expected)) || (r->fetch_site[0] && !strcmp(r->fetch_site, "cross-site"))) return error_response(403, "Origine della richiesta non consentita.");
        if ((strcmp(r->method, "DELETE") || r->body_len)) {
            if (strncasecmp(r->content_type, "application/json", 16) || (r->content_type[16] && r->content_type[16] != ';' && !isspace((unsigned char)r->content_type[16]))) return error_response(415, "Usa il formato application/json.");
            if (!r->body_len || !valid_object(r->body)) return error_response(400, "Il corpo deve essere un oggetto JSON valido.");
        }
    }
    if (!strcmp(r->path, "/api/health")) return get ? json_response(200, "{\"status\":\"ok\"}") : error_response(405, "Metodo non consentito.");
    if (!strcmp(r->path, "/api/boards")) {
        if (get) return query_json(boards_json, 0);
        if (!strcmp(r->method, "POST")) return save_board(r, 0, true);
        return error_response(405, "Metodo non consentito.");
    }
    char path[1024]; snprintf(path, sizeof path, "%s", r->path);
    char *parts[6] = {0}, *state = NULL; size_t count = 0;
    for (char *p = strtok_r(path, "/", &state); p && count < COUNT_OF(parts); p = strtok_r(NULL, "/", &state)) parts[count++] = p;
    if (count < 3 || count > 4 || strcmp(parts[0], "api") || strstr(r->path, "//") || r->path[strlen(r->path)-1] == '/') return error_response(404, "Percorso non trovato.");
    int64_t id = parse_id(parts[2]);
    if (!id) return error_response(404, "Risorsa non trovata.");
    if (count == 4) {
        if (!strcmp(r->method, "POST") && !strcmp(parts[1], "boards") && !strcmp(parts[3], "columns")) return save_column(r, id, true);
        if (!strcmp(r->method, "POST") && !strcmp(parts[1], "columns") && !strcmp(parts[3], "cards")) return save_card(r, id, true);
        return error_response(404, "Percorso non trovato.");
    }
    bool board = !strcmp(parts[1], "boards"), column = !strcmp(parts[1], "columns"), card = !strcmp(parts[1], "cards");
    if (!board && !column && !card) return error_response(404, "Percorso non trovato.");
    if (get && board) return query_json(board_json, id);
    if (!strcmp(r->method, "PATCH")) { if (board) return save_board(r, id, false); if (column) return save_column(r, id, false); return save_card(r, id, false); }
    if (!strcmp(r->method, "DELETE")) return delete_resource(parts[1], id);
    return error_response(405, "Metodo non consentito.");
}

static void make_parent_dirs(const char *path) {
    if (!path[0]) { fprintf(stderr, "Il percorso del database non può essere vuoto.\n"); exit(EXIT_FAILURE); }
    char *temp = copy_string(path);
    for (char *p = temp + 1; *p; p++) if (*p == '/') {
        *p = 0;
        if (mkdir(temp, 0700) < 0 && errno != EEXIST) die("Impossibile creare la cartella dati");
        *p = '/';
    }
    free(temp);
}
static int64_t seed_board(const char *name, const char *description, const char *color, int starred) {
    sqlite3_stmt *s = prepare("INSERT INTO boards(name,description,color,starred) VALUES(?1,?2,?3,?4)");
    bind_text(s, 1, name); bind_text(s, 2, description); bind_text(s, 3, color); sqlite3_bind_int(s, 4, starred);
    if (sqlite3_step(s) != SQLITE_DONE) db_die("Creazione bacheca demo fallita");
    sqlite3_finalize(s); return sqlite3_last_insert_rowid(db);
}
static int64_t seed_column(int64_t board, const char *title, int position) {
    sqlite3_stmt *s = prepare("INSERT INTO columns(board_id,title,position) VALUES(?1,?2,?3)");
    sqlite3_bind_int64(s, 1, board); bind_text(s, 2, title); sqlite3_bind_int(s, 3, position);
    if (sqlite3_step(s) != SQLITE_DONE) db_die("Creazione lista demo fallita");
    sqlite3_finalize(s); return sqlite3_last_insert_rowid(db);
}
static void seed_card(int64_t column, const char *title, const char *description, const char *label, const char *date, const char *assignee, const char *cover, int position, int completed, const char *checklist) {
    sqlite3_stmt *s = prepare("INSERT INTO cards(column_id,title,description,label,due_date,assignee,cover,position,completed,checklist) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)");
    sqlite3_bind_int64(s, 1, column); bind_text(s, 2, title); bind_text(s, 3, description); bind_text(s, 4, label); bind_text(s, 5, date); bind_text(s, 6, assignee); bind_text(s, 7, cover);
    sqlite3_bind_int(s, 8, position); sqlite3_bind_int(s, 9, completed); bind_text(s, 10, checklist);
    if (sqlite3_step(s) != SQLITE_DONE) db_die("Creazione scheda demo fallita");
    sqlite3_finalize(s);
}
static void initialize_database(void) {
    make_parent_dirs(db_path);
    if (sqlite3_open(db_path, &db) != SQLITE_OK) db_die("Impossibile aprire il database");
    sqlite3_busy_timeout(db, 3000);
    sql_exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;"
        "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS boards(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'sage',starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN(0,1)));"
        "CREATE TABLE IF NOT EXISTS columns(id INTEGER PRIMARY KEY AUTOINCREMENT,board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,title TEXT NOT NULL,position INTEGER NOT NULL);"
        "CREATE INDEX IF NOT EXISTS columns_board ON columns(board_id,position);"
        "CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY AUTOINCREMENT,column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',label TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',assignee TEXT NOT NULL DEFAULT '',cover TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),checklist TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checklist)));"
        "CREATE INDEX IF NOT EXISTS cards_column ON cards(column_id,position);");
    sqlite3_stmt *s = prepare("SELECT 1 FROM metadata WHERE key='initialized'");
    bool initialized = sqlite3_step(s) == SQLITE_ROW; sqlite3_finalize(s);
    if (initialized) return;
    sql_exec("BEGIN IMMEDIATE");
    s = prepare("SELECT count(*) FROM boards"); sqlite3_step(s); bool empty = sqlite3_column_int64(s, 0) == 0; sqlite3_finalize(s);
    if (empty) {
        int64_t board = seed_board("Lancio di OpenBoard", "Uno spazio condiviso per dare forma alle idee. Costruiamo qualcosa di bello, insieme.", "sage", 1);
        int64_t ideas = seed_column(board, "Idee", 0), todo = seed_column(board, "Da fare", 1), doing = seed_column(board, "In corso", 2), done = seed_column(board, "Completato", 3);
        seed_card(ideas, "Una casa per tutte le nostre idee", "Raccogliere spunti, ispirazioni e piccoli esperimenti per il futuro di OpenBoard.", "ricerca", "", "Sofia", "lavender", 0, 0, "[]");
        seed_card(ideas, "Modalità scura", "Esplorare una palette scura morbida, accessibile e piacevole da usare la sera.", "design", "2026-10-28", "Giulia", "", 1, 0, "[]");
        seed_card(ideas, "Importa le tue bacheche", "Studiare un formato aperto per importare progetti da altri strumenti Kanban.", "sviluppo", "", "Marco", "", 2, 0, "[]");
        seed_card(todo, "Disegnare la nuova pagina di benvenuto", "Una prima impressione semplice: il valore del progetto, una demo e un invito a contribuire.", "design", "2026-10-20", "Giulia", "peach", 0, 0, "[{\"id\":\"welcome-1\",\"text\":\"Raccogliere riferimenti\",\"done\":true},{\"id\":\"welcome-2\",\"text\":\"Preparare il wireframe\",\"done\":false},{\"id\":\"welcome-3\",\"text\":\"Revisione con il team\",\"done\":false}]");
        seed_card(todo, "Scrivere la guida per contribuire", "Documentare come avviare il progetto, segnalare problemi e proporre miglioramenti.", "marketing", "2026-10-22", "Luca", "", 1, 0, "[]");
        seed_card(todo, "Test di accessibilità", "Verificare navigazione da tastiera, contrasto e annunci per gli screen reader.", "urgente", "2026-10-19", "Sofia", "", 2, 0, "[{\"id\":\"a11y-1\",\"text\":\"Navigazione con Tab\",\"done\":false},{\"id\":\"a11y-2\",\"text\":\"Contrasto dei colori\",\"done\":false}]");
        seed_card(doing, "Trascina, sposta, organizza", "Spostare le schede fra le liste e mantenere il nuovo ordine anche dopo un riavvio.", "sviluppo", "2026-10-18", "Marco", "blue", 0, 0, "[{\"id\":\"drag-1\",\"text\":\"API di spostamento\",\"done\":true},{\"id\":\"drag-2\",\"text\":\"Interazioni drag & drop\",\"done\":false}]");
        seed_card(doing, "Dare un'identità a OpenBoard", "Definire logo, colori e tono di voce per un progetto aperto e accogliente.", "design", "2026-10-21", "Giulia", "", 1, 0, "[]");
        seed_card(done, "Il progetto è open source!", "Codice disponibile con licenza MIT. Ogni contributo, grande o piccolo, è benvenuto.", "marketing", "2026-10-14", "Luca", "sage", 0, 1, "[]");
        seed_card(done, "Preparare le fondamenta in C", "Server HTTP leggero, API JSON e database SQLite. Poche dipendenze, tanta sostanza.", "sviluppo", "2026-10-13", "Marco", "", 1, 1, "[{\"id\":\"base-1\",\"text\":\"Server HTTP\",\"done\":true},{\"id\":\"base-2\",\"text\":\"Persistenza SQLite\",\"done\":true}]");
        int64_t inspiration = seed_board("Idee & ispirazioni", "Uno spazio per i prossimi esperimenti e le cose che ci ispirano.", "lavender", 0);
        seed_column(inspiration, "Raccolta", 0); seed_column(inspiration, "Da esplorare", 1); seed_column(inspiration, "Preferiti", 2);
        int64_t website = seed_board("Sito web", "Dal primo wireframe alla pubblicazione del nostro nuovo sito.", "blue", 0);
        seed_column(website, "Da fare", 0); seed_column(website, "In corso", 1); seed_column(website, "Pubblicato", 2);
    }
    sql_exec("INSERT INTO metadata(key,value) VALUES('initialized','1'); PRAGMA user_version=1; COMMIT;");
}

static const char *reason_phrase(int status) {
    switch (status) {
        case 200: return "OK"; case 201: return "Created"; case 400: return "Bad Request"; case 403: return "Forbidden"; case 404: return "Not Found";
        case 405: return "Method Not Allowed"; case 408: return "Request Timeout"; case 413: return "Content Too Large"; case 415: return "Unsupported Media Type";
        case 431: return "Request Header Fields Too Large"; default: return "Internal Server Error";
    }
}
static bool send_all(int fd, const void *buffer, size_t len) {
    const char *p = buffer;
    while (len) { ssize_t n = send(fd, p, len, 0); if (n < 0 && errno == EINTR && !stopping) continue; if (n <= 0) return false; p += n; len -= (size_t)n; }
    return true;
}
static void send_response(int fd, Response *r, bool head) {
    char header[1800]; size_t len = strlen(r->body);
    int n = snprintf(header, sizeof header,
        "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\nCache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: same-origin\r\n"
        "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'\r\n\r\n",
        r->status, reason_phrase(r->status), r->type, len);
    if (n > 0 && (size_t)n < sizeof header && send_all(fd, header, (size_t)n) && !head) send_all(fd, r->body, len);
}
static bool set_header(char *dst, size_t cap, const char *value) { if (strlen(value) >= cap) return false; snprintf(dst, cap, "%s", value); return true; }
static bool valid_host(const char *host) {
    char a[64], b[64]; snprintf(a, sizeof a, "127.0.0.1:%d", server_port); snprintf(b, sizeof b, "localhost:%d", server_port);
    return !strcasecmp(host, a) || !strcasecmp(host, b) || (server_port == 80 && (!strcasecmp(host, "localhost") || !strcmp(host, "127.0.0.1")));
}
/* One bounded request per connection: reject ambiguous framing and never parse pipelined bytes. */
static int read_request(int fd, Request *r) {
    char headers[HEADER_LIMIT + 1]; size_t used = 0, header_end = 0;
    memset(r, 0, sizeof *r);
    while (!header_end) {
        if (used == HEADER_LIMIT) return 431;
        ssize_t n = recv(fd, headers + used, HEADER_LIMIT - used, 0);
        if (n < 0 && errno == EINTR && !stopping) continue;
        if (n <= 0) return errno == EAGAIN || errno == EWOULDBLOCK ? 408 : 400;
        used += (size_t)n; headers[used] = 0;
        if (memchr(headers, 0, used)) return 400;
        char *end = strstr(headers, "\r\n\r\n");
        if (end) header_end = (size_t)(end - headers) + 4;
    }
    size_t initial_body = used - header_end;
    headers[header_end - 2] = 0;
    char *cursor = headers, *line_end = strstr(cursor, "\r\n");
    if (!line_end) return 400;
    *line_end = 0;
    char version[16], extra;
    if (sscanf(cursor, "%11s %1023s %15s %c", r->method, r->path, version, &extra) != 3 || strcmp(version, "HTTP/1.1")) return 400;
    for (char *p = r->method; *p; p++) if (*p < 'A' || *p > 'Z') return 400;
    if (r->path[0] != '/' || strchr(r->path, '#')) return 400;
    for (char *p = r->path; *p; p++) if ((unsigned char)*p <= 32 || (unsigned char)*p >= 127) return 400;
    char *query = strchr(r->path, '?'); if (query) *query = 0;
    cursor = line_end + 2;
    bool have_host = false, have_length = false, have_origin = false, have_type = false, have_fetch_site = false;
    size_t length = 0;
    while (*cursor) {
        line_end = strstr(cursor, "\r\n"); if (!line_end) return 400;
        *line_end = 0;
        if (!*cursor || *cursor == ' ' || *cursor == '\t') return 400;
        char *colon = strchr(cursor, ':'); if (!colon || colon == cursor) return 400;
        for (char *p = cursor; p < colon; p++) if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_') return 400;
        *colon = 0; char *value = colon + 1; while (*value == ' ' || *value == '\t') value++;
        char *tail = value + strlen(value); while (tail > value && (tail[-1] == ' ' || tail[-1] == '\t')) *--tail = 0;
        for (char *p = value; *p; p++) if ((unsigned char)*p < 32 && *p != '\t') return 400;
        if (!strcasecmp(cursor, "Host")) { if (have_host || !set_header(r->host, sizeof r->host, value)) return 400; have_host = true; }
        else if (!strcasecmp(cursor, "Content-Length")) {
            if (have_length || !*value) return 400;
            have_length = true;
            for (char *p = value; *p; p++) { if (!isdigit((unsigned char)*p)) return 400; unsigned digit = (unsigned)(*p - '0'); if (length > (BODY_LIMIT - digit) / 10) return 413; length = length * 10 + digit; }
        } else if (!strcasecmp(cursor, "Transfer-Encoding")) return 400;
        else if (!strcasecmp(cursor, "Expect")) return 400;
        else if (!strcasecmp(cursor, "Origin")) { if (have_origin || !set_header(r->origin, sizeof r->origin, value)) return 400; have_origin = true; }
        else if (!strcasecmp(cursor, "Content-Type")) { if (have_type || !set_header(r->content_type, sizeof r->content_type, value)) return 400; have_type = true; }
        else if (!strcasecmp(cursor, "Sec-Fetch-Site")) { if (have_fetch_site || !set_header(r->fetch_site, sizeof r->fetch_site, value)) return 400; have_fetch_site = true; }
        cursor = line_end + 2;
    }
    if (!have_host || !valid_host(r->host)) return 403;
    if (initial_body > length) return 400;
    r->body = malloc(length + 1); if (!r->body) return 500;
    memcpy(r->body, headers + header_end, initial_body);
    size_t received = initial_body;
    while (received < length) {
        ssize_t n = recv(fd, r->body + received, length - received, 0);
        if (n < 0 && errno == EINTR && !stopping) continue;
        if (n <= 0) return errno == EAGAIN || errno == EWOULDBLOCK ? 408 : 400;
        received += (size_t)n;
    }
    r->body[length] = 0; r->body_len = length;
    if (memchr(r->body, 0, length) || !valid_utf8(r->body, length)) return 400;
    return 0;
}
static Response serve_static(Request *r) {
    if (strcmp(r->method, "GET") && strcmp(r->method, "HEAD")) return error_response(405, "Metodo non consentito.");
    const char *file = NULL, *type = NULL;
    if (!strcmp(r->path, "/") || !strcmp(r->path, "/index.html")) { file = "index.html"; type = "text/html; charset=utf-8"; }
    else if (!strcmp(r->path, "/styles.css")) { file = "styles.css"; type = "text/css; charset=utf-8"; }
    else if (!strcmp(r->path, "/app.js")) { file = "app.js"; type = "text/javascript; charset=utf-8"; }
    else if (!strcmp(r->path, "/favicon.svg")) { file = "favicon.svg"; type = "image/svg+xml"; }
    if (!file) return error_response(404, "Pagina non trovata.");
    char path[4096]; if (snprintf(path, sizeof path, "%s/%s", web_root, file) >= (int)sizeof path) return error_response(500, "Percorso dei file troppo lungo.");
    FILE *f = fopen(path, "rb"); if (!f) return error_response(404, "File dell'interfaccia non trovato.");
    struct stat st;
    if (fstat(fileno(f), &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size > 2 * 1024 * 1024) { fclose(f); return error_response(500, "File dell'interfaccia non valido."); }
    size_t len = (size_t)st.st_size; char *body = malloc(len + 1);
    if (!body) { fclose(f); return error_response(500, "Memoria insufficiente."); }
    bool ok = fread(body, 1, len, f) == len; fclose(f); body[len] = 0;
    if (!ok) { free(body); return error_response(500, "Impossibile leggere l'interfaccia."); }
    Response result = {200, body, type}; return result;
}
static void handle_connection(int fd) {
    struct timeval timeout = {5, 0}; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout); setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    Request r;
    int status = read_request(fd, &r);
    Response result;
    if (status) result = error_response(status, status == 413 ? "Richiesta troppo grande." : status == 431 ? "Intestazioni troppo grandi." : status == 408 ? "Tempo della richiesta scaduto." : status == 403 ? "Host non consentito." : "Richiesta HTTP non valida.");
    else if (!strncmp(r.path, "/api/", 5)) result = route_api(&r);
    else result = serve_static(&r);
    send_response(fd, &result, !strcmp(r.method, "HEAD")); free(result.body); free(r.body);
}
static void usage(const char *name) {
    printf("Uso: %s [--port 8080] [--db data/openboard.db] [--web-root web]\n", name);
}
int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) { usage(argv[0]); return 0; }
        if (i + 1 >= argc) { usage(argv[0]); return 1; }
        if (!strcmp(argv[i], "--port")) { int64_t port = parse_id(argv[++i]); if (port < 1 || port > 65535) { fprintf(stderr, "Porta non valida.\n"); return 1; } server_port = (int)port; }
        else if (!strcmp(argv[i], "--db")) db_path = argv[++i];
        else if (!strcmp(argv[i], "--web-root")) web_root = argv[++i];
        else { usage(argv[0]); return 1; }
    }
    if (!web_root[0] || !db_path[0]) { fprintf(stderr, "I percorsi del database e dell'interfaccia non possono essere vuoti.\n"); return 1; }
    struct sigaction action; memset(&action, 0, sizeof action); action.sa_handler = on_signal; sigemptyset(&action.sa_mask); sigaction(SIGINT, &action, NULL); sigaction(SIGTERM, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    initialize_database();
    listen_fd = socket(AF_INET, SOCK_STREAM, 0); if (listen_fd < 0) die("Socket non disponibile");
    int reuse = 1; setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
    struct sockaddr_in address; memset(&address, 0, sizeof address); address.sin_family = AF_INET; address.sin_port = htons((uint16_t)server_port); inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (bind(listen_fd, (struct sockaddr *)&address, sizeof address) < 0) die("Impossibile avviare OpenBoard sulla porta richiesta");
    if (listen(listen_fd, 32) < 0) die("Impossibile ascoltare le connessioni");
    printf("OpenBoard è pronto: http://127.0.0.1:%d\nDatabase: %s\nPremi Ctrl+C per uscire.\n", server_port, db_path); fflush(stdout);
    while (!stopping) {
        int fd = accept(listen_fd, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; if (stopping) break; perror("accept"); continue; }
        handle_connection(fd); close(fd);
    }
    close(listen_fd); sqlite3_close(db); puts("\nOpenBoard arrestato."); return 0;
}
