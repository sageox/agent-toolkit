import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorLine, errorText } from "./errors.ts";
import type { ChannelRef, InboundEvent } from "./events.ts";
import type { Gateway, TickOutcome } from "./gateway.ts";
import { admitJob, type SwitchSource } from "./kill-switch.ts";
import {
  announces,
  jobGate,
  jobStatus,
  type JobPoster,
  type JobRun,
} from "./job-host.ts";
import { JOB_ARTIFACT_LIMIT_BYTES } from "./job-output.ts";
import type { PromptJob } from "./manifest.ts";
import { combineVerdicts, verdictFromGate } from "./verdict.ts";
import type { WorkStart } from "./work-events.ts";

/**
 * The light tier of scheduled work: a clock tick that runs an ordinary guarded brain turn
 * in this process, rather than spawning a body in a pod of its own.
 *
 * Everything around it is the envelope `jobs[]` already has — the trigger, the switch,
 * `suspend`, `report`, the run record — and only the body differs. What that buys is the
 * work a job cannot do and a turn cannot be woken for: read one surface's channel,
 * summarize it with the agent's own tools, and post the summary on another, at 18:00,
 * without anybody posting a mention at 18:00.
 *
 * The credential line is unmoved in both directions. This tier holds none — it is a turn,
 * so it reaches exactly what the brain already reaches through the guard — and a `run`
 * body still cannot reach the brain. See `docs/job-contract.md`, "A job that is a turn".
 */

/** The words one prompt job's tick sends, and where they came from. */
export interface JobPrompt {
  /** An absolute path, or `inline` for a one-liner written in the manifest. */
  source: string;
  /** What the source was, in bytes — `doctor` prints it so a silent edit is visible. */
  bytes: number;
  /** What the tick sends: the body, with the frontmatter removed. */
  body: string;
}

/**
 * The frontmatter a prompt file carries.
 *
 * Nothing reads either field yet, and requiring them anyway is the point: the file is
 * shaped like a skill now so that the day one can be offered to the chat face — "run the
 * digest now", asked by a person — the file does not have to change and the job does not
 * need a second declaration. Unknown keys are dropped rather than refused, so a file that
 * grows a field this version has never heard of still loads.
 */
const Frontmatter = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Where a bundle keeps its skills, and what one is called.
 *
 * `skills/<name>/SKILL.md` is the shape the rest of the world already uses for a page of
 * instructions an agent reads and follows, which is exactly what a prompt job's body is.
 * Harness-neutral on purpose: a harness discovers skills under a root of its own choosing,
 * and `docs/naming.md` is why the manifest does not spell one of those roots — this
 * contract outlives any single one.
 */
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

/** Whether `path` is `root` itself or sits beneath it. Both must already be resolved. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * One regular file, read no further than one byte past the bound its caller enforces.
 *
 * `readFileSync` weighs nothing before it allocates: pointed at a large file it takes the
 * whole of it into memory to be told afterwards that it was too big, and pointed at a FIFO
 * it never returns at all. Both would turn a `run`, `doctor` or `validate` load into an
 * OOM or a silent hang, where every other bad prompt in this function is a named refusal.
 *
 * `O_NONBLOCK` is what keeps the *open* from being the thing that blocks — opening a FIFO
 * for reading waits for a writer otherwise.
 *
 * Both checks are made on the descriptor rather than on the path: the kind, and the
 * identity `admitted` pinned from the path containment already passed. Without the second
 * one this reads *a* file at a path that was checked, rather than *the* file that was
 * checked, and a swap in the window between them would put bytes nothing admitted in front
 * of the brain as trusted words.
 *
 * It does not make the bundle safe against something that can write inside it while the
 * gateway starts. Nothing here could: Node exposes no per-component no-follow traversal,
 * and anything able to swap a path in the bundle can write that path's contents instead.
 * What it does is make the containment check mean what it says.
 */
function readBounded(path: string, admitted: Stats): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error("not a regular file — a prompt is a file in the bundle");
    }
    if (opened.dev !== admitted.dev || opened.ino !== admitted.ino) {
      throw new Error("changed between the check that admitted it and the read");
    }
    // One past the limit: enough for the caller to refuse, and never the whole of something
    // that should have been refused.
    const buffer = Buffer.alloc(JOB_ARTIFACT_LIMIT_BYTES + 1);
    let read = 0;
    // A short read is legal even for a regular file, so this fills rather than assumes.
    for (let chunk = -1; chunk !== 0 && read < buffer.byteLength; read += chunk) {
      chunk = readSync(fd, buffer, read, buffer.byteLength - read, read);
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads a prompt job's words, at load and once.
 *
 * Everything here throws rather than degrades. A schedule that discovers at 18:00 that its
 * prompt is missing has nothing to say and no turn to say it in, so the refusal belongs
 * where a person is watching: `run` will not start, and `doctor` and `validate` report it.
 *
 * `agentDir` is the agent's own directory and the path is resolved against it, exactly as
 * `persona` is — the file rides in the bundle image, so editing it restarts the gateway
 * like any other bundle change.
 */
export function readJobPrompt(job: PromptJob, agentDir: string): JobPrompt {
  if (typeof job.prompt === "string") {
    return { source: "inline", bytes: Buffer.byteLength(job.prompt), body: job.prompt };
  }

  const name = job.prompt.skill;
  // The one place the layout is written down. A name is all the manifest supplies, so there
  // is no path here for an operator to point somewhere else and none for this to contain.
  const source = join(resolve(agentDir), SKILLS_DIR, name, SKILL_FILE);
  // Canonical only for the containment test below. The path an operator is shown stays the
  // one they wrote the bundle at — `/private/var/...` on a macOS temp dir is a true answer
  // to a question nobody asked.
  const tree = join(realpathSync(resolve(agentDir)), SKILLS_DIR);
  const named = `job "${job.slug}" skill ${name} (${source})`;

  // What the filesystem says it really is. A slug cannot traverse, but a symlink at any
  // step of `skills/<name>/SKILL.md` can still point out of the bundle — at a mounted
  // credential, or at `workspace/`, where repository checkouts sit refreshed from their
  // remotes. The words go to the brain as steering rather than as fenced data, and the
  // whole argument for that is that they came out of the reviewed bundle; a link is the
  // one way the diff shows a path and never the content it will resolve to.
  //
  // Contained to `skills/` rather than to the agent directory, which is stricter and says
  // what is meant: the bundle's skills tree is where a skill lives, and every other
  // subtree — the runtime's included — is out by construction rather than by a carve-out
  // per subtree.
  //
  // What this cannot see is a *mount* placed inside the tree; a mount point is an ordinary
  // directory to `realpath`. The chart refuses a `sharedVolumes` claim under
  // `/agents/<name>` for that reason.
  let real: string;
  try {
    real = realpathSync(source);
  } catch (error) {
    // Missing, or unreadable on the way down. Same sentence the read below would give.
    throw new Error(`${named}: ${errorText(error)}`);
  }
  if (!within(real, tree)) {
    throw new Error(
      `${named} is a link to ${real}, outside the bundle's ${SKILLS_DIR}/ tree — a prompt is ` +
        "read as steering, so it comes from the bundle and nowhere a review would not see it",
    );
  }

  let raw: Buffer;
  try {
    // The identity of what the containment check admitted, pinned here and compared against
    // the descriptor that gets read — see {@link readBounded}.
    raw = readBounded(real, statSync(real));
  } catch (error) {
    throw new Error(`${named}: ${errorText(error)}`);
  }
  // The same ceiling a verdict artifact has. A prompt is a page; anything approaching this
  // is a document that was pointed at the wrong field. The read above stops one byte past
  // the limit, so this says the bound rather than a size it did not measure.
  if (raw.byteLength > JOB_ARTIFACT_LIMIT_BYTES) {
    throw new Error(`${named} is over the ${JOB_ARTIFACT_LIMIT_BYTES}-byte limit`);
  }
  let text: string;
  try {
    // `readFileSync(path, "utf8")` would substitute U+FFFD for every bad byte and hand
    // back a prompt nobody wrote. Decoding strictly is what turns that into a refusal.
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${named} is not valid UTF-8`);
  }

  const matter = FRONTMATTER.exec(text);
  if (!matter) {
    throw new Error(
      `${named} has no frontmatter — a ${SKILL_FILE} opens with \`---\`, a \`name\` and a ` +
        "`description`, and a closing `---`, then the words the tick sends",
    );
  }
  const parsed = Frontmatter.safeParse(parseYaml(matter[1]!)); // data only — never evaluated
  if (!parsed.success) {
    throw new Error(`${named}: frontmatter needs a \`name\` and a \`description\``);
  }
  // The frontmatter stopped being decorative the moment the manifest addressed this by
  // name: two spellings of one name is how a skill is found under one and announces itself
  // as another, and whichever the chat face later reads would be a coin toss.
  if (parsed.data.name !== name) {
    throw new Error(
      `${named}: its frontmatter says \`name: ${parsed.data.name}\`, and a skill is found ` +
        "under the name it calls itself",
    );
  }
  const body = text.slice(matter[0].length).trim();
  if (!body) throw new Error(`${named} is frontmatter and nothing else — there is no prompt`);

  return { source, bytes: raw.byteLength, body };
}

/** One prompt job, with its words and its destination already resolved. */
export interface ScheduledTurn {
  job: PromptJob;
  prompt: JobPrompt;
  /**
   * The configured channel the tick is addressed to, resolved from `report` once at load.
   *
   * Resolved rather than carried as the declared string because `report.channel` may name
   * a channel rather than identify it, and the turn is queued on the channel's **id** —
   * a tick keyed by a name would run alongside a live turn in the same channel instead of
   * behind it.
   */
  channel: ChannelRef;
}

export interface ScheduledTurnsOptions {
  turns: readonly ScheduledTurn[];
  /** Where a tick's turn actually runs. The gateway, in this process. */
  gateway: Pick<Gateway, "tick">;
  /** The ceiling on a turn, which a job's own `budget.wallClockMs` may lower. */
  turnTimeoutMs: number;
  /**
   * How each job's kill switch is read. Unset is not "no switch" but an unreadable one,
   * which a fail-closed job refuses to tick on — {@link admitJob} holds that line.
   */
  switchSource?: SwitchSource | null;
  /**
   * Where the host's own line goes when a tick has something to say that the turn did not.
   * Unset means nowhere; the run record is still written.
   */
  post?: JobPoster;
  /** Admitted ticks, before the turn. No call for a refused one. */
  onStart?: (run: WorkStart) => void;
  /** Every tick's record, refusals included. */
  onRun?: (run: JobRun) => void;
}

/**
 * The gateway's in-process clock.
 *
 * Ticks that fall while this is not running are **not replayed**. A digest of the last
 * day, posted at 06:00 because that is when the pod came back, is worse than no digest:
 * the next tick's start event is the record that one was missed, and the next post is on
 * time.
 */
export class ScheduledTurns {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  /**
   * Ticks past their timer and not yet settled, which {@link drained} waits out.
   *
   * A tick spends its first moments reading a kill switch, and a shutdown lands inside that
   * await as readily as before it. Without this, `stop()` would clear the timers, the
   * gateway's own `drain()` would see an idle queue, and the tick would then submit a turn
   * into surfaces that were closing — with `process.exit` some milliseconds behind it and
   * no record of the run anywhere.
   */
  private firing = new Set<Promise<void>>();

  constructor(private opts: ScheduledTurnsOptions) {}

  /** The jobs this clock holds, for a caller printing the roster. */
  get turns(): readonly ScheduledTurn[] {
    return this.opts.turns;
  }

  /** Arms every declared schedule from now. */
  start(): void {
    for (const turn of this.opts.turns) this.arm(turn, new Date());
  }

  /**
   * Disarms every schedule, and refuses any tick that has not yet reached the gateway.
   *
   * A **state**, not an event, for the reason {@link JobHost.abandon} is one: a pass that
   * only cleared the timers would miss every tick whose switch was still being read when it
   * ran. {@link drained} is the other half.
   */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Resolves once every tick that was in flight at {@link stop} has settled.
   *
   * Bounded by what a shutdown already waits for: a tick past the gateway is a turn
   * `Gateway.drain` is waiting on anyway, and one that has not reached it refuses in
   * microseconds. So awaiting this alongside the drain costs the grace period nothing, and
   * buys the record — and the status post, through surfaces that are still up.
   */
  async drained(): Promise<void> {
    // In a loop rather than once: a tick settling during the pass can still be adding its
    // status post. It terminates because `stop` has already closed the door.
    while (this.firing.size > 0) await Promise.all([...this.firing]);
  }

  /**
   * When one job fires next, in its declared zone. What `doctor` prints.
   *
   * Throws on an expression this cannot parse. `looksLikeCron` in the manifest checks the
   * shape and leaves the definitive parse to whatever runs the job — for a prompt job that
   * is this — so a caller should ask once before the gateway is live rather than let the
   * first fire discover it.
   */
  next(turn: ScheduledTurn, after = new Date()): Date | undefined {
    try {
      return nextFire(turn.job.trigger.schedules, turn.job.trigger.timezone, after);
    } catch (error) {
      throw new Error(`job "${turn.job.slug}": ${errorText(error)}`);
    }
  }

  private arm(turn: ScheduledTurn, after: Date): void {
    if (this.stopped) return;
    const at = this.next(turn, after);
    if (!at) return;

    const delay = at.getTime() - Date.now();
    // `setTimeout` silently fires at once past its 32-bit range, so a fire more than
    // three weeks out is waited for in hops. The hop re-computes from the same `after`,
    // so nothing drifts.
    const hop = delay > MAX_TIMEOUT_MS;
    const timer = setTimeout(
      () => {
        this.timers.delete(turn.job.slug);
        if (hop) return this.arm(turn, after);
        // Armed from the scheduled instant rather than from now, so a turn that took ten
        // minutes does not move the next fire — and a tick can never re-arm itself onto
        // the one it just ran.
        this.arm(turn, at);
        const firing = this.fire(turn, at).finally(() => this.firing.delete(firing));
        this.firing.add(firing);
      },
      hop ? MAX_TIMEOUT_MS : Math.max(0, delay),
    );
    this.timers.set(turn.job.slug, timer);
  }

  /** One tick: admission, the turn, the record, and then the host's line if it is owed. */
  private async fire(turn: ScheduledTurn, at: Date): Promise<void> {
    const { job, prompt, channel } = turn;
    const runId = randomUUID();
    const base = {
      jobSlug: job.slug,
      runId,
      trigger: "schedule" as const,
      requestedBy: null,
      startedAt: Date.now(),
      parameters: {},
    };
    const didNotRun = { gate: jobGate(job), executed: false, exitCode: null };

    try {
      // The job host's order, because it is the same contract: the switch, then `suspend`,
      // then — inside `Gateway.tick` — the caps that decide whether a turn may start here.
      const admission = await admitJob(job, { trigger: "schedule", requestedBy: null }, this.opts.switchSource);
      if (!admission.admitted) {
        // Recorded and never announced. Refusing to start a parked job is a posture
        // somebody chose, and a channel told about it every evening learns to skim past
        // the evening the announcement is real.
        this.record({
          ...base,
          outcome: admission.outcome ?? "denied-switch",
          switch: admission.switch,
          bypassedSwitch: false,
          gates: [verdictFromGate(didNotRun)],
          checks: [didNotRun],
          reason: admission.reason,
        });
        return;
      }

      // Checked here rather than at the top, because reading the switch is the slowest thing
      // this does and a shutdown lands inside that await as readily as before it. A turn
      // started now would reach surfaces that are closing, and the record of it would be
      // lost at the exit some milliseconds behind. The same call `JobHost.begin` makes at
      // the same moment, in the same words.
      if (this.stopped) {
        this.record({
          ...base,
          outcome: "abandoned",
          switch: admission.switch,
          bypassedSwitch: admission.bypassedSwitch,
          gates: [verdictFromGate(didNotRun)],
          checks: [didNotRun],
          reason:
            `this gateway was asked to stop while ${job.slug} was still being admitted, ` +
            "so the tick was never started",
        });
        return;
      }

      // A turn is already held to `turnTimeoutMs`; a declared budget can only shorten it.
      const deadlineMs = Math.min(this.opts.turnTimeoutMs, job.budget?.wallClockMs ?? Infinity);
      this.observe(() => this.opts.onStart?.({ ...base, admittedAt: Date.now(), deadlineMs }));

      const outcome = await this.opts.gateway.tick(
        tickEvent(job, prompt, channel, runId, at),
        job.report,
        deadlineMs,
      );

      // A tick the gateway would not start is the caps doing their job, and it is told the
      // same way a dropped job tick is: recorded, and silent.
      if (outcome.skipped) {
        this.record({
          ...base,
          outcome: "skipped-overlap",
          switch: admission.switch,
          bypassedSwitch: false,
          gates: [verdictFromGate(didNotRun)],
          checks: [didNotRun],
          reason: `the gateway did not start this tick (${outcome.skipped})`,
          deadlineMs,
        });
        return;
      }

      const check = { gate: jobGate(job), executed: true, exitCode: exitCodeFor(outcome) };
      const run = this.record({
        ...base,
        // A timed-out turn and a brain that threw are one fact here: nobody will learn what
        // this tick found. `budget-bowout` is a process body's word — it names a clock this
        // host stopped a spawned body on — and the reason line below says which happened.
        outcome: outcome.error ? "crashed" : "completed",
        switch: admission.switch,
        bypassedSwitch: false,
        gates: [verdictFromGate(check)],
        checks: [check],
        reason: describeTick(outcome),
        deadlineMs,
      });
      await this.announce(turn, run);
    } catch (error) {
      // Nothing above is allowed to take the process down: this runs on a timer, so a
      // throw here would be an unhandled rejection and the whole of what anyone saw.
      console.warn(`tick_lost job=${job.slug} runId=${runId} reason=${errorLine(error)}`);
    }
  }

  /** Says the tick out loud, when the host has something the turn did not say itself. */
  private async announce(turn: ScheduledTurn, run: JobRun): Promise<void> {
    const report = turn.job.report;
    if (!this.opts.post || !announces(run, false, report.announce)) return;
    try {
      await this.opts.post(report, jobStatus(run, report.proven).headline);
    } catch (error) {
      console.warn(`tick_status job=${run.jobSlug} result=lost reason=${errorLine(error)}`);
    }
  }

  private record(run: Omit<JobRun, "endedAt" | "verdict">): JobRun {
    // Combined even though there is only ever one gate here, because `JobRun.verdict` is
    // documented as exactly `combineVerdicts(gates)` — a record whose sum a reader cannot
    // check is a record they have to take on trust.
    const complete: JobRun = { ...run, endedAt: Date.now(), verdict: combineVerdicts(run.gates) };
    this.observe(() => this.opts.onRun?.(complete));
    return complete;
  }

  /**
   * Both observers, held to the same rule: they cannot change what a tick did.
   *
   * An `onStart` that threw would take the turn *and* the record with it — a work-event
   * stream that failed to write during a shutdown is the realistic way that happens — and
   * "every tick's record, refusals included" would stop being true where it matters most.
   */
  private observe(publish: () => unknown): void {
    try {
      Promise.resolve(publish()).catch(() => {});
    } catch {
      /* An observer cannot change what a tick did. */
    }
  }
}

/**
 * What the turn proved, in the one vocabulary a job record has.
 *
 * `0` — the turn ran to the end. That covers a turn that posted and a turn that chose not
 * to: silence is the message, and a digest with nothing to report is a success.
 * `1` — the brain asked to post and nothing reached the channel. Every ask was refused by
 * the guard, which is a run that tried to speak and failed to.
 * `null` — the turn timed out or threw, so it never got to say what it found.
 */
function exitCodeFor(outcome: TickOutcome): number | null {
  if (outcome.error) return null;
  return outcome.asked > 0 && outcome.sent === 0 ? 1 : 0;
}

function describeTick(outcome: TickOutcome): string {
  if (outcome.error) return `the turn did not finish: ${errorLine(outcome.error)}`;
  if (outcome.asked > 0 && outcome.sent === 0) {
    return `the turn asked to post ${outcome.asked} time(s) and the guard refused every one`;
  }
  return outcome.sent > 0
    ? `the turn posted ${outcome.sent} message(s)`
    : "the turn finished with nothing to say";
}

/**
 * The tick as the gateway sees it: a synthetic inbound event, exactly as the design doc's
 * §10.1 describes one.
 *
 * The author is this process's clock and is deliberately unresolvable to a channel member:
 * `schedule:<slug>` is not an id any surface issues, so nothing can be addressed to it,
 * nothing answers as it, and the author gate has nobody to weigh. `mentionsMe` is true
 * because the clock is the wake, and there is no `threadRoot` because a tick starts a
 * conversation rather than continuing one.
 */
function tickEvent(
  job: PromptJob,
  prompt: JobPrompt,
  channel: ChannelRef,
  runId: string,
  at: Date,
): InboundEvent {
  return {
    id: { surface: channel.surface, nativeId: `schedule:${job.slug}:${runId}` },
    surface: channel.surface,
    channel,
    author: { surface: channel.surface, id: `schedule:${job.slug}`, isSelf: false, isAgent: false },
    text: prompt.body,
    mentionsMe: true,
    ts: at.toISOString(),
    // No adapter produced this, so there is no surface payload to escape into.
    raw: null,
  };
}

/** `setTimeout`'s 32-bit range — about 24.8 days. Longer waits are taken in hops. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The next instant strictly after `after` that one of these expressions names in `timeZone`.
 *
 * Delegated, and the delegation is the point: a cron field grammar plus wall-clock
 * arithmetic across DST is a solved problem with sharp edges, and the hand-rolled version
 * this replaced earned three review findings in one pull request — a leap day read as "never
 * fires", `MONSOON` parsed as Monday, and `0x10` parsed as 16. `croner` refuses all three,
 * has no dependencies of its own, and is the same shape of parser a deploy target runs.
 *
 * The array is the only thing left to do here: a job may declare several schedules, and the
 * next fire is the earliest any of them names. `undefined` means none of them names a day —
 * `30 2 31 2 *` parses and matches nothing — and the ticker arms nothing for it.
 *
 * Throws on an expression it cannot parse, which is `looksLikeCron`'s under-check arriving
 * at its definitive parser: the manifest checks the shape and leaves the grammar to whatever
 * runs the job.
 */
export function nextFire(
  schedules: readonly string[],
  timeZone: string,
  after: Date,
): Date | undefined {
  const fires = schedules
    .map((expression) => new Cron(expression, { timezone: timeZone }).nextRun(after))
    .filter((at): at is Date => at !== null);
  return fires.length ? new Date(Math.min(...fires.map((at) => at.getTime()))) : undefined;
}
