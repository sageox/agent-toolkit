import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "@sageox/agent-toolkit-core";
import {
  declaredSecrets,
  declaredWhere,
  spawnedSecretSpec,
  requireCredential,
  requireDeclaredSecrets,
} from "../src/credentials.ts";
import { parseReposConf } from "../src/repos.ts";

let dir: string;
let envPath: string;
const saved = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cred-"));
  envPath = join(dir, ".env");
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

const spec = {
  name: "ANTHROPIC_API_KEY",
  label: "Paste your key",
  looksRight: (v: string) => v.startsWith("sk-ant-"),
};

const interactive = { interactive: () => true };
const headless = { interactive: () => false };

describe("what an MCP server's secret is asked for as", () => {
  const savedGh = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (savedGh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGh;
  });

  it("never inherits from the shell, whatever the server calls its credential", async () => {
    // Not a fact about GitHub. `gh`, `direnv`, `psql` and CI all export exactly these names,
    // and an over-scoped *valid* credential is the failure that never reports itself — it
    // works indefinitely while the agent holds reach nobody chose. A wrong one, by contrast,
    // is rejected by the server on the first call.
    for (const [ref, envVar] of [
      ["GITHUB_TOKEN", "GITHUB_TOKEN"],
      ["DROVER_GH", "GITHUB_PERSONAL_ACCESS_TOKEN"],
      ["PG_URL", "DATABASE_URL"],
      ["LINEAR_KEY", "LINEAR_API_KEY"],
    ]) {
      expect(spawnedSecretSpec(ref, envVar, "the server").neverInherited, `${ref}=${envVar}`).toBe(true);
    }

    process.env.GITHUB_TOKEN = "ghp_whatever_this_shell_is_carrying";
    let asked = false;
    const value = await requireCredential(spawnedSecretSpec("GITHUB_TOKEN", "GITHUB_TOKEN", "the server"), {
      ...interactive,
      envPath,
      ask: async () => {
        asked = true;
        return "github_pat_chosen_for_this_agent";
      },
      log: () => {},
    });

    expect(asked).toBe(true);
    expect(value).toBe("github_pat_chosen_for_this_agent");
  });

  it("still takes the credential from the agent's own .env — it refuses the shell, not the bundle", async () => {
    // Otherwise this costs a paste on every command rather than once at bring-up.
    process.env.GITHUB_TOKEN = "ghp_whatever_this_shell_is_carrying";
    writeFileSync(envPath, "GITHUB_TOKEN=github_pat_this_agents_own\n");
    const value = await requireCredential(spawnedSecretSpec("GITHUB_TOKEN", "GITHUB_TOKEN", "the server"), {
      ...interactive,
      envPath,
      ask: async () => "never-asked",
    });
    expect(value).toBe("github_pat_this_agents_own");
  });

  it("makes no claim about the value's shape, because the server is the one that knows", () => {
    // A wrong credential reports itself: the server rejects it on the first call and the
    // audit line carries its words (`tool-audit.test.ts`). A format check here would only
    // warn, only for the formats we happened to hardcode, and would go stale when one
    // changed — while reading as coverage for every server it never looked at.
    for (const [ref, envVar] of [
      ["GITHUB_TOKEN", "GITHUB_TOKEN"],
      ["PG_URL", "DATABASE_URL"],
    ]) {
      expect(spawnedSecretSpec(ref, envVar, "the server").looksRight, `${ref}=${envVar}`).toBeUndefined();
    }
    expect(spawnedSecretSpec("PG_URL", "DATABASE_URL", "the server").label).toContain(
      "supplied to the server as DATABASE_URL",
    );
  });
});

describe("requireCredential", () => {
  it("uses an existing value without asking", async () => {
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-already-here\n");
    let asked = false;
    const value = await requireCredential(spec, {
      ...interactive,
      envPath,
      ask: async () => {
        asked = true;
        return "sk-ant-new";
      },
    });
    expect(value).toBe("sk-ant-already-here");
    expect(asked).toBe(false);
  });

  it("asks for a never-inherited credential the environment already holds", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-whatever-shell-this-is";
    const value = await requireCredential(
      { ...spec, neverInherited: true },
      { ...interactive, envPath, ask: async () => "sk-ant-chosen-for-this-agent", log: () => {} },
    );
    expect(value).toBe("sk-ant-chosen-for-this-agent");
  });

  it("still takes a never-inherited credential from the agent's own .env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-whatever-shell-this-is";
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-this-agents-own\n");
    const value = await requireCredential(
      { ...spec, neverInherited: true },
      { ...interactive, envPath, ask: async () => "sk-ant-never-asked" },
    );
    expect(value).toBe("sk-ant-this-agents-own");
  });

  it("asks when missing and saves the answer", async () => {
    const value = await requireCredential(spec, {
      ...interactive,
      envPath,
      ask: async () => "sk-ant-typed-by-human",
      log: () => {},
    });

    expect(value).toBe("sk-ant-typed-by-human");
    expect(readFileSync(envPath, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-typed-by-human");
  });

  it("writes the secret file as owner-only", async () => {
    await requireCredential(spec, {
      ...interactive,
      envPath,
      ask: async () => "sk-ant-x",
      log: () => {},
    });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("never prompts without a terminal — a service must fail, not hang", async () => {
    let asked = false;
    await expect(
      requireCredential(spec, {
        ...headless,
        envPath,
        ask: async () => {
          asked = true;
          return "sk-ant-x";
        },
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);

    expect(asked).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });

  it("refuses an empty answer rather than saving a blank key", async () => {
    await expect(
      requireCredential(spec, { ...interactive, envPath, ask: async () => "  ", log: () => {} }),
    ).rejects.toThrow(/no value given/);
    expect(existsSync(envPath)).toBe(false);
  });

  it("warns but still saves a key of an unexpected shape", async () => {
    const lines: string[] = [];
    const value = await requireCredential(spec, {
      ...interactive,
      envPath,
      ask: async () => "not-the-usual-prefix",
      log: (l) => lines.push(l),
    });
    expect(value).toBe("not-the-usual-prefix");
    expect(lines.join("")).toMatch(/does not look like/);
    expect(readFileSync(envPath, "utf8")).toContain("not-the-usual-prefix");
  });

  it("keeps an existing key rather than overwriting it", async () => {
    writeFileSync(envPath, "OTHER=1\nANTHROPIC_API_KEY=sk-ant-original\n");
    await requireCredential(spec, {
      ...interactive,
      envPath,
      ask: async () => "sk-ant-replacement",
      log: () => {},
    });
    const contents = readFileSync(envPath, "utf8");
    expect(contents).toContain("sk-ant-original");
    expect(contents).not.toContain("sk-ant-replacement");
  });
});

describe("file-mounted credentials", () => {
  it("accepts a secret mounted as a file, so a container needs no env var", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    writeFileSync(join(dir, "ANTHROPIC_API_KEY"), "sk-ant-from-a-file\n");
    const value = await requireCredential(
      { name: "ANTHROPIC_API_KEY", label: "key" },
      { secretsDir: dir, interactive: () => false, envPath: join(dir, "absent.env") },
    );
    // Trailing newline stripped: a mounted file usually has one, and a key with a
    // newline fails authentication in a way that is miserable to debug.
    expect(value).toBe("sk-ant-from-a-file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still fails loudly when no file and no env value exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    await expect(
      requireCredential(
        { name: "TOTALLY_UNSET_KEY_XYZ", label: "key" },
        { secretsDir: dir, interactive: () => false, envPath: join(dir, "absent.env") },
      ),
    ).rejects.toThrow(/not set/);
    rmSync(dir, { recursive: true, force: true });
  });
});

const FLEET = `
name: fleet-demo
brain: { provider: claude-acp }
respondTo: anyone
tools: ./settings.json
surfaces:
  - kind: buzz
    relayUrl: wss://relay.example
    identity: DEMO_NSEC
  - kind: slack
    identity: DEMO_SLACK_BOT
    appToken: DEMO_SLACK_APP
    channels: [{ id: C0123, reply: private }]
brains:
  - preset: local
    path: ./brain
    age:
      recipient: age1demorecipient
      identitySecret: DEMO_AGE_IDENTITY
mcpServers:
  - name: tracker
    command: npx
    args: ["-y", "tracker-mcp"]
    secrets: { TRACKER_API_KEY: DEMO_TRACKER_KEY }
jobs:
  - slug: nightly
    archetype: sweep
    description: A bounded pass over the repository.
    trigger: { schedules: ["0 3 * * *"] }
    killSwitch: { failDirection: closed }
    budget: { wallClockMs: 3600000 }
    run:
      command: node
      args: ["runner/src/nightly.ts"]
      secrets: { GH_TOKEN: DEMO_JOB_TOKEN }
`;

const PRIVATE_REPO = "private https://github.com/acme/service\n";

describe("declared secretRefs", () => {
  let secretsDir: string;
  // `resolveSecret` falls back to the environment, and a developer's shell often exports
  // GITHUB_TOKEN. Take the ambient answer out of these tests.
  const savedGithub = process.env.GITHUB_TOKEN;
  const savedTracker = process.env.DEMO_TRACKER_KEY;
  const savedJob = process.env.DEMO_JOB_TOKEN;

  beforeEach(() => {
    secretsDir = mkdtempSync(join(tmpdir(), "declared-"));
    delete process.env.GITHUB_TOKEN;
    delete process.env.DEMO_TRACKER_KEY;
    delete process.env.DEMO_JOB_TOKEN;
  });
  afterEach(() => {
    rmSync(secretsDir, { recursive: true, force: true });
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithub;
    if (savedTracker === undefined) delete process.env.DEMO_TRACKER_KEY;
    else process.env.DEMO_TRACKER_KEY = savedTracker;
    if (savedJob === undefined) delete process.env.DEMO_JOB_TOKEN;
    else process.env.DEMO_JOB_TOKEN = savedJob;
  });

  it("finds every ref a bundle declares, wherever it is declared", () => {
    const declared = declaredSecrets(loadManifest(FLEET), parseReposConf(PRIVATE_REPO));
    expect(declared.map((secret) => secret.name)).toEqual([
      "DEMO_NSEC",
      "DEMO_SLACK_BOT",
      "DEMO_SLACK_APP",
      "DEMO_AGE_IDENTITY",
      "DEMO_TRACKER_KEY", // an MCP server's own credential
      // A job body's, which resolves on every run rather than once at startup — so its
      // absence is a crashed tick at 3am unless it is asked for here, with the rest.
      "DEMO_JOB_TOKEN",
      "GITHUB_TOKEN", // repos.conf's private clone
    ]);
    // Every one names the line that declares it, not just the ref.
    expect(declared.map(declaredWhere)).toContain("surfaces[1].appToken (slack)");
    expect(declared.map(declaredWhere)).toContain(
      'mcpServers[0].secrets.TRACKER_API_KEY (server "tracker")',
    );
    expect(declared.map(declaredWhere)).toContain(
      'jobs[0].run.secrets.GH_TOKEN (job "nightly")',
    );
  });

  it("leaves out a ref the deployment keeps off this process's own directory", () => {
    // Listed, it would refuse the launch of every agent that split a credential out — the
    // arrangement `run.jobSecrets` exists to describe.
    const split = loadManifest(`${FLEET}      jobSecrets: { GH_APP_PEM: DEMO_JOB_PEM }\n`);
    const declared = declaredSecrets(split, parseReposConf(PRIVATE_REPO));

    expect(declared.map((secret) => secret.name)).not.toContain("DEMO_JOB_PEM");
    writeFileSync(join(secretsDir, "GITHUB_TOKEN"), "ghp_x");
    for (const name of ["DEMO_NSEC", "DEMO_SLACK_BOT", "DEMO_SLACK_APP", "DEMO_AGE_IDENTITY"]) {
      writeFileSync(join(secretsDir, name), "value");
    }
    writeFileSync(join(secretsDir, "DEMO_TRACKER_KEY"), "value");
    writeFileSync(join(secretsDir, "DEMO_JOB_TOKEN"), "value");
    // The PEM is absent from this directory and the launch still goes ahead.
    expect(requireDeclaredSecrets(declared, { dir: secretsDir })).toEqual([]);
  });

  it("names run.jobSecrets when the ref that did not resolve is a job's own", () => {
    // The arrangement above, spelled wrong: a credential moved to the directory only
    // `job run` is given, but left in `run.secrets`. The launch is refused — nothing here
    // can tell that from a typo, and the whole surface goes down for a credential nothing
    // read — so the message has to name the field that both isolates it and lets the agent
    // start. The other two remedies it offers are "put it back where the gateway reads it".
    for (const name of ["DEMO_NSEC", "DEMO_SLACK_BOT", "DEMO_SLACK_APP", "DEMO_TRACKER_KEY"]) {
      writeFileSync(join(secretsDir, name), "value");
    }
    writeFileSync(join(secretsDir, "GITHUB_TOKEN"), "ghp_x");
    const declared = declaredSecrets(loadManifest(FLEET), parseReposConf(PRIVATE_REPO));

    let message = "";
    try {
      requireDeclaredSecrets(declared, { dir: secretsDir });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/1 declared secret\(s\) did not resolve/);
    expect(message).toContain('jobs[0].run.secrets.GH_TOKEN (job "nightly")');
    expect(message).toContain("run.jobSecrets");
  });

  it("withholds that remedy from a ref the gateway itself also reads", () => {
    // The hint is advice about one feature, and the feature sharing the ref is the one it
    // is wrong for: a `private` checkout clones inside the gateway, so moving GITHUB_TOKEN
    // to `run.jobSecrets` would leave repos.conf's declaration unresolved and the launch
    // still refused. Which declaration was pushed first must not decide that — jobs are
    // pushed before repos.conf, so first-wins would have sent the operator the wrong way.
    const shared = loadManifest(`
name: shared-demo
brain: { provider: claude-acp }
respondTo: anyone
surfaces: [{ kind: console }]
jobs:
  - slug: nightly
    archetype: sweep
    description: A bounded pass over the repository.
    trigger: { onRequest: true }
    budget: { wallClockMs: 3600000 }
    run: { command: node, args: ["nightly.ts"], secrets: { GH_TOKEN: GITHUB_TOKEN } }
`);
    const declared = declaredSecrets(shared, parseReposConf(PRIVATE_REPO));

    expect(declared).toHaveLength(1);
    expect(declaredWhere(declared[0])).toBe(
      'jobs[0].run.secrets.GH_TOKEN (job "nightly") and repos.conf (private: service)',
    );

    let message = "";
    try {
      requireDeclaredSecrets(declared, { dir: secretsDir });
    } catch (error) {
      message = (error as Error).message;
    }
    // Both remedies, each under the line it is true of. The job's is still stated — it is
    // correct advice about the job — but it can no longer read as advice about the ref,
    // because the checkout is named right beside it with its own answer.
    expect(message).toContain(
      '      jobs[0].run.secrets.GH_TOKEN (job "nightly")\n          if GITHUB_TOKEN is mounted only',
    );
    expect(message).toContain(
      "      repos.conf (private: service)\n          Use a fine-grained token",
    );
  });

  it("keeps that remedy for a ref two jobs share, since it is true of both", () => {
    // Two jobs that both need the credential can both move it, so the remedy survives —
    // which is why the hint names no job index. `where` already names every line, and a
    // remedy true of both has to read as one remedy rather than as advice about jobs[0].
    const twoJobs = loadManifest(`
name: two-job-demo
brain: { provider: claude-acp }
respondTo: anyone
surfaces: [{ kind: console }]
jobs:
  - slug: nightly
    archetype: sweep
    description: A bounded pass over the repository.
    trigger: { onRequest: true }
    budget: { wallClockMs: 3600000 }
    run: { command: node, args: ["nightly.ts"], secrets: { GH_TOKEN: DEMO_JOB_TOKEN } }
  - slug: weekly
    archetype: sweep
    description: A wider pass over the repository.
    trigger: { onRequest: true }
    budget: { wallClockMs: 3600000 }
    run: { command: node, args: ["weekly.ts"], secrets: { GH_TOKEN: DEMO_JOB_TOKEN } }
`);
    const declared = declaredSecrets(twoJobs, []);

    expect(declared).toHaveLength(1);
    expect(declaredWhere(declared[0])).toBe(
      'jobs[0].run.secrets.GH_TOKEN (job "nightly") and jobs[1].run.secrets.GH_TOKEN (job "weekly")',
    );
    let message = "";
    try {
      requireDeclaredSecrets(declared, { dir: secretsDir });
    } catch (error) {
      message = (error as Error).message;
    }
    // Both lines listed, then the remedy once beneath them: it is one instruction, and
    // repeating it under each would read as two different things to go and do.
    expect(message).toContain(
      '      jobs[0].run.secrets.GH_TOKEN (job "nightly")\n' +
        '      jobs[1].run.secrets.GH_TOKEN (job "weekly")\n' +
        "          if DEMO_JOB_TOKEN is mounted only",
    );
    expect(message.match(/run\.jobSecrets rather than run\.secrets/g)).toHaveLength(1);
    // No index, or it would be advice about one of the two lines it names.
    expect(message).not.toContain("jobs[0].run.jobSecrets");
  });

  it("names every missing ref at once, with where it is declared and how to get one", () => {
    const declared = declaredSecrets(loadManifest(FLEET), parseReposConf(PRIVATE_REPO));
    let message = "";
    try {
      requireDeclaredSecrets(declared, { dir: secretsDir });
    } catch (error) {
      message = (error as Error).message;
    }

    // One message, not one restart per secret.
    expect(message).toMatch(/6 declared secret\(s\) did not resolve/);
    for (const name of [
      "DEMO_NSEC",
      "DEMO_SLACK_BOT",
      "DEMO_SLACK_APP",
      "DEMO_TRACKER_KEY",
      "DEMO_JOB_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      expect(message).toContain(name);
    }
    expect(message).toContain("surfaces[0].identity (buzz)");
    expect(message).toContain("`sageox-agent identity create` makes one");
    expect(message).toContain(secretsDir);
  });

  it("refuses a private repository's GITHUB_TOKEN at boot, not at clone time", () => {
    const manifest = loadManifest(`
name: repo-demo
brain: { provider: claude-acp }
respondTo: anyone
surfaces: [{ kind: console }]
`);
    expect(() =>
      requireDeclaredSecrets(declaredSecrets(manifest, parseReposConf(PRIVATE_REPO)), {
        dir: secretsDir,
      }),
    ).toThrow(/GITHUB_TOKEN — declared by repos\.conf \(private: service\)/);

    // A public-only repos.conf declares nothing, so it must not ask for a token.
    expect(
      declaredSecrets(manifest, parseReposConf("https://github.com/sageox/agent-toolkit\n")),
    ).toEqual([]);
  });

  it("declares one entry for a ref two features share, naming both places", () => {
    // The shape every migrated fleet agent has: a bundle-local GitHub MCP server and a
    // `private` checkout, both reading GITHUB_TOKEN. Two entries would prompt twice and
    // report "2 declared secret(s) did not resolve" for one file supplied once.
    const manifest = loadManifest(`
name: gh-demo
brain: { provider: claude-acp }
respondTo: anyone
surfaces: [{ kind: console }]
mcpServers:
  - name: github
    command: node
    args: [github-mcp.js]
    secrets: {GITHUB_TOKEN: GITHUB_TOKEN}
    scope: {repo: [acme/service]}
`);
    const both = declaredSecrets(manifest, parseReposConf(PRIVATE_REPO));

    expect(both).toHaveLength(1);
    expect(both[0].name).toBe("GITHUB_TOKEN");
    expect(declaredWhere(both[0])).toBe(
      'mcpServers[0].secrets.GITHUB_TOKEN (server "github") and ' +
        "repos.conf (private: service)",
    );
    expect(() => requireDeclaredSecrets(both, { dir: secretsDir })).toThrow(
      /1 declared secret\(s\) did not resolve/,
    );
  });

  it("keeps a shared ref fatal when either feature cannot start without it", () => {
    // A team brain's ox token degrades — `ox login` authenticates instead. Nothing else
    // does, so a ref shared with a feature that has no fallback must not inherit the
    // gentler reading and let an agent start into a credential it cannot do without.
    const manifest = loadManifest(`
name: gh-demo
brain: { provider: claude-acp }
respondTo: anyone
surfaces: [{ kind: console }]
brains: [{preset: team, team: team_x, token: GITHUB_TOKEN}]
`);
    const shared = declaredSecrets(manifest, parseReposConf(PRIVATE_REPO));

    expect(shared).toHaveLength(1);
    expect(shared[0].degraded).toBeUndefined();
    expect(() => requireDeclaredSecrets(shared, { dir: secretsDir })).toThrow(
      /did not resolve/,
    );
  });

  it("reports a withheld age identity instead of refusing to start", () => {
    const manifest = loadManifest(FLEET);
    for (const name of ["DEMO_NSEC", "DEMO_SLACK_BOT", "DEMO_SLACK_APP", "DEMO_TRACKER_KEY", "DEMO_JOB_TOKEN"]) {
      writeFileSync(join(secretsDir, name), "value\n");
    }
    // Mounting the identity only where decryption is allowed is what the deployment
    // contract asks for, so the agent starts and says what it cannot do.
    const degraded = requireDeclaredSecrets(
      declaredSecrets(manifest, parseReposConf("")),
      { dir: secretsDir },
    );
    expect(degraded.map((secret) => secret.name)).toEqual(["DEMO_AGE_IDENTITY"]);
    expect(degraded[0].degraded).toMatch(/plaintext vault files stay readable/);
  });

  it("declares the team brain's ox token, defaulted or named, without making it fatal", () => {
    const team = (token: string) => `
name: team-demo
brain: { provider: mock }
respondTo: anyone
surfaces: [{ kind: console }]
brains:
  - { preset: team, team: team_jihjpfkt8b${token} }
`;
    const defaulted = declaredSecrets(loadManifest(team("")), []);
    expect(defaulted.map((s) => [s.name, declaredWhere(s)])).toEqual([
      ["SAGEOX_TOKEN", "brains[0].token (defaulted to SAGEOX_TOKEN)"],
    ]);

    const named = declaredSecrets(loadManifest(team(", token: DROVER_OX_TOKEN")), []);
    expect(named.map((s) => [s.name, declaredWhere(s)])).toEqual([
      ["DROVER_OX_TOKEN", "brains[0].token"],
    ]);

    // Not fatal: `ox login` writes an auth.json that authenticates just as well, so a
    // workstation legitimately has no token and the agent still starts.
    const degraded = requireDeclaredSecrets(named, { dir: secretsDir });
    expect(degraded.map((s) => s.name)).toEqual(["DROVER_OX_TOKEN"]);
    expect(degraded[0].degraded).toMatch(/auth\.json authenticates instead/);
  });

  it("says nothing when every declared ref is mounted", () => {
    for (const name of [
      "DEMO_NSEC",
      "DEMO_SLACK_BOT",
      "DEMO_SLACK_APP",
      "DEMO_AGE_IDENTITY",
      "DEMO_TRACKER_KEY",
      "DEMO_JOB_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      writeFileSync(join(secretsDir, name), "value\n");
    }
    expect(
      requireDeclaredSecrets(declaredSecrets(loadManifest(FLEET), parseReposConf(PRIVATE_REPO)), {
        dir: secretsDir,
      }),
    ).toEqual([]);
  });
});

/**
 * The team brain's token is asked for on a workstation that `ox login` already
 * authenticates, because that login is not in the bundle — the container built from it has
 * no ambient credential and fails every `team_search`. Declining has to stay cheap, though:
 * local runs work on the login alone, so a blank answer must not end the interview.
 */
describe("a credential whose absence degrades rather than breaks", () => {
  it("returns empty on a blank answer instead of throwing", async () => {
    const said: string[] = [];
    const value = await requireCredential(
      { ...spec, name: "SAGEOX_TOKEN", optional: true },
      { ...interactive, ask: async () => "  ", envPath, log: (line) => said.push(line) },
    );

    expect(value).toBe("");
    expect(said.join("")).toMatch(/skipped/);
    // Nothing written: a skipped credential must not leave a blank line in .env that
    // `readEnvValue` would later hand back as a set-but-empty token.
    expect(existsSync(envPath)).toBe(false);
  });

  it("still refuses a blank answer for a credential nothing works without", async () => {
    await expect(
      requireCredential(spec, { ...interactive, ask: async () => "", envPath }),
    ).rejects.toThrow(/still unset/);
  });

  it("reports rather than throws when there is no terminal to ask in", async () => {
    const said: string[] = [];
    const value = await requireCredential(
      { ...spec, name: "SAGEOX_TOKEN", optional: true },
      { ...headless, envPath, log: (line) => said.push(line) },
    );

    expect(value).toBe("");
    expect(said.join("")).toContain(envPath);
  });
});
