/**
 * The documented System One defaults must be the ones the backends actually use.
 *
 * These read as documentation tests on purpose: the user guide and the panel
 * help text promise a specific default per backend, and a backend that quietly
 * changed one would leave both documents lying. Every case clears the relevant
 * environment variables first, because a development shell that exports
 * `SYSTEM_ONE_*` would otherwise make the assertion pass for the wrong reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_DEFAULT_API_KEY,
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  LOGITS_DEFAULT_API_KEY,
  LOGITS_DEFAULT_BASE_URL,
  LOGITS_DEFAULT_MODEL,
  LOGITS_DEFAULT_TIMEOUT_MS
} from './defaults.js';
import { DEFAULT_SYSTEMONE_ENDPOINT, JevDecisionBackend } from './jev.js';
import { LogitsSystemOneBackend } from './simple-jev.js';

const BACKEND_ENV_KEYS = [
  'SYSTEM_ONE_BASE_URL',
  'SYSTEM_ONE_API_KEY',
  'SYSTEM_ONE_MODEL',
  'JEV_BASE_URL',
  'JEV_API_BASE',
  'JEV_API_KEY',
  'JEV_MODEL',
  'VLLM_BASE_URL',
  'VLLM_API_KEY',
  'VLLM_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY'
] as const;

/** Run `body` with every backend variable the constructors read cleared. */
function withCleanEnv<T>(body: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of BACKEND_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The private connection fields, read through a structural view. */
interface ConnectionView {
  endpoint?: string;
  baseUrl?: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

test('the Jev backend defaults to the documented endpoint, model, key and timeout', () => {
  withCleanEnv(() => {
    const backend = new JevDecisionBackend() as unknown as ConnectionView;
    assert.equal(backend.endpoint, JEV_DEFAULT_BASE_URL);
    assert.equal(backend.endpoint, DEFAULT_SYSTEMONE_ENDPOINT);
    assert.equal(backend.model, JEV_DEFAULT_MODEL);
    assert.equal(backend.apiKey, JEV_DEFAULT_API_KEY, 'Jev ships no default key: the service refuses an empty one');
    assert.equal(backend.timeoutMs, JEV_DEFAULT_TIMEOUT_MS);
  });
});

test('the logits backend defaults to the documented endpoint, model, key and timeout', () => {
  withCleanEnv(() => {
    const backend = new LogitsSystemOneBackend() as unknown as ConnectionView;
    assert.equal(backend.baseUrl, LOGITS_DEFAULT_BASE_URL);
    assert.equal(backend.model, LOGITS_DEFAULT_MODEL);
    assert.equal(backend.apiKey, LOGITS_DEFAULT_API_KEY, 'a local vLLM usually checks no credential');
    assert.equal(backend.timeoutMs, LOGITS_DEFAULT_TIMEOUT_MS);
  });
});

test('the two backends do not share a timeout default', () => {
  // The guide used to print one value for both. They differ, so the guide says
  // "10000 ms for jev, 8000 ms for simple-jev" and this keeps that sentence true.
  assert.notEqual(JEV_DEFAULT_TIMEOUT_MS, LOGITS_DEFAULT_TIMEOUT_MS);
  assert.equal(JEV_DEFAULT_TIMEOUT_MS, 10_000);
  assert.equal(LOGITS_DEFAULT_TIMEOUT_MS, 8000);
});

test('an environment value still wins over every default', () => {
  const saved = { ...process.env };
  try {
    process.env.SYSTEM_ONE_BASE_URL = 'http://example.test/v1/systemone';
    process.env.SYSTEM_ONE_MODEL = 'chosen-model';
    process.env.SYSTEM_ONE_API_KEY = 'sk-test';
    const jev = new JevDecisionBackend() as unknown as ConnectionView;
    assert.equal(jev.endpoint, 'http://example.test/v1/systemone');
    assert.equal(jev.model, 'chosen-model');
    assert.equal(jev.apiKey, 'sk-test');
    const logits = new LogitsSystemOneBackend() as unknown as ConnectionView;
    assert.equal(logits.baseUrl, 'http://example.test/v1/systemone');
    assert.equal(logits.model, 'chosen-model');
    assert.equal(logits.apiKey, 'sk-test');
  } finally {
    process.env = saved;
  }
});
