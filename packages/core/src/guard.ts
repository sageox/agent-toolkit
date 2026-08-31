import type { GuardedMessage, ChannelRef } from "./events.ts";
import type { GuardConfig, LeakPattern } from "./manifest.ts";

/**
 * `reason` is replayed to the brain unfenced, so every word of it comes from this file or
 * from the manifest — never from the message, the channel id, or any other
 * adapter-asserted field. Those are untrusted, and echoing one would carry an injection
 * past the untrusted-input fence. Identifiers belong in the audit log, which the brain
 * never reads. A test in `guard.test.ts` enforces this.
 *
 * `leakPatterns` is the one rule whose reason varies, and it varies over the operator's own
 * pattern names — the same bundle the persona and the rule names come from. What it never
 * carries is the text that matched, because quoting that would be the leak.
 */
export type GuardVerdict = { ok: true } | { ok: false; rule: string; reason: string };

/**
 * Reads text against the operator's declared patterns, and says only their names.
 *
 * Lives here rather than inside `evaluateEgress` because it has a second caller: the broker
 * scans every argument of every MCP tool call on the way to a server (`mcp-broker.ts`). One
 * implementation, so the rule that a hit is reported by name and never by quotation holds on
 * both paths and cannot be re-derived differently on the next one.
 *
 * Takes several strings rather than one because a call publishes several fields, and joining
 * them first would let a pattern match across a boundary that does not exist.
 *
 * Every pattern, not the first to hit: a brain that fixes one and re-sends into the next
 * learns the same lesson twice, and an operator reading the log wants the whole list.
 */
export function scanForLeaks(
  texts: readonly string[],
  patterns: readonly LeakPattern[],
): GuardVerdict {
  const fired = patterns.filter((pattern) => texts.some((text) => pattern.regex.test(text)));
  if (!fired.length) return { ok: true };
  return {
    ok: false,
    rule: "leakPatterns",
    reason: `the text matched declared leak patterns: ${fired.map((p) => p.name).join(", ")}`,
  };
}

/**
 * Every string inside a value, however nested.
 *
 * A number or a boolean cannot carry a hostname, so the walk keeps only what a pattern could
 * match. Used to derive the scan target from the arguments themselves rather than from a
 * hand-kept list of field names that drifts the first time a field is added.
 */
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/**
 * The single egress chokepoint. Every outbound action — send, reply, edit — passes
 * through here, and every rule fails closed.
 *
 * Attachments and broadcasts need no rule here: `GuardedMessage` cannot represent
 * either, so the type refuses them structurally.
 */
export function evaluateEgress(
  msg: GuardedMessage,
  channel: ChannelRef,
  policy: GuardConfig,
): GuardVerdict {
  // Consent is per destination because that is how it is given: approving the channel in
  // front of you is not approval of every public channel the agent can reach, now or later.
  // Surface-qualified because an id is unique only within one — a `C01234567` listed on
  // Slack must not also authorize a Buzz channel that happens to carry that id.
  //
  // There is no manifest-wide "public is fine" switch to check first. The only way to reach
  // a public channel is to list it `reply: public`, so this rule cannot be turned off in one
  // line — it can only be answered one channel at a time.
  if (channel.isPublic && !policy.publicChannels.includes(`${channel.surface}:${channel.id}`))
    return { ok: false, rule: "publicChannel", reason: "the target channel is public" };

  // The one rule that reads what a message says, and it reads it only on the way somewhere
  // public — a destination the rule above made the operator list one at a time. Scanning
  // a private reply too would spend operator-authored regexes on *every* outbound message,
  // which is the exposure `1e442f8` deleted this rule over; the patterns are refused at
  // load if they can backtrack catastrophically, and here they run on a path that is
  // narrow by construction.
  if (channel.isPublic) {
    const verdict = scanForLeaks([msg.text], policy.leakPatterns);
    if (!verdict.ok) return verdict;
  }

  return { ok: true };
}
