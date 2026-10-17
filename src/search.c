/* SPDX-License-Identifier: MIT — ACL-filtered collaborative content search. */
#include "search.h"
#include <ctype.h>
#include <stdio.h>
#include <string.h>

static bool positive(const char *value, int64_t *out) {
  if (!value || !*value) return false;
  for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return false;
  *out = parse_id(value);
  return *out > 0;
}

Response ob_content_search(Request *r) {
  char term[801], kind[24] = "all", text[80], archived[8];
  if (ob_query(r, "q", term, sizeof term) != 1 || !valid_utf8(term, strlen(term)))
    return error_response(400, "Specifica un testo di ricerca valido (max 200 caratteri).");
  size_t count = 0;
  bool nonblank = false;
  for (const unsigned char *p = (const unsigned char *)term; *p; p++) {
    if ((*p & 0xc0) != 0x80) count++;
    if (!isspace(*p)) nonblank = true;
  }
  if (!nonblank || count > 200)
    return error_response(400, "Specifica un testo di ricerca valido (max 200 caratteri).");
  int has_kind = ob_query(r, "kind", text, sizeof text);
  if (has_kind < 0 || (has_kind && strcmp(text, "all") && strcmp(text, "card") &&
      strcmp(text, "comment") && strcmp(text, "request") &&
      strcmp(text, "request_note") && strcmp(text, "form")))
    return error_response(400, "Tipo di contenuto da cercare non valido.");
  if (has_kind) memcpy(kind, text, strlen(text) + 1); /* Validated vocabulary. */
  int64_t limit = 30, before = 0;
  int has_limit = ob_query(r, "limit", text, sizeof text);
  if (has_limit < 0 || (has_limit && (!positive(text, &limit) || limit > 200)))
    return error_response(400, "Paginazione non valida: limit 1–200 e before positivo.");
  int rank = -1, has_cursor = ob_query(r, "cursor", text, sizeof text);
  if (has_cursor) {
    if (has_cursor < 0 || strlen(text) < 3 || text[0] < '0' || text[0] > '4' ||
        text[1] != ':' || !positive(text + 2, &before))
      return error_response(400, "Cursore di ricerca non valido.");
    rank = text[0] - '0';
  }
  bool include_archived = false;
  int has_archived = ob_query(r, "include_archived", archived, sizeof archived);
  if (has_archived < 0 || (has_archived && strcmp(archived, "0") && strcmp(archived, "1")))
    return error_response(400, "Filtro archivio non valido.");
  if (has_archived) include_archived = !strcmp(archived, "1");
  /* Rank and immutable IDs define the cursor; timestamps and result offsets
   * never affect the next page. Every source applies live ancestry and ACLs
   * before UNION/LIMIT. The legacy /api/search contract remains unchanged. */
  sqlite3_stmt *s = prepare(
      "WITH live_cards AS(SELECT k.*,b.id board_id,b.name board_name,c.title column_title "
      "FROM cards k JOIN columns c ON c.id=k.column_id JOIN boards b ON b.id=c.board_id "
      "WHERE k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL "
      "AND (?7 OR(k.archived=0 AND b.archived=0)) AND ob_allowed(b.id)),"
      "live_requests AS(SELECT q.*,b.name board_name,f.name form_name FROM intake_requests q "
      "JOIN intake_forms f ON f.id=q.form_id AND f.board_id=q.board_id JOIN boards b ON b.id=q.board_id "
      "WHERE ?8 AND q.deleted_at IS NULL AND f.deleted_at IS NULL AND b.deleted_at IS NULL "
      "AND (?7 OR b.archived=0) AND ob_allowed(b.id)),"
      "hits AS(SELECT 0 rank,k.id,'card' kind,k.board_id,k.board_name,k.title,k.id card_id,"
      "NULL request_id,NULL form_id,k.column_title context,"
      "ob_unicode_snippet(k.description,?1) snippet "
      "FROM live_cards k WHERE ob_unicode_contains(k.title,?1) OR "
      "ob_unicode_contains(k.description,?1) OR ob_unicode_contains(k.assignee,?1) "
      "UNION ALL SELECT 1,m.id,'comment',k.board_id,k.board_name,k.title,k.id,NULL,NULL,k.column_title,"
      "ob_unicode_snippet(m.body,?1) "
      "FROM comments m JOIN live_cards k ON k.id=m.card_id WHERE ob_unicode_contains(m.body,?1) "
      "UNION ALL SELECT 2,q.id,'request',q.board_id,q.board_name,q.title,NULL,q.id,q.form_id,q.form_name,"
      "coalesce((SELECT ob_unicode_snippet(CASE WHEN a.type IN('true','false') THEN a.type ELSE CAST(a.value AS TEXT) END,?1) "
      "FROM json_tree(q.answers) a WHERE a.type NOT IN('object','array','null') AND "
      "ob_unicode_contains(CASE WHEN a.type IN('true','false') THEN a.type ELSE CAST(a.value AS TEXT) END,?1) LIMIT 1),'') "
      "FROM live_requests q WHERE ob_unicode_contains(q.title,?1) OR EXISTS(SELECT 1 "
      "FROM json_tree(q.answers) a WHERE a.type NOT IN('object','array','null') AND "
      "ob_unicode_contains(CASE WHEN a.type IN('true','false') THEN a.type ELSE CAST(a.value AS TEXT) END,?1)) "
      "UNION ALL SELECT 3,n.id,'request_note',q.board_id,q.board_name,q.title,NULL,q.id,q.form_id,q.form_name,"
      "ob_unicode_snippet(n.body,?1) FROM intake_notes n "
      "JOIN live_requests q ON q.id=n.request_id WHERE ob_unicode_contains(n.body,?1) "
      "UNION ALL SELECT 4,f.id,'form',b.id,b.name,f.name,NULL,NULL,f.id,'',"
      "ob_unicode_snippet(f.description,?1) "
      "FROM intake_forms f JOIN boards b ON b.id=f.board_id WHERE ?8 AND f.deleted_at IS NULL "
      "AND b.deleted_at IS NULL AND (?7 OR b.archived=0) AND ob_allowed(b.id) AND "
      "(ob_unicode_contains(f.name,?1) OR ob_unicode_contains(f.description,?1))),"
      "page AS(SELECT * FROM hits WHERE (?2='all' OR kind=?2) AND "
      "(?3<0 OR rank>?3 OR(rank=?3 AND id<?4)) ORDER BY rank,id DESC LIMIT ?5+1) "
      "SELECT json_object('items',json((SELECT json_group_array(json(item)) FROM(SELECT "
      "json_object('kind',kind,'id',id,'key',rank||':'||id,'board_id',board_id,'board_name',board_name,"
      "'title',title,'snippet',snippet,'context',context,'card_id',card_id,'request_id',request_id,'form_id',form_id) item "
      "FROM page ORDER BY rank,id DESC LIMIT ?5))),'next_cursor',CASE WHEN(SELECT count(*) FROM page)>?5 "
      "THEN(SELECT rank||':'||id FROM page ORDER BY rank,id DESC LIMIT 1 OFFSET ?6) ELSE NULL END)");
  bind_text(s, 1, term); bind_text(s, 2, kind);
  sqlite3_bind_int(s, 3, rank); sqlite3_bind_int64(s, 4, before);
  sqlite3_bind_int64(s, 5, limit); sqlite3_bind_int64(s, 6, limit - 1);
  sqlite3_bind_int(s, 7, include_archived);
  sqlite3_bind_int(s, 8, ob_config.auth_enabled && r->user_id > 0);
  Response response = sqlite3_step(s) == SQLITE_ROW
      ? json_response(200, (const char *)sqlite3_column_text(s, 0))
      : error_response(503, "Ricerca temporaneamente non disponibile.");
  sqlite3_finalize(s);
  snprintf(response.headers, sizeof response.headers, "Cache-Control: no-store\r\n");
  return response;
}
