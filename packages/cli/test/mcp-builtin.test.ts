import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";

import { runCli } from "./cli-harness.ts";

describe("built-in MCP setup", () => {
  let home: string;
  let agentDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-mcp-builtin-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "agent.yaml"), AGENT_YAML("demo"));
    writeFileSync(join(agentDir, "settings.json"), SETTINGS_JSON);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // A bound is refused while a human is still present to fix it, before the credential
  // prompt and before anything is spawned — so a typo costs a message rather than a server
  // configured without the narrowing its operator thought they had written.
  describe("a malformed bound", () => {
    const add = (scope: string) =>
      runCli([
        "mcp", "add", "--name", "gh", "--command", "node", "--args", "gh.js",
        "--scope", scope, "--agent", "demo",
      ], { AGENT_TOOLKIT_HOME: home });

    it("refuses a bound with no argument name, and leaves the manifest alone", async () => {
      const before = readFileSync(join(agentDir, "agent.yaml"), "utf8");
      await expect(add("acme/service")).rejects.toThrow(/--scope takes <argument>=<value>/);
      await expect(add("=acme/service")).rejects.toThrow(/--scope takes <argument>=<value>/);
      expect(readFileSync(join(agentDir, "agent.yaml"), "utf8")).toBe(before);
    });

    it("refuses a bound with no permitted values, which would refuse every call", async () => {
      await expect(add("repo=")).rejects.toThrow(/needs at least one permitted value/);
    });
  });

  it("uses the generic MCP flow without adding a manifest server or replacing policy data", async () => {
    const configBefore = readFileSync(join(agentDir, "agent.yaml"), "utf8");
    const settingsBefore = readFileSync(join(agentDir, "settings.json"), "utf8");
    const { stdout } = await runCli(["mcp", "add", "surface-egress", "--agent", "demo"], {
      AGENT_TOOLKIT_HOME: home,
    });

    expect(stdout).toContain('built-in mcp server "surface-egress"');
    expect(stdout).toContain("mcp__surface-egress__post_message");
    expect(readFileSync(join(agentDir, "agent.yaml"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
  });

  // The job tool is the same shape: gateway-built-in, so there is nothing to spawn and no
  // `mcpServers` entry — only the namespaced policy name, which is the string nobody should
  // ever type by hand. The jobs themselves are declared in `agent.yaml`; this is the door.
  describe("the job tool", () => {
    // A job with an unattended trigger must declare a kill switch, and a switch is read
    // through a brain — so the scheduled case below carries both.
    const declare = (trigger: string, extra = "") =>
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `${AGENT_YAML("demo")}\nbrains:\n  - preset: local\n` +
          "jobs:\n  - slug: shift\n    archetype: shift\n" +
          "    description: A bounded pass over the repository.\n" +
          `    trigger: ${trigger}\n${extra}` +
          "    budget: {wallClockMs: 4000}\n" +
          "    run: {command: ./body.sh, args: []}\n",
      );

    it("writes the namespaced policy name rather than leaving it to be typed", async () => {
      declare("{onRequest: true}");

      const { stdout } = await runCli(["mcp", "add", "jobs", "--agent", "demo"], { AGENT_TOOLKIT_HOME: home });

      expect(stdout).toContain('built-in mcp server "jobs"');
      expect(stdout).toContain("mcp__jobs__job_run");
    });

    // The gateway serves this tool only for jobs that armed the door, so allowing it for an
    // agent with none is a permission for a tool that will never exist.
    it("refuses to allow a tool nothing would serve, and leaves the policy alone", async () => {
      const before = readFileSync(join(agentDir, "settings.json"), "utf8");

      await expect(
        runCli(["mcp", "add", "jobs", "--agent", "demo"], { AGENT_TOOLKIT_HOME: home }),
      ).rejects.toThrow(/demo declares no jobs, so mcp__jobs__job_run would never be served/);

      declare('{schedules: ["0 3 * * *"]}', "    killSwitch: {failDirection: open}\n");
      await expect(
        runCli(["mcp", "add", "jobs", "--agent", "demo"], { AGENT_TOOLKIT_HOME: home }),
      ).rejects.toThrow(/no job in demo declares trigger.onRequest/);

      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
    });
  });

});
