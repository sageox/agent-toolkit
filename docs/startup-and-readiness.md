# Startup and readiness — an agent is up, or it is a black hole

**The rule, and everything on this page follows from it:**

> **An agent is up and answering immediately. Secondary warmup work never blocks startup,
> and while it runs the agent must be able to say it is not ready yet.**

The [deployment contract](deployment-contract.md) states this in one row, because a
deployment target has to preserve it. This page is the reasoning behind that row and the
machinery that holds it: [`health.ts`](../packages/core/src/health.ts) and
[`lifecycle.ts`](../packages/core/src/lifecycle.ts).

An agent that is not connected is not "starting up." It is a **black hole**: a question
sent to it produces no acknowledgement, no error, and no trace — a silence
indistinguishable from thinking. There is no observability story that recovers from it,
because the failure happens in the sender's client, in a process you do not run.

Being connected and *incomplete* is a strictly better failure. The question lands. The
asker gets an answer, even if the answer is "that part of me is still warming up, here is
what I can tell you meanwhile."

## The outage that produced this rule

A chat agent's container gated its own startup on building a code index, in an init step
that ran to completion before the agent process existed.

| | |
|---|---|
| Rollout begins, old agent deleted | **ear goes off the air** |
| Clone refreshed from cache | 3 seconds |
| Code index rebuilt from scratch | **7 minutes 8 seconds**, 76,427 symbols |
| A human @mentions the agent | *dropped — no process exists to receive it* |
| Agent connects, presence online | 7m 17s after it went down |

Indexing was **98% of the outage**. Across eight agents at roughly thirty rollouts a day,
that came to about **4.7 agent-hours daily** in which a mention was a black hole. The gate
had been in place for months, and a once-a-day roll-call probe structurally could not see
it — a daily sample cannot detect a nine-minute hole that opens thirty times a day.

**The gate's stated reason was correct and is preserved here:** an agent answering from an
empty index gives a *confident wrong answer*, not an error, so it must not answer from
one. The defect was the leap from there to *so it must not exist*. Those are different
claims:

- **"Must not answer from an empty index"** — a correctness requirement. Keep it.
- **"Must not be reachable"** — a convenience, bought because a container runtime hands you
  "run this to completion first" for free, and nobody priced it.

## Two layers, and conflating them is the bug

| | Lifecycle | Capability health |
|---|---|---|
| How many | one per agent | one per capability |
| Decides | does the agent run at all | what the agent **says** when asked |
| Lives in | [`lifecycle.ts`](../packages/core/src/lifecycle.ts) | [`health.ts`](../packages/core/src/health.ts) |
| Gates startup | **yes**, via preconditions | **never** |

**`Ready` does not mean "fully capable."** It means connected, listening, and able to
answer — including able to answer *"that part of me is still coming up."* An agent with
every brain unavailable is still `Ready`; it just discloses a lot. A readiness signal that
waits for full capability is a readiness signal that produces silence.

> **Only a precondition gates startup. No capability health, in any combination, ever
> does.**

That is not a convention. `evaluateStartup` takes both and consults only one, and
`lifecycle.test.ts` asserts it over every state in the health enum — one at a time and all
at once, including states added after the test was written. If you are here to add *"…
unless the index is still building"*, that test is the argument you have to beat.

## Precondition or capability? The line is "wrong" vs "less informed"

| | Examples | If absent |
|---|---|---|
| **Precondition** — wrong or unpoliced | no signing key · tool allowlist unenforced · no model credential · a bad author gate | **`Failed`.** Refuse to run. A wrong agent running is worse than no agent. |
| **Capability** — less informed | code index cold · a brain unreachable · a store empty · a clone that failed | **`Ready` anyway.** Come up, work, and disclose. |

An agent with no identity has no accountable voice. One whose tool policy is unenforced
has a reach nobody approved — which is why `tools.policy` is the precondition `run`
evaluates before it connects. An agent whose index is still building is neither. It is
temporarily less informed, and it can say so.

`preconditionFromProbe()` **refuses** to build a gate from a `Warming` probe. That is the
one-line mistake this page exists to prevent: probe a capability, find it not-`Ok`, promote
the reading to a startup gate, and you have rebuilt the original outage — now spelled in
the new vocabulary, and looking principled.

## The six states, and why there are six

`NotConfigured` and `Unavailable` are two states because a fleet's encrypted memory
silently never worked when they were one word. A fail-open reader rode straight through it,
a fail-closed one treated it as off forever, and no human could tell the two apart from any
surface the system produced. They carry different payloads — neither constructor accepts
the other's arguments — and they render different words.

The test that separates states is **"where does this send a human?"**

| State | Word | Sends a human |
|---|---|---|
| `Ok` | `ok` | nowhere; it works |
| `NotConfigured` | `never-configured` | to the configuration |
| `Unavailable` | `cannot-reach` | to the backend or the checkout |
| `NotFound` | `no-such-entry` | nowhere; a key with no entry is a normal answer |
| `Empty` | `nothing-stored` | to whatever fills the store |
| `Warming` | `still-warming` | **nowhere** — it is transient and clears itself |

`Empty` is its own state because it is the one failure an agent cannot feel: a search over
an empty index returns fluent, plausible prose, so the symptom is a confident wrong answer
rather than an error. `Warming` is `Empty` wearing a clock, and it lies exactly as
fluently — which is why it is disclosed.

## `Warming` — disclosed to the agent, announced to nobody

Every other degrading state means *a human must act*; that is what `remedy` is for, and it
is required.

| | `isDegrading` — disclose to the agent | `needsHuman` — announce to people |
|---|---|---|
| `Ok`, `NotFound` | no | no |
| `NotConfigured`, `Unavailable`, `Empty` | **yes** | **yes** |
| `Warming` | **yes** | **no** |

Post "a human must act" for something that fixes itself in four minutes, on every deploy,
and you have taught the team to skim past the announcement — which you pay for in full the
next time one is real. So `Warming` carries `since` instead of `remedy`, and the
constructor has nowhere to put one.

The turn prompt says this in two blocks, because nearly every line of one is the opposite
of the other. The degraded block tells the agent never to answer as if the capability had
worked. The warming block tells it to **answer the question anyway**, to say so in one
clause, and never to tell anyone to fix, file, or restart anything. Neither block carries a
`remedy`: that field is addressed at a person, it goes to the operator's terminal, and an
agent that reads it starts telling coworkers in a channel to mount secrets they have no
access to.

## The transition back is the part people forget

`Warming` is the first state that **clears itself**, which makes it the first one that
needs a way back. A reading taken once at boot cannot express recovery — the agent
apologizes for a cold index long after it went warm. *A transient state read once and
cached is a permanent one.*

So capability readings are handed to the runtime as a **function**, not a value:

```ts
const workspace = createRepoWorkspace(repos, { root, secretsDir });

const startup = evaluateStartup({
  preconditions: [precondition("tools.policy", !!policy, "…", "add `tools: ./settings.json`")],
  capabilities: workspace.readings(),   // for the log line, and for nothing else
});
if (startup.phase === "Failed") throw new Error(describeUnmet(startup));

void workspace.warm();                  // the index builds behind us

new Gateway({ …, capabilities: () => workspace.readings() });  // re-read every turn
```

The agent connects immediately, and a question arriving thirty seconds later gets *"still
warming up — answering without the code index for now,"* plus a real answer from the
checkout. Compare that with the seven minutes of nothing it replaces. `isTransient()` marks
exactly the states where a caller must re-read rather than latch.

**What this does not yet do:** a warmup that *failed* stays failed until the process
restarts. `Unavailable → Ok` recovery needs something to re-run the clone, and nothing
does. The reading is honest about it — `cannot-reach` with a remedy, on every turn, until a
human acts — which is the correct behavior for a state that needs a human anyway.

## Applying it: the checklist

1. **Enumerate preconditions.** If a human cannot fix it from outside the process, it is
   not one. `precondition()` requires a remedy for this reason.
2. **Everything else is a capability.** Probe it, report health, never gate on it.
3. **Move warmup off the startup path.** Whatever runs to completion before your agent
   connects had better be in the precondition set.
4. **Disclose to the agent, announce to humans — separately.** `isDegrading` for the first,
   `needsHuman` for the second. Never substitute one for the other.
5. **Re-read transient states.** Hand readings over as a function, not a value.
6. **Log the phase line.** `describeStartup()` emits
   `phase=Ready actionable=… warming=…` — an operator should be able to grep that without
   knowing this page exists.
