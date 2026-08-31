import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { auditToolCall } from "./tool-audit.ts";
import { qualifyTool } from "./tool-policy.ts";

/**
 * Serves one MCP server over HTTP, from inside the gateway.
 *
 * A stdio MCP server is spawned by the agent, so its process — and every secret in its
 * environment — sits in the brain's zone. Hosting it here inverts that: the gateway holds
 * the credential and runs the server, and the brain receives a URL and a capability token.
 * It asks for a tool call; it never holds the means to make one itself.
 *
 * `claude-agent-acp` declares `mcpCapabilities: {http, sse}` and no `acp`, so HTTP is the
 * only transport that can carry a gateway-hosted server to this brain.
 */
export interface HostedMcp {
  /** What the brain connects to. */
  url: string;
  /** Bearer token the brain must present. Grants this one server, nothing else. */
  token: string;
  close: () => Promise<void>;
}

export interface ServeOptions {
  /**
   * Loopback by default. A deployment that runs the brain in a separate container sets
   * this to an address that container can route to — at which point the token is doing
   * real work rather than defence in depth.
   */
  host?: string;
  port?: number;
}

/** Handles one JSON-RPC request. Returning undefined means "no such method". */
export type McpHandler = (msg: McpRequest) => Promise<Record<string, unknown> | undefined>;

export interface McpRequest {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * The initialize / tools/list / tools/call skeleton every hosted tool server speaks.
 *
 * `call` runs one tool and returns the text of its result; an unknown tool is its to
 * throw on, with the server's own wording. Anything that is not one of the three methods
 * gets no reply, which is what JSON-RPC expects for a notification and is safer than
 * inventing an answer.
 */
export function mcpToolServer(opts: {
  /** serverInfo name. Matches the name the server is wired under, e.g. "brain". */
  name: string;
  /** A function because some servers compute the list per request. */
  tools: () => readonly unknown[];
  call: (tool: string, args: Record<string, unknown>) => string | Promise<string>;
  /**
   * Per tool, the argument names whose **values** the audit line may record. A tool with
   * no entry records every argument as a shape, which is the safe default — see
   * `tool-audit.ts` for what a declaration promises.
   */
  audit?: Record<string, readonly string[]>;
}): McpHandler {
  return async (msg) => {
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: opts.name, version: "1" },
        };
      case "tools/list":
        return { tools: opts.tools() };
      case "tools/call": {
        const tool = msg.params?.name as string;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        // Recorded here rather than inside each server's own `call`, so a surface added
        // later is audited by existing and cannot ship silent. This is the second of the
        // two `tools/call` chokepoints; `McpBroker.message` is the other.
        return auditToolCall(
          { tool: qualifyTool(opts.name, tool), args, declared: opts.audit?.[tool] },
          async () => ({ content: [{ type: "text", text: await opts.call(tool, args) }] }),
        );
      }
      default:
        return undefined;
    }
  };
}

const MAX_BODY = 1024 * 1024;

export async function serveMcp(handle: McpHandler, opts: ServeOptions = {}): Promise<HostedMcp> {
  const token = randomBytes(32).toString("base64url");
  const host = opts.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    void handleHttp(handle, token, req, res);
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener("error", fail);
      ok();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    url: `http://${host}:${port}/mcp`,
    token,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((ok) => {
    server.closeAllConnections?.();
    server.close(() => ok());
  });
}

/** Constant-time compare, so the token cannot be recovered by timing the 401. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Rejects cross-origin callers.
 *
 * A browser on this machine can POST to a loopback port; without this, any page the
 * operator visits could reach a server holding their credentials. MCP's HTTP transport
 * calls for Origin validation for exactly this reason. A non-browser client sends none.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

async function handleHttp(
  handle: McpHandler,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!originAllowed(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });

  const auth = req.headers.authorization;
  const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!tokenMatches(presented, token)) return send(res, 401, { error: "unauthorized" });

  if (req.method !== "POST") {
    // No server-initiated stream: these servers only answer what they are asked.
    return send(res, 405, { error: "use POST" });
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (error) {
    return send(res, 413, { error: (error as Error).message });
  }

  let msg: McpRequest;
  try {
    msg = JSON.parse(body) as McpRequest;
  } catch {
    return send(res, 200, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }

  // A notification has no id and expects no reply.
  if (typeof msg.id !== "number") {
    res.writeHead(202).end();
    return;
  }

  try {
    const result = await handle(msg);
    if (result === undefined) {
      return send(res, 200, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unknown method ${msg.method ?? ""}` },
      });
    }
    send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
  } catch (error) {
    // A failed tool call is an answer the brain can read and react to, not a dead socket.
    send(res, 200, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32000, message: error instanceof Error ? error.message : "server error" },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY) {
        req.destroy();
        fail(new Error("request too large"));
      }
    });
    req.on("end", () => ok(body));
    req.on("error", fail);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}
