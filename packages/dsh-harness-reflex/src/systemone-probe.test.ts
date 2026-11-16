import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';

import { buildProbeRequest, clampTimeout, probeSystemOne, PROBE_TIMEOUT_MAX_MS, redact } from './systemone-probe.js';

/**
 * The connection test (g-057) against a local stub server.
 *
 * Every fixture here is a throwaway `http` server on loopback and a fake key
 * string; no real credential is read or used. The assertions that matter most
 * are the *negative* ones: no result, in any failure class, may contain the key.
 */

/** The secret every stub in this file is sent, and must never come back. */
const FAKE_KEY = 'sk-test-DO-NOT-LEAK-9f3a2b';

/** What a stub does with one request. */
interface StubBehaviour {
  status?: number;
  body?: string;
  /** Delay before answering. */
  delayMs?: number;
  /** Send a non-JSON body. */
  raw?: boolean;
}

/** A started stub server and its base URL. */
interface Stub {
  url: string;
  /** Requests the stub received, in order. */
  requests: Array<{ url: string; headers: IncomingMessage['headers']; body: string }>;
  close(): Promise<void>;
}

/**
 * Start a loopback server answering every request with one behaviour.
 * @param behaviour - how to answer.
 * @returns the stub handle.
 */
async function startStub(behaviour: StubBehaviour | ((request: IncomingMessage, response: ServerResponse) => void)): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', headers: request.headers, body });
      if (typeof behaviour === 'function') {
        behaviour(request, response);
        return;
      }
      const answer = (): void => {
        if (response.destroyed) return;
        const payload = behaviour.body ?? JSON.stringify({ answers: { probe: { choice: 'yes', confidence: 0.9 } } });
        response.writeHead(behaviour.status ?? 200, { 'content-type': behaviour.raw === true ? 'text/plain' : 'application/json' });
        response.end(payload);
      };
      if (behaviour.delayMs !== undefined) setTimeout(answer, behaviour.delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server did not bind a port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

/** Assert one text contains none of the credentials it must never echo. */
function assertNoSecret(text: string, ...secrets: string[]): void {
  for (const secret of [FAKE_KEY, ...secrets]) {
    assert.equal(text.includes(secret), false, `leaked "${secret}" in: ${text}`);
  }
  assert.equal(/Bearer\s+(?!\*\*\*)/.test(text), false, `leaked an Authorization header in: ${text}`);
}

test('a healthy gateway is reported ok with a real round trip', async () => {
  const stub = await startStub({});
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'jev-latest', apiKey: FAKE_KEY });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(result.httpStatus, 200);
    assert.ok(result.latencyMs >= 0 && result.latencyMs < 5_000, `latency must be a real measurement, got ${String(result.latencyMs)}`);
    assertNoSecret(JSON.stringify(result));
    // The probe really presented the credential (otherwise "ok" would prove nothing).
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0]?.headers.authorization, `Bearer ${FAKE_KEY}`);
    // And the endpoint is the one the runtime uses.
    assert.equal(stub.requests[0]?.url, '/v1/systemone');
  } finally {
    await stub.close();
  }
});

test('the probe sends one tiny choice question, not a payload', async () => {
  const stub = await startStub({});
  try {
    await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm1', apiKey: FAKE_KEY });
    const sent = JSON.parse(stub.requests[0]?.body ?? '{}');
    assert.equal(sent.model, 'm1');
    assert.deepEqual(Object.keys(sent.questions), ['probe'], 'exactly one question');
    assert.equal(sent.questions.probe.type, 'choice');
    assert.ok(Object.keys(sent.questions.probe.criteria).length <= 2, 'two criteria at most');
    assert.ok(stub.requests[0]!.body.length < 700, `a probe must stay small, got ${String(stub.requests[0]!.body.length)} bytes`);
  } finally {
    await stub.close();
  }
});

test('a rejected key is auth-failed, distinct from unreachable, and the key is redacted from the echo', async () => {
  // A careless gateway echoes the Authorization header back in its error body.
  const stub = await startStub({
    status: 401,
    body: `invalid api key: ${FAKE_KEY} (Authorization: Bearer ${FAKE_KEY})`
  });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKey: FAKE_KEY });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'auth-failed', 'a 401 must be its own class, not "unreachable"');
    assert.equal(result.httpStatus, 401);
    assert.ok(result.detail !== undefined && result.detail.length > 0);
    assertNoSecret(JSON.stringify(result));
    assert.equal(result.detail?.includes('***'), true, 'the echoed key must be visibly masked');
  } finally {
    await stub.close();
  }
});

test('a refused connection is unreachable, not a timeout', async () => {
  // Bind then immediately close, so the port is (almost certainly) free.
  const stub = await startStub({});
  const url = stub.url;
  await stub.close();
  const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: url, model: 'm', apiKey: FAKE_KEY, timeoutMs: 2_000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unreachable', 'a refused socket is a reachability problem, not slowness');
  assertNoSecret(JSON.stringify(result));
});

test('an unresolvable host is unreachable', async () => {
  const result = await probeSystemOne({
    name: 'p',
    backend: 'jev',
    baseUrl: 'http://reflex-probe.invalid',
    model: 'm',
    apiKey: FAKE_KEY,
    timeoutMs: 5_000
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unreachable');
  assertNoSecret(JSON.stringify(result));
});

test('a slow gateway is reported timeout within the bound, and does not hang', async () => {
  const stub = await startStub({ delayMs: 3_000 });
  try {
    const started = Date.now();
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKey: FAKE_KEY, timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'timeout', 'past the bound it is a timeout, not a pending forever');
    assert.ok(elapsed < 2_000, `the probe must return at the bound, took ${String(elapsed)} ms`);
    assertNoSecret(JSON.stringify(result));
  } finally {
    await stub.close();
  }
});

test('a 2xx that is not a System One envelope is bad-response, not ok', async () => {
  const stub = await startStub({ body: JSON.stringify({ hello: 'world' }) });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKey: FAKE_KEY });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'bad-response');
    assert.match(result.detail ?? '', /answers/);
  } finally {
    await stub.close();
  }
});

test('a 2xx carrying non-JSON is bad-response', async () => {
  const stub = await startStub({ body: '<html>proxy error</html>', raw: true });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKey: FAKE_KEY });
    assert.equal(result.status, 'bad-response');
    assert.match(result.detail ?? '', /not JSON/);
  } finally {
    await stub.close();
  }
});

test('a gateway timeout status is reported as timeout, a wrong path as misconfigured', async () => {
  const timed = await startStub({ status: 504, body: 'upstream timeout' });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: timed.url, model: 'm', apiKey: FAKE_KEY });
    assert.equal(result.status, 'timeout');
    assert.equal(result.httpStatus, 504);
  } finally {
    await timed.close();
  }
  const missing = await startStub({ status: 404, body: 'no route' });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: missing.url, model: 'm', apiKey: FAKE_KEY });
    assert.equal(result.status, 'misconfigured');
    assert.match(result.detail ?? '', /baseUrl/);
  } finally {
    await missing.close();
  }
});

test('concurrent probes of one profile do not cross results', async () => {
  // One stub answers slowly, one quickly, with distinguishable latencies.
  const slow = await startStub({ delayMs: 250 });
  const fast = await startStub({});
  try {
    const [a, b, c] = await Promise.all([
      probeSystemOne({ name: 'slow', backend: 'jev', baseUrl: slow.url, model: 'm', apiKey: FAKE_KEY }),
      probeSystemOne({ name: 'fast', backend: 'jev', baseUrl: fast.url, model: 'm', apiKey: FAKE_KEY }),
      probeSystemOne({ name: 'fast2', backend: 'jev', baseUrl: fast.url, model: 'm', apiKey: FAKE_KEY })
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, true);
    assert.ok(a.latencyMs >= 200, `the slow probe must report its own latency, got ${String(a.latencyMs)}`);
    assert.ok(b.latencyMs < 200, `the fast probe must not inherit the slow one's latency, got ${String(b.latencyMs)}`);
    // Each probe reached exactly the server it named.
    assert.equal(slow.requests.length, 1);
    assert.equal(fast.requests.length, 2);
  } finally {
    await slow.close();
    await fast.close();
  }
});

test('an outer abort cancels the probe without reporting a false timeout', async () => {
  const stub = await startStub({ delayMs: 2_000 });
  try {
    const controller = new AbortController();
    const pending = probeSystemOne(
      { name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKey: FAKE_KEY, timeoutMs: 10_000 },
      { signal: controller.signal }
    );
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false, 'a cancelled probe is not an ok result');
    assertNoSecret(JSON.stringify(result));
  } finally {
    await stub.close();
  }
});

test('a mock profile has no endpoint to test and says so', async () => {
  const result = await probeSystemOne({ name: 'p', backend: 'mock', model: 'm' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'misconfigured');
  assert.match(result.detail ?? '', /mock backend/);
});

test('a vllm profile probes the OpenAI-compatible completions route', async () => {
  const stub = await startStub({ body: JSON.stringify({ choices: [{ text: 'ok' }] }) });
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'vllm', baseUrl: stub.url, model: 'local', apiKey: FAKE_KEY });
    assert.equal(result.ok, true);
    assert.equal(stub.requests[0]?.url, '/v1/completions');
    const sent = JSON.parse(stub.requests[0]?.body ?? '{}');
    assert.equal(sent.max_tokens, 1, 'a probe asks for one token');
    assert.equal(sent.model, 'local');
  } finally {
    await stub.close();
  }
});

test('the key may come from an environment variable instead of the profile', async () => {
  const stub = await startStub({});
  try {
    const result = await probeSystemOne(
      { name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm', apiKeyEnv: 'PROBE_TEST_KEY' },
      { env: { PROBE_TEST_KEY: FAKE_KEY } }
    );
    assert.equal(result.ok, true);
    assert.equal(stub.requests[0]?.headers.authorization, `Bearer ${FAKE_KEY}`);
    assertNoSecret(JSON.stringify(result));
  } finally {
    await stub.close();
  }
});

test('a profile with no key at all sends no Authorization header', async () => {
  const stub = await startStub({});
  try {
    const result = await probeSystemOne({ name: 'p', backend: 'jev', baseUrl: stub.url, model: 'm' }, { env: {} });
    assert.equal(result.ok, true);
    assert.equal(stub.requests[0]?.headers.authorization, undefined, 'no empty bearer token is invented');
  } finally {
    await stub.close();
  }
});

test('the timeout is clamped into an accepted range', () => {
  assert.equal(clampTimeout(undefined), 10_000, 'the Jev backend default');
  assert.equal(clampTimeout(50), 250);
  assert.equal(clampTimeout(1_000_000), PROBE_TIMEOUT_MAX_MS);
  assert.equal(clampTimeout(Number.NaN), 10_000);
  assert.equal(clampTimeout(1234.7), 1234);
});

test('buildProbeRequest refuses a baseUrl that cannot be an http endpoint', () => {
  const built = buildProbeRequest({ name: 'p', backend: 'vllm', baseUrl: '' });
  assert.equal('status' in built, true);
  assert.equal((built as { status: string }).status, 'misconfigured');
});

test('redact strips keys, bearer headers, and key-shaped strings', () => {
  assert.equal(redact(`key=${FAKE_KEY}`, [FAKE_KEY]), 'key=***');
  assert.equal(redact('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer ***');
  assert.equal(redact('left sk-1234567890 right'), 'left sk-*** right');
  // Multi-line server bodies are flattened so the panel renders one line.
  assert.equal(redact('line one\nline two'), 'line one line two');
  assert.ok(redact('x'.repeat(1000)).length <= 243, 'detail strings are bounded');
});
