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
  profileRowsFrom(value: unknown): any[];
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

const panel = loadModule('panel') as unknown as PanelModule;

/** One profile row with the supplied overrides. */
function row(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    name: 'primary',
    baseUrl: '',
    model: '',
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

/** Whether any write targets the whole `systemOne` group. */
function hasGroupWrite(writes: { path: string[] }[]): boolean {
  return writes.some((write) => write.path.length === 1 && write.path[0] === 'systemOne');
}

/** The write targeting one exact path. */
function writeAt(writes: { path: string[]; value?: unknown }[], path: string[]): { path: string[]; value?: unknown } | undefined {
  return writes.find((write) => write.path.length === path.length && write.path.every((segment, index) => segment === path[index]));
}

test('the page never writes the systemOne group, which would delete a stored key', () => {
  const writes = panel.groupWrites(draftWith([row({ model: 'm1' }), row({ name: 'secondary', baseUrl: 'http://b' })]), 'backend');
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
  assert.equal(primary.model, 'm1');
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
      profiles: seeded.backend.profiles.map((profile: any) => ({ ...profile, model: 'new-model', apiKeyPresent: true, apiKeyFromProfile: true }))
    }
  };
  const writes = panel.groupWrites(edited, 'backend');
  assert.equal(hasGroupWrite(writes), false);
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'apiKey']), undefined, 'the stored key survives');
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'model'])?.value, 'new-model');
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
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'baseUrl'])?.value, undefined, 'inherits the flat block again');
  assert.equal(writeAt(writes, ['systemOne', 'profiles', 'primary', 'model'])?.value, 'm1', 'the untouched field is kept');
});

test('an unnamed row is skipped because it cannot become a settings path', () => {
  const writes = panel.groupWrites(draftWith([row({ name: '', model: 'm' })]), 'backend');
  assert.equal(writes.some((write) => write.path.includes('')), false, 'an empty path segment would be invalid');
});

test('the active name is written, and an empty one is an unset rather than left stale', () => {
  assert.equal(writeAt(panel.groupWrites(draftWith([row()], 'secondary'), 'backend'), ['systemOne', 'active'])?.value, 'secondary');
  assert.equal(writeAt(panel.groupWrites(draftWith([row()], ''), 'backend'), ['systemOne', 'active'])?.value, undefined);
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
