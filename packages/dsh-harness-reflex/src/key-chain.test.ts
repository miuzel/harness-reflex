import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_KEY_ENV_FALLBACKS,
  resolveApiKey,
  resolveApiKeyWithSource,
  resolveConfig,
  resolveSystemOneConfig,
  type ResolvedApiKey
} from './config.js';
import { createBackend } from './bridge.js';
import { apiKeyFacts, profileKeyPresence } from './panel-mount.js';
import { buildProbeRequest } from './systemone-probe.js';
import { JevDecisionBackend } from './vendor/harness-reflex/backend/jev.js';
import { SimpleJevDecisionBackend } from './vendor/harness-reflex/backend/simple-jev.js';

/**
 * One API-key chain (g-058).
 *
 * The bug these tests exist to make unrepresentable: the panel resolved the key
 * with a two-step chain (`apiKey`, then the *one* variable `apiKeyEnv` named)
 * while the backends resolved it with a longer one (`apiKey`, then a fallback
 * list of four variables). A deployment that named `SYSTEM_ONE_API_KEY` while
 * exporting only `JEV_API_KEY` therefore *worked* and reported "the environment
 * variable is empty".
 *
 * Every case here drives an injected `env` object and never reads the real
 * process environment: a host with `OPENAI_API_KEY` exported would otherwise
 * make half of these assertions true for the wrong reason.
 */

/** The fallback list, in the order the chain documents. */
const CHAIN = ['SYSTEM_ONE_API_KEY', 'JEV_API_KEY', 'VLLM_API_KEY', 'OPENAI_API_KEY'] as const;

/** One environment holding exactly one chain variable. */
function only(variable: string, value = `sk-${variable}`): Record<string, string> {
  return { [variable]: value };
}

/**
 * Read a backend's private `apiKey` field.
 *
 * The field is genuinely private (a credential must not be a public property), so
 * the test reaches for it deliberately rather than widening the production type
 * for a test's convenience.
 * @param backend - the constructed backend.
 * @returns the key the backend will present.
 */
function privateKey(backend: object): unknown {
  return (backend as unknown as { apiKey: unknown }).apiKey;
}

test('the exported fallback list is the documented chain', () => {
  assert.deepEqual([...API_KEY_ENV_FALLBACKS], [...CHAIN]);
});

test('each fallback variable alone resolves the key and names itself', () => {
  for (const variable of CHAIN) {
    const resolved = resolveApiKeyWithSource({}, only(variable));
    assert.equal(resolved?.key, `sk-${variable}`, `${variable} alone must supply the key`);
    assert.equal(resolved?.source, 'env');
    assert.equal(resolved?.variable, variable, 'the chain must report which variable answered');
  }
});

test('nothing in the environment resolves no key at all', () => {
  // Not even a source: a caller must not have to distinguish "absent" from
  // "present but empty" when it only wants to know whether a key exists.
  assert.equal(resolveApiKeyWithSource({}, {}), undefined);
  assert.equal(resolveApiKey({}, {}), undefined);
});

test('the fallback order is the documented priority, not merely membership', () => {
  // Every non-empty prefix of the chain must win with the *first* member it has.
  for (let start = 0; start < CHAIN.length; start += 1) {
    const env: Record<string, string> = {};
    for (const variable of CHAIN.slice(start)) env[variable] = `sk-${variable}`;
    const resolved = resolveApiKeyWithSource({}, env);
    assert.equal(resolved?.variable, CHAIN[start], `${CHAIN[start]} must outrank the ones after it`);
    assert.equal(resolved?.key, `sk-${CHAIN[start]}`);
  }
  // And a later variable alone still answers when the earlier ones are absent.
  assert.equal(resolveApiKeyWithSource({}, only('OPENAI_API_KEY'))?.variable, 'OPENAI_API_KEY');
});

test('an empty or blank chain variable is skipped, not treated as a key', () => {
  // An exported-but-blank variable is the classic shell accident; it must not
  // shadow a working one further down the chain, nor become an empty credential.
  assert.equal(resolveApiKeyWithSource({}, { SYSTEM_ONE_API_KEY: '', JEV_API_KEY: 'sk-jev' })?.variable, 'JEV_API_KEY');
  assert.equal(resolveApiKeyWithSource({}, { SYSTEM_ONE_API_KEY: '', JEV_API_KEY: '', VLLM_API_KEY: 'sk-vllm' })?.variable, 'VLLM_API_KEY');
  assert.equal(
    resolveApiKeyWithSource({}, { SYSTEM_ONE_API_KEY: '', JEV_API_KEY: '', VLLM_API_KEY: '', OPENAI_API_KEY: '' }),
    undefined,
    'a chain of empty variables is no key'
  );
});

test('a named apiKeyEnv wins over the fallback list', () => {
  const resolved = resolveApiKeyWithSource({ apiKeyEnv: 'MY_GATEWAY_KEY' }, {
    MY_GATEWAY_KEY: 'sk-named',
    SYSTEM_ONE_API_KEY: 'sk-system-one',
    JEV_API_KEY: 'sk-jev'
  });
  assert.equal(resolved?.key, 'sk-named');
  assert.equal(resolved?.variable, 'MY_GATEWAY_KEY');
});

test('a named apiKeyEnv that is empty falls through to the fallback list', () => {
  // This is the regression the old chain caused at the *panel* layer, and the
  // behaviour the backends always had: naming a variable is not a request to
  // lock onto it. "Naming locks" would have to be stated explicitly; it cannot
  // be inferred from an empty value.
  const named = { apiKeyEnv: 'SYSTEM_ONE_API_KEY' };
  assert.equal(resolveApiKeyWithSource(named, { SYSTEM_ONE_API_KEY: '', JEV_API_KEY: 'sk-jev' })?.variable, 'JEV_API_KEY');
  assert.equal(resolveApiKeyWithSource(named, {})?.variable, undefined, 'nothing anywhere is no key');
  // Naming a variable *nobody* exports behaves the same way.
  assert.equal(resolveApiKeyWithSource({ apiKeyEnv: 'NOT_EXPORTED' }, only('JEV_API_KEY'))?.variable, 'JEV_API_KEY');
});

test('the JEV_API_KEY-only deployment that started this bug now reads as ready', () => {
  // The exact reported shape: the settings name SYSTEM_ONE_API_KEY, the shell
  // exports only JEV_API_KEY. Before g-058 the panel said "empty" while the
  // backend worked.
  const systemOne = resolveSystemOneConfig('jev', { apiKeyEnv: 'SYSTEM_ONE_API_KEY' });
  const facts = apiKeyFacts(systemOne, only('JEV_API_KEY'));
  assert.equal(facts.apiKeyPresent, true);
  assert.equal(facts.apiKeySource, 'env');
  assert.equal(facts.apiKeyVariable, 'JEV_API_KEY');
  // The panel-side presence helper agrees with the main projection.
  assert.equal(profileKeyPresence({ profiles: { p: { apiKeyEnv: 'SYSTEM_ONE_API_KEY' } } }, only('JEV_API_KEY')).p.variable, 'JEV_API_KEY');
});

test('a literal profile key outranks every environment variable', () => {
  const env: Record<string, string> = {};
  for (const variable of CHAIN) env[variable] = `sk-${variable}`;
  env.NAMED = 'sk-named';
  const resolved = resolveApiKeyWithSource({ apiKey: 'sk-literal', apiKeyEnv: 'NAMED' }, env);
  assert.equal(resolved?.key, 'sk-literal');
  assert.equal(resolved?.source, 'profile');
  assert.equal(resolved?.variable, undefined, 'a profile key has no variable to report');
  // And an empty literal is not a key: the chain continues.
  assert.equal(resolveApiKeyWithSource({ apiKey: '', apiKeyEnv: 'NAMED' }, env)?.variable, 'NAMED');
});

test('an active profile key outranks the environment through the resolver', () => {
  const resolved = resolveConfig({
    backend: 'jev',
    systemOne: { active: 'a', profiles: { a: { apiKey: 'sk-profile' } } }
  });
  assert.deepEqual(resolveApiKeyWithSource(resolved.systemOne, only('JEV_API_KEY')), { key: 'sk-profile', source: 'profile' });
  assert.equal(apiKeyFacts(resolved.systemOne, only('JEV_API_KEY')).apiKeyVariable, undefined);
});

test('the panel facts never carry the key value', () => {
  // The projection hands the page a boolean, a source tag, and a *name*. A value
  // here would be a credential crossing the wire on every poll.
  const facts = apiKeyFacts({}, { JEV_API_KEY: 'sk-super-secret-value' });
  assert.deepEqual(facts, { apiKeyPresent: true, apiKeySource: 'env', apiKeyVariable: 'JEV_API_KEY' });
  assert.equal(JSON.stringify(facts).includes('sk-super-secret-value'), false, 'no key substring may serialize');
  const perProfile = profileKeyPresence({ profiles: { p: {} } }, { JEV_API_KEY: 'sk-super-secret-value' });
  assert.equal(JSON.stringify(perProfile).includes('sk-super-secret-value'), false);
});

test('the readiness facts are absent-by-default rather than "source: undefined"', () => {
  const facts = apiKeyFacts({}, {});
  assert.deepEqual(facts, { apiKeyPresent: false });
  assert.equal('apiKeySource' in facts, false, 'an absent key has no source to report');
});

test('the probe sends the key the chain resolves, so the test button matches the runtime', () => {
  // The named variable is empty; the key lives in the fallback. The probe must
  // present JEV_API_KEY, exactly as a real request would after g-058.
  const named = { name: 'p', backend: 'jev', baseUrl: 'http://gw/v1/systemone', model: 'm', apiKeyEnv: 'SYSTEM_ONE_API_KEY' };
  const built = buildProbeRequest(named, only('JEV_API_KEY'));
  assert.ok('spec' in built, 'the probe must be buildable');
  if (!('spec' in built)) return;
  assert.equal(built.spec.authorization, 'Bearer sk-JEV_API_KEY');

  // And a literal profile key outranks the environment here too.
  const literal = buildProbeRequest({ ...named, apiKey: 'sk-literal' }, only('JEV_API_KEY'));
  assert.ok('spec' in literal);
  if (!('spec' in literal)) return;
  assert.equal(literal.spec.authorization, 'Bearer sk-literal');
});

test('createBackend hands the chain-resolved key to both backends', () => {
  // The point of building the backend through the chain: the transport's key and
  // the panel's "ready" verdict are the same resolution, so they cannot diverge.
  const config = resolveConfig({ backend: 'jev', systemOne: { apiKeyEnv: 'SYSTEM_ONE_API_KEY' } });
  const jev = createBackend(config, only('JEV_API_KEY'));
  assert.ok(jev instanceof JevDecisionBackend);
  assert.equal(privateKey(jev), 'sk-JEV_API_KEY', 'jev must receive the fallback key explicitly');

  const vllmConfig = resolveConfig({
    backend: 'vllm',
    systemOne: { baseUrl: 'http://localhost:8000', apiKeyEnv: 'SYSTEM_ONE_API_KEY' }
  });
  const vllm = createBackend(vllmConfig, only('VLLM_API_KEY'));
  assert.ok(vllm instanceof SimpleJevDecisionBackend);
  assert.equal(privateKey(vllm), 'sk-VLLM_API_KEY', 'vllm must receive the fallback key explicitly');
});

test('createBackend passes no key when the chain resolves none, so the backend keeps its own default', () => {
  // An undeclared key stays undeclared: `simple-jev` falls back to its documented
  // `dummy` placeholder, and forcing `''` here would silently change that.
  const config = resolveConfig({ backend: 'vllm', systemOne: { baseUrl: 'http://localhost:8000' } });
  const vllm = createBackend(config, {});
  assert.equal(privateKey(vllm), 'dummy');
});

test('resolveApiKey is a thin wrapper over the one chain', () => {
  // Not merely "also works": the wrapper must agree with the full resolver for
  // every shape the chain can take, or the two spellings drift apart again.
  const cases: { config: { apiKey?: string; apiKeyEnv?: string }; env: Record<string, string | undefined> }[] = [
    { config: {}, env: {} },
    { config: { apiKey: 'sk-a' }, env: {} },
    { config: { apiKey: '', apiKeyEnv: 'K' }, env: { K: 'sk-k' } },
    { config: { apiKeyEnv: 'K' }, env: { K: '' } },
    { config: { apiKeyEnv: 'K' }, env: only('OPENAI_API_KEY') },
    { config: {}, env: { SYSTEM_ONE_API_KEY: 'sk-s', JEV_API_KEY: 'sk-j' } }
  ];
  for (const { config, env } of cases) {
    const full: ResolvedApiKey | undefined = resolveApiKeyWithSource(config, env);
    assert.equal(resolveApiKey(config, env), full?.key, JSON.stringify({ config, env }));
  }
});
