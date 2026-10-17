/* SPDX-License-Identifier: MIT */
#ifndef OPENBOARD_UNICODE_H
#define OPENBOARD_UNICODE_H
#include <sqlite3.h>
/* Register stateless deterministic Unicode search functions on every worker.
 * Contains uses full Unicode case-folding and canonical NFC equivalence;
 * snippets retain original UTF-8 and count original Unicode code points. */
int ob_unicode_register(sqlite3 *connection);
#endif
