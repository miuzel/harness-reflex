/**
 * Pure view model of the Reflex settings page.
 *
 * Everything the page decides — how a Host section becomes an editable draft,
 * which path ops a draft produces, which numbers are shown, which tone a chip
 * takes — is a pure function of its inputs and lives here. The React layer in
 * `./view` only draws what this module returns, and the store in `./store` only
 * moves data in and out of it, so the page's behaviour is testable without a
 * DOM, a browser, or a Host.
 *
 * The level vocabularies below deliberately restate the Host's (`EFFORT_LEVELS`,
 * `ADAPTIVE_EFFORT_LEVELS`, `EFFORT_TRIGGERS`). A browser bundle may not
 * value-import another module across the client boundary, so the copy is checked
 * against the Host's own constants by `client-contract.test.ts` instead of being
 * shared — drift fails the build rather than the page.
 *
 * @module dsh-reflex/client/panel
 */

/** Effort levels a `reasoningEffort` may pin, mirroring the Host vocabulary. */
export const EFFORT_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];

/** Levels the adaptive controller may choose from, mirroring the Host vocabulary. */
export const ADAPTIVE_EFFORT_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high'];

/** `reasoningEffort` sentinels that ask for a per-turn decision, mirroring the Host. */
export const EFFORT_TRIGGERS: readonly string[] = ['reflex', 'auto'];

/** Effort policies the panel offers: leave untouched, adapt per turn, or pin a level. */
export const EFFORT_POLICIES: readonly string[] = ['', ...EFFORT_TRIGGERS, ...EFFORT_LEVELS];

/** Backend implementations the panel offers. */
export const BACKEND_CHOICES: readonly string[] = ['auto', 'mock', 'jev', 'vllm'];

/** Ledger entry types the Host records, in the order the panel lists them. */
export const LEDGER_TYPES: readonly string[] = [
  'gate',
  'prune',
  'stagnation',
  'route',
  'choice',
  'model-route',
  'effort-decision'
];

/** One settings path operation, as the client form API takes it. */
export type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] };

/** Editable draft of one virtual model's physical candidate pool. */
export interface PoolEntryDraft {
  provider: string;
  model: string;
  description: string;
  /** Comma-separated in the form; split into the authored array on save. */
  tags: string;
}

/** Editable draft of one virtual model. */
export interface PoolDraft {
  model: string;
  entries: PoolEntryDraft[];
}

/** Editable draft of the routing block. */
export interface RoutingDraft {
  enabled: boolean;
  virtualProvider: string;
  /** `provider:model`, or empty for "no fallback". */
  fallback: string;
  maxTaskChars: string;
  pools: PoolDraft[];
}

/** Editable draft of the effort block. */
export interface EffortDraft {
  /** Draft of `reasoningEffort`: '', a sentinel, or a pinned level. */
  setting: string;
  fallback: string;
  minConfidence: string;
  /** Draft of `enabled`: whether adaptive effort may decide anything. */
  enabled: boolean;
}

/**
 * The three-state intervention vocabulary.
 *
 * The browser bundle cannot value-import a Host module, so the client restates
 * these lists and `client-contract.test.ts` holds them equal to the Host's.
 */
export const INTERVENTION_MODES = ['off', 'observe', 'active'] as const;

/** Capability settings: the three states plus `inherit`. */
export const INTERVENTION_SETTINGS = ['off', 'observe', 'active', 'inherit'] as const;

/** The capabilities that may carry their own setting. */
export const INTERVENTION_CAPABILITIES = ['stagnation', 'prune', 'gate', 'closing'] as const;

/** One capability name in the panel vocabulary. */
export type PanelInterventionCapability = (typeof INTERVENTION_CAPABILITIES)[number];

/** The five tool suffixes this plugin registers, in registration order. Restated; see above. */
export const REFLEX_TOOL_SUFFIXES = ['choice', 'score', 'route', 'screen', 'gate'] as const;

/** One tool suffix in the panel vocabulary. */
export type PanelToolSuffix = (typeof REFLEX_TOOL_SUFFIXES)[number];

/**
 * Whether one suffix is registered when the deployment says nothing about it.
 *
 * Restated from the Host's own table (`REFLEX_TOOL_DEFAULT_ENABLED` in
 * `src/tools.ts`), because the page is a separate compilation unit: `route` is
 * the one capability the default activation leaves off. The page reads the live
 * value from the Host and uses this table only where a value is missing, so a
 * wrong entry here would show up as a wrong switch, not as a wrong write.
 */
export const TOOL_DEFAULT_ENABLED: Record<PanelToolSuffix, boolean> = {
  choice: true,
  score: true,
  route: false,
  screen: true,
  gate: true
};

/**
 * What the panel advises doing with one tool.
 *
 * - `expose`: the agent reaches for it in normal work, and the recommended set
 *   keeps it on;
 * - `optional`: it works, and the recommended set leaves it off until someone
 *   decides the deployment needs it.
 */
export type ToolAdvice = 'expose' | 'optional';

/**
 * The advice shown next to each suffix, and the basis of "apply the recommended
 * set". Advice is not configuration: it never writes anything, and it agrees
 * with the Host default — four suffixes on, `route` off.
 */
export const TOOL_ADVICE: Record<PanelToolSuffix, ToolAdvice> = {
  choice: 'expose',
  score: 'expose',
  route: 'optional',
  screen: 'expose',
  gate: 'expose'
};

/**
 * The switch each suffix takes when the recommended set is applied.
 *
 * Derived from {@link TOOL_ADVICE} rather than written out a second time, so the
 * button and the labels can never disagree about what is recommended. The result
 * is the documented default: `choice`, `score`, `screen`, and `gate` on,
 * `route` off.
 * @returns suffix → enabled.
 */
export function recommendedToolSwitches(): Record<string, boolean> {
  return Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, TOOL_ADVICE[suffix] === 'expose']));
}

/** Editable draft of the automatic-intervention block. */
export interface InterventionsDraft {
  /** Master mode; `inherit` is not legal here. */
  mode: string;
  /** Capability → setting, `inherit` included. */
  capabilities: Record<string, string>;
  maxInterventionsPerTurn: string;
  maxJudgmentsPerTurn: string;
  maxJudgmentsPerSession: string;
  repeatThreshold: string;
  failureThreshold: string;
  minConfidence: string;
  windowSize: string;
  pruneFloorRatio: string;
  pruneHeadChars: string;
  pruneTailChars: string;
  intent: string;
}

/**
 * Editable draft of the per-tool switches.
 *
 * Keyed by suffix, never by registered name: a deployment that renames
 * `toolPrefix` must not have to rewrite its switches.
 */
export interface ToolsDraft {
  /** Suffix → enabled. Every suffix is present; see {@link TOOL_DEFAULT_ENABLED}. */
  enabled: Record<string, boolean>;
}

/** Editable draft of the System One connection block. */
export interface BackendDraft {
  backend: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: string;
}

/** Editable draft of the runtime-level fields. */
export interface RuntimeDraft {
  toolPrefix: string;
  ledgerPath: string;
  pruneThreshold: string;
  calibrationPath: string;
}

/** The whole editable draft. */
export interface PanelDraft {
  routing: RoutingDraft;
  effort: EffortDraft;
  backend: BackendDraft;
  runtime: RuntimeDraft;
  interventions: InterventionsDraft;
  tools: ToolsDraft;
}

/** Group names, in the order the page presents them. */
export const DRAFT_GROUPS: readonly (keyof PanelDraft)[] = [
  'routing',
  'effort',
  'backend',
  'runtime',
  'interventions',
  'tools'
];

/** Every tool suffix at its documented default, which is what an omitted block means. */
function defaultToolSwitches(): Record<string, boolean> {
  return Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, TOOL_DEFAULT_ENABLED[suffix]]));
}

/** Every capability inheriting the master mode, which is the documented default. */
function allCapabilitiesInherit(): Record<string, string> {
  return Object.fromEntries(INTERVENTION_CAPABILITIES.map((capability) => [capability, 'inherit']));
}

/** An empty draft: the Host defaults, with every text field blank rather than `undefined`. */
export const EMPTY_DRAFT: PanelDraft = {
  routing: { enabled: true, virtualProvider: 'reflex', fallback: '', maxTaskChars: '400', pools: [] },
  effort: { setting: '', fallback: 'low', minConfidence: '0.3', enabled: true },
  backend: { backend: 'auto', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: '' },
  runtime: { toolPrefix: 'reflex_', ledgerPath: '', pruneThreshold: '500', calibrationPath: '' },
  interventions: {
    mode: 'observe',
    capabilities: allCapabilitiesInherit(),
    maxInterventionsPerTurn: '3',
    maxJudgmentsPerTurn: '3',
    maxJudgmentsPerSession: '20',
    repeatThreshold: '3',
    failureThreshold: '3',
    minConfidence: '0.6',
    windowSize: '6',
    pruneFloorRatio: '0.5',
    pruneHeadChars: '400',
    pruneTailChars: '400',
    intent: ''
  },
  tools: { enabled: defaultToolSwitches() }
};

/** Read a plain object field. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read a field as text, mapping a missing or non-scalar value to `''`. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Read a field as a finite number, or `undefined`. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Read a field as a boolean with a default. */
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Split authored tags into the form's comma-separated text. */
function tagsToText(value: unknown): string {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string').join(', ') : '';
}

/** Split the form's comma-separated text into authored tags. */
export function textToTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Read the authored pools of a routing section. */
function poolsFromRouting(routing: Record<string, unknown>): PoolDraft[] {
  const models = asRecord(routing.models);
  return Object.keys(models).map((model) => {
    const entries = Array.isArray(models[model]) ? (models[model] as unknown[]) : [];
    return {
      model,
      entries: entries.map((entry) => {
        const record = asRecord(entry);
        return {
          provider: asText(record.provider),
          model: asText(record.model),
          description: asText(record.description),
          tags: tagsToText(record.tags)
        };
      })
    };
  });
}

/**
 * Seed an editable draft from a live runtime snapshot when form values are empty.
 */
export function draftFromSnapshot(snapshot: PanelSnapshotLike | null, base: PanelDraft): PanelDraft {
  if (!snapshot) return base;
  const draft = { ...base };
  if (base.routing.pools.length === 0 && snapshot.routing?.pools && snapshot.routing.pools.length > 0) {
    const pools: PoolDraft[] = snapshot.routing.pools.map((p) => ({
      model: asText(p.model),
      entries: Array.isArray(p.entries)
        ? (p.entries as unknown[]).map((e) => {
            const rec = asRecord(e);
            return {
              provider: asText(rec.provider),
              model: asText(rec.model),
              description: asText(rec.description),
              tags: tagsToText(rec.tags)
            };
          })
        : []
    }));
    draft.routing = {
      ...draft.routing,
      enabled: snapshot.routing.enabled ?? draft.routing.enabled,
      virtualProvider: snapshot.routing.virtualProvider || draft.routing.virtualProvider,
      fallback: snapshot.routing.fallback || draft.routing.fallback,
      ...(snapshot.routing.maxTaskChars !== undefined ? { maxTaskChars: String(snapshot.routing.maxTaskChars) } : {}),
      pools
    };
  }
  if (!draft.effort.setting && snapshot.effort?.setting) {
    draft.effort = {
      ...draft.effort,
      setting: snapshot.effort.setting,
      fallback: snapshot.effort.fallback || draft.effort.fallback,
      minConfidence: snapshot.effort.minConfidence !== undefined ? String(snapshot.effort.minConfidence) : draft.effort.minConfidence
    };
  }
  return draft;
}

/**
 * Seed an editable draft from a Host-resolved configuration section.
 *
 * Tolerant by construction: an absent, partial, or unexpected section yields the
 * documented defaults, because a panel that throws on a half-written settings
 * document would be unusable exactly when it is needed.
 * @param value - the resolved section a `ConfigForm` snapshot carries.
 * @returns the draft to edit.
 */
export function draftFromConfig(value: unknown): PanelDraft {
  const section = asRecord(value);
  const routing = asRecord(section.routing);
  const effort = asRecord(section.effort);
  const systemOne = asRecord(section.systemOne);
  const interventions = asRecord(section.interventions);
  const authoredCapabilities = asRecord(interventions.capabilities);
  const tools = asRecord(section.tools);
  const authoredTools = asRecord(tools.enabled);
  return {
    routing: {
      enabled: asBoolean(routing.enabled, EMPTY_DRAFT.routing.enabled),
      virtualProvider: asText(routing.virtualProvider) || EMPTY_DRAFT.routing.virtualProvider,
      // The *authored* block spells the fallback as one `provider:model` string;
      // only the resolved configuration splits it into a target object.
      fallback: asText(routing.fallback),
      maxTaskChars: asText(routing.maxTaskChars) || EMPTY_DRAFT.routing.maxTaskChars,
      pools: poolsFromRouting(routing)
    },
    effort: {
      setting: asText(effort.reasoningEffort),
      fallback: asText(effort.fallback) || EMPTY_DRAFT.effort.fallback,
      minConfidence: asText(effort.minConfidence) || EMPTY_DRAFT.effort.minConfidence,
      enabled: asBoolean(effort.enabled, EMPTY_DRAFT.effort.enabled)
    },
    backend: {
      backend: asText(section.backend) || EMPTY_DRAFT.backend.backend,
      baseUrl: asText(systemOne.baseUrl),
      model: asText(systemOne.model),
      apiKeyEnv: asText(systemOne.apiKeyEnv),
      timeoutMs: asText(systemOne.timeoutMs)
    },
    runtime: {
      toolPrefix: asText(section.toolPrefix) || EMPTY_DRAFT.runtime.toolPrefix,
      ledgerPath: asText(section.ledgerPath),
      pruneThreshold: asText(section.pruneThreshold) || EMPTY_DRAFT.runtime.pruneThreshold,
      calibrationPath: asText(section.calibrationPath)
    },
    // Every field of the section is carried, including the three the switch page
    // does not feature prominently: a group write replaces the whole section, so
    // a field left out of the draft would be deleted by an unrelated edit.
    interventions: {
      mode: asText(interventions.mode) || EMPTY_DRAFT.interventions.mode,
      capabilities: Object.fromEntries(
        INTERVENTION_CAPABILITIES.map((capability) => [
          capability,
          asText(authoredCapabilities[capability]) || 'inherit'
        ])
      ),
      maxInterventionsPerTurn: asText(interventions.maxInterventionsPerTurn) || EMPTY_DRAFT.interventions.maxInterventionsPerTurn,
      maxJudgmentsPerTurn: asText(interventions.maxJudgmentsPerTurn) || EMPTY_DRAFT.interventions.maxJudgmentsPerTurn,
      maxJudgmentsPerSession: asText(interventions.maxJudgmentsPerSession) || EMPTY_DRAFT.interventions.maxJudgmentsPerSession,
      repeatThreshold: asText(interventions.repeatThreshold) || EMPTY_DRAFT.interventions.repeatThreshold,
      failureThreshold: asText(interventions.failureThreshold) || EMPTY_DRAFT.interventions.failureThreshold,
      minConfidence: asText(interventions.minConfidence) || EMPTY_DRAFT.interventions.minConfidence,
      windowSize: asText(interventions.windowSize) || EMPTY_DRAFT.interventions.windowSize,
      pruneFloorRatio: asText(interventions.pruneFloorRatio) || EMPTY_DRAFT.interventions.pruneFloorRatio,
      pruneHeadChars: asText(interventions.pruneHeadChars) || EMPTY_DRAFT.interventions.pruneHeadChars,
      pruneTailChars: asText(interventions.pruneTailChars) || EMPTY_DRAFT.interventions.pruneTailChars,
      intent: asText(interventions.intent)
    },
    tools: {
      enabled: Object.fromEntries(
        REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, asBoolean(authoredTools[suffix], TOOL_DEFAULT_ENABLED[suffix])])
      )
    }
  };
}

/** Split a `provider:model` target into its two halves. */
export function splitTarget(text: string): { provider: string; model: string } | undefined {
  const trimmed = text.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
}

/** Validation outcome of one draft. */
export interface DraftValidation {
  /** Copy keys of the problems found, in presentation order. */
  errors: string[];
  /** Whether the draft can be written. */
  ok: boolean;
}

/**
 * Validate a draft before it reaches the Host.
 *
 * The Host validates too, but a refused write is a poor way to learn that a
 * number field holds text, so the page reports the same problems first.
 * @param draft - the draft to check.
 * @returns the copy keys of every problem, and whether any was found.
 */
export function validateDraft(draft: PanelDraft): DraftValidation {
  const errors: string[] = [];
  if (draft.routing.virtualProvider.trim().length === 0) errors.push('errVirtualProvider');
  if (draft.routing.fallback.trim().length > 0 && splitTarget(draft.routing.fallback) === undefined) {
    errors.push('errFallback');
  }
  const maxTaskChars = asNumber(draft.routing.maxTaskChars);
  if (maxTaskChars === undefined || !Number.isInteger(maxTaskChars) || maxTaskChars <= 0) errors.push('errMaxTaskChars');

  const modelIds = draft.routing.pools.map((pool) => pool.model.trim());
  for (const modelId of modelIds) {
    if (modelId.length === 0) errors.push('errPoolModel');
  }
  if (new Set(modelIds.filter((modelId) => modelId.length > 0)).size !== modelIds.filter((modelId) => modelId.length > 0).length) {
    errors.push('errPoolDuplicate');
  }
  for (const pool of draft.routing.pools) {
    for (const entry of pool.entries) {
      if (entry.provider.trim().length === 0) errors.push('errPoolProvider');
      if (entry.model.trim().length === 0) errors.push('errPoolModelName');
    }
  }
  if (draft.routing.enabled && !draft.routing.pools.some((pool) => pool.entries.length > 0)) errors.push('errPoolEmpty');

  if (!EFFORT_POLICIES.includes(draft.effort.setting)) errors.push('errEffortSetting');
  if (!ADAPTIVE_EFFORT_LEVELS.includes(draft.effort.fallback)) errors.push('errFallback');
  const minConfidence = asNumber(draft.effort.minConfidence);
  if (minConfidence === undefined || minConfidence < 0 || minConfidence > 1) errors.push('errMinConfidence');

  if (!BACKEND_CHOICES.includes(draft.backend.backend)) errors.push('errBackend');
  const timeoutMs = draft.backend.timeoutMs.trim() === '' ? undefined : asNumber(draft.backend.timeoutMs);
  if (draft.backend.timeoutMs.trim() !== '' && (timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs < 100)) {
    errors.push('errTimeout');
  }
  if (draft.runtime.toolPrefix.trim().length === 0) errors.push('errToolPrefix');
  const pruneThreshold = asNumber(draft.runtime.pruneThreshold);
  if (pruneThreshold === undefined || !Number.isInteger(pruneThreshold) || pruneThreshold < 0) {
    errors.push('errPruneThreshold');
  }

  // The intervention page repeats the Host's own rules so a refused write is not
  // how the user learns that a budget field holds text.
  if (!INTERVENTION_MODES.includes(draft.interventions.mode as (typeof INTERVENTION_MODES)[number])) {
    errors.push('errInterventionMode');
  }
  for (const capability of INTERVENTION_CAPABILITIES) {
    if (!INTERVENTION_SETTINGS.includes(draft.interventions.capabilities[capability] as (typeof INTERVENTION_SETTINGS)[number])) {
      errors.push('errInterventionCapability');
    }
  }
  const budgets: Array<[string, number]> = [
    [draft.interventions.maxInterventionsPerTurn, 0],
    [draft.interventions.maxJudgmentsPerTurn, 0],
    [draft.interventions.maxJudgmentsPerSession, 0],
    [draft.interventions.repeatThreshold, 2],
    [draft.interventions.failureThreshold, 2],
    [draft.interventions.windowSize, 3],
    [draft.interventions.pruneHeadChars, 0],
    [draft.interventions.pruneTailChars, 0]
  ];
  for (const [text, minimum] of budgets) {
    const parsed = asNumber(text);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < minimum) errors.push('errInterventionBudget');
  }
  for (const text of [draft.interventions.minConfidence, draft.interventions.pruneFloorRatio]) {
    const parsed = asNumber(text);
    if (parsed === undefined || parsed < 0 || parsed > 1) errors.push('errInterventionRatio');
  }
  return { errors: [...new Set(errors)], ok: errors.length === 0 };
}

/** One Host schema path a draft group authors, and the value it writes there. */
export interface GroupWrite {
  /** Absolute schema path, e.g. `['systemOne']` or `['pruneThreshold']`. */
  path: string[];
  /** The value to write; omitted means "unset this path". */
  value?: unknown;
}

/**
 * Convert a draft group into the Host schema paths it authors.
 *
 * A group is a *view* concept; the Host addresses configuration by schema path,
 * and two of the six groups are not one path: `backend` is the scalar union that
 * sits next to the `systemOne` block, and `runtime` is four separate top-level
 * fields. Addressing the Host by group name is refused — every field of the
 * System 1 backend page failed with either `Config field "runtime" is not
 * volatile` (the runtime group) or `$.backend expected "auto" | "mock" | "jev" |
 * "vllm" but got {"backend":...}` (the backend group) — so a group is always
 * expanded to real schema paths here.
 *
 * Absent-means-default is expressed by *omission*: a blank text field yields no
 * key, so the field keeps whatever the composition layer below says instead of
 * being pinned to an empty string. A path with no value at all is written as an
 * `unset` op, which says the same thing for a top-level field.
 * @param draft - the draft to convert.
 * @param group - which group to convert.
 * @returns one entry per Host schema path the group authors, in schema order.
 */
export function groupWrites(draft: PanelDraft, group: keyof PanelDraft): GroupWrite[] {
  const present = (text: string): string | undefined => {
    const trimmed = text.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };
  switch (group) {
    case 'routing': {
      const models: Record<string, unknown[]> = {};
      for (const pool of draft.routing.pools) {
        const modelId = pool.model.trim();
        if (modelId.length === 0) continue;
        models[modelId] = pool.entries.map((entry) => ({
          provider: entry.provider.trim(),
          model: entry.model.trim(),
          ...(present(entry.description) === undefined ? {} : { description: entry.description.trim() }),
          ...(textToTags(entry.tags).length === 0 ? {} : { tags: textToTags(entry.tags) })
        }));
      }
      const fallback = present(draft.routing.fallback);
      return [
        {
          path: [group],
          value: {
            enabled: draft.routing.enabled,
            ...(present(draft.routing.virtualProvider) === undefined ? {} : { virtualProvider: draft.routing.virtualProvider.trim() }),
            ...(fallback === undefined ? {} : { fallback }),
            ...(asNumber(draft.routing.maxTaskChars) === undefined ? {} : { maxTaskChars: asNumber(draft.routing.maxTaskChars) }),
            models
          }
        }
      ];
    }
    case 'effort':
      return [
        {
          path: [group],
          value: {
            enabled: draft.effort.enabled,
            ...(present(draft.effort.setting) === undefined ? {} : { reasoningEffort: draft.effort.setting.trim() }),
            ...(present(draft.effort.fallback) === undefined ? {} : { fallback: draft.effort.fallback.trim() }),
            ...(asNumber(draft.effort.minConfidence) === undefined ? {} : { minConfidence: asNumber(draft.effort.minConfidence) })
          }
        }
      ];
    case 'backend':
      // One page, two Host paths: the scalar backend choice and its own block.
      return [
        { path: ['backend'], value: present(draft.backend.backend) ?? 'auto' },
        {
          path: ['systemOne'],
          value: {
            ...(present(draft.backend.baseUrl) === undefined ? {} : { baseUrl: draft.backend.baseUrl.trim() }),
            ...(present(draft.backend.model) === undefined ? {} : { model: draft.backend.model.trim() }),
            ...(present(draft.backend.apiKeyEnv) === undefined ? {} : { apiKeyEnv: draft.backend.apiKeyEnv.trim() }),
            ...(asNumber(draft.backend.timeoutMs) === undefined ? {} : { timeoutMs: asNumber(draft.backend.timeoutMs) })
          }
        }
      ];
    case 'interventions': {
      // Only the capability settings that were authored are written, so an
      // inherited capability stays inherited instead of being frozen to the
      // master mode it happens to resolve to today.
      const capabilities: Record<string, string> = {};
      for (const capability of INTERVENTION_CAPABILITIES) {
        const setting = present(draft.interventions.capabilities[capability] ?? '');
        // `inherit` *is* the omission: writing it explicitly would record a
        // choice the user never made, and the Host derives it from the mode.
        if (setting === undefined || setting === 'inherit') continue;
        capabilities[capability] = setting;
      }
      const count = (text: string): number | undefined => {
        const parsed = asNumber(text);
        return parsed === undefined ? undefined : parsed;
      };
      const section = {
        ...(present(draft.interventions.mode) === undefined ? {} : { mode: draft.interventions.mode.trim() }),
        ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
        ...(count(draft.interventions.maxInterventionsPerTurn) === undefined
          ? {}
          : { maxInterventionsPerTurn: count(draft.interventions.maxInterventionsPerTurn) }),
        ...(count(draft.interventions.maxJudgmentsPerTurn) === undefined
          ? {}
          : { maxJudgmentsPerTurn: count(draft.interventions.maxJudgmentsPerTurn) }),
        ...(count(draft.interventions.maxJudgmentsPerSession) === undefined
          ? {}
          : { maxJudgmentsPerSession: count(draft.interventions.maxJudgmentsPerSession) }),
        ...(count(draft.interventions.repeatThreshold) === undefined
          ? {}
          : { repeatThreshold: count(draft.interventions.repeatThreshold) }),
        ...(count(draft.interventions.failureThreshold) === undefined
          ? {}
          : { failureThreshold: count(draft.interventions.failureThreshold) }),
        ...(count(draft.interventions.minConfidence) === undefined
          ? {}
          : { minConfidence: count(draft.interventions.minConfidence) }),
        ...(count(draft.interventions.windowSize) === undefined ? {} : { windowSize: count(draft.interventions.windowSize) }),
        ...(count(draft.interventions.pruneFloorRatio) === undefined
          ? {}
          : { pruneFloorRatio: count(draft.interventions.pruneFloorRatio) }),
        ...(count(draft.interventions.pruneHeadChars) === undefined
          ? {}
          : { pruneHeadChars: count(draft.interventions.pruneHeadChars) }),
        ...(count(draft.interventions.pruneTailChars) === undefined
          ? {}
          : { pruneTailChars: count(draft.interventions.pruneTailChars) }),
        ...(present(draft.interventions.intent) === undefined ? {} : { intent: draft.interventions.intent.trim() })
      };
      return [{ path: [group], value: section }];
    }
    case 'tools': {
      // Only departures from the documented default are authored, in either
      // direction: `route` starts off, so switching it on stores `true`, while
      // the other four start on and switching one off stores `false`. Returning
      // a switch to its default therefore *removes* its key, which is what "back
      // to default" means here — and what keeps a later change of the default
      // effective.
      const enabled: Record<string, boolean> = {};
      for (const suffix of REFLEX_TOOL_SUFFIXES) {
        const value = draft.tools.enabled[suffix] ?? TOOL_DEFAULT_ENABLED[suffix];
        if (value !== TOOL_DEFAULT_ENABLED[suffix]) enabled[suffix] = value;
      }
      return [{ path: [group], value: { enabled } }];
    }
    case 'runtime':
    default:
      // The runtime group is four top-level fields in the Host schema, not a
      // `runtime` block: writing `['runtime']` is refused as "not volatile".
      return [
        { path: ['toolPrefix'], value: present(draft.runtime.toolPrefix) ?? 'reflex_' },
        present(draft.runtime.ledgerPath) === undefined
          ? { path: ['ledgerPath'] }
          : { path: ['ledgerPath'], value: draft.runtime.ledgerPath.trim() },
        { path: ['pruneThreshold'], value: asNumber(draft.runtime.pruneThreshold) ?? 500 },
        present(draft.runtime.calibrationPath) === undefined
          ? { path: ['calibrationPath'] }
          : { path: ['calibrationPath'], value: draft.runtime.calibrationPath.trim() }
      ];
  }
}

/** Whether two JSON-shaped values are equal, ignoring key order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

/**
 * Diff two drafts into the path operations that turn the first into the second.
 *
 * Group granularity is deliberate: a group is dirty or it is not, and a dirty
 * group is written in full to every schema path it authors, so one edit can
 * never leave a half-written block behind and a blanked field simply stops being
 * present in the value it sends. Every path emitted here is a path the Host
 * declares volatile — `client-page.test.ts` checks that against the plugin's own
 * schema, because addressing a group name the schema does not have (`runtime`)
 * makes the Host refuse the whole write.
 * @param original - the draft seeded from the Host.
 * @param draft - the edited draft.
 * @returns the ops to send, empty when nothing changed.
 */
export function diffDraft(original: PanelDraft, draft: PanelDraft): SettingsOp[] {
  const ops: SettingsOp[] = [];
  for (const group of DRAFT_GROUPS) {
    const before = groupWrites(original, group);
    const after = groupWrites(draft, group);
    if (sameValue(before, after)) continue;
    for (const write of after) {
      ops.push(write.value === undefined ? { op: 'unset', path: write.path } : { op: 'set', path: write.path, value: write.value });
    }
  }
  return ops;
}

/** Which groups of a draft differ from the seeded original. */
export function dirtyGroups(original: PanelDraft, draft: PanelDraft): (keyof PanelDraft)[] {
  return DRAFT_GROUPS.filter((group) => !sameValue(groupWrites(original, group), groupWrites(draft, group)));
}

/** Append an empty virtual model to a draft. */
export function addPool(pools: PoolDraft[], modelId = ''): PoolDraft[] {
  return [...pools, { model: modelId, entries: [] }];
}

/** Remove one virtual model from a draft. */
export function removePool(pools: PoolDraft[], index: number): PoolDraft[] {
  return pools.filter((_, position) => position !== index);
}

/** Append an empty candidate to one virtual model. */
export function addPoolEntry(pools: PoolDraft[], index: number): PoolDraft[] {
  return pools.map((pool, position) =>
    position === index ? { ...pool, entries: [...pool.entries, { provider: '', model: '', description: '', tags: '' }] } : pool
  );
}

/** Remove one candidate from one virtual model. */
export function removePoolEntry(pools: PoolDraft[], index: number, entry: number): PoolDraft[] {
  return pools.map((pool, position) =>
    position === index ? { ...pool, entries: pool.entries.filter((_, at) => at !== entry) } : pool
  );
}

/**
 * Move one candidate within its pool, which is the pool's routing preference.
 * @param pools - the pools to edit.
 * @param index - pool position.
 * @param entry - candidate position.
 * @param delta - `-1` to promote, `1` to demote.
 * @returns the next pools; the ends are no-ops.
 */
export function movePoolEntry(pools: PoolDraft[], index: number, entry: number, delta: number): PoolDraft[] {
  const target = entry + delta;
  const pool = pools[index];
  if (pool === undefined || target < 0 || target >= pool.entries.length) return pools;
  const entries = [...pool.entries];
  const [moved] = entries.splice(entry, 1);
  if (moved === undefined) return pools;
  entries.splice(target, 0, moved);
  return pools.map((candidate, position) => (position === index ? { ...candidate, entries } : candidate));
}

/** Format an integer with thousands separators, without depending on ICU data. */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits[index] as string;
  }
  return sign + grouped;
}

/** Format a millisecond latency for a metric card. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

/** Format an estimated cost, keeping small numbers readable. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** Format a 0–1 ratio as a percentage. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

/** Format one ledger timestamp as local `HH:MM:SS`. */
export function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Copy key of one ledger type's display name. */
export function ledgerTypeKey(type: string): string {
  switch (type) {
    case 'gate':
      return 'typeGate';
    case 'prune':
      return 'typePrune';
    case 'stagnation':
      return 'typeStagnation';
    case 'route':
      return 'typeRoute';
    case 'choice':
      return 'typeChoice';
    case 'model-route':
      return 'typeModelRoute';
    case 'effort-decision':
      return 'typeEffort';
    default:
      return type;
  }
}

/** Design-token name a decision level is drawn in. */
export function levelTone(level: string): string {
  switch (level) {
    case 'off':
      return '--dsw-alias-label-tertiary';
    case 'minimal':
    case 'low':
      return '--dsw-alias-state-success-primary';
    case 'medium':
      return '--dsw-alias-brand-primary';
    case 'high':
      return '--dsw-alias-state-warn-primary';
    case 'max':
      return '--dsw-alias-state-error-primary';
    default:
      return '--dsw-alias-label-secondary';
  }
}

/** One badge the header shows. */
export interface PanelChip {
  id: string;
  /** Copy key, or a literal value that has no translation (a provider name, a level). */
  text: string;
  /** `true` when {@link text} is a copy key rather than literal text. */
  translated: boolean;
  tone: string;
  title?: string;
}

/** Live snapshot as the panel consumes it; a loose shape by design. */
export interface PanelSnapshotLike {
  ok?: boolean;
  at?: number;
  plugin?: { name?: string; version?: string; toolPrefix?: string; pruneThreshold?: number; ledgerPath?: string; calibrationPath?: string };
  routing?: {
    enabled?: boolean;
    active?: boolean;
    virtualProvider?: string;
    fallback?: string;
    maxTaskChars?: number;
    candidates?: number;
    pools?: { model?: string; entries?: unknown[] }[];
  };
  effort?: {
    setting?: string | null;
    fallback?: string;
    minConfidence?: number;
    /** Whether adaptive effort may decide anything. */
    enabled?: boolean;
    decisions?: number;
    latest?: {
      level?: string;
      applied?: string | null;
      outcome?: string;
      trigger?: string;
      source?: string;
      confidence?: number;
      latencyMs?: number;
      provider?: string;
      model?: string;
      line?: string;
      at?: number;
      agentId?: string;
      role?: string;
      turn?: number;
      step?: number;
      basis?: string[];
      degradedReason?: string;
    } | null;
  };
  systemOne?: {
    backend?: string;
    active?: string;
    baseUrl?: string;
    model?: string;
    apiKeyEnv?: string;
    apiKeyPresent?: boolean;
    timeoutMs?: number;
  };
  /** Effective automatic-intervention state, as the runtime resolved it. */
  interventions?: {
    mode?: string;
    /** Whether any capability acts at all. */
    enabled?: boolean;
    /** Whether any capability resolves to `active` rather than merely observing. */
    acting?: boolean;
    /** Capability → effective mode, with inheritance already resolved. */
    capabilities?: Record<string, string>;
  };
  /** Effective tool registration, as the runtime surface reports it. */
  tools?: {
    /** Registered tool names, in registration order. */
    active?: string[];
    /** Suffix → authored switch; every suffix is answered. */
    enabled?: Record<string, boolean>;
  };
  ledger?: {
    summary?: {
      totalCalls?: number;
      callsByType?: Record<string, number>;
      totalTokensSaved?: number;
      avgLatencyMs?: number;
      estimatedCostSavedUsd?: number;
      stagnationAlerts?: number;
      gatePassedCount?: number;
      gateFailedCount?: number;
    };
    recent?: {
      id?: string;
      at?: string;
      type?: string;
      backend?: string;
      latencyMs?: number;
      tokensSaved?: number;
      passed?: boolean;
      isStuck?: boolean;
      shadow?: boolean;
      skipReason?: string;
      action?: string;
      target?: string;
      level?: string;
      applied?: string | null;
      reason?: string;
    }[];
    logPath?: string | null;
    clearable?: boolean;
  };
  modelCatalog?: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }>;
}

/** Badges describing one snapshot. */
export function panelChips(snapshot: PanelSnapshotLike | null): PanelChip[] {
  if (snapshot === null) return [];
  const chips: PanelChip[] = [];
  const routing = snapshot.routing ?? {};
  chips.push({
    id: 'routing',
    text: routing.active === true ? 'toneActive' : 'toneInactive',
    translated: true,
    tone: routing.active === true ? '--dsw-alias-state-success-primary' : '--dsw-alias-label-tertiary',
    title: `${String(routing.virtualProvider ?? '')} · ${formatInteger(routing.candidates ?? 0)}`
  });
  const setting = snapshot.effort?.setting;
  chips.push({
    id: 'effort',
    text: setting === null || setting === undefined || setting === '' ? 'unset' : setting,
    translated: setting === null || setting === undefined || setting === '',
    tone: setting === null || setting === undefined || setting === '' ? '--dsw-alias-label-tertiary' : levelTone(setting)
  });
  const backend = snapshot.systemOne;
  chips.push({
    id: 'backend',
    text: String(backend?.active ?? backend?.backend ?? ''),
    translated: false,
    tone: '--dsw-alias-label-secondary',
    title: backend?.apiKeyEnv === undefined ? undefined : `${backend.apiKeyEnv}: ${backend.apiKeyPresent === true ? 'set' : 'empty'}`
  });
  return chips;
}

/** A ledger row rendered for the table. */
export interface LedgerRowView {
  id: string;
  clock: string;
  type: string;
  typeKey: string;
  backend: string;
  latency: string;
  tokens: string;
  /** One line summarising the entry: its action, target, level, or skip reason. */
  detail: string;
  tone: string;
}

/**
 * Project ledger rows for the table.
 * @param snapshot - the live snapshot.
 * @returns rows, newest last, exactly as the Host ordered them.
 */
export function ledgerRows(snapshot: PanelSnapshotLike | null): LedgerRowView[] {
  const recent = snapshot?.ledger?.recent ?? [];
  return recent.map((entry) => {
    const type = String(entry.type ?? '');
    const parts: string[] = [];
    if (entry.action !== undefined) parts.push(entry.action);
    if (entry.target !== undefined) parts.push(entry.target);
    if (entry.level !== undefined) parts.push(entry.applied === null ? `${entry.level} → cleared` : entry.level);
    if (entry.passed !== undefined) parts.push(entry.passed ? 'pass' : 'fail');
    if (entry.isStuck === true) parts.push('stuck');
    if (entry.shadow === true) parts.push('shadow');
    if (entry.skipReason !== undefined) parts.push(entry.skipReason);
    if (entry.reason !== undefined) parts.push(entry.reason);
    return {
      id: String(entry.id ?? ''),
      clock: formatClock(String(entry.at ?? '')),
      type,
      typeKey: ledgerTypeKey(type),
      backend: String(entry.backend ?? ''),
      latency: formatLatency(entry.latencyMs ?? 0),
      tokens: formatInteger(entry.tokensSaved ?? 0),
      detail: parts.join(' · '),
      tone: entry.level === undefined ? '--dsw-alias-label-secondary' : levelTone(entry.level)
    };
  });
}

/** One metric card. */
export interface MetricView {
  id: string;
  labelKey: string;
  value: string;
  hintKey?: string;
}

/**
 * Metrics the overview tab shows.
 * @param snapshot - the live snapshot.
 * @returns the cards, in presentation order.
 */
export function overviewMetrics(snapshot: PanelSnapshotLike | null): MetricView[] {
  const summary = snapshot?.ledger?.summary ?? {};
  const routingCalls = (summary.callsByType ?? {})['model-route'] ?? 0;
  return [
    { id: 'total', labelKey: 'ledgerTotal', value: formatInteger(summary.totalCalls ?? 0) },
    { id: 'tokens', labelKey: 'ledgerTokens', value: formatInteger(summary.totalTokensSaved ?? 0) },
    { id: 'cost', labelKey: 'ledgerCost', value: formatUsd(summary.estimatedCostSavedUsd ?? 0) },
    { id: 'latency', labelKey: 'ledgerLatency', value: formatLatency(summary.avgLatencyMs ?? 0) },
    {
      id: 'gates',
      labelKey: 'ledgerGates',
      value: `${formatInteger(summary.gatePassedCount ?? 0)} / ${formatInteger(summary.gateFailedCount ?? 0)}`
    },
    { id: 'stagnation', labelKey: 'ledgerStagnation', value: formatInteger(summary.stagnationAlerts ?? 0) },
    { id: 'routing', labelKey: 'ledgerRouting', value: formatInteger(routingCalls) },
    { id: 'effort', labelKey: 'effortDecisions', value: formatInteger(snapshot?.effort?.decisions ?? 0) }
  ];
}

/**
 * Pick the settings namespace this panel edits.
 *
 * The Host chooses its own namespace (a deployment may nest or rename it), so
 * candidates are matched by exact name first and then by suffix, and `undefined`
 * is returned rather than a guess when nothing matches.
 * @param namespaces - every namespace the Host serves.
 * @param candidates - preferred names, most specific first.
 * @returns the resolved namespace, or `undefined`.
 */
export function resolveReflexNamespace(namespaces: readonly string[], candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (namespaces.includes(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const suffix = `.${candidate}`;
    const match = namespaces.find((ns) => ns.endsWith(suffix));
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * Substitute `{name}` placeholders in a copy string.
 * @param template - the copy string.
 * @param values - placeholder values.
 * @returns the rendered string.
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
