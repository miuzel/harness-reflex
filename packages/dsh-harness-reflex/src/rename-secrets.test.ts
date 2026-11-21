import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Keeping a write-only key across a rename (g-066, criterion 4).
 *
 * The key cannot be read back by this page (it is a `role('secret')` slot), and
 * the Host retires the old `systemOne.profiles.<name>` subtree in the same save,
 * so a rename is the one operation that can destroy a credential *silently*. The
 * plan under test is the whole defence: it decides, per row, whether the key is
 * carried (the user retyped it), irrelevant (it comes from an environment
 * variable), or about to be lost (blocked, with the row named in the message).
 *
 * Every case below is a distinct way a user can arrive at a rename, because the
 * failure mode is "the save worked and the key is gone" — nothing else in the
 * system notices.
 *
 * The module is exercised through the built client artifact, like the other
 * browser-half suites: `src/client/**` compiles with the client tsconfig (no
 * Node types), so its tests live here and load `dist-client/<name>.js`.
 */

/** The slice of `./rename-secrets` this suite drives. */
interface RenameSecretsModule {
  SERVER_SIDE_SECRET_MOVE: boolean;
  planRenameSecrets(original: any, draft: any): {
    restated: Array<{ from: string; to: string }>;
    blocked: Array<{ from: string; to: string; reason: string }>;
    serverMove: boolean;
  };
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

const panel = loadModule('panel');
const secrets = loadModule('rename-secrets') as unknown as RenameSecretsModule;

/** One draft row, saved or not, with the fields these rules read. */
function row(name: string, overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: overrides.id ?? `id-${name}`,
    name,
    baseUrl: 'http://gw',
    modelIds: 'm1',
    selectedModel: 'm1',
    legacyModelShape: false,
    apiKeyEnv: '',
    timeoutMs: '',
    backend: '',
    apiKey: '',
    apiKeyPresent: false,
    apiKeyFromProfile: false,
    apiKeyVariable: '',
    apiKeySource: 'env',
    apiKeyLocked: false,
    clearKey: false,
    ...overrides
  };
}

/** A draft holding `profiles`, active on the first one. */
function draft(rows: Record<string, any>[]): Record<string, any> {
  return { ...panel.EMPTY_DRAFT, backend: { ...panel.EMPTY_DRAFT.backend, active: rows[0]?.name ?? '', profiles: rows } };
}

/** A saved row whose key is a literal stored in the document. */
function stored(name: string, overrides: Record<string, unknown> = {}): Record<string, any> {
  return row(name, { apiKeyPresent: true, apiKeyFromProfile: true, apiKeySource: 'profile', ...overrides });
}

/** Cross-realm comparison: JSON round-trips a value out of the module sandbox. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test('an unchanged name never touches the key', () => {
  const saved = draft([stored('a'), stored('b')]);
  const edited = draft([{ ...saved.backend.profiles[0], modelIds: 'm2', selectedModel: 'm2' }, saved.backend.profiles[1]]);
  const plan = secrets.planRenameSecrets(saved, edited);
  assert.deepEqual(plain(plan.blocked), [], 'editing a field is not a rename');
  assert.deepEqual(plain(plan.restated), []);
});

test('renaming a row whose key is stored blocks the save, naming both names', () => {
  const saved = draft([stored('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new' }]);
  const plan = secrets.planRenameSecrets(saved, renamed);
  assert.equal(plan.blocked.length, 1);
  assert.deepEqual(
    plain(plan.blocked.map((entry) => ({ from: entry.from, to: entry.to, reason: entry.reason }))),
    [{ from: 'old', to: 'new', reason: 'not-restated' }],
    'the ordinary rename of a stored key must be refused, with the reason named'
  );
  assert.deepEqual(plain(plan.restated), []);
});

test('retyping the key in the same save carries it', () => {
  const saved = draft([stored('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new', apiKey: 'sk-typed' }]);
  const plan = secrets.planRenameSecrets(saved, renamed);
  assert.deepEqual(plain(plan.blocked), [], 'the draft states what the new path holds');
  assert.deepEqual(plain(plan.restated), [{ from: 'old', to: 'new' }]);
});

test('an explicit clear is a decision, not a loss', () => {
  // The user asked for the key to go: the row is renamed *and* cleared on
  // purpose, so there is nothing to warn about.
  const saved = draft([stored('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new', clearKey: true }]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, renamed).blocked), []);
});

test('a key that comes from an environment variable survives a rename untouched', () => {
  // Nothing is stored in the document: the profile *names* a variable, and the
  // rename only changes which name the row is saved under. Blocking here would
  // make renaming any env-backed connection impossible for no reason.
  const saved = draft([row('old', { apiKeyPresent: true, apiKeyFromProfile: false, apiKeyEnv: 'MY_KEY', apiKeySource: 'env' })]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new' }]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, renamed).blocked), []);
});

test('a row with no key at all is never blocked', () => {
  const saved = draft([row('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new' }]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, renamed).blocked), []);
});

test('an unsaved row cannot lose a key, because it has no path yet', () => {
  // `apiKeyPresent` on an unsaved row describes nothing the Host holds, so a
  // rename there cannot destroy a stored value.
  const saved = draft([]);
  const renamed = draft([row('brand-new', { apiKeyPresent: true, apiKeyFromProfile: true })]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, renamed).blocked), []);
});

test('removing a row is not a rename: the key goes with it by design', () => {
  const saved = draft([stored('a'), stored('b')]);
  const removed = draft([saved.backend.profiles[1]]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, removed).blocked), []);
});

test('a collision with another saved row is refused even when the key is retyped', () => {
  // `b` is renamed onto `a`'s name while `a` is still saved under it: the two
  // rows now write the same path, and the loser's key disappears with no field
  // the user touched. Naming this apart from a plain rename matters because the
  // fix is different — it is not "retype the key", it is "pick another name".
  const saved = draft([stored('a'), stored('b')]);
  const collided = draft([saved.backend.profiles[0], { ...saved.backend.profiles[1], name: 'a', apiKey: 'sk-typed' }]);
  const plan = secrets.planRenameSecrets(saved, collided);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0]!.reason, 'joined-occupied-path');
  assert.deepEqual(plain({ from: plan.blocked[0]!.from, to: plan.blocked[0]!.to }), { from: 'b', to: 'a' });
});

test('swapping two names is refused, because neither key follows its own row', () => {
  // `a`→`b` and `b`→`a` in one save: each old subtree is retired and each new
  // path is written from the *other* row. `from`/`to` alone cannot say whose key
  // survives, so both directions are refused rather than one silently winning.
  const saved = draft([stored('a'), stored('b')]);
  const swapped = draft([
    { ...saved.backend.profiles[0], name: 'b' },
    { ...saved.backend.profiles[1], name: 'a' }
  ]);
  const plan = secrets.planRenameSecrets(saved, swapped);
  assert.equal(plan.blocked.length, 2);
  assert.deepEqual(
    plain(plan.blocked.map((entry) => entry.reason)),
    ['swap', 'swap'],
    'each half of a swap is called out as a swap'
  );
});

test('a swap is safe once both keys are retyped in the same save', () => {
  // The user restated both values, so the resulting document has exactly the
  // keys the draft describes — nothing is lost, and the save may proceed.
  const saved = draft([stored('a'), stored('b')]);
  const swapped = draft([
    { ...saved.backend.profiles[0], name: 'b', apiKey: 'sk-for-b' },
    { ...saved.backend.profiles[1], name: 'a', apiKey: 'sk-for-a' }
  ]);
  const plan = secrets.planRenameSecrets(saved, swapped);
  assert.deepEqual(plain(plan.blocked), []);
  assert.deepEqual(plain(plan.restated), [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' }
  ]);
});

test('renaming onto a name that was just freed is allowed', () => {
  // `b` is deleted and `a` takes over its name: no saved row answers for `b`
  // any more, so there is no collision, and the deleted row's key was dropped on
  // purpose.
  const saved = draft([stored('a'), stored('b')]);
  const moved = draft([{ ...saved.backend.profiles[0], name: 'b', apiKey: 'sk-retyped' }]);
  assert.deepEqual(plain(secrets.planRenameSecrets(saved, moved).blocked), []);
});

test('a row that is renamed twice before one save blocks once', () => {
  // Only the saved name matters: `old` → `mid` → `new` is one rename.
  const saved = draft([stored('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new' }]);
  const plan = secrets.planRenameSecrets(saved, renamed);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0]!.from, 'old');
});

test('the plan never claims a server-side move this Host cannot perform', () => {
  // The settings surface a plugin page is given can only `set` a path to a value
  // the page holds, and it never holds the key — so a cross-path move does not
  // exist, and the plan says so instead of pretending. Were a Host to grow one,
  // this constant and the move in `PanelStore.save` are the two things to change.
  assert.equal(secrets.SERVER_SIDE_SECRET_MOVE, false);
  const saved = draft([stored('old')]);
  const renamed = draft([{ ...saved.backend.profiles[0], name: 'new' }]);
  assert.equal(secrets.planRenameSecrets(saved, renamed).serverMove, false);
});
