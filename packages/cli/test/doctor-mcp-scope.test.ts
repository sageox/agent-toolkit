import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowTools, addMcpServer } from "../src/edit-config.ts";
import { AGENT_YAML, SETTINGS_JSON } from "../src/init.ts";
import { doctorReport as doctor } from "./cli-harness.ts";

/**
 * What `doctor` says about a server's bound.
 *
 * A bound nobody wrote reads exactly like a bound nobody needed, and only one of those is
 * fine — so the report has to say which it found rather than staying quiet when there is
 * no `scope`. These rows are that distinction, executed.
 */
describe("doctor and an mcp server's bound", () => {
  let home: string;
  let agentDir: string;

  const configure = (scope: Record<string, string[]> | undefined, allow: string[]) => {
    const yaml = addMcpServer(AGENT_YAML("demo"), {
      name: "gh",
      command: "node",
      args: ["gh.js"],
      scope,
    });
    writeFileSync(join(agentDir, "agent.yaml"), yaml);
    writeFileSync(join(agentDir, "settings.json"), allowTools(SETTINGS_JSON, allow).json);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-scope-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "persona\n");
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reports the bound when a server declares one", async () => {
    configure({ repo: ["acme/service", "acme/tools"] }, ["mcp__gh__pr_list"]);
    const report = await doctor(home);

    expect(report).toContain('mcp server "gh" is bound to');
    expect(report).toContain("acme/service, acme/tools");
  });

  it("warns when a server declares none, rather than staying quiet about it", async () => {
    // The credential is almost never as narrow as the job, and nothing else in the report
    // would say so — an unbounded server that works is indistinguishable from a bounded one
    // until the day it reaches something nobody meant it to.
    configure(undefined, ["mcp__gh__pr_list"]);
    const report = await doctor(home);

    expect(report).toContain('mcp server "gh" declares no scope');
    expect(report).toContain("wider than the job");
  });

  it("fails when a server is configured and the manifest names no tool policy", async () => {
    // Refusing beats denying silently: with no policy every call would be rejected and the
    // agent would look broken rather than misconfigured.
    const yaml = addMcpServer(AGENT_YAML("demo"), {
      name: "gh",
      command: "node",
      args: ["gh.js"],
    })
      .split("\n")
      .filter((line) => !line.startsWith("tools:"))
      .join("\n");
    writeFileSync(join(agentDir, "agent.yaml"), yaml);
    const report = await doctor(home);

    expect(report).toContain("mcp servers are configured but no tool policy is set");
  });

  it("warns that respondTo: anyone puts every allowed tool behind an open door", async () => {
    // Nothing between a channel message and a filed issue asks a second time, so the pairing
    // of a reachable agent and a tool that writes is worth saying out loud once.
    configure({ repo: ["acme/service"] }, ["mcp__gh__issue_create"]);
    const report = await doctor(home);

    expect(report).toContain("respondTo: anyone");
    expect(report).toContain("including any that write");
  });
});
