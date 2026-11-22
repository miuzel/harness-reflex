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
  splitModelIds,
  systemOneDegraded,
  type PanelDraft,
  type PanelStatusState,
  type ProfileDraft,
  type ToolAdvice
} from './panel';
import { PanelStore, PANEL_TABS, acquireAutosave, type FormSnapshotLike, type PanelState, type PanelTab, type ProbeState } from './store';
import type { AutosaveMode } from './autosave';
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
  /**
   * The disclosure header of a folded card: looks like the card title, behaves
   * like a button (focusable, keyboard-operable, `aria-expanded`).
   */
  foldHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    flexWrap: 'wrap',
    width: '100%',
    padding: 0,
    margin: 0,
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer'
  },
  foldCaret: { fontSize: '11px', color: token('--dsw-alias-label-tertiary', '#8a8a8a') },
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
  /** One profile row: a bordered block so several profiles stay visually apart. */
  profileRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    border: `1px solid ${token('--dsw-alias-border-primary', 'rgba(255,255,255,.12)')}`,
    borderRadius: '6px',
    padding: '8px 10px'
  },
  profileHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  profileName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', fontWeight: 600 },
  /** The name badge of a row the user filled in but never named (g-064). */
  profileUnnamedTag: {
    fontSize: '11px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: '4px',
    color: token('--dsw-alias-state-warn-primary', '#fbbf24'),
    border: `1px solid ${token('--dsw-alias-state-warn-primary', '#fbbf24')}`
  },
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

/**
 * A titled card whose body folds away behind a disclosure header.
 *
 * Used for surfaces that must stay *reachable* but must stop competing for
 * attention — the flat connection block after g-058, which profiles now supersede
 * for editing while remaining the documented fallback of the resolution chain.
 * Collapsed by default, and collapse is purely presentational: the fields render
 * the same draft and write through the same narrow paths whether or not they are
 * on screen, so folding can never change what a save writes.
 */
function FoldedCard(props: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}): ReactNode {
  const { open } = props;
  return h(
    'section',
    { style: S.card, 'data-reflex-folded': open ? 'open' : 'closed' },
    h(
      'button',
      {
        type: 'button',
        style: S.foldHead,
        'aria-expanded': open ? 'true' : 'false',
        onClick: props.onToggle
      },
      h('span', { style: S.foldCaret }, open ? '▾' : '▸'),
      h('span', { style: S.cardTitle }, props.title),
      open ? null : h('span', { style: S.hint }, props.summary)
    ),
    open ? props.children : null
  );
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

/**
 * A text input bound to a draft field.
 *
 * `multiline` renders a `<textarea>` instead, for a field that holds a *list*:
 * the model ids of one connection are one-per-line, and a single-line input
 * would hide every entry but the one under the cursor. Both controls route
 * their edits through the same `onChange` (the draft field), never through an
 * implicit commit: the value is only written to the Host on an explicit save.
 */
function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  multiline?: boolean;
}): ReactNode {
  const shared = {
    style: { ...S.input, ...(props.mono === true ? S.mono : {}), ...(props.multiline === true ? { minHeight: '4.5em', resize: 'vertical' } : {}) },
    value: props.value,
    placeholder: props.placeholder ?? '',
    disabled: props.disabled === true,
    onChange: (event: { target: { value: string } }) => {
      props.onChange(event.target.value);
    }
  };
  if (props.multiline === true) return h('textarea', { ...shared, rows: 3 });
  return h('input', { ...shared, type: 'text' });
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
 *
 * Two edit signals, because the two control families differ in kind (g-069): a
 * `select` or a checkbox is a decision and saves at once, while a text box emits
 * one change per keystroke and is debounced. That is why `text` exists rather
 * than the caller passing a mode: a text field is written one character at a
 * time, so it can only be a series of edits to coalesce.
 */
function GuidedField(props: {
  t: Translate;
  path: string;
  label?: string;
  help?: string;
  hint?: string;
  value?: string;
  /** A decision (a select): its change saves at once. */
  onChange?: (value: string) => void;
  /** Typing (a text box): its changes are coalesced until the user pauses. */
  onText?: (value: string) => void;
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  /** Render a textarea for a list-valued field (one entry per line). */
  multiline?: boolean;
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
            onChange: props.onText ?? props.onChange ?? (() => undefined),
            placeholder: props.placeholder ?? guide?.placeholder,
            mono: props.mono === true,
            disabled: props.disabled === true,
            multiline: props.multiline === true
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
  // Autosave has no Save press to press (g-069): the page states what the queue
  // is doing — waiting for a pause, saving, saved — and, when a write failed,
  // why, with the retry and the discard that go with a kept draft.
  const autosave = state.autosave;
  // A failure line has to stay a line: the reason is whatever the Host or the
  // network said, and a stack-trace-shaped message would push the status bar off
  // the page. The full text stays in the state — this only bounds what is drawn.
  const reasonText = autosave.reason ?? '—';
  const shownReason = reasonText.length > 160 ? `${reasonText.slice(0, 159)}…` : reasonText;
  const autosaveLine =
    autosave.phase === 'failed'
      ? h(
          'span',
          { style: { ...S.errors, 'data-autosave': 'failed' } },
          h('span', { title: reasonText }, `${t('autosaveFailed')}: ${shownReason}`),
          Button({ label: t('autosaveRetry'), small: true, disabled: !canWrite, onClick: () => void store.retryAutosave() }),
          Button({ label: t('autosaveDiscard'), small: true, kind: 'danger', disabled: !canWrite, onClick: () => store.discardRetained() })
        )
      : autosave.phase === 'idle'
        ? null
        : h(
            'span',
            { style: S.hint, 'data-autosave': autosave.phase },
            t(
              autosave.phase === 'pending'
                ? 'autosavePending'
                : autosave.phase === 'saving'
                  ? 'saving'
                  : 'saved'
            )
          );
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
      Button({ label: t('reset'), disabled: !canWrite, onClick: () => store.reset() }),
      autosaveLine,
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
  const setRouting = (patch: Partial<PanelDraft['routing']>, mode: AutosaveMode = 'immediate'): void => {
    store.edit((current) => ({ ...current, routing: { ...current.routing, ...patch } }), mode);
  };
  const setPoolModel = (index: number, model: string, mode: AutosaveMode = 'immediate'): void => {
    store.editPools((pools) => pools.map((pool, position) => (position === index ? { ...pool, model } : pool)), mode);
  };
  const setEntry = (
    index: number,
    entry: number,
    patch: Partial<PanelDraft['routing']['pools'][number]['entries'][number]>,
    mode: AutosaveMode = 'immediate'
  ): void => {
    store.editPools(
      (pools) =>
        pools.map((pool, position) =>
          position === index
            ? { ...pool, entries: pool.entries.map((candidate, at) => (at === entry ? { ...candidate, ...patch } : candidate)) }
            : pool
        ),
      mode
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
          GuidedField({ t, path: 'routing.virtualProvider', value: draft.routing.virtualProvider, disabled, mono: true, onText: (value) => setRouting({ virtualProvider: value }, 'text') }),
          GuidedField({ t, path: 'routing.fallback', value: draft.routing.fallback, disabled, mono: true, onText: (value) => setRouting({ fallback: value }, 'text') }),
          GuidedField({ t, path: 'routing.maxTaskChars', value: draft.routing.maxTaskChars, disabled, onText: (value) => setRouting({ maxTaskChars: value }, 'text') })
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
              TextInput({ value: pool.model, disabled, mono: true, placeholder: 'reflex-pro', onChange: (value) => setPoolModel(index, value, 'text') }),
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
                    : TextInput({ value: entry.provider, disabled, mono: true, placeholder: t('poolEntryProvider'), onChange: (value) => setEntry(index, at, { provider: value }, 'text') }),
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
                    : TextInput({ value: entry.model, disabled, mono: true, placeholder: t('poolEntryModel'), onChange: (value) => setEntry(index, at, { model: value }, 'text') }),
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
                  h('div', { style: { flex: '1.8 1 200px' } }, TextInput({ value: entry.description, disabled, placeholder: t('poolEntryDescription'), onChange: (value) => setEntry(index, at, { description: value }, 'text') })),
                  h('div', { style: { flex: '1.2 1 140px' } }, TextInput({ value: entry.tags, disabled, placeholder: t('poolEntryTags'), onChange: (value) => setEntry(index, at, { tags: value }, 'text') }))
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
  const setEffort = (patch: Partial<PanelDraft['effort']>, mode: AutosaveMode = 'immediate'): void => {
    store.edit((current) => ({ ...current, effort: { ...current.effort, ...patch } }), mode);
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
            onText: (value) => setEffort({ minConfidence: value }, 'text')
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

/**
 * Whether renaming this saved row asks for its stored key again.
 *
 * True exactly when the row's key is a **literal stored in the settings
 * document** (`apiKeyFromProfile`), the name it is saved under differs from the
 * name it is being saved as, and the draft states no new value for it. That is
 * the one combination where the key cannot survive: the Host retires the old
 * subtree and cannot move a secret to another path.
 *
 * Deliberately false for the other two ways a resolved key can exist:
 *
 * - the key comes from an **environment variable** (`apiKeyFromProfile` false,
 *   `apiKeyPresent` true): the variable is named, not re-stored, so a rename
 *   changes nothing about it and renaming stays free;
 * - the user **retyped** the key in this save (`apiKey` non-empty) or **cleared**
 *   it on purpose (`clearKey`): the new path states its own answer.
 *
 * @param profile - the draft row.
 * @param savedName - the name it is saved under (empty for an unsaved row).
 * @param draftName - the name it is being saved as.
 * @returns whether the row must ask for the key again.
 */
function renameNeedsKey(profile: ProfileDraft, savedName: string, draftName: string): boolean {
  if (savedName.length === 0 || draftName.length === 0 || savedName === draftName) return false;
  if (!profile.apiKeyPresent || !profile.apiKeyFromProfile) return false;
  return profile.apiKey.trim().length === 0 && !profile.clearKey;
}

/**
 * The single model a connection runs, chosen from the ids it lists.
 *
 * Why a radio group rather than a text field: `selectedModel` must be one of
 * `modelIds`, and free text makes "selected a model that does not exist" a state
 * a user can type themselves into. Here it cannot be typed — but it can still
 * *arise* from a list edit (the selected id was deleted), which is why the group
 * also reports a selection that no longer matches and why the save refuses one.
 *
 * With exactly one listed id the group renders as a plain statement: there is
 * nothing to choose, and a single radio button reads as a decision the user has
 * to re-confirm.
 */
function ModelSelection(props: {
  t: Translate;
  profile: ProfileDraft;
  disabled: boolean;
  onEdit: (patch: Partial<ProfileDraft>, mode?: AutosaveMode) => void;
}): ReactNode {
  const { t, profile, disabled, onEdit } = props;
  const ids = splitModelIds(profile.modelIds);
  const selection = profile.selectedModel.trim();
  // Blank means "the first listed id", which is exactly what the runtime
  // resolves for a connection that names no selection at all.
  const effective = selection.length > 0 ? selection : (ids[0] ?? '');
  const offList = selection.length > 0 && ids.length > 0 && !ids.includes(selection);
  if (ids.length === 0) return null;
  // Rendered through `Field` so it carries the same contract as every other
  // field of the page: a label, a stable help id, and the `(?)` disclosure.
  // It is *rendered as an element*, never invoked directly: `Field` owns a
  // `useState` (its `(?)` disclosure), and calling a stateful component as a
  // plain function puts that hook into the caller's sequence — the #310 crash
  // this page already shipped once. `client-hooks.test.ts` guards it.
  // The control is the **third argument**, the same way every other `Field` on
  // the page is built (see `GuidedField`). Passing it as `children` *inside* the
  // props object loses it: `h` treats the third argument as the children and
  // overwrites `props.children` with an empty array, so the field rendered with
  // its label and `(?)` but no radio buttons at all (g-066 att-002 — caught by
  // the page-level regression, not by any unit test of the group).
  return h(
    Field,
    {
      label: t('profileSelectedModel'),
      path: 'systemOne.profiles.selectedModel',
      help: t('helpSelectedModel'),
      helpLabel: interpolate(t('helpAbout'), { field: t('profileSelectedModel') })
    },
    h(
      'span',
      { style: { ...S.row, alignItems: 'center' }, 'data-profile-model-selection': profile.id },
      ids.length === 1
      ? h('span', { style: S.mono, 'data-profile-selected-model': ids[0] }, ids[0] ?? '')
      : h(
          'span',
          { style: { ...S.row, gap: '12px' } },
          ...ids.map((id) =>
            h(
              'label',
              {
                key: id,
                style: { ...S.row, gap: '4px', alignItems: 'center', cursor: disabled ? 'default' : 'pointer' },
                'data-profile-model-option': id
              },
              h('input', {
                type: 'radio',
                name: `reflex-profile-model-${profile.id}`,
                value: id,
                checked: id === effective,
                disabled,
                // Choosing a model is a draft edit like any other: nothing is
                // written until the user saves, so an exploratory click cannot
                // change what the running transport sends.
                //
                // A click on the model **already in force** is not a decision, and
                // must not be reported as one (g-070). `selectedModel` may be blank
                // while the row runs its first listed id, and `id === effective`
                // then still means "unchanged"; writing it would store a redundant
                // field, and reporting it as a decision cancelled the pause of a
                // model list the user was still typing — losing those keystrokes.
                // The comparison is against the *effective* selection, so clicking
                // the id the row already resolves to is a no-op in every case.
                onChange: () => {
                  if (id === effective) return;
                  onEdit({ selectedModel: id });
                }
              }),
              h('span', { style: S.mono }, id)
            )
          )
        ),
      // Why the runtime would send no model at all, spelled out where the fix is.
      offList
        ? h(
            'span',
            { style: { ...S.hint, color: token('--dsw-alias-state-warn-primary', '#fbbf24') }, 'data-profile-model-missing': 'true' },
            t('profileModelMissing').replace('{name}', selection)
          )
        : null
    )
  );
}

/**
 * One profile row: name, its connection fields, the write-only key input, the
 * active switch, the connection test, and the remove action.
 *
 * The key input is the point of the whole feature: it is never seeded from the
 * Host (no read carries the value), so it always renders empty with a
 * placeholder. A stored key is communicated by {@link apiKeyPresent} — a *fact*,
 * not the value — and can only be destroyed through the explicit Clear action.
 */
function ProfileRow(props: {
  t: Translate;
  profile: ProfileDraft;
  isActive: boolean;
  probe: ProbeState | undefined;
  /** Whether this row's name is in the Host snapshot, i.e. the Host can probe it. */
  saved: boolean;
  /**
   * The name this row is **saved** under, or `''` for a row the Host has not
   * read yet. Different from {@link ProfileDraft.name} exactly when the user has
   * renamed the row and not saved it.
   */
  savedName: string;
  disabled: boolean;
  store: PanelStore;
  onEdit: (patch: Partial<ProfileDraft>, mode?: AutosaveMode) => void;
}): ReactNode {
  const { t, profile, isActive, probe, saved, savedName, disabled, store, onEdit } = props;
  const name = profile.name.trim();
  const named = name.length > 0;
  // A row that carries content is one the user means to save, and an unnamed row
  // has no settings path, so the page must *say* it is unnamed rather than leave
  // a grey placeholder where a name would be (g-064: the row looked filled in
  // and the save looked clean, while nothing was written).
  const filled =
    [profile.baseUrl, profile.modelIds, profile.selectedModel, profile.apiKeyEnv, profile.timeoutMs, profile.backend, profile.apiKey].some(
      (field) => field.trim().length > 0
    ) || profile.clearKey;
  // The availability matrix (g-062). Activation writes the *draft*, so a named
  // row can be activated before it is saved; a probe reads the **saved** document
  // on the Host, so an unsaved row has nothing to probe; and an unnamed row can
  // be neither, because an empty name is not a settings path.
  //
  // Every disabled button carries its reason in `title` *and* in a visible note,
  // not just a dimmed paint: "nothing happens when I click" was the report.
  const activateBlocked = !named ? t('profileNeedName') : disabled ? t('profileWriteBlocked') : undefined;
  const testBlocked = !named
    ? t('profileNeedName')
    : !saved
      ? t('profileNeedSave')
      : probe?.phase === 'testing'
        ? t('profileTesting')
        : disabled
          ? t('profileWriteBlocked')
          : undefined;
  // The variable reported is the one the resolution reported, which is the one
  // that *supplied* the key when there is one, and the named-but-empty one when
  // the row locked onto a variable (g-059). A named row can no longer be served
  // by a different variable, so the two cases can no longer be confused.
  const keyVariable = profile.apiKeyFromProfile ? '' : profile.apiKeyVariable || profile.apiKeyEnv || '—';
  // A row the Host has never seen has no resolution answer, so its key state is
  // read off the *draft* instead (g-062): the snapshot simply cannot describe
  // the variable the user just typed, and rendering that absence as "no variable
  // named" contradicted the field sitting next to it.
  const draftVariable = profile.apiKeyEnv.trim();
  const keyState = !saved
    ? profile.apiKey.trim().length > 0
      ? t('profileKeyPendingLiteral')
      : draftVariable.length > 0
        ? t('profileKeyPendingEnv').replace('{name}', draftVariable)
        : t('profileKeyMissingPending')
    : profile.apiKeyPresent
      ? profile.apiKeyFromProfile
        ? t('profileKeyStored')
        : profile.apiKeySource === 'fallback'
          ? t('profileKeyFromFallback').replace('{name}', keyVariable)
          : t('profileKeyFromEnv').replace('{name}', keyVariable)
      : profile.apiKeyLocked
        ? t('profileKeyLocked').replace('{name}', keyVariable)
        : t('profileKeyMissing');
  const statusLabel = (status: string | undefined): string => {
    switch (status) {
      case 'ok':
        return t('profileTestOk');
      case 'auth-failed':
        return t('profileTestAuth');
      case 'unreachable':
        return t('profileTestUnreachable');
      case 'timeout':
        return t('profileTestTimeout');
      case 'bad-response':
        return t('profileTestBadResponse');
      case 'misconfigured':
        return t('profileTestMisconfigured');
      case 'model-unusable':
        return t('profileTestModelUnusable');
      default:
        return status ?? '—';
    }
  };
  return h(
    'div',
    { style: S.profileRow, 'data-profile': profile.id, 'data-profile-unnamed': named ? undefined : 'true' },
    h(
      'div',
      { style: S.profileHead },
      // The name is edited **here, always as an input** (g-066).
      //
      // It used to be a `<span>` once the row was named, and an `<input>` only
      // while it was not — so the first typed character renamed the row, swapped
      // the control under the caret, and the element that had focus was replaced
      // by text: the field looked locked after one keystroke and a *saved* row
      // could not be renamed at all. The control now stays an input for every
      // row, keyed by the row identity ({@link ProfileRow} is mounted with
      // `key: profile.id`), so React re-uses one DOM node for the whole edit and
      // nothing steals its focus, selection or caret.
      //
      // Editing it is still only a **draft** edit: nothing is written, committed
      // or activated until the explicit save.
      h('input', {
        type: 'text',
        style: { ...S.input, ...S.profileName, width: '13em', flex: '0 0 auto' },
        'data-profile-name': profile.id,
        placeholder: t('profileNamePlaceholder'),
        title: t('profileName'),
        value: profile.name,
        disabled,
        // No `key` prop: the node must be the *same* one across renders, which
        // is exactly what keeps the caret where the user left it.
        onChange: (event: { target: { value: string } }) => onEdit({ name: event.target.value }, 'text')
      }),
      // Worded, not just painted: the row says it is unnamed, and why that blocks
      // the save, in its own head line.
      named ? null : h('span', { style: S.profileUnnamedTag, 'data-profile-unnamed-tag': 'true' }, t('profileUnnamedTag')),
      isActive
        ? h('span', { style: { ...S.hint, color: token('--dsw-alias-state-success-primary', '#34d399') } }, t('profileActive'))
        : Button({
            label: t('profileActivate'),
            small: true,
            disabled: activateBlocked !== undefined,
            // The reason is the tooltip; it is also spelled out in the row's note
            // below, because a tooltip is unreachable on a disabled control in
            // several browsers.
            title: activateBlocked ?? t('profileActivate'),
            onClick: () => void store.setActiveProfile(profile.id)
          }),
      // The test is a server-side probe of the *saved* document: the button never
      // carries the key, and it cannot describe a row the Host has not read yet.
      Button({
        label: probe?.phase === 'testing' ? t('profileTesting') : t('profileTest'),
        small: true,
        disabled: testBlocked !== undefined,
        title: testBlocked ?? t('profileTest'),
        onClick: () => void store.testProfile(profile.id, new Set(saved ? [name] : []))
      }),
      probe?.phase === 'done' && probe.result !== undefined
        ? h(
            'span',
            {
              style: {
                ...S.hint,
                color: token(
                  probe.result.ok === true ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-warn-primary',
                  probe.result.ok === true ? '#34d399' : '#fbbf24'
                )
              },
              title: probe.result.detail ?? ''
            },
            `${statusLabel(probe.result.status)} · ${t('profileLatency').replace('{ms}', String(probe.result.latencyMs ?? 0))}`
          )
        : probe?.phase === 'error'
          ? h('span', { style: { ...S.hint, color: token('--dsw-alias-state-warn-primary', '#fbbf24') } }, probe.error ?? '—')
          : null,
      Button({
        label: t('profileRemove'),
        kind: 'danger',
        small: true,
        // Always available (per row, by identity): an unnamed row is exactly the
        // one a user wants to take back, and it used to take its neighbours too.
        disabled,
        title: t('profileRemoveRow'),
        onClick: () => store.removeProfile(profile.id)
      })
    ),
    // Why a control above is greyed out, written out in the row: a disabled
    // button swallows hover on some browsers, so a tooltip alone can explain
    // nothing. One line, the first reason that applies.
    activateBlocked !== undefined
      ? h('div', { style: { ...S.hint, flexBasis: '100%' }, 'data-profile-blocked': 'activate' }, activateBlocked)
      : null,
    testBlocked !== undefined && testBlocked !== t('profileTesting')
      ? h('div', { style: { ...S.hint, flexBasis: '100%' }, 'data-profile-blocked': 'test' }, testBlocked)
      : null,
    // A renamed row whose **stored key** would not survive the rename (g-066).
    //
    // The Host cannot move a secret to another path, and this page never held the
    // value, so the save is refused until the user retypes it here. Saying so on
    // the row — before the save, not as an auth failure afterwards — is the whole
    // "never silently lose a key" promise. A row that names an environment
    // variable resolves its key from there, so renaming it stays free: only a
    // row whose key really is stored in the document can lose one.
    renameNeedsKey(profile, savedName, name)
      ? h(
          'div',
          { style: { ...S.hint, flexBasis: '100%', color: token('--dsw-alias-state-warn-primary', '#fbbf24') }, 'data-profile-rename-key': 'true' },
          t('profileRenameKeyNeeded').replace('{name}', savedName)
        )
      : null,
    // The filled-in-but-unnamed case, spelled out on the row itself: the save is
    // refused for the whole page, so the reason has to be where the fix is.
    !named && filled
      ? h(
          'div',
          { style: { ...S.hint, flexBasis: '100%', color: token('--dsw-alias-state-warn-primary', '#fbbf24') }, 'data-profile-unnamed-warning': 'true' },
          t('profileUnnamedHint')
        )
      : null,
    h(
      'div',
      { style: S.fieldRow },
      GuidedField({
        t,
        path: 'systemOne.profiles.baseUrl',
        label: t('labelBaseUrl'),
        value: profile.baseUrl,
        mono: true,
        disabled,
        placeholder: 'http://127.0.0.1:8000/v1',
        onText: (value) => onEdit({ baseUrl: value }, 'text')
      }),
      GuidedField({
        t,
        path: 'systemOne.profiles.modelIds',
        label: t('labelModelIds'),
        hint: t('profileModelIdsHint'),
        value: profile.modelIds,
        mono: true,
        multiline: true,
        disabled,
        placeholder: 'jev-latest',
        onText: (value) => onEdit({ modelIds: value }, 'text')
      }),
      GuidedField({
        t,
        path: 'systemOne.profiles.timeoutMs',
        label: t('labelTimeoutMs'),
        value: profile.timeoutMs,
        disabled,
        onText: (value) => onEdit({ timeoutMs: value }, 'text')
      }),
      GuidedField({
        t,
        path: 'systemOne.profiles.apiKeyEnv',
        label: t('labelApiKeyEnv'),
        value: profile.apiKeyEnv,
        mono: true,
        disabled,
        onText: (value) => onEdit({ apiKeyEnv: value }, 'text')
      })
    ),
    // The one model in force (g-066). A radio group over the ids the list field
    // holds — never a free-text box — so the selection can only name a model
    // that exists: the runtime sends this id and the connection test probes it.
    //
    // Rendered as an **element**, not invoked: it returns a `Field`, which owns a
    // `useState` (its `(?)` disclosure). Calling it as a plain function would put
    // that hook into *this* row's sequence — the #310 crash this file warns
    // about — and it would still look correct in a render that never re-runs.
    h(ModelSelection, { t, profile, disabled, onEdit }),
    h(
      'div',
      { style: S.row },
      // Always a placeholder: the stored value is never handed to this page.
      h('input', {
        type: 'password',
        autocomplete: 'new-password',
        'data-profile-key': profile.id,
        placeholder: t('profileKeyPlaceholder'),
        value: profile.apiKey,
        disabled: disabled || profile.clearKey,
        style: { ...S.input, flex: '1 1 220px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        onInput: (event: { target?: { value?: unknown } }) => {
          const value = typeof event.target?.value === 'string' ? event.target.value : '';
          onEdit({ apiKey: value }, 'text');
        }
      }),
      h('span', { style: S.hint }, keyState),
      profile.apiKeyPresent
        ? Button({
            label: profile.clearKey ? t('profileClearConfirm') : t('profileClearKey'),
            kind: 'danger',
            small: true,
            disabled,
            // Clearing is explicit and two-step: an accidental click arms the
            // button, the second click performs the unset.
            onClick: () => {
              if (!profile.clearKey) onEdit({ clearKey: true });
              else onEdit({ clearKey: false, apiKeyPresent: false });
            }
          })
        : null,
      profile.clearKey
        // Cancelling the pending clear is labelled apart from removing the row:
        // "删除" twice in one row is how a user deletes a row by mistake.
        ? Button({ label: t('profileClearCancel'), small: true, onClick: () => onEdit({ clearKey: false }) })
        : null
    )
  );
}

/** Backend page: the System 1 connection and the runtime-level fields. */
function BackendTab(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const draft = state.draft;
  const disabled = !state.writable;
  const systemOne = state.snapshot?.systemOne;
  const setBackend = (patch: Partial<PanelDraft['backend']>, mode: AutosaveMode = 'immediate'): void => {
    store.edit((current) => ({ ...current, backend: { ...current.backend, ...patch } }), mode);
  };
  const setRuntime = (patch: Partial<PanelDraft['runtime']>, mode: AutosaveMode = 'immediate'): void => {
    store.edit((current) => ({ ...current, runtime: { ...current.runtime, ...patch } }), mode);
  };
  const profiles = draft.backend.profiles;
  const activeName = draft.backend.active.trim();
  // Whether anything connects (g-066). The snapshot decides it, never a guess
  // about which fields look filled in: `unconfigured` is set by the resolution
  // exactly when no connection resolved — no active profile, or an active one
  // whose model cannot be sent — and it also says *why*.
  const unconfigured = systemOne?.unconfigured;
  // The key readiness of the connection in force, from the snapshot's
  // provenance: say what supplied the key ("from the configuration" / "from
  // JEV_API_KEY"), or that the variable it names is empty — never echo a value.
  const connectionKeyState =
    systemOne?.apiKeyPresent !== true
      ? systemOne?.apiKeyLocked === true
        ? t('apiKeyLockedNamed').replace('{name}', systemOne.apiKeyVariable ?? '—')
        : t('apiKeyMissing')
      : systemOne.apiKeySource === 'profile'
        ? t('apiKeyFromProfile')
        : systemOne.apiKeySource === 'fallback'
          ? t('apiKeyFromFallback').replace('{name}', systemOne.apiKeyVariable ?? '—')
          : t('apiKeyFromEnv').replace('{name}', systemOne.apiKeyVariable ?? systemOne.apiKeyEnv ?? '—');
  // The connection in force, named for the copy: the snapshot's active profile
  // when it reports one, else the draft's (the banner only uses it to point at
  // the row the user has to fix).
  const connectionName = (systemOne?.activeProfile ?? activeName) || '—';
  const unconfiguredCopy =
    unconfigured === undefined
      ? undefined
      : unconfigured === 'legacy-config-required'
        ? t('unconfiguredLegacy')
        : unconfigured === 'no-profiles'
          ? t('unconfiguredNoProfiles')
          : unconfigured === 'active-profile-missing'
            ? t('unconfiguredActiveMissing').replace('{name}', activeName || '—')
            : unconfigured === 'model-selection-invalid'
              ? // g-066 att-002: an active profile whose *selected* model is not
                // in its list is not "no selection" — nothing runs for it, so the
                // page says so instead of offering a connection that refuses.
                t('unconfiguredModelInvalid').replace('{name}', connectionName)
              : unconfigured === 'model-selection-unusable'
                ? t('unconfiguredModelUnusable').replace('{name}', connectionName)
                : t('unconfiguredNoActive');
  const activeMissing = systemOne?.activeProfileMissing === true;
  // Which rows the Host has actually read: the probe route resolves the *saved*
  // document, so this set is what decides whether "测试" can do anything. The
  // draft's names are not enough — a name only a draft knows is not on the Host.
  const savedNames = new Set((systemOne?.profiles ?? []).map((profile) => profile.name?.trim() ?? '').filter((name) => name.length > 0));
  // The saved name of every row, by page identity: what a rename is measured
  // against, and the fact the row needs to tell the user its stored key cannot
  // follow the name (g-066). Seeded rows keep their identity across re-seeds.
  const originalRows = state.original.backend.profiles;
  // Rows are addressed by their page identity, never by position: one row's edit
  // must never land on whichever row happens to be third after a delete.
  const setProfile = (id: string, patch: Partial<ProfileDraft>, mode: AutosaveMode = 'immediate'): void => {
    store.edit(
      (current) => ({
        ...current,
        backend: {
          ...current.backend,
          profiles: current.backend.profiles.map((row) => (row.id === id ? { ...row, ...patch } : row))
        }
      }),
      mode
    );
  };
  return h(
    'div',
    { style: S.root },
    Card({
      title: t('profilesTitle'),
      children: h(
        'div',
        { style: S.field },
        h('span', { style: S.hint }, t('profilesHint')),
        // A typo in the active name must not look like a working configuration.
        activeMissing
          ? h(
              'div',
              { style: S.banner },
              t('activeProfileMissing').replace('{name}', activeName)
            )
          : null,
        profiles.length === 0
          ? h('div', { style: S.empty }, t('profilesEmpty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              ...profiles.map((profile) =>
                h(ProfileRow, {
                  // The page identity, not the name: two unnamed rows produced the
                  // same `${name}:${index}` key and React reused one row's DOM for
                  // the other (g-062).
                  key: profile.id,
                  t,
                  profile,
                  isActive: activeName.length > 0 && profile.name.trim() === activeName,
                  probe: state.probes[profile.name.trim()],
                  saved: savedNames.has(profile.name.trim()),
                  savedName: originalRows.find((row) => row.id === profile.id)?.name.trim() ?? '',
                  disabled,
                  store,
                  onEdit: (patch: Partial<ProfileDraft>, mode?: AutosaveMode) => setProfile(profile.id, patch, mode)
                })
              )
            ),
        Button({ label: t('profileAdd'), small: true, disabled, onClick: () => store.addProfile() })
      )
    }),
    // The *runtime* implementation choice, and — when nothing connects — the
    // one place the page says so. The flat compatibility editor that used to sit
    // here is gone (g-066): it was a second editor of the same connection fields,
    // and its values were a silent fallback the runtime no longer reads.
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
            // A pure implementation choice now: it names the backend a
            // connection uses when the connection states none, and it no longer
            // implies any connection settings at all.
            hint: t('backendHintRuntime'),
            onChange: (value) => setBackend({ backend: value })
          })
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, t('backendActive')),
          h('span', { style: S.mono }, String(systemOne?.active ?? '—')),
          h(
            'span',
            {
              style: {
                ...S.hint,
                color: token(
                  systemOne?.apiKeyPresent === true ? '--dsw-alias-state-success-primary' : '--dsw-alias-state-warn-primary',
                  'inherit'
                )
              }
            },
            connectionKeyState
          )
        )
      )
    }),
    // Nothing connects: say which absence it is, what that means for the
    // running plugin, and what to do about it — in that order. Rendered from the
    // snapshot's own fact, so a document that merely *looks* configured (an old
    // flat block, a name that matches no row) cannot read as connected.
    unconfiguredCopy === undefined
      ? null
      : h(
          'div',
          { style: { ...S.banner, flexBasis: '100%' }, 'data-unconfigured': unconfigured ?? '' },
          h('strong', null, ` ${t('unconfiguredTitle')} `),
          h('span', null, unconfiguredCopy),
          h('span', null, ` ${t('unconfiguredEffect')}`)
        ),
    Card({
      title: t('groupRuntime'),
      children: h(
        'div',
        { style: S.fieldRow },
        GuidedField({ t, path: 'toolPrefix', value: draft.runtime.toolPrefix, disabled, mono: true, onText: (value) => setRuntime({ toolPrefix: value }, 'text') }),
        GuidedField({ t, path: 'pruneThreshold', value: draft.runtime.pruneThreshold, disabled, onText: (value) => setRuntime({ pruneThreshold: value }, 'text') }),
        GuidedField({ t, path: 'ledgerPath', value: draft.runtime.ledgerPath, disabled, mono: true, onText: (value) => setRuntime({ ledgerPath: value }, 'text') }),
        GuidedField({ t, path: 'calibrationPath', value: draft.runtime.calibrationPath, disabled, mono: true, onText: (value) => setRuntime({ calibrationPath: value }, 'text') })
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
  const setInterventions = (patch: Partial<PanelDraft['interventions']>, mode: AutosaveMode = 'immediate'): void => {
    store.edit((current) => ({ ...current, interventions: { ...current.interventions, ...patch } }), mode);
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
      onText: (value) => setInterventions({ [key]: value } as Partial<PanelDraft['interventions']>, 'text')
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
            onText: (value) => setInterventions({ pruneJudgeMinChars: value }, 'text')
          }),
          budgetField('claimMinConfidence'),
          budgetField('closingEvidenceChars'),
          GuidedField({
            t,
            path: 'interventions.intent',
            value: draft.interventions.intent,
            disabled,
            onText: (value) => setInterventions({ intent: value }, 'text')
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
    DelegationCard(props),
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
function DelegationCard(props: { t: Translate; state: PanelState; store: PanelStore }): ReactNode {
  const { t, state, store } = props;
  const delegation = state.snapshot?.delegation;
  const checked = state.draft.delegation.enabled;
  const disabled = !state.writable;
  const write = state.delegationWrite;

  // Ticking is a two-step action, in this order: record the consent, then ask
  // the host to write the patch. Only the first is a settings edit, and only when
  // it lands does the second run — so the file is never written by a box whose
  // consent was never saved.
  const onToggle = (next: boolean): void => {
    void (async () => {
      store.edit((current) => ({ ...current, delegation: { enabled: next } }), 'immediate');
      // The autosaving page has already queued the write this edit needs; a
      // second `save()` here would write the same consent twice (g-069). The
      // host switch still follows the *recorded* consent, so it waits for that
      // queue to settle instead of racing it.
      const saved = store.autosave ? await store.whenSaved() : await store.save();
      if (saved && next) await store.enableDelegation();
    })();
  };

  const stateCopy = ((): string => {
    if (delegation === undefined) return t('delegationStateUnknown');
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
    children: h(
      'div',
      { style: S.field },
      h('div', { style: S.hint }, t('delegationIntro')),
      GuidedField({
        t,
        path: 'delegation.enabled',
        label: t('labelDelegationEnabled'),
        help: t('helpDelegationEnabled'),
        checkbox: { checked, disabled, onChange: onToggle }
      }),
      // The host switch this box writes, named plainly and unconditionally: it is
      // part of what ticking means, not a conditional consequence.
      h('div', { style: S.hint }, t('delegationConsent')),
      h(
        'table',
        { style: S.table },
        h(
          'tbody',
          null,
          ...[
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
          ].map(([label, value]) =>
            h('tr', { key: label }, h('td', { style: { ...S.td, ...S.label, width: '180px' } }, label), h('td', { style: S.td }, value))
          )
        )
      ),
      // The reason, verbatim from the host: a state with no explanation is the
      // "the tool just is not there" experience this switch exists to replace.
      delegation?.reason === undefined ? null : h('div', { style: S.banner }, delegation.reason),
      // "Saved, applies after a restart" — stated as the fact it is, never as
      // "done". Only shown when the file asks for the field and the live host
      // still refuses it, which is exactly the pending-restart window.
      delegation?.restartRequired === true
        ? h('div', { style: S.banner }, t('delegationRestartRequired'), ' ', h('span', { style: S.mono }, delegation.patchPath ?? ''))
        : null,
      write === null
        ? null
        : write.outcome === 'refused'
          ? // A refused write leaves the consent recorded but the host file
            // untouched. Saying "saved" here would be the exact dishonesty this
            // switch exists to avoid, so the reason is shown instead.
            h('div', { style: S.banner }, t('delegationWriteRefused'), ...(write.reason === undefined ? [] : [' ', write.reason]))
          : h(
              'div',
              { style: write.restartRequired ? S.banner : S.hint },
              t(write.restartRequired ? 'delegationSavedRestart' : 'delegationSavedNoRestart')
            ),
      h('div', { style: S.hint }, t('delegationRevokeHint'))
    )
  });
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
      storeRef.current = new PanelStore({
        form,
        fetch: (input, init) => fetch(input, init),
        // The page saves after each edit (g-069) and shares its queue with every
        // later mount of the same namespace: closing the dialog unmounts this
        // component, and a write left pending then still has to land.
        autosave: 'autosave',
        autosaveOwner: acquireAutosave(props.ns)
      });
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
        : h(
            'div',
            { style: S.errors },
            // `errors` holds copy keys; the row number an error has to name
            // (g-064) travels in `errorValues`, so it is interpolated here. An
            // unresolved `{row}` must never reach the user as braces, so a
            // missing value is filled in with a dash instead of being left raw.
            ...state.errors.map((key, index) => {
              // The validator can report the same key about different rows, and a
              // bare key would then collide on the React key: the index is part of
              // the identity, since the list is rebuilt as a whole every time.
              const values = state.errorValues ?? {};
              const row = values[key];
              const text = row === undefined ? t(key) : interpolate(t(key), { ...values, row });
              return h('div', { key: `${String(index)}:${key}` }, text.replace(/\{(\w+)\}/g, '-'));
            })
          ),
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
