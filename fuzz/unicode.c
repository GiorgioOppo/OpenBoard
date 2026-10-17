/* SPDX-License-Identifier: MIT — fuzz full Unicode search and excerpt origins. */
#include "../src/openboard.h"
#include "../src/unicode.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static sqlite3 *connection;
static sqlite3_stmt *statement;
static void close_database(void) {
  sqlite3_finalize(statement);
  sqlite3_close(connection);
  sqlite3_shutdown();
}
int LLVMFuzzerInitialize(int *argc, char ***argv) {
  (void)argc; (void)argv;
  assert(sqlite3_open(":memory:", &connection) == SQLITE_OK);
  assert(ob_unicode_register(connection) == SQLITE_OK);
  assert(sqlite3_prepare_v2(connection,
      "SELECT ob_unicode_contains(?1,?2),ob_unicode_snippet(?1,?2),ob_unicode_contains(?1,?1)",
      -1, &statement, NULL) == SQLITE_OK);
  atexit(close_database);
  return 0;
}
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size > 65536) return 0;
  const uint8_t *separator = memchr(data, 0, size);
  size_t left = separator ? (size_t)(separator - data) : size;
  const uint8_t *query = separator ? separator + 1 : data;
  size_t right = separator ? size - left - 1 : size;
  char *text = malloc(left + 1);
  assert(text);
  memcpy(text, data, left); text[left] = 0;
  int valid = valid_utf8(text, left) && valid_utf8((const char *)query, right) && !memchr(query, 0, right);
  assert(sqlite3_bind_text(statement, 1, text, (int)left, SQLITE_TRANSIENT) == SQLITE_OK);
  assert(sqlite3_bind_text(statement, 2, (const char *)query, (int)right, SQLITE_TRANSIENT) == SQLITE_OK);
  int result = sqlite3_step(statement);
  if (valid) {
    assert(result == SQLITE_ROW);
    assert(sqlite3_column_int(statement, 2) == 1);
    const char *excerpt = (const char *)sqlite3_column_text(statement, 1);
    int length = sqlite3_column_bytes(statement, 1);
    assert(excerpt && length >= 0 && length <= 960);
    assert(valid_utf8(excerpt, (size_t)length));
    assert(strstr(text, excerpt));
    size_t characters = 0;
    for (int i = 0; i < length; i++) if (((unsigned char)excerpt[i] & 0xc0) != 0x80) characters++;
    assert(characters <= 240);
  } else assert(result == SQLITE_ERROR);
  sqlite3_reset(statement);
  assert(sqlite3_clear_bindings(statement) == SQLITE_OK);
  free(text);
  return 0;
}
