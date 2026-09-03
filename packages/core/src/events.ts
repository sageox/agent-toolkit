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
  /**
   * The name people use for this id, when the surface was asked and put one to it.
   *
   * Presentation only, and absent on the author of a message: nothing on the inbound path
   * looks a name up, and `SurfaceAdapter.displayName` is how one is rendered there. Filled
   * by the reads that do ask — `listMembers` and `describeActor` — because a roster of
   * bare ids answers nobody's question about who is in a channel.
   */
  name?: string;
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
 * What one channel read found, and whether it is the whole of what was asked for.
 *
 * A bare array cannot carry the second half, and the second half is a different fact about
 * the world: a read that returns twelve of twenty because the channel holds twelve, and one
 * that returns twelve because it stopped walking, are the same value and opposite findings.
 * The first is a quiet channel. The second is not, and a caller that reports it as one is
 * wrong in the direction this whole seam exists to prevent.
 *
 * Refusing instead was tried and is worse: a surface may serve as few as fifteen records a
 * page, so "short of what you asked for" is the ordinary case there rather than the
 * exceptional one, and throwing on it fails ordinary reads of ordinary channels.
 */
export interface ChannelHistory {
  /** Oldest first, at most the `limit` asked for. */
  messages: readonly ThreadReply[];
  /**
   * History the read did not reach, and could have.
   *
   * `true` only when the read came back short of `limit` **and** the surface was still
   * offering more — so these messages are the recent end of what was read rather than the
   * recent end of the channel. Never `true` when the channel itself ran out, which is the
   * one short answer that is a complete one.
   */
  more: boolean;
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
