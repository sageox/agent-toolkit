import { Relay } from "nostr-tools/relay";
import type { EventTemplate } from "nostr-tools/pure";
import type { Signer } from "nostr-tools/signer";

export interface ConnectResult {
  relay: Relay;
  /** True when the relay issued a NIP-42 challenge and accepted our answer. */
  authenticated: boolean;
  /**
   * Why a challenge we answered did not end in authentication — the relay's own words
   * where it gave any, its refusal without them, or the timeout waiting for a verdict.
   *
   * Never the empty string. `OK <id> false ""` is a refusal like any other, and a reason
   * that reads as absent would make every `if (authRefusal)` in the toolkit miss it.
   */
  authRefusal?: string;
}

/**
 * Connects, and finishes NIP-42 **before** the caller subscribes.
 *
 * The challenge arrives after `connect()` resolves, so subscribing straight away races
 * it: an auth-required relay rejects the `REQ` and answers with a NOTICE, and the agent
 * then sits there authenticated and deaf. That failure is invisible — it looks exactly
 * like a quiet channel — so the ordering has to be enforced here rather than left to
 * each caller.
 *
 * The challenge is answered from here rather than through `relay.onauth`. Setting
 * `onauth` makes nostr-tools 2.25.0 run `this.auth(this.onauth).catch(err => { throw
 * err })` from its message loop, so a relay that answers the signed AUTH with `OK false`
 * — what a restricted relay tells a key it does not list — rejects a promise the library
 * never returns. No caller can attach a handler to it and the process exits. Calling
 * `auth()` here puts that rejection on a promise this function awaits, which is also
 * what lets a refusal be reported rather than merely survived.
 *
 * Relays that never challenge are not penalised: the wait ends after a short grace.
 *
 * `connectTimeoutMs` bounds the wait for the socket. nostr-tools arms a connection timeout
 * only when one is passed, so without it a relay that accepts the TCP connection and never
 * completes the WebSocket upgrade leaves `connect()` pending forever — and a caller whose
 * failure is meant to be non-fatal never gets a failure to handle. Omitted, the wait is
 * unbounded, which is what a caller that has nothing to do until the relay answers wants.
 */
const AUTH_GRACE_MS = 1500;

/** NIP-01 framing of the challenge: `["AUTH", "<challenge>"]`. */
const AUTH_FRAME = /^\s*\[\s*"AUTH"/;

export async function connectAuthenticated(
  relayUrl: string,
  signer: Signer,
  opts: {
    enableReconnect?: boolean;
    connectTimeoutMs?: number;
    /**
     * Called after a **reconnect's** challenge is answered, never after the first.
     *
     * A caller holding subscriptions has to re-open them here; see the note on the
     * challenge hook below for why the ones it already had are gone.
     */
    onReauthenticated?: () => void;
  } = {},
): Promise<ConnectResult> {
  const relay = new Relay(relayUrl, {
    enableReconnect: opts.enableReconnect ?? false,
    enablePing: true,
  });

  let answering: Promise<Omit<ConnectResult, "relay">> | undefined;
  let onChallenge: () => void = () => {};
  const challenged = new Promise<void>((resolve) => {
    onChallenge = resolve;
  });

  const answer = async (): Promise<Omit<ConnectResult, "relay">> => {
    try {
      await relay.auth((evt: EventTemplate) => signer.signEvent(evt));
      return { authenticated: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { authenticated: false, authRefusal: reason || "the relay gave no reason" };
    }
  };

  // Answers every challenge, including the one that follows a reconnect: `connect()`
  // clears the relay's memoised auth, so a reconnected socket is unauthenticated again.
  // Delivery has to come first — `auth()` reads the challenge the library records here,
  // and reads it synchronously.
  let challenges = 0;
  const deliver = relay._onmessage.bind(relay);
  relay._onmessage = (ev) => {
    deliver(ev);
    if (typeof ev.data === "string" && AUTH_FRAME.test(ev.data)) {
      const answered = answer();
      answering = answered;
      if (++challenges === 1) {
        onChallenge();
        return;
      }
      // Every later challenge belongs to a reconnect, and by the time it arrives the
      // caller's subscriptions are already gone: nostr-tools 2.25.0 re-fires them from
      // `ws.onopen` (relay.js `for (const sub of this.openSubs.values()) sub.fire()`),
      // which necessarily runs before any frame from the relay — so an auth-required
      // relay refuses each REQ with `auth-required: authenticate before subscribing`
      // and answers CLOSED, which drops it from `openSubs`. Nothing in the library
      // re-opens them, so the agent re-authenticates and then hears nothing at all,
      // looking healthy the whole time. Only a caller that re-subscribes recovers.
      void answered.then((result) => {
        if (result.authenticated) opts.onReauthenticated?.();
      });
    }
  };

  await relay.connect(opts.connectTimeoutMs ? { timeout: opts.connectTimeoutMs } : undefined);
  await Promise.race([challenged, delay(AUTH_GRACE_MS)]);

  // The grace bounds only whether a challenge arrives. Once one has, the answer is on the
  // wire and the caller must not subscribe until the relay has ruled on it; nostr-tools
  // bounds that wait with its own publish timeout.
  return { relay, ...(answering ? await answering : { authenticated: false }) };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
