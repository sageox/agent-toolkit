#!/usr/bin/env bash
# Run a noisy CI command quietly: one summary line when it passes, the full output when it fails.
# Usage: scripts/ci/run-quiet.sh <label> <command> [args...]
# Full output comes back with GitHub's "Re-run jobs > Enable debug logging" (RUNNER_DEBUG=1) or V=1.
set -uo pipefail

label=$1
shift

if [[ "${RUNNER_DEBUG:-}" == 1 || "${V:-}" == 1 ]]; then
  exec "$@"
fi

log=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/run-quiet.XXXXXX")
start=$SECONDS

# a job timeout or cancel must not leave the log empty
on_interrupt() {
  # stop the command too: bash does not forward the signal, and SIGINT is ignored in background jobs
  kill -TERM "$child" 2>/dev/null
  wait "$child" 2>/dev/null
  echo "interrupted: $label after $((SECONDS - start))s; output so far:" >&2
  tail -n 200 "$log" >&2
  exit 143
}
trap on_interrupt INT TERM

"$@" >"$log" 2>&1 &
child=$!
wait "$child"
status=$?

if [[ $status -ne 0 ]]; then
  echo "FAILED: $label (exit $status, $((SECONDS - start))s): $*" >&2
  cat "$log" >&2
  exit "$status"
fi

# Vitest's totals, so a run that found no tests cannot pass quietly
totals=$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ *(Test Files|Tests) ' | sed 's/^ *//' | paste -sd ';' - | sed 's/;/; /g')

echo "ok $label $((SECONDS - start))s${totals:+ -- $totals}"
