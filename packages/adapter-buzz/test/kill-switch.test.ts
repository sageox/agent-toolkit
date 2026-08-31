import { afterEach, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

import { admitJob, loadManifest, type JobConfig } from "@sageox/agent-toolkit-core";

import { EngramStore } from "../src/engram.ts";
import { resolveBuzzSigner } from "../src/identity.ts";
import { engramSwitchSource, type EngramSwitchConfig } from "../src/kill-switch.ts";
import { FakeRelay } from "./fake-relay.ts";

const KEY = "mem/sweep/enabled";

/** The declared job whose switch these tests read, at either fail-direction. */
function job(failDirection: "open" | "closed"): JobConfig {
  return loadManifest(
    "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
      "brains: [{preset: local}]\n" +
      "jobs: [{slug: sweep, archetype: sweep, description: 'Weekly pass.', " +
      `trigger: {schedules: ["0 3 * * 0"]}, killSwitch: {failDirection: ${failDirection}}, ` +
      "budget: {wallClockMs: 3600000}, run: {command: node}}]\n",
  ).jobs[0];
}

const stores: EngramStore[] = [];
const relays: FakeRelay[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const relay of relays.splice(0)) await relay.stop();
});

async function setup(relayOpts: { withholdEose?: boolean; rejectAuth?: boolean } = {}) {
  const relay = await FakeRelay.start({ requireAuth: true, ...relayOpts });
  relays.push(relay);
  const signer = await resolveBuzzSigner("TEST_NSEC", {
    env: { TEST_NSEC: nip19.nsecEncode(generateSecretKey()) },
  });
  const owner = getPublicKey(generateSecretKey());
  // Short, so a deliberately silent relay does not cost the suite the production deadline.
  const config: EngramSwitchConfig = {
    relayUrl: relay.url,
    owner,
    signer,
    queryTimeoutMs: 400,
  };

  /** Seeds the switch key the way an operator does — through the agent's own memory. */
  const seed = async (value: string) => {
    const store = new EngramStore({ ...config, owner, signer });
    stores.push(store);
    await store.write(KEY, value);
    store.close();
  };

  return { relay, config, seed };
}

describe("the remote half of the kill switch", () => {
  it("reads a parked switch out of the agent's own memory and stops the next tick", async () => {
    const { relay, config, seed } = await setup();
    await seed("off");
    const written = relay.published.length;

    const admission = await admitJob(
      job("open"),
      { trigger: "schedule" },
      engramSwitchSource(config),
    );

    // Fail-open, so nothing but a value somebody wrote could have stopped this job.
    expect(admission).toMatchObject({ admitted: false, outcome: "denied-switch" });
    expect(admission.switch).toEqual({ state: "off", origin: "set" });
    // Admission reads. A run never writes the posture it just read — not to arm it, and
    // not to "confirm" it.
    expect(relay.published.length).toBe(written);
  });

  it("runs when the switch says so", async () => {
    const { config, seed } = await setup();
    await seed("on");

    const admission = await admitJob(
      job("closed"),
      { trigger: "schedule" },
      engramSwitchSource(config),
    );
    expect(admission).toMatchObject({ admitted: true, bypassedSwitch: false });
    expect(admission.switch).toEqual({ state: "on", origin: "set" });
  });

  it("calls an untouched key never-set, which is not the same as off", async () => {
    const { config } = await setup();

    expect(await engramSwitchSource(config)(KEY)).toEqual({ origin: "never-set" });
    // The fleet's incident, structurally: a fail-closed job sat unset for four days and
    // read as though a human had parked it.
    expect(
      (await admitJob(job("closed"), { trigger: "schedule" }, engramSwitchSource(config)))
        .switch,
    ).toEqual({ state: "off", origin: "never-set" });
  });

  it("calls a tombstoned key never-set too — a deleted value is no value", async () => {
    const { config, seed } = await setup();
    await seed("on");
    const store = new EngramStore({ ...config, owner: config.owner!, signer: config.signer! });
    stores.push(store);
    await store.remove(KEY);

    expect(await engramSwitchSource(config)(KEY)).toEqual({ origin: "never-set" });
  });
});

describe("classification runs the safe way round", () => {
  it("reports a relay that accepts the REQ and then says nothing as a timeout", async () => {
    const { config } = await setup({ withholdEose: true });

    expect(await engramSwitchSource(config)(KEY)).toEqual({
      origin: "unreadable",
      failure: "timeout",
    });
  });

  it("reports a relay that is not there as unreachable", async () => {
    const { relay, config } = await setup();
    await relay.stop();
    relays.splice(relays.indexOf(relay), 1);

    expect(await engramSwitchSource(config)(KEY)).toEqual({
      origin: "unreadable",
      failure: "unreachable",
    });
  });

  it("reports a refused AUTH as auth-failed — an unseeded key is not an outage", async () => {
    const { config } = await setup({ rejectAuth: true });

    expect(await engramSwitchSource(config)(KEY)).toEqual({
      origin: "unreadable",
      failure: "auth-failed",
    });
  });

  it("reports a read that never reached a key as no-owner, never as never-set", async () => {
    // The fleet-wide misconfiguration this class exists for: every read and write failed
    // at once, so no fail-closed job could be armed, and it hid for weeks behind a
    // status that read normal.
    const { config } = await setup();

    for (const owner of [undefined, "", "not-a-pubkey"]) {
      expect(await engramSwitchSource({ ...config, owner })(KEY)).toEqual({
        origin: "unreadable",
        failure: "no-owner",
      });
    }
  });

  it("reports a missing signing key without opening a connection", async () => {
    const { relay, config } = await setup();

    expect(await engramSwitchSource({ ...config, signer: undefined })(KEY)).toEqual({
      origin: "unreadable",
      failure: "no-signing-key",
    });
    expect(relay.reqs).toEqual([]);
  });

  it("falls through to backend-error rather than inventing an answer", async () => {
    const { config } = await setup();

    // A key this transport cannot address at all. Unrecognized degrades to "we could not
    // read it", which is still distinguishable from "a human parked me".
    expect(await engramSwitchSource(config)("Not A Slug")).toEqual({
      origin: "unreadable",
      failure: "backend-error",
    });
  });
});
