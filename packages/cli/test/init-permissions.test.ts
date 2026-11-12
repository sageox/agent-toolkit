import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgentDir } from "../src/home.ts";
import { upsertEnv } from "../src/init.ts";

vi.mock("node:fs", { spy: true });
const realFs = await vi.importActual<typeof fs>("node:fs");

describe.skipIf(process.platform === "win32")("host-side credential permissions", () => {
  let root: string;
  let envPath: string;
  let previousUmask: number;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "agent-permissions-"));
    envPath = join(root, ".env");
    previousUmask = process.umask(0);
    vi.stubEnv("AGENT_TOOLKIT_HOME", root);
  });

  afterEach(() => {
    process.umask(previousUmask);
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([0o000, 0o022])("creates .env privately even with umask %s", (umask) => {
    process.umask(umask);
    vi.mocked(fs.fchmodSync).mockImplementationOnce((fd, mode) => {
      // Observe creation permissions before chmod can hide an insecure initial mode.
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(envPath, "utf8")).toBe("");
      realFs.fchmodSync(fd, mode);
    });

    expect(upsertEnv(envPath, "TOKEN", "secret")).toBe("written");
    expect(fs.openSync).toHaveBeenCalledWith(envPath, "a", 0o600);
    expect(fs.fchmodSync).toHaveBeenCalledOnce();
    expect(fs.readFileSync(envPath, "utf8")).toBe("TOKEN=secret\n");
    const fd = vi.mocked(fs.openSync).mock.results[0].value;
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
    expect(() => fs.fstatSync(fd)).toThrow();
  });

  it.each(["", "OTHER=kept", "OTHER=kept\n"])(
    "restricts a permissive existing file before appending to %j",
    (existing) => {
      fs.writeFileSync(envPath, existing, { mode: 0o644 });
      vi.clearAllMocks();
      vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data, options) => {
        expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
        realFs.appendFileSync(file, data, options);
      });

      expect(upsertEnv(envPath, "TOKEN", "secret")).toBe("written");
      expect(fs.appendFileSync).toHaveBeenCalledOnce();
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      expect(fs.readFileSync(envPath, "utf8")).toBe(`${existing}${prefix}TOKEN=secret\n`);
    },
  );

  it("keeps an existing credential without opening it for writing", () => {
    fs.writeFileSync(envPath, "TOKEN=original\n", { mode: 0o600 });
    vi.clearAllMocks();

    expect(upsertEnv(envPath, "TOKEN", "replacement")).toBe("kept");
    expect(fs.readFileSync(envPath, "utf8")).toBe("TOKEN=original\n");
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it("fails closed and closes the descriptor if setting permissions fails", () => {
    fs.writeFileSync(envPath, "OTHER=kept\n", { mode: 0o644 });
    vi.clearAllMocks();
    const failure = new Error("permission change failed");
    vi.mocked(fs.fchmodSync).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => upsertEnv(envPath, "TOKEN", "secret")).toThrow(failure);
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(envPath, "utf8")).toBe("OTHER=kept\n");
    const fd = vi.mocked(fs.openSync).mock.results[0].value;
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
    expect(() => fs.fstatSync(fd)).toThrow();
  });

  it("closes the descriptor if writing fails", () => {
    const failure = new Error("write failed");
    vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => upsertEnv(envPath, "TOKEN", "secret")).toThrow(failure);
    const fd = vi.mocked(fs.openSync).mock.results[0].value;
    expect(fs.closeSync).toHaveBeenCalledWith(fd);
    expect(() => fs.fstatSync(fd)).toThrow();
  });

  it("creates private agent directories and restricts existing ones", () => {
    const dir = ensureAgentDir("demo");
    expect(fs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    fs.chmodSync(dir, 0o755);
    expect(ensureAgentDir("demo")).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
