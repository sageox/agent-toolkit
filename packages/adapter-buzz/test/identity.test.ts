import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { resolveBuzzSigner, toHexPubkey } from "../src/identity.ts";

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const nsec = nip19.nsecEncode(sk);
const hex = Buffer.from(sk).toString("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buzz-id-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveBuzzSigner", () => {
  it("loads an nsec from a mounted secret file", async () => {
    writeFileSync(join(dir, "BUZZ_NSEC"), `${nsec}\n`);
    const signer = await resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} });
    expect(await signer.getPublicKey()).toBe(pk);
  });

  it("accepts a raw hex key too", async () => {
    writeFileSync(join(dir, "BUZZ_NSEC"), hex);
    const signer = await resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} });
    expect(await signer.getPublicKey()).toBe(pk);
  });

  it("falls back to env when no file is mounted", async () => {
    const signer = await resolveBuzzSigner("BUZZ_NSEC", { dir, env: { BUZZ_NSEC: nsec } });
    expect(await signer.getPublicKey()).toBe(pk);
  });

  it("refuses to start when the secret is missing, naming the ref", async () => {
    await expect(resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} })).rejects.toThrow(/BUZZ_NSEC/);
  });

  it("refuses a malformed key rather than starting with a broken identity", async () => {
    writeFileSync(join(dir, "BUZZ_NSEC"), "not-a-key");
    await expect(resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} })).rejects.toThrow();
  });

  it("never puts the key material in the error message", async () => {
    writeFileSync(join(dir, "BUZZ_NSEC"), `${nsec}garbage`);
    const err = await resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} }).catch((e: Error) => e);
    expect(String(err)).not.toContain(nsec);
    expect(String(err)).not.toContain(hex);
  });

  it("rejects a public key given where a secret key belongs", async () => {
    writeFileSync(join(dir, "BUZZ_NSEC"), nip19.npubEncode(pk));
    await expect(resolveBuzzSigner("BUZZ_NSEC", { dir, env: {} })).rejects.toThrow(/nsec/i);
  });
});

describe("toHexPubkey", () => {
  it("converts an npub to the hex the author gate compares against", () => {
    expect(toHexPubkey(nip19.npubEncode(pk))).toBe(pk);
  });
  it("passes hex through unchanged", () => {
    expect(toHexPubkey(pk)).toBe(pk);
  });
  it("refuses an nsec given where a public key belongs", () => {
    expect(() => toHexPubkey(nsec)).toThrow();
  });
});
