# Release process

OpenBoard 0.6.1 is prepared as an early preview. A draft or prerelease is not a stable-support promise. The [changelog](../CHANGELOG.md) records changes; the [security policy](../SECURITY.md) records maintenance scope.

## Prepare an identifiable candidate

1. Select a reviewed commit containing all intended fixes, documentation and tests. Keep release preparation separate from deploying an existing instance.
2. Keep `OB_VERSION` in `src/openboard.h`, Compose image tags, CI image references, current API examples and release notes consistent. Preserve historical audit measurements and older feature-version references.
3. Record schema/API compatibility and backup/upgrade/rollback instructions. Version 0.6.1 retains schema 7 and database server major versions.
4. Finish local validation, push the candidate and wait for its complete CI run. A previous green commit does not validate the candidate.
5. Review dependency findings for the exact release images, including visible residuals and any assessment of an absent affected component. Obtain authorization before any scanner uploads an SBOM externally.

## Evidence and artifacts

Include the tested commit, version, target platform, actual checks, skipped checks, limitations and dependency scan identities. The dated audit inventories in this repository distinguish measured artifacts from later changes. A later build using live distribution repositories can produce a different image and needs its own review.

CI logs are linked to their commit. Raw private logs, environment files and database backups are not release artifacts. Only publish sanitized reports. If distributing prebuilt images or binaries, additionally preserve third-party notices and required source access, record digests/checksums, and provide an SBOM/provenance for those exact artifacts. Source-only releases do not imply that official prebuilt packages are available.

## Draft, review and publish

Prepare a draft GitHub prerelease for the reviewed commit:

```sh
gh release create v0.6.1 --repo GiorgioOppo/OpenBoard \
  --target REVIEWED_COMMIT --draft --prerelease \
  --title 'OpenBoard 0.6.1 — Early preview' \
  --notes-file docs/releases/0.6.1.md
```

Replace `REVIEWED_COMMIT` with the verified SHA. The maintainer reviews the draft, release notes and [publication checklist](PUBLICATION.md) before publication. No publishing or deployment workflow runs automatically from a version string or tag.

Published tags identify immutable release content. Correct a release with a new version rather than silently moving its tag. If the candidate changes before publication, retest it and ensure the draft target/tag and evidence refer to the same commit. Review metadata, source notices and install commands again before promoting a preview to a stable release.
