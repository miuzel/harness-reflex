import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, INTERVENTION_CAPABILITIES } from './config.js';
import { REFLEX_TOOL_SUFFIXES } from './tools.js';

/**
 * Which configuration paths the Host lets a settings form write.
 *
 * `dsh-settings` refuses a write before it validates anything else: every path an
 * op addresses must be *volatile*, and a path is volatile when the schema node it
 * names — or any node above it — carries the `volatile` meta. The rule below is
 * that check transcribed from `@deepseek-ai/dsh-settings` (`isVolatilePath`), so
 * this file can state the contract the settings panel depends on without
 * importing the Host's private module.
 *
 * The panel had exactly this bug once: it addressed the Host with its own *view*
 * group names, and `runtime` is not a field of `Config` at all, so every save from
 * the System 1 backend page was refused with `Config field "runtime" is not
 * volatile`. These assertions are the fence that keeps a group name from standing
 * in for a schema path again.
 */

/** The part of a schemastery node this audit walks. */
interface SchemaNode {
  meta: { volatile?: boolean; role?: string };
  dict?: Record<string, SchemaNode>;
  /** Element schema of a `dict`/`array` node, which is where profiles live. */
  inner?: SchemaNode;
}

/** The schema under test, narrowed to the shape the audit walks. */
const root = Config as unknown as SchemaNode;

/**
 * Whether the Host would accept a write at `path`.
 * @param schema - schema node to walk.
 * @param path - path segments, outermost first.
 * @returns whether the path is writable under the Host's rule.
 */
function isVolatilePath(schema: SchemaNode, path: readonly string[]): boolean {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}

test('every top-level configuration field is writable by the settings panel', () => {
  const keys = Object.keys(root.dict ?? {});
  assert.deepEqual(
    keys,
    ['backend', 'toolPrefix', 'ledgerPath', 'pruneThreshold', 'calibrationPath', 'systemOne', 'routing', 'effort', 'tools', 'delegation', 'interventions'],
    'the settings surface changed shape; the panel pages must be revisited'
  );
  for (const key of keys) {
    assert.ok(isVolatilePath(root, [key]), `the Host refuses a write to "${key}": it is not volatile`);
  }
});

test('the System 1 backend block is writable field by field', () => {
  // The block itself is volatile, which is what makes its every field writable —
  // including any field a later version adds. Naming each one keeps the audit
  // honest: a field that moves out of the block has to keep a volatile parent.
  // g-066 removed the four flat connection fields: a connection is one active
  // profile, so the block itself holds only the profiles and which one is in
  // force. Their absence is asserted below, because a silently re-declared flat
  // field would bring the implicit fallback back.
  const fields = ['profiles', 'active'];
  assert.deepEqual(Object.keys(root.dict?.systemOne?.dict ?? {}), fields, 'the System 1 block changed shape');
  for (const field of fields) {
    assert.ok(isVolatilePath(root, ['systemOne', field]), `systemOne.${field} is not writable`);
  }
  // The multi-profile block (g-057): the panel writes each profile's fields on a
  // narrow path, so every one of them must be writable — including `apiKey`,
  // which is a `role('secret')` slot but is still an ordinary writable leaf. The
  // role governs *reads*, not writes: the page has to be able to store a key.
  // `modelIds`/`selectedModel` are the g-066 model list; `model` stays because a
  // one-model connection keeps working untouched.
  const profileFields = ['baseUrl', 'model', 'modelIds', 'selectedModel', 'apiKey', 'apiKeyEnv', 'timeoutMs', 'backend'];
  const profileNode = root.dict?.systemOne?.dict?.profiles as (SchemaNode & { inner?: SchemaNode }) | undefined;
  assert.deepEqual(Object.keys(profileNode?.inner?.dict ?? {}), profileFields, 'the profile shape changed');
  for (const field of profileFields) {
    assert.ok(
      isVolatilePath(root, ['systemOne', 'profiles', 'primary', field]),
      `systemOne.profiles.<name>.${field} is not writable`
    );
  }
  assert.equal(profileNode?.inner?.dict?.apiKey?.meta.role, 'secret', 'apiKey must stay a declared secret');
  // The flat block is gone: an undeclared field is one a save cannot address, so
  // a document that still carries it keeps it exactly as written.
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs']) {
    assert.equal(root.dict?.systemOne?.dict?.[field], undefined, `systemOne.${field} must not be declared any more`);
  }
  // Sibling blocks the panel writes, and the dynamic dictionaries inside them.
  for (const path of [
    ['routing'],
    ['effort'],
    ['effort', 'enabled'],
    ['routing', 'models'],
    ['tools'],
    ['tools', 'enabled'],
    ...REFLEX_TOOL_SUFFIXES.map((suffix) => ['tools', 'enabled', suffix]),
    ['delegation'],
    ['delegation', 'enabled'],
    ['interventions'],
    ['interventions', 'capabilities'],
    ...INTERVENTION_CAPABILITIES.map((capability) => ['interventions', 'capabilities', capability])
  ]) {
    assert.ok(isVolatilePath(root, path), `${path.join('.')} is not writable`);
  }
});

test('a path the schema does not declare is refused, and a group-shaped value is invalid', () => {
  // The regression itself: `runtime` was the panel's group name, never a field.
  for (const path of [['runtime'], ['nope'], ['toolPrefixes']]) {
    assert.equal(isVolatilePath(root, path), false, `${path.join('.')} must not be writable`);
  }
  // A leaf under a volatile block passes the volatility gate — the Host's rule
  // never walks past a volatile ancestor — so a wrong *shape* has to be caught by
  // schema validation instead, which is how the object at `backend` was refused.
  assert.equal(isVolatilePath(root, ['routing', 'nope']), true);
  // `backend` is a scalar union, not a block: the panel used to write
  // `{backend, systemOne}` there, which the Host rejects while validating the
  // merged layer. `Config(value)` is the validation entry point `resolveConfig`
  // itself calls (`plainConfig(Config(...))`), so this is the plugin's own check.
  const validate = (value: unknown): unknown => (Config as unknown as (input: unknown) => unknown)(value);
  assert.throws(() => validate({ backend: { backend: 'jev', systemOne: { timeoutMs: 2500 } } }), /backend/);
  assert.doesNotThrow(() => validate({ backend: 'jev', systemOne: { timeoutMs: 2500 }, toolPrefix: 'reflex_' }));
});
