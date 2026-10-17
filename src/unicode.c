/* SPDX-License-Identifier: MIT — Unicode search with original-text excerpts. */
#include "unicode.h"
#define UTF8PROC_STATIC
#include "../vendor/utf8proc/utf8proc.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Canonical composition preserves accents; COMPAT, STRIPMARK and IGNORE are
 * deliberately absent. Full case-folding still expands characters such as ß. */
#define SEARCH_OPTIONS (UTF8PROC_STABLE | UTF8PROC_COMPOSE | UTF8PROC_CASEFOLD)
#define DECOMPOSE_OPTIONS (UTF8PROC_STABLE | UTF8PROC_DECOMPOSE)
typedef struct { utf8proc_uint8_t *text; utf8proc_ssize_t length; } Fold;
typedef struct {
  utf8proc_int32_t codepoint;
  size_t source, order, next;
} Origin;

static void fold_free(void *value) {
  Fold *fold = value;
  if (!fold) return;
  utf8proc_free(fold->text);
  free(fold);
}
static void unicode_error(sqlite3_context *context, utf8proc_ssize_t error) {
  if (error == UTF8PROC_ERROR_NOMEM) sqlite3_result_error_nomem(context);
  else if (error == UTF8PROC_ERROR_OVERFLOW) sqlite3_result_error_toobig(context);
  else sqlite3_result_error(context, "Unicode search text is invalid", -1);
}
static bool fold_text(sqlite3_context *context, const unsigned char *text,
                      size_t length, Fold *fold) {
  fold->text = NULL;
  if (length > PTRDIFF_MAX || memchr(text, 0, length)) {
    unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8);
    return false;
  }
  fold->length = utf8proc_map(text, (utf8proc_ssize_t)length, &fold->text, SEARCH_OPTIONS);
  if (fold->length < 0) {
    unicode_error(context, fold->length);
    utf8proc_free(fold->text);
    fold->text = NULL;
    return false;
  }
  return true;
}
static Fold *query_fold(sqlite3_context *context, sqlite3_value *value, bool *owned) {
  Fold *fold = sqlite3_get_auxdata(context, 1);
  *owned = false;
  if (fold) return fold;
  const unsigned char *text = sqlite3_value_text(value);
  if (!text) { sqlite3_result_error_nomem(context); return NULL; }
  fold = calloc(1, sizeof *fold);
  if (!fold) { sqlite3_result_error_nomem(context); return NULL; }
  if (!fold_text(context, text, (size_t)sqlite3_value_bytes(value), fold)) {
    free(fold);
    return NULL;
  }
  *owned = true;
  return fold;
}
static void query_cache(sqlite3_context *context, Fold *fold, bool owned) {
  /* SQLite may destroy new auxdata immediately on allocation failure. Never
   * access fold after this call. A query parameter is constant for a scan. */
  if (owned) sqlite3_set_auxdata(context, 1, fold, fold_free);
}
static void contains_sql(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  if (sqlite3_value_type(argv[0]) == SQLITE_NULL || sqlite3_value_type(argv[1]) == SQLITE_NULL) {
    sqlite3_result_int(context, 0);
    return;
  }
  bool owned;
  Fold *query = query_fold(context, argv[1], &owned), haystack = {0};
  if (!query) return;
  const unsigned char *text = sqlite3_value_text(argv[0]);
  if (!text) sqlite3_result_error_nomem(context);
  else if (fold_text(context, text, (size_t)sqlite3_value_bytes(argv[0]), &haystack)) {
    sqlite3_result_int(context, strstr((const char *)haystack.text, (const char *)query->text) != NULL);
    utf8proc_free(haystack.text);
  }
  query_cache(context, query, owned);
}
static int origin_compare(const void *left, const void *right) {
  const Origin *a = left, *b = right;
  if (a->codepoint != b->codepoint) return a->codepoint < b->codepoint ? -1 : 1;
  return a->order < b->order ? -1 : a->order > b->order;
}
static bool origin_append(Origin **values, size_t *count, size_t *capacity,
                          utf8proc_int32_t cp, size_t source) {
  if (*count == *capacity) {
    size_t next = *capacity ? *capacity * 2 : 32;
    if (next < *capacity || next > SIZE_MAX / sizeof **values) return false;
    Origin *resized = realloc(*values, next * sizeof **values);
    if (!resized) return false;
    *values = resized;
    *capacity = next;
  }
  (*values)[*count] = (Origin){cp, source, *count, 0};
  ++*count;
  return true;
}
static bool origin_take(Origin *values, size_t count, utf8proc_int32_t cp, size_t *source) {
  size_t low = 0, high = count;
  while (low < high) {
    size_t mid = low + (high - low) / 2;
    if (values[mid].codepoint < cp) low = mid + 1; else high = mid;
  }
  if (low == count || values[low].codepoint != cp) return false;
  size_t next = low + values[low].next;
  if (next >= count || values[next].codepoint != cp) return false;
  ++values[low].next;
  *source = values[next].source;
  return true;
}
/* Map one folded/composed code point back to its original cluster. Sorting
 * origins by code point gives stable queues even when canonical ordering moves
 * accents or case-folding expands one source character into several outputs.
 * This also handles very long combining sequences without quadratic rescans. */
static bool cluster_origin(sqlite3_context *context, const unsigned char *text, size_t length,
                            size_t first_source, const Fold *folded, size_t target, size_t *source) {
  Origin *origins = NULL;
  size_t count = 0, capacity = 0, at = 0, original = first_source;
  utf8proc_int32_t decomposed[32];
  while (at < length) {
    utf8proc_int32_t cp;
    utf8proc_ssize_t bytes = utf8proc_iterate(text + at, (utf8proc_ssize_t)(length - at), &cp);
    if (bytes <= 0) goto invalid;
    utf8proc_ssize_t n = utf8proc_decompose_char(cp, decomposed, 32,
                                                DECOMPOSE_OPTIONS | UTF8PROC_CASEFOLD, NULL);
    if (n < 0 || n > 32) goto invalid; /* Unicode canonical/case mappings fit this bound. */
    for (utf8proc_ssize_t i = 0; i < n; ++i)
      if (!origin_append(&origins, &count, &capacity, decomposed[i], original)) goto nomem;
    at += (size_t)bytes;
    ++original;
  }
  qsort(origins, count, sizeof *origins, origin_compare);
  at = 0;
  while (at < (size_t)folded->length) {
    utf8proc_int32_t cp;
    utf8proc_ssize_t bytes = utf8proc_iterate(folded->text + at, folded->length - (utf8proc_ssize_t)at, &cp);
    if (bytes <= 0) goto invalid;
    utf8proc_ssize_t n = utf8proc_decompose_char(cp, decomposed, 32, DECOMPOSE_OPTIONS, NULL);
    if (n < 0 || n > 32) goto invalid;
    size_t earliest = SIZE_MAX;
    for (utf8proc_ssize_t i = 0; i < n; ++i) {
      size_t point_source;
      if (!origin_take(origins, count, decomposed[i], &point_source)) goto invalid;
      if (point_source < earliest) earliest = point_source;
    }
    if (target < at + (size_t)bytes) {
      if (earliest == SIZE_MAX) goto invalid;
      *source = earliest;
      free(origins);
      return true;
    }
    at += (size_t)bytes;
  }
invalid:
  free(origins);
  unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8);
  return false;
nomem:
  free(origins);
  sqlite3_result_error_nomem(context);
  return false;
}
static bool map_cluster(sqlite3_context *context, const unsigned char *text, size_t length,
                         size_t first_source, const Fold *whole, size_t *folded_at,
                         size_t target, size_t *source, bool *found) {
  bool ascii = true;
  for (size_t i = 0; i < length; ++i) if (text[i] >= 0x80) { ascii = false; break; }
  if (ascii) {
    if (target < *folded_at + length) {
      *source = first_source + target - *folded_at;
      *found = true;
    }
    *folded_at += length;
    return true;
  }
  Fold folded = {0};
  if (!fold_text(context, text, length, &folded)) return false;
  if (*folded_at > (size_t)whole->length || (size_t)folded.length > (size_t)whole->length - *folded_at ||
      memcmp(whole->text + *folded_at, folded.text, (size_t)folded.length)) {
    utf8proc_free(folded.text);
    unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8);
    return false;
  }
  bool ok = true;
  if (target < *folded_at + (size_t)folded.length) {
    ok = cluster_origin(context, text, length, first_source, &folded, target - *folded_at, source);
    *found = ok;
  }
  *folded_at += (size_t)folded.length;
  utf8proc_free(folded.text);
  return ok;
}
static bool original_position(sqlite3_context *context, const unsigned char *text, size_t length,
                               const Fold *folded, size_t target, size_t *source) {
  size_t at = 0, original = 0, cluster_at = 0, cluster_source = 0, folded_at = 0;
  utf8proc_int32_t previous = -1, state = 0;
  bool found = false;
  while (at < length) {
    utf8proc_int32_t cp;
    utf8proc_ssize_t bytes = utf8proc_iterate(text + at, (utf8proc_ssize_t)(length - at), &cp);
    if (bytes <= 0) { unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8); return false; }
    if (previous >= 0 && utf8proc_grapheme_break_stateful(previous, cp, &state)) {
      if (!map_cluster(context, text + cluster_at, at - cluster_at, cluster_source,
                       folded, &folded_at, target, source, &found)) return false;
      if (found) return true;
      cluster_at = at;
      cluster_source = original;
    }
    previous = cp;
    at += (size_t)bytes;
    ++original;
  }
  if (!map_cluster(context, text + cluster_at, length - cluster_at, cluster_source,
                   folded, &folded_at, target, source, &found)) return false;
  if (!found) { unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8); return false; }
  return true;
}
static void snippet_sql(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  if (sqlite3_value_type(argv[0]) == SQLITE_NULL || sqlite3_value_type(argv[1]) == SQLITE_NULL) {
    sqlite3_result_text(context, "", 0, SQLITE_STATIC);
    return;
  }
  bool owned;
  Fold *query = query_fold(context, argv[1], &owned), haystack = {0};
  if (!query) return;
  const unsigned char *text = sqlite3_value_text(argv[0]);
  if (!text) { sqlite3_result_error_nomem(context); query_cache(context, query, owned); return; }
  size_t length = (size_t)sqlite3_value_bytes(argv[0]);
  if (!fold_text(context, text, length, &haystack)) { query_cache(context, query, owned); return; }
  const char *match = strstr((const char *)haystack.text, (const char *)query->text);
  size_t original = 0;
  if (match && query->length && !original_position(context, text, length, &haystack,
                                                   (size_t)(match - (const char *)haystack.text), &original)) {
    utf8proc_free(haystack.text);
    query_cache(context, query, owned);
    return;
  }
  utf8proc_free(haystack.text);
  /* Forty original code points of context leave room for a 200-character
   * query. Never use folded offsets to slice or return the stored text. */
  size_t start_character = original > 40 ? original - 40 : 0, at = 0, character = 0, start = 0;
  while (at < length && character < start_character + 240) {
    if (character == start_character) start = at;
    utf8proc_int32_t cp;
    utf8proc_ssize_t bytes = utf8proc_iterate(text + at, (utf8proc_ssize_t)(length - at), &cp);
    if (bytes <= 0) { unicode_error(context, UTF8PROC_ERROR_INVALIDUTF8); query_cache(context, query, owned); return; }
    at += (size_t)bytes;
    ++character;
  }
  sqlite3_result_text(context, (const char *)text + start, (int)(at - start), SQLITE_TRANSIENT);
  query_cache(context, query, owned);
}
int ob_unicode_register(sqlite3 *connection) {
  const int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  int rc = sqlite3_create_function_v2(connection, "ob_unicode_contains", 2, flags, NULL,
                                      contains_sql, NULL, NULL, NULL);
  if (rc != SQLITE_OK) return rc;
  return sqlite3_create_function_v2(connection, "ob_unicode_snippet", 2, flags, NULL,
                                    snippet_sql, NULL, NULL, NULL);
}
