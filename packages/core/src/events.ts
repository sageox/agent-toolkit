/** Opaque, surface-qualified reference. Never compare across surfaces. */
export interface EventRef {
  surface: string;
  nativeId: string;
}

export interface ChannelRef {
  surface: string;
  id: string;
  isPublic: boolean;
  /**
   * What humans call this channel, when the surface has a name distinct from the id.
   *
   * Presentation only — every guard decision is made on `id`. It exists because a person
   * asking for a cross-post says "post that in hive", not the channel's uuid, and a tool
   * that only advertises ids gives the brain nothing to match that against.
   */
  name?: string;
}

export interface ActorRef {
  surface: string;
  id: string;
  /**
   * This message is the agent's own.
   *
   * Distinct from `isAgent`: an agent must never wake on its own posts (§8), which is a
   * different rule from how deep an agent-to-agent chain may go.
   */
  isSelf: boolean;
  /** Another autonomous agent — subject to the chain-depth cap. */
  isAgent: boolean;
}

export interface InboundEvent {
  id: EventRef;
  surface: string;
  channel: ChannelRef;
  author: ActorRef;
  text: string;
  /** The ONLY wake trigger. */
  mentionsMe: boolean;
  threadRoot?: EventRef;
  /** ISO-8601. */
  ts: string;
  /** Escape hatch for adapters. Core logic must NOT read this. */
  raw: unknown;
}

/** What the brain asks to send; the guard validates it before an adapter sends. */
export interface GuardedMessage {
  text: string;
  // threading is the adapter's call; attachments/urls/bulk-mentions are absent in v1
}

/**
 * One reply beneath a thread root, as an adapter read it back off its surface.
 *
 * Deliberately not an {@link InboundEvent}: nothing here woke the agent, nothing here was
 * addressed to it, and there is no `mentionsMe` to be true. What a reader of a thread it
 * rooted wants is who spoke, what they said, and when — and giving it the inbound shape
 * would invite a caller to treat a line it went looking for as a message that arrived.
 */
export interface ThreadReply {
  author: ActorRef;
  /**
   * Verbatim, and **UNTRUSTED**. Whatever anyone put in the channel, including an
   * instruction addressed to whoever reads it. Code that tallies replies is safe; text
   * from here must never be spliced into a prompt or a command.
   */
  text: string;
  /** ISO-8601, matching {@link InboundEvent.ts}. */
  ts: string;
}
