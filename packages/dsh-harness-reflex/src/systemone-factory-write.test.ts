/**
 * g-067 — the factory connection through the **Host's settings write path**.
 *
 * `systemone-factory.test.ts` pins what a *document* means. This file pins what
 * the page's writes turn into, because the distinction the goal needs — "the
 * owner said nothing" versus "the owner said no" — is decided by the Host, not
 * by the resolver:
 *
 * - `dsh-settings` `write()` takes the stored driver value, strips the volatile
 *   subtrees, then merges the new form value in;
 * - `mutate()` applies path ops through `applyPathOp`, which **clears a path by
 *   rebuilding its parent**: unsetting `systemOne.active` on a document that has
 *   no other keys stores `systemOne: {}`.
 *
 * Both are reproduced here exactly as the Host implements them, against the
 * plugin's **real** `Config` schema (the same object the loader validates with),
 * so a change in either the page's writes or the schema's defaults shows up as a
 * broken round-trip rather than as a surprise in a running profile.
 *
 * The round-trips asserted below are the whole save/delete story the goal names:
 * save an unrelated field, deactivate, delete the row, and reload after each.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import z from '@deepseek-ai/schemastery';

import { Config, FACTORY_PROFILE_NAME, plainConfig, resolveConfig, type ReflexConfig } from './config.js';

//#region the built page

/**
 * The built client modules, evaluated in a sandbox.
 *
 * The page is a *browser* module: the Host `tsconfig` excludes `src/client`, and
 * the release check refuses a `dist/client/` directory (that is why the browser
 * half ships as the single `client.js` bundle). Importing the TypeScript module
 * directly would make `tsc` emit exactly that forbidden directory, so the
 * committed built form is loaded the same way the page's own tests load it.
 */
interface PanelModule {
  EMPTY_DRAFT: Record<string, any>;
  diffDraft(original: unknown, draft: unknown, user?: unknown): { op: string; path: string[]; value?: unknown }[];
  draftFromConfig(value: unknown): any;
}

/** Evaluate one built CommonJS client module and return its exports. */
function loadClientModule(name: string): Record<string, any> {
  const file = fileURLToPath(new URL(`../dist-client/${name}.js`, import.meta.url));
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    module,
    exports: module.exports,
    require: (spec: string) => {
      const local = /^\.\/([a-z-]+)$/.exec(spec);
      if (local === null) throw new Error(`unexpected require "${spec}"`);
      return loadClientModule(local[1] as string);
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

const panel = loadClientModule('panel') as PanelModule;
const EMPTY_DRAFT = panel.EMPTY_DRAFT as PanelDraft;
const diffDraft = panel.diffDraft as (original: PanelDraft, draft: PanelDraft) => SettingsOp[];

/** Editable draft of one connection profile (see `panel.ts`). */
interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  modelIds: string;
  selectedModel: string;
  legacyModelShape: boolean;
  apiKeyEnv: string;
  timeoutMs: string;
  backend: string;
  apiKey: string;
  apiKeyPresent: boolean;
  apiKeyFromProfile: boolean;
  apiKeyVariable: string;
  apiKeySource: string;
  apiKeyLocked: boolean;
  clearKey: boolean;
}

/** Editable draft of the whole page. */
interface PanelDraft {
  backend: { backend: string; active: string; storedActive?: string; profiles: ProfileDraft[] };
  [group: string]: any;
}

//#endregion

//#region a faithful reproduction of the Host write path

/** One path-addressed edit, as `dsh-settings` `SettingsPathOp` spells it. */
type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] };

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `plainSchema()` of `dsh-settings/src/schema.ts`: the form schema the write
 * path uses. Volatile marks are dropped and **secret defaults are stripped**;
 * every other default is kept. This matters: it decides which defaults
 * `applyPathOp` fills in for a path it has to create.
 * @param schema - a schemastery node.
 * @returns the form copy.
 */
function plainSchema(schema: any): any {
  // `z(node)` is schemastery's own copy constructor; `.toJSON()` yields a ref
  // table (`{uid, refs}`) rather than a node description, so it cannot be used
  // to rebuild one.
  const result: any = z(schema as never);
  const walk = (node: any): void => {
    delete node.meta.volatile;
    if (node.meta.role === 'secret') {
      delete node.meta.default;
      delete node.meta.required;
    }
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}

/** `applyPathOp()` of `dsh-settings/src/index.ts`, verbatim in behaviour. */
function applyPathOp(section: Record<string, unknown>, op: SettingsOp, schema: any): Record<string, unknown> {
  const edit = (input: unknown, path: readonly string[], node: any): unknown => {
    const [head, ...rest] = path;
    if (head === undefined) return op.op === 'set' ? op.value : undefined;
    const value: unknown = input === undefined ? node?.meta?.default : input;
    const result = isPlainObject(value) ? { ...value } : {};
    const child = edit(Object.hasOwn(result, head) ? result[head] : undefined, rest, node?.dict?.[head] ?? node?.inner);
    if (child === undefined) Reflect.deleteProperty(result, head);
    else result[head] = child;
    return result;
  };
  const next = edit(section, op.path, schema);
  assert.ok(isPlainObject(next), 'the Host requires a plain object root');
  return next;
}

/** `projectForm()` of `dsh-settings/src/schema.ts`: only declared fields survive. */
function projectForm(schema: any, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field: unknown = Reflect.get(value as object, key);
        return field === undefined ? [] : [[key, projectForm(child, field)]];
      })
    );
  }
  return value;
}

/** `mergeLayers()` of `dsh-settings/src/index.ts`. */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over;
  const merged: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value;
  }
  return merged;
}

/** `strip()` of `SettingsForms#write`: drop the volatile subtrees from the stored value. */
function strip(value: Record<string, unknown>, schema: any): Record<string, unknown> {
  if (schema.meta?.volatile === true) return {};
  const result = { ...value };
  for (const [key, field] of Object.entries(schema.dict ?? {})) {
    if ((field as any).meta?.volatile === true) Reflect.deleteProperty(result, key);
    else if (isPlainObject(result[key])) result[key] = strip(result[key] as Record<string, unknown>, field);
  }
  return result;
}

/** The `systemOne` form schema the Host derives for this plugin. */
const FORM_SYSTEMONE = plainSchema((Config as any).dict.systemOne);

/**
 * Apply the page's operations the way a real save does.
 *
 * A `set` of a whole group replaces that subtree; a path op goes through
 * `applyPathOp` against the *current* stored value (projected to declared
 * fields, as `SettingsForms#write` does).
 * @param stored - the document as the profile patch holds it (absent = `{}`).
 * @param ops - what the page emitted.
 * @returns the document the next load reads.
 */
function applyOps(stored: Record<string, unknown>, ops: readonly SettingsOp[]): Record<string, unknown> {
  // `strip(raw, form)` over the whole config: only the volatile fields go, so a
  // stored row survives a save that writes an authation beside it.
  const written = mergeLayers(strip(stored, Config as any), {});
  const result = { ...(written as Record<string, unknown>) };
  let section = result.systemOne as Record<string, unknown> | undefined;
  for (const op of ops) {
    const [group, ...rest] = op.path;
    // A save of another group (the test edits `toolPrefix`) lands on its own path
    // and must leave the connection block alone — that is the point of the case.
    if (group !== 'systemOne') {
      if (op.op === 'set') result[group as string] = op.value;
      else delete result[group as string];
      continue;
    }
    if (rest.length === 0) {
      section = (op.op === 'set' ? op.value : undefined) as Record<string, unknown> | undefined;
      continue;
    }
    const current = projectForm(FORM_SYSTEMONE, section ?? {}) as Record<string, unknown>;
    section = applyPathOp(current, { op: op.op, path: rest, value: (op as { value?: unknown }).value } as SettingsOp, FORM_SYSTEMONE);
  }
  if (section === undefined) delete result.systemOne;
  else result.systemOne = section;
  return result;
}

/** Reload a stored document the way the loader does. */
function reload(stored: Record<string, unknown>): ReturnType<typeof resolveConfig> {
  return resolveConfig(plainConfig(Config(stored)) as ReflexConfig);
}

//#endregion

//#region drafts shaped like the page's

/** One factory-shaped row, as the page drafts it. */
function factoryRow(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    id: 'row-1',
    name: FACTORY_PROFILE_NAME,
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    modelIds: 'jev-latest',
    selectedModel: '',
    legacyModelShape: true,
    apiKeyEnv: 'JEV_API_KEY',
    timeoutMs: '',
    backend: '',
    apiKey: '',
    apiKeyPresent: false,
    apiKeyFromProfile: false,
    apiKeyVariable: 'JEV_API_KEY',
    apiKeySource: 'env',
    apiKeyLocked: false,
    clearKey: false,
    ...overrides
  } as ProfileDraft;
}

/** A draft as the page seeds it from a stored document. */
function draftFor(rows: ProfileDraft[], active: string, storedActive: string): PanelDraft {
  return {
    ...EMPTY_DRAFT,
    backend: { backend: 'auto', active, storedActive, profiles: rows }
  };
}

//#endregion

test('saving an unrelated field on a fresh document does not author the factory activation', () => {
  // The trap: the page drafts the *resolved* activation, so a naive save would
  // write `active: 'JEV official'` on the first edit of anything and turn the
  // factory default into a decision. After that, deactivating would have to
  // fight a stored name.
  // The page seeds from the *resolved* form value, so a fresh document drafts the
  // factory row as active — and `storedActive` says the same, which is exactly the
  // state in which the activation must not be written.
  const fresh = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const edited = { ...fresh, runtime: { ...fresh.runtime, toolPrefix: 'rv_' } };
  const ops = diffDraft(fresh, edited);
  // Cross-realm: the operations were built in the sandbox, so each `path` is an
  // array from *that* realm. `join` is called on the array itself (never a
  // prototype copied across), which is why the comparison is on the joined
  // string rather than on the array.
  const connectionOps = ops.filter((op) => String(op.path[0]) === 'systemOne');
  assert.deepEqual(
    JSON.parse(JSON.stringify(connectionOps)),
    [],
    `an unrelated save must not author the connection block: ${JSON.stringify(ops)}`
  );

  // And the reloaded document still resolves to the factory connection, this
  // time without any authored section at all.
  const stored = applyOps({}, diffDraft(fresh, edited));
  const resolved = reload(stored);
  assert.equal(resolved.systemOne.active, FACTORY_PROFILE_NAME);
  assert.deepEqual(Object.keys(resolved.systemOne.profiles ?? {}), [FACTORY_PROFILE_NAME]);
});

test('the page has no way to leave a half-cleared section behind', () => {
  // The activation is cleared only as a consequence of removing/renaming the row
  // that was active, never by a dedicated "off" control — so every write that
  // leaves `active` empty also writes the rows. This asserts the consequence:
  // there is no draft edit whose diff consists of a lone activation clear.
  const fresh = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  for (const draft of [
    draftFor([factoryRow({ name: 'renamed' })], '', ''),
    draftFor([], '', ''),
    draftFor([factoryRow()], '', '')
  ]) {
    const ops = diffDraft(fresh, draft);
    const only = ops.filter((op) => op.path.join('.') === 'systemOne.active');
    if (only.length === 0) continue;
    assert.ok(ops.length > only.length, `a lone activation write is a half-cleared section: ${JSON.stringify(ops)}`);
  }
});

test('deleting the factory row survives a save and a reload', () => {
  const fresh = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const deleted = draftFor([], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const ops = diffDraft(fresh, deleted);
  assert.ok(
    ops.some((op) => op.op === 'unset' && op.path.join('.') === `systemOne.profiles.${FACTORY_PROFILE_NAME}`),
    'the row subtree must be unset'
  );
  const stored = applyOps({}, ops);
  const resolved = reload(stored);
  assert.deepEqual(resolved.systemOne.profiles ?? {}, {}, 'a deleted row must not come back');
  assert.equal(resolved.systemOne.unconfigured, 'no-profiles');
  assert.equal(resolved.systemOne.baseUrl, undefined, 'nothing may connect after the deletion');
});

test('a document whose row was deleted stays that way across a later unrelated save', () => {
  // Deleting the row is the "remove it" escape: the section must then keep saying
  // "no rows" — an unrelated later edit must not bring the factory row back.
  const fresh = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const stored = applyOps({}, diffDraft(fresh, draftFor([], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME)));
  assert.equal(reload(stored).systemOne.unconfigured, 'no-profiles', `after the delete: ${JSON.stringify(stored.systemOne)}`);
  // The page re-seeds from that resolved document: no rows, no activation.
  const reseeded = draftFor([], '', '');
  const after = applyOps(stored, diffDraft(reseeded, { ...reseeded, effort: { ...reseeded.effort, fallback: 'high' } }));
  const resolved = reload(after);
  assert.deepEqual(resolved.systemOne.profiles ?? {}, {}, 'the deleted row must not come back');
  assert.equal(resolved.systemOne.unconfigured, 'no-profiles');
});

test('the page never writes a bare `{systemOne: {}}`, which the schema would not default', () => {
  // Whatever the draft does, a save that touches the connection block must state
  // something. `{}` is the one shape the factory default cannot reach.
  const seed = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const drafts: PanelDraft[] = [
    draftFor([factoryRow()], '', ''),
    draftFor([], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME),
    draftFor([], '', ''),
    draftFor([factoryRow({ baseUrl: '' })], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME)
  ];
  for (const draft of drafts) {
    const ops = diffDraft(seed, draft);
    const stored = applyOps({}, ops);
    const section = stored.systemOne as Record<string, unknown> | undefined;
    if (section === undefined) continue; // nothing written: the factory default still applies
    assert.notDeepEqual(section, {}, 'an empty section is indistinguishable from a fresh document');
  }
});

test('a fresh document that never saves the connection block is not re-stated', () => {
  // Writing the resolved connection back would freeze today's factory values
  // into the owner's document — and, for `active`, author a decision nobody
  // made. `groupWrites` describes one draft (it is a pure projection), so the
  // guarantee lives in the *diff*: two drafts that differ only outside the
  // connection block produce no connection write.
  const fresh = draftFor([factoryRow()], FACTORY_PROFILE_NAME, FACTORY_PROFILE_NAME);
  const edited = { ...fresh, effort: { ...fresh.effort, fallback: 'high' } };
  const ops = diffDraft(fresh, edited);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ops.filter((op) => String(op.path[0]) === 'systemOne'))),
    [],
    JSON.stringify(ops)
  );
  // The projection itself is a description of the whole block (it lists the row's
  // fields), which is why the guarantee is stated on the diff above: a description
  // is not a write. The reload confirms the document keeps resolving the same.
  const resolved = reload(applyOps({}, ops));
  assert.equal(resolved.systemOne.active, FACTORY_PROFILE_NAME);
});
