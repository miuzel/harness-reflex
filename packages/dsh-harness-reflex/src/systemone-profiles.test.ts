import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, connectionTarget, resolveApiKey, resolveConfig, resolveSystemOneConfig } from './config.js';

/**
 * System One connections: the active profile is the *only* connection (g-066),
 * its model list, and the write-only key.
 *
 * What changed with g-066, and what these tests therefore pin instead of the old
 * chain (`active profile > flat block > environment > default`):
 *
 * - the flat block is gone from the schema and from the resolution. A document
 *   that still carries those keys does **not** connect; it resolves to
 *   `unconfigured: 'legacy-config-required'`, so the owner learns why instead of
 *   silently running an address they had forgotten about;
 * - with no valid active profile there are **no connection fields at all** — not
 *   a fallback, not a default — which is what makes "no external request" a
 *   property of the resolution rather than a promise somewhere downstream;
 * - a connection may list several model ids and select one, and both the runtime
 *   and the probe read that same selected id.
 */

test('a document without an active profile resolves to nothing, and says why', () => {
  // No profiles at all.
  assert.deepEqual(resolveSystemOneConfig(undefined, undefined), { backend: 'auto', unconfigured: 'no-profiles' });
  assert.deepEqual(resolveSystemOneConfig('jev', { profiles: {} }), {
    backend: 'jev',
    unconfigured: 'no-profiles'
  });
  // Profiles exist, none activated: the "pick one for me" behaviour is gone.
  assert.equal(
    resolveSystemOneConfig('jev', { profiles: { a: { baseUrl: 'http://a' } } }).unconfigured,
    'no-active-profile'
  );
  // The active name matches nothing.
  const missing = resolveSystemOneConfig('jev', { active: 'prod', profiles: { production: { baseUrl: 'http://real' } } });
  assert.equal(missing.unconfigured, 'active-profile-missing');
  assert.equal(missing.activeProfileMissing, true);
  assert.equal(missing.active, 'prod', 'the authored name is reported as authored');
  assert.equal(missing.baseUrl, undefined, 'no connection field may be invented');
  // Nothing at all is configured *and* nothing is claimed.
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'apiKey', 'timeoutMs'] as const) {
    assert.equal(missing[field], undefined, `${field} must stay absent when nothing is activated`);
  }
});

test('the pre-g-066 flat fields are reported, never used to connect', () => {
  const legacy = { baseUrl: 'http://flat', model: 'flat-model', apiKeyEnv: 'FLAT_KEY', timeoutMs: 5000 };
  const resolved = resolveSystemOneConfig('jev', legacy);
  assert.equal(resolved.unconfigured, 'legacy-config-required', 'an old-shaped document is diagnosed, not honoured');
  assert.equal(resolved.baseUrl, undefined, 'the flat address must not reach the transport');
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.apiKeyEnv, undefined);
  assert.equal(resolved.timeoutMs, undefined);
  // A document that has both a profile and leftover flat fields connects through
  // the *profile*, and the leftovers change nothing.
  const both = resolveSystemOneConfig('jev', {
    ...legacy,
    active: 'p',
    profiles: { p: { baseUrl: 'http://profile', model: 'profile-model' } }
  });
  assert.equal(both.unconfigured, undefined);
  assert.equal(both.baseUrl, 'http://profile');
  assert.equal(both.model, 'profile-model');
  assert.equal(both.apiKeyEnv, undefined, 'no field is inherited from the flat block');
  assert.equal(both.timeoutMs, undefined);
});

test('a profile states every field it uses, and nothing is inherited from anywhere', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'fast',
    profiles: {
      fast: { baseUrl: 'http://fast', model: 'fast-model', timeoutMs: 800 },
      slow: { baseUrl: 'http://slow', model: 'slow-model', timeoutMs: 9000 }
    }
  });
  assert.equal(resolved.active, 'fast');
  assert.equal(resolved.baseUrl, 'http://fast');
  assert.equal(resolved.model, 'fast-model');
  assert.equal(resolved.timeoutMs, 800);
  assert.equal(resolved.apiKeyEnv, undefined, 'an unstated field stays undefined: the backend decides');
  assert.deepEqual(Object.keys(resolved.profiles ?? {}), ['fast', 'slow'], 'every profile is carried, in authored order');

  // A bare profile resolves bare: it borrows neither the other profile's address
  // nor any block's.
  const bare = resolveSystemOneConfig('jev', { active: 'bare', profiles: { bare: {}, other: { baseUrl: 'http://other' } } });
  assert.equal(bare.unconfigured, undefined);
  assert.equal(bare.baseUrl, undefined);
  assert.equal(bare.model, undefined);
});

test('a profile may override the backend for itself only', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'local',
    profiles: { local: { backend: 'vllm', baseUrl: 'http://127.0.0.1:8000' } }
  });
  assert.equal(resolved.backend, 'vllm', 'the active profile may switch the implementation');
});

test('profile names are validated against what the settings path can address', () => {
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { 'a.b': { model: 'm' } } }),
    /must not contain "\."/,
    'a dot is the settings path separator'
  );
  assert.throws(() => resolveSystemOneConfig('jev', { profiles: { '': { model: 'm' } } }), /non-empty profile names/);
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { Prod: { model: 'm' }, prod: { model: 'm2' } } }),
    /differing only in case/,
    'two rows the panel cannot tell apart'
  );
});

test('per-profile values are validated', () => {
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { p: { timeoutMs: 0 } } }),
    /profiles\["p"\]\.timeoutMs must be a positive integer/
  );
  assert.throws(() => resolveSystemOneConfig('jev', { profiles: { p: { backend: 'telepathy' } } }), /profiles\["p"\]\.backend must be one of/);
  assert.throws(() => resolveSystemOneConfig('jev', { profiles: { p: null as never } }), /must be an object of connection settings/);
  assert.throws(() => resolveSystemOneConfig('jev', { profiles: [] as never }), /must be a dictionary/);
});

//#region the model list (g-066)

test('a connection lists any number of models and runs the selected one', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'gw',
    profiles: { gw: { baseUrl: 'http://gw', modelIds: ['a', 'b', 'c'], selectedModel: 'b' } }
  });
  assert.equal(resolved.model, 'b', 'the runtime sends the selected model');
  assert.deepEqual(resolved.profiles?.gw.modelIds, ['a', 'b', 'c']);
  assert.equal(resolved.activeProfileModelMissing, undefined);
  // The probe reads the same selection: this is the "test what you run" rule.
  const target = connectionTarget(resolved, 'gw', resolved.profiles!.gw);
  assert.equal(target.model, 'b', 'the connection test probes the selected model');
});

test('a selection outside the list resolves to no model, and is reported', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'gw',
    profiles: { gw: { modelIds: ['a', 'b'], selectedModel: 'c' } }
  });
  assert.equal(resolved.model, undefined, 'never silently runs the first id instead');
  assert.equal(resolved.activeProfileModelMissing, true);
  // ... and the probe sends no model either, so the two cannot disagree.
  assert.equal(connectionTarget(resolved, 'gw', resolved.profiles!.gw).model, undefined);
});

test('a one-model connection is the same shape either way it is authored', () => {
  const legacy = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { model: 'only' } } });
  const listed = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { modelIds: ['only'] } } });
  assert.equal(legacy.model, 'only', 'a pre-g-066 connection keeps working untouched');
  assert.equal(listed.model, 'only');
  assert.deepEqual(legacy.profiles?.p.modelIds, ['only'], 'the legacy id becomes a one-entry list downstream');
  assert.equal(listed.profiles?.p.modelIds?.[0], 'only');
});

test('naming no selection means the first listed model', () => {
  const resolved = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { modelIds: ['first', 'second'] } } });
  assert.equal(resolved.model, 'first');
  assert.equal(resolved.activeProfileModelMissing, undefined);
});

test('a model list is validated, and the two authored shapes may not be mixed', () => {
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { p: { modelIds: 'not-a-list' as never } } }),
    /modelIds must be a list of model ids/
  );
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { p: { modelIds: ['a', '  '] } } }),
    /modelIds\[1\] must be a non-empty model id/
  );
  assert.throws(
    () => resolveSystemOneConfig('jev', { profiles: { p: { model: 'a', modelIds: ['b'] } } }),
    /authors both model and modelIds/
  );
  // The same id twice is one choice, not two rows.
  const deduped = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { modelIds: ['a', 'a', 'b'] } } });
  assert.deepEqual(deduped.profiles?.p.modelIds, ['a', 'b']);
});

test('the schema materializes an empty modelIds beside a legacy model, and that is not a mix', () => {
  // schemastery fills `modelIds: []` for every profile that declares the field,
  // so a legacy `model: x` reaches the resolver as `{ model: 'x', modelIds: [] }`.
  // Rejecting that pairing would reject every pre-g-066 connection on load.
  const resolved = resolveConfig({ systemOne: { active: 'a', profiles: { a: { model: 'ma' } } } });
  assert.equal(resolved.systemOne.model, 'ma');
  assert.deepEqual(resolved.systemOne.profiles?.a.modelIds, ['ma']);
});

//#endregion

test('the key chain prefers a profile key over the environment variable name', () => {
  const env = { SHARED_KEY: 'sk-from-env' };
  // 1. A profile key wins over the variable the same block names.
  assert.equal(resolveApiKey({ apiKey: 'sk-from-profile', apiKeyEnv: 'SHARED_KEY' }, env), 'sk-from-profile');
  // 2. Without a profile key, the variable answers — the pre-g-057 behaviour.
  assert.equal(resolveApiKey({ apiKeyEnv: 'SHARED_KEY' }, env), 'sk-from-env');
  // 3. Neither: no key, and that is not an error.
  assert.equal(resolveApiKey({}, env), undefined);
  assert.equal(resolveApiKey({ apiKeyEnv: 'MISSING' }, env), undefined);
  // 4. An empty string is "unset", not "an empty credential".
  assert.equal(resolveApiKey({ apiKey: '', apiKeyEnv: 'SHARED_KEY' }, env), 'sk-from-env');
});

test('apiKey is the one schema-declared secret of the connection block', () => {
  // The declared role is the whole mechanism: DSH's structural redaction walks
  // the schema, through `z.dict()` entries by `node.inner`, and drops every
  // secret slot from a value before it crosses a wire boundary.
  const schema = Config as any;
  const block = schema.dict.systemOne;
  const profile = block.dict.profiles.inner;
  assert.equal(profile.dict.apiKey.meta.role, 'secret', 'apiKey must be declared role("secret")');
  // Nothing else may be secret: a secret `baseUrl` would be stripped from the
  // panel and the user could never read back their own address.
  for (const field of ['baseUrl', 'model', 'modelIds', 'selectedModel', 'apiKeyEnv', 'timeoutMs', 'backend']) {
    assert.notEqual(profile.dict[field].meta.role, 'secret', `${field} must stay readable`);
  }
  for (const field of ['profiles', 'active']) {
    assert.notEqual(block.dict[field]?.meta?.role, 'secret', `${field} must stay readable`);
  }
  // A secret slot must not carry a default: that would materialize a value
  // nobody typed.
  assert.equal(profile.dict.apiKey.meta.default, undefined);
});

test('the schema declares no flat connection fields any more', () => {
  // Undeclared is what makes a written document keep them byte for byte:
  // schemastery re-states only what it declares, so the page cannot convert or
  // delete an old deployment's fields as a side effect of an unrelated save.
  const block = (Config as any).dict.systemOne;
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs']) {
    assert.equal(block.dict[field], undefined, `systemOne.${field} must no longer be declared`);
  }
  for (const field of ['profiles', 'active']) {
    assert.notEqual(block.dict[field], undefined, `systemOne.${field} must stay declared`);
  }
  // The profile grew exactly the two model-list fields.
  const profile = block.dict.profiles.inner;
  for (const field of ['modelIds', 'selectedModel']) {
    assert.notEqual(profile.dict[field], undefined, `systemOne.profiles.*.${field} must be declared`);
  }
});

test('a profile key survives resolution so the runtime can present it', () => {
  const resolved = resolveSystemOneConfig('jev', { active: 'a', profiles: { a: { apiKey: 'sk-live-profile' } } });
  assert.equal(resolved.apiKey, 'sk-live-profile');
  assert.equal(resolveApiKey(resolved, {}), 'sk-live-profile');
});

test('the full Config schema accepts multi-profile blocks and keeps them', () => {
  const resolved = resolveConfig({
    systemOne: {
      active: 'a',
      profiles: { a: { baseUrl: 'http://a', model: 'ma', apiKey: 'sk-abcdef123456' }, b: { model: 'mb' } }
    }
  });
  assert.equal(resolved.systemOne.active, 'a');
  assert.equal(resolved.systemOne.baseUrl, 'http://a');
  assert.equal(resolved.systemOne.model, 'ma');
  assert.equal(resolved.systemOne.apiKey, 'sk-abcdef123456', 'the loader must not drop the secret on the way in');
  assert.equal(resolved.systemOne.profiles?.b.modelIds?.[0], 'mb');
});

test('a legacy-shaped document round-trips through the loader without connecting', () => {
  // The important half is the second: the loader must keep reading the old keys
  // (so the diagnosis exists), and must not turn them into a connection.
  const resolved = resolveConfig({ backend: 'jev', systemOne: { apiKeyEnv: 'LEGACY_KEY' } });
  assert.equal(resolved.systemOne.apiKeyEnv, undefined, 'a legacy document resolves no variable');
  assert.equal(resolved.systemOne.apiKey, undefined, 'a legacy deployment gains no key');
  assert.equal(resolved.systemOne.unconfigured, 'legacy-config-required');
  assert.equal(resolveApiKey(resolved.systemOne, { LEGACY_KEY: 'sk-legacy' }), undefined, 'and presents no key either');
});

test('connectionTarget projects one profile and nothing else', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'fast',
    profiles: { fast: { baseUrl: 'http://fast', model: 'fast-model', apiKey: 'sk-fast' }, bare: {} }
  });
  const fast = connectionTarget(resolved, 'fast', resolved.profiles!.fast);
  assert.equal(fast.baseUrl, 'http://fast', 'the probe sends the address the runtime would send');
  assert.equal(fast.model, 'fast-model');
  assert.equal(fast.apiKey, 'sk-fast');
  assert.equal(fast.apiKeyEnv, undefined);
  assert.equal(fast.timeoutMs, undefined);

  const bare = connectionTarget(resolved, 'bare', resolved.profiles!.bare);
  assert.equal(bare.model, undefined, 'a bare profile inherits nothing — not even from the active profile');
  assert.equal(bare.apiKey, undefined, 'a profile without a key does not inherit one');
  assert.equal(bare.baseUrl, undefined);
  assert.equal(bare.backend, 'jev', 'the implementation fallback is the only inherited fact');
});

//#region switching the selected model (g-066 criterion 2)

/**
 * The model the *runtime* would send for a document.
 *
 * These tests exist because the runtime and the probe must read one field: a
 * selection that changes what `systemOne.model` resolves to is a selection that
 * changes the very next request.
 * @param systemOne - the authored block.
 * @returns the resolved model id, or `undefined`.
 */
function runtimeModel(systemOne: Parameters<typeof resolveSystemOneConfig>[1]): string | undefined {
  return resolveSystemOneConfig('jev', systemOne).model;
}

test('switching the selected model changes what the runtime sends, without touching anything else', () => {
  const profile = { baseUrl: 'http://gw', modelIds: ['a', 'b', 'c'], timeoutMs: 900 };
  assert.equal(runtimeModel({ active: 'p', profiles: { p: { ...profile, selectedModel: 'a' } } }), 'a');
  assert.equal(runtimeModel({ active: 'p', profiles: { p: { ...profile, selectedModel: 'b' } } }), 'b');
  assert.equal(runtimeModel({ active: 'p', profiles: { p: { ...profile, selectedModel: 'c' } } }), 'c');
  // Everything that is not the model is unchanged by the switch: the switch is
  // one field, not a re-declaration of the connection.
  const base = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { ...profile, selectedModel: 'a' } } });
  const switched = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: { ...profile, selectedModel: 'b' } } });
  assert.equal(switched.baseUrl, base.baseUrl);
  assert.equal(switched.timeoutMs, base.timeoutMs);
  assert.deepEqual(switched.profiles?.p.modelIds, ['a', 'b', 'c'], 'the list is the same list');
});

test('switching the selection also switches what the connection test probes', () => {
  // The single rule of criterion 2: one selected model, read by the runtime and
  // by the probe. A test button that probed a different id would report on a
  // request the plugin never sends.
  for (const selectedModel of ['a', 'b']) {
    const resolved = resolveSystemOneConfig('jev', {
      active: 'p',
      profiles: { p: { baseUrl: 'http://gw', modelIds: ['a', 'b'], selectedModel } }
    });
    const target = connectionTarget(resolved, 'p', resolved.profiles!.p);
    assert.equal(target.model, selectedModel, 'the probe tests the selected model');
    assert.equal(resolved.model, target.model, 'the runtime and the probe read the same field');
  }
});

test('an inactive profile does not affect what the runtime sends', () => {
  // Only the active profile connects: a second profile — however many models it
  // offers, whatever it selects — cannot leak into the running connection.
  const resolved = resolveSystemOneConfig('jev', {
    active: 'active',
    profiles: {
      active: { baseUrl: 'http://a', modelIds: ['m1', 'm2'], selectedModel: 'm1' },
      idle: { baseUrl: 'http://b', modelIds: ['x', 'y'], selectedModel: 'y' }
    }
  });
  assert.equal(resolved.model, 'm1', 'the active profile decides');
  assert.equal(resolved.baseUrl, 'http://a', 'and so does its address');
  // ... while the inactive row still *describes* itself honestly when asked.
  const idle = connectionTarget(resolved, 'idle', resolved.profiles!.idle);
  assert.equal(idle.model, 'y');
  assert.equal(idle.baseUrl, 'http://b');
});

test('an invalid selection degrades to "no model", never to a different one', () => {
  // The three ways a selection can be unusable, each answered the same way.
  const cases: { label: string; profile: Record<string, unknown> }[] = [
    { label: 'not in the list', profile: { modelIds: ['a', 'b'], selectedModel: 'zzz' } },
    { label: 'list emptied under the selection', profile: { modelIds: [], selectedModel: 'a' } },
    { label: 'legacy id replaced', profile: { model: 'a', selectedModel: 'b' } }
  ];
  for (const { label, profile } of cases) {
    const resolved = resolveSystemOneConfig('jev', { active: 'p', profiles: { p: profile as never } });
    assert.equal(resolved.model, undefined, `${label}: nothing may be sent`);
    assert.equal(resolved.activeProfileModelMissing, true, `${label}: the panel must be able to say why`);
    // The rest of the connection still resolves: the model is the broken part,
    // and refusing the whole activation would take every tool down for it.
    assert.equal(resolved.unconfigured, undefined, `${label}: the connection itself is configured`);
  }
});

test('a legacy connection keeps working and can still be given a selection', () => {
  // The compatibility half of criterion 2: `model` alone is a one-entry list.
  assert.equal(runtimeModel({ active: 'p', profiles: { p: { model: 'only' } } }), 'only');
  // And naming that same id as the selection is a no-op, not a conflict.
  assert.equal(runtimeModel({ active: 'p', profiles: { p: { model: 'only', selectedModel: 'only' } } }), 'only');
});

//#endregion
