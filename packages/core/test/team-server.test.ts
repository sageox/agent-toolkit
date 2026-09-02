import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  teamBrainHandler,
  formatPassages,
  makeOxTeam,
  classifyOxFailure,
  OX_FAILURE_TEXT,
  TEAM_TOOLS,
  TEAM_TOOL_NAMES,
  type OxFailure,
  type TeamBrain,
  type TeamOx,
  type TeamPassage,
  type TeamSearch,
  passageDate,
} from "../src/team-server.ts";
import { describeHealth, isActionable, isDegrading, needsHuman } from "../src/health.ts";

const passages: TeamPassage[] = [
  { score: 0.94, text: "We chose Postgres over DynamoDB for the ledger.", doc_type: "adr", file_path: "docs/adr/012.md" },
  { score: 0.71, text: "Migrations run in the deploy window.", source_type: "session", source_id: "sess_9" },
];

const search = async (q: string) => (q === "nothing" ? [] : passages);

/** A team surface with no `ox` behind it, so the handler's own behaviour is what is tested. */
function fakeOx(over: Partial<TeamOx> = {}): TeamOx {
  return {
    search,
    ...over,
  };
}

/**
 * Waits for a condition rather than for a duration. A test that sleeps its way to an
 * ordering asserts how loaded the machine was, and passes on either answer.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Puts a fake `ox` on PATH for the duration of `body`, with the audit lines it logs
 * captured. The child runs with its cwd set to the same directory, so a script can gate on
 * a marker file the body writes there — which is how one brain sees a credential die and
 * come back. Pass no script to put nothing on PATH at all.
 */
async function withFakeOx<T>(
  script: string | undefined,
  body: (brain: TeamBrain, bin: string) => Promise<T>,
): Promise<{ value: T; log: string }> {
  const bin = mkdtempSync(join(tmpdir(), "ox-fake-"));
  if (script !== undefined) writeFileSync(join(bin, "ox"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = script === undefined ? bin : `${bin}:${previousPath ?? ""}`;
  const logged: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((line) => void logged.push(String(line)));
  try {
    const value = await body(makeOxTeam({ team: "team_x", cwd: bin }), bin);
    return { value, log: logged.join("\n") };
  } finally {
    warn.mockRestore();
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

const call = (name: string, args: Record<string, unknown> = {}, ox: TeamOx = fakeOx()) =>
  teamBrainHandler(ox)({ id: 1, method: "tools/call", params: { name, arguments: args } }) as Promise<{
    content: Array<{ text: string }>;
  }>;

const text = async (name: string, args?: Record<string, unknown>, ox?: TeamOx) =>
  (await call(name, args, ox)).content[0].text;

describe("team brain", () => {
  it("offers the read verbs the fleet uses, and no way to write", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const names = listed.tools.map((t) => t.name);

    expect(names).toEqual(["team_search"]);
    expect(names.some((n) => /write|put|add|create|invite/.test(n))).toBe(false);
    expect(TEAM_TOOL_NAMES).toEqual(names);
  });

  it("tells the brain a name, a description and a schema — never how the tool runs", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<Record<string, unknown>>;
    };
    for (const tool of listed.tools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });

  it("refuses a tool it does not serve, so team memory cannot be authored", async () => {
    await expect(
      teamBrainHandler(fakeOx())({ id: 1, method: "tools/call", params: { name: "team_write", arguments: {} } }),
    ).rejects.toThrow(/unknown tool/);
  });

  it("serves no ledger-backed verb, which without a synced clone would answer empty", () => {
    // `ox glance` and `ox session list` read a ledger this toolkit never clones. See the
    // note on TEAM_TOOLS: an empty answer there is indistinguishable from a quiet team.
    expect(TEAM_TOOL_NAMES).not.toContain("team_recent");
    expect(TEAM_TOOL_NAMES).not.toContain("team_sessions");
    expect(TEAM_TOOLS.every((tool) => typeof tool.run === "function")).toBe(true);
  });

  it("returns passages with where they came from", async () => {
    const out = await text("team_search", { query: "database" });

    expect(out).toContain("docs/adr/012.md");
    expect(out).toContain("adr");
    expect(out).toContain("Postgres over DynamoDB");
    expect(out).toContain("sess_9"); // provenance even without a file path
  });

  it("treats an empty result as an answer, not a failure", () => {
    const out = formatPassages("nothing", []);
    expect(out).toMatch(/has nothing/i);
    expect(out).toMatch(/not that the search failed/i);
  });

  it("passes the caller's limit through to the search", async () => {
    let seen = 0;
    const searchWithLimit: TeamSearch = async (_q, limit) => {
      seen = limit;
      return [];
    };
    await call("team_search", { query: "x", limit: 12 }, fakeOx({ search: searchWithLimit }));
    expect(seen).toBe(12);
  });

  it("bounds the limit, because every passage is read into a turn", async () => {
    await expect(call("team_search", { query: "x", limit: 500 })).rejects.toThrow();
  });

  it("publishes that bound in the schema, so a caller learns it before being refused", async () => {
    const listed = (await teamBrainHandler(fakeOx())({ id: 1, method: "tools/list" })) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, { maximum?: number }> } }>;
    };
    const search = listed.tools.find((tool) => tool.name === "team_search")!;
    expect(search.inputSchema.properties.limit.maximum).toBe(20);
    // The advertised maximum and the enforced one are the same number, not two numbers
    // that happen to agree today.
    await expect(call("team_search", { query: "x", limit: 21 })).rejects.toThrow();
    await expect(call("team_search", { query: "x", limit: 20 })).resolves.toBeDefined();
  });

  it("reports a search failure instead of returning silence", async () => {
    await expect(
      call("team_search", { query: "x" }, fakeOx({
        search: async () => {
          throw new Error("the `ox` CLI is not on PATH");
        },
      })),
    ).rejects.toThrow(/not on PATH/);
  });
});

describe("what the brain is told when ox fails", () => {
  const PLANTED = "sk-planted-a1b2c3";

  /** Runs `search` against a fake `ox` on PATH, and returns the error and the audit lines. */
  async function failingOx(script: string) {
    const { value, log } = await withFakeOx(script, (brain) =>
      // The query is the caller's own words: the thing that must not come back out.
      brain.search(PLANTED, 5).then(() => undefined, (e: Error) => e),
    );
    return { message: value?.message ?? "", log };
  }

  it("keeps ox's stderr out of the brain and puts it in the audit log", async () => {
    const { message, log } = await failingOx(`echo "Error: rejected token ${PLANTED}" >&2; exit 1`);

    expect(message).not.toContain(PLANTED);
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT.failed}`);
    // The detail is not lost — it goes where an operator can triage it and the brain cannot.
    expect(log).toContain("ox_failed");
    expect(log).toContain("class=failed");
    expect(log).toContain(PLANTED);
  });

  it("logs the detail as one escaped field, so ox output cannot forge one of its own", async () => {
    // Both halves of the same trick: a newline to start a second record, and a quote to
    // close `detail` early and have the rest read as fields — a forged `class=` would send
    // an operator after exactly the wrong cause.
    const forge = 'boom" class=not-authenticated verb="ox';
    const { log } = await failingOx(`printf 'Error: %s\\nsecond line\\n' '${forge}' >&2; exit 1`);

    expect(log.split("\n")).toHaveLength(1);
    const detail = JSON.parse(log.slice(log.indexOf("detail=") + "detail=".length)) as string;
    expect(detail).toContain(forge); // intact for the operator, and inside one JSON string
    expect(log.slice(0, log.indexOf("detail="))).toContain("class=failed"); // the only class
  });

  it("says an auth failure is a credential to fix, not a lookup to retry", async () => {
    const { message, log } = await failingOx(
      `echo "Error: team context query failed: not authenticated. Run 'ox login' first" >&2; exit 1`,
    );
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT["not-authenticated"]}`);
    expect(message).toMatch(/a human has to mount or rotate/);
    expect(log).toContain("class=not-authenticated");
  });

  it("keeps unparseable stdout out too — it is the same untrusted text", async () => {
    const { message, log } = await failingOx(`echo "not json at all: ${PLANTED}"; exit 0`);

    expect(message).not.toContain(PLANTED);
    expect(message).toBe(`ox query: ${OX_FAILURE_TEXT.unreadable}`);
    expect(log).toContain("class=unreadable");
  });

  it("classifies the safe way round: an unrecognised refusal is not an auth failure", () => {
    expect(classifyOxFailure({ code: "ENOENT" })).toBe("not-installed");
    expect(classifyOxFailure({ stderr: "Error: not authenticated. Run 'ox login'" })).toBe(
      "not-authenticated",
    );
    // Reworded by a later ox, or simply something else: degrade to "it failed", never to a
    // class that sends a human after the wrong cause.
    expect(classifyOxFailure({ stderr: "Error: the team context service is unavailable" })).toBe(
      "failed",
    );
    expect(classifyOxFailure({})).toBe("failed");
  });

  it("gives each class its own words, so they are worth telling apart", () => {
    // Four classes that render as fewer than four sentences would be one class wearing
    // four names, and the brain would act the same way on all of them.
    const classes: OxFailure[] = ["not-installed", "not-authenticated", "unreadable", "failed"];
    expect(new Set(classes.map((name) => OX_FAILURE_TEXT[name])).size).toBe(classes.length);
  });
});

describe("the team brain's own capability health", () => {
  // Answers with no passages; fails with whatever the body has written into `fail` beside
  // it, and answers unreadably if `garbage` is there. ox runs with its cwd set to that
  // directory, so the markers are `./fail` and `./garbage`.
  const SCRIPTED =
    `if [ -f ./garbage ]; then echo "not json at all"; exit 0; fi\n` +
    `if [ -f ./fail ]; then cat ./fail >&2; exit 1; fi\n` +
    `echo '{"team_context":{"results":[]}}'`;
  const REVOKED = "Error: team context query failed: not authenticated. Run 'ox login' first";
  // A lookup whose query says `slow` announces itself in `blocked` and then waits for the
  // test to create `release`; every other one is refused straight away. A barrier rather
  // than a delay, so the interleaving is the test's to decide and not the machine's.
  const HELD_THEN_REVOKED =
    `case "$*" in\n` +
    `  *slow*)\n` +
    `    : > ./blocked\n` +
    `    while [ ! -f ./release ]; do sleep 0.02; done\n` +
    `    echo '{"team_context":{"results":[]}}'\n` +
    `    exit 0;;\n` +
    `  *flaky*) echo "Error: the team context service is unavailable" >&2; exit 1;;\n` +
    `esac\n` +
    `echo "${REVOKED}" >&2\nexit 1`;

  it("lets a success outlive a newer transient failure and clear the latch", async () => {
    // The other half of the ordering rule, and it is deliberate: a `failed` lookup records
    // nothing, so it does not make a newer-started success stale. Suppressing that success
    // would hold `Unavailable` on evidence nobody has — and delay exactly the recovery a
    // rotated credential is supposed to get without a restart.
    const { value } = await withFakeOx(HELD_THEN_REVOKED, async (brain, bin) => {
      await brain.search("revoked", 5).catch(() => {});
      const latched = brain.readings()[0].health;
      const held = brain.search("slow", 1).catch(() => {});
      await until(() => existsSync(join(bin, "blocked")), "the held lookup to start");
      // Asserted rather than swallowed: a `flaky` lookup that answered would leave the
      // held success to produce `Ok` on its own, and the test would pass having exercised
      // nothing.
      await expect(brain.search("flaky", 5)).rejects.toMatchObject({ failure: "failed" });
      writeFileSync(join(bin, "release"), "");
      await held;
      return [latched, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Ok"]);
  });

  it("reports nothing until a lookup has been made", async () => {
    // Not `Ok`: nothing has tried the credential yet, and a reading is a claim about it.
    const { value } = await withFakeOx(SCRIPTED, async (brain) => brain.readings());
    expect(value).toEqual([]);
  });

  it("latches a revoked credential, so the turn and the operator both learn of it", async () => {
    const { value, log } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      writeFileSync(join(bin, "fail"), REVOKED);
      await brain.search("how do we deploy", 5).catch(() => {});
      return brain.readings();
    });

    expect(value).toHaveLength(1);
    const [reading] = value;
    expect(reading.capability).toBe("brain.team");
    expect(reading.health).toBe("Unavailable");
    // The same word on both lines, so one grep finds the classification and the reading.
    expect(log).toContain("class=not-authenticated");
    expect(describeHealth(reading)).toContain("failure=not-authenticated");
    // Disclosed to the agent, and announced to a human — the two are separate decisions.
    expect(isDegrading(reading.health)).toBe(true);
    expect(needsHuman(reading.health)).toBe(true);
    // What the agent is told is the fixed sentence, and the remedy is only for the operator.
    expect(reading.reason).toBe(OX_FAILURE_TEXT["not-authenticated"]);
    expect(isActionable(reading) && reading.remedy).toMatch(/rotate/);
  });

  it("clears itself on the next answer, so a rotated credential needs no restart", async () => {
    const { value } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      const path = join(bin, "fail");
      writeFileSync(path, REVOKED);
      await brain.search("x", 5).catch(() => {});
      const dead = brain.readings()[0].health;
      rmSync(path);
      await brain.search("x", 5);
      return [dead, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Ok"]);
  });

  it("reads an answer with no passages as Ok, never as an empty corpus", async () => {
    // One query that matched nothing says nothing about how much the team has written
    // down, and `ox query` reports no corpus size. `Empty` here would be a guess.
    const { value } = await withFakeOx(SCRIPTED, async (brain) => {
      expect(await brain.search("nothing matches this", 5)).toEqual([]);
      return brain.readings()[0].health;
    });
    expect(value).toBe("Ok");
  });

  it("leaves the reading standing when a lookup falls over or answers unreadably", async () => {
    // The two classes retrying can disprove. Latching either would announce an outage to a
    // human on every flaky lookup, which is how people learn to skim announcements.
    const { value } = await withFakeOx(SCRIPTED, async (brain, bin) => {
      await brain.search("x", 5);
      writeFileSync(join(bin, "fail"), "Error: the team context service is unavailable");
      await brain.search("x", 5).catch(() => {});
      const afterFailed = brain.readings()[0].health;
      rmSync(join(bin, "fail"));
      writeFileSync(join(bin, "garbage"), "");
      await brain.search("x", 5).catch(() => {});
      return [afterFailed, brain.readings()[0].health];
    });
    expect(value).toEqual(["Ok", "Ok"]);
  });

  it("does not let a slower older lookup bury what a newer one proved", async () => {
    // Completion order is not start order once the launch probe overlaps a turn, and a
    // stale `Ok` landing on top of an auth failure is the silence this reading exists to
    // break, restored by a race.
    const { value } = await withFakeOx(HELD_THEN_REVOKED, async (brain, bin) => {
      // The older lookup is held inside the fake `ox` until this test lets it go, so the
      // newer one demonstrably records first and the guard is what the assertion rests on.
      const older = brain.search("slow", 1).catch(() => {});
      await until(() => existsSync(join(bin, "blocked")), "the older lookup to start");
      await brain.search("newer", 5).catch(() => {});
      const whileTheOlderOneIsHeld = brain.readings()[0].health;
      writeFileSync(join(bin, "release"), "");
      await older;
      return [whileTheOlderOneIsHeld, brain.readings()[0].health];
    });
    expect(value).toEqual(["Unavailable", "Unavailable"]);
  });

  it("takes the first reading at launch, without throwing", async () => {
    const { value } = await withFakeOx(SCRIPTED, async (brain) => {
      await brain.probe();
      return brain.readings()[0].health;
    });
    expect(value).toBe("Ok");
  });

  it("latches a missing `ox` at launch too — an image built without it stays broken", async () => {
    const { value } = await withFakeOx(undefined, async (brain) => {
      await brain.probe();
      return brain.readings()[0];
    });
    expect(value.health).toBe("Unavailable");
    expect(describeHealth(value)).toContain("failure=not-installed");
    expect(value.reason).toBe(OX_FAILURE_TEXT["not-installed"]);
  });
});

describe("passage dates", () => {
  it("surfaces the date a discussion came from, so recency is readable", () => {
    expect(passageDate("discussions/2026-08-14-21-34-ajit/transcript.vtt")).toBe("2026-08-14");
  });

  it("returns nothing for a path that carries no date", () => {
    expect(passageDate("documents/architecture.md")).toBeUndefined();
    expect(passageDate(undefined)).toBeUndefined();
  });

  it("shows the date in rendered output", () => {
    const out = formatPassages("x", [
      { score: 0.6, text: "we shipped it", file_path: "discussions/2026-08-14-21-34-a/t.vtt" },
    ]);
    expect(out).toContain("2026-08-14");
  });

  it("says an empty result is about wording, not about the corpus being stale", () => {
    const out = formatPassages("anything", []);
    expect(out).toMatch(/different wording/i);
    expect(out).toMatch(/not that the team has recorded nothing recently/i);
  });
});
