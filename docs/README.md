# Documentation

OpenBoard 0.6.1 is an early preview. Start with the guide that matches your task; the historical feature checklists are evidence of earlier work, not current installation instructions.

## Use and operate OpenBoard

| Guide | Purpose |
| --- | --- |
| [Project README](../README.md) | Overview, screenshots and quick start |
| [User guide](USER_GUIDE.md) | Accounts, boards, collaboration, sprints and requests |
| [Deployment](DEPLOYMENT.md) | Compose, HTTPS, native setup, upgrades, backup and restore |
| [Troubleshooting](TROUBLESHOOTING.md) | Setup, ports, origin, authentication and storage errors |
| [Architecture](ARCHITECTURE.md) | API/frontend separation, consistency and trust boundaries |
| [Roadmap](ROADMAP.md) | Current capabilities, limitations and proposed work |
| [Next 100 improvements](IMPROVEMENTS_NEXT_100.md) | Item-by-item implementation status, evidence and outstanding work |
| [Support](../SUPPORT.md) | Questions, bug reports and feature requests |

## Develop and integrate

| Guide | Purpose |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Development setup, conventions and pull requests |
| [Testing](TESTING.md) | Default, sanitizer, frontend and opt-in integration checks |
| [Native fuzzing](FUZZING.md) | Bounded HTTP, JSON and Unicode campaigns, synthetic corpora and reproduction |
| [API versioning](API_VERSIONING.md) | Explicit v1 paths, legacy aliases, compatibility and deprecation policy |
| [Base API](API.md) | HTTP conventions, authentication, permissions and board/card APIs |
| [Productivity API](API_PRODUTTIVITA.md) | Dependencies, assignees, templates, saved filters and bulk actions |
| [Collaboration API](API_COLLABORAZIONE.md) | Notifications, attachments and account/session tools |
| [Planning API](API_PIANIFICAZIONE.md) | Custom fields, milestones and board reporting |
| [Teamwork API](API_TEAMWORK.md) | Work logs, conversations, reactions and bookmarks |
| [Review API](API_REVISIONI.md) | Requests, reviewers, decisions and history |
| [Portfolio API](API_PORTFOLIO.md) | Cross-board queries and personal reports |
| [Sprint API](API_SPRINT.md) | Backlog, capacity and daily snapshots |
| [Intake API](API_RICHIESTE.md) | Internal forms, typed submissions and triage |
| [Internationalization](INTERNATIONALIZATION.md) | Translation catalogues and language behavior |

## Security and releases

- [Security policy and private reporting](../SECURITY.md).
- [Threat model](THREAT_MODEL.md) and [ASVS traceability and gaps](SECURITY_REQUIREMENTS.md).
- [Initial audit, 16 October 2026](SECURITY_AUDIT_2026-10-16.md) and [original inventory](SECURITY_SCAN_2026-10-16.json).
- [Remediation report](SECURITY_REMEDIATION_2026-10-16.md) and [follow-up inventory](SECURITY_SCAN_REMEDIATION_2026-10-16.json).
- [Third-party licenses and provenance](../THIRD_PARTY_NOTICES.md).
- [Changelog](../CHANGELOG.md), [release process](RELEASING.md) and [publication checklist](PUBLICATION.md).
- [Publication preparation review, 16 October 2026](PUBLICATION_REVIEW_2026-10-16.md).
- [Maintainers](../MAINTAINERS.md) and [code of conduct](../CODE_OF_CONDUCT.md).

## Historical archive

These Italian documents describe previous snapshots and may contain superseded architecture or configuration. Use the current guides above for operation and integration.

- [Original improvement study](STUDIO_MIGLIORIE.md).
- Feature checklists [1–100](MIGLIORIE_100.md), [101–200](MIGLIORIE_200.md), [201–300](MIGLIORIE_300.md), [301–400](MIGLIORIE_400.md) and [401–500](MIGLIORIE_500.md).
