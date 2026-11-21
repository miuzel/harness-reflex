/**
 * g-067 — the factory connection: a fresh settings document ships connected.
 *
 * The goal asks for three things, and this file is organised around them:
 *
 * 1. **A genuinely fresh document is connected.** Not "the plugin would connect
 *    if you typed something": the row is listed, it is the active one, it points
 *    at the project's own endpoint and model, and its credential is the *name*
 *    `JEV_API_KEY` — never a value, never another variable.
 * 2. **Nothing the owner states is overwritten.** A document that deactivated the
 *    row, deleted it, or authors different rows resolves exactly as authored —
 *    and the "absent" / "stated" distinction is taken from the real DSH schema
 *    behaviour, not from what the resolver would like it to be.
 * 3. **The lock holds.** Naming `JEV_API_KEY` locks the lookup (g-059): with the
 *    variable unset the connection is keyless and does **not** borrow
 *    `SYSTEM_ONE_API_KEY`, `VLLM_API_KEY` or `OPENAI_API_KEY`.
 *
 * The distinction in (2) is the whole difficulty of the goal, so it is taken
 * from the mechanism that actually decides it: `Config()` applies a chained
 * `default()` to an **absent** key only, never to a value that is present. The
 * tests below therefore go through `Config`, and the schema/vocabulary the page
 * copies is pinned against the host's own constant.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  FACTORY_PROFILE_API_KEY_ENV,
  connectionTarget,
  FACTORY_PROFILE_NAME,
  FACTORY_SYSTEMONE_PROFILE,
  plainConfig,
  resolveApiKeyWithSource,
  resolveConfig,
  resolveSystemOneConfig,
  type ReflexConfig
} from './config.js';
import { createBackend } from './bridge.js';
import { UnconfiguredBackend } from './unconfigured-backend.js';
import { buildProbeRequest, probeSystemOne } from './systemone-probe.js';
import { DEFAULT_SYSTEMONE_ENDPOINT } from './vendor/harness-reflex/backend/jev.js';

//#region helpers

/** The environment variables the key chain could borrow from, saved and cleared. */
const KEY_VARIABLES = [
  'SYSTEM_ONE_API_KEY',
  'JEV_API_KEY',
  'VLLM_API_KEY',
  'OPENAI_API_KEY',
  'SYSTEM_ONE_MODEL',
  'JEV_MODEL',
  'SYSTEM_ONE_BACKEND',
  'REFLEX_BACKEND',
  'VLLM_BASE_URL',
  'OPENAI_BASE_URL'
] as const;

/**
 * Run one assertion body with a known, empty credential environment.
 *
 * The process environment is the input to half of what this goal decides, so no
 * assertion may depend on whatever the developer happens to export.
 * @param env - variables to export for the run.
 * @param body - the assertions.
 */
async function withEnv(
  env: Partial<Record<(typeof KEY_VARIABLES)[number], string>>,
  body: () => Promise<void> | void
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const name of KEY_VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Resolve one authored document through the real schema, as the loader does. */
function resolveAuthored(document: ReflexConfig): ReturnType<typeof resolveConfig> {
  return resolveConfig(document);
}

//#endregion

//#region criterion 1 — a fresh document is visible and active

test('a fresh settings document lists the factory connection and activates it', async () => {
  await withEnv({}, () => {
    for (const [label, document] of [
      ['no config at all', undefined],
      ['an empty config object', {} as ReflexConfig]
    ] as const) {
      const resolved = resolveAuthored(document as ReflexConfig);
      const systemOne = resolved.systemOne;
      assert.deepEqual(
        Object.keys(systemOne.profiles ?? {}),
        [FACTORY_PROFILE_NAME],
        `${label}: the factory row must be the one listed`
      );
      assert.equal(systemOne.active, FACTORY_PROFILE_NAME, `${label}: the factory row must be the active one`);
      assert.equal(systemOne.unconfigured, undefined, `${label}: nothing about this document is unconfigured`);
      // The *connection* is the row's, and it is a real one: an address, a model
      // and a credential name reach the transport.
      assert.equal(systemOne.baseUrl, DEFAULT_SYSTEMONE_ENDPOINT, `${label}: the official endpoint must be used`);
      assert.equal(systemOne.model, 'jev-latest', `${label}: the official model must be used`);
      assert.equal(systemOne.apiKeyEnv, FACTORY_PROFILE_API_KEY_ENV, `${label}: the credential must be JEV_API_KEY`);
      assert.equal(systemOne.profiles?.[FACTORY_PROFILE_NAME]?.baseUrl, DEFAULT_SYSTEMONE_ENDPOINT);
      assert.deepEqual(systemOne.profiles?.[FACTORY_PROFILE_NAME]?.modelIds, ['jev-latest']);
    }
  });
});

test('the factory connection uses the project constants, not a second copy of them', () => {
  // The values are pinned to the constants the backend owns, so moving the
  // gateway is a one-line change rather than a hunt through the plugin.
  assert.equal(FACTORY_SYSTEMONE_PROFILE.baseUrl, DEFAULT_SYSTEMONE_ENDPOINT);
  assert.match(String(FACTORY_SYSTEMONE_PROFILE.baseUrl), /^https:\/\/api\.typesafe\.ai\/v1\/systemone$/);
  assert.equal(FACTORY_SYSTEMONE_PROFILE.model, 'jev-latest');
  assert.equal(FACTORY_SYSTEMONE_PROFILE.apiKeyEnv, 'JEV_API_KEY');
  // The implementation is bound too (g-067 att-002). Leaving it to `auto` is what
  // the review blocked: `auto` delegates to a factory that reads
  // `SYSTEM_ONE_BACKEND`, so exporting one variable moved the connection's key to
  // a vLLM endpoint while the test button still probed the official one.
  assert.equal(FACTORY_SYSTEMONE_PROFILE.backend, 'jev', 'the factory row must bind the implementation it names');
  // The secret slot is never authored: only the variable *name* is.
  assert.equal('apiKey' in FACTORY_SYSTEMONE_PROFILE, false, 'the factory row must never carry a key');
});

test('the factory row is a plain profile, so the panel can edit it like any other', () => {
  const view = resolveConfig({}).systemOne.profiles?.[FACTORY_PROFILE_NAME];
  assert.ok(view !== undefined);
  // Everything an authored row may state, resolved the same way.
  assert.equal(view.baseUrl, DEFAULT_SYSTEMONE_ENDPOINT);
  assert.deepEqual(view.modelIds, ['jev-latest']);
  assert.equal(view.apiKeyEnv, 'JEV_API_KEY');
  // The row states its own implementation, exactly like an authored one would.
  assert.equal(view.backend, 'jev');
});

//#endregion

//#region criterion 2 — an authored document is never overwritten

test('an explicit deactivation survives, and no factory row is filled back in', () => {
  // What the page writes when the user switches the connection off: the row
  // stays, the activation is stated empty.
  const authored = {
    systemOne: { profiles: { [FACTORY_PROFILE_NAME]: { ...FACTORY_SYSTEMONE_PROFILE } }, active: '' }
  } as ReflexConfig;
  const resolved = resolveAuthored(authored).systemOne;
  assert.deepEqual(Object.keys(resolved.profiles ?? {}), [FACTORY_PROFILE_NAME], 'the row is still listed');
  assert.equal(resolved.active, undefined, 'the empty activation is not an activation');
  assert.equal(resolved.unconfigured, 'no-active-profile', 'the reason is the authored one');
  assert.equal(resolved.baseUrl, undefined, 'no connection field may be invented for a deactivated document');
});

test('a deleted factory row stays deleted', () => {
  // What the page writes when the user removes the row: the row's subtree is
  // unset and the activation is stated empty, so the section is `{profiles: {},
  // active: ''}` — stated, and empty on purpose.
  const resolved = resolveAuthored({ systemOne: { profiles: {}, active: '' } } as ReflexConfig).systemOne;
  assert.deepEqual(resolved.profiles ?? {}, {}, 'no row may be filled back in');
  assert.equal(resolved.unconfigured, 'no-profiles');
  assert.equal(resolved.baseUrl, undefined);
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.apiKeyEnv, undefined);
});

test('an authored profile replaces the factory one outright', () => {
  const authored = {
    systemOne: { profiles: { mine: { baseUrl: 'http://mine', model: 'my-model' } }, active: 'mine' }
  } as ReflexConfig;
  const resolved = resolveAuthored(authored).systemOne;
  assert.deepEqual(Object.keys(resolved.profiles ?? {}), ['mine'], 'the factory row must not be added beside it');
  assert.equal(resolved.active, 'mine');
  assert.equal(resolved.baseUrl, 'http://mine');
  assert.equal(resolved.model, 'my-model');
  assert.equal(resolved.apiKeyEnv, undefined, 'an authored row that names no variable keeps it unset');
});

test('the schema default applies to an absent block only — the real DSH behaviour', () => {
  // This is the mechanism the whole distinction rests on, so it is asserted on
  // the schema itself rather than inferred from the resolver: schemastery
  // applies a chained `default()` to a key that is *absent*, and leaves a
  // present-but-empty value alone.
  const absent = plainConfig(Config({})) as ReflexConfig;
  assert.deepEqual(
    Object.keys(absent.systemOne?.profiles ?? {}),
    [FACTORY_PROFILE_NAME],
    'an absent section takes the factory default'
  );
  assert.equal(absent.systemOne?.active, FACTORY_PROFILE_NAME);

  for (const [label, block] of [
    ['an empty object', {}],
    ['an empty profile map', { profiles: {} }],
    ['an explicit empty activation', { profiles: {}, active: '' }]
  ] as const) {
    const authored = plainConfig(Config({ systemOne: block })) as ReflexConfig;
    const resolved = resolveAuthored({ systemOne: block } as ReflexConfig).systemOne;
    assert.notEqual(
      resolved.active,
      FACTORY_PROFILE_NAME,
      `${label}: a stated section must not be re-activated with the factory row`
    );
    assert.equal(resolved.unconfigured !== undefined, true, `${label}: nothing may connect`);
    // The schema keeps what was authored (it defaults the map, nothing else).
    assert.ok(authored.systemOne !== undefined, `${label}: the section survives the schema`);
  }
});

test('a legacy flat deployment is still diagnosed, not connected, and gains no factory row', () => {
  // g-066 kept the pre-`profiles` fields read-for-diagnosis only; g-067 must not
  // turn that diagnosis into a connection by adding a row beside it.
  const resolved = resolveAuthored({
    systemOne: { baseUrl: 'http://old', model: 'old-model', apiKeyEnv: 'OLD_KEY' }
  } as unknown as ReflexConfig).systemOne;
  assert.equal(resolved.unconfigured, 'legacy-config-required');
  assert.equal(resolved.baseUrl, undefined, 'the flat address must not reach the transport');
  assert.deepEqual(Object.keys(resolved.profiles ?? {}), [] as string[], 'no factory row may be invented');
});

test('no implicit fallback comes back with the factory row', () => {
  // The factory connection is a *profile*: everything it connects with is stated
  // on the row. Nothing is read from a block beside it, and an unconfigured
  // document still has no connection fields at all.
  const off = resolveSystemOneConfig('jev', { profiles: {}, active: '' });
  for (const field of ['baseUrl', 'model', 'apiKeyEnv', 'apiKey', 'timeoutMs'] as const) {
    assert.equal(off[field], undefined, `${field} must stay absent when nothing is activated`);
  }
});

//#endregion

//#region criterion 3 — the JEV_API_KEY lock

test('the factory credential is JEV_API_KEY and nothing else, and names lock', async () => {
  await withEnv({ SYSTEM_ONE_API_KEY: 'sk-other', VLLM_API_KEY: 'sk-vllm', OPENAI_API_KEY: 'sk-openai' }, () => {
    const connection = resolveConfig({}).systemOne;
    // Naming locks (g-059): with JEV_API_KEY unset and three other key variables
    // exported, the connection is keyless — it must not borrow any of them.
    const locked = resolveApiKeyWithSource(connection);
    assert.deepEqual(locked, { missing: 'named', variable: 'JEV_API_KEY' }, 'the lookup must lock onto the named variable');
    assert.equal('key' in (locked ?? {}), false, 'no key may be borrowed from another variable');
  });

  await withEnv({ JEV_API_KEY: 'sk-jev' }, () => {
    const connection = resolveConfig({}).systemOne;
    assert.deepEqual(resolveApiKeyWithSource(connection), { key: 'sk-jev', source: 'env', variable: 'JEV_API_KEY' });
  });
});

test('a keyless factory connection is "named but empty", never a silent fallback or a mock', async () => {
  await withEnv({ SYSTEM_ONE_API_KEY: 'sk-must-not-be-used' }, () => {
    // No transport at all is not the right answer here — the connection *is*
    // configured, its credential is simply absent — so the backend is a real one
    // that will fail closed at request time, not the unconfigured stand-in and
    // not the heuristic mock.
    const backend = createBackend(resolveConfig({}), { SYSTEM_ONE_API_KEY: 'sk-must-not-be-used' });
    assert.notEqual(backend.name, 'unconfigured', 'the factory connection is configured');
    assert.notEqual(backend.name, 'mock-heuristic-v1', 'no silent heuristic stand-in');
  });
});

test('nothing in the resolved config ever carries the secret', () => {
  // The row authors a variable *name*; a resolved document that carried a value
  // would mean the plugin had read the environment into its configuration.
  const resolved = resolveConfig({});
  assert.equal(resolved.systemOne.apiKey, undefined, 'the resolved connection must not carry a key');
  const serialized = JSON.stringify(resolved.systemOne);
  assert.equal(serialized.includes('sk-'), false, `the projection leaked a key-shaped value: ${serialized}`);
});

//#endregion

//#region the unconfigured document is still local-only

test('an explicitly empty document builds no transport, even with a gateway exported', async () => {
  // The g-066 invariant survives g-067: the factory default belongs to the
  // *fresh* document, and the owner's explicit "no connections" still connects
  // nothing. The environment below is the one that used to make `auto` dial out.
  const env = { JEV_API_KEY: 'sk-only-in-the-environment', SYSTEM_ONE_BASE_URL: 'http://env-gateway' };
  await withEnv(env, async () => {
    const backend = createBackend(resolveConfig({ systemOne: { profiles: {}, active: '' } } as ReflexConfig), env);
    assert.ok(backend instanceof UnconfiguredBackend, `the plugin must not build a remote transport, got ${backend.name}`);
    // And it still answers, from the in-process heuristics.
    const answer = await backend.choice({ question: 'ship it?', options: ['yes', 'no'] });
    assert.ok(answer.bestOption.length > 0, 'the local fallback answered nothing');
  });
});

//#endregion

//#region the factory connection cannot be redirected by the environment (att-002)

/**
 * A stub transport: records every request, answers nothing real.
 *
 * The point of this region is that **no** request may leave the process with the
 * JEV key, so the assertions are made against a `fetch` that never reaches a
 * socket. Reaching the network would make the test pass or fail for reasons that
 * have nothing to do with the code under test.
 */
function recordingFetch(): { fetch: typeof fetch; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, headers, body: String(init?.body ?? '') });
    // A well-formed response so a caller that awaits a decision completes; its
    // content is irrelevant, because every assertion is about *where* the request
    // went and *what* it carried.
    return new Response(JSON.stringify({ answers: { choice: { probabilities: { yes: 0.9, no: 0.1 } } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** The environment that used to take the factory connection's key elsewhere. */
const REDIRECTING_ENV = {
  SYSTEM_ONE_BACKEND: 'vllm',
  REFLEX_BACKEND: 'vllm',
  VLLM_BASE_URL: 'http://attacker-openai:8000',
  OPENAI_BASE_URL: 'http://attacker-openai:8000',
  SYSTEM_ONE_BASE_URL: 'http://attacker-system-one:9000'
} as const;

test('a fresh document keeps its key on the official endpoint under a redirecting environment', async () => {
  // The exact scenario the independent review captured as a key leak: a fresh
  // document, `JEV_API_KEY` exported, and `SYSTEM_ONE_BACKEND=vllm` with a vLLM
  // base URL. Before the fix the runtime built the logits backend and sent
  // `Authorization: Bearer <JEV key>` to `http://attacker-openai:8000/v1/completions`.
  await withEnv({ ...REDIRECTING_ENV, JEV_API_KEY: 'sk-jev-must-stay-home' }, async () => {
    const config = resolveConfig({});
    const backend = createBackend(config);
    assert.equal(backend.name, 'system-one-jev', `the factory row must bind its implementation, got ${backend.name}`);

    const { fetch: stub, calls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await backend.choice({ question: 'ship it?', options: ['yes', 'no'] });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1, `exactly one request may be sent, got ${JSON.stringify(calls.map((call) => call.url))}`);
    const [call] = calls;
    assert.equal(call!.url, DEFAULT_SYSTEMONE_ENDPOINT, `the official endpoint only, got ${call!.url}`);
    assert.equal(call!.headers.authorization, 'Bearer sk-jev-must-stay-home', 'the key reaches its own gateway');
    // And nowhere else: the stub is the only transport, so any other URL would
    // have been recorded above. This asserts the environment left no trace.
    for (const call of calls) {
      assert.equal(
        /attacker-openai|attacker-system-one/.test(call.url),
        false,
        `a request reached a redirecting endpoint: ${call.url}`
      );
    }
  });
});

test('a fresh document never builds the logits backend, whatever the environment says', async () => {
  // The implementation is a property of the connection, not of the process.
  const cases = [
    { SYSTEM_ONE_BACKEND: 'vllm' },
    { REFLEX_BACKEND: 'simple-jev' },
    { SYSTEM_ONE_BACKEND: 'logits' },
    { VLLM_BASE_URL: 'http://attacker-openai:8000' },
    { OPENAI_BASE_URL: 'http://attacker-openai:8000' }
  ] as const;
  for (const extra of cases) {
    await withEnv({ ...extra, JEV_API_KEY: 'sk-jev-must-stay-home' }, () => {
      const backend = createBackend(resolveConfig({}));
      assert.equal(backend.name, 'system-one-jev', `${JSON.stringify(extra)} must not move the factory connection`);
    });
  }
});

test('a fresh document with no JEV_API_KEY is keyless, and still points at the official endpoint', async () => {
  // The lock survives the binding: no other variable may supply the credential,
  // and the address is still the official one (so a 401 is the honest answer).
  await withEnv({ ...REDIRECTING_ENV, SYSTEM_ONE_API_KEY: 'sk-borrowed-must-not-be-sent' }, async () => {
    const backend = createBackend(resolveConfig({}));
    assert.equal(backend.name, 'system-one-jev');
    const { fetch: stub, calls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await backend.choice({ question: 'ship it?', options: ['yes', 'no'] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const [call] = calls;
    assert.equal(call!.url, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.equal(call!.headers.authorization, undefined, 'no other variable may stand in for JEV_API_KEY');
  });
});

test('the connection test probes exactly what the runtime runs, under a redirecting environment', async () => {
  // The second half of the block: the test button said "ok" on the official URL
  // while the runtime dialled vLLM. Both ends now answer from one resolver.
  await withEnv({ ...REDIRECTING_ENV, JEV_API_KEY: 'sk-jev-must-stay-home' }, async () => {
    const config = resolveConfig({});
    const backend = createBackend(config);
    const target = connectionTarget(config.systemOne, FACTORY_PROFILE_NAME, config.systemOne.profiles![FACTORY_PROFILE_NAME]!);
    assert.equal(target.backend, 'jev', 'the probe must treat the factory row as Jev, as the runtime does');

    const { fetch: stub, calls } = recordingFetch();
    const probe = await probeSystemOne(target, { env: process.env, fetch: stub });
    assert.equal(probe.ok, true, `the probe reached its stub: ${JSON.stringify(probe)}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, DEFAULT_SYSTEMONE_ENDPOINT, `the probe must test the runtime endpoint, got ${calls[0]!.url}`);
    assert.equal(
      (backend as unknown as { endpoint?: string }).endpoint,
      calls[0]!.url,
      'the probed endpoint is the built transport endpoint, byte for byte'
    );
  });
});

test('the probe and the runtime resolve an `auto` row to the same implementation', async () => {
  // The precise divergence the review captured: an `auto` connection (a user's own
  // row that does not bind an implementation) under an environment that selects
  // vLLM. The runtime must follow the environment — that is what `auto` means —
  // and the probe must follow it to the *same* place. Hard-coding `auto -> jev` in
  // the probe is what made the test button green while the runtime dialled
  // elsewhere. This test fails if either end derives `auto` on its own.
  await withEnv({ ...REDIRECTING_ENV, JEV_API_KEY: 'sk-jev-must-stay-home' }, async () => {
    const config = resolveConfig({
      backend: 'auto',
      systemOne: { active: 'mine', profiles: { mine: { baseUrl: 'http://mine-gateway:8080', model: 'my-model', apiKeyEnv: 'JEV_API_KEY' } } }
    });
    assert.equal(config.systemOne.backend, 'auto', 'the row names no implementation, so the selector decides');
    const backend = createBackend(config);
    assert.equal(backend.name, 'system-one-logits', 'the runtime follows the environment for `auto`');

    const target = connectionTarget(config.systemOne, 'mine', config.systemOne.profiles!.mine!);
    const built = buildProbeRequest(target, process.env);
    assert.ok('spec' in built, `the probe could build a request: ${JSON.stringify(built)}`);
    assert.equal(
      built.spec.url,
      'http://mine-gateway:8080/v1/completions',
      'the probe must speak the protocol the runtime speaks (logits), not Jev'
    );
  });
});

test('a mock deployment answers in-process even though the factory row is active', async () => {
  // The factory row binds `jev`, and every fixture in this package runs on
  // `backend: mock`. The binding must not turn "answer locally" into a live call.
  await withEnv({ JEV_API_KEY: 'sk-jev-must-stay-home' }, async () => {
    const backend = createBackend(resolveConfig({ backend: 'mock' }));
    assert.equal(backend.name, 'mock-heuristic-v1');
    const { fetch: stub, calls } = recordingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      const answer = await backend.choice({ question: 'ship it?', options: ['yes', 'no'] });
      assert.ok(answer.bestOption.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 0, 'a mock sends nothing, ever');
  });
});

test('the row precedence an authored row already had is unchanged', () => {
  // The narrow exception above must not become a general reordering: a row that
  // names its implementation still wins, exactly as before g-067.
  const rowWins = resolveSystemOneConfig('jev', {
    active: 'local',
    profiles: { local: { backend: 'vllm', baseUrl: 'http://127.0.0.1:8000' } }
  });
  assert.equal(rowWins.backend, 'vllm', 'an authored row still decides its own implementation');
  const underAuto = resolveSystemOneConfig('auto', { active: 'local', profiles: { local: { backend: 'vllm' } } });
  assert.equal(underAuto.backend, 'vllm');
});

test('an edited factory-shaped row keeps the usual precedence, not the shipped exception', () => {
  // The exception is keyed to the *unedited* shipped row. A user who repointed it
  // has stated their own connection, and `mock` must not silently swallow it.
  const edited = resolveSystemOneConfig('mock', {
    active: FACTORY_PROFILE_NAME,
    profiles: {
      [FACTORY_PROFILE_NAME]: { baseUrl: 'http://my-own-gateway', model: 'jev-latest', apiKeyEnv: 'JEV_API_KEY', backend: 'jev' }
    }
  });
  assert.equal(edited.backend, 'jev', 'an edited row is not the shipped row');
});

//#endregion
