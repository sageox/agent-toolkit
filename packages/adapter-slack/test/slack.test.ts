import { describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "@sageox/agent-toolkit-core";
import {
  SlackAdapter,
  privacyOf,
  type SlackApiClient,
  type SlackHistoryPage,
  type SlackSocketClient,
} from "../src/slack.ts";

class FakeSocket implements SlackSocketClient {
  listener?: (payload: unknown) => void;
  started = false;
  disconnected = false;

  on(_event: string, listener: (payload: unknown) => void): void {
    this.listener = listener;
  }

  off(_event: string, listener: (payload: unknown) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  emit(event: Record<string, unknown>, ack = async () => {}): void {
    this.listener?.({ type: "events_api", body: { event }, ack });
  }
}

class FakeApi implements SlackApiClient {
  histories: SlackHistoryPage[] = [];
  historyCalls: Array<{ channel: string; oldest: string; cursor?: string }> = [];
  threads: SlackHistoryPage[] = [];
  replyCalls: Array<{ channel: string; ts: string; oldest: string; cursor?: string }> = [];
  posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  added: Array<{ channel: string; timestamp: string; name: string }> = [];
  removed: Array<{ channel: string; timestamp: string; name: string }> = [];

  async authTest() {
    return { userId: "UBOT", botId: "BBOT" };
  }
  async channelIsPrivate(channel: string) {
    return channel.startsWith("G");
  }
  async history(args: { channel: string; oldest: string; cursor?: string }) {
    this.historyCalls.push(args);
    return this.histories.shift() ?? {};
  }
  async replies(args: { channel: string; ts: string; oldest: string; cursor?: string }) {
    this.replyCalls.push(args);
    return this.threads.shift() ?? {};
  }
  async postMessage(args: { channel: string; text: string; threadTs?: string }) {
    this.posts.push(args);
    // Slack answers with the new message's `ts`. Numbered so a thread root is traceable
    // back to the post that minted it.
    return `1786761${String(this.posts.length).padStart(3, "0")}.000200`;
  }
  async addReaction(args: { channel: string; timestamp: string; name: string }) {
    this.added.push(args);
  }
  async removeReaction(args: { channel: string; timestamp: string; name: string }) {
    this.removed.push(args);
  }
}

function adapter(extra: Partial<ConstructorParameters<typeof SlackAdapter>[0]> = {}) {
  const socket = new FakeSocket();
  const api = new FakeApi();
  const instance = new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    channels: [{ id: "GENG", reply: "private" }],
    api,
    socket,
    ...extra,
  });
  return { instance, socket, api };
}

function mention(ts = "1786761000.000100", extra: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: "GENG",
    channel_type: "group",
    user: "U123",
    text: "<@UBOT> status?",
    ts,
    event_ts: ts,
    ...extra,
  };
}

describe("SlackAdapter", () => {
  it("acks and delivers configured-channel events, ignoring other channels", async () => {
    const { instance, socket } = adapter();
    const got: InboundEvent[] = [];
    let acked = false;
    await instance.start((event) => got.push(event));

    socket.emit(mention(), async () => {
      acked = true;
    });
    socket.emit({ ...mention("1786761000.000200"), channel: "GOTHER" });
    await Promise.resolve();

    expect(acked).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ text: "status?", mentionsMe: true });
  });

  it("posts into the triggering thread and maps the default acknowledgement emoji", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention("1786761000.000200", { thread_ts: "1786760000.000001" }));

    const acknowledged = await instance.react(got[0], "👀");
    await instance.send(got[0].channel, { text: "all green" });
    await instance.unreact(acknowledged!.ref);

    expect(api.posts).toEqual([
      { channel: "GENG", text: "all green", threadTs: "1786760000.000001" },
    ]);
    expect(api.added[0]).toEqual({
      channel: "GENG",
      timestamp: "1786761000.000200",
      name: "eyes",
    });
    expect(api.removed).toEqual(api.added);
  });

  it("uses the triggering event when a newer message has arrived in the same channel", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention("1786761000.000100"));
    socket.emit(mention("1786761000.000200"));

    await instance.send(got[0].channel, { text: "first reply" }, got[0]);

    expect(api.posts[0].threadTs).toBe("1786761000.000100");
  });

  it("posts a new top-level message to a configured channel without inbound context", async () => {
    const { instance, api } = adapter();
    await instance.start(() => {});

    const ref = await instance.post(
      { surface: "slack", id: "GENG", isPublic: false },
      { text: "shipped" },
    );

    expect(api.posts).toEqual([{ channel: "GENG", text: "shipped" }]);
    // Channel-qualified, because a Slack `ts` is unique only within a conversation.
    expect(ref).toEqual({ surface: "slack", nativeId: "GENG:1786761001.000200" });
    expect(instance.postTargets()).toEqual([
      { surface: "slack", id: "GENG", isPublic: false },
    ]);
  });

  it("posts without Socket Mode, and does not let an inbound outage suppress the post", async () => {
    const { instance, api, socket } = adapter();
    // Everything `post` needs — auth, and the channel visibility the guard reads — is
    // resolved off the Web API before the socket is ever touched. A `job run` posts one
    // status and exits, so an inbound connection it would never read is not merely idle:
    // it is a second thing that can fail and take the status post with it.
    socket.start = async () => {
      throw new Error("socket mode unavailable");
    };

    await instance.start();
    await instance.post({ surface: "slack", id: "GENG", isPublic: false }, { text: "shipped" });

    expect(api.posts).toEqual([{ channel: "GENG", text: "shipped" }]);
    // And stopping does not ask a client to disconnect a socket it never connected.
    await expect(instance.stop()).resolves.toBeUndefined();
  });

  it("still fails a listening start outright, so a deaf agent cannot look healthy", async () => {
    const { instance, socket } = adapter();
    socket.start = async () => {
      throw new Error("socket mode unavailable");
    };

    // The gateway asked to hear things. Coming up anyway is the silent-deafness failure
    // this repo has paid for; only a caller that wants no listener may proceed without one.
    await expect(instance.start(() => {})).rejects.toThrow(/socket mode unavailable/);
    await expect(
      instance.post({ surface: "slack", id: "GENG", isPublic: false }, { text: "no" }),
    ).rejects.toThrow(/must be called before post/);
  });

  it("threads a post under one it posted itself, and refuses a root from another channel", async () => {
    const { instance, api } = adapter({
      channels: [
        { id: "GENG", reply: "private" },
        { id: "GOPS", reply: "private" },
      ],
    });
    await instance.start(() => {});
    const channel = { surface: "slack", id: "GENG", isPublic: false } as const;

    const root = await instance.post(channel, { text: "job sweep completed" });
    await instance.post(channel, { text: "NOT PROVEN: jscpd did not execute" }, root);

    expect(api.posts[1].threadTs).toBe("1786761001.000200");
    // A `ts` from GOPS names a real message somewhere else; anchoring on it would open a
    // thread in this channel that nobody can find.
    await expect(
      instance.post(channel, { text: "detail" }, { surface: "slack", nativeId: "GOPS:1.000100" }),
    ).rejects.toThrow(/thread root must be a message in GENG/);
    expect(api.posts).toHaveLength(2);
  });

  it("addresses a post to the members it names, and refuses anything that is not one", async () => {
    const { instance, api } = adapter();
    await instance.start(() => {});
    const channel = { surface: "slack", id: "GENG", isPublic: false } as const;

    await instance.post(channel, { text: "roll call" }, undefined, ["U0DRONE", "B0FORAGER"]);
    expect(api.posts[0].text).toBe("<@U0DRONE> <@B0FORAGER> roll call");

    // A display name renders and wakes nobody, which is the silent failure the recipients
    // exist to avoid — and an id carrying markup would close the `<@…>` it sits inside and
    // smuggle back the broadcast `text` is already screened for.
    for (const who of ["beekeeper", "U0X><!channel><@U0Y"]) {
      await expect(
        instance.post(channel, { text: "roll call" }, undefined, [who]),
      ).rejects.toThrow(/addressed by member id/i);
    }
    expect(api.posts).toHaveLength(1);
  });

  it("refuses a top-level post to an unconfigured channel", async () => {
    const { instance, api } = adapter();
    await instance.start(() => {});

    await expect(
      instance.post({ surface: "slack", id: "GOTHER", isPublic: false }, { text: "no" }),
    ).rejects.toThrow(/not configured/i);
    await expect(
      instance.post(
        { surface: "slack", id: "GENG", isPublic: false },
        { text: "hello <!channel>" },
      ),
    ).rejects.toThrow(/bulk mentions/i);
    expect(api.posts).toHaveLength(0);
  });

  it("waits for a slow reaction add before withdrawing it", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    let finishAdd!: () => void;
    api.addReaction = async (args) => {
      api.added.push(args);
      await new Promise<void>((resolve) => {
        finishAdd = resolve;
      });
    };
    await instance.start((event) => got.push(event));
    socket.emit(mention());

    const adding = instance.react(got[0], "👀");
    // Nothing can be removed yet, and not because anything here is holding it back: the
    // ref that names the reaction is what `react` resolves to, so there is nothing to
    // withdraw until the addition has landed.
    expect(api.removed).toHaveLength(0);
    finishAdd();
    await instance.unreact((await adding)!.ref);

    expect(api.removed).toEqual(api.added);
  });

  // Two reactions stand on one message at once — the gateway's while the turn runs, and
  // whatever the brain was asked to signal — and only the first is ever withdrawn.
  it("withdraws the emoji it is asked for and leaves the other standing", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention());

    const acknowledged = await instance.react(got[0], "👀");
    await instance.react(got[0], ":tada:");
    await instance.unreact(acknowledged!.ref);

    expect(api.added.map((a) => a.name)).toEqual(["eyes", "tada"]);
    expect(api.removed.map((a) => a.name)).toEqual(["eyes"]);
  });

  // The key is what lets a caller see that two spellings are one reaction before either is
  // made — a pure comparison, so it can be asked about a request still in flight.
  it("keys both spellings of one emoji alike", () => {
    const { instance } = adapter();
    expect(instance.reactionKey("👀")).toBe(instance.reactionKey("eyes"));
    expect(instance.reactionKey(":thumbsup:")).toBe(instance.reactionKey("thumbsup"));
    expect(instance.reactionKey("👍")).not.toBe(instance.reactionKey("👎"));
  });

  // Slack answers the state we wanted as a failure. The reaction the second call asks for
  // is on the message — put there by the first, under whichever spelling — so the ref comes
  // back and says it is that one reaction rather than a new one or an error. What does not
  // come back is the right to withdraw it: `already_reacted` says a reaction exists under
  // this identity and says nothing about who made it or when.
  it("answers a duplicate add with the ref of the reaction, and does not claim it", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention());

    const first = await instance.react(got[0], "👀");
    api.addReaction = async () => {
      throw Object.assign(new Error("An API error occurred"), {
        data: { ok: false, error: "already_reacted" },
      });
    };
    // The other spelling of the same emoji, which only this adapter can see is the same.
    const again = await instance.react(got[0], "eyes");

    // One reaction, named identically through two spellings only this adapter can equate.
    expect(again!.ref).toEqual(first!.ref);
    // But only the call that actually added it may take it back.
    expect([first!.placed, again!.placed]).toEqual([true, false]);

    // A failure that is not that one is still a failure.
    api.addReaction = async () => {
      throw Object.assign(new Error("An API error occurred"), {
        data: { ok: false, error: "channel_not_found" },
      });
    };
    await expect(instance.react(got[0], "tada")).rejects.toThrow(/API error/);
  });

  // Slack names an emoji where every other surface carries the character, and there is no
  // general way between them — so both spellings work and an unmappable one says so.
  it("takes a Slack emoji name as readily as a character, refusing neither silently", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention());

    await instance.react(got[0], "rocket");
    await instance.react(got[0], ":sparkles:");
    expect(api.added.map((a) => a.name)).toEqual(["rocket", "sparkles"]);

    await expect(instance.react(got[0], "🦆")).rejects.toThrow(/Slack has no name for 🦆/);
    expect(api.added).toHaveLength(2);
  });

  it("backfills from the saved cursor after connecting and deduplicates overlap", async () => {
    const { instance, socket, api } = adapter({ since: 1786760000 });
    api.histories.push({
      messages: [mention("1786761000.000200"), mention("1786761000.000100")],
    });
    const got: InboundEvent[] = [];

    await instance.start((event) => got.push(event));
    socket.emit(mention("1786761000.000200"));

    expect(socket.started).toBe(true);
    expect(api.historyCalls).toEqual([
      { channel: "GENG", oldest: "1786760000", cursor: undefined },
    ]);
    expect(got.map((event) => event.id.nativeId)).toEqual([
      "GENG:1786761000.000100",
      "GENG:1786761000.000200",
    ]);
    expect(instance.cursor()).toBe(1786761000.0002);
  });

  it("replays the whole gap in channel order, thread replies included", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    // History pages newest-first, so the second page holds the older half of the gap.
    api.histories.push(
      { messages: [mention("1786761000.000400")], nextCursor: "page2" },
      {
        messages: [
          mention("1786761000.000100", {
            thread_ts: "1786761000.000100",
            latest_reply: "1786761000.000300",
          }),
        ],
      },
    );
    // conversations.replies leads with the parent, which history already delivered.
    api.threads.push({
      messages: [
        mention("1786761000.000100", { thread_ts: "1786761000.000100" }),
        mention("1786761000.000300", { thread_ts: "1786761000.000100" }),
      ],
    });
    const got: InboundEvent[] = [];

    await instance.start((event) => got.push(event));

    expect(api.replyCalls).toEqual([
      { channel: "GENG", ts: "1786761000.000100", oldest: "1786760000", cursor: undefined },
    ]);
    expect(got.map((event) => event.id.nativeId)).toEqual([
      "GENG:1786761000.000100",
      "GENG:1786761000.000300",
      "GENG:1786761000.000400",
    ]);
  });

  it("asks for replies only in threads that moved after the cursor", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    api.histories.push({ messages: [mention("1786761000.000100")] });

    await instance.start(() => {});

    expect(api.replyCalls).toEqual([]);
  });

  it("answers a DM, which no config could have named in advance", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    socket.emit({
      type: "message",
      channel: "D9001",
      channel_type: "im",
      user: "U123",
      text: "status?",
      ts: "1786761000.000300",
    });

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      mentionsMe: true,
      channel: { id: "D9001", isPublic: false },
    });

    // A DM has no channel to keep tidy, so the answer is not buried in a thread.
    await instance.send(got[0].channel, { text: "all green" }, got[0]);
    expect(api.posts).toEqual([{ channel: "D9001", text: "all green" }]);
    expect(api.posts[0].threadTs).toBeUndefined();
  });

  it("stays inside the thread when a DM question was asked in one", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    socket.emit({
      type: "message",
      channel: "D9001",
      channel_type: "im",
      user: "U123",
      text: "and the other one?",
      ts: "1786761000.000400",
      thread_ts: "1786761000.000300",
    });

    await instance.send(got[0].channel, { text: "also green" }, got[0]);
    expect(api.posts[0].threadTs).toBe("1786761000.000300");
  });

  it("keeps a running turn's reply target through a flood of later messages", async () => {
    // A backfill replays a whole gap in one burst, so the 2,049th message can land while
    // the first one's turn is still queued. Losing its context there costs the answer.
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    socket.emit(mention("1786761000.000001"));
    const acknowledged = await instance.react(got[0], "👀");
    for (let i = 2; i <= 2_100; i++) {
      socket.emit(mention(`1786761000.${String(i).padStart(6, "0")}`));
    }

    await instance.send(got[0].channel, { text: "answer" }, got[0]);
    await instance.unreact(acknowledged!.ref);

    expect(api.posts).toEqual([
      { channel: "GENG", text: "answer", threadTs: "1786761000.000001" },
    ]);
    expect(api.removed).toEqual(api.added);
  });

  it("answers a turn that ran an hour after the message, with its reaction intact", async () => {
    // A turn can sit behind channelQueueLimit others, each up to turnTimeoutMs, so how
    // long it waits is the gateway's business — the adapter must not put a clock on it.
    vi.useFakeTimers();
    try {
      const { instance, socket, api } = adapter();
      const got: InboundEvent[] = [];
      await instance.start((event) => got.push(event));
      socket.emit(mention("1786761000.000001"));
      const acknowledged = await instance.react(got[0], "👀");

      vi.setSystemTime(Date.now() + 60 * 60_000);
      socket.emit(mention("1786761000.000002"));

      await instance.send(got[0].channel, { text: "worth the wait" }, got[0]);
      await instance.unreact(acknowledged!.ref);
      expect(api.posts[0].threadTs).toBe("1786761000.000001");
      expect(api.removed).toEqual(api.added);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses unconfigured channels and Slack-native bulk mentions", async () => {
    const { instance, socket } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    socket.emit(mention());

    await expect(
      instance.send({ surface: "slack", id: "GOTHER", isPublic: false }, { text: "hi" }),
    ).rejects.toThrow(/not configured/);
    // A DM opens a reply path by speaking first, never by being addressed cold.
    await expect(
      instance.send({ surface: "slack", id: "D404", isPublic: false }, { text: "hi" }),
    ).rejects.toThrow(/not configured/);
    await expect(instance.send(got[0].channel, { text: "hello <!channel>" })).rejects.toThrow(
      /bulk mentions/,
    );
  });

  it("disconnects cleanly", async () => {
    const { instance, socket } = adapter();
    await instance.start(() => {});
    await instance.stop();
    expect(socket.disconnected).toBe(true);
    expect(socket.listener).toBeUndefined();
  });

  it("keeps an explicit is_private:false as false, not unknown", async () => {
    // This is what conversations.info returns for a public channel: is_private false, the
    // IM flags absent. `is_private || is_im || is_mpim` yields undefined for it, laundering
    // a definitive public answer into "could not classify" — which callers then treat as
    // private, keeping a stale assertion and letting a workspace-visible reply through.
    expect(privacyOf({ is_private: false })).toBe(false);
    expect(privacyOf({ is_private: true })).toBe(true);
    expect(privacyOf({ is_private: false, is_im: true })).toBe(true);
    expect(privacyOf({ is_private: false, is_mpim: true })).toBe(true);
    // Only a missing channel object is genuinely unknown.
    expect(privacyOf(undefined)).toBeUndefined();
  });

  it("reports a G-prefixed channel Slack calls public as public", async () => {
    // The ID prefix is a guess — Slack Connect and shared channels do not follow one — so
    // an explicit is_private:false has to outrank it. Otherwise the channel normalizes
    // private, the guard never sees a public channel, and the reply goes out to a
    // workspace-visible conversation while the guard reports itself enforcing.
    const socket = new FakeSocket();
    const api = new FakeApi();
    api.channelIsPrivate = async () => false;
    const instance = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: [{ id: "GENG", reply: "private" }],
      api,
      socket,
    });

    const events: InboundEvent[] = [];
    await instance.start((event) => events.push(event));
    socket.emit(mention());
    await Promise.resolve();

    expect(events[0]?.channel.isPublic).toBe(true);
  });

  it("keeps the prefix heuristic when Slack cannot be asked", async () => {
    // A missing groups:read scope is not a denial, so an unanswered channel must not
    // become public and silence an agent that was working.
    const socket = new FakeSocket();
    const api = new FakeApi();
    api.channelIsPrivate = async () => {
      throw new Error("missing_scope");
    };
    const instance = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: [{ id: "GENG", reply: "private" }],
      api,
      socket,
    });

    const events: InboundEvent[] = [];
    await instance.start((event) => events.push(event));
    socket.emit(mention());
    await Promise.resolve();

    expect(events[0]?.channel.isPublic).toBe(false);
  });

  it("offers a G-prefixed channel Slack calls public as a public egress target", async () => {
    // The outbound half of the same rule. A stale `--private-channels` assertion used to
    // survive Slack answering is_private:false, and postTargets read that assertion alone
    // — so the egress guard was handed isPublic:false and let a cross-surface post into a
    // workspace-visible channel while reporting the guard as enforcing.
    const socket = new FakeSocket();
    const api = new FakeApi();
    api.channelIsPrivate = async () => false;
    const instance = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: [{ id: "GENG", reply: "private" }],
      api,
      socket,
    });

    await instance.start(() => {});

    expect(instance.postTargets()).toEqual([
      { surface: "slack", id: "GENG", isPublic: true },
    ]);
  });

  it("keeps offering an unanswered channel as private, so a lost scope cannot widen egress", async () => {
    const socket = new FakeSocket();
    const api = new FakeApi();
    api.channelIsPrivate = async () => {
      throw new Error("missing_scope");
    };
    const instance = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: [{ id: "GENG", reply: "private" }],
      api,
      socket,
    });

    await instance.start(() => {});

    expect(instance.postTargets()).toEqual([
      { surface: "slack", id: "GENG", isPublic: false },
    ]);
  });
});
