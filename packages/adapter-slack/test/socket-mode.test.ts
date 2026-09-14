import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SocketModeClient } from "@slack/socket-mode";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { SlackAdapter, SocketModeLogger } from "../src/slack.ts";

/**
 * Enough of Slack for socket-mode to come up: `apps.connections.open` hands out the
 * socket URL, and each connection is answered with `hello`. It pings only when told to,
 * because the first ping from the server is what arms socket-mode's stale timer.
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

  const http = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, url: wsUrl }));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const apiUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/`;

  return {
    apiUrl,
    wsUrl,
    sockets,
    /** Resolves once the pong is back, so the client has handled the ping frame. */
    async ping(socket: ServerSocket) {
      const pong = once(socket, "pong");
      socket.ping();
      await pong;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    },
  };
}

describe("SocketModeLogger", () => {
  it("is what SlackAdapter hands SocketModeClient when no socket is injected", () => {
    const adapter = new SlackAdapter({ botToken: "xoxb-test", appToken: "xapp-test", channels: [] });
    const { socket } = adapter as unknown as { socket: { logger: unknown } };
    expect(socket.logger).toBeInstanceOf(SocketModeLogger);
  });

  it("drops the warning about pings on sockets that are not Slack's, and nothing else", async () => {
    const logged: unknown[][] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...line) => void logged.push(line));
    const slack = await fakeSlack();
    try {
      const client = new SocketModeClient({
        appToken: "xapp-test",
        logger: new SocketModeLogger(),
        clientOptions: { slackApiUrl: slack.apiUrl },
        autoReconnectEnabled: false,
        serverPingTimeout: 50,
      });
      await client.start();

      // The Buzz relay connection as nostr-tools opens it: Node's global `WebSocket`,
      // which publishes to the same diagnostics channel from a different copy of undici
      // than the one socket-mode checks `instanceof` against.
      const relay = new WebSocket(slack.wsUrl);
      await once(relay, "open");
      await slack.ping(slack.sockets[1]);
      expect(logged).toEqual([]);

      // Slack's own ping arms the stale timer. Letting it lapse is the warning that says
      // the connection was recycled, and it still comes through under socket-mode's name.
      const disconnected = new Promise((resolve) => client.once("disconnected", resolve));
      await slack.ping(slack.sockets[0]);
      await disconnected;
      expect(logged).toEqual([
        ["[WARN] ", "socket-mode", "A ping wasn't received from the server before the timeout of 50ms!"],
      ]);
      relay.close();
    } finally {
      await slack.close();
      warn.mockRestore();
    }
  });
});
