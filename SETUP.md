# Creating and running an agent

**Each chapter adds one capability and is independently useful.** Stop wherever you have
what you need — nothing later is required by anything earlier, and every step ends with
something you can run.

## Before you start

**Requires Node 22+ and pnpm 10.** If you use [mise](https://mise.jdx.dev/), run
`mise install` first; the checked-in [`.mise.toml`](.mise.toml) selects both versions.
Then install dependencies once:

```bash
pnpm install --frozen-lockfile
```

Run the commands in this guide **from the repository root**. A source checkout does not
install a global `sageox-agent` command, so the examples use its checked-in wrapper,
`./bin/sageox-agent`.

Run `./bin/sageox-agent doctor` between steps. It is the difference between finding a
problem in one command and finding it as an agent that looks healthy and answers nobody.

## The first two commands

```bash
./bin/sageox-agent create --name my-agent
./bin/sageox-agent run my-agent
```

Type a message, get a reply. That is a **console agent with a mock brain**: no runtime
account, key, or model spend. It exercises the real gateway, guard, and egress path — only
the brain and the transport are local.

Everything after that — a real brain, a public identity, a chat surface, memory, tools,
scheduled jobs, a deployment — is a separate optional step, each one command.

## The guide

| # | Chapter | What you end up with |
|---|---|---|
| 1 | [Make it run](docs/guide/run-an-agent.md) | An agent with an identity and a face, answering in your terminal — then answering from Claude. |
| 2 | [Put it on Buzz or Slack](docs/guide/chat-surfaces.md) | The same agent live in a real channel: signing identity, relay or Socket Mode, published profile, guarded egress, cross-surface posts. |
| 3 | [Give it memory and tools](docs/guide/memory-and-tools.md) | Markdown vaults, encrypted slices, private engrams, the team brain, MCP servers bounded by `scope`, and repository context. |
| 4 | [Run it for real](docs/guide/run-it-for-real.md) | Kept alive by launchd, or deployed as one or more bundles with Compose or Helm. |
| 5 | [Reference](docs/guide/reference.md) | What each file is, where every credential lives, how to name tools in a policy, what the tool-call log records, and what survives a restart. |
| 6 | [When something is wrong](docs/guide/troubleshooting.md) | The failures that actually happen, what each one means, and the known limits. |

## Related

- [`README.md`](README.md) — what the toolkit is and the safety property it exists to hold.
- [`docs/deployment-contract.md`](docs/deployment-contract.md) — the runtime contract every deploy target implements.
- [`docs/startup-and-readiness.md`](docs/startup-and-readiness.md) — why an agent connects before it is warm.
- [`docs/fleets-and-the-mayor.md`](docs/fleets-and-the-mayor.md) — doctrine for running more than about three agents.
