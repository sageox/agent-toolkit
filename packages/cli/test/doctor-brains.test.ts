import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addBrain, allowTools } from "../src/edit-config.ts";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";
import { doctorRun } from "./cli-harness.ts";

describe("doctor and a brain's tools", () => {
  let home: string;
  let agentDir: string;
  const local = addBrain(AGENT_YAML("demo"), { preset: "local", path: "./brain" });
  const readOnly = allowTools(SETTINGS_JSON, ["mcp__brain__brain_list", "mcp__brain__brain_read"]).json;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-brains-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "persona\n");
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("passes a brain the policy narrows to reads, naming what it withholds", async () => {
    writeFileSync(join(agentDir, "agent.yaml"), local);
    writeFileSync(join(agentDir, "settings.json"), readOnly);

    const { code, stdout } = await doctorRun(home);

    expect(code).toBe(0);
    expect(stdout).toContain(
      "warn  brain local: the tool policy withholds mcp__brain__brain_write, " +
        "mcp__brain__brain_consolidate",
    );
  });

  // Judged per brain: a narrowed brain beside it must not hide one the policy shuts out.
  it("fails a brain the policy allows none of, beside one it narrows", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBrain(local, { preset: "shared", path: "../shared/demo-ida", scope: ["demo", "ida"] }),
    );
    writeFileSync(join(agentDir, "settings.json"), readOnly);

    const { code, stdout } = await doctorRun(home);

    expect(code).toBe(1);
    expect(stdout).toContain("warn  brain local: the tool policy withholds");
    expect(stdout).toContain(
      "FAIL  brain shared: the tool policy denies mcp__brain-shared-1__brain_list, " +
        "mcp__brain-shared-1__brain_read",
    );
  });
});
