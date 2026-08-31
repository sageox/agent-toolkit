import { Vault } from "./vault.ts";
import {
  mcpToolServer,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type McpRequest,
  type ServeOptions,
} from "./mcp-http.ts";

/**
 * An MCP server over a markdown vault — the `local` and `shared` brains.
 *
 * Tool names match the reference `brain-notes` server so a policy, a persona, or an
 * agent's habits transfer between the two implementations unchanged; the command is
 * configurable precisely so either can be dropped in.
 *
 * Speaks newline-delimited JSON-RPC on stdin/stdout, the standard shape for an MCP
 * server run as a stdio child.
 */
export const BRAIN_TOOLS = [
  {
    name: "brain_list",
    description:
      "List what is in your brain — file names only, no contents. The cheap first look before reading.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_read",
    description:
      "Read your brain. With a query, returns matching notes; without one, everything. Says so explicitly when nothing matches.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What you are looking for" } },
    },
  },
  {
    name: "brain_write",
    description:
      "Append one fact to your brain with its source. Write before the turn ends — anything not written down is lost when the turn stops.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Vault file, e.g. 'deploys.md'; use a configured '.md.age' file for encrypted facts",
        },
        markdown: { type: "string", description: "The single fact to record" },
        src: { type: "string", description: "Where it came from" },
      },
      required: ["file", "markdown", "src"],
    },
  },
  {
    name: "brain_consolidate",
    description:
      "Report near-duplicate facts in this brain for review. Report only: it never deletes or rewrites notes.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/** The vault's JSON-RPC handler. Exported so the behaviour is testable without a process. */
export function brainServerHandler(vault: Vault): McpHandler {
  return mcpToolServer({
    name: "brain",
    tools: () => BRAIN_TOOLS,
    // Which note was written and where it came from — not `markdown`, which is the note
    // itself, and not `brain_read`'s query, which is the caller's own words. See
    // `tool-audit.ts` for what a declaration promises.
    audit: { brain_write: ["file", "src"] },
    call: (name, args) => callTool(vault, name, args as Record<string, string>),
  });
}

/** Hosts a credential-bearing vault inside the gateway rather than an ACP stdio child. */
export function serveVaultBrain(vault: Vault, opts: ServeOptions = {}): Promise<HostedMcp> {
  return serveMcp(brainServerHandler(vault), opts);
}

function callTool(vault: Vault, name: string, args: Record<string, string>): string {
  switch (name) {
    case "brain_list": {
      const files = vault.list();
      return files.length ? files.join("\n") : "The brain is empty.";
    }
    case "brain_read":
      return vault.read(args.query);
    case "brain_write":
      return `wrote to ${vault.write(args.file, args.markdown, args.src)}`;
    case "brain_consolidate":
      return vault.consolidate();
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Runs the server against stdin/stdout until the stream closes. */
export function runBrainServer(vaultRoot: string): void {
  const handle = brainServerHandler(new Vault(vaultRoot));
  let buffer = "";
  // One request at a time, replies in frame order — a reader that sent two frames gets
  // its answers the way a single stdio child has always answered them.
  let pending: Promise<void> = Promise.resolve();

  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let msg: McpRequest;
      try {
        msg = JSON.parse(line) as McpRequest;
      } catch {
        continue; // a malformed frame is not worth killing the brain over
      }

      if (typeof msg.id !== "number") continue;
      pending = pending.then(async () => {
        try {
          const result = await handle(msg);
          if (result !== undefined) reply({ jsonrpc: "2.0", id: msg.id, result });
        } catch (error) {
          reply({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: error instanceof Error ? error.message : "brain error" },
          });
        }
      });
    }
  });
}

function reply(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
