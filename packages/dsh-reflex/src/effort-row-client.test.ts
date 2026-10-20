import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * S1 coverage for the browser half, against the **committed** `client.js`.
 *
 * The row is a conversation Definition: the engine calls `match(event)` for
 * every Session event, aggregates the matches of one Turn into state, and asks
 * `buildViewNode` for the final Chat node. Every assertion below drives that
 * contract through the artifact a browser would load, with only the cordis
 * services doubled — so a change that stops registering the row, that mis-anchors
 * it, or that lets a foreign Turn into the aggregate fails here rather than in
 * front of the user.
 */

//#region the artifact under test

/** What the bundle hands the client module loader. */
interface LoadedBundle {
  factory: (require: (spec: string) => unknown) => { apply: (scope: Record<string, unknown>) => unknown };
}

/** Fake React surface: the row builds plain elements, so pass them through. */
const reactor = {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ({
    type,
    props: props ?? {},
    children
  })
};

/** Evaluate the committed bundle the way the client loader does. */
function loadBundle(): LoadedBundle {
  let captured: LoadedBundle | undefined;
  const sandbox = { window: { __ModuleLoader__: { load: (entry: LoadedBundle): void => void (captured = entry) } } };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'), sandbox, {
    filename: 'client.js'
  });
  assert.ok(captured !== undefined, 'the bundle did not register with the module loader');
  return captured;
}

/** One definition the row registered against the conversation service. */
type Definition = {
  kind: string;
  target?: string;
  match: (event: Record<string, unknown>) => { id: string; role: string } | null;
  start: (context: Record<string, unknown>, match: Record<string, unknown>) => unknown;
  update: (context: Record<string, unknown>, match: Record<string, unknown>) => unknown;
  buildViewNode?: (context: Record<string, unknown>) => unknown;
};

/** Install the artifact against a doubled cordis context. */
function mount(): {
  definition: Definition;
  slot: Record<string, unknown>;
  component: (props: Record<string, unknown>) => unknown;
  translations: Record<string, string>;
} {
  const bundle = loadBundle();
  const definitions: Definition[] = [];
  const slots: { options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }[] = [];
  const translations: Record<string, string> = {};

  const ctx: Record<string, unknown> = {
    locale: {
      register: (ns: string, value: Record<string, Record<string, string>>) => {
        assert.equal(ns, 'dsh-reflex.panel', 'the row must use the plugin namespace');
        Object.assign(translations, value.zh);
        return () => undefined;
      },
      bind: (ns: string) => (key: string) => translations[key] ?? key
    },
    slots: {
      inject: (name: string, register: () => () => void) => {
        void name;
        return register();
      },
      register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
        slots.push({ options, component });
        return () => undefined;
      }
    },
    configForms: { get: () => ({}), whileServed: (names: readonly string[], register: () => () => void) => register() },
    effect: (callback: () => void | (() => void)) => callback(),
    inject: (dependencies: readonly string[], callback: (scope: Record<string, unknown>) => void) => callback(ctx),
    // The optional lookup the row uses: declaring `uiConversation` in the
    // plugin's `inject` list would park the whole client in a shell that has no
    // conversation service, so the row asks for it by name instead.
    get: (name: string) =>
      name === 'uiConversation'
        ? {
            events: {
              register: (definition: Definition) => {
                definitions.push(definition);
                return () => undefined;
              }
            }
          }
        : undefined
  };

  const exported = bundle.factory((spec) => {
    assert.equal(spec, 'react', `the bundle required "${spec}"`);
    return reactor;
  });
  exported.apply(ctx);

  assert.equal(definitions.length, 1, 'the row must register exactly one conversation definition');
  const entry = slots.find((candidate) => candidate.options.name === 'conversation.chat.node');
  assert.ok(entry !== undefined, 'the row must register its renderer against the chat slot');
  return { definition: definitions[0] as Definition, slot: entry.options, component: entry.component, translations };
}

/**
 * One effort record as the Host appends it.
 * @param payload - decision fields to override.
 * @param event - event-envelope fields (notably `seq`) to override.
 * @returns the record event.
 */
function record(payload: Record<string, unknown> = {}, event: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'plugin:dsh-reflex/effort',
    seq: 12,
    time: 1_700_000_000_000,
    ...event,
    data: {
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.82,
      latencyMs: 12,
      provider: 'deepseek',
      model: 'reasoner',
      line: 'reflex effort: high → high (system-one 0.82, 12ms) deepseek:reasoner',
      at: 1_700_000_000_000,
      turn: 1,
      step: 1,
      basis: ['design', 'migration'],
      ...payload
    }
  };
}

/** Walk an element tree produced in the VM realm. */
function elements(tree: unknown): { type: unknown; props: Record<string, unknown>; children: unknown[] }[] {
  const out: { type: unknown; props: Record<string, unknown>; children: unknown[] }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const element = node as { type: unknown; props: Record<string, unknown>; children: unknown[] };
    out.push(element);
    element.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/** All text in a tree, in document order. */
function textOf(tree: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    (node as { children: unknown[] }).children.forEach(walk);
  };
  walk(tree);
  return parts.join(' ');
}

//#endregion

//#region the definition contract

test('the committed client registers one chat row for the effort record type', () => {
  const { definition, slot } = mount();
  assert.equal(definition.target, 'chat', 'the row renders in the chat transcript');
  assert.equal(typeof definition.match, 'function', 'the engine calls match as a function, never as a table');
  assert.equal(typeof definition.start, 'function');
  assert.equal(typeof definition.update, 'function');
  assert.equal(typeof definition.buildViewNode, 'function');
  assert.equal(slot.name, 'conversation.chat.node', 'the renderer belongs to the chat node slot');
  assert.equal(slot.key, definition.kind, 'the slot entry must be selected by the node kind');
  assert.equal(slot.locale, 'dsh-reflex.panel', 'the row binds its own translations');
});

test('the row claims its own turn, and only its own', () => {
  const { definition } = mount();

  // A turn opens the aggregate even before any decision landed.
  assert.deepEqual(
    { ...(definition.match({ type: 'turn/start', seq: 10, data: { turn: 1 } }) as Record<string, unknown>) },
    { id: '1', role: 'start' }
  );

  // The decision record can also start a context: a restored window may begin
  // mid-turn, and a later start match is routed through `update`.
  assert.deepEqual(
    { ...(definition.match(record({ turn: 3, step: 2 })) as Record<string, unknown>) },
    { id: '3', role: 'start' }
  );

  // A user message addresses the open turn without re-opening it.
  assert.deepEqual(
    { ...(definition.match({ type: 'user/message', seq: 11, surfaceOp: 'append', data: { turn: 1 } }) as Record<string, unknown>) },
    { id: '1', role: 'update' }
  );

  // Everything else is declined, cheaply: the engine offers every event to every
  // definition, so a foreign event must not create a context.
  assert.equal(definition.match({ type: 'tool/result', seq: 13, data: { turn: 1 } }), null);
  assert.equal(definition.match({ type: 'assistant/message', seq: 14, data: { turn: 1 } }), null);
  assert.equal(definition.match({ type: 'turn/start', seq: 15, data: {} }), null);
  assert.equal(definition.match({ type: 'user/message', seq: 16, surfaceOp: 'replace', data: { turn: 1 } }), null);
});

test('one turn aggregates every step it decided, and a foreign turn stays out of it', () => {
  const { definition } = mount();
  const startMatch = { event: { type: 'turn/start', seq: 10, data: { turn: 1 } }, role: 'start' as const };
  let state = definition.start({ key: 'k', id: '1', start: startMatch }, startMatch) as Record<string, unknown>;

  const first = record({ turn: 1, step: 1, level: 'low', applied: 'low', outcome: 'supported' }, { seq: 12 });
  state = definition.update({ key: 'k', id: '1', state }, { event: first, role: 'start' }) as Record<string, unknown>;
  assert.equal((state.steps as unknown[]).length, 1);

  // A second decision in the same turn replaces nothing: both steps stay.
  const second = record({ turn: 1, step: 2, level: 'high', applied: 'high' }, { seq: 20 });
  state = definition.update({ key: 'k', id: '1', state }, { event: second, role: 'start' }) as Record<string, unknown>;
  assert.equal((state.steps as unknown[]).length, 2, 'the same turn aggregates its steps');

  // A record of another turn cannot leak into this aggregate.
  const foreign = record({ turn: 2, step: 1, level: 'max' }, { seq: 30 });
  const after = definition.update({ key: 'k', id: '1', state }, { event: foreign, role: 'start' }) as Record<string, unknown>;
  assert.equal((after.steps as unknown[]).length, 2, 'a foreign turn must not be aggregated');

  // Re-delivering one step (a resync replays the window) updates in place.
  const resent = record({ turn: 1, step: 2, level: 'medium', applied: 'medium' }, { seq: 20 });
  const replaced = definition.update({ key: 'k', id: '1', state }, { event: resent, role: 'start' }) as Record<string, unknown>;
  const steps = replaced.steps as { level: string }[];
  assert.equal(steps.length, 2, 'a replayed step updates rather than appends');
  assert.deepEqual(
    [...steps].map((step) => step.level),
    ['low', 'medium'],
    'the replacement keeps the step position'
  );

  // Steps are ordered by their step number, not by arrival: a resync can deliver
  // them out of order and the row must still read as a single turn.
  const reversed = record({ turn: 1, step: 9, level: 'max', applied: 'max' }, { seq: 40 });
  const sorted = definition.update({ key: 'k', id: '1', state: replaced }, { event: reversed, role: 'start' }) as Record<string, unknown>;
  assert.deepEqual(
    [...(sorted.steps as { level: string }[])].map((step) => step.level),
    ['low', 'medium', 'max'],
    'a late step takes its place at the end of the turn'
  );
});

test('the built node is a visible chat row anchored at the newest decision', () => {
  const { definition } = mount();
  const startMatch = { event: { type: 'turn/start', seq: 10, data: { turn: 1 } }, role: 'start' as const };
  let state = definition.start({ key: 'k', id: '1', start: startMatch }, startMatch) as Record<string, unknown>;
  for (const step of [1, 2]) {
    state = definition.update(
      { key: 'k', id: '1', state },
      { event: record({ turn: 1, step }, { seq: 12 + step }), role: 'start' }
    ) as Record<string, unknown>;
  }

  const location = { kind: 'step', turn: { turn: 1 }, step: { step: 2 } };
  const buildViewNode = definition.buildViewNode;
  assert.equal(typeof buildViewNode, 'function');
  const node = (buildViewNode as (context: Record<string, unknown>) => unknown)({
    key: 'k',
    id: '1',
    state,
    start: { ...startMatch, location },
    matches: [{ ...startMatch, location }]
  }) as Record<string, unknown>;

  assert.equal(node.key, 'k', 'the engine keys the node by the context');
  assert.equal(node.kind, 'reflex-effort');
  assert.equal(node.target, 'chat');
  assert.equal(node.id, '1');
  assert.equal(node.visibility, 'visible', 'the row is always visible: it is the only trace of the decision');
  assert.equal(node.anchorSeq, 14.02, 'the row sits just after the newest decision record');
  assert.deepEqual({ ...(node.location as Record<string, unknown>) }, location, 'the node inherits the matched location');
  assert.deepEqual(
    (node.data as { steps: unknown[] }).steps.length,
    2,
    'the payload carries every step of the turn'
  );

  // An aggregate with no decision yet renders nothing at all.
  const empty = (buildViewNode as (context: Record<string, unknown>) => unknown)({
    key: 'k',
    id: '1',
    state: { turn: 1, steps: [] },
    start: startMatch,
    matches: [startMatch]
  });
  assert.equal(empty, null, 'a turn without a decision must not add a row');
});

//#endregion

//#region the rendered row

test('the row renders one disclosure for the turn, light and token-driven', () => {
  const { component, translations } = mount();
  const steps = [
    {
      seq: 12,
      step: 1,
      level: 'low',
      applied: 'low',
      outcome: 'supported',
      trigger: 'request',
      source: 'cue-fallback',
      confidence: 0.5,
      latencyMs: 3,
      provider: 'deepseek',
      model: 'reasoner',
      line: 'reflex effort: low → low',
      at: 1,
      basis: ['typo'],
      supportedEfforts: ['off', 'low', 'high', 'max']
    },
    {
      seq: 20,
      step: 2,
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.82,
      latencyMs: 12,
      provider: 'deepseek',
      model: 'reasoner',
      line: 'reflex effort: high → high',
      at: 2,
      switched: true,
      requestedProvider: 'reflex',
      requestedModel: 'reflex-auto'
    }
  ];
  const tree = component({
    node: { kind: 'reflex-effort', data: { turn: 4, steps, latest: steps[1] } },
    t: (key: string) => translations[key] ?? key
  });

  const all = elements(tree);
  assert.equal(all.length > 0, true, 'the row rendered nothing');
  assert.equal(all[0]?.type, 'details', 'the row is a native disclosure, so it costs no state');
  const summary = all.find((element) => element.type === 'summary');
  assert.ok(summary !== undefined, 'the disclosure needs a summary line');

  const style = all[0]?.props.style as Record<string, string>;
  assert.equal(style.fontSize, '12px', 'the row is secondary chrome, not a message');
  assert.match(String(style.border), /^1px solid var\(--dsw-alias-border-l1/, 'the border follows the theme token');
  assert.match(String(style.background), /^var\(--dsw-alias-bg-layer-2/, 'the fill follows the theme token');
  assert.ok(
    Object.values(style).every((value) => !/#[0-9a-f]{3,6}\b/i.test(value) || value.includes('var(')),
    'every colour must come from a theme token, with a fallback only behind it'
  );

  assert.equal(all[0]?.props['data-reflex-turn'], '4', 'the row is attributable to its turn');
  const text = textOf(tree);
  assert.match(text, /high/, 'the summary shows the level the turn reached');
  assert.match(text, /deepseek\/reasoner/, 'the summary names the physical route');
  assert.match(text, /reflex\/reflex-auto → deepseek\/reasoner/, 'a switched route shows where it came from');
  assert.ok(text.includes(translations.rowDetails ?? 'rowDetails'), 'the disclosure advertises its detail affordance');

  // The disclosure body is where the per-step evidence lives.
  const table = all.find((element) => element.type === 'table');
  assert.ok(table !== undefined, 'every step of the turn has to be inspectable');
  const rows = elements(table).filter((element) => element.type === 'tr');
  assert.equal(rows.length, 3, 'a header row plus one row per decided step');
  assert.match(text, /0\.82/, 'the confidence of a step is shown');
  assert.match(text, /12ms/, 'the latency of a step is shown');
});

test('the row keeps the shipped English fallback when no translator is bound', () => {
  const { component } = mount();
  const steps = [
    {
      seq: 12,
      step: 1,
      level: 'off',
      applied: null,
      outcome: 'cleared',
      trigger: 'request',
      source: 'cue-fallback',
      confidence: 0.4,
      latencyMs: 1,
      provider: '',
      model: '',
      line: 'reflex effort: off → none',
      at: 1,
      supportedEfforts: ['off', 'low'],
      degradedReason: 'target model declares no reasoning'
    }
  ];
  const tree = component({ node: { data: { turn: 1, steps, latest: steps[0] } } });
  const text = textOf(tree);
  assert.match(text, /Reflex effort/, 'the unbound translator falls back to the shipped English');
  assert.match(text, /Details/, 'the fallback resolves the detail affordance too');
  assert.match(text, /off → not sent/, 'a cleared effort is written as not sent, not as an empty applied level');
  assert.match(text, /Declared levels: off, low/, 'the declared ladder of the route is shown');
  assert.match(text, /Degraded: target model declares no reasoning/, 'the reason a level was not sent is shown');
  assert.match(text, /reflex effort: off → none/, 'the audit line the Host logged is shown verbatim');
  assert.ok(!/row[A-Z]/.test(text), 'the fallback must resolve keys, not print them');
});

test('the row annotates cache-affinity retention in route text and evidence list', () => {
  const { component, translations } = mount();
  const steps = [
    {
      seq: 21,
      step: 1,
      level: 'medium',
      applied: 'medium',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.95,
      latencyMs: 15,
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      line: 'reflex effort: medium → medium (system-one 0.95, 15ms) openai-codex:gpt-6.1-sol (cache affinity)',
      at: 1,
      heldForCache: true,
      switched: false,
      requestedProvider: 'reflex',
      requestedModel: 'reflex-1',
      basis: ['complex']
    }
  ];
  const tree = component({
    node: { kind: 'reflex-effort', data: { turn: 2, steps, latest: steps[0] } },
    t: (key: string) => translations[key] ?? key
  });
  const text = textOf(tree);
  assert.match(text, /reflex\/reflex-1 → openai-codex\/gpt-6\.1-sol \(保持模型以保活缓存\)/);
  assert.match(text, /路由策略: 为避免 Prompt Cache 失效而保持当前模型 \(Cache Affinity\)/);
});

test('composer indicator reads only corroborated per-session actual projection', () => {
  const { translations } = mount();
  const exported = loadBundle().factory(() => reactor) as Record<string, any>;
  const Indicator = exported.ComposerEffortIndicator;
  const route = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
  const props = (value: unknown, next: unknown = { provider: 'reflex', model: 'reflex-1' }) => ({
    useProjection: (key: string) => {
      assert.ok(key === 'reflexActual' || key === 'modelSelection');
      return key === 'reflexActual' ? value : { next, lastUsed: route };
    },
    t: (key: string) => translations[key] ?? key,
    useSession: () => { throw new Error('must not read guessed Session fields'); }
  });
  assert.equal(Indicator(props(undefined)), null);
  assert.equal(Indicator(props({ adaptive: false, actual: route })), null);
  assert.equal(Indicator(props({ adaptive: true, actual: null })), null);
  assert.equal(Indicator(props({ adaptive: true, actual: { provider: 'reflex', model: 'reflex-1' } })), null);
  const tree = Indicator(props({ adaptive: true, actual: route }));
  assert.match(textOf(tree), /实际: openai-codex\/gpt-6\.1-sol · medium/);
  assert.ok(tree !== null);
  // Legacy 3ff-style replay: old virtual effort and physical header, but no
  // durable adaptive intent; Host next is now a concrete physical pin.
  assert.equal(Indicator(props({ adaptive: true, actual: route }, route)), null);
  // The same physical target with explicit adaptive effort retains the feature.
  assert.ok(Indicator(props({ adaptive: true, actual: route }, { ...route, reasoningEffort: 'reflex' })) !== null);
});

//#endregion
