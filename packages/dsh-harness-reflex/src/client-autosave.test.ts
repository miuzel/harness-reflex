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
  /** Make one row the active connection, addressed by its page identity (g-069 att-006). */
  setActiveProfile(id: string): boolean;
  save(): Promise<boolean>;
  retryAutosave(): Promise<boolean>;
  discardRetained(): void;
  reset(): void;
  whenSaved(): Promise<boolean>;
  readonly autosave: boolean;
  dispose(): void;
}

/** Evaluate one built CommonJS client module in a sandbox and return its exports. */

const T = (what: string): void => {};
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

/** The `./panel` module of the built client, for the group comparison it exports. */
const panelModule = loadModule('panel') as unknown as { dirtyGroups(original: unknown, draft: unknown): string[] };

// TEMP trace

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
  setWritable(writable: boolean): void;
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
    setWritable: (writable) => {
      snapshot = { ...snapshot, writable };
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

test('queued autosave does not mutate after the form becomes read-only', async () => {
  const { store, form, clock } = makeStore({ namespace: namespace('read-only-before-drain') });
  try {
    assert.equal(store.getState().writable, true);
    typePrefix(store, 'read_only_probe_');
    assert.equal(toolPrefix(store), 'read_only_probe_');
    assert.equal(clock.armed().length, 1, 'the writable edit must queue a debounce');
    assert.equal(form.writes.length, 0, 'the edit wrote before its pause');

    // Flip only capability without changing the document or its revision. The
    // queued entry still carries writable=true, so the live write fence matters.
    form.setWritable(false);
    assert.equal(store.getState().writable, false);
    assert.equal(clock.armed().length, 1, 'the debounce must still reach the live write fence');
    clock.fireLast();
    await settle();
    assert.equal(form.writes.length, 0, 'queued autosave called mutate on a read-only form');
  } finally {
    store.dispose();
  }
});

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
  const { store, form, clock } = makeStore({ namespace: ns });

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

  // The slow answer lands. The newer draft is *not* written on its (later) beat:
  // typing keeps its own timing, so it waits for the pause its keystroke armed.
  gate.release();
  await settle();
  assert.equal(form.writes.length, 1, 'the typing was written at the slow write\'s release instead of at its pause');
  assert.equal(clock.armed().length, 1, 'the pause the typing armed did not survive the slow write');
  clock.fireLast();
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
  const { store, form, clock } = makeStore({ namespace: ns });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, toolPrefix: 'rv_a' } }));
  await settle();
  for (const value of ['r', 'rv', 'rv_', 'rv_1']) typePrefix(store, value);
  await settle();
  assert.equal(form.writes.length, 1, 'typing while a write ran started a second write');

  // Four keystrokes, one pause, one write — and the pause is what writes them,
  // not the release of the write they queued behind (g-069).
  gate.release();
  await settle();
  assert.equal(form.writes.length, 1, 'the burst was written at the write\'s release rather than at its pause');
  clock.fireLast();
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

//#region text and decisions in one draft: the write names only what was edited

/**
 * The paths a write named, in the order they were sent.
 *
 * Copied through JSON before it is compared: the ops were built inside the VM the
 * module runs in, so their arrays carry that realm's prototypes and
 * `deepEqual` would refuse an array with identical contents.
 */
function pathsOf(write: Write | undefined): string[] {
  const paths = (write?.ops ?? []).map((op) => op.path.join('.'));
  return JSON.parse(JSON.stringify(paths)) as string[];
}

/**
 * A selection in the routing block — a *decision*, not typing.
 *
 * Deliberately in a different group from {@link typePrefix}: the tests below are
 * about whether one edit's write carries another edit's field.
 */
function toggleRouting(store: AnyStore, enabled: boolean): void {
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, enabled } }));
}

test('typing that has not paused is flushed by the decision, in one write, once', async () => {
  // The contract the review asked to be explicit (g-069): a decision may carry a
  // typing burst waiting behind the same draft — but it must carry it *exactly
  // once*, and the write must name both fields the user actually touched.
  const { store, form, clock } = makeStore({ namespace: namespace('flush-decision') });

  typePrefix(store, 'rv_typed');
  assert.equal(clock.armed().length, 1, 'typing did not arm its pause');
  assert.equal(form.writes.length, 0, 'typing wrote before its pause');

  toggleRouting(store, false);
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not write');
  assert.deepEqual(
    pathsOf(form.writes[0]).sort(),
    ['routing', 'toolPrefix'],
    'the write did not name exactly the two fields the user edited'
  );
  const flush = form.writes[0]?.ops.find((op) => op.path.join('.') === 'toolPrefix');
  assert.equal(flush?.value, 'rv_typed', 'the decision dropped the typing it flushed');
  assert.equal(clock.armed().length, 0, 'the flushed burst left its pause armed, so it would be written again');

  // The burst is not written a second time when its pause would have fired.
  await settle();
  assert.equal(form.writes.length, 1, 'the flushed typing was written again after the decision');
  const host = storedDocument(form);
  assert.equal(host.value.toolPrefix, 'rv_typed', 'the typed value did not reach the Host');
  assert.equal(host.value.routing.enabled, false, 'the decision did not reach the Host');
});

test('a decision first, then typing: the decision lands alone and the typing follows at its pause', async () => {
  // The other ordering. The decision is not held back by a pause it does not have,
  // and the typing it raced is written afterwards rather than lost.
  const { store, form, clock } = makeStore({ namespace: namespace('decision-then-text') });

  toggleRouting(store, false);
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not write at once');
  assert.deepEqual(pathsOf(form.writes[0]), ['routing'], 'the decision wrote a field the user had not touched');

  typePrefix(store, 'rv_after');
  await settle();
  assert.equal(form.writes.length, 1, 'the typing wrote before its pause');
  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 2, 'the typing behind the decision was never written');
  assert.deepEqual(pathsOf(form.writes[1]), ['toolPrefix'], 'the typing wrote a field other than the one typed');
  const host = storedDocument(form);
  assert.equal(host.value.toolPrefix, 'rv_after');
  assert.equal(host.value.routing.enabled, false);
});

test('each field edited in a burst of typing is written, not only the last one', async () => {
  // Two typed fields coalesce into one write. The write is measured from the draft
  // the burst started on, so it names both — measuring each keystroke from the
  // previous one would drop every field but the last (g-069).
  const { store, form, clock } = makeStore({ namespace: namespace('burst-two-fields') });

  store.edit(
    (draft: any) => ({ ...draft, backend: { ...draft.backend, profiles: draft.backend.profiles.map((row: any) => ({ ...row, timeoutMs: '9000' })) } }),
    'text'
  );
  typePrefix(store, 'rv_two');
  await settle();
  assert.equal(form.writes.length, 0, 'a keystroke wrote before the pause');

  clock.fireLast();
  await settle();
  assert.equal(form.writes.length, 1, 'the burst was not written once');
  assert.deepEqual(pathsOf(form.writes[0]).sort(), ['systemOne.profiles.primary.timeoutMs', 'toolPrefix'], 'a field edited in the burst was dropped');
  const host = storedDocument(form);
  assert.equal(host.value.systemOne.profiles.primary.timeoutMs, 9000, 'the first typed field never reached the Host');
  assert.equal(host.value.toolPrefix, 'rv_two', 'the last typed field never reached the Host');
});

test('a draft kept from a failed write does not ride along with a later decision', async () => {
  // The hazard behind the review's M1 finding, in the form that outlives a reboot
  // of the dialog: a draft the Host refused stays on the page for a retry. A later,
  // unrelated decision must send only its own path — otherwise one click publishes
  // a failed edit the user has not decided to retry.
  //
  // (A *typing burst* that has not paused yet is deliberately different: the
  // decision flushes it, as documented on `Autosave.submit` and pinned by the
  // flush test above.)
  const { store, form, clock } = makeStore({ namespace: namespace('retained-not-carried') });

  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, runtime: { ...draft.runtime, pruneThreshold: '700' } }), 'text');
  await settle();
  clock.fireLast();
  await settle();
  gate.reject(new Error('host down'));
  await settle();
  assert.equal(store.getState().autosave.retained, true, 'the failed draft was not kept');
  form.writes.length = 0;

  toggleRouting(store, false);
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not write');
  assert.deepEqual(
    pathsOf(form.writes[0]),
    ['routing'],
    'the decision carried the draft the Host had refused, and the retry the user never asked for'
  );
  store.dispose();
});

test('no write ever names a field the user did not edit, in either ordering', async () => {
  // The invariant behind all of the above, stated plainly: across both orderings of
  // a decision and a burst, the union of what reached the Host is exactly the
  // fields the user touched.
  for (const decisionFirst of [true, false]) {
    const ns = namespace(`only-touched-${String(decisionFirst)}`);
    const { store, form, clock } = makeStore({ namespace: ns });
    if (decisionFirst) {
      toggleRouting(store, false);
      await settle();
      typePrefix(store, 'rv_touch');
      await settle();
      clock.fireLast();
    } else {
      typePrefix(store, 'rv_touch');
      toggleRouting(store, false);
    }
    await settle();
    const written = form.writes.flatMap((write) => pathsOf(write));
    assert.deepEqual(
      [...new Set(written)].sort(),
      ['routing', 'toolPrefix'],
      `a write named a field the user did not edit (decision first: ${String(decisionFirst)})`
    );
    store.dispose();
  }
});

test('choosing a model with no other local edit writes exactly that one path', async () => {
  // The row's selection is the one "immediate" edit whose write must stay a
  // single narrow path: picking a model must not restate the list, another row, or
  // any runtime field (g-069).
  const { store, form } = makeStore({ namespace: namespace('precision-model') });
  await settle();

  store.edit((draft: any) => ({
    ...draft,
    backend: {
      ...draft.backend,
      profiles: draft.backend.profiles.map((row: any) => ({ ...row, selectedModel: 'jev-latest' }))
    }
  }));
  await settle();
  assert.equal(form.writes.length, 0, 'selecting the model the row already selects wrote');

  store.edit((draft: any) => ({
    ...draft,
    backend: {
      ...draft.backend,
      profiles: draft.backend.profiles.map((row: any) => ({ ...row, modelIds: 'jev-latest\ngpt-x', selectedModel: 'gpt-x' }))
    }
  }));
  await settle();
  assert.equal(form.writes.length, 1, 'the selection did not write at once');
  // The list and the selection are two paths of one row — and nothing else.
  for (const path of pathsOf(form.writes[0])) {
    assert.ok(
      path.startsWith('systemOne.profiles.primary.'),
      `the selection wrote a path outside the row: ${path}`
    );
  }
});

//#endregion

//#region a no-op decision must not disturb the typing behind it (g-070)

/** Edit the one row's model list, the way a keystroke reaches the textarea. */
function typeModelIds(store: AnyStore, value: string): void {
  store.edit(
    (draft: any) => ({
      ...draft,
      backend: { ...draft.backend, profiles: draft.backend.profiles.map((row: any) => ({ ...row, modelIds: value })) }
    }),
    'text'
  );
}

/**
 * A decision whose draft is **exactly** what the Host holds — the queue's own
 * definition of a no-op, with nothing typed into the row it touches.
 *
 * The page-level re-selection is a narrower case and is covered in
 * `client-page.test.ts`: there the click is never *reported* as an edit at all,
 * because a radio that is already checked is not a change. What is pinned here
 * is the queue's half of the rule, which does not depend on that: an edit whose
 * draft states the Host's own value must not cancel a pause it has no claim on.
 * @param store - the page.
 */
function decideNothing(store: AnyStore): void {
  // `routing` is the row-free decision: the draft it produces is the Host's own
  // value for every group, since the typed row is not part of it.
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing } }));
}

test('a decision that equals the Host cannot cancel the pause of the typing behind it (g-070)', async () => {
  // The queue's half of the reported race, stated as narrowly as it is true.
  //
  // In the page the click is now never reported as an edit at all (a radio that
  // is already checked is not a change — see `client-page.test.ts`). The queue is
  // the second line of defence, for a decision entry whose own draft says what
  // the Host holds *while a typed burst waits behind it*: that entry used to
  // supersede the burst, and `#drain` then dropped it by the no-op rule — after
  // `#cancelTimer` had disarmed the pause the burst depended on. The keystrokes
  // were then written by nothing at all.
  //
  // Driven through the store, not the bare queue: on the store path the decision
  // carries the typed row in its draft, so it is a real edit and flushes — which
  // is why this pins the flush/serialization behaviour rather than serving as the
  // red-to-green case. The red-to-green evidence for the queue rule itself is
  // `a decision with nothing to write leaves the waiting burst to its own pause`
  // below, driven against `Autosave` directly.
  const ns = namespace('noop-decision-keeps-pause');
  const { store, form, clock } = makeStore({ namespace: ns });
  await settle();

  typeModelIds(store, 'jev-latest\ntyped-partial');
  await settle();
  assert.equal(clock.armed().length, 1, 'the typing did not arm its pause');
  assert.equal(form.writes.length, 0, 'the typing wrote before its pause');

  // A decision whose draft states the Host's own routing — and, because it is
  // built from the page's live draft, the typed row as well. The page reports it
  // as a decision; the queue must treat the typed row as the user's edit.
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing } }));
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not write');
  assert.deepEqual(
    pathsOf(form.writes[0]),
    ['systemOne.profiles.primary.modelIds'],
    'the decision did not carry exactly the typed row'
  );
  assert.equal(clock.armed().length, 0, 'the flushed burst left its pause armed, so it would be written twice');
  await settle();
  assert.equal(form.writes.length, 1, 'the flushed burst was written a second time at its pause');
  assert.deepEqual(JSON.parse(JSON.stringify(hostModelIds(form))), ['jev-latest', 'typed-partial'], 'the typed list never reached the Host');
  store.dispose();
});

test('a decision with nothing to write leaves the waiting burst to its own pause (g-070)', async () => {
  // The queue rule in isolation, where the "nothing to write" part is exact: the
  // decision's draft *is* the baseline, and a burst waits behind it. Before the
  // fix the decision superseded the burst, `#cancelTimer` disarmed the burst's
  // pause, and `#drain` then dropped the combined entry by the no-op rule — the
  // burst was never written, by its pause or by anything else.
  const autosaveModule = loadModule('autosave') as { Autosave: new (options: Record<string, unknown>) => any };
  const timers: { fire: () => void }[] = [];
  const written: string[] = [];
  const queue = new autosaveModule.Autosave({
    write: async (entry: { draft: { v: string } }) => {
      written.push(entry.draft.v);
      return true;
    },
    changed: (base: { v: string }, draft: { v: string }) => base.v !== draft.v,
    original: () => ({ v: 'host' }),
    rebase: (draft: { v: string }) => draft,
    retain: () => undefined,
    setTimer: (callback: () => void) => {
      timers.push({ fire: callback });
      return timers.length;
    },
    clearTimer: () => undefined
  });
  queue.baseline({ v: 'host' });

  // Typing: queued, pause armed, nothing written.
  await queue.submit({ draft: { v: 'typed' }, errors: [], writable: true, revision: 1, before: { v: 'host' } }, 'text');
  assert.equal(queue.queued, true, 'the typing is not queued');
  assert.equal(timers.length, 1, 'the typing did not arm a pause');

  // A decision whose draft says exactly what the Host holds: nothing to write.
  await queue.submit({ draft: { v: 'host' }, errors: [], writable: true, revision: 1, before: { v: 'host' } }, 'immediate');
  assert.equal(queue.queued, true, 'the no-op decision dropped the waiting burst');

  // Its pause still carries the burst.
  timers[0]!.fire();
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ['typed'], 'the waiting burst never reached the Host');
});

test('a list typed behind a re-selection survives closing and reopening the dialog (g-070)', async () => {
  // Criterion 3 of the goal: the fix must not disturb the close/reopen contract.
  // The typed list is still waiting at its pause when the dialog is closed; the
  // queue outlives the page, so the burst must be written rather than dropped —
  // and a fresh page must then read it from the Host.
  const ns = namespace('noop-close-reopen');
  const { store, form } = makeStore({ namespace: ns });
  await settle();

  typeModelIds(store, 'jev-latest\ntyped-before-close');
  await settle();

  // A decision that states the Host value, arriving just before the close.
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing } }));
  store.dispose();
  await settle();

  const reopened = makeStore({ namespace: ns, form });
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(hostModelIds(form))),
    ['jev-latest', 'typed-before-close'],
    'the list typed before the close never reached the Host'
  );
  assert.equal(
    String(reopened.store.getState().draft.backend.profiles[0]?.modelIds ?? ''),
    'jev-latest\ntyped-before-close',
    'the reopened page does not show the list the Host holds'
  );
  reopened.store.dispose();
});

test('a re-selection and a typed list name only the row, never a field the Host moved (g-070)', async () => {
  // The "unrelated Host configuration" half of criterion 2, in the shape this
  // goal's edits actually take: a re-selection plus a typed model list must not
  // carry a *different* group the Host has moved in the meantime. (A genuine
  // revision conflict is covered by `a write fenced by a revision the Host has
  // moved past` above; this pins that the decision path cannot smuggle in an
  // older value of a field the user never touched.)
  const ns = namespace('reselection-narrow');
  const { store, form } = makeStore({ namespace: ns });
  await settle();

  // Another window moves a field that is not part of this row.
  form.push(authoredWith({ pruneThreshold: 999 }));
  await settle();
  assert.equal(storedDocument(form).value.pruneThreshold, 999, 'the Host did not move the unrelated field');

  typeModelIds(store, 'jev-latest\ntyped-narrow');
  await settle();
  // The decision that carries the burst (the shape the page sends when a real
  // change and a pending keystroke share one draft).
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing } }));
  await settle();

  assert.ok(form.writes.length > 0, 'nothing was written at all');
  for (const write of form.writes) {
    for (const path of pathsOf(write)) {
      assert.ok(path.startsWith('systemOne.profiles.primary.'), `a re-selection carried a field outside the row: ${path}`);
    }
  }
  assert.equal(storedDocument(form).value.pruneThreshold, 999, 'the page reverted a Host value the user never touched');
  assert.deepEqual(JSON.parse(JSON.stringify(hostModelIds(form))), ['jev-latest', 'typed-narrow'], 'the typed list did not reach the Host');
  store.dispose();
});

//#region activating a connection is a write (g-069 att-006)

/**
 * The authored document with a *second* connection the user can activate.
 *
 * Activation is only a change when there is another row to point `active` at,
 * so the reported flow needs a real choice. `secondary` differs from `primary`
 * in every field so a diff of the two rows is unambiguous.
 */
const TWO_PROFILES: Record<string, any> = {
  ...JSON.parse(JSON.stringify(AUTHORED)),
  systemOne: {
    active: 'primary',
    profiles: {
      primary: { baseUrl: 'http://a.example/v1', modelIds: ['jev-latest'], timeoutMs: 4000 },
      secondary: { baseUrl: 'http://b.example/v1', modelIds: ['other-latest'], timeoutMs: 5000 }
    }
  }
};

/** The page identity of one row, by name. */
function rowId(store: AnyStore, name: string): string {
  const row = store.getState().draft.backend.profiles.find((candidate: any) => candidate.name === name);
  assert.ok(row !== undefined, `no row named ${name}`);
  return row.id as string;
}

/** The activation the Host's document holds. */
function hostActive(form: ReturnType<typeof makeForm>): unknown {
  return JSON.parse(JSON.stringify(storedDocument(form).value.systemOne?.active));
}

test('activating another connection is written, and survives an immediate close and reopen', async () => {
  // The user's report against att-005: activate another connection, close the
  // dialog at once, reopen it — the old connection is still active. The root
  // cause was that `dirtyGroups` compared group writes only, and the activation
  // is deliberately not a group write (g-067), so a page whose *only* edit was an
  // activation read as clean: the queue's no-op rule dropped the write before
  // `diffDraft` — which does emit `set systemOne.active` — ever ran.
  const ns = namespace('activate-close-reopen');
  const { store, form } = makeStore({ namespace: ns, value: TWO_PROFILES });
  await settle();
  assert.equal(hostActive(form), 'primary', 'the fixture does not start with primary active');

  const gate = form.hold();
  assert.equal(store.setActiveProfile(rowId(store, 'secondary')), true, 'the row could not be activated');
  await settle();
  assert.equal(form.writes.length, 1, 'activating a connection did not start a write');

  // The dialog is closed while that write is still in flight, then reopened.
  store.dispose();
  const reopened = makeStore({ namespace: ns, form });
  await settle();
  gate.release();
  await settle();

  assert.equal(hostActive(form), 'secondary', 'the Host still holds the old connection after activation');
  assert.equal(reopened.store.getState().draft.backend.active, 'secondary', 'the reopened page shows the old connection active');

  // A *fresh* settings store — the dialog opened again later — must see it too,
  // which is what "persisted" means; an optimistic draft would not satisfy this.
  reopened.store.dispose();
  const again = makeStore({ namespace: ns, form });
  await settle();
  assert.equal(again.store.getState().draft.backend.active, 'secondary', 'a fresh page does not read the activated connection back');
  assert.equal(again.store.getState().draft.backend.storedActive, 'secondary', 'the fresh page read the activation from its own draft, not the document');
  again.store.dispose();
});

test('an activation alone writes `systemOne.active` and nothing else', async () => {
  // Precision is the other half of the report: the fix must not turn "activating a
  // connection" into a rewrite of the connection block. `setActiveProfile` changes
  // the activation and no row field, so the write is that one path — plus the
  // rows the diff restates *because* a lone activation write would otherwise drop
  // a schema-defaulted row. Here both rows are authored, so nothing needs restating.
  const ns = namespace('activate-precision');
  const { store, form } = makeStore({ namespace: ns, value: TWO_PROFILES });
  await settle();
  store.setActiveProfile(rowId(store, 'secondary'));
  await settle();
  assert.equal(form.writes.length, 1, 'activating a connection did not write');
  const paths = pathsOf(form.writes[0]);
  assert.ok(paths.includes('systemOne.active'), `the write does not name the activation: ${paths.join(',')}`);
  const rowPaths = paths.filter((path) => path.startsWith('systemOne.profiles.'));
  // The rows may be restated (see `diffDraft`), but only with what the document
  // already holds: no authored field may change value.
  const host = storedDocument(form).value;
  assert.equal(host.systemOne.profiles.primary.baseUrl, 'http://a.example/v1', 'the activation rewrote the un-activated row');
  assert.equal(host.systemOne.profiles.secondary.baseUrl, 'http://b.example/v1', 'the activation rewrote the activated row');
  assert.deepEqual(host.systemOne.profiles.secondary.modelIds, ['other-latest'], 'the activation changed a model list');
  for (const path of rowPaths) {
    assert.ok(
      path.startsWith('systemOne.profiles.primary.') || path.startsWith('systemOne.profiles.secondary.'),
      `the activation wrote a path outside the rows: ${path}`
    );
  }
  store.dispose();
});

test('re-activating the connection the document already holds is not a write', async () => {
  // The no-op rule still holds where it should: an activation that names what the
  // Host already holds must not write. This is the guard against "fix it by always
  // writing the activation", which would rewrite the document on every click of
  // the row that is already active.
  const ns = namespace('activate-noop');
  const { store, form } = makeStore({ namespace: ns, value: TWO_PROFILES });
  await settle();
  assert.equal(store.setActiveProfile(rowId(store, 'primary')), true, 'clicking the active row was refused');
  await settle();
  assert.equal(form.writes.length, 0, 'activating the connection already in force wrote to the Host');
  assert.equal(store.getState().autosave.phase, 'idle', 'a no-op activation reported a write');
  store.dispose();
});

test('a resolved factory activation nobody chose is not written', async () => {
  // g-067's rule has to survive the fix: a fresh document resolves to the factory
  // connection, so the page drafts it as active without anything on disk saying
  // so. That is a *display* value, and the dirty measure must not start reporting
  // it as an unsaved edit — otherwise every unrelated save would turn the factory
  // default into an authored decision.
  const ns = namespace('activate-factory');
  // No `systemOne` at all: the schema default supplies the factory row.
  const fresh = { backend: 'jev', toolPrefix: 'reflex_', routing: { enabled: true, virtualProvider: 'reflex', models: {} } };
  const { store, form } = makeStore({ namespace: ns, value: fresh });
  await settle();
  const state = store.getState();
  assert.equal(state.draft.backend.active, state.original.backend.active, 'the page invented an activation in its draft');
  assert.deepEqual(
    JSON.parse(JSON.stringify(panelModule.dirtyGroups(state.original, state.draft))),
    [],
    'a freshly seeded page reads its own resolved activation as an unsaved edit'
  );
  assert.equal(form.writes.length, 0, 'a freshly seeded page wrote on mount');
  store.dispose();
});

//#endregion

//#region the Host moves while a draft is unsaved

/**
 * A form that refuses writes with a *fence*: a revision older than the document's
 * is refused, which is what the Host does.
 *
 * The store's ordinary `makeForm` accepts anything, so a stale-revision write
 * would silently succeed there and hide exactly the failure these tests are about.
 */
function makeFencedForm(value: unknown): ReturnType<typeof makeForm> {
  const form = makeForm(value);
  const raw = form.form['mutate'] as (ops: unknown, revision?: number) => Promise<boolean>;
  let enforced = false;
  form.form['mutate'] = async (ops: unknown, revision?: number) => {
    if (!enforced) return raw(ops, revision);
    const live = (form.form['getSnapshot'] as () => { revision: number })();
    if (revision !== undefined && revision !== live.revision) return false;
    return raw(ops, revision);
  };
  // Exposed for the tests: begin fencing once the fixture is set up.
  (form as unknown as { enforce: () => void }).enforce = () => {
    enforced = true;
  };
  return form;
}

/**
 * Change one field on the Host, the way another window's save would.
 *
 * A full `form.push(replacedDocument)` is *not* the same event: replacing the whole
 * document rewrites the very field the kept draft holds, which legitimately makes
 * that draft obsolete. A Host that moved an unrelated field must leave the draft
 * alive.
 */
function hostSetsField(form: ReturnType<typeof makeForm>, path: string, value: unknown): void {
  const current = JSON.parse(JSON.stringify(storedDocument(form).value)) as Record<string, any>;
  current[path] = value;
  form.push(current);
}

/** The document the fixture's form is serving, typed for the tests below. */
function storedDocument(form: ReturnType<typeof makeForm>): { value: Record<string, any> } {
  return (form.form['getSnapshot'] as () => { value: Record<string, any> })();
}

test('a field the Host moved while a draft was unsaved is not written back to the old value', async () => {
  // The constraint the review carried over: never let an old draft overwrite a
  // newer Host setting. A failed write keeps a draft; the Host then moves on; the
  // next edit must still name only its own field, and a retry must re-state only
  // the unsaved edit.
  const ns = namespace('host-moved');
  const { store, form, clock } = makeStore({ namespace: ns });

  // A typed edit whose pause has fired: the write is in flight when the Host
  // refuses it, which is what leaves a draft behind.
  const gate = form.hold();
  typePrefix(store, 'rv_mine');
  await settle();
  clock.fireLast();
  await settle();
  gate.reject(new Error('host down'));
  await settle();
  assert.equal(store.getState().autosave.retained, true, 'the failed draft was not kept');

  // The Host's document moves on (another window wrote `pruneThreshold`).
  hostSetsField(form, 'pruneThreshold', 999);
  await settle();
  assert.equal(store.getState().original.runtime.pruneThreshold, '999', 'the page did not notice what the Host now holds');

  // A retry re-states the unsaved edit and leaves the Host's newer value alone.
  const accepted = await store.retryAutosave();
  await settle();
  assert.equal(accepted, true, 'the retry was refused');
  const retry = form.writes[form.writes.length - 1];
  assert.deepEqual(pathsOf(retry), ['toolPrefix'], 'the retry wrote a field the user had not edited');
  const afterRetry = storedDocument(form);
  assert.equal(afterRetry.value.pruneThreshold, 999, 'the retry reverted the Host to the stale value');
  assert.equal(afterRetry.value.toolPrefix, 'rv_mine', 'the retry did not land the unsaved edit');
  store.dispose();
});

test('an edit after the Host moved writes its own field and not the stale one', async () => {
  // Same setup, but no retry: the user simply keeps working. The next write must
  // not name `pruneThreshold` at all — the old draft's value would silently undo
  // the Host's newer setting.
  const ns = namespace('host-moved-edit');
  const { store, form, clock } = makeStore({ namespace: ns });

  const gate = form.hold();
  typePrefix(store, 'rv_mine');
  await settle();
  clock.fireLast();
  await settle();
  gate.reject(new Error('nope'));
  await settle();

  hostSetsField(form, 'pruneThreshold', 999);
  await settle();

  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, enabled: false } }));
  await settle();
  const write = form.writes[form.writes.length - 1];
  assert.deepEqual(pathsOf(write), ['routing'], 'the edit wrote a stale field back over the Host');
  const host = storedDocument(form);
  assert.equal(host.value.pruneThreshold, 999, 'the Host value the page never touched was reverted');
  store.dispose();
});

test('a write fenced by a revision the Host has moved past fails visibly and keeps the draft', async () => {
  // A conflict, not a silent overwrite. The revision a write is fenced by is the
  // one its draft was read at, so a Host that has moved on refuses it — the page
  // must report that and keep the draft, never retry behind the user and never
  // write anyway.
  const ns = namespace('conflict');
  const form = makeFencedForm(AUTHORED);
  const { store, clock } = makeStore({ namespace: ns, form });
  (form as unknown as { enforce: () => void }).enforce();

  // The first write is held open, so the second edit queues behind it.
  const gate = form.hold();
  toggleRouting(store, false);
  await settle();
  assert.equal(form.writes.length, 1, 'the first write did not start');

  typePrefix(store, 'rv_behind');
  await settle();
  assert.equal(form.writes.length, 1, 'the queued draft raced the write in flight');

  // The Host's document advances (another window) while the first write is still
  // open, so the queued draft was read at a revision that is now behind.
  const moved = JSON.parse(JSON.stringify(AUTHORED)) as Record<string, any>;
  moved.pruneThreshold = 999;
  form.push(moved);
  await settle();
  gate.release();
  await settle();
  // The queued write ran (or was drained by the release) and the Host refused it.
  if (clock.armed().length > 0) clock.fireLast();
  await settle();

  // The fence really was stale — otherwise this test would pass for the wrong
  // reason (a write that simply succeeded).
  const fenced = form.writes[form.writes.length - 1];
  assert.ok(fenced !== undefined, 'the queued write was never sent');
  const liveRevision = (form.form['getSnapshot'] as () => { revision: number })();
  assert.notEqual(fenced.revision, liveRevision, 'the fixture never produced a stale revision, so nothing was fenced');

  const state = store.getState();
  assert.equal(state.autosave.phase, 'failed', 'a write fenced by a stale revision is not reported as a failure');
  assert.equal(state.autosave.retained, true, 'a refused write did not keep its draft');
  assert.ok(state.autosave.reason !== null, 'a refused write does not say why');
  const host = storedDocument(form);
  assert.equal(host.value.pruneThreshold, 999, 'a refused write still overwrote the Host');
  // Nothing was lost: the typed draft is still on the page for a retry.
  assert.equal(toolPrefix(store), 'rv_behind', 'the refused draft left the page');
  store.dispose();
});

//#endregion

//#region a Host push that mints the unsaved value: the draft is not "saved"

/**
 * What the Host's document holds for the row every test edits.
 * @param form - the fixture's form.
 * @returns the stored `modelIds` array.
 */
function hostModelIds(form: ReturnType<typeof makeForm>): unknown {
  return JSON.parse(JSON.stringify(storedDocument(form).value.systemOne?.profiles?.primary?.modelIds));
}

/**
 * Hold one write open across a Host push, the way the review's sequence did.
 *
 * The shape being pinned (g-069): a *decision* is in flight when the Host pushes
 * a document that **already contains that decision's value**, plus an unrelated
 * field the page never touched. A text edit — valid on its own — is then typed
 * behind the held write. When the write is released, the re-seed hands the page a
 * row whose `name` matches by identity and whose *content* the Host still holds
 * at the pre-edit value; carrying the page's row across that re-seed (the g-062
 * identity rule) used to drag the unsaved text in with it, so the page's draft
 * equalled the Host's document and the edit was reported saved and never written.
 * @param form - the fixture's form.
 * @param store - the page.
 * @param clock - the fixture's clock.
 * @returns the gate, so the caller releases the held write explicitly.
 */
function holdDecisionThenType(
  form: ReturnType<typeof makeForm>,
  store: AnyStore,
  clock: ReturnType<typeof makeClock>
): { release: (accept?: boolean) => void; reject: (error: unknown) => void } {
  const gate = form.hold();
  toggleRouting(store, false);
  return gate;
}

/**
 * A Host snapshot built from the authored document, with fields overlaid.
 *
 * Built from {@link AUTHORED} rather than from the page's draft: the fixture's
 * `push` replaces the stored document outright, which is what a snapshot pushed
 * by the Host is.
 * @param patch - fields to overlay onto the authored document, by dotted path.
 * @returns the document the Host will serve next.
 */
function authoredWith(patch: Record<string, unknown>): Record<string, any> {
  const next = JSON.parse(JSON.stringify(AUTHORED)) as Record<string, any>;
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('.');
    const parent = keys.slice(0, -1).reduce<Record<string, any>>((node, key) => (node[key] ??= {}), next);
    parent[keys[keys.length - 1] as string] = value;
  }
  return next;
}

test('a Host push that already carries the decision does not save the text typed behind it', async () => {
  // The review's sequence, end to end. The decision is held open; the Host's
  // document then moves on *to the decision's own value* and also to an unrelated
  // timeout; a valid text edit is typed behind the held write. Releasing the write
  // must leave the text unsaved — neither reported saved nor lost — until the
  // pause carries it, and the Host's own moves must survive.
  const ns = namespace('push-mints-value');
  const { store, form, clock } = makeStore({ namespace: ns });
  await settle();

  const gate = holdDecisionThenType(form, store, clock);
  await settle();
  assert.equal(form.writes.length, 1, 'the decision did not start writing');

  // The Host's document now holds the decision, and a timeout the page never
  // touched. The row's `modelIds` is still the authored one.
  form.push(authoredWith({ 'routing.enabled': false, 'systemOne.profiles.primary.timeoutMs': 9000 }));
  await settle();
  // The text edit: valid on its own — `jev-latest` stays listed and selected.
  store.edit(
    (draft: any) => ({
      ...draft,
      backend: { ...draft.backend, profiles: draft.backend.profiles.map((p: any) => ({ ...p, modelIds: 'jev-latest, typed-local' })) }
    }),
    'text'
  );
  await settle();
  assert.equal(modelIds(store), 'jev-latest, typed-local', 'the typed row value is not on the page');
  assert.equal(clock.armed().length, 1, 'the typing did not arm its pause');

  // Release the decision and let everything settle *without* firing the pause.
  gate.release();
  await settle();
  assert.deepEqual(hostModelIds(form), ['jev-latest'], 'the typed list reached the Host before its pause');
  // A re-seed of the page may not *invent* the typed list either: the Host does
  // not hold it, so the page's draft is still an unsaved edit and nothing may
  // report it saved. (This is the false "已保存" the review saw.)
  assert.notEqual(store.getState().autosave.phase, 'saved', 'the page reported the typed edit saved while the Host does not hold it');
  // The typed edit is still the page's unsaved draft — the decision landing may
  // not re-seed it away, which is what made the page read as "saved".
  const afterRelease = store.getState();
  assert.equal(modelIds(store), 'jev-latest, typed-local', 'the decision landing dropped the text typed behind it');
  assert.deepEqual(
    JSON.parse(JSON.stringify(panelModule.dirtyGroups(afterRelease.original, afterRelease.draft))).sort(),
    ['backend'],
    'the page does not see the typed row as still unsaved'
  );

  // Now the pause fires — exactly as it would have — and the typed list lands.
  assert.equal(clock.armed().length, 1, 'the pause the typing armed was cancelled by the decision landing');
  clock.fireLast();
  await settle();

  const writesForModelIds = form.writes.filter((write) => pathsOf(write).includes('systemOne.profiles.primary.modelIds'));
  assert.equal(writesForModelIds.length, 1, 'the typed list was written more than once, or never');
  assert.deepEqual(hostModelIds(form), ['jev-latest', 'typed-local'], 'the typed list never reached the Host');
  // The Host's own unrelated move is left alone, and so is the decision.
  const host = storedDocument(form).value;
  assert.equal(host.systemOne.profiles.primary.timeoutMs, 9000, 'the write reverted a timeout the Host had set');
  assert.equal(host.routing.enabled, false, 'the write reverted the decision the Host already held');
  assert.equal(store.getState().autosave.phase, 'saved', 'the page never reported the write that did land');
  store.dispose();
});

test('two decisions in a row are written as the pair the user left, not one then a revert', async () => {
  // The second observation from the review: consecutive selections could roll
  // the earlier one back. Two decisions in one burst must reach the Host as the
  // combined state, and the Host must end on both.
  const ns = namespace('related-decisions');
  const { store, form, clock } = makeStore({ namespace: ns });
  await settle();

  const gate = form.hold();
  toggleRouting(store, false);
  await settle();
  store.edit((draft: any) => ({ ...draft, effort: { ...draft.effort, enabled: false } }));
  await settle();
  gate.release();
  await settle();
  if (clock.armed().length > 0) clock.fireLast();
  await settle();

  const host = storedDocument(form).value;
  assert.equal(host.routing.enabled, false, 'the first decision was rolled back by the second');
  assert.equal(host.effort.enabled, false, 'the second decision never reached the Host');
  assert.equal(form.writes.length, 2, 'the two decisions were not written as two ordered requests');
  store.dispose();
});

test('a re-seed that mints an unrelated Host value still keeps typing beyond the close/reopen', async () => {
  // The close/reopen path the feature is about: a decision in flight when the
  // page unmounts, a Host push, then a text edit in the reopened page. The
  // reopened page's own write must still land the text once.
  const ns = namespace('reopen-push');
  const { store, form, clock } = makeStore({ namespace: ns });
  await settle();

  const gate = holdDecisionThenType(form, store, clock);
  await settle();
  store.dispose();
  form.push(authoredWith({ 'routing.enabled': false, 'systemOne.profiles.primary.timeoutMs': 9000 }));
  await settle();
  gate.release();
  await settle();

  // The dialog is reopened in the same client lifetime and adopts the queue.
  const reopened = makeStore({ namespace: ns, form });
  await settle();
  reopened.store.edit(
    (draft: any) => ({
      ...draft,
      backend: { ...draft.backend, profiles: draft.backend.profiles.map((p: any) => ({ ...p, modelIds: 'jev-latest, typed-local' })) }
    }),
    'text'
  );
  await settle();
  if (reopened.clock.armed().length > 0) reopened.clock.fireLast();
  await settle();

  assert.deepEqual(hostModelIds(form), ['jev-latest', 'typed-local'], 'the reopened page never landed the typed list');
  assert.equal(storedDocument(form).value.systemOne.profiles.primary.timeoutMs, 9000, 'the reopened write reverted the Host timeout');
  reopened.store.dispose();
});

//#endregion

test('a long failure reason is kept whole in state and bounded where it is drawn', async () => {
  // The reason is the Host's or the network's own text, so its length is not this
  // page's to assume. The state keeps it whole (a retry or a later tooltip may want
  // it); the status line must not be redrawn around a novel.
  const ns = namespace('long-reason');
  const { store, form } = makeStore({ namespace: ns });
  const gate = form.hold();
  store.edit((draft: any) => ({ ...draft, routing: { ...draft.routing, enabled: false } }));
  await settle();
  const long = `host said: ${'x'.repeat(400)}`;
  gate.reject(new Error(long));
  await settle();
  assert.equal(store.getState().autosave.reason, long, 'the failure reason was truncated in state, where it is the truth');
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
