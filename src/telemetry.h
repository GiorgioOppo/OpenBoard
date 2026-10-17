/* Fixed-cardinality, process-local operational telemetry. SPDX-License-Identifier: MIT */
#ifndef OPENBOARD_TELEMETRY_H
#define OPENBOARD_TELEMETRY_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define OB_TELEMETRY_BUFFER_SIZE 16384

typedef enum {
  OB_TELEMETRY_STORE_MUTEX,
  OB_TELEMETRY_POSTGRES_LOCK,
  OB_TELEMETRY_HYDRATE,
  OB_TELEMETRY_PUBLISH,
  OB_TELEMETRY_STORAGE_OPERATIONS
} ObTelemetryStorageOperation;

/* Monotonic nanoseconds; zero means the clock could not be read. */
uint64_t ob_telemetry_now_ns(void);
uint64_t ob_telemetry_elapsed_ns(uint64_t start);
/* Record one completed worker response. Status classes and duration update atomically.
 * Accept-queue overload rejections retain their separate legacy counter.
 * Final HTTP responses outside 200..599 are not recorded. */
void ob_telemetry_http_record(int status, uint64_t duration_ns);
/* rows_published counts SQL application rows inserted/replaced in a confirmed
 * publication commit, including table-level fallbacks. Failed attempts add no
 * rows; delete-only publications can confirm zero inserted rows. */
void ob_telemetry_storage_record(ObTelemetryStorageOperation operation,
                                 uint64_t duration_ns, bool success,
                                 uint64_t rows_published);
/* Copy one coherent snapshot, then format without holding its mutex. Returns
 * bytes written, or zero on invalid/insufficient space; no truncated exposition
 * is returned. Output contains only fixed metric names and fixed label values. */
size_t ob_telemetry_format(char *buffer, size_t capacity);
#endif
