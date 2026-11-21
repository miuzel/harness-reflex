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
 * - `source` — where the answer came from, in states that must never be
 *   collapsed: `remote`, `local` (this connection sends nothing),
 *   `local-fallback` (a remote attempt happened and its failure was absorbed
 *   locally) and `rejected` (the call failed and no answer was invented). A
 *   fifth value, `unknown`, is what a call reports when nothing it could observe
 *   *proves* any of the others — see {@link classifyEvidence}. It is a real
 *   state, not a placeholder: a backend that publishes no failure record leaves
 *   a settled call with no positive evidence that a request was answered, and
 *   claiming `remote` there is exactly the falsehood this goal removes.
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
 * What one dispatch could prove about where its answer came from.
 *
 * Every field is something the runtime *observed*; none is inferred from a
 * request id or from the settings in force at read time.
 */
export interface SourceEvidence {
  /** Whether the call produced a decision at all. */
  readonly answered: boolean;
  /** The thrown failure, when the call threw. */
  readonly failure?: string;
  /** Whether the answered value was produced locally after a remote failure. */
  readonly localFallback?: boolean;
  /** Whether this connection sends no request at all. */
  readonly localOnly: boolean;
  /**
   * Whether the backend exposes a failure record this module may read.
   *
   * Only `JevDecisionBackend` has one. The vLLM logits backend has no
   * `health()`, and its services absorb a gateway failure into a fail-closed
   * verdict the same way the JEV one does — so without a record, a settled call
   * here has **no positive evidence** that a request was made and answered.
   */
  readonly healthReadable: boolean;
  /** `consecutiveFailures` before the call, when the record is readable. */
  readonly failuresBefore?: number;
  /** `consecutiveFailures` after the call, when the record is readable. */
  readonly failuresAfter?: number;
  /** The backend's reason for its most recent failure, when readable. */
  readonly lastFailureReason?: string;
  /**
   * Whether the ledger entry this call produced arrived **after** the call
   * settled — in which case the source written on the entry cannot be trusted
   * to be this call's.
   */
  readonly entryArrivedLate?: boolean;
}

/**
 * Classify a settled attempt from evidence, preferring `unknown` to a claim.
 *
 * This is {@link classifySource} with the one question the first version got
 * wrong added: a call that resolved and *looked* remote may have had its
 * request rejected and its failure absorbed — by the gate, or by a prune that
 * fell back — and claiming `remote` for it is the precise falsehood g-068
 * forbids. Three states are therefore never guessed:
 *
 * - a **late entry** means this call's provenance could not be tied to the
 *   entry that carried it, so the source is `unknown` (the ledger line itself
 *   also says `unknown`; the two surfaces agree);
 * - a connection that sends nothing is `local` by construction, without asking;
 * - a **settled, non-local call on a backend with no readable failure record**
 *   has no positive evidence for `remote`, so it is `unknown`. The fail-closed
 *   verdict the caller still receives is unchanged; only the claim about its
 *   provenance is withdrawn.
 *
 * Everything the first version handled keeps its old answer: a thrown call is
 * `rejected`, a local answer after a failure is `local-fallback`, and a local
 * path that is reported by the service itself stays `local`/`local-fallback`.
 * @param evidence - the facts the dispatch observed.
 * @returns the source, and the detail for a non-remote one.
 */
export function classifyEvidence(evidence: SourceEvidence): { source: CallSource; detail?: string } {
  const isLocal = evidence.localOnly;
  if (evidence.entryArrivedLate === true) {
    return {
      source: isLocal ? 'local' : 'unknown',
      ...(isLocal
        ? {}
        : { detail: 'the ledger entry for this call could not be tied to it, so its source is unproven' })
    };
  }
  if (evidence.failure !== undefined) return classifySource(false, evidence.failure, false, isLocal);
  if (!evidence.answered) return classifySource(false, undefined, false, isLocal);
  if (isLocal) return classifySource(true, undefined, false, true);

  // A readable record proves a failure when the failure count rose across the
  // call. It proves a *success* only when the backend has one and did not rise;
  // without one, `remote` would be a guess.
  const before = evidence.failuresBefore ?? 0;
  const after = evidence.failuresAfter;
  const absorbed =
    after !== undefined && after > before
      ? (evidence.lastFailureReason ?? 'the System One request failed')
      : undefined;
  if (absorbed !== undefined) {
    // A failure the service absorbed is a rejection unless the caller says the
    // answered value was produced *locally* afterwards. A gate that turns a
    // gateway failure into a fail-closed `escalate` verdict made no decision of
    // its own, so it is `rejected` — not `local-fallback`, which would claim a
    // local judgment replaced the failed one.
    return classifySource(true, absorbed, evidence.localFallback === true, false);
  }

  if (evidence.healthReadable !== true || after === undefined) {
    return {
      source: 'unknown',
      detail: 'this connection exposes no failure record, so no evidence proves the request was answered'
    };
  }
  return classifySource(true, undefined, evidence.localFallback === true, false);
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
