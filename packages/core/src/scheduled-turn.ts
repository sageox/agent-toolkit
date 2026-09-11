import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  const source = resolve(agentDir, job.prompt.file);
  const named = `job "${job.slug}" prompt ${source}`;
  let raw: Buffer;
  try {
    raw = readFileSync(source);
  } catch (error) {
    throw new Error(`${named}: ${errorText(error)}`);
  }
  // The same ceiling a verdict artifact has. A prompt is a page; anything approaching this
  // is a document that was pointed at the wrong field.
  if (raw.byteLength > JOB_ARTIFACT_LIMIT_BYTES) {
    throw new Error(
      `${named} is ${raw.byteLength} bytes, over the ${JOB_ARTIFACT_LIMIT_BYTES}-byte limit`,
    );
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
      `${named} has no frontmatter — a prompt file opens with \`---\`, a \`name\` and a ` +
        "`description`, and a closing `---`, then the words the tick sends",
    );
  }
  const parsed = Frontmatter.safeParse(parseYaml(matter[1]!)); // data only — never evaluated
  if (!parsed.success) {
    throw new Error(`${named}: frontmatter needs a \`name\` and a \`description\``);
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

  constructor(private opts: ScheduledTurnsOptions) {}

  /** The jobs this clock holds, for a caller printing the roster. */
  get turns(): readonly ScheduledTurn[] {
    return this.opts.turns;
  }

  /** Arms every declared schedule from now. */
  start(): void {
    for (const turn of this.opts.turns) this.arm(turn, new Date());
  }

  /** Disarms every schedule. A tick already in flight finishes on its own. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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
        void this.fire(turn, at);
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

      // A turn is already held to `turnTimeoutMs`; a declared budget can only shorten it.
      const deadlineMs = Math.min(this.opts.turnTimeoutMs, job.budget?.wallClockMs ?? Infinity);
      this.opts.onStart?.({ ...base, admittedAt: Date.now(), deadlineMs });

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
    try {
      Promise.resolve(this.opts.onRun?.(complete)).catch(() => {});
    } catch {
      /* Observers cannot change what a tick did. */
    }
    return complete;
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

/** How far ahead {@link nextFire} will look before answering "never". */
const SEARCH_DAYS = 366;

/** The fixed descriptors, as the five fields they stand for. `@every` names no clock time. */
const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** One compiled expression: which values each field admits, and whether it was restricted. */
interface Schedule {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** Vixie's rule below needs to know which of the two day fields were written as `*`. */
  anyDay: boolean;
  anyWeekday: boolean;
}

/** A wall-clock instant as one zone renders it. */
interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
  /** `YYYY-MM-DDTHH:MM` in the zone — what tells one side of a fall-back from the other. */
  key: string;
}

/**
 * The next instant strictly after `after` that one of these expressions names in `timeZone`.
 *
 * **A repeated local minute fires once.** The hour an autumn fall-back replays is two real
 * instants with one wall-clock reading, and a daily digest does not want to be posted
 * twice on one evening — so a candidate whose local minute is the one `after` was already
 * at is passed over. Spring forward needs no rule: a local time that does not exist is
 * never produced by formatting a real instant, so a job scheduled inside the gap simply
 * does not run that day, which is what every cron in a zone does.
 *
 * `undefined` means nothing matches inside {@link SEARCH_DAYS} — a `30 2 31 2 *`, which is
 * legal, parses, and names no day.
 */
export function nextFire(
  schedules: readonly string[],
  timeZone: string,
  after: Date,
): Date | undefined {
  const compiled = schedules.map(compileSchedule);
  if (!compiled.length) return undefined;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });

  const alreadyAt = wallClock(after, format).key;
  let at = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = at + SEARCH_DAYS * 24 * 60 * 60_000;
  while (at <= limit) {
    const wall = wallClock(new Date(at), format);
    const onDate = compiled.filter((schedule) => matchesDate(schedule, wall));
    if (wall.key !== alreadyAt && onDate.some((schedule) => matchesTime(schedule, wall))) {
      return new Date(at);
    }
    // Nothing in the rest of this local day can match a date that does not, so step to the
    // next local hour instead of the next minute — local midnight is an hour boundary, so
    // this can never step over the start of a day that does match. It takes the worst case
    // (a yearly expression) from half a million wall-clock formats to about ten thousand.
    at += (onDate.length ? 1 : 60 - wall.minute) * 60_000;
  }
  return undefined;
}

function wallClock(at: Date, format: Intl.DateTimeFormat): WallClock {
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(at)) parts[part.type] = part.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: DAY_NAMES.indexOf(parts.weekday!.slice(0, 3).toLowerCase()),
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

/**
 * Vixie cron's day rule, which Kubernetes' own parser also implements: when **both** day
 * fields are restricted the expression matches if **either** does, and otherwise the one
 * that was written governs. `0 0 1 * 1` is the first of the month *and* every Monday.
 */
function matchesDate(schedule: Schedule, wall: WallClock): boolean {
  if (!schedule.month.has(wall.month)) return false;
  const day = schedule.day.has(wall.day);
  const weekday = schedule.weekday.has(wall.weekday);
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

function matchesTime(schedule: Schedule, wall: WallClock): boolean {
  return schedule.hour.has(wall.hour) && schedule.minute.has(wall.minute);
}

/**
 * Five fields into five sets.
 *
 * Throws on anything it cannot read. `looksLikeCron` in the manifest admits a wider
 * grammar than this deliberately — it checks the shape and leaves the definitive parse to
 * whatever runs the job — so a prompt job's expression is parsed here at load, where the
 * failure is a launch that refuses rather than a schedule that silently never fires.
 */
function compileSchedule(expression: string): Schedule {
  const source = DESCRIPTORS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = source.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`\`${expression}\` is not five cron fields`);
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return {
    minute: fieldValues(expression, minute, 0, 59),
    hour: fieldValues(expression, hour, 0, 23),
    day: fieldValues(expression, day, 1, 31),
    month: fieldValues(expression, month, 1, 12, MONTH_NAMES),
    // 7 and 0 are both Sunday, so the set is folded to 0..6 after the numbers are read.
    weekday: new Set([...fieldValues(expression, weekday, 0, 7, DAY_NAMES)].map((d) => d % 7)),
    anyDay: unrestricted(day),
    anyWeekday: unrestricted(weekday),
  };
}

/** `*` and `?` both mean "this field does not narrow anything". A step does narrow. */
function unrestricted(field: string): boolean {
  return field === "*" || field === "?";
}

function fieldValues(
  expression: string,
  field: string,
  min: number,
  max: number,
  names?: readonly string[],
): Set<number> {
  const values = new Set<number>();
  for (const term of field.split(",")) {
    const [range, stride = "1"] = term.split("/");
    const step = Number(stride);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`\`${expression}\`: \`${term}\` has no usable step`);
    }
    let from: number;
    let to: number;
    if (unrestricted(range ?? "")) {
      [from, to] = [min, max];
    } else {
      const ends = (range ?? "").split("-").map((end) => named(end, names, min, max));
      if (ends.length > 2 || ends.some((end) => end === undefined)) {
        throw new Error(`\`${expression}\`: \`${term}\` is not a value or a range`);
      }
      from = ends[0]!;
      // `5/2` is "from 5, every 2" — a range with no end, which is the field's own end.
      to = ends.length === 2 ? ends[1]! : term.includes("/") ? max : from;
    }
    if (from > to) throw new Error(`\`${expression}\`: \`${term}\` counts backwards`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** One end of a range: a number in the field's own bounds, or a three-letter name. */
function named(
  end: string,
  names: readonly string[] | undefined,
  min: number,
  max: number,
): number | undefined {
  const written = end.trim();
  // `Number("")` is 0, so a blank end would read as a legal value and `1-` would refuse
  // for counting backwards rather than for being half a range.
  if (!written) return undefined;
  const byName = names?.indexOf(written.slice(0, 3).toLowerCase());
  if (byName !== undefined && byName >= 0) return byName + min;
  const value = Number(written);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
