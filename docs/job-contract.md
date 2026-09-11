# The job body contract

Everything the job host tells a job body, and everything it reads back. **There is no SDK
to import and no base class to extend** — the whole interface is an argv, some environment,
an exit code, and a file. A job body can be a shell script as easily as TypeScript.

`sageox-agent job run <slug>` is what a CronJob execs. For how jobs are declared, triggered,
parked, and bounded, see [the jobs RFC](design/2026-08-19-jobs-rfc.md). For temporary workers
with their own runtime image, durable status and cancellation, see [external jobs](external-jobs.md).

## What the host passes in

| Variable | What |
|---|---|
| `JOB_SLUG` · `JOB_RUN_ID` · `JOB_TRIGGER` | Who this run is. The trigger is stamped from the entry point that started it, never passed in, so a job cannot claim a human asked for what a clock started. |
| `JOB_VERDICT_PATH` | Where to write what you ran. |
| `JOB_WORK_SCHEMA_VERSION` | `1` when structured reporting is enabled, otherwise empty. Gate optional work fields on this capability; see [schema 1](#structured-work-events-schema-1). |
| `JOB_OUTPUT_SCHEMA_VERSION` | `1` when the job declares `output: {format: json}`; empty otherwise. Older hosts may omit it. |
| `JOB_OUTPUT_MAX_BYTES` | `16384` for opted-in JSON output, including its versioned envelope; empty otherwise. |
| `JOB_DEADLINE_AT` | Epoch ms at which the host stops you. Bow out before it. |
| `JOB_HARNESS_TIMEOUT_MS` · `JOB_MAX_ITERATIONS` · `JOB_MAX_ATTEMPTS` · `JOB_MAX_SPEND_USD` · `JOB_MODEL` | The declared bounds the runtime cannot enforce for you. It can hold a job to a clock without knowing what it does; it cannot count an iteration or a dollar. |
| `JOB_PARAM_<NAME>` | One per parameter this run was given, uppercased. Already validated against the declaration — see below. Absent when the run was given none. |
| `JOB_CHANNEL_URL` · `JOB_CHANNEL_TOKEN` | Where this run talks to its report channel, for a job declaring `report.probe`. Absent for every other job. |

**And nothing else you did not ask for.** A job body's environment is declared, not
inherited: it starts from `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR`, and grows
only by what `run` names. The gateway's own environment is the credential zone, and a job
body is the child most likely to shell out to a coding harness — so it gets the same
treatment every other spawned child already had, for the same reason.

```yaml
jobs:
  - slug: sweep
    run:
      command: node
      args: ["runner/src/sweep.ts"]
      # Plain configuration. Never a credential.
      env: { LOG_FORMAT: json }
      # Env var name -> secretRef. Resolved by the host, from /mnt/secrets-store or the
      # environment, and refused at startup if it does not resolve.
      secrets: { GH_TOKEN: GH_TOKEN, ANTHROPIC_API_KEY: ANTHROPIC_API_KEY }
      # The same, for a credential the gateway's own process must not hold. Resolved
      # identically, but left out of the startup check — that is what lets the gateway
      # start without it. For a local job, this refuses `trigger.onRequest`.
      # External workers may use both.
      jobSecrets: { GH_APP_PEM: GH_APP_PEM }
      # Ambient variables this body inherits, by name. For values the platform injects at
      # runtime — EKS IRSA below; GKE and Azure workload identity present the same way.
      passthrough: [AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_REGION]
```

`jobSecrets` is a claim about where the value is mounted, not a second resolver — both maps
resolve from the same directory list, and a deployment with one directory satisfies both.
A target may hand `job run` a second one it does not give the gateway (`--job-secrets`; the
Helm chart spells the mount `agents.<name>.jobSecrets`), and a ref living only there cannot
resolve on the local on-request path, which runs inside the gateway. Saying which
refs moved is what lets that local pairing be refused at load, by name, rather than on the run
that meets it. An external job instead resolves these refs only inside its worker.

A secret of the same name beats `env`, so a credential can never be silently downgraded to
a hardcoded value; the `JOB_*` variables above beat everything, because a body that could
redefine `JOB_VERDICT_PATH` could point the host at a file it wrote in advance — and one
that could redefine a `JOB_PARAM_*` would be choosing the target the caller was supposed to
choose.

## Values one run is given

Some work needs a target: **which** issue, **which** document, **which** environment.
Declare it, and the host validates it before your body starts:

```yaml
jobs:
  - slug: triage
    # A required parameter may only be started on request. A clock has no issue to name,
    # and a webhook carries no payload, so the manifest refuses that combination at load.
    trigger: { onRequest: true }
    parameters:
      issue:
        type: integer
        description: Which issue to triage.   # what a caller reads when it fills the field
        required: true
        minimum: 1
      env:
        type: string
        description: Which environment to look at.
        # A string is bounded by a closed list or by a pattern — exactly one of the two.
        values: [staging, production]
```

The body reads `process.env.JOB_PARAM_ISSUE` and `JOB_PARAM_ENV`, and can trust them: the
type, the bounds, and the required-ness were checked against this block, both at the tool
call and again in the host, so the bound holds on every door — a chat tool, an operator's
`--param`, whatever comes next. Where the values cannot be listed, `pattern` bounds the
shape instead: an id, a slug, a branch. Length is part of a shape, so it goes in the pattern
too — `^[a-z-]{1,64}$` — and a string is capped at 1024 characters whatever its pattern
admits. Write `.*` if you truly want free text, where a reviewer can see you chose it.
Values reach the body as **environment, never argv**: the command line is still
`run.command` and `run.args` and nothing else. An integer is a JSON number and must be
exact: a body reads `JOB_PARAM_*` as text, and a value that would not survive that trip is
refused rather than quietly rounded.

**A parameter names a target; it does not choose a behaviour.** There is no boolean, because
"which" is not a question answered yes or no — but no type can tell a target from a mode
(`[staging, production]` is a target; `[quick, full]` is a mode wearing the same clothes), so
this one is on you. A job whose work a caller can switch is two jobs with two slugs, each
with its own bound and its own line in a tool policy, where an operator can see both. That is
also what keeps `mcp__jobs__job_run` safe to offer an agent that answers anyone: a job that
declares no parameters is started by a slug and nothing else, which is still the default and
still what most jobs should be.

**If your body shells out to a coding harness, declare its key** — `ANTHROPIC_API_KEY` is
not inherited any more than anything else is.

## What a body finds on disk

**The bundle, and nothing your body did not put there.** A run starts in the agent's
directory — `./body.sh` resolves because of it. In a container deployment a scheduled run
stages that directory for itself, fresh, and drops it when the run ends.

**`workspace/` is the agent's, and a body never writes it.** The repository checkouts under
`workspace/repos` and the `ox` index under `workspace/ox-data` belong to `sageox-agent run`:
it clones, fast-forwards and indexes them at startup, in its own process, for the brain's
code tools. Nothing else builds them — not `job run`, whatever its trigger — so a body
writing there is a second writer on a tree it does not own, and a body deleting there
deletes an index the agent pays minutes to rebuild.

**Whether a body may read them depends on the deployment, so test before you look.** A run
the brain starts is inside the gateway's own process and sees the workspace that process
built — a racing one, because startup creates each repository's directory before `git` fills
it and waits for neither the clone nor the index. A standalone `job run` sees what its target
gave it: on a single host that is the same directory, and in a container deployment it is
nothing at all unless the deployment says otherwise, which the chart spells
`persistence.jobCheckouts`
([the chart's README](../deploy/helm/README.md#a-job-that-reads-the-agents-checkouts)).
One directory per repository, named `<owner>--<repo>` in lower case, and the test is
`git -C workspace/repos/acme--widgets rev-parse --verify HEAD`, not the directory: startup
creates it, and `git clone` creates `.git` inside it, before either has a ref to resolve.
What that proves is one clone that got as far as writing one — never a lock. The agent
fast-forwards these trees at every start, so a body reads a snapshot that can move under it,
and a body that needs one that cannot clones its own.

**A body that needs a tree either way clones one** — shallow, and inside its budget. From
the mount when there is one: `git clone --depth 1 workspace/repos/acme--widgets ./work` is
local, needs no token, and costs no network. Durable state a body genuinely shares with the
agent is a mount the deployment gives it
([`sharedVolumes`](../deploy/helm/README.md#jobs) is the Kubernetes spelling); a working
tree is not that, which is why the checkouts arrive read-only or not at all.

**The index does not travel with them.** `ox` opens its store read-write, so pointed at a
read-only one it reports corruption: `ox code search` errors, and `ox code status` answers
zeroes over `index_exists: true`. A deployment that shares checkouts therefore shares the
checkouts alone, and a body's `ox` finds no index rather than one that reads as empty.
`ox query` is API-backed and needs no local store, so it works wherever the job has network
and a credential.

## What the job writes back

The artifact is gates you **ran**, never a verdict you reached — the host mints the verdict,
and there is no field for a status:

```json
{ "gates": [ { "gate": "unit-tests", "executed": true, "exitCode": 0 },
             { "gate": "jscpd", "executed": false, "exitCode": null, "detail": "not on PATH" } ] }
```

`executed` is *did it start*, `exitCode` is *what it said on the way out*; a gate killed
mid-run is `{"executed": true, "exitCode": null}`. **A gate that did not execute is UNKNOWN,
never PASS** — and so is a missing artifact, an unparseable one, and an empty gate list. A
job that ran, exited 0, and reported nothing has proven nothing.

## Where a run is announced

A job declaring `report: {surface, channel}` posts its own status there: **one line at top
level, and every gate threaded beneath it.** The headline carries the outcome, the verdict,
and *how many* gates went unproven — a bad run is never invisible, only un-shouted — while
the per-gate lines are one click away rather than in the scroll, which is what keeps a
channel scannable on a day when three agents all have something to say. The toolkit owns
that shape; the words in it are gate names the job chose.

A run that proved itself posts nothing by default, and neither does a parked job refusing a
tick: announcing a posture somebody deliberately chose, every ten minutes, is how a channel
teaches its readers to skim past the announcement that was real. The run record is written
either way, and the whole path is best-effort — a relay outage never fails a job that did
its work.

That default is right for a job that hunts and wrong for a job that reports. A job whose
successes are the thing worth saying — one that opens a pull request every half hour — can
only be heard by claiming it proved nothing, and its headline then reads `FAILED` while the
words beneath it say a fix landed. Declare `announce: always` and a clean run is heard:

```yaml
report:
  surface: buzz
  channel: "…"
  announce: always     # default: unproven
```

It changes which runs speak and nothing about what they are called. The status word is
still minted here, a body still cannot write one, and a combined verdict still carries none
of the body's words into the headline — so a passing gate whose `detail` reads *fixed the
flaky login test, draft up at #41* threads as `PROVEN: fixed the flaky login test, draft up
at #41`, and the headline above it stays the host's.

A job that is both scheduled and reporting fits neither mode. One that ticks every half hour
and finds something twice a month is ~48 "nothing to report" lines a day under `always`, and
silent under the default on the ticks that did the work — a run where every gate passed has
nothing unproven left to announce. `announce: reported` posts a run whose body wrote a
`detail` on some gate, whatever the verdict, and is otherwise the default. Gates without
prose are outcomes the verdict already speaks for; a `detail` is a sentence composed for a
human. It buys no pass — the status word in front of that sentence is still minted here —
and it lowers no floor: a body that wrote no gates is UNKNOWN and is announced.

No mode announces a job the switch or a suspension refused: that silence is about a posture
somebody chose, and the run these modes weigh never happened.

`PROVEN:` in front of that sentence is right while the sentence after it is the host's, and
wrong for the job whose gates *are* the report — a body that wrote *the bench is full, so I
tended #3961 instead* composed something for a person to read, and the machine word in front
of it is what makes a human update read like machinery. Declare `proven: verbatim` and it
posts as written:

```yaml
report:
  surface: buzz
  channel: "…"
  proven: verbatim     # default: labelled
```

It is presentation and it reaches PASS alone. A passing gate that wrote no `detail` still
reads `PROVEN: …`, because the sentence there is the host's machine phrasing rather than
anybody's prose. **FAIL and UNKNOWN keep their label under both values** — that label is the
whole of what stops a body's *everything looks clean* on a gate that exited 1 from reading
as a success, and no setting takes it away. The verdict is still minted here from what the
body ran, and the headline is still host-phrased: a combined verdict carries none of the
body's words, so there is nothing there for `verbatim` to render.

## A job that probes

Everything above describes a job that **observes**: it reads something, writes the gates it
ran, and the host mints one verdict. Some work cannot be written that way. A fleet roll call
has to post into a channel, wait, read the answers back, and name who did and did not
answer — and the reply set is knowable from the channel and from nowhere else, since a
Deployment can be `Ready`, `Running` and green while consuming no events at all.

Declare `probe: true` beside the report destination, and the host opens a channel for the
length of the run:

```yaml
report:
  surface: buzz
  channel: "…"
  probe: true       # this body talks through the channel while it runs
```

The body then has `JOB_CHANNEL_URL` and `JOB_CHANNEL_TOKEN`, and three verbs over them —
MCP `tools/call` over HTTP, so a `curl` is enough and there is still nothing to import:

| Tool | Takes | Answers |
|---|---|---|
| `post_message` | `text`, optionally `mentions` — who to address it to — and optionally a `threadRoot` this run posted | `{"posted": true, "threadRoot": "…"}` — `null` where the surface named no id, so there is nothing to read back |
| `thread_read` | `root` — a `threadRoot` this run was handed — and optionally `limit` | `{"replies": [{"author", "text", "ts"}, …]}`, oldest first |
| `channel_members` | optionally `limit`. No destination: the channel is the one `report` names | `{"members": [{"surface", "id", "isSelf", "isAgent", "name", "mentionable"}, …]}` |

A fourth, `channel_history`, is declared separately — see
[a job that announces](#a-job-that-announces-something-once).

```js
const call = async (name, args) =>
  JSON.parse(
    (
      await (
        await fetch(process.env.JOB_CHANNEL_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.JOB_CHANNEL_TOKEN}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
      ).json()
    ).result.content[0].text,
  );

// Who is in the channel to be asked. Read first, because it is both what the roll call
// addresses and what tells a silence apart afterwards: an agent that answered slowly, and
// one that was never in the room.
const roster = (await call("channel_members", {})).members;

// **Ids**, never the member objects: a name renders in the text and wakes nobody, and a
// roll call that woke nobody reads back empty and reports the whole fleet silent.
const { threadRoot } = await call("post_message", {
  text: rollCall,
  mentions: roster.map(({ id }) => id),
});
// … wait, on a schedule this body owns …

// `null` means the surface named no id, so there is no thread to read. Report that gate
// `{executed: false}` rather than reading `null` or counting an empty roll call as a pass:
// "nobody replied" and "this surface cannot tell you" are different findings.
const replies = threadRoot
  ? (await call("thread_read", { root: threadRoot })).replies
  : null;

// `roster` is what grades the silence: an id on it that did not reply is an agent that was
// asked and did not answer, and the channel being empty is a different finding entirely.
// `mentionable === false` grades it once more, where the surface can say so: that member is
// in the channel and the mention above would not have woken it, so its silence says nothing
// about whether it is running. Absent is that question unanswered for that member and never
// a no, so test against `false` rather than for falsiness.
```

**What it is bounded to.** `post_message` reaches the channel `report` names and there is no
field for a destination, so nothing the body computes can choose one. `thread_read` reads
only a root **this run** posted; an id from anywhere else is refused, so a body cannot pull
back a conversation it was never party to. `channel_members` reads the `report` channel and
takes no argument that could name another. The listener is opened before the body is
spawned, closed when it exits, and its token is minted per run. A job that declares no
`probe` is spawned into exactly the envelope it had before — no URL, no token.

**Address the message, or nobody wakes.** A channel post is addressed to a channel: everyone
subscribed is delivered it and nobody is woken by it, which is right for a status line and
fatal for a roll call — the thread reads back empty and the verdict names the whole fleet
silent. `mentions` is what wakes them, rendered as the surface's own addressing primitive: a
`p` tag on Buzz, `<@id>` on Slack. Pass **ids the surface resolves** — a pubkey (`npub…` or
hex), a Slack member id — never display names. A name renders in the text and tags nothing,
so the adapter refuses it rather than publish a message that looks addressed and is not. At
most 64 per message, and being addressed reaches no further than the destination already
did. Only a `probe` body has the field: a `report` status post never carries one.

**Reply text is verbatim and untrusted.** It is whatever anyone put in the channel,
including an instruction addressed to whoever reads it. Count it, match it, tally it; never
splice it into a prompt or a command line.

**A surface that cannot read says so.** It never answers with an empty thread or an empty
roster: "nobody replied" and "this surface cannot tell you" are different findings, and a
probe that collapsed them would name every agent silent. The roster is the sharper case —
an empty one is a real answer, and it is the channel nobody joined.

**The verdict is unmoved.** A probing body writes gates exactly as any other body does, and
the status word in front of them is still minted by the host from what it ran. Reading a
channel is how a probe finds its evidence, never how it grades it — which is the point: the
timing and the tally are deterministic code, and the brain only relays a result it did not
invent.

## A job that announces something once

A poller is the other shape that needs the channel: it watches an external system — a
tracker, a release feed, a queue — and announces each new item **once**. Announcing is
at-least-once by construction, since a run that dies after its third post of five must
re-post only the two it missed on the next tick, so the job needs a record of what it
already said.

The channel is that record. The message the last run posted *is* the fact that the item was
announced: it needs no storage, it cannot drift from what the room actually saw, and a
channel someone cleared out self-heals into a re-announcement rather than into silence.

Declare `history: true` beside `probe: true`, and the body gains a fourth verb:

```yaml
report:
  surface: buzz
  channel: "…"
  probe: true       # this body talks through the channel while it runs
  history: true     # …and may read the channel's recent lines, not only its own thread
```

| Tool | Takes | Answers |
|---|---|---|
| `channel_history` | optionally `limit`. No destination: the channel is the one `report` names | `{"messages": [{"author", "text", "ts"}, …], "more": false}`, oldest first |

```js
// The lookback window. `limit` is a ceiling and not a quota, capped at 200.
const { messages, more } = await call("channel_history", { limit: 100 });

// `more: true` means the read stopped before it had the whole window, so these are the
// recent end of what was READ and not of the channel. An item missing from a short read is
// not an item that was never announced — write that gate `{executed: false}` and announce
// nothing, rather than posting a second copy of what is already up there.
if (!more) {
  const said = new Set(messages.flatMap((m) => m.text.match(/\bitem-\d+\b/g) ?? []));
  for (const item of await newItems()) {
    if (said.has(item.id)) continue;
    await call("post_message", { text: `new: ${item.id} — ${item.title}` });
  }
}
```

**It widens what the body sees, not where it reaches.** `channel_history` reads the one
channel `report` names and takes no argument that could name another, exactly as
`channel_members` does — nothing the body computes points it anywhere else. What is new is
that the lines come back from **a conversation this run did not start**: not replies under a
root it published, but whatever anyone said in the room, including before the run existed.
That is why it is a grant of its own rather than part of `probe` — a roll call reads back
only the thread it rooted and should keep exactly that reach. `history: true` without `probe: true` is refused at load, because
`probe` is what opens the channel this is served over.

**The text is untrusted, and matching it is not acting on it.** Every rule above holds
here — count it, match it, tally it, and never splice it into a prompt or a command line.
Deciding whether to post again by matching an identifier is a tally, in deterministic code,
with no model in the path.

## A job that is a turn

Everything above describes a job whose body is a **process**: the host spawns an argv, hands
it an envelope, and reads a file back. That body has no brain, no tool broker, and no second
surface, and it is bounded to the one channel `report` names — which is the whole security
argument for spawning it from a bundle at all.

So it cannot do light work that only the brain can do. *Read the last day of one surface's
channel, write a sentence about it, post that on another surface* is a few hundred tokens of
brain work with no write credential anywhere in it, and a process body cannot express it.
Neither can an ordinary turn, because a turn needs somebody to post a mention at 18:00.

A job may declare `prompt` instead of `run`, and then its body is words:

```yaml
jobs:
  - slug: daily-digest
    archetype: watch
    description: Summarize the last 24 hours of the status channel and post it on Slack.
    trigger: { schedules: ["0 18 * * *"], timezone: America/Los_Angeles }
    killSwitch: { key: mem/daily-digest/enabled, failDirection: closed }
    prompt: { file: ./jobs/daily-digest.md }   # or an inline string, for a one-liner
    report: { surface: slack, channel: "C0123456789" }
```

The prompt file is shaped like a skill — frontmatter, then the body the tick sends:

```markdown
---
name: daily-digest
description: One short post per day summarizing what the other agents did.
---
It is the scheduled daily digest. Read the last 24 hours of the status channel with
read_channel. Write one line per agent that did something and keep the links those lines
carry. Name agents with nothing as quiet. If `more` was true, say the window was busier
than one read covers. Post nothing else.
```

The shape is fixed now because nothing in the runtime reads those two fields yet. When
skills arrive, the same file can be offered to the chat face — so *run the digest now*,
asked by a person, becomes this prompt invoked on request, with no second declaration and
no edit to the file.

The path resolves against the agent directory, as `persona` does, and is **refused at load
if it lands outside it** — along with a file that is missing, is not UTF-8, or is larger
than a verdict artifact may be. The containment is what makes the rest of this section
true: these words go to the brain as steering rather than as fenced data, and the reason
they may is that they came out of the same reviewed bundle the persona did. A prompt read
off a mounted path appears in no bundle diff.

Both the declared path and its real path are checked, because they fail differently. A
symlink committed into the bundle is the one a path check cannot see, and it is the worse
of the two: the diff shows a path and never the content, the content can change after the
review that approved it, and what it resolves to reaches the brain as trusted words inside
the process holding this agent's credentials. Writing the prompt file directly is not the
same act — that puts the words themselves in front of a reviewer. A link that stays inside
the bundle is fine, and so is a bundle reached through a symlinked home, which is how a
mount usually arrives.

**The tick runs in the gateway process, never in a pod.** The gateway holds an in-process
clock: five cron fields — or one of the fixed descriptors, `@daily` and its siblings —
resolved against `trigger.timezone`. `@every 5m` is refused at load, since an interval
names no wall-clock time for a zone to resolve.

A local time a spring-forward deletes does not run that day, and the hour a fall-back
repeats fires once. Ticks that fall while the gateway is down are **not replayed** — a
digest of yesterday posted at 06:00 because that is when the pod came back is worse than no
digest — and the gap in the work events is where a missed one is visible. The Helm chart
renders no `CronJob` for a prompt job; [the chart README](../deploy/helm/README.md#jobs)
has the mirror.

Admission is this host's, in this order: the kill switch, then `suspend`, then the
gateway's own turn caps. A refused tick is recorded exactly as a refused job tick is, and
posts nothing. Then the tick enters the turn path as a **synthetic inbound event**: the
surface and channel come from `report`, the author is `schedule:<slug>` — an id no surface
issues, so nothing can be addressed to it and nothing can answer as it — and the text is
the prompt body. The author gate is the one check skipped, because there is no channel
author to weigh. The brain, the tool policy, the guard, the rate caps and `turnTimeoutMs`
are the ones every other turn gets.

The turn's reply is a **top-level post in `report.channel`**, through the same chokepoint
the brain's own `post_message` clears: channel consent, the guard, and the leak scan all
apply, and a channel the surface does not list is refused. So is a surface that carries no
top-level post at all — the console surface is one — which is why `doctor` and `validate`
check both before a deploy rather than leaving `run` to refuse at startup. A reply left under the post
reaches the agent exactly as any other message does, by mentioning it — the tick changes
nothing about what wakes a turn. An empty reply posts nothing: silence is the message here
as everywhere else.

`announce` keeps its meaning, with the turn standing in for the gate: `unproven` (the
default) posts the host's own line only when the turn never spoke — a timeout, a brain
failure, or a guard that refused everything it asked to send — and `always` posts after a
clean tick too. `reported` is refused at load, because a turn writes no gate details for it
to key on.

**Provenance is unforgeable.** The prompt comes from the reviewed bundle and nowhere else.
No channel text can start one of these turns, alter its prompt, or claim to be one, and the
`trigger: "schedule"` on the work event is stamped by the ticker exactly as `JobHost` stamps
a process job's.

Each of these is refused at load on a prompt job, by name, because it belongs to a process
body or opens a door this tier does not: `run`, `worker`, `parameters`, `model` (the turn
runs on `brain.model`), `output`, `report.probe`, `report.history` (the brain has its own
channel reads), `trigger.onRequest` and `trigger.webhook`. `budget` is optional and can only
shorten the turn: `wallClockMs` below `limits.turnTimeoutMs` wins, and above it does
nothing. A job declaring both bodies, or neither, is refused.

`sageox-agent doctor` and `sageox-agent validate` list every prompt job with its resolved
prompt file, that file's size, and its next fire time in the declared zone — a prompt that
silently changed size is the kind of thing nobody notices until the 3am post reads wrong.
`sageox-agent job run` refuses a prompt job: there is no process to spawn, and the gateway
holds the clock. `sageox-agent job park <slug>` stops it without a deploy, as it stops any
other job.

## Structured work events (schema 1)

Set `AGENT_WORK_EVENTS=1` on `sageox-agent job run` or `sageox-agent run` to emit
JSON Lines on **stdout**. The latter includes jobs requested through its MCP tool,
including detached runs. With reporting disabled, child stdout/stderr and human
status rendering retain their existing behavior. No collector or external service
is required. Deployments must wait for a versioned toolkit release containing this
contract before enabling it, and pin that release's image digest.

A top-level `sageox_work_event` key is reserved for host lifecycle records. Read
only stdout, ignore ordinary host log lines, accept `schema_version: 1`, and deduplicate by `(agent, run_id, event)`.
`run_id` is the host's existing opaque ID: do not derive another one from timestamps
or artifact IDs. Scope the agent name by deployment when combining independently
named fleets. Consumers must ignore unsupported schema versions.

```jsonl
{"sageox_work_event":{"schema_version":1,"agent":"reviewer","job":"triage","run_id":"opaque-run-id","trigger":"schedule","started_at":"2026-09-07T03:00:00.000Z","deadline_ms":300000,"event":"run.started","occurred_at":"2026-09-07T03:00:00.010Z"}}
{"sageox_work_event":{"schema_version":1,"agent":"reviewer","job":"triage","run_id":"opaque-run-id","trigger":"schedule","started_at":"2026-09-07T03:00:00.000Z","deadline_ms":300000,"event":"run.completed","occurred_at":"2026-09-07T03:00:12.000Z","outcome":"completed","verdict":"PASS","checks":[{"gate":"job:triage","executed":true,"exit_code":0,"source":"host"},{"gate":"ci","executed":true,"exit_code":0,"source":"producer"}],"report_status":"valid","admission":{"bypassed_switch":false,"switch":{"state":"on","origin":"set","value":"arming"}},"partial":false}}
```

`started_at` records the attempt; the start event's `occurred_at` records admission.
A start means admission succeeded, before setup and process spawn. It is not proof
that the process started: a later `crashed` result can report `executed: false`.
`deadline_ms` is the declared duration (`wallClockMs + deadlineHeadroomMs`),
not an absolute timestamp guessed before setup completes. For local jobs, setup time
does not consume the process budget. `JOB_DEADLINE_AT` remains the absolute
wall-clock cutoff passed to the body; the host allows cleanup headroom after that
cutoff. Refusals and overlap skips emit only a terminal record, with no admitted
deadline. `run.completed` names a terminal
**event**, whose `outcome` can still be denied, skipped, crashed, abandoned, or
`budget-bowout`. Its `occurred_at` is the host's settlement time.

`checks` retains execution and exit facts; `source` distinguishes the host process
check from producer-reported checks. Optional `execution` holds process state,
epoch-millisecond timestamps, actual exit code and signal number. A timeout may
have an actual exit code of zero after cleanup while its combined `verdict` remains
`UNKNOWN`. Neither process exit zero nor a passing gate confirms an artifact was
created or an external subject is healthy. `verdict` retains the existing gate
combination rules. A caller or chat transport timing out does not change the job's
observed outcome.

External-dispatch jobs use the dispatcher's existing run ID and settlement. The
gateway emits a start after dispatch admission, which can precede worker startup;
a cached terminal result or dispatcher refusal emits only a terminal record.
Their platform deadline remains admission-based: dispatch and worker startup consume
the declared budget. The worker subtracts elapsed time since the request's `startedAt`
before launching the body and can report a timeout without starting it.
Current dispatcher results carry aggregate verdicts and optional execution facts,
not individual checks or work metadata: these events are marked `partial`. This
contract does not expand the worker's termination-log protocol or cloud policies.

A killed host can leave a start with **no terminal record**. Absence is not proof
of success or failure. Observer/output failures are best-effort losses and never
change job admission or settlement. There is no durable event queue or replay.

### Admission diagnostics on the terminal record

`admission` is host-minted and appears on every `run.completed` record. It answers
why the run was allowed to start, or was not, without carrying the stored value.

`switch` is the reading this run's job took, or `null`. A `null` means this record
holds no reading: the job declares no kill switch, or — on a `denied-trigger` or
`skipped-overlap` outcome — the run was refused before one was read, which the
`outcome` already names. Otherwise:

| Field | Values | Present |
|---|---|---|
| `state` | `on`, `off` | always — after the job's `failDirection` is applied |
| `origin` | `set`, `never-set`, `unreadable` | always |
| `value` | `arming`, `parking`, `unrecognized`, `unavailable` | when `origin` is `set` |
| `failure` | one of the bounded lookup failure codes | when `origin` is `unreadable` |

`value` is what the stored text was recognized as, classified before the text was
discarded. `arming` is one of `on`, `true`, `yes`, `1`, `enabled`, `armed`;
`parking` is one of `off`, `false`, `no`, `0`, `disabled`, `parked`; both are
compared after trimming and lowercasing. Everything else is `unrecognized` and
still parks the job — including an annotated form such as `off — back Monday`, and
including a typo of an arming value such as `onn`. `sageox-agent job park` writes a
bare `off`. `unavailable` means a value was retrieved by a switch source that
predates this classification. **Only `value: "parking"` is evidence that somebody
parked the job on purpose. `origin: "set"` alone is not.**

`bypassed_switch` is `true` when a human's `on-request` run was admitted while the
job was parked. That run is manual execution and is not evidence that scheduled
admission works: a consumer counting admissions must read `trigger` alongside it.

A monitor watching for a job that is never admitted can suppress
`value: "parking"` without also suppressing `never-set`, `unreadable`,
`unrecognized`, or `unavailable`. Records from a toolkit release before this
contract carry no `admission` key at all; treat its absence as unknown, never as
parked.

Custom `SwitchSource` implementations keep working unchanged and report
`value: "unavailable"`. To classify, return the `value` field on a `set` lookup —
`interpretSwitchValue` from core produces it, and is what the Buzz engram source
uses.

External-dispatch requests carry the same optional field, and that request is
parsed strictly: a reader rejects a field it does not recognize. An added optional
field is therefore compatible in one direction only. A gateway older than the
dispatcher it sends to omits `value`, the dispatcher accepts the request, and the
run reports `unavailable`. The reverse does not hold — a dispatcher older than its
gateway rejects any request carrying `value`, and that worker job does not start.
A request carries `value` whenever the switch key holds a value, so this reaches
every armed job. Never run a dispatcher behind the gateway that dispatches to it.

### Optional facts in the existing verdict file

When reporting is enabled for a local job, the host sets
`JOB_WORK_SCHEMA_VERSION=1`; otherwise it sets an empty value. Producers must test
for the supported value before adding fields. The host owns this variable and
replaces any value declared by the child. Schema 1 extends the same strict
`JOB_VERDICT_PATH` JSON object. Existing gates-only files remain valid; optional
work fields never change how gates mint verdicts. The exported
`VerdictArtifactSchema` and `WorkReportSchema` in core are the shared validators.
The artifact may also contain a structured application `output` section. That
answer is validated and delivered separately and never included in lifecycle
events. Invalid application output does not invalidate valid gates or work facts;
the combined artifact remains subject to the same 64 KiB limit.

```json
{
  "gates": [{ "gate": "ci", "executed": true, "exitCode": 0 }],
  "artifacts": [{
    "subject": { "provider": "github", "kind": "pull_request", "scope": "acme/service", "id": "42" },
    "action": "created",
    "observed_at": "2026-09-07T03:00:10Z",
    "related_to": { "provider": "github", "kind": "issue", "scope": "acme/service", "id": "53" },
    "next_actor": "reviewer"
  }],
  "work_observations": [{
    "subject": { "provider": "github", "kind": "issue", "scope": "acme/service", "id": "53" },
    "state": "waiting", "next_actor": "reviewer"
  }],
  "usage": { "scanned": 0, "outputs": 1, "model_calls": 2 },
  "health": [{
    "subject": { "provider": "runtime", "kind": "service", "id": "api" },
    "check": "readiness", "status": "unknown", "observed_at": "2026-09-07T03:00:10Z"
  }],
  "partial": true
}
```

| Field | Schema 1 vocabulary |
|---|---|
| Subject | `provider`, `kind`, `id`, optional `scope`. Kinds: `issue`, `pull_request`, `document`, `artifact`, `agent`, `service`, `job`. IDs/scopes are bounded identifiers, not URLs or prose. |
| Artifact action | `created`, `updated`, `commented`, `completed`. |
| Work observation state | `open`, `in_progress`, `waiting`, `blocked`, `completed`, `closed`, `unknown`. Provider-specific states map to these in the producer. |
| Artifact/observation context | Optional `observed_at` (ISO timestamp with timezone), `related_to` (one subject), `next_actor` (identifier, not personal/requester information). |
| Usage | Optional `model_calls`, `input_tokens`, `output_tokens`, `scanned`, `candidates`, `recommendations`, `findings`, `outputs` (nonnegative safe integers), and `cost_usd` (nonnegative finite number). Only measured values; zero means measured zero, absence means unreported. |
| Health | Subject, `check` identifier, required observation timestamp, `status`: `healthy`, `degraded`, `unhealthy`, `unknown`. Producers define checks and health policy; runtime does not interpret cluster or fleet state. |
| Partial | Optional boolean. True means bounded or incomplete producer knowledge, even when every gate passes. |

Providers, checks, and next actors use lowercase letter/digit/hyphen identifiers
of at most 64 characters, beginning with a letter. IDs/scopes use up to 256 ASCII
letters/digits or `_./-`, beginning with a letter or digit. Colons are excluded,
so URI schemes cannot be embedded in either field. Put namespace information in
`provider` and `kind`, and use the provider-native ID (for example, `42`, not
`issue:42`). Arrays allow at most 100 items. Unknown fields, invalid values, malformed
JSON, missing files, and files over 64 KiB never become invented work. Terminal `report_status` distinguishes
`valid`, `missing`, `invalid`, and `oversized`; invalid/absent reports retain the
existing unproven verdict and expose no work facts. Empty gates also stay unproven.
A future incompatible vocabulary requires a new advertised version; producers
must not send fields simply because they hope a host will ignore them.

### Log boundaries and trust

Every structured record is at most **8,192 UTF-8 bytes**, including its wrapper
and trailing newline. If optional facts do not fit, whole items are omitted and
`partial` becomes true. The run identity, timestamps, outcome, combined verdict and
`admission` are preserved. An identity that cannot itself fit is an emission failure; execution
still proceeds. Identifier-unsafe historical gate names are omitted and also mark
the event partial. Gate details, requester identity, parameters, reasons/raw errors,
model output, transcripts, and credentials are not structured work fields.

With reporting enabled, child stdout/stderr are decoded across UTF-8 chunks and
wrapped as `{"job_diagnostic":{"stream":"stdout","text":"..."}}` (or `stderr`).
The one-shot human status rendering uses the same wrapper with `stream: "host"`.
Diagnostic text follows the existing diagnostic logging policy and can contain
untrusted output. **Never recursively parse diagnostic text as lifecycle events.**
A child printing event-shaped JSON remains text inside a diagnostic envelope.

These are host-observed execution facts and validated producer-reported work
facts. They are neither cryptographic proof nor independently verified provider
state. Consumers may reconcile artifacts with external systems separately; they
must not label producer claims as confirmed outcomes or infer tokens/cost from prose.
