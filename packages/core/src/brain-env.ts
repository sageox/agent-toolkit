import type { AgentManifest } from "./manifest.ts";

/**
 * Variables a child process needs to run at all. Everything outside this list is dropped,
 * because the gateway's own environment is the credential zone.
 *
 * `PATH` is not optional in the way the rest are: without it `spawn` cannot resolve a
 * command name and the child dies with ENOENT before it runs a line.
 */
const PASSTHROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const;

export type AcpProvider = Exclude<AgentManifest["brain"]["provider"], "mock">;

/**
 * The subset of `base` a spawned child is allowed to inherit: the list above, plus any
 * name the bundle declared for that particular child.
 *
 * `declared` carries the values that are required but unknowable when the bundle is written.
 * A pod's cloud identity is the case that forces it: EKS IRSA injects `AWS_ROLE_ARN` and
 * `AWS_WEB_IDENTITY_TOKEN_FILE` at admission, and GKE and Azure workload identity present
 * the same way, so a manifest can write down the name and never the value. Naming it keeps
 * the grant reviewable — the alternative is not a shorter manifest, it is `process.env`.
 */
export function passthroughEnv(
  base: NodeJS.ProcessEnv,
  declared: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...PASSTHROUGH, ...declared]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return env;
}

/**
 * Builds the environment for the brain subprocess.
 *
 * This is the v1 isolation mechanism: the brain zone holds only its spend-capped
 * model API key, so a prompt-injected turn has no surface or write credential to
 * reach for. It is an **allowlist** — a denylist would leak every credential nobody
 * thought to name.
 *
 * Isolation here is process-level, not container-hard: the subprocess still shares the
 * gateway's filesystem, so a mounted secret file remains readable at the OS level. The
 * separate-container tier is what makes the guarantee literal.
 */
export function brainEnv(
  base: NodeJS.ProcessEnv,
  opts: { provider?: AcpProvider; apiKey?: string; model?: string; turnTimeoutMs?: number } = {},
): NodeJS.ProcessEnv {
  const env = passthroughEnv(base);
  const keyName = opts.provider === "codex-acp" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = opts.apiKey ?? base[keyName];
  if (apiKey) env[keyName] = apiKey;
  if (opts.provider === "codex-acp") {
    env.NO_BROWSER = "1";
    env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "api-key" });
    env.INITIAL_AGENT_MODE = "read-only";
    env.CODEX_CONFIG = JSON.stringify({
      ...(opts.model ? { model: opts.model } : {}),
      features: { shell_tool: false, hooks: false, apps: false, multi_agent: false },
      web_search: "disabled",
    });
    return env;
  }
  // Set only from the manifest, never from `base`: an ambient ANTHROPIC_MODEL on the
  // gateway host would repin every agent it runs, invisibly to anyone reading the
  // bundle. Unpinned means the brain's own default, not the host's opinion.
  if (opts.model) env.ANTHROPIC_MODEL = opts.model;
  // Otherwise the brain's own default ends a tool call inside a turn the gateway still
  // considers live — and `job_run` waits for a job on the strength of that turn's number.
  if (opts.turnTimeoutMs) env.MCP_TOOL_TIMEOUT = String(opts.turnTimeoutMs);
  return env;
}
