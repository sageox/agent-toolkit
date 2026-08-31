#!/usr/bin/env node
// Convert a 64-character hex secret key to its nsec1… bech32 form.
//
//   node packages/adapter-buzz/scripts/hex-to-nsec.mjs <hex>
//   echo <hex> | node packages/adapter-buzz/scripts/hex-to-nsec.mjs
//
// Lives under adapter-buzz because that is where nostr-tools resolves.
import { readFileSync } from "node:fs";
import { nip19 } from "nostr-tools";

const hex = (process.argv[2] ?? readFileSync(0, "utf8")).trim().replace(/^0x/, "");

if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
  // Never echo the input back — it is key material.
  console.error("expected a 64-character hex secret key");
  process.exit(1);
}

console.log(nip19.nsecEncode(Uint8Array.from(Buffer.from(hex, "hex"))));
