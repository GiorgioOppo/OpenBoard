# Support

OpenBoard is an early preview with community support on a best-effort basis. There is no commercial support contract or guaranteed response time.

## Before asking

Read the [quick start](README.md#quick-start), [user guide](docs/USER_GUIDE.md) and [troubleshooting guide](docs/TROUBLESHOOTING.md). For installation, HTTPS, upgrades and recovery, use the [deployment guide](docs/DEPLOYMENT.md). Check the [known limitations](docs/ROADMAP.md#current-limitations) and search existing issues.

## Where to ask

- Use the [bug report form](https://github.com/GiorgioOppo/OpenBoard/issues/new?template=bug_report.yml) for a reproducible defect.
- Use the [feature request form](https://github.com/GiorgioOppo/OpenBoard/issues/new?template=feature_request.yml) for a proposed improvement.
- Use the [support question form](https://github.com/GiorgioOppo/OpenBoard/issues/new?template=support_question.yml) for setup and usage questions.
- Report vulnerabilities through the [private security channel](SECURITY.md#report-a-vulnerability).

Include the OpenBoard version/commit, operating system, relevant Docker/Compose versions, steps taken and expected/actual behavior. Mention whether storage is standalone SQLite or PostgreSQL/MongoDB. Share a small synthetic reproduction where possible.

Public issues, attachments and logs are visible to others. Remove credentials, cookies, CSRF tokens, personal data, private hostnames and connection strings. Never attach `.env`, `.env.local-admin`, database files or full Compose configuration. A short redacted error and request ID are usually more useful than an entire log archive.

Maintainers may ask for a minimal reproduction, close duplicates or move a request into the roadmap. The [code of conduct](CODE_OF_CONDUCT.md) applies to all project interactions.
