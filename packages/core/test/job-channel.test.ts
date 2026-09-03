import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventRef, ThreadReply } from "../src/events.ts";
import { jobChannelHandler, type JobChannelOptions } from "../src/job-channel.ts";
import {
  JobHost,
  type JobMembers,
  type JobPoster,
  type JobReader,
  type JobRun,
} from "../src/job-host.ts";
import { loadManifest, type JobConfig } from "../src/manifest.ts";
import type { McpHandler } from "../src/mcp-http.ts";

/**
 * The two verbs a probing job body has, driven through the real handler and — at the
 * bottom of this file — through a real body over a real socket.
 *
 * The property under test throughout is the pair of bounds, not the plumbing: a body may
 * speak into the one channel its job declared, and may read back only a thread the same
 * run rooted. Everything else it might name is refused.
 */

const base =
  "name: beekeeper\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
  "brains: [{preset: local}]\n";

/** One declared job, through the real schema so `report` carries what a bundle would get. */
const job = (report: string): JobConfig =>
  loadManifest(
    `${base}jobs: [{slug: rollcall, archetype: shift, description: 'Who is answering.', ` +
      `trigger: {schedules: ["*/5 * * * *"], onRequest: true}, killSwitch: {failDirection: open}, ` +
      `budget: {wallClockMs: 8000}, ` +
      `report: ${report}, run: {command: node, args: [runner/src/rollcall.ts]}}]\n`,
  ).jobs[0];

const PROBES = "{surface: console, channel: hive, probe: true}";
const REPORTS_ONLY = "{surface: console, channel: hive}";

const speaker = (id: string): ThreadReply["author"] => ({
  surface: "console",
  id,
  isSelf: false,
  isAgent: true,
});

describe("the job channel", () => {
  /** Every line this channel carried, and the ref each one was answered with. */
  const feed = (over: Partial<JobChannelOptions> = {}) => {
    const posts: Array<{
      channel: string;
      text: string;
      threadRoot?: EventRef;
      mentions?: readonly string[];
    }> = [];
    const reads: Array<{ root: EventRef; limit?: number }> = [];
    const post: JobPoster = async (report, text, threadRoot, mentions) => {
      posts.push({ channel: `${report.surface}:${report.channel}`, text, threadRoot, mentions });
      return { surface: "console", nativeId: `e${posts.length}` };
    };
    const read: JobReader = async (root, limit) => {
      reads.push({ root, limit });
      return [{ author: speaker("drone"), text: "here", ts: "2026-08-30T09:00:00.000Z" }];
    };
    const rosters: Array<{ channel: string; limit?: number }> = [];
    const members: JobMembers = async (report, limit) => {
      rosters.push({ channel: `${report.surface}:${report.channel}`, limit });
      return [speaker("drone"), speaker("forager")];
    };
    const handle = jobChannelHandler({
      report: job(PROBES).report!,
      post,
      read,
      members,
      ...over,
    });
    return { posts, reads, rosters, handle };
  };

  /** Calls a tool the way the body does, and parses the JSON it reads back. */
  const call = async (
    handle: McpHandler,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const result = await handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const text = ((result?.content as Array<{ text: string }>) ?? [])[0]?.text ?? "";
    return JSON.parse(text) as Record<string, unknown>;
  };

  it("posts into the channel the job declared, and hands back the root", async () => {
    const { posts, handle } = feed();

    // No field for a destination, so there is nothing for a body to compute one into: the
    // channel on the line is the manifest's, whatever the body asked for.
    expect(await call(handle, "post_message", { text: "roll call", channel: "somewhere" })).toEqual(
      { posted: true, threadRoot: "e1" },
    );
    expect(posts).toEqual([
      { channel: "console:hive", text: "roll call", threadRoot: undefined, mentions: undefined },
    ]);
  });

  it("carries the recipients a probe addresses, and refuses more than it may name", async () => {
    const { posts, handle } = feed();
    const roster = ["drone", "forager"];

    await call(handle, "post_message", { text: "roll call", mentions: roster });
    // Straight through to the surface, which is what renders them as its own addressing
    // primitive. Nothing here knows what an id looks like — the adapter refuses a name.
    expect(posts[0].mentions).toEqual(roster);

    // A body may address whom it likes, and cannot turn one line into a broadcast to
    // everyone the surface knows.
    await expect(
      call(handle, "post_message", {
        text: "roll call",
        mentions: Array.from({ length: 65 }, (_, i) => `agent-${i}`),
      }),
    ).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });

  it("threads a later line under a root this run posted", async () => {
    const { posts, handle } = feed();
    const first = await call(handle, "post_message", { text: "roll call" });

    await call(handle, "post_message", { text: "still waiting", threadRoot: first.threadRoot });
    expect(posts[1].threadRoot).toEqual({ surface: "console", nativeId: "e1" });
  });

  it("reads back only a thread this run rooted", async () => {
    const { reads, handle } = feed();
    const root = (await call(handle, "post_message", { text: "roll call" })).threadRoot;

    expect(await call(handle, "thread_read", { root, limit: 3 })).toEqual({
      replies: [{ author: speaker("drone"), text: "here", ts: "2026-08-30T09:00:00.000Z" }],
    });
    expect(reads).toEqual([{ root: { surface: "console", nativeId: "e1" }, limit: 3 }]);
  });

  it("refuses a root this run did not post, whichever verb names it", async () => {
    const { handle } = feed();
    // An id read out of a channel is exactly what this bound exists to stop: a body that
    // could name one could pull back a conversation it was never party to.
    await expect(call(handle, "thread_read", { root: "e404" })).rejects.toThrow(
      /did not post e404/,
    );
    await expect(
      call(handle, "post_message", { text: "me too", threadRoot: "e404" }),
    ).rejects.toThrow(/did not post e404/);
  });

  it("says a surface cannot read a thread rather than answering that nobody replied", async () => {
    const { handle } = feed({ read: undefined });
    const root = (await call(handle, "post_message", { text: "roll call" })).threadRoot;

    // The whole reason the probe exists: "nobody answered" and "this surface cannot tell
    // you" must not arrive as the same value, or a roll call names everyone silent.
    await expect(call(handle, "thread_read", { root })).rejects.toThrow(
      /nothing here can read a thread back on the console surface/,
    );
  });

  it("reads the roster of the channel the job declared, and of no other", async () => {
    const { rosters, handle } = feed();

    // No destination argument, so a body has nothing to compute one into — the same shape
    // `post_message` has, and the same bound.
    expect(await call(handle, "channel_members", { channel: "somewhere" })).toEqual({
      members: [speaker("drone"), speaker("forager")],
    });
    expect(rosters).toEqual([{ channel: "console:hive", limit: 200 }]);

    // Capped whatever was asked for, because Slack charges a lookup per member.
    await call(handle, "channel_members", { limit: 5000 });
    expect(rosters[1].limit).toBe(200);

    // A limit that is not a count is refused before the surface is touched, so a body
    // cannot turn a malformed argument into a roster read that quietly answers nothing.
    await expect(call(handle, "channel_members", { limit: 0 })).rejects.toThrow();
    await expect(call(handle, "channel_members", { limit: 1.5 })).rejects.toThrow();
    await expect(call(handle, "channel_members", { limit: "all" })).rejects.toThrow();
    expect(rosters).toHaveLength(2);
  });

  it("says a surface cannot read a roster rather than answering that nobody is there", async () => {
    const { handle } = feed({ members: undefined });

    // Sharper than the thread read: an empty roster is a real finding — the channel nobody
    // joined — so a probe handed `[]` here would report the bring-up failure it was written
    // to catch as an ordinary empty room.
    await expect(call(handle, "channel_members", {})).rejects.toThrow(
      /nothing here can read the membership of a console channel/,
    );
  });
});

describe("a job body that probes", () => {
  let workDir: string;
  let marker: string;
  let runs: JobRun[];
  let posts: string[];
  /** The thread each root holds, as the surface would answer it. */
  let thread: Map<string, ThreadReply[]>;

  /**
   * A real body: a node process that reaches the channel over HTTP, exactly as one written
   * in any other language would. Nothing here imports the toolkit.
   */
  const CALL =
    'const call=async(name,args)=>{const r=await fetch(process.env.JOB_CHANNEL_URL,{method:"POST",' +
    'headers:{authorization:"Bearer "+process.env.JOB_CHANNEL_TOKEN,"content-type":"application/json"},' +
    'body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:name,arguments:args}})});' +
    "const j=await r.json();if(j.error)throw new Error(j.error.message);" +
    "return JSON.parse(j.result.content[0].text)};";

  /** Posts, reads the answers back, and mints its gate from what it actually read. */
  const PROBE =
    CALL +
    'fs.appendFileSync(process.env.MARKER,String(process.env.JOB_CHANNEL_URL)+"\\n");' +
    "(async()=>{" +
    'const p=await call("post_message",{text:"roll call"});' +
    'const t=await call("thread_read",{root:p.threadRoot});' +
    "fs.writeFileSync(process.env.JOB_VERDICT_PATH,JSON.stringify({gates:[{" +
    'gate:"answered",executed:true,exitCode:t.replies.length===2?0:1,' +
    'detail:t.replies.map(r=>r.author.id).join(", ")}]}))})()';

  /** Writes down what the envelope told it, and proves one gate. */
  const REPORTS =
    'fs.appendFileSync(process.env.MARKER,String(process.env.JOB_CHANNEL_URL)+"\\n");' +
    "fs.writeFileSync(process.env.JOB_VERDICT_PATH," +
    'JSON.stringify({gates:[{gate:"ci",executed:true,exitCode:0}]}))';

  const body = (declared: JobConfig, script: string): JobConfig => ({
    ...declared,
    run: {
      ...declared.run,
      command: process.execPath,
      args: ["-e", `const fs=require("fs");${script}`],
      passthrough: [...declared.run.passthrough, "MARKER"],
    },
  });

  const post: JobPoster = async (_report, text) => {
    posts.push(text);
    const ref: EventRef = { surface: "console", nativeId: `e${posts.length}` };
    thread.set(ref.nativeId, [
      { author: speaker("drone"), text: "here", ts: "2026-08-30T09:00:00.000Z" },
      { author: speaker("forager"), text: "here", ts: "2026-08-30T09:00:04.000Z" },
    ]);
    return ref;
  };
  const read: JobReader = async (root) => thread.get(root.nativeId) ?? [];

  const host = (over: { post?: JobPoster; read?: JobReader } = { post, read }) =>
    new JobHost({
      workDir,
      env: { ...process.env, MARKER: marker },
      onRun: (run) => runs.push(run),
      ...over,
    });

  /** What the envelope really told each body, which no description of it can fake. */
  const saw = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : []);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "job-channel-"));
    marker = join(workDir, "envelope");
    runs = [];
    posts = [];
    thread = new Map();
  });
  afterEach(() => rm(workDir, { recursive: true, force: true }));

  it("posts, reads the answers back, and mints its verdict from them", async () => {
    const run = await host().tick(body(job(PROBES), PROBE));

    expect(run.outcome).toBe("completed");
    expect(posts[0]).toBe("roll call");
    // The verdict is the host's, and the names in it are the body's — read off a channel
    // rather than composed, which is the whole reason this path is code and not a prompt.
    expect(run.gates.map((gate) => gate.detail)).toContain("drone, forager");
    expect(run.verdict.status).toBe("PASS");
  });

  it("tells only a probing job where its channel is", async () => {
    await host().tick(body(job(REPORTS_ONLY), REPORTS));
    expect(saw()).toEqual(["undefined"]);
  });

  it("closes the channel when the body is done", async () => {
    await host().tick(body(job(PROBES), PROBE));
    const [url] = saw();

    // A listener that outlived its body would be a port on this host holding a live token
    // and a way into a channel, with nothing left that legitimately calls it.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("refuses to start a probe it has no channel for", async () => {
    const run = await host({}).tick(body(job(PROBES), PROBE));

    // Not a quiet run: a probe with nowhere to speak would mint a verdict about a
    // conversation that never happened.
    expect(run.outcome).toBe("crashed");
    expect(run.reason).toContain("report.probe");
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(saw()).toEqual([]);
  });
});
