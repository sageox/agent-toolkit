import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_YAML } from "../src/init.ts";
import { CLI } from "./cli-harness.ts";

/**
 * `validate` exists to be run where `doctor` cannot: a repository that authors `agent.yaml`
 * files, with no agent home, no credential, and no relay. So every test here supplies a bare
 * file and nothing else, and the exit code is the assertion that matters — it is the whole
 * of what a CI step reads.
 */
function validate(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(CLI, ["validate", ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** The manifest from the issue: a second job that omits two required fields. */
const MISSING_FIELDS =
  "jobs:\n" +
  "  - slug: sweep\n" +
  "    trigger: {schedule: '0 2 * * *'}\n" +
  "    budget: {wallClockMs: 4000}\n" +
  "    run: {command: ./body.sh, args: []}\n";

describe("sageox-agent validate", () => {
  let dir: string;
  const write = (name: string, yaml: string) => {
    const path = join(dir, name);
    writeFileSync(path, yaml);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sageox-agent-validate-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a manifest and says what it holds", async () => {
    const path = write("agent.yaml", AGENT_YAML("demo"));

    const { code, stdout } = await validate([path]);

    expect(code).toBe(0);
    expect(stdout).toContain(`ok    ${path} — demo, 1 surface(s), 0 job(s)`);
    expect(stdout).toContain("1 file(s) valid.");
  });

  it("names the field paths of an invalid job and exits non-zero", async () => {
    const path = write("agent.yaml", AGENT_YAML("demo") + MISSING_FIELDS);

    const { code, stdout } = await validate([path]);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`FAIL  ${path}`);
    expect(stdout).toContain("jobs[0].archetype");
    expect(stdout).toContain("jobs[0].description");
    // Zod's default `message` is the issue list as JSON, which is what this renders instead
    // of: a reviewer reading a diff should not have to parse it.
    expect(stdout).not.toContain('"code":');
  });

  it("refuses a parked job too, since the manifest parses as a unit", async () => {
    const path = write("agent.yaml", AGENT_YAML("demo") + MISSING_FIELDS + "    suspend: true\n");

    const { code, stdout } = await validate([path]);

    expect(code).not.toBe(0);
    expect(stdout).toContain("jobs[0].archetype");
  });

  it("reports every path rather than stopping at the first failure", async () => {
    const good = write("good.yaml", AGENT_YAML("good"));
    const bad = write("bad.yaml", AGENT_YAML("bad") + MISSING_FIELDS);
    const last = write("last.yaml", AGENT_YAML("last"));

    const { code, stdout, stderr } = await validate([good, bad, last]);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`ok    ${good}`);
    expect(stdout).toContain(`FAIL  ${bad}`);
    expect(stdout).toContain(`ok    ${last}`);
    expect(stderr).toContain("1 of 3 file(s) invalid");
  });

  it("fails a file it cannot read without claiming it validated", async () => {
    const { code, stdout } = await validate([join(dir, "absent.yaml")]);

    expect(code).not.toBe(0);
    expect(stdout).toContain("FAIL  ");
    expect(stdout).not.toContain("ok    ");
  });

  it("fails a path that exists but is not a file", async () => {
    const bundle = join(dir, "bundle");
    mkdirSync(bundle);

    const { code, stdout } = await validate([bundle]);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`FAIL  ${bundle}`);
    expect(stdout).not.toContain("ok    ");
  });

  /**
   * The gap that would make this command worse than nothing: the schema takes these as
   * plain strings, and `run` converts them afterwards — so validating one rung below the
   * runtime would report green on a file the runtime refuses at startup.
   */
  it("refuses an owner the runtime could not resolve to a key", async () => {
    const path = write("agent.yaml", AGENT_YAML("demo") + "owner:\n  - npub1nothing\n");

    const { code, stdout } = await validate([path]);

    expect(code).not.toBe(0);
    expect(stdout).toContain(`FAIL  ${path}`);
  });

  it("refuses a secret key written where a public one belongs", async () => {
    const path = write(
      "agent.yaml",
      `${AGENT_YAML("demo")}owner:\n  - ${"nsec1" + "q".repeat(58)}\n`,
    );

    const { code, stdout } = await validate([path]);

    expect(code).not.toBe(0);
    expect(stdout).toContain("secret key");
  });

  it("asks for a path instead of validating nothing", async () => {
    const { code, stderr } = await validate([]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("validate needs a path");
  });

  it("passes with no agent home to read and creates none", async () => {
    const path = write("agent.yaml", AGENT_YAML("demo"));
    const home = join(dir, "absent-home");
    const before = readdirSync(dir);

    const { code } = await validate([path], { AGENT_TOOLKIT_HOME: home });

    expect(code).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(dir)).toEqual(before);
  });
});
