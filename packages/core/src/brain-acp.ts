import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  CLIENT_METHODS,
  AGENT_METHODS,
  PROTOCOL_VERSION,
  type AgentApp,
  type ClientConnection,
  type McpServer,
  type SessionBuilder,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { Brain, BrainContext, BrainStep, GuardFeedback } from "./brain.ts";
import type { InboundEvent } from "./events.ts";
import { assembleTurnPrompt } from "./turn.ts";
import { brainEnv, type AcpProvider } from "./brain-env.ts";
import { withTimeout } from "./gateway.ts";
import type { ToolPolicy } from "./tool-policy.ts";

export type { McpServer } from "@agentclientprotocol/sdk";

/** Where the ACP agent lives: a transport stream, or an in-process app (tests). */
export type AcpTarget = Stream | AgentApp;

export interface AcpBrainOptions {
  /** Claude remains the default for existing callers. */
  provider?: AcpProvider;
  /** Defaults to spawning the brain subprocess. */
  target?: AcpTarget;
  /** The brain zone's only secret. Falls back to the ambient key. */
  apiKey?: string;
  /** Pins the model, from `brain.model`. Unset leaves the brain on its own default. */
  model?: string;
  cwd?: string;
  /** How many times a refused reply may be re-prompted before the turn gives up. */
  maxGuardRetries?: number;
  /** Claude's ACP tool permissions. Codex's HTTP endpoints enforce the same policy. */
  toolPolicy?: ToolPolicy;
  /**
   * Servers the brain can reach. Codex accepts only gateway-hosted HTTP endpoints;
   * Claude also accepts stdio servers that hold no credential.
   */
  mcpServers?: readonly McpServer[];
  /** How long a channel's conversation is kept before it is closed. */
  sessionIdleMs?: number;
  /**
   * `limits.turnTimeoutMs`, applied to the provider's MCP tool timeout. A `target`
   * handed in instead is not a process and carries no such bound.
   */
  turnTimeoutMs?: number;
}

/** Long enough to keep a conversation alive across a coffee break. */
const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;

const FALLBACK_COMMAND = "npx";
const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.68.0";
const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp@1.11.0";

/** How long the ACP handshake may take before we call it dead. */
const INITIALIZE_TIMEOUT_MS = 90_000;

/**
 * Prefers the installed binary over `npx`.
 *
 * Going through `npx` puts a package manager between the gateway and the brain: on a
 * cold cache it downloads while we are already waiting on the handshake, and it leaves
 * the real agent as a *grandchild*, so killing our child orphans it.
 */
function resolveBrainCommand(provider: AcpProvider): { command: string; args: string[] } {
  const binary = provider === "codex-acp" ? "codex-acp" : "claude-agent-acp";
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return { command: candidate, args: [] };
    } catch {
      /* keep looking */
    }
  }
  return {
    command: FALLBACK_COMMAND,
    args: ["-y", provider === "codex-acp" ? CODEX_ACP_PACKAGE : CLAUDE_AGENT_ACP_PACKAGE],
  };
}

interface ChannelSession {
  session: Awaited<ReturnType<SessionBuilder["start"]>>;
  lastUsed: number;
}

/**
 * Claude and Codex share one ACP session and guard-feedback implementation.
 *
 * The process is long-lived, with one session per channel. It yields intent and
 * never touches a transport — the gateway decides whether anything is sent,
 * and a refusal comes back into the same turn.
 */
export class AcpBrain implements Brain {
  private conn?: ClientConnection;
  private child?: ChildProcess;
  private canCloseSessions = false;
  private starting?: Promise<void>;
  private codexHome?: string;
  /**
   * One session per channel, not per turn.
   *
   * A session is where the conversation lives: reusing it is what lets the agent
   * remember what was just said, follow "and the other one?", and not reintroduce itself
   * every message. Channels stay separate so a conversation in one never leaks into
   * another, and idle ones are evicted so a long-running agent does not accumulate them.
   */
  private sessions = new Map<string, ChannelSession>();

  constructor(private opts: AcpBrainOptions = {}) {}

  async start(): Promise<void> {
    this.starting ??= this.doStart().catch(async (error) => {
      await this.stop();
      throw error;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.conn) return;
    const app = client({ name: "agent-gateway" });

    // The brain's own tools (shell, edit) are the third governed surface alongside egress
    // and MCP. With no policy configured nothing is allowlisted, so everything is
    // refused — an agent with no stated policy gets no reach, rather than full reach.
    app.onRequest(CLIENT_METHODS.session_request_permission, async (ctx) => {
      // `name` is the tool identifier the policy is written against; `title` is a
      // human-readable label ("Delete the repo") and would never match a rule.
      const toolName = ctx.params.toolCall.name ?? ctx.params.toolCall.title ?? "";
      // Codex's MCP approval omits the tool name. Let that attempt reach the gateway,
      // where the HTTP endpoint checks the actual tool before executing it. The adapter
      // marks MCP approvals explicitly; native permission escalation is always refused.
      const allowed = this.opts.provider === "codex-acp"
        ? ctx.params._meta?.is_mcp_tool_approval === true
        : this.opts.toolPolicy?.allowsTool(toolName).ok === true;

      if (allowed) {
        const allow = ctx.params.options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow_always",
        );
        if (allow) return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
      }

      const reject = ctx.params.options.find(
        (o) => o.kind === "reject_once" || o.kind === "reject_always",
      );
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    });

    const target = this.opts.target ?? this.spawnBrain();
    // Identical branches on purpose: connect() is overloaded per target type, so the
    // union has to be narrowed before either overload applies.
    this.conn = "readable" in target ? app.connect(target) : app.connect(target);

    // ACP requires initialize before any session, and it is also where we declare how
    // little reach this client offers: no filesystem, no terminal. The brain may talk,
    // not act — advertising the capability is what would let it act.
    // A handshake that never answers must fail loudly: without this the gateway sits
    // alive and silent, which reads as a working agent that ignores everyone.
    const init = await withTimeout(
      this.conn.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      INITIALIZE_TIMEOUT_MS,
      `the brain did not answer initialize within ${INITIALIZE_TIMEOUT_MS / 1000}s`,
    );
    if (
      this.opts.provider === "codex-acp" && !this.opts.target &&
      init.agentInfo?.name !== "@agentclientprotocol/codex-acp"
    ) {
      throw new Error(
        `Codex requires @agentclientprotocol/codex-acp; install it with \`npm install -g ${CODEX_ACP_PACKAGE}\``,
      );
    }
    this.canCloseSessions = init.agentCapabilities?.sessionCapabilities?.close != null;
  }

  async stop(): Promise<void> {
    for (const [key, entry] of this.sessions) {
      this.sessions.delete(key);
      await this.closeSession(entry);
    }
    this.conn?.close();
    this.conn = undefined;
    this.starting = undefined;
    const child = this.child;
    if (child?.pid && this.opts.provider === "codex-acp" && process.platform !== "win32") {
      // The adapter starts the Codex app server. Terminate their process group so
      // shutdown cannot leave a model process holding its key and MCP capabilities.
      const exited = child.exitCode === null && child.signalCode === null
        ? once(child, "exit").then(() => {}) : Promise.resolve();
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await withTimeout(exited, 5_000, "Codex did not exit").catch(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
      });
    } else child?.kill();
    this.child = undefined;
    if (this.codexHome) rmSync(this.codexHome, { recursive: true, force: true });
    this.codexHome = undefined;
  }

  async *runTurn(
    event: InboundEvent,
    ctx: BrainContext,
  ): AsyncGenerator<BrainStep, void, GuardFeedback | undefined> {
    // A turn may arrive before startup finishes — the gateway subscribes first on
    // purpose — so wait for readiness rather than rejecting the message.
    await this.start();
    if (!this.conn) throw new Error("the brain failed to start");

    const maxRetries = this.opts.maxGuardRetries ?? 2;
    // Sweep first: evicting after selecting would dispose the very session this turn is
    // about to use.
    this.evictIdleSessions();

    const key = `${event.surface}:${event.channel.id}`;
    const existing = this.sessions.get(key);
    const session = existing?.session ?? (await this.openSession());
    this.sessions.set(key, { session, lastUsed: Date.now() });

    try {
      // Steering goes in only on the first turn of a session; after that the agent has
      // it in context, and repeating it every message would waste tokens and read as
      // the agent being re-briefed mid-conversation.
      await session.prompt(assembleTurnPrompt(event, ctx, { steer: !existing }));
      let text = await readFinalText(session);

      for (let retries = 0; ; retries++) {
        if (!text.trim()) return;
        // Where the reply lands is the adapter's call — upstream keeps threads flat — so
        // the brain returns text and says nothing about threading.
        const feedback = yield { type: "reply", msg: { text } };
        if (!feedback) return; // sent
        if (retries >= maxRetries) return;

        await session.prompt(refusalPrompt(feedback));
        text = await readFinalText(session);
      }
    } finally {
      // The session stays open — it is this channel's memory. Closing happens on
      // eviction or shutdown.
    }
  }

  private async openSession() {
    let builder = this.conn!.agent.buildSession(this.codexHome ?? this.opts.cwd ?? process.cwd());
    for (const server of this.opts.mcpServers ?? []) {
      builder = builder.withMcpServer(server);
    }
    return builder.start();
  }

  /** Drops conversations nobody has touched for a while, so memory stays bounded. */
  private evictIdleSessions(): void {
    const ttl = this.opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    const cutoff = Date.now() - ttl;
    for (const [key, entry] of this.sessions) {
      if (entry.lastUsed > cutoff) continue;
      this.sessions.delete(key);
      void this.closeSession(entry);
    }
  }

  private async closeSession(entry: ChannelSession): Promise<void> {
    entry.session.dispose();
    if (!this.canCloseSessions || !this.conn) return;
    try {
      await this.conn.agent.request(AGENT_METHODS.session_close, {
        sessionId: entry.session.sessionId,
      });
    } catch {
      // A session we cannot close is a leak on the agent, not a failed turn.
    }
  }

  private spawnBrain(): Stream {
    const provider = this.opts.provider ?? "claude-acp";
    const resolved = resolveBrainCommand(provider);
    const env = brainEnv(process.env, {
      provider,
      apiKey: this.opts.apiKey,
      model: this.opts.model,
      turnTimeoutMs: this.opts.turnTimeoutMs,
    });
    if (provider === "codex-acp") {
      // No host login, user MCP configuration, repository instructions, or agent .env
      // enters Codex's working directory. Durable memory stays behind the gateway.
      this.codexHome = mkdtempSync(join(tmpdir(), "sageox-codex-"));
      env.HOME = this.codexHome;
      env.CODEX_HOME = join(this.codexHome, ".codex");
      mkdirSync(env.CODEX_HOME);
      const servers = (this.opts.mcpServers ?? []).map((server) => {
        if (!("type" in server) || server.type !== "http") {
          throw new Error("Codex MCP servers must be gateway-hosted HTTP endpoints");
        }
        return [
          `[mcp_servers.${JSON.stringify(server.name)}]`,
          `url = ${JSON.stringify(server.url)}`,
          `http_headers = { ${server.headers.map(({ name, value }) =>
            `${JSON.stringify(name)} = ${JSON.stringify(value)}`).join(", ")} }`,
          ...(this.opts.turnTimeoutMs
            ? [`tool_timeout_sec = ${this.opts.turnTimeoutMs / 1000}`] : []),
        ].join("\n");
      });
      writeFileSync(join(env.CODEX_HOME, "config.toml"), [
        'default_permissions = "brain"',
        '[permissions.brain.filesystem]',
        '":root" = "deny"',
        '[permissions.brain.network]',
        'enabled = false',
        ...servers,
        "",
      ].join("\n"), { mode: 0o600 });
    }
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "inherit"],
      detached: provider === "codex-acp" && process.platform !== "win32",
      env,
      cwd: this.codexHome ?? this.opts.cwd,
    });
    this.child = child;
    return ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
  }
}

/** Kept for callers that already construct the Claude brain directly. */
export { AcpBrain as ClaudeAcpBrain };

/** ACP's convenience reader joins progress and final text, producing contradictory replies. */
async function readFinalText(session: ChannelSession["session"]): Promise<string> {
  let text = "";
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === "stop") return text;
    const { update } = message;
    // ACP readText concatenates narration across tool calls. A new call supersedes
    // that narration; a late tool_call_update must not erase the final answer.
    if (update.sessionUpdate === "tool_call") text = "";
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      text += update.content.text;
    }
  }
}

/** The refusal the brain reads mid-turn — a reason to adapt to, not a dead end. */
function refusalPrompt(feedback: GuardFeedback): string {
  return [
    `The gateway REFUSED that reply. Rule: ${feedback.rule}. Reason: ${feedback.reason}.`,
    "It was not sent, and nobody saw it.",
    "",
    "Write a different reply that satisfies the rule. Do not argue with the refusal and",
    "do not try to route around it — you cannot send anything yourself.",
  ].join("\n");
}
