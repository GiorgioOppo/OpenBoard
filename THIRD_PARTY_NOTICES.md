# Third-party components and licenses

OpenBoard's original code, interface, documentation and deployment scripts are licensed under the [MIT license](LICENSE), copyright © 2026 OpenBoard contributors. Third-party software retains its own copyright notices and license terms. The MIT license of this repository does not relicense its databases, runtime libraries, container distributions or bundled dependencies.

This inventory identifies the main components used by the supplied build and deployment files. It is not a complete software bill of materials or a substitute for the license and notice files accompanying each artifact. Versions below identify an explicitly selected source or an upstream license reference; distribution-managed versions must be checked in the exact image being released. License references were reviewed on 2026-10-16.

## Backend libraries and databases

| Component | Use in OpenBoard | Upstream terms and source |
| --- | --- | --- |
| SQLite | Local persistence and the reconstructible cache used with external storage | The SQLite deliverable code and documentation are dedicated to the public domain. See the [SQLite copyright statement](https://www.sqlite.org/copyright.html). Build tools may have separate terms. |
| OpenSSL 3.x, including libcrypto | Password hashing, secure randomness and cryptographic operations in the C backend | Apache-2.0. See the [OpenSSL 3.5 license](https://github.com/openssl/openssl/blob/openssl-3.5.4/LICENSE.txt). The installed package version is resolved by the distribution. |
| PostgreSQL and libpq | Structured data and the PostgreSQL C client | PostgreSQL License. See the [PostgreSQL license](https://www.postgresql.org/about/licence/) and [PostgreSQL 17.11 copyright file](https://github.com/postgres/postgres/blob/REL_17_11/COPYRIGHT). |
| MongoDB Community Server 8.0 | JSON document storage in the Docker deployment | SSPL-1.0. See the [8.0 Community Server license](https://github.com/mongodb/mongo/blob/v8.0/LICENSE-Community.txt) and [MongoDB licensing FAQ](https://www.mongodb.com/legal/licensing/server-side-public-license/faq). |
| MongoDB C driver, including libmongoc and libbson | MongoDB access from the C backend; selected by `pkg-config` and the distribution | Apache-2.0 for the driver. See the [driver license](https://raw.githubusercontent.com/mongodb/mongo-c-driver/1.30.6/COPYING). Bundled dependencies have their own notices. |

MongoDB Community Server's SSPL is distinct from the Apache license of the C driver and Database Tools. MongoDB states that SSPL is not OSI-approved. Its FAQ also distinguishes offering MongoDB functionality as a service from using MongoDB as the database of another SaaS application. These distinctions do not change the MIT license of OpenBoard's original code. Consult the linked server terms for the intended use and for redistribution of a MongoDB-containing image.

## Proxy, frontend server and rebuilt tools

| Component | Use and selected source | Upstream terms and source |
| --- | --- | --- |
| Nginx Proxy Manager | Proxy administration and certificate workflows; upstream application 2.16.0 with the documented OpenBoard overlay | MIT. See [NPM 2.16.0 LICENSE](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/v2.16.0/LICENSE). This identifies the NPM application, not every package in its image. |
| NGINX | Static frontend server; also a component of the proxy's OpenResty distribution | BSD-2-Clause. See the [NGINX license](https://nginx.org/LICENSE). OpenResty, its modules and other proxy packages retain their own notices. |
| gosu | User switching in the PostgreSQL and MongoDB images; 1.19 rebuilt with Go 1.26.9 | Apache-2.0. See [gosu 1.19 LICENSE](https://github.com/tianon/gosu/blob/1.19/LICENSE). |
| Go | Toolchain and runtime used to rebuild gosu and MongoDB Database Tools | BSD-3-Clause for the Go project. See [Go 1.26.9 LICENSE](https://github.com/golang/go/blob/go1.26.9/LICENSE). Included modules retain their own licenses. |
| MongoDB Database Tools | Rebuilt 100.19.1 tools: `bsondump`, `mongodump`, `mongorestore`, `mongoimport`, `mongoexport`, `mongostat`, `mongotop`, `mongofiles` | Apache-2.0, verified in [Database Tools 100.19.1 LICENSE.md](https://raw.githubusercontent.com/mongodb/mongo-tools/100.19.1/LICENSE.md). This is separate from the Community Server license. |
| `golang.org/x/net` | Version 0.60.0 selected when rebuilding Database Tools | BSD-3-Clause. See [x/net 0.60.0 LICENSE](https://raw.githubusercontent.com/golang/net/v0.60.0/LICENSE). |
| js-yaml | Compatible 3.x bundle used by the MongoDB image's initialization path; version 3.15.2 | MIT. See [js-yaml 3.15.2 LICENSE](https://github.com/nodeca/js-yaml/blob/3.15.2/LICENSE). |
| Node.js | NPM's backend runtime; also used for OpenBoard's development tests | MIT for Node.js itself, with separately licensed incorporated components. See the complete [Node.js 22.23.2 license and bundled notices](https://github.com/nodejs/node/blob/v22.23.2/LICENSE). |
| npm CLI | Version 12.2.0 in the proxy image, with selected dependency replacements | Artistic-2.0 for the npm application. Dependencies retain their own terms. See [npm 12.2.0 LICENSE](https://github.com/npm/cli/blob/v12.2.0/LICENSE). |
| Certbot | NPM certificate and DNS-provider workflows | Apache-2.0 for the ACME client; its license also identifies MIT-licensed nginxparser code. See [Certbot LICENSE.txt](https://github.com/certbot/certbot/blob/master/LICENSE.txt). DNS plugins and their dependencies have individual licenses. |
| pip | Python package management in the proxy's Certbot environment | MIT for pip itself. See [pip LICENSE.txt](https://github.com/pypa/pip/blob/main/LICENSE.txt). Vendored packages retain separate terms. |
| cryptography | Version 50.0.2 selected in the Certbot environment | Apache-2.0 OR BSD-3-Clause for the project. See the [license choice](https://github.com/pyca/cryptography/blob/50.0.2/LICENSE), [Apache license](https://github.com/pyca/cryptography/blob/50.0.2/LICENSE.APACHE) and [BSD license](https://github.com/pyca/cryptography/blob/50.0.2/LICENSE.BSD). Wheels and native dependencies also contain third-party notices. |
| pyOpenSSL | Version 26.4.0 selected alongside cryptography | Apache-2.0. See [pyOpenSSL 26.4.0 LICENSE](https://github.com/pyca/pyopenssl/blob/26.4.0/LICENSE). |

The OpenBoard frontend uses locally supplied HTML, CSS, JavaScript and translation catalogs. Node.js is a development/test dependency for that frontend, not its production server runtime. Nginx Proxy Manager has its own Node and Python dependency trees; their terms are independent of OpenBoard's frontend.

## Dependency overlays and provenance

The following files record the source selections and modifications made by this repository:

- [Dockerfile](Dockerfile) selects distribution packages for the C backend; [Dockerfile.frontend](Dockerfile.frontend) selects the frontend server image.
- [Dockerfile.postgres](Dockerfile.postgres) and [Dockerfile.mongo](Dockerfile.mongo) identify their base images and copy the rebuilt tools.
- [build-gosu.sh](scripts/build-gosu.sh) pins and verifies the gosu source archive and build metadata helper.
- [build-mongo-tools.sh](scripts/build-mongo-tools.sh) pins and verifies the Database Tools source archive and js-yaml package, selects x/net 0.60.0, and records the tool build arguments.
- [Dockerfile.npm](Dockerfile.npm), [patch-npm-dependencies.mjs](scripts/patch-npm-dependencies.mjs) and [patch-npm-bundle.mjs](scripts/patch-npm-bundle.mjs) record the NPM base and JavaScript dependency overlay. Replacement packages include proxy-addr, basic-ftp, brace-expansion, undici and http-cache-semantics; each package's own license and notices still apply.
- [patch-pip-vendor.py](scripts/patch-pip-vendor.py) records the integrity-verified msgpack 1.2.3 and urllib3 2.8.0 replacements, retaining their license files and updating pip's vendor inventory and file records. pip's remaining vendored packages, including its pkg_resources subset, retain their own notices.
- [deploy/npm/harden.py](deploy/npm/harden.py) and [auth-rate-limit.mjs](deploy/npm/auth-rate-limit.mjs) contain the proxy configuration and middleware overlay. The [remediation report](docs/SECURITY_REMEDIATION_2026-10-16.md) describes its scope.

Upstream source links identify the relevant projects and, where available, the selected tags. These links are useful provenance references; a moving branch or a generic project link is not a complete archive of the corresponding source for an exact binary release.

## Operating-system and bundled licenses

Debian, Ubuntu and Alpine images contain additional independently licensed software, including system libraries, Python, shell tools, compression libraries, TLS dependencies and certificate data. Go binaries incorporate modules; Node.js, npm, Python wheels, Certbot plugins and the proxy application also bundle or install other components. A top-level application license does not replace those terms.

Retain the complete license, copyright and NOTICE files supplied with these components. Debian/Ubuntu package notices are commonly installed under `/usr/share/doc/<package>/copyright`; other distributions and language packages use their own license directories, package metadata and `LICENSE*`/`NOTICE*` files. An SBOM should describe the exact built image and supplement these original notices, rather than replace them.

## Before distributing binaries or container images

For each released artifact, record its exact digest, package versions, build inputs and OpenBoard changes. Include the required upstream license texts, notices, modification statements and applicable source-access information with the distribution. Where a component requires corresponding source or an offer of source, provide the required material and access method for that exact artifact, including relevant build scripts and modifications. Review the SSPL terms for a redistributed MongoDB server and the terms of bundled operating-system and language packages.

The source build recipes in this repository and this component summary do not by themselves establish that a prebuilt image has every required redistribution notice or source deliverable. Publishing such artifacts requires a separate check of their actual contents. Keep this inventory current when changing base images or dependencies.
