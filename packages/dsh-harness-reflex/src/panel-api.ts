/**
 * Read-only HTTP surface behind the Reflex settings panel.
 *
 * The browser half of this plugin (`./client`) renders the settings page, but a
 * client bundle may not value-import another plugin and the plugin's own live
 * facts — decision throughput, saved tokens, the last adaptive decision — only
 * exist in the Host process. The two halves therefore meet on the one channel a
 * third-party plugin can own without a generated Remote namespace: a small,
 * explicitly projected JSON route family served by `ctx.webServer`.
 *
 * Design rules this module keeps:
 *
 * - **Explicit projection.** Every payload field is projected from the runtime
 *   by hand. `LedgerEntry.details` is an open record written by several code
 *   paths, so it is narrowed to five known scalar fields instead of serialized
 *   whole — the panel shows what it declares, and nothing else rides the wire.
 * - **Secrets stay home.** The connection block carries the *name* of the API
 *   key's environment variable; the key's value is never read here, so no
 *   response can leak it.
 * - **Loopback by default.** The route family answers the local GUI only, plus
 *   whatever the optional `remoteWebUiPairing` service recognises as a paired
 *   device, so a LAN-exposed Host does not publish its ledger to strangers.
 *
 * @module dsh-reflex/panel-api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DecisionLedger, LedgerEntry } from './vendor/harness-reflex/index.js';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';

import { connectionTarget, type ResolvedReflexConfig } from './config.js';
import { INTERVENTION_CAPABILITIES } from './config.js';
import type { ReflexEffortStatus } from './effort.js';
import type { DelegationHealthState } from './delegation-health.js';

/** Version reported by the panel; kept in step with `package.json` by a test. */
export const REFLEX_PLUGIN_VERSION = '0.3.0';

/** Namespace every panel route lives under. */
export const PANEL_BASE = '/dsh-reflex/api';

/** The route family, as the panel's phases address it. */
export const PANEL_ROUTES = {
  snapshot: `${PANEL_BASE}/panel`,
  health: `${PANEL_BASE}/health`,
  clearLedger: `${PANEL_BASE}/ledger/clear`,
  /**
   * Writes the host `modelSelection` switch into the profile patch.
   *
   * A route of its own, and a `POST`, because it is the only request in this
   * family that changes a file outside this plugin's own settings section.
   */
  delegation: `${PANEL_BASE}/delegation`,
  /**
   * Probes one System One profile from the server.
   *
   * A `POST` with a JSON body naming the profile, and not a `GET`: it performs
   * outbound work on the user's behalf, and a cached or prefetched GET must never
   * be able to trigger a connection attempt.
   */
  systemOneTest: `${PANEL_BASE}/systemone/test`
} as const;

/** How many recent ledger entries one snapshot carries. Default 25, cap 200. */
export const PANEL_LEDGER_WINDOW = 25;

/** Largest accepted `?limit=` value, so one request cannot ask for the world. */
export const PANEL_LEDGER_WINDOW_MAX = 200;

/**
 * One candidate of a virtual model pool, as the panel renders it.
 *
 * Mirrors the authored `ReflexModelPoolEntry` rather than the resolved router
 * entry: the panel edits authored configuration, so it shows exactly the keys
 * the settings document can carry.
 */
export interface PanelPoolEntry {
  provider: string;
  model: string;
  description?: string;
  tags?: string[];
}

/** One virtual model and its ordered physical candidate pool. */
export interface PanelPoolView {
  /** Virtual model id the deployment selects (`reflex:<id>`). */
  model: string;
  entries: PanelPoolEntry[];
}

/** Routing block of the snapshot. */
export interface PanelRoutingView {
  enabled: boolean;
  /** Whether an activation actually registered the virtual provider. */
  active: boolean;
  virtualProvider: string;
  fallback?: string;
  maxTaskChars: number;
  /** Total candidates across every pool. */
  candidates: number;
  pools: PanelPoolView[];
}

/** Effort block of the snapshot. */
export interface PanelEffortView {
  /** `reflex`/`auto` (per-turn adaptive), one pinned level, or `null` when unset. */
  setting: string | null;
  fallback: string;
  minConfidence: number;
  /** Whether adaptive effort may decide anything; `false` turns the adaptive half off. */
  enabled: boolean;
  /** Most recent adaptive decision of this activation, if any. */
  latest: PanelEffortDecision | null;
  /** How many adaptive decisions the ledger has recorded. */
  decisions: number;
}

/** Automatic-intervention block of the snapshot. */
export interface PanelInterventionsView {
  /** Authored master mode. */
  mode: string;
  /** Whether any capability is enabled at all. */
  enabled: boolean;
  /** Whether any capability resolves to `active` rather than merely observing. */
  acting: boolean;
  /** Capability → effective mode, with `inherit` already resolved. */
  capabilities: Record<string, string>;
}

/**
 * Delegation block of the snapshot.
 *
 * Deliberately not folded into {@link PanelToolsView}: those switches decide
 * which tools *this plugin* registers, while this one decides whether the *Host*
 * is asked for a capability (`modelSelection`). The panel shows them apart so the
 * one switch that edits a file outside this plugin cannot look like the others.
 */
export interface PanelDelegationView {
  /** The authored consent (`delegation.enabled`); off by default. */
  enabled: boolean;
  /** Whether `reflex_delegate` is registered in the live registry right now. */
  registered: boolean;
  /** What the live Host registry says, or `unknown` when no fact was supplied. */
  state: DelegationHealthState | 'unknown';
  /** The host profile patch this switch edits, when one could be resolved. */
  patchPath?: string;
  /** Which fact resolved {@link patchPath}. */
  patchPathSource?: string;
  /** Whether the host patch currently asks for the field (read from the file). */
  patchEnabled: boolean;
  /** Why the capability is not usable, or why the patch could not be read. */
  reason?: string;
  /**
   * Whether a write has happened that only a restart can apply.
   *
   * Computed from facts, never guessed: the switch is on, the file asks for the
   * field, and the host tool still does not declare `reasoning_effort`.
   */
  restartRequired: boolean;
}

/** Per-tool switch block of the snapshot. */
export interface PanelToolsView {
  /** Suffix → switch, every suffix of the vocabulary answered. */
  enabled: Record<string, boolean>;
  /** Registered tool names as the runtime surface reports them, in registration order. */
  active: string[];
}

/** One projected adaptive-effort decision (`effort-decision` ledger entries and the live feed agree on these). */
export interface PanelEffortDecision {
  level: string;
  applied: string | null;
  outcome: string;
  trigger: string;
  source: string;
  confidence: number;
  latencyMs: number;
  provider: string;
  model: string;
  line: string;
  at: number;
  agentId?: string;
  role?: string;
  turn?: number;
  step?: number;
  basis?: string[];
  degradedReason?: string;
}

/** Ledger totals, projected from `DecisionLedger.getSummary`. */
export interface PanelLedgerSummary {
  totalCalls: number;
  callsByType: Record<string, number>;
  totalTokensSaved: number;
  avgLatencyMs: number;
  estimatedCostSavedUsd: number;
  stagnationAlerts: number;
  gatePassedCount: number;
  gateFailedCount: number;
}

/** One projected ledger entry. */
export interface PanelLedgerRow {
  id: string;
  at: string;
  type: string;
  backend: string;
  latencyMs: number;
  tokensSaved: number;
  passed?: boolean;
  isStuck?: boolean;
  shadow?: boolean;
  skipReason?: string;
  /** `details.action`, when the recording code path declared one. */
  action?: string;
  /** `details.target`, the physical `provider:model` a routing decision chose. */
  target?: string;
  /** `details.level`, the level an effort decision chose. */
  level?: string;
  /** `details.applied`, the effort actually dispatched; `null` when cleared. */
  applied?: string | null;
  /** `details.reason`, why the decision landed where it did. */
  reason?: string;
  /**
   * `details.currentModel`, the `provider:model` the session held before a
   * routing decision; absent on a session's first decision.
   */
  currentModel?: string;
  /** `details.switched`, whether the decision moved the session's model. */
  switched?: boolean;
  /** `details.contextTokens`, the context size the routing decision reasoned about. */
  contextTokens?: number;
}

/** Ledger block of the snapshot. */
export interface PanelLedgerView {
  summary: PanelLedgerSummary;
  recent: PanelLedgerRow[];
  /** JSONL sink, or `null` for an in-memory ledger. */
  logPath: string | null;
  /** Whether the Host will accept a clear request for this ledger. */
  clearable: boolean;
}

/** Health of the System One gateway conversation, as the panel renders it. */
export interface PanelSystemOneHealth {
  /** Whether the most recent request succeeded; `false` shows the degraded banner. */
  available: boolean;
  /** Why the most recent request failed, if it did. */
  lastFailureReason?: string;
  /** ISO timestamp of the most recent failure. */
  lastFailureAt?: string;
  /** Consecutive failed requests; a single success resets it. */
  consecutiveFailures: number;
}

/**
 * One connection profile, as the panel renders it.
 *
 * Every field here is a *non-secret* one. The key never appears: the panel learns
 * only {@link apiKeyPresent}, which is what lets it draw a write-only input with
 * a placeholder without ever holding the value.
 */
export interface PanelSystemOneProfileView {
  /** Profile name; also the row id and the settings path segment. */
  name: string;
  baseUrl?: string;
  model?: string;
  /** Environment variable this profile names, when it names one. */
  apiKeyEnv?: string;
  /**
   * Whether this profile currently resolves a key — from its own secret slot or
   * from the variable the chain names. Never which value.
   */
  apiKeyPresent: boolean;
  /** Whether the key this profile resolves is its own secret slot (not a variable). */
  apiKeyFromProfile: boolean;
  /**
   * The variable that supplied this profile's key, or the one it named and
   * found empty. A name, never a value.
   */
  apiKeyVariable?: string;
  /**
   * This profile names a variable that is empty, and the lookup locked onto it
   * (g-059): no fallback variable was consulted. Rendered as "named, but empty"
   * rather than as "no key configured".
   */
  apiKeyLocked?: boolean;
  timeoutMs?: number;
  backend?: string;
  /** Every model id this connection offers, in authored order (g-066). */
  modelIds?: string[];
  /** The one model id in force for this connection: what the runtime and the probe use. */
  selectedModel?: string;
  /**
   * `selectedModel` is not in {@link modelIds}.
   *
   * The row must say so: the runtime then sends no model at all rather than
   * quietly running a different one, and a probe would test a request nobody
   * selected. Absent when the selection is valid (or when none is named).
   */
  modelMissing?: boolean;
  /** Whether this is the profile in force. */
  active: boolean;
}

/** System One backend block of the snapshot. */
export interface PanelSystemOneView {
  /** Selected implementation; `auto` resolves through the environment. */
  backend: string;
  /** Name of the backend implementation the activation actually built. */
  active: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /**
   * Whether the key chain currently resolves a key — from the settings
   * document, from `apiKeyEnv`, or from one of the fallback variables. Never
   * which value.
   */
  apiKeyPresent: boolean;
  /**
   * Where that key came from, so the page can say "from the configuration",
   * "from JEV_API_KEY", or "from JEV_API_KEY (fallback)" instead of guessing
   * from `apiKeyEnv`. Absent when no key resolves at all.
   *
   * `fallback` is an environment read reached through the documented variable
   * list because the block named *no* variable (g-059) — marked as such so a
   * deployment that meant to name one can tell it named nothing.
   */
  apiKeySource?: 'profile' | 'env' | 'fallback';
  /**
   * The environment variable that supplied the key (present when
   * {@link apiKeySource} is `env` or `fallback`), or — when nothing resolved —
   * the variable the block named and found empty. A *name*; no value travels.
   */
  apiKeyVariable?: string;
  /**
   * The block named a variable that is empty, and the lookup stopped there on
   * purpose (g-059): no fallback variable was consulted. Distinct from a plain
   * `apiKeyPresent: false`, which means nothing was named and nothing was found.
   */
  apiKeyLocked?: boolean;
  /** Whether the resolved configuration carries a literal key. Never the key. */
  apiKeyFromProfile: boolean;
  timeoutMs?: number;
  /** Every authored profile, in authored order. Empty when none is authored. */
  profiles: PanelSystemOneProfileView[];
  /** The authored `active` name, when one was authored. */
  activeProfile?: string;
  /**
   * The authored `active` name matches no profile. Surfaced as a warning rather
   * than hidden: a typo must not look like a working configuration — and since
   * g-066 it also means nothing connects.
   */
  activeProfileMissing: boolean;
  /**
   * Why nothing connects, when nothing does (g-066): no profiles, none
   * activated, the active name missing, or only the pre-g-066 flat fields.
   *
   * Absent exactly when an active profile resolved, so the page renders its
   * "unconfigured" state from this and never from a guess about the fields.
   */
  unconfigured?: 'no-active-profile' | 'no-profiles' | 'active-profile-missing' | 'legacy-config-required';
  /** The active profile's selected model is not in its list; nothing runs. */
  activeProfileModelMissing?: boolean;
  /**
   * Live gateway health, when the backend keeps any. Backends that answer every
   * call in-process (mock) omit it; the absence is not an outage.
   */
  health?: PanelSystemOneHealth;
}

/** Plugin identity block of the snapshot. */
export interface PanelPluginView {
  name: string;
  version: string;
  toolPrefix: string;
  ledgerPath?: string;
  pruneThreshold: number;
  calibrationPath?: string;
}

/** The whole panel payload. */
export interface PanelModelGroup {
  id: string;
  name: string;
  models: Array<{ id: string; name?: string }>;
}

export interface PanelSnapshot {
  ok: true;
  at: number;
  plugin: PanelPluginView;
  routing: PanelRoutingView;
  effort: PanelEffortView;
  systemOne: PanelSystemOneView;
  interventions: PanelInterventionsView;
  tools: PanelToolsView;
  delegation: PanelDelegationView;
  ledger: PanelLedgerView;
  modelCatalog?: PanelModelGroup[];
}

/**
 * Everything {@link buildPanelSnapshot} needs, gathered by the caller.
 *
 * Passing facts in (instead of reaching into a live runtime) keeps the
 * projection a pure function of its inputs, which is what the unit tests pin.
 */
export interface PanelRuntimeFacts {
  config: ResolvedReflexConfig;
  /** `DecisionBackend.name` of the activation. */
  backendName: string;
  /** Ordered pools as the deployment authored them. */
  pools: PanelPoolView[];
  /**
   * The physical fallback currently in force, `provider:model`.
   *
   * Read from the live router, not from the resolved config: a settings edit is
   * committed into the running activation without a remount, so the config the
   * activation resolved at startup is exactly the stale value the panel must not
   * report as effective. `null` means the live policy has no fallback (fail
   * closed); `undefined` means the caller did not supply a live fact and the
   * activation's resolved config is the best available answer.
   */
  routingFallback?: string | null;
  /** Whether the virtual provider route is installed. */
  routingActive: boolean;
  /**
   * Registered tool names of this activation, as
   * {@link ReflexRuntime.toolSurface} reports them.
   *
   * Required, not derived from the switches: the panel's promise is to show the
   * *effective* surface, and a derived guess would keep agreeing with the config
   * while the registry disagreed with both.
   */
  toolSurface: readonly string[];
  ledger: Pick<DecisionLedger, 'getSummary' | 'getEntries' | 'getLogPath'>;
  /** Latest adaptive decision of this activation. */
  effort: ReflexEffortStatus | undefined;
  /** Whether an API key is currently reachable through the resolved key chain. */
  apiKeyPresent: boolean;
  /**
   * Where that key came from: a literal in the settings document (`profile`), an
   * environment variable the block named (`env`), or a documented fallback
   * variable (`fallback`). Absent when no key resolves.
   */
  apiKeySource?: 'profile' | 'env' | 'fallback';
  /**
   * The variable that supplied the key, or the named-but-empty one. A name,
   * never a value.
   */
  apiKeyVariable?: string;
  /** The block named a variable that is empty, so no fallback was consulted. */
  apiKeyLocked?: boolean;
  /**
   * Key *presence* per profile name — the only key fact the panel may receive.
   *
   * A map of booleans and variable names, never of values: the projection cannot
   * leak what it is not handed, and a test asserts the serialized snapshot
   * contains no key substring.
   */
  profileKeys?: Record<string, { present: boolean; fromProfile: boolean; variable?: string; locked?: boolean }>;
  /** Health of the backend's gateway conversation, when it tracks one. */
  systemOneHealth?: PanelSystemOneHealth;
  /** Available physical model catalog from ctx.llm. */
  modelCatalog?: PanelModelGroup[];
  /**
   * The live delegation-capability reading.
   *
   * `undefined` when the caller could not read the registry at all, which the
   * projection reports as `unknown` rather than inventing a state.
   */
  delegationHealth?: { state: DelegationHealthState; reason?: string };
  /**
   * The host profile patch, as read from disk by the caller.
   *
   * Supplied rather than read here so the projection stays pure: the mount layer
   * owns the file access, and a test drives it with a scratch path.
   */
  hostPatch?: { path?: string; source?: string; enabled: boolean; reason?: string };
  /** Timestamp of the snapshot; defaults to now. */
  now?: number;
}

/**
 * The fallback the panel must report.
 * @param facts - gathered runtime facts.
 * @returns the live fallback when one was supplied, else the activation's.
 */
function fallbackOf(facts: PanelRuntimeFacts): string | undefined {
  if (facts.routingFallback === null) return undefined;
  if (facts.routingFallback !== undefined) return facts.routingFallback;
  const fallback = facts.config.routing.fallback;
  return fallback === undefined ? undefined : `${fallback.provider}:${fallback.model}`;
}

/** Narrow one open `details` value to projected scalar fields. */
function projectRow(entry: LedgerEntry): PanelLedgerRow {
  const details = entry.details;
  const text = (key: string): string | undefined => {
    const value = details?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const action = text('action');
  const target = text('target');
  const level = text('level');
  const reason = text('reason');
  const rawApplied = details?.applied;
  const applied = typeof rawApplied === 'string' ? rawApplied : rawApplied === null ? null : undefined;
  const currentModel = text('currentModel');
  const rawSwitched = details?.switched;
  const switched = typeof rawSwitched === 'boolean' ? rawSwitched : undefined;
  const rawContextTokens = details?.contextTokens;
  const contextTokens =
    typeof rawContextTokens === 'number' && Number.isFinite(rawContextTokens) ? rawContextTokens : undefined;
  return {
    id: entry.id,
    at: entry.timestamp,
    type: entry.type,
    backend: entry.backend,
    latencyMs: entry.latencyMs,
    tokensSaved: entry.tokensSaved ?? 0,
    ...(entry.passed === undefined ? {} : { passed: entry.passed }),
    ...(entry.isStuck === undefined ? {} : { isStuck: entry.isStuck }),
    ...(entry.shadow === undefined ? {} : { shadow: entry.shadow }),
    ...(entry.skipReason === undefined ? {} : { skipReason: entry.skipReason }),
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(level === undefined ? {} : { level }),
    ...(applied === undefined ? {} : { applied }),
    ...(reason === undefined ? {} : { reason }),
    ...(currentModel === undefined ? {} : { currentModel }),
    ...(switched === undefined ? {} : { switched }),
    ...(contextTokens === undefined ? {} : { contextTokens })
  };
}

/**
 * Project one adaptive-effort status onto the wire shape.
 * @param status - the published status.
 * @returns the projected decision; basis entries that are not strings are dropped.
 */
export function projectEffortDecision(status: ReflexEffortStatus): PanelEffortDecision {
  const basis = Array.isArray(status.basis) ? status.basis.filter((item): item is string => typeof item === 'string') : undefined;
  return {
    level: status.level,
    applied: status.applied ?? null,
    outcome: status.outcome,
    trigger: status.trigger,
    source: status.source,
    confidence: status.confidence,
    latencyMs: status.latencyMs,
    provider: status.provider,
    model: status.model,
    line: status.line,
    at: status.at,
    ...(status.agentId === undefined ? {} : { agentId: status.agentId }),
    ...(status.role === undefined ? {} : { role: status.role }),
    ...(status.turn === undefined ? {} : { turn: status.turn }),
    ...(status.step === undefined ? {} : { step: status.step }),
    ...(basis === undefined ? {} : { basis }),
    ...(status.degradedReason === undefined ? {} : { degradedReason: status.degradedReason })
  };
}

/**
 * Build the panel payload from one activation's facts.
 *
 * Pure: the same facts always produce the same payload, except for the `at`
 * timestamp the caller may pin.
 * @param facts - gathered runtime facts.
 * @param limit - how many recent entries to carry; clamped to the accepted window.
 * @returns the serializable snapshot.
 */
export function buildPanelSnapshot(facts: PanelRuntimeFacts, limit: number = PANEL_LEDGER_WINDOW): PanelSnapshot {
  const window = clampLimit(limit);
  const { config } = facts;
  const entries = facts.ledger.getEntries();
  const recent = entries.slice(Math.max(0, entries.length - window)).map(projectRow);
  const decisions = entries.filter((entry) => entry.type === 'effort-decision').length;

  return {
    ok: true,
    at: facts.now ?? Date.now(),
    plugin: {
      name: 'dsh-reflex',
      version: REFLEX_PLUGIN_VERSION,
      toolPrefix: config.toolPrefix,
      pruneThreshold: config.pruneThreshold,
      ...(config.ledgerPath === undefined ? {} : { ledgerPath: config.ledgerPath }),
      ...(config.calibrationPath === undefined ? {} : { calibrationPath: config.calibrationPath })
    },
    routing: {
      enabled: config.routing.enabled,
      active: facts.routingActive,
      virtualProvider: config.routing.virtualProvider,
      maxTaskChars: config.routing.maxTaskChars,
      candidates: facts.pools.reduce((total, pool) => total + pool.entries.length, 0),
      pools: facts.pools.map((pool) => ({ model: pool.model, entries: pool.entries.map(clonePoolEntry) })),
      ...(fallbackOf(facts) === undefined ? {} : { fallback: fallbackOf(facts) })
    },
    effort: {
      setting: config.effort.setting ?? null,
      fallback: config.effort.fallback,
      minConfidence: config.effort.minConfidence,
      enabled: config.effort.enabled,
      decisions,
      latest: facts.effort === undefined ? null : projectEffortDecision(facts.effort)
    },
    interventions: {
      mode: config.interventions.mode,
      enabled: config.interventions.enabled,
      acting: INTERVENTION_CAPABILITIES.some((capability) => config.interventions.capabilities[capability] === 'active'),
      capabilities: { ...config.interventions.capabilities }
    },
    tools: {
      enabled: { ...config.tools.enabled },
      active: [...facts.toolSurface]
    },
    delegation: projectDelegation(config, facts),
    systemOne: projectSystemOne(config, facts),
    ledger: {
      summary: facts.ledger.getSummary(),
      recent,
      logPath: facts.ledger.getLogPath(),
      // Clearing drops the in-memory entries and, when this activation owns a
      // JSONL sink, deletes that file; the panel confirms before asking.
      clearable: true
    },
    ...(facts.modelCatalog === undefined ? {} : { modelCatalog: facts.modelCatalog })
  };
}

/**
 * Project the System One connection block, including every profile.
 *
 * The one rule this function exists to keep: **no key value may reach the
 * payload**. It reads {@link PanelRuntimeFacts.profileKeys} — presence flags the
 * caller gathered — and never `config.systemOne.profiles[*].apiKey`, which does
 * exist in the resolved config because the backend needs it.
 *
 * @param config - the configuration in force.
 * @param facts - gathered runtime facts.
 * @returns the wire projection of the connection block.
 */
export function projectSystemOne(config: ResolvedReflexConfig, facts: PanelRuntimeFacts): PanelSystemOneView {
  const { systemOne } = config;
  // Presence, never value: a profile "has" a key when its own secret slot is set,
  // else when one of the variables the chain names holds a non-empty value.
  const keyFacts = (
    name: string,
    profile: { apiKey?: string; apiKeyEnv?: string }
  ): { present: boolean; fromProfile: boolean; variable?: string; locked?: boolean } => {
    const supplied = facts.profileKeys?.[name];
    if (supplied !== undefined) return supplied;
    const own = typeof profile.apiKey === 'string' && profile.apiKey.length > 0;
    return { present: own, fromProfile: own };
  };
  // A row shows the connection it would *actually use*. Since g-066 that is the
  // profile's own fields and nothing else — there is no block beneath it to
  // inherit from — and the model shown is the *selected* one, the same value the
  // runtime sends and the probe tests. A selection pointing outside `modelIds`
  // projects no model plus `modelMissing`, so the row can say why.
  const profiles: PanelSystemOneProfileView[] = Object.entries(systemOne.profiles ?? {}).map(([name, profile]) => {
    const keys = keyFacts(name, profile);
    const projected = connectionTarget(systemOne, name, profile);
    const selectedOutsideList = profile.selectedModel !== undefined && !(profile.modelIds ?? []).includes(profile.selectedModel);
    return {
      name,
      active: systemOne.active === name,
      apiKeyPresent: keys.present,
      apiKeyFromProfile: keys.fromProfile,
      ...(keys.variable === undefined ? {} : { apiKeyVariable: keys.variable }),
      ...(keys.locked === true ? { apiKeyLocked: true } : {}),
      ...(projected.baseUrl === undefined ? {} : { baseUrl: projected.baseUrl }),
      ...(projected.model === undefined ? {} : { model: projected.model }),
      ...(projected.apiKeyEnv === undefined ? {} : { apiKeyEnv: projected.apiKeyEnv }),
      ...(projected.timeoutMs === undefined ? {} : { timeoutMs: projected.timeoutMs }),
      ...(projected.backend === undefined ? {} : { backend: projected.backend }),
      ...(profile.modelIds === undefined ? {} : { modelIds: [...profile.modelIds] }),
      ...(profile.selectedModel === undefined ? {} : { selectedModel: profile.selectedModel }),
      ...(selectedOutsideList ? { modelMissing: true } : {})
    };
  });
  const resolvedCarriesKey = typeof systemOne.apiKey === 'string' && systemOne.apiKey.length > 0;
  return {
    backend: systemOne.backend,
    active: facts.backendName,
    apiKeyPresent: facts.apiKeyPresent,
    apiKeyFromProfile: resolvedCarriesKey,
    // Provenance travels as a source tag and a variable *name* — the caller
    // resolved them through the one key chain and dropped the value there.
    ...(facts.apiKeySource === undefined ? {} : { apiKeySource: facts.apiKeySource }),
    ...(facts.apiKeyVariable === undefined ? {} : { apiKeyVariable: facts.apiKeyVariable }),
    ...(facts.apiKeyLocked === true ? { apiKeyLocked: true } : {}),
    profiles,
    activeProfileMissing: systemOne.activeProfileMissing === true,
    ...(systemOne.unconfigured === undefined ? {} : { unconfigured: systemOne.unconfigured }),
    ...(systemOne.activeProfileModelMissing === true ? { activeProfileModelMissing: true } : {}),
    ...(facts.systemOneHealth === undefined ? {} : { health: { ...facts.systemOneHealth } }),
    ...(systemOne.active === undefined ? {} : { activeProfile: systemOne.active }),
    ...(systemOne.baseUrl === undefined ? {} : { baseUrl: systemOne.baseUrl }),
    ...(systemOne.model === undefined ? {} : { model: systemOne.model }),
    ...(systemOne.apiKeyEnv === undefined ? {} : { apiKeyEnv: systemOne.apiKeyEnv }),
    ...(systemOne.timeoutMs === undefined ? {} : { timeoutMs: systemOne.timeoutMs })
  };
}

/**
 * Project the delegation switch, the host patch it edits, and the live capability.
 *
 * The "not working" reasons are kept apart on purpose, because the fix differs:
 * `model-selection-off` is a tool that does not publish the level (tick the
 * switch, restart), while `missing-tool` is a host without a delegation tool at
 * all (nothing this plugin can do). `unknown` is neither: it means the capability
 * was not probed, and it must never be rendered as "off".
 *
 * `registered` now follows **configuration** (g-054), so the one contradiction
 * this view exists to prevent — "the switch is ticked, the tool is never
 * registered" — can no longer be produced by the plugin. `restartRequired` is
 * the remaining explanation for "I ticked it and the level still does not take
 * effect": the file asks, but the running host still does not publish the
 * parameter.
 * @param config - the configuration in force.
 * @param facts - gathered runtime facts.
 * @returns the wire projection of the delegation block.
 */
export function projectDelegation(config: ResolvedReflexConfig, facts: PanelRuntimeFacts): PanelDelegationView {
  const state = facts.delegationHealth?.state ?? 'unknown';
  const enabled = config.delegation.enabled;
  const registered = [...facts.toolSurface].some((name) => name.endsWith('delegate'));
  const patchEnabled = facts.hostPatch?.enabled ?? false;
  // The runtime's own reading wins over the file's: a stale file that asks for
  // the field while the tool still refuses is precisely the restart case.
  const broken = state === 'model-selection-off' || state === 'missing-tool';
  const reason =
    enabled && broken
      ? facts.delegationHealth?.reason
      : // An unprobed capability explains itself: without this the panel would
        // fall back to the patch's reason and imply the patch was the problem.
        enabled && state === 'unknown' && registered
        ? facts.delegationHealth?.reason
        : facts.hostPatch?.reason;
  return {
    enabled,
    registered,
    state,
    patchEnabled,
    restartRequired: enabled && patchEnabled && state === 'model-selection-off',
    ...(facts.hostPatch?.path === undefined ? {} : { patchPath: facts.hostPatch.path }),
    ...(facts.hostPatch?.source === undefined ? {} : { patchPathSource: facts.hostPatch.source }),
    ...(reason === undefined ? {} : { reason })
  };
}

/** Detached copy of one pool entry, so a caller cannot mutate the payload later. */
function clonePoolEntry(entry: PanelPoolEntry): PanelPoolEntry {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.tags === undefined ? {} : { tags: [...entry.tags] })
  };
}

/**
 * Clamp a requested ledger window onto the accepted range.
 * @param limit - requested count; non-finite values fall back to the default.
 * @returns a count in `[1, PANEL_LEDGER_WINDOW_MAX]`.
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return PANEL_LEDGER_WINDOW;
  return Math.min(PANEL_LEDGER_WINDOW_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * Read one query parameter of a panel request.
 * @param url - raw request URL, path and query.
 * @param name - parameter name.
 * @returns the value, or `null` when absent.
 */
export function readQuery(url: string | undefined, name: string): string | null {
  const query = url === undefined ? '' : (url.split('?')[1] ?? '');
  return new URLSearchParams(query).get(name);
}

/**
 * Read the `limit` query parameter of a panel request.
 * @param url - raw request URL, path and query.
 * @returns the parsed count, or the default when absent or unusable.
 */
export function readLimit(url: string | undefined): number {
  const raw = readQuery(url, 'limit');
  if (raw === null || raw.trim().length === 0) return PANEL_LEDGER_WINDOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampLimit(parsed) : PANEL_LEDGER_WINDOW;
}

/** Whether an IPv4 literal names the loopback range `127/8`. */
export function isLoopbackIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  if (parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Whether a socket remote address names loopback (`127/8`, `::1`, or a mapped form).
 *
 * The socket address is authoritative: a `Host` header or `X-Forwarded-For` can
 * be forged by the caller, so neither decides this.
 * @param address - `request.socket.remoteAddress`.
 * @returns whether the peer is on this machine.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackIPv4(normalized.slice(7));
  return isLoopbackIPv4(normalized);
}

/** Extra allow rules a Host may install beside the loopback fence. */
export interface PanelAccessOptions {
  /**
   * Whether an optional pairing service recognises this request as a paired
   * device. Absent means "loopback only".
   */
  isPaired?: ((request: IncomingMessage) => boolean) | undefined;
}

/**
 * Whether one request may reach the panel routes.
 * @param request - the incoming request.
 * @param options - optional pairing check.
 * @returns whether the request is allowed.
 */
export function isPanelRequestAllowed(request: IncomingMessage, options: PanelAccessOptions = {}): boolean {
  if (isLoopbackAddress(request.socket?.remoteAddress)) return true;
  const isPaired = options.isPaired;
  if (typeof isPaired !== 'function') return false;
  try {
    return isPaired(request) === true;
  } catch {
    return false;
  }
}

/** Narrow response face the panel handlers need; `ServerResponse` satisfies it. */
export interface PanelResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: string): unknown;
}

/** What one panel request resolves to, before it is serialized. */
export interface PanelAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The live facts one panel route family answers from. */
export interface PanelSource {
  /** Build the current snapshot. */
  snapshot(limit: number): PanelSnapshot;
  /** Clear the ledger. @returns how many entries were dropped. */
  clearLedger(): number;
  /** Whether the loopback/pairing fence admitted this request. */
  allows(request: IncomingMessage): boolean;
  /**
   * Turn the host `modelSelection` switch on in the profile patch.
   *
   * Omitted by a host that cannot write the file; the route then answers 501
   * rather than pretending, which is what tells the panel to say "do it by hand".
   * @returns the outcome the panel renders.
   */
  enableDelegation?: () => PanelDelegationWrite;
  /**
   * Probe one System One profile; absent means the host cannot, and the route
   * answers 501 rather than pretending the connection was fine.
   * @param profile - profile name, or `undefined` for the active one.
   * @param signal - cancelled when the client goes away.
   * @returns the classified probe result.
   */
  testSystemOne?: (profile: string | undefined, signal: AbortSignal) => Promise<PanelProbeAnswer>;
}

/** The answer of one connection probe. */
export interface PanelProbeAnswer {
  ok: boolean;
  /** `ok` | `auth-failed` | `unreachable` | `timeout` | `bad-response` | `misconfigured`. */
  status: string;
  /** Real round trip, in milliseconds. */
  latencyMs: number;
  /** Profile that was probed, or `null` when the flat block was. */
  profile: string | null;
  httpStatus?: number;
  /** Redacted, single-line explanation. */
  detail?: string;
  model?: string;
  endpoint?: string;
}

/** The answer of one delegation write. */
export interface PanelDelegationWrite {
  /** What happened, in the vocabulary {@link HostPatchResult} uses. */
  outcome: string;
  /** Absolute path edited, when one was. */
  path?: string;
  /** Which fact resolved that path. */
  source?: string;
  /** Why nothing was written, when nothing was. */
  reason?: string;
  /** Backup written before the edit, when one was. */
  backupPath?: string;
  /**
   * Whether the change needs a DSH restart to take effect.
   *
   * Always `true` for an actual write: the host reads `tool-subagent`'s config
   * at boot, and only this plugin's own fiber hot-updates.
   */
  restartRequired: boolean;
}

/** JSON headers every panel answer carries. */
function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra };
}

/**
 * Resolve one panel request into a status and a JSON body.
 *
 * Kept separate from the socket so the whole route family is testable without a
 * server: {@link makePanelRoutes} only adapts this to `node:http`.
 * @param source - the live facts.
 * @param request - the incoming request.
 * @returns the answer to serialize.
 */
export function answerPanelRequest(source: PanelSource, request: IncomingMessage): PanelAnswer {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = (request.url ?? '/').split('?')[0] ?? '/';

  if (!source.allows(request)) {
    return { status: 403, body: { ok: false, error: 'forbidden', detail: 'the reflex panel answers loopback clients and paired devices only' } };
  }

  switch (path) {
    case PANEL_ROUTES.snapshot:
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
      return { status: 200, body: source.snapshot(readLimit(request.url)) };
    case PANEL_ROUTES.health:
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
      return { status: 200, body: { ok: true, name: 'dsh-reflex', version: REFLEX_PLUGIN_VERSION } };
    case PANEL_ROUTES.delegation:
      if (method !== 'POST') return methodNotAllowed('POST');
      // The write edits a file the user owns, outside this plugin's settings
      // section. Same fence as the ledger clear: an accidental or cross-site
      // GET/POST must not be enough, so the caller has to name the intent.
      if (readQuery(request.url, 'confirm') !== 'delegation') {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'confirmation-required',
            detail: 'this writes tool-subagent.modelSelection into the profile patch; repeat the POST with ?confirm=delegation'
          }
        };
      }
      if (source.enableDelegation === undefined) {
        return {
          status: 501,
          body: { ok: false, error: 'not-writable', detail: 'this host cannot write the profile patch; add the row by hand' }
        };
      }
      return { status: 200, body: { ok: true, ...source.enableDelegation() } };
    case PANEL_ROUTES.clearLedger:
      if (method !== 'POST') return methodNotAllowed('POST');
      // Clearing deletes the owned JSONL sink as well as the in-memory entries,
      // so an accidental (or cross-site) POST must not be enough on its own.
      if (readQuery(request.url, 'confirm') !== 'clear') {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'confirmation-required',
            detail: 'clearing the ledger deletes its JSONL sink; repeat the POST with ?confirm=clear'
          }
        };
      }
      return { status: 200, body: { ok: true, cleared: source.clearLedger() } };
    default:
      return { status: 404, body: { ok: false, error: 'not-found', detail: `unknown reflex panel route "${path}"` } };
  }
}

/** Largest body the probe route will read, so a request cannot make it buffer the world. */
export const PANEL_PROBE_BODY_MAX = 4_096;

/**
 * Read one request body, bounded.
 *
 * @param request - the incoming request.
 * @param max - largest accepted length in bytes.
 * @returns the body text, or `undefined` when it exceeded the bound.
 */
async function readBoundedBody(request: IncomingMessage, max: number = PANEL_PROBE_BODY_MAX): Promise<string | undefined> {
  const stream = request as IncomingMessage & AsyncIterable<Buffer | string>;
  let size = 0;
  const chunks: string[] = [];
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    size += Buffer.byteLength(text, 'utf8');
    if (size > max) return undefined;
    chunks.push(text);
  }
  return chunks.join('');
}

/**
 * Resolve one panel request that may need to read a body or probe a connection.
 *
 * The synchronous {@link answerPanelRequest} stays the entry point for every
 * route that needs neither, which is what keeps its existing callers (and their
 * assertions) unchanged. This one handles the probe route, whose body names the
 * profile and whose answer takes a real network round trip.
 *
 * @param source - the live facts.
 * @param request - the incoming request.
 * @returns the answer to serialize.
 */
export async function answerPanelRequestAsync(source: PanelSource, request: IncomingMessage): Promise<PanelAnswer> {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  if (path !== PANEL_ROUTES.systemOneTest) return answerPanelRequest(source, request);

  const method = (request.method ?? 'GET').toUpperCase();
  if (!source.allows(request)) {
    return { status: 403, body: { ok: false, error: 'forbidden', detail: 'the reflex panel answers loopback clients and paired devices only' } };
  }
  if (method !== 'POST') return methodNotAllowed('POST');
  if (source.testSystemOne === undefined) {
    return {
      status: 501,
      body: { ok: false, error: 'not-probeable', detail: 'this host cannot reach a System One endpoint from the server' }
    };
  }

  // An absent body means "the active profile"; anything else must be JSON naming
  // one. A malformed body is refused here rather than guessed at.
  const raw = await readBoundedBody(request);
  if (raw === undefined) {
    return { status: 413, body: { ok: false, error: 'body-too-large', detail: `the request body must stay under ${String(PANEL_PROBE_BODY_MAX)} bytes` } };
  }
  let requested: string | undefined;
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { status: 400, body: { ok: false, error: 'bad-json', detail: 'the request body must be JSON like {"profile":"name"}' } };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: { ok: false, error: 'bad-body', detail: 'the request body must be a JSON object' } };
    }
    const value = (parsed as { profile?: unknown }).profile;
    if (value !== undefined && typeof value !== 'string') {
      return { status: 400, body: { ok: false, error: 'bad-profile', detail: '"profile" must be a string when present' } };
    }
    requested = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  // The client may go away mid-probe (panel closed, route unmounted); the probe
  // then stops instead of completing into a destroyed socket.
  const controller = new AbortController();
  request.once?.('close', () => controller.abort());
  try {
    const result = await source.testSystemOne(requested, controller.signal);
    // `result` already carries `ok`, so the spread is the whole payload.
    return { status: 200, body: result };
  } catch (error) {
    // A probe is supposed to classify its own failures; reaching here means a bug.
    // Report it as a failed probe rather than a 500, so the row still renders.
    return {
      status: 200,
      body: {
        ok: false,
        status: 'bad-response',
        latencyMs: 0,
        profile: requested ?? null,
        detail: error instanceof Error ? redactProbeText(error.message) : 'the probe failed'
      }
    };
  }
}

/**
 * Scrub one probe detail before it is put on the wire.
 *
 * The probe already redacts; this is the second gate, at the boundary the payload
 * actually leaves through, so a bug in the first cannot become a leak.
 * @param text - raw detail.
 * @returns a single-line string with credential shapes removed.
 */
function redactProbeText(text: string): string {
  return String(text ?? '')
    .replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer ***')
    .replace(/\b(sk|pk|key)-[A-Za-z0-9._-]{6,}/g, '$1-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Standard 405 answer. */
function methodNotAllowed(allow: string): PanelAnswer {
  return { status: 405, body: { ok: false, error: 'method-not-allowed', detail: `use ${allow}` }, headers: { allow } };
}

/**
 * Serve one resolved answer over a `node:http` response.
 *
 * `HEAD` carries the same headers and no body, which is what a probe needs — so
 * the length is measured from the body the matching `GET` would send rather than
 * left for the server to guess from an empty chunk.
 * @param request - the incoming request.
 * @param response - the response to own.
 * @param answer - the resolved answer.
 */
export function sendPanelAnswer(request: IncomingMessage, response: PanelResponse, answer: PanelAnswer): void {
  const suppressed = answer.status === 204;
  const payload = suppressed ? '' : JSON.stringify(answer.body);
  const headers = jsonHeaders({
    ...(suppressed ? {} : { 'content-length': String(Buffer.byteLength(payload, 'utf8')) }),
    ...answer.headers
  });
  response.writeHead(answer.status, headers);
  if (suppressed || (request.method ?? 'GET').toUpperCase() === 'HEAD') {
    response.end();
    return;
  }
  response.end(payload);
}

/**
 * Build the `/api/dsh-reflex/*` route family.
 *
 * One handler owns every path in the family, so the method/path decision lives
 * in {@link answerPanelRequest} and cannot drift between routes; the
 * `kind: 'exact'` paths mean the server never routes an unrelated URL here.
 *
 * ## Why the handler catches
 *
 * The Host maps a throw out of a route handler onto a bare `400` with an empty
 * body, which erases the stack — the one thing needed to diagnose it. A panel
 * route that fails must therefore answer for itself: `500` plus the real detail.
 * This is not a substitute for handling a known failure where it happens (a
 * missing service is read defensively, not caught here); it guarantees that an
 * *unknown* one is still visible instead of silently becoming "bad request".
 * @param source - the live facts.
 * @returns the routes to register.
 */
export function makePanelRoutes(source: PanelSource): WebRoute[] {
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void answerPanelRequestAsync(source, request)
      .then((answer) => sendPanelAnswer(request, response, answer))
      .catch((error: unknown) => {
        reportHandlerError(response, error);
      });
  };

  const reportHandlerError = (response: ServerResponse, error: unknown): void => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(JSON.stringify({ ok: false, error: 'panel-handler-threw', detail }));
    } catch {
      // The socket is already gone: there is nobody left to report to.
    }
  };
  return [
    { kind: 'exact', path: PANEL_ROUTES.snapshot, handler },
    { kind: 'exact', path: PANEL_ROUTES.health, handler },
    { kind: 'exact', path: PANEL_ROUTES.clearLedger, handler },
    { kind: 'exact', path: PANEL_ROUTES.delegation, handler },
    { kind: 'exact', path: PANEL_ROUTES.systemOneTest, handler }
  ];
}

/** Every path this family owns, for diagnostics and tests. */
export const PANEL_PATHS: readonly string[] = Object.values(PANEL_ROUTES);
