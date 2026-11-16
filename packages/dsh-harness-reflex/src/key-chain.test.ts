import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_KEY_ENV_FALLBACKS,
  resolveApiKey,
  resolveApiKeyWithSource,
  resolveConfig,
  resolveSystemOneConfig,
  resolvedKeyOf,
  type ApiKeyResolution,
  type ResolvedApiKey
} from './config.js';
import { createBackend } from './bridge.js';
import { apiKeyFacts, profileKeyPresence } from './panel-mount.js';
import { buildProbeRequest } from './systemone-probe.js';
import { JevDecisionBackend } from './vendor/harness-reflex/backend/jev.js';
import { SimpleJevDecisionBackend } from './vendor/harness-reflex/backend/simple-jev.js';
import { createSystemOneBackend } from './vendor/harness-reflex/backend/factory.js';

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

/**
 * Read the resolved-key branch of a resolution, failing the test when the
 * lookup instead locked or found nothing.
 *
 * The union is the point of g-059 (`{key}` vs `{missing:'named'}` vs
 * `undefined`), so tests must not silently treat a locked outcome as "no key";
 * this helper makes the *expected* branch explicit at each call site.
 * @param resolution - a {@link resolveApiKeyWithSource} result.
 * @returns the resolved-key branch.
 */
function expectKey(resolution: ApiKeyResolution | undefined): ResolvedApiKey {
  assert.ok(resolution !== undefined, 'expected a resolution, got none');
  assert.ok('key' in resolution, `expected a resolved key, got ${JSON.stringify(resolution)}`);
  return resolution;
}

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
    const resolved = expectKey(resolveApiKeyWithSource({}, only(variable)));
    assert.equal(resolved.key, `sk-${variable}`, `${variable} alone must supply the key`);
    // `fallback`, not `env`: the block named no variable, and the panel marks it
    // so a deployment that meant to name one can see it named nothing (g-059).
    assert.equal(resolved.source, 'fallback');
    assert.equal(resolved.variable, variable, 'the chain must report which variable answered');
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
    const resolved = expectKey(resolveApiKeyWithSource({}, env));
    assert.equal(resolved.variable, CHAIN[start], `${CHAIN[start]} must outrank the ones after it`);
    assert.equal(resolved.key, `sk-${CHAIN[start]}`);
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
  const resolved = expectKey(
    resolveApiKeyWithSource({ apiKeyEnv: 'MY_GATEWAY_KEY' }, {
      MY_GATEWAY_KEY: 'sk-named',
      SYSTEM_ONE_API_KEY: 'sk-system-one',
      JEV_API_KEY: 'sk-jev'
    })
  );
  assert.equal(resolved.key, 'sk-named');
  assert.equal(resolved.source, 'env', 'a named variable is `env`, not `fallback`');
  assert.equal(resolved.variable, 'MY_GATEWAY_KEY');
});

test('naming a variable locks the lookup', () => {
  // g-059 reversed the g-058 choice here. Naming a variable *is* a request to
  // lock onto it: the named variable is the only one consulted, and when it is
  // empty the answer is "missing", never a fallback variable's value. The old
  // assertion (an empty name fell through to JEV_API_KEY) is now the bug.
  const named = { apiKeyEnv: 'SYSTEM_ONE_API_KEY' };
  assert.deepEqual(resolveApiKeyWithSource(named, { SYSTEM_ONE_API_KEY: '', JEV_API_KEY: 'sk-jev' }), {
    missing: 'named',
    variable: 'SYSTEM_ONE_API_KEY'
  });
  // Naming a variable *nobody* exports locks just the same.
  assert.deepEqual(resolveApiKeyWithSource({ apiKeyEnv: 'NOT_EXPORTED' }, only('JEV_API_KEY')), {
    missing: 'named',
    variable: 'NOT_EXPORTED'
  });
  // And "named but empty" is distinguishable from "nothing named, nothing set":
  // the panel needs that difference to render two different sentences.
  assert.deepEqual(resolveApiKeyWithSource(named, {}), { missing: 'named', variable: 'SYSTEM_ONE_API_KEY' });
  assert.equal(resolveApiKeyWithSource({}, {}), undefined);
});

test('the JEV_API_KEY-only deployment that started this bug now reads as locked, not ready', () => {
  // The exact reported shape: the settings name SYSTEM_ONE_API_KEY, the shell
  // exports only JEV_API_KEY. g-058 made the panel agree with the backend by
  // letting it report JEV_API_KEY as ready; g-059 instead locks the lookup, so
  // the honest answer is "the variable you named is empty".
  const systemOne = resolveSystemOneConfig('jev', { apiKeyEnv: 'SYSTEM_ONE_API_KEY' });
  const facts = apiKeyFacts(systemOne, only('JEV_API_KEY'));
  assert.equal(facts.apiKeyPresent, false, 'a named-but-empty variable is not a key');
  assert.equal(facts.apiKeyLocked, true);
  assert.equal(facts.apiKeyVariable, 'SYSTEM_ONE_API_KEY', 'the panel names the variable that was locked onto');
  assert.equal(facts.apiKeySource, undefined, 'nothing resolved, so there is no source to report');
  // The panel-side per-profile helper agrees with the main projection.
  const perProfile = profileKeyPresence({ profiles: { p: { apiKeyEnv: 'SYSTEM_ONE_API_KEY' } } }, only('JEV_API_KEY')).p;
  assert.equal(perProfile.present, false);
  assert.equal(perProfile.locked, true);
  assert.equal(perProfile.variable, 'SYSTEM_ONE_API_KEY');
  // The key value never rides along, even in the locked state.
  assert.equal(JSON.stringify(facts).includes('sk-JEV_API_KEY'), false);
});

test('a blank apiKeyEnv is not a naming, so the fallback still runs', () => {
  // The choice the brief asked to state: only a *non-empty* name locks. A field
  // holding spaces is the classic stray keystroke, and locking onto "" or " "
  // would turn a working deployment into a missing key with no variable to fix.
  // `resolveSystemOneConfig` trims the name away, so the resolver never sees it.
  for (const blank of ['', '   ', '\t ']) {
    const systemOne = resolveSystemOneConfig('jev', { apiKeyEnv: blank });
    assert.equal(systemOne.apiKeyEnv, undefined, `a blank apiKeyEnv (${JSON.stringify(blank)}) must not survive resolution`);
    assert.deepEqual(
      resolveApiKeyWithSource(systemOne, only('JEV_API_KEY')),
      { key: 'sk-JEV_API_KEY', source: 'fallback', variable: 'JEV_API_KEY' },
      'a blank name must keep the historical fallback'
    );
  }
  // A real name locks, even when only a fallback variable is exported.
  const named = resolveSystemOneConfig('jev', { apiKeyEnv: 'SYSTEM_ONE_API_KEY' });
  assert.deepEqual(resolveApiKeyWithSource(named, only('JEV_API_KEY')), {
    missing: 'named',
    variable: 'SYSTEM_ONE_API_KEY'
  });
});

test('a literal profile key outranks every environment variable', () => {
  const env: Record<string, string> = {};
  for (const variable of CHAIN) env[variable] = `sk-${variable}`;
  env.NAMED = 'sk-named';
  const literal = expectKey(resolveApiKeyWithSource({ apiKey: 'sk-literal', apiKeyEnv: 'NAMED' }, env));
  assert.equal(literal.key, 'sk-literal');
  assert.equal(literal.source, 'profile');
  assert.equal(literal.variable, undefined, 'a profile key has no variable to report');
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
  assert.deepEqual(facts, { apiKeyPresent: true, apiKeySource: 'fallback', apiKeyVariable: 'JEV_API_KEY' });
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
  // The named variable is empty, and naming locks (g-059): the probe must send
  // NO Authorization header — exactly what the real request now sends — so a
  // locked deployment's test button surfaces the 401 instead of a false green.
  const named = { name: 'p', backend: 'jev', baseUrl: 'http://gw/v1/systemone', model: 'm', apiKeyEnv: 'SYSTEM_ONE_API_KEY' };
  const built = buildProbeRequest(named, only('JEV_API_KEY'));
  assert.ok('spec' in built, 'the probe must be buildable');
  if (!('spec' in built)) return;
  assert.equal(built.spec.authorization, undefined, 'a locked lookup sends no Authorization');
  assert.equal(JSON.stringify(built.spec).includes('sk-JEV_API_KEY'), false, 'the fallback key must not leak in');

  // With no variable named, the fallback still answers — and the probe sends it.
  const unnamed = { ...named, apiKeyEnv: undefined };
  const fallback = buildProbeRequest(unnamed, only('JEV_API_KEY'));
  assert.ok('spec' in fallback);
  if (!('spec' in fallback)) return;
  assert.equal(fallback.spec.authorization, 'Bearer sk-JEV_API_KEY');

  // And a literal profile key outranks the environment here too.
  const literal = buildProbeRequest({ ...named, apiKey: 'sk-literal' }, only('JEV_API_KEY'));
  assert.ok('spec' in literal);
  if (!('spec' in literal)) return;
  assert.equal(literal.spec.authorization, 'Bearer sk-literal');
});

test('createBackend hands the chain-resolved key to both backends', () => {
  // No variable is named, so the documented fallback answers and is handed over
  // explicitly: the transport's key and the panel's "ready" verdict are the same
  // resolution, so they cannot diverge.
  const config = resolveConfig({ backend: 'jev', systemOne: {} });
  const jev = createBackend(config, only('JEV_API_KEY'));
  assert.ok(jev instanceof JevDecisionBackend);
  assert.equal(privateKey(jev), 'sk-JEV_API_KEY', 'jev must receive the fallback key explicitly');

  const vllmConfig = resolveConfig({ backend: 'vllm', systemOne: { baseUrl: 'http://localhost:8000' } });
  const vllm = createBackend(vllmConfig, only('VLLM_API_KEY'));
  assert.ok(vllm instanceof SimpleJevDecisionBackend);
  assert.equal(privateKey(vllm), 'sk-VLLM_API_KEY', 'vllm must receive the fallback key explicitly');
});

test('createBackend pins the key: a locked lookup hands the backend no key and no second chance', () => {
  // g-059. The named variable is empty while JEV_API_KEY is exported. The chain
  // says "no key", and `apiKeyResolved: true` makes that final — without the flag
  // the backend would read JEV_API_KEY itself and the panel would lie again.
  const config = resolveConfig({ backend: 'jev', systemOne: { apiKeyEnv: 'SYSTEM_ONE_API_KEY' } });
  const jev = createBackend(config, only('JEV_API_KEY'));
  assert.ok(jev instanceof JevDecisionBackend);
  assert.equal(privateKey(jev), '', 'the locked backend holds no key, not the fallback value');

  // The logits backend would otherwise invent its `dummy` placeholder; it too is
  // handed the empty resolution verbatim.
  const vllmConfig = resolveConfig({
    backend: 'vllm',
    systemOne: { baseUrl: 'http://localhost:8000', apiKeyEnv: 'SYSTEM_ONE_API_KEY' }
  });
  const vllm = createBackend(vllmConfig, only('VLLM_API_KEY'));
  assert.ok(vllm instanceof SimpleJevDecisionBackend);
  assert.equal(privateKey(vllm), '', 'the locked logits backend holds no key, not `dummy`');
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
    const full: ApiKeyResolution | undefined = resolveApiKeyWithSource(config, env);
    assert.equal(resolveApiKey(config, env), resolvedKeyOf(full), JSON.stringify({ config, env }));
  }
});

/* -------------------------------------------------------------------------- */
/* The transport really sends no key (criterion 4)                             */
/* -------------------------------------------------------------------------- */

/**
 * One outbound request the backends made.
 *
 * Observed at the `fetch` seam rather than read off a private field: the claim
 * under test is about the *wire*, and a private field cannot distinguish "the
 * backend holds no key" from "the backend holds no key but still signs".
 */
interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

/** Replace `fetch` with a recorder that answers 200 with a usable envelope. */
function captureFetch(answer: (call: CapturedCall) => unknown): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const call = { url: String(url), headers: init?.headers ?? {} };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Drive one `choice` call so the backend actually reaches the network. */
async function makeOneRequest(backend: { choice(request: { question: string; options: string[] }): Promise<unknown> }) {
  try {
    await backend.choice({ question: 'pick', options: ['a', 'b'] });
  } catch {
    // The fixture's answer need not be a *valid* System One envelope: the
    // request has already been captured by the time parsing can fail.
  }
}

test('a locked lookup sends an unauthenticated request, and the flag defaults to the old chain', async () => {
  // Criterion 4 of g-059, asserted at the wire. `env` is read from the process by
  // the backends themselves, so it is injected here and restored afterwards.
  const saved = { SYSTEM_ONE_API_KEY: process.env.SYSTEM_ONE_API_KEY, JEV_API_KEY: process.env.JEV_API_KEY };
  process.env.SYSTEM_ONE_API_KEY = '';
  process.env.JEV_API_KEY = 'sk-only-in-the-environment';
  const stub = captureFetch(() => ({ answers: {} }));
  try {
    // (a) The plugin's backend: the block names SYSTEM_ONE_API_KEY (empty), so
    //     the chain locks and `createBackend` passes no key + `apiKeyResolved`.
    const config = resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://jev.test/v1/systemone', apiKeyEnv: 'SYSTEM_ONE_API_KEY' } });
    const plugged = createBackend(config, { JEV_API_KEY: 'sk-only-in-the-environment' });
    assert.ok(plugged instanceof JevDecisionBackend);
    await makeOneRequest(plugged);
    assert.equal(stub.calls.length, 1, 'the backend must have reached the network');
    assert.equal(
      'Authorization' in stub.calls[0]!.headers,
      false,
      'a locked lookup must not authenticate — the backend re-read the environment behind the panel'
    );

    // (b) Negative control: with the flag left at its default the very same
    //     environment DOES authenticate. This is what proves (a) is caused by the
    //     flag rather than by the environment being unreachable, and it is also
    //     what keeps `vendor-contract.test.ts`'s premise (a behaviour-identical
    //     port) true for every other construction.
    stub.calls.length = 0;
    const bare = new JevDecisionBackend({ baseUrl: 'http://jev.test/v1/systemone' });
    await makeOneRequest(bare);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-only-in-the-environment');

    // (c) The logits backend: same lock, and no invented `dummy` placeholder.
    stub.calls.length = 0;
    const vllmConfig = resolveConfig({
      backend: 'vllm',
      systemOne: { baseUrl: 'http://vllm.test', apiKeyEnv: 'SYSTEM_ONE_API_KEY' }
    });
    const vllm = createBackend(vllmConfig, { VLLM_API_KEY: 'sk-vllm-env' });
    await makeOneRequest(vllm);
    assert.equal('Authorization' in stub.calls[0]!.headers, false, 'the locked logits backend must send no key');

    // (d) And with no variable named, the fallback key is sent as before.
    stub.calls.length = 0;
    const unnamed = createBackend(resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://jev.test/v1/systemone' } }), {
      JEV_API_KEY: 'sk-only-in-the-environment'
    });
    await makeOneRequest(unnamed);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-only-in-the-environment', 'the fallback chain still works');

    // (e) A named variable that IS set is sent verbatim.
    stub.calls.length = 0;
    const named = createBackend(
      resolveConfig({ backend: 'jev', systemOne: { baseUrl: 'http://jev.test/v1/systemone', apiKeyEnv: 'MY_KEY' } }),
      { MY_KEY: 'sk-named', JEV_API_KEY: 'sk-ignored' }
    );
    await makeOneRequest(named);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-named');
  } finally {
    stub.restore();
    if (saved.SYSTEM_ONE_API_KEY === undefined) delete process.env.SYSTEM_ONE_API_KEY;
    else process.env.SYSTEM_ONE_API_KEY = saved.SYSTEM_ONE_API_KEY;
    if (saved.JEV_API_KEY === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = saved.JEV_API_KEY;
  }
});

test('the default `auto` backend honours the lock too, and still picks its provider from the environment', async () => {
  // g-059 closing hole: `auto` is the DEFAULT backend, and it delegates to the
  // factory, which used to resolve the key itself. A lock that did not hold there
  // would only be safe for people who happened to configure `jev` explicitly.
  const saved = {
    SYSTEM_ONE_BACKEND: process.env.SYSTEM_ONE_BACKEND,
    REFLEX_BACKEND: process.env.REFLEX_BACKEND,
    SYSTEM_ONE_API_KEY: process.env.SYSTEM_ONE_API_KEY,
    JEV_API_KEY: process.env.JEV_API_KEY
  };
  delete process.env.SYSTEM_ONE_BACKEND;
  delete process.env.REFLEX_BACKEND;
  process.env.SYSTEM_ONE_API_KEY = '';
  process.env.JEV_API_KEY = 'sk-only-in-the-environment';
  const stub = captureFetch(() => ({ answers: {} }));
  try {
    // `backend: 'auto'` + a named-but-empty variable: the provider is still
    // selected from the environment (only JEV_API_KEY is exported, so the Jev
    // branch wins) *and* the request goes out unauthenticated.
    const config = resolveConfig({
      backend: 'auto',
      systemOne: { baseUrl: 'http://jev.test/v1/systemone', apiKeyEnv: 'SYSTEM_ONE_API_KEY' }
    });
    const auto = createBackend(config, { JEV_API_KEY: 'sk-only-in-the-environment' });
    assert.ok(auto instanceof JevDecisionBackend, 'auto must still select the jev provider from the environment');
    await makeOneRequest(auto);
    assert.equal(stub.calls.length, 1, 'the auto backend must have reached the network');
    assert.equal(
      'Authorization' in stub.calls[0]!.headers,
      false,
      'the locked auto backend authenticated anyway — the factory re-read the environment'
    );

    // Negative control: the same factory with no override keeps reading the
    // environment, so the assertion above is caused by the override and not by
    // the environment being unreachable. This is also the behaviour
    // `vendor-contract.test.ts` pins against the root copy.
    stub.calls.length = 0;
    const bare = createSystemOneBackend();
    assert.ok(bare instanceof JevDecisionBackend);
    await makeOneRequest(bare);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-only-in-the-environment');

    // And an `auto` deployment that names a variable which *is* set sends it.
    stub.calls.length = 0;
    const named = createBackend(
      resolveConfig({ backend: 'auto', systemOne: { baseUrl: 'http://jev.test/v1/systemone', apiKeyEnv: 'MY_KEY' } }),
      { MY_KEY: 'sk-named', JEV_API_KEY: 'sk-ignored' }
    );
    await makeOneRequest(named);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-named');
  } finally {
    stub.restore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a literal profile key wins and apiKeyEnv is ignored entirely', async () => {
  // Criterion 3 at the wire: the literal is sent even though a *different*
  // variable is named and exported.
  const config = resolveConfig({
    backend: 'jev',
    systemOne: {
      active: 'p',
      profiles: { p: { baseUrl: 'http://jev.test/v1/systemone', apiKey: 'sk-literal', apiKeyEnv: 'MY_KEY' } }
    }
  });
  const backend = createBackend(config, { MY_KEY: 'sk-named', JEV_API_KEY: 'sk-fallback' });
  const stub = captureFetch(() => ({ answers: {} }));
  try {
    await makeOneRequest(backend);
    assert.equal(stub.calls[0]!.headers.Authorization, 'Bearer sk-literal');
  } finally {
    stub.restore();
  }
});
