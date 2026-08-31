# Naming

**The runtime is not Buzz-specific, so its identifiers must not be either.** Read this
before naming an MCP server, a package, a chart, a service, or anything else that leaves
this repository.

## The rule

Outside `packages/adapter-buzz/`, no identifier prefixes the agent with the surface — not
`buzz-agent-`, not `buzz_agent_`, not `BUZZ_AGENT_`, not `com.buzzagent`. There is no
longer an exemption for the repository slug: the repository was `buzz-agent-toolkit` and is
now `agent-toolkit`, which is what this rule asked of every other identifier. The old slug
survives only in `docs/design/` and `CHANGELOG.md`, which are records of what was true when
they were written. The GitHub `user-agent` still says `sageox-agent-toolkit`, because it
names the software making the call rather than the repository.

Ask one question: **would this thing still exist, unchanged, if the Buzz adapter were
deleted tomorrow?** If yes, it is not Buzz's and must not be named after it. GitHub tools,
a markdown vault on local disk, the cross-post tool, the SageOx team brain, the Helm chart,
the Compose project and the CLI all answer yes. `surfaces[].kind: "buzz"`, the relay,
NIP-42 auth, engrams, and the `BUZZ_*` variables buzz-acp owns all answer no, and keep the
name because it is accurate.

## The adapter exemption is about audience, not directory

`packages/adapter-buzz/` is exempt because that is where the name is accurate. But the
directory holds two kinds of identifier, and only one of them is the adapter's to name:

- **Internal** — the relay client, NIP-42 auth, the types nobody outside ever spells.
  Exempt, because the folder really is the whole audience.
- **Public** — exported symbols, MCP server names, tool names. Exempt for the wrong
  reason: they merely happen to be *declared* here. They land in someone else's import
  statement, `settings.json` allowlist, or protocol trace, none of which can see what
  directory a name was written in. The rule applies to these wherever they live.

`buzz-agent-private-brain` is the name that showed the difference. It was the private
brain's `serverInfo.name`, exempt for sitting in the adapter — while the same server is
wired under `private-brain` in `mcpServers`, and every policy names it
`mcp__private-brain__*`. `buzz` was accurate and `agent-` was the repository's, and between
them they made `initialize` and the tool policy describe one server in two different words.
It is `private-brain` in both places now, per the note below.

## Why it is worth doing early rather than correctly later

Renaming is cheap exactly once — before something publishes — and then it never is again.
`.github/workflows/release.yml` made this argument for the runtime image and named it
`ghcr.io/sageox/agent-base` rather than after the repository:

> A repository can be renamed on a Tuesday. A published image name cannot: consumers pin
> it, and every digest ever published stays reachable under it.

The same is true of every durable identifier, with a different mechanism each time:

| Identifier | What makes it permanent |
|---|---|
| Container image | Consumers pin it; every published digest stays reachable under the old name |
| npm scope | Installed names appear in every consumer's lockfile |
| MCP server name | Reaches the brain as `mcp__<server>__<tool>` and is written into each agent's `settings.json` allowlist |
| Helm chart name | Appears in every `helm install` and in the `app.kubernetes.io/name` label of every rendered object; changing it is a release migration |
| launchd Label | Each host has to be `bootout`/`bootstrap`ed by hand |
| IAM role, Secrets Manager path | Renaming rewrites live infrastructure and the policies bound to it |

None of that is an argument for guessing at future names. It is an argument for not
spending a name you already know is wrong.

Note the MCP row in particular. What the brain namespaces a tool under is the name the
server is **wired under** in `mcpServers` — `github`, `brain`, `team-brain`, `code`,
`surface-egress` — not the `serverInfo.name` the server reports at `initialize`. Keep the
two spellings identical anyway. When they diverge, a protocol trace and a tool policy
describe the same server with different words, and the next person debugging a refused
tool call has to discover that themselves.

## What keeps the name

- `packages/adapter-buzz/**` internals — the relay client, NIP-42 auth, engrams. Not the
  names that package publishes: its MCP server is `private-brain`, for the reason above.
- `surfaces[].kind: "buzz"`, and the `buzz:` prefix the guard qualifies a channel with —
  derived from that `kind`, never written by hand.
- `BUZZ_NSEC`, `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` and the rest of `BUZZ_*` — buzz-acp
  and the `buzz` CLI own those spellings; this repository only reads them.
- The `buzz` subcommands: `surface buzz`, `identity register buzz`.
- **The repository itself.** It drops the prefix once there are enough adapters to
  justify it; that is a marketing decision on its own schedule, and it is not a licence to
  spend the prefix anywhere else in the meantime.
- Historical records — `CHANGELOG.md` and `docs/design/`. They describe what
  was true when they were written, and rewriting them makes them lie.

## Enforcement

`test/naming.test.ts` fails on a new one. It checks the prefix, which is the mistake that
actually recurred; it cannot check the judgment above, so a name that passes the test is
not yet a name that is right.

It skips the historical records and — because a rule that cannot name what it forbids is
not a rule — this file and the test itself.

It does not skip `packages/adapter-buzz/`, which is not in tension with the exemption
above. What the adapter earns is `buzz`; what the test forbids is `buzz` followed by
`agent`, the one reading this document exists to deny, and the adapter has never held one.
It was skipped by directory until `buzz-agent-private-brain`, and the fix is not a smarter
skip. Anything that decides per line whether a name looks public — an `export`, a quoted
literal — can be beaten by moving that marker to the line above, which a formatter will do
on its own at 100 columns. A rule that turns on where somebody pressed return is not a
rule. There is nothing in there to exempt, so nothing has to be classified.
