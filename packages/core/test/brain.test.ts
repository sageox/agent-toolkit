import { describe, expect, it } from "vitest";
import { MockBrain, type Brain, type InboundEvent } from "../src/index.ts";

const event: InboundEvent = {
  id: { surface: "console", nativeId: "1" },
  surface: "console",
  channel: { surface: "console", id: "local", isPublic: false },
  author: {
    surface: "console",
    id: "local-user",
    isSelf: false,
    isAgent: false,
  },
  text: "hello",
  mentionsMe: true,
  ts: "2026-01-01T00:00:00.000Z",
  raw: "hello",
};

describe("MockBrain", () => {
  it("returns one echo reply for an inbound event", async () => {
    const brain: Brain = new MockBrain();
    const turn = brain.runTurn(event, { agentName: "test-agent" });

    await expect(turn.next()).resolves.toEqual({
      done: false,
      value: { type: "reply", msg: { text: "echo: hello" } },
    });
    await expect(turn.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
