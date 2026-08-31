import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiringSoon, credentialSource, oxTeams } from "../src/ox.ts";

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
  it("names the token when one was supplied, since a PAT carries no user claims", () => {
    expect(credentialSource({ token: "oxp_x" })).toBe("SAGEOX_TOKEN");
  });

  it("reports the auth file when no token was supplied", () => {
    expect(credentialSource({})).toBe("auth file");
  });

  it("prefers the token even when an auth file is also configured, as ox does", () => {
    expect(credentialSource({ token: "oxp_x", configHome: "/mnt/secrets-store/ox" })).toBe("SAGEOX_TOKEN");
  });
});

/**
 * `ox team list` reports a restore's `<team-id>.bak.<epoch>` clone as a team. It is not one
 * anybody can pick — its id is a directory name, so choosing it writes a string into the
 * manifest that no deployment resolves — and on a machine that has been restored a few
 * times they outnumber the real teams on the menu.
 */
describe("the teams this machine can see", () => {
  const withFakeOx = async <T>(stdout: string, run: () => Promise<T>): Promise<T> => {
    const bin = mkdtempSync(join(tmpdir(), "ox-teams-"));
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
