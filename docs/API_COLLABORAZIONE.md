# Collaboration API — OpenBoard 0.6.1

These endpoints were introduced in 0.3. Responses are JSON, except metrics documented elsewhere. Writes require `Content-Type: application/json` and a JSON object; `DELETE` may have an empty body. Authentication is enabled by default: send the `ob_session` cookie and, for writes, the `X-CSRF-Token` returned by `/api/auth/session`. Writes use a transaction: activity or notification errors roll back the original change. Domain `POST` endpoints accept `Idempotency-Key` as described in [API.md](API.md); replay also verifies current authorization. In external-storage mode, the application acknowledges writes after its MongoDB documents and PostgreSQL transaction have persisted.

Watches, notifications, profiles, and session management require an account and return `403` in explicit loopback-only `--no-auth` development mode. Attachments, comment editing, and paginated activity also work in that mode. With accounts enabled, every board data access checks current permissions; a missing or inaccessible resource normally returns `404`.

## Watching boards and cards

`PATCH` or `POST /api/boards/:id/watch` and `/api/cards/:id/watch`:

```json
{"watching":true}
```

Response `200`:

```json
{"ok":true,"id":1,"watching":true}
```

`false` stops the subscription. Read access is sufficient: observers can watch a resource.

`GET /api/me/watches` returns only the current user's subscriptions that remain accessible, excluding deleted resources and resources with deleted ancestors:

```json
{"boards":[{"id":1,"name":"Project"}],"cards":[{"id":7,"title":"Review","board_id":1}]}
```

## Personal notifications

`GET /api/notifications?limit=30&before=82`:

```json
{
  "items":[{
    "id":81,"activity_id":120,"board_id":1,"actor":"Alex","actor_id":2,
    "action":"updated","entity_type":"cards","entity_id":7,
    "title":"Review","created_at":"2026-10-15T20:00:00.000Z","read":false
  }],
  "next_cursor":null,
  "unread_count":1
}
```

Results use descending ID order. `limit` is an integer from **1 to 100**, default **30**. `before` is an exclusive positive ID. When more results exist, `next_cursor` contains the last item's ID; use it as `before` in the next request. Otherwise, it is `null`. Duplicate parameters, invalid limits, or invalid cursors return `400`. `unread_count` counts all currently accessible unread notifications, independently of the page. Additional filters are documented in the [teamwork reference](API_TEAMWORK.md).

- `GET /api/notifications/unread-count` → `{"unread_count":1}`.
- `PATCH /api/notifications/:id` with `{"read":true}` marks a notification as read; `false` marks it unread again. Response `200`: `{"ok":true,"id":81}`.
- `POST /api/notifications/read-all` with `{}` marks all currently accessible notifications belonging to the current user as read. Response `200`: `{"ok":true,"id":0}`.

Notifications are **in-app only**, without email or push delivery. A SQLite trigger creates them together with the activity record for users watching the board or card. The actor is excluded; watching both resources creates only one notification per activity. Deactivated users and users without access do not receive new notifications. Every read and state change rechecks access: revoking membership also hides earlier notifications, except for global administrator access. Observers may manage their own notifications.

## Attachments

`POST /api/cards/:id/attachments`:

```json
{"name":"note.txt","mime":"text/plain","data_base64":"Y2lhbw=="}
```

Response `201`: `{"ok":true,"id":12}`. `data_base64` uses canonical RFC 4648 base64, padded when necessary: whitespace, line breaks, alternative alphabets, and noncanonical padding bits are rejected.

Limits and validation:

- **1 MiB decoded per file**, **10 active files**, and **5 MiB decoded active data per card**.
- Names contain 1–**180 Unicode characters** and must be valid UTF-8; `/`, `\`, ASCII control characters, and the complete names `.` and `..` are forbidden.
- MIME is required, at most **100 characters**, in `type/subtype` form without parameters or spaces.
- Empty files are allowed and occupy one of the ten slots.
- Invalid data returns `400`; exceeding the card quota returns `409`. The configured HTTP body limit may reject the request earlier with `413`.

`GET /api/cards/:id/attachments` returns metadata, including recoverable deleted attachments, newest first:

```json
{"attachments":[{"id":12,"card_id":7,"name":"note.txt","mime":"text/plain","size":4,"created_at":"2026-10-15T20:00:00.000Z","deleted_at":null}]}
```

`GET /api/attachments/:id` returns a JSON envelope; uploaded content is not served directly as HTML or script:

```json
{"id":12,"name":"note.txt","mime":"text/plain","data_base64":"Y2lhbw=="}
```

The response includes `Cache-Control: no-store` and `Content-Disposition: attachment; filename="attachment.json"`. Clients can decode the content and download it using the original name. The interface requires an explicit download and does not render uploaded content in the page.

`DELETE /api/attachments/:id` sets `deleted_at`, releases the active quota, and returns `200` with `{"ok":true,"id":12}`. Downloading a deleted attachment returns `404`. `POST /api/attachments/:id/restore` with `{}` restores it only if active quotas permit; otherwise it returns `409`. Deleting an already deleted attachment or restoring an already active attachment returns `200` without duplication.

Reading requires card access; uploading, deleting, and restoring require board write access. Observers may read and download attachments but cannot change them. The card, column, and board must not be deleted; archiving differs from deletion.

Content is retained as validated base64 in **SQLite** in local mode and in **MongoDB** with structured metadata in PostgreSQL in external-storage mode; there are no filesystem upload paths. A full application backup includes attachments, including deleted ones. Single-board JSON export excludes attachments and does not replace a full backup. Deleted files remain stored for restoration, so the active-file quotas do not cap total database size. OpenBoard does not include antivirus scanning; see [SECURITY.md](../SECURITY.md) for the supported security boundary.

## Editing comments

`PATCH /api/comments/:id` with `{"body":"Updated text"}`. Text must contain **1–5,000 characters** and cannot be whitespace-only. Board write access is required; with accounts enabled, the caller must also own the comment or be a global administrator.

The optional `If-Match: "1"` header checks the current version; an unquoted decimal number is also accepted. A different version returns `412` without changing the comment. Response `200`:

```json
{"ok":true,"id":9,"version":2}
```

`GET /api/cards/:id/comments` also returns `version` and `edited_at` for each comment; `edited_at` is `null` until the first edit. Editing records `comment_edited` activity and updates the board revision. Replies, reactions, and pinning are described in the [teamwork reference](API_TEAMWORK.md).

## Personal profile

`GET /api/me/profile`:

```json
{"id":2,"name":"Alex","username":"alex","role":"member"}
```

`PATCH /api/me/profile` with `{"name":"Alex Morgan"}` changes only the display name and returns the updated object. The name is required, cannot be whitespace-only, and has a maximum of **100 characters**. This endpoint cannot change the role or username. Observers may also update their own display name.

## Personal sessions

`GET /api/me/sessions` lists the current user's active sessions, excluding sessions that have expired or have been inactive for at least 30 minutes:

```json
{"sessions":[{"id":"50b854be40754db09d220907ab1aecaa6","created_at":1792094400,"last_seen":1792094700,"expires_at":1792123200,"current":true}]}
```

Dates are **Unix seconds**. Public IDs are random 32-character hexadecimal strings, distinct from tokens and their hashes; the endpoint does not expose credentials or CSRF tokens.

- `DELETE /api/me/sessions/:id` revokes another session belonging to the current user. Response `200`: `{"ok":true,"id":0}`. An unknown ID or another user's session returns `404`.
- Attempting to revoke the current session returns **409**: use `/api/auth/logout` to sign out of the current session.
- `POST /api/me/sessions/revoke-others` with `{}` revokes every other session belonging to the current user and retains the current one. Response `200`: `{"ok":true,"id":0}`.

Observers may also list and revoke their own sessions. Revocation invalidates subsequent requests from the affected session, including writes that recheck the session within their transaction.

## Paginated activity

`GET /api/boards/:id/activity-page?limit=30&before=121` requires board read access and uses the same limits and exclusive cursors as notifications:

```json
{"items":[{"id":120,"action":"updated","entity_type":"cards","entity_id":7,"title":"Review","actor":"Alex","actor_id":2,"created_at":"2026-10-15T20:00:00.000Z"}],"next_cursor":null}
```

The original `/api/boards/:id/activity` endpoint remains available; the paginated endpoint continues beyond the first page without offsets.
