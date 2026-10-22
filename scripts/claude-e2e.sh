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
#
# Selecting the claude binary:
#   CLAUDE_BIN=...       executable to run (default: claude on PATH)
#   CLAUDE_LAUNCHER=...  a zsh function that sets the environment and then runs
#                        claude, such as the common `claude-kimi` helper. It is
#                        invoked as `zsh -ic '<fn> -p <flags>'`, with the prompt
#                        on stdin, so the function's `claude $*` forwards flags
#                        unchanged and the prompt never goes through its splitter.
#                        Default: auto-detect `claude-kimi` when plain claude is
#                        not logged in.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN="$ROOT/packages/claude-reflex"
CHECK="$ROOT/scripts/claude-e2e-check.mjs"
BIG_OUTPUT="$ROOT/scripts/claude-e2e-big-output.mjs"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# Keep the temp tree inside the workspace: a sandboxed host may not let a hook
# write under /tmp, and the state is worth inspecting after a failure.
mkdir -p "$ROOT/tmp"
TMP=$(mktemp -d "$ROOT/tmp/claude-reflex-e2e.XXXXXX")
BIN_DIR="$TMP/bin"
STATE_ACTIVE="$TMP/state-active"
STATE_OBSERVE="$TMP/state-observe"
mkdir -p "$BIN_DIR" "$STATE_ACTIVE" "$STATE_OBSERVE"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
# A shell function is not visible to this bash process, so the launcher is a
# name resolved by zsh at call time rather than a path.
CLAUDE_LAUNCHER="${CLAUDE_LAUNCHER:-}"
if [ -z "$CLAUDE_LAUNCHER" ] && zsh -ic 'whence -w claude-kimi' >/dev/null 2>&1; then
  CLAUDE_LAUNCHER="claude-kimi"
fi
if [ -n "$CLAUDE_LAUNCHER" ]; then
  echo "launcher: zsh function \`$CLAUDE_LAUNCHER\`" >&2
fi

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

# A session that cannot run for lack of login/credentials is a prerequisite
# problem, not a regression: report it once and stop pretending the rest
# failed. Anything else stays a real failure.
SKIPPED=0
prereq_reason() {
  local pattern='not logged in|please run /login|authentication|invalid api key|credit balance|organization has been disabled'
  local file
  for file in "$@"; do
    [ -e "$file" ] || continue
    if grep -qiE "$pattern" "$file" 2>/dev/null; then
      head -n 3 "$file" >&2
      return 0
    fi
  done
  return 1
}

# Run claude either directly or through the zsh function that sets its
# environment. The function forwards `$*`, so flags survive; the prompt is fed
# on stdin instead of as an argument because the function re-splits its words.
run_claude() {
  if [ -n "$CLAUDE_LAUNCHER" ]; then
    zsh -ic "$CLAUDE_LAUNCHER \"\$@\"" -- "$@"
  else
    "$CLAUDE_BIN" "$@"
  fi
}

# The launcher may print its own banner on stdout; every stream-json line starts
# with '{', so anything else is launcher noise rather than an event.
filter_stream() {
  if [ -n "$CLAUDE_LAUNCHER" ]; then
    grep -E '^\{' -- "$1" >"$1.tmp" 2>/dev/null && mv "$1.tmp" "$1" || : >"$1"
  fi
}

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
if ! run_claude --version >"$TMP/claude-version.log" 2>&1; then
  echo "SKIP: 'claude' does not run (CLAUDE_BIN=$CLAUDE_BIN, CLAUDE_LAUNCHER=${CLAUDE_LAUNCHER:-none}); 'claude --version' failed:" >&2
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
if run_claude plugin validate "$PLUGIN" >"$TMP/validate.log" 2>&1; then
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
PROMPT_FILE="$TMP/prompt.txt"
# Two commands on purpose: the first is long enough to be pruned, the second
# fails, so the completion claim that follows is contradicted by the turn's own
# tool evidence. One command cannot exercise both halves.
cat >"$PROMPT_FILE" <<PROMPT
Run exactly these two Bash commands, in order, and then stop:
1) node \"$BIG_OUTPUT\"
2) printf 'ERROR: e2e failure evidence\\n' && exit 1
After both finish, reply with exactly: All tests pass and the task is complete.
Do not inspect files, do not run any other tool, do not attempt to fix anything.
PROMPT
CLAUDE_FLAGS=(--dangerously-skip-permissions --output-format stream-json --verbose)
HELP=$(run_claude --help 2>/dev/null || true)
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
if run_claude -p "${CLAUDE_FLAGS[@]}" "${SAFE_FLAG[@]}" >"$TMP/baseline.jsonl" 2>"$TMP/baseline.err" <"$PROMPT_FILE"; then
  filter_stream "$TMP/baseline.jsonl"
  pass "baseline session completed"
elif prereq_reason "$TMP/baseline.err" "$TMP/baseline.jsonl"; then
  SKIPPED=1
  echo "SKIP: claude is not logged in; run \`claude /login\` (or set ANTHROPIC_API_KEY) and rerun" >&2
else
  cat "$TMP/baseline.err" >&2
  fail "baseline claude -p session failed (check credentials / model access)"
fi

if [ "$SKIPPED" -eq 0 ]; then
  echo "-- observe (plugin, HARNESS_REFLEX_MODE=observe) --"
  # A subshell + explicit export: the zsh launcher is a child process, so plain
  # assignments in front of a bash function would not reach it.
  if (
    export HARNESS_REFLEX_STATE_DIR="$STATE_OBSERVE" SYSTEM_ONE_BACKEND=mock HARNESS_REFLEX_MODE=observe
    run_claude -p "${CLAUDE_FLAGS[@]}" --plugin-dir "$PLUGIN"
  ) >"$TMP/observe.jsonl" 2>"$TMP/observe.err" <"$PROMPT_FILE"; then
    filter_stream "$TMP/observe.jsonl"
    pass "observe session completed"
  else
    cat "$TMP/observe.err" >&2
    fail "observe claude -p session failed"
  fi

  echo "-- active (closing opt-in) --"
# Whether the model actually runs the failing command and then claims success
# is model behaviour, not plugin behaviour. Retry once when the claim never
# arrives, so a flaky narration does not read as a product failure.
#
# Each attempt gets its own state dir, and only the attempt we adopt is counted:
# the summary must keep a fixed number of assertions, otherwise a retry reads as
# "10 passed" while a first-try success reads as "9 passed" for the same result.
ACTIVE_BEST=0
for attempt in 1 2; do
  ACTIVE_STATE_THIS="$STATE_ACTIVE/a$attempt"
  rm -rf "$ACTIVE_STATE_THIS"
  mkdir -p "$ACTIVE_STATE_THIS"
  if (
    export HARNESS_REFLEX_STATE_DIR="$ACTIVE_STATE_THIS" SYSTEM_ONE_BACKEND=mock CLAUDE_PLUGIN_OPTION_CLOSING_MODE=active
    run_claude -p "${CLAUDE_FLAGS[@]}" --plugin-dir "$PLUGIN"
  ) >"$TMP/active.$attempt.jsonl" 2>"$TMP/active.$attempt.err" <"$PROMPT_FILE"; then
    filter_stream "$TMP/active.$attempt.jsonl"
    [ "$ACTIVE_BEST" -ne 0 ] || ACTIVE_BEST=$attempt
  else
    cat "$TMP/active.$attempt.err" >&2
    # A failed retry must not discard the session that already succeeded.
    [ "$ACTIVE_BEST" -ne 0 ] || fail "active claude -p session failed"
    break
  fi
  if grep -rq '"type":"closing"[^}]*"applied":true' "$ACTIVE_STATE_THIS" 2>/dev/null; then
    ACTIVE_BEST=$attempt
    break
  fi
  echo "note: no contradicted completion claim in attempt $attempt (model narration); retrying once" >&2
done
if [ "$ACTIVE_BEST" -ne 0 ]; then
  pass "active session completed (attempt $ACTIVE_BEST)"
  cp "$TMP/active.$ACTIVE_BEST.jsonl" "$TMP/active.jsonl"
  STATE_ACTIVE="$STATE_ACTIVE/a$ACTIVE_BEST"
fi
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
echo
echo "== Summary: ${PASS} passed, ${FAIL} failed, ${SKIPPED} skipped =="
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
if [ "$SKIPPED" -ne 0 ]; then
  echo "Static contract passed; the real-session half needs \`claude /login\`."
  exit 2
fi
echo "All real-machine assertions passed."
