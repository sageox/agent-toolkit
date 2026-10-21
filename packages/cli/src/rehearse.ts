import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_SECRETS_DIR,
  passthroughEnv,
  resolveSecret,
  type AgentManifest,
  type ChannelDecl,
  type SurfaceAdapter,
} from "@sageox/agent-toolkit-core";
import {
  BUZZ_DEFAULTS,
  EngramStore,
  generateKeypair,
  LocalRelay,
  resolveBuzzSigner,
} from "@sageox/agent-toolkit-adapter-buzz";
import { sameRelay } from "./register.ts";

/** The secretRef a rehearsal's Buzz surfaces sign with, set in this process's env alone. */
const IDENTITY = "REHEARSAL_BUZZ_IDENTITY";
const OPERATOR = "REHEARSAL_OPERATOR";

/**
 * Empties this process's environment of everything but the names a process needs to run,
 * and gives it a home of its own. Call it before the agent's `.env` is loaded, which then
 * becomes the only secret source besides `--secrets`.
 *
 * One step covers every credential path, because every `secretRef` falls back to this
 * environment and every child — brain, MCP server, job body — is built from it. `HOME` moves
 * for the same reason: a child that reads its home would read the operator's, from the Claude
 * brain's user settings to `gh`'s login.
 *
 * Returns the directory the rehearsal keeps its files in, which is removed when the process
 * exits however it exits — a job's caches under `HOME` would otherwise pile up per run.
 */
export function leaveTheShell(): string {
  const dir = mkdtempSync(join(tmpdir(), "sageox-agent-rehearsal-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(home);
  const keep = passthroughEnv(process.env);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, keep, { HOME: home });
  return dir;
}

/**
 * The real agent, run with the outside world swapped at the two places this CLI hands it to
 * one: what it connects to, and what it holds. Everything between — the gateway, the guard,
 * the policy, the brain, the MCP servers, the job host and the job body — is the production
 * path, unchanged.
 */
export class Rehearsal {
  /** The person at this terminal, who the rehearsal makes the agent's owner. */
  private readonly you = generateKeypair();
  /** Each line sent and not yet handed to the gateway, by event id. */
  private readonly pending = new Map<string, () => void>();
  private sent = 0;

  private constructor(
    private readonly manifest: AgentManifest,
    private readonly relay: LocalRelay,
    private readonly agent: string,
  ) {}

  /**
   * Rewires `manifest` in place onto stand-ins, and arms its kill switches there. A surface
   * with no stand-in is refused rather than left pointing at the real one.
   *
   * The agent signs as a throwaway key on a relay inside this process, so nothing it posts to
   * Buzz, remembers there, or announces there reaches anyone. Its vault memory moves into
   * `dir`, and the resume cursor is the caller's to leave alone: both belong to the real agent.
   */
  static async start(manifest: AgentManifest, dir: string): Promise<Rehearsal> {
    const other = manifest.surfaces.find((s) => s.kind !== "buzz" && s.kind !== "console");
    if (other) {
      throw new Error(
        `--rehearse has no local stand-in for the ${other.kind} surface yet — rehearse a ` +
          "copy of this agent without it",
      );
    }
    // One stand-in keeps the surfaces of one relay apart only by their channels, so two
    // relays' surfaces sharing a channel id would both answer the same line.
    const urls = manifest.surfaces.flatMap((s) => (s.kind === "buzz" ? [String(s.relayUrl)] : []));
    if (urls.some((url) => !sameRelay(url, urls[0]))) {
      throw new Error("--rehearse stands in for one Buzz relay, and this agent names more — rehearse a copy with one");
    }

    const agent = generateKeypair();
    process.env[IDENTITY] = agent.nsec;
    const names = new Map(
      manifest.surfaces
        .flatMap((s) => (s.kind === "buzz" ? ((s as { channels?: ChannelDecl[] }).channels ?? []) : []))
        .map((c): [string, string] => [c.id, c.name ?? c.id]),
    );
    const relay = await LocalRelay.start({
      // As a real relay does, so the adapter's AUTH path runs.
      requireAuth: true,
      onPublish: (event) => {
        if (event.kind !== BUZZ_DEFAULTS.kind || event.pubkey !== agent.hex) return;
        const channel = event.tags.find((tag) => tag[0] === BUZZ_DEFAULTS.channelTag)?.[1] ?? "";
        process.stdout.write(`\n#${names.get(channel) ?? channel} ${manifest.name}> ${event.content}\n`);
      },
    });
    const rehearsal = new Rehearsal(manifest, relay, agent.hex);

    manifest.surfaces = manifest.surfaces.map((s) =>
      s.kind === "buzz" ? { ...s, relayUrl: relay.url, identity: IDENTITY } : s,
    );
    manifest.owner = [...(manifest.owner ?? []), rehearsal.you.hex];
    manifest.allowlist = [...(manifest.allowlist ?? []), rehearsal.you.hex];
    manifest.brains = manifest.brains.map((brain, i) =>
      brain.preset === "local" || brain.preset === "shared"
        ? { ...brain, path: join(dir, "memory", String(i)) }
        : brain,
    );

    process.stdout.write(
      `  rehearsal: Buzz is a relay in this process (${relay.url}); the agent signs as ` +
        `${agent.npub}, and you, its owner, as ${rehearsal.you.npub}\n` +
        `  rehearsal: HOME and memory are under ${dir}, removed when this exits\n`,
    );
    const armed = await rehearsal.arm();
    if (armed.length) process.stdout.write(`  rehearsal: armed ${armed.join(", ")}\n`);
    return rehearsal;
  }

  /**
   * Arms every declared kill switch on the stand-in, writing what `job arm` writes. A fresh
   * relay holds no switch, and a job whose switch fails closed would be denied every time.
   */
  private async arm(): Promise<string[]> {
    const brain = this.manifest.brains.find((b) => b.preset === "private");
    const keys = this.manifest.jobs.flatMap((job) => (job.killSwitch ? [job.killSwitch.key] : []));
    if (brain?.preset !== "private" || !keys.length) return [];
    const store = new EngramStore({
      relayUrl: this.relay.url,
      owner: brain.owner,
      signer: await resolveBuzzSigner(IDENTITY),
    });
    try {
      for (const key of keys) await store.write(key, "on");
    } finally {
      store.close();
    }
    return keys;
  }

  /** Says which of `refs` this rehearsal runs without: the ones it was not given. */
  withheld(refs: Iterable<string>, opts: { dir?: string | readonly string[] }): void {
    const missing = [...new Set(refs)].filter((ref) => !resolveSecret(ref, opts));
    if (!missing.length) return;
    const dirs = typeof opts.dir === "string" ? [opts.dir] : (opts.dir ?? [DEFAULT_SECRETS_DIR]);
    process.stdout.write(
      `  rehearsal: running without ${missing.join(", ")} — not in ${dirs.join(", ")} or ` +
        "this agent's .env\n",
    );
  }

  /**
   * Sends each line of stdin as a message from you in the agent's first Buzz channel,
   * mentioning it. Call before the gateway starts the adapters, so the tap below is in place;
   * a line typed before the agent subscribes waits in the relay's backlog.
   *
   * `onEnd` runs once stdin closes and the gateway has been handed every line, so the
   * caller's `drain` then covers the turns they started — a file of lines on stdin is a
   * scripted rehearsal.
   */
  chat(adapters: SurfaceAdapter[], onEnd: () => void): void {
    const surface = this.manifest.surfaces.find((s) => s.kind === "buzz") as
      | { channels?: ChannelDecl[] }
      | undefined;
    const channel = surface?.channels?.[0]?.id;
    if (!channel) {
      process.stdout.write("  rehearsal: this agent lists no Buzz channel, so there is nowhere to talk to it\n");
      return;
    }

    for (const adapter of adapters) {
      if (adapter.kind !== "buzz") continue;
      const start = adapter.start.bind(adapter);
      // Tapped where the gateway is handed each message. It has queued the turn, or skipped
      // the message, before this returns.
      adapter.start = (onEvent) =>
        start(onEvent && ((e) => {
          onEvent(e);
          this.pending.get(e.id.nativeId)?.();
        }));
    }

    const signer = resolveBuzzSigner(OPERATOR, { env: { [OPERATOR]: this.you.nsec } });
    const handed: Promise<void>[] = [];
    let sending = Promise.resolve();
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      // Chained, so the lines reach the channel in the order they were typed.
      sending = sending.then(async () => {
        // The sequence tag is what makes two identical lines in one second two events: an
        // event's id is a hash of its content, and a repeated id is dropped as already seen.
        const event = await (await signer).signEvent({
          kind: BUZZ_DEFAULTS.kind,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            [BUZZ_DEFAULTS.channelTag, channel],
            [BUZZ_DEFAULTS.mentionTag, this.agent],
            ["rehearsal", String(++this.sent)],
          ],
          content: text,
        });
        handed.push(new Promise((resolve) => this.pending.set(event.id, resolve)));
        this.relay.backlog.push(event);
        this.relay.emit(event);
      });
    });
    lines.on("close", () => void sending.then(() => Promise.all(handed)).then(onEnd));
  }

  stop(): Promise<void> {
    return this.relay.stop();
  }
}
