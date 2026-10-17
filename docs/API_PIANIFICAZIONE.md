# Planning API — OpenBoard 0.4

Features 201–230 add custom fields, milestones, board guidelines and workload reports. Requests use the same session, CSRF protection and board authorization as the other APIs. Writes are transactional: an error rolls back the entire request; observers can read. Numeric IDs are local to the database, while field and milestone keys remain stable in exports.

## Custom fields

- `GET /api/boards/:id/fields` → `{fields:[...]}`. `?include_deleted=1` includes the trash.
- `POST /api/boards/:id/fields` → `201 {ok,id}`. Body: `{key,name,type,options?,position?}`.
- `PATCH /api/fields/:id` → `{ok,id}`. Body: `{name?,position?}`.
- `DELETE /api/fields/:id` hides the definition while retaining card values.
- `POST /api/fields/:id/restore`, with body `{}`, reactivates the definition at the end of the list.

The key is immutable, unique within the board even in the trash, and follows `[a-z][a-z0-9_]{0,39}`. The name contains 1–100 characters, including at least one non-whitespace character. The type and options are also immutable: changing the type could reinterpret existing data. Create a new field for a different structure. `position` is a zero-based index. A board allows 20 active definitions and 100 overall, including deleted definitions.

Each definition returns `{id,key,name,type,options,position,deleted_at}`. Types and values:

| Type | Allowed JSON value |
| --- | --- |
| `text` | Valid Unicode string, at most 2000 characters; no NUL |
| `number` | Finite JSON number between −10¹² and 10¹² |
| `date` | `YYYY-MM-DD` string containing a valid calendar date |
| `boolean` | `true` or `false` |
| `select` | String matching one of the options exactly |

`select` fields require 1–30 distinct options of 1–100 characters each. Other types use an empty array. Duplicate JSON keys, structured values, unknown keys and values of the wrong type return `400`.

Full card responses and card summaries include `custom_values`, an object with stable keys and typed JSON values. The regular card `POST` and `PATCH` endpoints accept `custom_values`. Alternatively:

- `GET /api/cards/:id/fields` → `{values,version}`.
- `PATCH /api/cards/:id/fields` with `{values:{cost:120,approved:false,note:null}}` → `{ok,id,version}`.

Updates are partial merges: omitted fields retain their values and `null` removes a value. `If-Match: <version>` protects against concurrent writes and returns `412` if the version has changed. Only active keys may be submitted; values of deleted fields remain stored and become visible again when the definition is restored. Omit these values when changing another card property.

### Typed field search (unreleased)

`GET /api/boards/:id/field-search?key=approved&value=false` retains the original exact typed comparison. The development branch adds operators, flat combinations and pagination, returning `{cards:[...],next_cursor}`. Card entries are summaries. This read operation requires current board access; observers may use it. Missing/deleted boards and revoked access return `404` before field validation.

For a single condition, use `key`, optional `op` (default `eq`) and `value`. The value is URL-encoded JSON: a string requires quotation marks, for example `%22Italia%22`; booleans and numbers are `false` and `12.5`, not quoted strings. Only active definitions are searchable. Type coercion is not performed, except that equivalent integer and real numbers match.

| Operator | Supported types and behavior |
| --- | --- |
| `eq`, `ne` | All field types; exact typed equality or inequality. A select equality value must be an existing option. `ne` excludes missing and null values. |
| `contains` | Text and select fields; literal, case-sensitive substring matching. The search substring need not be a complete select option. |
| `gt`, `gte`, `lt`, `lte` | Numbers and valid calendar dates of the definition's type. |
| `is_set`, `is_unset` | All types; omit `value` entirely. Missing keys and JSON null are unset; `false`, `0` and `""` are set. |

`eq` with JSON `null` matches an explicitly stored null, not an absent key. Normal updates remove null-valued keys, so this mainly concerns older stored data. `ne` with null matches set, non-null values. Numeric values must be finite and within ±10¹²; text/date/select validation follows the field definition.

For 1–10 conditions, send a URL-encoded `filters` JSON array and `match=all` (default) or `match=any`. Do not combine this form with `key`, `op` or `value`. Conditions are flat objects containing only `key`, `op` and, when required, `value`; nested groups, unknown properties, duplicate JSON keys and unknown/deleted fields return `400`.

```json
[
  {"key":"cost","op":"gte","value":100},
  {"key":"approved","op":"eq","value":true}
]
```

For example, URL-encode that array as the `filters` value in `/api/boards/7/field-search?filters=...&match=all&limit=30`. The decoded `filters` value is limited to 2047 UTF-8 bytes, and HTTP query-length limits still apply. Missing values match `is_unset`; they do not satisfy equality or ordering conditions inside an `all` combination.

Results exclude cards, lists and boards in the trash. Archived cards/boards are excluded unless `include_archived=1`. `limit` defaults to 200 and accepts 1–200. Results are ordered by descending card ID; `before` is a positive decimal card ID excluded from the next page. Use `next_cursor` as `before` with unchanged filters and archive selection; `null` ends pagination. Authorization and live ancestry are rechecked for each request. Invalid/duplicate pagination options return `400`.

The board toolbar exposes one selected custom field and a type-appropriate operator/value control, alongside the existing free-text filter. It filters the board data already loaded by the interface. The 10-condition `all`/`any` form is an API capability; the toolbar is not a multiple-condition builder.

## Milestones

- `GET /api/boards/:id/milestones` → `{milestones:[...]}`.
- `POST /api/boards/:id/milestones` with `{key?,title,due_date?,completed?}` → `201 {ok,id}`.
- `PATCH /api/milestones/:id` with `{title?,due_date?,completed?}` → `{ok,id}`.
- `DELETE /api/milestones/:id` and `POST /api/milestones/:id/restore` with `{}` manage the trash.

The title contains 1–200 characters and cannot consist only of whitespace. The due date is a valid date or `""`; `completed` is a boolean. A key is generated if omitted. Keys follow the same format as field keys and remain immutable and unique even in the trash. Limits: 100 active milestones and 200 overall.

Items return `{id,key,title,due_date,completed,deleted_at,total,done,overdue}`. Counts include cards that are neither archived nor deleted in active lists; `done` counts completed cards. Milestone completion is explicit and independent of card counts. `overdue` is true for an active, incomplete milestone whose due date precedes the server's UTC date. `?overdue=1` filters this report; `?include_deleted=1` includes the trash.

Cards include `milestone_key`. Regular saves accept an active key from the same board; `""` unlinks the card. Deleting a milestone retains its associations for restoration. Subsequent updates must omit an unchanged deleted key, or submit `""` to remove it.

## Bulk actions and guidelines

In addition to completion and archiving, `POST /api/boards/:id/bulk` accepts these actions:

Set priority:

```json
{"action":"priority","value":"high","cards":[{"id":12,"version":3}]}
```

Replace labels:

```json
{"action":"labels","value":["design","ricerca"],"cards":[{"id":12,"version":4}]}
```

Assign a milestone:

```json
{"action":"milestone","value":"release","cards":[{"id":12,"version":5}]}
```

The request accepts 1–500 distinct cards from the board. Every version is checked before writing; a conflict returns `412` and no card is changed. Priorities and labels use the regular API enums. The `labels` action replaces the set and also updates the primary label; `milestone` accepts `""` to unlink cards. The response is `{ok:true,updated:N}`. `Idempotency-Key` uses the same guarantees as other POST requests, including current authorization checks before replay.

`POST /api/boards` and `PATCH /api/boards/:id` accept `guidelines`, Unicode Markdown text up to 10000 characters. The full board response includes it; the interface renders a safe Markdown subset without executing HTML.

## Workload report

`GET /api/boards/:id/workload` returns:

- `total`, `completed`, `blocked` for active, unarchived cards in active lists.
- `estimate_minutes`, `actual_minutes`, `logged_minutes`, `total_minutes`.
- `by_priority`, a priority → count object.
- `by_milestone`, rows containing `key,title,total,completed,estimate_minutes,total_minutes`.
- `cards`, summary details for each card, including priority, milestone, time and blocking reason.

A card is blocked if it has an explicit reason or an incomplete or deleted dependency, including a dependency in a deleted list. `actual_minutes` is the existing manual time. `logged_minutes` sums only active work logs. `total_minutes` is their sum; work logs do not change manual time. Full card responses and summaries also return these last two fields. Totals may exceed the limit of a single work log.

## Export, import and copies

OpenBoard JSON format version 2 remains backward compatible. Exported boards add `guidelines`, `custom_fields` and `milestones`; cards add `custom_values` and `milestone_key`. Deleted definitions are included with `deleted_at`, so hidden values can be restored after transfer. Imports validate types, options, keys, active limits and references before committing. IDs are regenerated; deleted state is retained with a new timestamp. Positions follow the order of the exported definitions. An error in any card rolls back the entire import.

Board copies and templates preserve guidelines, definitions, milestones and values, including hidden ones. Copying a single card retains only values of active fields and an active milestone; a single-card template excludes all custom fields and the milestone association so it can be used on another board. Work logs, comments and reactions are not cloned by the board format: use the dedicated export to transfer time records, or a SQLite backup for complete recovery.

The upgrade to database schema 5 preserves existing data and first creates a `*.pre-v4.bak` backup with `0600` permissions.

## Verification

`tests/test_planning.py` covers all five types, Unicode/NUL and limits, merges and removal, version conflicts, search, deleted/restored fields and milestones, concurrent key creation, atomic imports, copies and templates, bulk operations, workload with logged time, migration from schema 4, and isolation for observers and users without access. The suite also passes with AddressSanitizer and UndefinedBehaviorSanitizer.
