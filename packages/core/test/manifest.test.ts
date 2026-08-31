import { describe, it, expect } from "vitest";
import { loadManifest, resolveMcpServer } from "../src/manifest.ts";

describe("loadManifest", () => {
  it("parses a minimal console agent", () => {
    const m = loadManifest(`
name: demo
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: console
`);
    expect(m.name).toBe("demo");
    expect(m.surfaces[0].kind).toBe("console");
    expect(m.surfaces[0].channels).toEqual([]);
    // Nothing is consented to until a channel says so, and a console agent lists none.
    expect(m.guard.publicChannels).toEqual([]);
  });

  // The consent the egress guard enforces is the channel list read a second way. Deriving
  // it is what makes "listed public" and "allowed to speak publicly" the same statement
  // rather than two that can disagree.
  it("derives the guard's public destinations from the channels that carry them", () => {
    const m = loadManifest(`
name: demo
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: buzz
    channels:
      - { id: town, reply: public }
      - { id: ops, name: Ops, reply: private }
  - kind: slack
    channels:
      - { id: C0123, reply: public }
`);
    expect(m.guard.publicChannels).toEqual(["buzz:town", "slack:C0123"]);
  });

  it("refuses a channel listed twice, which would answer the question twice", () => {
    expect(() =>
      loadManifest(`
name: demo
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: buzz
    channels:
      - { id: town, reply: private }
      - { id: town, reply: public }
`),
    ).toThrow(/same channel id twice/);
  });

  it("refuses an entry that does not say whether the agent answers publicly", () => {
    expect(() =>
      loadManifest(`
name: demo
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: buzz
    channels:
      - { id: town }
`),
    ).toThrow();
  });

  // The keys 0.2.0 used. Zod's own report for such a file is true and useless — an
  // unrecognized key per guard entry, and "expected object, received string" per channel.
  it("names the new shape when it finds the retired one", () => {
    for (const retired of [
      "surfaces: [{ kind: buzz, channels: [town], privateChannels: [town] }]",
      "surfaces: [{ kind: buzz, channels: [{id: town, reply: private}] }]\nguard: { noPublicChannels: true }",
      "surfaces: [{ kind: buzz, channels: [{id: town, reply: private}] }]\nguard: { publicChannels: [buzz:town] }",
    ]) {
      expect(() =>
        loadManifest(`name: demo\nbrain: {provider: mock}\nrespondTo: anyone\n${retired}`),
        retired,
      ).toThrow(/retired[\s\S]*reply: public/);
    }
  });

  it("refuses an MCP server name that makes a whole-server rule ambiguous", () => {
    // `mcp__my__server` would be either the `my__server` server or the `my` server's
    // `server` tool, and no rule text settles it — so a whole-server deny on such a name
    // silently stops applying at the one layer the brain cannot skip. The second case is
    // the same ambiguity arriving by sanitization: anything outside `[A-Za-z0-9_-]` in a
    // server name becomes `_`, so `my..server` would show up as `my__server`.
    for (const name of ["my__server", "my..server"]) {
      expect(() =>
        loadManifest(
          `name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n` +
            `mcpServers: [{name: "${name}", command: "x"}]`,
        ),
        name,
      ).toThrow();
    }
  });

  it("keeps the server names the toolkit itself generates", () => {
    for (const name of ["brain", "team-brain", "brain-shared-0", "github", "surface-egress"]) {
      expect(() =>
        loadManifest(
          `name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n` +
            `mcpServers: [{name: "${name}", command: "x"}]`,
        ),
        name,
      ).not.toThrow();
    }
  });

  it("rejects an unknown respondTo", () => {
    expect(() =>
      loadManifest("name: x\nbrain: {provider: mock}\nrespondTo: everyone\nsurfaces: [{kind: console}]"),
    ).toThrow();
  });

  it("rejects config with no surfaces", () => {
    expect(() =>
      loadManifest("name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: []"),
    ).toThrow();
  });
});

describe("guard.leakPatterns", () => {
  const withPatterns = (patterns: string) =>
    loadManifest(
      `name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n` +
        `guard:\n  leakPatterns:\n${patterns}`,
    );

  it("declares nothing by default", () => {
    const m = loadManifest(
      "name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]",
    );
    expect(m.guard.leakPatterns).toEqual([]);
  });

  it("compiles each pattern case-insensitively", () => {
    const m = withPatterns(`    - name: bead-id\n      regex: '\\bacme-[a-z0-9]{5}\\b'\n`);
    expect(m.guard.leakPatterns[0].name).toBe("bead-id");
    expect(m.guard.leakPatterns[0].regex.test("ACME-9F2K1")).toBe(true);
  });

  // The shapes the fleet's own list is made of — a hostname, a tracker id, a decision
  // record, a key. None of them needs to quantify a group, which is why refusing that is
  // affordable.
  it("takes the patterns an operator actually writes", () => {
    expect(() =>
      withPatterns(
        `    - name: internal-hostname\n      regex: '\\b(?:host\\.internal|corp\\.example)\\b'\n` +
          `    - name: adr-reference\n      regex: '\\bADR-\\d+\\b'\n` +
          `    - name: github-token\n      regex: '\\bgh[pousr]_[A-Za-z0-9]{20,}\\b'\n` +
          `    - name: private-key-block\n      regex: '-----BEGIN [A-Z ]*PRIVATE KEY-----'\n`,
      ),
    ).not.toThrow();
  });

  it("refuses a quantified group, which is how a scan stalls the gateway", () => {
    for (const regex of ["(a+)+$", "(?:[a-z]+\\.)*host", "(ab|a){2,}"]) {
      expect(() => withPatterns(`    - name: p\n      regex: '${regex}'\n`), regex).toThrow(
        /quantifier may not apply to a group/,
      );
    }
  });

  // An escaped paren and one inside a character class are text, not structure — refusing
  // them would send an operator hunting for a group their pattern does not have.
  it("reads an escaped or bracketed paren as text", () => {
    for (const regex of ["\\)+", "[)]+", "[\\]]+"]) {
      expect(() => withPatterns(`    - name: p\n      regex: '${regex}'\n`), regex).not.toThrow();
    }
  });

  it("refuses a regex that does not compile", () => {
    expect(() => withPatterns(`    - name: p\n      regex: '[unclosed'\n`)).toThrow(
      /not a valid regular expression/,
    );
  });

  it("requires the name a refusal and the log will speak in", () => {
    expect(() => withPatterns(`    - regex: 'secret'\n`)).toThrow();
  });

  // The name is written into `reason="…"` on one line of the gateway log and replayed to
  // the brain. A newline or a quote in it could close that field and forge a second
  // `egress_blocked` line no egress produced, so the charset refuses what escaping would
  // otherwise have to catch at every call site.
  it("refuses a name that could forge a log line", () => {
    // JSON flow style so the crafted name survives YAML quoting and reaches the schema —
    // written as a block scalar, the quote cases fail at the parser and prove nothing.
    const withName = (name: string) =>
      loadManifest(
        `name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n` +
          `guard: {leakPatterns: [{name: ${JSON.stringify(name)}, regex: "x"}]}`,
      );

    for (const name of ['"bead-id', 'bead-id"\negress_blocked rule=forged', "Bead_ID", "-lead"]) {
      expect(() => withName(name), JSON.stringify(name)).toThrow(
        /lower-case letters, digits, and hyphens/,
      );
    }
    expect(() => withName("internal-hostname")).not.toThrow();
  });
});

describe("brain.model", () => {
  const base = "name: x\nrespondTo: anyone\nsurfaces: [{kind: console}]\n";

  it("pins the model for this agent", () => {
    expect(loadManifest(`${base}brain: {provider: claude-acp, model: claude-opus-5}`).brain.model)
      .toBe("claude-opus-5");
  });

  it("is optional — an unpinned agent runs the brain's own default", () => {
    expect(loadManifest(`${base}brain: {provider: mock}`).brain.model).toBeUndefined();
  });

  it("refuses an empty pin, which names no model", () => {
    expect(() => loadManifest(`${base}brain: {provider: claude-acp, model: ''}`)).toThrow();
  });

  it("refuses a misspelt key rather than reading as a pin nobody made", () => {
    expect(() => loadManifest(`${base}brain: {provider: claude-acp, modle: claude-opus-5}`))
      .toThrow();
  });

  it("refuses a pin the mock brain cannot run", () => {
    expect(() => loadManifest(`${base}brain: {provider: mock, model: claude-opus-5}`))
      .toThrow(/claude-acp/);
  });
});

describe("owner", () => {
  const base = "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: owner-only\n";

  it("takes one id per surface, since one agent answers on all of them", () => {
    expect(loadManifest(`${base}owner: [npub-alice, U08ALICE]`).owner).toEqual([
      "npub-alice",
      "U08ALICE",
    ]);
  });

  it("still accepts a single id, meaning an owner on one surface", () => {
    expect(loadManifest(`${base}owner: alice`).owner).toEqual(["alice"]);
  });

  it("refuses an empty owner, which would admit nobody", () => {
    expect(() => loadManifest(`${base}owner: []`)).toThrow();
  });
});

describe("allowedRespondTo", () => {
  const base = "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\n";

  it("permits a mode that is on the list", () => {
    expect(() =>
      loadManifest(`${base}respondTo: owner-only\nowner: me\nallowedRespondTo: [owner-only]`),
    ).not.toThrow();
  });

  it("refuses a config that widens beyond what the deployment allows", () => {
    expect(() =>
      loadManifest(`${base}respondTo: anyone\nallowedRespondTo: [owner-only, allowlist]`),
    ).toThrow(/forbids/i);
  });

  it("places no restriction when the list is absent", () => {
    expect(() => loadManifest(`${base}respondTo: anyone`)).not.toThrow();
  });
});

describe("brains", () => {
  const base = "name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n";
  const buzzBase =
    "name: x\nbrain: {provider: mock}\nrespondTo: anyone\n" +
    "surfaces: [{kind: buzz, relayUrl: 'wss://relay.example', identity: BUZZ_NSEC}]\n";

  it("defaults to no brains — a stateless agent is valid", () => {
    expect(loadManifest(base).brains).toEqual([]);
  });

  it("accepts a local brain with a default vault path", () => {
    const m = loadManifest(`${base}brains:\n  - preset: local`);
    expect(m.brains[0]).toMatchObject({ preset: "local", path: "./brain" });
  });

  it("declares age encryption with a public recipient and logical identity secret", () => {
    const recipient = `age1${"q".repeat(58)}`;
    const brain = loadManifest(
      `${base}brains:\n  - preset: local\n    age:\n      recipient: ${recipient}\n      identitySecret: SHARED_AGE_IDENTITY`,
    ).brains[0];
    expect(brain).toMatchObject({
      preset: "local",
      age: { recipient, identitySecret: "SHARED_AGE_IDENTITY" },
    });
  });

  it("keeps age identities out of config and encrypted vaults on the built-in server", () => {
    const recipient = `age1${"q".repeat(58)}`;
    expect(() =>
      loadManifest(
        `${base}brains:\n  - preset: local\n    age: {recipient: ${recipient}, identitySecret: ../key}`,
      ),
    ).toThrow(/identitySecret/);
    expect(() =>
      loadManifest(
        `${base}brains:\n  - preset: local\n    command: custom-brain\n    age: {recipient: ${recipient}, identitySecret: AGE_IDENTITY}`,
      ),
    ).toThrow(/built-in gateway-hosted/);
    // `args` alone would otherwise pass and then be silently dropped by the wiring, which
    // routes every age brain to the hosted server.
    expect(() =>
      loadManifest(
        `${base}brains:\n  - preset: local\n    args: [brain_mcp.py]\n    age: {recipient: ${recipient}, identitySecret: AGE_IDENTITY}`,
      ),
    ).toThrow(/built-in gateway-hosted/);
  });

  it("requires a shared brain to declare its location and at least two members", () => {
    expect(() => loadManifest(`${base}brains:\n  - preset: shared`)).toThrow();
    expect(() =>
      loadManifest(`${base}brains:\n  - preset: shared\n    path: ../shared/x\n    scope: [x]`),
    ).toThrow();
    const m = loadManifest(
      `${base}brains:\n  - preset: shared\n    path: ../shared/x-y\n    scope: [x, y]`,
    );
    expect(m.brains[0]).toMatchObject({
      preset: "shared",
      path: "../shared/x-y",
      scope: ["x", "y"],
    });
  });

  it("requires this agent in a unique, duplicate-free shared scope", () => {
    expect(() =>
      loadManifest(`${base}brains:\n  - preset: shared\n    path: /vault\n    scope: [a, b]`),
    ).toThrow(/include this agent/i);
    expect(() =>
      loadManifest(`${base}brains:\n  - preset: shared\n    path: /vault\n    scope: [x, x]`),
    ).toThrow(/duplicate/i);
    expect(() =>
      loadManifest(
        `${base}brains:\n  - preset: shared\n    path: /a\n    scope: [x, y]\n  - preset: shared\n    path: /b\n    scope: [y, x]`,
      ),
    ).toThrow(/unique/i);
  });

  it("requires an engram owner for the private brain, since a missing one fails silently", () => {
    expect(() => loadManifest(`${buzzBase}brains:\n  - preset: private`)).toThrow();
    const owner = "A".repeat(64);
    expect(
      loadManifest(`${buzzBase}brains:\n  - preset: private\n    owner: ${owner}`).brains[0],
    ).toMatchObject({ preset: "private", owner: owner.toLowerCase() });
  });

  it("takes an optional write scope for the private brain, and refuses an empty one", () => {
    const owner = "a".repeat(64);
    expect(
      loadManifest(
        `${buzzBase}brains:\n  - preset: private\n    owner: ${owner}\n    writeScope: [mem/skills/]`,
      ).brains[0],
    ).toMatchObject({ writeScope: ["mem/skills/"] });
    // `writeScope: []` reads as "scoped to nothing" but would silently mean "unscoped".
    expect(() =>
      loadManifest(
        `${buzzBase}brains:\n  - preset: private\n    owner: ${owner}\n    writeScope: []`,
      ),
    ).toThrow();
  });

  it("binds private memory to exactly one Buzz relay and identity", () => {
    const privateBrain = `brains:\n  - preset: private\n    owner: ${"a".repeat(64)}`;
    expect(() => loadManifest(`${base}${privateBrain}`)).toThrow(/exactly one Buzz surface/);
    expect(() =>
      loadManifest(
        "name: x\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces:\n" +
          "  - {kind: buzz, relayUrl: 'wss://one.example', identity: ONE}\n" +
          "  - {kind: buzz, relayUrl: 'wss://two.example', identity: TWO}\n" +
          privateBrain,
      ),
    ).toThrow(/exactly one Buzz surface/);
  });

  it("allows only one private namespace for one agent identity", () => {
    expect(() =>
      loadManifest(
        `${buzzBase}brains:\n` +
          `  - {preset: private, owner: ${"a".repeat(64)}}\n` +
          `  - {preset: private, owner: ${"b".repeat(64)}}`,
      ),
    ).toThrow(/only one private brain/);
  });

  it("allows several brains at once, including two shared ones", () => {
    const m = loadManifest(
      `${base}brains:\n  - preset: local\n  - preset: shared\n    path: /a\n    scope: [x, a]\n  - preset: shared\n    path: /b\n    scope: [x, b]\n  - preset: team\n    team: team_x`,
    );
    expect(m.brains.map((b) => b.preset)).toEqual(["local", "shared", "shared", "team"]);
  });

  it("requires the team brain to name its team — it cannot be inferred at runtime", () => {
    expect(() => loadManifest(`${base}brains:\n  - preset: team`)).toThrow();
    expect(
      loadManifest(`${base}brains:\n  - preset: team\n    team: team_x`).brains[0],
    ).toMatchObject({ preset: "team", team: "team_x" });
  });

  it("takes the ox token as a secretRef, so the value stays out of the manifest", () => {
    expect(
      loadManifest(`${base}brains:\n  - preset: team\n    team: team_x\n    token: OX_TOKEN_ASHBY`)
        .brains[0],
    ).toMatchObject({ token: "OX_TOKEN_ASHBY" });
  });

  it("refuses a pasted access token, which would commit the credential to the bundle", () => {
    expect(() =>
      loadManifest(`${base}brains:\n  - preset: team\n    team: team_x\n    token: oxp_abc123`),
    ).toThrow(/not the token itself/);
  });

  it("refuses a second team brain, which would wire to the same server and be unreachable", () => {
    expect(() =>
      loadManifest(
        `${base}brains:\n  - preset: team\n    team: team_x\n  - preset: team\n    team: team_y`,
      ),
    ).toThrow(/only one team brain/);
  });

  it("rejects a preset nobody implements", () => {
    expect(() => loadManifest(`${base}brains:\n  - preset: telepathy`)).toThrow();
  });
});

describe("mcpServers scope", () => {
  const base = "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n";
  const server = (extra: string) =>
    `${base}mcpServers:\n  - name: gh\n    command: node\n    args: [gh.js]\n${extra}`;

  it("is absent unless configured — a server is unbounded until someone bounds it", () => {
    expect(resolveMcpServer(loadManifest(server("")).mcpServers[0]!).scope).toEqual({});
  });

  it("takes an argument name and the values allowed under it", () => {
    const decl = loadManifest(server('    scope: {repo: [acme/service, acme/tools]}')).mcpServers[0]!;
    expect(resolveMcpServer(decl).scope).toEqual({ repo: ["acme/service", "acme/tools"] });
  });

  it("refuses an empty value list at load rather than refusing every call at runtime", () => {
    expect(() => loadManifest(server("    scope: {repo: []}"))).toThrow(/at least one permitted value/);
  });

  it("refuses a glob, which an exact comparison could only ever match nothing", () => {
    // The inert-rule defect the tool policy keeps producing, structurally closed here:
    // `acme/*` reads as a bound and would refuse every call, so it is a load error.
    for (const value of ["acme/*", "*", "*/service"]) {
      expect(() => loadManifest(server(`    scope: {repo: ["${value}"]}`))).toThrow(
        /compared exactly/,
      );
    }
  });

  it("does not care what the argument means — a bound is a bound", () => {
    // Deliberately not repository-shaped. The broker compares strings; what the name means
    // is the third-party server's business, which is what makes this reusable at all.
    const decl = loadManifest(server("    scope: {teamId: [ENG], database: [analytics]}")).mcpServers[0]!;
    expect(resolveMcpServer(decl).scope).toEqual({ teamId: ["ENG"], database: ["analytics"] });
  });

  it("refuses a key nobody implements, rather than ignoring it", () => {
    expect(() => loadManifest(server("    allowFlags: true"))).toThrow();
  });
});

describe("secretRefs and environment names", () => {
  const base = "name: x\nbrain: {provider: mock}\nrespondTo: anyone\n";
  const withServer = (extra: string) =>
    `${base}surfaces: [{kind: console}]\nmcpServers:\n  - name: gh\n    command: node\n${extra}`;

  it("refuses a path-like secretRef in every field that holds one", () => {
    // `resolveSecret` refuses these too — that is what keeps a ref from escaping the mounted
    // secrets directory — but it runs when a surface connects, a server starts, or a job
    // ticks. Refusing at load is the difference between a bundle that cannot deploy and one
    // that deploys and fails later, on a schedule, in a channel.
    const cases: Array<readonly [string, string]> = [
      ["surfaces[].identity", `${base}surfaces: [{kind: buzz, identity: '../TOKEN'}]\n`],
      ["mcpServers[].secrets", withServer("    secrets: {GITHUB_TOKEN: '../TOKEN'}\n")],
      [
        "brains[].token",
        `${base}surfaces: [{kind: console}]\nbrains: [{preset: team, team: team_x, token: '../TOKEN'}]\n`,
      ],
    ];
    for (const [where, yaml] of cases) {
      expect(() => loadManifest(yaml), where).toThrow(/secretRef/);
    }
  });

  it("refuses an environment name a spawn cannot represent, wherever it is declared", () => {
    // A server gets the same check a job does: Node renders each entry as `key=value`, so
    // this key would reach the child as `BAD` holding `KEY=configured`.
    expect(() => loadManifest(withServer("    env: {'BAD=KEY': configured}\n"))).toThrow(
      /environment variable name/,
    );
    expect(() => loadManifest(withServer("    secrets: {'BAD=KEY': GITHUB_TOKEN}\n"))).toThrow(
      /environment variable name/,
    );
    // But a hyphen is not a defect: `MY-CONFIG` reaches the child as `MY-CONFIG`, and this
    // field accepted it before there was any check here at all.
    expect(
      loadManifest(withServer("    env: {'MY-CONFIG': on}\n")).mcpServers[0]!.env,
    ).toEqual({ "MY-CONFIG": "on" });
  });

  it("still takes the names a real bundle writes", () => {
    const manifest = loadManifest(
      withServer("    env: {GH_HOST: github.com}\n    secrets: {GITHUB_TOKEN: DEMO_GH}\n"),
    );
    expect(manifest.mcpServers[0]).toMatchObject({
      env: { GH_HOST: "github.com" },
      secrets: { GITHUB_TOKEN: "DEMO_GH" },
    });
  });
});

describe("jobs", () => {
  const base =
    "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
    "brains: [{preset: local}]\n";

  const declared = {
    slug: "sweep",
    archetype: "sweep",
    description: "'Whole-repo pass for logic that should live in a shared package.'",
    trigger: '{schedules: ["0 3 * * 0"]}',
    killSwitch: "{failDirection: open}",
    budget: "{wallClockMs: 3600000}",
    run: "{command: node, args: [runner/src/sweep.ts]}",
  };

  /** One complete job, with fields replaced, added, or dropped (`undefined`) per test. */
  const jobEntry = (over: Record<string, string | undefined> = {}) =>
    `{${Object.entries({ ...declared, ...over })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")}}`;

  const withJob = (over: Record<string, string | undefined> = {}, prelude = base) =>
    `${prelude}jobs: [${jobEntry(over)}]\n`;

  it("refuses an environment name a spawn cannot represent, at load rather than at 3am", () => {
    // Node renders each entry as `key=value`, so `BAD=KEY` arrives as `BAD` holding
    // `KEY=configured` — the manifest says one thing and the child sees another.
    for (const bad of [
      "{command: node, env: {'BAD=KEY': configured}}",
      "{command: node, secrets: {'BAD=KEY': GH_TOKEN}}",
      "{command: node, passthrough: ['AWS=ROLE']}",
    ]) {
      expect(() => loadManifest(withJob({ run: bad })), bad).toThrow(/environment variable name/);
    }
    expect(
      loadManifest(withJob({ run: "{command: node, env: {LOG_FORMAT: json}, passthrough: [AWS_ROLE_ARN]}" }))
        .jobs[0].run,
    ).toMatchObject({ env: { LOG_FORMAT: "json" }, passthrough: ["AWS_ROLE_ARN"] });
  });

  it("takes any name a spawn keeps intact, rather than enforcing a naming style", () => {
    // `MY-CONFIG`, `my.config` and a name with a space all reach the child unchanged, so
    // refusing them would reject a working configuration. The check is the constraint, not
    // the convention — and `mcpServers[].env` had always accepted these.
    const run =
      "{command: node, env: {'MY-CONFIG': on, 'my.config': on, 'MY CONFIG': on}, passthrough: ['MY-CONFIG']}";
    expect(Object.keys(loadManifest(withJob({ run })).jobs[0].run.env)).toEqual([
      "MY-CONFIG",
      "my.config",
      "MY CONFIG",
    ]);
  });

  it("refuses a path-like secretRef where it is declared, not where it is resolved", () => {
    // `resolveSecret` rejects this too, but a job resolves per run: without a check here the
    // bundle loads, deploys, passes a startup check, and fails on its first schedule.
    expect(() =>
      loadManifest(withJob({ run: "{command: node, secrets: {GH_TOKEN: '../TOKEN'}}" })),
    ).toThrow(/secretRef/);
    expect(
      loadManifest(withJob({ run: "{command: node, secrets: {GH_TOKEN: GH_TOKEN}}" })).jobs[0].run
        .secrets,
    ).toEqual({ GH_TOKEN: "GH_TOKEN" });
  });

  it("defaults the three environment fields to empty, so a job declares its way out of nothing", () => {
    expect(loadManifest(withJob()).jobs[0].run).toEqual({
      command: "node",
      args: ["runner/src/sweep.ts"],
      env: {},
      secrets: {},
      passthrough: [],
    });
  });

  it("is absent unless declared — an agent with no scheduled work is the default", () => {
    expect(loadManifest(base).jobs).toEqual([]);
  });

  it("fills the bounds a declaration leaves out, and nothing else", () => {
    const job = loadManifest(withJob()).jobs[0];
    expect(job).toMatchObject({
      slug: "sweep",
      archetype: "sweep",
      suspend: false,
      trigger: { schedules: ["0 3 * * 0"], timezone: "UTC", onRequest: false, webhook: false },
      budget: {
        wallClockMs: 3_600_000,
        deadlineHeadroomMs: 300_000,
        harnessTimeoutMs: 600_000,
        maxIterations: 2,
        maxAttempts: 3,
      },
      run: { command: "node", args: ["runner/src/sweep.ts"] },
    });
    // Nothing implies a spend cap, a model tier, or a place to report.
    expect(job.budget.maxSpendUsd).toBeUndefined();
    expect(job.model).toBeUndefined();
    expect(job.report).toBeUndefined();
    expect(loadManifest(withJob({ run: "{command: node}" })).jobs[0].run.args).toEqual([]);
  });

  it("derives the switch key from the slug, so the two cannot name different jobs", () => {
    expect(loadManifest(withJob()).jobs[0].killSwitch?.key).toBe("mem/sweep/enabled");
    expect(
      loadManifest(withJob({ killSwitch: "{failDirection: open, key: mem/shift/enabled}" }))
        .jobs[0].killSwitch?.key,
    ).toBe("mem/shift/enabled");
  });

  it("requires a fail-direction, so the wrong one cannot be inherited", () => {
    expect(() => loadManifest(withJob({ killSwitch: "{}" }))).toThrow();
    expect(() => loadManifest(withJob({ killSwitch: "{failDirection: maybe}" }))).toThrow();
    expect(loadManifest(withJob({ killSwitch: "{failDirection: closed}" })).jobs[0].killSwitch)
      .toMatchObject({ failDirection: "closed" });
  });

  it("refuses an unattended job that nothing can stop without a deploy", () => {
    expect(() => loadManifest(withJob({ killSwitch: undefined }))).toThrow(/killSwitch/);
    expect(() =>
      loadManifest(withJob({ trigger: "{webhook: true}", killSwitch: undefined })),
    ).toThrow(/killSwitch/);
    // A human is on the other end of an on-request run and can stop it themselves.
    expect(() =>
      loadManifest(withJob({ trigger: "{onRequest: true}", killSwitch: undefined })),
    ).not.toThrow();
  });

  it("takes no parameters unless a job declares them", () => {
    expect(loadManifest(withJob()).jobs[0].parameters).toEqual({});
  });

  it("declares a target, with its bound in the manifest rather than in the body", () => {
    const job = loadManifest(
      withJob({
        trigger: "{onRequest: true}",
        parameters:
          "{issue: {type: integer, minimum: 1, required: true, description: 'Which issue to triage.'}, " +
          "doc: {type: string, pattern: '^[a-z-]+$', description: 'Which document.'}, " +
          "env: {type: string, values: [staging, production], description: 'Which environment.'}}",
      }),
    ).jobs[0];

    expect(job.parameters.issue).toEqual({
      type: "integer",
      minimum: 1,
      required: true,
      description: "Which issue to triage.",
    });
    expect(job.parameters.doc).toMatchObject({ type: "string", required: false });
    expect(job.parameters.env).toMatchObject({ values: ["staging", "production"] });
  });

  it("refuses a mode dressed as a parameter — a mode is a second slug", () => {
    for (const spec of [
      "{quick: {type: boolean, description: 'Fast pass.'}}",
      "{mode: {type: enum, values: [quick, full], description: 'Which pass.'}}",
    ]) {
      expect(() =>
        loadManifest(withJob({ trigger: "{onRequest: true}", parameters: spec })),
      ).toThrow();
    }
  });

  it("bounds a string by a list or a pattern, and needs exactly one of the two", () => {
    const bounded = (bound: string) =>
      withJob({
        trigger: "{onRequest: true}",
        parameters: `{doc: {type: string, description: 'Which document.'${bound}}}`,
      });

    // Unbounded is the free-form argument the whole design avoids; two bounds is two places
    // to look when a caller is refused.
    expect(() => loadManifest(bounded(""))).toThrow(/bounded by `values` or by `pattern`/);
    expect(() =>
      loadManifest(bounded(", values: [a, b], pattern: '^[ab]$'")),
    ).toThrow(/exactly one/);

    // A closed list is the narrowest a target gets: which environment, which region.
    expect(loadManifest(bounded(", values: [staging, production]")).jobs[0].parameters.doc)
      .toMatchObject({ values: ["staging", "production"] });
    // And a pattern is for the targets nobody can list: an id, a slug, a branch.
    expect(loadManifest(bounded(", pattern: '^[a-z-]+$'")).jobs[0].parameters.doc)
      .toMatchObject({ pattern: "^[a-z-]+$" });
    // Refused for the same backtracking a leak pattern is refused for: this process runs it.
    expect(() => loadManifest(bounded(", pattern: '^(a+)+$'"))).toThrow(/quantifier/);
    // Free text stays writable, in one line a reviewer sees.
    expect(loadManifest(bounded(", pattern: '.*'")).jobs[0].parameters.doc).toMatchObject({
      pattern: ".*",
    });
  });

  it("refuses a name that two declarations would collapse into one variable", () => {
    // A body reads `JOB_PARAM_ISSUE`, so `issue` and `ISSUE` are one variable — and the
    // second declaration would silently win.
    expect(() =>
      loadManifest(
        withJob({
          trigger: "{onRequest: true}",
          parameters: "{ISSUE: {type: integer, description: 'Which issue.'}}",
        }),
      ),
    ).toThrow(/lower-case/);
  });

  it("refuses a required target on a trigger that has nothing to give it", () => {
    const needs = (trigger: string) =>
      withJob({
        trigger,
        parameters: "{issue: {type: integer, required: true, description: 'Which issue.'}}",
      });
    expect(() => loadManifest(needs('{schedules: ["0 3 * * 0"], onRequest: true}'))).toThrow(
      /required parameter may only be started on request/,
    );
    expect(() => loadManifest(needs("{webhook: true, onRequest: true}"))).toThrow(
      /required parameter may only be started on request/,
    );
    // Not required is fine alongside a clock: those ticks simply get no value.
    expect(() =>
      loadManifest(
        withJob({
          trigger: '{schedules: ["0 3 * * 0"], onRequest: true}',
          parameters: "{issue: {type: integer, description: 'Which issue.'}}",
        }),
      ),
    ).not.toThrow();
  });

  it("refuses a parameter on a job nothing may ask for, which could never be filled", () => {
    expect(() =>
      loadManifest(withJob({ parameters: "{issue: {type: integer, description: 'Which issue.'}}" })),
    ).toThrow(/must arm `trigger.onRequest`/);
  });

  it("refuses a switch on an agent with no brain to read it from", () => {
    const brainless =
      "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n";
    expect(() => loadManifest(withJob({}, brainless))).toThrow(
      /read through one of the agent's brains/,
    );
  });

  it("refuses a job nothing can ever start", () => {
    expect(() => loadManifest(withJob({ trigger: "{}" }))).toThrow(/never run/);
  });

  it("permits an on-request-only job, which the fleet had to fake a cron for", () => {
    const job = loadManifest(
      withJob({ slug: "queue", archetype: "queue", trigger: "{onRequest: true}" }),
    ).jobs[0];
    expect(job.trigger).toMatchObject({ schedules: [], onRequest: true });
  });

  it("refuses a duplicate cron expression, which renders two jobs on one tick", () => {
    expect(() =>
      loadManifest(withJob({ trigger: '{schedules: ["0 3 * * 0", "0 3 * * 0"]}' })),
    ).toThrow(/duplicate/);
    // Trimmed first, so surrounding space cannot make one schedule look like two.
    expect(() =>
      loadManifest(withJob({ trigger: '{schedules: ["0 3 * * 0", " 0 3 * * 0 "]}' })),
    ).toThrow(/duplicate/);
  });

  it("refuses a schedule the wrong shape, which would load and then have no job", () => {
    for (const schedule of ["not-a-cron", "'every sunday'", '"0 3 * *"', '"0 3 * * 0 2026"']) {
      expect(() =>
        loadManifest(withJob({ trigger: `{schedules: [${schedule}]}` })),
      ).toThrow(/cron/);
    }
  });

  it("refuses a number outside what its field counts", () => {
    // Each is five well-formed fields, and each is a job the scheduler will not create.
    for (const schedule of ['"0 99 * * *"', '"70 3 * * *"', '"0 3 32 * *"', '"0 3 * 13 *"']) {
      expect(() =>
        loadManifest(withJob({ trigger: `{schedules: [${schedule}]}` })),
      ).toThrow(/cron/);
    }
  });

  it("leaves field syntax to the scheduler, so a legal expression stays writable", () => {
    for (const schedule of [
      '"@weekly"',
      '"@every 1h30m"',
      '"*/15 9-17 * * MON-FRI"',
      '"0 0,12 1-15 JAN,JUL *"',
      '"0 3 * * 7"', // 7 is Sunday twice over in most crons
      '"*/90 * * * *"', // a stride wider than the field selects one point, and is legal
    ]) {
      expect(() =>
        loadManifest(withJob({ trigger: `{schedules: [${schedule}]}` })),
      ).not.toThrow();
    }
  });

  it("refuses a time zone nothing can resolve, rather than a job that never exists", () => {
    for (const timezone of ["'UTC+5'", "Europe/Londin", "''"]) {
      expect(() =>
        loadManifest(withJob({ trigger: `{schedules: ["0 3 * * 0"], timezone: ${timezone}}` })),
      ).toThrow(/IANA/);
    }
    expect(
      loadManifest(
        withJob({ trigger: '{schedules: ["0 3 * * 0"], timezone: America/New_York}' }),
      ).jobs[0].trigger.timezone,
    ).toBe("America/New_York");
  });

  it("takes four archetypes and no fifth — `call` is `onRequest`, spelled twice", () => {
    for (const archetype of ["watch", "shift", "sweep", "queue"]) {
      expect(loadManifest(withJob({ archetype })).jobs[0].archetype).toBe(archetype);
    }
    expect(() => loadManifest(withJob({ archetype: "call" }))).toThrow();
  });

  it("requires a slug that can name a job, a switch, and a record", () => {
    for (const slug of ["Sweep", "1sweep", "sweep_nightly", "'sweep nightly'", "''"]) {
      expect(() => loadManifest(withJob({ slug }))).toThrow();
    }
  });

  it("refuses two jobs under one slug, which would collide on all three", () => {
    expect(() => loadManifest(`${base}jobs: [${jobEntry()}, ${jobEntry()}]\n`)).toThrow(
      /unique/,
    );
    expect(() =>
      loadManifest(`${base}jobs: [${jobEntry()}, ${jobEntry({ slug: "shift" })}]\n`),
    ).not.toThrow();
  });

  it("requires a wall clock, and a spend cap that comparisons can trust", () => {
    expect(() => loadManifest(withJob({ budget: "{}" }))).toThrow();
    expect(() => loadManifest(withJob({ budget: "{wallClockMs: 0}" }))).toThrow();
    // `NaN` and `Infinity` compare false against every affordability check, so a poisoned
    // cap waves calls through instead of bowing out.
    for (const cap of [".inf", ".nan", "-1"]) {
      expect(() =>
        loadManifest(withJob({ budget: `{wallClockMs: 3600000, maxSpendUsd: ${cap}}` })),
      ).toThrow();
    }
  });

  it("reports only to a surface this agent declares", () => {
    expect(() =>
      loadManifest(withJob({ report: "{surface: buzz, channel: hive}" })),
    ).toThrow(/report.surface/);
    expect(
      loadManifest(withJob({ report: "{surface: console, channel: hive}" })).jobs[0].report,
    ).toEqual({ surface: "console", channel: "hive", announce: "unproven", probe: false });
  });

  it("gates the status post on the verdict unless the job says otherwise", () => {
    // The default is the behaviour every job had before the field existed: a run that
    // proved itself says nothing. A job that declares nothing cannot become noisier.
    const declared = (report: string) =>
      loadManifest(withJob({ report })).jobs[0].report?.announce;
    expect(declared("{surface: console, channel: hive}")).toBe("unproven");
    expect(declared("{surface: console, channel: hive, announce: always}")).toBe("always");
    expect(declared("{surface: console, channel: hive, announce: reported}")).toBe("reported");

    // A mode nobody implements is refused rather than read as the default. Silently
    // falling back is how a job meant to be heard stays silent on a clean run — the exact
    // failure this field exists to end.
    // On the enum rather than the field name: a schema that had dropped `announce`
    // altogether would throw `Unrecognized key: "announce"` and satisfy a looser match.
    expect(() =>
      loadManifest(withJob({ report: "{surface: console, channel: hive, announce: sometimes}" })),
    ).toThrow(/expected one of/);
  });

  it("pins its own model, independent of the brain's", () => {
    expect(loadManifest(withJob({ model: "claude-sonnet-5" })).jobs[0].model).toBe(
      "claude-sonnet-5",
    );
  });

  it("refuses a key nobody implements, rather than ignoring it", () => {
    expect(() => loadManifest(withJob({ cadence: "hourly" }))).toThrow(/unrecognized/i);
    // Quiet hours are cron's job; a second overlapping window would be two ways to say one
    // thing with no rule for what happens when they disagree.
    expect(() =>
      loadManifest(withJob({ trigger: '{schedules: ["0 3 * * 0"], quietHours: 22-06}' })),
    ).toThrow(/unrecognized/i);
    // The artifact-counting bounds belong to the runner, which knows what a PR is.
    expect(() =>
      loadManifest(withJob({ budget: "{wallClockMs: 3600000, maxOpenPrs: 2}" })),
    ).toThrow(/unrecognized/i);
  });
});
