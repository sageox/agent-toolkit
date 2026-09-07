---
name: agent-bringup
description: Create, configure, validate, and optionally publish a hosted agent with agent-toolkit. Use when asked to create, initialize, set up, bring up, register, or deploy an agent; configure its brain, chat surfaces, memory, MCP tools, or repository context; or diagnose an incomplete agent setup. Use agent-avatar for focused avatar work.
---

# Bring up an agent

Use the toolkit CLI as the implementation. Do not recreate its identity, credential,
surface, or deployment logic in the skill. Keep the agent directory declarative and make
each step safe to repeat.

## Choose the path

Inspect the target before changing it:

```bash
ls "${AGENT_TOOLKIT_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-toolkit/agents}"
./bin/sageox-agent doctor --agent <agent-name>
```

Each agent is one self-contained directory under that home. There is no `list` subcommand;
running the CLI with no arguments prints the usage and the home path it resolved.

- For a new human-guided agent, `./bin/sageox-agent create` is the user's to run in their own
  terminal. The interview covers mission inputs, definition of done, approval boundaries,
  voice, visual metaphor, palette, expression, and a role-specific joke, and avatar
  generation offers three candidates. A tool shell has no TTY, so the same command run by
  you asks nothing, takes every default, and skips preflight.
- To scaffold it yourself, supply the corresponding flags and either `--starter-avatar` or
  `--generate-avatar --avatar-candidates 1 --non-interactive`.
- For an existing agent, preserve its directory and use only the focused command for the
  missing capability. Never recreate an identity to repair registration.

Read [identity-design.md](references/identity-design.md) before drafting or substantially
changing `AGENTS.md`, `profile.json`, or the agent's operating contract.

## Create locally

Hand the guided flow to the user when they can answer at a terminal:

```bash
./bin/sageox-agent create --name <agent-name>
```

To scaffold it yourself, make every choice explicit — nothing is asked for:

```bash
./bin/sageox-agent create \
  --name <agent-name> \
  --display-name "<display name>" \
  --about "<one-line purpose>" \
  --inputs "<trusted inputs and sources>" \
  --success "<observable definition of done>" \
  --boundary "<actions requiring approval>" \
  --voice "<chat voice>" \
  --visual "<signature silhouette or prop>" \
  --metaphor "<visual role metaphor>" \
  --palette "<wardrobe and palette intent>" \
  --expression "<expression and posture>" \
  --joke "<role-specific visual joke>" \
  --starter-avatar --non-interactive
```

## Never handle a credential

You do not collect, hold, or write secrets. Every command that needs one resolves it from a
mounted secret, the environment, or the agent's `.env`, and refuses without a terminal by
naming the variable and the file:

```
ANTHROPIC_API_KEY is not set. Add it to .env:
  ANTHROPIC_API_KEY=<value>
(Get one at https://console.anthropic.com/settings/keys)
```

That message is the handoff. Relay it with the agent's `.env` path
(`<agents-home>/<agent-name>/.env`), stop that step, and continue with the steps that do not
need it. Do not ask for the value in chat, do not read, print, or grep `.env`, do not write a
value into it, and do not pass a secret as a CLI argument or an inline `VAR=… command` prefix
— an argument is visible in the process list and in this transcript. Every command is safe to
repeat, so rerun the same one once the user says the value is in place.

Which variable each capability needs:

| Capability | Variable | Notes |
|---|---|---|
| `brain claude` | `ANTHROPIC_API_KEY` | saved to `.env` at mode 600 |
| `surface slack` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | bot OAuth token and a Socket Mode app token |
| `identity register slack` | `SLACK_CONFIG_TOKEN` | one-time, environment only, never saved |
| `repos add --private` | `GITHUB_TOKEN` | read-only, and never inherited from your shell |
| `memory add team` | `SAGEOX_TOKEN` | |
| avatar generation | `OPENAI_API_KEY` | used for the request only, never saved |

`identity create` is the one secret this toolkit produces: it generates the Nostr key and
writes `BUZZ_NSEC` to `.env` itself. Never print, copy, or regenerate it. `identity show`
prints the public npub, which is the half that is safe to share.

## Preserve one identity bundle

Treat the agent directory as the source of truth:

- `agent.yaml` points the runtime at `AGENTS.md`.
- `AGENTS.md` owns behavior, evidence standards, voice, boundaries, and loop termination.
- `profile.json` owns the public name, description, and selected artwork.
- `avatar.md` owns durable visual identity; the shared house-style file owns rendering.
- `.env` owns local credentials, is written only by the CLI, and is never read back by you.

Extend these files instead of inventing a parallel persona or profile format. Use
`$agent-avatar` for focused artwork changes.

## Add capabilities incrementally

Use the relevant command, then rerun doctor:

```bash
./bin/sageox-agent brain claude --agent <agent-name>
./bin/sageox-agent identity create --agent <agent-name>
./bin/sageox-agent identity attach --agent <agent-name>
./bin/sageox-agent surface buzz --agent <agent-name> --relay <wss-url>
./bin/sageox-agent surface slack --agent <agent-name> --channels <ids>
./bin/sageox-agent memory add local --agent <agent-name>
./bin/sageox-agent memory add private --owner <org-npub-or-hex> --agent <agent-name>
./bin/sageox-agent memory add shared --with <agents> --agent <agent-name>
./bin/sageox-agent mcp add <github|surface-egress|surface-read> --agent <agent-name>
./bin/sageox-agent repos add <https-url> --agent <agent-name>
```

Use `identity attach` instead of `identity create` when the agent already exists on Buzz
and the user still has its private key. The command requests that key through a masked
interactive prompt, validates it, and saves it as the bundle's `BUZZ_NSEC` without printing
it. Without a terminal it takes an exported `BUZZ_NSEC`; the `buzz` CLI's `BUZZ_PRIVATE_KEY`
is never read, because it usually holds the operator's own identity. A relay's public
identity alone cannot recover a deleted private key.

`surface buzz` needs an identity first, and both surfaces take channel IDs — a display name
matches nothing. Without a terminal these commands do not ask, and each unanswered question
takes the closed default: an `owner-only` gate with no owner answers nobody, and the
public-channel guard stays shut. Both print a note saying so; read it rather than reporting
the surface as working. Pass `--owner-id <npub1…|U…>` to name the human it answers — an
owner id is public, not a credential — and `--allow-public` only with explicit approval.

Read [operations.md](references/operations.md) before configuring credentials, networked
surfaces, schedules, publication, deployment, or retirement. Read `SETUP.md` and command
help before using uncommon flags; do not import private-fleet flags or infrastructure.

## Publish only with approval

Creation is local. Registration changes external systems and can join channels, so require
explicit user approval:

```bash
./bin/sageox-agent identity register buzz --agent <agent-name> \
  --relay <wss-url> --channel <channel-id>
./bin/sageox-agent identity register slack --agent <agent-name> --app-id <app-id>
```

Use channel IDs, not display names. Preserve an existing Nostr key. If registration reports
missing membership, report the npub to the relay administrator and retry after admission.

Slack registration additionally needs a one-time `SLACK_CONFIG_TOKEN` in the environment
with `app_configurations:write`. It is deliberately never written to `.env`, so it is the
user's to export in the shell that runs the command — not yours to collect.

## Verify and hand off

Run the doctor for the intended runtime:

```bash
./bin/sageox-agent doctor --agent <agent-name>
./bin/sageox-agent doctor --bundle <agents-home>/<agent-name> --secrets <mounted-secret-dir>
```

For hosted deployment, hand the finished bundle to the operator's native deployment
configuration. One Compose app or Helm release may contain several bundles. Use the
checked-in artifacts as examples, not as infrastructure the framework owns:

```bash
docker compose -f deploy/docker/compose.yaml config
helm template <release> deploy/helm --values <operator-values.yaml>
```

Deployment secret directories are produced by the operator's SOPS, CI, or platform secret
system; never copy `.env` into them. Use `doctor --bundle <dir> --secrets <mounted-dir>` to
validate the same bundle and file-mounted secret layout the service will consume. The skill
does not generate Compose, Helm values, ConfigMaps, Secrets, or cloud resources.

Then verify the real consumer: run a bounded test message on each configured surface and
confirm the response appears in the expected channel or DM. Report what remains local,
what was published, which sources were degraded, and any human-only credential or admission
step that remains.
