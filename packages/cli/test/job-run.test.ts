import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI, run as exec } from "./cli-harness.ts";

let bundle: string;

const declare = (job: string) =>
  writeFileSync(
    join(bundle, "agent.yaml"),
    "name: demo\nbrain: {provider: mock}\nrespondTo: anyone\n" +
      "surfaces: [{kind: console}]\nbrains: [{preset: local}]\njobs:\n" +
      job,
  );

const shift = (over = "") =>
  "  - slug: shift\n    archetype: shift\n" +
  "    description: A bounded pass over the repository.\n" +
  '    trigger: {schedules: ["0 3 * * *"], onRequest: true, webhook: true}\n' +
  "    killSwitch: {failDirection: open}\n" +
  "    budget: {wallClockMs: 4000, deadlineHeadroomMs: 1000}\n" +
  "    run: {command: ./body.sh, args: []}\n" +
  over;

const body = (script: string) => {
  const path = join(bundle, "body.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
};

/** Reports the gates it names, as the artifact contract has it. */
const reports = (gates: string) =>
  `cat > "$JOB_VERDICT_PATH" <<JSON\n{"gates":${gates}}\nJSON`;

const cli = async (...argv: string[]) => {
  const env = { ...process.env };
  delete env.AGENT_TOOLKIT_HOME;
  delete env.XDG_CONFIG_HOME;
  try {
    const { stdout } = await exec(
      CLI,
      [...argv, "--bundle", bundle],
      { cwd: tmpdir(), env },
    );
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return { stdout: `${failed.stdout}${failed.stderr}`, code: failed.code };
  }
};

const job = (...argv: string[]) => cli("job", "run", ...argv);

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), "sageox-agent-job-"));
  writeFileSync(join(bundle, "AGENTS.md"), "persona\n");
  declare(shift());
});
afterEach(() => rmSync(bundle, { recursive: true, force: true }));

/**
 * The job host through the door a CronJob uses, against a bundle whose job body is a
 * shell script.
 *
 * A shell script on purpose. The toolkit's claim is that it hosts an *envelope* and knows
 * nothing about the work, and a body written in the runtime's own language would let an
 * accidental coupling — a shared import, an SDK, a required helper — pass unnoticed. Four
 * lines of `sh` can only use what the contract actually provides: an argv, some
 * environment, an exit code, and a file.
 */
describe("sageox-agent job run", () => {
  it("runs a body that is not written in this runtime, and mints its verdict", async () => {
    body(reports('[{"gate":"unit-tests","executed":true,"exitCode":0}]'));
    const { stdout, code } = await job("shift");

    expect(stdout).toContain("job shift completed");
    expect(stdout).toContain("PROVEN: unit-tests passed");
    expect(code).toBe(0);
  });

  it("hands the body its envelope, and starts it in the bundle rather than the caller's cwd", async () => {
    // `./body.sh` resolves at all only if the job started in the bundle, and the echoed
    // values are the whole of what the host tells a job about itself.
    body(`echo "envelope $JOB_SLUG/$JOB_TRIGGER/$JOB_MAX_ATTEMPTS in $(pwd)"`);
    const { stdout } = await job("shift", "--trigger", "webhook");

    expect(stdout).toContain(`envelope shift/webhook/3 in ${realpathSync(bundle)}`);
  });

  it("warms no repository workspace, so a body cannot come to depend on one", async () => {
    // Declared and still not built. The clone, the fast-forward and `ox index code` belong
    // to `run`, so a tick sees a checkout only where its deployment mounted one — read-only,
    // and never one this process built.
    writeFileSync(join(bundle, "repos.conf"), "https://github.com/acme/service\n");
    body('echo "workspace $([ -d workspace ] && echo present || echo absent)"');
    const { stdout, code } = await job("shift");

    expect(code).toBe(0);
    expect(stdout).toContain("workspace absent");
    expect(existsSync(join(bundle, "workspace"))).toBe(false);
  });

  it("passes a declared target through, converting the text a command line can only carry", async () => {
    declare(
      "  - slug: triage\n    archetype: queue\n    description: Triage one issue.\n" +
        "    trigger: {onRequest: true}\n" +
        "    budget: {wallClockMs: 4000, deadlineHeadroomMs: 1000}\n" +
        "    parameters: {issue: {type: integer, minimum: 1, required: true, description: Which issue.}}\n" +
        "    run: {command: ./body.sh, args: []}\n",
    );
    body(`echo "grading $JOB_PARAM_ISSUE"\n${reports('[{"gate":"ci","executed":true,"exitCode":0}]')}`);

    const { stdout } = await job("triage", "--trigger", "on-request", "--param", "issue=41");
    expect(stdout).toContain("grading 41");
    expect(stdout).toContain("PROVEN");
  });

  it("refuses a target the job did not declare, on this door as much as on the tool", async () => {
    declare(
      "  - slug: triage\n    archetype: queue\n    description: Triage one issue.\n" +
        "    trigger: {onRequest: true}\n" +
        "    budget: {wallClockMs: 4000, deadlineHeadroomMs: 1000}\n" +
        "    parameters: {issue: {type: integer, minimum: 1, required: true, description: Which issue.}}\n" +
        "    run: {command: ./body.sh, args: []}\n",
    );
    body('echo "should not run"');

    // Below the declared minimum: the bound is in the manifest, so it holds here too.
    const low = await job("triage", "--trigger", "on-request", "--param", "issue=0");
    expect(low.stdout).toContain('parameter "issue" must be >= 1');
    expect(low.stdout).not.toContain("should not run");
    expect(low.stdout).toContain("NOT PROVEN");

    // And a run that names no target at all is refused rather than sweeping.
    const none = await job("triage", "--trigger", "on-request");
    expect(none.stdout).toContain('parameter "issue" is required');
    expect(none.stdout).not.toContain("should not run");

    const malformed = await job("triage", "--trigger", "on-request", "--param", "41");
    expect(malformed.stdout).toContain("--param takes <name>=<value>");

    // A door that cannot carry a value says so, rather than sweeping with the target
    // dropped — the run that happened would not be the one the operator asked for.
    const wrongDoor = await job("triage", "--param", "issue=41");
    expect(wrongDoor.stdout).toContain("--param needs --trigger on-request");
    expect(wrongDoor.stdout).not.toContain("should not run");
  });

  it("does not read a body that reported nothing as a body that found nothing", async () => {
    body('echo "worked, said nothing"');
    const { stdout, code } = await job("shift");

    expect(stdout).toContain("job shift completed");
    expect(stdout).toContain("NOT PROVEN");
    // The envelope worked, so the job is green; the verdict is what says nothing was proven.
    expect(code).toBe(0);
  });

  it("never renders a gate that did not execute as one that passed", async () => {
    body(
      reports(
        '[{"gate":"unit-tests","executed":true,"exitCode":0},' +
          '{"gate":"jscpd","executed":false,"exitCode":null,"detail":"not on PATH"}]',
      ),
    );
    const { stdout } = await job("shift");

    expect(stdout).toContain("PROVEN: unit-tests passed");
    expect(stdout).toMatch(/NOT PROVEN: .*jscpd did not execute/);
    expect(stdout).not.toMatch(/^PROVEN/m); // the headline is the combined verdict
  });

  it("fails the job when a body outlives its budget, and stops what it started too", async () => {
    declare(shift().replace("wallClockMs: 4000", "wallClockMs: 300"));
    // The `sleep` is a stand-in for the harness every real job body shells out to. It
    // holds the inherited stdout, so if the group were not stopped this call would sit
    // here for thirty seconds rather than returning with a verdict.
    body('trap \'echo "released"; exit 0\' TERM\nsleep 30 &\nwait');
    const { stdout, code } = await job("shift");

    expect(stdout).toContain("released");
    expect(stdout).toContain("job shift budget-bowout");
    expect(stdout).toContain("NOT PROVEN");
    expect(code).toBe(1);
  });

  it("fails the job when the body cannot be started at all", async () => {
    const { stdout, code } = await job("shift"); // no body.sh was ever written
    expect(stdout).toContain("job shift crashed");
    expect(code).toBe(1);
  });

  it("starts nothing for a suspended job, and does not call that a job failure", async () => {
    declare(`${shift()}    suspend: true\n`);
    body('echo "should not run"');
    const { stdout, code } = await job("shift");

    expect(stdout).toContain("job shift denied-suspend");
    expect(stdout).not.toContain("should not run");
    expect(code).toBe(0);
  });

  it("will not let an operator at a terminal claim to be the human who bypasses", async () => {
    declare(`${shift()}    suspend: true\n`);
    body('echo "should not run"');
    const { stdout } = await job("shift", "--trigger", "on-request");

    expect(stdout).toContain("denied-suspend");
    expect(stdout).toContain("a run started from this CLI is `system`, and does not bypass");
  });

  it("says a declared switch cannot be read, rather than reading like it has none", async () => {
    body(reports("[]"));
    const { stdout } = await job("shift");
    expect(stdout).toContain("kill switch cannot be read at all; it fails open");
  });

  it("will not run a job through a trigger it never declared", async () => {
    // `loadManifest` refuses a job that takes a schedule without a kill switch. An
    // on-request-only job legally has none — so running it on a schedule anyway would put
    // unattended work behind nothing that can stop it, which is the shape the manifest
    // exists to make unwritable. The declaration has to hold at the door too.
    declare(
      "  - slug: restricted\n    archetype: queue\n" +
        "    description: On-request only, and therefore free to declare no kill switch.\n" +
        "    trigger: {onRequest: true}\n" +
        "    budget: {wallClockMs: 4000}\n" +
        "    run: {command: ./body.sh, args: []}\n",
    );
    body('echo "should not run"');

    const scheduled = await job("restricted", "--trigger", "schedule");
    expect(scheduled.stdout).toContain("denied-trigger");
    expect(scheduled.stdout).toContain("does not arm the schedule trigger");
    expect(scheduled.stdout).not.toContain("should not run");
    expect(scheduled.code).toBe(1);

    // The door it did declare still opens.
    const asked = await job("restricted", "--trigger", "on-request");
    expect(asked.stdout).toContain("should not run"); // i.e. it ran, as declared
    expect(asked.code).toBe(0);
  });

  it("runs the job anyway when its status channel cannot be reached", async () => {
    // The console surface takes replies and cannot receive a top-level post, so this is a
    // destination the run can never announce itself to. It says so and does the work: a
    // status post is best-effort, and a job that produced a real verdict is not failed by
    // a channel that could not carry it.
    declare(`${shift()}    report: {surface: console, channel: hive}\n`);
    body(reports('[{"gate":"unit-tests","executed":true,"exitCode":0}]'));
    const { stdout, code } = await job("shift");

    expect(stdout).toContain("cannot reach its status channel");
    expect(stdout).toContain("job shift completed");
    expect(stdout).toContain("PROVEN: unit-tests passed");
    expect(code).toBe(0);
  });

  it("names the jobs it does have when asked for one it does not", async () => {
    const { stdout, code } = await job("sweep");
    expect(stdout).toContain('declares no job "sweep" — it has: shift');
    expect(code).toBe(1);
  });
});

/**
 * The other two doors, and the only place a job is armed.
 *
 * §6.3 rule 4: anyone may park a job, only a human may arm one. The agent's own brain
 * cannot be that human — a hosted MCP server carries no per-request author, and the author
 * of a *turn* is not the author of a tool call inside it — so the gate is possession of the
 * agent's signing key, which lives on this host and never reaches the brain.
 */
describe("sageox-agent job arm | park", () => {
  it("says where the switch would go when there is nowhere to put it", async () => {
    // The switch is the agent's own engram. Without a private brain on a Buzz surface there
    // is no store to write, and the job runs the way its failDirection says — forever.
    const { stdout, code } = await cli("job", "arm", "shift");
    expect(stdout).toContain("has no private brain on a Buzz surface");
    expect(stdout).toContain("the switch is the agent's own engram");
    expect(code).toBe(1);
  });

  it("names the jobs that have a switch when asked to flip one that does not", async () => {
    declare(
      shift() +
        "  - slug: restricted\n    archetype: queue\n" +
        "    description: On-request only, and therefore free to declare no kill switch.\n" +
        "    trigger: {onRequest: true}\n" +
        "    budget: {wallClockMs: 4000}\n" +
        "    run: {command: ./body.sh, args: []}\n",
    );
    const { stdout, code } = await cli("job", "park", "restricted");
    expect(stdout).toContain('job "restricted" declares no killSwitch, so there is nothing to park');
    expect(stdout).toContain("these declare one: shift");
    expect(code).toBe(1);
  });

  it("offers both verbs in its usage, and refuses a third", async () => {
    const { stdout, code } = await cli("job", "disarm", "shift");
    expect(stdout).toContain("sageox-agent job arm | park <slug>");
    expect(code).toBe(1);
  });
});

/**
 * Which path arms a job, said before an incident rather than during one — the last of D9's
 * acceptance criteria, and the reason it is a criterion at all: an operator who has to
 * discover the arming path while a job is misbehaving is discovering it at the worst
 * possible time.
 */
describe("doctor and the job arming path", () => {
  it("names the switches, the command that arms them, and who may not", async () => {
    const { stdout } = await cli("doctor");
    expect(stdout).toContain("job kill switches: shift → mem/shift/enabled");
    expect(stdout).toContain("arm a job with `sageox-agent job arm <slug>` on this host");
    expect(stdout).toContain("may park a switch through brain_write and can never arm one");
  });

  it("warns when a declared switch has no store to live in", async () => {
    // Reported, not enforced: the job runs exactly as its failDirection says, which
    // somebody chose. But nothing can park it either, and a kill switch nobody can flip is
    // one in name.
    const { stdout } = await cli("doctor");
    expect(stdout).toContain("killSwitch declared by shift but this agent has no private brain");
  });
});
