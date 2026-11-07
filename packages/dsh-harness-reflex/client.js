window.__ModuleLoader__.load({
	id: "dsh-harness-reflex",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __factories = {
		"effort-row": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.COMPOSER_INDICATOR_SLOT = exports.effortRowDefinition = exports.EFFORT_ROW_SLOT = exports.EFFORT_ROW_KIND = exports.EFFORT_ROW_TARGET = exports.EFFORT_RECORD_TYPE = void 0;
			exports.turnOfEvent = turnOfEvent;
			exports.stepOfRecord = stepOfRecord;
			exports.upsertStep = upsertStep;
			exports.EffortRowView = EffortRowView;
			exports.ComposerEffortIndicator = ComposerEffortIndicator;
			exports.registerEffortRow = registerEffortRow;
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
			const react_1 = require("react");
			const locale_1 = require("./locale");
			const panel_1 = require("./panel");
			/** Session-log record type the Host writes for one adaptive decision. */
			exports.EFFORT_RECORD_TYPE = 'plugin:dsh-reflex/effort';
			/** View target this row renders on. */
			exports.EFFORT_ROW_TARGET = 'chat';
			/** Definition kind; also the chat-slot entry key the shell dispatches on. */
			exports.EFFORT_ROW_KIND = 'reflex-effort';
			/** Slot this row registers into. */
			exports.EFFORT_ROW_SLOT = 'conversation.chat.node';
			/** Read a finite number from an untrusted payload field. */
			function numberAt(value) {
			    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
			}
			/** Read a string from an untrusted payload field. */
			function stringAt(value) {
			    return typeof value === 'string' ? value : undefined;
			}
			/** Read a string list from an untrusted payload field. */
			function stringsAt(value) {
			    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined;
			}
			/** Turn number one event belongs to, when it names one. */
			function turnOfEvent(event) {
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
			function stepOfRecord(event) {
			    const data = event.data;
			    if (data === undefined)
			        return undefined;
			    const level = stringAt(data['level']);
			    if (level === undefined)
			        return undefined;
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
			function rankOf(step) {
			    return step.step ?? Number.MAX_SAFE_INTEGER;
			}
			/**
			 * Insert or replace one entry, keeping the list ordered by step then sequence.
			 *
			 * @param steps - current entries.
			 * @param entry - the entry to upsert.
			 * @returns the next entries, or the same array when nothing changed.
			 */
			function upsertStep(steps, entry) {
			    const sameEntry = (candidate) => candidate.step === undefined || entry.step === undefined
			        ? candidate.seq === entry.seq
			        : candidate.step === entry.step;
			    const kept = steps.filter((candidate) => !sameEntry(candidate));
			    if (kept.length === steps.length && steps.some((candidate) => candidate === entry))
			        return steps;
			    return [...kept, entry].sort((left, right) => rankOf(left) - rankOf(right) || left.seq - right.seq);
			}
			/** Empty state for one turn. */
			function stateOf(turn) {
			    return { turn, steps: [] };
			}
			/**
			 * Apply one matched event to a turn's state.
			 *
			 * @param state - state before the event.
			 * @param match - the accepted match.
			 * @returns the next state, or the same object when the event changed nothing.
			 */
			function applyEvent(state, match) {
			    const event = match.event;
			    if (event.type === exports.EFFORT_RECORD_TYPE) {
			        const entry = stepOfRecord(event);
			        if (entry === undefined)
			            return state;
			        const steps = upsertStep(state.steps, entry);
			        const lastStep = entry.step ?? state.lastStep;
			        if (steps === state.steps && lastStep === state.lastStep)
			            return state;
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
			function claimTurn(event, role) {
			    const turn = turnOfEvent(event);
			    if (turn === undefined)
			        return null;
			    return { id: String(turn), role };
			}
			/**
			 * The definition the client registers.
			 *
			 * An effort record starts the context as well as updating it: the record is the
			 * only event guaranteed to be present when the conversation is restored from a
			 * log window that begins mid-turn.
			 */
			exports.effortRowDefinition = {
			    kind: exports.EFFORT_ROW_KIND,
			    target: exports.EFFORT_ROW_TARGET,
			    match: (event) => {
			        if (event.type === 'turn/start')
			            return claimTurn(event, 'start');
			        // A record can also *start* a turn's context: a restored window may begin
			        // mid-turn, and the engine routes a later start match through `update`.
			        if (event.type === exports.EFFORT_RECORD_TYPE)
			            return claimTurn(event, 'start');
			        if (event.type === 'user/message' && event.surfaceOp === 'append')
			            return claimTurn(event, 'update');
			        return null;
			    },
			    start: (context, match) => applyEvent(stateOf(turnOfEvent(match.event) ?? 0), match),
			    update: (context, match) => applyEvent(context.state, match),
			    buildViewNode: (context) => {
			        const state = context.state;
			        if (state === undefined || state.steps.length === 0)
			            return null;
			        const latest = state.steps[state.steps.length - 1];
			        // Just after the newest decision record: the row reads as the status of the
			        // request that record belongs to, and it walks down the turn as steps land.
			        const anchor = latest.seq;
			        return {
			            key: context.key,
			            kind: exports.EFFORT_ROW_KIND,
			            id: context.id,
			            target: exports.EFFORT_ROW_TARGET,
			            // Just below the prompt of the turn, so the line reads as its status.
			            anchorSeq: anchor + 0.02,
			            location: context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' },
			            visibility: 'visible',
			            data: { turn: state.turn, steps: state.steps, latest }
			        };
			    }
			};
			/** Design token with a literal fallback, so an unthemed host still renders. */
			function token(name, fallback) {
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
			        listStyle: 'none'
			    },
			    body: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' },
			    table: { borderCollapse: 'collapse', fontSize: '11px', width: '100%' },
			    cell: {
			        padding: '2px 8px 2px 0',
			        textAlign: 'left',
			        borderBottom: `1px solid ${token('--dsw-alias-border-l1', 'rgba(127,127,127,.14)')}`,
			        color: token('--dsw-alias-label-secondary', '#b4b4b4'),
			        whiteSpace: 'nowrap'
			    },
			    evidence: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' },
			    line: {
			        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			        fontSize: '11px',
			        color: token('--dsw-alias-label-caption', '#777'),
			        overflowWrap: 'anywhere'
			    }
			};
			/** Translator with an English fallback, so the row renders outside the shell too. */
			function translator(props) {
			    const bound = props.t;
			    if (bound !== undefined)
			        return bound;
			    return (key) => locale_1.en[key] ?? key;
			}
			/** One `level → applied` thought, in words the reader can scan. */
			function thinkingText(step, t) {
			    const applied = step.applied ?? t('rowClearedShort');
			    return `${step.level} → ${applied} (${step.outcome})`;
			}
			/** Level chip whose colour follows the ladder, not the outcome. */
			function levelChip(step) {
			    return (0, react_1.createElement)('span', { key: 'level', style: { color: token((0, panel_1.levelTone)(step.level), '#b4b4b4'), fontWeight: 600 } }, step.level);
			}
			/** Route of one step, naming the move when routing changed it. */
			function routeText(step, t) {
			    const target = step.provider === '' && step.model === '' ? t('rowRouteUnknown') : `${step.provider}/${step.model}`;
			    const suffix = step.heldForCache ? ` (${t('rowHeldForCache')})` : '';
			    // No physical switch does not mean no virtual selection: expose the logged
			    // origin even when cache affinity retained the same physical target.
			    const virtualOrigin = step.requestedProvider === 'reflex' && step.provider !== 'reflex';
			    if (step.switched !== true && !virtualOrigin)
			        return `${target}${suffix}`;
			    const from = step.requestedProvider === undefined ? undefined : `${step.requestedProvider}/${step.requestedModel ?? '?'}`;
			    return from === undefined ? `${target} (${t('rowSwitched')})${suffix}` : `${from} → ${target}${suffix}`;
			}
			/** Per-step evidence table. */
			function stepTable(steps, t) {
			    const head = (0, react_1.createElement)('tr', { key: 'head' }, (0, react_1.createElement)('th', { style: S.cell }, t('rowStep')), (0, react_1.createElement)('th', { style: S.cell }, t('rowThinking')), (0, react_1.createElement)('th', { style: S.cell }, t('rowSource')), (0, react_1.createElement)('th', { style: S.cell }, t('rowConfidence')), (0, react_1.createElement)('th', { style: S.cell }, t('rowLatency')), (0, react_1.createElement)('th', { style: S.cell }, t('rowRoute')));
			    const rows = steps.map((step, index) => (0, react_1.createElement)('tr', { key: `${step.step ?? index}:${step.seq}` }, (0, react_1.createElement)('td', { style: S.cell }, step.step === undefined ? `#${index + 1}` : String(step.step)), (0, react_1.createElement)('td', { style: S.cell }, levelChip(step), ` → ${step.applied ?? t('rowClearedShort')} (${step.outcome})`), (0, react_1.createElement)('td', { style: S.cell }, `${step.trigger} · ${step.source}`), (0, react_1.createElement)('td', { style: S.cell }, step.confidence.toFixed(2)), (0, react_1.createElement)('td', { style: S.cell }, `${Math.round(step.latencyMs)}ms`), (0, react_1.createElement)('td', { style: S.cell }, routeText(step, t))));
			    return (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('thead', { key: 'thead' }, head), (0, react_1.createElement)('tbody', { key: 'tbody' }, rows));
			}
			/** Evidence of the latest decision, when the Host recorded any. */
			function evidenceList(step, t) {
			    const items = [];
			    if (step.basis !== undefined && step.basis.length > 0) {
			        items.push((0, react_1.createElement)('div', { key: 'basis' }, `${t('rowEvidence')}: ${step.basis.join(' · ')}`));
			    }
			    if (step.supportedEfforts !== undefined && step.supportedEfforts.length > 0) {
			        items.push((0, react_1.createElement)('div', { key: 'supported' }, `${t('rowSupported')}: ${step.supportedEfforts.join(', ')}`));
			    }
			    else if (step.supportedEfforts !== undefined) {
			        items.push((0, react_1.createElement)('div', { key: 'supported' }, `${t('rowSupported')}: ${t('rowNone')}`));
			    }
			    if (step.degradedReason !== undefined) {
			        items.push((0, react_1.createElement)('div', { key: 'degraded' }, `${t('rowDegraded')}: ${step.degradedReason}`));
			    }
			    if (step.heldForCache) {
			        items.push((0, react_1.createElement)('div', { key: 'heldForCache' }, `${t('rowRouteStrategy')}: ${t('rowHeldForCacheDetail')}`));
			    }
			    items.push((0, react_1.createElement)('div', { key: 'line', style: S.line }, step.line));
			    return items;
			}
			/**
			 * Render one turn's effort status line with its evidence behind a disclosure.
			 *
			 * @param props - the row's node data and the slot-bound translator.
			 * @returns the row element, or null when the node carries no decision.
			 */
			function EffortRowView(props) {
			    const data = props.node?.data;
			    if (data === undefined || data.steps.length === 0)
			        return null;
			    const t = translator(props);
			    const latest = data.latest;
			    const head = (0, react_1.createElement)('div', { style: S.head, key: 'head' }, (0, react_1.createElement)('span', { style: S.title, key: 'title' }, t('rowTitle')), levelChip(latest), (0, react_1.createElement)('span', { key: 'thinking' }, thinkingText(latest, t)), (0, react_1.createElement)('span', { style: S.route, key: 'route' }, routeText(latest, t)), data.steps.length > 1
			        ? (0, react_1.createElement)('span', { style: S.badge, key: 'steps' }, (0, panel_1.interpolate)(t('rowSteps'), { count: String(data.steps.length) }))
			        : null);
			    const body = (0, react_1.createElement)('div', { style: S.body, key: 'body' }, data.steps.length > 1 ? stepTable(data.steps, t) : null, (0, react_1.createElement)('div', { style: S.evidence, key: 'evidence' }, evidenceList(latest, t)));
			    // A native disclosure keeps the row stateless: no hook, no client-side
			    // expansion model, and it works in every render mode the shell uses.
			    return (0, react_1.createElement)('details', { style: S.row, 'data-reflex-turn': String(data.turn), key: 'row' }, (0, react_1.createElement)('summary', { style: S.summary, key: 'summary' }, head, (0, react_1.createElement)('span', { key: 'hint' }, ` · ${t('rowDetails')}`)), body);
			}
			/** Slot for composer indicator beside model selector. */
			exports.COMPOSER_INDICATOR_SLOT = 'conversation.input.right';
			/**
			 * Pill rendered at the right of composer (directly to the left of ModelSelect)
			 * indicating the actual routed physical model and actual decided reasoning effort.
			 */
			function ComposerEffortIndicator(props) {
			    const t = props.t ?? ((key) => locale_1.en[key] ?? key);
			    // This Host-owned projection folds this Session's own effort records,
			    // request headers and explicit selections. modelSelection.next falls back
			    // to lastUsed and therefore cannot retain adaptive intent after a header.
			    const actualState = props.useProjection?.('reflexActual');
			    const modelSelection = props.useProjection?.('modelSelection');
			    const next = modelSelection?.next;
			    // Durable adaptive intent stays pending after a physical header. Legacy logs
			    // may contain an old virtual effort but no persisted intent; a now-fixed
			    // selection must not resurrect that historical decision in the composer.
			    if (next?.provider !== 'reflex' && next?.reasoningEffort !== 'reflex' && next?.reasoningEffort !== 'auto')
			        return null;
			    const lastUsed = actualState?.adaptive === true ? actualState.actual : null;
			    if (typeof lastUsed?.provider !== 'string' || lastUsed.provider === 'reflex' ||
			        typeof lastUsed?.model !== 'string' || !lastUsed.model)
			        return null;
			    const parts = [`${lastUsed.provider}/${lastUsed.model}`];
			    if (typeof lastUsed.reasoningEffort === 'string' &&
			        lastUsed.reasoningEffort !== 'reflex' && lastUsed.reasoningEffort !== 'auto') {
			        parts.push(lastUsed.reasoningEffort);
			    }
			    const content = parts.join(' · ');
			    return (0, react_1.createElement)('div', {
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
			    }, (0, react_1.createElement)('span', {
			        key: 'dot',
			        style: {
			            width: '5px',
			            height: '5px',
			            borderRadius: '50%',
			            background: token('--dsw-alias-state-business-primary', '#3b82f6')
			        }
			    }), (0, react_1.createElement)('span', { key: 'label' }, `${t('composerActual')}: ${content}`));
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
			function registerEffortRow(conversation, registerSlot, locale) {
			    const unbindDefinition = conversation.events.register(exports.effortRowDefinition);
			    const unbindSlot = registerSlot({ name: exports.EFFORT_ROW_SLOT, key: exports.EFFORT_ROW_KIND, ...(locale === undefined ? {} : { locale }) }, EffortRowView);
			    const unbindIndicator = registerSlot({ name: exports.COMPOSER_INDICATOR_SLOT, id: 'reflex-composer-indicator', order: 10, ...(locale === undefined ? {} : { locale }) }, ComposerEffortIndicator);
			    return () => {
			        unbindIndicator();
			        unbindSlot();
			        unbindDefinition();
			    };
			}

		},
		"field-guide": function (module, exports, require) {
			"use strict";
			/**
			 * In-place guidance for every editable settings field.
			 *
			 * One row per Host schema path. The page uses the row for the label copy key,
			 * the empty-input example, and the `(?)` explanation key, so a field cannot
			 * gain a placeholder without a matching help entry. Dynamic rows (tool
			 * switches and intervention capabilities) are keyed by `<path>.*` and filled by
			 * the page from the row template.
			 *
			 * Everything here is browser copy only: the table never restates a default or a
			 * constraint. Those live in the locale help text and are cross-checked against
			 * the Host's own `resolveConfig` by `field-guidance.test.ts`, so the copy cannot
			 * silently drift from the schema.
			 *
			 * @module dsh-reflex/client/field-guide
			 */
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.FIELD_GUIDE = void 0;
			exports.guideFor = guideFor;
			exports.templateGuideFor = templateGuideFor;
			/** Path → guidance. Paths use the Host schema (`systemOne.baseUrl`), not draft names. */
			exports.FIELD_GUIDE = {
			    'routing.enabled': { labelKey: 'labelEnabled', helpKey: 'helpRoutingEnabled' },
			    'routing.virtualProvider': { labelKey: 'labelVirtualProvider', helpKey: 'helpVirtualProvider', placeholder: 'reflex' },
			    'routing.fallback': { labelKey: 'labelFallback', helpKey: 'helpFallback', placeholder: 'provider:model' },
			    'routing.maxTaskChars': { labelKey: 'labelMaxTaskChars', helpKey: 'helpMaxTaskChars', placeholder: '400' },
			    'effort.enabled': { labelKey: 'labelEffortEnabled', helpKey: 'helpEffortEnabled' },
			    'effort.setting': { labelKey: 'labelEffortSetting', helpKey: 'helpEffortSetting' },
			    'effort.fallback': { labelKey: 'labelEffortFallback', helpKey: 'helpEffortFallback' },
			    'effort.minConfidence': { labelKey: 'labelEffortMinConfidence', helpKey: 'helpEffortMinConfidence', placeholder: '0.3' },
			    backend: { labelKey: 'labelBackend', helpKey: 'helpBackend' },
			    'systemOne.baseUrl': { labelKey: 'labelBaseUrl', helpKey: 'helpBaseUrl', placeholder: 'https://api.typesafe.ai/v1/systemone' },
			    'systemOne.model': { labelKey: 'labelModel', helpKey: 'helpModel', placeholder: 'jev-latest' },
			    'systemOne.apiKeyEnv': { labelKey: 'labelApiKeyEnv', helpKey: 'helpApiKeyEnv', placeholder: 'JEV_API_KEY' },
			    'systemOne.timeoutMs': { labelKey: 'labelTimeoutMs', helpKey: 'helpTimeoutMs', placeholder: '10000' },
			    toolPrefix: { labelKey: 'labelToolPrefix', helpKey: 'helpToolPrefix', placeholder: 'reflex_' },
			    pruneThreshold: { labelKey: 'labelPruneThreshold', helpKey: 'helpPruneThreshold', placeholder: '500' },
			    ledgerPath: { labelKey: 'labelLedgerPath', helpKey: 'helpLedgerPath', placeholder: '.reflex/ledger.jsonl' },
			    calibrationPath: { labelKey: 'labelCalibrationPath', helpKey: 'helpCalibrationPath', placeholder: 'path/to/calibration.json' },
			    'interventions.mode': { labelKey: 'labelInterventionMode', helpKey: 'helpInterventionMode' },
			    'interventions.maxInterventionsPerTurn': {
			        labelKey: 'labelMaxInterventionsPerTurn',
			        helpKey: 'helpMaxInterventionsPerTurn',
			        placeholder: '3'
			    },
			    'interventions.maxJudgmentsPerTurn': { labelKey: 'labelMaxJudgmentsPerTurn', helpKey: 'helpMaxJudgmentsPerTurn', placeholder: '3' },
			    'interventions.maxJudgmentsPerSession': {
			        labelKey: 'labelMaxJudgmentsPerSession',
			        helpKey: 'helpMaxJudgmentsPerSession',
			        placeholder: '20'
			    },
			    'interventions.repeatThreshold': { labelKey: 'labelRepeatThreshold', helpKey: 'helpRepeatThreshold', placeholder: '3' },
			    'interventions.failureThreshold': { labelKey: 'labelFailureThreshold', helpKey: 'helpFailureThreshold', placeholder: '3' },
			    'interventions.minConfidence': {
			        labelKey: 'labelInterventionMinConfidence',
			        helpKey: 'helpInterventionMinConfidence',
			        placeholder: '0.6'
			    },
			    'interventions.windowSize': { labelKey: 'labelWindowSize', helpKey: 'helpWindowSize', placeholder: '6' },
			    'interventions.pruneFloorRatio': { labelKey: 'labelPruneFloorRatio', helpKey: 'helpPruneFloorRatio', placeholder: '0.5' },
			    'interventions.pruneHeadChars': { labelKey: 'labelPruneHeadChars', helpKey: 'helpPruneHeadChars', placeholder: '400' },
			    'interventions.pruneTailChars': { labelKey: 'labelPruneTailChars', helpKey: 'helpPruneTailChars', placeholder: '400' },
			    'interventions.intent': {
			        labelKey: 'labelPruneIntent',
			        helpKey: 'helpPruneIntent',
			        placeholder: 'extract diagnostics, relevant results and errors'
			    },
			    'interventions.pruneJudgeMinChars': {
			        labelKey: 'labelPruneJudgeMinChars',
			        helpKey: 'helpPruneJudgeMinChars',
			        placeholder: '10000'
			    },
			    'interventions.claimMinConfidence': {
			        labelKey: 'labelClaimMinConfidence',
			        helpKey: 'helpClaimMinConfidence',
			        placeholder: '0.5'
			    },
			    'interventions.closingEvidenceChars': {
			        labelKey: 'labelClosingEvidenceChars',
			        helpKey: 'helpClosingEvidenceChars',
			        placeholder: '2400'
			    },
			    // Dynamic rows: the page substitutes the suffix / capability into the label
			    // and fills the `{...}` holes in the explanation.
			    'tools.enabled.*': { helpKey: 'helpToolSwitch' },
			    'interventions.capabilities.*': { helpKey: 'helpCapability' }
			};
			/**
			 * Look up a field's guidance by its schema path.
			 * @param path - schema path such as `routing.virtualProvider`.
			 * @returns the row, or `undefined` when the path is not part of this table.
			 */
			function guideFor(path) {
			    return exports.FIELD_GUIDE[path];
			}
			/**
			 * Look up a dynamic field's guidance by family prefix.
			 * @param family - `tools.enabled` or `interventions.capabilities`.
			 * @returns the wildcard row, or `undefined`.
			 */
			function templateGuideFor(family) {
			    return exports.FIELD_GUIDE[`${family}.*`];
			}

		},
		"guide.generated": function (module, exports, require) {
			"use strict";
			/**
			 * GENERATED FILE — do not edit by hand.
			 *
			 * Produced by `node scripts/embed-user-guide.mjs` from the repository documents,
			 * which are the single source of truth for the in-panel guide:
			 *   - USER_GUIDE.md (sha256 66e0eacdc728abf426288129ac893098cffe264dba9a2bed07167e8dd4e2e10b)
			 *   - docs/USER_GUIDE.en.md (sha256 c61af256c0e15887364606d5eb79d79d24403eeca2fcc8ff9792d0d6d707439b)
			 *
			 * `npm run build:all` regenerates this module before the browser half is compiled;
			 * `npm run test:plugin` fails when the digests no longer match the documents.
			 */
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.GUIDE_EN = exports.GUIDE_ZH = exports.GUIDE_LANGUAGES = exports.GUIDE_DIGESTS = exports.GUIDE_SOURCES = void 0;
			/** Document paths, relative to the repository root. */
			exports.GUIDE_SOURCES = { "zh": "USER_GUIDE.md", "en": "docs/USER_GUIDE.en.md" };
			/** sha256 of each document, used to pin the packaged revision. */
			exports.GUIDE_DIGESTS = { "zh": "66e0eacdc728abf426288129ac893098cffe264dba9a2bed07167e8dd4e2e10b", "en": "c61af256c0e15887364606d5eb79d79d24403eeca2fcc8ff9792d0d6d707439b" };
			/** Guide languages this build carries. */
			exports.GUIDE_LANGUAGES = ["zh", "en"];
			/** zh user guide, verbatim Markdown. */
			exports.GUIDE_ZH = "# Harness Reflex 使用说明（v0.3.0）\n\n> 本文档是 **`dsh-harness-reflex` 插件** 与 **`harness-reflex` 核心包** 的完整使用手册。\n> 同一份内容会内嵌进 `packages/dsh-harness-reflex/client.js`，可在 DSH 设置面板的\n> **「使用说明 / Guide」** 标签页内直接阅读（跟随 DSH 界面语言中英切换）。\n> 因此修改本文档后必须重新执行 `npm run build:all`，否则面板里仍是上一次构建的副本\n> （`npm run test:plugin` 会用文档摘要做漂移校验）。\n\n---\n\n## 1. Harness Reflex 是什么\n\nHarness Reflex 是一个 **System One（快思考）决策运行时**：它在不调用昂贵\nSystem Two 生成式推理的前提下，用毫秒级的概率判定完成门禁校验、上下文剪枝、\n死循环拦截、模型路由与推理强度决策，并把每一次决策写进可审计的决策账本。\n\n它有两种交付形态，共享同一套判定引擎，但**对外工具面不同**（见第 9 节）：\n\n| 形态 | 包 | 适用 Harness | 通信方式 |\n| --- | --- | --- | --- |\n| stdio MCP 服务器 | `harness-reflex` | Claude Code、Codex CLI、AGY | MCP JSON-RPC 子进程 |\n| DSH Host 插件 | `dsh-harness-reflex` | DeepSeek Harness (`dsh`) | 进程内 `ctx.tools` / Cordis 钩子 |\n\nMCP 面暴露 8 个工具；DSH 面只注册 5 个可开关工具（默认 4 个），剪枝/停滞/账本由自动干预与\n`/reflex-ledger` 命令承载。参数及校验边界以第 9 节和各表面实际工具定义为准。\n\n---\n\n## 2. 插件架构\n\n```text\n┌──────────────────────────────────────────────────────────────────────┐\n│                          Harness Layer                               │\n│   Claude Code (.mcp.json) · Codex (.codex/config.json) · AGY 插件包   │\n└───────────────┬──────────────────────────────────┬───────────────────┘\n                │ stdio MCP                        │ DSH Cordis 进程内\n┌───────────────▼──────────────────┐  ┌────────────▼───────────────────┐\n│ harness-reflex 核心（dist/）      │  │ dsh-harness-reflex 插件            │\n│  gate · prune · stagnation       │◄─┤  src/bridge.ts  ReflexRuntime  │\n│  route · screen · score          │  │  src/tools.ts   5 个可开关工具 │\n│  ledger · calibrate              │  │  src/router.ts  虚拟 Provider  │\n└───────────────┬──────────────────┘  │  src/effort.ts  推理强度拦截   │\n                │ DecisionBackend     │  src/panel-*    设置面板 + API │\n┌───────────────▼──────────────────┐  └────────────┬───────────────────┘\n│ mock · simple-jev/vLLM · 官方 Jev │               │ settings.section\n└──────────────────────────────────┘  ┌────────────▼───────────────────┐\n                                      │ client.js 浏览器面板（React）   │\n                                      │ 概览/虚拟 Provider/推理强度/    │\n                                      │ System 1 后端/自动干预/工具开关/ │\n                                      │ 决策账本/使用说明               │\n                                      └────────────────────────────────┘\n```\n\n关键模块一览（插件侧）：\n\n| 文件 | 职责 |\n| --- | --- |\n| `src/index.ts` | Cordis 插件入口 `apply(ctx, config)`，注册与拆除都在一个 `ctx.effect` 内 |\n| `src/bridge.ts` | `ReflexRuntime`：一次激活的 backend / ledger / 校准器 / 决策服务集合 |\n| `src/tools.ts` | 5 个可开关 `reflex_*` 工具，默认注册 4 个（Host `defineTool` 严格校验 + 顶层未声明参数拦截） |\n| `src/router.ts` | `VirtualModelRouter`：候选池 → System 1 决策 → 降级 / Fail-Closed → 审计 |\n| `src/virtual-adapter.ts` | 虚拟 provider 的 `LlmAdapter` 表面与派发层兜底 |\n| `src/routing.ts` | `installModelRouting`：注册虚拟 provider，挂 `agent/pre-step`、`agent/request` |\n| `src/effort.ts` | `EffortInterceptor`：每轮推理强度判定、投影与状态上报 |\n| `src/session-audit.ts` | 写/读 `plugin:dsh-reflex/effort` 会话记录（不污染模型上下文） |\n| `src/panel-api.ts` | 设置面板只读投影 + `/dsh-reflex/api/*` 路由（仅 loopback） |\n| `src/client/*` | 浏览器半边：槽位注册、中英文案、Markdown 渲染、面板视图 |\n\n启动顺序：DSH 载入插件 → `apply` 解析配置 → 建立 `ReflexRuntime` → 注册虚拟\nprovider 与请求钩子 → 注册默认 4 个工具（`route` 打开后 5 个）→ 注册\n`/reflex-ledger` 命令 → 挂载面板路由。卸载时逆序注销，完全可逆。\n\n---\n\n## 3. 安装与构建\n\n```bash\n# 1) 安装依赖并构建（根包 → 链接本机 DSH 依赖 → 插件 → 浏览器 bundle）\nnpm install\nnpm run build:all\n\n# 2) 配置目标 Harness（生成 .mcp.json / .codex/config.json / AGY 插件包）\nnode dist/cli/index.js setup all      # 或 claude | codex | agy\n\n# 3) 以 DSH 插件方式安装（进程内集成，推荐）\n#    发布 tarball：同版本重装必须 --force；开发期也可直接装目录\ndsh plugin --profile web add --force ./release/dsh-harness-reflex-0.3.0.tgz\n```\n\n`npm run build:all` 的每一步都是必需的：\n\n1. `tsc`：根包 `src/` → `dist/`；\n2. `node scripts/link-dsh-deps.mjs`：把本机 DSH 的 `@deepseek-ai/*` 软链进\n   `packages/dsh-harness-reflex/node_modules/`（完全离线，不访问 registry）；\n3. `tsc -p packages/dsh-harness-reflex/tsconfig.json`：插件 Host 半边 → `packages/dsh-harness-reflex/dist/`；\n4. `node scripts/embed-user-guide.mjs` + `tsc -p tsconfig.client.json` +\n   `node packages/dsh-harness-reflex/dist/client-bundle.js packages/dsh-harness-reflex`：\n   把本文档内嵌进浏览器半边并产出单文件 `client.js`。\n\n> 构建顺序不可交换：`client.js` 必须晚于本文档的修改，否则面板显示的说明与仓库文档不一致。\n\n---\n\n## 4. System 1 后端接入配置\n\n三种后端共用一套 `SYSTEM_ONE_*` 环境变量与插件配置项，选择顺序为\n「插件配置 > 环境变量 > 默认 mock」。\n\n| 后端 | 取值 | 说明 |\n| --- | --- | --- |\n| 本地启发式（默认） | `mock` | 确定性、零网络、亚毫秒级；用于离线开发与测试 |\n| 通用 logits 读出 | `simple-jev` | vLLM / OpenAI 兼容接口的 `max_tokens: 1` + `next-token logprobs` |\n| 官方 Jev / System One API | `jev` | `POST {BASE_URL}/v1/...`，需 API Key |\n\n```bash\n# 官方 Jev：只有 key 是必填\nexport SYSTEM_ONE_API_KEY=\"your-api-key\"\n\n# 自托管 vLLM（OpenAI 兼容）：只有地址是必填\nexport SYSTEM_ONE_BASE_URL=\"http://localhost:8000\"\nexport SYSTEM_ONE_BACKEND=simple-jev     # 省略也能判定：检测到 VLLM_BASE_URL/OPENAI_BASE_URL 即为 simple-jev\n```\n\n不显式设 `SYSTEM_ONE_BACKEND` 时的判定顺序：有 `SYSTEM_ONE_API_KEY`/`JEV_API_KEY` → `jev`；\n有 `VLLM_BASE_URL`/`OPENAI_BASE_URL` → `simple-jev`；都没有 → `mock`。\n\n三份默认值都取决于后端，不要凭「默认 mock」推断另外两个：\n\n| 变量 | `jev` | `simple-jev` |\n| --- | --- | --- |\n| `SYSTEM_ONE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | `http://localhost:8000` |\n| `SYSTEM_ONE_MODEL` | `jev-latest` | `Qwen/Qwen2.5-7B-Instruct` |\n| `SYSTEM_ONE_API_KEY` | **无**（空串，请求会被服务端拒绝） | `dummy`（本地服务通常不校验） |\n\n插件配置项（可在设置面板「System 1 后端」页编辑，或写进 DSH 插件配置）：\n\n| 配置 | 默认 | 说明 |\n| --- | --- | --- |\n| `backend` | `auto` | `auto` 按环境变量判定，也可强制 `mock` / `vllm` / `jev`（`vllm` 即 logits 读出，环境变量侧名 `simple-jev`） |\n| `baseUrl` | 省略 | System 1 服务地址；省略时用后端默认值 |\n| `model` | 省略 | 服务端模型 ID；省略时用后端默认值（`jev-latest` / `Qwen/Qwen2.5-7B-Instruct`） |\n| `apiKeyEnv` | 省略 | **只记录环境变量名**，密钥本身不进入设置文档；省略时由后端各自从环境变量兜底（`SYSTEM_ONE_API_KEY` → `JEV_API_KEY` → `VLLM_API_KEY` → `OPENAI_API_KEY`） |\n| `timeoutMs` | 省略 | 单次判定超时；省略时用**后端默认值 `jev` 10000 ms / `simple-jev` 8000 ms**，不是统一值；超时按 `System 1 不可用` 走降级路径 |\n\n校准曲线（可选）：用 `calibrate` 引擎基于历史标注集拟合 ECE/PAVA 曲线，再用\n`calibrationPath` 指向该 JSON，运行时会自动修正过度自信的原始概率。\n\n---\n\n## 5. 虚拟 Provider 与模型池\n\n**概念.** 插件注册一个虚拟 provider（默认 id `reflex`），它自己不产生任何\ntoken：当请求落到 `reflex/reflex-auto` 这类虚拟模型上时，`agent/request` 钩子会\n用 System 1 从该虚拟模型配置的**物理候选池**里选出一个真实 `provider/model`，\n改写请求配置后继续派发，并写一条 `type: model-route` 台账。\n\n配置结构（对应 YAML）：\n\n```yaml\nrouting:\n  enabled: true\n  virtualProvider: reflex\n  maxTaskChars: 400          # 每个 agent 参与打分的任务文本上限\n  fallback: deepseek:deepseek-chat   # 池无法回答时的降级目标\n  models:\n    reflex-auto:             # 虚拟模型 ID\n      - provider: deepseek\n        model: deepseek-reasoner\n        description: 长链路推理与代码重构\n        tags: [reasoning, expensive]\n      - provider: deepseek\n        model: deepseek-chat\n        description: 日常问答与快速编辑\n        tags: [fast, cheap]\n    reflex-fast:\n      - provider: deepseek\n        model: deepseek-chat\n        description: 低延迟场景\n        tags: [fast]\n```\n\n**规则与边界.**\n\n- `enabled: false` 或 `models` 为空 ⇒ 不注册虚拟 provider，行为与未安装插件一致。\n- 候选池为空且未配置 `fallback` ⇒ **Fail-Closed**：报错而不是乱派发。\n- `virtualProvider` 不能包含 `:`；候选的 `provider` 与 `model` 都不能为空。\n- 主代理与 subagent 都走同一条拦截链路，抗循环标识（loop identity）在改写后保持不变。\n- 每次路由的候选、选择、置信度与耗时都会进账本，可在「决策账本」页回看。\n\n**上下文感知与会话粘性（省缓存、非必要不切换）.** 换模型会让服务端的提示词前缀\n缓存整体失效，因此路由不是「每轮重新选一次」，而是**默认守住这台会话已经在用的物理\n模型**：\n\n- 插件按 agent 累计本会话已观测到的上下文规模（`agent/pre-step` 送进来的输入字符数，\n  按 4 字符 ≈ 1 token 折算），每次决策都把它和**当前物理模型**一起交给 System 1\n  （请求里的 `state.currentModel` / `state.contextTokens` / `state.contextChars`）。\n- 决策提示词里会同时给出这条策略：保留当前模型能保住提示词缓存，只有另一个候选\n  **明显更合适**时才切走；候选清单里当前模型还带\n  `[current model — keeping it preserves the prompt cache]` 标记与 `current: true` 标志，\n  文本型后端和结构化后端都能读到同一个信号。\n- 后端排出名次后还有一道**粘性闸门**：挑战者必须分数更高、且高出当前模型\n  `stickyMargin`（默认 15%）的相对幅度，才会真的切换；并列或只是略优都保持不动。\n- 账本的每条 `model-route` 都记下 `currentModel`、`switched` 与 `contextTokens`，\n  于是「这轮为什么没换模型」是可回看的，而不是靠猜。\n- 粘性只在**同一个候选池**内生效：当前模型不在本轮候选里（例如换到另一个虚拟模型）\n  时，决策照常按 System 1 的名次走，`switched` 记为 `true`。\n\n**在设置面板里配置.** 打开 DSH 设置 →「Reflex 决策运行时」→ **虚拟 Provider**：\n顶部开关启用路由；填写虚拟 Provider 名称、兜底目标、任务文本预算；在「模型池」\n里新增虚拟模型与候选（上移/下移调整顺序），点 **保存** 整体写回。面板的写入\n会先过一遍 Host 侧同一个 `resolveConfig` 校验器，非法配置（空 ID、重复模型、\n跨组错误）会被直接拒绝并给出对应错误文案。\n\n---\n\n## 6. 自适应思考等级（`reflex` / `auto`）\n\n把推理强度策略设为 `reflex`（`auto` 与它同义）后，插件会在每轮真正发起 API 请求前\n拦截输入意图与上下文，用 System 1 判定本轮需要的 `reasoningEffort`，再改写实际\n下发的参数。\n\n| 配置 | 默认 | 说明 |\n| --- | --- | --- |\n| `effort.reasoningEffort` | 省略 | `reflex` / `auto` = 每轮自适应；省略 = 不干预，插件完全不碰 `reasoningEffort`；具体档位请在模型选择器里选择，可选项取决于目标模型声明的档位集合 |\n| `effort.fallback` | `medium` | System 1 不可用或置信度低于下限时，确定性线索投票的兜底档 |\n| `effort.minConfidence` | `0.3` | 低于该置信度的判定不直接采用，改走兜底 |\n| `effort.enabled` | `true` | 设为 `false` = 整层关闭：不判定、不审计、不注入 `reflex` 档位 |\n\n配置只回答一个问题：**要不要启用自适应**。\n\n- **留空（默认）= 不干预**：插件完全不改写 `reasoningEffort`，不产生判定与审计记录，行为与未安装该功能一致；\n- **`reflex`（`auto` 同义）= 自适应**：每轮按 System 1 判定本轮档位；\n- **想固定思考深度**：请在模型选择器里选择具体档位，可选项取决于目标模型声明的\n  档位集合；配置只接受留空或 `reflex`（`auto` 同义），写入其它值会在启动时被拒绝，\n  并提示把档位改到模型选择器里选择。\n\n**行为约定.**\n\n- 调用方在请求里显式选择的具体档位永远保持透明，插件不会覆盖；\n- 目标模型不支持思考等级时安全降级，不会把参数原样塞给非思考模型；\n- 每一轮都会向会话写入一条审计记录（`plugin:dsh-reflex/effort`），其中只包含\n  判定档位、置信度与截断后的任务摘录，**不进入后续模型上下文**；\n- 判定结果同时投影到状态栏，可在「概览」页看到最近一次决策\n  （形如 `reflex: high (confidence 0.82, system-one, 12.4 ms)`）。\n\n**关掉整层（`effort.enabled: false`）.**\n\n`effort.enabled` 是**能力开关**，与「策略是什么」相互独立：`reasoningEffort: reflex`\n加上 `enabled: false` 是合法组合，语义等于完全不装这一段拦截（区别只在于配置仍\n写着策略）。关闭后：\n\n- **不判定**：不发起 System 1 调用、不做线索投票、不写判定缓存，也不发布\n  `reflex/effort` 状态——「概览」页不会出现本插件的最近决策；\n- **不审计**：账本里没有 `effort-decision` 记录，会话日志里也没有\n  `plugin:dsh-reflex/effort` 记录；\n- **不注入档位**：本插件注入的那一档（`reflex` / `auto`）从模型选择器里撤销，\n  只保留适配器自己声明的档位与其默认档；\n- **具体档位原样下发**：调用方在请求里显式选择的 `high`、`medium` 等连「对齐到目标\n  模型词表」的改写都不做，逐字节保持原样；\n- **标记安全兜底**：已有会话或手工构造的调用里若仍带着本插件的标记，标记在**物理\n  适配器边界被删除**，而不是被翻译成一个档位——最终生效的是 provider 自己的默认\n  档，插件标记永远不会泄漏给真实 provider。\n\n默认 `true`（省略即 `true`），因此不写这一项时行为与显式写 `true` 逐字节一致。\n\n---\n\n## 7. 自动干预门禁（`off` / `observe` / `active`）\n\n插件可以在**模型没有调用任何 `reflex_*` 工具**的情况下，用宿主原生钩子自行干预。\n开关只有一处：`interventions.mode`，取值 `off` / `observe` / `active`，默认 `observe`：\n\n```yaml\ninterventions:\n  mode: observe        # off | observe | active\n  capabilities:        # 可选：四大能力分别覆盖，inherit 表示跟随 mode\n    stagnation: inherit\n    prune: inherit\n    gate: inherit\n    closing: inherit\n  maxInterventionsPerTurn: 3\n  maxJudgmentsPerTurn: 3\n  maxJudgmentsPerSession: 20\n```\n\n四大能力各自是**四态**：`off` / `observe` / `active` 显式覆盖 `mode`，`inherit`\n（或省略）跟随 `mode`。因此可以整体保持 `active`，只把 `prune` 单独降为\n`observe`（只记账不剪枝），或反过来把整体设为 `off` 而只放开 `gate`。\n\n| 模式 | 行为 |\n| --- | --- |\n| `off` | 不注册任何钩子监听器；工具执行与不装插件逐字节一致 |\n| `observe`（默认） | 完整检测与判定，只记账不执行：不改写 content、不注入消息、不拒绝工具、不 steer |\n| `active` | 完整链路：重复调用在执行前拒绝、超长结果在进入上下文前剪枝、重复失败改写为纠正反馈、回合收尾对有证据冲突的结论提出异议 |\n\n| 能力 | 钩子 | `active` 时的动作 |\n| --- | --- | --- |\n| `stagnation` | `tools/pre-execute`、`agent/pre-step` | 判定重复/振荡后拒绝该次调用，或在下一次 step 注入纠正上下文 |\n| `prune` | `tools/post-execute` | 结果超阈值时先保留原件再改写：原文写入会话日志并给出定位符，改写文本保留首尾并在中间标注定位符 |\n| `gate` | `tools/post-execute` | 同一调用连续失败达阈值时，把结果改写为纠正反馈；失败与否只看工具源保证的结构化退出码或宿主退出标记 |\n| `closing` | `agent/turn-stopping` | 用 `reflex_gate` 复核本回合的结论与证据，矛盾时 steer 一次 |\n\n### 合法等待为什么不会被当成停滞（豁免默认值）\n\n等待后台作业是合法行为，因此 `stagnation` 对**可结构识别的等待型调用**做了豁免。\n判定只看两个结构化事实，**不读工具描述、也不读任何输出文本**：\n\n1. **工具身份**：调用的是宿主自己的后台作业查询工具 `job_output`、`job_list`\n   （由 `@deepseek-ai/dsh-tool-jobs` 注册，shell 工具的后台作业也统一走 `job_output`）；\n2. **调用形态**：参数是宿主自己声明的作业句柄字段（`job_output` 的 `job_id` 非空字符串；\n   `job_list` 本身无参数，故以空参数对象为其形态）。\n\n命中豁免的调用：不产生拒绝、不注入纠正上下文、不消耗 turn 的干预与判定额度，\n`observe` 与 `active` 的计划完全一致；它仍会记录进检测窗口，只是不计入「无进展重复」\n（重复、失败重试、振荡三类触发都跳过它），因此**真正的循环并不会因为中间等了一次作业而消失**。\n`job_kill` 刻意不在豁免内——它是终止动作，不是等待查询。\n输出文本里出现 `wait` / `sleep` / `poll` 等字样不构成任何豁免。\n范围即上表所列的两个工具名；这是文档化的默认值，无需额外配置。\n\n### 被剪掉的原文如何取回\n\n`active` 剪枝的次序是「先保留、后替换」，这一步不能只有措辞：\n\n1. 判定通过、且**保留成功**之后，才生成改写文本；\n2. 原文以 `plugin:dsh-reflex/pruned-original` 记录写进会话日志（宿主 `appendPluginRecord`），\n   不进入模型可见面，`fork` / `resume` 会随日志一起带走；\n3. 改写文本中间带上定位符 `plugin:dsh-reflex/pruned-original#<digest>`，模型因此随时可以\n   要求取回被省略的部分；\n4. 保留失败（没有会话、日志缺失、写回校验不过）时**不替换**，也不计 `actualSavedTokens`，\n   结果逐字节保持原样（记为 `retention-failed`；这次判定已经付出，仍照实记账）。\n\n取回就是拿同一条定位符读会话事件：\n\n```ts\nimport { readPrunedOriginal } from 'dsh-harness-reflex';\n\nconst record = readPrunedOriginal(session.ownEvents(), locator);\nrecord?.text;    // 逐字节原文\nrecord?.chars;   // 保留时的字符数\nrecord?.digest;  // 与决策记录里的 digest 一致\n```\n\n下限 `pruneFloorRatio`（默认 0.5）是**安装文本占原文的最小比例**：判定给出的候选若低于它，\n就用首尾上下文补足到该比例；判定选中的中间诊断整体保留，不会被下限挤掉。\n可保留的载荷有边界：换行少于 4 个（不足 5 行）或超过 100 000 字符时不做剪枝\n（分别记为 `unsupported-payload` / `retention-too-large`），单行输出与超大日志原样通过；\n同一载荷重复出现时复用第一次保留的原件，不重复写日志。\n\n### 成本与可追溯\n\n- 账本按 `mode` 与 `capability` 分列：`plans`（计划了几次）、`applied`（真正执行了几次）、\n  `judgments` / `memoHits`（判定与判定缓存命中）、`judgeTokens`（判定消耗的 token）、\n  `originalTokens` / `candidateTokens` / `potentialSavedTokens`（本可节省）/ `actualSavedTokens`（真正少带进上下文的量）；\n- `observe` 的 `actualSavedTokens` 恒为 0，`potentialSavedTokens` 与同输入的 `active` 逐项一致；\n- 判定成本单独计：`localLatencyMs`（本机仲裁）与 `remoteLatencyMs`（后端判定）分开统计；\n- 每条剪枝记录都带被替换原文的 `digest`、`turn`/`step` 与定位符 `originalLocator`；用定位符即可读回逐字节原文（见上「被剪掉的原文如何取回」）；\n- 保留是替换的前提：保留不成功就不替换、不计 `actualSavedTokens`，`plans` 也不谎报一次没发生的缩减；\n- `off` 严格零行为：不注册任何监听器、不采样、不判定，与不装插件逐字节一致；\n- 判定缓存以「回合 + 尾部窗口」为键：同一个问题一个回合只付一次；`maxJudgmentsPerTurn`、\n  `maxJudgmentsPerSession`、`maxInterventionsPerTurn` 分别是每回合判定、每会话判定、每回合干预的次数上限；\n- 同一 `(agent, 调用签名)` 的干预在一个回合内去重；被本插件拒绝的那次调用的返回值不参与二次判定；\n- 本插件自己注册的工具永不进入判定（它们的结果已经是优化产物；默认 4 个，打开\n  `route` 后 5 个），这些 `reflex_*` 载荷不受干预影响。\n\n### 安全与回退\n\n- **fail-open**：任一判定环节抛错都直接放行下游结果（记为 `planning-error`），不会让工具调用失败；\n- **判失败不靠措辞**：以结果的结构化 `exitCode`/`signal` 为准，其次才是宿主追加在末行的退出标记；正文里出现 “failed” 不算失败，也不会因此拦下一次合法重试；\n- **权限单调**：`tools/pre-execute` 只在下游给 `allow` 时追加一条 `deny`；下游给 `ask`/`deny`/`cancel` 时按原对象原样返回（含 `info`），既不放宽也不覆盖；\n- **会话隔离**：检测窗口、判定缓存与次数上限都按 agent 记账，多 agent 互不共享；\n- **卸载无残留**：插件卸载时解除全部监听器并清空引擎状态；账本默认只在内存（未设 `ledgerPath` 时不落盘）。\n\n---\n\n## 8. 设置面板（DSH Settings UI）\n\n插件通过 `dsh.client` 声明浏览器半边，注册到设置面板的 `settings.section` 槽位：\n\n| 标签页 | 内容 |\n| --- | --- |\n| 概览 | 决策计数、节省 token、平均时延、门禁通过/失败、最近一次自适应决策 |\n| 虚拟 Provider | 路由开关、虚拟 Provider 名称、模型池增删与排序、兜底目标 |\n| 推理强度 | 策略（不干预 / Reflex 自适应）、兜底档、最小置信度、**自适应推理强度开关** |\n| 自动干预 | 三态模式（`off`/`observe`/`active`）、四大能力覆盖、每回合干预次数上限、每回合判定上限、每会话判定上限、重复阈值、失败阈值、最小置信度、判定窗口大小、剪枝下限比例；并列出当前生效的模式与能力（只读） |\n| 工具开关 | 5 个能力逐项启停（默认 4 开、`route` 关）；每项写明**做什么 / agent 何时该调用 / 是否建议暴露**，并有「应用推荐组合」按钮；页尾列出当前已注册的工具名（只读，跟随 `toolPrefix`），并提示账本改用 `/reflex-ledger` |\n| System 1 后端 | 后端实现、Base URL、模型 ID、API Key 环境变量名、超时；以及工具名前缀、裁剪阈值、账本 JSONL 路径、校准曲线路径 |\n| 决策账本 | 实时指标、最近决策表、落盘路径、清空（需二次确认） |\n| **使用说明** | **本手册的只读视图，跟随 DSH 界面语言中英切换** |\n\n- 页面是**整组写回**：改一个字段会让该配置组整体过一次 Host 校验后保存（System 1\n  后端页覆盖 `backend`、`systemOne`、`toolPrefix`、`ledgerPath`、`pruneThreshold`、\n  `calibrationPath` 六条配置路径，保存时逐条整值写入）；\n- Host 文档只读时页面自动进入只读模式，写操作按钮禁用；\n- 面板路由 `/dsh-reflex/api/*`（`panel` / `health` / `ledger/clear`）只接受 loopback 客户端，清除账本必须显式确认。\n\n### 各组的写回范围\n\n面板永远显示**当前生效值**，且保存走的是 Host 设置文档的唯一写入通道（按组\n`set` + 修订号校验），不存在第二条写入路径。各组写回粒度不同：\n\n- **自动干预：整组写回**。保存该组时，面板把该组当前的**模式与全部预算值一次性\n  完整写入**（与虚拟 Provider、推理强度等组一致），所以配置里留下的是你在面板上\n  看到的那一份完整取值，而不是只有被改过的那一个字段；其中能力覆盖只写「不等于\n  `inherit`」的项，其余保持省略（省略 = 跟随模式）。\n- **工具开关：只写与默认不同的项**。只有偏离该后缀默认值的开关会写进\n  `tools.enabled`：默认开启的工具被关掉写 `false`，默认关闭的 `route` 被打开写\n  `true`；把任何一项改回默认值都会**删除**该键。因此「推荐组合」与「整组省略」\n  逐字节一致，默认配置下配置内容零变化（默认已经是 4 开 1 关）。\n- **推理强度开关：总是显式写入**。`effort.enabled` 随该组写下当前值，避免出现\n  「面板显示已启用、配置里其实是省略」的歧义。\n- **System 1 后端：逐条 schema 路径整值写入**。Host 的设置文档按**配置路径**寻址，\n  而该页覆盖的是 `backend`（标量）、`systemOne`（连接块）以及 `toolPrefix`、\n  `ledgerPath`、`pruneThreshold`、`calibrationPath` 四个顶层字段：保存时这几条路径\n  各自整值写入（只写发生变化的那一组），**页面名不会被当成配置键**——`runtime`\n  并不是 `Config` 的字段，按页面名写入会被 Host 直接拒绝，整次保存随之失败。留空的\n  `ledgerPath`/`calibrationPath` 以「取消设置」写入，效果等于沿用下层配置而不是写空串。\n\n非法值（未知工具后缀、非布尔值、越界预算、非法三态取值）由 Host 侧同一个\n`resolveConfig` 校验器拒绝并给出字段级错误文案，面板不会部分生效——要么整组通过，\n要么一个字都不写。\n\n### 工具开关：两类建议与推荐组合\n\n工具开关页的每一项都写清三件事：**这个能力做什么**、**agent 在什么情况下应该调用\n它**、以及一条**是否建议暴露给 agent** 的标签：\n\n| 建议标签 | 含义 | 能力 |\n| --- | --- | --- |\n| 建议暴露 | agent 日常确实会用 | `choice`、`score`、`screen`、`gate` |\n| 按需开启 | 候选很多时先缩小范围才有用，默认关闭 | `route` |\n\n页首的「**应用推荐组合**」按钮按上表预填这 5 个开关，并把 `route` 关掉。**这个\n推荐组合就是默认值**：`tools.enabled` 省略时，`choice`、`score`、`screen`、`gate`\n开、`route` 关，DSH 插件侧默认暴露 4 个工具。按钮只预填草稿、不落盘：仍需点\n「保存」；草稿若已经等于默认值，保存**不写任何内容**（没有需要记录的差异）。\n\n`route` 是可选增强：打开它（面板开关，或配置里写 `tools: { enabled: { route: true } }`）\n才会注册 `reflex_route`；不开也不影响主流程。\n\n还有三项能力**已经不是工具**，因此这里没有它们的开关：`prune`（结果剪枝）与\n`detect_stagnation`（停滞检测）由自动干预层直接驱动，随 `observe`/`active` 生效；\n账本汇总改由 `/reflex-ledger` 命令读取。页尾有一行提示指出这两条去路；stdio MCP\n侧仍保留同名的 8 个工具，见下一节。\n\n---\n\n## 9. MCP 工具 ↔ DSH 原生能力对照\n\n两种形态**各自使用不同的工具集**：stdio MCP 侧仍然暴露自 v0.1.0 起冻结的 **8 个工具**，\nDSH 插件侧只注册 **6 个可开关的能力（默认 5 个）**——另外三项能力改由自动干预与一条\n命令承载，不占用模型的工具清单。`reflex_delegate` 是插件侧专属的包装工具：它把任务转交给\n宿主的 `subagent` 工具，由 System One 决定子树该用多深的思考档位；它**刻意没有**思考档位\n参数（想精确指定档位就直接调用 `subagent`），并且只在宿主委派工具声明了\n`reasoning_effort`（即部署开启了 `modelSelection: true`）时才注册——否则不注册并在日志里\n说明原因，不会出现「注册了却传不进档位」的静默降级。\n\n| 能力 | MCP 工具名（`harness-reflex mcp`） | DSH 插件侧（`dsh-harness-reflex`） | 主要参数 | 建议 |\n| --- | --- | --- | --- | --- |\n| 多选一分类 | `reflex_choice` | 工具 `reflex_choice` | `question`, `options[]`, 可选 `context` | 建议暴露 |\n| 连续评分 | `reflex_score` | 工具 `reflex_score` | `statement`, 可选 `criteria`, `context` | 建议暴露 |\n| 提示注入筛查 | `reflex_screen` | 工具 `reflex_screen` | `content`, 可选 `source`, `strict` | 建议暴露 |\n| 声明-证据门禁 | `reflex_gate` | 工具 `reflex_gate` | `assertions[{statement}]`, `evidence`, 可选 `strictness` | 建议暴露 |\n| 候选排序 | `reflex_route` | 工具 `reflex_route`（**默认不注册**） | `goal`, `candidates[]`, 可选 `topK` | 按需开启 |\n| 委派子代理 | `reflex_delegate` | 工具 `reflex_delegate`（**需先在设置面板勾选「子代理委派」，且宿主委派工具随后开放思考档位时才注册**） | `prompt`, `description`, 可选 `provider`, `model`, `cwd` | 建议暴露 |\n| 长输出剪枝 | `reflex_prune` | 无工具：结果剪枝由 `tools/pre-execute` 等钩子按干预模式自动执行 | `rawOutput`, 可选 `intent`, `shadowMode` | — |\n| 停滞检测 | `reflex_detect_stagnation` | 无工具：停滞检测是自动干预的一部分 | 可选 `recentAction`, `goal`, `history[]` | — |\n| 账本审计 | `reflex_status_ledger` | 无工具：改用 `/reflex-ledger` 命令（无参数） | 可选 `includeEntries`（返回 `summary`，可附 `recentEntries`） | 人读 |\n\n勾选 **子代理委派** 是一次带副作用的明确同意：插件会把 `tool-subagent: { modelSelection: true }` **合并**进你的\nprofile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`），其余内容逐字节保留，写入前先备份。宿主在启动时\n读取该开关，因此面板明说 **「已保存，重启 DSH 后生效」**，不假装即时生效。运行期该能力消失时，插件只告警、\n摘掉 `reflex_delegate` 并在面板显示原因——**绝不自动把你的配置改回去**。\n\n差异点：\n\n- 工具名前缀可配置（`toolPrefix`，默认 `reflex_`），例如改成 `rv_` 后是 `rv_gate`；\n- DSH 侧参数校验由 Host 的 `defineTool` 完成（必填/类型/枚举/嵌套），工具层再拦\n  截顶层未声明参数。MCP 侧发布 `inputSchema` 供客户端使用，但分派器不执行通用\n  JSON Schema 校验；错传 `claims` 而非 `assertions` 会进入空断言门禁，返回\n  `passed: false`、`needsEscalation: true`、`results: []`，不是 JSON Schema 错误。\n  执行异常返回工具结果 `isError: true`。DSH 另支持断言内可选 `criteria`，MCP 未声明此嵌套字段；\n- DSH 侧的账本读取**不经过模型**：`/reflex-ledger` 由 Host 直接渲染为文本（汇总 +\n  最近 5 条），也没有工具参数；账本是否落盘取决于 `ledgerPath`（省略时只留内存，\n  不写用户项目）。MCP 侧仍是 `reflex_status_ledger` 工具，参数与返回见上表；\n- DSH 侧的能力可用 `tools.enabled` **逐项开关**，键名是**后缀**，只接受当前 5 个后缀：\n\n  ```yaml\n  tools:\n    enabled:\n      route: true        # 打开默认关闭的候选排序\n      gate: false        # 关掉默认开启的门禁，其余照常\n  ```\n\n  后缀与 `toolPrefix` 无关：前缀改成 `rv_` 之后 `{ gate: false }` 关掉的仍是\n  `rv_gate`。被关闭的能力**不会被注册**到 `ctx.tools`，因此模型可见的工具清单里\n  没有它，`reflexToolNames()` 与前缀推导的结果里也没有它——没有「占位工具」这种\n  东西，模型不会看到一个调用即报错的空壳。`tools.enabled` 省略时按后缀默认值\n  （`choice`/`score`/`screen`/`gate` 开、`route` 关）生效；写成不存在的后缀\n  （例如 `teleport`，或已改为命令的 `prune`/`detect_stagnation`/`status_ledger`）\n  或非布尔值会在安装时被校验器拒绝，而不是被静默忽略。把 5 项全部写 `false` 后本\n  插件不注册任何工具（路由、推理强度与干预钩子不受影响）。\n\n### 9.1 五个 Harness 的能力差异\n\n同一套决策引擎接进了五个宿主，但**能力并不对等**：宿主没给出对应钩子时，该能力就是做不到。\n选宿主之前先看这张表（「是否在模型侧真实生效」才是关键，不是「有没有接线」）：\n\n| 能力 | Claude Code | DSH | Codex CLI | pi | Kimi Code | OpenCode |\n|---|---|---|---|---|---|---|\n| 剪枝（改写工具输出） | ✅ | ✅ 自动 | ⚠️ 仅 MCP 工具输出，**shell 输出改不了** | ✅ | ❌ 只记账不生效 | ✅ |\n| 停滞拦截 | ✅ | ✅ 自动 | ✅ | ✅ | ✅ | ✅ |\n| 收尾阻断 | ✅ 真阻断 | ✅ 真阻断 | ✅ | ⚠️ 只续跑一次，记 `closing-degraded-pass` | ⚠️ 需 exit-2 shim | ❌ 无法拦截 |\n| 接入形态 | hooks + MCP | 进程内插件 | hooks.json + config.toml | 进程内 TS 扩展 | hooks.toml + shim | JS 插件 |\n\n四条例外必须记住：\n\n1. **Codex**：`PostToolUse` 只接受 `updatedMCPToolOutput`，且只对 MCP 工具生效，**shell 工具输出无法改写**。\n   本机无可用模型端点，MCP 工具从未进入回合内工具清单，这一路径未真机验证。\n2. **Kimi**：`PostToolUse` / `PostToolUseFailure` / `SubagentStop` 是 observation-only，判定只进账本、\n   改变不了模型看到的内容；**剪枝只记账不生效**。`Stop` 要靠 `hooks/reflex-stop-exit2.sh` 转成 exit 2 才拦得住。\n3. **OpenCode**：宿主没有 shell 钩子机制，扩展点是 JS 插件；剪枝与停滞**生效**，但 **Stop 无法拦截**\n   （`session.idle` 不带助手文本，也无插件级否决权，只写 warn 日志）。\n4. **pi**：没有任何 API 能拒绝结束回合，`agent_before_settle` 只能请求一次续跑；矛盾未被纠正时放行并记\n   `closing-degraded-pass`，**pi 永不写 `closing-block`**。\n\n**Claude Code 与 DSH 是完整能力**。Kimi / OpenCode 的整机安装与钩子触发、Codex 的回合内 MCP 工具均未真机验证，\n复现方法见各包 README 的「Verification status」。\n\n---\n\n## 10. 决策账本与审计\n\n每次判定都会追加一条 JSONL 记录（`type` 取值：`gate`、`prune`、`stagnation`、\n`route`、`model-route`、`effort`、`choice`），字段包含后端、耗时、置信度、\n节省 token 估算与截断后的详情。查看方式：\n\n```bash\nnode dist/cli/index.js ledger      # 终端查看汇总\n```\n\n- **`/reflex-ledger`（DSH 内）**：在会话里直接输入该命令，Host 会把**本次激活**的\n  账本汇总渲染成文本（总调用数、按类型分布、平均时延、节省 token 与估算成本、\n  门禁通过/失败、停滞告警，以及最近 5 条决策）——这是命令，不是工具：**不占用模型\n  上下文、不发起模型回合**，账本为空时返回一句「暂无记录」而不是一排 0；\n- `ledgerPath` 省略 ⇒ 仅内存，关掉进程即消失（默认，用户项目零污染）；\n- 配置了路径 ⇒ 追加写 JSONL 并支持回放，面板「决策账本」页显示落盘路径；\n- 面板清空账本需要连续两次点击确认，第二次才真正删除记录与 JSONL 文件。\n\n---\n\n## 11. 测试与发布\n\n```bash\nnpm test                 # 根包：ledger / score / MCP 表面 / 打包清单\nnpm run test:plugin      # DSH 插件：注册、严格校验、工具面与 /reflex-ledger、路由、推理强度、面板、使用说明\nnpm run test:mutation    # 负向对照：注入故障，要求测试套件（或编译器）全部抓住\nnpm run test:all         # build:all + 两套测试\nnpm run release          # 全套测试 + 打包并校验 release/ 下的 tarball\nnpm run release:pack     # 只打包并校验（不跑测试；注意需先 build:all）\n```\n\n发布产物（`release/`）：\n\n| 产物 | 内容 |\n| --- | --- |\n| `harness-reflex-<version>.tgz` | 根包：`dist/`、`README.md`、`docs/`、`USER_GUIDE.md`、`experiments/` |\n| `dsh-harness-reflex-<version>.tgz` | 插件 `dsh-harness-reflex`（npm pack 命名）：`dist/`、`client.js`（内含本手册）、`cordis.patch.yml`、`locale/` |\n| `harness-reflex-claude-code-<version>.tgz` | Claude Code 插件：`.claude-plugin/`、`hooks/`、`.mcp.json` |\n| `harness-reflex-codex-<version>.tgz` | Codex 配置包：`hooks.json`、`config.toml` |\n| `pi-reflex-<version>.tgz` | pi 扩展：`src/`（发布会直接跑源码）、`scripts/`、`dist/` 声明 |\n| `harness-reflex-kimi-code-<version>.tgz` | Kimi Code 配置包：`hooks.toml`、`hooks/reflex-stop-exit2.sh`、`mcp.json` |\n| `harness-reflex-opencode-<version>.tgz` | OpenCode 插件：`plugin/reflex.js`、`opencode.json` |\n| `SHA256SUMS` | 全部 tarball 的 SHA-256 校验和 |\n| `release-report.json` | 逐项打包核验记录（文件清单、死链、依赖声明、安装冒烟） |\n| `RELEASE-<version>.md` | 由脚本生成的发布说明（机器产物；当前版本的会在每次打包时重写，**更早版本的会被保留**） |\n\n校验脚本 `scripts/release-pack.mjs` 会解压 tarball 逐个断言：必需文件齐全、\n无测试构建与临时目录、`exports`/`bin`/`dsh.bundle.patch` 目标真实存在、每个相\n对引用与 sourcemap 都能在包内解析（零死链），并在临时目录里真装一次根包、\n跑通 `import` 与 stdio MCP `tools/list`。\n\n---\n\n## 12. 常见问题排查\n\n| 现象 | 原因与处理 |\n| --- | --- |\n| 设置里找不到「Reflex 决策运行时」 | Host 半边未加载或未注册配置命名空间；确认 `dsh plugin --profile web add` 成功并重启/重载 `dsh` |\n| 面板显示只读 | 当前 DSH 设置文档不可写；只读模式下所有写操作被禁用属预期行为 |\n| 虚拟模型报错而不是派发 | 候选池为空且没有 `routing.fallback`；补候选或配置兜底目标 |\n| 文本没有按预期被路由 | 检查 `routing.enabled`、虚拟模型 ID 拼写，以及 Agent 是否真的请求了该虚拟模型 |\n| 推理强度没变化 | 策略设置为省略 = 不干预；或者调用方在请求里显式选择了具体档位 |\n| System 1 判定总是走兜底 | `timeoutMs` 过小、`baseUrl` 不可达，或 `minConfidence` 过高；先看「概览」页的最近决策与后端状态。注意超时**没有统一默认值**：省略时 `jev` 用 10000 ms、`simple-jev` 用 8000 ms |\n| 面板里的使用说明是过时副本 | 修改 `USER_GUIDE.md` 后未重新构建；执行 `npm run build:all` |\n| 关掉某个工具后模型仍在调用它 | 注册表在下一次加载时生效；重载插件后再看，并确认键名写的是**后缀**（`gate`，不是 `reflex_gate`）。`prune`/`detect_stagnation`/`status_ledger` 已不是工具，写进 `tools.enabled` 会被校验器拒绝 |\n| 默认工具清单里没有 `reflex_route` | 属预期：`route` 默认关闭，需要在工具开关页打开（或写 `tools: { enabled: { route: true } }`） |\n| 想查账本但找不到 `reflex_status_ledger` 工具 | 账本已是命令：输入 `/reflex-ledger`（stdio MCP 侧仍有同名工具） |\n| 关掉自适应推理强度后模型选择器仍有 `reflex` 档位 | 该档位是上一次加载注入的；确认配置已生效并重载插件，注入即被撤销 |\n| 保存配置时报错「只支持留空或 reflex」 | 配置里仍写着具体档位；删掉该值（或改成 `reflex`）。需要固定深度请在模型选择器里选择具体档位 |\n| 保存「自动干预」后配置里多出默认值 | 属预期：该组是整组写回，模式与全部预算按面板当前值完整写入 |\n\n---\n\n## 13. 版本与兼容性\n\n- 版本：`harness-reflex` 与 `dsh-harness-reflex` 同步发布，v0.3.0；五个宿主插件包同版本；\n- Node：`>= 18`（根包 `engines`；`pi-reflex` 为 `>= 22.19.0`）；DSH Host 依赖 `@deepseek-ai/*@0.2.1-alpha.4`；\n- 插件以 `peerDependencies` 声明 Host 契约，运行时不重复打包 Host 模块；\n- stdio MCP 的 8 工具表面自 v0.1.0 起冻结，Host 侧变更不得静默改动其载荷；\n- DSH 插件侧的工具表面自 v0.1.0 起是 **5 个可开关能力、默认注册 4 个**\n  （`route` 默认关闭），账本为 `/reflex-ledger` 命令——这一侧不承诺与 MCP 侧逐项对齐。\n";
			/** en user guide, verbatim Markdown. */
			exports.GUIDE_EN = "# Harness Reflex User Guide (v0.1.0)\n\n> This is the complete manual for the **`dsh-harness-reflex` plugin** and the\n> **`harness-reflex` core package**. The same text is embedded into\n> `packages/dsh-harness-reflex/client.js`, so it can be read directly in the DSH\n> settings panel under the **“Guide”** tab (it follows the DSH interface\n> language, Chinese or English).\n> Editing this file therefore requires re-running `npm run build:all`, otherwise\n> the panel keeps the last build (`npm run test:plugin` checks the\n> document digest and fails on drift).\n\n---\n\n## 1. What Harness Reflex is\n\nHarness Reflex is a **System One (fast-thinking) decision runtime**: without\npaying for generative System Two reasoning it performs millisecond-scale\nprobabilistic judgements — verification gates, context pruning, stagnation\nbreaking, model routing and reasoning-effort decisions — and records every\ndecision in an auditable ledger.\n\nIt ships in two forms that share one decision engine but expose **different tool surfaces** (see section 9):\n\n| Form | Package | Harness | Transport |\n| --- | --- | --- | --- |\n| stdio MCP server | `harness-reflex` | Claude Code, Codex CLI, AGY | MCP JSON-RPC child process |\n| DSH Host plugin | `dsh-harness-reflex` | DeepSeek Harness (`dsh`) | In-process `ctx.tools` / Cordis hooks |\n\nThe MCP surface exposes eight tools; the DSH surface registers five switchable\ntools (four by default), while pruning, stagnation detection and the ledger are\ncarried by automatic interventions and the `/reflex-ledger` command. See section 9\nand each surface's actual tool definitions for argument and validation boundaries.\n\n---\n\n## 2. Plugin architecture\n\n```text\n┌──────────────────────────────────────────────────────────────────────┐\n│                          Harness Layer                               │\n│   Claude Code (.mcp.json) · Codex (.codex/config.json) · AGY bundle   │\n└───────────────┬──────────────────────────────────┬───────────────────┘\n                │ stdio MCP                        │ in-process DSH Cordis\n┌───────────────▼──────────────────┐  ┌────────────▼───────────────────┐\n│ harness-reflex core (dist/)      │  │ dsh-harness-reflex plugin          │\n│  gate · prune · stagnation       │◄─┤  src/bridge.ts  ReflexRuntime  │\n│  route · screen · score          │  │  src/tools.ts   5 switchable    │\n│  ledger · calibrate              │  │  src/router.ts  virtual provider│\n└───────────────┬──────────────────┘  │  src/effort.ts  effort intercept│\n                │ DecisionBackend     │  src/panel-*    settings + API  │\n┌───────────────▼──────────────────┐  └────────────┬───────────────────┘\n│ mock · simple-jev/vLLM · Jev API  │               │ settings.section\n└──────────────────────────────────┘  ┌────────────▼───────────────────┐\n                                      │ client.js browser panel (React) │\n                                      │ Overview / Virtual provider /   │\n                                      │ Effort / Backend / Interventions│\n                                      │ Tools / Ledger / Guide          │\n                                      └────────────────────────────────┘\n```\n\nKey modules of the plugin:\n\n| File | Responsibility |\n| --- | --- |\n| `src/index.ts` | Cordis entry `apply(ctx, config)`; install and teardown inside one `ctx.effect` |\n| `src/bridge.ts` | `ReflexRuntime`: backend / ledger / calibrator / decision services of one activation |\n| `src/tools.ts` | The five switchable `reflex_*` tools, four registered by default (Host `defineTool` validation plus an undeclared-argument fence) |\n| `src/router.ts` | `VirtualModelRouter`: candidate pool → System 1 decision → fallback / fail-closed → audit |\n| `src/virtual-adapter.ts` | `LlmAdapter` surface of the virtual provider plus a dispatch-layer safety net |\n| `src/routing.ts` | `installModelRouting`: registers the virtual provider, hooks `agent/pre-step` and `agent/request` |\n| `src/effort.ts` | `EffortInterceptor`: per-turn reasoning-effort decision, projection and status reporting |\n| `src/session-audit.ts` | Writes/reads `plugin:dsh-reflex/effort` session records without polluting model context |\n| `src/panel-api.ts` | Read-only panel projection and the `/dsh-reflex/api/*` routes (loopback only) |\n| `src/client/*` | Browser half: slot registration, zh/en copy, Markdown renderer, panel views |\n\nActivation order: DSH loads the plugin → `apply` resolves the configuration →\n`ReflexRuntime` is built → the virtual provider and request hooks are installed →\nthe four default tools (five with `route` switched on) are registered →\nthe `/reflex-ledger` command is registered → the panel routes are mounted.\nUnloading unwinds in reverse and is fully reversible.\n\n---\n\n## 3. Install and build\n\n```bash\n# 1) install dependencies and build (root → link host deps → plugin → client bundle)\nnpm install\nnpm run build:all\n\n# 2) configure a target harness (writes .mcp.json / .codex/config.json / the AGY bundle)\nnode dist/cli/index.js setup all      # or claude | codex | agy\n\n# 3) install as a DSH plugin (in-process integration, recommended)\n#    release tarball: --force is required to reinstall the same version\ndsh plugin --profile web add --force ./release/dsh-harness-reflex-0.1.0.tgz\n```\n\nEvery step of `npm run build:all` is required:\n\n1. `tsc`: root `src/` → `dist/`;\n2. `node scripts/link-dsh-deps.mjs`: symlinks this machine's `@deepseek-ai/*`\n   packages into `packages/dsh-harness-reflex/node_modules/` (fully offline, no registry);\n3. `tsc -p packages/dsh-harness-reflex/tsconfig.json`: plugin Host half → `packages/dsh-harness-reflex/dist/`;\n4. `node scripts/embed-user-guide.mjs` + `tsc -p tsconfig.client.json` +\n   `node packages/dsh-harness-reflex/dist/client-bundle.js packages/dsh-harness-reflex`:\n   embeds this manual into the browser half and emits the single-file `client.js`.\n\n> The order is not interchangeable: `client.js` must be built after this\n> document changes, otherwise the panel shows a guide that differs from the\n> repository document.\n\n---\n\n## 4. System 1 backend configuration\n\nAll three backends share one set of `SYSTEM_ONE_*` environment variables and\nplugin options; resolution order is “plugin config > environment > default mock”.\n\n| Backend | Value | Notes |\n| --- | --- | --- |\n| Local heuristics (default) | `mock` | Deterministic, no network, sub-millisecond; for offline dev and tests |\n| Generic logits read-out | `simple-jev` | vLLM / OpenAI-compatible `max_tokens: 1` with next-token logprobs |\n| Official Jev / System One API | `jev` | `POST {BASE_URL}/v1/...`, requires an API key |\n\n```bash\n# Official Jev: only the key is required\nexport SYSTEM_ONE_API_KEY=\"your-api-key\"\n\n# Self-hosted vLLM (OpenAI compatible): only the endpoint is required\nexport SYSTEM_ONE_BASE_URL=\"http://localhost:8000\"\nexport SYSTEM_ONE_BACKEND=simple-jev     # optional: VLLM_BASE_URL/OPENAI_BASE_URL alone selects simple-jev\n```\n\nWith `SYSTEM_ONE_BACKEND` unset the choice is derived: `SYSTEM_ONE_API_KEY`/`JEV_API_KEY` present → `jev`;\n`VLLM_BASE_URL`/`OPENAI_BASE_URL` present → `simple-jev`; neither → `mock`.\n\nThe other two variables default per backend, so “default mock” says nothing about them:\n\n| Variable | `jev` | `simple-jev` |\n| --- | --- | --- |\n| `SYSTEM_ONE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | `http://localhost:8000` |\n| `SYSTEM_ONE_MODEL` | `jev-latest` | `Qwen/Qwen2.5-7B-Instruct` |\n| `SYSTEM_ONE_API_KEY` | **none** (empty; the service rejects the request) | `dummy` (local servers usually ignore it) |\n\nPlugin options (editable on the “System 1 backend” page, or in the DSH plugin config):\n\n| Option | Default | Notes |\n| --- | --- | --- |\n| `backend` | `auto` | `auto` derives from the environment; may be pinned to `mock` / `vllm` / `jev` (`vllm` is the logits read-out; the env name is `simple-jev`) |\n| `baseUrl` | unset | System 1 endpoint; unset uses the backend default |\n| `model` | unset | Server-side model id; unset uses the backend default (`jev-latest` / `Qwen/Qwen2.5-7B-Instruct`) |\n| `apiKeyEnv` | unset | Stores the **variable name only**; the secret never enters the settings document. Unset falls back to the backend's own chain (`SYSTEM_ONE_API_KEY` → `JEV_API_KEY` → `VLLM_API_KEY` → `OPENAI_API_KEY`) |\n| `timeoutMs` | unset | Per-decision timeout; unset uses the **backend default — 10000 ms for `jev`, 8000 ms for `simple-jev`**, not one shared value; a timeout follows the “System 1 unavailable” degradation path |\n\nCalibration (optional): fit a PAVA/ECE curve with the `calibrate` engine over a\nlabelled sample, then point `calibrationPath` at that JSON and the runtime will\ncorrect over-confident raw probabilities.\n\n---\n\n## 5. Virtual provider and model pools\n\n**Concept.** The plugin registers one virtual provider (id `reflex` by default)\nthat generates no tokens itself: when a request targets a virtual model such as\n`reflex/reflex-auto`, the `agent/request` hook asks System 1 to pick a real\n`provider/model` from that virtual model's **physical candidate pool**, rewrites\nthe request, lets it continue, and appends a `type: model-route` ledger entry.\n\nConfiguration shape (corresponding YAML):\n\n```yaml\nrouting:\n  enabled: true\n  virtualProvider: reflex\n  maxTaskChars: 400          # task-text budget per participating agent\n  fallback: deepseek:deepseek-chat   # used when no pool can answer\n  models:\n    reflex-auto:             # virtual model id\n      - provider: deepseek\n        model: deepseek-reasoner\n        description: long-horizon reasoning and refactors\n        tags: [reasoning, expensive]\n      - provider: deepseek\n        model: deepseek-chat\n        description: everyday chat and quick edits\n        tags: [fast, cheap]\n    reflex-fast:\n      - provider: deepseek\n        model: deepseek-chat\n        description: latency-sensitive work\n        tags: [fast]\n```\n\n**Rules and boundaries.**\n\n- `enabled: false`, or an empty `models` map ⇒ no virtual provider is\n  registered and behaviour matches an installation without the plugin.\n- An empty pool with no `fallback` ⇒ **fail-closed**: an error instead of a\n  random dispatch.\n- `virtualProvider` may not contain `:`; candidate `provider` and `model` may\n  not be empty.\n- Primary agents and subagents share the same interception path, and the loop\n  identity survives the rewrite unchanged.\n- Candidates, the selection, confidence and latency all reach the ledger, which\n  the “Decision ledger” page replays.\n\n**Context awareness and session stickiness (cache savings, no gratuitous\nswitches).** Changing models invalidates the server-side prompt prefix cache, so\nrouting is not “pick again every turn”: by default it **holds the physical model\nthe session is already using**.\n\n- The plugin accumulates, per agent, the context size it has observed for this\n  session (the characters `agent/pre-step` hands it, at roughly 4 characters per\n  token) and gives every decision both that number and the **current physical\n  model** (`state.currentModel` / `state.contextTokens` / `state.contextChars`).\n- The decision prompt states the policy as well: keeping the current model keeps\n  the prompt cache, so switch only when another candidate is **clearly better\n  suited**. The current candidate is marked in the list with\n  `[current model — keeping it preserves the prompt cache]` and the `current: true`\n  flag, so a text-reading backend and a flag-reading backend see one signal.\n- After the backend ranks the pool, a **sticky gate** still applies: a challenger\n  must score higher *and* by more than a relative `stickyMargin` (15% by default)\n  before the request actually moves. Ties and marginal wins stay put.\n- Every `model-route` entry records `currentModel`, `switched` and\n  `contextTokens`, so “why did this turn not switch” is replayable rather than\n  guessed.\n- Stickiness only applies **inside one pool**: when the current model is not a\n  candidate this turn (say the session moved to another virtual model), the pool’s\n  own ranking decides and `switched` is recorded as `true`.\n\n**Configuring it in the panel.** Open DSH settings → “Reflex runtime” →\n**Virtual provider**: toggle routing, fill in the provider name, the fallback\ntarget and the task-text budget, then add virtual models and candidates\n(up/down reorders them) and press **Save** to write the whole group. The panel\nvalidates through the same Host-side `resolveConfig` used at load time, so an\ninvalid document (empty id, duplicate model, cross-group mistake) is rejected\nwith a specific message.\n\n---\n\n## 6. Adaptive reasoning effort (`reflex` / `auto`)\n\nWith the effort policy set to `reflex` (`auto` means the same), the plugin intercepts the\nintent and context before each real API request, asks System 1 for the\n`reasoningEffort` this turn needs, and rewrites the outgoing parameter.\n\n| Option | Default | Notes |\n| --- | --- | --- |\n| `effort.reasoningEffort` | unset | `reflex` / `auto` = per-turn adaptive; unset = never intervene, the plugin never touches `reasoningEffort`; a concrete level is chosen in the model selector, and the offered levels follow what the target model declares |\n| `effort.fallback` | `medium` | Deterministic cue vote used when System 1 is unavailable or below the confidence floor |\n| `effort.minConfidence` | `0.3` | Decisions below this confidence go to the fallback instead |\n| `effort.enabled` | `true` | `false` turns the whole layer off: no judgment, no audit, no injected `reflex` level |\n\nConfiguration answers exactly one question: **should adaptive effort run at all?**\n\n- **blank (the default) = never intervene**: the plugin never rewrites\n  `reasoningEffort` and produces no decision or audit record, so the request\n  behaves exactly as if this feature were not installed;\n- **`reflex` (`auto` means the same) = adaptive**: every turn is decided by System 1;\n- **to fix the thinking depth**: choose a concrete level in the model selector; the\n  offered levels follow what the target model declares. Configuration only accepts\n  blank or `reflex` (`auto` means the same); any other value is rejected at startup\n  with a hint to pick the level in the model selector.\n\n**Behaviour contract.**\n\n- A concrete `reasoningEffort` chosen explicitly by the caller on the request\n  always stays transparent; the plugin never overrides it.\n- A target model that does not support thinking levels degrades safely instead\n  of receiving the parameter verbatim.\n- Every turn writes one audit record (`plugin:dsh-reflex/effort`) containing the\n  decided level, the confidence and a truncated task excerpt; it never enters\n  the model-visible context.\n- The decision is projected to the status line as well; the Overview page shows\n  the latest one (for example `reflex: high (confidence 0.82, system-one, 12.4 ms)`).\n\n**Turning the whole layer off (`effort.enabled: false`).**\n\n`effort.enabled` is a **capability switch**, independent of what the policy is:\n`reasoningEffort: reflex` together with `enabled: false` is a legitimate\ncombination whose meaning is \"install none of this interception\" (the only\ndifference being that the policy is still written down). With it off:\n\n- **no judgment**: no System 1 call, no cue vote, no judgment cache, and no\n  `reflex/effort` status published — the Overview page shows no decision of this\n  plugin;\n- **no audit**: no `effort-decision` entry in the ledger and no\n  `plugin:dsh-reflex/effort` record in the session log;\n- **no injected level**: the level this plugin injected (`reflex` / `auto`) is\n  revoked from the model selector, which keeps only the adapter's own levels and\n  its declared default;\n- **concrete levels pass through verbatim**: a `high`, `medium` and so on chosen\n  explicitly by the caller on the request is not even aligned onto the routed\n  model's vocabulary;\n- **the marker still cannot leak**: if an existing session or a hand-built call still\n  carries this plugin's marker, it is **deleted at the physical adapter\n  boundary** rather than translated into a level, so the provider's own default\n  applies and no plugin marker ever reaches a real provider.\n\nIt defaults to `true` (omitted means `true`), so not writing this option behaves\nbyte-identically to writing `true` explicitly.\n\n---\n\n## 7. Automatic intervention gates (`off` / `observe` / `active`)\n\nThe plugin can intervene on its own through the Host's native hooks, **without the\nmodel calling any `reflex_*` tool**. There is exactly one switch, `interventions.mode`, taking `off`,\n`observe` or `active`, and it defaults to `observe`:\n\n```yaml\ninterventions:\n  mode: observe        # off | observe | active\n  capabilities:        # optional per-capability override; inherit follows mode\n    stagnation: inherit\n    prune: inherit\n    gate: inherit\n    closing: inherit\n  maxInterventionsPerTurn: 3\n  maxJudgmentsPerTurn: 3\n  maxJudgmentsPerSession: 20\n```\n\nEach of the four capabilities is **four-state**: `off` / `observe` / `active`\noverride `mode` explicitly, while `inherit` (or omitting it) follows `mode`. You\ncan therefore keep the gate `active` overall and lower `prune` alone to\n`observe` (accounting only, no rewriting), or set everything to `off` and open\nup `gate` only.\n\n| Mode | Behaviour |\n| --- | --- |\n| `off` | No hook listener is registered at all; tool execution is byte-identical to running without the plugin |\n| `observe` (default) | Full detection and judging, accounting only: no content rewriting, no injected message, no refused tool, no steer |\n| `active` | The full chain: a repeated call is refused before it runs, an oversized result is pruned before it enters the context, a repeated failure is rewritten into corrective feedback, and a turn closing on contradicted evidence is objected to |\n\n| Capability | Hook | What `active` does |\n| --- | --- | --- |\n| `stagnation` | `tools/pre-execute`, `agent/pre-step` | After a confirmed repetition or oscillation, refuses that call or attaches corrective context to the next step |\n| `prune` | `tools/post-execute` | For a result above the threshold, retains the original first and then rewrites: the original goes into the session log under a locator, and the replacement keeps head and tail and names that locator |\n| `gate` | `tools/post-execute` | Rewrites the result into corrective feedback once one call has failed repeatedly; failure is read from the tool source's structured exit status or the Host's exit badge, never from wording |\n| `closing` | `agent/turn-stopping` | Re-checks the turn's claims against its evidence with `reflex_gate` and steers once when they contradict |\n\n### Why a legitimate wait is never treated as stagnation (the exemption default)\n\nWaiting on a background job is legitimate work, so `stagnation` exempts **structurally\nidentifiable wait queries**. The decision reads two structured facts only — it never parses a\ntool's description and never reads any output text:\n\n1. **tool identity**: the call is one of the Host's own background-job query tools, `job_output`\n   or `job_list` (registered by `@deepseek-ai/dsh-tool-jobs`; the shell tools' background jobs go\n   through the same `job_output` verb);\n2. **call shape**: the arguments carry the job handle in the Host's own declared field — a\n   non-empty `job_id` string for `job_output`; `job_list` declares no parameters at all, so its\n   shape is the empty argument object.\n\nAn exempt call is never refused, never gets corrective context, and spends none of the turn's\nintervention or judgment allowance; `observe` and `active` plan exactly the same thing. It is\nstill recorded in the detection window, but it does not count as an unproductive repeat — the\nrepetition, failing-retry, and oscillation triggers all skip it — so **a real loop does not\ndisappear just because the run waited for a job in between**. `job_kill` is deliberately outside\nthe exemption: it terminates a job rather than waiting for one. Output text that happens to\ncontain `wait`, `sleep`, or `poll` earns nothing. The scope is the two tool names above; this is\nthe documented default and needs no extra configuration.\n\n### How to get a pruned original back\n\n`active` pruning retains first and replaces second, and that order is not a figure of speech:\n\n1. the replacement is built only after the judgment passed **and** retention succeeded;\n2. the original is written into the session log as a `plugin:dsh-reflex/pruned-original`\n   record (the Host's `appendPluginRecord`); it never enters the model-visible surface, and\n   `fork` / `resume` carry it with the rest of the log;\n3. the replacement names the locator `plugin:dsh-reflex/pruned-original#<digest>` in its\n   middle, so the model can always ask for the omitted part;\n4. when retention fails (no session, a missing log, a failed read-back check) **nothing is\n   replaced** and no `actualSavedTokens` is reported — the result stays byte-identical\n   (recorded as `retention-failed`; the judgment was really paid for, and is still booked).\n\nRetrieval is a read of the session events under that locator:\n\n```ts\nimport { readPrunedOriginal } from 'dsh-harness-reflex';\n\nconst record = readPrunedOriginal(session.ownEvents(), locator);\nrecord?.text;    // the original, byte for byte\nrecord?.chars;   // the size it was retained at\nrecord?.digest;  // the digest the decision was recorded under\n```\n\nThe `pruneFloorRatio` floor (0.5 by default) is the **smallest share of the original the\ninstalled text may keep**: a judged candidate below it is padded with head and tail context\nup to that share, and the middle diagnostics the judgment chose are kept whole — the floor\nnever drops them. Retention has boundaries: a payload with fewer than four newlines (under\nfive lines) or more than 100 000 characters is not pruned at all (recorded as\n`unsupported-payload` / `retention-too-large`), so single-line output and oversized logs pass\nthrough untouched; a payload that repeats reuses the copy retained the first time instead of\nwriting a second one.\n\n### Cost and traceability\n\n- The ledger is split by `mode` and by `capability`: `plans` (decisions taken),\n  `applied` (decisions executed), `judgments` / `memoHits`, `judgeTokens`,\n  `originalTokens` / `candidateTokens` / `potentialSavedTokens` (what could be\n  saved) / `actualSavedTokens` (what really stopped entering the context);\n- `observe` always reports `actualSavedTokens` 0, and its `potentialSavedTokens`\n  matches `active` on the same input, item by item;\n- Judging cost is separated: `localLatencyMs` (local arbitration) versus\n  `remoteLatencyMs` (backend judgment);\n- Every pruning record carries the replaced original's `digest`, its `turn`/`step` and its\n  `originalLocator`; that locator reads the original back byte for byte (see \"How to get a\n  pruned original back\" above);\n- Retention is a precondition of replacement: when it fails nothing is replaced and no\n  `actualSavedTokens` is reported, and `plans` does not claim a reduction that never happened;\n- `off` is strictly zero behaviour: no listener, no sampling, no judgment — byte-identical to\n  running without the plugin;\n- The judgment cache is keyed by turn plus trailing window: one question costs one\n  judgment per turn. `maxJudgmentsPerTurn`, `maxJudgmentsPerSession` and\n  `maxInterventionsPerTurn` bound judgments per turn, judgments per session and\n  interventions per turn;\n- Interventions for one `(agent, call signature)` are de-duplicated within a turn,\n  and the result of a call this plugin refused is never judged a second time;\n- This plugin's own tools are never judged — their output is already the\n  optimizer's (four by default, five with `route` on) — so no `reflex_*` payload\n  this plugin registers is ever re-judged.\n\n### Safety and rollback\n\n- **fail-open**: any judging step that throws hands the downstream result on\n  unchanged (recorded as `planning-error`); a tool call never fails because of it;\n- **failure is never inferred from wording**: the structured `exitCode`/`signal` decides, then\n  the exit badge the Host appends as the last line; the word \"failed\" inside an ordinary result\n  is not a failure and never blocks a legitimate retry;\n- **Monotonic permission**: `tools/pre-execute` only ever appends a `deny` to a downstream\n  `allow`; an `ask`/`deny`/`cancel` from downstream is returned as the same object, with its\n  `info` intact — never loosened, never overwritten;\n- **Session isolation**: detection windows, verdict caches and budgets are booked\n  per agent and never shared between agents;\n- **No residue**: unloading the plugin detaches every listener and clears the\n  engine's state; the ledger stays in memory unless `ledgerPath` is set.\n\n---\n\n## 8. Settings panel (DSH Settings UI)\n\nThe plugin declares its browser half through `dsh.client` and registers into the\n`settings.section` slot:\n\n| Tab | Content |\n| --- | --- |\n| Overview | Decision count, tokens saved, average latency, gate pass/fail, latest adaptive decision |\n| Virtual provider | Routing switch, provider name, pool editing and ordering, fallback target |\n| Reasoning effort | Policy (never intervene / Reflex adaptive), fallback level, minimum confidence, **adaptive-effort switch** |\n| Interventions | Three-state mode (`off`/`observe`/`active`), the four capability overrides, per-turn intervention budget, per-turn judgment budget, per-session judgment budget, repeat threshold, failure threshold, minimum confidence, judgment window size, prune floor ratio; plus the currently effective mode and capabilities (read-only) |\n| Tools | A per-capability switch for each of the five capabilities (four on, `route` off by default), each one stating **what it does / when the agent should call it / whether it is advised to expose it**, plus an \"Apply recommended set\" button; the currently registered tool names are listed at the end (read-only, follows `toolPrefix`), with a line pointing the ledger at `/reflex-ledger` |\n| System 1 backend | Implementation, base URL, model id, API-key variable name, timeout; plus the tool-name prefix, prune threshold, ledger JSONL path and calibration-curve path |\n| Decision ledger | Live metrics, recent-decision table, JSONL sink, clear (confirmed twice) |\n| **Guide** | **A read-only view of this manual, following the DSH interface language** |\n\n- Saving is **whole-group**: editing one field validates and writes the entire\n  configuration group on every configuration path it covers (the System 1\n  backend page spans `backend`, `systemOne`, `toolPrefix`, `ledgerPath`,\n  `pruneThreshold` and `calibrationPath`).\n- When the Host settings document is read-only the page becomes read-only and\n  every write control is disabled.\n- Panel routes under `/dsh-reflex/api/*` (`panel` / `health` / `ledger/clear`) accept loopback clients only, and\n  clearing the ledger requires an explicit confirmation.\n\n### What each group writes back\n\nThe panel always shows the **currently effective values**, and saving goes\nthrough the Host settings document's only write channel (a per-group `set` plus\nthe revision check) — there is no second write path. The groups differ in how\nmuch they write:\n\n- **Interventions: whole-group write-back.** Saving that group writes the\n  group's **current mode and every budget value in full**, exactly like the\n  virtual-provider and reasoning-effort groups, so what the configuration keeps\n  is the complete set of values you see, not only the field you edited.\n  Capability overrides write only the entries that are **not** `inherit`; the\n  rest stay omitted (omitted = follow the mode).\n- **Tools: only departures from the default are written.** A default-on tool\n  switched off is written as `false`, the default-off `route` switched on is\n  written as `true`, and switching anything back to its default **deletes** the\n  key. The recommended set and \"the whole group omitted\" are therefore\n  byte-identical (the default already is four on, one off), and the default\n  configuration does not change at all.\n- **The reasoning-effort switch is always written explicitly.** `effort.enabled`\n  is saved with the group's current value, so there is no \"the panel shows it\n  enabled but the configuration actually omits it\" ambiguity.\n- **System 1 backend: one whole value per schema path.** The Host settings\n  document is addressed by **configuration path**, and this page covers\n  `backend` (a scalar), `systemOne` (the connection block), and the four\n  top-level fields `toolPrefix`, `ledgerPath`, `pruneThreshold` and\n  `calibrationPath`: saving writes each of those paths in full (only for the\n  group that changed), and a **page name is never used as a configuration key** —\n  `runtime` is not a field of `Config`, so writing under that name is refused by\n  the Host outright and the whole save fails with it. A blank `ledgerPath` or\n  `calibrationPath` is written as \"unset\", which keeps the layer below instead of\n  storing an empty string.\n\nAn illegal value (an unknown tool suffix, a non-boolean, an out-of-range budget,\nan invalid three-state value) is rejected by the same Host-side `resolveConfig`\nvalidator with a field-level message, and the panel applies nothing partially:\nthe whole group passes, or not a byte of it is written.\n\n### Tool switches: two kinds of advice, and the recommended set\n\nEvery entry on the tools page states three things: **what the capability does**,\n**when the agent should call it**, and one label answering **whether it is advised\nto expose it to the agent**:\n\n| Advice | Meaning | Capabilities |\n| --- | --- | --- |\n| Suggested for the agent | The agent genuinely uses it in day-to-day work | `choice`, `score`, `screen`, `gate` |\n| Opt-in | It only pays off when there are many candidates, so it is off by default | `route` |\n\nThe \"**Apply recommended set**\" button at the top pre-fills those five switches\nand switches `route` off. **That recommended set is the default**: with\n`tools.enabled` omitted, `choice`, `score`, `screen` and `gate` are on and `route`\nis off, so the DSH plugin exposes four tools by default. The button pre-fills the\ndraft only and writes nothing — the group is still saved when you press Save, and\na draft that already equals the default writes **nothing at all** (there is no\ndifference to record).\n\n`route` is an optional extra: switching it on (on the page, or with\n`tools: { enabled: { route: true } }`) is what registers `reflex_route`; the main\nflow does not depend on it.\n\nThree capabilities are **commands and hooks now** and therefore have no switch here:\n`prune` (result pruning) and `detect_stagnation` (stagnation detection) are driven\ndirectly by the intervention layer as `observe`/`active` take effect, and the\nledger summary moved to the `/reflex-ledger` command. A line at the end of the\npage points both out; the stdio MCP side still carries all eight tool names, see\nthe next section.\n\n---\n\n## 9. MCP tools ↔ DSH native capabilities\n\nThe two forms **use different tool sets**: the stdio MCP side still exposes\nthe **eight tools frozen since v0.1.0**, while the DSH plugin side registers\n**five switchable capabilities (four by default)** — the other three are carried\nby the automatic intervention layer and by one command instead of occupying the\nmodel's tool list.\n\n| Capability | MCP tool name (`harness-reflex mcp`) | DSH plugin side (`dsh-harness-reflex`) | Main arguments | Advice |\n| --- | --- | --- | --- | --- |\n| Multi-option classification | `reflex_choice` | tool `reflex_choice` | `question`, `options[]`, optional `context` | Suggested for the agent |\n| Continuous rating | `reflex_score` | tool `reflex_score` | `statement`, optional `criteria`, `context` | Suggested for the agent |\n| Prompt-injection screen | `reflex_screen` | tool `reflex_screen` | `content`, optional `source`, `strict` | Suggested for the agent |\n| Claim/evidence gate | `reflex_gate` | tool `reflex_gate` | `assertions[{statement}]`, `evidence`, optional `strictness` | Suggested for the agent |\n| Candidate ranking | `reflex_route` | tool `reflex_route` (**not registered by default**) | `goal`, `candidates[]`, optional `topK` | Opt-in |\n| Subagent delegation | `reflex_delegate` | tool `reflex_delegate` (**only registered after you tick Delegation in the settings panel, and the host delegation tool then declares a reasoning level, i.e. `modelSelection` is on**) | `prompt`, `description`, optional `provider`, `model`, `cwd` | Suggested for the agent |\n| Long-output pruning | `reflex_prune` | no tool: result pruning runs automatically from hooks such as `tools/pre-execute`, following the intervention mode | `rawOutput`, optional `intent`, `shadowMode` | — |\n| Stagnation detection | `reflex_detect_stagnation` | no tool: stagnation detection is part of the automatic intervention layer | optional `recentAction`, `goal`, `history[]` | — |\n| Ledger audit | `reflex_status_ledger` | no tool: use the `/reflex-ledger` command (no arguments) | optional `includeEntries` (returns `summary`, optionally `recentEntries`) | For humans |\n\nTicking **Delegation** is an explicit consent with a side effect outside this plugin: it merges\n`tool-subagent: { modelSelection: true }` into your profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`),\npreserving every other byte of it and backing it up first. The host reads that switch at start-up, so the\npanel says **\"saved — takes effect after you restart DSH\"** rather than pretending it is live. If the capability\ndisappears at runtime, the plugin warns, withdraws `reflex_delegate`, and shows the reason — it never writes your\nconfiguration back on its own.\n\nDifferences:\n\n- The tool-name prefix is configurable (`toolPrefix`, default `reflex_`), so\n  `rv_` yields `rv_gate` and friends.\n- On the DSH side argument validation comes from the Host's `defineTool`\n  (required/type/enum/nested) plus an undeclared top-level argument fence; on the\n  MCP side advertises `inputSchema` for clients but its dispatcher does not run\n  generic JSON Schema validation. Passing `claims` instead of `assertions` reaches\n  the empty-assertion gate and returns `passed: false`, `needsEscalation: true`,\n  `results: []`, not a JSON Schema error. Execution exceptions return a tool result\n  with `isError: true`. DSH additionally accepts optional per-assertion `criteria`;\n  MCP does not declare that nested field.\n- Reading the ledger on the DSH side **never reaches the model**: `/reflex-ledger`\n  is rendered into text by the Host (the summary plus the five most recent\n  decisions) and takes no tool arguments; whether the ledger persists depends on\n  `ledgerPath` (unset keeps it in memory and never writes into the user's\n  project). The MCP side keeps the `reflex_status_ledger` tool with the arguments\n  in the table above.\n- DSH-side capabilities can be **switched individually** with `tools.enabled`,\n  keyed by **suffix**; only the five current suffixes are accepted:\n\n  ```yaml\n  tools:\n    enabled:\n      route: true        # switch on the candidate ranking, off by default\n      gate: false        # switch off the gate, on by default; the rest stay available\n  ```\n\n  The suffix is independent of `toolPrefix`: after renaming the prefix to `rv_`,\n  `{ gate: false }` still closes `rv_gate`. A closed capability is **not\n  registered** into `ctx.tools`, so it is absent from the model-visible tool list\n  and from `reflexToolNames()` and its prefix derivation — there is no\n  \"placeholder tool\" and the model never sees a shell that fails on every call.\n  With `tools.enabled` omitted the per-suffix default applies\n  (`choice`/`score`/`screen`/`gate` on, `route` off); an unknown suffix (say\n  `teleport`, or one that has become a command such as\n  `prune`/`detect_stagnation`/`status_ledger`) or a non-boolean is rejected by the\n  validator at install time instead of being ignored. Writing `false` for all five\n  registers no tool at all (routing, reasoning effort and the intervention hooks\n  are unaffected).\n\n---\n\n## 10. Decision ledger and audit\n\nEvery judgement appends one JSONL record (`type` is one of `gate`, `prune`,\n`stagnation`, `route`, `model-route`, `effort`, `choice`) carrying the backend,\nlatency, confidence, token-savings estimate and a truncated detail field:\n\n```bash\nnode dist/cli/index.js ledger      # terminal summary\n```\n\n- **`/reflex-ledger` (inside DSH)**: type the command in a session and the Host\n  renders **this activation's** ledger summary into text (total calls, breakdown\n  by type, average latency, tokens saved and the estimated cost, gate\n  pass/fail, stagnation alerts, and the five most recent decisions). It is a\n  command, not a tool: it **costs no model context and opens no model turn**, and\n  an empty ledger answers \"no records yet\" instead of a row of zeroes;\n- `ledgerPath` unset ⇒ memory only, gone with the process (the default, so user\n  projects stay untouched);\n- a configured path ⇒ append-only JSONL with replay, and the panel's ledger page\n  shows the sink path;\n- clearing the ledger needs two consecutive clicks in the panel; only the second\n  one deletes the entries and the JSONL file.\n\n---\n\n## 11. Tests and release\n\n```bash\nnpm test                 # root package: ledger / score / MCP surface / packaging manifest\nnpm run test:plugin      # DSH plugin: registration, strict validation, tool surface and /reflex-ledger, routing, effort, panel, guide\nnpm run test:mutation    # negative control: injected faults must be caught by the suite (or the compiler)\nnpm run test:all         # build:all + both suites\nnpm run release          # all suites + pack and verify the tarballs in release/\nnpm run release:pack     # pack and verify only (no tests; run build:all first)\n```\n\nRelease artifacts (`release/`):\n\n| Artifact | Content |\n| --- | --- |\n| `harness-reflex-<version>.tgz` | Root package: `dist/`, `README.md`, `docs/`, `USER_GUIDE.md`, `experiments/` |\n| `dsh-harness-reflex-<version>.tgz` | Plugin `dsh-harness-reflex` (npm pack naming): `dist/`, `client.js` (with this manual embedded), `cordis.patch.yml`, `locale/` |\n| `SHA256SUMS` | SHA-256 checksums of the two tarballs |\n| `release-report.json` | The per-check packaging audit (entries, dead links, dependency declarations, install smoke) |\n| `RELEASE-<version>.md` | Release notes: install commands, verification checklist, contents |\n\nThe verifier `scripts/release-pack.mjs` extracts each tarball and asserts: every\nrequired file is present, no test build or temporary directory ships, the\n`exports`/`bin`/`dsh.bundle.patch` targets really exist, and every relative\nimport and source map resolves inside the package (zero dead links). It then\ninstalls the root tarball into a scratch directory and exercises `import` plus\nstdio MCP `tools/list` for real.\n\n---\n\n## 12. Troubleshooting\n\n| Symptom | Cause and fix |\n| --- | --- |\n| No “Reflex runtime” entry in settings | The Host half is not loaded or registered no configuration namespace; re-check `dsh plugin --profile web add` and reload `dsh` |\n| The panel is read-only | The DSH settings document is not writable; disabled writes are expected in that mode |\n| A virtual model errors instead of dispatching | The pool is empty and `routing.fallback` is unset; add candidates or a fallback target |\n| Text is not routed as expected | Check `routing.enabled`, the virtual model id spelling, and whether the agent actually requested that virtual model |\n| Reasoning effort never changes | The policy is unset (no intervention), or the caller chose a concrete `reasoningEffort` explicitly on the request |\n| System 1 decisions always fall back | `timeoutMs` too small, `baseUrl` unreachable, or `minConfidence` too high; check the latest decision and backend state on the Overview page. Note the timeout has **no single default**: unset means 10000 ms for `jev` and 8000 ms for `simple-jev` |\n| The in-panel guide is stale | `USER_GUIDE.md` changed without a rebuild; run `npm run build:all` |\n| A closed tool is still being called | The registry takes effect on the next load; reload the plugin and check that the key is the **suffix** (`gate`, not `reflex_gate`). `prune`/`detect_stagnation`/`status_ledger` are commands now and are refused by the validator |\n| `reflex_route` is missing from the default tool list | Expected: `route` is off by default; switch it on in the Tools page (or set `tools: { enabled: { route: true } }`) |\n| Looking for a `reflex_status_ledger` tool to read the ledger | The ledger is a command now: type `/reflex-ledger` (the stdio MCP side still has the tool of that name) |\n| The model selector still offers `reflex` after adaptive effort was switched off | That level came from a load that injected it; make sure the configuration is in effect and reload the plugin to revoke the injection |\n| Saving the configuration reports that only blank or reflex is supported | The configuration still writes a concrete level; remove it (or use `reflex`). To fix the depth, choose a concrete level in the model selector |\n| Saving Interventions grew the configuration with defaults | Expected: that group is written back whole, so the mode and every budget are saved as shown |\n\n---\n\n## 13. Version and compatibility\n\n- Version: `harness-reflex` and `dsh-harness-reflex` ship together at v0.1.0;\n- Node: `>= 18` (root package `engines`); DSH Host dependencies `@deepseek-ai/*@0.2.1-alpha.4`;\n- Host contracts are declared as `peerDependencies`, so the plugin never bundles\n  a second copy of Host modules;\n- The eight-tool stdio MCP surface has been frozen since v0.1.0; a Host-side\n  change must not silently alter its payloads;\n- The DSH plugin-side tool surface, since v0.1.0, is **five switchable\n  capabilities with four registered by default** (`route` is off by default) and\n  the ledger is the `/reflex-ledger` command — that side does not promise to\n  mirror the MCP side item by item.\n";

		},
		"index": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.BUNDLE_CONFIG_SLOT = exports.CONVERSATION_SERVICE = exports.inject = exports.SECTION_ORDER = exports.SECTION_ID = exports.SECTION_SLOT = exports.NS_CANDIDATES = exports.CLIENT_ID = exports.ComposerEffortIndicator = void 0;
			exports.registerSection = registerSection;
			exports.apply = apply;
			/**
			 * Browser half of `dsh-reflex`.
			 *
			 * This module is the entry of the prebuilt `client.js` bundle: the DSH client
			 * module system hands it a cordis context and reads back `apply` and `inject`.
			 * It contributes one `settings.section` page that visualizes and edits the
			 * Reflex runtime — the virtual provider's model pools, the adaptive reasoning
			 * effort policy, the System 1 backend connection, and the decision ledger.
			 *
			 * Two deliberate choices are worth naming:
			 *
			 * - **Only `slots` and `locale` are declared.** They are provided by the shell
			 *   itself, so the entry always activates. The settings provider is reached
			 *   through a *scoped* injection instead, because a client entry left pending on
			 *   a missing service aborts the entire web boot (the shell reports every
			 *   non-activated entry before refusing to start).
			 * - **The page exists only while its namespace is served.** Registration goes
			 *   through `configForms.whileServed`, so a deployment that never loaded the
			 *   Host half shows no trace of this page rather than an empty shell.
			 *
			 * @module dsh-reflex/client
			 */
			const locale_1 = require("./locale");
			const panel_1 = require("./panel");
			const view_1 = require("./view");
			const effort_row_1 = require("./effort-row");
			Object.defineProperty(exports, "ComposerEffortIndicator", { enumerable: true, get: function () { return effort_row_1.ComposerEffortIndicator; } });
			/**
			 * Stable settings key this entry registers under (bundle-config slot and panel
			 * namespace). Deliberately not the npm package name: the bundle's
			 * `__ModuleLoader__.load` id is derived from `package.json` instead, so a
			 * package rename never moves the user's saved settings.
			 */
			exports.CLIENT_ID = 'dsh-reflex';
			/** Settings namespace candidates, most specific first. */
			exports.NS_CANDIDATES = ['dsh-reflex', 'reflex'];
			/** Root-scoped settings slot the page registers into. */
			exports.SECTION_SLOT = 'settings.section';
			/** Slot entry id. */
			exports.SECTION_ID = 'reflex';
			/** Slot order: after the core preference sections. */
			exports.SECTION_ORDER = 55;
			/** Cordis services this entry requires. */
			exports.inject = ['slots', 'locale', 'configForms'];
			/** Shell service owning the conversation surface the effort row renders on. */
			exports.CONVERSATION_SERVICE = 'uiConversation';
			exports.BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';
			/**
			 * Register the settings page for one set of served namespaces.
			 * @param ctx - the client context that owns the registration.
			 * @param served - every settings namespace the Host serves.
			 * @param t - translator of this plugin's dictionary namespace.
			 * @returns the disposer that removes the page.
			 */
			function registerSection(ctx, served, t) {
			    const ns = (0, panel_1.resolveReflexNamespace)([...served], exports.NS_CANDIDATES);
			    if (ns === undefined)
			        return () => { };
			    const Component = (0, view_1.createPanelComponent)(ctx, t);
			    const unbindSection = ctx.slots.inject(exports.SECTION_SLOT, () => ctx.slots.register({
			        name: exports.SECTION_SLOT,
			        id: exports.SECTION_ID,
			        order: exports.SECTION_ORDER,
			        label: () => t('nav'),
			        locale: locale_1.NS,
			        inject: () => ({ ns })
			    }, Component));
			    // Also register into plugins.bundle.config (Plugins Page -> dsh-reflex details)
			    const unbindBundleConfig = ctx.slots.inject(exports.BUNDLE_CONFIG_SLOT, () => ctx.slots.register({
			        name: exports.BUNDLE_CONFIG_SLOT,
			        key: exports.CLIENT_ID
			    }, (props) => (props?.view === 'summary' ? null : Component({ ns }))));
			    return () => {
			        unbindSection();
			        unbindBundleConfig();
			    };
			}
			/**
			 * Activate the browser half.
			 * @param ctx - the client context.
			 */
			function apply(ctx) {
			    const t = ctx.locale.bind(locale_1.NS);
			    ctx.effect(() => ctx.locale.register(locale_1.NS, { zh: locale_1.zh, en: locale_1.en }), 'reflex panel locale');
			    // Register unconditionally into settings.section and plugins.bundle.config!
			    // This matches dsh-antigravity and dsh-graph so the UI entry is ALWAYS visible.
			    ctx.slots.inject(exports.SECTION_SLOT, () => ctx.slots.register({
			        name: exports.SECTION_SLOT,
			        id: exports.SECTION_ID,
			        order: exports.SECTION_ORDER,
			        label: () => t('nav'),
			        locale: locale_1.NS,
			        inject: () => ({ ns: 'dsh-reflex' })
			    }, (0, view_1.createPanelComponent)(ctx, t)));
			    ctx.slots.inject(exports.BUNDLE_CONFIG_SLOT, () => ctx.slots.register({
			        name: exports.BUNDLE_CONFIG_SLOT,
			        key: exports.CLIENT_ID
			    }, (props) => (props?.view === 'summary' ? null : (0, view_1.createPanelComponent)(ctx, t)({ ns: 'dsh-reflex' }))));
			    // The effort row rides an *optional* lookup, never a declared dependency: a
			    // client entry parked on a service that never arrives aborts the whole web
			    // boot, and this plugin must stay usable in a shell without a conversation
			    // view. `slots.inject` fires when the conversation surface declares the node
			    // slot, which is also when its service is reachable — so the row attaches
			    // exactly then, and detaches with the slot.
			    ctx.slots.inject(effort_row_1.EFFORT_ROW_SLOT, () => {
			        const conversation = ctx.get?.(exports.CONVERSATION_SERVICE);
			        if (conversation === undefined)
			            return () => { };
			        return (0, effort_row_1.registerEffortRow)(conversation, (options, component) => ctx.slots.register(options, component), locale_1.NS);
			    });
			}

		},
		"locale": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.en = exports.zh = exports.NS = void 0;
			/**
			 * Bilingual copy of the Reflex settings page.
			 *
			 * The page is registered with `locale: NS` and a `label: () => t('nav')`, so the
			 * settings shell renders the navigation entry in the user's own language; every
			 * string the page itself draws comes from here through the same `t`.
			 *
			 * @module dsh-reflex/client/locale
			 */
			const guide_generated_1 = require("./guide.generated");
			/** Dictionary namespace owned by the browser half of this plugin. */
			exports.NS = 'dsh-reflex.panel';
			/** Chinese copy. */
			exports.zh = {
			    nav: 'Reflex 决策运行时',
			    title: 'Reflex · System One 决策运行时',
			    subtitle: '虚拟模型池、自适应推理强度、System 1 后端与决策账本',
			    systemOneDegraded: 'System One 后端不可用（{reason}），决策已降级为本地压缩与确定性兜底；恢复后本提示自动消失。',
			    systemOneDegradedUnknown: '未知原因',
			    tabOverview: '概览',
			    tabRouting: '虚拟 Provider',
			    tabEffort: '推理强度',
			    tabBackend: 'System 1 后端',
			    tabInterventions: '自动干预',
			    tabTools: '工具开关',
			    tabLedger: '决策账本',
			    tabGuide: '使用说明',
			    stateLoading: '正在读取 Host 配置…',
			    stateUnavailable: '当前 Host 未注册 reflex 配置命名空间，页面只显示只读状态。',
			    stateError: '读取失败',
			    stateNotServed: '未找到 reflex 命名空间（请确认 Host 半已加载并注册了配置项）。',
			    readOnly: 'Host 配置文档为只读，写操作已禁用。',
			    groupRouting: '虚拟 Provider 与模型池',
			    groupEffort: '自适应推理强度',
			    groupBackend: '决策后端连接',
			    groupRuntime: '运行时',
			    groupInterventions: '自动干预（三态与预算）',
			    groupTools: '工具单项开关',
			    groupDelegation: '子代理委派（宿主能力）',
			    delegationIntro: '`reflex_delegate` 不是本插件自给自足的工具：它把任务交给宿主的 `subagent` 工具，并把 System One 判定的思考档位一起传过去。宿主只有在 `tool-subagent` 的 `modelSelection` 开启时才会发布 `reasoning_effort` 参数，所以这个开关默认关闭——不是忘了开，而是它需要先动一个不属于本插件的文件。',
			    // Deliberately without the exact token `reflex_delegate`: the tools page labels
			    // its switches by registered name, and two fields whose labels both contain
			    // that name would be ambiguous to anyone (and to the page test) looking a
			    // switch up by label.
			    labelDelegationEnabled: '启用子代理委派（宿主能力开关）',
			    helpDelegationEnabled: '用途：允许 reflex_delegate 注册，并同意把宿主的 modelSelection 开关写进 profile patch；格式：布尔开关；默认：关闭；范围：勾选＝明确同意开启宿主 modelSelection（否则思考档位传不进子代理），取消勾选＝停止委派，运行时不会自动帮你改回来。',
			    delegationConsent: '勾选即明确同意：本插件会把 `tool-subagent` 的 `modelSelection: true` 写入宿主的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）。只新增这一项，你原有的 patch 内容（模型、密钥、注释、`!!js` 表达式）逐字节保留，写入前会先备份一份 `.bak-dsh-reflex-*`。',
			    delegationRowState: '宿主当前状态',
			    delegationRowPatch: '宿主的 patch 文件',
			    delegationRowPatchState: 'patch 中是否已要求开启',
			    delegationRowRegistered: 'reflex_delegate 是否已注册',
			    delegationStateReady: '已开启，档位可以传进子代理',
			    delegationStateOff: '未开启：宿主委派工具没有 reasoning_effort 参数',
			    delegationStateNoTool: '当前宿主没有委派工具，无从包装',
			    // Distinct from `effectiveUnknown` on purpose: both mean "not read yet", but
			    // they sit on different cards, and a sentence shared by two cards cannot be
			    // used to assert that *this* card read its fact.
			    delegationStateUnknown: '尚未探测：读不到 agent 作用域，不能据此判断开或关',
			    delegationPatchUnknown: '未解析到 profile patch 路径',
			    delegationPatchOn: '已要求开启',
			    delegationPatchOff: '尚未要求开启',
			    delegationOn: '已注册',
			    delegationOff: '未注册',
			    delegationRestartRequired: '已保存，重启 DSH 后生效：宿主的 `tool-subagent` 配置是启动时读取的，热更新只对本插件自己的 fiber 有效。在你重启之前，reflex_delegate 会保持未注册。文件：',
			    delegationSavedRestart: '已保存，重启 DSH 后生效。',
			    delegationSavedNoRestart: 'patch 已是所需状态，无需再写入。',
			    delegationWriteRefused: '同意已记录，但宿主 patch 未写入成功：',
			    delegationRevokeHint: '想撤销：取消勾选这个开关即可停止委派；若要连宿主开关一起去掉，删掉 patch 里 `tool-subagent` 下那行 `modelSelection: true`（或本插件新增的那一整条）。本插件不会替你改回来。',
			    labelEnabled: '启用虚拟 Provider',
			    labelVirtualProvider: '虚拟 Provider 名称',
			    labelFallback: '兜底目标（provider:model）',
			    labelMaxTaskChars: '任务文本预算（字符）',
			    labelPools: '模型池',
			    poolEmpty: '尚未配置任何虚拟模型。',
			    poolModelId: '虚拟模型 ID',
			    poolEntryProvider: '物理 Provider',
			    poolEntryModel: '物理模型',
			    poolEntryDescription: '能力说明',
			    poolEntryTags: '标签（逗号分隔）',
			    poolAddModel: '新增虚拟模型',
			    poolAddEntry: '新增候选',
			    poolRemoveModel: '删除该模型',
			    poolRemoveEntry: '删除候选',
			    poolMoveUp: '上移',
			    poolMoveDown: '下移',
			    poolCandidates: '候选',
			    labelEffortSetting: '推理强度策略',
			    labelEffortFallback: '兜底档位',
			    labelEffortMinConfidence: '最小置信度',
			    labelEffortEnabled: '启用自适应推理强度',
			    effortDisabledHint: '关闭后不做自适应判定，也不注入 reflex 档位；调用方显式选择的具体档位原样下发。',
			    effortUnset: '不干预',
			    effortAdaptive: 'Reflex（自适应）',
			    effortHint: '留空＝不干预；选择 Reflex＝每轮自适应。',
			    effortLatest: '最近一次自适应决策',
			    effortNoDecision: '本次激活尚未产生自适应决策。',
			    effortDecisions: '自适应决策数',
			    interventionsHint: 'off 完全不介入，observe 只检测并记录，active 才真正执行干预；能力项可选「继承主模式」。默认 observe。',
			    labelInterventionMode: '主模式',
			    interventionModeHint: '默认 observe：先观察记录，确认无误后再切到 active。',
			    labelCapabilityStagnation: '停滞豁免',
			    labelCapabilityPrune: '结果裁剪',
			    labelCapabilityGate: '失败门禁',
			    labelCapabilityClosing: '收尾异议',
			    labelMaxInterventionsPerTurn: '每轮最大干预数',
			    labelMaxJudgmentsPerTurn: '每轮最大判定数',
			    labelMaxJudgmentsPerSession: '每会话最大判定数',
			    labelRepeatThreshold: '重复阈值',
			    labelFailureThreshold: '失败阈值',
			    labelWindowSize: '窗口大小',
			    labelInterventionMinConfidence: '最小置信度',
			    labelPruneFloorRatio: '裁剪保留下限比例',
			    labelPruneHeadChars: '裁剪保留头部字符数',
			    labelPruneTailChars: '裁剪保留尾部字符数',
			    labelPruneIntent: '裁剪判定意图',
			    labelPruneJudgeMinChars: '逐段判定最小字符数',
			    labelClaimMinConfidence: '完成声明置信度门槛',
			    labelClosingEvidenceChars: '收尾证据字符预算',
			    // (?) 就地提示：每条都写成「用途 / 格式 / 默认 / 留空或范围」四段，
			    // field-guidance 测试会按段解析，并用 resolveConfig 实算的默认值对拍。
			    helpAbout: '关于「{field}」的说明',
			    helpSwitchOn: '开启',
			    helpSwitchOff: '关闭',
			    helpRoutingEnabled: '用途：决定是否安装 reflex 虚拟 Provider 接管模型路由；格式：布尔开关；默认：开启；留空：未写时按开启处理，关闭后模型调用直连物理 Provider。',
			    helpVirtualProvider: '用途：虚拟 Provider 对外暴露的名字，模型池路由挂在它名下；格式：非空字符串，不能包含冒号；默认：reflex；范围：留空取默认，为空或含冒号会被配置校验拒绝。',
			    helpFallback: '用途：所有候选池都无法回答时使用的物理兜底目标；格式：provider:model，例如 deepseek-official:deepseek-flash；默认：未设置；留空：不启用兜底、路由失败即失败关闭，且不能指回虚拟 Provider 自身。',
			    helpMaxTaskChars: '用途：交给 System One 判定的任务文本长度上限；格式：正整数（字符数）；默认：400；范围：必须大于 0，超长文本会先截断再判定。',
			    helpEffortEnabled: '用途：是否允许按轮自适应决定推理强度；格式：布尔开关；默认：开启；留空：未写时按开启处理，关闭后本层不生效，调用方显式选择的具体档位仍原样下发。',
			    helpEffortSetting: '用途：决定是否启用自适应推理强度；格式：留空或 Reflex（自适应）；默认：不干预；留空：插件完全不改写 reasoningEffort，行为与未安装该功能一致，模型选择器里由插件注入的「Reflex (Auto)」档位仍可主动选中；选择 Reflex：每轮按 System 1 判定并下发；范围：想固定思考深度请在模型选择器里选择具体档位，可选项取决于目标模型声明的档位集合（例如 minimal、max 仅在模型声明后可选）。',
			    helpEffortFallback: '用途：System One 与线索分类器都没有证据时使用的兜底档位；格式：一个自适应档位；默认：medium；范围：必须是已提供的自适应档位之一，留空按默认处理。',
			    helpEffortMinConfidence: '用途：System One 的置信度达到多少才压过线索分类器；格式：小数；默认：0.3；范围：0~1，越界会被拒绝。',
			    helpBackend: '用途：选择决策后端实现；格式：auto / mock / jev / vllm 之一；默认：auto；留空：按 auto 处理，由环境自动挑选可用后端。',
			    helpBaseUrl: '用途：System One 网关或 OpenAI 兼容 logits 端点的地址；格式：http(s) URL；默认：未设置；留空：使用环境变量或后端内置默认地址（jev 为 https://api.typesafe.ai/v1/systemone，simple-jev 为 http://localhost:8000）。',
			    helpModel: '用途：后端请求使用的模型 ID；格式：非空字符串；默认：未设置；留空：使用环境变量或后端内置默认模型（jev 为 jev-latest，simple-jev 为 Qwen/Qwen2.5-7B-Instruct）。',
			    helpApiKeyEnv: '用途：存放 API Key 的环境变量名（不是密钥本身）；格式：大写环境变量名，例如 JEV_API_KEY；默认：未设置；留空：由后端按 SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY 依次兜底，密钥永远不会写进设置文档。',
			    helpTimeoutMs: '用途：单次后端请求的超时时间；格式：毫秒整数；默认：未设置；留空：使用后端默认超时（jev 10000 ms、simple-jev 8000 ms），小于 100 会被拒绝。',
			    helpToolPrefix: '用途：所有 reflex_* 工具注册名的前缀；格式：小写字母、数字与下划线；默认：reflex_；留空：按默认前缀注册，空字符串会被拒绝。',
			    helpPruneThreshold: '用途：单个工具结果超过多少字符才触发裁剪；格式：非负整数（字符数）；默认：500；范围：小于 0 会被拒绝，0 表示不设阈值。',
			    helpLedgerPath: '用途：决策账本 JSONL 的落盘路径；格式：相对或绝对路径；默认：未设置；留空：只保留在内存，进程退出即丢失。',
			    helpCalibrationPath: '用途：应用到 choice 置信度上的离线校准曲线文件；格式：相对或绝对 JSON 路径；默认：未设置；留空：不做离线校准，直接使用原始置信度。',
			    helpInterventionMode: '用途：自动干预的总开关语义；格式：off / observe / active 之一；默认：observe；留空：按 observe 处理，只检测并记录、不真正干预。',
			    helpMaxInterventionsPerTurn: '用途：每轮最多执行多少次干预；格式：非负整数；默认：3；留空：按默认处理，0 表示本轮不执行干预。',
			    helpMaxJudgmentsPerTurn: '用途：每轮最多做多少次 System One 判定；格式：非负整数；默认：3；留空：按默认处理。',
			    helpMaxJudgmentsPerSession: '用途：整个会话最多做多少次 System One 判定；格式：非负整数；默认：20；留空：按默认处理。',
			    helpRepeatThreshold: '用途：同一工具调用重复多少次才判定为停滞；格式：整数；默认：3；范围：最小 2，小于 2 会被拒绝。',
			    helpFailureThreshold: '用途：连续失败多少次才触发失败门禁；格式：整数；默认：3；范围：最小 2，小于 2 会被拒绝。',
			    helpInterventionMinConfidence: '用途：干预判定需要的最低置信度；格式：小数；默认：0.6；范围：0~1，越界会被拒绝（注意与推理强度组的 0.3 不同）。',
			    helpWindowSize: '用途：判定重复/停滞时回看的历史窗口大小；格式：整数；默认：6；范围：最小 3，小于 3 会被拒绝。',
			    helpPruneFloorRatio: '用途：裁剪后至少要保留原结果的比例；格式：0~1 的小数；默认：0.5；范围：越界会被拒绝。',
			    helpPruneHeadChars: '用途：裁剪时固定保留的结果头部字符数；格式：非负整数；默认：400；留空：按默认处理，0 表示不保留头部。',
			    helpPruneTailChars: '用途：裁剪时固定保留的结果尾部字符数；格式：非负整数；默认：400；留空：按默认处理，0 表示不保留尾部。',
			    helpPruneIntent: '用途：交给裁剪判定判断哪些内容值得保留的意图描述；格式：自然语言短句；默认：extract diagnostics, relevant results and errors；留空：按默认意图处理。',
			    helpPruneJudgeMinChars: '用途：工具结果达到多少字符才启用逐段 System One 判定；格式：整数（字符数）；默认：10000；范围：不得小于 pruneThreshold，倒挂会被配置校验拒绝。',
			    helpClaimMinConfidence: '用途：完成声明语义判定的置信度门槛，低于它的句子不会进入收尾验证；格式：0~1 的小数；默认：0.5；范围：0~1，留空则按 Host 默认 0.5。',
			    helpClosingEvidenceChars: '用途：交给收尾判定的证据总字符预算，超出按「诊断行 > 尾摘要 > 其余」优先级截断并记录 truncatedChars；格式：整数（字符数）；默认：2400；范围：最小 200，留空则按 Host 默认。',
			    helpCapability: '用途：控制「{name}」这一路自动干预是否执行；格式：off / observe / active / inherit；默认：inherit；范围：留空即继承主模式（当前 {mode}），显式三态会覆盖主模式。',
			    helpToolSwitch: '用途：{what}；格式：布尔开关（开启/关闭）；默认：{default}；留空：未写时按默认处理，关闭即从工具注册表下线，模型看不到该工具。',
			    interventionsEffective: '当前生效（只读）',
			    effectiveActing: '执行状态',
			    effectiveUnknown: '尚未读取到运行时状态。',
			    modeOff: '关闭（off）',
			    modeObserve: '观察（observe）',
			    modeActive: '执行（active）',
			    modeInherit: '继承主模式',
			    toolsHint: '按工具后缀开关（choice、score、route…）：关闭即从工具注册表下线，模型看不到该工具；开关与工具名前缀无关，改前缀不影响。默认开启 choice、score、screen、gate 四项，route 默认关闭，需要时再打开。',
			    toolsEffective: '当前已注册（只读）',
			    toolsAllClosed: '本插件当前未注册任何工具。',
			    toolsApplyRecommended: '应用推荐组合',
			    toolsRecommendedHint: '按下述建议填好 5 项：choice、score、screen、gate 开启，route 关闭（即默认组合）。这只是预填，仍需点“保存”才写回；与默认一致时不产生写入。',
			    toolAdviceExpose: '建议暴露',
			    toolAdviceOptional: '按需开启',
			    toolsLedgerHint: '账本（调用数、时延、节省 token、门禁与停滞告警）不占用工具位：直接用 /reflex-ledger 命令，或看本面板的“账本”页。',
			    toolWhat_choice: '在若干候选之间做一次快速概率选择，直接返回概率分布，不消耗生成 token。',
			    toolWhen_choice: '需要在多个方案、分类或是否二选一里挑一个，又不想花生成 token 推理时（选架构、选分类、选 yes/no）。',
			    toolWhat_score: '按给定标准给一段文本或代码打 0–1 的连续分。',
			    toolWhen_score: '需要连续评分（质量、对齐度、置信度）而不是二选一时。',
			    toolWhat_route: '按目标给候选工具、技能或方案做概率排序。',
			    toolWhen_route: '候选很多、需要先缩小范围再动手时；属可选增强，默认关闭，需要时手动打开，不影响主流程。',
			    toolWhat_screen: '检测不可信内容里的提示注入与指令覆盖。',
			    toolWhen_screen: '读到网页、外部 PR 评论、第三方日志等不可信输入之后，先筛一遍再当作数据处理。',
			    toolWhat_gate: '用真实输出与证据逐条核对断言，给出通过、矛盾或需升级的判定。',
			    toolWhen_gate: '准备宣布完成或关闭任务之前，逐条核对验收判据与真实输出。',
			    toolWhat_delegate: '把任务派给子代理，并由 System One 判定它该用多深的思考；权限、预设与递归限制仍由宿主的委派工具执行。',
			    toolWhen_delegate: '要把一段自成一体的工作交给子代理、而合适思考档位并不明显时。它刻意没有思考档位参数，想精确指定请直接调用宿主的委派工具；本工具仅在宿主委派工具声明了 reasoning_effort（modelSelection 已开启）时才会注册。',
			    labelBackend: '后端实现',
			    labelBaseUrl: 'Base URL',
			    labelModel: '模型 ID',
			    labelApiKeyEnv: 'API Key 环境变量名',
			    labelTimeoutMs: '超时（毫秒）',
			    backendHint: 'API Key 只以环境变量名记录，密钥本身不进入设置文档。',
			    backendActive: '当前生效实现',
			    apiKeyPresent: '环境变量已就绪',
			    apiKeyMissing: '环境变量为空',
			    labelToolPrefix: '工具名前缀',
			    labelLedgerPath: '账本 JSONL 路径',
			    labelPruneThreshold: '裁剪阈值（字符）',
			    labelCalibrationPath: '校准曲线路径',
			    unset: '未设置',
			    ledgerTotal: '决策总数',
			    ledgerTokens: '节省 token',
			    ledgerCost: '估算节省成本',
			    ledgerLatency: '平均时延',
			    ledgerGates: '门禁通过 / 失败',
			    ledgerStagnation: '停滞告警',
			    ledgerRouting: '路由决策',
			    ledgerRecent: '最近决策',
			    ledgerEmpty: '账本为空。',
			    ledgerLogPath: '落盘路径',
			    ledgerMemoryOnly: '仅内存（未配置 JSONL 路径）',
			    ledgerClear: '清空账本',
			    ledgerClearConfirm: '再次点击确认清空（会删除落盘的 JSONL 文件）',
			    ledgerCleared: '已清空 {count} 条记录',
			    colTime: '时间',
			    colType: '类型',
			    colBackend: '后端',
			    colLatency: '时延',
			    colTokens: '节省 token',
			    colDetail: '详情',
			    typeGate: '门禁',
			    typePrune: '裁剪',
			    typeStagnation: '停滞',
			    typeRoute: '路由',
			    typeChoice: '选择',
			    typeModelRoute: '模型路由',
			    typeEffort: '强度决策',
			    save: '保存',
			    saving: '保存中…',
			    saved: '已保存',
			    reset: '重置',
			    refresh: '刷新',
			    dirty: '有未保存的修改',
			    clean: '已与 Host 一致',
			    confirmRejected: 'Host 拒绝了本次写入',
			    refreshFailed: '刷新失败',
			    errVirtualProvider: '虚拟 Provider 名称不能为空',
			    errMaxTaskChars: '任务文本预算必须是正整数',
			    errPoolModel: '虚拟模型 ID 不能为空',
			    errPoolDuplicate: '虚拟模型 ID 重复',
			    errPoolProvider: '候选的物理 Provider 不能为空',
			    errPoolModelName: '候选的物理模型不能为空',
			    errPoolEmpty: '启用路由时至少要有一个含候选的模型池',
			    errMinConfidence: '最小置信度必须是 0 到 1 之间的数字',
			    errEffortSetting: '推理强度策略不在可选范围内',
			    errBackend: '后端实现不在可选范围内',
			    errTimeout: '超时必须是不小于 100 的整数',
			    errToolPrefix: '工具名前缀不能为空',
			    errPruneThreshold: '裁剪阈值必须是非负整数',
			    errFallback: '兜底目标必须写成 provider:model',
			    errInterventionMode: '干预主模式必须是 off / observe / active',
			    errInterventionCapability: '能力项必须是 off / observe / active / inherit',
			    errInterventionBudget: '预算与阈值必须是不小于各自下限的整数',
			    errInterventionRatio: '该比例必须是 0 到 1 之间的数字',
			    errPruneJudgeMinChars: '逐段判定最小字符数必须是不小于裁剪阈值的整数',
			    errClaimMinConfidence: '完成声明置信度门槛必须是 0 到 1 之间的数字',
			    errClosingEvidenceChars: '收尾证据字符预算必须是不小于 200 的整数',
			    toneActive: '激活',
			    toneInactive: '未激活',
			    toneEnabled: '已启用',
			    toneDisabled: '已停用',
			    chipRoutingActive: '路由 · 已启用（{candidates} 候选）',
			    chipRoutingInactive: '路由 · 未启用',
			    chipRoutingTitleActive: '虚拟 Provider 路由已启用：请求会按模型池路由到候选物理模型，当前共 {candidates} 个候选。可在「虚拟 Provider」页调整启用状态、候选池或兜底目标。',
			    chipRoutingTitleInactive: '虚拟 Provider 路由未启用（routing.enabled=false 或候选池为空）：请求直接使用所选物理模型。请在「虚拟 Provider」页启用路由并配置候选池。',
			    chipEffortSet: '推理强度 · {level}',
			    chipEffortUnset: '推理强度 · 未设置',
			    chipEffortTitleSet: '已选择推理强度：每轮按 {level} 执行并随请求下发。可在模型选择器里改选其他档位，或在「推理强度」页选择 Reflex 自适应。',
			    chipEffortTitleUnset: '无推理强度选择：插件不干预，使用模型默认档位。请在模型选择器里选择具体档位，或在「推理强度」页选择 Reflex 自适应。',
			    chipBackend: '后端 · {backend}',
			    chipBackendTitle: 'System One 决策后端当前为 {backend}；API Key 环境变量 {env} 已就绪（apiKeyEnv: set）。可在「System 1 后端」页更换实现或调整连接。',
			    chipBackendTitleMissing: 'System One 决策后端当前为 {backend}；缺少 {env} 环境变量（apiKeyEnv: empty），决策会降级到本地兜底。请在「System 1 后端」页配置该环境变量或更换后端。',
			    chipBackendTitleUnsetKey: 'System One 决策后端当前为 {backend}；未声明 API Key 环境变量，插件会使用环境默认密钥或降级到本地兜底。可在「System 1 后端」页配置连接。',
			    statusLabel: 'Reflex 运行状态：{routing}；{effort}；{backend}。悬停或聚焦查看完整说明。',
			    statusRoutingActive: '路由已启用（{candidates} 候选）',
			    statusRoutingInactive: '路由未启用',
			    statusEffortSet: '推理强度 {level}',
			    statusEffortUnset: '推理强度未设置',
			    statusBackendOk: '后端 {backend} 正常',
			    statusBackendMissingKey: '后端 {backend} 缺少 API Key，将降级',
			    statusBackendDegraded: '后端 {backend} 不可用，已降级',
			    // In-panel user guide: the body is the repository document itself, embedded
			    // at build time by `scripts/embed-user-guide.mjs`.
			    guideTitle: 'Harness Reflex 使用说明',
			    guideIntro: '本页内嵌仓库中的 USER_GUIDE.md：安装与构建、System 1 后端接入、虚拟 Provider 模型池、自适应推理强度（reflex / auto）、设置面板用法，以及 MCP 工具与 DSH 原生工具对照。',
			    guideHint: '文档语言跟随 DSH 界面语言切换（中文 / English）。修改 USER_GUIDE.md 后需重新执行 npm run build:all，否则本页仍是上一版。',
			    guideProvenance: '文档来源 {source} · 摘要 {digest}',
			    guideSource: guide_generated_1.GUIDE_SOURCES.zh,
			    guideRevision: guide_generated_1.GUIDE_DIGESTS.zh.slice(0, 12),
			    guideBody: guide_generated_1.GUIDE_ZH,
			    rowTitle: 'Reflex 推理强度',
			    rowDetails: '详情',
			    rowStep: '步骤',
			    rowThinking: '推理强度',
			    rowSource: '来源',
			    rowConfidence: '置信度',
			    rowLatency: '耗时',
			    rowRoute: '路由',
			    rowRouteUnknown: '未知模型',
			    rowSwitched: '已切换',
			    rowSteps: '{count} 步',
			    rowSupported: '目标档位',
			    rowEvidence: '证据',
			    rowDegraded: '降级原因',
			    rowNone: '无',
			    rowClearedShort: '未下发',
			    rowHeldForCache: '保持模型以保活缓存',
			    rowRouteStrategy: '路由策略',
			    rowHeldForCacheDetail: '为避免 Prompt Cache 失效而保持当前模型 (Cache Affinity)',
			    composerActual: '实际',
			    composerHeldForCache: '缓存保活'
			};
			/** English copy; the key set must match {@link zh} exactly. */
			exports.en = {
			    nav: 'Reflex runtime',
			    title: 'Reflex · System One decision runtime',
			    subtitle: 'Virtual model pools, adaptive reasoning effort, System 1 backend, decision ledger',
			    systemOneDegraded: 'The System One backend is unavailable ({reason}); decisions have degraded to local template compression and deterministic fallbacks. This notice disappears automatically when the backend recovers.',
			    systemOneDegradedUnknown: 'unknown error',
			    tabOverview: 'Overview',
			    tabRouting: 'Virtual provider',
			    tabEffort: 'Reasoning effort',
			    tabBackend: 'System 1 backend',
			    tabInterventions: 'Interventions',
			    tabTools: 'Tools',
			    tabLedger: 'Decision ledger',
			    tabGuide: 'Guide',
			    stateLoading: 'Reading Host configuration…',
			    stateUnavailable: 'This Host registers no reflex configuration namespace; the page stays read-only.',
			    stateError: 'Read failed',
			    stateNotServed: 'No reflex namespace found — check that the Host half is loaded and registered its configuration.',
			    readOnly: 'The Host settings document is read-only; writes are disabled.',
			    groupRouting: 'Virtual provider and model pools',
			    groupEffort: 'Adaptive reasoning effort',
			    groupBackend: 'Backend connection',
			    groupRuntime: 'Runtime',
			    groupInterventions: 'Automatic interventions (three-state and budgets)',
			    groupTools: 'Per-tool switches',
			    groupDelegation: 'Subagent delegation (host capability)',
			    delegationIntro: '`reflex_delegate` is not self-contained: it hands the task to the host `subagent` tool together with the reasoning level System One decided. The host publishes a `reasoning_effort` argument only when `tool-subagent` has `modelSelection` on, so this switch starts off — not because it was forgotten, but because it needs a file outside this plugin.',
			    // See the Chinese copy: no exact `reflex_delegate` token, so the tool switch
			    // labelled by its registered name stays unambiguous.
			    labelDelegationEnabled: 'Enable subagent delegation (host capability switch)',
			    helpDelegationEnabled: 'Use: allow reflex_delegate to register, and agree to write the host modelSelection switch into the profile patch; Format: boolean switch; Default: off; Range: ticking it is explicit consent to turn host modelSelection on (otherwise no level can reach the child); unticking stops delegation, and the runtime never turns it back on by itself.',
			    delegationConsent: 'Ticking this is explicit consent: the plugin writes `tool-subagent` `modelSelection: true` into the host profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Only that one field is added — your existing patch content (models, keys, comments, `!!js` expressions) is preserved byte for byte, and a `.bak-dsh-reflex-*` backup is written first.',
			    delegationRowState: 'Host state',
			    delegationRowPatch: 'Host patch file',
			    delegationRowPatchState: 'Patch asks for it',
			    delegationRowRegistered: 'reflex_delegate registered',
			    delegationStateReady: 'On — a decided level reaches the child',
			    delegationStateOff: 'Off — the host delegation tool has no reasoning_effort argument',
			    delegationStateNoTool: 'This host exposes no delegation tool to wrap',
			    delegationStateUnknown: 'Not probed — no agent scope was readable, so neither on nor off is claimed',
			    delegationPatchUnknown: 'Profile patch path not resolved',
			    delegationPatchOn: 'Asked for',
			    delegationPatchOff: 'Not asked for',
			    delegationOn: 'Registered',
			    delegationOff: 'Not registered',
			    delegationRestartRequired: 'Saved — takes effect after you restart DSH: the host reads `tool-subagent` configuration at start-up, and hot updates only reach this plugin\'s own fiber. Until then reflex_delegate stays unregistered. File:',
			    delegationSavedRestart: 'Saved — takes effect after you restart DSH.',
			    delegationSavedNoRestart: 'The patch already has what it needs; nothing was written.',
			    delegationWriteRefused: 'Consent recorded, but the host patch was not written:',
			    delegationRevokeHint: 'To undo: untick this switch to stop delegating; to remove the host switch too, delete the `modelSelection: true` line under `tool-subagent` (or the whole row this plugin added). The plugin will not set it back for you.',
			    labelEnabled: 'Install the virtual provider',
			    labelVirtualProvider: 'Virtual provider name',
			    labelFallback: 'Fallback target (provider:model)',
			    labelMaxTaskChars: 'Task-text budget (characters)',
			    labelPools: 'Model pools',
			    poolEmpty: 'No virtual model is configured yet.',
			    poolModelId: 'Virtual model id',
			    poolEntryProvider: 'Physical provider',
			    poolEntryModel: 'Physical model',
			    poolEntryDescription: 'Capability note',
			    poolEntryTags: 'Tags (comma separated)',
			    poolAddModel: 'Add virtual model',
			    poolAddEntry: 'Add candidate',
			    poolRemoveModel: 'Remove model',
			    poolRemoveEntry: 'Remove candidate',
			    poolMoveUp: 'Move up',
			    poolMoveDown: 'Move down',
			    poolCandidates: 'candidates',
			    labelEffortSetting: 'Effort policy',
			    labelEffortFallback: 'Fallback level',
			    labelEffortMinConfidence: 'Minimum confidence',
			    labelEffortEnabled: 'Enable adaptive reasoning effort',
			    effortDisabledHint: 'Off stops every adaptive decision and withdraws the injected reflex level; a concrete level the caller chose explicitly is still dispatched as written.',
			    effortUnset: 'Leave untouched',
			    effortAdaptive: 'Reflex (adaptive)',
			    effortHint: 'Blank = leave untouched; Reflex = adaptive every turn.',
			    effortLatest: 'Latest adaptive decision',
			    effortNoDecision: 'No adaptive decision yet in this activation.',
			    effortDecisions: 'Adaptive decisions',
			    interventionsHint: 'off stays out entirely, observe only detects and records, active actually performs the intervention; a capability may inherit the master mode. Default observe.',
			    labelInterventionMode: 'Master mode',
			    interventionModeHint: 'Default observe: watch and record first, switch to active once the record looks right.',
			    labelCapabilityStagnation: 'Stagnation exemption',
			    labelCapabilityPrune: 'Result pruning',
			    labelCapabilityGate: 'Failure gate',
			    labelCapabilityClosing: 'Turn-stop objection',
			    labelMaxInterventionsPerTurn: 'Interventions per turn',
			    labelMaxJudgmentsPerTurn: 'Judgments per turn',
			    labelMaxJudgmentsPerSession: 'Judgments per session',
			    labelRepeatThreshold: 'Repeat threshold',
			    labelFailureThreshold: 'Failure threshold',
			    labelWindowSize: 'Window size',
			    labelInterventionMinConfidence: 'Minimum confidence',
			    labelPruneFloorRatio: 'Prune floor ratio',
			    labelPruneHeadChars: 'Prune head characters',
			    labelPruneTailChars: 'Prune tail characters',
			    labelPruneIntent: 'Prune judgment intent',
			    labelPruneJudgeMinChars: 'Per-segment judge minimum characters',
			    labelClaimMinConfidence: 'Completion-claim confidence floor',
			    labelClosingEvidenceChars: 'Closing evidence character budget',
			    // (?) guidance: each entry spells out use / format / default / blank-or-range.
			    // The field-guidance test parses those segments and cross-checks the defaults
			    // against resolveConfig instead of trusting this copy.
			    helpAbout: 'About {field}',
			    helpSwitchOn: 'on',
			    helpSwitchOff: 'off',
			    helpRoutingEnabled: 'Use: whether the reflex virtual provider is installed to take over model routing; Format: boolean switch; Default: on; Blank: treated as on when omitted, and off sends calls straight to the physical provider.',
			    helpVirtualProvider: 'Use: the public name of the virtual provider that owns the model pools; Format: non-empty string without a colon; Default: reflex; Range: blank means the default, while an empty or colon-containing value is rejected by config validation.',
			    helpFallback: 'Use: the physical target used when no candidate pool can answer; Format: provider:model, e.g. deepseek-official:deepseek-flash; Default: not set; Blank: no fallback and routing fails closed, and it must not point back at the virtual provider.',
			    helpMaxTaskChars: 'Use: the character budget of the task text handed to System One; Format: positive integer (characters); Default: 400; Range: must be greater than 0, and longer text is truncated before the decision.',
			    helpEffortEnabled: 'Use: whether each turn may adapt its reasoning effort; Format: boolean switch; Default: on; Blank: treated as on when omitted, and off leaves this layer inactive while a concrete level the caller chose explicitly still passes through.',
			    helpEffortSetting: 'Use: whether adaptive reasoning effort runs; Format: blank, or Reflex (adaptive); Default: leave untouched; Blank: the plugin never rewrites reasoningEffort and the request behaves exactly as if this feature were not installed, while the "Reflex (Auto)" level injected into the model selector can still be chosen; choosing Reflex decides every turn through System 1; Range: to fix the thinking depth, choose a concrete level in the model selector, and the offered levels follow the target model\'s declared set (minimal or max are offered only when the model declares them).',
			    helpEffortFallback: 'Use: the level used when System One and the cue classifier both lack evidence; Format: one adaptive level; Default: medium; Range: must be an offered adaptive level, and blank means the default.',
			    helpEffortMinConfidence: 'Use: the System One confidence needed to override the cue classifier; Format: decimal; Default: 0.3; Range: 0 to 1, and out-of-range values are rejected.',
			    helpBackend: 'Use: choose the decision backend implementation; Format: one of auto / mock / jev / vllm; Default: auto; Blank: treated as auto, which picks an available backend from the environment.',
			    helpBaseUrl: 'Use: the System One gateway or OpenAI-compatible logits endpoint; Format: http(s) URL; Default: not set; Blank: use the environment or the backend default address (jev: https://api.typesafe.ai/v1/systemone, simple-jev: http://localhost:8000).',
			    helpModel: 'Use: the model id the backend asks for; Format: non-empty string; Default: not set; Blank: use the environment or the backend default model (jev: jev-latest, simple-jev: Qwen/Qwen2.5-7B-Instruct).',
			    helpApiKeyEnv: 'Use: the name of the environment variable holding the API key, never the key itself; Format: an uppercase environment variable name, e.g. JEV_API_KEY; Default: not set; Blank: the backend falls back in order to SYSTEM_ONE_API_KEY → JEV_API_KEY → VLLM_API_KEY → OPENAI_API_KEY, and the secret never enters the settings document.',
			    helpTimeoutMs: 'Use: the per-request backend timeout; Format: integer milliseconds; Default: not set; Blank: use the backend default (10000 ms for jev, 8000 ms for simple-jev), and values below 100 are rejected.',
			    helpToolPrefix: 'Use: the prefix of every registered reflex_* tool name; Format: lowercase letters, digits and underscores; Default: reflex_; Blank: register with the default prefix, and an empty string is rejected.',
			    helpPruneThreshold: 'Use: the character count above which a tool result is pruned; Format: non-negative integer (characters); Default: 500; Range: negative values are rejected, and 0 disables the threshold.',
			    helpLedgerPath: 'Use: the JSONL sink for the decision ledger; Format: relative or absolute path; Default: not set; Blank: keep the ledger in memory only, lost when the process exits.',
			    helpCalibrationPath: 'Use: the offline calibration curve applied to choice confidences; Format: relative or absolute JSON path; Default: not set; Blank: no offline calibration, and raw confidences are used.',
			    helpInterventionMode: 'Use: the master semantics of automatic interventions; Format: one of off / observe / active; Default: observe; Blank: treated as observe, which detects and records only and never acts.',
			    helpMaxInterventionsPerTurn: 'Use: how many interventions may run per turn; Format: non-negative integer; Default: 3; Blank: the default, where 0 runs none this turn.',
			    helpMaxJudgmentsPerTurn: 'Use: how many System One judgments may run per turn; Format: non-negative integer; Default: 3; Blank: the default.',
			    helpMaxJudgmentsPerSession: 'Use: how many System One judgments may run per session; Format: non-negative integer; Default: 20; Blank: the default.',
			    helpRepeatThreshold: 'Use: how often the same tool call must repeat before it counts as stagnation; Format: integer; Default: 3; Range: minimum 2, and smaller values are rejected.',
			    helpFailureThreshold: 'Use: how many consecutive failures trigger the failure gate; Format: integer; Default: 3; Range: minimum 2, and smaller values are rejected.',
			    helpInterventionMinConfidence: 'Use: the minimum confidence an intervention needs; Format: decimal; Default: 0.6; Range: 0 to 1, and out-of-range values are rejected (the effort group uses 0.3).',
			    helpWindowSize: 'Use: the history window examined for repetition and stagnation; Format: integer; Default: 6; Range: minimum 3, and smaller values are rejected.',
			    helpPruneFloorRatio: 'Use: the minimum fraction of the original result kept after pruning; Format: decimal from 0 to 1; Default: 0.5; Range: out-of-range values are rejected.',
			    helpPruneHeadChars: 'Use: head characters always kept when pruning; Format: non-negative integer; Default: 400; Blank: the default, where 0 keeps no head.',
			    helpPruneTailChars: 'Use: tail characters always kept when pruning; Format: non-negative integer; Default: 400; Blank: the default, where 0 keeps no tail.',
			    helpPruneIntent: 'Use: the intent description that tells the pruning judgment what is worth keeping; Format: a short natural-language phrase; Default: extract diagnostics, relevant results and errors; Blank: the default intent.',
			    helpPruneJudgeMinChars: 'Use: the result size that enables per-segment System One judging; Format: integer (characters); Default: 10000; Range: must not be smaller than pruneThreshold, and an inverted pair is rejected by config validation.',
			    helpClaimMinConfidence: 'Use: the confidence floor for the completion-claim semantic judgment, below which a sentence is not verified; Format: decimal in 0~1; Default: 0.5; Range: 0~1, blank keeps the Host default of 0.5.',
			    helpClosingEvidenceChars: 'Use: the character budget of the evidence handed to a closing judgment, truncated by priority diagnostic lines > tail summaries > rest with the dropped amount reported; Format: integer (characters); Default: 2400; Range: at least 200, blank keeps the Host default.',
			    helpCapability: 'Use: whether the "{name}" automatic intervention may run; Format: off / observe / active / inherit; Default: inherit; Range: blank inherits the master mode ({mode}), while an explicit state overrides it.',
			    helpToolSwitch: 'Use: {what}; Format: boolean switch (on / off); Default: {default}; Blank: treated as the default when omitted, and off unregisters the tool so the model never sees it.',
			    interventionsEffective: 'Currently effective (read-only)',
			    effectiveActing: 'Acting',
			    effectiveUnknown: 'No runtime state read yet.',
			    modeOff: 'Off',
			    modeObserve: 'Observe',
			    modeActive: 'Active',
			    modeInherit: 'Inherit the master mode',
			    toolsHint: 'Switched by tool suffix (choice, score, route…): closing a tool unregisters it, so the model never sees it. Switches are keyed by suffix, not by name, so renaming the prefix changes nothing. choice, score, screen and gate are on by default; route starts off and is turned on when a deployment wants it.',
			    toolsEffective: 'Currently registered (read-only)',
			    toolsAllClosed: 'This plugin currently registers no tools.',
			    toolsApplyRecommended: 'Apply recommended set',
			    toolsRecommendedHint: 'Prefills the five switches with the advice below: choice, score, screen and gate on, route off — the documented default. Nothing is written until you press Save, and a set that already matches the default writes nothing.',
			    toolAdviceExpose: 'Suggested for the agent',
			    toolAdviceOptional: 'Turn on when needed',
			    toolsLedgerHint: 'The ledger (call counts, latency, tokens saved, gate and stagnation results) does not take a tool slot: use the /reflex-ledger command, or the Ledger page of this panel.',
			    toolWhat_choice: 'Makes one fast probabilistic choice among candidates and returns the distribution, spending no generation tokens.',
			    toolWhen_choice: 'When one option has to be picked out of several approaches, categories or a yes/no, without spending generation tokens on it.',
			    toolWhat_score: 'Rates a passage or a piece of code against given criteria on a 0–1 scale.',
			    toolWhen_score: 'When a continuous score (quality, alignment, confidence) is needed rather than a yes/no.',
			    toolWhat_route: 'Ranks candidate tools, skills or approaches against a goal.',
			    toolWhen_route: 'When there are many candidates and the range should shrink before acting; an optional extra, off by default, turned on when a deployment wants it.',
			    toolWhat_screen: 'Screens untrusted content for prompt injection and instruction overrides.',
			    toolWhen_screen: 'Right after reading a web page, a foreign PR comment or a third-party log, before treating it as data.',
			    toolWhat_gate: 'Checks claims against real output and evidence, answering pass, contradicted or escalate.',
			    toolWhen_gate: 'Before declaring completion or closing a task: verify each acceptance criterion against real output.',
			    toolWhat_delegate: 'Hands a task to a subagent and lets System One decide how deeply it should think; permissions, presets and recursion limits stay with the host delegation tool.',
			    toolWhen_delegate: 'When a self-contained piece of work goes to a subagent and the right reasoning depth is not obvious. It deliberately has no reasoning-depth parameter: call the host delegation tool directly to pin one. It is only registered when the host delegation tool declares reasoning_effort (modelSelection enabled).',
			    labelBackend: 'Backend implementation',
			    labelBaseUrl: 'Base URL',
			    labelModel: 'Model id',
			    labelApiKeyEnv: 'API key environment variable',
			    labelTimeoutMs: 'Timeout (ms)',
			    backendHint: 'The API key is referenced by environment variable name; the secret never enters the settings document.',
			    backendActive: 'Effective implementation',
			    apiKeyPresent: 'Variable is set',
			    apiKeyMissing: 'Variable is empty',
			    labelToolPrefix: 'Tool-name prefix',
			    labelLedgerPath: 'Ledger JSONL path',
			    labelPruneThreshold: 'Prune threshold (characters)',
			    labelCalibrationPath: 'Calibration curve path',
			    unset: 'not set',
			    ledgerTotal: 'Total decisions',
			    ledgerTokens: 'Tokens saved',
			    ledgerCost: 'Estimated cost saved',
			    ledgerLatency: 'Average latency',
			    ledgerGates: 'Gates passed / failed',
			    ledgerStagnation: 'Stagnation alerts',
			    ledgerRouting: 'Routing decisions',
			    ledgerRecent: 'Recent decisions',
			    ledgerEmpty: 'The ledger is empty.',
			    ledgerLogPath: 'JSONL sink',
			    ledgerMemoryOnly: 'In memory only (no JSONL path configured)',
			    ledgerClear: 'Clear ledger',
			    ledgerClearConfirm: 'Click again to confirm (deletes the JSONL sink)',
			    ledgerCleared: 'Cleared {count} entries',
			    colTime: 'Time',
			    colType: 'Type',
			    colBackend: 'Backend',
			    colLatency: 'Latency',
			    colTokens: 'Tokens saved',
			    colDetail: 'Detail',
			    typeGate: 'gate',
			    typePrune: 'prune',
			    typeStagnation: 'stagnation',
			    typeRoute: 'route',
			    typeChoice: 'choice',
			    typeModelRoute: 'model-route',
			    typeEffort: 'effort',
			    save: 'Save',
			    saving: 'Saving…',
			    saved: 'Saved',
			    reset: 'Reset',
			    refresh: 'Refresh',
			    dirty: 'Unsaved changes',
			    clean: 'In step with the Host',
			    confirmRejected: 'The Host refused this write',
			    refreshFailed: 'Refresh failed',
			    errVirtualProvider: 'The virtual provider name cannot be empty',
			    errMaxTaskChars: 'The task-text budget must be a positive integer',
			    errPoolModel: 'A virtual model id cannot be empty',
			    errPoolDuplicate: 'Duplicate virtual model id',
			    errPoolProvider: 'A candidate provider cannot be empty',
			    errPoolModelName: 'A candidate model cannot be empty',
			    errPoolEmpty: 'Routing needs at least one pool with a candidate',
			    errMinConfidence: 'Minimum confidence must be a number between 0 and 1',
			    errEffortSetting: 'The effort policy is not one of the offered choices',
			    errBackend: 'The backend implementation is not one of the offered choices',
			    errTimeout: 'The timeout must be an integer of at least 100',
			    errToolPrefix: 'The tool-name prefix cannot be empty',
			    errPruneThreshold: 'The prune threshold must be a non-negative integer',
			    errFallback: 'The fallback target must read provider:model',
			    errInterventionMode: 'The intervention master mode must be off / observe / active',
			    errInterventionCapability: 'A capability setting must be off / observe / active / inherit',
			    errInterventionBudget: 'Budgets and thresholds must be integers at or above their own minimum',
			    errInterventionRatio: 'This ratio must be a number in [0, 1]',
			    errPruneJudgeMinChars: 'The per-segment judge minimum must be an integer at least the prune threshold',
			    errClaimMinConfidence: 'The completion-claim confidence floor must be a number in [0, 1]',
			    errClosingEvidenceChars: 'The closing evidence budget must be an integer of at least 200',
			    toneActive: 'live',
			    toneInactive: 'not live',
			    toneEnabled: 'enabled',
			    toneDisabled: 'disabled',
			    chipRoutingActive: 'Routing · enabled (candidates: {candidates})',
			    chipRoutingInactive: 'Routing · disabled',
			    chipRoutingTitleActive: 'Virtual Provider routing is enabled: requests are routed to candidate physical models from the pools, currently {candidates} candidates. Change the switch, pools, or fallback on the "Virtual Provider" page.',
			    chipRoutingTitleInactive: 'Virtual Provider routing is disabled (routing.enabled=false or the candidate pools are empty): requests use the selected physical model directly. Enable routing and configure a pool on the "Virtual Provider" page.',
			    chipEffortSet: 'Reasoning effort · {level}',
			    chipEffortUnset: 'Reasoning effort · not set',
			    chipEffortTitleSet: 'A reasoning effort is selected: every turn dispatches {level} with the request. Change it in the model selector, or choose Reflex adaptive on the "Reasoning effort" page.',
			    chipEffortTitleUnset: 'No reasoning effort is selected: the plugin does not intervene and the model default level applies. Choose a concrete level in the model selector, or Reflex adaptive on the "Reasoning effort" page.',
			    chipBackend: 'Backend · {backend}',
			    chipBackendTitle: 'System One decision backend is {backend}; API key env {env} is ready (apiKeyEnv: set). Change the implementation or connection on the "System 1 backend" page.',
			    chipBackendTitleMissing: 'System One decision backend is {backend}; API key env {env} is missing (apiKeyEnv: empty), so decisions degrade to the local fallback. Set that env var or change the backend on the "System 1 backend" page.',
			    chipBackendTitleUnsetKey: 'System One decision backend is {backend}; no API key env is declared, so the plugin uses the environment default key or degrades to the local fallback. Configure the connection on the "System 1 backend" page.',
			    statusLabel: 'Reflex status: {routing}; {effort}; {backend}. Hover or focus for the full explanation.',
			    statusRoutingActive: 'routing enabled ({candidates} candidates)',
			    statusRoutingInactive: 'routing disabled',
			    statusEffortSet: 'reasoning effort {level}',
			    statusEffortUnset: 'reasoning effort not set',
			    statusBackendOk: 'backend {backend} healthy',
			    statusBackendMissingKey: 'backend {backend} missing its API key, will degrade',
			    statusBackendDegraded: 'backend {backend} unavailable, degraded',
			    // In-panel user guide; see the Chinese dictionary for the embedding contract.
			    guideTitle: 'Harness Reflex user guide',
			    guideIntro: 'This page embeds the repository document docs/USER_GUIDE.en.md: install and build, System 1 backends, the virtual provider pools, adaptive reasoning effort (reflex / auto), the settings panel, and the MCP ↔ DSH native tool mapping.',
			    guideHint: 'The document follows the DSH interface language (English / 中文). After editing the guide, re-run npm run build:all or this page keeps the last build.',
			    guideProvenance: 'Document {source} · revision {digest}',
			    guideSource: guide_generated_1.GUIDE_SOURCES.en,
			    guideRevision: guide_generated_1.GUIDE_DIGESTS.en.slice(0, 12),
			    guideBody: guide_generated_1.GUIDE_EN,
			    rowTitle: 'Reflex effort',
			    rowDetails: 'Details',
			    rowStep: 'Step',
			    rowThinking: 'Effort',
			    rowSource: 'Source',
			    rowConfidence: 'Confidence',
			    rowLatency: 'Latency',
			    rowRoute: 'Route',
			    rowRouteUnknown: 'unknown model',
			    rowSwitched: 'switched',
			    rowSteps: '{count} steps',
			    rowSupported: 'Declared levels',
			    rowEvidence: 'Evidence',
			    rowDegraded: 'Degraded',
			    rowNone: 'none',
			    rowClearedShort: 'not sent',
			    rowHeldForCache: 'held for cache',
			    rowRouteStrategy: 'Routing strategy',
			    rowHeldForCacheDetail: 'Held current model to preserve upstream prompt cache (Cache Affinity)',
			    composerActual: 'Actual',
			    composerHeldForCache: 'Cache Affinity'
			};

		},
		"markdown": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.parseMarkdown = parseMarkdown;
			exports.renderInline = renderInline;
			exports.renderMarkdown = renderMarkdown;
			/**
			 * Minimal Markdown reader for the in-panel user guide.
			 *
			 * The guide is authored as ordinary Markdown (`USER_GUIDE.md` and its English
			 * twin) because that is what a reader wants to edit and what the repository
			 * renders. A client bundle cannot pull a Markdown library from the platform —
			 * `react` is the only seed word this plugin is allowed — so this module parses
			 * the subset of Markdown the guide actually uses.
			 *
			 * Two properties matter more than coverage:
			 *
			 * - **Parsing and rendering are separate.** {@link parseMarkdown} returns plain
			 *   data, so the syntax is unit-testable without a React runtime; the renderer
			 *   only turns that data into elements.
			 * - **Nothing is ever injected as HTML.** Emphasis, code and links become real
			 *   elements with text children, so a document that embeds `<script>` renders it
			 *   as literal text — the panel is a settings surface, not a browser.
			 *
			 * Supported: ATX headings, paragraphs with soft wrapping, bullet and ordered
			 * lists, fenced code blocks, block quotes, GitHub-style tables, thematic
			 * breaks, and inline code / bold / links.
			 *
			 * @module dsh-reflex/client/markdown
			 */
			const react_1 = require("react");
			/** `#`…`######` heading. */
			const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
			/** A thematic break: three or more of the same marker. */
			const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
			/** One list item, ordered (`1.` / `1)`) or bulleted. */
			const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
			/** A table delimiter row: only pipes, dashes, colons and spaces. */
			const TABLE_DELIMITER = /^\|?[\s:|-]+\|[\s:|-]*$/;
			/** Split one table row into trimmed cells. */
			function tableCells(line) {
			    return line
			        .replace(/^\s*\|/, '')
			        .replace(/\|\s*$/, '')
			        .split('|')
			        .map((cell) => cell.trim());
			}
			/** True when `line` opens a block whose body must not be merged into a paragraph. */
			function startsBlock(line) {
			    return (line.trim().length === 0 ||
			        line.trimStart().startsWith('```') ||
			        line.trimStart().startsWith('|') ||
			        line.trimStart().startsWith('>') ||
			        HEADING.test(line.trim()) ||
			        RULE.test(line.trim()) ||
			        LIST_ITEM.test(line));
			}
			/**
			 * Parse the Markdown subset this plugin renders.
			 * @param text - the Markdown document.
			 * @returns blocks in document order.
			 */
			function parseMarkdown(text) {
			    const lines = text.replace(/\r\n?/g, '\n').split('\n');
			    const blocks = [];
			    let index = 0;
			    while (index < lines.length) {
			        const line = lines[index];
			        const trimmed = line.trim();
			        if (trimmed.length === 0) {
			            index += 1;
			            continue;
			        }
			        if (line.trimStart().startsWith('```')) {
			            const language = line.trimStart().slice(3).trim();
			            const body = [];
			            index += 1;
			            while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
			                body.push(lines[index]);
			                index += 1;
			            }
			            index += 1; // consume the closing fence (or run off the end)
			            blocks.push({ kind: 'code', language, text: body.join('\n') });
			            continue;
			        }
			        const heading = HEADING.exec(trimmed);
			        if (heading !== null) {
			            blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
			            index += 1;
			            continue;
			        }
			        if (RULE.test(trimmed)) {
			            blocks.push({ kind: 'rule' });
			            index += 1;
			            continue;
			        }
			        if (line.trimStart().startsWith('|')) {
			            const next = lines[index + 1];
			            if (next !== undefined && TABLE_DELIMITER.test(next.trim())) {
			                const headers = tableCells(trimmed);
			                const rows = [];
			                index += 2;
			                while (index < lines.length && lines[index].trimStart().startsWith('|')) {
			                    rows.push(tableCells(lines[index].trim()));
			                    index += 1;
			                }
			                blocks.push({ kind: 'table', headers, rows });
			                continue;
			            }
			            // A pipe row with no delimiter row beneath it is not a table: it is a
			            // stray row (the usual cause is a paragraph written into the middle of a
			            // table, which strands every row after it). It still has to be consumed —
			            // `startsBlock` reports pipe rows as block starts, so the paragraph
			            // fallback below refuses to absorb it, and leaving the index where it is
			            // would spin this loop forever.
			            blocks.push({ kind: 'paragraph', text: trimmed });
			            index += 1;
			            continue;
			        }
			        if (line.trimStart().startsWith('>')) {
			            const quoted = [];
			            while (index < lines.length && lines[index].trimStart().startsWith('>')) {
			                quoted.push(lines[index].trimStart().replace(/^>\s?/, ''));
			                index += 1;
			            }
			            blocks.push({ kind: 'quote', text: quoted.join(' ').trim() });
			            continue;
			        }
			        const item = LIST_ITEM.exec(line);
			        if (item !== null) {
			            const ordered = item[2] !== undefined;
			            const items = [];
			            while (index < lines.length) {
			                const current = lines[index];
			                const match = LIST_ITEM.exec(current);
			                if (match !== null) {
			                    items.push(match[3].trim());
			                    index += 1;
			                    continue;
			                }
			                // An indented non-item line continues the item above it.
			                if (items.length > 0 && /^\s+\S/.test(current) && !startsBlock(current)) {
			                    items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
			                    index += 1;
			                    continue;
			                }
			                break;
			            }
			            blocks.push({ kind: 'list', ordered, items });
			            continue;
			        }
			        const paragraph = [];
			        while (index < lines.length && !startsBlock(lines[index])) {
			            paragraph.push(lines[index].trim());
			            index += 1;
			        }
			        if (paragraph.length > 0) {
			            blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
			        }
			        else {
			            // Belt and braces for the same failure class: every branch above must
			            // either consume the line or fall through to here. If a line is reported
			            // as a block start by `startsBlock` but no branch claims it, the paragraph
			            // loop cannot absorb it and this loop would never advance — so consume it
			            // as plain text instead of hanging.
			            blocks.push({ kind: 'paragraph', text: trimmed });
			            index += 1;
			        }
			    }
			    return blocks;
			}
			/** Inline spans the renderer understands. */
			const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
			/** Style kit of the rendered document; every value is a host design token. */
			const S = {
			    prose: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '920px' },
			    h1: { fontSize: '17px', fontWeight: 700, margin: '4px 0 0 0' },
			    h2: {
			        fontSize: '14px',
			        fontWeight: 600,
			        margin: '10px 0 0 0',
			        paddingBottom: '4px',
			        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.1))'
			    },
			    h3: { fontSize: '13px', fontWeight: 600, margin: '6px 0 0 0' },
			    h4: { fontSize: '12px', fontWeight: 600, margin: '4px 0 0 0' },
			    paragraph: { margin: 0, fontSize: '12px', lineHeight: '1.65' },
			    list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: '1.65', display: 'flex', flexDirection: 'column', gap: '3px' },
			    quote: {
			        margin: 0,
			        padding: '6px 10px',
			        borderLeft: '3px solid var(--dsw-alias-brand-primary, #4d6bfe)',
			        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03))',
			        fontSize: '12px',
			        lineHeight: '1.6'
			    },
			    pre: {
			        margin: 0,
			        padding: '10px 12px',
			        overflowX: 'auto',
			        background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.25))',
			        border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08))',
			        borderRadius: '6px',
			        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			        fontSize: '11px',
			        lineHeight: '1.55',
			        whiteSpace: 'pre'
			    },
			    code: {
			        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			        fontSize: '11px',
			        padding: '0 4px',
			        borderRadius: '4px',
			        background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.25))'
			    },
			    tableWrap: { overflowX: 'auto' },
			    table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
			    th: {
			        textAlign: 'left',
			        padding: '4px 6px',
			        fontWeight: 500,
			        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
			        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))'
			    },
			    td: {
			        padding: '4px 6px',
			        verticalAlign: 'top',
			        borderBottom: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.06))'
			    },
			    rule: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.1))', margin: '2px 0' },
			    link: { color: 'var(--dsw-alias-brand-primary, #4d6bfe)', textDecoration: 'underline' }
			};
			/**
			 * Render the inline spans of one text run.
			 *
			 * The result is a list of strings and elements — never HTML — so embedded markup
			 * is displayed, not executed.
			 * @param text - one line (or paragraph) of Markdown-ish text.
			 * @returns renderable children.
			 */
			function renderInline(text) {
			    const out = [];
			    let cursor = 0;
			    INLINE.lastIndex = 0;
			    for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
			        if (match.index > cursor)
			            out.push(text.slice(cursor, match.index));
			        const token = match[0];
			        if (token.startsWith('`')) {
			            out.push((0, react_1.createElement)('code', { style: S.code }, token.slice(1, -1)));
			        }
			        else if (token.startsWith('**')) {
			            out.push((0, react_1.createElement)('strong', null, token.slice(2, -2)));
			        }
			        else {
			            const label = token.slice(1, token.indexOf(']'));
			            const href = token.slice(token.indexOf('](') + 2, -1);
			            out.push((0, react_1.createElement)('a', { href, target: '_blank', rel: 'noreferrer noopener', style: S.link }, label));
			        }
			        cursor = match.index + token.length;
			    }
			    if (cursor < text.length)
			        out.push(text.slice(cursor));
			    return out;
			}
			/** One parsed block as an element. */
			function renderBlock(block, key) {
			    switch (block.kind) {
			        case 'heading': {
			            const tag = `h${String(Math.min(block.level, 4))}`;
			            const style = S[tag] ?? S.h4;
			            return (0, react_1.createElement)(tag, { key, style }, ...renderInline(block.text));
			        }
			        case 'paragraph':
			            return (0, react_1.createElement)('p', { key, style: S.paragraph }, ...renderInline(block.text));
			        case 'list':
			            return (0, react_1.createElement)(block.ordered ? 'ol' : 'ul', { key, style: S.list }, ...block.items.map((item, itemIndex) => (0, react_1.createElement)('li', { key: itemIndex }, ...renderInline(item))));
			        case 'code':
			            return (0, react_1.createElement)('pre', { key, style: S.pre }, (0, react_1.createElement)('code', null, block.text));
			        case 'quote':
			            return (0, react_1.createElement)('blockquote', { key, style: S.quote }, ...renderInline(block.text));
			        case 'table':
			            return (0, react_1.createElement)('div', { key, style: S.tableWrap }, (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('thead', null, (0, react_1.createElement)('tr', null, ...block.headers.map((cell, cellIndex) => (0, react_1.createElement)('th', { key: cellIndex, style: S.th }, ...renderInline(cell))))), (0, react_1.createElement)('tbody', null, ...block.rows.map((row, rowIndex) => (0, react_1.createElement)('tr', { key: rowIndex }, ...row.map((cell, cellIndex) => (0, react_1.createElement)('td', { key: cellIndex, style: S.td }, ...renderInline(cell))))))));
			        default:
			            return (0, react_1.createElement)('hr', { key, style: S.rule });
			    }
			}
			/**
			 * Render a Markdown document as a read-only element tree.
			 * @param text - the Markdown document.
			 * @returns the rendered document.
			 */
			function renderMarkdown(text) {
			    return (0, react_1.createElement)('div', { style: S.prose }, ...parseMarkdown(text).map((block, index) => renderBlock(block, index)));
			}

		},
		"panel": function (module, exports, require) {
			"use strict";
			/**
			 * Pure view model of the Reflex settings page.
			 *
			 * Everything the page decides — how a Host section becomes an editable draft,
			 * which path ops a draft produces, which numbers are shown, which tone a chip
			 * takes — is a pure function of its inputs and lives here. The React layer in
			 * `./view` only draws what this module returns, and the store in `./store` only
			 * moves data in and out of it, so the page's behaviour is testable without a
			 * DOM, a browser, or a Host.
			 *
			 * The adaptive-level vocabulary below deliberately restates the Host's
			 * `ADAPTIVE_EFFORT_LEVELS`. A browser bundle may not value-import another module
			 * across the client boundary, so the copy is checked against the Host's own
			 * constants by `client-contract.test.ts` instead of being shared — drift fails
			 * the build rather than the page. There is deliberately no concrete-level list
			 * here: configuration offers only "leave untouched" and the adaptive policy.
			 *
			 * @module dsh-reflex/client/panel
			 */
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.EMPTY_DRAFT = exports.DRAFT_GROUPS = exports.TOOL_ADVICE = exports.TOOL_DEFAULT_ENABLED = exports.REFLEX_TOOL_SUFFIXES = exports.INTERVENTION_CAPABILITIES = exports.INTERVENTION_SETTINGS = exports.INTERVENTION_MODES = exports.LEDGER_TYPES = exports.BACKEND_CHOICES = exports.EFFORT_POLICIES = exports.ADAPTIVE_EFFORT_POLICY = exports.ADAPTIVE_EFFORT_LEVELS = void 0;
			exports.normalizeEffortPolicy = normalizeEffortPolicy;
			exports.recommendedToolSwitches = recommendedToolSwitches;
			exports.asText = asText;
			exports.asNumber = asNumber;
			exports.textToTags = textToTags;
			exports.draftFromSnapshot = draftFromSnapshot;
			exports.draftFromLayers = draftFromLayers;
			exports.draftFromConfig = draftFromConfig;
			exports.splitTarget = splitTarget;
			exports.validateDraft = validateDraft;
			exports.groupWrites = groupWrites;
			exports.diffDraft = diffDraft;
			exports.withPreservedSiblings = withPreservedSiblings;
			exports.dirtyGroups = dirtyGroups;
			exports.addPool = addPool;
			exports.removePool = removePool;
			exports.addPoolEntry = addPoolEntry;
			exports.removePoolEntry = removePoolEntry;
			exports.movePoolEntry = movePoolEntry;
			exports.formatInteger = formatInteger;
			exports.formatLatency = formatLatency;
			exports.formatUsd = formatUsd;
			exports.formatPercent = formatPercent;
			exports.formatClock = formatClock;
			exports.ledgerTypeKey = ledgerTypeKey;
			exports.levelTone = levelTone;
			exports.systemOneDegraded = systemOneDegraded;
			exports.panelStatus = panelStatus;
			exports.ledgerRows = ledgerRows;
			exports.overviewMetrics = overviewMetrics;
			exports.resolveReflexNamespace = resolveReflexNamespace;
			exports.interpolate = interpolate;
			/** Levels the adaptive controller may choose from, mirroring the Host vocabulary. */
			exports.ADAPTIVE_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'];
			/** The single adaptive entry the panel offers; the `auto` alias folds onto it. */
			exports.ADAPTIVE_EFFORT_POLICY = 'reflex';
			/**
			 * Effort policies the panel offers: leave untouched, or adapt per turn. A
			 * concrete level is a model-selector choice and is deliberately absent.
			 */
			exports.EFFORT_POLICIES = ['', exports.ADAPTIVE_EFFORT_POLICY];
			/**
			 * Fold the legacy `auto` alias onto the panel's canonical adaptive sentinel.
			 *
			 * Configuration compatibility lives in the Host (which still accepts `auto`);
			 * the page needs one name, so every path that seeds, validates, shows, or writes
			 * an effort policy goes through here.
			 * @param setting - authored or resolved `reasoningEffort` value.
			 * @returns the value the page edits and writes.
			 */
			function normalizeEffortPolicy(setting) {
			    const trimmed = setting.trim();
			    return trimmed === 'auto' ? exports.ADAPTIVE_EFFORT_POLICY : trimmed;
			}
			/** Backend implementations the panel offers. */
			exports.BACKEND_CHOICES = ['auto', 'mock', 'jev', 'vllm'];
			/** Ledger entry types the Host records, in the order the panel lists them. */
			exports.LEDGER_TYPES = [
			    'gate',
			    'prune',
			    'stagnation',
			    'route',
			    'choice',
			    'model-route',
			    'effort-decision'
			];
			/**
			 * The three-state intervention vocabulary.
			 *
			 * The browser bundle cannot value-import a Host module, so the client restates
			 * these lists and `client-contract.test.ts` holds them equal to the Host's.
			 */
			exports.INTERVENTION_MODES = ['off', 'observe', 'active'];
			/** Capability settings: the three states plus `inherit`. */
			exports.INTERVENTION_SETTINGS = ['off', 'observe', 'active', 'inherit'];
			/** The capabilities that may carry their own setting. */
			exports.INTERVENTION_CAPABILITIES = ['stagnation', 'prune', 'gate', 'closing'];
			/** The six tool suffixes this plugin registers, in registration order. Restated; see above. */
			exports.REFLEX_TOOL_SUFFIXES = ['choice', 'score', 'route', 'screen', 'gate', 'delegate'];
			/**
			 * Whether one suffix is registered when the deployment says nothing about it.
			 *
			 * Restated from the Host's own table (`REFLEX_TOOL_DEFAULT_ENABLED` in
			 * `src/tools.ts`), because the page is a separate compilation unit: `route` is
			 * the one capability the default activation leaves off. The page reads the live
			 * value from the Host and uses this table only where a value is missing, so a
			 * wrong entry here would show up as a wrong switch, not as a wrong write.
			 */
			exports.TOOL_DEFAULT_ENABLED = {
			    choice: true,
			    score: true,
			    route: false,
			    screen: true,
			    gate: true,
			    // On by default, and additionally conditional on the Host: the switch is
			    // shown, and the delegate only registers when the Host delegation tool
			    // declares `reasoning_effort` (`modelSelection: true`).
			    delegate: true
			};
			/**
			 * The advice shown next to each suffix, and the basis of "apply the recommended
			 * set". Advice is not configuration: it never writes anything, and it agrees
			 * with the Host default — five suffixes on, `route` off.
			 */
			exports.TOOL_ADVICE = {
			    choice: 'expose',
			    score: 'expose',
			    route: 'optional',
			    screen: 'expose',
			    gate: 'expose',
			    delegate: 'expose'
			};
			/**
			 * The switch each suffix takes when the recommended set is applied.
			 *
			 * Derived from {@link TOOL_ADVICE} rather than written out a second time, so the
			 * button and the labels can never disagree about what is recommended. The result
			 * is the documented default: `choice`, `score`, `screen`, `gate`, and
			 * `delegate` on, `route` off.
			 * @returns suffix → enabled.
			 */
			function recommendedToolSwitches() {
			    return Object.fromEntries(exports.REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, exports.TOOL_ADVICE[suffix] === 'expose']));
			}
			/** Group names, in the order the page presents them. */
			exports.DRAFT_GROUPS = [
			    'routing',
			    'effort',
			    'backend',
			    'runtime',
			    'interventions',
			    'tools',
			    'delegation'
			];
			/** Every tool suffix at its documented default, which is what an omitted block means. */
			function defaultToolSwitches() {
			    return Object.fromEntries(exports.REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, exports.TOOL_DEFAULT_ENABLED[suffix]]));
			}
			/** Every capability inheriting the master mode, which is the documented default. */
			function allCapabilitiesInherit() {
			    return Object.fromEntries(exports.INTERVENTION_CAPABILITIES.map((capability) => [capability, 'inherit']));
			}
			/** An empty draft: the Host defaults, with every text field blank rather than `undefined`. */
			exports.EMPTY_DRAFT = {
			    routing: { enabled: true, virtualProvider: 'reflex', fallback: '', maxTaskChars: '400', pools: [] },
			    effort: { setting: '', fallback: 'low', minConfidence: '0.3', enabled: true },
			    backend: { backend: 'auto', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: '' },
			    runtime: { toolPrefix: 'reflex_', ledgerPath: '', pruneThreshold: '500', calibrationPath: '' },
			    interventions: {
			        mode: 'observe',
			        capabilities: allCapabilitiesInherit(),
			        maxInterventionsPerTurn: '3',
			        maxJudgmentsPerTurn: '3',
			        maxJudgmentsPerSession: '20',
			        repeatThreshold: '3',
			        failureThreshold: '3',
			        minConfidence: '0.6',
			        windowSize: '6',
			        pruneFloorRatio: '0.5',
			        pruneHeadChars: '400',
			        pruneTailChars: '400',
			        // Blank means "let the Host apply its own default"; the page never seeds a
			        // value here, so an unrelated save cannot pin this field.
			        pruneJudgeMinChars: '',
			        claimMinConfidence: '',
			        closingEvidenceChars: '',
			        intent: ''
			    },
			    tools: { enabled: defaultToolSwitches() },
			    // Off, and it stays off unless a person ticks it: the tool cannot work until
			    // the host publishes the level, and opting in also edits a file outside this
			    // plugin, so the default is "do not".
			    delegation: { enabled: false }
			};
			/** Read a plain object field. */
			function asRecord(value) {
			    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
			}
			/** Read a field as text, mapping a missing or non-scalar value to `''`. */
			function asText(value) {
			    if (typeof value === 'string')
			        return value;
			    if (typeof value === 'number' && Number.isFinite(value))
			        return String(value);
			    return '';
			}
			/** Read a field as a finite number, or `undefined`. */
			function asNumber(value) {
			    if (typeof value === 'number' && Number.isFinite(value))
			        return value;
			    if (typeof value === 'string' && value.trim().length > 0) {
			        const parsed = Number(value);
			        return Number.isFinite(parsed) ? parsed : undefined;
			    }
			    return undefined;
			}
			/** Read a field as a boolean with a default. */
			function asBoolean(value, fallback) {
			    return typeof value === 'boolean' ? value : fallback;
			}
			/** Split authored tags into the form's comma-separated text. */
			function tagsToText(value) {
			    return Array.isArray(value) ? value.filter((tag) => typeof tag === 'string').join(', ') : '';
			}
			/** Split the form's comma-separated text into authored tags. */
			function textToTags(text) {
			    return text
			        .split(',')
			        .map((tag) => tag.trim())
			        .filter((tag) => tag.length > 0);
			}
			/** Read the authored pools of a routing section. */
			function poolsFromRouting(routing) {
			    const models = asRecord(routing.models);
			    return Object.keys(models).map((model) => {
			        const entries = Array.isArray(models[model]) ? models[model] : [];
			        return {
			            model,
			            entries: entries.map((entry) => {
			                const record = asRecord(entry);
			                return {
			                    provider: asText(record.provider),
			                    model: asText(record.model),
			                    description: asText(record.description),
			                    tags: tagsToText(record.tags)
			                };
			            })
			        };
			    });
			}
			/**
			 * Seed an editable draft from a live runtime snapshot when form values are empty.
			 */
			function draftFromSnapshot(snapshot, base) {
			    if (!snapshot)
			        return base;
			    const draft = { ...base };
			    if (base.routing.pools.length === 0 && snapshot.routing?.pools && snapshot.routing.pools.length > 0) {
			        const pools = snapshot.routing.pools.map((p) => ({
			            model: asText(p.model),
			            entries: Array.isArray(p.entries)
			                ? p.entries.map((e) => {
			                    const rec = asRecord(e);
			                    return {
			                        provider: asText(rec.provider),
			                        model: asText(rec.model),
			                        description: asText(rec.description),
			                        tags: tagsToText(rec.tags)
			                    };
			                })
			                : []
			        }));
			        draft.routing = {
			            ...draft.routing,
			            enabled: snapshot.routing.enabled ?? draft.routing.enabled,
			            virtualProvider: snapshot.routing.virtualProvider || draft.routing.virtualProvider,
			            fallback: snapshot.routing.fallback || draft.routing.fallback,
			            ...(snapshot.routing.maxTaskChars !== undefined ? { maxTaskChars: String(snapshot.routing.maxTaskChars) } : {}),
			            pools
			        };
			    }
			    if (!draft.effort.setting && snapshot.effort?.setting) {
			        draft.effort = {
			            ...draft.effort,
			            setting: normalizeEffortPolicy(snapshot.effort.setting),
			            fallback: snapshot.effort.fallback || draft.effort.fallback,
			            minConfidence: snapshot.effort.minConfidence !== undefined ? String(snapshot.effort.minConfidence) : draft.effort.minConfidence
			        };
			    }
			    return draft;
			}
			/**
			 * Seed a draft from the two layers a Host settings section reports.
			 *
			 * `value` is the effective section and already includes `base` (the profile's
			 * compose layer) wherever the user layer is silent, so it wins field by field.
			 * `base` exists because a deployment configured in `cordis.patch.yml` writes
			 * nothing into the user layer: `value` alone would render an empty page for a
			 * configuration that is demonstrably running. Virtual-model pools are the one
			 * exception to "value wins": a pool added in either layer is kept, so editing a
			 * base-defined pool cannot hide a user-defined one.
			 *
			 * @param value - the effective section.
			 * @param base - the composition base the effective section resolves over.
			 * @returns the draft to edit.
			 */
			function draftFromLayers(value, base) {
			    const draft = draftFromConfig(value);
			    const baseDraft = draftFromConfig(base);
			    const pools = mergePools(draft.routing.pools, baseDraft.routing.pools);
			    return {
			        ...draft,
			        routing: { ...draft.routing, pools },
			        interventions: {
			            ...draft.interventions,
			            capabilities: { ...baseDraft.interventions.capabilities, ...draft.interventions.capabilities }
			        }
			    };
			}
			/**
			 * Merge two virtual-model pool lists, keeping both sides.
			 *
			 * A model id present on one side only is kept as is; one present on both takes
			 * the effective-side list (it may legitimately be empty, meaning "clear this
			 * pool"), and an empty effective list with no counterpart is dropped rather
			 * than rendered as an orphan row.
			 *
			 * @param value - pools from the effective layer.
			 * @param base - pools from the composition base.
			 * @returns the merged list, effective order first.
			 */
			function mergePools(value, base) {
			    const seen = new Set(value.map((pool) => pool.model));
			    return [...value, ...base.filter((pool) => !seen.has(pool.model) && pool.model.length > 0)];
			}
			/**
			 * Seed an editable draft from a Host-resolved configuration section.
			 *
			 * Tolerant by construction: an absent, partial, or unexpected section yields the
			 * documented defaults, because a panel that throws on a half-written settings
			 * document would be unusable exactly when it is needed.
			 * @param value - the resolved section a `ConfigForm` snapshot carries.
			 * @returns the draft to edit.
			 */
			function draftFromConfig(value) {
			    const section = asRecord(value);
			    const routing = asRecord(section.routing);
			    const effort = asRecord(section.effort);
			    const systemOne = asRecord(section.systemOne);
			    const interventions = asRecord(section.interventions);
			    const authoredCapabilities = asRecord(interventions.capabilities);
			    const tools = asRecord(section.tools);
			    const authoredTools = asRecord(tools.enabled);
			    return {
			        routing: {
			            enabled: asBoolean(routing.enabled, exports.EMPTY_DRAFT.routing.enabled),
			            virtualProvider: asText(routing.virtualProvider) || exports.EMPTY_DRAFT.routing.virtualProvider,
			            // The *authored* block spells the fallback as one `provider:model` string;
			            // only the resolved configuration splits it into a target object.
			            fallback: asText(routing.fallback),
			            maxTaskChars: asText(routing.maxTaskChars) || exports.EMPTY_DRAFT.routing.maxTaskChars,
			            pools: poolsFromRouting(routing)
			        },
			        effort: {
			            setting: normalizeEffortPolicy(asText(effort.reasoningEffort)),
			            fallback: asText(effort.fallback) || exports.EMPTY_DRAFT.effort.fallback,
			            minConfidence: asText(effort.minConfidence) || exports.EMPTY_DRAFT.effort.minConfidence,
			            enabled: asBoolean(effort.enabled, exports.EMPTY_DRAFT.effort.enabled)
			        },
			        backend: {
			            backend: asText(section.backend) || exports.EMPTY_DRAFT.backend.backend,
			            baseUrl: asText(systemOne.baseUrl),
			            model: asText(systemOne.model),
			            apiKeyEnv: asText(systemOne.apiKeyEnv),
			            timeoutMs: asText(systemOne.timeoutMs)
			        },
			        runtime: {
			            toolPrefix: asText(section.toolPrefix) || exports.EMPTY_DRAFT.runtime.toolPrefix,
			            ledgerPath: asText(section.ledgerPath),
			            pruneThreshold: asText(section.pruneThreshold) || exports.EMPTY_DRAFT.runtime.pruneThreshold,
			            calibrationPath: asText(section.calibrationPath)
			        },
			        // Every field of the section is carried, including the three the switch page
			        // does not feature prominently: a group write replaces the whole section, so
			        // a field left out of the draft would be deleted by an unrelated edit.
			        interventions: {
			            mode: asText(interventions.mode) || exports.EMPTY_DRAFT.interventions.mode,
			            capabilities: Object.fromEntries(exports.INTERVENTION_CAPABILITIES.map((capability) => [
			                capability,
			                asText(authoredCapabilities[capability]) || 'inherit'
			            ])),
			            maxInterventionsPerTurn: asText(interventions.maxInterventionsPerTurn) || exports.EMPTY_DRAFT.interventions.maxInterventionsPerTurn,
			            maxJudgmentsPerTurn: asText(interventions.maxJudgmentsPerTurn) || exports.EMPTY_DRAFT.interventions.maxJudgmentsPerTurn,
			            maxJudgmentsPerSession: asText(interventions.maxJudgmentsPerSession) || exports.EMPTY_DRAFT.interventions.maxJudgmentsPerSession,
			            repeatThreshold: asText(interventions.repeatThreshold) || exports.EMPTY_DRAFT.interventions.repeatThreshold,
			            failureThreshold: asText(interventions.failureThreshold) || exports.EMPTY_DRAFT.interventions.failureThreshold,
			            minConfidence: asText(interventions.minConfidence) || exports.EMPTY_DRAFT.interventions.minConfidence,
			            windowSize: asText(interventions.windowSize) || exports.EMPTY_DRAFT.interventions.windowSize,
			            pruneFloorRatio: asText(interventions.pruneFloorRatio) || exports.EMPTY_DRAFT.interventions.pruneFloorRatio,
			            pruneHeadChars: asText(interventions.pruneHeadChars) || exports.EMPTY_DRAFT.interventions.pruneHeadChars,
			            pruneTailChars: asText(interventions.pruneTailChars) || exports.EMPTY_DRAFT.interventions.pruneTailChars,
			            pruneJudgeMinChars: asText(interventions.pruneJudgeMinChars),
			            claimMinConfidence: asText(interventions.claimMinConfidence),
			            closingEvidenceChars: asText(interventions.closingEvidenceChars),
			            intent: asText(interventions.intent)
			        },
			        tools: {
			            enabled: Object.fromEntries(exports.REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, asBoolean(authoredTools[suffix], exports.TOOL_DEFAULT_ENABLED[suffix])]))
			        },
			        // Named `delegation` (not another `tools.enabled` key) because it is a
			        // different decision: a host capability, default off.
			        delegation: { enabled: asBoolean(asRecord(section.delegation).enabled, exports.EMPTY_DRAFT.delegation.enabled) }
			    };
			}
			/** Split a `provider:model` target into its two halves. */
			function splitTarget(text) {
			    const trimmed = text.trim();
			    const separator = trimmed.indexOf(':');
			    if (separator <= 0 || separator === trimmed.length - 1)
			        return undefined;
			    return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
			}
			/**
			 * Validate a draft before it reaches the Host.
			 *
			 * The Host validates too, but a refused write is a poor way to learn that a
			 * number field holds text, so the page reports the same problems first.
			 * @param draft - the draft to check.
			 * @returns the copy keys of every problem, and whether any was found.
			 */
			function validateDraft(draft) {
			    const errors = [];
			    if (draft.routing.virtualProvider.trim().length === 0)
			        errors.push('errVirtualProvider');
			    if (draft.routing.fallback.trim().length > 0 && splitTarget(draft.routing.fallback) === undefined) {
			        errors.push('errFallback');
			    }
			    const maxTaskChars = asNumber(draft.routing.maxTaskChars);
			    if (maxTaskChars === undefined || !Number.isInteger(maxTaskChars) || maxTaskChars <= 0)
			        errors.push('errMaxTaskChars');
			    const modelIds = draft.routing.pools.map((pool) => pool.model.trim());
			    for (const modelId of modelIds) {
			        if (modelId.length === 0)
			            errors.push('errPoolModel');
			    }
			    if (new Set(modelIds.filter((modelId) => modelId.length > 0)).size !== modelIds.filter((modelId) => modelId.length > 0).length) {
			        errors.push('errPoolDuplicate');
			    }
			    for (const pool of draft.routing.pools) {
			        for (const entry of pool.entries) {
			            if (entry.provider.trim().length === 0)
			                errors.push('errPoolProvider');
			            if (entry.model.trim().length === 0)
			                errors.push('errPoolModelName');
			        }
			    }
			    if (draft.routing.enabled && !draft.routing.pools.some((pool) => pool.entries.length > 0))
			        errors.push('errPoolEmpty');
			    // Accept a draft that still carries the `auto` alias and fold it before the
			    // policy check, so compat never depends on which path seeded the draft.
			    if (!exports.EFFORT_POLICIES.includes(normalizeEffortPolicy(draft.effort.setting)))
			        errors.push('errEffortSetting');
			    if (!exports.ADAPTIVE_EFFORT_LEVELS.includes(draft.effort.fallback))
			        errors.push('errFallback');
			    const minConfidence = asNumber(draft.effort.minConfidence);
			    if (minConfidence === undefined || minConfidence < 0 || minConfidence > 1)
			        errors.push('errMinConfidence');
			    if (!exports.BACKEND_CHOICES.includes(draft.backend.backend))
			        errors.push('errBackend');
			    const timeoutMs = draft.backend.timeoutMs.trim() === '' ? undefined : asNumber(draft.backend.timeoutMs);
			    if (draft.backend.timeoutMs.trim() !== '' && (timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs < 100)) {
			        errors.push('errTimeout');
			    }
			    if (draft.runtime.toolPrefix.trim().length === 0)
			        errors.push('errToolPrefix');
			    const pruneThreshold = asNumber(draft.runtime.pruneThreshold);
			    if (pruneThreshold === undefined || !Number.isInteger(pruneThreshold) || pruneThreshold < 0) {
			        errors.push('errPruneThreshold');
			    }
			    // The intervention page repeats the Host's own rules so a refused write is not
			    // how the user learns that a budget field holds text.
			    if (!exports.INTERVENTION_MODES.includes(draft.interventions.mode)) {
			        errors.push('errInterventionMode');
			    }
			    for (const capability of exports.INTERVENTION_CAPABILITIES) {
			        if (!exports.INTERVENTION_SETTINGS.includes(draft.interventions.capabilities[capability])) {
			            errors.push('errInterventionCapability');
			        }
			    }
			    const budgets = [
			        [draft.interventions.maxInterventionsPerTurn, 0],
			        [draft.interventions.maxJudgmentsPerTurn, 0],
			        [draft.interventions.maxJudgmentsPerSession, 0],
			        [draft.interventions.repeatThreshold, 2],
			        [draft.interventions.failureThreshold, 2],
			        [draft.interventions.windowSize, 3],
			        [draft.interventions.pruneHeadChars, 0],
			        [draft.interventions.pruneTailChars, 0]
			    ];
			    for (const [text, minimum] of budgets) {
			        const parsed = asNumber(text);
			        if (parsed === undefined || !Number.isInteger(parsed) || parsed < minimum)
			            errors.push('errInterventionBudget');
			    }
			    // Blank is legal and means "let the Host apply its own default". When set, the
			    // per-segment judge cannot be cheaper to reach than pruning itself: a threshold
			    // below `pruneThreshold` would ask System One about a payload the manifest
			    // decided was too small to prune, and the Host rejects the inversion.
			    if (draft.interventions.pruneJudgeMinChars.trim() !== '') {
			        const judgeMinChars = asNumber(draft.interventions.pruneJudgeMinChars);
			        if (judgeMinChars === undefined ||
			            !Number.isInteger(judgeMinChars) ||
			            judgeMinChars < 0 ||
			            (pruneThreshold !== undefined && judgeMinChars < pruneThreshold)) {
			            errors.push('errPruneJudgeMinChars');
			        }
			    }
			    for (const text of [draft.interventions.minConfidence, draft.interventions.pruneFloorRatio]) {
			        const parsed = asNumber(text);
			        if (parsed === undefined || parsed < 0 || parsed > 1)
			            errors.push('errInterventionRatio');
			    }
			    // The two closing-check knobs are also blank-legal: blank keeps the Host
			    // default, while an authored value must stay inside its own range.
			    if (draft.interventions.claimMinConfidence.trim() !== '') {
			        const parsed = asNumber(draft.interventions.claimMinConfidence);
			        if (parsed === undefined || parsed < 0 || parsed > 1)
			            errors.push('errClaimMinConfidence');
			    }
			    if (draft.interventions.closingEvidenceChars.trim() !== '') {
			        const parsed = asNumber(draft.interventions.closingEvidenceChars);
			        if (parsed === undefined || !Number.isInteger(parsed) || parsed < 200)
			            errors.push('errClosingEvidenceChars');
			    }
			    return { errors: [...new Set(errors)], ok: errors.length === 0 };
			}
			/**
			 * Convert a draft group into the Host schema paths it authors.
			 *
			 * A group is a *view* concept; the Host addresses configuration by schema path,
			 * and two of the six groups are not one path: `backend` is the scalar union that
			 * sits next to the `systemOne` block, and `runtime` is four separate top-level
			 * fields. Addressing the Host by group name is refused — every field of the
			 * System 1 backend page failed with either `Config field "runtime" is not
			 * volatile` (the runtime group) or `$.backend expected "auto" | "mock" | "jev" |
			 * "vllm" but got {"backend":...}` (the backend group) — so a group is always
			 * expanded to real schema paths here.
			 *
			 * Absent-means-default is expressed by *omission*: a blank text field yields no
			 * key, so the field keeps whatever the composition layer below says instead of
			 * being pinned to an empty string. A path with no value at all is written as an
			 * `unset` op, which says the same thing for a top-level field.
			 * @param draft - the draft to convert.
			 * @param group - which group to convert.
			 * @returns one entry per Host schema path the group authors, in schema order.
			 */
			function groupWrites(draft, group) {
			    const present = (text) => {
			        const trimmed = text.trim();
			        return trimmed.length === 0 ? undefined : trimmed;
			    };
			    switch (group) {
			        case 'routing': {
			            const models = {};
			            for (const pool of draft.routing.pools) {
			                const modelId = pool.model.trim();
			                if (modelId.length === 0)
			                    continue;
			                models[modelId] = pool.entries.map((entry) => ({
			                    provider: entry.provider.trim(),
			                    model: entry.model.trim(),
			                    ...(present(entry.description) === undefined ? {} : { description: entry.description.trim() }),
			                    ...(textToTags(entry.tags).length === 0 ? {} : { tags: textToTags(entry.tags) })
			                }));
			            }
			            const fallback = present(draft.routing.fallback);
			            return [
			                {
			                    path: [group],
			                    value: {
			                        enabled: draft.routing.enabled,
			                        ...(present(draft.routing.virtualProvider) === undefined ? {} : { virtualProvider: draft.routing.virtualProvider.trim() }),
			                        ...(fallback === undefined ? {} : { fallback }),
			                        ...(asNumber(draft.routing.maxTaskChars) === undefined ? {} : { maxTaskChars: asNumber(draft.routing.maxTaskChars) }),
			                        models
			                    }
			                }
			            ];
			        }
			        case 'effort':
			            return [
			                {
			                    path: [group],
			                    value: {
			                        enabled: draft.effort.enabled,
			                        ...(present(draft.effort.setting) === undefined
			                            ? {}
			                            : { reasoningEffort: normalizeEffortPolicy(draft.effort.setting) }),
			                        ...(present(draft.effort.fallback) === undefined ? {} : { fallback: draft.effort.fallback.trim() }),
			                        ...(asNumber(draft.effort.minConfidence) === undefined ? {} : { minConfidence: asNumber(draft.effort.minConfidence) })
			                    }
			                }
			            ];
			        case 'backend':
			            // One page, two Host paths: the scalar backend choice and its own block.
			            return [
			                { path: ['backend'], value: present(draft.backend.backend) ?? 'auto' },
			                {
			                    path: ['systemOne'],
			                    value: {
			                        ...(present(draft.backend.baseUrl) === undefined ? {} : { baseUrl: draft.backend.baseUrl.trim() }),
			                        ...(present(draft.backend.model) === undefined ? {} : { model: draft.backend.model.trim() }),
			                        ...(present(draft.backend.apiKeyEnv) === undefined ? {} : { apiKeyEnv: draft.backend.apiKeyEnv.trim() }),
			                        ...(asNumber(draft.backend.timeoutMs) === undefined ? {} : { timeoutMs: asNumber(draft.backend.timeoutMs) })
			                    }
			                }
			            ];
			        case 'interventions': {
			            // Only the capability settings that were authored are written, so an
			            // inherited capability stays inherited instead of being frozen to the
			            // master mode it happens to resolve to today.
			            const capabilities = {};
			            for (const capability of exports.INTERVENTION_CAPABILITIES) {
			                const setting = present(draft.interventions.capabilities[capability] ?? '');
			                // `inherit` *is* the omission: writing it explicitly would record a
			                // choice the user never made, and the Host derives it from the mode.
			                if (setting === undefined || setting === 'inherit')
			                    continue;
			                capabilities[capability] = setting;
			            }
			            const count = (text) => {
			                const parsed = asNumber(text);
			                return parsed === undefined ? undefined : parsed;
			            };
			            const section = {
			                ...(present(draft.interventions.mode) === undefined ? {} : { mode: draft.interventions.mode.trim() }),
			                ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
			                ...(count(draft.interventions.maxInterventionsPerTurn) === undefined
			                    ? {}
			                    : { maxInterventionsPerTurn: count(draft.interventions.maxInterventionsPerTurn) }),
			                ...(count(draft.interventions.maxJudgmentsPerTurn) === undefined
			                    ? {}
			                    : { maxJudgmentsPerTurn: count(draft.interventions.maxJudgmentsPerTurn) }),
			                ...(count(draft.interventions.maxJudgmentsPerSession) === undefined
			                    ? {}
			                    : { maxJudgmentsPerSession: count(draft.interventions.maxJudgmentsPerSession) }),
			                ...(count(draft.interventions.repeatThreshold) === undefined
			                    ? {}
			                    : { repeatThreshold: count(draft.interventions.repeatThreshold) }),
			                ...(count(draft.interventions.failureThreshold) === undefined
			                    ? {}
			                    : { failureThreshold: count(draft.interventions.failureThreshold) }),
			                ...(count(draft.interventions.minConfidence) === undefined
			                    ? {}
			                    : { minConfidence: count(draft.interventions.minConfidence) }),
			                ...(count(draft.interventions.windowSize) === undefined ? {} : { windowSize: count(draft.interventions.windowSize) }),
			                ...(count(draft.interventions.pruneFloorRatio) === undefined
			                    ? {}
			                    : { pruneFloorRatio: count(draft.interventions.pruneFloorRatio) }),
			                ...(count(draft.interventions.pruneHeadChars) === undefined
			                    ? {}
			                    : { pruneHeadChars: count(draft.interventions.pruneHeadChars) }),
			                ...(count(draft.interventions.pruneTailChars) === undefined
			                    ? {}
			                    : { pruneTailChars: count(draft.interventions.pruneTailChars) }),
			                ...(count(draft.interventions.pruneJudgeMinChars) === undefined
			                    ? {}
			                    : { pruneJudgeMinChars: count(draft.interventions.pruneJudgeMinChars) }),
			                ...(count(draft.interventions.claimMinConfidence) === undefined
			                    ? {}
			                    : { claimMinConfidence: count(draft.interventions.claimMinConfidence) }),
			                ...(count(draft.interventions.closingEvidenceChars) === undefined
			                    ? {}
			                    : { closingEvidenceChars: count(draft.interventions.closingEvidenceChars) }),
			                ...(present(draft.interventions.intent) === undefined ? {} : { intent: draft.interventions.intent.trim() })
			            };
			            return [{ path: [group], value: section }];
			        }
			        case 'delegation':
			            // Always authored explicitly, in both directions. `true` is the user's
			            // consent (and what makes the panel write the host patch); `false` is a
			            // decision the runtime must be able to *see*, so the detector never
			            // mistakes a deliberate off for a broken on.
			            return [{ path: [group], value: { enabled: draft.delegation.enabled } }];
			        case 'tools': {
			            // Only departures from the documented default are authored, in either
			            // direction: `route` starts off, so switching it on stores `true`, while
			            // the other four start on and switching one off stores `false`. Returning
			            // a switch to its default therefore *removes* its key, which is what "back
			            // to default" means here — and what keeps a later change of the default
			            // effective.
			            const enabled = {};
			            for (const suffix of exports.REFLEX_TOOL_SUFFIXES) {
			                const value = draft.tools.enabled[suffix] ?? exports.TOOL_DEFAULT_ENABLED[suffix];
			                if (value !== exports.TOOL_DEFAULT_ENABLED[suffix])
			                    enabled[suffix] = value;
			            }
			            return [{ path: [group], value: { enabled } }];
			        }
			        case 'runtime':
			        default:
			            // The runtime group is four top-level fields in the Host schema, not a
			            // `runtime` block: writing `['runtime']` is refused as "not volatile".
			            return [
			                { path: ['toolPrefix'], value: present(draft.runtime.toolPrefix) ?? 'reflex_' },
			                present(draft.runtime.ledgerPath) === undefined
			                    ? { path: ['ledgerPath'] }
			                    : { path: ['ledgerPath'], value: draft.runtime.ledgerPath.trim() },
			                { path: ['pruneThreshold'], value: asNumber(draft.runtime.pruneThreshold) ?? 500 },
			                present(draft.runtime.calibrationPath) === undefined
			                    ? { path: ['calibrationPath'] }
			                    : { path: ['calibrationPath'], value: draft.runtime.calibrationPath.trim() }
			            ];
			    }
			}
			/** Whether two JSON-shaped values are equal, ignoring key order. */
			function sameValue(left, right) {
			    if (left === right)
			        return true;
			    if (Array.isArray(left) && Array.isArray(right)) {
			        return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
			    }
			    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
			        const leftKeys = Object.keys(left).sort();
			        const rightKeys = Object.keys(right).sort();
			        if (leftKeys.length !== rightKeys.length)
			            return false;
			        return leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
			    }
			    return false;
			}
			/**
			 * Diff two drafts into the path operations that turn the first into the second.
			 *
			 * Group granularity is deliberate: a group is dirty or it is not, and a dirty
			 * group is written in full to every schema path it authors, so one edit can
			 * never leave a half-written block behind and a blanked field simply stops being
			 * present in the value it sends. Every path emitted here is a path the Host
			 * declares volatile — `client-page.test.ts` checks that against the plugin's own
			 * schema, because addressing a group name the schema does not have (`runtime`)
			 * makes the Host refuse the whole write.
			 * @param original - the draft seeded from the Host.
			 * @param draft - the edited draft.
			 * @returns the ops to send, empty when nothing changed.
			 */
			function diffDraft(original, draft, user) {
			    const ops = [];
			    // The user layer this panel will replace. A group write is a whole-section
			    // value, so anything already stored there under a sibling key would be deleted
			    // by the save; those keys are merged back in below.
			    const authored = asRecord(user);
			    for (const group of exports.DRAFT_GROUPS) {
			        const before = groupWrites(original, group);
			        const after = groupWrites(draft, group);
			        if (sameValue(before, after))
			            continue;
			        for (const write of after) {
			            ops.push(write.value === undefined ? { op: 'unset', path: write.path } : { op: 'set', path: write.path, value: write.value });
			        }
			    }
			    // Unsets first, then the merged sets: an unset and a set never share a path,
			    // and keeping that order makes the emitted operation list stable for tests.
			    const ordered = [];
			    for (const write of ops)
			        if (write.op === 'unset')
			            ordered.push(write);
			    for (const write of ops)
			        if (write.op === 'set')
			            ordered.push(withPreservedSiblings(write, authored));
			    return ordered;
			}
			/**
			 * Fold the sibling keys a whole-section write does not own back into it.
			 *
			 * `path: ['routing']` with `{ enabled, models }` replaces the whole `routing`
			 * object, so a key this page never renders would silently disappear on the next
			 * unrelated save. Only the top level is merged: the page owns every declared
			 * field, and merging a nested key it does not know would need to know the shape.
			 *
			 * @param write - one `set` operation.
			 * @param authored - the raw user layer as the Host reported it.
			 * @returns the operation with foreign sibling keys preserved.
			 */
			function withPreservedSiblings(write, authored) {
			    if (write.path.length !== 1)
			        return write;
			    const [group] = write.path;
			    const existing = group === undefined ? undefined : authored[group];
			    const written = write.value;
			    if (existing === undefined || written === undefined)
			        return write;
			    if (written === null || typeof written !== 'object' || Array.isArray(written))
			        return write;
			    if (existing === null || typeof existing !== 'object' || Array.isArray(existing))
			        return write;
			    const owned = new Set(Object.keys(written));
			    const preserved = Object.fromEntries(Object.entries(existing).filter(([key]) => !owned.has(key)));
			    if (Object.keys(preserved).length === 0)
			        return write;
			    return { ...write, value: { ...preserved, ...written } };
			}
			/** Which groups of a draft differ from the seeded original. */
			function dirtyGroups(original, draft) {
			    return exports.DRAFT_GROUPS.filter((group) => !sameValue(groupWrites(original, group), groupWrites(draft, group)));
			}
			/** Append an empty virtual model to a draft. */
			function addPool(pools, modelId = '') {
			    return [...pools, { model: modelId, entries: [] }];
			}
			/** Remove one virtual model from a draft. */
			function removePool(pools, index) {
			    return pools.filter((_, position) => position !== index);
			}
			/** Append an empty candidate to one virtual model. */
			function addPoolEntry(pools, index) {
			    return pools.map((pool, position) => position === index ? { ...pool, entries: [...pool.entries, { provider: '', model: '', description: '', tags: '' }] } : pool);
			}
			/** Remove one candidate from one virtual model. */
			function removePoolEntry(pools, index, entry) {
			    return pools.map((pool, position) => position === index ? { ...pool, entries: pool.entries.filter((_, at) => at !== entry) } : pool);
			}
			/**
			 * Move one candidate within its pool, which is the pool's routing preference.
			 * @param pools - the pools to edit.
			 * @param index - pool position.
			 * @param entry - candidate position.
			 * @param delta - `-1` to promote, `1` to demote.
			 * @returns the next pools; the ends are no-ops.
			 */
			function movePoolEntry(pools, index, entry, delta) {
			    const target = entry + delta;
			    const pool = pools[index];
			    if (pool === undefined || target < 0 || target >= pool.entries.length)
			        return pools;
			    const entries = [...pool.entries];
			    const [moved] = entries.splice(entry, 1);
			    if (moved === undefined)
			        return pools;
			    entries.splice(target, 0, moved);
			    return pools.map((candidate, position) => (position === index ? { ...candidate, entries } : candidate));
			}
			/** Format an integer with thousands separators, without depending on ICU data. */
			function formatInteger(value) {
			    if (!Number.isFinite(value))
			        return '0';
			    const rounded = Math.round(value);
			    const sign = rounded < 0 ? '-' : '';
			    const digits = String(Math.abs(rounded));
			    let grouped = '';
			    for (let index = 0; index < digits.length; index += 1) {
			        if (index > 0 && (digits.length - index) % 3 === 0)
			            grouped += ',';
			        grouped += digits[index];
			    }
			    return sign + grouped;
			}
			/** Format a millisecond latency for a metric card. */
			function formatLatency(ms) {
			    if (!Number.isFinite(ms) || ms <= 0)
			        return '0 ms';
			    if (ms >= 100)
			        return `${Math.round(ms)} ms`;
			    return `${ms.toFixed(1)} ms`;
			}
			/** Format an estimated cost, keeping small numbers readable. */
			function formatUsd(value) {
			    if (!Number.isFinite(value) || value === 0)
			        return '$0';
			    if (value < 0.01)
			        return `$${value.toFixed(4)}`;
			    if (value < 1)
			        return `$${value.toFixed(3)}`;
			    return `$${value.toFixed(2)}`;
			}
			/** Format a 0–1 ratio as a percentage. */
			function formatPercent(ratio) {
			    if (!Number.isFinite(ratio))
			        return '0%';
			    return `${Math.round(ratio * 100)}%`;
			}
			/** Format one ledger timestamp as local `HH:MM:SS`. */
			function formatClock(iso) {
			    const at = new Date(iso);
			    if (Number.isNaN(at.getTime()))
			        return iso;
			    const pad = (part) => String(part).padStart(2, '0');
			    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
			}
			/** Copy key of one ledger type's display name. */
			function ledgerTypeKey(type) {
			    switch (type) {
			        case 'gate':
			            return 'typeGate';
			        case 'prune':
			            return 'typePrune';
			        case 'stagnation':
			            return 'typeStagnation';
			        case 'route':
			            return 'typeRoute';
			        case 'choice':
			            return 'typeChoice';
			        case 'model-route':
			            return 'typeModelRoute';
			        case 'effort-decision':
			            return 'typeEffort';
			        default:
			            return type;
			    }
			}
			/** Design-token name a decision level is drawn in. */
			function levelTone(level) {
			    switch (level) {
			        case 'off':
			            return '--dsw-alias-label-tertiary';
			        case 'minimal':
			        case 'low':
			            return '--dsw-alias-state-success-primary';
			        case 'medium':
			            return '--dsw-alias-brand-primary';
			        case 'high':
			            return '--dsw-alias-state-warn-primary';
			        case 'max':
			            return '--dsw-alias-state-error-primary';
			        default:
			            return '--dsw-alias-label-secondary';
			    }
			}
			/**
			 * Whether the snapshot says System One is degraded.
			 *
			 * Only an explicit `available: false` qualifies: a mock backend publishes no
			 * health block at all, and "no health" must never render as an outage.
			 * @param snapshot - the live snapshot.
			 * @returns the facts to show, or `undefined` when the backend is healthy/unknown.
			 */
			function systemOneDegraded(snapshot) {
			    const health = snapshot?.systemOne?.health;
			    if (health === undefined || health.available !== false)
			        return undefined;
			    return {
			        reason: typeof health.lastFailureReason === 'string' ? health.lastFailureReason : '',
			        consecutiveFailures: typeof health.consecutiveFailures === 'number' ? health.consecutiveFailures : 0,
			        ...(typeof health.lastFailureAt === 'string' && health.lastFailureAt.length > 0
			            ? { lastFailureAt: health.lastFailureAt }
			            : {})
			    };
			}
			/**
			 * Project one snapshot into the header status icon.
			 *
			 * State precedence is degradation → missing key → healthy: an unreachable
			 * backend is the strongest signal, a missing key is a warning, and everything
			 * else (including a backend that publishes no health) reads as healthy.
			 * @param snapshot - the live snapshot.
			 * @returns the icon state and its translated fragments, or `undefined` while
			 *   no snapshot has arrived.
			 */
			function panelStatus(snapshot) {
			    if (snapshot === null)
			        return undefined;
			    const routing = snapshot.routing ?? {};
			    const routingActive = routing.active === true;
			    const candidates = formatInteger(routing.candidates ?? 0);
			    const setting = snapshot.effort?.setting;
			    const effortUnset = setting === null || setting === undefined || setting === '';
			    const backend = snapshot.systemOne;
			    const backendName = String(backend?.active ?? backend?.backend ?? '');
			    const apiKeyEnv = backend?.apiKeyEnv;
			    const degraded = backend?.health !== undefined && backend.health.available === false;
			    const missingKey = !degraded && backend?.apiKeyPresent === false;
			    const state = degraded ? 'error' : missingKey ? 'warn' : 'ok';
			    const tone = state === 'error'
			        ? '--dsw-alias-state-error-primary'
			        : state === 'warn'
			            ? '--dsw-alias-state-warn-primary'
			            : '--dsw-alias-state-success-primary';
			    const routingLine = routingActive
			        ? { key: 'chipRoutingTitleActive', values: { candidates } }
			        : { key: 'chipRoutingTitleInactive' };
			    const effortLine = effortUnset
			        ? { key: 'chipEffortTitleUnset' }
			        : { key: 'chipEffortTitleSet', values: { level: String(setting) } };
			    const backendLine = apiKeyEnv === undefined
			        ? { key: 'chipBackendTitleUnsetKey', values: { backend: backendName } }
			        : backend?.apiKeyPresent === true
			            ? { key: 'chipBackendTitle', values: { backend: backendName, env: apiKeyEnv } }
			            : { key: 'chipBackendTitleMissing', values: { backend: backendName, env: apiKeyEnv } };
			    const backendFragment = degraded
			        ? { key: 'statusBackendDegraded', values: { backend: backendName } }
			        : missingKey
			            ? { key: 'statusBackendMissingKey', values: { backend: backendName } }
			            : { key: 'statusBackendOk', values: { backend: backendName } };
			    return {
			        state,
			        tone,
			        routing: routingActive
			            ? { key: 'statusRoutingActive', values: { candidates } }
			            : { key: 'statusRoutingInactive' },
			        effort: effortUnset ? { key: 'statusEffortUnset' } : { key: 'statusEffortSet', values: { level: String(setting) } },
			        backend: backendFragment,
			        lines: [routingLine, effortLine, backendLine]
			    };
			}
			/**
			 * Project ledger rows for the table.
			 * @param snapshot - the live snapshot.
			 * @returns rows, newest last, exactly as the Host ordered them.
			 */
			function ledgerRows(snapshot) {
			    const recent = snapshot?.ledger?.recent ?? [];
			    return recent.map((entry) => {
			        const type = String(entry.type ?? '');
			        const parts = [];
			        if (entry.action !== undefined)
			            parts.push(entry.action);
			        if (entry.target !== undefined)
			            parts.push(entry.target);
			        if (entry.level !== undefined)
			            parts.push(entry.applied === null ? `${entry.level} → cleared` : entry.level);
			        if (entry.passed !== undefined)
			            parts.push(entry.passed ? 'pass' : 'fail');
			        if (entry.isStuck === true)
			            parts.push('stuck');
			        if (entry.shadow === true)
			            parts.push('shadow');
			        if (entry.skipReason !== undefined)
			            parts.push(entry.skipReason);
			        if (entry.reason !== undefined)
			            parts.push(entry.reason);
			        return {
			            id: String(entry.id ?? ''),
			            clock: formatClock(String(entry.at ?? '')),
			            type,
			            typeKey: ledgerTypeKey(type),
			            backend: String(entry.backend ?? ''),
			            latency: formatLatency(entry.latencyMs ?? 0),
			            tokens: formatInteger(entry.tokensSaved ?? 0),
			            detail: parts.join(' · '),
			            tone: entry.level === undefined ? '--dsw-alias-label-secondary' : levelTone(entry.level)
			        };
			    });
			}
			/**
			 * Metrics the overview tab shows.
			 * @param snapshot - the live snapshot.
			 * @returns the cards, in presentation order.
			 */
			function overviewMetrics(snapshot) {
			    const summary = snapshot?.ledger?.summary ?? {};
			    const routingCalls = (summary.callsByType ?? {})['model-route'] ?? 0;
			    return [
			        { id: 'total', labelKey: 'ledgerTotal', value: formatInteger(summary.totalCalls ?? 0) },
			        { id: 'tokens', labelKey: 'ledgerTokens', value: formatInteger(summary.totalTokensSaved ?? 0) },
			        { id: 'cost', labelKey: 'ledgerCost', value: formatUsd(summary.estimatedCostSavedUsd ?? 0) },
			        { id: 'latency', labelKey: 'ledgerLatency', value: formatLatency(summary.avgLatencyMs ?? 0) },
			        {
			            id: 'gates',
			            labelKey: 'ledgerGates',
			            value: `${formatInteger(summary.gatePassedCount ?? 0)} / ${formatInteger(summary.gateFailedCount ?? 0)}`
			        },
			        { id: 'stagnation', labelKey: 'ledgerStagnation', value: formatInteger(summary.stagnationAlerts ?? 0) },
			        { id: 'routing', labelKey: 'ledgerRouting', value: formatInteger(routingCalls) },
			        { id: 'effort', labelKey: 'effortDecisions', value: formatInteger(snapshot?.effort?.decisions ?? 0) }
			    ];
			}
			/**
			 * Pick the settings namespace this panel edits.
			 *
			 * The Host chooses its own namespace (a deployment may nest or rename it), so
			 * candidates are matched by exact name first and then by suffix, and `undefined`
			 * is returned rather than a guess when nothing matches.
			 * @param namespaces - every namespace the Host serves.
			 * @param candidates - preferred names, most specific first.
			 * @returns the resolved namespace, or `undefined`.
			 */
			function resolveReflexNamespace(namespaces, candidates) {
			    for (const candidate of candidates) {
			        if (namespaces.includes(candidate))
			            return candidate;
			    }
			    for (const candidate of candidates) {
			        const suffix = `.${candidate}`;
			        const match = namespaces.find((ns) => ns.endsWith(suffix));
			        if (match !== undefined)
			            return match;
			    }
			    return undefined;
			}
			/**
			 * Substitute `{name}` placeholders in a copy string.
			 * @param template - the copy string.
			 * @param values - placeholder values.
			 * @returns the rendered string.
			 */
			function interpolate(template, values) {
			    return template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
			}

		},
		"store": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.PanelStore = exports.DEFAULT_POLL_MS = exports.DELEGATION_PATH = exports.CLEAR_PATH = exports.SNAPSHOT_PATH = exports.PANEL_TABS = void 0;
			exports.draftFromForm = draftFromForm;
			/**
			 * Stateful core of the Reflex settings page.
			 *
			 * One store owns both halves of the page: the live metrics it polls from the
			 * Host's `/api/dsh-reflex/panel` route, and the editable draft it derives from
			 * the Host settings form for the resolved namespace. It is deliberately free of
			 * React and of any browser global — `fetch`, `configForms`, and the clock are
			 * injected — so the page's state machine can be driven by `node --test`.
			 *
			 * Two rules shape it:
			 *
			 * - **The Host stays the fact source.** The draft is re-seeded from the Host's
			 *   section whenever the user has no unsaved edit, so a concurrent settings
			 *   change elsewhere in the GUI cannot be silently overwritten by a stale form.
			 * - **Writes are fenced.** Every save carries the revision the draft was read
			 *   at, and a refused or failed write is reported instead of being retried
			 *   blindly.
			 *
			 * @module dsh-reflex/client/store
			 */
			const panel_1 = require("./panel");
			/** Every page, in navigation order. */
			exports.PANEL_TABS = [
			    'overview',
			    'routing',
			    'effort',
			    'backend',
			    'interventions',
			    'tools',
			    'ledger',
			    'guide'
			];
			/** Route of the live snapshot, relative to {@link PanelStoreOptions.basePath}. */
			exports.SNAPSHOT_PATH = '/dsh-reflex/api/panel';
			/** Route that clears the ledger. */
			exports.CLEAR_PATH = '/dsh-reflex/api/ledger/clear?confirm=clear';
			/**
			 * Route that writes the host `modelSelection` switch.
			 *
			 * The `confirm=delegation` query is the host's own requirement: this is the only
			 * request of the page that edits a file outside the plugin's settings section,
			 * so it may not be fired by an accidental GET.
			 */
			exports.DELEGATION_PATH = '/dsh-reflex/api/delegation?confirm=delegation';
			/** Default poll period, in milliseconds. */
			exports.DEFAULT_POLL_MS = 4000;
			/** Read a nested error message out of an unknown failure. */
			function messageOf(error) {
			    if (error instanceof Error)
			        return error.message;
			    return typeof error === 'string' ? error : 'unknown error';
			}
			/**
			 * Seed a draft from one settings section.
			 *
			 * The Host reports two layers: `value` (effective, with the profile's compose
			 * base already folded in) and `base` (that compose base on its own). A
			 * deployment configured in `cordis.patch.yml` — which is how a patch-layer user
			 * configures this plugin — puts nothing in `value` itself, so reading only
			 * `value` would show an empty page for a running configuration. `base` is the
			 * fallback for every group the panel owns; `routing` merges per virtual model so
			 * a pool added in one layer is not hidden by the other.
			 *
			 * @param form - the settings form snapshot.
			 * @returns the draft to edit.
			 */
			function draftFromForm(form) {
			    return (0, panel_1.draftFromLayers)(form.value, form.base);
			}
			/**
			 * Observable state of the Reflex settings page.
			 *
			 * Immutable snapshots, one listener list: the React layer subscribes through
			 * `useSyncExternalStore`-shaped calls, which need a stable reference per change.
			 */
			class PanelStore {
			    #options;
			    #basePath;
			    #now;
			    #setTimer;
			    #clearTimer;
			    #listeners = new Set();
			    #state;
			    #timer;
			    #disposed = false;
			    #formUnsubscribe;
			    /**
			     * @param options - the settings form, a fetch implementation, and timing seams.
			     */
			    constructor(options) {
			        this.#options = options;
			        this.#basePath = options.basePath ?? '';
			        this.#now = options.now ?? (() => Date.now());
			        this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
			        this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
			        const form = options.form.getSnapshot();
			        const seeded = draftFromForm(form);
			        this.#state = {
			            tab: 'overview',
			            phase: 'idle',
			            snapshot: null,
			            error: null,
			            fetchedAt: null,
			            configStatus: form.status,
			            writable: form.writable,
			            revision: form.revision,
			            original: seeded,
			            draft: seeded,
			            errors: [],
			            saving: false,
			            notice: null,
			            noticeValues: null,
			            confirmingClear: false,
			            delegationWrite: null
			        };
			    }
			    /** @returns the current immutable state. */
			    getState() {
			        return this.#state;
			    }
			    /**
			     * Observe state replacements.
			     * @param listener - invoked after each change.
			     * @returns the disposer removing this listener.
			     */
			    subscribe(listener) {
			        this.#listeners.add(listener);
			        return () => {
			            this.#listeners.delete(listener);
			        };
			    }
			    /** Start the polling loop and follow the Host settings section. */
			    start() {
			        if (this.#disposed)
			            return;
			        this.#formUnsubscribe = this.#options.form.subscribe(() => {
			            this.#adoptForm();
			        });
			        void this.refresh();
			    }
			    /** Stop polling and release the form subscription. */
			    dispose() {
			        this.#disposed = true;
			        if (this.#timer !== undefined) {
			            this.#clearTimer(this.#timer);
			            this.#timer = undefined;
			        }
			        this.#formUnsubscribe?.();
			        this.#formUnsubscribe = undefined;
			    }
			    /**
			     * Read the live snapshot, then schedule the next read.
			     * @returns settlement once the read has been folded into the state.
			     */
			    async refresh() {
			        if (this.#disposed)
			            return;
			        this.#set({ phase: this.#state.snapshot === null ? 'loading' : this.#state.phase, error: null });
			        try {
			            const response = await this.#options.fetch(`${this.#basePath}${exports.SNAPSHOT_PATH}`);
			            if (!response.ok)
			                throw new Error(`HTTP ${String(response.status)}`);
			            const body = (await response.json());
			            if (this.#disposed)
			                return;
			            const dirty = (0, panel_1.dirtyGroups)(this.#state.original, this.#state.draft).length > 0;
			            if (!dirty) {
			                const enhanced = (0, panel_1.draftFromSnapshot)(body, this.#state.draft);
			                this.#set({
			                    phase: 'ready',
			                    snapshot: body,
			                    fetchedAt: this.#now(),
			                    original: enhanced,
			                    draft: enhanced,
			                    error: null
			                });
			            }
			            else {
			                this.#set({ phase: 'ready', snapshot: body, fetchedAt: this.#now(), error: null });
			            }
			        }
			        catch (error) {
			            if (this.#disposed)
			                return;
			            this.#set({ phase: 'error', error: messageOf(error) });
			        }
			        finally {
			            this.#schedule();
			        }
			    }
			    /**
			     * Switch page.
			     * @param tab - the page to show.
			     */
			    setTab(tab) {
			        if (this.#state.tab === tab)
			            return;
			        this.#set({ tab });
			    }
			    /**
			     * Edit the draft in place.
			     * @param mutate - receives the current draft; returns the next one.
			     */
			    edit(mutate) {
			        const draft = mutate(this.#state.draft);
			        const { errors } = (0, panel_1.validateDraft)(draft);
			        this.#set({ draft, errors, notice: null, noticeValues: null });
			    }
			    /**
			     * Edit the routing draft's model pools.
			     * @param mutate - receives the current pools; returns the next ones.
			     */
			    editPools(mutate) {
			        this.edit((draft) => ({ ...draft, routing: { ...draft.routing, pools: mutate(draft.routing.pools) } }));
			    }
			    /** Append an empty virtual model. */
			    addPool() {
			        this.editPools((pools) => (0, panel_1.addPool)(pools));
			    }
			    /**
			     * Remove one virtual model.
			     * @param index - its position.
			     */
			    removePool(index) {
			        this.editPools((pools) => (0, panel_1.removePool)(pools, index));
			    }
			    /**
			     * Append an empty candidate to one pool.
			     * @param index - the pool's position.
			     */
			    addCandidate(index) {
			        this.editPools((pools) => (0, panel_1.addPoolEntry)(pools, index));
			    }
			    /**
			     * Remove one candidate.
			     * @param index - the pool's position.
			     * @param entry - the candidate's position.
			     */
			    removeCandidate(index, entry) {
			        this.editPools((pools) => (0, panel_1.removePoolEntry)(pools, index, entry));
			    }
			    /**
			     * Reorder one candidate, which is the pool's routing preference.
			     * @param index - the pool's position.
			     * @param entry - the candidate's position.
			     * @param delta - `-1` to promote, `1` to demote.
			     */
			    moveCandidate(index, entry, delta) {
			        this.editPools((pools) => (0, panel_1.movePoolEntry)(pools, index, entry, delta));
			    }
			    /** Discard unsaved edits and re-seed from the Host. */
			    reset() {
			        const seeded = draftFromForm(this.#options.form.getSnapshot());
			        this.#set({ draft: seeded, original: seeded, errors: [], notice: null, noticeValues: null });
			    }
			    /**
			     * Write the draft's changed groups to the Host.
			     *
			     * A no-op when nothing changed; a refusal (rather than a throw) when the draft
			     * is invalid or the document is read-only, so the page can show the reason
			     * without a network round trip.
			     * @returns whether the Host accepted the write.
			     */
			    async save() {
			        const { draft, original, revision } = this.#state;
			        // The button is disabled for a read-only document; refusing here as well keeps
			        // every other caller of `save()` (a keyboard shortcut, a future auto-save)
			        // from writing a document the Host said it will not accept.
			        if (!this.#state.writable)
			            return false;
			        const validation = (0, panel_1.validateDraft)(draft);
			        if (!validation.ok) {
			            this.#set({ errors: validation.errors, notice: null, noticeValues: null });
			            return false;
			        }
			        // The raw user layer is passed so a group write keeps the keys this page
			        // never rendered instead of replacing the whole section with them dropped.
			        const ops = (0, panel_1.diffDraft)(original, draft, this.#options.form.getSnapshot().user);
			        if (ops.length === 0) {
			            this.#set({ errors: [], notice: 'clean', noticeValues: null });
			            return true;
			        }
			        this.#set({ saving: true, errors: [], notice: null, noticeValues: null });
			        try {
			            const accepted = await this.#options.form.mutate(ops, revision);
			            if (this.#disposed)
			                return accepted;
			            if (!accepted) {
			                this.#set({ saving: false, notice: 'confirmRejected', noticeValues: null });
			                return false;
			            }
			            const seeded = draftFromForm(this.#options.form.getSnapshot());
			            this.#set({ saving: false, original: seeded, draft: seeded, notice: 'saved', noticeValues: null });
			            void this.refresh();
			            return true;
			        }
			        catch (error) {
			            if (this.#disposed)
			                return false;
			            this.#set({ saving: false, error: messageOf(error), notice: null, noticeValues: null });
			            return false;
			        }
			    }
			    /**
			     * Clear the Host ledger, asking for confirmation first.
			     *
			     * The first call only arms the confirmation, because the request also deletes
			     * the ledger's JSONL sink; the second, unchanged-state call performs it.
			     * @returns whether a clear was actually attempted.
			     */
			    async clearLedger() {
			        if (!this.#state.confirmingClear) {
			            this.#set({ confirmingClear: true, notice: null, noticeValues: null });
			            return false;
			        }
			        this.#set({ confirmingClear: false });
			        try {
			            const response = await this.#options.fetch(`${this.#basePath}${exports.CLEAR_PATH}`, { method: 'POST' });
			            if (!response.ok)
			                throw new Error(`HTTP ${String(response.status)}`);
			            const body = (await response.json());
			            if (this.#disposed)
			                return true;
			            this.#set({ notice: 'ledgerCleared', noticeValues: { count: String(body.cleared ?? 0) } });
			            await this.refresh();
			            return true;
			        }
			        catch (error) {
			            if (this.#disposed)
			                return false;
			            this.#set({ error: messageOf(error), notice: null, noticeValues: null });
			            return false;
			        }
			    }
			    /**
			     * Write the host `modelSelection` switch, then refresh the live facts.
			     *
			     * Called by the toggle *after* the settings save that records the consent, so
			     * the two writes are separate: the settings document says "the user agreed",
			     * and this request edits the profile patch. A failure here leaves the consent
			     * recorded and reports the host's reason, rather than silently un-ticking a
			     * box the user did press.
			     * @returns whether the host accepted the write.
			     */
			    async enableDelegation() {
			        this.#set({ delegationWrite: null, errors: [] });
			        try {
			            const response = await this.#options.fetch(`${this.#basePath}${exports.DELEGATION_PATH}`, { method: 'POST' });
			            const body = (await response.json().catch(() => ({})));
			            if (this.#disposed)
			                return false;
			            if (!response.ok || body.ok !== true) {
			                this.#set({
			                    delegationWrite: {
			                        outcome: 'refused',
			                        restartRequired: false,
			                        ...(body.detail === undefined ? {} : { reason: body.detail })
			                    }
			                });
			                return false;
			            }
			            this.#set({
			                delegationWrite: {
			                    outcome: String(body.outcome ?? 'unknown'),
			                    restartRequired: body.restartRequired === true,
			                    ...(body.path === undefined ? {} : { path: body.path }),
			                    ...(body.reason === undefined ? {} : { reason: body.reason })
			                }
			            });
			            await this.refresh();
			            return true;
			        }
			        catch (error) {
			            if (this.#disposed)
			                return false;
			            this.#set({ delegationWrite: { outcome: 'refused', restartRequired: false, reason: messageOf(error) } });
			            return false;
			        }
			    }
			    /** Disarm a pending clear confirmation. */
			    cancelClear() {
			        if (this.#state.confirmingClear)
			            this.#set({ confirmingClear: false });
			    }
			    /** Fold a Host settings-section change into the state. */
			    #adoptForm() {
			        if (this.#disposed)
			            return;
			        const form = this.#options.form.getSnapshot();
			        const dirty = (0, panel_1.dirtyGroups)(this.#state.original, this.#state.draft).length > 0;
			        if (dirty) {
			            // Keep the user's work, but follow the revision so the next write fences
			            // against what the Host actually holds.
			            this.#set({ configStatus: form.status, writable: form.writable, revision: form.revision });
			            return;
			        }
			        const seeded = draftFromForm(form);
			        this.#set({
			            configStatus: form.status,
			            writable: form.writable,
			            revision: form.revision,
			            original: seeded,
			            draft: seeded,
			            errors: []
			        });
			    }
			    /** Schedule the next poll, unless polling is disabled. */
			    #schedule() {
			        const interval = this.#options.pollIntervalMs ?? exports.DEFAULT_POLL_MS;
			        if (this.#disposed || interval <= 0)
			            return;
			        if (this.#timer !== undefined)
			            this.#clearTimer(this.#timer);
			        this.#timer = this.#setTimer(() => {
			            this.#timer = undefined;
			            void this.refresh();
			        }, interval);
			    }
			    /** Replace state and notify. */
			    #set(patch) {
			        if (this.#disposed)
			            return;
			        this.#state = { ...this.#state, ...patch };
			        for (const listener of this.#listeners)
			            listener();
			    }
			}
			exports.PanelStore = PanelStore;

		},
		"view": function (module, exports, require) {
			"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.createPanelComponent = createPanelComponent;
			/**
			 * React layer of the Reflex settings page.
			 *
			 * The component is created from the plugin's own context, so it reaches the
			 * settings provider and `fetch` through the closure instead of importing any
			 * other plugin — the client bundle purity gate forbids the latter and a
			 * settings page has no business owning a transport of its own.
			 *
			 * Only `react` is required; every visual value is a DSH design token with a
			 * literal fallback, so the page inherits the host theme (including dark mode)
			 * without shipping a stylesheet.
			 *
			 * @module dsh-reflex/client/view
			 */
			const react_1 = require("react");
			const panel_1 = require("./panel");
			const store_1 = require("./store");
			const markdown_1 = require("./markdown");
			const field_guide_1 = require("./field-guide");
			/** Token value with a literal fallback, so an unthemed host still renders. */
			function token(name, fallback) {
			    return `var(${name}, ${fallback})`;
			}
			/** Style kit: one place for every visual value the page uses. */
			const S = {
			    root: {
			        display: 'flex',
			        flexDirection: 'column',
			        gap: '14px',
			        padding: '2px',
			        color: token('--dsw-alias-label-primary', '#e6e6e6'),
			        fontSize: '13px',
			        lineHeight: '1.5'
			    },
			    header: { display: 'flex', flexDirection: 'column', gap: '6px' },
			    banner: {
			        display: 'flex',
			        alignItems: 'center',
			        gap: '10px',
			        flexWrap: 'wrap',
			        border: `1px solid ${token('--dsw-alias-state-warn-primary', '#fbbf24')}`,
			        borderRadius: '6px',
			        padding: '8px 10px',
			        background: token('--dsw-alias-bg-layer-2', 'rgba(251,191,36,.08)'),
			        color: token('--dsw-alias-state-warn-primary', '#fbbf24'),
			        fontSize: '12px'
			    },
			    titleRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap', minWidth: 0 },
			    title: { fontSize: '15px', fontWeight: 600, margin: 0, flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
			    subtitle: { color: token('--dsw-alias-label-tertiary', '#8a8a8a'), fontSize: '12px' },
			    /**
			     * The one compact status icon.
			     *
			     * A fixed 18×18 target keeps the title row's geometry independent of the copy
			     * inside the tooltip; `flex: 0 0 auto` and `marginLeft: auto` pin it to the
			     * right without ever letting it push the title into a wrap.
			     */
			    statusButton: {
			        appearance: 'none',
			        flex: '0 0 auto',
			        width: '18px',
			        height: '18px',
			        minWidth: '18px',
			        minHeight: '18px',
			        padding: 0,
			        marginLeft: 'auto',
			        borderRadius: '999px',
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.18)')}`,
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.04)'),
			        display: 'inline-flex',
			        alignItems: 'center',
			        justifyContent: 'center',
			        cursor: 'help',
			        font: 'inherit',
			        lineHeight: 1
			    },
			    statusGlyph: { fontSize: '11px', fontWeight: 700, lineHeight: 1 },
			    chip: {
			        display: 'inline-flex',
			        alignItems: 'center',
			        gap: '4px',
			        padding: '1px 8px',
			        borderRadius: '999px',
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.12)')}`,
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.04)'),
			        fontSize: '11px',
			        whiteSpace: 'nowrap'
			    },
			    tabs: {
			        display: 'flex',
			        gap: '2px',
			        borderBottom: `1px solid ${token('--dsw-alias-border-l1', 'rgba(255,255,255,.08)')}`,
			        flexWrap: 'wrap'
			    },
			    tab: {
			        appearance: 'none',
			        border: 'none',
			        background: 'transparent',
			        color: token('--dsw-alias-label-secondary', '#b4b4b4'),
			        padding: '6px 10px',
			        fontSize: '12px',
			        cursor: 'pointer',
			        borderBottom: '2px solid transparent'
			    },
			    tabActive: {
			        color: token('--dsw-alias-label-primary', '#e6e6e6'),
			        borderBottom: `2px solid ${token('--dsw-alias-brand-primary', '#4d6bfe')}`
			    },
			    card: {
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.1)')}`,
			        borderRadius: '8px',
			        background: token('--dsw-alias-bg-layer-1', 'rgba(255,255,255,.03)'),
			        padding: '12px'
			    },
			    cardTitle: { fontSize: '12px', fontWeight: 600, margin: '0 0 10px 0', color: token('--dsw-alias-label-secondary', '#b4b4b4') },
			    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: '8px' },
			    /**
			     * One switch per row, wide enough for real prose.
			     *
			     * A grid of narrow cards would wrap each explanation into a column of three
			     * words, which is how the old page ended up unreadable.
			     */
			    toolList: { display: 'flex', flexDirection: 'column', gap: '10px' },
			    toolRow: {
			        display: 'flex',
			        flexDirection: 'column',
			        gap: '3px',
			        padding: '8px 10px',
			        border: `1px solid ${token('--dsw-alias-border-l3', 'rgba(255,255,255,.08)')}`,
			        borderRadius: '6px',
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.02)')
			    },
			    toolHead: { display: 'flex', alignItems: 'center', gap: '8px' },
			    toolWhat: { fontSize: '12px', color: token('--dsw-alias-label-secondary', '#b4b4b4') },
			    toolActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			    metric: {
			        border: `1px solid ${token('--dsw-alias-border-l3', 'rgba(255,255,255,.08)')}`,
			        borderRadius: '6px',
			        padding: '8px 10px',
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.02)'),
			        display: 'flex',
			        flexDirection: 'column',
			        gap: '2px'
			    },
			    metricLabel: { fontSize: '11px', color: token('--dsw-alias-label-tertiary', '#8a8a8a') },
			    metricValue: { fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
			    field: { display: 'flex', flexDirection: 'column', gap: '4px' },
			    fieldRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' },
			    labelRow: { display: 'flex', alignItems: 'flex-start', gap: '6px' },
			    fieldLabel: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 auto', minWidth: 0 },
			    label: { fontSize: '11px', color: token('--dsw-alias-label-tertiary', '#8a8a8a') },
			    hint: { fontSize: '11px', color: token('--dsw-alias-label-caption', '#777') },
			    helpButton: {
			        appearance: 'none',
			        flex: '0 0 auto',
			        width: '16px',
			        height: '16px',
			        padding: 0,
			        marginTop: '1px',
			        borderRadius: '999px',
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.12)')}`,
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.05)'),
			        color: token('--dsw-alias-label-tertiary', '#8a8a8a'),
			        fontSize: '10px',
			        lineHeight: '1',
			        cursor: 'help'
			    },
			    helpText: {
			        display: 'block',
			        fontSize: '11px',
			        lineHeight: '1.5',
			        color: token('--dsw-alias-label-caption', '#777'),
			        maxWidth: '560px'
			    },
			    // Visually hidden but still in the accessibility tree, so `aria-describedby`
			    // reads the same text before the disclosure is expanded.
			    helpSrOnly: {
			        position: 'absolute',
			        width: '1px',
			        height: '1px',
			        padding: 0,
			        margin: '-1px',
			        overflow: 'hidden',
			        clip: 'rect(0 0 0 0)',
			        whiteSpace: 'nowrap',
			        border: 0
			    },
			    paragraph: { margin: 0, fontSize: '12px', lineHeight: '1.6' },
			    input: {
			        width: '100%',
			        boxSizing: 'border-box',
			        padding: '5px 8px',
			        fontSize: '12px',
			        color: token('--dsw-alias-label-primary', '#e6e6e6'),
			        background: token('--dsw-alias-bg-layer-3', 'rgba(0,0,0,.2)'),
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.12)')}`,
			        borderRadius: '6px',
			        outline: 'none'
			    },
			    button: {
			        appearance: 'none',
			        padding: '4px 10px',
			        fontSize: '12px',
			        cursor: 'pointer',
			        color: token('--dsw-alias-label-primary', '#e6e6e6'),
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.05)'),
			        border: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.12)')}`,
			        borderRadius: '6px'
			    },
			    buttonPrimary: {
			        color: token('--dsw-alias-label-primary-inverted', '#111827'),
			        background: token('--dsw-alias-button-primary-fill', '#f9fafb'),
			        border: `1px solid ${token('--dsw-alias-button-primary-fill', '#f9fafb')}`
			    },
			    buttonDanger: {
			        color: token('--dsw-alias-state-error-primary', '#f87171'),
			        border: `1px solid ${token('--dsw-alias-state-error-tertiary', 'rgba(248,113,113,.4)')}`
			    },
			    buttonSmall: { padding: '1px 6px', fontSize: '11px', lineHeight: '1.4' },
			    row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			    actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
			    table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
			    th: {
			        textAlign: 'left',
			        padding: '4px 6px',
			        color: token('--dsw-alias-label-tertiary', '#8a8a8a'),
			        fontWeight: 500,
			        borderBottom: `1px solid ${token('--dsw-alias-border-l2', 'rgba(255,255,255,.1)')}`
			    },
			    td: {
			        padding: '4px 6px',
			        borderBottom: `1px solid ${token('--dsw-alias-border-l4', 'rgba(255,255,255,.05)')}`,
			        verticalAlign: 'top'
			    },
			    pool: {
			        border: `1px solid ${token('--dsw-alias-border-l3', 'rgba(255,255,255,.08)')}`,
			        borderRadius: '6px',
			        padding: '10px',
			        display: 'flex',
			        flexDirection: 'column',
			        gap: '8px',
			        background: token('--dsw-alias-bg-layer-2', 'rgba(255,255,255,.02)')
			    },
			    candidateCard: {
			        border: `1px solid ${token('--dsw-alias-border-l3', 'rgba(255,255,255,.08)')}`,
			        borderRadius: '6px',
			        padding: '8px 10px',
			        background: token('--dsw-alias-bg-layer-1', 'rgba(255,255,255,.03)'),
			        display: 'flex',
			        flexDirection: 'column',
			        gap: '6px'
			    },
			    candidateRow1: {
			        display: 'flex',
			        gap: '8px',
			        alignItems: 'center',
			        width: '100%'
			    },
			    candidateRow2: {
			        display: 'flex',
			        gap: '8px',
			        alignItems: 'center',
			        width: '100%'
			    },
			    entryRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'nowrap', width: '100%' },
			    errors: {
			        border: `1px solid ${token('--dsw-alias-state-error-tertiary', 'rgba(248,113,113,.4)')}`,
			        borderRadius: '6px',
			        padding: '8px 10px',
			        color: token('--dsw-alias-state-error-primary', '#f87171'),
			        fontSize: '12px'
			    },
			    notice: { fontSize: '12px', color: token('--dsw-alias-state-success-primary', '#4ade80') },
			    mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
			    empty: { color: token('--dsw-alias-label-dimmed', '#6b6b6b'), fontSize: '12px', padding: '6px 0' },
			    swatch: { display: 'inline-block', width: '6px', height: '6px', borderRadius: '2px', background: 'currentColor', marginRight: '5px' }
			};
			/** One read-only metric card. */
			function Metric(props) {
			    return (0, react_1.createElement)('div', { style: S.metric }, (0, react_1.createElement)('span', { style: S.metricLabel }, props.label), (0, react_1.createElement)('span', { style: S.metricValue }, props.value));
			}
			/** A titled card. */
			function Card(props) {
			    return (0, react_1.createElement)('section', { style: S.card }, (0, react_1.createElement)('h4', { style: S.cardTitle }, props.title), props.children);
			}
			/** A button. */
			function Button(props) {
			    const style = {
			        ...S.button,
			        ...(props.kind === 'primary' ? S.buttonPrimary : {}),
			        ...(props.kind === 'danger' ? S.buttonDanger : {}),
			        ...(props.small === true ? S.buttonSmall : {}),
			        ...(props.disabled === true ? { opacity: 0.5, cursor: 'not-allowed' } : {})
			    };
			    return (0, react_1.createElement)('button', {
			        type: 'button',
			        style,
			        disabled: props.disabled === true,
			        title: props.title ?? props.label,
			        onClick: props.onClick
			    }, props.label);
			}
			/** A text input bound to a draft field. */
			function TextInput(props) {
			    return (0, react_1.createElement)('input', {
			        type: 'text',
			        style: { ...S.input, ...(props.mono === true ? S.mono : {}) },
			        value: props.value,
			        placeholder: props.placeholder ?? '',
			        disabled: props.disabled === true,
			        onChange: (event) => {
			            props.onChange(event.target.value);
			        }
			    });
			}
			/** A select bound to a draft field. */
			function Select(props) {
			    return (0, react_1.createElement)('select', {
			        style: S.input,
			        value: props.value,
			        disabled: props.disabled === true,
			        onChange: (event) => {
			            props.onChange(event.target.value);
			        }
			    }, props.options.map((option) => (0, react_1.createElement)('option', { key: option.value, value: option.value }, option.label)));
			}
			/**
			 * One labelled form field with an optional `(?)` disclosure.
			 *
			 * Accessibility contract: the explanation lives in the DOM as a `role="note"`
			 * element and is referenced by `aria-describedby`, so a screen reader reaches
			 * it without any pointer. The `(?)` itself is a native `<button>`: Tab focuses
			 * it and Enter/Space toggles the visible copy, while the native `title` remains
			 * as a fallback. The note starts visually hidden (not `display:none`), which
			 * keeps it readable before expansion.
			 */
			function Field(props) {
			    const [open, setOpen] = (0, react_1.useState)(false);
			    const helpId = props.helpId ?? (props.path === undefined ? undefined : `reflex-help-${props.path.replace(/[^A-Za-z0-9_-]/g, '-')}`);
			    const hasHelp = props.help !== undefined && props.help.length > 0 && helpId !== undefined;
			    const control = props.checkbox === undefined
			        ? (0, react_1.createElement)('label', { style: S.fieldLabel }, (0, react_1.createElement)('span', { style: S.label }, props.label), props.children)
			        : (0, react_1.createElement)('label', { style: { ...S.row, flex: '1 1 auto', minWidth: 0 } }, (0, react_1.createElement)('input', {
			            type: 'checkbox',
			            checked: props.checkbox.checked,
			            disabled: props.checkbox.disabled === true,
			            onChange: (event) => {
			                props.checkbox?.onChange(event.target.checked);
			            }
			        }), (0, react_1.createElement)('span', { style: { fontSize: '12px' } }, props.label));
			    return (0, react_1.createElement)('div', { style: S.field, ...(props.path === undefined ? {} : { 'data-reflex-path': props.path }) }, (0, react_1.createElement)('div', { style: S.labelRow }, control, hasHelp
			        ? (0, react_1.createElement)('button', {
			            type: 'button',
			            style: S.helpButton,
			            'aria-label': props.helpLabel ?? props.label,
			            'aria-describedby': helpId,
			            'aria-expanded': open,
			            'aria-controls': helpId,
			            title: props.help,
			            onClick: () => {
			                setOpen((previous) => !previous);
			            }
			        }, '?')
			        : null), hasHelp ? (0, react_1.createElement)('span', { id: helpId, role: 'note', style: open ? S.helpText : S.helpSrOnly }, props.help) : null, props.hint === undefined ? null : (0, react_1.createElement)('span', { style: S.hint }, props.hint));
			}
			/**
			 * A `Field` whose label, example value and `(?)` copy come from the field guide.
			 *
			 * Callers pass the Host schema path, so the label/placeholder/help triple cannot
			 * drift between the page and the guide table. Dynamic families (tool switches,
			 * intervention capabilities) supply their own label and help text and use the
			 * wildcard row for the rest.
			 */
			function GuidedField(props) {
			    const family = props.path.split('.').slice(0, -1).join('.');
			    const guide = (0, field_guide_1.guideFor)(props.path) ?? (family.length === 0 ? undefined : (0, field_guide_1.templateGuideFor)(family));
			    const label = props.label ?? (guide?.labelKey === undefined ? props.path : props.t(guide.labelKey));
			    const help = props.help ?? (guide === undefined ? '' : props.t(guide.helpKey));
			    // A component rendered through `h(GuidedField, props)` arrives with an empty
			    // children array; treat that as "no explicit control" so the default control
			    // is still built.
			    const explicitChildren = Array.isArray(props.children) && props.children.length === 0 ? undefined : props.children;
			    const control = explicitChildren ??
			        (props.checkbox !== undefined
			            ? undefined
			            : props.options !== undefined
			                ? Select({
			                    value: props.value ?? '',
			                    options: props.options,
			                    disabled: props.disabled === true,
			                    onChange: props.onChange ?? (() => undefined)
			                })
			                : TextInput({
			                    value: props.value ?? '',
			                    onChange: props.onChange ?? (() => undefined),
			                    placeholder: props.placeholder ?? guide?.placeholder,
			                    mono: props.mono === true,
			                    disabled: props.disabled === true
			                }));
			    return (0, react_1.createElement)(Field, {
			        label,
			        path: props.path,
			        help,
			        helpLabel: (0, panel_1.interpolate)(props.t('helpAbout'), { field: label }),
			        hint: props.hint,
			        checkbox: props.checkbox
			    }, control);
			}
			/** A colour-coded level chip. */
			function LevelChip(props) {
			    return (0, react_1.createElement)('span', { style: { ...S.chip, color: token((0, panel_1.levelTone)(props.level), 'inherit') } }, (0, react_1.createElement)('span', { style: S.swatch }), props.label ?? props.level);
			}
			/** Options of an effort-policy select: leave untouched, or adapt per turn. */
			function effortPolicyOptions(t) {
			    return [
			        { value: '', label: t('effortUnset') },
			        { value: panel_1.ADAPTIVE_EFFORT_POLICY, label: t('effortAdaptive') }
			    ];
			}
			/** Options of a fallback-level select. */
			function adaptiveLevelOptions() {
			    return panel_1.ADAPTIVE_EFFORT_LEVELS.map((value) => ({ value, label: value }));
			}
			/** One-character glyph that keeps the three icon states distinguishable without colour. */
			function statusGlyph(state) {
			    switch (state) {
			        case 'error':
			            return '×';
			        case 'warn':
			            return '!';
			        default:
			            return '●';
			    }
			}
			/** Header: identity, one compact status icon, and the write actions. */
			function Header(props) {
			    const { t, state, store } = props;
			    const status = (0, panel_1.panelStatus)(state.snapshot);
			    const degraded = (0, panel_1.systemOneDegraded)(state.snapshot);
			    const degradedReason = degraded === undefined || degraded.reason.length === 0 ? t('systemOneDegradedUnknown') : degraded.reason;
			    const canWrite = state.writable && state.configStatus === 'ready';
			    const statusLabel = status === undefined
			        ? ''
			        : (0, panel_1.interpolate)(t('statusLabel'), {
			            routing: (0, panel_1.interpolate)(t(status.routing.key), status.routing.values ?? {}),
			            effort: (0, panel_1.interpolate)(t(status.effort.key), status.effort.values ?? {}),
			            backend: (0, panel_1.interpolate)(t(status.backend.key), status.backend.values ?? {})
			        });
			    const statusTitle = status === undefined ? '' : status.lines.map((line) => (0, panel_1.interpolate)(t(line.key), line.values ?? {})).join('\n');
			    return (0, react_1.createElement)('header', { style: S.header }, (0, react_1.createElement)('div', { style: S.titleRow }, (0, react_1.createElement)('h3', { style: S.title }, t('title')), status === undefined
			        ? null
			        : (0, react_1.createElement)('button', {
			            type: 'button',
			            'data-reflex-status': status.state,
			            'aria-label': statusLabel,
			            title: statusTitle,
			            style: { ...S.statusButton, color: token(status.tone, 'inherit') }
			        }, (0, react_1.createElement)('span', { 'aria-hidden': 'true', style: S.statusGlyph }, statusGlyph(status.state)))), (0, react_1.createElement)('span', { style: S.subtitle }, t('subtitle')), degraded === undefined
			        ? null
			        : (0, react_1.createElement)('div', { style: S.banner, 'data-reflex-degraded': 'true', role: 'status' }, (0, react_1.createElement)('span', null, (0, panel_1.interpolate)(t('systemOneDegraded'), { reason: degradedReason })), Button({ label: t('refresh'), onClick: () => void store.refresh() })), (0, react_1.createElement)('div', { style: S.actions }, Button({ label: t('refresh'), onClick: () => void store.refresh() }), Button({ label: t('save'), kind: 'primary', disabled: !canWrite || state.saving, onClick: () => void store.save() }), Button({ label: t('reset'), disabled: !canWrite, onClick: () => store.reset() }), state.saving ? (0, react_1.createElement)('span', { style: S.hint }, t('saving')) : null, state.notice === null ? null : (0, react_1.createElement)('span', { style: S.notice }, (0, panel_1.interpolate)(t(state.notice), state.noticeValues ?? {}))));
			}
			/** Overview page: live metrics, backend identity, and the latest adaptive decision. */
			function OverviewTab(props) {
			    const { t, state } = props;
			    const snapshot = state.snapshot;
			    const latest = snapshot?.effort?.latest ?? null;
			    const pools = snapshot?.routing?.pools ?? [];
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('tabOverview'),
			        children: (0, react_1.createElement)('div', { style: S.grid }, ...(0, panel_1.overviewMetrics)(snapshot).map((metric) => (0, react_1.createElement)(Metric, { key: metric.id, label: t(metric.labelKey), value: metric.value })))
			    }), Card({
			        title: t('groupRouting'),
			        children: pools.length === 0
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('poolEmpty'))
			            : (0, react_1.createElement)('div', { style: S.grid }, ...pools.map((pool) => (0, react_1.createElement)(Metric, {
			                key: String(pool.model ?? ''),
			                label: String(pool.model ?? ''),
			                value: `${String((pool.entries ?? []).length)} ${t('poolCandidates')}`
			            })))
			    }), Card({
			        title: t('effortLatest'),
			        children: latest === null
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('effortNoDecision'))
			            : (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.row }, LevelChip({ level: String(latest.level ?? ''), label: String(latest.applied ?? latest.level ?? '') }), (0, react_1.createElement)('span', { style: S.hint }, `${String(latest.trigger ?? '')} · ${String(latest.source ?? '')} · ${String(latest.latencyMs ?? 0)} ms`), (0, react_1.createElement)('span', { style: S.hint }, `${String(latest.provider ?? '')}:${String(latest.model ?? '')}`)), (0, react_1.createElement)('div', { style: S.mono }, String(latest.line ?? '')), latest.degradedReason === undefined ? null : (0, react_1.createElement)('div', { style: S.hint }, String(latest.degradedReason)))
			    }));
			}
			/** Routing page: the virtual provider and its ordered model pools. */
			function RoutingTab(props) {
			    const { t, state, store } = props;
			    const draft = state.draft;
			    const disabled = !state.writable;
			    const setRouting = (patch) => {
			        store.edit((current) => ({ ...current, routing: { ...current.routing, ...patch } }));
			    };
			    const setPoolModel = (index, model) => {
			        store.editPools((pools) => pools.map((pool, position) => (position === index ? { ...pool, model } : pool)));
			    };
			    const setEntry = (index, entry, patch) => {
			        store.editPools((pools) => pools.map((pool, position) => position === index
			            ? { ...pool, entries: pool.entries.map((candidate, at) => (at === entry ? { ...candidate, ...patch } : candidate)) }
			            : pool));
			    };
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('groupRouting'),
			        children: (0, react_1.createElement)('div', { style: S.field }, GuidedField({
			            t,
			            path: 'routing.enabled',
			            checkbox: { checked: draft.routing.enabled, disabled, onChange: (checked) => setRouting({ enabled: checked }) }
			        }), (0, react_1.createElement)('div', { style: S.fieldRow }, GuidedField({ t, path: 'routing.virtualProvider', value: draft.routing.virtualProvider, disabled, mono: true, onChange: (value) => setRouting({ virtualProvider: value }) }), GuidedField({ t, path: 'routing.fallback', value: draft.routing.fallback, disabled, mono: true, onChange: (value) => setRouting({ fallback: value }) }), GuidedField({ t, path: 'routing.maxTaskChars', value: draft.routing.maxTaskChars, disabled, onChange: (value) => setRouting({ maxTaskChars: value }) })))
			    }), Card({
			        title: t('labelPools'),
			        children: (0, react_1.createElement)('div', { style: S.field }, draft.routing.pools.length === 0 ? (0, react_1.createElement)('div', { style: S.empty }, t('poolEmpty')) : null, ...draft.routing.pools.map((pool, index) => (0, react_1.createElement)('div', { key: `pool-${String(index)}`, style: S.pool }, (0, react_1.createElement)('div', { style: S.row }, (0, react_1.createElement)('span', { style: S.label }, t('poolModelId')), TextInput({ value: pool.model, disabled, mono: true, placeholder: 'reflex-pro', onChange: (value) => setPoolModel(index, value) }), Button({ label: t('poolAddEntry'), small: true, disabled, onClick: () => store.addCandidate(index) }), Button({ label: t('poolRemoveModel'), small: true, kind: 'danger', disabled, onClick: () => store.removePool(index) })), ...pool.entries.map((entry, at) => {
			            const catalog = state.snapshot?.modelCatalog ?? [];
			            const selectedGroup = catalog.find((g) => g.id === entry.provider);
			            const availableModels = selectedGroup?.models ?? [];
			            return (0, react_1.createElement)('div', { key: `entry-${String(index)}-${String(at)}`, style: S.candidateCard }, 
			            // 第一行：Provider 选择 + Model 选择 + 排序/删除操作按钮
			            (0, react_1.createElement)('div', { style: S.candidateRow1 }, catalog.length > 0
			                ? (0, react_1.createElement)('select', {
			                    style: { ...S.input, flex: '1 1 140px', minWidth: '120px' },
			                    disabled,
			                    value: entry.provider,
			                    onChange: (e) => {
			                        const newProv = e.target.value;
			                        const group = catalog.find((g) => g.id === newProv);
			                        const firstModel = group?.models?.[0]?.id ?? '';
			                        setEntry(index, at, { provider: newProv, model: firstModel });
			                    }
			                }, (0, react_1.createElement)('option', { value: '' }, `-- ${t('poolEntryProvider')} --`), ...catalog.map((g) => (0, react_1.createElement)('option', { key: g.id, value: g.id }, g.name || g.id)))
			                : TextInput({ value: entry.provider, disabled, mono: true, placeholder: t('poolEntryProvider'), onChange: (value) => setEntry(index, at, { provider: value }) }), availableModels.length > 0
			                ? (0, react_1.createElement)('select', {
			                    style: { ...S.input, flex: '1.5 1 180px', minWidth: '140px' },
			                    disabled,
			                    value: entry.model,
			                    onChange: (e) => setEntry(index, at, { model: e.target.value })
			                }, (0, react_1.createElement)('option', { value: '' }, `-- ${t('poolEntryModel')} --`), ...availableModels.map((m) => (0, react_1.createElement)('option', { key: m.id, value: m.id }, m.name || m.id)))
			                : TextInput({ value: entry.model, disabled, mono: true, placeholder: t('poolEntryModel'), onChange: (value) => setEntry(index, at, { model: value }) }), (0, react_1.createElement)('div', { style: { display: 'flex', gap: '4px', flex: '0 0 auto', marginLeft: 'auto' } }, Button({ label: '↑', title: t('poolMoveUp'), small: true, disabled: disabled || at === 0, onClick: () => store.moveCandidate(index, at, -1) }), Button({ label: '↓', title: t('poolMoveDown'), small: true, disabled: disabled || at === pool.entries.length - 1, onClick: () => store.moveCandidate(index, at, 1) }), Button({ label: '×', title: t('poolRemoveEntry'), small: true, kind: 'danger', disabled, onClick: () => store.removeCandidate(index, at) }))), 
			            // 第二行：能力说明 + 特征标签（宽敞横向排开）
			            (0, react_1.createElement)('div', { style: S.candidateRow2 }, (0, react_1.createElement)('div', { style: { flex: '1.8 1 200px' } }, TextInput({ value: entry.description, disabled, placeholder: t('poolEntryDescription'), onChange: (value) => setEntry(index, at, { description: value }) })), (0, react_1.createElement)('div', { style: { flex: '1.2 1 140px' } }, TextInput({ value: entry.tags, disabled, placeholder: t('poolEntryTags'), onChange: (value) => setEntry(index, at, { tags: value }) }))));
			        }))), Button({ label: t('poolAddModel'), small: true, disabled, onClick: () => store.addPool() }))
			    }));
			}
			/** Effort page: the adaptive policy, its floor, and the last decision's shape. */
			function EffortTab(props) {
			    const { t, state, store } = props;
			    const draft = state.draft;
			    const disabled = !state.writable;
			    const setEffort = (patch) => {
			        store.edit((current) => ({ ...current, effort: { ...current.effort, ...patch } }));
			    };
			    const latest = state.snapshot?.effort?.latest ?? null;
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('groupEffort'),
			        children: (0, react_1.createElement)('div', { style: S.field }, GuidedField({
			            t,
			            path: 'effort.enabled',
			            checkbox: { checked: draft.effort.enabled, disabled, onChange: (checked) => setEffort({ enabled: checked }) }
			        }), (0, react_1.createElement)('div', { style: S.hint }, t('effortDisabledHint')), (0, react_1.createElement)('div', { style: S.fieldRow }, GuidedField({
			            t,
			            path: 'effort.setting',
			            hint: t('effortHint'),
			            value: (0, panel_1.normalizeEffortPolicy)(draft.effort.setting),
			            options: effortPolicyOptions(t),
			            disabled,
			            onChange: (value) => setEffort({ setting: value })
			        }), GuidedField({
			            t,
			            path: 'effort.fallback',
			            value: draft.effort.fallback,
			            options: adaptiveLevelOptions(),
			            disabled,
			            onChange: (value) => setEffort({ fallback: value })
			        }), GuidedField({
			            t,
			            path: 'effort.minConfidence',
			            value: draft.effort.minConfidence,
			            disabled,
			            onChange: (value) => setEffort({ minConfidence: value })
			        })))
			    }), Card({
			        title: t('effortLatest'),
			        children: latest === null
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('effortNoDecision'))
			            : (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('tbody', null, ...[
			                [t('labelEffortSetting'), String(latest.level ?? '')],
			                [t('backendActive'), `${String(latest.provider ?? '')}:${String(latest.model ?? '')}`],
			                ['trigger', String(latest.trigger ?? '')],
			                ['source', String(latest.source ?? '')],
			                ['confidence', String(latest.confidence ?? '')],
			                [t('colLatency'), `${String(latest.latencyMs ?? 0)} ms`],
			                [t('colDetail'), String(latest.line ?? '')]
			            ].map(([label, value]) => (0, react_1.createElement)('tr', { key: label }, (0, react_1.createElement)('td', { style: { ...S.td, ...S.label, width: '140px' } }, label), (0, react_1.createElement)('td', { style: S.td }, value)))))
			    }));
			}
			/** Backend page: the System 1 connection and the runtime-level fields. */
			function BackendTab(props) {
			    const { t, state, store } = props;
			    const draft = state.draft;
			    const disabled = !state.writable;
			    const systemOne = state.snapshot?.systemOne;
			    const setBackend = (patch) => {
			        store.edit((current) => ({ ...current, backend: { ...current.backend, ...patch } }));
			    };
			    const setRuntime = (patch) => {
			        store.edit((current) => ({ ...current, runtime: { ...current.runtime, ...patch } }));
			    };
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('groupBackend'),
			        children: (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.fieldRow }, GuidedField({
			            t,
			            path: 'backend',
			            value: draft.backend.backend,
			            options: panel_1.BACKEND_CHOICES.map((value) => ({ value, label: value })),
			            disabled,
			            onChange: (value) => {
			                if (value === 'jev') {
			                    setBackend({
			                        backend: value,
			                        baseUrl: draft.backend.baseUrl || 'https://api.typesafe.ai/v1/systemone',
			                        model: draft.backend.model || 'jev-latest',
			                        apiKeyEnv: draft.backend.apiKeyEnv || 'JEV_API_KEY'
			                    });
			                }
			                else {
			                    setBackend({ backend: value });
			                }
			            }
			        }), GuidedField({ t, path: 'systemOne.baseUrl', value: draft.backend.baseUrl, disabled, mono: true, onChange: (value) => setBackend({ baseUrl: value }) }), GuidedField({ t, path: 'systemOne.model', value: draft.backend.model, disabled, mono: true, onChange: (value) => setBackend({ model: value }) }), GuidedField({ t, path: 'systemOne.apiKeyEnv', hint: t('backendHint'), value: draft.backend.apiKeyEnv, disabled, mono: true, onChange: (value) => setBackend({ apiKeyEnv: value }) }), GuidedField({ t, path: 'systemOne.timeoutMs', value: draft.backend.timeoutMs, disabled, onChange: (value) => setBackend({ timeoutMs: value }) })), (0, react_1.createElement)('div', { style: S.row }, (0, react_1.createElement)('span', { style: S.label }, t('backendActive')), (0, react_1.createElement)('span', { style: S.mono }, String(systemOne?.active ?? '—')), systemOne?.apiKeyEnv === undefined
			            ? null
			            : (0, react_1.createElement)('span', { style: { ...S.hint, color: token(systemOne.apiKeyPresent === true ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-warn-primary', 'inherit') } }, `${systemOne.apiKeyEnv} · ${t(systemOne.apiKeyPresent === true ? 'apiKeyPresent' : 'apiKeyMissing')}`)))
			    }), Card({
			        title: t('groupRuntime'),
			        children: (0, react_1.createElement)('div', { style: S.fieldRow }, GuidedField({ t, path: 'toolPrefix', value: draft.runtime.toolPrefix, disabled, mono: true, onChange: (value) => setRuntime({ toolPrefix: value }) }), GuidedField({ t, path: 'pruneThreshold', value: draft.runtime.pruneThreshold, disabled, onChange: (value) => setRuntime({ pruneThreshold: value }) }), GuidedField({ t, path: 'ledgerPath', value: draft.runtime.ledgerPath, disabled, mono: true, onChange: (value) => setRuntime({ ledgerPath: value }) }), GuidedField({ t, path: 'calibrationPath', value: draft.runtime.calibrationPath, disabled, mono: true, onChange: (value) => setRuntime({ calibrationPath: value }) }))
			    }));
			}
			/** Ledger page: summary, sink identity, recent decisions, and the clear action. */
			function LedgerTab(props) {
			    const { t, state, store } = props;
			    const rows = (0, panel_1.ledgerRows)(state.snapshot);
			    const logPath = state.snapshot?.ledger?.logPath ?? null;
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('tabLedger'),
			        children: (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.grid }, ...(0, panel_1.overviewMetrics)(state.snapshot).map((metric) => (0, react_1.createElement)(Metric, { key: metric.id, label: t(metric.labelKey), value: metric.value }))), (0, react_1.createElement)('div', { style: S.row }, (0, react_1.createElement)('span', { style: S.label }, t('ledgerLogPath')), (0, react_1.createElement)('span', { style: S.mono }, logPath ?? t('ledgerMemoryOnly')), Button({
			            label: state.confirmingClear ? t('ledgerClearConfirm') : t('ledgerClear'),
			            kind: 'danger',
			            small: true,
			            onClick: () => void store.clearLedger()
			        })))
			    }), Card({
			        title: t('ledgerRecent'),
			        children: rows.length === 0
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('ledgerEmpty'))
			            : (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('thead', null, (0, react_1.createElement)('tr', null, ...[t('colTime'), t('colType'), t('colBackend'), t('colLatency'), t('colTokens'), t('colDetail')].map((label) => (0, react_1.createElement)('th', { key: label, style: S.th }, label)))), (0, react_1.createElement)('tbody', null, ...rows.map((row) => (0, react_1.createElement)('tr', { key: row.id }, (0, react_1.createElement)('td', { style: { ...S.td, ...S.mono } }, row.clock), (0, react_1.createElement)('td', { style: { ...S.td, color: token(row.tone, 'inherit') } }, t(row.typeKey)), (0, react_1.createElement)('td', { style: S.td }, row.backend), (0, react_1.createElement)('td', { style: { ...S.td, fontVariantNumeric: 'tabular-nums' } }, row.latency), (0, react_1.createElement)('td', { style: { ...S.td, fontVariantNumeric: 'tabular-nums' } }, row.tokens), (0, react_1.createElement)('td', { style: S.td }, row.detail)))))
			    }));
			}
			/**
			 * Guide page: the repository user guide, rendered inside the settings surface.
			 *
			 * The Markdown body arrives through the locale dictionary (`guideBody`), which is
			 * why the language selector is the DSH interface language rather than a control
			 * of its own: the document is embedded once per language at build time, and the
			 * provenance line names the exact source file and revision digest so a reader can
			 * tell whether the panel is showing the current document.
			 */
			function GuideTab(props) {
			    const { t } = props;
			    return (0, react_1.createElement)('div', { style: S.root }, (0, react_1.createElement)('section', { style: S.card }, (0, react_1.createElement)('h4', { style: S.cardTitle }, t('guideTitle')), (0, react_1.createElement)('p', { style: S.paragraph }, t('guideIntro')), (0, react_1.createElement)('p', { style: S.hint }, t('guideHint')), (0, react_1.createElement)('p', { style: S.mono }, (0, panel_1.interpolate)(t('guideProvenance'), { source: t('guideSource'), digest: t('guideRevision') }))), (0, markdown_1.renderMarkdown)(t('guideBody')));
			}
			/** Copy key of one three-state (or `inherit`) intervention setting. */
			function interventionModeCopyKey(value) {
			    switch (value) {
			        case 'off':
			            return 'modeOff';
			        case 'active':
			            return 'modeActive';
			        case 'inherit':
			            return 'modeInherit';
			        default:
			            return 'modeObserve';
			    }
			}
			/** Options of an intervention mode select; `inherit` only where it is legal. */
			function interventionModeOptions(t, withInherit) {
			    return (withInherit ? panel_1.INTERVENTION_SETTINGS : panel_1.INTERVENTION_MODES).map((value) => ({
			        value,
			        label: t(interventionModeCopyKey(value))
			    }));
			}
			/** Capability name → copy key of its field label. */
			const CAPABILITY_COPY = {
			    stagnation: 'labelCapabilityStagnation',
			    prune: 'labelCapabilityPrune',
			    gate: 'labelCapabilityGate',
			    closing: 'labelCapabilityClosing'
			};
			/** Automatic-intervention page: the master mode, the per-capability overrides, and the budgets. */
			function InterventionsTab(props) {
			    const { t, state, store } = props;
			    const draft = state.draft;
			    const disabled = !state.writable;
			    const setInterventions = (patch) => {
			        store.edit((current) => ({ ...current, interventions: { ...current.interventions, ...patch } }));
			    };
			    const setCapability = (capability, value) => {
			        store.edit((current) => ({
			            ...current,
			            interventions: { ...current.interventions, capabilities: { ...current.interventions.capabilities, [capability]: value } }
			        }));
			    };
			    const effective = state.snapshot?.interventions;
			    const budgetField = (key) => GuidedField({
			        t,
			        path: `interventions.${String(key)}`,
			        value: String(draft.interventions[key] ?? ''),
			        disabled,
			        onChange: (value) => setInterventions({ [key]: value })
			    });
			    return (0, react_1.createElement)('div', { style: S.root }, Card({
			        title: t('groupInterventions'),
			        children: (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.hint }, t('interventionsHint')), (0, react_1.createElement)('div', { style: S.fieldRow }, GuidedField({
			            t,
			            path: 'interventions.mode',
			            hint: t('interventionModeHint'),
			            value: draft.interventions.mode,
			            options: interventionModeOptions(t, false),
			            disabled,
			            onChange: (value) => setInterventions({ mode: value })
			        }), ...panel_1.INTERVENTION_CAPABILITIES.map((capability) => (0, react_1.createElement)(GuidedField, {
			            key: capability,
			            t,
			            path: `interventions.capabilities.${capability}`,
			            label: t(CAPABILITY_COPY[capability] ?? capability),
			            help: (0, panel_1.interpolate)(t('helpCapability'), {
			                name: t(CAPABILITY_COPY[capability] ?? capability),
			                mode: draft.interventions.mode
			            }),
			            value: draft.interventions.capabilities[capability] ?? 'inherit',
			            options: interventionModeOptions(t, true),
			            disabled,
			            onChange: (value) => setCapability(capability, value)
			        }))), (0, react_1.createElement)('div', { style: S.fieldRow }, budgetField('maxInterventionsPerTurn'), budgetField('maxJudgmentsPerTurn'), budgetField('maxJudgmentsPerSession'), budgetField('repeatThreshold'), budgetField('failureThreshold'), budgetField('windowSize'), budgetField('minConfidence'), budgetField('pruneFloorRatio'), budgetField('pruneHeadChars'), budgetField('pruneTailChars'), GuidedField({
			            t,
			            path: 'interventions.pruneJudgeMinChars',
			            value: draft.interventions.pruneJudgeMinChars,
			            disabled,
			            onChange: (value) => setInterventions({ pruneJudgeMinChars: value })
			        }), budgetField('claimMinConfidence'), budgetField('closingEvidenceChars'), GuidedField({
			            t,
			            path: 'interventions.intent',
			            value: draft.interventions.intent,
			            disabled,
			            onChange: (value) => setInterventions({ intent: value })
			        })))
			    }), Card({
			        title: t('interventionsEffective'),
			        children: effective === undefined
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('effectiveUnknown'))
			            : (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('tbody', null, ...[
			                [t('labelInterventionMode'), String(effective.mode ?? '')],
			                [t('effectiveActing'), t(effective.acting === true ? 'modeActive' : effective.enabled === true ? 'modeObserve' : 'modeOff')],
			                ...panel_1.INTERVENTION_CAPABILITIES.map((capability) => [
			                    t(CAPABILITY_COPY[capability] ?? capability),
			                    String(effective.capabilities?.[capability] ?? '')
			                ])
			            ].map(([label, value]) => (0, react_1.createElement)('tr', { key: label }, (0, react_1.createElement)('td', { style: { ...S.td, ...S.label, width: '180px' } }, label), (0, react_1.createElement)('td', { style: S.td }, value)))))
			    }));
			}
			/** Dictionary key of one advice label. */
			function toolAdviceKey(advice) {
			    return advice === 'expose' ? 'toolAdviceExpose' : 'toolAdviceOptional';
			}
			/**
			 * Tone of one advice label: a colour on the existing chip, not a new component.
			 * @param advice - the advice being shown.
			 * @returns the CSS custom property, with a literal fallback.
			 */
			function toolAdviceTone(advice) {
			    return advice === 'expose'
			        ? token('--dsw-alias-state-success-primary', '#4ade80')
			        : token('--dsw-alias-state-warn-primary', '#d9a441');
			}
			/** Tool-switch page: one toggle per reflex tool, plus the effective registration. */
			function ToolsTab(props) {
			    const { t, state, store } = props;
			    const draft = state.draft;
			    const disabled = !state.writable;
			    const setTool = (suffix, enabled) => {
			        store.edit((current) => ({ ...current, tools: { enabled: { ...current.tools.enabled, [suffix]: enabled } } }));
			    };
			    // Advice drives both the labels and this button, so "recommended" is stated
			    // once. Applying it only pre-fills the draft: the group is written when the
			    // user saves, through the same single write channel as every other field.
			    const applyRecommended = () => {
			        const recommended = (0, panel_1.recommendedToolSwitches)();
			        store.edit((current) => ({ ...current, tools: { enabled: { ...current.tools.enabled, ...recommended } } }));
			    };
			    const active = state.snapshot?.tools?.active;
			    return (0, react_1.createElement)('div', { style: S.root }, DelegationCard(props), Card({
			        title: t('groupTools'),
			        children: (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.hint }, t('toolsHint')), (0, react_1.createElement)('div', { style: S.toolActions }, Button({ label: t('toolsApplyRecommended'), onClick: applyRecommended, disabled }), (0, react_1.createElement)('span', { style: S.hint }, t('toolsRecommendedHint'))), (0, react_1.createElement)('div', { style: S.toolList }, 
			        // The label is the *registered* name under the current draft prefix, so
			        // renaming the prefix shows up here immediately; the switch itself is
			        // keyed by suffix and therefore survives the rename.
			        ...panel_1.REFLEX_TOOL_SUFFIXES.map((suffix) => {
			            const advice = panel_1.TOOL_ADVICE[suffix];
			            return (0, react_1.createElement)('div', { key: suffix, style: S.toolRow }, (0, react_1.createElement)('div', { style: S.toolHead }, GuidedField({
			                t,
			                path: `tools.enabled.${suffix}`,
			                // The label is the registered name under the current prefix.
			                label: `${draft.runtime.toolPrefix}${suffix}`,
			                help: (0, panel_1.interpolate)(t('helpToolSwitch'), {
			                    what: t(`toolWhat_${suffix}`).replace(/[。.]$/, ''),
			                    default: (draft.tools.enabled[suffix] ?? panel_1.TOOL_DEFAULT_ENABLED[suffix]) ? t('helpSwitchOn') : t('helpSwitchOff')
			                }),
			                // The switch shows the *effective* state, so a suffix the
			                // deployment never mentioned reads its documented default
			                // (`route` starts off) instead of an unconditional "on".
			                checkbox: {
			                    checked: draft.tools.enabled[suffix] ?? panel_1.TOOL_DEFAULT_ENABLED[suffix],
			                    disabled,
			                    onChange: (checked) => setTool(suffix, checked)
			                }
			            }), (0, react_1.createElement)('span', { style: { ...S.chip, marginLeft: 'auto', color: toolAdviceTone(advice) } }, t(toolAdviceKey(advice)))), (0, react_1.createElement)('span', { style: S.toolWhat }, t(`toolWhat_${suffix}`)), (0, react_1.createElement)('span', { style: S.hint }, t(`toolWhen_${suffix}`)));
			        }), 
			        // The ledger is not a tool any more, so this page points at where it
			        // went instead of listing a switch for it.
			        (0, react_1.createElement)('div', { style: S.hint }, t('toolsLedgerHint'))))
			    }), Card({
			        title: t('toolsEffective'),
			        children: active === undefined
			            ? (0, react_1.createElement)('div', { style: S.empty }, t('effectiveUnknown'))
			            : active.length === 0
			                ? (0, react_1.createElement)('div', { style: S.empty }, t('toolsAllClosed'))
			                : (0, react_1.createElement)('div', { style: S.mono }, ...active.map((toolName) => (0, react_1.createElement)('div', { key: toolName }, toolName)))
			    }));
			}
			/**
			 * The host-capability switch behind `reflex_delegate`.
			 *
			 * Three facts are shown together because they answer the three questions a
			 * person actually has: *is it on in my settings* (the checkbox), *is the host
			 * asked for it* (the patch line), and *is it working right now* (the live state).
			 * The consent text names the host switch explicitly, because ticking this box
			 * also edits a file outside this plugin — that is the point of the notice, and
			 * hiding it behind a tooltip would be the dishonesty the goal forbids.
			 */
			function DelegationCard(props) {
			    const { t, state, store } = props;
			    const delegation = state.snapshot?.delegation;
			    const checked = state.draft.delegation.enabled;
			    const disabled = !state.writable;
			    const write = state.delegationWrite;
			    // Ticking is a two-step action, in this order: record the consent, then ask
			    // the host to write the patch. Only the first is a settings edit, and only when
			    // it lands does the second run — so the file is never written by a box whose
			    // consent was never saved.
			    const onToggle = (next) => {
			        void (async () => {
			            store.edit((current) => ({ ...current, delegation: { enabled: next } }));
			            const saved = await store.save();
			            if (saved && next)
			                await store.enableDelegation();
			        })();
			    };
			    const stateCopy = (() => {
			        if (delegation === undefined)
			            return t('delegationStateUnknown');
			        switch (delegation.state) {
			            case 'ready':
			                return t('delegationStateReady');
			            case 'model-selection-off':
			                return t('delegationStateOff');
			            case 'missing-tool':
			                return t('delegationStateNoTool');
			            default:
			                return t('delegationStateUnknown');
			        }
			    })();
			    return Card({
			        title: t('groupDelegation'),
			        children: (0, react_1.createElement)('div', { style: S.field }, (0, react_1.createElement)('div', { style: S.hint }, t('delegationIntro')), GuidedField({
			            t,
			            path: 'delegation.enabled',
			            label: t('labelDelegationEnabled'),
			            help: t('helpDelegationEnabled'),
			            checkbox: { checked, disabled, onChange: onToggle }
			        }), 
			        // The host switch this box writes, named plainly and unconditionally: it is
			        // part of what ticking means, not a conditional consequence.
			        (0, react_1.createElement)('div', { style: S.hint }, t('delegationConsent')), (0, react_1.createElement)('table', { style: S.table }, (0, react_1.createElement)('tbody', null, ...[
			            [t('delegationRowState'), stateCopy],
			            [t('delegationRowPatch'), delegation?.patchPath ?? t('delegationPatchUnknown')],
			            [
			                t('delegationRowPatchState'),
			                delegation === undefined
			                    ? t('delegationStateUnknown')
			                    : delegation.patchEnabled
			                        ? t('delegationPatchOn')
			                        : t('delegationPatchOff')
			            ],
			            [t('delegationRowRegistered'), delegation?.registered === true ? t('delegationOn') : t('delegationOff')]
			        ].map(([label, value]) => (0, react_1.createElement)('tr', { key: label }, (0, react_1.createElement)('td', { style: { ...S.td, ...S.label, width: '180px' } }, label), (0, react_1.createElement)('td', { style: S.td }, value))))), 
			        // The reason, verbatim from the host: a state with no explanation is the
			        // "the tool just is not there" experience this switch exists to replace.
			        delegation?.reason === undefined ? null : (0, react_1.createElement)('div', { style: S.banner }, delegation.reason), 
			        // "Saved, applies after a restart" — stated as the fact it is, never as
			        // "done". Only shown when the file asks for the field and the live host
			        // still refuses it, which is exactly the pending-restart window.
			        delegation?.restartRequired === true
			            ? (0, react_1.createElement)('div', { style: S.banner }, t('delegationRestartRequired'), ' ', (0, react_1.createElement)('span', { style: S.mono }, delegation.patchPath ?? ''))
			            : null, write === null
			            ? null
			            : write.outcome === 'refused'
			                ? // A refused write leaves the consent recorded but the host file
			                    // untouched. Saying "saved" here would be the exact dishonesty this
			                    // switch exists to avoid, so the reason is shown instead.
			                    (0, react_1.createElement)('div', { style: S.banner }, t('delegationWriteRefused'), ...(write.reason === undefined ? [] : [' ', write.reason]))
			                : (0, react_1.createElement)('div', { style: write.restartRequired ? S.banner : S.hint }, t(write.restartRequired ? 'delegationSavedRestart' : 'delegationSavedNoRestart')), (0, react_1.createElement)('div', { style: S.hint }, t('delegationRevokeHint')))
			    });
			}
			/** Page body. */
			function Body(props) {
			    switch (props.state.tab) {
			        case 'routing':
			            return RoutingTab(props);
			        case 'effort':
			            return EffortTab(props);
			        case 'backend':
			            return BackendTab(props);
			        case 'interventions':
			            return InterventionsTab(props);
			        case 'tools':
			            return ToolsTab(props);
			        case 'ledger':
			            return LedgerTab(props);
			        case 'guide':
			            return GuideTab({ t: props.t });
			        default:
			            return OverviewTab(props);
			    }
			}
			/**
			 * Build the slot component for one client context.
			 *
			 * The store is created once per mounted component and disposed with it, so a
			 * closed settings surface stops polling immediately.
			 * @param ctx - the client context, used to reach the settings provider.
			 * @param t - translator of this plugin's dictionary namespace.
			 * @returns the component to register into `settings.section`.
			 */
			function createPanelComponent(ctx, t) {
			    return function ReflexPanel(props) {
			        const storeRef = (0, react_1.useRef)(null);
			        const form = (0, react_1.useMemo)(() => {
			            let cfg = null;
			            try {
			                cfg = ctx?.get?.('configForms') ?? (typeof ctx?.configForms?.get === 'function' ? ctx.configForms : null);
			            }
			            catch {
			                try {
			                    cfg = ctx?.get?.('configForms');
			                }
			                catch { }
			            }
			            if (cfg && typeof cfg.get === 'function') {
			                const candidates = ['dsh-reflex', 'reflex', props.ns];
			                for (const candidate of candidates) {
			                    try {
			                        const candidateForm = cfg.get(candidate);
			                        const snap = candidateForm?.getSnapshot?.();
			                        if (snap && snap.status !== 'unavailable') {
			                            return candidateForm;
			                        }
			                    }
			                    catch { }
			                }
			                // If neither is served yet, return a local writable form so the panel is fully interactive
			                return {
			                    getSnapshot: () => ({ status: 'ready', value: {}, base: 0, user: 0, revision: 1, writable: true }),
			                    subscribe: () => () => { },
			                    mutate: async (ops) => {
			                        for (const candidate of candidates) {
			                            try {
			                                const candidateForm = cfg.get(candidate);
			                                await candidateForm?.mutate?.(ops);
			                            }
			                            catch { }
			                        }
			                        return true;
			                    }
			                };
			            }
			            return {
			                getSnapshot: () => ({ status: 'ready', value: {}, base: 0, user: 0, revision: 1, writable: true }),
			                subscribe: () => () => { },
			                mutate: async () => true
			            };
			        }, [props.ns]);
			        if (storeRef.current === null) {
			            storeRef.current = new store_1.PanelStore({ form, fetch: (input, init) => fetch(input, init) });
			        }
			        const store = storeRef.current;
			        (0, react_1.useEffect)(() => {
			            store.start();
			            return () => {
			                store.dispose();
			            };
			        }, [store]);
			        const subscribe = (0, react_1.useCallback)((listener) => store.subscribe(listener), [store]);
			        const state = (0, react_1.useSyncExternalStore)(subscribe, () => store.getState());
			        const selectTab = (0, react_1.useCallback)((tab) => store.setTab(tab), [store]);
			        const statusNote = state.configStatus === 'unavailable'
			            ? t('stateUnavailable')
			            : state.configStatus === 'loading'
			                ? t('stateLoading')
			                : !state.writable
			                    ? t('readOnly')
			                    : null;
			        return (0, react_1.createElement)('div', { style: S.root }, Header({ t, state, store }), statusNote === null ? null : (0, react_1.createElement)('div', { style: S.hint }, statusNote), state.errors.length === 0
			            ? null
			            : (0, react_1.createElement)('div', { style: S.errors }, ...state.errors.map((key) => (0, react_1.createElement)('div', { key }, t(key)))), state.error === null ? null : (0, react_1.createElement)('div', { style: S.errors }, `${t('refreshFailed')}: ${state.error}`), (0, react_1.createElement)('nav', { style: S.tabs }, ...store_1.PANEL_TABS.map((tab) => (0, react_1.createElement)('button', {
			            key: tab,
			            type: 'button',
			            style: { ...S.tab, ...(state.tab === tab ? S.tabActive : {}) },
			            onClick: () => selectTab(tab)
			        }, t(tabCopyKey(tab))))), Body({ t, state, store }));
			    };
			}
			/** Copy key of one page's navigation label. */
			function tabCopyKey(tab) {
			    switch (tab) {
			        case 'routing':
			            return 'tabRouting';
			        case 'effort':
			            return 'tabEffort';
			        case 'backend':
			            return 'tabBackend';
			        case 'interventions':
			            return 'tabInterventions';
			        case 'tools':
			            return 'tabTools';
			        case 'ledger':
			            return 'tabLedger';
			        case 'guide':
			            return 'tabGuide';
			        default:
			            return 'tabOverview';
			    }
			}

		}
		};
		var __cache = Object.create(null);
		var __load = function (key) {
			var cached = __cache[key];
			if (cached !== undefined) return cached.exports;
			var factory = __factories[key];
			if (factory === undefined) throw new Error("client-modules: no bundled module \"" + key + "\" in dsh-harness-reflex");
			var record = { exports: {} };
			__cache[key] = record;
			factory(record, record.exports, __require);
			return record.exports;
		};
		var __require = function (spec) {
			if (spec.charCodeAt(0) === 46) return __load(spec.replace(/^\.\//, ""));
			return require(spec);
		};
		__cache["index"] = module;
		__factories["index"](module, module.exports, __require);
		return module.exports;
	}
});
