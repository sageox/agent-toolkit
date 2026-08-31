import { spawn, type ChildProcess } from "node:child_process";
import type { McpConnection, McpServerConfig, McpTransport } from "./mcp-broker.ts";

/**
 * Runs an MCP server as a stdio child process and relays JSON-RPC to it.
 *
 * Deliberately a dumb pipe: the brain drives the MCP conversation end to end —
 * `initialize`, `tools/list`, `tools/call` — and the broker's job is to carry those
 * frames and apply policy, not to speak MCP itself. Anything this layer interpreted
 * would be a second, divergent implementation of the protocol.
 *
 * The credential lives here and nowhere else: the server is spawned with the resolved
 * secret in its environment, inside the gateway's process tree, so the brain gets tools
 * and never a token.
 */
export const stdioTransport: McpTransport = {
  async spawn(config: McpServerConfig, env: NodeJS.ProcessEnv): Promise<McpConnection> {
    const child = spawn(config.command, config.args, {
      // stderr is inherited so a server that fails to start says so in our log rather
      // than dying mutely behind a pipe nobody reads.
      stdio: ["pipe", "pipe", "inherit"],
      env,
    });

    return new StdioConnection(config.name, child);
  },
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * How long one `tools/call` waits.
 *
 * `failAll` covers a server that dies — exit and error both reject every caller. What it
 * cannot see is a server that is **alive and never answers**: the frame was accepted, the
 * process is healthy, and the promise stays pending forever. That holds the turn until
 * `limits.turnTimeoutMs` fires and releases the channel, with nothing said about which
 * server did it.
 *
 * Set below that budget (120s by default) rather than near it, because a bound that expires
 * after the turn does is a bound that never fires: the turn timeout would answer first and
 * blame nothing. This one names the server.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * How long the handshake waits — `initialize` and `tools/list`.
 *
 * More generous, because these run at `mcp add`, `doctor` and gateway boot rather than
 * inside a turn, and the first of them can be paying for an `npx -y` cold install. Bounded
 * all the same: a setup command that hangs is worse than one that fails, since a human is
 * sitting in front of it either way.
 */
const STARTUP_TIMEOUT_MS = 120_000;

class StdioConnection implements McpConnection {
  private pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 0;
  private closed = false;

  constructor(
    private name: string,
    private child: ChildProcess,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    child.on("exit", (code) => this.failAll(`MCP server ${this.name} exited (code ${code})`));
    child.on("error", (error) => this.failAll(`MCP server ${this.name} failed: ${error.message}`));
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error(`MCP server ${this.name} is closed`);

    const id = ++this.nextId;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    const budget = method === "tools/call" ? CALL_TIMEOUT_MS : STARTUP_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      // Cleared on every exit from this request, so a settled call cannot be rejected later
      // by its own timer and a slow-but-answering server leaves nothing running.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP server ${this.name} did not answer ${method} within ${budget / 1000}s — ` +
              "the server is still running, so this is a hang rather than a crash",
          ),
        );
      }, budget);
      // Node keeps the process alive for a pending timer; a gateway shutting down should not
      // wait on one that exists only to bound somebody else.
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin?.write(frame + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP server ${this.name}: ${error.message}`));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(`MCP server ${this.name} closed`);
    this.child.kill();
  }

  /** Newline-delimited JSON: a frame may arrive split, or several may arrive together. */
  private onData(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onFrame(line);
    }
  }

  private onFrame(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      // A server that prints non-JSON to stdout (a banner, a warning) would otherwise
      // take down every in-flight call. Ignore it; stderr is where that belongs.
      return;
    }

    if (typeof msg.id !== "number") return; // a notification: nothing is waiting on it
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);

    if (msg.error) waiting.reject(new Error(msg.error.message ?? "MCP server returned an error"));
    else waiting.resolve(msg.result);
  }

  /** A dead server must reject its callers, not leave them hanging forever. */
  private failAll(reason: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error(reason));
  }
}
