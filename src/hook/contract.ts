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

/**
 * Events a host emits that this runtime has no capability for.
 *
 * Codex 0.163.0 fires twelve hook events (`hooks/src/engine/command_runner.rs`).
 * Five of them describe something the decision runtime deliberately does not
 * decide — the prompt is already submitted, the permission is already being
 * asked, the compaction is already happening. They are still *recognized* so a
 * wiring mistake is a silent `{}` instead of a stderr warning on every turn, but
 * they can never produce a decision: `HookDecision.handle` never sees them.
 *
 * This is a separate type from {@link HookEvent} on purpose. Widening `HookEvent`
 * would force every existing `switch` over it to grow a branch, which is exactly
 * the kind of behavior change this adapter is not allowed to make.
 */
export const CODEX_ONLY_HOOK_EVENTS = [
  'userpromptsubmit',
  'permissionrequest',
  'precompact',
  'postcompact',
  'subagentstart',
  'interrupt'
] as const;

/** One host event that is recognized but carries no reflex capability. */
export type CodexOnlyHookEvent = (typeof CODEX_ONLY_HOOK_EVENTS)[number];

/** What one raw event argument resolved to. */
export type ParsedHookEventName =
  | { kind: 'canonical'; event: HookEvent }
  | { kind: 'codex-only'; event: CodexOnlyHookEvent }
  | { kind: 'unknown' };

/** Strip the dashes, underscores and case a host may spell an event with. */
function normalizeEventName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[-_\s]/g, '');
}

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
 * PascalCase, kebab-case, or snake_case depending on the harness. All spellings
 * are accepted so a wiring mistake is a no-op rather than a crash, and an
 * unknown name is reported to stderr while stdout stays `{}`.
 *
 * Kebab-case is handled structurally: `pre-tool-use` loses its separators and
 * becomes `pretooluse`, so the same table serves Claude Code's PascalCase and
 * Codex's `pre-tool-use` without a second list.
 *
 * Events that are recognized but have no capability resolve to `undefined` here;
 * use {@link parseHookEventName} when the difference matters.
 * @param raw - the first argument after `hook`.
 * @returns the canonical event, or `undefined` when unknown or capability-less.
 */
export function parseHookEvent(raw: string | undefined): HookEvent | undefined {
  if (!raw) return undefined;
  const name = normalizeEventName(raw);
  // `post-tool` / `pre-tool` are what a few bundlers spell the Claude Code
  // events as, so the alias table normalizes them instead of silently no-oping.
  if (name === 'pretooluse' || name === 'pretool') return 'pretooluse';
  if (name === 'posttooluse' || name === 'posttool') return 'posttooluse';
  if (name === 'posttoolusefailure' || name === 'postfailure') return 'postfailure';
  if (name === 'stop') return 'stop';
  if (name === 'subagentstop' || name === 'substop') return 'substop';
  if (name === 'sessionstart') return 'sessionstart';
  if (name === 'sessionend') return 'sessionend';
  return undefined;
}

/**
 * Resolve an event argument, distinguishing "no capability" from "unknown".
 *
 * The hook process uses this so that a Codex event the runtime has nothing to
 * say about exits 0 with `{}` and no warning, while a genuine typo still gets one.
 * @param raw - the first argument after `hook`.
 * @returns the discriminated parse result.
 */
export function parseHookEventName(raw: string | undefined): ParsedHookEventName {
  const canonical = parseHookEvent(raw);
  if (canonical) return { kind: 'canonical', event: canonical };
  if (!raw) return { kind: 'unknown' };
  const name = normalizeEventName(raw);
  for (const event of CODEX_ONLY_HOOK_EVENTS) {
    if (name === event) return { kind: 'codex-only', event };
  }
  return { kind: 'unknown' };
}

/** A JSON object, as every stdout shape and stdin payload is. */
export type JsonObject = Record<string, unknown>;

/** The `hookSpecificOutput` envelope of the Claude Code hook contract. */
export interface HookSpecificOutput {
  hookEventName: string;
  permissionDecision?: 'deny' | 'allow' | 'ask';
  permissionDecisionReason?: string;
  updatedToolOutput?: string;
  /**
   * Codex's name for a replaced tool result. It is a *different field* from
   * `updatedToolOutput`, not an alias, and Codex only honors it for MCP tool
   * output — a shell tool result cannot be rewritten at all. Both names are
   * modelled so a host mismatch is a typed mistake instead of a silently
   * ignored field.
   */
  updatedMCPToolOutput?: string;
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

/**
 * The output of one Codex PostToolUse replacement.
 *
 * Codex reads `updatedMCPToolOutput` and only for MCP tools; emitting Claude's
 * `updatedToolOutput` there is silently ignored. Kept as a separate function so
 * the adapter cannot pick the wrong name by accident.
 * @param text - the replacement text for the MCP tool result.
 */
export function postToolUseMcpReplace(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: text } };
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
