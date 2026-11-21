import z from '@deepseek-ai/schemastery';

import { ADAPTIVE_EFFORT_LEVELS, EFFORT_TRIGGERS, type AdaptiveEffortLevel, type ReasoningEffortSetting } from './effort.js';
import { parseFallback, type ModelPoolEntry, type ModelPools, type PhysicalTarget } from './router.js';
// Runtime import, not a type-only one: the tool vocabulary is owned by the
// registry module, and validating `tools.enabled` against a second copy of the
// list is exactly the drift this import removes. `./tools.js` imports this
// module for types only, so no runtime cycle exists.
import { REFLEX_TOOL_DEFAULT_ENABLED, REFLEX_TOOL_SUFFIXES, type ReflexToolSuffix } from './tools.js';
// The factory connection re-states the *project's* official endpoint and model
// rather than a second copy of the strings: `api.typesafe.ai/v1/systemone` and
// `jev-latest` are owned by the backend implementation, and a literal here would
// be a drift waiting to happen the next time the gateway moves.
import { DEFAULT_SYSTEMONE_ENDPOINT } from './vendor/harness-reflex/backend/jev.js';

/**
 * Deployment configuration for the reflex plugin.
 *
 * Every field is optional in the authored form: schemastery supplies the
 * documented defaults, and {@link resolveConfig} normalizes whatever the loader
 * resolved into the fully-populated {@link ResolvedReflexConfig}.
 *
 * @module dsh-reflex/config
 */

/** One authored candidate of a virtual model's pool. */
export interface ReflexModelPoolEntry {
  /** Physical provider route. */
  provider: string;
  /** Physical model id. */
  model: string;
  /** Capability note fed to the System 1 decision. */
  description?: string;
  /** Extra matching keywords fed to the System 1 decision. */
  tags?: string[];
}

/** Authored virtual-provider routing configuration. */
export interface ReflexRoutingConfig {
  /** Install the virtual provider and its request interception. Default `true`. */
  enabled?: boolean;
  /** Virtual provider route name. Default `reflex`. */
  virtualProvider?: string;
  /**
   * Physical `provider:model` used when a pool cannot answer (unknown model,
   * empty pool, unrankable candidates). Absent = fail closed: the request is
   * refused with a `ReflexRoutingError` instead of silently dispatching into a
   * route the user never configured.
   */
  fallback?: string;
  /** Virtual model id → ordered physical candidate pool. */
  models?: Record<string, ReflexModelPoolEntry[]>;
  /** Task-text budget handed to the System 1 decision (characters). */
  maxTaskChars?: number;
}

/**
 * One named System One connection profile.
 *
 * A profile **is** the connection (g-066): there is no block of last resort
 * beside it, so every field the runtime needs is either stated here or read out
 * of the environment by the backend. The panel lists profiles, picks one as
 * active, and tests each connection without ever receiving the key: `apiKey` is
 * a schema-declared `role('secret')` slot, so DSH's structural redaction removes
 * it from every wire-boundary value and reports its *presence* through a
 * sidecar instead.
 *
 * Legality: a profile name is a key of `systemOne.profiles`, so it may not be
 * empty, may not contain `.` (the settings-route path separator), and may not
 * collide after case folding — the panel shows these names as identifiers.
 */
export interface ReflexSystemOneProfile {
  /** Base URL of the Jev gateway or the OpenAI-compatible logits endpoint. */
  baseUrl?: string;
  /**
   * The one legacy model id (pre-g-066 shape).
   *
   * A connection that authors this and nothing else keeps working untouched:
   * {@link resolveSystemOneProfiles} treats it as a one-entry
   * {@link modelIds} list. Authors spelling both is refused rather than guessed
   * at, because the two say different things about which models exist.
   */
  model?: string;
  /**
   * Every model id this connection may ask for (g-066).
   *
   * A list, not a single id, because one gateway serves several models behind
   * one URL and key. {@link selectedModel} is the one the *runtime* and the
   * *probe* use — the two read the same field, so testing a connection tests
   * what the next decision actually sends.
   */
  modelIds?: string[];
  /**
   * Which of {@link modelIds} is in force.
   *
   * Absent means "the first one", which is what a one-model connection always
   * resolves to. A name outside the list is *reported*
   * ({@link ResolvedSystemOneConfig.activeProfileModelMissing}) and resolves to
   * nothing instead of silently running a model nobody selected: quietly
   * picking the first entry is exactly the "switched behind my back" behaviour
   * this goal removes.
   */
  selectedModel?: string;
  /**
   * The API key itself.
   *
   * Write-only: schemastery declares it `role('secret')`, so it never crosses a
   * wire boundary and no response can echo it. Absent means "no key stated by
   * this profile" — the resolution chain then falls through to `apiKeyEnv`.
   */
  apiKey?: string;
  /**
   * Name of the environment variable holding the API key. Never the key itself.
   *
   * Kept beside {@link apiKey} on purpose: a profile may name an environment
   * variable instead of carrying a secret.
   */
  apiKeyEnv?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Backend override for this profile (`auto`/`mock`/`jev`/`vllm`). */
  backend?: string;
}

/** Row name of the factory connection, as the panel shows it. */
export const FACTORY_PROFILE_NAME = 'JEV official';

/** The environment variable the factory connection locks onto — never another. */
export const FACTORY_PROFILE_API_KEY_ENV = 'JEV_API_KEY';

/**
 * The factory connection (g-067): the project's own Jev gateway, switched on.
 *
 * A deployment whose settings document declares **no** `systemOne` block is a
 * **fresh document**, and it should not open on "no connection, nothing works":
 * the plugin ships with one working remote connection already named, already
 * active, pointing at the official endpoint and model, and locked onto
 * {@link FACTORY_PROFILE_API_KEY_ENV}.
 *
 * It is deliberately a normal profile — an entry of `systemOne.profiles` with
 * nothing special about it — and it is supplied by the **schema default**
 * (`Config.systemOne`), which schemastery applies only to an *absent* key. That
 * single rule is the whole distinction between "fresh" and "the owner said
 * something":
 *
 * - **deactivate** — the page writes `systemOne.active: ''`; the section is
 *   stated, resolves as `no-active-profile`, and **no** factory row is filled
 *   back in (the row stays listed, switched off);
 * - **delete** — the page unsets the row *and* states the empty activation, so
 *   the section is `{profiles: {}, active: ''}` → `no-profiles`, and nothing is
 *   filled back in;
 * - **rename / replace** — any authored `systemOne` block wins outright; the
 *   factory row is only ever materialized into a document that has none.
 *
 * The one write that would blur the line is a cleared path whose parent is then
 * rebuilt from nothing (`{}`, which schemastery does not default): that is why
 * the page never unsets `systemOne.active` or the last profile row on its own —
 * it states an explicit empty activation instead.
 *
 * The lock matters as much as the row. `apiKeyEnv` **names** the variable, and
 * naming locks (g-059): with no `JEV_API_KEY` exported the connection reports
 * "named but empty" and sends no key — it never reaches for
 * `SYSTEM_ONE_API_KEY`, `VLLM_API_KEY` or `OPENAI_API_KEY` behind the owner's
 * back. Only the variable *name* is ever authored; the secret itself is never
 * written into a settings document by this row.
 *
 * ## The implementation is bound, not left to `auto` (g-067 att-002)
 *
 * The row pins `backend: 'jev'` rather than inheriting the top-level selector.
 * An independent review blocked the first attempt for exactly this: with no
 * `backend` on the row, a fresh deployment (top-level `backend: 'auto'`) had its
 * implementation chosen from the *environment* on every build — `auto` delegates
 * to the vendored factory, which reads `SYSTEM_ONE_BACKEND`/`REFLEX_BACKEND` and
 * `VLLM_BASE_URL`/`OPENAI_BASE_URL`. Exporting two variables therefore took the
 * already-resolved `JEV_API_KEY` and sent it as `Authorization` to a vLLM
 * endpoint nobody configured, while the panel's connection test — which treats
 * `auto` as Jev — still probed the official URL and reported green.
 *
 * So the factory row states all three of the facts a connection has: where
 * (official URL), what model, and **which implementation speaks it**. The
 * implementation is no longer something the environment can change underneath a
 * connection the plugin shipped. This is a row-level binding, which is the
 * documented precedence for every profile — not a top-level override: an
 * authored row, and a deployment's own `backend` selector for authored rows,
 * are untouched.
 *
 * An **explicit** top-level `mock` still answers in-process: a mock never opens
 * a socket, so it cannot send the key anywhere, and `createBackend` honours it
 * before any transport is built (see its mock branch). What the binding removes
 * is the *implicit* `auto` route, which is the one the environment decided.
 */
export const FACTORY_SYSTEMONE_PROFILE = Object.freeze({
  baseUrl: DEFAULT_SYSTEMONE_ENDPOINT,
  model: 'jev-latest',
  apiKeyEnv: FACTORY_PROFILE_API_KEY_ENV,
  backend: 'jev'
}) satisfies Readonly<ReflexSystemOneProfile>;

/**
 * `systemOne` block a settings document starts from.
 *
 * Returned fresh on every call, because schemastery stores the default it is
 * given: a shared object would let one caller's edit leak into the next
 * resolution.
 * @returns a new factory block.
 */
function factorySystemOneBlock() {
  return {
    profiles: { [FACTORY_PROFILE_NAME]: { ...FACTORY_SYSTEMONE_PROFILE } },
    active: FACTORY_PROFILE_NAME
  };
}

/**
 * Authored connection settings of the System One decision backend.
 *
 * **Only named profiles connect** (g-066). The flat `baseUrl` / `model` /
 * `apiKeyEnv` / `timeoutMs` fields this block used to carry beside
 * `profiles` are gone, together with the "profile over flat over environment"
 * merge they made possible: with no valid active profile the plugin is
 * *unconfigured* and sends no external request at all. Silently running some
 * other block — or picking whatever environment variable happened to be
 * exported — is the behaviour the goal removes.
 *
 * The fields are deliberately **not declared on the schema** any more, for two
 * reasons:
 *
 * 1. Schemastery drops what an object does not declare, so a settings document
 *    that still carries them (written by an earlier release) keeps them on disk
 *    untouched instead of having them rewritten under the page's feet. g-066
 *    converts nothing: migration is the owner's decision, not a side effect of
 *    opening a panel.
 * 2. A deployment authored in `cordis.patch.yml` with the old flat shape still
 *    hands those keys to {@link resolveSystemOneConfig} — read below under
 *    `legacy*` — and they can *only* describe a connection that this plugin
 *    would previously have used implicitly. Reading them is what turns "your
 *    working deployment now fails closed with no explanation" into a precise
 *    message telling the owner to name a profile.
 *
 * An omitted profile field keeps the environment/default behaviour of the
 * backend implementation.
 */
export interface ReflexSystemOneConfig {
  /** Named connection profiles, keyed by the name the panel shows. */
  profiles?: Record<string, ReflexSystemOneProfile>;
  /**
   * Name of the profile in force.
   *
   * A name that matches no authored profile is *not* silently ignored: the
   * resolution reports `activeProfileMissing` and resolves **nothing**, which
   * the panel shows as a warning and the runtime treats as unconfigured.
   * Failing the whole activation was the alternative and was rejected: a single
   * mistyped name would take every reflex tool down, and the tools still have
   * their deterministic local fallbacks.
   */
  active?: string;
  /**
   * Pre-g-066 flat connection fields, read for the *diagnosis* only.
   *
   * Never used to connect: see {@link ReflexSystemOneConfig}. Kept out of the
   * authoring schema; listed here so the resolution can name them.
   */
  baseUrl?: string;
  /** Pre-g-066 flat model id; diagnosis only. */
  model?: string;
  /** Pre-g-066 flat key-variable name; diagnosis only. */
  apiKeyEnv?: string;
  /** Pre-g-066 flat timeout; diagnosis only. */
  timeoutMs?: number;
}

/**
 * The three-state vocabulary every automatic capability shares.
 *
 * `off` is the capability absent; `observe` runs the complete detection and
 * action *planning* path while changing nothing the model can see; `active`
 * executes the planned intervention. The shared vocabulary is what keeps one
 * switch — not three subtly different "disabled" flags — behind every gate.
 */
export const INTERVENTION_MODES = ['off', 'observe', 'active'] as const;

/** One resolved three-state mode. */
export type InterventionMode = (typeof INTERVENTION_MODES)[number];

/**
 * A capability-level setting: one of the three modes, or `inherit` to follow
 * {@link ReflexInterventionsConfig.mode}. Inheritance is deliberately not
 * available at the top level, where there is nothing to inherit from.
 */
export const INTERVENTION_SETTINGS = [...INTERVENTION_MODES, 'inherit'] as const;

/** One authored capability-level setting. */
export type InterventionSetting = (typeof INTERVENTION_SETTINGS)[number];

/**
 * The automatic capabilities, each with its own three-state setting.
 *
 * - `stagnation`: the tool-call gate (`tools/pre-execute`) that denies a call
 *   the run is repeating after System 1 confirmed stagnation, plus the
 *   corrective context appended at `agent/pre-step`.
 * - `prune`: the result projection (`tools/post-execute`) that shrinks an
 *   oversized successful payload below its deterministic floors.
 * - `gate`: corrective feedback (`tools/post-execute`) that turns a repeated
 *   failing result into an error carrying the System 1 recommendation.
 * - `closing`: the turn-stop check (`agent/turn-stopping`) that objects to a
 *   turn closing on self-contradictory verification evidence.
 */
export const INTERVENTION_CAPABILITIES = ['stagnation', 'prune', 'gate', 'closing'] as const;

/** One automatic capability name. */
export type InterventionCapability = (typeof INTERVENTION_CAPABILITIES)[number];

/**
 * Authored automatic-intervention configuration.
 *
 * Key names are this plugin's contract with the settings surface: the block is
 * edited through the very same schemastery schema the Settings panel writes, so
 * there is no second write channel and no second source of truth.
 */
export interface ReflexInterventionsConfig {
  /**
   * Master mode of every automatic capability. `observe` (the default) runs the
   * full detection path and records what it *would* do without touching the
   * tool call, its result, the message list, or the turn boundary.
   */
  mode?: InterventionSetting;
  /** Per-capability override; an omitted capability inherits {@link mode}. */
  capabilities?: Partial<Record<InterventionCapability, InterventionSetting>>;
  /**
   * Ceiling on applied interventions per turn, so an intervention can never
   * become the loop it was meant to break. Default `3`.
   */
  maxInterventionsPerTurn?: number;
  /**
   * Ceiling on *judgments* per turn — the expensive half of a detection. A
   * pathological turn presenting many similar results is bounded by this rather
   * than by the payload count. Default `3`.
   */
  maxJudgmentsPerTurn?: number;
  /** Ceiling on judgments per agent session. Default `20`. */
  maxJudgmentsPerSession?: number;
  /**
   * Identical consecutive tool calls required before the deterministic
   * pre-trigger spends a System 1 judgment. Default `3`.
   */
  repeatThreshold?: number;
  /** Consecutive failing results required before the same. Default `3`. */
  failureThreshold?: number;
  /** Minimum System 1 confidence for a stagnation verdict to act. Default `0.6`. */
  minConfidence?: number;
  /** Steps of one agent's history a deterministic pre-trigger looks at. Default `6`. */
  windowSize?: number;
  /**
   * Lowest share of a payload's characters a prune may keep. The deterministic
   * floor: a candidate that cuts deeper is replaced by the head/tail form.
   * Default `0.5`.
   */
  pruneFloorRatio?: number;
  /** Characters always kept from the head of a pruned payload. Default `400`. */
  pruneHeadChars?: number;
  /** Characters always kept from the tail of a pruned payload. Default `400`. */
  pruneTailChars?: number;
  /**
   * Character count at/above which pruning judges the payload segment by
   * segment through System One. Below it the deterministic local candidates run
   * and no judgment is spent. Effective value is `max(this, pruneThreshold)`,
   * so raising `pruneThreshold` alone never makes a save invalid. Default `10000`.
   */
  pruneJudgeMinChars?: number;
  /**
   * Probability at/above which a sentence System One classified as a completion
   * claim is submitted to verification. A deterministic floor on a semantic
   * decision, never a word list. Default `0.5`.
   */
  claimMinConfidence?: number;
  /**
   * Character budget of the evidence handed to one closing judgment. Overflow
   * is truncated by priority — diagnostic lines, then tail summaries, then the
   * rest — and the dropped amount is reported. Minimum `200`, default `2400`.
   */
  closingEvidenceChars?: number;
  /** Lookup intent handed to the pruning judgment. */
  intent?: string;
}

/** Automatic-intervention configuration after defaults and resolution. */
export interface ResolvedInterventionsConfig {
  /** The master mode, always one of the three (never `inherit`). */
  mode: InterventionMode;
  /** Effective mode of every capability: the override, else the master mode. */
  capabilities: Record<InterventionCapability, InterventionMode>;
  /** Whether any capability is allowed to act. */
  enabled: boolean;
  maxInterventionsPerTurn: number;
  maxJudgmentsPerTurn: number;
  maxJudgmentsPerSession: number;
  repeatThreshold: number;
  failureThreshold: number;
  minConfidence: number;
  windowSize: number;
  pruneFloorRatio: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  /** At/above this character count pruning judges segments through System One. */
  pruneJudgeMinChars: number;
  /** Confidence floor for a classified completion claim. */
  claimMinConfidence: number;
  /** Character budget of the closing evidence. */
  closingEvidenceChars: number;
  intent: string;
}

/** Authored adaptive reasoning-effort configuration. */
export interface ReflexEffortConfig {
  /**
   * Whether adaptive reasoning effort may run at all. Default `true`, which is
   * the pre-existing behaviour: `reflex`/`auto` and the virtual-route default
   * keep deciding per turn. `false` stops every adaptive decision and withdraws
   * the plugin-injected `reflex` level, leaving concrete levels untouched.
   */
  enabled?: boolean;
  /**
   * `'reflex'`/`'auto'` makes every turn decide its own effort through System 1.
   * Omitted = the plugin never touches `reasoningEffort`, exactly as if this
   * feature were not installed. A concrete level is rejected: fixed depth is a
   * model-selector choice, not a deployment setting.
   */
  reasoningEffort?: ReasoningEffortSetting;
  /** Level used when no cue matches and System 1 cannot decide. Default `medium`. */
  fallback?: AdaptiveEffortLevel;
  /** Minimum System 1 confidence for its answer to be trusted. Default `0.3`. */
  minConfidence?: number;
}

/**
 * Authored per-tool switches, indexed by tool *suffix* rather than tool name.
 *
 * The suffix is what a user writes (`choice`, `route`, …); the registered name
 * is `toolPrefix` + suffix, so a switch keyed by name would break the moment a
 * deployment renames its prefix. An omitted suffix takes
 * {@link REFLEX_TOOL_DEFAULT_ENABLED} — on for every suffix except `route` —
 * and every suffix can be turned either way explicitly.
 */
export interface ReflexToolsConfig {
  /**
   * Suffix → enabled. Omitted entries take the documented default (`route` is
   * the one suffix that starts off); unknown keys are rejected.
   */
  enabled?: Partial<Record<ReflexToolSuffix, boolean>>;
}

/**
 * Authored switch of the *host capability* the delegation tool needs.
 *
 * Deliberately not part of {@link ReflexToolsConfig}: `tools.enabled.<suffix>`
 * decides whether this plugin registers a tool it can serve on its own, while
 * this flag decides whether the Host is asked to publish the model-selection
 * surface `reflex_delegate` needs. Ticking it is a consent to edit the host
 * profile patch (`tool-subagent.config.modelSelection: true`) — a file this
 * plugin otherwise never touches, and whose change only applies after a DSH
 * restart.
 */
export interface ReflexDelegationConfig {
  /**
   * Whether the delegation capability is asked for. Default `false`: the tool
   * does not work until the Host's `tool-subagent` publishes `reasoning_effort`,
   * so the switch starts off rather than advertising a tool that cannot carry a
   * level. `true` means "I want it, and I agree to the host switch it needs".
   */
  enabled?: boolean;
}

/** Deployment configuration for the reflex tool bundle. */
export interface ReflexConfig {
  /**
   * System One decision backend. `auto` honors `SYSTEM_ONE_BACKEND` and the
   * API-key/base-url environment variables; the explicit values force one
   * implementation for this plugin only, without touching the environment.
   */
  backend?: 'auto' | 'mock' | 'jev' | 'vllm';
  /** Prefix for every registered tool name (`reflex_choice`, …). */
  toolPrefix?: string;
  /**
   * JSONL audit sink for the decision ledger. Omitted (the default) keeps the
   * ledger in process memory so a Host never writes into the user's project
   * unless persistence was asked for explicitly.
   */
  ledgerPath?: string;
  /** Character count above which `prune` activates for one payload. */
  pruneThreshold?: number;
  /** Optional calibration curve JSON; falls back to `SYSTEM_ONE_CALIBRATION_FILE`. */
  calibrationPath?: string;
  /** Connection settings of the System One decision backend. */
  systemOne?: ReflexSystemOneConfig;
  /** Virtual provider + System 1 model routing. */
  routing?: ReflexRoutingConfig;
  /** Per-turn adaptive reasoning effort. */
  effort?: ReflexEffortConfig;
  /** Per-tool switches of the eight reflex tools. */
  tools?: ReflexToolsConfig;
  /** The host capability `reflex_delegate` depends on. */
  delegation?: ReflexDelegationConfig;
  /** Automatic interventions on the Host's tool and agent lifecycle hooks. */
  interventions?: ReflexInterventionsConfig;
}

/** Routing configuration after defaults and validation have been applied. */
export interface ResolvedRoutingConfig {
  enabled: boolean;
  virtualProvider: string;
  fallback?: PhysicalTarget;
  models: ModelPools;
  maxTaskChars: number;
}

/** System One backend configuration after defaults and validation. */
export interface ResolvedSystemOneConfig {
  /** Selected implementation; `auto` keeps the environment heuristics. */
  backend: 'auto' | 'mock' | 'jev' | 'vllm';
  /**
   * Base URL of the connection in force, absent when nothing selected one.
   *
   * Since g-066 this is *the active profile's* address (or, for a profile that
   * states none, nothing at all — the backend then reads the environment). It
   * is never inherited from a block beside the profile, because no such block
   * exists any more.
   */
  baseUrl?: string;
  /** Model id the runtime asks for: the active profile's selected model. */
  model?: string;
  /** Environment variable that holds the API key; never the key itself. */
  apiKeyEnv?: string;
  /** Per-request timeout override in milliseconds. */
  timeoutMs?: number;
  /**
   * The API key of the *resolved* profile, when the chain found one.
   *
   * Never serialized to a panel or route: {@link ResolvedSystemOneConfig} is only
   * handed to {@link createBackend} and to the connection probe.
   */
  apiKey?: string;
  /** Active profile name as authored, when one was. */
  active?: string;
  /**
   * Every profile, normalized, in authored order. Keys are the panel's row ids.
   *
   * Absent when the document authors no `profiles` at all.
   */
  profiles?: Record<string, ResolvedSystemOneProfile>;
  /**
   * The authored `active` name matched no profile.
   *
   * The panel shows this as a warning and the runtime is **unconfigured**: it
   * makes no connection of its own accord. Nothing is resolved from anywhere
   * else, so a typo cannot silently run a connection the user did not select.
   */
  activeProfileMissing?: boolean;
  /**
   * Why nothing can be connected, when nothing can (g-066).
   *
   * - `no-active-profile`: profiles exist but none is activated;
   * - `no-profiles`: the document authors no profile at all;
   * - `active-profile-missing`: `active` names no authored profile;
   * - `legacy-config-required`: the document carries only the pre-g-066 flat
   *   fields, which no longer connect anything;
   * - `model-selection-unusable`: the active profile resolved, but the model its
   *   configuration puts in force cannot be sent (owner-authored refusal);
   * - `model-selection-invalid`: the active profile's *selected* model is not in
   *   its list, so nothing runs (see {@link activeProfileModelMissing}).
   *
   * Absent exactly when an active profile resolved **and** its model is
   * sendable. The panel renders it as the "unconfigured" state and the backend
   * refuses to build, so an unusable model never becomes a request to some other
   * model (g-066 att-002).
   */
  unconfigured?:
    | 'no-active-profile'
    | 'no-profiles'
    | 'active-profile-missing'
    | 'legacy-config-required'
    | 'model-selection-unusable'
    | 'model-selection-invalid';
  /**
   * The active profile names a `selectedModel` that is not in its `modelIds`.
   *
   * Reported, and the resolved {@link model} is left absent rather than falling
   * back to the first id: a connection whose *selected* model does not exist is
   * a broken selection, not an invitation to run a different model. Since
   * g-066 att-002 it is also *final*: {@link unconfigured} is set with
   * `model-selection-invalid` and {@link createBackend} builds no transport, so
   * the backend's own `|| DEFAULT_MODEL` fallback can never turn "nothing was
   * selected" into a request for a model nobody picked.
   */
  activeProfileModelMissing?: boolean;
}

/** One profile after defaults and validation. */
export interface ResolvedSystemOneProfile {
  baseUrl?: string;
  /**
   * Every model id the connection offers, in authored order.
   *
   * Derived from `modelIds`, or from a legacy single `model` as a one-entry
   * list — so every connection has the same shape downstream.
   */
  modelIds?: string[];
  /** The model in force for this connection (see {@link ReflexSystemOneProfile.selectedModel}). */
  selectedModel?: string;
  /** The key this profile carries. Write-only; see {@link ReflexSystemOneProfile}. */
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  backend?: 'auto' | 'mock' | 'jev' | 'vllm';
}

/** Effort configuration after defaults and validation have been applied. */
export interface ResolvedEffortConfig {
  /** Whether adaptive effort may decide anything; `true` unless authored otherwise. */
  enabled: boolean;
  /**
   * The adaptive trigger marker; `undefined` (the default) leaves
   * `reasoningEffort` entirely to the caller.
   */
  setting?: ReasoningEffortSetting;
  /** Level used when neither System 1 nor the cue classifier has evidence. */
  fallback: AdaptiveEffortLevel;
  /** Minimum System 1 confidence for its answer to be trusted. */
  minConfidence: number;
}

/** Per-tool switches after defaults: every suffix of the vocabulary is answered. */
export interface ResolvedToolsConfig {
  /** Suffix → whether the tool is registered. Every suffix has an entry. */
  enabled: Record<ReflexToolSuffix, boolean>;
}

/** Delegation switch after defaults have been applied. */
export interface ResolvedDelegationConfig {
  /**
   * Whether the user has consented to the host `modelSelection` switch this
   * activation's `reflex_delegate` needs. Default `false`.
   */
  enabled: boolean;
}

/** Configuration after defaults and validation have been applied. */
export interface ResolvedReflexConfig {
  backend: 'auto' | 'mock' | 'jev' | 'vllm';
  toolPrefix: string;
  ledgerPath?: string;
  pruneThreshold: number;
  calibrationPath?: string;
  systemOne: ResolvedSystemOneConfig;
  routing: ResolvedRoutingConfig;
  effort: ResolvedEffortConfig;
  tools: ResolvedToolsConfig;
  delegation: ResolvedDelegationConfig;
  interventions: ResolvedInterventionsConfig;
}

/** Schemastery schema for one automatic-intervention block. */
const InterventionsSchema = z
  .object({
    mode: z
      .union([...INTERVENTION_MODES])
      .default('observe')
      .description('off = absent, observe = detect and record only (default), active = execute the planned intervention.'),
    capabilities: z
      .object({
        stagnation: z.union([...INTERVENTION_SETTINGS]).description('Tool-call gate and pre-step correction; omit to inherit mode.'),
        prune: z.union([...INTERVENTION_SETTINGS]).description('Oversized result projection; omit to inherit mode.'),
        gate: z.union([...INTERVENTION_SETTINGS]).description('Repeated-failure corrective feedback; omit to inherit mode.'),
        closing: z.union([...INTERVENTION_SETTINGS]).description('Turn-stop objection; omit to inherit mode.')
      })
      .default({}),
    maxInterventionsPerTurn: z.natural().default(3),
    maxJudgmentsPerTurn: z.natural().default(3),
    maxJudgmentsPerSession: z.natural().default(20),
    repeatThreshold: z.natural().min(2).default(3),
    failureThreshold: z.natural().min(2).default(3),
    minConfidence: z.number().min(0).max(1).default(0.6),
    windowSize: z.natural().min(3).default(6),
    pruneFloorRatio: z.number().min(0).max(1).default(0.5),
    pruneHeadChars: z.natural().default(400),
    pruneTailChars: z.natural().default(400),
    pruneJudgeMinChars: z
      .natural()
      .default(10000)
      .description('At or above this many characters, pruning judges the output segment by segment through System One.'),
    claimMinConfidence: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .description('Probability at/above which a sentence classified as a completion claim is submitted to verification.'),
    closingEvidenceChars: z
      .natural()
      .min(200)
      .default(2400)
      .description('Character budget of the evidence handed to one closing judgment; overflow is truncated by priority.'),
    intent: z.string().description('Lookup intent handed to the pruning judgment.')
  })
  .volatile();

/** Schemastery schema for one candidate pool entry. */
const ModelPoolEntrySchema = z.object({
  provider: z.string().description('Physical provider route (must not be the virtual provider itself).'),
  model: z.string().description('Physical model id as the provider adapter knows it.'),
  description: z.string().description('Capability note the System 1 decision reasons about.'),
  tags: z.array(z.string()).description('Extra matching keywords for the System 1 decision.')
});

/** Schemastery schema for the virtual-provider routing block. */
const RoutingSchema = z.object({
  enabled: z.boolean().default(true),
  virtualProvider: z.string().default('reflex'),
  fallback: z.string().description('Physical "provider:model" used when a pool cannot answer; omit to fail closed.'),
  models: z.dict(z.array(ModelPoolEntrySchema)).default({}),
  maxTaskChars: z.natural().default(400)
}).volatile();

/** Schemastery schema for the adaptive reasoning-effort block. */
const EffortSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Whether adaptive reasoning effort may run. Default true; false withdraws the plugin-injected adaptive level.'),
  reasoningEffort: z
    .union([...EFFORT_TRIGGERS])
    .description(
      'Per-turn adaptive marker ("reflex", alias "auto"). Omit to leave reasoningEffort to the caller; a concrete level belongs in the model selector.'
    ),
  fallback: z
    .union([...ADAPTIVE_EFFORT_LEVELS])
    .default('medium')
    .description('Level used when System 1 and the cue classifier both have no evidence.'),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .description('Minimum System 1 confidence for its answer to be trusted over the cue classifier.')
}).volatile();

/**
 * Schemastery schema for one System One connection profile.
 *
 * `apiKey` is the one field of this plugin declared `role('secret')`. That role
 * is the whole mechanism behind the panel's write-only input: DSH's structural
 * redaction (`dsh-settings` `redactSecrets`) walks the schema — through
 * `z.dict()` entries, by `node.inner` — drops every secret slot from a value
 * before it crosses a wire boundary, and records `{path, set}` in a sidecar so a
 * configuration surface can render a placeholder without ever holding the value.
 *
 * Deliberately no `default`: a secret slot with a default would materialize a
 * value nobody typed, and `plainSchema` strips `default`/`required` from secret
 * slots anyway.
 */
const SystemOneProfileSchema = z.object({
  baseUrl: z.string().description('Jev gateway or OpenAI-compatible logits endpoint.'),
  model: z
    .string()
    .description('Legacy single model id. Same as modelIds: [id]; it is kept as written and is never rewritten into the list form.'),
  modelIds: z
    .array(z.string())
    .description('Every model id this connection may ask for. Omit to keep the legacy single model.'),
  selectedModel: z
    .string()
    .description('The one model in force for this connection: the runtime and the connection test both use it. Omit = the first modelIds entry.'),
  apiKey: z
    .string()
    .role('secret')
    .description(
      'API key of this profile, write-only: stored on save, never returned by any read. Empty = leave unchanged; clear it with the explicit Clear action.'
    ),
  apiKeyEnv: z.string().description('Name of the environment variable holding this profile’s API key — never the key itself.'),
  timeoutMs: z.natural().description('Per-request timeout in milliseconds.'),
  backend: z
    .union(['auto', 'mock', 'jev', 'vllm'])
    .description('Backend implementation serving this connection; omit to use the top-level backend.')
});

/** Schemastery schema for the System One backend connection block. */
const SystemOneSchema = z.object({
  /**
   * Only profiles connect (g-066). The pre-g-066 flat `baseUrl` / `model` /
   * `apiKeyEnv` / `timeoutMs` keys are deliberately **not** declared: schemastery
   * drops undeclared keys, and an object write re-states only what it declares,
   * so a document still carrying them keeps them byte for byte instead of having
   * them converted (or deleted) as a side effect of a panel save.
   */
  profiles: z
    .dict(SystemOneProfileSchema)
    .default({})
    .description('Named connection profiles; each may carry its own write-only apiKey and its own model list.'),
  active: z.string().description('Name of the profile in force; a name no profile declares is reported, and nothing connects.')
}).volatile();

/**
 * Schemastery schema for the per-tool switch block.
 *
 * Deliberately an open dictionary rather than an object with eight declared
 * keys: schemastery drops what an object does not declare, and a dropped typo
 * would read as "the tool stayed on" instead of failing. {@link resolveToolsConfig}
 * therefore owns the rejection of unknown suffixes.
 */
const ToolsSchema = z
  .object({
    enabled: z
      .dict(z.boolean())
      .default({})
      .description(
        `Suffix → enabled (${REFLEX_TOOL_SUFFIXES.join(', ')}). Omitted suffixes keep their documented default (${REFLEX_TOOL_SUFFIXES.filter((suffix) => !REFLEX_TOOL_DEFAULT_ENABLED[suffix]).join(', ') || 'none'} off, the rest on).`
      )
  })
  .volatile();

/**
 * Schemastery schema for the delegation block.
 *
 * One boolean, defaulting to `false`. It is authored, never written by the
 * plugin: the panel's toggle writes this field, the runtime detector refuses to
 * write it, and the only other file this plugin edits is the host patch the
 * consent box names explicitly.
 */
const DelegationSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .description(
        'Consent to the host capability reflex_delegate needs: on = the host tool-subagent publishes reasoning_effort (modelSelection: true), which is written into the profile patch and applies after a DSH restart. Default false.'
      )
  })
  .volatile();

/**
 * Schemastery schema the Cordis loader validates the deployment config with.
 *
 * The explicit `Schemastery<ReflexConfig>` annotation is deliberate: the
 * inferred type of a schema containing `z.dict(z.array(...))` names a
 * `cosmokit` helper that is not portably resolvable from this package's
 * emitted declarations, so the public shape is stated instead of inferred.
 */
/**
 * Schemastery schema of the plugin's configuration.
 */
export const Config: Schemastery<any> = z.object({
  backend: z.union(['auto', 'mock', 'jev', 'vllm']).default('auto').volatile(),
  toolPrefix: z.string().default('reflex_').volatile(),
  ledgerPath: z.string().description('JSONL audit sink; omit to keep the ledger in memory.').volatile(),
  pruneThreshold: z.natural().default(500).volatile(),
  calibrationPath: z.string().description('Calibration curve JSON applied to choice confidences.').volatile(),
  // The factory connection lives here, on the real schema default, rather than in
  // `resolveSystemOneConfig` (g-067). Schemastery applies a default to a
  // top-level key the document omits, and a fresh profile omits it: its patch
  // file starts as `[]`, so the loader entry's config is `{}` and this key never
  // appears. That is the only shape that gets the factory row from here: a
  // document that *states* a `systemOne` block keeps it, which is what makes
  // deactivation and deletion stick.
  //
  // It also puts the row where the Host settings form can see it: the form
  // projects the *resolved* config, so a default the schema never produces would
  // be a connection the panel shows and the settings page does not.
  systemOne: SystemOneSchema.default(factorySystemOneBlock()),
  routing: RoutingSchema.default({}),
  effort: EffortSchema.default({}),
  tools: ToolsSchema.default({}),
  delegation: DelegationSchema.default({}),
  interventions: InterventionsSchema.default({})
});

/**
 * Validate one authored three-state setting.
 *
 * The loader restricts the value to the schema's union; this repeats the check
 * because {@link resolveConfig} is also the entry point for a programmatic
 * caller, and a typo there must fail loudly instead of silently disabling (or
 * silently enabling) an intervention.
 *
 * @param value - authored setting.
 * @param allowInherit - whether `inherit` is a legal value at this position.
 * @param label - dotted path used in the error.
 * @returns the normalized setting, or `undefined` when nothing was authored.
 * @throws Error when the value is not a legal setting.
 */
export function resolveInterventionSetting(
  value: string | undefined,
  allowInherit: boolean,
  label: string
): InterventionSetting | undefined {
  if (value === undefined) return undefined;
  const setting = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((INTERVENTION_SETTINGS as readonly string[]).includes(setting)) {
    if (setting === 'inherit' && !allowInherit) {
      throw new Error(`${label} must be one of ${INTERVENTION_MODES.join(', ')} (got "inherit": there is nothing to inherit from)`);
    }
    return setting as InterventionSetting;
  }
  const legal = allowInherit ? INTERVENTION_SETTINGS : INTERVENTION_MODES;
  throw new Error(`${label} must be one of ${legal.join(', ')} (got "${String(value)}")`);
}

/**
 * Validate the automatic-intervention block and fill in every default.
 *
 * Capability entries resolve to an effective three-state mode here, once, so
 * every consumer — listeners, the panel projection, the audit — reads the same
 * answer instead of re-deriving inheritance.
 *
 * @param authored - the authored `interventions` block.
 * @param pruneThreshold - the runtime prune threshold, the lower bound of the
 *   segment-judging threshold.
 * @returns the resolved master mode, effective capability modes, and limits.
 * @throws Error when a field is present but unusable.
 */
export function resolveInterventionsConfig(
  authored: ReflexInterventionsConfig | undefined,
  pruneThreshold = 500
): ResolvedInterventionsConfig {
  const block = authored ?? {};
  const mode = (resolveInterventionSetting(block.mode, false, 'interventions.mode') ?? 'observe') as InterventionMode;

  const capabilities = {} as Record<InterventionCapability, InterventionMode>;
  for (const capability of INTERVENTION_CAPABILITIES) {
    const setting = resolveInterventionSetting(
      block.capabilities?.[capability],
      true,
      `interventions.capabilities.${capability}`
    );
    capabilities[capability] = setting === undefined || setting === 'inherit' ? mode : setting;
  }

  const counts: Array<[number | undefined, string, number, number]> = [
    [block.maxInterventionsPerTurn, 'maxInterventionsPerTurn', 3, 0],
    [block.maxJudgmentsPerTurn, 'maxJudgmentsPerTurn', 3, 0],
    [block.maxJudgmentsPerSession, 'maxJudgmentsPerSession', 20, 0],
    [block.repeatThreshold, 'repeatThreshold', 3, 2],
    [block.failureThreshold, 'failureThreshold', 3, 2],
    [block.windowSize, 'windowSize', 6, 3],
    [block.pruneHeadChars, 'pruneHeadChars', 400, 0],
    [block.pruneTailChars, 'pruneTailChars', 400, 0],
    [block.pruneJudgeMinChars, 'pruneJudgeMinChars', 10000, 0],
    [block.closingEvidenceChars, 'closingEvidenceChars', 2400, 200]
  ];
  const resolved: Record<string, number> = {};
  for (const [value, name, fallback, minimum] of counts) {
    if (value === undefined) {
      resolved[name] = fallback;
      continue;
    }
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`interventions.${name} must be an integer >= ${minimum} (got "${String(value)}")`);
    }
    resolved[name] = value;
  }

  const minConfidence = block.minConfidence ?? 0.6;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`interventions.minConfidence must be a number in [0, 1] (got "${String(block.minConfidence)}")`);
  }
  const pruneFloorRatio = block.pruneFloorRatio ?? 0.5;
  if (!Number.isFinite(pruneFloorRatio) || pruneFloorRatio < 0 || pruneFloorRatio > 1) {
    throw new Error(`interventions.pruneFloorRatio must be a number in [0, 1] (got "${String(block.pruneFloorRatio)}")`);
  }
  const claimMinConfidence = block.claimMinConfidence ?? 0.5;
  if (!Number.isFinite(claimMinConfidence) || claimMinConfidence < 0 || claimMinConfidence > 1) {
    throw new Error(
      `interventions.claimMinConfidence must be a number in [0, 1] (got "${String(block.claimMinConfidence)}")`
    );
  }
  // The segment-judging floor is layered on the prune threshold: judging below
  // the size at which pruning even runs is meaningless. Rather than refusing a
  // save that raises `pruneThreshold` alone (the panel exposes it independently,
  // and the user should not have to raise a second field to keep their edit),
  // the effective floor is lifted to the prune threshold. The panel reports the
  // lifted value, which is the one the runtime actually uses.
  const pruneJudgeMinChars = Math.max(resolved.pruneJudgeMinChars!, pruneThreshold);

  return {
    mode,
    capabilities,
    // One capability may be enabled by its own override while the master mode is
    // `off`, so the switch that decides whether anything is installed reads the
    // effective modes rather than the master alone.
    enabled: INTERVENTION_CAPABILITIES.some((capability) => capabilities[capability] !== 'off'),
    maxInterventionsPerTurn: resolved.maxInterventionsPerTurn!,
    maxJudgmentsPerTurn: resolved.maxJudgmentsPerTurn!,
    maxJudgmentsPerSession: resolved.maxJudgmentsPerSession!,
    repeatThreshold: resolved.repeatThreshold!,
    failureThreshold: resolved.failureThreshold!,
    minConfidence,
    windowSize: resolved.windowSize!,
    pruneFloorRatio,
    pruneHeadChars: resolved.pruneHeadChars!,
    pruneTailChars: resolved.pruneTailChars!,
    pruneJudgeMinChars,
    claimMinConfidence,
    closingEvidenceChars: resolved.closingEvidenceChars!,
    intent: optionalText(block.intent) ?? 'extract diagnostics, relevant results and errors'
  };
}

/**
 * Normalize one profile's model list and its single selected entry.
 *
 * Two authored shapes are accepted, and they mean the same thing:
 *
 * - `modelIds: [a, b, c]` + `selectedModel: b` — the g-066 shape, any number of
 *   ids with one in force;
 * - `model: a` — the pre-g-066 shape, which is exactly `modelIds: [a]` selected.
 *   Accepted so an existing connection keeps working untouched; **no migration
 *   is written back**, so opening the panel changes nothing on disk.
 *
 * Both at once is refused rather than merged: they are two different statements
 * about which models exist, and picking one would silently drop the other.
 * A `selectedModel` outside the list is *not* an error here — resolution reports
 * it (`activeProfileModelMissing`) so the panel can point at the field.
 *
 * @param name - profile name, for the message.
 * @param entry - the authored profile.
 * @returns the normalized list and the selected id (when the profile names one).
 * @throws Error when `modelIds` is not a list of non-empty strings, or when both
 *   shapes are authored.
 */
function resolveProfileModels(
  name: string,
  entry: ReflexSystemOneProfile
): { modelIds: string[]; selectedModel?: string } {
  const legacy = optionalText(entry.model);
  const authored = entry.modelIds;
  const selectedModel = optionalText(entry.selectedModel);
  // An **empty** list is not an authoring: schemastery materializes `modelIds: []`
  // for every profile that declares the field's schema but no value, so a legacy
  // `model: x` arrives beside an empty list rather than alone. Treating that as
  // "both shapes authored" would reject every pre-g-066 connection the moment it
  // passes through the schema — the exact compatibility this rule protects.
  if (Array.isArray(authored) && authored.length === 0 && legacy !== undefined) {
    return checkedSelection(name, [legacy], selectedModel);
  }
  if (authored !== undefined && authored !== null) {
    if (!Array.isArray(authored)) {
      throw new Error(`systemOne.profiles["${name}"].modelIds must be a list of model ids`);
    }
    if (legacy !== undefined) {
      throw new Error(
        `systemOne.profiles["${name}"] authors both model and modelIds; keep modelIds and selectedModel, or keep the single model`
      );
    }
    const modelIds: string[] = [];
    for (const [index, raw] of authored.entries()) {
      const id = optionalText(typeof raw === 'string' ? raw : undefined);
      if (id === undefined) {
        throw new Error(`systemOne.profiles["${name}"].modelIds[${String(index)}] must be a non-empty model id`);
      }
      // Duplicates are collapsed: the list is a set of choices, and two rows for
      // one id would let the page show a selection that is not a selection.
      if (!modelIds.includes(id)) modelIds.push(id);
    }
    return checkedSelection(name, modelIds, selectedModel);
  }
  return checkedSelection(name, legacy === undefined ? [] : [legacy], selectedModel);
}

/**
 * Refuse the one authored selection that can never run.
 *
 * A `selectedModel` **outside** `modelIds` is not a preference to be re-resolved
 * later: it names a model this connection does not offer, and every consumer —
 * runtime, connection test, panel — would have to invent an answer. g-066
 * att-002 closes it here, at the write, so it cannot be saved in the first
 * place. A selection beside an **empty** list is the same mistake with nothing
 * to select: it is refused rather than silently kept as "select nothing".
 *
 * (The resolution still reports such a document — {@link
 * ResolvedSystemOneConfig.activeProfileModelMissing} — because a file edited by
 * hand reaches it without passing through here, and the runtime then refuses to
 * connect instead of running another model.)
 *
 * @param name - profile name, for the message.
 * @param modelIds - the normalized list.
 * @param selectedModel - the authored selection, when one was.
 * @returns the normalized list and selection.
 * @throws Error when the selection names nothing in the list.
 */
function checkedSelection(
  name: string,
  modelIds: string[],
  selectedModel: string | undefined
): { modelIds: string[]; selectedModel?: string } {
  if (selectedModel !== undefined && !modelIds.includes(selectedModel)) {
    throw new Error(
      `systemOne.profiles["${name}"].selectedModel "${selectedModel}" is not one of its modelIds (${
        modelIds.length === 0 ? 'the list is empty' : modelIds.join(', ')
      }); select a listed model instead`
    );
  }
  return { modelIds, ...(selectedModel === undefined ? {} : { selectedModel }) };
}

/**
 * Trim one optional authored string, treating blank text as absent.
 * @param value - authored value.
 * @returns the trimmed text, or `undefined` when nothing usable was authored.
 */
function optionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate the System One connection block and fill in every default.
 *
 * ## The resolution rule (g-066: one connection, the active profile)
 *
 * **Only the active profile connects.** Every connection field — `baseUrl`,
 * `model`, `apiKey`, `apiKeyEnv`, `timeoutMs`, `backend` — comes from the
 * profile `active` names, or stays `undefined` and is then decided by the
 * backend's own environment read and documented default.
 *
 * There is no block of last resort. A document with no valid active profile
 * resolves to {@link ResolvedSystemOneConfig.unconfigured} with **no** connection
 * fields at all, so nothing downstream can invent one:
 *
 * | document                                  | `unconfigured`            |
 * | ----------------------------------------- | ------------------------- |
 * | no profiles at all                        | `no-profiles`             |
 * | profiles, none activated                  | `no-active-profile`       |
 * | `active` naming a profile that is not there | `active-profile-missing`  |
 * | only the pre-g-066 flat fields             | `legacy-config-required`  |
 *
 * The pre-g-066 merge ("active profile over flat block over environment") was
 * removed because the *fallback* was the bug: a mistyped or missing activation
 * ran a connection the user never selected. The legacy fields are still *read*,
 * but only to name the problem in `legacy-config-required` — converting them into
 * a profile would be a silent configuration change (and, for `apiKeyEnv`, a
 * silent choice between a literal key and a variable), so this function never
 * does it.
 *
 * `apiKey` and `apiKeyEnv` stay independent, so a profile may carry a literal key
 * while naming no variable, or name a variable and carry no key;
 * {@link resolveApiKeyWithSource} decides which the transport presents.
 *
 * @param backend - the top-level backend selector (the fallback implementation
 *   choice for a profile that states none).
 * @param authored - the authored `systemOne` block.
 * @returns the resolved connection settings.
 * @throws Error when a field is present but unusable.
 */
export function resolveSystemOneConfig(
  backend: 'auto' | 'mock' | 'jev' | 'vllm' | undefined,
  authored: ReflexSystemOneConfig | undefined
): ResolvedSystemOneConfig {
  const selected = backend ?? 'auto';
  if (!(['auto', 'mock', 'jev', 'vllm'] as const).includes(selected)) {
    throw new Error(`backend must be one of auto, mock, jev, vllm (got "${String(backend)}")`);
  }
  const profiles = resolveSystemOneProfiles(authored?.profiles);
  const hasProfiles = Object.keys(profiles).length > 0;
  const active = optionalText(authored?.active);
  const activeProfile = active === undefined ? undefined : profiles[active];
  const activeProfileMissing = active !== undefined && activeProfile === undefined;

  // The shared half of the resolved shape: what the document authors, and
  // nothing that could be mistaken for a connection.
  const authoredShape: ResolvedSystemOneConfig = {
    backend: selected,
    ...(hasProfiles ? { profiles } : {}),
    ...(active === undefined ? {} : { active }),
    ...(activeProfileMissing ? { activeProfileMissing: true } : {})
  };

  if (activeProfile === undefined) {
    // Nothing was activated. Which of the four absence reasons applies decides
    // the copy the panel shows and the message the runtime logs, so the facts are
    // kept apart rather than collapsed into "not configured".
    const legacy = legacyConnectionAuthored(authored);
    const unconfigured = activeProfileMissing
      ? ('active-profile-missing' as const)
      : hasProfiles
        ? ('no-active-profile' as const)
        : legacy
          ? ('legacy-config-required' as const)
          : ('no-profiles' as const);
    return { ...authoredShape, unconfigured };
  }

  // The profile's *selected* model: the one the runtime sends and the probe
  // tests. A selection outside the list is reported — never resolved to "the
  // first one", which would run a model nobody picked.
  const modelIds = activeProfile.modelIds ?? [];
  const selectedModel = modelForProfile(activeProfile, modelIds);
  const modelSelectionBroken = selectedModel?.missing === true;
  // The implementation this connection really runs (g-067 att-002), resolved by
  // the precedence {@link connectionTarget} applies, so the runtime and the
  // connection test cannot describe two different transports.
  const implementationSelector = effectiveImplementation(selected, activeProfile.backend, activeProfile);
  // The timeout is already validated per profile (`resolveProfileEntry` runs on
  // every entry, the active one included), so this is a read, not a re-check: a
  // second copy of the predicate here would be a check nothing can reach, and
  // the mutation control proved it — disabling *this* line left every test green.
  const timeoutMs = activeProfile.timeoutMs;
  // Which model the transport would *really* send (g-066 att-002), decided by
  // the one function the connection test reads as well.
  const planned = plannedModel(modelIds, implementationSelector, selectedModel);
  const connection = {
    ...authoredShape,
    // The selector this connection really runs under, *after* the spread so the
    // authored top-level value cannot re-assert itself over the row's choice.
    backend: implementationSelector,
    ...(activeProfile.baseUrl === undefined ? {} : { baseUrl: activeProfile.baseUrl }),
    ...(modelSelectionBroken || selectedModel?.model === undefined ? {} : { model: selectedModel.model }),
    ...(activeProfile.apiKeyEnv === undefined ? {} : { apiKeyEnv: activeProfile.apiKeyEnv }),
    ...(activeProfile.apiKey === undefined ? {} : { apiKey: activeProfile.apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(modelSelectionBroken ? { activeProfileModelMissing: true } : {})
  };
  // A model the configuration puts in force but the runtime cannot honour is a
  // refusal, not a connection: `unconfigured` means "build no transport", which
  // is the only way the backend's default can never stand in for it.
  if (planned.unusable !== undefined) return { ...connection, unconfigured: planned.unusable };
  // Spread conditionally: `model: undefined` would still be a *present* key, and
  // "absent" is what the panel and the probe read as "names no model".
  return planned.model === undefined ? connection : { ...connection, model: planned.model };
}

/**
 * The model a connection would actually send, or why it can send none.
 *
 * The single implementation of the rule the runtime and the connection test both
 * obey (g-066 att-002). It exists because `model === undefined` did *not* mean
 * "no model": every remote backend fills an absent `model` with `|| DEFAULT`, and
 * `auto` may additionally take a `SYSTEM_ONE_MODEL` from the environment. Left
 * to the backend, a broken selection became a live request for a model nobody
 * chose, while the probe — which has no such default — sent nothing. Both ends
 * now ask this one function, in the same process, so they cannot disagree.
 *
 * - the profile lists ids and selects one: that id;
 * - its selection is outside the list: **unusable** (`model-selection-invalid`),
 *   never the first id and never an implementation default;
 * - it lists no id: the default of the implementation that would be built, read
 *   from the same environment the backend reads — unless that implementation is
 *   not determinable, in which case it is **unusable**
 *   (`model-selection-unusable`) rather than a guess between two defaults;
 * - `mock` connects nowhere and names no model.
 *
 * @param modelIds - the profile's model list.
 * @param backend - the effective implementation selector.
 * @param selected - what {@link modelForProfile} answered for the profile.
 * @param env - the environment the backend would read.
 * @returns the model to send, or the refusal tag.
 */
function plannedModel(
  modelIds: readonly string[],
  backend: 'auto' | 'mock' | 'jev' | 'vllm',
  selected: { model?: string; missing?: boolean },
  env: Record<string, string | undefined> = process.env
): { model?: string; unusable?: 'model-selection-invalid' | 'model-selection-unusable' } {
  if (selected.missing === true) return { unusable: 'model-selection-invalid' };
  if (selected.model !== undefined) return { model: selected.model };
  const fallback = defaultModelAnswer(backend, env);
  if (fallback.unusable === true) return { unusable: 'model-selection-unusable' };
  return fallback.model === undefined ? {} : { model: fallback.model };
}

/**
 * The model a backend would fall back to, for a connection that names none.
 *
 * Only the *defaults* of the two remote implementations are modelled, under the
 * same environment precedence as the backend classes (explicit option, then
 * `SYSTEM_ONE_MODEL`, then the per-implementation variable, then the constant).
 * The in-process mock is not configured by any of this and has never touched an
 * endpoint, so it names no model.
 *
 * `unusable` is the "there is a model, but no backend here could send it"
 * answer: an `auto` provider chosen from the environment by a URL rather than an
 * explicit provider.
 *
 * @param backend - the effective implementation selector.
 * @param env - the environment the backend would read; the process environment by
 *   default, so the runtime and the probe (in that same process) agree.
 * @returns the model that would be sent, and whether it is unusable.
 */
function defaultModelAnswer(
  backend: 'auto' | 'mock' | 'jev' | 'vllm',
  env: Record<string, string | undefined> = process.env
): { model?: string; unusable?: true } {
  const named = optionalText(env.SYSTEM_ONE_MODEL);
  if (backend === 'mock') return {};
  if (backend === 'jev') return { model: named ?? optionalText(env.JEV_MODEL) ?? 'jev-latest' };
  if (backend === 'vllm') {
    return { model: named ?? optionalText(env.VLLM_MODEL) ?? 'Qwen/Qwen2.5-7B-Instruct' };
  }
  // `auto`: the vendored factory picks the implementation from the environment.
  // It is modelled exactly as far as it is deterministic — an explicit provider
  // variable selects one — and anything else is refused rather than guessed.
  const provider = (env.SYSTEM_ONE_BACKEND ?? env.REFLEX_BACKEND ?? '').trim().toLowerCase();
  if (provider === 'jev') return { model: named ?? optionalText(env.JEV_MODEL) ?? 'jev-latest' };
  if (provider === 'vllm' || provider === 'simple-jev' || provider === 'logits') {
    return { model: named ?? optionalText(env.VLLM_MODEL) ?? 'Qwen/Qwen2.5-7B-Instruct' };
  }
  if (provider.length === 0) {
    if (!named && (env.SYSTEM_ONE_API_KEY || env.JEV_API_KEY)) {
      return { model: optionalText(env.JEV_MODEL) ?? 'jev-latest' };
    }
    if (!named && (env.VLLM_BASE_URL || env.OPENAI_BASE_URL)) {
      return { model: optionalText(env.VLLM_MODEL) ?? 'Qwen/Qwen2.5-7B-Instruct' };
    }
    // Neither credential nor endpoint: the factory would build the in-process
    // mock. That is still *not* "no model" — the runtime would answer from
    // heuristics while the panel showed a configured connection — so it is
    // refused like any other undeterminable implementation. A deployment that
    // wants the in-process answer asks for it (`backend: mock`).
  }
  // A model was named but no implementation can be determined to send it.
  return { unusable: true };
}

/**
 * The model one profile puts in force, and whether the selection is broken.
 *
 * A legacy single `model` is a one-entry list, so the two authored shapes answer
 * the same way: `selectedModel` if it names an entry, else the first entry, else
 * absent (a connection may name no model at all and let the backend default it).
 * @param profile - the normalized profile.
 * @param modelIds - its model list.
 * @returns the resolved choice; `missing` marks a selected id outside the list.
 */
function modelForProfile(
  profile: ResolvedSystemOneProfile,
  modelIds: readonly string[]
): { model?: string; missing?: boolean } {
  const chosen = profile.selectedModel;
  if (chosen === undefined) return modelIds.length === 0 ? {} : { model: modelIds[0] };
  // The list is what decides: an id outside it cannot be run, even when it is the
  // only text the document carries.
  return modelIds.includes(chosen) ? { model: chosen } : { missing: true };
}

/**
 * Whether the document carries the pre-g-066 flat connection fields.
 *
 * Read purely to *name* the problem: a deployment authored that way used to
 * connect implicitly, and "no profile configured" would be a confusing answer
 * for a document that plainly holds an address. Never a connection itself.
 * @param authored - the authored `systemOne` block.
 * @returns true when any legacy connection field is non-blank.
 */
function legacyConnectionAuthored(authored: ReflexSystemOneConfig | undefined): boolean {
  return [authored?.baseUrl, authored?.model, authored?.apiKeyEnv].some((value) => optionalText(value) !== undefined);
}

/**
 * Normalize every authored profile, rejecting names the panel cannot address.
 *
 * A name becomes both a `z.dict` key and a segment of a settings `set` path, so
 * the rules are the ones those two consumers impose: non-blank, no `.` (the path
 * separator) and unique after case folding (the panel shows names as identifiers
 * and two rows differing only in case would be indistinguishable).
 *
 * @param authored - the authored `profiles` dictionary.
 * @returns the normalized profiles, in authored order.
 * @throws Error when a name or a field is unusable.
 */
function resolveSystemOneProfiles(
  authored: Record<string, ReflexSystemOneProfile> | undefined
): Record<string, ResolvedSystemOneProfile> {
  if (authored === undefined) return {};
  if (authored === null || typeof authored !== 'object' || Array.isArray(authored)) {
    throw new Error('systemOne.profiles must be a dictionary of profile name → connection settings');
  }
  const profiles: Record<string, ResolvedSystemOneProfile> = {};
  const seen = new Map<string, string>();
  for (const [rawName, entry] of Object.entries(authored)) {
    const name = optionalText(rawName);
    if (name === undefined) throw new Error('systemOne.profiles keys must be non-empty profile names');
    if (name.includes('.')) {
      throw new Error(`systemOne.profiles name must not contain "." (got "${name}"): it is the settings path separator`);
    }
    const folded = name.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) {
      throw new Error(`systemOne.profiles has two names differing only in case ("${clash}" and "${name}")`);
    }
    seen.set(folded, name);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`systemOne.profiles["${name}"] must be an object of connection settings`);
    }
    const profileBackend = optionalText(entry.backend);
    if (profileBackend !== undefined && !(['auto', 'mock', 'jev', 'vllm'] as const).includes(profileBackend as never)) {
      throw new Error(`systemOne.profiles["${name}"].backend must be one of auto, mock, jev, vllm (got "${profileBackend}")`);
    }
    const timeoutMs = entry.timeoutMs;
    // The one place a timeout is validated: every profile goes through here, so
    // the active profile is covered without a second check of its own.
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`systemOne.profiles["${name}"].timeoutMs must be a positive integer (got "${String(timeoutMs)}")`);
    }
    const baseUrl = optionalText(entry.baseUrl);
    const { modelIds, selectedModel } = resolveProfileModels(name, entry);
    const apiKey = optionalText(entry.apiKey);
    const apiKeyEnv = optionalText(entry.apiKeyEnv);
    profiles[name] = {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(modelIds.length === 0 ? {} : { modelIds }),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(profileBackend === undefined ? {} : { backend: profileBackend as 'auto' | 'mock' | 'jev' | 'vllm' })
    };
  }
  return profiles;
}

/**
 * The environment variables the key chain falls back to, in order.
 *
 * This list is the *whole* fallback, exported so callers that want to name the
 * candidates (the panel's "nothing configured" copy) read it from here instead of
 * restating it. Changing the order here changes it for the backend, the panel,
 * and the connection probe at once — which is the point.
 */
export const API_KEY_ENV_FALLBACKS = ['SYSTEM_ONE_API_KEY', 'JEV_API_KEY', 'VLLM_API_KEY', 'OPENAI_API_KEY'] as const;

/**
 * The outcome of resolving one connection's key.
 *
 * A discriminated union rather than `{ key } | undefined` (g-059): "the block
 * named a variable and that variable is empty" is a *different fact* from "the
 * block named nothing and nothing was exported", and the panel has to say which.
 * Collapsing both into `undefined` is exactly what let the two be conflated.
 *
 * - `{ key }` — a key was found; {@link source} says where.
 * - `{ missing: 'named', variable }` — the block **named** `variable` and it holds
 *   nothing. Naming is a lock: no fallback variable was consulted, and none may be.
 * - `undefined` — the block named nothing and no fallback variable holds a key.
 */
export type ApiKeyResolution = ResolvedApiKey | ApiKeyNotFound;

/** Where a resolved key came from. */
export interface ResolvedApiKey {
  /** The key itself. Stays in the host process; no projection serializes it. */
  key: string;
  /**
   * `profile` for a literal key from the settings document; `env` for the
   * variable the block named; `fallback` for a {@link API_KEY_ENV_FALLBACKS}
   * variable reached because the block named none. `fallback` is a separate tag
   * so the panel can print "（回退）" — a deployment that *meant* to name a
   * variable can then see that it in fact named nothing.
   */
  source: 'profile' | 'env' | 'fallback';
  /** The variable that supplied the key when {@link source} is `env` or `fallback`. */
  variable?: string;
}

/** The variable the block named holds nothing, and the lookup stopped there. */
export interface ApiKeyNotFound {
  /** Why nothing resolved. */
  missing: 'named';
  /** The variable the block named — the empty one, never a fallback. */
  variable: string;
}

/**
 * Resolve the API key for a connection, and say where it came from.
 *
 * This is the **single source of truth** for the key chain. The backend
 * constructors, the panel's readiness projection, and the `/systemone/test`
 * probe all call it, so the panel can never again report a different reality
 * from the one the runtime acts on.
 *
 * The chain, in order:
 *
 * 1. **`config.apiKey`** — a literal key from the settings document, where it is
 *    a declared `role('secret')` slot. It outranks every variable and makes
 *    `apiKeyEnv` irrelevant: a deployment that stores the secret outright has no
 *    use for a variable *name*.
 * 2. **`config.apiKeyEnv`** — the variable the connection *names*. **Naming
 *    locks**: this is the only variable consulted, and if it is empty the result
 *    is {@link ApiKeyNotFound} — never a fallback to step 3. The settings
 *    document carries only the name, so a panel write cannot leak the value.
 * 3. **{@link API_KEY_ENV_FALLBACKS}** — only when step 2 named nothing:
 *    `SYSTEM_ONE_API_KEY`, `JEV_API_KEY`, `VLLM_API_KEY`, `OPENAI_API_KEY`,
 *    first non-empty wins.
 *
 * Step 2 no longer falls through to step 3 (g-059). The earlier choice — "naming
 * a variable is not a request to lock onto it" — was reversed by the owner: a
 * deployment that names `SYSTEM_ONE_API_KEY` while only `JEV_API_KEY` is
 * exported must read as *missing*, not silently work from a variable nobody
 * named. Locking is now implied by naming, so an empty value cannot be mistaken
 * for "nobody named anything".
 *
 * An empty string counts as absent at every step, so an exported-but-empty
 * variable is never a credential.
 *
 * A **blank** `apiKeyEnv` (spaces only) is not a naming:
 * {@link resolveSystemOneConfig} trims it away before this function sees it, so
 * a stray space in the name field keeps the historical fallback instead of
 * locking onto a variable whose name is a space.
 *
 * @param config - resolved System One connection settings (a profile's, or the flat block's).
 * @param env - environment to read; defaults to `process.env`.
 * @returns the key and its provenance; the locked-but-empty fact; or `undefined`
 *   when nothing was named and nothing was exported.
 */
export function resolveApiKeyWithSource(
  config: Pick<ResolvedSystemOneConfig, 'apiKeyEnv' | 'apiKey'>,
  env: Record<string, string | undefined> = process.env
): ApiKeyResolution | undefined {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return { key: config.apiKey, source: 'profile' };
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0) {
    const named = env[config.apiKeyEnv];
    if (typeof named === 'string' && named.length > 0) return { key: named, source: 'env', variable: config.apiKeyEnv };
    // Naming locks (g-059): a named-but-empty variable ends the lookup here. It
    // must not reach the fallback loop, or the panel would report a lock the
    // runtime never honoured.
    return { missing: 'named', variable: config.apiKeyEnv };
  }
  for (const variable of API_KEY_ENV_FALLBACKS) {
    const value = env[variable];
    if (typeof value === 'string' && value.length > 0) return { key: value, source: 'fallback', variable };
  }
  return undefined;
}

/**
 * The key a resolution carries, or `undefined` for both kinds of absence.
 *
 * The one place the union is flattened: a transport only needs to know *whether*
 * there is a key, never *why* there is none. Panel copy must not use this —
 * telling "named but empty" from "nothing configured" is the point of the union.
 * @param resolution - a {@link resolveApiKeyWithSource} result.
 * @returns the key, when one resolved.
 */
export function resolvedKeyOf(resolution: ApiKeyResolution | undefined): string | undefined {
  return resolution === undefined || !('key' in resolution) ? undefined : resolution.key;
}

/**
 * Read the API key a resolved connection block points at.
 *
 * A thin wrapper over {@link resolveApiKeyWithSource}: callers that need only the
 * value use this one, and callers that must report *where* it came from use that
 * one. Deliberately kept as the only spelling of the chain — a second
 * implementation here is exactly the drift (`panel says empty, backend works`)
 * this pair exists to prevent.
 *
 * @param config - resolved System One connection settings.
 * @param env - environment to read; defaults to `process.env`.
 * @returns the key, or `undefined` when no source holds one.
 */
export function resolveApiKey(
  config: Pick<ResolvedSystemOneConfig, 'apiKeyEnv' | 'apiKey'>,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return resolvedKeyOf(resolveApiKeyWithSource(config, env));
}

/** The connection facts one probe target carries (never a value it can echo). */
export interface ConnectionTarget {
  /** Profile name this target was projected from. */
  name: string;
  /** Backend that would serve this target. */
  backend: 'auto' | 'mock' | 'jev' | 'vllm';
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /** The key to present. Stays in this process; never serialized. */
  apiKey?: string;
  timeoutMs?: number;
  /**
   * This connection's model cannot be sent (g-066 att-002): its `selectedModel`
   * is not in its list, or no implementation could be sure which model to ask
   * for when it names none. A probe reports this instead of guessing a model.
   */
  modelUnusable?: boolean;
}

/**
 * Project one profile's connection facts for the connection test.
 *
 * The probe must send exactly the request the runtime would send, so both read
 * the *same* profile fields: base URL, the **selected** model
 * ({@link modelForProfile}), the key and its variable, the timeout, and the
 * backend. Since g-066 there is nothing to merge — a profile that states no
 * `baseUrl` inherits from **nobody**, and the backend's own environment read is
 * the only thing left below it, exactly as for the runtime.
 *
 * The model is derived rather than read from {@link ConnectionTarget.model}, so a
 * probe can never test a model the runtime does not run: one `selectedModel`
 * outside `modelIds` makes both of them **absent** (and the panel says why,
 * while {@link resolveSystemOneConfig} refuses to connect at all). A profile that
 * lists no model is the one case where the answer is the implementation default
 * — the same {@link plannedModel} the resolved connection uses, so the two can
 * never disagree about which model a connection asks for.
 *
 * `modelUnusable` is the probe's whole answer for a connection whose model
 * cannot be sent: it must not guess one instead.
 *
 * @param flat - the resolved block, supplying the backend fallback only.
 * @param name - profile name (the probe's label).
 * @param profile - the profile to project.
 * @returns the target's connection facts.
 */
export function connectionTarget(
  flat: Pick<ResolvedSystemOneConfig, 'backend'>,
  name: string,
  profile: ResolvedSystemOneProfile
): ConnectionTarget {
  const baseUrl = optionalText(profile.baseUrl);
  // The same rule {@link resolveSystemOneConfig} applies (g-067 att-002): one
  // function, so the test button cannot describe a transport the runtime does
  // not run — the divergence that got the first attempt blocked.
  const backend = effectiveImplementation(flat.backend ?? 'auto', profile.backend, profile);
  const modelIds = profile.modelIds ?? [];
  const resolved = plannedModel(modelIds, backend, modelForProfile(profile, modelIds));
  const model = resolved.model === undefined ? undefined : optionalText(resolved.model);
  const apiKeyEnv = optionalText(profile.apiKeyEnv);
  const apiKey = optionalText(profile.apiKey);
  const timeoutMs = profile.timeoutMs;
  return {
    name,
    backend,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(resolved.unusable === undefined ? {} : { modelUnusable: true }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

/** The transport a connection resolves to: the three the plugin can build. */
export type ConnectionImplementation = 'mock' | 'jev' | 'vllm';

/**
 * Which backend selector one active connection really runs under (g-067 att-002).
 *
 * One rule, asked by the resolved connection and by {@link connectionTarget}, so
 * the runtime and the connection test cannot disagree about the transport.
 *
 * The long-standing precedence stands: **a row that names an implementation
 * decides for itself**, and an unnamed row follows the top-level selector. What
 * g-067 adds is a single, narrow exception — see {@link isShippedFactoryRow}.
 *
 * @param selected - the top-level selector.
 * @param rowBackend - the profile's own `backend`, when it states one.
 * @param profile - the profile, so the shipped factory row can be recognised.
 * @returns the selector to resolve an implementation from.
 */
function effectiveImplementation(
  selected: 'auto' | 'mock' | 'jev' | 'vllm',
  rowBackend: 'auto' | 'mock' | 'jev' | 'vllm' | undefined,
  profile: ResolvedSystemOneProfile
): 'auto' | 'mock' | 'jev' | 'vllm' {
  // The shipped factory row binds `jev` so the *environment* cannot redirect it —
  // but that binding must not silently overrule a deployment that stated its own
  // implementation. Two explicit top-level settings therefore still win over the
  // shipped row, and only over it: an authored row keeps the usual precedence.
  //
  // - `mock` answers in-process and opens no socket, so honouring it cannot send
  //   the connection's credential anywhere. Without this, `backend: mock` — the
  //   setting every fixture in this package runs on — would dial the official
  //   gateway with whatever key the chain resolved.
  // - `vllm` asks the runtime to speak the logits protocol; leaving it on the
  //   row's bound `jev` would answer in a protocol the deployment did not choose.
  //   Its own endpoint is the row's, so nothing is reached that the connection
  //   does not name.
  //
  // `jev` needs no exception (it is what the row already binds), and `auto` is
  // precisely the case the binding exists to override.
  if ((selected === 'mock' || selected === 'vllm') && rowBackend === 'jev' && isShippedFactoryRow(profile)) {
    return selected;
  }
  return rowBackend ?? selected;
}

/**
 * Whether one profile is the **unedited** shipped factory connection.
 *
 * The exception above must not leak to an authored row that merely resembles the
 * factory one: a user who edited the address, the model or the key variable has
 * stated their own connection, and the usual precedence must apply to it. Value
 * equality is the only stable handle — schemastery materializes the default into
 * a fresh object on every resolution.
 *
 * The model is read through {@link modelForProfile}, the rule every consumer of
 * a profile's model uses, so the schema's legacy `model` beside an empty
 * `modelIds` is recognised exactly like an explicit one-entry list.
 *
 * @param profile - a resolved profile.
 * @returns true for the shipped factory row, unedited.
 */
function isShippedFactoryRow(profile: ResolvedSystemOneProfile): boolean {
  const modelIds = profile.modelIds ?? [];
  return (
    profile.baseUrl === FACTORY_SYSTEMONE_PROFILE.baseUrl &&
    profile.apiKeyEnv === FACTORY_SYSTEMONE_PROFILE.apiKeyEnv &&
    profile.backend === FACTORY_SYSTEMONE_PROFILE.backend &&
    modelForProfile(profile, modelIds).model === FACTORY_SYSTEMONE_PROFILE.model
  );
}

/**
 * The implementation a connection's backend selector really builds (g-067 att-002).
 *
 * The one place `auto` is turned into a concrete transport, asked by both ends
 * of the same connection: {@link createBackend} builds from it, and the
 * connection test probes with it. Any second derivation is a divergence waiting
 * to happen — and one already happened: the probe hard-coded `auto → jev` while
 * `auto` in the runtime delegated to the vendored factory, which reads the
 * environment. Under `SYSTEM_ONE_BACKEND=vllm` the test button probed the
 * official Jev URL and reported green while the runtime dialled a vLLM endpoint
 * with the same key.
 *
 * `auto` is modelled exactly as far as it is deterministic: the vendored
 * factory's own precedence, read from the environment —
 *
 * 1. an explicit `SYSTEM_ONE_BACKEND` / `REFLEX_BACKEND` selects that provider
 *    (`jev`, or `vllm`/`simple-jev`/`logits` as the logits backend);
 * 2. with no selector, a Jev credential (`SYSTEM_ONE_API_KEY` / `JEV_API_KEY`)
 *    selects Jev, then a vLLM endpoint selects the logits backend;
 * 3. anything else is the in-process mock.
 *
 * Note what this function does **not** do: it does not make `auto` safe. It
 * makes the two halves honest about the same answer. A connection that must not
 * follow the environment pins its own `backend` instead — which is what the
 * factory row does ({@link FACTORY_SYSTEMONE_PROFILE}).
 *
 * The one deviation from the factory is deliberate: with a selector naming a
 * provider, the factory's "any other name falls through to the mock" is kept,
 * because that is what the runtime really builds — guessing Jev there would
 * reintroduce the false green from the other side.
 *
 * @param selector - the connection's effective backend selector.
 * @param env - the environment the `auto` factory would read.
 * @returns the transport that would be built.
 */
export function connectionImplementation(
  selector: string,
  env: Record<string, string | undefined> = process.env
): ConnectionImplementation {
  if (selector === 'mock') return 'mock';
  if (selector === 'jev') return 'jev';
  if (selector === 'vllm') return 'vllm';
  // `auto` (and anything unexpected reaching here): the factory's own order.
  const provider = (env.SYSTEM_ONE_BACKEND ?? env.REFLEX_BACKEND ?? '').trim().toLowerCase();
  if (provider === 'jev') return 'jev';
  if (provider === 'vllm' || provider === 'simple-jev' || provider === 'logits') return 'vllm';
  if (provider.length > 0) return 'mock';
  if (env.SYSTEM_ONE_API_KEY || env.JEV_API_KEY) return 'jev';
  if (env.VLLM_BASE_URL || env.OPENAI_BASE_URL) return 'vllm';
  return 'mock';
}

/**
 * Normalize one authored pool into detached `{ provider, model, description, tags }` entries,
 * rejecting candidates that would route back into the virtual provider.
 * @param model - virtual model id owning the pool.
 * @param entries - authored candidates.
 * @param virtualProvider - the virtual provider route.
 * @returns the normalized pool.
 * @throws Error when an entry is unusable or self-referential.
 */
function resolvePool(model: string, entries: ReflexModelPoolEntry[], virtualProvider: string): ModelPoolEntry[] {
  if (!Array.isArray(entries)) throw new Error(`routing.models.${model} must be a list of { provider, model } candidates`);

  return entries.map((entry, index) => {
    const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : '';
    const target = typeof entry?.model === 'string' ? entry.model.trim() : '';
    if (provider.length === 0 || target.length === 0) {
      throw new Error(`routing.models.${model}[${index}] needs a non-empty provider and model`);
    }
    if (provider.includes(':')) {
      throw new Error(`routing.models.${model}[${index}].provider must not contain ":" (got "${provider}")`);
    }
    if (provider === virtualProvider) {
      throw new Error(
        `routing.models.${model}[${index}] routes back into the virtual provider "${virtualProvider}"; a pool must name physical routes only`
      );
    }
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0) : [];
    return {
      provider,
      model: target,
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      ...(tags.length > 0 ? { tags } : {})
    };
  });
}

/**
 * Read a resolved config value out of its volatile marker.
 */
export function plainConfig(value: any): any {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return plainConfig(value.get());
  }
  if (Array.isArray(value)) {
    return value.map(item => plainConfig(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

/**
 * Collect the snapshot of every volatile config reference reachable from one
 * loader-resolved config.
 *
 * A config-only update in the Cordis loader never remounts the plugin: the
 * schemastery `volatile` marks tell the loader to commit the new values into the
 * running fiber's references and dispatch `loader/volatile-update`. Every
 * reference hands out a fresh snapshot object from `get()` when it is committed,
 * so comparing these snapshots by identity answers "did the live config change?"
 * without re-validating the whole document, and without the loader itself.
 *
 * @param value - a resolved config, raw config, or one of its blocks.
 * @param out - collector for the snapshot identities.
 * @returns the snapshots, in a stable traversal order; empty for a plain config.
 */
export function volatileSnapshots(value: unknown, out: unknown[] = []): unknown[] {
  if (value === null || typeof value !== 'object') return out;
  const reference = value as { get?: unknown };
  if (typeof reference.get === 'function') {
    out.push((reference.get as () => unknown)());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) volatileSnapshots(item, out);
    return out;
  }
  for (const child of Object.values(value as Record<string, unknown>)) volatileSnapshots(child, out);
  return out;
}

/**
 * Validate an authored config and fill in every default.
 * @param config - deployment config (already resolved by the loader, or raw).
 * @returns the fully-populated configuration.
 * @throws Error when the routing block names an unusable virtual provider or fallback.
 */
export function resolveConfig(config?: ReflexConfig): ResolvedReflexConfig {
  const unwrapped = plainConfig(config ?? {});
  const authoredEffort = (unwrapped as { effort?: { reasoningEffort?: unknown } } | null | undefined)?.effort;
  const authoredReasoning =
    authoredEffort !== null && typeof authoredEffort === 'object'
      ? (authoredEffort as { reasoningEffort?: unknown }).reasoningEffort
      : undefined;
  // Check the authored policy *before* the schema: a legacy concrete level then
  // gets the migration hint below instead of the schema's generic union error.
  if (typeof authoredReasoning === 'string') resolveEffortSetting(authoredReasoning);
  const validated = plainConfig(Config(unwrapped)) as ReflexConfig;
  const routing = validated.routing ?? {};
  const effort = validated.effort ?? {};

  const virtualProvider = (routing.virtualProvider ?? 'reflex').trim();
  if (virtualProvider.length === 0) throw new Error('routing.virtualProvider must be non-empty');
  if (virtualProvider.includes(':')) {
    throw new Error(`routing.virtualProvider must not contain ":" (got "${virtualProvider}")`);
  }

  const setting = resolveEffortSetting(effort.reasoningEffort);

  const authored = routing.models ?? {};
  const models: Record<string, ModelPoolEntry[]> = {};
  for (const [model, entries] of Object.entries(authored)) {
    if (model.trim().length === 0) throw new Error('routing.models keys must be non-empty virtual model ids');
    models[model] = resolvePool(model, Array.isArray(entries) ? entries : [], virtualProvider);
  }

  const fallback =
    typeof routing.fallback === 'string' && routing.fallback.trim().length > 0 ? parseFallback(routing.fallback) : undefined;
  if (fallback?.provider === virtualProvider) {
    throw new Error(`routing.fallback must not point back into the virtual provider "${virtualProvider}"`);
  }

  const effortFallback = effort.fallback ?? 'medium';
  if (!(ADAPTIVE_EFFORT_LEVELS as readonly string[]).includes(effortFallback)) {
    throw new Error(`effort.fallback must be one of ${ADAPTIVE_EFFORT_LEVELS.join(', ')} (got "${String(effortFallback)}")`);
  }
  const minConfidence = effort.minConfidence ?? 0.3;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`effort.minConfidence must be a number in [0, 1] (got "${String(effort.minConfidence)}")`);
  }
  const effortEnabled = effort.enabled ?? true;
  if (typeof effortEnabled !== 'boolean') {
    throw new Error(`effort.enabled must be a boolean (got "${String(effort.enabled)}")`);
  }

  return {
    backend: validated.backend ?? 'auto',
    toolPrefix: validated.toolPrefix ?? 'reflex_',
    ledgerPath: validated.ledgerPath,
    pruneThreshold: validated.pruneThreshold ?? 500,
    calibrationPath: validated.calibrationPath,
    systemOne: resolveSystemOneConfig(validated.backend, validated.systemOne),
    routing: {
      enabled: routing.enabled ?? true,
      virtualProvider,
      models,
      maxTaskChars: routing.maxTaskChars ?? 400,
      ...(fallback ? { fallback } : {})
    },
    effort: {
      enabled: effortEnabled,
      ...(setting === undefined ? {} : { setting }),
      fallback: effortFallback,
      minConfidence
    },
    tools: resolveToolsConfig(validated.tools),
    delegation: resolveDelegationConfig(validated.delegation),
    interventions: resolveInterventionsConfig(validated.interventions, validated.pruneThreshold ?? 500)
  };
}

/**
 * Validate the per-tool switch block and fill in every omitted suffix.
 *
 * Both failure modes are answered here, not by the schema: an unknown suffix
 * (a typo, or a tool this build does not ship) and a non-boolean value. A
 * deployment that cannot be honoured fails at resolution time rather than
 * half-registering its tools. The suffix vocabulary is this build's, so a
 * switch for a capability that is no longer a tool — `prune`,
 * `detect_stagnation`, `status_ledger` — is refused here instead of being
 * carried as a key that reads as "on" and registers nothing.
 *
 * A programmatic caller that passes the switch map itself (instead of wrapping
 * it in `enabled`) is rejected too: silently reading it as "nothing authored"
 * would turn that typo into a deployment where everything stays registered.
 *
 * @param authored - the authored `tools` block.
 * @returns every suffix of the vocabulary mapped to its effective switch.
 * @throws Error when the block, a key, or a value cannot be honoured.
 */
export function resolveToolsConfig(authored: ReflexToolsConfig | undefined): ResolvedToolsConfig {
  if (authored !== undefined && (authored === null || typeof authored !== 'object' || Array.isArray(authored))) {
    throw new Error(`tools must be an object mapping tool suffixes to booleans (got "${String(authored)}")`);
  }
  const block = authored ?? {};
  const extraKeys = Object.keys(block).filter((key) => key !== 'enabled');
  if (extraKeys.length > 0) {
    const rendered = extraKeys.map((key) => JSON.stringify(key)).join(', ');
    throw new Error(
      `tools has unknown key${extraKeys.length === 1 ? '' : 's'} ${rendered}; only "enabled" is supported`
    );
  }
  const switches = block.enabled;
  if (switches !== undefined && (switches === null || typeof switches !== 'object' || Array.isArray(switches))) {
    throw new Error(`tools.enabled must be an object mapping tool suffixes to booleans (got "${String(switches)}")`);
  }
  const authoredSwitches = switches ?? {};
  const unknown = Object.keys(authoredSwitches).filter((key) => !(REFLEX_TOOL_SUFFIXES as readonly string[]).includes(key));
  if (unknown.length > 0) {
    const rendered = unknown.map((key) => JSON.stringify(key)).join(', ');
    throw new Error(
      `tools.enabled has unknown tool ${unknown.length === 1 ? 'switch' : 'switches'} ${rendered}; legal suffixes are ${REFLEX_TOOL_SUFFIXES.join(', ')}`
    );
  }
  const enabled = {} as Record<ReflexToolSuffix, boolean>;
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    const value = authoredSwitches[suffix];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`tools.enabled.${suffix} must be a boolean (got "${String(value)}")`);
    }
    // Omitted entries take the per-suffix default instead of an unconditional
    // "on": `route` is off unless the deployment asks for it, and the panel,
    // the registry, and this resolver must all agree on that one table.
    enabled[suffix] = value ?? REFLEX_TOOL_DEFAULT_ENABLED[suffix];
  }
  return { enabled };
}

/**
 * Validate the delegation block and fill in its default.
 *
 * The default is `false` and it is load-bearing: with the switch on, the tool
 * is offered; with it off, `reflex_delegate` is not registered at all, because a
 * wrapper whose level cannot be delivered would be a capability that only looks
 * like one. A non-boolean is refused rather than coerced, for the same reason
 * every other block refuses one.
 * @param authored - the authored `delegation` block.
 * @returns the resolved switch.
 * @throws Error when the value is present but not a boolean.
 */
export function resolveDelegationConfig(authored: ReflexDelegationConfig | undefined): ResolvedDelegationConfig {
  if (authored !== undefined && (authored === null || typeof authored !== 'object' || Array.isArray(authored))) {
    throw new Error(`delegation must be an object (got "${String(authored)}")`);
  }
  const block = authored ?? {};
  const extraKeys = Object.keys(block).filter((key) => key !== 'enabled');
  if (extraKeys.length > 0) {
    const rendered = extraKeys.map((key) => JSON.stringify(key)).join(', ');
    throw new Error(`delegation has unknown key${extraKeys.length === 1 ? '' : 's'} ${rendered}; only "enabled" is supported`);
  }
  const value = block.enabled;
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`delegation.enabled must be a boolean (got "${String(value)}")`);
  }
  return { enabled: value ?? false };
}

/**
 * Validate one authored `reasoningEffort` value.
 *
 * Configuration only answers "should adaptive effort run at all?": the loader
 * restricts it to the trigger markers, and this repeats the check because
 * {@link resolveConfig} is also the entry point for a programmatic caller. A
 * concrete level is not a typo to ignore — it is an obsolete setting, so the
 * error says where that choice moved instead of silently dropping it.
 *
 * @param value - authored setting.
 * @returns the normalized trigger, or `undefined` when nothing was configured.
 * @throws Error when the value is not `reflex`/`auto` (including a concrete level).
 */
export function resolveEffortSetting(value: string | undefined): ReasoningEffortSetting | undefined {
  if (value === undefined) return undefined;
  const setting = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((EFFORT_TRIGGERS as readonly string[]).includes(setting)) {
    return setting as ReasoningEffortSetting;
  }
  throw new Error(
    `effort.reasoningEffort 只支持留空或 reflex（别名 auto）；要固定思考深度请在模型选择器里选择具体档位 (got "${String(value)}")`
  );
}

/**
 * Whether this configuration can actually route: enabled with at least one
 * non-empty pool. Without a pool the plugin registers no virtual provider at
 * all, so a misconfigured `reflex` selection can never masquerade as working.
 * @param config - resolved configuration.
 * @returns whether routing should be installed.
 */
export function routingActive(config: ResolvedReflexConfig): boolean {
  if (!config.routing.enabled) return false;
  return Object.values(config.routing.models).some((pool) => pool.length > 0);
}
