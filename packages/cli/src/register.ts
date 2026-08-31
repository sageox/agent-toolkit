import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { npubFor, toHexPubkey, type AgentDirectory } from "@sageox/agent-toolkit-adapter-buzz";
import { errorText, type AgentManifest } from "@sageox/agent-toolkit-core";
import { normalizeActorId } from "./identity.ts";

const run = promisify(execFile);

export interface BuzzChannel {
  channel_id: string;
  name: string;
  description?: string;
}

/** The fields of a Buzz surface a directory record is built from. */
export interface BuzzSurfaceChannels {
  channels?: readonly { id: string }[];
}

/**
 * The directory record one Buzz surface implies.
 *
 * Takes the surface rather than searching the manifest for it: a manifest may declare more
 * than one Buzz surface — the schema requires a single one only alongside a private brain —
 * and `doctor` checks each in turn. Searching here would give every surface the first one's
 * channels, so the second relay would be told the agent answers where it does not.
 *
 * `owner-only` becomes an allowlist of the owners rather than a mode of its own. That is
 * precisely what it means, and it is the vocabulary clients read; a mode they do not
 * recognise reads as "never mentionable", which would take the agent off the picker for
 * the very person it exists to answer.
 *
 * Principals are normalized here rather than left to the caller: Buzz events carry hex, so
 * an `npub` written to the record matches nobody reading it, and `doctor` — which loads the
 * manifest through its own normalizing reader — would compare the two spellings forever
 * without a re-registration ever reconciling them. `normalizeActorId` rewrites only
 * Nostr-shaped ids, so a Slack member id in the same list is left as its own events spell it.
 */
export function directoryFor(
  manifest: AgentManifest,
  surface: BuzzSurfaceChannels,
  name: string,
): AgentDirectory {
  const channelIds = [...new Set((surface.channels ?? []).map((channel) => channel.id))];
  const principals = (ids: string[] | undefined) => ids?.map(normalizeActorId);

  switch (manifest.respondTo) {
    case "owner-only":
      return { name, channelIds, respondTo: "allowlist", respondToAllowlist: principals(manifest.owner) };
    case "allowlist":
      return { name, channelIds, respondTo: "allowlist", respondToAllowlist: principals(manifest.allowlist) };
    default:
      return { name, channelIds, respondTo: manifest.respondTo };
  }
}

/**
 * How a published allowlist differs from the configured one, or undefined when it does not.
 *
 * Order is not meaningful, and an entry left behind matters as much as one never added: the
 * first authorizes a principal the config has dropped, the second locks out one it names.
 */
export function allowlistDrift(published: unknown, expected: string[] | undefined): string | undefined {
  const want = new Set(expected ?? []);
  const have = new Set(Array.isArray(published) ? published.map(String) : []);
  const missing = [...want].filter((id) => !have.has(id));
  const stale = [...have].filter((id) => !want.has(id));
  if (!missing.length && !stale.length) return undefined;

  return [
    missing.length ? `omits ${missing.join(", ")}` : "",
    stale.length ? `still authorizes ${stale.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

/**
 * Whether two spellings name the same relay.
 *
 * Registration takes the relay from `--relay` or a prompt while the surface it belongs to
 * was written separately, so the two reach `find` as independently typed strings. A
 * trailing slash or a capitalized host is not a different relay, and treating it as one
 * skips the surface and publishes no record. Scheme and host are case-insensitive; a path
 * is not.
 */
export function sameRelay(a: string, b: string): boolean {
  const normalize = (raw: string): string => {
    try {
      const url = new URL(raw);
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return raw.trim().replace(/\/+$/, "");
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * The `buzz` CLI's base URL, derived from the relay's websocket URL.
 *
 * The adapter talks `wss://`; the CLI wants the `https://` base of the same host. Asking
 * for both would be asking the same question twice.
 */
export function toHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

export interface BuzzCli {
  (args: string[], env: NodeJS.ProcessEnv): Promise<string>;
}

/**
 * The closed-relay denial that setup may defer until an admin admits the identity.
 *
 * The separators are loose because the refusal arrives in two registers: the relay's own
 * `403 relay_membership_required` code, forwarded verbatim by the `buzz` client, and the
 * prose a NIP-42 refusal carries. Matching only the prose is how a recognised denial
 * becomes an unrecognised one, and `create` re-asks the same question forever instead of
 * naming the grant.
 */
export function isRelayMembershipError(error: unknown): boolean {
  const message = errorText(error);
  return /not a relay member|must be a relay member|relay[\s_-]*membership[\s_-]*(?:is[\s_-]*)?required/i.test(
    message,
  );
}

/**
 * The agent key in the two spellings the grants take, or placeholders when it will not
 * decode.
 *
 * Decoding throws on a malformed nsec, and every caller is *reporting a different failure*
 * — a throw here replaces the membership handoff, or the whole `doctor` run, with a bech32
 * error and says nothing about the relay. `doctor`'s own fixture is a key that does not
 * decode, so this is a state that occurs.
 */
export function agentPubkeys(nsec: string): { npub: string; hex: string } {
  try {
    const npub = npubFor(nsec);
    return { npub, hex: toHexPubkey(npub) };
  } catch {
    return { npub: "<the agent npub>", hex: "<the agent pubkey, hex>" };
  }
}

/**
 * The channel-role grant, as a command that reaches the right relay with the right key.
 *
 * Both are spelled out because `buzz channels add-member` carries neither: the relay and
 * the signing key are global options, and an omitted `--relay` **defaults to
 * `http://localhost:3000`** — so the bare command an admin pastes either fails or grants a
 * role on some other relay entirely. The key goes in the environment rather than in argv,
 * where `ps` would show it to everyone on that host.
 *
 * One line, long as it is: it is printed at two different indents, and a wrapped command
 * lines up under neither of them.
 */
export function channelBotCommand(relayUrl: string, channel: string, hex: string): string {
  return (
    `BUZZ_PRIVATE_KEY=<channel owner or admin nsec> buzz --relay ${toHttpBase(relayUrl)} ` +
    `channels add-member --channel ${channel} --pubkey ${hex} --role bot`
  );
}

/**
 * Both grants a membership-gated relay needs before the agent answers, as commands.
 *
 * Printed together even though only the first is blocking here. They are run by different
 * people in different places — relay membership on the relay host, the channel role from a
 * channel owner's terminal — so learning about the second only after the first lands costs
 * another round trip through a human who has already walked away.
 *
 * `buzz-admin` is the relay's own binary, not the `buzz` client this file shells out to:
 * that client has no relay-membership command, and the key being admitted cannot admit
 * itself.
 *
 * The channel id is a placeholder when the refusal came before the relay would list its
 * channels. Nothing here can substitute one, and a guessed uuid is a command that runs.
 */
export function relayMembershipHandoff(opts: {
  relayUrl: string;
  nsec: string;
  channel?: string;
}): string {
  const { npub, hex } = agentPubkeys(opts.nsec);
  return `Ask a relay owner or admin for both grants:

  1. relay membership — on the relay host:

       buzz-admin add-member --pubkey ${npub}

  2. the channel bot role — from a terminal holding a channel owner or admin key:

       ${channelBotCommand(opts.relayUrl, opts.channel ?? "<channel-uuid>", hex)}

Step 2 can also be done from here: rerun this registration with --add-as-bot and paste the
owner/admin key at the hidden, one-time prompt. The profile and the directory record are
this toolkit's own to publish; it does that itself once step 1 lands.`;
}

/**
 * Shells out to the real `buzz` client for bring-up.
 *
 * Registration is a one-shot admin-shaped operation on a `0.x` relay whose conventions
 * drift; reimplementing it would mean tracking upstream for no benefit. Calling the real
 * client is how a Buzz capability can never be silently lost — the same reason one shells
 * out to `gh` rather than reimplementing GitHub.
 */
export const buzzCli: BuzzCli = async (args, env) => {
  try {
    const childEnv = { ...process.env, ...env };
    for (const [name, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[name];
    }
    const { stdout } = await run("buzz", args, { env: childEnv });
    return stdout;
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "the `buzz` CLI is not on your PATH — it performs relay registration; install it first",
      );
    }
    throw new Error(`buzz ${args[0]} ${args[1] ?? ""} failed: ${(e.stderr || e.message || "").trim()}`);
  }
};

function assertAccepted(output: string, what: string): void {
  let parsed: { accepted?: boolean; message?: string };
  try {
    parsed = JSON.parse(output) as { accepted?: boolean; message?: string };
  } catch {
    return; // not JSON: nothing to assert, and a non-zero exit would already have thrown
  }
  if (parsed.accepted === false) {
    throw new Error(`the relay rejected ${what}: ${parsed.message || "no reason given"}`);
  }
}

export async function listChannels(
  relayUrl: string,
  nsec: string,
  cli: BuzzCli = buzzCli,
): Promise<BuzzChannel[]> {
  const out = await cli(["channels", "list"], {
    BUZZ_RELAY_URL: toHttpBase(relayUrl),
    BUZZ_PRIVATE_KEY: nsec,
  });
  return JSON.parse(out) as BuzzChannel[];
}

/** Sets the agent's relay profile. Channel membership is a human-owned action. */
export async function registerAgent(
  opts: {
    relayUrl: string;
    nsec: string;
    name: string;
    about?: string;
    nip05?: string;
    avatar?: string;
  },
  cli: BuzzCli = buzzCli,
): Promise<void> {
  const env = { BUZZ_RELAY_URL: toHttpBase(opts.relayUrl), BUZZ_PRIVATE_KEY: opts.nsec };

  let avatarUrl: string | undefined;
  if (opts.avatar) {
    const uploaded = await cli(["upload", "file", "--file", opts.avatar], env);
    avatarUrl = uploaded.match(/https?:\/\/[^"\s]+/)?.[0];
    if (!avatarUrl) throw new Error("avatar upload returned no URL");
  }

  const profileArgs = ["users", "set-profile", "--name", opts.name];
  if (opts.about) profileArgs.push("--about", opts.about);
  if (opts.nip05) profileArgs.push("--nip05", opts.nip05);
  if (avatarUrl) profileArgs.push("--avatar", avatarUrl);
  assertAccepted(await cli(profileArgs, env), "the profile");
}

/** Uses a human owner/admin key once to grant the agent its channel bot role. */
export async function addBotToChannel(
  opts: {
    relayUrl: string;
    agentNsec: string;
    channelOwnerNsec: string;
    channel: string;
  },
  cli: BuzzCli = buzzCli,
): Promise<void> {
  const agentPubkey = toHexPubkey(npubFor(opts.agentNsec));
  const ownerPubkey = toHexPubkey(npubFor(opts.channelOwnerNsec));
  if (ownerPubkey === agentPubkey) {
    throw new Error("the channel owner/admin key must be different from the agent key");
  }

  assertAccepted(
    await cli([
      "channels", "add-member",
      "--channel", opts.channel,
      "--pubkey", agentPubkey,
      "--role", "bot",
    ], {
      BUZZ_RELAY_URL: toHttpBase(opts.relayUrl),
      BUZZ_PRIVATE_KEY: opts.channelOwnerNsec,
      BUZZ_AUTH_TAG: undefined,
    }),
    `adding the bot to channel ${opts.channel}`,
  );
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_UPLOAD_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

/**
 * Renders the committed SVG source and strips PNG metadata the relay rejects.
 * Generated PNGs take the same path so profile publication is deterministic.
 *
 * This does not composite a circular crop or ring onto the artwork — that stays a chat
 * client's job (avatar-house-style.txt tells the model to leave background margin for
 * exactly this). The alternative, baking a ring into the generation prompt, was tried and
 * rejected: an image model draws a visibly different ring on every render — a few pixels
 * thicker here, off-center there — which reads as "drawn by different people" across a
 * roster. A crop is deterministic geometry; if this toolkit ever wants one baked into the
 * artwork rather than left to the client, it belongs here as pixel math, not as a prompt
 * instruction the model reinterprets each time.
 */
export async function prepareAvatarForUpload(
  source: string,
  renderSize = 256,
): Promise<{ path: string; cleanup: () => void }> {
  if (!existsSync(source)) throw new Error(`avatar does not exist: ${source}`);
  const dir = mkdtempSync(join(tmpdir(), "agent-avatar-"));
  const raw = join(dir, "raw.png");
  const clean = join(dir, "avatar.png");

  try {
    const extension = extname(source).toLowerCase();
    if (extension === ".svg") {
      try {
        await run("rsvg-convert", [
          "-w", String(renderSize), "-h", String(renderSize), source, "-o", raw,
        ]);
      } catch (error) {
        const cause = error as { code?: string };
        if (cause.code === "ENOENT") {
          throw new Error(
            "publishing avatar.svg needs `rsvg-convert` (macOS: `brew install librsvg`)",
          );
        }
        throw error;
      }
    } else if (extension === ".png") {
      writeFileSync(raw, readFileSync(source));
    } else {
      throw new Error(`avatar must be an .svg or .png file: ${source}`);
    }

    writeFileSync(clean, canonicalPng(readFileSync(raw)));
    return { path: clean, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Keeps only chunks accepted by the Buzz media validator. */
export function canonicalPng(input: Buffer): Buffer {
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("avatar renderer did not produce a PNG");
  }

  const chunks = [input.subarray(0, 8)];
  const seen = new Set<string>();
  let offset = 8;
  while (offset < input.length) {
    if (offset + 12 > input.length) throw new Error("avatar PNG has a truncated chunk");
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) throw new Error("avatar PNG has a truncated chunk");
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (PNG_UPLOAD_CHUNKS.has(type)) {
      chunks.push(input.subarray(offset, end));
      seen.add(type);
    }
    offset = end;
    if (type === "IEND") break;
  }

  for (const required of ["IHDR", "IDAT", "IEND"]) {
    if (!seen.has(required)) throw new Error(`avatar PNG is missing ${required}`);
  }
  return Buffer.concat(chunks);
}
