import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, connectionTarget, resolveApiKey, resolveConfig, resolveSystemOneConfig } from './config.js';

/**
 * Multi-profile System One connections (g-057): the data model, the precedence
 * chain, and the write-only key.
 *
 * The chain these tests pin is `active profile > flat block > environment >
 * default`. This module owns the first two steps; the last two stay inside the
 * backends, so an unresolved field must stay `undefined` rather than be filled
 * in here — a test asserting that is what keeps env-configured deployments (the
 * pre-g-057 shape) honest.
 */

test('a block without profiles resolves to exactly its pre-g-057 shape', () => {
  // The whole backward-compatibility promise: no `profiles` key appears out of
  // nowhere, because that key would show up in every resolved config dump.
  assert.deepEqual(resolveSystemOneConfig(undefined, undefined), { backend: 'auto' });
  assert.deepEqual(
    resolveSystemOneConfig('jev', { baseUrl: 'http://gw', model: 'm', apiKeyEnv: 'K', timeoutMs: 1000 }),
    { backend: 'jev', baseUrl: 'http://gw', model: 'm', apiKeyEnv: 'K', timeoutMs: 1000 }
  );
  assert.equal(resolveSystemOneConfig(undefined, { profiles: {} }).profiles, undefined, 'an empty dictionary is "no profiles"');
});

test('the active profile wins field by field over the flat block', () => {
  const resolved = resolveSystemOneConfig('jev', {
    baseUrl: 'http://flat',
    model: 'flat-model',
    apiKeyEnv: 'FLAT_KEY',
    timeoutMs: 5000,
    active: 'fast',
    profiles: {
      fast: { baseUrl: 'http://fast', model: 'fast-model', timeoutMs: 800 },
      slow: { baseUrl: 'http://slow', model: 'slow-model', timeoutMs: 9000 }
    }
  });
  assert.equal(resolved.active, 'fast');
  assert.equal(resolved.baseUrl, 'http://fast', 'profile baseUrl replaces the flat one');
  assert.equal(resolved.model, 'fast-model');
  assert.equal(resolved.timeoutMs, 800);
  // Not stated by the profile: the flat block still answers.
  assert.equal(resolved.apiKeyEnv, 'FLAT_KEY', 'an omitted profile field falls through to the flat block');
  assert.deepEqual(Object.keys(resolved.profiles ?? {}), ['fast', 'slow'], 'every profile is carried, in authored order');
});

test('a profile inherits every flat field it does not state', () => {
  const resolved = resolveSystemOneConfig('jev', {
    baseUrl: 'http://flat',
    model: 'flat-model',
    timeoutMs: 5000,
    active: 'bare',
    profiles: { bare: { model: 'only-model' } }
  });
  assert.equal(resolved.baseUrl, 'http://flat');
  assert.equal(resolved.model, 'only-model');
  assert.equal(resolved.timeoutMs, 5000);
});

test('a profile may override the backend for itself only', () => {
  const resolved = resolveSystemOneConfig('jev', {
    active: 'local',
    profiles: { local: { backend: 'vllm', baseUrl: 'http://127.0.0.1:8000' } }
  });
  assert.equal(resolved.backend, 'vllm', 'the active profile may switch the implementation');
});

test('an active name that matches no profile is reported, never silently dropped', () => {
  // The user mistyped a name. Failing the activation would take every reflex
  // tool down over one character, so the chain continues at the flat block — but
  // the mistake must reach the panel, which is what this flag is for.
  const resolved = resolveSystemOneConfig('jev', {
    baseUrl: 'http://flat',
    model: 'flat-model',
    active: 'prod',
    profiles: { production: { baseUrl: 'http://real' } }
  });
  assert.equal(resolved.activeProfileMissing, true);
  assert.equal(resolved.active, 'prod', 'the authored name is reported as authored');
  assert.equal(resolved.baseUrl, 'http://flat', 'resolution falls back to the flat block');
  assert.equal(resolved.model, 'flat-model');

  // A name that does match is not flagged.
  const ok = resolveSystemOneConfig('jev', { active: 'production', profiles: { production: { baseUrl: 'http://real' } } });
  assert.equal(ok.activeProfileMissing, undefined);
  assert.equal(ok.baseUrl, 'http://real');
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
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs', 'backend']) {
    assert.notEqual(profile.dict[field].meta.role, 'secret', `${field} must stay readable`);
  }
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs', 'active']) {
    assert.notEqual(block.dict[field]?.meta?.role, 'secret', `flat ${field} must stay readable`);
  }
  // A secret slot must not carry a default: that would materialize a value
  // nobody typed.
  assert.equal(profile.dict.apiKey.meta.default, undefined);
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
  assert.equal(resolved.systemOne.profiles?.b.model, 'mb');
});

test('a resolveConfig round trip keeps the flat apiKeyEnv behaviour unchanged', () => {
  const resolved = resolveConfig({ backend: 'jev', systemOne: { apiKeyEnv: 'LEGACY_KEY' } });
  assert.equal(resolved.systemOne.apiKeyEnv, 'LEGACY_KEY');
  assert.equal(resolved.systemOne.apiKey, undefined, 'a legacy deployment gains no key');
  assert.equal(resolved.systemOne.profiles, undefined);
  assert.equal(resolveApiKey(resolved.systemOne, { LEGACY_KEY: 'sk-legacy' }), 'sk-legacy');
});

test('connectionTarget merges a profile over the flat block for the probe', () => {
  const authored = {
    baseUrl: 'http://flat',
    model: 'flat-model',
    apiKeyEnv: 'FLAT_KEY',
    timeoutMs: 4000,
    active: 'fast',
    profiles: { fast: { model: 'fast-model', apiKey: 'sk-fast' }, bare: {} }
  };
  const resolved = resolveSystemOneConfig('jev', authored);
  // The probe target is resolved against the block as authored, without the
  // active profile folded in — otherwise "bare profile over block" would silently
  // borrow the *fast* profile's address.
  const { active: _active, ...flat } = resolveSystemOneConfig('jev', { ...authored, active: undefined });

  const fast = connectionTarget(flat, 'fast', resolved.profiles?.fast);
  assert.equal(fast.baseUrl, 'http://flat', 'the probe sends the address the runtime would send');
  assert.equal(fast.model, 'fast-model');
  assert.equal(fast.apiKey, 'sk-fast');
  assert.equal(fast.apiKeyEnv, 'FLAT_KEY');
  assert.equal(fast.timeoutMs, 4000);

  const bare = connectionTarget(flat, 'bare', resolved.profiles?.bare);
  assert.equal(bare.model, 'flat-model', 'a bare profile inherits the flat model, not another profile\'s');
  assert.equal(bare.apiKey, undefined, 'a profile without a key does not inherit one from the active profile');
  assert.equal(bare.baseUrl, 'http://flat');
});
