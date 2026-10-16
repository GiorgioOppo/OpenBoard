# Sprints and capacity — OpenBoard 0.6

Sprints organize existing cards from the same board into planned, active or closed iterations. They require an authenticated account, current board access and, for mutations, a CSRF token and valid origin. These APIs return `403` in `--no-auth` mode; anonymous requests in authenticated mode receive `401`.

## Features 401–425

| ID | Feature | Method and path |
|---|---|---|
| 401 | Creation with a name, goal and date range | `POST /api/boards/{board}/sprints` |
| 402 | Board listing with search, state and cursor | `GET /api/boards/{board}/sprints` |
| 403 | Details with current permissions | `GET /api/sprints/{id}` |
| 404 | Updating the name, goal and dates | `PATCH /api/sprints/{id}` |
| 405 | Activating one sprint per board | `POST /api/sprints/{id}/activate` |
| 406 | Closing without marking unfinished cards complete | `POST /api/sprints/{id}/close` |
| 407 | Reopening as planned with conflict checks | `POST /api/sprints/{id}/reopen` |
| 408 | Recoverable deletion | `DELETE /api/sprints/{id}` |
| 409 | Restoration with active-sprint and assignment checks | `POST /api/sprints/{id}/restore` |
| 410 | Adding an existing card | `POST /api/sprints/{id}/cards` |
| 411 | Removing a card from a sprint | `DELETE /api/sprints/{id}/cards/{card}` |
| 412 | Atomically scheduling up to 100 cards | `POST /api/sprints/{id}/cards/bulk` |
| 413 | Atomically removing up to 100 cards | `DELETE /api/sprints/{id}/cards/bulk` |
| 414 | Backlog of unscheduled cards | `GET /api/boards/{board}/backlog` |
| 415 | Cards filtered by search, status, priority and assignee | `GET /api/sprints/{id}/cards` |
| 416 | Declared capacity for active members with write access | `GET /api/sprints/{id}/capacity`; `PATCH /capacity/{user}` |
| 417 | Individual workloads with exact allocation of shared cards | `GET /api/sprints/{id}/capacity-report` |
| 418 | Explicit snapshot of the current UTC day | `POST /api/sprints/{id}/snapshots` |
| 419 | Historical snapshot series | `GET /api/sprints/{id}/snapshots` |
| 420 | Removing an incorrect snapshot | `DELETE /api/sprints/{id}/snapshots/{YYYY-MM-DD}` |
| 421 | Progress from actual cards, estimates and work logs | `GET /api/sprints/{id}/progress` |
| 422 | Descriptive comparison of estimated remaining work and capacity | `GET /api/sprints/{id}/forecast` |
| 423 | Personal tasks in accessible active sprints | `GET /api/me/sprint-tasks` |
| 424 | CSV plan with formula protection | `GET /api/sprints/{id}/export` |
| 425 | Change history with cursor | `GET /api/sprints/{id}/history` |

## Creation, details and permissions

Creation:

```json
{"name":"Sprint accessibilità","goal":"Completare i flussi da tastiera","start_date":"2026-11-02","end_date":"2026-11-13"}
```

`name` is required, contains at least one non-whitespace character, and has at most 120 characters; `goal` is optional, with at most 4000 characters. Dates are optional: empty strings or real `YYYY-MM-DD` dates with a year of at least 1900. When both are present, the start cannot follow the end. No duration, working-day or company-calendar rules are imposed. An update accepts at least one of these four fields; an empty string removes the goal or date. Unknown fields, NUL, wrong types and out-of-range values return `400`.

Details are returned with `201` on creation and `200` for other mutations:

```json
{"id":2,"board_id":1,"name":"Sprint accessibilità","goal":"Completare i flussi da tastiera","start_date":"2026-11-02","end_date":"2026-11-13","state":"planned","creator_id":1,"version":1,"deleted_at":null,"created_at":"2026-10-16T12:00:00.000Z","updated_at":"2026-10-16T12:00:00.000Z","permissions":{"manage":true,"schedule":true}}
```

Global or board administrators with write access manage details, lifecycle, capacity and snapshots. Members with write access can add and remove cards in planned or active sprints. Observers can read; they cannot modify a sprint even if they were its creator or an administrator before demotion. `permissions` reflects the current user and sprint state. Inaccessible resources or deleted ancestors return `404`; a forbidden mutation of a readable resource returns `403`.

All mutations of an existing sprint accept `If-Match: "version"` or an unquoted positive integer. A stale version returns `412`, and an invalid header returns `400`. Every successful change increments the sprint version once, updates the board version, and records an event and activity in the same transaction. Replacing today's snapshot always requires `If-Match`; omitting it returns `409`.

POST requests support the router's global idempotency: the same user, path, key and body return the original result after current authorization is checked; a different body with the same key returns `409`. Authenticated responses use `Cache-Control: no-store`.

## Lifecycle and scheduling

The `activate`, `close`, `reopen` and `restore` endpoints receive `{}`. Creation produces `planned`; only a planned sprint can become `active`, and a board can have at most one active, non-deleted sprint. `close` requires `active` and produces `closed`. Closing preserves memberships, capacity and snapshots, without changing card completion. Open cards can therefore remain in history and be scheduled in a new sprint.

`reopen` requires `closed` and produces `planned`. Before reopening, the backend checks that no card still belonging to the board is already assigned to another planned or active sprint: if one is, it returns `409` without removing cards from the newer plan. The check includes archived or trashed cards and trashed lists that could later be restored: hiding a card does not permit double scheduling. The same checks apply when restoring a deleted sprint; a restored sprint retains its previous state. Restoring an active sprint when the board already has another active sprint returns `409`.

Details, cards and capacity cannot be changed in closed sprints; reopen them first. Deletion preserves all data. Regular details and lists exclude deleted sprints; `include_deleted=1` includes them for restoration. History remains readable after deletion. Other aggregates and related lists require a non-deleted sprint.

A single insertion uses `{"card_id":42}`. Batches use `{"card_ids":[42,43]}` with 1–100 distinct positive integers, excluding strings, booleans and decimals. All cards must be non-deleted, unarchived and in non-deleted lists of the same board. A card may belong to several closed sprints but only one planned or active, non-deleted sprint. Duplicate or conflicting insertion returns `409`; an unrelated or hidden card returns `404`. Removing a card that does not belong to the sprint returns `409`.

Batches validate all input before writing and save or roll back all memberships together. History or persistence errors also roll back cards, versions and activity. Limits are 200 sprints per board, including deleted sprints; 1000 memberships per sprint; and 10000 events per sprint. Mutations exceeding a limit return `409`.

## Lists, backlog and personal tasks

Sprint lists, card lists and history return `{items,next_cursor}` in descending ID order. `limit` is 1–100, default 30; `before` is a positive ID and excludes that ID. `next_cursor` is the last returned ID if more results exist, otherwise `null`. IDs keep pagination stable when new records are inserted. Keep the same filters for subsequent pages.

The sprint list accepts `q`, `state=planned|active|closed` and `include_deleted=0|1`. Search matches a literal substring in the name and goal. Card lists, backlog, personal tasks and CSV accept:

| Parameter | Meaning |
|---|---|
| `q` | Literal substring in the title and description, at most 200 characters; `%` and `_` are not wildcards. |
| `status` | `all` (default), `open`, `completed`, `blocked`. |
| `priority` | `low`, `normal`, `high`, `urgent`; omitting it does not restrict results. |
| `assignee_id` | Positive ID present among the card's structured assignees. |
| `before`, `limit` | Cursor and page size. |

`blocked` includes open cards with a blocking reason or incomplete dependencies that remain readable and non-deleted. Duplicate parameters or invalid values return `400`. Returned cards contain the standard summary plus `board_id`, `board_name`, `column_title`, `sprint_id` and `sprint_name`.

The backlog contains unarchived cards that do not belong to planned or active, non-deleted sprints. Historical membership in a closed sprint does not remove a card from the backlog. The personal inbox includes only cards with the current user as a structured assignee in active sprints, on unarchived boards that remain accessible. Access is rechecked after every revocation.

All counts, workloads, exports and lists follow the card's current board and non-deleted ancestors. Archived, deleted or transferred cards, including transfers through imports or administrative changes, do not disclose data through old memberships.

## Capacity, progress and comparison

`PATCH /api/sprints/{id}/capacity/{user}` receives `{"minutes":2400}`. The value is an integer between 0 and 1000000. The person must be active, an actual board member with write access, and have a global role other than observer. Global administrators still need board membership to receive capacity. Zero is an explicit declaration, distinct from unconfigured capacity.

`GET /capacity` returns `{items:[{user_id,name,minutes}]}` for all currently eligible members, including those without configuration, which counts as zero. Removal from the board, demotion to observer and deactivation delete stored capacity; reinvitation or reactivation does not restore old values. Queries still check current eligibility.

`GET /progress` returns:

```json
{"total":3,"completed":1,"open":2,"estimate_minutes":121,"completed_estimate_minutes":20,"remaining_minutes":82,"logged_minutes":19,"completion_percent":33.33}
```

`logged_minutes` includes a card's manual actual time plus non-deleted work logs, including completed cards. Remaining work for an open card is the maximum of zero and its estimate minus manual actual time and work logs; it is zero for a completed card. The percentage measures completed cards divided by total cards, rounded to two decimal places; an empty sprint returns zero.

`GET /capacity-report` returns `{items:[{user_id,name,capacity_minutes,assigned_minutes,logged_minutes,remaining_minutes,over_capacity}],totals:{capacity_minutes,assigned_minutes,remaining_minutes,unassigned_minutes}}`. A card with several currently eligible assignees splits its estimate, logged minutes and remaining work equally: remainder minutes go to the lowest user IDs. Thus 101 minutes shared by two people become 51 and 50 without doubling totals. Cards without eligible assignees still contribute to totals and `unassigned_minutes`. `over_capacity` compares a person's allocated remaining work with their declared capacity.

`GET /forecast` adds `capacity_minutes`, `capacity_gap_minutes`, `estimate_missing`, `unestimated_cards`, `capacity_user_count`, `capacity_configured` and `description` to the progress fields. `estimate_missing` and `unestimated_cards` are the same count of open cards with zero estimates: their effort is unknown and must not be treated as free work. `capacity_configured` is true if at least one valid declaration exists, including zero; `capacity_user_count` counts those people. The gap is the maximum of zero and estimated remaining work minus declared capacity. This descriptive comparison does not calculate delivery dates, historical velocity, holidays or daily capacity, and does not guarantee sprint completion.

## UTC snapshots, history and CSV

`POST /snapshots` with `{}` records the active sprint's current counts and minutes for the current UTC day. It does not accept past or future dates and is not triggered implicitly by reads or a scheduler. A second capture on the same day replaces the first only with `If-Match` for the current version. Up to 366 days can be retained; exceeding the limit returns `409`, while replacing an existing day remains possible.

`GET /snapshots` returns `{items:[{day,total,completed,estimate_minutes,completed_estimate_minutes,remaining_minutes,logged_minutes,captured_at}]}` in ascending day order. Values remain those actually captured, even if cards and estimates later change. `DELETE /snapshots/{YYYY-MM-DD}` removes an incorrect snapshot, even after sprint closure, with management permission and the sprint version. An absent day returns `404`. Corrections are recorded in history.

`GET /history` returns events containing `{id,actor_id,actor,action,subject_id,note,created_at}`. Actions are `sprint_created`, `sprint_edited`, `sprint_activated`, `sprint_closed`, `sprint_reopened`, `sprint_deleted`, `sprint_restored`, `sprint_cards_added`, `sprint_cards_removed`, `sprint_capacity_set`, `sprint_snapshot_captured` and `sprint_snapshot_deleted`. The author's name is retained at the time of the action; `subject_id` identifies the card for single-card operations or the person for capacity. Batches retain the card count in the note.

`GET /export` uses the card filters and returns `{filename,csv,truncated:false,record_count}`. It ignores `before` and `limit` and includes all matching cards up to 1000; more than 1000 or 2 MiB returns `413`, without partial CSV output. Columns are `id,title,column,priority,completed,estimate_minutes,logged_minutes,assignee,due_date`. The format uses commas and CRLF; free text is quoted, quotation marks are doubled, and formulas beginning with `=`, `+`, `-` or `@` are neutralized with an apostrophe, including after spaces or whitespace characters.

Migration 7 adds only the relational tables `sprints`, `sprint_cards`, `sprint_capacity`, `sprint_snapshots` and `sprint_events`, their indexes, and capacity-invalidation triggers. External storage retains all these values in PostgreSQL; it does not create artificial JSON documents. `tests/test_sprints.py` checks all 25 features with real sessions, concurrency, ACLs, revocations, history, injected rollback, quotas, actual counts and hostile CSV input.
