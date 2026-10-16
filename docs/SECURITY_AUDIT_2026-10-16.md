# Pre-publication security audit — 16 October 2026

## Decision

**Hold Internet production deployment.** The confirmed application defects below have been corrected and regression tested. The supplied proxy and database images still contain high and critical dependency findings requiring updates or a documented assessment of the affected execution paths. HTTPS and protection against authentication denial of service at the reverse proxy also remain deployment requirements.

Publishing the source on GitHub and exposing a running service are different decisions. Secret scanning found no confirmed live credentials in the examined Git history or publishable working files. This review does not certify the application or establish that every dependency finding is remotely exploitable.

At the time of this audit, changes and image builds were local. The existing Compose deployment, its accounts, volumes and credentials were not upgraded or modified. Read-only inventory confirmed that the running app/frontend are still version 0.4.0 and the proxy still publishes ports 80/443 on all host interfaces. The new loopback defaults and application corrections take effect only after the corresponding containers are recreated. This review therefore does not clear that older running deployment.

## Scope and method

- Baseline: OpenBoard 0.6.0, Git commit `28626d2`, including the pending seven-language frontend and the fixes from this audit.
- Reviewed C authentication, HTTP parsing, sessions, CSRF, permissions, object ancestry, idempotency, SQL/BSON boundaries, imports, attachments, reviews, sprints and internal requests.
- Reviewed frontend rendering, Markdown, links, CSV, drafts, asynchronous responses, static routing, Docker Compose, bootstrap scripts and GitHub Actions.
- Used disposable authenticated SQLite fixtures, frontend VM tests and isolated PostgreSQL/MongoDB instances. No tests used the running application databases.
- Ran Clang Static Analyzer on all ten C source files, including a separate analysis with the external-storage implementation enabled.
- Ran Gitleaks 8.30.1 against all eight local Git commits and tracked/nonignored working files. The upstream download checksum was verified; deployment secret files were excluded from the working-file snapshot.
- Ran Docker Scout 1.25.0 on local Linux ARM64 images. Findings are a dated inventory, not a guarantee about future tags or other architectures.

## Confirmed application findings and fixes

| ID | Severity in this context | Finding | Correction and evidence |
| --- | --- | --- | --- |
| OB-SEC-01 | High | A request could retain an administrator role or session loaded before waiting for a writer lock or password hashing. Revocation could commit first, followed by a protected mutation using the old authorization. Creating another administrator was reproducible. | Recheck session, CSRF and required role inside the same transaction as the write. Applied to domain writes and account, password, membership and favorite mutations. Auth and domain regressions verify that revoked or demoted requests cannot write. |
| OB-SEC-02 | Medium | On a shared browser, a delayed board response authorized for account A could repopulate the interface after logout and login as B. A lost POST response could also lead to a retry with the new browser session. | Bind requests to an authentication generation and owner. Invalidate on authentication changes, discard stale successes/errors and prevent cross-session retries. Clear old views and filters; preserve drafts under their original owner. Tests exercise the real login/logout handlers, rendering and draft storage. |
| OB-SEC-03 | Medium | Idempotency replay returned a stored successful response before checking current resource permissions. A removed board member could retrieve an earlier sprint response with the same key. | Check current ACL, resource ancestry, ownership and action capabilities before replay. Keep keys and successful authorized responses; do not execute the original mutation again. Unknown cached route families fail closed. Tests cover membership removal, global-role changes, review eligibility, observer requests, personal resources and deleted ancestors. |
| OB-SEC-04 | Medium | Every HTTP connection was assigned the peer address 127.0.0.1. A client's login attempts consumed the IP quota used by unrelated clients, including a correct login from another address. | Read the actual TCP peer with `getpeername`. A test uses two distinct local source addresses and confirms that spoofed forwarding headers cannot reset the quota. Reverse-proxy aggregation and the global authentication budget remain limitations below. |

Relevant changes: [authentication](../src/auth.c), [transport](../src/http.c), [domain routing and replay](../src/server.c), [frontend](../web/app.js). Regression coverage: [auth](../tests/test_auth.py), [transport](../tests/test_transport.py), [domain](../tests/test_security_domain.py), [frontend](../tests/test_frontend.js), [external storage](../tests/test_cloud.py).

The replay permission gate covers domain creation/import/duplication/restore, columns and cards, comments/replies/reactions, attachments and work logs, fields and milestones, personal templates and reports, reviews, sprints, intake forms/fields/requests, subscriptions, notifications and personal session revocation. New POST families must explicitly add their permission checks before cached responses can be replayed. Account and membership endpoints handled by the authentication module do not use domain idempotency.

## Additional hardening

- HTTP and HTTPS proxy ports now default to `127.0.0.1`. Network publication requires `OPENBOARD_PUBLISH_IP=0.0.0.0` or `init-env.py --publish-ip 0.0.0.0`. The administration port remains on loopback. Compose tests resolve the real configuration with dummy credentials and verify these boundaries.
- The frontend image applies Alpine package updates during build. This updated zlib from 1.3.2-r0 to 1.3.2-r1 and removed its CVE-2026-85091 finding. The final frontend image scan reports no vulnerable packages.
- The C container build enables stack canaries, FORTIFY level 3, PIE, full RELRO, immediate symbol binding and a non-executable stack. ELF inspection confirmed the corresponding headers and symbols.
- The standalone Nginx example now allows the complete current static asset set, including translation and workflow assets, while retaining its explicit file whitelist.

## Dependency findings that remain open

The following are **package/CVE result counts**, including repeated advisory IDs when multiple installed packages or versions are affected. They do not represent distinct application exploits. Raw scanner reports were retained locally outside the repository; the [scan inventory](SECURITY_SCAN_2026-10-16.json) records image IDs, counts and high/critical package findings.

| Image examined | Total package findings | Critical | High | Other | Unique advisory IDs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Final OpenBoard backend | 52 | 0 | 1 | 51 | 52 |
| Final OpenBoard frontend | 0 | 0 | 0 | 0 | 0 |
| Nginx Proxy Manager 2.16.0 | 254 | 7 | 45 | 202 | 247 |
| PostgreSQL 17 Trixie | 122 | 4 | 33 | 85 | 122 |
| MongoDB 8.0 Noble | 121 | 7 | 46 | 68 | 103 |

Priority assessment:

1. **Proxy dependencies need review before Internet exposure.** NPM findings include OpenSSL, curl, Expat and Node/Python packages, with fixed versions available for several. The runtime `proxy-addr` finding must be assessed against the actual proxy trust configuration. Apache-related package findings do not prove that an Apache HTTP server is running. Do not suppress these findings merely because the image is an upstream release.
2. **Keep proxy administration private.** The published [NPM authentication rate-limit advisory](https://github.com/advisories/GHSA-pm9h-p429-j8c5) concerns password and second-factor guessing. The project's port 81 binding reduces remote exposure; it does not fix NPM itself. The [upstream change](https://github.com/NginxProxyManager/nginx-proxy-manager/pull/5908) was still open at review time, and [2.16.0 remained the latest release](https://github.com/NginxProxyManager/nginx-proxy-manager/releases/tag/v2.16.0).
3. **Assess database-image findings by execution path.** PostgreSQL's critical Go findings point to `gosu`; MongoDB findings also include administration tools. These are not evidence that the PostgreSQL or MongoDB server implements the affected Go HTTP/TLS paths. Database ports are unpublished on an internal Docker network. Update approved images and document reachability rather than treating either the raw count or network isolation as a complete verdict.
4. **Retain the backend zlib finding pending vendor resolution.** Debian labels CVE-2026-85091 as unfixed, while the reported affected range and upstream discussion raise a version-classification question for Debian's 1.3.1 package. OpenBoard does not call the affected non-blocking gzip writer functions. This is a reachability assessment, not an accepted vendor exemption. References: [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-85091), [upstream discussion](https://github.com/madler/zlib/issues/1310), [upstream correction](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148).

## Other residual risks and limits

- Behind a single NPM instance the backend sees the proxy's TCP address, so the 60-attempt IP budget is shared. Authentication also has an intentional global budget of 80 attempts per five minutes. An attacker can exhaust these budgets and temporarily prevent legitimate sign-ins. Add client-aware rate limiting and capacity controls at the perimeter before a public service. The backend deliberately does not trust arbitrary `X-Forwarded-For` or `X-Real-IP` headers.
- HTTP is suitable for the configured local origin. Internet access requires a real HTTPS origin, a valid certificate, forced HTTPS and the corresponding Secure session cookie. Configure both `OPENBOARD_PUBLIC_URL` and the proxy; changing one is insufficient.
- The external storage adapter serializes requests and publishes snapshots. Storage quotas, bounded request bodies and the worker queue do not establish resilience against sustained distributed traffic or large enterprise datasets.
- Browser-local drafts remain accessible to someone controlling the same OS/browser profile. Session isolation prevents delayed rendering across accounts; it is not encryption or isolation between mutually untrusted users sharing a browser profile.
- Attachment quotas do not cap total database size when deleted files are retained. Antivirus scanning, centralized abuse detection, MFA/SSO, a retention policy and high availability remain outside the implementation.
- Static analysis emitted conservative warnings for constant-format output, bounded `sscanf`, and the EOF/timeout use of `errno`. Review did not establish a memory-corruption issue from those warnings. No long-running coverage-guided fuzzing, independent penetration test, production network assessment or AMD64 image scan was performed.

## Secret-scan assessment

Gitleaks produced one finding in history and the corresponding current documentation finding: the example `Idempotency-Key` header in the API documentation. This is a public example request identifier, not a password, session, CSRF token or service credential. It was triaged without blanket suppressions or rewriting Git history. No confirmed live secret was detected. Local `.env` and `.env.local-admin` files have mode 0600 and are ignored by Git and the Docker build context.

BuildKit also emitted a name-based secret warning for `OPENBOARD_AUTH=true`. This value is an authentication configuration flag, not a credential; no database passwords or administrator credentials are baked into the images.

GitHub Actions uses read-only repository permissions, commit-pinned actions and checkout without persisted credentials. Container tests use disposable configuration and clean up their credentials and volumes. This audit did not include a remote workflow run of the reviewed working-tree changes.

## Validation

- Local Python integration suite: 176 checks passed; 13 optional checks were skipped in the recorded full run. The same 176 checks passed with AddressSanitizer and UndefinedBehaviorSanitizer.
- JavaScript: all five suites passed, including session-isolation regressions, escaping, CSV, workflow permissions and complete translation coverage.
- Hardened Linux backend image: isolated runtime smoke passed for startup, authentication, protected writes, localized initial lists and idempotency.
- Docker frontend: three isolated HTTP checks passed for exact assets, security headers, missing paths, API exclusion and write rejection.
- Deployment: three checks passed for private environment creation and the resolved default/explicit-public Compose boundaries.
- Real PostgreSQL/MongoDB validation: all 12 checks passed on disposable stores, including authenticated replay after membership revocation, fresh-cache reconstruction, migrations and recovery after a database outage.
- Both Docker images built. ELF hardening checks, Actionlint, ShellCheck, source analysis and `git diff --check` completed.

Re-run the suites against the exact commit and image digests selected for release. Refresh vulnerability data, resolve or explicitly approve the remaining dependency assessments, and validate TLS and perimeter limits before Internet deployment.
