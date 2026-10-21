import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import type { LedgerEntry, LedgerSummary } from './vendor/harness-reflex/index.js';

import { INTERVENTION_CAPABILITIES, INTERVENTION_MODES, INTERVENTION_SETTINGS, Config, resolveConfig, type ReflexConfig } from './config.js';
import { ADAPTIVE_EFFORT_LEVELS, EFFORT_LEVELS, EFFORT_TRIGGERS } from './effort.js';
import { REFLEX_TOOL_SUFFIXES } from './tools.js';
import {
  PANEL_ROUTES,
  buildPanelSnapshot,
  isPanelRequestAllowed,
  makePanelRoutes,
  type PanelRuntimeFacts,
  type PanelSource
} from './panel-api.js';

/**
 * End-to-end coverage of the browser half without a browser.
 *
 * The committed `client.js` is evaluated in a VM, its settings page is mounted
 * against a fake cordis context, and the page is rendered by a hook runtime that
 * subscribes, re-renders, and runs effects the way React does. Everything the
 * page reads is production code: the snapshot comes from `buildPanelSnapshot`
 * served through the real `/api/dsh-reflex/*` route family and the real loopback
 * fence, and the write path is checked against the Host's own `resolveConfig`
 * validator. Only the cordis services, React, and the clock are doubled.
 */

//#region tree helpers

/** A node of the tree the page produced. */
interface Element {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

/** Every element in a tree, depth first. */
function elements(tree: unknown): Element[] {
  const out: Element[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const element = node as Element;
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
    (node as Element).children.forEach(walk);
  };
  walk(tree);
  return parts.join(' ');
}

/** First element of one tag whose text contains `needle`. */
function find(tree: unknown, tag: string, needle: string): Element | undefined {
  return elements(tree).find((element) => element.type === tag && textOf(element).includes(needle));
}

/** The `<label>` field whose text contains `label`. */
function field(tree: unknown, label: string): Element {
  const found = elements(tree).find((element) => element.type === 'label' && textOf(element).includes(label));
  assert.ok(found !== undefined, `no field labelled "${label}" among [${elements(tree).filter((e) => e.type === 'label').map((e) => textOf(e)).join(' | ')}]`);
  return found as Element;
}

/** Values of every `<option>` of the select field labelled `label`. */
function optionsOf(tree: unknown, label: string): string[] {
  return elements(field(tree, label))
    .filter((element) => element.type === 'option')
    .map((element) => String(element.props.value));
}

/** The text input of the field labelled `label`. */
function inputElement(tree: unknown, label: string): Element | undefined {
  return elements(field(tree, label)).find((element) => element.type === 'input');
}

/** Value of the text input of the field labelled `label`. */
function inputOf(tree: unknown, label: string): string {
  return String(inputElement(tree, label)?.props.value ?? '');
}

/** Type into a text input, as the browser would. */
function type(input: Element | undefined, value: string): void {
  fire(input, 'onChange', { target: { value } });
}

/** The single checkbox of the field labelled `label`. */
function checkboxOf(tree: unknown, label: string): Element {
  const box = elements(field(tree, label)).find((element) => element.type === 'input' && element.props.type === 'checkbox');
  assert.ok(box !== undefined, `no checkbox labelled "${label}"`);
  return box as Element;
}

/** The single `<select>` of the field labelled `label`. */
function selectOf(tree: unknown, label: string): Element {
  const select = elements(field(tree, label)).find((element) => element.type === 'select');
  assert.ok(select !== undefined, `no select labelled "${label}"`);
  return select as Element;
}

/** Cross-realm comparison: JSON round-trips values out of the VM's realm. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Invoke one handler prop of an element, as the browser would. */
function fire(element: Element | undefined, prop: string, argument?: unknown): void {
  const handler = element?.props[prop];
  if (typeof handler === 'function') (handler as (value?: unknown) => void)(argument);
}

/** Switch page by clicking its tab. */
function openTab(tree: unknown, label: string): void {
  const tab = find(tree, 'button', label);
  assert.ok(tab !== undefined, `no tab labelled "${label}"`);
  fire(tab, 'onClick');
}

//#endregion

//#region hook runtime

/** One hook slot of the component under test. */
interface HookRecord {
  deps?: readonly unknown[];
  value?: unknown;
  cleanup?: () => void;
}

/**
 * A hook runtime for one component instance.
 *
 * Implements exactly the React surface `src/client/react.d.ts` declares, with
 * the behaviours the page depends on: `useRef` identity across passes,
 * dependency-gated effects, and the `useSyncExternalStore` post-subscribe
 * snapshot check that makes a store changed inside an effect re-render.
 */
class HookRuntime {
  private hooks: HookRecord[] = [];
  private index = 0;
  private pending: { record: HookRecord; run: () => void | (() => void) }[] = [];
  private stale = false;
  renderCount = 0;
  tree: unknown = null;

  constructor(
    private readonly component: (props: Record<string, unknown>) => unknown,
    private readonly props: () => Record<string, unknown>
  ) {}

  /** `react.createElement`. */
  createElement = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity) as unknown[]
  });

  /** `react.useRef`: the same object across passes. */
  useRef = (initial: unknown): { current: unknown } => {
    const record = this.slot();
    if (record.value === undefined) record.value = { current: initial };
    return record.value as { current: unknown };
  };

  /** `react.useMemo`: recomputed when its dependencies change. */
  useMemo = (factory: () => unknown, deps: readonly unknown[]): unknown => {
    const record = this.slot();
    if (record.value === undefined || !sameDeps(record.deps, deps)) {
      record.deps = deps;
      record.value = factory();
    }
    return record.value;
  };

  /** `react.useCallback` (identity churn is not observable here). */
  useCallback = (callback: unknown): unknown => callback;

  /** `react.useEffect`: runs only when its dependencies change. */
  useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]): void => {
    const record = this.slot();
    if (record.deps !== undefined && deps !== undefined && sameDeps(record.deps, deps)) return;
    record.deps = deps;
    this.pending.push({ record, run: effect });
  };

  /** `react.useState`: one box per slot, and a setter that marks the tree stale. */
  useState = (initial: unknown): [unknown, (next: unknown) => void] => {
    const record = this.slot();
    if (record.value === undefined) {
      const box = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      record.value = box;
    }
    const box = record.value as { value: unknown };
    const set = (next: unknown): void => {
      box.value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(box.value) : next;
      this.stale = true;
    };
    return [box.value, set];
  };

  /** `react.useSyncExternalStore`, including React's post-subscribe re-check. */
  useSyncExternalStore = (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown): unknown => {
    const record = this.slot();
    const seen = getSnapshot();
    this.useEffect(() => {
      const unsubscribe = subscribe(() => {
        this.stale = true;
      });
      if (getSnapshot() !== seen) this.stale = true;
      return unsubscribe;
    }, [subscribe]);
    return seen;
  };

  private slot(): HookRecord {
    const record = this.hooks[this.index] ?? {};
    this.hooks[this.index] = record;
    this.index += 1;
    return record;
  }

  /** Render one pass and run the effects it registered. */
  render(): unknown {
    this.index = 0;
    this.pending = [];
    this.stale = false;
    this.renderCount += 1;
    this.tree = this.renderNode(this.component(this.props()));
    const run = this.pending;
    this.pending = [];
    for (const entry of run) {
      entry.record.cleanup?.();
      const cleanup = entry.run();
      entry.record.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return this.tree;
  }

  /** Unmount the page, running every cleanup. */
  unmount(): void {
    for (const entry of this.hooks) entry.cleanup?.();
    this.hooks = [];
  }

  /** Render, settle async work, and repeat while the page says it changed. */
  async flush(passes = 8): Promise<unknown> {
    let tree = this.render();
    for (let pass = 0; pass < passes; pass += 1) {
      await settle();
      if (!this.stale) break;
      tree = this.render();
    }
    return tree;
  }

  private renderNode(node: unknown): unknown {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((child) => this.renderNode(child));
    const element = node as Element;
    if (typeof element.type === 'function') {
      const component = element.type as (props: Record<string, unknown>) => unknown;
      return this.renderNode(component({ ...element.props, children: element.children }));
    }
    return { type: element.type, props: element.props, children: element.children.map((child) => this.renderNode(child)) };
  }
}

/** Let pending promises and timers settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Dependency comparison for the hook runtime. */
function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

//#endregion

//#region fixtures

/** The authored settings document the fake form serves. */
const AUTHORED: ReflexConfig = {
  backend: 'jev',
  toolPrefix: 'reflex_',
  pruneThreshold: 500,
  routing: {
    enabled: true,
    virtualProvider: 'reflex',
    fallback: 'deepseek:deepseek-chat',
    maxTaskChars: 400,
    models: { 'reflex-pro': [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] }
  },
  effort: { reasoningEffort: 'reflex', fallback: 'low', minConfidence: 0.3 },
  systemOne: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'jev-small', apiKeyEnv: 'REFLEX_TEST_KEY', timeoutMs: 2500 }
};

/** An API key value the page must never render. */
const SECRET = 'sk-do-not-render-this-4f9a';

const LEDGER_ENTRIES: LedgerEntry[] = [
  { id: 'l1', timestamp: '2024-03-04T05:06:07.000Z', type: 'effort-decision', backend: 'jev', latencyMs: 12.4, details: { level: 'high' } },
  {
    id: 'l2',
    timestamp: '2024-03-04T05:06:09.000Z',
    type: 'model-route',
    backend: 'jev',
    latencyMs: 8.1,
    details: { action: 'ranked', target: 'deepseek:deepseek-chat', reason: 'pool-order' }
  }
];

const LEDGER_SUMMARY: LedgerSummary = {
  totalCalls: 2,
  callsByType: { 'effort-decision': 1, 'model-route': 1 },
  totalTokensSaved: 1024,
  avgLatencyMs: 10.25,
  estimatedCostSavedUsd: 0.5,
  stagnationAlerts: 0,
  gatePassedCount: 3,
  gateFailedCount: 1
};

/** Panel facts in production shapes, so the snapshot is the real projection. */
function facts(apiKeyPresent: boolean): PanelRuntimeFacts {
  return {
    config: resolveConfig(AUTHORED),
    backendName: 'jev',
    pools: [{ model: 'reflex-pro', entries: [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] }],
    routingActive: true,
    // AUTHORED authors no tools block, so the Host registers the documented
    // default: the four recommended tools, with route left for opt-in.
    toolSurface: REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route').map((suffix) => `reflex_${suffix}`),
    ledger: {
      getSummary: () => LEDGER_SUMMARY,
      getEntries: () => LEDGER_ENTRIES,
      getLogPath: () => '/tmp/reflex-ledger.jsonl'
    },
    effort: {
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.82,
      latencyMs: 12.4,
      provider: 'deepseek',
      model: 'deepseek-chat',
      line: 'reflex: high (confidence 0.82, system-one, 12.4 ms)',
      at: 1_709_530_000_000
    },
    apiKeyPresent,
    now: 1_709_530_001_000
  };
}

/** What one test observed of the panel's network traffic and live timers. */
interface Observed {
  calls: { url: string; method: string }[];
  clears: number[];
  timers: { id: number; ms: number }[];
}

/** A deterministic clock whose live timers are inspectable. */
interface Clock {
  globals: { setTimeout: (callback: () => void, ms: number) => number; clearTimeout: (handle: number) => void };
  /** Fire one live timer, as the event loop would. */
  fire(id: number): void;
}

/**
 * A fake timer queue.
 *
 * Live timers are the observable, so a fired or cleared timer leaves the queue:
 * that is what makes "an unmounted page left its polling timer behind"
 * detectable at all.
 * @param observed - the record the live timers are published into.
 * @returns the sandbox globals and the manual tick.
 */
function makeClock(observed: Observed): Clock {
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    globals: {
      setTimeout: (callback: () => void, ms: number): number => {
        const id = next;
        next += 1;
        live.set(id, callback);
        observed.timers.push({ id, ms });
        return id;
      },
      clearTimeout: (handle: number): void => {
        live.delete(handle);
        observed.timers = observed.timers.filter((timer) => timer.id !== handle);
      }
    },
    fire: (id: number): void => {
      const callback = live.get(id);
      assert.ok(callback !== undefined, `timer ${String(id)} is not live`);
      live.delete(id);
      observed.timers = observed.timers.filter((timer) => timer.id !== id);
      callback?.();
    }
  };
}

/** Serve `/api/dsh-reflex/*` from a real source, over a loopback socket shape. */
function makeTransport(panelFacts: PanelRuntimeFacts, observed: Observed): (input: string, init?: { method?: string }) => Promise<unknown> {
  const source: PanelSource = {
    snapshot: (limit) => buildPanelSnapshot(panelFacts, limit),
    clearLedger: () => {
      observed.clears.push(1);
      return 2;
    },
    allows: (request) => isPanelRequestAllowed(request, {})
  };
  const routes = makePanelRoutes(source);
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    observed.calls.push({ url: input, method });
    const path = input.split('?')[0] ?? '/';
    const route = routes.find((candidate) => candidate.path === path);
    assert.ok(route !== undefined, `no panel route for ${path}`);
    let status = 0;
    let body = '';
    route.handler(
      { method, url: input, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } } as never,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (chunk?: string) => {
          body = chunk ?? '';
        }
      } as never
    );
    return { ok: status >= 200 && status < 300, status, json: async (): Promise<unknown> => JSON.parse(body) as unknown };
  };
}

/** The settings form the page edits. */
function settingsForm(value: unknown, options: { writable?: boolean; revision?: number } = {}): {
  form: Record<string, unknown>;
  mutations: { ops: unknown; revision: unknown }[];
  /** Replace the document and notify, the way the Host does after a write. */
  push(next: unknown): void;
} {
  const mutations: { ops: unknown; revision: unknown }[] = [];
  let snapshot = { status: 'ready', value, base: 0, user: 0, revision: options.revision ?? 3, writable: options.writable ?? true };
  const listeners = new Set<() => void>();
  return {
    mutations,
    push: (next: unknown) => {
      snapshot = { ...snapshot, value: next, revision: (snapshot.revision ?? 0) + 1 };
      for (const listener of [...listeners]) listener();
    },
    form: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      mutate: async (ops: unknown, revision?: number) => {
        mutations.push({ ops, revision });
        snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1 };
        for (const listener of [...listeners]) listener();
        return true;
      }
    }
  };
}

/** The plugin's client bundle, evaluated against a stub module table. */
interface LoadedBundle {
  factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}

/**
 * Evaluate the committed artifact with exactly the globals a browser provides.
 *
 * The bundle runs in the VM's own realm, so `fetch` and the timers have to be
 * injected: unqualified lookups inside the bundle resolve against the sandbox.
 * @param globals - browser globals the bundle may reach.
 * @returns the captured module-loader entry.
 */
function loadBundle(globals: Record<string, unknown> = {}): LoadedBundle {
  let captured: LoadedBundle | undefined;
  const sandbox = { window: { __ModuleLoader__: { load: (entry: LoadedBundle): void => void (captured = entry) } }, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'), sandbox, { filename: 'client.js' });
  assert.ok(captured !== undefined, 'the bundle did not register with the module loader');
  return captured;
}

/** Mount the page the way the client loader would, and render it once. */
interface Mounted {
  runtime: HookRuntime;
  tree: unknown;
  observed: Observed;
  registered: { options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }[];
  dictionaries: Record<string, Record<string, string>>;
  effects: string[];
  slots: string[];
  services: string[][];
  /** Fire one live timer the page scheduled. */
  fireTimer(id: number): void;
  unmount(): void;
}

/** Run the committed artifact with only the globals a browser would provide. */
async function mountPanel(options: {
  facts: PanelRuntimeFacts;
  served?: readonly string[];
  form: Record<string, unknown>;
  language?: 'zh' | 'en';
}): Promise<Mounted> {
  const language = options.language ?? 'zh';
  const observed: Observed = { calls: [], clears: [], timers: [] };
  const fetchImpl = makeTransport(options.facts, observed);
  const registered: Mounted['registered'] = [];
  const dictionaries: Record<string, Record<string, string>> = {};
  const effects: string[] = [];
  const slots: string[] = [];
  const services: string[][] = [];
  const teardown: (() => void)[] = [];

  // The bundle is evaluated in the VM's own realm, so every browser global it
  // reaches (fetch, timers) has to be provided here.
  const clock = makeClock(observed);
  const bundle = loadBundle({ fetch: fetchImpl, ...clock.globals, console });

  const ctx: Record<string, unknown> = {
    locale: {
      register: (ns: string, value: Record<string, Record<string, string>>) => {
        dictionaries[ns] = value[language] as Record<string, string>;
        return () => undefined;
      },
      bind: (ns: string) => (key: string) => dictionaries[ns]?.[key] ?? key
    },
    slots: {
      inject: (name: string, register: () => () => void) => {
        slots.push(name);
        return register();
      },
      register: (opts: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
        registered.push({ options: opts, component });
        return () => undefined;
      }
    },
    configForms: {
      get: () => options.form,
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        void namespaces;
        return register(new Set(options.served ?? ['dsh-reflex']));
      }
    },
    effect: (callback: () => void | (() => void), label?: string) => {
      effects.push(label ?? 'anonymous');
      const cleanup = callback();
      if (typeof cleanup === 'function') teardown.push(cleanup);
    },
    inject: (dependencies: readonly string[], callback: (scope: Record<string, unknown>) => void) => {
      services.push([...dependencies]);
      callback(ctx);
    }
  };

  let runtime: HookRuntime | undefined;
  const reactor = {
    createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown =>
      (runtime as HookRuntime).createElement(type, props, ...children),
    useRef: (initial: unknown) => (runtime as HookRuntime).useRef(initial),
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => (runtime as HookRuntime).useMemo(factory, deps),
    useCallback: (callback: unknown) => (runtime as HookRuntime).useCallback(callback),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => (runtime as HookRuntime).useEffect(effect, deps),
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) =>
      (runtime as HookRuntime).useSyncExternalStore(subscribe, getSnapshot),
    useState: (initial: unknown) => (runtime as HookRuntime).useState(initial)
  };

  const exported = bundle.factory((spec) => {
    assert.equal(spec, 'react', `the bundle required "${spec}"`);
    return reactor;
  });
  (exported.apply as (scope: Record<string, unknown>) => void)(ctx);

  assert.ok(registered.length >= 1, 'the page did not register');
  const page = (registered.find(r => r.options.name === 'settings.section') ?? registered[0]) as Mounted['registered'][number];
  const props = { ...(page.options.inject as () => Record<string, unknown>)(), close: () => undefined };
  runtime = new HookRuntime(page.component, () => props);
  const tree = await runtime.flush();

  return {
    runtime,
    tree,
    observed,
    registered,
    dictionaries,
    effects,
    slots,
    services,
    fireTimer: (id: number) => clock.fire(id),
    unmount: () => {
      runtime?.unmount();
      teardown.forEach((callback) => callback());
    }
  };
}

//#endregion

//#region activation and registration

test('the browser half activates, translates, and registers one settings page', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });

  // Entry contract: shell-provided services, reached by scoped injection.
  assert.deepEqual(mounted.effects, ['reflex panel locale']);
  assert.ok(mounted.slots.includes('settings.section'));
  assert.deepEqual(Object.keys(mounted.dictionaries), ['dsh-reflex.panel']);
  assert.equal(mounted.dictionaries['dsh-reflex.panel']?.title, 'Reflex · System One 决策运行时');
  // The English dictionary mirrors every key the Chinese one has.
  assert.deepEqual(
    Object.keys(mounted.dictionaries['dsh-reflex.panel'] ?? {}).sort(),
    Object.keys(mounted.dictionaries['dsh-reflex.panel'] ?? {}).sort()
  );

  const options = (mounted.registered.find(r => r.options.name === 'settings.section') ?? mounted.registered[0])?.options ?? {};
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'reflex');
  assert.equal(options.locale, 'dsh-reflex.panel');
  assert.equal(options.order, 55);
  assert.equal((options.label as () => string)(), 'Reflex 决策运行时');
  assert.deepEqual(plain((options.inject as () => Record<string, unknown>)()), { ns: 'dsh-reflex' });

  const text = textOf(mounted.tree);
  for (const label of ['概览', '虚拟 Provider', '推理强度', 'System 1 后端', '决策账本', '使用说明']) {
    assert.ok(text.includes(label), `the page does not offer the "${label}" page`);
  }
  mounted.unmount();
});

test('the direct registration registers into settings.section and plugins.bundle.config', () => {
  const registered: any[] = [];
  const ctx = {
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (opts: unknown) => {
        registered.push(opts);
        return () => undefined;
      }
    },
    effect: (callback: () => void | (() => void)) => void callback(),
    inject: (_dependencies: readonly string[], callback: (scope: never) => void) => callback(ctx as never)
  };
  const bundle = loadBundle();
  (bundle.factory(() => ({}))['apply'] as (scope: unknown) => void)(ctx);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, 'settings.section');
  assert.equal(registered[1].name, 'plugins.bundle.config');
});

//#endregion

//#region read paths

test('the overview renders the Host projection, not a rewrite of it', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  const text = textOf(mounted.tree);

  assert.deepEqual(mounted.observed.calls, [{ url: PANEL_ROUTES.snapshot, method: 'GET' }]);
  const metrics: [string, string][] = [
    ['2', 'total decisions'],
    ['1,024', 'tokens saved'],
    ['$0.500', 'cost saved'],
    ['10.3 ms', 'average latency'],
    ['3 / 1', 'gate pass/fail split']
  ];
  for (const [value, what] of metrics) assert.ok(text.includes(value), `missing ${what}: ${text.slice(0, 240)}`);
  // Routing and the latest decision come from the same snapshot.
  assert.ok(text.includes('reflex-pro'), 'the virtual model pool is not shown');
  assert.ok(text.includes('1 候选'), 'the pool candidate count is not shown');
  assert.ok(text.includes('reflex: high (confidence 0.82, system-one, 12.4 ms)'), 'the latest decision line is not shown');
  mounted.unmount();
});

test('the routing page reads the authored section back as authored', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  const tree = await mounted.runtime.flush();

  assert.equal(inputOf(tree, '虚拟 Provider 名称'), 'reflex');
  assert.equal(inputOf(tree, '兜底目标'), 'deepseek:deepseek-chat');
  assert.equal(inputOf(tree, '任务文本预算'), '400');
  const values = elements(tree)
    .filter((element) => element.type === 'input')
    .map((element) => String(element.props.value));
  assert.ok(values.includes('reflex-pro'), `the pool model id is not editable: ${values.join('|')}`);
  assert.ok(values.includes('deepseek'), 'the candidate provider is not editable');
  assert.equal(checkboxOf(tree, '虚拟 Provider').props.checked, true);
  mounted.unmount();
});

test('one edit inside a group becomes one whole-section write', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'saving did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(ops.map((op) => [op.op, op.path]), [['set', ['routing']]]);
  const value = ops[0]?.value ?? {};
  assert.equal(value.enabled, false);
  assert.equal(value.fallback, 'deepseek:deepseek-chat', 'the fallback must round-trip as the authored string');
  assert.deepEqual(value.models, {
    'reflex-pro': [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }]
  });
  assert.equal(mutations[0]?.revision, 3, 'the write must carry the revision it was based on');
  assert.ok(textOf(tree).includes('已保存'), 'the save was not acknowledged');
  mounted.unmount();
});

test('the group the page writes satisfies the Host validator', () => {
  // The client's write path is only correct if the Host accepts its output shape.
  const resolved = resolveConfig(AUTHORED);
  assert.deepEqual(plain(resolved.routing.models), plain(AUTHORED.routing?.models));
  assert.equal(resolved.routing.fallback?.provider, 'deepseek');
  assert.equal(resolved.routing.fallback?.model, 'deepseek-chat');
  assert.equal(resolved.routing.maxTaskChars, 400);
  // The resolved block normalises the authored `reasoningEffort` to `setting`.
  assert.deepEqual(plain(resolved.effort), { enabled: true, setting: 'reflex', fallback: 'low', minConfidence: 0.3 });
});

test('the candidate pool can be extended, reordered, and written back', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  // Add a candidate, then fill its two required fields.
  fire(find(tree, 'button', '新增候选'), 'onClick');
  tree = await mounted.runtime.flush();
  const providers = elements(tree).filter((element) => element.type === 'input' && element.props.placeholder === '物理 Provider');
  const models = elements(tree).filter((element) => element.type === 'input' && element.props.placeholder === '物理模型');
  assert.equal(providers.length, 2, 'the new candidate row did not appear');
  assert.equal(String(providers[0]?.props.value), 'deepseek', 'the existing candidate must keep its position');
  type(providers[1], 'moonshot');
  type(models[1], 'kimi-k2');
  tree = await mounted.runtime.flush();

  // A newly added candidate is last in the pool; promote it, which is the preference.
  const up = elements(tree).filter((element) => element.type === 'button' && textOf(element) === '↑' && element.props.disabled !== true);
  assert.equal(up.length, 1, 'exactly the second candidate can be promoted');
  fire(up[0], 'onClick');
  tree = await mounted.runtime.flush();

  fire(find(tree, 'button', '保存'), 'onClick');
  await mounted.runtime.flush();
  assert.equal(mutations.length, 1);
  const ops = plain(mutations[0]?.ops) as { value: { models: Record<string, { provider: string; model: string }[]> } }[];
  assert.deepEqual(ops[0]?.value.models['reflex-pro'], [
    { provider: 'moonshot', model: 'kimi-k2' },
    { provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }
  ]);
  mounted.unmount();
});

test('an invalid draft is reported and never written', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  // Blanking a required field must show the reason instead of a broken write.
  type(elements(tree).find((element) => element.type === 'input' && element.props.value === 'reflex'), '');
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.ok(textOf(tree).includes('虚拟 Provider 名称不能为空'), `the refusal is not explained: ${textOf(tree).slice(0, 200)}`);
  assert.deepEqual(mutations, [], 'an invalid draft reached the Host');

  // A second invalid field replaces the first problem, not accumulates silently.
  type(inputElement(tree, '任务文本预算'), '0');
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  const text = textOf(tree);
  assert.ok(text.includes('虚拟 Provider 名称不能为空'), 'the first problem disappeared');
  assert.ok(text.includes('任务文本预算必须是正整数'), 'the new problem is not reported');
  assert.deepEqual(mutations, []);
  mounted.unmount();
});

test('the effort page offers exactly the levels the Host accepts', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '推理强度');
  const tree = await mounted.runtime.flush();

  assert.deepEqual(optionsOf(tree, '推理强度策略'), ['', ...EFFORT_TRIGGERS, ...EFFORT_LEVELS]);
  assert.deepEqual(optionsOf(tree, '兜底档位'), [...ADAPTIVE_EFFORT_LEVELS]);
  assert.equal(inputOf(tree, '最小置信度'), '0.3');
  assert.ok(textOf(tree).includes('0.82'), 'the last decision confidence is not shown');
  mounted.unmount();
});

test('the interventions page writes the three-state block the Host validates', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '自动干预');
  let tree = await mounted.runtime.flush();

  const cap = elements(tree).find((e) => e.type === 'label' && textOf(e) === '停滞豁免');
  // The master mode cannot inherit; a capability can, and does by default.
  assert.deepEqual(optionsOf(tree, '主模式'), [...INTERVENTION_MODES], 'the master mode offers the wrong settings');
  const capabilityLabels = ['停滞豁免', '结果裁剪', '失败门禁', '收尾异议'];
  assert.equal(capabilityLabels.length, INTERVENTION_CAPABILITIES.length, 'a capability is not on the page');
  for (const capability of capabilityLabels) {
    assert.deepEqual(optionsOf(tree, capability), [...INTERVENTION_SETTINGS], `${capability} cannot express every setting`);
    assert.equal(String(selectOf(tree, capability).props.value), 'inherit', `${capability} is not seeded as inherited`);
  }
  assert.equal(inputOf(tree, '窗口大小'), '6');
  assert.ok(textOf(tree).includes('观察（observe）'), 'the effective mode from the snapshot is not shown');

  fire(selectOf(tree, '主模式'), 'onChange', { target: { value: 'active' } });
  fire(selectOf(tree, '结果裁剪'), 'onChange', { target: { value: 'off' } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'saving did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(ops.map((op) => [op.op, op.path]), [['set', ['interventions']]]);
  const value = ops[0]?.value ?? {};
  assert.equal(value.mode, 'active');
  assert.deepEqual(value.capabilities, { prune: 'off' }, 'only the capability the user changed is authored');
  assert.equal(value.windowSize, 6, 'a budget must be written as a number, not as the field text');
  assert.equal(typeof value.minConfidence, 'number');
  assert.equal('intent' in value, false, 'a blank intent must be omitted, not pinned to an empty string');

  // The Host accepts exactly what the page wrote, and derives the rest.
  const resolved = resolveConfig({ ...AUTHORED, interventions: value as ReflexConfig['interventions'] });
  assert.equal(resolved.interventions.mode, 'active');
  assert.deepEqual(resolved.interventions.capabilities, { stagnation: 'active', prune: 'off', gate: 'active', closing: 'active' });
  mounted.unmount();
});

test('the interventions page refuses a budget the Host would refuse', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '自动干预');
  let tree = await mounted.runtime.flush();

  type(inputElement(tree, '重复阈值'), '1');
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.ok(textOf(tree).includes('预算与阈值必须是'), `the refusal is not explained: ${textOf(tree).slice(0, 200)}`);
  assert.deepEqual(mutations, [], 'a draft the Host would refuse reached the Host');
  mounted.unmount();
});

test('the switch pages seed the documented defaults and pin nothing when nothing was authored', async () => {
  const { form, mutations } = settingsForm({});
  const mounted = await mountPanel({ facts: facts(true), form });

  openTab(mounted.tree, '自动干预');
  let tree = await mounted.runtime.flush();
  assert.equal(String(selectOf(tree, '主模式').props.value), 'observe', 'the master mode does not default to observe');
  assert.equal(inputOf(tree, '每轮最大干预数'), '3');
  assert.equal(inputOf(tree, '每会话最大判定数'), '20');
  assert.equal(inputOf(tree, '裁剪保留下限比例'), '0.5');

  openTab(tree, '工具开关');
  tree = await mounted.runtime.flush();
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    assert.equal(
      checkboxOf(tree, `reflex_${suffix}`).props.checked,
      suffix !== 'route',
      `${suffix} does not show its documented default`
    );
  }

  fire(find(tree, 'button', '保存'), 'onClick');
  await mounted.runtime.flush();
  const ops = plain(mutations.flatMap((entry) => entry.ops as unknown[])) as { path: string[] }[];
  for (const op of ops) {
    assert.equal(['interventions', 'tools'].includes(op.path[0] ?? ''), false, `visiting the page pinned ${op.path.join('.')}`);
  }
  mounted.unmount();
});

test('authored switches are read back, and rewriting them does not freeze what was inherited', async () => {
  const authored = {
    ...AUTHORED,
    // One authored departure in each direction: a tool switched off, and the
    // opt-in tool switched on.
    tools: { enabled: { gate: false, route: true } },
    interventions: { mode: 'off', capabilities: { gate: 'observe' } }
  } as ReflexConfig;
  const { form, mutations } = settingsForm(authored);
  const mounted = await mountPanel({ facts: facts(true), form });

  openTab(mounted.tree, '工具开关');
  let tree = await mounted.runtime.flush();
  assert.equal(checkboxOf(tree, 'reflex_gate').props.checked, false, 'an authored switch is not read back');
  assert.equal(checkboxOf(tree, 'reflex_route').props.checked, true, 'an authored opt-in is not read back');
  assert.equal(checkboxOf(tree, 'reflex_choice').props.checked, true);

  // Reopening one tool must *remove* its key instead of pinning it to true,
  // while the departure in the other direction stays authored.
  fire(checkboxOf(tree, 'reflex_gate'), 'onChange', { target: { checked: true } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  const tools = plain(mutations[0]?.ops) as { path: string[]; value: unknown }[];
  assert.deepEqual(tools.map((op) => op.path), [['tools']]);
  assert.deepEqual(tools[0]?.value, { enabled: { route: true } });

  // The interventions page keeps the authored override and changes only the mode.
  mutations.length = 0;
  openTab(tree, '自动干预');
  tree = await mounted.runtime.flush();
  assert.equal(String(selectOf(tree, '主模式').props.value), 'off', 'the authored mode is not read back');
  assert.equal(String(selectOf(tree, '失败门禁').props.value), 'observe', 'the authored capability override is not read back');
  assert.equal(String(selectOf(tree, '结果裁剪').props.value), 'inherit');
  fire(selectOf(tree, '主模式'), 'onChange', { target: { value: 'active' } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  await mounted.runtime.flush();
  const interventions = plain(mutations[0]?.ops) as { path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(interventions.map((op) => op.path), [['interventions']]);
  assert.equal(interventions[0]?.value.mode, 'active');
  assert.deepEqual(
    interventions[0]?.value.capabilities,
    { gate: 'observe' },
    'an authored override must survive the write and an inherited one must stay omitted'
  );
  mounted.unmount();
});

test('the tools page closes one tool and writes exactly that switch', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '工具开关');
  let tree = await mounted.runtime.flush();

  // One switch per suffix, labelled with the registered name under the draft
  // prefix. Each one starts at its documented default, not at "on".
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    assert.equal(
      checkboxOf(tree, `reflex_${suffix}`).props.checked,
      suffix !== 'route',
      `${suffix} does not start at its documented default`
    );
  }
  const effective = textOf(tree);
  assert.ok(!effective.includes('尚未读取到运行时状态'), 'the Host projection of the registered surface was not read');
  // The read-only card renders one bare row per registered name; the switch
  // labels above carry the same prefix, so read the card's own rows instead of
  // every occurrence of the name on the page.
  const registeredRows = (of: unknown): string[] =>
    elements(of)
      .filter(
        (element) =>
          element.type === 'div' &&
          element.children.length === 1 &&
          typeof element.children[0] === 'string' &&
          (element.children[0] as string).startsWith('reflex_')
      )
      .map((element) => element.children[0] as string);
  assert.deepEqual(
    registeredRows(tree),
    REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route').map((suffix) => `reflex_${suffix}`),
    'the effective card must list exactly the four tools the default registers'
  );

  fire(checkboxOf(tree, 'reflex_gate'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'saving did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: unknown }[];
  assert.deepEqual(ops.map((op) => [op.op, op.path]), [['set', ['tools']]]);
  assert.deepEqual(ops[0]?.value, { enabled: { gate: false } }, 'only the departure from the default is written');

  // The Host takes the written block and closes exactly that tool.
  const resolved = resolveConfig({ ...AUTHORED, tools: ops[0]?.value as ReflexConfig['tools'] });
  assert.equal(resolved.tools.enabled.gate, false);
  assert.equal(resolved.tools.enabled.route, false, 'closing gate must not switch the opt-in tool on');
  assert.equal(Object.values(resolved.tools.enabled).filter((on) => !on).length, 2, 'gate is closed and route keeps its off default');
  mounted.unmount();
});

test('every tool explains itself and the recommended set can be pre-filled', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '工具开关');
  let tree = await mounted.runtime.flush();

  // A distinctive fragment of the "what it does" and "when to call it" sentence,
  // per tool: the page has to explain the tool, not repeat one generic line.
  const explains: Record<string, [string, string]> = {
    choice: ['概率分布', '二选一'],
    score: ['0–1 的连续分', '连续评分'],
    route: ['概率排序', '缩小范围'],
    screen: ['提示注入', '不可信输入'],
    gate: ['逐条核对', '验收判据']
  };
  const copy = textOf(tree);
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    const [what, when] = explains[suffix] ?? ['', ''];
    assert.ok(copy.includes(what), `${suffix} does not say what it does`);
    assert.ok(copy.includes(when), `${suffix} does not say when to call it`);
  }

  // The advice is stated per tool: four suggested, one to turn on when needed.
  // Counts, so a misplaced label is caught too.
  const occurrences = (needle: string): number => copy.split(needle).length - 1;
  assert.equal(occurrences('建议暴露'), 4, 'the tools the agent should keep are not marked as such');
  assert.equal(occurrences('按需开启'), 1, 'route is the one tool that is not part of the recommended set');
  assert.equal(occurrences('已由自动干预覆盖'), 0, 'the intervention-covered advice outlived the tools it described');
  assert.equal(occurrences('仅诊断'), 0, 'the diagnostic-only advice outlived the ledger tool');
  assert.equal(occurrences('按后缀开关，与工具名前缀无关'), 0, 'the generic per-tool hint is still repeated');

  // The ledger left the tool surface, so the page says where it went; and no
  // switch survives for a capability that is no longer a tool.
  assert.ok(copy.includes('/reflex-ledger'), 'the tools page must point at the ledger command');
  for (const gone of ['reflex_prune', 'reflex_detect_stagnation', 'reflex_status_ledger']) {
    assert.equal(copy.includes(gone), false, `${gone} is still presented as a tool`);
  }

  // The recommendation is the review table, written out here on purpose: the test
  // is the spec, not a copy of the panel's own constant.
  const recommended: Record<string, boolean> = {
    choice: true,
    score: true,
    route: false,
    screen: true,
    gate: true
  };
  fire(find(tree, 'button', '应用推荐组合'), 'onClick');
  tree = await mounted.runtime.flush();
  for (const [suffix, on] of Object.entries(recommended)) {
    assert.equal(checkboxOf(tree, `reflex_${suffix}`).props.checked, on, `applying the recommendation left ${suffix} at ${String(!on)}`);
  }
  assert.equal(mutations.length, 0, 'pre-filling the recommendation wrote to the settings document');

  // Saving it writes nothing: the recommended set *is* the documented default,
  // so there is no departure to author and the Host is left untouched.
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 0, 'a set that already matches the default must not be written');

  // A real departure is written — and written alone.
  fire(checkboxOf(tree, 'reflex_route'), 'onChange', { target: { checked: true } });
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 1, 'saving the departure did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { path: string[]; value: { enabled: Record<string, boolean> } }[];
  assert.deepEqual(ops.map((op) => op.path), [['tools']]);
  assert.deepEqual(
    ops[0]?.value,
    { enabled: { route: true } },
    'the recommended tools must be omitted, and only the opt-in departure authored'
  );
  const resolved = resolveConfig({ ...AUTHORED, tools: ops[0]?.value as ReflexConfig['tools'] });
  assert.equal(resolved.tools.enabled.route, true, 'the Host reads the authored opt-in back');
  assert.equal(resolved.tools.enabled.choice, true);
  mounted.unmount();
});

test('the effort page can turn adaptive effort off, and writes it with its group', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '推理强度');
  let tree = await mounted.runtime.flush();

  assert.equal(checkboxOf(tree, '启用自适应推理强度').props.checked, true, 'adaptive effort does not start enabled');
  fire(checkboxOf(tree, '启用自适应推理强度'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  assert.ok(textOf(tree).includes('不再做自适应判定'), 'the consequence of switching off is not explained');
  fire(find(tree, 'button', '保存'), 'onClick');
  await mounted.runtime.flush();

  const ops = plain(mutations[0]?.ops) as { path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(ops.map((op) => op.path), [['effort']]);
  assert.equal(ops[0]?.value.enabled, false);
  assert.equal(ops[0]?.value.reasoningEffort, 'reflex', 'the group write must keep the level that was authored');
  assert.equal(resolveConfig({ ...AUTHORED, effort: ops[0]?.value as ReflexConfig['effort'] }).effort.enabled, false);
  mounted.unmount();
});

test('the backend page shows where the key lives, never the key', async () => {
  process.env.REFLEX_TEST_KEY = SECRET;
  try {
    const { form } = settingsForm(AUTHORED);
    const mounted = await mountPanel({ facts: facts(true), form });
    openTab(mounted.tree, 'System 1 后端');
    const tree = await mounted.runtime.flush();
    const text = textOf(tree);

    assert.equal(inputOf(tree, 'API Key 环境变量名'), 'REFLEX_TEST_KEY');
    assert.equal(inputOf(tree, 'Base URL'), 'http://127.0.0.1:8000/v1');
    assert.ok(!text.includes(SECRET), 'the page rendered an API key value');
    assert.ok(text.includes('环境变量已就绪'), 'the page does not say whether the key is present');
    mounted.unmount();
  } finally {
    delete process.env.REFLEX_TEST_KEY;
  }
});

test('the backend page reports a missing key variable', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(false), form });
  openTab(mounted.tree, 'System 1 后端');
  const tree = await mounted.runtime.flush();
  assert.ok(textOf(tree).includes('环境变量为空'), 'a missing key is not reported');
  assert.equal(inputOf(tree, 'API Key 环境变量名'), 'REFLEX_TEST_KEY');
  mounted.unmount();
});

//#region host write contract

/** The part of a schemastery node the write contract walks. */
interface HostSchemaNode {
  meta: { volatile?: boolean };
  dict?: Record<string, HostSchemaNode>;
}

/** The plugin's schema, narrowed to the shape the contract check walks. */
const HOST_CONFIG = Config as unknown as HostSchemaNode;

/**
 * Whether the Host would let a settings form write at `path`.
 *
 * Transcribed from `@deepseek-ai/dsh-settings`: a write is refused unless every
 * path it addresses is *volatile*, and a path is volatile when the schema node it
 * names — or any node above it — carries the `volatile` meta. The browser half
 * cannot import the Host schema, so the panel's real output is checked against the
 * plugin's own `Config` here. The panel did get this wrong once: it addressed the
 * Host with its own view group name `runtime`, which is not a field of `Config`,
 * and the whole write was refused.
 * @param schema - schema node to walk.
 * @param path - path segments, outermost first.
 * @returns whether the Host would accept a write there.
 */
function hostAcceptsPath(schema: HostSchemaNode, path: readonly string[]): boolean {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && hostAcceptsPath(child, rest);
}

/** Apply path ops to a section the way the Host does, so the resolver can read it. */
function applyOps(ops: readonly { op: string; path: string[]; value?: unknown }[]): Record<string, unknown> {
  const section: Record<string, unknown> = {};
  const edit = (at: Record<string, unknown>, path: readonly string[], op: { op: string; value?: unknown }): void => {
    const [head, ...rest] = path;
    if (head === undefined) return;
    if (rest.length === 0) {
      if (op.op === 'set') at[head] = op.value;
      else delete at[head];
      return;
    }
    const child = (at[head] ?? {}) as Record<string, unknown>;
    at[head] = child;
    edit(child, rest, op);
  };
  for (const op of ops) edit(section, op.path, op);
  return section;
}

/**
 * Type the two fields that change on the System 1 backend page.
 * @param tree - the rendered page.
 */
function editBackendPage(tree: unknown): void {
  type(inputElement(tree, '超时（毫秒）'), '9000');
  type(inputElement(tree, '工具名前缀'), 'rv_');
}

//#endregion

test('the System 1 backend page writes the scalar and its block, on the paths the Host declares', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  editBackendPage(tree);
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '保存'), 'onClick');
  await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'saving did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.deepEqual(
    ops.map((op) => [op.op, op.path]),
    [
      ['set', ['backend']],
      ['set', ['systemOne']],
      ['set', ['toolPrefix']],
      ['unset', ['ledgerPath']],
      ['set', ['pruneThreshold']],
      ['unset', ['calibrationPath']]
    ],
    'the backend page must address the fields the Host declares, never its own group name'
  );
  assert.equal(ops[0]?.value, 'jev', '`backend` is a scalar union, never a block');
  const systemOne = (ops[1]?.value ?? {}) as Record<string, unknown>;
  assert.equal(systemOne.timeoutMs, 9000);
  assert.equal(systemOne.baseUrl, 'http://127.0.0.1:8000/v1', 'an untouched field must round-trip');

  // The Host accepts what the page wrote, and each field lands where it belongs.
  const resolved = resolveConfig({ ...AUTHORED, ...applyOps(ops) } as ReflexConfig);
  assert.equal(resolved.backend, 'jev');
  assert.equal(resolved.toolPrefix, 'rv_');
  assert.equal(resolved.systemOne.timeoutMs, 9000);
  assert.equal(resolved.systemOne.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(resolved.pruneThreshold, 500);
  mounted.unmount();
});

test('every path the panel writes is a path the Host declares volatile', async () => {
  // One save per page, each one changing the group that page owns: the union of
  // the ops is then the complete write surface, and every path in it has to pass
  // the Host's own pre-check.
  const perturbs: { tab: string; edit: (tree: unknown) => void }[] = [
    { tab: '虚拟 Provider', edit: (tree) => fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } }) },
    { tab: '推理强度', edit: (tree) => fire(checkboxOf(tree, '启用自适应推理强度'), 'onChange', { target: { checked: false } }) },
    { tab: 'System 1 后端', edit: editBackendPage },
    { tab: '自动干预', edit: (tree) => fire(selectOf(tree, '主模式'), 'onChange', { target: { value: 'active' } }) },
    // Closing a tool that is on by default is a real departure, so this page
    // still reaches the document even though its recommendation matches the default.
    { tab: '工具开关', edit: (tree) => fire(checkboxOf(tree, 'reflex_gate'), 'onChange', { target: { checked: false } }) }
  ];
  const paths = new Set<string>();
  for (const perturb of perturbs) {
    const { form, mutations } = settingsForm(AUTHORED);
    const mounted = await mountPanel({ facts: facts(true), form });
    openTab(mounted.tree, perturb.tab);
    let tree = await mounted.runtime.flush();
    perturb.edit(tree);
    tree = await mounted.runtime.flush();
    fire(find(tree, 'button', '保存'), 'onClick');
    await mounted.runtime.flush();

    assert.equal(mutations.length, 1, `${perturb.tab}: saving did not reach the settings form`);
    const ops = plain(mutations[0]?.ops) as { op: string; path: string[] }[];
    for (const op of ops) {
      assert.ok(hostAcceptsPath(HOST_CONFIG, op.path), `${perturb.tab} writes ${op.path.join('.')}, which the Host refuses as non-volatile`);
      paths.add(op.path.join('.'));
    }
    mounted.unmount();
  }
  assert.deepEqual(
    [...paths].sort(),
    ['backend', 'calibrationPath', 'effort', 'interventions', 'ledgerPath', 'pruneThreshold', 'routing', 'systemOne', 'toolPrefix', 'tools'],
    'the pages stopped covering every writable field, so this fence is no longer checking them all'
  );
});

test('the ledger page lists decisions and clears only after confirmation', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '决策账本');
  let tree = await mounted.runtime.flush();
  let text = textOf(tree);

  assert.ok(text.includes('推理强度'), 'the effort decision row is not listed');
  assert.ok(text.includes('ranked · deepseek:deepseek-chat · pool-order'), `the routing detail is not listed: ${text.slice(0, 300)}`);
  assert.ok(text.includes('/tmp/reflex-ledger.jsonl'), 'the sink path is not shown');
  assert.ok(text.includes('12.4 ms'), 'row latency missing');

  // The first click only arms the action; nothing may be deleted yet.
  fire(find(tree, 'button', '清空账本'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.deepEqual(mounted.observed.clears, [], 'the first click cleared the ledger');
  assert.ok(textOf(tree).includes('再次点击确认清空'), 'the confirmation state is not offered');
  assert.deepEqual(mounted.observed.calls.filter((call) => call.method === 'POST'), []);

  fire(find(tree, 'button', '再次点击确认清空'), 'onClick');
  tree = await mounted.runtime.flush();
  assert.deepEqual(mounted.observed.clears, [1], 'the confirmed click did not clear the ledger');
  assert.deepEqual(
    mounted.observed.calls.filter((call) => call.method === 'POST').map((call) => call.url),
    ['/dsh-reflex/api/ledger/clear?confirm=clear']
  );
  assert.ok(textOf(tree).includes('已清空 2 条记录'), `the clear was not acknowledged: ${textOf(tree).slice(0, 240)}`);
  mounted.unmount();
});

//#endregion

//#region state, language, and lifecycle

test('a read-only settings document renders but refuses to write', async () => {
  const { form, mutations } = settingsForm(AUTHORED, { writable: false });
  const mounted = await mountPanel({ facts: facts(false), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  // Every control is disabled, and the page says why.
  assert.equal(checkboxOf(tree, '虚拟 Provider').props.disabled, true);
  assert.ok(textOf(tree).includes('只读'), 'the page does not say why it cannot write');

  // Make the draft dirty through a disabled field, so the refusal below is about
  // permission and not about there being nothing to save, then call the disabled
  // save path directly: a disabled control is a hint, not a guarantee.
  type(inputElement(tree, '任务文本预算'), '900');
  tree = await mounted.runtime.flush();
  const save = find(tree, 'button', '保存');
  assert.equal(save?.props.disabled, true, 'the save action must be disabled when the document is read-only');
  fire(save, 'onClick');
  tree = await mounted.runtime.flush();
  assert.deepEqual(mutations, [], 'a read-only document accepted a write');
  assert.equal(inputOf(tree, '任务文本预算'), '900', 'the draft was not the one under test');
  mounted.unmount();
});

test('the page follows the Host language', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form, language: 'en' });
  const text = textOf(mounted.tree);

  assert.ok(text.includes('Reflex · System One decision runtime'), `the English copy is missing: ${text.slice(0, 200)}`);
  assert.ok(text.includes('Overview') && text.includes('Decision ledger'), 'the English tab labels are missing');
  assert.ok(text.includes('Guide'), 'the English guide tab label is missing');
  assert.ok(!text.includes('决策账本'), 'the Chinese copy leaked into the English page');
  mounted.unmount();
});

test('the page polls on its own schedule and stops when disposed', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });

  assert.deepEqual(mounted.observed.timers.map((timer) => timer.ms), [4000], 'the page does not schedule its refresh');
  const reads = mounted.observed.calls.length;
  const first = mounted.observed.timers[0];
  assert.ok(first !== undefined);
  mounted.fireTimer(first.id);
  await settle();
  assert.equal(mounted.observed.calls.length, reads + 1, 'a scheduled tick did not read the snapshot');
  assert.deepEqual(mounted.observed.timers.map((timer) => timer.ms), [4000], 'a tick must schedule the next one');

  mounted.unmount();
  assert.deepEqual(mounted.observed.timers, [], 'an unmounted page left its timer scheduled');
  await settle();
  assert.equal(mounted.observed.calls.length, reads + 1, 'an unmounted page kept reading');
});

test('the page re-seeds when the Host changes the document underneath it', async () => {
  const settings = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form: settings.form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();
  assert.equal(inputOf(tree, '虚拟 Provider 名称'), 'reflex');

  // The Host pushes a new document (another surface wrote it); the draft follows.
  settings.push({ ...AUTHORED, routing: { ...AUTHORED.routing, virtualProvider: 'reflex-edge' } });
  tree = await mounted.runtime.flush();
  assert.equal(inputOf(tree, '虚拟 Provider 名称'), 'reflex-edge', 'the page ignored a document the Host changed');
  mounted.unmount();
});

test('the guide page renders the shipped user guide inside the panel', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '使用说明');
  const tree = await mounted.runtime.flush();
  const text = textOf(tree);

  // The document itself, not a summary of it: a heading, a section further down,
  // a table row and a command from the build section all have to be there.
  for (const probe of [
    'Harness Reflex 使用说明',
    '1. Harness Reflex 是什么',
    '虚拟 Provider 与模型池',
    'npm run build:all',
    // The ledger is a command on the plugin side now, so the guide has to say so.
    '/reflex-ledger'
  ]) {
    assert.ok(text.includes(probe), `the guide page is missing "${probe}"`);
  }
  // Structure survives the renderer: headings, tables and code blocks are elements.
  const types = new Set(elements(tree).map((element) => element.type));
  for (const type of ['h1', 'h2', 'table', 'pre', 'li']) {
    assert.ok(types.has(type), `the rendered guide has no <${type}>`);
  }
  // Provenance: which revision of which file is on screen.
  assert.ok(text.includes('USER_GUIDE.md'), 'the guide page does not name its source document');
  const revision = /文档来源 USER_GUIDE\.md · 摘要 ([0-9a-f]{12})/.exec(text);
  assert.ok(revision !== null, `the guide page does not report its revision: ${text.slice(0, 300)}`);
  mounted.unmount();
});

test('the guide page follows the Host language', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form, language: 'en' });
  openTab(mounted.tree, 'Guide');
  const tree = await mounted.runtime.flush();
  const text = textOf(tree);

  assert.ok(text.includes('Harness Reflex User Guide'), 'the English guide is not on the page');
  assert.ok(text.includes('Virtual provider and model pools'), 'the English guide lost a section');
  assert.ok(text.includes('/reflex-ledger'), 'the English guide does not document the ledger command');
  assert.ok(text.includes('docs/USER_GUIDE.en.md'), 'the English guide does not name its source document');
  assert.ok(!text.includes('虚拟 Provider 与模型池'), 'the Chinese guide leaked into the English page');
  mounted.unmount();
});

//#endregion

//#region field guidance: placeholders, (?) disclosures, defaults, accessibility

/** Read a dotted path out of a plain object. */
function readPath(value: unknown, path: string): unknown {
  let current: any = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** Every primitive leaf path of a plain object, skipping arrays and empty nodes. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix === '' ? [] : [prefix];
  if (Array.isArray(value)) return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  }
  return out;
}

/** Schema leaves that a default config leaves unset, so they have no resolved key. */
const OPTIONAL_SCHEMA_PATHS = [
  'routing.fallback',
  'effort.setting',
  'systemOne.baseUrl',
  'systemOne.model',
  'systemOne.apiKeyEnv',
  'systemOne.timeoutMs',
  'ledgerPath',
  'calibrationPath'
] as const;

/** Resolved keys that are derived rather than edited on the page. */
const DERIVED_SCHEMA_PATHS = new Set(['systemOne.backend', 'interventions.enabled']);

/** Schema path → the page group that renders it. */
function tabOfPath(path: string): string {
  if (path.startsWith('routing.')) return 'routing';
  if (path.startsWith('effort.')) return 'effort';
  if (path.startsWith('interventions.')) return 'interventions';
  if (path.startsWith('tools.')) return 'tools';
  return 'backend';
}

/** Copy rules of one language. */
interface GuidanceCopy {
  required: readonly string[];
  optional: readonly string[];
  defaultPattern: RegExp;
  optionalDefault: string;
  leaveDefault: string;
  unsetDefault: string;
  onDefault: string;
  offDefault: string;
}

const GUIDANCE_COPY: Record<'zh' | 'en', GuidanceCopy> = {
  zh: {
    required: ['用途：', '格式：', '默认：'],
    optional: ['留空：', '范围：'],
    defaultPattern: /默认：([^；。]+)/,
    optionalDefault: '不干预',
    leaveDefault: '不干预',
    unsetDefault: '未设置',
    onDefault: '开启',
    offDefault: '关闭'
  },
  en: {
    required: ['Use:', 'Format:', 'Default:'],
    optional: ['Blank:', 'Range:'],
    defaultPattern: /Default: ([^;]+)/,
    optionalDefault: 'leave untouched',
    leaveDefault: 'leave untouched',
    unsetDefault: 'not set',
    onDefault: 'on',
    offDefault: 'off'
  }
};

/** The default a field's help must state, derived from `resolveConfig({})`. */
function expectedDefaultToken(path: string, resolved: unknown, language: 'zh' | 'en'): string | undefined {
  const copy = GUIDANCE_COPY[language];
  if (path === 'effort.setting') return copy.leaveDefault;
  if (path.startsWith('interventions.capabilities.')) return 'inherit';
  if (path.startsWith('tools.enabled.')) {
    const suffix = path.split('.').pop() ?? '';
    const on = Boolean((resolved as any).tools?.enabled?.[suffix]);
    return on ? copy.onDefault : copy.offDefault;
  }
  const value = readPath(resolved, path);
  if (value === undefined) return copy.unsetDefault;
  if (typeof value === 'boolean') return value ? copy.onDefault : copy.offDefault;
  return String(value);
}

/** The `(?)` button of one guided field wrapper. */
function helpButtonOf(wrapper: Element): Element {
  const button = elements(wrapper).find(
    (element) => element.type === 'button' && typeof element.props['aria-describedby'] === 'string'
  );
  assert.ok(button !== undefined, `field ${String(wrapper.props['data-reflex-path'])} has no (?) button`);
  return button as Element;
}

/** The note a field's `aria-describedby` points at. */
function helpNoteOf(wrapper: Element): { id: string; note: Element } {
  const button = helpButtonOf(wrapper);
  const id = String(button.props['aria-describedby']);
  const note = elements(wrapper).find((element) => element.type === 'span' && element.props.id === id);
  assert.ok(note !== undefined, `field ${String(wrapper.props['data-reflex-path'])} points aria-describedby at a missing node`);
  return { id, note: note as Element };
}

test('every schema field carries a placeholder and a four-part (?) explanation', async () => {
  const resolved = resolveConfig({});
  // `pruneJudgeMinChars` is a resolved leaf now (g-014), so the traversal picks
  // it up from `resolveConfig` rather than from a local pending list.
  assert.equal(resolved.interventions.pruneJudgeMinChars, 10000, 'the Host default for the judge threshold changed');
  const expectedPaths = [
    ...leafPaths(resolved).filter((path) => !DERIVED_SCHEMA_PATHS.has(path)),
    ...OPTIONAL_SCHEMA_PATHS
  ];
  const uniquePaths = [...new Set(expectedPaths)];
  assert.ok(uniquePaths.length >= 30, `the schema traversal found only ${uniquePaths.length} fields`);

  const keysByLanguage: Record<string, string[]> = {};
  let covered = 0;

  for (const language of ['zh', 'en'] as const) {
    const copy = GUIDANCE_COPY[language];
    const { form } = settingsForm(AUTHORED);
    const mounted = await mountPanel({ facts: facts(true), form, language });
    keysByLanguage[language] = Object.keys(mounted.dictionaries['dsh-reflex.panel'] ?? {}).sort();

    const tabLabels: Record<string, string> = {
      routing: language === 'zh' ? '虚拟 Provider' : 'Virtual provider',
      effort: language === 'zh' ? '推理强度' : 'Reasoning effort',
      backend: language === 'zh' ? 'System 1 后端' : 'System 1 backend',
      interventions: language === 'zh' ? '自动干预' : 'Interventions',
      tools: language === 'zh' ? '工具开关' : 'Tools'
    };
    const groupOf = (path: string): string => tabOfPath(path);

    const tabs = ['routing', 'effort', 'backend', 'interventions', 'tools'];
    const renderedPaths = new Set<string>();
    for (const tab of tabs) {
      openTab(mounted.tree, tabLabels[tab] as string);
      const tree = await mounted.runtime.flush();
      const wrappers = elements(tree).filter((element) => typeof element.props['data-reflex-path'] === 'string');
      for (const wrapper of wrappers) renderedPaths.add(String(wrapper.props['data-reflex-path']));
      const pathsInTab = uniquePaths.filter((path) => groupOf(path) === tab);
      assert.ok(pathsInTab.length > 0, `no schema field maps to the ${tab} tab`);

      for (const path of pathsInTab) {
        const wrapper = wrappers.find((element) => element.props['data-reflex-path'] === path);
        assert.ok(wrapper !== undefined, `the ${tab} tab does not render field ${path}`);
        covered += 1;

        // Placeholder: every text input must show a non-empty example.
        const control = elements(wrapper).find(
          (element) => element.type === 'input' || element.type === 'select'
        );
        assert.ok(control !== undefined, `field ${path} has no control`);
        const isText = control.type === 'input' && control.props.type === 'text';
        if (isText) {
          const placeholder = String(control.props.placeholder ?? '');
          assert.ok(placeholder.trim().length > 0, `field ${path} has an empty placeholder`);
        }

        // (?) contract: a native, focusable button with aria-label/description.
        const button = helpButtonOf(wrapper);
        assert.equal(button.props.type, 'button', `field ${path} (?) is not a button`);
        assert.notEqual(button.props.disabled, true, `field ${path} (?) is disabled`);
        const ariaLabel = String(button.props['aria-label'] ?? '');
        assert.ok(ariaLabel.trim().length > 3, `field ${path} (?) has no aria-label`);
        const title = String(button.props.title ?? '');
        assert.ok(title.trim().length > 3, `field ${path} (?) lost its native title fallback`);

        const { id, note } = helpNoteOf(wrapper);
        assert.ok(id.startsWith('reflex-help-'), `field ${path} help id is not stable: ${id}`);
        assert.equal(button.props['aria-controls'], id, `field ${path} (?) controls the wrong node`);
        assert.equal(button.props['aria-expanded'], false, `field ${path} (?) starts expanded`);

        const help = textOf(note);
        for (const marker of copy.required) {
          assert.ok(help.includes(marker), `field ${path} help (${language}) lacks "${marker}": ${help}`);
        }
        assert.ok(
          copy.optional.some((marker) => help.includes(marker)),
          `field ${path} help (${language}) lacks a blank/range clause: ${help}`
        );
        assert.ok(help.length > 20, `field ${path} help is too thin: ${help}`);
        assert.equal(title, help, `field ${path} title and aria-describedby copy diverged`);
        if (language === 'en') {
          assert.ok(!/[\u4e00-\u9fff]/.test(help), `field ${path} help leaked Chinese into the English page: ${help}`);
        }

        // Default: the stated value must equal what resolveConfig computes.
        const expected = expectedDefaultToken(path, resolved, language);
        assert.ok(expected !== undefined, `field ${path} has no derivable default`);
        const match = copy.defaultPattern.exec(help);
        assert.ok(match !== null, `field ${path} help (${language}) has no parseable default: ${help}`);
        assert.equal(match?.[1].trim(), expected, `field ${path} declares a default that resolveConfig does not: ${help}`);
      }

      // Beyond the schema table: every text input on these tabs shows an example.
      for (const input of elements(tree).filter(
        (element) => element.type === 'input' && element.props.type === 'text'
      )) {
        assert.ok(
          String(input.props.placeholder ?? '').trim().length > 0,
          `an input on the ${tab} tab has no placeholder`
        );
      }
    }
    // Exact set equality in both directions: every schema leaf is editable on the
    // page, and every editable field the page renders is a declared schema leaf.
    // A new schema field that is not wired into the page fails the left-to-right
    // direction; a page-only knob fails the right-to-left one.
    assert.deepEqual(
      [...renderedPaths].sort(),
      [...uniquePaths].sort(),
      `the panel's editable field set (${language}) differs from the schema leaf set`
    );
    mounted.unmount();
  }

  // Every expected field was rendered in both languages.
  assert.equal(covered, uniquePaths.length * 2, 'the traversal did not visit every field in both languages');
  // The dictionaries are key-aligned.
  assert.deepEqual(keysByLanguage.zh, keysByLanguage.en, 'the Chinese and English dictionaries have different keys');
});

test('the constraint copy matches the Host rules and the judge field is cross-checked', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '自动干预');
  let tree = await mounted.runtime.flush();

  const note = (path: string): string => {
    const wrapper = elements(tree).find((element) => element.props['data-reflex-path'] === path);
    assert.ok(wrapper !== undefined, `no field ${path}`);
    return textOf(helpNoteOf(wrapper as Element).note);
  };

  assert.ok(note('interventions.repeatThreshold').includes('最小 2'), 'repeatThreshold minimum 2 is not stated');
  assert.ok(note('interventions.failureThreshold').includes('最小 2'), 'failureThreshold minimum 2 is not stated');
  assert.ok(note('interventions.windowSize').includes('最小 3'), 'windowSize minimum 3 is not stated');
  assert.ok(note('interventions.minConfidence').includes('0~1'), 'intervention minConfidence range is not stated');
  assert.ok(note('interventions.pruneFloorRatio').includes('0~1'), 'pruneFloorRatio range is not stated');

  const judge = note('interventions.pruneJudgeMinChars');
  assert.ok(judge.includes('10000'), 'the judge threshold default is missing');
  assert.ok(judge.includes('pruneThreshold'), 'the judge threshold does not name its lower bound');
  const judgeWrapper = elements(tree).find(
    (element) => element.props['data-reflex-path'] === 'interventions.pruneJudgeMinChars'
  ) as Element;
  const judgeInput = elements(judgeWrapper).find((element) => element.type === 'input');
  assert.equal(String(judgeInput?.props.placeholder), '10000', 'the judge threshold placeholder is not 10000');

  // The two closing knobs are real controls with their own default and examples.
  const claimNote = note('interventions.claimMinConfidence');
  assert.ok(claimNote.includes('0.5'), 'the claim floor default is missing');
  const claimWrapper = elements(tree).find(
    (element) => element.props['data-reflex-path'] === 'interventions.claimMinConfidence'
  ) as Element;
  assert.equal(
    String(elements(claimWrapper).find((element) => element.type === 'input')?.props.placeholder),
    '0.5',
    'the claim floor placeholder is not 0.5'
  );
  const budgetNote = note('interventions.closingEvidenceChars');
  assert.ok(budgetNote.includes('2400'), 'the evidence budget default is missing');
  assert.ok(budgetNote.includes('截断'), 'the evidence budget does not describe truncation');
  const budgetWrapper = elements(tree).find(
    (element) => element.props['data-reflex-path'] === 'interventions.closingEvidenceChars'
  ) as Element;
  assert.equal(
    String(elements(budgetWrapper).find((element) => element.type === 'input')?.props.placeholder),
    '2400',
    'the evidence budget placeholder is not 2400'
  );

  openTab(tree, '推理强度');
  tree = await mounted.runtime.flush();
  assert.ok(note('effort.minConfidence').includes('0~1'), 'effort minConfidence range is not stated');
  mounted.unmount();
});

test('the (?) disclosure is keyboard-operable and its text is always readable', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  const wrapperOf = (): Element => {
    const wrapper = elements(tree).find((element) => element.props['data-reflex-path'] === 'toolPrefix');
    assert.ok(wrapper !== undefined, 'no toolPrefix field');
    return wrapper as Element;
  };

  const button = helpButtonOf(wrapperOf());
  // The note is in the DOM (and in the accessibility tree) before any pointer event.
  const before = helpNoteOf(wrapperOf());
  assert.notEqual((before.note.props.style as { display?: string }).display, 'block', 'the note is visible before the user asks for it');
  assert.equal(button.props['aria-expanded'], false);

  // A native button is what makes Enter/Space work in the browser; the handler toggles.
  fire(button, 'onClick');
  tree = await mounted.runtime.flush();
  const opened = helpButtonOf(wrapperOf());
  assert.equal(opened.props['aria-expanded'], true, '(?) did not expand');
  assert.equal((helpNoteOf(wrapperOf()).note.props.style as { display?: string }).display, 'block', 'the expanded note is still hidden');

  fire(opened, 'onClick');
  tree = await mounted.runtime.flush();
  assert.equal(helpButtonOf(wrapperOf()).props['aria-expanded'], false, '(?) did not collapse');
  mounted.unmount();
});

//#endregion
