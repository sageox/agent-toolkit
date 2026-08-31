import { describe, it, expect } from "vitest";
import { ChannelQueue } from "../src/queue.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("ChannelQueue", () => {
  it("runs turns in one channel strictly in order, never overlapping", async () => {
    const q = new ChannelQueue({ maxConcurrentChannels: 4, channelQueueLimit: 10 });
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;

    const job = (name: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`start:${name}`);
      await tick(10);
      log.push(`end:${name}`);
      active--;
    };

    q.submit("hive", job("a"));
    q.submit("hive", job("b"));
    q.submit("hive", job("c"));
    await q.drain();

    expect(log).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
    expect(maxActive).toBe(1);
  });

  it("runs different channels in parallel", async () => {
    const q = new ChannelQueue({ maxConcurrentChannels: 4, channelQueueLimit: 10 });
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(10);
      active--;
    };

    q.submit("hive", job);
    q.submit("eng", job);
    q.submit("random", job);
    await q.drain();

    expect(maxActive).toBeGreaterThan(1);
  });

  it("caps how many channels run at once", async () => {
    const q = new ChannelQueue({ maxConcurrentChannels: 2, channelQueueLimit: 10 });
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(10);
      active--;
    };

    for (const c of ["a", "b", "c", "d", "e"]) q.submit(c, job);
    await q.drain();

    expect(maxActive).toBe(2);
  });

  it("sheds the oldest when a channel queue is full, and reports the count", async () => {
    const shed: string[] = [];
    const q = new ChannelQueue({
      maxConcurrentChannels: 1,
      channelQueueLimit: 2,
      onShed: (channel, count) => shed.push(`${channel}:${count}`),
    });
    const ran: string[] = [];
    const job = (n: string) => async () => {
      await tick(5);
      ran.push(n);
    };

    q.submit("hive", job("running")); // starts immediately
    q.submit("hive", job("queued-1"));
    q.submit("hive", job("queued-2"));
    q.submit("hive", job("queued-3")); // overflows: sheds the oldest queued
    await q.drain();

    expect(shed).toEqual(["hive:1"]);
    expect(ran).not.toContain("queued-1"); // oldest queued was dropped
    expect(ran).toContain("queued-3");
  });

  it("keeps serving a channel after one of its turns throws", async () => {
    const q = new ChannelQueue({ maxConcurrentChannels: 2, channelQueueLimit: 10 });
    const ran: string[] = [];

    q.submit("hive", async () => {
      throw new Error("turn blew up");
    });
    q.submit("hive", async () => {
      ran.push("after");
    });
    await q.drain();

    expect(ran).toEqual(["after"]);
  });
});
