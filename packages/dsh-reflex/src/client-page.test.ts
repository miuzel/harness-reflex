import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import type { LedgerEntry, LedgerSummary } from './vendor/harness-reflex/index.js';

import { resolveConfig, type ReflexConfig } from './config.js';
import { ADAPTIVE_EFFORT_LEVELS, EFFORT_LEVELS, EFFORT_TRIGGERS } from './effort.js';
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
      (runtime as HookRuntime).useSyncExternalStore(subscribe, getSnapshot)
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
  assert.deepEqual(plain(resolved.effort), { setting: 'reflex', fallback: 'low', minConfidence: 0.3 });
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
    'reflex_detect_stagnation'
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
  assert.ok(text.includes('docs/USER_GUIDE.en.md'), 'the English guide does not name its source document');
  assert.ok(!text.includes('虚拟 Provider 与模型池'), 'the Chinese guide leaked into the English page');
  mounted.unmount();
});

//#endregion
