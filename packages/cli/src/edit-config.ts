import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { resolveMcpServer, type ChannelDecl, type McpServerDecl } from "@sageox/agent-toolkit-core";
import { writeIfAbsent, SETTINGS_JSON } from "./init.ts";

export type BrainProvider = "mock" | "claude-acp";

/**
 * Points the manifest at a brain.
 *
 * Setting what is already set is **not an error** — it reports `changed: false` and
 * leaves the file alone, so re-running the command is safe and the caller can carry on
 * to whatever comes next.
 */
export function setBrainProvider(
  config: string,
  provider: BrainProvider,
): { yaml: string; changed: boolean } {
  const doc = parseDocument(config);
  const brain = doc.get("brain") as YAMLMap | undefined;

  if (!brain || typeof brain.get !== "function") {
    throw new Error("config has no `brain:` block — is this a sageox-agent manifest?");
  }
  if (brain.get("provider") === provider) return { yaml: config, changed: false };

  brain.set("provider", provider);
  return { yaml: String(doc), changed: true };
}

/**
 * Pins the model the brain runs on, or removes the pin when given `undefined`.
 *
 * Written into the manifest rather than exported into the environment, so the pin is a
 * line someone can review in the bundle diff — and so it survives the brain's env
 * allowlist, which drops an ambient `ANTHROPIC_MODEL` on purpose.
 *
 * Removal exists because the mock brain runs no model: a pin left behind on the way to
 * `mock` is one the manifest refuses to load, and one the next switch back to Claude
 * would silently reuse as though it had been chosen again.
 */
export function setBrainModel(
  config: string,
  model: string | undefined,
): { yaml: string; changed: boolean } {
  const doc = parseDocument(config);
  const brain = doc.get("brain") as YAMLMap | undefined;

  if (!brain || typeof brain.get !== "function") {
    throw new Error("config has no `brain:` block — is this a sageox-agent manifest?");
  }
  if (model === undefined) {
    if (!brain.has("model")) return { yaml: config, changed: false };
    brain.delete("model");
    return { yaml: String(doc), changed: true };
  }
  if (brain.get("model") === model) return { yaml: config, changed: false };

  brain.set("model", model);
  return { yaml: String(doc), changed: true };
}

/**
 * Adds a Buzz surface to an existing manifest.
 *
 * Edits the YAML document rather than appending text: `surfaces:` sits in the middle of
 * the file, so appending puts the new entry under whatever block happens to come last
 * and produces a config that no longer parses. Going through the document also keeps the
 * comments a human wrote.
 */
export function addBuzzSurface(
  config: string,
  relayUrl: string,
  channels: readonly ChannelDecl[] = [],
): string {
  const doc = parseDocument(config);
  const surfaces = doc.get("surfaces") as YAMLSeq | undefined;

  if (!surfaces || typeof surfaces.add !== "function") {
    throw new Error("config has no `surfaces:` list to add to");
  }
  if (seqHasSurface(surfaces, "buzz")) {
    throw new Error("config already has a buzz surface — edit it by hand");
  }
  refuseDuplicateChannels(channels);

  surfaces.add({
    kind: "buzz",
    relayUrl,
    identity: "BUZZ_NSEC",
    // Omitted rather than written empty when nothing is listed: an absent list reads as
    // "hear mentions only", which is what an agent with no channels is for.
    ...(channels.length ? { channels: channels.map(channelEntry) } : {}),
  });

  return String(doc);
}

/** The entry as it is written to the file — `name` only when there is one to record. */
function channelEntry(channel: ChannelDecl): Record<string, string> {
  return { id: channel.id, ...(channel.name ? { name: channel.name } : {}), reply: channel.reply };
}

/**
 * Refuses a list that answers "may it speak publicly here" twice for one channel.
 *
 * The manifest refuses it at load as well. Refusing it here is what keeps the command
 * from writing a file it would then have to tell the operator to hand-edit.
 */
function refuseDuplicateChannels(channels: readonly ChannelDecl[]): void {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.id)) twice.add(channel.id);
    seen.add(channel.id);
  }
  if (twice.size) throw new Error(`a channel may be listed once: ${[...twice].join(", ")}`);
}

/** Adds a Socket Mode Slack surface without placing either token in the manifest. */
export function addSlackSurface(config: string, channels: readonly ChannelDecl[]): string {
  const doc = parseDocument(config);
  const surfaces = doc.get("surfaces") as YAMLSeq | undefined;

  if (!surfaces || typeof surfaces.add !== "function") {
    throw new Error("config has no `surfaces:` list to add to");
  }
  if (seqHasSurface(surfaces, "slack")) {
    throw new Error("config already has a slack surface — edit it by hand");
  }
  refuseDuplicateChannels(channels);

  surfaces.add({
    kind: "slack",
    identity: "SLACK_BOT_TOKEN",
    appToken: "SLACK_APP_TOKEN",
    // Empty is a DM-only agent: `message.im` opens that path without any channel being
    // named, and the guard sees a DM as private wherever it arrives from.
    channels: channels.map(channelEntry),
  });
  return String(doc);
}

/** `owner` as a list, whether the file wrote one id or several. */
function ownerIds(doc: ReturnType<typeof parseDocument>): string[] {
  const owner = doc.get("owner", true) as { toJSON?: () => unknown } | string | undefined;
  if (owner === undefined) return [];
  return [(owner as { toJSON?: () => unknown }).toJSON?.() ?? owner].flat() as string[];
}

function seqHasSurface(surfaces: YAMLSeq | undefined, kind: string): boolean {
  const list = (surfaces?.toJSON?.() ?? []) as Array<{ kind?: string }>;
  return list.some((surface) => surface?.kind === kind);
}

/** Whether a surface of this kind is already declared. */
export function hasSurface(config: string, kind: string): boolean {
  return seqHasSurface(parseDocument(config).get("surfaces") as YAMLSeq | undefined, kind);
}

/**
 * Who may address the agent — what `surface` has to read out of a manifest it is midway
 * through editing.
 *
 * Read straight from the document rather than through `loadManifest`, because this runs
 * mid-edit — a manifest that does not yet satisfy the schema is exactly the state the
 * command is there to fix, and failing to parse it would leave the human hand-editing.
 */
export function readAuthorGate(config: string): {
  respondTo: string | undefined;
  owner: string[];
} {
  const doc = parseDocument(config);
  return {
    respondTo: doc.get("respondTo") as string | undefined,
    owner: ownerIds(doc),
  };
}

/**
 * Records an author-gate id, promoting `owner` to a list on the way.
 *
 * One person is a different id on every surface, so `owner` grows by surface rather than
 * being replaced — overwriting the Buzz npub while adding a Slack id would silently lock
 * the owner out of the surface they already had. A scalar `owner` is still valid config,
 * so the promotion happens here rather than being demanded of whoever wrote the file.
 */
export function addOwnerId(config: string, id: string): { yaml: string; changed: boolean } {
  const doc = parseDocument(config);
  const existing = ownerIds(doc);

  if (existing.includes(id)) return { yaml: config, changed: false };
  doc.set("owner", [...existing, id]);
  return { yaml: String(doc), changed: true };
}

/** Sets the author gate. Reports `changed: false` when it already reads that way. */
export function setRespondTo(config: string, mode: string): { yaml: string; changed: boolean } {
  const doc = parseDocument(config);
  if (doc.get("respondTo") === mode) return { yaml: config, changed: false };
  doc.set("respondTo", mode);
  return { yaml: String(doc), changed: true };
}

/**
 * Adds an MCP server to the manifest, creating the list when the agent has none.
 *
 * Refuses a duplicate name rather than merging: two servers answering to one name would
 * make the tool policy ambiguous, and the policy is the only thing standing between a
 * declared server and what it can do.
 */
export function addMcpServer(config: string, entry: McpServerDecl): string {
  const doc = parseDocument(config);
  const name = resolveMcpServer(entry).name;
  const servers = doc.get("mcpServers") as YAMLSeq | undefined;

  if (!servers || typeof servers.add !== "function") {
    doc.set("mcpServers", [entry]);
    return String(doc);
  }

  const existing = (servers.toJSON() ?? []) as McpServerDecl[];
  if (existing.some((d) => resolveMcpServer(d).name === name)) {
    throw new Error(`config already has an mcp server named "${name}" — edit it by hand`);
  }

  servers.add(entry);
  return String(doc);
}

/** Points the manifest at a tool policy, since an MCP server without one cannot run. */
export function ensureToolsPath(config: string, path: string): { yaml: string; changed: boolean } {
  const doc = parseDocument(config);
  if (doc.get("tools")) return { yaml: config, changed: false };
  doc.set("tools", path);
  return { yaml: String(doc), changed: true };
}

/**
 * The shared preamble of every command that grants tools: make sure the policy file
 * exists and the manifest names it. Returns the (possibly updated) manifest text and
 * where the policy lives; the caller decides when to write the manifest back.
 */
export function ensureSettingsFile(
  agentDir: string,
  config: string,
): { yaml: string; changed: boolean; settingsFile: string; toolsPath: string } {
  const toolsPath =
    ((parseDocument(config).get("tools") as string | undefined) || undefined) ?? "./settings.json";
  const settingsFile = resolve(agentDir, toolsPath);
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeIfAbsent(settingsFile, SETTINGS_JSON);
  return { ...ensureToolsPath(config, toolsPath), settingsFile, toolsPath };
}

/** Adds tool names to the policy file on disk. Returns the names newly allowed. */
export function allowToolsInFile(settingsFile: string, names: string[]): string[] {
  const { json, added } = allowTools(readFileSync(settingsFile, "utf8"), names);
  writeFileSync(settingsFile, json);
  return added;
}

/**
 * Adds tool names to a policy's allow list.
 *
 * Names are written by the CLI rather than by hand on purpose: they must be namespaced
 * `mcp__<server>__<tool>`, and a bare name silently matches nothing — config that looks
 * right and enforces nothing.
 */
export function allowTools(settings: string, names: string[]): { json: string; added: string[] } {
  const parsed = JSON.parse(settings) as {
    permissions?: { allow?: string[] };
  };
  const permissions = (parsed.permissions ??= {});
  const allow = (permissions.allow ??= []);
  const added = names.filter((n) => !allow.includes(n));
  allow.push(...added);
  return { json: JSON.stringify(parsed, null, 2) + "\n", added };
}

/**
 * Raised when the brain is already in the manifest.
 *
 * Its own type, not a bare `Error`, because "already configured" is the one failure a
 * caller may want to continue through: re-running `memory add` is how the tool policy
 * gets re-synced when the tools a brain contributes have grown since it was first added.
 */
export class DuplicateBrainError extends Error {}

/**
 * Adds a memory brain to the manifest, creating the list when there is none.
 *
 * Adding the same singleton preset twice is refused rather than merged. Shared brains
 * are the exception: one agent may belong to several explicitly named groups, but the
 * same group cannot be added twice.
 */
export function addBrain(config: string, entry: Record<string, unknown>): string {
  const doc = parseDocument(config);
  const brains = doc.get("brains") as YAMLSeq | undefined;

  if (!brains || typeof brains.add !== "function") {
    doc.set("brains", [entry]);
    return String(doc);
  }

  const existing = (brains.toJSON() ?? []) as Array<{ preset?: string }>;
  const duplicate = existing.some((brain) => {
    if (brain.preset !== entry.preset) return false;
    if (entry.preset !== "shared") return true;
    const left = Array.isArray((brain as Record<string, unknown>).scope)
      ? [...((brain as Record<string, unknown>).scope as string[])].sort()
      : [];
    const right = Array.isArray(entry.scope) ? [...(entry.scope as string[])].sort() : [];
    return JSON.stringify(left) === JSON.stringify(right);
  });
  if (duplicate) {
    // Naming the scope matters for `shared`: several shared brains are allowed, so
    // "already has a shared brain" would read as a limit that does not exist.
    const what =
      entry.preset === "shared" && Array.isArray(entry.scope)
        ? `a shared brain scoped to ${(entry.scope as string[]).join(", ")}`
        : `a "${String(entry.preset)}" brain`;
    throw new DuplicateBrainError(`config already has ${what} — edit it by hand`);
  }

  brains.add(entry);
  return String(doc);
}
