import assert from 'node:assert/strict';
import test from 'node:test';

import { DecisionLedger, MockDecisionBackend, type ChoiceResponse } from './vendor/harness-reflex/index.js';

import {
  EffortInterceptor,
  buildEffortChoice,
  buildEffortChoiceOptions,
  classifyByCues,
  cleanEffortTaskText,
  levelOfChoiceOption,
  readEffortCues,
  type EffortRequestContext,
  type EffortResolution
} from './effort.js';
import type { PhysicalTarget, ReasoningProbe, ReasoningSupport } from './router.js';

/**
 * S3 / P9 coverage: the adaptive level is *decided inside* the routed model's
 * declared vocabulary instead of being snapped onto it, and the System 1 prompt
 * never leaks the answer to its own backend.
 *
 * Every assertion observes a public seam: the returned resolution, the published
 * status, the ledger, and the System 1 choice request itself.
 */

const TARGET: PhysicalTarget = { provider: 'deepseek', model: 'reasoner' };

/** Vocabulary declared by the first-party reasoning route. */
const DEEPSEEK_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max'];

/** Vocabulary with no `off`: the model can be quiet, never silent. */
const GPT_EFFORTS: readonly string[] = ['low', 'medium', 'high'];

/** Full adaptive ladder, so every tier has an exact candidate. */
const FULL_EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high'];

const TASK_TRIVIAL = 'thanks';
const TASK_DEEP = 'design the migration protocol for the distributed store';
const TASK_CJK_TRIVIAL = '好的';
const TASK_CJK_DEEP = '分析这个并发算法的竞态条件并证明不变式成立';

/** A probe that always answers with one declared capability. */
function probeOf(support: ReasoningSupport): ReasoningProbe {
  return async () => support;
}

/**
 * One interceptor over a scripted System 1 answer.
 * @param option - the option the backend returns as its best guess.
 * @param confidence - the probability it reports for that option.
 * @returns the interceptor under test.
 */
function scripted(option: string, confidence: number): EffortInterceptor {
  return new EffortInterceptor({
    decide: async (): Promise<ChoiceResponse> => ({
      options: [{ label: option, probability: confidence }],
      bestOption: option,
      confidence,
      uncalibrated: true,
      latencyMs: 0
    }),
    backendName: 'scripted',
    now: () => 0
  });
}

/** One interceptor over the real mock System 1 backend and an in-memory ledger. */
function interceptor(): { effort: EffortInterceptor; ledger: DecisionLedger } {
  const backend = new MockDecisionBackend();
  const ledger = new DecisionLedger(null);
  const effort = new EffortInterceptor({
    decide: (request) => backend.choice(request),
    backendName: backend.name,
    ledger,
    now: () => 0
  });
  return { effort, ledger };
}

/**
 * Resolve one adaptive turn against a declared vocabulary.
 * @param efforts - the route's declared effort ids.
 * @param task - the turn input.
 * @param support - capability override (used for the non-thinking route).
 * @returns the resolution and the ledger it was written to.
 */
async function resolveTurn(
  efforts: readonly string[],
  task: string,
  support: ReasoningSupport = { kind: 'declared', efforts }
): Promise<{ resolution: EffortResolution; ledger: DecisionLedger }> {
  const { effort: engine, ledger } = interceptor();
  const context: EffortRequestContext = {
    requested: 'reflex',
    task,
    target: TARGET,
    probe: probeOf(support)
  };
  const resolution = await engine.resolve(context);
  return { resolution, ledger };
}

//#region S3 — decide inside the declared set

test('every DeepSeek decision is taken inside the declared vocabulary and never snapped', async () => {
  // One turn per cue tier, so the sample really spans the tiers rather than
  // merely being labelled as if it did.
  const turns = [
    TASK_TRIVIAL,
    'ok go ahead',
    'rename the variable for clarity',
    'fix the typo in the README',
    'implement the new config endpoint',
    'add a test for the parser function',
    TASK_DEEP,
    'review the security threat model and its trade-offs'
  ];
  const tiers = new Set<string>();
  for (const task of turns) {
    const { resolution } = await resolveTurn(DEEPSEEK_EFFORTS, task);
    tiers.add(classifyByCues(readEffortCues(task)).tier);
    assert.ok(resolution.effort !== undefined, `"${task}" must still be dispatched a level`);
    assert.ok(
      DEEPSEEK_EFFORTS.includes(resolution.effort),
      `"${task}" dispatched "${resolution.effort}", which the target never declared (${DEEPSEEK_EFFORTS.join(', ')})`
    );
    assert.equal(
      resolution.outcome,
      'supported',
      `"${task}" was snapped instead of decided inside the declared set (outcome ${resolution.outcome})`
    );
  }
  assert.deepEqual(
    [...tiers].sort(),
    ['deep', 'light', 'moderate', 'trivial'],
    'the sample must span all four cue tiers, or the claim above is weaker than it looks'
  );

  const trivial = await resolveTurn(DEEPSEEK_EFFORTS, TASK_TRIVIAL);
  assert.equal(trivial.resolution.effort, 'off', 'a trivial turn must reach the cheapest declared level');
  const deep = await resolveTurn(DEEPSEEK_EFFORTS, TASK_DEEP);
  assert.equal(deep.resolution.effort, 'high', 'a deep turn must reach the expensive declared level');
});

test('a vocabulary without "off" still returns a level taken inside the set', async () => {
  for (const task of [TASK_TRIVIAL, 'rename the variable for clarity', 'implement the new config endpoint', TASK_DEEP]) {
    const { resolution } = await resolveTurn(GPT_EFFORTS, task);
    assert.ok(resolution.effort !== undefined, `"${task}" must be dispatched a level`);
    assert.ok(
      GPT_EFFORTS.includes(resolution.effort),
      `"${task}" dispatched "${resolution.effort}", outside ${GPT_EFFORTS.join(', ')}`
    );
    assert.notEqual(resolution.effort, 'off', 'a model that declares no `off` can never be turned off');
    assert.equal(resolution.outcome, 'supported', 'the decision was taken inside the set, so nothing had to be snapped');
  }

  const trivial = await resolveTurn(GPT_EFFORTS, TASK_TRIVIAL);
  assert.equal(trivial.resolution.effort, 'low', 'the cheapest declared level is the trivial answer for this route');
  assert.equal(trivial.resolution.outcome, 'supported');
});

test('a Chinese trivial turn takes the cheapest declared level, not the expensive one', async () => {
  const { resolution } = await resolveTurn(GPT_EFFORTS, TASK_CJK_TRIVIAL);
  assert.equal(resolution.effort, 'low', `"${TASK_CJK_TRIVIAL}" must not be billed as a deep turn`);
  assert.equal(resolution.outcome, 'supported', 'a model without `off` is lowered to its cheapest declared level');
  assert.equal(resolution.changed, true, 'the caller asked for the adaptive marker, so the request must be rewritten');
});

test('a Chinese deep turn is read as deep by the cue classifier', async () => {
  const vote = classifyByCues(readEffortCues(TASK_CJK_DEEP));
  assert.equal(vote.tier, 'deep', `"${TASK_CJK_DEEP}" must be classified deep, not trivial`);
  assert.equal(vote.level, 'high', 'the classifier votes the expensive tier for a concurrency proof');

  assert.deepEqual(vote.basis, ['并发', '证明'], 'the classifier evidence is the matched cue words');

  const full = await resolveTurn(FULL_EFFORTS, TASK_CJK_DEEP);
  assert.equal(full.resolution.effort, 'high', 'on a full ladder the Chinese deep turn reaches `high`');
  assert.equal(full.resolution.outcome, 'supported');
  assert.equal(full.resolution.decision?.source, 'system-one', 'the option vocabulary itself carries the Han cues');
  assert.deepEqual(full.resolution.decision?.basis, ['high'], 'the evidence names the option System 1 answered with');
});

test('a Chinese deep turn reads the System 1 vocabulary instead of collapsing to the first candidate', async () => {
  // `MockDecisionBackend.choice` scores each option by the overlap between that
  // option's own vocabulary and the turn input. Chinese is written without
  // spaces, so a whitespace split used to discard every two-character cue word
  // (并发, 证明, 不变式), tie all three candidates at 1/3, clear the 0.3 floor as
  // a "confident" answer, and hand the turn to whichever level merely came first
  // in the ladder. Both halves of the fix are pinned here: the backend reads Han
  // grams, and a tie can never be trusted at all (the baseline test below).
  const { resolution } = await resolveTurn(GPT_EFFORTS, TASK_CJK_DEEP);
  assert.equal(resolution.decision?.source, 'system-one', 'a real vocabulary overlap must be trusted');
  assert.ok(
    (resolution.decision?.confidence ?? 0) > 1 / GPT_EFFORTS.length,
    'the trusted answer must beat the uniform baseline'
  );
  assert.equal(resolution.effort, 'high', 'the deep Chinese turn reaches the expensive declared level');
  assert.equal(resolution.outcome, 'supported', 'it was decided inside the declared set');

  const trivial = await resolveTurn(GPT_EFFORTS, TASK_CJK_TRIVIAL);
  assert.equal(trivial.resolution.effort, 'low', 'the trivial Chinese turn still reaches the cheapest declared level');
});

test('a System 1 answer that only ties the field is never trusted, whatever the candidate count', async () => {
  // The uniform baseline `1/n` clears the absolute floor for every `n >= 3`, so a
  // flat answer has to be rejected on its own terms rather than by that floor.
  for (const efforts of [GPT_EFFORTS, FULL_EFFORTS, DEEPSEEK_EFFORTS]) {
    const options = buildEffortChoiceOptions(efforts);
    const tied = Number((1 / options.length).toFixed(4));
    const engine = scripted(options[0] ?? 'low minimal thinking', tied);
    const resolution = await engine.resolve({
      requested: 'reflex',
      task: 'fix the typo in the README',
      target: TARGET,
      probe: probeOf({ kind: 'declared', efforts })
    });
    assert.equal(
      resolution.decision?.source,
      'cue-fallback',
      `${options.length} candidates: a ${tied} tie must fall back to the cues`
    );
    assert.match(
      String(resolution.decision?.degradedReason),
      /floor|baseline/,
      'the diagnosis must explain why the flat answer was refused'
    );
  }

  // Paired control: the same scripted option, one point above the baseline.
  const options = buildEffortChoiceOptions(GPT_EFFORTS);
  const trusted = await scripted(options[0] ?? 'low minimal thinking', 0.5).resolve({
    requested: 'reflex',
    task: 'fix the typo in the README',
    target: TARGET,
    probe: probeOf({ kind: 'declared', efforts: GPT_EFFORTS })
  });
  assert.equal(trusted.decision?.source, 'system-one', 'an answer above the baseline is still trusted');
  assert.equal(trusted.effort, 'low');
});

test('a target that declares no reasoning clears the effort but still votes a level', async () => {
  const { resolution, ledger } = await resolveTurn(GPT_EFFORTS, TASK_DEEP, { kind: 'none' });

  assert.equal(resolution.effort, undefined, 'a non-thinking target must receive no effort at all');
  assert.equal(resolution.outcome, 'cleared', 'the key is cleared rather than sent');
  assert.equal(resolution.changed, true, 'the caller requested the adaptive marker, so the request still has to be rewritten');
  assert.equal(resolution.status?.level, 'high', 'the cues still voted a real level for the status bar');
  assert.equal(resolution.status?.outcome, 'cleared', 'the published status reports what was actually applied');
  assert.ok(
    resolution.status?.line.includes('→ none ('),
    `the status line must show the cleared effort (got "${resolution.status?.line}")`
  );

  const decisions = ledger.getEntries().filter((entry) => entry.type === 'effort-decision');
  assert.equal(decisions.length, 1, 'exactly one effort-decision entry must be audited, and only one');
  assert.equal(ledger.getEntries().length, 1, 'no other ledger entry belongs to this decision');
  assert.equal(decisions[0]?.details?.outcome, 'cleared', 'the audit entry records the cleared outcome');
});

//#endregion

//#region P9 — the System 1 prompt must not leak the answer

test('the choice context carries no cue words and no level names', async () => {
  const cues = readEffortCues(TASK_DEEP);
  const bounded = buildEffortChoice(TASK_DEEP, cues, DEEPSEEK_EFFORTS);
  const context = String(bounded.context ?? '');
  assert.ok(context.length > 0, 'a bounded choice must explain the candidate set, or the leak check below is vacuous');

  for (const word of ['design', 'migration', 'protocol', 'distributed', 'store']) {
    assert.ok(!context.includes(word), `the context leaks the turn's own cue word "${word}": "${context}"`);
  }
  assert.doesNotMatch(
    context,
    /\boff\b|\blow\b|\bmedium\b|\bhigh\b|\bminimal\b|\bmax\b/,
    `the backend must not be able to read the level out of its own prompt: "${context}"`
  );

  const options = buildEffortChoiceOptions(DEEPSEEK_EFFORTS);
  assert.equal(bounded.options.length, options.length, 'the candidates are still enumerated');
  assert.match(
    options.join('\n'),
    /\boff\b|\blow\b|\bhigh\b|\bmax\b/,
    'the options themselves do name levels, so the context check above is a real contrast'
  );
  for (const option of bounded.options) {
    assert.ok(
      levelOfChoiceOption(option) !== undefined,
      `every option must still map to a level, got "${option.slice(0, 40)}…"`
    );
  }

  // Without a declared vocabulary there is nothing to bound, so no context at all
  // is sent rather than an empty or revealing one.
  const unbounded = buildEffortChoice(TASK_DEEP, cues);
  assert.equal(unbounded.context, undefined, 'an unbounded choice carries no context to leak');
  assert.equal(unbounded.options.length, 4, 'the default choice still enumerates the adaptive ladder');
});

test('a restatement instruction keeps its cheap level even when it quotes deep words', async () => {
  const restatements = [
    '不要优化，也不要分析，只要照抄这句话',
    '把 "design the migration protocol" 这几个字逐字发给我',
    '只返回 "design the migration protocol" 这几个字',
    'echo back "design the migration protocol for the distributed store"',
    'quoted text: "analyze the race condition" — just return it verbatim',
    'repeat verbatim: "design the migration protocol for the distributed store"'
  ];
  for (const task of restatements) {
    const { resolution } = await resolveTurn(DEEPSEEK_EFFORTS, task);
    assert.ok(
      resolution.effort === 'off' || resolution.effort === 'low',
      `"${task}" must be billed as restatement work, not as the quoted payload (got "${resolution.effort}")`
    );
    assert.equal(resolution.outcome, 'supported', 'the restatement level is a declared level of the route');
  }

  // The mirror case: a genuine deep instruction that merely mentions a quoted
  // literal keeps its deep level.
  const mirror = 'design the migration protocol — the string "hello world" must appear in the output';
  const { resolution } = await resolveTurn(DEEPSEEK_EFFORTS, mirror);
  assert.equal(resolution.effort, 'high', 'a genuine deep instruction must not be demoted by an incidental quote');
});

test('every restatement phrasing the brief named keeps its cheap level', async () => {
  // Both shapes P9 named: 原样发给我 (around a quoted payload) and 原文照抄 (a bare
  // payload after the instruction). Neither reached `VERBATIM_INSTRUCTION`, so the
  // deep words were scored as work and the turn was billed at `high`.
  const shapes = ['把 "design the migration protocol" 这几个字原样发给我', '原文照抄：design the migration protocol'];
  for (const task of shapes) {
    const cleaned = cleanEffortTaskText(task);
    assert.equal(cleaned.verbatim, true, `"${task}" must be read as a restatement instruction`);
    const { resolution } = await resolveTurn(DEEPSEEK_EFFORTS, task);
    assert.ok(
      resolution.effort === 'off' || resolution.effort === 'low',
      `"${task}" must be billed as restatement work, not as the quoted payload (got "${resolution.effort}")`
    );
    assert.equal(resolution.outcome, 'supported', 'the restatement level is a declared level of the route');
  }
});

test('a verbatim instruction clears the light, moderate and deep cue buckets', async () => {
  const task = '把 "design the migration protocol" 这几个字逐字发给我';
  const cleaned = cleanEffortTaskText(task);
  assert.equal(cleaned.verbatim, true, 'the instruction is recognised as a restatement');
  assert.deepEqual(cleaned.quoted, ['"design the migration protocol"'], 'the quoted literal is lifted out of the turn');

  const cues = readEffortCues(task);
  assert.deepEqual(cues.light, [], 'no light evidence survives a verbatim restatement');
  assert.deepEqual(cues.moderate, [], 'no moderate evidence survives a verbatim restatement');
  assert.deepEqual(cues.deep, [], 'the quoted deep words must not become evidence');
  assert.deepEqual(cues.trivial, ['verbatim restatement'], 'the only evidence left is the restatement itself');

  const vote = classifyByCues(cues);
  assert.equal(vote.tier, 'trivial', 'the classifier can only land on the trivial tier');
  assert.equal(vote.level, 'off', 'so the cheapest level is what it votes');
  assert.deepEqual(vote.basis, ['verbatim restatement'], 'and the evidence names the restatement, not the payload');
});

//#endregion

/** A hand-written System 1 answer, kept for completeness of the backend contract. */
function answer(bestOption: string, confidence: number): ChoiceResponse {
  return {
    options: [{ label: bestOption, probability: confidence }],
    bestOption,
    confidence,
    uncalibrated: true,
    latencyMs: 0
  };
}

test('a backend answer outside the candidate set is still projected onto a declared level', async () => {
  const ledger = new DecisionLedger(null);
  const effort = new EffortInterceptor({
    decide: async () => answer('high deep thinking: architecture design security', 0.9),
    backendName: 'hand-written',
    ledger,
    now: () => 0
  });
  const resolution = await effort.resolve({
    requested: 'reflex',
    task: TASK_TRIVIAL,
    target: TARGET,
    probe: probeOf({ kind: 'declared', efforts: DEEPSEEK_EFFORTS })
  });
  assert.equal(resolution.effort, 'high', 'a confident backend answer wins over the cues');
  assert.ok(DEEPSEEK_EFFORTS.includes(resolution.effort), 'and it still lands on a declared level');
  assert.equal(resolution.outcome, 'supported', 'a deliberate answer is never reported as a snap');
});
