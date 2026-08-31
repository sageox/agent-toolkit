import { z } from "zod";
import {
  ChannelSchema,
  resolveSecret,
  type AgentManifest,
  type SurfaceAdapter,
} from "@sageox/agent-toolkit-core";
import { ConsoleAdapter } from "@sageox/agent-toolkit-adapter-console";
import { BuzzAdapter, resolveBuzzSigner } from "@sageox/agent-toolkit-adapter-buzz";
import { SlackAdapter } from "@sageox/agent-toolkit-adapter-slack";

/**
 * Buzz's own surface fields. The manifest schema lets a surface carry extra keys so
 * each adapter validates its own — a typo in `relayUrl` should fail here, at load,
 * rather than as a confusing connection error later.
 */
const BuzzSurfaceSchema = z.object({
  kind: z.literal("buzz"),
  relayUrl: z.string().url(),
  identity: z.string().min(1),
  /** Channels to listen and reply in. None means it hears mentions only. */
  channels: z.array(ChannelSchema).default([]),
});

const SlackSurfaceSchema = z.object({
  kind: z.literal("slack"),
  /** Bot token secretRef (normally SLACK_BOT_TOKEN). */
  identity: z.string().min(1),
  /** App-level Socket Mode token secretRef (normally SLACK_APP_TOKEN). */
  appToken: z.string().min(1),
  /** Channels to listen and reply in. None means it answers DMs only. */
  channels: z.array(ChannelSchema).default([]),
});

export interface BuildOptions {
  secretsDir?: string;
  /** Resume point per surface kind, so a restart does not lose the messages it missed. */
  since?: Record<string, number>;
}

export interface BuzzTarget {
  relayUrl: string;
  /** secretRef, not the key — callers resolve it through `resolveBuzzSigner`. */
  identity: string;
}

/**
 * Narrows a Buzz surface to the two fields anything reaching a relay needs. `SurfaceSchema`
 * is `passthrough()`, so the manifest type does not carry them and every caller had to cast.
 *
 * Only as strict as those callers were: `relayUrl` is checked for being a string, not a
 * URL. `BuzzSurfaceSchema` refuses a malformed one when the adapter is built — rejecting it
 * here would report "you have no Buzz surface" for what is really a bad relay URL.
 */
export function buzzTarget(surface: unknown): BuzzTarget | undefined {
  const buzz = surface as { relayUrl?: unknown; identity?: unknown } | undefined;
  if (typeof buzz?.relayUrl !== "string" || typeof buzz.identity !== "string") return undefined;
  return { relayUrl: buzz.relayUrl, identity: buzz.identity };
}

/** `find` is safe: the manifest refuses a second Buzz surface wherever it would be ambiguous. */
export function buzzSurface(manifest: AgentManifest): BuzzTarget | undefined {
  return buzzTarget(manifest.surfaces.find((surface) => surface.kind === "buzz"));
}

/** Turns the manifest's declared surfaces into live adapters. */
export async function buildAdapters(
  manifest: AgentManifest,
  opts: BuildOptions = {},
): Promise<SurfaceAdapter[]> {
  const adapters: SurfaceAdapter[] = [];

  for (const surface of manifest.surfaces) {
    switch (surface.kind) {
      case "console":
        adapters.push(new ConsoleAdapter({ input: process.stdin, output: process.stdout }));
        break;

      case "buzz": {
        const cfg = BuzzSurfaceSchema.parse(surface);
        adapters.push(
          new BuzzAdapter({
            relayUrl: cfg.relayUrl,
            signer: await resolveBuzzSigner(cfg.identity, { dir: opts.secretsDir }),
            channels: cfg.channels,
            since: opts.since?.buzz,
          }),
        );
        break;
      }

      case "slack": {
        const cfg = SlackSurfaceSchema.parse(surface);
        const botToken = resolveSecret(cfg.identity, { dir: opts.secretsDir });
        const appToken = resolveSecret(cfg.appToken, { dir: opts.secretsDir });
        if (!botToken) throw new Error(`Slack bot token secretRef ${cfg.identity} does not resolve`);
        if (!appToken) throw new Error(`Slack app token secretRef ${cfg.appToken} does not resolve`);
        adapters.push(
          new SlackAdapter({
            botToken,
            appToken,
            channels: cfg.channels,
            since: opts.since?.slack,
          }),
        );
        break;
      }

      default:
        throw new Error(
          `surface "${surface.kind}" is not implemented yet (have: console, buzz, slack)`,
        );
    }
  }

  return adapters;
}
