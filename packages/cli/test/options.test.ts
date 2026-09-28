import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { flag, refuseUnknownOptions } from "../src/args.ts";
import { AGENT_YAML } from "../src/init.ts";
import { runCli } from "./cli-harness.ts";

describe("an option no command reads", () => {
  let home: string;
  let config: string;
  const cli = (argv: string[]) => runCli(argv, { AGENT_TOOLKIT_HOME: home });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-options-"));
    config = join(home, "demo", "agent.yaml");
    mkdirSync(join(home, "demo"));
    writeFileSync(config, AGENT_YAML("demo"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Without the check each line adds the memory: `memory add` reads none of these options.
  it.each([
    [["memory", "add", "local", "--dry-run"]],
    [["memory", "add", "local", "--command", "server", "--args", "--dry-run"]],
  ])("is refused before the command runs: %j", async (argv) => {
    await expect(cli(argv)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown option: --dry-run"),
    });
    expect(readFileSync(config, "utf8")).toBe(AGENT_YAML("demo"));
  });

  it("is handed to the program by mcp add --args", async () => {
    await cli(["mcp", "add", "--name", "probe", "--command", "/nonexistent/program", "--args", "--stdio"]);

    const server = loadManifest(readFileSync(config, "utf8")).mcpServers.find((s) => s.name === "probe");
    expect(server?.args).toEqual(["--stdio"]);
  });

  it.each([
    [["local", "-n"], "unknown option: -n"],
    [["local", "--args", "--dry-run"], "unknown option: --dry-run"],
    [["local", "--relay", "-n"], "unknown option: -n"],
    [["--relay=wss://relay.example"], "write --relay wss://relay.example, not --relay=wss://relay.example"],
  ])("is refused in %j", (argv, message) => {
    expect(() => refuseUnknownOptions(argv)).toThrow(message);
  });

  it.each(["--stdio", "-y,pkg"])("is the value %s of --args when it is handed on", (value) => {
    const argv = ["--command", "server", "--args", value];
    expect(() => refuseUnknownOptions(argv, true)).not.toThrow();
    expect(flag(argv, "args")).toBe(value);
  });
});
