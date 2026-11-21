import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * The write contract of the multi-profile page (g-057), exercised against the
 * committed bundle.
 *
 * Two properties carry the whole feature:
 *
 * 1. **A whole-group `systemOne` write would delete every stored key.** The Host
 *    strips `role('secret')` slots before this page sees them, so the page cannot
 *    restate them, while a `set` op replaces its path's subtree on the *stored*
 *    config. These tests pin that the page only ever writes narrow paths.
 * 2. **Empty input means "leave it alone".** The page cannot distinguish "the
 *    user cleared the field" from "the key was never shown to them", so only the
 *    explicit clear action may unset the secret slot.
 *
 * The module is read out of the built artifact (CommonJS inside a `type: module`
 * package cannot be imported directly, so it runs in a module sandbox, the same
 * way `client-page.test.ts` loads the page).
 */

/** The `./panel` module of the built client. */
interface PanelModule {
  EMPTY_DRAFT: Record<string, any>;
  draftFromLayers(value: unknown, base: unknown): any;
  groupWrites(draft: unknown, group: string): { op?: string; path: string[]; value?: unknown }[];
  diffDraft(original: unknown, draft: unknown, user?: unknown): { op: string; path: string[]; value?: unknown }[];
  profileRowsFrom(value: unknown): any[];
  unnamedFilledRows(draft: unknown): number[];
  validateDraft(draft: unknown): { errors: string[]; values: Record<string, string>; ok: boolean };
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

/**
 * A store whose panel snapshot reports a stored key for the active profile.
 *
 * `fromProfile` decides whether that key is a literal in the document (the only
 * kind a rename can destroy) or one resolved from the environment variable the
 * profile names.
 * @param value - the settings document the form holds.
 * @param fromProfile - whether the key is the document's own secret slot.
 * @returns the store, its form, and the fetch log `makeStore` returns.
 */
function storeWithStoredKey(
  value: Record<string, unknown>,
  fromProfile = true
): ReturnType<typeof makeStore> {
  const routing = { enabled: false };
  const form = fakeForm({ backend: 'jev', ...value, routing });
  const fetched: string[] = [];
  const profileName = String((value as any).systemOne?.active ?? '');
  const snapshot = {
    systemOne: { profiles: [{ name: profileName, apiKeyPresent: true, apiKeyFromProfile: fromProfile }] }
  };
  const store = new storeModule.PanelStore({
    form: form.form,
    fetch: async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => snapshot };
    },
    pollIntervalMs: 0
  });
  return { store, form, fetched };
}

const panel = loadModule('panel') as unknown as PanelModule;

/** One profile row with the supplied overrides. */
function row(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    name: 'primary',
    baseUrl: '',
    modelIds: '',
    selectedModel: '',
    legacyModelShape: false,
    apiKeyEnv: '',
    timeoutMs: '',
    backend: '',
    apiKey: '',
    apiKeyPresent: false,
    apiKeyFromProfile: false,
    clearKey: false,
    ...overrides
  };
}

/** A draft carrying the supplied rows. */
function draftWith(profiles: Record<string, any>[], active = 'primary'): any {
  return { ...panel.EMPTY_DRAFT, backend: { ...panel.EMPTY_DRAFT.backend, backend: 'jev', active, profiles } };
}

/** Cross-realm comparison: JSON round-trips a value out of the module sandbox. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Whether any write targets the whole `systemOne` group. */
function hasGroupWrite(writes: { path: string[] }[]): boolean {
  return writes.some((write) => write.path.length === 1 && write.path[0] === 'systemOne');
}

/** The write targeting one exact path. */
function writeAt(writes: { path: string[]; value?: unknown }[], path: string[]): { path: string[]; value?: unknown } | undefined {
  return writes.find((write) => write.path.length === path.length && write.path.every((segment, index) => segment === path[index]));
}

test('the page never writes the systemOne group, which would delete a stored key', () => {
  const writes = panel.groupWrites(draftWith([row({ modelIds: 'm1' }), row({ name: 'secondary', baseUrl: 'http://b' })]), 'backend');
  assert.equal(hasGroupWrite(writes), false, 'a group write would drop every secret slot');
  for (const write of writes) {
    if (write.path[0] !== 'systemOne') continue;
    assert.ok(write.path.length >= 2, `too shallow: ${write.path.join('.')}`);
  }
  // The scalar backend choice still travels on its own declared path.
  assert.equal(writeAt(writes, ['backend'])?.value, 'jev');
});

test('an empty key input writes nothing at all for that slot', () => {
  const writes = panel.groupWrites(draftWith([row({ apiKeyPresent: true })]), 'backend');
  assert.equal(
    writeAt(writes, ['systemOne', 'profiles', 'primary', 'apiKey']),
    undefined,
    'an empty input must not touch the stored key'
  );
});

test('a typed key is written on the profile secret path, once', () => {
  const writes = panel.groupWrites(draftWith([row({ apiKey: '  sk-typed-key  ' })]), 'backend');
  // Compared field by field: the values come from another realm, so a deepEqual
  // against a host-realm object would fail on the prototype rather than the value.
  const secretWrite = writeAt(writes, ['systemOne', 'profiles', 'primary', 'apiKey']);
  assert.ok(secretWrite !== undefined, 'the typed key must reach the secret path');
  assert.equal(secretWrite.value, 'sk-typed-key', 'trimmed');
  assert.deepEqual([...secretWrite.path], ['systemOne', 'profiles', 'primary', 'apiKey']);
  const secretWrites = writes.filter((candidate) => candidate.path[candidate.path.length - 1] === 'apiKey');
  assert.equal(secretWrites.length, 1, 'exactly one write names the secret slot');
});

test('clearing is an explicit unset, and it wins over a pending value', () => {
  const cleared = panel.groupWrites(draftWith([row({ clearKey: true })]), 'backend');
  const clearWrite = writeAt(cleared, ['systemOne', 'profiles', 'primary', 'apiKey']);
  assert.ok(clearWrite !== undefined, 'the clear must reach the secret path');
  assert.equal(clearWrite.value, undefined, 'clear is an unset');

  // A value typed and then explicitly cleared gets the clear, not the value.
  const both = panel.groupWrites(draftWith([row({ clearKey: true, apiKey: 'sk-typed' })]), 'backend');
  assert.equal(writeAt(both, ['systemOne', 'profiles', 'primary', 'apiKey'])?.value, undefined);
});

test('the key is never seeded from a read, and presence comes from the Host', () => {
  const seeded = panel.draftFromLayers(
    { backend: 'jev', systemOne: { baseUrl: 'http://flat', active: 'primary', profiles: { primary: { model: 'm1', baseUrl: 'http://p' } } } },
    {}
  );
  const [primary] = seeded.backend.profiles;
  assert.equal(primary.name, 'primary');
  assert.equal(primary.modelIds, 'm1', 'a legacy single model seeds the one-entry list');
  assert.equal(primary.selectedModel, 'm1', 'and is the selected one, so nothing runs unselected');
  assert.equal(primary.apiKey, '', 'a read must never seed the key');
  assert.equal(primary.apiKeyPresent, false, 'presence is unknown until the live snapshot says');
});

test('an unrelated edit of a row that has a stored key leaves that key alone', () => {
  const seeded = panel.draftFromLayers(
    { backend: 'jev', systemOne: { active: 'primary', profiles: { primary: { model: 'old-model' } } } },
    {}
  );
  const edited = {
    ...seeded,
    backend: {
      ...seeded.backend,
      profiles: seeded.backend.profiles.map((profile: any) => ({
        ...profile,
        modelIds: 'new-model',
        selectedModel: 'new-model',
        apiKeyPresent: true,
        apiKeyFromProfile: true
      }))
    }
  };
  const writes = panel.groupWrites(edited, 'backend');
  assert.equal(hasGroupWrite(writes), false);
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'apiKey']), undefined, 'the stored key survives');
  // The row was read in the legacy shape and still holds one model, so the save
  // keeps that shape: `model` is updated, and no `modelIds` is left beside it.
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'model'])?.value, 'new-model');
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'modelIds'])?.value, undefined, 'no second shape');
});

test('a blanked profile field becomes an unset so the row inherits again', () => {
  const seeded = panel.draftFromLayers(
    { backend: 'jev', systemOne: { baseUrl: 'http://flat', active: 'primary', profiles: { primary: { model: 'm1', baseUrl: 'http://p' } } } },
    {}
  );
  const blanked = {
    ...seeded,
    backend: {
      ...seeded.backend,
      profiles: seeded.backend.profiles.map((profile: any) => ({ ...profile, baseUrl: '' }))
    }
  };
  const writes = panel.groupWrites(blanked, 'backend');
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'baseUrl'])?.value, undefined, 'the row states no address');
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'model'])?.value, 'm1', 'the untouched field is kept');
});

test('an unnamed row is still never written, but it is no longer silently accepted', () => {
  // g-062 pinned that an unnamed row is skipped by `groupWrites` — and it still
  // is, because an empty path segment is not a settings path. What g-064 changes
  // is what the *page* does about it: skipping alone meant both drafts produced
  // the same empty write list, the diff came out empty, and the save reported
  // "clean" while the row silently vanished. The row cannot be written (this
  // assertion, unchanged) and must now be *refused* instead (the next ones).
  const writes = panel.groupWrites(draftWith([row({ name: '', modelIds: 'm' })]), 'backend');
  assert.equal(writes.some((write) => write.path.includes('')), false, 'an empty path segment would be invalid');
  // A blank row is not refused: "新增配置" leaves one behind and it must not
  // block the rest of the page.
  assert.deepEqual([...panel.unnamedFilledRows(draftWith([row({ name: '' })]))], [], 'an empty new row is not an error');
  // A filled-in one is, and the message names the row by its position. A blank
  // row sitting *above* it is not counted, so the number is the position on the
  // page, not the index among the unnamed ones.
  const threeRows = draftWith([row({ name: '' }), row(), row({ name: ' ', baseUrl: 'http://x' })]);
  assert.deepEqual([...panel.unnamedFilledRows(threeRows)], [3], 'only the filled-in row is a problem');
  const validation = panel.validateDraft(threeRows);
  assert.equal(validation.ok, false, 'a filled-in unnamed row must not validate');
  assert.ok(validation.errors.includes('errProfileName'), `no errProfileName: ${validation.errors.join(',')}`);
  assert.equal(validation.values.errProfileName, '3', 'the error must name which row is unnamed');
});

test('the active name is written only when it changes, and never as an unset (g-067)', () => {
  // `groupWrites` describes one draft and no longer states the activation: what
  // to write depends on what the save does to the rows, which only the diff of
  // two drafts knows (g-067 — a fresh document drafts the factory row as active
  // without anything on disk saying so).
  assert.equal(writeAt(panel.groupWrites(draftWith([row()], 'secondary'), 'backend'), ['systemOne', 'active']), undefined);
  const seed = { ...panel.EMPTY_DRAFT, backend: { ...panel.EMPTY_DRAFT.backend, backend: 'jev', active: 'primary', storedActive: 'primary', profiles: [row()] } };
  const chosen = { ...seed, backend: { ...seed.backend, active: 'secondary' } };
  const ops = panel.diffDraft(seed, chosen);
  const written = writeAt(ops as never, ['systemOne', 'active']);
  assert.equal(written?.value, 'secondary', 'the chosen row must be written');
  // Clearing the activation is never a lone `unset`, which the Host would rebuild
  // as `{}` — the fresh document that gets the factory connection back.
  const cleared = panel.diffDraft(seed, { ...seed, backend: { ...seed.backend, active: '' } });
  const activationOps = (cleared as { path: string[] }[]).filter((op) => op.path.join('.') === 'systemOne.active');
  assert.equal(activationOps.every((op) => (op as { op?: string }).op !== 'unset'), true, JSON.stringify(activationOps));
});

//#region row identity (g-062)

/**
 * The store module of the built client.
 *
 * The page's own state machine is plain JavaScript once compiled — no React, no
 * browser global — so the row-identity behaviour can be driven directly rather
 * than through a rendered tree, which is what these cases need: a *sequence* of
 * clicks, each depending on the previous one.
 */
interface StoreModule {
  PanelStore: new (options: Record<string, unknown>) => {
    getState(): any;
    edit(mutate: (draft: any) => any): void;
    addProfile(): void;
    removeProfile(id: string): void;
    setActiveProfile(id: string): boolean;
    testProfile(id: string, saved: ReadonlySet<string>): Promise<boolean>;
    save(): Promise<boolean>;
    reset(): void;
    /** Re-read the panel snapshot; how key *presence* reaches the rows. */
    refresh(): Promise<void>;
    dispose(): void;
  };
  draftFromForm(form: unknown): any;
  draftFromFormKeepingRows(form: unknown, previous: readonly any[]): any;
}

const storeModule = loadModule('store') as unknown as StoreModule;

/** A settings form over one authored document, recording what a save writes. */
function fakeForm(value: unknown): {
  form: Record<string, unknown> & { getSnapshot(): unknown };
  mutations: { ops: any[]; revision: unknown }[];
  replace(next: unknown): void;
} {
  const mutations: { ops: any[]; revision: unknown }[] = [];
  let snapshot: Record<string, unknown> = { status: 'ready', value, base: 0, user: 0, revision: 1, writable: true };
  const listeners = new Set<() => void>();
  return {
    mutations,
    form: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      mutate: async (ops: unknown, revision?: number) => {
        mutations.push({ ops: ops as any[], revision });
        return true;
      }
    },
    replace: (next: unknown) => {
      snapshot = { ...snapshot, value: next, revision: (Number(snapshot.revision) ?? 0) + 1 };
      for (const listener of [...listeners]) listener();
    }
  };
}

/** A store over one authored document, with polling switched off. */
function makeStore(value: unknown = { backend: 'jev', systemOne: { profiles: {} } }): {
  store: InstanceType<StoreModule['PanelStore']>;
  form: ReturnType<typeof fakeForm>;
  fetched: string[];
} {
  // Shipping routing needs at least one usable candidate, so an empty pool would
  // fail validation for a reason that has nothing to do with the rows under test.
  const form = fakeForm({ ...(value as Record<string, unknown>), routing: { enabled: false } });
  const fetched: string[] = [];
  const store = new storeModule.PanelStore({
    form: form.form,
    fetch: async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    pollIntervalMs: 0
  });
  return { store, form, fetched };
}

test('deleting one unnamed row deletes exactly one row', () => {
  const { store } = makeStore();
  store.addProfile();
  store.addProfile();
  store.addProfile();
  const before = store.getState().draft.backend.profiles as any[];
  assert.equal(before.length, 3, 'three unnamed candidate rows');
  assert.equal(new Set(before.map((row) => row.id)).size, 3, 'every row has its own identity');
  const victim = before[1]!;
  store.removeProfile(victim.id);
  const after = store.getState().draft.backend.profiles as any[];
  // The regression this pins: `filter(row => row.name.trim() !== '')` removed
  // *all* three unnamed rows, so this went from 3 to 0 rather than 3 to 2.
  assert.equal(after.length, 2, 'one remove must take one row, not every unnamed one');
  // Ids come from the sandbox realm, so they are stringified before comparing.
  assert.deepEqual(
    [...after.map((row) => row.id)],
    [...[before[0]!.id, before[2]!.id]],
    'the pressed row is the row that went'
  );
});

test('deleting a named row leaves the unnamed rows and the active marker alone', () => {
  const { store } = makeStore({ backend: 'jev', systemOne: { active: 'primary', profiles: { primary: { model: 'm' } } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const named = rows().find((row) => row.name === 'primary');
  assert.ok(named !== undefined, 'the saved row is seeded');
  store.removeProfile(named.id);
  assert.equal(rows().length, 1, 'the unnamed row survives');
  assert.equal(rows()[0]!.name, '', 'the survivor is the unnamed one');
  // Removing the active profile clears it, so the document never names a row the
  // user just deleted.
  assert.equal(store.getState().draft.backend.active, '', 'the active profile was the one removed');
});

test('removing one of two same-named rows keeps the activation', () => {
  const { store } = makeStore({ backend: 'jev', systemOne: { active: 'primary', profiles: { primary: { model: 'm' } } } });
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: [
        ...current.backend.profiles,
        // A second row that happens to carry the same name in the draft: the
        // activation must survive deleting one of the two.
        { ...current.backend.profiles[0], id: 'dup-row' }
      ]
    }
  }));
  store.removeProfile('dup-row');
  assert.equal(store.getState().draft.backend.active, 'primary', 'the survivor still carries the active name');
  const remaining = store.getState().draft.backend.profiles as any[];
  assert.equal(remaining.length, 1);
  store.removeProfile(remaining[0]!.id);
  assert.equal(store.getState().draft.backend.active, '', 'the last holder of the name clears it');
});

test('activating a row is addressed by identity and is visible at once', () => {
  const { store } = makeStore({
    backend: 'jev',
    systemOne: { profiles: { primary: { model: 'm' }, secondary: { model: 'n' } } }
  });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const secondary = rows().find((row) => row.name === 'secondary');
  assert.ok(secondary !== undefined);
  // Activation is a draft edit: it shows immediately, before any save.
  assert.equal(store.setActiveProfile(secondary.id), true, 'a named row can be activated');
  assert.equal(store.getState().draft.backend.active, 'secondary');
});

test('activating an unnamed row is refused instead of writing an empty active', () => {
  const { store } = makeStore({ backend: 'jev', systemOne: { active: 'primary', profiles: { primary: { model: 'm' } } } });
  store.addProfile();
  const blank = (store.getState().draft.backend.profiles as any[]).find((row) => row.name === '');
  assert.ok(blank !== undefined);
  assert.equal(store.setActiveProfile(blank.id), false, 'an unnamed row has no name to activate');
  // The regression: `active: ''` was written and the screen never changed.
  assert.equal(store.getState().draft.backend.active, 'primary', 'the previous activation is untouched');
});

test('a row is tested only when the Host already knows its name', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { primary: { model: 'm' } } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const named = rows().find((row) => row.name === 'primary');
  const blank = rows().find((row) => row.name === '');
  const saved = new Set(['primary']);

  assert.equal(await store.testProfile(blank!.id, saved), false, 'an unnamed row cannot be probed');
  assert.equal(store.getState().probes[''], undefined, 'no probe state was recorded for the empty name');

  // A named row the Host has not read yet is not probeable either.
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) => (row.id === blank.id ? { ...row, name: 'fresh' } : row))
    }
  }));
  assert.equal(await store.testProfile(blank!.id, saved), false, 'an unsaved row has nothing on the Host to probe');
  // Once the Host reports it, the same click works and files the result by name.
  assert.equal(await store.testProfile(named!.id, saved), true);
  assert.equal(store.getState().probes['primary']?.phase, 'done');
  assert.deepEqual(form.mutations, [], 'testing a connection never writes the document');
});

test('saving still writes only named rows, and never a row identity', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { base: {} } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const blank = rows().find((row) => row.name === '')!;
  assert.equal(blank.name, '', 'the row starts unnamed');
  // Save the row the way the user does: name it, fill it in, then save.
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) =>
        row.id === blank.id ? { ...row, name: 'aseit', baseUrl: 'https://newapi.example/v1', apiKeyEnv: 'NEWAPI_ASEIT_API_KEY' } : row
      )
    }
  }));
  assert.equal(await store.save(), true, `the save went through: ${JSON.stringify(store.getState().errors)}`);
  const ops = form.mutations.flatMap((mutation) => mutation.ops);
  assert.ok(ops.length > 0, 'the named row was written');
  const serialized = JSON.stringify(ops);
  // The identity is page state: no op may name it, and no op may address a
  // profile path whose name segment is empty.
  assert.equal(serialized.includes('profile-'), false, 'a row identity reached the settings write');
  for (const op of ops) {
    if (op.path?.[0] !== 'systemOne' || op.path?.[1] !== 'profiles') continue;
    assert.notEqual(String(op.path[2]).trim(), '', `an unnamed row produced the path ${(op.path as string[]).join('.')}`);
  }
});

test('a filled-in unnamed row is refused by the save, and nothing is written', async () => {
  // The reported bug (g-064): the row was filled in but never named, the save
  // returned `true` with notice `clean`, the document got nothing, the page kept
  // saying "unsaved" forever and the row could never be tested.
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { base: {} } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const blank = rows().find((row) => row.name === '')!;
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) =>
        row.id === blank.id ? { ...row, baseUrl: 'https://newapi.example/v1', apiKeyEnv: 'NEWAPI_ASEIT_API_KEY' } : row
      )
    }
  }));
  // Editing already surfaces the problem, before any save click.
  assert.ok(store.getState().errors.includes('errProfileName'), `the row is not flagged while editing: ${store.getState().errors}`);
  assert.equal(store.getState().errorValues.errProfileName, '2', 'the error names the row (the seeded `base` row is 1)');

  assert.equal(await store.save(), false, 'the save must be refused, not reported successful');
  const state = store.getState();
  assert.ok(state.errors.length > 0, 'the refusal carries no explanation');
  assert.ok(state.errors.includes('errProfileName'), `wrong explanation: ${state.errors.join(',')}`);
  assert.notEqual(state.notice, 'clean', 'a refused save must never report clean');
  assert.notEqual(state.notice, 'saved', 'a refused save must never report saved');
  assert.deepEqual(form.mutations, [], 'a refused save wrote to the document');
  // The user's row is untouched by the refusal: it is still there to be named.
  const survivor = rows().find((row) => row.id === blank.id);
  assert.ok(survivor !== undefined, 'the refused row disappeared');
  assert.equal(survivor.apiKeyEnv, 'NEWAPI_ASEIT_API_KEY', 'the typed value was lost');
});

test('a blank row the user just added does not block the save, and the page stops claiming dirty', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { base: {} } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const blank = rows().find((row) => row.name === '')!;
  // Cross-realm: the store runs in the module sandbox, so the empty list is
  // compared by content rather than by prototype (see `plain` above).
  assert.deepEqual(plain(store.getState().errors), [], 'an empty new row must not be an error');
  assert.equal(await store.save(), true, `the save should go through: ${store.getState().errors}`);
  assert.deepEqual(form.mutations, [], 'there was nothing to write');
  const state = store.getState();
  assert.equal(state.notice, 'clean');
  // The regression: the empty diff returned early without re-seeding, so the
  // dirty badge stayed on over a draft that held only an empty new row.
  assert.equal(state.draft, state.original, 'the page still believes it has unsaved changes');
  const after = rows().filter((row) => row.name === '');
  assert.equal(after.length, 1, 'the blank row must survive the re-seed');
  assert.equal(after[0]!.id, blank.id, 'and keep its identity');
});

test('naming the row after the refusal writes narrow profile paths and reports saved', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { base: {} } } });
  store.addProfile();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const blank = rows().find((row) => row.name === '')!;
  const fill = (patch: Record<string, string>): void => {
    store.edit((current) => ({
      ...current,
      backend: {
        ...current.backend,
        profiles: current.backend.profiles.map((row: any) => (row.id === blank.id ? { ...row, ...patch } : row))
      }
    }));
  };
  fill({ baseUrl: 'https://newapi.example/v1', apiKeyEnv: 'NEWAPI_ASEIT_API_KEY' });
  assert.equal(await store.save(), false);
  fill({ name: 'aseit' });
  assert.deepEqual(plain(store.getState().errors), [], 'naming the row clears the problem');
  assert.equal(await store.save(), true, `the named save went through: ${store.getState().errors}`);
  assert.equal(store.getState().notice, 'saved');
  assert.equal(store.getState().draft, store.getState().original, 'the page still shows unsaved changes after the save');

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  const written = ops.filter((op) => op.path[0] === 'systemOne' && op.path[1] === 'profiles' && op.path[2] === 'aseit');
  // The row is written on narrow paths under its own name, and only there.
  assert.ok(written.length > 0, `the named row produced no profile write: ${JSON.stringify(ops.slice(0, 4))}`);
  for (const op of written) {
    assert.equal(op.path[3] !== undefined, true, `a write stops at the row: ${op.path.join('.')}`);
  }
  const valueAt = (field: string): unknown => written.find((op) => op.path[3] === field)?.value;
  assert.equal(valueAt('baseUrl'), 'https://newapi.example/v1');
  assert.equal(valueAt('apiKeyEnv'), 'NEWAPI_ASEIT_API_KEY');
  assert.equal(JSON.stringify(ops).includes('profile-'), false, 'a row identity reached the settings write');
});

test('a re-seed matches rows by name even when the unnamed rows sit above them', () => {
  const form = fakeForm({ backend: 'jev', systemOne: { profiles: { primary: { model: 'm' } } } });
  const seeded = storeModule.draftFromForm(form.form.getSnapshot());
  const [primary] = seeded.backend.profiles as any[];
  // User state: one blank row added *first*, then the saved row.
  const blank = { ...primary, id: 'blank-row', name: '', model: '', baseUrl: '' };
  const onScreen = [blank, primary];
  // The document answers for `primary` only; the blank row is not in it.
  const next = storeModule.draftFromFormKeepingRows(form.form.getSnapshot(), onScreen);
  const ids = (next.backend.profiles as any[]).map((row) => row.id);
  assert.ok(ids.includes('blank-row'), `the unsaved row must survive a re-seed; got ${ids.join(',')}`);
  assert.equal(next.backend.profiles.find((row: any) => row.id === 'blank-row')!.name, '', 'it stays unnamed');
  assert.ok(ids.includes(primary.id), 'the saved row keeps its identity');
});

test('profileRowsFrom seeds rows in authored order and drops malformed entries', () => {
  const rows = panel.profileRowsFrom({
    a: { model: 'ma', apiKey: 'stored-never-returned' },
    b: null,
    c: { baseUrl: 'http://c', timeoutMs: 900 }
  });
  assert.deepEqual([...rows.map((entry: any) => entry.name)], ['a', 'c']);
  assert.equal(rows[0].apiKey, '', 'even a (hypothetical) authored key is not seeded into the input');
  assert.equal(rows[1].baseUrl, 'http://c');
  assert.equal(rows[1].timeoutMs, '900');
});

//#region renaming and deleting saved rows (g-065)

/**
 * A profile is addressed by the name the user typed, so renaming one is a
 * *different settings path* rather than an edit of the old one. Without an
 * explicit delete the old `systemOne.profiles.<old>` subtree survived the save:
 * the Host accumulated abandoned profiles, and a document could name a profile
 * that no longer had a row.
 *
 * Both halves must travel in one `mutate` call, so the Host applies the delete
 * and the write together or neither.
 */

/** The profile-path operations of one save, as `op path` lines. */
function profileOps(ops: { op: string; path: string[]; value?: unknown }[]): string[] {
  return ops
    .filter((op) => op.path[0] === 'systemOne' && op.path[1] === 'profiles')
    .map((op) => `${op.op} ${op.path.join('.')}`);
}

/** The exact `unset` of one profile's whole subtree. */
function hasSubtreeUnset(ops: { op: string; path: string[] }[], name: string): boolean {
  return ops.some((op) => op.op === 'unset' && op.path.length === 3 && op.path[0] === 'systemOne' && op.path[1] === 'profiles' && op.path[2] === name);
}

/** Rename one row by identity, the way the name input does. */
function renameRow(store: { edit(mutate: (draft: any) => any): void; getState(): any }, id: string, name: string): void {
  store.edit((current) => ({
    ...current,
    backend: { ...current.backend, profiles: current.backend.profiles.map((row: any) => (row.id === id ? { ...row, name } : row)) }
  }));
}

test('renaming a saved row unsets the old name and writes the row under the new one', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { oldname: { model: 'm1', baseUrl: 'http://a' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'oldname');
  assert.ok(saved !== undefined, 'the saved row is seeded');

  renameRow(store, saved.id, 'newname');
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);
  assert.equal(store.getState().notice, 'saved');

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  // One subtree unset, not one per field: `apiKey` is `role('secret')`, never
  // sent to the page, so a field-by-field delete would leave the key behind.
  assert.equal(hasSubtreeUnset(ops, 'oldname'), true, `the old name was not deleted: ${profileOps(ops).join(' | ')}`);
  const setNew = ops.find(
    (op) => op.op === 'set' && op.path[0] === 'systemOne' && op.path[1] === 'profiles' && op.path[2] === 'newname' && op.path[3] === 'model'
  );
  assert.equal(setNew?.value, 'm1', 'the row must survive under the new name');
  // The retired name is never written to, on either side.
  assert.equal(
    ops.some((op) => op.op === 'set' && op.path[2] === 'oldname'),
    false,
    `the retired name was written to: ${profileOps(ops).join(' | ')}`
  );
  // And both halves are in the same write, which is what makes it atomic.
  assert.equal(form.mutations.length, 1, 'the delete and the write must be one mutate call');
});

test('renaming several rows at once retires every old name', async () => {
  const { store, form } = makeStore({
    backend: 'jev',
    systemOne: { profiles: { alpha: { model: 'a' }, beta: { model: 'b' }, gamma: { model: 'g' } } }
  });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const alpha = rows().find((row) => row.name === 'alpha')!;
  const beta = rows().find((row) => row.name === 'beta')!;

  renameRow(store, alpha.id, 'alpha2');
  renameRow(store, beta.id, 'beta2');
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'alpha'), true, `alpha not deleted: ${profileOps(ops).join(' | ')}`);
  assert.equal(hasSubtreeUnset(ops, 'beta'), true, `beta not deleted: ${profileOps(ops).join(' | ')}`);
  // The untouched row is left exactly as it was. The write is per path now
  // (g-066), so "left alone" is the stronger statement: no operation addresses
  // `gamma` at all, which is neither a deletion nor a restatement.
  assert.equal(hasSubtreeUnset(ops, 'gamma'), false, 'an untouched row must not be deleted');
  assert.deepEqual(
    ops.filter((op) => op.path.includes('gamma')),
    [],
    `an untouched row was rewritten: ${profileOps(ops).join(' | ')}`
  );
  assert.equal(form.mutations.length, 1, 'one save, one atomic write');
});

test('renaming a row while editing its fields deletes the old name and writes the new values', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { oldname: { model: 'm1', baseUrl: 'http://a' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'oldname')!;

  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) =>
        row.id === saved.id ? { ...row, name: 'newname', modelIds: 'm2', selectedModel: 'm2', apiKeyEnv: 'NEW_KEY' } : row
      )
    }
  }));
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'oldname'), true, `the old name was not deleted: ${profileOps(ops).join(' | ')}`);
  const valueAt = (field: string): unknown =>
    ops.find((op) => op.op === 'set' && op.path.join('.') === `systemOne.profiles.newname.${field}`)?.value;
  // The row was read as a legacy one-model connection and the user replaced the
  // id, so the save keeps that shape (`model`) rather than migrating it.
  assert.equal(valueAt('model'), 'm2', 'the edited value must land under the new name');
  assert.equal(valueAt('apiKeyEnv'), 'NEW_KEY', 'the newly typed value must land under the new name');
  assert.equal(valueAt('baseUrl'), 'http://a', 'the untouched value travels with the row');
});

test('renaming the active row moves the activation with it', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { active: 'oldname', profiles: { oldname: { model: 'm1' }, other: { model: 'm2' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'oldname')!;
  assert.equal(store.getState().draft.backend.active, 'oldname', 'the row starts active');

  renameRow(store, saved.id, 'newname');
  // The activation is visible before the save, exactly like the rename itself.
  assert.equal(store.getState().draft.backend.active, 'newname', 'the activation did not follow the row');

  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);
  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'oldname'), true, 'the old name is still deleted');
  const active = ops.find((op) => op.op === 'set' && op.path.join('.') === 'systemOne.active');
  // The document must not keep naming a profile that no longer exists: that
  // resolved as `activeProfileMissing` and silently dropped to the flat block.
  assert.equal(active?.value, 'newname', 'the document would name a deleted profile');
});

test('deleting a saved row deletes its whole settings subtree', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { target: { model: 'm1', baseUrl: 'http://t' }, keep: { model: 'm2' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const target = rows().find((row) => row.name === 'target')!;

  store.removeProfile(target.id);
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'target'), true, `the deleted row was left behind: ${profileOps(ops).join(' | ')}`);
  assert.equal(hasSubtreeUnset(ops, 'keep'), false, 'a surviving row must not be deleted');
});

test('swapping two rows names deletes nothing, because both names survive', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { a: { model: 'ma' }, b: { model: 'mb' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const a = rows().find((row) => row.name === 'a')!;
  const b = rows().find((row) => row.name === 'b')!;

  // Each row keeps its own fields but takes the other's name: every name in the
  // old document is still in use, so deleting either would delete a live row.
  renameRow(store, a.id, 'b');
  renameRow(store, b.id, 'a');
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);

  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'a'), false, `swapping deleted a live row: ${profileOps(ops).join(' | ')}`);
  assert.equal(hasSubtreeUnset(ops, 'b'), false, `swapping deleted a live row: ${profileOps(ops).join(' | ')}`);
});

test('renaming onto a name the document never held deletes only the old one', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { a: { model: 'ma' }, keep: { model: 'mk' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const a = rows().find((row) => row.name === 'a')!;

  renameRow(store, a.id, 'fresh');
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);
  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
  assert.equal(hasSubtreeUnset(ops, 'a'), true, 'the old name is deleted');
  assert.equal(hasSubtreeUnset(ops, 'fresh'), false, 'a name the document never held cannot be deleted');
  assert.equal(hasSubtreeUnset(ops, 'keep'), false, 'the other saved row is untouched');
});

test('renaming a row and back to its saved name writes nothing about the profile', async () => {
  const { store, form } = makeStore({ backend: 'jev', systemOne: { profiles: { stable: { model: 'm' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'stable')!;

  renameRow(store, saved.id, 'scratch');
  renameRow(store, saved.id, 'stable');
  // A round trip is not a change: the diff must not delete the row it keeps.
  assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);
  const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[] }[];
  assert.equal(hasSubtreeUnset(ops, 'stable'), false, `a no-op rename deleted the live row: ${profileOps(ops).join(' | ')}`);
  assert.equal(hasSubtreeUnset(ops, 'scratch'), false, 'the scratch name was never saved');
});

test('an explicit activation choice wins over following a rename', async () => {
  // Following the renamed row is a *default*, not an override: a draft that sets
  // `active` deliberately — to another row, or to none at all — is the user's
  // decision and must be written as asked on the same save.
  for (const [chosen, expected] of [
    ['b', 'b'],
    ['', '']
  ] as const) {
    const { store, form } = makeStore({ backend: 'jev', systemOne: { active: 'a', profiles: { a: { model: 'ma' }, b: { model: 'mb' } } } });
    const rows = () => store.getState().draft.backend.profiles as any[];
    const a = rows().find((row) => row.name === 'a')!;
    store.edit((current) => ({
      ...current,
      backend: {
        ...current.backend,
        active: chosen,
        profiles: current.backend.profiles.map((row: any) => (row.id === a.id ? { ...row, name: 'a2' } : row))
      }
    }));
    assert.equal(store.getState().draft.backend.active, expected, `renaming overrode the chosen activation (${JSON.stringify(chosen)})`);
    assert.equal(await store.save(), true, `the save went through: ${store.getState().errors}`);
    const ops = form.mutations.flatMap((mutation) => mutation.ops) as { op: string; path: string[]; value?: unknown }[];
    const written = ops.find((op) => op.path.join('.') === 'systemOne.active');
    // A chosen row is written; clearing is never a lone `unset` (which the Host
    // would rebuild as `{}`, resurrecting the factory row — g-067). Either way it
    // is what the user asked for, not what the rename implies.
    if (chosen.length === 0) assert.notEqual(written?.op, 'unset', 'clearing must not be an unset');
    else assert.equal(written?.value, chosen, 'the chosen row must be the one written');
    assert.equal(hasSubtreeUnset(ops, 'a'), true, 'the old name is still deleted');
  }
});

test('renaming an inactive row leaves the activation where it is', async () => {
  const { store } = makeStore({ backend: 'jev', systemOne: { active: 'b', profiles: { a: { model: 'ma' }, b: { model: 'mb' } } } });
  const rows = () => store.getState().draft.backend.profiles as any[];
  renameRow(store, rows().find((row) => row.name === 'a')!.id, 'a2');
  // The activated row (`b`) was not the one renamed, so its name stays put.
  assert.equal(store.getState().draft.backend.active, 'b', 'an unrelated rename stole the activation');
});

//#endregion

test('a rename that would lose a stored key is refused before anything is written', async () => {
  // Criterion 4 at the store: the guard is in `save`, not in the page's copy, so
  // it holds for any caller — and it refuses *before* building ops, leaving the
  // document untouched and the typed name in the draft.
  //
  // The key *presence* is driven the way production drives it: through the panel
  // snapshot, which reports `apiKeyPresent` per profile (the page never sees a
  // value). A hand-set `apiKeyPresent` on the draft would be erased by the next
  // re-seed — which is exactly what a save does — so the fact has to come from
  // the snapshot to survive.
  const { store, form } = storeWithStoredKey({ systemOne: { active: 'old', profiles: { old: { model: 'm1' } } } });
  await store.refresh();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'old')!;
  assert.equal(saved.apiKeyPresent, true, 'the snapshot facts did not reach the row');
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) => (row.id === saved.id ? { ...row, name: 'renamed' } : row))
    }
  }));

  assert.equal(await store.save(), false, 'the rename must be refused');
  assert.deepEqual(plain(form.mutations), [], 'a refused rename wrote to the document');
  const state = store.getState();
  assert.ok(state.errors.includes('errProfileRenameKey'), `wrong reason: ${state.errors.join(',')}`);
  assert.equal(state.errorValues.errProfileRenameKey, 'old → renamed', 'the message must name the row');
  assert.notEqual(state.notice, 'saved');
  // The draft is intact: the user's typed name is still there to be paired with
  // a retyped key.
  assert.ok(rows().some((row) => row.name === 'renamed'), 'the refused save discarded the rename');

  // Retyping the key in that row makes the same save legal.
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) => (row.name === 'renamed' ? { ...row, apiKey: 'sk-retyped' } : row))
    }
  }));
  assert.equal(await store.save(), true, `the retyped save went through: ${store.getState().errors}`);
  const ops = (plain(form.mutations) as { ops: { op: string; path: string[]; value?: unknown }[] }[]).flatMap((mutation) => mutation.ops);
  assert.ok(hasSubtreeUnset(ops, 'old'), 'the old subtree must still be retired');
  const key = ops.find((op) => op.op === 'set' && op.path.join('.') === 'systemOne.profiles.renamed.apiKey');
  assert.equal(key?.value, 'sk-retyped', 'the new path must receive the retyped key');
});

test('renaming an env-backed connection saves without asking for the key again', async () => {
  // The other half of criterion 4: the guard must not block a rename that cannot
  // lose anything, or every deployment using an environment variable would be
  // unable to rename its connection.
  const { store, form } = storeWithStoredKey(
    { backend: 'jev', systemOne: { active: 'old', profiles: { old: { model: 'm1', apiKeyEnv: 'MY_KEY' } } } },
    false
  );
  await store.refresh();
  const rows = () => store.getState().draft.backend.profiles as any[];
  const saved = rows().find((row) => row.name === 'old')!;
  assert.equal(saved.apiKeyPresent, true, 'the environment resolved, so a key is present');
  assert.equal(saved.apiKeyFromProfile, false, 'but it is not a stored literal');
  store.edit((current) => ({
    ...current,
    backend: {
      ...current.backend,
      profiles: current.backend.profiles.map((row: any) => (row.id === saved.id ? { ...row, name: 'renamed' } : row))
    }
  }));
  assert.equal(await store.save(), true, `an env-backed rename was refused: ${store.getState().errors}`);
  const ops = (plain(form.mutations) as { ops: { op: string; path: string[] }[] }[]).flatMap((mutation) => mutation.ops);
  assert.ok(hasSubtreeUnset(ops, 'old'), 'the old subtree is retired');
  assert.ok(
    ops.some((op) => op.op === 'set' && op.path.join('.') === 'systemOne.profiles.renamed.apiKeyEnv'),
    'the variable name travels to the new path'
  );
});
