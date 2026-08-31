import { describe, it, expect } from "vitest";
import { DEFAULT_SECRETS_DIR } from "../src/secrets.ts";
import { loadToolPolicy, ToolPolicy } from "../src/tool-policy.ts";

const ok = {
  permissions: {
    defaultMode: "acceptEdits",
    allow: ["Bash(git status)", "Bash(git diff:*)", "mcp__github__list_issues"],
    deny: ["Read(./.env)", "Read(//mnt/secrets-store/**)", "Read(**/auth.json)"],
  },
};

describe("loadToolPolicy invariants", () => {
  it("accepts a well-formed policy", () => {
    expect(() => loadToolPolicy(JSON.stringify(ok))).not.toThrow();
  });

  it("refuses bypassPermissions, which turns the allowlist into deny-only", () => {
    const bad = { ...ok, permissions: { ...ok.permissions, defaultMode: "bypassPermissions" } };
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(/bypass/i);
  });

  it("explains a missing defaultMode instead of dumping zod issues at the operator", () => {
    const bad = { permissions: { allow: ok.permissions.allow, deny: ok.permissions.deny } };
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(
      /permissions\.defaultMode is required.*acceptEdits/s,
    );
  });

  it("explains a settings file with no permission block at all", () => {
    expect(() => loadToolPolicy(JSON.stringify({ model: "opus" }))).toThrow(
      /permissions is required.*acceptEdits/s,
    );
  });

  it("refuses a broad Bash deny, which would brick every allowed verb", () => {
    const bad = { ...ok, permissions: { ...ok.permissions, deny: [...ok.permissions.deny, "Bash"] } };
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(/bash/i);
  });

  it("refuses a policy that does not deny reading secrets", () => {
    const bad = { ...ok, permissions: { ...ok.permissions, deny: ["Read(./notes.md)"] } };
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(/secret/i);
  });

  it("refuses an allow glob that names no server, because it grants nothing", () => {
    // Claude Code skips one with a warning; a hosted agent has nobody to read a warning,
    // and the rule reads as the broadest grant in the file.
    for (const rule of ["mcp__*__pr_list", "mcp__*", "*"]) {
      const bad = { ...ok, permissions: { ...ok.permissions, allow: [rule] } };
      expect(() => loadToolPolicy(JSON.stringify(bad)), rule).toThrow(/grants nothing/);
    }
  });

  it("leaves an argument glob alone — Bash(git diff:*) globs a command, not a tool", () => {
    const fine = { ...ok, permissions: { ...ok.permissions, allow: ["Bash(git diff:*)"] } };
    expect(() => loadToolPolicy(JSON.stringify(fine))).not.toThrow();
  });

  it("refuses a secrets deny whose path only contains a protected one", () => {
    // Both ends of the path have to be anchored, and each of these defeats exactly one
    // end. A sibling extends the right (`secrets-old`, `.envrc`); a copy under another
    // directory extends the left (`/tmp//mnt/secrets-store`), denying a bundle-local path while
    // the root mount stays readable. Either way the agent starts with its credentials
    // exposed and a settings file that reads as if they were not.
    for (const rule of [
      "Read(//mnt/secrets-store-old/**)",
      "Read(./.envrc)",
      "Read(**/auth.jsonc)",
      "Read(/tmp//mnt/secrets-store/**)",
      "Read(/tmp/.env)",
      "Read(vendor/auth.json)",
    ]) {
      const bad = { ...ok, permissions: { ...ok.permissions, deny: [rule] } };
      expect(() => loadToolPolicy(JSON.stringify(bad)), rule).toThrow(/no deny rule covers/);
    }
  });

  it("accepts each spelling that does reach a secret path", () => {
    for (const rule of [
      "Read(//mnt/secrets-store/**)",
      "Read(//mnt/secrets-store)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(.env)",
      "Read(**/.env)",
      "Read(**/auth.json)",
      "Read(auth.json)",
    ]) {
      const fine = { ...ok, permissions: { ...ok.permissions, deny: [rule] } };
      expect(() => loadToolPolicy(JSON.stringify(fine)), rule).not.toThrow();
    }
  });

  it("refuses a secrets deny with one leading slash, which anchors at the bundle", () => {
    // The rule reads absolute and is not: Claude Code's path rules need `//` for the
    // filesystem root, so this covers <bundle>/mnt/secrets-store and leaves the mount
    // readable. The toolkit shipped this spelling itself once, which is why the near-miss
    // gets its own message instead of being reported as a missing rule.
    const bad = {
      ...ok,
      permissions: { ...ok.permissions, deny: ["Read(/mnt/secrets-store/**)"] },
    };
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(
      /does not reach \/mnt\/secrets-store/,
    );
    expect(() => loadToolPolicy(JSON.stringify(bad))).toThrow(/Read\(\/\/mnt\/secrets-store/);
  });

  it("accepts the mount deny spelled from the directory the resolver actually reads", () => {
    // The assertion and `resolveSecret` hold one path between them and neither can see the
    // other move. Spelling the rule from the constant is what fails here if one does.
    const fine = {
      ...ok,
      permissions: { ...ok.permissions, deny: [`Read(/${DEFAULT_SECRETS_DIR}/**)`] },
    };
    expect(() => loadToolPolicy(JSON.stringify(fine))).not.toThrow();
  });

  it("refuses a path rule on a tool whose path rules are never consulted", () => {
    // A scope expressed as Write(...) is not a narrower scope, it is no scope — and a
    // scope is the thing an operator writes once and then stops thinking about.
    for (const rule of ["Write(src/**)", "NotebookEdit(nb/**)", "MultiEdit(src/**)"]) {
      const bad = { ...ok, permissions: { ...ok.permissions, allow: [rule] } };
      expect(() => loadToolPolicy(JSON.stringify(bad)), rule).toThrow(/never consulted/);
      expect(() => loadToolPolicy(JSON.stringify(bad)), rule).toThrow(/Edit\(\.\.\.\)/);
    }
    // Glob(...) is the same defect with a different replacement.
    const glob = { ...ok, permissions: { ...ok.permissions, allow: ["Glob(src/**)"] } };
    expect(() => loadToolPolicy(JSON.stringify(glob))).toThrow(/Read\(\.\.\.\)/);
  });

  it("leaves a tool-level rule with no path alone, which Claude Code does consult", () => {
    const fine = { ...ok, permissions: { ...ok.permissions, deny: [...ok.permissions.deny, "Write"] } };
    expect(() => loadToolPolicy(JSON.stringify(fine))).not.toThrow();
  });
});

describe("allowsTool", () => {
  const p = loadToolPolicy(JSON.stringify(ok));

  it("allows an explicitly allowlisted tool", () => {
    expect(p.allowsTool("mcp__github__list_issues").ok).toBe(true);
  });

  it("refuses a tool nobody named — unlisted is not permitted", () => {
    const r = p.allowsTool("mcp__github__delete_repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not allowlisted/i);
  });

  it("lets deny beat allow", () => {
    const conflicted = loadToolPolicy(
      JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["mcp__github__merge_pr"],
          deny: ["Read(//mnt/secrets-store/**)", "mcp__github__merge_pr"],
        },
      }),
    );
    const r = conflicted.allowsTool("mcp__github__merge_pr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/denied/i);
  });

  it("supports a wildcard suffix so a server can be allowed wholesale", () => {
    const wild = loadToolPolicy(
      JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["mcp__docs__*"],
          deny: ["Read(//mnt/secrets-store/**)"],
        },
      }),
    );
    expect(wild.allowsTool("mcp__docs__search").ok).toBe(true);
    expect(wild.allowsTool("mcp__other__search").ok).toBe(false);
  });
});

// Claude Code reads this same file to decide whether the brain may call a tool, so a rule
// that means one thing there and another here is a policy nobody wrote. What the rules
// reach across a whole tool call is adjudicated in `policy-cases`; these are the
// name-level semantics on their own.
describe("the rule language, which is Claude Code's", () => {
  const policy = (allow: string[], deny: string[] = []) => new ToolPolicy(allow, deny);

  it("reads a bare server name as every tool that server provides", () => {
    expect(policy(["mcp__github"]).allowsTool("mcp__github__pr_list").ok).toBe(true);
    // The separator is part of the rule, so one server cannot reach into another whose
    // name merely starts the same way.
    expect(policy(["mcp__github"]).allowsTool("mcp__github_actions__run").ok).toBe(false);
  });

  it("reads a single underscore in a server name as part of the name", () => {
    // The `__` ban is on the SEPARATOR, not on underscores. A server named `my_server` is
    // legal and its whole-server rule has to work in both directions, or the ban would
    // have traded one silently-inert rule for another.
    expect(policy(["mcp__my_server"]).allowsTool("mcp__my_server__tool").ok).toBe(true);
    expect(
      policy(["mcp__my_server__*"], ["mcp__my_server"]).allowsTool("mcp__my_server__tool").ok,
    ).toBe(false);
  });

  it("keeps a qualified tool rule exact, so it cannot expand into a suffixed name", () => {
    // Only a BARE server rule expands to a prefix. `mcp__github__pr_list` names one tool,
    // and MCP tool names may themselves contain the separator — so expanding it would
    // grant `pr_list__admin`, which nobody wrote down, and deny it just as silently.
    expect(policy(["mcp__github__pr_list"]).allowsTool("mcp__github__pr_list__admin").ok).toBe(
      false,
    );
    expect(policy(["mcp__github__pr_list"]).allowsTool("mcp__github__pr_list").ok).toBe(true);
    expect(
      policy(["mcp__github"], ["mcp__github__pr_list"]).allowsTool("mcp__github__pr_list__admin")
        .ok,
    ).toBe(true);
  });

  it("lets a deny glob match the whole tool name, which an allow glob may not", () => {
    // The asymmetry is Claude Code's. Reproducing only the allow half is what would leave
    // a deny inert on the layer the brain cannot skip.
    expect(policy(["mcp__github__*"], ["mcp__*__pr_list"]).allowsTool("mcp__github__pr_list").ok)
      .toBe(false);
    expect(policy(["mcp__github__*"], ["mcp__*__pr_list"]).allowsTool("mcp__github__issue_list").ok)
      .toBe(true);
    expect(policy(["mcp__*__pr_list"]).allowsTool("mcp__github__pr_list").ok).toBe(false);
  });

  it("still honours an argument glob, which is where the scaffold's git verbs live", () => {
    // The anchoring rule is about tool-NAME globs. Applying it to `Bash(git diff:*)` reads
    // the rule as unanchored and takes the verb away — silently, since the policy still
    // loads. Both rules below are in the generated settings.json.
    const p = policy(["Bash(git diff:*)", "Bash(git log:*)"]);
    expect(p.allowsTool("Bash(git diff:HEAD)").ok).toBe(true);
    expect(p.allowsTool("Bash(git log:--oneline)").ok).toBe(true);
    expect(p.allowsTool("Bash(git push:--force)").ok).toBe(false);
  });

  it("matches a glob positionally, not by prefix and suffix alone", () => {
    // `mcpBroker.message` passes `params.name` from the brain's own request straight into
    // the policy, so these are the semantics an untrusted name is judged by. The middles
    // have to fit between the ends, in order.
    expect(policy(["mcp__x__a*bc"]).allowsTool("mcp__x__abc").ok).toBe(true);
    expect(policy(["mcp__x__a*bc"]).allowsTool("mcp__x__abd").ok).toBe(false);
    expect(policy(["mcp__x__a*b*c"]).allowsTool("mcp__x__aXbYc").ok).toBe(true);
    expect(policy(["mcp__x__a*b*c"]).allowsTool("mcp__x__acb").ok).toBe(false);
  });

  it("treats a regex metacharacter in a rule as a literal", () => {
    // The rule is translated into a regex, so an unescaped `.` or `+` would silently widen
    // a deny into something its author did not write.
    expect(policy([], ["mcp__x__a.c"]).allowsTool("mcp__x__abc").ok).toBe(false);
    expect(policy(["mcp__x__a.c"]).allowsTool("mcp__x__a.c").ok).toBe(true);
  });

  it("spans separators, so a glob is a glob and not a token-aware prefix", () => {
    expect(policy(["mcp__github__**"]).allowsTool("mcp__github__pr_list").ok).toBe(true);
    expect(policy(["mcp__github__*"], ["mcp__*"]).allowsTool("mcp__github__pr_list").ok).toBe(false);
  });
});
