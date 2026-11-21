/**
 * Per-call provenance of one System One decision: which connection and which
 * requested model were in force **when the call was dispatched**, and where the
 * answer really came from.
 *
 * ## Why this module exists (g-068)
 *
 * A session switched the active System One profile three times and then to a
 * model that does not exist. Every call still answered, and the tool payloads
 * said nothing about the connection or the model, so the only honest sentence a
 * reader could write was "no model is shown". The reader cannot be expected to
 * reconstruct provenance from a payload that omits it, and the ledger used to
 * record a *backend class name* (`mock-heuristic-v1`, `system-one-jev`) that is
 * neither the connection the user named nor the model that was asked for.
 *
 * ## The four facts, and what each one may claim
 *
 * - `connectionName` — the name of the System One connection (the profile) that
 *   was in force at dispatch. This is the one identity a human authored, so it
 *   is what "which connection answered?" must answer. It is *not* the backend
 *   class and *not* the main model the session itself is running on.
 * - `model` — the model id the runtime **requested** for this call. It is a
 *   request, never an observation: a gateway may rewrite it, and this plugin
 *   never sees what an upstream really served. Nothing here may ever be
 *   presented as "the model that answered".
 * - `source` — where the answer came from, in three states that must never be
 *   collapsed: `remote`, `local-fallback` (a remote attempt happened and its
 *   failure was absorbed locally) and `rejected` (the call failed and no answer
 *   was invented). A fourth value, `unknown`, is for a caller that cannot prove
 *   any of them.
 * - `detail` — the reason a non-remote call is non-remote, kept so a reader can
 *   tell "no connection configured" from "the gateway refused the model".
 *
 * ## Snapshot at dispatch, never re-read
 *
 * {@link callIdentity} is taken *before* the backend is awaited and carried
 * through the payload and the ledger entry. A profile switch, a concurrent
 * in-flight call, or a later history read therefore cannot restate an older
 * call: the answer keeps the identity it was asked under. That is the property
 * the `switch and in-flight` tests pin.
 *
 * ## What this module must never do
 *
 * It never reads or renders a key, an endpoint's credentials, or the main
 * model. `apiKeyEnv` is deliberately absent from {@link CallIdentity}: the
 * *name* of a variable is harmless but it is also not provenance, and a caller
 * that wants the connection's address/selector has the panel for that.
 *
 * @module dsh-reflex/attribution
 */

import type { ResolvedSystemOneConfig } from './config.js';

/**
 * Where one answer came from.
 *
 * The states g-068 must keep apart, plus `unknown` for a caller that can prove
 * none of them:
 *
 * - `remote` — the connection was asked and answered;
 * - `local` — this connection sends no request at all (the in-process mock, or
 *   an activation with no profile), so "remote" would be a lie;
 * - `local-fallback` — a remote attempt was made and **failed**, and the answer
 *   was produced locally afterwards. This is the "远端拒绝后本地降级" case;
 * - `rejected` — the remote attempt failed and the call produced no decision of
 *   its own (it threw), or produced only a fail-closed verdict.
 *
 * `local-fallback` and `rejected` are both failures of the remote attempt and
 * must never be rendered as a remote success.
 */
export type CallSource = 'remote' | 'local' | 'local-fallback' | 'rejected' | 'unknown';

/** Provenance of one decision call, as taken at dispatch. */
export interface CallIdentity {
  /**
   * Name of the System One connection in force at dispatch.
   *
   * The active profile's name, or one of the two synthetic names this module
   * defines when no profile exists: `mock` for a deployment that explicitly
   * chose the in-process implementation, `unconfigured` for an activation that
   * has no connection at all. Never the backend class name.
   */
  readonly connectionName: string;
  /**
   * The model id this call **requested**, or `null` when the connection names
   * none (nothing was sent, or the backend's own default applies).
   *
   * A request, never an observation: this plugin cannot see whether an upstream
   * served, rewrote, or ignored it. Renderers must keep that wording.
   */
  readonly requestedModel: string | null;
}

/** The connection name used when the deployment explicitly chose the mock. */
export const MOCK_CONNECTION_NAME = 'mock';

/** The connection name used when the activation has no connection at all. */
export const UNCONFIGURED_CONNECTION_NAME = 'unconfigured';

/**
 * Read the identity of the connection an activation would use right now.
 *
 * Pure and synchronous on purpose: the caller takes it at dispatch, before any
 * request leaves, so what it reports is the connection the call was *asked*
 * under rather than whatever the live config says when the answer arrives.
 *
 * The order matters and mirrors {@link createBackend}: an explicit `mock`
 * outranks the "no active profile" rule (the mock never uses a profile), and an
 * `unconfigured` connection is named as such rather than by the profile the
 * document happens to carry.
 * @param systemOne - the resolved connection block currently in force.
 * @param backendSelector - the deployment's backend selector (`auto` when unauthored).
 * @returns the identity to carry through the payload and the ledger entry.
 */
export function callIdentity(
  systemOne: ResolvedSystemOneConfig,
  backendSelector: ResolvedSystemOneConfig['backend'] | undefined
): CallIdentity {
  if (backendSelector === 'mock' || systemOne.backend === 'mock') {
    return { connectionName: MOCK_CONNECTION_NAME, requestedModel: null };
  }
  if (systemOne.unconfigured !== undefined || systemOne.active === undefined) {
    return { connectionName: UNCONFIGURED_CONNECTION_NAME, requestedModel: null };
  }
  return { connectionName: systemOne.active, requestedModel: systemOne.model ?? null };
}

/** One call's provenance as it appears in a tool payload. */
export interface Attribution {
  /**
   * Name of the System One connection the call used.
   *
   * The profile the user activated — not the backend class, and not the main
   * model this session runs on.
   */
  connectionName: string;
  /**
   * The model id this call requested from that connection; `null` when the
   * connection names none.
   *
   * A request, not an observation: whether an upstream served or rewrote it is
   * unknown to this plugin.
   */
  requestedModel: string | null;
  /** Where the answer came from (see {@link CallSource}). */
  source: CallSource;
  /** Why the source is not `remote`; absent exactly when `source` is `remote`. */
  detail?: string;
}

/**
 * Classify one settled attempt into a {@link CallSource}.
 *
 * `answered` is the only question asked of the outcome: a call that produced a
 * decision was answered, whatever path produced it. The reason decides between
 * a remote answer and a local one, because a locally absorbed failure must stay
 * distinguishable from a gateway answer.
 * @param answered - whether the call produced a decision at all.
 * @param failure - the absorbed failure, when one happened.
 * @param localFallback - whether the answered value was produced locally *after*
 *   a remote attempt failed (rather than by a local-only connection).
 * @param localOnly - whether this connection makes no request at all.
 * @returns the source, and the detail for a non-remote one.
 */
export function classifySource(
  answered: boolean,
  failure: string | undefined,
  localFallback: boolean,
  localOnly: boolean
): { source: CallSource; detail?: string } {
  if (failure !== undefined) {
    // A remote attempt happened and its request failed. What the caller did with
    // that failure is the distinction the goal exists to preserve: an answer
    // produced *locally afterwards* is a local fallback (a remote rejection that
    // was absorbed), while a call with no answer is a rejection. Neither may be
    // described as a remote success.
    return answered && localFallback
      ? { source: 'local-fallback', detail: failure }
      : { source: 'rejected', detail: failure };
  }
  if (!answered) return { source: 'rejected', detail: 'the call produced no decision' };
  // A connection that sends nothing is local by construction, not by fallback:
  // the two read differently in a ledger and mean different things to a user.
  if (localOnly) return { source: 'local', detail: `no request is sent by this connection` };
  if (localFallback) return { source: 'local-fallback', detail: 'the answer was produced locally, not by System One' };
  return { source: 'remote' };
}

/**
 * Compose the payload fields one call reports.
 * @param identity - the identity taken at dispatch.
 * @param outcome - the classified source and detail.
 * @returns the attribution object to spread into a tool payload or lead a ledger entry.
 */
export function attributionOf(identity: CallIdentity, outcome: { source: CallSource; detail?: string }): Attribution {
  return {
    connectionName: identity.connectionName,
    requestedModel: identity.requestedModel,
    source: outcome.source,
    ...(outcome.detail === undefined || outcome.detail === '' ? {} : { detail: outcome.detail })
  };
}

/**
 * The ledger's view of one call's provenance.
 *
 * Flat and prefixed (`systemOneConnection`, `systemOneModel`, `systemOneSource`)
 * rather than nested, so an existing JSONL reader that greps a single line can
 * pick the facts out without knowing the nesting, and so `backend` keeps its
 * historical meaning ("which implementation class answered") beside them. The
 * three are the facts g-068 requires the ledger to carry; none of them is ever
 * inferred from a request id, and `systemOneModel` is the *requested* id.
 */
export interface LedgerAttribution {
  /** Connection name in force at dispatch (see {@link CallIdentity.connectionName}). */
  systemOneConnection: string;
  /** Model id the call requested, `null` when the connection names none. */
  systemOneModel: string | null;
  /** Where the answer came from. */
  systemOneSource: CallSource;
  /** Why the source is not `remote`; absent when it is. */
  systemOneDetail?: string;
}

/**
 * Project an attribution onto the ledger's flat fields.
 * @param attribution - the call's attribution.
 * @returns the flat ledger fields.
 */
export function ledgerAttribution(attribution: Attribution): LedgerAttribution {
  return {
    systemOneConnection: attribution.connectionName,
    systemOneModel: attribution.requestedModel,
    systemOneSource: attribution.source,
    ...(attribution.detail === undefined ? {} : { systemOneDetail: attribution.detail })
  };
}

/**
 * Render one attribution as the single line `/reflex-ledger` prints.
 *
 * Bilingual and compact: the connection name, the requested model (marked as a
 * request), and — for a non-remote call — the source with its reason. A `remote`
 * call prints no source word, because "answered by the connection as asked" is
 * the only reading that needs no warning; a local fallback or a rejection always
 * says so.
 * @param fields - the flat ledger fields of one entry.
 * @returns the line segment, or `undefined` for an entry that predates g-068.
 */
export function describeAttribution(fields: Partial<LedgerAttribution>): string | undefined {
  if (typeof fields.systemOneConnection !== 'string' || fields.systemOneConnection === '') return undefined;
  const model = fields.systemOneModel === null || fields.systemOneModel === undefined ? '无模型 / none' : fields.systemOneModel;
  const head = `${fields.systemOneConnection} · 请求模型 ${model}`;
  switch (fields.systemOneSource) {
    case 'local':
      return `${head} · 本地作答 local`;
    case 'local-fallback':
      return `${head} · 本地降级 local-fallback${fields.systemOneDetail ? `（${fields.systemOneDetail}）` : ''}`;
    case 'rejected':
      return `${head} · 已拒绝 rejected${fields.systemOneDetail ? `（${fields.systemOneDetail}）` : ''}`;
    case 'unknown':
      return `${head} · 来源未知 unknown`;
    default:
      return head;
  }
}
