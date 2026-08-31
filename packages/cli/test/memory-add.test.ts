import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";

import { AGENT_YAML } from "../src/init.ts";
import { addBuzzSurface } from "../src/edit-config.ts";
import { memoryAddCmd } from "../src/cli.ts";

/**
 * `memory add private --write-scope` decides whether a brain is bounded or not.
 *
 * A scope that parses to nothing must never reach the manifest as an omitted key: omitted
 * is how "write anything" is spelled, so the quiet path turns a request to restrict the
 * agent into a grant of everything it asked to be kept away from.
 */
describe("memory add private --write-scope", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;
  const owner = generateKeypair().hex;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;

  beforeEach(() => {
    cwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "sageox-agent-memory-add-"));
    agentDir = join(root, "demo");
    mkdirSync(agentDir);
    // A private brain is bound to one Buzz surface, so the manifest needs one to load.
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBuzzSurface(AGENT_YAML("demo"), "wss://relay.example"),
    );
    process.env.AGENT_TOOLKIT_HOME = root;
  });

  afterEach(() => {
    process.chdir(cwd); // memoryAddCmd chdirs into the agent it edits
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
  });

  const manifest = () => loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
  const privateBrain = () => manifest().brains.find((brain) => brain.preset === "private");

  it("writes the prefixes it was given", async () => {
    await memoryAddCmd(["private", "--owner", owner, "--write-scope", "core,mem/skills/"]);
    expect(privateBrain()).toMatchObject({ writeScope: ["core", "mem/skills/"] });
  });

  it("leaves the brain unscoped when the flag is absent", async () => {
    await memoryAddCmd(["private", "--owner", owner]);
    expect(privateBrain()).toMatchObject({ preset: "private" });
    expect(privateBrain()).not.toHaveProperty("writeScope");
  });

  // Each of these parses to zero prefixes. Dropping the key would write the widest brain
  // there is for an operator who typed the flag precisely to narrow it.
  it.each([
    ["an empty value", ""],
    ["a whitespace-only value", "   "],
    ["separators naming nothing", ", ,"],
  ])("refuses %s rather than provisioning unrestricted writes", async (_label, value) => {
    await expect(
      memoryAddCmd(["private", "--owner", owner, "--write-scope", value]),
    ).rejects.toThrow(/--write-scope needs at least one key prefix/);
    // The refusal must also leave nothing behind: a half-written brain would be unscoped.
    expect(privateBrain()).toBeUndefined();
  });

  it("refuses a bare flag that swallows the next option as its value", async () => {
    await expect(
      memoryAddCmd(["private", "--write-scope", "--owner", owner]),
    ).rejects.toThrow(/--write-scope needs at least one key prefix/);
    expect(privateBrain()).toBeUndefined();
  });
});
