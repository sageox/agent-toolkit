import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { z } from "zod";
import {
  mcpToolServer,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type ServeOptions,
} from "./mcp-http.ts";
import { probeOk, probeUnavailable, type ProbeFailure, type ProbeResult } from "./health.ts";

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
 * **Two verbs on every fleet agent's `ox` allowlist are deliberately absent:** `ox glance`
 * (recent murmurs and sessions) and `ox session list`. Both read the ledger clone that
 * `ox daemon` keeps in sync, and this toolkit does not run that daemon — repository
 * readiness here comes from a one-shot code index instead (docs/guide/memory-and-tools.md,
 * step 7b). Without the
 * clone `ox glance` fails with "ledger not available", and `ox session list` fails worse:
 * it prints `{"sessions": [], "ledger_available": false}` and exits 0. A tool that cannot
 * tell "the team was quiet this week" from "nothing is synced here" does not give a weaker
 * answer, it gives a confident wrong one — the same reason `ox status` is absent. Serving
 * them is a ledger-sync decision, not a schema.
 *
 * `team_kb_list` and `team_kb_show` were served here until knowledge bubbles stopped being
 * a feature anyone maintains. `ox conversation` reads the same shape of thing — a listing
 * to scan, then one item's summary — and is the obvious replacement, but it needs the same
 * synced team-context checkout the paragraph above rules out: with none it answers
 * `{"success": false, "error": {"code": "no_team_context"}}`. It is a better candidate than
 * `ox session list` for having an honest failure to check rather than an empty list to
 * misread, and it stays out for the same reason until something here syncs.
 *
 * That leaves `team_search` alone, and it is the one that does not need the checkout:
 * `ox query` is answered server-side from the token.
 */
export const TEAM_TOOLS: readonly TeamTool[] = [
  {
    name: "team_search",
    description:
      "Search the team's shared knowledge — past discussions, decisions, docs, and prior sessions. " +
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
];

/** The bare tool names, for writing and checking the policy. */
export const TEAM_TOOL_NAMES: string[] = TEAM_TOOLS.map((tool) => tool.name);

export interface TeamPassage {
  score: number;
  text: string;
  doc_type?: string;
  file_path?: string;
  source_type?: string;
  source_id?: string;
}

/** How the team knowledge is queried. Injectable so the server is testable offline. */
export type TeamSearch = (query: string, limit: number) => Promise<TeamPassage[]>;

/** Everything the team brain asks `ox` for. Injectable so the server is testable offline. */
export interface TeamOx {
  search: TeamSearch;
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
  let reading: ProbeResult | undefined;
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
    // An answer is the proof: ox ran, the credential was accepted, and whatever was latched
    // before is over. Zero passages is still `Ok` and never `Empty` — `ox query` reports no
    // corpus size, and one query matching nothing is also what a team with plenty written
    // down returns to unlucky wording.
    record(probeOk(TEAM_CAPABILITY, "team memory answered this gateway's last lookup"));
    return (out as { team_context?: { results?: TeamPassage[] } }).team_context?.results ?? [];
  };

  return {
    search,
    // The query is a fixed word and the passages are thrown away: what is being read here
    // is whether ox answers at all.
    probe: async () => {
      await search("team", 1).catch(() => {});
    },
    readings: () => (reading ? [reading] : []),
  };
}

export interface OxScope {
  team?: string;
  repo?: string;
  /** Directory holding `sageox/auth.json`, for a credential mounted as a file. */
  configHome?: string;
  /**
   * An access token supplied out-of-band, for CI and containers where no interactive
   * `ox login` can happen. Takes precedence over anything on disk.
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
  token?: string;
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

/** Env for the ox child. Built explicitly so a credential is never passed by accident. */
export function oxEnv(scope: OxScope, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (scope.configHome) env.XDG_CONFIG_HOME = scope.configHome;
  if (scope.token) env.SAGEOX_TOKEN = scope.token;
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
      "names, or the auth file under its `configHome` — then restart",
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
  let stdout: string;
  try {
    ({ stdout } = await run("ox", args, {
      maxBuffer: 8 * 1024 * 1024,
      env: oxEnv(scope),
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
