import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `secretRef`, and equally a POSIX environment-variable name — one grammar because a ref
 * has to work as both: it names a file under {@link DEFAULT_SECRETS_DIR} and the variable a
 * resolved value is handed to. Exported so the manifest schema refuses a bad one where it is
 * declared, rather than here where it is first used.
 */
export const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Where a `secretRef` is looked for as a file. Named because it is also what an operator
 * has to be told when one is missing, and a message that guessed a different path than
 * the resolver uses would send them to the wrong directory.
 *
 * Under `/mnt` and not `/run`, because `/var/run` is a symlink to `/run` and
 * `/var/run/secrets` is where a Kubernetes cluster projects a Pod's identity token. A
 * read-only mount there covers a mountpoint `runc` has to create, and the container then
 * fails before its first process — which nothing in this repository can catch, because
 * nothing here has run yet.
 */
export const DEFAULT_SECRETS_DIR = "/mnt/secrets-store";

/** Reject path-like names before they can escape a file-mounted secret directory. */
function assertSecretRef(name: string): string {
  if (!SECRET_REF.test(name)) {
    throw new Error(
      `invalid secretRef ${JSON.stringify(name)}; use letters, numbers, and underscores, ` +
        "starting with a letter or underscore",
    );
  }
  return name;
}

/**
 * Resolves a `secretRef` logical name. File-first, env-fallback: real secrets are
 * file-mounted because env leaks via `docker inspect`, `/proc/<pid>/environ`, and
 * crash dumps.
 *
 * `dir` may name more than one directory, searched in order, and one string is the same
 * thing said shorter. A second directory is how a deployment gives one consumer a mount
 * another does not get: a credential that only a job's body needs can be mounted on the job
 * Pod alone, and is then not a file in the container that runs the brain. Which consumer
 * gets which directory is the caller's to decide — this only agrees to look in more than
 * one place, and still falls back to the environment exactly once, after all of them.
 */
export function resolveSecret(
  name: string,
  opts: { dir?: string | readonly string[]; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  assertSecretRef(name);
  const dirs =
    typeof opts.dir === "string" ? [opts.dir] : (opts.dir ?? [DEFAULT_SECRETS_DIR]);
  const env = opts.env ?? process.env;
  for (const dir of dirs) {
    try {
      const path = join(dir, name);
      if (lstatSync(path).isFile()) return readFileSync(path, "utf8").trim();
    } catch {
      // The next directory, then the environment. A missing mount is the ordinary case on
      // a host that runs one agent from `.env`, not an error to report.
    }
  }
  return env[name];
}
