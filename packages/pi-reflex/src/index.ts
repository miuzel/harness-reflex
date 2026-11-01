/**
 * The harness-reflex extension for the pi coding agent.
 *
 * pi loads this as an in-process TypeScript module (via jiti, no build step).
 * It does two things:
 *
 * 1. **Registers the eight `reflex_*` tools** ({@link REFLEX_TOOLS}), the same
 *    set and semantics the MCP surface exposes.
 * 2. **Runs the four automatic interventions** — prune, stagnation, correction,
 *    closing — by translating pi's events into the command-hook contract and
 *    handing them to the root package's `HookDecision`, which is the same
 *    decision object the Claude Code hook and the DSH plugin run.
 *
 * ## The closing capability is honestly degraded here
 *
 * pi has no API that refuses to end a turn. `agent_before_settle` may append
 * entries and set `continue: true` to ask for exactly one more model request.
 * So the closing check in pi is not the Claude Code hard block; it is:
 *
 * - contradiction found, continuation unused → append the correction, request
 *   one more request, record `closing-continue`;
 * - contradiction found, continuation already spent → let the settle proceed
 *   and record `closing-degraded-pass`.
 *
 * The ledger tag distinguishes the two hosts. pi never writes `closing-block`,
 * because pi never blocks. See {@link ClosingDegradeState}.
 *
 * @module pi-reflex
 */
import { HookDecision, DEFAULT_HOOK_CONFIG, type HookConfig } from '../../../src/hook/decision.js';
import { MemoryStateStore } from '../../../src/hook/memory-store.js';
import { EVENT_BUDGETS } from '../../../src/hook/contract.js';
import type { HookLedgerRecord } from '../../../src/state/file-store.js';
import { SystemClock } from '../../../src/state/clock.js';

/** The wall clock; one instance is enough for every decision this extension runs. */
const clock = new SystemClock();
import {
  CLOSING_BLOCK,
  CLOSING_DEGRADED_PASS,
  ClosingDegradeState,
  closingCorrectionText,
  PI_EVENTS,
  lastAssistantText,
  settleCanContinue,
  settleMessageText,
  replaceBlocks,
  resultEventFor,
  stopPayload,
  toolCallPayload,
  toolResultPayload,
  type PiBeforeSettleEventLike,
  type PiToolCallEventLike,
  type PiToolResultEventLike
} from './pi-adapter.js';
import { REFLEX_TOOLS, piReflexServices, type PiReflexServices } from './tools.js';

/** How each capability starts, unless an environment variable overrides it. */
export interface PiReflexOptions {
  /** Per-capability mode; the keys match the hook contract's capability names. */
  modes?: Partial<Record<'stagnation' | 'prune' | 'gate' | 'closing', 'off' | 'observe' | 'active'>>;
  /** Decision tuning; defaults to {@link DEFAULT_HOOK_CONFIG}. */
  config?: Partial<HookConfig>;
  /** Services seam for tests. */
  services?: PiReflexServices;
}

/**
 * The mode defaults for pi.
 *
 * `closing` is `observe` in line with the hook contract's shipped default: the
 * most destructive action available stays off until someone opts in. Unlike the
 * other hosts there is no safe degraded default to ship — an extension that
 * appends messages and requests continuations on every turn changes what the
 * agent costs, so the capability is advertised and observable, and actively
 * requests continuations only when the user turns it on.
 */
export const PI_DEFAULT_MODES = {
  stagnation: 'active',
  prune: 'active',
  gate: 'active',
  closing: 'observe'
} as const;

/** Resolve a mode from `REFLEX_PI_<CAP>` (falling back to `REFLEX_<CAP>`), or `undefined`. */
function modeFromEnv(capability: string): 'off' | 'observe' | 'active' | undefined {
  const upper = capability.toUpperCase();
  const raw = process.env[`REFLEX_PI_${upper}`] ?? process.env[`REFLEX_${upper}`];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  return value === 'off' || value === 'observe' || value === 'active' ? value : undefined;
}

/**
 * Resolve the four capability modes.
 * @param options - explicit modes, highest precedence.
 * @returns the resolved modes.
 */
export function resolveModes(options: PiReflexOptions = {}): ResolvedModes {
  const resolved = { ...PI_DEFAULT_MODES } as Record<string, 'off' | 'observe' | 'active'>;
  for (const capability of ['stagnation', 'prune', 'gate', 'closing'] as const) {
    const env = modeFromEnv(capability);
    if (env) resolved[capability] = env;
    const explicit = options.modes?.[capability];
    if (explicit) resolved[capability] = explicit;
  }
  return resolved as ResolvedModes;
}

/** The structural slice of pi's `ExtensionAPI` this extension uses. */
export interface PiApiLike {
  on(event: string, handler: (event: unknown) => unknown): () => void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
  }): void;
}

/** The four resolved capability modes. */
export type ResolvedModes = Record<'stagnation' | 'prune' | 'gate' | 'closing', 'off' | 'observe' | 'active'>;

/** One ledger line the extension appended, as the tests read it back. */
/** The pi-specific closing label, the one field a pi ledger line adds to the shared record. */
export type PiClosingOutcome = typeof CLOSING_BLOCK | typeof CLOSING_DEGRADED_PASS;

/** One ledger line the extension appended, as the tests read it back. */
export interface RecordedIntervention extends HookLedgerRecord {
  closingOutcome?: PiClosingOutcome;
}

/**
 * Everything the running extension keeps between events.
 *
 * Exported so the unit tests can drive the handlers directly with the same
 * session store the real extension uses.
 */
export interface PiReflexRuntime {
  sessionId: string;
  store: MemoryStateStore;
  decision: HookDecision;
  services: PiReflexServices;
  closing: ClosingDegradeState;
  /** Every ledger line this extension produced, in order. */
  readonly ledger: RecordedIntervention[];
  /** pi turn index pi last reported. */
  turnIndex: number;
  /** The SessionStart notice, when one was produced. */
  notice: string;
}

/**
 * Bind the runtime to pi's events.
 *
 * The factory is synchronous and does no I/O: pi may call it before a session
 * exists, and the docs ask extensions not to start long-lived work here.
 * @param pi - the extension API.
 * @param options - modes, config, and test seams.
 * @returns the runtime, so tests and the e2e can inspect it.
 */
export function installPiReflex(pi: PiApiLike, options: PiReflexOptions = {}): PiReflexRuntime {
  const services = options.services ?? piReflexServices();
  const store = new MemoryStateStore({ harness: 'pi' });
  const runtime: PiReflexRuntime = {
    sessionId: 'pi-session',
    store,
    services,
    closing: new ClosingDegradeState(1),
    ledger: [],
    turnIndex: 0,
    notice: '',
    decision: undefined as unknown as HookDecision
  };
  const modes = resolveModes(options);
  const config: HookConfig = { ...DEFAULT_HOOK_CONFIG, ...options.config };
  runtime.decision = new HookDecision({
    store,
    backend: services.backend,
    config,
    modes,
    sessionId: runtime.sessionId,
    clock,
    stderr: () => undefined
  });

  // The eight tools. `execute` is the same code the MCP surface runs.
  for (const spec of REFLEX_TOOLS) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params) {
        try {
          return { content: [{ type: 'text', text: await spec.execute(params ?? {}, services) }] };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Tool execution failed: ${(error as Error).message}` }],
            isError: true
          };
        }
      }
    });
  }

  // Session lifecycle: the start notice and the teardown.
  pi.on(PI_EVENTS.sessionStart, async (event) => {
    const sessionId = sessionIdOf(event);
    if (sessionId) rebind(runtime, sessionId, modes, config);
    const output = await runtime.decision.handle(
      'sessionstart',
      { session_id: runtime.sessionId },
      EVENT_BUDGETS.sessionstart
    );
    const context = (output.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
    runtime.notice = context ?? '';
    return undefined;
  });

  pi.on(PI_EVENTS.sessionShutdown, async () => {
    await runtime.decision.handle('sessionend', { session_id: runtime.sessionId }, EVENT_BUDGETS.sessionend);
    return undefined;
  });

  // Turn bookkeeping: a new turn refills the single closing continuation.
  pi.on(PI_EVENTS.turnStart, async (event) => {
    const index = (event as { turnIndex?: unknown }).turnIndex;
    if (typeof index === 'number') {
      runtime.turnIndex = index;
      runtime.closing.beginTurn(index);
    }
    return undefined;
  });

  // Stagnation: a repeated or oscillating call is refused before it runs.
  pi.on(PI_EVENTS.toolCall, async (event) => {
    const call = event as PiToolCallEventLike;
    const output = await runtime.decision.handle(
      'pretooluse',
      toolCallPayload(call, runtime.sessionId),
      EVENT_BUDGETS.pretooluse
    );
    const specific = output.hookSpecificOutput as
      | { permissionDecision?: string; permissionDecisionReason?: string }
      | undefined;
    if (specific?.permissionDecision === 'deny' && specific.permissionDecisionReason) {
      return { block: true, reason: specific.permissionDecisionReason };
    }
    return undefined;
  });

  // Prune and correction: replace a bulky result, or attach one corrective note.
  pi.on(PI_EVENTS.toolResult, async (event) => {
    const result = event as PiToolResultEventLike;
    const payload = toolResultPayload(result, runtime.sessionId);
    if (result.isError === true) {
      const failure = await runtime.decision.handle('postfailure', payload, EVENT_BUDGETS.postfailure);
      const note = (failure.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
      if (note) {
        return { content: [...result.content, { type: 'text', text: note }] as never };
      }
      return undefined;
    }
    const output = await runtime.decision.handle(resultEventFor(false), payload, EVENT_BUDGETS.posttooluse);
    const replaced = (output.hookSpecificOutput as { updatedToolOutput?: string } | undefined)?.updatedToolOutput;
    if (typeof replaced === 'string') {
      // pi drops `structuredContent` when `content` is replaced without it, so the
      // old structured value is deliberately not returned: it describes the
      // payload we just pruned, and keeping it would hand callers a value that no
      // longer matches the text they can see.
      return { content: replaceBlocks(replaced) as never };
    }
    return undefined;
  });

  // Closing: the honest degraded version. One continuation per turn, then pass.
  pi.on(PI_EVENTS.beforeSettle, async (event) => {
    const settle = event as unknown as PiBeforeSettleEventLike;
    // The assistant's closing words are in the *context preview*, not in
    // `entries`: `entries` are the drafts handlers may append, and at this point
    // they are only whatever an earlier handler already queued.
    const message = settleMessageText(settle);
    const stop = await runtime.decision.handle(
      'stop',
      stopPayload({
        sessionId: runtime.sessionId,
        lastAssistantMessage: message,
        stopHookActive: runtime.closing.spent > 0
      }),
      EVENT_BUDGETS.stop
    );
    const blockReason = typeof stop.reason === 'string' ? stop.reason : '';
    // `stop_hook_active` makes the shared decision take its guarded-allow path,
    // which is right for a host that owns its own retry guard. Here pi's settle
    // allowance is the guard, and it is ours, so the judgment is re-asked with
    // the flag clear: otherwise the second settle would look clean and the turn
    // would be recorded as nothing instead of as a degraded pass.
    const judgment = runtime.closing.spent > 0
      ? await runtime.decision.handle(
          'stop',
          stopPayload({ sessionId: runtime.sessionId, lastAssistantMessage: message, stopHookActive: false }),
          EVENT_BUDGETS.stop
        )
      : stop;
    const reason = typeof judgment.reason === 'string' ? judgment.reason : blockReason;
    const contradicted = closingContradictions(reason);
    const plan = runtime.closing.decide(contradicted, reason || closingCorrectionText(contradicted));
    if (plan.outcome) recordClosing(runtime, plan.outcome, { contradicted: contradicted.slice(0, 5) });
    if (plan.action !== 'continue') return undefined;
    if (!settleCanContinue(settle)) {
      recordClosing(runtime, CLOSING_DEGRADED_PASS, { skipReason: 'not-continuable' });
      return undefined;
    }
    return {
      entries: [
        ...(settle.entries ?? []),
        { type: 'custom_message', customType: 'reflex.closing', content: plan.text, display: true }
      ],
      continue: true
    };
  });

  return runtime;
}

/** pi's session id, when the event carries one. */
function sessionIdOf(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  for (const key of ['sessionId', 'session_id', 'session']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Point the decision at another session.
 *
 * `HookDecision` fixes its session at construction, so a session switch needs a
 * fresh instance over the same store and services.
 */
function rebind(runtime: PiReflexRuntime, sessionId: string, modes: ResolvedModes, config: HookConfig): void {
  runtime.sessionId = sessionId;
  runtime.decision = new HookDecision({
    store: runtime.store,
    backend: runtime.services.backend,
    config,
    modes,
    sessionId,
    clock,
    stderr: () => undefined
  });
}

/** The contradicted claims quoted in a closing reason, for the ledger detail. */
function closingContradictions(reason: string): string[] {
  if (!reason) return [];
  const marker = 'tool evidence contradicts it: ';
  const start = reason.indexOf(marker);
  if (start < 0) return [reason];
  const rest = reason.slice(start + marker.length);
  const end = rest.indexOf('. ');
  return (end < 0 ? rest : rest.slice(0, end))
    .split('; ')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Append one pi closing outcome to the runtime's readable ledger. */
function recordClosing(
  runtime: PiReflexRuntime,
  outcome: PiClosingOutcome,
  detail: Record<string, unknown>
): void {
  runtime.ledger.push({
    id: `pi_${runtime.closing.turn}_${runtime.closing.spent}_${outcome}`,
    timestamp: new Date().toISOString(),
    type: 'closing',
    harness: 'pi',
    event: PI_EVENTS.beforeSettle,
    backend: runtime.services.backend.name,
    latencyMs: 0,
    dedupeKey: outcome,
    turnNo: runtime.closing.turn,
    applied: false,
    passed: outcome === CLOSING_DEGRADED_PASS,
    details: { ...detail, closingOutcome: outcome },
    closingOutcome: outcome
  });
}

/**
 * The pi extension entry point, as pi calls it.
 *
 * pi's own `ExtensionAPI` satisfies {@link PiApiLike} structurally; the cast is
 * the only place this package names pi's type system, and it is a structural
 * match rather than an import, so the package builds without pi installed.
 * @param pi - the extension API.
 */
export default function piReflex(pi: PiApiLike): void {
  installPiReflex(pi);
}
