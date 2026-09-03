import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiringSoon, credentialSource, oxStatus, oxTeams } from "../src/ox.ts";

/** Puts an `ox` on PATH that prints `stdout` whatever it is asked. */
const withFakeOx = async <T>(stdout: string, run: () => Promise<T>): Promise<T> => {
  const bin = mkdtempSync(join(tmpdir(), "ox-fake-"));
  writeFileSync(join(bin, "ox"), `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return await run();
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
};

describe("expiringSoon", () => {
  const now = new Date("2026-08-14T00:00:00Z");

  it("flags a token that expires within the hour", () => {
    expect(expiringSoon("2026-08-14T00:30:00Z", now)).toBe(true);
  });

  it("flags one that already expired", () => {
    expect(expiringSoon("2026-08-13T23:00:00Z", now)).toBe(true);
  });

  it("accepts one with hours left", () => {
    expect(expiringSoon("2026-08-14T06:00:00Z", now)).toBe(false);
  });

  it("says nothing when ox reports no expiry, rather than guessing", () => {
    expect(expiringSoon(undefined, now)).toBe(false);
    expect(expiringSoon("not-a-date", now)).toBe(false);
  });
});

describe("credential source reporting", () => {
  it("names the token when the child carried one, since a PAT carries no user claims", () => {
    expect(credentialSource({ SAGEOX_TOKEN: "oxp_x" })).toBe("SAGEOX_TOKEN");
  });

  it("reports the auth file when the child carried no token", () => {
    expect(credentialSource({})).toBe("auth file");
  });

  it("prefers the token even when an auth file is also configured, as ox does", () => {
    expect(credentialSource({ SAGEOX_TOKEN: "oxp_x", XDG_CONFIG_HOME: "/mnt/secrets-store/ox" })).toBe(
      "SAGEOX_TOKEN",
    );
  });

  it("labels the run from the env the child got, not from a second reading", async () => {
    // `OxScope.token` reads a file that a rotation rewrites under this process — that is
    // the point of resolving it per child — so a reading taken after `ox status` exits can
    // disagree with the one that built its env, and `doctor` would then name a credential
    // the run never used. One reading, and the label comes off the env it produced.
    let reads = 0;
    const status = await withFakeOx(JSON.stringify({ auth: { authenticated: true } }), () =>
      oxStatus({ token: () => (reads++ === 0 ? "oxp_x" : undefined) }),
    );

    expect(status.source).toBe("SAGEOX_TOKEN");
    expect(reads).toBe(1);
  });
});

/**
 * `ox team list` reports a restore's `<team-id>.bak.<epoch>` clone as a team. It is not one
 * anybody can pick — its id is a directory name, so choosing it writes a string into the
 * manifest that no deployment resolves — and on a machine that has been restored a few
 * times they outnumber the real teams on the menu.
 */
describe("the teams this machine can see", () => {
  const listing = JSON.stringify({
    primary_team: "team_jihjpfkt8b",
    teams: [
      { team_id: "team_xlcr6yzpec", name: "SageOx Internal" },
      { team_id: "team_jihjpfkt8b.bak.1787702665" },
      { team_id: "team_jihjpfkt8b", name: "SageOx" },
      { team_id: "team_zixrnfjrv2.bak.1787702673" },
    ],
  });

  it("drops restore clones and puts the primary team first", async () => {
    const teams = await withFakeOx(listing, () => oxTeams());

    expect(teams.map((t) => t.id)).toEqual(["team_jihjpfkt8b", "team_xlcr6yzpec"]);
  });

  it("keeps a team whose own name merely contains the word", async () => {
    const teams = await withFakeOx(
      JSON.stringify({ teams: [{ team_id: "team_bak99", name: "Backups" }] }),
      () => oxTeams(),
    );

    expect(teams.map((t) => t.id)).toEqual(["team_bak99"]);
  });

  it("answers with an empty list rather than throwing when ox cannot be read", async () => {
    expect(await withFakeOx("not json at all", () => oxTeams())).toEqual([]);
  });
});
