# Reviews and approvals — OpenBoard 0.5

Review requests belong to a card and follow the card's current board. The endpoints require an authenticated account, including on local installations started with `--no-auth`: they return `403` in that mode. Anonymous requests in authenticated mode return `401`; all mutations require the CSRF token and origin checks already applied by the router. The static frontend obtains enums and canonical labels from `/api/catalog` (`review_statuses`, `review_policies`, `review_decisions`), translates those labels using its bundled catalogs, and obtains data and permissions from the APIs.

## Backend features 301–325

| ID | Feature | Method and path |
|---|---|---|
| 301 | Request with a title, description and due date | `POST /api/cards/{card}/reviews` |
| 302 | Selection of 1–20 active board reviewers | `reviewer_ids` on creation and replacement |
| 303 | Approval by all reviewers or at least one | `policy: "all"` or `"any"` |
| 304 | Card review list | `GET /api/cards/{card}/reviews` |
| 305 | Details with reviewers and individual votes | `GET /api/reviews/{id}` |
| 306 | Updating the title, description, due date and policy | `PATCH /api/reviews/{id}` |
| 307 | Replacing reviewers and clearing votes | `PATCH /api/reviews/{id}/reviewers` |
| 308 | Approval with an optional note | `POST /api/reviews/{id}/vote`, `decision: "approved"` |
| 309 | Requesting changes with a required note | Same endpoint, `decision: "changes_requested"` |
| 310 | Withdrawing your own vote | `DELETE /api/reviews/{id}/vote` |
| 311 | Cancelling the request | `POST /api/reviews/{id}/cancel` |
| 312 | Reopening and clearing votes | `POST /api/reviews/{id}/reopen` |
| 313 | Recoverable deletion | `DELETE /api/reviews/{id}` |
| 314 | Restoration | `POST /api/reviews/{id}/restore` |
| 315 | History with cursor | `GET /api/reviews/{id}/history` |
| 316 | Board inbox with status filtering | `GET /api/boards/{board}/reviews` |
| 317 | Personal inbox of assigned requests | `GET /api/me/reviews` |
| 318 | Overdue request filter | `overdue=1` |
| 319 | Reviewer filter | `reviewer_id={user}` |
| 320 | Requester filter | `requester_id={user}` |
| 321 | Aggregate status prioritizing requested changes | `status` calculated from current permissions |
| 322 | Board counts | `GET /api/boards/{board}/review-stats` |
| 323 | CSV export with formula neutralization | `GET /api/boards/{board}/review-export` |
| 324 | Card counts | `GET /api/cards/{card}/review-summary` |
| 325 | Copying to a card on the same board without votes | `POST /api/reviews/{id}/duplicate` |

## Permissions and aggregate status

Reading requires current board access and non-deleted ancestors: the card, list and board must not be deleted. Observers can read. The requester, global administrator and board administrator may manage a request only while they also have write access; a requester demoted to observer therefore loses management permission. An unrelated or hidden resource returns `404`; unauthorized management of a readable resource returns `403`.

Reviewers must be active accounts, actual board members with role `member` or `admin`, and have a global role other than `observer`. The requester cannot select themselves or vote on their own request. A global administrator can review only if they also hold actual board membership. Voting and withdrawing a vote require a currently valid reviewer selection; each account changes only its own vote.

Status is calculated for each request, without storing an aggregate approval that could become stale:

1. If cancelled, `cancelled`.
2. If at least one currently eligible reviewer requests changes, `changes_requested`.
3. With policy `any`, at least one valid approval produces `approved`.
4. With policy `all`, every selected reviewer must have a valid approval.
5. Otherwise, `pending`.

Removing a member does not reduce the number of required approvals: an `all` request remains pending until its manager replaces the reviewers. Removal from the board, demotion to observer and deactivation also invalidate stored votes; reinvitation or reactivation does not restore old approvals. Role and status changes increment the request version and record a system event. Eligibility is still checked dynamically, including when a card changes boards.

`overdue` is true when the due date precedes the current UTC date and status is `pending` or `changes_requested`. An approved or cancelled request is not overdue for counting purposes.

## Creation and details

Creation example:

```http
POST /api/cards/42/reviews
Content-Type: application/json
X-CSRF-Token: <token di sessione>
Idempotency-Key: revisione-accessibilita-42
```

```json
{
  "title": "Verifica accessibilità",
  "description": "Controllare tastiera e contrasto prima della consegna.",
  "due_date": "2026-11-10",
  "policy": "all",
  "reviewer_ids": [7, 12]
}
```

`title` is required, cannot consist only of whitespace, and has at most 200 characters. `description` is optional, with at most 4000 characters. `due_date` is optional: a real `YYYY-MM-DD` date with a year of at least 1900, or an empty string. `policy` is optional and defaults to `all`. `reviewer_ids` must be an array of 1–20 distinct positive integer IDs; strings, decimals, booleans, ineligible members and the requester are rejected with `400`.

Creation and copying return `201`; other mutations return updated details with `200`. Details contain:

```json
{
  "id": 3,
  "card_id": 42,
  "board_id": 2,
  "card_title": "Schermata di accesso",
  "requester_id": 1,
  "requester": "Amministratore",
  "title": "Verifica accessibilità",
  "description": "Controllare tastiera e contrasto prima della consegna.",
  "due_date": "2026-11-10",
  "policy": "all",
  "status": "pending",
  "version": 1,
  "created_at": "2026-10-16T10:00:00.000Z",
  "updated_at": "2026-10-16T10:00:00.000Z",
  "cancelled_at": null,
  "deleted_at": null,
  "overdue": false,
  "reviewer_count": 2,
  "approved_count": 0,
  "changes_count": 0,
  "can_manage": true,
  "can_vote": false,
  "reviewers": [
    {"user_id": 7, "name": "Anna", "username": "anna", "eligible": true,
     "decision": null, "note": "", "voted_at": null},
    {"user_id": 12, "name": "Luca", "username": "luca", "eligible": true,
     "decision": null, "note": "", "voted_at": null}
  ]
}
```

`reviewers` is ordered by user ID. `eligible` indicates current reviewer eligibility, and `can_manage`/`can_vote` describe the reading user's permissions. Deleted reviews are excluded from regular details; `GET /api/reviews/{id}?include_deleted=1` allows reading an item for restoration while retaining the same ACL checks.

## Updates and lifecycle

`PATCH /api/reviews/{id}` accepts at least one of `title`, `description`, `due_date` or `policy`. Empty strings clear the description or due date but are invalid for the title or policy. Changing policy clears previous votes. Replacing reviewers requires `{"reviewer_ids":[7,15]}` and clears all votes, even if some reviewers remain selected.

`POST /api/reviews/{id}/vote` accepts `{"decision":"approved","note":"Verificato"}` or `{"decision":"changes_requested","note":"Correggere il contrasto"}`. `note` has at most 2000 characters and, in the second case, must contain non-whitespace text. A new vote replaces the same user's previous vote. `DELETE /vote` without an existing vote returns `409`. Cancelled requests do not accept votes and return `409`.

The `cancel`, `reopen` and `restore` endpoints use POST with a JSON object, including `{}`. Cancelling an already cancelled request or restoring an already active one returns `409`. Reopening clears all votes and removes cancellation; it may also be used to reset a request that is still open. Deletion retains the request, reviewers, votes and history; the item accepts neither updates nor votes until restored. Restoration does not reopen a cancelled request.

All mutations of an existing request accept `If-Match: "version"` or an unquoted positive number. A stale version returns `412`; a malformed value returns `400`. The frontend always sends the version it read. A successful update increments `version`, updates `updated_at`, records history and updates the board version. Copying checks the source version and creates a request at version 1 without changing the source.

`POST /api/reviews/{id}/duplicate` requires `{"card_id":43}`. The destination must be a non-deleted card on the same board, otherwise `404` is returned. The new requester is the user making the copy; only currently eligible reviewers other than the new requester are copied. Votes, cancellation and deletion are not copied. If no reviewer remains, the response is `409`.

## Lists and history

Card, board and user lists return `{items,next_cursor}`. The personal inbox includes requests where the user is selected as a reviewer and retains only boards that remain readable; it is not a list of requests created by that user.

| Parameter | Meaning |
|---|---|
| `status` | `pending`, `approved`, `changes_requested`, `cancelled`; omitting it means all. |
| `overdue` | `1` restricts results to overdue requests; `0` does not restrict them. |
| `reviewer_id` | Positive integer ID of a selected reviewer. |
| `requester_id` | Positive integer ID of the requester. |
| `include_deleted` | `1` also includes deleted items; default `0`. |
| `limit` | From 1 to 100; default 30. |
| `before` | Positive ID: returns items with a lower ID. |

Invalid IDs, textual booleans and statuses return `400`; flags accept only `0` or `1`. Results are ordered by descending ID; `next_cursor` is the last ID on the page when more results exist, otherwise `null`. Keep the same filters for subsequent pages.

`GET /api/reviews/{id}/history` uses the same `before` and `limit`, with the same limits and order, and can read the history of deleted requests. Every event contains `{id,review_id,actor_id,actor,subject_id,action,decision,note,created_at}`. Actions are `review_created`, `review_edited`, `review_reviewers_changed`, `review_voted`, `review_vote_withdrawn`, `review_cancelled`, `review_reopened`, `review_deleted`, `review_restored`, `review_duplicated` and `review_eligibility_changed`.

System events for eligibility changes have `actor: "Sistema"`, `actor_id: null` and the affected reviewer's `subject_id`, distinguishing the subject from the person who administered the account. Regular events retain the author's name at the time of the action; `subject_id` is `null`.

## Counts, CSV and limits

Card and board counts return `{total,pending,approved,changes_requested,cancelled,overdue}`. They count all active reviews in their scope without applying filters or cursors, excluding deleted reviews and ancestors.

`GET /api/boards/{board}/review-export` accepts the same filters as lists and returns `{filename,csv,truncated:false}`. The export includes all filtered rows up to 1000 without applying `before`/`limit` pagination. More than 1000 rows or a response larger than 2 MiB returns `413`, without delivering partial CSV output. Narrow the filters in this case.

The CSV contains `id,card_id,card_title,title,description,requester,status,policy,due_date,reviewer_count,approved_count,changes_count`, with a comma separator and CRLF endings. All free-text cells are quoted, quotation marks are doubled, and formula prefixes `=`, `+`, `-` and `@`, including after spaces, tabs or newlines, are neutralized with an apostrophe. Enum and date fields are validated by the backend. Authenticated responses retain `Cache-Control: no-store`.

At most 200 reviews per card, including deleted reviews, and 10000 events per request are allowed. Creation, copying or mutations beyond their respective limits return `409`. Permission revocations continue to invalidate votes and update the version even when history has reached its limit; no further automatic event is added in that case.

Mutations use the router transaction: validation, votes, version, history and activity are saved together or rolled back. POST requests support the router's global idempotency; a retry with the same user, path, key and body returns the original result only after checking current authorization, including reviewer eligibility for votes. A different body with the same key returns `409`. Persistence errors return `503` without leaving partial votes or versions.

SQLite migration 6 adds `reviews`, `review_members`, `review_votes`, `review_events`, two views for eligibility and aggregates, and invalidation triggers. All review data is relational; external storage retains it in PostgreSQL without adding artificial JSON documents to MongoDB.

Verification: `tests/test_reviews.py` exercises all 25 features with real sessions, revocations and reinvitations, global and board roles, prevention of self-approval, versions, filters and cursors, hostile CSV input, idempotency, quotas and an injected history error to verify atomic rollback. `tests/test_security_domain.py` additionally verifies that a vote replay is rejected after reviewer eligibility is removed.
