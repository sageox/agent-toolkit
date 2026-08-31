import { describe, it, expect, vi } from "vitest";
import { stdioTransport } from "../src/mcp-stdio.ts";
import type { McpServerConfig } from "../src/mcp-broker.ts";

/** A real MCP-shaped stdio server: newline-delimited JSON-RPC on stdin/stdout. */
const ECHO_SERVER = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, error: { message: "no such tool" } }) + "\\n");
    } else if (msg.method === "env") {
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { token: process.env.SERVER_TOKEN ?? null } }) + "\\n");
    } else if (msg.method === "noisy") {
      process.stdout.write("a banner line that is not JSON\\n");
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { ok: true } }) + "\\n");
    } else if (msg.method === "split") {
      const frame = JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { ok: "split" } }) + "\\n";
      process.stdout.write(frame.slice(0, 8));
      setTimeout(() => process.stdout.write(frame.slice(8)), 15);
    } else if (msg.method === "hang") {
      // Accepted, never answered, process stays healthy: the case failAll cannot see.
    } else if (msg.method === "die") {
      process.exit(1);
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { echoed: msg.method, params: msg.params } }) + "\\n");
    }
  }
});
`;

const config = (): McpServerConfig => ({
  name: "echo",
  command: process.execPath,
  args: ["-e", ECHO_SERVER],
  secrets: {},
});

describe("stdioTransport", () => {
  it("round-trips a JSON-RPC call to a real child process", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    const result = await conn.request("tools/call", { name: "brain_read" });

    expect(result).toEqual({ echoed: "tools/call", params: { name: "brain_read" } });
    await conn.close();
  });

  it("puts the resolved secret in the server's environment, not the caller's", async () => {
    const conn = await stdioTransport.spawn(config(), { ...process.env, SERVER_TOKEN: "s3cret" });
    expect(await conn.request("env")).toEqual({ token: "s3cret" });
    await conn.close();
  });

  it("matches concurrent calls to their own replies", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    const [a, b, c] = await Promise.all([
      conn.request("one"),
      conn.request("two"),
      conn.request("three"),
    ]);

    expect([a, b, c].map((r) => (r as { echoed: string }).echoed)).toEqual(["one", "two", "three"]);
    await conn.close();
  });

  it("reassembles a frame that arrives split across chunks", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    expect(await conn.request("split")).toEqual({ ok: "split" });
    await conn.close();
  });

  it("ignores non-JSON output instead of failing every in-flight call", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    expect(await conn.request("noisy")).toEqual({ ok: true });
    await conn.close();
  });

  it("surfaces a JSON-RPC error as a rejection", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    await expect(conn.request("boom")).rejects.toThrow(/no such tool/);
    await conn.close();
  });

  it("rejects in-flight calls when the server dies, rather than hanging", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    await expect(conn.request("die")).rejects.toThrow(/exited/);
  });

  it("refuses calls after close", async () => {
    const conn = await stdioTransport.spawn(config(), process.env);
    await conn.close();
    await expect(conn.request("anything")).rejects.toThrow(/closed/);
  });
});

describe("a server that is alive and never answers", () => {
  // The case `failAll` cannot reach. Exit and error both reject every caller; a healthy
  // process that simply does not reply leaves the promise pending forever, holding the turn
  // until `limits.turnTimeoutMs` releases the channel — with nothing said about which server
  // did it. These bounds fire first, and name it.

  it("gives up on a tools/call inside the turn's own budget", async () => {
    vi.useFakeTimers();
    try {
      const conn = await stdioTransport.spawn(config(), process.env);
      const pending = conn.request("tools/call", { name: "hang" });
      // Asserted before advancing: a bound that fired immediately would pass the check
      // below while breaking every slow-but-working server.
      let settled = false;
      void pending.catch(() => {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).rejects.toThrow(
        /MCP server echo did not answer tools\/call within 60s/,
      );
      // Named as a hang rather than a crash, because the two need different fixes and the
      // process being healthy is the surprising half.
      await expect(pending).rejects.toThrow(/hang rather than a crash/);
      await conn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the handshake longer, since a cold `npx -y` install is legitimately slow", async () => {
    // Bounded all the same: a setup command that hangs is worse than one that fails, since
    // a human is sitting in front of it either way.
    vi.useFakeTimers();
    try {
      const conn = await stdioTransport.spawn(config(), process.env);
      const pending = conn.request("hang");
      let settled = false;
      void pending.catch(() => {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).rejects.toThrow(/did not answer hang within 120s/);
      await conn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reject a call that answered, when its timer would later have fired", async () => {
    // The bug the cleanup exists to prevent: a settled promise rejected by its own timer,
    // or a timer left running for every call a long-lived connection ever made.
    vi.useFakeTimers();
    try {
      const conn = await stdioTransport.spawn(config(), process.env);
      const answered = conn.request("tools/call", { name: "brain_read" });
      await vi.advanceTimersByTimeAsync(10);
      await expect(answered).resolves.toMatchObject({ echoed: "tools/call" });

      let rejected: unknown;
      void answered.catch((error) => (rejected = error));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(rejected).toBeUndefined();
      await conn.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
