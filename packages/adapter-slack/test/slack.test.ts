import { describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "@sageox/agent-toolkit-core";
import {
  SlackAdapter,
  privacyOf,
  type SlackApiClient,
  type SlackDirectPage,
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

  /** Answers when the adapter has finished with the envelope: delivery is not synchronous. */
  emit(event: Record<string, unknown>, ack = async () => {}): unknown {
    return this.listener?.({ type: "events_api", body: { event }, ack });
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
  dms: SlackDirectPage[] = [];
  dmCalls: Array<string | undefined> = [];
  async channelIsPrivate(channel: string) {
    return channel.startsWith("G");
  }
  async openDirectChannels(cursor?: string) {
    this.dmCalls.push(cursor);
    return this.dms.shift() ?? {};
  }
  async history(args: { channel: string; oldest: string; cursor?: string }) {
    this.historyCalls.push(args);
    return this.histories.shift() ?? {};
  }
  async replies(args: { channel: string; ts: string; oldest: string; cursor?: string }) {
    this.replyCalls.push(args);
    return this.threads.shift() ?? {};
  }
  names: Record<string, string> = {};
  nameCalls: string[] = [];
  async userName(id: string): Promise<string | undefined> {
    this.nameCalls.push(id);
    return this.names[id];
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

    await socket.emit(mention(), async () => {
      acked = true;
    });
    await socket.emit({ ...mention("1786761000.000200"), channel: "GOTHER" });
    await Promise.resolve();

    expect(acked).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ text: "status?", mentionsMe: true });
  });

  it("posts into the triggering thread and maps the default acknowledgement emoji", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    await socket.emit(mention("1786761000.000200", { thread_ts: "1786760000.000001" }));

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
    await socket.emit(mention("1786761000.000100"));
    await socket.emit(mention("1786761000.000200"));

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

  it("reads back the replies to a post of its own, oldest first and without the parent", async () => {
    const { instance, api } = adapter();
    await instance.start(() => {});
    const channel = { surface: "slack", id: "GENG", isPublic: false } as const;
    const root = await instance.post(channel, { text: "roll call" }, undefined, ["U0DRONE"]);

    // Slack hands back the parent whatever `oldest` says, pages a long thread, and does not
    // promise the order — and a join notice is no more a reply than it is a turn.
    api.threads = [
      {
        messages: [
          { type: "message", user: "UBOT", text: "roll call", ts: "1786761001.000200" },
          { type: "message", user: "U0DRONE", text: "<@UBOT> awake", ts: "1786761003.000000" },
        ],
        nextCursor: "page2",
      },
      {
        messages: [
          { type: "message", subtype: "channel_join", user: "U0LATE", text: "", ts: "1786761004.000000" },
          { type: "message", user: "U0FORAGER", text: "here", ts: "1786761002.000000" },
        ],
      },
    ];

    const replies = await instance.readThread!(root!);
    expect(api.replyCalls).toEqual([
      { channel: "GENG", ts: "1786761001.000200", oldest: "0", cursor: undefined },
      { channel: "GENG", ts: "1786761001.000200", oldest: "0", cursor: "page2" },
    ]);
    expect(replies.map((reply) => [reply.author.id, reply.text])).toEqual([
      ["U0FORAGER", "here"],
      ["U0DRONE", "awake"],
    ]);
    expect(replies[0].ts).toBe(new Date(1786761002_000).toISOString());
    // The bot's own reply is its own, so a tally can tell an answer from an echo.
    expect(replies.map((reply) => reply.author.isSelf)).toEqual([false, false]);

    api.threads = [{ messages: [{ type: "message", user: "U0A", text: "1", ts: "1786761005.000000" }] }];
    expect(await instance.readThread!(root!, 0)).toEqual([]);
  });

  it("names mentions in a thread read the same way the inbound path does", async () => {
    const { instance, api } = adapter();
    api.names = { U0ALICE: "alice" };
    await instance.start(() => {});
    const channel = { surface: "slack", id: "GENG", isPublic: false } as const;
    const root = await instance.post(channel, { text: "roll call" }, undefined, ["U0DRONE"]);

    api.threads = [
      {
        messages: [
          { type: "message", user: "UBOT", text: "roll call", ts: "1786761001.000200" },
          { type: "message", user: "U0DRONE", text: "ask <@U0ALICE>", ts: "1786761003.000000" },
        ],
      },
    ];

    // A probe tallying replies must not read a mention differently from the channel it is
    // reading — sharing the directory without filling it is what made the two disagree.
    const replies = await instance.readThread!(root!);
    expect(replies.map((reply) => reply.text)).toEqual(["ask @alice"]);
    expect(api.nameCalls).toEqual(["U0ALICE"]);
  });

  it("refuses a thread read it cannot answer, rather than reporting an empty thread", async () => {
    const { instance, api } = adapter();
    const root = { surface: "slack", nativeId: "GENG:1786761001.000200" } as const;

    // Each of these would mint a verdict naming every agent silent if it answered `[]`.
    await expect(instance.readThread!(root)).rejects.toThrow(/must be called before readThread/);
    await instance.start(() => {});
    await expect(
      instance.readThread!({ surface: "buzz", nativeId: "abc" }),
    ).rejects.toThrow(/buzz thread root names no Slack thread/);
    await expect(
      instance.readThread!({ surface: "slack", nativeId: "GOPS:1786761001.000200" }),
    ).rejects.toThrow(/conversation this agent serves/);
    await expect(
      instance.readThread!({ surface: "slack", nativeId: "nonsense" }),
    ).rejects.toThrow(/conversation this agent serves/);

    // The one that would not announce itself: a root this adapter does serve, refused by
    // Slack. Swallowing it into `[]` is how a probe comes to report a live fleet silent.
    api.replies = async () => {
      throw new Error("ratelimited");
    };
    await expect(instance.readThread!(root)).rejects.toThrow(/ratelimited/);
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

  it("renders the brain's own text literally, so only `mentions` addresses anyone", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));
    // Quoting the message that woke the agent must not page whoever it named. Two
    // independent things now stop it, and this asserts both: the mention reaches the brain
    // as a name rather than markup, and what the brain sends is escaped regardless.
    api.names = { U0ALICE: "alice" };
    await socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE> & <@U0BOB>" }));
    expect(got[0].text).toBe("ask @alice & @U0BOB");

    await instance.send(got[0].channel, { text: got[0].text }, got[0]);
    expect(api.posts[0].text).toBe("ask @alice &amp; @U0BOB");

    // The recipients the adapter builds from validated ids stay markup; the text beside
    // them does not, so the two ways to address somebody have not become one again.
    const channel = { surface: "slack", id: "GENG", isPublic: false } as const;
    await instance.post(channel, { text: "who is <@U0ALICE>?" }, undefined, ["U0DRONE"]);
    expect(api.posts[1].text).toBe("<@U0DRONE> who is &lt;@U0ALICE&gt;?");
  });

  it("names the members a message mentions, and asks Slack about each one once", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    api.names = { U0ALICE: "alice", U0BOB: "bob" };
    await instance.start((event) => got.push(event));

    await socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE> and <@U0BOB>" }));
    await socket.emit(mention("1786761000.000200", { text: "<@UBOT> and <@U0ALICE> again" }));

    expect(got.map((event) => event.text)).toEqual(["ask @alice and @bob", "and @alice again"]);
    // Each member once across both messages, and never the bot: its own mention is stripped.
    expect(api.nameCalls).toEqual(["U0ALICE", "U0BOB"]);
  });

  it("keeps a mention Slack will not name, and stops asking about it", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    // No `users:read`, a deactivated account, another Grid workspace — all the same here.
    api.userName = async (id: string) => {
      api.nameCalls.push(id);
      throw new Error("missing_scope");
    };
    await socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0GHOST>" }));
    await socket.emit(mention("1786761000.000200", { text: "<@UBOT> ask <@U0GHOST> again" }));

    // The mention still reads as a mention. Dropping it would lose the fact that somebody
    // was named, which is worse than naming them by id.
    expect(got.map((event) => event.text)).toEqual(["ask @U0GHOST", "ask @U0GHOST again"]);
    // Asked once. A refusal that is not remembered spends the rate limit re-asking forever.
    expect(api.nameCalls).toEqual(["U0GHOST"]);
  });

  it("delivers in arrival order even when the first message waits on a lookup", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    // The first message needs a name and the second does not. Without the chain the second
    // overtakes it, `ChannelQueue` submits them reversed, and the agent answers backwards.
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.userName = async (id: string) => {
      await held;
      return id === "U0ALICE" ? "alice" : undefined;
    };
    const first = socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }));
    const second = socket.emit(mention("1786761000.000200", { text: "<@UBOT> second" }));

    expect(got).toHaveLength(0);
    release!();
    await Promise.all([first, second]);

    expect(got.map((event) => event.text)).toEqual(["ask @alice", "second"]);
  });

  it("believes the directory over a label the sending client embedded", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    api.names = { U0ALICE: "alice" };
    await instance.start((event) => got.push(event));

    // The two disagree after a rename. On the reading that a label decides, the brain is
    // told a different person was named than the one Slack will actually notify.
    await socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE|bob>" }));
    // With nothing in the directory the label is still better than the bare id.
    await socket.emit(mention("1786761000.000200", { text: "<@UBOT> and <@U0CAROL|carol>" }));

    expect(got.map((event) => event.text)).toEqual(["ask @alice", "and @carol"]);
  });

  it("does not let one conversation's lookups hold up another's", async () => {
    const { instance, socket, api } = adapter({
      channels: [
        { id: "GENG", reply: "private" },
        { id: "GOPS", reply: "private" },
      ],
    });
    const got: InboundEvent[] = [];
    await instance.start((event) => got.push(event));

    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.userName = async () => {
      await held;
      return "alice";
    };
    // GENG is stuck on a lookup. GOPS mentions nobody and must not wait behind it —
    // ordering is what `ChannelQueue` needs per channel, and it runs channels in parallel.
    const stuck = socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }));
    await socket.emit({ ...mention("1786761000.000200"), channel: "GOPS" });

    expect(got.map((event) => event.channel.id)).toEqual(["GOPS"]);
    release!();
    await stuck;
    expect(got.map((event) => event.channel.id)).toEqual(["GOPS", "GENG"]);
  });

  it("drops a message still resolving when the adapter is stopped", async () => {
    const { instance, socket, api } = adapter();
    const first: InboundEvent[] = [];
    await instance.start((event) => first.push(event));

    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.userName = async () => {
      await held;
      return "alice";
    };
    const inFlight = socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }));

    // Stopped and restarted while that lookup is outstanding. The queued message belongs to
    // the run that heard it: delivering it to the new session's callback would answer a
    // question from before the restart, and leave its reply target behind in `lastByChannel`.
    await instance.stop();
    const second: InboundEvent[] = [];
    await instance.start((event) => second.push(event));
    release!();
    await inFlight;

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // The new run still works, and threads onto its own message rather than the dropped one.
    await socket.emit(mention("1786761000.000300"));
    await instance.send({ surface: "slack", id: "GENG", isPublic: false }, { text: "ok" });
    expect(api.posts[0].threadTs).toBe("1786761000.000300");
  });

  it("drops a queued event when the start that heard it fails", async () => {
    const { instance, socket, api } = adapter();
    const first: InboundEvent[] = [];
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The lookup is what holds the message past the failure. Without one it settles while
    // `onEvent` is still cleared, and nothing about the run it belongs to is ever tested.
    api.userName = async () => {
      await held;
      return "alice";
    };
    // The listener is registered before the connection is up, so an envelope can already be
    // queued when the start fails.
    let queued: unknown;
    socket.start = async () => {
      queued = socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }));
      throw new Error("socket mode unavailable");
    };

    await expect(instance.start((event) => first.push(event))).rejects.toThrow(/unavailable/);

    const second: InboundEvent[] = [];
    socket.start = async () => {};
    await instance.start((event) => second.push(event));
    release!();
    await queued;

    // It belongs to the run that heard it, and that run never came up.
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("abandons a replay when the adapter is stopped mid-backfill", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    const first: InboundEvent[] = [];
    let release: () => void;
    let entered: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inHistory = new Promise<void>((resolve) => {
      entered = resolve;
    });
    api.histories.push({ messages: [mention("1786761000.000100")] });
    const pages = api.history.bind(api);
    // Held *before* the replay is queued, which is the window that matters: a stop landing
    // here means the messages this page turns into were never queued by a live run.
    api.history = async (args) => {
      entered();
      await held;
      return pages(args);
    };

    const starting = instance.start((event) => first.push(event));
    await inHistory;
    await instance.stop();

    // The restart backfills nothing of its own, so anything the second run hears came from
    // the replay the first run abandoned.
    const second: InboundEvent[] = [];
    api.history = async () => ({});
    await instance.start((event) => second.push(event));
    release!();
    await starting;

    // The replay belongs to the run that asked for it. Delivering it into the next run
    // would answer a message from before the restart, and thread onto it afterwards.
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("stops paging and starting reply walks once the run it belongs to has ended", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    const first: InboundEvent[] = [];
    let release: () => void;
    let entered: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inHistory = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requested: Array<string | undefined> = [];
    api.history = async (args) => {
      requested.push(args.cursor);
      if (args.cursor) return {};
      entered();
      await held;
      // A page with more behind it, held until the run that asked for it has ended.
      return {
        messages: [
          mention("1786761000.000100", {
            text: "<@UBOT> ask <@U0ALICE>",
            thread_ts: "1786761000.000100",
            latest_reply: "1786761000.000300",
          }),
        ],
        nextCursor: "page2",
      };
    };

    const starting = instance.start((event) => first.push(event));
    await inHistory;
    await instance.stop();
    release!();
    await starting;

    // Paging to the end of a gap on behalf of a run that has ended is work nobody asked
    // for, against a rate limit the next run needs.
    expect(requested).toEqual([undefined]);
    // Nor is a reply walk started for a thread that moved: the page said so, but the run
    // that would have read it is over.
    expect(api.replyCalls).toEqual([]);
    expect(first).toEqual([]);
  });

  it("spends no lookup on a message already stale when its turn comes", async () => {
    const { instance, socket, api } = adapter();
    const got: InboundEvent[] = [];
    const looked: string[] = [];
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.userName = async (id: string) => {
      looked.push(id);
      if (id === "U0ALICE") await held;
      return id.toLowerCase();
    };
    await instance.start((event) => got.push(event));

    // Same conversation, so the second waits behind the first. By the time its turn comes
    // the run is over — and a chain is per conversation, so a lookup it spends is one the
    // run actually serving that conversation waits behind.
    const a = socket.emit(mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }));
    const b = socket.emit(mention("1786761000.000200", { text: "<@UBOT> ask <@U0BOB>" }));
    await instance.stop();
    release!();
    await Promise.all([a, b]);

    expect(looked).toEqual(["U0ALICE"]);
    expect(got).toEqual([]);
  });

  it("keeps a sorted replay contiguous when a live message lands mid-backfill", async () => {
    const { instance, socket, api } = adapter({ since: 1786760000 });
    const got: InboundEvent[] = [];
    let release: () => void;
    let entered: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inLookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    api.userName = async () => {
      entered();
      await held;
      return "alice";
    };
    // History pages newest-first, so the replay sorts to 000100 then 000200. Only the
    // first mentions anyone, which is what holds the replay open midway through.
    api.histories.push({
      messages: [
        mention("1786761000.000200"),
        mention("1786761000.000100", { text: "<@UBOT> ask <@U0ALICE>" }),
      ],
    });

    const starting = instance.start((event) => got.push(event));
    await inLookup;
    const live = socket.emit(mention("1786761000.000400"));
    release!();
    await Promise.all([starting, live]);

    // The live message must not land between two replayed ones. If it does, the older
    // replay that follows it is the last thing written to the reply target.
    expect(got.map((event) => event.id.nativeId)).toEqual([
      "GENG:1786761000.000100",
      "GENG:1786761000.000200",
      "GENG:1786761000.000400",
    ]);
    await instance.send({ surface: "slack", id: "GENG", isPublic: false }, { text: "ok" });
    expect(api.posts[0].threadTs).toBe("1786761000.000400");
  });

  it("stops enumerating DMs once the run it belongs to has ended", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    const got: InboundEvent[] = [];
    let release: () => void;
    let entered: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inDms = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requested: Array<string | undefined> = [];
    api.openDirectChannels = async (cursor?: string) => {
      requested.push(cursor);
      if (cursor) return { ids: ["DLATE"] };
      entered();
      await held;
      return { ids: ["DALICE"], nextCursor: "page2" };
    };

    const starting = instance.start((event) => got.push(event));
    await inDms;
    await instance.stop();
    release!();
    await starting;

    // Enumerating DMs pages like everything else here, and paging for a run that has ended
    // spends a rate limit the next run needs.
    expect(requested).toEqual([undefined]);
    expect(got).toEqual([]);
  });

  it("threads a context-free reply onto the newest message, not the last replayed one", async () => {
    const { instance, socket, api } = adapter({ since: 1786760000 });
    const got: InboundEvent[] = [];
    let release: () => void;
    let entered: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inHistory = new Promise<void>((resolve) => {
      entered = resolve;
    });
    api.histories.push({ messages: [mention("1786761000.000100")] });
    const pages = api.history.bind(api);
    // `start` connects before it fills the gap, so a live message can arrive while history
    // is still being collected — and it is newer than everything the replay will contain.
    api.history = async (args) => {
      entered();
      await held;
      return pages(args);
    };

    const starting = instance.start((event) => got.push(event));
    await inHistory;
    const live = socket.emit(mention("1786761000.000900"));
    release!();
    await Promise.all([starting, live]);

    // The replay lands after the live message and is older than it. The reply target is
    // the latest thing said, not whatever was processed last.
    expect(got.map((event) => event.id.nativeId)).toEqual([
      "GENG:1786761000.000900",
      "GENG:1786761000.000100",
    ]);
    await instance.send({ surface: "slack", id: "GENG", isPublic: false }, { text: "ok" });
    expect(api.posts[0].threadTs).toBe("1786761000.000900");
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
    await socket.emit(mention());

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
    await socket.emit(mention());

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
    await socket.emit(mention());

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
    await socket.emit(mention());

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
    await socket.emit(mention("1786761000.000200"));

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

  it("backfills the DMs it has open, which no config could have named", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    // Paged, so the cursor has to be carried back or the second DM is never enumerated.
    api.dms = [{ ids: ["DALICE"], nextCursor: "page2" }, { ids: ["DQUIET"] }];
    api.histories.push(
      { messages: [] }, // GENG
      // A history result carries no `channel_type`; the `D` prefix is what says "DM" here.
      { messages: [{ type: "message", user: "U123", text: "did the sweep finish?", ts: "1786761000.000100" }] },
      { messages: [] }, // DQUIET — open, but nothing arrived while the agent was away
    );
    const got: InboundEvent[] = [];

    await instance.start((event) => got.push(event));

    expect(api.dmCalls).toEqual([undefined, "page2"]);
    expect(api.historyCalls.map((call) => call.channel)).toEqual(["GENG", "DALICE", "DQUIET"]);
    expect(got.map((event) => event.id.nativeId)).toEqual(["DALICE:1786761000.000100"]);
    // A DM is private and is itself a direct address, whichever door it came in through.
    expect(got[0].channel.isPublic).toBe(false);
    expect(got[0].mentionsMe).toBe(true);

    // Reading a DM is not permission to speak in one. DALICE spoke in the gap and may be
    // answered; DQUIET was only ever enumerated, so it is still a conversation this
    // adapter must not open.
    await instance.send({ surface: "slack", id: "DALICE", isPublic: false }, { text: "yes" });
    await expect(
      instance.send({ surface: "slack", id: "DQUIET", isPublic: false }, { text: "hello" }),
    ).rejects.toThrow(/DQUIET is not configured/);
  });

  it("keeps the DMs it paged in when the lookup fails partway", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    api.dms = [{ ids: ["DALICE"], nextCursor: "page2" }];
    const pages = api.openDirectChannels.bind(api);
    // Page two never arrives. Discarding page one on that basis would drop a DM the agent
    // was told about, and take the configured channels down with it.
    api.openDirectChannels = async (cursor?: string) => {
      if (!cursor) return pages(cursor);
      api.dmCalls.push(cursor);
      throw new Error("ratelimited");
    };
    api.histories.push(
      { messages: [mention("1786761000.000100")] },
      { messages: [{ type: "message", user: "U123", text: "ping", ts: "1786761000.000200" }] },
    );
    const got: InboundEvent[] = [];

    await instance.start((event) => got.push(event));

    expect(api.dmCalls).toEqual([undefined, "page2"]);
    expect(got.map((event) => event.id.nativeId)).toEqual([
      "GENG:1786761000.000100",
      "DALICE:1786761000.000200",
    ]);
  });

  it("still backfills its channels when it may not ask which DMs are open", async () => {
    const { instance, api } = adapter({ since: 1786760000 });
    // No `im:read`. A channel-only agent must not be taken down by a scope it never needs.
    api.openDirectChannels = async () => {
      throw new Error("missing_scope");
    };
    api.histories.push({ messages: [mention("1786761000.000100")] });
    const got: InboundEvent[] = [];

    await instance.start((event) => got.push(event));

    expect(got.map((event) => event.id.nativeId)).toEqual(["GENG:1786761000.000100"]);
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

    await socket.emit({
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

    await socket.emit({
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

    await socket.emit(mention("1786761000.000001"));
    const acknowledged = await instance.react(got[0], "👀");
    for (let i = 2; i <= 2_100; i++) {
      await socket.emit(mention(`1786761000.${String(i).padStart(6, "0")}`));
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
      await socket.emit(mention("1786761000.000001"));
      const acknowledged = await instance.react(got[0], "👀");

      vi.setSystemTime(Date.now() + 60 * 60_000);
      await socket.emit(mention("1786761000.000002"));

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
    await socket.emit(mention());

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
    await socket.emit(mention());
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
    await socket.emit(mention());
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
