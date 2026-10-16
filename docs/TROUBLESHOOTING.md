# Troubleshooting

Start with `docker compose ps` and `docker compose logs --tail 100 app`. Inspect other affected services by name, for example `docker compose logs --tail 100 npm`. Before sharing logs, remove credentials, cookies, tokens, connection strings and private board content. Keep `.env` and `.env.local-admin` private. Use `docker compose config --quiet`; expanded Compose output contains secrets.

## A host port is already allocated

Another process may be using HTTP, HTTPS or NPM administration ports. On a fresh installation, select distinct free ports:

```sh
python3 scripts/init-env.py --http-port 8088 --https-port 8443 --admin-port 8181
```

The local application origin becomes `http://openboard.localhost:8088`, and NPM administration is `http://127.0.0.1:8181`. If `.env` already exists, edit its port variables and `OPENBOARD_PUBLIC_URL` together, then recreate affected services. Changing only the browser URL does not update backend origin validation.

## Environment generation says the file already exists

`init-env.py` deliberately refuses to overwrite `.env`. Retain existing passwords when adjusting ports, addresses or time zone. For an existing database, changing a password in `.env` alone does not change the database user's password. Follow a deliberate credential-rotation procedure instead of regenerating the file. Do not delete volumes to solve this error.

## Initial setup is already complete, or bootstrap refuses an existing instance

The first-administrator endpoint returns `409` after an account has been created. Sign in with that instance's existing account; rerunning setup is not a password reset.

`bootstrap-local.py` reuses credentials from `.env.local-admin` and refuses to claim or replace an installation whose credentials or proxy configuration it cannot verify. For the exact old project-generated proxy block, use `python3 scripts/bootstrap-local.py --upgrade-proxy` after backup and image updates. For a manually configured host, update NPM's **Advanced** field using [`deploy/npm/openboard-api.conf`](../deploy/npm/openboard-api.conf), leaving account records intact. The automatic bootstrap supports only `http://openboard.localhost[:port]`; use [manual setup](DEPLOYMENT.md#manual-setup) for a real domain.

## Origin, Host, Secure cookie or HTTPS checks fail

`OPENBOARD_PUBLIC_URL` must match the browser's exact scheme, hostname and public port, without a path. Recreate the app after changing it. Keep `proxy_set_header Host $http_host` in all API locations so a custom port survives forwarding. Access through a different hostname or direct container address may fail the backend's checks.

Public exposure requires HTTPS, a nonlocal origin and a certificate trusted for that name. `.localhost` is a local evaluation domain. NPM administration stays on loopback; reach a remote console through an SSH tunnel. For nonstandard HTTPS ports, ensure HTTP redirects retain the public port; the standard Force SSL redirect may omit it. Then run:

```sh
python3 scripts/check-deployment.py
```

`--config-only` checks resolved configuration but does not establish live readiness or certificate validity. Do not treat it as a substitute for the full check.

## Proxy address, rate limiting or a network allocation fails

The backend trusts one exact IPv4 proxy peer. `OPENBOARD_PROXY_IP` must match the NPM static address and the application's `OPENBOARD_TRUSTED_PROXY`. A trusted peer must send one valid numeric `X-Real-IP`; a missing, duplicate or malformed value returns `400`. NPM must overwrite client IP headers rather than append browser-supplied values. Reapply the project's API proxy block and inspect the full deployment preflight result.

The frontend subnet must not overlap another Docker or host network. Its dynamic `OPENBOARD_FRONTEND_IP_RANGE` occupies the upper half; reserve `OPENBOARD_PROXY_IP` in the lower half, outside network, gateway and broadcast addresses. For example, a fresh environment can use:

```sh
python3 scripts/init-env.py --frontend-subnet 172.30.241.0/24 --proxy-ip 172.30.241.2
```

The generator derives the matching dynamic range. On an existing installation, update all three settings consistently, plan a network recreation and retain named volumes. A proxy address inside the dynamic pool can produce intermittent “address already in use” failures when startup order changes.

HTTP `429` means an authentication or connection limit was reached. Respect `Retry-After` when present and wait before retrying. Changing forwarded headers does not grant a new quota. A shared NAT address can share a client quota; increasing limits requires reviewing exposure and workload rather than disabling the controls.

## The API returns `401`, `403` or `409`

- `401`: the data API requires a valid session. Sign in again after expiration, password changes or session revocation. Health/version endpoints are separate from data authorization.
- `403`: the current account or board role does not allow the operation, or a modifying request failed CSRF/origin validation. Check current membership and use the official same-origin frontend; global observers cannot edit shared board data.
- `409`: the item may have changed, initial setup may already be complete, or the operation conflicts with current state. Read the response, reload current data and review your draft before retrying.

The backend is authenticated by default. Account-free mode is an explicit loopback-only development option, not a fix for an access problem.

## `/api/ready` returns `503`, or app startup stays unhealthy

Check database health and application logs. In Compose, both external connection variables must be configured, application users must authenticate, and both databases must be reachable from the backend network. Check for a missing MongoDB document, an unsupported schema version or a failed migration. Retain the data and restore a verified full backup to a new instance when needed; do not edit schema metadata to force startup.

The app's temporary filesystem holds the SQLite cache, WAL and temporary files. If it is full, measure usage and adjust its size; it is reconstructible, while PostgreSQL and MongoDB contain persistent data. More HTTP workers do not remove the storage adapter's serialization. A storage error invalidates the cache and may recover on a later request once the database problem is fixed. Repeated retries do not repair missing data or a failed migration.

## The backend returns `404` for `/`, or the frontend returns `404` for `/api`

This is expected when either production component is contacted directly. The backend serves APIs only; the production frontend serves assets only. Open the application through NPM. For native development, start both processes as shown in the [README](../README.md#local-development). For native deployment, use the separate static frontend and reverse-proxy example in [Deployment](DEPLOYMENT.md#native-deployment-and-previous-configurations).

## What to include in a bug report

Include the OpenBoard version or commit, operating system, Docker/Compose or compiler versions, storage mode, concise reproduction steps, expected and actual behavior, relevant HTTP status and redacted logs. State whether the full deployment preflight passed. Never attach a real backup, private environment file, session cookie or access token. Use [Support](../SUPPORT.md) for routing and [Security](../SECURITY.md) for private vulnerability reporting.
