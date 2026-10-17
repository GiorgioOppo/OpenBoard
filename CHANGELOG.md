# Changelog

Version sections describe the code's development history. They do not imply that a corresponding GitHub release or tag has been published. See [GitHub releases](https://github.com/GiorgioOppo/OpenBoard/releases) for published artifacts.

## Unreleased

Add Unicode NFC/full-case-folding to both global substring search APIs, preserving accents and original snippet text without stemming or ranking. Bundle unmodified utf8proc with immutable source provenance and offline hash checks; leave the browser's current-board filter semantics unchanged. Add a read-only UTC week/month timeline, explicit partial-date anchors, bounded row pages and one authorized board dependency read capped at 2000 edges. Dates and edges remain separate reads without an atomic snapshot guarantee. Add full-card three-way conflict comparison: apply a reviewed preview to the local draft, then explicitly Save with `If-Match`.

Add three native libFuzzer targets exercising real HTTP parsing, JSON validation and Unicode search/excerpt code under sanitizers, with synthetic bounded inputs and source/binary hashes. Local campaigns have run; see [Fuzzing](docs/FUZZING.md) for measured evidence and limits. The new fifth CI job has not run remotely. These four changes postdate the last successful remote run and are not a security certification or real-browser end-to-end validation.

Add collaborative search across authorized cards, comments/replies, requests/answers/notes and forms, with typed result keys and stable cursors. Extend custom-field search with typed comparisons, set/unset semantics, pagination and up to ten flat all/any conditions; expose one typed condition in the board toolbar. Add bounded local Trello JSON and mapped CSV conversion with previews and omission warnings, followed by the existing authenticated atomic import. Add explicit table-row editing for title, priority, due date and estimate, with version/permission checks, isolated drafts and guarded refreshes. These additions passed all four jobs of [CI run 39030617497](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39030617497) at `25da2ba`, including container integration. That run predates the Unicode/timeline/merge/fuzz changes above; a complete real-browser end-to-end session remains outstanding.

Add an administrator storage panel and API, retained-file count/payload quotas that include trash, history accounting, configurable cache tmpfs sizing, SQLite page limits and minimum-free-space write admission. Preserve existing files when quotas are lowered. Add bounded Prometheus response/latency histograms, storage-operation timing/errors and confirmed publication-row counters. Local and offline-driver regressions cover quotas, rollback, pressure and telemetry. The preceding storage/backup block passed [CI run 39020804975](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39020804975) at `5688602`, including native/sanitizer checks, candidate image builds, real-store scenarios and disposable application recovery. Proxy recovery remains a synthetic archive check; external capacity and operational recovery objectives remain unmeasured.

Refresh the pinned MongoDB `8.0.34-noble` multi-platform base image to the upstream rebuild published on 2026-10-17. Preserve MongoDB 8.0.34, its data format and the existing rebuilt tools and hardening. The OCI base-digest label follows the new pin. Historical audit measurements and the published `v0.6.1` tag continue to identify their original artifacts.

Begin the [next 100 improvements](docs/IMPROVEMENTS_NEXT_100.md), recording completed, partial and outstanding scope explicitly. Publish changed SQL rows and verify reused MongoDB documents; retain serialization and full stale-cache reconstruction. Coalesce session activity, add opt-in idempotency retention and private file-backed storage credentials, and invalidate review votes atomically after relevant card-content edits.

Add paginated global search, a contextual command palette, month/week calendar, card draft center, browser-tab logout coordination and keyboard/field-error/forced-color/IME improvements. Add pseudolocalization without changing user content. Extend backup tooling with verified manifests, standard CMS encryption, retention/scheduling and isolated installation recovery tools. Pin the remaining Docker bases, configure disposable cloud CI and add a bounded local benchmark with explicit budgets. Running-proxy/certificate recovery, fresh image scans, external capacity and the remaining enterprise features are not claimed complete.

## 0.6.1 — 2026-10-16 (Early preview)

Prepare the repository for public contributions: consolidate English documentation, document architecture and everyday workflows, add troubleshooting and community guidance, record third-party licensing, and distinguish historical improvement checklists from current operating instructions.

Remediate the audit's proxy and database dependency findings with patched, pinned base images and rebuilt Go tools. Replace shared authentication quotas with bounded per-client counters; explicitly trust the proxy's static IPv4 address and reject ambiguous forwarded client IPs. Add nginx authentication and connection limits, an NPM authentication limiter, a checked local proxy upgrade and a read-only deployment preflight for private ports, setup completion, HTTPS and effective nginx controls. Record residual upstream findings and test the real proxy chain in disposable containers.

Security review: isolate late frontend responses across account changes; recheck sessions and roles inside protected write transactions; verify current authorization before idempotency replay; use the real TCP peer for login quotas. Add regression tests, explicit loopback publication defaults, hardened container compilation and frontend distribution security updates. Record dependency findings and publication conditions in the security audit.

Add English, French, Spanish, German, Simplified Chinese and Japanese alongside Italian. Localize interface text, accessible labels, API errors and date formats; detect browser language and provide a persistent selector before and after sign-in. Keep user content and API identifiers unchanged. New boards create their initial lists in the selected language. Add catalogue generation and source-coverage tests without runtime dependencies. Rewrite the README in English.

## 0.6.0

The fifth set of 100 improvements adds sprints, a backlog, atomic bulk assignment, per-person capacity, remaining-effort comparisons, explicitly captured daily snapshots, personal tasks, history and CSV exports. A board has at most one active sprint; unfinished cards remain unfinished when it closes. Estimates and logged time are apportioned across current team assignees.

Internal forms add typed fields, retained submission schemas, inboxes, triage, notes, personal edits, trash and atomic conversion to cards with WIP checks. The API-driven interface includes personal drafts, versions, filters and conflict recovery. See the [401–500 checklist and verification](docs/MIGLIORIE_500.md).

Additive schema 7 includes a pre-migration SQLite backup and explicit external 5/6 → 7 upgrades under the PostgreSQL lock. Form options, answers and schemas live in MongoDB; relationships and scalar values live in PostgreSQL. Separate 0.6 frontend and backend images include the new assets in both static-server allowlists.

## 0.5.0

The fourth set of 100 improvements adds card review requests with named reviewers, all-reviewer or any-reviewer approval rules, explained decisions, vote withdrawal, cancellation, reopening, duplication, trash, history and filtered inboxes. Requesters cannot approve their own requests. Current permissions are enforced, and revoking access permanently invalidates previous votes. Versions handle conflicts.

An authorized cross-board portfolio adds paginated search, editable and pinnable personal reports, daily activity, overdue bands, per-person workload, estimate/time comparisons, WIP, checklists, dependencies and milestones. CSV exports protect against spreadsheet formulas. The responsive interface includes personal drafts, conflict handling and protection from late responses. See the [301–400 checklist and verification](docs/MIGLIORIE_400.md).

SQLite schema 6 creates a pre-migration backup. External 5 → 6 migration runs under a PostgreSQL lock and rolls back if cache reconstruction fails. Structured review data lives in SQL; report-filter JSON lives in MongoDB. Separate 0.5 backend and frontend images include the new assets in the Nginx and development-server allowlists.

## 0.4.0

The third set of 100 improvements adds typed custom fields, milestones, bulk priority/label/milestone actions, guidelines and workload views. Time entries include trash, card/board/personal-week summaries and server-generated CSV exports. Comments gain replies, reactions and pinning; users gain personal bookmarks and notifications filtered before pagination.

The interface includes field management, milestones, reports and a table view. Reply drafts survive refreshes, and late HTTP responses do not overwrite filters or bookmarks. Local schema 5 creates a pre-migration backup. JSON v2 includes definitions, values and milestones; full backups retain personal and collaborative relationships. See the [201–300 checklist and verification](docs/MIGLIORIE_300.md).

Docker Compose separates the authenticated C API backend, static frontend, PostgreSQL, MongoDB and Nginx Proxy Manager. The binary and backend image contain no graphical assets. Authentication becomes the default; account-free mode is an explicit loopback-only option. The frontend loads data and catalogues from same-origin APIs. PostgreSQL stores typed scalar columns and references to immutable MongoDB JSON documents; SQLite becomes a reconstructible cache. SQL commits and cross-process locks coordinate snapshot publication. Local SQLite mode remains available. Separate persistent volumes, generated credentials and private networks support deployment; see [operations and limitations](docs/DEPLOYMENT.md).

## 0.3.0

The second set of 100 improvements adds scheduling and blockers, actual time, multiple user assignees, personal tasks, cycle-free dependencies, personal templates, saved filters and atomic bulk actions. Internal notifications include subscriptions. Attachments stored in the database are recoverable; comments can be edited, and users can update their profiles and revoke sessions.

The interface adds a manual timer, Markdown preview, CSV and iCalendar exports, keyboard shortcuts and team workflows. Operations add PREFIX/DESTDIR installation, Linux Docker/Compose, systemd and Nginx examples, environment configuration, metrics and SQLite maintenance. Schema 4 creates a pre-migration backup.

See the [101–200 checklist and verification](docs/MIGLIORIE_200.md). JSON v2 retains new scalar card fields; account relationships, dependencies, attachments and notifications require a full SQLite backup.

## 0.2.0

Collaboration adds a concurrent server, migrations, revisions and conflict handling, trash, archives, comments, history, versioned import/export, optional accounts and per-board permissions. The interface adds recoverable drafts, direct links, statistics and calendar views, and configurable theme and density.

See the complete [001–100 checklist](docs/MIGLIORIE_100.md).

OpenSSL libcrypto and pkg-config become build dependencies. Initial-version databases migrate without reseeding demonstration data. A copy with a `.pre-vN.bak` suffix is created before migration.

## 0.1.0

Initial local version: a C server, SQLite, boards, lists, cards, checklists, due dates, search and drag-and-drop. MIT license.
