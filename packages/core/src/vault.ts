import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname, relative, resolve, sep } from "node:path";

export interface VaultAgeConfig {
  /** Public recipient written to the manifest. */
  recipient: string;
  /** Optional secret identity resolved by the gateway, never written to the manifest. */
  identity?: string;
}

const MAX_DECRYPTED_BYTES = 32 * 1024 * 1024;
/** Absent on Windows, where 0 leaves the open unrestricted rather than failing it. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

class EncryptedVaultAccessError extends Error {}

/**
 * A markdown vault: the storage behind the `local` and `shared` brains.
 *
 * Plain files on purpose. At this scale grep over markdown beats a retrieval layer, and
 * the files stay human-readable — you can open what your agent believes, correct a wrong
 * belief before it compounds, and keep the history in git. A store only the agent can
 * query gives up all of that.
 */
export class Vault {
  constructor(
    private root: string,
    private age?: VaultAgeConfig,
  ) {}

  /** File names only — the cheap first step before pulling bodies in. */
  list(): string[] {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // A symlink is not vault content, whatever it is named. `readdirSync` reports the
        // link rather than its target, so skipping here keeps a linked `.md` out of every
        // read and stops the walk from descending a linked directory — either one would
        // otherwise hand `brain_read` a file from outside the vault.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".md") || entry.name.endsWith(".md.age")) {
          out.push(relative(this.root, full));
        }
      }
    };
    walk(this.root);
    return out.sort();
  }

  /**
   * Every file whose name or body matches, plus an explicit note for what did not.
   *
   * Saying "nothing matched" out loud matters: an agent that gets an empty result cannot
   * tell "the brain has nothing" from "the brain is broken", and will happily invent the
   * difference.
   */
  read(query?: string): string {
    const files = this.list();
    if (files.length === 0) return "The brain is empty — nothing has been written yet.";

    const needle = query?.toLowerCase().trim();
    const sections: string[] = [];
    const misses: string[] = [];
    const inaccessible: string[] = [];

    for (const file of files) {
      let body: string;
      try {
        body = this.readFile(file);
      } catch (error) {
        if (!(error instanceof EncryptedVaultAccessError)) throw error;
        inaccessible.push(file);
        continue;
      }
      const hit =
        !needle || file.toLowerCase().includes(needle) || body.toLowerCase().includes(needle);
      if (hit) sections.push(`## ${file}${needle ? "  (matched)" : ""}\n${body.trim()}`);
      else misses.push(file);
    }

    const denied = inaccessible.length
      ? `\n\nEncrypted files not inspected (access denied): ${inaccessible.join(", ")}`
      : "";
    if (sections.length === 0) {
      const empty = needle
        ? `Nothing in the brain matches "${query}".`
        : "No accessible brain files could be read.";
      return `${empty} Files present: ${files.join(", ")}${denied}`;
    }
    const tail = misses.length ? `\n\nNot matched: ${misses.join(", ")}` : "";
    return sections.join("\n\n") + tail + denied;
  }

  /**
   * Appends one fact with its provenance.
   *
   * Append rather than replace, and always with a source: a brain entry whose origin is
   * unknown cannot be judged later, and an agent that can overwrite silently can erase a
   * correction a human made.
   */
  write(file: string, markdown: string, src: string, today = new Date()): string {
    const target = this.safePath(file);
    mkdirSync(dirname(target), { recursive: true });
    this.assertNoSymlinkEscape(target);

    const stamp = today.toISOString().slice(0, 10);
    const line = `${markdown.trim()}  <!-- src: ${src}, ${stamp} -->\n`;
    if (target.endsWith(".md.age")) {
      this.withLock(target, () => {
        const creating = !existsSync(target);
        const existing = creating ? "" : this.decrypt(target);
        this.encrypt(target, existing + line);
        // An append already proved the pair by decrypting the file it is extending, but a
        // create has proved nothing: an identity that does not own the configured recipient
        // encrypts happily and only fails on every read afterwards. Prove the new slice is
        // readable, and leave nothing behind when it is not.
        if (creating) this.assertReadable(target);
      });
    } else this.appendNoFollow(target, line);

    return relative(this.root, target);
  }

  /**
   * Reports repeated facts for review, without deleting or rewriting anything.
   *
   * Shared memory compounds mistakes across every agent in its scope, so consolidation
   * is deliberately a human-readable report rather than an automatic cleanup pass.
   */
  consolidate(): string {
    const seen = new Map<string, Array<{ file: string; line: number; original: string }>>();
    const inaccessible: string[] = [];

    for (const file of this.list()) {
      let body: string;
      try {
        body = this.readFile(file);
      } catch (error) {
        if (!(error instanceof EncryptedVaultAccessError)) throw error;
        inaccessible.push(file);
        continue;
      }
      const lines = body.split(/\r?\n/);
      lines.forEach((original, index) => {
        const normalized = original
          .replace(/<!--.*?-->/g, "")
          .replace(/^[\s\-*#>]+/, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        if (normalized.length < 8) return;
        const hits = seen.get(normalized) ?? [];
        hits.push({ file, line: index + 1, original: original.trim() });
        seen.set(normalized, hits);
      });
    }

    const duplicates = [...seen.entries()].filter(([, hits]) => hits.length > 1);
    const denied = inaccessible.length
      ? ` Encrypted files not inspected (access denied): ${inaccessible.join(", ")}.`
      : "";
    if (!duplicates.length) {
      return `No near-duplicate lines found. Nothing was changed.${denied}`;
    }

    const sections = duplicates.map(
      ([normalized, hits]) =>
        `## "${normalized}"\n` +
        hits.map((hit) => `- ${hit.file}:${hit.line}: ${hit.original}`).join("\n"),
    );
    return [
      `# Consolidate report (${duplicates.length} duplicate group(s))`,
      "",
      "Report only — nothing was deleted. Review and deduplicate by hand.",
      ...(inaccessible.length
        ? [`Encrypted files not inspected (access denied): ${inaccessible.join(", ")}.`]
        : []),
      "",
      ...sections,
    ].join("\n");
  }

  /**
   * Keeps a path inside the vault.
   *
   * The file name reaches this from a tool call the model composed, which may itself be
   * repeating something a stranger wrote in a channel — so `../../.ssh/authorized_keys`
   * is a request that will eventually arrive.
   */
  private safePath(file: string): string {
    const named = file.endsWith(".md") || file.endsWith(".md.age") ? file : `${file}.md`;
    const target = resolve(this.root, named);
    const rootResolved = resolve(this.root);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new Error(`refusing to write outside the vault: ${file}`);
    }
    return target;
  }

  /**
   * The other half of `safePath`: a name that stays inside the vault can still resolve out
   * of it.
   *
   * `safePath` strips `..` textually and follows nothing, while `mkdirSync` and `age` both
   * follow symlinks. A shared vault is writable by every agent in its scope, so a link
   * planted there — as a file, or as a directory on the way to one — is how a write ends up
   * outside. Called after `mkdirSync`, so the directory exists even though the file may
   * not. `appendNoFollow` closes the same hole for the last component at the open itself;
   * this is what covers the directories above it, and gives a legible error either way.
   */
  private assertNoSymlinkEscape(target: string): void {
    const root = realpathSync(this.root);
    const parent = realpathSync(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep)) {
      throw new Error(`refusing to write outside the vault: ${relative(this.root, target)}`);
    }
    // `throwIfNoEntry: false` rather than `existsSync`, which follows the link and so
    // reports a dangling one as absent — the case that would then be created outside.
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${relative(this.root, target)}`);
    }
  }

  private readFile(file: string): string {
    const target = join(this.root, file);
    return target.endsWith(".md.age") ? this.decrypt(target) : this.readNoFollow(target);
  }

  /**
   * Opening and checking as one operation, because they are otherwise two moments.
   *
   * `list()` skips symlinks and `assertNoSymlinkEscape` rejects them, but both check a
   * pathname that is then opened again later — and a shared vault is writable by every
   * agent in its scope, so a concurrent writer can swap a plain file for a link in the
   * gap. `O_NOFOLLOW` refuses at the open itself, which no swap can get in front of.
   *
   * This covers the last path component. A link swapped into a parent directory is beyond
   * what Node exposes without `openat`, and is left to `assertNoSymlinkEscape`.
   */
  private readNoFollow(target: string): string {
    const fd = openSync(target, constants.O_RDONLY | NO_FOLLOW);
    try {
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  /** The write half of `readNoFollow`: create or append, never through a link. */
  private appendNoFollow(target: string, line: string): void {
    // 0o666 so the umask decides, matching what `writeFileSync` would have created. A
    // shared vault is read by other agents, which may not share this one's uid.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW;
    const fd = openSync(target, flags, 0o666);
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }

  /** Decrypts without ever placing the identity in argv, env, or a plaintext temp file. */
  private decrypt(target: string): string {
    if (!this.age?.identity) {
      throw new EncryptedVaultAccessError(
        `cannot read encrypted brain file ${relative(this.root, target)}: age identity is not available`,
      );
    }
    // `age` would open the pathname itself, and the last component can change between the
    // listing and this call — a link to ciphertext encrypted for this same recipient
    // decrypts perfectly well, so the substitution would be invisible. Open it here under
    // O_NOFOLLOW and hand the child that descriptor as fd 3 instead: the identity still has
    // stdin, and no later swap can reach the file this reads.
    let fd: number;
    try {
      fd = openSync(target, constants.O_RDONLY | NO_FOLLOW);
    } catch {
      throw new EncryptedVaultAccessError(
        `cannot read encrypted brain file ${relative(this.root, target)}: not a regular vault file`,
      );
    }
    try {
      return execFileSync("age", ["--decrypt", "--identity", "-", "/dev/fd/3"], {
        input: this.age.identity.endsWith("\n") ? this.age.identity : `${this.age.identity}\n`,
        encoding: "utf8",
        maxBuffer: MAX_DECRYPTED_BYTES,
        // Denial is an expected, reported outcome, so keep age's complaint out of the
        // gateway's own stderr.
        stdio: ["pipe", "pipe", "pipe", fd],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error(
          `cannot decrypt brain file ${relative(this.root, target)}: plaintext exceeds the 32 MiB vault slice limit`,
        );
      }
      throw new EncryptedVaultAccessError(
        `cannot decrypt brain file ${relative(this.root, target)}: the age identity is missing, invalid, or not a recipient`,
      );
    } finally {
      closeSync(fd);
    }
  }

  /** Discards a slice this vault cannot read back, so a failed write leaves no memory. */
  private assertReadable(target: string): void {
    try {
      this.decrypt(target);
    } catch {
      rmSync(target, { force: true });
      throw new Error(
        `cannot write encrypted brain file ${relative(this.root, target)}: ` +
          "the configured age identity is not a recipient of the configured recipient",
      );
    }
  }

  /** Encrypts from memory and atomically swaps ciphertext into place. */
  private encrypt(target: string, plaintext: string): void {
    // The identity is required to write, not just to read. Encrypting to a recipient this
    // vault cannot decrypt would report a durable memory it can never read back, and the
    // append after it would fail anyway once the file exists — so refuse the first one.
    if (!this.age?.identity) {
      throw new EncryptedVaultAccessError(
        `cannot write encrypted brain file ${relative(this.root, target)}: age identity is not available`,
      );
    }
    if (Buffer.byteLength(plaintext) > MAX_DECRYPTED_BYTES) {
      throw new Error(
        `cannot encrypt brain file ${relative(this.root, target)}: plaintext exceeds the 32 MiB vault slice limit`,
      );
    }

    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      execFileSync("age", ["--encrypt", "--recipient", this.age.recipient, "--output", temp], {
        input: plaintext,
        stdio: ["pipe", "pipe", "pipe"],
      });
      chmodSync(temp, 0o600);
      renameSync(temp, target);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
      const said = failure.stderr?.toString() ?? "";
      throw vaultWriteFailed(
        relative(this.root, target),
        classifyVaultWriteFailure({ code: failure.code, syscall: failure.syscall, stderr: said }),
        // `execFileSync`'s own message is the whole command line, temp path included, so it
        // is no safer to replay than stderr is — both go to the log, neither to the brain.
        said || failure.message,
      );
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** Serializes encrypted read-modify-write cycles across agents sharing one vault. */
  private withLock<T>(target: string, run: () => T): T {
    const lock = `${target}.lock`;
    const deadline = Date.now() + 5_000;
    const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;

    for (;;) {
      try {
        writeFileSync(lock, owner, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        // A shared mount may span hosts or PID namespaces, so neither age nor a local PID
        // proves that the owner is dead. Fail safely and leave explicit recovery to an
        // operator who can verify the owner has stopped.
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting to write encrypted brain file ${relative(this.root, target)}; ` +
              `verify the lock owner has stopped before removing ${relative(this.root, lock)}`,
          );
        }
        Atomics.wait(LOCK_WAIT, 0, 0, 25);
      }
    }

    try {
      return run();
    } finally {
      try {
        if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * Why an encrypted write failed — a closed vocabulary, never the text `age` printed.
 *
 * There is more than one class because each sends a human somewhere different: a bad
 * recipient is a manifest to correct, an `age` this gateway cannot run is an image built
 * wrong, and an unwritable vault is a mount or a full disk. "The write failed" covers none
 * of them.
 */
export type VaultWriteFailure = "age-unusable" | "bad-recipient" | "vault-unwritable" | "failed";

/**
 * What the brain is told for each class: **a fixed string, never interpolated.**
 *
 * `age`'s stderr is on a path that ends in the model's context — `brain_write` returns this
 * message as its tool error — and it carries things that have no business going there:
 * "failed to write header" quotes the absolute temp path, "malformed recipient" quotes the
 * configured key back. `decrypt` above already answers this way, with a fixed string per
 * class; this is the same rule on the write side, and the same one `GuardVerdict.reason`
 * and `OX_FAILURE_TEXT` hold elsewhere.
 */
export const VAULT_WRITE_FAILURE_TEXT: Record<VaultWriteFailure, string> = {
  "age-unusable":
    "this gateway cannot run `age` — it is missing from PATH, or there and not executable — " +
    "so encrypted memory cannot be written at all. A human has to fix it",
  "bad-recipient":
    "the configured age recipient is not a usable public key. Writing again will not help — " +
    "a human has to correct it",
  "vault-unwritable":
    "the vault would not take the write — it may be read-only, out of space, or missing. A " +
    "human has to fix it; writing again will not",
  failed:
    "the encrypted brain file could not be written. Why is in the gateway log, which you " +
    "cannot see — say the write failed rather than guessing a reason",
};

/**
 * Which class a failed `age --encrypt` belongs to.
 *
 * Classification runs the safe way round: only a recognised signal becomes a specific
 * class, and anything else degrades to `failed` — still true — rather than sending a human
 * after the wrong cause. If `age` rewords its complaints, this loses precision and nothing
 * else.
 */
export function classifyVaultWriteFailure(e: {
  code?: string;
  syscall?: string;
  stderr?: string;
}): VaultWriteFailure {
  // A child that never ran, whatever stopped it: `age` absent, or there and not executable.
  // Checked before the filesystem codes because a failed spawn reports ENOENT and EACCES
  // exactly as `renameSync` does — `syscall` is the only thing separating a binary this
  // gateway cannot run from a vault it cannot write, and those send a human to two places.
  if (e.syscall?.startsWith("spawn")) return "age-unusable";
  // From `chmodSync`/`renameSync`. A non-zero `age` carries no code at all, so the same
  // conditions arrive below as its own prose instead.
  if (e.code === "EACCES" || e.code === "EROFS" || e.code === "ENOSPC") return "vault-unwritable";
  const said = e.stderr ?? "";
  if (/\bmalformed recipient\b/.test(said)) return "bad-recipient";
  if (/\bfailed to write\b/.test(said)) return "vault-unwritable";
  return "failed";
}

/**
 * The two halves of a failed encrypted write, together so neither can be raised without
 * the other: a fixed string for the brain, and the detail on the gateway's own log, which
 * the brain never reads. Same split `oxFailed` makes in `team-server.ts`.
 */
function vaultWriteFailed(file: string, failure: VaultWriteFailure, detail: string): Error {
  // Collapsed and bounded so the line stays readable, then quoted as JSON so neither field
  // can end early: a `"` in age's output — or in a file name, which is the brain's own
  // words — would otherwise let the rest read as fields of its own, and a forged `class=`
  // sends an operator after exactly the wrong cause. Detail last: it is the free text here.
  const one = detail.replace(/\s+/g, " ").trim().slice(0, 500);
  console.warn(
    `vault_write_failed file=${JSON.stringify(file)} class=${failure} ` +
      `detail=${JSON.stringify(one || "none")}`,
  );
  return new Error(`cannot encrypt brain file ${file}: ${VAULT_WRITE_FAILURE_TEXT[failure]}`);
}
