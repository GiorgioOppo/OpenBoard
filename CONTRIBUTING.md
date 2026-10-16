# Contributing to OpenBoard

Bug reports, documentation improvements, translations and pull requests are welcome. OpenBoard is an early preview maintained on a best-effort basis. Read the [code of conduct](CODE_OF_CONDUCT.md), [roadmap](docs/ROADMAP.md) and [security policy](SECURITY.md) before contributing.

## Start from a clean checkout

Create a descriptive branch for your changes. The commands below clone upstream for local development; to submit a pull request, clone your own GitHub fork instead or add it as a push remote. Requirements and package installation commands are in the [README](README.md#local-development).

```sh
git clone https://github.com/GiorgioOppo/OpenBoard.git
cd OpenBoard
git switch -c docs/example-change
make EXTERNAL_STORAGE=0
./build/openboard --no-demo --public-url http://127.0.0.1:8090
```

In a second terminal, from the same checkout:

```sh
python3 scripts/dev-frontend.py
```

Open `http://127.0.0.1:8090` and create a local administrator. The backend exposes APIs on port 8080; the development frontend serves assets and forwards API calls. Never use personal or company databases as test fixtures. Generated databases, builds, backups and private environment files are ignored by Git.

For the five-service deployment use the [Compose guide](docs/DEPLOYMENT.md). Building external storage natively requires libpq and a compatible MongoDB C driver discoverable through `pkg-config`:

```sh
make EXTERNAL_STORAGE=1
```

On some systems the libpq package directory must be added to `PKG_CONFIG_PATH`. `make` otherwise detects the available drivers; `EXTERNAL_STORAGE=0` explicitly selects a SQLite-only development build.

## Verify your change

```sh
make test
make test-sanitize
make test-frontend
make test-security
python3 scripts/check-docs.py
```

Node.js is needed for the frontend and proxy-limiter tests, not for the C API or static frontend at runtime. Run checks relevant to your change; CI runs the complete default suite. The [testing guide](docs/TESTING.md) explains optional Docker/cloud checks and why a skipped optional test is not evidence that the integration passed.

For interface changes also check keyboard use, mobile layouts, language switching, observer permissions, drafts, conflicts and switching between accounts. For API changes add a meaningful behavioral regression and update the matching contract. Documentation-only changes require link/example verification rather than new backend tests.

## Implementation conventions

- Keep the backend C11/POSIX and the frontend plain HTML/CSS/JavaScript.
- Use prepared SQL statements, validate request types and enforce current authorization on the server.
- Preserve session/CSRF handling, revision preconditions, idempotency authorization and frontend account isolation.
- Keep PostgreSQL scalar rows and MongoDB JSON references consistent; database/schema changes need a documented migration, backup and rollback plan.
- Use synthetic, deterministic data in committed fixtures. Never commit credentials, tokens, private logs, database dumps, executable builds or copied customer data.
- Keep documentation in English. Historical Italian checklists remain in the archive; user content and API identifiers do not need translation.

For translations edit `locales/*.json`, regenerate `web/locales.js`, and run `make test-frontend`. Follow the [translation guide](docs/INTERNATIONALIZATION.md); do not translate arbitrary user content or change protocol enums.

## Issues and pull requests

Search existing issues before opening a new one. Use the bug or feature form and include the version, environment, expected behavior and a minimal reproduction. Remove private information from screenshots and logs. Security vulnerabilities must use [private reporting](SECURITY.md#report-a-vulnerability), not a public issue.

Keep a pull request focused. Explain the problem, resulting behavior and checks actually performed. Mention API/schema compatibility, migration or deployment changes when applicable. Do not describe skipped checks as passing. For larger changes, discuss the design in an issue before investing in an implementation.

The maintainer reviews scope, correctness, compatibility and validation before merging. Contributions must be your own work or have compatible permissions and attribution; accepted contributions to OpenBoard are made under its [MIT license](LICENSE). No contributor license agreement is currently required.
