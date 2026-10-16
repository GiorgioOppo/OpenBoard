# Internal forms and requests API — OpenBoard 0.6

Requests collect board members' needs before creating a card. All APIs require an authenticated account and current board membership; global administrators retain access. Routes also return `403` in local `--no-auth` mode. These are not public forms, do not send email and do not place credentials in the frontend.

Mutations use a session and `X-CSRF-Token`. `If-Match: "version"` is optional for API clients and is sent by the frontend; a stale version returns `412`, and a malformed header returns `400`. POST operations support global idempotency with `Idempotency-Key`: repeating the key and payload returns the same result without duplicating records, after current authorization is checked. Every write, history event and card conversion participates in the same transaction: a failure rolls back all changes.

## Permissions

| Operation | Access |
| --- | --- |
| Read active forms, requests, notes and history | Current members, including observers; global administrators |
| Create/update/publish/trash/restore forms and fields | Board administrators with a global role that allows writing; global administrators |
| Submit a request | All current members, including observers, on a published form |
| Update the title/answers | Author only, while the state is `new` or `in_review`, with no converted card |
| Add notes | Author or board members with write access |
| Change state and convert | Board members with write access |
| Trash/restore a request | Author or board members with write access |

Every read rechecks membership and the active board. A request whose form or board is in the trash is not returned, even in personal lists. Removing a member revokes access immediately, including with an already open session. Pausing a form blocks new submissions while keeping existing requests readable.

## Forms: features 426–432

| Method and path | Payload / result |
| --- | --- |
| `POST /api/boards/:board/intake/forms` | `{name, description?, column_id}` → form, `201` |
| `GET /api/boards/:board/intake/forms` | `{items: [...], next_cursor: id|null}` |
| `GET /api/intake/forms/:id` | Form and ordered active fields |
| `PATCH /api/intake/forms/:id` | At least one of `{name, description, column_id}` |
| `POST /api/intake/forms/:id/publish` | `{}` → publishes the form |
| `POST /api/intake/forms/:id/pause` | `{}` → pauses submissions |
| `DELETE /api/intake/forms/:id` | Trash; retains fields, answers and history |
| `POST /api/intake/forms/:id/restore` | `{}` → restores the form |

A form contains `id`, `board_id`, `name`, `description`, `column_id`, boolean `published`, `version`, `created_at`, `updated_at`, `deleted_at`, boolean `can_manage` and `fields`. The name has 1–200 characters and cannot consist only of whitespace; the description has up to 4000 characters. The destination must be an active column on the same board. At most 100 forms are allowed per board, including trashed forms. If a column is permanently removed, the destination becomes `null`, the form version increases, and history records `target_column_removed`: the form and requests remain readable. An administrator must select a new active column before publishing again or converting requests.

Lists support a positive `before` ID and `limit=1..100` (default 30), in descending ID order. `include_deleted=1` in form lists and details is restricted to administrators and also includes trashed fields. Members and observers should use details without this parameter.

## Fields: features 433–437

| Method and path | Payload / result |
| --- | --- |
| `POST /api/intake/forms/:id/fields` | `{key, name, type, required?, options?}` → field, `201`; form `If-Match` |
| `PATCH /api/intake/fields/:id` | At least one of `{name, type, required, options}`; field `If-Match` |
| `POST /api/intake/forms/:id/fields/reorder` | `{field_ids: [id,...]}`: every active field exactly once; form `If-Match` |
| `DELETE /api/intake/fields/:id` | Trashes the field; field `If-Match` |
| `POST /api/intake/fields/:id/restore` | `{}`; field `If-Match` |

A field contains `id`, `key`, `name`, `type`, boolean `required`, array `options`, `position`, `version` and `deleted_at`. The immutable key follows `[a-z][a-z0-9_]{0,39}`; `constructor`, `prototype` and `__proto__` are forbidden. Keys remain unique within the form even after trashing. Names have at most 200 characters; at most 20 fields may be active. Restoring beyond this quota returns `409`.

Allowed types are `text`, `number`, `date`, `boolean` and `select`, also supplied by `/api/catalog`. `required` accepts JSON booleans, not numbers. `select` fields require 1–30 distinct non-empty text options of up to 400 bytes each; other types require empty options. When changing a select field to another type, also send `options: []`. Every field change increments its version and the form version.

## Submission, inbox and details: features 438–441

| Method and path | Payload / result |
| --- | --- |
| `POST /api/intake/forms/:id/requests` | `{title, answers: {key: typedValue}}` → request, `201`; form `If-Match` |
| `GET /api/boards/:board/intake/requests` | Paginated board inbox |
| `GET /api/me/intake/requests` | Only the author's requests, rechecking current access |
| `GET /api/intake/requests/:id` | Request, answers, historical schema and notes |

The title has 1–300 characters and cannot consist only of whitespace. `answers` is a JSON object of up to 50000 bytes containing only active field keys. The server rejects duplicate or unknown properties, wrong types, null values and non-finite values. Text: up to 8000 bytes; JSON numbers preserve `0`; booleans preserve `false`; dates are real `YYYY-MM-DD` dates; choices must be present in the options. A required field must be present; required text cannot consist only of whitespace, while `false` and `0` are valid answers. An optional date may be an empty string. At most 10000 requests are allowed per board, including trashed records.

Submission saves an immutable copy of the ordered fields in `schema_snapshot`, the JSON answers and `form_version`. Subsequent field changes do not alter history. If the client sends `If-Match`, submitting against a changed form returns `412` before validating answers.

A request contains `id`, `form_id`, `form_name`, `board_id`, `author_id`, `author`, `title`, `answers`, `schema_snapshot`, `state`, `converted_card_id`, boolean `converted_card_available`, `version`, `form_version`, boolean `form_changed`, timestamps, `deleted_at`, `can_triage`, `can_edit`, `notes_count` and, in details, `notes`. `form_changed` indicates form changes after submission. The frontend uses the historical schema for existing requests.

Board and personal lists omit note bodies and include only `notes_count`, so their payload does not grow with the discussion. Complete notes remain available in details and the dedicated endpoint.

Lists support `before`, `limit`, `state=new|in_review|accepted|rejected`, a `q` search string of up to 200 characters, and `include_deleted=0|1`. Search covers the title, author and form name; `%` and `_` are literal characters. Trashed records are returned only to their author or members with write access; details explicitly require `?include_deleted=1`.

## Management and conversion: features 442–447

| Method and path | Payload / result |
| --- | --- |
| `POST /api/intake/requests/:id/state` | `{state: "new"|"in_review"|"accepted"|"rejected"}` |
| `POST /api/intake/requests/:id/notes` | `{body}` → updated details, `201` |
| `GET /api/intake/requests/:id/notes` | `{items: [note,...]}` in chronological order |
| `PATCH /api/intake/requests/:id` | At least one of `{title, answers}`; author only and an editable state |
| `POST /api/intake/requests/:id/convert` | `{description?: string}` → details with `converted_card_id` |
| `DELETE /api/intake/requests/:id` | Trashes the request |
| `POST /api/intake/requests/:id/restore` | `{}` → restores the request |

Notes are append-only, with author and date, up to 2000 characters each; at most 1000 per request. Answer updates are validated against **the original schema**, even if the form has changed, is paused or a field has been removed. A member with write access may return an accepted or rejected request to review before the author edits it.

Conversion requires state `accepted`, an active destination and write permission. It creates one card with the request title and a description derived from the historical schema's names and answers, preserving `false` and `0`. It respects the quotas, WIP limits, ACLs and events of regular card creation. Without an explicit description, derived text longer than 10000 bytes returns `413` without creating cards. The client may send `description` up to 10000 characters for an explicit summary; complete answers remain on the request. They are not silently truncated.

Card creation and association with the request are atomic: even a failure during association rolls back the card. A second conversion without idempotent replay returns `409`. After conversion, the request title, answers and state cannot be changed; notes and trash remain available. Trashing the request does not trash the created card. `converted_card_id` remains an immutable historical reference without a foreign-key constraint, even if the card is permanently deleted; the request does not become convertible again and remains included in converted counts. `converted_card_available` is true only when the card, column and board are active and the card still belongs to the same board: the frontend avoids unavailable links or links to other boards.

## History, statistics and export: features 448–450

| Method and path | Result |
| --- | --- |
| `GET /api/intake/requests/:id/history` | `{items, next_cursor}`: events with author, action, date and note |
| `GET /api/intake/forms/:id/history` | History of the form and its requests |
| `GET /api/boards/:board/intake/stats` | Counts: `total`, `new`, `in_review`, `accepted`, `rejected`, `converted` |
| `GET /api/boards/:board/intake/export` | UTF-8 CSV download with JSON answers/schema preserving their types |

History uses the same `before` cursor and `limit=1..100`, and is also available in the trash to people authorized to read the deleted record. Mutations record creation, updates, publication, pauses, field management, submission, notes, state, conversion, trash and restoration. Statistics and CSV exclude trashed requests or forms.

The CSV contains `id,form,author,title,state,answers_json,schema_snapshot_json,converted_card_id,created_at`, with correct quoting for commas, quotation marks and newlines. Text that could be interpreted as a formula is prefixed with an apostrophe; JSON documents remain valid and retain the original answers. The limit is 1000 requests or 2 MiB: exceeding it returns `413`, without a partial export.

## Verification

`tests/test_intake.py` covers all 25 capabilities 426–450, including current and revoked permissions, the observer role, CSRF, optimistic concurrency, schema evolution, leap dates, `false`/`0`, quotas, idempotency, transactional errors after card creation, WIP limits, trash, cursors and safe CSV. All test data is temporary.
