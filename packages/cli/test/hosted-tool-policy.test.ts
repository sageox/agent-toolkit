import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpBrain, loadManifest, ToolPolicy, Vault } from "@sageox/agent-toolkit-core";
import { EngramStore, generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";
import { buildBrain } from "../src/cli.ts";
import type { RepoWorkspace } from "../src/repos.ts";

// Capture precisely the endpoints and bearer tokens handed to the ACP provider, without
// starting a model process. The CLI wiring, HTTP receiver and tool handlers stay real.
vi.mock("@sageox/agent-toolkit-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@sageox/agent-toolkit-core")>();
  return { ...core, AcpBrain: vi.fn(core.AcpBrain) };
});

describe.each(["claude-acp", "codex-acp"] as const)("%s hosted tool policy", (provider) => {
  const rules = [
    "mcp__private-brain", "mcp__brain", "mcp__brain-shared-1", "mcp__team-brain", "mcp__code",
  ];
  let dir: string;
  let closeHosted: (() => Promise<void>) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hosted-tool-policy-"));
    closeHosted = undefined;
    vi.clearAllMocks();
    vi.stubEnv("BRAIN_MCP_HOST", "127.0.0.1");
    vi.stubEnv("TEST_BUZZ_NSEC", generateKeypair().nsec);
    vi.stubEnv("TEST_AGE_IDENTITY", "test-identity");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await closeHosted?.();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(policy?: ToolPolicy) {
    const age = { recipient: `age1${"q".repeat(58)}`, identitySecret: "TEST_AGE_IDENTITY" };
    const manifest = loadManifest(JSON.stringify({
      name: "demo",
      brain: { provider },
      respondTo: "nobody",
      surfaces: [{ kind: "buzz", relayUrl: "ws://127.0.0.1:1", identity: "TEST_BUZZ_NSEC" }],
      brains: [
        { preset: "local", age },
        { preset: "shared", path: "shared", scope: ["demo", "other"], age },
        { preset: "private", owner: "a".repeat(64), writeScope: ["mem/skills/"] },
        { preset: "team", team: "team_test" },
      ],
      killSwitchParkBy: [],
      jobs: [{
        slug: "shift", archetype: "shift", description: "Test switch protection",
        trigger: { onRequest: true }, killSwitch: { failDirection: "closed" },
        budget: { wallClockMs: 1000 }, run: { command: "unused", args: [] },
      }],
    }));

    // Stub only the backing operations: a refusal must precede any data access or write.
    const entry = { slug: "mem/skills/note", value: "note", eventId: "event", createdAt: 1 };
    const list = vi.spyOn(EngramStore.prototype, "list").mockResolvedValue([entry]);
    const read = vi.spyOn(EngramStore.prototype, "read").mockResolvedValue(entry);
    const write = vi.spyOn(EngramStore.prototype, "write").mockResolvedValue(entry);
    const remove = vi.spyOn(EngramStore.prototype, "remove").mockResolvedValue(entry);
    const vaultRead = vi.spyOn(Vault.prototype, "read").mockReturnValue("vault note");
    const workspace: RepoWorkspace = {
      states: [], warm: async () => {}, readings: () => [], statusText: () => "ready",
      search: vi.fn(async () => "code result"), insights: async () => "",
    };
    const built = await buildBrain(manifest, dir, join(dir, "secrets"), undefined, workspace, policy);
    closeHosted = built.closeHosted;
    const teamSearch = vi.spyOn(built.team!, "search").mockResolvedValue([]);
    const servers = vi.mocked(AcpBrain).mock.calls.at(-1)![0]!.mcpServers!;
    expect(servers.map((server) => server.name)).toEqual([
      "brain", "brain-shared-1", "private-brain", "team-brain", "code",
    ]);

    const request = async (serverName: string, method: string, name?: string, args = {}) => {
      const server = servers.find((server) => server.name === serverName);
      if (!server || !("type" in server) || server.type !== "http") {
        throw new Error(`missing hosted server ${serverName}`);
      }
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        result?: { tools?: { name: string }[]; content?: { text: string }[] };
        error?: { message: string };
      }>;
    };
    const cases = [
      { server: "private-brain", tool: "brain_list", args: {}, work: list },
      { server: "private-brain", tool: "brain_read", args: { slug: "skills/note" }, work: read },
      { server: "private-brain", tool: "brain_write", args: { slug: "skills/note", value: "note" }, work: write },
      { server: "private-brain", tool: "brain_delete", args: { slug: "skills/note" }, work: remove },
      { server: "brain", tool: "brain_read", args: {}, work: vaultRead },
      { server: "brain-shared-1", tool: "brain_read", args: {}, work: vaultRead },
      { server: "team-brain", tool: "team_search", args: { query: "note" }, work: teamSearch },
      { server: "code", tool: "code_search", args: { query: "note" }, work: workspace.search },
    ];
    return { request, cases, write, remove, vaultRead };
  }

  it("refuses direct calls to denied tools before dispatch, even when also allowlisted", async () => {
    const { request, cases } = await start(new ToolPolicy(rules, rules));
    // No tools/list or ACP permission request first: a caller can send the name directly.
    for (const { server, tool, args, work } of cases) {
      expect((await request(server, "tools/call", tool, args)).error?.message).toMatch(/denied/);
      expect(work).not.toHaveBeenCalled();
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("outcome=refused"));
  });

  it("fails closed when no policy is configured", async () => {
    const { request, cases } = await start();
    for (const { server, tool, args, work } of cases) {
      expect((await request(server, "tools/call", tool, args)).error?.message).toMatch(/not allowlisted/);
      expect(work).not.toHaveBeenCalled();
    }
  });

  it("executes allowed calls while retaining private-memory scope and kill-switch checks", async () => {
    const { request, cases, write, remove } = await start(new ToolPolicy(rules, []));
    for (const { server, tool, args, work } of cases) {
      const reply = await request(server, "tools/call", tool, args);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.content?.[0].text).toBeTruthy();
      expect(work).toHaveBeenCalled();
    }
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("outcome=ok"));
    write.mockClear();
    remove.mockClear();
    for (const tool of ["brain_write", "brain_delete"]) {
      expect((await request("private-brain", "tools/call", tool, {
        slug: "other/note", value: "note",
      })).error?.message).toMatch(/outside this agent's write scope/);
      expect((await request("private-brain", "tools/call", tool, {
        slug: "shift/enabled", value: "on",
      })).error?.message).toMatch(/only a human may arm a job/);
    }
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    // Parking remains permitted, even though this declared switch is outside writeScope.
    expect((await request("private-brain", "tools/call", "brain_write", {
      slug: "shift/enabled", value: "off",
    })).error).toBeUndefined();
    expect(write).toHaveBeenCalledExactlyOnceWith("mem/shift/enabled", "off");
  });

  it("checks the configured alias, not the handler's serverInfo name", async () => {
    const { request, vaultRead } = await start(new ToolPolicy(["mcp__brain__brain_read"], []));
    expect((await request("brain-shared-1", "tools/list")).result?.tools).toEqual([]);
    expect((await request("brain-shared-1", "tools/call", "brain_read")).error?.message).toMatch(/not allowlisted/);
    expect(vaultRead).not.toHaveBeenCalled();
    expect((await request("brain", "tools/call", "brain_read")).error).toBeUndefined();
    expect(vaultRead).toHaveBeenCalledOnce();
  });
});
