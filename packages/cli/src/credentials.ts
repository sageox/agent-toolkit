import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SECRETS_DIR,
  resolveMcpServer,
  resolveSecret,
  type AgentManifest,
} from "@sageox/agent-toolkit-core";
import { DEFAULT_OX_TOKEN_SECRET } from "./brains.ts";
import { upsertEnv } from "./init.ts";
import { isInteractive, promptSecret } from "./prompt.ts";
import type { RepoSpec } from "./repos.ts";

export function readEnvValue(name: string, envPath = ".env"): string | undefined {
  return process.env[name] || readEnvFileValue(name, envPath);
}

/** The same lookup with the ambient environment left out — only what the file says. */
export function readEnvFileValue(name: string, envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

export interface CredentialSpec {
  name: string;
  /** Shown when asking for it. */
  label: string;
  /** A soft shape check — warns, never refuses, because key formats change. */
  looksRight?: (value: string) => boolean;
  hint?: string;
  /**
   * Refuses to take this credential from the ambient environment.
   *
   * Most of these names are ours alone, so reusing one that is already exported saves a
   * paste. `GITHUB_TOKEN` is not ours: gh, direnv and CI all set it, and inheriting it
   * would stage whatever the shell happened to be carrying — usually a token scoped far
   * wider than the repositories the agent reads — into a file the container then mounts,
   * with nothing printed but "staged". Chosen for this agent, or asked for.
   */
  neverInherited?: boolean;
  /**
   * A blank answer, or no terminal to answer in, returns `""` instead of throwing.
   *
   * For a credential whose absence degrades a capability rather than breaking the command
   * that asks for it. The caller has already decided the agent is configured either way, so
   * ending the interview here would cost the rest of it over something `doctor` reports.
   */
  optional?: boolean;
}

/**
 * Returns a credential, asking for it if a human is present.
 *
 * Asking beats instructing: the alternative is telling someone to open a dotfile and get
 * the variable name exactly right. When there is no terminal this throws with that
 * instruction instead, so a service fails loudly rather than blocking on stdin.
 */
export interface CredentialIO {
  interactive?: () => boolean;
  ask?: (question: string) => Promise<string>;
  envPath?: string;
  /** Where file-mounted secrets live. Defaults to `/mnt/secrets-store` inside resolveSecret. */
  secretsDir?: string;
  /**
   * Ask even when a value already resolves. Rotation is the one case where reusing what is
   * already on the machine is exactly wrong: it is the credential being replaced.
   */
  force?: boolean;
  log?: (line: string) => void;
}

/** The specs asked for in more than one command, written once so wording cannot drift. */
export const ANTHROPIC_KEY_SPEC: CredentialSpec = {
  name: "ANTHROPIC_API_KEY",
  label: "Paste your Anthropic API key (input hidden)",
  hint: "Get one at https://console.anthropic.com/settings/keys",
  looksRight: (value) => value.startsWith("sk-ant-"),
};

export const GITHUB_TOKEN_SPEC: CredentialSpec = {
  name: "GITHUB_TOKEN",
  label: "Paste this agent's GitHub token (input hidden)",
  // The token is the outer bound and `scope` is the inner one, so a fine-grained token is
  // what makes the two agree: an agent bound to one repository holding an org-wide token is
  // one config edit away from reaching the rest. Create one at
  // https://github.com/settings/tokens.
  hint:
    "Use a fine-grained token limited to the repositories this agent may touch: Contents " +
    "read-only for repos.conf checkouts, plus Issues or Pull requests write only where the " +
    "tool policy allows a write — https://github.com/settings/tokens",
  looksRight: (value) => value.startsWith("github_pat_") || value.startsWith("ghp_"),
  neverInherited: true,
};

export const SAGEOX_TOKEN_SPEC: CredentialSpec = {
  name: "SAGEOX_TOKEN",
  label: "Paste your SageOx personal access token (input hidden)",
  hint: "Create one at https://sageox.ai/settings/tokens — it is shown only once",
  looksRight: (value) => value.startsWith("oxp_"),
};

export const slackBotTokenSpec = (name: string): CredentialSpec => ({
  name,
  label: `Paste ${name} — Slack Bot User OAuth Token (input hidden)`,
  hint: "Install the Slack app to the workspace, then copy its Bot User OAuth Token",
  looksRight: (value) => value.startsWith("xoxb-"),
});

export const slackAppTokenSpec = (name: string): CredentialSpec => ({
  name,
  label: `Paste ${name} — Slack Socket Mode app token (input hidden)`,
  hint: "Enable Socket Mode and create an app-level token with connections:write",
  looksRight: (value) => value.startsWith("xapp-"),
});

const buzzNsecSpec = (name: string): CredentialSpec => ({
  name,
  label: `Paste ${name} — the agent's Nostr secret key (input hidden)`,
  hint: "`sageox-agent identity create` makes one if this agent has no key yet",
  looksRight: (value) => value.startsWith("nsec"),
});

/**
 * What to ask for when a process the bundle declares — an MCP server, a job body — names a
 * secret it needs. One prompt for both, because both are the same fact: a credential the
 * gateway holds on behalf of a child it spawns, and never inherits from the shell.
 *
 * **No shape check and no per-process hint.** The ref is whatever the author named it and
 * the process behind it is the bundle's, so neither is knowable here — and neither is
 * needed. A wrong credential is the one failure that reports itself: whatever it is aimed at
 * rejects it on the first call, loudly, and no warning printed here would have said it
 * sooner or better. That is true of every such process, not only the ones whose token format
 * we happen to recognise.
 *
 * **`neverInherited` is the exception, because its failure does not report itself.** A wrong
 * credential fails; an over-scoped *valid* one works, indefinitely, while the agent holds far
 * more reach than anyone chose for it. `gh`, `direnv`, `psql` and CI all export exactly these
 * names, so a prompt that read the ambient environment would stage whatever the human's shell
 * was carrying into a file the container then mounts, printing only "staged". This is the
 * outer half of what `mcpServers[].scope` guarantees on the inner half — a bound is worth
 * what the credential behind it is scoped to — and it is undone before the bound is ever
 * consulted. A job body has no `scope` at all, so this is the whole of it there.
 *
 * It refuses the *shell*, not the bundle: the agent's own `.env` still answers, so this costs
 * one paste at bring-up and nothing afterwards.
 */
export const spawnedSecretSpec = (
  name: string,
  envVar: string,
  spawned: string,
): CredentialSpec => ({
  name,
  label: `Paste ${name} — supplied to ${spawned} as ${envVar} (input hidden)`,
  hint: "Use a credential issued for this agent and scoped to what it is bound to — not the one this shell exports",
  neverInherited: true,
});

const ageIdentitySpec = (name: string, recipient: string): CredentialSpec => ({
  name,
  label: `Paste ${name} — the AGE-SECRET-KEY for ${recipient} (input hidden)`,
  hint: "`age-keygen` prints an identity and its recipient; the recipient must be the one in agent.yaml",
});

export async function requireCredential(
  spec: CredentialSpec,
  io: CredentialIO = {},
): Promise<string> {
  const interactive = io.interactive ?? isInteractive;
  const ask = io.ask ?? promptSecret;
  const envPath = io.envPath ?? ".env";
  const say = io.log ?? ((line: string) => process.stdout.write(line));

  // File-first, matching how every other secret resolves: a container mounts the key
  // rather than passing it in an environment that `docker inspect` can read.
  let existing: string | undefined;
  if (!io.force) {
    existing = spec.neverInherited
      ? readEnvFileValue(spec.name, envPath)
      : (resolveSecret(spec.name, { dir: io.secretsDir }) ?? readEnvValue(spec.name, envPath));
  }
  if (existing) return existing;

  if (!interactive()) {
    const note = spec.hint ? `\n(${spec.hint})` : "";
    if (spec.optional && !io.force) {
      say(`  ${spec.name} is not set — add it to ${envPath} when you have one.${note}\n`);
      return "";
    }
    // Naming the one in the environment, because "not set" in front of a variable that is
    // plainly exported reads as a bug rather than the refusal it is.
    const ignored =
      spec.neverInherited && process.env[spec.name]
        ? ` The one exported here is not used: it belongs to this shell, not to this agent.`
        : "";
    throw new Error(
      io.force
        ? `${spec.name} cannot be replaced without a terminal to type the new value into.${note}`
        : `${spec.name} is not set.${ignored} Add it to .env:\n  ${spec.name}=<value>${note}`,
    );
  }

  if (spec.hint) say(`${spec.hint}\n`);
  // Trim here, not only in the prompt: a stray space-enter must not be saved as a key.
  const value = (await ask(`${spec.label}: `)).trim();
  if (!value) {
    if (spec.optional) {
      say(`  skipped — ${spec.name} is still unset\n`);
      return "";
    }
    throw new Error(`no value given — ${spec.name} is still unset`);
  }

  if (spec.looksRight && !spec.looksRight(value)) {
    say(`  note: that does not look like a ${spec.name}, saving it anyway\n`);
  }

  upsertEnv(envPath, spec.name, value); // chmod 600 — it is a secret
  say(`  saved ${spec.name} to ${envPath} (mode 600)\n`);
  return value;
}

/** One place a bundle asks for a ref, and the advice that belongs to *that* place. */
export interface Declaration {
  /** Where the bundle asks for it, so an operator knows which line to fix. */
  where: string;
  /**
   * What to do about it here.
   *
   * Per declaration and not per ref, because advice is about one feature: a job's
   * `run.jobSecrets` remedy is wrong for the `private` checkout reading the same
   * `GITHUB_TOKEN`, and the checkout's fine-grained-token advice says nothing about the job.
   * A ref two features share has two answers, and an operator needs the one beside the line
   * it belongs to.
   */
  hint?: string;
}

/** A `secretRef` the bundle declares, with every line that declares it. */
export interface DeclaredSecret extends Omit<CredentialSpec, "hint"> {
  /** Never empty. More than one means several features read the same file. */
  declaredBy: Declaration[];
  /**
   * What still works without it.
   *
   * Set means the agent starts anyway. An age identity is withheld from a deployment on
   * purpose — the deployment contract says to mount it only where decryption is allowed —
   * so its absence is a posture someone chose, not a fault. Everything else here is a
   * credential the agent was configured to use and would fail every attempt to use.
   */
  degraded?: string;
}

/** One declaration, taking the spec's own advice as that declaration's. */
function declaredAt(spec: CredentialSpec, where: string, degraded?: string): DeclaredSecret {
  const { hint, ...rest } = spec;
  return { ...rest, declaredBy: [{ where, hint }], degraded };
}

/** Every place a ref is declared, as one phrase. */
export function declaredWhere(secret: DeclaredSecret): string {
  return secret.declaredBy.map((decl) => decl.where).join(" and ");
}

/**
 * The advice across every declaration, each stated once.
 *
 * Two jobs sharing a ref share a remedy, and saying it twice reads as two instructions.
 */
export function declaredHints(secret: DeclaredSecret): string[] {
  const hints = secret.declaredBy
    .map((decl) => decl.hint)
    .filter((hint): hint is string => hint !== undefined);
  return [...new Set(hints)];
}

/**
 * One entry per `secretRef`, however many features read it.
 *
 * Several features legitimately share a credential — a bundle's GitHub MCP server and a
 * `private` checkout in `repos.conf` both read `GITHUB_TOKEN`, and that is the common shape
 * once an agent's tools live in its own bundle. Left unmerged, one missing file is reported
 * as "2 declared secret(s) did not resolve" and prompted for twice, which reads as two
 * problems and is one.
 *
 * The merged entry keeps every declaration, and is **fatal if any declaration is fatal**: a
 * feature that degrades gracefully without the credential does not make the one that cannot
 * start without it any less broken.
 *
 * Keeping them all is what lets each carry its own advice. A single `hint` on the merged
 * entry could only be one declaration's, so it was either wrong for the others or dropped;
 * neither states what an operator facing two features and one file actually needs.
 */
function mergeByRef(declared: DeclaredSecret[]): DeclaredSecret[] {
  const byRef = new Map<string, DeclaredSecret>();
  for (const secret of declared) {
    const seen = byRef.get(secret.name);
    if (!seen) {
      byRef.set(secret.name, secret);
      continue;
    }
    byRef.set(secret.name, {
      ...seen,
      declaredBy: [...seen.declaredBy, ...secret.declaredBy],
      degraded: seen.degraded && secret.degraded ? seen.degraded : undefined,
    });
  }
  return [...byRef.values()];
}

/**
 * Every `secretRef` a bundle declares, from the manifest and from `repos.conf`.
 *
 * One list, so `run` and `doctor` cannot drift: a doctor that checks a smaller set than
 * the runtime reads as a clean bill of health for a bundle that cannot start.
 */
export function declaredSecrets(manifest: AgentManifest, repos: RepoSpec[]): DeclaredSecret[] {
  const declared: DeclaredSecret[] = [];

  manifest.surfaces.forEach((surface, index) => {
    const at = `surfaces[${index}]`;
    if (surface.kind === "buzz" && typeof surface.identity === "string") {
      declared.push(declaredAt(buzzNsecSpec(surface.identity), `${at}.identity (buzz)`));
    }
    if (surface.kind === "slack") {
      if (typeof surface.identity === "string") {
        declared.push(declaredAt(slackBotTokenSpec(surface.identity), `${at}.identity (slack)`));
      }
      if (typeof surface.appToken === "string") {
        declared.push(declaredAt(slackAppTokenSpec(surface.appToken), `${at}.appToken (slack)`));
      }
    }
  });

  manifest.brains.forEach((brain, index) => {
    if ((brain.preset === "local" || brain.preset === "shared") && brain.age) {
      declared.push(
        declaredAt(
          ageIdentitySpec(brain.age.identitySecret, brain.age.recipient),
          `brains[${index}].age.identitySecret`,
          "plaintext vault files stay readable; every `*.md.age` slice is denied on read and on write",
        ),
      );
    }
    if (brain.preset === "team") {
      const ref = brain.token ?? DEFAULT_OX_TOKEN_SECRET;
      declared.push(
        declaredAt(
          { ...SAGEOX_TOKEN_SPEC, name: ref },
          `brains[${index}].token${brain.token ? "" : ` (defaulted to ${ref})`}`,
          // The one credential with a second source: `ox login` writes an auth.json that
          // authenticates just as well, which is why a workstation legitimately has no
          // token. A deployment mounts neither, and every team_search fails.
          "an `ox login` auth.json authenticates instead where one exists; a deployment " +
          "with neither fails every team_search",
        ),
      );
    }
  });

  manifest.mcpServers.forEach((decl, index) => {
    const server = resolveMcpServer(decl);
    for (const [envVar, ref] of Object.entries(server.secrets)) {
      declared.push(
        declaredAt(
          spawnedSecretSpec(ref, envVar, "the server"),
          `mcpServers[${index}].secrets.${envVar} (server "${server.name}")`,
        ),
      );
    }
  });

  // A job resolves its refs per run rather than at startup, so `run` and `doctor` are the
  // only places a missing one can be reported before the job is due. Left out here, the
  // first report is a crashed 3am tick in a channel.
  //
  // `run.secrets` and not `run.jobSecrets`: this is checked against the one directory the
  // calling process was given, and a `jobSecrets` ref is the one a deployment keeps out of
  // the gateway's. Listing it would refuse the launch of every agent that split a credential
  // out. `job run` resolves it per run and fails by name.
  //
  // The hint names that field here, where the refusal is read, because the two remedies
  // this error otherwise offers — mount the file here, add it to `.env` — are both the
  // arrangement the split was for.
  manifest.jobs.forEach((job, index) => {
    for (const [envVar, ref] of Object.entries(job.run.secrets)) {
      declared.push(
        declaredAt(
          {
            ...spawnedSecretSpec(ref, envVar, "the job body"),
            hint:
              `if ${ref} is mounted only in a directory this process is not given, it ` +
              "belongs in run.jobSecrets rather than run.secrets — this check leaves that " +
              "map out, and `sageox-agent job run` resolves it per run and fails by name",
          },
          `jobs[${index}].run.secrets.${envVar} (job "${job.slug}")`,
        ),
      );
    }
  });

  // Asked here rather than at the clone: `gitEnvironment` throws for a private checkout
  // after warmup has already started, which is late and on a background path.
  const priv = repos.filter((repo) => repo.private);
  if (priv.length) {
    declared.push(
      declaredAt(
        GITHUB_TOKEN_SPEC,
        `repos.conf (private: ${priv.map((repo) => repo.name).join(", ")})`,
      ),
    );
  }

  return mergeByRef(declared);
}

/**
 * One entry of the "did not resolve" list: the ref, where it is declared, and what to do.
 *
 * A ref declared once keeps the one-line form it has always had. Several declarations get a
 * line each, because they are separate lines in separate files to go and fix — and each
 * carries the advice belonging to it, since a remedy for one feature can be the wrong move
 * for the other reading the same file. Declarations that share a remedy are listed together
 * above it, so it is stated once.
 */
function describeDeclared(secret: DeclaredSecret): string {
  const [only] = secret.declaredBy;
  if (secret.declaredBy.length === 1) {
    return `  ${secret.name} — declared by ${only.where}` + (only.hint ? `\n      ${only.hint}` : "");
  }
  const groups = declaredHints(secret).map((hint) => ({
    hint,
    wheres: secret.declaredBy.filter((decl) => decl.hint === hint).map((decl) => decl.where),
  }));
  const unadvised = secret.declaredBy.filter((decl) => !decl.hint).map((decl) => decl.where);
  const blocks = [
    ...unadvised.map((where) => `      ${where}`),
    ...groups.map(
      (group) => group.wheres.map((where) => `      ${where}`).join("\n") + `\n          ${group.hint}`,
    ),
  ];
  return `  ${secret.name} — declared by:\n${blocks.join("\n")}`;
}

/**
 * Refuses to start when a declared `secretRef` does not resolve, and says how to supply it.
 *
 * Each of these otherwise fails at the moment it is first needed — the clone, the first
 * MCP call, the first encrypted read. That is late, usually on a background path where
 * the failure becomes a status line rather than an exit code, and always on the one class
 * of value a human must supply from outside the process. Ask the whole question here, and
 * answer it in one message instead of one restart per missing secret.
 *
 * Returns the ones that are missing but not fatal, so the caller can report the posture.
 */
export function requireDeclaredSecrets(
  declared: DeclaredSecret[],
  opts: { dir?: string } = {},
): DeclaredSecret[] {
  const dir = opts.dir ?? DEFAULT_SECRETS_DIR;
  const missing = declared.filter((secret) => !resolveSecret(secret.name, { dir }));
  const fatal = missing.filter((secret) => !secret.degraded);
  const degraded = missing.filter((secret) => secret.degraded);

  if (fatal.length) {
    const list = fatal.map(describeDeclared).join("\n\n");
    throw new Error(
      `${fatal.length} declared secret(s) did not resolve, so this agent cannot do what it ` +
        `is configured to do. Each is read from ${dir}/<name>, then from the environment:\n\n` +
        `${list}\n\n` +
        `Mount one file per secret under ${dir}, or add it to this agent's .env.`,
    );
  }

  return degraded;
}
