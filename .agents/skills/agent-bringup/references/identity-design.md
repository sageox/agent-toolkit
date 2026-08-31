# Identity and operating contract

Use this reference when designing a new agent or materially changing its role. Keep the
contract specific enough that another operator can predict the agent's behavior.

## Define the job before the personality

Write one concrete sentence for each:

1. **Outcome:** What useful state should exist after the agent acts?
2. **Inputs:** Which messages, repositories, tools, memories, and external sources may it
   inspect?
3. **Definition of done:** What observable evidence proves a request or scheduled run is
   complete?
4. **Boundary:** Which destructive, public, costly, access-changing, or cross-channel
   actions require explicit approval?
5. **Voice:** How should it compress and present information in chat?

Avoid job descriptions such as “help with engineering.” Prefer contracts such as “triage a
failing build, cite the failing check and relevant code, propose the smallest repair, and
stop before merging or changing production.”

## Keep facts, inference, and access failures distinct

Require the persona to distinguish:

- a source was checked and returned no matching results;
- a source was unavailable, denied, stale, timed out, or not configured;
- the agent inferred an answer from other evidence.

“Could not inspect” must never become “nothing found.” Include degraded sources in the final
answer whenever they could change the conclusion.

## Make loops terminate

Agents share chat with humans and other agents. Add rules that prevent self-sustaining
conversation:

- Reply to another agent only when the reply adds evidence, an artifact, a decision, or a
  necessary correction.
- Do not send acknowledgements, thanks, greetings, or status-only replies to agents.
- Do not mention an agent merely to close a thread.
- After handing off a result, stop unless a human requests another step.
- For recurring work, define a maximum run duration and a kill switch before enabling the
  schedule.

The runtime also enforces turn and chain limits; the persona should make graceful stopping
the normal behavior rather than relying on those limits.

## Preserve key continuity

Treat a network identity as durable state. Re-running bring-up must reuse the existing
Nostr key and public identifier. A registration, membership, channel, or relay failure is
not evidence that a new key is needed. Rotating the key creates a different agent and may
orphan memberships, mentions, and history.

## Keep the bundle coherent

Use one public display name and purpose across `AGENTS.md`, `profile.json`, and `avatar.md`.
Wire `agent.yaml` to `AGENTS.md`. Keep operational behavior out of `profile.json`, rendering
style out of `avatar.md`, and secrets out of every declarative file. Review all four files
together before generation or publication.
