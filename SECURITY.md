# Security policy

OpenBoard is an early preview. Security fixes target the latest preview release and the default branch. The project does not offer security certification, a bug bounty, a response-time guarantee or an enterprise support agreement.

## Supported versions

| Version | Security maintenance |
| --- | --- |
| 0.6.1 preview / current `main` | Current development target; upgrade to the latest reviewed fixes |
| 0.6.0 and earlier | No separate maintenance branch; upgrade after backing up and reviewing migrations |

Support status is a maintenance policy, not a claim that the current release has no vulnerabilities. See the [audit](docs/SECURITY_AUDIT_2026-10-16.md), [remediation report](docs/SECURITY_REMEDIATION_2026-10-16.md) and [known limitations](docs/ROADMAP.md#current-limitations).

## Report a vulnerability

Use **GitHub Private Vulnerability Reporting**: open the repository's [Security advisories](https://github.com/GiorgioOppo/OpenBoard/security/advisories) and choose **Report a vulnerability**. This is the project's sole private vulnerability-reporting channel; no reporting email is published.

Private reporting must be enabled when the repository becomes public. If the button is unavailable, open a support issue asking the maintainer to enable private reporting, without including vulnerability details. See [GitHub's reporting instructions](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability).

Include the affected version/commit or image digest, configuration, impact, minimal reproduction and any proposed fix. Use synthetic data. Do not send live credentials, customer databases or personal information. Do not post an exploit or reproduction in public issues before coordinated disclosure.

The maintainer will investigate, coordinate a fix and discuss disclosure through the private report. Response and remediation are best effort; no deadline or bounty is promised. Keep supporting evidence available privately until the report has been assessed.

## Deployment boundaries

- Authentication is enabled by default. `--no-auth` is explicitly restricted to loopback development.
- The C backend exposes JSON APIs only; a separate static frontend has no database credentials.
- Compose publishes only the proxy ports, bound to loopback by default. The NPM administration port remains on loopback. Set up both administrators before public service access.
- Public service access requires a real HTTPS origin and certificate. The exact public origin controls Host/Origin checks and Secure cookies.
- PostgreSQL structured rows and MongoDB JSON documents form one sensitive dataset. The application's database accounts are not database administrators. The SQLite cache is rebuildable and temporary in Compose.
- Secrets are generated in private environment files; backups, database volumes and NPM certificates/configuration also need protection. A board JSON export is not a complete application backup.

Run `python3 scripts/check-deployment.py` before exposing a service. It verifies actual port bindings, setup, origin, authentication, trusted proxy, live storage readiness and loaded nginx controls. For HTTPS it checks the certificate and exact redirect. `--config-only` does not verify running readiness. See [deployment and recovery](docs/DEPLOYMENT.md).

## Authentication and authorization

Passwords use random salts and PBKDF2-HMAC-SHA256 with 600,000 iterations. Sessions use random tokens stored as hashes, HttpOnly/SameSite Strict cookies, a 30-minute idle timeout and an eight-hour absolute lifetime. HTTPS origins add Secure. Authenticated writes require CSRF tokens.

Instance administrators can access every board. Members and observers require current board access; observers cannot modify board data, but can use permitted personal features. Sessions and roles are rechecked inside protected writes, and current permissions are checked before replaying idempotent responses. The frontend discards responses belonging to a previous signed-in account.

Only the exact IPv4 peer configured in `OPENBOARD_TRUSTED_PROXY` may provide one numeric `X-Real-IP`. Other forwarded headers do not determine identity. NPM uses a static address outside Docker's dynamic pool, overwrites IP headers with its TCP peer and has no implicit private-network/CDN trust. Adding another upstream proxy requires a reviewed trust configuration.

The backend permits 60 authentication attempts per IP in fixed monotonic five-minute windows. A second limit allows 10 per IP/scope/username for login, per IP/scope for setup, and per IP/scope/account ID for password changes. Fixed-memory keyed counters cannot be evicted by rotating usernames; collisions can reject attempts early. There is no shared global login quota. Nginx adds five authentication requests/minute/client with burst 10 and API concurrency limits of eight/client and 32/virtual host. NPM adds 10 attempts/five minutes/IP/route for login, second factor and user creation. Fixed-window quotas and per-IP limits do not stop a distributed attack.

## Data and known limits

Attachments are validated and downloaded as files rather than executed. Limits are 1 MiB/file, 10 active files/card and 5 MiB active attachment data/card. Trash retains data, so active quotas do not bound physical storage. Antivirus scanning is not included.

CSV exports guard against spreadsheet formulas, rendered Markdown escapes HTML, and reference links accept HTTP/HTTPS. Notifications, reports, reviews, sprints and forms enforce current account and board permissions. Publishing an internal form makes it available to eligible board members, not anonymous Internet users.

The project has no SSO, SaaS tenant isolation, automatic retention policy or high-availability guarantee. Dependency findings remain documented even when the affected execution component is absent. A later image rebuild can change packages and must be reviewed and tested as a new artifact. The recorded scans do not establish a clean scan of every final release image.
