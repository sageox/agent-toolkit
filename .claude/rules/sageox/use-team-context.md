---
description: How to discover and use team-context rules and knowledge from the SageOx ox CLI
---
<!-- agentx-hash: 689754a46103 ver: 0.12.0 -->
# Team Context — More Rules Live Outside This Repo

This repo uses SageOx. Behavioral rules and conventions that apply to your
WHOLE TEAM (not just this repo) live in your team's SageOx team-context
repo, NOT in `.claude/rules/`. SageOx will not auto-sync them here —
that would create stale-mirror and naming-conflict problems. Instead,
read them on demand from the canonical location.

## Where team rules live

Team-context repo path: see `ox status` (look for "team_context").
Typical layout:

    <team-context>/
      AGENTS.md                  # team-wide preamble
      MEMORY.md                  # team memory (already inlined into prime)
      agents/
        rules/
          <topic>.md             # one concern per file
          backend/postgres.md    # subdirectories supported
          frontend/react.md
        commands/                # team slash commands
        profiles/                # AI coworker profiles
      discussions/               # archived team meetings
      memory/                    # daily/weekly/monthly summaries
      documents/                 # imported docs

## How to discover and read them

`ox agent prime` already inlines:
- Team AGENTS.md / CLAUDE.md
- `visibility: always` team rules (full body)
- Team MEMORY.md

`ox agent prime` also catalogs (name + description + path only):
- `visibility: indexed` team rules — read on demand via the path

To read an indexed team rule: use the Read tool with the absolute path
shown in the prime output's `<team-rules>` block.

To search team-wide knowledge (discussions, sessions, docs):
- `ox query "<question>"` — semantic search across the team's
  recorded discussions and prior coding sessions
- `ox agent team-ctx` — distilled team knowledge for AI agents

To learn the team-rule format (when authoring or promoting a rule):
- `ox guide team-rules`

## When you write a project-local rule

If a user adds or edits a rule in `.claude/rules/` (this repo's
local rules) that looks generally applicable — not specific to this
repo's paths/services/schemas — ASK them whether to also publish it as
a team rule under `<team-context>/agents/rules/`. Default to
asking; do not silently publish. Repo-specific rules stay project-local.

Team rules apply to every supported AI coding agent (Claude, Codex, Amp,
Cursor, etc.) used by teammates running ox — but only for teammates
running ox. Project-local `.claude/rules/` only reaches Claude
users. That asymmetry is the reason to promote durable conventions
team-wide.

## Why this rule exists (instead of syncing team rules here)

Syncing team rules from team-context into `.claude/rules/` would
require: continuous mirror semantics (write on change, remove on
disappearance), namespace management to avoid project-local conflicts,
and per-adapter coverage (Claude has rules; Codex / Amp don't yet).
Pointing here instead keeps the team-context repo as the single source
of truth and works uniformly across every coding agent that supports
rules.
