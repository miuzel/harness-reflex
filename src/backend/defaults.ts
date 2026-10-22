/**
 * The values each System One backend falls back to when neither the
 * deployment configuration nor the environment names one.
 *
 * They live in one place because they are shipped documentation, not
 * implementation detail: the user guide, the settings-panel help text and the
 * backends themselves must agree, and a single source is what makes a drift a
 * compile error rather than a stale sentence. They are deliberately *not* one
 * shared value per variable — the Jev gateway and a self-hosted vLLM differ in
 * every one of them.
 *
 * @module backend/defaults
 */

/** Endpoint used when neither configuration nor environment supplies a Jev base URL. */
export const JEV_DEFAULT_ENDPOINT_PATH = '/v1/systemone';
/** @see JEV_DEFAULT_ENDPOINT_PATH */
export const JEV_DEFAULT_BASE_URL = `https://api.typesafe.ai${JEV_DEFAULT_ENDPOINT_PATH}`;
/** Model id the Jev gateway serves when nothing overrides it. */
export const JEV_DEFAULT_MODEL = 'jev-latest';
/** Jev has no default key: an empty key is sent as-is and the service rejects it. */
export const JEV_DEFAULT_API_KEY = '';
/** Per-request timeout of the Jev backend, in milliseconds. */
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;

/** Endpoint used when neither configuration nor environment supplies a logits base URL. */
export const LOGITS_DEFAULT_BASE_URL = 'http://localhost:8000';
/** Model id asked for when nothing overrides it. */
export const LOGITS_DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
/** A local vLLM usually checks no credentials, so a placeholder keeps the header well-formed. */
export const LOGITS_DEFAULT_API_KEY = 'dummy';
/** Per-request timeout of the logits backend, in milliseconds. */
export const LOGITS_DEFAULT_TIMEOUT_MS = 8000;
