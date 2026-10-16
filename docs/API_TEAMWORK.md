# Teamwork API — OpenBoard 0.4

Routes return JSON, use the sessions and CSRF token documented in
[API.md](API.md), and apply current board permissions to every request.
Deleted or inaccessible resources return `404`. Writes are atomic together
with activity and the board revision. SQL errors return `503` and roll back
all changes.

## Work logs (231–240)

| Method and path | Behavior |
| --- | --- |
| `POST /api/cards/:id/worklogs` | Creates a work log; `201` with the full record. |
| `GET /api/cards/:id/worklogs` | Lists `{items,next_cursor}` in descending ID order. |
| `PATCH /api/worklogs/:id` | Updates the minutes, date and/or note of your own record. |
| `DELETE /api/worklogs/:id` | Soft-deletes your own record. |
| `POST /api/worklogs/:id/restore` | Restores a deleted record. |
| `GET /api/cards/:id/time-summary` | Returns `{manual_minutes,logged_minutes,total_minutes}`. |
| `GET /api/boards/:id/time-report` | Board report with rows and totals by author and day. |
| `GET /api/boards/:id/time-export` | Returns `{filename,csv}` to export the full report. |
| `GET /api/me/time-report` | Weekly report of your own records on boards you can still access. |

Creation body:

```json
{"minutes":45,"date":"2026-10-16","note":"Revisione della proposta"}
```

`minutes` is an integer between 1 and 1000000; `date` is a real Gregorian
`YYYY-MM-DD` date, from year 1900 through 9999; `note` is optional, with at most
2000 Unicode characters. A card allows at most 10000 records, including deleted
records, to bound history size. Exceeding this limit returns `409`. An update
requires at least one of these three fields, with the same limits.

A record contains:

```json
{"id":1,"card_id":1,"user_id":2,"author":"Alice","date":"2026-10-16","minutes":45,"note":"Revisione della proposta","version":1,"created_at":"2026-10-16T10:00:00.000Z","updated_at":"2026-10-16T10:00:00.000Z","deleted_at":null}
```

Updating, deleting and restoring require both board write permission and
ownership of the record; the global administrator may manage any accessible
record. Observers can read but cannot log or change time. Local account-free
mode uses `user_id:0` and author `Locale`.

`If-Match: "1"` checks the version for updates, deletion and restoration: a stale
version returns `412`, and invalid syntax returns `400`. This header is optional
for compatibility with the other endpoints. Every actual change increments
`version`; restoring an already active record is idempotent. POST requests also
support `Idempotency-Key`, subject to current authorization before replay.

The list supports `limit` from 1 to 100 (default 30), `before` with a positive ID,
and `include_deleted=1` to include the trash. Deleting a card or an ancestor also
hides its work logs until restoration.

The existing manual time in `cards.actual_minutes` remains independent:
`logged_minutes` sums active work logs, while `total_minutes` sums manual and
logged minutes. Logging time updates the board revision without overwriting
manual time or changing `cards.version`.

The board report accepts `from`, `to` and `user_id`. Dates are inclusive; if
omitted, the range is the current UTC month. The range must be ordered and span
at most 366 days. Rows add `card_title`, `board_id` and `board_name` to the record
fields. The response contains:

```json
{"from":"2026-10-01","to":"2026-10-31","rows":[],"truncated":false,"by_user":[{"user_id":2,"author":"Alice","minutes":45}],"daily":[{"date":"2026-10-16","minutes":45}],"totals":{"logged_minutes":45,"entries":1},"total_minutes":45}
```

`rows` contains at most 10000 rows; `truncated:true` indicates additional rows,
while totals and aggregates include all eligible records. Archived resources
are included to preserve history; deleted resources are excluded.

The CSV applies the same filters as the report. It includes a header and columns
`date,card_id,card_title,user_id,author,minutes,note`; it quotes text fields,
doubles quotation marks, preserves commas and newlines, and prefixes values
that could be interpreted as spreadsheet formulas with an apostrophe. It
returns `413` for a truncated report or JSON larger than 2 MiB: narrow the range
rather than exporting incomplete data. The response uses
`Cache-Control: no-store`.

The personal report requires `--auth`; `week=YYYY-MM-DD` may name any day and is
normalized to Monday through Sunday inclusive. If omitted, it uses the current
UTC week. The response adds `week_start` and `week_end`, alongside `daily`,
`rows` and `total_minutes`. It includes only the current user and rechecks board
access; revoking membership immediately removes the data.

## Discussions and personal tools (241–250)

| Method and path | Behavior |
| --- | --- |
| `POST /api/comments/:id/reactions` | Adds your own reaction `{reaction}`. |
| `DELETE /api/comments/:id/reactions` | Removes your own reaction `{reaction}`. |
| `GET /api/comments/:id/reactions` | Returns `{items:[{reaction,count,mine}]}`. |
| `PATCH /api/comments/:id/pin` | Sets `{pinned:true/false}` with optional `If-Match`. |
| `GET /api/cards/:id/pinned-comments` | Returns `{comments:[...]}` containing pinned comments. |
| `GET /api/cards/:id/bookmark` | Returns `{id,bookmarked}` for your personal card status. |
| `PATCH /api/cards/:id/bookmark` | Sets your personal bookmark `{bookmarked:true/false}`. |
| `GET /api/me/bookmarks` | Returns `{items,next_cursor}` containing your still-accessible bookmarks. |
| `POST /api/comments/:id/replies` | Creates a reply `{body}`; `201` with `{ok,id,version}`. |
| `GET /api/comments/:id/thread` | Returns `{parent,replies}`. |

Allowed reactions are `like`, `heart`, `celebrate`, `eyes`, `question` and `done`.
A person can use each reaction once on the same comment; repeated additions and
removals are idempotent. Reactions and bookmarks require `--auth` and read
access, and are also available to observers. A bookmark is private and does not
generate shared activity; the list uses `limit` and `before` as work logs do,
ordered by descending card ID.

Pinning a comment and replying require board write permission. Pinning
increments the comment version only when its state changes; it changes neither
the text nor the modification date. All readers see pinned comments and
reaction counts. Replies contain 1–5000 characters and cannot consist only of
whitespace.

`GET /api/cards/:id/comments` retains its previous format and adds `card_id`,
`parent_id`, `pinned` and `reactions` to each comment. `parent_id:null` identifies
a top-level comment. Threads have one level: replying to a reply links it to
the top-level comment. Deleting the top-level comment **preserves** its replies,
which become top-level comments; its reactions are removed by a foreign key.
Comment updates and deletion retain the existing author/administrator
permissions.

## Notification search and filtering

`GET /api/notifications-filtered` retains the notification list format and adds
`filtered_count`. It accepts `limit`, `before`, `unread=1` and `q` up to 200
Unicode characters. Literal search covers the title, author and action;
case-insensitive comparison uses SQLite's `lower()` (ASCII), while other letters
are compared literally. Filters apply **before** pagination. `unread_count`
counts all visible unread notifications regardless of the search;
`filtered_count` counts visible notifications matching the filters regardless
of the cursor. Revoked memberships and deleted boards are always excluded.
The endpoint requires accounts and returns `Cache-Control: no-store`.

## Verification

`tests/test_teamwork.py` checks work-log creation, updates, deletion and
restoration, stale versions, dates and quotas, separation of manual time,
idempotency, SQL rollback and revisions, ownership and observers, membership
revocation, weekly and date-range reports, CSV formulas/quotation marks/newlines,
deduplicated reactions, private paginated bookmarks, pinned comments and threads
that preserve replies, and notification filtering before pagination.
