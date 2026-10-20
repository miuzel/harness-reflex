import z from '@deepseek-ai/schemastery';

import { ADAPTIVE_EFFORT_LEVELS, EFFORT_LEVELS, EFFORT_TRIGGERS, type AdaptiveEffortLevel, type ReasoningEffortSetting } from './effort.js';
import { parseFallback, type ModelPoolEntry, type ModelPools, type PhysicalTarget } from './router.js';

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

/** Authored adaptive reasoning-effort configuration. */
export interface ReflexEffortConfig {
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
}

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
  effort: EffortSchema.default({})
});

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
      ...(setting === undefined ? {} : { setting }),
      fallback: effortFallback,
      minConfidence
    }
  };
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
