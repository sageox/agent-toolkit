import { describe, expect, it, vi } from "vitest";
import type { SurfaceAdapter } from "../src/adapter.ts";
import type { ChannelRef, EventRef, GuardedMessage, InboundEvent } from "../src/events.ts";
import { loadManifest } from "../src/manifest.ts";
import {
  surfaceEgressHandler,
  resolveTarget,
  SurfaceEgress,
  SURFACE_EGRESS_TOOL,
  SURFACE_REACT_TOOL,
} from "../src/surface-egress.ts";
import { ToolPolicy } from "../src/tool-policy.ts";

const SERVE_BOTH = { postMessage: true, react: true };

function adapter(kind: string, targets: ChannelRef[]) {
  const posted: Array<{
    channel: ChannelRef;
    msg: GuardedMessage;
    threadRoot?: EventRef;
    mentions?: readonly string[];
  }> = [];
  const reactions: Array<{ target: string; emoji: string }> = [];
  const value: SurfaceAdapter = {
    kind,
    start: async () => {},
    send: async () => {},
    postTargets: () => targets,
    post: async (channel, msg, threadRoot, mentions) => {
      posted.push({ channel, msg, threadRoot, mentions });
      return { surface: kind, nativeId: `e${posted.length}` };
    },
    // The ref identifies the reaction, so one emoji on one message answers alike however
    // often it is asked for — the invariant every real adapter holds.
    react: async (target, emoji) => {
      reactions.push({ target: target.id.nativeId, emoji });
      return { ref: { surface: kind, nativeId: `${emoji}@${target.id.nativeId}` }, placed: true };
    },
    stop: async () => {},
  };
  return { value, posted, reactions };
}

/** A message the gateway would hand to a turn. */
function event(surface: string, channelId: string, isPublic = false, id = "m1"): InboundEvent {
  return {
    id: { surface, nativeId: id },
    surface,
    channel: { surface, id: channelId, isPublic },
    author: { surface, id: "npub1abc", isSelf: false, isAgent: false },
    text: "react 👍 and reply with your status",
    mentionsMe: true,
    ts: "2026-08-24T00:00:00Z",
    raw: null,
  };
}

/**
 * `buzzChannels` is where public consent lives now: a `reply: public` entry is what the
 * guard reads as the grant, so a test that needs an open destination lists one.
 */
function manifest(extra = "", buzzChannels = "") {
  return loadManifest(`
name: t
brain: { provider: mock }
respondTo: anyone
surfaces:
  - kind: buzz
    channels: [${buzzChannels}]
  - kind: slack
${extra}`);
}

describe("SurfaceEgress", () => {
  it("posts only through a configured adapter target", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "hive", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    await egress.post("buzz", "hive", { text: "shipped" });

    expect(buzz.posted).toEqual([
      {
        channel: { surface: "buzz", id: "hive", isPublic: false },
        msg: { text: "shipped" },
        mentions: undefined,
      },
    ]);
    await expect(egress.post("buzz", "other", { text: "no" })).rejects.toThrow(
      /not configured/i,
    );
  });

  it("hands back the posted ref, and threads the next post under it", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "hive", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    const root = await egress.post("buzz", "hive", { text: "job sweep completed" });
    expect(root).toEqual({ surface: "buzz", nativeId: "e1" });

    // A job's detail line takes the same guarded path its headline did — the thread root
    // buys no way around the public-channel or allowlist rules.
    await egress.post("buzz", "hive", { text: "NOT PROVEN: jscpd did not execute" }, root);
    expect(buzz.posted[1].threadRoot).toEqual(root);
  });

  it("carries recipients to the surface, and never from the brain's own tool", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "hive", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    await egress.post("buzz", "hive", { text: "roll call" }, undefined, ["drone", "forager"]);
    expect(buzz.posted[0].mentions).toEqual(["drone", "forager"]);

    // A list is a job's capability. The brain's field is `mention`, one principal — below
    // — and a `mentions` list on its call is dropped by the schema rather than reaching a
    // surface.
    await surfaceEgressHandler(egress, new ToolPolicy([SURFACE_EGRESS_TOOL], []), SERVE_BOTH)({
      method: "tools/call",
      params: {
        name: "post_message",
        arguments: { surface: "buzz", channel: "hive", text: "hi", mentions: ["drone"] },
      },
    });
    expect(buzz.posted[1].mentions).toBeUndefined();
  });

  it("applies the public-channel guard to cross-posts", async () => {
    const buzz = adapter("buzz", [
      { surface: "buzz", id: "town", isPublic: true },
      { surface: "buzz", id: "hive", isPublic: false },
    ]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    await expect(egress.post("buzz", "town", { text: "hello" })).rejects.toThrow(
      /publicChannel/,
    );
    expect(buzz.posted).toHaveLength(0);

    // The private one goes through whatever it says — the guard reads the destination.
    await egress.post("buzz", "hive", { text: "token=sk-secret-123" });
    expect(buzz.posted).toHaveLength(1);
  });

  it("scans a granted public destination for declared leak patterns", async () => {
    const buzz = adapter("buzz", [
      { surface: "buzz", id: "town", isPublic: true },
      { surface: "buzz", id: "hive", isPublic: false },
    ]);
    const egress = new SurfaceEgress({
      adapters: [buzz.value],
      manifest: manifest(
        `guard:
  leakPatterns:
    - name: internal-hostname
      regex: '\\bhost\\.internal\\b'`,
        "{ id: town, reply: public }",
      ),
    });

    // The grant opens the channel; the scan is the second gate on it, and it refuses by
    // pattern name — never by quoting what matched.
    const refused = await egress
      .post("buzz", "town", { text: "rolled out to host.internal" })
      .then(() => new Error("the post was not refused"), (error: Error) => error);
    expect(refused.message).toMatch(/leakPatterns.*internal-hostname/);
    expect(refused.message).not.toContain("host.internal");
    expect(buzz.posted).toHaveLength(0);

    // Same text, private destination: the scan runs only on the way somewhere public.
    await egress.post("buzz", "hive", { text: "rolled out to host.internal" });
    await egress.post("buzz", "town", { text: "rolled out" });
    expect(buzz.posted).toHaveLength(2);
  });

  it("enforces the tool policy again inside the hosted server", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "hive", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const call = {
      method: "tools/call",
      params: {
        name: "post_message",
        arguments: { surface: "buzz", channel: "hive", text: "done" },
      },
    };

    await expect(
      surfaceEgressHandler(egress, new ToolPolicy([], []), SERVE_BOTH)(call),
    ).rejects.toThrow(/not allowlisted/i);

    const result = await surfaceEgressHandler(
      egress,
      new ToolPolicy([SURFACE_EGRESS_TOOL], []),
      SERVE_BOTH,
    )(call);
    expect(result).toEqual({
      content: [{ type: "text", text: "Posted to buzz:hive." }],
    });
    expect(buzz.posted).toHaveLength(1);
  });

  it("reads a thread back through the adapter whose ref it is", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "hive", isPublic: false }]);
    const slack = adapter("slack", []);
    const speaker = (id: string) => ({ surface: "buzz", id, isSelf: false, isAgent: true });
    buzz.value.readThread = async (root, limit) => [
      { author: speaker(root.nativeId), text: `${limit}`, ts: "2026-08-30T09:00:00Z" },
    ];
    const egress = new SurfaceEgress({
      manifest: manifest("", "{ id: hive, reply: private }"),
      adapters: [buzz.value, slack.value],
    });

    // The ref's own surface picks the adapter, so a root cannot be read through a surface
    // that never issued it.
    expect(await egress.readThread({ surface: "buzz", nativeId: "e1" }, 5)).toEqual([
      { author: speaker("e1"), text: "5", ts: "2026-08-30T09:00:00Z" },
    ]);
  });

  it("refuses rather than reporting an empty thread where there is no thread model", async () => {
    const slack = adapter("slack", []);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [slack.value] });

    // "Nobody replied" is a finding; "this surface cannot tell you" is not one, and a
    // caller handed `[]` for the second would report the first.
    await expect(egress.readThread({ surface: "slack", nativeId: "e1" })).rejects.toThrow(
      /the slack surface cannot read a thread back/,
    );
  });
});

describe("resolveTarget", () => {
  const uuid = "6f1c0a2e-0000-4000-8000-000000000001";
  const targets: ChannelRef[] = [
    { surface: "buzz", id: uuid, isPublic: false, name: "hive" },
    { surface: "slack", id: "GENG", isPublic: false, name: "hive" },
  ];

  it("finds a channel by the name a person would say out loud", () => {
    expect(resolveTarget(targets, "buzz", "hive")?.id).toBe(uuid);
    expect(resolveTarget(targets, "buzz", "HIVE  ")?.id).toBe(uuid);
  });

  it("keeps a name on one surface from reaching the same name on another", () => {
    expect(resolveTarget(targets, "slack", "hive")?.id).toBe("GENG");
  });

  // Otherwise a channel could be named after another's id and quietly capture posts.
  it("prefers an exact id over a name that collides with it", () => {
    const collide: ChannelRef[] = [
      { surface: "buzz", id: "ops", isPublic: false, name: "hive" },
      { surface: "buzz", id: "hive", isPublic: false, name: "ops" },
    ];
    expect(resolveTarget(collide, "buzz", "hive")?.id).toBe("hive");
  });

  it("refuses an ambiguous name rather than guessing between two channels", () => {
    const twins: ChannelRef[] = [
      { surface: "buzz", id: "a", isPublic: false, name: "general" },
      { surface: "buzz", id: "b", isPublic: false, name: "general" },
    ];
    expect(resolveTarget(twins, "buzz", "general")).toBeUndefined();
  });

  it("finds nothing for an unconfigured channel", () => {
    expect(resolveTarget(targets, "buzz", "nope")).toBeUndefined();
  });
});

describe("cross-posting by display name", () => {
  const uuid = "6f1c0a2e-0000-4000-8000-000000000001";

  it("posts to the id the name resolves to, and advertises both", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: uuid, isPublic: false, name: "hive" }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    await egress.post("buzz", "hive", { text: "shipped" });
    expect(buzz.posted[0].channel.id).toBe(uuid);

    const listed = await surfaceEgressHandler(
      egress,
      new ToolPolicy([SURFACE_EGRESS_TOOL], []),
      SERVE_BOTH,
    )({ method: "tools/list" });
    const [tool] = (listed as { tools: Array<{ description: string }> }).tools;
    expect(tool.description).toContain(`buzz:${uuid} (hive)`);
  });

  // The guard reads `isPublic` off the resolved target, so reaching it by name must not
  // be a way around the rule that reaching it by id would hit.
  it("applies the public-channel guard to a name just as to an id", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: uuid, isPublic: true, name: "town" }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });

    await expect(egress.post("buzz", "town", { text: "hello" })).rejects.toThrow(
      /publicChannel/,
    );
    expect(buzz.posted).toHaveLength(0);
  });
});

describe("addressing one principal from the brain's post", () => {
  const hive: ChannelRef[] = [{ surface: "buzz", id: "hive", isPublic: false }];
  const OWNER = "a".repeat(64);
  const FRIEND = "b".repeat(64);
  const IDA = "c".repeat(64);
  const JUNO = "d".repeat(64);
  const named = () => manifest(`owner: ["${OWNER}"]\nallowlist: ["${FRIEND}"]`);
  const handler = (egress: SurfaceEgress) =>
    surfaceEgressHandler(egress, new ToolPolicy([SURFACE_EGRESS_TOOL], []), SERVE_BOTH);
  const call = (mention: string) => ({
    method: "tools/call",
    params: {
      name: "post_message",
      arguments: { surface: "buzz", channel: "hive", text: "sweep ok?", mention },
    },
  });

  it("wakes a principal the manifest names, on behalf of the turn that asked", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    const result = await handler(egress)(call(OWNER));
    expect(buzz.posted.map((p) => p.mentions)).toEqual([[OWNER]]);
    expect(result).toEqual({
      content: [{ type: "text", text: `Posted to buzz:hive, addressed to ${OWNER}.` }],
    });
    turn.close();

    const again = egress.answers(event("slack", "C0123", false, "m2"));
    await handler(egress)(call(FRIEND));
    expect(buzz.posted[1].mentions).toEqual([FRIEND]);
    again.close();
  });

  it("refuses a stranger, and posts nothing", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    await expect(handler(egress)(call("e".repeat(64)))).rejects.toThrow(/names nobody/);
    expect(buzz.posted).toHaveLength(0);
    turn.close();
  });

  it("resolves a name the surface vouches for, and refuses one shared by two", async () => {
    const buzz = adapter("buzz", hive);
    buzz.value.principals = () =>
      new Map([
        [IDA, "ida"],
        [JUNO, "juno"],
      ]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    await handler(egress)(call(" Ida "));
    expect(buzz.posted[0].mentions).toEqual([IDA]);
    turn.close();

    buzz.value.principals = () =>
      new Map([
        [IDA, "ida"],
        [JUNO, "ida"],
      ]);
    const twins = egress.answers(event("slack", "C0123", false, "m2"));
    await expect(handler(egress)(call("ida"))).rejects.toThrow(/names nobody/);
    expect(buzz.posted).toHaveLength(1);
    twins.close();
  });

  // One admitted message wakes at most one principal: that is the whole termination proof,
  // and it needs no counter beyond the turn itself.
  it("wakes at most one principal per turn, and a plain post does not spend it", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    await egress.post("buzz", "hive", { text: "fyi" });
    await handler(egress)(call(OWNER));
    await expect(handler(egress)(call(FRIEND))).rejects.toThrow(/already addressed/);
    expect(buzz.posted.map((p) => p.mentions)).toEqual([undefined, [OWNER]]);
    turn.close();
  });

  // The hosted server handles calls concurrently, so the reservation has to be taken
  // before the first await — two calls that both passed the check would both wake someone.
  it("lets two concurrent calls wake one principal, not two", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    const outcomes = await Promise.allSettled([handler(egress)(call(OWNER)), handler(egress)(call(FRIEND))]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(buzz.posted).toHaveLength(1);
    turn.close();
  });

  it("keeps the reservation when the surface failed after taking the post", async () => {
    const buzz = adapter("buzz", hive);
    const taken = buzz.value.post!;
    buzz.value.post = async (...args) => {
      await taken(...args);
      throw new Error("relay closed the socket before answering");
    };
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    await expect(egress.address("buzz", "hive", { text: "hi" }, OWNER)).rejects.toThrow(
      /closed the socket/,
    );
    // The message may well be out. Waking a second principal is worse than a lost retry.
    await expect(egress.address("buzz", "hive", { text: "hi" }, FRIEND)).rejects.toThrow(
      /already addressed/,
    );
    expect(buzz.posted).toHaveLength(1);
    turn.close();
  });

  it("gives the reservation back when the post was refused, so the brain can try again", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "town", isPublic: true }, ...hive]);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });
    const turn = egress.answers(event("slack", "C0123"));

    await expect(
      egress.address("buzz", "town", { text: "hi" }, OWNER),
    ).rejects.toThrow(/publicChannel/);
    await egress.address("buzz", "hive", { text: "hi" }, OWNER);
    expect(buzz.posted).toHaveLength(1);
    turn.close();
  });

  it("wakes nobody with no turn behind the call, or two", async () => {
    const buzz = adapter("buzz", [...hive, { surface: "buzz", id: "town", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });

    await expect(handler(egress)(call(OWNER))).rejects.toThrow(/no single conversation/);

    const first = egress.answers(event("buzz", "hive"));
    const second = egress.answers(event("buzz", "town", false, "m2"));
    await expect(handler(egress)(call(OWNER))).rejects.toThrow(/no single conversation/);
    expect(buzz.posted).toHaveLength(0);
    first.close();
    second.close();
  });

  it("lists the principals a surface can name, and not the manifest's ids", async () => {
    const buzz = adapter("buzz", hive);
    buzz.value.principals = () => new Map([[IDA, "ida"]]);
    const egress = new SurfaceEgress({ manifest: named(), adapters: [buzz.value] });

    const listed = await handler(egress)({ method: "tools/list" });
    const [tool] = (listed as { tools: Array<{ description: string }> }).tools;
    expect(tool.description).toContain(`buzz:${IDA} (ida)`);
    expect(tool.description).not.toContain(OWNER);
    expect(tool.description).toContain("wakes nobody unless");
  });
});

describe("reacting to the message a turn is answering", () => {
  const hive: ChannelRef[] = [{ surface: "buzz", id: "hive", isPublic: false }];

  it("marks the message the gateway said this turn is for", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const turn = egress.answers(event("buzz", "hive"));

    // The brain names the emoji and nothing else — every other part of the target comes
    // from the event the gateway received.
    await egress.react("👍");
    expect(buzz.reactions).toEqual([{ target: "m1", emoji: "👍" }]);
    turn.close();
  });

  it("forgets the target when the turn ends, so a late call lands nowhere", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    egress.answers(event("buzz", "hive")).close();

    await expect(egress.react("👍")).rejects.toThrow(/no message to react to/i);
    expect(buzz.reactions).toHaveLength(0);
  });

  // Turns are serialized per channel, so one channel is never ambiguous. Two are, and a
  // glyph on the wrong person's message is worse than a glyph nowhere.
  it("refuses rather than guessing when two conversations are mid-turn", async () => {
    const buzz = adapter("buzz", [...hive, { surface: "buzz", id: "town", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const first = egress.answers(event("buzz", "hive"));
    egress.answers(event("buzz", "town", false, "m2"));

    await expect(egress.react("👍")).rejects.toThrow(/ambiguous.*buzz:hive.*buzz:town/s);
    expect(buzz.reactions).toHaveLength(0);

    // Once the first finishes, the remaining one is exact again.
    first.close();
    await egress.react("👍");
    expect(buzz.reactions).toEqual([{ target: "m2", emoji: "👍" }]);
  });

  // The job door asks the same registry a different question: not which message, but who
  // sent it. A run a person is waiting on is not the unattended work a kill switch parks.
  it("names the author of the one live turn, and nobody when two are", () => {
    const buzz = adapter("buzz", [...hive, { surface: "buzz", id: "town", isPublic: false }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    expect(egress.asking()).toBeNull();

    const first = egress.answers(event("buzz", "hive"));
    expect(egress.asking()).toMatchObject({ id: "npub1abc", isAgent: false });

    // A different person in the second channel, so what comes back once one turn ends says
    // which turn it was read from rather than repeating the only author in the test.
    const inTown = event("buzz", "town", false, "m2");
    const second = egress.answers({ ...inTown, author: { ...inTown.author, id: "npub1ryan" } });
    expect(egress.asking()).toBeNull();

    first.close();
    expect(egress.asking()).toMatchObject({ id: "npub1ryan" });
    second.close();
    expect(egress.asking()).toBeNull();
  });

  // A closer removes only its own event: a superseded turn must not delete the live one.
  it("keeps the live target when a finished turn's closer runs late", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const stale = egress.answers(event("buzz", "hive", false, "m1"));
    egress.answers(event("buzz", "hive", false, "m2"));
    stale.close();

    await egress.react("👍");
    expect(buzz.reactions).toEqual([{ target: "m2", emoji: "👍" }]);
  });

  // A courtesy signal is still egress, and the guard reads the destination either way.
  it("refuses a reaction in a channel the agent may not speak in", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "town", isPublic: true }]);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    egress.answers(event("buzz", "town", true));

    await expect(egress.react("👍")).rejects.toThrow(/publicChannel/);
    expect(buzz.reactions).toHaveLength(0);
  });

  // The emoji is text the brain chose inside a turn that has read untrusted channel
  // content, so it goes out through the same scan a reply's text does. "It is only an
  // emoji" is a property of a well-behaved brain, not of this input.
  it("scans the emoji on the way somewhere public, exactly as a reply is scanned", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "town", isPublic: true }]);
    const egress = new SurfaceEgress({
      adapters: [buzz.value],
      manifest: manifest(
        `guard:
  leakPatterns:
    - name: api-token
      regex: 'sk-[A-Za-z0-9]{6,}'`,
        "{ id: town, reply: public }",
      ),
    });
    egress.answers(event("buzz", "town", true));

    const refused = await egress
      .react("sk-Abc123Def456")
      .then(() => new Error("the reaction was not refused"), (error: Error) => error);
    expect(refused.message).toMatch(/leakPatterns.*api-token/);
    // By pattern name, never by quoting what matched — quoting it would be the leak.
    expect(refused.message).not.toContain("sk-Abc123Def456");
    expect(buzz.reactions).toHaveLength(0);

    // A real glyph matches nothing, so the ordinary case is untouched.
    await egress.react("👍");
    expect(buzz.reactions).toEqual([{ target: "m1", emoji: "👍" }]);
  });

  // A surface that publishes nothing must not come back as a reaction. Reporting one here
  // has the brain tell the channel it signalled something it did not.
  it("refuses to report a reaction the surface did not publish", async () => {
    const buzz = adapter("buzz", hive);
    // What both adapters answer when they are not connected, or the message is not one
    // they serve: no error, and nothing published.
    buzz.value.react = async () => undefined;
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    egress.answers(event("buzz", "hive"));

    await expect(egress.react("👍")).rejects.toThrow(/did not accept the reaction/);
  });

  it("says so when the surface carries no reactions at all", async () => {
    const console_ = adapter("console", []);
    delete console_.value.react;
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [console_.value] });
    egress.answers(event("console", "tty"));

    await expect(egress.react("👍")).rejects.toThrow(/does not support reactions/);
  });

  it("reports what each capability can actually be served with", () => {
    const one = new SurfaceEgress({
      manifest: manifest(),
      adapters: [adapter("buzz", hive).value],
    });
    // One surface is a post target like any other. A job on a single-surface agent has no
    // inbound turn to answer, so the tool is the only way it reaches its own channel —
    // gating this on a second surface left that agent unable to speak on purpose.
    expect(one.canPost()).toBe(true);
    expect(one.canReact()).toBe(true);

    // What actually decides it is whether any channel is named at all.
    const none = new SurfaceEgress({
      manifest: manifest(),
      adapters: [adapter("buzz", []).value],
    });
    expect(none.canPost()).toBe(false);

    const two = new SurfaceEgress({
      manifest: manifest(),
      adapters: [
        adapter("buzz", hive).value,
        adapter("slack", [{ surface: "slack", id: "GENG", isPublic: false }]).value,
      ],
    });
    expect(two.canPost()).toBe(true);
  });
});

describe("the reaction tool", () => {
  const hive: ChannelRef[] = [{ surface: "buzz", id: "hive", isPublic: false }];
  const call = (emoji: string) => ({
    method: "tools/call",
    params: { name: "react", arguments: { emoji } },
  });

  it("enforces the tool policy again inside the hosted server", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    egress.answers(event("buzz", "hive"));

    // The cross-post grant is not a reaction grant: each tool is allowlisted by name.
    await expect(
      surfaceEgressHandler(egress, new ToolPolicy([SURFACE_EGRESS_TOOL], []), SERVE_BOTH)(
        call("👍"),
      ),
    ).rejects.toThrow(/not allowlisted/i);
    expect(buzz.reactions).toHaveLength(0);

    const result = await surfaceEgressHandler(
      egress,
      new ToolPolicy([SURFACE_REACT_TOOL], []),
      SERVE_BOTH,
    )(call("👍"));
    expect(result).toEqual({
      content: [
        { type: "text", text: "Reacted 👍 on the message you are answering in buzz:hive." },
      ],
    });
    expect(buzz.reactions).toEqual([{ target: "m1", emoji: "👍" }]);
  });

  // The bound is not what makes this safe — the guard is — but a reaction still must not
  // become a way to publish a paragraph, or to write one into an audit line.
  it("refuses a payload too long to be a glyph", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    egress.answers(event("buzz", "hive"));

    await expect(
      surfaceEgressHandler(egress, new ToolPolicy([SURFACE_REACT_TOOL], []), SERVE_BOTH)(
        call("x".repeat(65)),
      ),
    ).rejects.toThrow();
    expect(buzz.reactions).toHaveLength(0);
  });

  // Greptile's finding, from the path it actually ran: the hosted handler, a granted
  // public channel, and a secret in the emoji. It must not reach the surface, and it must
  // not reach the audit line on the way to being refused either.
  it("refuses a payload the guard catches, and writes none of it down", async () => {
    const buzz = adapter("buzz", [{ surface: "buzz", id: "town", isPublic: true }]);
    const egress = new SurfaceEgress({
      adapters: [buzz.value],
      manifest: manifest(
        `guard:
  leakPatterns:
    - name: api-token
      regex: 'sk-[A-Za-z0-9]{6,}'`,
        "{ id: town, reply: public }",
      ),
    });
    egress.answers(event("buzz", "town", true));
    const secret = "sk-Abc123Def456";

    const lines: string[] = [];
    const collect = (line: unknown) => void lines.push(String(line));
    const info = vi.spyOn(console, "info").mockImplementation(collect);
    const warn = vi.spyOn(console, "warn").mockImplementation(collect);
    try {
      await expect(
        surfaceEgressHandler(egress, new ToolPolicy([SURFACE_REACT_TOOL], []), SERVE_BOTH)(
          call(secret),
        ),
      ).rejects.toThrow(/leakPatterns/);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }

    expect(buzz.reactions).toHaveLength(0);
    const audit = lines.filter((line) => line.startsWith("tool_call "));
    expect(audit).toHaveLength(1);
    // Recorded as a shape, like `post_message`'s text: enough to see a reaction was tried.
    expect(audit[0]).toContain(`"emoji":"<string ${secret.length}>"`);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("offers only the tools the gateway agreed to serve", async () => {
    const buzz = adapter("buzz", hive);
    const egress = new SurfaceEgress({ manifest: manifest(), adapters: [buzz.value] });
    const policy = new ToolPolicy([SURFACE_EGRESS_TOOL, SURFACE_REACT_TOOL], []);
    const names = async (serve: { postMessage: boolean; react: boolean }) => {
      const listed = await surfaceEgressHandler(egress, policy, serve)({ method: "tools/list" });
      return (listed as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    };

    // One surface has nowhere to cross-post, and that is not a reason to hide the glyph.
    expect(await names({ postMessage: false, react: true })).toEqual(["react"]);
    expect(await names({ postMessage: true, react: false })).toEqual(["post_message"]);
    expect(await names({ postMessage: true, react: true })).toEqual(["post_message", "react"]);
  });
});
