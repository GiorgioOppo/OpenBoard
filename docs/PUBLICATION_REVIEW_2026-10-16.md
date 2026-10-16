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

Raw logs and scanner outputs were kept private; the repository records sanitized results and reproducible commands in [Testing](TESTING.md). A detector result does not establish the absence of every confidential value. Commit author metadata needs a separate owner privacy decision before public access; secret scanning does not remove or redact Git identities.

## Release and visibility follow-up

After pushing the candidate, use its complete [CI run](https://github.com/GiorgioOppo/OpenBoard/actions/workflows/ci.yml) as the source of current commit-specific verification. Review the draft release, exact artifact digests and the [publication checklist](PUBLICATION.md). Historical audit image counts remain historical.

The repository was private and `main` had no enforced branch rule when presentation settings were inspected. Review required checks/review settings before accepting outside write access. Private Vulnerability Reporting is the chosen security channel and must be enabled and tested at the visibility change. No final external dependency rescan or public service deployment was performed during this preparation.
