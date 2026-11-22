import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import type { LedgerEntry, LedgerSummary } from './vendor/harness-reflex/index.js';

import { INTERVENTION_CAPABILITIES, INTERVENTION_MODES, INTERVENTION_SETTINGS, Config, resolveConfig, type ReflexConfig } from './config.js';
import { ADAPTIVE_EFFORT_LEVELS } from './effort.js';
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

/** Every input value, placeholder, select value, and text node, for field-level checks. */
function valuesOf(tree: unknown): string {
  return [
    textOf(tree),
    ...elements(tree).flatMap((element) => [String(element.props.value ?? ''), String(element.props.placeholder ?? '')])
  ].join(' ');
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

/** Labels of every `<option>` of the select field labelled `label`. */
function optionLabelsOf(tree: unknown, label: string): string[] {
  return elements(field(tree, label))
    .filter((element) => element.type === 'option')
    .map((element) => textOf(element));
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

/**
 * Let an autosave that is waiting for a pause go through, and render the result.
 *
 * The page debounces typing (`TEXT_DEBOUNCE_MS`), so a text edit is not written
 * by the keystroke alone: the pause has to be reached. A decision carries no
 * timer and is written by the caller's own `flush` — there is nothing to fire
 * here, which is itself the property "a selection saves at once" rests on.
 * @param mounted - the page under test.
 * @param tree - the tree to re-render if the write changed the page.
 * @returns the rendered tree after the pause was reached.
 */
/** The paths one recorded write named, in order. */
function writtenPaths(mutation: { ops: unknown } | undefined): string[] {
  const ops = plain(mutation?.ops) as { op: string; path: string[]; value?: unknown }[];
  return ops.map((op) => op.path.join('.'));
}

async function flushAutosave(mounted: Mounted, tree: unknown): Promise<unknown> {
  let rendered = tree;
  // The page arms two kinds of timer: the metrics poll (4000 ms, the store's
  // `DEFAULT_POLL_MS`) and the typing pause this helper exists for. Only the
  // latter is fired; firing the poll would start a second round of it.
  //
  // Each pause is re-armed by the next keystroke, so the loop continues until no
  // pause is left. A write that lands mid-way re-seeds the page, which can
  // replace the pending draft with a no-op — firing again is then harmless, and
  // *not* doing it is what would leave a keystroke unwritten.
  for (let round = 0; round < 4; round += 1) {
    await settle();
    rendered = await mounted.runtime.flush();
    const due = mounted.clock.pending().filter((timer) => timer.ms !== 4000);
    if (due.length === 0) break;
    for (const timer of due) mounted.fireTimer(timer.id);
  }
  return rendered;
}

/** Click the header control whose label is exactly `label`. */
function clickButton(tree: unknown, label: string): void {
  const control = elements(tree).find((element) => element.type === 'button' && textOf(element).trim() === label);
  assert.ok(control !== undefined, `no button labelled "${label}" among [${elements(tree).filter((e) => e.type === 'button').map((e) => textOf(e)).join(' | ')}]`);
  fire(control as Element, 'onClick');
}

/** Whether the page offers a header control labelled exactly `label`. */
function hasButton(tree: unknown, label: string): boolean {
  return elements(tree).some((element) => element.type === 'button' && textOf(element).trim() === label);
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
    // default: the four recommended tools, with route left for opt-in. The
    // delegation capability is off (it is an opt-in), so `reflex_delegate` is
    // not part of the default surface.
    toolSurface: REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route' && suffix !== 'delegate').map(
      (suffix) => `reflex_${suffix}`
    ),
    // A host that *can* serve the wrapper: the switch is off because nobody
    // consented, not because the Host is broken. A fixture that left this out
    // would make the panel say "state unknown", which is a different screen.
    delegationHealth: { state: 'ready' },
    hostPatch: { path: '/home/user/.dsh/profiles/web/cordis.patch.yml', source: 'DSH_PROFILE_DIR', enabled: false },
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
    // g-058: presence alone is no longer the whole fact — the panel reports
    // *where* the key came from. A fixture with a key therefore has to say so,
    // exactly as the mount layer does.
    ...(apiKeyPresent ? { apiKeySource: 'env' as const, apiKeyVariable: 'JEV_API_KEY' } : {}),
    now: 1_709_530_001_000
  };
}

/** What one test observed of the panel's network traffic and live timers. */
interface Observed {
  calls: { url: string; method: string }[];
  clears: number[];
  timers: { id: number; ms: number }[];
  /** Profiles the page asked the Host to probe, in order. */
  probes: (string | null)[];
  /** The settings forms the page reached; how a test makes its write slow. */
  forms: { mutate: (ops: unknown, revision?: number) => Promise<boolean> }[];
}

/** A deterministic clock whose live timers are inspectable. */
interface Clock {
  globals: { setTimeout: (callback: () => void, ms: number) => number; clearTimeout: (handle: number) => void };
  /** Fire one live timer, as the event loop would. */
  fire(id: number): void;
  /** Every timer still waiting, in the order they were armed. */
  pending(): { id: number; ms: number }[];
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
    },
    pending: () => [...live.keys()].map((id) => ({ id, ms: observed.timers.find((timer) => timer.id === id)?.ms ?? -1 }))
  };
}

/** Serve `/api/dsh-reflex/*` from a real source, over a loopback socket shape. */
function makeTransport(panelFacts: PanelRuntimeFacts, observed: Observed): (input: string, init?: { method?: string; body?: string }) => Promise<unknown> {
  const source: PanelSource = {
    snapshot: (limit) => buildPanelSnapshot(panelFacts, limit),
    clearLedger: () => {
      observed.clears.push(1);
      return 2;
    },
    allows: (request) => isPanelRequestAllowed(request, {}),
    // A deterministic probe: the page's own behaviour is what these tests cover,
    // not the network. The classification varies by profile so a test can tell
    // two rows' results apart.
    testSystemOne: async (profile) => {
      observed.probes.push(profile ?? '');
      return {
        ok: profile !== 'secondary',
        status: profile === 'secondary' ? 'auth-failed' : 'ok',
        latencyMs: profile === 'secondary' ? 42 : 7,
        profile: profile ?? null,
        detail: profile === 'secondary' ? 'the gateway rejected the API key' : undefined
      } as never;
    }
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
    // The route handler resolves asynchronously (it may read a request body and
    // probe a connection), so the stub has to wait for it to settle before it can
    // report a status — reading `status` on the same tick would always yield 0.
    const request = {
      method,
      url: input,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      once: () => request,
      async *[Symbol.asyncIterator]() {
        if (init?.body !== undefined) yield Buffer.from(String(init.body), 'utf8');
      }
    };
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    route.handler(request as never, {
      writeHead: (code: number) => {
        status = code;
      },
      end: (chunk?: string) => {
        body = chunk ?? '';
        settle();
      }
    } as never);
    // Drain the handler's promise chain, then wait for its answer (if any).
    for (let turn = 0; turn < 8 && status === 0; turn += 1) await Promise.resolve();
    await Promise.race([done, Promise.resolve()]);
    return { ok: status >= 200 && status < 300, status, json: async (): Promise<unknown> => JSON.parse(body) as unknown };
  };
}

/** The settings form the page edits. */
/** One fake settings form: the record the page writes through, and how a test
 * observes, applies or holds those writes. */
interface FakeForm {
  /** The form object the client is handed (`configForms.get()`). */
  form: Record<string, unknown>;
  mutations: { ops: unknown; revision: unknown }[];
  /** Replace the document and notify, the way the Host does after a write. */
  push(next: unknown): void;
  /** Apply one write's operations to the served document, as the Host does. */
  apply(ops: unknown): void;
  /** Hold every later write open until the returned handle is used. */
  hold(resolveWith?: boolean): { release: (accept?: boolean) => void; reject: (error: unknown) => void };
}

function settingsForm(
  value: unknown,
  options: { writable?: boolean; revision?: number; base?: unknown; user?: unknown } = {}
): FakeForm {
  const mutations: { ops: unknown; revision: unknown }[] = [];
  let snapshot = {
    status: 'ready',
    value,
    base: options.base ?? 0,
    user: options.user ?? 0,
    revision: options.revision ?? 3,
    writable: options.writable ?? true
  };
  const listeners = new Set<() => void>();
  // A write awaiting the Host: it holds the promise the page is waiting on, and
  // does not bump the revision or notify until it is released.
  let held: { resolve: (accept: boolean) => void; reject: (error: unknown) => void } | null = null;
  let holding = false;
  const settleRevision = (): void => {
    snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1 };
    for (const listener of [...listeners]) listener();
  };
  const applyOps = (ops: unknown): void => {
    let next = plain(snapshot.value) as Record<string, any>;
    const apply = (root: Record<string, any>, op: { op: string; path: string[]; value?: unknown }): void => {
      const parent = op.path.slice(0, -1).reduce<Record<string, any>>((node, key) => (node[key] ??= {}), root);
      const key = op.path[op.path.length - 1] as string;
      if (op.op === 'set') parent[key] = plain(op.value);
      else delete parent[key];
    };
    for (const op of plain(ops) as { op: string; path: string[]; value?: unknown }[]) apply(next, op);
    snapshot = { ...snapshot, value: next };
  };
  return {
    mutations,
    apply: (ops: unknown) => applyOps(ops),
    push: (next: unknown) => {
      snapshot = { ...snapshot, value: next, revision: (snapshot.revision ?? 0) + 1 };
      for (const listener of [...listeners]) listener();
    },
    hold: () => {
      holding = true;
      return {
        release: (accept = true) => {
          holding = false;
          const pending = held;
          held = null;
          if (accept) {
            // The write that was held applies its own ops when it is accepted.
            applyOps(mutations[mutations.length - 1]?.ops);
            settleRevision();
          }
          pending?.resolve(accept);
        },
        reject: (error: unknown) => {
          holding = false;
          const pending = held;
          held = null;
          pending?.reject(error);
        }
      };
    },
    form: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      mutate: async (ops: unknown, revision?: number) => {
        mutations.push({ ops, revision });
        if (!holding) {
          applyOps(ops);
          settleRevision();
          return true;
        }
        return new Promise<boolean>((resolve, reject) => {
          held = { resolve, reject };
        });
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
 *
 * Mounts that share one client (closing and reopening the settings dialog) must
 * also share one *module instance*: the browser loads `client.js` once per page,
 * and module-level state — the autosave owner registry among it — lives in that
 * one instance. Each `mountPanel` therefore gets its own context by default, but
 * `mountPanel({ client: previous })` evaluates into the previous mount's context,
 * which is what a second mount (not a second page load) is.
 * @param globals - browser globals the bundle may reach.
 * @param context - an existing sandbox to evaluate into, for a second mount.
 * @returns the captured module-loader entry.
 */
function loadBundle(globals: Record<string, unknown> = {}): LoadedBundle {
  return loadBundleIn(newClient(globals));
}

/** One client's sandbox, carrying the module loader and the browser globals. */
function newClient(globals: Record<string, unknown> = {}): vm.Context {
  const sandbox = { window: { __ModuleLoader__: { load: (): void => undefined } }, ...globals } as Record<string, unknown>;
  vm.createContext(sandbox);
  return sandbox as vm.Context;
}

/**
 * Evaluate the committed bundle inside one client's sandbox — once per client.
 *
 * The module-loader registration is remembered on the sandbox, so a *reopen* of
 * the page (a second mount in the same client) reuses the instance the browser
 * would already have, instead of evaluating a second copy with its own
 * module-level state. Re-running the script would still be a new instance.
 */
function loadBundleIn(client: vm.Context): LoadedBundle {
  const sandbox = client as unknown as { __bundle?: LoadedBundle };
  if (sandbox.__bundle !== undefined) return sandbox.__bundle;
  (sandbox as unknown as { window: { __ModuleLoader__: { load: (entry: LoadedBundle) => void } } }).window.__ModuleLoader__.load = (entry) => {
    sandbox.__bundle = entry;
  };
  vm.runInContext(readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'), client, { filename: 'client.js' });
  assert.ok(sandbox.__bundle !== undefined, 'the bundle did not register with the module loader');
  return sandbox.__bundle;
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
  /** The page's deterministic clock, so a test can wait out autosave's pause. */
  clock: Clock;
  /** Live text of the newest render, for a page that keeps changing after mount. */
  current(): string;
  /** The client instance this mount ran in, to reopen the page in the same one. */
  client: vm.Context;
  unmount(): void;
}

/** Run the committed artifact with only the globals a browser would provide. */
async function mountPanel(options: {
  facts: PanelRuntimeFacts;
  served?: readonly string[];
  form: Record<string, unknown>;
  language?: 'zh' | 'en';
  /** Reopen in an existing client's module instance (a dialog reopened). */
  client?: vm.Context;
}): Promise<Mounted> {
  const language = options.language ?? 'zh';
  const observed: Observed = { calls: [], clears: [], timers: [], probes: [], forms: [] };
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
  const globals = { fetch: fetchImpl, ...clock.globals, console };
  // A second mount of the same client re-evaluates into the first one's module
  // instance; a fresh mount gets its own (a separate page load).
  const client = options.client ?? newClient(globals);
  const bundle = loadBundleIn(client);

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
      get: () => (observed.forms.push(options.form as Observed['forms'][number]), options.form),
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
    clock,
    current: () => textOf(runtime?.tree),
    client,
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

  // A switch is a decision, not typing: it writes without a pause (g-069).
  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'a switch did not save at once');
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

  // The two fields were typed, not clicked: nothing is written until the pause
  // (g-069), even though the candidate row itself was added by a click.
  tree = await flushAutosave(mounted, tree);
  assert.equal(mutations.length, 1, 'the paused typing never reached the Host');

  // Promote the new candidate, which is the preference. A click is a decision, so
  // it writes at once — carrying the promotion, not the corrected fields again.
  const up = elements(tree).filter((element) => element.type === 'button' && textOf(element) === '↑' && element.props.disabled !== true);
  assert.equal(up.length, 1, 'exactly the second candidate can be promoted');
  fire(up[0], 'onClick');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 2, 'the promotion did not write at once');
  /** Declared with its own type: indexing a tuple narrowed by `length` needs one. */
  const saves: { ops: unknown; revision: unknown }[] = mutations;
  const ops = plain(saves[saves.length - 1]?.ops) as { value: { models: Record<string, { provider: string; model: string }[]> } }[];
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
  // There is no Save button to press any more (g-069), so the rule is proven the
  // hard way: type, then wait out the pause, and let the page try to save.
  type(elements(tree).find((element) => element.type === 'input' && element.props.value === 'reflex'), '');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  assert.ok(textOf(tree).includes('虚拟 Provider 名称不能为空'), `the refusal is not explained: ${textOf(tree).slice(0, 200)}`);
  assert.deepEqual(mutations, [], 'an invalid draft reached the Host');

  // A second invalid field replaces the first problem, not accumulates silently.
  type(inputElement(tree, '任务文本预算'), '0');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  const text = textOf(tree);
  assert.ok(text.includes('虚拟 Provider 名称不能为空'), 'the first problem disappeared');
  assert.ok(text.includes('任务文本预算必须是正整数'), 'the new problem is not reported');
  assert.deepEqual(mutations, [], 'an invalid draft reached the Host');

  // Fixing one problem is not enough: the budget is still 0, so the next pause is
  // still refused. Validation is a gate on the *whole* draft, not a dead end
  // (g-069).
  type(elements(tree).find((element) => element.type === 'input' && element.props.value === ''), 'reflex');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  assert.deepEqual(mutations, [], 'a draft with one remaining problem reached the Host');
  assert.ok(textOf(tree).includes('任务文本预算必须是正整数'), 'the remaining problem disappeared');

  // Restoring the budget restores a draft the Host already holds, which is not a
  // change at all: a no-op must stay a no-op (g-069).
  type(inputElement(tree, '任务文本预算'), '400');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  assert.equal(mutations.length, 0, 'typing a value back to the Host\'s own wrote it');
  assert.ok(!textOf(tree).includes('虚拟 Provider 名称不能为空'), 'the repaired draft still shows its old problem');

  // And a genuinely new value does write.
  type(inputElement(tree, '任务文本预算'), '900');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  assert.equal(mutations.length, 1, 'a valid changed draft was never written');
  mounted.unmount();
});

test('the effort page offers exactly the two configured-effort choices', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '推理强度');
  const tree = await mounted.runtime.flush();

  const options = optionsOf(tree, '推理强度策略');
  // Leave untouched plus the one adaptive entry, named rather than raw: a
  // concrete level is a model-selector choice, never a deployment setting.
  assert.deepEqual(options, ['', 'reflex']);
  assert.ok(!options.includes('auto'), 'the auto alias is still offered as its own option');
  const labels = optionLabelsOf(tree, '推理强度策略');
  assert.ok(labels[1]?.includes('Reflex'), `the adaptive option is not named: ${labels[1] ?? '(missing)'}`);
  assert.ok(labels[1]?.includes('自适应'), `the adaptive option is not explained: ${labels[1] ?? '(missing)'}`);
  assert.deepEqual(optionsOf(tree, '兜底档位'), [...ADAPTIVE_EFFORT_LEVELS]);
  assert.equal(inputOf(tree, '最小置信度'), '0.3');
  assert.ok(textOf(tree).includes('0.82'), 'the last decision confidence is not shown');
  mounted.unmount();
});

test('a legacy auto setting folds onto the adaptive option and is saved as reflex', async () => {
  const authoredAuto: ReflexConfig = { ...AUTHORED, effort: { ...AUTHORED.effort, reasoningEffort: 'auto' } };
  // The Host still accepts the alias in configuration...
  assert.equal(resolveConfig(authoredAuto).effort.setting, 'auto');

  const { form, mutations } = settingsForm(authoredAuto);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '推理强度');
  let tree = await mounted.runtime.flush();

  // ...and the page shows it as the one adaptive entry, never as raw "auto".
  assert.deepEqual(optionsOf(tree, '推理强度策略'), ['', 'reflex']);
  assert.equal(String(selectOf(tree, '推理强度策略').props.value), 'reflex');

  // Editing the group writes the canonical sentinel back.
  fire(selectOf(tree, '兜底档位'), 'onChange', { target: { value: 'medium' } });
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'saving the edited group did not reach the form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(ops.map((op) => [op.op, op.path]), [['set', ['effort']]]);
  const value = ops[0]?.value ?? {};
  assert.equal(value.reasoningEffort, 'reflex', 'the legacy alias was not normalized on write');
  assert.equal(resolveConfig(plain({ ...authoredAuto, effort: value }) as ReflexConfig).effort.setting, 'reflex');
  mounted.unmount();
});

test('the effort copy explains non-intervention and the injected adaptive level in both languages', async () => {
  for (const language of ['zh', 'en'] as const) {
    const { form } = settingsForm(AUTHORED);
    const mounted = await mountPanel({ facts: facts(true), form, language });
    try {
      openTab(mounted.tree, language === 'zh' ? '推理强度' : 'Reasoning effort');
      const tree = await mounted.runtime.flush();
      const wrapper = elements(tree).find((element) => element.props['data-reflex-path'] === 'effort.setting') as
        | Element
        | undefined;
      assert.ok(wrapper !== undefined, 'the effort setting field is not rendered');
      const note = textOf(helpNoteOf(wrapper).note);
      const labels = optionLabelsOf(tree, language === 'zh' ? '推理强度策略' : 'Effort policy');
      assert.equal(labels[0], language === 'zh' ? '不干预' : 'Leave untouched');
      assert.ok(labels[1]?.includes(language === 'zh' ? '自适应' : 'adaptive'), `the adaptive option lacks its meaning: ${labels[1] ?? ''}`);

      const required =
        language === 'zh'
          ? ['不改写 reasoningEffort', '行为与未安装该功能一致', 'System 1', '模型选择器', '具体档位']
          : ['never rewrites reasoningEffort', 'as if this feature were not installed', 'System 1', 'model selector', 'concrete level'];
      for (const phrase of required) assert.ok(note.includes(phrase), `${language} help lacks "${phrase}": ${note}`);
      // The on-page hint is a one-line locator; the long explanation lives in (?).
      const hint = String(mounted.dictionaries['dsh-reflex.panel']?.effortHint ?? '');
      assert.ok(
        hint.includes(language === 'zh' ? '不干预' : 'leave untouched') &&
          hint.includes(language === 'zh' ? '每轮' : 'every turn'),
        `${language} hint no longer locates both policies: ${hint}`
      );
    } finally {
      mounted.unmount();
    }
  }
});

test('settings copy and both guides carry no migration wording and the effort hint stays a locator', async () => {
  const banned =
    /旧|不再|等价|别名|迁移|legacy|previously|no longer|deprecated|backwards.compat|(?:^|[^a-z])alias(?:[^a-z]|$)|migration|any more|old (?:value|config|configuration|session|revision)|previous (?:revision|load)/i;

  for (const language of ['zh', 'en'] as const) {
    const { form } = settingsForm(AUTHORED);
    const mounted = await mountPanel({ facts: facts(true), form, language });
    try {
      const copy = mounted.dictionaries['dsh-reflex.panel'] ?? {};
      for (const [key, value] of Object.entries(copy)) {
        const hit = banned.exec(value);
        assert.equal(hit, null, `${language} copy "${key}" carries migration wording "${hit?.[0]}": ${value}`);
      }

      const hint = String(copy.effortHint ?? '');
      const help = String(copy.helpEffortSetting ?? '');
      assert.notEqual(hint, help, `${language} effort hint duplicates the (?) explanation`);
      assert.equal(help.includes(hint), false, `${language} (?) explanation repeats the short hint verbatim`);
      assert.ok(hint.length < 90, `${language} effort hint is not a one-line locator: ${hint}`);
      assert.ok(hint.length * 2 < help.length, `${language} effort hint is nearly as long as the (?) explanation`);

      // Criteria that must survive the cleanup, shared across hint + (?).
      const surface = `${hint} ${help}`;
      const points =
        language === 'zh'
          ? ['不干预', '每轮', 'System 1', '模型选择器', 'minimal', 'max']
          : ['leave untouched', 'every turn', 'System 1', 'model selector', 'minimal', 'max'];
      for (const point of points) {
        assert.ok(surface.includes(point), `${language} effort copy lost the "${point}" requirement`);
      }
    } finally {
      mounted.unmount();
    }
  }

  for (const document of ['USER_GUIDE.md', 'docs/USER_GUIDE.en.md']) {
    const text = readFileSync(fileURLToPath(new URL(`../../../${document}`, import.meta.url)), 'utf8');
    const hit = banned.exec(text);
    assert.equal(hit, null, `${document} carries migration wording "${hit?.[0]}"`);
  }
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

  // Each select is a decision: it saves at once, with no Save press (g-069).
  fire(selectOf(tree, '主模式'), 'onChange', { target: { value: 'active' } });
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 1, 'choosing the master mode did not save at once');
  fire(selectOf(tree, '结果裁剪'), 'onChange', { target: { value: 'off' } });
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 2, `choosing a capability did not save at once: ${JSON.stringify(plain(mutations.map((m) => m.ops))).slice(0, 500)}`);
  const ops = plain(mutations[mutations.length - 1]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
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
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
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
    REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route' && suffix !== 'delegate').map(
      (suffix) => `reflex_${suffix}`
    ),
    'the effective card must list exactly the four tools a default (unconsented) deployment registers'
  );

  fire(checkboxOf(tree, 'reflex_gate'), 'onChange', { target: { checked: false } });
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
    gate: ['逐条核对', '验收判据'],
    delegate: ['交给子代理', '思考档位']
  };
  const copy = textOf(tree);
  for (const suffix of REFLEX_TOOL_SUFFIXES) {
    const [what, when] = explains[suffix] ?? ['', ''];
    assert.ok(copy.includes(what), `${suffix} does not say what it does`);
    assert.ok(copy.includes(when), `${suffix} does not say when to call it`);
  }

  // The advice is stated per tool: five suggested, one to turn on when needed.
  // Counts, so a misplaced label is caught too.
  const occurrences = (needle: string): number => copy.split(needle).length - 1;
  assert.equal(occurrences('建议暴露'), 5, 'the tools the agent should keep are not marked as such');
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
    gate: true,
    delegate: true
  };
  fire(find(tree, 'button', '应用推荐组合'), 'onClick');
  tree = await mounted.runtime.flush();
  for (const [suffix, on] of Object.entries(recommended)) {
    assert.equal(checkboxOf(tree, `reflex_${suffix}`).props.checked, on, `applying the recommendation left ${suffix} at ${String(!on)}`);
  }
  assert.equal(mutations.length, 0, 'pre-filling the recommendation wrote to the settings document');

  // Saving it writes nothing: the recommended set *is* the documented default,
  // so there is no departure to author and the Host is left untouched.
  assert.equal(mutations.length, 0, 'a set that already matches the default must not be written');

  // A real departure is written — and written alone.
  fire(checkboxOf(tree, 'reflex_route'), 'onChange', { target: { checked: true } });
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
  assert.ok(textOf(tree).includes('不做自适应判定'), 'the consequence of switching off is not explained');

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
    const { form } = settingsForm(PROFILED);
    const mounted = await mountPanel({ facts: profiledFacts(), form });
    openTab(mounted.tree, 'System 1 后端');
    const tree = await mounted.runtime.flush();
    const text = textOf(tree);

    // The connection fields are the *profile rows'* now (g-066): the flat block
    // that also edited them is gone, so each fact lives where its row is.
    assert.equal(inputOf(tree, 'Base URL'), 'http://flat.example', 'the row shows the address it would use');
    assert.equal(inputOf(tree, 'API Key 环境变量名'), 'REFLEX_TEST_KEY');
    assert.ok(!text.includes(SECRET), 'the page rendered an API key value');
    assert.ok(!valuesOf(tree).includes(SECRET), 'the page rendered an API key value as an input value or placeholder');
    mounted.unmount();
  } finally {
    delete process.env.REFLEX_TEST_KEY;
  }
});

test('a locked lookup and an unconfigured connection read as different facts', async () => {
  // g-059: naming a variable *locks* the lookup, so "the variable you named is
  // empty" is the truthful sentence — and g-066 adds the second sentence the page
  // never had: what an *unconfigured* connection means (nothing connects at all).
  const { form } = settingsForm(PROFILED);
  const locked = await mountPanel({ facts: { ...profiledFacts(), apiKeyLocked: true, apiKeyVariable: 'REFLEX_TEST_KEY' }, form });
  try {
    openTab(locked.tree, 'System 1 后端');
    const text = textOf(await locked.runtime.flush());
    assert.ok(text.includes('已点名 REFLEX_TEST_KEY'), `the locked copy does not name the locked variable: ${text}`);
    assert.ok(text.includes('不会回退'), 'the locked copy does not say the lookup will not fall back');
    assert.equal(unconfiguredBanner(await locked.runtime.flush()), undefined, 'a locked lookup is not an unconfigured document');
  } finally {
    locked.unmount();
  }

  const unconfigured = await mountPanel({ facts: facts(false), form });
  try {
    openTab(unconfigured.tree, 'System 1 后端');
    const tree = await unconfigured.runtime.flush();
    const banner = unconfiguredBanner(tree);
    assert.ok(banner !== undefined, 'an unconfigured document shows no "not configured" banner');
    const copy = textOf(banner);
    assert.ok(copy.includes('未配置连接'), `the banner does not state the absence: ${copy}`);
    assert.ok(copy.includes('不发出任何外部请求'), 'the banner does not say what happens instead');
    assert.ok(!textOf(tree).includes('已点名'), 'an unconfigured document must not claim a variable was named');
  } finally {
    unconfigured.unmount();
  }
});

//#region the flat compatibility block is gone (g-066)

/**
 * The "nothing connects" banner, when the page renders one.
 *
 * Found by its own data attribute rather than by its copy, so an assertion about
 * *which* document state produced it cannot accidentally match ordinary text.
 * @param tree - the rendered page.
 * @returns the banner element, or `undefined`.
 */
function unconfiguredBanner(tree: unknown): Element | undefined {
  return elements(tree).find((element) => typeof element.props['data-unconfigured'] === 'string');
}

test('the flat connection editor is gone, and its fields are not rendered anywhere', async () => {
  // The reported bug was two editors of the same connection, one of them a silent
  // fallback the runtime no longer read. Both halves are asserted: no fold, and no
  // field bound to a `systemOne.*` flat path.
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  const tree = await mounted.runtime.flush();

  const folds = elements(tree).filter((element) => typeof element.props['data-reflex-folded'] === 'string');
  assert.deepEqual(folds, [], 'the compatibility fold is still rendered');
  assert.ok(!textOf(tree).includes('兼容区'), 'the compatibility copy is still rendered');
  assert.ok(!textOf(tree).includes('新配置请用上方连接配置'), 'the compatibility pointer is still rendered');
  assert.ok(!textOf(tree).includes('已折叠'), 'the collapsed-state copy is still rendered');

  // No control addresses a flat connection path. The row editors address
  // `systemOne.profiles.*`, which is a different (and the only) surface.
  for (const element of elements(tree)) {
    const field = element.props['data-reflex-path'];
    if (typeof field !== 'string') continue;
    assert.ok(
      !/^systemOne\.(baseUrl|model|apiKeyEnv|timeoutMs)$/.test(field),
      `the page still renders a flat connection field: ${field}`
    );
  }
  // The profiles card, the runtime implementation choice and the runtime fields
  // are what the page is made of now.
  assert.ok(textOf(tree).includes('连接配置（可多套）'), 'the profiles card is missing');
  assert.ok(find(tree, 'button', '新增配置') !== undefined, 'the profiles card is not editable on screen');
  mounted.unmount();
});

test('an unconfigured document says so, and names which absence it is', async () => {
  const cases: { authored: ReflexConfig; marker: string; needle: string }[] = [
    // g-067: an authored section that states nothing is no longer the "not
    // configured" case — the *absent* section is the fresh document, which ships
    // with the factory connection. "Not configured" is written explicitly, which
    // is exactly what the page stores when the last row is removed.
    { authored: { backend: 'jev', systemOne: { profiles: {}, active: '' } } as ReflexConfig, marker: 'no-profiles', needle: '还没有任何连接配置' },
    {
      authored: { backend: 'jev', systemOne: { profiles: { p: { baseUrl: 'http://a' } } } } as ReflexConfig,
      marker: 'no-active-profile',
      needle: '没有选定当前激活'
    },
    {
      authored: { backend: 'jev', systemOne: { active: 'typo', profiles: { p: { baseUrl: 'http://a' } } } } as ReflexConfig,
      marker: 'active-profile-missing',
      needle: '不对应任何已保存的连接配置'
    },
    {
      // The pre-g-066 shape: a document that plainly holds an address and still
      // connects nothing. This is the case the diagnosis exists for.
      authored: { backend: 'jev', systemOne: { baseUrl: 'http://old', model: 'm' } } as unknown as ReflexConfig,
      marker: 'legacy-config-required',
      needle: '不构成一套连接配置'
    }
  ];
  for (const { authored, marker, needle } of cases) {
    // Both halves are the *same* document: the form is what the page edits, and
    // the snapshot is where "unconfigured" is read from (the projection of this
    // very config), so passing the default `facts(true)` here would describe
    // AUTHORED instead and the case would prove nothing.
    const { form } = settingsForm(authored);
    const mounted = await mountPanel({ facts: { ...facts(true), config: resolveConfig(authored) }, form });
    try {
      openTab(mounted.tree, 'System 1 后端');
      const tree = await mounted.runtime.flush();
      const banner = unconfiguredBanner(tree);
      assert.ok(banner !== undefined, `${marker}: no unconfigured banner`);
      assert.equal(banner.props['data-unconfigured'], marker, `${marker}: wrong reason reported`);
      assert.ok(textOf(banner).includes(needle), `${marker}: the copy does not explain it (${textOf(banner)})`);
      assert.ok(textOf(banner).includes('不发出任何外部请求'), `${marker}: the consequence is not stated`);
    } finally {
      mounted.unmount();
    }
  }
});

test('a save from the page never writes the flat connection fields', async () => {
  // The write half of the same rule: even with a legacy document loaded, saving
  // the page addresses neither `systemOne.baseUrl` nor its siblings, so the old
  // keys neither leak into resolution nor get silently rewritten.
  const legacy = { backend: 'jev', systemOne: { baseUrl: 'http://old', model: 'm', apiKeyEnv: 'K' } } as unknown as ReflexConfig;
  const { form, mutations } = settingsForm(legacy);
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    openTab(mounted.tree, 'System 1 后端');
    let tree = await mounted.runtime.flush();
    type(inputElement(tree, '工具名前缀'), 'rv_');
    tree = await mounted.runtime.flush();
    tree = await flushAutosave(mounted, tree);
    assert.ok(mutations.length > 0, 'saving wrote nothing');
    for (const mutation of mutations) {
      for (const op of plain(mutation.ops) as { op?: string; path: string[] }[]) {
        assert.ok(
          !(op.path.length === 2 && op.path[0] === 'systemOne' && ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs'].includes(op.path[1]!)),
          `the save addressed a flat connection field: ${op.path.join('.')}`
        );
      }
    }
  } finally {
    mounted.unmount();
  }
});

//#endregion

//#region connection profiles (g-057)

/** The secret one profile carries; it must never be rendered by the page. */
const PROFILE_SECRET = 'sk-ui-profile-never-rendered-4d21';

/** A configuration with two profiles, one active and one carrying a stored key. */
const PROFILED = {
  ...AUTHORED,
  systemOne: {
    active: 'primary',
    profiles: {
      // Every field a row is expected to show lives on the row it belongs to
      // (g-066): there is no flat block beneath a profile to inherit from, so a
      // fixture that kept one would make these assertions pass for the old reason.
      primary: { baseUrl: 'http://flat.example', model: 'primary-model', apiKeyEnv: 'REFLEX_TEST_KEY', timeoutMs: 4000 },
      secondary: { baseUrl: 'http://secondary.example', model: 'secondary-model' }
    }
  }
} as unknown as ReflexConfig;

/** Facts whose snapshot reports profile key presence (never a value). */
function profiledFacts(): PanelRuntimeFacts {
  const base = facts(false);
  return {
    ...base,
    config: resolveConfig(PROFILED),
    profileKeys: {
      primary: { present: true, fromProfile: true },
      secondary: { present: false, fromProfile: false }
    }
  };
}

test('the connection page lists every profile with its non-secret fields and the active marker', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  const tree = await mounted.runtime.flush();
  const text = textOf(tree);

  // Both rows are listed, each by the name its field carries (the name is an
  // editable input on every row since g-066, so it is a value, not text), with
  // their effective connection fields.
  assert.ok(namedRow(tree, 'primary') !== undefined, 'the active profile row is missing');
  assert.ok(namedRow(tree, 'secondary') !== undefined, 'the inactive profile row is missing');
  assert.ok(text.includes('已激活'), 'the active marker is missing');
  assert.ok(text.includes('设为激活'), 'the activation switch is missing');
  // Presence is reported as a fact, and the key is never rendered.
  assert.ok(text.includes('已保存'), 'a stored key is not reported as present');
  assert.ok(text.includes('未设置'), 'an absent key is not reported as absent');
  assert.ok(!valuesOf(tree).includes(PROFILE_SECRET), 'the page rendered a key value');

  // Each row has a write-only key input: always empty, always a placeholder.
  const keyInputs = elements(tree).filter((element) => typeof element.props['data-profile-key'] === 'string');
  assert.equal(keyInputs.length, 2, 'one key input per profile');
  for (const input of keyInputs) {
    assert.equal(input.props.value, '', 'a key input must never be seeded with a value');
    assert.equal(input.props.type, 'password');
    assert.ok(String(input.props.placeholder).length > 0, 'a key input needs a placeholder');
  }
  // Each row has a test button and a remove button.
  const buttons = elements(tree).filter((element) => element.type === 'button');
  assert.ok(buttons.some((button) => textOf(button) === '测试'), 'no test button');
  assert.ok(buttons.filter((button) => textOf(button) === '删除').length >= 2, 'a remove action per row');
  mounted.unmount();
});

test('testing a profile asks the Host to probe it and shows the status and latency', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  const testButton = elements(tree).find((element) => element.type === 'button' && textOf(element) === '测试');
  assert.ok(testButton !== undefined, 'no test button to press');
  (testButton.props.onClick as () => void)();
  tree = await mounted.runtime.flush();

  // The request went to the probe route as a POST naming the profile.
  const probe = mounted.observed.calls.find((call) => call.url.includes('/systemone/test'));
  assert.ok(probe !== undefined, 'the page did not call the probe route');
  assert.equal(probe.method, 'POST');

  // The pressed row is the row probed, and it shows its own classification.
  assert.deepEqual(mounted.observed.probes, ['primary'], 'the page probed a different row than the one pressed');
  const text = textOf(tree);
  assert.ok(text.includes('连接正常'), `the status is not shown: ${text.slice(0, 400)}`);
  assert.ok(text.includes('7 ms'), `the measured latency is not shown: ${text.slice(0, 400)}`);
  // And the key value still never appears.
  assert.ok(!valuesOf(tree).includes(PROFILE_SECRET));
  mounted.unmount();
});

test('a rejected key is shown as its own class, not as a generic failure', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  // Press the *second* row's test button: it is the one the fixture fails.
  const testButtons = elements(tree).filter((element) => element.type === 'button' && textOf(element) === '测试');
  assert.equal(testButtons.length, 2, 'one test button per profile');
  (testButtons[1]!.props.onClick as () => void)();
  tree = await mounted.runtime.flush();

  assert.deepEqual(mounted.observed.probes, ['secondary'], 'the pressed row is the row probed');
  const text = textOf(tree);
  assert.ok(text.includes('密钥被拒绝'), `the auth failure is not classified: ${text.slice(0, 400)}`);
  assert.ok(text.includes('42 ms'), 'the measured latency is not shown for the failing row');
  // The other row keeps its own state: results do not cross.
  assert.ok(!text.includes('连接正常'), 'a failed probe must not render as a healthy one');
  mounted.unmount();
});

test('an active name that matches no profile is shown as a warning', async () => {
  const broken = {
    ...AUTHORED,
    systemOne: { ...PROFILED.systemOne, active: 'prod' }
  } as unknown as ReflexConfig;
  const { form } = settingsForm(broken);
  const mounted = await mountPanel({ facts: { ...facts(false), config: resolveConfig(broken) }, form });
  openTab(mounted.tree, 'System 1 后端');
  const text = textOf(await mounted.runtime.flush());
  assert.ok(text.includes('prod'), 'the mistyped name must be named');
  assert.ok(text.includes('不存在'), 'a missing active profile must be called out');
  mounted.unmount();
});

//#endregion

//#region row identity (g-062)

/** The profile rows of the connection page, in document order. */
function profileRows(tree: unknown): Element[] {
  return elements(tree).filter((element) => typeof element.props['data-profile'] === 'string');
}

/** One button of one profile row, found by its label. */
/**
 * The row whose **name field** holds `name`.
 *
 * The name is an `<input>` value on every row now (g-066), so it is not part of
 * the row's rendered text: looking a row up by `textOf(row).includes(name)`
 * silently stops finding anything, which is exactly what these tests did.
 * @param tree - the rendered page.
 * @param name - the profile name to look for.
 * @returns the row, or `undefined`.
 */
function namedRow(tree: unknown, name: string): Element | undefined {
  return profileRows(tree).find((row) =>
    elements(row).some((element) => element.props['data-profile-name'] !== undefined && String(element.props.value) === name)
  );
}

function rowButton(row: Element, label: string): Element | undefined {
  return elements(row).find((element) => element.type === 'button' && textOf(element) === label);
}

/** The status note one profile row prints for a blocked action. */
function rowBlockedNote(row: Element, action: 'activate' | 'test'): string | undefined {
  const note = elements(row).find((element) => element.props['data-profile-blocked'] === action);
  return note === undefined ? undefined : textOf(note).trim();
}

/** The page with two unnamed candidate rows and one saved row. */
function rowsFacts(): PanelRuntimeFacts {
  return profiledFacts();
}

test('a new, unnamed row disables both actions and says why', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: rowsFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  // Two clicks on "add" produce two rows with their own identity — the very
  // state in which the remove action used to take both away.
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();

  const rows = profileRows(tree);
  assert.equal(rows.length, 4, `expected the two saved rows plus two new ones, saw ${rows.length}`);
  assert.equal(
    new Set(rows.map((row) => String(row.props['data-profile']))).size,
    rows.length,
    'two rows share a data-profile key'
  );
  const keys = elements(tree).filter((element) => typeof element.props['data-profile-key'] === 'string');
  assert.equal(new Set(keys.map((key) => String(key.props['data-profile-key']))).size, keys.length, 'two key inputs share a key');

  // The unnamed rows: activation and testing are greyed *out loud*.
  // Identified by the row's own marker, not by "the text does not mention a
  // sibling": every row carries a name *input* now (g-066), and `valuesOf`-style
  // matching on absence is what this replaces.
  const unnamed = rows.filter((row) => String(row.props['data-profile-unnamed']) === 'true');
  assert.equal(unnamed.length, 2, 'the two new rows are not identifiable');
  for (const row of unnamed) {
    const activate = rowButton(row, '设为激活');
    const test = rowButton(row, '测试');
    assert.ok(activate !== undefined && test !== undefined, 'a row is missing its actions');
    assert.equal(activate.props.disabled, true, 'an unnamed row must not be activatable');
    assert.equal(test.props.disabled, true, 'an unnamed row must not be testable');
    // Disabled *with a reason*, in the tooltip and in the row's own text.
    assert.equal(String(activate.props.title), '先填写配置名');
    assert.equal(String(test.props.title), '先填写配置名');
    assert.equal(rowBlockedNote(row, 'activate'), '先填写配置名');
    assert.equal(rowBlockedNote(row, 'test'), '先填写配置名');
    // Remove stays available: it only ever removes this row.
    const remove = elements(row).find((element) => element.type === 'button' && textOf(element) === '删除');
    assert.equal(remove?.props.disabled, false, 'an unnamed row must always be removable');
  }

  // A saved row can be tested at once; the unsaved-but-named row cannot. Found
  // by its *name field's value*, which is the row's own fact: the name lives in
  // an input now (g-066), so it is not part of the row's text.
  const saved = rows.find((row) =>
    elements(row).some((element) => element.props['data-profile-name'] !== undefined && String(element.props.value) === 'primary')
  );
  assert.ok(saved !== undefined, 'the saved `primary` row is not identifiable by its name field');
  assert.equal(rowButton(saved, '测试')?.props.disabled, false, 'a saved row must be testable');
  mounted.unmount();
});

test('removing one unnamed row removes exactly that row', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: rowsFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();

  const before = profileRows(tree);
  assert.equal(before.length, 4);
  const victim = before[2]!;
  const victimId = String(victim.props['data-profile']);
  fire(rowButton(victim, '删除'), 'onClick');
  tree = await mounted.runtime.flush();

  const after = profileRows(tree);
  assert.equal(after.length, 3, 'one remove must take one row, not every unnamed one');
  assert.equal(after.some((row) => String(row.props['data-profile']) === victimId), false, 'the pressed row went');
  for (const row of before) {
    const id = String(row.props['data-profile']);
    if (id === victimId) continue;
    assert.ok(after.some((candidate) => String(candidate.props['data-profile']) === id), `row ${id} was removed too`);
  }
  mounted.unmount();
});

test('an unnamed row keeps its typed connection fields, and says where its key will come from', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: rowsFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();

  const row = profileRows(tree).find((candidate) => String(candidate.props['data-profile-unnamed']) === 'true');
  assert.ok(row !== undefined, 'the new row is missing');
  // Fill it in the way the report did — including the variable name — without
  // ever saving it.
  const controls = elements(row).filter(
    (element) => (element.type === 'input' || element.type === 'textarea') && element.props.type !== 'radio'
  );
  // The name field comes first (g-064), then baseUrl, the model list, timeoutMs
  // and apiKeyEnv; found by what they are, so a field addition fails loudly
  // instead of shifting every value one box to the left. The model list is a
  // `<textarea>` (one id per line) since g-066, hence the looser tag filter —
  // and the selection radios, which are a choice rather than a field, are skipped.
  const nameInput = controls.find((element) => typeof element.props['data-profile-name'] === 'string');
  assert.ok(nameInput !== undefined, 'the row has no name field');
  const connection = controls.filter((element) => element !== nameInput && element.props.type !== 'password');
  assert.equal(connection.length, 4, `expected four connection fields, saw ${connection.length}`);
  assert.equal(String(connection[0]?.props.placeholder), 'http://127.0.0.1:8000/v1', 'the first connection field is not Base URL');
  assert.equal(connection[1]?.type, 'textarea', 'the second connection field is the model list');
  type(connection[0], 'https://newapi.aseit.cn/v1');
  type(connection[1], 'd3-ultra');
  type(connection[2], '2000');
  type(connection[3], 'NEWAPI_ASEIT_API_KEY');
  tree = await mounted.runtime.flush();

  const updated = profileRows(tree).find((candidate) => String(candidate.props['data-profile']) === String(row.props['data-profile']));
  assert.ok(updated !== undefined, 'the row disappeared while it was being filled in');
  const text = textOf(updated);
  // The contradiction this pins: the row said "no variable named" while the
  // variable name sat in the field beside it.
  assert.ok(!text.includes('未指定变量名'), `an unsaved row still claims nothing was named: ${text}`);
  assert.ok(
    text.includes('保存后将从 NEWAPI_ASEIT_API_KEY 读取（未保存）'),
    `the row does not say where its key will come from: ${text}`
  );
  // Every field the user typed is still there.
  const values = valuesOf(updated);
  assert.ok(values.includes('https://newapi.aseit.cn/v1'), 'the base URL was lost');
  assert.ok(values.includes('d3-ultra'), 'the model was lost');
  assert.ok(values.includes('NEWAPI_ASEIT_API_KEY'), 'the variable name was lost');
  // And it is still unnamed, so it is still not testable — with the reason.
  assert.equal(rowBlockedNote(updated, 'test'), '先填写配置名');
  mounted.unmount();
});

test('a filled-in unnamed row is marked, names its row in the save error, and saves once named', async () => {
  const settings = settingsForm(PROFILED);
  const { form, mutations } = settings;
  const mounted = await mountPanel({ facts: rowsFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();

  const unnamedRow = (): Element => {
    const row = profileRows(tree).find((candidate) => String(candidate.props['data-profile-unnamed']) === 'true');
    assert.ok(row !== undefined, 'the new row is not marked as unnamed');
    return row;
  };
  // The marker is visible copy on the row itself, not a grey placeholder.
  assert.ok(textOf(unnamedRow()).includes('未命名'), `the row carries no "未命名" marker: ${textOf(unnamedRow())}`);
  const nameInput = elements(unnamedRow()).find((element) => typeof element.props['data-profile-name'] === 'string');
  assert.ok(nameInput !== undefined, 'the row has no name field to type into');

  // Fill it in without naming it, then let autosave try: refused, explained,
  // unwritten. There is no Save button any more, so the pause is what asks
  // (g-069) — and the answer must be the same refusal.
  const connectionInputs = elements(unnamedRow()).filter((element) => element.type === 'input' && typeof element.props['data-profile-name'] !== 'string' && element.props.type !== 'password');
  type(connectionInputs[0], 'https://newapi.aseit.cn/v1');
  tree = await mounted.runtime.flush();
  assert.ok(
    textOf(unnamedRow()).includes('没有「配置名」'),
    `the filled-in unnamed row does not say what is wrong: ${textOf(unnamedRow())}`
  );
  tree = await flushAutosave(mounted, tree);
  assert.deepEqual(mutations, [], 'the refused save reached the Host');
  assert.ok(textOf(tree).includes('没有「配置名」'), 'the page did not explain the refusal');
  // The row number travels with the error: the error list holds copy *keys*, so
  // the position is interpolated from `errorValues`, never baked into the key.
  const missing = mounted.observed.calls.find((call) => (call as any).op === 'mutate');
  assert.equal(missing, undefined, 'a refused save opened a write request');
  const errorLine = elements(tree).find((element) => typeof element.props.style === 'object' && textOf(element).includes('没有「配置名」'));
  assert.ok(errorLine !== undefined, 'the page did not explain the refusal');
  assert.match(textOf(tree), /第 \d+ 行连接配置/, `the refusal does not name the row: ${textOf(tree).slice(0, 400)}`);

  // Naming it in the row's own field clears the marker and the save goes through.
  type(
    elements(profileRows(tree).find((row) => String(row.props['data-profile-unnamed']) === 'true')).find((element) => typeof element.props['data-profile-name'] === 'string'),
    'aseit'
  );
  tree = await mounted.runtime.flush();
  assert.equal(profileRows(tree).filter((row) => String(row.props['data-profile-unnamed']) === 'true').length, 0, 'the marker survived the name');
  // Naming it is the edit that repairs the draft, so the same typing pause that
  // was refused a moment ago now writes (g-069).
  tree = await flushAutosave(mounted, tree);
  /** Declared with its own type: `mutations` is narrowed to an empty tuple above by `deepEqual(mutations, [])`. */
  const saves: { ops: unknown; revision: unknown }[] = mutations;
  assert.equal(saves.length, 1, `the named save did not reach the Host: ${textOf(tree).slice(0, 300)}`);
  const ops = plain(saves[0]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
  const written = ops.filter((op) => op.path[0] === 'systemOne' && op.path[1] === 'profiles' && op.path[2] === 'aseit');
  assert.ok(
    written.some((op) => op.path[3] === 'baseUrl' && (op.value as unknown) === 'https://newapi.aseit.cn/v1'),
    `the new row's base URL was not written: ${JSON.stringify(ops).slice(0, 300)}`
  );
  mounted.unmount();
});

test('activating a saved row shows the marker at once', async () => {
  const { form } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: rowsFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  // `secondary` is not the active profile yet.
  const secondaryRow = namedRow(tree, 'secondary');
  assert.ok(secondaryRow !== undefined);
  assert.ok(!textOf(secondaryRow).includes('已激活'), 'the fixture already shows the marker');
  fire(rowButton(secondaryRow, '设为激活'), 'onClick');
  tree = await mounted.runtime.flush();

  const activated = namedRow(tree, 'secondary');
  assert.ok(activated !== undefined);
  assert.ok(textOf(activated).includes('已激活'), 'the activation did not show up on the row');
  // The marker is a draft edit, so nothing was written yet.
  mounted.unmount();
});

//#endregion

//#region header status icon

/** The single status button of the rendered header, if any. */
function statusButtons(tree: unknown): Element[] {
  return elements(tree).filter(
    (element) => element.type === 'button' && typeof element.props['data-reflex-status'] === 'string'
  );
}

/** Resolve an element's inline style as a plain record. */
function styleOf(element: Element | undefined): Record<string, unknown> {
  return (element?.props.style as Record<string, unknown> | undefined) ?? {};
}

/** The title row: the nowrap header div that holds the h3 and the status icon. */
function titleRow(tree: unknown): Element | undefined {
  return elements(tree).find(
    (element) =>
      element.type === 'div' &&
      styleOf(element)['flexWrap'] === 'nowrap' &&
      elements(element).some((child) => child.type === 'h3')
  );
}

/** Facts whose snapshot leaves the reasoning effort unset. */
function factsWithUnsetEffort(apiKeyPresent: boolean): PanelRuntimeFacts {
  const base = facts(apiKeyPresent);
  return {
    ...base,
    config: resolveConfig({ ...AUTHORED, effort: { fallback: 'low', minConfidence: 0.3 } })
  };
}

test('the three long text badges collapse into one fixed-size status icon', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    const icons = statusButtons(mounted.tree);
    assert.equal(icons.length, 1, 'the header must show exactly one status icon');
    const icon = icons[0]!;
    assert.equal(icon.props['data-reflex-status'], 'ok');

    const iconStyle = styleOf(icon);
    assert.equal(iconStyle.width, '18px', 'the icon width is not fixed');
    assert.equal(iconStyle.height, '18px', 'the icon height is not fixed');
    assert.equal(iconStyle.flex, '0 0 auto', 'the icon can be squeezed by the title');
    assert.match(String(iconStyle.color), /state-success/, 'a healthy state is not a success tone');

    const row = titleRow(mounted.tree);
    assert.ok(row !== undefined, 'the header has no title row');
    assert.equal(styleOf(row)['flexWrap'], 'nowrap', 'the title row still wraps');
    assert.equal(styleOf(row)['minWidth'], 0, 'the title row cannot shrink below its content');

    const title = elements(mounted.tree).find((element) => element.type === 'h3');
    assert.ok(title !== undefined, 'the header lost its title');
    assert.equal(styleOf(title)['whiteSpace'], 'nowrap', 'the title can still wrap');
    assert.equal(styleOf(title)['overflow'], 'hidden', 'the title has no overflow guard');

    // The old long labels are gone from the rendered text.
    const body = textOf(mounted.tree);
    assert.ok(!body.includes('路由 · 未启用'), 'the routing text badge is still rendered');
    assert.ok(!body.includes('推理强度 · 未设置'), 'the effort text badge is still rendered');
    assert.ok(!body.includes('后端 · '), 'the backend text badge is still rendered');
  } finally {
    mounted.unmount();
  }
});

test('the status icon is focusable and explains routing, effort, and backend', async () => {
  const { form } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    const icon = statusButtons(mounted.tree)[0]!;
    assert.equal(icon.type, 'button', 'the status icon is not a button');

    const label = String(icon.props['aria-label'] ?? '');
    assert.match(label, /Reflex 运行状态/, 'the icon has no status label');
    assert.match(label, /路由已启用/, 'the label drops the routing fact');
    assert.match(label, /推理强度 reflex/, 'the label drops the effort fact');
    assert.match(label, /后端 jev 正常/, 'the label drops the backend fact');

    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('\n'), 'the explanation is not multi-line');
    assert.ok(title.includes('虚拟 Provider 路由已启用'), 'the explanation does not describe routing');
    assert.ok(title.includes('「虚拟 Provider」页'), 'the explanation does not say where to change routing');
    assert.ok(title.includes('推理强度'), 'the explanation does not describe reasoning effort');
    assert.ok(title.includes('「推理强度」页'), 'the explanation does not say where to change effort');
    assert.ok(title.includes('System One 决策后端'), 'the explanation does not describe the backend');
    assert.ok(title.includes('密钥来自环境变量 JEV_API_KEY'), 'the explanation drops where the key came from');
    assert.ok(title.includes('「System 1 后端」页'), 'the explanation does not say where to configure the backend');
  } finally {
    mounted.unmount();
  }
});

test('the icon distinguishes healthy, missing-key, and degraded states', async () => {
  const { form } = settingsForm(AUTHORED);

  const healthy = await mountPanel({ facts: facts(true), form });
  try {
    const icon = statusButtons(healthy.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'ok');
    assert.equal(textOf(icon).trim(), '●', 'the healthy glyph is not distinctive');
  } finally {
    healthy.unmount();
  }

  // A *locked* lookup (g-059): the variable was named and is empty. The icon is
  // still a warning — there is no key — but the copy names the locked variable
  // and says the lookup will not fall back.
  const locked = await mountPanel({
    facts: { ...factsWithUnsetEffort(false), routingActive: false, apiKeyLocked: true, apiKeyVariable: 'REFLEX_TEST_KEY' },
    form
  });
  try {
    const icon = statusButtons(locked.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'warn', 'a locked key is not a warning state');
    assert.match(String(styleOf(icon).color), /state-warn/, 'a locked key is not drawn in the warning tone');
    assert.equal(textOf(icon).trim(), '!', 'the warning glyph is not distinctive');
    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('已点名 REFLEX_TEST_KEY'), `the warning state does not name the locked variable: ${title}`);
    assert.ok(title.includes('不会回退'), 'the warning state does not say the lookup is locked');
    assert.ok(title.includes('降级'), 'the warning state does not warn about degradation');
    assert.match(String(icon.props['aria-label'] ?? ''), /缺少 API Key/);
  } finally {
    locked.unmount();
  }

  // Nothing named, nothing exported: still a warning, and still no claim that a
  // variable was named.
  const missingKey = await mountPanel({ facts: { ...factsWithUnsetEffort(false), routingActive: false }, form });
  try {
    const icon = statusButtons(missingKey.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'warn', 'a missing key is not a warning state');
    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('未指定变量名'), 'the warning does not state that nothing was named');
    assert.ok(!title.includes('已点名'), 'an unconfigured block must not claim a variable was named');
    assert.ok(title.includes('降级'), 'the warning state does not warn about degradation');
  } finally {
    missingKey.unmount();
  }

  const degradedFacts: PanelRuntimeFacts = {
    ...facts(true),
    systemOneHealth: { available: false, lastFailureReason: 'fetch failed', consecutiveFailures: 2 }
  };
  const degraded = await mountPanel({ facts: degradedFacts, form });
  try {
    const icon = statusButtons(degraded.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'error', 'a degraded backend is not an error state');
    assert.match(String(styleOf(icon).color), /state-error/, 'a degraded backend is not drawn in the error tone');
    assert.equal(textOf(icon).trim(), '×', 'the error glyph is not distinctive');
    assert.match(String(icon.props['aria-label'] ?? ''), /不可用/);
    // g-016: the explicit degradation banner and the error icon appear together.
    const banner = degradedBanner(degraded.tree);
    assert.ok(banner !== undefined, 'the degradation banner disappeared with the icon change');
  } finally {
    degraded.unmount();
  }
});

test('the status chip reports all four key states, never the key itself', async () => {
  // g-059: four states, each with its own sentence — a literal key, the one named
  // variable, a named variable that is empty (locked, and it says so), and a
  // fallback variable that answered because nothing was named.
  const { form } = settingsForm(AUTHORED);
  const cases: {
    source: 'profile' | 'env' | 'fallback' | undefined;
    variable?: string;
    locked?: boolean;
    expect: RegExp;
    forbidden?: RegExp;
  }[] = [
    { source: 'profile', expect: /密钥来自连接配置/, forbidden: /来自环境变量/ },
    { source: 'env', variable: 'JEV_API_KEY', expect: /来自环境变量 JEV_API_KEY/ },
    {
      source: undefined,
      variable: 'REFLEX_TEST_KEY',
      locked: true,
      expect: /已点名 REFLEX_TEST_KEY.*不会回退/,
      // A locked lookup must never be described as "nothing configured": the
      // user typed a name, and the fix is to set *that* variable.
      forbidden: /未配置密钥/
    },
    { source: 'fallback', variable: 'JEV_API_KEY', expect: /来自环境变量 JEV_API_KEY（回退/ },
    // Nothing named, nothing exported: the chip states *that*, and names the four
    // variables it checked rather than implying a name was locked onto.
    { source: undefined, expect: /未指定变量名/, forbidden: /已点名/ }
  ];
  for (const entry of cases) {
    const base = facts(entry.source !== undefined);
    const scenarioFacts: PanelRuntimeFacts = {
      ...base,
      ...(entry.source === undefined
        ? {}
        : { apiKeySource: entry.source, ...(entry.variable === undefined ? {} : { apiKeyVariable: entry.variable }) }),
      ...(entry.locked === true
        ? { apiKeyLocked: true, ...(entry.variable === undefined ? {} : { apiKeyVariable: entry.variable }) }
        : {})
    };
    const mounted = await mountPanel({ facts: scenarioFacts, form });
    try {
      const title = String(statusButtons(mounted.tree)[0]?.props.title ?? '');
      assert.match(title, entry.expect, `source ${String(entry.source)} is not reported: ${title}`);
      if (entry.forbidden !== undefined) {
        assert.doesNotMatch(title, entry.forbidden, `state ${String(entry.source)} leaked another state's copy`);
      }
      // The candidates are named when nothing resolves, so the user knows what to check.
      if (entry.source === undefined && entry.locked !== true) {
        assert.match(title, /SYSTEM_ONE_API_KEY/, 'the missing-key copy must name the candidates');
        assert.match(title, /OPENAI_API_KEY/, 'the missing-key copy must name every candidate');
      }
      // Whatever the source, the credential itself never reaches the copy.
      const serialized = JSON.stringify([title, textOf(mounted.tree)]);
      assert.ok(!serialized.includes('sk-'), 'a key value leaked into the rendered copy');
    } finally {
      mounted.unmount();
    }
  }
});

test('the English status icon mirrors the label, title, and three states', async () => {
  const { form } = settingsForm(AUTHORED);
  const healthy = await mountPanel({ facts: facts(true), form, language: 'en' });
  try {
    const icon = statusButtons(healthy.tree)[0]!;
    const label = String(icon.props['aria-label'] ?? '');
    assert.match(label, /Reflex status/, 'the English label is missing');
    assert.match(label, /routing enabled/, 'the English label drops routing');
    assert.match(label, /reasoning effort reflex/, 'the English label drops effort');
    assert.match(label, /backend jev healthy/, 'the English label drops the backend');

    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('"Virtual Provider" page'), 'the English explanation omits the routing page');
    assert.ok(title.includes('"Reasoning effort" page'), 'the English explanation omits the effort page');
    assert.ok(title.includes('"System 1 backend" page'), 'the English explanation omits the backend page');
    assert.ok(title.includes('environment variable JEV_API_KEY'), `the English explanation drops where the key came from: ${title}`);
  } finally {
    healthy.unmount();
  }

  const locked = await mountPanel({
    facts: { ...factsWithUnsetEffort(false), routingActive: false, apiKeyLocked: true, apiKeyVariable: 'REFLEX_TEST_KEY' },
    form,
    language: 'en'
  });
  try {
    const icon = statusButtons(locked.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'warn');
    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('REFLEX_TEST_KEY is named but unset'), `the English warning does not name the locked variable: ${title}`);
    assert.ok(title.includes('will not fall back'), 'the English warning does not say the lookup is locked');
    assert.ok(title.includes('degrade'), 'the English warning does not warn about degradation');
    assert.match(String(icon.props['aria-label'] ?? ''), /missing its API key/);
  } finally {
    locked.unmount();
  }

  const missingKey = await mountPanel({ facts: { ...factsWithUnsetEffort(false), routingActive: false }, form, language: 'en' });
  try {
    const icon = statusButtons(missingKey.tree)[0]!;
    assert.equal(icon.props['data-reflex-status'], 'warn');
    const title = String(icon.props.title ?? '');
    assert.ok(title.includes('no variable is named'), 'the English warning does not state that nothing was named');
    assert.ok(title.includes('OPENAI_API_KEY'), 'the English warning does not name the fallback candidates');
    assert.ok(!title.includes('is named but unset'), 'an unconfigured block must not claim a variable was named');
    assert.match(String(icon.props['aria-label'] ?? ''), /missing its API key/);
  } finally {
    missingKey.unmount();
  }
});

//#endregion

//#region profile compose layer (cordis.patch.yml)

/**
 * A deployment configured entirely in the profile patch writes nothing into the
 * user layer: the Host reports the running configuration as `base` and an empty
 * `value`. Before the page read `base` it rendered a configuration whose model
 * pool was demonstrably in use as an empty form.
 */
const PATCHED: Record<string, unknown> = {
  backend: 'jev',
  systemOne: { apiKeyEnv: 'SYSTEM_ONE_API_KEY' },
  routing: {
    enabled: true,
    virtualProvider: 'reflex',
    fallback: 'newapi-aseit:MiniMax-M3.1-Flash',
    maxTaskChars: 400,
    models: {
      'reflex-1': [
        { provider: 'deepseek-official', model: 'deepseek-flash', description: 'fast official model' },
        { provider: 'newapi-aseit', model: 'qwen3.8-27b', description: 'local model, free' }
      ]
    }
  },
  effort: { reasoningEffort: 'reflex', fallback: 'medium', minConfidence: 0.3 },
  interventions: {
    mode: 'active',
    capabilities: { stagnation: 'active', prune: 'active', gate: 'active', closing: 'active' }
  }
};

test('a configuration that lives only in the profile patch still renders its model pool', async () => {
  const { form } = settingsForm({}, { base: PATCHED, user: {} });
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    openTab(mounted.tree, '虚拟 Provider');
    const tree = await mounted.runtime.flush();
    // A virtual model id is an editable input value, not text: read the values.
    const text = valuesOf(tree);
    assert.ok(text.includes('reflex-1'), 'the virtual model id in the compose base was not rendered');
    assert.ok(text.includes('deepseek-flash'), 'the first candidate in the compose base was not rendered');
    assert.ok(text.includes('qwen3.8-27b'), 'the second candidate in the compose base was not rendered');
    // The pool is the observable half: it only appears when the page seeded from
    // the compose base rather than from the (empty) user layer.

    assert.equal(
      elements(tree).filter((element) => element.type === 'input' && element.props.placeholder === '物理模型').length,
      2,
      'both candidates from the base layer must be editable rows'
    );
  } finally {
    mounted.unmount();
  }
});

test('editing a base-defined pool writes it to the user layer instead of showing an empty form', async () => {
  const { form, mutations } = settingsForm({}, { base: PATCHED, user: {} });
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    openTab(mounted.tree, '虚拟 Provider');
    let tree = await mounted.runtime.flush();
    fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
    tree = await mounted.runtime.flush();

    assert.equal(mutations.length, 1, 'saving a base-seeded draft did not reach the settings form');
    const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: any }[];
    const routing = ops.find((op) => op.path.length === 1 && op.path[0] === 'routing');
    assert.ok(routing, 'the routing group was not written');
    assert.equal(routing?.value.enabled, false);
    // The pool came from the base layer, but the write now records it in the
    // user layer: the panel edits what it shows, and what it shows was not empty.
    assert.deepEqual(Object.keys(routing?.value.models ?? {}), ['reflex-1']);
    assert.equal(routing?.value.models['reflex-1'].length, 2);
    assert.equal(routing?.value.virtualProvider, 'reflex');
  } finally {
    mounted.unmount();
  }
});

test('a group write keeps stored keys the page never rendered', async () => {
  // A whole-section write replaces the section, so a key authored by hand (or by
  // a future schema) would vanish on an unrelated save unless it is carried over.
  const user = {
    routing: {
      enabled: true,
      virtualProvider: 'reflex',
      fallback: 'deepseek:deepseek-chat',
      maxTaskChars: 400,
      models: { 'reflex-pro': [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] },
      stickyMargin: 0.25
    }
  };
  const { form, mutations } = settingsForm(AUTHORED, { user });
  const mounted = await mountPanel({ facts: facts(true), form });
  try {
    openTab(mounted.tree, '虚拟 Provider');
    let tree = await mounted.runtime.flush();
    fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
    tree = await mounted.runtime.flush();

    const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: any }[];
    const routing = ops.find((op) => op.path.length === 1 && op.path[0] === 'routing');
    assert.equal(routing?.value.enabled, false, 'the edit itself must be written');
    assert.equal(routing?.value.stickyMargin, 0.25, 'a stored key the page does not render was dropped by the save');
  } finally {
    mounted.unmount();
  }
});

test('the base layer report: a run whose value layer is empty is the case the page must handle', async () => {
  // The reproduction the page was rewritten for: `cordis.patch.yml` writes a
  // configuration, the Host reports it as `base`, and the effective `value` is
  // empty. Two things must hold for that deployment: the page renders the pool
  // (documented above) and the Host-side validator accepts the group the page
  // then writes, including the pool it carried over from the base layer.
  const resolved = resolveConfig({
    backend: 'jev',
    routing: {
      enabled: false,
      virtualProvider: 'reflex',
      maxTaskChars: 400,
      models: { 'reflex-1': [{ provider: 'deepseek-official', model: 'deepseek-flash', description: 'fast official model' }] }
    }
  } as ReflexConfig);
  assert.equal(resolved.routing.enabled, false);
  assert.deepEqual(Object.keys(resolved.routing.models), ['reflex-1']);
  assert.equal(resolved.routing.models['reflex-1']?.[0]?.provider, 'deepseek-official');
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
function applyOps(ops: readonly { op: string; path: string[]; value?: unknown }[], base: Record<string, unknown> = {}): Record<string, unknown> {
  // The Host applies each op to the *stored* section, not to an empty one, so a
  // deep path (`systemOne.profiles.p.timeoutMs`) lands beside the siblings it
  // does not mention. Building from `{}` would make a per-path write look like a
  // replacement of the whole block — the bug this shape guards against.
  const section: Record<string, unknown> = structuredClone(base);
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
  // One field per surface the page owns: a row field (the profile the row edits),
  // and the runtime-level fields, which are untouched by the row edit and would
  // otherwise drop out of the write inventory below.
  type(inputElement(tree, '超时（毫秒）'), '9000');
  type(inputElement(tree, '工具名前缀'), 'rv_');
  type(inputElement(tree, '裁剪阈值（字符）'), '600');
  type(inputElement(tree, '账本 JSONL 路径'), '.reflex/ledger.jsonl');
  type(inputElement(tree, '校准曲线路径'), 'calibration.json');
  // The implementation fallback is not restated by a row edit, so it is edited
  // here too — otherwise the scalar `backend` path leaves the inventory.
  fire(selectOf(tree, '后端实现'), 'onChange', { target: { value: 'mock' } });
}

//#endregion

test('the System 1 backend page writes the scalar and its rows, on the paths the Host declares', async () => {
  const { form, mutations } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  // Two edits, one per surface the page writes: a row field and a runtime field.
  // (`editBackendPage` touches more surfaces for the write-inventory sweep below;
  // naming the edits here keeps this test about *where* they land.)
  type(inputElement(tree, '超时（毫秒）'), '9000');
  type(inputElement(tree, '工具名前缀'), 'rv_');
  tree = await mounted.runtime.flush();
  // Both edits are typing: they coalesce into ONE write at the pause (g-069).
  tree = await flushAutosave(mounted, tree);

  assert.equal(mutations.length, 1, 'the coalesced typing did not reach the settings form');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value: Record<string, unknown> }[];
  assert.deepEqual(
    ops.map((op) => [op.op, op.path]),
    [
      // Exactly the two fields the test edited, and nothing else (g-066).
      //
      // The write is per path: a group whose expansion differs contributes only
      // the paths whose value changed, so an unrelated edit no longer restates
      // the whole connection block — nor emits the unsets that used to accompany
      // every field the page had no opinion about.
      //
      // g-057's rule still holds inside that: the connection is addressed field
      // by field, never as one group (a group `set` would delete every
      // `role('secret')` key the page never received), and the only flat paths
      // left are the ones in the schema at all — there are no flat connection
      // fields any more.
      ['set', ['systemOne', 'profiles', 'primary', 'timeoutMs']],
      ['set', ['toolPrefix']]
    ],
    'the backend page must address the fields the Host declares, never its own group name'
  );
  // `backend` is unchanged by this edit, so the per-path rule leaves it out — the
  // scalar-union shape is pinned by the page's own choice list and by
  // `groupWrites` (see `client-profiles.test.ts`), not by a re-statement here.
  const backendOp = ops.find((op) => op.path.length === 1 && op.path[0] === 'backend');
  assert.equal(backendOp, undefined, 'an unchanged group is not restated');
  assert.equal(
    ops.some((op) => op.path.length === 1 && op.path[0] === 'systemOne'),
    false,
    'a whole-group systemOne write would delete stored secrets'
  );
  const timeoutOp = ops.find((op) => op.path.join('.') === 'systemOne.profiles.primary.timeoutMs');
  assert.equal(timeoutOp?.value, 9000, 'the edited timeout must land on the row it was edited in');

  // The Host accepts what the page wrote, and each field lands where it belongs.
  const resolved = resolveConfig({ ...PROFILED, ...applyOps(ops, { ...PROFILED }) } as ReflexConfig);
  assert.equal(resolved.backend, 'jev');
  assert.equal(resolved.toolPrefix, 'rv_');
  assert.equal(resolved.systemOne.timeoutMs, 9000, 'and the runtime reads it back from the active profile');
  assert.equal(resolved.systemOne.baseUrl, 'http://flat.example', 'an untouched field round-trips from the row');
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
    { tab: '工具开关', edit: (tree) => fire(checkboxOf(tree, 'reflex_gate'), 'onChange', { target: { checked: false } }) },
    // The host-capability consent, on its own page section: ticking it must write
    // `delegation.enabled` (a volatile path the Host accepts), and must not
    // depend on any tool switch.
    {
      tab: '工具开关',
      edit: (tree) => fire(checkboxOf(tree, '启用子代理委派（宿主能力开关）'), 'onChange', { target: { checked: true } })
    }
  ];
  const paths = new Set<string>();
  for (const perturb of perturbs) {
    // The fixture carries a connection row: the backend page edits *rows* now
    // (g-066), and a document with no profile has no row field to touch — the
    // sweep would then miss every `systemOne.profiles.*` path it exists to fence.
    const { form, mutations } = settingsForm(PROFILED);
    const mounted = await mountPanel({ facts: profiledFacts(), form });
    openTab(mounted.tree, perturb.tab);
    let tree = await mounted.runtime.flush();
    perturb.edit(tree);
    tree = await mounted.runtime.flush();
    // A switch or a select writes at once; a sweep entry that types has to wait
    // out the pause instead. Both end with exactly one write (g-069).
    tree = await flushAutosave(mounted, tree);

    assert.equal(mutations.length, 1, `${perturb.tab}: the edit did not reach the settings form`);
    const ops = plain(mutations[0]?.ops) as { op: string; path: string[] }[];
    for (const op of ops) {
      assert.ok(hostAcceptsPath(HOST_CONFIG, op.path), `${perturb.tab} writes ${op.path.join('.')}, which the Host refuses as non-volatile`);
      paths.add(op.path.join('.'));
    }
    mounted.unmount();
  }
  assert.deepEqual(
    [...paths].sort(),
    [
      'backend',
      'calibrationPath',
      'delegation',
      'effort',
      'interventions',
      'ledgerPath',
      'pruneThreshold',
      'routing',
      // g-057 writes the connection block field by field rather than as one
      // group (a group `set` would delete stored secrets), so the inventory names
      // the leaves instead of `systemOne`. g-066 moved those leaves onto the rows
      // and made the write per path, so a save names exactly what it changed: the
      // one row field it touched, and the runtime-level fields beside it.
      'systemOne.profiles.primary.timeoutMs',
      'toolPrefix',
      'tools'
    ],
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
  // permission and not about there being nothing to save. Autosave is the only
  // write path now, so this is the check that matters: a disabled control is a
  // hint, and the queue must refuse on its own (g-069).
  type(inputElement(tree, '任务文本预算'), '900');
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);
  assert.deepEqual(mutations, [], 'a read-only document accepted a write');
  assert.equal(inputOf(tree, '任务文本预算'), '900', 'the draft was not the one under test');
  // The page offers no Save button at all: saving is not an action any more.
  assert.equal(hasButton(tree, '保存'), false, 'the autosaving page still offers a Save button');
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

/**
 * Whether a resolved path names one *profile row's* field, e.g.
 * `systemOne.profiles.JEV official.baseUrl`.
 *
 * A row field's path depends on the row's name, which is data, not schema: the
 * page renders those by shape on every row it lists. The shape is what
 * `OPTIONAL_SCHEMA_PATHS` carries, so a concrete row's path is not a separate
 * field to account for.
 * @param path - a dotted path from {@link leafPaths}.
 * @returns true for a path under a named profile.
 */
function isProfileRowPath(path: string): boolean {
  return /^systemOne\.profiles\.[^.]+\.[^.]+$/.test(path);
}

/** Schema leaves that a default config leaves unset, so they have no resolved key. */
const OPTIONAL_SCHEMA_PATHS = [
  'routing.fallback',
  'effort.setting',
  // The connection fields are the *profile's* now (g-066): a profile states each
  // one individually, so none of them is guaranteed to appear in a resolved
  // config, and the page renders them on every row it lists.
  'systemOne.profiles.baseUrl',
  'systemOne.profiles.modelIds',
  'systemOne.profiles.selectedModel',
  'systemOne.profiles.apiKeyEnv',
  'systemOne.profiles.timeoutMs',
  'ledgerPath',
  'calibrationPath'
] as const;

/**
 * Resolved keys that are derived rather than edited on the page.
 *
 * `systemOne.unconfigured` (g-066) is the newest: it is a *diagnosis* the
 * resolution adds, not a field of the document — the page renders it as the
 * "nothing connects" banner, and it is covered by its own test, which asserts the
 * four reasons and the copy each one shows.
 */
const DERIVED_SCHEMA_PATHS = new Set([
  'systemOne.backend',
  'interventions.enabled',
  'systemOne.unconfigured',
  // The connection in force, projected from the active row (g-066). The page
  // renders *no* field for any of them: they are what the row the user edits
  // resolves to, and they appear on the page as the row's own editors plus the
  // activation marker. g-067 made `active` and the resolved connection fields
  // non-empty in the default config (the factory connection is active by
  // default), which is why they are enumerated here rather than only when a
  // deployment happened to author them.
  'systemOne.active',
  'systemOne.baseUrl',
  'systemOne.model',
  'systemOne.apiKeyEnv'
]);

/** Schema path → the page group that renders it. */
function tabOfPath(path: string): string {
  if (path.startsWith('routing.')) return 'routing';
  if (path.startsWith('effort.')) return 'effort';
  if (path.startsWith('interventions.')) return 'interventions';
  if (path.startsWith('tools.')) return 'tools';
  // The delegation consent is rendered on the tools tab (it is about the
  // delegate tool), even though it owns a group of its own in the document.
  if (path.startsWith('delegation.')) return 'tools';
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
  /** The default of a field whose answer is relative to its row (the model selection). */
  firstListed: string;
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
    firstListed: '列表第一项',
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
    firstListed: 'the first listed id',
    onDefault: 'on',
    offDefault: 'off'
  }
};

/** The default a field's help must state, derived from `resolveConfig({})`. */
function expectedDefaultToken(path: string, resolved: unknown, language: 'zh' | 'en'): string | undefined {
  const copy = GUIDANCE_COPY[language];
  if (path === 'effort.setting') return copy.leaveDefault;
  // The model selection is not a resolved leaf of the default config: its
  // default is *relative* to the row it belongs to ("the first listed id"), which
  // no single resolved value can state. The copy says exactly that, and the
  // behaviour is pinned in `systemone-profiles.test.ts` instead.
  if (path === 'systemOne.profiles.selectedModel') return copy.firstListed;
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
    // The factory connection is part of the default document now (g-067), so its
    // row's leaves arrive here with the profile name baked into the path. They
    // are *row* fields: the page renders them by shape, once per row it lists,
    // which is what `OPTIONAL_SCHEMA_PATHS` states below — so they are carried as
    // the shape, not as this one row's paths.
    ...leafPaths(resolved).filter((path) => !DERIVED_SCHEMA_PATHS.has(path) && !isProfileRowPath(path)),
    ...OPTIONAL_SCHEMA_PATHS
  ];
  const uniquePaths = [...new Set(expectedPaths)];
  assert.ok(uniquePaths.length >= 30, `the schema traversal found only ${uniquePaths.length} fields`);

  const keysByLanguage: Record<string, string[]> = {};
  let covered = 0;

  for (const language of ['zh', 'en'] as const) {
    const copy = GUIDANCE_COPY[language];
    const { form } = settingsForm(PROFILED);
    const mounted = await mountPanel({ facts: profiledFacts(), form, language });
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
      // One page per tab: the stub runtime allocates hook slots by call order, so
      // a `useState` left non-default on one tab would leak into the `?`
      // expansion checks of the next. g-058 added such a state (the flat block's
      // fold), which is why this walk no longer shares one mounted page.
      const { form: tabForm } = settingsForm(PROFILED);
      const page = await mountPanel({ facts: profiledFacts(), form: tabForm, language });
      openTab(page.tree, tabLabels[tab] as string);
      const tree = await page.runtime.flush();
      const wrappers = elements(tree).filter((element) => typeof element.props['data-reflex-path'] === 'string');
      for (const wrapper of wrappers) renderedPaths.add(String(wrapper.props['data-reflex-path']));
      const pathsInTab = uniquePaths.filter((path) => groupOf(path) === tab);
      assert.ok(pathsInTab.length > 0, `no schema field maps to the ${tab} tab`);

      for (const path of pathsInTab) {
        const wrapper = wrappers.find((element) => element.props['data-reflex-path'] === path);
        assert.ok(wrapper !== undefined, `the ${tab} tab does not render field ${path}`);
        covered += 1;

        // Placeholder: every text input must show a non-empty example.
        // A list-valued field is a `<textarea>` and a single choice among ids is a
        // radio group (both g-066), so a *control* is any interactive element —
        // the point is that the field is operable, not which tag expresses it.
        const control = elements(wrapper).find(
          (element) => element.type === 'input' || element.type === 'select' || element.type === 'textarea' || element.type === 'button'
        );
        assert.ok(control !== undefined, `field ${path} has no control`);
        const isText = (control.type === 'input' && control.props.type === 'text') || control.type === 'textarea';
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

//#region degraded System One banner

/** The degraded banner of the rendered tree, if any. */
function degradedBanner(tree: unknown): Element | undefined {
  return elements(tree).find((element) => element.props['data-reflex-degraded'] === 'true');
}

test('a degraded System One backend shows a bilingual reason banner on every tab and it disappears on recovery', async () => {
  for (const language of ['zh', 'en'] as const) {
    const { form } = settingsForm(AUTHORED);
    const degradedFacts: PanelRuntimeFacts = {
      ...facts(true),
      systemOneHealth: {
        available: false,
        lastFailureReason: 'fetch failed',
        lastFailureAt: '2024-03-04T05:06:07.000Z',
        consecutiveFailures: 2
      }
    };
    const mounted = await mountPanel({ facts: degradedFacts, form, language });
    try {
      let tree = await mounted.runtime.flush();
      const banner = degradedBanner(tree);
      assert.ok(banner !== undefined, `${language}: no degraded banner in the header`);
      const copy = textOf(banner);
      assert.match(copy, /fetch failed/, `${language}: the banner does not name the reason`);
      if (language === 'zh') {
        assert.match(copy, /降级/, 'the Chinese banner does not say decisions degraded');
        assert.match(copy, /恢复后本提示自动消失/, 'the Chinese banner does not promise automatic recovery');
      } else {
        assert.match(copy, /degraded/i, 'the English banner does not say decisions degraded');
        assert.match(copy, /disappears automatically/i, 'the English banner does not promise automatic recovery');
      }

      // The banner belongs to the header, not to one page: it survives tab switches.
      openTab(mounted.tree, language === 'zh' ? '决策账本' : 'Decision ledger');
      tree = await mounted.runtime.flush();
      assert.ok(degradedBanner(tree) !== undefined, `${language}: the banner vanished on another tab`);

      // Its refresh button pulls a fresh snapshot.
      const refresh = elements(banner).find(
        (element) => element.type === 'button' && textOf(element).includes(language === 'zh' ? '刷新' : 'Refresh')
      );
      assert.ok(refresh !== undefined, `${language}: the banner has no refresh button`);
      const before = mounted.observed.calls.filter((call) => call.url.includes('/panel')).length;
      fire(refresh, 'onClick');
      await mounted.runtime.flush();
      const after = mounted.observed.calls.filter((call) => call.url.includes('/panel')).length;
      assert.ok(after > before, `${language}: the refresh button did not re-read the snapshot`);
    } finally {
      mounted.unmount();
    }
  }
});

test('the banner is absent while the backend is healthy or when it publishes no health', async () => {
  const { form } = settingsForm(AUTHORED);
  const healthy: PanelRuntimeFacts = {
    ...facts(true),
    systemOneHealth: { available: true, consecutiveFailures: 0 }
  };
  const mountedHealthy = await mountPanel({ facts: healthy, form });
  try {
    const tree = await mountedHealthy.runtime.flush();
    assert.equal(degradedBanner(tree), undefined, 'a healthy backend still shows the degraded banner');
  } finally {
    mountedHealthy.unmount();
  }

  const mountedUnknown = await mountPanel({ facts: facts(true), form });
  try {
    const tree = await mountedUnknown.runtime.flush();
    assert.equal(degradedBanner(tree), undefined, 'an in-process backend is misread as an outage');
  } finally {
    mountedUnknown.unmount();
  }
});

//#endregion

//#region choosing the model in force: radio group, no write before save (g-066 criterion 2)

/**
 * A configuration whose active connection lists three models and selects the
 * second one — the shape that renders a radio group rather than a statement.
 */
const MULTI_MODEL = {
  ...AUTHORED,
  systemOne: {
    active: 'multi',
    profiles: {
      multi: { baseUrl: 'http://multi.example', modelIds: ['alpha', 'beta', 'gamma'], selectedModel: 'beta' },
      // One listed id: the group degenerates to a plain statement — there is
      // nothing to choose, so a single radio would be a decision to re-confirm.
      single: { baseUrl: 'http://single.example', modelIds: ['solo'] },
      // The pre-g-066 single-model spelling still opens with a selection.
      legacy: { baseUrl: 'http://legacy.example', model: 'old-model' }
    }
  }
} as unknown as ReflexConfig;

/** Facts for {@link MULTI_MODEL}, with no stored keys to trip the rename guard. */
function multiModelFacts(): PanelRuntimeFacts {
  return { ...facts(false), config: resolveConfig(MULTI_MODEL), profileKeys: {} };
}

/** The radio inputs of one row, in render order. */
function modelRadios(row: Element): Element[] {
  return elements(row).filter((element) => element.type === 'input' && element.props.type === 'radio');
}

/** The value of one model-list field of a row (there is exactly one textarea). */
function modelListOf(row: Element): Element | undefined {
  return elements(row).find((element) => element.type === 'textarea');
}

test('a connection listing several models offers one radio group with exactly one selection', async () => {
  const { form } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  const tree = await mounted.runtime.flush();

  const row = namedRow(tree, 'multi');
  assert.ok(row !== undefined, 'the multi-model row is missing');
  const radios = modelRadios(row);
  assert.deepEqual(
    radios.map((radio) => String(radio.props.value)),
    ['alpha', 'beta', 'gamma'],
    'one radio per listed id, in authored order'
  );
  // Single-select semantics: every radio shares one group name (per row), so the
  // browser makes choosing one clear the others — and the checked one is the
  // *saved* selection.
  const names = new Set(radios.map((radio) => String(radio.props.name)));
  assert.equal(names.size, 1, 'the group must be one mutual-exclusion group');
  const checked = radios.filter((radio) => radio.props.checked === true);
  assert.deepEqual(checked.map((radio) => String(radio.props.value)), ['beta'], 'exactly the saved selection is checked');
  // A different row's group is a different group: selecting in one cannot clear
  // the other row's choice.
  const single = namedRow(tree, 'single');
  assert.ok(single !== undefined);
  const singleRadios = modelRadios(single);
  assert.equal(singleRadios.length, 0, 'a one-model connection renders no radio to re-confirm');
  assert.ok(valuesOf(single).includes('solo'), 'and states the model it runs');
  assert.equal(singleRadios.length, 0, 'the single-model row adds no group of its own');
  // The legacy single-model row opens with its id selected — no silent conversion.
  const legacy = namedRow(tree, 'legacy');
  assert.ok(legacy !== undefined);
  assert.ok(valuesOf(legacy).includes('old-model'), 'a legacy connection does not lose its model');
  mounted.unmount();
});

test('choosing another model saves at once as the selected model, and nothing else', async () => {
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  const row = namedRow(tree, 'multi');
  assert.ok(row !== undefined);
  const gamma = modelRadios(row).find((radio) => String(radio.props.value) === 'gamma');
  assert.ok(gamma !== undefined, 'no radio for the third model');
  fire(gamma, 'onChange', { target: { value: 'gamma' } });
  tree = await mounted.runtime.flush();

  // A selection is a decision, not typing: it saves at once, with no pause and
  // no Save press (g-069). It is still exactly one narrow write — choosing a
  // model must not rewrite the list or the other rows.
  const after = namedRow(tree, 'multi');
  assert.ok(after !== undefined);
  assert.deepEqual(
    modelRadios(after).filter((radio) => radio.props.checked === true).map((radio) => String(radio.props.value)),
    ['gamma'],
    'the selection did not move within the draft'
  );

  const saves: { ops: unknown; revision: unknown }[] = mutations;
  assert.equal(saves.length, 1, `the selection did not save at once: ${textOf(tree).slice(0, 200)}`);
  const ops = plain(saves[0]?.ops) as { op: string; path: string[]; value: unknown }[];
  const selected = ops.filter((op) => op.path.join('.') === 'systemOne.profiles.multi.selectedModel');
  assert.deepEqual(selected.map((op) => [op.op, op.value]), [['set', 'gamma']], 'the selected model was not written');
  // Nothing else about the model moved: the list is untouched, and the other
  // rows are not rewritten by this edit.
  assert.deepEqual(
    ops.filter((op) => op.path.join('.') === 'systemOne.profiles.multi.modelIds'),
    [],
    'the model list was rewritten by a selection change'
  );
  assert.deepEqual(
    ops.filter((op) => op.path[2] === 'single' || op.path[2] === 'legacy'),
    [],
    'untouched rows were rewritten'
  );
  mounted.unmount();
});

test('choosing the first listed model clears the stored selection instead of writing it', async () => {
  // The first id is the implicit selection, so writing it would store a
  // redundant field — and a later list edit would leave that field pointing at
  // an id that no longer exists.
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  const row = namedRow(tree, 'multi');
  assert.ok(row !== undefined);
  fire(modelRadios(row).find((radio) => String(radio.props.value) === 'alpha'), 'onChange', { target: { value: 'alpha' } });
  tree = await mounted.runtime.flush();

  const saves: { ops: unknown }[] = mutations;
  assert.equal(saves.length, 1);
  const ops = plain(saves[0]?.ops) as { op: string; path: string[]; value: unknown }[];
  const selected = ops.filter((op) => op.path.join('.') === 'systemOne.profiles.multi.selectedModel');
  assert.deepEqual(selected.map((op) => [op.op, op.value]), [['unset', undefined]], 'the first id must clear the field');
  mounted.unmount();
});

/**
 * The model list a row shows, as the textarea carries it.
 *
 * Read off the rendered element rather than the store, so the test measures
 * exactly what the user is looking at — the raw value, trailing partial line and
 * whitespace included.
 * @param tree - the rendered page.
 * @param name - the row's name.
 * @returns the textarea's raw value, or `''` when the row has no list field.
 */
function modelListValue(tree: unknown, name: string): string {
  const row = namedRow(tree, name);
  if (row === undefined) return '';
  return String(modelListOf(row)?.props.value ?? '');
}

/** Every write's ops, across one fixture's whole lifetime. */
function allOps(mutations: readonly { ops: unknown }[]): { op: string; path: string[]; value: unknown }[] {
  return mutations.flatMap((mutation) => plain(mutation.ops) as { op: string; path: string[]; value: unknown }[]);
}

/** The row named `name`, asserting it is on the page. */
function requireRow(tree: unknown, name: string): Element {
  const row = namedRow(tree, name);
  assert.ok(row !== undefined, `no row named ${name}`);
  return row;
}

/** The radio of `row` whose value is `id`, asserting it exists. */
function requireRadio(row: Element, id: string): Element {
  const radio = modelRadios(row).find((candidate) => String(candidate.props.value) === id);
  assert.ok(radio !== undefined, `no radio for ${id} among [${modelRadios(row).map((r) => String(r.props.value)).join(', ')}]`);
  return radio;
}

/** The ops that named one dotted path. */
function opsFor(mutations: readonly { ops: unknown }[], dotted: string): { op: string; path: string[]; value: unknown }[] {
  return allOps(mutations).filter((op) => op.path.join('.') === dotted);
}

test('re-selecting the model already in force never writes and never un-arms the list edit (g-070)', async () => {
  // The reported race, at the element a user actually touches. The user is
  // appending a model: the list is mid-edit ("alpha\nbeta\n" plus a partial
  // "gamm" with no trailing newline — the id in force, `beta`, is still listed),
  // when the current model's radio is clicked again.
  //
  // Two defects met here. `ModelSelection` reported that click as a *decision*,
  // so it saved at once; and the queue let a decision supersede the text waiting
  // behind it — after which the no-op rule dropped the combined draft, and the
  // pause that would have carried the typing had been cancelled. The characters
  // the user had just typed were gone: never written, and never written later.
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  // A half-typed list: a trailing partial line, with no trailing newline yet.
  type(modelListOf(requireRow(tree, 'multi')), 'alpha\nbeta\ngamm');
  tree = await mounted.runtime.flush();
  assert.equal(modelListValue(tree, 'multi'), 'alpha\nbeta\ngamm', 'the keystrokes are not on the page');

  // The click a user makes on the model they already run.
  const current = requireRadio(requireRow(tree, 'multi'), 'beta');
  assert.equal(current.props.checked, true, 'the fixture does not start on `beta`');
  fire(current, 'onChange', { target: { value: 'beta' } });
  tree = await mounted.runtime.flush();

  // No write was started by it, and the typed text keeps its value on the page.
  assert.deepEqual(mutations, [], 're-selecting the current model wrote to the Host');
  assert.equal(modelListValue(tree, 'multi'), 'alpha\nbeta\ngamm', 're-selecting the current model dropped the typed characters');

  // The typing's own pause still carries the edit once the list is finished, and
  // it is still what the user last typed. The finished list deliberately differs
  // from the Host's own (`gamma-2`): landing back on the authored value would be
  // indistinguishable from a lost edit, and would pass for the wrong reason.
  type(modelListOf(requireRow(tree, 'multi')), 'alpha\nbeta\ngamma-2\n');
  tree = await mounted.runtime.flush();
  // The raw value, trailing newline and all, is what the keystrokes left.
  assert.equal(modelListValue(tree, 'multi'), 'alpha\nbeta\ngamma-2\n', 'the keystrokes are not on the page');
  tree = await flushAutosave(mounted, tree);
  const lists = opsFor(mutations, 'systemOne.profiles.multi.modelIds');
  assert.deepEqual(
    lists.map((op) => [op.op, op.value]),
    [['set', ['alpha', 'beta', 'gamma-2']]],
    'the list edit never reached the Host, or reached it more than once'
  );
  // And selecting nothing new was written along with it.
  assert.deepEqual(opsFor(mutations, 'systemOne.profiles.multi.selectedModel'), [], 'the re-selection was written after all');
  mounted.unmount();
});

test('re-selecting the current model does not flush a still-typing list ahead of its pause (g-070)', async () => {
  // The same click with text that is *valid* on its own. The click must not write
  // it early either: a decision writes at once only when it is itself an edit, and
  // a re-selection is not — the pause still owns the list's timing.
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  type(modelListOf(requireRow(tree, 'multi')), 'alpha\nbeta\ngamma\ndelta');
  tree = await mounted.runtime.flush();
  fire(requireRadio(requireRow(tree, 'multi'), 'beta'), 'onChange', { target: { value: 'beta' } });
  tree = await mounted.runtime.flush();
  assert.deepEqual(mutations, [], 'a re-selection flushed the list before its pause');
  assert.equal(modelListValue(tree, 'multi'), 'alpha\nbeta\ngamma\ndelta');

  tree = await flushAutosave(mounted, tree);
  assert.deepEqual(
    opsFor(mutations, 'systemOne.profiles.multi.modelIds').map((op) => [op.op, op.value]),
    [['set', ['alpha', 'beta', 'gamma', 'delta']]],
    'the paused list edit was not written exactly once'
  );
  assert.equal(mutations.length, 1, `the re-selection caused a write of its own: ${JSON.stringify(allOps(mutations))}`);
  mounted.unmount();
});

test('a real model switch still saves at once, and keeps text typed behind it (g-070)', async () => {
  // The half of the rule that must not regress: choosing a *different* model is a
  // decision and writes at once. Its write carries the list too when the list is
  // mid-edit, because a decision flushes the burst in the same draft — and the
  // newer text must survive the answer.
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  type(modelListOf(requireRow(tree, 'multi')), 'alpha\nbeta\ngamma');
  tree = await mounted.runtime.flush();
  fire(requireRadio(requireRow(tree, 'multi'), 'gamma'), 'onChange', { target: { value: 'gamma' } });
  tree = await mounted.runtime.flush();
  tree = await flushAutosave(mounted, tree);

  // The switch landed at once, and the list went with it rather than being lost.
  assert.ok(
    opsFor(mutations, 'systemOne.profiles.multi.selectedModel').length > 0,
    'a real model switch did not save'
  );
  // The Host's own document, as the page's writes left it.
  const host = plain((form['getSnapshot'] as () => Record<string, any>)()) as Record<string, any>;
  assert.equal(host.value.systemOne.profiles.multi.selectedModel, 'gamma', 'the switch never reached the Host');
  assert.deepEqual(host.value.systemOne.profiles.multi.modelIds, ['alpha', 'beta', 'gamma'], 'the list typed before the switch was lost');
  assert.equal(modelListValue(tree, 'multi'), 'alpha\nbeta\ngamma', 'the list was rolled back after the switch');
  mounted.unmount();
});

test('a selection that is no longer in the list is refused, and the row says why', async () => {
  // Editing the list under a selection is how an unusable state arises — the
  // radio group cannot produce it, but typing can. The save must be refused,
  // with the row named, rather than written out as "select nothing".
  const { form, mutations } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({ facts: multiModelFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  const row = namedRow(tree, 'multi');
  assert.ok(row !== undefined);
  type(modelListOf(row), 'alpha\ngamma');
  tree = await mounted.runtime.flush();
  const edited = namedRow(tree, 'multi');
  assert.ok(edited !== undefined);
  const missing = elements(edited).find((element) => element.props['data-profile-model-missing'] === 'true');
  assert.ok(missing !== undefined, `the row does not explain the broken selection: ${textOf(edited)}`);
  assert.ok(textOf(missing).includes('beta'), 'the warning does not name the selected model');

  tree = await flushAutosave(mounted, tree);
  assert.deepEqual(mutations, [], 'a broken selection reached the Host');
  assert.ok(textOf(tree).includes('不在模型列表里'), `the refusal is not explained: ${textOf(tree).slice(0, 300)}`);
  mounted.unmount();
});

test('a saved connection that selects a missing model shows the unconfigured banner', async () => {
  // The Host-side snapshot is the authority: it reports the refusal, and the page
  // must render it as "nothing connects" rather than as a working connection.
  const refused = { ...facts(false), config: resolveConfig(MULTI_MODEL), profileKeys: {} } as PanelRuntimeFacts;
  const { form } = settingsForm(MULTI_MODEL);
  const mounted = await mountPanel({
    facts: {
      ...refused,
      config: {
        ...refused.config,
        systemOne: { ...refused.config.systemOne, unconfigured: 'model-selection-invalid' as const }
      }
    },
    form
  });
  openTab(mounted.tree, 'System 1 后端');
  const tree = await mounted.runtime.flush();
  const banner = elements(tree).find((element) => element.props['data-unconfigured'] === 'model-selection-invalid');
  assert.ok(banner !== undefined, 'the page does not report the refused connection');
  assert.ok(textOf(banner).includes('不在它的模型列表里'), `the banner does not explain why: ${textOf(banner)}`);
  assert.ok(textOf(banner).includes('不发出任何外部请求'), 'the banner does not state that nothing is requested');
  mounted.unmount();
});

//#endregion

//#region editing a connection name, one keystroke at a time (g-066 criterion 3)

/**
 * Type `text` into the row's name field one character at a time.
 *
 * The reported bug was exactly this loop: the first character renamed the row,
 * the field was replaced by static text, and the second character had nowhere to
 * land. Typing character by character — re-rendering between each — is the only
 * way to catch that; a single `onChange` with the whole string would pass on the
 * broken version.
 * @param mounted - the mounted page.
 * @param rowId - the row identity to type into.
 * @param text - the full name to type.
 * @returns the tree after the last keystroke.
 */
async function typeEveryCharacter(mounted: Mounted, rowId: string, text: string): Promise<unknown> {
  let tree: unknown = undefined;
  for (let length = 1; length <= text.length; length += 1) {
    tree = await mounted.runtime.flush();
    const input = nameInputOf(tree, rowId);
    assert.ok(input !== undefined, `the name field disappeared after "${text.slice(0, length - 1)}"`);
    fire(input, 'onChange', { target: { value: text.slice(0, length) } });
  }
  return mounted.runtime.flush();
}

/**
 * Assert the name control is genuinely editable.
 *
 * `fire()` drives a handler directly, so it would happily "type" into a field the
 * browser would refuse to accept — a `readOnly` (or `disabled`) name field passes
 * a value-only assertion and is the exact regression this suite exists for. The
 * mutation control caught that gap, hence this explicit check.
 * @param input - the rendered name control.
 */
function assertEditableName(input: Element): void {
  assert.equal(input.type, 'input', 'the name control must be an <input>');
  assert.notEqual(input.props.readOnly, true, 'the name field is read-only: typing would be refused');
  assert.notEqual(input.props.disabled, true, 'the name field is disabled: typing would be refused');
  assert.equal(typeof input.props.onChange, 'function', 'the name field accepts no edits');
}

/** The name input of one row, by page identity. */
function nameInputOf(tree: unknown, rowId: string): Element | undefined {
  return elements(tree).find((element) => element.props['data-profile-name'] === rowId);
}

test('typing an unsaved row name one character at a time keeps the field editable', async () => {
  const { form, mutations } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  fire(find(tree, 'button', '新增配置'), 'onClick');
  tree = await mounted.runtime.flush();

  const newRow = profileRows(tree).find((row) => String(row.props['data-profile-unnamed']) === 'true');
  assert.ok(newRow !== undefined, 'the new row is missing');
  const id = String(newRow.props['data-profile']);
  tree = await typeEveryCharacter(mounted, id, 'newapi');

  // The field is still an input, and it holds the whole name.
  const input = nameInputOf(tree, id);
  assert.ok(input !== undefined, 'the name field stopped being editable after the first character');
  assert.equal(input.props.value, 'newapi', 'a character was dropped');
  assertEditableName(input);
  // The row is no longer marked unnamed: it now has the name it was typed.
  const row = profileRows(tree).find((candidate) => String(candidate.props['data-profile']) === id);
  assert.ok(row !== undefined);
  assert.equal(row.props['data-profile-unnamed'], undefined, 'the row still reads as unnamed after being named');
  assert.ok(!textOf(row).includes('未命名'), 'the unnamed marker is still rendered');
  // Typing is a draft edit: nothing reached the Host, and nothing is saved.
  assert.deepEqual(mutations, [], 'typing a name wrote to the document');
  mounted.unmount();
});

test('renaming a saved row one character at a time works, and only a save commits it', async () => {
  const { form, mutations } = settingsForm(PROFILED);
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  const savedRow = namedRow(tree, 'primary');
  assert.ok(savedRow !== undefined, 'the saved row is missing');
  const id = String(savedRow.props['data-profile']);
  // A saved row used to render its name as text — so it could not be renamed at
  // all. It is an input now, and it takes the whole name.
  tree = await typeEveryCharacter(mounted, id, 'primary2');

  const input = nameInputOf(tree, id);
  assert.ok(input !== undefined, 'a saved row has no editable name field');
  assert.equal(input.props.value, 'primary2', 'the saved row name was not fully typed');
  assertEditableName(input);
  assert.deepEqual(mutations, [], 'typing rebuilt or wrote the document');
  // The activation followed the row while it was being typed (g-065), and is
  // still a draft: the marker is on the row, nothing is written until save.
  assert.ok(textOf(namedRow(tree, 'primary2') ?? null).includes('已激活'), 'the activation did not follow the rename');
  mounted.unmount();
});

test('a failed save keeps the typed name, so the draft is never lost', async () => {
  // The name is the one field whose loss is unrecoverable — it is the settings
  // path. A refused save (here: a read-only document) must leave it as typed.
  const { form, mutations } = settingsForm(PROFILED, { writable: false });
  const mounted = await mountPanel({ facts: profiledFacts(), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();
  const savedRow = namedRow(tree, 'secondary');
  assert.ok(savedRow !== undefined);
  const id = String(savedRow.props['data-profile']);
  tree = await typeEveryCharacter(mounted, id, 'renamed');

  assert.deepEqual(mutations, [], 'a read-only document was written');
  assert.equal(nameInputOf(tree, id)?.props.value, 'renamed', 'the refused save discarded the typed name');
  mounted.unmount();
});

//#endregion

//#region autosave: the page saves after the edit, and survives being closed (g-069)

test('the page offers no Save button, and a switch saves without one', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  // g-069: saving is not an action any more, so nothing offers it.
  assert.equal(hasButton(tree, '保存'), false, 'the page still offers a Save button');
  assert.equal(hasButton(tree, '取消'), false, 'the page offers a cancel button instead');

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 1, 'a switch did not save on its own');
  assert.ok(textOf(tree).includes('已保存'), `the save was not acknowledged: ${textOf(tree).slice(0, 200)}`);
  mounted.unmount();
});

test('typing shows "saves when you pause", then writes once', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  type(inputElement(tree, '工具名前缀'), 'rv_');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 0, 'a keystroke wrote before the pause');
  assert.ok(textOf(tree).includes('输入停顿后自动保存'), `the waiting state is not shown: ${textOf(tree).slice(0, 200)}`);

  tree = await flushAutosave(mounted, tree);
  assert.equal(mutations.length, 1, 'the paused typing was never written');
  assert.ok(textOf(tree).includes('已保存'), 'the save was not acknowledged');
  mounted.unmount();
});

test('closing the dialog mid-typing still writes what was typed', async () => {
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  type(inputElement(tree, '工具名前缀'), 'rv_closed');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 0, 'the keystroke wrote before the pause');

  // Closing the settings dialog: the shell unmounts the page (no interception
  // point exists, which is why this feature exists at all).
  mounted.unmount();
  await settle();
  await settle();
  assert.equal(mutations.length, 1, 'closing the dialog dropped the pending write');
  const write = plain(mutations[0]?.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.ok(
    write.some((op) => op.path.join('.') === 'toolPrefix' && (op.value as unknown) === 'rv_closed'),
    `the write that survived the close is not the typed one: ${JSON.stringify(write).slice(0, 300)}`
  );
});

test('a reopened page in the same client starts from the Host, not from a stale page', async () => {
  // What the *page* guarantees on a reopen: a fresh mount renders the Host's
  // document (nothing left over from the page that was closed), and it offers no
  // trace of the previous page's status line. The draft a failed write keeps
  // across the close is carried by the client's autosave owner and proved at the
  // store level (`client-autosave.test.ts`), where the timing is deterministic.
  const settings = settingsForm(AUTHORED);
  const gate = settings.hold();
  const first = await mountPanel({ facts: facts(true), form: settings.form });
  openTab(first.tree, '虚拟 Provider');
  let tree = await first.runtime.flush();
  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await first.runtime.flush();
  gate.reject(new Error('settings host went away'));
  for (let pass = 0; pass < 3; pass += 1) tree = await first.runtime.flush();
  assert.ok(textOf(tree).includes('自动保存失败'), 'the first page did not report the failure');
  first.unmount();
  await settle();

  const second = await mountPanel({ facts: facts(true), form: settings.form, client: first.client });
  const reopened = second.current();
  // A page that just opened has nothing of its own to report: no stale "saved"
  // and no stale failure banner describing an action this page did not take.
  assert.equal(second.current().includes('自动保存失败'), false, `a fresh page carried the old failure banner: ${reopened.slice(0, 200)}`);
  openTab(second.tree, '虚拟 Provider');
  for (let pass = 0; pass < 4; pass += 1) await second.runtime.flush();
  assert.equal(settings.mutations.length, 1, 'reopening wrote to the Host on its own');
  assert.equal(hasButton(second.tree, '保存'), false, 'the reopened page offers a Save button again');
  second.unmount();
});

test('a failed save says why, keeps the edit, and offers retry and discard', async () => {
  const settings = settingsForm(AUTHORED);
  const { form, mutations } = settings;
  const gate = settings.hold();
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  gate.reject(new Error('settings host is down'));
  for (let pass = 0; pass < 3; pass += 1) tree = await mounted.runtime.flush();

  const text = textOf(tree);
  assert.ok(text.includes('自动保存失败'), `the failure is not reported: ${text.slice(0, 240)}`);
  assert.ok(text.includes('settings host is down'), 'the failure does not say why');
  assert.equal(hasButton(tree, '重试保存'), true, 'the failure offers no retry');
  assert.equal(hasButton(tree, '放弃改动'), true, 'the failure offers no way out');
  // The edit is still on the page, not rolled back to what the Host holds.
  assert.equal(checkboxOf(tree, '虚拟 Provider').props.checked, false, 'the failed edit was rolled back');

  // The retry goes out through the same write path.
  clickButton(tree, '重试保存');
  for (let pass = 0; pass < 3; pass += 1) tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 2, 'the retry did not write');
  assert.ok(textOf(tree).includes('已保存'), 'a successful retry is not acknowledged');
  mounted.unmount();
});

test('typing then a switch: the switch flushes the waiting text in one write, naming both', async () => {
  // The page-level contract for the ordering that lost a decision in review: a
  // switch (a decision) pressed while typing has not paused yet carries that
  // typing in the same write — and that write names the two fields the user
  // touched, nothing else.
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, 'System 1 后端');
  let tree = await mounted.runtime.flush();

  type(inputElement(tree, '工具名前缀'), 'rv_then_switch');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 0, 'a keystroke wrote before its pause');

  // The switch lives on another tab; switching tabs is not an edit, and the
  // pending text must survive it.
  openTab(mounted.tree, '虚拟 Provider');
  tree = await mounted.runtime.flush();
  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();

  assert.equal(mutations.length, 1, 'the switch did not write, or wrote twice');
  const ops = plain(mutations[0]?.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.deepEqual(
    writtenPaths(mutations[0]).sort(),
    ['routing', 'toolPrefix'],
    'the write did not name exactly the fields the user touched'
  );
  assert.ok(
    ops.some((op) => op.path.join('.') === 'toolPrefix' && op.value === 'rv_then_switch'),
    'the switch dropped the typed text it flushed'
  );
  mounted.unmount();
});

test('a switch pressed before any typing writes alone, and the typing follows its own pause', async () => {
  // The other ordering: the decision is not delayed by a pause it does not have,
  // and the typing after it reaches the Host at its own pause.
  const { form, mutations } = settingsForm(AUTHORED);
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 1, 'the switch did not write at once');
  assert.deepEqual(writtenPaths(mutations[0]), ['routing'], 'the switch wrote a field the user had not touched');

  openTab(mounted.tree, 'System 1 后端');
  tree = await mounted.runtime.flush();
  type(inputElement(tree, '工具名前缀'), 'rv_after_switch');
  tree = await mounted.runtime.flush();
  assert.equal(mutations.length, 1, 'the typing wrote before its pause');

  tree = await flushAutosave(mounted, tree);
  assert.equal(mutations.length, 2, 'the typing after the switch was never written');
  assert.deepEqual(writtenPaths(mutations[1]), ['toolPrefix'], 'the typing wrote a field other than the one typed');
  mounted.unmount();
});

test('a long failure reason is shortened in the status line, and kept whole in its tooltip', async () => {
  // The Host's own message reaches the page unbounded; the status line must stay a
  // line. The full text is available on hover rather than thrown away silently.
  const settings = settingsForm(AUTHORED);
  const { form } = settings;
  const gate = settings.hold();
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  const long = `host exploded: ${'y'.repeat(500)}`;
  gate.reject(new Error(long));
  for (let pass = 0; pass < 3; pass += 1) tree = await mounted.runtime.flush();

  const text = textOf(tree);
  assert.ok(text.includes('自动保存失败'), 'the failure is not reported');
  assert.equal(text.includes(long), false, 'the status line drew the whole Host message');
  // The whole reason survives as the hover text on the shortened line.
  const titled = elements(tree).find((element) => element.props['title'] === long);
  assert.ok(titled !== undefined, 'the full reason is not kept for the tooltip');
  mounted.unmount();
});

test('discarding a kept draft goes back to what the Host holds', async () => {
  const settings = settingsForm(AUTHORED);
  const { form, mutations } = settings;
  const gate = settings.hold();
  const mounted = await mountPanel({ facts: facts(true), form });
  openTab(mounted.tree, '虚拟 Provider');
  let tree = await mounted.runtime.flush();

  fire(checkboxOf(tree, '虚拟 Provider'), 'onChange', { target: { checked: false } });
  tree = await mounted.runtime.flush();
  gate.reject(new Error('nope'));
  for (let pass = 0; pass < 3; pass += 1) tree = await mounted.runtime.flush();
  assert.equal(checkboxOf(tree, '虚拟 Provider').props.checked, false, 'the draft is not the failed one');

  clickButton(tree, '放弃改动');
  tree = await mounted.runtime.flush();
  assert.equal(checkboxOf(tree, '虚拟 Provider').props.checked, true, 'discarding kept the failed edit');
  assert.equal(hasButton(tree, '重试保存'), false, 'discarding left the failure banner up');
  assert.equal(mutations.length, 1, 'discarding wrote to the Host');
  mounted.unmount();
});

//#endregion
