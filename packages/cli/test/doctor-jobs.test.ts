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
  it("reports the parkers in the spelling an event carries, not the one an operator typed", async () => {
    // `chat-surfaces.md` spells `owner` as an npub and a Buzz event carries hex, so an
    // unnormalized parker list matches nobody — silently, until the emergency it exists
    // for. `owner` and `allowlist` are normalized at load; this is the third list.
    const npub = "npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9";
    const hex = "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240";
    declare(
      `${AGENT_YAML("demo")}\nbrains:\n  - preset: local\nkillSwitchParkBy: ["${npub}"]\n`,
      '{schedules: ["0 3 * * *"]}\n    killSwitch: {failDirection: open}',
    );

    expect(await doctor(home)).toContain(`honoured from a human, and from ${hex}`);
  });

  it("says nothing about a job that never armed the chat door", async () => {
    declare(
      `${AGENT_YAML("demo")}\nbrains:\n  - preset: local\nkillSwitchParkBy: []\n`,
      '{schedules: ["0 3 * * *"]}\n    killSwitch: {failDirection: open}',
    );

    const report = await doctor(home);

    expect(report).toContain("parses and validates"); // i.e. the job was read, not rejected
    expect(report).not.toContain("job tool");
    expect(report).not.toContain("mcp__jobs__job_run");
  });
  /**
   * A job whose body is a prompt: the gateway holds its clock, so `run` reads the prompt at
   * startup and refuses to launch on a file it cannot read. `doctor` has to find that first
   * — the same rule that puts every declared `secretRef` in this report.
   */
  /** Slack rather than console: a scheduled turn answers with a top-level post. */
  const SLACK_SURFACE =
    "surfaces:\n  - kind: slack\n    identity: TEST_SLACK_BOT_TOKEN\n" +
    "    appToken: TEST_SLACK_APP_TOKEN\n    channels: [{id: C01, name: hive, reply: private}]\n";

  const TOKENS = { TEST_SLACK_BOT_TOKEN: "xoxb-test", TEST_SLACK_APP_TOKEN: "xapp-test" };

  const declarePrompt = (body: string, report = "{surface: slack, channel: C01}", surface = SLACK_SURFACE) =>
    writeFileSync(
      join(agentDir, "agent.yaml"),
      AGENT_YAML("demo").replace("surfaces:\n  - kind: console\n", surface) +
        "\nbrains:\n  - preset: local\nkillSwitchParkBy: []\n" +
        "jobs:\n  - slug: daily-digest\n    archetype: watch\n" +
        "    description: One short post per day.\n" +
        "    trigger: {schedules: ['0 18 * * *'], timezone: America/Los_Angeles}\n" +
        "    killSwitch: {failDirection: closed}\n" +
        `    prompt: ${body}\n` +
        `    report: ${report}\n`,
    );

  it("names a scheduled turn's prompt, its size, and when it next fires", async () => {
    mkdirSync(join(agentDir, "jobs"));
    writeFileSync(
      join(agentDir, "jobs", "digest.md"),
      "---\nname: daily-digest\ndescription: One short post per day.\n---\nSummarize the day.\n",
    );
    declarePrompt("{file: ./jobs/digest.md}");

    const report = await doctor(home, TOKENS);

    expect(report).toContain('job "daily-digest" is a scheduled turn');
    expect(report).toContain(join(agentDir, "jobs", "digest.md"));
    expect(report).toMatch(/\(\d+ bytes\), next \d{4}-\d{2}-\d{2} 18:00:00 America\/Los_Angeles/);
  });

  it("fails on a prompt file that is not there, rather than at 18:00", async () => {
    declarePrompt("{file: ./jobs/digest.md}");

    // `doctorReport` hands back stdout either way, so the path alone would pass on a run
    // that merely mentioned the file. The verdict beside it is what says `run` would refuse.
    expect(await doctor(home, TOKENS)).toMatch(/FAIL\s+job "daily-digest" prompt .*jobs\/digest\.md/);
  });

  it("fails when the turn would have nowhere to post", async () => {
    declarePrompt("'Summarize the day.'", "{surface: slack, channel: nowhere}");

    const report = await doctor(home, TOKENS);

    expect(report).toContain("FAIL");
    expect(report).toContain("does not list as a channel");
  });

  // The one a channel list cannot answer: console lists the channel and has no way to
  // publish a new top-level message in it, so `run` refuses a turn that would answer there.
  it("fails when the report surface carries no top-level posts at all", async () => {
    declarePrompt(
      "'Summarize the day.'",
      "{surface: console, channel: local}",
      "surfaces:\n  - kind: console\n    channels: [{id: local, reply: private}]\n",
    );

    const report = await doctor(home);

    expect(report).toContain("FAIL");
    expect(report).toContain("carries no top-level posts");
  });
});
