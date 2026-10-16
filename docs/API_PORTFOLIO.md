# Portfolio and personal reports — OpenBoard 0.5

The portfolio collects boards the user can currently read. Portfolio queries follow the backend's authentication mode: normal operation requires a session, while explicit local `--no-auth` mode permits account-free queries. Personal saved reports always require an authenticated account. Mutations in authenticated mode also require the CSRF token. The frontend uses only JSON and the `/api/catalog` catalog for filter enums.

## Common filters

`GET /api/portfolio`, `/api/portfolio/cards`, `/api/portfolio/insights` and `/api/portfolio/export` accept these parameters:

| Parameter | Value |
|---|---|
| `q` | Literal substring in the title or description, at most 200 characters. `%` and `_` are not wildcards; comparison ignores ASCII case. |
| `status` | `all` by default, `open`, `completed`, `blocked`, `overdue`, `due_soon`, `unassigned`. |
| `assignee_id` | Positive ID of a structured assignee. |
| `priority` | `low`, `normal`, `high`, `urgent`. |
| `label` | One of the labels returned by the catalog. |
| `board_id` | Positive board ID. It does not grant access to the board. |
| `from`, `to` | ISO `YYYY-MM-DD` due dates, inclusive and ordered; cards without a due date are excluded when either bound is present. |
| `include_archived` | `0` by default, or `1` to include archived boards and cards. |
| `before` | Positive cursor, only for card and export pages. |
| `limit` | From 1 to 100, default 30, only for card and export pages. |

Repeated parameters, invalid IDs, unknown enums, impossible dates, reversed ranges and values beyond limits return `400`. Parameters use SQLite bindings. Search, CSV and charts never include deleted boards, lists or cards, or items with deleted ancestors. ACL checks are repeated for every request, including after access revocation.

`open` means incomplete; `blocked` additionally requires an explicit blocking reason or at least one visible incomplete dependency. `overdue` compares the due date with the server's UTC date; `due_soon` includes today and the next seven days. `unassigned` includes only open cards without structured assignees or a legacy free-text assignee name.

## Summary and search

`GET /api/portfolio` returns:

```json
{
  "summary": {
    "boards": 2,
    "total": 12,
    "open": 8,
    "completed": 4,
    "blocked": 1,
    "overdue": 2,
    "due_soon": 3,
    "unassigned": 1,
    "estimate_minutes": 600,
    "total_minutes": 420,
    "checklist_total": 10,
    "checklist_done": 6
  },
  "boards": [],
  "users": [],
  "boards_truncated": false
}
```

Each `boards` item has `id`, `name`, `color` and the same card counts. Empty boards are also included; the list contains at most the 100 boards with the highest IDs, while the summary counts the entire authorized set. `boards_truncated` indicates the limit. `users` contains at most 100 active accounts belonging to visible boards or assigned to cards in the result, ordered by name and ID, with `{id,name,username}`.

`GET /api/portfolio/cards` returns `{items,next_cursor}`. Items contain the card summary used by boards, including `assignees`, `assignee_ids`, `labels`, priority, due dates, version, estimate, manual time, logged time and total time. They add `board_id`, `board_name`, `column_title` and boolean `dependency_blocked`.

Order is always by descending ID. `next_cursor` is the last ID on the page when more items remain, otherwise `null`. To continue, keep the same filters and pass `before=next_cursor`. New cards created during navigation do not cause duplicates on subsequent pages.

## Insights

`GET /api/portfolio/insights` returns:

| Property | Contents |
|---|---|
| `activity` | 30 consecutive UTC days through today, each `{date,count}`; includes days without events. Events are filtered by authorized boards and `board_id`, since they may also concern lists and boards. |
| `overdue_buckets` | Three `{bucket,count}` rows: `1-7`, `8-30`, `31+` overdue days. |
| `capacity` | `{user_id,name,cards,estimate_minutes,total_minutes}` per assignee of open cards; `user_id=0` identifies cards without structured assignees. |
| `time` | `estimate_minutes`, `manual_minutes`, `logged_minutes`, `total_minutes` and `variance_minutes`. |
| `bottlenecks` | Lists with a positive WIP limit reached or exceeded: `{column_id,title,board_id,board_name,wip_limit,open,over_limit}`. |
| `checklists` | `{total,done}`: sums all checklist items and completed items. |
| `dependency_blocks` | Open cards blocked by visible incomplete dependencies: `{id,title,board_id,board_name,remaining}`. |
| `milestones` | Non-deleted milestones: `{id,key,title,board_id,board_name,due_date,completed,total,done,overdue}`. |

Card aggregates respect the same filters as search; `before` and `limit` do not restrict aggregates. Time includes a card's manual time and non-deleted work logs. The variance is total time minus the estimate and may be negative. A card with several assignees contributes fully to each person's capacity; summing assignee rows can therefore count the same estimate more than once. Legacy free-text assignments are included in the row without structured assignees.

Capacity, lists, dependencies and milestones each have at most 100 rows per response. Capacity is ordered by descending card count, lists by WIP overrun, and dependencies by the number of open prerequisites. SQL views aggregate authorized data without loading every card into the C process.

## Saved personal reports

Reports are personal settings, not data snapshots, and do not preserve permissions. They require `--auth` and an account, even when the local installation permits account-free mode. Observers can save and update their own reports without changing shared content.

| Method and path | Action |
|---|---|
| `GET /api/me/reports` | `{reports:[...]}`, pinned first, then descending ID. |
| `POST /api/me/reports` | Creates with `{name,filters?,pinned?}`; returns the report and `201`. |
| `GET /api/reports/{id}` | Reads your own report. |
| `PATCH /api/reports/{id}` | Updates at least one of `name`, `filters`, `pinned`; supplied filters completely replace previous filters. |
| `DELETE /api/reports/{id}` | Permanently deletes your own report. |
| `POST /api/reports/{id}/duplicate` | Copies filters with `{name?}`; the new report is not pinned and starts at version 1. |

Each report contains `{id,name,filters,pinned,version,created_at,updated_at}`. `name` must contain 1–100 characters and cannot consist only of whitespace. `filters` is a JSON object of up to 4096 bytes with search parameters except `before`: positive JSON integers for IDs and the limit, a JSON boolean for `include_archived`, and strings for other fields. Unknown or duplicate properties, null values, string/number coercion and wrong types are rejected. `pinned` is a JSON boolean. The owner and timestamps cannot be changed.

At most 100 reports are allowed per account; creation and duplication beyond the limit return `409`. Every endpoint for another person's report returns `404`, even for administrators. PATCH, DELETE and duplication accept `If-Match: "version"` or an unquoted numeric version: a stale version returns `412`, and a malformed value returns `400`. Updates increment the version; deletion and creation are serialized by the router transaction. Idempotent POST replays also recheck current ownership and authorization before returning a saved response.

Example:

```json
{
  "name": "Urgenti senza responsabile",
  "filters": {"status": "unassigned", "priority": "urgent", "include_archived": false},
  "pinned": true
}
```

## Export

`GET /api/portfolio/export` uses the same filters, order and cursors as `/cards`, and returns `{filename:"portfolio.csv",csv,next_cursor}`. The CSV contains `id,board,column,title,priority,due_date,completed,estimate_minutes,total_minutes`; it uses a comma separator and CRLF endings. Text cells are quoted, quotation marks are doubled, and formulas beginning with `=`, `+`, `-` or `@`, including after spaces, tabs or newlines, are neutralized with an apostrophe. Pagination is not silently omitted: `next_cursor` indicates whether more pages need to be exported.

SQLite migration 6 introduces `saved_reports`; PostgreSQL retains structured fields and MongoDB retains `filters` in external storage. Data visibility always depends on current ACLs. API responses retain `Cache-Control: no-store` like other authenticated resources.

Verification: `tests/test_portfolio.py` exercises all backend features 326–350, including ACL revocation, deleted ancestors, combined filters, cursors with concurrent insertions, JSON types, versions, quotas, deterministic analytical counts and hostile CSV cells. `tests/test_security_domain.py` additionally checks current ownership before personal-report replay.
