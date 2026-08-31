import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Vault,
  classifyVaultWriteFailure,
  VAULT_WRITE_FAILURE_TEXT,
  type VaultWriteFailure,
} from "../src/vault.ts";
import { brainServerHandler, BRAIN_TOOLS } from "../src/brain-server.ts";

let root: string;
let vault: Vault;
function ageKeyPair(): { identity: string; recipient: string } {
  const identity = execFileSync("age-keygen", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const recipient = identity.match(/^# public key: (age1\S+)$/m)?.[1];
  if (!recipient) throw new Error("age-keygen did not return a public recipient");
  return { identity, recipient };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vault-"));
  vault = new Vault(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Vault", () => {
  it("says the brain is empty rather than returning nothing", () => {
    expect(vault.list()).toEqual([]);
    expect(vault.read()).toMatch(/empty/i);
  });

  it("writes a fact with its provenance, and reads it back", () => {
    vault.write("deploys.md", "harry runs under launchd", "madhur", new Date("2026-08-13"));
    const body = readFileSync(join(root, "deploys.md"), "utf8");

    expect(body).toContain("harry runs under launchd");
    expect(body).toContain("<!-- src: madhur, 2026-08-13 -->");
    expect(vault.read("launchd")).toContain("harry runs under launchd");
  });

  it("appends rather than overwriting, so a correction is never silently erased", () => {
    vault.write("notes.md", "first", "a");
    vault.write("notes.md", "second", "b");
    const body = readFileSync(join(root, "notes.md"), "utf8");

    expect(body).toContain("first");
    expect(body).toContain("second");
  });

  it("says explicitly when nothing matches, and lists what is there", () => {
    vault.write("deploys.md", "harry runs under launchd", "madhur");
    const out = vault.read("kubernetes");

    expect(out).toMatch(/nothing in the brain matches/i);
    expect(out).toContain("deploys.md");
  });

  it("reports files that did not match, so the agent knows what it has not read", () => {
    vault.write("deploys.md", "launchd", "a");
    vault.write("people.md", "madhur owns harry", "a");
    expect(vault.read("launchd")).toContain("Not matched: people.md");
  });

  it("adds .md so a bare topic name still lands in the vault", () => {
    vault.write("people", "madhur owns harry", "a");
    expect(existsSync(join(root, "people.md"))).toBe(true);
  });

  it("finds notes in subdirectories", () => {
    vault.write("projects/toolkit.md", "ships as pnpm workspaces", "a");
    expect(vault.list()).toEqual(["projects/toolkit.md"]);
    expect(vault.read("pnpm")).toContain("ships as pnpm workspaces");
  });

  it("round-trips .md.age files without writing plaintext to disk", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });

    encrypted.write(
      "people/health.md.age",
      "allergic to penicillin",
      "clover",
      new Date("2026-08-19"),
    );
    const ciphertext = readFileSync(join(root, "people/health.md.age"), "utf8");

    expect(ciphertext).toContain("age-encryption.org/v1");
    expect(ciphertext).not.toContain("penicillin");
    expect(encrypted.list()).toEqual(["people/health.md.age"]);
    expect(encrypted.read("penicillin")).toContain("allergic to penicillin");
    expect(encrypted.read("penicillin")).toContain("<!-- src: clover, 2026-08-19 -->");
  });

  it("appends encrypted facts without losing the existing ciphertext content", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });

    encrypted.write("health.md.age", "first private fact", "a");
    encrypted.write("health.md.age", "second private fact", "b");

    expect(encrypted.read()).toContain("first private fact");
    expect(encrypted.read()).toContain("second private fact");
    expect(existsSync(join(root, "health.md.age.lock"))).toBe(false);
  });

  it("writes, reads, and appends a 16 MiB encrypted slice", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });
    const largeFact = "x".repeat(16 * 1024 * 1024);

    encrypted.write("large.md.age", largeFact, "a");
    encrypted.write("large.md.age", "tail marker", "b");

    expect(encrypted.read("tail marker")).toContain("tail marker");
  });

  it("reports the decrypt limit separately from denied identity access", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });
    expect(() =>
      encrypted.write("write-too-large.md.age", "x".repeat(32 * 1024 * 1024), "a"),
    ).toThrow(/plaintext exceeds the 32 MiB vault slice limit/);
    execFileSync(
      "age",
      ["--encrypt", "--recipient", recipient, "--output", join(root, "oversized.md.age")],
      {
        input: "x".repeat(32 * 1024 * 1024 + 1),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    expect(() => encrypted.read()).toThrow(/plaintext exceeds the 32 MiB vault slice limit/);
  });

  it("refuses an encrypted write it could never read back", () => {
    const { recipient } = ageKeyPair();
    const writeOnly = new Vault(root, { recipient });

    expect(() => writeOnly.write("health.md.age", "a private fact", "x")).toThrow(
      /age identity is not available/,
    );
    expect(existsSync(join(root, "health.md.age"))).toBe(false);
    expect(writeOnly.list()).toEqual([]);
  });

  it("refuses an encrypted write whose identity does not own the recipient", () => {
    const { recipient } = ageKeyPair();
    const stranger = ageKeyPair();
    const mismatched = new Vault(root, { recipient, identity: stranger.identity });

    expect(() => mismatched.write("health.md.age", "a private fact", "x")).toThrow(
      /not a recipient of the configured recipient/,
    );
    // The unreadable slice must not survive the failed write.
    expect(existsSync(join(root, "health.md.age"))).toBe(false);
    expect(mismatched.read()).toContain("The brain is empty");
  });

  it("denies an encrypted slice without blocking accessible vault files", () => {
    const { identity, recipient } = ageKeyPair();
    new Vault(root, { recipient, identity }).write(
      "finances.md.age",
      "account balance",
      "fiona",
    );
    vault.write("deploys.md", "ships on Tuesdays", "fiona");

    const result = new Vault(root).read();
    expect(result).toContain("ships on Tuesdays");
    expect(result).toContain("Encrypted files not inspected (access denied): finances.md.age");
    expect(result).not.toContain("account balance");
    expect(new Vault(root).read("account balance")).toContain(
      'Nothing in the brain matches "account balance"',
    );
    expect(new Vault(root).consolidate()).toContain(
      "Encrypted files not inspected (access denied): finances.md.age",
    );
    rmSync(join(root, "deploys.md"));
    expect(new Vault(root).read()).toContain("No accessible brain files could be read");
  });

  it("consolidates plaintext and encrypted notes through the same vault", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });
    encrypted.write("plain.md", "the repeated private fact", "a");
    encrypted.write("private.md.age", "the repeated private fact", "b");

    const report = encrypted.consolidate();
    expect(report).toContain("plain.md:1");
    expect(report).toContain("private.md.age:1");
  });

  it("refuses to write outside the vault", () => {
    for (const escape of ["../escaped.md", "../../etc/passwd.md", "/tmp/absolute.md"]) {
      expect(() => vault.write(escape, "x", "attacker")).toThrow(/outside the vault/);
    }
  });

  // A name that stays inside the vault can still resolve out of it. A shared vault is
  // writable by every agent in its scope, so a planted link is a reachable way to read a
  // host file through `brain_read` or to append through one.
  it("does not read a file symlinked into the vault", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.md");
    writeFileSync(outside, "SENTINEL-do-not-disclose");
    symlinkSync(outside, join(root, "innocent.md"));
    vault.write("real.md", "genuine vault content", "madhur");

    expect(vault.list()).toEqual(["real.md"]);
    expect(vault.read()).not.toContain("SENTINEL-do-not-disclose");
    expect(vault.read()).toContain("genuine vault content");
  });

  it("does not descend a directory symlinked into the vault", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.md"), "SENTINEL-do-not-disclose");
    symlinkSync(outside, join(root, "linked"));

    expect(vault.list()).toEqual([]);
    expect(vault.read()).not.toContain("SENTINEL-do-not-disclose");
  });

  it("refuses to write through a symlink planted in the vault", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "target.md");
    writeFileSync(outside, "original\n");
    symlinkSync(outside, join(root, "notes.md"));

    expect(() => vault.write("notes.md", "appended by the agent", "attacker"))
      .toThrow(/through a symlink/);
    expect(readFileSync(outside, "utf8")).toBe("original\n");
  });

  it("refuses to write through a dangling symlink, which would create the target", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "not-yet.md");
    symlinkSync(outside, join(root, "fresh.md"));

    expect(() => vault.write("fresh.md", "x", "attacker")).toThrow(/through a symlink/);
    expect(existsSync(outside)).toBe(false);
  });

  // The public paths never reach these: `list()` filters links out before a read, and
  // `write()` rejects one before the open. Both checks name a path that is opened again a
  // moment later, though, and a concurrent writer to a shared vault can swap a plain file
  // for a link in that gap — so the opens themselves have to refuse.
  it("refuses to read through a symlink swapped in after listing", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.md");
    writeFileSync(outside, "SENTINEL-do-not-disclose");
    symlinkSync(outside, join(root, "swapped.md"));
    const internals = vault as unknown as { readFile(file: string): string };

    expect(() => internals.readFile("swapped.md")).toThrow(/ELOOP|symbolic/i);
  });

  // Ciphertext encrypted for this same recipient decrypts perfectly well, so a swapped
  // `.md.age` would have disclosed an outside slice with nothing to distinguish it from
  // vault content — `age` opens the pathname, not the file that was listed.
  it("refuses to decrypt through a symlink swapped in after listing", () => {
    const { identity, recipient } = ageKeyPair();
    const encrypted = new Vault(root, { recipient, identity });
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "external.md.age");
    execFileSync("age", ["--encrypt", "--recipient", recipient, "--output", outside], {
      input: "EXTERNAL-SECRET-PLAINTEXT",
    });
    symlinkSync(outside, join(root, "swapped.md.age"));
    const internals = encrypted as unknown as { readFile(file: string): string };

    expect(() => internals.readFile("swapped.md.age")).toThrow(/not a regular vault file/);
  });

  it("refuses to append through a symlink swapped in after the check", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "target.md");
    writeFileSync(outside, "original\n");
    symlinkSync(outside, join(root, "swapped.md"));
    const internals = vault as unknown as { appendNoFollow(t: string, line: string): void };

    expect(() => internals.appendNoFollow(join(root, "swapped.md"), "appended\n"))
      .toThrow(/ELOOP|symbolic/i);
    expect(readFileSync(outside, "utf8")).toBe("original\n");
  });

  it("refuses to write into a directory symlinked out of the vault", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(root, "sub"));

    expect(() => vault.write("sub/note.md", "x", "attacker")).toThrow(/outside the vault/);
    expect(existsSync(join(outside, "note.md"))).toBe(false);
  });

  it("reports duplicate facts without modifying either file", () => {
    vault.write("one.md", "- deploys happen on Tuesdays", "a");
    vault.write("two.md", "deploys happen on Tuesdays", "b");

    const report = vault.consolidate();

    expect(report).toContain("one.md:1");
    expect(report).toContain("two.md:1");
    expect(report).toMatch(/nothing was deleted/i);
    expect(readFileSync(join(root, "one.md"), "utf8")).toContain("deploys happen on Tuesdays");
  });

  it("says when consolidation has nothing to report", () => {
    vault.write("one.md", "only one fact exists", "a");
    expect(vault.consolidate()).toMatch(/no near-duplicate/i);
  });
});

describe("what the brain is told when an encrypted write fails", () => {
  /** Runs a write that must fail, and returns the brain's error and the audit lines. */
  function failingWrite(target: Vault, file: string): { message: string; log: string } {
    const logged: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((line) => void logged.push(String(line)));
    let message: string | undefined;
    try {
      target.write(file, "a private fact", "a");
    } catch (error) {
      message = (error as Error).message;
    } finally {
      warn.mockRestore();
    }
    expect(message, `${file} must not have encrypted`).toBeDefined();
    return { message: message ?? "", log: logged.join("\n") };
  }

  it("keeps what age printed out of the brain, and puts it in the audit log", () => {
    const broken = new Vault(root, { recipient: "age1not-a-real-recipient", identity: "unused" });
    const { message, log } = failingWrite(broken, "notes.md.age");

    expect(message).toBe(
      `cannot encrypt brain file notes.md.age: ${VAULT_WRITE_FAILURE_TEXT["bad-recipient"]}`,
    );
    // The two things age's own complaint carries: the key it was handed, and the absolute
    // temp path it failed on. Neither belongs in a model's context.
    expect(message).not.toContain("age1not-a-real-recipient");
    expect(message).not.toContain(root);
    // The detail is not lost — it goes where an operator can triage it and the brain cannot.
    expect(log).toContain("vault_write_failed");
    expect(log).toContain("class=bad-recipient");
    expect(log).toContain("malformed recipient");
  });

  it("logs file and detail as escaped fields, so neither can forge one of its own", () => {
    // The same trick from both untrusted directions: age quotes the recipient back into its
    // stderr, and the file name is the brain's own words. Either could close its field early
    // and have the rest read as fields — a forged `class=` sends an operator to install a
    // binary that is already there, which is the misdirection this whole change exists to
    // stop, one layer down.
    const forge = 'age1x" class=age-unusable';
    const broken = new Vault(root, { recipient: forge, identity: "unused" });
    const { log } = failingWrite(broken, 'sneaky" class=age-unusable.md.age');

    expect(log.split("\n")).toHaveLength(1);
    // Read the line the way an operator's tooling would: two JSON strings and one bare word.
    const fields =
      /^vault_write_failed file=("(?:[^"\\]|\\.)*") class=(\S+) detail=("(?:[^"\\]|\\.)*")$/.exec(
        log,
      );
    expect(fields, log).not.toBeNull();
    const [, file, failureClass, detail] = fields!;
    expect(failureClass).toBe("bad-recipient"); // the only class on the line
    // Both forgeries survive for the operator — and inside one JSON string each.
    expect(JSON.parse(file)).toBe('sneaky" class=age-unusable.md.age');
    expect(JSON.parse(detail) as string).toContain("class=age-unusable");
  });

  it("tells an `age` it cannot run apart from a vault that refused the write", () => {
    const { recipient } = ageKeyPair(); // before PATH goes, since age-keygen needs it too
    const onlyPath = mkdtempSync(join(tmpdir(), "no-age-"));
    const previousPath = process.env.PATH;
    process.env.PATH = onlyPath;
    try {
      const noAge = new Vault(root, { recipient, identity: "unused" });
      const missing = failingWrite(noAge, "missing.md.age");

      expect(missing.message).toContain(VAULT_WRITE_FAILURE_TEXT["age-unusable"]);
      expect(missing.log).toContain("class=age-unusable");

      // There and not executable fails the same spawn with EACCES — the very code
      // `renameSync` reports for a vault that will not take the write. Reading it as the
      // vault sends an operator to the mount while the binary sits there unrunnable.
      writeFileSync(join(onlyPath, "age"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const denied = failingWrite(noAge, "denied.md.age");

      expect(denied.message).toContain(VAULT_WRITE_FAILURE_TEXT["age-unusable"]);
      expect(denied.log).toContain("class=age-unusable");
    } finally {
      process.env.PATH = previousPath;
      rmSync(onlyPath, { recursive: true, force: true });
    }
  });

  it("classifies only recognised signals, and degrades rather than misdirecting", () => {
    // Two codes, two origins each: a spawn that never happened is a binary this gateway
    // cannot run, a rename that found nothing is not, and only `syscall` separates them.
    expect(classifyVaultWriteFailure({ code: "ENOENT", syscall: "spawnSync age" })).toBe(
      "age-unusable",
    );
    expect(classifyVaultWriteFailure({ code: "EACCES", syscall: "spawnSync age" })).toBe(
      "age-unusable",
    );
    expect(classifyVaultWriteFailure({ code: "ENOENT", syscall: "rename" })).toBe("failed");
    expect(classifyVaultWriteFailure({ code: "EACCES", syscall: "rename" })).toBe(
      "vault-unwritable",
    );
    expect(classifyVaultWriteFailure({ code: "EROFS", syscall: "rename" })).toBe("vault-unwritable");
    expect(
      classifyVaultWriteFailure({
        stderr: "age: error: failed to write header: open /tmp/x.tmp: permission denied",
      }),
    ).toBe("vault-unwritable");
    expect(
      classifyVaultWriteFailure({ stderr: 'age: error: malformed recipient "age1x": bad checksum' }),
    ).toBe("bad-recipient");
    // A reworded complaint becomes "the write failed" — still true — not the wrong cause.
    expect(classifyVaultWriteFailure({ stderr: "age: error: something not seen before" })).toBe(
      "failed",
    );
    expect(classifyVaultWriteFailure({})).toBe("failed");
  });

  it("gives every class its own sentence, so they are not four names for one message", () => {
    const classes: VaultWriteFailure[] = [
      "age-unusable",
      "bad-recipient",
      "vault-unwritable",
      "failed",
    ];
    expect(new Set(classes.map((name) => VAULT_WRITE_FAILURE_TEXT[name])).size).toBe(
      classes.length,
    );
  });
});

describe("brain MCP server", () => {
  const call = (name: string, args: Record<string, string> = {}) =>
    brainServerHandler(vault)({
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }) as Promise<{ content: Array<{ text: string }> }>;

  it("advertises the same tool names as the reference brain-notes server", async () => {
    const listed = (await brainServerHandler(vault)({ id: 1, method: "tools/list" })) as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.map((t) => t.name)).toEqual([
      "brain_list",
      "brain_read",
      "brain_write",
      "brain_consolidate",
    ]);
    expect(BRAIN_TOOLS.length).toBe(4);
  });

  it("initializes with the MCP protocol version", async () => {
    const init = (await brainServerHandler(vault)({ id: 1, method: "initialize" })) as {
      protocolVersion: string;
    };
    expect(init.protocolVersion).toBe("2024-11-05");
  });

  it("round-trips write then read through the tool surface", async () => {
    await call("brain_write", { file: "deploys.md", markdown: "runs under launchd", src: "session" });
    expect((await call("brain_read", { query: "launchd" })).content[0].text).toContain("launchd");
  });

  it("exposes report-only consolidation through MCP", async () => {
    await call("brain_write", { file: "a.md", markdown: "the repeated useful fact", src: "a" });
    await call("brain_write", { file: "b.md", markdown: "the repeated useful fact", src: "b" });
    expect((await call("brain_consolidate")).content[0].text).toContain("duplicate group");
  });

  it("reports an unknown tool as an error rather than pretending", async () => {
    await expect(call("brain_delete_everything")).rejects.toThrow(/unknown tool/);
  });

  it("stays silent on notifications, which expect no reply", async () => {
    expect(await brainServerHandler(vault)({ method: "notifications/initialized" })).toBeUndefined();
  });
});
