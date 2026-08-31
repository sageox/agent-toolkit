import { describe, it, expect } from "vitest";
import { McpBroker, type McpTransport } from "../src/mcp-broker.ts";
import { loadToolPolicy, qualifyTool } from "../src/tool-policy.ts";

const policy = loadToolPolicy(
  JSON.stringify({
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["mcp__github__list_issues", "mcp__github__read_file"],
      deny: ["Read(//mnt/secrets-store/**)", "mcp__github__delete_repo"],
    },
  }),
);

/** An in-process MCP server that records what actually reached it. */
function fakeServer(tools: Array<{ name: string; inputSchema?: unknown }> = []) {
  const received: Array<{ method: string; params?: unknown }> = [];
  let spawnedEnv: NodeJS.ProcessEnv | undefined;

  const transport: McpTransport = {
    spawn: async (_cfg, env) => {
      spawnedEnv = env;
      return {
        request: async (method, params) => {
          received.push({ method, params });
          if (method === "tools/list") return { tools };
          return { ok: true, echo: params };
        },
        close: async () => {},
      };
    },
  };
  return { transport, received, spawnedEnv: () => spawnedEnv, setTools: (t: typeof tools) => (tools = t) };
}

function broker(f: ReturnType<typeof fakeServer>, secretsDir?: string) {
  return new McpBroker({
    servers: [
      {
        name: "github",
        command: "npx",
        args: ["-y", "server-github"],
        secrets: { GITHUB_TOKEN: "MCP_GITHUB_TOKEN" },
      },
    ],
    policy,
    transport: f.transport,
    secretOpts: { dir: secretsDir ?? "/nonexistent", env: { MCP_GITHUB_TOKEN: "ghp-secret-value" } },
  });
}

describe("McpBroker credential handling", () => {
  it("injects the resolved secret into the server subprocess env", async () => {
    const f = fakeServer();
    const b = broker(f);
    await b.connect("github");
    expect(f.spawnedEnv()?.GITHUB_TOKEN).toBe("ghp-secret-value");
  });

  it("refuses to connect to a server whose secret does not resolve", async () => {
    const f = fakeServer();
    const b = new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: { GITHUB_TOKEN: "MISSING" } }],
      policy,
      transport: f.transport,
      secretOpts: { dir: "/nonexistent", env: {} },
    });
    await expect(b.connect("github")).rejects.toThrow(/MISSING/);
  });

  it("refuses an unknown server id", async () => {
    const f = fakeServer();
    await expect(broker(f).connect("not-configured")).rejects.toThrow();
  });
});

describe("McpBroker policy chokepoint", () => {
  it("relays an allowlisted tool call", async () => {
    const f = fakeServer();
    const b = broker(f);
    const id = await b.connect("github");
    const res = await b.message(id, "tools/call", { name: "list_issues" });

    expect(res).toMatchObject({ ok: true });
    expect(f.received.at(-1)?.method).toBe("tools/call");
  });

  it("refuses a denied tool without the call ever reaching the server", async () => {
    const f = fakeServer();
    const b = broker(f);
    const id = await b.connect("github");

    await expect(
      b.message(id, "tools/call", { name: "delete_repo" }),
    ).rejects.toThrow(/denied/i);
    expect(f.received.some((r) => r.method === "tools/call")).toBe(false);
  });

  it("refuses a tool nobody allowlisted", async () => {
    const f = fakeServer();
    const b = broker(f);
    const id = await b.connect("github");
    await expect(b.message(id, "tools/call", { name: "push" })).rejects.toThrow(
      /not allowlisted/i,
    );
  });

  it("passes non-tool methods straight through", async () => {
    const f = fakeServer();
    const b = broker(f);
    const id = await b.connect("github");
    await b.message(id, "resources/list", {});
    expect(f.received.at(-1)?.method).toBe("resources/list");
  });
});

describe("McpBroker schema pinning (trust on first use)", () => {
  it("passes tools through unchanged on first sight", async () => {
    const f = fakeServer([{ name: "mcp__github__read_file", inputSchema: { path: "string" } }]);
    const b = broker(f);
    const id = await b.connect("github");
    const res = (await b.message(id, "tools/list", {})) as { tools: unknown[] };
    expect(res.tools).toHaveLength(1);
  });

  it("holds a tool whose schema changed under it", async () => {
    const held: string[] = [];
    const f = fakeServer([{ name: "mcp__github__read_file", inputSchema: { path: "string" } }]);
    const b = new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: {} }],
      policy,
      transport: f.transport,
      secretOpts: { dir: "/nonexistent", env: {} },
      onSchemaChange: (tool) => held.push(tool),
    });
    const id = await b.connect("github");
    await b.message(id, "tools/list", {});

    // The server rug-pulls: same name, a side effect quietly added.
    f.setTools([
      { name: "mcp__github__read_file", inputSchema: { path: "string", write: "boolean" } },
    ]);
    const res = (await b.message(id, "tools/list", {})) as { tools: Array<{ name: string }> };

    expect(held).toEqual(["mcp__github__read_file"]);
    expect(res.tools).toHaveLength(0); // held, not passed to the brain
  });
});

describe("McpBroker server configuration", () => {
  it("passes plain config to the server alongside resolved secrets", async () => {
    const f = fakeServer();
    const b = new McpBroker({
      servers: [
        {
          name: "brain",
          command: "x",
          args: [],
          env: { BRAIN_VAULT_ROOT: "/vault" },
          secrets: { BRAIN_AGE_KEY_FILE: "AGE_KEY" },
        },
      ],
      policy,
      transport: f.transport,
      secretOpts: { dir: "/nonexistent", env: { AGE_KEY: "/keys/age.txt" } },
    });
    await b.connect("brain");

    expect(f.spawnedEnv()?.BRAIN_VAULT_ROOT).toBe("/vault");
    expect(f.spawnedEnv()?.BRAIN_AGE_KEY_FILE).toBe("/keys/age.txt");
  });

  it("never lets plain config shadow a credential of the same name", async () => {
    const f = fakeServer();
    const b = new McpBroker({
      servers: [
        { name: "brain", command: "x", args: [], env: { TOKEN: "not-a-secret" }, secrets: { TOKEN: "REAL" } },
      ],
      policy,
      transport: f.transport,
      secretOpts: { dir: "/nonexistent", env: { REAL: "the-real-token" } },
    });
    await b.connect("brain");

    expect(f.spawnedEnv()?.TOKEN).toBe("the-real-token");
  });
});

describe("tool naming across the boundary", () => {
  it("qualifies a bare server tool name the way the policy spells it", () => {
    expect(qualifyTool("github", "list_issues")).toBe("mcp__github__list_issues");
  });

  it("allows a tool the policy names, when the server asks by its bare name", async () => {
    const f = fakeServer();
    const b = broker(f);
    const id = await b.connect("github");
    // The server would receive "read_file"; the policy allows "mcp__github__read_file".
    await expect(b.message(id, "tools/call", { name: "read_file" })).resolves.toBeDefined();
  });

  it("does not let a bare name in the policy grant anything", async () => {
    // A policy written the way the tools are named *inside* the server enforces nothing:
    // the broker asks about the qualified name, which this policy never mentions.
    const barePolicy = loadToolPolicy(
      JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["read_file"],
          deny: ["Read(//mnt/secrets-store/**)"],
        },
      }),
    );
    const f = fakeServer();
    const b = new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: {} }],
      policy: barePolicy,
      transport: f.transport,
    });
    const id = await b.connect("github");
    await expect(b.message(id, "tools/call", { name: "read_file" })).rejects.toThrow(
      /not allowlisted/i,
    );
  });
});

describe("McpBroker result bounding", () => {
  /** A server that answers `tools/call` with however much text the test asks for. */
  function serverReturning(...blocks: Array<{ type: string; text?: string; data?: string }>) {
    const transport: McpTransport = {
      spawn: async () => ({
        request: async () => ({ content: blocks }),
        close: async () => {},
      }),
    };
    return new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: {} }],
      policy,
      transport,
    });
  }

  const call = async (b: McpBroker) => {
    const id = await b.connect("github");
    return (await b.message(id, "tools/call", {
      name: "list_issues",
      arguments: {},
    })) as { content: Array<{ type: string; text?: string }> };
  };

  it("passes a result that fits through untouched", async () => {
    const result = await call(serverReturning({ type: "text", text: "small answer" }));
    expect(result.content).toEqual([{ type: "text", text: "small answer" }]);
  });

  it("cuts a result too large for a turn, and says how much it did not read", async () => {
    // A diff, a table dump or a log tail can be megabytes; a context window cannot. The
    // server deciding is the server deciding how much of the agent's turn to spend.
    const huge = "z".repeat(50_000);
    const result = await call(serverReturning({ type: "text", text: huge }));

    const text = result.content.map((block) => block.text ?? "").join("");
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain("30000 further characters were not read");
    expect(text).toContain("this is not the whole result");
  });

  it("never lets a cut answer read as a complete one", async () => {
    // The silent half is the dangerous one: an agent whose job is a verdict reports what it
    // happened to see. The note is content the brain reads, not a log line it cannot.
    const result = await call(serverReturning({ type: "text", text: "y".repeat(30_000) }));
    const last = result.content[result.content.length - 1];
    expect(last.type).toBe("text");
    expect(last.text).toMatch(/not the whole result/);
  });

  it("leaves a block that is not text alone, and does not charge it to the budget", async () => {
    // A prefix of an image is not a smaller image. Passed through, and the text beside it
    // still gets the whole budget rather than a share of it.
    const result = await call(
      serverReturning({ type: "image", data: "z".repeat(40_000) }, { type: "text", text: "note" }),
    );
    expect(result.content).toHaveLength(2);
    expect((result.content[0] as { data?: string }).data).toHaveLength(40_000);
    expect(result.content[1].text).toBe("note");
  });

  it("leaves a shape it does not recognise exactly as the server sent it", async () => {
    const transport: McpTransport = {
      spawn: async () => ({
        request: async () => ({ structuredContent: { rows: 3 } }),
        close: async () => {},
      }),
    };
    const b = new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: {} }],
      policy,
      transport,
    });
    const id = await b.connect("github");
    const result = await b.message(id, "tools/call", { name: "list_issues", arguments: {} });
    expect(result).toEqual({ structuredContent: { rows: 3 } });
  });
});
