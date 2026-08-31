import { toHexPubkey } from "@sageox/agent-toolkit-adapter-buzz";

/**
 * Puts an author ID into the spelling its own surface's events use.
 *
 * One agent answers on every surface it declares, so `owner` and `allowlist` hold ids
 * from more than one namespace at once. Only Nostr identities have two spellings, so
 * they are the only ones rewritten: Buzz events carry hex, and a config written with an
 * npub would match nobody. Everything else is returned untouched — a Slack `U…` member
 * id is already what its events carry, and rewriting it was what made `owner-only` on
 * Slack fail at load.
 *
 * An `nsec` still goes through `toHexPubkey` so that pasting a secret key where a public
 * one belongs stays a loud error rather than an id that silently matches nobody.
 */
export function normalizeActorId(value: string): string {
  const nostrShaped =
    value.startsWith("npub") || value.startsWith("nsec") || /^[0-9a-f]{64}$/i.test(value);
  return nostrShaped ? toHexPubkey(value) : value;
}
