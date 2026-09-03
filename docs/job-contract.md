# The job body contract

Everything the job host tells a job body, and everything it reads back. **There is no SDK
to import and no base class to extend** — the whole interface is an argv, some environment,
an exit code, and a file. A job body can be a shell script as easily as TypeScript.

`sageox-agent job run <slug>` is what a CronJob execs. For how jobs are declared, triggered,
parked, and bounded, see [the jobs RFC](design/2026-08-19-jobs-rfc.md).

## What the host passes in

| Variable | What |
|---|---|
| `JOB_SLUG` · `JOB_RUN_ID` · `JOB_TRIGGER` | Who this run is. The trigger is stamped from the entry point that started it, never passed in, so a job cannot claim a human asked for what a clock started. |
| `JOB_VERDICT_PATH` | Where to write what you ran. |
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
      # start without it. Declaring one here refuses `trigger.onRequest` on this job.
      jobSecrets: { GH_APP_PEM: GH_APP_PEM }
      # Ambient variables this body inherits, by name. For values the platform injects at
      # runtime — EKS IRSA below; GKE and Azure workload identity present the same way.
      passthrough: [AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_REGION]
```

`jobSecrets` is a claim about where the value is mounted, not a second resolver — both maps
resolve from the same directory list, and a deployment with one directory satisfies both.
A target may hand `job run` a second one it does not give the gateway (`--job-secrets`; the
Helm chart spells the mount `agents.<name>.jobSecrets`), and a ref living only there cannot
resolve on the on-request path, which is the one that runs inside the gateway. Saying which
refs moved is what lets that pairing be refused at load, by name, rather than on the run
that meets it.

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
