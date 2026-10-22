#!/usr/bin/env bash
# End-to-end verification of the Claude Code plugin on a machine that has the
# real `claude` binary. This checkout has no `claude`, so the script's static
# phase is the part CI can run; the three `claude -p` sessions are the part a
# user must run locally.
#
# What it asserts:
#   1. `claude plugin validate` accepts the plugin directory (when supported).
#   2. A real session prunes an oversized Bash result (shorter, locator present,
#      retained original restores the command output) and the Stop hook blocks
#      exactly on the contradicted completion claim.
#   3. The host's guarded retry (`stop_hook_active: true`) is allowed.
#   4. With the plugin in observe mode, the model-visible tool result is
#      byte-identical to a no-plugin baseline.
#
# Exit codes: 0 = every assertion passed; 1 = an assertion failed;
#             2 = a prerequisite is missing (no claude / no build).
#
# Usage: scripts/claude-e2e.sh [--keep]
#   --keep  keep the temp state/stream files and print their location
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN="$ROOT/packages/claude-reflex"
CHECK="$ROOT/scripts/claude-e2e-check.mjs"
BIG_OUTPUT="$ROOT/scripts/claude-e2e-big-output.mjs"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

TMP=$(mktemp -d "${TMPDIR:-/tmp}/claude-reflex-e2e.XXXXXX")
BIN_DIR="$TMP/bin"
STATE_ACTIVE="$TMP/state-active"
STATE_OBSERVE="$TMP/state-observe"
mkdir -p "$BIN_DIR" "$STATE_ACTIVE" "$STATE_OBSERVE"

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "kept: $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

echo "== Phase 0: static contract (no claude required) =="
if [ ! -f "$ROOT/dist/cli/index.js" ]; then
  echo "building the root package first..."
  (cd "$ROOT" && npm run build >/dev/null)
fi
if ! node --test "$PLUGIN/test/structure.test.mjs" "$PLUGIN/test/hooks.test.mjs" >"$TMP/static.log" 2>&1; then
  tail -40 "$TMP/static.log" >&2
  echo "static contract checks failed; fix them before the real e2e" >&2
  exit 1
fi
pass "static manifest/hooks/.mcp.json/7-event/observe-diff checks"

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP: 'claude' is not installed on this machine." >&2
  echo "      Static checks passed. Run this script where Claude Code is installed." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node is required to run Claude Code hooks." >&2
  exit 2
fi
# A `claude` shim can exist while its platform-native binary is missing (broken
# postinstall / --omit=optional). Treat that as "no usable claude", not as a
# product failure.
if ! claude --version >"$TMP/claude-version.log" 2>&1; then
  echo "SKIP: 'claude' resolves to $(command -v claude), but 'claude --version' failed:" >&2
  head -5 "$TMP/claude-version.log" >&2
  echo "      Install the native binary (see the message above) and re-run." >&2
  exit 2
fi
echo "claude: $(head -1 "$TMP/claude-version.log")"
echo "node:   $(node --version)"

# The plugin's hooks and MCP server both call `harness-reflex`. Use a temp shim
# when the checkout is not installed globally; claude inherits this PATH.
if ! command -v harness-reflex >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$ROOT/dist/cli/index.js" >"$BIN_DIR/harness-reflex"
  chmod +x "$BIN_DIR/harness-reflex"
  export PATH="$BIN_DIR:$PATH"
  pass "harness-reflex shim added to PATH"
fi

echo "== Phase 1: plugin validation =="
if claude plugin validate "$PLUGIN" >"$TMP/validate.log" 2>&1; then
  pass "claude plugin validate"
else
  if grep -qiE "unknown command|unrecognized|no such command" "$TMP/validate.log"; then
    echo "WARN: this claude has no 'plugin validate'; skipping that check" >&2
  else
    cat "$TMP/validate.log" >&2
    fail "claude plugin validate rejected the plugin"
  fi
fi

echo "== Phase 2: real sessions =="
PROMPT="Run exactly one Bash command and then stop:
node \"$BIG_OUTPUT\"
After it finishes, reply with exactly: All tests pass and the task is complete.
Do not inspect files, do not run any other tool, do not attempt to fix anything."
CLAUDE_FLAGS=(--dangerously-skip-permissions --output-format stream-json --verbose)
HELP=$(claude --help 2>/dev/null || true)
if grep -q -- '--max-turns' <<<"$HELP"; then
  CLAUDE_FLAGS+=(--max-turns 6)
fi
SAFE_FLAG=()
if grep -q -- '--safe-mode' <<<"$HELP"; then
  SAFE_FLAG=(--safe-mode)
else
  echo "WARN: this claude has no --safe-mode; the baseline may still load a globally installed plugin" >&2
fi

echo "-- baseline (no plugin) --"
if claude -p "$PROMPT" "${CLAUDE_FLAGS[@]}" "${SAFE_FLAG[@]}" >"$TMP/baseline.jsonl" 2>"$TMP/baseline.err"; then
  pass "baseline session completed"
else
  cat "$TMP/baseline.err" >&2
  fail "baseline claude -p session failed (check credentials / model access)"
fi

echo "-- observe (plugin, HARNESS_REFLEX_MODE=observe) --"
if env HARNESS_REFLEX_STATE_DIR="$STATE_OBSERVE" SYSTEM_ONE_BACKEND=mock HARNESS_REFLEX_MODE=observe \
  claude -p "$PROMPT" "${CLAUDE_FLAGS[@]}" --plugin-dir "$PLUGIN" >"$TMP/observe.jsonl" 2>"$TMP/observe.err"; then
  pass "observe session completed"
else
  cat "$TMP/observe.err" >&2
  fail "observe claude -p session failed"
fi

echo "-- active (closing opt-in) --"
if env HARNESS_REFLEX_STATE_DIR="$STATE_ACTIVE" SYSTEM_ONE_BACKEND=mock CLAUDE_PLUGIN_OPTION_CLOSING_MODE=active \
  claude -p "$PROMPT" "${CLAUDE_FLAGS[@]}" --plugin-dir "$PLUGIN" >"$TMP/active.jsonl" 2>"$TMP/active.err"; then
  pass "active session completed"
else
  cat "$TMP/active.err" >&2
  fail "active claude -p session failed"
fi

echo "== Phase 3: assertions =="
if [ -s "$TMP/baseline.jsonl" ] && [ -s "$TMP/observe.jsonl" ]; then
  if node "$CHECK" assert-observe-equal "$TMP/baseline.jsonl" "$TMP/observe.jsonl" "claude-e2e-big-output.mjs" >"$TMP/observe.log" 2>&1; then
    pass "$(cat "$TMP/observe.log")"
  else
    cat "$TMP/observe.log" >&2
    fail "observe diff is not zero"
  fi
else
  fail "missing stream output for the observe comparison"
fi

if [ -s "$TMP/active.jsonl" ]; then
  node "$ROOT/scripts/claude-e2e-big-output.mjs" >"$TMP/expected.txt"
  if node "$CHECK" assert-pruned "$TMP/active.jsonl" "claude-e2e-big-output.mjs" "$TMP/expected.txt" "$STATE_ACTIVE" >"$TMP/prune.log" 2>&1; then
    pass "$(cat "$TMP/prune.log")"
  else
    cat "$TMP/prune.log" >&2
    fail "the real session did not produce a verifiable prune"
  fi
  if node "$CHECK" ledger "$STATE_ACTIVE" >"$TMP/ledger.log" 2>&1; then
    pass "$(cat "$TMP/ledger.log")"
  else
    cat "$TMP/ledger.log" >&2
    fail "the active ledger is missing a decision"
  fi
else
  fail "missing stream output for the active session"
fi

echo
echo "== Summary: ${PASS} passed, ${FAIL} failed =="
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "All real-machine assertions passed."
