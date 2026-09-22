import { describe, it, expect, afterEach } from "vitest";
import { tokenMatches, originAllowed, type HostedMcp } from "../src/mcp-http.ts";
import { serveTeamBrain, oxEnv, oxCwd, type TeamOx, type TeamSearch } from "../src/team-server.ts";
import { devNull, homedir } from "node:os";

let hosted: HostedMcp | undefined;
afterEach(async () => {
  await hosted?.close();
  hosted = undefined;
});

const search: TeamSearch = async (query) => [{ score: 0.9, text: `about ${query}`, file_path: "d.md" }];

/** The hosting is what is under test here, so the ox side is a stub. */
const ox = (over: Partial<TeamOx> = {}): TeamOx => ({
  search,
  ledgerStatus: async () => [],
  sessions: async () => { throw new Error("no ledger configured"); },
  recent: async () => { throw new Error("no ledger configured"); },
  ...over,
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("gateway-hosted team brain", () => {
  it("answers a search for a caller holding the token", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(
      hosted.url,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_search", arguments: { query: "deploys" } } },
      { authorization: `Bearer ${hosted.token}` },
    );
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(res.status).toBe(200);
    expect(body.result.content[0].text).toContain("about deploys");
  });

  it("refuses a caller with no token, so a stray local process cannot read team knowledge", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(hosted.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });

  it("answers status over the guarded endpoint without returning search passages", async () => {
    hosted = await serveTeamBrain(ox());
    const request = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "team_status", arguments: {} } };
    expect((await post(hosted.url, request)).status).toBe(401);
    const res = await post(hosted.url, request, { authorization: `Bearer ${hosted.token}` });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    const output = body.result.content[0].text;
    expect(JSON.parse(output)).toMatchObject({
      team_search: { status: "available" },
      ledger_sync: { status: "not_configured" },
    });
    expect(output).not.toContain("about team");
  });

  it("refuses a wrong token", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(hosted.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("listens only on loopback by default", async () => {
    hosted = await serveTeamBrain(ox());
    expect(hosted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("advertises the read verbs, and nothing that writes", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(hosted.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${hosted.token}` });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["team_search", "team_status", "team_sessions", "team_recent"]);
  });

  it("turns a search failure into an error the brain can read, not a dead socket", async () => {
    hosted = await serveTeamBrain(
      ox({
        search: async () => {
          throw new Error("not authenticated. Run 'ox login' first");
        },
      }),
    );
    const res = await post(
      hosted.url,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "team_search", arguments: { query: "x" } } },
      { authorization: `Bearer ${hosted.token}` },
    );
    const body = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(200);
    expect(body.error.message).toMatch(/not authenticated/);
  });

  it("accepts a notification without replying to it", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(hosted.url, { jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: `Bearer ${hosted.token}` });
    expect(res.status).toBe(202);
  });

  it("reports an unknown method rather than hanging", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(hosted.url, { jsonrpc: "2.0", id: 2, method: "resources/list" }, { authorization: `Bearer ${hosted.token}` });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("rejects a browser page on this machine, which could otherwise read team knowledge", async () => {
    hosted = await serveTeamBrain(ox());
    const res = await post(
      hosted.url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${hosted.token}`, origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });
});

describe("token comparison", () => {
  it("accepts the real token and rejects near-misses of every length", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
});

describe("origin checks", () => {
  it("allows a non-browser client, which sends no origin", () => {
    expect(originAllowed(undefined)).toBe(true);
  });
  it("allows loopback and rejects the rest", () => {
    expect(originAllowed("http://127.0.0.1:3000")).toBe(true);
    expect(originAllowed("http://localhost:3000")).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
    expect(originAllowed("garbage")).toBe(false);
  });
});

describe("ox credential handling", () => {
  it("preserves workstation paths and endpoint while applying the configured scope", () => {
    const base = {
      PATH: "/usr/bin", HOME: "/workstation", LANG: "en_US.UTF-8", LC_ALL: "C", TZ: "UTC", TMPDIR: "/tmp",
      XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache",
      XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run", SAGEOX_ENDPOINT: "https://sageox.ai",
    };
    expect(oxEnv({}, base)).toEqual({ ...base, SAGEOX_DAEMON: "false", OX_NO_DAEMON: "1" });
    expect(oxEnv({ dataHome: "/agent-data" }, base)).toMatchObject({
      XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/agent-data", XDG_CACHE_HOME: "/agent-data/cache",
      XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run",
    });
    expect(base.XDG_CONFIG_HOME).toBe("/config");
    expect(base.XDG_DATA_HOME).toBe("/data");
  });

  it("passes a token supplied out-of-band, for containers with no interactive login", () => {
    const env = oxEnv({ token: () => "tok_abc" }, { PATH: "/usr/bin" });
    expect(env.SAGEOX_TOKEN).toBe("tok_abc");
  });

  it("reads the token per child, so a mount rewritten under the process is what goes out", () => {
    let mounted = "tok_old";
    const scope = { token: () => mounted };
    expect(oxEnv(scope, {}).SAGEOX_TOKEN).toBe("tok_old");
    mounted = "tok_new";
    expect(oxEnv(scope, {}).SAGEOX_TOKEN).toBe("tok_new");
  });

  it("adds no credential when the secret is not there to read, rather than an empty one", () => {
    // What `resolveSecret` returns for an unmounted ref. `SAGEOX_TOKEN=` would be a
    // credential as far as ox is concerned.
    expect(oxEnv({ token: () => undefined }, {}).SAGEOX_TOKEN).toBeUndefined();
  });

  it("gives ox no credential at all when the configured ref reads as nothing", () => {
    // The gateway's own environment is not this agent's credential. On a host running
    // several agents each with its own ref, an ambient `SAGEOX_TOKEN` is somebody else's,
    // and a workstation's `ox login` is whoever runs the gateway: ox would answer normally
    // as either of them.
    const env = oxEnv({ token: () => undefined }, {
      SAGEOX_TOKEN: "oxp_someone_else",
      XDG_CONFIG_HOME: "/home/operator/.config",
      PATH: "/usr/bin",
    });

    expect(env.SAGEOX_TOKEN).toBeUndefined();
    expect(env).toMatchObject({ XDG_CONFIG_HOME: devNull, PATH: "/usr/bin" });
  });

  it("keeps ox off any login on disk even with a token, which is then all it can use", () => {
    // ox skips `auth.json` for a token bound to the endpoint it calls, and reads it for any
    // other. An agent never runs `ox login`, so that file is never the agent's.
    const env = oxEnv({ token: () => "oxt_agent" }, { XDG_CONFIG_HOME: "/home/operator/.config" });

    expect(env).toMatchObject({ SAGEOX_TOKEN: "oxt_agent", XDG_CONFIG_HOME: devNull });
  });

  it("leaves an inherited token alone when no ref is configured at all", () => {
    // A workstation call — `doctor` with no team brain declared — means to use whatever
    // login this shell already has. Only a configured ref speaks for the agent.
    expect(oxEnv({ team: "team_x" }, { SAGEOX_TOKEN: "oxp_mine" }).SAGEOX_TOKEN).toBe("oxp_mine");
  });

  it("adds no credential when none is configured, so nothing rides along by accident", () => {
    const env = oxEnv({ team: "team_x" }, { PATH: "/usr/bin" });
    expect(env.SAGEOX_TOKEN).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });
});

describe("where ox runs", () => {
  it("defaults to a writable home rather than the app directory", () => {
    // The gateway's own cwd is the application directory, which is intentionally not
    // writable by the user the agent runs as — ox fails there.
    expect(oxCwd({})).toBe(homedir());
  });

  it("honours an explicit working directory", () => {
    expect(oxCwd({ cwd: "/var/lib/agent" })).toBe("/var/lib/agent");
  });
});
