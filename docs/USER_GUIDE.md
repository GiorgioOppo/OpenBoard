# User guide

OpenBoard organizes work into boards, lists and cards. Start with a small board and add planning or reporting features as your team needs them. For installation and initial administrator setup, follow [Deployment](DEPLOYMENT.md).

## A first workflow in five steps

1. **Sign in and choose your language.** Use the credentials supplied by your administrator. The language selector is available before and after sign-in. English, Italian, French, Spanish, German, Simplified Chinese and Japanese are supported; changing language does not translate user-written content.
2. **Create or open a board.** Use **New board** in the sidebar and give it a name and description, such as “Website launch”. A newly created board starts with lists in the selected language. If you are an observer, ask a member or administrator to create it.
3. **Share it with your team.** A global administrator creates user accounts through account administration. A global or board administrator then opens the board's **Members and permissions** panel and adds existing active users with the appropriate board role.
4. **Add and move cards.** Use **Add card**, enter a title such as “Draft launch checklist”, and choose a list. Open the card to add a description, checklist, due date, labels and assignees. Move it between lists by dragging it or editing its list. WIP limits can prevent moves that would exceed a list's capacity.
5. **Review progress.** Filter or search the board, use list/calendar/table views, and mark completed work. Follow a board or card for internal notifications. Use the activity log to inspect changes and the trash to recover supported deleted items.

Labels may vary with the selected language. The unreleased development interface changes language without reloading. Use the selector in the header or an editor/panel dialog; unsaved fields and drafts remain in place. Switching does not save them. Language is still a browser preference, with no account synchronization.

The unreleased interface adds a command palette (`Ctrl`/`Command` + `Shift` + `P`), monthly/weekly calendar navigation and a personal center for saved card drafts. Open these through the account panel; drafts still require current server access when reopened. Arrow keys and Home/End navigate card controls. Signing out in one tab also invalidates the interface in the account's other tabs. `?pseudo=1` is a developer text-expansion mode; it does not translate user content or add a supported language.

## Accounts and permissions

Global account roles and board memberships are separate. A board's display label does not make its data anonymously accessible.

| Role | What it allows |
| --- | --- |
| Global administrator (`admin`) | Administers accounts and accesses all boards, including board membership management. |
| Global member (`member`) | Creates boards and accesses boards where they are a member. Their board role determines whether they can edit or manage membership. |
| Global observer (`observer`) | Reads boards where they have membership. They cannot gain board editing rights by receiving a higher board role. |
| Board administrator (`admin`) | For an eligible global member, edits that board and manages its members. |
| Board member (`member`) | For an eligible global member, reads and edits that board. |
| Board observer (`observer`) | Reads that board without editing its shared data. |

Creating a board grants its creator board administrator membership. Individual actions may have additional permission requirements. If access is revoked, the server applies the change to later requests, even if the browser still shows older content. Account preferences and personal collections are distinct from shared board edits.

Use the account menu to change your display name, update your password or revoke other sessions. Sign out on a shared device. There is no anonymous public form submission or public self-registration workflow; ask an instance administrator for account access.

## Everyday collaboration

Cards support multiple assignees, checklist items, comments and replies, reactions, dependencies, attachments and time entries. Dependencies reject cycles. Use the card's activity history for context. Supported attachments are limited to 10 active files per card, 1 MiB each and 5 MiB total. Internal notifications are available in OpenBoard; do not assume email or push delivery.

In unreleased builds, administrators can open **Account → Capacity and retention** and explicitly refresh the installation inventory. Optional installation limits count decoded attachment bytes and all retained files, including trash. Deleting a file into trash does not free this quota. A quota rejection preserves existing files; restoring them does not consume the quota a second time. The panel also displays local cache measurements and history counts. Unknown measurements are shown as unavailable. These values do not measure total PostgreSQL/MongoDB disk usage or unused MongoDB documents.

Search, filters, favorites and personal bookmarks help find work. Board JSON, CSV and iCalendar exports serve different uses. A board export does not include every account or collaboration record and is not an instance backup; administrators should use the [full backup procedure](DEPLOYMENT.md#full-backup).

## Finding work (unreleased)

Global search now covers cards, comments/replies, internal requests and their answers/notes, and forms. Choose a content type to narrow the results, then use **Load more** for another page. Results include an excerpt in the original spelling and open the relevant card, conversation, request or form. Only content you can currently read is returned. Unicode case folding and canonical NFC equivalence let `STRASSE` find `Straße` and recognize equivalent accent encodings. Accents remain significant: `cafe` does not find `café`. This remains substring search, without stemming, relevance ranking or transliteration. Attachments, checklist items and custom fields are not included. The current-board free-text filter retains its previous browser matching behavior.

To filter a custom field on the current board, select the field in the planning toolbar, choose an operator and enter a value. Number/date fields support comparisons; text/select fields support exact substring matching; booleans use **Yes/No**. **Set/Unset** require no value: zero, false and an empty text value count as set. Exact substring matching is case-sensitive. **Free search** retains the existing descriptive text filter. Invalid typed input displays an error and does not silently remove the filter. The toolbar applies one custom-field condition to the loaded board; API integrations can combine up to ten conditions with all/any matching.

## Editing the table (unreleased)

Open the board's **Table** view and select **Edit row**. Members with current write access can change the title, priority, due date and estimate in minutes. Other fields remain readable here and can be changed through their existing editors. A title must contain 1–300 characters; estimates are whole minutes from 0 to 100000.

**Save** sends the four fields together. **Cancel** closes the row editor and keeps its draft for later. Drafts are separated by account, board and card on this browser; **Resume draft** reopens one. Filtering, changing view or a background refresh preserves the values and their original server version. An edited row hidden by filters remains available below the visible results. If browser storage is unavailable, an explicit warning explains that values survive only in memory while the page stays open.

If the server version changes, the draft stays visible and further saves are blocked. **Reload current version** asks for confirmation and replaces the draft only after a successful authorized read. Preserve any text you want to keep before accepting. An uncertain save result also requires an explicit reload before another save. Access revocation or a deleted card prevents editing and keeps the draft; a cached row never grants permission to write. Another tab's changed draft is not silently overwritten or removed.

## Board timeline (unreleased)

Choose **Timeline** to read card schedules by week or month. Select a reference date, move to the previous/next period or use **Today**. The date window uses UTC and supports years 1–9999. Existing board filters apply. Cards with both start and due dates show their actual interval; a start-only or due-only card shows a labeled anchor, without inventing a duration. Cards without dates or with invalid date pairs appear in a separate table.

Each table displays at most 100 cards per page, with separate page controls for scheduled and undated cards. Cards outside the current period are counted. This bounds the rendered rows; it is not virtual scrolling or a large-board capacity guarantee. Tables retain readable date text, keyboard focus and card links. Arrow keys and Home/End move between card-title controls. Observers with board access can use this view.

The dependency column links visible prerequisites and displays at most three links per card plus a remaining count. One board request reads at most 2000 dependency edges; a warning identifies a truncated graph. **Refresh dependencies** retries or refreshes that read. Dates and edges are read separately, so they may reflect different moments; refresh the board to realign them. Permission failures hide the stale card rows. The timeline never changes dates automatically; open a card's normal editor to make an authorized change.

## Importing a board (unreleased)

Open **Import** and select **OpenBoard JSON**, **Trello JSON** or **CSV**, then choose a local UTF-8 file of at most 2 MiB. You need permission to create a board. JSON formats prepare their preview after the file is read. For CSV:

1. Enter the new board name, choose comma or semicolon, and indicate whether the first row contains headers.
2. Map distinct source columns to the supported fields. A title column is required; list, description, due date, priority, descriptive assignee and estimate are optional. The first source column is initially selected for the title.
3. Select **Prepare CSV preview**, review counts and conversion warnings, then confirm **Import as new board**.

Changing the file, format or CSV settings invalidates the previous confirmation. Reading, mapping and previewing a file do not create anything on the server. Confirmation submits one OpenBoard-format payload to the authenticated import API. The server creates a new board atomically; an invalid column/card rolls back the whole import. This does not merge into an existing board or replace the source.

| Format | Preserved or converted | Important omissions |
| --- | --- | --- |
| OpenBoard JSON | Supported version 2 board fields, lists, cards and planning data | A board export is not an account, collaboration-history or installation backup. |
| Trello JSON | One exported board with lists/cards, descriptions, supported dates, completion, archive state and flattened checklist groups | Comments, activity/history, attachments, custom fields, covers and integrations are omitted. Labels become description text; members become descriptive text without creating accounts, roles or assignments. |
| CSV | One card per data row; rows grouped by list, with mapped title/description/date/priority/assignee/estimate | Unmapped columns are omitted. Assignees remain text, and no accounts or actual assignments are created. |

Trello expects the single-board JSON export structure, with optional board-level checklists, members and labels. Expanded per-card API checklist objects are not supported. Positions are used when consistently present; otherwise source order is retained. Multiple checklist groups become one checklist, preserving group names in the text. Dates with times retain their UTC day, omitting time and reminders. Archived lists remain present with their cards archived. There is no Trello sign-in, synchronization or attachment download.

CSV supports quoted cells, escaped quotes, multiline text, optional headers and a UTF-8 BOM. Rows must have the same width, up to 100 columns; enabled headers must be nonempty and unique. Dates use `YYYY-MM-DD`, priorities use `low`, `normal`, `high` or `urgent`, and estimates are whole minutes from 0 to 100000. Formula-like strings remain text and are never executed by the importer. Empty/unmapped list values use the default imported list.

Conversion allows at most 100 lists, 10,000 cards and 100 combined checklist items per card. The converted payload must also fit 2 MiB and the normal field limits; added checklist/label text can cause a formerly smaller source to exceed them. Check conversion warnings before confirming. These are bounded migration helpers, not complete Trello compatibility or an instance restore procedure.

## Planning, reviews and forms

**Planning:** configure custom fields, estimates, milestones and list WIP limits. Time entries record actual work. Portfolio and reports show the boards you can access, so different users can see different totals.

**Sprints:** plan backlog cards into an iteration, set dates and a goal, then start it. Only one sprint can be active per board. Per-person capacity can be compared with remaining effort. Daily snapshots are captured explicitly; the app does not invent past observations. Closing a sprint retains unfinished cards and history.

**Reviews:** request named reviewers and choose an all-reviewer or any-reviewer approval rule. Reviewers approve or request changes with an explanation. Requesters cannot approve their own requests. Revoked access invalidates the user's previous review decision; being invited again requires a new decision.

**Forms and requests:** build internal forms with typed fields and publish them for authenticated board members. Submissions retain the field schema used when they were sent. Triage requests with notes, then convert an eligible request to a card. Conversion checks permissions and WIP limits. These forms do not grant outsiders access to the board.

## Drafts, conflicts and recovery

The interface keeps recoverable personal drafts for supported editors. When another user changes an item, a version conflict may require reloading current data and reviewing your draft before retrying. Avoid repeatedly submitting an old version. A lost response does not prove that a change failed: refresh or inspect the activity log before repeating it.

In unreleased builds, the full-card editor's **Compare with server version** displays the initial snapshot, your draft and the latest readable server values. Independent changes merge automatically. For a field changed differently on both sides, explicitly choose **Your draft** or **Server version**. Checklist, assignees and primary/additional labels remain indivisible groups; custom values are compared individually. A legacy draft without a verified initial snapshot requires an explicit choice for every difference.

**Apply preview to editor** rechecks current permissions and the server version, validates the combined values, then updates only the local editor and its draft. Review it and explicitly **Save** to submit the change with the reviewed version. If the server or draft changes again, reload the comparison; your draft is retained. Removed lists or invalid combined dates/custom values prevent application. A further server edit after applying the preview can still cause a save conflict. This comparison covers the full-card form's editable fields, not comments, attachments or every collaboration record.

For a sign-in failure, a `403` permission error, a `429` retry delay or storage unavailability, see [Troubleshooting](TROUBLESHOOTING.md). Report reproducible problems through the repository's [support guide](../SUPPORT.md); security reports follow the [security policy](../SECURITY.md).
