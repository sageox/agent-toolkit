// Puts one case in front of the REAL decision path and reports which gate answered.
//
// WHY THIS SHAPE. `loadToolPolicy` and `McpBroker.message` are the two halves of what the
// gateway actually decides, and they are both in-process, so a case costs nothing to run.
// The harness therefore drives them directly rather than reimplementing the rules: a
// second copy of `matches()` here would agree with itself forever while the shipped one
// drifted, which is the failure this whole directory exists to prevent.
//
// WHAT IT MEASURES. Not "did the call throw" — WHICH GATE refused, and whether the call
// reached the server. A case that expects a bound refusal and gets a policy refusal passes
// for the wrong reason and would keep passing on a build with no bound check left in it.
// Distinct causes get distinct words.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpBroker,
  type McpConnection,
  type McpServerConfig,
  type McpTransport,
} from "../../src/mcp-broker.ts";
import { McpServerSchema, resolveMcpServer, GuardSchema } from "../../src/manifest.ts";
import { loadToolPolicy } from "../../src/tool-policy.ts";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * What the boundary decided.
 *
 * Seven words for seven causes, and the two that look alike are the load-bearing pair:
 * `Denied` is a deny rule that fired, `Unlisted` is an allow rule that matched nothing.
 * Collapsing them into one "refused" would make an inert rule indistinguishable from a
 * deliberate refusal — which is exactly the defect sections A and B are about, so the
 * vocabulary has to be able to say the difference out loud.
 *
 * `Broken` is the same idea as the fleet guard's exit-code lesson, where "not the blocked
 * code" was read as "allowed" and a guard that crashed before inspecting a single flag
 * passed its own tests. Anything outside the explicit set is `Broken`, carries the
 * boundary's own words, and fails the suite.
 */
export const VERDICTS = [
  /** Every gate passed and the call reached the server. */
  "Allowed",
  /** A deny rule matched the tool name. */
  "Denied",
  /** No allow rule matched the tool name. */
  "Unlisted",
  /** A bound argument was missing, or carried a value outside `scope`. */
  "OutOfBounds",
  /** Something the call would send matched a declared leak pattern. */
  "Leaked",
  /** The configuration never loaded, so there was never a boundary to reach. */
  "Rejected",
  /** None of the above. Never an expected verdict. */
  "Broken",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** One `tools/call` that got past every gate and reached the server process. */
export interface ServerRequest {
  method: string;
  tool: string;
}

export interface Outcome {
  readonly verdict: Verdict;
  /** Every request the call made. Empty on every refusal — see `runPolicyCase`. */
  readonly requests: readonly ServerRequest[];
  /** The boundary's own words, so a `Broken` verdict can be read rather than guessed. */
  readonly detail?: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Which gate produced a refusal, read from the words it refused in.
 *
 * Matching on the message is a deliberate bargain: it couples this file to the wording of
 * four `throw`s, so rewording one turns its rows `Broken` and fails the suite loudly. That
 * is the correct failure — those sentences are the boundary's interface to an operator
 * reading a log, and changing one is a change worth a test noticing. The alternative,
 * classifying by "something threw", is what lets a case pass for the wrong reason.
 */
export function classifyRefusal(error: unknown): Verdict {
  const text = message(error);
  if (/ is denied by policy/.test(text)) return "Denied";
  if (/ is not allowlisted/.test(text)) return "Unlisted";
  if (/ this server is bound to /.test(text)) return "OutOfBounds";
  if (/ refused by leakPatterns:/.test(text)) return "Leaked";
  return "Broken";
}

/** Records what reached the server, and answers everything without a network. */
class RecordingConnection implements McpConnection {
  constructor(private readonly requests: ServerRequest[]) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    const call = params as { name?: string } | undefined;
    this.requests.push({ method, tool: call?.name ?? "" });
    // An empty result is the one body every tool can render, so no case has to carry a
    // canned server response to ask a question about the policy.
    return { content: [] };
  }
  async close(): Promise<void> {}
}

/**
 * Runs one case against the loader and the broker.
 *
 * THE INVARIANT: `Allowed` requires POSITIVE EVIDENCE. A call is allowed when a request
 * reached the server, not when nothing threw — a broker that answered without relaying
 * would look identical to an allow while proving that no gate was passed, so that shape is
 * `Broken` rather than folded into its cheerful neighbour.
 *
 * The converse is asserted by the driver: a refusal must have relayed nothing. A boundary
 * that reaches the server and then says no has already handed the credential's authority to
 * a call the policy refuses, and the refusal is theatre.
 */
export async function runPolicyCase(
  fixture: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const raw = readFileSync(join(FIXTURES, fixture), "utf8");
  const requests: ServerRequest[] = [];
  const transport: McpTransport = {
    async spawn(_config: McpServerConfig): Promise<McpConnection> {
      return new RecordingConnection(requests);
    },
  };

  let broker: McpBroker;
  let server: ReturnType<typeof resolveMcpServer>;
  try {
    const parsed = JSON.parse(raw) as { mcpServers: unknown[]; guard?: unknown };
    server = resolveMcpServer(McpServerSchema.parse(parsed.mcpServers[0]));
    broker = new McpBroker({
      servers: [server],
      policy: loadToolPolicy(raw),
      transport,
      // The fixtures declare a secretRef because a real server has one, and `connect`
      // refuses a server whose credential does not resolve. Supplied here rather than
      // dropped from the fixtures, so these rows run the real connect path — a case that
      // reached the gates through a shortcut would prove less than it appears to.
      secretOpts: { env: { GITHUB_TOKEN: "placeholder-not-a-token" } },
      leakPatterns: GuardSchema.parse(parsed.guard ?? {}).leakPatterns,
    });
  } catch (error) {
    return { verdict: "Rejected", requests, detail: message(error) };
  }

  try {
    const id = await broker.connect(server.name);
    await broker.message(id, "tools/call", { name: tool, arguments: args });
  } catch (error) {
    return { verdict: classifyRefusal(error), requests, detail: message(error) };
  }

  if (requests.length === 0) {
    return {
      verdict: "Broken",
      requests,
      detail: "the broker answered without relaying, so no gate was proven to pass",
    };
  }
  return { verdict: "Allowed", requests };
}
