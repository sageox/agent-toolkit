import { describe, expect, it } from "vitest";
import type { SurfaceAdapter } from "../src/adapter.ts";
import type { ActorRef, ChannelRef, ThreadReply } from "../src/events.ts";
import { loadManifest } from "../src/manifest.ts";
import { SurfaceEgress } from "../src/surface-egress.ts";
import {
  surfaceReadHandler,
  SURFACE_READ_SERVER,
  SURFACE_READ_TOOL_NAMES,
} from "../src/surface-read.ts";
import { qualifyTool, ToolPolicy } from "../src/tool-policy.ts";

const manifest = loadManifest(
  "name: t\nbrain: { provider: mock }\nrespondTo: anyone\n" +
    "surfaces:\n  - kind: buzz\n    channels: []\n",
);

const HIVE: ChannelRef = { surface: "buzz", id: "hive", isPublic: false, name: "the hive" };
const IDA: ActorRef = {
  surface: "buzz",
  id: "npub1ida",
  isSelf: false,
  isAgent: true,
  name: "ida",
};

/** A surface that answers every read, recording the bound each call arrived with. */
function reader(over: Partial<SurfaceAdapter> = {}) {
  const limits: Array<number | undefined> = [];
  const channels: string[] = [];
  const value: SurfaceAdapter = {
    kind: "buzz",
    start: async () => {},
    send: async () => {},
    stop: async () => {},
    postTargets: () => [HIVE],
    post: async () => undefined,
    listChannels: async () => [HIVE, { surface: "buzz", id: "lobby", isPublic: true }],
    listMembers: async (channel, limit) => {
      channels.push(channel.id);
      limits.push(limit);
      return [IDA];
    },
    describeActor: async (id) => (id === IDA.id ? IDA : undefined),
    readChannel: async (channel, limit) => {
      channels.push(channel.id);
      limits.push(limit);
      return [{ author: IDA, text: "morning", ts: "2026-08-30T09:00:00.000Z" }] as ThreadReply[];
    },
    ...over,
  };
  return { value, limits, channels };
}

const allowAll = () =>
  new ToolPolicy(
    SURFACE_READ_TOOL_NAMES.map((tool) => qualifyTool(SURFACE_READ_SERVER, tool)),
    [],
  );

/** The full tool declarations, for assertions about what a description actually says. */
type Declared = { name: string; inputSchema: { properties: { surface: { description: string } } } };

async function handleTools(adapter: SurfaceAdapter): Promise<Declared[]> {
  const handle = surfaceReadHandler(
    new SurfaceEgress({ manifest, adapters: [adapter] }),
    allowAll(),
  );
  return ((await handle({ id: 1, method: "tools/list" }))?.tools ?? []) as Declared[];
}

/** The one line every tool shows the brain about where it may ask. */
const askableSurfaces = (declared: Declared[]) => [
  ...new Set(declared.map((tool) => tool.inputSchema.properties.surface.description)),
];

function server(adapter: SurfaceAdapter, policy = allowAll()) {
  const egress = new SurfaceEgress({ manifest, adapters: [adapter] });
  const handle = surfaceReadHandler(egress, policy);
  return {
    egress,
    tools: async () =>
      (((await handle({ id: 1, method: "tools/list" }))?.tools ?? []) as { name: string }[]).map(
        (tool) => tool.name,
      ),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await handle({
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const text = ((result?.content as Array<{ text: string }>) ?? [])[0]?.text ?? "";
      return JSON.parse(text) as Record<string, unknown>;
    },
  };
}

describe("the surface read server", () => {
  it("answers the four questions about the surface the agent is already on", async () => {
    const surface = reader();
    const { call } = server(surface.value);

    expect(await call("list_channels", { surface: "buzz" })).toEqual({
      channels: [HIVE, { surface: "buzz", id: "lobby", isPublic: true }],
    });
    expect(await call("list_members", { surface: "buzz", channel: "hive" })).toEqual({
      members: [IDA],
    });
    expect(await call("describe_actor", { surface: "buzz", id: IDA.id })).toEqual({ actor: IDA });
    expect(await call("read_channel", { surface: "buzz", channel: "hive" })).toEqual({
      messages: [{ author: IDA, text: "morning", ts: "2026-08-30T09:00:00.000Z" }],
    });
  });

  it("names a channel read by display name, and only among configured ones", async () => {
    const surface = reader();
    const { call } = server(surface.value);

    // The way a person asks — "who's in the hive" — resolved against configured targets,
    // exactly as a post is.
    await call("list_members", { surface: "buzz", channel: "the hive" });
    expect(surface.channels).toEqual(["hive"]);

    // `lobby` is a channel the surface says the agent is in, and not one an operator
    // configured. Listing it is diagnosis; reading it would be reach.
    await expect(call("read_channel", { surface: "buzz", channel: "lobby" })).rejects.toThrow(
      /not one this agent is configured for/,
    );
  });

  it("caps every read, so an unbounded one cannot be asked for", async () => {
    const surface = reader();
    const { call } = server(surface.value);

    await call("list_members", { surface: "buzz", channel: "hive" });
    await call("list_members", { surface: "buzz", channel: "hive", limit: 5000 });
    await call("read_channel", { surface: "buzz", channel: "hive", limit: 5000 });
    // Never `undefined`: Slack charges one `users.info` per member and a relay answers a
    // filterless read with whatever it stores, so the bound has to be here rather than in
    // whatever the brain happened to ask for.
    expect(surface.limits).toEqual([200, 200, 200]);
  });

  it("refuses a read the surface cannot make, rather than answering emptily", async () => {
    const { call } = server(reader({ listMembers: undefined, readChannel: undefined }).value);

    // Zero members and no membership read look identical to a caller handed `[]` for both,
    // and the first is the most common way an agent comes up healthy and unreachable.
    await expect(call("list_members", { surface: "buzz", channel: "hive" })).rejects.toThrow(
      /cannot say who is in a channel/,
    );
    await expect(call("read_channel", { surface: "buzz", channel: "hive" })).rejects.toThrow(
      /cannot read a channel back/,
    );
    await expect(call("list_channels", { surface: "slack" })).rejects.toThrow(
      /cannot say which channels this agent is in/,
    );
  });

  it("says an id is unknown without saying it could not look, and vice versa", async () => {
    const { call } = server(reader().value);

    // `null` and not `{}`: an actor with nothing known about it is a different finding
    // from an id the surface has never heard of.
    expect(await call("describe_actor", { surface: "buzz", id: "npub1nobody" })).toEqual({
      actor: null,
    });
    const blind = server(reader({ describeActor: undefined }).value);
    await expect(blind.call("describe_actor", { surface: "buzz", id: IDA.id })).rejects.toThrow(
      /cannot look an id up/,
    );
  });

  it("offers and serves only the reads the policy allows", async () => {
    const policy = new ToolPolicy([qualifyTool(SURFACE_READ_SERVER, "list_channels")], []);
    const { tools, call } = server(reader().value, policy);

    expect(await tools()).toEqual(["list_channels"]);
    // Listed and called are two decisions, and a brain that names a tool it was not offered
    // must meet the same answer.
    await expect(call("list_members", { surface: "buzz", channel: "hive" })).rejects.toThrow(
      /list_members refused/,
    );
  });

  it("names an askable surface even when it has no channel to post into", async () => {
    // A DM-only Slack agent configures no channels and is a working agent, so a tool
    // description built from post targets would tell the brain there was nowhere to ask.
    const dmOnly = reader({ postTargets: () => [], post: undefined });
    const { tools, egress } = server(dmOnly.value);

    expect(egress.targets()).toEqual([]);
    expect(egress.readableSurfaces()).toEqual(["buzz"]);
    // The `surface` argument is what names them, and it is the only place the brain
    // learns which surfaces there are to ask about.
    expect(askableSurfaces(await handleTools(dmOnly.value))).toEqual(["Which surface to ask: buzz"]);
    expect(await tools()).toContain("list_channels");
  });

  it("knows whether any surface here answers a read at all", () => {
    expect(server(reader().value).egress.canRead()).toBe(true);
    const deaf = reader({
      listChannels: undefined,
      listMembers: undefined,
      describeActor: undefined,
      readChannel: undefined,
    });
    expect(server(deaf.value).egress.canRead()).toBe(false);
  });
});
