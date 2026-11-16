/**
 * Server-side connection test for one System One profile.
 *
 * The panel's "Test" button needs to know *why* a connection fails — a wrong key
 * and an unreachable host are the same red dot to a user and completely
 * different fixes. Passive health (what {@link ReflexRuntime.systemOneHealth}
 * reports) cannot answer that: it only observes calls the runtime happened to
 * make. This module makes one deliberately small, real request and classifies
 * the outcome.
 *
 * Design rules this module keeps:
 *
 * - **The key never leaves this process.** It is read here from the resolved
 *   profile and placed in an `Authorization` header; nothing derived from it —
 *   not the header, not the key, not a prefix of it — is returned. Every string
 *   that reaches the caller passes through {@link redact}.
 * - **Bounded.** The probe uses the profile's own `timeoutMs`, clamped to
 *   {@link PROBE_TIMEOUT_MAX_MS}, and additionally guards with its own timer, so
 *   a host whose `fetch` ignores the abort signal still cannot hang the route.
 *   An in-flight probe is abortable so a closed panel does not leave one behind.
 * - **Minimal payload.** The probe sends the same one-endpoint `choice` shape
 *   the runtime sends, with one question of two criteria — a real decision, so
 *   the answer distinguishes "authenticated" from "reachable but misconfigured".
 *   It does **not** call a models-list route: the Jev gateways this plugin
 *   targets serve `POST /v1/systemone` and have no models route, so a models
 *   probe would report "unreachable" for a perfectly working deployment.
 *
 * @module dsh-reflex/systemone-probe
 */
import { normalizeSystemOneEndpoint } from './vendor/harness-reflex/backend/jev.js';

/** Model the Jev gateway serves when nothing overrides it (mirrors the vendor backend). */
const JEV_DEFAULT_MODEL = 'jev-latest';
/** Jev has no default key: an absent one is simply not sent. */
const JEV_DEFAULT_API_KEY = '';
/** Per-request timeout the vendor Jev backend falls back to, in milliseconds. */
const JEV_DEFAULT_TIMEOUT_MS = 10_000;
/** Model a local vLLM is asked for when nothing overrides it. */
const LOGITS_DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
/** A local vLLM usually checks no credentials, so a placeholder keeps the header well-formed. */
const LOGITS_DEFAULT_API_KEY = 'dummy';

/** Longest a probe may take, whatever the profile asks for. */
export const PROBE_TIMEOUT_MAX_MS = 15_000;

/** Shortest accepted probe timeout; below this a healthy gateway looks like a timeout. */
export const PROBE_TIMEOUT_MIN_MS = 250;

/**
 * The outcome classes a probe distinguishes.
 *
 * Four states, because they map onto four different user actions:
 * `ok` → nothing to do; `auth-failed` → the key is wrong; `unreachable` → the
 * address (or this machine's network) is wrong; `timeout` → the gateway is slow
 * or the limit is too tight; `bad-response` → something speaks HTTP there but
 * not the protocol this plugin expects; `misconfigured` → the plugin cannot even
 * build a request (no URL for the backend type it resolved).
 */
export type ProbeStatus = 'ok' | 'auth-failed' | 'unreachable' | 'timeout' | 'bad-response' | 'misconfigured';

/** What one probe answers. */
export interface ProbeResult {
  ok: boolean;
  status: ProbeStatus;
  /** Real round-trip time from request start to response headers, or the elapsed time of the failure. */
  latencyMs: number;
  /** HTTP status, when a response arrived. */
  httpStatus?: number;
  /** Redacted, single-line explanation. Never contains the key or the header. */
  detail?: string;
  /** Model the probe asked for. */
  model?: string;
  /** Endpoint that was contacted. Contains no credentials (URLs are checked). */
  endpoint?: string;
}

/** The connection facts one probe needs: a projected profile, never the whole config. */
export interface ProbeTarget {
  /** Profile name, for the detail line only. */
  name: string;
  backend: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /** The key to present; read by this module and never returned. */
  apiKey?: string;
  timeoutMs?: number;
}

/** Options of one probe. */
export interface ProbeOptions {
  /** Environment the `apiKeyEnv` indirection reads. */
  env?: Record<string, string | undefined>;
  /** `fetch` seam for tests. */
  fetch?: typeof fetch;
  /** Clock seam for tests. */
  now?: () => number;
  /** Signal that cancels the probe (panel closed, route disposed). */
  signal?: AbortSignal;
}

/** What one endpoint probe sends. */
export interface ProbeRequestSpec {
  url: string;
  method: 'POST';
  /** Authorization header value, or `undefined` when no key is configured. */
  authorization?: string;
  body: string;
  timeoutMs: number;
}

/**
 * Remove every credential-shaped substring from one diagnostic line.
 *
 * Belt and braces: callers are expected never to put a key in a detail string in
 * the first place, and this makes an accidental one invisible rather than
 * broadcast. It also flattens newlines so a gateway's multi-line error page
 * cannot break the panel's single-line rendering.
 *
 * @param text - raw text, possibly from a remote server.
 * @param secrets - values that must not appear (the key, the header value).
 * @returns the sanitized single-line text.
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    out = out.split(secret).join('***');
  }
  // Any Bearer token that survived (a server echoing headers, say).
  out = out.replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer ***');
  // Common key shapes, in case a server echoed a *different* credential.
  out = out.replace(/\b(sk|pk|key)-[A-Za-z0-9._-]{6,}/g, '$1-***');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
}

/**
 * Whether a URL is safe to report: it must carry no inline credentials.
 * @param url - the endpoint.
 * @returns the URL without a userinfo component, or `undefined` when unparseable.
 */
function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Build the request one probe sends for a target.
 *
 * Exported so the endpoint's shape is pinned by a test rather than reimplemented
 * in a stub server's expectations.
 * @param target - the projected profile.
 * @param env - environment the `apiKeyEnv` indirection reads.
 * @returns the request spec, or a `status` describing why none can be built.
 */
export function buildProbeRequest(
  target: ProbeTarget,
  env: Record<string, string | undefined> = process.env
): { spec: ProbeRequestSpec } | { status: ProbeStatus; detail: string } {
  const backend = target.backend === 'auto' ? 'jev' : target.backend;
  const timeoutMs = clampTimeout(target.timeoutMs);
  if (backend === 'mock') {
    return { status: 'misconfigured', detail: 'this profile resolves to the mock backend: there is no remote endpoint to test' };
  }
  // Key precedence matches the runtime: profile key, then the named variable.
  const key =
    typeof target.apiKey === 'string' && target.apiKey.length > 0
      ? target.apiKey
      : target.apiKeyEnv === undefined
        ? undefined
        : env[target.apiKeyEnv];

  if (backend === 'vllm') {
    const base = (target.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (base.length === 0) {
      return { status: 'misconfigured', detail: 'a vllm profile needs a baseUrl (e.g. http://localhost:8000)' };
    }
    const model = target.model ?? LOGITS_DEFAULT_MODEL;
    const authorization = `Bearer ${key ?? LOGITS_DEFAULT_API_KEY}`;
    return {
      spec: {
        url: `${base}/v1/completions`,
        method: 'POST',
        authorization,
        // One token, no sampling: the cheapest request that still proves the
        // model answers and the key is accepted.
        body: JSON.stringify({ model, prompt: 'ok', max_tokens: 1, temperature: 0, stream: false }),
        timeoutMs
      }
    };
  }

  const model = target.model ?? JEV_DEFAULT_MODEL;
  const keyText = key === undefined || key.length === 0 ? JEV_DEFAULT_API_KEY : key;
  // `normalizeSystemOneEndpoint` appends the path for us; the only unusable case
  // is a baseUrl the normalizer cannot turn into an absolute URL at all.
  const url = normalizeSystemOneEndpoint(target.baseUrl);
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'misconfigured', detail: `baseUrl must be an absolute http(s) URL (resolved to "${url}")` };
  }
  const body = JSON.stringify({
    model,
    state: { probe: true },
    questions: {
      probe: {
        type: 'choice',
        instructions: 'Answer whether this connection works. Either criterion is acceptable.',
        criteria: { yes: 'The connection works.', no: 'The connection does not work.' }
      }
    }
  });
  return {
    spec: {
      url,
      method: 'POST',
      ...(keyText.length > 0 ? { authorization: `Bearer ${keyText}` } : {}),
      body,
      timeoutMs
    }
  };
}

/**
 * Clamp one profile's timeout onto the probe's accepted range.
 * @param timeoutMs - authored per-request timeout.
 * @returns a bounded timeout.
 */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return JEV_DEFAULT_TIMEOUT_MS;
  return Math.min(PROBE_TIMEOUT_MAX_MS, Math.max(PROBE_TIMEOUT_MIN_MS, Math.floor(timeoutMs)));
}

/**
 * Map a rejection from `fetch` onto a probe status.
 * @param error - the thrown value.
 * @param elapsedMs - time spent before the failure.
 * @param secrets - values that must not appear in the detail.
 * @param timedOut - whether our own timer fired first.
 * @returns the classified result.
 */
function failureResult(
  error: unknown,
  elapsedMs: number,
  secrets: readonly (string | undefined)[],
  timedOut: boolean
): ProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut || /abort/i.test(message)) {
    return { ok: false, status: 'timeout', latencyMs: elapsedMs, detail: redact('the request did not complete within the probe timeout', secrets) };
  }
  // A Node `fetch` reports DNS/refused/TLS failures as TypeError('fetch failed')
  // and hides the real cause on `error.cause`.
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = cause?.code ?? '';
  const detail = redact(
    [message, cause?.message ?? ''].filter((part) => part.length > 0).join(': ') || 'the request failed',
    secrets
  );
  return {
    ok: false,
    status: 'unreachable',
    latencyMs: elapsedMs,
    detail: code.length > 0 ? redact(`${code}: ${detail}`, secrets) : detail
  };
}

/**
 * Classify one HTTP response.
 * @param response - the gateway's response.
 * @param latencyMs - round-trip time to headers.
 * @param secrets - values that must not appear in the detail.
 * @returns the classified result.
 */
async function classifyResponse(
  response: Response,
  latencyMs: number,
  secrets: readonly (string | undefined)[],
  backend: 'jev' | 'vllm'
): Promise<ProbeResult> {
  const status = response.status;
  if (status === 401 || status === 403) {
    // The body of an auth failure is the gateway's own explanation and is the
    // single most useful line a user can read — but it may echo the key back, so
    // it is redacted like everything else.
    const text = await readBodyText(response);
    return {
      ok: false,
      status: 'auth-failed',
      latencyMs,
      httpStatus: status,
      detail: redact(text.length > 0 ? text : `the gateway rejected the API key (HTTP ${String(status)})`, secrets)
    };
  }
  if (status === 408 || status === 504) {
    return { ok: false, status: 'timeout', latencyMs, httpStatus: status, detail: redact(`the gateway timed out (HTTP ${String(status)})`, secrets) };
  }
  if (status === 404) {
    return {
      ok: false,
      status: 'misconfigured',
      latencyMs,
      httpStatus: status,
      detail: redact('the endpoint path does not exist on that host (HTTP 404): check baseUrl', secrets)
    };
  }
  if (!response.ok) {
    const text = await readBodyText(response);
    return {
      ok: false,
      status: 'bad-response',
      latencyMs,
      httpStatus: status,
      detail: redact(text.length > 0 ? `HTTP ${String(status)}: ${text}` : `HTTP ${String(status)} ${response.statusText}`, secrets)
    };
  }
  // A 2xx is not yet success: the body must be the envelope the backend can use,
  // otherwise the runtime would fail on the very first real decision.
  const text = await readBodyText(response);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 'bad-response', latencyMs, httpStatus: status, detail: redact('the response was not JSON', secrets) };
  }
  // A 2xx must also carry the envelope the *backend type* will parse: the
  // single-endpoint gateways answer `{ answers }`, while an OpenAI-compatible
  // server answers `{ choices }`. Checking the wrong one would report a working
  // vLLM as broken (and a working Jev gateway as broken by the reverse).
  const shaped =
    parsed !== null &&
    typeof parsed === 'object' &&
    (backend === 'vllm' ? Array.isArray((parsed as { choices?: unknown }).choices) : (parsed as { answers?: unknown }).answers !== undefined && (parsed as { answers?: unknown }).answers !== null);
  if (!shaped) {
    return {
      ok: false,
      status: 'bad-response',
      latencyMs,
      httpStatus: status,
      detail: redact(
        backend === 'vllm'
          ? 'the response carries no "choices" list (is this really an OpenAI-compatible endpoint?)'
          : 'the response carries no "answers" envelope (is this really a System One endpoint?)',
        secrets
      )
    };
  }
  return { ok: true, status: 'ok', latencyMs, httpStatus: status };
}

/**
 * Read at most a bounded slice of a response body.
 * @param response - the response.
 * @returns its text, truncated.
 */
async function readBodyText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Probe one System One connection.
 *
 * Never throws: every failure is classified, because a test button that reports
 * "the handler threw" is less useful than one that reports "timed out after
 * 8000 ms".
 *
 * @param target - the projected profile to test.
 * @param options - environment, seams, and a cancellation signal.
 * @returns the classified result, with bounded latency and redacted detail.
 */
export async function probeSystemOne(target: ProbeTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const built = buildProbeRequest(target, env);
  if (!('spec' in built)) return { ok: false, status: built.status, latencyMs: 0, detail: redact(built.detail) };
  const { spec } = built;
  // Everything the detail must never echo.
  const secrets = [target.apiKey, spec.authorization];
  const endpoint = safeUrl(spec.url);
  // The same "auto means Jev" resolution `buildProbeRequest` applied, so the
  // success-envelope check below looks for the protocol actually spoken.
  const backend = target.backend === 'auto' ? 'jev' : target.backend;
  const model = target.model ?? (backend === 'vllm' ? LOGITS_DEFAULT_MODEL : JEV_DEFAULT_MODEL);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted === true) controller.abort();

  const started = now();
  try {
    const response = await fetchImpl(spec.url, {
      method: spec.method,
      headers: {
        'Content-Type': 'application/json',
        ...(spec.authorization === undefined ? {} : { Authorization: spec.authorization })
      },
      body: spec.body,
      signal: controller.signal
    });
    const latencyMs = Math.max(0, Math.round(now() - started));
    const classified = await classifyResponse(response, latencyMs, secrets, backend === 'vllm' ? 'vllm' : 'jev');
    return {
      ...classified,
      model,
      ...(endpoint === undefined ? {} : { endpoint })
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(now() - started));
    return { ...failureResult(error, latencyMs, secrets, timedOut), model, ...(endpoint === undefined ? {} : { endpoint }) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
