/* SPDX-License-Identifier: MIT — actual production JSON/UTF-8 validators. */
#include "../src/server.c"
#include <assert.h>

#define FUZZ_LIMIT 65536

static void close_database(void) {
  if (db) { sqlite3_close(db); db = NULL; }
  sqlite3_shutdown();
}
int LLVMFuzzerInitialize(int *argc, char ***argv) {
  (void)argc; (void)argv;
  if (sqlite3_open(":memory:", &db) != SQLITE_OK) abort();
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH, FUZZ_LIMIT * 4);
  atexit(close_database);
  return 0;
}
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size > FUZZ_LIMIT) return 0;
  char *text = malloc(size + 1);
  if (!text) abort();
  memcpy(text, data, size); text[size] = 0;
  (void)valid_utf8(text, size);
  (void)parse_id(text);
  (void)valid_date(text);
  if (!memchr(text, 0, size) && valid_object(text)) {
    const char *keys[] = {"title", "description", "key"};
    size_t limits[] = {300, 10000, 40};
    for (size_t i = 0; i < 3; i++) {
      char *value = NULL;
      int result = json_string(text, keys[i], &value, limits[i]);
      assert(result >= -1 && result <= 1);
      if (result == 1) {
        assert(value && strlen(value) <= limits[i] * 4);
        assert(valid_utf8(value, strlen(value)));
      }
      ob_free(value);
    }
    int64_t value = 0;
    int result = json_integer(text, "minutes", &value, 0, 100000, false);
    assert(result >= -1 && result <= 1);
    if (result == 1) assert(value >= 0 && value <= 100000);
    result = json_integer(text, "completed", &value, 0, 1, true);
    assert(result >= -1 && result <= 1);
    if (result == 1) assert(value == 0 || value == 1);
    char *array = NULL;
    result = json_checklist(text, &array);
    assert(result >= -1 && result <= 1);
    ob_free(array); array = NULL;
    result = json_assignee_ids(text, "assignee_ids", &array);
    assert(result >= -1 && result <= 1);
    ob_free(array); array = NULL;
    result = json_object_field(text, "custom_values", &array);
    assert(result >= -1 && result <= 1);
    if (result == 1) assert(array && valid_object(array));
    ob_free(array);
  }
  free(text);
  return 0;
}
