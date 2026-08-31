import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addBuzzSurface, addSlackSurface } from "../src/edit-config.ts";
import { AGENT_YAML } from "../src/init.ts";
import { doctorReport } from "./cli-harness.ts";

// The stub `buzz` CLI this suite writes into `<home>/bin` has to win the PATH lookup.
const doctor = (home: string) =>
  doctorReport(home, {
    BUZZ_NSEC: "nsec1doctor",
    PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
  });

describe("doctor channel reachability", () => {
  let home: string;
  let agentDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-"));
    agentDir = join(home, "demo");
    mkdirSync(agentDir);
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "buzz"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Every listed channel is answerable, so this is a summary and not a check: the channel
  // an agent may not answer in is the one the list leaves out.
  it("says where the agent may reply, and which of those are public", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBuzzSurface(AGENT_YAML("demo"), "wss://relay.example", [
        { id: "ops", reply: "private" },
        { id: "town", reply: "public" },
      ]),
    );

    const report = await doctor(home);
    expect(report).toContain("surface buzz: may reply in 2 channel(s), publicly in town");
  });

  it("says so when every channel it lists is private", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBuzzSurface(AGENT_YAML("demo"), "wss://relay.example", [{ id: "ops", reply: "private" }]),
    );

    expect(await doctor(home)).toContain("may reply in 1 channel(s), all of them private");
  });

  // A Slack DM is structurally private, so a channel-less Slack surface answers. Buzz has
  // no such path: with nothing listed it falls back to a mention filter, and every mention
  // arrives from a channel no entry names — public, and refused at egress. Reporting that
  // as working is the failure this release is about, in the one shape an entry list cannot
  // rule out.
  it("separates the two surfaces that list no channels, because only one of them answers", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addSlackSurface(addBuzzSurface(AGENT_YAML("demo"), "wss://relay.example"), []),
    );

    const report = await doctor(home);
    expect(report).toContain("surface slack: no channels listed — DMs are answerable");
    expect(report).toContain(
      "surface buzz: no channels listed — it hears mentions from anywhere and may answer in none",
    );
    expect(report).toContain("list the channels it should answer in");
  });

  it("reports when the configured identity is not a relay member", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      addBuzzSurface(AGENT_YAML("demo"), "wss://closed.example", [
        { id: "town", reply: "private" },
      ]),
    );
    writeFileSync(
      join(home, "bin", "buzz"),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"error":"auth","message":"restricted: not a relay member"}\' >&2\nexit 3\n',
      { mode: 0o755 },
    );

    const report = await doctor(home);
    expect(report).toContain("identity is not a member of relay wss://closed.example");
    // The command, not just the diagnosis: the key to admit is the one thing the operator
    // cannot look up from the failure. This fixture's nsec does not decode, so the
    // placeholder stands in — a report that dies here reports nothing at all.
    expect(report).toContain("run `buzz-admin add-member --pubkey <the agent npub>`");
  });
});
