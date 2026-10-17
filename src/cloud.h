/* PostgreSQL/MongoDB authoritative storage with a reconstructible SQLite cache.
 * SPDX-License-Identifier: MIT */
#ifndef OPENBOARD_CLOUD_H
#define OPENBOARD_CLOUD_H
#include <sqlite3.h>
#include <stdbool.h>

bool cloud_enabled(void);
int cloud_bootstrap(sqlite3 *cache);
/* Each request must use the same SQLite connection for begin/finish/abort.
 * Committed row changes are published incrementally; initial bootstrap and
 * stale-cache recovery retain full-snapshot semantics. Operational telemetry
 * records fixed operation labels and confirmed SQL row publications only. */
int cloud_request_begin(sqlite3 *cache);
int cloud_request_finish(sqlite3 *cache, bool changed);
/* BSON supports bounded nesting and no NUL byte in document field names. */
int cloud_validate_json(sqlite3 *cache, const char *json);
void cloud_request_abort(sqlite3 *cache);
int cloud_ready(void);
void cloud_shutdown(void);
#endif
