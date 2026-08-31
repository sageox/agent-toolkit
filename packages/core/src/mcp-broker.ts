import { createHash } from "node:crypto";
import { resolveSecret } from "./secrets.ts";
import { passthroughEnv } from "./brain-env.ts";
import { scanForLeaks, strings } from "./guard.ts";
import type { LeakPattern } from "./manifest.ts";
import { auditToolCall, ToolRefused } from "./tool-audit.ts";
import { qualifyTool, type ToolPolicy } from "./tool-policy.ts";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  /**
   * Plain configuration for the server process — a vault path, a mode, a base URL.
   *
   * Separate from `secrets` on purpose: these are not credentials, they need no
   * resolution, and a missing one is a config error rather than a security failure. A
   * real server needs both (`BRAIN_VAULT_ROOT` beside `BRAIN_AGE_KEY_FILE`), and folding
   * them together would either resolve non-secrets through the secret store or smuggle
   * credentials in as plain config.
   */
  env?: Record<string, string>;
  /** Env var name → `secretRef` name. Resolved in the gateway, never sent to the brain. */
  secrets: Record<string, string>;
  /**
   * Argument name → the values allowed under it. Every `tools/call` must carry each name
   * with a listed value, or it is refused. See `McpServerSchema.scope` for why absent is
   * refused rather than allowed.
   */
  scope?: Record<string, string[]>;
}

export interface McpConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * How much of a tool result is read into a turn.
 *
 * Bounded here rather than by whatever the server happens to hold. A single diff, table dump
 * or log tail can be megabytes; a context window cannot, and the server deciding is the
 * server deciding how much of the agent's turn to spend. `MAX_BODY` in `mcp-http.ts` bounds
 * the brain's request *inbound* — this is the other direction, which nothing bounded.
 */
const MAX_RESULT = 20_000;

/**
 * A tool result, cut to fit — and **saying that it was cut**.
 *
 * The silent half is the dangerous one: an answer that stopped early reads exactly like a
 * complete one, and an agent whose job is producing a verdict will report what it happened
 * to see as the result. So the note is part of the content the brain reads, in the same
 * words the rest of this toolkit bounds things with, rather than a truncation nobody
 * mentions.
 *
 * Only `text` blocks are cut. An image or a resource block is not something a prefix of is
 * meaningful, so those pass through and are not charged against the budget.
 */
function clipResult(result: unknown): unknown {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return result;

  let budget = MAX_RESULT;
  let dropped = 0;
  const kept = content.map((block) => {
    const text = (block as { type?: string; text?: string } | null)?.text;
    if ((block as { type?: string } | null)?.type !== "text" || typeof text !== "string") {
      return block;
    }
    if (text.length <= budget) {
      budget -= text.length;
      return block;
    }
    dropped += text.length - budget;
    const cut = { ...(block as object), text: text.slice(0, budget) };
    budget = 0;
    return cut;
  });

  if (!dropped) return result;
  return {
    ...(result as object),
    content: [
      ...kept,
      {
        type: "text",
        text:
          `… ${dropped} further characters were not read — this is not the whole result. ` +
          "Narrow the request rather than treating this as complete.",
      },
    ],
  };
}

/** How a server is actually started. Injectable so tests need no subprocess. */
export interface McpTransport {
  spawn(config: McpServerConfig, env: NodeJS.ProcessEnv): Promise<McpConnection>;
}

export interface McpBrokerOptions {
  servers: McpServerConfig[];
  policy: ToolPolicy;
  transport: McpTransport;
  secretOpts?: { dir?: string; env?: NodeJS.ProcessEnv };
  /**
   * The operator's declared leak patterns, run over every tool call's arguments.
   *
   * The same patterns the chat chokepoint runs. An MCP server is the other way out of this
   * agent: a token pasted into a pull request body, an issue title, or a search query has
   * left the building whether or not the tool that carried it was called a write.
   */
  leakPatterns?: readonly LeakPattern[];
  /** Called when a pinned tool's schema changes — a rug-pull is reported, not passed on. */
  onSchemaChange?: (tool: string, server: string) => void;
}

/**
 * Holds MCP credentials on the gateway's side of the boundary.
 *
 * The brain reaches a server only by asking the broker to relay, so the broker is the
 * one place every MCP call passes through — which is why per-tool policy and schema
 * pinning live here and cannot be bypassed.
 *
 * ACP's own `McpServerStdio` config carries the server env and is delivered to the
 * *agent*, which would put every token in the brain zone. This broker exists so the
 * brain instead gets a URL and a capability token (see `serveBrokerServer`), while the
 * server process and its credential run here.
 */
export class McpBroker {
  private connections = new Map<string, { server: McpServerConfig; conn: McpConnection }>();
  private pinnedSchemas = new Map<string, string>();
  private nextId = 0;

  constructor(private opts: McpBrokerOptions) {}

  async connect(serverId: string): Promise<string> {
    const server = this.opts.servers.find((s) => s.name === serverId);
    if (!server) throw new Error(`unknown MCP server ${serverId}`);

    // A server is still a process: it needs PATH to be found at all. Everything beyond
    // that minimum is dropped, so the gateway's own environment stays out of reach.
    // Plain config next; a secret with the same name wins, so a credential can never be
    // silently downgraded to a hardcoded value.
    const env: NodeJS.ProcessEnv = { ...passthroughEnv(process.env), ...server.env };
    for (const [envVar, ref] of Object.entries(server.secrets)) {
      const value = resolveSecret(ref, this.opts.secretOpts ?? {});
      // Starting a server without its credential produces confusing auth failures at
      // call time; refusing here names the missing ref instead.
      if (!value) throw new Error(`MCP server ${serverId}: secretRef ${ref} did not resolve`);
      env[envVar] = value;
    }

    const conn = await this.opts.transport.spawn(server, env);
    const connectionId = `mcp-${++this.nextId}`;
    this.connections.set(connectionId, { server, conn });
    return connectionId;
  }

  async message(connectionId: string, method: string, params?: unknown): Promise<unknown> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`unknown MCP connection ${connectionId}`);

    if (method !== "tools/call") {
      const result = await entry.conn.request(method, params);
      return method === "tools/list" ? this.pinTools(result, entry.server.name) : result;
    }

    // A server knows its tools by their bare names; the policy — like the brain's own
    // permission requests — names them `mcp__<server>__<tool>`. Qualifying here is what
    // makes one policy line govern both the brain asking and the broker relaying.
    const call = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const tool = qualifyTool(entry.server.name, call?.name ?? "");
    const args = call?.arguments;
    const scope = entry.server.scope ?? {};

    // A bound argument is recorded by value **only when its value is one the operator wrote
    // down**. That is the whole of what makes writing it safe: a broker server is a
    // third-party process named in a manifest, so nothing here knows what its arguments
    // hold, and the audit keeps shapes for all of them.
    //
    // Matching on the value rather than the name is the load-bearing part. Declaring the
    // name alone would record whatever arrived under it, and what arrives is the brain's —
    // so a secret sent as an out-of-scope `repo` would be written verbatim by the refusal
    // that rejected it, before the leak scan below ever ran. A value the allowlist does not
    // contain is arbitrary caller text and is recorded as a shape, exactly like every other
    // undeclared argument. The refusal still names the server, the argument, and the bound
    // it violated; what it does not do is quote the thing it refused.
    const declared = Object.entries(scope)
      .filter(([name, allowed]) => allowed.includes(args?.[name] as string))
      .map(([name]) => name);

    return auditToolCall({ tool, args, declared }, async () => {
      const verdict = this.opts.policy.allowsTool(tool);
      // Thrown as a refusal rather than a plain failure so the audit can tell the two
      // apart: a call the policy stopped is the line an operator goes looking for.
      if (!verdict.ok) throw new ToolRefused(`MCP call refused: ${verdict.reason}`);

      // Bounded. Absent is refused, not waved through — a server's unscoped tools are
      // precisely the ones that reach past the bound, so "no such argument" must never be
      // the cheap way around it.
      for (const [name, allowed] of Object.entries(scope)) {
        const value = args?.[name];
        if (typeof value !== "string" || !allowed.includes(value)) {
          throw new ToolRefused(
            `${tool} refused: this server is bound to ${name} ∈ {${allowed.join(", ")}}, ` +
              `written exactly that way, and this call ` +
              `${value === undefined ? `named no ${name}` : `named one outside it`}`,
          );
        }
      }

      // Scanned. Every argument, not a declared subset: what a third-party server does with
      // a field is its own business, so the only honest reading is that anything sent may be
      // published. Over-scanning costs a false refusal, which fails closed; a per-tool list
      // of "the ones that publish" fails open the first time somebody forgets one.
      const leak = scanForLeaks(strings(args), this.opts.leakPatterns ?? []);
      if (!leak.ok) throw new ToolRefused(`${tool} refused by ${leak.rule}: ${leak.reason}`);

      return clipResult(await entry.conn.request(method, params));
    });
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    this.connections.delete(connectionId);
    await entry.conn.close();
  }

  async stop(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.disconnect(id);
  }

  /**
   * Trust on first use: a tool's shape is pinned the first time we see it, and a later
   * change is held. The read-vs-write classification the allowlist depends on comes from
   * the server's self-report, so a server that quietly adds a side effect must not be
   * able to re-describe a tool the operator already approved.
   */
  private pinTools(result: unknown, server: string): unknown {
    const tools = (result as { tools?: Array<{ name: string }> } | undefined)?.tools;
    if (!Array.isArray(tools)) return result;

    const kept = tools.filter((tool) => {
      const key = `${server}:${tool.name}`;
      const hash = createHash("sha256").update(JSON.stringify(tool)).digest("hex");
      const pinned = this.pinnedSchemas.get(key);
      if (pinned === undefined) {
        this.pinnedSchemas.set(key, hash);
        return true;
      }
      if (pinned === hash) return true;
      this.opts.onSchemaChange?.(tool.name, server);
      return false;
    });

    return { ...(result as object), tools: kept };
  }
}
