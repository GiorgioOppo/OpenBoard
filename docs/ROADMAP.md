# Roadmap

OpenBoard 0.6.1 is an early preview for self-hosted evaluation and pilot teams. This roadmap describes priorities and areas for investigation; it is not a delivery schedule. Discuss proposals through the [feature request process](../SUPPORT.md).

## Available today

Authenticated boards, lists and cards; board sharing and roles; checklists, dates, dependencies and assignees; comments, notifications and attachments; custom fields, milestones and time tracking; review requests and portfolio reports; sprints and internal request forms; archive/trash restoration; JSON board transfer and full backups. The interface supports seven languages. See the [user guide](USER_GUIDE.md) and [API index](README.md#develop-and-integrate) for actual behavior and limits.

## Development branch (unreleased)

Collaborative content search adds authorized card/comment/request/note/form results with typed cursors. Custom-field search adds typed comparisons and up to ten flat all/any conditions in the API; the board toolbar exposes one typed condition at a time. Browser import converts bounded single-board Trello JSON and mapped CSV into the existing atomic OpenBoard import format, with explicit omission warnings. The table editor saves title, priority, due date and estimate together with version checks and account-scoped drafts. These additions passed the four jobs in [CI run 39030617497](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39030617497) at `25da2ba`: repository checks, Linux and macOS native/sanitizer suites, and container integration.

Unicode NFC/full-case-folding global substring search preserves original-text snippets. A read-only UTC timeline uses bounded board dependency reads and CSP-compatible static geometry; a three-way full-card conflict preview applies only to the local editor before explicit version-checked Save. Three native fuzz targets cover HTTP, JSON and Unicode. These changes passed all five jobs in [CI run 39049801070](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39049801070) at `b103d97`, including native fuzzing, both native/sanitizer platforms and disposable container integration. The local campaign evidence is described in [Testing](TESTING.md) and [Fuzzing](FUZZING.md). A complete real-browser end-to-end session remains outstanding. Development changes do not modify the published `v0.6.1` tag. See the [user workflows](USER_GUIDE.md#finding-work-unreleased) and [API contracts](API.md#collaborative-content-search-unreleased).

The next local block adds in-place language changes across mounted editors, explicit `/api/v1` aliases with shared authentication/idempotency controls and proxy-aware deployment validation, plus a threat model and scoped ASVS 5.0.0 traceability. IDs 42 and 86 are implemented; ID 31 remains partial because requirements are unassessed or have known gaps. See [API versioning](API_VERSIONING.md), [localization](INTERNATIONALIZATION.md) and [security requirements](SECURITY_REQUIREMENTS.md). These changes are not covered by the earlier `b103d97` run.

## Current limitations

- **Workload capacity:** the external-storage adapter serializes data requests under a PostgreSQL lock. Unreleased changes publish modified rows incrementally, while initial import and stale-cache reconstruction still use complete snapshots. Authenticated reads may persist coalesced session activity. The local SQLite benchmark is not an enterprise external-storage capacity measurement; no high-availability target has been validated.
- **Two-store operation:** PostgreSQL rows and MongoDB JSON documents must be backed up and restored together. SQLite is a rebuildable cache in Compose. Unreleased capacity controls expose cache measurements, configurable tmpfs sizing, a SQLite main-database cap and a minimum-free-space write guard. Sizing still requires workload measurements; the cap does not bound WAL, process memory or external databases.
- **Identity:** accounts and board roles are supported; SSO/OIDC/SAML, SCIM and an enterprise identity lifecycle are not implemented.
- **Integration:** the API import/export format remains OpenBoard JSON. Unreleased browser converters support bounded Trello JSON and CSV, with omissions for history, attachments, identities and unsupported data. They do not synchronize with Trello. Public integration credentials, webhooks and an automation engine are not implemented.
- **Search and scheduling:** Unicode global search remains substring scanning, without stemming, ranking or a full-text index; the browser's board filter keeps its prior semantics. The timeline reads existing dates and at most 2000 dependency edges separately, without an atomic snapshot or automatic scheduling. Its bounded pages do not establish large-board virtualization or measured capacity.
- **Attachments and retention:** unreleased installation quotas include retained attachment payloads and file counts, including trash, alongside existing active per-card limits. An admin panel accounts for active/trashed files, local cache and history rows. Physical SQL/MongoDB sizes, unused MongoDB documents and history are outside the attachment quota. Opt-in idempotency expiration and backup-file retention exist; automatic domain-history/trash retention, antivirus scanning and object storage remain outstanding.
- **Deployment:** Compose is a single-host starting point. Disposable application recovery has CI evidence, while proxy archive recovery remains partial and does not exercise a running NPM or certificate restoration. Clustering, measured disaster-recovery objectives, external object storage and zero-downtime upgrades have not been established.
- **Security assurance:** the audit records fixes and visible dependency findings. Three new native fuzz targets add bounded local coverage, with recorded source/binary hashes; their separate fifth job passed at `b103d97`. The threat model and ASVS matrix make known gaps and unassessed requirements explicit. Neither that traceability, audit nor fuzzing is a certification or a complete scan of every later image. Fixed-window authentication limits do not stop distributed abuse.
- **Compatibility:** the API and schema are documented. The unreleased v1 route policy preserves documented API major semantics, while application/schema upgrades still require review. Follow release notes and create a verified backup before upgrading.

## Next priorities

| Area | Planned outcome | Validation needed |
| --- | --- | --- |
| Release maintenance | Reproducible release evidence, updated dependency pins and tested upgrades | CI for each target architecture and exact image digests |
| Storage efficiency | Extend incremental-publication coverage, reduce full cache reconstruction and lock contention while preserving consistency | Representative real-store concurrency, failure recovery, migration and workload tests |
| Capacity | Published measurements on representative datasets | Explicit hardware, dataset, request mix and latency/error results |
| Data lifecycle | Extend logical accounting to physical stores, backup-aware orphan cleanup, domain retention and safer attachments | Disposable-store restore/cleanup, quota and permission tests |
| Documentation | More integration examples and a machine-readable API contract | Examples exercised against the current authenticated API |

## Follow-up by limitation

| Limitation | Practical next improvement | Completion evidence |
| --- | --- | --- |
| Workload capacity | Benchmark authenticated mixed workloads against disposable external stores, then design incremental cache reconstruction and narrower consistency locks | Representative datasets, p95/p99/error budgets, permission changes and failure/retry races; simply removing the lock is insufficient |
| Two-store operation | Measure physical PostgreSQL/MongoDB growth and verify backup-aware orphan reachability before adding cleanup | Real paired-store outage/recovery tests, retained-backup references and cleanup dry runs |
| Identity | Add one configurable OIDC provider before expanding to SAML/SCIM | Isolated provider integration, safe account linking, role/revocation tests and fallback administrator recovery |
| Integration | Validate the new Trello/CSV browser workflow against supported export variants, then add integration credentials and signed, retryable webhooks | Real-browser migration checks, explicit omissions, ACL/limits, replay and delivery-failure tests |
| Attachments and retention | Add policy previews and retention rules for trash/history, followed by object storage and scanning | Dry-run inventory, legal/operational retention choices, restore/backup compatibility and denied-access tests |
| Deployment | Extend the disposable application recovery proof to a running proxy/certificate drill and measure recovery objectives before multi-host operation | Candidate images and fresh stores, real proxy behavior, safely isolated certificate checks and measured timings |
| Security assurance | Rescan every exact release artifact and retain findings, SBOM and remediation evidence | Scanner output tied to platform/digest; distributed-abuse tests and independently configured infrastructure controls |
| Compatibility | Publish a machine-readable authenticated API contract and exercise supported upgrades | Contract tests, clean and upgraded databases, verified backup/restore across supported versions |

The storage, quota, telemetry and backup block first passed [CI run 39020804975](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39020804975) at commit `5688602`; the later four-job run at `25da2ba` also covered the five search/filter/import/table additions. Container evidence includes five image builds, isolated PostgreSQL/MongoDB scenarios and encrypted application recovery into fresh stores. Proxy recovery checks a synthetic archive in a separate network-disabled container; it does not start NPM, request certificates or restore an existing deployment. The later five-job run at `b103d97` additionally covers the Unicode/timeline/merge/fuzz block, including its new static assets and separate native fuzzing job. They do not establish external-store performance, actual tmpfs-exhaustion behavior, recovery-time objectives or high availability. Destructive retention or garbage collection still requires verified backup-aware behavior.

## Under consideration

SSO, broader Trello export compatibility, webhooks, rule-based automations, external attachment storage, real-time updates and more resilient multi-host deployments need design and operational validation before a commitment. A feature's presence in this section does not mean it is implemented or scheduled.

Completed work is recorded in the [changelog](../CHANGELOG.md). The old numbered improvement checklists are retained as a [historical archive](README.md#historical-archive).

The [next 100 improvements ledger](IMPROVEMENTS_NEXT_100.md) records development status separately for each accepted proposal. Partial and pending items are not available-feature claims.
