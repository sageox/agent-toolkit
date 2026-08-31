import { serveMcp, type HostedMcp, type ServeOptions } from "./mcp-http.ts";
import type { McpBroker } from "./mcp-broker.ts";

/**
 * Publishes one broker-managed MCP server to the brain over HTTP.
 *
 * The broker already holds the credential, enforces per-tool policy on `tools/call`, and
 * pins tool schemas on first sight. This is only the transport the brain can reach —
 * `claude-agent-acp` speaks `http` and `sse` — and nothing more; every guarantee still
 * comes from the broker.
 *
 * One listener per server, each with its own token, so a leaked token reaches one server
 * rather than every server the agent can use.
 */
export function serveBrokerServer(
  broker: McpBroker,
  name: string,
  opts: ServeOptions = {},
): Promise<HostedMcp> {
  // The child is spawned on first use, not at startup: a server nobody asks for should
  // not cost a process. Held as a promise so concurrent first calls share one connection
  // instead of racing into two.
  let connecting: Promise<string> | undefined;
  const connection = () => (connecting ??= broker.connect(name));

  return serveMcp(async (msg) => {
    const id = await connection();
    const result = await broker.message(id, msg.method ?? "", msg.params);
    return (result ?? {}) as Record<string, unknown>;
  }, opts).then((hosted) => ({
    ...hosted,
    close: async () => {
      await hosted.close();
      // Only tear down a connection that was actually opened, and let a failed teardown
      // stop the socket from closing.
      if (connecting) {
        const id = await connecting.catch(() => undefined);
        if (id) await broker.disconnect(id).catch(() => {});
      }
    },
  }));
}
