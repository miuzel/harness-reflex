import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';

import { Config, resolveConfig, resolveDelegationConfig, resolveEffortSetting, resolveApiKey, resolveSystemOneConfig, resolveToolsConfig, routingActive, volatileSnapshots, type ReflexConfig, type ResolvedReflexConfig } from './config.js';
import { createReflexRuntime, type ReflexRuntime } from './bridge.js';
import { installModelRouting } from './routing.js';
import { defineReflexTools, delegationExecutables, enabledReflexToolSuffixes, reflexToolNames, resolveReflexToolExecutables } from './tools.js';
import type { ReflexDelegationSeam, ReflexToolSuffix } from './tools.js';
import { DELEGATION_TOOL_NAME, createReflexDelegation } from './delegation-dispatch.js';
import { readDelegationHealth, watchDelegationHealth, type DelegationHealth } from './delegation-health.js';
import { installLedgerCommand } from './command.js';
import { mountReflexPanel } from './panel-mount.js';
import { installInterventions } from './interventions.js';
import { appendInterventionRecord, appendPrunedOriginal } from './session-audit.js';
import { installActualProjection } from './actual-projection.js';
import { installDelegatedEffortInheritance } from './effort-delegation.js';

/**
 * DSH Host plugin that exposes the `harness-reflex` System One decision runtime
 * as in-process tools and as a System 1 model router.
 *
 * One activation owns one {@link ReflexRuntime} — its backend, ledger, the five
 * decision services, and the virtual→physical model router — and registers the
 * `reflex_*` tools on `ctx.tools`. Everything is created inside a single
 * `ctx.effect`, so unloading the plugin (or disposing the context) unregisters
 * every tool, detaches the `tools/change` observer, releases the virtual
 * provider route, unregisters `/reflex-ledger`, and drops the runtime whole.
 *
 * @module dsh-reflex
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The loader committed new values into this activation's volatile config
     * references without remounting the plugin.
     *
     * Routing pools and the fallback are read per request, so the activation
     * only has to re-resolve them to make a settings edit effective; nothing
     * else about the running activation is re-created.
     * @param paths - changed config paths as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
  }
}

/** Cordis plugin name. */
export const name = 'dsh-reflex';

/**
 * The runtime needs the tool registry, the LLM service for model routing, and
 * the command registry for `/reflex-ledger`: the virtual provider is a real
 * provider route on `ctx.llm`, and the ledger command is a Host-rendered command
 * that never reaches the model.
 */
export const inject = ['tools', 'llm', 'commands'];

export { Config, resolveConfig, resolveDelegationConfig, resolveEffortSetting, resolveApiKey, resolveSystemOneConfig, resolveToolsConfig, routingActive, volatileSnapshots, createReflexRuntime, defineReflexTools, enabledReflexToolSuffixes, reflexToolNames };
export type { ReflexDelegationConfig, ReflexToolsConfig, ResolvedDelegationConfig, ResolvedToolsConfig } from './config.js';
export {
  INTERVENTION_CAPABILITIES,
  INTERVENTION_MODES,
  INTERVENTION_SETTINGS,
  resolveInterventionSetting,
  resolveInterventionsConfig
} from './config.js';
export type { InterventionCapability, InterventionMode, InterventionSetting, ReflexInterventionsConfig, ResolvedInterventionsConfig } from './config.js';
export { INTERVENTION_SOURCE_KIND, InterventionEngine, WAIT_QUERY_TOOLS, installInterventions, isWaitQuery } from './interventions.js';
export type {
  InterventionAction,
  InterventionBaseline,
  InterventionCostBucket,
  InterventionInstallation,
  InterventionPlan,
  InterventionReport
} from './interventions.js';
export type { InterventionAuditRecord } from './session-audit.js';
export { createBackend } from './bridge.js';
export {
  LEDGER_COMMAND_ENTRIES,
  REFLEX_LEDGER_COMMAND,
  REFLEX_LEDGER_COMMAND_DESCRIPTION,
  formatLedgerReport,
  installLedgerCommand
} from './command.js';
export {
  PANEL_BASE,
  PANEL_LEDGER_WINDOW,
  PANEL_LEDGER_WINDOW_MAX,
  PANEL_PATHS,
  PANEL_ROUTES,
  REFLEX_PLUGIN_VERSION,
  answerPanelRequest,
  buildPanelSnapshot,
  clampLimit,
  isLoopbackAddress,
  isLoopbackIPv4,
  isPanelRequestAllowed,
  makePanelRoutes,
  projectEffortDecision,
  readLimit,
  readQuery,
  sendPanelAnswer
} from './panel-api.js';
export type {
  PanelAnswer,
  PanelEffortDecision,
  PanelEffortView,
  PanelLedgerRow,
  PanelLedgerSummary,
  PanelLedgerView,
  PanelPluginView,
  PanelPoolEntry,
  PanelPoolView,
  PanelResponse,
  PanelRoutingView,
  PanelRuntimeFacts,
  PanelSnapshot,
  PanelSource,
  PanelSystemOneHealth,
  PanelSystemOneView
} from './panel-api.js';
export { mountReflexPanel } from './panel-mount.js';
export { createPanelSource, panelFacts, panelPools } from './panel-mount.js';
export { ReflexRuntime } from './bridge.js';
export { REFLEX_TOOL_SUFFIXES } from './tools.js';
export { delegateServable, delegationExecutables } from './tools.js';
export {
  DELEGATION_BROKEN_WARNING,
  DELEGATION_MODEL_SELECTION_OFF_REASON,
  DELEGATION_TOOL_MISSING_REASON,
  readDelegationHealth,
  watchDelegationHealth
} from './delegation-health.js';
export type { DelegationHealth, DelegationHealthState, DelegationHealthWatch, DelegationHealthWatchOptions } from './delegation-health.js';
export {
  DELEGATION_ROW_ID,
  MODEL_SELECTION_FIELD,
  OWNERSHIP_MARKER,
  PROFILE_PATCH_FILENAME,
  enableHostModelSelection,
  inspectHostModelSelection,
  planModelSelectionEdit,
  resolveProfilePatchPath
} from './host-patch.js';
export type { HostPatchOutcome, HostPatchResult, PatchEditResult, PatchPathResolution } from './host-patch.js';
export { installModelRouting } from './routing.js';
export {
  ADAPTIVE_EFFORT_LEVELS,
  EFFORT_CHOICE_OPTIONS,
  EFFORT_LEVELS,
  EFFORT_TRIGGERS,
  EffortInterceptor,
  EffortStatusFeed,
  buildEffortChoice,
  classifyByCues,
  effortRank,
  formatEffortStatusLine,
  isAdaptiveEffortLevel,
  isEffortTrigger,
  levelOfChoiceOption,
  projectEffort,
  readEffortCues,
  snapEffort
} from './effort.js';
export { EFFORT_RECORD_TYPE, appendEffortRecord, effortRecordsOf, toEffortAuditRecord } from './session-audit.js';
export {
  EFFORT_INHERIT_RECORD_TYPE,
  appendEffortInheritRecord,
  effortInheritRecordsOf,
  isEffortInheritAuditRecord
} from './session-audit.js';
export type { EffortInheritAuditRecord } from './session-audit.js';
export {
  DELEGATION_EFFORT_REASON,
  currentSelectionOf,
  installDelegatedEffortInheritance,
  isDelegatedSession
} from './effort-delegation.js';
export type {
  DelegatedEffortInheritance,
  DelegatedEffortInheritanceOptions
} from './effort-delegation.js';
// Retrieval of a pruned original is a public API, not an internal detail: the guide
// tells a reader to import the function from the package root, so the root entry has
// to export it together with the two names a caller needs to use it — the record's
// own type, and the locator builder for the digest a decision record carries.
// Exporting it only from `session-audit.js` would leave the documented example
// unrunnable for an installed package.
export { PRUNED_ORIGINAL_RECORD_TYPE, pruneLocator, readPrunedOriginal } from './session-audit.js';
export type { PrunedOriginalRecord } from './session-audit.js';
export { ReflexVirtualAdapter } from './virtual-adapter.js';
export {
  ReflexRoutingError,
  VirtualModelRouter,
  alignReasoningEffort,
  formatTargetName,
  parseFallback,
  parseTargetName
} from './router.js';
export type {
  ReflexConfig,
  ReflexEffortConfig,
  ReflexRoutingConfig,
  ReflexSystemOneConfig,
  ResolvedEffortConfig,
  ResolvedReflexConfig,
  ResolvedRoutingConfig,
  ResolvedSystemOneConfig
} from './config.js';
export type { ReflexChoiceResult, ReflexLedgerResult, ReflexPruneResult } from './bridge.js';
export type { ReflexToolSuffix } from './tools.js';
export type { ModelRoutingInstallation, ModelRoutingOptions } from './routing.js';
export type {
  AdaptiveEffortLevel,
  EffortAgentFacts,
  EffortCues,
  EffortDecider,
  EffortDecision,
  EffortInterceptorOptions,
  EffortLevel,
  EffortOutcome,
  EffortRequestContext,
  EffortResolution,
  EffortSource,
  EffortTrigger,
  EffortTriggerKind,
  ReasoningEffortSetting,
  ReflexEffortStatus
} from './effort.js';
export type { EffortAuditRecord } from './session-audit.js';
export type { ReflexVirtualAdapterOptions } from './virtual-adapter.js';
export type {
  ModelPoolEntry,
  ModelPools,
  PhysicalTarget,
  ReasoningProbe,
  ReasoningSupport,
  RouteContext,
  RouteDecision,
  RoutingFailureCode,
  RoutingReason,
  VirtualModelRouterOptions
} from './router.js';

/** The registry reconciler of one activation. */
interface ToolSurfaceInstallation {
  /**
   * Make the registry answer for exactly the tools `config` enables.
   *
   * Idempotent: when the enabled suffixes and the prefix are unchanged, no
   * registration is touched. A prefix edit unregisters the old names *before*
   * registering the new ones — the registry refuses a name that is already
   * taken, and a caller still holding an old name then gets "unknown tool"
   * instead of silently reaching an old body.
   * @param config - the resolved configuration currently in force.
   */
  refresh(config: ResolvedReflexConfig): void;
  /** Republish the surface from the names this activation really owns. */
  publish(): void;
  /** How many tools this activation currently owns. */
  readonly registrationCount: number;
  /** How many `tools.register` calls this activation has made in total. */
  readonly registrationEvents: number;
  /** Unregister every owned tool; idempotent. */
  dispose(): void;
}

/**
 * Register this activation's reflex tools, and keep the registry in step with
 * config-only saves.
 *
 * The registry is process-wide, so it is not enough to resolve the config on
 * every save: the *registrations* have to change with it. This installer owns
 * those registrations (one disposer per currently-owned name) and reconciles
 * them only when the effective surface actually differs, which is what keeps a
 * same-value save from churning the registry.
 * @param ctx - registrant context carrying `tools`.
 * @param runtime - the activation's runtime, for the definitions and surface.
 * @returns the reconciler and its diagnostics.
 */
function installReflexToolSurface(ctx: Context, runtime: ReflexRuntime): ToolSurfaceInstallation {
  /** Unregister functions of the names this activation currently owns. */
  const owned = new Map<string, () => void>();
  let registrationEvents = 0;
  let disposed = false;

  // Resolved live from configuration only. The honest capability check cannot
  // happen here: this runs during `apply()`, where the plugin has no agent
  // scope, and `dsh-tools` is a *scoped* registry whose global view does not
  // contain a tool attached inside an agent preset — which is exactly where a
  // real deployment puts `tool-subagent`. Probing the global view at mount is
  // what made a correctly configured Host register nothing at all (g-054).
  // Whether the Host can carry a level is judged at call time, by the Host.
  const delegation = (): ReflexDelegationSeam | undefined =>
    createReflexDelegation({
      ctx,
      ledger: runtime.ledger,
      decide: (request) => runtime.choice(request),
      minConfidence: runtime.effort.minConfidence,
      warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message)
    });

  /**
   * Suffixes enabled by config *and* consented to by the operator.
   *
   * Registering the delegate is a **configuration** decision: `delegation.enabled`
   * is the consent that writes the Host's `modelSelection` switch, and once it is
   * given the wrapper is registered unconditionally. It deliberately does not
   * consult the registry — at this point in the lifecycle there is no agent scope
   * to read as, so any registry answer would describe a view no session uses.
   * `delegationExecutables` still withholds the target when consent is off, which
   * is the one gate registration keeps.
   */
  const executableSuffixes = (config: ResolvedReflexConfig): ReflexToolSuffix[] =>
    resolveReflexToolExecutables(
      enabledReflexToolSuffixes(config),
      delegationExecutables(config, DELEGATION_TOOL_NAME)
    );

  const publish = (): void => {
    // Vocabulary order, not registration order: the panel and the runtime
    // surface must not reshuffle just because a tool was toggled later.
    runtime.noteToolSurface(
      executableSuffixes(runtime.effectiveConfig)
        .map((suffix) => `${runtime.effectiveConfig.toolPrefix}${suffix}`)
        .filter((name) => owned.has(name) && ctx.tools.get(name) !== undefined)
    );
  };

  return {
    refresh(config: ResolvedReflexConfig): void {
      if (disposed) return;
      const wanted = new Set(
        executableSuffixes(config).map((suffix) => `${config.toolPrefix}${suffix}`)
      );
      // Remove first: a duplicate registration throws, and a prefix rename has
      // no name in common with the old surface. A name we still want but that
      // the registry no longer answers for is dropped too, so a stray removal
      // is repaired on the next commit instead of leaving a permanent hole.
      for (const [name, unregister] of [...owned]) {
        if (wanted.has(name) && ctx.tools.get(name) !== undefined) continue;
        owned.delete(name);
        unregister();
      }
      const seam = delegation();
      for (const definition of defineReflexTools(runtime, config, seam)) {
        if (!wanted.has(definition.name)) continue;
        if (owned.has(definition.name)) continue;
        try {
          owned.set(definition.name, ctx.tools.register(definition));
          registrationEvents += 1;
        } catch (error) {
          // A foreign registration of the same name is not ours to take over:
          // leave it absent and let the panel report the surface that is real.
          ctx.logger?.('dsh-reflex')?.warn(
            `dsh-reflex: tool "${definition.name}" could not be registered (${(error as Error).message})`
          );
        }
      }
      publish();
    },
    publish,
    get registrationCount(): number {
      return owned.size;
    },
    get registrationEvents(): number {
      return registrationEvents;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const unregister of [...owned.values()].reverse()) unregister();
      owned.clear();
    }
  };
}

/**
 * Cordis plugin entry point: register the reflex tool set for one activation.
 *
 * Returns nothing on purpose — Cordis interprets a plugin callback's return
 * value as an effect (a disposer, or an iterable/promise of disposers), so the
 * runtime is published through {@link applyReflex} instead.
 * @param ctx - registrant context carrying the tool and LLM services.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config?: ReflexConfig): void {
  applyReflex(ctx, config);
}

/**
 * Same activation as {@link apply}, but hands the caller the runtime it built.
 *
 * Useful for tests, diagnostics, and Hosts that want to audit the ledger
 * directly. The runtime is deliberately *not* registered as a context service:
 * one deployment may activate the plugin more than once (say, with different
 * tool prefixes), which a single fixed service name could not represent.
 * @param ctx - registrant context carrying the tool and LLM services.
 * @param config - deployment configuration; defaults are resolved here, so a
 *   raw or already-resolved config both work.
 * @returns the activation's runtime, disposed when the plugin unloads.
 */
export function applyReflex(ctx: Context, config?: ReflexConfig): ReflexRuntime {
  const resolved = resolveConfig(config);
  // `config` is kept as passed: when the Host is the Cordis loader it carries
  // schema-declared volatile references, and those are the only place a
  // config-only update (no remount) can be observed at all.
  const runtime = createReflexRuntime(resolved, {
    configSource: config,
    warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message)
  });
  installActualProjection(ctx);

  ctx.effect(() => {
    // The tool surface is owned by a reconciler rather than registered once:
    // the loader commits `tools.enabled`/`toolPrefix` changes into the running
    // activation without remounting it, and the registry is what the model
    // actually sees. `refresh` is called once per actual commit and never on
    // the step/tool hot path, so the tool schemas are still built once per
    // change rather than once per call.
    const tools = installReflexToolSurface(ctx, runtime);
    runtime.attachToolSurface(
      (next) => tools.refresh(next),
      () => tools.registrationCount,
      () => tools.registrationEvents
    );
    tools.refresh(resolved);

    // The Host capability the delegate needs is read from the live registry, so
    // a broken one is reported and warned about. The read is **scoped**: a preset
    // deployment attaches `tool-subagent` to an agent, not to the global view, so
    // reading globally would call a working Host "off" (g-054). Until an agent
    // registers here the reading is `unknown` — which the panel shows as "not
    // probed", never as a fault. It never writes a configuration file: a switch
    // that went off might be a person's own decision, and turning it back on is
    // theirs to make.
    //
    // Registration is *not* a reaction of this watch any more (see
    // `executableSuffixes`): a tool must not appear or vanish because a scope
    // happened to become readable. The watch only reports.
    let observedAgent: Agent | undefined;
    const readHealth = (): DelegationHealth => readDelegationHealth(ctx, observedAgent);
    const delegationHealth = watchDelegationHealth({
      read: readHealth,
      warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message),
      onChange: () => {
        if (runtime.disposed) return;
        tools.publish();
      }
    });
    runtime.attachDelegationHealth(
      () => delegationHealth.health,
      () => {
        tools.refresh(runtime.effectiveConfig);
      }
    );

    // No listener is installed for the tool registry: the reading is taken on
    // the panel's own poll (see `panel-mount.ts`), with whatever agent scope is
    // known by then. Re-reading on every registry change proved nothing — the
    // global view cannot resolve a preset-hosted tool — and cost a probe per
    // change.
    runtime.attachDelegationScope((agent) => {
      observedAgent = agent;
      // A new scope is a genuinely new view, so the reading is taken again in it.
      delegationHealth.check();
    });

    // A config-only settings save does not remount this plugin: the loader
    // commits the new values into the volatile references and dispatches this
    // event to the owning fiber. Re-resolving here makes the edited routing,
    // effort, intervention, and tool policies effective on the next
    // request/tool call instead of after a restart.
    const stopConfigWatch = ctx.on('loader/volatile-update', () => {
      if (runtime.disposed) return;
      runtime.refresh();
    });

    // The registry is process-wide, so the published surface is re-derived on
    // every change instead of assumed static.
    const stopObserving = ctx.on('tools/change', () => {
      if (runtime.disposed) return;
      // The published surface is re-derived, not the delegation *reading*: the
      // registry's global view cannot resolve a preset-hosted delegation tool, so
      // a probe on every change would only ever answer "unknown" — and an
      // "unknown" that triggered a refresh would be churn without information.
      tools.publish();
    });

    const stopRouting = installRouting(ctx, runtime);
    // A delegated agent cannot decide its own effort: the loop fixes the step's
    // selection before the request waterfall, so the marker is replaced with the
    // parent's level *on the selection itself* — before the next step reads it.
    const inheritance = installDelegatedEffortInheritance(ctx, {
      enabled: () => runtime.effort.enabled,
      sessionById: (id) => (ctx as any).sessions?.get?.(id),
      warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message)
    });
    runtime.attachEffortInheritance(inheritance);
    // The ledger is an audit question a person asks, not a decision the model
    // makes, so it is a Host command instead of a tool: `/reflex-ledger` reads
    // the same runtime and never opens a turn.
    const unregisterLedger = installLedgerCommand(ctx, runtime);
    // The automatic half of the plugin: the same System 1 judgments, spent at the
    // Host's own hook points instead of waiting for the model to call a tool. The
    // installer registers nothing when every capability is `off`, so an inactive
    // deployment pays for no listener and no state.
    const interventions = installInterventions(ctx, {
      config: resolved.interventions,
      pruneThreshold: resolved.pruneThreshold,
      // The tools of this plugin are already the optimizer's own output: judging
      // them again would spend a second judgment on the same payload.
      ownTools: reflexToolNames(resolved),
      stagnation: runtime.stagnationService,
      prune: runtime.pruneService,
      gate: runtime.gateService,
      // Every judgment this engine spends is attributed like a tool call: the
      // ledger records the connection, the requested model and the source, so a
      // decision made at a Host hook point is no longer anonymous (g-068).
      attribute: (run, options) => runtime.attribute(run, options),
      audit: (record, session) => {
        // The session log is the one place a decision is durable; an agent without
        // a session simply records nothing, which is why this is guarded.
        if (session) appendInterventionRecord(session, record);
      },
      // Pruning is only allowed to replace a result when the original has really
      // been retained in a place that survives the replacement. The session log is
      // that place: a plugin record is ignorable by the model, carried by resume
      // and fork, and readable back — which the retention verifies before it
      // reports a locator. No verified retention, no reduction.
      retain: (session, request) => appendPrunedOriginal(session, request)
    });
    runtime.attachInterventions(
      interventions.engine,
      (next, pruneThreshold) => {
        // The prefix may have changed in the same commit: the engine's own-tool
        // exemption must name the tools that are registered *now*.
        interventions.reconfigure(next, pruneThreshold, reflexToolNames(runtime.effectiveConfig));
      },
      () => interventions.listenerCount
    );
    const unmountPanel = mountReflexPanel(ctx, runtime);

    const injectSettings = (ctx as { inject?: (deps: string[], cb: (scope: any) => void) => void }).inject;
    if (typeof injectSettings === 'function') {
      injectSettings(['settings'], (sctx) => {
        const svc = sctx?.settings;
        if (typeof svc?.configure === 'function') {
          sctx.effect(() => svc.configure({ auto: false }, (ctx as any).fiber));
        }
      });
    }

    return () => {
      stopConfigWatch();
      stopObserving();
      stopRouting();
      inheritance.dispose();
      unregisterLedger();
      interventions.dispose();
      unmountPanel();
      tools.dispose();
      runtime.dispose();
    };
  }, 'reflex tools');

  return runtime;
}

/**
 * Install the request interception layers of this activation.
 *
 * The listeners are installed whenever the LLM service is present, because the
 * adaptive-effort layer is not tied to a virtual route: a deployment may enable
 * per-turn effort while routing is off, and a request may carry the `reflex`
 * marker on its own. Registering the virtual *route* stays opt-in — without a
 * single non-empty candidate pool (or with `routing.enabled: false`) nothing is
 * registered, so a `reflex` selection can never silently resolve to an
 * unconfigured provider. The absence of the LLM service is tolerated as well:
 * `inject` makes the Host wait for it, and this guard keeps direct embedders
 * (tests, `applyReflex` callers) working without one.
 * @param ctx - registrant context.
 * @param runtime - the activation's runtime.
 * @returns a disposer that releases the route and its listeners.
 */
function installRouting(ctx: Context, runtime: ReflexRuntime): () => void {
  const llm = (ctx as { llm?: LlmRuntime }).llm;
  if (!llm) {
    ctx.logger?.('dsh-reflex')?.warn('LLM service is unavailable; request interception stays off for this activation');
    return () => {};
  }

  const installation = installModelRouting(ctx, {
    llm,
    router: runtime.modelRouter,
    effort: runtime.effort,
    route: routingActive(runtime.effectiveConfig),
    // Both are getters: a config-only save changes `maxTaskChars` and the router
    // provider between steps, and the next step must see the new value without
    // re-resolving the schema.
    maxTaskChars: () => runtime.effectiveConfig.routing.maxTaskChars,
    liveRouting: () => {
      const routing = runtime.effectiveConfig.routing;
      return {
        enabled: routing.enabled,
        virtualProvider: routing.virtualProvider,
        maxTaskChars: routing.maxTaskChars,
        models: routing.models
      };
    },
    // Live config, pulled once per step: identity comparison, no schema run
    // unless the loader actually committed a change.
    refreshConfig: () => runtime.refreshIfChanged(),
    warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message)
  });
  // A second activation of this plugin joins the process-wide route; its live
  // policy is then the shared router's, so the panel and the dispatch path of
  // this activation must both read that one.
  runtime.adoptModelRouter(installation.router);
  // A config-only save can enable/disable the route or rename the virtual
  // provider. The registration lives on the LLM runtime, so the runtime calls
  // back here once per actual commit; the reconciler is idempotent.
  runtime.attachRouting(
    (routing) => {
      installation.refresh(routing);
      runtime.adoptModelRouter(installation.router);
    },
    () => installation.registrationEvents
  );

  return () => installation.dispose();
}
