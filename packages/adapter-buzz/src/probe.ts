import { Relay } from "nostr-tools/relay";
import type { Event, VerifiedEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { connectAuthenticated } from "./connect.ts";
import { resolveBuzzSigner } from "./identity.ts";
import { BUZZ_DEFAULTS } from "./normalize.ts";

export type AuthState =
  /** The relay challenged us and accepted the answer we signed. */
  | "authenticated"
  /** The relay verified the signature and still would not serve this key. */
  | "refused"
  /** The relay wants auth and we had no key to answer with. */
  | "required-no-identity"
  /** The relay never asked. */
  | "not-required";

export interface QueryResult {
  label: string;
  events: number;
  /** End-of-stored-events: proof the relay accepted and answered the query. */
  eose: boolean;
  closed?: string;
}

export interface ProbeReport {
  auth: AuthState;
  /** The relay's stated reason, when `auth` is `refused` — usually names the allowlist. */
  authRefusal?: string;
  /** NOTICE lines from the relay — usually the reason a subscription returned nothing. */
  notices: string[];
  queries: QueryResult[];
  events: number;
  kinds: Record<number, number>;
  tagNames: Record<string, number>;
  matchingPinnedKind: number;
  mentionsOfMe: number;
  channelsSeen: string[];
}

/**
 * Reads a relay and reports what is actually there.
 *
 * Runs several narrow queries rather than one broad one, because "nothing came back" has
 * several very different causes that a single filterless `REQ` cannot tell apart: the
 * relay may refuse an unfiltered query, may hold nothing, or may hold plenty and serve
 * none of it to a pubkey it does not recognise. **EOSE is the discriminator** — receiving
 * it means the query was accepted and answered, so zero events is a real answer rather
 * than a dropped request.
 *
 * Read-only: it subscribes and never publishes.
 */
export async function probeRelay(opts: {
  relayUrl: string;
  identityRef?: string;
  secretsDir?: string;
  seconds?: number;
}): Promise<ProbeReport> {
  const report: ProbeReport = {
    auth: "not-required",
    notices: [],
    queries: [],
    events: 0,
    kinds: {},
    tagNames: {},
    matchingPinnedKind: 0,
    mentionsOfMe: 0,
    channelsSeen: [],
  };

  let pubkey: string | undefined;
  let relay: Relay;

  if (opts.identityRef) {
    const signer = await resolveBuzzSigner(opts.identityRef, { dir: opts.secretsDir });
    pubkey = await signer.getPublicKey();
    const result = await connectAuthenticated(opts.relayUrl, signer);
    relay = result.relay;
    if (result.authenticated) report.auth = "authenticated";
    else if (result.authRefusal) {
      report.auth = "refused";
      report.authRefusal = result.authRefusal;
    }
  } else {
    relay = new Relay(opts.relayUrl, { enableReconnect: false, enablePing: true });
    // Record the challenge even though we cannot answer it: "the relay asked and we had
    // no key" is a completely different diagnosis from "the relay never asked".
    relay.onauth = async (): Promise<VerifiedEvent> => {
      report.auth = "required-no-identity";
      throw new Error("no identity available to answer the AUTH challenge");
    };
    await relay.connect();
  }

  relay.onnotice = (msg: string) => report.notices.push(msg);

  const queries: Array<{ label: string; filter: Filter }> = [
    { label: "anything at all", filter: { limit: 50 } },
    { label: "profiles (kind 0)", filter: { kinds: [0], limit: 10 } },
    { label: "notes (kind 1)", filter: { kinds: [1], limit: 10 } },
    {
      label: `chat (kind ${BUZZ_DEFAULTS.kind})`,
      filter: { kinds: [BUZZ_DEFAULTS.kind], limit: 20 },
    },
  ];
  if (pubkey) {
    queries.push({ label: "mentions of you", filter: { "#p": [pubkey], limit: 20 } });
    queries.push({ label: "your own events", filter: { authors: [pubkey], limit: 10 } });
  }

  const channels = new Set<string>();
  // Queries overlap — a kind-9 event matches both "anything at all" and "chat" — so
  // tally each event once or every count is inflated.
  const counted = new Set<string>();
  const perQuery = Math.max(500, Math.floor(((opts.seconds ?? 10) * 1000) / queries.length));

  for (const { label, filter } of queries) {
    const result: QueryResult = { label, events: 0, eose: false };

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, perQuery);

      const sub = relay.subscribe([filter], {
        onevent: (event: Event) => {
          result.events++;
          if (counted.has(event.id)) return;
          counted.add(event.id);

          report.events++;
          report.kinds[event.kind] = (report.kinds[event.kind] ?? 0) + 1;
          if (event.kind === BUZZ_DEFAULTS.kind) report.matchingPinnedKind++;
          for (const tag of event.tags) {
            const name = tag[0];
            report.tagNames[name] = (report.tagNames[name] ?? 0) + 1;
            if (name === BUZZ_DEFAULTS.channelTag && tag[1]) channels.add(tag[1]);
            if (pubkey && name === BUZZ_DEFAULTS.mentionTag && tag[1] === pubkey)
              report.mentionsOfMe++;
          }
        },
        oneose: () => {
          result.eose = true;
          sub.close();
          finish();
        },
        onclose: (reason: string) => {
          result.closed = reason;
          finish();
        },
      });
    });

    report.queries.push(result);
  }

  relay.close();

  // Some relays announce the requirement by NOTICE rather than by challenging.
  if (report.auth === "not-required" && report.notices.some((n) => /auth[- ]?required/i.test(n))) {
    report.auth = "required-no-identity";
  }
  report.channelsSeen = [...channels];
  return report;
}
