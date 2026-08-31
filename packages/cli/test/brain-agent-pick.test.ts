import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { AGENT_YAML } from "../src/init.ts";

const prompt = vi.hoisted(() => ({
  ask: vi.fn(),
  interactive: vi.fn(),
}));

vi.mock("../src/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompt.ts")>()),
  isInteractive: prompt.interactive,
  promptLine: prompt.ask,
  promptSecret: vi.fn(),
}));

import { brainCmd, identityCmd } from "../src/commands.ts";
import { selectAgentName } from "../src/home.ts";

describe("agent selection", () => {
  let home: string;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-brain-pick-"));
    for (const name of ["hagrid", "harry"]) {
      const dir = join(home, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "agent.yaml"), AGENT_YAML(name));
      writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");
    }
    process.env.AGENT_TOOLKIT_HOME = home;
    delete process.env.ANTHROPIC_API_KEY;
    prompt.ask.mockReset();
    prompt.interactive.mockReset();
    prompt.interactive.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("asks which agent to update when more than one exists", async () => {
    prompt.ask.mockResolvedValueOnce("2");

    await brainCmd(["claude"]);

    expect(prompt.ask).toHaveBeenCalledWith("Choice [1-2]: ");
    expect(loadManifest(readFileSync(join(home, "harry", "agent.yaml"), "utf8")).brain.provider)
      .toBe("claude-acp");
    expect(loadManifest(readFileSync(join(home, "hagrid", "agent.yaml"), "utf8")).brain.provider)
      .toBe("mock");
  });

  it("still honors an explicit --agent without prompting", async () => {
    await brainCmd(["claude", "--agent", "hagrid"]);

    expect(prompt.ask).not.toHaveBeenCalled();
    expect(loadManifest(readFileSync(join(home, "hagrid", "agent.yaml"), "utf8")).brain.provider)
      .toBe("claude-acp");
  });

  it("uses the same picker in other agent-scoped commands", async () => {
    prompt.ask.mockResolvedValueOnce("harry");

    await identityCmd(["create"]);

    expect(readFileSync(join(home, "harry", ".env"), "utf8")).toContain("BUZZ_NSEC=");
    expect(readFileSync(join(home, "hagrid", ".env"), "utf8")).not.toContain("BUZZ_NSEC=");
  });

  it("fails fast without prompting when there is no terminal", async () => {
    prompt.interactive.mockReturnValue(false);

    await expect(selectAgentName()).rejects.toThrow(/which agent.*hagrid, harry/s);
    expect(prompt.ask).not.toHaveBeenCalled();
  });
});
