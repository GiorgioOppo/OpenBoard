/* Exercise the storage adapter with real SQLite/BSON and SQL failure injection.
 * No database server, credentials or production test switches are required. */
#define _POSIX_C_SOURCE 200809L
#include <libpq-fe.h>
#include <mongoc/mongoc.h>

static PGresult *fixture_exec(PGconn *, const char *);
static PGresult *fixture_exec_params(PGconn *, const char *, int, const Oid *,
                                    const char *const *, const int *, const int *, int);
static bool fixture_mongo_ping(mongoc_client_t *, const char *, const bson_t *,
                               const mongoc_read_prefs_t *, bson_t *, bson_error_t *);
#define PQexec fixture_exec
#define PQexecParams fixture_exec_params
#define mongoc_client_command_simple fixture_mongo_ping
#include "../../src/cloud.c"
static bool fixture_cache_capacity = true;
static int fixture_cache_checks_until_denial = -1;
bool ob_storage_cache_write_allowed(void) {
  if (fixture_cache_checks_until_denial == 0) return false;
  if (fixture_cache_checks_until_denial > 0) fixture_cache_checks_until_denial--;
  return fixture_cache_capacity;
}
#undef PQexec
#undef PQexecParams
#undef mongoc_client_command_simple

#include <assert.h>

static char commands[65536];
static bool fail_insert, fail_ping;
static PGresult *fixture_exec(PGconn *connection, const char *sql) {
  (void)connection;
  assert(strlen(commands) + strlen(sql) + 2 < sizeof commands);
  strcat(commands, sql);
  strcat(commands, "\n");
  return PQmakeEmptyPGresult(NULL, PGRES_COMMAND_OK);
}
static PGresult *fixture_exec_params(PGconn *connection, const char *sql,
                                     int count, const Oid *types,
                                     const char *const *values,
                                     const int *lengths, const int *formats,
                                     int result_format) {
  (void)types; (void)lengths; (void)formats; (void)result_format;
  PGresult *result = fixture_exec(connection, sql);
  for (int i = 0; i < count; i++) {
    assert(strlen(commands) + strlen(values[i] ? values[i] : "NULL") + 2 < sizeof commands);
    strcat(commands, values[i] ? values[i] : "NULL");
    strcat(commands, "|");
  }
  strcat(commands, "\n");
  if (fail_insert && strstr(sql, "INSERT INTO \"ob_records\"")) {
    PQclear(result);
    return PQmakeEmptyPGresult(NULL, PGRES_FATAL_ERROR);
  }
  return result;
}
static bool fixture_mongo_ping(mongoc_client_t *client, const char *database,
                               const bson_t *command,
                               const mongoc_read_prefs_t *preferences,
                               bson_t *reply, bson_error_t *error) {
  (void)client; (void)database; (void)command;
  (void)preferences; (void)reply; (void)error;
  return !fail_ping;
}
static void run_sql(sqlite3 *cache, const char *sql) {
  char *error = NULL;
  int rc = sqlite3_exec(cache, sql, NULL, NULL, &error);
  if (rc != SQLITE_OK)
    fprintf(stderr, "%s: %s\n", sql, error ? error : "SQLite failure");
  sqlite3_free(error);
  assert(rc == SQLITE_OK);
}
static int table_id(const char *name) {
  for (int i = 0; i < table_count; i++)
    if (!strcmp(tables[i].name, name))
      return i;
  assert(false);
  return -1;
}
static sqlite3 *new_cache(void) {
  sqlite3 *cache = NULL;
  assert(sqlite3_open_v2("file:cloud-fixture?mode=memory&cache=shared", &cache,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI,
                        NULL) == SQLITE_OK);
  run_sql(cache, "PRAGMA foreign_keys=ON;PRAGMA user_version=7;"
                 "CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);"
                 "CREATE TABLE links(owner INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,"
                 "tag TEXT NOT NULL,PRIMARY KEY(owner,tag));"
                 "CREATE TABLE unkeyed(value TEXT);"
                 "INSERT INTO records(id,value) VALUES(1,'first'),(2,'removed'),(3,'untouched');"
                 "INSERT INTO links VALUES(2,'original');INSERT INTO unkeyed VALUES('before');");
  assert(inspect_schema(cache) == 0);
  assert(install_change_tracker(cache) == 0);
  return cache;
}
static bool has_key(sqlite3 *cache, const char *table, const char *key) {
  sqlite3_stmt *s = NULL;
  assert(sqlite3_prepare_v2(cache, "SELECT 1 FROM temp.ob_cloud_changes WHERE table_id=?1 AND key=?2",
                            -1, &s, NULL) == SQLITE_OK);
  sqlite3_bind_int(s, 1, table_id(table));
  sqlite3_bind_text(s, 2, key, -1, SQLITE_STATIC);
  bool found = sqlite3_step(s) == SQLITE_ROW;
  sqlite3_finalize(s);
  return found;
}
static void test_tracker(sqlite3 *cache) {
  run_sql(cache, "BEGIN;UPDATE records SET value='rolled back' WHERE id=1;"
                 "DELETE FROM records WHERE id=2;ROLLBACK");
  assert(scalar(cache, "SELECT count(*) FROM temp.ob_cloud_changes") == 0);
  assert(scalar(cache, "SELECT count(*) FROM links WHERE owner=2") == 1);
  run_sql(cache, "BEGIN;UPDATE records SET value='committed' WHERE id=1;"
                 "SAVEPOINT nested;DELETE FROM records WHERE id=2;"
                 "ROLLBACK TO nested;RELEASE nested;COMMIT");
  assert(has_key(cache, "records", "[1]"));
  assert(!has_key(cache, "records", "[2]"));
  assert(!has_key(cache, "links", "[2,\"original\"]"));
  assert(install_change_tracker(cache) == 0);
  run_sql(cache, "UPDATE records SET id=9007199254740993 WHERE id=1;"
                 "UPDATE links SET tag='changed' WHERE owner=2;"
                 "DELETE FROM records WHERE id=2;INSERT INTO unkeyed VALUES('after');");
  assert(has_key(cache, "records", "[1]"));
  assert(has_key(cache, "records", "[9007199254740993]"));
  assert(has_key(cache, "records", "[2]"));
  assert(has_key(cache, "links", "[2,\"original\"]"));
  assert(has_key(cache, "links", "[2,\"changed\"]"));
  assert(has_key(cache, "unkeyed", ""));
  sqlite3 *other = NULL;
  assert(sqlite3_open_v2("file:cloud-fixture?mode=memory&cache=shared", &other,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_URI, NULL) == SQLITE_OK);
  assert(install_change_tracker(other) == 0);
  assert(scalar(other, "SELECT count(*) FROM temp.ob_cloud_changes") == 0);
  run_sql(other, "UPDATE records SET value='other connection' WHERE id=3");
  assert(has_key(other, "records", "[3]"));
  assert(!has_key(cache, "records", "[3]"));
  assert(sqlite3_close(other) == SQLITE_OK);
  /* Rehydration disables all triggers and must not create publication work. */
  assert(install_change_tracker(cache) == 0);
  assert(set_change_tracking(cache, false) == 0);
  assert(sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, NULL) == SQLITE_OK);
  run_sql(cache, "UPDATE records SET value='rehydrated' WHERE id=3");
  assert(sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, 1, NULL) == SQLITE_OK);
  assert(set_change_tracking(cache, true) == 0);
  assert(scalar(cache, "SELECT count(*) FROM temp.ob_cloud_changes") == 0);
  puts("transactional tracker, composite keys, cascades and connection isolation OK");
}
static void test_publication(sqlite3 *cache) {
  run_sql(cache, "UPDATE records SET value='updated' WHERE id=1;"
                 "DELETE FROM records WHERE id=2;INSERT INTO records(id,value) VALUES(4,'new');"
                 "UPDATE unkeyed SET value='after';");
  mongo_client = (mongoc_client_t *)(uintptr_t)1;
  cache_epoch = 41;
  assert(publish_snapshot(cache, false) == 0);
  assert(cache_epoch == 42);
  assert(strstr(commands, "DELETE FROM \"ob_records\" WHERE \"id\" IS NOT DISTINCT FROM $1"));
  assert(!strstr(commands, "DELETE FROM \"ob_records\"\n"));
  assert(strstr(commands, "1|updated|"));
  assert(strstr(commands, "4|new|"));
  assert(!strstr(commands, "untouched"));
  assert(strstr(commands, "DELETE FROM \"ob_links\" WHERE \"owner\" IS NOT DISTINCT FROM $1 AND \"tag\" IS NOT DISTINCT FROM $2"));
  assert(strstr(commands, "DELETE FROM \"ob_unkeyed\"\n"));
  assert(strstr(commands, "COMMIT\n"));
  commands[0] = 0;
  fail_insert = true;
  assert(publish_snapshot(cache, false) == -1);
  assert(cache_epoch == -1);
  assert(strstr(commands, "ROLLBACK\n"));
  assert(!strstr(commands, "COMMIT\n"));
  assert(!strstr(commands, "UPDATE ob_store"));
  fail_insert = false;
  commands[0] = 0;
  fail_ping = true;
  assert(publish_snapshot(cache, false) == -1);
  assert(commands[0] == 0); /* Mongo outage prevents any SQL mutation. */
  fail_ping = false;
  mongo_client = NULL;
  puts("incremental SQL, table fallback, rollback and Mongo outage OK");
}
static bson_t *make_document(sqlite3 *cache, const Table *t, const Column *c,
                              const char *key, const char *raw,
                              const char *kind_override, bool bad_value) {
  bson_t *document = bson_new();
  char kind[MAX_IDENTIFIER * 2 + 2];
  snprintf(kind, sizeof kind, "%s.%s", t->name, c->name);
  assert(BSON_APPEND_UTF8(document, "_id", key));
  assert(BSON_APPEND_UTF8(document, "kind", kind_override ? kind_override : kind));
  assert(BSON_APPEND_UTF8(document, "raw", raw));
  assert(bad_value ? BSON_APPEND_UTF8(document, "value", "altered")
                  : c->string_document ? BSON_APPEND_UTF8(document, "value", raw)
                                       : append_json_value(cache, document, raw));
  return document;
}
static void test_integrity(sqlite3 *cache) {
  Table t = {0};
  Column c = {0};
  strcpy(t.name, "cards"); strcpy(c.name, "checklist"); c.json = true;
  const char *raw = "[{\"$date\":\"literal\",\"text\":\"Caffè ☕\\u0000fine\",\"done\":false,\"n\":9007199254740993}]";
  char key[65];
  assert(digest("cards.checklist", raw, key) == 0);
  bson_t *document = make_document(cache, &t, &c, key, raw, NULL, false);
  assert(validate_document(cache, &t, &c, key, document));
  bson_destroy(document);
  document = make_document(cache, &t, &c, key, raw, NULL, true);
  assert(!validate_document(cache, &t, &c, key, document));
  bson_destroy(document);
  document = make_document(cache, &t, &c, key, raw, "other.kind", false);
  assert(!validate_document(cache, &t, &c, key, document));
  bson_destroy(document);
  document = make_document(cache, &t, &c, key, "[]", NULL, false);
  assert(!validate_document(cache, &t, &c, key, document));
  bson_destroy(document);
  document = make_document(cache, &t, &c, key, raw, NULL, false);
  assert(!validate_document(cache, &t, &c, "0000000000000000000000000000000000000000000000000000000000000000", document));
  bson_destroy(document);
  strcpy(t.name, "attachments"); strcpy(c.name, "data_base64"); c.string_document = true;
  assert(digest("attachments.data_base64", "YQ==", key) == 0);
  document = make_document(cache, &t, &c, key, "YQ==", NULL, false);
  assert(validate_document(cache, &t, &c, key, document));
  bson_destroy(document);
  puts("document identity, kind, digest and typed projection integrity OK");
}
int main(int argc, char **argv) {
  assert(argc == 2);
  sqlite3 *cache = new_cache();
  if (!strcmp(argv[1], "tracker")) test_tracker(cache);
  else if (!strcmp(argv[1], "publication")) test_publication(cache);
  else if (!strcmp(argv[1], "integrity")) test_integrity(cache);
  else assert(false);
  clear_memo();
  free(tables);
  assert(sqlite3_close(cache) == SQLITE_OK);
  return 0;
}
