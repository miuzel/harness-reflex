import z from '@deepseek-ai/schemastery';

import { ADAPTIVE_EFFORT_LEVELS, EFFORT_LEVELS, EFFORT_TRIGGERS, type AdaptiveEffortLevel, type ReasoningEffortSetting } from './effort.js';
import { parseFallback, type ModelPoolEntry, type ModelPools, type PhysicalTarget } from './router.js';
// Runtime import, not a type-only one: the tool vocabulary is owned by the
// registry module, and validating `tools.enabled` against a second copy of the
// list is exactly the drift this import removes. `./tools.js` imports this
// module for types only, so no runtime cycle exists.
import { REFLEX_TOOL_DEFAULT_ENABLED, REFLEX_TOOL_SUFFIXES, type ReflexToolSuffix } from './tools.js';

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
 * Authored connection settings of the System One decision backend.
 *
 * The Settings panel edits this block, so it is deliberately secret-free: the
 * API key never enters the settings document. `apiKeyEnv` names the environment
 * variable that holds the key, which keeps the credential in the deployment's
 * own environment (and out of every `settings.describe` answer, whose redaction
 * only covers schema-declared secret slots).
 *
 * Every field is optional and *overrides* the environment for this plugin
 * instance only. An omitted field keeps the environment/environment-default
 * behaviour of the backend implementation, so an existing env-configured
 * deployment is unaffected by adding the block.
 */
export interface ReflexSystemOneConfig {
  /** Base URL of the Jev gateway or the OpenAI-compatible logits endpoint. */
  baseUrl?: string;
  /** Model id the backend asks for. */
  model?: string;
  /**
   * Name of the environment variable holding the API key (`SYSTEM_ONE_API_KEY`
   * by default). Never the key itself.
   */
  apiKeyEnv?: string;
  /** Per-request timeout in milliseconds. */
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
   * `'reflex'`/`'auto'` makes every turn decide its own effort through System 1;
   * one concrete level (`off`/`low`/`medium`/`high`) pins requests that carry no
   * effort of their own. Omitted = the plugin never touches `reasoningEffort`.
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
  /** Base URL override, absent when the environment decides. */
  baseUrl?: string;
  /** Model id override, absent when the environment decides. */
  model?: string;
  /** Environment variable that holds the API key; never the key itself. */
  apiKeyEnv?: string;
  /** Per-request timeout override in milliseconds. */
  timeoutMs?: number;
}

/** Effort configuration after defaults and validation have been applied. */
export interface ResolvedEffortConfig {
  /** Whether adaptive effort may decide anything; `true` unless authored otherwise. */
  enabled: boolean;
  /**
   * The adaptive trigger marker or the pinned level; `undefined` (the default)
   * leaves `reasoningEffort` entirely to the caller.
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
    .union([...EFFORT_TRIGGERS, ...EFFORT_LEVELS])
    .description(
      'Per-turn adaptive marker ("reflex", alias "auto"), or one pinned level. Omit to leave reasoningEffort to the caller.'
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

/** Schemastery schema for the System One backend connection block. */
const SystemOneSchema = z.object({
  baseUrl: z.string().description('Jev gateway or OpenAI-compatible logits endpoint; omit to use the environment.'),
  model: z.string().description('Model id the backend asks for; omit to use the environment default.'),
  apiKeyEnv: z
    .string()
    .description('Name of the environment variable holding the API key — never the key itself.'),
  timeoutMs: z.natural().description('Per-request timeout in milliseconds; omit for the backend default.')
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
  systemOne: SystemOneSchema.default({}),
  routing: RoutingSchema.default({}),
  effort: EffortSchema.default({}),
  tools: ToolsSchema.default({}),
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
 * @returns the resolved master mode, effective capability modes, and limits.
 * @throws Error when a field is present but unusable.
 */
export function resolveInterventionsConfig(authored: ReflexInterventionsConfig | undefined): ResolvedInterventionsConfig {
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
    [block.pruneTailChars, 'pruneTailChars', 400, 0]
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
    intent: optionalText(block.intent) ?? 'extract diagnostics, relevant results and errors'
  };
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
 * @param backend - the top-level backend selector.
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
  const baseUrl = optionalText(authored?.baseUrl);
  const model = optionalText(authored?.model);
  const apiKeyEnv = optionalText(authored?.apiKeyEnv);
  const timeoutMs = authored?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`systemOne.timeoutMs must be a positive integer (got "${String(timeoutMs)}")`);
  }
  return {
    backend: selected,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

/**
 * Read the API key a resolved connection block points at.
 *
 * The indirection is the point: the settings document carries the variable's
 * *name*, so a panel write can never leak the credential into a file the Host
 * then renders back to every client.
 * @param config - resolved System One connection settings.
 * @param env - environment to read; defaults to `process.env`.
 * @returns the key, or `undefined` when the variable is unset or empty.
 */
export function resolveApiKey(
  config: Pick<ResolvedSystemOneConfig, 'apiKeyEnv'>,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (config.apiKeyEnv === undefined) return undefined;
  const value = env[config.apiKeyEnv];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
 * Validate an authored config and fill in every default.
 * @param config - deployment config (already resolved by the loader, or raw).
 * @returns the fully-populated configuration.
 * @throws Error when the routing block names an unusable virtual provider or fallback.
 */
export function resolveConfig(config?: ReflexConfig): ResolvedReflexConfig {
  const unwrapped = plainConfig(config ?? {});
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
    interventions: resolveInterventionsConfig(validated.interventions)
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
 * Validate one authored `reasoningEffort` value.
 *
 * The loader already restricts it to the schema's union; this repeats the check
 * because {@link resolveConfig} is also the entry point for a programmatic
 * caller, and a typo there must fail loudly instead of silently disabling the
 * interceptor.
 *
 * @param value - authored setting.
 * @returns the normalized setting, or `undefined` when nothing was configured.
 * @throws Error when the value is neither a trigger marker nor a level.
 */
export function resolveEffortSetting(value: string | undefined): ReasoningEffortSetting | undefined {
  if (value === undefined) return undefined;
  const setting = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((EFFORT_TRIGGERS as readonly string[]).includes(setting) || (EFFORT_LEVELS as readonly string[]).includes(setting)) {
    return setting as ReasoningEffortSetting;
  }
  throw new Error(`effort.reasoningEffort must be one of ${[...EFFORT_TRIGGERS, ...EFFORT_LEVELS].join(', ')} (got "${String(value)}")`);
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
