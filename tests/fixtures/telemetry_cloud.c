/* Reuse the offline driver fixture: real SQLite, injected SQL/Mongo outcomes. */
#define main cloud_fixture_main
#include "cloud_incremental.c"
#undef main

static unsigned long long value(const char *body, const char *name) {
  const char *found = body;
  while (*found && (strncmp(found, name, strlen(name)) || found[strlen(name)] != ' ')) {
    found = strchr(found, '\n');
    assert(found);
    found++;
  }
  assert(found && found[strlen(name)] == ' ');
  return strtoull(found + strlen(name) + 1, NULL, 10);
}
int main(void) {
  sqlite3 *cache = new_cache();
  test_publication(cache);
  /* Capacity rejection happens before trigger, epoch or row mutation. */
  fixture_cache_capacity = false;
  cache_epoch = 42;
  assert(hydrate_snapshot(cache, 100) == -1);
  assert(cache_epoch == 42 && sqlite3_get_autocommit(cache));
  assert(scalar(cache, "SELECT count(*) FROM records") == 3);
  assert(scalar(cache, "SELECT enabled FROM temp.ob_cloud_tracking") == 1);
  fixture_cache_capacity = true;
  /* Free space can change while BEGIN waits: reject again under the lock and
   * restore transaction, trigger, foreign-key and change-tracker state. */
  fixture_cache_checks_until_denial = 1;
  assert(hydrate_snapshot(cache, 100) == -1);
  assert(cache_epoch == -1 && sqlite3_get_autocommit(cache));
  assert(scalar(cache, "SELECT count(*) FROM records") == 3);
  assert(scalar(cache, "SELECT enabled FROM temp.ob_cloud_tracking") == 1);
  assert(scalar(cache, "PRAGMA foreign_keys") == 1);
  int triggers_enabled = 0;
  assert(sqlite3_db_config(cache, SQLITE_DBCONFIG_ENABLE_TRIGGER, -1, &triggers_enabled) == SQLITE_OK);
  assert(triggers_enabled == 1);
  fixture_cache_checks_until_denial = -1;
  /* A refused hydrate and a failed read must preserve the cache. */
  run_sql(cache, "BEGIN");
  assert(hydrate_snapshot(cache, 100) == -1);
  run_sql(cache, "ROLLBACK");
  assert(hydrate_snapshot(cache, 100) == -1);
  assert(scalar(cache, "SELECT count(*) FROM records") == 3);
  assert(scalar(cache, "SELECT count(*) FROM records WHERE value='updated'") == 1);
  assert(advisory_lock() == -1);
  store_lock();
  pthread_mutex_unlock(&store_mutex);
  char body[OB_TELEMETRY_BUFFER_SIZE];
  assert(ob_telemetry_format(body, sizeof body));
  assert(value(body, "openboard_storage_operation_duration_seconds_count{operation=\"publish\"}") == 3);
  assert(value(body, "openboard_storage_operation_errors_total{operation=\"publish\"}") == 2);
  /* Two keyed inserts, one unkeyed table fallback and sqlite_sequence. */
  assert(value(body, "openboard_storage_rows_published_total") == 4);
  assert(value(body, "openboard_storage_operation_duration_seconds_count{operation=\"hydrate\"}") == 4);
  assert(value(body, "openboard_storage_operation_errors_total{operation=\"hydrate\"}") == 4);
  assert(value(body, "openboard_storage_operation_duration_seconds_count{operation=\"postgres_lock\"}") == 1);
  assert(value(body, "openboard_storage_operation_errors_total{operation=\"postgres_lock\"}") == 1);
  assert(value(body, "openboard_storage_operation_duration_seconds_count{operation=\"mutex_wait\"}") == 1);
  assert(!strstr(body, "updated") && !strstr(body, "ob_records"));
  clear_memo();
  free(tables);
  assert(sqlite3_close(cache) == SQLITE_OK);
  puts("storage operation failures and confirmed publication row counts OK");
}
