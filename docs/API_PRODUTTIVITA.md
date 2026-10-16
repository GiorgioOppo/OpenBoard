# Productivity API — OpenBoard 0.6.1

These APIs, introduced in 0.3, provide planning, assignees, dependencies, personal templates, saved filters, and bulk changes. They use the sessions, CSRF protection, JSON responses, and access rules described in [API.md](API.md). Authentication is enabled by default. In explicit `--no-auth` development mode, personal objects belong to the local user `0`.

Shared writes require board write access. Saved filters require only board read access and belong to the current user: observers can create, rename, and delete their own filters. Users cannot read or modify another account's filters.

## Card planning

`POST /api/columns/:id/cards` and `PATCH /api/cards/:id` accept these additional fields. Full card responses and board `?summary=1` responses include them.

| Field | Type and constraints | Initial value |
| --- | --- | --- |
| `start_date` | Valid calendar date `YYYY-MM-DD`, or an empty string. When both dates are present, start ≤ `due_date`. Partial updates also check the saved date. | `""` |
| `blocked_reason` | String, up to 1,000 characters. | `""` |
| `actual_minutes` | Integer from 0 to 1,000,000. | `0` |
| `reference_url` | Empty string or `http://`/`https://` URL, up to 2,000 characters; no control characters, spaces, backslashes, or credentials in the authority. | `""` |
| `assignee_ids` | Array of up to 100 positive numeric IDs, without duplicates. | `[]` |

Example update with concurrency control:

```http
PATCH /api/cards/42
Content-Type: application/json
If-Match: "7"
X-CSRF-Token: <token>

{"start_date":"2026-11-02","due_date":"2026-11-05","blocked_reason":"Waiting for review","actual_minutes":90,"reference_url":"https://example.org/specification","assignee_ids":[3,8]}
```

An authenticated request also needs the session cookie. Empty strings clear text fields. Omitted fields retain their previous values. Invalid dates or types produce `400`; a stale `If-Match` version produces `412`.

## Account assignees and personal tasks

IDs must identify active users who can read the board: global administrators or explicit board members. Validation and writing occur in the card's transaction; an invalid assignee rolls back the entire change. Only an empty array is allowed in `--no-auth` mode.

The legacy `assignee` field, a free-text string, remains independent for compatibility. Account IDs are not inferred from names.

| Method and path | Body / response |
| --- | --- |
| `GET /api/cards/:id/assignees` | `{"assignees":[{"id":3,"name":"Alex","username":"alex"}]}` |
| `PATCH /api/cards/:id/assignees` | Body `{"user_ids":[3,8]}`. Response `{"ok":true,"id":42,"version":8}`. Supports `If-Match`. |
| `GET /api/me/tasks` | `{"cards":[...]}`; each full card also contains `board_id`, `board_name`, `column_title`. |

Full card responses include both `assignee_ids` and `assignees`. Personal tasks include only open, unarchived cards assigned to the current session's user ID, on unarchived boards the user can currently access. They do not use the free-text `assignee` name. Revoking board access immediately hides the related tasks; observers can read their own tasks without gaining write access.

## Dependencies

A dependency `A → B` means B must be completed before A can be completed.

| Method and path | Body / response |
| --- | --- |
| `GET /api/cards/:id/dependencies` | `{"dependencies":[{"id":15,"title":"Review","completed":false}]}` |
| `POST /api/cards/:id/dependencies` | Body `{"required_card_id":15}`. Response `201` with the card's ID and new version. |
| `DELETE /api/cards/:id/dependencies/:required_id` | Removes the link; response `200` with ID and new version. |

Cards must belong to the same board. A self-dependency produces `400`; a direct or indirect cycle produces `409`. Cycle detection occurs in the write transaction: concurrent requests cannot create a cycle.

Completing a card with incomplete dependencies produces `409`. A trashed prerequisite, or one in a trashed list, remains unsatisfied; remove the dependency or restore and complete the prerequisite. An incomplete prerequisite cannot be added to an already completed card. Link changes support `If-Match`, increment the card version, and record board activity.

## Personal templates

A template retains a snapshot taken at creation. Later changes to, or deletion of, the original do not affect it. Listing and instantiation are limited to the owner; the owner or a global administrator can delete a template. Shared operations remain subject to destination permissions.

| Method and path | Body / response |
| --- | --- |
| `POST /api/templates/cards` | `{"card_id":42,"name":"Review card"}` → `201`, `{"ok":true,"id":5}` |
| `GET /api/templates/cards` | `{"templates":[{"id":5,"name":"Review card","created_at":"..."}]}` |
| `POST /api/templates/cards/:id/instantiate` | `{"column_id":9}` → `201`, ID and version of the new card. The server enforces WIP. |
| `DELETE /api/templates/cards/:id` | Deletes the template without deleting cards already created from it. |
| `POST /api/templates/boards` | `{"board_id":2,"name":"Standard project"}` → `201`, template ID. |
| `GET /api/templates/boards` | Same `templates` structure as the card template list. |
| `POST /api/templates/boards/:id/instantiate` | `{"name":"New project"}` or `{}`. Creates a board with lists, WIP limits, and cards from the snapshot. The new board is active and not starred. |
| `DELETE /api/templates/boards/:id` | Deletes the template. |

Templates do not automatically assign source board members to the destination or copy account assignee IDs. Legacy free-text names remain part of the card content. Card templates do not copy dependencies, attachments, comments, activity, or trash.

## Saved filters

| Method and path | Body / response |
| --- | --- |
| `POST /api/boards/:id/views` | `{"name":"Open urgent tasks","filters":{"priority":"urgent","status":"open","sort":"due"}}` → `201`, view ID. |
| `GET /api/boards/:id/views` | `{"views":[{"id":6,"name":"Open urgent tasks","filters":{...}}]}` |
| `PATCH /api/views/:id` | `{"name":"New name"}` and/or `{"filters":{...}}`. When supplied, `filters` replaces the previous object. |
| `DELETE /api/views/:id` | Deletes the personal view. |

The name must contain non-whitespace text and have at most 200 characters. The `filters` object accepts known keys only, without duplicates; every value is a string of up to 200 characters.

| Key | Values accepted by the server |
| --- | --- |
| `search`, `query` | Free text; `query` is a compatibility alias. |
| `label` | `""`, `design`, `sviluppo`, `ricerca`, `marketing`, `urgente` |
| `assignee` | Free-text name or a client filter value. |
| `priority` | `""`, `low`, `normal`, `high`, `urgent` |
| `status` | `""`, `open`, `completed`, `overdue`, `due-soon`, `blocked` |
| `sort` | `manual`, `due`, `priority`, `title`, `created`, `updated` |

These identifiers remain unchanged across interface languages. Persistence does not execute queries or code supplied by the client. The interface offers filters and ordering it can apply; the API stores only values from the allowlist.

## Atomic bulk changes

```http
POST /api/boards/2/bulk
Content-Type: application/json

{"action":"complete","value":true,"cards":[{"id":42,"version":7},{"id":43,"version":12}]}
```

The original actions `complete` and `archive` take a boolean `value`; [planning](API_PIANIFICAZIONE.md) documents the additional `priority`, `labels`, and `milestone` actions introduced in 0.4. Requests contain 1–500 cards, each with a unique ID and a positive integer version. Response: `{"ok":true,"updated":2}`. Authenticated writes also require the session cookie and CSRF token.

All cards must be active and belong to the specified board. Before writing, the server checks every version and the entire requested final state. A stale version produces `412`; unsatisfied dependencies or exceeded WIP produce `409`; an unrelated or inaccessible card produces `404`. On any error, no card changes.

A batch can complete a card and its prerequisites together. Reopening and unarchiving check collective WIP only in affected lists, preventing multiple cards from bypassing the limit when reopened together. Each changed card generates an event; versions, events, and notifications commit in the same transaction. After an ambiguous outcome, retry with the same `Idempotency-Key` and body; current permissions are checked before a stored response is replayed.

## Export, import, and retention

The JSON format remains `openboard`, version `2`, compatible with previous files. The four additional text/numeric planning properties are exported, validated on import, and preserved when boards are copied.

Export includes assignee IDs in card snapshots, but import ignores them: account IDs are not portable between installations and do not automatically grant access to the new board. Reassign account users after import. Copying a card within the same board may retain still-valid assignees; copying or instantiating a board does not copy these relationships.

Board JSON does not contain dependencies, accounts, memberships, sessions, attachments, comments, activity, personal templates, or saved filters. A full application backup preserves these relationships: use SQLite backup in local mode or the PostgreSQL/MongoDB snapshot procedure in the [deployment guide](DEPLOYMENT.md). Trash and archive operations are reversible and do not automatically reclaim physical space. Personal templates and filters are deleted through their respective endpoints; their content remains independent of the originals.

## Verification

[tests/test_productivity.py](../tests/test_productivity.py) checks fields and partial date updates, JSON round trips, the dependency graph and concurrent requests, trashed prerequisites, template snapshots, WIP, filter persistence and isolation, active assignees, access revocation, atomic batches, stale versions, and observer permissions. Earlier domain tests remain part of the full suite.
