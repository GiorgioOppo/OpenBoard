# Next 100 improvements — implementation ledger

Started on 17 October 2026. IDs match the 100 proposals accepted in the development conversation. This is an implementation ledger, not a claim that all 100 capabilities are available. The published `v0.6.1` tag is unchanged.

**Implemented** means the stated capability has code and local verification. **Partial** means either functional scope or verification on the target services is incomplete. **Pending** means implementation remains outstanding. Container execution is unavailable locally; the owner requested continuing with the available local checks. No existing installation, database or deployment credentials are used for tests.

| ID | Improvement | Status | Evidence or remaining work |
| --- | --- | --- | --- |
| 1 | Incremental SQL/JSON persistence | Partial | Changed-row publication and Mongo document verification implemented; offline tracker tests pass. Real cloud regressions await disposable PostgreSQL/MongoDB. |
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
| 16 | Search collaborative content | Pending | Comments, discussions and intake answers are not in core search. |
| 17 | Advanced custom-field filters | Pending | Existing exact-match filters remain. |
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
| 47 | Native Trello import | Pending | Existing OpenBoard-format import remains. |
| 48 | CSV import | Pending | No column-mapping import workflow implemented. |
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
| 77 | Editable table | Pending | Existing table remains read-only. |
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
| 98 | Full cloud suite in CI | Partial | Isolated orchestration added; candidate workflow/container execution remains unverified locally. |
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

`scripts/test-cloud-stack.py` and `scripts/restore-check.py` require Docker and use fresh isolated resources. They must not be represented as passing until executed. The [testing guide](TESTING.md) and [deployment guide](DEPLOYMENT.md) describe the supported boundaries and backup procedures.

## Local verification — 17 October 2026

- Native build with libpq and the MongoDB C driver succeeded.
- Final Python discovery after the capacity/telemetry follow-up ran 287 tests: 261 passed and 26 optional checks skipped, both normally (83.178 seconds) and with AddressSanitizer/UndefinedBehaviorSanitizer (104.003 seconds). This includes retained quotas, rollback, measurement failure, writer-lock pressure and offline adapter telemetry.
- All seven frontend suites, NPM limiter tests, Actionlint, local documentation checks and `git diff --check` passed.
- Compose configuration rendered successfully with a synthetic private environment file, including overridden tmpfs/cache/attachment settings. No daemon or existing environment file was used.
- A local Gitleaks scan of 209 publishable source files reported zero findings; ignored environment files and private Git backups were not included.
- Real PostgreSQL/MongoDB, container images, complete Docker recovery, fresh CVE scans, browser E2E and a complete WCAG/native-language review were not executed. These results were recorded before Git publication; no deployment or release was performed.

Current ledger: **12 implemented, 15 partial, 73 pending**. The requested 100-item implementation remains incomplete.
