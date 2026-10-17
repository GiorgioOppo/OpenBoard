/* Exercise public telemetry APIs with concurrent writers and exporters. */
#define _POSIX_C_SOURCE 200809L
#include "../../src/telemetry.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *const limits[] = {
    "0.001", "0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5",
    "1", "2.5", "5", "10", "+Inf"};
static const char *const operations[] = {"mutex_wait", "postgres_lock", "hydrate", "publish"};
static long double metric(const char *body, const char *name) {
  size_t size = strlen(name);
  const char *line = body;
  while (*line) {
    if (!strncmp(line, name, size) && line[size] == ' ')
      return strtold(line + size + 1, NULL);
    line = strchr(line, '\n');
    if (!line) break;
    line++;
  }
  fprintf(stderr, "Missing fixed metric: %s\n", name);
  abort();
}
static void coherent(const char *body, bool all_one_ms) {
  char name[256];
  long double count = metric(body, "openboard_http_request_duration_seconds_count");
  long double statuses = 0;
  for (int i = 2; i <= 5; i++) {
    snprintf(name, sizeof name, "openboard_http_responses_total{class=\"%dxx\"}", i);
    statuses += metric(body, name);
  }
  assert(count == statuses);
  assert(metric(body, "openboard_http_rate_limited_total") <=
         metric(body, "openboard_http_responses_total{class=\"4xx\"}"));
  long double previous = 0;
  for (size_t i = 0; i < sizeof limits / sizeof limits[0]; i++) {
    snprintf(name, sizeof name, "openboard_http_request_duration_seconds_bucket{le=\"%s\"}", limits[i]);
    long double current = metric(body, name);
    assert(current >= previous && current <= count);
    previous = current;
  }
  assert(previous == count);
  if (all_one_ms)
    assert(fabsl(metric(body, "openboard_http_request_duration_seconds_sum") - count / 1000) < 0.000000001L);
  for (size_t op = 0; op < sizeof operations / sizeof operations[0]; op++) {
    snprintf(name, sizeof name, "openboard_storage_operation_duration_seconds_count{operation=\"%s\"}", operations[op]);
    count = metric(body, name);
    snprintf(name, sizeof name, "openboard_storage_operation_errors_total{operation=\"%s\"}", operations[op]);
    long double errors = metric(body, name);
    assert(errors <= count);
    previous = 0;
    for (size_t i = 0; i < sizeof limits / sizeof limits[0]; i++) {
      snprintf(name, sizeof name, "openboard_storage_operation_duration_seconds_bucket{operation=\"%s\",le=\"%s\"}", operations[op], limits[i]);
      long double current = metric(body, name);
      assert(current >= previous && current <= count);
      previous = current;
    }
    assert(previous == count);
    if (all_one_ms) {
      snprintf(name, sizeof name, "openboard_storage_operation_duration_seconds_sum{operation=\"%s\"}", operations[op]);
      assert(fabsl(metric(body, name) - count / 1000) < 0.000000001L);
      if (op == OB_TELEMETRY_PUBLISH)
        assert(metric(body, "openboard_storage_rows_published_total") == 3 * (count - errors));
    }
  }
}
static void boundaries(void) {
  char body[OB_TELEMETRY_BUFFER_SIZE];
  ob_telemetry_http_record(200, 0);
  ob_telemetry_http_record(302, 1000000);
  ob_telemetry_http_record(400, 1000001);
  ob_telemetry_http_record(429, 10000000000ULL);
  ob_telemetry_http_record(503, 10000000001ULL);
  ob_telemetry_http_record(199, 1000);
  ob_telemetry_http_record(600, 1000);
  ob_telemetry_storage_record(OB_TELEMETRY_PUBLISH, 2000000, false, 999);
  ob_telemetry_storage_record(OB_TELEMETRY_PUBLISH, 3000000, true, 7);
  ob_telemetry_storage_record((ObTelemetryStorageOperation)-1, 1000, true, 999);
  ob_telemetry_storage_record(OB_TELEMETRY_STORAGE_OPERATIONS, 1000, true, 999);
  size_t length = ob_telemetry_format(body, sizeof body);
  assert(length == strlen(body) && length > 0);
  coherent(body, false);
  assert(metric(body, "openboard_http_request_duration_seconds_count") == 5);
  assert(metric(body, "openboard_http_request_duration_seconds_bucket{le=\"0.001\"}") == 2);
  assert(metric(body, "openboard_http_request_duration_seconds_bucket{le=\"10\"}") == 4);
  assert(fabsl(metric(body, "openboard_http_request_duration_seconds_sum") - 20.002000002L) < 0.000000001L);
  assert(metric(body, "openboard_storage_rows_published_total") == 7);
  assert(metric(body, "openboard_storage_operation_errors_total{operation=\"publish\"}") == 1);
  char small[8] = "private";
  assert(ob_telemetry_format(small, sizeof small) == 0 && !small[0]);
  assert(ob_telemetry_format(NULL, 100) == 0);
  assert(ob_telemetry_format(small, 0) == 0);
  assert(ob_telemetry_elapsed_ns(0) == 0);
  assert(ob_telemetry_elapsed_ns(UINT64_MAX) == 0);
  uint64_t start = ob_telemetry_now_ns();
  assert(start > 0 && ob_telemetry_now_ns() >= start);
  puts("histogram boundaries, invalid inputs and bounded output OK");
}
#define WRITERS 8
#define ITERATIONS 4000
static atomic_bool start;
static atomic_int pending;
static void *writer(void *unused) {
  (void)unused;
  while (!atomic_load(&start)) sched_yield();
  for (int i = 0; i < ITERATIONS; i++) {
    ob_telemetry_http_record(i % 2 ? 429 : 200, 1000000);
    bool success = i % 5 != 0;
    ob_telemetry_storage_record((ObTelemetryStorageOperation)(i % OB_TELEMETRY_STORAGE_OPERATIONS),
                                1000000, success, success ? 3 : 999);
  }
  atomic_fetch_sub(&pending, 1);
  return NULL;
}
static void concurrent(void) {
  pthread_t threads[WRITERS];
  atomic_store(&pending, WRITERS);
  for (int i = 0; i < WRITERS; i++) assert(!pthread_create(&threads[i], NULL, writer, NULL));
  atomic_store(&start, true);
  int exports = 0;
  char body[OB_TELEMETRY_BUFFER_SIZE];
  do {
    assert(ob_telemetry_format(body, sizeof body));
    coherent(body, true);
    exports++;
  } while (atomic_load(&pending) || exports < 100);
  for (int i = 0; i < WRITERS; i++) assert(!pthread_join(threads[i], NULL));
  assert(ob_telemetry_format(body, sizeof body));
  coherent(body, true);
  assert(metric(body, "openboard_http_request_duration_seconds_count") == WRITERS * ITERATIONS);
  printf("concurrent writers and %d coherent exports OK\n", exports);
}
int main(int argc, char **argv) {
  assert(argc == 2);
  if (!strcmp(argv[1], "boundaries")) boundaries();
  else if (!strcmp(argv[1], "concurrent")) concurrent();
  else assert(false);
  return 0;
}
