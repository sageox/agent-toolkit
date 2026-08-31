import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  admitJob,
  type JobAdmission,
  type JobRequester,
  type JobTriggerKind,
  type SwitchReading,
  type SwitchSource,
} from "./kill-switch.ts";
import { passthroughEnv } from "./brain-env.ts";
import { errorLine } from "./errors.ts";
import type { EventRef, ThreadReply } from "./events.ts";
import { serveJobChannel } from "./job-channel.ts";
import type { HostedMcp } from "./mcp-http.ts";
import { withTimeout } from "./gateway.ts";
import type { JobAnnounce, JobConfig } from "./manifest.ts";
import { resolveSecret } from "./secrets.ts";
import {
  combineVerdicts,
  describeVerdict,
  isProven,
  verdictFromGate,
  type Verdict,
} from "./verdict.ts";

/**
 * Runs the envelope around a job. It never runs the body inside it.
 *
 * The line is the whole design: the toolkit owns admission, single-flight, the clock, and
 * the run record; the agent owns what the job does. The evidence is the size of what is
 * left over — one fleet runner is 37 source files of product logic (which repository paths
 * are sacred, how to grade a check rollup, what belongs in a PR body), and none of it
 * generalizes. A toolkit that owned any of it would be describing one agent.
 *
 * So the interface to the job body is four things and no more: an argv it declared, an
 * environment envelope, an exit code, and a file. The host cannot see the work, which is
 * exactly why it can host anybody's.
 *
 * See [the RFC](../../../docs/design/2026-08-19-jobs-rfc.md) §2, §7–§10.
 */

/**
 * What the envelope did with this run. Distinct from the verdict, which is what the run
 * *proved* — a body that ran its gates and found a real failure `completed` with a `FAIL`,
 * and a tick that never started is `skipped-overlap` with no verdict at all. Collapsing the
 * two is how "ran and found nothing" and "did not run" end up rendering the same.
 */
export type JobOutcome =
  | "completed"
  | "denied-trigger"
  | "denied-switch"
  | "denied-suspend"
  | "skipped-overlap"
  | "budget-bowout"
  /**
   * The host was told to stop, and this run will never be settled by it. Its own word, not
   * the body's: `crashed` would blame a process that is still running fine, and
   * `budget-bowout` would name a clock that had not run out. What is true either way is
   * that nobody here will ever read this run's verdict — which is UNKNOWN, and is why it
   * needs a spelling of its own.
   *
   * It covers both sides of the shutdown: a body that was still running, and one that was
   * never started because the switch was still being read. The outcome is the same because
   * the consequence is; the gate is what says which, `executed: true` against `false`.
   */
  | "abandoned"
  | "crashed";

/**
 * Written for every run, including one the switch denied and a tick dropped for overlap.
 *
 * Silence is allowed for findings — a job that found nothing posts nothing, which is the
 * fleet's rule and it is right. Silence is never allowed for the record, because a job
 * that reported nothing and a job that never ran must not read the same.
 */
export interface JobRun {
  jobSlug: string;
  runId: string;
  /** Stamped from the entry point that started the run. Never passed in — see {@link JobHost}. */
  trigger: JobTriggerKind;
  /** Who asked, or null for a clock tick that nobody asked for. */
  requestedBy: JobRequester | null;
  startedAt: number;
  /**
   * Always a number: every record this host returns is of a finished run. The RFC sketches
   * it nullable for a run still in flight, and a field that is never null is a type that
   * lies — whoever adds in-flight observation can widen it then.
   */
  endedAt: number;
  outcome: JobOutcome;
  /** The switch as this job read it, or null when it declares none. */
  switch: SwitchReading | null;
  /** True when a human ran this job while it was parked. Greppable at 3am, by design. */
  bypassedSwitch: boolean;
  /**
   * Every gate this run minted, the host's own process gate first. `verdict` is exactly
   * `combineVerdicts(gates)` — there is no hidden input, so a reader can check the sum.
   */
  gates: readonly Verdict[];
  verdict: Verdict;
  /**
   * The validated values this run was given, empty for a job that declares none.
   *
   * On the record because a run of a job that takes a target is not identified by its slug:
   * "which one did the 03:12 run act on" is the first question an operator asks about it, and
   * the audit line cannot answer it — `auditArgs` does not write out a nested object.
   */
  parameters: JobParams;
  /** One line for the log and the status post. Never carries a backend's error text. */
  reason: string;
}

/**
 * A run that has been admitted, answered before its body is done.
 *
 * There is exactly one caller that needs this, and it is the reason the type exists: a chat
 * turn has a clock of its own, and a job whose deadline is longer than
 * `limits.turnTimeoutMs` cannot be waited for inside one. Waiting anyway is a turn that
 * times out with nothing said while the run carries on — which the person who asked cannot
 * tell from an agent that ignored them.
 *
 * It carries no verdict and there is nowhere in it to put one. Nothing has finished, so the
 * only true things about the run are that it started and which one it is — everything else a
 * caller says about it comes from the job it already holds.
 */
export interface JobStart {
  runId: string;
  /**
   * The complete record of a run that never started: a door the job never armed, a slug
   * already in flight, a parked job. `null` means a body is running now, and its record
   * reaches `onRun` when it is over.
   */
  refused: JobRun | null;
}

/** The facts a run has before its body does. Named because four signatures below take it. */
type RunBase = Pick<
  JobRun,
  "jobSlug" | "runId" | "trigger" | "requestedBy" | "startedAt" | "parameters"
>;

/** {@link JobStart}, plus the record the run will end with. Never leaves this file. */
interface Started extends JobStart {
  /** Already settled when the run was refused — there is nothing left for it to wait on. */
  finished: Promise<JobRun>;
}

/**
 * How one line of a job's status reaches its channel, and how the next line finds it.
 *
 * Injected because the host must not know what a surface is: it is handed the `report`
 * destination the job declared and something that can reach it. The CLI binds
 * `SurfaceEgress.post`, so a status post clears the same guard every other outbound
 * message does — a job cannot reach a public channel the agent has no consent for.
 *
 * The returned ref is the whole point of the type. A headline answers with its own id, and
 * that id is what threads the detail underneath it. `undefined` means the surface reported
 * no id, and the caller posts the next line at top level rather than losing it.
 *
 * `mentions` addresses the post to a named set, by the surface's own ids. Nothing on the
 * status path passes it — only the per-run job channel does, and only for a `report.probe`
 * job. See `SurfaceAdapter.post` in `adapter.ts` for what a surface makes of it.
 */
export type JobPoster = (
  report: NonNullable<JobConfig["report"]>,
  text: string,
  threadRoot?: EventRef,
  mentions?: readonly string[],
) => Promise<EventRef | undefined>;

/**
 * How a job body reads back the thread it just rooted — `post`'s other half.
 *
 * Injected for the same reason `post` is: the host must not know what a surface is. It
 * takes the ref rather than the `report` destination because a ref already carries the
 * surface that issued it, so a read cannot be pointed at an adapter that never posted it.
 *
 * Unset is not "nobody replied" — it is "no surface here can say", and the job channel
 * refuses the read rather than answering with an empty thread.
 */
export type JobReader = (root: EventRef, limit?: number) => Promise<readonly ThreadReply[]>;

export interface JobHostOptions {
  /**
   * How a job's kill switch is read. Bind `engramSwitchSource` from the Buzz adapter in
   * production; leaving it unset is not "no switch" but an unreadable one, which a
   * fail-closed job refuses to run on.
   */
  switchSource?: SwitchSource | null;
  /**
   * Where a job's status post goes. Unset means nowhere — the run record is still written,
   * which is the half that is never allowed to be silent.
   */
  post?: JobPoster;
  /**
   * How a probing job's body reads back what it posted. Unset means no surface here can,
   * which a `report.probe` job is told plainly rather than left to read as silence.
   */
  read?: JobReader;
  /** Where verdict artifacts are written. Defaults to a directory under the system temp. */
  workDir?: string;
  /** Every run record, always — denied and dropped ticks included. */
  onRun?: (run: JobRun) => void;
  /**
   * The environment a job body is built *from* — never the environment it gets. Defaults to
   * this process's, and either way only `passthroughEnv` and what the job declared survive
   * the trip. A job body is spawned from the bundle exactly as an MCP server is, and that
   * is the reason it is scrubbed rather than the reason it would not be: an MCP server's
   * `command` is bundle code too, and the gateway's own environment stays out of its reach.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Where `run.secrets` refs are resolved from — the same options `McpBroker` takes, so one
   * mounted secrets directory answers for every child that declares a credential.
   */
  /**
   * Where `run.secrets` refs are resolved from, and the only thing this host resolves at
   * all. More than one directory means a job body may be handed a credential the rest of
   * this process cannot read as a file — see {@link resolveSecret}.
   */
  secretOpts?: { dir?: string | readonly string[]; env?: NodeJS.ProcessEnv };
}

/**
 * One gate the job body observed. Deliberately not a verdict: the body reports what it
 * *ran*, and this host is the only thing that turns that into a PASS. A body cannot write
 * `{"status":"PASS"}` because nothing here reads a status.
 */
const GateResultSchema = z
  .object({
    gate: z.string().min(1),
    /** Did the gate process start? Nothing about how it ended — that is `exitCode`. */
    executed: z.boolean(),
    /** What it said on the way out. `null` when it never said anything. */
    exitCode: z.number().int().nullable(),
    /** The body's own sentence about this gate. Rendered by `describeVerdict`, never read to decide. */
    detail: z.string().optional(),
  })
  // Strict because the field a body would add is `status`, and quietly ignoring an attempt
  // to compose a verdict is worse than refusing the artifact: refusing reads as UNKNOWN.
  .strict();

const VerdictArtifactSchema = z.object({ gates: z.array(GateResultSchema) }).strict();

/** The validated values one run was given, by declared name. */
export type JobParams = Readonly<Record<string, string | number>>;

/**
 * The longest a string parameter may be, whatever its declared pattern admits.
 *
 * Not a manifest field. It is a ceiling on an environment variable whose contents a channel
 * message chose, not the author's own bound — that is the pattern's job, and a pattern says
 * length better than a second field could: `^[a-z-]{1,64}$` puts the shape and the size in
 * one place, where they cannot disagree. Well above any id, slug, branch, or path a target
 * is, and nowhere near long enough to be a payload.
 */
export const MAX_PARAM_LENGTH = 1024;

/**
 * What a caller may hand a run, checked against what the job declared.
 *
 * Called twice on the tool path, and the repetition is the design. `job-server` calls it so
 * an invalid value is refused **at the tool call**, where the brain is told what was wrong
 * and can fix it inside the same turn rather than several minutes into unattended work.
 * `envelope` calls it because the doors keep multiplying — a chat tool, an operator's CLI —
 * and a bound only some of them apply is a bound the manifest cannot be read for.
 *
 * Refuses rather than ignores an undeclared name, on `GateResultSchema`'s reasoning: quietly
 * dropping a value somebody meant to send is how a run acts on a target nobody chose.
 */
export function jobParams(job: JobConfig, given: Readonly<Record<string, unknown>>): JobParams {
  const declared = Object.entries(job.parameters);
  const named = declared.map(([name]) => name);
  const params: Record<string, string | number> = {};

  for (const name of Object.keys(given)) {
    // `hasOwn`, not `in`: `in` walks the prototype, so `toString` would read as declared
    // here and then be dropped by the loop below — a value somebody sent, silently ignored.
    if (Object.hasOwn(job.parameters, name)) continue;
    throw new Error(
      `job ${job.slug} declares no parameter "${name}" — it takes: ` +
        (named.join(", ") || "no parameter at all"),
    );
  }

  for (const [name, spec] of declared) {
    const value = given[name];
    if (value === undefined || value === null) {
      if (spec.required) throw new Error(`job ${job.slug}: parameter "${name}" is required`);
      continue;
    }
    const bad = (what: string) => new Error(`job ${job.slug}: parameter "${name}" ${what}`);

    if (spec.type === "integer") {
      // A JSON number and nothing else. A digit string would parse to the same value, and
      // accepting one would make the advertised type advice rather than the contract.
      //
      // *Safe*, because this is handed on as text: `String(1e21)` is `"1e+21"`, which a body
      // reading it back with `parseInt` sees as 1. A value that does not survive the
      // transport must not pass validation — nothing above 2^53 is an id anyway.
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw bad(`must be an integer, not ${JSON.stringify(value)}`);
      }
      const { minimum, maximum } = spec;
      if (minimum !== undefined && value < minimum) throw bad(`must be >= ${minimum}`);
      if (maximum !== undefined && value > maximum) throw bad(`must be <= ${maximum}`);
      params[name] = value;
      continue;
    }

    if (typeof value !== "string") throw bad(`must be a string, not ${JSON.stringify(value)}`);

    // A closed list is the whole bound. Length and shape are not also applied to it: those
    // could refuse a value the manifest itself wrote down, which is a bound arguing with
    // itself and no reader could tell which one was meant.
    if (spec.values) {
      if (!spec.values.includes(value)) throw bad(`must be one of: ${spec.values.join(", ")}`);
      params[name] = value;
      continue;
    }

    if (value.length > MAX_PARAM_LENGTH) {
      throw bad(`is longer than ${MAX_PARAM_LENGTH} characters`);
    }
    // Whatever the declared pattern admits, this cannot: a spawn renders each entry as
    // `key=value`, and `EnvVarName` refuses a null byte in a name for the same reason.
    if (value.includes("\u0000")) throw bad("cannot contain a null byte");
    // The schema admits exactly one of the two bounds, so this holds. If that ever stops
    // being true, an unbounded string is refused rather than handed to a body.
    if (!spec.pattern) throw bad("declares no bound, so no value for it is admitted");
    if (!new RegExp(spec.pattern).test(value)) throw bad(`does not match ${spec.pattern}`);
    params[name] = value;
  }
  return params;
}

/**
 * The platform deadline, derived here and nowhere else.
 *
 * `activeDeadlineSeconds`, a launchd timeout, and a workflow `timeout-minutes` are all this
 * sum. An operator who can set the budget and the deadline independently will eventually
 * set the deadline below the budget, and then the process is SIGKILLed mid-write: no
 * cleanup runs, so a claimed item stays claimed and a half-written change is left dangling.
 */
/**
 * How long a shutdown will hold the process open for verdicts already going out.
 *
 * Small, and deliberately not a manifest field. This bounds a channel round trip, which is
 * under a second when a surface is answering at all — and the wait has no value once one has
 * stopped, because a message that is not going to arrive does not arrive any harder for the
 * process staying up. What the wait costs is everything a shutdown does after it: the resume
 * cursor is persisted last, and a restart that lost it re-reads a window it already answered.
 *
 * Distinct from every other clock here, and the distinction is the point: a job body is
 * bounded by its own budget in minutes, a sentence about one by the surface in seconds.
 */
const SAY_GRACE_MS = 5_000;

export function jobDeadlineMs(job: JobConfig): number {
  return job.budget.wallClockMs + job.budget.deadlineHeadroomMs;
}

interface Execution {
  /** False only when the process never started at all — a bad command, a missing binary. */
  started: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when this host stopped it for running out of wall clock. */
  bowedOut: boolean;
}

export class JobHost {
  /**
   * Single-flight, per slug, within this process. Across processes the platform provides
   * it — a CronJob's `concurrencyPolicy: Forbid` — which is honest about a real limit:
   * `Forbid` cannot see across two objects, so a job arming both a schedule and a webhook
   * can still overlap. A cross-process lease is the first thing to build when one does.
   */
  private inFlight = new Set<string>();

  /**
   * The runs this host answered for and still owes a record, by run id.
   *
   * Only detached runs are in here, and that is the whole distinction: a caller that waited
   * is holding the record itself, while a detached one was told "it started" and has nothing
   * else coming unless this host produces it. Nothing but this map knows that debt exists.
   */
  private owed = new Map<string, () => Promise<void>>();

  /**
   * Settlements that have been claimed and are still being said out loud.
   *
   * A claim is taken before the post goes out, so between those two moments a run is in
   * neither {@link owed} nor anywhere else a shutdown can see it — and the answer somebody
   * is waiting on is exactly what is in flight. Announcing is bounded by the surface rather
   * than by the job's clock, which is why waiting for *this* costs a shutdown nothing the
   * grace period cannot afford, while waiting for a body would cost it everything.
   */
  private saying = new Set<Promise<void>>();

  /**
   * Set once {@link abandon} has made its settlement pass. A host past this point starts no
   * body, because there is nothing left to supervise one or to say what it found.
   */
  private closed = false;

  constructor(private opts: JobHostOptions = {}) {}

  /**
   * A clock tick. Nobody asked for it, so there is nobody to bypass a parked switch.
   *
   * Every entry point here exists so the trigger is stamped by which one was called rather
   * than passed in as an argument. A job body that could name its own trigger could claim
   * a human asked for what a clock started.
   */
  async tick(job: JobConfig): Promise<JobRun> {
    return this.run(job, "schedule", null, {});
  }

  /**
   * Somebody asked for this run. Only a human's request bypasses a parked job — a sibling
   * agent asking is automation, and `on-request` is a trigger, not an authorization.
   *
   * The requester is resolved from the inbound author by whoever holds the surface, never
   * self-reported by the job.
   */
  async request(
    job: JobConfig,
    requestedBy: JobRequester,
    params: JobParams = {},
  ): Promise<JobRun> {
    return this.run(job, "on-request", requestedBy, params);
  }

  /**
   * An external event. Automation, and subject to the switch exactly like a clock tick.
   *
   * No parameters, and there are none to pass: a webhook carries no payload here, which is
   * why `loadManifest` refuses a job that both requires a value and arms this trigger.
   */
  async webhook(job: JobConfig): Promise<JobRun> {
    return this.run(job, "webhook", null, {});
  }

  /**
   * The same request, answered as soon as it is admitted rather than when it is over.
   *
   * For the caller that cannot wait — a chat turn, against a job whose deadline is longer
   * than the turn's. Nothing the waiting form produces is skipped: the record is written and
   * the status post goes out exactly as they would have, only after this has returned rather
   * than in it. That is what makes the post load-bearing here, and why {@link announces} does
   * not let a detached run go quiet on a clean verdict — this answer is the last one its
   * caller gets, so silence afterwards would be the whole failure again, an hour later.
   *
   * A refusal is finished here rather than detached. Nothing is in flight, the record is
   * already complete, and answering "started" for a run that never started is the one thing
   * this must not do.
   */
  async startRequest(
    job: JobConfig,
    requestedBy: JobRequester,
    params: JobParams = {},
  ): Promise<JobStart> {
    const { finished, ...start } = await this.begin(job, "on-request", requestedBy, params, true);
    if (start.refused) {
      await finished;
      return start;
    }
    // Nobody holds this promise now, and an unhandled rejection takes the process down with
    // it. `finish` writes the record and says the run out loud itself, so what can still
    // reject here is the host — a work directory it could not make — and the only thing left
    // to do with that is put it where an operator looks.
    finished.catch((error) =>
      console.warn(
        `job_run slug=${job.slug} runId=${start.runId} result=lost reason=` +
          errorLine(error),
      ),
    );
    return start;
  }

  /**
   * Give up the runs this host is still supervising, and say so. The last thing it does.
   *
   * A detached run's caller was told only that it started. If this process exits without a
   * word, that person is left with a promise of a report that can no longer arrive — the
   * same unanswerable silence {@link startRequest} exists to end, one turn later and no
   * easier to tell from being ignored. So the debt is paid before the exit rather than
   * dropped at it.
   *
   * **It does not wait, and that is the point.** A detached job may have twenty minutes
   * left; the deployment contract sizes the grace period between `SIGTERM` and `SIGKILL` to
   * `limits.turnTimeoutMs`, because a turn is what a shutdown was ever meant to outlast.
   * Draining a job instead would blow through that grace — losing the record anyway, after
   * hanging every rolling deploy on the longest job an agent declares — and would re-couple
   * the two clocks this whole shape exists to separate.
   *
   * The body is left alone for the same reason `spawnBody` puts it in its own process group:
   * under a container the platform's deadline takes it, and that is the deployment every
   * job runs in. Stopping it here would mean `SIGKILL` inside the window the headroom
   * reserves for its closing writes, which is the half-written change that design prevents.
   * What is genuinely lost at exit is the record and the answer, and those are what this
   * writes.
   *
   * Closing the door is half of it, and the half that is easy to leave out: a pass that
   * settles what it can see, without stopping what it cannot, misses every run whose
   * admission was still in flight when it ran. So this is a **state**, not an event — after
   * it, {@link begin} starts no body at all.
   *
   * Bounded, because the wait it *does* do is on a surface and a surface can stop answering
   * without ever refusing. Everything after this in a shutdown — the cursor especially —
   * would be held behind one channel that accepted a message and went quiet.
   */
  async abandon(withinMs = SAY_GRACE_MS): Promise<void> {
    this.closed = true;
    const said = (async () => {
      // `owed` is not cleared: the entry *is* the claim, and dropping the map wholesale
      // would take it out from under a body finishing normally at this moment. Each
      // `giveUp` takes its own, and whichever settler gets there first is the one that
      // speaks.
      await Promise.all([...this.owed.values()].map((giveUp) => giveUp()));

      // Then wait out whatever is mid-sentence, including a run that claimed itself moments
      // before this began and whose verdict is on its way to a channel right now.
      //
      // In a loop rather than once, because a body finishing during the pass above claims
      // itself and starts speaking after any single snapshot was taken. It terminates
      // because no new run can start — `closed` is already set — so each pass has strictly
      // fewer bodies left to finish than the last.
      while (this.saying.size > 0) await Promise.all([...this.saying]);
    })();
    // The race below can leave this pending, and a pending rejection nobody is holding takes
    // the process down — which is the opposite of what a bounded shutdown is for. The `await`
    // still sees it, because a promise may be handled twice.
    said.catch(() => {});

    try {
      await withTimeout(said, withinMs, `not everything could be said inside ${withinMs}ms`);
    } catch (error) {
      // A surface that stopped answering, or a record sink that threw. Both are one line for
      // whoever is reading the log afterwards, and neither may hold the exit.
      console.warn(
        `job_abandon result=incomplete saying=${this.saying.size} reason=` +
          errorLine(error),
      );
    }
  }

  /**
   * One settlement per run, to whoever asks first.
   *
   * A detached run has two settlers that can overlap — its own body finishing, and a
   * shutdown giving up on it — and nothing orders them. Two winners is not a tidiness
   * problem: it is one run id with two terminal records, and a channel told `abandoned,
   * NOT PROVEN` and then `completed, PROVEN` about the same run, seconds apart. Which one a
   * reader acts on is then whichever they happened to see.
   *
   * `Map.delete` answers whether it removed anything, so taking the entry and testing the
   * claim are the same indivisible act. A run with no entry has no claim to take — it was
   * either settled already, or it was never detached, and a waited-for run's caller is
   * holding its record.
   */
  private claim(runId: string): boolean {
    return this.owed.delete(runId);
  }

  /**
   * Says a settled run out loud, where a shutdown can see that it is still being said.
   *
   * The claim has already been taken by the time this runs, so this is the only window in
   * which a settlement exists nowhere a shutdown could find it. Both settlers go through
   * here, because either one can be the sentence a shutdown would otherwise cut off.
   */
  private async settle(job: JobConfig, run: JobRun, detached: boolean): Promise<void> {
    const said = this.announce(job, run, detached);
    this.saying.add(said);
    try {
      await said;
    } finally {
      this.saying.delete(said);
    }
  }

  /** One abandoned run: the record, then the last thing its channel will hear about it. */
  private async giveUp(job: JobConfig, base: RunBase, admission: JobAdmission): Promise<void> {
    if (!this.claim(base.runId)) return; // its body finished first and has already spoken
    const run = this.record({
      ...base,
      switch: admission.switch,
      bypassedSwitch: admission.bypassedSwitch,
      outcome: "abandoned",
      // The body ran, and what it exited with is a thing this host will never learn.
      // `exitCode: null` is already the encoding for exactly that — a process that ran and
      // said nothing readable — so an abandoned run is UNKNOWN by the same arithmetic every
      // other unproven run is, rather than by a second rule written here.
      gates: [verdictFromGate({ gate: jobGate(job), executed: true, exitCode: null })],
      reason:
        `this host was asked to stop while the ${job.slug} body was still running, ` +
        "so nothing here will read what it proved",
    });
    await this.settle(job, run, true);
  }

  private async run(
    job: JobConfig,
    trigger: JobTriggerKind,
    requestedBy: JobRequester | null,
    params: JobParams,
  ): Promise<JobRun> {
    return (await this.begin(job, trigger, requestedBy, params)).finished;
  }

  /**
   * Says the run out loud, when it is worth saying, in the shape the whole fleet reads:
   * one line at top level and the gates threaded beneath it.
   *
   * After the record and never in front of it, and best-effort per line: a relay outage
   * must not fail a job that did its work, and one refused line must not take the lines
   * behind it. The record is already written whatever happens here, which is what makes it
   * safe for this to swallow.
   */
  private async announce(job: JobConfig, run: JobRun, detached = false): Promise<void> {
    const report = job.report;
    const post = this.opts.post;
    if (!report || !post || !announces(run, detached, report.announce)) return;
    const { headline, detail } = jobStatus(run);

    // Every line is attempted on its own. One rejection is as likely to be about one
    // message — too long, rate-limited, refused by the guard — as about the channel, and a
    // shared `try` would let that drop every gate explanation queued behind it. A noisy
    // line beats a lost failure report, which is the same rule that puts orphaned detail
    // at top level below.
    const lost: string[] = [];
    const say = async (text: string, threadRoot?: EventRef): Promise<EventRef | undefined> => {
      try {
        return await post(report, text, threadRoot);
      } catch (error) {
        lost.push(errorLine(error));
        return undefined;
      }
    };

    // `root` is undefined when the headline never landed, or landed and the surface named
    // no id. The detail then posts at top level: noisier than intended, and the
    // alternative is dropping the lines that say *why* the headline reads the way it does.
    const root = await say(headline);
    for (const line of detail) await say(line, root);

    // One line for the run rather than one per failure: a channel that is down fails every
    // post, and the same sentence logged five times is still one fact. The count is what
    // separates the two cases — all of them lost is an outage, one is a refused message.
    if (lost.length > 0) {
      console.warn(
        `job_status slug=${job.slug} result=partial ` +
          `lost=${lost.length}/${detail.length + 1} reason=${lost[0]}`,
      );
    }
  }

  /**
   * Everything up to the body — the door, the slug, the switch — and then the body itself,
   * handed back as a promise rather than awaited.
   *
   * Split from {@link finish} for the one caller that answers before the body is done. Both
   * halves happen in the same order whoever calls this: the record is written first and the
   * channel hears second, because a status post about a run the record does not have is a
   * report nobody can go back and check.
   */
  private async begin(
    job: JobConfig,
    trigger: JobTriggerKind,
    requestedBy: JobRequester | null,
    params: JobParams,
    detached = false,
  ): Promise<Started> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const base: RunBase = {
      jobSlug: job.slug,
      runId,
      trigger,
      requestedBy,
      startedAt,
      parameters: params,
    };
    const didNotRun = verdictFromGate({ gate: jobGate(job), executed: false, exitCode: null });
    // A run that never started is never detached: whoever asked is holding this record and
    // is about to read it out, so the channel's copy is the ordinary one.
    const refuse = (refused: JobRun): Started => ({
      runId,
      refused,
      finished: this.announce(job, refused).then(() => refused),
    });

    // Refused first, and here rather than at each door, because the doors keep multiplying
    // — a CronJob, an operator's CLI, a chat tool — and every one of them would otherwise
    // re-implement this or forget to.
    //
    // Not a tidiness check. A job that arms only `onRequest` may legally declare no kill
    // switch, because nothing about it is unattended; `loadManifest` refuses that same job
    // the moment it takes a schedule. Starting it on a schedule anyway is unattended work
    // nothing can stop without a deploy, which is the one shape the manifest exists to make
    // unwritable.
    if (!arms(job, trigger)) {
      return refuse(
        this.record({
          ...base,
          outcome: "denied-trigger",
          switch: null,
          bypassedSwitch: false,
          gates: [didNotRun],
          reason: `${job.slug} does not arm the ${trigger} trigger, so nothing may start it that way`,
        }),
      );
    }

    // Claimed before the first `await`, so two ticks in one turn of the event loop cannot
    // both find the slug free and both proceed.
    if (this.inFlight.has(job.slug)) {
      return refuse(
        this.record({
          ...base,
          outcome: "skipped-overlap",
          switch: null,
          bypassedSwitch: false,
          gates: [didNotRun],
          reason: `a ${job.slug} run is still in flight; this ${trigger} tick was dropped`,
        }),
      );
    }
    this.inFlight.add(job.slug);

    // Released here for every path that does not reach a body. The path that does hands the
    // claim to `finish` instead: a detached run's caller has already been answered, and
    // single-flight has to hold until the body is over rather than until this returns.
    let running = false;
    try {
      const admission = await admitJob(job, { trigger, requestedBy }, this.opts.switchSource);
      if (!admission.admitted) {
        return refuse(
          this.record({
            ...base,
            outcome: admission.outcome ?? "denied-switch",
            switch: admission.switch,
            bypassedSwitch: false,
            gates: [didNotRun],
            reason: admission.reason,
          }),
        );
      }
      // Checked here rather than at the top, because reading a switch is the slowest thing
      // this function does and a shutdown lands inside that await as readily as before it.
      // A body started now is work nothing is left to hold to its clock, read a verdict
      // from, or answer for — and this run would not even be in `owed` when the one
      // settlement pass ran. Refusing is the honest end: the caller is told, in the same
      // words every other refusal uses, that it did not start.
      if (this.closed) {
        return refuse(
          this.record({
            ...base,
            outcome: "abandoned",
            switch: admission.switch,
            bypassedSwitch: admission.bypassedSwitch,
            // Never ran, and the gate says so — the same `abandoned` as a run whose body was
            // already going, told apart by the one field that knows the difference.
            gates: [didNotRun],
            reason:
              `this host was asked to stop while ${job.slug} was still being admitted, ` +
              "so the run was never started",
          }),
        );
      }
      running = true;
      if (detached) this.owed.set(runId, () => this.giveUp(job, base, admission));
      return {
        runId,
        refused: null,
        // The claim is `finish`'s to take, so nothing is deleted from `owed` here: releasing
        // it on the way out would drop a settlement that a shutdown had already made.
        finished: this.finish(job, base, admission, detached).finally(() =>
          this.inFlight.delete(job.slug),
        ),
      };
    } finally {
      if (!running) this.inFlight.delete(job.slug);
    }
  }

  /** The body, the record it produced, and the post that says so — in that order. */
  private async finish(
    job: JobConfig,
    base: RunBase,
    admission: JobAdmission,
    detached: boolean,
  ): Promise<JobRun> {
    const done = {
      ...base,
      switch: admission.switch,
      bypassedSwitch: admission.bypassedSwitch,
      ...(await this.execute(job, base)),
    };
    // A detached run may have been given up on while its body was finishing, and the loser
    // of that race says nothing at all: the record is sealed for the caller's return value
    // and goes no further. A waited-for run has no claim to take and never loses one.
    if (detached && !this.claim(base.runId)) return this.seal(done);

    const run = this.record(done);
    await this.settle(job, run, detached);
    return run;
  }

  /** Spawn the body, hold it to its wall clock, and read back what it says it ran. */
  private async execute(
    job: JobConfig,
    base: RunBase,
  ): Promise<Pick<JobRun, "outcome" | "gates" | "reason">> {
    const verdictPath = join(await this.workDir(), `${job.slug}-${base.runId}.json`);
    const unstarted = verdictFromGate({ gate: jobGate(job), executed: false, exitCode: null });

    let env: NodeJS.ProcessEnv;
    let channel: HostedMcp | undefined;
    try {
      channel = await this.openChannel(job);
      env = this.envelope(job, base, verdictPath, channel);
    } catch (error) {
      // Opened before it was known whether the envelope could be built, so a listener can
      // already be up when this runs.
      await channel?.close();
      // A job resolves its credentials per run, not once at `connect()` the way an MCP
      // server does, so this fires on a timer or inside a CronJob — where a throw would be
      // an unhandled rejection and the whole of what anyone saw. It is the same shape as a
      // body that could not be started: unstarted gate, UNKNOWN verdict, and a run record
      // naming the ref. `sageox-agent run` and `doctor` check the same refs up front; the
      // CronJob entry point has no launch to refuse, so this is its only report. A
      // `report.probe` job with no reachable channel arrives here by the same route — see
      // {@link openChannel}.
      return {
        outcome: "crashed",
        gates: [unstarted],
        reason: `the job body could not be started: ${errorLine(error)}`,
      };
    }
    // Closed the moment the body is: this listener exists for one run, and one that
    // outlived its body would be a port on this host with a live token and nothing left
    // that legitimately holds it.
    const execution = await this.spawnBody(job, env).finally(() => channel?.close());

    if (!execution.started) {
      return {
        outcome: "crashed",
        gates: [unstarted],
        reason: `the job body could not be started: ${job.run.command} did not run`,
      };
    }
    const gates = await this.readGates(verdictPath, job);

    // A body this host stopped never got to speak, whatever it managed to exit with on the
    // way out — a job told to stop has not finished its work, so a 0 from it is not a
    // statement about that work. `exitCode: null` is the one input that yields UNKNOWN for
    // a process that ran, and it is the same encoding a signal death already arrives as.
    const processGate = verdictFromGate({
      gate: jobGate(job),
      executed: true,
      exitCode: execution.bowedOut ? null : execution.exitCode,
    });

    if (execution.bowedOut) {
      return {
        outcome: "budget-bowout",
        gates: [processGate, ...gates],
        reason:
          `the job body was still running after its ${job.budget.wallClockMs}ms wall clock ` +
          `and was asked to stop, with ${job.budget.deadlineHeadroomMs}ms to finish writing`,
      };
    }
    if (execution.exitCode === null) {
      return {
        outcome: "crashed",
        gates: [processGate, ...gates],
        reason: `the job body died on ${execution.signal ?? "an unreported signal"}`,
      };
    }
    // Exit 1 is `completed`: the envelope did its work and the body found something. What it
    // found is the verdict's business, and it is a FAIL.
    return {
      outcome: "completed",
      gates: [processGate, ...gates],
      reason: `the job body exited ${execution.exitCode}`,
    };
  }

  /**
   * The channel this run's body talks through, or nothing when it declared no probe.
   *
   * Refusing here rather than starting the body without it is the same call `envelope`
   * makes on an unresolvable `secretRef`, for the same reason: a probe's whole work is the
   * conversation, and a body that could not post is not a job that ran quietly — it is one
   * whose verdict would be minted from a channel it never spoke into. Unstarted gate,
   * UNKNOWN verdict, and a run record naming what was missing.
   */
  private async openChannel(job: JobConfig): Promise<HostedMcp | undefined> {
    if (!job.report?.probe) return undefined;
    if (!this.opts.post) {
      throw new Error(
        `job ${job.slug} declares report.probe and nothing here can reach ` +
          `${job.report.surface}:${job.report.channel}`,
      );
    }
    return serveJobChannel({ report: job.report, post: this.opts.post, read: this.opts.read });
  }

  private spawnBody(job: JobConfig, env: NodeJS.ProcessEnv): Promise<Execution> {
    return new Promise<Execution>((resolve) => {
      // `command` + `args[]` is the whole interface: no shell, so nothing can be word-split
      // or interpolated into one. Only the bundle ever names these — never a channel
      // message, an issue body, or a webhook payload.
      const child = spawn(job.run.command, job.run.args, {
        stdio: ["ignore", "inherit", "inherit"],
        env,
        // Its own process group, so stopping a job stops what the job started. Every
        // real job body shells out — to a coding harness, to a test run, to `gh` — and
        // signalling only the body leaves those children running past the budget, still
        // spending and still able to act on the world after the job was told to stop.
        // The budget would hold for the process and not for the work.
        //
        // The cost of the group: a job body no longer inherits signals sent to this
        // process. Under a container that is the same thing either way — the platform's
        // deadline takes the whole pod — and it is the deployment every job runs in.
        detached: true,
      });

      /** The group, not the process. Already-gone is not a failure to stop something. */
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          /* it exited between the timer firing and this call */
        }
      };

      let bowedOut = false;
      // SIGTERM at the budget, SIGKILL at the deadline: the gap is the body's chance to
      // release what it claimed. A job that ignores SIGTERM still cannot outlive the
      // platform's own deadline, which is the same sum.
      const bowOut = setTimeout(() => {
        bowedOut = true;
        stop("SIGTERM");
      }, job.budget.wallClockMs);
      const hardStop = setTimeout(() => stop("SIGKILL"), jobDeadlineMs(job));

      const settle = (execution: Execution) => {
        clearTimeout(bowOut);
        clearTimeout(hardStop);
        resolve(execution);
      };
      child.on("error", () =>
        settle({ started: false, exitCode: null, signal: null, bowedOut: false }),
      );
      child.on("exit", (exitCode, signal) => {
        // The job is over when its body is, so nothing the body started may outlive it.
        //
        // Without this the timeout path is guarded and the ordinary path is not: a body
        // that finishes early having left a harness up leaves it running with both timers
        // cleared and the run recorded `completed` — unbounded, rather than merely past
        // the deadline. There is no grace to give here that the budget did not already
        // give: whatever is still up had the body's whole wall clock to finish, and the
        // process that was supposed to wait for it has declared itself done.
        //
        // Best-effort in exactly one case, and unavoidably so: a body that spawns and exits
        // in the same breath can lose the race, because the fork lands after the parent it
        // would have been grouped with is already gone. Nothing a host does closes that —
        // there is no group left to signal. The container boundary is what covers it.
        stop("SIGKILL");
        settle({ started: true, exitCode, signal, bowedOut });
      });
    });
  }

  /**
   * The envelope, and the whole of what a job body is told.
   *
   * Flat variables rather than one JSON blob because a job body may be a shell script or a
   * compiled binary as easily as it is TypeScript, and `$JOB_DEADLINE_AT` needs no parser.
   *
   * The bounds this host cannot enforce are handed over rather than dropped: it can hold a
   * job to a clock without knowing what it does, but it cannot count iterations, attempts,
   * or dollars without knowing what one is. Passing them on is the honest half — claiming a
   * control the runtime does not hold is the same defect as a composed verdict, one level up.
   *
   * Built, never inherited. The layers are ordered by how explicit each one is, and the
   * order is the design:
   *
   * 1. `passthroughEnv` — the six variables a process needs to run, plus the names this job
   *    declared in `passthrough`. Nothing else in `opts.env` reaches the body.
   * 2. `run.env` — plain configuration, from the bundle.
   * 3. `run.secrets` — resolved refs. A secret wins over config of the same name, so a
   *    credential can never be silently downgraded to a hardcoded value (`McpBroker` orders
   *    them the same way, for the same reason).
   * 4. The `JOB_*` envelope, which is the host's and outranks all of it: a body that could
   *    redefine `JOB_VERDICT_PATH` could point this host at a file it wrote in advance. The
   *    `JOB_PARAM_*` values this run was given are part of that block, for the same reason,
   *    and so is `JOB_CHANNEL_*` when this run has a channel to talk through.
   */
  private envelope(
    job: JobConfig,
    base: RunBase,
    verdictPath: string,
    channel?: HostedMcp,
  ): NodeJS.ProcessEnv {
    const secrets: NodeJS.ProcessEnv = {};
    for (const [envVar, ref] of Object.entries(job.run.secrets)) {
      const value = resolveSecret(ref, this.opts.secretOpts ?? {});
      // Refusing here names the missing ref. Handing the body a hole instead produces an
      // auth failure several minutes into unattended work, attributed to whatever it called.
      if (!value) throw new Error(`job ${job.slug}: secretRef ${ref} did not resolve`);
      secrets[envVar] = value;
    }
    const env: NodeJS.ProcessEnv = {
      ...passthroughEnv(this.opts.env ?? process.env, job.run.passthrough),
      ...job.run.env,
      ...secrets,
      JOB_SLUG: job.slug,
      JOB_RUN_ID: base.runId,
      JOB_TRIGGER: base.trigger,
      JOB_VERDICT_PATH: verdictPath,
      /** When this host will ask the body to stop. The body should bow out before it. */
      JOB_DEADLINE_AT: String(Date.now() + job.budget.wallClockMs),
      JOB_HARNESS_TIMEOUT_MS: String(job.budget.harnessTimeoutMs),
      JOB_MAX_ITERATIONS: String(job.budget.maxIterations),
      JOB_MAX_ATTEMPTS: String(job.budget.maxAttempts),
      // Only a `report.probe` job has these, and only for as long as its body runs. In the
      // `JOB_*` block for the reason the rest of it is here: a body that could redefine the
      // address would be choosing what it talks to.
      ...(channel ? { JOB_CHANNEL_URL: channel.url, JOB_CHANNEL_TOKEN: channel.token } : {}),
    };
    if (job.budget.maxSpendUsd !== undefined) {
      env.JOB_MAX_SPEND_USD = String(job.budget.maxSpendUsd);
    }
    if (job.model) env.JOB_MODEL = job.model;
    // In the envelope and not beside `run.env`, for the reason the rest of the block is
    // here: a body that could redefine its own target through `env` would be choosing what
    // the caller was supposed to choose. Re-validated rather than trusted — see
    // {@link jobParams}, and this is the door a CLI comes through.
    for (const [name, value] of Object.entries(jobParams(job, base.parameters))) {
      env[`JOB_PARAM_${name.toUpperCase()}`] = String(value);
    }
    return env;
  }

  /**
   * A missing or unparseable artifact is UNKNOWN — not an error, and never a pass.
   *
   * The fail-safe falls out of the file's absence rather than out of someone remembering to
   * handle it. A job that ran, exited 0, and reported nothing has proven nothing, and an
   * empty gate list says so in the body's own words.
   */
  private async readGates(verdictPath: string, job: JobConfig): Promise<readonly Verdict[]> {
    const unproven = [
      verdictFromGate({ gate: `${jobGate(job)}:verdict`, executed: false, exitCode: null }),
    ];
    try {
      const parsed = VerdictArtifactSchema.safeParse(JSON.parse(await readFile(verdictPath, "utf8")));
      if (!parsed.success || parsed.data.gates.length === 0) return unproven;
      return parsed.data.gates.map(verdictFromGate);
    } catch {
      return unproven;
    } finally {
      // The gates are in the record now; leaving the file behind would accumulate one per
      // tick on a host that runs a job every ten minutes.
      await rm(verdictPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Completes a record and tells nobody. Split from {@link record} for the one caller that
   * built a true record and then lost the right to publish it — see {@link claim}.
   */
  private seal(run: Omit<JobRun, "endedAt" | "verdict">): JobRun {
    return { ...run, endedAt: Date.now(), verdict: combineVerdicts(run.gates) };
  }

  private record(run: Omit<JobRun, "endedAt" | "verdict">): JobRun {
    const complete = this.seal(run);
    this.opts.onRun?.(complete);
    return complete;
  }

  /**
   * Not memoized: `recursive: true` is idempotent, and a job run spawns a whole child
   * process, so one `mkdir` is noise beside it. A cached promise here would be a cached
   * *rejection* too — one transient failure and every later run on this host fails for a
   * reason that stopped being true.
   */
  private async workDir(): Promise<string> {
    const dir = this.opts.workDir ?? join(tmpdir(), "sageox-agent-jobs");
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

/**
 * A finished run, in the two tiers a fleet channel is read in.
 *
 * `#hive` is scanned rather than read. A person scrolling wants the verdict in a second;
 * the per-gate lines are the longest and most numerous thing a run produces, and on a bad
 * run they bury every other agent's status. So the headline carries **how many** gates went
 * unproven and the gates themselves sit underneath — progressive disclosure, not
 * suppression. A bad run is never invisible, only un-shouted.
 *
 * Structured rather than a string because a channel needs the halves apart: the headline
 * posts at top level and the detail threads beneath it. Everywhere else flattens it with
 * {@link describeJobRun}. The verdict line is `describeVerdict`'s, so an unrun gate cannot
 * be phrased as a passing one here either.
 */
export function jobStatus(run: JobRun): { headline: string; detail: readonly string[] } {
  // With one gate the combined verdict already *is* that gate, said once — and a count is
  // only information when there is something for it to be a count of.
  const threaded = run.gates.length > 1;
  const unproven = run.gates.filter((gate) => !isProven(gate)).length;
  const tally = threaded ? ` ${unproven} of ${run.gates.length} gates did not pass.` : "";

  return {
    headline:
      `job ${run.jobSlug} ${run.outcome} in ${run.endedAt - run.startedAt}ms — ` +
      `${run.reason}. ${describeVerdict(run.verdict)}${tally}`,
    detail: threaded ? run.gates.map(describeVerdict) : [],
  };
}

/**
 * The same run as one block of text, for every door that has no threads: the CLI a CronJob
 * execs, and the chat tool.
 *
 * One rendering underneath all of them, because a run that reads one way on a terminal and
 * another in a channel is two reports of one run, and the one somebody acts on is whichever
 * they saw.
 */
export function describeJobRun(run: JobRun): string {
  const { headline, detail } = jobStatus(run);
  const lines = [headline, ...detail.map((line) => `  ${line}`)];
  // Only ever true for a run a human asked for, so it reaches the person who asked. It is
  // deliberately not in the headline: the channel is told about runs, not about postures.
  if (run.bypassedSwitch) lines.push("  it ran while parked; the posture is unchanged");
  return `${lines.join("\n")}\n`;
}

/**
 * Whether this run is said out loud.
 *
 * Silence is allowed for findings and never for the record: every run reaches `onRun`, and
 * only some reach a channel. A proven run says nothing — a job that found nothing posts
 * nothing is the fleet's rule and it is right.
 *
 * A denied one says nothing either. Refusing to start a parked job is the posture somebody
 * chose, and announcing it every ten minutes is how a channel teaches its readers to skim
 * past the announcement that was real. `denied-trigger` is not that: a job started through
 * a door it never declared is a job wired to the wrong job, and nobody chose it.
 *
 * A detached run is the one exception, and it is the same rule rather than a hole in it. A
 * run whose caller waited answered that caller — the verdict went back as a return value,
 * and the post is a second copy the channel may be spared. A detached one already told
 * whoever asked only that it started, so this post is the answer, not a copy of it, and
 * dropping it for a clean verdict would leave a question asked in a channel with no reply.
 *
 * `report.announce: always` asks for that same separation on a schedule, and a job whose
 * successes are its point needs it: with only the verdict to speak through, such a job has
 * to claim it proved nothing to be heard at all, and its headline then reads `FAILED` over
 * words saying the work went fine. What speaks changes; what the run is called does not —
 * the status word is minted from the verdict either way.
 *
 * `report.announce: reported` asks for less than `always` and is for the job neither other
 * mode fits: one that is both scheduled and reporting, whose idle ticks are most of its
 * ticks. Under `always` those ticks are a half-hourly "nothing to report" — the noise a
 * channel's readers learn to skim — and under the default a wholly successful run has
 * nothing unproven left to announce. So it posts when the body wrote a `detail` on some
 * gate: a body writing gates without prose is reporting outcomes the verdict already speaks
 * for, and one writing a `detail` has composed a sentence for a human. Keying on that
 * rather than on the gate list leaves the floor where it is — a body that wrote no gates is
 * UNKNOWN, and an unproven run announces under every mode.
 *
 * The two denied outcomes stay silent in every mode. They are a posture somebody chose, and
 * the run whose verdict these modes weigh never happened.
 */
function announces(run: JobRun, detached: boolean, announce: JobAnnounce): boolean {
  if (run.outcome === "denied-switch" || run.outcome === "denied-suspend") return false;
  if (detached || announce === "always" || !isProven(run.verdict)) return true;
  return announce === "reported" && run.gates.some((gate) => gate.detail);
}

/** The host's own gate: did the process run, and what did it say on the way out. */
function jobGate(job: JobConfig): string {
  return `job:${job.slug}`;
}

/** Whether this job declared that this door may open it. */
function arms(job: JobConfig, trigger: JobTriggerKind): boolean {
  if (trigger === "schedule") return job.trigger.schedules.length > 0;
  if (trigger === "on-request") return job.trigger.onRequest;
  return job.trigger.webhook;
}
