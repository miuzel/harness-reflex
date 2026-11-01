# harness-reflex for OpenCode

An [OpenCode](https://opencode.ai) plugin that routes tool interceptions through
the `harness-reflex` decision runtime, plus the MCP entry that exposes the eight
`reflex_*` tools.

> **Not verified on a real host.** `opencode` starts on the machine this package
> was written on but throws before it can load a plugin:
> `PlatformError: Unknown: FileSystem.open (~/.local/share/opencode/log/opencode.log)`.
> What *is* verified: the plugin's shape, its hook names, the payload it builds,
> the four verdict mappings and the fail-open paths, all asserted offline against
> the real decision layer (`npm run test:opencode-plugin`). See
> [Verification status](#verification-status).

## Install

1. Install the runtime so the bare `harness-reflex` command resolves on `PATH`
   (the plugin spawns that command; it never imports a host SDK):

   ```sh
   npm install -g harness-reflex     # or: npm link, from a checkout
   harness-reflex --help
   ```

2. Put the plugin where OpenCode loads plugins from — project
   `.opencode/plugins/reflex.js`, or global `~/.config/opencode/plugins/reflex.js`:

   ```sh
   mkdir -p .opencode/plugins
   cp plugin/reflex.js .opencode/plugins/
   ```

3. Merge [`opencode.json`](./opencode.json) into your config (project
   `opencode.json`, or `~/.config/opencode/opencode.json`). Note the key is
   **`mcp`**, not `mcpServers`, and a local `command` is an **array**:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "harness-reflex": { "type": "local", "command": ["harness-reflex", "mcp"], "enabled": true }
     }
   }
   ```

4. Restart OpenCode and confirm the eight `reflex_*` tools are listed.

Optional: set `HARNESS_REFLEX_BIN` to an absolute path if the command is not on
the host's `PATH`, and `HARNESS_REFLEX_TIMEOUT_MS` to change the 3000 ms decision
deadline.

## Capability matrix

| Capability | Hook | Reaches the model? | Why |
| --- | --- | --- | --- |
| Stagnation gate (refuse a repeated call) | `tool.execute.before` | **yes** — the call is refused | `permissionDecision: "deny"` is thrown as an `Error`, the host's documented way to refuse a call |
| Result pruning | `tool.execute.after` | **yes** — `output.output` is replaced | This is the text the model reads, so OpenCode is the one non-Claude host where automatic pruning actually takes effect |
| Session notice / GC | `event` (`session.created`, `session.deleted`) | **no** | OpenCode events are one-shot; the decision is recorded in the ledger only |
| Closing verification (refuse a contradicted "done") | `event` (`session.idle`) | **no** | The event carries no assistant text, and the host publishes no plugin-level veto for a finished turn; an objection is logged (`client.app.log`, level `warn`) instead of being enforced |
| Failure correction | — | **no** | OpenCode has no tool-failure hook in `Hooks`; nothing is invented here |

### Why this host gets a JS plugin while the others get shell hooks

Claude Code, Kimi Code and Codex all let a config file map an event to a shell
command. OpenCode does not: its only extension point is a plugin module
(`Plugin = (input) => Promise<Hooks>`), so "use a shell hook when the host offers
one" cannot apply. The plugin stays dependency-free — `node:child_process` plus
the installed `harness-reflex` command — and reuses the same decision layer every
other host uses, rather than reimplementing it in JavaScript. The cost is one
short-lived process per interception, the same as a command hook.

## Verification status

**Verified offline** (all green in `npm run test:opencode-plugin`):

- the config contract: servers under `mcp`, local `command` as an array, no
  `args` field, and a real MCP handshake returning the eight tool names;
- the plugin entry point and its hook names against
  `@opencode-ai/plugin@1.19.5`'s `Hooks` type;
- the plugin imports nothing but `node:child_process` and declares no runtime
  dependencies;
- allow / deny / rewrite / block, driven through the real
  `harness-reflex hook <event>` command with OpenCode-shaped payloads;
- fail-open on a missing binary, a broken binary, and a timeout.

**Not verified** (no working host):

| Unverified claim | Reproduce with |
| --- | --- |
| OpenCode loads `.opencode/plugins/reflex.js` and calls the hooks | Start OpenCode in a project with the plugin installed; the plugin should register with no error. Run `opencode debug config` to confirm the `mcp` block is resolved |
| Throwing from `tool.execute.before` really aborts the tool call | Set `HARNESS_REFLEX_MODE=active`, run one identical command three times; the third should be refused with the ledger's reason |
| Replacing `output.output` really changes what the model reads | Run a command with large output; compare a session with pruning on and off. The ledger should record a `prune` entry with `applied: true` |
| `session.created` / `session.deleted` payload shape stays `properties.info.id` | Check `opencode --print-logs` output, or call `client.app.log` inside the plugin with the event type |
| `session.idle` fires once per turn and not per message | Observe the warn log lines from a multi-turn session |

The vendor sources for every rule above — including the exact `.d.ts` files and
the `mcp`-vs-`mcpServers` difference — are in
[`docs/contract-sources.md`](./docs/contract-sources.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `HARNESS_REFLEX_BIN` | absolute path to the `harness-reflex` command |
| `HARNESS_REFLEX_TIMEOUT_MS` | per-decision deadline (default 3000) |
| `HARNESS_REFLEX_MODE` | `off` / `observe` / `active` for every capability at once |
| `HARNESS_REFLEX_PRUNE_MODE`, `_STAGNATION_MODE`, `_GATE_MODE`, `_CLOSING_MODE` | per-capability override |
| `HARNESS_REFLEX_STATE_DIR` | where the ledger and retained originals live |
| `SYSTEM_ONE_BACKEND` | `mock` / `simple-jev` / `jev` / `vllm` |

Pruning and stagnation default to `active`; closing defaults to `observe`, so no
warning is logged until you opt in.
