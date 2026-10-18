# API versioning and deprecation

This policy and the explicit versioned paths describe the **unreleased development branch**. The published `v0.6.1` source snapshot remains immutable. The application release number, the API major version and the database schema version are separate identifiers.

## Version 1 paths

Use `/api/v1` as the base path for new integrations. Every current `/api/...` route also accepts `/api/v1/...`, including authentication, service status, metrics and exports. Existing clients may continue using `/api`: it is an alias for API version 1, rather than a selector for whichever API major is newest in the future.

For example, these requests reach the same authenticated board handler:

```http
GET /api/v1/boards/123?summary=1 HTTP/1.1
Host: openboard.localhost
Cookie: ob_session=<session-token>
```

```http
GET /api/boards/123?summary=1 HTTP/1.1
Host: openboard.localhost
Cookie: ob_session=<session-token>
```

The native HTTP transport replaces the explicit `v1` prefix exactly once before route dispatch. It keeps the raw query separate and applies the existing query decoding and duplicate-parameter validation. There are no redirects, path percent-decoding, repeated prefix removal or implicit trailing-slash corrections. The normalized route also appears in native request logs; `X-Request-ID` remains the request correlation identifier.

Both forms share sessions, CSRF validation, authentication quotas, board permissions, revision preconditions and mutation handlers. A session cookie already uses `Path=/` and works with either form. Send `X-CSRF-Token` on authenticated writes and `If-Match` where the resource supports revision preconditions, as described in the [API reference](API.md).

Supported idempotent `POST` requests use the same existing scope of user, normalized route and `Idempotency-Key`. Retrying an identical request through the other alias replays the first result; it does not create another record. Body mismatch still returns `409`, and replay still checks current authorization. Retention remains an operator setting described in [deployment](DEPLOYMENT.md); changing URL spelling does not extend the replay window.

The supplied proxy configuration applies the same authentication rate zones to the exact versioned and unversioned setup, login and password paths. Custom reverse proxies must preserve this equivalence and forward the versioned path to the backend. Edge rejections happen before native API processing and may have different response bodies and headers.

## Response identification and discovery

Native responses for recognized `/api` paths include:

```http
OpenBoard-API-Version: 1
```

This header identifies the implemented API major. It also appears on native authentication, validation, unknown-route and unsupported-version errors, and on `HEAD` responses. For an unsupported requested version it reports the server's implemented major, not successful negotiation. A request rejected before its API path can be read, an overloaded connection or an error produced by a reverse proxy may omit it. Non-API paths do not receive this header.

The public `GET /api/version` and `GET /api/v1/version` responses retain their application/runtime fields and add this machine-readable object:

```json
{
  "api": {
    "version": 1,
    "supported_versions": [1],
    "base_path": "/api/v1",
    "unversioned_alias": "/api",
    "alias_version": 1,
    "deprecated": false,
    "sunset": null
  }
}
```

Version 1 is currently the only supported major. There is no announced API retirement date and no active deprecation response header.

## Unsupported and malformed versions

After ordinary HTTP transport validation, a numeric unsupported version such as `/api/v2/boards` returns `404`, without redirecting or executing a domain mutation:

```json
{
  "error": "Unsupported API version. Use /api/v1/.",
  "code": "unsupported_api_version",
  "supported_versions": [1]
}
```

Version identifiers use canonical decimal spelling. `/api/v01/boards`, `/api/v1suffix/boards` and `/api/v1.0/boards` are invalid version paths and return `404`. `/api/v1` and `/api/v1/` require an actual resource path and also return `404`. Nested prefixes, doubled separators, escaped resource names and trailing slashes do not create alternate routes. Error bodies contain bounded fixed descriptions and do not echo arbitrary requested version strings.

## Compatibility and deprecation policy

API version 1 establishes the documented development contract even while application releases remain `0.x`. This is a maintained compatibility policy, not a claim that every route has a complete machine-validated schema or a production support SLA. Endpoint-specific constraints and limitations remain in the API references and [roadmap](ROADMAP.md).

- Additive optional fields and new endpoints may be introduced within version 1. Clients should tolerate additional object properties and continue validating required fields they use.
- Removing or renaming documented fields or endpoints, changing documented field types, or introducing incompatible required inputs requires a new API major path and migration guidance. Do not silently redirect version 1 clients to the new contract. Enumeration changes must document client handling; do not assume an unknown value is safe.
- Security corrections may reject inputs or access that violated documented validation or authorization rules. Such changes must be described in the changelog and relevant security advisory when applicable.
- Before deprecating a supported API major or the unversioned alias, publish a notice in this policy and the changelog with the affected contract, replacement paths, migration steps and a concrete retirement date. Update discovery metadata and emit the applicable `Deprecation` and `Sunset` headers on affected responses when that notice takes effect. Until a notice is published, `/api` continues to mean version 1 and both forms remain available.
- A future major version does not itself retire version 1. A deprecation notice must describe the actual overlap period; no retirement deadline or automatic migration is currently scheduled.

The API header and metadata are ordinary HTTP/JSON discovery information. They do not provide cryptographic attestation, signed contracts or automatic client compatibility validation.

## Regression coverage

`tests/test_api_versioning.py` starts disposable authenticated servers and checks alias setup/login/session behavior, native shared login quotas, CSRF and origin rejection, board ACL and observer enforcement, `If-Match`, cross-alias idempotency and authorization after membership revocation, unchanged query handling, response headers, and bounded unknown-version errors without mutation. Existing transport, authentication and domain tests continue to exercise the canonical handlers.

Run the focused checks after building the native server:

```sh
make EXTERNAL_STORAGE=0
python3 -m unittest discover -s tests -p test_api_versioning.py -v
```

The same tests use `OPENBOARD_BINARY` for a sanitizer build. The fixed monotonic authentication clock used by the quota regression affects only its test fixture; production quotas, password hashing and HTTP deadlines remain unchanged.
