import { nip19 } from "nostr-tools";
import { getConversationKey } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { PlainKeySigner, type Signer } from "nostr-tools/signer";
import { resolveSecret } from "@sageox/agent-toolkit-core";

export interface Keypair {
  /** The signing key. Belongs in a secret store, never in the manifest. */
  nsec: string;
  /** The public identity to register with the relay and add to channels. */
  npub: string;
  hex: string;
}

/**
 * A signer that can also derive the NIP-44 conversation key used by NIP-AE.
 *
 * Signing alone is deliberately not enough: an engram's private `d` address is an HMAC
 * over this key. A future remote signer therefore needs an explicit equivalent operation;
 * pretending an ordinary `Signer` can serve private memory would produce records it can
 * sign but can neither address nor retrieve.
 */
export interface EngramSigner extends Signer {
  conversationKey(pubkey: string): Promise<Uint8Array>;
}

class PlainEngramSigner implements EngramSigner {
  private signer: PlainKeySigner;

  constructor(private secretKey: Uint8Array) {
    this.signer = new PlainKeySigner(secretKey);
  }

  getPublicKey(): Promise<string> {
    return this.signer.getPublicKey();
  }

  signEvent(event: Parameters<Signer["signEvent"]>[0]) {
    return this.signer.signEvent(event);
  }

  async conversationKey(pubkey: string): Promise<Uint8Array> {
    return getConversationKey(this.secretKey, pubkey);
  }
}

export function generateKeypair(): Keypair {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { nsec: nip19.nsecEncode(sk), npub: nip19.npubEncode(pk), hex: pk };
}

/**
 * Normalises a public key to hex.
 *
 * Nostr events carry hex pubkeys, so that is what the author gate compares against. A
 * config written with an `npub` would match nothing and the agent would silently ignore
 * its own owner — so accept both spellings and convert.
 */
export function toHexPubkey(value: string): string {
  if (value.startsWith("npub")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") throw new Error(`expected an npub, got ${decoded.type}`);
    return decoded.data;
  }
  // Anything else must already be a hex pubkey. Validating rather than passing it
  // through is what stops a secret key, or a typo, from being accepted as an identity.
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      value.startsWith("nsec")
        ? "that is a secret key; a public key (npub… or hex) is required here"
        : `"${value.slice(0, 12)}…" is not a public key (expected npub… or 64-char hex)`,
    );
  }
  return value.toLowerCase();
}

/** The npub for an existing secret, so bring-up can report the identity already in use. */
export function npubFor(secret: string): string {
  const key = secret.startsWith("nsec")
    ? (nip19.decode(secret).data as Uint8Array)
    : new Uint8Array(Buffer.from(secret, "hex"));
  return nip19.npubEncode(getPublicKey(key));
}

/**
 * Resolves a manifest `identity: <secretRef>` into a signer.
 *
 * The reference is logical — file-first, env-fallback — so the same manifest runs
 * against `.env` locally and a mounted secret in production without editing.
 *
 * Returning a `Signer` rather than a key is what keeps NIP-46 a drop-in: swap this for
 * a `BunkerSigner` and the private key never enters the gateway at all.
 */
export async function resolveBuzzSigner(
  ref: string,
  opts: { dir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EngramSigner> {
  const raw = resolveSecret(ref, opts);
  if (!raw) {
    throw new Error(`secretRef ${ref} did not resolve to a value (checked file, then env)`);
  }
  return new PlainEngramSigner(decodeSecretKey(raw.trim(), ref));
}

/** Accepts `nsec1…` or 64-char hex. Errors never carry the key material. */
function decodeSecretKey(value: string, ref: string): Uint8Array {
  if (value.startsWith("nsec")) {
    let decoded;
    try {
      decoded = nip19.decode(value);
    } catch {
      throw new Error(`secretRef ${ref} is not a decodable nsec`);
    }
    if (decoded.type !== "nsec") {
      throw new Error(`secretRef ${ref} decoded to ${decoded.type}, expected an nsec`);
    }
    return decoded.data;
  }

  if (value.startsWith("npub")) {
    throw new Error(`secretRef ${ref} is a public key; an nsec is required for signing`);
  }

  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`secretRef ${ref} is neither an nsec nor a 64-character hex key`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}
