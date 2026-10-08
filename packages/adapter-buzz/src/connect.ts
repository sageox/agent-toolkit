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

/**
 * The NIP-OA owner-attestation tag from `BUZZ_AUTH_TAG`, or `undefined`.
 *
 * A public `["auth", <owner_pubkey_hex>, <conditions>, <sig_hex>]` tag the owner
 * mints with their secret (the tag itself carries no secret). When present it is
 * appended to the NIP-42 AUTH event below, so the relay materializes the agent's
 * owner on authentication and clients render "managed by \<owner\>" instead of
 * "owner unavailable". This mirrors the Rust harness's `send_auth_response`
 * (block/buzz `crates/buzz-acp/src/relay.rs`), which the TS runtime never ported.
 *
 * A missing, empty, or malformed value is ignored, not fatal — the relay is the
 * authority on the signature, so shape validation here only avoids sending an
 * obviously-broken tag. The agent simply stays unattested.
 */
export function ownerAuthTag(raw: string | undefined = process.env.BUZZ_AUTH_TAG): string[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((x) => typeof x === "string")) {
    return undefined;
  }
  const [label, owner, , sig] = parsed as string[];
  if (label !== "auth" || !/^[0-9a-f]{64}$/.test(owner) || !/^[0-9a-f]{128}$/.test(sig)) {
    return undefined;
  }
  return parsed as string[];
}

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

  const authTag = ownerAuthTag();

  const answer = async (): Promise<Omit<ConnectResult, "relay">> => {
    try {
      await relay.auth((evt: EventTemplate) =>
        // nostr-tools builds the kind-22242 AUTH event with `relay` + `challenge`
        // tags; the NIP-OA owner tag rides alongside them, exactly as the relay's
        // membership-delegation fallback expects. Copy rather than mutate the
        // template the library handed us.
        signer.signEvent(authTag ? { ...evt, tags: [...evt.tags, authTag] } : evt),
      );
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
