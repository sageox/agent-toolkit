import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCmd } from "../src/commands.ts";

describe("sageox-agent init", () => {
  const previousHome = process.env.AGENT_TOOLKIT_HOME;
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = previousHome;
  });

  it("gives a new agent a profile, character brief, and publishable avatar source", () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-init-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;

    initCmd(["--name", "harry"]);

    const dir = join(root, "harry");
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"))).toEqual({
      display_name: "harry",
      about: "harry, a member of this team's chat.",
      avatar: "avatar.svg",
    });
    expect(readFileSync(join(dir, "avatar.md"), "utf8")).toContain("# harry — character brief");
    expect(readFileSync(join(dir, "avatar.svg"), "utf8")).toMatch(/^<svg[\s\S]*harry starter avatar/);
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("persona: ./AGENTS.md");
  });

  it("does not overwrite identity files a person has edited", () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-init-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    initCmd(["--name", "harry"]);
    const profile = join(root, "harry", "profile.json");
    writeFileSync(profile, "custom profile\n");

    initCmd(["--name", "harry"]);

    expect(readFileSync(profile, "utf8")).toBe("custom profile\n");
  });

  it("uses one public identity to seed the profile, persona, brief, and image", () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-init-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;

    initCmd([
      "--name", "camp-guide",
      "--display-name", "Harry",
      "--about", "Helps the team find its way through unfamiliar systems.",
    ]);

    const dir = join(root, "camp-guide");
    const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
    expect(profile).toMatchObject({
      display_name: "Harry",
      about: "Helps the team find its way through unfamiliar systems.",
    });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(profile.about);
    expect(readFileSync(join(dir, "avatar.md"), "utf8")).toContain(profile.about);
    expect(readFileSync(join(dir, "avatar.svg"), "utf8")).toContain("Harry starter avatar");
  });
});
