/**
 * Conversation row for the adaptive reasoning-effort decisions of one turn.
 *
 * The row is a *reading* of the session log, not a second source of truth: it
 * matches the `plugin:dsh-reflex/effort` records the Host already writes, one
 * per adaptive decision, and aggregates every step of a turn into one line with
 * the per-step evidence behind a disclosure. Nothing here is sent to a model —
 * the record type is `ignorable` and outside the message-projecting event set,
 * so it can be rendered without widening the prompt (see `session-audit.ts`).
 *
 * Three matching decisions are worth naming:
 *
 * - **A turn starts from either side.** `turn/start` is the ordinary start, but
 *   a resumed or paged history can hand the row an effort record with no
 *   `turn/start` in the loaded window; the record then starts the context too,
 *   which the engine supports by routing later start matches through `update`.
 * - **Steps are keyed by step number.** A retried step overwrites its own entry
 *   instead of appending a second line, so the row always shows the decision
 *   that was actually dispatched; records without a step number fall back to
 *   event order.
 * - **`user/message` only anchors.** It moves the row under the prompt of the
 *   turn it belongs to, so the status line reads as part of that exchange.
 *
 * The component needs no state of its own: the disclosure is a native
 * `<details>`, which keeps the bundle free of a hook the shell's React build
 * would have to provide.
 *
 * @module dsh-reflex/client/effort-row
 */
import { createElement as h, type ReactNode } from 'react';

import { en } from './locale';
import { interpolate, levelTone } from './panel';

/** Session-log record type the Host writes for one adaptive decision. */
export const EFFORT_RECORD_TYPE = 'plugin:dsh-reflex/effort';

/** View target this row renders on. */
export const EFFORT_ROW_TARGET = 'chat';

/** Definition kind; also the chat-slot entry key the shell dispatches on. */
export const EFFORT_ROW_KIND = 'reflex-effort';

/** Slot this row registers into. */
export const EFFORT_ROW_SLOT = 'conversation.chat.node';

/**
 * One event as the conversation engine hands it to a definition.
 *
 * Only the envelope fields this row reads are declared: `type` and `seq` are
 * always present, `data` is owner-defined JSON, and `surfaceOp` distinguishes a
 * committed message from a log-only record.
 */
export interface ConversationEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: Record<string, unknown>;
  readonly surfaceOp?: unknown;
}

/** One accepted match: the event plus the lifecycle role the definition claimed. */
export interface ConversationMatchLike {
  readonly event: ConversationEventLike;
  readonly role: 'start' | 'update';
  readonly location?: unknown;
}

/** Engine-owned identity of one definition context. */
export interface ConversationContextLike {
  readonly key: string;
  readonly id: string;
  readonly matches?: readonly ConversationMatchLike[];
  readonly start?: ConversationMatchLike;
  readonly state?: EffortRowState;
  /** Reader for earlier matches; unused here but part of the contract shape. */
  readonly reader?: unknown;
}

/** Identity and lifecycle role one event claims from this definition. */
export interface ConversationMatchResultLike {
  readonly id: string;
  readonly role: 'start' | 'update';
}

/** Definition contribution shape the client's `uiConversation.events` accepts. */
export interface ConversationNodeDefinitionLike {
  readonly kind: string;
  readonly target: string;
  /**
   * Claim one event. The engine calls this for **every** event — a Definition
   * is not routed by event type — so an unrelated event must be cheap and
   * return null.
   */
  readonly match: (event: ConversationEventLike) => ConversationMatchResultLike | null;
  readonly start: (context: ConversationContextLike, match: ConversationMatchLike) => EffortRowState;
  readonly update: (context: ConversationContextLike & { state: EffortRowState }, match: ConversationMatchLike) => EffortRowState;
  readonly buildViewNode?: (context: ConversationContextLike) => unknown;
}

/** Client face that owns conversation definitions. */
export interface UiConversationLike {
  readonly events: { register(definition: ConversationNodeDefinitionLike): () => void };
}

/** One step's decision, losslessly carried through to the disclosure. */
export interface EffortRowStep {
  /** Session sequence of the record this entry came from. */
  readonly seq: number;
  /** Step within the turn, when the record named one. */
  readonly step?: number;
  readonly level: string;
  readonly applied?: string;
  readonly outcome: string;
  readonly trigger: string;
  readonly source: string;
  readonly confidence: number;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
  readonly line: string;
  readonly at: number;
  readonly supportedEfforts?: readonly string[];
  readonly basis?: readonly string[];
  readonly degradedReason?: string;
  readonly switched?: boolean;
  readonly heldForCache?: boolean;
  readonly requestedProvider?: string;
  readonly requestedModel?: string;
}

/** Aggregated state of one turn. */
export interface EffortRowState {
  readonly turn: number;
  readonly steps: readonly EffortRowStep[];
  /** Sequence of the last user message of this turn, when one was seen. */
  readonly userSeq?: number;
  /** Step number the most recent record named, for the transient live row. */
  readonly lastStep?: number;
}

/** Payload carried by one rendered row. */
export interface EffortRowData {
  readonly turn: number;
  readonly steps: readonly EffortRowStep[];
  readonly latest: EffortRowStep;
}

/** Props the chat slot hands to {@link EffortRowView}. */
export interface EffortRowProps {
  readonly node: { readonly data?: EffortRowData; readonly kind?: string } & Record<string, unknown>;
  readonly t?: (key: string) => string;
}

/** Read a finite number from an untrusted payload field. */
function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a string from an untrusted payload field. */
function stringAt(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read a string list from an untrusted payload field. */
function stringsAt(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...(value as string[])] : undefined;
}

/** Turn number one event belongs to, when it names one. */
export function turnOfEvent(event: ConversationEventLike): number | undefined {
  return numberAt(event.data?.['turn']);
}

/**
 * Project one effort record into a row entry.
 *
 * Every field is validated on read: a restored log carries whatever an earlier
 * build wrote, so a malformed record degrades to a sparse entry instead of
 * breaking the row.
 *
 * @param event - the `plugin:dsh-reflex/effort` record.
 * @returns the entry, or `undefined` when the record names no level.
 */
export function stepOfRecord(event: ConversationEventLike): EffortRowStep | undefined {
  const data = event.data;
  if (data === undefined) return undefined;
  const level = stringAt(data['level']);
  if (level === undefined) return undefined;
  const applied = stringAt(data['applied']);
  const step = numberAt(data['step']);
  const basis = stringsAt(data['basis']);
  const supported = stringsAt(data['supportedEfforts']);
  const degraded = stringAt(data['degradedReason']);
  const requestedProvider = stringAt(data['requestedProvider']);
  const requestedModel = stringAt(data['requestedModel']);

  return {
    seq: event.seq,
    ...(step === undefined ? {} : { step }),
    level,
    ...(applied === undefined ? {} : { applied }),
    outcome: stringAt(data['outcome']) ?? 'unknown',
    trigger: stringAt(data['trigger']) ?? 'unknown',
    source: stringAt(data['source']) ?? 'unknown',
    confidence: numberAt(data['confidence']) ?? 0,
    latencyMs: numberAt(data['latencyMs']) ?? 0,
    provider: stringAt(data['provider']) ?? '',
    model: stringAt(data['model']) ?? '',
    line: stringAt(data['line']) ?? level,
    at: numberAt(data['at']) ?? event.time ?? 0,
    ...(supported === undefined ? {} : { supportedEfforts: supported }),
    ...(basis === undefined ? {} : { basis }),
    ...(degraded === undefined ? {} : { degradedReason: degraded }),
    ...(data['switched'] === true ? { switched: true } : {}),
    ...(data['heldForCache'] === true ? { heldForCache: true } : {}),
    ...(requestedProvider === undefined ? {} : { requestedProvider }),
    ...(requestedModel === undefined ? {} : { requestedModel })
  };
}

/** Order key of one entry: by step number, then by the sequence it came from. */
function rankOf(step: EffortRowStep): number {
  return step.step ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Insert or replace one entry, keeping the list ordered by step then sequence.
 *
 * @param steps - current entries.
 * @param entry - the entry to upsert.
 * @returns the next entries, or the same array when nothing changed.
 */
export function upsertStep(steps: readonly EffortRowStep[], entry: EffortRowStep): readonly EffortRowStep[] {
  const sameEntry = (candidate: EffortRowStep): boolean =>
    candidate.step === undefined || entry.step === undefined
      ? candidate.seq === entry.seq
      : candidate.step === entry.step;
  const kept = steps.filter((candidate) => !sameEntry(candidate));
  if (kept.length === steps.length && steps.some((candidate) => candidate === entry)) return steps;
  return [...kept, entry].sort((left, right) => rankOf(left) - rankOf(right) || left.seq - right.seq);
}

/** Empty state for one turn. */
function stateOf(turn: number): EffortRowState {
  return { turn, steps: [] };
}

/**
 * Apply one matched event to a turn's state.
 *
 * @param state - state before the event.
 * @param match - the accepted match.
 * @returns the next state, or the same object when the event changed nothing.
 */
function applyEvent(state: EffortRowState, match: ConversationMatchLike): EffortRowState {
  const event = match.event;
  if (event.type === EFFORT_RECORD_TYPE) {
    const entry = stepOfRecord(event);
    if (entry === undefined) return state;
    const steps = upsertStep(state.steps, entry);
    const lastStep = entry.step ?? state.lastStep;
    if (steps === state.steps && lastStep === state.lastStep) return state;
    return { ...state, steps, ...(lastStep === undefined ? {} : { lastStep }) };
  }
  if (event.type === 'user/message') {
    return state.userSeq === event.seq ? state : { ...state, userSeq: event.seq };
  }
  return state;
}

/**
 * Claim one turn from an event, or decline it.
 *
 * @param event - candidate event.
 * @returns the claim, or null when the event is not this row's business.
 */
function claimTurn(event: ConversationEventLike, role: 'start' | 'update'): ConversationMatchResultLike | null {
  const turn = turnOfEvent(event);
  if (turn === undefined) return null;
  return { id: String(turn), role };
}

/**
 * The definition the client registers.
 *
 * An effort record starts the context as well as updating it: the record is the
 * only event guaranteed to be present when the conversation is restored from a
 * log window that begins mid-turn.
 */
export const effortRowDefinition: ConversationNodeDefinitionLike = {
  kind: EFFORT_ROW_KIND,
  target: EFFORT_ROW_TARGET,
  match: (event) => {
    if (event.type === 'turn/start') return claimTurn(event, 'start');
    // A record can also *start* a turn's context: a restored window may begin
    // mid-turn, and the engine routes a later start match through `update`.
    if (event.type === EFFORT_RECORD_TYPE) return claimTurn(event, 'start');
    if (event.type === 'user/message' && event.surfaceOp === 'append') return claimTurn(event, 'update');
    return null;
  },
  start: (context, match) => applyEvent(stateOf(turnOfEvent(match.event) ?? 0), match),
  update: (context, match) => applyEvent(context.state, match),
  buildViewNode: (context) => {
    const state = context.state;
    if (state === undefined || state.steps.length === 0) return null;
    const latest = state.steps[state.steps.length - 1];
    // Just after the newest decision record: the row reads as the status of the
    // request that record belongs to, and it walks down the turn as steps land.
    const anchor = latest.seq;
    return {
      key: context.key,
      kind: EFFORT_ROW_KIND,
      id: context.id,
      target: EFFORT_ROW_TARGET,
      // Just below the prompt of the turn, so the line reads as its status.
      anchorSeq: anchor + 0.02,
      location: context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { turn: state.turn, steps: state.steps, latest }
    };
  }
};

/** Design token with a literal fallback, so an unthemed host still renders. */
function token(name: string, fallback: string): string {
  return `var(${name}, ${fallback})`;
}

/** Style kit of the row: one place for every visual value. */
const S = {
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    margin: '2px 0 6px 0',
    padding: '6px 10px',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: '18px',
    border: `1px solid ${token('--dsw-alias-border-l1', 'rgba(127,127,127,.22)')}`,
    background: token('--dsw-alias-bg-layer-2', 'rgba(127,127,127,.06)'),
    color: token('--dsw-alias-label-tertiary', '#8a8a8a')
  },
  head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  title: { color: token('--dsw-alias-label-secondary', '#b4b4b4'), fontWeight: 600 },
  badge: {
    padding: '0 6px',
    borderRadius: '999px',
    fontSize: '11px',
    border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(127,127,127,.3)')}`
  },
  route: { color: token('--dsw-alias-label-caption', '#777') },
  summary: {
    cursor: 'pointer',
    color: token('--dsw-alias-label-tertiary', '#8a8a8a'),
    listStyle: 'none' as const
  },
  body: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' },
  table: { borderCollapse: 'collapse' as const, fontSize: '11px', width: '100%' },
  cell: {
    padding: '2px 8px 2px 0',
    textAlign: 'left' as const,
    borderBottom: `1px solid ${token('--dsw-alias-border-l1', 'rgba(127,127,127,.14)')}`,
    color: token('--dsw-alias-label-secondary', '#b4b4b4'),
    whiteSpace: 'nowrap' as const
  },
  evidence: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' },
  line: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    color: token('--dsw-alias-label-caption', '#777'),
    overflowWrap: 'anywhere' as const
  }
};

/** Translator with an English fallback, so the row renders outside the shell too. */
function translator(props: EffortRowProps): (key: string) => string {
  const bound = props.t;
  if (bound !== undefined) return bound;
  return (key) => (en as Record<string, string>)[key] ?? key;
}

/** One `level → applied` thought, in words the reader can scan. */
function thinkingText(step: EffortRowStep, t: (key: string) => string): string {
  const applied = step.applied ?? t('rowClearedShort');
  return `${step.level} → ${applied} (${step.outcome})`;
}

/** Level chip whose colour follows the ladder, not the outcome. */
function levelChip(step: EffortRowStep): unknown {
  return h(
    'span',
    { key: 'level', style: { color: token(levelTone(step.level), '#b4b4b4'), fontWeight: 600 } },
    step.level
  );
}

/** Route of one step, naming the move when routing changed it. */
function routeText(step: EffortRowStep, t: (key: string) => string): string {
  const target = step.provider === '' && step.model === '' ? t('rowRouteUnknown') : `${step.provider}/${step.model}`;
  const suffix = step.heldForCache ? ` (${t('rowHeldForCache')})` : '';
  // No physical switch does not mean no virtual selection: expose the logged
  // origin even when cache affinity retained the same physical target.
  const virtualOrigin = step.requestedProvider === 'reflex' && step.provider !== 'reflex';
  if (step.switched !== true && !virtualOrigin) return `${target}${suffix}`;
  const from = step.requestedProvider === undefined ? undefined : `${step.requestedProvider}/${step.requestedModel ?? '?'}`;
  return from === undefined ? `${target} (${t('rowSwitched')})${suffix}` : `${from} → ${target}${suffix}`;
}

/** Per-step evidence table. */
function stepTable(steps: readonly EffortRowStep[], t: (key: string) => string): unknown {
  const head = h(
    'tr',
    { key: 'head' },
    h('th', { style: S.cell }, t('rowStep')),
    h('th', { style: S.cell }, t('rowThinking')),
    h('th', { style: S.cell }, t('rowSource')),
    h('th', { style: S.cell }, t('rowConfidence')),
    h('th', { style: S.cell }, t('rowLatency')),
    h('th', { style: S.cell }, t('rowRoute'))
  );
  const rows = steps.map((step, index) =>
    h(
      'tr',
      { key: `${step.step ?? index}:${step.seq}` },
      h('td', { style: S.cell }, step.step === undefined ? `#${index + 1}` : String(step.step)),
      h('td', { style: S.cell }, levelChip(step), ` → ${step.applied ?? t('rowClearedShort')} (${step.outcome})`),
      h('td', { style: S.cell }, `${step.trigger} · ${step.source}`),
      h('td', { style: S.cell }, step.confidence.toFixed(2)),
      h('td', { style: S.cell }, `${Math.round(step.latencyMs)}ms`),
      h('td', { style: S.cell }, routeText(step, t))
    )
  );
  return h('table', { style: S.table }, h('thead', { key: 'thead' }, head), h('tbody', { key: 'tbody' }, rows));
}

/** Evidence of the latest decision, when the Host recorded any. */
function evidenceList(step: EffortRowStep, t: (key: string) => string): unknown[] {
  const items: unknown[] = [];
  if (step.basis !== undefined && step.basis.length > 0) {
    items.push(
      h('div', { key: 'basis' }, `${t('rowEvidence')}: ${step.basis.join(' · ')}`)
    );
  }
  if (step.supportedEfforts !== undefined && step.supportedEfforts.length > 0) {
    items.push(
      h('div', { key: 'supported' }, `${t('rowSupported')}: ${step.supportedEfforts.join(', ')}`)
    );
  } else if (step.supportedEfforts !== undefined) {
    items.push(h('div', { key: 'supported' }, `${t('rowSupported')}: ${t('rowNone')}`));
  }
  if (step.degradedReason !== undefined) {
    items.push(h('div', { key: 'degraded' }, `${t('rowDegraded')}: ${step.degradedReason}`));
  }
  if (step.heldForCache) {
    items.push(h('div', { key: 'heldForCache' }, `${t('rowRouteStrategy')}: ${t('rowHeldForCacheDetail')}`));
  }
  items.push(h('div', { key: 'line', style: S.line }, step.line));
  return items;
}

/**
 * Render one turn's effort status line with its evidence behind a disclosure.
 *
 * @param props - the row's node data and the slot-bound translator.
 * @returns the row element, or null when the node carries no decision.
 */
export function EffortRowView(props: EffortRowProps): ReactNode {
  const data = props.node?.data;
  if (data === undefined || data.steps.length === 0) return null;
  const t = translator(props);
  const latest = data.latest;
  const head = h(
    'div',
    { style: S.head, key: 'head' },
    h('span', { style: S.title, key: 'title' }, t('rowTitle')),
    levelChip(latest),
    h('span', { key: 'thinking' }, thinkingText(latest, t)),
    h('span', { style: S.route, key: 'route' }, routeText(latest, t)),
    data.steps.length > 1
      ? h('span', { style: S.badge, key: 'steps' }, interpolate(t('rowSteps'), { count: String(data.steps.length) }))
      : null
  );

  const body = h(
    'div',
    { style: S.body, key: 'body' },
    data.steps.length > 1 ? stepTable(data.steps, t) : null,
    h('div', { style: S.evidence, key: 'evidence' }, evidenceList(latest, t))
  );

  // A native disclosure keeps the row stateless: no hook, no client-side
  // expansion model, and it works in every render mode the shell uses.
  return h(
    'details',
    { style: S.row, 'data-reflex-turn': String(data.turn), key: 'row' },
    h('summary', { style: S.summary, key: 'summary' }, head, h('span', { key: 'hint' }, ` · ${t('rowDetails')}`)),
    body
  );
}

/** Slot for composer indicator beside model selector. */
export const COMPOSER_INDICATOR_SLOT = 'conversation.input.right';

/** Props passed to ComposerEffortIndicator by conversation.input.right */
export interface ComposerIndicatorProps {
  readonly useSession?: (selector?: (s: any) => any) => any;
  readonly useProjection?: (key: string) => any;
  readonly t?: (key: string) => string;
}

/**
 * Pill rendered at the right of composer (directly to the left of ModelSelect)
 * indicating the actual routed physical model and actual decided reasoning effort.
 */
export function ComposerEffortIndicator(props: ComposerIndicatorProps): ReactNode {
  const t = props.t ?? ((key: string) => (en as Record<string, string>)[key] ?? key);
  
  // This Host-owned projection folds this Session's own effort records,
  // request headers and explicit selections. modelSelection.next falls back
  // to lastUsed and therefore cannot retain adaptive intent after a header.
  const actualState = props.useProjection?.('reflexActual');
  const modelSelection = props.useProjection?.('modelSelection');
  const next = modelSelection?.next;
  // Durable adaptive intent stays pending after a physical header. Legacy logs
  // may contain an old virtual effort but no persisted intent; a now-fixed
  // selection must not resurrect that historical decision in the composer.
  if (next?.provider !== 'reflex' && next?.reasoningEffort !== 'reflex' && next?.reasoningEffort !== 'auto') return null;
  const lastUsed = actualState?.adaptive === true ? actualState.actual : null;
  if (typeof lastUsed?.provider !== 'string' || lastUsed.provider === 'reflex' ||
      typeof lastUsed?.model !== 'string' || !lastUsed.model) return null;
  const parts = [`${lastUsed.provider}/${lastUsed.model}`];
  if (typeof lastUsed.reasoningEffort === 'string' &&
      lastUsed.reasoningEffort !== 'reflex' && lastUsed.reasoningEffort !== 'auto') {
    parts.push(lastUsed.reasoningEffort);
  }
  const content = parts.join(' · ');

  return h(
    'div',
    {
      key: 'reflex-composer-indicator',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '2px 8px',
        borderRadius: '6px',
        fontSize: '12px',
        lineHeight: '16px',
        color: token('--dsw-alias-label-secondary', '#b4b4b4'),
        background: token('--dsw-alias-bg-layer-2', 'rgba(127,127,127,.08)'),
        border: `1px solid ${token('--dsw-alias-border-l1', 'rgba(127,127,127,.18)')}`,
        marginRight: '2px',
        userSelect: 'none',
        pointerEvents: 'none'
      }
    },
    h('span', {
      key: 'dot',
      style: {
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        background: token('--dsw-alias-state-business-primary', '#3b82f6')
      }
    }),
    h('span', { key: 'label' }, `${t('composerActual')}: ${content}`)
  );
}

/**
 * Register the row on the conversation surface and composer indicator.
 *
 * The definition is keyed by its kind, so a second activation of this plugin
 * would collide rather than double-render; the shell's registry rejects the
 * duplicate, which is why the caller registers inside one `effect`.
 *
 * @param ctx - client context carrying `uiConversation` and `slots`.
 * @param registerSlot - register slot entries.
 * @param locale - dictionary namespace the slot binds for the component.
 * @returns the disposer that removes both contributions.
 */
export function registerEffortRow(
  conversation: UiConversationLike,
  registerSlot: (options: { name: string; key?: string; id?: string; order?: number; locale?: string }, component: (props: any) => ReactNode) => () => void,
  locale?: string
): () => void {
  const unbindDefinition = conversation.events.register(effortRowDefinition);
  const unbindSlot = registerSlot(
    { name: EFFORT_ROW_SLOT, key: EFFORT_ROW_KIND, ...(locale === undefined ? {} : { locale }) },
    EffortRowView
  );
  const unbindIndicator = registerSlot(
    { name: COMPOSER_INDICATOR_SLOT, id: 'reflex-composer-indicator', order: 10, ...(locale === undefined ? {} : { locale }) },
    ComposerEffortIndicator
  );
  return () => {
    unbindIndicator();
    unbindSlot();
    unbindDefinition();
  };
}
