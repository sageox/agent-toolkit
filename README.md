<div align="center">

# SageOx Agent Toolkit

**A hosted AI coworker in the channels where your team already talks — open source, and
yours to run.**

[![CI](https://github.com/sageox/agent-toolkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sageox/agent-toolkit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sageox/agent-toolkit?sort=semver)](https://github.com/sageox/agent-toolkit/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](.mise.toml)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Quickstart](#quickstart) · [Setup guide](SETUP.md) · [Architecture](#the-idea-in-one-picture) · [Team memory](#team-memory-over-sageox) · [Status](#status) · [Docs](#documentation) · [Contributing](CONTRIBUTING.md)

</div>

---

- Hosted agents, on your own infra.
- One agent, one memory, across Buzz and Slack.
- Your team's context, inherited and live, when SageOx is connected.

One process runs the agent: a gateway that owns every connection and credential, and a
model that writes the replies. Every surface multiplexes into that one model, and each
reply routes back out the way it came in. The agent is the same character across surfaces:
one memory, one persona, one profile.

An agent that reads from open channels will eventually read something written to
manipulate it. So the model holds no credential of its own — not for the transports, not
for the tools. It can only ask; the gateway holds the keys, decides, and executes.

And it does not start cold. Point it at your team's knowledge on
**[SageOx](https://sageox.ai)** and the agent answers out of what your team already
decided — read-only, and drawn from work people were doing anyway.

**→ [Team memory](#team-memory-over-sageox)**

## Quickstart

Node ≥ 22 and pnpm. The repo carries a [`.mise.toml`](.mise.toml) if you'd rather not
manage either by hand.

```bash
pnpm install --frozen-lockfile
./bin/sageox-agent create --name my-agent
./bin/sageox-agent run
```

An agent answering in your terminal on a mock brain — **no runtime account, key, or model
spend.** It exercises the real gateway, guard, and egress path; only the brain and the
transport are local.

`create` is a guided interview that builds one coherent identity rather than just naming a
bot: purpose, approval boundary, voice, and look become its public profile, its persona,
and a generated avatar. It then offers a real brain, chat surfaces, memory, and tools —
each one optional, each one resumable if you close the terminal.

Everything after the first reply is a separate step, and every step ends with something you
can run. **→ [SETUP.md](SETUP.md) walks the whole journey.**

The step most worth taking first is [team memory](#team-memory-over-sageox): an `ox` login,
a token, and one `memory add team` — after which the agent stops guessing at what your team
already settled.

## The idea in one picture

[![Architecture: inbound → gateway → brain → guard → outbound](docs/images/architecture.png)](docs/design/2026-08-12-multi-surface-agent-toolkit-arch.html)

<sub>Open [the HTML version](docs/design/2026-08-12-multi-surface-agent-toolkit-arch.html) in a browser for the readable original.</sub>

The safety property in the lede has one consequence worth spelling out: **MCP servers run
inside the gateway**, not beside the brain. The gateway spawns them with the credential in
its own process and publishes them to the brain over HTTP behind a per-server capability
token. A prompt-injected brain can only ask, and every ask meets the policy and the guard.

**The brain gets tools, never tokens.**

## What you get

Everything below is implemented and covered by the test suite; the Buzz path is also
verified against a live relay.

| | What it does | Depth |
|---|---|---|
| **Surfaces** | Buzz (Nostr) and Slack, live and concurrent: threaded replies, reactions, typing indicators, DMs, and channel filtering. A cursor survives restarts, so a restarted agent catches up on what moved while it was away. | [Guide ch. 2](docs/guide/chat-surfaces.md) |
| **Brains** | A mock brain for free local work, or **Claude driven over ACP**. A refused reply comes back to the brain as a refusal it can adapt to mid-turn. | [Guide ch. 1](docs/guide/run-an-agent.md) |
| **Identity** | A declarative profile, a style-independent character brief, and a generated avatar with an offline SVG fallback. Create a fresh Buzz signing key or adopt an existing one, then publish the same face to Buzz and Slack. | [Guide ch. 1](docs/guide/run-an-agent.md) |
| **Cross-surface posts** | Ask the agent in Slack to post to a Buzz channel, or the reverse. Enabled by default, under the same channel guards as an ordinary reply. | [Guide ch. 2](docs/guide/chat-surfaces.md) |
| **Memory** | Local and explicitly scoped shared markdown vaults, optional age-encrypted `*.md.age` slices, encrypted private NIP-AE engrams on Buzz, and a read-only **team brain over SageOx**. | [Below](#team-memory-over-sageox) · [Guide ch. 3](docs/guide/memory-and-tools.md) |
| **MCP tools** | Any MCP server, credential held by the gateway, with the tool policy written for you from what the server reports. **`scope` bounds the credential to the job** — fail-closed, so a token that reaches an org reaches one repository. Every argument is leak-scanned on the way out. | [Guide ch. 3](docs/guide/memory-and-tools.md) |
| **Repository context** | Optional durable checkouts, background `ox` code indexing, and gateway-hosted read-only search and status tools. | [Guide ch. 3](docs/guide/memory-and-tools.md) |
| **Scheduled jobs** | Cron and event-driven work declared in `agent.yaml` beside the surfaces it shares an identity with. **The toolkit owns the envelope, never the body:** a kill switch with a declared fail-direction, single-flight per slug, a wall-clock budget under the platform deadline, and a run record for every tick — including the ones that never ran. | [Contract](docs/job-contract.md) · [RFC](docs/design/2026-08-19-jobs-rfc.md) |
| **Audit log** | One `tool_call` line per MCP call, allowed and refused alike, from both places a call can be made. **Arguments are recorded by declaration** — a body shows up as `<string 1300>`, never as its text. | [Guide ch. 5](docs/guide/reference.md#what-the-log-says-about-tool-calls) |
| **Readiness** | A cold index or an unreachable brain is a reading the agent *discloses*, not a reason it is not there to be asked. Only a precondition can refuse a launch; no capability health ever does. | [Startup](docs/startup-and-readiness.md) |
| **Hardening** | Per-channel serialization, rate/thread/agent-chain caps, an author gate, a kill switch, and a per-turn timeout. | [Guide ch. 5](docs/guide/reference.md) |
| **Deployment** | One deployment-neutral image, file-mounted secrets, a canonical Helm chart, and Terraform-managed AWS/EKS. | [Contract](docs/deployment-contract.md) · [below](#deploying-a-fleet) |

## Team memory over SageOx

An agent that has read what your team already decided stops asking your team to repeat it.
The **team brain** gives the agent read-only search over your team's own recorded knowledge
— discussions, decisions, docs, and prior AI-coworker sessions — through
[SageOx](https://sageox.ai) and its [`ox`](https://github.com/sageox/ox) CLI, as one tool:

| Tool | What it reaches |
|---|---|
| `team_search` | Recorded discussions, decisions, docs, and prior sessions |

**It reads; it does not write.** An agent that can write to team memory is an agent whose
worst turn becomes a fact a colleague cites six months later. What the agent searches is
what your teammates recorded by running `ox` in their own repositories — so the corpus grows
from work people were doing anyway, not from a documentation chore.

### Wiring it up

The team brain attaches to an agent, so create one first with `./bin/sageox-agent create`.

**1. Get an account and the CLI.** Sign up at [sageox.ai](https://sageox.ai), then:

```bash
brew install sageox/tap/ox   # qualified: `ox` also exists in homebrew/core
ox login                     # for you, at the terminal — `ox teams` needs it
ox teams                     # the teams you belong to, with their IDs
```

Other install methods: [ox install docs](https://github.com/sageox/ox#install).

**2. Create a personal access token** at
[sageox.ai/settings/tokens](https://sageox.ai/settings/tokens) — prefixed `oxp_`, shown
once — and put it in the agent bundle's `.env` as `SAGEOX_TOKEN`.

**The agent always authenticates with a PAT**, on your workstation and in a container
alike: the token takes precedence over anything on disk, so the manifest you test locally
is the one you deploy. Never give the agent the token from your own `ox login` — that one
expires within hours and cannot refresh itself once out of ox's hands.

**3. Add the brain.**

```bash
./bin/sageox-agent memory add team
```

Leave `--team` off and it lists your teams **by name**, resolves the ID once, and writes it
into `agent.yaml` with the matching tool-policy entries — memory tools arrive namespaced
(`mcp__team-brain__team_search`), and a policy that omits the prefix matches nothing.

```yaml
brains:
  - preset: team
    team: team_xxxxxxxx     # the ID from `ox teams`, not the slug — a slug 403s
    token: SAGEOX_TOKEN     # a secretRef; the gateway resolves it, the brain never sees it
```

`token` names the secret, never the token itself, so a deployment supplies it through
whatever already holds its secrets. `doctor` checks the token with SageOx and reports its
rolling expiry.

The rest is in
[the team brain's credential](docs/guide/reference.md#the-team-brains-credential) and
[Guide ch. 3](docs/guide/memory-and-tools.md).

## Deploying a fleet

Several agents, one versioned runtime image, ordinary Compose:

```bash
export AGENT_IMAGE=ghcr.io/sageox/agent-base@sha256:<digest>
export AGENT_UID=$(id -u)
export AGENT_GID=$(id -g)
export HARRY_BUNDLE=~/.config/agent-toolkit/agents/harry
export HARRY_SECRETS=/srv/agent-secrets/harry
export IDA_BUNDLE=~/.config/agent-toolkit/agents/ida
export IDA_SECRETS=/srv/agent-secrets/ida

docker compose -f deploy/docker/compose.yaml up -d
```

Each release records the digest to paste there — take the newest from
[Releases](https://github.com/sageox/agent-toolkit/releases). **Pin the digest rather
than a tag:** `:latest` and `:0.1` move, `@sha256:…` does not.

The [Helm chart](deploy/helm) likewise takes multiple agents in one release, using native
Secret and PVC references and taking each bundle's source as a Kubernetes volume — and can
be consumed as a subchart. Past about three agents, read
[fleets and the mayor](docs/fleets-and-the-mayor.md) before adding the fourth.

## Status

**Pre-1.0.** The surfaces, guard, memory, MCP, job, and deploy paths listed above work and
are tested. Configuration format and CLI flags may still move between minor versions; the
[CHANGELOG](CHANGELOG.md) records every change and the [releases](https://github.com/sageox/agent-toolkit/releases)
publish a pinnable image digest.

Not built yet:

- **A separate-container tier.** The brain is a child process, so it shares the gateway's
  filesystem. Credentials are kept out of its *environment*, but that is not a filesystem
  boundary.

The toolkit is the **SageOx Agent Toolkit**, which is what its packages are published as
(`@sageox/agent-toolkit-*`) and what the repository is called. A slug leading with one
surface would misdescribe a runtime that carries several, and no shipped artifact carries
the repository's name either — the image is `ghcr.io/sageox/agent-base`, the CLI is
`sageox-agent`, the chart is `agent`. See [`docs/naming.md`](docs/naming.md) before naming
anything that leaves this repository.

## Key decisions

- **One brain, many surfaces, live** — one process multiplexes N surfaces into one
  Claude-via-**ACP** brain; replies route back out the origin surface.
- **Buzz is a native TS Nostr client**, not a shell to the `buzz` CLI, which cannot
  subscribe.
- **Config is parsed as data, never evaluated** — a schema-validated YAML manifest; the
  loader cannot be made to run anything by the file it reads. That is a guarantee about
  parsing, not about what the values name: `mcpServers[].command` and `brains[].command`
  select processes the runtime spawns. **A bundle is code-equivalent — review a manifest
  change the way you review code.**
- **Simple-default, hardened-opt-in** on every axis: secrets (`.env` → mounted files),
  Nostr signing (nsec → NIP-46), isolation (env-scoped subprocess → container).
- **An agent is a directory.** Config, persona, public profile, character brief, avatar,
  tool policy, local memory, and cursor live together under
  `~/.config/agent-toolkit/agents/<name>/`, so an agent is movable, inspectable, and
  deletable in one step. Shared memory lives beside agent directories because no one
  participant owns it.

## Documentation

**Start with [`SETUP.md`](SETUP.md)** — six chapters, each ending in something you can run,
from the first reply in your terminal to a deployed fleet.

Everything else is in [`docs/`](docs): the [guide chapters](docs/guide) themselves, the
deployment and job contracts, the AWS/EKS walkthrough, and the design spec and RFCs that
record why the toolkit is shaped the way it is. The chart and Terraform live in
[`deploy/`](deploy).

## Contributing

**Pull requests are welcome** — a one-line fix, a new chat adapter, or a docs improvement
all land the same way. New integrations are especially welcome: the toolkit is built around
seams for chat surfaces, brains, memory, and MCP servers.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for what makes a great PR and when to open an
issue first. Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
Everyone participating is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Tech stack

TypeScript · pnpm workspaces · Vitest · zod (manifest) · nostr-tools (Buzz) · Slack Node SDK · ACP (brain seam).

## License

Apache License 2.0 © 2026 SageOx Inc. See [LICENSE](LICENSE).
