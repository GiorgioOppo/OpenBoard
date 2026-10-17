/* SPDX-License-Identifier: MIT — logical quotas and local cache guardrails. */
#define _POSIX_C_SOURCE 200809L
#include "storage.h"
#include "auth.h"
#include "cloud.h"
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>

static int64_t scalar(const char *sql) {
  sqlite3_stmt *s = NULL;
  int64_t value = -1;
  if (db && sqlite3_prepare_v2(db, sql, -1, &s, NULL) == SQLITE_OK &&
      sqlite3_step(s) == SQLITE_ROW)
    value = sqlite3_column_int64(s, 0);
  sqlite3_finalize(s);
  return value;
}

int ob_storage_configure_cache(void) {
  if (!ob_config.cache_max_bytes) return 0;
  int64_t page_size = scalar("PRAGMA page_size");
  int64_t page_count = scalar("PRAGMA page_count");
  if (page_size <= 0 || page_count < 0) return -1;
  int64_t pages = ob_config.cache_max_bytes / page_size;
  /* Refuse a smaller cap without truncating an existing database. */
  if (pages < 1 || page_count > pages) {
    fputs("Cache limit is smaller than the current SQLite database.\n", stderr);
    return -1;
  }
  char sql[96];
  snprintf(sql, sizeof sql, "PRAGMA max_page_count=%" PRId64, pages);
  return scalar(sql) == pages ? 0 : -1;
}

static int64_t available_bytes(void) {
  const char *path = db ? sqlite3_db_filename(db, "main") : NULL;
  struct statvfs info;
  if (!path || !*path || statvfs(path, &info)) return -1;
  uint64_t unit = info.f_frsize ? info.f_frsize : info.f_bsize;
  if (unit && (uint64_t)info.f_bavail > INT64_MAX / unit) return INT64_MAX;
  return (int64_t)((uint64_t)info.f_bavail * unit);
}

bool ob_storage_cache_write_allowed(void) {
  if (!ob_config.cache_min_free_bytes) return true;
  int64_t available = available_bytes();
  return available >= ob_config.cache_min_free_bytes;
}

int ob_storage_attachment_admission(int64_t bytes) {
  if (!ob_config.attachment_limit_bytes && !ob_config.attachment_limit_files)
    return 1;
  sqlite3_stmt *s = prepare("SELECT count(*),coalesce(sum(size),0) FROM attachments");
  int result = -1;
  if (sqlite3_step(s) == SQLITE_ROW) {
    int64_t files = sqlite3_column_int64(s, 0), used = sqlite3_column_int64(s, 1);
    bool count_ok = !ob_config.attachment_limit_files ||
                    files < ob_config.attachment_limit_files;
    bool size_ok = !ob_config.attachment_limit_bytes ||
                   (used <= ob_config.attachment_limit_bytes &&
                    bytes <= ob_config.attachment_limit_bytes - used);
    result = count_ok && size_ok;
  }
  sqlite3_finalize(s);
  return result;
}

static int64_t file_bytes(const char *suffix) {
  const char *path = db ? sqlite3_db_filename(db, "main") : NULL;
  if (!path || !*path) return -1;
  size_t length = strlen(path) + strlen(suffix) + 1;
  char *name = malloc(length);
  if (!name) return -1;
  snprintf(name, length, "%s%s", path, suffix);
  struct stat st;
  int rc = stat(name, &st), error = errno;
  free(name);
  return rc == 0 ? (int64_t)st.st_size : error == ENOENT && *suffix ? 0 : -1;
}

typedef struct {
  int64_t database, wal, shm, logical, freelist, available;
  bool measured, capacity_ok;
} Cache;

static Cache cache_measure(void) {
  Cache c = {.database = file_bytes(""), .wal = file_bytes("-wal"),
             .shm = file_bytes("-shm"), .available = available_bytes(),
             .logical = -1, .freelist = -1};
  int64_t size = scalar("PRAGMA page_size"), pages = scalar("PRAGMA page_count"),
          free_pages = scalar("PRAGMA freelist_count");
  if (size > 0 && pages >= 0 && pages <= INT64_MAX / size)
    c.logical = pages * size;
  if (size > 0 && free_pages >= 0 && free_pages <= INT64_MAX / size)
    c.freelist = free_pages * size;
  c.measured = c.database >= 0 && c.wal >= 0 && c.shm >= 0 &&
               c.logical >= 0 && c.freelist >= 0 && c.available >= 0;
  c.capacity_ok = !ob_config.cache_min_free_bytes ||
                  c.available >= ob_config.cache_min_free_bytes;
  return c;
}

static void nullable(sqlite3_stmt *s, int index, int64_t value) {
  if (value < 0) sqlite3_bind_null(s, index);
  else sqlite3_bind_int64(s, index, value);
}

Response ob_storage_inventory(Request *r) {
  if (!auth_is_admin(r))
    return error_response(403, "È richiesto il ruolo amministratore.");
  Cache c = cache_measure();
  /* One read statement gives a coherent logical inventory. No parent filter
   * may remove retained files from the installation-wide quota. */
  sqlite3_stmt *s = prepare(
      "WITH inventory AS (SELECT count(*) files,coalesce(sum(a.size),0) bytes,"
      "coalesce(sum(CASE WHEN a.deleted_at IS NULL AND k.id IS NOT NULL AND "
      "k.deleted_at IS NULL AND l.id IS NOT NULL AND l.deleted_at IS NULL AND "
      "b.id IS NOT NULL AND b.deleted_at IS NULL THEN 1 ELSE 0 END),0) active_files,"
      "coalesce(sum(CASE WHEN a.deleted_at IS NULL AND k.id IS NOT NULL AND "
      "k.deleted_at IS NULL AND l.id IS NOT NULL AND l.deleted_at IS NULL AND "
      "b.id IS NOT NULL AND b.deleted_at IS NULL THEN a.size ELSE 0 END),0) active_bytes "
      "FROM attachments a LEFT JOIN cards k ON k.id=a.card_id LEFT JOIN columns l "
      "ON l.id=k.column_id LEFT JOIN boards b ON b.id=l.board_id) "
      "SELECT json_object('storage_mode',?1,'attachments',json_object("
      "'active',json_object('files',active_files,'bytes',active_bytes),"
      "'trashed',json_object('files',files-active_files,'bytes',bytes-active_bytes),"
      "'total',json_object('files',files,'bytes',bytes),"
      "'limits',json_object('files',?2,'bytes',?3),"
      "'remaining',json_object('files',CASE WHEN ?2=0 THEN NULL ELSE max(0,?2-files) END,"
      "'bytes',CASE WHEN ?3=0 THEN NULL ELSE max(0,?3-bytes) END),"
      "'over_limit',json(CASE WHEN (?2>0 AND files>?2) OR (?3>0 AND bytes>?3) "
      "THEN 'true' ELSE 'false' END)),"
      "'cache',json_object('database_bytes',?4,'wal_bytes',?5,'shm_bytes',?6,"
      "'freelist_bytes',?7,'filesystem_available_bytes',?8,"
      "'logical_database_bytes',?9,'minimum_free_bytes',?10,'maximum_database_bytes',?11,"
      "'capacity_ok',json(?12),'measurement_available',json(?13)),"
      "'history',json_object('activity_rows',(SELECT count(*) FROM activity),"
      "'comments_rows',(SELECT count(*) FROM comments),"
      "'review_events_rows',(SELECT count(*) FROM review_events),"
      "'sprint_events_rows',(SELECT count(*) FROM sprint_events),"
      "'intake_events_rows',(SELECT count(*) FROM intake_events),"
      "'idempotency_rows',(SELECT count(*) FROM idempotency),"
      "'idempotency_request_bytes',(SELECT coalesce(sum(length(CAST(request_body AS BLOB))),0) FROM idempotency),"
      "'idempotency_response_bytes',(SELECT coalesce(sum(length(CAST(response_body AS BLOB))),0) FROM idempotency)),"
      "'limitations',json('[\"logical_attachment_payload_only\","
      "\"external_physical_sizes_not_measured\",\"mongodb_orphans_not_measured\"]')) FROM inventory");
  bind_text(s, 1, cloud_enabled() ? "postgresql+mongodb" : "sqlite");
  sqlite3_bind_int64(s, 2, ob_config.attachment_limit_files);
  sqlite3_bind_int64(s, 3, ob_config.attachment_limit_bytes);
  nullable(s, 4, c.database); nullable(s, 5, c.wal); nullable(s, 6, c.shm);
  nullable(s, 7, c.freelist); nullable(s, 8, c.available); nullable(s, 9, c.logical);
  sqlite3_bind_int64(s, 10, ob_config.cache_min_free_bytes);
  sqlite3_bind_int64(s, 11, ob_config.cache_max_bytes);
  bind_text(s, 12, c.capacity_ok ? "true" : "false");
  bind_text(s, 13, c.measured ? "true" : "false");
  Response result = sqlite3_step(s) == SQLITE_ROW
      ? json_response(200, (const char *)sqlite3_column_text(s, 0))
      : error_response(503, "Database temporaneamente non disponibile.");
  sqlite3_finalize(s);
  snprintf(result.headers, sizeof result.headers, "Cache-Control: no-store\r\n");
  return result;
}

size_t ob_storage_metrics_format(char *buffer, size_t capacity) {
  if (!buffer || !capacity) return 0;
  Cache c = cache_measure();
  int used = snprintf(buffer, capacity,
      "# TYPE openboard_cache_measurement_available gauge\nopenboard_cache_measurement_available %d\n"
      "# TYPE openboard_cache_capacity_ok gauge\nopenboard_cache_capacity_ok %d\n"
      "# TYPE openboard_cache_minimum_free_bytes gauge\nopenboard_cache_minimum_free_bytes %" PRId64 "\n"
      "# TYPE openboard_cache_maximum_database_bytes gauge\nopenboard_cache_maximum_database_bytes %" PRId64 "\n"
      "# TYPE openboard_attachment_limit_bytes gauge\nopenboard_attachment_limit_bytes %" PRId64 "\n"
      "# TYPE openboard_attachment_limit_files gauge\nopenboard_attachment_limit_files %" PRId64 "\n",
      c.measured, c.capacity_ok, ob_config.cache_min_free_bytes,
      ob_config.cache_max_bytes, ob_config.attachment_limit_bytes, ob_config.attachment_limit_files);
  if (used < 0 || (size_t)used >= capacity) return 0;
  struct { const char *name; int64_t value; } gauges[] = {
      {"database_bytes", c.database}, {"wal_bytes", c.wal}, {"shm_bytes", c.shm},
      {"logical_database_bytes", c.logical}, {"freelist_bytes", c.freelist},
      {"filesystem_available_bytes", c.available}};
  size_t offset = (size_t)used;
  for (size_t i = 0; i < sizeof gauges / sizeof gauges[0]; i++) {
    if (gauges[i].value < 0) continue; /* Unknown measurements are never zero. */
    used = snprintf(buffer + offset, capacity - offset,
        "# TYPE openboard_cache_%s gauge\nopenboard_cache_%s %" PRId64 "\n",
        gauges[i].name, gauges[i].name, gauges[i].value);
    if (used < 0 || (size_t)used >= capacity - offset) return 0;
    offset += (size_t)used;
  }
  return offset;
}
