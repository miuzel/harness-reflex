import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';

import { Config, resolveConfig, resolveEffortSetting, resolveApiKey, resolveSystemOneConfig, resolveToolsConfig, routingActive, volatileSnapshots, type ReflexConfig, type ResolvedReflexConfig } from './config.js';
import { createReflexRuntime, type ReflexRuntime } from './bridge.js';
import { installModelRouting } from './routing.js';
import { defineReflexTools, enabledReflexToolSuffixes, reflexToolNames } from './tools.js';
import { installLedgerCommand } from './command.js';
import { mountReflexPanel } from './panel-mount.js';
import { installInterventions } from './interventions.js';
import { appendInterventionRecord, appendPrunedOriginal } from './session-audit.js';
import { installActualProjection } from './actual-projection.js';

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

export { Config, resolveConfig, resolveEffortSetting, resolveApiKey, resolveSystemOneConfig, resolveToolsConfig, routingActive, volatileSnapshots, createReflexRuntime, defineReflexTools, enabledReflexToolSuffixes, reflexToolNames };
export type { ReflexToolsConfig, ResolvedToolsConfig } from './config.js';
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

  const publish = (): void => {
    // Vocabulary order, not registration order: the panel and the runtime
    // surface must not reshuffle just because a tool was toggled later.
    runtime.noteToolSurface(
      reflexToolNames(runtime.effectiveConfig).filter((name) => owned.has(name) && ctx.tools.get(name) !== undefined)
    );
  };

  return {
    refresh(config: ResolvedReflexConfig): void {
      if (disposed) return;
      const desired = reflexToolNames(config);
      const wanted = new Set(desired);
      // Remove first: a duplicate registration throws, and a prefix rename has
      // no name in common with the old surface. A name we still want but that
      // the registry no longer answers for is dropped too, so a stray removal
      // is repaired on the next commit instead of leaving a permanent hole.
      for (const [name, unregister] of [...owned]) {
        if (wanted.has(name) && ctx.tools.get(name) !== undefined) continue;
        owned.delete(name);
        unregister();
      }
      for (const definition of defineReflexTools(runtime, config)) {
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
      tools.publish();
    });

    const stopRouting = installRouting(ctx, runtime, resolved.routing.maxTaskChars);
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
 * @param maxTaskChars - task-text budget captured from `agent/pre-step`.
 * @returns a disposer that releases the route and its listeners.
 */
function installRouting(ctx: Context, runtime: ReflexRuntime, maxTaskChars: number): () => void {
  const llm = (ctx as { llm?: LlmRuntime }).llm;
  if (!llm) {
    ctx.logger?.('dsh-reflex')?.warn('LLM service is unavailable; request interception stays off for this activation');
    return () => {};
  }

  const installation = installModelRouting(ctx, {
    llm,
    router: runtime.modelRouter,
    effort: runtime.effort,
    route: routingActive(runtime.config),
    maxTaskChars,
    // Live config, pulled once per step: identity comparison, no schema run
    // unless the loader actually committed a change.
    refreshConfig: () => runtime.refreshIfChanged(),
    warn: (message) => ctx.logger?.('dsh-reflex')?.warn(message)
  });
  // A second activation of this plugin joins the process-wide route; its live
  // policy is then the shared router's, so the panel and the dispatch path of
  // this activation must both read that one.
  runtime.adoptModelRouter(installation.router);

  return () => installation.dispose();
}
