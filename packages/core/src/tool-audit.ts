import { createHash } from "node:crypto";

/**
 * One line per MCP tool call, written for an operator and never read by the brain.
 *
 * There are two `tools/call` chokepoints, not one: `McpBroker.message` for a server the
 * broker runs as a subprocess, and `mcpToolServer` for one the gateway hosts in-process.
 * Both funnel through `auditToolCall`, because a write-capable tool can sit on either side —
 * `post_message` is *hosted* and never reaches the broker, while a bundle's own server is
 * brokered and never reaches the host. Instrumenting one would have missed the other.
 *
 * The audit follows the split `GuardVerdict` already makes: a fixed string for the brain,
 * the detail on the gateway's own log, which the brain cannot read. So untrusted text on
 * this line is not an injection vector the way it is in a tool result — but the line is
 * still somewhere a credential could land, which is what the argument policy is about.
 */

/** What became of one call. A closed vocabulary, so `outcome=` is greppable. */
export type ToolCallOutcome = "ok" | "refused" | "failed";

/**
 * A call a gate refused, as distinct from one that ran and failed.
 *
 * That distinction is the more interesting half of this log: a refusal means something
 * asked for a capability it does not hold, and repeatedly, on a surface reading untrusted
 * channel content, it is the signal the whole tool policy exists to produce. Which is why
 * it is carried by a type rather than read out of the message text — classifying the audit's
 * most important field by pattern-matching prose would make it depend on how somebody
 * happened to word an error.
 */
export class ToolRefused extends Error {}

export interface ToolCall {
  /** `mcp__<server>__<tool>` — the name the policy governs, not the server's bare one. */
  tool: string;
  args?: Record<string, unknown>;
  /** Argument names this tool declares recordable by value. Absent means none. */
  declared?: readonly string[];
}

/** A declared value is still bounded: one long argument must not flood the log. */
const MAX_VALUE = 200;

/** Free text is collapsed and bounded the same way `ox_failed` bounds its `detail`. */
const MAX_REASON = 500;

/**
 * A name — the tool's, or one of its arguments'. Both are the caller's, not ours.
 *
 * `tools/call` carries whatever `params.name` the brain sent, and `qualifyTool` prefixes it
 * rather than validating it, so the tool on this line is attacker-reachable text of
 * unbounded length. Set well above the longest name any server here actually publishes —
 * a qualified one runs to about forty characters — and nowhere near long enough to be a
 * payload.
 */
const MAX_NAME = 120;

/**
 * How much of a cut name's digest is kept — 128 bits of it.
 *
 * The first version kept 8 hex characters, on the reasoning that two names would not
 * collide by *accident*. That was the wrong bar: the names are the caller's, so the
 * question is whether a collision can be **chosen**, and 32 bits is found in about 2^16
 * tries — `tool-audit.test.ts` pins a real pair that took 74,866. A digest that an
 * attacker can aim at is a digest that identifies nothing.
 *
 * There is no readability argument on the other side of this. A name reaching 120
 * characters is already unreadable, so the 24 extra characters cost nothing that was
 * being preserved.
 */
const DIGEST = 32;

/**
 * How many arguments one line names.
 *
 * The ingress body is capped at a megabyte, and a call may spend all of it on argument
 * *keys* — which are the caller's own strings and are recorded whether or not their values
 * are. Without this, one tool call writes a megabyte-long line, and an audit log an
 * attacker can flood is an audit log they can bury a line in.
 */
const MAX_ARGS = 32;

/**
 * How many items of a **declared** list one line names.
 *
 * A declared list is the one place a bound on each thing does not bound the whole thing:
 * its length is the caller's too. Well above any real label set, so a real call is never
 * shortened — and `<n items>` says so when one is.
 */
const MAX_ITEMS = 8;

/**
 * Runs one tool call and records it, however it ends.
 *
 * Both chokepoints go through this rather than each timing and classifying its own call:
 * two implementations of "what counts as a refusal" is the shape that lets one of them
 * quietly stop recording. The error is re-thrown untouched — this observes, it never
 * decides.
 */
export async function auditToolCall<T>(call: ToolCall, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    write(call, "ok", Date.now() - started);
    return result;
  } catch (error) {
    const refused = error instanceof ToolRefused;
    write(
      call,
      refused ? "refused" : "failed",
      Date.now() - started,
      error instanceof Error ? error.message : undefined,
    );
    throw error;
  }
}

/**
 * The line itself, in the key=value shape `ox_failed` and `egress_blocked` already use, so
 * one grep serves all three.
 *
 * **Every field on this line that the caller can reach is JSON-quoted**, for the reason
 * `ox_failed`'s `detail` is: a `"` in it would otherwise close the field and let the rest
 * read as fields of its own, and a newline would end the record and write a second one.
 * A forged `outcome=ok` sends an operator past the call they went looking for — which is
 * the one thing an audit log must not do.
 *
 * `tool` is one of those fields, and it is easy to read as if it were not: it is built by
 * `qualifyTool`, which prefixes a *server* name we chose onto a *tool* name the brain sent,
 * and prefixing is not validating. `outcome` and `ms` are ours and are bare. `args` is a
 * JSON object and goes last, since its keys are the only part not known in advance.
 */
function write(call: ToolCall, outcome: ToolCallOutcome, ms: number, reason?: string): void {
  const said = reason ? ` reason=${JSON.stringify(collapse(reason))}` : "";
  const line =
    `tool_call tool=${JSON.stringify(boundName(call.tool))} outcome=${outcome} ms=${ms}${said}` +
    ` args=${JSON.stringify(auditArgs(call.args, call.declared ?? []))}`;

  // A refusal and a failure are both things an operator went looking for; an allowed call
  // is the ordinary case, and sits at the same level as `turn_start`.
  if (outcome === "ok") console.info(line);
  else console.warn(line);
}

/**
 * What of an argument list is recorded: **declared values, and shapes for everything else.**
 *
 * Recording every argument by default makes this log a secret store the day a server takes
 * a credential as one, and a transcript of what people asked the agent the moment one takes
 * free text — `team_search`'s query is the caller's own words. Recording nothing leaves
 * "which repository did it open that pull request against" unanswerable, which is the
 * question a write-capable tool raises.
 *
 * So each tool names the arguments whose values may be written down, one at a time rather
 * than by category. Undeclared is the default, and an undeclared argument is recorded as a
 * **type and a size** — enough to see that a body was passed and how big it was, never what
 * it said.
 *
 * Two consequences worth stating rather than leaving to be discovered:
 *
 *  - **A server the broker runs declares only the bound values that matched.** Its tools
 *    come from a manifest entry and a third-party process, so nothing here knows what most
 *    of its arguments hold, and the safe reading of "unknown" is "not safe". The exception
 *    is a `mcpServers[].scope` argument **whose value is one on the operator's list** —
 *    that string was written down by a human, so it cannot be a credential or a sentence.
 *    The declaration follows the value and not the name, because what arrives under a bound
 *    name is still the caller's: a value the allowlist rejects is arbitrary text, and
 *    declaring the name would write it here on the way to refusing it.
 *  - **A declaration only reaches a scalar or a list of them** — a repository, a branch, a
 *    slug, a channel. Declare a nested object and the declaration is *not* honoured: see
 *    `bound`, which falls back to a shape rather than write out something whose contents
 *    nobody read.
 */
export function auditArgs(
  args: Record<string, unknown> | undefined,
  declared: readonly string[],
): Record<string, unknown> {
  const entries = Object.entries(args ?? {});
  const out: Record<string, unknown> = {};
  for (const [name, value] of entries.slice(0, MAX_ARGS)) {
    // Matched on the name the caller sent, written under the name that fits. A declaration
    // names a real argument, so a name too long to be one cannot be honoured by accident.
    out[boundName(name)] = declared.includes(name) ? bound(value) : shapeOf(value);
  }

  // A shortened list must never read as the whole call. Still compared by count rather
  // than against `MAX_ARGS`: `boundName` is what keeps two long names from becoming one
  // key, and a count that is derived rather than assumed does not depend on it staying so.
  if (Object.keys(out).length < entries.length) out["…"] = `<${entries.length} arguments>`;
  return out;
}

/**
 * A value with its content removed: what type it was and how much of it there was.
 *
 * The size is the useful half — `"<string 4>"` beside a `body` argument says the brain
 * passed something too short to be the pull request description it claimed to write, and
 * that is visible without the log holding a word of it.
 */
function shapeOf(value: unknown): string {
  if (value === null || value === undefined) return "<none>";
  if (typeof value === "string") return `<string ${value.length}>`;
  if (Array.isArray(value)) return `<array ${value.length}>`;
  if (typeof value === "object") return `<object ${Object.keys(value).length}>`;
  return `<${typeof value}>`;
}

/**
 * A declared value — but only when it is the kind of thing a declaration can promise, and
 * only as much of it as this line can afford.
 *
 * A declaration is read once, about an argument *name*, and what arrives under that name is
 * whatever the caller sent. A nested object is not something a declaration can vouch for —
 * the next person to add a field to one would put it on this line without knowing they had —
 * so it falls back to its shape: the declaration goes unhonoured rather than honoured wrongly.
 *
 * **A list needs a count bound and not only a per-item one.** A declared argument may arrive
 * as a list — a set of labels, a set of slugs — so a caller that sends five thousand of them
 * writes five thousand of them here, every item individually short and the record a megabyte
 * long. Bounding each item bounds nothing; the length of the list is the caller's too. Eight
 * is well above any real one, so a real call is never shortened, and the ceiling this leaves
 * is roughly `MAX_ARGS × MAX_ITEMS × MAX_VALUE` — kilobytes, not megabytes.
 */
function bound(value: unknown): unknown {
  if (typeof value === "string") return clip(value, MAX_VALUE);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const kept = value.slice(0, MAX_ITEMS).map((item: string) => clip(item, MAX_VALUE));
    // The same rule the argument list follows: a shortened list must never read as the
    // whole one, so the real count goes on the end rather than being left to be inferred.
    return value.length > MAX_ITEMS ? [...kept, `<${value.length} items>`] : kept;
  }
  return shapeOf(value);
}

/**
 * A name, bounded — and still one name rather than a prefix two names share.
 *
 * Cutting a name to a fixed length makes two long ones that begin alike record identically,
 * and an audit record that cannot say which tool ran has failed at the only thing it does.
 * The obvious objection is that no tool here has a name that long — but tool names come from
 * MCP servers an operator adds, which publish whatever names they publish, so "no real tool
 * is like that" is a fact about today's bundles rather than a property of the format. The
 * digest makes it a property of the format.
 *
 * Only ever computed for a name that was actually cut, which no working call produces.
 */
function boundName(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, DIGEST);
  // `…` first, so a cut name still reads as cut, then what tells two of them apart.
  return `${name.slice(0, MAX_NAME)}…${digest}`;
}

/** Collapsed and bounded so the line stays readable, as `ox_failed` treats its own detail. */
const collapse = (text: string): string => clip(text.replace(/\s+/g, " ").trim(), MAX_REASON);

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
