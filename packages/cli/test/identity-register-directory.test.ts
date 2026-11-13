import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIRECTORY_KIND,
  generateKeypair,
  LocalRelay,
  resolveBuzzSigner,
} from "@sageox/agent-toolkit-adapter-buzz";

// Non-interactive, and no `buzz` CLI: the kind-0 profile is that CLI's job, and this test is
// about the directory record the toolkit publishes itself.
vi.mock("../src/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompt.ts")>()),
  isInteractive: () => false,
}));
vi.mock("../src/register.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/register.ts")>()),
  registerAgent: async () => {},
}));

const { identityCmd } = await import("../src/commands.ts");

const key = generateKeypair();

async function held(content: Record<string, unknown>) {
  const signer = await resolveBuzzSigner("BUZZ_NSEC", { env: { BUZZ_NSEC: key.nsec } });
  return signer.signEvent({
    kind: DIRECTORY_KIND,
    created_at: 1786000000,
    tags: [],
    content: JSON.stringify(content),
  });
}

describe("identity register buzz, for an agent already in the directory", () => {
  let root: string;
  let relay: LocalRelay;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;
  const savedCwd = process.cwd();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sageox-agent-register-directory-"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // An exported key wins over the bundle's .env and would point registration at another
    // agent's record.
    vi.stubEnv("BUZZ_NSEC", key.nsec);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(savedCwd);
    await relay?.stop();
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
  });

  // A display name with a space is unmentionable: clients tokenize the `@…` against the
  // record and strip the tag when it does not resolve. Renaming the agent in profile.json and
  // re-registering is the documented fix, so it has to reach the record — and the record
  // used to keep its first display name forever.
  it("renames the record to the profile's display name, under the manifest's handle", async () => {
    relay = await LocalRelay.start({
      requireAuth: true,
      backlog: [
        await held({
          name: "ron",
          display_name: "Ron Weasley",
          channel_ids: ["c1"],
          respond_to: "anyone",
          agent_type: "claude-agent-acp",
        }),
      ],
    });

    const agent = join(root, "ron");
    mkdirSync(agent);
    writeFileSync(join(agent, ".env"), `BUZZ_NSEC=${key.nsec}\n`);
    writeFileSync(join(agent, "profile.json"), '{"display_name":"Ron"}\n');
    writeFileSync(
      join(agent, "agent.yaml"),
      `name: ron
brain:
  provider: mock
respondTo: anyone
surfaces:
  - kind: buzz
    relayUrl: ${relay.url}
    identity: BUZZ_NSEC
    channels:
      - { id: c1, reply: private }
`,
    );
    process.env.AGENT_TOOLKIT_HOME = root;

    await identityCmd(["register", "buzz", "--agent", "ron", "--relay", relay.url, "--channel", "c1"]);

    const records = relay.published.filter((event) => event.kind === DIRECTORY_KIND);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].content)).toEqual({
      // The manifest's handle, as `run` publishes it — not the display name, or the two
      // writers flip the field on every restart after a registration.
      name: "ron",
      display_name: "Ron",
      channel_ids: ["c1"],
      respond_to: "anyone",
      agent_type: "claude-agent-acp",
    });
  }, 20_000);
});
