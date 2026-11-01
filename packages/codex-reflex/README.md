# harness-reflex — Codex CLI plugin

System One decision runtime for [Codex CLI](https://github.com/openai/codex)
0.163.0+: hook wiring, an MCP server with eight `reflex_*` tools, and the
`config.toml` fragment that registers it.

This package is a **configuration bundle**. The executable is the root
`harness-reflex` package (`dist/cli/index.js` or the installed `harness-reflex`
bin); nothing here runs on its own.

## What is in here

| File | Purpose |
| --- | --- |
| `hooks.json` | Twelve hook events wired to `harness-reflex hook <event>` |
| `config.toml` | `[mcp_servers.harness-reflex]` block Codex reads for the MCP server |
| `README.md` | This file |

## Install

Copy `hooks.json` into your Codex home, and merge `config.toml` into
`$CODEX_HOME/config.toml`:

```sh
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME"
cp hooks.json "$CODEX_HOME/hooks.json"
cat config.toml >> "$CODEX_HOME/config.toml"
```

Or let the CLI do all of it for a workspace-local Codex home:

```sh
harness-reflex setup codex          # writes <workspace>/.codex/{hooks.json,config.toml,config.json}
CODEX_HOME=<workspace>/.codex codex exec "…"
```

`hooks.json` must live in **`$CODEX_HOME`**, not in the project. See
[Known limits](#known-limits).

## The twelve events

Codex 0.163.0 fires twelve hook events. Six of them map onto a capability this
runtime has; six are recognized and answered with `{}`.

| Codex event | Subcommand | What happens |
| --- | --- | --- |
| `PreToolUse` | `pretooluse` | Stagnation guard; may **deny** a provably repeated call |
| `PostToolUse` | `posttooluse` | Prunes bulky MCP tool output |
| `SessionStart` | `sessionstart` | Opens the session, may add context |
| `SessionEnd` | `sessionend` | Closes the session and flushes the ledger |
| `SubagentStop` | `substop` | Closing check for a subagent |
| `Stop` | `stop` | Closing verification; may **block** a completion claim |
| `PermissionRequest` | `permissionrequest` | No instruction (`{}`) |
| `UserPromptSubmit` | `userpromptsubmit` | No instruction (`{}`) |
| `PreCompact` | `precompact` | No instruction (`{}`) |
| `PostCompact` | `postcompact` | No instruction (`{}`) |
| `SubagentStart` | `subagentstart` | No instruction (`{}`) |
| `Interrupt` | `interrupt` | No instruction (`{}`) |

The second column is the subcommand; the kebab-case spellings `pre-tool-use`,
`post-tool-use`, `session-start`, `session-end`, `subagent-stop`,
`user-prompt-submit`, `permission-request`, `pre-compact`, `post-compact`,
`subagent-start` and `interrupt` parse to the same events.

### Two things about `hooks.json` that are not obvious

**1. `args` is silently dropped.** Codex runs a handler declared as
`{"command": "/path/hook.sh", "args": ["session-start"]}` with `argv = []`. The
event must be part of `command`, which is why every entry here reads
`harness-reflex hook pretooluse` rather than `command: "harness-reflex"` +
`args: ["hook", "pretooluse"]`. Measured with a probe hook that logged `$*`.

**2. Codex clamps the `SessionEnd` timeout to 3 s** and prints
`warning: clamping SessionEnd hook timeout to 3s`. The entry asks for 2 s, which
is inside the clamp and still above this runtime's 1.5 s internal budget.

The `PreToolUse` and `PostToolUse` matcher is `.*`. A matcher naming only MCP
tools would miss every shell call.

### Tagging the audit ledger

The decision ledger records which harness produced each decision, and its
historical default is `cc`. To attribute Codex sessions correctly, export:

```sh
export HARNESS_REFLEX_HARNESS=codex
```

Sessions then land in `codex-<hash>` instead of `cc-<hash>`. Nothing else
changes, and the default is untouched for existing setups.

Codex does execute the command through a shell, so on POSIX you can inline the
same thing in `hooks.json` (`"command": "HARNESS_REFLEX_HARNESS=codex harness-reflex hook stop"`)
— but the exported variable is the portable form and is what this package
documents.

## The MCP server

Codex reads MCP servers from `config.toml`:

```toml
[mcp_servers.harness-reflex]
command = "node"
args = ["/abs/path/to/dist/cli/index.js", "mcp"]
startup_timeout_sec = 20
```

Those eight tools are `reflex_choice`, `reflex_score`, `reflex_route`,
`reflex_screen`, `reflex_gate`, `reflex_prune`, `reflex_detect_stagnation`, and
`reflex_status_ledger`.

`codex mcp list --json` is the check that the config was understood. It reports
the server with `"enabled": true` and `"transport": {"type": "stdio", …}`.

> **Note.** The repository previously wrote `.codex/config.json` with an
> `mcpServers` object. Codex does not read that file. It is still written for
> backwards compatibility, but `config.toml` is the file that takes effect.

## Known limits

Read this section before assuming the integration is symmetric with Claude Code.

1. **Pruning only reaches MCP tool output.** Codex's `PostToolUse` accepts
   exactly one decision field, `updatedMCPToolOutput`, and only for MCP tools. A
   shell (`exec_command`) result **cannot** be rewritten. This is not a bug in
   the adapter; it is the host's contract. `reflex_prune` still works as a tool
   the model calls itself.

2. **`hooks.json` is loaded from `$CODEX_HOME`, not from the project.** A
   project-local `hooks.json` produced no hook invocations at all in testing.
   A project-local `.agents/hooks.json` worked in an earlier test only because
   that run also had it as `CODEX_HOME` — i.e. the same file in both roles. **The
   project-scoped path has not been reproduced on its own**; treat
   `$CODEX_HOME/hooks.json` as the supported one.

3. **`decision: "block"` on `Stop` is retried without a visible cap.** A Stop
   handler that always blocks was invoked repeatedly for one turn (the probe
   counted over 900 requests). Any blocking Stop implementation must honor
   `stop_hook_active` and stop blocking once it is `true`. This runtime does.

4. **Not verified on a real model.** See below.

## What has been verified, and what has not

Verified by running the real `codex-cli 0.163.0` binary:

- The shipped `hooks.json` (this package's file, unmodified) is loaded from
  `$CODEX_HOME/hooks.json` and its handler is invoked. A full turn with a local
  stand-in model produced `hook: SessionStart Completed`, `UserPromptSubmit
  Completed`, `PreToolUse Completed`, `PostToolUse Completed`, and `Stop
  Completed` — every one answered with valid JSON and exit 0.
- The hook wrote real state: `sessions/<harness>-<hash>/{meta,ledger,events}.jsonl`
  under `HARNESS_REFLEX_STATE_DIR`, with ledger lines for `pretooluse …
  stagnation`, `posttooluse … prune`, and `stop … closing`. That is the runtime
  deciding, not a probe script.
- A `PreToolUse` handler in `$CODEX_HOME/hooks.json` is invoked, and its stdin
  payload carries `session_id`, `transcript_path`, `cwd`, `model`,
  `permission_mode`, and `source`.
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` all fire, with
  `tool_name`, `tool_input`, `tool_use_id` on the tool events and
  `stop_hook_active`, `last_assistant_message` on `Stop`.
- A `PreToolUse` denial is honored:
  `Command blocked by PreToolUse hook: <reason>`.
- A `Stop` block is honored: the turn does not finish while `decision` is
  `"block"`.
- `codex mcp list --json` reads the `config.toml` server definition.
- Codex executes a hook `command` through a shell (an inline `VAR=value` prefix
  reached the handler and changed the session directory name).

**Not verified — do not claim otherwise:**

- **In-turn pruning.** No model was available (the host's model endpoint was
  unreachable), so a `PostToolUse` pruning decision was never observed reaching a
  model in a real turn. Tooling was not exercised end to end.
- **Stop interception in a real session.** The block mechanism was confirmed, but
  not against a genuine model completion claim.
- **The MCP tools inside a Codex turn.** The server definition is read, but the
  MCP process was not started and the eight tools never appeared in the turn's
  tool list on this machine. `tools/list` was verified by talking to
  `harness-reflex mcp` directly, which is the root package's contract, not
  Codex's.
