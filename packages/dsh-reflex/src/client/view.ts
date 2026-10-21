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
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  ADAPTIVE_EFFORT_LEVELS,
  ADAPTIVE_EFFORT_POLICY,
  BACKEND_CHOICES,
  INTERVENTION_CAPABILITIES,
  INTERVENTION_MODES,
  INTERVENTION_SETTINGS,
  REFLEX_TOOL_SUFFIXES,
  TOOL_ADVICE,
  TOOL_DEFAULT_ENABLED,
  interpolate,
  ledgerRows,
  levelTone,
  normalizeEffortPolicy,
  overviewMetrics,
  panelStatus,
  recommendedToolSwitches,
  systemOneDegraded,
  type PanelDraft,
  type PanelStatusState,
  type ToolAdvice
} from './panel';
import { PanelStore, PANEL_TABS, type FormSnapshotLike, type PanelState, type PanelTab } from './store';
import { renderMarkdown } from './markdown';
import { guideFor, templateGuideFor } from './field-guide';

/** Context face the panel needs; structurally typed against the client runtime. */
export interface PanelContextLike {
  configForms: {
    get(entryId: string): {
      getSnapshot(): FormSnapshotLike;
      subscribe(listener: () => void): () => void;
      mutate(ops: readonly { op: 'set'; path: string[]; value: unknown }[], expectedRevision?: number): Promise<boolean>;
    };
  };
}

/** Props a `settings.section` registration hands to its component. */
export interface PanelProps {
  /** Settings namespace the page edits, resolved by the registration. */
  ns: string;
  /** Closes the settings surface this section was opened in. */
  close?: () => void;
}

/** Translator bound to the panel's dictionary namespace. */
export type Translate = (key: string) => string;

/** Token value with a literal fallback, so an unthemed host still renders. */
function token(name: string, fallback: string): string {
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
} as const;

/** One read-only metric card. */
function Metric(props: { label: string; value: string }): ReactNode {
  return h('div', { style: S.metric }, h('span', { style: S.metricLabel }, props.label), h('span', { style: S.metricValue }, props.value));
}

/** A titled card. */
function Card(props: { title: string; children?: ReactNode }): ReactNode {
  return h('section', { style: S.card }, h('h4', { style: S.cardTitle }, props.title), props.children);
}

/** A button. */
function Button(props: {
  label: string;
  onClick: () => void;
  kind?: 'default' | 'primary' | 'danger';
  small?: boolean;
  disabled?: boolean;
  title?: string;
}): ReactNode {
  const style = {
    ...S.button,
    ...(props.kind === 'primary' ? S.buttonPrimary : {}),
    ...(props.kind === 'danger' ? S.buttonDanger : {}),
    ...(props.small === true ? S.buttonSmall : {}),
    ...(props.disabled === true ? { opacity: 0.5, cursor: 'not-allowed' } : {})
  };
  return h(
    'button',
    {
      type: 'button',
      style,
      disabled: props.disabled === true,
      title: props.title ?? props.label,
      onClick: props.onClick
    },
    props.label
  );
}

/** A text input bound to a draft field. */
function TextInput(props: { value: string; onChange: (value: string) => void; placeholder?: string; mono?: boolean; disabled?: boolean }): ReactNode {
  return h('input', {
    type: 'text',
    style: { ...S.input, ...(props.mono === true ? S.mono : {}) },
    value: props.value,
    placeholder: props.placeholder ?? '',
    disabled: props.disabled === true,
    onChange: (event: { target: { value: string } }) => {
      props.onChange(event.target.value);
    }
  });
}

/** A select bound to a draft field. */
function Select(props: { value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }): ReactNode {
  return h(
    'select',
    {
      style: S.input,
      value: props.value,
      disabled: props.disabled === true,
      onChange: (event: { target: { value: string } }) => {
        props.onChange(event.target.value);
      }
    },
    props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))
  );
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
function Field(props: {
  label: string;
  path?: string;
  help?: string;
  helpLabel?: string;
  helpId?: string;
  hint?: string;
  checkbox?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void };
  children?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const helpId =
    props.helpId ?? (props.path === undefined ? undefined : `reflex-help-${props.path.replace(/[^A-Za-z0-9_-]/g, '-')}`);
  const hasHelp = props.help !== undefined && props.help.length > 0 && helpId !== undefined;
  const control =
    props.checkbox === undefined
      ? h('label', { style: S.fieldLabel }, h('span', { style: S.label }, props.label), props.children)
      : h(
          'label',
          { style: { ...S.row, flex: '1 1 auto', minWidth: 0 } },
          h('input', {
            type: 'checkbox',
            checked: props.checkbox.checked,
            disabled: props.checkbox.disabled === true,
            onChange: (event: { target: { checked: boolean } }) => {
              props.checkbox?.onChange(event.target.checked);
            }
          }),
          h('span', { style: { fontSize: '12px' } }, props.label)
        );
  return h(
    'div',
    { style: S.field, ...(props.path === undefined ? {} : { 'data-reflex-path': props.path }) },
    h(
      'div',
      { style: S.labelRow },
      control,
      hasHelp
        ? h(
            'button',
            {
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
            },
            '?'
          )
        : null
    ),
    hasHelp ? h('span', { id: helpId, role: 'note', style: open ? S.helpText : S.helpSrOnly }, props.help) : null,
    props.hint === undefined ? null : h('span', { style: S.hint }, props.hint)
  );
}

/**
 * A `Field` whose label, example value and `(?)` copy come from the field guide.
 *
 * Callers pass the Host schema path, so the label/placeholder/help triple cannot
 * drift between the page and the guide table. Dynamic families (tool switches,
 * intervention capabilities) supply their own label and help text and use the
 * wildcard row for the rest.
 */
function GuidedField(props: {
  t: Translate;
  path: string;
  label?: string;
  help?: string;
  hint?: string;
  value?: string;
  onChange?: (value: string) => void;
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  checkbox?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void };
  children?: ReactNode;
}): ReactNode {
  const family = props.path.split('.').slice(0, -1).join('.');
  const guide = guideFor(props.path) ?? (family.length === 0 ? undefined : templateGuideFor(family));
  const label = props.label ?? (guide?.labelKey === undefined ? props.path : props.t(guide.labelKey));
  const help = props.help ?? (guide === undefined ? '' : props.t(guide.helpKey));
  // A component rendered through `h(GuidedField, props)` arrives with an empty
  // children array; treat that as "no explicit control" so the default control
  // is still built.
  const explicitChildren = Array.isArray(props.children) && props.children.length === 0 ? undefined : props.children;
  const control =
    explicitChildren ??
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
  return h(
    Field,
    {
      label,
      path: props.path,
      help,
      helpLabel: interpolate(props.t('helpAbout'), { field: label }),
      hint: props.hint,
      checkbox: props.checkbox
    },
    control
  );
}

/** A colour-coded level chip. */
function LevelChip(props: { level: string; label?: string }): ReactNode {
  return h(
    'span',
    { style: { ...S.chip, color: token(levelTone(props.level), 'inherit') } },
    h('span', { style: S.swatch }),
    props.label ?? props.level
  );
}

/** Options of an effort-policy select: leave untouched, or adapt per turn. */
function effortPolicyOptions(t: Translate): { value: string; label: string }[] {
  return [
    { value: '', label: t('effortUnset') },
    { value: ADAPTIVE_EFFORT_POLICY, label: t('effortAdaptive') }
  ];
}

/** Options of a fallback-level select. */
function adaptiveLevelOptions(): { value: string; label: string }[] {
  return ADAPTIVE_EFFORT_LEVELS.map((value) => ({ value, label: value }));
}

/** One-character glyph that keeps the three icon states distinguishable without colour. */
function statusGlyph(state: PanelStatusState): string {
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
function Header(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const status = panelStatus(state.snapshot);
  const degraded = systemOneDegraded(state.snapshot);
  const degradedReason = degraded === undefined || degraded.reason.length === 0 ? t('systemOneDegradedUnknown') : degraded.reason;
  const canWrite = state.writable && state.configStatus === 'ready';
  const statusLabel =
    status === undefined
      ? ''
      : interpolate(t('statusLabel'), {
          routing: interpolate(t(status.routing.key), status.routing.values ?? {}),
          effort: interpolate(t(status.effort.key), status.effort.values ?? {}),
          backend: interpolate(t(status.backend.key), status.backend.values ?? {})
        });
  const statusTitle =
    status === undefined ? '' : status.lines.map((line) => interpolate(t(line.key), line.values ?? {})).join('\n');
  return h(
    'header',
    { style: S.header },
    h(
      'div',
      { style: S.titleRow },
      h('h3', { style: S.title }, t('title')),
      status === undefined
        ? null
        : h(
            'button',
            {
              type: 'button',
              'data-reflex-status': status.state,
              'aria-label': statusLabel,
              title: statusTitle,
              style: { ...S.statusButton, color: token(status.tone, 'inherit') }
            },
            h('span', { 'aria-hidden': 'true', style: S.statusGlyph }, statusGlyph(status.state))
          )
    ),
    h('span', { style: S.subtitle }, t('subtitle')),
    degraded === undefined
      ? null
      : h(
          'div',
          { style: S.banner, 'data-reflex-degraded': 'true', role: 'status' },
          h('span', null, interpolate(t('systemOneDegraded'), { reason: degradedReason })),
          Button({ label: t('refresh'), onClick: () => void store.refresh() })
        ),
    h(
      'div',
      { style: S.actions },
      Button({ label: t('refresh'), onClick: () => void store.refresh() }),
      Button({ label: t('save'), kind: 'primary', disabled: !canWrite || state.saving, onClick: () => void store.save() }),
      Button({ label: t('reset'), disabled: !canWrite, onClick: () => store.reset() }),
      state.saving ? h('span', { style: S.hint }, t('saving')) : null,
      state.notice === null ? null : h('span', { style: S.notice }, interpolate(t(state.notice), state.noticeValues ?? {}))
    )
  );
}

/** Overview page: live metrics, backend identity, and the latest adaptive decision. */
function OverviewTab(props: { t: Translate; state: PanelState }): ReactNode {
  const { t, state } = props;
  const snapshot = state.snapshot;
  const latest = snapshot?.effort?.latest ?? null;
  const pools = snapshot?.routing?.pools ?? [];
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('tabOverview'),
      children: h(
        'div',
        { style: S.grid },
        ...overviewMetrics(snapshot).map((metric) => h(Metric, { key: metric.id, label: t(metric.labelKey), value: metric.value }))
      )
    }),
    Card({
      title: t('groupRouting'),
      children:
        pools.length === 0
          ? h('div', { style: S.empty }, t('poolEmpty'))
          : h(
              'div',
              { style: S.grid },
              ...pools.map((pool) =>
                h(Metric, {
                  key: String(pool.model ?? ''),
                  label: String(pool.model ?? ''),
                  value: `${String((pool.entries ?? []).length)} ${t('poolCandidates')}`
                })
              )
            )
    }),
    Card({
      title: t('effortLatest'),
      children:
        latest === null
          ? h('div', { style: S.empty }, t('effortNoDecision'))
          : h(
              'div',
              { style: S.field },
              h(
                'div',
                { style: S.row },
                LevelChip({ level: String(latest.level ?? ''), label: String(latest.applied ?? latest.level ?? '') }),
                h('span', { style: S.hint }, `${String(latest.trigger ?? '')} · ${String(latest.source ?? '')} · ${String(latest.latencyMs ?? 0)} ms`),
                h('span', { style: S.hint }, `${String(latest.provider ?? '')}:${String(latest.model ?? '')}`)
              ),
              h('div', { style: S.mono }, String(latest.line ?? '')),
              latest.degradedReason === undefined ? null : h('div', { style: S.hint }, String(latest.degradedReason))
            )
    })
  );
}

/** Routing page: the virtual provider and its ordered model pools. */
function RoutingTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const setRouting = (patch: Partial<PanelDraft['routing']>): void => {
    store.edit((current) => ({ ...current, routing: { ...current.routing, ...patch } }));
  };
  const setPoolModel = (index: number, model: string): void => {
    store.editPools((pools) => pools.map((pool, position) => (position === index ? { ...pool, model } : pool)));
  };
  const setEntry = (index: number, entry: number, patch: Partial<PanelDraft['routing']['pools'][number]['entries'][number]>): void => {
    store.editPools((pools) =>
      pools.map((pool, position) =>
        position === index
          ? { ...pool, entries: pool.entries.map((candidate, at) => (at === entry ? { ...candidate, ...patch } : candidate)) }
          : pool
      )
    );
  };
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('groupRouting'),
      children: h(
        'div',
        { style: S.field },
        GuidedField({
          t,
          path: 'routing.enabled',
          checkbox: { checked: draft.routing.enabled, disabled, onChange: (checked) => setRouting({ enabled: checked }) }
        }),
        h(
          'div',
          { style: S.fieldRow },
          GuidedField({ t, path: 'routing.virtualProvider', value: draft.routing.virtualProvider, disabled, mono: true, onChange: (value) => setRouting({ virtualProvider: value }) }),
          GuidedField({ t, path: 'routing.fallback', value: draft.routing.fallback, disabled, mono: true, onChange: (value) => setRouting({ fallback: value }) }),
          GuidedField({ t, path: 'routing.maxTaskChars', value: draft.routing.maxTaskChars, disabled, onChange: (value) => setRouting({ maxTaskChars: value }) })
        )
      )
    }),
    Card({
      title: t('labelPools'),
      children: h(
        'div',
        { style: S.field },
        draft.routing.pools.length === 0 ? h('div', { style: S.empty }, t('poolEmpty')) : null,
        ...draft.routing.pools.map((pool, index) =>
          h(
            'div',
            { key: `pool-${String(index)}`, style: S.pool },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.label }, t('poolModelId')),
              TextInput({ value: pool.model, disabled, mono: true, placeholder: 'reflex-pro', onChange: (value) => setPoolModel(index, value) }),
              Button({ label: t('poolAddEntry'), small: true, disabled, onClick: () => store.addCandidate(index) }),
              Button({ label: t('poolRemoveModel'), small: true, kind: 'danger', disabled, onClick: () => store.removePool(index) })
            ),
            ...pool.entries.map((entry, at) => {
              const catalog = state.snapshot?.modelCatalog ?? [];
              const selectedGroup = catalog.find((g: any) => g.id === entry.provider);
              const availableModels = selectedGroup?.models ?? [];
              return h(
                'div',
                { key: `entry-${String(index)}-${String(at)}`, style: S.candidateCard },
                // 第一行：Provider 选择 + Model 选择 + 排序/删除操作按钮
                h(
                  'div',
                  { style: S.candidateRow1 },
                  catalog.length > 0
                    ? h(
                        'select',
                        {
                          style: { ...S.input, flex: '1 1 140px', minWidth: '120px' },
                          disabled,
                          value: entry.provider,
                          onChange: (e: any) => {
                            const newProv = e.target.value;
                            const group = catalog.find((g: any) => g.id === newProv);
                            const firstModel = group?.models?.[0]?.id ?? '';
                            setEntry(index, at, { provider: newProv, model: firstModel });
                          }
                        },
                        h('option', { value: '' }, `-- ${t('poolEntryProvider')} --`),
                        ...catalog.map((g: any) => h('option', { key: g.id, value: g.id }, g.name || g.id))
                      )
                    : TextInput({ value: entry.provider, disabled, mono: true, placeholder: t('poolEntryProvider'), onChange: (value) => setEntry(index, at, { provider: value }) }),
                  availableModels.length > 0
                    ? h(
                        'select',
                        {
                          style: { ...S.input, flex: '1.5 1 180px', minWidth: '140px' },
                          disabled,
                          value: entry.model,
                          onChange: (e: any) => setEntry(index, at, { model: e.target.value })
                        },
                        h('option', { value: '' }, `-- ${t('poolEntryModel')} --`),
                        ...availableModels.map((m: any) => h('option', { key: m.id, value: m.id }, m.name || m.id))
                      )
                    : TextInput({ value: entry.model, disabled, mono: true, placeholder: t('poolEntryModel'), onChange: (value) => setEntry(index, at, { model: value }) }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '4px', flex: '0 0 auto', marginLeft: 'auto' } },
                    Button({ label: '↑', title: t('poolMoveUp'), small: true, disabled: disabled || at === 0, onClick: () => store.moveCandidate(index, at, -1) }),
                    Button({ label: '↓', title: t('poolMoveDown'), small: true, disabled: disabled || at === pool.entries.length - 1, onClick: () => store.moveCandidate(index, at, 1) }),
                    Button({ label: '×', title: t('poolRemoveEntry'), small: true, kind: 'danger', disabled, onClick: () => store.removeCandidate(index, at) })
                  )
                ),
                // 第二行：能力说明 + 特征标签（宽敞横向排开）
                h(
                  'div',
                  { style: S.candidateRow2 },
                  h('div', { style: { flex: '1.8 1 200px' } }, TextInput({ value: entry.description, disabled, placeholder: t('poolEntryDescription'), onChange: (value) => setEntry(index, at, { description: value }) })),
                  h('div', { style: { flex: '1.2 1 140px' } }, TextInput({ value: entry.tags, disabled, placeholder: t('poolEntryTags'), onChange: (value) => setEntry(index, at, { tags: value }) }))
                )
              );
            })
          )
        ),
        Button({ label: t('poolAddModel'), small: true, disabled, onClick: () => store.addPool() })
      )
    })
  );
}

/** Effort page: the adaptive policy, its floor, and the last decision's shape. */
function EffortTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const setEffort = (patch: Partial<PanelDraft['effort']>): void => {
    store.edit((current) => ({ ...current, effort: { ...current.effort, ...patch } }));
  };
  const latest = state.snapshot?.effort?.latest ?? null;
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('groupEffort'),
      children: h(
        'div',
        { style: S.field },
        GuidedField({
          t,
          path: 'effort.enabled',
          checkbox: { checked: draft.effort.enabled, disabled, onChange: (checked) => setEffort({ enabled: checked }) }
        }),
        h('div', { style: S.hint }, t('effortDisabledHint')),
        h(
          'div',
          { style: S.fieldRow },
          GuidedField({
            t,
            path: 'effort.setting',
            hint: t('effortHint'),
            value: normalizeEffortPolicy(draft.effort.setting),
            options: effortPolicyOptions(t),
            disabled,
            onChange: (value) => setEffort({ setting: value })
          }),
          GuidedField({
            t,
            path: 'effort.fallback',
            value: draft.effort.fallback,
            options: adaptiveLevelOptions(),
            disabled,
            onChange: (value) => setEffort({ fallback: value })
          }),
          GuidedField({
            t,
            path: 'effort.minConfidence',
            value: draft.effort.minConfidence,
            disabled,
            onChange: (value) => setEffort({ minConfidence: value })
          })
        )
      )
    }),
    Card({
      title: t('effortLatest'),
      children:
        latest === null
          ? h('div', { style: S.empty }, t('effortNoDecision'))
          : h(
              'table',
              { style: S.table },
              h(
                'tbody',
                null,
                ...([
                  [t('labelEffortSetting'), String(latest.level ?? '')],
                  [t('backendActive'), `${String(latest.provider ?? '')}:${String(latest.model ?? '')}`],
                  ['trigger', String(latest.trigger ?? '')],
                  ['source', String(latest.source ?? '')],
                  ['confidence', String(latest.confidence ?? '')],
                  [t('colLatency'), `${String(latest.latencyMs ?? 0)} ms`],
                  [t('colDetail'), String(latest.line ?? '')]
                ] as [string, string][]).map(([label, value]) =>
                  h('tr', { key: label }, h('td', { style: { ...S.td, ...S.label, width: '140px' } }, label), h('td', { style: S.td }, value))
                )
              )
            )
    })
  );
}

/** Backend page: the System 1 connection and the runtime-level fields. */
function BackendTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const systemOne = state.snapshot?.systemOne;
  const setBackend = (patch: Partial<PanelDraft['backend']>): void => {
    store.edit((current) => ({ ...current, backend: { ...current.backend, ...patch } }));
  };
  const setRuntime = (patch: Partial<PanelDraft['runtime']>): void => {
    store.edit((current) => ({ ...current, runtime: { ...current.runtime, ...patch } }));
  };
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('groupBackend'),
      children: h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.fieldRow },
          GuidedField({
            t,
            path: 'backend',
            value: draft.backend.backend,
            options: BACKEND_CHOICES.map((value) => ({ value, label: value })),
            disabled,
            onChange: (value) => {
              if (value === 'jev') {
                setBackend({
                  backend: value,
                  baseUrl: draft.backend.baseUrl || 'https://api.typesafe.ai/v1/systemone',
                  model: draft.backend.model || 'jev-latest',
                  apiKeyEnv: draft.backend.apiKeyEnv || 'JEV_API_KEY'
                });
              } else {
                setBackend({ backend: value });
              }
            }
          }),
          GuidedField({ t, path: 'systemOne.baseUrl', value: draft.backend.baseUrl, disabled, mono: true, onChange: (value) => setBackend({ baseUrl: value }) }),
          GuidedField({ t, path: 'systemOne.model', value: draft.backend.model, disabled, mono: true, onChange: (value) => setBackend({ model: value }) }),
          GuidedField({ t, path: 'systemOne.apiKeyEnv', hint: t('backendHint'), value: draft.backend.apiKeyEnv, disabled, mono: true, onChange: (value) => setBackend({ apiKeyEnv: value }) }),
          GuidedField({ t, path: 'systemOne.timeoutMs', value: draft.backend.timeoutMs, disabled, onChange: (value) => setBackend({ timeoutMs: value }) })
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, t('backendActive')),
          h('span', { style: S.mono }, String(systemOne?.active ?? '—')),
          systemOne?.apiKeyEnv === undefined
            ? null
            : h('span', { style: { ...S.hint, color: token(systemOne.apiKeyPresent === true ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-warn-primary', 'inherit') } }, `${systemOne.apiKeyEnv} · ${t(systemOne.apiKeyPresent === true ? 'apiKeyPresent' : 'apiKeyMissing')}`)
        )
      )
    }),
    Card({
      title: t('groupRuntime'),
      children: h(
        'div',
        { style: S.fieldRow },
        GuidedField({ t, path: 'toolPrefix', value: draft.runtime.toolPrefix, disabled, mono: true, onChange: (value) => setRuntime({ toolPrefix: value }) }),
        GuidedField({ t, path: 'pruneThreshold', value: draft.runtime.pruneThreshold, disabled, onChange: (value) => setRuntime({ pruneThreshold: value }) }),
        GuidedField({ t, path: 'ledgerPath', value: draft.runtime.ledgerPath, disabled, mono: true, onChange: (value) => setRuntime({ ledgerPath: value }) }),
        GuidedField({ t, path: 'calibrationPath', value: draft.runtime.calibrationPath, disabled, mono: true, onChange: (value) => setRuntime({ calibrationPath: value }) })
      )
    })
  );
}

/** Ledger page: summary, sink identity, recent decisions, and the clear action. */
function LedgerTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const rows = ledgerRows(state.snapshot);
  const logPath = state.snapshot?.ledger?.logPath ?? null;
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('tabLedger'),
      children: h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.grid },
          ...overviewMetrics(state.snapshot).map((metric) => h(Metric, { key: metric.id, label: t(metric.labelKey), value: metric.value }))
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, t('ledgerLogPath')),
          h('span', { style: S.mono }, logPath ?? t('ledgerMemoryOnly')),
          Button({
            label: state.confirmingClear ? t('ledgerClearConfirm') : t('ledgerClear'),
            kind: 'danger',
            small: true,
            onClick: () => void store.clearLedger()
          })
        )
      )
    }),
    Card({
      title: t('ledgerRecent'),
      children:
        rows.length === 0
          ? h('div', { style: S.empty }, t('ledgerEmpty'))
          : h(
              'table',
              { style: S.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ...[t('colTime'), t('colType'), t('colBackend'), t('colLatency'), t('colTokens'), t('colDetail')].map((label) =>
                    h('th', { key: label, style: S.th }, label)
                  )
                )
              ),
              h(
                'tbody',
                null,
                ...rows.map((row) =>
                  h(
                    'tr',
                    { key: row.id },
                    h('td', { style: { ...S.td, ...S.mono } }, row.clock),
                    h('td', { style: { ...S.td, color: token(row.tone, 'inherit') } }, t(row.typeKey)),
                    h('td', { style: S.td }, row.backend),
                    h('td', { style: { ...S.td, fontVariantNumeric: 'tabular-nums' } }, row.latency),
                    h('td', { style: { ...S.td, fontVariantNumeric: 'tabular-nums' } }, row.tokens),
                    h('td', { style: S.td }, row.detail)
                  )
                )
              )
            )
    })
  );
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
function GuideTab(props: { t: Translate }): ReactNode {
  const { t } = props;
  return h(
    'div',
    { style: S.root },
    h(
      'section',
      { style: S.card },
      h('h4', { style: S.cardTitle }, t('guideTitle')),
      h('p', { style: S.paragraph }, t('guideIntro')),
      h('p', { style: S.hint }, t('guideHint')),
      h('p', { style: S.mono }, interpolate(t('guideProvenance'), { source: t('guideSource'), digest: t('guideRevision') }))
    ),
    renderMarkdown(t('guideBody'))
  );
}

/** Copy key of one three-state (or `inherit`) intervention setting. */
function interventionModeCopyKey(value: string): string {
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
function interventionModeOptions(t: Translate, withInherit: boolean): { value: string; label: string }[] {
  return (withInherit ? INTERVENTION_SETTINGS : INTERVENTION_MODES).map((value) => ({
    value,
    label: t(interventionModeCopyKey(value))
  }));
}

/** Capability name → copy key of its field label. */
const CAPABILITY_COPY: Record<string, string> = {
  stagnation: 'labelCapabilityStagnation',
  prune: 'labelCapabilityPrune',
  gate: 'labelCapabilityGate',
  closing: 'labelCapabilityClosing'
};

/** Automatic-intervention page: the master mode, the per-capability overrides, and the budgets. */
function InterventionsTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const setInterventions = (patch: Partial<PanelDraft['interventions']>): void => {
    store.edit((current) => ({ ...current, interventions: { ...current.interventions, ...patch } }));
  };
  const setCapability = (capability: string, value: string): void => {
    store.edit((current) => ({
      ...current,
      interventions: { ...current.interventions, capabilities: { ...current.interventions.capabilities, [capability]: value } }
    }));
  };
  const effective = state.snapshot?.interventions;
  const budgetField = (key: keyof PanelDraft['interventions']): ReactNode =>
    GuidedField({
      t,
      path: `interventions.${String(key)}`,
      value: String(draft.interventions[key] ?? ''),
      disabled,
      onChange: (value) => setInterventions({ [key]: value } as Partial<PanelDraft['interventions']>)
    });
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('groupInterventions'),
      children: h(
        'div',
        { style: S.field },
        h('div', { style: S.hint }, t('interventionsHint')),
        h(
          'div',
          { style: S.fieldRow },
          GuidedField({
            t,
            path: 'interventions.mode',
            hint: t('interventionModeHint'),
            value: draft.interventions.mode,
            options: interventionModeOptions(t, false),
            disabled,
            onChange: (value) => setInterventions({ mode: value })
          }),
          ...INTERVENTION_CAPABILITIES.map((capability) =>
            h(GuidedField, {
              key: capability,
              t,
              path: `interventions.capabilities.${capability}`,
              label: t(CAPABILITY_COPY[capability] ?? capability),
              help: interpolate(t('helpCapability'), {
                name: t(CAPABILITY_COPY[capability] ?? capability),
                mode: draft.interventions.mode
              }),
              value: draft.interventions.capabilities[capability] ?? 'inherit',
              options: interventionModeOptions(t, true),
              disabled,
              onChange: (value: string) => setCapability(capability, value)
            })
          )
        ),
        h(
          'div',
          { style: S.fieldRow },
          budgetField('maxInterventionsPerTurn'),
          budgetField('maxJudgmentsPerTurn'),
          budgetField('maxJudgmentsPerSession'),
          budgetField('repeatThreshold'),
          budgetField('failureThreshold'),
          budgetField('windowSize'),
          budgetField('minConfidence'),
          budgetField('pruneFloorRatio'),
          budgetField('pruneHeadChars'),
          budgetField('pruneTailChars'),
          GuidedField({
            t,
            path: 'interventions.pruneJudgeMinChars',
            value: draft.interventions.pruneJudgeMinChars,
            disabled,
            onChange: (value) => setInterventions({ pruneJudgeMinChars: value })
          }),
          budgetField('claimMinConfidence'),
          budgetField('closingEvidenceChars'),
          GuidedField({
            t,
            path: 'interventions.intent',
            value: draft.interventions.intent,
            disabled,
            onChange: (value) => setInterventions({ intent: value })
          })
        )
      )
    }),
    Card({
      title: t('interventionsEffective'),
      children:
        effective === undefined
          ? h('div', { style: S.empty }, t('effectiveUnknown'))
          : h(
              'table',
              { style: S.table },
              h(
                'tbody',
                null,
                ...[
                  [t('labelInterventionMode'), String(effective.mode ?? '')],
                  [t('effectiveActing'), t(effective.acting === true ? 'modeActive' : effective.enabled === true ? 'modeObserve' : 'modeOff')],
                  ...INTERVENTION_CAPABILITIES.map((capability) => [
                    t(CAPABILITY_COPY[capability] ?? capability),
                    String(effective.capabilities?.[capability] ?? '')
                  ])
                ].map(([label, value]) =>
                  h('tr', { key: label }, h('td', { style: { ...S.td, ...S.label, width: '180px' } }, label), h('td', { style: S.td }, value))
                )
              )
            )
    })
  );
}

/** Dictionary key of one advice label. */
function toolAdviceKey(advice: ToolAdvice): string {
  return advice === 'expose' ? 'toolAdviceExpose' : 'toolAdviceOptional';
}

/**
 * Tone of one advice label: a colour on the existing chip, not a new component.
 * @param advice - the advice being shown.
 * @returns the CSS custom property, with a literal fallback.
 */
function toolAdviceTone(advice: ToolAdvice): string {
  return advice === 'expose'
    ? token('--dsw-alias-state-success-primary', '#4ade80')
    : token('--dsw-alias-state-warn-primary', '#d9a441');
}

/** Tool-switch page: one toggle per reflex tool, plus the effective registration. */
function ToolsTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const setTool = (suffix: string, enabled: boolean): void => {
    store.edit((current) => ({ ...current, tools: { enabled: { ...current.tools.enabled, [suffix]: enabled } } }));
  };
  // Advice drives both the labels and this button, so "recommended" is stated
  // once. Applying it only pre-fills the draft: the group is written when the
  // user saves, through the same single write channel as every other field.
  const applyRecommended = (): void => {
    const recommended = recommendedToolSwitches();
    store.edit((current) => ({ ...current, tools: { enabled: { ...current.tools.enabled, ...recommended } } }));
  };
  const active = state.snapshot?.tools?.active;
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('groupTools'),
      children: h(
        'div',
        { style: S.field },
        h('div', { style: S.hint }, t('toolsHint')),
        h(
          'div',
          { style: S.toolActions },
          Button({ label: t('toolsApplyRecommended'), onClick: applyRecommended, disabled }),
          h('span', { style: S.hint }, t('toolsRecommendedHint'))
        ),
        h(
          'div',
          { style: S.toolList },
          // The label is the *registered* name under the current draft prefix, so
          // renaming the prefix shows up here immediately; the switch itself is
          // keyed by suffix and therefore survives the rename.
          ...REFLEX_TOOL_SUFFIXES.map((suffix) => {
            const advice = TOOL_ADVICE[suffix];
            return h(
              'div',
              { key: suffix, style: S.toolRow },
              h(
                'div',
                { style: S.toolHead },
                GuidedField({
                  t,
                  path: `tools.enabled.${suffix}`,
                  // The label is the registered name under the current prefix.
                  label: `${draft.runtime.toolPrefix}${suffix}`,
                  help: interpolate(t('helpToolSwitch'), {
                    what: t(`toolWhat_${suffix}`).replace(/[。.]$/, ''),
                    default: (draft.tools.enabled[suffix] ?? TOOL_DEFAULT_ENABLED[suffix]) ? t('helpSwitchOn') : t('helpSwitchOff')
                  }),
                  // The switch shows the *effective* state, so a suffix the
                  // deployment never mentioned reads its documented default
                  // (`route` starts off) instead of an unconditional "on".
                  checkbox: {
                    checked: draft.tools.enabled[suffix] ?? TOOL_DEFAULT_ENABLED[suffix],
                    disabled,
                    onChange: (checked) => setTool(suffix, checked)
                  }
                }),
                h(
                  'span',
                  { style: { ...S.chip, marginLeft: 'auto', color: toolAdviceTone(advice) } },
                  t(toolAdviceKey(advice))
                )
              ),
              h('span', { style: S.toolWhat }, t(`toolWhat_${suffix}`)),
              h('span', { style: S.hint }, t(`toolWhen_${suffix}`))
            );
          }),
          // The ledger is not a tool any more, so this page points at where it
          // went instead of listing a switch for it.
          h('div', { style: S.hint }, t('toolsLedgerHint'))
        )
      )
    }),
    Card({
      title: t('toolsEffective'),
      children:
        active === undefined
          ? h('div', { style: S.empty }, t('effectiveUnknown'))
          : active.length === 0
            ? h('div', { style: S.empty }, t('toolsAllClosed'))
            : h('div', { style: S.mono }, ...active.map((toolName) => h('div', { key: toolName }, toolName)))
    })
  );
}

/** Page body. */
function Body(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
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
export function createPanelComponent(ctx: any, t: Translate): (props: PanelProps) => ReactNode {
  return function ReflexPanel(props: PanelProps): ReactNode {
    const storeRef = useRef<PanelStore | null>(null);
    const form = useMemo(() => {
      let cfg = null;
      try {
        cfg = ctx?.get?.('configForms') ?? (typeof ctx?.configForms?.get === 'function' ? ctx.configForms : null);
      } catch {
        try {
          cfg = ctx?.get?.('configForms');
        } catch {}
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
          } catch {}
        }
        // If neither is served yet, return a local writable form so the panel is fully interactive
        return {
          getSnapshot: () => ({ status: 'ready' as const, value: {}, base: 0, user: 0, revision: 1, writable: true }),
          subscribe: () => () => {},
          mutate: async (ops: any) => {
            for (const candidate of candidates) {
              try {
                const candidateForm = cfg.get(candidate);
                await candidateForm?.mutate?.(ops);
              } catch {}
            }
            return true;
          }
        };
      }
      return {
        getSnapshot: () => ({ status: 'ready' as const, value: {}, base: 0, user: 0, revision: 1, writable: true }),
        subscribe: () => () => {},
        mutate: async () => true
      };
    }, [props.ns]);
    if (storeRef.current === null) {
      storeRef.current = new PanelStore({ form, fetch: (input, init) => fetch(input, init) });
    }
    const store = storeRef.current;
    useEffect(() => {
      store.start();
      return () => {
        store.dispose();
      };
    }, [store]);
    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
    const state = useSyncExternalStore(subscribe, () => store.getState());
    const selectTab = useCallback((tab: PanelTab) => store.setTab(tab), [store]);

    const statusNote =
      state.configStatus === 'unavailable'
        ? t('stateUnavailable')
        : state.configStatus === 'loading'
          ? t('stateLoading')
          : !state.writable
            ? t('readOnly')
            : null;

    return h(
      'div',
      { style: S.root },
      Header({ t, state, store }),
      statusNote === null ? null : h('div', { style: S.hint }, statusNote),
      state.errors.length === 0
        ? null
        : h('div', { style: S.errors }, ...state.errors.map((key) => h('div', { key }, t(key)))),
      state.error === null ? null : h('div', { style: S.errors }, `${t('refreshFailed')}: ${state.error}`),
      h(
        'nav',
        { style: S.tabs },
        ...PANEL_TABS.map((tab) =>
          h(
            'button',
            {
              key: tab,
              type: 'button',
              style: { ...S.tab, ...(state.tab === tab ? S.tabActive : {}) },
              onClick: () => selectTab(tab)
            },
            t(tabCopyKey(tab))
          )
        )
      ),
      Body({ t, state, store })
    );
  };
}

/** Copy key of one page's navigation label. */
function tabCopyKey(tab: PanelTab): string {
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
