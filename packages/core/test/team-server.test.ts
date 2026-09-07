import { describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  teamBrainHandler,
  formatPassages,
  makeOxTeam,
  classifyOxFailure,
  OX_FAILURE_TEXT,
  TEAM_TOOL_NAMES,
  type OxFailure,
  type OxScope,
  type TeamBrain,
  type TeamOx,
  type TeamPassage,
  type TeamSearch,
  passageDate,
} from "../src/team-server.ts";
import { describeHealth, isActionable, isDegrading, needsHuman } from "../src/health.ts";

const passages: TeamPassage[] = [
  { score: 0.94, text: "We chose Postgres over DynamoDB for the ledger.", doc_type: "adr", file_path: "docs/adr/012.md" },
  { score: 0.71, text: "Migrations run in the deploy window.", source_type: "session", source_id: "sess_9" },
];

const search = async (q: string) => (q === "nothing" ? [] : passages);

/** A team surface with no `ox` behind it, so the handler's own behaviour is what is tested. */
function fakeOx(over: Partial<TeamOx> = {}): TeamOx {
  return {
    search,
    ledgerStatus: async () => [],
    sessions: async () => { throw new Error("no ledger configured"); },
    recent: async () => { throw new Error("no ledger configured"); },
    ...over,
  };
}

/**
 * Waits for a condition rather than for a duration. A test that sleeps its way to an
 * ordering asserts how loaded the machine was, and passes on either answer.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Puts a fake `ox` on PATH for the duration of `body`, with the audit lines it logs
 * captured. The child runs with its cwd set to the same directory, so a script can gate on
 * a marker file the body writes there — which is how one brain sees a credential die and
 * come back. Pass no script to put nothing on PATH at all.
 */
async function withFakeOx<T>(
  script: string | undefined,
  body: (brain: TeamBrain, bin: string) => Promise<T>,
  // Taken as a function of the directory, because the only scope any test here varies is
  // the credential, and a credential is a path under it.
  scope: (bin: string) => OxScope = () => ({}),
): Promise<{ value: T; log: string }> {
  const bin = mkdtempSync(join(tmpdir(), "ox-fake-"));
  if (script !== undefined) writeFileSync(join(bin, "ox"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = script === undefined ? bin : `${bin}:${previousPath ?? ""}`;
  const logged: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((line) => void logged.push(String(line)));
  let brain: TeamBrain | undefined;
  try {
    brain = makeOxTeam({ team: "team_x", cwd: bin, ...scope(bin) });
    const value = await body(brain, bin);
    return { value, log: logged.join("\n") };
  } finally {
    await brain?.stopSync();
    warn.mockRestore();
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

const call = (name: string, args: Record<string, unknown> = {}, ox: TeamOx = fakeOx()) =>
  teamBrainHandler(ox)({ id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<{
    content: Array<{ text: string }>;
  }>;

const text = async (name: string, args?: Record<string, unknown>, ox?: TeamOx) =>
  (await call(name, args, ox)).content[0].text;

describe("team brain", () => {
  it("offers the read verbs the fleet uses, and no way to write", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const names = listed.tools.map((t) => t.name);

    expect(names).toEqual(["team_search", "team_status", "team_sessions", "team_recent"]);
    expect(names.some((n) => /write|put|add|create|invite/.test(n))).toBe(false);
    expect(TEAM_TOOL_NAMES).toEqual(names);
  });

  it("tells the brain a name, a description and a schema — never how the tool runs", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<Record<string, unknown>>;
    };
    for (const tool of listed.tools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });

  it("refuses a tool it does not serve, so team memory cannot be authored", async () => {
    await expect(
      teamBrainHandler(fakeOx())({ id: 1, method: "tools/call", params: { name: "team_write", arguments: {} } }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("returns passages with where they came from", async () => {
    const out = await text("team_search", { query: "database" });

    expect(out).toContain("docs/adr/012.md");
    expect(out).toContain("adr");
    expect(out).toContain("Postgres over DynamoDB");
    expect(out).toContain("sess_9"); // provenance even without a file path
  });

  it("treats an empty result as an answer, not a failure", () => {
    const out = formatPassages("nothing", []);
    expect(out).toMatch(/has nothing/i);
    expect(out).toMatch(/not that the search failed/i);
  });

  it("passes the caller's limit through to the search", async () => {
    let seen = 0;
    const searchWithLimit: TeamSearch = async (_q, limit) => {
      seen = limit;
      return [];
    };
    await call("team_search", { query: "x", limit: 12 }, fakeOx({ search: searchWithLimit }));
    expect(seen).toBe(12);
  });

  it("bounds the limit, because every passage is read into a turn", async () => {
    await expect(call("team_search", { query: "x", limit: 500 })).rejects.toThrow();
  });

  it("publishes that bound in the schema, so a caller learns it before being refused", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, { maximum?: number }> } }>;
    };
    const search = listed.tools.find((tool) => tool.name === "team_search")!;
    expect(search.inputSchema.properties.limit.maximum).toBe(20);
    // The advertised maximum and the enforced one are the same number, not two numbers
    // that happen to agree today.
    await expect(call("team_search", { query: "x", limit: 21 })).rejects.toThrow();
    await expect(call("team_search", { query: "x", limit: 20 })).resolves.toBeDefined();
  });

  it("reports a search failure instead of returning silence", async () => {
    await expect(
      call("team_search", { query: "x" }, fakeOx({
        search: async () => {
          throw new Error("the `ox` CLI is not on PATH");
        },
      })),
    ).rejects.toThrow(/not on PATH/);
  });
});

describe("team status (#24)", () => {
  const PLANTED = "oxp_planted-status-secret";

  it.each([
    { label: "empty", results: [] },
    { label: "populated", results: passages },
  ])("checks search access without claiming ledger readiness ($label)", async ({ results }) => {
    const { value } = await withFakeOx(
      `printf '%s\\n' "$@" > ./argv\ncat ./reply`,
      async (brain, bin) => {
        writeFileSync(join(bin, "reply"), JSON.stringify({
          team_context: { results },
          // Neither an ambient daemon's health nor its old checkout proves that this
          // runtime syncs its ledger. None of these extra fields belongs in the reply.
          daemon: { health: "healthy", errors: 0 },
          ledger: { last_sync: "2026-01-01T00:00:00Z", path: `/private/${PLANTED}` },
          auth: { access_token: PLANTED, user: PLANTED },
        }));
        const output = await text("team_status", {}, brain);
        return { output, args: readFileSync(join(bin, "argv"), "utf8").trim().split("\n") };
      },
    );
    const status = JSON.parse(value.output);
    expect(status.team_search.status).toBe("available");
    expect(status.ledger_sync.status).toBe("not_configured");
    expect(status.ledger_sync.detail).toMatch(/activity.*session history/i);
    expect(Object.keys(status).sort()).toEqual(["ledger_sync", "team_search"]);
    expect(value.output).not.toContain(PLANTED);
    expect(value.output).not.toContain("2026-01-01");
    expect(value.output).not.toContain("Postgres");
    expect(value.args).toEqual(["query", "team", "--json", "--limit", "1", "--team", "team_x"]);
  });

  it.each([
    ["not-installed", undefined],
    ["not-authenticated", `echo 'not authenticated: ${PLANTED}' >&2; exit 1`],
    ["failed", `echo 'service unavailable: ${PLANTED}' >&2; exit 1`],
    ["unreadable", `echo '${PLANTED}'`],
  ] as const)("reports %s without returning subprocess diagnostics", async (failure, script) => {
    const { value } = await withFakeOx(script, (brain) => text("team_status", {}, brain));
    expect(JSON.parse(value)).toMatchObject({
      team_search: { status: "unavailable", failure, detail: OX_FAILURE_TEXT[failure] },
      ledger_sync: { status: "not_configured" },
    });
    expect(value).not.toContain(PLANTED);
  });

  it.each([
    null,
    {},
    { team_context: { results: null } },
    { team_context: { results: [{ score: "0.9", text: "wrong score type" }] } },
    { team_context: { results: [{ score: 0.9 }] } },
  ])("does not claim access from a malformed search response (%j)", async (reply) => {
    const { value } = await withFakeOx("cat ./reply", async (brain, bin) => {
      writeFileSync(join(bin, "reply"), JSON.stringify(reply));
      return text("team_status", {}, brain);
    });
    expect(JSON.parse(value).team_search).toMatchObject({ status: "unavailable", failure: "unreadable" });
  });

  it("keeps an unexpected error's text out of status too", async () => {
    const output = await text("team_status", {}, fakeOx({ search: async () => { throw new Error(PLANTED); } }));
    expect(JSON.parse(output).team_search).toMatchObject({ status: "unavailable", failure: "failed" });
    expect(output).not.toContain(PLANTED);
  });

  it.each(["file", "repo", "team", "token", "command"])("rejects an undeclared %s before running ox", async (key) => {
    const search = vi.fn();
    await expect(call("team_status", { [key]: PLANTED }, fakeOx({ search }))).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("uses each call's result even when the last latched health is still Ok", async () => {
    const { value } = await withFakeOx(
      `if [ -f ./fail ]; then echo 'service unavailable' >&2; exit 1; fi\necho '{"team_context":{"results":[]}}'`,
      async (brain, bin) => {
        await text("team_status", {}, brain);
        writeFileSync(join(bin, "fail"), "");
        const output = await text("team_status", {}, brain);
        return { output, health: brain.readings()[0].health };
      },
    );
    expect(value.health).toBe("Ok"); // Transient failures deliberately do not latch.
    expect(JSON.parse(value.output).team_search).toMatchObject({ status: "unavailable", failure: "failed" });
  });

  it("discloses rejection and recovers on credential rotation without retrying a call", async () => {
    const { value } = await withFakeOx(
      `echo lookup >> ./calls\n` +
      `if [ "$SAGEOX_TOKEN" != "oxp_rotated" ]; then echo 'not authenticated' >&2; exit 1; fi\n` +
      `echo '{"team_context":{"results":[]}}'`,
      async (brain, bin) => {
        writeFileSync(join(bin, "secret"), PLANTED);
        const rejected = await text("team_status", {}, brain);
        const health = brain.readings()[0].health;
        writeFileSync(join(bin, "secret"), "oxp_rotated");
        const recovered = await text("team_status", {}, brain);
        // Team search remains usable, and all calls use the same bound credential.
        await expect(brain.search("deploys", 1)).resolves.toEqual([]);
        return { rejected, recovered, health, after: brain.readings()[0].health,
          calls: readFileSync(join(bin, "calls"), "utf8").trim().split("\n") };
      },
      (bin) => ({ token: () => readFileSync(join(bin, "secret"), "utf8").trim() }),
    );
    expect(JSON.parse(value.rejected).team_search.failure).toBe("not-authenticated");
    expect(JSON.parse(value.recovered).team_search.status).toBe("available");
    expect([value.health, value.after]).toEqual(["Unavailable", "Ok"]);
    expect(value.calls).toHaveLength(3);
    expect(value.rejected + value.recovered).not.toMatch(/oxp_/);
  });
});

describe("repository ledger readers (#24)", () => {
  const SCRIPT = [
    'printf "%s\\n" "$PWD|$*|$XDG_DATA_HOME" >> "${0%/*}/calls"',
    'printf "%s\\n" "$OX_PROJECT_ROOT|$XDG_CACHE_HOME" > ./scope-seen',
    'case "$1 $2" in',
    '  "query team")',
    '    if [ -f ./required-token ] && [ "$SAGEOX_TOKEN" != "$(cat ./required-token)" ]; then echo "not authenticated" >&2; exit 1; fi',
    `    echo '{"team_context":{"results":[]}}';;`,
    '  "status --json") cat ./status.json;;',
    '  "daemon status") cat ./daemon.json;;',
    '  "session list") if [ "$AGENT_ENV" != "claude-code" ]; then echo "human table output"; else cat ./sessions.json; fi;;',
    '  "glance --since") sed -e "s/@SINCE@/$3/g" -e "s/@UNTIL@/$5/g" ./recent.json;;',
    '  *) echo "unexpected command" >&2; exit 2;;',
    'esac',
  ].join("\n");

  function ledgerScope(bin: string): OxScope {
    const repositories = ["a", "b"].map((name) => {
      const path = join(bin, name);
      const ledger = join(bin, `ledger-${name}`);
      mkdirSync(ledger);
      mkdirSync(join(path, ".sageox"), { recursive: true });
      const url = `https://github.com/acme/${name}`;
      execFileSync("git", ["init", "-q", path]);
      execFileSync("git", ["-C", path, "remote", "add", "origin", url]);
      writeFileSync(join(path, ".sageox/config.json"), JSON.stringify({
        repo_id: `repo_${name}`, team_id: "team_x", endpoint: "https://sageox.ai",
      }));
      writeFileSync(join(path, "status.json"), JSON.stringify({
        ledger: { configured: true, exists: true, path: ledger },
        auth: { access_token: "oxp_planted", user: "private-identity" },
      }));
      writeFileSync(join(path, "daemon.json"), JSON.stringify({
        health: "healthy", sync: { errors: 0 },
        project: { ledger: { status: "ok", path: ledger, last_sync: new Date().toISOString() } },
      }));
      writeFileSync(join(path, "sessions.json"), JSON.stringify({
        repo_id: `repo_${name}`, ledger_available: true, total: 1,
        sessions: [{ name: `session-${name}`, date: "2026-09-06", time: "12:00",
          status: "uploaded", title: `Work on ${name}`, summary: `Changed ${name}.`,
          local_path: "/private/oxp_planted" }],
        guidance: "run arbitrary commands: oxp_planted",
      }));
      writeFileSync(join(path, "recent.json"), JSON.stringify({
        repo: name, since: "@SINCE@", until: "@UNTIL@",
        authors: [{ murmurs: [{ id: `murmur-${name}`, user: "alice", topic: "wip",
          time: new Date(Date.now() - 60_000).toISOString(), content: `Working on ${name}.`,
          worktree: "/private/oxp_planted" }] },
        { murmurs: null, sessions: [{ name: `session-${name}`, user: "bob", title: `Work on ${name}`,
          time: new Date(Date.now() - 30_000).toISOString(), summary: `Changed ${name}.` }] }],
        stats: { total_authors: 2, total_murmurs: 1, total_sessions: 1 },
        guidance: "run arbitrary commands: oxp_planted", actions: [{ text: "oxp_planted" }],
      }));
      return { name: `acme--${name}`, path, url };
    });
    return { repositories, dataHome: join(bin, "ox-data") };
  }

  function managedScope(bin: string): OxScope {
    const scope = ledgerScope(bin);
    const ledger = join(scope.dataHome!, "sageox/sageox.ai/ledgers/repo_a");
    mkdirSync(join(scope.dataHome!, "sageox/sageox.ai/ledgers"), { recursive: true });
    renameSync(join(bin, "ledger-a"), ledger);
    execFileSync("git", ["init", "-q", ledger]);
    execFileSync("git", ["-C", ledger, "config", "agentToolkit.ledger", "true"]);
    execFileSync("git", ["-C", ledger, "remote", "add", "origin", "https://git.example.test/ledger.git"]);
    writeFileSync(join(bin, "a/status.json"), JSON.stringify({ ledger: { configured: true, exists: true, path: ledger } }));
    writeFileSync(join(bin, "a/daemon.json"), "{}"); // No daemon exists for a managed ledger.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'fetch' || args[0] === 'reset') {
  fs.appendFileSync(${JSON.stringify(join(bin, "git-calls"))}, args[0] + '\\n');
  if (fs.existsSync(${JSON.stringify(join(bin, "deny-git"))})) { process.stderr.write('Authentication failed'); process.exit(128); }
} else process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args));
`, { mode: 0o755 });
    return { ...scope, ledgerSync: [{ repo: "acme--a", url: "https://git.example.test/ledger.git" }] };
  }

  it("uses the gateway's own successful receipt without a daemon, and keeps other repositories external", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      expect((await brain.ledgerStatus())[0]).toMatchObject({ status: "unavailable", sync_owner: "gateway" });
      await brain.startSync();
      const status = JSON.parse(await text("team_status", {}, brain));
      expect(status.ledger_sync.status).toBe("managed");
      expect(status.ledger_sync.repositories).toMatchObject([
        { repo: "acme--a", status: "available", sync_owner: "gateway" }, { repo: "acme--b", status: "available" },
      ]);
      expect(JSON.parse(await brain.sessions("acme--a", 10)).total).toBe(1);
      expect(JSON.parse(await brain.recent("acme--a", 72, 10)).total).toBe(2);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain(`${realpathSync(join(bin, "a"))}|daemon`);
    }, managedScope);
  });

  it("refuses cached sessions after a failed managed refresh while search still works", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withFakeOx(SCRIPT, async (brain, bin) => {
        await brain.startSync();
        writeFileSync(join(bin, "deny-git"), "");
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(brain.sessions("acme--a", 10)).rejects.toThrow(/Git authentication failed/);
        expect((await brain.ledgerStatus())[0].status).toBe("unavailable");
        expect(await brain.search("team", 1)).toEqual([]);
      }, managedScope);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { repo_id: "repo_a", team_id: "team_foreign" },
    { repo_id: "repo_a/../../escape", team_id: "team_x" },
  ])("verifies the project before starting Git sync (%j)", async (config) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/.sageox/config.json"), JSON.stringify(config));
      await brain.startSync();
      expect((await brain.ledgerStatus())[0].status).toBe("unavailable");
      expect(existsSync(join(bin, "git-calls"))).toBe(false);
    }, managedScope);
  });

  it("lists populated sessions from each selected cwd with bounded argv and isolated state", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      for (const name of ["a", "b"]) {
        const output = await text("team_sessions", { repo: `acme--${name}`, limit: 2 }, brain);
        expect(JSON.parse(output)).toMatchObject({
          repo: `acme--${name}`, repo_id: `repo_${name}`, window: "past seven days", total: 1,
          sessions: [{ name: `session-${name}`, title: `Work on ${name}` }],
        });
        expect(JSON.parse(output).last_sync).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(output).not.toMatch(/oxp_planted|private-identity|arbitrary commands|local_path/);
      }
      const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
      expect(calls.filter((line) => line.includes("|session list"))).toEqual([
        `${realpathSync(join(bin, "a"))}|session list --json --limit 2|${join(bin, "ox-data")}`,
        `${realpathSync(join(bin, "b"))}|session list --json --limit 2|${join(bin, "ox-data")}`,
      ]);
      expect(calls.every((line) => /\|(query team|status --json|daemon status|session list)/.test(line))).toBe(true);
      expect(readFileSync(join(bin, "a/scope-seen"), "utf8").trim()).toBe(`${join(bin, "a")}|${join(bin, "ox-data/cache")}`);
      expect(readFileSync(join(bin, "b/scope-seen"), "utf8").trim()).toBe(`${join(bin, "b")}|${join(bin, "ox-data/cache")}`);
      const readings = brain.readings();
      expect(readings.map((r) => r.capability)).toEqual(["brain.team", "ledger:acme--a", "ledger:acme--b"]);
      expect(readings.every((r) => r.health === "Ok")).toBe(true);
    }, ledgerScope);
  });

  it("reports a genuinely empty fresh ledger with the receipt, rather than a missing source", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: true, sessions: [], total: 0,
      }));
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain))).toMatchObject({
        sessions: [], total: 0, last_sync: expect.any(String),
      });
    }, ledgerScope);
  });

  it("merges recent work updates and sessions by time, with a repeatable bounded window per repository", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      for (const name of ["a", "b"]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const output = await text("team_recent", { repo: `acme--${name}`, hours: 24, limit: 2 }, brain);
          const recent = JSON.parse(output);
          expect(recent).toMatchObject({ repo: `acme--${name}`, repo_id: `repo_${name}`,
            total: 2, truncated: false, last_sync: expect.any(String), activities: [
              { kind: "session", name: `session-${name}`, title: `Work on ${name}` },
              { kind: "murmur", id: `murmur-${name}`, content: `Working on ${name}.` },
            ] });
          expect(Date.parse(recent.until) - Date.parse(recent.since)).toBe(24 * 60 * 60_000);
          expect(output).not.toMatch(/oxp_planted|worktree|guidance|actions/);
        }
        const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n")
          .filter((line) => line.startsWith(`${realpathSync(join(bin, name))}|glance`));
        expect(calls).toHaveLength(2);
        for (const command of calls) {
          expect(command).toMatch(/\|glance --since \S+ --until \S+ --json\|/);
          expect(command).toContain(`|${join(bin, "ox-data")}`);
        }
      }
    }, ledgerScope);
  });

  it("uses the default 72-hour window and discloses a limited activity list", async () => {
    await withFakeOx(SCRIPT, async (brain) => {
      const recent = JSON.parse(await text("team_recent", { repo: "acme--a", limit: 1 }, brain));
      expect(recent).toMatchObject({ total: 2, truncated: true, activities: [{ kind: "session" }] });
      expect(Date.parse(recent.until) - Date.parse(recent.since)).toBe(72 * 60 * 60_000);
    }, ledgerScope);
  });

  it("bounds long activity text without forwarding arbitrary metadata", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      const fixture = JSON.parse(readFileSync(join(bin, "a/recent.json"), "utf8"));
      fixture.authors[0].murmurs[0].content = "x".repeat(5000);
      fixture.authors[1].sessions[0].title = "t".repeat(5000);
      fixture.authors[1].sessions[0].summary = "s".repeat(5000);
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      const recent = JSON.parse(await text("team_recent", { repo: "acme--a" }, brain));
      expect(recent.activities[0].title).toBe("t".repeat(2000) + "…");
      expect(recent.activities[0].summary).toBe("s".repeat(2000) + "…");
      expect(recent.activities[1].content).toBe("x".repeat(2000) + "…");
    }, ledgerScope);
  });

  it("returns a fresh empty activity window with zero totals", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify({
        repo: "a", since: "@SINCE@", until: "@UNTIL@", authors: [],
        stats: { total_authors: 0, total_murmurs: 0 },
      }));
      expect(JSON.parse(await text("team_recent", { repo: "acme--a" }, brain))).toMatchObject({
        total: 0, truncated: false, activities: [], last_sync: expect.any(String),
      });
    }, ledgerScope);
  });

  it.each(["missing", "stale", "mismatched"])("refuses a %s ledger before running glance", async (kind) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      if (kind === "missing") {
        writeFileSync(join(bin, "a/status.json"), JSON.stringify({ ledger: { configured: true, exists: false } }));
      } else {
        writeFileSync(join(bin, "a/daemon.json"), JSON.stringify({ project: { ledger: {
          status: "ok", path: join(bin, kind === "mismatched" ? "ledger-b" : "ledger-a"),
          last_sync: new Date(Date.now() - (kind === "stale" ? 6 * 60_000 : 0)).toISOString(),
        } } }));
      }
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("|glance");
      expect(brain.readings().find((reading) => reading.capability === "ledger:acme--a")?.health).toBe("Unavailable");
      await expect(brain.search("team", 1)).resolves.toEqual([]);
    }, ledgerScope);
  });

  it.each([null, {}, { repo: "a", authors: [] }, { ledger_available: false },
    { repo: "a", since: "@SINCE@", until: "@UNTIL@", authors: [], stats: { total_authors: 0, total_murmurs: 1 } },
  ])("rejects malformed activity or inconsistent empty counts (%j)", async (fixture) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(/could not read/);
      expect(brain.readings().find((reading) => reading.capability === "ledger:acme--a")?.health).toBe("Unavailable");
    }, ledgerScope);
  });

  it.each(["repo", "since", "until", "event time"])("rejects a response with a mismatched %s", async (field) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      const fixture = JSON.parse(readFileSync(join(bin, "a/recent.json"), "utf8"));
      if (field === "event time") fixture.authors[0].murmurs[0].time = "2000-01-01T00:00:00Z";
      else fixture[field] = field === "repo" ? "b" : "2000-01-01T00:00:00Z";
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
    }, ledgerScope);
  });

  it.each([
    { repo: "../a" }, { repo: "acme--a", hours: 0 }, { repo: "acme--a", hours: 169 },
    { repo: "acme--a", hours: 1.5 }, { repo: "acme--a", hours: "--file=/private/secret" },
    { repo: "acme--a", limit: 21 }, { repo: "acme--a", until: "/private/secret" },
  ])("rejects unbounded activity inputs and extra flags before invoking ox (%j)", async (args) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      await expect(text("team_recent", args, brain)).rejects.toThrow();
      expect(existsSync(join(bin, "calls"))).toBe(false);
    }, ledgerScope);
  });

  it("sanitizes glance failures and recovers on the next successful activity read", async () => {
    const failing = SCRIPT.replace('"glance --since") sed',
      '"glance --since") if [ -f ./fail ]; then echo "ledger not available: oxp_planted" >&2; exit 1; fi; sed');
    await withFakeOx(failing, async (brain, bin) => {
      writeFileSync(join(bin, "a/fail"), "");
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(OX_FAILURE_TEXT.failed);
      expect(brain.readings().find((reading) => reading.capability === "ledger:acme--a")?.health).toBe("Unavailable");
      rmSync(join(bin, "a/fail"));
      expect(JSON.parse(await text("team_recent", { repo: "acme--a" }, brain)).total).toBe(2);
      expect(brain.readings().find((reading) => reading.capability === "ledger:acme--a")?.health).toBe("Ok");
    }, ledgerScope);
  });

  it("refuses an exit-zero unavailable ledger and keeps unrelated team search usable", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: false, sessions: [], total: 0,
      }));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/not an empty session list/);
      expect(brain.readings().find((r) => r.capability === "ledger:acme--a")?.health).toBe("Unavailable");
      await expect(brain.search("team", 1)).resolves.toEqual([]);
      expect(brain.readings().find((r) => r.capability === "brain.team")?.health).toBe("Ok");
    }, ledgerScope);
  });

  it.each(["old", "missing", "invalid", "future"])("refuses %s freshness even with a healthy daemon", async (kind) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      const last_sync = kind === "old" ? new Date(Date.now() - 6 * 60_000).toISOString()
        : kind === "future" ? new Date(Date.now() + 60_000).toISOString()
        : kind === "invalid" ? "oxp_planted" : undefined;
      writeFileSync(join(bin, "a/daemon.json"), JSON.stringify({
        health: "healthy", sync: { errors: 0 }, last_sync: new Date().toISOString(),
        project: { ledger: { status: "ok", path: join(bin, "ledger-a"), last_sync } },
      }));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/five minutes/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("|session list");
      const status = JSON.parse(await text("team_status", {}, brain));
      expect(status.ledger_sync.status).toBe("external");
      expect(status.ledger_sync.repositories[0]).toMatchObject({ repo: "acme--a", status: "unavailable", failure: "ledger-stale" });
      expect(status.ledger_sync.repositories[1].status).toBe("available");
      expect(JSON.stringify(status)).not.toContain("oxp_planted");
    }, ledgerScope);
  });

  it.each(["not_cloned", "not_synced", "syncing", "error"])("refuses a ledger whose own state is %s", async (status) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/daemon.json"), JSON.stringify({
        health: "healthy", project: { ledger: { status, path: join(bin, "ledger-a"), last_sync: new Date().toISOString() } },
      }));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("|session list");
    }, ledgerScope);
  });

  it("does not use another ledger's recent sync to authorize a read", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/daemon.json"), readFileSync(join(bin, "b/daemon.json")));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("|session list");
    }, ledgerScope);
  });

  it.skipIf(process.getuid?.() === 0)("refuses an unreadable sessions directory even if ox would report an empty ledger", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      const sessions = join(bin, "ledger-a/sessions");
      mkdirSync(sessions, { mode: 0o300 });
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: true, sessions: [], total: 0,
      }));
      try {
        await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
        expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("|session list");
      } finally {
        chmodSync(sessions, 0o700);
      }
    }, ledgerScope);
  });

  it("refuses a response for another repository even after the selected ledger passed its probe", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), readFileSync(join(bin, "b/sessions.json")));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
    }, ledgerScope);
  });

  it.each([
    { repo: "/private/secret" }, { repo: "../a" }, { repo: "acme--a", limit: 0 },
    { repo: "acme--a", limit: 21 }, { repo: "acme--a", file: "/private/secret" },
  ])("rejects unconfigured paths and extra flags before invoking ox (%j)", async (args) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      await expect(text("team_sessions", args, brain)).rejects.toThrow();
      expect(existsSync(join(bin, "calls"))).toBe(false);
    }, ledgerScope);
  });

  it.each([
    { team_id: "team_other" }, { endpoint: "https://other.example" },
  ])("rejects a foreign project binding before invoking ox in that cwd (%j)", async (override) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/.sageox/config.json"), JSON.stringify({ repo_id: "repo_a", team_id: "team_x", ...override }));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain(`${realpathSync(join(bin, "a"))}|`);
    }, ledgerScope);
  });

  it("recovers when the selected checkout becomes usable, independently of a code index", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      const config = readFileSync(join(bin, "a/.sageox/config.json"));
      rmSync(join(bin, "a/.sageox/config.json"));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow();
      writeFileSync(join(bin, "a/.sageox/config.json"), config);
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain)).sessions).toHaveLength(1);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toMatch(/index|code status/);
    }, ledgerScope);
  });

  it("refuses an existing checkout whose origin no longer matches repos.conf", async () => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      execFileSync("git", ["-C", join(bin, "a"), "remote", "set-url", "origin", "https://github.com/other/repo"]);
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain(`${realpathSync(join(bin, "a"))}|`);
    }, ledgerScope);
  });

  it.each([null, {}, { sessions: [], ledger_available: false }, {
    repo_id: "repo_a", sessions: [{ name: "oxp_planted" }], ledger_available: true, total: 1,
  }])("rejects malformed or unavailable output and degrades the ledger reading (%j)", async (response) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify(response));
      const error = await text("team_sessions", { repo: "acme--a" }, brain).then(() => undefined, (e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain("oxp_planted");
      expect(brain.readings().find((r) => r.capability === "ledger:acme--a")?.health).toBe("Unavailable");
    }, ledgerScope);
  });

  it("expires a successful capability reading as its refresh receipt ages", async () => {
    await withFakeOx(SCRIPT, async (brain) => {
      await text("team_sessions", { repo: "acme--a" }, brain);
      expect(brain.readings().find((r) => r.capability === "ledger:acme--a")?.health).toBe("Ok");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
      try {
        expect(brain.readings().find((r) => r.capability === "ledger:acme--a")).toMatchObject({ health: "Unavailable", failure: "ledger-stale" });
      } finally { clock.mockRestore(); }
    }, ledgerScope);
  });

  it("does not let an older successful probe erase a newer ledger failure", async () => {
    const held = SCRIPT.replace('"daemon status") cat ./daemon.json;;',
      '"daemon status") if [ -f ./hold ]; then : > ./blocked; while [ ! -f ./release ]; do sleep 0.02; done; fi; cat ./daemon.json;;');
    await withFakeOx(held, async (brain, bin) => {
      writeFileSync(join(bin, "a/hold"), "");
      const first = brain.ledgerStatus();
      await until(() => existsSync(join(bin, "a/blocked")), "the first ledger probe to wait");
      try {
        writeFileSync(join(bin, "a/status.json"), JSON.stringify({ ledger: { configured: false, exists: false } }));
        await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow();
      } finally {
        writeFileSync(join(bin, "a/release"), "");
        await first;
      }
      expect(brain.readings().find((r) => r.capability === "ledger:acme--a")?.health).toBe("Unavailable");
    }, ledgerScope);
  });

  it.each(["team_sessions", "team_recent"])("requires current credential access for %s, then picks up rotation", async (tool) => {
    await withFakeOx(SCRIPT, async (brain, bin) => {
      writeFileSync(join(bin, "required-token"), "oxt_rotated");
      writeFileSync(join(bin, "secret"), "oxt_revoked");
      await expect(text(tool, { repo: "acme--a" }, brain)).rejects.toThrow(/not authenticated/);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toMatch(/\|(session list|glance)/);
      expect(brain.readings()[0].health).toBe("Unavailable");
      writeFileSync(join(bin, "secret"), "oxt_rotated");
      expect(JSON.parse(await text(tool, { repo: "acme--a" }, brain)).total).toBeGreaterThan(0);
      expect(brain.readings()[0].health).toBe("Ok");
    }, (bin) => ({ ...ledgerScope(bin), token: () => readFileSync(join(bin, "secret"), "utf8").trim() }));
  });
});

describe("what the brain is told when ox fails", () => {
  const PLANTED = "sk-planted-a1b2c3";

  /** Runs `search` against a fake `ox` on PATH, and returns the error and the audit lines. */
  async function failingOx(script: string) {
    const { value, log } = await withFakeOx(script, (brain) =>
      // The query is the caller's own words: the thing that must not come back out.
      brain.search(PLANTED, 5).then(() => undefined, (e: Error) => e),
    );
    return { message: value?.message ?? "", log };
  }

  it("keeps ox's stderr out of the brain and puts it in the audit log", async () => {
    const { message, log } = await failingOx(`echo "Error: rejected token ${PLANTED}" >&2; exit 1`);

    expect(message).not.toContain(PLANTED);
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT.failed}`);
    // The detail is not lost — it goes where an operator can triage it and the brain cannot.
    expect(log).toContain("ox_failed");
    expect(log).toContain("class=failed");
    expect(log).toContain(PLANTED);
  });

  it("logs the detail as one escaped field, so ox output cannot forge one of its own", async () => {
    // Both halves of the same trick: a newline to start a second record, and a quote to
    // close `detail` early and have the rest read as fields — a forged `class=` would send
    // an operator after exactly the wrong cause.
    const forge = 'boom" class=not-authenticated verb="ox';
    const { log } = await failingOx(`printf 'Error: %s\\nsecond line\\n' '${forge}' >&2; exit 1`);

    expect(log.split("\n")).toHaveLength(1);
    const detail = JSON.parse(log.slice(log.indexOf("detail=") + "detail=".length)) as string;
    expect(detail).toContain(forge); // intact for the operator, and inside one JSON string
    expect(log.slice(0, log.indexOf("detail="))).toContain("class=failed"); // the only class
  });

  it("says an auth failure is a credential to fix, not a lookup to retry", async () => {
    const { message, log } = await failingOx(
      `echo "Error: team context query failed: not authenticated. Run 'ox login' first" >&2; exit 1`,
    );
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT["not-authenticated"]}`);
    expect(message).toMatch(/a human has to mount or rotate/);
    expect(log).toContain("class=not-authenticated");
  });

  it("keeps unparseable stdout out too — it is the same untrusted text", async () => {
    const { message, log } = await failingOx(`echo "not json at all: ${PLANTED}"; exit 0`);

    expect(message).not.toContain(PLANTED);
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT.unreadable}`);
    expect(log).toContain("class=unreadable");
  });

  it("classifies the safe way round: an unrecognised refusal is not an auth failure", () => {
    expect(classifyOxFailure({ code: "ENOENT" })).toBe("not-installed");
    expect(classifyOxFailure({ stderr: "Error: not authenticated. Run 'ox login'" })).toBe(
      "not-authenticated",
    );
    // Reworded by a later ox, or simply something else: degrade to "it failed", never to a
    // class that sends a human after the wrong cause.
    expect(classifyOxFailure({ stderr: "Error: the team context service is unavailable" })).toBe(
      "failed",
    );
    expect(classifyOxFailure({})).toBe("failed");
  });

  it("gives each class its own words, so they are worth telling apart", () => {
    // Four classes that render as fewer than four sentences would be one class wearing
    // four names, and the brain would act the same way on all of them.
    const classes: OxFailure[] = ["not-installed", "not-authenticated", "unreadable", "failed"];
    expect(new Set(classes.map((name) => OX_FAILURE_TEXT[name])).size).toBe(classes.length);
  });
});

describe("the team brain's own capability health", () => {
  // Answers with no passages; fails with whatever the body has written into `fail` beside
  // it, and answers unreadably if `garbage` is there. ox runs with its cwd set to that
  // directory, so the markers are `./fail` and `./garbage`.
  const SCRIPTED =
    `if [ -f ./garbage ]; then echo "not json at all"; exit 0; fi\n` +
    `if [ -f ./fail ]; then cat ./fail >&2; exit 1; fi\n` +
    `echo '{"team_context":{"results":[]}}'`;
  const REVOKED = "Error: team context query failed: not authenticated. Run 'ox login' first";
  // A lookup whose query says `slow` announces itself in `blocked` and then waits for the
  // test to create `release`; every other one is refused straight away. A barrier rather
  // than a delay, so the interleaving is the test's to decide and not the machine's.
  const HELD_THEN_REVOKED =
    `case "$*" in\n` +
    `  *slow*)\n` +
    `    : > ./blocked\n` +
    `    while [ ! -f ./release ]; do sleep 0.02; done\n` +
    `    echo '{"team_context":{"results":[]}}'\n` +
    `    exit 0;;\n` +
    `  *flaky*) echo "Error: the team context service is unavailable" >&2; exit 1;;\n` +
    `esac\n` +
    `echo "${REVOKED}" >&2\nexit 1`;

  it("lets a success outlive a newer transient failure and clear the latch", async () => {
    // The other half of the ordering rule, and it is deliberate: a `failed` lookup records
    // nothing, so it does not make a newer-started success stale. Suppressing that success
    // would hold `Unavailable` on evidence nobody has — and delay exactly the recovery a
    // rotated credential is supposed to get without a restart.
    const { value } = await withFakeOx(HELD_THEN_REVOKED, async (brain, bin) => {
      await brain.search("revoked", 5).catch(() => {});
      const latched = brain.readings()[0].health;
      const held = brain.search("slow", 1).catch(() => {});
      await until(() => existsSync(join(bin, "blocked")), "the held lookup to start");
      // Asserted rather than swallowed: a `flaky` lookup that answered would leave the
      // held success to produce `Ok` on its own, and the test would pass having exercised
      // nothing.
      await expect(brain.search("flaky", 5)).rejects.toMatchObject({ failure: "failed" });
      writeFileSync(join(bin, "release"), "");
      await held;
      return [latched, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Ok"]);
  });

  it("reports nothing until a lookup has been made", async () => {
    // Not `Ok`: nothing has tried the credential yet, and a reading is a claim about it.
    const { value } = await withFakeOx(SCRIPTED, async (brain) => brain.readings());
    expect(value).toEqual([]);
  });

  it("latches a revoked credential, so the turn and the operator both learn of it", async () => {
    const { value, log } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      writeFileSync(join(bin, "fail"), REVOKED);
      await brain.search("how do we deploy", 5).catch(() => {});
      return brain.readings();
    });

    expect(value).toHaveLength(1);
    const [reading] = value;
    expect(reading.capability).toBe("brain.team");
    expect(reading.health).toBe("Unavailable");
    // The same word on both lines, so one grep finds the classification and the reading.
    expect(log).toContain("class=not-authenticated");
    expect(describeHealth(reading)).toContain("failure=not-authenticated");
    // Disclosed to the agent, and announced to a human — the two are separate decisions.
    expect(isDegrading(reading.health)).toBe(true);
    expect(needsHuman(reading.health)).toBe(true);
    // What the agent is told is the fixed sentence, and the remedy is only for the operator.
    expect(reading.reason).toBe(OX_FAILURE_TEXT["not-authenticated"]);
    expect(isActionable(reading) && reading.remedy).toMatch(/rotate/);
  });

  it("clears itself on the next answer, so a rotated credential needs no restart", async () => {
    const { value } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      const path = join(bin, "fail");
      writeFileSync(path, REVOKED);
      await brain.search("x", 5).catch(() => {});
      const dead = brain.readings()[0].health;
      rmSync(path);
      await brain.search("x", 5);
      return [dead, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Ok"]);
  });

  it("hands each lookup the credential on disk now, so a rotated secret self-heals", async () => {
    // The other half of "clears itself on the next answer": that latch only clears if the
    // next lookup can still get one, and with a token read once at boot it cannot — a
    // secrets-store CSI driver rewrites the file under the mount and the process goes on
    // sending the revoked value. The fake records what it was handed.
    const RECORDS_TOKEN = `printf '%s' "$SAGEOX_TOKEN" > ./seen\necho '{"team_context":{"results":[]}}'`;
    const { value } = await withFakeOx(
      RECORDS_TOKEN,
      async (brain, bin) => {
        const seen = () => readFileSync(join(bin, "seen"), "utf8");
        writeFileSync(join(bin, "secret"), "tok_old");
        await brain.search("x", 5);
        const before = seen();
        writeFileSync(join(bin, "secret"), "tok_new");
        await brain.search("x", 5);
        return [before, seen()];
      },
      // Stands in for `resolveSecret` against a mounted secrets directory, down to
      // answering `undefined` for a ref with no file — which is what a token captured
      // before this body wrote one would have carried for the whole process.
      (bin) => ({
        token: () => {
          const path = join(bin, "secret");
          return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
        },
      }),
    );
    expect(value).toEqual(["tok_old", "tok_new"]);
  });

  it("reads an answer with no passages as Ok, never as an empty corpus", async () => {
    // One query that matched nothing says nothing about how much the team has written
    // down, and `ox query` reports no corpus size. `Empty` here would be a guess.
    const { value } = await withFakeOx(SCRIPTED, async (brain) => {
      expect(await brain.search("nothing matches this", 5)).toEqual([]);
      return brain.readings()[0].health;
    });
    expect(value).toBe("Ok");
  });

  it("leaves the reading standing when a lookup falls over or answers unreadably", async () => {
    // The two classes retrying can disprove. Latching either would announce an outage to a
    // human on every flaky lookup, which is how people learn to skim announcements.
    const { value } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      await brain.search("x", 5);
      writeFileSync(join(bin, "fail"), "Error: the team context service is unavailable");
      await brain.search("x", 5).catch(() => {});
      const afterFailed = brain.readings()[0].health;
      rmSync(join(bin, "fail"));
      writeFileSync(join(bin, "garbage"), "");
      await brain.search("x", 5).catch(() => {});
      return [afterFailed, brain.readings()[0].health];
    });
    expect(value).toEqual(["Ok", "Ok"]);
  });

  it("does not let a slower older lookup bury what a newer one proved", async () => {
    // Completion order is not start order once the launch probe overlaps a turn, and a
    // stale `Ok` landing on top of an auth failure is the silence this reading exists to
    // break, restored by a race.
    const { value } = await withFakeOx(HELD_THEN_REVOKED, async (brain, bin) => {
      // The older lookup is held inside the fake `ox` until this test lets it go, so the
      // newer one demonstrably records first and the guard is what the assertion rests on.
      const older = brain.search("slow", 1).catch(() => {});
      await until(() => existsSync(join(bin, "blocked")), "the older lookup to start");
      await brain.search("newer", 5).catch(() => {});
      const whileTheOlderOneIsHeld = brain.readings()[0].health;
      writeFileSync(join(bin, "release"), "");
      await older;
      return [whileTheOlderOneIsHeld, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Unavailable"]);
  });

  it("takes the first reading at launch, without throwing", async () => {
    const { value } = await withFakeOx(SCRIPTED, async (brain) => {
      await brain.probe();
      return brain.readings()[0].health;
    });
    expect(value).toBe("Ok");
  });

  it("latches a missing `ox` at launch too — an image built without it stays broken", async () => {
    const { value } = await withFakeOx(undefined, async (brain) => {
      await brain.probe();
      return brain.readings()[0];
    });
    expect(value.health).toBe("Unavailable");
    expect(describeHealth(value)).toContain("failure=not-installed");
    expect(value.reason).toBe(OX_FAILURE_TEXT["not-installed"]);
  });
});

describe("passage dates", () => {
  it("surfaces the date a discussion came from, so recency is readable", () => {
    expect(passageDate("discussions/2026-08-14-21-34-ajit/transcript.vtt")).toBe("2026-08-14");
  });

  it("returns nothing for a path that carries no date", () => {
    expect(passageDate("documents/architecture.md")).toBeUndefined();
    expect(passageDate(undefined)).toBeUndefined();
  });

  it("shows the date in rendered output", () => {
    const out = formatPassages("x", [
      { score: 0.6, text: "we shipped it", file_path: "discussions/2026-08-14-21-34-a/t.vtt" },
    ]);
    expect(out).toContain("2026-08-14");
  });

  it("says an empty result is about wording, not about the corpus being stale", () => {
    const out = formatPassages("anything", []);
    expect(out).toMatch(/different wording/i);
    expect(out).toMatch(/not that the team has recorded nothing recently/i);
  });
});
