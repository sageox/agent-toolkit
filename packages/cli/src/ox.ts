import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { oxEnv, oxCwd, type OxScope } from "@sageox/agent-toolkit-core";

const run = promisify(execFile);

export interface OxStatus {
  installed: boolean;
  authenticated: boolean;
  /** ISO timestamp the token expires at, when ox reports one. */
  expiresAt?: string;
  user?: string;
  /** ox's own view of whether its GitHub credential still works. */
  gitPatValid?: boolean;
  authFile?: string;
  /**
   * Which credential actually authenticated.
   *
   * ox reports `config.auth_file` unconditionally — the path it *would* read for a disk
   * login, whether or not anything is there. Reporting that as the source is wrong in a
   * container, where the file does not exist and a token did the work.
   */
  source?: "SAGEOX_TOKEN" | "auth file";
  /** Why the check could not be completed, when it could not. */
  error?: string;
}

/**
 * Asks ox whether it can actually talk to the team.
 *
 * The team brain has no credential of its own — it shells to `ox`, which authenticates
 * from a token file in the user config directory. That is the right shape (a
 * file-mounted secret, never an env var) but it fails in a quiet way: an unauthenticated
 * `ox` returns no passages, which is indistinguishable from a team that has written
 * nothing down. So the check happens before the agent runs, not at the first question.
 */
export async function oxStatus(scope: OxScope = {}): Promise<OxStatus> {
  try {
    // Same credential the team brain will use, or the check answers a different question
    // than the one asked: a container has no ambient login for ox to fall back on.
    const { stdout } = await run("ox", ["status", "--json"], { timeout: 30_000, env: oxEnv(scope), cwd: oxCwd(scope) });
    const parsed = JSON.parse(stdout) as {
      auth?: {
        authenticated?: boolean;
        expires_at?: string;
        user?: string;
        git_pat_valid?: boolean;
      };
      config?: { auth_file?: string };
    };
    return {
      installed: true,
      authenticated: parsed.auth?.authenticated === true,
      expiresAt: parsed.auth?.expires_at,
      user: parsed.auth?.user,
      gitPatValid: parsed.auth?.git_pat_valid,
      authFile: parsed.config?.auth_file,
      // An env token takes precedence over anything on disk, so if we supplied one and
      // the call authenticated, that is what authenticated it.
      source: credentialSource(scope),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "ENOENT") return { installed: false, authenticated: false };
    return {
      installed: true,
      authenticated: false,
      error: (e.message ?? "ox status failed").slice(0, 160),
    };
  }
}

/**
 * Which credential authenticated. An env token takes precedence over anything on disk,
 * so supplying one means it is what did the work.
 */
export function credentialSource(scope: OxScope): "SAGEOX_TOKEN" | "auth file" {
  return scope.token?.() ? "SAGEOX_TOKEN" : "auth file";
}

/** True when the token is gone or expires within the hour. */
export function expiringSoon(expiresAt: string | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return false;
  return at - now.getTime() < 60 * 60 * 1000;
}

/**
 * What `ox` leaves behind when it restores a team: the id it was cloned from, then
 * `.bak.<epoch>`. Anchored on both ends so it matches the whole id and not a team whose
 * own id merely contains the word.
 */
const RESTORE_CLONE = /^.+\.bak\.\d+$/;

export interface OxTeam {
  id: string;
  name: string;
  slug?: string;
  /** False when the listing carried no name and `name` above is the slug or the id. */
  named: boolean;
}

/**
 * The teams this machine can see.
 *
 * `ox team list` is the command that answers this. It was `ox kb list` filtered to the
 * entries of type `team`, which never worked: `kb list` ignores `--json` and prints a
 * table, so the parse threw on every call and the catch below turned it into "no teams
 * found on this machine" — indistinguishable from a real one, and the reason this listing
 * appeared to be a workstation-only convenience rather than broken.
 *
 * Restore leftovers are dropped rather than ranked. A restore leaves a
 * `<team-id>.bak.<epoch>` clone behind and `ox team list` reports it as a team, but it is
 * not one you can pick: its id is a directory name, and choosing it writes a string into
 * the manifest that no deployment can resolve. Sorting them to the bottom still put six of
 * them on a menu of nine here. A team id is `team_` and one run of base32-ish characters,
 * so a suffixed one is a clone by construction — see {@link RESTORE_CLONE}.
 *
 * Still a workstation command: a container holding nothing but a token has no local team
 * state and gets an empty list. That is why the id is resolved here, once, and written into
 * the manifest — the deployment cannot look it up later.
 */
export async function oxTeams(scope: OxScope = {}): Promise<OxTeam[]> {
  try {
    const { stdout } = await run("ox", ["team", "list", "--json"], {
      timeout: 60_000,
      env: oxEnv(scope),
      cwd: oxCwd(scope),
    });
    const parsed = JSON.parse(stdout) as {
      primary_team?: string;
      teams?: Array<{ team_id?: string; name?: string; slug?: string; primary?: boolean }>;
    };
    return (parsed.teams ?? [])
      .filter((t) => t.team_id && !RESTORE_CLONE.test(t.team_id))
      .map((t) => ({
        id: t.team_id!,
        name: t.name ?? t.slug ?? t.team_id!,
        slug: t.slug,
        named: Boolean(t.name && t.name !== t.team_id),
      }))
      // Primary first — ox already knows which team the person almost certainly means —
      // then the ones that carry a name, since a team that did not identify itself should
      // not sit above one that did.
      .sort(
        (a, b) =>
          Number(b.id === parsed.primary_team) - Number(a.id === parsed.primary_team) ||
          Number(b.named) - Number(a.named),
      );
  } catch {
    // Listing is a convenience; failing it must not stop someone who knows their team id.
    return [];
  }
}
