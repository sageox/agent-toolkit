import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { passthroughEnv } from "./brain-env.ts";

export interface LedgerRemote {
  repo: string;
  url: string;
  username?: string;
  /** Resolved for each refresh; may reference a secret used by another consumer. */
  token?: () => string | undefined;
}

interface Receipt {
  path: string;
  last_sync?: string;
  detail: string;
}

const AUTH_FAILED = "Ledger Git authentication failed. Update its mounted credential; sync waits for that credential to change.";
const PULL_FAILED = "Ledger refresh failed. Check the configured remote and gateway filesystem; sync will retry in one minute.";

/** One gateway owns these checkouts. Readers and refreshes share its queue. */
export function createLedgerSync(root: string, remotes: readonly LedgerRemote[]) {
  const receipts = new Map<string, Receipt>();
  const rejected = new Map<string, string>();
  const abort = new AbortController();
  const owner = randomUUID();
  const lock = join(root, "ledger-sync.lock");
  let ownsLock = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  // Used by status, both ledger readers, and refresh. A checkout cannot change midway
  // through an ox read; unrelated search/chat never enters this queue.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => {
      if (stopped) throw new Error("Ledger sync stopped.");
      return work();
    });
    tail = result.catch(() => {});
    return result;
  };

  const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
    if (abort.signal.aborted) return reject(new Error("Ledger sync stopped."));
    const child = spawn("git", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const kill = () => {
      killed = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    const timeout = setTimeout(kill, 120_000);
    abort.signal.addEventListener("abort", kill, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      abort.signal.removeEventListener("abort", kill);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 1024 * 1024) kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 1024 * 1024) kill(); });
    child.once("error", () => { cleanup(); reject(new Error(PULL_FAILED)); });
    child.once("close", (code) => {
      cleanup();
      if (code === 0 && !killed) resolve(stdout.trim());
      else reject(new Error(/authentication failed|http basic: access denied|returned error: (401|403)/i.test(stderr)
        ? AUTH_FAILED : PULL_FAILED));
    });
  });

  /** Called inside exclusive(), after the gateway verifies the project's identity. */
  const pull = async (repo: string, path: string): Promise<void> => {
    const remote = remotes.find((candidate) => candidate.repo === repo);
    if (!remote || !ownsLock || stopped) throw new Error("Ledger sync has no active owner.");
    // A temporarily unreadable mount fails closed and is reread on the next tick.
    let token: string | undefined;
    try { token = remote.token?.(); } catch {
      receipts.set(repo, { path, detail: AUTH_FAILED });
      throw new Error(AUTH_FAILED);
    }
    const fingerprint = createHash("sha256").update(token ?? "").digest("hex");
    if (rejected.get(repo) === fingerprint) throw new Error(AUTH_FAILED);
    if (remote.token && !token) {
      receipts.set(repo, { path, detail: AUTH_FAILED });
      rejected.set(repo, fingerprint);
      throw new Error(AUTH_FAILED);
    }
    const env: NodeJS.ProcessEnv = {
      ...passthroughEnv(process.env), HOME: join(root, "git-home"),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_LFS_SKIP_SMUDGE: "1",
      GIT_CONFIG_COUNT: token ? "6" : "5",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "protocol.allow", GIT_CONFIG_VALUE_2: "never",
      GIT_CONFIG_KEY_3: "protocol.https.allow", GIT_CONFIG_VALUE_3: "always",
      GIT_CONFIG_KEY_4: "http.followRedirects", GIT_CONFIG_VALUE_4: "false",
    };
    if (token) {
      env.GIT_CONFIG_KEY_5 = `http.${new URL(remote.url).origin}/.extraHeader`;
      env.GIT_CONFIG_VALUE_5 = `AUTHORIZATION: Basic ${Buffer.from(`${remote.username}:${token}`).toString("base64")}`;
    }
    const stage = `${path}.stage-${owner}`;
    try {
      const exists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists) {
        await mkdir(dirname(path), { recursive: true });
        await git(["clone", "--depth=1", "--filter=blob:none", "--no-checkout", "--", remote.url, stage], root, env);
        await git(["config", "agentToolkit.ledger", "true"], stage, env);
        await git(["sparse-checkout", "set", "sessions", "data/murmurs"], stage, env);
        await git(["checkout", "--detach", "origin/HEAD"], stage, env);
        if (stopped) throw new Error("Ledger sync stopped.");
        await rename(stage, path);
      } else {
        if (await git(["config", "--get", "agentToolkit.ledger"], path, env) !== "true" ||
            await git(["remote", "get-url", "origin"], path, env) !== remote.url) {
          throw new Error("Ledger checkout is not owned by this sync configuration.");
        }
        await git(["fetch", "--depth=1", "origin", "HEAD"], path, env);
        await git(["reset", "--hard", "FETCH_HEAD"], path, env);
      }
      if (stopped) throw new Error("Ledger sync stopped.");
      rejected.delete(repo);
      receipts.set(repo, { path, last_sync: new Date().toISOString(), detail: "The gateway successfully refreshed this ledger." });
    } catch (error) {
      const detail = error instanceof Error && error.message === AUTH_FAILED ? AUTH_FAILED : PULL_FAILED;
      if (detail === AUTH_FAILED) rejected.set(repo, fingerprint);
      receipts.set(repo, { path, detail });
      throw new Error(detail);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };

  return {
    exclusive,
    pull,
    receipt: (repo: string) => receipts.get(repo),
    start: (cycle: () => Promise<void>): Promise<void> => {
      starting ??= (async () => {
        await mkdir(root, { recursive: true });
        try {
          await writeFile(lock, owner, { flag: "wx", mode: 0o600 });
          ownsLock = true;
        } catch {
          throw new Error("Ledger sync is already owned or its lock is unavailable. After a crash, verify the previous owner has stopped before removing ledger-sync.lock.");
        }
        const tick = async () => {
          if (stopped) return;
          // A failed repository must not terminate the background loop. The cycle
          // records each repository's fixed failure before returning.
          await exclusive(cycle).catch(() => {});
          if (!stopped) timer = setTimeout(() => { void tick(); }, 60_000);
        };
        await tick();
      })();
      return starting;
    },
    stop: async (): Promise<void> => {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await starting?.catch(() => {});
      await tail;
      if (ownsLock && await readFile(lock, "utf8").catch(() => "") === owner) await rm(lock);
      receipts.clear();
    },
  };
}
