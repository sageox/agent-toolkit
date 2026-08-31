import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentState {
  /** Newest event timestamp seen per surface — the resume point after a restart. */
  since: Record<string, number>;
}

const EMPTY: AgentState = { since: {} };

/**
 * Durable resume points.
 *
 * A long-running agent restarts — for a deploy, a crash, a laptop sleep — and without a
 * persisted cursor every restart reopens a deaf window over exactly the messages that
 * arrived while it was down.
 */
export function loadState(path: string): AgentState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentState>;
    return { since: parsed.since ?? {} };
  } catch {
    return { ...EMPTY }; // first run, or a state file we cannot read: start clean
  }
}

export function saveState(path: string, state: AgentState): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a truncated cursor behind.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
