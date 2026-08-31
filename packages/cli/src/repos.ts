import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  errorText,
  isTransient,
  needsHuman,
  passthroughEnv,
  probeEmpty,
  probeNotConfigured,
  probeOk,
  probeUnavailable,
  probeWarming,
  mcpToolServer,
  qualifyTool,
  resolveSecret,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type ProbeResult,
  type ServeOptions,
} from "@sageox/agent-toolkit-core";

const exec = promisify(execFile);

export interface RepoSpec {
  url: string;
  private: boolean;
  name: string;
  dirName: string;
}

/** Which step of the warmup a repository is on. Only ever a `Warming` reading's reason. */
type WarmStep = "pending" | "cloning" | "fetching" | "indexing";

const STEP_REASON: Readonly<Record<WarmStep, string>> = {
  pending: "the code index is queued behind another repository and has not started",
  cloning: "the first clone of this repository is still running",
  fetching: "the checkout is being fast-forwarded",
  indexing: "the code index is being built",
};

export interface RepoState extends RepoSpec {
  path: string;
  /**
   * This repository's capability health, live. Never latched anywhere: a `Warming` reading
   * is true for a few minutes, so a caller that captures one keeps apologizing for a cold
   * index long after it went warm.
   */
  reading: ProbeResult;
}

interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<{ stdout: string; stderr: string }>;

const systemRunner: CommandRunner = async (command, args, options) =>
  exec(command, args, options) as Promise<{ stdout: string; stderr: string }>;

function repoIdentity(
  raw: string,
  source: string,
): Pick<RepoSpec, "url" | "name" | "dirName"> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${source}: repository URL must be HTTPS`);
  }
  if (url.protocol !== "https:") throw new Error(`${source}: repository URL must be HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${source}: repository URL must not contain credentials, query parameters, or a fragment`,
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`${source}: repository URL must include an owner and repository`);
  }
  const rawName = parts.at(-1)!.replace(/\.git$/, "");
  const owner = parts.at(-2)!;
  if (!rawName) throw new Error(`${source}: repository URL has no repository name`);
  // This name enters a trusted runtime-status block. Keep remote-controlled path text out.
  const name = rawName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error(`${source}: repository URL has no safe repository name`);
  const dirName = `${owner}--${name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return { url: raw, name, dirName };
}

/** One HTTPS URL per line; prefix a private repository with `private `. */
export function parseReposConf(text: string): RepoSpec[] {
  const repos: RepoSpec[] = [];
  const urls = new Set<string>();
  const dirs = new Set<string>();

  for (const [offset, original] of text.split("\n").entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;

    const source = `repos.conf:${offset + 1}`;
    const isPrivate = line.startsWith("private ");
    const raw = isPrivate ? line.slice("private ".length).trim() : line;
    const identity = repoIdentity(raw, source);
    if (isPrivate && new URL(identity.url).hostname.toLowerCase() !== "github.com") {
      throw new Error(`${source}: private repositories currently require a github.com HTTPS URL`);
    }
    if (urls.has(identity.url)) {
      throw new Error(`${source}: repository appears twice in repos.conf: ${identity.url}`);
    }
    if (dirs.has(identity.dirName)) {
      throw new Error(
        `${source}: two repositories resolve to the same workspace directory: ${identity.dirName}`,
      );
    }
    urls.add(identity.url);
    dirs.add(identity.dirName);
    repos.push({ ...identity, private: isPrivate });
  }

  return repos;
}

function gitEnvironment(repo: RepoSpec, secretsDir?: string): NodeJS.ProcessEnv {
  const env = {
    ...passthroughEnv(process.env),
    GIT_TERMINAL_PROMPT: "0",
    // A persisted checkout is model-visible. Never let a local hook inherit clone auth.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  if (!repo.private) return env;

  const token = resolveSecret("GITHUB_TOKEN", { dir: secretsDir });
  if (!token) {
    throw new Error(
      `private repository ${repo.url} needs the file-mounted secret GITHUB_TOKEN`,
    );
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    // Environment-backed git config keeps the token out of argv and out of origin.url.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

function oxEnvironment(dataHome: string): NodeJS.ProcessEnv {
  return {
    ...passthroughEnv(process.env),
    CI: "true",
    XDG_DATA_HOME: dataHome,
  };
}

/**
 * What a failed warmup means, as a typed reading rather than a phrase.
 *
 * The two states this picks between are the ones that must never collapse: a missing token
 * sends a human to the configuration, and everything else sends them to the checkout or
 * the backend. Both `reason` and `remedy` are written from values decided here — git and
 * `ox` put their own prose on the error stream, and that stream is remote-controlled, so
 * it never reaches an operator's terminal or a model turn through this function.
 */
function failureReading(capability: string, step: WarmStep, error: unknown): ProbeResult {
  const message = errorText(error);
  if (message.includes("GITHUB_TOKEN")) {
    return probeNotConfigured(
      capability,
      ["GITHUB_TOKEN"],
      "mount GITHUB_TOKEN as a file-mounted secret, or add it to this agent's .env, then restart",
      "this private repository needs a token this deployment does not have",
    );
  }
  if (message.startsWith("origin is ")) {
    return probeUnavailable(
      capability,
      "origin-mismatch",
      "delete this repository's directory under workspace/repos for a fresh clone, or correct " +
        "the URL in repos.conf, then restart",
      "the checkout on disk is a different repository than repos.conf names",
    );
  }
  if (step === "cloning") {
    return probeUnavailable(
      capability,
      "clone-failed",
      "check the URL in repos.conf, this deployment's network reach, and its token, then restart",
      "the first clone of this repository did not complete",
    );
  }
  if (step === "fetching") {
    return probeUnavailable(
      capability,
      "fetch-failed",
      "resolve the checkout under workspace/repos, or delete it for a fresh clone, then restart",
      "the checkout could not be fast-forwarded to its remote",
    );
  }
  return probeUnavailable(
    capability,
    "index-failed",
    "check that `ox` is installed and can write this agent's workspace/ox-data, then restart",
    "the code index for this repository could not be built",
  );
}

export interface RepoWorkspace {
  states: RepoState[];
  /**
   * Starts clone/fetch/index work. Idempotent, and separate from construction so a caller
   * can read the startup verdict — which cannot be gated on any of this — before spending
   * a clone on a launch that is about to be refused.
   */
  warm(): Promise<void>;
  /**
   * One reading per repository, computed on every call.
   *
   * A function rather than a value, deliberately: warmup is transient, and a caller that
   * holds the array holds an answer that stopped being true. The gateway calls this once
   * per turn, which is what lets the disclosure clear itself when the index goes warm.
   */
  readings(): readonly ProbeResult[];
  statusText(): string;
  search(query: string, limit: number): Promise<string>;
}

/** Prepares the workspace directories and the initial readings. Starts nothing — see `warm`. */
export function createRepoWorkspace(
  repos: RepoSpec[],
  options: { root: string; secretsDir?: string; run?: CommandRunner },
): RepoWorkspace {
  if (!repos.length) throw new Error("cannot start an empty repository workspace");
  const run = options.run ?? systemRunner;
  const reposRoot = join(options.root, "repos");
  const dataHome = join(options.root, "ox-data");
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(dataHome, { recursive: true });

  // One timestamp for the whole workspace, because repositories warm sequentially and what
  // a human compares it against is the deploy, not this repository's turn in the queue.
  const since = new Date();
  const capabilityOf = (repo: RepoSpec) => `code:${repo.dirName}`;
  const states: RepoState[] = repos.map((repo) => {
    const path = join(reposRoot, repo.dirName);
    // The brain can start in this directory while git fills it. This is what keeps a cold
    // clone from turning the agent into a black hole.
    mkdirSync(path, { recursive: true });
    return {
      ...repo,
      path,
      reading: probeWarming(capabilityOf(repo), since, STEP_REASON.pending),
    };
  });

  const warmOne = async (state: RepoState): Promise<void> => {
    const capability = capabilityOf(state);
    // Which step is running is the warming reading's whole content, and it is what
    // `failureReading` reads to say where a human should look when the step throws.
    let step: WarmStep = "pending";
    const enter = (next: WarmStep) => {
      step = next;
      state.reading = probeWarming(capability, since, STEP_REASON[next]);
    };
    try {
      const gitEnv = gitEnvironment(state, options.secretsDir);
      if (existsSync(join(state.path, ".git"))) {
        enter("fetching");
        const remote = await run("git", ["remote", "get-url", "origin"], {
          cwd: state.path,
          env: gitEnv,
          timeout: 30_000,
        });
        if (remote.stdout.trim() !== state.url) {
          throw new Error(`origin is ${remote.stdout.trim()}, expected ${state.url}`);
        }
        await run("git", ["pull", "--ff-only"], {
          cwd: state.path,
          env: gitEnv,
          timeout: 5 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } else {
        enter("cloning");
        await run("git", ["clone", state.url, "."], {
          cwd: state.path,
          env: gitEnv,
          timeout: 15 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
        });
      }

      enter("indexing");
      const oxEnv = oxEnvironment(dataHome);
      await run("ox", ["index", "code", "--json"], {
        cwd: state.path,
        env: oxEnv,
        timeout: 30 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const canary = await run("ox", ["code", "status", "--json"], {
        cwd: state.path,
        env: oxEnv,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const status = JSON.parse(canary.stdout) as { index_exists?: boolean };
      // Its own state, and not a failure: the index ran and holds nothing, which a search
      // cannot feel — it answers from an empty store in fluent, plausible prose.
      state.reading =
        status.index_exists === true
          ? probeOk(capability, "the code index for this repository is ready")
          : probeEmpty(
              capability,
              "re-run `ox index code` in this repository's directory under workspace/repos, then restart",
              "the code index for this repository holds nothing, so a search would answer from an empty store",
            );
    } catch (error) {
      state.reading = failureReading(capability, step, error);
    }
  };

  // Indexes share one durable ox data directory. Warm repositories sequentially so two
  // writers never race in that store; the whole sequence still runs behind agent startup.
  let warming: Promise<void> | undefined;
  const warm = (): Promise<void> =>
    (warming ??= (async () => {
      for (const state of states) await warmOne(state);
    })());

  const readings = (): readonly ProbeResult[] => states.map((state) => state.reading);

  const statusText = (): string => {
    const ready = states.filter((state) => state.reading.health === "Ok");
    if (ready.length === states.length) {
      return `Code context ready for ${ready.length} repository(s).`;
    }
    const list = (subset: RepoState[]) =>
      subset.map((state) => `${state.name} (${state.reading.reason})`).join(", ");
    const parts: string[] = [];
    // Two lists rather than one, because the difference between them is whether anybody
    // has to do anything: warmup clears itself, and everything here needs a human.
    const stillWarming = states.filter((state) => isTransient(state.reading.health));
    const degraded = states.filter((state) => needsHuman(state.reading.health));
    if (stillWarming.length) parts.push(`warming: ${list(stillWarming)}`);
    if (degraded.length) parts.push(`unavailable: ${list(degraded)}`);
    if (ready.length) parts.push(`ready: ${ready.length}/${states.length}`);
    return `Code context ${parts.join("; ")}.`;
  };

  const search = async (query: string, limit: number): Promise<string> => {
    const ready = states.filter((state) => state.reading.health === "Ok");
    if (!ready.length) return statusText();
    const results = await Promise.all(
      ready.map(async (state) => {
        try {
          const result = await run(
            "ox",
            ["code", "search", query, "--json", "--limit", String(limit)],
            {
              cwd: state.path,
              env: oxEnvironment(dataHome),
              timeout: 60_000,
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          return `## ${state.name}\n${result.stdout.trim()}`;
        } catch (error) {
          // The same rule the readings hold by type, at query time: `ox` puts its own prose
          // on the error stream and it is searching a remote-controlled checkout, so the
          // text is an injection surface rather than a diagnostic. The detail goes to the
          // operator's log; the model gets a sentence written here.
          console.warn(
            `code_search_failed repo=${state.dirName} ` +
              `error=${error instanceof Error ? error.message : "unknown"}`,
          );
          return `## ${state.name}\nsearch failed: this repository's index could not be searched`;
        }
      }),
    );
    return results.join("\n\n");
  };

  return { states, warm, readings, statusText, search };
}

/** The server the code tools are namespaced under: `mcp__code__code_search`. */
export const CODE_SERVER = "code";

const CODE_TOOL_NAMES = ["code_search", "code_status"] as const;

/**
 * The same tools as the policy must name them. Derived, so `repos add` cannot write one
 * spelling while `doctor` checks another.
 */
export const CODE_POLICY_TOOL_NAMES = CODE_TOOL_NAMES.map((name) =>
  qualifyTool(CODE_SERVER, name),
);

const CODE_TOOLS = [
  {
    name: "code_search",
    description:
      "Search the read-only local code indexes for configured repositories. " +
      "If an index is still warming, call code_status and say that code context is not ready.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find in the code and its history" },
        limit: { type: "number", description: "Results per repository, default 5, maximum 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "code_status",
    description: "Report which configured repository indexes are ready, warming, or unavailable.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/**
 * The code surface's JSON-RPC handler. Exported so the behaviour is testable offline.
 *
 * Built on `mcpToolServer` rather than answering `initialize`/`tools/list`/`tools/call` by
 * hand, which is what it used to do. A hand-rolled skeleton is a third `tools/call` site,
 * and a `tools/call` site the audit does not reach is a tool nobody can prove ran — the
 * whole failure this log exists to close. Every hosted surface goes through the one
 * chokepoint so that stays true of the next one too.
 */
export function codeHandler(workspace: RepoWorkspace): McpHandler {
  return mcpToolServer({
    name: CODE_SERVER,
    tools: () => CODE_TOOLS,
    // Nothing declared: `query` is the caller's own words, the same reason the team brain
    // declares nothing for `team_search`. The audit records that a search ran and how long
    // its query was, never the query.
    call: async (name, args) => {
      if (name === "code_status") return workspace.statusText();
      if (name !== "code_search") throw new Error(`unknown tool ${name}`);

      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("code_search requires a non-empty query");
      const requested = typeof args.limit === "number" ? Math.floor(args.limit) : 5;
      return workspace.search(query, Math.max(1, Math.min(20, requested)));
    },
  });
}

export function serveCodeWorkspace(
  workspace: RepoWorkspace,
  options: ServeOptions = {},
): Promise<HostedMcp> {
  return serveMcp(codeHandler(workspace), options);
}
