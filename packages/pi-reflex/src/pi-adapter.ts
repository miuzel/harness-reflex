/**
 * The one file that knows pi's event shapes.
 *
 * `HookDecision` (the root package's host-independent decision) speaks the
 * command-hook contract: plain payload objects with `session_id`, `tool_name`,
 * `tool_input`, `tool_response`. pi speaks TypeScript events with
 * `toolCallId`, `toolName`, `input`, `content`, `isError`. Someone has to
 * translate, and pi 1.x is still in breaking change: `agent_before_settle`
 * gained its `continue` field mid-1.x, `tool_result.content` moved from a
 * string to content blocks, and `tool_call` gained `parentToolCallId`.
 *
 * Keeping every such assumption here means an upstream change is a change to
 * this file and its tests, not a hunt through the extension. Nothing else in
 * `packages/pi-reflex/src` imports a pi type at runtime.
 *
 * ## What this adapter does *not* pretend
 *
 * pi has no hard veto on turn ending. `agent_before_settle` can append entries
 * and ask for exactly one more model request; it cannot refuse to stop. So this
 * module models the closing check as two ledger outcomes — `closing-block`,
 * which the hosts with a real veto (Claude Code, DSH) record, and
 * `closing-degraded-pass`, which pi records when a contradiction survives the
 * single continuation it is allowed to request. The second is a pass, recorded
 * as one. It is not spelled `block` anywhere, and {@link ClosingDegradeState}
 * never requests a second continuation.
 *
 * @module pi-reflex/pi-adapter
 */
import type { HookEvent } from '../../../src/hook/contract.js';

/**
 * The subset of a pi `tool_call` event the decision needs.
 *
 * Declared structurally rather than imported so this file compiles against the
 * root package alone; the real pi event satisfies it.
 */
export interface PiToolCallEventLike {
  readonly type?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly parentToolCallId?: string;
}

/** A pi text or image content block, reduced to what the decision reads. */
export interface PiContentBlockLike {
  readonly type: string;
  readonly text?: string;
}

/** The subset of a pi `tool_result` event the decision needs. */
export interface PiToolResultEventLike {
  readonly type?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly PiContentBlockLike[];
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly parentToolCallId?: string;
}

/** What `HookDecision.handle` receives for a tool call or result. */
export interface HookPayload extends Record<string, unknown> {
  session_id: string;
  tool_use_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_response?: unknown;
  error?: string;
}

/** The two outcome labels the ledger uses for a closing check. */
export const CLOSING_BLOCK = 'closing-block' as const;
/** pi ran its one allowed continuation and the contradiction persisted. */
export const CLOSING_DEGRADED_PASS = 'closing-degraded-pass' as const;
/**
 * pi's continuation actually fixed the claim, or there was nothing to object to.
 *
 * This outcome produces no extension ledger line: a clean settle is the ordinary
 * case. The constant exists so the vocabulary is complete and a reader can see
 * that "clean" was considered rather than forgotten.
 */
export const CLOSING_CLEAN = 'closing-clean' as const;

/** How one closing check ended, as the ledger records it. */
export type ClosingOutcome = typeof CLOSING_BLOCK | typeof CLOSING_DEGRADED_PASS | typeof CLOSING_CLEAN;

/**
 * Reduce pi's content blocks to the single text the decision reads.
 *
 * Image blocks carry no text and are skipped, matching what
 * `toolResponseText` already does for a host that sends a mixed array.
 * @param content - the blocks pi produced.
 * @returns the joined text, `''` for no text blocks.
 */
export function textOfBlocks(content: readonly PiContentBlockLike[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Normalize one pi `tool_call` event into the hook payload.
 *
 * `tool_input` is passed through untouched: the decision instance-digests it
 * for the stagnation signature, so any normalization here would change which
 * calls count as repeats.
 * @param event - the pi event.
 * @param sessionId - the session the call belongs to.
 * @returns the payload `HookDecision.handle('pretooluse', …)` expects.
 */
export function toolCallPayload(event: PiToolCallEventLike, sessionId: string): HookPayload {
  return {
    session_id: sessionId,
    tool_use_id: event.toolCallId,
    tool_name: event.toolName,
    tool_input: event.input ?? {}
  };
}

/**
 * Normalize one pi `tool_result` event into the hook payload.
 *
 * The result is handed to the decision in the `tool_response` shape it already
 * understands (`{ content: [{type:'text', text}] }` plus `isError`), so the
 * shared `toolResponseText` / `toolResponseFailed` readers apply unchanged and
 * the prune decision is byte-for-byte the one the other hosts take.
 * @param event - the pi event.
 * @param sessionId - the session the call belongs to.
 * @returns the payload both `posttooluse` and `postfailure` accept.
 */
export function toolResultPayload(event: PiToolResultEventLike, sessionId: string): HookPayload {
  const payload: HookPayload = {
    session_id: sessionId,
    tool_use_id: event.toolCallId,
    tool_name: event.toolName,
    tool_input: event.input ?? {},
    tool_response: {
      content: event.content.map((block) => ({ type: block.type, text: block.text })),
      isError: event.isError === true
    }
  };
  if (event.isError === true) payload.error = textOfBlocks(event.content) || 'tool call failed';
  return payload;
}

/**
 * The hook event that carries a pi tool result.
 *
 * A failed call reaches *both* the failure path and the prune path in the
 * shared decision; pi delivers one `tool_result` for either, so the adapter
 * tells the caller which one to dispatch by the result's own `isError`.
 * @param isError - whether pi marked the result as failed.
 * @returns `postfailure` for an error, `posttooluse` otherwise.
 */
export function resultEventFor(isError: boolean): HookEvent {
  return isError ? 'postfailure' : 'posttooluse';
}

/**
 * The replacement content blocks for a pruned result.
 *
 * pi keeps `content` as blocks, so the pruned text goes back as a single text
 * block. Images in the original are dropped: the shared decision's replacement
 * path is textual by construction, and claiming to have kept them would make
 * the result differ from what the ledger recorded.
 * @param text - the pruned text.
 * @returns the content array to return from the `tool_result` handler.
 */
export function replaceBlocks(text: string): PiContentBlockLike[] {
  return [{ type: 'text', text }];
}

/** What the closing check decided for one settle, before the host acts on it. */
export interface ClosingPlan {
  /** `block` when a host with a veto would refuse; `continue` when pi asks for one more request. */
  action: 'block' | 'continue' | 'clean' | 'skip';
  /** The corrective text, empty when the action carries none. */
  text: string;
  /**
   * The pi-specific ledger label to record, or `null` when there is nothing to
   * record: a clean settle is the ordinary case and does not deserve a line, and
   * a `continue` is recorded by the shared decision's own ledger.
   */
  outcome: typeof CLOSING_DEGRADED_PASS | null;
  /** Why nothing happened, when `action` is `skip`. */
  skipReason?: string;
}

/**
 * Tracks how many closing continuations the current turn has already spent.
 *
 * pi's `agent_before_settle` fires once per settle attempt, and each call may
 * ask for *one* more model request. Without this state an extension that
 * objects on every contradiction would loop forever — the mistake the upstream
 * docs explicitly warn about.
 *
 * The rule is the one the goal fixed: at most one continuation per turn. A
 * second contradictory settle consumes the pass, releases it, and is recorded
 * as {@link CLOSING_DEGRADED_PASS}. The class models pi honestly: the request
 * it returns is a *request for one more turn*, never a refusal to stop.
 */
export class ClosingDegradeState {
  readonly #maxContinues: number;
  #turn = -1;
  #spent = 0;

  /**
   * @param maxContinues - continuations allowed per turn; the goal fixes it at 1.
   */
  constructor(maxContinues = 1) {
    if (!Number.isInteger(maxContinues) || maxContinues < 0) {
      throw new Error(`maxContinues must be a non-negative integer, got ${String(maxContinues)}`);
    }
    this.#maxContinues = maxContinues;
  }

  /** Continuations already requested in the current turn. */
  get spent(): number {
    return this.#spent;
  }

  /** The turn this state is tracking, or `-1` before the first settle. */
  get turn(): number {
    return this.#turn;
  }

  /**
   * Start tracking a turn, letting the continuation allowance refill.
   *
   * Called from `turn_end`, which pi fires once per completed turn. A repeated
   * call for the turn already tracked is a no-op, so a re-entrant settle cannot
   * hand the turn a second allowance.
   * @param turn - the turn index pi reports.
   */
  beginTurn(turn: number): void {
    if (this.#turn === turn) return;
    this.#turn = turn;
    this.#spent = 0;
  }

  /**
   * Decide what to do with one settle.
   *
   * The three cases are deliberately distinct so the ledger can tell them
   * apart, and so "we gave up" never looks like "we blocked":
   * - no contradiction → `clean`, nothing requested, nothing recorded;
   * - contradiction, allowance left → `continue`, request one more request
   *   (the shared decision's own ledger line already records the judgment);
   * - contradiction, allowance spent → `skip` recorded as
   *   {@link CLOSING_DEGRADED_PASS}, and the settle proceeds unmodified.
   *
   * (A contaminated-cache worry is not modelled here: the allowlist is the
   * turn counter, and only an explicit `beginTurn` refills it.)
   * @param contradicted - the claims the closing judgment refuted; empty means clean.
   * @param correction - the corrective text to append when continuing.
   * @returns the plan the caller executes.
   */
  decide(contradicted: readonly string[], correction: string): ClosingPlan {
    if (contradicted.length === 0) return { action: 'clean', text: '', outcome: null };
    if (this.#spent >= this.#maxContinues) {
      return {
        action: 'skip',
        text: '',
        outcome: CLOSING_DEGRADED_PASS,
        skipReason: 'continuation-budget-spent'
      };
    }
    this.#spent += 1;
    return { action: 'continue', text: correction, outcome: null };
  }
}

/**
 * Whether a settle may be asked for another request at all.
 *
 * pi only honours `continue: true` when its own preview says the rebuilt
 * context can run. Asking otherwise makes pi log
 * "requested continuation without runnable model context" and drop it, so the
 * adapter checks first and reports the refusal as its own skip.
 * @param canContinue - `event.context.canContinue` from pi.
 * @returns whether a continuation request would be honoured.
 */
export function continuationPossible(canContinue: boolean | undefined): boolean {
  return canContinue !== false;
}

/**
 * Build the corrective text a degraded closing appends.
 *
 * It states the contradiction and what to do about it. It never claims the stop
 * was refused, because pi cannot refuse one.
 * @param contradicted - the refuted statements.
 * @returns the message text.
 */
export function closingCorrectionText(contradicted: readonly string[]): string {
  return (
    'harness-reflex: this turn claims completion but its own tool evidence contradicts it: ' +
    `${contradicted.join('; ')}. ` +
    'Address the contradiction or restate the claim with the evidence that supports it. ' +
    '(pi can request this one extra turn but cannot refuse to stop; if the contradiction ' +
    'survives, harness-reflex records closing-degraded-pass and lets the turn end.)'
  );
}

/**
 * The pi event names this extension subscribes to.
 *
 * Named here, once, so `index.ts` wires handlers without spelling a pi-specific
 * string — a rename upstream is then a change to this table and nothing else.
 */
export const PI_EVENTS = {
  sessionStart: 'session_start',
  sessionShutdown: 'session_shutdown',
  turnStart: 'turn_start',
  toolCall: 'tool_call',
  toolResult: 'tool_result',
  /** The settle hook whose result pi accepts as "one more request, please". */
  beforeSettle: 'agent_before_settle'
} as const;

/**
 * The subset of a pi `agent_before_settle` event the extension reads.
 *
 * Deliberately *not* reading `entries`: those are the drafts a handler may
 * append, and at settle time they hold only what an earlier handler queued. The
 * assistant's closing words are in `context.contextMessages`, which is the
 * preview pi built for the settle itself.
 */
export interface PiBeforeSettleEventLike {
  readonly type?: string;
  readonly entries?: readonly unknown[];
  readonly context?: {
    readonly canContinue?: boolean;
    readonly contextMessages?: readonly PiAgentMessageLike[];
  };
}

/** A pi agent message, reduced to the fields the closing check reads. */
export interface PiAgentMessageLike {
  readonly role?: string;
  readonly content?: string | readonly PiContentBlockLike[];
}

/**
 * The closing text of one settle: the last assistant message in the preview.
 *
 * pi's `AssistantMessage` carries `role` and `content` directly (no nested
 * `message` wrapper), and a settled transcript normally ends with one or more
 * tool results after the last assistant turn. Walking backwards to the newest
 * assistant message is therefore required, not a nicety.
 * @param messages - the settle's context preview.
 * @returns the assistant's text, or `''` when it produced none.
 */
export function lastAssistantText(messages: readonly PiAgentMessageLike[] | undefined): string {
  if (!messages) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const text = textOfBlocks(message.content as readonly PiContentBlockLike[]);
      if (text) return text;
    }
  }
  return '';
}

/**
 * The closing text a settle presents, read from its context preview.
 * @param event - the settle.
 * @returns the last assistant message's text.
 */
export function settleMessageText(event: PiBeforeSettleEventLike): string {
  return lastAssistantText(event.context?.contextMessages);
}

/**
 * Whether pi can actually run a continuation for this settle.
 * @param event - the settle.
 * @returns whether asking for one more request would be honoured.
 */
export function settleCanContinue(event: PiBeforeSettleEventLike): boolean {
  return continuationPossible(event.context?.canContinue);
}

/** The payload one `agent_before_settle` handler builds for the decision. */
export interface StopPayloadInput {
  sessionId: string;
  /** The assistant's final text for this turn. */
  lastAssistantMessage: string;
  /** Whether a previous closing objection already ran in this turn. */
  stopHookActive: boolean;
}

/**
 * Normalize the closing event into the hook payload.
 *
 * `stop_hook_active` is what keeps the shared decision from objecting to the
 * same turn twice: the continuation pi is asked for arrives as a second settle,
 * and the decision's own guard treats it as the guarded allow path. pi has no
 * such flag, so the adapter carries the count of continuations already spent
 * this turn into that field — which is exactly the semantics the contract means
 * by it.
 * @param input - the settle's facts.
 * @returns the payload `HookDecision.handle('stop', …)` expects.
 */
export function stopPayload(input: StopPayloadInput): Record<string, unknown> {
  return {
    session_id: input.sessionId,
    last_assistant_message: input.lastAssistantMessage,
    stop_hook_active: input.stopHookActive
  };
}
