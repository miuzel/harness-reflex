import { AsyncLocalStorage } from 'node:async_hooks';

import type { Agent } from '@deepseek-ai/dsh-agent';

import {
  Calibrator,
  DecisionLedger,
  JevDecisionBackend,
  MockDecisionBackend,
  ReflexGateService,
  ReflexRouter,
  ReflexScreenService,
  SimpleJevDecisionBackend,
  StagnationDetector,
  ToolResultPruner,
  scoreStatement
} from './vendor/harness-reflex/index.js';
import type {
  ActionStep,
  BackendHealth,
  CandidateItem,
  ChoiceResponse,
  DecisionBackend,
  GateResponse,
  PruneResponse,
  RouteResponse,
  ScreenResult,
  StagnationCheckResponse
} from './vendor/harness-reflex/index.js';

import type {
  ReflexConfig,
  ResolvedInterventionsConfig,
  ResolvedReflexConfig,
  ResolvedRoutingConfig,
  ResolvedSystemOneConfig,
  ResolvedToolsConfig
} from './config.js';
import { connectionImplementation, resolveApiKeyWithSource, resolvedKeyOf, resolveConfig, volatileSnapshots } from './config.js';
import { EffortInterceptor, EffortStatusFeed, type ReflexEffortStatus } from './effort.js';
import type { DelegatedEffortInheritance } from './effort-delegation.js';
import type { DelegationHealth } from './delegation-health.js';
import type { InterventionEngine } from './interventions.js';
import { UnconfiguredBackend } from './unconfigured-backend.js';
import { VirtualModelRouter } from './router.js';
import {
  attributionOf,
  callIdentity,
  classifyEvidence,
  ledgerAttribution,
  MOCK_CONNECTION_NAME,
  UNCONFIGURED_CONNECTION_NAME,
  type Attribution,
  type CallIdentity,
  type CallSource,
  type SourceEvidence
} from './attribution.js';

/**
 * What one dispatch observed about itself.
 *
 * `identity` is taken *before* the call is awaited (see {@link callIdentity}),
 * so a profile switch during an in-flight call cannot restate it; `source` is
 * filled once the call settles. The pair travels together into the tool payload
 * and the ledger entry, which is what keeps the two surfaces agreeing.
 */
interface DispatchOutcome {
  readonly identity: CallIdentity;
  readonly source: CallSource;
  readonly detail?: string;
}

/** Payload of the `choice` operation, mirroring the stdio MCP surface. */
export type ReflexChoiceResult = ChoiceResponse & { calibratedConfidence?: number } & Attribution;

/** Payload of the `prune` operation, mirroring the stdio MCP surface. */
export interface ReflexPruneResult extends Attribution {
  tokensSaved: number;
  reductionPercentage: string;
  shadow: boolean;
  processedOutput: string;
}

/** Payload of the ledger read, mirroring the stdio MCP `status_ledger` payload. */
export interface ReflexLedgerResult {
  summary: ReturnType<DecisionLedger['getSummary']>;
  recentEntries?: ReturnType<DecisionLedger['getEntries']>;
  /**
   * Health of the backend at read time, when it tracks one.
   *
   * `/reflex-ledger` prints a degraded notice from it. It is deliberately not
   * part of any model-facing tool payload: a health warning is a diagnostics
   * fact for the person reading the command, not context for the agent.
   */
  systemOneHealth?: BackendHealth;
}

/**
 * A decision backend whose implementation can be swapped while services keep
 * their reference to it.
 *
 * The five decision services are built once and close over their backend. A
 * config-only save can change `backend`/`systemOne.*`, and rebuilding those
 * services would drop their ledger/audit wiring; delegating through one stable
 * object swaps the transport instead, so the next decision reaches the new
 * endpoint/model while the services stay put. Health is the delegate's, so a
 * freshly built backend starts at `available: true, consecutiveFailures: 0`.
 */
class LiveBackend {
  #target: DecisionBackend;

  constructor(target: DecisionBackend) {
    this.#target = target;
  }

  /** Name of the backend implementation currently in force. */
  get name(): string {
    return this.#target.name;
  }

  /** Model id of the backend implementation currently in force. */
  get model(): string {
    return this.#target.model;
  }

  /** Replace the transport, releasing the previous one. */
  swap(next: DecisionBackend): void {
    const previous = this.#target;
    this.#target = next;
    const dispose = (previous as { dispose?: () => void }).dispose;
    if (typeof dispose === 'function') {
      try {
        dispose.call(previous);
      } catch {
        // A backend that cannot release its transport must not veto the swap.
      }
    }
  }

  choice(request: Parameters<DecisionBackend['choice']>[0]): ReturnType<DecisionBackend['choice']> {
    return this.#target.choice(request);
  }

  gate(request: Parameters<DecisionBackend['gate']>[0]): ReturnType<DecisionBackend['gate']> {
    return this.#target.gate(request);
  }

  prune(request: Parameters<DecisionBackend['prune']>[0]): ReturnType<DecisionBackend['prune']> {
    return this.#target.prune(request);
  }

  checkStagnation(request: Parameters<DecisionBackend['checkStagnation']>[0]): ReturnType<DecisionBackend['checkStagnation']> {
    return this.#target.checkStagnation(request);
  }

  route(request: Parameters<DecisionBackend['route']>[0]): ReturnType<DecisionBackend['route']> {
    return this.#target.route(request);
  }

  classifyClaims(request: Parameters<DecisionBackend['classifyClaims']>[0]): ReturnType<DecisionBackend['classifyClaims']> {
    return this.#target.classifyClaims(request);
  }

  /** Health of the backend currently in force (absent for in-process backends). */
  currentHealth(): BackendHealth | undefined {
    const health = (this.#target as Partial<DecisionBackend>).health;
    return typeof health === 'function' ? health.call(this.#target) : undefined;
  }
}

/**
 * The slice of {@link DecisionLedger} a decision service uses.
 *
 * Declared structurally so this decorator never pretends to be the ledger: the
 * services only ever call `record`, and the runtime keeps the real ledger for
 * every other read.
 */
type LedgerSink = Pick<DecisionLedger, 'record'>;

/**
 * One call's held ledger entry: what the service built, plus its identity.
 *
 * Held rather than written, because the *source* of an answer is not knowable
 * until the answer settles (see {@link AttributedLedger}).
 */
interface HeldEntry {
  readonly entry: Parameters<DecisionLedger['record']>[0];
  readonly identity: CallIdentity;
}

/**
 * One already-attributed call, for callers that drive a decision service
 * themselves instead of going through {@link ReflexRuntime.choice} and friends.
 *
 * `ledger` is the call's private buffer; `settle` appends it once the source is
 * known and returns the attribution to put on the caller's own payload.
 */
export interface CallRing {
  /** The ledger ring this call's service entries are buffered in. */
  readonly ledger: LedgerSink;
  /**
   * Close the ring: append its entries with the final source.
   * @param outcome - the settled source.
   * @returns the attribution for the caller's payload.
   */
  settle(outcome: { source: CallSource; detail?: string }): Attribution;
}

/**
 * The attributed, append-only ledger sink every decision service writes through.
 *
 * ## Why a decorator rather than fields on the entry (g-068)
 *
 * `ReflexGateService`, `ReflexRouter`, `ToolResultPruner` and the rest write
 * their *own* ledger entry while they run, and that entry is the one a reader
 * sees. `DecisionLedger` is shared with the root stdio MCP package, whose
 * contract g-068 must not touch, so this layer keeps the provenance inside the
 * entry's existing open `details` bag instead of adding fields to it.
 *
 * ## Per-call isolation (the att-001 review's BLOCK-1)
 *
 * The first attempt kept **one** "current stamp" field and cleared it in a
 * `finally`. Two overlapping calls then destroyed each other's attribution: the
 * fast call's clear wiped the slow call's stamp, the slow call's service entry
 * was written unattributed, and its payload still said `local-fallback`. The
 * ledger and the payload disagreed about the same call, which is the exact
 * falsehood this goal exists to remove. There is no single shared field any
 * more: {@link open} returns a *token*, a service's entry is held in a buffer
 * **owned by that token**, and nothing a concurrent call does can reach it.
 *
 * ## Written once, finished, never rewritten (BLOCK-2)
 *
 * A service writes its entry *before* the answer settles, when `source` is still
 * unknown. Stamp-then-rewrite-the-last-JSONL-line was the first attempt's answer
 * to that, and it was wrong twice over: it rewrote a line that might belong to
 * another call, and rewriting a whole file is an append-only violation that can
 * truncate a sink another writer is appending to. Here the service's entry is
 * **buffered** on its token; when the call settles, {@link finish} appends that
 * one entry exactly once — identity *and* source together, already final. An
 * unregistered token (a call that threw before settling) falls back to the
 * buffered group in {@link flush}, so no entry is ever lost. The JSONL file is
 * therefore only ever appended to: no line is rewritten and no line is moved.
 *
 * ## Why attribution can honestly be `unknown`
 *
 * A call whose outcome cannot be proven must say so rather than claim `remote`.
 * Two paths reach that state and both end up here: a backend that exposes no
 * failure record at all (the vLLM logits backend) and a call whose service entry
 * was written after the call had already settled ({@link AttributedLedger.report}
 * explains how). See {@link classifyEvidence}.
 */
export class AttributedLedger {
  /** Open calls: the identity each token was opened with, and the entries it holds. */
  readonly #openCalls = new Map<number, { identity: CallIdentity; held: HeldEntry[] }>();
  /** Call tokens in dispatch order; settled calls are removed as they finish. */
  readonly #settleOrder: number[] = [];
  /** Entries a service wrote while no call was open, if any. */
  #unattributed: Array<Parameters<DecisionLedger['record']>[0]> = [];
  #nextToken = 0;
  /** Set when a call settled while its own entry was still unaccounted for. */
  #aCallLandedLate = false;

  /**
   * @param target - the activation's real ledger sink.
   */
  constructor(private readonly target: LedgerSink) {}

  /**
   * Open one call's ledger context.
   * @param identity - the identity taken at dispatch, before the call is awaited.
   * @returns the token to settle the call with, and the sink its services write through.
   */
  open(identity: CallIdentity): { token: number; ledger: LedgerSink } {
    const token = this.#nextToken;
    this.#nextToken += 1;
    this.#openCalls.set(token, { identity, held: [] });
    this.#settleOrder.push(token);
    return { token, ledger: this.#sinkFor(token) };
  }

  /**
   * The sink one call's services write through.
   *
   * A token that is no longer open (only a service writing *after* its own call
   * settled can hit this) buffers into the shared group that {@link flush}
   * settles as `unknown`, rather than being dropped.
   * @param token - the call's token.
   * @returns the sink to hand a decision service.
   */
  #sinkFor(token: number): LedgerSink {
    return {
      record: (entry) => {
        const call = this.#openCalls.get(token);
        if (call !== undefined) {
          // Buffered, not written: the same object is appended once the call
          // settles, so the entry a reader sees is final the first time.
          call.held.push({ entry, identity: call.identity });
        } else {
          this.#unattributed.push(entry);
        }
        // The service owns this return value only to log it; the entry it will
        // actually be read from is the one appended at settlement.
        return { ...entry, id: '', timestamp: '' } as ReturnType<DecisionLedger['record']>;
      }
    };
  }

  /**
   * The sink a service writes through when no call is in force.
   *
   * A service driven directly — the automatic-intervention engine, a
   * programmatic caller, a test — has no dispatch context to attribute it to.
   * Its entry is appended **immediately** (dropping it would lose an audited
   * judgment) with the source the service itself reported when it reported one
   * (a `systemOneSource`-style field on the entry), and `unknown` otherwise. It is
   * never left to read as a remote success.
   * @param token - the identity-less call id, for logging only.
   * @returns the unattributed sink.
   */
  unattributedSink(): LedgerSink {
    return {
      record: (entry) => {
        // A service may have been given its provenance by a caller that knew it
        // (the intervention engine attributes the call itself). Honour that;
        // otherwise say plainly that nothing proves where the answer came from.
        const claimed = typeof entry.details?.systemOneSource === 'string';
        this.target.record({
          ...entry,
          details: {
            ...entry.details,
            ...(claimed
              ? {}
              : ledgerAttribution({
                  connectionName: 'unknown',
                  requestedModel: null,
                  source: 'unknown',
                  detail: 'the entry was written outside the call it belongs to'
                }))
          }
        } as typeof entry);
        return { ...entry, id: '', timestamp: '' } as ReturnType<DecisionLedger['record']>;
      }
    };
  }

  /** Close one token's context, returning what it held. */
  #close(token: number): HeldEntry[] {
    const call = this.#openCalls.get(token);
    this.#openCalls.delete(token);
    const at = this.#settleOrder.indexOf(token);
    if (at !== -1) this.#settleOrder.splice(at, 1);
    return call?.held ?? [];
  }

  /**
   * Append what one call held, once, with the final source.
   *
   * The source is written into `details` here — the last moment it is knowable
   * and the only moment anything is persisted — so no line is ever rewritten.
   * @param token - the call's token.
   * @param outcome - the settled outcome, source included.
   * @returns how many entries this call appended.
   */
  finish(token: number, outcome: DispatchOutcome): number {
    const held = this.#close(token);
    const fields = ledgerAttribution(attributionOf(outcome.identity, outcome));
    for (const item of held) {
      this.target.record({ ...item.entry, details: { ...item.entry.details, ...fields } } as typeof item.entry);
    }
    // A service that wrote only after its call settled left its entry in the
    // shared group, where it cannot be told apart from another call's. Flag the
    // settlement so the runtime can withdraw the claim it would otherwise make.
    if (held.length === 0 && this.#unattributed.length > 0) this.#aCallLandedLate = true;
    return held.length;
  }

  /**
   * Append what one call held, with a source that could not be verified.
   * @param token - the call's token.
   * @returns how many entries this call appended.
   */
  finishUnknown(token: number): number {
    const held = this.#close(token);
    const fields = ledgerAttribution({
      connectionName: 'unknown',
      requestedModel: null,
      source: 'unknown',
      detail: 'the call did not settle, so where its answer came from is unproven'
    });
    for (const item of held) {
      this.target.record({
        ...item.entry,
        details: { ...item.entry.details, ...fields, systemOneConnection: item.identity.connectionName, systemOneModel: item.identity.requestedModel }
      } as typeof item.entry);
    }
    return held.length;
  }

  /**
   * Append entries that were written while no call was open.
   *
   * They cannot be attributed to a call, so they are marked `unknown` rather
   * than left to read as a remote success.
   * @returns whether any entry was appended.
   */
  flush(): boolean {
    const pending = this.#unattributed;
    this.#unattributed = [];
    for (const entry of pending) {
      const already = typeof entry.details?.systemOneSource === 'string';
      this.target.record({
        ...entry,
        details: {
          ...entry.details,
          ...(already
            ? {}
            : ledgerAttribution({
                connectionName: 'unknown',
                requestedModel: null,
                source: 'unknown',
                detail: 'the entry was written outside the call it belongs to'
              }))
        }
      } as typeof entry);
    }
    return pending.length > 0;
  }

  /**
   * Take, once, whether a settled call could not be tied to its own entry.
   * @returns `true` when the last settlement landed late.
   */
  takeLateCall(): boolean {
    const late = this.#aCallLandedLate;
    this.#aCallLandedLate = false;
    return late;
  }
}

/**
 * In-process System One runtime shared by every reflex tool of one plugin
 * activation.
 *
 * The bridge owns the backend, the audit ledger, and the five decision services,
 * so a plugin reload builds a fresh runtime and drops the previous one whole —
 * no module-level singleton is mutated and nothing survives the activation.
 */
export class ReflexRuntime {
  readonly config: ResolvedReflexConfig;
  readonly backend: DecisionBackend;
  readonly ledger: DecisionLedger;
  readonly calibrator: Calibrator;
  readonly gateService: ReflexGateService;
  readonly pruneService: ToolResultPruner;
  readonly stagnationService: StagnationDetector;
  readonly routeService: ReflexRouter;
  readonly screenService: ReflexScreenService;
  /**
   * System 1 virtual→physical model router this activation routes through. It
   * owns the configured pools and writes one `model-route` ledger entry per
   * decision; the plugin installs it on the LLM runtime and dispatches through
   * it. With several live activations the process-wide route has one shared
   * router, and {@link adoptModelRouter} points this runtime at it.
   */
  #modelRouter: VirtualModelRouter;
  /**
   * Per-turn adaptive reasoning-effort policy. It writes one `effort-decision`
   * ledger entry per decided turn and publishes each decision to
   * {@link effortStatusFeed}.
   */
  readonly effort: EffortInterceptor;
  /** Status-bar surface of the adaptive effort decisions of this activation. */
  readonly effortStatusFeed: EffortStatusFeed;
  /**
   * Delegated-agent effort inheritance, when this activation installed one.
   *
   * A delegated agent cannot decide its own effort, so the marker is replaced on
   * its `model/selection` before the step reads it. Held here so the panel and
   * diagnostics can report how often that happened.
   */
  #effortInheritance?: DelegatedEffortInheritance;

  #disposed = false;
  #surface: readonly string[] = [];
  /** Reads the live delegation capability; set by the plugin lifecycle. */
  #delegationHealth?: () => DelegationHealth;
  /** Records the agent scope the delegation capability is read in. */
  #noteDelegationScope?: (agent: Agent) => void;
  #interventions?: InterventionEngine;
  /**
   * The config the Host resolved for this activation, kept as it was passed in.
   *
   * With the Cordis loader this object holds schema-declared *volatile
   * references*: a config-only update mutates those references in place and
   * dispatches `loader/volatile-update` instead of remounting the plugin, so
   * this is the only handle that sees the new values. A programmatic caller
   * passes a plain object, in which case there is nothing to watch.
   */
  readonly #source: unknown;
  /** Snapshot identities of {@link #source} at the last applied refresh. */
  #mark: unknown[] = [];
  /** Re-entrancy guard: callbacks during one apply must not resolve again. */
  #refreshing = false;
  /** Whether {@link #source} actually exposes volatile references. */
  readonly #watchable: boolean;
  #warn: (message: string) => void;
  /**
   * The intervention policy currently in force.
   *
   * Kept even when the engine is inert (`mode: off`), so the panel reports the
   * authored block rather than the activation-time snapshot, and so turning a
   * capability back on can install its listeners without a remount.
   */
  #interventionsConfig: ResolvedInterventionsConfig;
  /** The prune threshold currently in force (top-level `pruneThreshold`). */
  #pruneThreshold: number;
  /**
   * The per-tool switches and deployment prefix currently in force.
   *
   * Kept here rather than read from {@link config} because a config-only save
   * never remounts the activation: the registry has to follow the committed
   * values, and the panel has to report the same ones.
   */
  #toolsConfig: ResolvedToolsConfig;
  #toolPrefix: string;
  /**
   * The delegation consent currently in force.
   *
   * A config-only save commits this without remounting the activation, and both
   * the registry and the panel must follow it: reading the startup snapshot here
   * would keep registering (or withholding) `reflex_delegate` after the user
   * ticked the switch.
   */
  #delegationConfig: ResolvedReflexConfig['delegation'];
  /** Applies a freshly resolved intervention policy to the installed listeners. */
  #reconfigureInterventions?: (config: ResolvedInterventionsConfig, pruneThreshold: number) => void;
  /** Reads how many intervention listeners are currently attached. */
  #interventionListenerCount?: () => number;
  /** Reconciles the registered tool set with a freshly resolved config. */
  #reconfigureTools?: (config: ResolvedReflexConfig) => void;
  /** Re-reads the Host delegation capability and reconciles the surface. */
  #refreshDelegation?: () => void;
  /** Reads how many tools this activation currently has registered. */
  #toolRegistrationCount?: () => number;
  /** Reads how many `tools.register` calls this activation has made in total. */
  #toolRegistrationEvents?: () => number;
  /** Full schema resolutions performed by this activation (diagnostics/measurement). */
  #configResolves = 0;

  /** The stable delegate all decision services dispatch through. */
  readonly #liveBackend: LiveBackend;
  /**
   * Ledger the whole activation writes through, so an entry a service owns
   * carries the provenance of the call that produced it and is appended once
   * (see {@link AttributedLedger}).
   */
  readonly #attributed: AttributedLedger;
  /**
   * Per-call sinks handed to the shared decision services.
   *
   * The decision services are long-lived and write their own ledger entry, but
   * the call they are serving is per-dispatch. Each dispatch runs its services
   * inside its own {@link #callScope}, so the sink below resolves to *that*
   * call's buffer. This is why no shared "current stamp" field exists: a
   * concurrent call cannot see, let alone clear, another call's context.
   */
  readonly tracking: { gate: LedgerSink; prune: LedgerSink; stagnation: LedgerSink; route: LedgerSink; screen: LedgerSink } = {
    gate: { record: (entry) => this.#recordForCurrentCall(entry) },
    prune: { record: (entry) => this.#recordForCurrentCall(entry) },
    stagnation: { record: (entry) => this.#recordForCurrentCall(entry) },
    route: { record: (entry) => this.#recordForCurrentCall(entry) },
    screen: { record: (entry) => this.#recordForCurrentCall(entry) }
  };

  /** The dispatch context in force, so a service's `record` finds its own call. */
  readonly #callScope = new AsyncLocalStorage<{ sink: LedgerSink }>();

  /**
   * Route one service entry to the call whose context is in force.
   *
   * Falls back to the unattributed group (settled as `unknown`, never dropped)
   * when a service writes outside any dispatch — that only happens for a
   * programmatic caller driving a service directly.
   * @param entry - the entry the service built.
   * @returns the record result the service expects.
   */
  #recordForCurrentCall(entry: Parameters<DecisionLedger['record']>[0]): ReturnType<DecisionLedger['record']> {
    return (this.#callScope.getStore()?.sink ?? this.#attributed.unattributedSink()).record(entry);
  }

  /**
   * Hand a decision service an already-attributed payload.
   *
   * The automatic intervention layer ({@link InterventionEngine}) drives the
   * same services directly at Host hook points, so those calls never reach
   * {@link #dispatch}. They still spend a System One judgment, and the goal
   * requires every such call to be attributed — an entry the ledger cannot name
   * is exactly the opacity g-068 removes.
   *
   * The returned ring is the call's own ledger token: the caller wraps the
   * service call in {@link runInCall}, then reports the outcome through
   * `settle` when the answer arrives, which is when the source first exists.
   * @returns the ring for the call about to be made.
   */
  openCall(): CallRing {
    const identity = this.currentCallIdentity();
    const { token, ledger } = this.#attributed.open(identity);
    return {
      ledger,
      settle: (outcome) => this.#settleCall(token, identity, outcome)
    };
  }

  /**
   * Run one call inside its own ledger ring.
   * @param ring - the ring from {@link openCall}.
   * @param run - the work to run with that ring in force.
   * @returns whatever `run` returns.
   */
  runInCall<T>(ring: CallRing, run: () => Promise<T>): Promise<T> {
    return this.#callScope.run({ sink: ring.ledger }, run);
  }
  /** Whether this runtime owns the backend and may rebuild it on a config save. */
  readonly #backendSwappable: boolean;
  /** Identity of the backend configuration currently in force. */
  #backendSignature: string;
  /** System One connection settings currently in force (panel/diagnostics). */
  #systemOneConfig: ResolvedSystemOneConfig;
  /** Backend selector currently in force (panel/diagnostics). */
  #backendSelector: ResolvedReflexConfig['backend'];
  /** Ledger sink currently in force. */
  #ledgerPath?: string;
  /** Routing policy currently in force (provider lifecycle is reconciled live). */
  #routingConfig: ResolvedRoutingConfig;
  /** Applies routing lifecycle changes (enable/disable, provider rename) live. */
  #reconfigureRouting?: (routing: ResolvedRoutingConfig) => void;
  /** Reads how many provider registrations this activation made in total. */
  #routingRegistrationEvents?: () => number;
  /** Backend rebuilds performed by this activation (diagnostics/measurement). */
  #backendRebuilds = 0;
  /** Ledger sink switches performed by this activation. */
  #ledgerSwitches = 0;

  /**
   * @param config - resolved plugin configuration.
   * @param dependencies - test seams for the ledger, backend, and routing clock,
   *   plus the raw config (whose volatile references carry live updates) and a
   *   diagnostic sink.
   */
  constructor(
    config: ResolvedReflexConfig,
    dependencies: {
      backend?: DecisionBackend;
      ledger?: DecisionLedger;
      now?: () => number;
      configSource?: unknown;
      warn?: (message: string) => void;
    } = {}
  ) {
    this.config = config;
    // One stable delegate: the services below close over it, and a config save
    // swaps the transport inside it instead of rebuilding them.
    this.#liveBackend = new LiveBackend(dependencies.backend ?? createBackend(config));
    this.#backendSwappable = dependencies.backend === undefined;
    this.#backendSignature = backendSignature(config);
    this.backend = this.#liveBackend as unknown as DecisionBackend;
    this.ledger = dependencies.ledger ?? new DecisionLedger(config.ledgerPath ?? null);
    this.#systemOneConfig = config.systemOne;
    this.#backendSelector = config.backend;
    this.#ledgerPath = config.ledgerPath;
    this.#routingConfig = config.routing;
    this.calibrator = config.calibrationPath ? new Calibrator(config.calibrationPath) : new Calibrator();
    // Services that write their own ledger entry go through the attributed
    // ledger, so the entry they own carries the same provenance the payload
    // reports — with a source that is only written once it is knowable.
    this.#attributed = new AttributedLedger(this.ledger);
    // The services are typed against the whole ledger but only ever call
    // `record`; the cast keeps that one-method contract honest while the
    // attributed sink does the bookkeeping behind it.
    const sinkOf = (sink: LedgerSink): DecisionLedger => sink as unknown as DecisionLedger;
    this.gateService = new ReflexGateService(this.backend, sinkOf(this.tracking.gate), this.calibrator);
    this.pruneService = new ToolResultPruner(this.backend, sinkOf(this.tracking.prune), config.pruneThreshold);
    this.stagnationService = new StagnationDetector(this.backend, sinkOf(this.tracking.stagnation));
    this.routeService = new ReflexRouter(this.backend, sinkOf(this.tracking.route));
    this.screenService = new ReflexScreenService(this.backend, sinkOf(this.tracking.screen));
    this.#source = dependencies.configSource;
    this.#warn = dependencies.warn ?? (() => {});
    this.#interventionsConfig = config.interventions;
    this.#pruneThreshold = config.pruneThreshold;
    this.#toolsConfig = config.tools;
    this.#toolPrefix = config.toolPrefix;
    this.#delegationConfig = config.delegation;
    const initialMark = dependencies.configSource === undefined ? [] : volatileSnapshots(dependencies.configSource);
    this.#mark = initialMark;
    this.#watchable = initialMark.length > 0;
    this.#modelRouter = new VirtualModelRouter({
      virtualProvider: config.routing.virtualProvider,
      models: config.routing.models,
      backendName: this.backend.name,
      ledger: this.ledger,
      route: (goal, candidates, topK, input) =>
        this.routeService.selectBest(goal, candidates, topK, { record: false, ...(input ?? {}) }),
      ...(config.routing.fallback ? { fallback: config.routing.fallback } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      // The loader commits a config-only update without remounting the plugin;
      // this is how every routing decision and panel read sees the new policy.
      refresh: () => { this.refreshIfChanged(); }
    });
    this.effortStatusFeed = new EffortStatusFeed();
    this.effort = new EffortInterceptor({
      ...(config.effort.setting === undefined ? {} : { setting: config.effort.setting }),
      enabled: config.effort.enabled,
      fallback: config.effort.fallback,
      minConfidence: config.effort.minConfidence,
      decide: (request) => this.backend.choice(request),
      backendName: this.backend.name,
      ledger: this.ledger,
      feed: this.effortStatusFeed,
      ...(dependencies.now ? { now: dependencies.now } : {})
    });
  }

  /** Name of the active decision backend, for diagnostics and tests. */
  get backendName(): string {
    return this.backend.name;
  }

  /** The routing policy this activation routes through (live). */
  get modelRouter(): VirtualModelRouter {
    return this.#modelRouter;
  }

  /**
   * Route through the process-wide router another activation registered.
   *
   * A reload can leave one provider registration shared by two activations. The
   * shared router is where the live pools and fallback live, so this runtime must
   * read (and refresh) that one — a private copy would show the panel, and route
   * requests, on a policy nobody applies.
   * @param router - the shared router the virtual provider dispatches through.
   */
  adoptModelRouter(router: VirtualModelRouter): void {
    this.#modelRouter = router;
  }

  /**
   * Health of the backend's gateway conversation, or `undefined` for a backend
   * that answers every call in-process.
   *
   * Read by the settings panel and `/reflex-ledger`; never passed to a model.
   * @returns a copy of the counters.
   */
  systemOneHealth(): BackendHealth | undefined {
    return this.#liveBackend.currentHealth();
  }

  /**
   * The connection identity a call dispatched *now* would carry.
   *
   * Public so the panel and a test can ask the same question the dispatch path
   * asks, without going through a call. It reads the live resolved connection
   * block, never the activation-time snapshot, so a config-only commit is
   * reflected immediately (and a profile switch cannot lag one call behind).
   * @returns the identity to snapshot into the next call.
   */
  currentCallIdentity(): CallIdentity {
    return callIdentity(this.#systemOneConfig, this.#backendSelector);
  }

  /**
   * Take the identity, run one call, and classify where its answer came from —
   * the single place provenance is decided.
   *
   * The identity is snapshotted **before** `run()` is called, so the call keeps
   * the connection it was dispatched under even if the backend is swapped while
   * it is in flight. A thrown call is captured rather than rethrown here: some
   * services answer locally after a remote failure (prune, stagnation), others
   * refuse (choice, score, route, screen), and the caller decides.
   *
   * ## Per-call rings, not one shared stamp
   *
   * Every call runs inside its own {@link CallRing}, so a service that writes
   * its own entry buffers it on *this* call and never on a neighbour's. Two
   * overlapping calls therefore cannot borrow, erase or overwrite each other's
   * attribution, which one shared "current stamp" field made trivially possible.
   *
   * ## Absorbed failures, and the honest `unknown`
   *
   * Not every remote failure arrives as a rejection. `ReflexGateService` turns a
   * gateway failure into a fail-closed `escalate` verdict and *returns* it, so
   * `run()` resolves normally. Where the backend publishes a failure record
   * (JEV), a failure count that rose across the call proves the request was
   * rejected and absorbed. Where it publishes none (the vLLM logits backend) no
   * evidence proves anything, and the call reports `unknown` rather than
   * claiming `remote` — see {@link classifyEvidence}.
   * @param run - the call to make.
   * @param options - how to read the outcome (`answered`, `localFallback`).
   * @returns the value, or the failure with the classified outcome.
   */
  async #dispatch<T>(
    run: () => Promise<T>,
    options: { answered(value: T): boolean; localFallback?: (value: T) => boolean }
  ): Promise<{ result?: T; outcome: DispatchOutcome; failure?: string }> {
    this.#assertLive();
    const identity = this.currentCallIdentity();
    // A connection with no active profile, and the in-process mock, send
    // nothing. Naming them apart is the whole point, so it is read from the
    // identity rather than inferred from an empty health record.
    const localOnly =
      identity.connectionName === UNCONFIGURED_CONNECTION_NAME || identity.connectionName === MOCK_CONNECTION_NAME;
    const before = this.#liveBackend.currentHealth();
    const ring = this.#attributed.open(identity);
    let result: T | undefined;
    let failure: string | undefined;
    try {
      result = await this.#callScope.run({ sink: ring.ledger }, run);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const after = this.#liveBackend.currentHealth();
    const evidence: SourceEvidence = {
      answered: failure === undefined && result !== undefined && options.answered(result as T),
      ...(failure === undefined ? {} : { failure }),
      localFallback: failure === undefined && options.localFallback?.(result as T) === true,
      localOnly,
      healthReadable: after !== undefined,
      ...(before === undefined ? {} : { failuresBefore: before.consecutiveFailures }),
      ...(after === undefined ? {} : { failuresAfter: after.consecutiveFailures }),
      ...(after?.lastFailureReason === undefined ? {} : { lastFailureReason: after.lastFailureReason })
    };
    const classified = classifyEvidence(evidence);
    // Appended exactly once, already final: identity *and* source together. No
    // line is ever rewritten, so the JSONL sink stays append-only.
    this.#attributed.finish(ring.token, { identity, ...classified });
    this.#attributed.flush();
    // A service that wrote only after this call settled left its entry in the
    // shared group, so nothing proves that entry is this call's. The ledger line
    // says `unknown`; the payload must agree with it rather than disagree.
    const outcome: DispatchOutcome = this.#attributed.takeLateCall()
      ? { identity, ...classifyEvidence({ ...evidence, entryArrivedLate: true }) }
      : { identity, ...classified };
    return { ...(result === undefined ? {} : { result }), outcome, ...(failure === undefined ? {} : { failure }) };
  }

  /**
   * Run one outbound decision inside a full attributed call.
   *
   * The seam the automatic-intervention engine uses: it opens a ring, runs the
   * service inside it, classifies the outcome from the same evidence the tools
   * use, settles the ring (append-only, once) and hands back both the value and
   * the attribution so the caller can put it on its own payload.
   * @param run - the decision to make.
   * @param options - how to read the outcome.
   * @returns the value and its attribution.
   */
  async attribute<T>(
    run: () => Promise<T>,
    options: { answered(value: T): boolean; localFallback?: (value: T) => boolean }
  ): Promise<{ result: T; attribution: Attribution }> {
    const { result, outcome, failure } = await this.#dispatch(run, options);
    if (failure !== undefined || result === undefined) {
      throw new Error(failure ?? 'the System One connection produced no answer');
    }
    return { result, attribution: attributionOf(outcome.identity, outcome) };
  }

  /**
   * Close one `openCall` ring: append its entries with the final source.
   *
   * The automatic-intervention layer calls this once its service answered, so
   * a decision made at a Host hook point is attributed exactly like one made
   * through a tool.
   * @param token - the ring's token.
   * @param identity - the identity the ring was opened with.
   * @param outcome - the settled source.
   * @returns the attribution for the caller's payload.
   */
  #settleCall(token: number, identity: CallIdentity, outcome: { source: CallSource; detail?: string }): Attribution {
    this.#attributed.finish(token, { identity, ...outcome });
    this.#attributed.flush();
    return attributionOf(identity, outcome);
  }

  /**
   * Append the attribution to one ledger entry's `details`.
   *
   * The four provenance facts ride in `details` rather than as new top-level
   * `LedgerEntry` fields, because `DecisionLedger` is shared with the root stdio
   * MCP package: adding keys there would be a contract change to a surface g-068
   * must leave alone. `details` is already the entry's open bag, and a JSONL
   * reader greps it all the same.
   * @param outcome - the dispatch outcome.
   * @returns the flat provenance fields to merge into `details`.
   */
  #provenance(outcome: DispatchOutcome): Record<string, unknown> {
    return { ...ledgerAttribution(attributionOf(outcome.identity, outcome)) };
  }

  /**
   * Multi-class choice, with the deployment's calibration curve applied to the
   * winning confidence when one is loaded.
   * @param request - question, options, and optional context.
   * @returns the choice response plus the calibrated confidence and the
   *   attribution (connection, requested model, source), when available.
   * @throws Error when the connection produced no answer: a choice tool must not
   *   invent a distribution, and the ledger still records the rejected attempt.
   */
  async choice(request: { question: string; options: string[]; context?: string }): Promise<ReflexChoiceResult> {
    const started = performance.now();
    const { result, outcome, failure } = await this.#dispatch(() => this.backend.choice(request), {
      answered: (value) => value !== undefined
    });
    const record = (): void => {
      this.ledger.record({
        type: 'choice',
        backend: this.backend.name,
        latencyMs: Math.round(performance.now() - started),
        details: { action: 'choice', options: request.options.length, ...this.#provenance(outcome) }
      });
    };

    if (result === undefined) {
      record();
      throw new Error(failure ?? 'the System One connection produced no answer');
    }

    let calibratedConfidence: number | undefined;
    if (this.calibrator.isLoaded()) {
      calibratedConfidence = this.calibrator.calibrate(result.confidence).calibrated;
    }
    record();
    return { ...result, calibratedConfidence, ...attributionOf(outcome.identity, outcome) };
  }

  /**
   * Continuous 0.0 – 1.0 scoring projected from one choice call.
   * @param request - statement, rubric, and optional context.
   * @returns the score response, recorded in the ledger with its attribution.
   */
  async score(request: {
    statement: string;
    criteria?: string;
    context?: string;
  }): Promise<Awaited<ReturnType<typeof scoreStatement>> & Attribution> {
    const started = performance.now();
    const { result, outcome, failure } = await this.#dispatch(() => scoreStatement(this.backend, request), {
      answered: (value) => value !== undefined
    });
    this.ledger.record({
      type: 'choice',
      backend: this.backend.name,
      latencyMs: result?.latencyMs ?? Math.round(performance.now() - started),
      details: { action: 'score', ...(result === undefined ? {} : { score: result.score }), ...this.#provenance(outcome) }
    });
    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    return { ...result, ...attributionOf(outcome.identity, outcome) };
  }

  /**
   * Rank candidate skills/tools against a goal.
   * @param request - goal, candidates, and how many to return.
   * @returns the ranked candidates with their attribution.
   */
  async route(request: { goal: string; candidates: CandidateItem[]; topK?: number }): Promise<RouteResponse & Attribution> {
    const { result, outcome, failure } = await this.#dispatch(
      () => this.routeService.selectBest(request.goal, request.candidates, request.topK ?? 3),
      { answered: (value) => value !== undefined }
    );
    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    return { ...result, ...attributionOf(outcome.identity, outcome) };
  }

  /**
   * Screen untrusted content for prompt injection and instruction hijacking.
   * @param request - content, its source, and whether to force deep screening.
   * @returns the screening verdict and a sanitized fence when unsafe.
   */
  async screen(request: {
    content: string;
    source?: 'tool_output' | 'web_page' | 'user_input' | 'file_content';
    strict?: boolean;
  }): Promise<ScreenResult & Attribution> {
    const { result, outcome, failure } = await this.#dispatch(() => this.screenService.screen(request), {
      answered: (value) => value !== undefined
    });
    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    return { ...result, ...attributionOf(outcome.identity, outcome) };
  }

  /**
   * Fail-closed verification of assertions against evidence.
   *
   * A remote rejection is *not* rethrown: the gate's contract is a verdict, and
   * every assertion escalates. What changes is the honesty of that verdict —
   * the attribution says `rejected` and carries the reason, so a local
   * fail-closed escalation can no longer be read as a System One judgement.
   * @param request - assertions, evidence, and optional strictness.
   * @returns one outcome per assertion plus the overall verdict and attribution.
   */
  async gate(request: {
    assertions: Array<{ statement: string; criteria?: string }>;
    evidence: string;
    strictness?: 'high' | 'normal' | 'lenient';
  }): Promise<GateResponse & Attribution> {
    const { result, outcome, failure } = await this.#dispatch(
      () => this.gateService.verify(request.assertions, request.evidence, { strictness: request.strictness }),
      { answered: (value) => value !== undefined }
    );
    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    // The service absorbs a gateway rejection into a fail-closed verdict, so a
    // thrown call is impossible there; the *reason* it absorbed must still reach
    // the reader. The service's own explanation already carries it, and this
    // layer adds the source so the verdict is not read as a remote judgement.
    return { ...result, ...attributionOf(outcome.identity, outcome) };
  }


  /**
   * Prune bulky output, preserving the lines the intent depends on.
   *
   * Programmatic seam for the pruning capability: the automatic intervention
   * layer drives {@link pruneService} directly, and this entry point stays for
   * in-process callers (tests, diagnostics, an embedding Host).
   * @param request - raw output, lookup intent, and shadow-mode flag.
   * @returns the compacted payload and the measured token savings.
   */
  async prune(request: { rawOutput: string; intent?: string; shadowMode?: boolean }): Promise<ReflexPruneResult & Attribution> {
    const { result, outcome, failure } = await this.#dispatch(
      () =>
        this.pruneService.prune(request.rawOutput, {
          intent: request.intent,
          shadowMode: request.shadowMode
        }),
      {
        answered: (value) => value !== undefined,
        // Prune is the one capability that answers locally on purpose. `judgePath`
        // is its own account of which path produced the text: `local` sent no
        // request at all (the payload is below the judge threshold), and
        // `fallback` means the segmented request was tried and failed. Either is
        // a local answer and must never be rendered as a System One judgement.
        localFallback: (value) => {
          const path = (value as PruneResponse).judgePath;
          return path === 'fallback' || path === 'local';
        }
      }
    );

    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    // A gateway failure that prune absorbed as a local fallback is still a
    // rejection: `judgePath: 'fallback'` and the health record agree, and the
    // reason the fallback happened is the more useful of the two to report.
    const reason = (result as PruneResponse).fallbackReason ?? outcome.detail;
    return {
      tokensSaved: result.estimatedTokensSaved,
      reductionPercentage: `${result.reductionPercentage}%`,
      shadow: result.shadow,
      processedOutput: result.processedOutput,
      ...attributionOf(outcome.identity, { ...outcome, ...(reason === undefined ? {} : { detail: reason }) })
    };
  }

  /**
   * Record one action and check whether the run is stagnating.
   *
   * `history` exists for callers that bring their own run: a resumed session, a
   * delegated agent, or a caller that did not record its steps through this
   * tool. Supplied steps are treated as earlier than the ones recorded here, so
   * a caller can hand over a whole run and still add the action it just took.
   *
   * Programmatic seam for the stagnation capability: the automatic intervention
   * layer drives {@link stagnationService} directly, and this entry point stays
   * for in-process callers.
   *
   * @param request - the action just taken, the overall goal, and any prior steps.
   * @returns the stagnation verdict and corrective suggestion.
   */
  async detectStagnation(request: {
    goal?: string;
    recentAction?: ActionStep;
    history?: readonly ActionStep[];
  }): Promise<StagnationCheckResponse> {
    this.#assertLive();
    if (request.recentAction) this.stagnationService.recordAction(request.recentAction);
    // Dispatched like every other decision: the service writes its own entry,
    // and the ring's append-only settlement is what attributes it.
    const { result, outcome, failure } = await this.#dispatch(
      () => this.stagnationService.check(request.goal, request.history),
      { answered: (value) => value !== undefined }
    );
    if (result === undefined) throw new Error(failure ?? 'the System One connection produced no answer');
    return result;
  }

  /**
   * Read the decision ledger.
   *
   * Programmatic seam behind `/reflex-ledger`: the Host command formats this
   * same read for a person, and an embedding Host can call it directly. Nothing
   * in the tool surface depends on it.
   * @param request - whether to attach the ten most recent entries.
   * @returns the aggregate summary and, on request, recent entries.
   */
  statusLedger(request: { includeEntries?: boolean } = {}): ReflexLedgerResult {
    this.#assertLive();
    const summary = this.ledger.getSummary();
    const health = this.systemOneHealth();
    const base: ReflexLedgerResult = health === undefined ? { summary } : { summary, systemOneHealth: health };
    if (!request.includeEntries) return base;
    return { ...base, recentEntries: this.ledger.getEntries().slice(-10) };
  }

  /**
   * Publish the reflex tool names this activation currently owns, so a Host
   * observer can mirror the live surface.
   * @param names - the registered tool names.
   */
  noteToolSurface(names: readonly string[]): void {
    this.#surface = [...names];
  }

  /** The reflex tool names of this activation. */
  get toolSurface(): readonly string[] {
    return this.#surface;
  }

  /**
   * The latest adaptive effort decision this activation published.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the status, or `undefined` before the first decided turn.
   */
  effortStatus(agentId?: string): ReflexEffortStatus | undefined {
    return this.effortStatusFeed.latest(agentId);
  }

  /**
   * The status-bar line of the latest adaptive effort decision.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the rendered line, or `undefined` before the first decided turn.
   */
  effortStatusLine(agentId?: string): string | undefined {
    return this.effortStatusFeed.statusLine(agentId);
  }

  /**
   * Attach the automatic-intervention engine of this activation.
   *
   * Set by the plugin lifecycle right after the listeners are installed, so the
   * panel and the tests read the same engine the hooks drive. Absent when every
   * capability is `off`: nothing is installed, and nothing is reported.
   *
   * The optional reconfiguration seam is what makes a config-only save live: the
   * installer owns the listeners (which hooks exist depends on the capability
   * modes), so swapping thresholds or turning a capability on/off has to go
   * through it rather than through the engine alone.
   * @param engine - the engine behind this activation's listeners.
   * @param reconfigure - applies a new resolved policy to the listeners.
   * @param listenerCount - reads how many listeners are currently attached.
   */
  attachInterventions(
    engine: InterventionEngine | undefined,
    reconfigure?: (config: ResolvedInterventionsConfig, pruneThreshold: number) => void,
    listenerCount?: () => number
  ): void {
    this.#interventions = engine;
    this.#reconfigureInterventions = reconfigure;
    this.#interventionListenerCount = listenerCount;
  }

  /**
   * How many intervention listeners this activation currently has attached.
   *
   * `0` is the honest answer of an `off` deployment: the capability is absent,
   * not a listener that checks a flag on every hook.
   */
  get interventionListenerCount(): number {
    return this.#interventionListenerCount?.() ?? 0;
  }

  /** The automatic-intervention engine, when this activation installed one. */
  get interventions(): InterventionEngine | undefined {
    return this.#interventions;
  }

  /**
   * Attach the tool-surface reconciler of this activation.
   *
   * Set by the plugin lifecycle right after the tools are registered. The
   * registry lives on the Host context, not on this runtime, so a config-only
   * save has to call back out to the installer that owns the registrations. The
   * seam is also what lets the tests prove idempotence: an unchanged save must
   * not unregister and re-register anything.
   * @param reconfigure - reconciles the registered set with a new resolved config.
   * @param registrationCount - reads how many tools are currently registered.
   * @param registrationEvents - reads how many registrations happened in total.
   */
  attachToolSurface(
    reconfigure?: (config: ResolvedReflexConfig) => void,
    registrationCount?: () => number,
    registrationEvents?: () => number
  ): void {
    this.#reconfigureTools = reconfigure;
    this.#toolRegistrationCount = registrationCount;
    this.#toolRegistrationEvents = registrationEvents;
  }

  /**
   * Attach the routing-lifecycle reconciler of this activation.
   *
   * The provider registration lives on the LLM runtime, not on this runtime, so
   * enabling/disabling the route or renaming the virtual provider on a
   * config-only save has to call back out to the installer that owns it.
   * @param reconfigure - applies the routing lifecycle of a freshly resolved config.
   * @param registrationEvents - reads how many provider registrations happened.
   */
  attachRouting(
    reconfigure?: (routing: ResolvedRoutingConfig) => void,
    registrationEvents?: () => number
  ): void {
    this.#reconfigureRouting = reconfigure;
    this.#routingRegistrationEvents = registrationEvents;
  }

  /**
   * Attach the live delegation-capability read of this activation.
   *
   * Set by the plugin lifecycle right after the tool surface, so the panel can
   * explain what the Host actually publishes instead of silently omitting it.
   * The runtime does not own the registry: it only reports what the Host says.
   * @param read - returns the current reading.
   * @param refresh - re-checks the registry and reconciles the tool surface.
   */
  attachDelegationHealth(read?: () => DelegationHealth, refresh?: () => void): void {
    this.#delegationHealth = read;
    this.#refreshDelegation = refresh;
  }

  /**
   * Attach the hook that records the agent scope the capability is read in.
   *
   * `dsh-tools` is scoped, and a preset-hosted delegation tool is invisible from
   * the global view. The lifecycle owns the reading, so it also owns the scope:
   * this only lets a caller that *does* have an `Agent` (the panel poll, a
   * session-aware caller) tell it which scope to read as. Never decides
   * registration — that is configuration's job.
   * @param note - receives the scope to read the delegation capability in.
   */
  attachDelegationScope(note?: (agent: Agent) => void): void {
    this.#noteDelegationScope = note;
  }

  /**
   * Record the scope future delegation reads should use.
   * @param agent - the calling agent, or a preset to read as.
   */
  noteDelegationScope(agent: Agent): void {
    this.#noteDelegationScope?.(agent);
  }

  /** Re-check the Host delegation capability in the recorded scope. */
  checkDelegationHealth(): DelegationHealth | undefined {
    this.#refreshDelegation?.();
    return this.#delegationHealth?.();
  }

  /** The current delegation-capability reading, when the lifecycle attached one. */
  get delegationHealth(): DelegationHealth | undefined {
    return this.#delegationHealth?.();
  }

  /**
   * Attach the delegated-agent effort inheritance of this activation.
   * @param inheritance - the installed listener, or undefined to detach.
   */
  attachEffortInheritance(inheritance: DelegatedEffortInheritance | undefined): void {
    this.#effortInheritance = inheritance;
  }

  /**
   * How many delegated selections this activation rewrote to a concrete level.
   *
   * Monotonic: it counts the marker replacements, not the steps that used them.
   */
  get effortInheritanceRewrites(): number {
    return this.#effortInheritance?.rewrites ?? 0;
  }

  /** Provider registrations this activation made (monotonic; diagnostics). */
  get routingRegistrationEvents(): number {
    return this.#routingRegistrationEvents?.() ?? 0;
  }

  /** Backend rebuilds this activation performed (0 when a seam supplied one). */
  get backendRebuilds(): number {
    return this.#backendRebuilds;
  }

  /** Ledger sink switches this activation performed. */
  get ledgerSwitches(): number {
    return this.#ledgerSwitches;
  }

  /** The number of reflex tools this activation currently has registered. */
  get toolRegistrationCount(): number {
    return this.#toolRegistrationCount?.() ?? 0;
  }

  /**
   * How many `tools.register` calls this activation has made since it loaded.
   *
   * Monotonic on purpose: an idempotent save leaves it unchanged, which is the
   * measurement a test can assert without spying on the registry.
   */
  get toolRegistrationEvents(): number {
    return this.#toolRegistrationEvents?.() ?? 0;
  }

  /**
   * The configuration the panel and diagnostics must report: the values
   * currently in force for every block this slice has made live.
   *
   * The panel promise is "show what is in force", not "show what was written at
   * startup". `effort`, `interventions`, `pruneThreshold`, `tools` and
   * `toolPrefix` are read from their live fields; blocks whose live path is a
   * separate slice (backend, ledger sink, route lifecycle) keep reporting their
   * activation values until that slice lands.
   */
  get effectiveConfig(): ResolvedReflexConfig {
    const models = this.modelRouter.models;
    const fallback = this.modelRouter.fallback;
    return {
      ...this.config,
      backend: this.#backendSelector,
      ledgerPath: this.#ledgerPath,
      toolPrefix: this.#toolPrefix,
      tools: this.#toolsConfig,
      systemOne: this.#systemOneConfig,
      routing: {
        enabled: this.#routingConfig.enabled,
        maxTaskChars: this.#routingConfig.maxTaskChars,
        // The router is the live source of the provider name and the pools: a
        // rename is applied there first, and every surface must agree with it.
        virtualProvider: this.modelRouter.virtualProvider,
        models,
        ...(fallback === undefined ? {} : { fallback })
      },
      effort: { ...this.effort.policy },
      // The delegation consent is a deployment switch, written by the panel and
      // re-resolved on every commit; a cached activation value would keep showing
      // "off" after the user ticked it.
      delegation: this.#delegationConfig,
      interventions: this.#interventionsConfig,
      pruneThreshold: this.#pruneThreshold
    };
  }

  /**
   * Full schema resolutions this activation performed.
   *
   * Incremented only by {@link refresh}; the request/step/tool hot paths never
   * resolve the schema, which is the measurement this counter makes provable.
   */
  get configResolveCount(): number {
    return this.#configResolves;
  }

  /** Whether the owning plugin activation has been disposed. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Re-read this activation's live policy from its config.
   *
   * Called when the Host reports a config commit (`loader/volatile-update`) and
   * lazily once per `agent/pre-step`. The schema runs here — once per actual
   * commit — and nowhere on the request/tool hot paths.
   *
   * Applied without a remount:
   * - routing pools and fallback (replaced in the router);
   * - the whole adaptive-effort policy (switch, marker, fallback, confidence
   *   floor), read live by the request interception and the selector surface;
   * - the intervention thresholds and capability modes, with the listeners
   *   added or removed according to the effective modes;
   * - the per-tool switches and the deployment prefix, with the registry
   *   reconciled by the installer through {@link attachToolSurface}. The
   *   reconciler is idempotent: a commit that changes neither the enabled
   *   suffixes nor the prefix unregisters and re-registers nothing;
   * - the decision backend and its connection settings, rebuilt only on a
   *   transport-relevant change (health starts fresh on the new backend);
   * - the ledger sink, migrated in place so no recorded entry is lost;
   * - the routing lifecycle (enabled switch, virtual-provider rename) through
   *   {@link attachRouting}, and the task budget read per step.
   * @returns whether a new policy was applied.
   */
  refresh(): boolean {
    if (this.#source === undefined || this.#disposed || this.#refreshing) return false;
    this.#refreshing = true;
    try {
      let resolved: ResolvedReflexConfig;
      try {
        resolved = resolveConfig(this.#source as ReflexConfig);
      } catch (error) {
        this.#warn(
          `dsh-reflex: the updated configuration cannot be applied (${(error as Error).message}); keeping the previous live values`
        );
        return false;
      }
      this.#configResolves += 1;

      // Backend and connection: rebuild only when something that shapes the
      // transport changed. A same-value commit touches nothing (idempotence), and
      // the services keep dispatching through the same delegate.
      const nextSignature = backendSignature(resolved);
      if (this.#backendSwappable && nextSignature !== this.#backendSignature) {
        this.#liveBackend.swap(createBackend(resolved));
        this.#backendSignature = nextSignature;
        this.#backendRebuilds += 1;
      }
      this.#systemOneConfig = resolved.systemOne;
      this.#backendSelector = resolved.backend;

      // Ledger sink: move the JSONL target in place, migrating the in-memory
      // history into the new file so entries recorded before the switch survive.
      if (resolved.ledgerPath !== this.#ledgerPath) {
        const switched = (this.ledger as { switchLogPath?: (path?: string | null) => boolean }).switchLogPath?.(
          resolved.ledgerPath ?? null
        );
        this.#ledgerPath = resolved.ledgerPath;
        if (switched) this.#ledgerSwitches += 1;
      }

      // The prune threshold is read live by the direct prune seam as well as by
      // the intervention engine's projection.
      this.pruneService.setMinCharsThreshold(resolved.pruneThreshold);

      this.#modelRouter.updatePolicy({
        models: resolved.routing.models,
        ...(resolved.routing.fallback ? { fallback: resolved.routing.fallback } : {})
      });
      this.#routingConfig = resolved.routing;
      this.effort.updatePolicy({
        enabled: resolved.effort.enabled,
        ...(resolved.effort.setting === undefined ? {} : { setting: resolved.effort.setting }),
        fallback: resolved.effort.fallback,
        minConfidence: resolved.effort.minConfidence
      });
      this.#interventionsConfig = resolved.interventions;
      this.#pruneThreshold = resolved.pruneThreshold;
      // The tool block is applied before the intervention reconfigure so the
      // callback can derive the renamed `ownTools` set from this runtime's live
      // values rather than from the activation-time snapshot.
      this.#toolsConfig = resolved.tools;
      this.#toolPrefix = resolved.toolPrefix;
      this.#delegationConfig = resolved.delegation;
      this.#reconfigureInterventions?.(resolved.interventions, resolved.pruneThreshold);
      this.#reconfigureTools?.(resolved);
      // Routing lifecycle last: enabling/disabling the route and renaming the
      // provider may recreate the shared router, and the panel/tool surfaces read
      // the routing block after the pools have been replaced.
      this.#reconfigureRouting?.(resolved.routing);
      this.#mark = volatileSnapshots(this.#source);
      return true;
    } finally {
      this.#refreshing = false;
    }
  }

  /**
   * Refresh only when the loader actually committed a new config value.
   *
   * The volatile references hand out a new snapshot object on every commit, so
   * an identity comparison over them is O(config blocks) and never runs the
   * schema again for an unchanged config.
   * @returns whether a new policy was applied.
   */
  refreshIfChanged(): boolean {
    if (!this.#watchable || this.#source === undefined || this.#disposed || this.#refreshing) return false;
    const next = volatileSnapshots(this.#source);
    const previous = this.#mark;
    const unchanged =
      next.length === previous.length && next.every((snapshot, index) => snapshot === previous[index]);
    if (unchanged) return false;
    return this.refresh();
  }

  /** Release the runtime. Called from the plugin's `ctx.effect` cleanup. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // No residue on unload: the per-agent detection state, the reduction memo,
    // and the accounts of the intervention engine are dropped with the runtime,
    // exactly like the effort feed and the ledger.
    this.#interventions?.reset();
    this.#interventions = undefined;
    this.#reconfigureRouting = undefined;
    this.effortStatusFeed.clear();
    this.ledger.clear();
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('reflex runtime has been disposed');
  }
}

/**
 * Identity of the configuration that shapes the decision transport.
 *
 * A config-only save re-resolves the whole document; rebuilding the backend for
 * a change that cannot affect it would reset health and drop the connection for
 * no reason. This signature lets {@link ReflexRuntime.refresh} rebuild exactly
 * when the transport's identity changed.
 * @param config - resolved plugin configuration.
 * @returns a stable string of the transport-relevant fields.
 */
function backendSignature(config: ResolvedReflexConfig): string {
  const { backend, systemOne, interventions } = config;
  return JSON.stringify([
    backend,
    // g-066: the resolved connection fields, which are the *active profile's*
    // (plus the "unconfigured" reason, so activating or losing a profile
    // rebuilds). They are listed here rather than left to the per-profile rows
    // below because a resolved field is the one the transport is built from.
    systemOne.unconfigured ?? '',
    systemOne.baseUrl ?? '',
    systemOne.model ?? '',
    systemOne.apiKeyEnv ?? '',
    systemOne.timeoutMs ?? null,
    // g-057: switching the active profile (or editing any profile's connection
    // facts) must rebuild the backend, otherwise the panel would report a new
    // profile as active while the running transport still served the old one.
    // The *keys* are represented by presence only: a signature is a diagnostic
    // value, and a rotated key must not change what an edited profile is
    // observed to be — but a profile that gained or lost a key must.
    systemOne.active ?? '',
    Object.entries(systemOne.profiles ?? {}).map(([name, profile]) => [
      name,
      profile.baseUrl ?? '',
      // The model *list* and the selection, not the resolved model: a save that
      // only changes which listed model is selected must rebuild the transport,
      // and so must one that adds a model the selection could point at.
      (profile.modelIds ?? []).join('\u0000'),
      profile.selectedModel ?? '',
      profile.apiKeyEnv ?? '',
      profile.timeoutMs ?? null,
      profile.backend ?? '',
      profile.apiKey === undefined ? '' : 'set'
    ]),
    interventions.pruneJudgeMinChars
  ]);
}

/**
 * Build the backend a plugin activation should use.
 *
 * ## Nothing connects without an active profile (g-066)
 *
 * The connection fields come from the active profile only, so when
 * {@link ResolvedSystemOneConfig.unconfigured} is set there is nothing to build
 * and this function **refuses**. Building a backend anyway is exactly the old
 * fallback: with no profile resolved, the vendored factory would choose `jev`
 * because `JEV_API_KEY` happens to be exported, and the plugin would make a
 * request nobody configured. Returning the mock backend instead was the other
 * candidate and was rejected as well: "unconfigured" must not look like "answered
 * locally with heuristics" in the ledger or the panel.
 *
 * The replacement is {@link UnconfiguredBackend}: the same deterministic local
 * heuristics, under a name that says what is wrong, plus a health record that
 * reports the missing connection instead of staying silent. `backend` may still
 * be `mock` **explicitly**, which is a deployment choosing the in-process
 * implementation on purpose — the two must remain distinguishable.
 *
 * The connection block of the resolved config overrides the environment for
 * this plugin instance only: the backend implementations already fall back to
 * the environment for every omitted option, so an explicitly configured
 * deployment and an env-configured one behave the same when the block is empty.
 *
 * The key is the exception worth naming: it is resolved **here**, through
 * {@link resolveApiKeyWithSource}, and handed to the backend explicitly. The
 * backends keep their own environment reads for the fields they own (base URL,
 * model), but a key that only arrived through their fallback would be invisible
 * to {@link resolveApiKeyWithSource} — and therefore to the panel, which is how
 * "the panel says the env var is empty while the backend works" was possible.
 * One chain, one answer for both.
 *
 * Every construction here also passes `apiKeyResolved: true` (g-059). That flag
 * makes "the chain resolved no key" *final*: without it both backends would
 * re-read `SYSTEM_ONE_API_KEY` / `JEV_API_KEY` (and the logits backend would
 * invent `dummy`) whenever the key was omitted, so a block naming an empty
 * variable would show as missing on the panel while its requests still
 * authenticated — the divergence this file exists to close, pointing the other
 * way. The flag defaults to `false` in the vendored backends, so every other
 * construction (tests, probes, a bare import) keeps the historical chain.
 * @param config - resolved plugin configuration.
 * @param env - environment the API-key chain reads; defaults to `process.env`.
 * @returns the forced backend, the local-only one when nothing is configured, or
 *   one chosen from the environment for `auto`.
 */
export function createBackend(
  config: ResolvedReflexConfig,
  env: Record<string, string | undefined> = process.env
): DecisionBackend {
  const { backend, baseUrl, model, timeoutMs } = config.systemOne;
  // An explicitly chosen `mock` is a decision, not a connection: it answers
  // in-process and reads nothing. It therefore outranks the "no active profile"
  // rule — which exists to stop *network* connections nobody configured, and
  // which would otherwise make `backend: 'mock'` impossible to ask for without
  // also authoring a profile that the mock never uses.
  if (backend === 'mock') return new MockDecisionBackend();
  // No active profile — or an active profile whose model cannot be sent — no
  // connection (g-066 att-002). Checked before the key chain and before the
  // provider selector below, because both of them read the environment:
  // reaching either would be the implicit request this removes.
  //
  // The model reasons are here for a reason the review found the hard way: a
  // transport built for a broken selection still sends *something*, because
  // every implementation fills an absent `model` with `|| DEFAULT_MODEL`. The
  // only place that fallback can be kept from firing is "no transport at all",
  // and `UnconfiguredBackend` issues no request.
  if (config.systemOne.unconfigured !== undefined) {
    return new UnconfiguredBackend(config.systemOne.unconfigured);
  }
  const apiKey = resolvedKeyOf(resolveApiKeyWithSource(config.systemOne, env));
  // `auto` is resolved by the *one* function the connection test asks as well
  // (g-067 att-002), so the runtime and the "Test" button can never describe two
  // different transports for the same connection. Before this, `auto` here was
  // a delegation to the vendored factory and `auto` there was a hard-coded Jev:
  // with `SYSTEM_ONE_BACKEND=vllm` exported, the button went green on the
  // official URL while this function built a request carrying the very same
  // resolved key to a vLLM endpoint. The factory is still what `auto` *means* —
  // `connectionImplementation` reads the same precedence it does — it is just no
  // longer consulted twice.
  const implementation = backend === 'auto' ? connectionImplementation('auto', env) : backend;
  switch (implementation) {
    case 'mock':
      // The environment's `auto` answer is the in-process mock: it opens no
      // socket, so nothing configured (or resolved) leaves this process.
      return new MockDecisionBackend();
    case 'jev':
      return new JevDecisionBackend({
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(apiKey === undefined ? {} : { apiKey }),
        // The chain above is the whole chain: no second read behind its back.
        apiKeyResolved: true,
        ...(model === undefined ? {} : { model }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        // The resolved config wins over SYSTEM_ONE_PRUNE_JUDGE_MIN_CHARS: the
        // backend only reads the environment when no explicit value is given.
        pruneJudgeMinChars: config.interventions.pruneJudgeMinChars
      });
    default:
      // `vllm`, and `auto` when the environment selected the logits backend.
      return new SimpleJevDecisionBackend({
        ...(baseUrl === undefined ? {} : { vllmBaseUrl: baseUrl }),
        ...(apiKey === undefined ? {} : { apiKey }),
        // Same for the logits backend, whose `dummy` fallback would otherwise
        // turn "no key" into a header nobody configured.
        apiKeyResolved: true,
        ...(model === undefined ? {} : { model }),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      });
  }
}

/**
 * Build a runtime for one plugin activation.
 * @param config - resolved plugin configuration.
 * @param dependencies - test seams for the ledger, backend, and routing clock.
 * @returns the runtime the tools close over.
 */
export function createReflexRuntime(
  config: ResolvedReflexConfig,
  dependencies: {
    backend?: DecisionBackend;
    ledger?: DecisionLedger;
    now?: () => number;
    configSource?: unknown;
    warn?: (message: string) => void;
  } = {}
): ReflexRuntime {
  return new ReflexRuntime(config, dependencies);
}
