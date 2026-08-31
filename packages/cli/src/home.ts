import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isInteractive, promptLine } from "./prompt.ts";
import { flag } from "./args.ts";

/**
 * Where agents live.
 *
 * An agent is a *thing you run*, not a property of whatever directory you happen to be
 * standing in. Keeping each one self-contained under a fixed home means it can be named
 * from anywhere, a service manager needs no working directory, and nothing an agent owns
 * ever leaks into a source tree.
 *
 * The path is deliberately neutral: this toolkit runs agents on Buzz, Slack, Discord and
 * a console, so naming the home after any one surface would be wrong — and naming it
 * after the toolkit would bind it to a name the design has not settled yet.
 *
 * Strict XDG would split state into `~/.local/state`. Keeping an agent's cursor beside
 * its config is the deliberate trade: one directory is the whole agent, which is what
 * makes it movable, inspectable, and deletable in one step.
 */
export function agentsHome(): string {
  if (process.env.AGENT_TOOLKIT_HOME) return process.env.AGENT_TOOLKIT_HOME;
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "agent-toolkit", "agents");
}

export function agentDir(name: string): string {
  return join(agentsHome(), name);
}

/** Paths in a portable bundle, independent of the framework's authoring home. */
export function bundlePaths(directory: string) {
  const dir = resolve(directory);
  return {
    dir,
    config: join(dir, "agent.yaml"),
    persona: join(dir, "AGENTS.md"),
    profile: join(dir, "profile.json"),
    avatarBrief: join(dir, "avatar.md"),
    avatar: join(dir, "avatar.svg"),
    generatedAvatar: join(dir, "avatar.png"),
    tools: join(dir, "settings.json"),
    repos: join(dir, "repos.conf"),
    env: join(dir, ".env"),
    state: join(dir, "state.json"),
    creation: join(dir, ".create-progress.json"),
  };
}

/** Everything an authored agent owns, in one place. */
export function agentPaths(name: string) {
  return bundlePaths(agentDir(name));
}

export function listAgents(): string[] {
  const home = agentsHome();
  if (!existsSync(home)) return [];
  return readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(home, e.name, "agent.yaml")))
    .map((e) => e.name)
    .sort();
}

/** Paths for the agent `--agent` names, or the one the shared picker settles on. */
export async function selectedPaths(argv: string[]): Promise<ReturnType<typeof agentPaths>> {
  return agentPaths(await selectAgentName(flag(argv, "agent")));
}

export function ensureAgentDir(name: string): string {
  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Picks which agent a command applies to, asking a person when the choice is ambiguous. */
export async function selectAgentName(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const agents = listAgents();
  if (agents.length === 1) return agents[0];
  if (agents.length === 0) {
    throw new Error(`no agents yet — create one with \`sageox-agent init --name <name>\``);
  }
  if (!isInteractive()) {
    throw new Error(
      `which agent? name one of: ${agents.join(", ")}\n  e.g. sageox-agent run ${agents[0]}`,
    );
  }

  process.stdout.write(
    `Which agent?\n${agents.map((agent, index) => `  ${index + 1}. ${agent}`).join("\n")}\n`,
  );
  const answer = await promptLine(`Choice [1-${agents.length}]: `);
  const named = agents.find((agent) => agent === answer);
  const numbered = /^\d+$/.test(answer) ? agents[Number(answer) - 1] : undefined;
  const picked = named ?? numbered;
  if (picked) return picked;
  throw new Error(`choose an agent by number or name: ${agents.join(", ")}`);
}
