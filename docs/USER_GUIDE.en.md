# Harness Reflex User Guide (v0.1.0-alpha.2)

> This is the complete manual for the **`dsh-reflex` plugin** and the
> **`harness-reflex` core package**. The same text is embedded into
> `packages/dsh-reflex/client.js`, so it can be read directly in the DSH
> settings panel under the **“Guide”** tab (it follows the DSH interface
> language, Chinese or English).
> Editing this file therefore requires re-running `npm run build:all`, otherwise
> the panel keeps the previous revision (`npm run test:plugin` checks the
> document digest and fails on drift).

---

## 1. What Harness Reflex is

Harness Reflex is a **System One (fast-thinking) decision runtime**: without
paying for generative System Two reasoning it performs millisecond-scale
probabilistic judgements — verification gates, context pruning, stagnation
breaking, model routing and reasoning-effort decisions — and records every
decision in an auditable ledger.

It ships in two forms with identical capabilities:

| Form | Package | Harness | Transport |
| --- | --- | --- | --- |
| stdio MCP server | `harness-reflex` | Claude Code, Codex CLI, AGY | MCP JSON-RPC child process |
| DSH Host plugin | `dsh-reflex` | DeepSeek Harness (`dsh`) | In-process `ctx.tools` / Cordis hooks |

Both expose the same tool names, arguments and payloads, so one agent prompt can
be reused across harnesses.

---

## 2. Plugin architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                          Harness Layer                               │
│   Claude Code (.mcp.json) · Codex (.codex/config.json) · AGY bundle   │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ stdio MCP                        │ in-process DSH Cordis
┌───────────────▼──────────────────┐  ┌────────────▼───────────────────┐
│ harness-reflex core (dist/)      │  │ dsh-reflex plugin              │
│  gate · prune · stagnation       │◄─┤  src/bridge.ts  ReflexRuntime  │
│  route · screen · score          │  │  src/tools.ts   8 reflex_*     │
│  ledger · calibrate              │  │  src/router.ts  virtual provider│
└───────────────┬──────────────────┘  │  src/effort.ts  effort intercept│
                │ DecisionBackend     │  src/panel-*    settings + API  │
┌───────────────▼──────────────────┐  └────────────┬───────────────────┘
│ mock · simple-jev/vLLM · Jev API  │               │ settings.section
└──────────────────────────────────┘  ┌────────────▼───────────────────┐
                                      │ client.js browser panel (React) │
                                      │ Overview / Virtual provider /   │
                                      │ Effort / Backend / Ledger /Guide│
                                      └────────────────────────────────┘
```

Key modules of the plugin:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Cordis entry `apply(ctx, config)`; install and teardown inside one `ctx.effect` |
| `src/bridge.ts` | `ReflexRuntime`: backend / ledger / calibrator / decision services of one activation |
| `src/tools.ts` | The eight `reflex_*` tools (Host `defineTool` validation plus an undeclared-argument fence) |
| `src/router.ts` | `VirtualModelRouter`: candidate pool → System 1 decision → fallback / fail-closed → audit |
| `src/virtual-adapter.ts` | `LlmAdapter` surface of the virtual provider plus a dispatch-layer safety net |
| `src/routing.ts` | `installModelRouting`: registers the virtual provider, hooks `agent/pre-step` and `agent/request` |
| `src/effort.ts` | `EffortInterceptor`: per-turn reasoning-effort decision, projection and status reporting |
| `src/session-audit.ts` | Writes/reads `plugin:dsh-reflex/effort` session records without polluting model context |
| `src/panel-api.ts` | Read-only panel projection and the `/api/dsh-reflex/*` routes (loopback only) |
| `src/client/*` | Browser half: slot registration, zh/en copy, Markdown renderer, panel views |

Activation order: DSH loads the plugin → `apply` resolves the configuration →
`ReflexRuntime` is built → the virtual provider and request hooks are installed →
the eight tools are registered → the panel routes are mounted. Unloading unwinds
in reverse and is fully reversible.

---

## 3. Install and build

```bash
# 1) install dependencies and build (root → link host deps → plugin → client bundle)
npm install
npm run build:all

# 2) configure a target harness (writes .mcp.json / .codex/config.json / the AGY bundle)
node dist/cli/index.js setup all      # or claude | codex | agy

# 3) install as a DSH plugin (in-process integration, recommended)
dsh plugin add ./packages/dsh-reflex
```

Every step of `npm run build:all` is required:

1. `tsc`: root `src/` → `dist/`;
2. `node scripts/link-dsh-deps.mjs`: symlinks this machine's `@deepseek-ai/*`
   packages into `packages/dsh-reflex/node_modules/` (fully offline, no registry);
3. `tsc -p packages/dsh-reflex/tsconfig.json`: plugin Host half → `packages/dsh-reflex/dist/`;
4. `node scripts/embed-user-guide.mjs` + `tsc -p tsconfig.client.json` +
   `node packages/dsh-reflex/dist/client-bundle.js packages/dsh-reflex`:
   embeds this manual into the browser half and emits the single-file `client.js`.

> The order is not interchangeable: `client.js` must be built after this
> document changes, otherwise the panel shows a guide that differs from the
> repository document.

---

## 4. System 1 backend configuration

All three backends share one set of `SYSTEM_ONE_*` environment variables and
plugin options; resolution order is “plugin config > environment > default mock”.

| Backend | Value | Notes |
| --- | --- | --- |
| Local heuristics (default) | `mock` | Deterministic, no network, sub-millisecond; for offline dev and tests |
| Generic logits read-out | `simple-jev` | vLLM / OpenAI-compatible `max_tokens: 1` with next-token logprobs |
| Official Jev / System One API | `jev` | `POST {BASE_URL}/v1/...`, requires an API key |

```bash
# Official Jev
export SYSTEM_ONE_BACKEND=jev
export SYSTEM_ONE_API_KEY="your-api-key"
export SYSTEM_ONE_BASE_URL="https://api.typesafe.ai/v1/systemone"

# Self-hosted vLLM (OpenAI compatible)
export SYSTEM_ONE_BACKEND=simple-jev
export SYSTEM_ONE_BASE_URL="http://localhost:8000"
export SYSTEM_ONE_MODEL="Qwen/Qwen2.5-7B-Instruct"
```

Plugin options (editable on the “System 1 backend” page, or in the DSH plugin config):

| Option | Default | Notes |
| --- | --- | --- |
| `backend` | `auto` | `auto` derives from the environment; may be pinned to `mock` / `simple-jev` / `jev` |
| `baseUrl` | unset | System 1 endpoint; unset uses the backend default |
| `model` | unset | Server-side model id (required by `simple-jev`) |
| `apiKeyEnv` | `SYSTEM_ONE_API_KEY` | Stores the **variable name only**; the secret never enters the settings document |
| `timeoutMs` | `2000` | Per-decision timeout; a timeout follows the “System 1 unavailable” degradation path |

Calibration (optional): fit a PAVA/ECE curve with the `calibrate` engine over a
labelled sample, then point `calibrationPath` at that JSON and the runtime will
correct over-confident raw probabilities.

---

## 5. Virtual provider and model pools

**Concept.** The plugin registers one virtual provider (id `reflex` by default)
that generates no tokens itself: when a request targets a virtual model such as
`reflex/reflex-auto`, the `agent/request` hook asks System 1 to pick a real
`provider/model` from that virtual model's **physical candidate pool**, rewrites
the request, lets it continue, and appends a `type: model-route` ledger entry.

Configuration shape (YAML equivalent):

```yaml
routing:
  enabled: true
  virtualProvider: reflex
  maxTaskChars: 400          # task-text budget per participating agent
  fallback: deepseek:deepseek-chat   # used when no pool can answer
  models:
    reflex-auto:             # virtual model id
      - provider: deepseek
        model: deepseek-reasoner
        description: long-horizon reasoning and refactors
        tags: [reasoning, expensive]
      - provider: deepseek
        model: deepseek-chat
        description: everyday chat and quick edits
        tags: [fast, cheap]
    reflex-fast:
      - provider: deepseek
        model: deepseek-chat
        description: latency-sensitive work
        tags: [fast]
```

**Rules and boundaries.**

- `enabled: false`, or an empty `models` map ⇒ no virtual provider is
  registered and behaviour matches an installation without the plugin.
- An empty pool with no `fallback` ⇒ **fail-closed**: an error instead of a
  random dispatch.
- `virtualProvider` may not contain `:`; candidate `provider` and `model` may
  not be empty.
- Primary agents and subagents share the same interception path, and the loop
  identity survives the rewrite unchanged.
- Candidates, the selection, confidence and latency all reach the ledger, which
  the “Decision ledger” page replays.

**Context awareness and session stickiness (cache savings, no gratuitous
switches).** Changing models invalidates the server-side prompt prefix cache, so
routing is not “pick again every turn”: by default it **holds the physical model
the session is already using**.

- The plugin accumulates, per agent, the context size it has observed for this
  session (the characters `agent/pre-step` hands it, at roughly 4 characters per
  token) and gives every decision both that number and the **current physical
  model** (`state.currentModel` / `state.contextTokens` / `state.contextChars`).
- The decision prompt states the policy as well: keeping the current model keeps
  the prompt cache, so switch only when another candidate is **clearly better
  suited**. The current candidate is marked in the list with
  `[current model — keeping it preserves the prompt cache]` and the `current: true`
  flag, so a text-reading backend and a flag-reading backend see one signal.
- After the backend ranks the pool, a **sticky gate** still applies: a challenger
  must score higher *and* by more than a relative `stickyMargin` (15% by default)
  before the request actually moves. Ties and marginal wins stay put.
- Every `model-route` entry records `currentModel`, `switched` and
  `contextTokens`, so “why did this turn not switch” is replayable rather than
  guessed.
- Stickiness only applies **inside one pool**: when the current model is not a
  candidate this turn (say the session moved to another virtual model), the pool’s
  own ranking decides and `switched` is recorded as `true`.

**Configuring it in the panel.** Open DSH settings → “Reflex runtime” →
**Virtual provider**: toggle routing, fill in the provider name, the fallback
target and the task-text budget, then add virtual models and candidates
(up/down reorders them) and press **Save** to write the whole group. The panel
validates through the same Host-side `resolveConfig` used at load time, so an
invalid document (empty id, duplicate model, cross-group mistake) is rejected
with a specific message.

---

## 6. Adaptive reasoning effort (`reflex` / `auto`)

With the effort policy set to `reflex` (alias `auto`), the plugin intercepts the
intent and context before each real API request, asks System 1 for the
`reasoningEffort` this turn needs, and rewrites the outgoing parameter.

| Option | Default | Notes |
| --- | --- | --- |
| `effort.reasoningEffort` | unset | `reflex` / `auto` = per-turn adaptive; `off`/`minimal`/`low`/`medium`/`high`/`max` = pinned level; unset = never intervene |
| `effort.fallback` | `medium` | Deterministic cue vote used when System 1 is unavailable or below the confidence floor |
| `effort.minConfidence` | `0.55` | Decisions below this confidence go to the fallback instead |

**Behaviour contract.**

- An `reasoningEffort` pinned explicitly by the caller always stays transparent;
  the plugin never overrides it.
- A target model that does not support thinking levels degrades safely instead
  of receiving the parameter verbatim.
- Every turn writes one audit record (`plugin:dsh-reflex/effort`) containing the
  decided level, the confidence and a truncated task excerpt; it never enters
  the model-visible context.
- The decision is projected to the status line as well; the Overview page shows
  the latest one (for example `reflex: high (confidence 0.82, system-one, 12.4 ms)`).

---

## 7. Settings panel (DSH Settings UI)

The plugin declares its browser half through `dsh.client` and registers into the
`settings.section` slot:

| Tab | Content |
| --- | --- |
| Overview | Decision count, tokens saved, average latency, gate pass/fail, latest adaptive decision |
| Virtual provider | Routing switch, provider name, pool editing and ordering, fallback target |
| Reasoning effort | Policy (`reflex`/`auto`/a concrete level), fallback level, minimum confidence |
| System 1 backend | Implementation, base URL, model id, API-key variable name, timeout |
| Decision ledger | Live metrics, recent-decision table, JSONL sink, clear (confirmed twice) |
| **Guide** | **A read-only view of this manual, following the DSH interface language** |

- Saving is **whole-group**: editing one field validates and writes the entire
  configuration group.
- When the Host settings document is read-only the page becomes read-only and
  every write control is disabled.
- Panel routes under `/api/dsh-reflex/*` accept loopback clients only, and
  clearing the ledger requires an explicit confirmation.

---

## 8. MCP tools ↔ DSH native tools

Both forms expose the **same eight tools** with identical arguments and payloads;
only registration and call overhead differ.

| Capability | MCP tool name (`harness-reflex mcp`) | DSH in-process tool (`dsh-reflex`) | Main arguments |
| --- | --- | --- | --- |
| Multi-option classification | `reflex_choice` | `reflex_choice` registered via `ctx.tools` | `question`, `options[]` |
| Continuous rating | `reflex_score` | `reflex_score` | `statement`, optional `rubric` |
| Prompt-injection screen | `reflex_screen` | `reflex_screen` | `payload`, optional `source` |
| Claim/evidence gate | `reflex_gate` | `reflex_gate` | `claims[]` or `statement`+`evidence` |
| Long-output pruning | `reflex_prune` | `reflex_prune` | `text`, optional `query` |
| Stagnation detection | `reflex_detect_stagnation` | `reflex_detect_stagnation` | `recentAction`, optional `history[]` |
| Candidate ranking | `reflex_route` | `reflex_route` | `goal`, `candidates[]`, optional `topK` |
| Ledger audit | `reflex_status_ledger` | `reflex_status_ledger` | none (returns a `LedgerSummary`) |

Differences:

- The tool-name prefix is configurable (`toolPrefix`, default `reflex_`), so
  `rv_` yields `rv_gate` and friends.
- On the DSH side argument validation comes from the Host's `defineTool`
  (required/type/enum/nested) plus an undeclared top-level argument fence; on the
  MCP side `harness-reflex` validates itself and returns structured errors.
- `reflex_status_ledger` on the DSH side summarises **the current activation**;
  whether the ledger persists depends on `ledgerPath` (unset keeps it in memory
  and never writes into the user's project).

---

## 9. Decision ledger and audit

Every judgement appends one JSONL record (`type` is one of `gate`, `prune`,
`stagnation`, `route`, `model-route`, `effort`, `choice`) carrying the backend,
latency, confidence, token-savings estimate and a truncated detail field:

```bash
node dist/cli/index.js ledger      # terminal summary
```

- `ledgerPath` unset ⇒ memory only, gone with the process (the default, so user
  projects stay untouched);
- a configured path ⇒ append-only JSONL with replay, and the panel's ledger page
  shows the sink path;
- clearing the ledger needs two consecutive clicks in the panel; only the second
  one deletes the entries and the JSONL file.

---

## 10. Tests and release

```bash
npm test                 # root package: ledger / score / MCP surface / packaging manifest
npm run test:plugin      # DSH plugin: registration, strict validation, 8 tools, routing, effort, panel, guide
npm run test:mutation    # negative control: injected faults must be caught by the suite (or the compiler)
npm run test:all         # build:all + both suites
npm run release          # all suites + pack and verify the tarballs in release/
npm run release:pack     # pack and verify only (no tests; run build:all first)
```

Release artifacts (`release/`):

| Artifact | Content |
| --- | --- |
| `harness-reflex-<version>.tgz` | Root package: `dist/`, `README.md`, `docs/`, `USER_GUIDE.md`, `experiments/` |
| `dsh-reflex-<version>.tgz` | Plugin: `dist/`, `client.js` (with this manual embedded), `cordis.patch.yml`, `locale/` |
| `SHA256SUMS` | SHA-256 checksums of the two tarballs |
| `release-report.json` | The per-check packaging audit (entries, dead links, dependency declarations, install smoke) |
| `RELEASE-<version>.md` | Release notes: install commands, verification checklist, contents |

The verifier `scripts/release-pack.mjs` extracts each tarball and asserts: every
required file is present, no test build or temporary directory ships, the
`exports`/`bin`/`dsh.bundle.patch` targets really exist, and every relative
import and source map resolves inside the package (zero dead links). It then
installs the root tarball into a scratch directory and exercises `import` plus
stdio MCP `tools/list` for real.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No “Reflex runtime” entry in settings | The Host half is not loaded or registered no configuration namespace; re-check `dsh plugin add` and reload `dsh` |
| The panel is read-only | The DSH settings document is not writable; disabled writes are expected in that mode |
| A virtual model errors instead of dispatching | The pool is empty and `routing.fallback` is unset; add candidates or a fallback target |
| Text is not routed as expected | Check `routing.enabled`, the virtual model id spelling, and whether the agent actually requested that virtual model |
| Reasoning effort never changes | The policy is unset (no intervention), or the caller pinned `reasoningEffort` explicitly |
| System 1 decisions always fall back | `timeoutMs` too small, `baseUrl` unreachable, or `minConfidence` too high; check the latest decision and backend state on the Overview page |
| The in-panel guide is stale | `USER_GUIDE.md` changed without a rebuild; run `npm run build:all` |

---

## 12. Version and compatibility

- Version: `harness-reflex` and `dsh-reflex` ship together at v0.1.0-alpha.2;
- Node: `>= 18` (root package `engines`); DSH Host dependencies `@deepseek-ai/*@0.2.1-alpha.4`;
- Host contracts are declared as `peerDependencies`, so the plugin never bundles
  a second copy of Host modules;
- The eight-tool stdio MCP surface has been frozen since v0.1.0; a Host-side
  change must not silently alter its payloads.
