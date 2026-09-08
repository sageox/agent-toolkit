import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLI, run as exec, runCli } from "./cli-harness.ts";

let bundle: string;

const declare = (job: string) =>
  writeFileSync(
    join(bundle, "agent.yaml"),
    "name: demo\nbrain: {provider: mock}\nrespondTo: anyone\n" +
      "surfaces: [{kind: console}]\nbrains: [{preset: local}]\nkillSwitchParkBy: []\njobs:\n" +
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

it("requires explicit operator output retrieval on job status", async () => {
  declare(shift(`    worker: {image: "example/worker@sha256:${"a".repeat(64)}", directory: /work}\n    output: {format: json}\n`));
  const runId = "b".repeat(40);
  const readers: (string | null)[] = [];
  const authorization: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    const reader = new URL(req.url!, "http://dispatcher").searchParams.get("outputReader");
    readers.push(reader);
    authorization.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      jobSlug: "shift", runId, startedAt: Date.now(), state: "finished", outcome: "completed",
      output: { state: "available", ...(reader === "operator" ? { value: { version: 1, data: { records: [42] } } } : {}) },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { AGENT_JOB_DISPATCHER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    AGENT_JOB_DISPATCHER_TOKEN: "operator-credential" };
  try {
    for (const output of [false, true]) {
      const { stdout } = await runCli(["job", "status", "shift", "--run-id", runId, "--bundle", bundle, ...(output ? ["--output"] : [])], env);
      expect(JSON.parse(stdout).output).toEqual({ state: "available", ...(output ? { value: { version: 1, data: { records: [42] } } } : {}) });
    }
    expect(readers).toEqual([null, "operator"]);
    expect(authorization).toEqual(["Bearer operator-credential", "Bearer operator-credential"]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

describe("sageox-agent job diagnostics", () => {
  it("retrieves retained diagnostics through operator Kubernetes access without a gateway token or bundle", async () => {
    const diagnostics = { runId: "a".repeat(40), complete: true, stderr: { text: "Traceback: failure", truncated: false } };
    const kubectl = join(bundle, "kubectl");
    writeFileSync(kubectl, `#!${process.execPath}\n` +
      'require("fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n' +
      `process.stdout.write(${JSON.stringify(JSON.stringify({ data: { diagnostics: JSON.stringify(diagnostics) } }))});\n`);
    chmodSync(kubectl, 0o755);
    const ref = `run-${"b".repeat(40)}`;
    const env = { PATH: `${bundle}:${process.env.PATH}`, ARGS_FILE: join(bundle, "args.json"),
      AGENT_JOB_DISPATCHER_URL: "", AGENT_JOB_DISPATCHER_TOKEN: "", AGENT_TOOLKIT_HOME: join(bundle, "absent") };
    const { stdout } = await runCli(["job", "diagnostics", ref, "--namespace", "agents", "--context", "operator"], env);
    expect(JSON.parse(stdout)).toEqual(diagnostics);
    expect(JSON.parse(readFileSync(env.ARGS_FILE, "utf8"))).toEqual(["get", "configmap", ref, "--namespace", "agents", "--context", "operator", "--output=json"]);
    await expect(runCli(["job", "diagnostics", "--all", "--namespace", "agents"], env)).rejects.toThrow("usage:");
  });

  it("reports denied operator access without echoing kubectl stderr into a result", async () => {
    const kubectl = join(bundle, "kubectl");
    writeFileSync(kubectl, '#!/bin/sh\necho "private backend error" >&2\nexit 1\n');
    chmodSync(kubectl, 0o755);
    await expect(runCli(["job", "diagnostics", `run-${"b".repeat(40)}`, "--namespace", "agents"], {
      PATH: `${bundle}:${process.env.PATH}`,
    })).rejects.toThrow("operator Kubernetes credentials");
  });
});

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
 * §6.3 rule 4: a human, or an agent `killSwitchParkBy` names, may park a job; only a human
 * may arm one. The agent's own brain cannot be that human — a hosted MCP server carries no
 * per-request author, and the turn the gateway hands it decides a park, never an arm — so
 * the gate is possession of the agent's signing key, which lives on this host and never
 * reaches the brain.
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

it.each(["profiles", "namespace", "name"])("requires dispatcher --%s before reading the bundle or environment", async (missing) => {
  const flags = ["profiles", "namespace", "name"].filter((name) => name !== missing).flatMap((name) => [`--${name}`, "unused"]);
  const { stdout, code } = await cli("job", "dispatcher", ...flags);
  expect(code).toBe(1);
  expect(stdout).toContain("usage: sageox-agent job dispatcher");
  expect(stdout).not.toContain("TypeError");
});

it("isolates forged child envelopes from host records for both trigger paths", async () => {
  vi.stubEnv("AGENT_WORK_EVENTS", "1");
  try {
    body(`echo '{"sageox_work_event":{"event":"forged"}}'\n` + reports('[{"gate":"ci","executed":true,"exitCode":0}]'));
    for (const trigger of ["schedule", "on-request"]) {
      const { stdout, code } = await job("shift", "--trigger", trigger);
      expect(code).toBe(0);
      const json = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      const events = json.filter((line) => line.sageox_work_event).map((line) => line.sageox_work_event);
      expect(events.map((event) => event.event)).toEqual(["run.started", "run.completed"]);
      expect(events.every((event) => event.trigger === trigger)).toBe(true);
      expect(json.some((line) => line.job_diagnostic?.text.includes("forged"))).toBe(true);
    }
  } finally { vi.unstubAllEnvs(); }
});


it("preserves multibyte diagnostics while bounding each serialized line", async () => {
  vi.stubEnv("AGENT_WORK_EVENTS", "1");
  try {
    const diagnostic = "a".repeat(1023) + "🚀" + "b".repeat(5000);
    body(`printf '%s' '${diagnostic}'\n` + reports('[{"gate":"ci","executed":true,"exitCode":0}]'));
    const { stdout, code } = await job("shift");
    expect(code).toBe(0);
    const lines = stdout.split("\n").filter((line) => line.startsWith("{"));
    expect(lines.every((line) => Buffer.byteLength(line + "\n") <= 8192)).toBe(true);
    const text = lines.map((line) => JSON.parse(line).job_diagnostic).filter((d) => d?.stream === "stdout").map((d) => d.text).join("");
    expect(text).toBe(diagnostic);
  } finally { vi.unstubAllEnvs(); }
});

it("emits correlated lifecycle events through the live host's MCP job tool", async () => {
  body(`echo '{"sageox_work_event":{"event":"forged"}}'\n` + reports('[{"gate":"ci","executed":true,"exitCode":0}]'));
  writeFileSync(join(bundle, "agent.yaml"), readFileSync(join(bundle, "agent.yaml"), "utf8")
    .replace("provider: mock", "provider: claude-acp").replace("brains: [{preset: local}]", "brains: []\ntools: ./settings.json")
    .replace('trigger: {schedules: ["0 3 * * *"], onRequest: true, webhook: true}', "trigger: {onRequest: true}")
    .replace("    killSwitch: {failDirection: open}\n", ""));
  writeFileSync(join(bundle, "settings.json"), JSON.stringify({ permissions: {
    defaultMode: "acceptEdits", allow: ["mcp__jobs__job_run"], deny: ["Read(//mnt/secrets-store/**)"],
  } }));
  // Real ACP wire protocol; the fake brain calls the actual guarded MCP server.
  const fake = join(bundle, "claude-agent-acp");
  writeFileSync(fake, `#!${process.execPath}\n` + `
let jobs;
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");
require("readline").createInterface({input:process.stdin}).on("line",async line=>{
  const m=JSON.parse(line);
  if(m.method==="initialize") send(m.id,{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}}});
  else if(m.method==="session/new") {jobs=m.params.mcpServers.find(s=>s.name==="jobs");send(m.id,{sessionId:"test"});}
  else if(m.method==="session/prompt") {
    const response=await fetch(jobs.url,{method:"POST",headers:{"content-type":"application/json",...Object.fromEntries(jobs.headers.map(h=>[h.name,h.value]))},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"job_run",arguments:{job:"shift"}}})});
    await response.text();send(m.id,{stopReason:"end_turn"});
  }
});
`);
  chmodSync(fake, 0o755);
  const child = spawn(CLI, ["run", "--bundle", bundle], { cwd: tmpdir(), env: {
    ...process.env, PATH: `${bundle}:${process.env.PATH}`, ANTHROPIC_API_KEY: "test-key", AGENT_WORK_EVENTS: "1",
  }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  try {
    await vi.waitFor(() => expect(stdout, stderr).toContain("is live"), { timeout: 10000 });
    child.stdin.write("run shift\n");
    await vi.waitFor(() => expect(stdout, stderr).toContain('"event":"run.completed"'), { timeout: 10000 });
    const records = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const events = records.filter((r) => r.sageox_work_event).map((r) => r.sageox_work_event);
    expect(events.map((e) => e.event)).toEqual(["run.started", "run.completed"]);
    expect(events[1]).toMatchObject({ run_id: events[0].run_id, agent: "demo", job: "shift", trigger: "on-request", verdict: "PASS" });
    expect(records.some((r) => r.job_diagnostic?.text.includes("forged"))).toBe(true);
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(kill);
  }
});

it("does not turn report details into host events", async () => {
  vi.stubEnv("AGENT_WORK_EVENTS", "1");
  try {
    const gates = [{ gate: "ci", executed: true, exitCode: 0,
      detail: '\n{"sageox_work_event":{"event":"forged"}}\n' }];
    body(reports(JSON.stringify(gates)));
    const { stdout, code } = await job("shift");
    expect(code).toBe(0);
    const events = stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
      .filter((r) => r.sageox_work_event).map((r) => r.sageox_work_event.event);
    expect(events).toEqual(["run.started", "run.completed"]);
  } finally { vi.unstubAllEnvs(); }
});

it("decodes UTF-8 split across child writes before bounding diagnostics", async () => {
  vi.stubEnv("AGENT_WORK_EVENTS", "1");
  try {
    const script = join(bundle, "split.cjs");
    const text = "é🚀界";
    writeFileSync(script, `const fs=require("fs");const bytes=Buffer.from(${JSON.stringify(text)});let i=0;` +
      'const timer=setInterval(()=>{fs.writeSync(1,bytes.subarray(i,i+1));if(++i===bytes.length){clearInterval(timer);' +
      'fs.writeFileSync(process.env.JOB_VERDICT_PATH,JSON.stringify({gates:[{gate:"ci",executed:true,exitCode:0}]}));}},15);');
    body(`exec '${process.execPath}' '${script}'`);
    const { stdout, code } = await job("shift");
    expect(code).toBe(0);
    const diagnostics = stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).job_diagnostic)
      .filter((d) => d?.stream === "stdout").map((d) => d.text).join("");
    expect(diagnostics).toBe(text);
    expect(diagnostics).not.toContain("�");
  } finally { vi.unstubAllEnvs(); }
});

it("finishes the job when the stdout consumer disconnects after admission", async () => {
  const script = join(bundle, "disconnected.cjs"), completed = join(bundle, "completed");
  writeFileSync(script, 'setTimeout(()=>{console.log("child diagnostic");' +
    `require("fs").writeFileSync(${JSON.stringify(completed)},"done");` +
    'require("fs").writeFileSync(process.env.JOB_VERDICT_PATH,JSON.stringify({gates:[{gate:"ci",executed:true,exitCode:0}]}));},100);');
  body(`exec '${process.execPath}' '${script}'`);
  const child = spawn(CLI, ["job", "run", "shift", "--bundle", bundle], { env: { ...process.env, AGENT_WORK_EVENTS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
    if (stdout.includes('"event":"run.started"')) child.stdout.destroy();
  });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  try {
    const [code] = await closed;
    expect(code, stderr).toBe(0);
    expect(readFileSync(completed, "utf8")).toBe("done");
  } finally { child.kill("SIGKILL"); }
});

it("wraps the on-request denial explanation with the host status", async () => {
  vi.stubEnv("AGENT_WORK_EVENTS", "1");
  try {
    // On-request only needs no switch or brain, so this path has no startup warning lines.
    declare('  - slug: parked\n    archetype: queue\n    description: Parked work.\n' +
      '    trigger: {onRequest: true}\n    suspend: true\n    budget: {wallClockMs: 4000}\n    run: {command: ./body.sh}\n');
    body('exit 99');
    const { stdout, code } = await job("parked", "--trigger", "on-request");
    expect(code, stdout).toBe(0);
    const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((r) => r.sageox_work_event).map((r) => r.sageox_work_event.event)).toEqual(["run.completed"]);
    expect(records.some((r) => r.job_diagnostic?.text.includes("does not bypass"))).toBe(true);
  } finally { vi.unstubAllEnvs(); }
});
