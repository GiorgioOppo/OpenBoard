/* SPDX-License-Identifier: MIT — bounded dependency metadata for a board view. */
#include "timeline.h"
#include "auth.h"
#include <string.h>

Response ob_board_timeline(Request *r, int64_t board_id) {
  char archive[8];
  int present = ob_query(r, "include_archived", archive, sizeof archive);
  if (present < 0 || (present && strcmp(archive, "0") && strcmp(archive, "1")))
    return error_response(400, "Filtro archivio non valido.");
  bool archived = present && !strcmp(archive, "1");
  if (!auth_board_allowed(r, board_id, false))
    return error_response(404, "Bacheca non trovata.");
  /* One SQLite statement applies current ACL and live ancestry before ordering
   * and LIMIT. No endpoints from another board or a deleted ancestor escape.
   * Board version is metadata, not a version of all card/dependency edits. */
  sqlite3_stmt *s = prepare(
      "WITH visible_board AS(SELECT id,version FROM boards WHERE id=?1 AND "
      "deleted_at IS NULL AND (?2 OR archived=0) AND ob_allowed(id)),"
      "live AS(SELECT k.id FROM cards k JOIN columns c ON c.id=k.column_id "
      "JOIN visible_board b ON b.id=c.board_id WHERE k.deleted_at IS NULL "
      "AND c.deleted_at IS NULL AND (?2 OR k.archived=0)),"
      "page AS(SELECT d.card_id,d.required_card_id FROM card_dependencies d "
      "JOIN live k ON k.id=d.card_id JOIN live p ON p.id=d.required_card_id "
      "ORDER BY d.card_id,d.required_card_id LIMIT 2001) "
      "SELECT json_object('board_id',b.id,'version',b.version,'limit',2000,"
      "'truncated',json(CASE WHEN (SELECT count(*) FROM page)>2000 THEN 'true' ELSE 'false' END),"
      "'dependencies',json((SELECT json_group_array(json_object('card_id',card_id,"
      "'required_card_id',required_card_id)) FROM(SELECT * FROM page LIMIT 2000)))) "
      "FROM visible_board b");
  sqlite3_bind_int64(s, 1, board_id);
  sqlite3_bind_int(s, 2, archived);
  int step = sqlite3_step(s);
  Response result = step == SQLITE_ROW ? json_response(200, (const char *)sqlite3_column_text(s, 0))
      : error_response(step == SQLITE_DONE ? 404 : 503,
                       step == SQLITE_DONE ? "Bacheca non trovata." : "Database temporaneamente non disponibile.");
  sqlite3_finalize(s);
  return result;
}
