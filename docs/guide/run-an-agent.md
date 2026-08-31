# Make it run

<sub>[Setup guide](../../SETUP.md) · 1 of 6 · run these commands from the repository root</sub>

## Step 1 — an agent that runs

```bash
./bin/sageox-agent create --name my-agent
./bin/sageox-agent run my-agent
```

`create` asks for the public display name and then develops an operating and visual
identity: purpose, trusted inputs, definition of done, approval boundary, chat voice,
visual metaphor, palette, expression, signature prop, and one role-specific joke. It
derives the internal directory/CLI name from the display name and only asks for another if
that name already exists. Those answers seed `profile.json`, the runtime-wired `AGENTS.md`
persona, and the durable character layer in `avatar.md`. Scripts can override the derived
name with `--name` or supply every interview answer as a flag.

It then offers to generate three high-quality 1024×1024 avatar candidates with GPT Image 2
and pauses so you can inspect them at full size and as 32 px circles before selecting one.
The prompt combines that agent-specific brief with one shared house style, matching the
internal fleet's two-layer system: changing the style can redraw the roster without changing
who a character is. The OpenAI key is read from `OPENAI_API_KEY` or hidden input, used for
that request, and never saved. The generated canonical PNG becomes `avatar.png` and
`profile.json` points both publishers to it. Decline or submit an empty key to keep the
publishable offline `avatar.svg` fallback. Nothing uploads until a destination and its
credentials exist in Part 2. Generation and publication first validate that `agent.yaml`,
`AGENTS.md`, `profile.json`, `avatar.md`, and the selected artwork form one coherent bundle.

Next, the same command asks which brain to use and where people should reach the agent.
The default Mock + Console path needs no account or credential. Choosing Claude asks for
its Anthropic key; choosing Buzz or Slack continues into only that surface's identity,
credential, relay, channel, and profile-publication questions. Buzz and Slack can both be
selected from the checkbox menu, in which case it completes both flows and retains both
surface identities. Console is always included and is not a mutually exclusive choice.

The wizard then offers memory as a checkbox list: Local, Shared, Team via SageOx, and
Buzz-private (when Buzz is configured) can be combined. It then offers one or more MCP
servers and, with Claude, repository context. Selecting GitHub asks which repositories the
agent may touch, which write tools to arm, and then for its token with hidden input; a
custom server asks for `SERVER_ENV=SECRET_NAME` mappings and then collects each mapped
secret the same way. Private repository setup likewise asks for a narrowly scoped,
read-only token. A blank answer to any of these skips that stage rather than ending setup
part-way; `memory add`, `mcp add`, and `repos add` add it later.
Finally, `create` runs `doctor` itself and stops: starting the agent with
`run` is the one deliberately separate action. Deployment is separate too: `create`
produces a portable bundle and makes no Docker, Kubernetes, secret-distribution, or hosting
choice. Every construction choice remains available later
through the individual `brain`, `identity`, `surface`, `memory`, `mcp`, and `repos`
commands.

Press Enter to accept every default, or make creation entirely non-interactive:

```bash
./bin/sageox-agent create --name camp-guide --display-name Harry \
  --about "Helps the team navigate unfamiliar systems." \
  --inputs "Repository state, tool evidence, and teammate questions." \
  --success "A cited recommendation and the smallest safe next action." \
  --boundary "Never merge, publish, or change access without approval." \
  --voice "Calm, compact, and lightly wry." \
  --visual "An oversized compass carried over one shoulder." \
  --metaphor "A backcountry systems cartographer." \
  --palette "Weathered green workwear with a brass accent." \
  --expression "Alert eyes and a patient half-smile." \
  --joke "A compass too large for the trail map." \
  --generate-avatar --avatar-candidates 1
```

Use `--starter-avatar` instead for a prompt-free, offline build. `init` is the
automation-oriented scaffold: it accepts the identity flags, uses defaults instead of
prompting, and always creates the starter SVG. `create --non-interactive` also uses
defaults without prompting, including when automation is attached to a terminal.

Re-running `create` keeps every file that already exists, generated artwork included: it
refuses rather than drawing over an `avatar.png` you already have. Edit `avatar.md` and
pass `--replace-avatar` when you do mean to redraw that agent.

A step that *fails* is reported and offered again in the same sitting. A `create` that never
returns at all — a closed terminal, a killed process — is what the checkpoint is for: run
`./bin/sageox-agent create` again and a single unfinished agent is detected and resumed from
its last completed section, or name it with `./bin/sageox-agent create --name <name>` when
several are unfinished. Completed profile, avatar, brain, surface, and memory choices are
not asked again. The tool and repository sections are open-ended loops with no list to
checkpoint, so they do ask again — but a server or repository that is already configured is
reported and skipped rather than added twice.

The checkpoint exists only while a guided setup is unfinished. Reaching the end of the
questions deletes it, including when the preflight is deferred with `Finish setup and fix
them later` — everything has been written by then, so there is nothing left to resume. A
scripted `create` over the same agent deletes it too: `--generate-avatar`,
`--starter-avatar` and `--non-interactive` finish that agent their own way, and such a run
says out loud that it dropped the checkpoint.

Type a message, get a reply. This is a **console agent with a mock brain**: no runtime
account, key, or model spend. It exercises the real gateway, guard, and egress path — only
the brain and the transport are local.

Agents live in `~/.config/agent-toolkit/agents/<name>/` — config, persona, public profile,
avatar, tool policy, credentials, and resume state together in one directory. The path is
surface-neutral on purpose: the same agent can run on Buzz, Slack, Discord, and a console
at once, so naming its home after any one of them would be wrong. Set
`AGENT_TOOLKIT_HOME` to move it.

That layout means the agent data is independent of the current repository or working
directory, and nothing an agent owns lands in the source tree. With only one agent you can
leave the name off. The source wrapper itself is invoked from this repository root.

Created: `agent.yaml` (what the agent is), `settings.json` (what its tools may do),
`AGENTS.md` (its persona — the voice is yours to write), `profile.json` (its public
identity), `avatar.md` (the style-independent character brief), and `avatar.svg` (a
publishable starter face). If you chose generation, `avatar.png` is added and selected in
the profile. No credential is stored; a console agent itself needs none.

## Step 2 — the real brain

```bash
./bin/sageox-agent brain claude     # asks for your API key and saves it
./bin/sageox-agent run
```

It prompts for the key (input hidden) and writes it to `.env` at mode 600 — you never edit
a dotfile. An existing key is kept, never overwritten.

**Under a service manager there is no terminal**, so instead of hanging on a prompt it
exits naming the variable to set. Same for `run`.

The key only ever reaches the brain subprocess. The gateway's own credentials are never
placed in that subprocess's environment — that separation is what makes a prompt-injected
agent unable to reach anything it was not given.

---

[← Setup guide](../../SETUP.md) · [Put it on Buzz or Slack →](chat-surfaces.md)
