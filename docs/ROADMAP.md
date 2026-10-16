# Roadmap

OpenBoard 0.6.1 is an early preview for self-hosted evaluation and pilot teams. This roadmap describes priorities and areas for investigation; it is not a delivery schedule. Discuss proposals through the [feature request process](../SUPPORT.md).

## Available today

Authenticated boards, lists and cards; board sharing and roles; checklists, dates, dependencies and assignees; comments, notifications and attachments; custom fields, milestones and time tracking; review requests and portfolio reports; sprints and internal request forms; archive/trash restoration; JSON board transfer and full backups. The interface supports seven languages. See the [user guide](USER_GUIDE.md) and [API index](README.md#develop-and-integrate) for actual behavior and limits.

## Current limitations

- **Workload capacity:** the external-storage adapter serializes data requests under a PostgreSQL lock and publishes complete snapshots. Authenticated reads may also persist session activity. No enterprise capacity benchmark or high-availability target has been validated.
- **Two-store operation:** PostgreSQL rows and MongoDB JSON documents must be backed up and restored together. SQLite is a rebuildable cache in Compose. The default cache tmpfs is finite and requires workload-specific sizing.
- **Identity:** accounts and board roles are supported; SSO/OIDC/SAML, SCIM and an enterprise identity lifecycle are not implemented.
- **Integration:** JSON import/export is the OpenBoard format. Native Trello import, public integrations, webhooks and an automation engine are not implemented.
- **Attachments and retention:** file quotas cover active attachments; trash and history still consume storage. Antivirus scanning and automatic retention are not implemented.
- **Deployment:** Compose is a single-host starting point. Clustering, disaster-recovery objectives, external object storage and zero-downtime upgrades have not been established.
- **Security assurance:** the audit records fixes and visible dependency findings. It is not a certification or a complete scan of every later image. Fixed-window authentication limits do not stop distributed abuse.
- **Compatibility:** the API and schema are documented, but this 0.x preview may still change. Follow release notes and create a verified backup before upgrading.

## Next priorities

| Area | Planned outcome | Validation needed |
| --- | --- | --- |
| Release maintenance | Reproducible release evidence, updated dependency pins and tested upgrades | CI for each target architecture and exact image digests |
| Storage efficiency | Incremental persistence and less contention while preserving authorization and consistency | Concurrency, failure recovery, migration and workload tests |
| Capacity | Published measurements on representative datasets | Explicit hardware, dataset, request mix and latency/error results |
| Data lifecycle | Storage accounting, retention and safer attachment operation | Restore behavior, quotas and permission tests |
| Documentation | More integration examples and a machine-readable API contract | Examples exercised against the current authenticated API |

## Under consideration

SSO, Trello import, webhooks, rule-based automations, external attachment storage, real-time updates and more resilient multi-host deployments need design and operational validation before a commitment. A feature's presence in this section does not mean it is implemented or scheduled.

Completed work is recorded in the [changelog](../CHANGELOG.md). The old numbered improvement checklists are retained as a [historical archive](README.md#historical-archive).
