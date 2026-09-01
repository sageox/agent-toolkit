import { z } from "zod";
import type { ActorRef } from "./events.ts";
import type { JobRequester } from "./kill-switch.ts";
import {
  describeJobRun,
  jobDeadlineMs,
  jobParams,
  MAX_PARAM_LENGTH,
  type JobHost,
  type JobParams,
  type JobRun,
  type JobStart,
} from "./job-host.ts";
import type { JobConfig } from "./manifest.ts";
import {
  mcpToolServer,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type ServeOptions,
} from "./mcp-http.ts";
import { ToolRefused } from "./tool-audit.ts";
import type { ToolPolicy } from "./tool-policy.ts";

export const JOB_SERVER = "jobs";
export const JOB_RUN_TOOL_NAME = "job_run";
export const JOB_RUN_TOOL = `mcp__${JOB_SERVER}__${JOB_RUN_TOOL_NAME}`;

/**
 * The one way a conversation starts a job.
 *
 * The fleet has two today and both are a command line the brain hands to a shell. One agent
 * allowlists a no-arg wrapper script and discards whatever arguments arrive, *because* the
 * no-arg shape is the security boundary; two others allowlist `Bash(node …/shift.ts
 * --quick)` — prefix matching on a path, which cannot express "and no other flag", so
 * `--quick --dangerously-skip-permissions` matches the rule that was written to be narrow.
 *
 * Here the brain names a job, and — for a job that declared them — typed values under
 * `params`. The argv is `run.command` and `run.args` from the bundle's own manifest, built
 * by the host, and **no field in this schema reaches it**: a parameter is validated against
 * the manifest's own declaration and handed to the body as `JOB_PARAM_<NAME>` in its
 * environment, never as a word on its command line. That is the same argument the team
 * surface and the GitHub surface each make in their own file, for the third time: **a typed
 * `inputSchema` cannot smuggle a flag.**
 *
 * A job that declares no parameters takes a slug and nothing else, exactly as before — which
 * is the shape that is safe to offer an agent answering anyone, and it is still the default.
 *
 * See [the RFC](../../../docs/design/2026-08-19-jobs-rfc.md) §5, §6.3.
 */

/**
 * Which jobs may be started this way: the ones that said so.
 *
 * `trigger.onRequest` is the arming, and there is deliberately no second field for it. A
 * job that only takes a clock is not offered here — and the refusal is the host's, not this
 * list's, so naming one anyway is denied and recorded rather than quietly ignored.
 */
export function requestableJobs(jobs: readonly JobConfig[]): readonly JobConfig[] {
  return jobs.filter((job) => job.trigger.onRequest);
}

export interface JobToolOptions {
  /** Every declared job, not only the requestable ones — see {@link jobHandler}. */
  jobs: readonly JobConfig[];
  policy: ToolPolicy;
  /** Shared with nothing else in this process, so single-flight per slug actually holds. */
  host: JobHost;
  /**
   * This agent's name, which is the requester when no one turn can be named — see
   * {@link requester}.
   */
  agentName: string;
  /**
   * Who this agent is answering, or `null` when the gateway cannot name one person.
   *
   * An {@link ActorRef} the gateway resolved from an inbound event, never a
   * {@link JobRequester}: a caller that could pass the kind could pass `human`, and the kind
   * is what decides whether a parked job runs. It is derived here from `isAgent`, which only
   * the surface that received the message sets.
   */
  asking?: () => ActorRef | null;
  /**
   * `limits.turnTimeoutMs` — the clock this tool's answer has to fit inside, and the whole
   * of what picks between {@link describeRun} and {@link describeStart}. Both numbers are
   * already declared, so there is no field for an operator to set a third way and no
   * argument for a caller to choose the shape with.
   */
  turnTimeoutMs: number;
}

/**
 * Who the run record says asked: the author of the turn this call is inside.
 *
 * A hosted MCP server is process-level — `tools/call` arrives carrying this server's bearer
 * token and the tool arguments, and nothing at all about the turn that produced it — so the
 * author is not on the call and is read off the gateway instead. That is the same
 * live-turn registry the reaction tool reads to put a glyph on "the message you are
 * answering", and it is the author the manifest already admitted through `owner`,
 * `allowlist`, and `respondTo`.
 *
 * The kind comes from the author's own `isAgent`, set by the surface that received the
 * message. Nothing said inside the turn reaches it, so this is still not the run naming its
 * own provenance: `on-request` remains a trigger rather than an authorization, and a sibling
 * agent asking is automation exactly as a clock tick is.
 *
 * With no turn to name — none live, or two channels mid-turn at once, which names nobody —
 * the requester is this agent's brain. That is what is left that is true, and it is the safe
 * direction: it does not bypass a parked job.
 */
function requester(agentName: string, asking: JobToolOptions["asking"]): JobRequester {
  const author = asking?.() ?? null;
  if (!author) return { kind: "agent", id: agentName };
  return { kind: author.isAgent ? "agent" : "human", id: author.id };
}

const JobArgs = z.object({
  job: z.string({ error: "job is required — name one of the jobs this agent declares" }).min(1),
  /**
   * Unknown here and validated by {@link jobParams} against the named job's own declaration.
   * Typing it as a record of `unknown` rather than of strings is deliberate: a declared
   * integer must arrive as a JSON number, and a schema that pre-coerced would decide that
   * question here instead of where the bound is written down.
   */
  params: z
    .record(z.string(), z.unknown(), {
      error: "params is an object of the values the job you named declares",
    })
    .optional(),
});

/**
 * The declared parameters, as one JSON Schema object for the tool's `params` field.
 *
 * Flat across every offered job rather than per job, because this tool is one tool: which
 * job wants which value is said in the roster, where it can be said truthfully, and enforced
 * at the call against the job that was named.
 *
 * So one name can be two declarations — `deploy` taking `env: [staging, production]` beside
 * `rollback` taking `env: [production]` is one concept narrowed, not a mistake, and refusing
 * that manifest would be refusing good design to protect a schema that is advice. What is
 * not allowed is advertising a bound that is right for one of them and wrong for the other,
 * so a name declared two ways is advertised with no bound at all. The call is unchanged
 * either way: it enforces the named job's own declaration.
 */
function paramSchema(jobs: readonly JobConfig[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const shapes = new Map<string, string>();
  for (const job of jobs) {
    for (const [name, spec] of Object.entries(job.parameters)) {
      // Sorted, so the same declaration written in two key orders is one shape.
      const shape = JSON.stringify(Object.entries(spec).sort());
      const seen = shapes.get(name);
      if (seen === undefined) shapes.set(name, shape);
      properties[name] =
        seen === undefined || seen === shape
          ? jsonSchemaFor(spec)
          : {
              description:
                "more than one of these jobs declares this, and they do not agree — its " +
                "type and bounds are whichever the job you name declared",
            };
    }
  }
  return properties;
}

function jsonSchemaFor(spec: JobConfig["parameters"][string]): Record<string, unknown> {
  return spec.type === "integer"
    ? {
        type: "integer",
        description: spec.description,
        ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
        ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {}),
      }
    : {
        type: "string",
        description: spec.description,
        // A closed list is JSON Schema's `enum`, and it says everything a length or a
        // pattern would: a caller reading it sees the values themselves.
        ...(spec.values
          ? { enum: spec.values }
          : { pattern: spec.pattern, maxLength: MAX_PARAM_LENGTH }),
      };
}

/** What a job takes, for the roster line the brain reads. Empty for a job that takes none. */
function describeParams(job: JobConfig): string {
  const declared = Object.entries(job.parameters).map(
    ([name, spec]) => `${name} (${spec.type}${spec.required ? ", required" : ""})`,
  );
  return declared.length ? ` [params: ${declared.join(", ")}]` : "";
}

function tools(jobs: readonly JobConfig[], turnTimeoutMs: number): unknown[] {
  const requestable = requestableJobs(jobs);
  const params = paramSchema(requestable);
  return [
    {
      name: JOB_RUN_TOOL_NAME,
      description:
        "Run one of this agent's declared jobs now. You choose which job; the job's own " +
        "declaration decides what runs, for how long, and with what arguments. A job short " +
        "enough to finish inside one turn is waited for, and this tool answers with the " +
        "verdict it minted — report that verdict exactly as it is returned, because a job " +
        "that proved nothing did not pass. A job whose budget is longer than a turn is " +
        "started rather than waited for, and the answer says only that it is running and " +
        "where its result will be posted: there is no verdict in it, so say it is running " +
        "and report the result when it lands. A parked job runs when the person you are " +
        "answering is the one who asked, because they are waiting on the result; it refuses " +
        "when another agent is asking, and nothing in this call lets you claim otherwise. " +
        "A job listed below with params takes a target — which issue, which document, " +
        "which environment — under `params`. No parameter changes what a job does: if the ask " +
        "is for different behaviour, it is a different job and a different slug.\n" +
        `Jobs this agent will run on request: ${
          requestable.length
            ? requestable
                .map(
                  (job) =>
                    `${job.slug} (${job.archetype}) — ${job.description}` +
                    describeParams(job) +
                    (jobDeadlineMs(job) > turnTimeoutMs ? " [started, not waited for]" : ""),
                )
                .join("; ")
            : "none"
        }`,
      inputSchema: {
        type: "object",
        properties: {
          job: {
            type: "string",
            enum: requestable.map((job) => job.slug),
            description: "Which declared job to run, by slug",
          },
          // Omitted entirely when no offered job declares one, so the tool an agent without
          // parameterised jobs sees is byte-for-byte the tool it saw before they existed.
          ...(Object.keys(params).length
            ? {
                params: {
                  type: "object",
                  properties: params,
                  additionalProperties: false,
                  description:
                    "Values for the job you named, and only the ones it declares — see the " +
                    "roster above for which job takes which. A value the job does not " +
                    "declare, or one outside its bounds, is refused.",
                },
              }
            : {}),
        },
        required: ["job"],
      },
    },
  ];
}

/**
 * The job tool's JSON-RPC handler. Exported so the refusals are testable offline.
 *
 * The policy is re-checked here rather than left to the brain's own permission layer, for
 * the reason every hosted surface re-checks it: the brain holds this server's bearer token
 * and can reach the listener directly.
 *
 * A job the agent declares but never armed for requests is passed to the host anyway,
 * rather than filtered out here. `tools/list` is advice and the host is the boundary — it
 * refuses an unarmed door with `denied-trigger` *and writes a run record*, which is the
 * difference between an attempt somebody can find at 3am and one that never happened.
 */
export function jobHandler(opts: JobToolOptions): McpHandler {
  const { jobs, policy, host, agentName, asking, turnTimeoutMs } = opts;
  return mcpToolServer({
    name: JOB_SERVER,
    tools: () => tools(jobs, turnTimeoutMs),
    // The slug, which is what correlates this line with the run record the host writes. A
    // parameter's value is not declared here and would not be honoured if it were —
    // `auditArgs` writes a shape for a nested object rather than its contents. The record
    // carries the validated values instead, which is the durable place to look anyway.
    audit: { [JOB_RUN_TOOL_NAME]: ["job"] },
    call: async (tool, args) => {
      if (tool !== JOB_RUN_TOOL_NAME) throw new Error(`unknown tool ${tool}`);
      const allowed = policy.allowsTool(JOB_RUN_TOOL);
      if (!allowed.ok) throw new ToolRefused(`${JOB_RUN_TOOL_NAME} refused: ${allowed.reason}`);

      const asked = JobArgs.parse(args);
      const job = jobs.find((candidate) => candidate.slug === asked.job);
      if (!job) {
        const offered = requestableJobs(jobs).map((candidate) => candidate.slug);
        throw new Error(
          `no job "${asked.job}" is declared — this agent runs on request: ` +
            `${offered.join(", ") || "no job at all"}`,
        );
      }

      // Checked before anything starts, because this is the one moment the brain can do
      // something about it: it is mid-turn, it can read what was wrong, and it can go back
      // to whoever named a target. The host checks again — see {@link jobParams} — and by
      // then the only thing left to do with a bad value is write a run record about it.
      const params: JobParams = jobParams(job, asked.params ?? {});

      // Two shapes, and the job's own declaration against the turn's own clock is what
      // picks between them — not a field in this call, and not a field in the manifest that
      // could disagree with either number. A job that fits inside a turn is waited for and
      // quoted; one that cannot is started, and answers where it declared it would.
      if (jobDeadlineMs(job) > turnTimeoutMs) {
        const start = await host.startRequest(job, requester(agentName, asking), params);
        return start.refused ? describeRun(start.refused) : describeStart(job, start);
      }
      return describeRun(await host.request(job, requester(agentName, asking), params));
    },
  });
}

/** A finished run, plus the one thing about a refusal the brain can do something with. */
function describeRun(run: JobRun): string {
  const parked = run.outcome === "denied-switch" || run.outcome === "denied-suspend";
  return (
    describeJobRun(run) +
    // Named here rather than left to the reason line, because the brain is about to
    // explain the refusal to whoever asked, and which side of the bypass this run fell on
    // is the part of it they can act on.
    (parked
      ? "  this run counted as automation rather than a person's request, so it did not " +
        "bypass a parked job\n"
      : "")
  );
}

/**
 * A run that has begun, in words that cannot be read as a run that has ended.
 *
 * This is `describeVerdict`'s rule one level up. No gate has run, so there is nothing to
 * report about one, and the sentence must not contain a word a skimming reader could take
 * for an outcome — not even in a denial, because "it did not pass" and "it passed" are one
 * missed word apart. So the shape deliberately does not rhyme with a run headline's
 * `job <slug> completed in <n>ms`: what is said instead is that it is running, which one it
 * is, and where the answer will appear.
 *
 * A job with no `report` has nowhere to answer, and that is said plainly rather than left
 * for the person in the channel to discover by waiting. `doctor` flags the same job before
 * a deploy; this is the honest thing to say when one is running anyway.
 */
function describeStart(job: JobConfig, start: JobStart): string {
  const lands = job.report
    ? `the result will post to ${job.report.channel} on the ${job.report.surface} surface ` +
      "when the run lands"
    : "this job declares no `report`, so its result will reach no channel at all — it will " +
      "only be in the run record, where an operator has to go and look for it";
  return (
    `job ${job.slug} is running now — run id ${start.runId}; nothing has finished yet, so ` +
    "there is no verdict to read.\n" +
    `  its budget allows ${jobDeadlineMs(job)}ms, longer than this turn, so this tool ` +
    "started it instead of waiting for it\n" +
    `  ${lands}\n` +
    "  tell whoever asked that it is running and that you will report back; you have not " +
    "read a result and must not describe one\n"
  );
}

/**
 * The job surface, hosted by the gateway.
 *
 * Not a subprocess and not a shell: the job bodies are spawned by this process, from the
 * manifest, and the brain receives a URL, a capability token, and a list of slugs.
 */
export function serveJobs(opts: JobToolOptions, serve: ServeOptions = {}): Promise<HostedMcp> {
  return serveMcp(jobHandler(opts), serve);
}
