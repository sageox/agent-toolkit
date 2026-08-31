import { describe, it, expect } from "vitest";
import {
  addMcpServer,
  addBrain,
  DuplicateBrainError,
  ensureToolsPath,
  allowTools,
} from "../src/edit-config.ts";
import { loadManifest, resolveMcpServer } from "@sageox/agent-toolkit-core";
import { toolsOutsideScope } from "../src/cli.ts";
import { parse } from "yaml";

const BASE = `name: a
brain:
  provider: mock
respondTo: owner-only
surfaces:
  - kind: console
`;

describe("resolving a server declaration", () => {
  it("fills in what a declaration leaves out", () => {
    const r = resolveMcpServer({ name: "pg", command: "npx", args: ["-y", "x"] });
    expect(r).toMatchObject({ name: "pg", command: "npx", args: ["-y", "x"], secrets: {}, env: {} });
  });
});

describe("adding a server to a manifest", () => {
  const GH = { name: "gh", command: "npx", args: ["-y", "server-github"] };

  it("creates the list when the agent has none, and still parses", () => {
    const yaml = addMcpServer(BASE, GH);
    expect(parse(yaml).mcpServers).toEqual([GH]);
    expect(parse(yaml).name).toBe("a"); // the rest of the manifest survives
  });

  it("appends to an existing list", () => {
    const once = addMcpServer(BASE, GH);
    const twice = addMcpServer(once, { name: "pg", command: "npx", args: [] });
    expect(parse(twice).mcpServers).toHaveLength(2);
  });

  it("refuses a duplicate name, which would make the policy ambiguous", () => {
    const once = addMcpServer(BASE, GH);
    expect(() => addMcpServer(once, { name: "gh", command: "x", args: [] })).toThrow(/already has/i);
  });

  it("writes a bound the manifest schema accepts and the broker can read", () => {
    // The round trip is the point: a `scope` the CLI writes and the schema rejects would be
    // a manifest no later command can load, including the one that wrote it.
    // Loadable, unlike BASE: this asserts what the schema makes of the entry, so the rest
    // of the manifest has to satisfy it too.
    const yaml = addMcpServer(`${BASE}owner: npub1abc\n`, {
      ...GH,
      scope: { repo: ["acme/service", "acme/tools"] },
    });
    const declared = loadManifest(yaml).mcpServers[0]!;
    expect(resolveMcpServer(declared).scope).toEqual({ repo: ["acme/service", "acme/tools"] });
  });
});

describe("pointing the manifest at a policy", () => {
  it("sets it when absent", () => {
    const { yaml, changed } = ensureToolsPath(BASE, "./settings.json");
    expect(changed).toBe(true);
    expect(parse(yaml).tools).toBe("./settings.json");
  });

  it("leaves an existing policy path alone", () => {
    const withTools = ensureToolsPath(BASE, "./a.json").yaml;
    expect(ensureToolsPath(withTools, "./b.json")).toMatchObject({ changed: false });
  });
});

describe("allowing tools", () => {
  const settings = JSON.stringify({ permissions: { defaultMode: "acceptEdits", allow: [] } });

  it("adds the names it was given", () => {
    const { json, added } = allowTools(settings, ["mcp__fs__read_file"]);
    expect(added).toEqual(["mcp__fs__read_file"]);
    expect(JSON.parse(json).permissions.allow).toContain("mcp__fs__read_file");
  });

  it("does not duplicate a name already allowed", () => {
    const once = allowTools(settings, ["mcp__fs__read_file"]).json;
    const { added, json } = allowTools(once, ["mcp__fs__read_file", "mcp__fs__list_directory"]);
    expect(added).toEqual(["mcp__fs__list_directory"]);
    expect(JSON.parse(json).permissions.allow).toHaveLength(2);
  });

  it("keeps the rest of the policy, including deny rules", () => {
    const withDeny = JSON.stringify({
      permissions: { defaultMode: "acceptEdits", allow: [], deny: ["Read(//mnt/secrets-store/**)"] },
    });
    const { json } = allowTools(withDeny, ["mcp__fs__read_file"]);
    expect(JSON.parse(json).permissions.deny).toEqual(["Read(//mnt/secrets-store/**)"]);
  });
});

describe("adding shared brains", () => {
  it("allows distinct declared groups and refuses the same group in another order", () => {
    const one = addBrain(BASE, { preset: "shared", path: "/a", scope: ["a", "b"] });
    const two = addBrain(one, { preset: "shared", path: "/b", scope: ["a", "c"] });
    expect(parse(two).brains).toHaveLength(2);
    expect(() =>
      addBrain(two, { preset: "shared", path: "/elsewhere", scope: ["b", "a"] }),
    ).toThrow(/already has/i);
  });

  it("keeps singleton brain presets singleton", () => {
    const one = addBrain(BASE, { preset: "local" });
    expect(() => addBrain(one, { preset: "local" })).toThrow(/already has/i);
  });

  it("names the scope it refused, since a shared brain is not a singleton", () => {
    const one = addBrain(BASE, { preset: "shared", path: "/a", scope: ["a", "b"] });
    expect(() => addBrain(one, { preset: "shared", path: "/b", scope: ["b", "a"] })).toThrow(
      /scoped to b, a/,
    );
  });

  it("marks 'already configured' as its own error, so callers can repair the policy", () => {
    const one = addBrain(BASE, { preset: "local" });
    expect(() => addBrain(one, { preset: "local" })).toThrow(DuplicateBrainError);
  });
});

describe("a bound the tools cannot carry", () => {
  // `scope` is fail-closed, so a tool that does not take the bound argument is refused on
  // every call. That is the safe direction and a silent one — the agent simply cannot use
  // the tool, and the reason is a manifest line nobody re-reads. The schemas come back from
  // `tools/list` for free, so the answer is available while a human is still present.
  const schema = (...props: string[]) => ({
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
  });

  it("says nothing when every tool takes the bound argument", () => {
    const tools = [
      { name: "pr_list", inputSchema: schema("repo", "state") },
      { name: "issue_view", inputSchema: schema("repo", "number") },
    ];
    expect(toolsOutsideScope(tools, { repo: ["acme/service"] })).toEqual([]);
  });

  it("names the tools a bound would refuse on every call", () => {
    // The real shape: a server that splits the repository into owner and name takes neither
    // `repo` nor anything the operator wrote, so the bound refuses it forever.
    const tools = [
      { name: "pr_list", inputSchema: schema("repo") },
      { name: "search_code", inputSchema: schema("query") },
      { name: "get_me", inputSchema: schema() },
    ];
    expect(toolsOutsideScope(tools, { repo: ["acme/service"] })).toEqual([
      { tool: "search_code", missing: ["repo"] },
      { tool: "get_me", missing: ["repo"] },
    ]);
  });

  it("says nothing when there is no bound, since nothing is being refused", () => {
    const tools = [{ name: "get_me", inputSchema: schema() }];
    expect(toolsOutsideScope(tools, {})).toEqual([]);
  });

  it("stays quiet about a tool that publishes no schema, rather than inventing a finding", () => {
    // An absent schema is unknown, not empty. Guessing would turn a terse server into a
    // page of findings about tools that are probably fine.
    const tools = [{ name: "pr_list" }, { name: "issue_view", inputSchema: {} }];
    expect(toolsOutsideScope(tools, { repo: ["acme/service"] })).toEqual([]);
  });

  it("reports every bound argument a tool is missing, not just the first", () => {
    const tools = [{ name: "run_query", inputSchema: schema("sql") }];
    expect(toolsOutsideScope(tools, { database: ["analytics"], schema: ["public"] })).toEqual([
      { tool: "run_query", missing: ["database", "schema"] },
    ]);
  });
});
