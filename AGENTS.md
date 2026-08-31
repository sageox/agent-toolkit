<!-- ox:prime-check -->
Run `ox agent prime` at session start to load SageOx team context — it's fine to read the user's request first.

# AI Agent Instructions

<!-- ox:prime --> Run SageOx `ox agent prime` on session start, after compaction, or clear. (DO NOT REMOVE)

`ox` is SageOx's team-context CLI. It is optional for outside contributors — if you do
not have it, skip the line above and carry on; nothing in this repository needs it to
build, test, or run.

## Orientation

An opinionated toolkit for hosted AI chat agents that run on several chat surfaces at
once from one process and identity. Read [`README.md`](README.md) for the architecture and
[`SETUP.md`](SETUP.md) to run one.

The property every change has to preserve: **the brain holds no transport or write
credential.** It can only request actions through one guarded chokepoint, and the gateway
decides and executes. If a change lets a credential, a relay handle, or a write path reach
the brain's process, it is wrong however well it works.

## Build and test

Node 22+ and pnpm 10. The vault tests shell out to real [`age`](https://age-encryption.org/)
and `age-keygen` binaries, so install those too — or run `mise install`, which the
checked-in [`.mise.toml`](.mise.toml) pins.

```bash
pnpm install --frozen-lockfile
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit, root and every package
```

Both must be green before you open a pull request. Changes under `deploy/` also need Helm
and Terraform; [`.github/workflows/ci.yml`](.github/workflows/ci.yml) has the exact
commands and pinned tool versions.

Run the CLI from source with the checked-in wrapper — the packages are not published yet:

```bash
./bin/sageox-agent --help
```

## Layout

| Path | What |
|---|---|
| `packages/core/` | Gateway, guard, brain seam, MCP broker, job host, memory, policy |
| `packages/adapter-buzz/` | Buzz (Nostr) surface: relay client, NIP-42, engrams, identity |
| `packages/adapter-slack/` | Slack surface over Socket Mode |
| `packages/adapter-console/` | Local console surface |
| `packages/cli/` | `sageox-agent` — create, run, doctor, identity, memory, mcp, jobs |
| `deploy/` | Dockerfile, Compose, Helm chart, Terraform for AWS/EKS |
| `docs/` | Design specs, RFCs, the setup guide chapters, operational contracts |

## Conventions

- **Read [`docs/naming.md`](docs/naming.md) before naming anything that leaves this
  repository** — an MCP server, a package, a chart, a service, an environment variable.
  Ask its question: would this thing still exist, unchanged, if the Buzz adapter were
  deleted tomorrow? If yes, it is not Buzz's and must not be named after it.
  `test/naming.test.ts` fails on the spelling that keeps recurring.
- **Config is parsed as data, never evaluated.** The manifest loader must not gain a path
  that runs what it reads.
- **One change per pull request**, with a test that fails without it. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **CHANGELOG.md** gets an entry under `## [Unreleased]` for anything user-facing.
