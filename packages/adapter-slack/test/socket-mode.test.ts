import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SocketModeClient } from "@slack/socket-mode";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { SlackAdapter, SocketModeLogger, type SlackApiClient } from "../src/slack.ts";

/**
 * Enough of Slack for socket-mode to come up: `apps.connections.open` hands out the
 * socket URL, and each connection is answered with `hello`. It pings only when told to,
 * because the first ping from the server is what arms socket-mode's stale timer.
 *
 * The API call is answered by stubbing `fetch`, which `WebClient` captures when it is
 * constructed — so a client built after this, including the one `SlackAdapter` builds for
 * itself, lands here. Build the fake before the client.
 */
async function fakeSlack() {
  const sockets: ServerSocket[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "hello" }));
  });
  await once(wss, "listening");
  const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, url: wsUrl }), { status: 200 })),
  );

  return {
    wsUrl,
    sockets,
    /** Resolves once the pong is back, so the client has handled the ping frame. */
    async ping(socket: ServerSocket) {
      const pong = once(socket, "pong");
      socket.ping();
      await pong;
    },
    async close() {
      vi.unstubAllGlobals();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function captureWarnings() {
  const logged: unknown[][] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...line) => void logged.push(line));
  return { logged, restore: () => spy.mockRestore() };
}

/** Connects the way nostr-tools does: Node's global `WebSocket`, a different copy of undici. */
async function relayConnection(url: string) {
  const relay = new WebSocket(url);
  await once(relay, "open");
  return relay;
}

describe("SocketModeLogger", () => {
  it("is what SlackAdapter hands SocketModeClient when no socket is injected", () => {
    const adapter = new SlackAdapter({ botToken: "xoxb-test", appToken: "xapp-test", channels: [] });
    const { socket } = adapter as unknown as { socket: { logger: unknown } };
    expect(socket.logger).toBeInstanceOf(SocketModeLogger);
  });

  it("drops the warning about pings on sockets that are not Slack's, and nothing else", async () => {
    const warnings = captureWarnings();
    const slack = await fakeSlack();
    try {
      const client = new SocketModeClient({
        appToken: "xapp-test",
        logger: new SocketModeLogger(),
        autoReconnectEnabled: false,
        serverPingTimeout: 50,
      });
      await client.start();

      // The relay's socket publishes to the same diagnostics channel socket-mode watches,
      // from the copy of undici it checks `instanceof` against and fails.
      const relay = await relayConnection(slack.wsUrl);
      await slack.ping(slack.sockets[1]);
      expect(warnings.logged).toEqual([]);

      // Slack's own ping arms the stale timer. Letting it lapse is the warning that says
      // the connection was recycled, and it still comes through under socket-mode's name.
      const disconnected = new Promise((resolve) => client.once("disconnected", resolve));
      await slack.ping(slack.sockets[0]);
      await disconnected;
      expect(warnings.logged).toEqual([
        ["[WARN] ", "socket-mode", "A ping wasn't received from the server before the timeout of 50ms!"],
      ]);
      relay.close();
    } finally {
      await slack.close();
      warnings.restore();
    }
  });

  it("holds through the client SlackAdapter builds for itself", async () => {
    const warnings = captureWarnings();
    const slack = await fakeSlack();
    const api = { authTest: async () => ({ userId: "UBOT" }) } as unknown as SlackApiClient;
    const adapter = new SlackAdapter({ botToken: "xoxb-test", appToken: "xapp-test", channels: [], api });
    try {
      await adapter.start(() => {});
      const relay = await relayConnection(slack.wsUrl);
      await slack.ping(slack.sockets[1]);
      expect(warnings.logged).toEqual([]);
      relay.close();
    } finally {
      await adapter.stop();
      await slack.close();
      warnings.restore();
    }
  });
});
