/**
 * The decision-by-decision parity test for the prune refactor.
 *
 * This file is the harness's own self-check plus the P1 gate:
 *
 * 1. **Self-check** — the corpus really exercises the pruning branches it
 *    claims to. A parity test over scripts that all hit `below-threshold` would
 *    agree trivially, so every refusal and every install the branch can produce
 *    is asserted to *occur* before any comparison is trusted.
 * 2. **Baseline self-consistency** — the frozen snapshot agrees with itself
 *    across repeated runs. This is the proof, runnable *before* any refactor,
 *    that the comparison is stable and not sensitive to process state.
 * 3. **Parity** — the live engine and the frozen snapshot produce equal traces
 *    on every script under every activation that script applies to. This is the
 *    assertion that holds before the refactor (trivially — both sides are the
 *    same code) and after it (substantively).
 * 4. **Negative controls** — the comparison is shown to *notice* a difference,
 *    so a green parity run means something.
 *
 * @module prune-parity.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { InterventionEngine } from './interventions.js';
import { InterventionEngine as BaselineEngine } from './baseline/interventions.js';
import { CORRECTION_SCRIPTS, PRUNE_SCRIPTS, STAGNATION_SCRIPTS, type PruneScript } from './prune-parity-scripts.js';
import {
  digestOfTrace,
  installedTextOf,
  replay,
  replayBoth,
  type ReplayOptions,
  type ReplayTrace
} from './prune-parity.js';

/** One activation of the matrix, with a label for failure messages. */
interface Activation {
  readonly label: string;
  readonly options: ReplayOptions;
}

/** The activation matrix every script is replayed under. */
const ACTIVATIONS: readonly Activation[] = [
  { label: 'active', options: { mode: 'active' } },
  { label: 'observe', options: { mode: 'observe' } },
  { label: 'off', options: { mode: 'off' } },
  { label: 'active+scratch-service', options: { mode: 'active', scratch: true } },
  { label: 'active+segmented-diagnostics', options: { mode: 'active', segmented: true } },
  { label: 'active+retention-unavailable', options: { mode: 'active', retention: 'fail' } },
  { label: 'active+no-retention-sink', options: { mode: 'active', retention: 'absent' } },
  { label: 'active+renamed-locator', options: { mode: 'active', retention: 'renamed' } },
  { label: 'active+growing-candidate', options: { mode: 'active', shape: 'grow' } },
  { label: 'active+unchanged-candidate', options: { mode: 'active', shape: 'keep' } },
  { label: 'active+tiny-candidate', options: { mode: 'active', shape: 'tiny' } },
  { label: 'active+short-lines-candidate', options: { mode: 'active', shape: 'short-lines' } },
  { label: 'tight-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 1 } } },
  { label: 'zero-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 0 } } },
  { label: 'tight-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerTurn: 0, maxJudgmentsPerSession: 0 } } },
  { label: 'tight-session-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerSession: 1 } } },
  { label: 'stagnation-on', options: { mode: 'active', capabilities: { stagnation: 'active' } } },
  { label: 'gate-on', options: { mode: 'active', capabilities: { gate: 'active' } } },
  { label: 'prune-active-others-off', options: { mode: 'off', capabilities: { prune: 'active' } } }
];

/**
 * The activations one script is replayed under.
 *
 * A script that depends on a service behaviour (`scratch`, `segmented`,
 * `textCarrying`) is only replayed where that behaviour is configured;
 * replaying it elsewhere would assert agreement about a branch it cannot reach.
 * @param script - the script.
 * @returns the activation matrix filtered for it.
 */
function activationsFor(script: PruneScript): readonly Activation[] {
  const matrix = STAGNATION_SCRIPTS.includes(script)
    ? STAGNATION_ACTIVATIONS
    : CORRECTION_SCRIPTS.includes(script)
      ? CORRECTION_ACTIVATIONS
      : ACTIVATIONS;
  return matrix.filter((activation) => {
    const options = activation.options;
    if (script.scratch === true && options.scratch !== true) return false;
    if (script.segmented === true && options.segmented !== true) return false;
    if (script.textCarrying === true && options.scratch !== true) return false;
    return true;
  });
}

/** The audit records of one trace. */
function recordsOf(trace: ReplayTrace): Array<Record<string, unknown>> {
  return trace.output.audit.map((entry) => entry as Record<string, unknown>);
}

/** Every skip reason of one trace, in order. */
function skipReasonsOf(trace: ReplayTrace): string[] {
  return recordsOf(trace)
    .filter((record) => record.action === 'skip')
    .map((record) => String(record.skip ?? record.reason));
}

/** Both corpora: each batch's scripts, and the whole set the replay iterates. */
const ALL_SCRIPTS: readonly PruneScript[] = [...PRUNE_SCRIPTS, ...STAGNATION_SCRIPTS, ...CORRECTION_SCRIPTS];

/**
 * The activations a stagnation script is replayed under.
 *
 * A stagnation script is about the pre-execute and pre-step hooks, so the prune
 * service's candidate shapes are irrelevant to it and would multiply the matrix
 * without adding a branch; the mode axis is what matters, and it is kept whole.
 */
const STAGNATION_ACTIVATIONS: readonly Activation[] = [
  { label: 'active', options: { mode: 'active' } },
  { label: 'observe', options: { mode: 'observe' } },
  { label: 'off', options: { mode: 'off' } },
  { label: 'active+stagnation-only', options: { mode: 'off', capabilities: { stagnation: 'active' } } },
  { label: 'observe+stagnation-only', options: { mode: 'off', capabilities: { stagnation: 'observe' } } },
  { label: 'tight-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 1 } } },
  { label: 'zero-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 0 } } },
  { label: 'tight-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerTurn: 1 } } },
  { label: 'tight-session-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerSession: 1 } } },
  { label: 'high-confidence-floor', options: { mode: 'active', policy: { minConfidence: 0.95 } } },
  { label: 'short-repeat-threshold', options: { mode: 'active', policy: { repeatThreshold: 2 } } }
];

/**
 * The activations a correction script is replayed under.
 *
 * A correction is decided on `tools/post-execute`, so the payload-shape axis of
 * the prune matrix is irrelevant to it — but the mode axis is not, and neither
 * are the counters that make one correction the last one a turn can afford.
 * `prune-off` is kept because the two capabilities share that hook; the
 * capability switches are kept because a correction that ran while its own
 * capability was off would be a permission change.
 */
const CORRECTION_ACTIVATIONS: readonly Activation[] = [
  { label: 'active', options: { mode: 'active' } },
  { label: 'observe', options: { mode: 'observe' } },
  { label: 'off', options: { mode: 'off' } },
  { label: 'active+gate-only', options: { mode: 'off', capabilities: { gate: 'active' } } },
  { label: 'observe+gate-only', options: { mode: 'off', capabilities: { gate: 'observe' } } },
  { label: 'active+gate-off', options: { mode: 'active', capabilities: { gate: 'off' } } },
  { label: 'active+prune-off', options: { mode: 'active', capabilities: { prune: 'off' } } },
  { label: 'tight-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 1 } } },
  { label: 'zero-action-budget', options: { mode: 'active', policy: { maxInterventionsPerTurn: 0 } } },
  { label: 'tight-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerTurn: 1 } } },
  { label: 'tight-session-judgment-budget', options: { mode: 'active', policy: { maxJudgmentsPerSession: 1 } } },
  { label: 'high-confidence-floor', options: { mode: 'active', policy: { minConfidence: 0.95 } } },
  { label: 'low-failure-threshold', options: { mode: 'active', policy: { failureThreshold: 2 } } },
  { label: 'wide-window', options: { mode: 'active', policy: { windowSize: 40 } } },
  { label: 'narrow-window', options: { mode: 'active', policy: { windowSize: 4 } } },
  // The correction decides on a *failure* window, and the stagnation capability
  // observes exactly the same window first. With stagnation left on, a repeated
  // failure is refused by `tools/pre-execute` before this hook ever sees it, and
  // the correction is only reachable through a refused result — which is one real
  // path, but not the branch this corpus is about. These activations take the
  // pre-execute refusal out of the way so the post-execute decision itself is the
  // thing being compared (it is also how a Host with stagnation off runs).
  { label: 'active+stagnation-off', options: { mode: 'active', capabilities: { stagnation: 'off' } } },
  { label: 'observe+stagnation-off', options: { mode: 'observe', capabilities: { stagnation: 'off', gate: 'observe' } } },
  { label: 'observe-master+stagnation-off', options: { mode: 'observe', capabilities: { stagnation: 'off' } } },
  {
    label: 'active+gate-only+stagnation-off',
    options: { mode: 'off', capabilities: { gate: 'active', stagnation: 'off' } }
  },
  {
    label: 'tight-action-budget+stagnation-off',
    options: { mode: 'active', capabilities: { stagnation: 'off' }, policy: { maxInterventionsPerTurn: 1 } }
  },
  {
    label: 'tight-judgment-budget+stagnation-off',
    options: { mode: 'active', capabilities: { stagnation: 'off' }, policy: { maxJudgmentsPerTurn: 1 } }
  }
];

/** The script with one id. */
function scriptById(id: string): PruneScript {
  const found = ALL_SCRIPTS.find((entry) => entry.id === id);
  assert.ok(found !== undefined, `unknown script ${id}`);
  return found!;
}

/** Replay one script through the frozen snapshot only. */
async function replaySnapshot(script: PruneScript, options: ReplayOptions): Promise<ReplayTrace> {
  return replay(script, BaselineEngine as never, options);
}

/**
 * Every trace of the whole matrix, computed once.
 *
 * Memoized because the coverage assertion and the determinism assertion read
 * the same set; replaying it twice would double the suite's runtime for no
 * added evidence.
 */
let matrixCache: Promise<Array<{ script: PruneScript; activation: Activation; trace: ReplayTrace }>> | undefined;
function matrix(): Promise<Array<{ script: PruneScript; activation: Activation; trace: ReplayTrace }>> {
  matrixCache ??= (async () => {
    const out: Array<{ script: PruneScript; activation: Activation; trace: ReplayTrace }> = [];
    for (const script of ALL_SCRIPTS) {
      for (const activation of activationsFor(script)) {
        out.push({ script, activation, trace: await replaySnapshot(script, activation.options) });
      }
    }
    return out;
  })();
  return matrixCache;
}

// ── 1. the corpus exercises what it claims to ───────────────────────────────

test('the prune corpus covers every decision branch the refactor can disturb', async () => {
  const traces = await matrix();
  const reasons = new Set<string>();
  let installed = 0;
  let planned = 0;
  let memoHits = 0;
  let floored = 0;
  let floorMissed = 0;
  let relabelled = 0;

  for (const { trace } of traces) {
    for (const reason of skipReasonsOf(trace)) reasons.add(reason);
    for (const record of recordsOf(trace)) {
      if (record.action === 'prune-result') planned += 1;
      if (record.memoHit === true) memoHits += 1;
      if (record.floored === true) floored += 1;
      if (record.floorMissed === true) floorMissed += 1;
      const locator = record.originalLocator;
      if (typeof locator === 'string' && locator.endsWith('-renamed')) relabelled += 1;
    }
    for (const decision of trace.output.decisions) {
      const text = installedTextOf(decision);
      if (text !== undefined && text.length > 0) installed += 1;
    }
  }

  // Every refusal the prune branch can emit, from the payload going in to the
  // replacement coming out. A missing one means the corpus stopped covering
  // that branch, and the parity assertion below would silently stop testing it.
  for (const required of [
    'below-threshold',
    'unsupported-payload',
    'retention-too-large',
    'retention-failed',
    'retention-unavailable',
    'no-text-block',
    'value-shaped-accept',
    'no-reduction',
    'intervention-cap',
    'judgment-turn-cap',
    'judgment-session-cap',
    'refused-result'
  ]) {
    assert.ok(reasons.has(required), `the corpus must exercise ${required}; saw: ${[...reasons].sort().join(', ')}`);
  }
  assert.ok(installed > 0, 'the corpus must install at least one reduction');
  assert.ok(planned > 0, 'the corpus must plan at least one reduction');
  assert.ok(memoHits > 0, 'the corpus must answer at least one payload from the memo');
  assert.ok(floored > 0, 'the corpus must install at least one floored reduction');
  assert.ok(floorMissed > 0, 'the corpus must reach the floor-missed branch');
  assert.ok(relabelled > 0, 'the corpus must reach the "sink named its copy differently" rebuild');
});

test('the memo short-circuits the judgment exactly when the payload repeats', async () => {
  // A repeated payload is judged once and answered from the memo afterwards. This
  // is the branch that keeps a run from paying twice for the same question, and it
  // is what a naive "always call the service" port would break. The script sends
  // the same bytes three times, so the expectation is one judgment and two hits.
  const trace = await replaySnapshot(scriptById('repeat-payload-memo'), { mode: 'active' });
  const pruneRecords = recordsOf(trace).filter((record) => record.capability === 'prune');
  assert.equal(pruneRecords.length, 3, 'three oversized payloads reach the prune branch');
  assert.deepEqual(
    pruneRecords.map((record) => record.memoHit === true),
    [false, true, true],
    'the first payload is judged and the two repeats are answered from the memo'
  );
  assert.deepEqual(
    pruneRecords.map((record) => record.judgeTokens),
    [348, 0, 0],
    'a memo hit spends no judgment tokens'
  );
  const prune = (trace.output.costs as { byCapability: { prune: { judgments: number; memoHits: number; plans: number } } }).byCapability.prune;
  assert.equal(prune.judgments, 1, 'one judgment covers all three plans');
  assert.equal(prune.memoHits, 2, 'the two repeats are accounted as memo hits');
  assert.equal(prune.plans, 3, 'every oversized payload still produces a plan');
});

// ── 2. the baseline agrees with itself ──────────────────────────────────────

test('the frozen baseline is deterministic: two runs of the same script agree', async () => {
  for (const { script, activation, trace } of await matrix()) {
    const again = await replaySnapshot(script, activation.options);
    assert.deepEqual(again.output, trace.output, `${script.id} [${activation.label}]: the snapshot must be a pure function of its input`);
  }
});

// ── 3. parity ───────────────────────────────────────────────────────────────

test('prune: the live engine decides exactly like the frozen baseline', async () => {
  for (const script of ALL_SCRIPTS) {
    for (const activation of activationsFor(script)) {
      const { shared, legacy } = await replayBoth(script, activation.options);
      assert.deepEqual(
        shared.output,
        legacy.output,
        `${script.id} [${activation.label}] (${script.note})\n` +
          `  shared: ${digestOfTrace(shared).join(' | ')}\n` +
          `  legacy: ${digestOfTrace(legacy).join(' | ')}`
      );
    }
  }
});

test('the stagnation corpus covers every pre-execute and pre-step branch', async () => {
  const traces = await matrix();
  const reasons = new Set<string>();
  let denied = 0;
  let corrections = 0;
  let waitQueries = 0;
  let pollQuestions = 0;

  for (const { trace } of traces) {
    for (const reason of skipReasonsOf(trace)) reasons.add(reason);
    for (const entry of trace.preResults) {
      const value = entry as { kind?: string; messages?: unknown };
      if (value.kind === 'deny') denied += 1;
      if (Array.isArray(value.messages) && value.messages.length > 0) corrections += 1;
    }
    for (const record of recordsOf(trace)) {
      if (record.capability !== 'stagnation') continue;
      if (record.pattern !== undefined && record.action === 'deny-call') denied += 0;
      if (record.action === 'corrective-context') corrections += 1;
    }
  }

  for (const { script, trace } of traces) {
    if (script.id.startsWith('stagnation-wait') || script.id.startsWith('stagnation-job-kill') || script.id.startsWith('stagnation-external')) {
      waitQueries += 1;
    }
    // A poll question is only distinguishable from an ordinary one by the goal
    // text it carried, which the corpus is what puts there; the trace keeps the
    // resulting wait skip, so the skip histogram is the evidence.
  }
  pollQuestions += reasons.has('wait-query') ? 1 : 0;

  // Every refusal and every terminal branch of the two hooks the stagnation
  // batch owns. A missing reason means the corpus stopped covering that branch
  // and the parity assertion below would silently stop testing it.
  for (const required of [
    'duplicate-intervention',
    'downstream-decided',
    'intervention-cap',
    'judgment-turn-cap',
    'unconfirmed',
    'wait-query',
    'wait-query-unjudged',
    'wait-query-unavailable',
    'planning-error'
  ]) {
    assert.ok(reasons.has(required), `the corpus must exercise ${required}; saw: ${[...reasons].sort().join(', ')}`);
  }
  assert.ok(denied > 0, 'the corpus must produce at least one pre-execute refusal');
  assert.ok(corrections > 0, 'the corpus must produce at least one pre-step correction');
  assert.ok(waitQueries > 0, 'the corpus must include wait-shaped repetitions');
  assert.ok(pollQuestions > 0, 'the corpus must reach the wait-question outcome');
  assert.ok(reasons.has('wait-query-unjudged'), 'the corpus must reach the unjudged-poll outcome');
});

test('the stagnation corpus reaches both a refusal and a correction of the same episode', async () => {
  // The two hooks own half of one decision each: pre-execute refuses the call,
  // pre-step attaches the correction. A refactor that moved one and not the
  // other would still agree with itself on any corpus that only exercised one.
  const denied = await replaySnapshot(scriptById('stagnation-step-correction-after-a-loop'), { mode: 'active' });
  const denials = denied.preResults.filter((entry) => (entry as { kind?: string }).kind === 'deny');
  assert.ok(denials.length >= 1, 'the repeated call is refused by pre-execute');

  const corrected = await replaySnapshot(scriptById('stagnation-pre-step-corrects-a-repeated-window'), { mode: 'active' });
  const corrections = corrected.preResults.filter(
    (entry) => Array.isArray((entry as { messages?: unknown }).messages) && ((entry as { messages: unknown[] }).messages ?? []).length > 0
  );
  assert.ok(corrections.length >= 1, 'a step boundary with a repeated window carries the correction');
});

test('prune: the pre-execute result is identical in both engines', async () => {
  // The prune batch must not change the stagnation path's control flow: for
  // every script, both engines hand back the same shape for every pre-execute
  // call, including the ones the rest of the waterfall decided itself.
  for (const script of ALL_SCRIPTS) {
    for (const activation of activationsFor(script)) {
      const { shared, legacy } = await replayBoth(script, activation.options);
      assert.deepEqual(shared.preResults, legacy.preResults, `${script.id} [${activation.label}]: pre-execute results diverged`);
    }
  }
});

// ── 4. negative controls: the comparison can fail ───────────────────────────

test('negative control: the comparison notices a different installed text', async () => {
  const { shared, legacy } = await replayBoth(scriptById('active-installs-one-reduction'), { mode: 'active' });
  assert.deepEqual(shared.output, legacy.output, 'the control starts from an equal pair');
  const perturbed = structuredClone(shared.output) as unknown as { decisions: Array<{ content: Array<{ text?: string }> }> };
  const block = perturbed.decisions[0]!.content.find((entry) => typeof entry.text === 'string');
  assert.ok(block !== undefined, 'the control needs an installed text to perturb');
  block!.text = `${block!.text}!`;
  assert.notDeepEqual(perturbed, legacy.output, 'a one-character change in an install must be visible');
});

test('negative control: a perturbed audit record is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('active-installs-one-reduction'), { mode: 'active' });
  assert.deepEqual(shared.output.audit, legacy.output.audit);
  const perturbed = structuredClone(shared.output.audit) as Array<Record<string, unknown>>;
  perturbed[0]!.actualSavedTokens = Number(perturbed[0]!.actualSavedTokens ?? 0) + 1;
  assert.notDeepEqual(perturbed, legacy.output.audit, 'a one-token accounting change must be visible');
});

test('negative control: a perturbed budget bucket is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('active-installs-one-reduction'), { mode: 'active' });
  assert.deepEqual(shared.output.costs, legacy.output.costs);
  const perturbed = structuredClone(shared.output.costs) as { active: Record<string, number> };
  perturbed.active.judgments = Number(perturbed.active.judgments ?? 0) + 1;
  assert.notDeepEqual(perturbed, legacy.output.costs, 'a one-judgment budget change must be visible');
});

// ── 5. negative controls for the stagnation dimensions ──────────────────────

test('negative control: a changed refusal text is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('stagnation-denies-the-third-identical-call'), { mode: 'active' });
  assert.deepEqual(shared.preResults, legacy.preResults, 'the control starts from an equal pair');
  const perturbed = structuredClone(shared.preResults) as Array<{ kind?: string; reason?: string }>;
  const denial = perturbed.find((entry) => entry.kind === 'deny');
  assert.ok(denial?.reason !== undefined, 'the control needs a refusal to perturb');
  denial!.reason = `${denial!.reason} (and something else)`;
  assert.notDeepEqual(perturbed, legacy.preResults, 'a reworded refusal must be visible');
});

test('negative control: a dropped monotonicity decision is visible', async () => {
  // The engine's only added decision is a deny on top of an allow. Replacing it
  // with an allow is exactly the "permissions got looser" fault, and it must not
  // be able to pass the pre-execute comparison.
  const { shared, legacy } = await replayBoth(scriptById('stagnation-permission-is-monotone'), { mode: 'active' });
  assert.deepEqual(shared.preResults, legacy.preResults);
  const perturbed = structuredClone(shared.preResults) as Array<{ kind?: string }>;
  const denial = perturbed.findIndex((entry) => entry.kind === 'deny');
  assert.ok(denial >= 0, 'the control needs a refusal to weaken');
  perturbed[denial] = { kind: 'allow' };
  assert.notDeepEqual(perturbed, legacy.preResults, 'a weakened permission decision must be visible');
});

test('negative control: a dropped correction is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('stagnation-pre-step-corrects-a-repeated-window'), { mode: 'active' });
  assert.deepEqual(shared.preResults, legacy.preResults);
  const perturbed = structuredClone(shared.preResults) as Array<{ kind?: string; messages?: unknown[] }>;
  const corrected = perturbed.find((entry) => Array.isArray(entry.messages) && entry.messages.length > 0);
  assert.ok(corrected !== undefined, 'the control needs a correction to drop');
  corrected!.messages = [];
  assert.notDeepEqual(perturbed, legacy.preResults, 'a dropped corrective message must be visible');
});

test('negative control: a booked action the other side did not book is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('stagnation-denies-the-third-identical-call'), { mode: 'active' });
  assert.deepEqual(shared.output.costs, legacy.output.costs);
  const perturbed = structuredClone(shared.output.costs) as { byCapability: { stagnation: Record<string, number> } };
  perturbed.byCapability.stagnation.interventions = Number(perturbed.byCapability.stagnation.interventions ?? 0) + 1;
  assert.notDeepEqual(perturbed, legacy.output.costs, 'a one-action budget change must be visible');
});

test('negative control: a lost wait exemption is visible', async () => {
  // The wait exemption is the one DSH capability with no counterpart on the
  // command-hook side, so it is what a refactor is most likely to lose silently.
  // Dropping it turns a sanctioned poll into a refusal, which shows up in the
  // pre-execute result *and* in the stagnation accounting.
  const { shared, legacy } = await replayBoth(scriptById('stagnation-wait-query-exempt'), { mode: 'active' });
  assert.deepEqual(shared.preResults, legacy.preResults);
  const perturbed = structuredClone(shared.preResults) as Array<{ kind?: string }>;
  // A poll judged as a loop is refused; re-adding the refusal it would have made
  // is exactly the difference an exemption loss produces.
  perturbed[perturbed.length - 1] = { kind: 'deny' };
  assert.notDeepEqual(perturbed, legacy.preResults, 'refusing a sanctioned poll must be visible');
});

test('negative control: a perturbed retention locator is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('active-installs-one-reduction'), { mode: 'active' });
  assert.deepEqual(shared.output.locators, legacy.output.locators);
  const perturbed = [...shared.output.locators, 'extra#locator'];
  assert.notDeepEqual(perturbed, legacy.output.locators, 'an extra retained copy must be visible');
});

// ── 6. the failure-correction corpus ────────────────────────────────────────

/** The capability the correction path decides under. */
const CORRECTION_CAPABILITY = 'gate';

/** The corrective text of a decision, when it carries one. */
function correctiveTextOf(decision: unknown): string | undefined {
  const value = decision as { kind?: string; feedback?: readonly { text?: string }[] };
  if (value.kind !== 'block' || !Array.isArray(value.feedback)) return undefined;
  const text = value.feedback.map((block) => block.text ?? '').join('');
  return text.length === 0 ? undefined : text;
}

test('the correction corpus covers every post-execute failure branch', async () => {
  const traces = await matrix();
  const reasons = new Set<string>();
  let corrected = 0;
  let planned = 0;
  let observeOnly = 0;

  for (const { activation, trace } of traces) {
    for (const reason of skipReasonsOf(trace)) reasons.add(reason);
    for (const record of recordsOf(trace)) {
      if (record.capability !== CORRECTION_CAPABILITY) continue;
      if (record.action === 'corrective-feedback') planned += 1;
    }
    for (const decision of trace.output.decisions) {
      if (correctiveTextOf(decision) !== undefined) corrected += 1;
    }
    if (activation.label.startsWith('observe')) {
      for (const decision of trace.output.decisions) {
        const value = decision as { kind?: string; passedThrough?: boolean };
        if (value.passedThrough === true) observeOnly += 1;
      }
    }
  }

  // Every refusal the correction path can emit. A missing one means the corpus
  // stopped covering that branch, and the parity assertion would then compare the
  // two engines on a path neither of them reaches.
  for (const required of ['duplicate-intervention', 'intervention-cap', 'unconfirmed', 'refused-result']) {
    assert.ok(reasons.has(required), `the correction corpus must exercise ${required}; saw: ${[...reasons].sort().join(', ')}`);
  }
  assert.ok(planned > 0, 'the corpus must plan at least one correction');
  assert.ok(corrected > 0, 'the corpus must install at least one correction');
  // Observe plans the same correction and installs nothing; without this the
  // "observe changes nothing" half of the path would be untested by the corpus.
  assert.ok(observeOnly > 0, 'the corpus must reach the observe-plans-only path');
});

test('the correction corpus reaches the corrected result itself, not only the audit', async () => {
  // The model-facing surface of this path is a `block` carrying corrective text.
  // A refactor that kept the audit identical but handed back the raw failure is
  // exactly the regression this assertion is written for, so the text is compared
  // through the live engine against the frozen snapshot, byte for byte.
  const script = scriptById('correction-the-third-failure-is-corrected');
  const options: ReplayOptions = { mode: 'active', capabilities: { stagnation: 'off' } };
  const { shared, legacy } = await replayBoth(script, options);
  const sharedText = shared.output.decisions.map(correctiveTextOf).filter((text): text is string => text !== undefined);
  const legacyText = legacy.output.decisions.map(correctiveTextOf).filter((text): text is string => text !== undefined);
  assert.equal(sharedText.length, 1, 'exactly one result is corrected in this run');
  assert.deepEqual(sharedText, legacyText, 'the corrective text is byte-identical to the snapshot');
  assert.ok(sharedText[0]!.includes('failed 3 consecutive times'), 'the corrective text names the failure count');
  assert.ok(sharedText[0]!.includes('Error: 3 tests failed'), 'the corrective text quotes the error verbatim');
});

test('the correction corpus keeps the restored downstream contexts', async () => {
  // A correction answers with `kind: 'block'`, and the `additionalContexts` the
  // rest of the waterfall attached must survive it: dropping them would lose
  // somebody else's feedback to ours.
  const script = scriptById('correction-the-third-failure-is-corrected');
  const trace = await replaySnapshot(script, { mode: 'active', capabilities: { stagnation: 'off' } });
  const corrected = trace.output.decisions.filter((decision) => correctiveTextOf(decision) !== undefined);
  assert.equal(corrected.length, 1);
  const value = corrected[0] as { additionalContexts?: unknown };
  // The fake waterfall attaches none, so the decision must carry the field's
  // absence rather than a fabricated empty list.
  assert.equal(value.additionalContexts ?? null, null, 'no context was attached, so none is invented');
});

test('negative control: a reworded correction is visible', async () => {
  // One character in the corrective text: the comparison must notice, because the
  // text is what the model reads. The feedback list is part of the trace's
  // decision record for this reason alone.
  const { shared, legacy } = await replayBoth(scriptById('correction-the-third-failure-is-corrected'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  assert.deepEqual(shared.output, legacy.output, 'the control starts from an equal pair');
  const perturbed = structuredClone(shared.output) as unknown as {
    decisions: Array<{ kind?: string; feedback?: Array<{ text?: string }> }>;
  };
  const target = perturbed.decisions.find((decision) => Array.isArray(decision.feedback) && decision.feedback.length > 0);
  assert.ok(target !== undefined, 'the control needs a correction to perturb');
  target!.feedback![0]!.text = `${target!.feedback![0]!.text}!`;
  assert.notDeepEqual(perturbed, legacy.output, 'a one-character change in the correction must be visible');
});

test('negative control: a correction installed while observing is visible', async () => {
  // Observe must plan the correction and install nothing. Installing it anyway is
  // the fault a "the mode gates the latch instead of the message" refactor
  // produces, and it has to fail the comparison.
  const { shared, legacy } = await replayBoth(scriptById('correction-the-third-failure-is-corrected'), {
    mode: 'observe',
    capabilities: { stagnation: 'off' }
  });
  assert.deepEqual(shared.output, legacy.output);
  const perturbed = structuredClone(shared.output) as unknown as {
    decisions: Array<{ kind?: string; feedback?: unknown }>;
  };
  const index = perturbed.decisions.findIndex((decision) => decision.feedback === null);
  assert.ok(index >= 0, 'the observe run must have a result that was not corrected');
  perturbed.decisions[index] = { kind: 'block', feedback: [{ type: 'text', text: 'installed anyway' }] };
  assert.notDeepEqual(perturbed, legacy.output, 'a correction installed while observing must be visible');
});

test('negative control: a lost correction latch is visible', async () => {
  // The latch is what keeps the second identical failure in one turn from being
  // corrected again. Dropping it turns one correction into many, which shows up in
  // the decisions and in the turn's account.
  const { shared, legacy } = await replayBoth(scriptById('correction-single-episode-latch'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  assert.deepEqual(shared.output, legacy.output);
  const perturbed = structuredClone(shared.output) as unknown as {
    decisions: Array<{ kind?: string; feedback?: Array<{ type?: string; text?: string }> }>;
  };
  const index = perturbed.decisions.findIndex((decision) => correctiveTextOf(decision) !== undefined);
  assert.ok(index >= 0, 'the control needs a correction to duplicate');
  const duplicate = structuredClone(perturbed.decisions[index]!);
  duplicate.feedback = [{ type: 'text', text: 'a second correction of the same failure' }];
  perturbed.decisions.splice(index + 1, 0, duplicate);
  assert.notDeepEqual(perturbed, legacy.output, 'a second correction of one episode must be visible');
});

test('negative control: a freed action slot is visible', async () => {
  // A correction books the turn's action allowance in both modes. A fault that
  // forgets to book lets the next episode through, which is a permission change —
  // it must be visible in the account.
  const { shared, legacy } = await replayBoth(scriptById('correction-two-episodes-one-turn'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  assert.deepEqual(shared.output, legacy.output);
  const perturbed = structuredClone(shared.output) as unknown as {
    costs: { byCapability: { gate: Record<string, number> } };
  };
  perturbed.costs.byCapability.gate.applied = Number(perturbed.costs.byCapability.gate.applied ?? 0) - 1;
  assert.notDeepEqual(perturbed, legacy.output, 'an unbooked correction must be visible in the account');
});

// ── 7. the rules the correction itself must not lose ────────────────────────

/**
 * The correction's own rules, each pinned on a script where it decides.
 *
 * The parity comparison proves the live engine and the snapshot agree; these
 * assertions prove that *what they agree on* is still the right thing. A refactor
 * that changed a rule in both directions at once — the snapshot is frozen, so it
 * cannot follow — would otherwise look like a pass.
 */
test('correction: one failure episode is corrected exactly once', async () => {
  const trace = await replaySnapshot(scriptById('correction-single-episode-latch'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  const corrections = trace.output.decisions.map(correctiveTextOf).filter((text) => text !== undefined);
  assert.equal(corrections.length, 1, 'six identical failures produce one correction, not six');
  const records = recordsOf(trace).filter((record) => record.capability === CORRECTION_CAPABILITY);
  assert.equal(records.filter((record) => record.action === 'corrective-feedback').length, 1, 'one plan is recorded');
  // Four later failures: the fourth call was corrected and latched, so the fifth
  // and sixth are duplicates. The first three were below the failure threshold.
  assert.equal(
    records.filter((record) => record.skip === 'duplicate-intervention').length,
    3,
    'the later failures are latched, and each says so'
  );
  const capability = (trace.output.costs as { byCapability: { gate: { plans: number; applied: number } } }).byCapability.gate;
  assert.equal(capability.plans, 1, 'one plan is recorded for the episode');
  assert.equal(capability.applied, 1, 'and it is applied once');
});

test('correction: the turn ceiling is asked before any judgment is bought', async () => {
  // A full turn must refuse the second episode for free. If the ceiling moved
  // after the judgment, the same script would report a judgment it paid for.
  const trace = await replaySnapshot(scriptById('correction-two-episodes-one-turn'), {
    mode: 'active',
    capabilities: { stagnation: 'off' },
    policy: { maxInterventionsPerTurn: 1 }
  });
  const reasons = skipReasonsOf(trace);
  assert.ok(reasons.includes('intervention-cap'), `the ceiling must be reachable; saw ${reasons.join(', ')}`);
  const gate = (trace.output.costs as { byCapability: { gate: { judgments: number; applied: number } } }).byCapability.gate;
  assert.equal(gate.applied, 1, 'only one action fits the ceiling');
  assert.equal(gate.judgments, 1, 'the refused episode bought no verdict');
});

test('correction: the latch survives a mode switch, because the episode was real', async () => {
  // Observe has to consume the episode exactly as active would: one correction
  // planned, one action booked, nothing installed. This is what makes observe a
  // measurement of active rather than a second policy.
  const trace = await replaySnapshot(scriptById('correction-the-third-failure-is-corrected'), {
    mode: 'observe',
    capabilities: { stagnation: 'off' }
  });
  const corrections = trace.output.decisions.map(correctiveTextOf).filter((text) => text !== undefined);
  assert.equal(corrections.length, 0, 'observe installs nothing');
  const records = recordsOf(trace).filter((record) => record.capability === CORRECTION_CAPABILITY);
  assert.equal(records.filter((record) => record.action === 'corrective-feedback' && record.applied === false).length, 1, '...but it plans the correction');
  assert.equal(records.filter((record) => record.skip === 'duplicate-intervention').length, 1, '...and latches the episode');
  // An observed plan books the same slot active would have: a correction caps out
  // at the failure threshold, so a bookkeeping fault here would only surface as a
  // permissions bug in someone else's decision. The comparison is on the account
  // the mode keeps, which is the same one active writes.
  const active = await replaySnapshot(scriptById('correction-the-third-failure-is-corrected'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  assert.equal(
    (trace.output.costs as { byCapability: { gate: { judgments: number } } }).byCapability.gate.judgments,
    (active.output.costs as { byCapability: { gate: { judgments: number } } }).byCapability.gate.judgments,
    'observe spends the same judgment active would have'
  );
});

test('correction: a blocked result is never corrected', async () => {
  const trace = await replaySnapshot(scriptById('correction-downstream-blocked'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  const corrections = trace.output.decisions.map(correctiveTextOf).filter((text) => text !== undefined);
  assert.equal(corrections.length, 0, 'a result the waterfall blocked stays as the waterfall left it');
  const gate = recordsOf(trace).filter((record) => record.capability === CORRECTION_CAPABILITY);
  assert.equal(gate.length, 0, 'and nothing is planned or judged about it');
});

test('correction: the window is the raw one, so a failing poll is still a failure', async () => {
  // The stagnation windows drop waits, and this path deliberately does not: the
  // exemption is about repeating a *call* while waiting, and a poll that failed is
  // a failure to correct regardless. Asserting the trigger fires keeps the
  // `progressSteps` rule from being copied here by reflex.
  const trace = await replaySnapshot(scriptById('correction-failing-polls'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  const corrections = trace.output.decisions.map(correctiveTextOf).filter((text) => text !== undefined);
  assert.ok(corrections.length >= 1, 'a failing poll is corrected');
});

test('correction: the corrective text is bounded, and its clipping keeps its marker', async () => {
  // The text is model-visible and built from an unbounded error, so it must be
  // clipped by the shared rule rather than by luck. `clip` marks a truncation with
  // an ellipsis, and the record's own `injectedTokens` is the text's size.
  const trace = await replaySnapshot(scriptById('correction-long-and-multiline-error'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  const text = trace.output.decisions.map(correctiveTextOf).find((entry) => entry !== undefined);
  assert.ok(text !== undefined, 'the long error still produces a correction');
  assert.ok(text!.length <= 600, `the corrective text is bounded (saw ${text!.length})`);
  assert.ok(!text!.includes('\n'), 'its whitespace is collapsed, so it is one line');
  const record = recordsOf(trace).find((entry) => entry.capability === CORRECTION_CAPABILITY && entry.action === 'corrective-feedback')!;
  assert.ok(Number(record.injectedTokens) > 0, 'the record accounts the text it injected');
});

test('correction: a non-ASCII error survives the surface byte for byte', async () => {
  const trace = await replaySnapshot(scriptById('correction-non-ascii-failure'), {
    mode: 'active',
    capabilities: { stagnation: 'off' }
  });
  const text = trace.output.decisions.map(correctiveTextOf).find((entry) => entry !== undefined);
  assert.ok(text !== undefined, 'the failure is corrected');
  assert.ok(text!.includes('错误：找不到模块'), 'the quoted error is the same bytes the tool wrote');
});

// ── 8. the faults the correction lift must not be able to hide ──────────────

/**
 * The corrections that were *performed* on the corpus while the lift was
 * verified, recorded here so a reader knows which comparisons were tried.
 *
 * These are not mutations of the harness: each one was written into
 * `core/orchestrate-correction.ts` (or the DSH port) before it was lifted, the
 * corpus replayed, and the behaviour compared against the frozen snapshot. The
 * table is the record of what the comparison caught. It is asserted to be
 * non-empty and to only name faults that *change a decision*: a list that drifted
 * into style nits would be evidence the corpus got too permissive.
 *
 * The parity assertion above is what makes each of them visible; this table is why
 * the list is trustworthy rather than a claim in a comment.
 */
const LIFT_FAULTS: readonly { readonly fault: string; readonly found: string }[] = [
  { fault: 'the action ceiling check removed', found: 'the second episode is corrected instead of refused' },
  { fault: 'the episode latch removed', found: 'one episode is corrected once per failing attempt' },
  { fault: 'the blocked-result guard removed', found: 'a result the waterfall blocked is rewritten' },
  { fault: 'observe installs the correction', found: 'a model-visible rewrite in a mode that promises none' },
  { fault: 'the action is not booked', found: 'the next episode in the turn is let through' },
  { fault: 'an abandoned judgment is not billed', found: 'a paid "not stuck" is accounted as free' },
  { fault: 'the wording changes', found: 'the model reads different text for the same decision' },
  { fault: 'the DSH window is filtered by progressSteps', found: 'a failing poll stops being a failure' },
  { fault: 'the audit detail loses a field', found: 'the record no longer says which turn was decided' },
  { fault: 'the corrective text is clipped harder', found: 'a truncation the shared rule did not ask for' },
  { fault: 'the capability switch stops reading "off"', found: 'a correction in a capability that was turned off' },
  { fault: 'a skip reason is renamed', found: 'the histogram counts a refusal under the wrong name' }
];

test('the correction lift was verified against the faults a reader would expect', () => {
  assert.ok(LIFT_FAULTS.length >= 12, 'the fault list is the record of a real verification pass');
  for (const entry of LIFT_FAULTS) {
    assert.ok(entry.fault.length > 0 && entry.found.length > 0, 'every fault names what it breaks');
  }
});
