/* PostgreSQL structured records and MongoDB immutable JSON documents.
 * The SQLite file is a local, reconstructible query cache; no acknowledged
 * write depends on that file. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "cloud.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

bool cloud_enabled(void) {
  const char *pg = getenv("OPENBOARD_POSTGRES_URL");
  const char *mongo = getenv("OPENBOARD_MONGODB_URI");
  return (pg && *pg) || (mongo && *mongo);
}

#ifndef OB_EXTERNAL_STORAGE
int cloud_bootstrap(sqlite3 *cache) {
  (void)cache;
  if (!cloud_enabled())
    return 0;
  fputs("Storage esterno richiesto: ricompila con libpq e libmongoc.\n",
        stderr);
  return -1;
}
int cloud_request_begin(sqlite3 *cache) {
  (void)cache;
  return cloud_enabled() ? -1 : 0;
}
int cloud_request_finish(sqlite3 *cache, bool changed) {
  (void)cache;
  (void)changed;
  return cloud_enabled() ? -1 : 0;
}
int cloud_validate_json(sqlite3 *cache, const char *json) {
  (void)cache;
  (void)json;
  return 0;
}
void cloud_request_abort(sqlite3 *cache) { (void)cache; }
int cloud_ready(void) { return cloud_enabled() ? -1 : 0; }
void cloud_shutdown(void) {}
#else
#include <bson/bson.h>
#include <libpq-fe.h>
#include <limits.h>
#include <mongoc/mongoc.h>
#include <openssl/evp.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>

#define CLOUD_LOCK "7157469169132038"
#define CLOUD_LAYOUT_VERSION 1
#define MAX_TABLES 128
#define MAX_COLUMNS 128
#define MAX_IDENTIFIER 96

typedef struct {
  char name[MAX_IDENTIFIER];
  char pg_name[MAX_IDENTIFIER + 8];
  int affinity, primary;
  bool not_null, json, string_document;
} Column;
typedef struct {
  char name[MAX_IDENTIFIER];
  char pg_name[MAX_IDENTIFIER + 8];
  int count;
  Column columns[MAX_COLUMNS];
} Table;
typedef struct {
  char *data;
  size_t length, capacity;
  bool failed;
} Buffer;
typedef struct DocMemo {
  char key[65];
  char *raw;
  struct DocMemo *next;
} DocMemo;

static pthread_mutex_t store_mutex = PTHREAD_MUTEX_INITIALIZER;
static PGconn *postgres;
static mongoc_client_t *mongo_client;
static mongoc_collection_t *documents;
static Table *tables;
static int table_count, local_schema;
static int64_t cache_epoch = -1;
static bool mongoc_started, bootstrapped;
static _Thread_local bool request_active;
static DocMemo *memo;

static void buffer_add(Buffer *b, const char *format, ...) {
  if (b->failed)
    return;
  va_list args, copy;
  va_start(args, format);
  va_copy(copy, args);
  int size = vsnprintf(NULL, 0, format, copy);
  va_end(copy);
  if (size < 0 || (size_t)size > SIZE_MAX - b->length - 1) {
    b->failed = true;
    va_end(args);
    return;
  }
  size_t required = b->length + (size_t)size + 1;
  if (required > b->capacity) {
    size_t next = required * 2;
    char *grown = realloc(b->data, next);
    if (!grown) {
      b->failed = true;
      va_end(args);
      return;
    }
    b->data = grown;
    b->capacity = next;
  }
  vsnprintf(b->data + b->length, b->capacity - b->length, format, args);
  b->length += (size_t)size;
  va_end(args);
}
static bool identifier(const char *s) {
  if (!s || !*s || strlen(s) >= MAX_IDENTIFIER)
    return false;
  for (; *s; s++)
    if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') ||
          (*s >= '0' && *s <= '9') || *s == '_'))
      return false;
  return true;
}
static int pg_command(const char *sql) {
  PGresult *result = PQexec(postgres, sql);
  bool ok = result && PQresultStatus(result) == PGRES_COMMAND_OK;
  PQclear(result);
  return ok ? 0 : -1;
}
static void quiet_postgres(void *context, const char *message) {
  (void)context;
  (void)message;
}
static int cache_command(sqlite3 *cache, const char *sql) {
  return sqlite3_exec(cache, sql, NULL, NULL, NULL) == SQLITE_OK ? 0 : -1;
}
static int scalar(sqlite3 *cache, const char *sql) {
  sqlite3_stmt *s = NULL;
  int value = -1;
  if (sqlite3_prepare_v2(cache, sql, -1, &s, NULL) == SQLITE_OK &&
      sqlite3_step(s) == SQLITE_ROW)
    value = sqlite3_column_int(s, 0);
  sqlite3_finalize(s);
  return value;
}
int cloud_validate_json(sqlite3 *cache, const char *json) {
  if (!cloud_enabled())
    return 0;
  sqlite3_stmt *s = NULL;
  /* Stop depth traversal once the first unsupported level is reached. The
   * materialized tree is also checked for NUL field names before any mutation.
   */
  const char *sql =
      "WITH RECURSIVE nodes AS MATERIALIZED(SELECT id,parent,key FROM "
      "json_tree(?1)),"
      "depths(id,level)AS(SELECT id,0 FROM nodes WHERE parent IS NULL UNION "
      "ALL "
      "SELECT n.id,d.level+1 FROM nodes n JOIN depths d ON n.parent=d.id WHERE "
      "d.level<91) "
      "SELECT NOT EXISTS(SELECT 1 FROM depths WHERE level>90) AND NOT EXISTS("
      "SELECT 1 FROM nodes WHERE typeof(key)='text' AND instr(key,char(0))>0)";
  int rc = -1;
  if (sqlite3_prepare_v2(cache, sql, -1, &s, NULL) == SQLITE_OK) {
    sqlite3_bind_text(s, 1, json, -1, SQLITE_STATIC);
    if (sqlite3_step(s) == SQLITE_ROW && sqlite3_column_int(s, 0))
      rc = 0;
  }
  sqlite3_finalize(s);
  return rc;
}
static void clear_memo(void) {
  while (memo) {
    DocMemo *next = memo->next;
    free(memo->raw);
    free(memo);
    memo = next;
  }
}
static DocMemo *memo_find(const char *key) {
  for (DocMemo *d = memo; d; d = d->next)
    if (!strcmp(d->key, key))
      return d;
  return NULL;
}
static int memo_add(const char *key, const char *raw) {
  DocMemo *d = calloc(1, sizeof *d);
  if (!d)
    return -1;
  d->raw = strdup(raw);
  if (!d->raw) {
    free(d);
    return -1;
  }
  memcpy(d->key, key, 65);
  d->next = memo;
  memo = d;
  return 0;
}
static int digest(const char *kind, const char *raw, char hex[65]) {
  EVP_MD_CTX *ctx = EVP_MD_CTX_new();
  unsigned char bytes[32];
  unsigned int count = 0;
  bool ok = ctx && EVP_DigestInit_ex(ctx, EVP_sha256(), NULL) == 1 &&
            EVP_DigestUpdate(ctx, kind, strlen(kind) + 1) == 1 &&
            EVP_DigestUpdate(ctx, raw, strlen(raw)) == 1 &&
            EVP_DigestFinal_ex(ctx, bytes, &count) == 1 && count == 32;
  EVP_MD_CTX_free(ctx);
  if (!ok)
    return -1;
  static const char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < 32; i++) {
    hex[i * 2] = digits[bytes[i] >> 4];
    hex[i * 2 + 1] = digits[bytes[i] & 15];
  }
  hex[64] = 0;
  return 0;
}
static bool json_column(const char *table, const char *column) {
  return (!strcmp(table, "cards") &&
          (!strcmp(column, "checklist") || !strcmp(column, "labels") ||
           !strcmp(column, "custom_values"))) ||
         (!strcmp(table, "custom_fields") && !strcmp(column, "options")) ||
         (!strcmp(table, "templates") && !strcmp(column, "payload")) ||
         (!strcmp(table, "saved_views") && !strcmp(column, "filters")) ||
         (!strcmp(table, "idempotency") &&
          (!strcmp(column, "request_body") ||
           !strcmp(column, "response_body"))) ||
         (!strcmp(table, "attachments") && !strcmp(column, "data_base64"));
}
static int inspect_schema(sqlite3 *cache) {
  sqlite3_stmt *list = NULL;
  tables = calloc(MAX_TABLES, sizeof *tables);
  if (!tables)
    return -1;
  if (sqlite3_prepare_v2(
          cache,
          "SELECT name FROM sqlite_schema WHERE type='table' AND "
          "(name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name",
          -1, &list, NULL) != SQLITE_OK)
    return -1;
  int rc;
  while ((rc = sqlite3_step(list)) == SQLITE_ROW) {
    const char *name = (const char *)sqlite3_column_text(list, 0);
    if (table_count == MAX_TABLES || !identifier(name)) {
      rc = SQLITE_ERROR;
      break;
    }
    Table *t = &tables[table_count++];
    snprintf(t->name, sizeof t->name, "%s", name);
    snprintf(t->pg_name, sizeof t->pg_name, "ob_%s", name);
    char sql[160];
    snprintf(sql, sizeof sql, "PRAGMA table_info(\"%s\")", name);
    sqlite3_stmt *columns = NULL;
    if (sqlite3_prepare_v2(cache, sql, -1, &columns, NULL) != SQLITE_OK) {
      rc = SQLITE_ERROR;
      break;
    }
    int column_rc;
    while ((column_rc = sqlite3_step(columns)) == SQLITE_ROW) {
      const char *col = (const char *)sqlite3_column_text(columns, 1);
      const char *type = (const char *)sqlite3_column_text(columns, 2);
      if (t->count == MAX_COLUMNS || !identifier(col)) {
        column_rc = SQLITE_ERROR;
        break;
      }
      Column *c = &t->columns[t->count++];
      snprintf(c->name, sizeof c->name, "%s", col);
      c->json = json_column(name, col);
      c->string_document =
          !strcmp(name, "attachments") && !strcmp(col, "data_base64");
      snprintf(c->pg_name, sizeof c->pg_name, "%s%s", col,
               c->json ? "__doc" : "");
      c->primary = sqlite3_column_int(columns, 5);
      c->not_null = sqlite3_column_int(columns, 3) != 0;
      c->affinity = type && strstr(type, "INT") ? SQLITE_INTEGER
                    : type && (strstr(type, "REAL") || strstr(type, "FLOA") ||
                               strstr(type, "DOUB"))
                        ? SQLITE_FLOAT
                    : type && strstr(type, "BLOB") ? SQLITE_BLOB
                                                   : SQLITE_TEXT;
    }
    sqlite3_finalize(columns);
    if (column_rc != SQLITE_DONE || !t->count) {
      rc = SQLITE_ERROR;
      break;
    }
  }
  sqlite3_finalize(list);
  local_schema = scalar(cache, "PRAGMA user_version");
  return rc == SQLITE_DONE && local_schema > 0 ? 0 : -1;
}
static int connect_postgres(void) {
  if (postgres && PQstatus(postgres) == CONNECTION_OK)
    return 0;
  PQfinish(postgres);
  postgres = NULL;
  cache_epoch = -1;
  const char *url = getenv("OPENBOARD_POSTGRES_URL");
  if (!url || !*url)
    return -1;
  /* Separate parameters override URI defaults, including a bounded connection
   * wait. */
  const char *keywords[] = {"dbname",
                            "connect_timeout",
                            "application_name",
                            "keepalives_idle",
                            "keepalives_interval",
                            "keepalives_count",
                            "tcp_user_timeout",
                            NULL};
  const char *values[] = {url, "5", "openboard", "5", "2", "2", "10000", NULL};
  postgres = PQconnectdbParams(keywords, values, 1);
  if (!postgres || PQstatus(postgres) != CONNECTION_OK)
    return -1;
  PQsetNoticeProcessor(postgres, quiet_postgres, NULL);
  return pg_command("SET statement_timeout='10s';SET lock_timeout='5s';"
                    "SET idle_in_transaction_session_timeout='30s';"
                    "SET client_encoding='UTF8';SET search_path=public");
}
static void quiet_mongo(mongoc_log_level_t level, const char *domain,
                        const char *message, void *data) {
  (void)level;
  (void)domain;
  (void)message;
  (void)data;
}
static int mongo_ping(void) {
  if (!mongo_client)
    return -1;
  bson_t command = BSON_INITIALIZER;
  BSON_APPEND_INT32(&command, "ping", 1);
  bson_error_t error;
  bool ok = mongoc_client_command_simple(mongo_client, "admin", &command, NULL,
                                         NULL, &error);
  bson_destroy(&command);
  return ok ? 0 : -1;
}
static int connect_mongo(void) {
  const char *url = getenv("OPENBOARD_MONGODB_URI");
  if (!url || !*url)
    return -1;
  if (!mongoc_started) {
    mongoc_init();
    mongoc_log_set_handler(quiet_mongo, NULL);
    mongoc_started = true;
  }
  bson_error_t error;
  mongoc_uri_t *uri = mongoc_uri_new_with_error(url, &error);
  if (!uri)
    return -1;
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SERVERSELECTIONTIMEOUTMS,
                                 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_CONNECTTIMEOUTMS, 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SOCKETTIMEOUTMS, 10000);
  mongo_client = mongoc_client_new_from_uri(uri);
  const char *database = mongoc_uri_get_database(uri);
  if (mongo_client) {
    mongoc_client_set_error_api(mongo_client, 2);
    documents = mongoc_client_get_collection(
        mongo_client, database && *database ? database : "openboard",
        "documents");
  }
  mongoc_uri_destroy(uri);
  if (!documents)
    return -1;
  mongoc_write_concern_t *concern = mongoc_write_concern_new();
  mongoc_write_concern_set_wmajority(concern, 5000);
  mongoc_write_concern_set_journal(concern, true);
  mongoc_collection_set_write_concern(documents, concern);
  mongoc_write_concern_destroy(concern);
  return mongo_ping();
}
static int advisory_lock(void) {
  PGresult *r = PQexec(postgres, "SELECT pg_advisory_lock(" CLOUD_LOCK ")");
  bool ok = r && PQresultStatus(r) == PGRES_TUPLES_OK;
  PQclear(r);
  if (!ok) {
    /* Cancellation/transport failure can make lock acquisition ambiguous. A
     * fresh connection is the only safe way to avoid recursive session locks.
     */
    PQfinish(postgres);
    postgres = NULL;
    cache_epoch = -1;
  }
  return ok ? 0 : -1;
}
static void advisory_unlock(void) {
  if (postgres && PQstatus(postgres) == CONNECTION_OK) {
    PGresult *r = PQexec(postgres, "SELECT pg_advisory_unlock(" CLOUD_LOCK ")");
    bool ok = r && PQresultStatus(r) == PGRES_TUPLES_OK && PQntuples(r) == 1 &&
              !strcmp(PQgetvalue(r, 0, 0), "t");
    PQclear(r);
    if (!ok) {
      PQfinish(postgres);
      postgres = NULL;
      cache_epoch = -1;
    }
  }
}
static int read_epoch(int64_t *epoch, int *version) {
  PGresult *r = PQexec(
      postgres,
      "SELECT epoch,schema_version,layout_version FROM ob_store WHERE id=1");
  int rc = -1;
  if (r && PQresultStatus(r) == PGRES_TUPLES_OK) {
    if (!PQntuples(r))
      rc = 1;
    else if (PQntuples(r) == 1 &&
             atoi(PQgetvalue(r, 0, 2)) == CLOUD_LAYOUT_VERSION) {
      char *end;
      *epoch = strtoll(PQgetvalue(r, 0, 0), &end, 10);
      *version = atoi(PQgetvalue(r, 0, 1));
      rc = !*end && *epoch >= 0 ? 0 : -1;
    }
  }
  PQclear(r);
  return rc;
}
static int create_layout(void) {
  for (int ti = 0; ti < table_count; ti++) {
    Table *t = &tables[ti];
    Buffer sql = {0};
    buffer_add(&sql, "CREATE TABLE IF NOT EXISTS \"%s\"(", t->pg_name);
    int primary_count = 0;
    for (int i = 0; i < t->count; i++) {
      Column *c = &t->columns[i];
      const char *type = c->json                         ? "TEXT"
                         : c->affinity == SQLITE_INTEGER ? "BIGINT"
                         : c->affinity == SQLITE_FLOAT   ? "DOUBLE PRECISION"
                         : c->affinity == SQLITE_BLOB    ? "BYTEA"
                                                         : "TEXT";
      buffer_add(&sql, "%s\"%s\" %s%s", i ? "," : "", c->pg_name, type,
                 c->not_null ? " NOT NULL" : "");
      if (c->primary > primary_count)
        primary_count = c->primary;
    }
    if (primary_count) {
      buffer_add(&sql, ",PRIMARY KEY(");
      for (int order = 1; order <= primary_count; order++)
        for (int i = 0; i < t->count; i++)
          if (t->columns[i].primary == order)
            buffer_add(&sql, "%s\"%s\"", order > 1 ? "," : "",
                       t->columns[i].pg_name);
      buffer_add(&sql, ")");
    }
    buffer_add(&sql, ")");
    int rc = sql.failed ? -1 : pg_command(sql.data);
    free(sql.data);
    if (rc)
      return -1;
  }
  return 0;
}
typedef struct {
  int64_t id, parent;
  int child, last_child, next;
  int type, key_length, text_length;
  char *key, *text;
  int64_t integer;
  double real;
} JsonNode;
typedef struct {
  int64_t id;
  int position;
} JsonIndex;
enum { JSON_OBJECT = 20, JSON_ARRAY, JSON_TRUE, JSON_FALSE };
static int compare_json_index(const void *left, const void *right) {
  const JsonIndex *a = left, *b = right;
  return a->id < b->id ? -1 : a->id > b->id;
}
static int find_json_parent(JsonIndex *index, int count, int64_t id) {
  JsonIndex key = {id, 0};
  JsonIndex *found =
      bsearch(&key, index, (size_t)count, sizeof *index, compare_json_index);
  return found ? found->position : -1;
}
static char *copy_sqlite_text(sqlite3_stmt *s, int column, int *length) {
  const char *source = (const char *)sqlite3_column_text(s, column);
  *length = sqlite3_column_bytes(s, column);
  if (!source || *length < 0)
    return NULL;
  char *copy = malloc((size_t)*length + 1);
  if (copy) {
    memcpy(copy, source, (size_t)*length);
    copy[*length] = 0;
  }
  return copy;
}
static bool append_json_node(bson_t *output, const char *key, int key_length,
                             const JsonNode *nodes, int position, int depth) {
  const JsonNode *node = &nodes[position];
  /* Request input is capped at 90. Leave room for server-generated board/card
   * template envelopes while staying below MongoDB's BSON nesting limit. */
  if (depth > 96 || memchr(key, 0, (size_t)key_length))
    return false;
  if (node->type == JSON_OBJECT || node->type == JSON_ARRAY) {
    bson_t child;
    bool ok;
    if (node->type == JSON_OBJECT)
      ok = bson_append_document_begin(output, key, key_length, &child);
    else {
#if BSON_CHECK_VERSION(2, 0, 0)
      ok = bson_append_array_unsafe_begin(output, key, key_length, &child);
#else
      ok = bson_append_array_begin(output, key, key_length, &child);
#endif
    }
    if (!ok)
      return false;
    for (int i = node->child; i >= 0; i = nodes[i].next) {
      if (!append_json_node(&child, nodes[i].key, nodes[i].key_length, nodes, i,
                            depth + 1)) {
        /* End even on failure: child buffers are owned by their parent. */
        if (node->type == JSON_OBJECT)
          bson_append_document_end(output, &child);
        else
          bson_append_array_end(output, &child);
        return false;
      }
    }
    return node->type == JSON_OBJECT ? bson_append_document_end(output, &child)
                                     : bson_append_array_end(output, &child);
  }
  if (node->type == SQLITE_INTEGER)
    return bson_append_int64(output, key, key_length, node->integer);
  if (node->type == SQLITE_FLOAT)
    return bson_append_double(output, key, key_length, node->real);
  if (node->type == SQLITE_TEXT)
    return bson_append_utf8(output, key, key_length, node->text,
                            node->text_length);
  if (node->type == JSON_TRUE || node->type == JSON_FALSE)
    return bson_append_bool(output, key, key_length, node->type == JSON_TRUE);
  return bson_append_null(output, key, key_length);
}
/* Do not use bson_new_from_json here: its Extended JSON parser interprets
 * literal user keys such as {"$date":"ordinary text"} as BSON operators.
 * SQLite's JSON parser plus typed BSON append preserves those keys literally.
 */
static bool append_json_value(sqlite3 *cache, bson_t *document,
                              const char *raw) {
  sqlite3_stmt *s = NULL;
  JsonNode *nodes = NULL;
  JsonIndex *index = NULL;
  int count = 0, capacity = 0, rc = SQLITE_ERROR, root = -1;
  bool ok = false;
  if (sqlite3_prepare_v2(cache,
                         "SELECT id,parent,key,type,atom FROM json_tree(?1)",
                         -1, &s, NULL) != SQLITE_OK)
    goto done;
  sqlite3_bind_text(s, 1, raw, -1, SQLITE_STATIC);
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    if (count == capacity) {
      int next = capacity ? capacity * 2 : 64;
      if (next < capacity || next > 1048576)
        goto done;
      JsonNode *grown = realloc(nodes, (size_t)next * sizeof *nodes);
      if (!grown)
        goto done;
      nodes = grown;
      capacity = next;
    }
    JsonNode *n = &nodes[count++];
    memset(n, 0, sizeof *n);
    n->id = sqlite3_column_int64(s, 0);
    n->parent = sqlite3_column_type(s, 1) == SQLITE_NULL
                    ? -1
                    : sqlite3_column_int64(s, 1);
    n->child = n->last_child = n->next = -1;
    if (n->parent >= 0) {
      n->key = copy_sqlite_text(s, 2, &n->key_length);
      if (!n->key)
        goto done;
    } else {
      if (root >= 0)
        goto done;
      root = count - 1;
    }
    const char *type = (const char *)sqlite3_column_text(s, 3);
    n->type = !strcmp(type, "object")  ? JSON_OBJECT
              : !strcmp(type, "array") ? JSON_ARRAY
              : !strcmp(type, "true")  ? JSON_TRUE
              : !strcmp(type, "false") ? JSON_FALSE
                                       : sqlite3_column_type(s, 4);
    if (n->type == SQLITE_TEXT) {
      n->text = copy_sqlite_text(s, 4, &n->text_length);
      if (!n->text)
        goto done;
    } else if (n->type == SQLITE_INTEGER)
      n->integer = sqlite3_column_int64(s, 4);
    else if (n->type == SQLITE_FLOAT)
      n->real = sqlite3_column_double(s, 4);
  }
  if (rc != SQLITE_DONE || root < 0)
    goto done;
  index = malloc((size_t)count * sizeof *index);
  if (!index)
    goto done;
  for (int i = 0; i < count; i++)
    index[i] = (JsonIndex){nodes[i].id, i};
  qsort(index, (size_t)count, sizeof *index, compare_json_index);
  for (int i = 0; i < count; i++)
    if (nodes[i].parent >= 0) {
      int parent = find_json_parent(index, count, nodes[i].parent);
      if (parent < 0 || parent == i)
        goto done;
      if (nodes[parent].last_child >= 0)
        nodes[nodes[parent].last_child].next = i;
      else
        nodes[parent].child = i;
      nodes[parent].last_child = i;
    }
  ok = append_json_node(document, "value", 5, nodes, root, 0);
done:
  sqlite3_finalize(s);
  for (int i = 0; i < count; i++) {
    free(nodes[i].key);
    free(nodes[i].text);
  }
  free(nodes);
  free(index);
  return ok;
}
static int document_put(sqlite3 *cache, const Table *t, const Column *c,
                        const char *raw, char key[65]) {
  char kind[MAX_IDENTIFIER * 2 + 2];
  snprintf(kind, sizeof kind, "%s.%s", t->name, c->name);
  if (digest(kind, raw, key))
    return -1;
  if (memo_find(key))
    return 0;
  bson_error_t error;
  bson_t *document = bson_new();
  if (!document)
    return -1;
  bool built = BSON_APPEND_UTF8(document, "_id", key) &&
               BSON_APPEND_UTF8(document, "kind", kind) &&
               BSON_APPEND_UTF8(document, "raw", raw) &&
               (c->string_document ? BSON_APPEND_UTF8(document, "value", raw)
                                   : append_json_value(cache, document, raw));
  if (!built) {
    bson_destroy(document);
    return -1;
  }
  bson_t filter = BSON_INITIALIZER, update = BSON_INITIALIZER,
         opts = BSON_INITIALIZER;
  BSON_APPEND_UTF8(&filter, "_id", key);
  BSON_APPEND_DOCUMENT(&update, "$setOnInsert", document);
  BSON_APPEND_BOOL(&opts, "upsert", true);
  bool ok = mongoc_collection_update_one(documents, &filter, &update, &opts,
                                         NULL, &error);
  bson_destroy(document);
  bson_destroy(&filter);
  bson_destroy(&update);
  bson_destroy(&opts);
  return ok && !memo_add(key, raw) ? 0 : -1;
}
static const char *document_get(const Table *t, const Column *c,
                                const char *key) {
  if (strlen(key) != 64)
    return NULL;
  DocMemo *existing = memo_find(key);
  if (existing)
    return existing->raw;
  bson_t filter = BSON_INITIALIZER, opts = BSON_INITIALIZER;
  BSON_APPEND_UTF8(&filter, "_id", key);
  BSON_APPEND_INT64(&opts, "limit", 1);
  mongoc_cursor_t *cursor =
      mongoc_collection_find_with_opts(documents, &filter, &opts, NULL);
  const bson_t *document;
  const char *raw = NULL;
  bson_iter_t value;
  if (mongoc_cursor_next(cursor, &document) &&
      bson_iter_init_find(&value, document, "raw") &&
      BSON_ITER_HOLDS_UTF8(&value)) {
    const char *source = bson_iter_utf8(&value, NULL);
    char kind[MAX_IDENTIFIER * 2 + 2], actual[65];
    snprintf(kind, sizeof kind, "%s.%s", t->name, c->name);
    if (!digest(kind, source, actual) && !strcmp(actual, key) &&
        !memo_add(key, source))
      raw = memo->raw;
  }
  mongoc_cursor_destroy(cursor);
  bson_destroy(&filter);
  bson_destroy(&opts);
  return raw;
}
static Buffer select_sql(const Table *t, bool pg) {
  Buffer b = {0};
  buffer_add(&b, "SELECT ");
  for (int i = 0; i < t->count; i++)
    buffer_add(&b, "%s\"%s\"", i ? "," : "",
               pg ? t->columns[i].pg_name : t->columns[i].name);
  buffer_add(&b, " FROM \"%s\"", pg ? t->pg_name : t->name);
  return b;
}
static Buffer insert_sql(const Table *t, bool pg) {
  Buffer b = {0};
  buffer_add(&b, "INSERT INTO \"%s\"(", pg ? t->pg_name : t->name);
  for (int i = 0; i < t->count; i++)
    buffer_add(&b, "%s\"%s\"", i ? "," : "",
               pg ? t->columns[i].pg_name : t->columns[i].name);
  buffer_add(&b, ") VALUES(");
  for (int i = 0; i < t->count; i++)
    buffer_add(&b, "%s%s%d", i ? "," : "", pg ? "$" : "?", i + 1);
  buffer_add(&b, ")");
  return b;
}
static int publish_table(sqlite3 *cache, const Table *t) {
  Buffer select = select_sql(t, false), insert = insert_sql(t, true);
  sqlite3_stmt *rows = NULL;
  int rc = -1;
  if (select.failed || insert.failed ||
      sqlite3_prepare_v2(cache, select.data, -1, &rows, NULL) != SQLITE_OK)
    goto done;
  int step;
  while ((step = sqlite3_step(rows)) == SQLITE_ROW) {
    const char *values[MAX_COLUMNS] = {0};
    int formats[MAX_COLUMNS] = {0}, lengths[MAX_COLUMNS] = {0};
    char hashes[MAX_COLUMNS][65];
    for (int i = 0; i < t->count; i++) {
      const Column *c = &t->columns[i];
      int type = sqlite3_column_type(rows, i);
      if (type == SQLITE_NULL)
        continue;
      if (c->json) {
        const char *raw = (const char *)sqlite3_column_text(rows, i);
        if (!raw || document_put(cache, t, c, raw, hashes[i]))
          goto done;
        values[i] = hashes[i];
      } else if (c->affinity == SQLITE_BLOB) {
        values[i] = (const char *)sqlite3_column_blob(rows, i);
        lengths[i] = sqlite3_column_bytes(rows, i);
        formats[i] = 1;
      } else
        values[i] = (const char *)sqlite3_column_text(rows, i);
    }
    PGresult *r = PQexecParams(postgres, insert.data, t->count, NULL, values,
                               lengths, formats, 0);
    bool ok = r && PQresultStatus(r) == PGRES_COMMAND_OK;
    PQclear(r);
    if (!ok)
      goto done;
  }
  rc = step == SQLITE_DONE ? 0 : -1;
done:
  sqlite3_finalize(rows);
  free(select.data);
  free(insert.data);
  return rc;
}
/* Documents are immutable and acknowledged before the relational transaction
 * publishes their references. A crash can leave unused documents, never a
 * committed relational reference to a document still being written. */
static int publish_snapshot(sqlite3 *cache, bool initial) {
  if (sqlite3_get_autocommit(cache) == 0 || mongo_ping() || pg_command("BEGIN"))
    return -1;
  if (initial && create_layout())
    goto failed;
  for (int i = 0; i < table_count; i++) {
    char sql[160];
    snprintf(sql, sizeof sql, "DELETE FROM \"%s\"", tables[i].pg_name);
    if (pg_command(sql))
      goto failed;
  }
  for (int i = 0; i < table_count; i++)
    if (publish_table(cache, &tables[i]))
      goto failed;
  char sql[320];
  if (initial)
    snprintf(sql, sizeof sql,
             "INSERT INTO ob_store(id,epoch,schema_version,layout_version) "
             "VALUES(1,1,%d,%d)",
             local_schema, CLOUD_LAYOUT_VERSION);
  else
    snprintf(
        sql, sizeof sql,
        "UPDATE ob_store SET epoch=epoch+1 WHERE id=1 AND schema_version=%d",
        local_schema);
  if (pg_command(sql) || pg_command("COMMIT"))
    goto failed;
  cache_epoch = initial ? 1 : cache_epoch + 1;
  return 0;
failed:
  pg_command("ROLLBACK");
  cache_epoch = -1;
  return -1;
}
static int hydrate_table(sqlite3 *cache, const Table *t) {
  Buffer select = select_sql(t, true), insert = insert_sql(t, false);
  PGresult *rows = NULL;
  sqlite3_stmt *s = NULL;
  int rc = -1;
  if (select.failed || insert.failed)
    goto done;
  rows = PQexec(postgres, select.data);
  if (!rows || PQresultStatus(rows) != PGRES_TUPLES_OK ||
      PQnfields(rows) != t->count ||
      sqlite3_prepare_v2(cache, insert.data, -1, &s, NULL) != SQLITE_OK)
    goto done;
  for (int row = 0; row < PQntuples(rows); row++) {
    sqlite3_reset(s);
    sqlite3_clear_bindings(s);
    for (int i = 0; i < t->count; i++) {
      const Column *c = &t->columns[i];
      if (PQgetisnull(rows, row, i))
        continue;
      const char *value = PQgetvalue(rows, row, i);
      int bound;
      if (c->json) {
        value = document_get(t, c, value);
        if (!value)
          goto done;
        bound = sqlite3_bind_text(s, i + 1, value, -1, SQLITE_TRANSIENT);
      } else if (c->affinity == SQLITE_INTEGER) {
        char *end;
        long long number = strtoll(value, &end, 10);
        if (*end)
          goto done;
        bound = sqlite3_bind_int64(s, i + 1, number);
      } else if (c->affinity == SQLITE_FLOAT) {
        char *end;
        double number = strtod(value, &end);
        if (*end)
          goto done;
        bound = sqlite3_bind_double(s, i + 1, number);
      } else if (c->affinity == SQLITE_BLOB) {
        size_t length;
        unsigned char *bytes =
            PQunescapeBytea((const unsigned char *)value, &length);
        if (!bytes || length > INT_MAX) {
          PQfreemem(bytes);
          goto done;
        }
        bound =
            sqlite3_bind_blob(s, i + 1, bytes, (int)length, SQLITE_TRANSIENT);
        PQfreemem(bytes);
      } else
        bound = sqlite3_bind_text(s, i + 1, value, PQgetlength(rows, row, i),
                                  SQLITE_TRANSIENT);
      if (bound != SQLITE_OK)
        goto done;
    }
    if (sqlite3_step(s) != SQLITE_DONE)
      goto done;
  }
  rc = 0;
done:
  sqlite3_finalize(s);
  PQclear(rows);
  free(select.data);
  free(insert.data);
  return rc;
}
/* Replay must not fire notification/timestamp triggers, or a cache rebuild
 * would change data. SQLite exposes an engine-level trigger switch for this. */
static int hydrate_snapshot(sqlite3 *cache, int64_t epoch) {
  if (sqlite3_get_autocommit(cache) == 0)
    return -1;
  int previous_triggers = 1;
  if (sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, -1,
                        &previous_triggers) != SQLITE_OK ||
      sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, NULL) !=
          SQLITE_OK)
    return -1;
  int rc = -1;
  if (cache_command(cache, "PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE"))
    goto done;
  for (int i = 0; i < table_count; i++) {
    char sql[160];
    snprintf(sql, sizeof sql, "DELETE FROM \"%s\"", tables[i].name);
    if (cache_command(cache, sql))
      goto rollback;
  }
  /* sqlite_sequence must be loaded last: inserting AUTOINCREMENT rows into
   * other tables updates it even when user triggers are disabled. */
  for (int i = 0; i < table_count; i++)
    if (strcmp(tables[i].name, "sqlite_sequence") &&
        hydrate_table(cache, &tables[i]))
      goto rollback;
  for (int i = 0; i < table_count; i++)
    if (!strcmp(tables[i].name, "sqlite_sequence")) {
      if (cache_command(cache, "DELETE FROM sqlite_sequence") ||
          hydrate_table(cache, &tables[i]))
        goto rollback;
    }
  {
    sqlite3_stmt *check = NULL;
    bool valid = sqlite3_prepare_v2(cache, "PRAGMA foreign_key_check", -1,
                                    &check, NULL) == SQLITE_OK &&
                 sqlite3_step(check) == SQLITE_DONE;
    sqlite3_finalize(check);
    if (!valid)
      goto rollback;
  }
  if (cache_command(cache, "COMMIT"))
    goto rollback;
  cache_epoch = epoch;
  rc = 0;
  goto done;
rollback:
  cache_command(cache, "ROLLBACK");
done:
  cache_command(cache, "PRAGMA foreign_keys=ON");
  sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, previous_triggers,
                    NULL);
  if (rc)
    cache_epoch = -1;
  return rc;
}
int cloud_bootstrap(sqlite3 *cache) {
  if (!cloud_enabled())
    return 0;
  pthread_mutex_lock(&store_mutex);
  int rc = -1;
  bool locked = false;
  const char *pg = getenv("OPENBOARD_POSTGRES_URL"),
             *mongo = getenv("OPENBOARD_MONGODB_URI");
  if (!pg || !*pg || !mongo || !*mongo) {
    fputs("Imposta insieme OPENBOARD_POSTGRES_URL e OPENBOARD_MONGODB_URI.\n",
          stderr);
    goto done;
  }
  if (inspect_schema(cache) || connect_postgres() || connect_mongo() ||
      advisory_lock())
    goto done;
  locked = true;
  if (pg_command("CREATE TABLE IF NOT EXISTS ob_store(id SMALLINT PRIMARY KEY "
                 "CHECK(id=1),"
                 "epoch BIGINT NOT NULL,schema_version INTEGER NOT "
                 "NULL,layout_version INTEGER NOT NULL)"))
    goto done;
  int64_t epoch;
  int version;
  int state = read_epoch(&epoch, &version);
  if (state < 0)
    goto done;
  if (!state && version != local_schema) {
    fprintf(stderr,
            "Schema storage esterno %d incompatibile con schema locale %d.\n",
            version, local_schema);
    goto done;
  }
  rc = state == 1 ? publish_snapshot(cache, true)
                  : hydrate_snapshot(cache, epoch);
  if (!rc)
    bootstrapped = true;
done:
  clear_memo();
  if (locked)
    advisory_unlock();
  if (rc)
    fputs("Storage PostgreSQL/MongoDB non disponibile; avvio interrotto.\n",
          stderr);
  pthread_mutex_unlock(&store_mutex);
  return rc;
}
int cloud_request_begin(sqlite3 *cache) {
  if (!cloud_enabled())
    return 0;
  if (request_active)
    return -1;
  pthread_mutex_lock(&store_mutex);
  if (!bootstrapped || connect_postgres() || advisory_lock())
    goto failed;
  int64_t epoch;
  int version;
  if (read_epoch(&epoch, &version) || version != local_schema ||
      (epoch != cache_epoch && hydrate_snapshot(cache, epoch))) {
    advisory_unlock();
    goto failed;
  }
  clear_memo();
  request_active = true;
  return 0;
failed:
  cache_epoch = -1;
  clear_memo();
  pthread_mutex_unlock(&store_mutex);
  return -1;
}
int cloud_request_finish(sqlite3 *cache, bool changed) {
  if (!cloud_enabled())
    return 0;
  if (!request_active)
    return -1;
  int rc = changed ? publish_snapshot(cache, false) : 0;
  if (rc)
    cache_epoch = -1;
  clear_memo();
  advisory_unlock();
  request_active = false;
  pthread_mutex_unlock(&store_mutex);
  return rc;
}
void cloud_request_abort(sqlite3 *cache) {
  (void)cache;
  if (!request_active)
    return;
  cache_epoch = -1;
  clear_memo();
  advisory_unlock();
  request_active = false;
  pthread_mutex_unlock(&store_mutex);
}
int cloud_ready(void) {
  if (!cloud_enabled())
    return 0;
  bool acquire = !request_active;
  if (acquire)
    pthread_mutex_lock(&store_mutex);
  int rc = bootstrapped && !connect_postgres() && !mongo_ping() ? 0 : -1;
  if (acquire)
    pthread_mutex_unlock(&store_mutex);
  return rc;
}
void cloud_shutdown(void) {
  pthread_mutex_lock(&store_mutex);
  clear_memo();
  free(tables);
  tables = NULL;
  table_count = 0;
  mongoc_collection_destroy(documents);
  documents = NULL;
  mongoc_client_destroy(mongo_client);
  mongo_client = NULL;
  if (mongoc_started)
    mongoc_cleanup();
  mongoc_started = false;
  PQfinish(postgres);
  postgres = NULL;
  cache_epoch = -1;
  bootstrapped = false;
  pthread_mutex_unlock(&store_mutex);
}
#endif
