import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowTools } from "../src/edit-config.ts";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";
import { doctorReport as doctor } from "./cli-harness.ts";

/**
 * The job tool held to the same pre-flight as every other gateway-hosted surface: a job
 * arms the chat door with `trigger.onRequest`, the policy is the other half of it, and half
 * of it is an agent that reads as unable to run its own jobs rather than as one not allowed
 * to. Found before deploying, which is what `doctor` is for.
 */
describe("doctor and the job tool", () => {
  let home: string;
  let agentDir: string;

  const declare = (yaml: string, trigger: string) =>
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `${yaml}\njobs:\n  - slug: shift\n    archetype: shift\n` +
        "    description: A bounded pass over the repository.\n" +
        `    trigger: ${trigger}\n` +
        "    budget: {wallClockMs: 4000}\n" +
        "    run: {command: ./body.sh, args: []}\n",
    );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-jobs-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "persona\n");
    writeFileSync(join(agentDir, "settings.json"), SETTINGS_JSON);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("names the jobs a conversation can ask for when the policy allows the tool", async () => {
    declare(AGENT_YAML("demo"), "{onRequest: true}");
    writeFileSync(
      join(agentDir, "settings.json"),
      allowTools(SETTINGS_JSON, ["mcp__jobs__job_run"]).json,
    );

    expect(await doctor(home)).toContain("ok    job tool: shift can be asked for in chat");
  });

  it("fails on a job armed for request while the policy denies the tool", async () => {
    declare(AGENT_YAML("demo"), "{onRequest: true}");

    const report = await doctor(home);

    expect(report).toContain("FAIL  1 job(s) declare trigger.onRequest but the tool policy denies");
    expect(report).toContain("mcp__jobs__job_run");
    expect(report).toContain("sageox-agent mcp add jobs");
  });

  it("fails the same way when there is no tool policy at all", async () => {
    declare(AGENT_YAML("demo").replace("tools: ./settings.json\n", ""), "{onRequest: true}");

    expect(await doctor(home)).toContain(
      "FAIL  1 job(s) declare trigger.onRequest but no tool policy is set",
    );
  });

  // A job longer than a turn is started rather than waited for, and answers in its report
  // channel. Without one it answers nowhere: whoever asked in chat is told it is running and
  // never hears again, which is the silence the whole job tool exists to end.
  it("warns about a job too long for a turn that declares nowhere to report", async () => {
    declare(AGENT_YAML("demo"), "{onRequest: true}");
    writeFileSync(
      join(agentDir, "settings.json"),
      allowTools(SETTINGS_JSON, ["mcp__jobs__job_run"]).json,
    );

    const report = await doctor(home);

    expect(report).toContain("warn  shift can outlast the 120000ms turn timeout");
    expect(report).toContain("declare no `report`");
  });

  it("says nothing about the same job once it has somewhere to report", async () => {
    declare(
      AGENT_YAML("demo"),
      "{onRequest: true}\n    report: {surface: console, channel: hive}",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      allowTools(SETTINGS_JSON, ["mcp__jobs__job_run"]).json,
    );

    expect(await doctor(home)).not.toContain("turn timeout");
  });

  // A job nobody may ask for is a complete configuration: it has a clock, and the chat door
  // is the one thing it did not arm. Saying anything here would be `doctor` arguing with a
  // manifest that says exactly what its author meant.
  it("says nothing about a job that never armed the chat door", async () => {
    declare(
      `${AGENT_YAML("demo")}\nbrains:\n  - preset: local\n`,
      '{schedules: ["0 3 * * *"]}\n    killSwitch: {failDirection: open}',
    );

    const report = await doctor(home);

    expect(report).toContain("parses and validates"); // i.e. the job was read, not rejected
    expect(report).not.toContain("job tool");
    expect(report).not.toContain("mcp__jobs__job_run");
  });
});
