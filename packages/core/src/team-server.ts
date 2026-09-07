import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
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
import { probeOk, probeUnavailable, type ProbeFailure, type ProbeResult } from "./health.ts";
import { createLedgerSync, type LedgerRemote } from "./ledger-sync.ts";

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
const LedgerSync = z.object({
  project: z.object({
    ledger: z.object({ status: z.string(), path: z.string(), last_sync: z.string().optional() }).optional(),
  }).optional(),
});
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
 * `team_sessions` reads only repositories configured in the gateway. An operator's ox
 * daemon or the gateway must have synced the selected ledger within five minutes;
 * code-index readiness and global daemon health are not that evidence. Without
 * a clone, `ox session list` prints `{"sessions": [], "ledger_available": false}` and exits
 * 0, so the reader checks availability again after the command. Missing and stale data
 * are refused rather than described as an empty week. `team_recent` uses the same checks
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
        ledger_sync: repositories.length ? {
          status: repositories.some((repo) => repo.sync_owner === "gateway") ? "managed" : "external", repositories,
        } : {
          status: "not_configured",
          detail:
            "No repositories are configured for ledger reads. Add repositories with repos add and " +
            "arrange ledger sync. Recent activity and session history cannot be inferred from an empty search.",
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
  sync_owner?: "gateway";
  status: "available" | "unavailable";
  failure?: "ledger-unavailable" | "ledger-stale";
  last_sync?: string;
  detail: string;
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
 * `configHome` points ox at its token file. This runs in the gateway, so the credential
 * stays on this side of the boundary; the brain never sees it.
 */
export function makeOxTeam(scope: OxScope = {}): TeamBrain {
  const remotes = scope.ledgerSync ?? [];
  if (remotes.length && (!scope.dataHome || remotes.some((remote) =>
    scope.repositories?.filter((repo) => repo.name === remote.repo).length !== 1))) {
    throw new Error("ledgerSync requires an isolated data home and names from the configured repository list.");
  }
  const sync = remotes.length ? createLedgerSync(scope.dataHome!, remotes) : undefined;
  let syncFailure: string | undefined;
  const read = <T>(work: () => Promise<T>): Promise<T> => sync ? sync.exclusive(work) : work();
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
    if (remotes.some((remote) => remote.repo === status.repo)) status = { ...status, sync_owner: "gateway" };
    if ((ledgerReadings.get(status.repo)?.lookup ?? 0) <= lookup) {
      ledgerReadings.set(status.repo, { status, lookup });
    }
    return status;
  };

  /** Verify project identity and a fresh matching receipt, optionally refreshing an owned ledger first. */
  const inspectLedger = async (repo: TeamRepository, refresh = false) => {
    const lookup = ++ledgerLookup;
    let repoId: string | undefined;
    let status: TeamLedgerStatus = {
      repo: repo.name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE,
    };
    try {
      const origin = await run("git", ["remote", "get-url", "origin"], {
        cwd: repo.path, timeout: 30_000,
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      });
      if (origin.stdout.trim() !== repo.url) return { status: recordLedger(status, lookup), lookup };
      const config = ProjectConfig.parse(JSON.parse(await readFile(join(repo.path, ".sageox/config.json"), "utf8")));
      // The cwd comes from repos.conf, never from tool arguments. Check its tracked
      // identity before handing ox the credential; a foreign endpoint must not select
      // an ambient disk login, and a repository from another team is outside this brain.
      if (config.team_id !== scope.team || (scope.repo && config.repo_id !== scope.repo) ||
          (config.endpoint && config.endpoint.replace(/\/$/, "") !== "https://sageox.ai")) {
        return { status: recordLedger(status, lookup), lookup };
      }
      repoId = config.repo_id;
      let managed;
      if (sync && remotes.some((remote) => remote.repo === repo.name)) {
        // ox 0.14.3's canonical ledger directory. Never turn a repository's config
        // into an arbitrary destination, and never adopt an operator-owned clone.
        if (!/^repo_[A-Za-z0-9_-]+$/.test(repoId)) throw new Error(LEDGER_UNAVAILABLE);
        const path = join(scope.dataHome!, "sageox", "sageox.ai", "ledgers", repoId);
        if (refresh) await sync.pull(repo.name, path).catch(() => {});
        managed = sync.receipt(repo.name);
        if (!managed?.last_sync) {
          status.detail = managed?.detail ?? syncFailure ?? "The gateway has not successfully refreshed this ledger yet.";
          return { status: recordLedger(status, lookup), repoId, lookup };
        }
      }
      const location = LedgerLocation.parse(await runOx(["status", "--json"], scope, repo.path)).ledger;
      if (!location.configured || !location.exists || !location.path) return { status: recordLedger(status, lookup), lookup };
      const receipt = managed ? { ...managed, status: "ok" }
        : LedgerSync.parse(await runOx(["daemon", "status", "--json"], scope, repo.path)).project?.ledger;
      // Top-level daemon health/last_sync may describe another checkout. Match the
      // ledger that this cwd's read commands actually resolve, then use only its receipt.
      if (!receipt || receipt.status !== "ok" || await realpath(receipt.path) !== await realpath(location.path)) {
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
      const at = receipt.last_sync ? Date.parse(receipt.last_sync) : NaN;
      const age = Date.now() - at;
      status = { ...status, failure: "ledger-stale", detail: LEDGER_STALE };
      if (Number.isFinite(at) && age >= 0) status.last_sync = new Date(at).toISOString();
      if (Number.isFinite(at) && age >= 0 && age < MAX_LEDGER_AGE_MS) {
        status = { repo: repo.name, status: "available", last_sync: status.last_sync,
          detail: "This repository's ledger has a successful refresh within five minutes." };
      }
    } catch {
      // Paths, config parse errors and ox diagnostics are never copied into a turn.
    }
    return { status: recordLedger(status, lookup), repoId, lookup };
  };

  /** Inspect configured aliases and report each repository's source failure separately. */
  const ledgerStatus = async (): Promise<TeamLedgerStatus[]> => {
    const statuses: TeamLedgerStatus[] = [];
    for (const repo of scope.repositories ?? []) statuses.push((await inspectLedger(repo)).status);
    return statuses;
  };

  /** List recent sessions only after live access and fresh ledger checks succeed. */
  const sessions = async (name: string, limit: number): Promise<string> => {
    SessionsArgs.parse({ repo: name, limit });
    const matches = (scope.repositories ?? []).filter((repo) => repo.name === name);
    if (matches.length !== 1) throw new Error("No unique configured repository matches that name. Use team_status to list repository names.");
    const repo = matches[0];
    // A fresh local clone alone does not prove that a revoked credential still grants
    // this gateway access. Reuse the live team check and its rotation/health handling.
    await search("team", 1);
    const { status, repoId, lookup } = await inspectLedger(repo);
    if (status.status !== "available") throw new Error(status.detail);
    try {
      const out = await runOx(["session", "list", "--json", "--limit", String(limit)], scope, repo.path);
      if (out && typeof out === "object" && "ledger_available" in out && out.ledger_available === false) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      const parsed = SessionsResponse.safeParse(out);
      if (!parsed.success) throw oxFailed("session", "unreadable", "unexpected session-list response shape");
      if (parsed.data.repo_id !== repoId) throw new Error(LEDGER_UNAVAILABLE);
      return JSON.stringify({ repo: name, repo_id: repoId, last_sync: status.last_sync,
        window: "past seven days", total: parsed.data.total, sessions: parsed.data.sessions.slice(0, limit) });
    } catch (error) {
      recordLedger({ repo: name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE }, lookup);
      throw error;
    }
  };

  /** Read an explicit activity window without consuming another caller's history. */
  const recent = async (name: string, hours: number, limit: number): Promise<string> => {
    RecentArgs.parse({ repo: name, hours, limit });
    const matches = (scope.repositories ?? []).filter((repo) => repo.name === name);
    if (matches.length !== 1) throw new Error("No unique configured repository matches that name. Use team_status to list repository names.");
    const repo = matches[0];
    await search("team", 1);
    const { status, repoId, lookup } = await inspectLedger(repo);
    if (status.status !== "available") throw new Error(status.detail);
    try {
      // Never use glance's default checkpoint: one caller reading must not hide earlier
      // activity from another. Absolute bounds also let us verify the returned window.
      const until = Date.now();
      const since = until - hours * 60 * 60_000;
      const out = await runOx(["glance", "--since", new Date(since).toISOString(),
        "--until", new Date(until).toISOString(), "--json"], scope, repo.path);
      const parsed = RecentResponse.safeParse(out);
      if (!parsed.success) throw oxFailed("glance", "unreadable", "unexpected activity response shape");
      const data = parsed.data;
      if (data.repo !== basename(await realpath(repo.path)) || Date.parse(data.since) !== since || Date.parse(data.until) !== until) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      const activities = data.authors.flatMap((author) => [
        ...(author.murmurs ?? []).map((murmur) => ({ kind: "murmur", ...murmur })),
        ...(author.sessions ?? []).map((session) => ({ kind: "session", ...session })),
      ]);
      if (activities.some(({ time }) => Date.parse(time) < since || Date.parse(time) > until)) {
        throw new Error(LEDGER_UNAVAILABLE);
      }
      activities.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      return JSON.stringify({ repo: name, repo_id: repoId, last_sync: status.last_sync,
        since: data.since, until: data.until, total: activities.length,
        truncated: activities.length > limit, activities: activities.slice(0, limit) });
    } catch (error) {
      recordLedger({ repo: name, status: "unavailable", failure: "ledger-unavailable", detail: LEDGER_UNAVAILABLE }, lookup);
      throw error;
    }
  };

  return {
    search,
    ledgerStatus: () => read(ledgerStatus),
    sessions: (...args) => read(() => sessions(...args)),
    recent: (...args) => read(() => recent(...args)),
    startSync: async () => {
      if (!sync) return;
      try {
        await sync.start(async () => {
          for (const repo of scope.repositories ?? []) {
            if (!remotes.some((remote) => remote.repo === repo.name)) continue;
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
    },
    stopSync: async () => { await sync?.stop(); },
    // The query is a fixed word and the passages are thrown away: what is being read here
    // is whether ox answers at all.
    probe: async () => {
      await search("team", 1).catch(() => {});
    },
    readings: () => [...(reading ? [reading] : []), ...[...ledgerReadings.values()].map(({ status }) => {
      const capability = `ledger:${status.repo}`;
      // Freshness expires even between tool calls. A latched Ok must not keep telling
      // subsequent turns that a checkout is current after its receipt has aged out.
      const age = Date.now() - Date.parse(status.last_sync ?? "");
      const stale = status.status === "available" && !(age >= 0 && age < MAX_LEDGER_AGE_MS);
      return status.status === "available" && !stale
        ? probeOk(capability, status.detail)
        : probeUnavailable(capability, stale ? "ledger-stale" : status.failure ?? "ledger-unavailable",
            "check SageOx ledger sync and its configured credential for this repository", stale ? LEDGER_STALE : status.detail);
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
  /** Omit to use externally supervised sync. Secrets are resolved only by the gateway. */
  ledgerSync?: readonly LedgerRemote[];
  /** Directory holding `sageox/auth.json`, for a credential mounted as a file. */
  configHome?: string;
  /**
   * An access token supplied out-of-band, for CI and containers where no interactive
   * `ox login` can happen. Takes precedence over anything on disk.
   *
   * A reading and not a value, for the same reason capability health is one: it changes
   * under a running process. A secrets-store CSI driver with rotation on rewrites the
   * mounted file in place, and a string captured when the gateway booted would keep
   * stamping the revoked value onto every `ox` child until somebody restarted the
   * Deployment — for a credential already sitting current on the container's own disk.
   * {@link oxEnv} calls this once per child, which is a file read next to a process spawn.
   *
   * Unlike a logged-in `auth.json`, this carries no refresh credential: ox stamps a
   * rolling 24h expiry and treats a server 401 as the truth. A long-running agent on a
   * token alone will eventually need it rotated — mount `auth.json` instead if you want
   * the credential to renew itself.
   *
   * **It is bound to one endpoint, and the binding is silent.** ox uses this token only
   * for `SAGEOX_ENDPOINT` when that is set, and otherwise only for `https://sageox.ai`.
   * Against any other endpoint the token is not rejected — it is not used, and ox falls
   * back to `auth.json`. With nothing on disk that surfaces as "not authenticated"; with
   * a login for that host it authenticates as someone else entirely and answers normally.
   * Nothing is passed here to select an endpoint, deliberately: team memory is on
   * production, so the default is already right and a knob would only add a way to be
   * wrong.
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
  const env = { ...base };
  if (scope.configHome) env.XDG_CONFIG_HOME = scope.configHome;
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
    // A configured ref is the authority on this agent's credential, including when it
    // reads as nothing: the child then carries no token and falls back to `configHome`,
    // never to a `SAGEOX_TOKEN` this process happens to have inherited. On a host running
    // several agents that ambient value is another agent's credential, and ox would take
    // it and answer normally as someone else. Deleting matters more now that the ref is
    // read per child than it did when one boot-time reading stood for the process.
    if (token) env.SAGEOX_TOKEN = token;
    else delete env.SAGEOX_TOKEN;
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
      "rotate this deployment's SageOx credential — the secret the team brain's `token` " +
      "names, or the auth file under its `configHome`. The next lookup reads it, so a " +
      "file-mounted value needs no restart; one supplied in the environment does",
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

async function runOx(args: string[], scope: OxScope, cwd: string): Promise<unknown> {
  // The verb only, never the rest of the argv: a query is the caller's own words and has
  // no business coming back inside an error message.
  const verb = args[0];
  const env = oxEnv(scope);
  // ox's project override outranks cwd. Never inherit the launching coding agent's
  // project; local ledger commands bind it to the gateway-selected repository.
  delete env.OX_PROJECT_ROOT;
  if (verb !== "query") env.OX_PROJECT_ROOT = cwd;
  // The toolkit's hosted brain runs Claude over ACP. ox 0.14.3's session list
  // ignores the inherited --json flag outside agent context; make that context
  // explicit instead of depending on the environment of the deployment's launcher.
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
    throw oxFailed(verb, classifyOxFailure(e), e.stderr || e.message);
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    // Not what failed to parse: whatever ox printed is the same untrusted text.
    throw oxFailed(verb, "unreadable", `${stdout.length} bytes of non-JSON on stdout`);
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
