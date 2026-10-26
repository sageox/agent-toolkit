import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { SlackAdapter } from "@sageox/agent-toolkit-adapter-slack";
import { generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";
import { buildAdapters, carriesTopLevelPosts } from "../src/surfaces.ts";

const slackConfig = (channels: string) => `
name: slack-test
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: slack
    identity: TEST_SLACK_BOT_TOKEN
    appToken: TEST_SLACK_APP_TOKEN
    channels: [${channels}]
`;

const config = slackConfig("{ id: GENG, reply: private }");

describe("buildAdapters Slack wiring", () => {
  afterEach(() => {
    delete process.env.TEST_SLACK_BOT_TOKEN;
    delete process.env.TEST_SLACK_APP_TOKEN;
  });

  it("resolves both gateway-side credentials and builds Slack", async () => {
    // Resolver falls back to env after the file lookup.
    process.env.TEST_SLACK_BOT_TOKEN = "xoxb-test";
    process.env.TEST_SLACK_APP_TOKEN = "xapp-test";
    const adapters = await buildAdapters(loadManifest(config), {
      since: { slack: 1786761000 },
      secretsDir: "/definitely/not/a/secrets/directory",
    });

    expect(adapters[0]).toBeInstanceOf(SlackAdapter);
    expect((adapters[0] as SlackAdapter).cursor()).toBe(1786761000);
  });

  it("fails before connecting when either credential is missing", async () => {
    delete process.env.TEST_SLACK_BOT_TOKEN;
    delete process.env.TEST_SLACK_APP_TOKEN;
    await expect(
      buildAdapters(loadManifest(config), { secretsDir: "/definitely/not/a/secrets/directory" }),
    ).rejects.toThrow(/bot token/);
  });

  // Reachability needs no channel id here: `message.im` opens the DM path, and the agent
  // answers in a DM without being tagged. The schema used to refuse the config that says
  // so, which left a DM-only agent listing a channel it was never meant to answer in.
  it("builds a Slack surface that lists no channels, which is a DM-only agent", async () => {
    process.env.TEST_SLACK_BOT_TOKEN = "xoxb-test";
    process.env.TEST_SLACK_APP_TOKEN = "xapp-test";

    const adapters = await buildAdapters(loadManifest(slackConfig("")));

    expect(adapters[0]).toBeInstanceOf(SlackAdapter);
    expect((adapters[0] as SlackAdapter).postTargets()).toEqual([]);
  });
});
/**
 * The capability `validate` and `doctor` answer without building anything, held against the
 * adapters that answer it at runtime.
 *
 * A scheduled turn answers with a top-level post, so a surface that cannot make one is a
 * bundle `run` refuses to start — and both pre-flight commands have to refuse it first,
 * with no credential, no relay, and no agent home to build an adapter from.
 */
describe("carriesTopLevelPosts", () => {
  afterEach(() => {
    delete process.env.TEST_SLACK_BOT_TOKEN;
    delete process.env.TEST_SLACK_APP_TOKEN;
    delete process.env.TEST_BUZZ_NSEC;
  });

  it("agrees with the adapter each kind is actually built into", async () => {
    process.env.TEST_SLACK_BOT_TOKEN = "xoxb-test";
    process.env.TEST_SLACK_APP_TOKEN = "xapp-test";
    // Every kind `ADAPTERS` registers, so the table cannot claim a capability for one the
    // CLI never checks. Buzz builds offline — the adapter opens its relay in `start()`.
    process.env.TEST_BUZZ_NSEC = generateKeypair().nsec;
    for (const [kind, yaml] of [
      ["console", "name: t\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]"],
      ["slack", slackConfig("{ id: GENG, reply: private }")],
      [
        "buzz",
        "name: t\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces:\n  - kind: buzz\n" +
          "    relayUrl: wss://relay.example\n    identity: TEST_BUZZ_NSEC\n" +
          "    channels: [{id: hive, reply: private}]",
      ],
    ] as const) {
      const [adapter] = await buildAdapters(loadManifest(yaml));
      const built = typeof adapter!.post === "function" && typeof adapter!.postTargets === "function";
      expect(carriesTopLevelPosts(kind), kind).toBe(built);
    }
  });

  it("says no for a kind nothing builds, rather than guessing", () => {
    // `buildAdapters` refuses such a surface anyway; what matters is that the answer here
    // is never an optimistic yes for something that will not exist.
    expect(carriesTopLevelPosts("discord")).toBe(false);
  });
});
