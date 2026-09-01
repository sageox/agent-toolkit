<!-- ox-hash: 22568b2f4841 ver: 0.14.3 -->
# SageOx Commands Reference

Essential ox commands for team context:

## Get Project Conventions
```bash
ox conventions
```
Returns verified SAGEOX.md content with coding standards and team patterns.

## Check Project Health
```bash
ox doctor
```
Diagnostic checks for SageOx configuration, signatures, and integration.

## Update Conventions
```bash
ox update
```
Sync latest conventions from cloud (requires authentication).

## Initialize SageOx
```bash
ox init
```
Enable SageOx for a new project (creates .sageox/ directory).

## Check Status
```bash
ox status
```
Check authentication, project initialization, sync, and daemon health.

## Session Recording
```bash
ox agent <id> session start   # begin recording
ox agent <id> session stop    # stop and save to ledger
```
Record agent sessions to the project ledger for team visibility.

## Diagnostics
```bash
ox doctor
```
Run diagnostic checks on SageOx configuration and integrations.

## Search Code, History, PRs

`ox code` queries the local CodeDB index. Reach for it before grep/ripgrep on this repo.

Verb-mode (preferred):

```bash
ox code defs <name>                       # where is <name> defined?
ox code callers <name>                    # who calls <name>? (resolved call graph)
ox code callees <name> --depth 2          # what <name> calls (transitive)
ox code refs <name> [--lang go]           # text references
ox code log <path> [--author X --after YYYY-MM-DD]  # commits touching path
ox code prs --sort stalled                # PR triage
ox code activity --since 7d               # recent GitHub events
ox code insights                          # hotspots, contention, open PRs/issues
ox code status                            # index health
```

DSL-mode (when verbs don't fit):

```bash
ox code search "<text>" type:pr                   # indexed PR titles/bodies/comments
ox code search "<text>" type:comment ckind:todo   # source comments by kind
ox code search "<text>" author:<n> after:<date>   # git history + content together
ox code search "/<regex>/"                        # forced regex
```

DSL: `type:{code,symbol,diff,commit,comment,pr,issue}`, `repo:`, `file:`, `lang:`, `author:`, `before:`/`after:`, `message:`, `calls:`/`calledby:`, `depth:`, `confidence:{extracted,inferred,ambiguous}`, `ckind:`, `state:`, `OR`, `/regex/`. Negate any filter with `-` prefix.

Fall back to grep only for exact-string matches in a known file or when `ox code` returns 0 results.

---
Run `ox --help` for full command list.
