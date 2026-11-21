import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';

import type { LedgerEntry, LedgerSummary } from './vendor/harness-reflex/index.js';

import { resolveConfig, type ReflexConfig } from './config.js';
import {
  PANEL_LEDGER_WINDOW,
  PANEL_LEDGER_WINDOW_MAX,
  PANEL_PATHS,
  PANEL_ROUTES,
  REFLEX_PLUGIN_VERSION,
  answerPanelRequest,
  answerPanelRequestAsync,
  buildPanelSnapshot,
  clampLimit,
  isLoopbackAddress,
  isLoopbackIPv4,
  isPanelRequestAllowed,
  makePanelRoutes,
  readLimit,
  readQuery,
  sendPanelAnswer,
  type PanelAnswer,
  type PanelResponse,
  type PanelRuntimeFacts,
  type PanelSource
} from './panel-api.js';
import { REFLEX_TOOL_SUFFIXES } from './tools.js';

/**
 * The `/api/dsh-reflex/*` surface: what it publishes, what it refuses, and what
 * it never reads. The route family is the only channel between the two halves of
 * this plugin, so its projection and its fence are asserted directly rather than
 * through the page that consumes them.
 */

/** An API key value that must never appear in any answer. */
const SECRET = 'sk-panel-must-not-leak-7c21';

/**
 * The presence fact the caller gathers for the zoned `main` profile.
 *
 * In production this comes from {@link profileKeyPresence}, which resolves the
 * one key chain; here it is stated so the projection test is about projection.
 */
const MAIN_KEY_FACTS = { main: { present: true, fromProfile: false, variable: 'REFLEX_TEST_KEY' } };

const AUTHORED: ReflexConfig = {
  backend: 'jev',
  toolPrefix: 'reflex_',
  pruneThreshold: 500,
  routing: {
    enabled: true,
    virtualProvider: 'reflex',
    fallback: 'deepseek:deepseek-chat',
    maxTaskChars: 400,
    models: { 'reflex-pro': [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] }
  },
  effort: { reasoningEffort: 'reflex', fallback: 'low', minConfidence: 0.3 },
  // g-066: the connection is one active profile. The same facts used to be the
  // flat block's; the flat block no longer connects anything.
  systemOne: {
    active: 'main',
    profiles: {
      main: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'jev-small', apiKeyEnv: 'REFLEX_TEST_KEY', timeoutMs: 2500 }
    }
  }
};

const SUMMARY: LedgerSummary = {
  totalCalls: 4,
  callsByType: { 'effort-decision': 2, 'model-route': 1, gate: 1 },
  totalTokensSaved: 2048,
  avgLatencyMs: 9.5,
  estimatedCostSavedUsd: 0.25,
  stagnationAlerts: 1,
  gatePassedCount: 2,
  gateFailedCount: 1
};

/** One ledger entry of each interesting shape. */
function ledgerEntry(index: number): LedgerEntry {
  return {
    id: `l${String(index)}`,
    timestamp: `2024-03-04T05:06:${String(index % 60).padStart(2, '0')}.000Z`,
    type: index % 2 === 0 ? 'model-route' : 'effort-decision',
    backend: 'jev',
    latencyMs: 5 + index,
    tokensSaved: index * 10,
    details: { action: 'ranked', target: 'deepseek:deepseek-chat', secretish: SECRET }
  };
}

/** Facts with `count` ledger entries and a pinned clock. */
function facts(count = 3, overrides: Partial<PanelRuntimeFacts> = {}): PanelRuntimeFacts {
  const entries = Array.from({ length: count }, (_, index) => ledgerEntry(index));
  return {
    config: resolveConfig(AUTHORED),
    backendName: 'jev',
    pools: [{ model: 'reflex-pro', entries: [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] }],
    routingActive: true,
    // AUTHORED authors no tools block, so the runtime registers the documented
    // default surface: route is opt-in and is not part of it.
    toolSurface: REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route').map((suffix) => `reflex_${suffix}`),
    ledger: { getSummary: () => SUMMARY, getEntries: () => entries, getLogPath: () => '/tmp/reflex-ledger.jsonl' },
    effort: {
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.82,
      latencyMs: 12.4,
      provider: 'deepseek',
      model: 'deepseek-chat',
      line: 'reflex: high',
      at: 1_709_530_000_000,
      basis: ['task looks hard']
    },
    apiKeyPresent: true,
    now: 1_709_530_001_000,
    ...overrides
  };
}

/** A request stub carrying only what the fence and the router read. */
function request(method: string, url: string, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { method, url, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/**
 * A request stub carrying a body, as an async-iterable stream.
 *
 * The probe route reads its body, so this stub has to behave like one: the
 * `answerPanelRequestAsync` path iterates the request.
 * @param method - HTTP method.
 * @param url - path.
 * @param body - JSON body, or `undefined` for no body at all.
 * @param remoteAddress - peer address the fence reads.
 * @returns the request stub.
 */
function requestJson(method: string, url: string, body: string | undefined, remoteAddress = '127.0.0.1'): IncomingMessage {
  const listeners = new Map<string, Array<() => void>>();
  const stub = {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress },
    once(event: string, listener: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return stub;
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    }
  };
  return stub as unknown as IncomingMessage;
}

/**
 * Run one route handler and wait for its (now asynchronous) answer.
 *
 * The handler dispatches through `answerPanelRequestAsync`, so a test that
 * inspects the response must let a microtask turn elapse first.
 * @param route - the registered route.
 * @param request - the request to serve.
 * @param response - the response stub to fill.
 * @returns a promise resolving once the handler settled.
 */
async function serve(route: { handler: (req: never, res: never) => void }, request: IncomingMessage, response: unknown): Promise<void> {
  route.handler(request as never, response as never);
  // Drain the promise chain the handler kicked off.
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

/** A panel source whose probe is the supplied callback. */
function probeSource(testSystemOne: PanelSource['testSystemOne'] extends undefined ? never : NonNullable<PanelSource['testSystemOne']>): PanelSource {
  return {
    snapshot: () => buildPanelSnapshot(facts(1)),
    clearLedger: () => 0,
    allows: (req) => isPanelRequestAllowed(req),
    testSystemOne
  };
}

/** What the response stub recorded. */
interface ResponseRecord extends PanelResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A response stub that records what was written. */
function response(): ResponseRecord {
  const record: ResponseRecord = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead: (status: number, headers?: Record<string, string>) => {
      record.status = status;
      record.headers = headers ?? {};
    },
    end: (chunk?: string) => {
      record.body = chunk ?? '';
    }
  };
  return record;
}

/** A source over given facts that counts clears. */
function source(panelFacts = facts()): { source: PanelSource; cleared: number[] } {
  const cleared: number[] = [];
  return {
    cleared,
    source: {
      snapshot: (limit) => buildPanelSnapshot(panelFacts, limit),
      clearLedger: () => {
        cleared.push(1);
        return 2;
      },
      allows: (incoming) => isPanelRequestAllowed(incoming, {})
    }
  };
}

//#region projection

test('the snapshot carries exactly the projected facts', () => {
  const snapshot = buildPanelSnapshot(facts(3, { profileKeys: MAIN_KEY_FACTS }));

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.at, 1_709_530_001_000);
  assert.deepEqual(snapshot.plugin, {
    name: 'dsh-reflex',
    version: REFLEX_PLUGIN_VERSION,
    toolPrefix: 'reflex_',
    pruneThreshold: 500
  });
  assert.deepEqual(snapshot.routing, {
    enabled: true,
    active: true,
    virtualProvider: 'reflex',
    maxTaskChars: 400,
    candidates: 1,
    pools: [{ model: 'reflex-pro', entries: [{ provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] }] }],
    fallback: 'deepseek:deepseek-chat'
  });
  assert.deepEqual(snapshot.effort, {
    setting: 'reflex',
    fallback: 'low',
    minConfidence: 0.3,
    enabled: true,
    decisions: 1,
    latest: {
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.82,
      latencyMs: 12.4,
      provider: 'deepseek',
      model: 'deepseek-chat',
      line: 'reflex: high',
      at: 1_709_530_000_000,
      basis: ['task looks hard']
    }
  });
  // The block-level fields are the *active profile's*, and the connection is
  // configured, so no `unconfigured` reason is reported.
  const { profiles: profileViews, ...systemOneFacts } = snapshot.systemOne;
  assert.deepEqual(systemOneFacts, {
    backend: 'jev',
    active: 'jev',
    apiKeyPresent: true,
    apiKeyFromProfile: false,
    activeProfileMissing: false,
    activeProfile: 'main',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'jev-small',
    apiKeyEnv: 'REFLEX_TEST_KEY',
    timeoutMs: 2500
  });
  // One row, carrying the selected model — the id the runtime and the probe both
  // use — and nothing secret.
  // The row's presence is a *fact the caller gathered* (`profileKeys`, read from
  // the one key chain), never something the projection infers from the value it
  // holds — that is why this fixture supplies it explicitly.
  assert.deepEqual(profileViews, [
    {
      name: 'main',
      active: true,
      apiKeyPresent: true,
      apiKeyFromProfile: false,
      // The variable that supplied the key, as a *name* — the row renders
      // "from REFLEX_TEST_KEY" from it, and never the value.
      apiKeyVariable: 'REFLEX_TEST_KEY',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'jev-small',
      modelIds: ['jev-small'],
      selectedModel: 'jev-small',
      apiKeyEnv: 'REFLEX_TEST_KEY',
      timeoutMs: 2500,
      backend: 'jev'
    }
  ]);
  assert.deepEqual(snapshot.interventions, {
    mode: 'observe',
    enabled: true,
    acting: false,
    capabilities: { stagnation: 'observe', prune: 'observe', gate: 'observe', closing: 'observe' }
  });
  assert.deepEqual(snapshot.tools, {
    enabled: Object.fromEntries(REFLEX_TOOL_SUFFIXES.map((suffix) => [suffix, suffix !== 'route'])),
    active: REFLEX_TOOL_SUFFIXES.filter((suffix) => suffix !== 'route').map((suffix) => `reflex_${suffix}`)
  });
  assert.equal(snapshot.ledger.summary, SUMMARY);
  assert.equal(snapshot.ledger.logPath, '/tmp/reflex-ledger.jsonl');
  assert.equal(snapshot.ledger.clearable, true);
  assert.equal(snapshot.ledger.recent.length, 3);
});

test('the snapshot projects ledger details instead of serializing them whole', () => {
  const snapshot = buildPanelSnapshot(facts(2));
  const row = snapshot.ledger.recent[0];
  assert.deepEqual(Object.keys(row ?? {}).sort(), ['action', 'at', 'backend', 'id', 'latencyMs', 'target', 'tokensSaved', 'type'].sort());
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false, 'an unprojected detail field rode the wire');
});

test('a routing decision projects its cache-affinity audit fields', () => {
  const entries = [
    {
      id: 'l-route',
      timestamp: '2024-03-04T05:06:00.000Z',
      type: 'model-route',
      backend: 'jev',
      latencyMs: 7,
      tokensSaved: 0,
      details: {
        goal: 'carry on',
        chosen: 'deepseek:chat',
        currentModel: 'deepseek:chat',
        switched: false,
        contextTokens: 2500,
        contextChars: 10000
      }
    }
  ];
  const snapshot = buildPanelSnapshot(
    facts(0, {
      ledger: { getSummary: () => SUMMARY, getEntries: () => entries as never, getLogPath: () => null }
    })
  );

  const row = snapshot.ledger.recent[0];
  assert.equal(row?.currentModel, 'deepseek:chat');
  assert.equal(row?.switched, false);
  assert.equal(row?.contextTokens, 2500);
  assert.deepEqual(
    Object.keys(row ?? {}).sort(),
    ['at', 'backend', 'contextTokens', 'currentModel', 'id', 'latencyMs', 'switched', 'tokensSaved', 'type'].sort()
  );
});

test('a first decision with no incumbent projects no currentModel', () => {
  const entries = [
    {
      id: 'l-first',
      timestamp: '2024-03-04T05:06:00.000Z',
      type: 'model-route',
      backend: 'jev',
      latencyMs: 7,
      tokensSaved: 0,
      details: { chosen: 'deepseek:chat', currentModel: null, switched: false, contextTokens: 0, contextChars: 0 }
    }
  ];
  const snapshot = buildPanelSnapshot(
    facts(0, {
      ledger: { getSummary: () => SUMMARY, getEntries: () => entries as never, getLogPath: () => null }
    })
  );

  const row = snapshot.ledger.recent[0];
  assert.equal(row?.currentModel, undefined, 'a null incumbent is absence, not a model named "null"');
  assert.equal(row?.switched, false);
  assert.equal(row?.contextTokens, 0);
});

test('the snapshot never reads the API key', () => {
  process.env.REFLEX_TEST_KEY = SECRET;
  try {
    const snapshot = buildPanelSnapshot(facts(1));
    const wire = JSON.stringify(snapshot);
    assert.equal(wire.includes(SECRET), false, 'the key value reached the wire');
    assert.equal(snapshot.systemOne.apiKeyEnv, 'REFLEX_TEST_KEY');
    assert.equal(snapshot.systemOne.apiKeyPresent, true);
  } finally {
    delete process.env.REFLEX_TEST_KEY;
  }
});

test('a missing key is reported as absent, not as an error', () => {
  const snapshot = buildPanelSnapshot(facts(1, { apiKeyPresent: false }));
  assert.equal(snapshot.systemOne.apiKeyPresent, false);
});

test('an activation with no adaptive decision yet reports null, not a blank row', () => {
  const snapshot = buildPanelSnapshot(facts(1, { effort: undefined }));
  assert.equal(snapshot.effort.latest, null);
});

test('optional connection fields are omitted rather than sent as undefined', () => {
  // No connection at all: since g-067 the default document carries the factory
  // row (and so names a base URL, a model and a key variable), which is a
  // *different* fact — it is asserted in its own case below.
  const minimal = resolveConfig({ backend: 'auto', systemOne: { active: '', profiles: {} } });
  const snapshot = buildPanelSnapshot(facts(0, { config: minimal, pools: [] }));
  assert.equal('baseUrl' in snapshot.systemOne, false);
  assert.equal('model' in snapshot.systemOne, false);
  assert.equal('apiKeyEnv' in snapshot.systemOne, false);
  assert.equal('timeoutMs' in snapshot.systemOne, false);
  assert.equal('fallback' in snapshot.routing, false);
  assert.equal('ledgerPath' in snapshot.plugin, false);
  assert.equal('calibrationPath' in snapshot.plugin, false);
  assert.deepEqual(snapshot.routing.pools, []);
  assert.equal(snapshot.routing.candidates, 0);
  assert.equal(snapshot.effort.setting, null);
});

test('the pool view is a detached copy the caller cannot mutate back', () => {
  const panelFacts = facts(1);
  const snapshot = buildPanelSnapshot(panelFacts);
  (snapshot.routing.pools[0]?.entries[0] as { model: string }).model = 'mutated';
  (snapshot.routing.pools[0]?.entries[0]?.tags as string[]).push('mutated');
  assert.equal(panelFacts.pools[0]?.entries[0]?.model, 'deepseek-chat');
  assert.deepEqual(panelFacts.pools[0]?.entries[0]?.tags, ['cheap']);
});

test('the ledger window is the tail of the log, newest last', () => {
  const snapshot = buildPanelSnapshot(facts(30), 5);
  assert.deepEqual(
    snapshot.ledger.recent.map((row) => row.id),
    ['l25', 'l26', 'l27', 'l28', 'l29']
  );
});

//#endregion

//#region window arithmetic

test('the requested ledger window is clamped to the accepted range', () => {
  assert.equal(clampLimit(Number.NaN), PANEL_LEDGER_WINDOW);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY), PANEL_LEDGER_WINDOW);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-10), 1);
  assert.equal(clampLimit(7.8), 7);
  assert.equal(clampLimit(PANEL_LEDGER_WINDOW_MAX + 1), PANEL_LEDGER_WINDOW_MAX);
  assert.equal(clampLimit(10), 10);
});

test('the limit query parameter is read defensively', () => {
  assert.equal(readLimit(undefined), PANEL_LEDGER_WINDOW);
  assert.equal(readLimit('/dsh-reflex/api/panel'), PANEL_LEDGER_WINDOW);
  assert.equal(readLimit('/dsh-reflex/api/panel?limit=5'), 5);
  assert.equal(readLimit('/dsh-reflex/api/panel?limit='), PANEL_LEDGER_WINDOW);
  assert.equal(readLimit('/dsh-reflex/api/panel?limit=abc'), PANEL_LEDGER_WINDOW);
  assert.equal(readLimit('/dsh-reflex/api/panel?limit=99999'), PANEL_LEDGER_WINDOW_MAX);
  assert.equal(readLimit('/dsh-reflex/api/panel?limit=0'), 1);
  assert.equal(readLimit('/dsh-reflex/api/panel?other=3&limit=4'), 4);
});

test('query reading ignores an absent query string', () => {
  assert.equal(readQuery('/api/x', 'confirm'), null);
  assert.equal(readQuery(undefined, 'confirm'), null);
  assert.equal(readQuery('/api/x?confirm=clear', 'confirm'), 'clear');
});

//#endregion

//#region fence

test('only loopback literals pass the address check', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.254']) {
    assert.equal(isLoopbackIPv4(address), true, address);
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['10.0.0.1', '192.168.1.5', '::2', '0.0.0.0', '127.0.0', '127.0.0.256', '127.0.0.1.5', 'localhost', '', '::ffff:10.0.0.1']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackIPv4('127.0.0.1'), true);
  assert.equal(isLoopbackIPv4('128.0.0.1'), false);
  assert.equal(isLoopbackIPv4('127.0.0.01'), true);
});

test('the fence is the socket address, with pairing as the only extra door', () => {
  assert.equal(isPanelRequestAllowed(request('GET', '/dsh-reflex/api/panel')), true);
  assert.equal(isPanelRequestAllowed(request('GET', '/dsh-reflex/api/panel', '10.0.0.9')), false);
  assert.equal(isPanelRequestAllowed(request('GET', '/dsh-reflex/api/panel', '10.0.0.9'), { isPaired: () => true }), true);
  assert.equal(isPanelRequestAllowed(request('GET', '/dsh-reflex/api/panel', '10.0.0.9'), { isPaired: () => false }), false);
  // A pairing check that throws must fail closed, not open.
  assert.equal(
    isPanelRequestAllowed(request('GET', '/dsh-reflex/api/panel', '10.0.0.9'), {
      isPaired: () => {
        throw new Error('pairing service down');
      }
    }),
    false
  );
  // A forged Host header cannot buy access.
  const forged = request('GET', '/dsh-reflex/api/panel', '10.0.0.9');
  (forged.headers as Record<string, string>).host = '127.0.0.1:3080';
  (forged.headers as Record<string, string>)['x-forwarded-for'] = '127.0.0.1';
  assert.equal(isPanelRequestAllowed(forged), false);
});

//#endregion

//#region routing

test('a remote peer is refused before any path or method is considered', () => {
  const { source: panelSource, cleared } = source();
  for (const [method, url] of [
    ['GET', PANEL_ROUTES.snapshot],
    ['GET', PANEL_ROUTES.health],
    ['POST', `${PANEL_ROUTES.clearLedger}?confirm=clear`],
    ['GET', '/dsh-reflex/api/unknown']
  ] as const) {
    const answer = answerPanelRequest(panelSource, request(method, url, '10.0.0.9'));
    assert.equal(answer.status, 403, `${method} ${url}`);
    assert.deepEqual(answer.body, {
      ok: false,
      error: 'forbidden',
      detail: 'the reflex panel answers loopback clients and paired devices only'
    });
  }
  assert.deepEqual(cleared, [], 'a refused request reached the ledger');
});

test('an unknown path is a 404 and never leaks the route table', () => {
  const { source: panelSource } = source();
  const answer = answerPanelRequest(panelSource, request('GET', '/dsh-reflex/api/../ledger'));
  assert.equal(answer.status, 404);
  assert.deepEqual(answer.body, { ok: false, error: 'not-found', detail: 'unknown reflex panel route "/dsh-reflex/api/../ledger"' });
});

test('the snapshot and health routes answer GET and HEAD only', () => {
  const { source: panelSource } = source();
  for (const path of [PANEL_ROUTES.snapshot, PANEL_ROUTES.health]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal(answerPanelRequest(panelSource, request(method, path)).status, 200, `${method} ${path}`);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const answer = answerPanelRequest(panelSource, request(method, path));
      assert.equal(answer.status, 405, `${method} ${path}`);
      assert.equal(answer.headers?.allow, 'GET, HEAD');
    }
  }
});

test('the snapshot route honours the requested window', () => {
  const { source: panelSource } = source(facts(12));
  const answer = answerPanelRequest(panelSource, request('GET', `${PANEL_ROUTES.snapshot}?limit=3`));
  const body = answer.body as { ledger: { recent: { id: string }[] } };
  assert.deepEqual(
    body.ledger.recent.map((row) => row.id),
    ['l9', 'l10', 'l11']
  );
});

test('health answers identity without reading the runtime', () => {
  let reads = 0;
  const panelSource: PanelSource = {
    snapshot: () => {
      reads += 1;
      return buildPanelSnapshot(facts(1));
    },
    clearLedger: () => 0,
    allows: () => true
  };
  const answer = answerPanelRequest(panelSource, request('GET', PANEL_ROUTES.health));
  assert.deepEqual(answer.body, { ok: true, name: 'dsh-reflex', version: REFLEX_PLUGIN_VERSION });
  assert.equal(reads, 0, 'health read live facts');
});

test('clearing needs an explicit confirmation', () => {
  const { source: panelSource, cleared } = source();
  for (const url of [PANEL_ROUTES.clearLedger, `${PANEL_ROUTES.clearLedger}?confirm=`, `${PANEL_ROUTES.clearLedger}?confirm=1`, `${PANEL_ROUTES.clearLedger}?confirm=CLEAR`]) {
    const answer = answerPanelRequest(panelSource, request('POST', url));
    assert.equal(answer.status, 400, url);
    assert.deepEqual(answer.body, {
      ok: false,
      error: 'confirmation-required',
      detail: 'clearing the ledger deletes its JSONL sink; repeat the POST with ?confirm=clear'
    });
  }
  assert.deepEqual(cleared, [], 'an unconfirmed request reached the ledger');
  assert.equal(answerPanelRequest(panelSource, request('GET', PANEL_ROUTES.clearLedger)).status, 405);
  assert.equal(answerPanelRequest(panelSource, request('GET', PANEL_ROUTES.clearLedger)).headers?.allow, 'POST');

  const confirmed = answerPanelRequest(panelSource, request('POST', `${PANEL_ROUTES.clearLedger}?confirm=clear`));
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.body, { ok: true, cleared: 2 });
  assert.deepEqual(cleared, [1]);
});

//#endregion

//#region wire format

test('a HEAD answer carries headers and no body', async () => {
  const { source: panelSource } = source();
  const routes = makePanelRoutes(panelSource);
  const snapshotRoute = routes.find((route) => route.path === PANEL_ROUTES.snapshot);
  assert.ok(snapshotRoute !== undefined);

  const head = response();
  await serve(snapshotRoute, request('HEAD', PANEL_ROUTES.snapshot), head);
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(Number(head.headers['content-length'] ?? '0') > 0, 'content-length must describe the body HEAD suppresses');

  const get = response();
  await serve(snapshotRoute, request('GET', PANEL_ROUTES.snapshot), get);
  assert.equal(get.status, 200);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['content-length'], String(Buffer.byteLength(get.body, 'utf8')));
  assert.equal(head.headers['content-length'], get.headers['content-length'], 'a probe must see the size GET would return');
  assert.deepEqual(JSON.parse(get.body), buildPanelSnapshot(facts()));
});

test('the route family owns exactly its five exact paths', () => {
  const { source: panelSource } = source();
  const routes = makePanelRoutes(panelSource);
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ['exact', PANEL_ROUTES.snapshot],
      ['exact', PANEL_ROUTES.health],
      ['exact', PANEL_ROUTES.clearLedger],
      // The one route of the family that writes a file outside this plugin's
      // settings section; it is listed here so adding a write route can never be
      // done without updating this inventory.
      ['exact', PANEL_ROUTES.delegation],
      // The connection probe: outbound work on the user's behalf, so it is a POST
      // with a named profile and is listed here for the same reason as above.
      ['exact', PANEL_ROUTES.systemOneTest]
    ]
  );
  assert.deepEqual([...PANEL_PATHS], [
    PANEL_ROUTES.snapshot,
    PANEL_ROUTES.health,
    PANEL_ROUTES.clearLedger,
    PANEL_ROUTES.delegation,
    PANEL_ROUTES.systemOneTest
  ]);
  // Every path is under the one namespace, and every path is addressable.
  for (const path of PANEL_PATHS) assert.ok(path.startsWith('/dsh-reflex/api/'), path);
  assert.equal(new Set(PANEL_PATHS).size, PANEL_PATHS.length);
});

test('a 204 answer has no body even for GET', () => {
  const written = response();
  sendPanelAnswer(request('GET', '/api/x'), written, { status: 204, body: { ok: true } } satisfies PanelAnswer);
  assert.equal(written.status, 204);
  assert.equal(written.body, '');
});

test('a handler that throws answers 500 with the real detail, not an empty 400', async () => {
  // The Host turns a throw out of a route handler into a bare 400 — the shape
  // that made the "cannot get property "agents" without inject" panel outage
  // undiagnosable. The handler must answer for itself instead.
  const broken: PanelSource = {
    snapshot: () => {
      throw new Error('cannot get property "agents" without inject');
    },
    clearLedger: () => 0,
    allows: () => true
  };
  const routes = makePanelRoutes(broken);
  const snapshotRoute = routes.find((route) => route.path === PANEL_ROUTES.snapshot);
  assert.ok(snapshotRoute !== undefined);

  const written = response();
  await assert.doesNotReject(() => serve(snapshotRoute, request('GET', PANEL_ROUTES.snapshot), written));
  assert.equal(written.status, 500);
  assert.equal(written.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(written.headers['cache-control'], 'no-store');

  const body = JSON.parse(written.body) as { ok: boolean; error: string; detail: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, 'panel-handler-threw');
  // The detail must be the stack, not a generic sentence: the stack is the whole
  // point of the fallback.
  assert.match(body.detail, /cannot get property "agents" without inject/);
  assert.match(body.detail, /\n\s+at /, 'the detail must carry a stack');
});

test('a non-Error throw is still reported as a 500', async () => {
  const broken: PanelSource = {
    snapshot: () => {
      throw 'string failure';
    },
    clearLedger: () => 0,
    allows: () => true
  };
  const routes = makePanelRoutes(broken);
  const written = response();
  await serve(routes[0], request('GET', PANEL_ROUTES.snapshot), written);
  assert.equal(written.status, 500);
  assert.equal((JSON.parse(written.body) as { detail: string }).detail, 'string failure');
});

test('a dead socket during the fallback is not a second throw', async () => {
  const broken: PanelSource = {
    snapshot: () => {
      throw new Error('boom');
    },
    clearLedger: () => 0,
    allows: () => true
  };
  const routes = makePanelRoutes(broken);
  const dead = {
    writeHead: () => {
      throw new Error('headers already sent');
    },
    end: () => undefined
  };
  await assert.doesNotReject(() => serve(routes[0], request('GET', PANEL_ROUTES.snapshot), dead));
});

test('a healthy handler still answers its own status, unchanged', async () => {
  const { source: panelSource } = source();
  const routes = makePanelRoutes(panelSource);
  const written = response();
  await serve(routes[0], request('GET', PANEL_ROUTES.snapshot), written);
  assert.equal(written.status, 200);
  assert.ok(!written.body.includes('panel-handler-threw'));
});

//#endregion

/* -------------------------------------------------------------------------- */
/* Multi-profile connection block (g-057)                                      */
/* -------------------------------------------------------------------------- */

/** A profile block where one profile carries a literal (secret) key. */
const PROFILE_SECRETS = {
  primary: 'sk-profile-primary-51b0e2',
  secondary: 'sk-profile-secondary-88ac17'
} as const;

/**
 * Authored config carrying two profiles, one of them active.
 *
 * The flat fields this fixture used to carry beside the profiles are gone with
 * g-066: they connected nothing any more, and keeping them here would have made
 * the "inherited field" assertions below pass for the wrong reason. What a
 * profile does not state is now simply unstated.
 */
const MULTI_PROFILE: ReflexConfig = {
  ...AUTHORED,
  systemOne: {
    active: 'primary',
    profiles: {
      primary: { model: 'primary-model', timeoutMs: 4000, apiKey: PROFILE_SECRETS.primary },
      secondary: { baseUrl: 'http://secondary.example', model: 'secondary-model', apiKey: PROFILE_SECRETS.secondary }
    }
  }
};

test('the panel lists every profile with its non-secret fields and the active marker', () => {
  const snapshot = buildPanelSnapshot(
    facts(1, { config: resolveConfig(MULTI_PROFILE), profileKeys: { primary: { present: true, fromProfile: true }, secondary: { present: true, fromProfile: true } } })
  );
  const view = snapshot.systemOne;
  assert.equal(view.activeProfile, 'primary');
  assert.equal(view.activeProfileMissing, false);
  assert.deepEqual(view.profiles.map((profile) => profile.name), ['primary', 'secondary'], 'authored order is kept');
  const [primary, secondary] = view.profiles;
  assert.equal(primary?.active, true);
  assert.equal(secondary?.active, false);
  assert.equal(primary?.model, 'primary-model');
  assert.equal(primary?.baseUrl, undefined, 'a field the profile does not state is not inherited from anything');
  assert.equal(secondary?.baseUrl, 'http://secondary.example');
  assert.equal(primary?.apiKeyPresent, true);
  assert.equal(primary?.apiKeyFromProfile, true);
  assert.equal(primary?.apiKeyEnv, undefined, 'no variable is named, and none is borrowed');
  assert.equal(secondary?.timeoutMs, undefined, 'the second row does not inherit the first row\'s timeout');
  // The model list and its selection travel with the row: the page renders the
  // radio group from `modelIds` and the effective choice from `selectedModel`.
  assert.deepEqual(primary?.modelIds, ['primary-model']);
  assert.equal(primary?.selectedModel, 'primary-model');
  assert.equal(primary?.modelMissing, undefined);
});

test('no serialized panel answer contains a profile key, in any form', () => {
  // The criterion this whole design exists for. `config` (which really does hold
  // the keys) goes in; a payload that does not is the only acceptable out.
  const snapshot = buildPanelSnapshot(
    facts(3, {
      config: resolveConfig(MULTI_PROFILE),
      profileKeys: { primary: { present: true, fromProfile: true }, secondary: { present: true, fromProfile: true } }
    })
  );
  const serialized = JSON.stringify(snapshot);
  for (const secret of Object.values(PROFILE_SECRETS)) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret} into the panel payload`);
  }
  // Neither may the key's surrounding key name survive as a *value* carrier: the
  // only key-shaped facts on the wire are booleans.
  assert.equal(/"apiKey"\s*:/.test(serialized), false, 'the payload carries no apiKey slot at all');
  assert.equal(serialized.includes('sk-'), false, 'no key-shaped substring survives');

  // The same promise over the actual route answer, which is what a client gets.
  const panelSource: PanelSource = { snapshot: () => snapshot, clearLedger: () => 0, allows: () => true };
  const answer = answerPanelRequest(panelSource, request('GET', PANEL_ROUTES.snapshot));
  const body = JSON.stringify(answer.body);
  for (const secret of Object.values(PROFILE_SECRETS)) assert.equal(body.includes(secret), false);

  // And over the bytes actually written to the socket, through the real
  // serializer: a leak could also ride headers or a difference between the
  // answer object and what `sendPanelAnswer` emits.
  const wire = response();
  sendPanelAnswer(request('GET', PANEL_ROUTES.snapshot), wire, answer);
  for (const secret of Object.values(PROFILE_SECRETS)) {
    assert.equal(wire.body.includes(secret), false, `leaked ${secret} onto the wire`);
  }
  assert.equal(wire.body.includes('sk-'), false, 'no key-shaped substring reaches the socket');
  // The write-only inputs are still renderable: presence is on the wire, values are not.
  const parsed = JSON.parse(wire.body) as { systemOne: { profiles: { name: string; apiKeyPresent: boolean }[] } };
  assert.deepEqual(
    parsed.systemOne.profiles.map((profile) => [profile.name, profile.apiKeyPresent]),
    [
      ['primary', true],
      ['secondary', true]
    ],
    'presence is what the placeholder renders from'
  );
});

test('a resolved config that carries a key still projects presence only', () => {
  const resolved = resolveConfig(MULTI_PROFILE);
  assert.equal(resolved.systemOne.apiKey, PROFILE_SECRETS.primary, 'the runtime really does hold the active key');
  // Projected without any supplied presence facts: the projection must fall back
  // to reading presence, never the value.
  const view = buildPanelSnapshot(facts(1, { config: resolved })).systemOne;
  assert.equal(view.apiKeyFromProfile, true);
  assert.equal(view.profiles.find((profile) => profile.name === 'primary')?.apiKeyPresent, true);
  assert.equal(JSON.stringify(view).includes(PROFILE_SECRETS.primary), false);
  assert.equal(JSON.stringify(view).includes(PROFILE_SECRETS.secondary), false, 'an inactive profile key is not leaked either');
});

test('an active name matching no profile is surfaced, not hidden', () => {
  const config = resolveConfig({ ...MULTI_PROFILE, systemOne: { ...MULTI_PROFILE.systemOne, active: 'prod' } });
  const view = buildPanelSnapshot(facts(1, { config })).systemOne;
  assert.equal(view.activeProfileMissing, true);
  assert.equal(view.activeProfile, 'prod');
  assert.equal(view.baseUrl, undefined, 'nothing is resolved in place of the missing profile');
  assert.equal(view.unconfigured, 'active-profile-missing', 'the page is told nothing connects, and why');
  assert.equal(view.profiles.length, 2, 'the authored profiles are still listed, so the user can pick one');
  assert.equal(view.profiles.every((profile) => !profile.active), true, 'none of them is silently promoted');
});

test('a deployment with no profiles projects an empty list and an unconfigured state', () => {
  // A config that authors nothing at all — the shape every other fixture avoids
  // precisely because it no longer connects anything. g-067 made `systemOne: {}`
  // mean the *fresh* document (the factory connection, active), so the explicit
  // empty document is what is projected here.
  const view = buildPanelSnapshot(facts(1, { config: resolveConfig({ backend: 'jev', systemOne: { active: '', profiles: {} } }) })).systemOne;
  assert.deepEqual(view.profiles, []);
  assert.equal(view.activeProfile, undefined);
  assert.equal(view.activeProfileMissing, false);
  assert.equal(view.unconfigured, 'no-profiles', 'the page must be able to say "not configured"');
  assert.equal(view.baseUrl, undefined);
  assert.equal(view.model, undefined);
  assert.equal(view.apiKeyEnv, undefined);
});

test('the probe route is registered, refuses the wrong method, and refuses remote peers', async () => {
  assert.equal(PANEL_PATHS.includes(PANEL_ROUTES.systemOneTest), true);
  const paths = makePanelRoutes({ snapshot: () => buildPanelSnapshot(facts(1)), clearLedger: () => 0, allows: (req) => isPanelRequestAllowed(req) }).map((route) => route.path);
  assert.equal(paths.includes(PANEL_ROUTES.systemOneTest), true, 'the route family owns the probe path');

  const calls: string[] = [];
  const panelSource: PanelSource = {
    snapshot: () => buildPanelSnapshot(facts(1)),
    clearLedger: () => 0,
    allows: (req) => isPanelRequestAllowed(req),
    testSystemOne: async (profile) => {
      calls.push(profile ?? '(active)');
      return { ok: true, status: 'ok', latencyMs: 12, profile: profile ?? null };
    }
  };
  // A GET must not be able to trigger outbound work.
  const wrongMethod = await answerPanelRequestAsync(panelSource, request('GET', PANEL_ROUTES.systemOneTest));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers?.allow, 'POST');
  assert.deepEqual(calls, [], 'no probe ran for a refused method');

  const remote = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, undefined, '10.0.0.9'));
  assert.equal(remote.status, 403);
  assert.deepEqual(calls, []);
});

test('the probe route probes the active profile when the body names none', async () => {
  const calls: Array<string | undefined> = [];
  const panelSource = probeSource(async (profile) => {
    calls.push(profile);
    return { ok: true, status: 'ok', latencyMs: 7, profile: profile ?? null };
  });
  for (const [label, body] of [['no body', undefined], ['empty object', '{}'], ['empty profile', '{"profile":"  "}']] as const) {
    calls.length = 0;
    const answer = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, body));
    assert.equal(answer.status, 200, label);
    assert.deepEqual(calls, [undefined], label);
    assert.deepEqual(answer.body, { ok: true, status: 'ok', latencyMs: 7, profile: null }, label);
  }
});

test('the probe route forwards a named profile and returns its classification', async () => {
  const calls: Array<string | undefined> = [];
  const panelSource = probeSource(async (profile) => {
    calls.push(profile);
    return { ok: false, status: 'auth-failed', latencyMs: 31, profile: profile ?? null, httpStatus: 401, detail: 'the gateway rejected the API key' };
  });
  const answer = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, '{"profile":"secondary"}'));
  assert.deepEqual(calls, ['secondary']);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    ok: false,
    status: 'auth-failed',
    latencyMs: 31,
    profile: 'secondary',
    httpStatus: 401,
    detail: 'the gateway rejected the API key'
  });
});

test('the probe route refuses malformed bodies instead of guessing', async () => {
  const calls: string[] = [];
  const panelSource = probeSource(async (profile) => {
    calls.push(String(profile));
    return { ok: true, status: 'ok', latencyMs: 1, profile: profile ?? null };
  });
  for (const [body, status, error] of [
    ['{not json', 400, 'bad-json'],
    ['[]', 400, 'bad-body'],
    ['"primary"', 400, 'bad-body'],
    ['{"profile":42}', 400, 'bad-profile']
  ] as const) {
    const answer = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, body));
    assert.equal(answer.status, status, body);
    assert.equal((answer.body as { error?: string }).error, error, body);
  }
  assert.deepEqual(calls, [], 'no probe ran for an invalid body');
});

test('the probe route answers 501 when the host cannot probe', async () => {
  const panelSource: PanelSource = { snapshot: () => buildPanelSnapshot(facts(1)), clearLedger: () => 0, allows: () => true };
  const answer = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, '{}'));
  assert.equal(answer.status, 501);
  assert.equal((answer.body as { error?: string }).error, 'not-probeable');
});

test('a probe that throws becomes a classified failure, not a 500', async () => {
  const panelSource = probeSource(async () => {
    throw new Error(`boom with Bearer ${SECRET}`);
  });
  const answer = await answerPanelRequestAsync(panelSource, requestJson('POST', PANEL_ROUTES.systemOneTest, '{"profile":"primary"}'));
  assert.equal(answer.status, 200, 'a row must still render');
  const body = answer.body as { ok: boolean; status: string; detail?: string };
  assert.equal(body.ok, false);
  assert.equal(body.status, 'bad-response');
  assert.equal(JSON.stringify(body).includes(SECRET), false, 'a thrown message is redacted at the boundary too');
});

test('the panel ledger row carries the System One connection, requested model and source, and marks the model a request', () => {
  // BLOCK-5. The first attempt projected nothing onto the Web ledger, so the
  // panel's "recent decisions" table could not show which connection answered
  // or whether the answer was remote at all. The row is the wire shape the page
  // renders from, so asserting on it pins the rendering contract.
  const entries = [
    {
      id: 'ref_1',
      timestamp: '2026-11-21T12:00:00.000Z',
      type: 'choice' as const,
      backend: 'system-one-jev',
      latencyMs: 3,
      details: { systemOneConnection: 'gw', systemOneModel: 'sys-one-a', systemOneSource: 'remote' }
    },
    {
      id: 'ref_2',
      timestamp: '2026-11-21T12:00:01.000Z',
      type: 'gate' as const,
      backend: 'system-one-jev',
      latencyMs: 0,
      passed: false,
      details: { systemOneConnection: 'gw', systemOneModel: 'sys-one-a', systemOneSource: 'rejected', systemOneDetail: 'fetch failed' }
    },
    {
      id: 'ref_3',
      timestamp: '2026-11-21T12:00:02.000Z',
      type: 'prune' as const,
      backend: 'mock-heuristic-v1',
      latencyMs: 1,
      // An entry written before g-068 carries no provenance at all.
      details: {}
    }
  ];
  const snapshot = buildPanelSnapshot(
    facts(0, { ledger: { getSummary: () => SUMMARY, getEntries: () => entries, getLogPath: () => null } })
  );
  const rows = snapshot.ledger.recent;
  assert.equal(rows[0]?.systemOneConnection, 'gw');
  assert.equal(rows[0]?.systemOneModel, 'sys-one-a', 'the row carries the requested model');
  assert.equal(rows[0]?.systemOneSource, 'remote');
  assert.equal(rows[1]?.systemOneSource, 'rejected', 'a rejection is projected as a rejection');
  assert.equal(rows[1]?.systemOneDetail, 'fetch failed', 'the reason travels with it');
  assert.equal(rows[2]?.systemOneConnection, undefined, 'a legacy entry is given no connection it never recorded');
  assert.equal(rows[2]?.systemOneSource, undefined);
});
