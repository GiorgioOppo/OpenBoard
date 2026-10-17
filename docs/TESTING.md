# Testing

Run checks from the repository root. Tests use local servers and temporary data; never point integration tests at a personal or production database. CI results apply to the tested commit and artifacts only.

## Default checks

```sh
make EXTERNAL_STORAGE=0
make test EXTERNAL_STORAGE=0
make test-sanitize EXTERNAL_STORAGE=0
make test-frontend
make test-security
make test-docs
```

The Python suite covers API/domain behavior, authentication, permissions, concurrency, migrations, quotas and HTTP transport. The sanitizer target checks C behavior with AddressSanitizer and UndefinedBehaviorSanitizer. The frontend target checks generated translations, source coverage, escaping, data formats, account isolation and panel workflows. The security target checks the NPM authentication limiter independently of Docker.

Unreleased regressions additionally cover incremental change tracking, MongoDB document validation, coalesced session activity, opt-in idempotency retention, content-bound approvals, paginated search, private credential files, backup crypto/integrity/signal cleanup and an isolated benchmark. `test_experience.js` exercises command/calendar/draft/tab interaction. Synthetic DOM/IME tests are not a complete browser/accessibility assessment.

The earlier collaboration/import/table block added `test_content_search.py` (nine HTTP cases), `test_field_filters.py` (six), and `test_import_formats.py` (three authenticated conversion/import cases). The import round trips require Node.js; set `NODE=/absolute/path/to/node` if it is outside `PATH`. Its normal and sanitizer discovery with native storage drivers ran 311 tests, with 285 passing and 26 optional integrations skipped, on 17 October 2026. These local runs do not exercise real external stores or containers.

That block ran 13 frontend suites. Its additions exercise the pure Trello/CSV converters, the real import handlers/API client, typed custom-field predicates/toolbar, editable table renderer/handlers and collaborative search. They cover literal formula text, invalid UTF-8, mapping/omission warnings, atomic-import compatibility, safe snippets, stable typed cursors, role changes, late navigation/account/panel responses, `If-Match`, preserved drafts and explicit recovery after uncertain writes. The development HTTP and opt-in container fixtures check that the separate static frontend serves `importers.js`. These checks do not replace a real-browser end-to-end or native-language review.

The following development block adds eight checks in `test_unicode_search.py` and four in `test_timeline_api.py`. Unicode coverage includes full case-folding, canonical equivalence, preserved original excerpts, all 2,692 changed scalar mappings in the selected tables, long combining sequences, query bounds, ACLs and pagination. The fixture verifies the four vendored files against their pinned SHA-256 hashes and checks normal/sanitized native functions. Timeline HTTP checks cover observers, deleted ancestry, both endpoints' archive state, corrupted cross-board edges and stable truncation to 2,000 edges.

The frontend target now runs **15 suites**, adding `test_conflict_resolution.js` and `test_timeline.js`. These exercise actual merge/apply/save handlers, scalar and per-key custom-field choices, atomic array groups, legacy drafts, auxiliary drafts, repeated `412`, current definitions/permissions and late responses. Timeline checks cover UTC/DST/year boundaries, dates/anchors, pagination, bounded rows/edges, escaping, observer keyboard use, malformed responses and cache isolation by board snapshot, account, view, archive and load sequence. Both new static modules are included in development and opt-in container asset checks. No real-browser accessibility or complete E2E result is implied.

Run `make fuzz-smoke` separately with a Clang/libFuzzer toolchain; the [fuzzing guide](FUZZING.md) describes the three real C targets, budgets, synthetic seeds, exact-source reports and reproduction. Fuzz campaigns do not run during ordinary Python discovery. The new CI job is separate from the existing native matrix, so its budget does not reduce those checks. Build/install includes the complete utf8proc license; `make test-vendor` verifies unmodified upstream files offline.

This latest block passed 323 native discovery tests (297 passed, 26 optional integrations skipped) normally and with ASan/UBSan. Three later runner regressions in `test_fuzz_tools.py` passed separately, covering child configuration isolation and compiler/campaign timeout diagnostics. They join the next full discovery. These results do not claim that optional real-store/container integrations ran locally.

Final local fuzz campaigns on Darwin arm64 with Homebrew Clang 23.1.1 each completed 1,000,000 executions for HTTP, JSON and Unicode, with exit status zero and no failure artifacts. Budgets were 30 seconds per target; elapsed campaign times were 9.444, 10.550 and 28.275 seconds respectively. Source/binary hashes and edge/feature counts are retained in the ignored local `build/fuzz-final/report.json`; the numbers are not an application-wide coverage percentage or a long-running fuzzing guarantee.

HTTP tests that fill a login quota use a separate test server with only the authentication limiter's clock frozen. This avoids crossing a legitimate five-minute window boundary on slower runners. The production backend, password-hashing cost and request deadlines are unchanged. Other HTTP checks use the normal backend, and the private limiter fixture explicitly tests expiration, collisions and concurrent reservations with controlled timestamps.

`make test-docs` runs the repository's local Markdown link/fence checks without fetching remote pages. Node.js is required for JavaScript checks; CI uses Node 22 and Python 3.14. Native CI runs on Linux and macOS. These are tested environments, not a claim that every older tool version or platform is supported.

## Docker image checks

Build the current images first:

```sh
docker compose build app frontend postgres mongo npm
```

Compose resolution requires a generated private environment file even when only building. For a fresh checkout use `python3 scripts/init-env.py`; an existing file is preserved. The following fixtures create only disposable, uniquely named containers and remove their own resources:

```sh
OPENBOARD_POSTGRES_IMAGE=openboard-postgres:0.6.1 \
OPENBOARD_MONGO_IMAGE=openboard-mongo:0.6.1 \
python3 -m unittest discover -s tests -p test_database_images.py -v

OPENBOARD_FRONTEND_IMAGE=openboard-frontend:0.6.1 \
python3 -m unittest discover -s tests -p test_frontend_static.py -v

OPENBOARD_PROXY_IMAGE=openboard-proxy:0.6.1 \
OPENBOARD_APP_IMAGE=openboard:0.6.1 \
OPENBOARD_FRONTEND_IMAGE=openboard-frontend:0.6.1 \
python3 -m unittest discover -s tests -p test_proxy_security.py -v
```

Database fixtures check entrypoint initialization, least privilege, wrong-password rejection, native tools and backup/restore with typed JSON and Unicode. Frontend checks verify real HTTP assets and access restrictions. Proxy checks verify the loaded nginx configuration, authenticated API routing, forged IP headers, rate limits and independent clients using a separate Docker network.

Disposable database startup has a bounded 120-second deadline and stops early if the container exits. Failure diagnostics expose only sanitized container state, exit code and OOM status; raw initialization logs and environment values are not printed.

The CI container job additionally starts a fresh five-service stack, creates local administrators, runs `scripts/check-deployment.py` and checks the public frontend/API route. It removes its own stack and credentials afterward. `docker compose down --volumes` deletes data and belongs only in disposable test cleanup or an intentional reset.

## External-storage tests

Build with `make EXTERNAL_STORAGE=1` and install the native libpq/MongoDB drivers required by the test inspector. Configure `OPENBOARD_POSTGRES_URL` and `OPENBOARD_MONGODB_URI` for a **new, disposable pair of databases**, then run:

```sh
make test-cloud EXTERNAL_STORAGE=1
```

Set `OPENBOARD_CLOUD_MIGRATION_TEST=1` only for disposable stores when also exercising old-schema migrations. `OPENBOARD_CLOUD_MONGO_CONTAINER` identifies the disposable MongoDB container for the outage/restart test. `OPENBOARD_BINARY` can select a separate test binary. The tests alter external metadata and deliberately interrupt storage; they are unsuitable for an existing deployment.

Default Python discovery skips integrations unless their opt-in variables are set. Missing prerequisites may also skip a check. Record the number of passed and skipped checks accurately; a successful default run does not establish that external storage or Docker images were tested.

The unreleased CI container job builds with native database drivers and runs `python3 scripts/test-cloud-stack.py`. This creates new stores and explicitly enables migration and outage tests, treating skipped tests as failure. The recovery job uses a generated encrypted fixture backup; it never consumes a production backup. Both require runtime confirmation for the exact candidate. [Run 39020804975](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39020804975) at `5688602` passed all four jobs. The later [run 39030617497](https://github.com/GiorgioOppo/OpenBoard/actions/runs/39030617497) at `25da2ba` also passed all four jobs, including the collaborative-search/filter/import/table source and importer static asset. Its container job passed 16 real-store scenarios, one encrypted recovery test, four database-image checks, three proxy checks and three static-frontend checks. The proxy recovery fixture checks a synthetic archive in a network-disabled container; it does not validate running NPM/certificate restoration. These runs predate the new Unicode/timeline/conflict/fuzzing block and its fifth CI job. See [operations tools](OPERATIONS_TOOLS.md) for manual commands and their boundaries.

## Storage capacity and telemetry (unreleased)

Default discovery includes `test_storage_capacity.py`, `test_storage_lock_pressure.py` and `test_telemetry.py`; frontend checks include `test_capacity_ui.js`. They use temporary databases, private control files, isolated loopback servers and offline native-driver fixtures. No deployment credentials or real database servers are required. The native libpq/MongoDB development packages enable the offline cloud-adapter checks.

Coverage includes retained trash/ancestor/orphan accounting, exact quota boundaries, empty files, concurrent uploads, idempotency replay, restore above a lowered quota, clone/import behavior, SQL failures and transaction rollback. Cache tests cover page limits, preserved reads/session expiry under pressure, measurement failure and rechecking capacity after a real writer-lock wait for both domain and authentication operations. Driver fixtures verify the hydration guard restores transactions, triggers, foreign keys and the change tracker. Telemetry tests exercise fixed bucket boundaries, bounded output, concurrent coherent exports, authenticated metrics and actual 429 responses. The frontend suite covers unknown/zero values, all seven locales, role revocation and late responses.

These checks do not measure actual tmpfs exhaustion, external database performance or two-store recovery. Run the Docker/cloud jobs against the candidate before making those claims. Cache free-space admission is not an atomic space reservation; include WAL, temporary allocations and process memory in capacity planning.

## Secret and dependency review

CI runs a pinned Gitleaks binary locally against repository history. The configuration retains default rules and allows only the documented synthetic Idempotency-Key example in the API document. No general credential or directory exclusion is added.

Before publication, scan the publishable source snapshot as well as Git history and review historical Actions logs and screenshots. Never scan or upload live environment files as part of public release evidence. Record actual dependency scanner, artifact digests, findings and reachability assessments; a local package comparison is not a fresh vulnerability scan. External SBOM upload requires the repository owner's authorization.

Dependabot proposes weekly Docker and GitHub Actions updates. Base-image changes require coordinated review of restored image metadata, hardening checks, native modules and pinned tool sources; the script-embedded Go/npm/Python pins still need manual maintenance. There is no automatic merge. PostgreSQL major and MongoDB/NPM major/minor updates require an explicit compatibility or migration plan.
