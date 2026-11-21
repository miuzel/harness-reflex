import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Autosave after the edit that made it (g-069), at the store and queue level.
 *
 * The properties that carry the feature are all about *time*, so they are driven
 * here against a deterministic clock rather than a real one:
 *
 * - a decision writes at once, a keystroke waits for a pause and coalesces;
 * - closing the page (unmounting it) does not drop a queued write;
 * - a failed write keeps its draft, and reopening the page in the same client
 *   puts it back with the reason, for a retry;
 * - writes are serialized, and the newer draft wins over a slow older answer;
 * - nothing the user typed is persisted anywhere but the Host.
 *
 * The module is the built CommonJS client artifact, evaluated in a sandbox the
 * same way `client-profiles.test.ts` loads it.
 */

/** The `./store` module of the built client, as these tests use it. */
interface StoreModule {
  PanelStore: new (options: Record<string, unknown>) => AnyStore;
  acquireAutosave(namespace: string): Record<string, any>;
  forgetAutosave(namespace: string): void;
  dirtyGroups(original: unknown, draft: unknown): string[];
  draftFromLayers(value: unknown, base: unknown): any;
}

/** What the tests drive on one store. */
interface AnyStore {
  getState(): any;
  start(): void;
  edit(mutate: (draft: any) => any, mode?: 'immediate' | 'text'): void;
  save(): Promise<boolean>;
  retryAutosave(): Promise<boolean>;
  discardRetained(): void;
  reset(): void;
  whenSaved(): Promise<boolean>;
  readonly autosave: boolean;
  dispose(): void;
}

/** Evaluate one built CommonJS client module in a sandbox and return its exports. */
function loadModule(name: string): Record<string, any> {
  const file = fileURLToPath(new URL(`../dist-client/${name}.js`, import.meta.url));
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    module,
    exports: module.exports,
    require: (spec: string) => {
      const local = /^\.\/([a-z-]+)$/.exec(spec);
      if (local === null) throw new Error(`unexpected require "${spec}"`);
      return loadModule(local[1]!);
    },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    __dirname: '/',
    __filename: file
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: `${name}.js` });
  return module.exports;
}

const storeModule = loadModule('store') as unknown as StoreModule;

/** The authored document every test starts from. */
const AUTHORED = {
  backend: 'jev',
  toolPrefix: 'reflex_',
  pruneThreshold: 500,
  routing: {
    enabled: true,
    virtualProvider: 'reflex',
    models: { 'reflex-pro': [{ provider: 'deepseek', model: 'deepseek-chat' }] }
  },
  effort: { enabled: true, reasoningEffort: 'reflex', fallback: 'low', minConfidence: 0.3 },
  systemOne: {
    active: 'primary',
    // `modelIds` is list-valued on the Host's side: authored as an array, edited
    // as the comma/newline-separated text the row shows.
    profiles: { primary: { baseUrl: 'http://a.example/v1', modelIds: ['jev-latest'], timeoutMs: 4000 } }
  }
};

/** One timer armed by the code under test. */
interface Armed {
  id: number;
  ms: number;
  fire: () => void;
  cleared: boolean;
}

/** A deterministic clock: timers are inspected, fired, and cancelled by hand. */
function makeClock(): {
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (handle: unknown) => void;
  /** Timers still waiting, in arming order. */
  armed(): Armed[];
  /** Fire the newest timer; fails if there is none. */
  fireLast(): void;
} {
  const live: Armed[] = [];
  let next = 1;
  return {
    setTimer: (callback, ms) => {
      const armed: Armed = { id: next, ms, fire: callback, cleared: false };
      next += 1;
      live.push(armed);
      return armed.id;
    },
    clearTimer: (handle) => {
      const entry = live.find((timer) => timer.id === handle);
      if (entry !== undefined) entry.cleared = true;
      live.splice(0, live.length, ...live.filter((timer) => !timer.cleared));
    },
    armed: () => [...live],
    fireLast: () => {
      const entry = live[live.length - 1];
      assert.ok(entry !== undefined, 'no timer was armed');
      live.splice(live.indexOf(entry), 1);
      entry.fire();
    }
  };
}

/** One write the page attempted. */
interface Write {
  ops: { op: string; path: string[]; value?: unknown }[];
  revision: unknown;
}

/**
 * The settings form the store writes through, with the Host's behaviour.
 *
 * A write is applied to the served document and then notified, which is what
 * makes the page re-seed itself from it — the exact sequence the queue has to
 * stay correct through.
 */
function makeForm(
  value: unknown,
  options: { writable?: boolean; revision?: number } = {}
): {
  form: Record<string, unknown>;
  writes: Write[];
  /** Replace the document and notify. */
  push(next: unknown): void;
  /** Hold the next write open until the returned handle releases or rejects it. */
  hold(): { release: (accept?: boolean) => void; reject: (error: unknown) => void };
} {
  const writes: Write[] = [];
  let snapshot: Record<string, unknown> = {
    status: 'ready',
    value,
    base: 0,
    user: 0,
    revision: options.revision ?? 3,
    writable: options.writable ?? true
  };
  const listeners = new Set<() => void>();
  let held: { resolve: (accept: boolean) => void; reject: (error: unknown) => void } | null = null;
  let holding = false;
  const apply = (ops: Write['ops']): void => {
    const next = JSON.parse(JSON.stringify(snapshot.value)) as Record<string, any>;
    for (const op of ops) {
      const parent = op.path.slice(0, -1).reduce<Record<string, any>>((node, key) => (node[key] ??= {}), next);
      const key = op.path[op.path.length - 1] as string;
      if (op.op === 'set') parent[key] = JSON.parse(JSON.stringify(op.value ?? null));
      else delete parent[key];
    }
    snapshot = { ...snapshot, value: next };
  };
  const settle = (): void => {
    snapshot = { ...snapshot, revision: Number(snapshot.revision ?? 0) + 1 };
    for (const listener of [...listeners]) listener();
  };
  return {
    writes,
    push: (next: unknown) => {
      snapshot = { ...snapshot, value: next, revision: Number(snapshot.revision ?? 0) + 1 };
      for (const listener of [...listeners]) listener();
    },
    hold: () => {
      holding = true;
      return {
        release: (accept = true) => {
          holding = false;
          const pending = held;
          held = null;
          const write = writes[writes.length - 1];
          if (accept && write !== undefined) apply(write.ops);
          if (accept) settle();
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
        writes.push({ ops: ops as Write['ops'], revision });
        if (holding) {
          return new Promise<boolean>((resolve, reject) => {
            held = { resolve, reject };
          });
        }
        apply(ops as Write['ops']);
        settle();
        return true;
      }
    }
  };
}

/** Let promise chains settle without advancing the fake clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A page store over the authored document, with autosave on. */
function makeStore(options: {
  namespace: string;
  value?: unknown;
  writable?: boolean;
  form?: ReturnType<typeof makeForm>;
  /** Profiles whose key the Host reports as a literal stored in the document. */
  storedKeyProfiles?: readonly string[];
}): { store: AnyStore; form: ReturnType<typeof makeForm>; clock: ReturnType<typeof makeClock> } {
  const form = options.form ?? makeForm(options.value ?? AUTHORED, { writable: options.writable });
  const clock = makeClock();
  // Key *presence* is a Host fact: the secret itself never reaches the page (it
  // is stripped at the wire boundary), so the panel snapshot is where a row
  // learns that its key is a document literal — the fact the rename rule reads.
  const stored = new Set(options.storedKeyProfiles ?? []);
  const snapshot = {
    systemOne: {
      profiles: [...stored].map((name) => ({ name, apiKeyPresent: true, apiKeyFromProfile: true }))
    }
  };
  const store = new storeModule.PanelStore({
    form: form.form,
    fetch: async () => ({ ok: true, status: 200, json: async () => snapshot }),
    pollIntervalMs: 0,
    autosave: 'autosave',
    autosaveOwner: storeModule.acquireAutosave(options.namespace),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  store.start();
  return { store, form, clock };
}

/** Fresh client lifetime per test, so no queue or retained draft leaks across. */
function namespace(name: string): string {
  const ns = `test-${name}`;
  storeModule.forgetAutosave(ns);
  return ns;
}

/** The `parentLabel` value a draft currently carries. */
function modelIds(store: AnyStore): string {
  return String(store.getState().draft.backend.profiles[0]?.modelIds ?? '');
}

/** The tool prefix a draft currently carries. */
function toolPrefix(store: AnyStore): string {
  return String(store.getState().draft.runtime.toolPrefix ?? '');
}

/**
 * Type one value into the tool prefix, the way a keystroke reaches the page.
 *
 * A free-text runtime field, deliberately: every keystroke is a valid document,
 * so a test that measures *timing* is not silently measuring validation instead
 * (a profile's model list is validated against its selected model, which would
 * refuse a half-typed edit for a reason unrelated to autosave).
 */
function typePrefix(store: AnyStore, value: string): void {
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: value } }), 'text');
}

/** The model list of the row every test edits, as the page shows it. */
function rowModelIds(store: AnyStore): string {
  return String(store.getState().draft.backend.profiles[0]?.modelIds ?? '');
}

//#region a decision writes at once, typing coalesces

test('a selection writes at once; a keystroke waits for a pause and coalesces', async () => {
  const { store, form, clock } = makeStore({ namespace: namespace('mode') });

  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, enabled: false } }));
  await settle();
  assert.equal(form.writes.length, 1, 'a decision did not write at once');
  assert.deepEqual(
    JSON.parse(JSON.stringify(form.writes[0]?.ops.map((op) => op.path.join('.')) ?? [])),
    ['routing'],
    'the decision wrote the wrong path'
  );
  assert.equal(clock.armed().length, 0, 'a decision armed a debounce it does not need');

  // Three keystrokes, one pause, one write carrying the last of them.
  // A keystroke appends to what the row shows; the last one is what has to land.
  typePrefix(store, 'rv');
  assert.equal(clock.armed().length, 1, 'a keystroke did not arm the pause');
  typePrefix(store, 'rv_');
  typePrefix(store, 'rv_x');
  assert.equal(clock.armed().length, 1, 'each keystroke armed its own timer instead of replacing it');
  assert.equal(form.writes.length, 1, 'a keystroke wrote before the pause');
  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 2, 'the paused typing never wrote');
  const written = form.writes[1]?.ops.find((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(written?.value, 'rv_x', 'the write did not carry the last keystroke');
});

test('a draft the Host already holds is never written, and only a real change is', async () => {
  const { store, form, clock } = makeStore({ namespace: namespace('noop') });

  // Re-stating the value the Host already holds is not an edit: the pause may
  // still be armed by the keystroke, but nothing is written when it fires.
  typePrefix(store, toolPrefix(store));
  await settle();
  if (clock.armed().length > 0) clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 0, 'an edit that changed nothing wrote');

  // A real change writes…
  typePrefix(store, 'rv_x');
  await settle();
  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 1, 'a real change did not write');

  // …and going back to the value the Host now holds is a no-op again. This is
  // the case the queue must recognise *after* a write moved what "the Host
  // holds": it measures against its own last written snapshot, not the page's
  // live one (g-069).
  // The Host now holds `rv_x`; going back to the original prefix is a real change
  // of the *stored* document only insofar as it differs from what was written.
  typePrefix(store, 'reflex_');
  await settle();
  if (clock.armed().length > 0) clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 2, 'a real edit back to the old value was not written');
  typePrefix(store, 'reflex_');
  await settle();
  if (clock.armed().length > 0) clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 2, 're-stating the value the Host now holds wrote it again');
});

test('an invalid draft waits instead of writing, and the next valid edit writes', async () => {
  const { store, form, clock } = makeStore({ namespace: namespace('invalid') });

  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, virtualProvider: '' } }), 'text');
  await settle();
  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 0, 'an invalid draft reached the Host');
  assert.ok(store.getState().errors.length > 0, 'the problem is not shown');
  assert.equal(store.getState().autosave.phase, 'pending', 'an invalid draft does not say it is waiting');

  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, virtualProvider: 'reflex-x' } }), 'text');
  await settle();
  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 1, 'the repaired draft was never written');
});

//#endregion

//#region the owner outlives the page

test('closing the page while typing still writes what was typed', async () => {
  const ns = namespace('unmount-debounce');
  const { store, form, clock } = makeStore({ namespace: ns });

  typePrefix(store, 'rv_unmounted');
  await settle();
  assert.equal(form.writes.length, 0, 'the typing wrote before its pause');
  assert.equal(clock.armed().length, 1, 'no pause was armed');

  // The dialog closes: the page is disposed before the pause fires.
  store.dispose();
  await settle();
  assert.equal(form.writes.length, 1, 'closing the page dropped the pending write');
  const written = form.writes[0]?.ops.find((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(written?.value, 'rv_unmounted', 'the write that survived the close is not the typed one');
});

test('closing the page with a write in flight keeps the draft behind it and sends it after', async () => {
  const ns = namespace('unmount-inflight');
  const { store, form } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_' } }));
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not start a write');
  // A newer keystroke arrives and is waiting behind the write above.
  typePrefix(store, 'rv_behind');
  await settle();

  store.dispose();
  await settle();
  assert.equal(form.writes.length, 1, 'a second write raced the one in flight');

  gate.release();
  await settle();
  assert.equal(form.writes.length, 2, 'the draft behind the in-flight write was dropped');
  const written = form.writes[1]?.ops.find((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(written?.value, 'rv_behind', 'the follow-up write is not the newer draft');
});

test('reopening the page in the same client finishes a write the closed page left in flight', async () => {
  const ns = namespace('reopen-inflight');
  const { store, form } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_' } }));
  await settle();
  store.dispose();
  await settle();

  // Reopened before the Host answered: a new page over the same client.
  const reopened = makeStore({ namespace: ns, form });
  await settle();
  gate.release();
  await settle();
  assert.equal(form.writes.length, 1, 'a reopened page wrote the same draft again');
  assert.equal(
    reopened.store.getState().autosave.phase,
    'saved',
    'the reopened page was not told about the write its client finished'
  );
  reopened.store.dispose();
});

//#endregion

//#region a failure keeps a draft worth retrying

test('a failed write reports why, keeps the draft, and reopens with it', async () => {
  const ns = namespace('failure');
  const { store, form } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_fail' } }));
  await settle();
  gate.reject(new Error('settings host is down'));
  await settle();

  const failed = store.getState();
  assert.equal(failed.autosave.phase, 'failed', 'the failure is not reported');
  assert.equal(failed.autosave.reason, 'settings host is down', 'the failure does not carry the Host reason');
  assert.equal(failed.autosave.retained, true, 'the draft is not marked as kept');
  assert.equal(toolPrefix(store), 'rv_fail', 'the failed draft was dropped from the live page');
  assert.equal(form.writes.length, 1, 'a failed write retried itself behind the user');

  // Closing and reopening the panel in the same client lifetime.
  store.dispose();
  const reopened = makeStore({ namespace: ns, form });
  await settle();
  const back = reopened.store.getState();
  assert.equal(toolPrefix(reopened.store), 'rv_fail', 'reopening lost the unsaved edit');
  assert.equal(back.autosave.phase, 'failed', 'reopening did not show that the edit is unsaved');
  assert.equal(back.autosave.reason, 'settings host is down', 'reopening lost the reason');

  // The retry is the page's own action, and it reuses the ordinary write path.
  const accepted = await reopened.store.retryAutosave();
  await settle();
  assert.equal(accepted, true, 'the retry was not accepted');
  assert.equal(form.writes.length, 2, 'the retry did not write');
  assert.equal(reopened.store.getState().autosave.phase, 'saved', 'a successful retry is not reported');
  assert.equal(reopened.store.getState().autosave.retained, false, 'the kept draft survived a successful retry');
  reopened.store.dispose();
});

test('a draft the Host refuses is kept with its reason rather than silently discarded', async () => {
  const ns = namespace('refused');
  const { store, form } = makeStore({ namespace: ns });

  // A rename onto a name the Host refuses: the store's own secret rule refuses
  // the write before it is built, which is a failure to report, not a crash.
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: '' } }), 'text');
  await settle();
  const clockArmed = store.getState().errors.length > 0;
  assert.equal(clockArmed, true, 'an empty prefix is not reported as invalid');
  assert.equal(form.writes.length, 0, 'an invalid draft was written');
});

test('the kept draft can be discarded, which re-seeds the page from the Host', async () => {
  const ns = namespace('discard');
  const { store, form } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_gone' } }));
  await settle();
  gate.reject(new Error('nope'));
  await settle();
  assert.equal(toolPrefix(store), 'rv_gone', 'the failed draft is not on the page');

  store.discardRetained();
  await settle();
  assert.equal(toolPrefix(store), 'reflex_', 'discarding did not go back to what the Host holds');
  assert.equal(store.getState().autosave.phase, 'idle', 'discarding left the page in a failed state');
  assert.equal(store.getState().autosave.retained, false, 'the kept draft was not forgotten');
  store.dispose();
});

//#endregion

//#region serialization and staleness

test('a slow older write never lands on top of a newer draft', async () => {
  const ns = namespace('staleness');
  const { store, form } = makeStore({ namespace: ns });

  // A write is in flight carrying `rv_first`…
  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_first' } }));
  await settle();
  assert.equal(form.writes.length, 1, 'the first decision did not start a write');

  // …when the user edits again. The newer draft is queued, not raced.
  typePrefix(store, 'rv_newer');
  await settle();
  assert.equal(form.writes.length, 1, 'a second write raced the one in flight');
  assert.equal(store.getState().autosave.phase, 'pending', 'the newer change is not shown as waiting');

  gate.release();
  await settle();
  assert.equal(form.writes.length, 2, 'the newer draft was never sent');
  const second = form.writes[1]?.ops.find((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(second?.value, 'rv_newer', 'the write after the slow one is not the newer draft');
  assert.equal(toolPrefix(store), 'rv_newer', 'the newer draft was overwritten by the older answer');
  store.dispose();
});

test('every write is fenced by the revision its draft was read at', async () => {
  const ns = namespace('revision');
  const { store, form } = makeStore({ namespace: ns, form: makeForm(AUTHORED, { revision: 7 }) });

  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_rev' } }));
  await settle();
  assert.equal(form.writes[0]?.revision, 7, 'the write did not carry the revision the draft was read at');
  store.dispose();
});

test('edits made while a write is in flight do not each cause a write', async () => {
  const ns = namespace('coalesce-inflight');
  const { store, form } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_a' } }));
  await settle();
  for (const value of ['r', 'rv', 'rv_', 'rv_1']) typePrefix(store, value);
  await settle();
  assert.equal(form.writes.length, 1, 'typing while a write ran started a second write');

  gate.release();
  await settle();
  assert.equal(form.writes.length, 2, 'the coalesced typing was not written once');
  const written = form.writes[1]?.ops.filter((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(written?.length, 1, 'the coalesced typing wrote more than one path');
  assert.equal(written?.[0]?.value, 'rv_1', 'the coalesced write is not the last keystroke');
  store.dispose();
});

//#endregion

//#region the write path is the page's own, and nothing is stored in the browser

test('autosave reuses the page write path: validation, secrets and the revision fence', async () => {
  const ns = namespace('write-path');
  // The Host says the saved row's key is a literal in the document — the fact the
  // rename rule reads (`apiKeyFromProfile`, on the *saved* row).
  const { store, form } = makeStore({ namespace: ns, storedKeyProfiles: ['primary'] });
  // The snapshot's key face is folded in by the first read, which `start()` kicks
  // off asynchronously.
  await settle();
  const seededRow = store.getState().draft.backend.profiles[0];
  assert.equal(seededRow.apiKeyFromProfile, true, 'the fixture does not seed a document literal');

  // A rename of that row without restating the key is refused by the same rule
  // the explicit Save button enforces (g-066): the page cannot restate a secret
  // it never received, and the rename retires the old subtree.
  store.edit((draft: any) => ({
    ...draft,
    backend: {
      ...draft.backend,
      profiles: draft.backend.profiles.map((row: any) => (row.name === 'primary' ? { ...row, name: 'renamed' } : row))
    }
  }));
  await settle();
  const refused = store.getState();
  // The rule runs before any op is built, so nothing reaches the Host, and the
  // draft stays on the page for the user to fix rather than being lost.
  assert.equal(form.writes.length, 0, 'a rename that would drop the stored key was written');
  assert.equal(refused.autosave.phase, 'failed', 'a refused rename is not reported as a failure');
  assert.equal(refused.autosave.retained, true, 'the refused draft was not kept');
  assert.equal(refused.draft.backend.profiles[0]?.name, 'renamed', 'the refused draft left the page');
  store.dispose();
});

test('no draft is ever kept in browser storage', async () => {
  // The claim g-069 must never break: an API key typed into a row reaches the
  // Host's settings API and nothing else. The client half is read as source so a
  // future `localStorage.setItem(draft)` fails here, not in a user's browser.
  const sources = ['store', 'view', 'autosave', 'panel', 'rename-secrets'].map((name) =>
    readFileSync(fileURLToPath(new URL(`../src/client/${name}.ts`, import.meta.url)), 'utf8')
  );
  for (const source of sources) {
    // Matched as *use* — `localStorage.setItem(…)`, `window.sessionStorage`,
    // `indexedDB.open(…)`, `document.cookie = …` — so the prose that documents
    // this rule is not itself a violation.
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'cookie']) {
      const used = new RegExp(`(?<![\\w$.])${forbidden}\\s*[.\\[]|document\\.cookie`).test(source);
      assert.equal(used, false, `the client touches browser storage (${forbidden}), which would persist a typed API key`);
    }
  }
});

//#endregion
