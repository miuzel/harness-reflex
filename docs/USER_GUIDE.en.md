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

Both share tool names, main arguments and payloads, so one agent prompt can be
reused across harnesses. See section 9 and each surface's actual tool definitions
for argument and validation boundaries.

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
the four default tools (five with `route` switched on) are registered →
the `/reflex-ledger` command is registered → the panel routes are mounted.
Unloading unwinds in reverse and is fully reversible.

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
| `effort.reasoningEffort` | unset | `reflex` / `auto` = per-turn adaptive; unset = never intervene, the plugin never touches `reasoningEffort`; a concrete level is chosen in the model selector, not in configuration |
| `effort.fallback` | `medium` | Deterministic cue vote used when System 1 is unavailable or below the confidence floor |
| `effort.minConfidence` | `0.55` | Decisions below this confidence go to the fallback instead |
| `effort.enabled` | `true` | `false` turns the whole layer off: no judgment, no audit, no injected `reflex` level |

Configuration answers exactly one question: **should adaptive effort run at all?**

- **blank (the default) = never intervene**: the plugin never rewrites
  `reasoningEffort` and produces no decision or audit record, so the request
  behaves exactly as if this feature were not installed;
- **`reflex` (alias `auto`) = adaptive**: every turn is decided by System 1;
- **to fix the thinking depth**: choose a concrete level in the model selector.
  Configuration no longer accepts
  `off`/`minimal`/`low`/`medium`/`high`/`max`; writing one is rejected at startup
  with the migration hint instead of being silently ignored.

**Behaviour contract.**

- A concrete `reasoningEffort` chosen explicitly by the caller on the request
  always stays transparent; the plugin never overrides it.
- A target model that does not support thinking levels degrades safely instead
  of receiving the parameter verbatim.
- Every turn writes one audit record (`plugin:dsh-reflex/effort`) containing the
  decided level, the confidence and a truncated task excerpt; it never enters
  the model-visible context.
- The decision is projected to the status line as well; the Overview page shows
  the latest one (for example `reflex: high (confidence 0.82, system-one, 12.4 ms)`).

**Turning the whole layer off (`effort.enabled: false`).**

`effort.enabled` is a **capability switch**, independent of what the policy is:
`reasoningEffort: reflex` together with `enabled: false` is a legitimate
combination whose meaning is "install none of this interception" (the only
difference being that the policy is still written down). With it off:

- **no judgment**: no System 1 call, no cue vote, no judgment cache, and no
  `reflex/effort` status published — the Overview page shows no decision of this
  plugin;
- **no audit**: no `effort-decision` entry in the ledger and no
  `plugin:dsh-reflex/effort` record in the session log;
- **no injected level**: the level this plugin injected (`reflex` / `auto`) is
  revoked from the model selector, which keeps only the adapter's own levels and
  its declared default;
- **concrete levels pass through verbatim**: a `high`, `medium` and so on chosen
  explicitly by the caller on the request is not even aligned onto the routed
  model's vocabulary;
- **the marker still cannot leak**: if an old session or a hand-built call still
  carries this plugin's marker, it is **deleted at the physical adapter
  boundary** rather than translated into a level, so the provider's own default
  applies and no plugin marker ever reaches a real provider.

It defaults to `true` (omitted means `true`), so not writing this option behaves
byte-identically to before.

---

## 7. Automatic intervention gates (`off` / `observe` / `active`)

The plugin can intervene on its own through the Host's native hooks, **without the
model calling any `reflex_*` tool**. There is exactly one switch, `interventions.mode`, taking `off`,
`observe` or `active`, and it defaults to `observe`:

```yaml
interventions:
  mode: observe        # off | observe | active
  capabilities:        # optional per-capability override; inherit follows mode
    stagnation: inherit
    prune: inherit
    gate: inherit
    closing: inherit
  maxInterventionsPerTurn: 3
  maxJudgmentsPerTurn: 3
  maxJudgmentsPerSession: 20
```

Each of the four capabilities is **four-state**: `off` / `observe` / `active`
override `mode` explicitly, while `inherit` (or omitting it) follows `mode`. You
can therefore keep the gate `active` overall and lower `prune` alone to
`observe` (accounting only, no rewriting), or set everything to `off` and open
up `gate` only.

| Mode | Behaviour |
| --- | --- |
| `off` | No hook listener is registered at all; tool execution is byte-identical to running without the plugin |
| `observe` (default) | Full detection and judging, accounting only: no content rewriting, no injected message, no refused tool, no steer |
| `active` | The full chain: a repeated call is refused before it runs, an oversized result is pruned before it enters the context, a repeated failure is rewritten into corrective feedback, and a turn closing on contradicted evidence is objected to |

| Capability | Hook | What `active` does |
| --- | --- | --- |
| `stagnation` | `tools/pre-execute`, `agent/pre-step` | After a confirmed repetition or oscillation, refuses that call or attaches corrective context to the next step |
| `prune` | `tools/post-execute` | For a result above the threshold, retains the original first and then rewrites: the original goes into the session log under a locator, and the replacement keeps head and tail and names that locator |
| `gate` | `tools/post-execute` | Rewrites the result into corrective feedback once one call has failed repeatedly; failure is read from the tool source's structured exit status or the Host's exit badge, never from wording |
| `closing` | `agent/turn-stopping` | Re-checks the turn's claims against its evidence with `reflex_gate` and steers once when they contradict |

### Why a legitimate wait is never treated as stagnation (the exemption default)

Waiting on a background job is legitimate work, so `stagnation` exempts **structurally
identifiable wait queries**. The decision reads two structured facts only — it never parses a
tool's description and never reads any output text:

1. **tool identity**: the call is one of the Host's own background-job query tools, `job_output`
   or `job_list` (registered by `@deepseek-ai/dsh-tool-jobs`; the shell tools' background jobs go
   through the same `job_output` verb);
2. **call shape**: the arguments carry the job handle in the Host's own declared field — a
   non-empty `job_id` string for `job_output`; `job_list` declares no parameters at all, so its
   shape is the empty argument object.

An exempt call is never refused, never gets corrective context, and spends none of the turn's
intervention or judgment allowance; `observe` and `active` plan exactly the same thing. It is
still recorded in the detection window, but it does not count as an unproductive repeat — the
repetition, failing-retry, and oscillation triggers all skip it — so **a real loop does not
disappear just because the run waited for a job in between**. `job_kill` is deliberately outside
the exemption: it terminates a job rather than waiting for one. Output text that happens to
contain `wait`, `sleep`, or `poll` earns nothing. The scope is the two tool names above; this is
the documented default and needs no extra configuration.

### How to get a pruned original back

`active` pruning retains first and replaces second, and that order is not a figure of speech:

1. the replacement is built only after the judgment passed **and** retention succeeded;
2. the original is written into the session log as a `plugin:dsh-reflex/pruned-original`
   record (the Host's `appendPluginRecord`); it never enters the model-visible surface, and
   `fork` / `resume` carry it with the rest of the log;
3. the replacement names the locator `plugin:dsh-reflex/pruned-original#<digest>` in its
   middle, so the model can always ask for the omitted part;
4. when retention fails (no session, a missing log, a failed read-back check) **nothing is
   replaced** and no `actualSavedTokens` is reported — the result stays byte-identical
   (recorded as `retention-failed`; the judgment was really paid for, and is still booked).

Retrieval is a read of the session events under that locator:

```ts
import { readPrunedOriginal } from 'dsh-reflex';

const record = readPrunedOriginal(session.ownEvents(), locator);
record?.text;    // the original, byte for byte
record?.chars;   // the size it was retained at
record?.digest;  // the digest the decision was recorded under
```

The `pruneFloorRatio` floor (0.5 by default) is the **smallest share of the original the
installed text may keep**: a judged candidate below it is padded with head and tail context
up to that share, and the middle diagnostics the judgment chose are kept whole — the floor
never drops them. Retention has boundaries: a payload with fewer than four newlines (under
five lines) or more than 100 000 characters is not pruned at all (recorded as
`unsupported-payload` / `retention-too-large`), so single-line output and oversized logs pass
through untouched; a payload that repeats reuses the copy retained the first time instead of
writing a second one.

### Cost and traceability

- The ledger is split by `mode` and by `capability`: `plans` (decisions taken),
  `applied` (decisions executed), `judgments` / `memoHits`, `judgeTokens`,
  `originalTokens` / `candidateTokens` / `potentialSavedTokens` (what could be
  saved) / `actualSavedTokens` (what really stopped entering the context);
- `observe` always reports `actualSavedTokens` 0, and its `potentialSavedTokens`
  matches `active` on the same input, item by item;
- Judging cost is separated: `localLatencyMs` (local arbitration) versus
  `remoteLatencyMs` (backend judgment);
- Every pruning record carries the replaced original's `digest`, its `turn`/`step` and its
  `originalLocator`; that locator reads the original back byte for byte (see "How to get a
  pruned original back" above);
- Retention is a precondition of replacement: when it fails nothing is replaced and no
  `actualSavedTokens` is reported, and `plans` does not claim a reduction that never happened;
- `off` is strictly zero behaviour: no listener, no sampling, no judgment — byte-identical to
  running without the plugin;
- The judgment cache is keyed by turn plus trailing window: one question costs one
  judgment per turn. `maxJudgmentsPerTurn`, `maxJudgmentsPerSession` and
  `maxInterventionsPerTurn` bound judgments per turn, judgments per session and
  interventions per turn;
- Interventions for one `(agent, call signature)` are de-duplicated within a turn,
  and the result of a call this plugin refused is never judged a second time;
- This plugin's own tools are never judged — their output is already the
  optimizer's (four by default, five with `route` on) — so no `reflex_*` payload
  this plugin registers is ever re-judged.

### Safety and rollback

- **fail-open**: any judging step that throws hands the downstream result on
  unchanged (recorded as `planning-error`); a tool call never fails because of it;
- **failure is never inferred from wording**: the structured `exitCode`/`signal` decides, then
  the exit badge the Host appends as the last line; the word "failed" inside an ordinary result
  is not a failure and never blocks a legitimate retry;
- **Monotonic permission**: `tools/pre-execute` only ever appends a `deny` to a downstream
  `allow`; an `ask`/`deny`/`cancel` from downstream is returned as the same object, with its
  `info` intact — never loosened, never overwritten;
- **Session isolation**: detection windows, verdict caches and budgets are booked
  per agent and never shared between agents;
- **No residue**: unloading the plugin detaches every listener and clears the
  engine's state; the ledger stays in memory unless `ledgerPath` is set.

---

## 8. Settings panel (DSH Settings UI)

The plugin declares its browser half through `dsh.client` and registers into the
`settings.section` slot:

| Tab | Content |
| --- | --- |
| Overview | Decision count, tokens saved, average latency, gate pass/fail, latest adaptive decision |
| Virtual provider | Routing switch, provider name, pool editing and ordering, fallback target |
| Reasoning effort | Policy (never intervene / Reflex adaptive), fallback level, minimum confidence, **adaptive-effort switch** |
| Interventions | Three-state mode (`off`/`observe`/`active`), the four capability overrides, per-turn intervention budget, per-turn judgment budget, per-session judgment budget, repeat threshold, failure threshold, minimum confidence, judgment window size, prune floor ratio; plus the currently effective mode and capabilities (read-only) |
| Tools | A per-capability switch for each of the five capabilities (four on, `route` off by default), each one stating **what it does / when the agent should call it / whether it is advised to expose it**, plus an "Apply recommended set" button; the currently registered tool names are listed at the end (read-only, follows `toolPrefix`), with a line pointing the ledger at `/reflex-ledger` |
| System 1 backend | Implementation, base URL, model id, API-key variable name, timeout; plus the tool-name prefix, prune threshold, ledger JSONL path and calibration-curve path |
| Decision ledger | Live metrics, recent-decision table, JSONL sink, clear (confirmed twice) |
| **Guide** | **A read-only view of this manual, following the DSH interface language** |

- Saving is **whole-group**: editing one field validates and writes the entire
  configuration group on every configuration path it covers (the System 1
  backend page spans `backend`, `systemOne`, `toolPrefix`, `ledgerPath`,
  `pruneThreshold` and `calibrationPath`).
- When the Host settings document is read-only the page becomes read-only and
  every write control is disabled.
- Panel routes under `/api/dsh-reflex/*` accept loopback clients only, and
  clearing the ledger requires an explicit confirmation.

### What each group writes back

The panel always shows the **currently effective values**, and saving goes
through the Host settings document's only write channel (a per-group `set` plus
the revision check) — there is no second write path. The groups differ in how
much they write:

- **Interventions: whole-group write-back.** Saving that group writes the
  group's **current mode and every budget value in full**, exactly like the
  virtual-provider and reasoning-effort groups, so what the configuration keeps
  is the complete set of values you see, not only the field you edited.
  Capability overrides write only the entries that are **not** `inherit`; the
  rest stay omitted (omitted = follow the mode).
- **Tools: only departures from the default are written.** A default-on tool
  switched off is written as `false`, the default-off `route` switched on is
  written as `true`, and switching anything back to its default **deletes** the
  key. The recommended set and "the whole group omitted" are therefore
  byte-identical (the default already is four on, one off), and the default
  configuration does not change at all.
- **The reasoning-effort switch is always written explicitly.** `effort.enabled`
  is saved with the group's current value, so there is no "the panel shows it
  enabled but the configuration actually omits it" ambiguity.
- **System 1 backend: one whole value per schema path.** The Host settings
  document is addressed by **configuration path**, and this page covers
  `backend` (a scalar), `systemOne` (the connection block), and the four
  top-level fields `toolPrefix`, `ledgerPath`, `pruneThreshold` and
  `calibrationPath`: saving writes each of those paths in full (only for the
  group that changed), and a **page name is never used as a configuration key** —
  `runtime` is not a field of `Config`, so writing under that name is refused by
  the Host outright and the whole save fails with it. A blank `ledgerPath` or
  `calibrationPath` is written as "unset", which keeps the layer below instead of
  storing an empty string.

An illegal value (an unknown tool suffix, a non-boolean, an out-of-range budget,
an invalid three-state value) is rejected by the same Host-side `resolveConfig`
validator with a field-level message, and the panel applies nothing partially:
the whole group passes, or not a byte of it is written.

### Tool switches: two kinds of advice, and the recommended set

Every entry on the tools page states three things: **what the capability does**,
**when the agent should call it**, and one label answering **whether it is advised
to expose it to the agent**:

| Advice | Meaning | Capabilities |
| --- | --- | --- |
| Suggested for the agent | The agent genuinely uses it in day-to-day work | `choice`, `score`, `screen`, `gate` |
| Opt-in | It only pays off when there are many candidates, so it is off by default | `route` |

The "**Apply recommended set**" button at the top pre-fills those five switches
and switches `route` off. **That recommended set is the default**: with
`tools.enabled` omitted, `choice`, `score`, `screen` and `gate` are on and `route`
is off, so the DSH plugin exposes four tools by default. The button pre-fills the
draft only and writes nothing — the group is still saved when you press Save, and
a draft that already equals the default writes **nothing at all** (there is no
difference to record).

`route` is an optional extra: switching it on (on the page, or with
`tools: { enabled: { route: true } }`) is what registers `reflex_route`; the main
flow does not depend on it.

Three capabilities are **no longer tools** and therefore have no switch here:
`prune` (result pruning) and `detect_stagnation` (stagnation detection) are driven
directly by the intervention layer as `observe`/`active` take effect, and the
ledger summary moved to the `/reflex-ledger` command. A line at the end of the
page points both out; the stdio MCP side still carries all eight tool names, see
the next section.

---

## 9. MCP tools ↔ DSH native capabilities

The two forms **no longer share one tool set**: the stdio MCP side still exposes
the **eight tools frozen since v0.1.0**, while the DSH plugin side registers
**five switchable capabilities (four by default)** — the other three are carried
by the automatic intervention layer and by one command instead of occupying the
model's tool list.

| Capability | MCP tool name (`harness-reflex mcp`) | DSH plugin side (`dsh-reflex`) | Main arguments | Advice |
| --- | --- | --- | --- | --- |
| Multi-option classification | `reflex_choice` | tool `reflex_choice` | `question`, `options[]`, optional `context` | Suggested for the agent |
| Continuous rating | `reflex_score` | tool `reflex_score` | `statement`, optional `criteria`, `context` | Suggested for the agent |
| Prompt-injection screen | `reflex_screen` | tool `reflex_screen` | `content`, optional `source`, `strict` | Suggested for the agent |
| Claim/evidence gate | `reflex_gate` | tool `reflex_gate` | `assertions[{statement}]`, `evidence`, optional `strictness` | Suggested for the agent |
| Candidate ranking | `reflex_route` | tool `reflex_route` (**not registered by default**) | `goal`, `candidates[]`, optional `topK` | Opt-in |
| Long-output pruning | `reflex_prune` | no tool: result pruning runs automatically from hooks such as `tools/pre-execute`, following the intervention mode | `rawOutput`, optional `intent`, `shadowMode` | — |
| Stagnation detection | `reflex_detect_stagnation` | no tool: stagnation detection is part of the automatic intervention layer | optional `recentAction`, `goal`, `history[]` | — |
| Ledger audit | `reflex_status_ledger` | no tool: use the `/reflex-ledger` command (no arguments) | optional `includeEntries` (returns `summary`, optionally `recentEntries`) | For humans |

Differences:

- The tool-name prefix is configurable (`toolPrefix`, default `reflex_`), so
  `rv_` yields `rv_gate` and friends.
- On the DSH side argument validation comes from the Host's `defineTool`
  (required/type/enum/nested) plus an undeclared top-level argument fence; on the
  MCP side advertises `inputSchema` for clients but its dispatcher does not run
  generic JSON Schema validation. Passing `claims` instead of `assertions` reaches
  the empty-assertion gate and returns `passed: false`, `needsEscalation: true`,
  `results: []`, not a JSON Schema error. Execution exceptions return a tool result
  with `isError: true`. DSH additionally accepts optional per-assertion `criteria`;
  MCP does not declare that nested field.
- Reading the ledger on the DSH side **never reaches the model**: `/reflex-ledger`
  is rendered into text by the Host (the summary plus the five most recent
  decisions) and takes no tool arguments; whether the ledger persists depends on
  `ledgerPath` (unset keeps it in memory and never writes into the user's
  project). The MCP side keeps the `reflex_status_ledger` tool with the arguments
  in the table above.
- DSH-side capabilities can be **switched individually** with `tools.enabled`,
  keyed by **suffix**; only the five current suffixes are accepted:

  ```yaml
  tools:
    enabled:
      route: true        # switch on the candidate ranking, off by default
      gate: false        # switch off the gate, on by default; the rest stay available
  ```

  The suffix is independent of `toolPrefix`: after renaming the prefix to `rv_`,
  `{ gate: false }` still closes `rv_gate`. A closed capability is **not
  registered** into `ctx.tools`, so it is absent from the model-visible tool list
  and from `reflexToolNames()` and its prefix derivation — there is no
  "placeholder tool" and the model never sees a shell that fails on every call.
  With `tools.enabled` omitted the per-suffix default applies
  (`choice`/`score`/`screen`/`gate` on, `route` off); an unknown suffix (say
  `teleport`, or one that is no longer a tool such as
  `prune`/`detect_stagnation`/`status_ledger`) or a non-boolean is rejected by the
  validator at install time instead of being ignored. Writing `false` for all five
  registers no tool at all (routing, reasoning effort and the intervention hooks
  are unaffected).

---

## 10. Decision ledger and audit

Every judgement appends one JSONL record (`type` is one of `gate`, `prune`,
`stagnation`, `route`, `model-route`, `effort`, `choice`) carrying the backend,
latency, confidence, token-savings estimate and a truncated detail field:

```bash
node dist/cli/index.js ledger      # terminal summary
```

- **`/reflex-ledger` (inside DSH)**: type the command in a session and the Host
  renders **this activation's** ledger summary into text (total calls, breakdown
  by type, average latency, tokens saved and the estimated cost, gate
  pass/fail, stagnation alerts, and the five most recent decisions). It is a
  command, not a tool: it **costs no model context and opens no model turn**, and
  an empty ledger answers "no records yet" instead of a row of zeroes;
- `ledgerPath` unset ⇒ memory only, gone with the process (the default, so user
  projects stay untouched);
- a configured path ⇒ append-only JSONL with replay, and the panel's ledger page
  shows the sink path;
- clearing the ledger needs two consecutive clicks in the panel; only the second
  one deletes the entries and the JSONL file.

---

## 11. Tests and release

```bash
npm test                 # root package: ledger / score / MCP surface / packaging manifest
npm run test:plugin      # DSH plugin: registration, strict validation, tool surface and /reflex-ledger, routing, effort, panel, guide
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

## 12. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No “Reflex runtime” entry in settings | The Host half is not loaded or registered no configuration namespace; re-check `dsh plugin add` and reload `dsh` |
| The panel is read-only | The DSH settings document is not writable; disabled writes are expected in that mode |
| A virtual model errors instead of dispatching | The pool is empty and `routing.fallback` is unset; add candidates or a fallback target |
| Text is not routed as expected | Check `routing.enabled`, the virtual model id spelling, and whether the agent actually requested that virtual model |
| Reasoning effort never changes | The policy is unset (no intervention), or the caller chose a concrete `reasoningEffort` explicitly on the request |
| System 1 decisions always fall back | `timeoutMs` too small, `baseUrl` unreachable, or `minConfidence` too high; check the latest decision and backend state on the Overview page |
| The in-panel guide is stale | `USER_GUIDE.md` changed without a rebuild; run `npm run build:all` |
| A closed tool is still being called | The registry takes effect on the next load; reload the plugin and check that the key is the **suffix** (`gate`, not `reflex_gate`). `prune`/`detect_stagnation`/`status_ledger` are not tools any more and are refused by the validator |
| `reflex_route` is missing from the default tool list | Expected: `route` is off by default; switch it on in the Tools page (or set `tools: { enabled: { route: true } }`) |
| Looking for a `reflex_status_ledger` tool to read the ledger | The ledger is a command now: type `/reflex-ledger` (the stdio MCP side still has the tool of that name) |
| The model selector still offers `reflex` after adaptive effort was switched off | That level was injected by the previous load; make sure the configuration is in effect and reload the plugin to revoke the injection |
| Saving the configuration reports that only blank or reflex is supported | The old configuration still writes a concrete level; remove it (or use `reflex`). To fix the depth, choose a concrete level in the model selector |
| Saving Interventions grew the configuration with defaults | Expected: that group is written back whole, so the mode and every budget are saved as shown |

---

## 13. Version and compatibility

- Version: `harness-reflex` and `dsh-reflex` ship together at v0.1.0-alpha.2;
- Node: `>= 18` (root package `engines`); DSH Host dependencies `@deepseek-ai/*@0.2.1-alpha.4`;
- Host contracts are declared as `peerDependencies`, so the plugin never bundles
  a second copy of Host modules;
- The eight-tool stdio MCP surface has been frozen since v0.1.0; a Host-side
  change must not silently alter its payloads;
- The DSH plugin-side tool surface, since v0.1.0-alpha.2, is **five switchable
  capabilities with four registered by default** (`route` is off by default) and
  the ledger is the `/reflex-ledger` command — that side does not promise to
  mirror the MCP side item by item.
