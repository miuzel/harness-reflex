# Contract sources: Kimi Code CLI

Every rule this package encodes is cited here, so a reviewer can re-check it
without trusting the implementation. Two kinds of evidence are used:

- **Docs page** — the vendor's published documentation.
- **Package artifact** — a file inside the published npm tarball (`npm pack`),
  which is the code that actually runs, and therefore the tie-breaker when the
  docs and the bundle disagree.

Everything below was read on **2026-11-02** against
`@moonshot-ai/kimi-code@2.4.1` (published binary name: `kimi`), fetched with
`npm pack @moonshot-ai/kimi-code@2.4.1` into a scratch directory. The tarball is
gitignored and not vendored; the paths below are inside it
(`package/…` in the tarball).

## 1. Hooks: where they live and what fields they take

- Docs: <https://moonshotai.github.io/kimi-code/en/customization/hooks>
  (markdown source: `https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/docs/en/customization/hooks.md`)
  - `[[hooks]]` array in `~/.kimi-code/config.toml` (`$KIMI_CODE_HOME` relocates
    the directory; the file name stays `config.toml`).
  - Allowed fields: `event`, `matcher`, `command`, `timeout` — "`[[hooks]]` only
    allows these four fields; extra fields will cause the config file to fail to
    load."
  - `matcher` optional, "if omitted, matches all"; it is a **regular expression**.
  - `timeout` optional, **seconds**, range 1–600, default 30.
  - "Hook rules live only in your user-level `config.toml` and in local plugins —
    there is no project-level hook file."
- Docs: <https://moonshotai.github.io/kimi-code/en/configuration/config-files.html>
  — the `hooks` row of the top-level table ("`array<table>` — Lifecycle hooks")
  and the worked example, which uses the same four fields.
- Package artifact: `dist/main.mjs` (the bundled CLI).
  - `runHook(hostProcess, command, input, options)` spawns with
    `{ shell: true }` — the `command` is a **shell command string**, so pipes and
    `$()` are available (this is what makes the Stop shim a shell one-liner).
  - `timeoutSeconds(timeout)` × 1000 confirms the seconds unit.
  - `DEFAULT_HOOK_TIMEOUT_SECONDS = 30`.

## 2. Hooks: stdin payload and return protocol

- Docs (same hooks page):
  - Base stdin fields, snake_case: `hook_event_name`, `session_id`,
    `session_title`, `client_type`, `cwd`.
  - Tool events add the tool facts; the docs' blocking example reads
    `payload.tool_input?.command`.
  - Exit codes: `0` allow, `2` block (stderr becomes the reason), other non-zero
    allow (fail-open). Timeout or crash also fail open.
  - A JSON object on stdout may block with
    `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}`.
  - Only `PreToolUse`, `Stop`, `UserPromptSubmit` are blockable; every other
    event is observation-only.
- Package artifact: `dist/main.mjs`.
  - `toHookInputData` + `camelToSnake` — every payload key is converted to
    snake_case before it reaches stdin, which is why the wiring uses
    `session_id`/`tool_name`/`tool_call_id`.
  - `runPreToolUse` sends `toolName`, `toolInput`, `toolCallId` (→
    `tool_name`, `tool_input`, `tool_call_id`). **Kimi says `tool_call_id`, not
    `tool_use_id`**; `src/hook/payload.ts` in the root package folds the former
    onto the latter.
  - `notifyPostToolUse` sends `toolName`, `toolInput`, `toolCallId`, `error`,
    `toolOutput` (→ `tool_output`, truncated to 2000 characters). There is no
    `tool_response`; the normalizer maps `tool_output` onto it.
  - `resultFromExitCode`: `exitCode === 2` → block (stderr trimmed is the
    reason); otherwise `structuredOutput(stdout)`.
  - `structuredOutput`: parses stdout and blocks **only** when
    `hookSpecificOutput.permissionDecision === "deny"`. `HookJsonOutputSchema` is
    `{message?, hookSpecificOutput?: {message?, permissionDecision?,
    permissionDecisionReason?}}` — there is **no** `decision` field. This is why
    the Stop verdict (`{"decision":"block"}`) must be converted to exit 2 by
    `hooks/reflex-stop-exit2.sh`; without the shim the host would silently ignore
    the block.
  - `registerToolHooks`: `PreToolUse` runs through `triggerBlock` and vetoes the
    tool (`event.veto(denyToolExecution(reason))`), while `PostToolUse` goes
    through `notifyPostToolUse` → `fireAndForget` **and its return value is
    ignored**. That is the mechanical reason pruning is ledger-only on Kimi Code.
  - `runStop` uses `triggerBlock("Stop", …)` and appends the reason as a user
    message, guarded by `stopHookContinuationUsed`.
  - `indexHooks`/`matches`: `new RegExp(matcher).test(matcherValue)`, empty
    pattern matches all, an invalid pattern matches nothing.
  - Deduplication: matched hooks are deduped by `cwd + "\0" + command`.

## 3. MCP servers

- Docs: <https://moonshotai.github.io/kimi-code/en/customization/mcp>
  (markdown: `docs/en/customization/mcp.md` in the repo)
  - `~/.kimi-code/mcp.json` (user level) or `.kimi-code/mcp.json` (project
    level); `$KIMI_CODE_HOME/mcp.json` for the user level.
  - Shape: `{"mcpServers": {"<name>": {"command": "...", "args": [...]}}}` —
    identical to the root package's `.mcp.json`, which is why `mcp.json` here is
    a copy rather than a translation.
  - Optional stdio fields: `env`, `cwd`, `environment_id`, `enabled`,
    `startupTimeoutMs`, `toolTimeoutMs`, `enabledTools`, `disabledTools`.
  - Tool names are `mcp__<server>__<tool>`; permission rules support wildcards.

## 4. Event names used by this package

From the docs event table, cross-checked against the bundle's string literals
(`"PreToolUse"`, `"PostToolUse"`, `"PostToolUseFailure"`, `"SubagentStop"`, …):

| Event | Blockable | Used for |
| --- | --- | --- |
| `PreToolUse` | yes | stagnation gate (`harness-reflex hook pretooluse`) |
| `PostToolUse` | no | prune candidate recorded only |
| `PostToolUseFailure` | no | repeated-failure correction recorded only |
| `Stop` | yes | closing verification, via the exit-2 shim |
| `SubagentStop` | no | recorded only |
| `SessionStart` | no | mode notice recorded only |
| `SessionEnd` | no | session GC |

The names are identical to the Claude Code spellings, so the root package's
`parseHookEvent` alias table needs **no change** to accept them; the tests assert
that instead of relying on it.

## 5. What could not be verified

`kimi` is not installed on this machine (`command -v kimi` is empty) and the
package requires Node ≥ 22.19 while the sandbox cannot write
`~/.kimi-code/`. No hook was ever executed by a real Kimi Code process. See
`README.md` for the reproduction recipe and the exact list of unverified claims.
