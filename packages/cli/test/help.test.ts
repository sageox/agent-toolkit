import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_YAML } from "../src/init.ts";
import { runCli } from "./cli-harness.ts";

const HEADLINE = "sageox-agent — run one AI agent across chat surfaces";

describe("sageox-agent help", () => {
  let home: string;
  const cli = (args: string[]) => runCli(args, { AGENT_TOOLKIT_HOME: home });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-help-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each(["help", "--help", "-h"])("%s prints the usage to stdout and exits zero", async (arg) => {
    const { stdout, stderr } = await cli([arg]);

    expect(stdout).toContain(HEADLINE);
    expect(stderr).toBe("");
  });

  // Without the check this line adds the memory: the only agent in a home is selected
  // without asking, and `memory add` never reads `--help`.
  it("runs nothing when --help follows a command", async () => {
    const config = join(home, "demo", "agent.yaml");
    mkdirSync(join(home, "demo"));
    writeFileSync(config, AGENT_YAML("demo"));

    const { stdout } = await cli(["memory", "add", "local", "--help"]);

    expect(stdout).toContain(HEADLINE);
    expect(readFileSync(config, "utf8")).toBe(AGENT_YAML("demo"));
  });

  it("still fails on an unknown command", async () => {
    await expect(cli(["frobnicate"])).rejects.toMatchObject({ code: 1, stdout: "" });
  });
});
