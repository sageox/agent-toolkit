import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { SlackAdapter } from "@sageox/agent-toolkit-adapter-slack";
import { buildAdapters } from "../src/surfaces.ts";

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
