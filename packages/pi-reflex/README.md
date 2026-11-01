# pi-reflex

harness-reflex for the [pi coding agent](https://pi.dev): the eight `reflex_*`
tools, plus the four automatic interventions (prune, stagnation, correction,
closing), running **in process** inside pi.

This is a pi **extension**, not a shell hook. pi loads the TypeScript sources
directly with jiti — there is no build step for the extension itself.

- **Zero runtime dependencies.** `dependencies` is absent from the manifest on
  purpose; the host package is declared in `peerDependencies` with `"*"`.
- **Version target: pi `1.4.0`.** See [Version coupling](#version-coupling).

## Install

```bash
# As a pi package (recommended)
pi install ./packages/pi-reflex

# Or load it for one run, without installing anything
pi -e ./packages/pi-reflex/src/index.ts
```

A package manifest declares the entry point:

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

## What it does

### The eight tools

Registered with `pi.registerTool`, with the **same names, schemas and payloads**
as the MCP surface, so an agent that learned `reflex_gate` over MCP does not have
to relearn it here.

| Tool | Purpose |
|---|---|
| `reflex_choice` | Multi-class System One choice, returns a probability distribution |
| `reflex_score` | Score a statement or snippet against criteria, 0.0–1.0 |
| `reflex_route` | Rank candidate tools/skills against a goal |
| `reflex_screen` | Screen untrusted content for prompt injection |
| `reflex_gate` | Fail-closed verification of assertions against evidence |
| `reflex_prune` | Reduce bulky output, keep the diagnostic lines |
| `reflex_detect_stagnation` | Detect a loop, an oscillation, or repeated failure |
| `reflex_status_ledger` | Read decision counts, tokens saved, latency |

### The four automatic interventions

These run from pi's event hooks, not from tool calls:

| Capability | pi mechanism | Mode default |
|---|---|---|
| **Prune** | `tool_result` returns replacement `content` | `active` |
| **Stagnation** | `tool_call` returns `{ block: true, reason }` | `active` |
| **Correction** | `tool_result` appends a corrective note after repeated failure | `active` |
| **Closing** | `agent_before_settle` + `continue: true` | `observe` |

Configure each with an environment variable (`off` / `observe` / `active`):

```bash
REFLEX_PI_PRUNE=active
REFLEX_PI_STAGNATION=active
REFLEX_PI_GATE=active
REFLEX_PI_CLOSING=observe
```

`REFLEX_<CAP>` works as a fallback name, so one setting can cover every host.

## The closing check is honestly degraded here

**pi has no API that refuses to end a turn.** `agent_before_settle` can append
entries and set `continue: true` to ask for exactly one more model request; it
cannot veto the settle. So the closing check is not the Claude Code hard block:

1. The claim is judged against the turn's tool evidence.
2. **Contradiction, continuation unused** → append the correction, request one
   more request.
3. **Contradiction, continuation already spent** → let the settle proceed and
   record `closing-degraded-pass`.

The ledger distinguishes the hosts by label:

| Label | Host | Meaning |
|---|---|---|
| `closing-block` | Claude Code, DSH | The host actually refused the turn |
| `closing-degraded-pass` | **pi** | The contradiction survived the one continuation pi allows; the turn was let through and **recorded as a pass** |

pi never writes `closing-block`, because pi never blocks. This extension will not
pretend otherwise: `ClosingDegradeState` models the allowance explicitly, a
re-entrant settle cannot refill it, and `tests` assert that a pi ledger line can
never carry the block label.

## Environment traps

### `~/.pi` is read-only in a sandbox → `mkdir EROFS`

pi's default agent directory is `~/.pi`, with sessions under `~/.pi/agent/sessions`.
Under a read-only home (sandboxes, CI, containers), **any** pi run — with or
without this extension — dies in `mkdir EROFS` before an extension loads. It is a
pi boot failure, not a reflex failure, and it looks like the extension is broken.

Redirect both paths:

```bash
export PI_CODING_AGENT_DIR=/some/writable/dir/agent
export PI_CODING_AGENT_SESSION_DIR=/some/writable/dir/agent/sessions
```

Then copy `auth.json` and `models.json` from your real `~/.pi/agent` into that
directory so the run keeps your provider credentials. `scripts/e2e.mjs` does
exactly this.

### The global `pi` may not be 1.4.0

A globally installed `pi` can be older (for example `0.85.1`), and **older
versions do not fire `agent_before_settle` at all**. Check before debugging a
closing check that never runs:

```bash
pi --version
```

The e2e installs its own copy:

```bash
mkdir -p tmp/pi-verify && cd tmp/pi-verify
printf '{"name":"pi-verify","private":true}\n' > package.json
npm_config_cache="$PWD/.npmcache" npm install --no-audit --no-fund \
  @earendil-works/pi-coding-agent@1.4.0
```

### pi's cwd is the process cwd

A prompt like "run `./fixture.sh`" resolves against the directory pi was started
in, not the session directory. The e2e starts pi at the repository root and uses
repo-relative paths.

## Verify

```bash
npm run build          # root package (the decision core this extension calls)
npm run build:pi       # type-check + compile the extension (Node host use)
npm run test:pi        # unit tests: event mapping, payloads, closing degradation
npm run e2e:pi         # real pi 1.4.0 run: tools registered + prune reaches context
```

The pruning step asks a model to run a command, so it depends on the model
actually calling the tool. deepseek-flash sometimes answers from reasoning
instead, and then there is no bulky result to prune. The session is therefore
retried up to **twice**, the adopted attempt is printed
(`pruning session (attempt 2 of 2 adopted)`), and only two failed attempts count
as a failure. The retry absorbs model flakiness — it does not paper over a broken
extension: a session that ran but produced no marker still fails.

`npm run e2e:pi` asserts, on a real model:

1. `pi --version` is 1.4.0;
2. pi boots with the extension and all eight `reflex_*` tools are visible to the
   model, with pi's own tools still present;
3. a bulky `bash` result is replaced, the replacement carries
   `… [reflex prune: full original retrievable as originals/<digest>.txt] …`,
   the diagnostic tail survives, and the original is retrievable by that locator;
4. offline, the closing hook buys exactly one continuation and then records
   `closing-degraded-pass`, never `closing-block`.

Step 4 is offline because a well-behaved model declines to state a false
completion claim on request, so a prompt cannot reliably reach the closing path.
The event pi fires is replayed in its real shape instead.

## Layout

```
packages/pi-reflex/
├── package.json          # pi.extensions, peerDependencies only
├── src/
│   ├── index.ts          # the factory: registers tools, wires pi's events
│   ├── pi-adapter.ts     # **the only file that knows pi's event shapes**
│   ├── tools.ts          # the eight tools, schemas shared with MCP
│   └── *.test.ts         # unit tests
└── scripts/
    ├── e2e.mjs           # the real-machine check (network + real model)
    └── closing-check.mjs # the closing contract, offline
```

## Version coupling

pi 1.x is still changing. Every pi-specific assumption — event field names,
content-block shapes, the `agent_before_settle` result, `stop_hook_active`
emulation — lives in **`src/pi-adapter.ts`** and nowhere else. When pi renames
something, that file and its tests are the whole change.

`src/index.ts` imports the decision core from the repository root
(`../../../src/hook/decision.js`) rather than keeping a copy, so a decision rule is
fixed in exactly one place for every host.

## License

MIT.
