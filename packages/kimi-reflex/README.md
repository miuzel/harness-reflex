# harness-reflex for Kimi Code CLI

Wires the `harness-reflex` decision runtime into [Kimi Code CLI](https://moonshotai.github.io/kimi-code/):
lifecycle hooks that translate host events into `harness-reflex hook <event>`,
and the eight `reflex_*` tools through Kimi's MCP client.

> **Not verified on a real host.** `kimi` is not installed on the machine this
> package was written on, so no hook below has ever been executed by Kimi Code.
> What *is* verified: the configuration shape, the event names, the payload
> normalization and the stdout contract, all asserted offline against the real
> build (`npm run test:kimi-plugin`). See [Verification status](#verification-status)
> for the exact gaps and how to close them.

## Install

1. Install the runtime so the bare `harness-reflex` command resolves on `PATH`:

   ```sh
   npm install -g harness-reflex     # or: npm link, from a checkout
   harness-reflex --help
   ```

2. Append the `[[hooks]]` entries from [`hooks.toml`](./hooks.toml) to the
   **user-level** config (`~/.kimi-code/config.toml`, or
   `$KIMI_CODE_HOME/config.toml`). Kimi Code reads hook rules only from that
   file; there is no project-level hook file. Keep it to the four allowed fields —
   an extra key makes the whole config fail to load.

3. Put the Stop shim where the config points at it:

   ```sh
   mkdir -p ~/.kimi-code/hooks
   cp hooks/reflex-stop-exit2.sh ~/.kimi-code/hooks/
   chmod +x ~/.kimi-code/hooks/reflex-stop-exit2.sh
   ```

4. Add the MCP server by copying [`mcp.json`](./mcp.json) to
   `~/.kimi-code/mcp.json` (user level) or `.kimi-code/mcp.json` (project level).
   Merge it with any existing file rather than replacing it — the `mcpServers`
   object holds every server you have. Alternatively run `/mcp-config` in the TUI.

5. Start a session and check `/mcp` shows `harness-reflex` with eight tools.

State lives outside the repository, under `$HARNESS_REFLEX_STATE_DIR` or
`$XDG_STATE_HOME/harness-reflex`; nothing is written into the project.

## Capability matrix

Only three Kimi Code events can block, and only two of those have a decision
behind them. This table says what actually reaches the model.

| Capability | Event | Reaches the model? | Why |
| --- | --- | --- | --- |
| Stagnation gate (refuse a repeated call) | `PreToolUse` | **yes** — the tool call is vetoed | The host blocks on `hookSpecificOutput.permissionDecision == "deny"`, which is exactly what the hook prints |
| Closing verification (refuse a contradicted "done") | `Stop` | **yes** — via the exit-2 shim | The host blocks on exit code 2 and takes stderr as the reason; our own Stop JSON uses `decision: "block"`, which the host's schema does not read, hence the shim |
| Result pruning | `PostToolUse` | **no** | Observation-only event: the host ignores the return value (`notifyPostToolUse` → `fireAndForget`). The decision is still recorded in the ledger, with the token saving it *would* have produced |
| Failure correction | `PostToolUseFailure` | **no** | Same: observation-only. Recorded, not applied |
| Subagent closing | `SubagentStop` | **no** | Observation-only event |
| Session notice / GC | `SessionStart` / `SessionEnd` | **no** | Observation-only; the ledger records the mode |

The `updatedToolOutput` and `additionalContext` fields the other hosts honour have
no effect here. That is a property of the host, not a bug in the wiring, and it is
why this package does not claim Kimi Code gets automatic pruning.

### Why a shell shim instead of one command per event

Every hook is `harness-reflex hook <event>` — a single `sh` line, no extra
interpreter. The one exception is `Stop`: the decision layer emits the Claude Code
verdict (`{"decision":"block","reason":…}`), while Kimi Code only honours exit
code 2 or a `permissionDecision` deny document. `hooks/reflex-stop-exit2.sh`
re-emits our exact bytes on the channel the host reads. It is pure `sh` — no
extra JS process — and it fails *towards* allow: anything it does not recognise is
passed through unchanged, so a decision it fails to parse can never become a veto.

## Verification status

**Verified offline** (all green in `npm run test:kimi-plugin`):

- the four-field `[[hooks]]` restriction, and that every entry names a real
  decision event (a typo would be a silent no-op, because an unknown event fails
  open);
- `timeout` in seconds, integer, inside 1–600, equal to the design's host budget
  rounded **up** (`SessionEnd` is 1500 ms → 2 s, never down);
- the whole stdin → decision → stdout chain, run through the real CLI with
  Kimi-shaped payloads (`tool_call_id`, `tool_output`, `hook_event_name`,
  `session_title`, `client_type`) for allow / deny / rewrite / block;
- the Stop shim's conversion, including that an unrecognized verdict stays allow;
- an MCP handshake against the real `harness-reflex mcp`, returning the eight
  tool names.

**Not verified** (no host available):

| Unverified claim | Reproduce with |
| --- | --- |
| Kimi Code actually loads `[[hooks]]` from `config.toml` and fires them | `npm i -g @moonshot-ai/kimi-code`, add the fragment, start `kimi`, run any task that calls `Bash`; then check a `ledger.jsonl` appeared under `$HARNESS_REFLEX_STATE_DIR/sessions/kimi-*` |
| The host's matcher/`cwd` behaviour matches the docs | Put a hook with `matcher = "Bash"`, trigger a `Read`, confirm the hook does **not** run; then trigger `Bash` and confirm it does |
| `PreToolUse` denial actually prevents the tool call | Set `HARNESS_REFLEX_MODE=active`, run one identical command three times; the third call should be refused with the ledger's reason |
| The Stop shim's exit 2 appends the reason and keeps the model working | With `HARNESS_REFLEX_CLOSING_MODE=active`, contradict the evidence (fail a build, then claim success) and confirm the turn continues instead of ending |
| `tool_output` is truncated to 2000 characters in practice | Run a command with large output and inspect the ledger's recorded `tokensSaved`; the original saved by the hook should be at most the truncation limit |
| Whether `updatedToolOutput` has any effect | Not expected to; confirm by comparing the model's view of a large output with pruning on — it should be unchanged |

The vendor sources for every rule above are listed in
[`docs/contract-sources.md`](./docs/contract-sources.md), including the specific
file inside the published tarball where the docs and the bundle disagree.

## Configuration

Same environment variables as the rest of the runtime:

| Variable | Meaning |
| --- | --- |
| `HARNESS_REFLEX_MODE` | `off` / `observe` / `active` for every capability at once |
| `HARNESS_REFLEX_PRUNE_MODE`, `_STAGNATION_MODE`, `_GATE_MODE`, `_CLOSING_MODE` | per-capability override |
| `HARNESS_REFLEX_STATE_DIR` | where the ledger and retained originals live |
| `SYSTEM_ONE_BACKEND` | `mock` / `simple-jev` / `jev` / `vllm` |

`closing` defaults to `observe`, so the Stop shim is inert until you opt in — the
same default the other hosts ship.
