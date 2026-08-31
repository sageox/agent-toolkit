import { describe, expect, it } from "vitest";
import {
  parseSlackEventId,
  slackEventId,
  toSlackInboundEvent,
} from "../src/normalize.ts";

describe("Slack normalization", () => {
  it("normalizes an app mention and keeps event ids channel-qualified", () => {
    const event = toSlackInboundEvent(
      {
        type: "app_mention",
        channel: "GPRIVATE",
        channel_type: "group",
        user: "U123",
        text: "<@UBOT> deploy &lt;main&gt; &amp; report",
        ts: "1786761000.000100",
        event_ts: "1786761000.000100",
        thread_ts: "1786760000.000001",
      },
      { botUserId: "UBOT" },
    );

    expect(event).toMatchObject({
      id: { surface: "slack", nativeId: "GPRIVATE:1786761000.000100" },
      surface: "slack",
      channel: { id: "GPRIVATE", isPublic: false },
      author: { id: "U123", isSelf: false, isAgent: false },
      text: "deploy <main> & report",
      mentionsMe: true,
      threadRoot: { nativeId: "GPRIVATE:1786760000.000001" },
    });
  });

  it("treats a DM as a mention and its own bot message as self-authored", () => {
    const event = toSlackInboundEvent(
      {
        type: "message",
        subtype: "bot_message",
        channel: "D123",
        channel_type: "im",
        user: "UBOT",
        bot_id: "BBOT",
        text: "hello",
        ts: "1786761000.000101",
      },
      { botUserId: "UBOT", botId: "BBOT" },
    );

    expect(event?.mentionsMe).toBe(true);
    expect(event?.channel.isPublic).toBe(false);
    expect(event?.author).toMatchObject({ isSelf: true, isAgent: true });
  });

  it("ignores edits and deletes rather than treating metadata as a request", () => {
    for (const subtype of ["message_changed", "message_deleted"]) {
      expect(
        toSlackInboundEvent(
          {
            type: "message",
            subtype,
            channel: "C123",
            user: "U123",
            text: "metadata",
            ts: "1786761000.1",
          },
          { botUserId: "UBOT" },
        ),
      ).toBeUndefined();
    }
  });

  it("ignores malformed timestamps instead of throwing out of the socket listener", () => {
    expect(
      toSlackInboundEvent(
        { type: "message", channel: "C123", user: "U123", text: "hi", ts: "not-a-ts" },
        { botUserId: "UBOT" },
      ),
    ).toBeUndefined();
  });

  it("round-trips Slack event references", () => {
    expect(parseSlackEventId(slackEventId("C123", "1786761000.000100"))).toEqual({
      channel: "C123",
      ts: "1786761000.000100",
    });
  });
});
