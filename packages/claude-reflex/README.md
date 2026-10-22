# claude-reflex — Claude Code plugin

One plugin directory carrying the three surfaces Claude Code gives an extension:

| Surface | File | Role |
| --- | --- | --- |
| **mod** (in-process) | `hooks/register.js` (declared by `hooks/hooks.json` → `modules`) | `turn.step` effort seam; `tool.call` pass-through. Requires Claude Code v2.1.287+. |
| **settings hooks** | `hooks/hooks.json` → `hooks` | PreToolUse / PostToolUse / PostToolUseFailure / Stop / SubagentStop (off by default) / SessionStart / SessionEnd, each dispatching to `harness-reflex hook <event>`. |
| **MCP server** | `.mcp.json` | The root package's stdio server, so the eight `reflex_*` tools are available as `mcp__plugin_claude-reflex_harness-reflex__reflex_*`. |

Defaults: pruning, stagnation and failure correction are **active**; the closing
check is **observe** (it records what it would block, and never changes the
model-visible output). Set the `Closing verification mode` option to `active`
to opt in. See [`docs/claude-code.md`](../../docs/claude-code.md) for install,
configuration, limits and the verified/unverified split.

Prerequisite: the `harness-reflex` executable on `PATH` (`npm i -g harness-reflex`,
`npm link`, or `PATH="$PWD/dist/cli:$PATH"` for a checkout).
