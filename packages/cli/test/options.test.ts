import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flag, refuseUnknownOptions } from "../src/args.ts";
import { AGENT_YAML } from "../src/init.ts";
import { runCli } from "./cli-harness.ts";

describe("an option no command reads", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-options-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Without the check this line adds the memory: `memory add` never reads `--dry-run`.
  it("is refused before the command runs", async () => {
    const config = join(home, "demo", "agent.yaml");
    mkdirSync(join(home, "demo"));
    writeFileSync(config, AGENT_YAML("demo"));

    await expect(
      runCli(["memory", "add", "local", "--dry-run"], { AGENT_TOOLKIT_HOME: home }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("unknown option: --dry-run") });
    expect(readFileSync(config, "utf8")).toBe(AGENT_YAML("demo"));
  });

  it.each([
    [["local", "-n"], "unknown option: -n"],
    [["local", "--args", "--dry-run"], "unknown option: --dry-run"],
    [["local", "--relay", "-n"], "unknown option: -n"],
    [["--relay=wss://relay.example"], "write --relay wss://relay.example, not --relay=wss://relay.example"],
  ])("is refused in %j", (argv, message) => {
    expect(() => refuseUnknownOptions(argv)).toThrow(message);
  });

  it.each(["--stdio", "-y,pkg"])("is handed on as %s by --args beside --command", (value) => {
    const argv = ["--command", "server", "--args", value];
    expect(() => refuseUnknownOptions(argv)).not.toThrow();
    expect(flag(argv, "args")).toBe(value);
  });
});
