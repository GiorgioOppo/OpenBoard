# Dependency refresh — 24 October 2026

This records the dependency selections for the unreleased development branch. Application version `0.6.1`, database schema 7 and the published `v0.6.1` tag are unchanged. The update preserves PostgreSQL 17, MongoDB 8.0 and Nginx Proxy Manager 2.16; it does not migrate or modify an existing installation.

## Updated selections

| Component | Previous selection | New selection | Primary provenance |
| --- | --- | --- | --- |
| Debian backend builder/runtime | `trixie-slim`, index `a29215f6a35e…` | Same suite, index `62bd423aeee9…` | [Official registry manifest](https://registry-1.docker.io/v2/library/debian/manifests/trixie-slim); full digest in [Dockerfile](../Dockerfile) |
| PostgreSQL base | `17.11-trixie`, index `2d2b8998d310…` | Same patch/data format, index `b8faeff77126…` | [Official registry manifest](https://registry-1.docker.io/v2/library/postgres/manifests/17.11-trixie); [Dockerfile.postgres](../Dockerfile.postgres) |
| Go builder/runtime for rebuilt tools | 1.26.9 | 1.26.10, index `632dff735179…` | [Go release](https://go.dev/doc/devel/release#go1.26.10), [official image manifest](https://registry-1.docker.io/v2/library/golang/manifests/1.26.10-bookworm) |
| `golang.org/x/net` | 0.60.0 | 0.61.0 | [Official source tag](https://go.googlesource.com/net/+/refs/tags/v0.61.0); explicit module/archive checksums in [build-mongo-tools.sh](../scripts/build-mongo-tools.sh) |
| Node.js in the proxy | Upstream base 22.23.2 | 22.23.4; APT `22.23.4-1nodesource1` | [Official release index](https://nodejs.org/dist/index.json), [NodeSource amd64 metadata](https://deb.nodesource.com/node_22.x/dists/nodistro/main/binary-amd64/Packages.gz), [arm64 metadata](https://deb.nodesource.com/node_22.x/dists/nodistro/main/binary-arm64/Packages.gz) |
| npm CLI | 12.2.0 | 12.2.1 | [Official registry metadata](https://registry.npmjs.org/npm/12.2.1) |
| undici overlay in npm and NPM/node-gyp | 6.28.1 | 6.29.1 | [Official registry metadata](https://registry.npmjs.org/undici/6.29.1); pinned SHA-512 in [patch-npm-bundle.mjs](../scripts/patch-npm-bundle.mjs) |
| pip in the Certbot environment | 26.2.1 | 26.2.2 | [PyPI release metadata](https://pypi.org/pypi/pip/26.2.2/json); immutable wheel URL/SHA-256 in [Dockerfile.npm](../Dockerfile.npm) |
| `actions/setup-python` | 7.0.0 | 7.1.0, commit `6d4fd22b20465ccc0f7354476588e8df7c9ca0e0` | [Official release](https://github.com/actions/setup-python/releases/tag/v7.1.0) |

The Docker index bodies were hashed and compared with the registry digests. Linux amd64/arm64 child manifests and image configuration were also checked; PostgreSQL's restored metadata remains `PG_VERSION=17.11-1.pgdg13+2`. Full digests remain in the build files rather than using moving tags alone.

Go 1.26.10 is the maintained patch line already used by these builders. Go 1.27.3 was available at review time; adopting the newer minor toolchain is separate from this patch refresh. Updating x/net selects x/crypto 0.58.0, x/sys 0.49.0, x/term 0.47.0, x/text 0.43.0 and x/sync 0.24.0 in the verified build graph. The Database Tools source stays 100.19.1 and the rebuilt identity becomes `100.19.1-openboard.2` to distinguish the changed runtime/module graph.

Node stays within the 22.x ABI (`NODE_MODULE_VERSION=127`). The upstream NPM image already installs NodeSource's 22.x package; the overlay makes the selected package and runtime assertion explicit. The build retains native bcrypt/SQLite tests after the update. npm CLI, NPM application dependencies and pip's vendored namespace remain separately patched and verified; package-manager updates do not remove the existing dependency overlays or licenses.

## Reviewed and retained

The following selections were already the latest published compatible choices at review time:

- PostgreSQL 17.11, MongoDB 8.0.34 and NPM application 2.16.0.
- gosu 1.19, Database Tools 100.19.1, js-yaml 3.15.2 on the compatible 3.x API, and x/net as selected above.
- pyOpenSSL 26.4.0 with cryptography 50.0.2; pip-vendored replacements msgpack 1.2.3 and urllib3 2.8.0.
- proxy-addr 2.0.8, basic-ftp 6.2.3, brace-expansion 5.0.12 and http-cache-semantics 4.3.0.
- utf8proc 2.12.0/Unicode 18.0.0, checkout 7.0.1, setup-node 7.1.0, upload-artifact 7.0.2 and Gitleaks 8.30.1.

The NPM 2.16.0, MongoDB 8.0.34 and frontend 1.31.7 image indexes matched their existing pins. NGINX itself had [released 1.31.8](https://nginx.org/news.html), but the selected `nginxinc/nginx-unprivileged:1.31.8-alpine-slim` image was not published in the registry. `mongo:8.0.35-noble` was also unavailable. The build therefore retains the real published tags rather than referencing prospective versions. See [PostgreSQL 17 releases](https://www.postgresql.org/docs/17/release.html), [MongoDB 8.0 notes](https://www.mongodb.com/docs/v8.0/release-notes/8.0/) and the [NPM release](https://github.com/NginxProxyManager/nginx-proxy-manager/releases/tag/v2.16.0).

## Container runner compatibility

The preceding [failed run](https://github.com/GiorgioOppo/OpenBoard/actions/runs/40075513299) used Ubuntu 26.04 through `ubuntu-latest`; the [preceding successful run](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39959611287) used Ubuntu 24.04. MongoDB 8.0.34 terminated during `mongod --version`, before the integration tests. The known Ubuntu-specific kernel release check is tracked by [SERVER-131779](https://jira.mongodb.org/browse/SERVER-131779); the general kernel incompatibility is described in the [MongoDB notice](https://www.mongodb.com/docs/v8.0/release-notes/8.0/).

Only the container job now selects `ubuntu-24.04` and records `uname` plus `/proc/version_signature` where available. Native Linux/macOS coverage and the fuzz job retain their current runner choices. MongoDB's smoke test remains in place. This CI host selection does not change an operator's Docker host or prove that an existing kernel is supported. Revisit the pin when the compatible MongoDB patch is actually published and validated.

## Verification and boundaries

The update was prepared without starting Docker or using an existing installation's environment, databases, volumes or credentials. Local checks used isolated temporary artifacts:

- Eight actual MongoDB Tools built with Go 1.26.10, CGO, GSSAPI, failpoints and PIE on macOS arm64; all version/help commands, build metadata and a synthetic BSON parse passed. gosu cross-built for Linux arm64 with its upstream version identity retained. Its Linux execution remains a container check.
- The actual upstream NPM 2.16.0 production dependency tree passed Yarn installation and offline integrity checks. The updated verification script ran using the official Node.js 22.23.4 runtime in temporary paths: bcrypt hashing, both SQLite bindings and the proxy/glob/FTP/URI/cache APIs passed. The patched npm CLI ran registry requests; selected package and runtime lock integrity checks passed. These native checks were macOS arm64, not a Linux container proof.
- A temporary Python environment installed pip 26.2.2 and the retained TLS pair, ran the real vendoring patch and `pip check`, and verified TLS/RSA, msgpack round trips, urllib3, licenses, BOM/purls and 638 installed-file RECORD hashes.
- Full native discovery ran 338 tests: 312 passed and 26 optional integrations were skipped, normally (80.637 seconds) and with ASan/UBSan (106.600 seconds). All 16 frontend suites, proxy-limiter, documentation/ASVS reference, Actionlint, shell/JavaScript syntax and whitespace checks passed. Gitleaks scanned 269 publishable source files locally with zero findings; ignored environments, builds and private artifacts were excluded.

The full five-image Linux build, real-store scenarios, image authentication/backup tools, loaded NPM routing and proxy/static integration must run against the exact candidate in CI. A default locally skipped container test is not a passing image check. Distribution package upgrades still resolve at build time; this report is neither a complete SBOM, a fully reproducible OS package snapshot nor a fresh vulnerability scan of final images. Dated security inventories continue to describe their original artifacts. See [Testing](TESTING.md), [Deployment](DEPLOYMENT.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).
