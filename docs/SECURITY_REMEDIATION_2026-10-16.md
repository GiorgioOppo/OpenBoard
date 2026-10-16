# Security remediation — 16 October 2026

This dated follow-up records corrections to the 0.6.0 snapshot examined in the [pre-publication audit](SECURITY_AUDIT_2026-10-16.md). The 0.6.1 candidate includes those fixes and publication documentation; its CI evidence is linked from the [release process](RELEASING.md). Measurements below concern disposable local Linux ARM64 images, not the existing running deployment. No application accounts, database volumes or deployment credentials were changed by these checks. Source publication and Internet deployment remain separate decisions.

## Database image corrections

The original PostgreSQL and MongoDB images already contained current compatible server releases, PostgreSQL 17.11 and MongoDB 8.0.34. Updating only their operating-system packages would leave statically compiled Go vulnerabilities in `gosu` and the MongoDB Database Tools.

The derived images now:

- Rebuild the unchanged gosu 1.19 source using the supported Go 1.26.9 security release. The gosu package identity remains `v1.19.0`; its version and debug metadata remain available to scanners and binary reachability tools. The upstream metadata shim is pinned and checksum verified.
- Rebuild all eight MongoDB Database Tools from the official 100.19.1 source, with Go 1.26.9 and `golang.org/x/net` 0.60.0. The tools report `100.19.1-openboard.1` to identify the local dependency patch. GSSAPI support and native Go TLS remain enabled; no backup or administration tools were removed.
- Update MongoDB's js-yaml browser bundle to 3.15.2, preserving the entrypoint's existing 3.x API and `/js-yaml.js` symlink. An actual startup using a YAML server configuration passed.
- Apply available APT updates and retain package records and licenses. Remote source archives, the YAML bundle and the metadata shim have pinned SHA-256 checksums; Go module downloads use their checksums and the Go checksum database.
- Publish the complete patched filesystem in a final stage, retaining upstream environment variables, entrypoint, command, volumes, exposed ports and PostgreSQL's `SIGINT` stop signal. This excludes superseded vulnerable binaries from distributed lower layers without deleting current tools or suppressing scanner findings.

The last point matters for the evidence: an intermediate layered image had the corrected runtime binaries but still distributed their vulnerable predecessors in lower layers. Scout reported both. The final images physically exclude those obsolete copies and were scanned again without ignore, severity or VEX filters.

Implementation: [PostgreSQL Dockerfile](../Dockerfile.postgres), [MongoDB Dockerfile](../Dockerfile.mongo), [gosu builder](../scripts/build-gosu.sh), [MongoDB tools builder](../scripts/build-mongo-tools.sh).

Primary upstream references: [official PostgreSQL image](https://github.com/docker-library/postgres/blob/2603e26e245e558218728ee14e0a42dcb020dc7f/17/trixie/Dockerfile), [official MongoDB image](https://github.com/docker-library/mongo/blob/ea5191cbb2fe8958dc3e8dd0364b6d1f0d1b61a1/8.0/Dockerfile), [Go security release](https://go.dev/doc/devel/release#go1.26.9), [MongoDB tools release](https://github.com/mongodb/mongo-tools/blob/100.19.1/CHANGELOG.md), [js-yaml release](https://github.com/nodeca/js-yaml/releases/tag/3.15.2), [gosu build and scanner metadata](https://github.com/tianon/gosu/blob/1.19/Dockerfile).

## Verified image identities and platform support

All three pinned bases are **multiarchitecture OCI indexes**, verified with `docker buildx imagetools inspect`, and include both `linux/amd64` and `linux/arm64`. These pins therefore support the Ubuntu AMD64 CI runner and the local ARM64 builder. This verification does not replace building and testing each target architecture; the measurements in this report are ARM64 only.

| Base | Pinned OCI index digest |
| --- | --- |
| `postgres:17.11-trixie` | `sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3` |
| `mongo:8.0.34-noble` | `sha256:0dc2511c4261bffa84f5af2c7df2aae148c0bea68d9b0aacd85c3d7be07e0583` |
| `golang:1.26.9-bookworm` | `sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c` |

Final local QA identities:

| Artifact | PostgreSQL | MongoDB |
| --- | --- | --- |
| Local tag | `openboard-postgres:security` | `openboard-mongo:security` |
| Image index digest | `sha256:b7fdc40f5f4d5a51485054e1d51fb2f6c08ed6e804d3fb64ff61f07fe5046466` | `sha256:922a790e32940589b4edaa5c18001d5c27ec6b6367d9961feb3b9e6f47ad72d4` |
| ARM64 manifest digest | `sha256:613c4d1c60eeec33f2f09d416ac55454628de9f3c895d4c6db316fd58185c568` | `sha256:f48454999752c79999cc8f0eab797ec2022039960ea7def601aab0a390f7a795` |
| Image config digest | `sha256:399dd026d3cfd23949735028774749b47e226e06ecb4d722ece3c45e32afaa57` | `sha256:9b5f3b5c691342d752fd2537da3f3ed9988ca42c1a470ad3b42a2a6e91963c68` |

APT security repositories remain live so subsequent builds can receive vendor fixes. A later rebuild can therefore have a different final digest; scan and test that exact artifact before release.

## Database validation

All four opt-in tests in [test_database_images.py](../tests/test_database_images.py) passed against the final images in 16.305 seconds. Each fixture creates uniquely named containers with tmpfs databases, no network access and no published ports. It never attaches existing volumes, and removes its own containers after the tests.

Coverage includes fresh official-entrypoint initialization with the project's actual account initialization scripts, application authentication, incorrect-password rejection, PostgreSQL least-privilege role attributes, database backup/restore, Unicode, JSON zero/false/null values and nested objects, restored primary-key enforcement, all eight MongoDB tools, and YAML bundle compatibility.

```sh
docker build -f Dockerfile.postgres -t openboard-postgres:security .
docker build -f Dockerfile.mongo -t openboard-mongo:security .
OPENBOARD_POSTGRES_IMAGE=openboard-postgres:security \
OPENBOARD_MONGO_IMAGE=openboard-mongo:security \
python3 -m unittest discover -s tests -p test_database_images.py -v
```

ShellCheck passed for both builder scripts, and `git diff --check` passed. No running production database was upgraded by these commands.

## Database scan results

Docker Scout 1.25.0 scanned the original and corrected images on 16 October 2026. Counts are **package/advisory results**, not proven application exploits. The scanner was run without suppression or exclusion options.

| Image | Total before → after | Critical before → after | High before → after | Remaining severities |
| --- | ---: | ---: | ---: | --- |
| PostgreSQL 17 | 122 → 64 | 4 → 0 | 33 → 3 | 7 medium, 54 low |
| MongoDB 8.0 | 121 → 40 | 7 → 0 | 46 → 0 | 27 medium, 12 low, 1 unspecified |

The corrected PostgreSQL report contains 64 distinct advisory IDs; the corrected MongoDB report contains 40. All critical database-image findings from the original audit are absent from these final scans. Lower-severity results still require ordinary maintenance and assessment.

The [original inventory](SECURITY_SCAN_2026-10-16.json) and [follow-up inventory](SECURITY_SCAN_REMEDIATION_2026-10-16.json) are versioned publication evidence. They identify the examined artifacts, counts, high/critical results and raw SARIF hashes. Raw workstation logs and reports were not published; temporary local paths are not release evidence. Review the linked source/build recipes and rerun the checks for a newly built release artifact.

Reproduce final vulnerability checks with:

```sh
docker scout cves local://openboard-postgres:security --format sarif \
  --output /tmp/openboard-postgres-security.sarif
docker scout cves local://openboard-mongo:security --format sarif \
  --output /tmp/openboard-mongo-security.sarif
```

## PostgreSQL high-severity residuals

These three results remain visible. No blanket exception or replacement of PostgreSQL's required library ABI was applied.

| Advisory | Installed source package | Assessment and release consequence |
| --- | --- | --- |
| [CVE-2026-86140](https://security-tracker.debian.org/tracker/CVE-2026-86140) | libxml2 `2.12.7+dfsg+really2.9.14-2.1+deb13u3` | The upstream issue is a stack overflow in `xmlSnprintfElements`; the fix is in libxml2 2.15.4. Debian Trixie still reports the package as vulnerable. OpenBoard's adapter does not issue XML operations, but PostgreSQL supports XML queries and this library is present. Private networking and database authentication reduce exposure; they do not establish that the package is safe for arbitrary SQL/XML clients. A vendor backport or separately validated compatible patch is still required. |
| [CVE-2026-74860](https://security-tracker.debian.org/tracker/CVE-2026-74860) | Same libxml2 package | The advisory concerns Python SAX bindings, specifically a double free in the attribute-declaration callback. The final image has no installed `python3-libxml2` package or `libxml2mod`/`libxml2.py` binding files. This establishes an absent affected execution component for the examined image, while Scout still reports the vulnerable source package. Adding Python bindings invalidates this assessment. Retain the result pending vendor resolution or an explicitly reviewed component-specific exception. |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091) | zlib `1:1.3.dfsg+really1.3.1-1+b1` | The published description concerns nonblocking gzip writer handling introduced in upstream 1.3.1.2, while this Debian package contains upstream 1.3.1. Debian nevertheless marks the source package as unfixed. OpenBoard does not call `gzwrite`, `gzprintf` or `gzvprintf`; this does not audit every PostgreSQL/library caller. Keep the discrepancy visible until vendor classification or an approved compatible fix resolves it. |

The libxml2 2.15 series changes the shared-library ABI relative to the package used by the PostgreSQL base. Installing an unrelated distribution's library or replacing the server major version solely to lower the scan count would require additional compatibility and migration work. Neither was done here.

Further primary evidence: [libxml2 overflow correction](https://gitlab.gnome.org/GNOME/libxml2/-/commit/d1686f91dbda141a752200419d35639fd6b38340), [Python binding correction](https://gitlab.gnome.org/GNOME/libxml2/-/commit/f41e1865781f74d1cadfe2fbdfeefed946026f12), [zlib correction](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148), [zlib affected-range discussion](https://github.com/madler/zlib/issues/1310).

## Authentication and transport follow-up

The C backend now accepts an optional, single trusted IPv4 peer in `OPENBOARD_TRUSTED_PROXY` or `--trusted-proxy`. Only a connection from that exact TCP address may supply client identity through one numeric `X-Real-IP` header. Missing, duplicate, malformed or multi-address trusted headers are rejected. Headers from other peers cannot change their identity. IPv6 client addresses and IPv4-mapped addresses are canonicalized; forwarded chains and zone identifiers are not accepted.

Authentication accounting no longer has a global 80-attempt bucket shared by unrelated clients, or an exhaustible username table. Fixed-size, keyed counter tables reserve attempts under a mutex and enforce 60 per IP and 10 per IP/scope/username in five-minute monotonic windows. New usernames cannot evict another user's quota. Counters saturate, and older concurrent timestamps cannot roll back the active window. This is a fixed-window limit, so two adjacent windows may allow two budgets near a boundary; it is not protection against a distributed botnet. Hash collisions can conservatively reject an attempt early.

The regression suite covers actual socket identity, trusted/untrusted headers, malformed IP variants, cross-client quotas, fixed-memory collisions, saturation, expiry, backward timestamps and concurrent reservations. The earlier session-revocation, authorization-before-idempotency-replay and frontend account-isolation fixes remain covered.

The complete Python suite passed: 220 tests, 21 optional checks skipped; the same suite passed with AddressSanitizer and UndefinedBehaviorSanitizer. Later deployment-only changes passed all 18 deployment tests and 9 bootstrap tests. All five frontend Node suites and the NPM limiter suite passed. Twelve external-storage tests passed against the rebuilt PostgreSQL/MongoDB images, including cold caches, authorization revocation, JSON types, outage/retry behavior, backups and schema migration. The versioned follow-up inventory records these dated results. The [testing guide](TESTING.md) gives the current commands; use the candidate's CI run for release verification.

## Reverse proxy follow-up

The derived NPM image retains the upstream 2.16.0 application and Node 22 runtime. Its base is pinned to multiarchitecture index `sha256:4393e642e233e5efd5adeb7f10918d4aaea71c9ed875b94190273fc8e87f9594`. Available distribution updates are applied. The application dependency overlay pins proxy-addr 2.0.8, basic-ftp 6.2.3, brace-expansion 5.0.12 and node-gyp's undici 6.28.1; its other locked dependencies and native SQLite/bcrypt modules are retained. npm 12.2.0's bundled copies also receive the actual, integrity-verified brace-expansion 5.0.12, undici 6.28.1 and http-cache-semantics 4.3.0 code, recorded in its regenerated runtime lock.

Certbot retains its existing certificate/DNS-provider workflow. pyOpenSSL 26.4.0 and cryptography 50.0.2 are installed together because the older pyOpenSSL upper bound rejects the fixed cryptography release. pip's real vendored msgpack and urllib3 implementations are updated to 1.2.3 and 2.8.0, including package versions, vendor inventory and wheel RECORD checksums. Its pkg_resources subset remains honestly identified as setuptools 70.3.0; the vulnerable `package_index.py` implementation is absent. No scanner metadata was falsified.

The defensive overlay removes implicit private-network/CDN trust and restricts Express proxy trust to loopback. Nginx overwrites forwarded addresses with the actual peer, ignores incoming scheme claims and caps request bodies at 2 MiB. OpenBoard's API routes enforce 8 concurrent connections per client and 32 per virtual host. Login, setup and password changes additionally receive a 5/minute per-client nginx limit with burst 10 and HTTP 429. NPM login, second factor and user creation receive a bounded 10-attempt, five-minute per-IP/route limiter before body parsing or file upload. Tests explicitly cover NPM's removal of the `/api` prefix before Express routing, so the public and internal route aliases share the same quota.

Local dependency smoke checks passed for bcrypt, both SQLite modules, module imports, FTP transfer through get-uri, npm registry/cache operations and CachePolicy. `pip check`, pip download and a disposable Certbot Cloudflare plugin installation/loader check passed; no certificate was requested.

The last completed NPM scan measured **188 package/advisory results: 3 critical, 15 high, 11 medium, 159 low**, down from 254 (7 critical, 45 high). That scan refers to the predecessor image with config digest `sha256:2f6f7d3517770b02c33e69638a1c65208dc4b7dce37b15094203d558bd0baa92`. The final image additionally fixes the remaining npm CLI http-cache-semantics 4.2.0 copy and corrects the middleware's internal route aliases. **The final image has not been rescanned; 188 is not its measured vulnerability count.** The machine-readable [follow-up inventory](SECURITY_SCAN_REMEDIATION_2026-10-16.json) separates measured images from local verification and subsequent changes.

The penultimate scan's three critical and twelve high Apache findings concern HTTP-server modules. This image includes only `apache2-utils` for NPM's `htpasswd` access-list function; the Apache server and these modules are absent. The critical advisories specifically concern [mod_rewrite](https://security-tracker.debian.org/tracker/CVE-2026-56154), [mod_http2](https://security-tracker.debian.org/tracker/CVE-2026-57941) and [mod_ssl](https://security-tracker.debian.org/tracker/CVE-2026-59797). These are component-specific assessments, not a blanket statement that every Apache-source-package finding is harmless. The other high results were [setuptools PackageIndex](https://github.com/advisories/GHSA-5rjg-fvgr-3xxf), vendor-unfixed zlib and the now-replaced http-cache-semantics copy. The high/critical results remain listed in the versioned inventory without suppression.

Final NPM local QA image index: `sha256:7590434c40735460e1c86b34595a496842597e56581e44885d4d2711cb55460a`. The original backend OS package inventory and the corrected backend inventory are identical (109 packages). Its previously measured 52 findings, including the one vendor-unfixed zlib high result, remain a baseline rather than a fresh scan. The unchanged frontend retains its previous zero-finding scan. A further external scan was not authorized during this review, because it may transmit image metadata/SBOM. No substitute upload was performed; a fresh external scan requires the owner's explicit authorization.

## Deployment and release gate

Compose now builds all five project images. The proxy has a fixed IPv4 address outside the dynamic frontend address pool; the backend's trusted peer must match it. The first full-stack test exposed a Docker address-allocation collision, which is corrected by reserving the lower half of the subnet for static addresses and using the upper half for dynamic allocations. `init-env.py` derives and validates this layout. Existing installations changing subnet must recreate the affected network during a planned interruption while preserving volumes.

The local bootstrap consumes the shared [API proxy configuration](../deploy/npm/openboard-api.conf). Its explicit `--upgrade-proxy` mode only upgrades the exact legacy host generated by this project, preserving its ID and private administrator credentials; manually altered hosts are refused. The normal bootstrap remains idempotent.

The read-only preflight checks resolved Compose configuration and actual container bindings, both administrators, runtime origin, backend authentication/trusted-peer configuration, live storage readiness, actual `nginx -T` includes and the intended virtual host's limits/headers. For HTTPS it checks the certificate through loopback with trusted CA validation and the public hostname's SNI, and requires an exact HTTP-to-HTTPS redirect. A nonstandard HTTPS port may require a custom NPM redirect because the standard Force SSL redirect can omit that port. `--config-only` does not establish runtime readiness.

CI builds all five images on AMD64, tests database image initialization/backup tools, runs the preflight and the real NPM/client-isolation tests, and removes its disposable stack and credentials. Actionlint and ShellCheck passed locally. The full stack was also started using the final image identities on an unused subnet with temporary loopback ports, new volumes and private temporary credentials; initialization, repeated bootstrap, an actual legacy proxy upgrade preserving the host ID/credential file, and the full preflight passed. All three opt-in proxy tests passed against the final NPM image in 11.072 seconds: loaded nginx configuration, anonymous API rejection, spoofed headers, nginx-generated 429 responses, independent clients and the NPM console limiter. These checks supplement the ARM64 dependency measurements. AMD64 validation was pending when these measurements were recorded; consult the candidate's [CI run](https://github.com/GiorgioOppo/OpenBoard/actions/workflows/ci.yml) for subsequent platform checks.

Before Internet publication, review the visible residual findings, obtain a fresh authorized scan of the exact release images, configure a real HTTPS origin and certificate, initialize administrators privately, verify backups, and require a successful full preflight. These corrections and tests do not clear every dependency finding or update the existing running deployment.
