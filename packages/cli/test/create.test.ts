import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Generated candidates go through resize + palette quantization (see avatar.ts), so a
 * written avatar.png is never byte-identical to the mocked API response. These tests are
 * about the `create` flow's mechanics — which file gets written, when, and from which
 * candidate — not about image content, so asserting "a real optimized avatar landed here"
 * is the right level of detail; pixel-level behavior is avatar.test.ts's job.
 */
async function expectOptimizedAvatar(path: string): Promise<void> {
  const meta = await sharp(readFileSync(path)).metadata();
  expect(meta.width).toBe(512);
  expect(meta.height).toBe(512);
}

const prompt = vi.hoisted(() => vi.fn());
const interactive = vi.hoisted(() => vi.fn(() => true));
const multiSelect = vi.hoisted(() => vi.fn(async () => [] as string[]));
const select = vi.hoisted(() => vi.fn(
  async (question: string): Promise<string | number> =>
    question === "Which Buzz identity should this agent use?" ? "create" : "mock",
));
const confirm = vi.hoisted(() => vi.fn(async () => false));
const secret = vi.hoisted(() => vi.fn(async () => ""));
// Spread the real module: only the prompts are faked, so a non-prompt export such as
// `SetupCancelled` — which `commands.ts` matches with `instanceof` — stays the real one.
vi.mock("../src/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompt.ts")>()),
  isInteractive: interactive,
  promptConfirm: confirm,
  promptLine: prompt,
  promptMultiSelect: multiSelect,
  promptSecret: secret,
  promptSelect: select,
}));

import { createCmd } from "../src/commands.ts";

const AVATAR_QUESTION =
  "Generate three gpt-image-2 candidates and choose one now? (uses three images)";

function answerIdentity(
  name: string,
  about = "",
  visual = "",
  advanced: string[] = [],
): void {
  for (const answer of [name, about, visual, ...advanced, ...Array(8 - advanced.length).fill("")]) {
    prompt.mockResolvedValueOnce(answer);
  }
}

describe("guided sageox-agent create", () => {
  const previousHome = process.env.AGENT_TOOLKIT_HOME;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousNsec = process.env.BUZZ_NSEC;
  const roots: string[] = [];

  afterEach(() => {
    prompt.mockReset();
    multiSelect.mockReset();
    multiSelect.mockResolvedValue([]);
    select.mockReset();
    select.mockImplementation(async (question: string) =>
      question === "Which Buzz identity should this agent use?" ? "create" : "mock");
    confirm.mockReset();
    confirm.mockResolvedValue(false);
    secret.mockReset();
    secret.mockResolvedValue("");
    interactive.mockReturnValue(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = previousHome;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousNsec === undefined) delete process.env.BUZZ_NSEC;
    else process.env.BUZZ_NSEC = previousNsec;
  });

  it("asks for identity once and derives all identity files from it", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity(
      "Harry",
      "Helps the team navigate unfamiliar systems.",
      "An oversized compass over one shoulder.",
      [
        "Repository state and teammate questions.",
        "A cited recommendation with one next action.",
        "Never merge or publish without approval.",
        "Calm, compact, and lightly wry.",
        "A backcountry systems cartographer.",
        "Weathered green workwear with a brass accent.",
        "Alert eyes and a patient half-smile.",
        "A compass too large for the trail map.",
      ],
    );

    await createCmd([]);

    expect(prompt).toHaveBeenCalledTimes(11);
    expect(select).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(multiSelect).toHaveBeenCalledOnce();
    const dir = join(root, "harry");
    const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
    expect(profile).toEqual({
      display_name: "Harry",
      about: "Helps the team navigate unfamiliar systems.",
      avatar: "avatar.svg",
    });
    const persona = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const brief = readFileSync(join(dir, "avatar.md"), "utf8");
    expect(persona).toContain(profile.about);
    expect(persona).toContain("Never merge or publish without approval.");
    expect(persona).toContain("Calm, compact, and lightly wry.");
    expect(brief).toContain(profile.about);
    expect(brief).toContain("A backcountry systems cartographer.");
    expect(brief).toContain("A compass too large for the trail map.");
  });

  it("only asks for an internal name when the derived one already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    await createCmd([
      "--display-name", "Harry",
      "--about", "The camp guide.",
      "--visual", "An oversized compass.",
      "--starter-avatar",
    ]);
    prompt.mockResolvedValueOnce("harry-guide");

    await createCmd([
      "--display-name", "Harry",
      "--about", "The camp guide.",
      "--visual", "An oversized compass.",
      "--starter-avatar",
    ]);

    expect(prompt).toHaveBeenCalledOnce();
    expect(readFileSync(join(root, "harry-guide", "profile.json"), "utf8"))
      .toContain('"display_name": "Harry"');
  });

  it("needs no prompts when automation supplies the identity flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;

    await createCmd([
      "--display-name", "Harry",
      "--about", "The camp guide.",
      "--visual", "An oversized compass over one shoulder.",
      "--starter-avatar",
    ]);

    expect(prompt).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "harry", "profile.json"), "utf8"))
      .toContain('"display_name": "Harry"');
  });

  it("can use defaults without prompts even when a script is attached to a terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;

    await createCmd(["--name", "robot", "--non-interactive"]);

    expect(prompt).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "robot", "agent.yaml"), "utf8")).toContain("name: robot");
  });

  it("configures the brain selected from the TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity("Guide");

    await createCmd([]);

    expect(readFileSync(join(root, "guide", "agent.yaml"), "utf8"))
      .toContain("provider: mock");
    expect(select).toHaveBeenCalledWith(
      "How should this agent think?",
      expect.arrayContaining([expect.objectContaining({ value: "mock" })]),
      "mock",
    );
  });

  it("reports a missing Claude credential and asks for the brain choice again", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity("Guide");
    select
      .mockResolvedValueOnce("claude")
      .mockResolvedValueOnce("mock");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([]);

    expect(select).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.flat().join(""))
      .toContain("no value given — ANTHROPIC_API_KEY is still unset");
    expect(readFileSync(join(root, "guide", "agent.yaml"), "utf8"))
      .toContain("provider: mock");
    expect(multiSelect).toHaveBeenCalledOnce();
  });

  // The identity step can fail for a reason retrying will never clear — an exported
  // BUZZ_NSEC blocks `create` every time. Declining ends the question, but the agent still
  // has no Buzz, and `create` has to say so instead of reporting a finished agent.
  it("says Buzz was skipped when the identity step is declined", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.BUZZ_NSEC = generateKeypair().nsec;
    multiSelect.mockResolvedValueOnce(["buzz"]);
    select.mockResolvedValueOnce("mock").mockResolvedValueOnce("create");
    answerIdentity("Shadowed Guide");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([]);

    const printed = write.mock.calls.flat().join("");
    expect(printed).toContain("would shadow a newly created identity");
    expect(printed).toContain("skipped  buzz");
    const dir = join(root, "shadowed-guide");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).not.toContain("kind: buzz");
  });

  it("reports a bad Buzz surface answer and continues when retry is declined", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity("Guide");
    prompt.mockResolvedValueOnce("not-a-relay");
    multiSelect.mockResolvedValueOnce(["buzz"]);
    confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([]);

    expect(write.mock.calls.flat().join(""))
      .toContain('"not-a-relay" is not a relay URL');
    expect(confirm).toHaveBeenNthCalledWith(2, "Try adding the Buzz surface again?");
    expect(readFileSync(join(root, "guide", "agent.yaml"), "utf8"))
      .not.toContain("kind: buzz");
  });

  it("reports a Buzz identity filesystem error and continues when retry is declined", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity("Guide");
    multiSelect.mockImplementationOnce(async () => {
      mkdirSync(join(root, "guide", ".env"));
      return ["buzz"];
    });
    confirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([]);

    expect(write.mock.calls.flat().join("")).toMatch(/EISDIR|illegal operation on a directory/);
    expect(confirm).toHaveBeenNthCalledWith(2, "Try creating the Buzz identity again?");
    expect(readFileSync(join(root, "guide", "agent.yaml"), "utf8"))
      .not.toContain("kind: buzz");
  });

  it("continues into Buzz-specific questions only when Buzz is selected", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    multiSelect.mockResolvedValueOnce(["buzz"]);
    answerIdentity("Relay Guide");
    prompt.mockResolvedValueOnce("wss://relay.example").mockResolvedValueOnce("");

    await createCmd([]);

    const dir = join(root, "relay-guide");
    expect(readFileSync(join(dir, "agent.yaml"), "utf8"))
      .toContain("relayUrl: wss://relay.example");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("BUZZ_NSEC=");
    expect(prompt).toHaveBeenCalledWith("Relay URL (wss://…): ");
  });

  it("can attach an existing Buzz identity during guided creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    const identity = generateKeypair();
    // An exported BUZZ_NSEC is attached without asking, which is the one case this does
    // not exercise: what is under test is the hidden prompt.
    delete process.env.BUZZ_NSEC;
    multiSelect.mockResolvedValueOnce(["buzz"]);
    select
      .mockResolvedValueOnce("mock")
      .mockResolvedValueOnce("attach");
    secret.mockResolvedValueOnce(identity.nsec);
    answerIdentity("Returning Guide");
    prompt.mockResolvedValueOnce("wss://relay.example").mockResolvedValueOnce("");

    await createCmd([]);

    const dir = join(root, "returning-guide");
    expect(readFileSync(join(dir, ".env"), "utf8"))
      .toBe(`BUZZ_NSEC=${identity.nsec}\n`);
    expect(secret).toHaveBeenCalledWith(
      "Paste the existing Buzz private key (nsec or 64-character hex; input hidden): ",
    );
  });

  it("hands the guided agent to the remaining setup stages before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    answerIdentity("Complete Guide");
    const finishSetup = vi.fn(async () => "sageox-agent run --bundle /bundles/complete-guide");

    await createCmd([], finishSetup);

    expect(finishSetup).toHaveBeenCalledOnce();
    expect(finishSetup).toHaveBeenCalledWith("complete-guide");
  });

  it("does not claim preflight succeeded when the remaining setup reports a problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    prompt
      .mockResolvedValueOnce("Incomplete Guide")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([], async () => ({ checkCommand: "sageox-agent doctor --agent incomplete-guide" }));

    const output = write.mock.calls.flat().join("");
    expect(output).toContain("Setup saved; preflight incomplete: incomplete-guide");
    expect(output).toContain("fix it     sageox-agent doctor --agent incomplete-guide");
    expect(output).not.toContain("Setup and preflight complete");
  });

  it("clears the checkpoint when preflight is deferred, leaving nothing to resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    prompt
      .mockResolvedValueOnce("Deferred Guide")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await createCmd([], async () => ({ checkCommand: "sageox-agent doctor --agent deferred-guide" }));

    // Every question was answered and written; only the check was put off, and the closing
    // message names the command for it.
    expect(existsSync(join(root, "deferred-guide", ".create-progress.json"))).toBe(false);
  });

  it("automatically resumes an interrupted setup without replaying completed sections", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    prompt
      .mockResolvedValueOnce("Resumable Guide")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const finishSetup = vi.fn()
      .mockRejectedValueOnce(new Error("process interrupted"))
      .mockResolvedValueOnce("sageox-agent run --agent resumable-guide");

    await expect(createCmd([], finishSetup)).rejects.toThrow("process interrupted");

    const checkpoint = join(root, "resumable-guide", ".create-progress.json");
    expect(JSON.parse(readFileSync(checkpoint, "utf8"))).toMatchObject({
      stage: "memory",
      avatar: "starter",
      brain: "mock",
      surfaces: [],
    });

    prompt.mockReset();
    confirm.mockReset();
    select.mockReset();
    multiSelect.mockReset();
    await createCmd([], finishSetup);

    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(multiSelect).not.toHaveBeenCalled();
    expect(finishSetup).toHaveBeenCalledTimes(2);
    expect(existsSync(checkpoint)).toBe(false);
  });

  it("resumes past an agent whose checkpoint cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    const finishSetup = vi.fn()
      .mockRejectedValueOnce(new Error("process interrupted"))
      .mockResolvedValueOnce("sageox-agent run --agent resumable");
    await expect(
      createCmd(["--name", "resumable", "--display-name", "Resumable"], finishSetup),
    ).rejects.toThrow("process interrupted");
    // A second agent whose checkpoint is unreadable must not speak for the first one.
    mkdirSync(join(root, "damaged"), { recursive: true });
    writeFileSync(join(root, "damaged", "agent.yaml"), "name: damaged\n");
    writeFileSync(join(root, "damaged", ".create-progress.json"), "{ not json");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([], finishSetup);

    const output = write.mock.calls.flat().join("");
    expect(output).toContain("skipped  damaged");
    expect(output).toContain("resuming  resumable");
    expect(existsSync(join(root, "resumable", ".create-progress.json"))).toBe(false);
  });

  it("drops the checkpoint when a scripted create takes the same agent over", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    const finishSetup = vi.fn().mockRejectedValueOnce(new Error("process interrupted"));
    await expect(
      createCmd(["--name", "harry", "--display-name", "Harry"], finishSetup),
    ).rejects.toThrow("process interrupted");
    const checkpoint = join(root, "harry", ".create-progress.json");
    expect(existsSync(checkpoint)).toBe(true);

    await createCmd(["--name", "harry", "--starter-avatar"]);

    // Left behind, the next bare `create` would resume harry instead of making a new agent.
    expect(existsSync(checkpoint)).toBe(false);
  });

  it("generates and selects avatar.png when explicitly requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200 })));

    await createCmd([
      "--name", "harry",
      "--display-name", "Harry",
      "--about", "The camp guide.",
      "--visual", "An oversized compass over one shoulder.",
      "--generate-avatar",
    ]);

    const dir = join(root, "harry");
    await expectOptimizedAvatar(join(dir, "avatar.png"));
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).avatar)
      .toBe("avatar.png");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("reports a guided avatar error and asks again without stopping setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    answerIdentity("Harry", "The camp guide.", "An oversized compass.");
    confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Your request was rejected by the safety system. Request ID: req_test." },
    }), { status: 400 })));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createCmd([]);

    expect(confirm).toHaveBeenNthCalledWith(1, AVATAR_QUESTION);
    expect(confirm).toHaveBeenNthCalledWith(2, AVATAR_QUESTION);
    expect(write.mock.calls.flat().join(""))
      .toContain("OpenAI avatar generation failed (400): Your request was rejected " +
        "by the safety system. Request ID: req_test.");
    expect(select).toHaveBeenCalledOnce();
    expect(multiSelect).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(root, "harry", "profile.json"), "utf8")).avatar)
      .toBe("avatar.svg");
  });

  it("regenerates from the brief the retry asked for rather than re-sending the refused one", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    answerIdentity("Harry", "The camp guide.", "An oversized flare gun.", [
      "Repository state and teammate questions.",
      "A cited recommendation with one next action.",
      "Never merge or publish without approval.",
      "Calm, compact, and lightly wry.",
      "A backcountry systems cartographer.",
      "Weathered green workwear with a brass accent.",
      "Alert eyes and a patient half-smile.",
      "A compass too large for the trail map.",
    ]);
    prompt.mockResolvedValueOnce("An oversized compass.");
    confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    select.mockResolvedValueOnce(1).mockResolvedValueOnce("mock");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Your request was rejected by the safety system." },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: Array.from({ length: 3 }, () => ({
          b64_json: ONE_PIXEL_PNG.toString("base64"),
        })),
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await createCmd([]);

    const dir = join(root, "harry");
    const brief = readFileSync(join(dir, "avatar.md"), "utf8");
    expect(brief).toContain("An oversized compass.");
    // Rewriting the brief replaces only the prop the retry asked about. The rest of the
    // character the interview collected has to survive, or a safety refusal quietly
    // resets the agent to the default look.
    expect(brief).toContain("A backcountry systems cartographer.");
    expect(brief).toContain("A compass too large for the trail map.");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).prompt)
      .toContain("An oversized compass.");
    await expectOptimizedAvatar(join(dir, "avatar.png"));
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).avatar)
      .toBe("avatar.png");
  });

  it("offers three generated candidates during guided creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    answerIdentity("Trail Guide");
    confirm.mockResolvedValueOnce(true);
    select.mockResolvedValueOnce(2).mockResolvedValueOnce("mock");
    const image = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: Array.from({ length: 3 }, () => ({
          b64_json: ONE_PIXEL_PNG.toString("base64"),
        })),
      }), { status: 200 }));
    vi.stubGlobal("fetch", image);

    await createCmd([]);

    const request = JSON.parse(String(image.mock.calls[0]?.[1]?.body));
    expect(request.n).toBe(3);
    expect(select).toHaveBeenNthCalledWith(
      1,
      "Which avatar should this agent use?",
      expect.arrayContaining([
        expect.objectContaining({ value: 1, label: "Candidate 1" }),
        expect.objectContaining({ value: 2, label: "Candidate 2" }),
        expect.objectContaining({ value: 3, label: "Candidate 3" }),
        expect.objectContaining({ value: 0, label: "None" }),
      ]),
      1,
    );
    expect(JSON.parse(readFileSync(join(root, "trail-guide", "profile.json"), "utf8")).avatar)
      .toBe("avatar.png");
  });

  it("validates the identity bundle before spending an image request", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    await createCmd([
      "--name", "harry",
      "--display-name", "Harry",
      "--starter-avatar",
    ]);
    writeFileSync(join(root, "harry", "avatar.md"), "# Harry\n\nAn incomplete brief.\n");
    const image = vi.fn();
    vi.stubGlobal("fetch", image);

    await expect(createCmd([
      "--name", "harry",
      "--display-name", "Harry",
      "--generate-avatar",
      "--replace-avatar",
    ])).rejects.toThrow(/Role and visual metaphor/);

    expect(image).not.toHaveBeenCalled();
  });

  it("accepts an agent scaffolded before the manifest gained a persona key", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    await createCmd(["--name", "harry", "--display-name", "Harry", "--starter-avatar"]);
    const dir = join(root, "harry");
    // Exactly what an earlier version of this toolkit wrote: no `persona:` in the manifest
    // and no `## Recognition tests` in the brief.
    const config = join(dir, "agent.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("persona: ./AGENTS.md\n\n", ""));
    const brief = join(dir, "avatar.md");
    const legacy = readFileSync(brief, "utf8");
    writeFileSync(
      brief,
      legacy.slice(0, legacy.indexOf("## Recognition tests")) +
        legacy.slice(legacy.indexOf("## Current artwork")),
    );
    const image = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", image);

    await createCmd([
      "--name", "harry",
      "--display-name", "Harry",
      "--generate-avatar",
      "--replace-avatar",
    ]);

    expect(image).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).avatar).toBe("avatar.png");
  });

  it("does not pay to regenerate an avatar that finished just before interruption", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    const image = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", image);
    await createCmd(["--name", "harry", "--display-name", "Harry", "--generate-avatar"]);
    const dir = join(root, "harry");
    writeFileSync(join(dir, ".create-progress.json"), JSON.stringify({
      version: 1,
      stage: "avatar",
      avatar: "generate",
    }));
    image.mockClear();

    await createCmd(["--name", "harry"]);

    expect(image).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).avatar).toBe("avatar.png");
    expect(existsSync(join(dir, ".create-progress.json"))).toBe(false);
  });

  it("refuses a derived name that already exists rather than generating over that agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    await createCmd(["--display-name", "Harry", "--starter-avatar"]);
    const dir = join(root, "harry");
    const before = readFileSync(join(dir, "profile.json"), "utf8");
    const generate = vi.fn();
    vi.stubGlobal("fetch", generate);
    interactive.mockReturnValue(false); // a service manager or CI: nobody to ask

    await expect(
      createCmd(["--display-name", "Harry", "--generate-avatar"]),
    ).rejects.toThrow(/already uses the internal name "harry"/);

    expect(generate).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "profile.json"), "utf8")).toBe(before);
  });

  it("keeps artwork an agent already has unless asked to replace it", async () => {
    const root = mkdtempSync(join(tmpdir(), "sageox-agent-create-"));
    roots.push(root);
    process.env.AGENT_TOOLKIT_HOME = root;
    process.env.OPENAI_API_KEY = "sk-test";
    const image = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", image);
    const args = ["--name", "harry", "--display-name", "Harry", "--generate-avatar"];
    await createCmd(args);
    const dir = join(root, "harry");
    writeFileSync(join(dir, "avatar.png"), Buffer.from("chosen artwork"));

    await expect(createCmd(args)).rejects.toThrow(/--replace-avatar/);
    expect(image).toHaveBeenCalledOnce();
    expect(readFileSync(join(dir, "avatar.png"))).toEqual(Buffer.from("chosen artwork"));

    await createCmd([...args, "--replace-avatar"]);

    expect(image).toHaveBeenCalledTimes(2);
    await expectOptimizedAvatar(join(dir, "avatar.png"));
  });
});
