#!/bin/sh
# Convert a harness-reflex Stop verdict into Kimi Code's block protocol.
#
# Kimi Code decides a Stop hook's intent from the exit code:
#   0  -> allow (stdout may be appended to the context)
#   2  -> block; stderr, trimmed, becomes the reason appended to the model's
#         context so it keeps working
#    *  -> allow (fail-open)
# See https://moonshotai.github.io/kimi-code/en/customization/hooks
#
# `harness-reflex hook stop` speaks the Claude Code shape instead:
#   {"decision":"block","reason":"..."}   (block)
#   {}                                     (allow)
# The host parses stdout with a schema that knows `message` and
# `hookSpecificOutput.{message,permissionDecision,permissionDecisionReason}` —
# not `decision` — so the JSON would be silently ignored and the block lost.
# This shim is the translation, in pure sh: it matches the exact bytes the CLI
# writes (JSON.stringify output, no spaces) and re-emits them on the channel the
# host actually reads. Anything unexpected is passed through untouched, so a
# decision this script does not recognize can only ever allow, never block.
#
# Usage (from hooks.toml):  command = "sh ~/.kimi-code/hooks/reflex-stop-exit2.sh"

set -u

# The CLI prints exactly one JSON object on stdout and always exits 0 on the
# decision path. Capture it; empty output means "no instruction".
out=$(harness-reflex hook stop 2>/dev/null)

case "$out" in
  *'"decision":"block"'*)
    # Exit 2 + stderr: the host turns stderr into the continuation reason.
    printf '%s\n' "$out" >&2
    exit 2
    ;;
  *)
    printf '%s\n' "$out"
    exit 0
    ;;
esac
