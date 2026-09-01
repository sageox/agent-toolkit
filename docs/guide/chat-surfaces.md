# Put it on Buzz or Slack

<sub>[Setup guide](../../SETUP.md) · 2 of 6 · run these commands from the repository root</sub>

Skip this entire part for a console-only agent.

## Step 3 — an identity

```bash
./bin/sageox-agent identity create      # prints the npub to register
./bin/sageox-agent identity attach      # reuse an existing Buzz identity
./bin/sageox-agent identity show        # prints it again later
```

Writes `BUZZ_NSEC` to `.env` at mode 600. **The secret never leaves the machine**; the
`npub` is the half you hand out.

Use `identity attach` when Buzz already knows the agent and you are rebuilding its local
bundle. It asks for the private key with hidden input, validates it, and saves it as this
agent's `BUZZ_NSEC`. The key is never accepted as a command-line argument or printed. For
non-interactive use, export `BUZZ_NSEC` and it is attached without asking. `BUZZ_PRIVATE_KEY`
— the `buzz` CLI's own variable — is deliberately ignored: it usually holds your personal
identity, not the agent's.

Deleting an agent directory also deletes its local `.env`; the relay's public identity
cannot restore signing access unless the corresponding private key still exists elsewhere.

## Step 4 — check the relay before committing to it

```bash
./bin/sageox-agent probe --relay wss://your-relay.example
```

Read-only: it connects, answers a NIP-42 challenge with the selected agent's identity if
there is one, and reports the event kinds, tag names, and channels the relay actually
serves — then checks those against the conventions this adapter assumes. With multiple
agents, add `--agent <name>`.

This exists because a convention mismatch produces **silence**, which is indistinguishable
from "nobody has mentioned me yet." If the probe says `kind 9 MATCHED NOTHING`, edit
`BUZZ_DEFAULTS` in `packages/adapter-buzz/src/normalize.ts` to the kinds and tags it
listed, and run it again.

## Step 5 — the Buzz surface

Register first, so the agent has a name, a face, and a channel to be mentioned in:

```bash
./bin/sageox-agent identity register buzz --relay wss://your-relay.example
./bin/sageox-agent surface buzz --relay wss://your-relay.example
```

`register buzz` (or the backward-compatible `register`) prompts for the relay (offering
the one in your config as the default) and lists the relay's channels for you to pick
from. It reads the complete name/about/NIP-05/avatar profile from `profile.json`, renders
an SVG source or canonicalizes a generated PNG, uploads it, then shells out to the `buzz`
CLI — the real client — to set the profile, signed with the agent's **own** key.
It then prints the `buzz channels add-member … --role bot` command that a channel owner
or admin must run from their own authenticated terminal. The bot key must not grant its
own channel access or role. `set-profile` replaces omitted fields, which is why these
values live in one declarative file instead of a command you have to reconstruct later.

To finish the channel step in the same command, add `--add-as-bot`. Registration asks for
the channel owner/admin private key through a hidden prompt, uses it only for the
`channels add-member` child process, and never writes it to `.env`, `agent.yaml`, command
arguments, or output:

```bash
./bin/sageox-agent identity register buzz --relay wss://your-relay.example --add-as-bot
```

Registration publishes one more thing alongside the profile: a **directory record**, naming
the channels the agent answers in and who may wake it. A profile and channel membership are
not enough to be reachable — clients gate their mention picker on that record, and a mention
of an agent without one is *stripped at send*. The message posts, carries no mention tag, and
the agent — connected, authenticated, subscribed — never hears it. Nothing distinguishes that
from a slow or wedged brain, which is why `doctor` checks for it:

```
FAIL  surface buzz: no directory record published — clients strip mentions of this agent
      at send, so it is connected but unreachable; publish it with
      `sageox-agent identity register buzz`
```

The same failure is reported when the record has drifted — when it omits a channel the
manifest declares, or its `respond_to` no longer matches the config. Rerunning registration
republishes it. The record is read-merged rather than overwritten, so settings written by
other tools survive. `respondTo: owner-only` publishes as an allowlist of the owners, which
is what it means and what clients read; a mode they do not recognise would read as "never
mentionable" and hide the agent from the very person it answers.

On a membership-gated relay, a new identity may be refused before it can publish that
profile or list and join channels. Registration calls this out with the identity's npub
and finishes successfully so the rest of setup can continue. Ask a relay owner or admin
to add that npub, then rerun registration. Once the Buzz surface is configured, `doctor`
checks relay access when the `buzz` CLI is available and keeps the missing membership
visible until it is granted.

```json
{
  "display_name": "harry",
  "about": "The camp guide.",
  "nip05": "harry@example.com",
  "avatar": "avatar.svg"
}
```

Edit `avatar.md` before replacing the starter art: it owns the character's silhouette,
prop, palette intent, expression, and joke independent of any one rendering style. Point
`profile.json` at either an SVG or PNG. SVG publication needs `rsvg-convert` (`brew install
librsvg` on macOS; `apt install librsvg2-bin` on Debian/Ubuntu); PNG metadata is stripped
automatically because the Buzz media validator accepts only canonical image chunks.

`surface buzz` then lists the relay's channels for you to pick from by number, and asks
which of those are private:

```text
  channels on this relay:
    1. hive  (6f1c0a2e-…)
    2. town  (9a3b17c4-…)

Which should the agent listen and reply in? (numbers, blank for none): 1

  Which of those are private? A relay cannot tell us, and anything left out is
  treated as public — which you will be asked to consent to, one channel at a time.
    1. hive

  Numbers, blank for none: 1
```

Picking nothing configures no channels, and the agent subscribes for mentions instead —
which this relay answers on reconnect rather than streaming. That is a bring-up state, not
a working one: a mention arrives from a channel no entry lists, so it counts as public and
the reply is refused. `doctor` reports it until you list the channels it should answer in.

Privacy is your assertion. Unlike Slack, a relay has no endpoint that reports it, so
nothing can check what you say — and anything left out of the privacy answer is treated as
public, which the guard refuses to post in unless you consent to that channel when asked.
Declining leaves it out of `channels` rather than listing a channel the agent could never
answer in.

It records both the channel ID it needs and the name you use, so you can later ask the
agent to post in "hive" rather than reciting a uuid:

```yaml
surfaces:
  - kind: buzz
    relayUrl: wss://your-relay.example
    identity: BUZZ_NSEC
    channels:
      - { id: 6f1c0a2e-…, name: hive, reply: private }
```

To script it, pass the IDs and skip the menu entirely:

```bash
sageox-agent surface buzz --relay wss://your-relay.example \
  --channels 6f1c…-…-…  --private-channels 6f1c…-…-…
```

Those are IDs, not display names — a channel's ID is what the relay puts in an event's
`h` tag, so a name there matches nothing and the agent goes quiet in a channel it looks
configured for. `identity register` prints the ID of the channel selected for the human
owner/admin membership step. The same flag form is what runs when the `buzz` CLI is
missing or the relay cannot be reached.

Run `surface buzz` once: it refuses a second Buzz surface, so channels added later are a
hand edit to `agent.yaml`.

Requires the `buzz` CLI on your PATH.

Until the profile exists the agent is an unnamed pubkey nobody can mention, and until it
joins a channel it hears nothing there — which looks exactly like "nobody has mentioned me
yet."

`anyone` was fine for a local console and is not fine for a relay. If `respondTo` is
already `owner-only`, `surface buzz` asks for the npub that should own it — yours, not the
agent's — because an `owner-only` agent with no Nostr id in `owner` answers nobody. Set it
by hand if you would rather:

```yaml
respondTo: owner-only
owner: "<your npub>"
```

## Step 5b — Slack, instead of Buzz or alongside it

`surfaces:` is a list, and Step 5 and this step both append to it. One agent — one
identity, one brain, one memory, one set of limits — can be reached from Buzz and Slack
at once, and answers in whichever surface it was addressed on. Run either command, or
both:

```bash
sageox-agent surface buzz  --relay wss://your-relay.example --channels <channel-id>
sageox-agent surface slack --channels C0123,G0456 --private-channels G0456
```

Create a Slack app, enable **Socket Mode**, and create an app-level token with
`connections:write`. Install the app with these bot scopes:

- `app_mentions:read`, `chat:write`, and `reactions:write`
- the matching history and read scopes for the conversations you configure
  (`channels:history`/`channels:read`, `groups:history`/`groups:read`,
  `im:history`/`im:read`, or `mpim:history`/`mpim:read`)

Subscribe the bot to `app_mention` and `message.im`, invite it into each channel, then run:

```bash
sageox-agent surface slack --channels C0123,G0456 --private-channels G0456
```

The command asks for the `xoxb-` bot token and `xapp-` Socket Mode token with hidden input,
stores them as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`, and adds only their references to
`agent.yaml`.

It then uses the token you just gave it to ask Slack which of those channels are actually
private — the same `conversations.info` call the adapter makes at startup, so setup and
runtime cannot disagree. Private ones are written as `reply: private` for you; you only
need `--private-channels` to assert privacy when the bot lacks the scope to ask, or is not
yet in the channel.

Slack's answer wins over the flag in both directions. If you assert `--private-channels`
for a channel Slack reports public, the assertion is **dropped** and the command says so.
That is not pedantry: the adapter seeds its private set from config and only ever adds to
it, so a wrong assertion is never revoked at runtime — the channel would normalize as
private, the guard would never see a public channel to refuse, and the rule you kept on
would be refusing nothing.

Anything Slack calls public raises the one question the guard forces:

```
  C0123 is public — the agent would answer there in front of everyone who can
  read it, including what it reads from its brains. Only C0123 would be listed
  that way; every other public channel stays refused.

  Answer publicly in this channel? [y/N]
```

Answering yes lists that channel — and only that channel — as one it answers in publicly:

```yaml
surfaces:
  - kind: slack
    channels:
      - { id: C0123, reply: public }    # consented during setup
      - { id: G0456, reply: private }
```

That entry **is** the consent the egress guard enforces. There is no second list to keep
in step with this one and no manifest-wide switch to turn the rule off: the only way to
reach a public channel is to name it here, one channel at a time.

Answering no leaves the channel out of `channels` entirely, and the command says so. That
is the honest outcome of declining: a channel the agent listens in but may never answer in
is advertised as mentionable, wakes the agent, spends a turn, and says nothing.

It is asked rather than inferred: naming a channel says where the agent should listen,
which is not the same as saying it may speak there. Without a terminal, pass
`--allow-public` — otherwise the public channels are dropped and the command says so.

### Leak patterns — the second gate on a public destination

A grant says the agent may speak in a channel. It does not say everything the agent knows
belongs there. `guard.leakPatterns` is the second gate on that grant: text that must not go
out in front of the public, scanned at the same chokepoint every send passes through — an
ordinary reply and a cross-post alike.

```yaml
guard:
  leakPatterns:
    - name: internal-hostname
      regex: '\b(?:host\.internal|corp\.example\.com)\b'
    - name: bead-id
      regex: '\bacme-[a-z0-9]{5}\b'
    - name: adr-reference
      regex: '\bADR-\d+\b'
    - name: github-token
      regex: '\bgh[pousr]_[A-Za-z0-9]{20,}\b'
```

Those four are the kinds worth carrying: **internal hostnames**, **ids from a private
tracker**, **decision-record references** (citing one in public publishes its existence and
its numbering), and **secret shapes**. The patterns themselves ship with no defaults,
because every one of them is a fact about your organization and not about a toolkit — a
list that guessed would fire on somebody's legitimate content, and a gate that cries wolf
is a gate people route around.

Three rules the toolkit holds you to:

- **It only runs on the way somewhere public.** A private reply is never content-filtered.
  The guard's other rules ask where a message is going; this one is the exception, and
  narrowing it to public destinations is what keeps it cheap enough to run on every send.
- **A quantifier may not apply to a group.** `(…)+`, `(?:…)*` and `(…){2,}` are refused at
  load: a repetition nested inside a repetition is how a pattern backtracks catastrophically
  and stalls the gateway on a message someone else wrote. Quantify a character class
  instead, or drop the group — `\b(?:[a-z0-9-]+\.)*host\.internal\b` and
  `\bhost\.internal\b` match the same strings.
- **A hit is reported by name, never by quotation.** The refusal handed back to the brain
  and the line written to the log both say `internal-hostname, bead-id` and stop there.
  Quoting the text that matched would put the leak in the log. A name is a slug — lower-case
  letters, digits and hyphens, the same shape as a job's — because a name free to hold a
  newline or a quote could close the log's `reason="…"` field and write a second
  `egress_blocked` line that no egress produced.

Matching is case-insensitive, and every pattern that fires is named rather than just the
first — a brain that strips a hostname and re-sends into a bead id has learned the same
lesson twice.

#### The same patterns on every MCP call

A public channel is not the only way out. An MCP server can open a pull request, file an
issue, or run a query, so the broker runs the same patterns over **every string argument of
every call** on the way out — reads included. A token pasted into a search query has reached
a third party exactly as surely as one pasted into an issue body.

Every argument rather than the ones a tool declares as prose: a per-tool list fails open the
first time somebody forgets an entry, and over-scanning an identifier costs a false refusal,
which fails closed. The cheap direction is the safe one.

**Public repositories only, and GitHub is asked which those are.** The manifest has no
`public: true` beside `repos`, deliberately: an operator who marked a public repository
private would get a scan that never fires on the one destination it exists for, and nothing
would ever say so. So the runtime asks — `GET /repos/{owner}/{name}` — the same way
`sageox-agent surface slack` asks Slack which channels are private rather than believing
what it was told. If GitHub will not answer, the write is refused: a scan that cannot
establish where the text is going does not proceed.

The question is asked *after* the scan, and only if something matched. Both orders give the
same verdict — text nothing matched goes to a public and a private repository alike — so a
clean pull request costs no extra request, and an agent that declares no patterns is never
asked about visibility at all.

What it still does not reach: **a job body that shells out to `gh`**. The job host spawns
a process and reads an exit code and a verdict file; it cannot see the work, which is the
point of the job boundary. Nothing in the toolkit can scan that — keep it bounded where
the job runs, with a check of your own.

Channels have to be listed because a channel exists before the bot does. A DM does not —
its conversation ID appears only once someone opens it — so DMs need no entry, and
`message.im` is what turns that path on or off. A DM counts as private, and as a direct
address: inside one the bot answers without being tagged. Drop `message.im` from the
event subscriptions if you do not want that.

The author gate is the second thing `surface slack` settles with you. You are one person
with one id per surface, and an id is only ever matched against the surface it arrived
from — so an agent that is `owner-only` with only an npub answers nobody on Slack. When
that is the state it finds, the command asks:

```
  respondTo is `owner-only` and `owner` names no Slack id, so the agent would
  answer nobody on Slack.

    1) just me — I will paste my Slack member ID
    2) anyone in the workspace

  Choice [1]:
```

Your member ID is in Slack under your profile → **⋮** → **Copy member ID**. It is appended
to `owner` rather than replacing what is there, because the npub is what still admits you
on Buzz. `--owner-id U…` answers the same question without a terminal.

Choosing (2) writes `respondTo: anyone`: every workspace member may address the agent, and
each turn spends your model key. `doctor` reports it as a **warning** rather than refusing
to start — a deployment that runs exactly as its operator wrote it is not broken, and the
tool has no business overruling that. It keeps saying so until you narrow the gate, and
until you do, the `limits:` block is the only thing rationing who spends what.

`owner` therefore ends up a list, in whatever mix of surfaces you are reachable on:

```yaml
respondTo: owner-only
owner:
  - "<your npub>"     # how Buzz knows you
  - "U08…"            # how Slack knows you
```

A single string still works and means an owner on one surface. `allowlist` works the same
way — list every id the same person or team uses. `doctor` fails if `owner-only` names
fewer ids than you have networked surfaces, because the surfaces without one answer
nobody, which is indistinguishable from a broken agent.

Socket Mode does not replay missed events. On restart the adapter connects first and then
pulls `conversations.history` from its saved cursor, deduplicating any overlap with live
events. Because history returns thread parents but not their replies, it also pulls
`conversations.replies` for every thread that moved during the gap. Two gaps remain: a
reply under a parent older than the cursor stays missed — that parent is outside the
history window, and Slack cannot enumerate the threads that moved in a period — and DMs
are not backfilled at all, since the adapter has no list of them until they speak.

### Publish its face on Slack

Publish the same `profile.json` and avatar Slack users will see on every message:

```bash
sageox-agent identity register slack --app-id A0123
```

`identity register slack` asks for a Slack app configuration token with
`app_configurations:write`, exports the current app manifest, changes only the app name,
description, and bot display name, then uploads the avatar at 512×512. It does not replace
the rest of the manifest and does not save the configuration token. Generate that
short-lived token under **Your App Configuration Tokens** on
[Slack's app settings page](https://api.slack.com/apps); for a non-interactive run, expose
it only to this command as `SLACK_CONFIG_TOKEN`.

Slack keeps the public identity on the app, while Buzz keeps it on the agent's Nostr
profile. Run both registration commands when one agent serves both surfaces; both read the
same files, so later edits stay deliberate and reproducible:

```bash
sageox-agent identity register buzz
sageox-agent identity register slack --app-id A0123
```

The Slack configuration token is a setup credential, separate from the `xoxb-` bot token
and `xapp-` Socket Mode token `surface slack` collected above. Slack documents
configuration tokens and icon updates in its
[token guide](https://docs.slack.dev/authentication/tokens/) and
[`apps.icon.set`](https://docs.slack.dev/reference/methods/apps.icon.set/) reference.

### Let one surface post to another

With Buzz and Slack on the same agent, the gateway can publish a new top-level message to
either surface. The destination must be in that surface's `channels` list; platform
membership alone is not authority to post. The egress guard then applies unchanged, so a
public destination is refused unless that surface lists it `reply: public` — a cross-post
gets exactly the reach a reply already had, never more.

When `surface buzz` or `surface slack` adds the agent's second networked surface, the CLI
enables the cross-post MCP tool by default. It updates only the tool allowlist; all existing
agent data and configuration stay in place.

Two surfaces is the *default*, not the requirement. The tool posts into any channel the
agent has configured, so it is servable on one surface too — which is the only way a job
reaches a channel on its own initiative, since a job has no inbound turn to answer and so
no reply to carry it. It is not granted automatically there: a single-surface agent's
top-level post tool is a deliberate choice, not a side effect of adding a surface.

For an agent on one surface, or one that already had both before this feature was
installed, enable or repair the same permission through the generic MCP setup:

```bash
sageox-agent mcp add surface-egress --agent harry
```

This uses the same interactive MCP setup as every other tool server: it shows the tools,
asks which authority to grant, and updates the tool policy. Because `surface-egress` is
gateway-built-in, it needs no subprocess, credential, or `mcpServers` manifest entry. The
command keeps the existing manifest, surfaces, credentials, persona, memory, state, and
tool rules; it adds only this server's tools to `permissions.allow` (and a `tools` pointer
when an older manifest does not have one). The server offers two, allowlisted separately —
the cross-post tool below, and the reaction tool described after it.

The resulting policy entry is:

```json
{
  "permissions": {
    "allow": [
      "mcp__surface-egress__post_message"
    ]
  }
}
```

You can also add that entry by hand. Keep the existing allow and deny entries. Restart
the agent, then either direction works:

```text
Slack: @harry post "the deploy is complete" to Buzz channel hive
Buzz:  @harry post "incident resolved" to Slack channel G0456
```

Naming a Buzz channel by its display name works when `surface buzz` recorded one — the
tool advertises its destinations as `buzz:<id> (hive)`, and a name resolves to the ID
behind it. The ID is what the guard checks and what the audit log records either way, and
a name shared by two channels on one surface resolves to neither: picking one of them is
not a guess worth making on your behalf.

The requested message is posted top-level in the destination, and the agent's ordinary
response confirms the result back in the conversation where the request originated.
Unknown channels, unconsented public channels, and Slack bulk mentions are refused. Slack
mention markup written into the text is neither refused nor honoured: it renders as the
characters the agent typed, so a cross-post notifies nobody it names.
Cross-posts never reuse an unrelated message as a fake thread parent.

### Let the agent react with an emoji

The gateway already puts `ack.emoji` on every message it picks up and takes it back when
the reply lands. That is the operator's one glyph for every turn, and it says only that
the agent is working. A message that asks the agent to *signal* something — a check-in
asking for one emoji if all is well and another if it is not — needs the agent to choose,
and that is a separate tool:

```json
{
  "permissions": {
    "allow": [
      "mcp__surface-egress__react"
    ]
  }
}
```

Add it by hand, or through the same interactive setup:

```bash
sageox-agent mcp add surface-egress --agent harry
```

The reaction tool takes one argument, the emoji. It always marks **the message the agent
is currently answering**: the gateway tells the tool which message that is, so there is no
message id for the agent to name and none for it to get wrong. It is not a reply and never
replaces one — the agent still answers in its normal response, which is what anything
reading the conversation actually sees.

It needs no second surface, so a single-surface agent can hold it. It is refused in a
channel the egress guard would not let the agent speak in, exactly as the acknowledgement
is, and it is refused rather than guessed at when two conversations are mid-turn at once.

The emoji goes through the guard as text, so a reaction on the way somewhere public is
scanned against `guard.leakPatterns` exactly as a reply is. That is not a statement about
emoji: the agent chooses this value during a turn that has read whatever a channel said to
it, so it is caller-controlled text leaving the agent, and it gets the reach a reply gets
and no more.

Which emoji, and what it means, is between whoever asked and the agent — nothing here
carries a vocabulary. On Buzz the character is published as-is. Slack names emoji instead
of carrying them, so it takes either spelling — `:tada:`, `tada`, or one of the few
characters the adapter knows a name for — and refuses a character it cannot name rather
than letting Slack reject it with `invalid_name`.

---

[← Make it run](run-an-agent.md) · [Give it memory and tools →](memory-and-tools.md)
