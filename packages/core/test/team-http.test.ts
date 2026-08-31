import { describe, it, expect, afterEach } from "vitest";
import { tokenMatches, originAllowed, type HostedMcp } from "../src/mcp-http.ts";
import { serveTeamBrain, oxEnv, oxCwd, type TeamOx, type TeamSearch } from "../src/team-server.ts";
import { homedir } from "node:os";

let hosted: HostedMcp | undefined;
afterEach(async () => {
  await hosted?.close();
  hosted = undefined;
});

const search: TeamSearch = async (query) => [{ score: 0.9, text: `about ${query}`, file_path: "d.md" }];

/** The hosting is what is under test here, so the ox side is a stub. */
const ox = (over: Partial<TeamOx> = {}): TeamOx => ({
  search,
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
    expect(body.result.tools.map((t) => t.name)).toEqual(["team_search"]);
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
  it("passes a token supplied out-of-band, for containers with no interactive login", () => {
    const env = oxEnv({ token: "tok_abc" }, { PATH: "/usr/bin" });
    expect(env.SAGEOX_TOKEN).toBe("tok_abc");
  });

  it("points ox at a mounted auth file when given one", () => {
    const env = oxEnv({ configHome: "/mnt/secrets-store/ox" }, { PATH: "/usr/bin" });
    expect(env.XDG_CONFIG_HOME).toBe("/mnt/secrets-store/ox");
  });

  it("adds no credential when none is configured, so nothing rides along by accident", () => {
    const env = oxEnv({ team: "team_x" }, { PATH: "/usr/bin" });
    expect(env.SAGEOX_TOKEN).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("supports both at once — the token wins in ox, and both are the gateway's to hold", () => {
    const env = oxEnv({ token: "tok_abc", configHome: "/mnt/secrets-store/ox" }, {});
    expect(env).toMatchObject({ SAGEOX_TOKEN: "tok_abc", XDG_CONFIG_HOME: "/mnt/secrets-store/ox" });
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
