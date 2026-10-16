# Maintainers and project decisions

The current project maintainer is [@GiorgioOppo](https://github.com/GiorgioOppo). The maintainer reviews contributions, sets release scope and coordinates security reports and community moderation.

OpenBoard is maintained on a best-effort basis. A contribution or feature request does not create a delivery date, support obligation or commitment to merge.

## How decisions are made

Small fixes and documentation changes can be proposed directly as pull requests. Discuss larger API, schema, storage, authentication or dependency changes in an issue first. The maintainer considers correctness, compatibility, operational cost, validation and the [roadmap](docs/ROADMAP.md).

Reviews should explain actionable concerns and tradeoffs. Accepted changes need relevant checks and updated documentation; changes involving permissions, migrations or external storage require special attention to existing users and recovery. Release decisions and support status are recorded in the [changelog](CHANGELOG.md), [release process](docs/RELEASING.md) and [security policy](SECURITY.md).

`CODEOWNERS` requests a maintainer review; requiring that review or CI checks additionally needs a GitHub branch rule. Repository settings are reviewed as part of the [publication checklist](docs/PUBLICATION.md).

There is no separate steering committee or delegated maintainer group at present. Future maintainers and any changes to this process will be documented here. See [CONTRIBUTING.md](CONTRIBUTING.md) for implementation and pull request guidance.
