import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { devNull, homedir } from "node:os";
import { opendir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  mcpToolServer,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type ServeOptions,
} from "./mcp-http.ts";
import { probeOk, probeUnavailable, probeWarming, type ProbeFailure, type ProbeResult } from "./health.ts";
import { createLedgerSync, type LedgerRemote } from "./ledger-sync.ts";
import { passthroughEnv } from "./brain-env.ts";

const run = promisify(execFile);

/** One tool: what the brain is told, and the gateway half that answers it. */
export interface TeamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ox: TeamOx, args: Record<string, unknown>) => Promise<string>;
}

/** Bounded here rather than by whatever the corpus holds: a passage is read into a turn. */
const MAX_PASSAGES = 20;

const SearchArgs = z.object({
  query: z.string({ error: "query is required — ask in plain words" }).min(1),
  limit: z.number().int().positive().max(MAX_PASSAGES).default(5),
});

const StatusArgs = z.strictObject({});
const SessionsArgs = z.strictObject({
  repo: z.string().min(1).max(200),
  limit: z.number().int().positive().max(20).default(10),
});
const RecentArgs = SessionsArgs.extend({
  hours: z.number().int().positive().max(168).default(72),
});
const ProjectConfig = z.object({
  repo_id: z.string().min(1),
  team_id: z.string().min(1),
  endpoint: z.string().optional(),
});
const LedgerLocation = z.object({
  ledger: z.object({ configured: z.boolean(), exists: z.boolean(), path: z.string().optional() }),
});
// The receipt `ox sync --read-only --json` prints on success and failure alike. ox may add
// fields and failure classes within schema version 1. Reads are authorized against the
// endpoint a ready receipt names, so one without it is not a usable success, and a receipt
// that is not ready must name its failure class to be read as a failure.
const ReadSyncResult = z.object({
  schema_version: z.literal(1),
  endpoint: z.string().optional(),
  ready: z.boolean(),
  last_successful_sync: z.string().nullish(),
  error_class: z.string().optional(),
  resumable: z.boolean().optional(),
}).refine((receipt) => receipt.ready ? Boolean(receipt.endpoint) : Boolean(receipt.error_class));
type ReadSyncResult = z.infer<typeof ReadSyncResult>;
const SessionsResponse = z.object({
  repo_id: z.string(),
  ledger_available: z.boolean(),
  total: z.number().int().nonnegative(),
  sessions: z.array(z.object({
    name: z.string(),
    date: z.string(),
    time: z.string(),
    status: z.string(),
    user: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    recording: z.boolean().optional(),
    entry_count: z.number().int().nonnegative().optional(),
    hydration_status: z.string().optional(),
  })),
}).refine((value) => value.total >= value.sessions.length);
// Free text is data from other coworkers. Bound it and omit ox's generated instructions.
const ActivityText = z.string().transform((value) => value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
const RecentResponse = z.object({
  repo: z.string(),
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  authors: z.array(z.object({
    murmurs: z.array(z.object({
      id: z.string().max(500),
      user: z.string().max(500),
      time: z.iso.datetime({ offset: true }),
      topic: z.string().max(500),
      content: ActivityText,
    })).nullable(), // Session-only authors have a null murmur slice in ox 0.14.3.
    sessions: z.array(z.object({
      name: z.string().max(500),
      user: z.string().max(500),
      time: z.iso.datetime({ offset: true }),
      title: ActivityText,
      summary: ActivityText.optional(),
      recording: z.boolean().optional(),
    })).optional(),
  })),
  stats: z.object({
    total_authors: z.number().int().nonnegative(),
    total_murmurs: z.number().int().nonnegative(),
    total_sessions: z.number().int().nonnegative().default(0),
  }),
}).refine(({ authors, stats }) => stats.total_authors === authors.length &&
  stats.total_murmurs === authors.reduce((sum, author) => sum + (author.murmurs?.length ?? 0), 0) &&
  stats.total_sessions === authors.reduce((sum, author) => sum + (author.sessions?.length ?? 0), 0));
const MAX_LEDGER_AGE_MS = 5 * 60_000;
const LEDGER_UNAVAILABLE = "This repository's ledger could not be verified. Check its SageOx team binding and ledger sync; this is not an empty session list or activity window.";
const LEDGER_STALE = "This repository's ledger has no successful refresh within five minutes. Session history and recent activity may be incomplete; wait for ledger sync to recover.";
const LEDGER_FRESH = "This repository's ledger has a successful refresh within five minutes.";
// Older read sync leaves objects unhydrated under server backpressure, rejects files whose
// bytes look like a pointer, and needs most of an hour for a warm refresh of a large ledger.
const MIN_OX_VERSION = [0, 17, 0];
// One attempt's budget. A first sync of a large ledger outlasts it; ox keeps the transferred
// objects and the next attempt resumes from them.
const LEDGER_SYNC_BUDGET = "30m";
// A precondition, such as a ledger path ox cannot claim, fails the same way on every attempt,
// so the wait after a repeated failure grows to this.
const MAX_SYNC_WAIT_MS = 30 * 60_000;
// ox 0.17.0's read sync keeps murmurs only for the hour of its last sync and the eleven before
// it, and glance skips an hour the checkout does not hold, so a team-token checkout is only
// sure to hold the last 11 hours of work updates.
const SYNCED_UPDATE_HOURS = 11;
const LEDGER_FIRST_SYNC = "This repository's first ledger sync has not finished. A large ledger's first sync can take most of an hour; each attempt resumes where the last one stopped.";
const LEDGER_DENIED = "SageOx refused this gateway's credential for ledger sync. It needs a current team access token (oxt_) with access to this repository; sync retries when the mounted credential changes or the gateway restarts.";
const LEDGER_NOT_OFFERED = "SageOx did not offer this repository's ledger to this gateway's team token. Ledger reads may not be enabled for the team, or the repository has no ready ledger.";
const LEDGER_INCOMPLETE = "Some of this ledger's objects could not be downloaded, so it is not served. The gateway log names them; an object SageOx refuses stays missing until it is repaired.";
const LEDGER_PARTIAL = "ox found this repository's ledger checkout missing part of its history or of the paths it must hold, so it is not served. The gateway log names which; sync retries, less often while the same failure repeats.";
const LEDGER_DIRTY = "ox will not refresh this repository's ledger checkout because it holds content ox did not write. An operator must inspect the gateway's data directory.";
const LEDGER_SYNC_FAILED = "The last ledger sync failed, and the gateway log names the failure. Sync retries, less often while the same failure repeats.";
const LEDGER_OX_TOO_OLD = `Ledger sync needs ox ${MIN_OX_VERSION.join(".")} or newer, and this gateway's ox is older or reported no version.`;
const LEDGER_NOT_AUTHORIZED = "SageOx did not confirm this gateway's current access to this repository, so its local ledger is not served. This is not an empty session list or activity window.";
const LEDGER_UNREAD = "This repository's ledger could not be read in this call, most likely because a refresh held it. This is not an empty session list or activity window; ask again shortly.";
const SearchResponse = z.object({
  team_context: z.object({
    results: z.array(z.object({
      score: z.number(),
      text: z.string(),
      doc_type: z.string().optional(),
      file_path: z.string().optional(),
      source_type: z.string().optional(),
      source_id: z.string().optional(),
    })),
  }),
});

/**
 * The team brain: the team's own knowledge, reached through `ox`.
 *
 * **Every tool here reads.** That is a property of the tools, not a promise about the
 * server: a write verb would be armed one name at a time in the tool policy, and nothing in
 * this file forecloses one. What will not change is the discipline around it. Write authority tightens as scope widens, this is the widest scope
 * there is, and channel content is untrusted: an agent that can write to team memory is an
 * agent whose worst turn becomes a fact a human cites six months later. So a write lands
 * one verb at a time, never as a wildcard.
 *
 * It is also the only brain that is non-empty on day one: local, private and shared all
 * start blank, so a new agent is amnesiac for weeks. This one predates the agent.
 *
 * Unlike a vault brain, this is not key-value: there is no key to `get`. You ask in words
 * and get passages back with their sources.
 *
 * **Typed tools rather than `Bash(ox …)`.** A prefix-matched command allowlist cannot
 * express "no `--file`", and a real leak was measured through `ox decision enrich --file`,
 * which printed the contents of a planted secret into a channel reply. Here the gateway
 * builds the argv and the tool takes named fields, so there is no flag to smuggle — the
 * flag-audit discipline stops being a standing human obligation and becomes a property of
 * the interface.
 *
 * `team_sessions` reads only repositories configured in the gateway, and only a ledger the
 * gateway synced within five minutes; code-index readiness is not that evidence. A read
 * first asks SageOx whether the mounted credential may read that exact repository, because
 * a team token can outlive a repository's link to its team, then reads through ox's guarded
 * reader, which holds the checkout lock against a refresh. A `ledgerSync` repository instead
 * keeps the gateway's own Git checkout, where `ox session list` prints
 * `{"sessions": [], "ledger_available": false}` and exits 0 without a clone, so that reader
 * checks availability again after the command. Missing and stale data are refused rather
 * than described as an empty week. `team_recent` uses the same checks
 * for bounded murmur/session activity. It always supplies an explicit time window, so
 * ox's local glance checkpoint never decides what this caller sees.
 *
 * `team_kb_list` and `team_kb_show` were served here until knowledge bubbles stopped being
 * a feature anyone maintains. `ox conversation` reads the same shape of thing — a listing
 * to scan, then one item's summary — and is the obvious replacement, but it needs the same
 * synced team-context checkout, which the ledger probe does not establish: with none it answers
 * `{"success": false, "error": {"code": "no_team_context"}}`. It is a better candidate than
 * an unchecked session list for having an honest failure to check rather than an empty
 * list to misread, and it stays out until its own checkout is verified.
 *
 * `team_search` needs no checkout: `ox query` is answered server-side from the token.
 * `team_status` checks that same access and each configured ledger. It returns a fixed
 * projection of the metadata, never raw `ox status` output or credential details.
 */
export const TEAM_TOOLS: readonly TeamTool[] = [
  {
    name: "team_search",
    description:
      "Search the team's indexed knowledge — discussions, decisions, docs, plans, and assistant-chat sessions. " +
      "Use it before answering from first principles about how this team does something; the answer " +
      "may already exist. Returns passages with their sources and dates. Read-only. " +
      "Results are ranked by relevance, never by date, and there is no way to filter by time: " +
      "old results mean your wording matched old material, not that nothing recent exists. " +
      "Never infer from one search how current the team's knowledge is — search again with " +
      "different words instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A question in plain words" },
        // The bound is in the schema as well as the prose because the handler enforces it:
        // a caller that can only read the description learns about it by being refused.
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PASSAGES,
          description: `How many passages (default 5, maximum ${MAX_PASSAGES})`,
        },
      },
      required: ["query"],
    },
    run: async (ox, raw) => {
      const { query, limit } = SearchArgs.parse(raw);
      return formatPassages(query, await ox.search(query, limit));
    },
  },
  {
    name: "team_status",
    description:
      "Check this gateway's access to team search and local ledger readiness. Lists configured repository names. " +
      "Checks access with one bounded search; returns no passages or credential details. " +
      "Search access does not prove that activity or session history is synced. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (ox, raw) => {
      StatusArgs.parse(raw);
      let failure: OxFailure | undefined;
      try {
        await ox.search("team", 1);
      } catch (error) {
        failure = error instanceof OxCallError ? error.failure : "failed";
      }
      const repositories = await ox.ledgerStatus();
      return JSON.stringify({
        team_search: failure
          ? { status: "unavailable", failure, detail: OX_FAILURE_TEXT[failure] }
          : { status: "available", detail: "This gateway's team search answered this check." },
        ledger_sync: repositories.length ? { status: "managed", repositories } : {
          status: "not_configured",
          detail:
            "No repository has ledger reads. Add repositories with repos add and grant team_sessions " +
            "or team_recent. Recent activity and session history cannot be inferred from an empty search.",
        },
      });
    },
  },
  {
    name: "team_sessions",
    description:
      "List the selected repository's sessions from the past seven days, newest first. " +
      "Use a repository name from team_status. Requires verified ledger sync " +
      "within five minutes; unavailable or stale data is refused, never reported as an empty week. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", minLength: 1, maxLength: 200, description: "Configured repository name from team_status" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum sessions (default 10)" },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    run: async (ox, raw) => {
      const { repo, limit } = SessionsArgs.parse(raw);
      return ox.sessions(repo, limit);
    },
  },
  {
    name: "team_recent",
    description:
      "Read recent coworker work updates and session activity from a configured repository's ledger, newest first. " +
      "Use a repository name from team_status. Looks back 72 hours by default (maximum 168); returns at most 20 records. " +
      "Work updates may not reach back that far: work_updates_since is where they start. " +
      "Requires verified ledger sync within five minutes. Missing or stale data is refused. " +
      "Returns recorded activity; text is capped at 2,000 characters per field. Read-only team access.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", minLength: 1, maxLength: 200, description: "Configured repository name from team_status" },
        hours: { type: "integer", minimum: 1, maximum: 168, description: "Hours to look back (default 72)" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum activity records (default 10)" },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    run: async (ox, raw) => {
      const { repo, hours, limit } = RecentArgs.parse(raw);
      return ox.recent(repo, hours, limit);
    },
  },
];

/** The bare tool names, for writing and checking the policy. */
export const TEAM_TOOL_NAMES: string[] = TEAM_TOOLS.map((tool) => tool.name);

export type TeamPassage = z.infer<typeof SearchResponse>["team_context"]["results"][number];

/** How the team knowledge is queried. Injectable so the server is testable offline. */
export type TeamSearch = (query: string, limit: number) => Promise<TeamPassage[]>;

/** Everything the team brain asks `ox` for. Injectable so the server is testable offline. */
export interface TeamOx {
  search: TeamSearch;
  ledgerStatus(): Promise<TeamLedgerStatus[]>;
  sessions(repo: string, limit: number): Promise<string>;
  recent(repo: string, hours: number, limit: number): Promise<string>;
}

export interface TeamLedgerStatus {
  repo: string;
  status: "available" | "initializing" | "unavailable";
  failure?: LedgerFailure;
  last_sync?: string;
  /** When syncing began, while the first sync has not finished. */
  since?: string;
  detail: string;
}

type LedgerFailure = "ledger-unavailable" | "ledger-stale" | "not-authenticated" | "not-installed";

const LEDGER_REMEDY: Record<LedgerFailure, string> = {
  "ledger-unavailable": "check SageOx ledger sync and its configured credential for this repository",
  "ledger-stale": "check SageOx ledger sync and its configured credential for this repository",
  "not-authenticated": "mount a current SageOx team access token (oxt_) with access to this repository",
  "not-installed": `install ox ${MIN_OX_VERSION.join(".")} or newer in this agent's image, then restart`,
};

/** What the gateway knows about a ledger it syncs over the team token. */
interface HostedLedger {
  since: string;
  /** Undefined before the first attempt; null when the checkout is not bound to this team. */
  repoId?: string | null;
  /** The latest completed `ox sync --read-only`. */
  last?: ReadSyncResult;
  /** Remote observation time of the latest successful sync. */
  lastSync?: string;
  /** Fingerprint of the credential ox last refused. */
  refused?: string;
}

/** Turns a reader's output into the tool's reply, or throws. */
type Reply = (out: unknown, repoId: string, lastSync: string | undefined) => Promise<string>;

/** A remote observation time, when it parses and is not in the future. */
function observedAt(value: string | null | undefined): string | undefined {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) && at <= Date.now() ? new Date(at).toISOString() : undefined;
}

function isFresh(lastSync: string | undefined): boolean {
  const age = Date.now() - Date.parse(lastSync ?? "");
  return age >= 0 && age < MAX_LEDGER_AGE_MS;
}

export interface TeamRepository {
  name: string;
  path: string;
  url: string;
}

/**
 * The ox-backed surface, plus the capability health its own lookups measure.
 *
 * Health is not on {@link TeamOx} because {@link teamBrainHandler} never reads it. What
 * the brain is told about a failed lookup is the per-turn sentence in
 * {@link OX_FAILURE_TEXT}; the latched reading is for the gateway's capability closure and
 * the operator's terminal, which are the two places that sentence never reaches.
 */
export interface TeamBrain extends TeamOx {
  /** Optional background refresh. Startup failure degrades ledgers, never chat. */
  startSync(): Promise<void>;
  stopSync(): Promise<void>;
  /**
   * One lookup at launch, so a credential that is already dead at deploy time is no more
   * silent than one revoked later. Nothing else in `run` checks: `oxStatus()` is called
   * only by `init` and `doctor`, and a deployment runs neither.
   *
   * Never throws — the outcome is the reading.
   */
  probe(): Promise<void>;
  /**
   * This brain's capability health, live, as the closure handed to `Gateway` wants it.
   * Empty until a lookup has happened: a reading before then would be a claim about a
   * credential nothing has tried.
   */
  readings(): readonly ProbeResult[];
}

/**
 * Builds the ox-backed team surface, bound to one team.
 *
 * This runs in the gateway, so the credential stays on this side of the boundary; the
 * brain never sees it.
 */
export function makeOxTeam(scope: OxScope = {}): TeamBrain {
  // A team brain always speaks for an agent, so without a token provider it gets no
  // credential at all rather than the operator's; see oxEnv.
  scope = { ...scope, token: scope.token ?? (() => undefined) };
  const remotes = scope.ledgerSync ?? [];
  if (remotes.length && (!scope.dataHome || remotes.some((remote) =>
    scope.repositories?.filter((repo) => repo.name === remote.repo).length !== 1))) {
    throw new Error("ledgerSync requires an isolated data home and names from the configured repository list.");
  }
  const sync = remotes.length ? createLedgerSync(scope.dataHome!, remotes) : undefined;
  let syncFailure: string | undefined;
  const isLegacy = (repo: TeamRepository) => remotes.some((remote) => remote.repo === repo.name);
  // Serializes a `ledgerSync` repository's reads with its refresh; ox's checkout lock does
  // the same for every other repository.
  const read = <T>(work: () => Promise<T>): Promise<T> => sync ? sync.exclusive(work) : work();
  // Every other configured repository syncs through ox over the team token, and only when a
  // reader is granted: a first sync transfers every object its ledger covers.
  const hosted = new Map<string, HostedLedger>(
    (scope.syncLedgers && scope.dataHome ? scope.repositories ?? [] : [])
      .filter((repo) => !isLegacy(repo))
      .map((repo) => [repo.name, { since: new Date().toISOString() }]),
  );
  const ledgerRepos = (scope.repositories ?? []).filter((repo) => isLegacy(repo) || hosted.has(repo.name));
  const stopping = new AbortController();
  let hostedLoops: Promise<void> | undefined;
  let oxTooOld = false;
  let reading: ProbeResult | undefined;
  const ledgerReadings = new Map<string, { status: TeamLedgerStatus; lookup: number }>();
  let ledgerLookup = 0;
  // Which lookup's outcome `reading` currently holds. Completion order is not start order:
  // the launch probe runs alongside the first turns, and `ChannelQueue` runs one turn per
  // channel rather than one at a time, so two lookups can be in flight. A slow older `Ok`
  // landing after a newer auth failure would restore exactly the silence this reading
  // exists to break, so an outcome is dropped when something newer has already recorded.
  let started = 0;
  let recorded = 0;

  const search: TeamSearch = async (query, limit) => {
    const lookup = ++started;
    const record = (result: ProbeResult) => {
      if (lookup < recorded) return;
      recorded = lookup;
      reading = result;
    };
    const args = ["query", query, "--json", "--limit", String(limit)];
    if (scope.team) args.push("--team", scope.team);
    if (scope.repo) args.push("--repo", scope.repo);
    let out: unknown;
    try {
      out = await runOx(args, scope, oxCwd(scope));
    } catch (error) {
      if (error instanceof OxCallError) {
        const latch = LATCHED[error.failure];
        if (latch) {
          // `reason` is the same sentence the failed lookup itself hands the brain, not a
          // second wording of it: both reach a turn, and two spellings of one fact drift
          // into the agent hearing one thing per lookup and another from its capability
          // block.
          record(
            probeUnavailable(
              TEAM_CAPABILITY,
              latch.failure,
              latch.remedy,
              OX_FAILURE_TEXT[error.failure],
            ),
          );
        }
      }
      throw error;
    }
    // Valid JSON alone is not an answer: an error envelope or a changed schema must not
    // become an empty search and a successful access check.
    const parsed = SearchResponse.safeParse(out);
    if (!parsed.success) throw oxFailed("query", "unreadable", "unexpected search response shape");
    // An answer is the proof: ox ran, the credential was accepted, and whatever was latched
    // before is over. Zero passages is still `Ok` and never `Empty` — `ox query` reports no
    // corpus size, and one query matching nothing is also what a team with plenty written
    // down returns to unlucky wording.
    record(probeOk(TEAM_CAPABILITY, "team memory answered this gateway's last lookup"));
    return parsed.data.team_context.results;
  };

  /** Keep newer ledger verdicts when concurrent lookups finish out of order. */
  const recordLedger = (status: TeamLedgerStatus, lookup: number): TeamLedgerStatus => {
    if ((ledgerReadings.get(status.repo)?.lookup ?? 0) <= lookup) {
      ledgerReadings.set(status.repo, { status, lookup });
    }
    return status;
  };

  /**
   * The checkout's tracked SageOx binding, when the checkout is the configured one and the
   * binding names this brain's team. The cwd comes from repos.conf, never from tool arguments.
   */
  const binding = async (repo: TeamRepository) => {
    try {
      const origin = await run("git", ["remote", "get-url", "origin"], {
        cwd: repo.path, timeout: 30_000,
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      });
      if (origin.stdout.trim() !== repo.url) return undefined;
      const config = ProjectConfig.parse(JSON.parse(await readFile(join(repo.path, ".sageox/config.json"), "utf8")));
      // The id reaches ox's argv and, for `ledgerSync`, a path under the data home.
      if (config.team_id !== scope.team || (scope.repo && config.repo_id !== scope.repo) ||
          !/^repo_[A-Za-z0-9_-]+$/.test(config.repo_id)) {
        return undefined;
      }
      return config;
    } catch {
      return undefined;
    }
  };

  /** Verify a `ledgerSync` repository's binding and a fresh matching receipt, optionally refreshing it first. */
  const inspectLedger = async (repo: TeamRepository, refresh = false) => {
    const lookup = ++ledgerLookup;
    let repoId: string | undefined;
    let status: TeamLedgerStatus = {
      repo: repo.name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE,
    };
    try {
      const config = await binding(repo);
      // ox runs in this checkout below, so a foreign endpoint must not select an ambient
      // disk login.
      if (!config || (config.endpoint && config.endpoint.replace(/\/$/, "") !== "https://sageox.ai")) {
        return { status: recordLedger(status, lookup), lookup };
      }
      repoId = config.repo_id;
      // ox 0.14.3's canonical ledger directory. Never adopt an operator-owned clone.
      const path = join(scope.dataHome!, "sageox", "sageox.ai", "ledgers", repoId);
      if (refresh) await sync!.pull(repo.name, path).catch(() => {});
      const managed = sync!.receipt(repo.name);
      if (!managed?.last_sync) {
        status.detail = managed?.detail ?? syncFailure ?? "The gateway has not successfully refreshed this ledger yet.";
        return { status: recordLedger(status, lookup), repoId, lookup };
      }
      const location = LedgerLocation.parse(await runOx(["status", "--json"], scope, repo.path)).ledger;
      if (!location.configured || !location.exists || !location.path) return { status: recordLedger(status, lookup), lookup };
      // Match the ledger that this cwd's read commands actually resolve to the one refreshed.
      if (await realpath(managed.path) !== await realpath(location.path)) {
        return { status: recordLedger(status, lookup), lookup };
      }
      // ox 0.14.3 ignores ledger ListSessions errors. Verify directory readability so
      // permission failures cannot become an empty week. No sessions directory is normal
      // for a freshly synced empty ledger; ox creates it when listing.
      try {
        await (await opendir(join(location.path, "sessions"))).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const last_sync = observedAt(managed.last_sync);
      status = { ...status, failure: "ledger-stale", detail: LEDGER_STALE, ...(last_sync ? { last_sync } : {}) };
      if (isFresh(last_sync)) status = { repo: repo.name, status: "available", last_sync, detail: LEDGER_FRESH };
    } catch {
      // Paths, config parse errors and ox diagnostics are never copied into a turn.
    }
    return { status: recordLedger(status, lookup), repoId, lookup };
  };

  /** Where a hosted ledger stands after its latest completed sync. Reads nothing. */
  const hostedStatus = (name: string): TeamLedgerStatus => {
    const ledger = hosted.get(name)!;
    const last = ledger.last;
    const last_sync = observedAt(ledger.lastSync);
    const unavailable = (detail: string, failure: LedgerFailure = "ledger-unavailable"): TeamLedgerStatus =>
      ({ repo: name, status: "unavailable", failure, detail, ...(last_sync ? { last_sync } : {}) });
    if (oxTooOld) return unavailable(LEDGER_OX_TOO_OLD, "not-installed");
    if (ledger.repoId === null) return unavailable(LEDGER_UNAVAILABLE);
    // ox reports `resumable` only while no checkout is published: a first sync, or a clone that
    // replaces a checkout removed after an earlier success.
    if (!last || (last.error_class === "interrupted" && last.resumable)) {
      return { repo: name, status: "initializing", since: ledger.since, detail: LEDGER_FIRST_SYNC };
    }
    if (last.ready && !last.error_class) {
      return isFresh(last_sync)
        ? { repo: name, status: "available", last_sync, detail: LEDGER_FRESH }
        : unavailable(LEDGER_STALE, "ledger-stale");
    }
    switch (last.error_class) {
      case "denied": return unavailable(LEDGER_DENIED, "not-authenticated");
      case "unavailable": case "missing_ledger": return unavailable(LEDGER_NOT_OFFERED);
      case "missing_hydration": return unavailable(LEDGER_INCOMPLETE);
      case "incomplete_history": case "incomplete_coverage": return unavailable(LEDGER_PARTIAL);
      case "dirty": return unavailable(LEDGER_DIRTY);
      default: return unavailable(LEDGER_SYNC_FAILED);
    }
  };

  /**
   * One `ox sync --read-only` with the credential mounted now. Returns what the operator log
   * shows of a failed attempt: its receipt, which ox keeps credentials out of, or, when ox
   * printed no receipt, how it exited and what it wrote.
   */
  const refreshHosted = async (repo: TeamRepository): Promise<string | undefined> => {
    const ledger = hosted.get(repo.name)!;
    const token = scope.token?.();
    const fingerprint = createHash("sha256").update(token ?? "").digest("hex");
    // A refused credential is not offered again every minute; a replaced mount is tried at once.
    if (ledger.refused === fingerprint) return undefined;
    const repoId = (await binding(repo))?.repo_id ?? null;
    if (repoId !== ledger.repoId) Object.assign(ledger, { repoId, last: undefined, lastSync: undefined });
    if (!repoId || stopping.signal.aborted) return undefined;
    // Settles when ox exits, which on shutdown is after SIGTERM has let it stop its Git
    // children and release the checkout. A failed sync still prints its receipt.
    const { stdout, stderr, exit } = await new Promise<{ stdout: string; stderr: string; exit?: string | number }>((resolve) => {
      const child = execFile("ox", ["sync", "--read-only", `--repo=${repoId}`, "--timeout", LEDGER_SYNC_BUDGET, "--json"], {
        env: oxEnv({ ...scope, token: () => token }), cwd: oxCwd(scope), maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        stopping.signal.removeEventListener("abort", stop);
        resolve({ stdout, stderr, exit: error ? error.signal ?? error.code : 0 });
      });
      const stop = () => child.kill("SIGTERM");
      stopping.signal.addEventListener("abort", stop);
    });
    if (stopping.signal.aborted) return undefined;
    // The mounted token is replaced before the bound can cut it. The bound keeps both ends: a
    // Go panic states its cause first, and a failure reported after long output states it last.
    const quoted = (text: string) => {
      const line = (token ? text.replaceAll(token, "[REDACTED]") : text).replace(/\s+/g, " ").trim();
      return JSON.stringify(line.length > 2000 ? `${line.slice(0, 1000)} … ${line.slice(-1000)}` : line);
    };
    let result: ReadSyncResult = { schema_version: 1, ready: false, error_class: "unreadable" };
    let evidence = `exit=${exit} stdout=${quoted(stdout)} stderr=${quoted(stderr)}`;
    try {
      const receipt = JSON.parse(stdout);
      result = ReadSyncResult.parse(receipt);
      // coverage.paths lists the checkout's sparse window, not what failed, and is long enough
      // that the bound would cut what did.
      delete receipt.coverage?.paths;
      evidence = `receipt=${quoted(JSON.stringify(receipt))}`;
    } catch {
      // Recorded as a failed attempt.
    }
    ledger.last = result;
    ledger.refused = result.error_class === "denied" ? fingerprint : undefined;
    if (result.ready && !result.error_class) ledger.lastSync = result.last_successful_sync ?? undefined;
    return result.error_class ? evidence : undefined;
  };

  /**
   * Refresh one hosted ledger, and log a changed verdict or failure class. Returns whether ox
   * ran and failed with the same class as the attempt before it, other than a first sync still
   * transferring. A denied attempt never counts: ox runs again only for a replaced credential.
   */
  const cycle = async (repo: TeamRepository): Promise<boolean> => {
    if (stopping.signal.aborted) return false;
    const ledger = hosted.get(repo.name)!;
    const before = ledger.last;
    const previous = ledgerReadings.get(repo.name)?.status;
    const evidence = await refreshHosted(repo).catch(() => undefined);
    if (stopping.signal.aborted) return false;
    const status = recordLedger(hostedStatus(repo.name), ++ledgerLookup);
    const failure = ledger.last?.error_class;
    if (previous?.status !== status.status || previous?.detail !== status.detail || failure !== before?.error_class) {
      console.warn(`ledger_sync repo=${JSON.stringify(repo.name)} status=${status.status}` +
        (failure ? ` class=${JSON.stringify(failure)}` : "") +
        ` detail=${JSON.stringify(status.detail)}` + (evidence ? ` ${evidence}` : ""));
    }
    return ledger.last !== before && Boolean(failure) && failure === before?.error_class &&
      failure !== "denied" && status.status !== "initializing";
  };

  /**
   * Sync again a minute after each attempt ends, until the gateway stops. Each attempt that
   * fails with the same class as the one before it doubles the wait, up to
   * {@link MAX_SYNC_WAIT_MS}.
   */
  const loop = async (repo: TeamRepository) => {
    let wait = 60_000;
    while (!stopping.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          stopping.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        stopping.signal.addEventListener("abort", done);
      });
      wait = await cycle(repo) ? Math.min(wait * 2, MAX_SYNC_WAIT_MS) : 60_000;
    }
  };

  /** Resolves once every hosted ledger has made its first attempt; the loops outlive it. */
  const startHosted = async () => {
    if (!hosted.size || hostedLoops) return;
    for (const name of hosted.keys()) recordLedger(hostedStatus(name), ++ledgerLookup);
    const version = await oxVersion(scope);
    if (!version || !atLeast(version, MIN_OX_VERSION)) {
      oxTooOld = true;
      for (const name of hosted.keys()) recordLedger(hostedStatus(name), ++ledgerLookup);
      console.warn(`ledger_sync unavailable: ox=${version?.join(".") ?? "unknown"} detail=${JSON.stringify(LEDGER_OX_TOO_OLD)}`);
      return;
    }
    const repos = ledgerRepos.filter((repo) => hosted.has(repo.name));
    const first = repos.map(cycle);
    // Each repository keeps its own cadence: one long first sync must not hold the others.
    hostedLoops = Promise.all(first.map((attempt, i) => attempt.then(() => loop(repos[i])))).then(() => {});
    await Promise.all(first);
  };

  const startLegacy = async () => {
    if (!sync) return;
    try {
      await sync.start(async () => {
        for (const repo of ledgerRepos) {
          if (!isLegacy(repo)) continue;
          const previous = ledgerReadings.get(repo.name)?.status;
          const { status } = await inspectLedger(repo, true);
          if (previous?.status !== status.status || previous?.detail !== status.detail) {
            console.warn(`ledger_sync repo=${JSON.stringify(repo.name)} status=${status.status} detail=${JSON.stringify(status.detail)}`);
          }
        }
      });
    } catch {
      syncFailure = "Ledger sync could not acquire its ownership lock. Check gateway logs and filesystem ownership.";
      for (const remote of remotes) recordLedger({ repo: remote.repo, status: "unavailable",
        failure: "ledger-unavailable", detail: syncFailure }, ++ledgerLookup);
      console.warn("ledger_sync unavailable: verify any previous owner has stopped before removing workspace/ox-data/ledger-sync.lock");
    }
  };

  /**
   * Ask SageOx whether `token` may read this exact repository now. A team search is not that
   * answer: a repository can leave the team while the team's token stays valid.
   */
  const authorize = async (name: string, repoId: string, lookup: number, token: string | undefined) => {
    const verdict = await authorizeRead(hosted.get(name)!.last?.endpoint, repoId, token);
    if (verdict === "authorized") return token;
    recordLedger({ repo: name, status: "unavailable", detail: LEDGER_NOT_AUTHORIZED,
      failure: verdict === "denied" ? "not-authenticated" : "ledger-unavailable" }, lookup);
    throw new Error(LEDGER_NOT_AUTHORIZED);
  };

  /**
   * A hosted read: a fresh sync, live authorization, then ox's guarded reader, which holds the
   * checkout lock so a refresh cannot change files mid-read.
   */
  const hostedRead = async (repo: TeamRepository, argv: string[], reply: Reply): Promise<string> => {
    const { name } = repo;
    const lookup = ++ledgerLookup;
    const status = recordLedger(hostedStatus(name), lookup);
    if (status.status !== "available") throw new Error(status.detail);
    const repoId = hosted.get(name)!.repoId!;
    // The checkout must still carry the binding the ledger was synced for.
    if ((await binding(repo))?.repo_id !== repoId) {
      recordLedger({ repo: name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE }, lookup);
      throw new Error(LEDGER_UNAVAILABLE);
    }
    let token = await authorize(name, repoId, lookup, scope.token?.());
    let answer: string;
    try {
      answer = await reply(await runOx([...argv, `--repo=${repoId}`], scope, oxCwd(scope), true), repoId, status.last_sync);
    } catch (error) {
      const detail = error instanceof Error && error.message === LEDGER_UNREAD ? LEDGER_UNREAD : LEDGER_UNAVAILABLE;
      recordLedger({ repo: name, status: "unavailable", failure: "ledger-unavailable", detail }, lookup);
      throw error;
    }
    // The handoff: a credential replaced during the read is authorized before anything is
    // returned. One replaced after the last comparison is the next call's to check.
    for (let checks = 0; checks < 3; checks++) {
      const mounted = scope.token?.();
      if (mounted === token) return answer;
      token = await authorize(name, repoId, lookup, mounted);
    }
    recordLedger({ repo: name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_NOT_AUTHORIZED }, lookup);
    throw new Error(LEDGER_NOT_AUTHORIZED);
  };

  /** A `ledgerSync` read: live team access, a fresh gateway receipt, then ox in the checkout. */
  const legacyRead = async (repo: TeamRepository, argv: string[], reply: Reply): Promise<string> => {
    // A fresh local clone alone does not prove that a revoked credential still grants
    // this gateway access. Reuse the live team check and its rotation/health handling.
    await search("team", 1);
    const { status, repoId, lookup } = await inspectLedger(repo);
    if (status.status !== "available") throw new Error(status.detail);
    try {
      return await reply(await runOx(argv, scope, repo.path), repoId!, status.last_sync);
    } catch (error) {
      recordLedger({ repo: repo.name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE }, lookup);
      throw error;
    }
  };

  const ledgerRepo = (name: string) => {
    const matches = ledgerRepos.filter((repo) => repo.name === name);
    if (matches.length !== 1) throw new Error("No unique configured repository matches that name. Use team_status to list repository names.");
    return matches[0];
  };

  /** Report each repository's ledger separately. */
  const ledgerStatus = async (): Promise<TeamLedgerStatus[]> => {
    const statuses: TeamLedgerStatus[] = [];
    for (const repo of ledgerRepos) {
      statuses.push(hosted.has(repo.name)
        ? recordLedger(hostedStatus(repo.name), ++ledgerLookup)
        : (await read(() => inspectLedger(repo))).status);
    }
    return statuses;
  };

  /** List recent sessions only after live access and fresh ledger checks succeed. */
  const sessions = async (name: string, limit: number): Promise<string> => {
    SessionsArgs.parse({ repo: name, limit });
    const repo = ledgerRepo(name);
    const argv = ["session", "list", "--json", "--limit", String(limit)];
    const reply: Reply = async (out, repoId, last_sync) => {
      if (out && typeof out === "object" && "ledger_available" in out && out.ledger_available === false) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      const parsed = SessionsResponse.safeParse(out);
      if (!parsed.success) throw oxFailed("session", "unreadable", "unexpected session-list response shape");
      if (parsed.data.repo_id !== repoId) throw new Error(LEDGER_UNAVAILABLE);
      return JSON.stringify({ repo: name, repo_id: repoId, last_sync,
        window: "past seven days", total: parsed.data.total, sessions: parsed.data.sessions.slice(0, limit) });
    };
    return hosted.has(name) ? hostedRead(repo, argv, reply) : read(() => legacyRead(repo, argv, reply));
  };

  /** Read an explicit activity window without consuming another caller's history. */
  const recent = async (name: string, hours: number, limit: number): Promise<string> => {
    RecentArgs.parse({ repo: name, hours, limit });
    const repo = ledgerRepo(name);
    // Never use glance's default checkpoint: one caller reading must not hide earlier
    // activity from another. Absolute bounds also let us verify the returned window.
    const until = Date.now();
    const since = until - hours * 60 * 60_000;
    const updatesSince = hosted.has(name) ? Math.max(since, until - SYNCED_UPDATE_HOURS * 60 * 60_000) : since;
    const argv = ["glance", "--since", new Date(since).toISOString(), "--until", new Date(until).toISOString(), "--json"];
    const reply: Reply = async (out, repoId, last_sync) => {
      const parsed = RecentResponse.safeParse(out);
      if (!parsed.success) throw oxFailed("glance", "unreadable", "unexpected activity response shape");
      const data = parsed.data;
      // A hosted glance labels its window with the repository id; one in a checkout, with its directory.
      const label = hosted.has(name) ? repoId : basename(await realpath(repo.path));
      if (data.repo !== label || Date.parse(data.since) !== since || Date.parse(data.until) !== until) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      const activities = data.authors.flatMap((author) => [
        ...(author.murmurs ?? []).map((murmur) => ({ kind: "murmur", ...murmur })),
        ...(author.sessions ?? []).map((session) => ({ kind: "session", ...session })),
      ]);
      if (activities.some(({ time }) => Date.parse(time) < since || Date.parse(time) > until)) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      // Work updates before updatesSince may be only some of those recorded, so none are listed.
      const listed = activities.filter(({ kind, time }) => kind === "session" || Date.parse(time) >= updatesSince);
      listed.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      return JSON.stringify({ repo: name, repo_id: repoId, last_sync,
        since: data.since, until: data.until, work_updates_since: new Date(updatesSince).toISOString(),
        total: listed.length, truncated: listed.length > limit, activities: listed.slice(0, limit) });
    };
    return hosted.has(name) ? hostedRead(repo, argv, reply) : read(() => legacyRead(repo, argv, reply));
  };

  return {
    search,
    ledgerStatus,
    sessions,
    recent,
    startSync: async () => {
      await Promise.all([startHosted(), startLegacy()]);
    },
    stopSync: async () => {
      stopping.abort();
      await Promise.all([hostedLoops, sync?.stop()]);
    },
    // The query is a fixed word and the passages are thrown away: what is being read here
    // is whether ox answers at all.
    probe: async () => {
      await search("team", 1).catch(() => {});
    },
    readings: () => [...(reading ? [reading] : []), ...[...ledgerReadings.values()].map(({ status }) => {
      const capability = `ledger:${status.repo}`;
      if (status.status === "initializing") return probeWarming(capability, new Date(status.since!), status.detail);
      // Freshness expires even between tool calls. A latched Ok must not keep telling
      // subsequent turns that a checkout is current after its receipt has aged out.
      const stale = status.status === "available" && !isFresh(status.last_sync);
      if (status.status === "available" && !stale) return probeOk(capability, status.detail);
      const failure = stale ? "ledger-stale" : status.failure ?? "ledger-unavailable";
      return probeUnavailable(capability, failure, LEDGER_REMEDY[failure], stale ? LEDGER_STALE : status.detail);
    })],
  };
}

export interface OxScope {
  team?: string;
  repo?: string;
  /** Runtime repository allowlist from repos.conf; paths never come from a tool call. */
  repositories?: readonly TeamRepository[];
  /** The same isolated ox data home used by this agent's repository workspace. */
  dataHome?: string;
  /** Repositories synced from an explicit Git remote instead. Secrets are resolved only by the gateway. */
  ledgerSync?: readonly LedgerRemote[];
  /**
   * Sync every other configured repository's ledger with `ox sync --read-only` and
   * {@link token}. Set only when the policy grants a ledger reader: a first sync transfers
   * every object the ledger covers.
   */
  syncLedgers?: boolean;
  /**
   * This agent's SageOx access token, and the only credential its `ox` children get:
   * {@link oxEnv} leaves them no login on disk to fall back on.
   *
   * A reading and not a value, for the same reason capability health is one: it changes
   * under a running process. A secrets-store CSI driver with rotation on rewrites the
   * mounted file in place, and a string captured when the gateway booted would keep
   * stamping the revoked value onto every `ox` child until somebody restarted the
   * Deployment — for a credential already sitting current on the container's own disk.
   * {@link oxEnv} calls this once per child, which is a file read next to a process spawn.
   *
   * **It is bound to one endpoint.** ox uses this token only for `SAGEOX_ENDPOINT` when
   * that is set, and otherwise only for `https://sageox.ai`. Against any other endpoint
   * the token is not used, and with no login on disk to fall back on the call fails as
   * "not authenticated". Nothing is passed here to select an endpoint, deliberately: team
   * memory is on production, so the default is already right and a knob would only add a
   * way to be wrong.
   */
  token?: () => string | undefined;
  /**
   * Where ox runs.
   *
   * Not the gateway's own working directory: that is the application directory, which is
   * deliberately not writable by the user the agent runs as, and ox wants somewhere it can
   * keep a project config. The team is named explicitly on every query, so ox needs no
   * project context — only a writable place to stand.
   */
  cwd?: string;
}

/** A writable, neutral directory for the ox child. */
export function oxCwd(scope: OxScope): string {
  return scope.cwd ?? homedir();
}

/**
 * Env for the ox child. Built explicitly so a credential is never passed by accident, and
 * built per child so the credential it carries is the one on disk now — see
 * {@link OxScope.token}.
 */
export function oxEnv(scope: OxScope, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = passthroughEnv(base, [
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SAGEOX_TOKEN", "SAGEOX_ENDPOINT",
  ]);
  if (scope.dataHome) {
    env.XDG_DATA_HOME = scope.dataHome;
    env.XDG_CACHE_HOME = join(scope.dataHome, "cache");
  }
  // Read commands must not auto-start ox's daemon: it also publishes pending data.
  env.SAGEOX_DAEMON = "false";
  env.OX_NO_DAEMON = "1";
  if (scope.ledgerSync?.length && scope.dataHome) {
    env.XDG_STATE_HOME = join(scope.dataHome, "state");
    env.XDG_RUNTIME_DIR = join(scope.dataHome, "run");
  }
  if (scope.token) {
    const token = scope.token();
    // A configured ref is this agent's only SageOx credential, including when it reads as
    // nothing. Never a `SAGEOX_TOKEN` this process happens to have inherited, which on a
    // host running several agents is another agent's, and never a login on disk: an agent
    // does not run `ox login`, so any login ox would find there is a person's. ox looks for
    // one under `$XDG_CONFIG_HOME/sageox`, and nothing exists under the null device, so a
    // token ox cannot use fails as "not authenticated" instead.
    if (token) env.SAGEOX_TOKEN = token;
    else delete env.SAGEOX_TOKEN;
    env.XDG_CONFIG_HOME = devNull;
  }
  return env;
}

/**
 * Why an `ox` call failed — a closed vocabulary, never the text ox printed.
 *
 * There is more than one class because each sends a human somewhere different: a missing
 * binary is an image that was built wrong, an auth failure is a credential to mount or
 * rotate (`OxScope.token` expires on a rolling 24h and does not renew itself), and output
 * this gateway cannot read is a version skew. "It failed, try again" covers none of them.
 */
export type OxFailure = "not-installed" | "not-authenticated" | "unreadable" | "failed";

/**
 * What the brain is told for each class: **a fixed string, never interpolated.**
 *
 * ox's stderr is untrusted text on a path that reaches the LLM — a failing `ox query`
 * can quote the query back, and the query is whatever a channel talked the brain into
 * asking. This follows `GuardVerdict.reason`, which is a fixed string per rule for
 * exactly this reason. `team-server.test.ts` enforces that a planted secret in ox's
 * stderr reaches the log and not the brain.
 */
export const OX_FAILURE_TEXT: Record<OxFailure, string> = {
  "not-installed": "the `ox` CLI is not on PATH — the team brain needs it to search",
  "not-authenticated":
    "this gateway is not authenticated to SageOx, so team memory cannot be read. Asking " +
    "again will not help — a human has to mount or rotate its credential",
  unreadable: "ox answered with something this gateway could not read",
  failed:
    "ox could not answer this lookup. Why is in the gateway log, which you cannot see — " +
    "say the lookup failed rather than guessing a reason",
};

/**
 * Which class a failed `ox` child belongs to.
 *
 * Classification runs the safe way round: only ox's documented phrasing is recognised,
 * and anything else falls through to `failed`. If ox rewords its refusal this degrades to
 * "we could not read it" — still true — rather than sending a human after the wrong cause.
 */
export function classifyOxFailure(e: { code?: string; stderr?: string }): OxFailure {
  if (e.code === "ENOENT") return "not-installed";
  if (/\bnot authenticated\b/i.test(e.stderr ?? "")) return "not-authenticated";
  return "failed";
}

/**
 * A failed `ox` call, carrying its class. The message is still the fixed per-class
 * sentence: the class is a second field so a caller can act on it, never a second thing to
 * parse back out of the text.
 */
export class OxCallError extends Error {
  constructor(
    readonly failure: OxFailure,
    message: string,
  ) {
    super(message);
    this.name = "OxCallError";
  }
}

/** The capability id this brain's health is reported under. */
const TEAM_CAPABILITY = "brain.team";

/**
 * The failure classes worth latching as capability health, and what a person does about
 * each.
 *
 * `failed` and `unreadable` are absent, and that is the judgement here. Latching sends a
 * human somewhere — `needsHuman` is what the operator note and the degraded turn block are
 * built on — so it is for what retrying cannot disprove. A lookup that fell over once may
 * well answer the next time; a missing binary and a rejected credential stay broken until
 * somebody acts.
 */
const LATCHED: Partial<Record<OxFailure, { failure: ProbeFailure; remedy: string }>> = {
  "not-installed": {
    failure: "not-installed",
    remedy:
      "install the `ox` CLI in this agent's image, or drop the team brain from agent.yaml, " +
      "then restart",
  },
  "not-authenticated": {
    failure: "not-authenticated",
    remedy:
      "mount or rotate this deployment's SageOx credential — the secret the team brain's " +
      "`token` names. The next lookup reads it, so a file-mounted value needs no restart; " +
      "one supplied in the environment does",
  },
};

/**
 * The two halves of a failure, together so neither can be raised without the other: a
 * fixed string for the brain, and the detail on the gateway's own log, which the brain
 * never reads. Same split `GuardVerdict` makes between `reason` and the audit line.
 */
function oxFailed(verb: string, failure: OxFailure, detail: string | undefined): OxCallError {
  // Collapsed and bounded so the line stays readable, then quoted as JSON so it cannot
  // end early: a `"` in ox's output would otherwise close `detail` and let the rest of it
  // read as fields of its own — a forged `class=` sends an operator after the wrong cause,
  // which is the mistake this whole change exists to stop. Last on the line, because it is
  // the only free text here.
  const one = (detail ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  console.warn(`ox_failed verb="${verb}" class=${failure} detail=${JSON.stringify(one || "none")}`);
  return new OxCallError(failure, `ox ${verb}: ${OX_FAILURE_TEXT[failure]}`);
}

/**
 * Run bounded ox JSON commands in the supplied cwd using the gateway's current credential.
 * `guarded` runs one of ox's guarded ledger readers, which select a checkout by `--repo` and
 * the data home alone and read only local files, so it gets no credential and no project.
 */
async function runOx(args: string[], scope: OxScope, cwd: string, guarded = false): Promise<unknown> {
  // The verb only, never the rest of the argv: a query is the caller's own words and has
  // no business coming back inside an error message.
  const verb = args[0];
  const env = oxEnv(scope);
  if (guarded) {
    delete env.SAGEOX_TOKEN;
  } else {
    // The allowlist drops ambient project overrides; local ledger commands bind ox to
    // the gateway-selected repository because OX_PROJECT_ROOT outranks cwd.
    if (verb !== "query") env.OX_PROJECT_ROOT = cwd;
  }
  // ox 0.17.0's session list picks its format from agent context, not from the inherited
  // --json flag, in a project checkout and for a `--repo` hosted read alike: without this a
  // hosted read answers with the human "No sessions found" line. `glance` is unaffected.
  if (verb === "session") env.AGENT_ENV = "claude-code";
  let stdout: string;
  try {
    ({ stdout } = await run("ox", args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      env,
      cwd,
    }));
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message?: string };
    // execFile's own message is the whole command line plus stderr, so it is no safer to
    // replay than stderr is — both go to the log, neither to the brain.
    const failed = oxFailed(verb, classifyOxFailure(e), e.stderr || e.message);
    // A guarded reader's refusal names only a sanitized class, most often a refresh that
    // held the checkout past this call's timeout.
    throw guarded && failed.failure === "failed" ? new Error(LEDGER_UNREAD) : failed;
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    // Not what failed to parse: whatever ox printed is the same untrusted text.
    throw oxFailed(verb, "unreadable", `${stdout.length} bytes of non-JSON on stdout`);
  }
}

/** `ox --version` as numbers, or undefined when ox is missing or prints something else. */
async function oxVersion(scope: OxScope): Promise<number[] | undefined> {
  const env = oxEnv(scope);
  delete env.SAGEOX_TOKEN;
  try {
    const { stdout } = await run("ox", ["--version"], { env, cwd: oxCwd(scope), timeout: 30_000 });
    return stdout.match(/\bversion v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  } catch {
    return undefined;
  }
}

function atLeast(version: number[], minimum: number[]): boolean {
  return (version[0] - minimum[0] || version[1] - minimum[1] || version[2] - minimum[2]) >= 0;
}

/**
 * Whether SageOx lets `token` read this repository's ledger now. Repository discovery answers
 * 401/403 for a refused token, and gives a foreign or unlinked repository no ready ledger to
 * read. The token goes only to the HTTPS origin ox synced from, and never follows a redirect.
 */
async function authorizeRead(
  endpoint: string | undefined,
  repoId: string,
  token: string | undefined,
): Promise<"authorized" | "denied" | "unavailable"> {
  if (!token) return "denied";
  const origin = URL.canParse(endpoint ?? "") ? new URL(endpoint!) : undefined;
  if (origin?.protocol !== "https:" || origin.href !== `${origin.origin}/`) return "unavailable";
  try {
    const response = await fetch(`${origin.origin}/api/v1/cli/repos/${repoId}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return "denied";
    if (response.status !== 200) return "unavailable";
    const detail = (await response.json()) as { ledger?: { status?: unknown; read_url?: unknown } } | null;
    return detail?.ledger?.status === "ready" && typeof detail.ledger.read_url === "string" && detail.ledger.read_url
      ? "authorized"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * The date a passage comes from, when its path carries one.
 *
 * ox returns no date field — only `file_path`, which for discussions and sessions begins
 * with `YYYY-MM-DD`. Surfacing it matters: without it a reader has to parse paths to tell
 * old material from new, and guessing wrong looks like the corpus being stale.
 */
export function passageDate(filePath: string | undefined): string | undefined {
  return filePath?.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
}

/**
 * Renders passages with their provenance.
 *
 * A passage without its source cannot be judged or checked, and an agent that cites team
 * memory without saying where it came from is asking to be believed on its own authority.
 */
export function formatPassages(query: string, passages: TeamPassage[]): string {
  if (passages.length === 0) {
    return (
      `The team brain has nothing on "${query}". That is an answer: it means the team has not ` +
      `written this down in words that match, not that the search failed and not that the team ` +
      `has recorded nothing recently. Try different wording before concluding anything.`
    );
  }

  return passages
    .map((p, i) => {
      const where = p.file_path ?? p.source_id ?? p.source_type ?? "team context";
      const kind = p.doc_type ? ` · ${p.doc_type}` : "";
      const when = passageDate(p.file_path);
      const dated = when ? ` · ${when}` : "";
      return `[${i + 1}] ${where}${kind}${dated} (score ${p.score.toFixed(2)})\n${p.text.trim()}`;
    })
    .join("\n\n");
}

/** The team brain's JSON-RPC handler. Exported so the behaviour is testable offline. */
export function teamBrainHandler(ox: TeamOx): McpHandler {
  return mcpToolServer({
    name: "team-brain",
    // `run` is the gateway's half and never leaves it: the brain is told the name, the
    // description and the schema, which is all it can act on.
    tools: () =>
      TEAM_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: async (name, args) => {
      const tool = TEAM_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool.run(ox, args);
    },
  });
}

/**
 * The team brain, hosted by the gateway.
 *
 * Unlike the servers the broker runs, this one is not a subprocess — every tool is a
 * function call that shells to `ox`. It reaches the brain the same way regardless: over
 * HTTP, behind a capability token, with the credential staying on this side.
 */
export function serveTeamBrain(ox: TeamOx, opts: ServeOptions = {}): Promise<HostedMcp> {
  return serveMcp(teamBrainHandler(ox), opts);
}
