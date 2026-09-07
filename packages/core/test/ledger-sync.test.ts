import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLedgerSync, type LedgerRemote } from "../src/ledger-sync.ts";

describe("gateway-owned ledger sync", () => {
  let dir: string;
  let source: string;
  let root: string;
  let checkout: string;
  let realGit: string;
  const remote = "https://git.example.test/team/ledger.git";
  const owners: ReturnType<typeof createLedgerSync>[] = [];
  const git = (...args: string[]) => execFileSync(realGit, args, { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  const owner = (token?: LedgerRemote["token"]) => {
    const sync = createLedgerSync(root, [{ repo: "service", url: remote, ...(token ? { username: "oauth2", token } : {}) }]);
    owners.push(sync);
    return sync;
  };
  const calls = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
  const commit = (text: string) => {
    writeFileSync(join(source, "sessions/one.json"), text);
    git("-C", source, "add", ".");
    git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", text);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-sync-"));
    source = join(dir, "source");
    root = join(dir, "data");
    checkout = join(root, "ledger");
    realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main", source);
    mkdirSync(join(source, "sessions"));
    mkdirSync(join(source, "data/murmurs"), { recursive: true });
    mkdirSync(join(source, "data/github"));
    writeFileSync(join(source, "data/murmurs/update.json"), "{}");
    writeFileSync(join(source, "data/github/index.json"), "{}");
    commit("first");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Only the transport is replaced. Clone, sparse checkout, fetch and reset use
    // real Git against a local repository; no test credential leaves the machine.
    writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const realGit = ${JSON.stringify(realGit)};
const source = ${JSON.stringify(source)};
const remote = ${JSON.stringify(remote)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls', JSON.stringify(args) + '\\n');
if (args[0] === 'clone' || args[0] === 'fetch') {
  if (process.env.SAGEOX_TOKEN) { process.stderr.write('unrelated gateway credential leaked'); process.exit(1); }
  if (fs.existsSync(dir + '/required-auth') && (
      process.env.GIT_CONFIG_KEY_5 !== 'http.https://git.example.test/.extraHeader' ||
      process.env.GIT_CONFIG_VALUE_5 !== fs.readFileSync(dir + '/required-auth', 'utf8'))) {
    process.stderr.write('Authentication failed'); process.exit(128);
  }
  if (fs.existsSync(dir + '/deny')) { process.stderr.write('Authentication failed: planted-secret'); process.exit(128); }
  if (fs.existsSync(dir + '/hang')) {
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    fs.writeFileSync(dir + '/child-pid', String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
}
if (args[0] === 'clone') args[args.indexOf(remote)] = 'file://' + source;
if (args[0] === 'fetch') args[args.indexOf('origin')] = 'file://' + source;
const result = spawnSync(realGit, ['-c', 'protocol.file.allow=always', ...args], {env: process.env});
if (args[0] === 'clone' && result.status === 0) {
  spawnSync(realGit, ['-C', args.at(-1), 'remote', 'set-url', 'origin', remote], {env: process.env});
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  });

  afterEach(async () => {
    await Promise.all(owners.splice(0).map((sync) => sync.stop()));
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clones only the reader data, refreshes, and verifies it again after a graceful restart", async () => {
    vi.stubEnv("SAGEOX_TOKEN", "unrelated-api-token");
    writeFileSync(join(dir, "required-auth"), `AUTHORIZATION: Basic ${Buffer.from("oauth2:reused-test-token").toString("base64")}`);
    const sync = owner(() => "reused-test-token");
    await sync.start(() => sync.pull("service", checkout));
    expect(readFileSync(join(checkout, "sessions/one.json"), "utf8")).toBe("first");
    expect(existsSync(join(checkout, "data/murmurs/update.json"))).toBe(true);
    expect(existsSync(join(checkout, "data/github/index.json"))).toBe(false);
    expect(sync.receipt("service")?.last_sync).toBeDefined();
    commit("second");
    await sync.exclusive(() => sync.pull("service", checkout));
    expect(readFileSync(join(checkout, "sessions/one.json"), "utf8")).toBe("second");
    expect(calls()).not.toMatch(/push|reused-test-token|AUTHORIZATION/);
    expect(readFileSync(join(checkout, ".git/config"), "utf8")).not.toMatch(/reused-test-token|AUTHORIZATION/);
    await sync.stop();
    rmSync(join(dir, "required-auth"));
    const restarted = owner();
    expect(restarted.receipt("service")).toBeUndefined();
    await restarted.start(() => restarted.pull("service", checkout));
    expect(restarted.receipt("service")?.last_sync).toBeDefined();
  });

  it("clears freshness after denial, pauses requests until the mounted value changes, then recovers", async () => {
    const secret = join(dir, "shared-secret");
    writeFileSync(secret, "first-token");
    writeFileSync(join(dir, "required-auth"), `AUTHORIZATION: Basic ${Buffer.from("oauth2:first-token").toString("base64")}`);
    const sync = owner(() => readFileSync(secret, "utf8"));
    await sync.start(() => sync.pull("service", checkout));
    writeFileSync(join(dir, "deny"), "");
    await expect(sync.exclusive(() => sync.pull("service", checkout))).rejects.toThrow(/authentication failed/);
    expect(sync.receipt("service")?.last_sync).toBeUndefined();
    expect(sync.receipt("service")?.detail).not.toContain("planted-secret");
    const before = calls();
    await expect(sync.exclusive(() => sync.pull("service", checkout))).rejects.toThrow(/authentication failed/);
    expect(calls()).toBe(before);
    rmSync(join(dir, "deny"));
    writeFileSync(secret, "rotated-token");
    writeFileSync(join(dir, "required-auth"), `AUTHORIZATION: Basic ${Buffer.from("oauth2:rotated-token").toString("base64")}`);
    await sync.exclusive(() => sync.pull("service", checkout));
    expect(sync.receipt("service")?.last_sync).toBeDefined();
  });

  it("keeps a configured missing credential from falling back to anonymous Git", async () => {
    const sync = owner(() => undefined);
    await sync.start(() => sync.pull("service", checkout));
    expect(calls()).toBe("");
    expect(sync.receipt("service")?.last_sync).toBeUndefined();
    expect(existsSync(checkout)).toBe(false);
  });

  it("refuses another owner and preserves the first owner's lock", async () => {
    const first = owner();
    await first.start(async () => {});
    const second = owner();
    await expect(second.start(async () => {})).rejects.toThrow(/already owned/);
    await second.stop();
    expect(existsSync(join(root, "ledger-sync.lock"))).toBe(true);
    await first.stop();
    expect(existsSync(join(root, "ledger-sync.lock"))).toBe(false);
  });

  it("never resets an existing operator-owned checkout", async () => {
    mkdirSync(root);
    git("clone", "-q", source, checkout);
    const before = git("-C", checkout, "rev-parse", "HEAD");
    commit("new upstream");
    const sync = owner();
    await sync.start(() => sync.pull("service", checkout));
    expect(sync.receipt("service")?.last_sync).toBeUndefined();
    expect(git("-C", checkout, "rev-parse", "HEAD")).toBe(before);
    expect(calls()).not.toMatch(/fetch|reset/);
  });

  it("runs periodic refresh after a failure and serializes readers with refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sync = owner();
    const cycle = vi.fn(async () => { throw new Error("temporarily unavailable"); });
    await sync.start(cycle);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cycle).toHaveBeenCalledTimes(2);
    let release!: () => void;
    const refresh = sync.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const read = vi.fn(async () => "complete snapshot");
    const result = sync.exclusive(read);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    release();
    await refresh;
    expect(await result).toBe("complete snapshot");
    await sync.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cycle).toHaveBeenCalledTimes(2);
    read.mockClear();
    await expect(sync.exclusive(read)).rejects.toThrow(/stopped/);
    expect(read).not.toHaveBeenCalled();
  });

  it("kills Git's process group on shutdown and never publishes a partial cold clone", async () => {
    writeFileSync(join(dir, "hang"), "");
    const sync = owner();
    const starting = sync.start(() => sync.pull("service", checkout));
    await vi.waitFor(() => expect(existsSync(join(dir, "child-pid"))).toBe(true), { timeout: 5000 });
    const pid = Number(readFileSync(join(dir, "child-pid"), "utf8"));
    await sync.stop();
    await starting;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(join(root, "ledger-sync.lock"))).toBe(false);
  });
});
