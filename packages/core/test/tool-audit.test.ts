import { describe, expect, it, vi } from "vitest";
import { auditArgs } from "../src/tool-audit.ts";
import type { LeakPattern } from "../src/manifest.ts";
import { McpBroker, type McpTransport } from "../src/mcp-broker.ts";
import { ToolPolicy, loadToolPolicy } from "../src/tool-policy.ts";

/**
 * A credential in the shape somebody would actually notice: if any of these strings reaches
 * the log, the argument policy failed.
 */
const PLANTED = "ghp_plantedaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** What a `secretRef` resolves to. The broker puts it in the subprocess env and nowhere else. */
const RESOLVED_SECRET = "ghp-gateway-side-credential";

/** Runs `work` with the audit stream captured, and hands back every line it wrote. */
async function captured<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const collect = (line: unknown) => void lines.push(String(line));
  const info = vi.spyOn(console, "info").mockImplementation(collect);
  const warn = vi.spyOn(console, "warn").mockImplementation(collect);
  try {
    return { result: await work(), lines: lines.filter((line) => line.startsWith("tool_call ")) };
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
}

const one = (lines: string[]): string => {
  expect(lines).toHaveLength(1);
  return lines[0];
};

describe("what the audit line records about an argument", () => {
  it("writes a declared argument by value and every other one by shape", () => {
    expect(
      auditArgs(
        { repo: "acme/service", body: "x".repeat(40), labels: ["a", "b"], number: 7, draft: true },
        ["repo"],
      ),
    ).toEqual({
      repo: "acme/service",
      body: "<string 40>",
      labels: "<array 2>",
      number: "<number>",
      draft: "<boolean>",
    });
  });

  it("declares nothing by default, so a caller that forgets records no values at all", () => {
    expect(auditArgs({ token: PLANTED }, [])).toEqual({ token: `<string ${PLANTED.length}>` });
  });

  it("bounds a declared value, so one long argument cannot flood the log", () => {
    const long = auditArgs({ repo: "a".repeat(500) }, ["repo"]).repo as string;
    expect(long.length).toBeLessThan(500);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes a declared list of strings, and each of them bounded", () => {
    expect(auditArgs({ labels: ["bug", "a".repeat(500)] }, ["labels"]).labels).toEqual([
      "bug",
      `${"a".repeat(200)}…`,
    ]);
  });

  it("bounds how many items of a declared list it names, and says how many there were", () => {
    // Bounding each item bounds nothing: the length of the list is the caller's too, and
    // `labels` is declared on two reachable write tools. Five thousand short labels is a
    // megabyte-long record and a way to bury every other line in the stream.
    const labels = Array.from({ length: 4_900 }, (_, i) => `label-${i}`);
    const out = auditArgs({ labels }, ["labels"]).labels as string[];

    expect(out).toHaveLength(9); // 8 items, plus the count
    expect(out.slice(0, 8)).toEqual(labels.slice(0, 8));
    expect(out[8]).toBe("<4900 items>");
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });

  it("leaves a real label set untouched, so the bound is invisible in ordinary use", () => {
    const labels = ["bug", "security", "buzz-toolkit-migration"];
    expect(auditArgs({ labels }, ["labels"]).labels).toEqual(labels);
  });

  it("does not honour a declaration over a nested object — a shape is written instead", () => {
    // A declaration is read once, about a name. What arrives under it is the caller's, and
    // an object would carry whatever it happened to hold. Better unhonoured than wrong.
    expect(auditArgs({ opts: { token: PLANTED } }, ["opts"])).toEqual({ opts: "<object 1>" });
  });

  it("caps how many arguments one line names, and says how many there were", () => {
    // The ingress body is a megabyte, and a caller may spend all of it on argument keys.
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`arg${i}`, i]));
    const out = auditArgs(many, []);

    expect(Object.keys(out)).toHaveLength(33); // 32 arguments, plus the count
    expect(out["…"]).toBe("<200 arguments>");
  });

  it("keeps apart two names built to collide, not merely two that differ", () => {
    // A real pair, found in 74,866 tries against the 32-bit digest this first shipped with:
    // both share 120 characters and both hash to `fa5a851b…`. The bar for a digest over
    // caller-controlled text is not "distinct by accident" — it is "cannot be aimed at" —
    // and this is the input that tells the two bars apart.
    const prefix = `mcp__x__${"z".repeat(112)}`;
    const out = auditArgs({ [`${prefix}26347`]: 1, [`${prefix}74866`]: 2 }, []);

    expect(Object.keys(out)).toHaveLength(2);
    expect(Object.keys(out)[0]).not.toBe(Object.keys(out)[1]);
    expect(out["…"]).toBeUndefined();
  });

  it("bounds an argument name, and keeps two long ones apart", () => {
    const out = auditArgs({ [`a${"x".repeat(400)}`]: 1, [`a${"x".repeat(401)}`]: 2 }, []);

    // Two names sharing a 120-character prefix, so a plain cut would file both under one
    // key and lose an argument from a record that still looked complete.
    expect(Object.keys(out)).toHaveLength(2);
    expect(out["…"]).toBeUndefined(); // nothing was dropped, so nothing is claimed to be
    expect(JSON.stringify(out).length).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// The broker chokepoint: a third-party server in a subprocess, holding a secret.
//
// Every MCP tool call in this toolkit passes through here — a bundle's own server and a
// package off npm alike — so this is where the argument policy, the bound and the leak
// scan are all measured. `mcpToolServer` is the other chokepoint and carries the tools the
// gateway hosts itself; `surface-egress.test.ts` and `team-server.test.ts` drive that one.
// ---------------------------------------------------------------------------

const brokerPolicy = loadToolPolicy(
  JSON.stringify({
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["mcp__github__list_issues", "mcp__github__create_issue"],
      deny: ["Read(//mnt/secrets-store/**)", "mcp__github__delete_repo"],
    },
  }),
);

interface BrokeredOpts {
  policy?: ToolPolicy;
  scope?: Record<string, string[]>;
  leakPatterns?: readonly LeakPattern[];
  /** What the server process answers. Throwing is how a test asks for a call that failed. */
  respond?: () => unknown;
}

async function brokered(
  tool: string,
  args: Record<string, unknown>,
  opts: BrokeredOpts = {},
) {
  const transport: McpTransport = {
    spawn: async () => ({
      request: async () => opts.respond?.() ?? { ok: true },
      close: async () => {},
    }),
  };
  const broker = new McpBroker({
    servers: [
      {
        name: "github",
        command: "npx",
        args: ["-y", "server-github"],
        secrets: { GITHUB_TOKEN: "REF" },
        scope: opts.scope,
      },
    ],
    policy: opts.policy ?? brokerPolicy,
    transport,
    secretOpts: { dir: "/nonexistent", env: { REF: RESOLVED_SECRET } },
    leakPatterns: opts.leakPatterns,
  });
  const id = await broker.connect("github");
  return captured(() =>
    broker
      .message(id, "tools/call", { name: tool, arguments: args })
      .catch((error: Error) => error),
  );
}

describe("a brokered tool call", () => {
  it("records the call, and records every argument as a shape", async () => {
    const { lines } = await brokered("list_issues", { repo: "acme/service", query: PLANTED });
    const line = one(lines);

    expect(line).toContain('tool_call tool="mcp__github__list_issues" outcome=ok');
    // Nothing declares a broker server's arguments, so nothing is written by value — not
    // even the innocuous one. "Unknown" reads as "not safe".
    expect(line).toContain('"repo":"<string 12>"');
    expect(line).toContain(`"query":"<string ${PLANTED.length}>"`);
    expect(line).not.toContain(PLANTED);
    // The credential the broker resolved into the subprocess env is on the gateway's side
    // of the boundary and must not cross onto this line either.
    expect(line).not.toContain(RESOLVED_SECRET);
  });

  it("records a refusal with the rule that fired", async () => {
    const { result, lines } = await brokered("delete_repo", { repo: "acme/service" });
    expect((result as Error).message).toContain("denied by policy");
    expect(one(lines)).toContain('tool_call tool="mcp__github__delete_repo" outcome=refused');
    expect(one(lines)).toContain("denied by policy");
  });

  it("records a tool nobody allowlisted, which is how a missing grant becomes visible", async () => {
    const { lines } = await brokered("read_file", { path: "README.md" });
    expect(one(lines)).toContain("outcome=refused");
    expect(one(lines)).toContain("is not allowlisted");
  });

  it("writes a bound argument by value, and the prose beside it only as a shape", async () => {
    // The one thing a third-party server's arguments can say about themselves: the operator
    // wrote `repo`'s permitted values down, so nothing arriving under that name can be a
    // credential or a sentence. Everything else stays unknown, and unknown reads as unsafe.
    const body = `see also ${PLANTED}`;
    const title = "Fix the thing";
    const { lines } = await brokered(
      "create_issue",
      { repo: "acme/service", title, body },
      { scope: { repo: ["acme/service"] } },
    );
    const line = one(lines);

    expect(line).toContain('tool_call tool="mcp__github__create_issue" outcome=ok');
    expect(line).toContain('"repo":"acme/service"');
    // "a body was passed, and it was this long" survives; its contents do not.
    expect(line).toContain(`"body":"<string ${body.length}>"`);
    expect(line).toContain(`"title":"<string ${title.length}>"`);
    expect(line).not.toContain(PLANTED);
  });

  it("records a bound refusal as refused, without quoting the value it refused", async () => {
    // The declaration is about the VALUE, not the name. A value the allowlist does not
    // contain is arbitrary caller text — the brain composed it — so it is recorded as a
    // shape like any other undeclared argument. The refusal still names the server, the
    // argument and the bound, which is what an operator needs to act.
    const { lines } = await brokered(
      "list_issues",
      { repo: "acme/other" },
      { scope: { repo: ["acme/service"] } },
    );
    const line = one(lines);

    expect(line).toContain("outcome=refused");
    expect(line).toContain("this server is bound to");
    expect(line).toContain('"repo":"<string 10>"');
    expect(line).not.toContain("acme/other");
  });

  it("never writes a secret sent as an out-of-scope bound argument", async () => {
    // Found in review (greptile, PR #79). Declaring the scope NAME marked the argument
    // recordable before the bound had judged its value, so a credential pasted into `repo`
    // was written verbatim by the very refusal that rejected it — and written *before* the
    // leak scan below, which never got the chance to catch it. The declaration now follows
    // the value, so this line holds a length and nothing else.
    const { result, lines } = await brokered(
      "list_issues",
      { repo: PLANTED },
      { scope: { repo: ["acme/service"] } },
    );
    const line = one(lines);

    expect((result as Error).message).toContain("this server is bound to");
    expect(line).toContain("outcome=refused");
    expect(line).toContain(`"repo":"<string ${PLANTED.length}>"`);
    expect(line).not.toContain(PLANTED);
  });

  it("still writes a bound value the operator wrote down, even when something else refuses", async () => {
    // The bound argument is not silenced generally — only when it is the thing that failed.
    // A call refused by the leak scan carries an in-allowlist `repo` by value, because that
    // string came off the operator's own list and is the one an operator greps for.
    const { lines } = await brokered(
      "create_issue",
      { repo: "acme/service", body: "rolled back on host.internal" },
      {
        scope: { repo: ["acme/service"] },
        leakPatterns: [{ name: "internal-hostname", regex: /\bhost\.internal\b/i }],
      },
    );
    const line = one(lines);

    expect(line).toContain("outcome=refused");
    expect(line).toContain("leakPatterns");
    expect(line).toContain('"repo":"acme/service"');
  });

  it("records a duration, so a slow tool is visible without a second source", async () => {
    const { lines } = await brokered("list_issues", { repo: "acme/service" });
    expect(one(lines)).toMatch(/ ms=\d+ /);
  });

  it("separates a call that ran and failed from one a gate refused, and says why", async () => {
    // This line is what a rejected credential looks like, and the reason it is enough. The
    // prompt makes no claim about a credential's shape — the ref is the server author's and
    // the format is the vendor's — so the server rejecting it IS the check, and it is only a
    // check if its words reach an operator. They land here and in the error the brain reads.
    const { result, lines } = await brokered(
      "list_issues",
      { repo: "acme/service" },
      {
        respond: () => {
          throw new Error("401 Bad credentials");
        },
      },
    );
    const line = one(lines);

    expect(line).toContain("outcome=failed");
    expect(line).not.toContain("outcome=refused");
    expect(line).toContain("401 Bad credentials");
    expect((result as Error).message).toContain("401 Bad credentials");
  });

  it("records a leak-scan refusal as refused, not as a failure", async () => {
    // The last gate, and the most interesting refusal the broker can produce: the call was
    // allowed and in bounds, and stopped because of what it would have sent. Filing that
    // under "it did not work" would lose the one line worth grepping for.
    const { lines } = await brokered(
      "create_issue",
      { repo: "acme/service", title: "t", body: "rolled back on host.internal" },
      {
        scope: { repo: ["acme/service"] },
        leakPatterns: [{ name: "internal-hostname", regex: /\bhost\.internal\b/i }],
      },
    );

    expect(one(lines)).toContain("outcome=refused");
    expect(one(lines)).toContain("leakPatterns");
    // Named, never quoted: the line says which pattern fired and not what it matched.
    expect(one(lines)).not.toContain("host.internal");
  });

  it("scans a read's arguments too, because a query reaches the server just the same", async () => {
    // Not a write, and still refused. A per-tool list of "the ones that publish" fails open
    // the first time somebody forgets an entry; a token pasted into a search string has
    // reached a third party either way.
    const { result } = await brokered(
      "list_issues",
      { repo: "acme/service", query: `author:${PLANTED}` },
      {
        scope: { repo: ["acme/service"] },
        leakPatterns: [{ name: "github-pat", regex: /\bghp_[A-Za-z0-9]{8,}\b/ }],
      },
    );
    expect((result as Error).message).toContain("refused by leakPatterns");
  });

  it("quotes the tool name, so a caller cannot write a second record", async () => {
    // `params.name` is the brain's, and `qualifyTool` prefixes it rather than validating it.
    // A newline in it would end the line and let the rest read as a record of its own — a
    // forged `outcome=ok` is exactly what sends an operator past the call they wanted.
    const forge = "x\ntool_call tool=mcp__github__list_issues outcome=ok ms=1 args={}";
    const { lines } = await brokered(forge, { repo: "acme/service" });
    const line = one(lines);

    // One record, and the forged text survives whole inside the quoted `tool` field rather
    // than becoming a record of its own. Asserting the escaping, not merely the absence of
    // a newline: a sanitiser that dropped the name would also pass that weaker test.
    expect(line.includes("\n")).toBe(false);
    expect(
      line.startsWith(`tool_call tool=${JSON.stringify(`mcp__github__${forge}`)} outcome=refused`),
    ).toBe(true);
  });

  it("bounds the tool name, so it cannot be a payload either", async () => {
    const { lines } = await brokered("z".repeat(5_000), { repo: "acme/service" });
    expect(one(lines).length).toBeLessThan(1_000);
    expect(one(lines)).toContain("…"); // a cut name still reads as cut
  });

  it("keeps two cut tool names apart, so a record can still say which tool ran", async () => {
    // Tool names come from whatever MCP server an operator added, so "no real name is that
    // long" is a fact about today's bundles and not a property of this format. A record
    // that cannot say which tool ran has failed at the only thing it does.
    const shared = "z".repeat(200);
    const first = await brokered(`${shared}A`, { repo: "acme/service" });
    const second = await brokered(`${shared}B`, { repo: "acme/service" });
    const nameOf = (line: string) => line.slice(0, line.indexOf(" outcome="));

    expect(nameOf(one(first.lines))).not.toBe(nameOf(one(second.lines)));
    // Same prefix, different digest: still readable as a name, not replaced by a hash.
    expect(one(first.lines)).toContain(`mcp__github__${"z".repeat(107)}`);
  });

  it("quotes the reason as one field, so an error cannot forge another", async () => {
    const forging = new ToolPolicy([], ['mcp__github__list_issues(" outcome=ok x=")']);
    const { lines } = await brokered("list_issues", { repo: "acme/service" }, { policy: forging });
    // One line, one outcome: a `"` inside the reason is escaped rather than closing the
    // field and letting the rest read as fields of its own.
    expect(one(lines).match(/outcome=/g)).toHaveLength(1);
    expect(one(lines)).toContain("outcome=refused");
  });

  it("leaves tools/list alone — this log is tool calls, not every message", async () => {
    const transport: McpTransport = {
      spawn: async () => ({
        request: async () => ({ tools: [{ name: "list_issues" }] }),
        close: async () => {},
      }),
    };
    const broker = new McpBroker({
      servers: [{ name: "github", command: "x", args: [], secrets: {} }],
      policy: brokerPolicy,
      transport,
    });
    const id = await broker.connect("github");
    const { result, lines } = await captured(() => broker.message(id, "tools/list"));

    expect(lines).toEqual([]);
    // And the schema pinning it does on the way back is untouched.
    expect((result as { tools: unknown[] }).tools).toHaveLength(1);
  });
});
