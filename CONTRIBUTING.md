# Contributing to the SageOx Agent Toolkit

**Pull requests are welcome — we love PRs.** Whether it's a one-line fix, a new
chat adapter, or a docs improvement, we're glad you're here.

## Two ways in

Both are first-class ways to contribute — pick whichever fits:

- **File an issue.** Report a bug, request a feature, or share a well-crafted
  agent prompt or implementation plan. Use the issue templates on the repo's
  Issues tab.
- **Open a pull request.** Fixes, features, and docs all land the same way. If
  you're not sure your change is wanted, open an issue first and we'll talk it
  through.

## Setting up

The repository uses Node.js 22, pnpm 10, and [`age`](https://age-encryption.org/)
— the vault tests exercise encrypted `*.md.age` slices through the real `age` and
`age-keygen` binaries. With those installed:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

The checked-in [`.mise.toml`](.mise.toml) can install and select the expected
Node.js, pnpm, and `age` versions when you use [mise](https://mise.jdx.dev/).

Changes under `deploy/` may also need Helm and Terraform. CI runs the canonical
chart and Terraform checks, and builds `deploy/docker/Dockerfile` for both
architectures the release publishes; see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the exact commands
and tool versions.

## What makes a great PR

- **One change per PR.** Small, focused diffs get reviewed and merged faster.
- **A test that fails without your change.** Break it, watch the test fail,
  restore your fix, and watch it pass.
- **`pnpm typecheck && pnpm test` green** before you open it.
- **A linked issue** where one exists, so the change traces back to the need.
- **A description written for a reviewer who skims:** what was needed, what the
  change ships, and how you verified it.

## Large, architectural, or security-sensitive changes

Open an issue first so we can agree on the approach before you write the code.
This is especially important for changes to the credential boundary, guarded
egress, brain isolation, or public configuration format.

## New integrations are especially welcome

The toolkit is built around seams for chat surfaces, brains, memory, and MCP
servers. Contributions that add a useful integration or make an existing one
safer and easier to operate are welcome. Match the neighboring package's shape,
keep credentials inside the gateway boundary, and include tests for the
observable behavior.

## Releasing

Maintainers cut a release from `main` in two steps:

1. Rename `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) to
   `## [X.Y.Z] - YYYY-MM-DD`, open a fresh `## [Unreleased]` above it, and merge
   that.
2. Tag that commit `vX.Y.Z` and push the tag.

[`release.yml`](.github/workflows/release.yml) does the rest: it builds the
runtime image for `linux/amd64` and `linux/arm64`, pushes it to
`ghcr.io/sageox/agent-base`, checks that it is pullable with no credentials, and
publishes a GitHub Release: the lead sentence of each of that version's CHANGELOG
entries, the published digest, and the pull requests GitHub lists for the tag.
Production pins that digest; the tags are for humans. Write each CHANGELOG entry
so its first sentence stands alone — that sentence is the release note.

A re-run reuses the digest already published under that version rather than
building a second one, so a release that failed *after* its push is repaired by
re-running it — never by moving the tag, which would leave anyone who pinned the
first digest holding one nothing references.

A GHCR package is private on its first push, and the release fails until it is
switched to **Public** in the package settings. That check is deliberate — a
quickstart that needs a registry token is not a quickstart, so the property is
verified on every release rather than assumed.

## Attribution

We're happy to co-author you on the resulting PR — share your preferred name
and email in the issue or PR, and we'll add you.

## Copyright

Unless you state otherwise, contributions intentionally submitted for inclusion
in this project are licensed under the Apache License 2.0, as described in
[LICENSE](LICENSE).
