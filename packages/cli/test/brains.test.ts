import { describe, it, expect } from "vitest";
import {
  wireBrains,
  toolNamesFor,
  BRAIN_TOOL_NAMES,
  PRIVATE_BRAIN_TOOL_NAMES,
  DEFAULT_OX_TOKEN_SECRET,
} from "../src/brains.ts";

const opts = { agentDir: "/agents/harry", self: { command: "/usr/bin/node", args: ["--import", "tsx", "/cli.ts"] } };

describe("wireBrains", () => {
  it("wires nothing when no brains are configured", () => {
    expect(wireBrains([], opts)).toEqual({ servers: [], hosted: [], unsupported: [] });
  });

  it("serves a local brain from a vault inside the agent's home", () => {
    const { servers } = wireBrains([{ preset: "local", path: "./brain" }], opts);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("brain");
    expect(servers[0].env[0]).toEqual({ name: "BRAIN_VAULT_ROOT", value: "/agents/harry/brain" });
    expect(servers[0].args).toContain("/agents/harry/brain");
  });

  it("resolves the vault against the agent home, not the working directory", () => {
    const { servers } = wireBrains([{ preset: "local", path: "notes" }], opts);
    expect(servers[0].env[0].value).toBe("/agents/harry/notes");
  });

  it("lets a different vault server be swapped in", () => {
    const { servers } = wireBrains(
      [{ preset: "local", path: "./brain", command: "python3", args: ["brain_mcp.py"] }],
      opts,
    );
    expect(servers[0].command).toBe("python3");
    expect(servers[0].args).toEqual(["brain_mcp.py"]);
  });

  it("hosts an age-encrypted vault so its identity never enters the brain process", () => {
    const age = { recipient: `age1${"q".repeat(58)}`, identitySecret: "AGE_IDENTITY" };
    const { servers, hosted } = wireBrains([{ preset: "local", path: "./brain", age }], opts);
    expect(servers).toEqual([]);
    expect(hosted).toEqual([
      {
        preset: "vault",
        brainPreset: "local",
        name: "brain",
        root: "/agents/harry/brain",
        age,
      },
    ]);
  });

  it("gives two shared brains distinct server names", () => {
    const { servers } = wireBrains(
      [
        { preset: "shared", path: "./a", scope: ["x", "a"] },
        { preset: "shared", path: "./b", scope: ["x", "b"] },
      ],
      opts,
    );
    expect(new Set(servers.map((s) => s.name)).size).toBe(2);
  });

  it("serves the team brain from the gateway, alongside a spawned vault brain", () => {
    const { servers, hosted, unsupported } = wireBrains(
      [{ preset: "local", path: "./brain" }, { preset: "team", team: "team_x" }],
      opts,
    );
    expect(servers.map((s) => s.name)).toEqual(["brain"]);
    expect(hosted.map((h) => h.name)).toEqual(["team-brain"]);
    expect(unsupported).toEqual([]);
  });

  it("hosts private memory in the gateway, where the Nostr signer stays", () => {
    const { servers, hosted, unsupported } = wireBrains(
      [{ preset: "private", owner: "a".repeat(64) }],
      opts,
    );
    expect(servers).toHaveLength(0);
    expect(hosted).toEqual([
      { preset: "private", name: "private-brain", owner: "a".repeat(64) },
    ]);
    expect(unsupported).toEqual([]);
  });

  it("carries a private brain's write scope through to the hosted server", () => {
    const { hosted } = wireBrains(
      [{ preset: "private", owner: "a".repeat(64), writeScope: ["mem/skills/"] }],
      opts,
    );
    expect(hosted[0]).toMatchObject({ preset: "private", writeScope: ["mem/skills/"] });
  });

  it("never puts a credential in a brain server's environment", () => {
    const { servers } = wireBrains([{ preset: "local", path: "./brain" }], opts);
    // A vault brain is configured entirely by a path; that is why stdio is safe here.
    expect(servers[0].env.map((e) => e.name)).toEqual(["BRAIN_VAULT_ROOT"]);
  });

  it("re-invokes this CLI with the loader flags it was started with", () => {
    const { servers } = wireBrains([{ preset: "local", path: "./brain" }], opts);
    expect(servers[0].command).toBe("/usr/bin/node");
    expect(servers[0].args.slice(0, 3)).toEqual(["--import", "tsx", "/cli.ts"]);
    expect(servers[0].args).toContain("brain-server");
  });

  it("names the tools doctor checks the policy for", () => {
    expect(BRAIN_TOOL_NAMES).toEqual([
      "brain_list",
      "brain_read",
      "brain_write",
      "brain_consolidate",
    ]);
  });

  it("uses key-value tools for private memory, including tombstones", () => {
    expect(PRIVATE_BRAIN_TOOL_NAMES).toEqual([
      "brain_list",
      "brain_read",
      "brain_write",
      "brain_delete",
    ]);
  });
});

describe("the team brain is hosted, not spawned", () => {
  it("never becomes a stdio child, so ox's token stays out of the brain's reach", () => {
    const { servers, hosted } = wireBrains([{ preset: "team", team: "team_x" }], opts);
    expect(servers).toHaveLength(0);
    expect(hosted).toHaveLength(1);
  });

  it("carries the credential location to the gateway, which is what runs ox", () => {
    const { hosted } = wireBrains(
      [{ preset: "team", team: "team_x", repo: "repo_y", configHome: "/mnt/secrets-store/ox" }],
      opts,
    );
    expect(hosted[0]).toMatchObject({ team: "team_x", repo: "repo_y", configHome: "/mnt/secrets-store/ox" });
  });

  it("carries the token's secretRef, so a bundle can reach SAGEOX_TOKEN at all", () => {
    const { hosted } = wireBrains([{ preset: "team", team: "team_x", token: "OX_TOKEN_ASHBY" }], opts);
    expect(hosted[0]).toMatchObject({ token: "OX_TOKEN_ASHBY" });
  });

  it("names the default secretRef when the manifest names none, rather than nothing", () => {
    const { hosted } = wireBrains([{ preset: "team", team: "team_x" }], opts);
    expect(hosted[0]).toMatchObject({ token: DEFAULT_OX_TOKEN_SECRET });
  });

  it("still spawns plaintext vault brains itself, which hold no credential", () => {
    const { servers, hosted } = wireBrains(
      [{ preset: "local", path: "brain" }, { preset: "team", team: "team_x" }],
      opts,
    );
    expect(servers.map((s) => s.name)).toEqual(["brain"]);
    expect(hosted.map((h) => h.name)).toEqual(["team-brain"]);
  });
});

describe("tool names the policy must admit", () => {
  it("namespaces brain tools, because that is what the agent actually asks for", () => {
    expect(toolNamesFor([{ preset: "local", path: "brain" }])).toEqual([
      "mcp__brain__brain_list",
      "mcp__brain__brain_read",
      "mcp__brain__brain_write",
      "mcp__brain__brain_consolidate",
    ]);
  });

  it("namespaces every team-brain tool, taking the list from the server that serves them", () => {
    expect(toolNamesFor([{ preset: "team", team: "team_x" }])).toEqual([
      "mcp__team-brain__team_search",
    ]);
  });

  it("namespaces the private brain tools under its hosted server", () => {
    expect(toolNamesFor([{ preset: "private", owner: "a".repeat(64) }])).toEqual([
      "mcp__private-brain__brain_list",
      "mcp__private-brain__brain_read",
      "mcp__private-brain__brain_write",
      "mcp__private-brain__brain_delete",
    ]);
  });

  it("uses the shared brain's full-list index after another brain", () => {
    const names = toolNamesFor([
      { preset: "local", path: "brain" },
      { preset: "shared", path: "../shared/a-b", scope: ["a", "b"] },
    ]);
    expect(names).toContain("mcp__brain-shared-1__brain_read");
    expect(names).not.toContain("mcp__brain-shared-0__brain_read");
  });

  it("never returns a bare tool name, which would silently match nothing", () => {
    const names = toolNamesFor([
      { preset: "local", path: "brain" },
      { preset: "team", team: "team_x" },
    ]);
    expect(names.every((n) => n.startsWith("mcp__"))).toBe(true);
  });

  it("uses the same server name the wiring registers, or the policy guards nothing", () => {
    const brains = [{ preset: "local" as const, path: "brain" }, { preset: "team" as const, team: "t" }];
    const { servers, hosted } = wireBrains(brains, opts);
    const registered = [...servers.map((s) => s.name), ...hosted.map((h) => h.name)];
    for (const name of registered) {
      expect(toolNamesFor(brains).some((t) => t.startsWith(`mcp__${name}__`))).toBe(true);
    }
  });
});
