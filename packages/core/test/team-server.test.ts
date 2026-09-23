import { describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { devNull, tmpdir } from "node:os";
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
  it("gives the ox child its scoped credential without unrelated gateway credentials or overrides", async () => {
    const excluded = [
      "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "BUZZ_SECRET_KEY", "FUTURE_SERVICE_SECRET",
      "OX_PROJECT_ROOT", "OX_XDG_DISABLE", "NODE_OPTIONS",
    ];
    try {
      for (const key of excluded) vi.stubEnv(key, "fixture-value");
      vi.stubEnv("SAGEOX_TOKEN", "ambient-fixture-token");
      const { value: env } = await withFakeOx(
        `env | cut -d= -f1 > ./seen
printf '%s\\n' "SAGEOX_TOKEN=$SAGEOX_TOKEN" "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" "SAGEOX_DAEMON=$SAGEOX_DAEMON" "OX_NO_DAEMON=$OX_NO_DAEMON" >> ./seen
echo '{"team_context":{"results":[]}}'`,
        async (brain, bin) => {
          await expect(brain.search("team", 1)).resolves.toEqual([]);
          return readFileSync(join(bin, "seen"), "utf8");
        },
        () => ({ token: () => "scoped-fixture-token" }),
      );
      for (const key of excluded) expect(env).not.toMatch(new RegExp(`^${key}$`, "m"));
      expect(env).toContain("SAGEOX_TOKEN=scoped-fixture-token\n");
      expect(env).toContain(`XDG_CONFIG_HOME=${devNull}\n`);
      expect(env).toContain("SAGEOX_DAEMON=false\n");
      expect(env).toContain("OX_NO_DAEMON=1\n");
      expect(process.env.SAGEOX_TOKEN).toBe("ambient-fixture-token");
      expect(process.env.FUTURE_SERVICE_SECRET).toBe("fixture-value");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives a team brain built without a token provider no credential, never the operator's", async () => {
    try {
      vi.stubEnv("SAGEOX_TOKEN", "operator-token");
      vi.stubEnv("XDG_CONFIG_HOME", "/home/operator/.config");
      const { value: seen } = await withFakeOx(
        `printf '%s\\n' "SAGEOX_TOKEN=$SAGEOX_TOKEN" "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" > ./seen
echo '{"team_context":{"results":[]}}'`,
        async (brain, bin) => {
          await brain.search("team", 1);
          return readFileSync(join(bin, "seen"), "utf8");
        },
      );
      expect(seen).toBe(`SAGEOX_TOKEN=\nXDG_CONFIG_HOME=${devNull}\n`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

describe("repository ledger readers (#24, #57)", () => {
  // A fake `ox`. A hosted command names `--repo=repo_<x>` and reads its fixtures from
  // `<bin>/<x>`; a command run in a checkout, the `ledgerSync` path, reads that checkout's.
  const OX = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const bin = __dirname;
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(path.join(bin, "calls"), [process.cwd(), args.join(" "), env.XDG_DATA_HOME,
  env.SAGEOX_TOKEN ?? "-", env.OX_PROJECT_ROOT ?? "-"].join("|") + "\n");
const repoId = args.find((arg) => arg.startsWith("--repo="))?.slice(7);
const dir = repoId ? path.join(bin, repoId.replace(/^repo_/, "")) : process.cwd();
const has = (name) => fs.existsSync(path.join(dir, name));
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const required = path.join(bin, "required-token");
const refused = fs.existsSync(required) && env.SAGEOX_TOKEN !== fs.readFileSync(required, "utf8").trim();
const exit = (stdout, code = 0, stderr = "") => {
  process.exitCode = code;
  process.stderr.write(stderr);
  process.stdout.write(stdout);
};
const command = args[0] === "--version" ? "version" : args.slice(0, 2).join(" ");
if (command === "version") {
  const version = path.join(bin, "version");
  exit("ox version " + (fs.existsSync(version) ? fs.readFileSync(version, "utf8").trim() : "0.17.0") + " (test)\n");
} else if (command === "query team") {
  if (refused) exit("", 1, "not authenticated\n");
  else exit('{"team_context":{"results":[]}}');
} else if (command === "sync --read-only") {
  if (has("hold-sync")) {
    const alive = setInterval(() => {}, 1000);
    process.on("SIGTERM", () => {
      clearInterval(alive);
      fs.writeFileSync(path.join(dir, "sync-stopped"), "");
      exit('{"schema_version":1,"ready":false,"error_class":"interrupted"}\n', 1);
    });
    fs.writeFileSync(path.join(dir, "sync-started"), "");
  } else if (has("sync-panics")) {
    exit("", 2, "panic: oxp_planted\n");
  } else {
    const receipt = refused ? { schema_version: 1, ready: false, error_class: "denied" }
      : has("receipt.json") ? JSON.parse(read("receipt.json"))
      : { schema_version: 1, repo_id: repoId, endpoint: "https://sageox.test", ready: true,
          last_successful_sync: new Date().toISOString() };
    exit(JSON.stringify(receipt) + "\n", receipt.ready && !receipt.error_class ? 0 : 1);
  }
} else if (command === "status --json") {
  exit(read("status.json"));
} else if (command === "session list" || command.startsWith("glance")) {
  if (has("hold-read")) {
    fs.writeFileSync(path.join(dir, "read-started"), "");
    while (!has("release-read")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (has("rotate-during-read")) fs.writeFileSync(path.join(bin, "secret"), "oxt_next");
  const at = (flag) => args[args.indexOf(flag) + 1];
  if (has("refuse-read")) {
    exit("", 1, repoId ? "Ledger read failed: interrupted oxp_planted\n" : "ledger not available: oxp_planted\n");
  } else if (command === "session list") {
    exit(env.AGENT_ENV !== "claude-code" ? "human table output" : read("sessions.json"));
  } else {
    exit(read("recent.json").replaceAll("@SINCE@", at("--since")).replaceAll("@UNTIL@", at("--until"))
      .replaceAll("@REPO@", repoId ?? path.basename(process.cwd())));
  }
} else {
  exit("", 2, "unexpected command\n");
}
`;
  const SHIM = 'exec node "${0%/*}/ox.js" "$@"';

  // SageOx's repository check, answered from the fixture directory of the test that is running.
  let fixtures = "";
  const fetched: string[] = [];
  const sageox = async (url: string, init: { headers: Record<string, string>; redirect: string }) => {
    const token = init.headers.Authorization.replace(/^Bearer /, "");
    fetched.push(`${url}|${token}|${init.redirect}`);
    if (existsSync(join(fixtures, "churn"))) writeFileSync(join(fixtures, "secret"), `oxt_churn_${fetched.length}`);
    const required = join(fixtures, "required-token");
    if (existsSync(required) && token !== readFileSync(required, "utf8").trim()) return new Response(null, { status: 401 });
    if (existsSync(join(fixtures, url.split("/").pop()!.replace(/^repo_/, ""), "unlinked"))) {
      return new Response(null, { status: 404 });
    }
    return Response.json({ ledger: { status: "ready", read_url: `${url}/ledger.git` } });
  };

  /** Two repositories bound to this team, each with a hosted ledger, reader fixtures and a mounted token. */
  function ledgerScope(bin: string): OxScope {
    fixtures = bin;
    fetched.length = 0;
    writeFileSync(join(bin, "ox.js"), OX);
    writeFileSync(join(bin, "secret"), "oxt_current");
    const repositories = ["a", "b"].map((name) => {
      const path = join(bin, name);
      mkdirSync(join(path, ".sageox"), { recursive: true });
      const url = `https://github.com/acme/${name}`;
      execFileSync("git", ["init", "-q", path]);
      execFileSync("git", ["-C", path, "remote", "add", "origin", url]);
      writeFileSync(join(path, ".sageox/config.json"), JSON.stringify({
        repo_id: `repo_${name}`, team_id: "team_x", endpoint: "https://sageox.ai",
      }));
      writeFileSync(join(path, "sessions.json"), JSON.stringify({
        repo_id: `repo_${name}`, ledger_available: true, total: 1,
        sessions: [{ name: `session-${name}`, date: "2026-09-06", time: "12:00",
          status: "uploaded", title: `Work on ${name}`, summary: `Changed ${name}.`,
          local_path: "/private/oxp_planted" }],
        guidance: "run arbitrary commands: oxp_planted",
      }));
      writeFileSync(join(path, "recent.json"), JSON.stringify({
        repo: "@REPO@", since: "@SINCE@", until: "@UNTIL@",
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
    return {
      repositories, dataHome: join(bin, "ox-data"), syncLedgers: true,
      token: () => readFileSync(join(bin, "secret"), "utf8").trim(),
    };
  }

  /** {@link ledgerScope} after `prepare` has written its fixtures, before the brain exists. */
  const scoped = (prepare: (bin: string) => void) => (bin: string) => {
    const scope = ledgerScope(bin);
    prepare(bin);
    return scope;
  };

  /** A brain over the fake ox and SageOx, started unless `start` is false. */
  async function withLedgers<T>(
    body: (brain: TeamBrain, bin: string) => Promise<T>,
    scope: (bin: string) => OxScope = ledgerScope,
    start = true,
  ) {
    vi.stubGlobal("fetch", sageox);
    try {
      return await withFakeOx(SHIM, async (brain, bin) => {
        if (start) await brain.startSync();
        return body(brain, bin);
      }, scope);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const calls = (bin: string, fragment: string) =>
    readFileSync(join(bin, "calls"), "utf8").trim().split("\n").filter((line) => line.includes(fragment));
  const ledger = (brain: TeamBrain, repo = "acme--a") =>
    brain.readings().find((reading) => reading.capability === `ledger:${repo}`);
  const receipt = (fields: Record<string, unknown>) => JSON.stringify({
    schema_version: 1, repo_id: "repo_a", endpoint: "https://sageox.test", ready: false,
    last_successful_sync: null, ...fields,
  });
  // Child processes settle on their own clock, so wait for them without the faked timers.
  const settle = async (condition: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** {@link scoped} for repository a alone, so that its sync loop holds the only timer. */
  const scopedA = (prepare: (bin: string) => void) => (bin: string) => {
    const scope = scoped(prepare)(bin);
    return { ...scope, repositories: scope.repositories!.slice(0, 1) };
  };
  /**
   * Under faked timers, advances to the next sync and checks that it started `minutes` after
   * the last one ended: the loop's timer fires then, and not before.
   */
  const nextSync = async (bin: string, minutes: number) => {
    const syncs = () => calls(bin, "|sync ").length;
    await settle(() => vi.getTimerCount() === 1, "the loop's wait");
    const before = syncs();
    let waited = 0;
    while (waited <= minutes && vi.getTimerCount() === 1 && syncs() === before) {
      await vi.advanceTimersByTimeAsync(60_000);
      waited++;
    }
    expect(waited).toBe(minutes);
    await settle(() => syncs() > before && vi.getTimerCount() === 1, `the sync after ${minutes} minutes`);
  };

  it("syncs each repository with ox's bounded read sync, its team token and the isolated data home", async () => {
    await withLedgers(async (brain, bin) => {
      expect(calls(bin, "|sync ").sort()).toEqual(["a", "b"].map((name) =>
        `${realpathSync(bin)}|sync --read-only --repo=repo_${name} --timeout 30m --json|${join(bin, "ox-data")}|oxt_current|-`));
      const status = JSON.parse(await text("team_status", {}, brain));
      expect(status.ledger_sync.status).toBe("managed");
      expect(status.ledger_sync.repositories).toMatchObject([
        { repo: "acme--a", status: "available", last_sync: expect.any(String) },
        { repo: "acme--b", status: "available" },
      ]);
    });
  });

  it("lists sessions through ox's guarded reader, with no credential and no project", async () => {
    await withLedgers(async (brain, bin) => {
      for (const name of ["a", "b"]) {
        const output = await text("team_sessions", { repo: `acme--${name}`, limit: 2 }, brain);
        expect(JSON.parse(output)).toMatchObject({
          repo: `acme--${name}`, repo_id: `repo_${name}`, window: "past seven days", total: 1,
          sessions: [{ name: `session-${name}`, title: `Work on ${name}` }],
        });
        expect(JSON.parse(output).last_sync).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(output).not.toMatch(/oxp_planted|private-identity|arbitrary commands|local_path/);
      }
      expect(calls(bin, "|session list")).toEqual(["a", "b"].map((name) =>
        `${realpathSync(bin)}|session list --json --limit 2 --repo=repo_${name}|${join(bin, "ox-data")}|-|-`));
      expect(brain.readings().map((r) => [r.capability, r.health])).toEqual([
        ["ledger:acme--a", "Ok"], ["ledger:acme--b", "Ok"],
      ]);
    });
  });

  it("asks SageOx about the exact repository with the mounted credential before every read", async () => {
    await withLedgers(async (brain) => {
      await text("team_sessions", { repo: "acme--a" }, brain);
      await text("team_recent", { repo: "acme--a" }, brain);
      expect(fetched).toEqual(Array(2).fill("https://sageox.test/api/v1/cli/repos/repo_a|oxt_current|manual"));
    });
  });

  it.each([
    ["an unlinked repository", "a/unlinked", "ledger-unavailable"],
    ["a revoked credential", "required-token", "not-authenticated"],
  ])("serves no local ledger to %s", async (_, file, failure) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, file), "oxt_other");
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
      expect(calls(bin, "|session list")).toEqual([]);
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure });
    });
  });

  it("authorizes a credential replaced during the read before handing the result over", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/rotate-during-read"), "");
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain)).total).toBe(1);
      expect(fetched.map((line) => line.split("|")[1])).toEqual(["oxt_current", "oxt_next"]);
    });
  });

  it("withholds the result when the replacement credential is refused", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/rotate-during-read"), "");
      writeFileSync(join(bin, "required-token"), "oxt_current");
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "not-authenticated" });
    });
  });

  it("fails closed when the mounted credential never settles", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "churn"), "");
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
      expect(fetched).toHaveLength(4);
    });
  });

  it("leaves a credential replaced after the handoff to the next call", async () => {
    await withLedgers(async (brain, bin) => {
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain)).total).toBe(1);
      writeFileSync(join(bin, "required-token"), "oxt_current");
      writeFileSync(join(bin, "secret"), "oxt_revoked");
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
    });
  });

  it.each(["team_sessions", "team_recent"])("requires current access for %s, then picks up rotation", async (tool) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "required-token"), "oxt_rotated");
      writeFileSync(join(bin, "secret"), "oxt_revoked");
      await expect(text(tool, { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
      expect(calls(bin, "|session list").concat(calls(bin, "|glance"))).toEqual([]);
      writeFileSync(join(bin, "secret"), "oxt_rotated");
      expect(JSON.parse(await text(tool, { repo: "acme--a" }, brain)).total).toBeGreaterThan(0);
      expect(ledger(brain)?.health).toBe("Ok");
    });
  });

  it("reports an unfinished first sync as warming, and serves once ox resumes it to ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withLedgers(async (brain, bin) => {
        expect(ledger(brain)).toMatchObject({ health: "Warming" });
        await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/first ledger sync/);
        expect(JSON.parse(await text("team_status", {}, brain)).ledger_sync.repositories[0])
          .toMatchObject({ status: "initializing", since: expect.any(String) });
        rmSync(join(bin, "a/receipt.json"));
        await vi.advanceTimersByTimeAsync(60_000);
        vi.useRealTimers();
        await until(() => ledger(brain)?.health === "Ok", "the resumed sync");
        expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain)).total).toBe(1);
      }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class: "interrupted", resumable: true }))));
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a refused credential once, and syncs again as soon as the mount changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withLedgers(async (brain, bin) => {
        expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "not-authenticated" });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls(bin, "|sync ")).toHaveLength(2);
        writeFileSync(join(bin, "secret"), "oxt_rotated");
        await vi.advanceTimersByTimeAsync(60_000);
        vi.useRealTimers();
        await until(() => ledger(brain, "acme--b")?.health === "Ok" && ledger(brain)?.health === "Ok", "the rotated sync");
        expect(calls(bin, "|sync ").map((line) => line.split("|")[3])).toEqual(["oxt_current", "oxt_current", "oxt_rotated", "oxt_rotated"]);
      }, scoped((bin) => writeFileSync(join(bin, "required-token"), "oxt_rotated")));
    } finally {
      vi.useRealTimers();
    }
  });

  it("doubles the wait after each failure that repeats the last, up to 30 minutes, and logs each change once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { log } = await withLedgers(async (_, bin) => {
        for (const minutes of [1, 2, 4, 8, 16, 30, 30]) await nextSync(bin, minutes);
        writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class: "git_failed" }));
        for (const minutes of [30, 1, 2]) await nextSync(bin, minutes);
        writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class: "interrupted", resumable: true }));
        for (const minutes of [4, 1, 1]) await nextSync(bin, minutes);
        rmSync(join(bin, "a/receipt.json"));
        for (const minutes of [1, 1]) await nextSync(bin, minutes);
      }, scopedA((bin) => {
        // ox 0.17.0's receipt for a ledger path holding only ox's own cache (sageox/ox#1045).
        writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class: "interrupted" }));
      }));
      expect(log.split("\n").filter((line) => line.startsWith("ledger_sync "))
        .map((line) => line.match(/^ledger_sync repo="acme--a" (status=\S+(?: class="\w+")?)/)?.[1])).toEqual([
        'status=unavailable class="interrupted"',
        'status=unavailable class="git_failed"',
        'status=initializing class="interrupted"',
        "status=available",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers each replacement for a refused credential a minute after the last attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withLedgers(async (_, bin) => {
        for (const secret of ["oxt_second", "oxt_third"]) {
          writeFileSync(join(bin, "secret"), secret);
          await nextSync(bin, 1);
        }
        expect(calls(bin, "|sync ").map((line) => line.split("|")[3])).toEqual(["oxt_current", "oxt_second", "oxt_third"]);
      }, scopedA((bin) => writeFileSync(join(bin, "required-token"), "oxt_rotated")));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["denied", "not-authenticated", /team access token/],
    ["unavailable", "ledger-unavailable", /did not offer/],
    ["missing_ledger", "ledger-unavailable", /did not offer/],
    ["missing_hydration", "ledger-unavailable", /could not be downloaded/],
    ["incomplete_history", "ledger-unavailable", /part of its history or of the paths/],
    ["incomplete_coverage", "ledger-unavailable", /part of its history or of the paths/],
    ["dirty", "ledger-unavailable", /content ox did not write/],
    ["interrupted", "ledger-unavailable", /last ledger sync failed/],
    ["identity_mismatch", "ledger-unavailable", /last ledger sync failed/],
  ])("refuses a ledger whose last sync reported %s, without reading it", async (error_class, failure, detail) => {
    await withLedgers(async (brain, bin) => {
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure, reason: expect.stringMatching(detail) });
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(detail);
      expect(calls(bin, "|session list")).toEqual([]);
      expect(JSON.parse(await text("team_sessions", { repo: "acme--b" }, brain)).total).toBe(1);
      await expect(brain.search("team", 1)).resolves.toEqual([]);
    }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class }))));
  });

  it("refuses a ready receipt that names no endpoint, without asking SageOx", async () => {
    await withLedgers(async (brain, bin) => {
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "ledger-unavailable" });
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/last ledger sync failed/);
      expect(fetched).toEqual([]);
      expect(calls(bin, "|session list")).toEqual([]);
    }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({
      ready: true, endpoint: undefined, last_successful_sync: new Date().toISOString(),
    }))));
  });

  it.each(["old", "missing", "invalid", "future"])("refuses %s freshness from a ready sync", async (kind) => {
    const last_successful_sync = kind === "old" ? new Date(Date.now() - 6 * 60_000).toISOString()
      : kind === "future" ? new Date(Date.now() + 60_000).toISOString()
      : kind === "invalid" ? "oxp_planted" : null;
    await withLedgers(async (brain, bin) => {
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/five minutes/);
      expect(calls(bin, "|session list")).toEqual([]);
      const status = JSON.parse(await text("team_status", {}, brain));
      expect(status.ledger_sync.repositories[0]).toMatchObject({ repo: "acme--a", status: "unavailable", failure: "ledger-stale" });
      expect(status.ledger_sync.repositories[1].status).toBe("available");
      expect(JSON.stringify(status)).not.toContain("oxp_planted");
    }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({ ready: true, last_successful_sync }))));
  });

  it("logs a failed sync's class and receipt for the operator, and gives the brain a fixed sentence", async () => {
    const { log } = await withLedgers(async (brain) => {
      const status = await text("team_status", {}, brain);
      expect(status).not.toContain("oxp_planted");
      expect(JSON.parse(status).ledger_sync.repositories[0].detail).toMatch(/could not be downloaded/);
    }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({
      // ox lists the checkout's whole sparse window here, ahead of what failed.
      coverage: { complete: false, files: 0, empty: false,
        paths: Array.from({ length: 42 }, (_, day) => `data/github/2026/09/${day}/`) },
      error_class: "missing_hydration",
      error_detail: { reason: "object_refused", path: "sessions/oxp_planted/session.md", server_code: 404 },
      skipped: { total: 2, reasons: { object_refused: 2 } },
    }))));
    expect(log).toMatch(
      /ledger_sync repo="acme--a" status=unavailable class="missing_hydration" detail="[^"]+" receipt=".*object_refused.*sessions\/oxp_planted/);
    expect(log).not.toContain("data/github/");
  });

  it.each([
    ["no receipt", "sync-panics", "", /exit=2 stdout="" stderr="panic: oxp_planted"/],
    ["a receipt that is not ready and names no failure", "receipt.json", receipt({}), /exit=1 stdout="\{\\"schema_version\\":1,/],
  ])("logs how ox exited and what it wrote for %s", async (_, file, content, evidence) => {
    const { log } = await withLedgers(async (brain) => {
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", reason: expect.stringMatching(/last ledger sync failed/) });
      expect(await text("team_status", {}, brain)).not.toContain("oxp_planted");
    }, scoped((bin) => writeFileSync(join(bin, "a", file), content)));
    expect(log).toMatch(/ledger_sync repo="acme--a" status=unavailable class="unreadable" detail="[^"]+" exit=/);
    expect(log).toMatch(evidence);
  });

  it("refuses ox older than 0.17.0 without syncing", async () => {
    await withLedgers(async (brain, bin) => {
      expect(calls(bin, "|sync ")).toEqual([]);
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "not-installed", remedy: expect.stringMatching(/0\.17\.0/) });
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/0\.17\.0 or newer/);
    }, scoped((bin) => writeFileSync(join(bin, "version"), "0.16.0")));
  });

  it("syncs nothing when no ledger reader is granted", async () => {
    await withLedgers(async (brain, bin) => {
      expect(existsSync(join(bin, "calls"))).toBe(false);
      expect(JSON.parse(await text("team_status", {}, brain)).ledger_sync).toMatchObject({
        status: "not_configured", detail: expect.stringMatching(/grant team_sessions or team_recent/),
      });
      await expect(brain.sessions("acme--a", 10)).rejects.toThrow(/No unique configured repository/);
    }, (bin) => ({ ...ledgerScope(bin), syncLedgers: false }));
  });

  it("keeps two coworkers' data homes, credentials and readiness apart", async () => {
    await withLedgers(async (first, bin) => {
      const second = makeOxTeam({
        team: "team_x", cwd: bin, repositories: [{ name: "acme--a", path: join(bin, "a"), url: "https://github.com/acme/a" }],
        dataHome: join(bin, "ox-data-2"), syncLedgers: true, token: () => "oxt_second",
      });
      try {
        await second.startSync();
        expect(ledger(second)).toMatchObject({ health: "Unavailable", failure: "not-authenticated" });
        expect(ledger(first)?.health).toBe("Ok");
        expect(calls(bin, "sync --read-only --repo=repo_a").map((line) => line.split("|").slice(2, 4))).toEqual([
          [join(bin, "ox-data"), "oxt_current"], [join(bin, "ox-data-2"), "oxt_second"],
        ]);
        expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, first)).total).toBe(1);
        await expect(text("team_sessions", { repo: "acme--a" }, second)).rejects.toThrow(/team access token/);
      } finally {
        await second.stopSync();
      }
    }, scoped((bin) => writeFileSync(join(bin, "required-token"), "oxt_current")));
  });

  it("keeps other repositories syncing while one first sync is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withLedgers(async (brain, bin) => {
        const syncs = (repo: string) => existsSync(join(bin, "calls")) ? calls(bin, `--repo=${repo} `).length : 0;
        const starting = brain.startSync();
        await settle(() => existsSync(join(bin, "a/sync-started")) && ledger(brain, "acme--b")?.health === "Ok",
          "b's first sync beside a's");
        await vi.advanceTimersByTimeAsync(60_000);
        await settle(() => syncs("repo_b") === 2, "b's next sync");
        expect(syncs("repo_a")).toBe(1);
        await brain.stopSync();
        await starting;
      }, scoped((bin) => writeFileSync(join(bin, "a/hold-sync"), "")), false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a running sync with SIGTERM on shutdown", async () => {
    await withLedgers(async (brain, bin) => {
      const starting = brain.startSync();
      await until(() => existsSync(join(bin, "a/sync-started")), "the sync to start");
      await brain.stopSync();
      await starting;
      expect(existsSync(join(bin, "a/sync-stopped"))).toBe(true);
    }, scoped((bin) => writeFileSync(join(bin, "a/hold-sync"), "")), false);
  });

  it("reports a genuinely empty fresh ledger with its sync time, rather than a missing source", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: true, sessions: [], total: 0,
      }));
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain))).toMatchObject({
        sessions: [], total: 0, last_sync: expect.any(String),
      });
    });
  });

  it("merges recent work updates and sessions by time, with a repeatable bounded window per repository", async () => {
    await withLedgers(async (brain, bin) => {
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
        const glances = calls(bin, `|glance`).filter((line) => line.includes(`--repo=repo_${name}`));
        expect(glances).toHaveLength(2);
        for (const command of glances) {
          expect(command).toMatch(/\|glance --since \S+ --until \S+ --json --repo=repo_\w\|/);
          expect(command).toContain(`|${join(bin, "ox-data")}|-|-`);
        }
      }
    });
  });

  it("uses the default 72-hour window and discloses a limited activity list", async () => {
    await withLedgers(async (brain) => {
      const recent = JSON.parse(await text("team_recent", { repo: "acme--a", limit: 1 }, brain));
      expect(recent).toMatchObject({ total: 2, truncated: true, activities: [{ kind: "session" }] });
      expect(Date.parse(recent.until) - Date.parse(recent.since)).toBe(72 * 60 * 60_000);
    });
  });

  it("bounds long activity text without forwarding arbitrary metadata", async () => {
    await withLedgers(async (brain, bin) => {
      const fixture = JSON.parse(readFileSync(join(bin, "a/recent.json"), "utf8"));
      fixture.authors[0].murmurs[0].content = "x".repeat(5000);
      fixture.authors[1].sessions[0].title = "t".repeat(5000);
      fixture.authors[1].sessions[0].summary = "s".repeat(5000);
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      const recent = JSON.parse(await text("team_recent", { repo: "acme--a" }, brain));
      expect(recent.activities[0].title).toBe("t".repeat(2000) + "…");
      expect(recent.activities[0].summary).toBe("s".repeat(2000) + "…");
      expect(recent.activities[1].content).toBe("x".repeat(2000) + "…");
    });
  });

  it("returns a fresh empty activity window with zero totals", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify({
        repo: "@REPO@", since: "@SINCE@", until: "@UNTIL@", authors: [],
        stats: { total_authors: 0, total_murmurs: 0 },
      }));
      expect(JSON.parse(await text("team_recent", { repo: "acme--a" }, brain))).toMatchObject({
        total: 0, truncated: false, activities: [], last_sync: expect.any(String),
      });
    });
  });

  it.each([null, {}, { repo: "a", authors: [] }, { ledger_available: false },
    { repo: "@REPO@", since: "@SINCE@", until: "@UNTIL@", authors: [], stats: { total_authors: 0, total_murmurs: 1 } },
  ])("rejects malformed activity or inconsistent empty counts (%j)", async (fixture) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(/could not read/);
      expect(ledger(brain)?.health).toBe("Unavailable");
    });
  });

  it.each(["repo", "since", "until", "event time"])("rejects a response with a mismatched %s", async (field) => {
    await withLedgers(async (brain, bin) => {
      const fixture = JSON.parse(readFileSync(join(bin, "a/recent.json"), "utf8"));
      if (field === "event time") fixture.authors[0].murmurs[0].time = "2000-01-01T00:00:00Z";
      else fixture[field] = field === "repo" ? "repo_b" : "2000-01-01T00:00:00Z";
      writeFileSync(join(bin, "a/recent.json"), JSON.stringify(fixture));
      await expect(text("team_recent", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
    });
  });

  it.each([
    { repo: "../a" }, { repo: "acme--a", hours: 0 }, { repo: "acme--a", hours: 169 },
    { repo: "acme--a", hours: 1.5 }, { repo: "acme--a", hours: "--file=/private/secret" },
    { repo: "acme--a", limit: 21 }, { repo: "acme--a", until: "/private/secret" },
  ])("rejects unbounded activity inputs and extra flags before invoking ox (%j)", async (args) => {
    await withLedgers(async (brain, bin) => {
      await expect(text("team_recent", args, brain)).rejects.toThrow();
      expect(existsSync(join(bin, "calls"))).toBe(false);
    }, ledgerScope, false);
  });

  it("keeps a guarded reader's refusal out of the brain and recovers on the next read", async () => {
    const { log } = await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/refuse-read"), "");
      const error = await text("team_recent", { repo: "acme--a" }, brain).then(() => undefined, (e: Error) => e);
      expect(error?.message).toMatch(/could not be read in this call/);
      expect(error?.message).not.toContain("oxp_planted");
      expect(ledger(brain)?.health).toBe("Unavailable");
      rmSync(join(bin, "a/refuse-read"));
      expect(JSON.parse(await text("team_recent", { repo: "acme--a" }, brain)).total).toBe(2);
      expect(ledger(brain)?.health).toBe("Ok");
    });
    expect(log).toContain("Ledger read failed: interrupted");
  });

  it("refuses an exit-zero unavailable ledger and keeps unrelated team search usable", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: false, sessions: [], total: 0,
      }));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/not an empty session list/);
      expect(ledger(brain)?.health).toBe("Unavailable");
      await expect(brain.search("team", 1)).resolves.toEqual([]);
      expect(brain.readings().find((r) => r.capability === "brain.team")?.health).toBe("Ok");
    });
  });

  it("does not let one ledger's successful sync vouch for another", async () => {
    await withLedgers(async (brain, bin) => {
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/last ledger sync failed/);
      expect(calls(bin, "--repo=repo_a").filter((line) => !line.includes("|sync "))).toEqual([]);
      expect(JSON.parse(await text("team_sessions", { repo: "acme--b" }, brain)).total).toBe(1);
    }, scoped((bin) => writeFileSync(join(bin, "a/receipt.json"), receipt({ error_class: "git_failed" }))));
  });

  it("refuses a response for another repository even after the selected ledger passed its checks", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), readFileSync(join(bin, "b/sessions.json")));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
    });
  });

  it.each([
    { repo: "/private/secret" }, { repo: "../a" }, { repo: "acme--a", limit: 0 },
    { repo: "acme--a", limit: 21 }, { repo: "acme--a", file: "/private/secret" },
  ])("rejects unconfigured paths and extra flags before invoking ox (%j)", async (args) => {
    await withLedgers(async (brain, bin) => {
      await expect(text("team_sessions", args, brain)).rejects.toThrow();
      expect(existsSync(join(bin, "calls"))).toBe(false);
    }, ledgerScope, false);
  });

  it.each([
    { repo_id: "repo_a", team_id: "team_other" }, { repo_id: "repo_b", team_id: "team_x" },
    { repo_id: "repo_a/../../escape", team_id: "team_x" },
  ])("refuses a checkout whose binding changed after its ledger synced (%j)", async (config) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/.sageox/config.json"), JSON.stringify(config));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(calls(bin, "|session list")).toEqual([]);
      expect(fetched).toEqual([]);
    });
  });

  it("syncs no ledger for a repository bound to another team", async () => {
    await withLedgers(async (brain, bin) => {
      expect(calls(bin, "--repo=repo_a")).toEqual([]);
      expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "ledger-unavailable" });
    }, scoped((bin) => writeFileSync(join(bin, "a/.sageox/config.json"), JSON.stringify({ repo_id: "repo_a", team_id: "team_other" }))));
  });

  it("recovers when the selected checkout becomes usable, independently of a code index", async () => {
    await withLedgers(async (brain, bin) => {
      const config = readFileSync(join(bin, "a/.sageox/config.json"));
      rmSync(join(bin, "a/.sageox/config.json"));
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow();
      writeFileSync(join(bin, "a/.sageox/config.json"), config);
      expect(JSON.parse(await text("team_sessions", { repo: "acme--a" }, brain)).sessions).toHaveLength(1);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toMatch(/index|code status/);
    });
  });

  it("refuses an existing checkout whose origin no longer matches repos.conf", async () => {
    await withLedgers(async (brain, bin) => {
      execFileSync("git", ["-C", join(bin, "a"), "remote", "set-url", "origin", "https://github.com/other/repo"]);
      await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
      expect(calls(bin, "|session list")).toEqual([]);
    });
  });

  it.each([null, {}, { sessions: [], ledger_available: false }, {
    repo_id: "repo_a", sessions: [{ name: "oxp_planted" }], ledger_available: true, total: 1,
  }])("rejects malformed or unavailable output and degrades the ledger reading (%j)", async (response) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify(response));
      const error = await text("team_sessions", { repo: "acme--a" }, brain).then(() => undefined, (e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain("oxp_planted");
      expect(ledger(brain)?.health).toBe("Unavailable");
    });
  });

  it("expires a successful capability reading as its sync ages", async () => {
    await withLedgers(async (brain) => {
      await text("team_sessions", { repo: "acme--a" }, brain);
      expect(ledger(brain)?.health).toBe("Ok");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
      try {
        expect(ledger(brain)).toMatchObject({ health: "Unavailable", failure: "ledger-stale" });
      } finally { clock.mockRestore(); }
    });
  });

  it("does not let an older successful read erase a newer ledger failure", async () => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/hold-read"), "");
      const first = text("team_sessions", { repo: "acme--a" }, brain);
      await until(() => existsSync(join(bin, "a/read-started")), "the first read to wait");
      try {
        writeFileSync(join(bin, "a/unlinked"), "");
        await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/did not confirm/);
      } finally {
        writeFileSync(join(bin, "a/release-read"), "");
      }
      expect(JSON.parse(await first).total).toBe(1);
      expect(ledger(brain)?.health).toBe("Unavailable");
    });
  });

  /** Give one fixture a gateway-owned Git checkout, leaving the other on the team token. */
  function managedScope(bin: string): OxScope {
    const scope = ledgerScope(bin);
    const ledger = join(scope.dataHome!, "sageox/sageox.ai/ledgers/repo_a");
    mkdirSync(ledger, { recursive: true });
    execFileSync("git", ["init", "-q", ledger]);
    execFileSync("git", ["-C", ledger, "config", "agentToolkit.ledger", "true"]);
    execFileSync("git", ["-C", ledger, "remote", "add", "origin", "https://git.example.test/ledger.git"]);
    writeFileSync(join(bin, "a/status.json"), JSON.stringify({ ledger: { configured: true, exists: true, path: ledger } }));
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

  it("keeps a ledgerSync repository on its own Git checkout, and syncs the others over the team token", async () => {
    await withLedgers(async (brain, bin) => {
      const status = JSON.parse(await text("team_status", {}, brain));
      expect(status.ledger_sync).toMatchObject({ status: "managed", repositories: [
        { repo: "acme--a", status: "available" }, { repo: "acme--b", status: "available" },
      ] });
      expect(JSON.parse(await brain.sessions("acme--a", 10)).total).toBe(1);
      expect(JSON.parse(await brain.recent("acme--a", 72, 10)).total).toBe(2);
      expect(JSON.parse(await brain.sessions("acme--b", 10)).total).toBe(1);
      expect(readFileSync(join(bin, "git-calls"), "utf8")).toContain("fetch");
      expect(calls(bin, "|sync ").map((line) => line.split("|")[1])).toEqual([
        "sync --read-only --repo=repo_b --timeout 30m --json",
      ]);
      expect(calls(bin, "|session list")).toEqual([
        `${realpathSync(join(bin, "a"))}|session list --json --limit 10|${join(bin, "ox-data")}|oxt_current|${join(bin, "a")}`,
        `${realpathSync(bin)}|session list --json --limit 10 --repo=repo_b|${join(bin, "ox-data")}|-|-`,
      ]);
      expect(readFileSync(join(bin, "calls"), "utf8")).not.toContain("daemon");
    }, managedScope);
  });

  it("lists a team-token ledger's work updates only from where its checkout holds them all", async () => {
    await withLedgers(async (brain, bin) => {
      const brief = JSON.parse(await brain.recent("acme--b", 6, 10));
      expect(brief).toMatchObject({ work_updates_since: brief.since, total: 2 });
      for (const name of ["a", "b"]) {
        const fixture = JSON.parse(readFileSync(join(bin, name, "recent.json"), "utf8"));
        fixture.authors[0].murmurs.push({ id: `old-${name}`, user: "alice", topic: "wip",
          time: new Date(Date.now() - 30 * 60 * 60_000).toISOString(), content: "Yesterday's work." });
        fixture.authors[1].sessions.push({ name: `old-session-${name}`, user: "bob", title: "Yesterday's session",
          time: new Date(Date.now() - 31 * 60 * 60_000).toISOString() });
        fixture.stats = { total_authors: 2, total_murmurs: 2, total_sessions: 2 };
        writeFileSync(join(bin, name, "recent.json"), JSON.stringify(fixture));
      }
      const git = JSON.parse(await brain.recent("acme--a", 72, 10));
      expect(git.work_updates_since).toBe(git.since);
      expect(git).toMatchObject({ total: 4, activities: [
        { kind: "session" }, { id: "murmur-a" }, { id: "old-a" }, { name: "old-session-a" },
      ] });
      const token = JSON.parse(await brain.recent("acme--b", 72, 10));
      expect(Date.parse(token.until) - Date.parse(token.work_updates_since)).toBe(11 * 60 * 60_000);
      expect(Date.parse(token.until) - Date.parse(token.since)).toBe(72 * 60 * 60_000);
      expect(token).toMatchObject({ total: 3, activities: [
        { kind: "session" }, { id: "murmur-b" }, { name: "old-session-b" },
      ] });
    }, managedScope);
  });

  it("refuses cached sessions after a failed managed refresh while search still works", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withLedgers(async (brain, bin) => {
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
    { repo_id: "repo_a", team_id: "team_x", endpoint: "https://other.example" },
  ])("verifies the project before starting Git sync (%j)", async (config) => {
    await withLedgers(async (brain, bin) => {
      writeFileSync(join(bin, "a/.sageox/config.json"), JSON.stringify(config));
      await brain.startSync();
      expect((await brain.ledgerStatus())[0].status).toBe("unavailable");
      expect(existsSync(join(bin, "git-calls"))).toBe(false);
      expect(calls(bin, "|").filter((line) => line.startsWith(`${realpathSync(join(bin, "a"))}|`))).toEqual([]);
    }, managedScope, false);
  });

  it.skipIf(process.getuid?.() === 0)("refuses an unreadable managed sessions directory even if ox would report an empty ledger", async () => {
    await withLedgers(async (brain, bin) => {
      const sessions = join(bin, "ox-data/sageox/sageox.ai/ledgers/repo_a/sessions");
      mkdirSync(sessions, { mode: 0o300 });
      writeFileSync(join(bin, "a/sessions.json"), JSON.stringify({
        repo_id: "repo_a", ledger_available: true, sessions: [], total: 0,
      }));
      try {
        await expect(text("team_sessions", { repo: "acme--a" }, brain)).rejects.toThrow(/ledger could not be verified/);
        expect(calls(bin, "|session list")).toEqual([]);
      } finally {
        chmodSync(sessions, 0o700);
      }
    }, managedScope);
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
