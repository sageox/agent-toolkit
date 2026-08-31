import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSecret } from "../src/secrets.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveSecret", () => {
  it("prefers a file over env", () => {
    writeFileSync(join(dir, "TOKEN"), "from-file\n");
    expect(resolveSecret("TOKEN", { dir, env: { TOKEN: "from-env" } })).toBe("from-file");
  });
  it("falls back to env when no file", () => {
    expect(resolveSecret("TOKEN", { dir, env: { TOKEN: "from-env" } })).toBe("from-env");
  });
  it("does not resolve a secret through a symbolic link", () => {
    const external = join(dir, "external");
    writeFileSync(external, "from-link");
    symlinkSync(external, join(dir, "TOKEN"));
    expect(resolveSecret("TOKEN", { dir, env: { TOKEN: "from-env" } })).toBe("from-env");
  });
  it("returns undefined when neither exists", () => {
    expect(resolveSecret("MISSING", { dir, env: {} })).toBeUndefined();
  });
  it("rejects path-like secretRefs before reading outside the mount", () => {
    expect(() => resolveSecret("../TOKEN", { dir, env: {} })).toThrow(/invalid secretRef/);
  });

  describe("more than one directory", () => {
    let second: string;
    beforeEach(() => {
      second = mkdtempSync(join(tmpdir(), "sec2-"));
    });
    afterEach(() => {
      rmSync(second, { recursive: true, force: true });
    });

    it("searches them in order and takes the first file", () => {
      writeFileSync(join(dir, "TOKEN"), "job-mount");
      writeFileSync(join(second, "TOKEN"), "agent-mount");
      expect(resolveSecret("TOKEN", { dir: [dir, second], env: {} })).toBe("job-mount");
      // Order is the whole of the rule, so the reverse has to answer the other way.
      expect(resolveSecret("TOKEN", { dir: [second, dir], env: {} })).toBe("agent-mount");
    });

    it("keeps looking past a directory that does not have it", () => {
      // The case the second mount exists for: a credential in one mount and not the other.
      // A search that stopped at the first miss would fail a ref the caller can reach.
      writeFileSync(join(second, "TOKEN"), "agent-mount");
      expect(resolveSecret("TOKEN", { dir: [dir, second], env: {} })).toBe("agent-mount");
    });

    it("falls back to env once, after every directory", () => {
      expect(resolveSecret("TOKEN", { dir: [dir, second], env: { TOKEN: "from-env" } })).toBe(
        "from-env",
      );
      expect(resolveSecret("MISSING", { dir: [dir, second], env: {} })).toBeUndefined();
    });

    it("is the same thing as one directory, said longer", () => {
      writeFileSync(join(dir, "TOKEN"), "from-file");
      expect(resolveSecret("TOKEN", { dir: [dir], env: { TOKEN: "e" } })).toBe(
        resolveSecret("TOKEN", { dir, env: { TOKEN: "e" } }),
      );
      // Including the symlink refusal, which is a property of each directory and not of
      // the search: a link in the first must not be followed just because a second exists.
      const external = join(dir, "external");
      writeFileSync(external, "from-link");
      symlinkSync(external, join(dir, "LINKED"));
      expect(resolveSecret("LINKED", { dir: [dir, second], env: {} })).toBeUndefined();
    });
  });
});
