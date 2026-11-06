import type { Context } from '@deepseek-ai/cordis';

import { isEffortTrigger } from './effort.js';
import { appendEffortInheritRecord, type EffortInheritAuditRecord } from './session-audit.js';

/**
 * Delegated agents cannot decide their own reasoning effort — so let them inherit.
 *
 * ## Why this exists (g-048)
 *
 * `executor.reasoning_effort: "reflex"` marks a deployment as adaptive: the
 * plugin decides the level per turn. For a delegated agent that decision used to
 * be taken inside the `agent/request` waterfall, and `dsh-agent-loop` refuses
 * exactly that — it fixes the step's effort during step preparation and rejects
 * any later proposal:
 *
 *   agent/request proposed reasoning effort "low" after step preparation fixed
 *   "reflex"; use agent.model.select() before step preparation
 *
 * The waterfall may re-route a request; it may not re-decide the effort. And
 * `agent/pre-step` cannot help either: the loop reads `model.current()` for that
 * step *before* the waterfall runs, so a `modelSelection` handed back from
 * `pre-step` is already too late. There is no host hook between "the selection is
 * recorded" and "the step reads it".
 *
 * ## What this does instead (C1)
 *
 * The marker the delegated agent would have decided on is replaced on its own
 * `model/selection` — the very log entry the loop folds to obtain `model.current()`
 * — with the level its parent session is currently using. The step then fixes a
 * concrete level, the request waterfall has nothing left to change, and the loop's
 * contract holds by construction rather than by suppressing a check.
 *
 * ## Why the rewrite is a second `model/selection` event
 *
 * The arriving event is deep-frozen (the Session snapshots and freezes every
 * payload) and the append that published it is still on the stack, so a listener
 * cannot rewrite it in place: `session append cannot reenter while another append
 * is being published`. Returning *before* the projection folds is not an option
 * either — listeners run in registration order, and the projection that serves
 * `model.current()` is registered by the agent runtime, ahead of this plugin.
 *
 * So the rewrite is committed immediately *after* the current append completes,
 * as one further `model/selection`. Only the last one counts: the selection fold
 * takes `pending` from the newest `model/selection`, which is exactly the value
 * `model.current()` returns. Nothing reads the selection in between — the driver
 * reaches its next step only after the current one has fully committed.
 *
 * Deferring also buys the ordering the parent needs. A child's selection may be
 * recorded before the parent has one, and the parent's own level may change
 * later; settling on a microtask keeps the copy current without depending on
 * which session was configured first.
 *
 * ## Boundaries
 *
 * - **Only delegated sessions.** A `delegationDepth > 0` header or a `subagent`
 *   origin marks one; a main session is never touched, so the adaptive behaviour
 *   its deployment asked for is bit-for-bit unchanged.
 * - **Only the marker.** `reflex`/`auto` is rewritten. A concrete level — the
 *   caller's own choice — is left exactly as recorded.
 * - **`effort.enabled: false` keeps today's behaviour**, i.e. nothing happens
 *   here and the interceptor clears the marker later, landing on the adapter's
 *   default. Inheriting the parent's level would silently change what a switched
 *   off deployment does.
 * - **No parent level, no inheritance:** the marker is removed, which is the
 *   adapter's own default — the same outcome the disabled switch has, reached for
 *   a different reason (recorded as such).
 *
 * @module dsh-reflex/effort-delegation
 */

/** The only reason this module rewrites anything. */
export const DELEGATION_EFFORT_REASON = 'subagent-cannot-decide' as const;

/** Structural view of the session header fields delegation is decided on. */
interface SessionHeaderLike {
  origin?: string;
  delegationDepth?: number;
  parentSession?: unknown;
}

/** Structural view of the selection events this module reads and writes. */
interface SelectionData {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** Structural view of a live session. */
interface SessionLike {
  readonly id?: string;
  readonly header?: SessionHeaderLike;
  append(type: string, data: unknown): unknown;
  snapshotEvents?(): readonly { type: string; data?: any }[];
}

/** What {@link installDelegatedEffortInheritance} needs from the activation. */
export interface DelegatedEffortInheritanceOptions {
  /**
   * Read the live `effort.enabled` switch.
   *
   * A getter, not a value: a config-only settings save flips this without
   * remounting the plugin, and the next delegated selection must see the value
   * actually in force.
   */
  enabled: () => boolean;
  /** Resolve one session id to a live session (the parent lookup). */
  sessionById?: (id: string) => SessionLike | undefined;
  /** Diagnostic sink for non-fatal degradation (never throws). */
  warn?: (message: string) => void;
}

/** What {@link installDelegatedEffortInheritance} installed. */
export interface DelegatedEffortInheritance {
  /** How many delegated selections have been rewritten. */
  readonly rewrites: number;
  /** How many records have been written to child logs. */
  readonly records: number;
  /** Detach the listener; idempotent. */
  dispose(): void;
}

/**
 * Whether one session is a delegated agent's.
 *
 * `delegationDepth` is authoritative when present; `origin: 'subagent'` covers a
 * header written before depth was recorded. A main session has neither.
 * @param header - the session header, when the session has one.
 * @returns whether this session is a delegated child.
 */
export function isDelegatedSession(header: SessionHeaderLike | undefined): boolean {
  if (!header || typeof header !== 'object') return false;
  if (typeof header.delegationDepth === 'number') return header.delegationDepth > 0;
  return header.origin === 'subagent';
}

/**
 * Read the concrete level a selection carries.
 * @param selection - the selection to inspect.
 * @returns the level, or undefined when it carries none (or carries the marker).
 */
function concreteLevel(selection: SelectionData | undefined): string | undefined {
  const effort = selection?.reasoningEffort;
  if (typeof effort !== 'string') return undefined;
  return isEffortTrigger(effort) ? undefined : effort;
}

/**
 * Fold one session's selection the way the host projection does.
 *
 * `model/selection` sets `pending`; a matching `request/header` retires it into
 * `lastUsed`. `model.current()` reads `pending ?? lastUsed`, so this is the exact
 * value the loop would fix for the next step.
 * @param session - the session to read.
 * @returns the selection in force, or undefined when none was ever recorded.
 */
export function currentSelectionOf(session: SessionLike | undefined): SelectionData | undefined {
  const events = session?.snapshotEvents?.() ?? [];
  let pending: SelectionData | undefined;
  let lastUsed: SelectionData | undefined;
  const same = (a: SelectionData | undefined, b: SelectionData | undefined): boolean =>
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.provider === b.provider &&
      a.model === b.model &&
      a.reasoningEffort === b.reasoningEffort);
  for (const event of events) {
    if (event.type === 'model/selection') {
      const data = event.data as SelectionData | undefined;
      if (data && typeof data.provider === 'string' && typeof data.model === 'string') pending = data;
      continue;
    }
    if (event.type !== 'request/header') continue;
    const config = (event.data as { header?: { config?: SelectionData } } | undefined)?.header?.config;
    if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') continue;
    lastUsed = config;
    if (same(pending, config)) pending = undefined;
  }
  return pending ?? lastUsed;
}

/**
 * Build the audit record for one rewrite.
 * @param selection - the child selection that carried the marker.
 * @param requested - the marker that was there.
 * @param parentLevel - the level copied from the parent, when there was one.
 * @param parentLevel - how the parent looked up.
 * @param agentId - the delegated agent's id.
 * @param depth - the delegated agent's depth.
 * @returns the record payload.
 */
function inheritRecord(
  selection: SelectionData,
  requested: string,
  parentLevel: string | undefined,
  parentState: EffortInheritAuditRecord['parentLevel'],
  agentId: string | undefined,
  depth: number | undefined
): EffortInheritAuditRecord {
  return {
    requested,
    applied: parentLevel ?? null,
    reason: DELEGATION_EFFORT_REASON,
    ...(parentLevel === undefined ? {} : { inherited: parentLevel }),
    parentLevel: parentState,
    provider: selection.provider,
    model: selection.model,
    line:
      parentLevel === undefined
        ? `delegated agent: configured "${requested}", cannot decide per turn — marker removed (adapter default)`
        : `delegated agent: configured "${requested}", cannot decide per turn — inherited parent level "${parentLevel}"`,
    at: Date.now(),
    ...(agentId === undefined ? {} : { agentId }),
    ...(depth === undefined ? {} : { delegationDepth: depth })
  };
}

/**
 * Install the delegated-agent effort inheritance.
 *
 * The listener observes `model/selection` on every session and settles the
 * delegated ones off the current append, never inside it.
 * @param ctx - the plugin context whose `session/event` feed is observed.
 * @param options - live policy and the parent lookup.
 * @returns the installation handle.
 */
export function installDelegatedEffortInheritance(
  ctx: Context,
  options: DelegatedEffortInheritanceOptions
): DelegatedEffortInheritance {
  let rewrites = 0;
  let records = 0;
  let disposed = false;

  /**
   * Rewrite one child selection, then record what happened.
   *
   * Every step is best-effort: this runs off a committed event, and an audit or
   * lookup failure must not become a failed turn.
   * @param session - the delegated agent's session.
   * @param selection - the child selection carrying the marker.
   * @param requested - the marker that was there.
   */
  const settle = (session: SessionLike, selection: SelectionData, requested: string): void => {
    if (disposed) return;
    const header = session.header;
    const parentId = header?.parentSession;
    let parentLevel: string | undefined;
    let parentState: EffortInheritAuditRecord['parentLevel'] = 'absent';
    try {
      if (parentId !== undefined && options.sessionById !== undefined) {
        const parent = options.sessionById(String(parentId));
        if (parent === undefined) parentState = 'absent';
        else {
          const level = concreteLevel(currentSelectionOf(parent));
          if (level === undefined) parentState = 'absent';
          else {
            parentLevel = level;
            parentState = 'present';
          }
        }
      }
    } catch (error) {
      // A hostile or half-built session must not swallow the rewrite itself:
      // without a readable parent the marker is removed, which is still valid.
      parentState = 'unreadable';
      parentLevel = undefined;
      options.warn?.(`dsh-reflex: could not read the parent level of a delegated agent: ${String(error)}`);
    }

    try {
      // A second `model/selection` is the rewrite: the fold takes `pending` from
      // the newest one, which is what the next step's `model.current()` reads.
      session.append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        ...(parentLevel === undefined ? {} : { reasoningEffort: parentLevel })
      });
      rewrites += 1;
    } catch (error) {
      options.warn?.(`dsh-reflex: could not inherit a parent effort level: ${String(error)}`);
      return;
    }

    const record = inheritRecord(selection, requested, parentLevel, parentState, session.id, header?.delegationDepth);
    if (appendEffortInheritRecord(session, record) !== undefined) records += 1;
  };

  const stop = ctx.on('session/event', (session: any, event: any) => {
    if (disposed || event?.type !== 'model/selection') return;
    const data = event.data as SelectionData | undefined;
    if (!data || typeof data.provider !== 'string' || typeof data.model !== 'string') return;
    const requested = data.reasoningEffort;
    if (requested === undefined || !isEffortTrigger(requested)) return;
    if (!isDelegatedSession(session?.header)) return;
    // The disabled switch keeps its existing behaviour; the interceptor clears
    // the marker on the way out, so touching the selection here would change it.
    let enabled = true;
    try {
      enabled = options.enabled();
    } catch {
      enabled = true;
    }
    if (!enabled) return;
    // Off the current append: the log cannot be appended to while the event that
    // reported it is still being published.
    queueMicrotask(() => {
      if (disposed) return;
      try {
        settle(session, data, requested);
      } catch (error) {
        options.warn?.(`dsh-reflex: delegated effort inheritance failed: ${String(error)}`);
      }
    });
  });

  return {
    get rewrites(): number {
      return rewrites;
    },
    get records(): number {
      return records;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
    }
  };
}
