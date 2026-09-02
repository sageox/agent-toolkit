# When something is wrong

<sub>[Setup guide](../../SETUP.md) · 6 of 6 · run these commands from the repository root</sub>

**The agent is running but never answers.**
Check the log for `event_skipped` — the `reason` names the gate: `own_message`,
`not_mentioned`, `author_gate:owner-only` (the sender is not the owner), `kill_switch`, or
`limit:<rule>`. No line at all means the relay is not delivering: run
`./bin/sageox-agent probe --agent <name> --relay <url>`.

**It answers, but says it cannot use its memory or tools.**
The tool policy is not admitting them. `./bin/sageox-agent doctor` names the exact strings
that are missing. This is almost always the namespacing above. The log says which call it
was and which rule stopped it: grep `tool_call` for `outcome=refused`.

**`tool_call … outcome=refused` you did not expect.**
Something asked for a capability it does not hold. Once is a bundle with a line missing —
`reason` says which gate answered: the policy, the server's `scope`, or the leak scan.
Repeatedly, on an agent reading a channel anybody can post in, read it as what it is: an
attempt, refused, that would not otherwise have left a trace.

**`turn_failed` in the log.**
Brain-side. The error follows on the same line. A turn that exceeds `limits.turnTimeoutMs`
(default 120s) is cancelled rather than wedging the gateway.

**The team brain says it could not read team memory.**
It will not tell you what `ox` said, and that is deliberate: a failing `ox query` can quote
the query back, and the query is whatever the channel talked the agent into asking. The
channel gets one fixed sentence; the log gets `ox_failed verb=<verb> class=<class>
detail="<what ox printed>"`. The class is where to look — `not-installed` is `ox` missing
from the gateway's `PATH`, `not-authenticated` is a credential to mount or rotate (above)
and will not fix itself by retrying, `unreadable` is output this gateway could not parse,
and `failed` is everything else, where `detail` is the whole story.

The first two also latch as the `brain.team` capability, because retrying cannot disprove
either: `run` prints `note: brain.team — …` with what to do, and the agent is told to stop
answering as if team memory had worked. The next lookup that gets an answer clears the
reading, so a rotated credential needs no restart. `unreadable` and `failed` do not latch —
the next lookup may well answer, and an announcement a retry disproves is one people learn
to skim.

**`ox_failed … class=failed detail="… permission denied"`.**
`ox` needs a writable working directory. The gateway runs it from the home directory for
this reason; if you have changed that, point it somewhere writable.

**The agent says it could not write an encrypted brain file.**
It will not tell you what `age` said, for the same reason the team brain will not tell you
what `ox` said: that text reaches the model, and `age` quotes the configured recipient back
and names the absolute temp path it failed on. The log gets `vault_write_failed
file="<vault-relative path>" class=<class> detail="<what age printed>"`. The class is where
to look — `age-unusable` is `age` off the gateway's `PATH` or there without an execute bit,
`bad-recipient` is the manifest's `age.recipient` (a write also needs the matching identity,
which reports separately), `vault-unwritable` is the mount or the disk, and `failed` is
everything else, where `detail` is the whole story.

**`identity register buzz` says relay membership is required.**
The relay admits keys from a list, and this one is not on it yet. One grant has to be made
elsewhere — `buzz-admin add-member --pubkey <npub>`, on the relay host — and registration
prints it and waits: get it run, answer the prompt, and the same command carries on. It
then picks the channel off the relay's own menu and offers to make the second grant, the
channel bot role, from a hidden one-time prompt for a channel owner or admin key. Decline
either and setup continues without the relay, printing the commands to run by hand;
`doctor` reports the gap until membership is granted. Authenticating is not the same as
being admitted, so the check is a real read of the relay, not the handshake.

**An MCP server fails to start with `ENOENT`.**
The command is not on the gateway's `PATH`. Servers inherit only a minimal environment.


---

## Known limits

- **Discord** is not implemented; the seam exists.
- **The tool-call log records arguments by declaration, not in full.** A tool names the
  arguments whose values are written down; everything else is a type and a size. Free text
  — a pull request body, a `team_search` query — is deliberately never recorded, so the log
  answers *which tool, against what, and what became of it* and not *what it said*.
- **Private repository authentication is GitHub-only** — public HTTPS repositories may use
  other hosts, but the private-token header is currently scoped specifically to github.com.
- **The brain shares the gateway's filesystem.** Credentials are kept out of its
  environment, but that is not a filesystem boundary.

---

[← Reference](reference.md) · [Setup guide ↑](../../SETUP.md)
