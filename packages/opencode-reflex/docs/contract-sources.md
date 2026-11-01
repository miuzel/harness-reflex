# Contract sources: OpenCode

Every rule this package encodes is cited here so a reviewer can re-check it
without trusting the implementation. Two kinds of evidence are used:

- **Docs page** — the vendor's published documentation.
- **Package artifact** — a `.d.ts`/`.js` file inside a published npm tarball
  (`npm pack`), which is the code the host actually runs and therefore the
  tie-breaker when docs and typings disagree.

Read on **2026-11-02** against `@opencode-ai/plugin@1.19.5` and
`@opencode-ai/sdk@1.19.5`. Tarballs were fetched with `npm pack` into a scratch
directory; they are gitignored and not vendored. Paths below are relative to the
extracted `package/` directory.

## 1. Plugin shape

- Docs: <https://opencode.ai/docs/plugins/>
  - A plugin is a JS/TS module exporting a function that receives a context and
    returns a hooks object:
    `export const MyPlugin = async ({ project, client, $, directory, worktree }) => ({ … })`.
  - Local plugins: `.opencode/plugins/` (project) and `~/.config/opencode/plugins/`
    (global); npm plugins are listed in `opencode.json` under `plugin`.
  - The docs' own blocking example throws from `tool.execute.before`:
    `throw new Error("Do not read .env files")`.
- Package artifact: `dist/index.d.ts` — `@opencode-ai/plugin`
  - `export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;`
  - `PluginInput = { client, project, directory, worktree, experimental_workspace, serverUrl, $ }`
  - `Hooks` members used here: `event`, `tool.execute.before`,
    `tool.execute.after`, `permission.ask`, `chat.params`, `chat.headers`,
    `tool.definition`, `shell.env`, …
  - `"tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string }, output: { args: any }) => Promise<void>`
  - `"tool.execute.after"?: (input: { tool: string; sessionID: string; callID: string; args: any }, output: { title: string; output: string; metadata: any }) => Promise<void>`
  - `"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>`
  - `"event"?: (input: { event: Event }) => Promise<void>`
- Package artifact: `dist/tool.d.ts` — `tool({description, args, execute})`,
  `ToolContext = { sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }`.
  This package does **not** register custom tools through `tool()`: the eight
  `reflex_*` tools come from the root package's MCP server, which keeps the tool
  surface identical to every other host.

## 2. Event payloads

From `@opencode-ai/sdk@1.19.5`, `dist/gen/types.gen.d.ts` (the `Event` union):

- `EventSessionCreated = { type: "session.created"; properties: { info: Session } }`
  and `Session = { id, projectID, directory, parentID?, … }`.
- `EventSessionDeleted = { type: "session.deleted"; properties: { info: Session } }`.
- `EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }`.
- `EventSessionError = { type: "session.error"; properties: { sessionID?, error? } }`.

`session.idle` carries **no assistant text**, which is why the Stop decision
cannot be evaluated meaningfully from it; and OpenCode publishes no plugin-level
veto for a finished turn, which is why a Stop objection is logged rather than
enforced.

## 3. MCP configuration

- Docs: <https://opencode.ai/docs/mcp-servers/>
  - Servers live under the **`mcp`** key of `opencode.json` — **not**
    `mcpServers` (the key used by Claude Code and Kimi Code in this repository).
  - Local server shape:
    ```json
    { "mcp": { "name": { "type": "local", "command": ["npx", "-y", "pkg"], "enabled": true,
                          "environment": { }, "cwd": "…", "timeout": 30000 } } }
    ```
  - `command` is an **array** (program plus arguments); there is no `args` field.
  - Remote servers use `{ "type": "remote", "url": …, "headers"?, "oauth"? }`.
  - MCP tools are registered with the server name as prefix, and can be
    disabled with glob patterns under `tools`.
- Docs: <https://opencode.ai/docs/config/>
  - Config locations and precedence: remote `.well-known/opencode` → global
    `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → project
    `opencode.json` → `.opencode` directories → `OPENCODE_CONFIG_CONTENT` →
    managed files.
  - Both JSON and JSONC are accepted; schema at <https://opencode.ai/config.json>.

## 4. Why this package ships JavaScript, not a shell hook

OpenCode's only extension point is a plugin module. There is no configuration
field that maps an event to a shell command — unlike Claude Code (`hooks.json`),
Kimi Code (`[[hooks]]` in `config.toml`) and Codex. The repository rule "use a
shell hook when the host offers one" therefore cannot apply here without
inventing a mechanism the host does not have. The plugin keeps the cost low by
spawning the one `harness-reflex` command per interception, which is the same
work the shell-hosted plugins do.

## 5. What could not be verified

`opencode` starts on this machine but dies before a plugin can load:

```
$ opencode --version
PlatformError: Unknown: FileSystem.open (~/.local/share/opencode/log/opencode.log)
```

The sandbox cannot write `~/.local/share`, so the host cannot initialise and no
plugin hook has ever been executed by a real OpenCode process. The plugin was
verified only through its own exported functions plus the real hook CLI. See
`README.md` for the reproduction recipe.
