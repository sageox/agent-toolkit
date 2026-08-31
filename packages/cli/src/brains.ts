import { resolve } from "node:path";
import { TEAM_TOOL_NAMES, type BrainConfig } from "@sageox/agent-toolkit-core";

/** Tool names a brain contributes, so `doctor` can check the policy admits them. */
export const BRAIN_TOOL_NAMES = [
  "brain_list",
  "brain_read",
  "brain_write",
  "brain_consolidate",
];
/** Private NIP-AE memory is key/value and supports tombstones, not vault consolidation. */
export const PRIVATE_BRAIN_TOOL_NAMES = [
  "brain_list",
  "brain_read",
  "brain_write",
  "brain_delete",
];
/**
 * The team brain's tools come from the server that serves them, not a second list here: a
 * policy written from a stale copy allows tools the agent never asks for and denies the
 * ones it does.
 */
export { TEAM_TOOL_NAMES };

/** Where a team brain reads its `ox` token from when the manifest names no secretRef. */
export const DEFAULT_OX_TOKEN_SECRET = "SAGEOX_TOKEN";

/**
 * The MCP server name a brain is wired under. One definition, because the tool policy is
 * written against it and a policy that names a server that does not exist enforces nothing.
 */
export function serverNameFor(brain: BrainConfig, index: number): string | undefined {
  switch (brain.preset) {
    case "local":
      return "brain";
    case "shared":
      return `brain-shared-${index}`;
    case "private":
      return "private-brain";
    case "team":
      return "team-brain";
    default:
      return undefined;
  }
}

/**
 * Tool names a given set of brains needs the policy to admit.
 *
 * MCP tools reach the brain namespaced as `mcp__<server>__<tool>`, with non-`[a-zA-Z0-9_-]`
 * in the server name replaced by `_`. A policy listing the bare `team_search` therefore
 * matches nothing: the agent asks for `mcp__team-brain__team_search`, the gateway finds no
 * rule, and the tool is refused while `doctor` — checking the same bare name — calls it
 * allowlisted. The namespace belongs here so both sides ask the same question.
 */
export function toolNamesFor(brains: BrainConfig[]): string[] {
  const names = new Set<string>();
  brains.forEach((brain, index) => {
    const server = serverNameFor(brain, index);
    if (!server) return;
    const tools =
      brain.preset === "team"
        ? TEAM_TOOL_NAMES
        : brain.preset === "private"
          ? PRIVATE_BRAIN_TOOL_NAMES
          : BRAIN_TOOL_NAMES;
    for (const tool of tools) names.add(`mcp__${normalizeServerName(server)}__${tool}`);
  });
  return [...names];
}

/** Mirrors the agent's own rule: anything outside `[a-zA-Z0-9_-]` becomes `_`. */
function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** An MCP server the agent runs itself, in ACP's stdio shape. */
export interface StdioMcpServer {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** A brain the gateway hosts itself, because it holds a credential the brain must not. */
export type HostedBrainConfig =
  | {
      preset: "vault";
      brainPreset: "local" | "shared";
      name: string;
      root: string;
      age: { recipient: string; identitySecret: string };
    }
  | {
      preset: "private";
      name: string;
      owner: string;
      writeScope?: string[];
    }
  | {
      preset: "team";
      name: string;
      team: string;
      repo?: string;
      configHome?: string;
      /** secretRef, not the token: the gateway resolves it, the brain never sees it. */
      token: string;
    };

export interface BrainWiring {
  servers: StdioMcpServer[];
  /** Started by the caller; each becomes an `http` MCP server the agent connects to. */
  hosted: HostedBrainConfig[];
  /** Presets configured but not yet implemented, so the gap is reported, not silent. */
  unsupported: string[];
}

/**
 * Turns declared brains into MCP servers.
 *
 * These go to the agent as **stdio** servers, which it spawns itself. That is a
 * deliberate exception to §7.5's "the gateway hosts MCP" rule, and it is safe for
 * exactly one reason: **a vault brain has no credential**. Its whole configuration is a
 * directory path. The rule exists to keep tokens out of the brain zone, and there is no
 * token here to keep out.
 *
 * A secret-bearing MCP server may NOT take this route — stdio would hand it the
 * credential. Those come back as `hosted`, for the gateway to serve over HTTP.
 *
 * Tool calls still pass the policy: the agent asks permission per tool, and the gateway
 * answers from `settings.json`.
 */
export function wireBrains(
  brains: BrainConfig[],
  opts: { agentDir: string; self: { command: string; args: string[] } },
): BrainWiring {
  const servers: StdioMcpServer[] = [];
  const hosted: HostedBrainConfig[] = [];
  const unsupported: string[] = [];

  brains.forEach((brain, index) => {
    switch (brain.preset) {
      case "local":
      case "shared": {
        // Vault paths resolve against the agent's home, never the working directory: an
        // agent must mean the same thing wherever it is launched from.
        const vault = resolve(opts.agentDir, brain.path);
        if (brain.age) {
          // The identity is a secret, so the vault moves into the gateway. The ACP child
          // receives only an HTTP capability and never the identity value or secretRef.
          hosted.push({
            preset: "vault",
            brainPreset: brain.preset,
            name: serverNameFor(brain, index)!,
            root: vault,
            age: brain.age,
          });
        } else {
          servers.push({
            type: "stdio",
            name: serverNameFor(brain, index)!,
            command: brain.command ?? opts.self.command,
            args: brain.args ?? [...opts.self.args, "brain-server", "--vault", vault],
            env: [{ name: "BRAIN_VAULT_ROOT", value: vault }],
          });
        }
        break;
      }
      case "team": {
        // Hosted by the gateway, never spawned by the agent: this brain shells to `ox`,
        // and a stdio child would put ox's token file inside the brain's reach.
        hosted.push({
          preset: "team",
          name: serverNameFor(brain, index)!,
          team: brain.team,
          repo: brain.repo,
          configHome: brain.configHome,
          // Defaulted here rather than at the call site, so the runtime, `doctor` and
          // `memory add` all ask for the same secret rather than each guessing.
          token: brain.token ?? DEFAULT_OX_TOKEN_SECRET,
        });
        break;
      }

      case "private": {
        // NIP-AE needs the agent's signing key to encrypt, address, and publish records.
        // It therefore lives with the gateway just like the credentialed team brain; the
        // brain gets an HTTP capability and never the Nostr key itself.
        hosted.push({
          preset: "private",
          name: serverNameFor(brain, index)!,
          owner: brain.owner,
          writeScope: brain.writeScope,
        });
        break;
      }

      // Every preset in the schema is served above, so this arm is unreachable today. It
      // stays because the next one added to `BrainSchema` would otherwise be dropped here
      // without a diagnostic and without a type error — `serverNameFor` returns undefined
      // by default too, so the agent would come up quietly missing a brain it declared.
      default:
        unsupported.push((brain as BrainConfig).preset);
    }
  });

  return { servers, hosted, unsupported };
}
