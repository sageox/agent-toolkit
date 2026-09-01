import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { SECRET_REF } from "./secrets.ts";

/**
 * A name a spawned child will really see — and deliberately not the POSIX identifier
 * grammar, which is a convention rather than a constraint.
 *
 * The check is exactly what a `spawn` cannot represent, no wider. Node renders each entry as
 * `key=value`, so a key holding `=` splits at the wrong place: `BAD=KEY` reaches the child
 * as `BAD` holding `KEY=configured`, with nothing anywhere reporting it. A null byte is
 * refused by `spawn` itself, which crashes a run rather than failing a load. Everything else
 * round-trips intact — `MY-CONFIG`, `my.config`, even a name with a space — so refusing it
 * here would reject a working configuration to enforce a style.
 *
 * A `secretRef` is stricter ({@link SecretRef}) and for a different reason: it also names a
 * file, so it has to be path-safe. Same-looking rules, different constraints; collapsing
 * them cost a hyphen that `mcpServers[].env` had always accepted.
 */
const EnvVarName = z
  .string()
  .min(1, "an environment variable name cannot be empty")
  .refine((name) => !name.includes("=") && !name.includes("\u0000"), {
    message:
      "an environment variable name cannot contain `=` or a null byte — a spawn renders " +
      "each entry as `key=value`, so the child would see a different variable",
  });

/**
 * A `secretRef` logical name, refused at load rather than at the moment it is resolved.
 *
 * `resolveSecret` rejects a path-like ref — that is what keeps `../TOKEN` from escaping the
 * mounted secrets directory — but it runs when a surface connects, a server starts, or a job
 * ticks. For a job that is per run, so a bundle with a typo would load, deploy, and pass a
 * startup check, then fail on a schedule at 3am. The grammar belongs where the ref is
 * written down, and one grammar answers for every field that holds one: `SECRET_REF` is the
 * resolver's own, imported rather than restated, because two spellings of a rule are two
 * rules the moment either moves.
 */
const SecretRef = z
  .string()
  .regex(SECRET_REF, "a secretRef is letters, digits, and underscores, starting with a letter or underscore");

const HexPubkey = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "expected a 64-character hex public key")
  .transform((value) => value.toLowerCase());

/**
 * Whether a quantifier applies to a *group* — `(…)+`, `(?:…)*`, `(…){2,}`.
 *
 * This is the whole of the backtracking answer, and the condition on which `leakPatterns`
 * came back after `1e442f8` deleted it for being "one backtracking pattern away from
 * stalling a single-threaded gateway". Catastrophic backtracking needs a repetition nested
 * inside a repetition; refusing to quantify a group leaves nowhere to nest one. A
 * quantified character class — `[a-z0-9]{5}`, `\d+`, `[A-Za-z0-9_.-]+` — cannot blow up
 * exponentially and is left alone, which is what a pattern for a hostname, an id, or a key
 * shape is actually made of.
 *
 * Conservative on purpose: it refuses safe patterns too, at load, where the rewrite is one
 * line away rather than at 3am. The rewrite is usually to delete the group —
 * `\b(?:[a-z0-9-]+\.)*example\.internal\b` and `\bexample\.internal\b` match the same
 * strings, because the word boundary is already inside the hostname.
 */
function quantifiesAGroup(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") i++; // an escaped character is never structure
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    // `?` is allowed: an optional group runs at most once, so it cannot nest a repetition.
    else if (char === ")" && "*+{".includes(source[i + 1] ?? "")) return true;
  }
  return false;
}

/** Tried with the flag the guard will use, so what loads is exactly what runs. */
function compiles(source: string): boolean {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

/**
 * One outbound deny pattern, and the name a refusal and the audit log will say for it.
 *
 * Named because the name is the only thing anyone is allowed to say about a hit: quoting
 * what matched would *be* the leak, in a string that goes to the log and back to the brain.
 * A name is also the one form of it a brain can act on — "internal-hostname" tells it what
 * to take out of the reply, where "matched a leak pattern" tells it to guess.
 *
 * Compiled at load, so an unparseable regex is a deploy-time error rather than a rule that
 * matches nothing until the message it was written for goes out. Case-insensitive: a
 * hostname or an id is the same leak in any casing.
 */
const LeakPatternSchema = z
  .object({
    /**
     * A slug, on the same terms as a job's, because it lands in the same two places a
     * job slug does: one line of a line-oriented log, and a string replayed to the brain.
     * A name free to hold a newline or a quote could close the `reason="…"` field and write
     * a second `egress_blocked` line that no egress produced — a forged record in the one
     * log an operator reads to find out what a leak scan caught.
     *
     * Structural rather than escaped at the point of use. Escaping puts the invariant in
     * every caller that ever formats a verdict; a charset that cannot express the problem
     * holds for the ones not written yet.
     */
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "a leak pattern name is lower-case letters, digits, and hyphens, starting with a " +
          "letter — it is written to a line-oriented log and replayed to the brain",
      ),
    regex: z
      .string()
      .min(1)
      .refine(compiles, "not a valid regular expression")
      .refine(
        (source) => !quantifiesAGroup(source),
        "a quantifier may not apply to a group — `(…)+`, `(?:…)*` and `(…){2,}` are how a " +
          "pattern backtracks catastrophically and stalls the gateway. Quantify a character " +
          "class instead, or drop the group: `\\b(?:[a-z0-9-]+\\.)*host\\.internal\\b` and " +
          "`\\bhost\\.internal\\b` match the same strings",
      ),
  })
  .strict()
  .transform((pattern) => ({ name: pattern.name, regex: new RegExp(pattern.regex, "i") }));

export const GuardSchema = z
  .object({
    /**
     * Text this agent may not put in front of the public, scanned at the egress chokepoint.
     *
     * The patterns are the operator's, and only the operator's: a toolkit cannot know which
     * hostnames are internal, which id prefixes name a private tracker, or which decision
     * records exist to be cited. The fleet's own list is four kinds of thing — internal
     * hostnames, tracker ids, decision-record references, and secret shapes — and every one
     * of them is a fact about a particular organization.
     *
     * The guard runs these only on the way to a public destination, which is what makes a
     * scan of the message body affordable at all. Empty by default, and doing nothing is the
     * right default: an agent whose channels are all `reply: private` has no public
     * destination to scan on the way to.
     */
    leakPatterns: z.array(LeakPatternSchema).default([]),
  })
  .strict();

/**
 * One channel this agent listens in and answers in.
 *
 * `reply` states what the channel is and what the agent may say there in one word, because
 * they are one decision. A `public` entry **is** the consent the egress guard checks: there
 * is no second list anywhere for this one to disagree with, which is what makes "listed,
 * public, and structurally unable to answer" unspellable rather than merely detectable.
 *
 * No default. Listing a channel is deliberate, and so is answering in front of everyone who
 * can read it — a default would make one of those two happen by omission.
 */
export const ChannelSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Display name, as the surface reports it — what a person says out loud when asking for
     * a cross-post. Carried to `postTargets`, never consulted when deciding whether a post
     * is allowed.
     */
    name: z.string().min(1).optional(),
    reply: z.enum(["public", "private"]),
  })
  .strict();

export const SurfaceSchema = z
  .object({
    kind: z.string(), // "console" | "buzz" | "slack" | ...
    /**
     * Every channel this surface serves. Empty is a working configuration: a Slack agent
     * still answers DMs, and a Buzz agent still answers mentions.
     */
    channels: z.array(ChannelSchema).default([]),
    /** A secretRef: the buzz nsec or the Slack bot token this surface signs as. */
    identity: SecretRef.optional(),
  })
  .passthrough(); // adapters validate their own extra fields

const LimitsSchema = z.object({
  perAuthorPerMinute: z.number().int().positive().default(6),
  perChannelPerMinute: z.number().int().positive().default(20),
  maxTurnsPerThread: z.number().int().positive().default(8),
  maxAgentChainDepth: z.number().int().positive().default(2),
  maxConcurrentChannels: z.number().int().positive().default(4),
  channelQueueLimit: z.number().int().positive().default(32),
  /** A turn that outlives this releases its channel; without it one hang wedges the gateway. */
  turnTimeoutMs: z.number().int().positive().default(120_000),
});

/** Courtesy signals while a turn runs. Off is a valid choice; noisy is not. */
const AckSchema = z.object({
  /** Reaction added to the message being answered. Empty disables it. */
  emoji: z.string().default("👀"),
  /** Ephemeral typing indicator, refreshed while the turn runs. */
  typing: z.boolean().default(true),
});

const VaultAgeSchema = z
  .object({
    /** Public X25519 recipient. Safe to keep in the bundle and in version control. */
    recipient: z.string().regex(/^age1[0-9a-z]+$/, "expected an age recipient beginning with age1"),
    /** Logical secretRef containing the matching AGE-SECRET-KEY identity. */
    identitySecret: z
      .string()
      .regex(SECRET_REF, "identitySecret must be a logical secretRef"),
  })
  .strict();

/**
 * Memory. Every brain is independently optional and none is implied by another — an
 * agent with no brains is a valid agent, and that is the default.
 *
 * A list rather than four flags because scope is a parameter, not a constant: a team
 * with two squads needs two `shared` brains, which named booleans could not express.
 */
export const BrainSchema = z.discriminatedUnion("preset", [
  z.object({
    preset: z.literal("local"),
    /** Vault directory, relative to the agent's home. */
    path: z.string().default("./brain"),
    /** Override to run a different vault server, e.g. the reference brain-notes. */
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    /** Enables transparent read/write support for files named `*.md.age`. */
    age: VaultAgeSchema.optional(),
  }),
  z.object({
    preset: z.literal("shared"),
    /**
     * A shared vault must name its location explicitly. Defaulting to `./brain` would
     * give every agent a different directory while claiming they shared a memory.
     */
    path: z.string().min(1),
    /** The agents this brain is shared with. Scope is declared, never implied. */
    scope: z
      .array(z.string().min(1))
      .min(2)
      .refine((members) => new Set(members).size === members.length, {
        message: "shared brain scope must not contain duplicate agents",
      }),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    /** Enables transparent read/write support for files named `*.md.age`. */
    age: VaultAgeSchema.optional(),
  }),
  z.object({
    preset: z.literal("private"),
    /**
     * Engram owner — an ADDRESSING namespace, not authorization, and not the same thing
     * as `owner` above or the relay auth tag. Make it an organisation identity: personal
     * ownership orphans every engram the day that person leaves.
     */
    owner: HexPubkey,
    /**
     * Key prefixes `brain_write` and `brain_delete` are confined to, e.g. `mem/skills/`.
     * Reads are not restricted — this bounds what a turn can change, not what it can see.
     *
     * Omit it and the whole store is writable, which is the right default for an agent
     * whose memory is its own. Set it for an agent granted one corner of memory to edit,
     * so the tool is no wider than the grant: a slug outside the scope is refused, and
     * the bound is stated in the tool description rather than discovered by trial.
     */
    writeScope: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    preset: z.literal("team"),
    /**
     * Which team's knowledge to search, as the team **ID** — `team_jihjpfkt8b`, the value
     * `ox teams` prints in its ID column. Not the slug: a slug is accepted here and by ox,
     * and then every search fails with `HTTP 403 … access denied to team <slug>`.
     *
     * Required, because it cannot be inferred where the agent runs: `ox` normally reads
     * it from a project directory, and an agent's home is not one. Without it every
     * search fails with "no team or repo ID available" — a brain that looks configured
     * and answers nothing.
     */
    team: z.string().min(1),
    /** Narrow to a single repo's context. Optional. */
    repo: z.string().optional(),
    /**
     * The secretRef holding a SageOx access token, for deployments with no `ox login`.
     * Defaults to `SAGEOX_TOKEN`; name another when several agents on one host each carry
     * their own. Resolved in the gateway like every other credential — the brain never
     * sees it, and the value itself never belongs in this file.
     *
     * **An env-supplied token is bound to exactly one endpoint** — `SAGEOX_ENDPOINT` when
     * set, otherwise `https://sageox.ai`. Point ox at any other host and the token is not
     * rejected, it is simply not used: ox falls back to whatever `auth.json` is on disk,
     * which is either no credential at all or, worse, a different identity than the one
     * this manifest names. There is deliberately no `endpoint` field here — team memory
     * lives on production, which is already the default.
     */
    token: z
      .string()
      .regex(SECRET_REF, "token must be a logical secretRef")
      .refine((ref) => !/^ox[pt]_/.test(ref), {
        message:
          "token names the secretRef to read the ox token from, not the token itself — " +
          "put the value in the deployment's secret store and name it here",
      })
      .optional(),
    /**
     * Where ox finds its credentials — the directory holding `sageox/auth.json`.
     *
     * Defaults to the process's own config home, which is right on a workstation after
     * `ox login`. In a container there is no interactive login, so the token file is
     * mounted as a secret and this points at it. A file, not an env var: env leaks
     * through `docker inspect`, `/proc/<pid>/environ`, and crash dumps (§7.3).
     */
    configHome: z.string().optional(),
  }),
]);

/**
 * An MCP server the gateway runs on the agent's behalf.
 *
 * Every server is gateway-hosted, credential or not. Two paths would mean the safe choice
 * depends on the author classifying their own server correctly, and a server that gains a
 * credential later would silently become wrong.
 */
/**
 * A server name, constrained so that `mcp__<server>__<tool>` parses exactly one way.
 *
 * The policy language spells a whole-server rule `mcp__<server>` and a single-tool rule
 * `mcp__<server>__<tool>`, and the gateway and Claude Code read both from the same file. A
 * server whose name contains `__` makes those indistinguishable — `mcp__my__server` is
 * either the `my__server` server or the `my` server's `server` tool — and nothing in the
 * rule text can settle it, so a whole-server deny on such a name quietly stops applying.
 * The ambiguity is refused here, where the name is chosen, rather than guessed at in the
 * matcher that cannot see the server list. `tool-policy.ts`'s `isServerRule` depends on it.
 *
 * The charset is the one a namespaced tool name preserves. Anything outside
 * `[A-Za-z0-9_-]` is replaced by `_` on the way in (see `toolNamesFor` in the CLI), so
 * `my..server` would arrive as `my__server` and reintroduce the ambiguity a ban on the
 * literal spelling had just closed.
 */
const ServerName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "expected letters, numbers, dash, or underscore, starting with a letter or number — " +
      "anything else is replaced by `_` in `mcp__<server>__<tool>`, which can create a `__`",
  )
  .refine(
    (name) => !name.includes("__"),
    "a doubled underscore separates server from tool in `mcp__<server>__<tool>`, so a " +
      "server name carrying one makes a whole-server rule ambiguous — use a single `_` or `-`",
  );

export const McpServerSchema = z
  .object({
    name: ServerName,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Plain configuration — a path, a mode, a base URL. Never a credential. */
    env: z.record(EnvVarName, z.string()).optional(),
    /** Env var name → `secretRef`. Resolved in the gateway, never sent to the brain. */
    secrets: z.record(EnvVarName, SecretRef).optional(),
    /**
     * What this server's credential may be pointed at — argument name → the values allowed
     * under it, compared as exact strings.
     *
     * A credential is almost never as narrow as the job. A GitHub token reaches every
     * repository its owner can see; a Linear key reaches every team. The tool policy cannot
     * narrow that, because it matches on the tool *name* and a bound is a fact about an
     * *argument* — `pr_create` is the same tool whichever repository it is aimed at.
     *
     * **Fail-closed, and that is the whole design.** Every `tools/call` on this server must
     * carry each argument named here, with a listed value; a call missing one is refused
     * rather than passed. The alternative — check the argument when present, allow the call
     * when absent — reads as a bound and is not one: a server's org-wide tools take no
     * repository argument at all, so exactly the calls that escape the bound are the ones
     * that would sail through. A tool this refuses is a tool the operator should not be
     * allowing in the policy, and a refusal says so where a silent pass never would.
     *
     * A bound argument is also the one thing about a third-party server the audit may record
     * by value — but only when the value is one of these, not merely under one of these
     * names. A human wrote these strings, so recording one is safe; what a caller sends
     * under a bound name is still the caller's, so a value this list rejects is recorded as
     * a shape like everything else. See `tool-audit.ts`.
     */
    scope: z
      .record(
        z.string(),
        z
          .array(
            z
              .string()
              .min(1)
              // A bound is an exact string comparison, so a value spelled as a glob can only
              // ever match nothing — an agent whose every call is refused, discovered at 3am
              // rather than when the config was read. This is the one defect the tool policy
              // keeps producing (a rule that is present and inert), and it is structurally
              // closed here: `acme/*` is the same instinct as `mcp__github__**`, and unlike
              // that one it never becomes a config someone has to debug.
              .refine(
                (value) => !value.includes("*"),
                "a scope value is compared exactly, so a `*` would match nothing — " +
                  "write each permitted value out",
              ),
          )
          .min(1, "a bound argument needs at least one permitted value — an empty list refuses every call"),
      )
      .optional(),
  })
  .strict();

export type McpServerDecl = z.infer<typeof McpServerSchema>;

/** Fills in what a declaration leaves out, so the broker has a complete server config. */
export function resolveMcpServer(decl: McpServerDecl): {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  scope: Record<string, string[]>;
} {
  return {
    name: decl.name,
    command: decl.command,
    args: decl.args,
    env: decl.env ?? {},
    secrets: decl.secrets ?? {},
    scope: decl.scope ?? {},
  };
}

/**
 * Rejects a zone nothing can resolve, so `UTC+5` or `Europe/Londin` is a load error rather
 * than a job the platform refuses to create. Resolvability, not equivalence: ICU also
 * accepts a legacy alias and matches case-insensitively, where a deploy target may not.
 */
function resolvableTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Characters a cron field is spelled with — digits, names, and the range operators. */
const CRON_FIELD = /^[A-Za-z0-9*?,/-]+$/;
/** The descriptors a Kubernetes-compatible parser accepts. `@reboot` is not among them. */
const CRON_DESCRIPTOR = /^@(yearly|annually|monthly|weekly|daily|midnight|hourly|every\s+\S+)$/;
/** What each position counts, in order. Day-of-week takes 7 as a second Sunday. */
const CRON_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

/**
 * Every number the field names, ignoring the operand of a `/` step.
 *
 * A step is a stride, not a point on the axis: `*` slash-90 in minutes selects only minute
 * zero and a scheduler takes it, so bounding it by the field's own range would refuse
 * something legal.
 */
function cronFieldNumbers(field: string): number[] {
  return field
    .split(",")
    .map((term) => term.split("/")[0])
    .flatMap((term) => term.match(/\d+/g) ?? [])
    .map(Number);
}

/**
 * The **shape** of a cron expression, and the range of every number in it — not its
 * grammar.
 *
 * Each of these loads fine and then yields a job with no job, or one the deploy target
 * refuses far from the line that caused it: `not-a-cron`, a four-field expression, the
 * six-field Quartz form that comes back from a search, and an hour of `99`.
 *
 * It stops there deliberately. Field *syntax* is left to the scheduler, which is the only
 * thing that has to agree with itself — a hand-rolled grammar would eventually refuse a
 * legal expression, and a job that cannot be declared at all is worse than one whose
 * definitive parse happens downstream. Names (`MON`, `JAN`) pass unchecked for the same
 * reason: under-catching is the safe direction here.
 */
function looksLikeCron(expression: string): boolean {
  if (CRON_DESCRIPTOR.test(expression)) return true;
  const fields = expression.split(/\s+/);
  if (fields.length !== CRON_BOUNDS.length) return false;
  return fields.every((field, position) => {
    if (!CRON_FIELD.test(field)) return false;
    const [min, max] = CRON_BOUNDS[position];
    return cronFieldNumbers(field).every((value) => value >= min && value <= max);
  });
}

/**
 * What may start a job. At least one of these, or the job is a declaration nothing can
 * ever act on.
 */
const TriggerSchema = z
  .object({
    /**
     * Cron expressions, trimmed so surrounding space cannot make one entry look like two.
     * Two identical entries render two jobs firing on the same tick — refused rather than
     * deduplicated, since a doubled job is not what either line said.
     */
    schedules: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(
            looksLikeCron,
            "expected a cron expression — five fields, each in range, or a descriptor: " +
              "`0 3 * * 0`, `@weekly`",
          ),
      )
      .default([])
      .refine((s) => new Set(s).size === s.length, "duplicate cron expression"),
    /**
     * IANA zone for every expression above — cron alone cannot say which midnight.
     * A zone the platform cannot resolve is a job that never exists, so it is refused at
     * load rather than at apply.
     */
    timezone: z
      .string()
      .default("UTC")
      .refine(resolvableTimeZone, "expected an IANA time zone, e.g. UTC or America/New_York"),
    /**
     * A human or a sibling may start this job now. Which of the two is stamped by the
     * host from the entry point, never passed in: a job that could name its own trigger
     * could claim a human asked for what a clock started.
     */
    onRequest: z.boolean().default(false),
    /** An external event may start this job. */
    webhook: z.boolean().default(false),
  })
  .strict()
  .refine(
    (t) => t.schedules.length > 0 || t.onRequest || t.webhook,
    "a job with no trigger can never run",
  );

const KillSwitchSchema = z
  .object({
    /**
     * Where the soft switch is read. Defaults to `mem/<slug>/enabled` so the two cannot
     * name different jobs: one fleet job reads a switch named for a sibling, which
     * breaks nothing until the day somebody parks that sibling and cannot find why a
     * third job stopped. Override only to migrate a job whose key already exists.
     */
    key: z.string().min(1).optional(),
    /**
     * What an unreadable switch means for **this** job. No default, and never inherited.
     * A job that acts on the world fails closed — "we could not read the switch" must
     * never be the reason an unattended merge happened. A job that only reports may fail
     * open — a relay blip must not silently halt reporting for days, and `suspend` is
     * behind it. The fleet gets this right today by passing a different argument to a
     * function copied into five runners, which is exactly how a sixth inherits the wrong
     * one. Requiring the field costs one line per job and makes that unwritable.
     */
    failDirection: z.enum(["open", "closed"]),
  })
  .strict();

/**
 * The bounds the runtime can enforce **without knowing what the job does** — a clock and
 * a counter. Anything that requires counting the job's own artifacts (`maxOpenPrs`,
 * `maxFiles`) stays in the runner's own config: the toolkit cannot know what a pull
 * request is.
 *
 * The budget bows out *before* the deadline rather than being cut off at it. A SIGKILLed
 * process runs no cleanup, so a claimed item stays claimed and a half-written change is
 * left dangling.
 */
const BudgetSchema = z
  .object({
    /** The job's own wall clock. Stated, never defaulted — an unstated bound is no bound. */
    wallClockMs: z.number().int().positive(),
    /**
     * Reserved above `wallClockMs` for the closing writes. The platform deadline
     * (`activeDeadlineSeconds`, a launchd timeout, a workflow `timeout-minutes`) **is** the
     * sum of the two, computed by the deploy target from this declaration. An operator who
     * can set the deadline independently will eventually set it below the budget, which is
     * the SIGKILL-mid-write the headroom exists to prevent.
     */
    deadlineHeadroomMs: z.number().int().positive().default(300_000),
    harnessTimeoutMs: z.number().int().positive().default(600_000),
    maxIterations: z.number().int().positive().default(2),
    maxAttempts: z.number().int().positive().default(3),
    /**
     * Finite because `NaN` and `Infinity` compare false against every affordability
     * check, so a poisoned cap waves every call through instead of bowing out — it fails
     * in the unsafe direction, silently. Refused where it is constructed.
     */
    maxSpendUsd: z.number().positive().finite().optional(),
  })
  .strict();

/**
 * A parameter's name, and why it is lower-case.
 *
 * A body reads a parameter as `JOB_PARAM_<NAME>` with the name uppercased, so `env` and
 * `ENV` would be two declarations of one variable and the second would silently win.
 */
const ParameterName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "a job parameter name is lower-case letters, digits, and underscores, starting with a " +
      "letter — a body reads it as JOB_PARAM_<NAME>, uppercased",
  );

/**
 * One value a run may be handed: **which** issue, **which** document, **which** environment.
 *
 * `job_run` takes a slug and nothing else for a job that declares none of these, and that
 * default is what makes it safe to offer an agent answering anyone — no free-form field for
 * a channel message to smuggle a flag through. A parameter is the narrowest widening of it:
 * a typed, bounded value the manifest declares, the host validates, and the body reads out
 * of its environment. It never reaches the argv, which is still `run.command` and
 * `run.args` and nothing else.
 *
 * **A parameter names a target; it does not choose a behaviour.** A job whose work a caller
 * can switch is two jobs with two slugs, each with its own bound and its own line in a tool
 * policy. That is a design rule and it is stated in `docs/job-contract.md`, because no type
 * can enforce it — a two-value list is a target where the values are environments and a mode
 * where they are speeds, and nothing here can tell those apart. What the types *can* do is
 * refuse the one shape that is never a target: there is no boolean, because "which" is not a
 * question answered yes or no.
 *
 * A string must be bounded, by a closed list of values or by a pattern, exactly one of the
 * two. Unbounded, it is the free-form argument this tool spent its whole design avoiding.
 *
 * Declared here rather than checked inside the body for the same reason `budget` is: a bound
 * that lives in the body is a bound nobody reviewing the manifest can see.
 */
const JobParameterSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("integer"),
      /**
       * What this value is, in the words the brain will read when it fills the field. Not
       * decorative: a parameter is chosen by a model from a channel message, and a field
       * with no description is a field it fills with the wrong number.
       */
      description: z.string().min(1),
      /** A run with no value for it is refused. See the trigger rule: a clock has no target. */
      required: z.boolean().default(false),
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("string"),
      description: z.string().min(1),
      required: z.boolean().default(false),
      /**
       * The values this may be, when they can be written down — JSON Schema's `enum`, which
       * is how `job_run` advertises it. The narrowest a parameter gets, and the best-steered:
       * a caller sees the list rather than a regular expression it has to satisfy by
       * guessing, and a value outside it never reaches the body.
       */
      values: z.array(z.string().min(1)).min(1).optional(),
      /**
       * The shape this must have, when the values cannot be listed — an id, a slug, a path,
       * a branch. Length is part of a shape, so it is written here too: `^[a-z-]{1,64}$`,
       * quantifying the class rather than a group. A job that genuinely wants free text
       * writes `.*`, which is one line in a reviewed diff rather than a bound nobody
       * notices is missing; `MAX_PARAM_LENGTH` still caps it.
       *
       * Refused for catastrophic backtracking on the same grounds as a leak pattern: it is
       * this process that runs it, against a value a channel message chose.
       */
      pattern: z
        .string()
        .min(1)
        .refine(compiles, "not a valid regular expression")
        .refine(
          (source) => !quantifiesAGroup(source),
          "a quantifier may not apply to a group — `(…)+`, `(?:…)*` and `(…){2,}` are how a " +
            "pattern backtracks catastrophically and stalls the gateway",
        )
        .optional(),
    })
    .strict()
    .refine(
      (p) => (p.values === undefined) !== (p.pattern === undefined),
      "a string parameter is bounded by `values` or by `pattern`, and needs exactly one — " +
        "two bounds on one value is two places to look when a caller is refused",
    ),
]);

/**
 * Scheduled and event-driven work, declared beside the surfaces and brains it shares an
 * identity with.
 *
 * The toolkit owns the *envelope* — the trigger, the switch, the bound, the run record,
 * the shape of the status post. It never owns the job body, which is an ordinary process
 * named by `run`. See [the RFC](../../../docs/design/2026-08-19-jobs-rfc.md).
 *
 * Here rather than in chart values because `docs/deployment-contract.md` requires a
 * deployment target to "preserve this contract instead of translating `agent.yaml` into a
 * second configuration model" — and jobs in Helm values would be exactly that second
 * model, which is how a fleet arrives at twelve jobs described in six different charts.
 */
const JobSchema = z
  .object({
    /**
     * Stable identity. Names the job, the kill switch, and the run record — renaming one
     * is a silent outage, not a tidy-up.
     */
    slug: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "a job slug is lower-case letters, digits, and hyphens, starting with a letter",
      ),
    /**
     * An ops grouping label, deliberately redundant with the trigger, carrying **no
     * behavior**: it sets no defaults and gates nothing. A label with defaults behind it
     * gets chosen for its defaults rather than for the truth, and within two agents the
     * vocabulary describes nothing.
     *
     * `watch` — event-reactive; narrow, fresh, cheap. `shift` — the recurring bounded
     * workhorse. `sweep` — low-frequency, broad, expensive, off-hours. `queue` — drains a
     * backlog on request, with no rhythm of its own.
     *
     * The membership test is *would an operator ever act on every job of this kind at
     * once, across agents?* — which is why there is no `call`: a human-summoned job is
     * acted on one at a time by the human summoning it, and it already has a spelling,
     * `trigger.onRequest`.
     */
    archetype: z.enum(["watch", "shift", "sweep", "queue"]),
    /**
     * One line, for an operator reading a roster they did not write. Required and not
     * decorative: a parked job nobody can describe is a job nobody restarts.
     */
    description: z.string().min(1),
    trigger: TriggerSchema,
    killSwitch: KillSwitchSchema.optional(),
    /**
     * The hard switch — same effect as the soft one, but it takes a reviewed diff to flip
     * and it survives an unreadable memory backend. There is deliberately no third
     * `enabled` flag: a job you never want is a job you do not declare, and a job you
     * want on the roster but not running is `suspend: true`.
     */
    suspend: z.boolean().default(false),
    budget: BudgetSchema,
    /**
     * The tier this job's work runs on. Independent of `brain.model` — a job is its own
     * process, not a turn on the agent's brain.
     */
    model: z.string().min(1).optional(),
    /**
     * The job body: a process, an exit code, and a verdict artifact. TypeScript, a shell
     * script, or a compiled binary — the toolkit spawns it and reads what it wrote.
     *
     * This names a process the host spawns, so it sits on the same trust boundary as
     * `mcpServers[].command` and `brains[].command`: a bundle is code-equivalent. Two
     * things follow. The list form is the whole interface — no shell string, so nothing
     * can be word-split or interpolated into one. And the host never builds either field
     * from a channel message, an issue body, or a webhook payload; only the bundle names
     * them.
     *
     * The environment follows the same boundary rather than sitting outside it: a body is
     * built from `passthroughEnv` plus what `env`, `secrets`, and `passthrough` declare, so
     * the gateway's own credential zone does not reach a job that never asked for it. That
     * is the treatment `mcpServers[]` has always had, and the reason for it was never trust
     * — a bundle's MCP server is code-equivalent too — it was blast radius.
     */
    run: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        /** Plain configuration — a path, a mode, a log format. Never a credential. */
        env: z.record(EnvVarName, z.string()).default({}),
        /**
         * Env var name → `secretRef`. Resolved in the host on every run, never inherited.
         *
         * Without this field the manifest cannot state which credentials a body may hold,
         * and the only way to find out is to read the bundle's TypeScript. That matters
         * most here: a job body is the child that shells out — to a coding harness, to a
         * test run, to `gh` — so its reach is the reach of everything it starts.
         */
        secrets: z.record(EnvVarName, SecretRef).default({}),
        /**
         * The same map, for a credential the gateway's own process must not hold. Resolved
         * exactly as `secrets` is — the split is a claim about where the value is mounted,
         * not a second resolver, and a one-directory deployment satisfies both from it.
         * Declaring one refuses `trigger.onRequest` on the same job.
         */
        jobSecrets: z.record(EnvVarName, SecretRef).default({}),
        /**
         * Ambient variables this body inherits, by name. See `passthroughEnv`: a value the
         * platform injects at runtime cannot be written into `env`, so its name is written
         * here instead and the grant stays readable.
         */
        passthrough: z.array(EnvVarName).default([]),
      })
      .strict(),
    /**
     * Values a caller may hand one run of this job, by name. See {@link JobParameterSchema}.
     *
     * The default is none, and none is the safe default: a job that declares no parameters
     * is started by a slug and nothing else, exactly as every job was before this field
     * existed.
     */
    parameters: z.record(ParameterName, JobParameterSchema).default({}),
    /**
     * Where the status post goes. The *shape* is the toolkit's — a one-line verdict at top
     * level, detail in a thread beneath it. The words are the agent's.
     */
    report: z
      .object({
        surface: z.string().min(1),
        channel: z.string().min(1),
        /**
         * Whether a run that proved itself is still said out loud.
         *
         * `unproven`, the default, posts only a run that did not prove itself: a job that
         * found nothing posts nothing. That is right for a job whose purpose is to find
         * things, and wrong for one whose successes are the thing worth saying — a job that
         * opens a pull request every half hour has to encode "I have something to say" as a
         * verdict it did not reach, and its headline then reads `FAILED` over words saying
         * the work went fine.
         *
         * `always` posts whatever the verdict is, so such a job can exit 0 for "this went
         * fine" and still reach the channel. It decouples whether a run speaks from whether
         * it passed, which the detached path already treats as separable, and it moves
         * nothing else: the status word is still minted by the host, a body cannot write one,
         * and a combined verdict still carries no body's words into the headline.
         *
         * `reported` sits between the two, for a job that is both scheduled and reporting:
         * it posts a run whose body wrote a `detail` on some gate, whatever the verdict, and
         * is otherwise the default. A body that writes gates without prose is reporting
         * outcomes the verdict already speaks for; one that writes a `detail` has composed a
         * sentence for a human, and that is the thing worth carrying to a channel. It is not
         * a way to fake a pass — the status word in front of that sentence is still minted
         * from the verdict — and a body that wrote no gates at all is UNKNOWN, so it is
         * announced here as it is under `unproven`.
         *
         * No mode announces a job the switch or a suspension refused. That silence is
         * about a posture somebody chose rather than about a verdict, and the run those
         * modes choose between never happened.
         */
        announce: z.enum(["unproven", "always", "reported"]).default("unproven"),
        /**
         * Whether this job's body may talk through this channel while it runs, rather than
         * only being reported into it when it is over.
         *
         * A job body is spawned with no endpoint, no adapter handle and no credential, and
         * its only channel output is the verdict the host mints from what it wrote. That is
         * the whole shape of a job that *observes* — it reads something, and one verdict
         * comes out. It cannot express a job that **probes**: post into the channel, wait,
         * read the answers back, and mint the verdict from what was actually read. A fleet
         * roll call is the case — whether an agent's chat face is answering is knowable
         * from the channel and from nowhere else, and a Deployment can be `Ready` and green
         * while consuming no events at all.
         *
         * Declared, because it is a capability grant and this manifest is where a body's
         * grants are readable — the same reason `run.secrets` and `run.passthrough` are
         * written down rather than inherited. What it grants is bounded twice and stated
         * here so a reviewer need not read the host: the body may post into **this channel
         * and no other**, and may read back **only a thread the same run rooted**. It
         * cannot name a channel, and it cannot read one.
         *
         * The verdict is unmoved. A probing body writes gates exactly as any other body
         * does, and the status word in front of them is still minted here from what it
         * ran — reading a channel is how it finds its evidence, never how it grades it.
         */
        probe: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  // Resolve the switch key here so no consumer re-derives it. Two derivations of one key
  // is how a reader and a writer end up on different keys.
  .transform((job) => ({
    ...job,
    killSwitch: job.killSwitch
      ? { ...job.killSwitch, key: job.killSwitch.key ?? `mem/${job.slug}/enabled` }
      : undefined,
  }));

const ManifestSchema = z
  .object({
    name: z.string().min(1),
    brain: z
      .object({
        provider: z.enum(["mock", "claude-acp"]),
        /**
         * Pins the model this agent's brain runs on, e.g. `claude-opus-5`.
         *
         * In the manifest rather than the environment because a pin is a decision about
         * one agent that should be reviewable in the bundle diff — an ambient
         * `ANTHROPIC_MODEL` on the host would silently repin every agent it runs, and
         * would be invisible to anyone reading the config. Left unset, the brain uses
         * its own default.
         */
        model: z.string().min(1).optional(),
      })
      // Strict because a misspelt `modle` that parsed would read as a pin nobody made:
      // the bundle diff would show the intent and the agent would run unpinned.
      .strict(),
    persona: z.string().optional(),
    respondTo: z.enum(["owner-only", "allowlist", "anyone", "nobody"]),
    /**
     * Modes this deployment permits at all. An operator sets it once so a later config
     * edit cannot quietly widen who the agent answers; empty means no restriction.
     */
    allowedRespondTo: z.array(z.enum(["owner-only", "allowlist", "anyone", "nobody"])).optional(),
    /**
     * The human this agent answers to, as one ID per surface.
     *
     * One agent is reachable from every surface it declares, and the same person is a
     * different ID on each — an npub on Buzz, a `U…` member ID on Slack. A single string
     * stays valid and simply means an owner on one surface; anywhere else, `owner-only`
     * would lock out the very person it names.
     */
    owner: z
      .preprocess(
        (value) => (typeof value === "string" ? [value] : value),
        z.array(z.string().min(1)).min(1),
      )
      .optional(),
    allowlist: z.array(z.string()).optional(),
    surfaces: z.array(SurfaceSchema).min(1),
    tools: z.string().optional(),
    guard: GuardSchema.prefault({}),
    limits: LimitsSchema.prefault({}),
    ack: AckSchema.prefault({}),
    brains: z.array(BrainSchema).default([]),
    mcpServers: z.array(McpServerSchema).default([]),
    jobs: z.array(JobSchema).default([]),
  })
  .strict()
  // A gate that cannot identify anyone admits nobody, so refuse the config at load
  // rather than discovering it at 3am.
  .refine((m) => !m.allowedRespondTo?.length || m.allowedRespondTo.includes(m.respondTo), {
    message: "respondTo is not among allowedRespondTo — this deployment forbids that mode",
  })
  // A pin under the mock brain is a line that claims a model is in force when nothing
  // runs one — the same failure `.strict()` refuses a misspelt key for.
  .refine((m) => m.brain.provider === "claude-acp" || !m.brain.model, {
    message: "brain.model requires brain.provider: claude-acp — the mock brain runs no model",
    path: ["brain", "model"],
  })
  .refine((m) => m.respondTo !== "owner-only" || !!m.owner, {
    message: "respondTo: owner-only requires `owner`",
  })
  .refine((m) => m.respondTo !== "allowlist" || (m.allowlist?.length ?? 0) > 0, {
    message: "respondTo: allowlist requires a non-empty `allowlist`",
  })
  .refine(
    (m) =>
      m.brains.every(
        (brain) =>
          !("age" in brain && brain.age) ||
          (!("command" in brain && brain.command) && !("args" in brain && brain.args?.length)),
      ),
    {
      message: "age-encrypted vaults use the built-in gateway-hosted brain server; command and args are not allowed",
      path: ["brains"],
    },
  )
  .refine(
    (m) =>
      m.brains.every(
        (brain) => brain.preset !== "shared" || brain.scope.includes(m.name),
      ),
    {
      message: "a shared brain's scope must include this agent's name",
      path: ["brains"],
    },
  )
  .refine(
    (m) => {
      const scopes = m.brains
        .filter((brain) => brain.preset === "shared")
        .map((brain) => [...brain.scope].sort().join("\0"));
      return new Set(scopes).size === scopes.length;
    },
    {
      message: "shared brain scopes must be unique",
      path: ["brains"],
    },
  )
  .refine(
    (m) =>
      !m.brains.some((brain) => brain.preset === "private") ||
      m.surfaces.filter((surface) => surface.kind === "buzz").length === 1,
    {
      message: "a private brain requires exactly one Buzz surface (it is bound to that relay and identity)",
      path: ["brains"],
    },
  )
  .refine(
    (m) => m.brains.filter((brain) => brain.preset === "private").length <= 1,
    {
      message: "an agent may configure only one private brain",
      path: ["brains"],
    },
  )
  // Refused rather than tolerated because a second one is not addressable: every team
  // brain wires to the `team-brain` MCP server, so two collide on that name and on the
  // single `mcp__team-brain__team_search` the policy admits. Accepting the config would
  // mean one team's knowledge silently shadowing the other's — and a `doctor` that
  // reported on a credential no search would ever use.
  .refine(
    (m) => m.brains.filter((brain) => brain.preset === "team").length <= 1,
    {
      message: "an agent may configure only one team brain — a second would wire to the same MCP server and be unreachable",
      path: ["brains"],
    },
  )
  // The slug is the job name, the switch key, and the run record's key. Two jobs sharing
  // one would collide on all three, and the second would look like a rerun of the first.
  .refine((m) => new Set(m.jobs.map((job) => job.slug)).size === m.jobs.length, {
    message: "job slugs must be unique — a slug names the job, the switch, and the run record",
    path: ["jobs"],
  })
  // The fleet's `cron-agent-kill-switch` invariant, moved somewhere a non-Kubernetes
  // consumer also gets it: nothing that runs with no human watching may be unstoppable
  // without a deploy. Refused at load, not discovered at 3am.
  .refine(
    (m) =>
      m.jobs.every(
        (job) => job.killSwitch || !(job.trigger.schedules.length > 0 || job.trigger.webhook),
      ),
    {
      message:
        "a job with an unattended trigger (schedules or webhook) must declare a killSwitch",
      path: ["jobs"],
    },
  )
  // Nothing else can supply one. `tick` and `webhook` pass no values and have none to pass,
  // so a parameter on a job no caller may ask for is a field that can never be filled.
  .refine(
    (m) =>
      m.jobs.every((job) => Object.keys(job.parameters).length === 0 || job.trigger.onRequest),
    {
      message:
        "a job that declares parameters must arm `trigger.onRequest` — nothing else can " +
        "give it a value",
      path: ["jobs"],
    },
  )
  // A clock has no target to give, and neither has a webhook — `webhook(job)` carries no
  // payload. A job that requires a value and also takes one of those triggers is a job whose
  // every unattended run would be refused for a value nothing was there to supply.
  .refine(
    (m) =>
      m.jobs.every(
        (job) =>
          !Object.values(job.parameters).some((p) => p.required) ||
          !(job.trigger.schedules.length > 0 || job.trigger.webhook),
      ),
    {
      message:
        "a job with a required parameter may only be started on request — a schedule and a " +
        "webhook have no target to give it",
      path: ["jobs"],
    },
  )
  // A `jobSecrets` ref is one a deployment keeps out of the gateway's own secrets directory,
  // and `onRequest` is the only trigger the gateway serves: every other one enters through
  // `sageox-agent job run`, a separate process the target may hand a second directory. So a
  // job arming both resolves that ref on every tick and cannot on the one path a person
  // uses. Refused where the pairing is written, because nothing the run can see differs —
  // only which process the deployment started it in.
  .superRefine((m, ctx) => {
    for (const job of m.jobs) {
      const moved = Object.values(job.run.jobSecrets);
      if (!moved.length || !job.trigger.onRequest) continue;
      ctx.addIssue({
        code: "custom",
        message:
          `job "${job.slug}" arms trigger.onRequest and declares ${moved.join(", ")} in ` +
          "run.jobSecrets — an on-request run executes in the gateway's own process, which " +
          "is not given that directory, so it would fail on that ref. Drop onRequest, move " +
          "the ref to run.secrets and take the weaker guarantee knowingly, or give the " +
          "credentialed work a job of its own that nothing may ask for",
        path: ["jobs"],
      });
    }
  })
  // `envelope` merges the two maps, so a name in both would silently take whichever landed
  // last — and which map a ref is in is what the rule above reads.
  .superRefine((m, ctx) => {
    for (const job of m.jobs) {
      const both = Object.keys(job.run.jobSecrets).filter((name) => name in job.run.secrets);
      if (!both.length) continue;
      ctx.addIssue({
        code: "custom",
        message:
          `job "${job.slug}" declares ${both.join(", ")} in both run.secrets and ` +
          "run.jobSecrets — one variable comes from one place",
        path: ["jobs"],
      });
    }
  })
  // The soft switch is a value in the agent's memory, resolved through a brain it already
  // declares rather than a bespoke transport. With no brain there is nothing to read, so
  // the switch would silently be the fail-direction and nothing else.
  .refine((m) => !m.jobs.some((job) => job.killSwitch) || m.brains.length > 0, {
    message: "a job's killSwitch is read through one of the agent's brains — declare one",
    path: ["jobs"],
  })
  // An entry that matches no declared surface is a report the operator believes is going
  // somewhere. Same rule, and same reason, as `guard.publicChannels`.
  .refine(
    (m) =>
      m.jobs.every((job) => {
        const surface = job.report?.surface;
        return !surface || m.surfaces.some((declared) => declared.kind === surface);
      }),
    {
      message: "jobs[].report.surface must name a surface this agent declares",
      path: ["jobs"],
    },
  )
  // Two entries for one id are two answers to "may it speak publicly here", and the guard
  // would take whichever the derivation reached first. The single-list shape exists so that
  // question has one answer; this is the one way left to write two.
  .refine(
    (m) =>
      m.surfaces.every(
        (surface) => new Set(surface.channels.map((c) => c.id)).size === surface.channels.length,
      ),
    {
      message: "a surface must not list the same channel id twice",
      path: ["surfaces"],
    },
  )
  // The consent the guard enforces, derived rather than authored. `evaluateEgress` needs a
  // set of destinations and the operator needs one place to say it; deriving here is what
  // keeps those from being two lists that drift.
  .transform((m) => ({
    ...m,
    guard: { ...m.guard, publicChannels: publicReplyTargets(m.surfaces) },
  }));

/** The `<surface>:<id>` destinations this manifest consents to answering publicly in. */
function publicReplyTargets(surfaces: readonly Surface[]): string[] {
  return surfaces.flatMap((surface) =>
    surface.channels.filter((c) => c.reply === "public").map((c) => `${surface.kind}:${c.id}`),
  );
}

export type AgentManifest = z.infer<typeof ManifestSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type ChannelDecl = z.infer<typeof ChannelSchema>;
/**
 * What the egress guard reads. `publicChannels` is derived from the surfaces at load — it is
 * not a key anyone writes, and `GuardSchema` is strict so an attempt to write it is refused.
 */
export type GuardConfig = z.infer<typeof GuardSchema> & { publicChannels: string[] };
/** One compiled pattern, carried to every place a scan runs — chat egress and GitHub writes. */
export type LeakPattern = z.infer<typeof LeakPatternSchema>;
export type LimitsConfig = z.infer<typeof LimitsSchema>;
export type AckConfig = z.infer<typeof AckSchema>;
export type BrainConfig = z.infer<typeof BrainSchema>;
export type JobConfig = z.infer<typeof JobSchema>;
export type JobArchetype = JobConfig["archetype"];
/** Whether a job's status post is gated on the verdict. See the `report.announce` field. */
export type JobAnnounce = NonNullable<JobConfig["report"]>["announce"];

/**
 * Names the keys that used to say where an agent may speak, so a config written against
 * them is refused by its real problem rather than by a symptom.
 *
 * Zod's own report for such a file is true and useless — "Expected object, received string"
 * at `surfaces.0.channels.0`, plus an unrecognized key for every guard entry. This is the
 * one place that knows the old spellings, and it exists to be deleted once nothing is
 * running them.
 */
function refuseRetiredChannelKeys(raw: unknown): void {
  const doc = (raw ?? {}) as { surfaces?: unknown; guard?: unknown };
  const surfaces = Array.isArray(doc.surfaces) ? (doc.surfaces as Record<string, unknown>[]) : [];
  const guard = (doc.guard ?? {}) as Record<string, unknown>;
  const retired = [
    ...surfaces.flatMap((surface) =>
      ["privateChannels", "channelNames"].filter((key) => surface && key in surface),
    ),
    ...(surfaces.some(
      (surface) =>
        Array.isArray(surface?.channels) &&
        (surface.channels as unknown[]).some((entry) => typeof entry === "string"),
    )
      ? ["channels as a list of ids"]
      : []),
    ...["noPublicChannels", "publicChannels", "channelAllowlist"]
      .filter((key) => key in guard)
      .map((key) => `guard.${key}`),
  ];
  if (!retired.length) return;

  throw new Error(
    `${[...new Set(retired)].join(", ")}: retired. A surface now carries one list, and each ` +
      "entry says whether the agent answers there in public or in private — a `public` entry " +
      "is the consent the guard used to read from `guard.publicChannels`:\n\n" +
      "  surfaces:\n" +
      "    - kind: buzz\n" +
      "      channels:\n" +
      "        - { id: C0123, name: eng-ops, reply: private }\n" +
      "        - { id: C0456, name: town-square, reply: public }\n\n" +
      "A channel the agent should not answer in is one to leave out of the list.",
  );
}

export function loadManifest(yamlText: string): AgentManifest {
  const raw = parseYaml(yamlText); // data only — never executed
  refuseRetiredChannelKeys(raw);
  return ManifestSchema.parse(raw);
}
