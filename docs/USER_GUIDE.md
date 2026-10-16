# User guide

OpenBoard organizes work into boards, lists and cards. Start with a small board and add planning or reporting features as your team needs them. For installation and initial administrator setup, follow [Deployment](DEPLOYMENT.md).

## A first workflow in five steps

1. **Sign in and choose your language.** Use the credentials supplied by your administrator. The language selector is available before and after sign-in. English, Italian, French, Spanish, German, Simplified Chinese and Japanese are supported; changing language does not translate user-written content.
2. **Create or open a board.** Use **New board** in the sidebar and give it a name and description, such as “Website launch”. A newly created board starts with lists in the selected language. If you are an observer, ask a member or administrator to create it.
3. **Share it with your team.** A global administrator creates user accounts through account administration. A global or board administrator then opens the board's **Members and permissions** panel and adds existing active users with the appropriate board role.
4. **Add and move cards.** Use **Add card**, enter a title such as “Draft launch checklist”, and choose a list. Open the card to add a description, checklist, due date, labels and assignees. Move it between lists by dragging it or editing its list. WIP limits can prevent moves that would exceed a list's capacity.
5. **Review progress.** Filter or search the board, use list/calendar views, and mark completed work. Follow a board or card for internal notifications. Use the activity log to inspect changes and the trash to recover supported deleted items.

Labels may vary with the selected language.

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

Search, filters, favorites and personal bookmarks help find work. Board JSON, CSV and iCalendar exports serve different uses. A board export does not include every account or collaboration record and is not an instance backup; administrators should use the [full backup procedure](DEPLOYMENT.md#full-backup).

## Planning, reviews and forms

**Planning:** configure custom fields, estimates, milestones and list WIP limits. Time entries record actual work. Portfolio and reports show the boards you can access, so different users can see different totals.

**Sprints:** plan backlog cards into an iteration, set dates and a goal, then start it. Only one sprint can be active per board. Per-person capacity can be compared with remaining effort. Daily snapshots are captured explicitly; the app does not invent past observations. Closing a sprint retains unfinished cards and history.

**Reviews:** request named reviewers and choose an all-reviewer or any-reviewer approval rule. Reviewers approve or request changes with an explanation. Requesters cannot approve their own requests. Revoked access invalidates the user's previous review decision; being invited again requires a new decision.

**Forms and requests:** build internal forms with typed fields and publish them for authenticated board members. Submissions retain the field schema used when they were sent. Triage requests with notes, then convert an eligible request to a card. Conversion checks permissions and WIP limits. These forms do not grant outsiders access to the board.

## Drafts, conflicts and recovery

The interface keeps recoverable personal drafts for supported editors. When another user changes an item, a version conflict may require reloading current data and reviewing your draft before retrying. Avoid repeatedly submitting an old version. A lost response does not prove that a change failed: refresh or inspect the activity log before repeating it.

For a sign-in failure, a `403` permission error, a `429` retry delay or storage unavailability, see [Troubleshooting](TROUBLESHOOTING.md). Report reproducible problems through the repository's [support guide](../SUPPORT.md); security reports follow the [security policy](../SECURITY.md).
