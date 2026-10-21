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
  systemOne: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'jev-small', apiKeyEnv: 'REFLEX_TEST_KEY', timeoutMs: 2500 }
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
  const snapshot = buildPanelSnapshot(facts(3));

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
  assert.deepEqual(snapshot.systemOne, {
    backend: 'jev',
    active: 'jev',
    apiKeyPresent: true,
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'jev-small',
    apiKeyEnv: 'REFLEX_TEST_KEY',
    timeoutMs: 2500
  });
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
  const minimal = resolveConfig({ backend: 'auto' });
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

test('a HEAD answer carries headers and no body', () => {
  const { source: panelSource } = source();
  const routes = makePanelRoutes(panelSource);
  const snapshotRoute = routes.find((route) => route.path === PANEL_ROUTES.snapshot);
  assert.ok(snapshotRoute !== undefined);

  const head = response();
  snapshotRoute.handler(request('HEAD', PANEL_ROUTES.snapshot) as never, head as never);
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(Number(head.headers['content-length'] ?? '0') > 0, 'content-length must describe the body HEAD suppresses');

  const get = response();
  snapshotRoute.handler(request('GET', PANEL_ROUTES.snapshot) as never, get as never);
  assert.equal(get.status, 200);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['content-length'], String(Buffer.byteLength(get.body, 'utf8')));
  assert.equal(head.headers['content-length'], get.headers['content-length'], 'a probe must see the size GET would return');
  assert.deepEqual(JSON.parse(get.body), buildPanelSnapshot(facts()));
});

test('the route family owns exactly its three exact paths', () => {
  const { source: panelSource } = source();
  const routes = makePanelRoutes(panelSource);
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ['exact', PANEL_ROUTES.snapshot],
      ['exact', PANEL_ROUTES.health],
      ['exact', PANEL_ROUTES.clearLedger]
    ]
  );
  assert.deepEqual([...PANEL_PATHS], [PANEL_ROUTES.snapshot, PANEL_ROUTES.health, PANEL_ROUTES.clearLedger]);
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

//#endregion
