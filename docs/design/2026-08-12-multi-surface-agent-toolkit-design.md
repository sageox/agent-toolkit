# Multi-Surface AI Agent Toolkit — Design

- **Status:** Proposed (design; awaiting review before implementation planning)
- **Date:** 2026-08-12
- **Author:** Madhur Shrimal

---

## 1. What this is

An **opinionated, scaffolding-CLI toolkit** for standing up safe, hosted AI
coworkers (chat agents) **quickly**, and running a single agent **live across
multiple chat surfaces at once** — Buzz (Nostr), Slack, Discord, and a local
console — from one process and one identity.

It is a clean-room generalization of the patterns proven by the SageOx internal
"Buzz fleet", extracted so any team can adopt them. It carries over the
crown-jewel ideas — a tool-policy the LLM can't widen, an egress guard the LLM
can't argue with, a read-only chat face paired with a write-capable
deterministic worker — and **deliberately improves on the fleet where a better
2026 pattern exists** (secret handling, remote signing, local-first DX).

### Goals

1. **Time-to-first-agent is the product.** Talking to a real agent in ~60s with
   only an Anthropic key.
2. **One agent, many surfaces, live.** Fan-in from N surfaces to one brain;
   reply out the origin surface.
3. **Safe by construction.** The brain never holds transport credentials and can
   only emit through a single guarded egress chokepoint.
4. **Opinionated but progressive.** A simple default for every axis, a hardened
   opt-in that never requires rewriting the agent definition.
5. **Adoptable.** One hackable language (TypeScript), published to npm, no
   proprietary dependencies.

### Non-goals (v1)

- Not a transport *framework with one real adapter* — three real surfaces ship.
- Not a brain-abstraction layer — the brain is **Claude via ACP**, opinionated.
- Not a bespoke per-surface bot SDK replacement — we *wrap* each surface's best
  client (the Rust `buzz` CLI for Buzz; official JS SDKs for Slack/Discord).
- Not the SageOx `ox` tool — `ox` is one optional context provider, shelled out
  to if present.

---

## 2. Locked decisions

| Axis | Decision |
|---|---|
| Distribution | Scaffolding CLI (`create-<kit>` + `<kit>` commands) |
| Transport | **Abstracted**, multi-surface **live** (one process, N surfaces) |
| Core isolation | **Approach 2** — brain holds no transport creds; sends only via a guarded gateway egress |
| Language | **TypeScript** for all toolkit code |
| Buzz adapter | **Native TS Nostr client** (nostr-tools) for the runtime path: relay WSS + NIP-42 + mention `REQ` + `since` backfill, both directions incl. NIP-34 (the CLI is send/query-only, §5). The `buzz` CLI stays as an **optional bring-up/admin helper only**, never in the reply hot path (§17.1). Slack/Discord use JS SDKs |
| Brain | **Claude via ACP**; the gateway **replaces `buzz-acp`** (reimplements its relay/NIP-42/mention-subscription in TS) |
| Concurrency | **serialize per channel**; bounded concurrency across channels/surfaces; **per-author rate limit** (§6) |
| Config | **declarative manifest (YAML/JSON), schema-validated — parsed as data, never evaluated.** Command-bearing fields (`mcpServers[].command`, `brains[].command`) still name processes the runtime spawns, so a bundle is code-equivalent and gets a code-level review; `defineAgent` is an *optional* build-time TS emitter (§4) |
| Scope | **single agent per deployment** (v1); multi-agent fleet + roll-call deferred |
| Loop B | A **Job SDK** with a business-logic SPI (`collect`/`decide`); harness owns the safety pipeline |
| Context | Pluggable `ContextProvider`; ship `none`, `local-files`, and an optional shell-out `ox` |
| Secrets (k8s) | **ESO default**, CSI hardened opt-in |
| Nostr identity | nsec-mount default, **NIP-46 remote signer** hardened opt-in |
| MCP | brain is an MCP client; **a broker/proxy in the gateway zone holds the auth** — stdio secrets injected into the server subprocess, remote OAuth tokens held by a local proxy; the brain gets tools, never tokens |
| Deploy | local console → compose → k8s (Helm); local-first via outbound websockets |
| Repo | **Separate OSS repo**, pnpm/TS workspace, npm-published |
| License | Apache-2.0 (proposed) |
| Name | **`buzz-agent-toolkit`** (interim — outgrows "Buzz" once Slack/Discord land; transport-neutral rename later) |
| Isolation | brain = ACP subprocess, **same container, env-scoped** (v1 simple); separate-container + socket later (§6.3) |

---

## 3. Architecture

### 3.1 Two loops, one shared core

```
                 ┌─────────────── SHARED PRIMITIVES ───────────────┐
                 │ Egress Guard contract · surface-egress (usable   │
                 │ outside a live turn) · credential-scope model ·  │
                 │ kill switch · cross-surface loop termination ·   │
                 │ leak scrub                                       │
                 └───────────────┬───────────────┬─────────────────┘
                                 │               │
                    Loop A: live gateway    Loop B: job harness
                    (chat face, read-only)  (scheduled, write-capable;
                                             business logic = user's)
```

Both loops publish through the **same** guarded egress path. The shared
primitives are designed with both consumers in view so the egress/guard/
credential model is not Loop-A-shaped.

### 3.2 Loop A — the live gateway (data flow)

```
Slack   ─┐  adapter.inbound → normalize
Buzz    ─┼─▶  InboundEvent ─▶ Gateway ──[author gate + loop guard]──▶ ACP session (Claude)
Discord ─┤                       ▲                                        │
Console ─┘                       │              turn emits reply / requests a send
                                 │                                        ▼
                           origin surface ◀── adapter.send ◀── Guarded Egress
                                                              [policy contract + leak scrub]
```

The **brain never touches a transport.** It receives a normalized turn over ACP
and produces output; the **gateway** is the only component that sends, routing
the reply back out the *origin* surface through the single guarded egress.

The "leak scrub" in these diagrams was designed, deleted for being unenforced,
and later built on the narrower terms the guard contract table below records.

### 3.3 Why Approach 2 (enforced egress boundary)

The fleet's guard works by wrapping the concrete `buzz` binary at the OS level
because the LLM *itself* shells out to send. Generalizing to N surfaces, we do
better: **the brain has no send capability and no transport credentials at all.**
It may only *request* a send via a narrow gateway API, which validates against
the guard contract before any adapter touches the wire. This is a stronger,
cleaner boundary than a per-binary shim, and it is identical for every surface.

Rejected: **Approach 1** (in-process policy-object guard, all creds in one env —
throws away the containment that differentiates this toolkit) and **Approach 3**
(per-adapter sidecars — strongest isolation but real ops overhead; kept as a
future "hardened" deploy profile, not v1).

---

## 4. The agent spec (`defineAgent`)

One typed config file the CLI stamps and the runtime loads. Everything
downstream is derived from or validated against it.

```ts
export default defineAgent({
  name: "inkslinger",
  persona: "./AGENTS.md",                       // steering + canonical reply-shape
  brain: { provider: "claude-acp", model: "claude-opus-4-8" },

  surfaces: [                                    // live multiplex — all at once
    buzz({ channels: ["#hive", "#eng"], identity: secretRef("BUZZ_NSEC") }),
    slack({ channels: ["C0123"],        identity: secretRef("SLACK_BOT_TOKEN") }),
  ],
  respondTo: "allowlist",                        // owner-only | allowlist | anyone | nobody

  tools:   "./settings.json",                    // Claude Code tool policy (portable)
  context: ox({ repo: "you/repo" }),             // or none() / localFiles({...})

  guard: {                                       // shared egress contract
    noPublicChannels: true, noFileAttach: true, noBroadcast: true,
    channelAllowlist: "fromSurfaces",
    leakPatterns: [{ name: "internal-hostname", regex: "\\bhost\\.internal\\b" }],  // public destinations only (§7.1)
  },

  mcp: [                                          // brain tools; auth held OUTSIDE the brain (§7.5)
    stdioMcp({ name: "github",                    // secret injected into the SERVER, not the brain
               command: "npx -y @modelcontextprotocol/server-github",
               secrets: { GITHUB_TOKEN: secretRef("MCP_GITHUB_TOKEN") } }),
    remoteMcp({ name: "linear", url: "https://mcp.linear.app/sse",
                auth: oauth({ login: "cli" }) }), // token minted by `<kit> mcp login linear`
  ],

  schedules: [                                    // light cron — a scheduled brain TURN (§10.1)
    schedule({ name: "standup", cron: "0 9 * * 1-5", to: "#eng",
               prompt: "Post the overnight summary for #eng." }),
  ],
  jobs: [                                         // heavy cron — Loop B batch (write-capable)
    job({ name: "audit", schedule: "0 */6 * * *", module: "./jobs/audit.ts" }),
  ],
});
```

**The runtime consumes a static, declarative, schema-validated manifest
(YAML/JSON) — it NEVER imports or executes config code.** This closes an RCE
vector a security review flagged: an executable config imported by the gateway
runs arbitrary code *in the credential zone, before the guard exists* — a forked
template or a compromised transitive dep would be direct compromise. The `.ts`
example above is the **optional build-time emitter** (`defineAgent` → validated
manifest) for teams who want type-safety and `secretRef()` helpers while
authoring; its output, not the code, is what the runtime loads. Authoring in
plain YAML is fully supported and needs no build step.

### 4.1 Persona & steering (`AGENTS.md` + reply-shape)

`persona` points at the agent's steering — mission, boundaries, voice. The
toolkit ships an **opinionated but optional** persona scaffold (a team can ignore
it and write a bare prompt):

- **A canonical reply-shape template** — VERDICT → FACTS → RECEIPTS → NEXT — the
  agent *fills*, so answers stay scannable. A template to fill beats an adjective
  to obey (the fleet learned this: "be concise" lost to persona; a fixed shape
  held).
- **Voice lives in chat; artifacts stay plain.** PRs, commits, and issues are
  professional English even when the channel voice is playful — and a test
  asserts the split.
- **The persona file expresses identity ONLY, never policy.** It is deliberately
  separate from the guard/tools config so a persona edit can't loosen a safety
  rule. `init` stamps a starter `AGENTS.md`.
- **Fleet-wide runtime steering (degraded-mode disclosure, kill-switch status,
  loop-termination acks) is injected at runtime, not written into the persona
  file** — a fleet-wide behavior maintained per-agent is one with a hole in it.

The avatar/character system (`avatar.svg` + a style-independent character brief)
is a post-v1 nicety, not core.

---

## 5. Adapter SPI

Each transport implements one interface; the gateway knows nothing surface-
specific. Adapters **declare their escalation vectors** so the generic guard can
enforce a surface-appropriate check.

```ts
interface SurfaceAdapter {
  readonly kind: "buzz" | "slack" | "discord" | "console" | string;
  readonly capabilities: {
    hasPublicChannels: boolean;   // Slack public, Discord @everyone, Buzz --broadcast
    hasFileUpload: boolean;
    hasMentions: boolean;
    bulkMention: string | null;   // "@channel" | "@everyone" | "--broadcast" | null
    threads: boolean;             // Buzz/Slack/Discord: yes; console: no
    edit: boolean; delete: boolean;   // Buzz + Slack + Discord support both
    reactions: boolean;
    sendDiff: boolean;            // Buzz `messages send-diff` (NIP-34); others: no
  };
  identity(): Promise<Identity>;             // resolves a Signer/Sender (see §7)
  subscribe(onEvent: (e: InboundEvent) => void): Promise<Subscription>;

  // EVERY outbound action is an egress action and passes through the guard —
  // edit/delete are not exempt (an edit can leak or escalate as easily as a send).
  send(msg: GuardedMessage): Promise<SendResult>;
  reply?(inReplyTo: EventRef, msg: GuardedMessage): Promise<SendResult>;   // threading
  edit?(target: EventRef, msg: GuardedMessage): Promise<SendResult>;
  delete?(target: EventRef): Promise<void>;
  react?(target: EventRef, emoji: string): Promise<void>;                  // no --emoji-url
}
```

`Identity` carries **owner attribution**, mirroring Buzz's dual-signature model:

```ts
interface Identity {
  signer: Signer;                 // agent's own key or NIP-46 connection (§7.4)
  owner?: OwnerAttestation;       // Buzz: BUZZ_AUTH_TAG / second signature tying the
                                  // agent to an accountable human. A cross-surface
                                  // audit field even where the surface can't sign it.
}
```

- **Buzz adapter — a native TS Nostr client (nostr-tools), NOT a CLI wrapper.**
  The upstream `buzz` CLI is **send/query-only**; live inbound is `buzz-acp`
  holding the relay websocket (verified: no `subscribe`/`watch`/`stream` verb
  exists; the fleet's `entrypoint.sh` ends `exec buzz-acp`). So the adapter is the
  largest single component — it reimplements what `buzz-acp` does: relay WSS +
  **NIP-42** challenge/response auth + a **mention-filter `REQ`** subscription
  (inbound) and **signed-event publish** for send/reply/edit/delete/react and
  **NIP-34** diffs (outbound). Signing is the shared `Signer` (file nsec or NIP-46,
  §7.4); it emits the **owner second-signature** (`BUZZ_AUTH_TAG`) for chain of
  custody. Dropping the CLI also drops the Rust binary, the subprocess, and the
  guard-shim — the egress guard now lives in our TS layer for every surface alike.
- **Slack/Discord/Console** are pure TS (Slack Socket Mode, Discord gateway,
  stdin/stdout or localhost web). They carry `owner` as recorded audit metadata,
  and — because the surface can't cryptographically sign it — the gateway treats
  their `author`/`isAgent`/`owner` fields as **untrusted, adapter-asserted** (§7.8).
- Adding Discord is the proof the SPI holds without core changes.

**Subscribe by CHANNEL, not by mention** (learned against a live relay, 2026-08-13). The
Buzz relay answers a mention filter (`#p`) on `REQ` and then **never streams to it**, so
an agent subscribed that way appears to work — it replays everything on restart — and
silently ignores every live message. A channel filter (`#h`) streams normally. The adapter
therefore subscribes to the channels it serves and evaluates `mentionsMe` locally, which
is where the §8 wake rule belongs anyway.

**`subscribe()` is a durable, self-healing contract, not fire-and-forget.** It
owns reconnect, and on every (re)connect it **backfills** with the surface's own
replay so a restart/drop doesn't silently lose mentions: Nostr re-issues a `REQ`
with a `since` cursor, Discord resumes with its session-id + sequence, and Slack
Socket Mode — which does **not** replay — is backfilled by a `conversations.history`
pull since the last-seen ts. It also exposes **liveness** (last-event / last-pong)
so a silently-dead socket is detectable (§6).

### 5.1 The normalized event model

The one cross-surface data contract. Every adapter maps its native events to and
from these; **the gateway and brain never see a surface-native shape.**

```ts
interface InboundEvent {
  id: EventRef;            // opaque, surface-qualified: { surface, nativeId }
  surface: string;         // "buzz" | "slack" | "discord" | "console"
  channel: ChannelRef;     // normalized id + isPublic (drives the guard)
  author: ActorRef;        // normalized id + isAgent + owner?
  text: string;            // plain text; surface markup normalized away
  mentionsMe: boolean;     // the ONLY wake trigger (§8)
  threadRoot?: EventRef;   // threading
  ts: string;              // ISO-8601
  raw: unknown;            // escape hatch — core logic NEVER reads it
}

interface GuardedMessage {
  text: string;
  threadRoot?: EventRef;
  // attachments / urls / bulk-mentions only if capability AND policy allow (§7.1)
}
```

- `EventRef` / `ChannelRef` / `ActorRef` are **opaque and surface-qualified**, so a
  Slack id can't be confused with a Buzz one and reply/edit/delete always route to
  the origin surface.
- `author.isAgent` + identity is how cross-surface loop detection (§8) recognizes
  another agent regardless of which surface a message arrived on.
- `raw` exists as an escape hatch but **core logic never consults it** — that's
  what keeps the gateway genuinely surface-agnostic.

---

## 6. Gateway runtime

- **Fan-in:** every adapter's `subscribe` feeds normalized `InboundEvent`s into
  one queue.
- **Author gate:** `respondTo` (owner-only | allowlist | anyone | nobody),
  fail-closed on misconfiguration (mirrors the fleet's `entrypoint.sh` asserts).
- **Loop guard:** cross-surface termination enforced *before* a turn starts
  (§8) — the gateway, not steering, is the backstop.
- **Concurrency — serialize per channel, bounded across channels/surfaces.** A
  channel processes one turn at a time (ordered; a reply lands before the next
  turn in that channel starts), but different channels/surfaces run in parallel up
  to a small worker cap. This avoids both failure modes: global serialization
  would let one slow Slack turn head-of-line-block a Buzz mention; unbounded
  concurrency would race ACP sessions and interleave egress. The per-channel queue
  is bounded; overflow sheds oldest with a logged count, never silently.
- **Brain session:** one ACP session per turn; the brain gets the event + its
  policy-scoped tools (surface actions and MCP tools, §7.5); it cannot reach a
  transport or hold a credential.
- **Egress:** reply routed to the origin surface through the guard (§7).
- **Rate & spend limits (not just a global cap):** per-author and per-channel
  turn-rate limits, a max-concurrent-turns cap, a per-turn cost ceiling, and a
  per-thread turn cap. The shared Anthropic cap is the *last* backstop, not the
  only one — tripping it deafens every legitimate user, so it must never be the
  first thing an abuser hits (esp. under `respondTo: anyone`). Counters are
  per-author so one abuser can be throttled without an outage.
- **Loop A kill switch.** The *live* chat agent — not just Loop B — has a switch
  a human can flip to stop it mid-misbehavior (a looping or spamming agent needs a
  brake). It obeys the control-plane rules in §7.8: flippable only by an addressed
  DM/owner action, **never** by anything read in a channel, and ON is human-only.
- **Runtime liveness:** each `subscribe()` reports last-event/last-pong; a socket
  that goes silent past a threshold is treated as **down** — reconnect + backfill
  (§5), and the state is surfaced (a health endpoint + a status post) so a
  single-surface silent death is *detected*, not invisible (the fleet's
  roll-call lesson, without needing a second agent to watch).
- **Degraded mode:** a context-provider failure **or a down transport** degrades
  (start/continue, announce once, inject steering that forces disclosure), never
  kills — generalized from the fleet's `buzz-degraded-mode` rule.

### 6.1 The turn model — an intra-turn agentic loop

A turn is **not** "brain emits one reply and stops." It is an **ACP session** in
which the brain runs an agentic loop, and **every step round-trips through the
gateway** — the gateway is the ACP client/host, the brain is the ACP agent.

```
inbound event ─▶ gateway opens ACP session ─▶ brain
   ┌──────────────── within ONE turn (many round-trips) ────────────────┐
   │ brain: "call tool X"     → gateway: policy check → run → result ──▶ │
   │ brain: "query context"   → gateway: ContextProvider → chunks   ──▶ │
   │ brain: "post reply text" → gateway: GUARD → allow → adapter.send ─▶ (to surface)
   │ brain: "attach a file"   → gateway: GUARD → BLOCK → refusal    ──▶ │ brain reads it, adapts
   │ … keeps looping until the brain ends the turn                      │
   └────────────────────────────────────────────────────────────────────┘
turn ends ─▶ session closes ─▶ next queued turn for that channel
```

- **Intent is not a single final blob.** Across one turn the brain may emit
  interim messages, reactions, tool calls, MCP calls, context queries, **and** a
  final reply — each outward step is a *separate* guarded action.
- **The guard is a feedback loop, not a wall.** A blocked action returns a
  **refusal the brain reads** (e.g. "file attachment disabled — reply with text")
  and adapts to *within the same turn* — `request → guard → (allow → done | block
  → reason back to brain) → continue`. The brain never touches a transport
  directly at any step; it only ever *asks*, and the gateway decides.
- **Bounded.** The loop is capped by the per-turn duration ceiling, the per-turn
  cost ceiling, and the tool/rate limits (§6). Within a channel, turns are
  serialized — a turn's whole loop completes before the next turn in that channel
  starts — while other channels/surfaces run in parallel.
- **Across turns** (a follow-up reply or new `@mention`) is a *new* session; turns
  are otherwise stateless, and continuity comes from the surface's thread history
  + the context provider re-reading it.

### 6.2 Observability & the signed audit trail

- **Structured, single-line `key=value` logs**, carrying the fleet's logging
  doctrine: log success *and* failure (a run that did nothing is distinguishable
  from one that never ran), before/after counts on every filter/dedup/scrub, a
  reason on every early return, entity ids on every line. Written for an AI
  triaging at 3am.
- **Every turn emits an audit record** — inbound event id, author, surface, tools
  and MCP servers called, egress actions attempted, **guard verdicts (allowed /
  blocked + which rule)**, and spend. On Buzz this rides the native signed event
  log (dual-signature, §5); on Slack/Discord it lands in the toolkit's own
  **tamper-evident** sink — hash-chained append-only (each record commits the
  prior record's hash) so a gateway compromise that rewrites history is
  *detectable* even though the same process writes it. Best-effort shipping to an
  external sink is offered as the stronger option.
- **Never log secrets or untrusted content verbatim** — ids and counts only,
  never alert/log/channel text (attacker-reachable by design; carried over from
  the fleet).
- Per-surface + per-agent spend/rate counters are exported for a dashboard; the
  Anthropic spend cap is the runaway backstop.

### 6.3 Process & isolation model

**The gateway is one long-lived process** (the ACP *client*) that owns the
transport connections, the guard, the credentials, and the per-turn loop. **The
brain is `claude-agent-acp` (the ACP *agent*)**, driven over **ACP** — JSON-RPC
2.0 over a stream. The gateway opens a `session/prompt` per inbound event and
serves the brain's tool/permission requests until the turn ends (§6.1).

**v1 isolation — the simple tier (chosen):** the brain runs as a **subprocess of
the gateway, in the same container**, ACP over **stdio**. The two zones are kept
apart by **env-scoping** (surface/write credentials are never placed in the brain
subprocess's environment), the tool policy's secret-path `Read()` denies, and the
fact that the brain reaches every credentialed action only through a
gateway-mediated tool. This is the fleet's proven model and needs no socket
wiring — the fastest path to a working system.

**Be honest about what this tier buys:** isolation is **process-level, not
container-hard**. The subprocess shares the gateway's filesystem, so a credential
file mounted for the gateway is reachable at the OS level by a
sufficiently-compromised brain process; the protection is env-scoping + policy
denies + mediated tools — strong in practice, but not a kernel boundary. The
"structurally cannot reach a write credential" guarantee (§7.2) is fully literal
only under the hardened tier below.

**Hardened tier (later, no redesign):** move the brain into its **own container**
with only its `ANTHROPIC_API_KEY` mounted, and run ACP over a **local socket** (a
unix-domain socket on a shared `emptyDir`, or localhost) instead of stdio. Surface
creds then live in a container the brain cannot read, and the guarantee becomes
literal. Because ACP is transport-agnostic, this is a *deployment* change, not an
architecture change — the gateway↔brain contract is byte-identical. Same
simple-default / hardened-opt-in shape as secrets (ESO→CSI) and signing
(nsec→NIP-46).

---

## 7. Guard contract & the two-trust-zone secret model *(safety-critical)*

### 7.1 Guard contract

A declarative policy enforced at the single egress chokepoint, **generic
contract + per-adapter enforcement**:

| Contract field | Buzz | Slack | Discord | GitHub |
|---|---|---|---|---|
| `noBroadcast` / `noPublicChannels` | `--broadcast`, public channel | public channel, `@channel`/`@here` | `@everyone`/`@here`, public channel | — (`repos` allowlist + armed writes) |
| `noFileAttach` | `--file`/`--attach` | `files.upload` | attachments | — |
| `channelAllowlist` | channel UUID | channel ID | channel ID | — |
| `noArbitraryUrls` | `--emoji-url` | unfurl/attachment URLs | embed URLs | — |
| `leakPatterns` | outbound text scan, public destinations only | same | same | every string a write tool sends, public repositories only |

Every rule fails **closed**. The brain cannot bypass it because it cannot send
except through it.

> **`leakPatterns` was deleted once, and came back narrower.** As designed here it
> was defence in depth that never ran: the schema accepted it, nothing enforced
> it, and nobody noticed for the life of the repo, so `1e442f8` deleted it rather
> than finishing it. Finishing it then meant accepting operator-authored regular
> expressions on *every* outbound message — a backtracking stall away from taking
> a single-threaded gateway down — to buy back something nothing was using.
>
> Two things changed. Agents now run unattended jobs and hold a GitHub write
> surface, so an agent that publishes an internal hostname or a decision record
> number is a thing that happens rather than a hypothesis — and the same shift made
> `guard.publicChannels` necessary, which is a granted public destination for every
> word the agent says. And the rule that came back is not the one that was deleted:
>
> - **Public destinations only.** A private reply is still never read. The scan
>   runs where `noPublicChannels` made someone grant a destination one at a time,
>   which is a narrow path by construction rather than every send.
> - **A quantifier may not apply to a group.** `(…)+`, `(?:…)*` and `(…){2,}` are
>   refused when the manifest loads. Catastrophic backtracking needs a repetition
>   nested inside a repetition; with nowhere to nest one, the stall the deletion
>   was about cannot be written. A quantified character class — which is what a
>   hostname, an id, or a key shape is actually made of — is untouched.
> - **Named hits, never quoted ones.** A refusal says `internal-hostname, bead-id`
>   and stops. It is replayed to the brain and written to the log, and quoting the
>   text that matched would put the leak in both.
>
> What it is not: the credential defence. The reason the brain cannot leak the
> gateway's credentials is still that it never holds them, and this rule is about
> *knowledge* the brain legitimately holds and must not publish.
>
> **It reaches the GitHub write path too**, on the same terms. `pr_create`,
> `issue_create` and `issue_add_label` are scanned across every string they send —
> titles, bodies, branch names, label names — before the request is built, as a
> fourth gate after armed → allowlisted → bounded. That needed a notion of which
> repositories are public, which the manifest does not have and deliberately still
> does not: a `public:` flag beside `repos` fails **open** when an operator marks a
> public repository private, on the control's only case, with nothing to say so.
> The runtime asks GitHub instead (`GET /repos/{owner}/{name}` → `private`), which
> is the rule `surface slack` already holds for channel privacy — the authority
> answers, the assertion does not. Unavailable means refused. The question is asked
> only once a pattern has already fired, which is what keeps a per-call answer
> affordable: both orders give the same verdict, so the clean path makes no extra
> request.
>
> Still out of reach: **a job body that shells out to `gh`**. The job host sees an
> exit code and a verdict file, not the work, so nothing in this runtime can scan
> it — a control claimed there would be a control with no enforcement, which is what
> `1e442f8` deleted.

### 7.2 Two trust zones → two secret sets

| Zone | Runs | Holds | Never holds |
|---|---|---|---|
| **Gateway** (trusted) | adapters, guard, egress | surface identities, context creds | — |
| **Brain** (LLM over untrusted text) | claude-agent-acp | only its spend-capped `ANTHROPIC_API_KEY` | any surface/write credential |
| **Job** (Loop B) | harness + user logic | **write-scoped** creds (e.g. GitHub PAT) | — |

Separate processes with separate credential access. A prompt-injected chat turn
cannot reach a write credential through any *authorized* path — it holds none and
can only request gateway-mediated tools. **How hard that boundary is depends on
the isolation tier (§6.3):** env-scoped subprocess (v1 — process-level, with a
residual same-filesystem OS read) up to separate containers (hardened —
kernel-level, where "cannot reach" is literal). **MCP auth belongs to the gateway
zone too** — an MCP broker/proxy holds stdio-server secrets and remote-MCP OAuth
tokens; the brain gets tools, never tokens (§7.5).

### 7.3 Secret injection (simple-default + hardened-opt-in)

`secretRef("NAME")` is a **logical reference** resolved **file-first,
env-fallback**; the deploy target binds it — the agent spec never changes.

- **Dev:** `.env` (fallback) or a compose bind mount (files under `/mnt/secrets-store`).
- **k8s default: External Secrets Operator** — backend-agnostic (40+ providers),
  syncs into a native k8s `Secret`. Easiest portable default.
- **k8s hardened: CSI Secrets Store** — secrets bypass etcd, mounted as files.
- **Real secrets are file-mounted, not env vars** (env leaks via `docker
  inspect`, `/proc/<pid>/environ`, crash dumps).

### 7.4 Signer/Sender seam & NIP-46

Identity resolves to a **Signer/Sender**, not necessarily a raw key:

- **Default (Nostr):** nsec file-mounted in the gateway zone.
- **Hardened (Nostr): NIP-46 remote signer ("bunker")** — the gateway holds a
  *revocable connection token*, signing happens in an isolated signer with
  per-connection event-kind restrictions (a second, signing-layer guard). A
  fully compromised gateway cannot exfiltrate the key.
- **Slack/Discord** have no remote-signer standard → scoped bot token + rotation
  guidance. The seam's asymmetry is honest: one real remote-signer impl now, not
  a framework awaiting plugins.

### 7.5 MCP tools & auth *(safety-critical)*

The brain speaks **MCP** (Claude Code is an MCP client), so an agent's tools can
be any MCP server. But MCP servers need credentials — which collides head-on with
"the brain holds no credentials." We resolve it exactly as we did transports:
**the brain invokes tools; a broker holds the auth; tokens never enter the brain
zone.** This is the 2026 enterprise **MCP gateway/proxy** pattern (Kong AI MCP
Proxy, Azure APIM + Entra, Operant), applied inside our gateway trust zone.

**Two credential classes:**

1. **stdio / local MCP servers** — the scoped secret is injected into the *MCP
   server subprocess* env, **never the brain's**. The server *is* a credential
   broker: the LLM calls its tools and never sees the token. Same discipline as a
   surface adapter.

   **Implementation correction (2026-08-13): the *gateway* must spawn that
   subprocess.** ACP's own `McpServerStdio` config carries `env` and is delivered to
   the **agent** in `session/new`, so configuring a server that way hands the token to
   the brain — the precise thing Approach 2 exists to prevent. Use ACP's
   **`McpServerAcp`** instead: it carries only `{name, serverId}`, and the client-side
   `mcp/connect` · `mcp/message` · `mcp/disconnect` methods let the gateway host the
   server and relay calls. **Never configure an MCP server as `McpServerStdio`.**
2. **Remote / HTTP MCP servers (OAuth 2.1)** — never let the brain hold the OAuth
   tokens. An **MCP proxy in the gateway zone** is the OAuth *client*, holds the
   access + refresh tokens, and re-exposes the remote server to the brain as a
   **local loopback MCP with no secret**. It enforces PKCE (S256), **RFC 8707
   Resource Indicators**, and the token-passthrough prohibition, so a token can't
   be replayed across servers, with local JWT validation (cached JWKS) on the hot
   path.

**The headless-auth problem** — an interactive OAuth consent needs a human +
browser, which a hosted agent can't do at runtime. Three tiers, simple→hardened,
honoring the human-time "one human step, then autonomous" rule:

- **Service token / API key** (simplest) — where the server issues a static
  scoped token, treat it as a stdio secret.
- **`<kit> mcp login <server>` (once, local, interactive)** — the *CLI* runs the
  OAuth 2.1 + PKCE authorization-code flow in a **human's** browser and stores the
  resulting **refresh token** in the secret backend (ESO / compose). The runtime's
  proxy silently mints access tokens (OAuth 2.1 rotation); the hosted agent never
  does interactive auth. This is the default remote path.
- **Enterprise-Managed Authorization (EMA / ID-JAG)** (hardened) — the agent's
  workload identity gets an Identity Assertion JWT from the org IdP and exchanges
  it for an MCP access token: fully non-interactive, **no stored refresh token**,
  the org IdP is the authority. The enterprise path; ties to workload identity.

**Governance — the lethal trifecta.** MCP tools ride the same tool-policy
allowlist as everything else (Claude Code supports per-MCP-tool permissions).
Because the brain reads untrusted channel text, a **side-effecting MCP tool is an
exfiltration/write vector** (untrusted input + private data + external reach). So
read-only MCP tools are the low-risk default; any write/side-effecting MCP tool
must be **explicitly allowlisted and routed through the same leak-scrub/guard
posture as egress**, or denied. The proxy caps per-tool scope so a compromised
server can't widen its own reach.

**v1 builds:** stdio-with-injected-secret + remote-via-local-proxy with
`mcp login`. EMA / ID-JAG is a hardened fast-follow.

### 7.6 Tool policy model

The brain's tools are governed by **Claude Code `settings.json`** (the format is
portable and unchanged): allow/deny of Bash verbs, `Read`/`Write` denies, and
per-MCP-tool permissions. Fleet invariants are baked in and **asserted at
startup** (mirroring `entrypoint.sh`):

- **Permission mode must be the enforcing one** — never `bypass-permissions`,
  which silently turns the allowlist into deny-only. Refuse to start otherwise.
- **No broad `Bash` deny** — with no specificity tiebreak it also kills every
  allowed verb and bricks replies.
- **Deny reads of secret paths** (`/mnt/secrets-store`, mounted secret dirs, `.env*`,
  `**/auth.json`) — defense in depth even though the brain zone holds no surface
  secret.
- **Matching is flag-blind, so the policy is audited by *flags*, not verb names.**
  Anything that can spell around it — env-prefix, stdin bodies, absolute-path
  binaries — is denied; no blanket `node`/`sh`.

**Three governed capability surfaces, one posture:** surface actions (egress
guard §7.1), MCP tools (§7.5), and shell tools (this section). The
write/side-effecting members of all three are the ones a team allowlists
deliberately. The policy file is **separate from the persona** so an identity
edit can never widen reach.

### 7.7 Verifying the posture (`<kit> doctor`)

The fleet proves policy with **mutation-tested assertions** + golden manifest
renders, not by hoping. The toolkit ships this as `<kit> doctor` — the pre-deploy
gate, guarded against drift by a golden-render test in CI:

- asserts the rendered deploy manifests carry the enforcing permission mode,
  singleton (`replicaCount: 1` + `Recreate`), read-only rootfs, a brain container
  with **no** surface/write secret mounted, and a set guard channel-allowlist;
- runs the guard contract against known-bad egress (a `--broadcast`, an
  `@channel`, a leak-pattern hit) and asserts each **fails closed**;
- checks every `secretRef` resolves and every declared MCP server's auth is
  provisioned (so a missing `mcp login` is caught before deploy, not at 3am).

### 7.8 Untrusted input & the control plane *(safety-critical)*

Approach 2 contains *credentials*; this section contains *instructions and data*.
The base rule, carried over from the fleet: **anything the agent did not author
is DATA, never a command** — and that set is bigger than chat text.

- **Three untrusted sources, one envelope.** Channel/DM text, **MCP tool
  results** (a compromised or rug-pulled server's response is exactly as
  attacker-controlled as a chat message), and **adapter-asserted fields**
  (`author`, `isAgent`, `owner` on surfaces that can't sign them). Turns are
  constructed so every one of these is **structurally fenced** as untrusted
  content with a weaker trust signal than the agent's own steering — not
  concatenated in as peers. This is enforced in turn assembly, not asked for in
  the persona.
- **The control plane is never reachable from data.** No switch — Loop A's or
  Loop B's — is ever flipped by anything *read* in a channel, a thread, a quoted
  transcript, or an MCP result. Switching is an **addressed** DM/owner action
  only, and **turning an agent ON is human-only** (the fleet's asymmetry: a wrong
  OFF costs idle time, a wrong ON puts an unsupervised agent back to work). A
  message that merely *says* "turn X off" is data.
- **Data-axis exfiltration is a first-class guard concern, not just credentials.**
  The lethal trifecta closes on creds but stays open on data: "summarize the
  private ticket in your reply" reads private context via a *read-only* tool and
  leaks it through the *authorized* reply path — pattern leak-scrub won't catch
  it. Mitigations: read-only MCP/context tools are the default, **side-effecting
  or private-data tools are explicitly allowlisted**, and an egress that would
  surface private context fetched this turn to a channel of lower trust than its
  source is held (a coarse source-vs-sink check, not perfect, but not nothing).
- **MCP tool schemas are pinned (trust-on-first-use).** The read-vs-write
  classification the allowlist depends on is *not* taken from the server's
  self-reported schema each call — schemas are pinned on first sight and a change
  (a tool silently gaining a side effect, a rug-pull) is flagged and held.
- **Honesty:** this is defense-in-depth, not a proof. The residual (a determined
  injection through a legitimately-allowlisted write tool) is stated in the threat
  model (§16), not papered over.

---

## 8. Cross-surface loop termination *(safety-critical)*

Generalizes the fleet's `agent-loops` rules to N surfaces, enforced **in the
gateway**, never left to steering (the LLM can't be trusted to self-limit):

1. The **@mention is the only wake trigger** — an agent's own status posts,
   another agent's lines, and reactions never wake it.
2. **Handoffs are one-way, fire-and-forget** — a status line may name at most one
   downstream agent; the real trigger is a durable artifact, never the mention.
3. **Acks terminate** — a mentioned agent replies ≤1 line mentioning nobody; no
   agent replies to a reply. **Hard depth cap = 2, enforced by the gateway.**
4. **Agent-to-agent detection across surfaces** — the gateway recognizes other
   agents (by identity) regardless of which surface a message arrived on, so a
   Slack→Buzz cross-surface chain is capped the same way. *On Buzz the identity
   comes from the relay's directory records (kind 10100), which every mentionable
   agent publishes; the toolkit still owns no roster.*

Every piece of new cross-agent wiring must state its termination proof.

**Addressed posts and links** (2026-09-02) are the one cross-surface path added
since, and their proof: a brain post may name one principal, only during the single
live turn, and at most once per turn — so one admitted message wakes at most one
principal. The addressed principal's replies under that post come home to the
asking thread as the agent's own message (`isSelf`, so never a wake) and are
consumed by the relay rather than admitted as turns, bounded to that root, that
principal, twenty lines, and an hour. Residual: an unaddressed post is still not
rate-limited on egress.

---

## 9. Context provider seam

```ts
interface ContextProvider {
  prime(): Promise<void>;                     // optional warm/index step
  query(q: string, ctx: TurnCtx): Promise<ContextChunk[]>;
  health(): Promise<"ok" | "degraded">;
}
```

- `none()` — zero team memory (the true quickstart default).
- `localFiles({ globs })` — a simple local-doc provider.
- `ox({ repos, auth, cache })` — thin adapter that shells to the `ox` binary **if
  present**; contributes no SageOx source to the OSS repo. Its failure triggers
  degraded mode, not a crash. See §9.1 for its config + deploy wiring.

### 9.1 Configuring `ox` and what it indexes (at deploy)

Everything is declared in **one place — the `ox()` provider in `defineAgent`**;
the deploy target binds the secret, the volume, and the prime step off it.

```ts
context: ox({
  repos: [
    { slug: "you/monorepo", index: true, ref: "main" },  // clone + `ox index code`
    { slug: "you/docs" },                                 // clone only (ledger/query, no code index)
  ],
  auth:  secretRef("OX_AUTH_JSON"),   // ox refresh-token creds — CONTEXT zone, never the brain
  cache: { persist: true },           // wire the checkout + ox data-dir volume
}),
```

| Concern | Configured in | Deploy target binds it to |
|---|---|---|
| Which repos / which to code-index / ref | `ox({ repos: [...] })` | the **prime/init step**: clone + `ox index code` |
| ox auth credential | `auth: secretRef(...)` | secret backend (`.env`/compose, ESO, CSI) → mounted into the **ox/context process, not the brain** |
| Index persistence | `cache: { persist: true }` | a **named volume** (compose) / **RWO PVC** (k8s, AZ-pinned for EBS) holding *both* the checkout and ox's data dir |
| Prime-before-live | implicit | init runs before the gateway subscribes; degraded-mode fallback on failure/timeout |

**The index is NOT inside the checkout.** `ox index code` writes to ox's data
dir (`$XDG_DATA_HOME/.../codedb`), a *separate* path from the git checkout.
Persist only the checkout and every deploy pays a **~7–11 min cold rebuild** —
the "deaf window" that caused two days of fleet outages. `cache.persist`
wires **both** paths onto one volume so restarts are incremental (seconds).

**How ox reaches the brain — two modes, both keep the credential out of the
brain zone:**

- **Default — ContextProvider pre-fetch.** The gateway calls `ox query`/`ox
  glance` and injects results into the turn. Simplest; credential fully outside
  the brain; no ad-hoc mid-turn querying.
- **Opt-in — ox-as-local-MCP-server.** Wrap the `ox` binary as a stdio MCP server
  (the §7.5 broker model); the brain calls `ox_*` tools on-demand with the ox
  secret injected into the *ox MCP subprocess*, not the brain. Agentic querying,
  still zero credential in the brain zone.

---

## 10. Loop B — the Job SDK

> **Partly superseded** by [the jobs RFC](2026-08-19-jobs-rfc.md). The
> `defineJob({collect, decide})` seam below is withdrawn — measured against real
> job bodies it does not fit, and a `run: {command, args}` process seam replaces
> it (RFC §11). What the harness owns, §10.1's two tiers, and unforgeable
> trigger provenance all survive.

The user writes domain logic at defined seams; the harness owns everything
dangerous and identical-across-agents.

```ts
// user writes:
export default defineJob({
  collect: async (ctx) => Signal[],           // your Honeycomb/GitHub/etc.
  decide:  async (signals, ctx) => Action[],  // your dedup/judgment
});

// harness owns (never the user's to reimplement):
//   kill-switch-read-first · no-theater gate · optional LLM judge seam ·
//   leak-scrub · credential-scoped publish · report-to-surface ·
//   scheduled-vs-on-request provenance · CronJob/local-cron wiring
```

- Runs as a **separate** process/pod with the **write-scoped** credential the
  live chat brain never holds.
- **Kill switch read first** (fail-open soft switch + hard suspend), matching the
  fleet's `cron-agent-kill-switch` invariant.
- **On-request vs scheduled** is an unforgeable provenance fact stamped by the
  run trigger, not an argv knob.
- **Publish target is pluggable.** Default is GitHub (scoped PAT). Because Buzz
  is a git forge, an `Action` may instead publish as a **NIP-34 git event**
  (patch / review) on Buzz itself — a Buzz-native agent can open and review PRs
  without a GitHub credential at all. The `collect`/`decide` SPI is unchanged;
  only the harness's publisher differs.

### 10.1 Two tiers of scheduled ("cron") work

A cron-based agent is fully supported — pick the tier by weight:

| | **Scheduled turn** (light) | **Job / Loop B** (heavy) |
|---|---|---|
| What | a **synthetic inbound event** (a clock tick) runs an ordinary guarded brain turn | a deterministic `collect → decide → publish` batch |
| Runs in | the **gateway process** (Loop A machinery) | a **separate pod** (its own zone) |
| Credentials | none (brain zone) | **write-scoped** |
| Good for | daily summary, reminder, "check X and post it" | file issues, open PRs, multi-step write work |
| Declared as | `schedules:` in the agent spec | `jobs:` in the agent spec |

The key idea: **a cron tick is just another inbound event.** It enters the
gateway as a synthetic `InboundEvent` (author = the internal clock), so it flows
through the exact same brain → guard → egress path — no new machinery. It
**skips the author gate** (there is no channel author) but is still subject to the
guard, the rate/turn caps, and the kill switch. Both tiers are
**kill-switch-first** (a scheduled run has nobody watching, so "off" must cost one
check and nothing else) and honor the fleet's **silence-is-the-message** rule (a
run that finds nothing posts nothing).

---

## 11. The quickstart ladder & local-first transports

| Rung | Command | External accounts | Goal |
|---|---|---|---|
| 0. Try | `npx <kit> try` | just `ANTHROPIC_API_KEY` (or `--brain mock`) | agent in your terminal, ~60s |
| 1. Scaffold | `<kit> init` | none | a `defineAgent` project you own |
| 2. Real surface, local | `<kit> run` | one surface token | live on a real surface, from a laptop |
| 3. Deploy | `<kit> deploy --compose` | + `.env` | one-command container |
| 4. k8s | `<kit> deploy --k8s` | + ESO backend | production |
| 5. Harden | flags only | CSI / NIP-46 | no key in runtime |

- **`console`/`local-web` is a first-class adapter, not a mock** — `try` runs the
  *real* gateway/guard/egress/brain/context; only the transport is local. What
  you try is the real *behavior*. **It is not the real *operations***, though: the
  console path has no singleton/RWO-volume/index-rebuild/deaf-window/reconnect, so
  `try` builds confidence about the agent's logic, not its deploy hazards (§9.1,
  §6). `doctor` (§7.7) + `deploy --compose` are where the ops surface is exercised.
- **Local-first via outbound websockets** — Slack **Socket Mode**, Discord
  **gateway**, Buzz **relay WSS**. No ingress, public URL, or webhook is ever
  required to receive events, even for a real surface on a laptop. Simplifies
  k8s (no Ingress/webhook routing).
- **`add-surface slack` is guided** — prints exact scopes/manifest + create-app
  link; you paste back one token (human-time "one script, one paste").

---

## 12. CLI surface

```
<kit> try            # rung 0 — console agent, only ANTHROPIC_API_KEY
<kit> init           # scaffold a defineAgent project
<kit> run            # run locally, all configured surfaces
<kit> add-surface    # guided Slack/Discord/Buzz app + token setup
<kit> deploy         # --compose | --k8s (renders manifests)
<kit> doctor         # verify config, secrets, connectivity, guard posture
```

---

## 13. Repo layout & distribution

Separate OSS repo **`buzz-agent-toolkit`** (interim name, §18), pnpm/TS workspace.
Packages publish under scope `@buzz-agent-toolkit/*` (shown as `@kit/*` below for
brevity); the `create-<kit>` front door is `create-buzz-agent`.

```
packages/
  core/            @kit/core         gateway, egress, guard contract, loop guard, ACP bridge
  job/             @kit/job          Loop B SDK + harness
  adapter-buzz/    @kit/adapter-buzz wraps upstream `buzz` CLI
  adapter-slack/   @kit/adapter-slack
  adapter-discord/ @kit/adapter-discord
  adapter-console/ @kit/adapter-console
  context-ox/      @kit/context-ox   optional shell-out
  cli/             @kit/cli
  create/          create-<kit>      npx entry (rung 0/1)
templates/         starter agent projects the CLI stamps
examples/          1–2 reference agents (a chat-only + a chat+job)
```

- Published to npm; `npx create-<kit>` is the front door.
- CI: unit tests per package; a golden-render test for `deploy` output (compose
  + k8s manifests) — the fleet's `check-rendered-charts` idea, generalized.
- No proprietary dependencies; `context-ox` shells to a binary it does not ship.

---

## 14. Deploy targets

- **compose** (default): gateway + brain + (optional) job services, file-mounted
  secrets, outbound-websocket surfaces — no ingress.
- **k8s**: the CLI renders a **minimal Helm chart** (two containers: gateway +
  brain; job as a `CronJob`), ESO for secrets by default. Kustomize overlays
  considered as an alternative to reduce templating; decision deferred to the
  deploy sub-spec.
- Approach 3 (per-adapter sidecars) is a future hardened profile, not v1.

---

## 15. Build order (v1 cut line)

1. **Shared core** — declarative-manifest loader + schema, Adapter SPI, gateway
   runtime (**serialize-per-channel concurrency, rate/turn caps, Loop A+B kill
   switch, runtime liveness**), guard contract + egress, **untrusted-input turn
   assembly** (§7.8), two-zone secret model (`.env`/compose + ESO), loop
   termination, `Signer` seam (nsec-mount impl), **MCP broker/proxy + per-tool
   policy governance + tool-pinning**, hash-chained audit.
2. **Loop A** — the **native Buzz Nostr client** (NIP-42 + mention `REQ` +
   `since` backfill + publish/NIP-34 — the largest single component) + Slack +
   Console adapters, each with the reconnect/backfill contract; Discord as SPI
   proof.
3. **CLI** — `try`, `init`, `run`, `add-surface` (Buzz bring-up via `buzz`
   CLI-assist), **`mcp login`**, `deploy --compose`, `doctor`.
4. **Loop B** — the Job SDK + local-cron + k8s `CronJob`.
5. **Deploy `--k8s`** — Helm render + ESO.
6. **Context** — `none`, `local-files`, optional `ox`.

**Fast-follow (post-v1):** CSI + NIP-46 hardened tiers, **MCP EMA / ID-JAG
enterprise auth**, Discord parity polish, Approach-3 sidecar profile, additional
context providers, the persona/avatar system, additional brains behind the ACP
seam.

---

## 16. Threat model & residual risks

**Adversaries:** (1) a malicious message author in a channel the agent reads
(prompt injection); (2) a compromised / rug-pulled MCP server or a vulnerable
transport-adapter dependency; (3) a supply-chain hit on the toolkit or a forked
config manifest.

**Trust zones and what a compromise of each yields:**

| Zone | Holds | Compromise yields |
|---|---|---|
| **Brain** | only its Anthropic key | confused-deputy within *authorized* reach only — bounded by the guard, the tool allowlist, and rate limits; **no credential theft** |
| **Gateway** (concentrated crown jewel) | all surface signers (unless NIP-46), all MCP broker auth, context creds; runs the guard | **every surface credential + every MCP token at once** |
| **Job** | write-scoped creds, separate process | write creds for its scope; the live brain never holds them |

**The headline residual, stated plainly:** Approach 2 **relocates and
concentrates** blast radius — it does not shrink it. A gateway RCE (an adapter
dep vuln, an MCP-proxy vuln, malicious `InboundEvent` parsing) exposes every
surface credential simultaneously. v1 mitigations: minimize dependencies, NIP-46
to keep the Nostr key out even of the gateway, hash-chained audit. The real fix
is **Approach 3 (per-adapter sidecars)** — a hardened profile, deliberately
deferred, and this is the trade-off being accepted, not an oversight.

**Dependency risk is concentrated, not uniform** (measured 2026-08-13, cumulative
npm tree): ACP client `2` packages → `+nostr-tools` `10` → `+@slack/bolt` **`120`**
→ `+discord.js` `144` → `+@modelcontextprotocol/sdk` `168`. Slack alone contributes
~110 of the 168 packages a full v1 gateway loads *into the credential zone*, while
core + Buzz is only 10. Two consequences: a **Buzz-only deployment has a genuinely
small attack surface** and should be documented as the lean profile; and **Approach 3
is dependency isolation as much as credential isolation** — sidecarring Slack first
buys the most risk reduction per unit of ops overhead. Adapter dep count is a review
metric, not a footnote.

**Named residuals accepted for v1 (honest gaps, fleet-style):**

- **Data-axis exfil through an allowlisted write tool** — §7.8 raises the bar
  (few scoped write tools + source/sink check + tool-pinning) but a determined
  injection through an *approved* side-effecting tool is not fully closed.
- **Owner attribution is cryptographic only on Buzz** — Slack/Discord `owner`
  and `isAgent` are unsigned adapter metadata, so attribution is forgeable and the
  cross-surface loop cap leans on unsigned fields on 2 of 3 surfaces; rate limits,
  not proof, are the backstop there.
- **Config is data, but a manifest is still a foot-gun** — the runtime executes
  no config code, yet a manifest naming a malicious MCP server or an over-broad
  allowlist is still dangerous; `doctor` warns, it does not forbid.
- **The startup deaf window is shortened, not eliminated** — backfill (§5)
  recovers most drops; a mention in the sub-second window before a surface's
  cursor is established can still be missed.

New cross-surface / cross-agent wiring states its own residual in the PR — the
fleet's termination-proof discipline, generalized.

---

## 17. Alignment with the current `block/buzz` release (0.4.21)

Buzz is Apache-2.0, `0.x`, and moving fast. What it ships now, and how we track it:

| Buzz feature | Our stance |
|---|---|
| **Dual-signature identity** (agent key + owner second signature, `BUZZ_AUTH_TAG`) | **Adopted** — `Identity.owner` (§5); Buzz adapter emits it; a cross-surface audit field elsewhere |
| **Threads / replies** | Adapter `reply()` + `threads` capability (§5); loop rules treat a thread reply as a message (§8) |
| **Edit / delete** | Adapter `edit()`/`delete()` — **guarded like any send** (§5) |
| **Reactions** | Adapter `react()`, no `--emoji-url` (guard §7.1) |
| **`send-diff` / NIP-34 git events** | Loop B alternate publish target (§10); `sendDiff` capability |
| **Git forge / NIP-34** | Loop B can publish PRs/reviews natively on Buzz (§10) |
| **Built-in YAML workflows** | **Complementary, not replaced** — Buzz workflows are declarative + Buzz-only; our Job SDK is code-based, cross-surface, bespoke. Use Buzz workflows for simple Buzz-local automation; the Job SDK when logic is real or must span surfaces |
| **Canvases, voice, media, search** | **Out of scope v1** — adapter advertises them as unsupported capabilities; revisit per demand |
| **ACP harnesses (Goose/Codex/Claude Code)** | We speak ACP to **Claude Code**; the same seam admits the others later |

**One deliberate divergence to document loudly:** upstream `buzz-acp` auto-injects
`BUZZ_RELAY_URL` / `BUZZ_PRIVATE_KEY` / `BUZZ_AUTH_TAG` **into the agent
subprocess**, so the LLM holds the signing key and sends by shelling out. Our
gateway (Approach 2) **does not inject the private key into the brain** — the
gateway holds it and sends on the brain's behalf through the guarded egress. This
is strictly more contained than the path most Buzz users arrive from, and the
docs must call it out so it doesn't read as a missing feature.

### 17.1 Buzz capability parity — dropping the CLI drops no capability

The `buzz` CLI is a **stateless Nostr client** (JSON in, signed events out) —
every command is publish/subscribe/query of Nostr events, so a native TS client
reaches the same relay surface. Confirmed against `crates/buzz-cli/README.md`:
there is **no** `subscribe`/`watch`/`stream` command (inbound was always
`buzz-acp`), and the command groups map to event kinds:

| CLI group | Maps to | v1 |
|---|---|---|
| `messages` send/edit/delete/get/thread/search/vote/send-diff | NIP-01 + NIP-34 | **native** |
| `reactions` add/remove/get | NIP-25 | **native** |
| `dms` list/open/add-member | NIP-04/44 | **native** |
| `users` get/set-profile/presence/set-status | NIP-05/38 | **native** (bring-up + presence) |
| `channels` list/get/join/leave/members | relay conv. | **native** |
| `channels` create/update/add-member/remove-member (admin-signed) | relay conv. | **CLI-assist at bring-up** |
| `repos` (NIP-34), `mem` (NIP-AE) | NIP-34 / NIP-AE | native if needed (see below) |
| `canvas`, `workflows`, `feed`, `social`, `upload`, `pack` | relay extensions | **out of v1 scope** |

Two honest caveats and how we handle them:

1. **Standard NIPs are stable; relay *extensions* drift.** Messages, reactions,
   DMs, profile/presence, git, mem, auth are standardized — native, low-risk.
   `canvas`/`workflows`/`feed`/`pack` are Buzz-relay conventions on a `0.x`
   project; reimplementing them means tracking upstream. They're already out of v1
   scope, so we take on none of that drift now; when we add one, native-vs-assist
   is decided then.
2. **The `buzz` CLI stays available as an optional bring-up/admin helper — never
   in the reply hot path.** Admin-signed one-shots (`channels create/add-member`,
   `users set-profile`, `repos create`) and any extension kind not yet native are
   done by shelling to the pinned `buzz` binary from the *bring-up* flow (as `gh`
   is used), inheriting upstream's exact conventions for the drift-prone tail.
   This keeps the Rust binary out of the latency/guard-sensitive runtime while
   **guaranteeing a Buzz capability can never be silently lost** — the fallback is
   always "call the real client." A conformance test asserts the native adapter
   covers every CLI command's underlying event kind.

**Kill switch is toolkit-native, not Buzz `mem`/engrams.** The fleet parks jobs
via `buzz mem` engrams (NIP-AE); we deliberately do NOT depend on that — the
switch is gateway-owned state, so it works identically on Slack/Discord (a gain,
not a loss). `mem` stays available (native or CLI-assist) for agents wanting
durable engram memory.

**Version discipline:** the native adapter pins the **Nostr event-kind + tag
conventions** it implements (and, where CLI-assist is used, a tested `buzz`
binary version); an OSS toolkit re-checks the relay's conventions on each bump
rather than floating `main` as the internal fleet does.

## 18. Open decisions

1. **License** — Apache-2.0 proposed.
2. **k8s render** — Helm vs Kustomize (deferred to deploy sub-spec).
3. **Hardened tiers as seams-now / build-fast-follow** — accepted for v1.
4. **Transport-neutral rename** — `buzz-agent-toolkit` is the interim name; revisit
   once Slack/Discord land (a name that leads with one of three surfaces will
   confuse). Candidates parked: Hearth, Switchboard, Roost, Concord.

**Resolved during review** (2026-08-12): config = declarative manifest, no runtime
code execution (§4); concurrency = serialize-per-channel + bounded (§6); scope =
single agent per deployment (§2); Buzz = native Nostr client, CLI as optional
bring-up helper (§5, §17.1); **name = `buzz-agent-toolkit`** (interim); **isolation
= env-scoped subprocess, same container, harden to separate-container+socket later
(§6.3)**.

---

## 19. Relationship to the SageOx fleet

Clean-room, no shared files. The fleet may later dogfood this toolkit as a
dependency; that migration is out of scope here. Patterns carried over are
credited to the fleet's own decision records and agent rules — `agent-loops`,
`cron-agent-kill-switch`, `buzz-degraded-mode`, `buzz-agent-identity`.
```
