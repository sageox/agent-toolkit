import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMcpServer } from "../src/edit-config.ts";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";
import { loadManifest } from "@sageox/agent-toolkit-core";

import { CLI, run } from "./cli-harness.ts";

describe("agent command working directory", () => {
  let root: string;
  let elsewhere: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sageox-agent-cwd-"));
    elsewhere = join(root, "unrelated-cwd");
    mkdirSync(elsewhere);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ["AGENT_TOOLKIT_HOME", (dir: string) => dir],
    ["XDG_CONFIG_HOME", (dir: string) => join(dir, "agent-toolkit", "agents")],
  ] as const)("starts relative MCP commands from an agent home set by %s", async (variable, homeFor) => {
    const configured = join(root, "configured-home");
    const agents = homeFor(configured);
    const agent = join(agents, "demo");
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      join(agent, "agent.yaml"),
      addMcpServer(AGENT_YAML("demo"), {
        name: "cwd-check",
        command: "node",
        args: ["./cwd-server.mjs"],
      }),
    );

    const settings = JSON.parse(SETTINGS_JSON) as { permissions: { allow: string[] } };
    settings.permissions.allow.push("mcp__cwd-check__where");
    writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));

    writeFileSync(
      join(agent, "cwd-server.mjs"),
      `process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const result = message.method === "tools/list"
      ? { tools: [{ name: "where", inputSchema: { type: "object" } }] }
      : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    );

    const env = { ...process.env };
    delete env.AGENT_TOOLKIT_HOME;
    delete env.XDG_CONFIG_HOME;
    env[variable] = configured;

    const { stdout } = await run(CLI, ["doctor", "demo"], {
      cwd: elsewhere,
      env,
    });

    expect(stdout).toContain("mcp server \"cwd-check\": 1/1 tool(s) allowed");
    expect(stdout).toContain("all checks passed");
  });

  it("runs an arbitrary bundle without an authoring home", async () => {
    const bundle = join(root, "portable-bundle");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "agent.yaml"), AGENT_YAML("portable"));
    writeFileSync(join(bundle, "settings.json"), SETTINGS_JSON);

    const env = { ...process.env };
    delete env.AGENT_TOOLKIT_HOME;
    delete env.XDG_CONFIG_HOME;
    const { stdout } = await run(CLI, ["doctor", "--bundle", bundle], {
      cwd: elsewhere,
      env,
    });

    expect(stdout).toContain(`config ${join(bundle, "agent.yaml")} parses and validates`);
    expect(stdout).toContain("all checks passed");
  });

  it("reads a relative --secrets directory from where it was typed, in run as in doctor", async () => {
    // `run` chdirs into the agent's home before resolving secrets. Left relative, the flag
    // would name a directory under that home, so `doctor` would clear a bundle `run` then
    // refuses over the very files doctor just read.
    const agents = join(root, "relative-secrets");
    const agent = join(agents, "demo");
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      join(agent, "agent.yaml"),
      `name: demo
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: slack
    identity: TEST_SLACK_BOT
    appToken: TEST_SLACK_APP
    channels: [{ id: C0123, reply: private }]
`,
    );
    const secrets = join(elsewhere, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "TEST_SLACK_BOT"), "xoxb-test\n", { mode: 0o600 });
    writeFileSync(join(secrets, "TEST_SLACK_APP"), "xapp-test\n", { mode: 0o600 });

    const env = { ...process.env, AGENT_TOOLKIT_HOME: agents };
    const args = ["--agent", "demo", "--secrets", "secrets"];

    const doctor = await run(CLI, ["doctor", ...args], {
      cwd: elsewhere,
      env,
    });
    expect(doctor.stdout).toContain("secretRef TEST_SLACK_BOT resolves");

    // Same directory, same flag: `run` must get past the preflight too. It goes on to fail
    // in Slack, which is the proof the token was found and used rather than not found.
    const started = await run(CLI, ["run", ...args], {
      cwd: elsewhere,
      env,
    }).catch((error: { stdout?: string; stderr?: string }) => error);
    const output = `${started.stdout ?? ""}${started.stderr ?? ""}`;
    expect(output).not.toContain("did not resolve");
  }, 30_000);

  it("configures, diagnoses, and reads age-encrypted markdown through a secretRef", async () => {
    const agents = join(root, "agents");
    const agent = join(agents, "demo");
    const brain = join(agent, "brain");
    const secrets = join(root, "secrets");
    mkdirSync(brain, { recursive: true });
    mkdirSync(secrets);
    writeFileSync(join(agent, "agent.yaml"), AGENT_YAML("demo"));

    const identity = execFileSync("age-keygen", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const recipient = identity.match(/^# public key: (age1\S+)$/m)?.[1];
    if (!recipient) throw new Error("age-keygen did not return a public recipient");

    const env = { ...process.env, AGENT_TOOLKIT_HOME: agents };
    await run(
      CLI,
      [
        "memory", "add", "local", "--agent", "demo",
        "--age-recipient", recipient,
        "--age-identity", "HEALTH_AGE_IDENTITY",
      ],
      { env },
    );

    const configured = loadManifest(readFileSync(join(agent, "agent.yaml"), "utf8"));
    expect(configured.brains[0]).toMatchObject({
      preset: "local",
      age: { recipient, identitySecret: "HEALTH_AGE_IDENTITY" },
    });

    writeFileSync(join(secrets, "HEALTH_AGE_IDENTITY"), identity, { mode: 0o600 });
    execFileSync("age", ["--encrypt", "--recipient", recipient, "--output", join(brain, "health.md.age")], {
      input: "allergic to penicillin\n",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const read = await run(
      CLI,
      ["memory", "read", "--agent", "demo", "--secrets", secrets, "--query", "penicillin"],
      { env },
    );
    expect(read.stdout).toContain("allergic to penicillin");

    const doctor = await run(
      CLI,
      ["doctor", "--agent", "demo", "--secrets", secrets],
      { env },
    );
    expect(doctor.stdout).toContain("age is installed for encrypted markdown memory");
    expect(doctor.stdout).toContain(
      "age identity secretRef HEALTH_AGE_IDENTITY matches its recipient",
    );
    expect(doctor.stdout).toContain("all checks passed");

    writeFileSync(join(brain, "deploys.md"), "ships on Tuesdays\n");
    unlinkSync(join(secrets, "HEALTH_AGE_IDENTITY"));
    const plaintextOnly = await run(
      CLI,
      ["memory", "read", "--agent", "demo", "--secrets", join(root, "missing-secrets")],
      { env },
    );
    expect(plaintextOnly.stdout).toContain("ships on Tuesdays");
    expect(plaintextOnly.stdout).toContain(
      "Encrypted files not inspected (access denied): health.md.age",
    );
    const missingIdentity = await run(
      CLI,
      ["doctor", "--agent", "demo", "--secrets", join(root, "missing-secrets")],
      { env },
    );
    expect(missingIdentity.stdout).toContain(
      "warn  brains[0].age.identitySecret: secretRef HEALTH_AGE_IDENTITY does not resolve",
    );
    // Warned, not failed: withholding the identity from a deployment is a posture someone
    // chose, and the plaintext half of the vault still works.
    expect(missingIdentity.stdout).toContain("all checks passed");

    const wrongIdentity = execFileSync("age-keygen", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(secrets, "HEALTH_AGE_IDENTITY"), wrongIdentity, { mode: 0o600 });
    await expect(
      run(CLI, ["doctor", "--agent", "demo", "--secrets", secrets], {
        env,
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        "age identity secretRef HEALTH_AGE_IDENTITY does not match its configured recipient",
      ),
    });
    // Nine subprocesses — two age-keygen, one age encrypt, six CLI runs — land this at
    // 4.0-4.5s on a CI runner, close enough to the 5s default to fail on a slow one.
  }, 30_000);
});
