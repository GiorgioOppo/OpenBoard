# Publication preparation review — 16 October 2026

This record describes local checks of the 0.6.1 early-preview candidate before its publication-preparation commit. It complements the dated security inventories; it is not a security certification or a fresh vulnerability scan of every release image.

| Check | Observed result |
| --- | --- |
| Default Python suite | 222 tests completed; 21 optional checks skipped; no failures |
| Address/undefined-behavior sanitizers | Same 222 tests; 21 optional checks skipped; no failures |
| Frontend and proxy-limiter Node checks | All five frontend suites and the limiter suite passed |
| Documentation | Publishable local links, Markdown anchors and code fences passed |
| Workflow syntax | Actionlint passed |
| Local five-service stack | 0.6.1 API version, setup, idempotent bootstrap, real legacy proxy upgrade and full preflight passed |
| Git history secret scan | Gitleaks 8.30.1, 9 existing commits; no unsuppressed findings |
| Publishable source snapshot | Gitleaks 8.30.1, 172 files in the examined snapshot; no unsuppressed findings |
| Historical Actions log scan | All 9 existing runs, 64 log files, 2,543,857 bytes; Gitleaks found no secrets |
| Screenshots | All 13 tracked preview images visually reviewed; no credentials or private desktop content found |
| Repository presentation | Description and ten relevant topics configured; repository remained private |

The only secret-scanner exception is the documented synthetic Idempotency-Key example in `docs/API.md`. Both the path and complete detected match must agree. Temporary fixtures confirmed that the same example elsewhere and a separate generated credential-like value in the API file are still detected. The standard detector rules remain active, and inline ignore comments are disabled for the scan.

The five-service check used only temporary credentials, a unique project/network and new volumes. All test resources were removed. Existing deployment containers, data and credentials were not changed. The native backend and unchanged frontend/database/proxy artifacts were tagged locally for the 0.6.1 checks; these tags do not represent published registry images.

Raw logs and scanner outputs were kept private; the repository records sanitized results and reproducible commands in [Testing](TESTING.md). A detector result does not establish the absence of every confidential value. Secret scanning does not remove or redact Git identities.

## Commit identity privacy

With the owner's explicit approval, the personal email in the author and committer metadata of nine historical commits was replaced with the owner's GitHub noreply address. The default branch and both existing Dependabot branches were updated atomically with exact `force-with-lease` conditions. All 13 examined commits retained identical file trees, messages, names and timestamps. Two bot signatures were removed because changing commit ancestry invalidates them; bot identities were preserved. A recovery bundle and the SHA mapping remain private, outside publishable files. The repository-local Git email now uses noreply for future commits.

Current documentation, scan provenance and migration-fixture comments use the rewritten commit identifiers. Historical image digests and measured scan counts are unchanged. Prior Actions runs remain evidence for their original commits; the release candidate requires its own complete CI run.

**Public visibility remains blocked on a privacy review.** At the initial check after the force push, authenticated GitHub API checks still retrieved all nine original commit objects with their original email. Nine historical Actions run records also retained that email in their `head_commit` author/committer metadata; the examined log files did not contain it. Both pull requests' current head/base references and advertised pull-request refs used the rewritten ancestry, but that does not establish deletion of retained objects or historical views. A fresh remote mirror contained no original email in any reachable commit identity, and the repository reported no forks or Actions caches. No request to GitHub Support was sent. Rewriting Git history does not edit Actions run records; deleting those records is irreversible and requires separate owner authorization.

The owner subsequently authorized removal of those nine historical Actions runs. Complete run records and reviewed logs were backed up privately before deletion. All nine deletion operations succeeded, follow-up requests returned `404`, and no original email remained in the other examined runs' `head_commit` identities. New candidate verification runs were retained. This removes the examined Actions records; it does not establish purging of retained Git objects or cached views.

[GitHub's removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) explains retained commit objects, cached views and pull-request references. Support must determine whether further removal is available for this data; a force push cannot promise complete erasure. Resolve this with the owner before changing visibility. Do not publish the private recovery bundle, old-to-new mapping or support-request draft.

## Release and visibility follow-up

After pushing the candidate, use its complete [CI run](https://github.com/GiorgioOppo/OpenBoard/actions/workflows/ci.yml) as the source of current commit-specific verification. Review the draft release, exact artifact digests and the [publication checklist](PUBLICATION.md). Historical audit image counts remain historical.

The repository was private and `main` had no enforced branch rule when presentation settings were inspected. Review required checks/review settings before accepting outside write access. Private Vulnerability Reporting is the chosen security channel and must be enabled and tested at the visibility change. No final external dependency rescan or public service deployment was performed during this preparation.
