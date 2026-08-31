# Fleets, and the mayor

One agent is easy. Three is a fleet, and a fleet needs things a single agent never does:
a roster, a way to tell who is alive, a kill switch per job, and somebody whose job is
noticing when one of the others went dark.

This document is **doctrine, not machinery.** The toolkit ships no roster type, no roll
call, and no mayor — a roster is a fleet concept, not a runtime one, and it stays with
the fleet ([jobs RFC §13](design/2026-08-19-jobs-rfc.md#13-what-the-toolkit-does-not-own)).
The toolkit's half of this story is the job envelope — the declaration, the trigger, the
kill-switch admission, the budget, the verdict contract, and the run record — specified
in [the jobs RFC](design/2026-08-19-jobs-rfc.md) and landing item by item: the verdict
contract is in `core` today and the rest is in flight. What a deployment target must
preserve is [the deployment contract](deployment-contract.md). This is for the operator
standing over all of it, once there are more than about three agents to stand over.

The **mayor** is a designated agent that reports on the fleet — typically a daily roll
call naming who is alive. It is the single highest-value agent to have and the easiest
one to get subtly, dangerously wrong.

*The failures below are the SageOx fleet's, generalized. No roster, channel identifier,
path, or key from it is carried here.*

## Declare the roster. Never discover it.

The mayor reads a **declared** roster. It does not scan the cluster.

That looks like bookkeeping until you notice what a scan cannot see: **absence is
unjudgeable.** An agent that was never deployed, an agent whose deploy silently failed,
and an agent that does not exist are one observation — nothing is there. A declared
roster is the only artifact that can say *this agent is supposed to be here*, which is
the only way "it isn't" becomes a finding rather than a shrug.

The shape, which is the consumer's own file and deliberately not a toolkit schema:

```
name · display name · owner · one line on what it is for · where it is deployed
chat:  { workload, expected: true | false, why }
jobs: [ { workload, expect: "live" | "parked" } ]
```

Every entry carries its **expectation**, because the observation alone means both things.
A parked job reporting parked is healthy. A live job reporting parked is an incident.
`expect: "parked"` is also what keeps a deliberate break-in posture legible: a job
shipped `suspend: true` so it can be proven by hand is not an outage, and the roster is
where that gets said out loud instead of remembered.

An entry nobody can describe is an entry nobody restarts, which is why the job
declaration requires a one-line `description` and a roster should carry the same for each
agent. The reviewer you are writing for did not deploy any of this.

## The verdict is code, not a turn

**Compute liveness deterministically. Never ask a model.**

A liveness report you cannot trust is worse than no report, because it manufactures calm.
The roll call is ordinary code with ordinary tests: read state, compare against the
declared expectation, emit a verdict. The mayor's conversational ability is irrelevant to
it.

Keep the axes separate, and never fold them:

| Axis | What it answers | What it does not answer |
|---|---|---|
| Pod | Is the always-on face running? | Whether it replies |
| Cron | Did the scheduled job run when it should have? | Whether the run proved anything |
| Chat | Did it answer a message? | Whether its jobs ran |

A green pod proves a process started. It does not prove the agent replies — that is a
different question with a different answer, and collapsing them is how a fleet looks
healthy while nobody is home.

**`UNKNOWN` is a third verdict and must never round to either neighbour.** Rounding it to
OK hides outages; rounding it to DEAD cries wolf until nobody reads the report. Say you do
not know.

That is the same three-valued discipline the toolkit already carries for jobs, so a roll
call should take the contract rather than reinvent a boolean: [`Verdict`,
`verdictFromGate`, `combineVerdicts`, and `describeVerdict`](../packages/core/src/verdict.ts),
exported from `@sageox/agent-toolkit-core`. An empty roll call combines to `UNKNOWN`,
because no checks running is never success — and `describeVerdict` is the half that
matters at render time, since a report is where a careful verdict most often gets
flattened back into a reassuring word.

## The failure worth reading twice

A mayor has two surfaces: a scheduled job that can actually read cluster state, and a
chat face you can talk to. Somebody asked the chat face how the fleet was doing.

**It answered. Confidently. It had no ability to read pod state at all.**

Nothing was broken in the ordinary sense. The chat face received a question it could not
truthfully answer and produced the shape of an answer, because that is what these systems
do. Only the privileged job could tell the truth, and nobody had told the chat face that.

The general form, which reaches well past mayors:

> **An agent that can be asked a question it cannot truthfully answer will answer it
> anyway.** Absence of a capability does not present as an error. It presents as fluent
> prose.

So the fix is structural, not a prompt:

1. **Do not give a surface a question it cannot answer.** If only the scheduled job can
   read cluster state, the chat face's honest reply is "the roll call runs at 08:00, here
   is the last one" — pointing at an artifact it can actually read.
2. **Publish verdicts as artifacts, and have conversational surfaces cite them.** A mayor
   that quotes a timestamped report cannot invent one. This is a constraint on the job
   host as much as on the mayor: the job writes its verdict to an artifact, and the chat
   surface gets a **read tool for that artifact** — never a capability it half-has
   ([jobs RFC §8.2](design/2026-08-19-jobs-rfc.md#82-how-a-job-reports-one)).
3. **Make the artifact distinguish "no report" from "report says fine."** If those two
   render the same, you have rebuilt the bug one level up. A missing or unparseable
   verdict artifact is `UNKNOWN`.

Steering a surface away from answering is not the fix. It is the same trust in fluent
prose, moved somewhere harder to test.

## Kill switches belong to the fleet, not the deploy

Parking a job must never require a deploy. The mechanism is the toolkit's, specified in
[jobs RFC §6](design/2026-08-19-jobs-rfc.md#6-kill-switches): a soft switch in the
agent's own memory, a hard `suspend: true` in the declaration, a `failDirection` declared
per job, and a switch read that returns a reading rather than a boolean. Three
fleet-level obligations sit on top of it, and none are enforceable by a runtime that can
only see one agent:

- **The roster is where a posture becomes reviewable.** The switch says what is true now;
  the roster says what was intended. A roll call that reads only the switch reports every
  deliberately parked job as a finding, every morning, until people stop reading it.
- **"Never configured", "cannot read", and "a human parked it" stay three different
  sentences all the way to the report.** The toolkit separates them at the read; a report
  that flattens them back into one word has undone that in the last inch. A fleet-wide
  memory misconfiguration once hid for weeks behind a status that read normal, because
  they rendered the same.
- **The mayor may tell a sibling to stop. It may never start one.** Anyone may park a
  job; only a human may arm one. If the recovery path from "we deployed this and it is
  wrong" runs back through the automation that is misbehaving, there is no recovery path.

## The spend cap the toolkit cannot enforce

Give every agent its own provider workspace with a hard monthly cap. This is an operator
step with no toolkit substitute: the runtime cannot create such a workspace, cannot read
its balance, and cannot verify one exists.

A job's `maxSpendUsd` bounds one job's own accounting and nothing else. A wedged retry
loop inside a brain, a chat surface answering a busy channel all night, and a second copy
of an agent somebody started by hand are all outside it. The workspace cap is the only
backstop that holds when the thing spending money is not the thing counting.

Say this plainly, because the alternative is the defect this whole document is about:
claiming a control the runtime does not hold is a composed verdict, one level up.

## Should you have a mayor?

| Fleet size | Verdict |
|---|---|
| 1 agent | No. You will notice. |
| 2–3 | Probably not yet. A scheduled check is enough. |
| 4+ | Yes. Past a handful, "is everyone up?" stops being answerable by looking. |

The mayor is also where fleet-wide orchestration lands once you want it — one agent
handing work to another, tracking who is mid-task, noticing a stalled hand-off. That is
the point where a **shared brain** stops being a nicety: coordination through a public
channel means every hand-off is a message a human scrolls past. The
[deployment contract](deployment-contract.md) states what a shared brain costs — a
genuinely shared volume mounted into each participant, with filesystem permissions as the
authorization boundary.

## Where this becomes machinery

| Doctrine here | Where it is enforced |
|---|---|
| A declared roster, with an expectation per entry | Nowhere in the toolkit. The consumer's file, and the roll call that reads it. |
| Liveness is computed, never narrated | The consumer's roll call — ordinary code, ordinary tests. |
| Three-valued verdicts; `UNKNOWN` never rounds | [`packages/core/src/verdict.ts`](../packages/core/src/verdict.ts) |
| A verdict artifact the chat surface reads instead of guessing | The job host's verdict artifact ([RFC §8.2](design/2026-08-19-jobs-rfc.md#82-how-a-job-reports-one)) |
| Fail-direction per job; never-set ≠ unreadable | `killSwitch.failDirection` and the switch reading ([RFC §6.1, §6.2](design/2026-08-19-jobs-rfc.md#6-kill-switches)) |
| Anyone may park a job; only a human may arm one | Kill-switch write admission ([RFC §6.3](design/2026-08-19-jobs-rfc.md#63-the-switch-parks-automation-not-the-job)) |
| A per-agent spend cap | Nowhere in the toolkit. The provider console, owned by the operator. |

Every row citing the RFC is specified there and lands with the job host; `verdict.ts` is
in `core` today. Until a row is code, it is a rule somebody has to keep by hand — which is
worth knowing before you rely on it.
