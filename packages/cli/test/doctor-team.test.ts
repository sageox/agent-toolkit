import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oxClientId } from "@sageox/agent-toolkit-core";
import { addBrain } from "../src/edit-config.ts";
import { AGENT_YAML } from "../src/init.ts";
import { doctorReport } from "./cli-harness.ts";

describe("doctor's team brain check", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-"));
    mkdirSync(join(home, "demo"));
    mkdirSync(join(home, "bin"));
    // Records the environment it was given, then answers as a signed-in ox.
    writeFileSync(
      join(home, "bin", "ox"),
      `#!/bin/sh\nenv > "${join(home, "ox-env")}"\nprintf '{"auth":{"authenticated":true}}\\n'\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("runs ox under the agent's telemetry ID", async () => {
    writeFileSync(
      join(home, "demo", "agent.yaml"),
      addBrain(AGENT_YAML("demo"), { preset: "team", team: "team_x" }),
    );

    await doctorReport(home, {
      SAGEOX_TOKEN: "oxt_doctor",
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
    });

    expect(readFileSync(join(home, "ox-env"), "utf8")).toContain(
      `SAGEOX_CLIENT_ID=${oxClientId("team_x", "demo")}\n`,
    );
  });
});
