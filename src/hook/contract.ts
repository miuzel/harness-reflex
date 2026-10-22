/**
 * The `harness-reflex hook <event>` wire contract.
 *
 * One table, one source of truth: the event aliases a harness may invoke, the
 * stdin shape this implementation reads, the stdout shape it may emit, and the
 * per-event decision budget. The command only ever writes the JSON shape named
 * here, because the host splices stdout into model-visible text and treats any
 * non-JSON byte as a reason.
 *
 * @module hook/contract
 */

/** The events the hook accepts (design §2.5). */
export const HOOK_EVENTS = [
  'pretooluse',
  'posttooluse',
  'postfailure',
  'stop',
  'substop',
  'sessionstart',
  'sessionend'
] as const;

/** One accepted hook event. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The three-state mode every capability shares. */
export type HookMode = 'off' | 'observe' | 'active';

/** Per-event decision budget and the host-side timeout it must stay inside. */
export interface EventBudget {
  /** Internal decision budget; on expiry the hook fails open. */
  budgetMs: number;
  /** The host's own timeout, kept for documentation and the hard deadline. */
  hookTimeoutMs: number;
}

/** Budgets from design §2.5, in the same order as {@link HOOK_EVENTS}. */
export const EVENT_BUDGETS: Record<HookEvent, EventBudget> = {
  pretooluse: { budgetMs: 300, hookTimeoutMs: 1000 },
  posttooluse: { budgetMs: 800, hookTimeoutMs: 2000 },
  postfailure: { budgetMs: 300, hookTimeoutMs: 1000 },
  stop: { budgetMs: 1000, hookTimeoutMs: 2000 },
  substop: { budgetMs: 1000, hookTimeoutMs: 2000 },
  sessionstart: { budgetMs: 1200, hookTimeoutMs: 2000 },
  sessionend: { budgetMs: 1200, hookTimeoutMs: 1500 }
};

/**
 * Resolve an event argument to its canonical name.
 *
 * The documented subcommand names are lowercase; the host's event names are
 * PascalCase. Both are accepted so a wiring mistake is a no-op rather than a
 * crash, and an unknown name is reported to stderr while stdout stays `{}`.
 * @param raw - the first argument after `hook`.
 * @returns the canonical event, or `undefined` when unknown.
 */
export function parseHookEvent(raw: string | undefined): HookEvent | undefined {
  if (!raw) return undefined;
  const name = raw.trim().toLowerCase().replace(/[-_]/g, '');
  if (name === 'pretooluse') return 'pretooluse';
  if (name === 'posttooluse') return 'posttooluse';
  if (name === 'posttoolusefailure' || name === 'postfailure') return 'postfailure';
  if (name === 'stop') return 'stop';
  if (name === 'subagentstop' || name === 'substop') return 'substop';
  if (name === 'sessionstart') return 'sessionstart';
  if (name === 'sessionend') return 'sessionend';
  return undefined;
}

/** A JSON object, as every stdout shape and stdin payload is. */
export type JsonObject = Record<string, unknown>;

/** The `hookSpecificOutput` envelope of the Claude Code hook contract. */
export interface HookSpecificOutput {
  hookEventName: string;
  permissionDecision?: 'deny' | 'allow' | 'ask';
  permissionDecisionReason?: string;
  updatedToolOutput?: string;
  additionalContext?: string;
}

/** The stdout object of a hook invocation. `{}` means "no instruction". */
export interface HookOutput extends JsonObject {
  hookSpecificOutput?: HookSpecificOutput;
  decision?: 'block';
  reason?: string;
}

/** The empty output that always means "allow, no instruction". */
export function emptyHookOutput(): HookOutput {
  return {};
}

/** The output of one PreToolUse denial. */
export function preToolUseDeny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
}

/** The output of one PostToolUse replacement. */
export function postToolUseReplace(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: text } };
}

/** The output of one PostToolUseFailure correction. */
export function postToolUseFailureContext(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: text } };
}

/** The output of one Stop objection. */
export function stopBlock(reason: string): HookOutput {
  return { decision: 'block', reason };
}

/** The output of one SessionStart notice. */
export function sessionStartContext(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}
