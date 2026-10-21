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
import { NS, en, zh } from './locale';
import { resolveReflexNamespace } from './panel';
import { createPanelComponent, type PanelProps } from './view';
import { EFFORT_ROW_SLOT, registerEffortRow, ComposerEffortIndicator, type UiConversationLike } from './effort-row';
export { ComposerEffortIndicator };
import type { ConfigFormLike } from './store';

/**
 * Stable settings key this entry registers under (bundle-config slot and panel
 * namespace). Deliberately not the npm package name: the bundle's
 * `__ModuleLoader__.load` id is derived from `package.json` instead, so a
 * package rename never moves the user's saved settings.
 */
export const CLIENT_ID = 'dsh-reflex';

/** Settings namespace candidates, most specific first. */
export const NS_CANDIDATES: readonly string[] = ['dsh-reflex', 'reflex'];

/** Root-scoped settings slot the page registers into. */
export const SECTION_SLOT = 'settings.section';

/** Slot entry id. */
export const SECTION_ID = 'reflex';

/** Slot order: after the core preference sections. */
export const SECTION_ORDER = 55;

/** Cordis services this entry requires. */
export const inject: readonly string[] = ['slots', 'locale', 'configForms'];

/** Settings provider face of this plugin. */
export interface ConfigFormsLike {
  get(entryId: string): ConfigFormLike;
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
}

/** Locale service face of this plugin. */
export interface LocaleLike {
  register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void;
  bind(ns: string): (key: string) => string;
}

/** Slot registration options this plugin uses. */
export interface SlotOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: () => string;
  locale?: string;
  inject?: () => Record<string, unknown>;
}

/** Slot service face of this plugin. */
export interface SlotsLike {
  inject(name: string, register: () => () => void): () => void;
  register(options: SlotOptions, component: (props: any) => unknown): () => void;
}

/** The client context as this bundle consumes it, structurally typed. */
export interface ClientContextLike {
  slots: SlotsLike;
  locale: LocaleLike;
  configForms: ConfigFormsLike;
  effect(callback: () => void | (() => void), label?: string): void;
  inject(dependencies: readonly string[], callback: (scope: ClientContextLike) => void): unknown;
  /** Optional service lookup, the sanctioned way to reach an undeclared seat. */
  get?(name: string): unknown;
}

/** Shell service owning the conversation surface the effort row renders on. */
export const CONVERSATION_SERVICE = 'uiConversation';

export const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';

/**
 * Register the settings page for one set of served namespaces.
 * @param ctx - the client context that owns the registration.
 * @param served - every settings namespace the Host serves.
 * @param t - translator of this plugin's dictionary namespace.
 * @returns the disposer that removes the page.
 */
export function registerSection(
  ctx: ClientContextLike,
  served: ReadonlySet<string>,
  t: (key: string) => string
): () => void {
  const ns = resolveReflexNamespace([...served], NS_CANDIDATES);
  if (ns === undefined) return () => {};
  const Component = createPanelComponent(ctx, t);
  const unbindSection = ctx.slots.inject(SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SECTION_SLOT,
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ ns })
      },
      Component
    )
  );

  // Also register into plugins.bundle.config (Plugins Page -> dsh-reflex details)
  const unbindBundleConfig = ctx.slots.inject(BUNDLE_CONFIG_SLOT, () =>
    ctx.slots.register(
      {
        name: BUNDLE_CONFIG_SLOT,
        key: CLIENT_ID
      },
      (props: { view?: string }) => (props?.view === 'summary' ? null : Component({ ns }))
    )
  );

  return () => {
    unbindSection();
    unbindBundleConfig();
  };
}

/**
 * Activate the browser half.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContextLike): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reflex panel locale');

  // Register unconditionally into settings.section and plugins.bundle.config!
  // This matches dsh-antigravity and dsh-graph so the UI entry is ALWAYS visible.
  ctx.slots.inject(SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SECTION_SLOT,
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ ns: 'dsh-reflex' })
      },
      createPanelComponent(ctx, t)
    )
  );

  ctx.slots.inject(BUNDLE_CONFIG_SLOT, () =>
    ctx.slots.register(
      {
        name: BUNDLE_CONFIG_SLOT,
        key: CLIENT_ID
      },
      (props: { view?: string }) => (props?.view === 'summary' ? null : createPanelComponent(ctx, t)({ ns: 'dsh-reflex' }))
    )
  );

  // The effort row rides an *optional* lookup, never a declared dependency: a
  // client entry parked on a service that never arrives aborts the whole web
  // boot, and this plugin must stay usable in a shell without a conversation
  // view. `slots.inject` fires when the conversation surface declares the node
  // slot, which is also when its service is reachable — so the row attaches
  // exactly then, and detaches with the slot.
  ctx.slots.inject(EFFORT_ROW_SLOT, () => {
    const conversation = ctx.get?.(CONVERSATION_SERVICE) as UiConversationLike | undefined;
    if (conversation === undefined) return () => {};
    return registerEffortRow(conversation, (options, component) => ctx.slots.register(options, component), NS);
  });
}
