import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addBrain, allowTools } from "../src/edit-config.ts";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";
import { doctorReport as doctor } from "./cli-harness.ts";

describe("doctor and a brain's tools", () => {
  let home: string;
  let agentDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-brains-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "persona\n");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBrain(AGENT_YAML("demo"), { preset: "local", path: "./brain" }),
    );
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("names, but does not fail, a brain the policy narrows to reads", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      allowTools(SETTINGS_JSON, ["mcp__brain__brain_list", "mcp__brain__brain_read"]).json,
    );

    const report = await doctor(home);

    expect(report).toContain(
      "warn  brain local: the tool policy withholds mcp__brain__brain_write, " +
        "mcp__brain__brain_consolidate",
    );
    expect(report).not.toContain("memory it cannot use");
  });

  it("fails a brain the policy allows none of", async () => {
    writeFileSync(join(agentDir, "settings.json"), SETTINGS_JSON);

    expect(await doctor(home)).toContain(
      "FAIL  brain local: the tool policy denies mcp__brain__brain_list, mcp__brain__brain_read",
    );
  });
});
