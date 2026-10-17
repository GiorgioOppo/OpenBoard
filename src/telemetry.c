/* SPDX-License-Identifier: MIT — coherent, bounded telemetry without user data. */
#define _POSIX_C_SOURCE 200809L
#include "telemetry.h"
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* Finite bounds in nanoseconds, plus the implicit +Inf bucket. */
static const uint64_t bounds_ns[] = {
    1000000, 5000000, 10000000, 25000000, 50000000, 100000000,
    250000000, 500000000, 1000000000, 2500000000ULL, 5000000000ULL,
    10000000000ULL};
static const char *const bounds_text[] = {
    "0.001", "0.005", "0.01", "0.025", "0.05", "0.1", "0.25",
    "0.5", "1", "2.5", "5", "10"};
#define BUCKETS (sizeof bounds_ns / sizeof bounds_ns[0])

typedef struct {
  uint64_t buckets[BUCKETS + 1], count, errors;
  long double duration_ns;
} Histogram;
typedef struct {
  Histogram http;
  uint64_t statuses[4], rate_limited, rows_published;
  Histogram storage[OB_TELEMETRY_STORAGE_OPERATIONS];
} Telemetry;
static Telemetry telemetry;
static pthread_mutex_t telemetry_mutex = PTHREAD_MUTEX_INITIALIZER;

uint64_t ob_telemetry_now_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value))
    return 0;
  return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}
uint64_t ob_telemetry_elapsed_ns(uint64_t start) {
  uint64_t end = ob_telemetry_now_ns();
  return start && end >= start ? end - start : 0;
}
static void observe(Histogram *histogram, uint64_t duration_ns) {
  histogram->count++;
  histogram->duration_ns += (long double)duration_ns;
  for (size_t i = 0; i < BUCKETS; i++)
    if (duration_ns <= bounds_ns[i])
      histogram->buckets[i]++;
  histogram->buckets[BUCKETS]++;
}
void ob_telemetry_http_record(int status, uint64_t duration_ns) {
  if (status < 200 || status >= 600)
    return;
  pthread_mutex_lock(&telemetry_mutex);
  observe(&telemetry.http, duration_ns);
  telemetry.statuses[status / 100 - 2]++;
  if (status == 429)
    telemetry.rate_limited++;
  pthread_mutex_unlock(&telemetry_mutex);
}
void ob_telemetry_storage_record(ObTelemetryStorageOperation operation,
                                 uint64_t duration_ns, bool success,
                                 uint64_t rows_published) {
  if ((unsigned)operation >= OB_TELEMETRY_STORAGE_OPERATIONS)
    return;
  pthread_mutex_lock(&telemetry_mutex);
  observe(&telemetry.storage[operation], duration_ns);
  if (!success)
    telemetry.storage[operation].errors++;
  if (operation == OB_TELEMETRY_PUBLISH && success)
    telemetry.rows_published += rows_published;
  pthread_mutex_unlock(&telemetry_mutex);
}

typedef struct {
  char *data;
  size_t capacity, length;
  bool failed;
} Output;
static void append(Output *output, const char *format, ...) {
  if (output->failed)
    return;
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(output->data + output->length,
                         output->capacity - output->length, format, arguments);
  va_end(arguments);
  if (length < 0 || (size_t)length >= output->capacity - output->length)
    output->failed = true;
  else
    output->length += (size_t)length;
}
size_t ob_telemetry_format(char *buffer, size_t capacity) {
  if (!buffer || !capacity)
    return 0;
  Telemetry snapshot;
  pthread_mutex_lock(&telemetry_mutex);
  snapshot = telemetry;
  pthread_mutex_unlock(&telemetry_mutex);
  Output output = {.data = buffer, .capacity = capacity};
  append(&output, "# HELP openboard_http_request_duration_seconds Worker response duration including parsing and transmission, excluding accept-queue wait and queue-full rejections.\n"
                  "# TYPE openboard_http_request_duration_seconds histogram\n");
  for (size_t i = 0; i <= BUCKETS; i++)
    append(&output, "openboard_http_request_duration_seconds_bucket{le=\"%s\"} %llu\n",
           i == BUCKETS ? "+Inf" : bounds_text[i],
           (unsigned long long)snapshot.http.buckets[i]);
  append(&output, "openboard_http_request_duration_seconds_sum %.9Lf\n"
                  "openboard_http_request_duration_seconds_count %llu\n"
                  "# TYPE openboard_http_responses_total counter\n",
         snapshot.http.duration_ns / 1000000000.0L,
         (unsigned long long)snapshot.http.count);
  static const char *const classes[] = {"2xx", "3xx", "4xx", "5xx"};
  for (size_t i = 0; i < sizeof classes / sizeof classes[0]; i++)
    append(&output, "openboard_http_responses_total{class=\"%s\"} %llu\n",
           classes[i], (unsigned long long)snapshot.statuses[i]);
  append(&output, "# TYPE openboard_http_rate_limited_total counter\n"
                  "openboard_http_rate_limited_total %llu\n"
                  "# HELP openboard_storage_operation_duration_seconds Local adapter operation duration, including unsuccessful attempts.\n"
                  "# TYPE openboard_storage_operation_duration_seconds histogram\n",
         (unsigned long long)snapshot.rate_limited);
  static const char *const operations[] = {
      "mutex_wait", "postgres_lock", "hydrate", "publish"};
  for (size_t operation = 0; operation < OB_TELEMETRY_STORAGE_OPERATIONS; operation++) {
    const Histogram *histogram = &snapshot.storage[operation];
    for (size_t i = 0; i <= BUCKETS; i++)
      append(&output, "openboard_storage_operation_duration_seconds_bucket{operation=\"%s\",le=\"%s\"} %llu\n",
             operations[operation], i == BUCKETS ? "+Inf" : bounds_text[i],
             (unsigned long long)histogram->buckets[i]);
    append(&output, "openboard_storage_operation_duration_seconds_sum{operation=\"%s\"} %.9Lf\n"
                    "openboard_storage_operation_duration_seconds_count{operation=\"%s\"} %llu\n",
           operations[operation], histogram->duration_ns / 1000000000.0L,
           operations[operation], (unsigned long long)histogram->count);
  }
  append(&output, "# TYPE openboard_storage_operation_errors_total counter\n");
  for (size_t operation = 0; operation < OB_TELEMETRY_STORAGE_OPERATIONS; operation++)
    append(&output, "openboard_storage_operation_errors_total{operation=\"%s\"} %llu\n",
           operations[operation], (unsigned long long)snapshot.storage[operation].errors);
  append(&output, "# HELP openboard_storage_rows_published_total Application rows inserted or replaced in confirmed SQL publication commits, including table fallbacks.\n"
                  "# TYPE openboard_storage_rows_published_total counter\n"
                  "openboard_storage_rows_published_total %llu\n",
         (unsigned long long)snapshot.rows_published);
  if (output.failed) {
    buffer[0] = 0;
    return 0;
  }
  return output.length;
}
