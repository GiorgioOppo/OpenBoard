# Next 100 improvements — implementation ledger

Started on 17 October 2026. IDs match the 100 proposals accepted in the development conversation. This is an implementation ledger, not a claim that all 100 capabilities are available. The published `v0.6.1` tag is unchanged.

**Implemented** means the stated capability has code and local verification. **Partial** means either functional scope or verification on the target services is incomplete. **Pending** means implementation remains outstanding. Container execution is unavailable locally; the owner requested continuing with the available local checks. No existing installation, database or deployment credentials are used for tests.

| ID | Improvement | Status | Evidence or remaining work |
| --- | --- | --- | --- |
| 1 | Incremental SQL/JSON persistence | Implemented | Changed-row publication and Mongo document verification; offline tracker and real disposable SQL/Mongo regressions passed in CI at `5688602`. Full hydration and the global lock remain separate pending items. |
| 2 | Concurrent external reads | Pending | The global external-store lock remains. |
| 3 | More granular write locks | Pending | Requires a consistency design covering cross-board/global operations. |
| 4 | Incremental cache reconstruction | Pending | Stale caches still load complete snapshots. |
| 5 | Coalesced session activity writes | Implemented | `auth.c`; activity touched at most once per minute; expiry/revocation regressions in `test_growth.py`. |
| 6 | SQL/Mongo reference and content integrity | Partial | Read/reuse validates document ID, kind, digest and typed BSON; offline checks pass. An administrator-wide inventory/repair workflow is still needed. |
| 7 | Mongo orphan garbage collection | Pending | Requires backup-aware reachability and a grace-period contract. |
| 8 | Complete storage quotas | Partial | Installation decoded-payload/file quotas include retained trash and deleted ancestors; admin API/UI reports attachment, local cache and history inventory. Physical external sizes, history quotas and MongoDB orphans remain outside the quota. |
| 9 | Idempotency retention | Implemented | Opt-in TTL, indexed transactional cleanup, rollback and compatibility tests. Default is unlimited retention. |
| 10 | Temporary-cache capacity controls | Implemented | Configurable tmpfs, per-connection SQLite page cap, minimum-free-space admission/readiness and gauges; rollback, lock rechecks and hydration guard tested locally/offline. WAL/process memory need separate headroom; Docker sizing remains unvalidated. |
| 11 | Reproducible workload benchmarks | Partial | Isolated SQLite benchmark records workload, hardware, binary hash and latency; external/authenticated workloads remain unmeasured. |
| 12 | Performance regression budgets | Partial | Benchmark CLI enforces p95/error budgets; memory budgets and representative CI baselines remain. |
| 13 | Paginated global search | Implemented | Stable ID cursor, permissions before pagination, frontend load-more and stale-response tests. Legacy ordering remains available. |
| 14 | Unicode-aware search | Pending | Existing SQLite `lower` behavior remains. |
| 15 | Full-text relevance ranking | Pending | No new search index/ranking engine. |
| 16 | Search collaborative content | Implemented | Dedicated content API searches cards, comments/replies, requests/answer values/notes and forms; live ACL/ancestry before typed cursor pagination, escaped excerpts and guarded UI navigation. Nine HTTP regressions and a frontend race/escaping suite. Unicode linguistic search and relevance ranking remain IDs 14–15. |
| 17 | Advanced custom-field filters | Implemented | Typed operators, set/unset, 1–10 flat all/any API conditions and ID pagination; toolbar exposes one typed condition while preserving free search. Six HTTP regressions and two frontend suites. |
| 18 | S3-compatible attachment storage | Pending | Requires storage, authorization and backup integration. |
| 19 | Binary/resumable attachments | Pending | Existing JSON/base64 transfer remains. |
| 20 | Large asynchronous exports | Pending | Existing export bounds remain. |
| 21 | Workspaces | Pending | Organizational scope and tenant boundaries require schema/ACL work. |
| 22 | User groups | Pending | No group grants implemented. |
| 23 | Custom roles | Pending | Existing admin/member/observer roles remain. |
| 24 | Expiring guest access | Pending | No guest lifecycle implemented. |
| 25 | Secure invitations | Pending | No invitation delivery/token workflow implemented. |
| 26 | OpenID Connect SSO | Pending | Provider integration, token verification and account linking required. |
| 27 | SAML compatibility | Pending | No SAML adapter implemented. |
| 28 | SCIM provisioning | Pending | No SCIM endpoint implemented. |
| 29 | TOTP and recovery codes | Pending | No application second-factor workflow implemented. |
| 30 | Passkeys | Pending | No WebAuthn registration/authentication implemented. |
| 31 | Threat model and ASVS traceability | Pending | Existing audit is not a complete requirements matrix. |
| 32 | Native fuzzing | Pending | ASan/UBSan regressions do not constitute a fuzzing corpus/campaign. |
| 33 | Account recovery | Pending | No recovery-token workflow implemented. |
| 34 | Administrative reauthentication | Pending | No elevation window implemented. |
| 35 | Distributed authentication quotas | Pending | Counters remain process-local. |
| 36 | Antivirus quarantine | Pending | No file scanner implemented. |
| 37 | Configurable data retention | Pending | No automatic domain trash/history purge implemented. |
| 38 | Verifiable administrative audit | Pending | Existing activity/history is not a tamper-evident audit channel. |
| 39 | File-mounted credentials | Implemented | PostgreSQL/Mongo `_FILE` inputs, regular/private-file checks, conflict/NUL/size/symlink/FIFO regressions; inline configuration remains compatible. |
| 40 | Guided credential rotation | Pending | No coordinated rotation/rollback tool implemented. |
| 41 | Validated OpenAPI contract | Pending | Existing Markdown API references remain authoritative. |
| 42 | API versioning/deprecation policy | Pending | No new versioned routing contract implemented. |
| 43 | Mandatory mutation versions | Pending | Existing optional preconditions remain. |
| 44 | Scoped service accounts | Pending | No integration-token authentication implemented. |
| 45 | Signed webhooks | Pending | No outgoing event delivery implemented. |
| 46 | Webhook retries/history | Pending | Depends on webhook delivery and durable jobs. |
| 47 | Native Trello import | Implemented | Bounded local single-board JSON conversion, checklist/date/archive handling and explicit omission warnings; preview/confirmation uses the authenticated atomic OpenBoard import. Attachments/history/custom fields and broader API export shapes are unsupported; no Trello sign-in or synchronization. Converter, UI and authenticated round-trip tests. |
| 48 | CSV import | Implemented | UTF-8 comma/semicolon files, quoted multiline cells, optional headers, explicit column mapping, validation/counts/warnings and atomic confirmation. Seven supported card/list fields; formulas remain literal text. Converter, UI and authenticated rollback/round-trip tests. |
| 49 | GitHub synchronization | Pending | No connector implemented or account access requested. |
| 50 | Complete portable board bundle | Pending | Full instance backup remains the complete transfer mechanism. |
| 51 | Automation editor | Pending | No rule engine implemented. |
| 52 | Durable job queue | Pending | No persistent application-job executor implemented. |
| 53 | Recurring cards | Pending | Depends on the job scheduler and recurrence contract. |
| 54 | Due-date reminders | Pending | No scheduled application reminders implemented. |
| 55 | Automatic sprint observations | Pending | Existing explicit snapshots remain. |
| 56 | Email notifications | Pending | No SMTP delivery implemented. |
| 57 | Web Push | Pending | No push subscription/delivery implemented. |
| 58 | Notification preferences | Pending | Existing watch/filter behavior remains. |
| 59 | User mentions | Pending | No mention parsing/delivery implemented. |
| 60 | Automation simulation/history | Pending | Depends on the automation engine. |
| 61 | Configurable board labels | Pending | Existing fixed label catalogue remains. |
| 62 | Shared versioned templates | Pending | Existing personal templates remain. |
| 63 | Hierarchical subtasks | Pending | Checklists remain independent of card hierarchy. |
| 64 | Cross-board dependencies | Pending | Existing same-board restriction remains. |
| 65 | Cross-board card moves | Pending | Existing same-board move restriction remains. |
| 66 | Workflow transition rules | Pending | Approvals do not automatically block completion. |
| 67 | Content-bound approvals | Implemented | Relevant content changes clear votes, increment review versions and record history atomically; identical content/order changes retain votes. |
| 68 | Daily sprint capacity | Pending | Existing total-minute capacity remains. |
| 69 | Timeline/Gantt | Pending | No dependency timeline implemented. |
| 70 | Observed flow analytics | Pending | No cumulative-flow/lead-time data model implemented. |
| 71 | Virtualized card rendering | Pending | Board rendering is not virtualized. |
| 72 | Authorized realtime events | Pending | Existing polling remains. |
| 73 | Field-by-field conflict resolution | Pending | Existing draft/reload recovery remains. |
| 74 | Compensating undo | Pending | No mutation undo command implemented. |
| 75 | Command palette | Implemented | Contextual actions, filtering, current permission checks and keyboard shortcut; `test_experience.js`. |
| 76 | Monthly/weekly calendar | Implemented | Agenda/month/week, period navigation, localized dates, filters and card opening. |
| 77 | Editable table | Implemented | Explicit row Save for title, priority, due date and estimate; original If-Match, fresh permission checks, owner-isolated drafts, conflict/ambiguous-write recovery and guarded refresh. Actual renderer/handler/API-client tests; other properties use their existing editors. |
| 78 | Personal draft center | Partial | Card drafts supported with owner isolation and server ACL check; review/comment/intake drafts remain in their editors. |
| 79 | Offline snapshots | Pending | No authorized offline cache implemented. |
| 80 | Browser-tab coordination | Implemented | Logout through BroadcastChannel/storage fallback, no credentials in messages, pending responses invalidated. |
| 81 | Complete WCAG 2.2 AA assessment | Pending | Local interaction tests are not a complete accessibility audit. |
| 82 | Direct board keyboard navigation | Implemented | Arrows/Home/End and Ctrl+Home/End; focus preservation tests. |
| 83 | Accessible field errors | Partial | Browser constraint errors linked to fields with summary/focus; API field-level errors remain unsupported. |
| 84 | Forced colors/high contrast | Partial | CSS support implemented; real OS/browser assessment remains. |
| 85 | Touch targets | Partial | Main controls have 44px targets; real-device checks remain. |
| 86 | Change language without reload | Pending | Existing reload behavior remains. |
| 87 | Account language synchronization | Pending | Language preference remains local to the browser. |
| 88 | Independent regional preferences | Pending | No account timezone/week-start settings implemented. |
| 89 | IME compatibility | Partial | Composition guards and grapheme initials implemented/tested synthetically; real browser/IME matrix remains. |
| 90 | Pseudolocalization/language review | Partial | `?pseudo=1` UI stress mode preserves placeholders/user content; native-speaker review remains. |
| 91 | Storage/latency observability | Implemented | Bounded coherent HTTP/storage histograms, status classes, 429, adapter errors, confirmed SQL rows and cache gauges. Native concurrent export, HTTP ACL and offline driver tests; external capacity is not measured. |
| 92 | Operational alerts | Pending | No alert delivery/dashboard implemented. |
| 93 | Encrypted scheduled backups | Partial | CMS encryption, manifest, integrity, scheduler and retention tested locally; actual container capture/scheduling awaits Docker. |
| 94 | Complete installation backup | Partial | Coordinated application/NPM archive code and isolated tests; real maintenance capture awaits Docker. |
| 95 | Full restore verification | Partial | Disposable restore/check command implemented; real SQL/Mongo/NPM round trip remains unexecuted locally. |
| 96 | Exact-image local vulnerability scans | Pending | No new scan executed; historical inventories are unchanged. |
| 97 | Pin all Docker bases | Implemented | Debian/backend and Nginx/frontend OCI indexes pinned; database/proxy/toolchain pins retained. |
| 98 | Full cloud suite in CI | Implemented | CI at `5688602` passed the complete disposable cloud suite, migrations/outage, encrypted fixture recovery, image and five-service routing checks without skipped cloud tests. This is not evidence for later local changes. |
| 99 | Browser end-to-end matrix | Pending | Node helper/interaction suites do not replace real browser E2E. |
| 100 | Verifiable official distributions | Pending | No signed registry release, multiarch runtime matrix or release SBOM produced. |

## Verification commands

```sh
make test
make test-sanitize
make test-frontend
make test-security
make test-docs
python3 scripts/benchmark.py --boards 5 --cards 100 --requests 1000 --concurrency 8
```

`scripts/test-cloud-stack.py` and `scripts/restore-check.py` require Docker and use fresh isolated resources. Results must identify the tested commit; passing earlier CI does not verify a later candidate. The [testing guide](TESTING.md) and [deployment guide](DEPLOYMENT.md) describe the supported boundaries and backup procedures.

## Local verification — 17 October 2026

- Native build with libpq and the MongoDB C driver succeeded.
- Final Python discovery after the capacity/telemetry follow-up ran 287 tests: 261 passed and 26 optional checks skipped, both normally (83.178 seconds) and with AddressSanitizer/UndefinedBehaviorSanitizer (104.003 seconds). This includes retained quotas, rollback, measurement failure, writer-lock pressure and offline adapter telemetry.
- All seven frontend suites, NPM limiter tests, Actionlint, local documentation checks and `git diff --check` passed.
- Compose configuration rendered successfully with a synthetic private environment file, including overridden tmpfs/cache/attachment settings. No daemon or existing environment file was used.
- A local Gitleaks scan of 209 publishable source files reported zero findings; ignored environment files and private Git backups were not included.
- Real PostgreSQL/MongoDB, container images, complete Docker recovery, fresh CVE scans, browser E2E and a complete WCAG/native-language review were not executed. These results were recorded before Git publication; no deployment or release was performed.

## Subsequent CI evidence — 17 October 2026

[Run 39020804975](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39020804975) at `56886022035c5f0a0b1c3229e012a1e6c8e32d44` completed successfully: documentation/secrets, macOS, Ubuntu and container jobs. It exercised real disposable PostgreSQL/MongoDB, migration/outage regressions, encrypted generated-fixture recovery, five-service startup and proxy/static routing. This closes the target-service verification gaps for IDs 1 and 98. The recovery fixture does not establish a complete maintenance capture or a functional restoration of an existing NPM installation; IDs 93–95 remain partial.

## Collaborative search, typed filters, imports and table — 17 October 2026

IDs 16, 17, 47, 48 and 77 are implemented on the development branch. Their contracts and conversion boundaries are documented in the [API reference](API.md), [field API](API_PIANIFICAZIONE.md) and [user guide](USER_GUIDE.md). No migration or schema version change is required; the backend remains API-only and conversion happens in the separate static frontend.

- Native discovery with the external-storage drivers ran **311 tests: 285 passed, 26 optional integrations skipped**, normally (74.135 seconds) and with ASan/UBSan (98.646 seconds).
- The new HTTP regressions cover current permissions, revoked access, live ancestry, archive selection, stable pagination, typed values, literal matching, conversion round trips and atomic rollback. Frontend checks cover escaping, account/panel/navigation races, mapping, UTF-8 rejection, optimistic versions and retained drafts.
- All 13 frontend suites pass, including source/catalogue coverage in seven locales. Documentation links/fences, Actionlint and the NPM limiter tests pass.
- Gitleaks scanned 228 publishable source files and reported zero findings; ignored private environment files and Git backups were excluded from the snapshot. This is not a new dependency vulnerability scan.
- Local HTTP checks serve the new importer asset through the development frontend. Container/static-proxy tests are wired to check that asset on the next CI run; they remain skipped locally. Browser interaction tests use VM/DOM adapters, not a real-browser E2E matrix.
- This feature block has local verification only; it has not been exercised against real PostgreSQL/MongoDB. The earlier CI evidence above applies only to `5688602`. No existing installation or credentials were used.

Current ledger: **19 implemented, 13 partial, 68 pending**. The requested 100-item implementation remains incomplete.
