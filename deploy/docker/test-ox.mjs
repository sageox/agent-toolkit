// Offline compatibility smoke test for the binary installed by the runtime Dockerfile.
// Synthetic on-disk inputs, real command output; no daemon, credentials, or API access.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ox-compat-"));
const repo = join(root, "repo");
const env = {
  PATH: process.env.PATH,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  OX_PROJECT_ROOT: repo,
  OX_NO_DAEMON: "1",
  SAGEOX_DAEMON: "false",
  CI: "true",
};
const ledger = join(env.XDG_DATA_HOME, "sageox/sageox.ai/ledgers/repo_fixture");

function run(binary, args, extraEnv = {}) {
  const result = spawnSync(binary, args, {
    cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} ${args.join(" ")}: ${result.stderr}`);
  return result;
}

function ox(args, extraEnv) {
  const result = run("ox", args, extraEnv);
  // In particular, code insights can exit zero while warning about failed sections.
  assert.equal(result.stderr.trim(), "", `ox ${args.join(" ")} emitted diagnostics`);
  return JSON.parse(result.stdout);
}

try {
  mkdirSync(join(repo, ".sageox"), { recursive: true });
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(repo, ".sageox/config.json"), JSON.stringify({
    repo_id: "repo_fixture", team_id: "team_fixture", team_name: "Fixture team",
    endpoint: "https://sageox.ai",
  }));
  run("git", ["init", "-q", "--initial-branch=main", repo]);
  run("git", ["init", "-q", "--initial-branch=main", ledger]);

  const status = ox(["status", "--json"]);
  assert.equal(status.auth.authenticated, false);
  assert.equal(status.config.auth_file, join(env.XDG_CONFIG_HOME, "sageox/auth.json"));
  assert.equal(status.ledger.configured, true);
  assert.equal(status.ledger.exists, true);
  assert.equal(status.ledger.path, ledger);
  assert.deepEqual(ox(["team", "list", "--json"]).teams, []);
  mkdirSync(join(env.XDG_DATA_HOME, "sageox/sageox.ai/teams/team_fixture"), { recursive: true });
  const teams = ox(["team", "list", "--json"]);
  assert.equal(teams.primary_team, "team_fixture");
  assert.equal(teams.teams.length, 1);
  assert.equal(teams.teams[0].team_id, "team_fixture");
  assert.equal(teams.teams[0].name, "Fixture team");

  const at = new Date(Date.now() - 60_000).toISOString();
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const until = new Date().toISOString();
  const name = `${at.slice(0, 16).replace(":", "-")}-fixture-OxTEST`;
  for (const populated of [false, true]) {
    if (populated) {
      mkdirSync(join(ledger, "sessions", name), { recursive: true });
      writeFileSync(join(ledger, "sessions", name, "meta.json"), JSON.stringify({
        version: "1.0", session_name: name, created_at: at, username: "fixture",
        title: "Compatibility fixture", summary: "Validate the pinned CLI", entry_count: 2,
      }));
    }
    // Match runOx's explicit session context, including both empty and populated ledgers.
    const sessions = ox(["session", "list", "--json", "--limit", "5"], { AGENT_ENV: "claude-code" });
    assert.equal(sessions.repo_id, "repo_fixture");
    assert.equal(sessions.ledger_available, true);
    assert.equal(sessions.total, Number(populated));
    assert.equal(sessions.sessions.length, Number(populated));
    if (populated) {
      const session = sessions.sessions[0];
      assert.equal(session.name, name);
      for (const field of ["date", "time", "status", "user", "title", "summary", "hydration_status"]) {
        assert.equal(typeof session[field], "string", `session.${field}`);
      }
      assert.equal(session.entry_count, 2);
    }

    const activity = ox(["glance", "--since", since, "--until", until, "--json"]);
    assert.equal(activity.repo, "repo");
    assert.equal(Date.parse(activity.since), Date.parse(since));
    assert.equal(Date.parse(activity.until), Date.parse(until));
    assert.equal(activity.authors.length, Number(populated));
    assert.equal(activity.stats.total_authors, Number(populated));
    assert.equal(activity.stats.total_murmurs, 0);
    assert.equal(activity.stats.total_sessions ?? 0, Number(populated));
    if (populated) {
      assert.equal(activity.authors[0].murmurs, null);
      const [session] = activity.authors[0].sessions;
      assert.equal(session.name, name);
      assert.equal(session.user, "fixture");
      assert.equal(typeof session.title, "string");
      assert.ok(Date.parse(session.time) >= Date.parse(since) && Date.parse(session.time) <= Date.parse(until));
    }
  }

  writeFileSync(join(repo, "main.go"), "package fixture\nfunc ScheduledWorkspaceMarker() string { return \"warm\" }\n");
  run("git", ["add", "."]);
  run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Index fixture"]);
  run("ox", ["index", "code", "--json"]);
  const codeStatus = ox(["code", "status", "--json"]);
  assert.equal(codeStatus.index_exists, true);
  assert.ok(codeStatus.commits > 0);
  const insights = ox(["code", "insights", "--json", "--days", "14", "--limit", "10"]);
  assert.ok(insights.recent_commits.some((commit) => commit.message === "Index fixture"));
  for (const key of Object.keys(insights)) {
    assert.ok(["hotspots", "recent_commits", "open_prs", "open_issues", "contention", "guidance", "hints"].includes(key),
      `unexpected code insights field: ${key}`);
  }
  for (const commit of insights.recent_commits) {
    for (const field of ["hash", "author", "message", "age"]) {
      assert.equal(typeof commit[field], "string", `recent_commits.${field}`);
    }
    assert.ok(commit.files == null || (Array.isArray(commit.files) && commit.files.every((file) => typeof file === "string")));
  }
  for (const hotspot of insights.hotspots ?? []) {
    assert.equal(typeof hotspot.path, "string");
    assert.ok(Number.isInteger(hotspot.changes) && hotspot.changes >= 0);
  }
  // The writer and search print progress/timing on stderr; their consumers use exit status.
  const search = run("ox", ["code", "search", "ScheduledWorkspaceMarker", "--json", "--limit", "5"]);
  assert.match(search.stdout, /ScheduledWorkspaceMarker/);
  console.log("ox compatibility passed: status, team list, session list, glance, code insights and search");
} finally {
  rmSync(root, { recursive: true, force: true });
}
