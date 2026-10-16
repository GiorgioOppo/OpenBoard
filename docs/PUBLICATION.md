# Repository publication checklist

This checklist prepares the GitHub source repository for public access. Deploying a service requires the separate [deployment checks](DEPLOYMENT.md). The maintainer chooses when to change repository visibility and publish the draft release.

## Repository content

- [ ] Commit and push all intended security fixes, documentation, scripts and tests.
- [ ] Verify a fresh clone can follow the README and development instructions.
- [ ] Require the candidate's complete CI run, including docs, secrets, native/sanitizer tests and container checks.
- [ ] Review Git history, screenshots and historical Actions logs for confidential information. Ignoring a file now does not remove an older committed copy.
- [ ] Review author/committer identities separately from secret scanning. Verify all branch/tag and draft-release targets after any authorized history rewrite, and resolve retained old objects, PR views and cached metadata before public access; see the [privacy review](PUBLICATION_REVIEW_2026-10-16.md#commit-identity-privacy).
- [ ] Confirm no environment files, local administrator credentials, database dumps, personal data or build artifacts are tracked.
- [ ] Keep current documentation in English and clearly mark historical Italian material as archived.
- [ ] Review third-party licenses/source notices and exact artifact identities before distributing binaries or images.
- [ ] Preserve measured scan results and explain residual findings and scans not yet performed.

## GitHub presentation and release

- [ ] Set a useful repository description and topics; verify the README, image links and documentation index render correctly.
- [ ] Verify issue forms, pull request template, code of conduct, support policy and CODEOWNERS on the default branch.
- [ ] Review the 0.6.1 early-preview draft, target commit, changelog, limitations and upgrade instructions.
- [ ] Review branch rules, required checks and review requirements. CODEOWNERS alone does not enforce approval.
- [ ] Keep Actions credentials read-only by default and review permissions for any future release/image-publishing job.
- [ ] Confirm Dependabot configuration is recognized and that update PRs receive compatibility review.

## At the visibility change

- [ ] Review [GitHub's visibility-change consequences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), including exposure of Actions history/logs and any ruleset changes.
- [ ] Explicitly choose public visibility in GitHub settings only after reviewing this checklist.
- [ ] Confirm the recorded historical-email privacy issue is resolved with the owner; rewritten branch tips alone do not prove deletion of GitHub's retained objects.
- [ ] Enable [Private Vulnerability Reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), the project's sole private security channel.
- [ ] Confirm **Report a vulnerability** appears on the Security advisories page and the maintainer receives security notifications.
- [ ] Recheck public README badges, documentation links, issue forms and repository rules from the public view.
- [ ] Publish the reviewed prerelease when ready; keep its early-preview label and known limitations visible.

GitHub private vulnerability reporting is intended for public repositories. Until it is available, the security policy directs users to request activation without posting vulnerability details publicly. No contact email is implied or invented.

## Scope of the checks

The [audit](SECURITY_AUDIT_2026-10-16.md) and [remediation report](SECURITY_REMEDIATION_2026-10-16.md) record dated technical evidence. The current test and dependency state must be tied to the selected commit and images. Checkboxes are review steps, not a claim that every item has already passed or that the service is certified secure.
