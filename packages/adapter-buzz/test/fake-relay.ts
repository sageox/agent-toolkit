import { WebSocketServer, type WebSocket } from "ws";
import type { Event } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";

export interface ReqRecord {
  subId: string;
  filters: Array<Record<string, unknown>>;
}

interface OpenSub extends ReqRecord {
  ws: WebSocket;
}

/**
 * An in-process Nostr relay that speaks enough NIP-01 + NIP-42 to exercise the adapter
 * against real protocol framing: REQ/EVENT/EOSE/CLOSE, AUTH challenge, and OK.
 */
export class FakeRelay {
  private wss: WebSocketServer;
  private sockets = new Set<WebSocket>();
  /** Every REQ the adapter sent — the `since` cursor assertions read this. */
  readonly reqs: ReqRecord[] = [];
  /** The REQs still open, with the socket to push to. `emit` routes on these. */
  private openSubs: OpenSub[] = [];
  /** Every event the adapter published. */
  readonly published: Event[] = [];
  /** Every signed AUTH event, in order — a reconnected socket is challenged again. */
  readonly authEvents: Event[] = [];
  /** Stored events replayed on REQ, subject to the filter's `since`. Mutable mid-test. */
  readonly backlog: Event[] = [];

  /** The most recent signed AUTH event, once the adapter answers a challenge. */
  get authEvent(): Event | undefined {
    return this.authEvents.at(-1);
  }

  private constructor(
    wss: WebSocketServer,
    readonly url: string,
    private opts: {
      requireAuth: boolean;
      notice?: string;
      withholdEose?: boolean;
      rejectAuth?: boolean;
      rejectAuthReason?: string;
      slowDirectoryMs?: number;
      refuseDirectory?: boolean;
    },
  ) {
    this.wss = wss;
    wss.on("connection", (ws) => this.onConnection(ws));
  }

  static async start(
    opts: {
      requireAuth?: boolean;
      backlog?: Event[];
      notice?: string;
      /** Accept the REQ and then say nothing at all — no EVENT, no EOSE, no CLOSED. */
      withholdEose?: boolean;
      /** Answer a correctly signed AUTH with a refusal — an unseeded or unlisted key. */
      rejectAuth?: boolean;
      /** The refusal's reason. `""` is protocol-legal, and relays do send it. */
      rejectAuthReason?: string;
      /**
       * Answer a directory (kind 10100) REQ only after this long, so a channel REQ opened
       * beside it is answered first — the interleaving a real relay is free to produce.
       */
      slowDirectoryMs?: number;
      /** Close a directory REQ unanswered — a relay whose conventions do not include one. */
      refuseDirectory?: boolean;
    } = {},
  ): Promise<FakeRelay> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const { port } = wss.address() as { port: number };
    const relay = new FakeRelay(wss, `ws://127.0.0.1:${port}`, {
      requireAuth: opts.requireAuth ?? false,
      notice: opts.notice,
      withholdEose: opts.withholdEose,
      rejectAuth: opts.rejectAuth,
      rejectAuthReason: opts.rejectAuthReason,
      slowDirectoryMs: opts.slowDirectoryMs,
      refuseDirectory: opts.refuseDirectory,
    });
    relay.backlog.push(...(opts.backlog ?? []));
    return relay;
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    // Real auth-required relays refuse REQ until the client has authenticated, which is
    // what makes a subscribe-before-auth race show up as silence rather than an error.
    let authed = !this.opts.requireAuth;
    ws.on("close", () => {
      this.sockets.delete(ws);
      this.openSubs = this.openSubs.filter((sub) => sub.ws !== ws);
    });
    if (this.opts.requireAuth) ws.send(JSON.stringify(["AUTH", "challenge-token"]));
    if (this.opts.notice) ws.send(JSON.stringify(["NOTICE", this.opts.notice]));

    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as unknown[];
      const verb = msg[0];

      if (verb === "AUTH") {
        const event = msg[1] as Event;
        this.authEvents.push(event);
        // `OK false` with a reason is how a relay answers a signature it can verify but a
        // pubkey it does not list.
        authed = !this.opts.rejectAuth && verifyEvent(event);
        ws.send(
          JSON.stringify([
            "OK",
            event.id,
            authed,
            this.opts.rejectAuth
              ? (this.opts.rejectAuthReason ?? "restricted: this key may not read here")
              : "",
          ]),
        );
        return;
      }

      if (verb === "REQ") {
        const subId = msg[1] as string;
        if (!authed) {
          ws.send(JSON.stringify(["NOTICE", "auth-required: authenticate before subscribing"]));
          ws.send(JSON.stringify(["CLOSED", subId, "auth-required"]));
          return;
        }
        const filters = msg.slice(2) as Array<Record<string, unknown>>;
        this.reqs.push({ subId, filters });
        this.openSubs.push({ subId, filters, ws });
        // A relay that takes the REQ and then goes quiet: the client is left holding an
        // open subscription that will never terminate itself.
        if (this.opts.withholdEose) return;
        // Replay anything in the backlog admitted by at least one NIP-01 filter.
        const answer = () => {
          if (ws.readyState !== ws.OPEN) return;
          for (const e of this.backlog) {
            if (filters.some((filter) => matchesFilter(e, filter))) {
              ws.send(JSON.stringify(["EVENT", subId, e]));
            }
          }
          ws.send(JSON.stringify(["EOSE", subId]));
        };
        const directory = filters.some((filter) =>
          Array.isArray(filter.kinds) && (filter.kinds as number[]).includes(10100),
        );
        if (directory && this.opts.refuseDirectory) {
          this.openSubs = this.openSubs.filter((sub) => sub.subId !== subId);
          ws.send(JSON.stringify(["CLOSED", subId, "unsupported: kind 10100"]));
          return;
        }
        if (directory && this.opts.slowDirectoryMs) setTimeout(answer, this.opts.slowDirectoryMs);
        else answer();
        return;
      }

      if (verb === "EVENT") {
        const event = msg[1] as Event;
        this.published.push(event);
        // Addressable writes are immediately queryable by clients verifying the new head.
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (d) {
          const replaced = this.backlog.findIndex(
            (old) =>
              old.kind === event.kind &&
              old.pubkey === event.pubkey &&
              old.tags.find((tag) => tag[0] === "d")?.[1] === d,
          );
          if (replaced >= 0) this.backlog.splice(replaced, 1);
        }
        this.backlog.push(event);
        ws.send(JSON.stringify(["OK", event.id, verifyEvent(event), ""]));
        return;
      }

      if (verb === "CLOSE") {
        this.openSubs = this.openSubs.filter((sub) => sub.subId !== msg[1]);
        ws.send(JSON.stringify(["CLOSED", msg[1], "closed by client"]));
      }
    });
  }

  /**
   * Pushes a live event to every open subscription whose filters admit it — the routing
   * a client relies on once it holds more than one REQ, since nostr-tools drops an EVENT
   * that does not match the subscription id it arrived under.
   */
  emit(event: Event): void {
    for (const sub of this.openSubs) {
      if (sub.filters.some((filter) => matchesFilter(event, filter))) {
        sub.ws.send(JSON.stringify(["EVENT", sub.subId, event]));
      }
    }
  }

  /** Drops all connections without shutting the relay down, to exercise reconnect. */
  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    this.openSubs = [];
  }

  async stop(): Promise<void> {
    this.openSubs = [];
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function matchesFilter(event: Event, filter: Record<string, unknown>): boolean {
  if (event.created_at < Number(filter.since ?? 0)) return false;
  if (Array.isArray(filter.kinds) && !(filter.kinds as number[]).includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && !(filter.authors as string[]).includes(event.pubkey)) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const tag = key.slice(1);
    if (!event.tags.some((entry) => entry[0] === tag && (values as string[]).includes(entry[1]))) {
      return false;
    }
  }
  return true;
}
