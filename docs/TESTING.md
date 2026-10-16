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

The CI container job additionally starts a fresh five-service stack, creates local administrators, runs `scripts/check-deployment.py` and checks the public frontend/API route. It removes its own stack and credentials afterward. `docker compose down --volumes` deletes data and belongs only in disposable test cleanup or an intentional reset.

## External-storage tests

Build with `make EXTERNAL_STORAGE=1` and install the native libpq/MongoDB drivers required by the test inspector. Configure `OPENBOARD_POSTGRES_URL` and `OPENBOARD_MONGODB_URI` for a **new, disposable pair of databases**, then run:

```sh
make test-cloud EXTERNAL_STORAGE=1
```

Set `OPENBOARD_CLOUD_MIGRATION_TEST=1` only for disposable stores when also exercising old-schema migrations. `OPENBOARD_CLOUD_MONGO_CONTAINER` identifies the disposable MongoDB container for the outage/restart test. `OPENBOARD_BINARY` can select a separate test binary. The tests alter external metadata and deliberately interrupt storage; they are unsuitable for an existing deployment.

Default Python discovery skips integrations unless their opt-in variables are set. Missing prerequisites may also skip a check. Record the number of passed and skipped checks accurately; a successful default run does not establish that external storage or Docker images were tested.

## Secret and dependency review

CI runs a pinned Gitleaks binary locally against repository history. The configuration retains default rules and allows only the documented synthetic Idempotency-Key example in the API document. No general credential or directory exclusion is added.

Before publication, scan the publishable source snapshot as well as Git history and review historical Actions logs and screenshots. Never scan or upload live environment files as part of public release evidence. Record actual dependency scanner, artifact digests, findings and reachability assessments; a local package comparison is not a fresh vulnerability scan. External SBOM upload requires the repository owner's authorization.

Dependabot proposes weekly Docker and GitHub Actions updates. Base-image changes require coordinated review of restored image metadata, hardening checks, native modules and pinned tool sources; the script-embedded Go/npm/Python pins still need manual maintenance. There is no automatic merge. PostgreSQL major and MongoDB/NPM major/minor updates require an explicit compatibility or migration plan.
