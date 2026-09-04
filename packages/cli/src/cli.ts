#!/usr/bin/env tsx
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Gateway,
  MockBrain,
  ClaudeAcpBrain,
  describeStartup,
  describeUnmet,
  errorLine,
  errorText,
  evaluateStartup,
  isActionable,
  precondition,
  loadManifest,
  loadToolPolicy,
  runBrainServer,
  serveVaultBrain,
  Vault,
  makeOxTeam,
  serveTeamBrain,
  type HostedMcp,
  type TeamBrain,
  resolveSecret,
  type AgentManifest,
  type Brain,
  type ToolPolicy,
  McpBroker,
  resolveMcpServer,
  stdioTransport,
  serveBrokerServer,
  SurfaceEgress,
  serveSurfaceEgress,
  serveSurfaceRead,
  SURFACE_EGRESS_SERVER,
  SURFACE_EGRESS_TOOL,
  SURFACE_EGRESS_TOOL_NAMES,
  SURFACE_READ_SERVER,
  SURFACE_READ_TOOL_NAMES,
  SURFACE_REACT_TOOL,
  qualifyTool,
  JobHost,
  jobDeadlineMs,
  describeJobRun,
  serveJobs,
  requestableJobs,
  JOB_SERVER,
  JOB_RUN_TOOL,
  JOB_RUN_TOOL_NAME,
  type JobConfig,
  type JobParams,
  type JobPoster,
  type JobMembers,
  type JobReader,
  type JobRun,
  type SwitchSource,
  type McpServerDecl,
  type InboundEvent,
} from "@sageox/agent-toolkit-core";
import { ConsoleAdapter } from "@sageox/agent-toolkit-adapter-console";
import {
  EngramStore,
  engramSwitchSource,
  normalizeEngramPrefix,
  probeRelay,
  publishDirectory,
  readDirectory,
  type AgentDirectory,
  resolveBuzzSigner,
  servePrivateBrain,
  toHexPubkey,
} from "@sageox/agent-toolkit-adapter-buzz";
import { buildAdapters, buzzSurface, buzzTarget, type BuzzTarget } from "./surfaces.ts";
import { normalizeActorId } from "./identity.ts";
import {
  createCmd,
  initCmd,
  identityCmd,
  surfaceCmd,
  brainCmd,
  MODEL_ID,
  memoryCmd,
  retryGuidedStep,
  loadCreateProgress,
  saveCreateProgress,
} from "./commands.ts";
import {
  ANTHROPIC_KEY_SPEC,
  GITHUB_TOKEN_SPEC,
  SAGEOX_TOKEN_SPEC,
  declaredSecrets,
  spawnedSecretSpec,
  requireCredential,
  requireDeclaredSecrets,
  readEnvValue,
} from "./credentials.ts";
import { SETTINGS_JSON } from "./init.ts";
import {
  addMcpServer,
  addBrain,
  DuplicateBrainError,
  allowToolsInFile,
  ensureSettingsFile,
} from "./edit-config.ts";
import { flag, optionValue, positional } from "./args.ts";
import { wireBrains, toolNamesFor, DEFAULT_OX_TOKEN_SECRET } from "./brains.ts";
import { oxStatus, expiringSoon, oxTeams, type OxTeam } from "./ox.ts";
import { formatProbe } from "./probe.ts";
import {
  allowlistDrift,
  directoryFor,
  agentPubkeys,
  isRelayMembershipError,
  listChannels,
  sameRelay,
  type BuzzSurfaceChannels,
} from "./register.ts";
import { isInteractive, promptLine, promptMultiSelect, promptSelect } from "./prompt.ts";
import { loadState, saveState } from "./state.ts";
import {
  CODE_POLICY_TOOL_NAMES,
  CODE_SERVER,
  createRepoWorkspace,
  parseReposConf,
  serveCodeWorkspace,
  type RepoSpec,
  type RepoWorkspace,
} from "./repos.ts";
import { agentPaths, agentsHome, bundlePaths, listAgents, selectAgentName } from "./home.ts";

/** Options that take a value anywhere in the CLI, so their value is never read as a name. */
const VALUED_OPTIONS = new Set([
  "--agent",
  "--bundle",
  "--secrets",
  "--job-secrets",
  "--name",
  "--trigger",
]);

type SelectedAgent = ReturnType<typeof agentPaths> & { name: string };

/** The agent a command applies to: explicitly named, uniquely implied, or interactively picked. */
async function agentFrom(argv: string[]): Promise<SelectedAgent> {
  const bundle = flag(argv, "bundle");
  if (bundle) {
    const paths = bundlePaths(bundle);
    return { name: readManifest(paths.config).name, ...paths };
  }
  const name = await selectAgentName(flag(argv, "agent") ?? positional(argv, VALUED_OPTIONS));
  return { name, ...agentPaths(name) };
}

/**
 * Selects an agent from `--agent` or the shared picker. Commands such as `memory add
 * local` and `mcp add surface-egress` use their positionals for what is being added, not names.
 */
async function agentFromFlag(argv: string[]): Promise<SelectedAgent> {
  const bundle = flag(argv, "bundle");
  if (bundle) {
    const paths = bundlePaths(bundle);
    return { name: readManifest(paths.config).name, ...paths };
  }
  const name = await selectAgentName(flag(argv, "agent"));
  return { name, ...agentPaths(name) };
}

function readRepos(path: string): RepoSpec[] {
  return existsSync(path) ? parseReposConf(readFileSync(path, "utf8")) : [];
}

/**
 * `--secrets`, made absolute.
 *
 * Every command that takes this flag also chdirs into the agent's home, so a relative
 * value read afterwards names a directory under that home rather than the one the operator
 * typed. Call this *before* the chdir. Absolute values are unaffected, which is every
 * deployment: Compose and the chart both pass `/mnt/secrets-store`.
 */
function secretsDirFrom(argv: string[]): string | undefined {
  const named = flag(argv, "secrets");
  return named ? resolve(named) : undefined;
}

/**
 * `--job-secrets`, made absolute, and the directories a job body's `run.secrets` are
 * resolved from — that directory first, then the agent's own.
 *
 * Only `job run` takes it, and only a deployment that mounts a second source passes it. It
 * is what lets a credential a job needs be absent from the agent's own mount, and so absent
 * from the container that runs the brain, which no tool policy can arrange. Everything else
 * this process resolves — the surface signer, the kill switch, the age identity — keeps
 * reading the agent's directory alone, so splitting a job's credential out never costs a job
 * its status post or its switch.
 *
 * A run started on request is served from the gateway, which passes no such directory, so a
 * prompt-injected turn cannot reach a job-only credential through a job it is allowed to
 * ask for. `run.jobSecrets` beside `trigger.onRequest` is refused at load for that reason.
 */
function jobSecretDirs(argv: string[], secretsDir?: string): string | string[] | undefined {
  const named = flag(argv, "job-secrets");
  if (!named) return secretsDir;
  return secretsDir ? [resolve(named), secretsDir] : [resolve(named)];
}

/** Loads the agent's own `.env`. Each agent is self-contained, credentials included. */
function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
    } catch {
      /* a malformed .env should not stop a run that has real env vars */
    }
  }
}

/** Whether a command the config depends on is actually installed. */
function hasOnPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

function readManifest(path: string): AgentManifest {
  if (!existsSync(path)) {
    throw new Error(`no config at ${resolve(path)} — run \`sageox-agent init --name <name>\` first`);
  }
  const manifest = loadManifest(readFileSync(path, "utf8"));

  // Author ids come from whichever surface the person reached the agent on, so each is
  // normalized in its own namespace rather than all of them as Nostr keys.
  if (manifest.owner) manifest.owner = manifest.owner.map(normalizeActorId);
  if (manifest.allowlist) manifest.allowlist = manifest.allowlist.map(normalizeActorId);
  return manifest;
}

/**
 * Builds the brain and everything it may reach.
 *
 * Returns a closer because the gateway now *hosts* some brains rather than letting the
 * agent spawn them — those hold listening sockets that must come down with the process.
 */
async function buildBrain(
  manifest: AgentManifest,
  agentDir: string,
  secretsDir?: string,
  egress?: SurfaceEgress,
  codeWorkspace?: RepoWorkspace,
  policy?: ToolPolicy,
): Promise<{
  brain: Brain;
  closeHosted: () => Promise<void>;
  postMessage: boolean;
  react: boolean;
  /** Present only when the job tool is served — see the shutdown path in `runCmd`. */
  jobs?: JobHost;
  /**
   * Present only when a team brain is configured. `runCmd` probes it once and hands its
   * readings to the gateway, which is the only capability source here other than the code
   * workspace.
   */
  team?: TeamBrain;
}> {
  const nothingToClose = async () => {};
  if (manifest.brain.provider === "mock") {
    return { brain: new MockBrain(), closeHosted: nothingToClose, postMessage: false, react: false };
  }

  // Every server hosted below listens on the same address.
  const serveAt = { host: process.env.BRAIN_MCP_HOST };

  // Re-invoking this CLI needs the loader flags it was started with: under tsx the
  // script is a .ts file that plain node cannot run.
  const self = { command: process.execPath, args: [...process.execArgv, process.argv[1]] };
  const wiring = wireBrains(manifest.brains, { agentDir, self });
  for (const preset of wiring.unsupported) {
    process.stdout.write(`  note: the "${preset}" brain is configured but not implemented yet\n`);
  }

  const mcpServers: unknown[] = [...wiring.servers];
  const hosted: HostedMcp[] = [];
  const addHosted = (name: string, server: HostedMcp, label: string) => {
    hosted.push(server);
    // The agent gets a URL and a capability token; the credentialed work runs here in
    // the gateway, so no token or signer crosses into the brain.
    mcpServers.push({
      type: "http",
      name,
      url: server.url,
      headers: [{ name: "Authorization", value: `Bearer ${server.token}` }],
    });
    process.stdout.write(`  ${label} served at ${server.url}\n`);
  };
  const allowsPostMessage = policy?.allowsTool(SURFACE_EGRESS_TOOL).ok === true;
  const postMessage = egress?.canPost() === true && allowsPostMessage;
  const allowsReact = policy?.allowsTool(SURFACE_REACT_TOOL).ok === true;
  const react = egress?.canReact() === true && allowsReact;

  // Allowed but unservable is the confusing case for both: without this the tool is
  // simply absent with nothing said, and the operator reads that as a policy they got
  // wrong rather than a surface that cannot carry it.
  if (allowsPostMessage && !postMessage) {
    process.stdout.write(
      `  note: ${SURFACE_EGRESS_TOOL} is allowed, but no surface names a channel to post\n` +
        "        into — list them under that surface's channels\n",
    );
  }
  if (allowsReact && !react) {
    process.stdout.write(
      `  note: ${SURFACE_REACT_TOOL} is allowed, but no configured surface carries reactions\n`,
    );
  }

  if (postMessage || react) {
    const server = await serveSurfaceEgress(egress!, policy!, { postMessage, react }, serveAt);
    const label = [postMessage && "post", react && "reaction"].filter(Boolean).join(" and ");
    addHosted(SURFACE_EGRESS_SERVER, server, `${label} tool`);
  }

  // Allowed *and* carried by some surface, which is the same pair the two tools above are
  // decided by. The server offers only the allowed reads, so one allowlisted read is enough
  // to want it — and none means the brain is offered nothing, not an empty server.
  const reads = SURFACE_READ_TOOL_NAMES.filter(
    (tool) => policy?.allowsTool(qualifyTool(SURFACE_READ_SERVER, tool)).ok === true,
  );
  if (reads.length && egress?.canRead()) {
    const server = await serveSurfaceRead(egress, policy!, serveAt);
    addHosted(SURFACE_READ_SERVER, server, `surface read tools (${reads.join(", ")})`);
  } else if (reads.length) {
    process.stdout.write(
      "  note: surface read tools are allowed, but no configured surface answers a read\n",
    );
  }

  // User-declared MCP servers. The broker holds their credentials, enforces the tool
  // policy, and pins schemas; this only gives the brain a way to reach it.
  if (manifest.mcpServers.length && !policy) {
    // Refusing beats denying silently: with no policy every call would be rejected and the
    // agent would look broken rather than misconfigured.
    throw new Error(
      "tools are configured but no tool policy is set — add `tools: ./settings.json` " +
        "to agent.yaml, or run `sageox-agent mcp add` which writes both",
    );
  }

  const broker = manifest.mcpServers.length
    ? new McpBroker({
        servers: manifest.mcpServers.map(resolveMcpServer),
        policy: policy!,
        transport: stdioTransport,
        secretOpts: { dir: secretsDir },
        // The same patterns the chat chokepoint runs. A tool argument is the other way out
        // of this agent — a pull request body, an issue title, a search query — and it was
        // the one the rule did not reach.
        leakPatterns: manifest.guard.leakPatterns,
        onSchemaChange: (tool: string, server: string) =>
          process.stdout.write(
            `  warning: ${server}'s "${tool}" changed shape since it was approved — held back\n`,
          ),
      })
    : undefined;

  for (const decl of manifest.mcpServers) {
    const { name, scope } = resolveMcpServer(decl);
    const server = await serveBrokerServer(broker!, name, serveAt);
    const bound = Object.entries(scope)
      .map(([arg, values]) => `${arg} ∈ ${values.join(", ")}`)
      .join("; ");
    addHosted(name, server, `mcp server "${name}"${bound ? ` (bound to ${bound})` : ""}`);
  }

  // The chat door onto this agent's own jobs. The brain names a slug; the argv comes from
  // the manifest, so there is no flag for a channel message to reach.
  // Declared-but-denied is `doctor`'s finding, exactly as it is for the brains, the MCP
  // servers, and the code tools — a misconfiguration reported at boot is one an operator
  // meets after deploying, and one said in two places is one that gets maintained in neither.
  const requestable = requestableJobs(manifest.jobs);
  let jobs: JobHost | undefined;
  if (requestable.length && policy?.allowsTool(JOB_RUN_TOOL).ok === true) {
    // One host for this process, so single-flight per slug holds across every request — and
    // handed back to the caller, because a detached run outlives the turn that started it
    // and something has to settle it when this process is told to stop.
    jobs = new JobHost({
      switchSource: await jobSwitchSource(manifest, secretsDir),
      secretOpts: { dir: secretsDir },
      // A job started from chat announces itself exactly as a scheduled one does. The
      // gateway already holds the adapters and the guarded path through them, so this
      // needs none of the connecting `job run` has to do for itself — and without it a
      // job would report to `#hive` on a clock and go quiet the moment someone asked.
      post: egress && jobPoster(egress),
      read: egress && jobReader(egress),
      members: egress && jobMembers(egress),
    });
    const server = await serveJobs(
      {
        jobs: manifest.jobs,
        policy: policy!,
        // A job whose deadline outlasts a turn is started rather than waited for, and says
        // what it found in its report channel. The tool reads both numbers off what is
        // already declared, so there is nothing here for an operator to set a third way.
        turnTimeoutMs: manifest.limits.turnTimeoutMs,
        host: jobs,
        agentName: manifest.name,
        // Who the run record says asked. A `tools/call` carries nothing about the turn that
        // produced it, and the gateway is what knows — the same live turn the reaction tool
        // marks. Without it every request is automation, including the ones a person is
        // waiting on, and a parked job could only be run by arming the switch and
        // remembering to disarm it.
        answering: egress && (() => egress.answeringEvent()),
        // How the verdict of a run that outlasts the turn reaches the message that asked.
        reply: egress && jobAnswerer(egress),
        // Who that author has to be for the run to count as a person's. `owner` and not
        // `respondTo`: an allowlist says who may speak to this agent, and a fleet's names
        // siblings.
        owner: manifest.owner ?? [],
      },
      serveAt,
    );
    addHosted(JOB_SERVER, server, `job tool (${requestable.map((l) => l.slug).join(", ")})`);
  }

  let teamBrain: TeamBrain | undefined;
  for (const cfg of wiring.hosted) {
    let server: HostedMcp;
    if (cfg.preset === "vault") {
      const identity = resolveSecret(cfg.age.identitySecret, { dir: secretsDir });
      server = await serveVaultBrain(
        new Vault(cfg.root, { recipient: cfg.age.recipient, identity }),
        serveAt,
      );
    } else if (cfg.preset === "private") {
      const buzz = buzzSurface(manifest);
      if (!buzz) {
        throw new Error(
          "the private brain needs one valid Buzz surface with relayUrl and identity",
        );
      }
      server = await servePrivateBrain(
        {
          relayUrl: buzz.relayUrl,
          owner: cfg.owner,
          signer: await resolveBuzzSigner(buzz.identity, { dir: secretsDir }),
          writeScope: cfg.writeScope,
          // The write side of §6.3 rule 4. The switch lives in this brain, so this brain is
          // where "anyone may park a job, only a human may arm one" stops being steering.
          killSwitches: jobSwitches(manifest).map((s) => s.key),
        },
        serveAt,
      );
    } else {
      // Held, not just served: this is the one brain that measures its own health, and
      // `runCmd` puts those readings in the gateway's capability closure.
      teamBrain = makeOxTeam({
        team: cfg.team,
        repo: cfg.repo,
        configHome: cfg.configHome,
        // Resolved here, in the gateway, and per lookup rather than once: file-first, so a
        // mounted secret beats an env var, and a mount rewritten under this process is what
        // the next `ox` child carries.
        token: () => resolveSecret(cfg.token, { dir: secretsDir }),
      });
      server = await serveTeamBrain(teamBrain, serveAt);
    }
    addHosted(cfg.name, server, `${cfg.preset === "vault" ? cfg.brainPreset : cfg.preset} brain`);
  }

  if (codeWorkspace) {
    const server = await serveCodeWorkspace(codeWorkspace, serveAt);
    addHosted(CODE_SERVER, server, "code search");
  }

  // ACP applies the same tool policy to these memory servers as to every other tool the
  // brain can reach; hosted servers additionally keep their credential on this side.
  return {
    brain: new ClaudeAcpBrain({
      toolPolicy: policy,
      // Never the repository checkout: an agent whose working directory is cloned code
      // picks that repository's own agent instructions up as trusted context. Code
      // reaches the brain through the allowlisted `code` tools, which is the whole point.
      cwd: agentDir,
      mcpServers,
      // Handed over explicitly: the brain's own env is an allowlist, and a mounted key
      // is never in it.
      apiKey: resolveSecret("ANTHROPIC_API_KEY", { dir: secretsDir }),
      model: manifest.brain.model,
    }),
    closeHosted: async () => {
      for (const h of hosted) await h.close().catch(() => {});
    },
    postMessage,
    react,
    jobs,
    team: teamBrain,
  };
}

/** Add an indexed checkout and the exact read-only tools that can query it. */
async function reposCmd(argv: string[]): Promise<void> {
  // Before the agent is selected: picking one is now a question, and asking it for a
  // command that cannot succeed spends an answer on nothing.
  const sub = argv[0];
  if (sub !== "list" && (sub !== "add" || !argv[1] || argv[1].startsWith("--"))) {
    throw new Error("usage: sageox-agent repos add <https-url> [--private] | repos list");
  }
  const agent = await agentFromFlag(argv);
  const existing = existsSync(agent.repos) ? readFileSync(agent.repos, "utf8") : "";
  if (sub === "list") {
    const repos = parseReposConf(existing);
    if (!repos.length) process.stdout.write("  no repositories configured\n");
    for (const repo of repos) {
      process.stdout.write(`  ${repo.private ? "private " : "public  "}${repo.url}\n`);
    }
    return;
  }
  if (!existsSync(agent.config)) {
    throw new Error("no agent.yaml — run `sageox-agent init --name <name>` first");
  }

  const line = `${argv.includes("--private") ? "private " : ""}${argv[1]}`;
  const current = parseReposConf(existing);
  const configured = current.find((repo) => repo.url === argv[1]);
  const requestedPrivate = argv.includes("--private");
  if (configured && configured.private !== requestedPrivate) {
    throw new Error(
      `${argv[1]} is already configured as ${configured.private ? "private" : "public"}; ` +
        "edit repos.conf to change its access mode",
    );
  }
  const already = configured !== undefined;
  const next = already
    ? existing
    : `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${line}\n`;
  parseReposConf(next); // validate the complete file before writing any of it

  readManifest(agent.config); // validate before touching anything
  const ensured = ensureSettingsFile(agent.dir, readFileSync(agent.config, "utf8"));
  if (ensured.changed) writeFileSync(agent.config, ensured.yaml);
  const added = allowToolsInFile(ensured.settingsFile, CODE_POLICY_TOOL_NAMES);
  writeFileSync(agent.repos, next);
  process.stdout.write(`  ${already ? "kept" : "added"} ${argv[1]} in ${agent.repos}\n`);
  for (const name of added) process.stdout.write(`  allowed ${name}\n`);
  process.stdout.write(`\nverify:  sageox-agent doctor --agent ${agent.name}\n`);
}

/**
 * Adds an MCP server to an agent, end to end.
 *
 * The whole point is that nothing here gets typed by hand. Tool names must be namespaced
 * `mcp__<server>__<tool>`; a bare name matches nothing and produces a policy that looks
 * correct and enforces nothing. The CLI knows each built-in's compiled tool list and can
 * ask an external server for its live list, so it writes those strings itself.
 */
const BUILTIN_MCP_SERVERS: Record<string, readonly string[]> = {
  [SURFACE_EGRESS_SERVER]: SURFACE_EGRESS_TOOL_NAMES,
  [SURFACE_READ_SERVER]: SURFACE_READ_TOOL_NAMES,
  [JOB_SERVER]: [JOB_RUN_TOOL_NAME],
};

/** Options `mcp add` takes a value for, so none of those values is read as the server name. */
const MCP_VALUED_OPTIONS = new Set([
  ...VALUED_OPTIONS,
  "--command",
  "--args",
  "--secret-refs",
  "--scope",
]);

/**
 * `--scope repo=owner/name,owner/other` → `{repo: ["owner/name", "owner/other"]}`.
 *
 * One bound argument, because one is what a real server needs — a repository, a team, a
 * database. A second is spelled by hand in `agent.yaml`, which is a fair trade against a
 * flag syntax nobody can remember.
 */
function parseScope(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf("=");
  if (at < 1) throw new Error(`--scope takes <argument>=<value>[,<value>] — got "${raw}"`);
  const name = raw.slice(0, at);
  const values = splitCommaFlag(raw.slice(at + 1));
  if (!values.length) throw new Error(`--scope ${name}= needs at least one permitted value`);
  return { [name]: values };
}

async function mcpAddCmd(argv: string[]): Promise<void> {
  // Before the agent is selected and before the chdir: selecting one is now a question,
  // and a command with nothing to add should not move the process into an agent's home.
  const named = positional(
    argv.filter((a) => a !== "add"),
    MCP_VALUED_OPTIONS,
  );
  const custom = flag(argv, "command");
  const known = Object.keys(BUILTIN_MCP_SERVERS).join(", ");
  if (!named && !custom) {
    throw new Error(
      `name a built-in server (${known}) or describe one: ` +
        `mcp add --name x --command npx --args "-y,pkg" [--secret-refs ENV=REF] ` +
        `[--scope repo=owner/name]`,
    );
  }

  const agent = await agentFromFlag(argv);
  loadDotEnv(agent.env);
  const secretsDir = secretsDirFrom(argv);
  process.chdir(agent.dir);

  const builtInTools = named ? BUILTIN_MCP_SERVERS[named] : undefined;
  if (!custom && builtInTools) {
    // The gateway serves the job tool only for jobs that armed the door, so a policy
    // written before any job does is a permission for a tool that will never exist —
    // silent, and the shape `repos add` refuses too.
    if (named === JOB_SERVER) {
      const { jobs } = readManifest(agent.config);
      if (!requestableJobs(jobs).length) {
        throw new Error(
          (jobs.length
            ? `no job in ${agent.name} declares trigger.onRequest`
            : `${agent.name} declares no jobs`) +
            `, so ${JOB_RUN_TOOL} would never be served — arm a job with ` +
            "`trigger: {onRequest: true}` in agent.yaml first",
        );
      }
    }
    const ensured = ensureSettingsFile(agent.dir, readFileSync(agent.config, "utf8"));
    if (ensured.changed) writeFileSync(agent.config, ensured.yaml);

    process.stdout.write(`adding built-in mcp server "${named}" to agent "${agent.name}"\n`);
    await offerToolPolicy(named!, [...builtInTools], ensured.settingsFile, ensured.toolsPath);
    process.stdout.write(`\nverify:  sageox-agent doctor --agent ${agent.name}\n`);
    return;
  }

  if (!custom) throw new Error(`unknown server "${named}" — have: ${known}`);

  const decl: McpServerDecl = {
    name: flag(argv, "name") ?? "custom",
    command: custom,
    args: (flag(argv, "args") ?? "").split(",").filter(Boolean),
    secrets: parsePairs(flag(argv, "secret-refs")),
    scope: parseScope(flag(argv, "scope")),
  };

  const resolved = resolveMcpServer(decl);
  process.stdout.write(`adding mcp server "${resolved.name}" to agent "${agent.name}"\n`);
  // Said before the credential prompt, because an unbounded server is the thing a human
  // still has time to reconsider while they are here — after this, nothing asks again.
  const bound = Object.entries(resolved.scope);
  process.stdout.write(
    bound.length
      ? `  bound to ${bound.map(([arg, values]) => `${arg} ∈ ${values.join(", ")}`).join("; ")}\n`
      : "  unbounded — every tool reaches everything this server's credential reaches. " +
          "Add --scope <argument>=<value> if that is wider than the job.\n",
  );

  // 1. Credentials first: a server started without them fails in confusing ways later.
  for (const [envVar, ref] of Object.entries(resolved.secrets)) {
    await requireCredential(spawnedSecretSpec(ref, envVar, "the server"), {
      envPath: agent.env,
      secretsDir,
    });
  }
  // A prompt above may just have added a value to the bundle's local .env. Reload before
  // starting the server for discovery; deployment systems bind the same logical refs later.
  loadDotEnv(agent.env);

  // 2. Ask the server what it offers, so the policy is written from fact rather than guesswork.
  const tools = await listServerTools(resolved, secretsDir);
  // 3. Config last, so a failure above leaves the agent untouched.
  const ensured = ensureSettingsFile(agent.dir, readFileSync(agent.config, "utf8"));
  writeFileSync(agent.config, addMcpServer(ensured.yaml, decl));
  process.stdout.write(`\n  added to ${agent.config}\n`);

  // Said before the policy question, because a bound the tools cannot carry makes every
  // allowed one unusable — and this is the moment a human can still fix the argument name.
  const unreachable = toolsOutsideScope(tools, resolved.scope);
  if (unreachable.length) {
    process.stdout.write(
      `\n  warning: ${unreachable.length} of ${tools.length} tool(s) do not take ` +
        `${Object.keys(resolved.scope).join(", ")} — every call to ` +
        `${unreachable.map((u) => u.tool).join(", ")} would be refused\n`,
    );
  }

  await offerToolPolicy(
    resolved.name,
    tools.map((tool) => tool.name),
    ensured.settingsFile,
    ensured.toolsPath,
  );

  process.stdout.write(`\nverify:  sageox-agent doctor --agent ${agent.name}\n`);
}

/** One permission flow for gateway-built-ins and user-added MCP servers alike. */
async function offerToolPolicy(
  server: string,
  tools: string[],
  settingsFile: string,
  toolsPath: string,
): Promise<void> {
  if (!tools.length) {
    process.stdout.write("  the server reported no tools — nothing to allow\n");
    return;
  }

  process.stdout.write(`\n  ${server} offers ${tools.length} tool(s):\n`);
  for (const tool of tools) process.stdout.write(`    mcp__${server}__${tool}\n`);

  const answer = isInteractive()
    ? (await promptLine(`  Allow all ${tools.length} tool(s) for this agent? [y/N]: `)).trim()
    : "n";
  if (/^y(es)?$/i.test(answer)) {
    const added = allowToolsInFile(settingsFile, tools.map((tool) => `mcp__${server}__${tool}`));
    process.stdout.write(`  allowed ${added.length} tool(s) in ${toolsPath}\n`);
    return;
  }

  process.stdout.write(
    `  allowed nothing. Add the lines above to "permissions.allow" in ${toolsPath} ` +
      "when you have decided which the agent should have.\n",
  );
}

/** Where someone with no SageOx account is sent to make one. */
const SAGEOX_REGISTER_URL = "https://sageox.ai/register";

/** Injected so the branch a person without an account takes can be tested without a terminal. */
interface TeamPickIO {
  teams?: () => Promise<OxTeam[]>;
  ask?: (question: string) => Promise<string>;
  say?: (line: string) => void;
}

/**
 * Asking for an account from the team picker, where a bare `n` cannot mean it: the empty
 * branch below asks a `[y/N]` question, and one key meaning "no" there and "new account"
 * here is the kind of collision that only shows up as a wrong answer nobody reported.
 */
const WANTS_ACCOUNT = /^(new|create|register)$/i;

/**
 * Offers the teams this machine knows about, rather than asking for an id to be typed.
 *
 * The listing only works where `ox` has local state, which is the workstation — and that
 * is exactly where this command runs. A container cannot enumerate teams from a token
 * alone, so the id chosen here is what it will use.
 *
 * **Registering is offered from both branches, not only the empty one.** It began in the
 * empty branch, on the reasoning that anyone whose teams list has an account already. That
 * reasoning holds for the person and not for the prompt: an empty listing also means ox is
 * absent or unsynced, so tying the only route to a new account to that state hides it from
 * everyone whose tooling works, and makes the offer impossible to demonstrate without
 * breaking something first. Here it costs one clause in a line already being printed.
 */
export async function chooseTeam(io: TeamPickIO = {}): Promise<string> {
  const list = io.teams ?? oxTeams;
  const ask = io.ask ?? promptLine;
  const say = io.say ?? ((line: string) => process.stdout.write(line));

  /** Sends someone off to register, then asks for what they come back with. */
  const registerThenAsk = async (): Promise<string> => {
    say(
      `\n  Register at ${SAGEOX_REGISTER_URL}, and create your team there.\n` +
        "  Come back with its id and a personal access token — the two things this needs.\n\n",
    );
    await ask("  Press Enter once the team exists: ");
    return (await ask("SageOx team id (team_…): ")).trim();
  };

  const teams = await list();
  if (!teams.length) {
    // Nothing synced locally, or no ox at all — and the second case includes someone who
    // has never signed up. Telling them to find an id in an app they cannot open is a dead
    // end, and this stage is the only one that asks for a team.
    say("  no teams found on this machine.\n");
    const wants = (await ask("Create a SageOx account now? [y/N]: ")).trim();
    if (/^(y|yes)$/i.test(wants)) return registerThenAsk();
    say("  find the id in the SageOx app (sageox.ai), or run `ox login` and try again.\n");
    return (await ask("SageOx team id (team_…): ")).trim();
  }

  teams.forEach((t, i) =>
    say(`  ${i + 1}. ${t.name}  (${t.id})${t.named ? "" : "  — no name in the listing"}\n`),
  );
  const answer = (
    await ask(`Which team? [1-${teams.length}, paste an id, or "new" for a new SageOx account]: `)
  ).trim();

  if (WANTS_ACCOUNT.test(answer)) return registerThenAsk();

  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= teams.length) return teams[index - 1].id;
  return answer;
}

/**
 * Makes sure the team brain will actually be able to search — now, not at first use.
 *
 * Asked for even where `ox login` already authenticates the workstation, because that login
 * is not part of the bundle: `auth.json` stays in the user's config directory, and a
 * container built from this agent has no ambient login to fall back on. Skipping the
 * question there produced a bundle that searched fine locally and failed every `team_search`
 * once deployed — `ox_failed class=not-authenticated` mid-turn, with the answer still sent.
 * This is the last point where supplying the token is a paste rather than a redeploy.
 *
 * The answer is optional in that case and only there: local runs do work on the login
 * alone, so refusing to continue without a token would block a console agent over a
 * capability it already has. `doctor` reports the gap until it is filled either way.
 */
async function ensureOxCredential(
  agent: SelectedAgent,
  tokenRef: string,
  // Passed in rather than read from argv: this runs after the caller has chdir'd, which is
  // too late to make a relative `--secrets` mean what it said.
  secretsDir: string | undefined,
): Promise<void> {
  const existing = resolveSecret(tokenRef, { dir: secretsDir });
  if (existing) {
    process.stdout.write(`  ${tokenRef} already set\n`);
    return;
  }

  const status = await oxStatus();
  if (!status.installed) {
    process.stdout.write(
      "\n  the `ox` CLI is not installed — the team brain cannot search without it:\n" +
        "    curl -sSL https://raw.githubusercontent.com/sageox/ox/main/scripts/install.sh | bash\n" +
        `  then \`ox login\`, or add ${tokenRef} to this bundle's local .env.\n` +
        "  The brain is configured either way; `doctor` will keep reporting this until it works.\n",
    );
    return;
  }

  if (status.authenticated) {
    process.stdout.write(
      `\n  ox is already authenticated as ${status.user ?? "you"}, which covers runs on this machine.\n` +
        `  A deployment needs its own ${tokenRef}: that login lives in your config directory,\n` +
        "  not in the bundle, so nothing carries it into a container.\n",
    );
    await requireCredential(
      {
        ...SAGEOX_TOKEN_SPEC,
        name: tokenRef,
        label: `${SAGEOX_TOKEN_SPEC.label}, or Enter to skip and add ${tokenRef} later`,
        optional: true,
      },
      { envPath: agent.env, secretsDir },
    );
    return;
  }

  await requireCredential({ ...SAGEOX_TOKEN_SPEC, name: tokenRef }, { envPath: agent.env, secretsDir });
}

/** `A=B,C=D` → `{A: "B", C: "D"}`. */
function parsePairs(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Starts a server just long enough to ask for its tool list.
 *
 * Runs through the broker so the credential is resolved exactly the way it will be at
 * runtime — if the secret is wrong, it fails here, with a human present, rather than at
 * the agent's first attempt to use it.
 */
/** One tool as its server describes it. The schema is what `scope` is checked against. */
interface ServerTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

/**
 * Which of a server's tools could never satisfy its bound.
 *
 * `scope` is fail-closed, so a tool that does not take the bound argument is refused on
 * every call. That is the safe direction and a silent one: the agent simply cannot use the
 * tool, and the reason is a manifest line nobody re-reads. The schemas come back from
 * `tools/list` for free, so the answer is available at `doctor` time rather than at 3am.
 *
 * A tool publishing no `inputSchema` properties is not reported — an absent schema is
 * unknown, not empty, and guessing would turn a quiet server into a fake finding.
 */
export function toolsOutsideScope(
  tools: ServerTool[],
  scope: Record<string, string[]>,
): Array<{ tool: string; missing: string[] }> {
  const bound = Object.keys(scope);
  if (!bound.length) return [];
  return tools
    .map((tool) => {
      const properties = tool.inputSchema?.properties;
      if (!properties || typeof properties !== "object") return { tool: tool.name, missing: [] };
      return { tool: tool.name, missing: bound.filter((arg) => !(arg in properties)) };
    })
    .filter((entry) => entry.missing.length > 0);
}

async function listServerTools(
  server: ReturnType<typeof resolveMcpServer>,
  secretsDir: string | undefined,
): Promise<ServerTool[]> {
  const broker = new McpBroker({
    servers: [server],
    policy: loadToolPolicy(SETTINGS_JSON),
    transport: stdioTransport,
    secretOpts: { dir: secretsDir },
  });
  try {
    const id = await broker.connect(server.name);
    await broker.message(id, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-toolkit", version: "1" },
    });
    const listed = (await broker.message(id, "tools/list", {})) as { tools?: ServerTool[] };
    return listed.tools ?? [];
  } catch (error) {
    process.stdout.write(
      `  could not list tools: ${errorText(error)}\n` +
        "  (the server is still added — run `sageox-agent doctor` once it starts)\n",
    );
    return [];
  } finally {
    await broker.stop().catch(() => {});
  }
}


/**
 * Adds a memory brain and the policy entries that make it usable.
 *
 * Adding the brain alone is a trap: its tools arrive namespaced `mcp__<server>__<tool>`,
 * so a hand-written policy silently matches nothing and the agent gets memory it cannot
 * read. The names come from the same function the wiring uses, so they cannot drift.
 */
export async function memoryAddCmd(argv: string[]): Promise<void> {
  const preset = argv.find((a) => !a.startsWith("--"));
  if (preset !== "local" && preset !== "private" && preset !== "shared" && preset !== "team") {
    throw new Error(
      "usage: sageox-agent memory add local | private --owner <org-pubkey> [--write-scope <prefix,...>] | shared --with <agents> [--path <dir>] | team [--team <id>] [--age-recipient <age1...>] [--age-identity <secretRef>]",
    );
  }

  const agent = await agentFromFlag(argv);
  loadDotEnv(agent.env);
  if (!existsSync(agent.config)) throw new Error("no such agent — run `sageox-agent init` first");

  const secretsDir = secretsDirFrom(argv);
  process.chdir(agent.dir);

  const ageRecipient = flag(argv, "age-recipient");
  const ageIdentity = flag(argv, "age-identity");
  if ((ageRecipient || ageIdentity) && preset !== "local" && preset !== "shared") {
    throw new Error("age encryption applies only to local or shared markdown memory");
  }
  if (ageIdentity && !ageRecipient) {
    throw new Error("--age-identity requires --age-recipient <age1...>");
  }
  const age = ageRecipient
    ? { recipient: ageRecipient, identitySecret: ageIdentity ?? "AGE_IDENTITY" }
    : undefined;

  let entry: Record<string, unknown>;
  if (preset === "local") {
    entry = { preset: "local", ...(age ? { age } : {}) };
  } else if (preset === "private") {
    let owner = flag(argv, "owner");
    if (!owner && isInteractive()) {
      process.stdout.write(
        "Private memory is encrypted for an organization owner identity. This is an " +
          "addressing namespace, not the respond-to owner.\n",
      );
      owner = await promptLine("Organization owner public key (npub or 64-char hex): ");
    }
    if (!owner) {
      throw new Error(
        "private memory needs its organization owner: --owner <npub-or-hex> (do not use a personal identity)",
      );
    }
    // Bounds writes and deletes without touching reads, for an agent that is trusted to
    // edit one corner of its memory rather than all of it.
    //
    // An absent flag and a flag naming nothing are opposite intentions that parse the
    // same way: `--write-scope ""`, `--write-scope " "`, and `--write-scope ,` all filter
    // down to no prefixes, and omitting the key from the entry is how an UNRESTRICTED
    // brain is written. An operator who asked for a bound would silently get none — the
    // exact widening this option exists to prevent. Refused instead, which is also the
    // rule the manifest already applies to `writeScope: []`.
    const wants = "at least one key prefix, e.g. core,mem/skills/";
    const scopeFlag = optionValue(argv, "write-scope", wants);
    const writeScope = splitCommaFlag(scopeFlag);
    if (scopeFlag !== undefined && !writeScope.length) throw new Error(`--write-scope needs ${wants}`);
    entry = {
      preset: "private",
      owner: toHexPubkey(owner),
      ...(writeScope.length ? { writeScope } : {}),
    };
  } else if (preset === "shared") {
    const explicitScope = splitCommaFlag(flag(argv, "scope"));
    const peers = splitCommaFlag(flag(argv, "with"));
    const scope = [...new Set(explicitScope.length ? explicitScope : [agent.name, ...peers])].sort();
    if (scope.length < 2) {
      throw new Error(
        "a shared brain needs at least one other agent: --with ida[,jo], or --scope harry,ida",
      );
    }
    if (!scope.includes(agent.name)) {
      throw new Error(`shared scope must include this agent (${agent.name})`);
    }
    entry = {
      preset: "shared",
      path: flag(argv, "path") ?? defaultSharedPath(scope),
      scope,
      ...(age ? { age } : {}),
    };
  } else {
    let team = flag(argv, "team");
    if (!team && isInteractive()) {
      process.stdout.write("The team brain searches your team's recorded knowledge.\n");
      team = await chooseTeam();
    }
    if (!team) throw new Error("a team brain needs a team id: --team team_xxxxxxxx");
    entry = { preset: "team", team };
  }

  const ensured = ensureSettingsFile(agent.dir, readFileSync(agent.config, "utf8"));
  let yaml = ensured.yaml;

  // Re-running `memory add` for a brain that is already there repairs the policy instead
  // of failing. The tools a brain contributes grow between releases, and an agent whose
  // settings.json predates the growth would otherwise fail `doctor` for a tool no command
  // could allow.
  let fresh = true;
  try {
    yaml = addBrain(yaml, entry);
  } catch (error) {
    if (!(error instanceof DuplicateBrainError)) throw error;
    fresh = false;
  }

  // Calculate names from the complete manifest. Shared servers include their list index;
  // computing from the new entry alone would allow brain-shared-0 even when wiring names
  // it brain-shared-1 after an existing local brain. This also validates before anything
  // is written: a manifest the schema rejects, once on disk, is one no later command can
  // load — including this one.
  const brains = loadManifest(yaml).brains;
  const names = toolNamesFor(brains);

  // The default lives beside agent directories, not inside either participant's home.
  // Both agents therefore resolve the same sorted scope to the same vault. An explicit
  // path supports a shared volume when the participants run on different hosts.
  if (fresh && preset === "shared") {
    mkdirSync(resolve(agent.dir, entry.path as string), { recursive: true });
  }
  writeFileSync(agent.config, yaml);
  const added = allowToolsInFile(ensured.settingsFile, names);

  process.stdout.write(
    fresh
      ? `  added the ${preset} brain to ${agent.config}\n`
      : `  the ${preset} brain is already in ${agent.config} — re-checked its tool policy\n`,
  );
  for (const allowed of added) process.stdout.write(`  allowed ${allowed}\n`);
  if (!fresh && !added.length) process.stdout.write("  the tool policy was already complete\n");
  // Re-running repairs the policy; it never edits an entry that is already there, so say
  // so when the arguments asked for something the existing entry does not say.
  const ignoredOnRerun =
    flag(argv, "path") ||
    flag(argv, "team") ||
    flag(argv, "owner") ||
    // Named here too: a re-run that appears to tighten the write scope and silently does
    // not is the exact failure this scope exists to prevent.
    flag(argv, "write-scope") ||
    ageRecipient ||
    ageIdentity;
  if (!fresh && ignoredOnRerun) {
    process.stdout.write("  the existing entry was kept — change it in agent.yaml by hand\n");
  }

  if (preset === "team") {
    // The entry that is already on disk may name its own secretRef, and asking for the
    // default would stage a credential nothing reads.
    const team = brains.find((brain) => brain.preset === "team");
    const tokenRef = (team?.preset === "team" ? team.token : undefined) ?? DEFAULT_OX_TOKEN_SECRET;
    await ensureOxCredential(agent, tokenRef, secretsDir);
  }
  process.stdout.write(`\nverify:  sageox-agent doctor --agent ${agent.name}\n`);
}

function splitCommaFlag(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A deterministic, traversal-safe home for agents in the same toolkit installation. */
function defaultSharedPath(scope: string[]): string {
  const members = [...scope].sort();
  const label = members
    .map((member) => member.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "agent"))
    .join("--")
    .slice(0, 80);
  const digest = createHash("sha256").update(JSON.stringify(members)).digest("hex").slice(0, 10);
  return `../shared/${label}-${digest}`;
}

/** A single-choice picker shared by the optional stages of guided creation. */
async function setupChoice(title: string, options: string[]): Promise<number> {
  return promptSelect(
    title,
    options.map((label, value) => ({ value, label })),
    0,
  );
}

const MEMORY_RETRY: Record<"local" | "shared" | "team" | "private", string> = {
  local: "Try adding local memory again?",
  shared: "Try adding shared memory again?",
  team: "Try adding team memory again?",
  private: "Try adding Buzz-private memory again?",
};

/**
 * Everything after identity/surfaces and before run: memory, tools, code, then doctor.
 *
 * A blank answer skips the stage it was asked for rather than ending the journey. Each
 * completed section advances the transient creation checkpoint, so a cancelled or killed
 * command returns to this section instead of replaying identity and surface setup.
 */
async function finishCreateJourney(
  name: string,
): Promise<string | { checkCommand: string }> {
  const agent = { name, ...agentPaths(name) };
  // Without a checkpoint there is nothing to skip, which is this phase's original behaviour:
  // start at the first section. `create` writes one, so the guided path always has it.
  const progress = loadCreateProgress(name) ?? { version: 1 as const, stage: "memory" as const };

  if (progress.stage === "memory") {
    const manifest = readManifest(agent.config);
    const hasBuzz = manifest.surfaces.some((surface) => surface.kind === "buzz");
    if (!progress.memories) {
      progress.memories = await promptMultiSelect("Select any memory sources:", [
        { value: "local" as const, label: "Local", hint: "private markdown files owned by this agent" },
        { value: "shared" as const, label: "Shared", hint: "a markdown vault shared with named agents" },
        { value: "team" as const, label: "Team via SageOx", hint: "read-only team knowledge" },
        ...(hasBuzz
          ? [{ value: "private" as const, label: "Buzz-private", hint: "encrypted on its Buzz relay" }]
          : []),
      ]);
      saveCreateProgress(name, progress);
    }

    // A source that was added, skipped, or given up on is done being asked about. Recording
    // that here is what stops a resumed journey from offering the whole list again.
    const completed = new Set(progress.completedMemories ?? []);
    for (const memory of progress.memories) {
      if (completed.has(memory)) continue;
      if (memory === "shared") {
        await retryGuidedStep(MEMORY_RETRY.shared, async () => {
          const peers = await promptLine("Other agent names (comma-separated): ");
          if (peers) await memoryAddCmd(["shared", "--with", peers, "--agent", name]);
          else process.stdout.write("  skipped shared memory — it needs at least one other agent name\n");
        });
      } else {
        await retryGuidedStep(
          MEMORY_RETRY[memory],
          () => memoryAddCmd([memory, "--agent", name]),
        );
      }
      completed.add(memory);
      progress.completedMemories = [...completed];
      saveCreateProgress(name, progress);
    }
    progress.stage = "mcp";
    saveCreateProgress(name, progress);
  }

  if (progress.stage === "mcp") {
    // This section is a loop with no list to checkpoint, so re-entering it after an
    // interruption re-offers servers that are already installed. The manifest is the record
    // of what the section did — read it back rather than tracking a second copy. Before the
    // prompts, not after: `mcp add` does refuse a duplicate name, but only once it has asked
    // for that server's token.
    const installed = () =>
      new Set(readManifest(agent.config).mcpServers.map((server) => resolveMcpServer(server).name));
    for (;;) {
      const tool = await setupChoice("Add an MCP tool server?", [
        "Done adding tools",
        "MCP server     asks for its command, its secrets, and what it may be pointed at",
      ]);
      if (tool === 0) break;

      await retryGuidedStep("Try adding this MCP server again?", async () => {
        const serverName = await promptLine("Server name: ");
        const command = await promptLine("Command (for example npx): ");
        if (!serverName || !command) {
          process.stdout.write("  an MCP server needs a name and a command — nothing added\n");
          return;
        }
        if (installed().has(serverName)) {
          process.stdout.write(`  ${serverName} is already configured — nothing added\n`);
          return;
        }
        const args = await promptLine("Arguments (comma-separated, blank for none): ");
        const secrets = await promptLine(
          "Secret mappings (SERVER_ENV=SECRET_NAME, comma-separated; blank for none): ",
        );
        // Asked rather than defaulted: a credential is almost never as narrow as the job,
        // and there is no value the toolkit could pick on the operator's behalf. Blank is a
        // real answer — some servers are already as narrow as their token.
        process.stdout.write(
          "  A bound argument narrows every call: name it and the values allowed under it,\n" +
            "  for example repo=acme/service. A call without it is refused.\n",
        );
        const scope = await promptLine("Bound argument (name=value[,value]; blank for none): ");
        await mcpAddCmd([
          "add",
          "--name", serverName,
          "--command", command,
          ...(args ? ["--args", args] : []),
          ...(secrets ? ["--secret-refs", secrets] : []),
          ...(scope.trim() ? ["--scope", scope.trim()] : []),
          "--agent", name,
        ]);
      });
    }
    progress.stage = "repos";
    saveCreateProgress(name, progress);
  }

  if (progress.stage === "repos") {
    // The mock brain cannot call the code tools, so asking for repositories there would
    // knowingly create a configuration that the preflight below rejects.
    if (readManifest(agent.config).brain.provider === "claude-acp") {
      for (;;) {
        const repository = await setupChoice("Add repository context?", [
          "Done adding repositories",
          "Public GitHub repository",
          "Private GitHub repository  asks for a read-only token",
        ]);
        if (repository === 0) break;
        await retryGuidedStep("Try adding this repository again?", async () => {
          const url = await promptLine("Repository HTTPS URL: ");
          if (!url) {
            process.stdout.write("  a repository needs an HTTPS URL — nothing added\n");
            return;
          }
          await reposCmd(["add", url, ...(repository === 2 ? ["--private"] : []), "--agent", name]);
          if (repository === 2) {
            await requireCredential(GITHUB_TOKEN_SPEC, { envPath: agent.env });
          }
        });
      }
    }
    progress.stage = "preflight";
    saveCreateProgress(name, progress);
  }

  for (;;) {
    process.stdout.write("\nRunning local preflight checks before the first run…\n");
    if (await doctorCmd(["--agent", name])) break;
    const next = await promptSelect("Preflight found problems. What next?", [
      { value: 1, label: "Run preflight again" },
      { value: 0, label: "Finish setup and fix them later" },
    ], 0);
    if (next === 0) return { checkCommand: `sageox-agent doctor --agent ${name}` };
  }
  return `sageox-agent run --agent ${name}`;
}

/** Read-only: connects, authenticates, and reports what the relay actually serves. */
async function probeCmd(argv: string[]): Promise<void> {
  // A probe can run before an agent exists. If one is selected (or there is exactly one),
  // use that agent's identity so an auth-required relay can be checked accurately.
  const explicit = flag(argv, "agent");
  const secretsDir = secretsDirFrom(argv); // before the chdir below, which may not happen
  const agents = listAgents();
  if (explicit || agents.length === 1 || (agents.length > 1 && isInteractive())) {
    const agent = agentPaths(await selectAgentName(explicit));
    loadDotEnv(agent.env);
    if (existsSync(agent.dir)) process.chdir(agent.dir); // a named agent may not exist yet
  } else {
    loadDotEnv();
  }
  let relayUrl = flag(argv, "relay");
  if (!relayUrl && isInteractive()) relayUrl = await promptLine("Relay URL (wss://…): ");
  if (!relayUrl) throw new Error("a relay URL is required: --relay wss://your-relay.example");

  const identityRef = readEnvValue("BUZZ_NSEC") ? "BUZZ_NSEC" : undefined;
  if (!identityRef) {
    process.stdout.write(
      "  no identity yet — probing anonymously; a relay requiring NIP-42 may serve nothing\n",
    );
  }

  process.stdout.write(`  connecting to ${relayUrl} …\n`);
  const report = await probeRelay({
    relayUrl,
    identityRef,
    secretsDir,
    seconds: Number(flag(argv, "seconds", "5")),
  });
  process.stdout.write(formatProbe(report, relayUrl));
}

async function runCmd(argv: string[]): Promise<void> {
  const agent = await agentFrom(argv);
  loadDotEnv(agent.env);
  const secretsDir = secretsDirFrom(argv); // before the chdir below
  const statePath = agent.state;

  const manifest = readManifest(agent.config);
  process.chdir(agent.dir);

  // Resolve the spend credential before starting any background network work. A failed
  // unattended launch should not leave a clone running after the process reports failure.
  if (manifest.brain.provider === "claude-acp") {
    await requireCredential(ANTHROPIC_KEY_SPEC, { secretsDir });
  }

  const repos = readRepos(agent.repos);
  // Every declared secretRef, before a socket opens or a clone starts. Otherwise each one
  // fails where it is first used — and the ones on background paths become a status line
  // rather than a failed launch.
  const declared = declaredSecrets(manifest, repos);
  for (const secret of requireDeclaredSecrets(declared, { dir: secretsDir })) {
    process.stdout.write(
      `  note: ${secret.where}: ${secret.name} does not resolve — ${secret.degraded}\n`,
    );
  }

  const policy = manifest.brain.provider === "claude-acp" && manifest.tools
    ? loadToolPolicy(readFileSync(resolve(agent.dir, manifest.tools), "utf8"))
    : undefined;
  const codeWorkspace =
    repos.length && manifest.brain.provider === "claude-acp"
      ? createRepoWorkspace(repos, { root: join(agent.dir, "workspace"), secretsDir })
      : undefined;

  // The startup verdict, and the only thing in this process allowed to refuse a launch.
  //
  // An unpoliced tool surface makes the agent WRONG — it reaches further than anyone
  // approved — so it is a precondition. A cold code index makes it less informed for a few
  // minutes, so it is a capability, and the readings below are passed for the log line and
  // for nothing else. `evaluateStartup` cannot consult them for the phase, which is the
  // point: gating a launch on warmup is what turns a rollout into seven minutes of silence.
  const startup = evaluateStartup({
    preconditions: [
      precondition(
        "tools.policy",
        !codeWorkspace || !!policy,
        codeWorkspace
          ? "repos.conf is configured, so this agent's code tools would reach unpoliced"
          : "no code tools are configured, so there is no tool surface to police",
        "add `tools: ./settings.json` to agent.yaml, or run `sageox-agent repos add`, which writes both",
      ),
    ],
    capabilities: codeWorkspace?.readings(),
  });
  if (startup.phase === "Failed") throw new Error(describeUnmet(startup));
  process.stdout.write(`  ${describeStartup(startup)}\n`);

  if (codeWorkspace) {
    process.stdout.write(`  ${codeWorkspace.statusText()}\n`);
    // Started only now: a refused launch must not leave a clone running behind a process
    // that has already reported failure.
    void codeWorkspace.warm().then(() => {
      process.stdout.write(`  ${codeWorkspace.statusText()}\n`);
      // Announced to a person only for what a person can do something about. Warmup that
      // finished needs no announcement, and warmup that failed already changed state.
      for (const r of codeWorkspace.readings().filter(isActionable)) {
        process.stdout.write(`  note: ${r.capability} — ${r.reason}; ${r.remedy}\n`);
      }
    });
  }

  const state = loadState(statePath);
  const adapters = await buildAdapters(manifest, { secretsDir, since: state.since });
  const egress = new SurfaceEgress({ manifest, adapters });
  const { brain, closeHosted, postMessage, react, jobs, team } = await buildBrain(
    manifest,
    agent.dir,
    secretsDir,
    egress,
    codeWorkspace,
    policy,
  );

  // One lookup, so a credential that was already dead at deploy time is not first noticed
  // by an agent answering a team-knowledge question from the model alone. Off the startup
  // path for the same reason the code index is: an unusable team brain leaves this agent
  // less informed, not wrong, so it comes up, works, and discloses.
  if (team) {
    void team.probe().then(() => {
      for (const r of team.readings().filter(isActionable)) {
        process.stdout.write(`  note: ${r.capability} — ${r.reason}; ${r.remedy}\n`);
      }
    });
  }

  // Subscribe before the brain is ready — upstream's `--lazy-pool` exists for the same
  // reason. A brain that takes seconds to come up must not cost us the mentions that
  // arrive meanwhile; a turn landing early simply waits for readiness.
  const starting = brain instanceof ClaudeAcpBrain ? brain.start() : Promise.resolve();
  starting.catch(() => {}); // reported below, once we are already listening

  const persona = manifest.persona
    ? readFileSync(resolve(agent.dir, manifest.persona), "utf8")
    : undefined;
  const gw = new Gateway({
    manifest,
    adapters,
    brain,
    egress,
    postMessage,
    react,
    persona,
    memory: manifest.brains.length
      ? {
          vault: manifest.brains.some((b) => b.preset === "local" || b.preset === "shared"),
          private: manifest.brains.some((b) => b.preset === "private"),
          team: manifest.brains.some((b) => b.preset === "team"),
        }
      : undefined,
    // Re-read every turn, never captured: the team reading changes when a lookup fails or
    // succeeds, and a latched one handed over as a value would outlive the credential that
    // was rotated to clear it.
    capabilities: () => [...(codeWorkspace?.readings() ?? []), ...(team?.readings() ?? [])],
  });

  // Persist the resume cursor periodically and on exit, so a restart does not reopen a
  // deaf window over the messages that arrived while the process was down.
  const persist = () => {
    for (const a of adapters) {
      const cursor = a.cursor?.();
      if (cursor !== undefined) state.since[a.kind] = cursor;
    }
    saveState(statePath, state);
  };
  const ticker = setInterval(persist, 30_000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ticker);
    process.stdout.write("\nshutting down…\n");
    await gw.drain().catch(() => {});
    // After the turns and before the surfaces close, which is the only window where both
    // are true: a job started inside a turn was just waited for by `drain`, while a
    // detached one never was and is owed a last word through a channel that is still up.
    // It settles rather than waits — see `JobHost.abandon`.
    await jobs?.abandon().catch(() => {});
    await gw.stop().catch(() => {});
    if (brain instanceof ClaudeAcpBrain) await brain.stop().catch(() => {});
    await closeHosted();
    persist();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Before listening: a client decides whether a mention reaches this agent at all by
  // reading the record, so it should agree with this config before anybody can send one.
  await reconcileDirectories(manifest, secretsDir);

  await gw.start();
  await starting; // report a brain that never came up, now that we are listening
  const surfaces = manifest.surfaces.map((s) => s.kind).join(", ");
  const model = manifest.brain.model ? ` model=${manifest.brain.model}` : "";
  process.stdout.write(
    `sageox-agent "${manifest.name}" is live — brain=${manifest.brain.provider}${model} surfaces=[${surfaces}] respondTo=${manifest.respondTo}\n`,
  );
}

/**
 * How this agent's job switches are read, or nothing at all.
 *
 * "Nothing at all" is not "no switch" — it is an unreadable one, which a fail-closed job
 * refuses to run on and a fail-open job runs through. That is the distinction the whole
 * switch vocabulary exists to keep, so a deployment that cannot read its switch says so
 * (below) rather than looking like a deployment that has none.
 *
 * Only the private brain has a reader today, which is the fleet's case: the switch key is
 * `mem/<slug>/enabled`, and `mem/` is the engram namespace. A vault-backed switch for an
 * agent whose only memory is `local` or `shared` has no reader yet.
 */
async function jobSwitchSource(
  manifest: AgentManifest,
  secretsDir?: string,
): Promise<SwitchSource | undefined> {
  const brain = manifest.brains.find((b) => b.preset === "private");
  const buzz = buzzSurface(manifest);
  if (!brain || !buzz) return undefined;
  return engramSwitchSource({
    relayUrl: buzz.relayUrl,
    owner: brain.owner,
    // An unresolvable key is `no-signing-key`, which is one of the switch's own failure
    // classes. Throwing here would turn a switch this host could not read into a job run
    // that never happened and never said why.
    signer: await resolveBuzzSigner(buzz.identity, { dir: secretsDir }).catch(() => undefined),
  });
}

/** Every job that declares a switch, with the key the manifest already resolved for it. */
function jobSwitches(manifest: AgentManifest): { slug: string; key: string }[] {
  return manifest.jobs.flatMap((job) =>
    job.killSwitch ? [{ slug: job.slug, key: job.killSwitch.key }] : [],
  );
}

/**
 * A job's status, sent the way every other outbound message is sent.
 *
 * Both doors onto a job bind this — the gateway, which already holds live adapters, and
 * `job run`, which connects one of its own. Written once so they cannot come to disagree
 * about which guard a status post clears.
 */
function jobPoster(egress: SurfaceEgress): JobPoster {
  return (to, text, threadRoot, mentions) =>
    egress.post(to.surface, to.channel, { text }, threadRoot, mentions);
}

/**
 * How a probing job reads back what it posted — bound beside {@link jobPoster}, and by
 * both doors, so a job cannot post through one surface list and read through another.
 */
function jobReader(egress: SurfaceEgress): JobReader {
  return (root, limit) => egress.readThread(root, limit);
}

/** How a probing job reads its report channel's roster. Bound beside {@link jobReader}. */
function jobMembers(egress: SurfaceEgress): JobMembers {
  return (to, limit) => egress.listMembers(to.surface, to.channel, limit);
}

/**
 * How a detached run answers the conversation that asked for it: the guarded reply the
 * turn itself would have made, into the same thread. A refusal is thrown so the host counts
 * the run as unanswered and lets the status post carry it instead.
 */
function jobAnswerer(egress: SurfaceEgress) {
  return async (home: InboundEvent, text: string): Promise<void> => {
    const verdict = await egress.replyTo(home, { text });
    if (!verdict.ok) throw new Error(`answer refused by ${verdict.rule}: ${verdict.reason}`);
  };
}

/**
 * Where this job's status post goes, live, or nothing when it declares no destination.
 *
 * Only the reporting surface is built. A job run is a job that starts, works, and exits —
 * standing up the console adapter (which takes stdin) or a second Socket Mode connection to
 * reach one channel would be paying for surfaces nothing in this process is listening on.
 *
 * The post still goes through `SurfaceEgress`, which is the point: a job's status is
 * outbound chat, and it clears the public-channel and allowlist rules exactly as the
 * brain's own post tool does. A job cannot announce itself somewhere the agent has no
 * consent to speak.
 */
async function jobReporter(
  manifest: AgentManifest,
  job: JobConfig,
  secretsDir?: string,
): Promise<
  { post: JobPoster; read: JobReader; members: JobMembers; stop: () => Promise<void> } | undefined
> {
  const kind = job.report?.surface;
  // `loadManifest` already refuses a `report.surface` this agent does not declare.
  const surface = kind && manifest.surfaces.find((s) => s.kind === kind);
  if (!surface) return undefined;

  const [adapter] = await buildAdapters({ ...manifest, surfaces: [surface] }, { secretsDir });
  if (!adapter.post) {
    throw new Error(`the ${kind} surface cannot post, so there is nowhere to report`);
  }
  // No listener, because this process posts one status and exits. That is not a
  // micro-optimization: a no-op handler would open a subscription nobody reads and, on
  // Slack, put the whole status post behind an inbound connection it does not need.
  await adapter.start();
  const egress = new SurfaceEgress({ manifest, adapters: [adapter] });
  return {
    post: jobPoster(egress),
    read: jobReader(egress),
    members: jobMembers(egress),
    stop: () => adapter.stop(),
  };
}

/**
 * `--param <name>=<value>`, repeated. The host validates them against the job's declaration.
 *
 * A command line carries only text, so a declared integer is converted here — this is the
 * layer that knows argv is strings, and the alternative is a host that accepts a digit
 * string from every door and calls the advertised type advice. An unparseable one is passed
 * through untouched so the host refuses it by name rather than this reading it as absent.
 */
function jobParamFlags(argv: string[], job: JobConfig, trigger: string): JobParams {
  const given: Record<string, string | number> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error("--param takes <name>=<value>, e.g. --param issue=41");
    const name = pair.slice(0, eq);
    const text = pair.slice(eq + 1);
    given[name] =
      job.parameters[name]?.type === "integer" && /^-?\d+$/.test(text) ? Number(text) : text;
  }
  // Only one of the host's doors carries values. Refusing beats running the job without
  // them: an operator who typed a target and watched a sweep go out instead was not warned
  // by anything, and the run that did happen is not the one they asked for.
  if (Object.keys(given).length && trigger !== "on-request") {
    throw new Error(`--param needs --trigger on-request; a ${trigger} run carries no values`);
  }
  return given;
}

/**
 * Runs one declared job, once, and exits. This is what a CronJob, a launchd job, or an
 * operator execs. `arm` and `park` are the other two doors, and they are
 * {@link jobSwitchCmd}.
 *
 * The entry point is the provenance: `--trigger` picks which of the host's three doors the
 * run comes through, and the host stamps the record from the door rather than from a value
 * anything passed it.
 *
 * A run started here is `system`, never `human`. An operator at a terminal is unambiguously
 * a person, and equally unambiguously carries no author this process can read — and a CI
 * dispatch reaching the same command is not a person at all. Until there is a way to tell
 * the two apart, neither bypasses a parked job, which is the safe direction and mildly
 * annoying for the operator. Ask through a chat surface to bypass.
 */
async function jobCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  const slug = argv[1];
  if ((sub !== "run" && sub !== "arm" && sub !== "park") || !slug || slug.startsWith("--")) {
    throw new Error(
      "usage: sageox-agent job run <slug> [--trigger schedule|on-request|webhook] " +
        "[--param <name>=<value>]... [--agent <name>]\n" +
        "       sageox-agent job arm | park <slug> [--agent <name>]",
    );
  }
  const trigger = flag(argv, "trigger", "schedule")!;
  if (sub === "run" && trigger !== "schedule" && trigger !== "on-request" && trigger !== "webhook") {
    throw new Error(`unknown trigger: ${trigger} (expected schedule | on-request | webhook)`);
  }

  const agent = await agentFromFlag(argv);
  loadDotEnv(agent.env);
  const secretsDir = secretsDirFrom(argv); // before the chdir below
  const manifest = readManifest(agent.config);
  const job = manifest.jobs.find((l) => l.slug === slug);
  if (!job) {
    throw new Error(
      manifest.jobs.length
        ? `${manifest.name} declares no job "${slug}" — it has: ` +
          manifest.jobs.map((l) => l.slug).join(", ")
        : `${manifest.name} declares no jobs`,
    );
  }
  if (sub !== "run") return jobSwitchCmd(manifest, job, sub, secretsDir);

  // Before anything is opened: a mistyped flag is a refusal at the terminal, not a relay
  // connection and a chdir that a throw would leave behind.
  const params = jobParamFlags(argv, job, trigger);

  const switchSource = await jobSwitchSource(manifest, secretsDir);
  if (job.killSwitch && !switchSource) {
    process.stdout.write(
      `  note: ${manifest.name} has no private brain on a Buzz surface, so ${job.slug}'s ` +
        `kill switch cannot be read at all; it fails ${job.killSwitch.failDirection}\n`,
    );
  }
  // A channel this run cannot reach is not a reason the run may not happen: the whole point
  // of a best-effort status post is that a relay outage does not fail a job that did its
  // work. Said out loud here, because a silent feed looks exactly like a quiet one.
  const reporter = await jobReporter(manifest, job, secretsDir).catch((error: unknown) => {
    const first = errorLine(error);
    process.stdout.write(`  note: ${job.slug} cannot reach its status channel: ${first}\n`);
    return undefined;
  });

  // The job body's argv is relative to the bundle, exactly as the brain's and every MCP
  // server's is.
  process.chdir(agent.dir);

  const host = new JobHost({
    switchSource,
    post: reporter?.post,
    read: reporter?.read,
    members: reporter?.members,
    secretOpts: { dir: jobSecretDirs(argv, secretsDir) },
  });
  let run: JobRun;
  try {
    run =
      trigger === "webhook"
        ? await host.webhook(job)
        : trigger === "on-request"
          ? await host.request(job, { kind: "system", id: "cli" }, params)
          : await host.tick(job);
  } finally {
    // Or the open socket keeps this process alive long past the run it was opened for.
    await reporter?.stop().catch(() => {});
  }

  // Headline, then the gates beneath it — the shape a job's status post takes, and the
  // reason it takes it: the verdict is what gets read, and the gates are why it says that.
  // The same rendering the chat tool returns, so one run reads one way wherever it lands.
  process.stdout.write(describeJobRun(run, job.report?.proven));
  const denied = run.outcome === "denied-switch" || run.outcome === "denied-suspend";
  if (denied && trigger === "on-request") {
    process.stdout.write("  a run started from this CLI is `system`, and does not bypass\n");
  }

  // The exit code answers "did the run happen", not "what did it find". A job that ran its
  // gates and found a real failure is a working job, and a green job with a FAIL verdict
  // is the honest rendering of that. A job that crashed or blew its budget is not, and
  // neither is one started through a door it never declared — a parked job is a posture
  // somebody chose, while an undeclared trigger is a job wired to the wrong job.
  if (run.outcome === "crashed" || run.outcome === "budget-bowout") process.exit(1);
  if (run.outcome === "denied-trigger") process.exit(1);
}

/**
 * Arms or parks one job's kill switch, from the deployment host.
 *
 * This is the arming path §6.3 rule 4 requires, and the reason the private brain refuses to
 * be one: **possession of the agent's signing key is the gate, not a claimed author.** The
 * brain never holds that key — the gateway hosts the memory server and hands the brain a
 * URL and a bearer token — so refusing the switch at that surface genuinely takes
 * automation out of the recovery path rather than asking it nicely, and leaves arming with
 * whoever is at the host.
 *
 * That is also why a per-turn author would not have been enough on its own. The author of a
 * *turn* is not the author of a tool call inside it: the brain is what calls, mid-turn, and
 * a write attributed to the human in the channel would arm a job on the strength of
 * somebody having said hello.
 *
 * Parking is offered here too, and not because it is gated anywhere — it is not, and must
 * never be. An operator whose agent is misbehaving should not have to find a chat surface
 * to stop it.
 */
async function jobSwitchCmd(
  manifest: AgentManifest,
  job: JobConfig,
  verb: "arm" | "park",
  secretsDir?: string,
): Promise<void> {
  if (!job.killSwitch) {
    const declared = jobSwitches(manifest).map((s) => s.slug);
    throw new Error(
      `job "${job.slug}" declares no killSwitch, so there is nothing to ${verb}` +
        (declared.length ? ` — these declare one: ${declared.join(", ")}` : ""),
    );
  }
  const brain = manifest.brains.find((b) => b.preset === "private");
  const buzz = buzzSurface(manifest);
  if (!brain || !buzz) {
    throw new Error(
      `${manifest.name} has no private brain on a Buzz surface, so ${job.slug}'s kill switch ` +
        `cannot be written — the switch is the agent's own engram, and there is nowhere to put it`,
    );
  }

  const store = new EngramStore({
    relayUrl: buzz.relayUrl,
    owner: brain.owner,
    signer: await resolveBuzzSigner(buzz.identity, { dir: secretsDir }),
  });
  try {
    // "on" and "off" rather than anything cleverer: `on` is the canonical arming value, and
    // every value that is not one of the arming spellings parks, so `off` is unambiguous
    // to a human reading the key later as well as to `interpretSwitchValue`.
    const entry = await store.write(job.killSwitch.key, verb === "arm" ? "on" : "off");
    process.stdout.write(
      `${job.slug}: kill switch ${verb === "arm" ? "armed" : "parked"} — ` +
        `${job.killSwitch.key} is now \`${verb === "arm" ? "on" : "off"}\` (event ${entry.eventId})\n`,
    );
    if (verb === "arm" && job.suspend) {
      // Otherwise an operator walks away from an incident believing they lifted something
      // they did not: `suspend` is the switch a flip of this one does not clear.
      process.stdout.write(
        "  note: this job is `suspend: true` in the manifest, which no switch clears — " +
          "lifting it takes a reviewed diff\n",
      );
    }
    process.stdout.write(
      verb === "arm"
        ? `  park it again with \`sageox-agent job park ${job.slug}\`\n`
        : "  a human can still run this job on request; automation cannot\n",
    );
  } finally {
    store.close();
  }
}

/** Pre-flight: everything that can be wrong before a single message arrives. */
/**
 * Checks the record that decides whether this agent can be `@`-mentioned at all.
 *
 * Worth a relay round trip in `doctor` because the failure it catches is otherwise
 * invisible: a mention of an agent with no directory record is stripped at send, so the
 * message posts, the agent stays connected and silent, and every other signal on both
 * sides reports healthy. Nothing distinguishes it from a slow or wedged brain.
 */
async function checkDirectory(opts: {
  relayUrl: string;
  identityRef: string;
  secretsDir?: string;
  expected: AgentDirectory;
  problems: string[];
  warnings: string[];
  ok: string[];
}): Promise<void> {
  const { expected } = opts;

  const fix =
    "publish it with `sageox-agent identity register buzz`, or restart the agent — " +
    "`run` reconciles the record against this config before it starts listening";
  let record: Record<string, unknown> | undefined;
  try {
    record = await readDirectory({
      relayUrl: opts.relayUrl,
      identityRef: opts.identityRef,
      secretsDir: opts.secretsDir,
    });
  } catch (error) {
    opts.warnings.push(
      `surface buzz: could not read the directory record at ${opts.relayUrl}: ${errorText(error)}`,
    );
    return;
  }

  if (!record) {
    opts.problems.push(
      `surface buzz: no directory record published — clients strip mentions of this agent ` +
        `at send, so it is connected but unreachable; ${fix}`,
    );
    return;
  }

  const listed = Array.isArray(record.channel_ids) ? (record.channel_ids as unknown[]) : [];
  const missing = expected.channelIds.filter((id) => !listed.includes(id));
  if (missing.length) {
    opts.problems.push(
      `surface buzz: the directory record omits ${missing.join(", ")} — a mention in a ` +
        `channel it does not list is stripped at send; ${fix}`,
    );
    return;
  }

  if (record.respond_to !== expected.respondTo) {
    opts.problems.push(
      `surface buzz: the directory record says respond_to ${JSON.stringify(record.respond_to)} ` +
        `but this config is ${manifestRespondToLabel(expected.respondTo)} — ${fix}`,
    );
    return;
  }

  // The mode alone does not say who: an owner added since the last publish is not in the
  // published allowlist, so clients still gate mentions on the principals it replaced. Only
  // asked of an allowlist record — under `anyone` or `nobody` no client reads the field, so
  // a leftover from a record written before this toolkit owned it is not a live problem.
  if (expected.respondTo === "allowlist") {
    const drift = allowlistDrift(record.respond_to_allowlist, expected.respondToAllowlist);
    if (drift) {
      opts.problems.push(`surface buzz: the directory record ${drift} — ${fix}`);
      return;
    }
  }

  opts.ok.push(
    `surface buzz: directory record lists ${expected.channelIds.length} channel(s), so it is mentionable`,
  );
}

/**
 * Brings every Buzz surface's directory record up to what its config says, before the agent
 * starts listening.
 *
 * Only `sageox-agent identity register buzz` ever wrote this record, and that is a bring-up
 * action — so an edit to `allowlist` or `channels` took effect for the gateway on the next
 * deploy and took effect for clients only when somebody re-ran registration by hand. In
 * between, the agent stops hearing a principal its own manifest names: the client strips the
 * mention at send, the message posts with no `p` tag, and both sides go on reporting healthy.
 * `run` holds the same three inputs registration does — the key, the manifest, and a relay —
 * so it reconciles rather than waiting to be told.
 *
 * `publishDirectory` read-merges and writes only on drift, so a record already in agreement
 * costs one read and no event.
 *
 * A failure warns rather than throws. The record governs who can wake the agent, not whether
 * it runs, and refusing the launch would take an agent off the air over a relay that was
 * briefly unable to serve one read. `publishDirectory` bounds its own connect so that a relay
 * which accepts the socket and never speaks produces such a failure rather than a hung launch.
 */
async function reconcileDirectories(manifest: AgentManifest, secretsDir?: string): Promise<void> {
  for (const { buzz, directory } of await directoryRecords(manifest, secretsDir)) {
    try {
      const { published, preserved } = await publishDirectory({
        relayUrl: buzz.relayUrl,
        identityRef: buzz.identity,
        secretsDir,
        directory,
      });
      process.stdout.write(
        published
          ? `  directory record republished to ${buzz.relayUrl} — mentionable in ` +
            `${directory.channelIds.length} channel(s)` +
            (preserved.length ? `, kept ${preserved.join(", ")}` : "") +
            "\n"
          : `  directory record at ${buzz.relayUrl} already matches this config\n`,
      );
    } catch (error) {
      process.stdout.write(
        `  note: the directory record at ${buzz.relayUrl} could not be reconciled: ` +
          `${errorText(error)} — clients gate mentions on it, so run \`sageox-agent doctor\` ` +
          "to see what it still says\n",
      );
    }
  }
}

/**
 * The directory records this manifest implies — one per record, not one per Buzz surface.
 *
 * The kind is plain-replaceable and addressed by the signing pubkey, so two surfaces reaching
 * one relay under one key are a single record. Publishing them in turn would leave it listing
 * only the last surface's channels, and a channel the record omits has mentions in it stripped
 * at send — the failure this whole path exists to prevent. Their channels are unioned instead.
 *
 * Keyed on the *resolved* pubkey rather than on the `identity` secretRef, because the ref is a
 * name this manifest chose and the pubkey is what the relay files the record under: two refs
 * holding one nsec address one record and would otherwise publish to it twice.
 *
 * Relay too, never the key alone: one key on two relays is two records, and merging them would
 * tell each relay the agent answers in channels that live on the other. `sameRelay` decides,
 * because a trailing slash is not a second relay.
 */
async function directoryRecords(
  manifest: AgentManifest,
  secretsDir?: string,
): Promise<{ buzz: BuzzTarget; directory: AgentDirectory }[]> {
  const records: { buzz: BuzzTarget; pubkey?: string; directory: AgentDirectory }[] = [];
  for (const surface of manifest.surfaces) {
    if (surface.kind !== "buzz") continue;
    const buzz = buzzTarget(surface);
    if (!buzz) continue;

    // A ref that does not resolve stays its own record rather than joining another's: the
    // publish below then fails and names the relay it was for, which is what an operator
    // needs. Folding it in would report success for a surface whose key was never read.
    const pubkey = await resolveBuzzSigner(buzz.identity, { dir: secretsDir })
      .then((signer) => signer.getPublicKey())
      .catch(() => undefined);

    const directory = directoryFor(manifest, surface as BuzzSurfaceChannels, manifest.name);
    const shared = records.find(
      (r) =>
        r.pubkey !== undefined && r.pubkey === pubkey && sameRelay(r.buzz.relayUrl, buzz.relayUrl),
    );
    if (shared) {
      shared.directory.channelIds = [
        ...new Set([...shared.directory.channelIds, ...directory.channelIds]),
      ];
    } else {
      records.push({ buzz, pubkey, directory });
    }
  }
  return records;
}

/** `nobody` reads as a mistake in a message about being unreachable, so name it as the choice it is. */
function manifestRespondToLabel(respondTo: string): string {
  return respondTo === "nobody" ? "nobody (it answers no one)" : respondTo;
}

async function doctorCmd(argv: string[]): Promise<boolean> {
  const agent = await agentFrom(argv);
  loadDotEnv(agent.env);
  const configPath = agent.config;
  const secretsDir = secretsDirFrom(argv); // before the chdir below
  const problems: string[] = [];
  const ok: string[] = [];
  /**
   * Reported, not enforced: a posture that is loose on purpose.
   *
   * Distinct from `problems` because those are configurations that cannot work — an
   * unresolvable secret, a policy that denies the memory it was given. A warning is a
   * deployment that runs exactly as written, by someone who chose it, so refusing to
   * start would be this tool overruling its operator rather than informing them.
   */
  const warnings: string[] = [];
  let repos: ReturnType<typeof parseReposConf> = [];

  if (existsSync(agent.repos)) {
    try {
      repos = parseReposConf(readFileSync(agent.repos, "utf8"));
      if (repos.length) ok.push(`repos.conf declares ${repos.length} repository(s)`);
    } catch (error) {
      problems.push(`repos.conf: ${errorText(error)}`);
    }
  }

  let manifest: AgentManifest | undefined;
  try {
    manifest = readManifest(configPath);
    ok.push(`config ${configPath} parses and validates`);
  } catch (e) {
    problems.push(`config: ${errorText(e)}`);
  }

  if (manifest) {
    process.chdir(agent.dir);
    if (manifest.brain.provider === "claude-acp" && !resolveSecret("ANTHROPIC_API_KEY", { dir: secretsDir }))
      problems.push("brain is claude-acp but ANTHROPIC_API_KEY does not resolve (file or env)");
    else if (manifest.brain.provider === "claude-acp") ok.push("ANTHROPIC_API_KEY resolves");
    // Named in the report because a pin is a cost decision: the operator who set one
    // should be able to confirm it survived, without reading the manifest back.
    if (manifest.brain.model) ok.push(`brain.model pins ${manifest.brain.model}`);

    if (repos.length) {
      if (manifest.brain.provider !== "claude-acp") {
        problems.push("repos.conf is configured but the mock brain cannot use its code tools");
      }
      if (!hasOnPath("git")) problems.push("repos.conf is configured but `git` is not installed");
      else ok.push("git is installed for repository warmup");
      if (!hasOnPath("ox")) problems.push("repos.conf is configured but `ox` is not installed");
      else ok.push("ox is installed for code indexing");
      if (!manifest.tools) {
        problems.push("repos.conf is configured but no tool policy is set — every code tool would be refused");
      }
    }

    // The same inventory `run` refuses to start without, so a clean doctor cannot precede
    // a launch that dies on a missing secret.
    for (const secret of declaredSecrets(manifest, repos)) {
      if (resolveSecret(secret.name, { dir: secretsDir })) {
        ok.push(`${secret.where}: secretRef ${secret.name} resolves`);
      } else if (secret.degraded) {
        warnings.push(
          `${secret.where}: secretRef ${secret.name} does not resolve — ${secret.degraded}`,
        );
      } else {
        problems.push(
          `${secret.where}: secretRef ${secret.name} does not resolve` +
            (secret.hint ? ` — ${secret.hint}` : ""),
        );
      }
    }

    const ageBrains = manifest.brains.filter(
      (brain): brain is Extract<(typeof manifest.brains)[number], { preset: "local" | "shared" }> & {
        age: { recipient: string; identitySecret: string };
      } => (brain.preset === "local" || brain.preset === "shared") && !!brain.age,
    );
    if (ageBrains.length) {
      const hasAge = hasOnPath("age");
      const hasAgeKeygen = hasOnPath("age-keygen");
      if (!hasAge || !hasAgeKeygen) {
        problems.push("age-encrypted memory is configured but the `age` tooling is not installed");
      } else {
        ok.push("age is installed for encrypted markdown memory");
      }
      for (const brain of ageBrains) {
        const identity = resolveSecret(brain.age.identitySecret, { dir: secretsDir });
        if (!identity) continue; // The secretRef inventory above already reported this.
        if (!hasAgeKeygen) continue;
        try {
          const actualRecipient = execFileSync("age-keygen", ["-y", "-"], {
            input: identity.endsWith("\n") ? identity : `${identity}\n`,
            encoding: "utf8",
          }).trim();
          if (actualRecipient === brain.age.recipient) {
            ok.push(`age identity secretRef ${brain.age.identitySecret} matches its recipient`);
          } else {
            problems.push(
              `age identity secretRef ${brain.age.identitySecret} does not match its configured recipient`,
            );
          }
        } catch {
          problems.push(`age identity secretRef ${brain.age.identitySecret} is not a valid age identity`);
        }
      }
    }

    for (const surface of manifest.surfaces) {
      if (surface.kind !== "buzz") continue;
      const buzz = buzzTarget(surface);
      if (!buzz) continue;
      const nsec = resolveSecret(buzz.identity, { dir: secretsDir });
      if (!nsec) continue; // The credential check above already reports this precisely.

      // Before the `buzz` CLI check below: this one talks to the relay directly, and a
      // host without that CLI is exactly where an unmentionable agent goes unnoticed.
      await checkDirectory({
        relayUrl: buzz.relayUrl,
        identityRef: buzz.identity,
        secretsDir,
        expected: directoryFor(manifest, surface as BuzzSurfaceChannels, manifest.name),
        problems,
        warnings,
        ok,
      });

      if (!hasOnPath("buzz")) {
        warnings.push("surface buzz: relay membership was not checked because the `buzz` CLI is not installed");
        continue;
      }
      try {
        await listChannels(buzz.relayUrl, nsec);
        ok.push(`surface buzz: identity can access relay ${buzz.relayUrl}`);
      } catch (error) {
        const detail = errorText(error);
        problems.push(
          isRelayMembershipError(error)
            ? `surface buzz: identity is not a member of relay ${buzz.relayUrl} — ask a relay owner or admin to run \`buzz-admin add-member --pubkey ${agentPubkeys(nsec).npub}\` on the relay host`
            : `surface buzz: could not check relay membership at ${buzz.relayUrl}: ${detail}`,
        );
      }
    }

    // One is all there can be: the schema refuses a second, because both would wire to
    // the `team-brain` server and only one could be reached.
    const teamBrain = manifest.brains.find((b) => b.preset === "team");
    if (teamBrain?.preset === "team") {
      const tokenRef = teamBrain.token ?? DEFAULT_OX_TOKEN_SECRET;
      const ox = await oxStatus({
        token: () => resolveSecret(tokenRef, { dir: secretsDir }),
        configHome: teamBrain.configHome,
      });
      if (!ox.installed) {
        problems.push("a team brain is configured but the `ox` CLI is not installed — it cannot search");
      } else if (!ox.authenticated) {
        problems.push(
          `a team brain is configured but ox is not authenticated${ox.error ? ` (${ox.error})` : ""} — ` +
            "run `ox login`, or mount its auth file into the deployment",
        );
      } else {
        // A personal access token carries no user claims, so naming the credential is
        // more useful than reporting the user as "unknown".
        ok.push(
          ox.source === "SAGEOX_TOKEN"
            ? `ox authenticated via ${tokenRef}${ox.expiresAt ? `, expires ${ox.expiresAt}` : ""}`
            : `ox authenticated as ${ox.user ?? "unknown"}${ox.authFile ? ` (${ox.authFile})` : ""}`,
        );
        if (expiringSoon(ox.expiresAt)) {
          problems.push(`ox credentials expire at ${ox.expiresAt} — refresh before deploying`);
        }
        if (ox.gitPatValid === false) {
          problems.push("ox reports its GitHub credential is invalid — repo-backed context will fail");
        }
      }
    }

    const privateBrain = manifest.brains.find((b) => b.preset === "private");
    if (privateBrain) {
      // A config fact, checked apart from the relay: a prefix the gateway would reject at
      // startup should be a doctor finding, not a failed rollout, and a relay that happens
      // to be unreachable must not hide it.
      if (privateBrain.writeScope) {
        try {
          const scope = privateBrain.writeScope.map(normalizeEngramPrefix);
          ok.push(`private brain writes are scoped to ${scope.join(", ")}`);
        } catch (error) {
          problems.push(
            `private brain writeScope is not a valid key prefix: ${errorText(error)}`,
          );
        }
      }

      const buzz = buzzSurface(manifest);
      if (!buzz) {
        problems.push("private brain: its Buzz surface has no valid relayUrl or identity");
      } else {
        let store: EngramStore | undefined;
        try {
          store = new EngramStore({
            relayUrl: buzz.relayUrl,
            owner: privateBrain.owner,
            signer: await resolveBuzzSigner(buzz.identity, { dir: secretsDir }),
          });
          const core = await store.read("core");
          ok.push(
            core
              ? `private brain is readable (core event ${core.eventId})`
              : "private brain is reachable and has no core yet",
          );
        } catch (error) {
          problems.push(
            `private brain is not readable: ${errorText(error)}`,
          );
        } finally {
          store?.close();
        }
      }
    }

    // Which path arms a job on this deployment, said before an incident rather than
    // during one. There is exactly one, and it is not the agent: its own memory tool may
    // park a switch and can never arm one, so the answer is always this host.
    const switched = jobSwitches(manifest);
    if (switched.length) {
      ok.push(
        `job kill switches: ${switched.map((s) => `${s.slug} → ${s.key}`).join(", ")}`,
      );
      ok.push(
        "arm a job with `sageox-agent job arm <slug>` on this host, park it with `job park` — " +
          "the agent's own brain may park a switch through brain_write and can never arm one",
      );
      if (!manifest.brains.some((brain) => brain.preset === "private")) {
        // Reported, not enforced: a fail-open job declared this posture on purpose. But
        // nothing can park it either, and a kill switch nobody can flip is one in name.
        warnings.push(
          `killSwitch declared by ${switched.map((s) => s.slug).join(", ")} but this agent ` +
            "has no private brain — the switch cannot be read, armed, or parked at all, and " +
            "each job runs the way its failDirection says",
        );
      }
    }

    if (manifest.brains.length && !manifest.tools) {
      problems.push(
        "brains are configured but no tool policy is set — every brain call would be refused",
      );
    }

    if (manifest.mcpServers.length) {
      if (!manifest.tools) {
        problems.push(
          "mcp servers are configured but no tool policy is set — every call would be refused",
        );
      }
      // Whether each server's credential is narrowed to the job. Reported either way: a
      // bound nobody wrote reads exactly like a bound nobody needed, and only one of those
      // is fine.
      for (const decl of manifest.mcpServers) {
        const { name, scope } = resolveMcpServer(decl);
        const bound = Object.entries(scope);
        if (bound.length) {
          ok.push(
            `mcp server "${name}" is bound to ` +
              bound.map(([arg, values]) => `${arg} ∈ ${values.join(", ")}`).join("; "),
          );
        } else {
          warnings.push(
            `mcp server "${name}" declares no scope — every tool reaches everything its ` +
              "credential reaches. Add `scope:` to agent.yaml if that is wider than the job",
          );
        }
      }
      // Tools are reachable by whoever can address the agent, and nothing between a channel
      // message and a filed issue asks a second time.
      if (manifest.respondTo === "anyone") {
        warnings.push(
          `mcp servers are configured (${manifest.mcpServers.map((s) => s.name).join(", ")}) ` +
            "with respondTo: anyone — anyone who can reach a surface can invoke every tool " +
            "the policy allows, including any that write",
        );
      }
    }

    // A job arms the chat door with `trigger.onRequest`; the policy is the other half of
    // it, and an agent that declares one without the other is one nothing can ask.
    const requestable = requestableJobs(manifest.jobs);
    if (requestable.length && !manifest.tools) {
      problems.push(
        `${requestable.length} job(s) declare trigger.onRequest but no tool policy is set — ` +
          `${JOB_RUN_TOOL} would be refused, so nothing could ask for one in chat`,
      );
    }
    // A job too long for a turn is started rather than waited for, so its status post is
    // the only place its verdict can land. Without a `report` it lands nowhere a person
    // will see: whoever asked is told it started and never hears again, which is the
    // silence the job tool exists to end.
    const unheard = requestable.filter(
      (job) => jobDeadlineMs(job) > manifest.limits.turnTimeoutMs && !job.report,
    );
    if (unheard.length) {
      warnings.push(
        `${unheard.map((job) => job.slug).join(", ")} can outlast the ` +
          `${manifest.limits.turnTimeoutMs}ms turn timeout, so a chat request starts them ` +
          "rather than waiting — but they declare no `report`, so the verdict would reach " +
          "no channel; give each one a report destination",
      );
    }

    if (manifest.tools) {
      try {
        const policy = loadToolPolicy(readFileSync(resolve(agent.dir, manifest.tools), "utf8"));
        ok.push(`tool policy ${manifest.tools} is valid`);

        // Ask each server what it offers and check the policy against the answer. Tool
        // names cannot be known any other way, and a name typed by hand is a name that
        // silently matches nothing.
        for (const decl of manifest.mcpServers) {
          const server = resolveMcpServer(decl);
          const tools = await listServerTools(server, secretsDir);
          if (!tools.length) {
            problems.push(
              `mcp server "${server.name}" is configured but reported no tools — it may be failing to start`,
            );
            continue;
          }
          const allowed = tools.filter(
            (t) => policy.allowsTool(`mcp__${server.name}__${t.name}`).ok,
          );
          if (!allowed.length) {
            problems.push(
              `mcp server "${server.name}" offers ${tools.length} tool(s) but the policy allows none — ` +
                `add e.g. mcp__${server.name}__${tools[0].name} to permissions.allow`,
            );
          } else {
            ok.push(
              `mcp server "${server.name}": ${allowed.length}/${tools.length} tool(s) allowed`,
            );
          }

          // A bound the tools cannot carry refuses every call to them — fail-closed, and
          // silent. Only the allowed ones are reported: a tool the policy already denies is
          // unreachable for a reason the operator chose, and naming it here would bury the
          // finding in tools nobody asked for.
          const unreachable = toolsOutsideScope(allowed, server.scope);
          if (unreachable.length) {
            problems.push(
              `mcp server "${server.name}" is bound to ${Object.keys(server.scope).join(", ")}, ` +
                `which ${unreachable.length} allowed tool(s) do not take — every call to ` +
                `${unreachable.map((u) => u.tool).join(", ")} would be refused. Rename the bound ` +
                "to the argument those tools use, or stop allowing them",
            );
          }
        }

        if (manifest.brains.length) {
          const denied = toolNamesFor(manifest.brains).filter((t) => !policy.allowsTool(t).ok);
          if (denied.length) {
            problems.push(
              `brains are configured but the tool policy denies ${denied.join(", ")} — ` +
                "the agent would have memory it cannot use; re-run `sageox-agent memory add " +
                "<preset>` for that brain to re-sync the policy",
            );
          } else {
            ok.push(`brain tools are allowlisted (${manifest.brains.length} brain(s))`);
          }
        }
        if (requestable.length) {
          if (!policy.allowsTool(JOB_RUN_TOOL).ok) {
            problems.push(
              `${requestable.length} job(s) declare trigger.onRequest but the tool policy denies ` +
                `${JOB_RUN_TOOL} — nothing can ask this agent to run one in chat; run ` +
                `\`sageox-agent mcp add ${JOB_SERVER}\`, or drive them from the CLI`,
            );
          } else {
            ok.push(
              `job tool: ${requestable.map((job) => job.slug).join(", ")} can be asked for in chat`,
            );
          }
        }
        if (repos.length) {
          const denied = CODE_POLICY_TOOL_NAMES.filter((name) => !policy.allowsTool(name).ok);
          if (denied.length) {
            problems.push(
              `repos.conf is configured but the tool policy denies ${denied.join(", ")} — ` +
                "re-run `sageox-agent repos add <url>` to repair it",
            );
          } else {
            ok.push(`code tools are allowlisted (${repos.length} repository(s))`);
          }
        }
      } catch (e) {
        // `loadToolPolicy` already says "tool policy:"; name the file instead of repeating it.
        problems.push(`${manifest.tools}: ${errorText(e)}`);
      }
    }

    if (manifest.respondTo === "anyone" && manifest.surfaces.some((s) => s.kind !== "console"))
      warnings.push(
        "respondTo: anyone on a networked surface — anyone who can reach it can spend your key. " +
          "`limits:` is the only thing rationing that; narrow it with owner-only or allowlist when you are ready",
      );

    // One agent answers on every surface it declares, and the same person is a different
    // ID on each. Fewer owner IDs than surfaces means the surfaces without one admit
    // nobody — which looks exactly like an agent that is simply broken.
    const networked = manifest.surfaces.filter((s) => s.kind !== "console");
    const owners = manifest.owner?.length ?? 0;
    if (manifest.respondTo === "owner-only" && networked.length > 1 && owners < networked.length) {
      problems.push(
        `respondTo: owner-only with ${owners} owner id(s) across ${networked.length} networked surfaces ` +
          "— give `owner` one id per surface (e.g. `owner: [npub1…, U08…]`), or the rest answer nobody",
      );
    } else if (manifest.respondTo === "owner-only" && owners > 1) {
      // Counted, not matched to surfaces: this says the owner has enough ids, not that
      // one of them is the right shape for each surface.
      ok.push(`owner is named by ${owners} ids, enough for ${networked.length} networked surface(s)`);
    }

    // Where this agent may speak, read back to the operator. There is no failure left to
    // report here: a channel it may not answer in is one the list leaves out, and the
    // manifest refuses the two ways left to say something else — a duplicate id, and a
    // `reply` this schema does not know.
    for (const surface of manifest.surfaces) {
      if (surface.kind === "console") continue;
      const open = surface.channels.filter((channel) => channel.reply === "public");
      if (surface.channels.length) {
        ok.push(
          `surface ${surface.kind}: may reply in ${surface.channels.length} channel(s)` +
            (open.length
              ? `, publicly in ${open.map((channel) => channel.id).join(", ")}`
              : ", all of them private"),
        );
      } else if (surface.kind === "slack") {
        // Slack reaches the agent by a path no id names: a DM is structurally private, so
        // `message.im` alone is a working agent.
        ok.push("surface slack: no channels listed — DMs are answerable, channels are not");
      } else {
        // Buzz has no such path. With nothing listed the adapter falls back to a mention
        // filter, and every mention it receives arrives from a channel no entry names — so
        // it is public, and the reply is refused. The agent wakes, spends a turn, and says
        // nothing, which is this release's failure in the one shape the entry list cannot
        // rule out: an empty list.
        problems.push(
          `surface ${surface.kind}: no channels listed — it hears mentions from anywhere and ` +
            "may answer in none of them; list the channels it should answer in with " +
            "`sageox-agent surface buzz --channels <ids>`, or by hand under this surface",
        );
      }
    }
  }

  for (const line of ok) process.stdout.write(`  ok    ${line}\n`);
  for (const line of warnings) process.stdout.write(`  warn  ${line}\n`);
  for (const line of problems) process.stdout.write(`  FAIL  ${line}\n`);

  if (problems.length) {
    process.stderr.write(`\n${problems.length} problem(s) — fix these before running.\n`);
    return false;
  }
  process.stdout.write(
    warnings.length
      ? `\nall checks passed, with ${warnings.length} warning(s).\n`
      : "\nall checks passed.\n",
  );
  return true;
}

async function tryCmd(argv: string[]): Promise<void> {
  loadDotEnv();
  const provider = flag(argv, "brain", "mock")!;
  if (provider !== "mock" && provider !== "claude-acp") {
    process.stderr.write(`unknown brain: ${provider} (expected mock | claude-acp)\n`);
    process.exit(1);
  }
  const model = optionValue(argv, "model", MODEL_ID);
  if (model && provider !== "claude-acp") {
    process.stderr.write("--model needs --brain claude-acp; the mock brain runs no model\n");
    process.exit(1);
  }

  // The console is one local human, not a public channel, so the per-author rate limit
  // that protects a real surface would just make `try` go quiet after six messages —
  // with the refusal only in a log nobody is reading.
  const manifest = loadManifest(`
name: try-agent
brain: { provider: ${provider} }
respondTo: anyone
surfaces: [{ kind: console }]
limits: { perAuthorPerMinute: 600, perChannelPerMinute: 600, maxTurnsPerThread: 1000 }
`);

  let brain: Brain;
  if (provider === "claude-acp") {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.stderr.write("ANTHROPIC_API_KEY is required for --brain claude-acp\n");
      process.exit(1);
    }
    // `try` has no manifest to pin from, so the flag is the whole mechanism here — this
    // is where you find out a model is worth pinning before you write it into one.
    const acp = new ClaudeAcpBrain({ model });
    await acp.start();
    brain = acp;
  } else {
    brain = new MockBrain();
  }

  const gw = new Gateway({
    manifest,
    adapters: [new ConsoleAdapter({ input: process.stdin, output: process.stdout })],
    brain,
  });

  const shutdown = async () => {
    await gw.stop().catch(() => {});
    if (brain instanceof ClaudeAcpBrain) await brain.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  process.stdout.write(`sageox-agent try [brain: ${provider}] — type a message (Ctrl+C to exit)\n`);
  await gw.start();
}

const USAGE = `sageox-agent — run one AI agent across chat surfaces

setting up, in the order you need them:
  create [--name x] [--display-name x] [--about x] [--visual x]
         [--generate-avatar | --starter-avatar] [--replace-avatar]
         [--avatar-candidates 1-4]
                               guided persona, character, and profile through preflight
                               (guided avatar creation generates three choices)
                               rerun to resume an unfinished guided setup
         [--inputs x] [--success x] [--boundary x] [--voice x]
         [--metaphor x] [--palette x] [--expression x] [--joke x]
                               provide the advanced interview answers non-interactively
         [--non-interactive]   scaffold with defaults and stop; asks nothing and runs no
                               preflight, naming the doctor command to run instead
  init [--name x] [--display-name x] [--about x]
                               scaffold the same files with defaults (for scripts)
  brain claude [--model <id>] | mock
                               choose the brain            (claude needs an API key)
                               --model pins this agent's model, e.g. claude-opus-5;
                               unset leaves it on the brain's own default
  identity create | attach | show
                               create a new identity or securely provide an existing key
  identity register [buzz] [--relay <url>] [--channel <id>] [--add-as-bot]
                               publish profile.json on Buzz; optionally prompt once for a
                               channel owner/admin key, add the bot, and never save that key
  identity register slack --app-id A…
                               publish the same name, about line, and avatar on Slack
  surface buzz --relay <url> [--channels <ids>] [--private-channels <ids>]
                               add the Buzz surface        (needs an identity); channel
                               IDs, the ones "identity register" lists — a display name
                               matches nothing. A relay cannot report channel privacy or
                               who you are, so it asks you both
                               [--allow-public] [--owner-id npub1…]  answer without a terminal
  surface slack [--channels <ids>] [--private-channels <ids>]
                               add Slack via Socket Mode; asks Slack which channels are
                               private, then settles the public ones and the owner with
                               you. No channels is a DM-only agent
                               [--allow-public] [--owner-id U…]  answer both without a terminal

giving it memory and tools:
  memory add local | private | shared | team
                               add memory, and the policy entries to use it
  memory add private --owner <org-pubkey>
                               encrypted NIP-AE memory on the configured Buzz relay
  memory add shared --with <agents> [--path <dir>]
                               share one markdown vault with a declared group
  memory add local|shared --age-recipient <age1…> [--age-identity <secretRef>]
                               transparently read and write encrypted *.md.age slices
  mcp add surface-egress       add a built-in server and write its policy entries
  mcp add --name x --command npx --args "-y,pkg" [--secret-refs ENV=REF]
                               add your own server: records its local credential, asks the
                               server what it offers, and writes the policy for you
                 [--scope repo=owner/name,owner/other]
                               bind it: every call must carry that argument with a listed
                               value, and one that does not is refused
  repos add <https-url> [--private]
                               clone and index a repository without blocking startup
  repos list                   show the configured repository workspace

reading what it remembers:
  memory list | read [--query x] | path

checking a relay:
  probe --relay <url> [--agent x]  connect read-only and report what it actually serves

running it:
  doctor [--bundle <dir>]      check config, credentials, and policy before running
  run [--bundle <dir>]         run every configured surface locally (Ctrl+C to stop)
  job run <slug> [--trigger schedule|on-request|webhook]
                               run one declared job once and exit — what a CronJob execs.
                               The trigger is stamped from this flag; a run started here is
                               \`system\`, so it does not bypass a parked job
  job arm | park <slug>       flip one job's kill switch. Anyone may park a job, and only
                               a human may arm one — so this host, holding the agent's
                               signing key, is the only place arming happens. The agent's
                               own brain can park a switch and is refused if it tries to arm
  try [--brain mock|claude-acp] [--model <id>]
                               talk to a throwaway agent, no config at all

Agents live in ${agentsHome()}/<name>/ — config, persona, profile, avatar, tools,
credentials, and state together. Name one as \`sageox-agent <cmd> <name>\` or \`--agent <name>\`,
or omit it to pick interactively (the only agent is selected automatically).

options:
  --agent <name>    which agent            (default: pick interactively)
  --bundle <dir>    use a portable bundle instead of the authoring home
  --secrets <dir>   file-mounted secrets   (default: /mnt/secrets-store, then env)

Deployment is a separate concern. The checked-in Compose example and Helm chart consume
one or more bundles through their native configuration.
`;

const commands: Record<string, (argv: string[]) => Promise<void> | void> = {
  // Spawned by the broker as a stdio child, not typed by a human.
  "brain-server": (argv) => runBrainServer(flag(argv, "vault") ?? process.cwd()),
  init: initCmd,
  create: async (argv) => { await createCmd(argv, finishCreateJourney); },
  brain: brainCmd,
  identity: identityCmd,
  memory: (argv: string[]) =>
    argv[0] === "add" ? memoryAddCmd(argv.slice(1)) : memoryCmd(argv),
  surface: surfaceCmd,
  probe: probeCmd,
  repos: reposCmd,
  mcp: mcpAddCmd,
  doctor: async (argv) => {
    if (!await doctorCmd(argv)) process.exit(1);
  },
  run: runCmd,
  job: jobCmd,
  try: tryCmd,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2] ?? "";
  const handler = commands[cmd];
  if (!handler) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  void (async () => {
    try {
      await handler(process.argv.slice(3));
    } catch (error: unknown) {
      process.stderr.write(`${errorText(error)}\n`);
      process.exit(1);
    }
  })();
}
