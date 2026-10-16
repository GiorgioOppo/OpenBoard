# OpenBoard 0.6.1 API

This reference describes the core API supported by the current release. Additional endpoints are documented in [productivity](API_PRODUTTIVITA.md), [collaboration and accounts](API_COLLABORAZIONE.md), [custom fields and milestones](API_PIANIFICAZIONE.md), [time tracking and conversations](API_TEAMWORK.md), [reviews and approvals](API_REVISIONI.md), [portfolio and personal reports](API_PORTFOLIO.md), [sprints and capacity](API_SPRINT.md), and [forms and requests](API_RICHIESTE.md). Configuration, separate databases, and metrics are covered in the [deployment guide](DEPLOYMENT.md).

The API uses the same origin as the interface: by default, `http://127.0.0.1:8090` in development or `http://openboard.localhost` with Compose. The backend serves APIs only and returns `404` for HTML, CSS, JavaScript, and every non-API path. The native server listens on loopback; the container explicitly sets `--bind 0.0.0.0` on a private network. `--public-url https://board.example.com` configures the public host and origin used behind a reverse proxy. Nginx Proxy Manager terminates TLS.

## HTTP conventions

- API responses use `application/json; charset=utf-8` and `Cache-Control: no-store`, except endpoints explicitly documented as CSV or another format.
- `POST` and `PATCH` require `Content-Type: application/json` and a JSON object, including when no fields are needed: send `{}`.
- `DELETE` accepts an empty body. If present, its body must be a JSON object with the same content type.
- `HEAD` is available for `GET` paths and returns the same headers without a body. `OPTIONS` is not implemented.
- Omitted update fields retain their previous values. Known fields have strict types: for example, `false` is a boolean, `0` is an integer, and `null` does not mean an omitted field. Unknown fields are ignored unless an endpoint explicitly rejects them.
- JSON and strings must be valid UTF-8. Duplicate keys in the request object and validated structures are rejected.
- Resource IDs in paths are positive decimal integers, except the opaque session IDs documented in the [collaboration reference](API_COLLABORAZIONE.md#personal-sessions). Use URLs without a trailing slash.
- Processed requests include `X-Request-ID` in their response to correlate errors with logs; rejection before request processing, such as an overloaded queue, may omit it.
- Writes validate `Host`, `Origin` when supplied, and `Sec-Fetch-Site`. Requests declared `cross-site` are rejected. There is no CORS API.

Creating a board, column, card, or comment returns `201`; other mutations normally return `200`. Board, column, and card mutations return:

```json
{"ok": true, "id": 123, "version": 4}
```

Account, member, and comment operations return `{"ok":true,"id":123}` when they do not return a session or a more specific response documented below. Initial setup returns a session with `201`; login returns a session with `200`.

## Service status

These endpoints are available without a session.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/health` | `{"status":"ok"}`: the process responds |
| GET | `/api/ready` | `200 {"status":"ready"}` when the database is open for writing and a test read succeeds; otherwise `503 {"status":"unavailable"}` |
| GET | `/api/version` | For example, `{"version":"0.6.1","sqlite":"…","auth_enabled":true,"workers":8,"storage":"sqlite"}`; external storage reports `postgresql+mongodb` |

Readiness checks database access and, in external-storage mode, connectivity to PostgreSQL and MongoDB; it does not perform a test write. A write that cannot be persisted to the external services returns `503`; reuse the same `Idempotency-Key` when retrying a supported `POST`.

## Frontend catalogues

`GET /api/catalog` requires a session in the default authenticated mode and returns `labels`, `priorities`, `covers`, and `custom_field_types`. The frontend builds selectors from these metadata; custom definitions and board data come from their respective endpoints. Validation and permissions remain the backend's responsibility.

## Accounts and sessions

Authentication is enabled by default. Domain endpoints require a session; the public exceptions are service status, session status, initial setup, and login. The explicit `--no-auth` option, or `OPENBOARD_AUTH=false`, enables local development without accounts and is allowed only on loopback. In that mode, boards are accessible without a session or CSRF token; endpoints that require an account remain unavailable.

| Method | Path | Body / behavior |
| --- | --- | --- |
| GET | `/api/auth/session` | Session status and CSRF token, including for an anonymous visitor |
| POST | `/api/auth/setup` | `{"name":"Alex","username":"alex","password":"example-password-change-me"}`; creates the first administrator and opens a session. Available only when no users exist; subsequently returns `409` |
| POST | `/api/auth/login` | `{"username":"alex","password":"example-password-change-me"}`; opens a session |
| POST | `/api/auth/logout` | `{}`; revokes the current session and clears the cookie |
| POST | `/api/auth/password` | `{"current_password":"…","password":"new-example-password-change-me"}`; changes the current user's password and revokes their other sessions |

The passwords above are illustrative; choose a unique password for your installation. Example authenticated session response:

```json
{
  "enabled": true,
  "setup_required": false,
  "user": {"id": 1, "name": "Alex", "username": "alex", "role": "admin"},
  "csrf": "<64-character hexadecimal token>"
}
```

For an anonymous visitor, `user` is `null` and `csrf` is empty. In explicit `--no-auth` mode, `enabled` and `setup_required` are `false`; other account, user, and member endpoints return `403`.

Sessions use the `ob_session` cookie with `HttpOnly`, `SameSite=Strict`, and `Path=/`. An HTTPS public URL also enables `Secure`. Sessions last at most 8 hours and expire after 30 minutes of inactivity; an account can have up to 10 sessions. Send the CSRF token returned by the session endpoint in `X-CSRF-Token` for every authenticated write, including logout. Setup and login do not require a previous session. After a `401`, fetch the session again or sign in again.

Setup, login, and password changes consume a shared per-client allowance of 60 attempts in a fixed monotonic five-minute window. A second allowance permits 10 attempts per client IP and operation key: the normalized username for login, one setup key per client, or the authenticated account ID for password changes. Counters have fixed memory and keyed hashing; collisions may cause an earlier refusal but cannot increase an allowance. There is no global authentication budget shared by every client. A backend `429` includes `Retry-After: 300`.

The client address normally comes from the TCP peer. Only the exact IPv4 peer configured in `OPENBOARD_TRUSTED_PROXY` or `--trusted-proxy` may supply a single numeric `X-Real-IP` address. A trusted peer with a missing, duplicate, or malformed address receives `400`; addresses with ports, zones, or comma-separated lists are invalid. The backend ignores forwarded client identities from other peers and never uses `X-Forwarded-For` or `Forwarded` to choose the client. Compose assigns NPM a static address and configures that exact trusted peer; NPM replaces client-supplied IP headers with the TCP client address. The proxy applies additional authentication and connection limits documented in [SECURITY.md](../SECURITY.md) and the [deployment guide](DEPLOYMENT.md).

### Users and permissions

| Method | Path | Body / response | Permission |
| --- | --- | --- | --- |
| GET | `/api/users` | `{"users":[{"id":1,"name":"…","username":"…","role":"admin","active":true,"created_at":"…"}]}` | Global administrator |
| POST | `/api/users` | `name`, `username`, `password`; optional `role`, default `member`; returns `201` | Global administrator |
| PATCH | `/api/users/:id` | One or more of `name`, `role`, `active` | Global administrator |
| GET | `/api/boards/:id/members` | `{"members":[{"user_id":1,"name":"…","username":"…","role":"admin","global_role":"admin","active":true}]}` | Board read access |
| POST | `/api/boards/:id/members` | `{"user_id":2,"role":"member"}`; adds or updates membership; returns `200` | Global or board administrator |
| DELETE | `/api/boards/:id/members/:user_id` | Removes membership; optional body | Global or board administrator |

The allowed roles are `admin`, `member`, and `observer`, for both accounts and board memberships. Global administrators can access every board. Other users can access only boards they belong to. A global `observer` role prevents domain mutations even when board membership is more permissive; a board `observer` role allows only reads on that board. Observers may still manage their personal favorites.

Creating, duplicating, or importing a board makes the current user its administrator. Initial setup assigns existing boards to the first administrator. Deactivating an account revokes its sessions; deactivating or demoting the last active global administrator is rejected with `409`. There is no public signup endpoint or endpoint for physically deleting users.

## Boards

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/boards` | `{"boards":[...]}` with metadata only, without columns or cards; excludes archived boards |
| GET | `/api/boards?include_archived=1` | Includes archived boards |
| POST | `/api/boards` | Creates a board and three initial lists. Optional `language` selects their names; omitting it preserves the Italian defaults |
| GET | `/api/boards/:id` | Full board with columns and cards; excludes archived cards |
| GET | `/api/boards/:id?summary=1` | Board with summarized cards |
| GET | `/api/boards/:id?summary=1&include_archived=1` | Summary including archived cards |
| GET | `/api/boards/:id/revision` | `{"version":12}` for checking updates |
| PATCH | `/api/boards/:id` | Updates one or more writable fields |
| PATCH | `/api/boards/:id/star` | `{"starred":true}`; updates the personal favorite with accounts, or the local favorite without accounts |
| DELETE | `/api/boards/:id` | Moves the board to the trash; its columns and cards become invisible |
| POST | `/api/boards/:id/restore` | `{}`; restores a board from the trash |
| POST | `/api/boards/:id/duplicate` | `{}` or `{"name":"New project"}`; creates a copy with new identities and returns `201` |
| GET | `/api/boards/:id/activity` | Most recent 200 events, newest first |
| GET | `/api/boards/:id/stats` | Counts and groupings for active cards |
| GET | `/api/boards/:id/export` | OpenBoard v2 export, described below |

| Writable field | Type / initial value | Limit |
| --- | --- | --- |
| `name` | Required string on creation; nonempty and not whitespace-only | 200 Unicode characters |
| `description` | String, `""` | 2,000 Unicode characters |
| `color` | String, `"sage"` | `sage`, `peach`, `lavender`, `blue` |
| `starred` | Boolean, `false` | Also saves the personal favorite when accounts are enabled; use `/star` to update only the favorite |
| `archived` | Boolean, `false` | `true` archives; `false` reopens |
| `language` | Optional string, creation only; default `"it"` | Exactly `it`, `en`, `fr`, `es`, `de`, `zh-CN`, or `ja`; unknown values and non-string values return `400` |

`POST /api/boards` accepts `language` only as a creation hint for the three initial list names. For example, `{"name":"Release","language":"en"}` creates `To do`, `In progress`, and `Done`; the board name and other user content are preserved exactly. French defaults are `À faire`, `En cours`, `Terminé`; Spanish: `Por hacer`, `En curso`, `Completado`; German: `Zu erledigen`, `In Arbeit`, `Erledigt`; Simplified Chinese: `待办`, `进行中`, `已完成`; Japanese: `未着手`, `進行中`, `完了`. The legacy Italian defaults remain `Da fare`, `In corso`, `Completato`.

This hint is not persisted as a board property or returned by reads. Existing boards and lists are never translated. Any `language` field on `PATCH /api/boards/:id`, including `null`, returns `400` and leaves the board unchanged. Renaming a list continues to use its normal API. Board creation permissions, transaction boundaries, and idempotency rules remain unchanged.

Responses also contain `id`, `created_at`, `updated_at`, `version`, `role`, `membership_role`, and `readonly`. The two role properties report the role returned for the board; `readonly` also accounts for a global observer role. Detail responses add `columns`.

Archiving differs from trashing: an archived board remains readable through its direct URL. On a board detail request, `include_archived=1` controls which cards are included; on the board list, it controls which boards are included.

## Columns and ordering

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/boards/:id/columns` | Creates a column; requires `title`; accepts `position` and `wip_limit` |
| PATCH | `/api/columns/:id` | Updates `title`, `position`, and/or `wip_limit` |
| DELETE | `/api/columns/:id` | Moves the column to the trash and hides its cards |
| POST | `/api/columns/:id/restore` | `{}`; restores the column if its board is active |

Read columns within their board; there is no `GET /api/columns/:id`. Each column contains `id`, `title`, `position`, `wip_limit`, `version`, `created_at`, `updated_at`, and `cards`.

`title` must contain 1–200 Unicode characters and cannot be whitespace-only. `position` is a zero-based integer: at creation, its maximum is the number of existing columns; on update, its maximum is the number of other columns. Visible columns maintain dense positions (`0,1,2,…`). Omitting `position` on creation appends the column.

`wip_limit` is an integer from 0 to 100,000; the default, 0, means no limit. WIP counts cards in the column that are neither deleted, archived, nor completed. Creating, moving, reopening, restoring, or unarchiving a card that would exceed the limit returns `409`. Completed cards can enter a column without consuming WIP. Lowering the limit below the current count is allowed: existing cards remain, but subsequent additions are blocked.

## Cards

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/columns/:id/cards` | Creates a card in the path's column; only `title` is required |
| GET | `/api/cards/:id` | Full detail, including when the card is archived |
| PATCH | `/api/cards/:id` | Updates, moves, reorders, completes, or archives a card |
| DELETE | `/api/cards/:id` | Moves the card to the trash |
| POST | `/api/cards/:id/restore` | `{}`; restores when its board and column are active and WIP allows it |
| POST | `/api/cards/:id/duplicate` | `{}` or `{"column_id":4}`; copies into the current column or another column on the same board; returns `201` |

Example detail:

```json
{
  "id": 123,
  "column_id": 4,
  "title": "Prepare the launch",
  "description": "Task details",
  "label": "sviluppo",
  "labels": ["sviluppo", "urgente"],
  "due_date": "2026-10-20",
  "assignee": "Alex",
  "cover": "sage",
  "position": 0,
  "completed": false,
  "archived": false,
  "priority": "high",
  "estimate_minutes": 90,
  "checklist": [{"id": "item-1", "text": "Review", "done": false}],
  "version": 4,
  "created_at": "2026-10-15T10:00:00.000Z",
  "updated_at": "2026-10-15T10:05:00.000Z"
}
```

| Writable field | Type / initial value | Validation |
| --- | --- | --- |
| `title` | Required string on creation | 1–300 Unicode characters; not whitespace-only |
| `description` | String, `""` | Up to 10,000 Unicode characters |
| `label` | String, `""` | Single label retained for compatibility with the first version |
| `labels` | Array of strings, `[]` | Up to 5 allowed labels, without duplicates |
| `due_date` | String, `""` | Valid calendar date `YYYY-MM-DD`, year 0001–9999, or empty |
| `assignee` | String, `""` | Up to 100 Unicode characters; free text, not a user ID |
| `cover` | String, `""` | Empty, or `sage`, `peach`, `lavender`, `blue` |
| `completed` | Boolean, `false` | Does not change automatically based on the column title |
| `archived` | Boolean, `false` | Archiving is separate from trashing |
| `priority` | String, `"normal"` | `low`, `normal`, `high`, `urgent` |
| `estimate_minutes` | Integer, `0` | 0–100,000 |
| `checklist` | Array, `[]` | Up to 100 entries, each with `id`, `text`, `done` |
| `column_id` | Positive integer | Moving via `PATCH` only; creation uses the path's column |
| `position` | Zero-based integer | Insertion position after removing the previous position |

Allowed label identifiers are `design`, `sviluppo`, `ricerca`, `marketing`, and `urgente`. These API values do not change with the interface language. `label` also accepts an empty string. Supplying `labels` synchronizes `label` to its first element or `""` for an empty array, even when the request also contains `label`. Supplying only `label` also updates `labels` to a one-element array or an empty array.

Each checklist entry requires a nonempty `id` of up to 100 Unicode characters, nonempty `text` of up to 500 Unicode characters, and a boolean `done`. IDs must be unique within the card. Updating `checklist` replaces the entire array: use `If-Match` to protect concurrent changes.

Moves are allowed only between columns of the same board; otherwise the response is `400`. Changing columns without `position` appends the card. The server updates the source, destination, and ordering in one transaction. Unarchived cards are ordered before archived cards and maintain dense visible positions. Duplication also preserves description, checklist, labels, priority, estimate, assignee, due date, completion, and archive state; it does not copy comments. Additional planning fields and assignment behavior are described in the [productivity reference](API_PRODUTTIVITA.md).

With `summary=1`, each card retains its metadata but replaces `description` and `checklist` with:

```json
{"description_preview":"First 160 characters…","checklist_total":3,"checklist_done":1}
```

The client must read `/api/cards/:id` to open and edit full detail.

## Comments, activity, search, and statistics

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/cards/:id/comments` | `{"comments":[{"id":1,"body":"…","author_id":1,"author":"Alex","created_at":"…"}]}`, oldest first; comment editing metadata and replies are documented in the supplementary references |
| POST | `/api/cards/:id/comments` | `{"body":"Comment text"}`; 1–5,000 Unicode characters, not whitespace-only; returns `201` |
| DELETE | `/api/comments/:id` | Author or global administrator, with board write access; local users without accounts may delete local comments |
| GET | `/api/boards/:id/activity` | `{"events":[{"id":1,"action":"updated","entity_type":"cards","entity_id":123,"title":"…","actor":"Alex","actor_id":1,"created_at":"…"}]}` |
| GET | `/api/search?q=text` | `{"cards":[{"id":123,"title":"…","board_id":1,"board_name":"…","column_title":"…","priority":"normal","due_date":""}]}` |
| GET | `/api/boards/:id/stats` | Statistics for non-deleted, unarchived cards in active columns |

In explicit `--no-auth` mode, comments have `author_id: 0` and `author: "Locale"`. The body is text; the server does not interpret it as HTML. The canonical local-author value remains language-independent.

Activity includes creations, updates, moves, archiving, trashing, restores, imports, board duplication, comments, and membership changes. Personal favorites do not generate shared activity. `/api/boards/:id/activity` returns at most 200 events without pagination; use the [paginated activity endpoint](API_COLLABORAZIONE.md#paginated-activity) to continue beyond a page.

Search requires nonempty `q` of up to 200 Unicode characters, encoded in the query string. It searches substrings in titles, descriptions, and assignees only on authorized boards. It excludes archived boards and cards unless `include_archived=1`, returns at most 200 cards, and sorts by latest update. It uses SQLite `lower()`: default case conversion covers ASCII and does not provide full Unicode linguistic search.

Example statistics:

```json
{
  "total": 8,
  "completed": 3,
  "overdue": 2,
  "estimate_minutes": 360,
  "by_label": {"design": 4, "urgente": 2},
  "by_assignee": {"Alex": 5, "Non assegnato": 3},
  "by_priority": {"normal": 6, "high": 2}
}
```

`overdue` counts incomplete cards with a due date before the current UTC date; a card due today is not overdue. `by_label` counts every label on a card, so its sum can exceed `total`. `estimate_minutes` sums estimates including completed cards in the result. `Non assegnato` is the backend's canonical key for an unassigned card.

## Versions and conflicts

Boards, columns, and cards expose `version`, `created_at`, and `updated_at`. Timestamps are UTC ISO 8601 with milliseconds. Versions increase with changes; an operation may increment them multiple times, so do not assume an exact increment of one. Domain and membership updates also increment the board revision; personal favorites do not.

`PATCH` and `DELETE` on `/api/boards/:id`, `/api/columns/:id`, and `/api/cards/:id` support an optional precondition:

```http
PATCH /api/cards/123 HTTP/1.1
If-Match: "4"
Content-Type: application/json

{"title":"Updated title"}
```

Authenticated writes also require the session cookie and `X-CSRF-Token` described above. If the current version differs, the response is `412` and the mutation is not applied. Read the resource again and present the conflict while preserving the user's draft. Do not automatically retry with a newer version and replace the entire card.

A single decimal number is accepted, with or without quotes. Wildcard `*`, tag lists, and weak tags `W/` are not implemented. Omitting the header remains allowed for compatibility. Core restore, duplicate, membership, and account operations do not apply this precondition. [Comment editing](API_COLLABORAZIONE.md#editing-comments), card assignments and dependencies, and later APIs document their own version requirements. API resource responses do not send a resource ETag: use the `version` field. Static frontend assets have separate caching behavior.

## Idempotent creation and commands

Domain `POST` endpoints accept the optional `Idempotency-Key` header, up to 127 bytes. Core supported operations include board, column, card, and comment creation, duplication, restoration, and import. Supplementary references describe additional domain `POST` commands. The header does not apply to account, user, or membership endpoints, or to `PATCH` and `DELETE`.

```http
POST /api/columns/4/cards HTTP/1.1
Content-Type: application/json
Idempotency-Key: create-2026-10-15-001

{"title":"Prepare the launch"}
```

The key is scoped to the user, path without its query string, and original body. Repeating the same request returns the status and body of the first successful response, with `Idempotency-Replayed: true`, without creating more resources, provided that current authorization still permits the operation. Revoked access or a removed resource can prevent replay; a stored success does not bypass current permissions. Reusing the same key on the same path with a different body returns `409`; differences in whitespace or JSON property order also count as a different body.

The mutation and key record commit in the same transaction. Errors are not stored. Keys persist in the database without automatic expiry: generate a new key for each distinct operation and retain it for retries of the same operation. In explicit `--no-auth` mode, requests share the local identity `0`.

## Trash and restoration

`DELETE` performs a logical deletion and retains data. A trashed board hides all its columns and cards; a trashed column hides its cards. Reading a hidden resource returns `404`.

```http
GET /api/trash
```

```json
{
  "items": [
    {"kind":"cards","id":123,"title":"Prepare the launch","deleted_at":"2026-10-15T11:00:00.000Z","board_id":1}
  ]
}
```

The trash contains only explicitly deleted resources on authorized boards. Descendants hidden by a parent's deletion are not added individually. `kind` values are plural: `boards`, `columns`, `cards`.

In addition to `/api/:kind/:id/restore`, the following is available:

```http
POST /api/trash/cards/123/restore
Content-Type: application/json

{}
```

Restore the board first, then the column, then the card. A parent still in the trash, an already restored resource, or a reached WIP limit produces `409`. Restoring a parent makes children visible again unless they were individually deleted. Previous `archived` state is preserved. There is no endpoint for permanently emptying the trash.

## Export and import

`GET /api/boards/:id/export` returns JSON and `Content-Disposition: attachment; filename="openboard-1.json"`:

```json
{
  "format": "openboard",
  "version": 2,
  "board": {
    "id": 1,
    "name": "Project",
    "description": "",
    "color": "sage",
    "starred": false,
    "archived": false,
    "version": 8,
    "created_at": "2026-10-15T10:00:00.000Z",
    "updated_at": "2026-10-15T10:30:00.000Z",
    "role": "admin",
    "membership_role": "admin",
    "readonly": false,
    "columns": [
      {"id": 4, "title": "To do", "position": 0, "wip_limit": 0, "version": 1,
       "created_at": "2026-10-15T10:00:00.000Z", "updated_at": "2026-10-15T10:00:00.000Z", "cards": []}
    ]
  }
}
```

The export contains non-deleted columns and full detail for their non-deleted cards, including archived cards, even when the interface uses summaries. It does not contain comments, activity, memberships, accounts, sessions, or trash. It is not a complete database backup; supplementary references describe the additional fields supported by format version 2.

`POST /api/import` accepts the same object with `format: "openboard"`, `version: 2`, and a `board` object containing `name` and a `columns` array. Each column requires `title` and a `cards` array; each card requires `title`. Arrays may be empty. At most 100 columns and 10,000 cards are allowed overall, within the 2 MiB HTTP limit and normal endpoint field limits.

Import always creates a new board; it does not update or replace the source. It generates new IDs, timestamps, and revisions, and rebuilds ordering from arrays, ignoring old `position` and `column_id` values. It preserves supported functional fields, including archive state, completion, checklist, estimates, labels, and WIP limits. The importer applies WIP limits after loading cards, allowing a board already above its limit to be restored without losing work. The exported favorite reflects the requesting user and is applied to the new owner.

The operation is atomic: if any column or card is invalid, no part of the new board is retained. Success returns `201 {"ok":true,"id":…, "version":…}`. Direct import of Trello JSON is not implemented.

For a complete local SQLite copy, use `./build/openboard --db data/openboard.db --backup /path/to/backup.db`; this performs a consistent backup through the SQLite API and exits. For PostgreSQL/MongoDB, use the full application backup procedure in the [deployment guide](DEPLOYMENT.md). Database restoration is an administrative operation, separate from `/api/import`.

## Errors and operational limits

Application errors have this shape:

```json
{"error":"Human-readable message"}
```

The message above illustrates the shape; backend messages retain their canonical language and are translated by the frontend for display. Clients should use HTTP status codes and the documented contract rather than matching translated text.

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, types, values, positions, forwarded client address, or HTTP request |
| `401` | Missing/expired session or incorrect credentials |
| `403` | Host/origin, CSRF token, or role not permitted; account feature disabled |
| `404` | Path or resource not found, deleted, hidden by a parent, or inaccessible |
| `405` | Method not supported for the path |
| `408` | Request receive deadline exceeded |
| `409` | WIP, restore conflict, duplicate username, setup already complete, last-administrator protection, or incompatible idempotency key |
| `412` | Stale or mismatched `If-Match` version |
| `413` | Body exceeds 2,097,152 bytes (2 MiB) |
| `415` | Content type is not JSON for a write that requires a body |
| `429` | Authentication attempt allowance or proxy request/connection limit exceeded |
| `431` | Headers exceed 16,384 bytes |
| `500` | Internal processing error |
| `503` | Database temporarily unavailable/busy, service not ready, or request queue overloaded |

An unsuccessful `/api/ready` response uses `{"status":"unavailable"}` instead of `error`. Not every transport limit produces a JSON response: an already closed socket or a connection deadline may lead to a closed connection. The reverse proxy may produce its own error body, including for its `429` limits.

| Limit | Value |
| --- | --- |
| HTTP body | 2 MiB by default |
| Total HTTP headers | 16 KiB |
| Request target, path and query combined | 1,023 bytes |
| `If-Match` | 79 bytes |
| `Idempotency-Key` | 127 bytes |
| User display name | 1–100 Unicode characters; not whitespace-only |
| Username | 3–64 ASCII characters: letters, digits, `.`, `_`, `-`; normalized to lowercase |
| New password | 12–256 UTF-8 bytes |
| Header receive deadline | 5 seconds total |
| Body receive deadline | 10 seconds total after headers |
| Response send deadline | 10 seconds total |
| Workers | 8 by default; `--workers` accepts 1–32 |
| Connection queue | 64 |

The server handles one HTTP/1.1 request per connection, then closes the connection. `Transfer-Encoding`, `Expect`, and duplicate sensitive headers are rejected; use `Content-Length` for request bodies.
