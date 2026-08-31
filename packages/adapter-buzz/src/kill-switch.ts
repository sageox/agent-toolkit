import {
  errorText,
  interpretSwitchValue,
  type SwitchFailure,
  type SwitchSource,
} from "@sageox/agent-toolkit-core";

import { EngramStore } from "./engram.ts";
import type { EngramSigner } from "./identity.ts";

export interface EngramSwitchConfig {
  relayUrl: string;
  /** The engram owner the agent's memory is addressed to — `brains[].owner`. */
  owner: string | undefined;
  /** The agent's own signing key. Absent on a deployment that never seeded one. */
  signer: EngramSigner | undefined;
  /** Overrides the store's own query deadline where relay latency needs longer. */
  queryTimeoutMs?: number;
}

/**
 * A job's kill switch, read out of the agent's own private memory.
 *
 * No new transport: this is the NIP-AE store the private brain already runs, called with
 * one key. That is the whole remote half of the switch — flip an engram, and the next tick
 * does not run, with no deploy and nothing in a channel able to reach it. The chat-side
 * switch stays what it is, a programmatic `stopServing`.
 *
 * A connection per read, closed on the way out. A job tick spawns a whole child process,
 * so one relay round trip is noise, and a host with no shutdown path of its own cannot
 * leak a socket it never holds.
 *
 * Nothing here throws: every way this can fail is one of the switch's failure classes, and
 * a caller that had to catch would be one missed `catch` away from reading a failure as
 * "nobody ever set this".
 */
export function engramSwitchSource(config: EngramSwitchConfig): SwitchSource {
  return async (key) => {
    // Checked before the read rather than classified after it: neither of these ever
    // reached a key, so neither is evidence about one.
    if (!config.signer) return { origin: "unreadable", failure: "no-signing-key" };
    let store: EngramStore;
    try {
      store = new EngramStore({
        relayUrl: config.relayUrl,
        // The store's own constructor is the validator; an unset owner reaches it as a
        // value it refuses, rather than as an assertion that it is a pubkey.
        owner: config.owner ?? "",
        signer: config.signer,
        queryTimeoutMs: config.queryTimeoutMs,
      });
    } catch {
      return { origin: "unreadable", failure: "no-owner" };
    }

    try {
      const entry = await store.read(key);
      // Absent and tombstoned are both "no value at this key" — the one documented
      // not-found answer, and the only one that may read as never-set.
      return entry ? interpretSwitchValue(entry.value) : { origin: "never-set" };
    } catch (error) {
      return { origin: "unreadable", failure: classifyEngramFailure(error) };
    } finally {
      store.close();
    }
  };
}

/**
 * The store's failure vocabulary, mapped onto the switch's.
 *
 * Runs the safe way round: anything unrecognized falls through to `backend-error`, so a
 * reworded message degrades to "we could not read it" — still distinguishable from "a
 * human parked me", which was the whole point — rather than to a lie. Auth is matched
 * first because an auth-refused subscription arrives as a closed query, and a human sent
 * to wait out an outage will not find the unseeded key.
 */
function classifyEngramFailure(error: unknown): SwitchFailure {
  const message = errorText(error);
  if (/auth/i.test(message)) return "auth-failed";
  if (/timed out/i.test(message)) return "timeout";
  if (/query closed|connect|websocket|socket|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return "unreachable";
  }
  return "backend-error";
}
