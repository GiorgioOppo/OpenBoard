# Roadmap

OpenBoard 0.6.1 is an early preview for self-hosted evaluation and pilot teams. This roadmap describes priorities and areas for investigation; it is not a delivery schedule. Discuss proposals through the [feature request process](../SUPPORT.md).

## Available today

Authenticated boards, lists and cards; board sharing and roles; checklists, dates, dependencies and assignees; comments, notifications and attachments; custom fields, milestones and time tracking; review requests and portfolio reports; sprints and internal request forms; archive/trash restoration; JSON board transfer and full backups. The interface supports seven languages. See the [user guide](USER_GUIDE.md) and [API index](README.md#develop-and-integrate) for actual behavior and limits.

## Current limitations

- **Workload capacity:** the external-storage adapter serializes data requests under a PostgreSQL lock. Unreleased changes publish modified rows incrementally, while initial import and stale-cache reconstruction still use complete snapshots. Authenticated reads may persist coalesced session activity. The local SQLite benchmark is not an enterprise external-storage capacity measurement; no high-availability target has been validated.
- **Two-store operation:** PostgreSQL rows and MongoDB JSON documents must be backed up and restored together. SQLite is a rebuildable cache in Compose. Unreleased capacity controls expose cache measurements, configurable tmpfs sizing, a SQLite main-database cap and a minimum-free-space write guard. Sizing still requires workload measurements; the cap does not bound WAL, process memory or external databases.
- **Identity:** accounts and board roles are supported; SSO/OIDC/SAML, SCIM and an enterprise identity lifecycle are not implemented.
- **Integration:** JSON import/export is the OpenBoard format. Native Trello import, public integrations, webhooks and an automation engine are not implemented.
- **Attachments and retention:** unreleased installation quotas include retained attachment payloads and file counts, including trash, alongside existing active per-card limits. An admin panel accounts for active/trashed files, local cache and history rows. Physical SQL/MongoDB sizes, unused MongoDB documents and history are outside the attachment quota. Opt-in idempotency expiration and backup-file retention exist; automatic domain-history/trash retention, antivirus scanning and object storage remain outstanding.
- **Deployment:** Compose is a single-host starting point. Clustering, disaster-recovery objectives, external object storage and zero-downtime upgrades have not been established.
- **Security assurance:** the audit records fixes and visible dependency findings. It is not a certification or a complete scan of every later image. Fixed-window authentication limits do not stop distributed abuse.
- **Compatibility:** the API and schema are documented, but this 0.x preview may still change. Follow release notes and create a verified backup before upgrading.

## Next priorities

| Area | Planned outcome | Validation needed |
| --- | --- | --- |
| Release maintenance | Reproducible release evidence, updated dependency pins and tested upgrades | CI for each target architecture and exact image digests |
| Storage efficiency | Validate incremental publication, reduce full cache reconstruction and lock contention while preserving consistency | Real-store concurrency, failure recovery, migration and workload tests |
| Capacity | Published measurements on representative datasets | Explicit hardware, dataset, request mix and latency/error results |
| Data lifecycle | Extend logical accounting to physical stores, backup-aware orphan cleanup, domain retention and safer attachments | Disposable-store restore/cleanup, quota and permission tests |
| Documentation | More integration examples and a machine-readable API contract | Examples exercised against the current authenticated API |

## Follow-up by limitation

| Limitation | Practical next improvement | Completion evidence |
| --- | --- | --- |
| Workload capacity | Benchmark authenticated mixed workloads against disposable external stores, then design incremental cache reconstruction and narrower consistency locks | Representative datasets, p95/p99/error budgets, permission changes and failure/retry races; simply removing the lock is insufficient |
| Two-store operation | Measure physical PostgreSQL/MongoDB growth and verify backup-aware orphan reachability before adding cleanup | Real paired-store outage/recovery tests, retained-backup references and cleanup dry runs |
| Identity | Add one configurable OIDC provider before expanding to SAML/SCIM | Isolated provider integration, safe account linking, role/revocation tests and fallback administrator recovery |
| Integration | Start with bounded Trello JSON import; then add authenticated integration credentials and signed, retryable webhooks | Sanitized import fixtures, explicit unsupported fields, ACL/limits, replay and delivery-failure tests |
| Attachments and retention | Add policy previews and retention rules for trash/history, followed by object storage and scanning | Dry-run inventory, legal/operational retention choices, restore/backup compatibility and denied-access tests |
| Deployment | Execute the existing isolated full recovery tooling and measure recovery objectives before multi-host operation | A timed restore drill using candidate images and new stores, no skipped integration checks |
| Security assurance | Rescan every exact release artifact and retain findings, SBOM and remediation evidence | Scanner output tied to platform/digest; distributed-abuse tests and independently configured infrastructure controls |
| Compatibility | Publish a machine-readable authenticated API contract and exercise supported upgrades | Contract tests, clean and upgraded databases, verified backup/restore across supported versions |

The capacity, quota and telemetry changes above are locally verified development work. Real-store, image and recovery evidence still requires a disposable Docker environment. Destructive retention or garbage collection should not be introduced until its backup/restore behavior has been verified.

## Under consideration

SSO, Trello import, webhooks, rule-based automations, external attachment storage, real-time updates and more resilient multi-host deployments need design and operational validation before a commitment. A feature's presence in this section does not mean it is implemented or scheduled.

Completed work is recorded in the [changelog](../CHANGELOG.md). The old numbered improvement checklists are retained as a [historical archive](README.md#historical-archive).

The [next 100 improvements ledger](IMPROVEMENTS_NEXT_100.md) records development status separately for each accepted proposal. Partial and pending items are not available-feature claims.
