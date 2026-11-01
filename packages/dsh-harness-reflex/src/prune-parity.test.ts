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
import { PRUNE_SCRIPTS, type PruneScript } from './prune-parity-scripts.js';
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
  return ACTIVATIONS.filter((activation) => {
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

/** The script with one id. */
function scriptById(id: string): PruneScript {
  const found = PRUNE_SCRIPTS.find((entry) => entry.id === id);
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
    for (const script of PRUNE_SCRIPTS) {
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
  for (const script of PRUNE_SCRIPTS) {
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

test('prune: the pre-execute result is identical in both engines', async () => {
  // The prune batch must not change the stagnation path's control flow: for
  // every script, both engines hand back the same shape for every pre-execute
  // call, including the ones the rest of the waterfall decided itself.
  for (const script of PRUNE_SCRIPTS) {
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

test('negative control: a perturbed retention locator is visible', async () => {
  const { shared, legacy } = await replayBoth(scriptById('active-installs-one-reduction'), { mode: 'active' });
  assert.deepEqual(shared.output.locators, legacy.output.locators);
  const perturbed = [...shared.output.locators, 'extra#locator'];
  assert.notDeepEqual(perturbed, legacy.output.locators, 'an extra retained copy must be visible');
});
