import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A surface's name is not a licence to prefix everything in the repository with it.
 *
 * Slack and console adapters ship in the same image as Buzz, so `buzz-agent-github` was a
 * claim about the product that stopped being true several PRs ago — and `settings.json`
 * allowlists, npm lockfiles, Helm releases and IAM roles all make a name expensive to take
 * back. docs/naming.md carries the reasoning and the question to ask before naming
 * anything; this only catches the spelling that actually recurred.
 *
 * The repository itself carried that spelling until it was renamed to `agent-toolkit`, and
 * was exempted for it. Nothing is exempted now — which is what makes this catch the URLs
 * and slugs a rename leaves behind, in the one place they all have to be right.
 */
const PREFIXED = /buzz[-_]agent|buzzagent/i;

/**
 * `packages/adapter-buzz/` is not here, though docs/naming.md exempts it from the
 * judgment. The two agree: what the adapter earns is `buzz` — `BUZZ_DEFAULTS`,
 * `surfaces[].kind: "buzz"` — and what this pattern forbids is `buzz` followed by
 * `agent`, which claims the agent as a Buzz thing and is the one reading the whole
 * document exists to deny. The adapter has never held one.
 *
 * It was exempt by directory until `buzz-agent-private-brain` showed that to be the wrong
 * question: a name declared in the adapter can still be an MCP server name that lands in
 * every consumer's allowlist, and a directory cannot tell the two apart. Neither can a
 * per-line rule — whatever marks a line as public, an `export` or a quote, a formatter
 * can move to the line above, so the check would turn on where somebody pressed return.
 * There is nothing in there to exempt, so nothing has to be classified.
 */
const EXEMPT = [
  // Records are records: a dated plan describes what was true when it was written, and
  // the changelog has to spell the old names to give anyone the old→new mapping.
  // Rewriting either to satisfy this test would make it lie.
  /^docs\/(plans|design)\//,
  /^CHANGELOG\.md$/,
  // A rule that cannot name the thing it forbids is not a rule, and a test that cannot
  // hold its own pattern cannot check anything. Both of these say `buzz-agent` on purpose.
  /^docs\/naming\.md$/,
  /^test\/naming\.test\.ts$/,
];

/** Every line of every tracked text file, so a check supplies only its own policy. */
function* trackedLines(): Generator<{ file: string; line: string; number: number }> {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" });

  for (const file of listed.split("\0").filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(resolve(repo, file), "utf8");
    } catch {
      continue; // A binary or unreadable path has no identifiers to check.
    }
    if (text.includes("\0")) continue;

    for (const [index, line] of text.split("\n").entries()) {
      yield { file, line, number: index + 1 };
    }
  }
}

/**
 * The private repository this toolkit was extracted from. A reader here cannot open
 * `sageox/sageox-monorepo#3545`, so the citation goes and the prose around it — which
 * already carries the failure it described — stays.
 *
 * The slug is the checkable part, and all this checks. The same sweep also removed a bare
 * `(#2719)`, which is worse than unreachable: GitHub resolves it against *this*
 * repository, so it points at an unrelated issue rather than at nothing. No pattern
 * catches that without also catching a correct `#42`, because the two differ only in
 * which tracker the number came from. Qualifying a citation is a review question, not one
 * this test can answer.
 *
 * Unlike the prefix check above, `docs/design/` and `CHANGELOG.md` are not
 * exempt. Dropping an unreachable citation leaves the record's account of what happened
 * intact, so a record does not have to lie to satisfy this.
 */
const PRIVATE_REPO = /sageox[-_ ]monorepo/i;

describe("naming", () => {
  it("keeps the buzz-agent prefix out of generic identifiers", () => {
    const offenders: string[] = [];

    for (const { file, line, number } of trackedLines()) {
      if (EXEMPT.some((pattern) => pattern.test(file))) continue;
      if (PREFIXED.test(line)) {
        offenders.push(`${file}:${number}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `These name a surface on something that is not the surface's. ` +
        `Read docs/naming.md: if it would still exist with the Buzz adapter deleted, it is ` +
        `not Buzz's to name. Inside packages/adapter-buzz/ too: what is earned there is ` +
        `buzz, not buzz-agent.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names no private repository an outside reader cannot open", () => {
    const offenders: string[] = [];

    for (const { file, line, number } of trackedLines()) {
      // A rule that cannot name the thing it forbids is not a rule.
      if (file === "test/naming.test.ts") continue;
      if (PRIVATE_REPO.test(line)) offenders.push(`${file}:${number}: ${line.trim()}`);
    }

    expect(
      offenders,
      `These point at a repository nobody outside SageOx can read. The narrative around ` +
        `each one already carries the evidence, so drop the citation and reflow; for a ` +
        `fixture, the house convention is acme/service.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
