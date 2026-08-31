import { z } from "zod";

import { DEFAULT_SECRETS_DIR } from "./secrets.ts";

/**
 * What the two ways of having no mode actually cost, because zod only says "Required".
 *
 * Both stay required for the same reason: with no mode, Claude Code falls back to its
 * interactive default and asks a human to approve each tool call. A hosted agent has
 * nobody to ask, so it refuses everything and reads as a broken brain rather than as a
 * config file with a line missing. Say so, and name the value to set.
 */
const MISSING_DEFAULT_MODE =
  'is required — without it Claude Code prompts a human to approve every tool call, and a hosted agent has nobody to ask, so each call is refused. Set "acceptEdits" to run the allow/deny lists as written ("bypassPermissions" is not an option — it ignores the allowlist)';

const MISSING_PERMISSIONS =
  'is required — with no permission block there is no mode, nothing is allowlisted, and no deny rule covers secrets, so the agent cannot act at all. Add {"permissions": {"defaultMode": "acceptEdits", "allow": [...], "deny": ["Read(//mnt/secrets-store/**)"]}}';

/**
 * Zod 4 replaced `required_error` with one `error` callback covering every issue, so each
 * of these tests for an absent value and defers to zod's own wording otherwise. A message
 * about a field being missing, printed for a field that is present and mistyped, sends the
 * operator to add the line that is already there.
 */
const whenMissing = (message: string) => ({
  error: (issue: { input: unknown }) => (issue.input === undefined ? message : undefined),
});

/** Claude Code's `settings.json` permission shape — portable and unchanged. */
const SettingsSchema = z
  .object({
    permissions: z.object(
      {
        defaultMode: z.string(whenMissing(MISSING_DEFAULT_MODE)),
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      },
      whenMissing(MISSING_PERMISSIONS),
    ),
  })
  .passthrough();

export type ToolVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The name a tool is known by outside its own server, and the only place that spelling is
 * built.
 *
 * It lives beside the matcher because it is the same language: a server knows its tools by
 * their bare names, while the policy — like the brain's own permission requests — names them
 * `mcp__<server>__<tool>`. Both `tools/call` chokepoints qualify through this, so one policy
 * line governs the brain asking, the broker relaying, and the gateway hosting.
 */
export function qualifyTool(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Which list a rule came from. Claude Code reads a glob differently in each. */
type Direction = "allow" | "deny";

const MCP = "mcp__";

/**
 * An allow glob has to name one literal server: `mcp__<server>__…`, server segment
 * glob-free.
 *
 * Claude Code skips an unanchored allow glob — `*`, `B*`, `mcp__*` — with a warning
 * rather than auto-approving anything, so honouring one here would make the gateway
 * strictly more permissive than the layer it backs up. `loadToolPolicy` refuses one
 * outright instead, because a grant that grants nothing is the failure this whole module
 * is shaped around.
 */
const ANCHORED_ALLOW_GLOB = /^mcp__[^*]+__/;

/**
 * A rule naming a whole server: `mcp__<server>`, with nothing after the server segment.
 *
 * Only a bare one expands to a prefix. A qualified `mcp__<server>__<tool>` rule names that
 * tool and stops there — expanding it too would turn `mcp__github__pr_list` into a grant
 * for any tool whose name extends it, `pr_list__admin` included, and MCP tool names may
 * contain the separator. One tool is what the operator wrote and one tool is what it has
 * to mean. Both spellings begin `mcp__`, so the discriminator is what follows the server.
 *
 * That discriminator is only sound because a server name cannot contain `__`, which
 * `manifest.ts`'s `ServerName` enforces where the name is chosen. Relax it there and
 * `mcp__my__server` becomes ambiguous here, with a whole-server deny silently ceasing to
 * apply — the ambiguity is not resolvable from the rule text, which is why it is refused
 * at the source rather than guessed at in this function.
 */
const isServerRule = (rule: string): boolean =>
  rule.startsWith(MCP) && !rule.slice(MCP.length).includes("__");

/** The tool-name position: everything before an argument list, if there is one. */
const toolNameOf = (rule: string): string => rule.split("(")[0];

/**
 * An allow rule that globs a TOOL NAME without naming a server, and so grants nothing.
 *
 * Only the tool-name position counts. `Bash(git diff:*)` globs an argument — Claude Code
 * honours it, the scaffold ships two of them, and reading it as an unanchored tool-name
 * glob would silently take the agent's git verbs away. The matcher and `loadToolPolicy`
 * share this predicate rather than each spelling it, because the two answering differently
 * is a rule that loads and then matches nothing.
 */
const grantsNothing = (rule: string): boolean => {
  const tool = toolNameOf(rule);
  return tool.includes("*") && !ANCHORED_ALLOW_GLOB.test(tool);
};

/** `*` spans anything, including the `__` separators. Every other character is literal. */
const globToRegExp = (rule: string): RegExp =>
  new RegExp(
    `^${rule.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? ".*" : `\\${char}`))}$`,
  );

/**
 * Paths whose contents would hand over the gateway zone if the brain could read them, and
 * what a deny rule has to look like to actually reach one.
 *
 * Each pattern anchors the path at a segment boundary rather than testing for a substring,
 * because a substring accepts a sibling that covers nothing: `Read(//mnt/secrets-store-old/**)`
 * contains `//mnt/secrets-store` and leaves the mount readable, and `Read(./.envrc)` contains
 * `.env`. An assertion answered by a rule that is present and inert is the failure this
 * module exists to catch, so it must not be one.
 *
 * `//mnt/secrets-store` carries two slashes because only `//` means the filesystem root: a
 * single `/` anchors at the settings file's own directory. See `MISANCHORED_SECRETS`.
 */
const SECRET_PATH_DENIES: ReadonlyArray<{ shows: string; covers: RegExp }> = [
  // The mounted credential directory, at the filesystem root and nowhere else. Spelled to
  // match DEFAULT_SECRETS_DIR; `tool-policy.test.ts` fails if the two ever disagree.
  { shows: "Read(//mnt/secrets-store/**)", covers: /^\/\/mnt\/secrets-store([/)]|$)/ },
  // A bare or cwd-relative filename. Gitignore semantics match one at any depth, so these
  // reach the agent's own file; a rule carrying any other directory prefix does not.
  { shows: "Read(./.env)", covers: /^(\.\/|\*\*\/)?\.env(\..*)?$/ },
  { shows: "Read(**/auth.json)", covers: /^(\.\/|\*\*\/)?auth\.json$/ },
];

/**
 * The path inside a `Read(...)` rule, or `undefined` when the rule is not one.
 *
 * The coverage patterns above are anchored against this rather than searched for inside
 * the whole rule, because a search only ever bounds one end. Anchoring the right-hand
 * boundary rejects `Read(//mnt/secrets-store-old/**)` and still accepts
 * `Read(/tmp//mnt/secrets-store/**)`, which denies a bundle-local path and leaves the mount
 * readable. A path is the thing being asserted about, so it is the thing to match.
 */
const readPathOf = (rule: string): string | undefined => /^Read\((.*)\)$/.exec(rule)?.[1];

/**
 * The secret mount named with one leading slash — a rule that reads absolute and is not.
 *
 * `Read(/mnt/secrets-store/**)`, with one slash, covers `<bundle>/mnt/secrets-store/**` — a
 * directory that does not exist — while `/mnt/secrets-store`, where the runtime actually
 * mounts them and what `resolveSecret` defaults to, stays readable. The toolkit shipped
 * this mistake in its own scaffold once, so the refusal is here to catch the copies as
 * much as an original.
 */
const MISANCHORED_SECRETS = /\(\/(?!\/)mnt\/secrets-store/;

/**
 * Tools whose PATH rules Claude Code accepts and never consults.
 *
 * File permissions are checked against `Edit(path)` and `Read(path)` only. A path rule for
 * any of these is not a narrower scope, it is no scope — the `A4` defect in a different
 * tool, and worse, because a scope is the one thing an operator writes down and then stops
 * thinking about. A rule with no path is fine: a bare `Write` deny matches at the tool
 * level, which is why the pattern requires the opening bracket.
 */
const INERT_PATH_RULE = /^(Write|NotebookEdit|MultiEdit|Glob)\(/;

export class ToolPolicy {
  constructor(
    private allow: string[],
    private deny: string[],
  ) {}

  /**
   * Deny wins, and an unlisted tool is refused.
   *
   * The brain reads untrusted text, so a side-effecting tool is an exfiltration and
   * write vector. Read-only is the low-risk default; anything else gets named on purpose.
   */
  allowsTool(name: string): ToolVerdict {
    if (this.deny.some((rule) => matches(rule, name, "deny")))
      return { ok: false, reason: `tool ${name} is denied by policy` };

    if (this.allow.some((rule) => matches(rule, name, "allow"))) return { ok: true };

    return { ok: false, reason: `tool ${name} is not allowlisted` };
  }
}

/**
 * Claude Code's own rule language for tool names:
 *
 *  - `mcp__<server>` covers every tool that server provides;
 *  - `mcp__<server>__<tool>` is that one tool;
 *  - a `*` is a glob over the whole tool name — but only a **deny** may be unanchored.
 *
 * It is Claude Code's language rather than one of our own because `settings.json` is read
 * by both matchers: Claude Code decides whether the brain may call a tool, and this
 * decides whether the gateway will serve one. A rule that means two different things is a
 * policy nobody wrote.
 *
 * The deny direction is the half that must never be looser here. The brain holds the
 * capability token for every gateway-hosted server and can reach one directly, which is
 * why `surfaceEgressHandler` re-checks at all — so a deny the brain's
 * own permission layer honours and this one ignores is a hole in the backstop rather than
 * a redundancy. `test/policy-cases` adjudicates what these rules actually reach; change
 * this function and read the verdicts that flip.
 */
function matches(rule: string, name: string, direction: Direction): boolean {
  if (rule === name) return true;

  // A bare `mcp__<server>` is the whole server. Written without a glob, so it is checked
  // before one — and `${rule}__` keeps `mcp__github` off `mcp__github_actions__run`.
  if (!rule.includes("*")) return isServerRule(rule) && name.startsWith(`${rule}__`);

  if (direction === "allow" && grantsNothing(rule)) return false;
  return globToRegExp(rule).test(name);
}

/**
 * Loads the tool policy and refuses to start on a policy that only looks like one.
 *
 * These are startup assertions rather than documentation because each failure mode is
 * silent: the agent comes up, looks healthy, and is not enforcing what its config says.
 */
export function loadToolPolicy(json: string): ToolPolicy {
  // Zod's own message is a JSON dump of issue objects, which reads as a toolkit crash
  // rather than a config file with a line missing. Name the field and say what it means.
  const parsed = SettingsSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `tool policy: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "settings"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const { defaultMode, allow, deny } = parsed.data.permissions;

  if (/bypass/i.test(defaultMode)) {
    throw new Error(
      `tool policy: defaultMode "${defaultMode}" bypasses permissions, turning the allowlist into deny-only`,
    );
  }

  // A bare `Bash` deny has no specificity tiebreak against `Bash(git status)`, so it
  // kills every allowed verb and the agent silently stops being able to reply.
  if (deny.some((rule) => rule === "Bash" || rule === "Bash(*)")) {
    throw new Error("tool policy: a broad Bash deny also denies every allowed Bash verb");
  }

  // An allow glob that names no server grants nothing — Claude Code skips it with a
  // warning, and a warning in a hosted agent's startup log is a warning nobody reads. It
  // is refused here because the rule reads as the broadest grant in the file, which is
  // exactly the shape that stops the next person looking for the grant that is missing.
  // Only the tool-name position is checked: `Bash(git diff:*)` globs an argument, not a
  // tool, and Claude Code honours it.
  const unanchored = allow.find(grantsNothing);
  if (unanchored) {
    throw new Error(
      `tool policy: allow rule "${unanchored}" grants nothing — an allow glob has to name ` +
        'one server, as "mcp__<server>__*" or "mcp__<server>__<tool>". A glob in the server ' +
        "segment is skipped rather than matched",
    );
  }

  // Checked before the hints below, so the near-miss is named as a near-miss. Reporting it
  // as "no deny rule covers secret paths" would send someone to add the rule that is
  // already there, one character short.
  const misanchored = [...allow, ...deny].find((rule) => MISANCHORED_SECRETS.test(rule));
  if (misanchored) {
    throw new Error(
      `tool policy: rule "${misanchored}" does not reach ${DEFAULT_SECRETS_DIR} — one leading ` +
        "slash anchors at the settings file's own directory, so this covers " +
        `<bundle>${DEFAULT_SECRETS_DIR} and leaves the mounted secrets readable. An absolute ` +
        `path takes two: "Read(/${DEFAULT_SECRETS_DIR}/**)"`,
    );
  }

  const inert = [...allow, ...deny].find((rule) => INERT_PATH_RULE.test(rule));
  if (inert) {
    throw new Error(
      `tool policy: rule "${inert}" is accepted and never consulted — Claude Code checks ` +
        `file permissions against Edit(path) and Read(path) rules only, so this scopes ` +
        `nothing. Write it as ${inert.startsWith("Glob(") ? "Read(...)" : "Edit(...)"}`,
    );
  }

  const denied = deny.map(readPathOf).filter((path): path is string => path !== undefined);
  if (!SECRET_PATH_DENIES.some(({ covers }) => denied.some((path) => covers.test(path)))) {
    throw new Error(
      "tool policy: no deny rule covers secret paths (expected one of " +
        `${SECRET_PATH_DENIES.map(({ shows }) => shows).join(", ")}) — a rule whose path ` +
        "merely contains one of these, such as a sibling or a copy under another " +
        "directory, does not count",
    );
  }

  return new ToolPolicy(allow, deny);
}
