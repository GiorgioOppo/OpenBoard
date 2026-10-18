# Security requirements and ASVS traceability

Reviewed on **18 October 2026** alongside the [threat model](THREAT_MODEL.md). This document connects selected security observations to source paths, regression scenarios, residual risks and responsible roles. It does not claim ASVS Level 1/2/3 compliance, certification, an independent assessment or readiness for Internet production use. Improvement **31 remains partial** until the applicable requirements have been completely assessed and the documented gaps addressed or explicitly accepted for a defined deployment.

## Standard and immutable provenance

The reference is **OWASP Application Security Verification Standard 5.0.0**, the latest stable release verified on the review date through the [official project](https://owasp.org/projects/asvs) and [stable release](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release). The moving bleeding-edge release is not the reference. ASVS identifies requirements using version-qualified numeric IDs; this inventory uses, for example, `v5.0.0-8.2.2`. See the [official ASVS repository](https://github.com/OWASP/ASVS#how-to-reference-asvs-requirements).

| Provenance | Pinned value |
| --- | --- |
| Official repository/tag | `OWASP/ASVS`, `v5.0.0_release` |
| Release commit | `5cf9b032440be53ce345ab3c130fda46ba1ce7a2` |
| Original English catalog | [Immutable official CSV](https://raw.githubusercontent.com/OWASP/ASVS/5cf9b032440be53ce345ab3c130fda46ba1ce7a2/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv) |
| CSV SHA-256 | `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680` |
| Official catalog size | 345 requirements; 70 at Level 1 |
| Upstream terms | OWASP ASVS contributors; [CC BY-SA 4.0](https://github.com/OWASP/ASVS/blob/5cf9b032440be53ce345ab3c130fda46ba1ce7a2/LICENSE.md) |

The local inventory records upstream identifiers/levels and original OpenBoard observations. It does not reproduce the standard's requirement prose or modify the upstream catalog. Use the immutable standard to read each complete requirement. OWASP has not endorsed or assessed this project.

## Scope and status meanings

The canonical [JSON matrix](security-requirements.json) enumerates **all 70 official Level 1 identifiers**, including the ones not yet assessed, plus **16 selected Level 2/3 identifiers** relevant to storage, crypto, proxy identity, coding and errors. It contains 37 control records and explicit applicability boundaries for all 17 chapters. Enumeration is complete for Level 1; verification is not. The other 259 catalog requirements have no individual assessment in this matrix and remain outside its claimed coverage.

| Status | Meaning | Requirements |
| --- | --- | ---: |
| `partial` | Related code/documentation and selected evidence exist; the full requirement has not been established across all applicable layers. | 59 |
| `gap` | A concrete missing behavior or policy prevents a positive assessment. | 11 |
| `deployment_required` | The operator must configure and verify the actual running system; source tests cannot establish it. | 3 |
| `unassessed` | No requirement assessment or compliance inference is made. | 11 |
| `not_applicable` | An explicitly scoped application feature is absent; the rationale excludes claims about unrelated upstream components. | 2 |

No row has a `pass` or `compliant` status. The counts include the selected higher-level requirements and do not form a compliance percentage. OpenBoard's reference sessions are different from NPM's administration token/session system: the latter still needs an upstream-specific assessment. Likewise, private Docker networking does not satisfy encrypted transport requirements, and board ACLs do not implement SaaS tenancy.

The eleven unassessed Level 1 IDs are `v5.0.0-1.3.1`, `3.5.2`, `9.1.1`–`9.1.3`, `9.2.1` and `10.4.1`–`10.4.5` (all abbreviated IDs in this sentence retain the `v5.0.0-` prefix). HTML sanitization applicability, preflight-specific CSRF assumptions, NPM self-contained tokens and complete OAuth/provider applicability require explicit review. These rows must not disappear merely because the primary application does not currently expose OAuth or JWT sessions.

## How to read the evidence

Each requirement points to a control with:

- A narrowly stated observation about current OpenBoard behavior, not a paraphrased promise of the entire ASVS requirement.
- Repository-relative implementation/document paths and existing Python test method names or JavaScript suite paths.
- One or more `TM-xx` entries in the threat model.
- Remaining work and an owner: maintainer, operator, or both. Roles identify responsibility; they do not imply a service-level commitment.

The following groups explain the matrix structure. The JSON carries the exact version-qualified requirement lists and test names.

| Controls | Scope and useful evidence | Verification limit |
| --- | --- | --- |
| OB-C01–04 | Output/URL handling, SQL/BSON, command boundaries and dynamic execution; frontend, cloud and archive regressions. | Selected sinks and scenarios; no complete interpreter/query audit. |
| OB-C05–08 | XML applicability, trusted validation, workflow order and response context; domain/import/review/static tests. | No complete endpoint/field/flow inventory; application XML absence excludes upstream XML-capable components. |
| OB-C09–12 | Cookie naming, HSTS, Origin/CSRF and WebSocket applicability; auth/transport/static checks. | Cookie-prefix and HSTS gaps; no WebSocket functionality. |
| OB-C13–14 | Upload/admission/path/extraction bounds and content validation. | Physical external capacity, arbitrary file safety and antivirus remain incomplete. |
| OB-C15–21 | Authentication quotas, password handling and private bootstrap. | Local quotas, byte-based password length, missing blocklist and initial-password lifecycle remain concerns. |
| OB-C22–26 | Session verification/termination, ACL, transactional rechecks and tenancy. | Rotation and tenant-boundary gaps; upstream NPM tokens need separate review. |
| OB-C27–30 | Crypto use, public/internal transport and runtime filesystem exposure. | Optional encryption, operator-configured TLS and unencrypted internal links; inspect exact artifacts. |
| OB-C31–37 | Data placement/clearing, dependency policy, shaped responses, proxy identity, JavaScript keys and errors/logging. | Retained browser drafts, missing remediation deadlines, incomplete log/audit inventory and selected tests. |

Regression references are maintained pointers. Their existence does not establish that they passed for a candidate, that optional container scenarios executed, or that all attacks were tested. Obtain current test results from the exact candidate's [testing procedures](TESTING.md) and CI. The [fuzzing campaigns](FUZZING.md) exercise actual HTTP/JSON/Unicode paths within stated budgets; they do not assess every ASVS property. Dated dependency reports remain dated evidence, including explicitly unscanned final images.

## Concrete open work

The matrix makes several previously implicit limitations explicit:

| Work | Current observation | Owner / related threat |
| --- | --- | --- |
| HTTPS cookie migration | `ob_session` lacks a security prefix; Secure depends on the configured HTTPS origin. | Maintainer; TM-03 |
| Public transport policy | No guaranteed HSTS on all public response classes; enabled TLS versions/ciphers need runtime verification. | Operator/maintainer; TM-16 |
| Password policy | Twelve UTF-8 bytes can be fewer than eight characters; there is no common-password blocklist. | Maintainer; TM-02 |
| Initial secrets and rotation | Bootstrap passwords do not expire or require first-use replacement; login/password changes do not replace and revoke every relevant current token. | Maintainer/operator; TM-01/TM-03 |
| Client-data retention | Logout invalidates visible state and late responses, but deliberately retains account-scoped local recovery drafts. | Maintainer/operator; TM-07 |
| Internal transport | Supplied internal HTTP/database links are isolated but unencrypted. | Maintainer/operator; TM-16 |
| File/tenant boundaries | General content validation/quarantine and SaaS tenant isolation are absent. | Maintainer; TM-05/TM-10 |
| Dependency and audit policy | No risk-based remediation deadlines, complete fresh final-artifact assessment or protected security-event channel. | Maintainer/operator; TM-15/TM-17 |

An open ASVS gap is not automatically a newly demonstrated exploitable vulnerability. Its deployment impact must be assessed against the threat model. Conversely, the absence of a reproduction is not evidence that a requirement is met. Track new confirmed vulnerabilities privately using the [security policy](../SECURITY.md).

## Reproduce the traceability checks

Run the offline checker from the repository root:

```sh
python3 scripts/check-security-requirements.py
```

It checks the exact pinned Level 1 ID set and selected higher-level ID/level pairs, unique controls, status consistency, all chapter boundaries, threat IDs, remaining-work/owner fields, source paths and real Python test definitions. JavaScript evidence identifies whole existing suites. It neither executes the cited tests nor reads deployment configuration, creates network connections or inspects credentials. This is a documentation maintenance check, not a security scanner.

For an independent provenance comparison, obtain the original CSV from the immutable official link above and run:

```sh
python3 scripts/check-security-requirements.py --asvs-catalog /path/to/official-asvs-5.0.0.csv
```

The checker verifies the exact CSV checksum and compares every local ID/level/chapter and the complete Level 1 inventory against it. A moving branch, regenerated CSV with changed bytes, another release or the bleeding-edge asset is rejected. No automatic download or third-party upload occurs.

When updating ASVS, review changed IDs/semantics and applicability against the new stable release, update the pinned metadata and checker together, and reassess affected controls rather than copying a previous status. When updating application code, preserve an honest remaining-work statement, refresh evidence pointers and rerun meaningful negative scenarios. Record actual runtime/image verification separately from this source-level matrix.
