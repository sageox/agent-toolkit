import type { EventRef, InboundEvent } from "./events.ts";

/**
 * How long a link stays open after the post that made it.
 *
 * The same hour `TurnPolicy` remembers a thread: an answer to a question asked on a
 * conversation's behalf is worth bringing home for about as long as that conversation is
 * still one. After that a late reply belongs to the channel it was written in.
 */
export const LINK_TTL_MS = 60 * 60 * 1000;

/**
 * How many replies one link relays before it closes.
 *
 * A link carries what one addressed principal says under one root, so this bounds a
 * conversation and not a feed. Past twenty lines the exchange is one a person should open
 * where it is happening, and a link that never closed would be the mirror the design spec
 * (§8) refuses.
 */
export const MAX_RELAYED = 20;

/** A post made on behalf of a turn, and where its answers go. */
export interface Link {
  /** The post this agent made — the only thread whose replies come home. */
  root: EventRef;
  /** The message that asked: the surface, channel, and thread an answer returns to. */
  home: InboundEvent;
  /** The one principal the post addressed. Only their replies come home. */
  principal: string;
  until: number;
  remaining: number;
}

/**
 * The open links, keyed by the root each was posted under.
 *
 * Bounded so that it can never become a bridge: a link opens only from an addressed post
 * (`SurfaceEgress.address`), relays only the addressed principal's replies under that one
 * root, and closes on a count and a clock. Sweeping is amortised into the two ways in.
 */
export class Links {
  private byRoot = new Map<string, Link>();

  constructor(private now: () => number = Date.now) {}

  /** How many are open, so a test can prove they close. */
  size(): number {
    return this.byRoot.size;
  }

  open(root: EventRef, home: InboundEvent, principal: string): void {
    this.sweep();
    this.byRoot.set(key(root), {
      root,
      home,
      principal,
      until: this.now() + LINK_TTL_MS,
      remaining: MAX_RELAYED,
    });
  }

  /**
   * The link an event answers, spending one of its relays — or nothing.
   *
   * An answer is a reply under a linked root, from the principal that root addressed, and
   * not this agent's own: a relayed line is the agent's message, and one that came home
   * again would loop. The root is surface-qualified, so a reply on one surface can never
   * answer a root on another.
   */
  claim(event: InboundEvent): Link | undefined {
    this.sweep();
    if (!event.threadRoot || event.author.isSelf) return undefined;
    const link = this.byRoot.get(key(event.threadRoot));
    if (!link || link.principal !== event.author.id) return undefined;
    link.remaining -= 1;
    if (link.remaining <= 0) this.byRoot.delete(key(link.root));
    return link;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, link] of this.byRoot) if (link.until <= now) this.byRoot.delete(k);
  }
}

function key(ref: EventRef): string {
  return `${ref.surface}:${ref.nativeId}`;
}
