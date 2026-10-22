import assert from 'node:assert/strict';
import test from 'node:test';

import { DecisionLedger, MockDecisionBackend, type ChoiceResponse } from './vendor/harness-reflex/index.js';

import {
  ADAPTIVE_EFFORT_LEVELS,
  EFFORT_TRIGGERS,
  EffortInterceptor,
  EffortStatusFeed,
  buildEffortChoice,
  classifyByCues,
  formatEffortStatusLine,
  isEffortTrigger,
  levelOfChoiceOption,
  projectEffort,
  readEffortCues,
  snapEffort,
  type AdaptiveEffortLevel,
  type EffortRequestContext,
  type ReflexEffortStatus
} from './effort.js';
import type { PhysicalTarget, ReasoningProbe, ReasoningSupport } from './router.js';

/**
 * Unit coverage of the adaptive-effort policy: the cue classifier, the
 * projection onto a physical vocabulary, and the interceptor's decision rules.
 * Every assertion observes a public seam (returned resolution, ledger entry,
 * published status), never a private field.
 */

const TARGET: PhysicalTarget = { provider: 'deepseek', model: 'reasoner' };

/** A probe that always answers with one declared capability. */
function probeOf(support: ReasoningSupport): ReasoningProbe {
  return async () => support;
}

/** Request context with the fields most tests care about. */
function context(overrides: Partial<EffortRequestContext> = {}): EffortRequestContext {
  return { target: TARGET, probe: probeOf({ kind: 'declared', efforts: ['off', 'low', 'medium', 'high'] }), ...overrides };
}

/** A hand-written System 1 answer, in the shape the backend contract requires. */
function answer(bestOption: string, confidence: number): ChoiceResponse {
  return {
    options: [{ label: bestOption, probability: confidence }],
    bestOption,
    confidence,
    uncalibrated: true,
    latencyMs: 0
  };
}

/** An interceptor over the real mock System 1 backend and an in-memory ledger. */
function interceptor(
  overrides: Partial<ConstructorParameters<typeof EffortInterceptor>[0]> = {}
): { effort: EffortInterceptor; ledger: DecisionLedger; feed: EffortStatusFeed } {
  const backend = new MockDecisionBackend();
  const ledger = new DecisionLedger(null);
  const feed = new EffortStatusFeed();
  const effort = new EffortInterceptor({
    decide: (request) => backend.choice(request),
    backendName: backend.name,
    ledger,
    feed,
    now: () => 0,
    ...overrides
  });
  return { effort, ledger, feed };
}

/**
 * Intent table for the accuracy checks: one user-shaped turn input per level.
 * The labels are hand-assigned, so this table is the specification the two
 * decision paths (System 1 and the cue fail-safe) are measured against. The two
 * tests below pin the measured hit counts, so a drift in either path has to be
 * acknowledged here instead of quietly lowering the accuracy.
 */
const INTENTS: ReadonlyArray<{ task: string; level: AdaptiveEffortLevel }> = [
  { task: 'thanks', level: 'off' },
  { task: 'ok go ahead', level: 'off' },
  { task: 'yes', level: 'off' },
  { task: 'sounds good', level: 'off' },
  { task: 'rename the variable for clarity', level: 'low' },
  { task: 'fix the typo in the README', level: 'low' },
  { task: 'bump the version and reformat the file', level: 'low' },
  { task: 'revert the last commit message wording', level: 'low' },
  { task: 'implement the new config endpoint', level: 'medium' },
  { task: 'add a test for the parser function', level: 'medium' },
  { task: 'update the documentation for the handler', level: 'medium' },
  { task: 'extend the CLI with a new flag', level: 'medium' },
  { task: 'wire the module into the service class', level: 'medium' },
  { task: 'design the migration protocol for the distributed store', level: 'high' },
  { task: 'analyze the race condition and prove the invariant holds', level: 'high' },
  { task: 'optimize the throughput of the concurrent algorithm', level: 'high' },
  { task: 'review the security threat model and the trade-offs', level: 'high' },
  { task: 'find the root cause of the latency regression', level: 'high' }
];

/**
 * Report accuracy the way a failing build needs it: the count *and* the misses.
 * @param label - which decision path produced the levels.
 * @param got - decided level per intent, in table order.
 * @returns a message naming every miss.
 */
function accuracyReport(label: string, got: readonly AdaptiveEffortLevel[]): string {
  const misses = INTENTS.map((intent, index) =>
    got[index] === intent.level ? undefined : `"${intent.task}" expected ${intent.level}, got ${got[index]}`
  ).filter((miss): miss is string => miss !== undefined);
  const hits = INTENTS.length - misses.length;
  return `${label}: ${hits}/${INTENTS.length} (${(hits / INTENTS.length).toFixed(2)})${misses.length === 0 ? '' : `; misses: ${misses.join('; ')}`}`;
}

test('the marker vocabulary is exactly reflex/auto', () => {
  assert.deepEqual([...EFFORT_TRIGGERS], ['reflex', 'auto']);
  assert.deepEqual([...ADAPTIVE_EFFORT_LEVELS], ['off', 'low', 'medium', 'high']);

  assert.equal(isEffortTrigger('reflex'), true);
  assert.equal(isEffortTrigger('auto'), true);
  assert.equal(isEffortTrigger('high'), false);
  assert.equal(isEffortTrigger(undefined), false);
});

test('the cue fail-safe classifies the intent table without a backend', () => {
  const got = INTENTS.map((intent) => classifyByCues(readEffortCues(intent.task)).level);
  const hits = INTENTS.filter((intent, index) => got[index] === intent.level).length;

  assert.equal(hits, 17, accuracyReport('cue fail-safe', got));
  assert.ok(hits / INTENTS.length >= 0.9, accuracyReport('cue fail-safe', got));
});

test('the interceptor decides the intent table through System 1 at speed', async () => {
  const { effort } = interceptor({ setting: 'reflex' });
  const got: AdaptiveEffortLevel[] = [];
  const latencies: number[] = [];
  const decisions = [];

  for (const intent of INTENTS) {
    const resolution = await effort.resolve(context({ requested: 'reflex', task: intent.task }));
    assert.ok(resolution.decision, `"${intent.task}" must produce a decision`);
    decisions.push(resolution.decision);
    got.push(resolution.decision.level);
    latencies.push(resolution.decision.latencyMs);
  }

  const hits = INTENTS.filter((intent, index) => got[index] === intent.level).length;
  assert.equal(hits, 18, accuracyReport('System 1 + fail-safe', got));
  assert.ok(hits / INTENTS.length >= 0.9, accuracyReport('System 1 + fail-safe', got));
  assert.ok(
    decisions.every((decision) => decision.source === 'system-one' || decision.source === 'cue-fallback'),
    'every level comes from one of the two named paths'
  );
  assert.ok(
    latencies.every((ms) => ms < 50),
    `a decision must stay in the single-digit-millisecond class (got max ${Math.max(...latencies)}ms)`
  );
});

test('the choice request carries the four levels and never leaks the cue evidence', () => {
  const cues = readEffortCues('design the migration protocol');
  const request = buildEffortChoice('design the migration protocol', cues);

  assert.equal(request.options.length, 4);
  assert.deepEqual(
    request.options.map((option) => levelOfChoiceOption(option)),
    ['off', 'low', 'medium', 'high']
  );
  // The question is the turn, the options are the ladder: the context must not
  // restate the cue words, because a backend that can read the answer out of
  // its own prompt is not making a decision (S3/P9).
  assert.doesNotMatch(String(request.context ?? ''), /design|migration|protocol/);
  assert.doesNotMatch(String(request.context ?? ''), /\boff\b|\blow\b|\bmedium\b|\bhigh\b/);

  assert.equal(levelOfChoiceOption('medium reasoning effort for a normal task'), 'medium');
  assert.equal(levelOfChoiceOption('  HIGH  '), 'high');
  assert.equal(levelOfChoiceOption('turbo the model'), undefined, 'a foreign option is not a level');
  assert.equal(levelOfChoiceOption(''), undefined);

  const empty = buildEffortChoice('', readEffortCues(''));
  assert.ok(empty.question.length > 0, 'a turn with no new instruction still asks a real question');
});

test('snapEffort picks the nearest declared level and ties go cheaper', () => {
  assert.equal(snapEffort('medium', ['off', 'low', 'medium', 'high']), 'medium', 'an exact level wins');
  assert.equal(snapEffort('medium', ['off', 'low', 'high', 'max']), 'low', 'a tie takes the cheaper neighbour');
  assert.equal(snapEffort('high', ['off', 'low']), 'low', 'the nearest rankable neighbour is used');
  assert.equal(snapEffort('off', ['high', 'max']), 'high');
  assert.equal(snapEffort('max', ['off', 'low']), 'low');
  assert.equal(snapEffort('medium', ['turbo', 'high'], 'high'), 'high', 'an unrankable vocabulary uses its declared default');
  assert.equal(snapEffort('medium', ['turbo'], 'max'), undefined, 'a default the target does not declare is not invented');
  assert.equal(snapEffort('medium', ['turbo']), undefined, 'nothing rankable and no default means nothing to send');
  assert.equal(snapEffort('medium', []), undefined);
});

test('projectEffort degrades safely on every probe answer', async () => {
  assert.deepEqual(await projectEffort('high', TARGET, probeOf({ kind: 'declared', efforts: ['low', 'high'] })), {
    effort: 'high',
    outcome: 'supported'
  });
  assert.deepEqual(await projectEffort('medium', TARGET, probeOf({ kind: 'declared', efforts: ['low', 'high'] })), {
    effort: 'low',
    outcome: 'snapped'
  });
  assert.deepEqual(await projectEffort('high', TARGET, probeOf({ kind: 'none' })), {
    outcome: 'cleared'
  });
  assert.deepEqual(await projectEffort('high', TARGET, probeOf({ kind: 'unknown' })), {
    effort: 'high',
    outcome: 'unknown'
  });
  assert.deepEqual(await projectEffort('high', TARGET, undefined), { effort: 'high', outcome: 'unknown' });
  assert.deepEqual(
    await projectEffort('high', TARGET, async () => {
      throw new Error('adapter exploded');
    }),
    { effort: 'high', outcome: 'unknown' },
    'a throwing probe must not fail the turn'
  );
});

test('an unconfigured, unmarked request is left exactly alone', async () => {
  const { effort, ledger, feed } = interceptor();

  const resolution = await effort.resolve(context({ requested: undefined, task: 'implement the endpoint' }));

  assert.deepEqual(resolution, { changed: false, outcome: 'passthrough' });
  assert.equal(ledger.getEntries().length, 0);
  assert.equal(feed.latest(), undefined);
});

test('a request that names a concrete effort passes through untouched', async () => {
  const { effort, ledger } = interceptor({ setting: 'reflex' });

  const kept = await effort.resolve(context({ requested: 'high', task: 'design the migration' }));
  assert.equal(kept.changed, false);
  assert.equal(kept.effort, 'high');
  assert.equal(kept.trigger, undefined, 'an explicit effort is not an adaptive decision');
  assert.equal(kept.status, undefined);

  const projected = await effort.resolve(
    context({
      requested: 'medium',
      target: TARGET,
      probe: probeOf({ kind: 'declared', efforts: ['off', 'low', 'high'], defaultEffort: 'low' })
    })
  );
  assert.equal(projected.changed, true, 'alignment onto the routed vocabulary still applies');
  assert.equal(projected.effort, 'low', 'an undeclared level still lands on the target default');
  assert.equal(projected.outcome, 'passthrough');
  assert.equal(
    ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length,
    0,
    'a passthrough is never audited as an effort decision'
  );
});

test('the reflex marker decides a turn and audits it once', async () => {
  const { effort, ledger, feed } = interceptor({ setting: 'reflex' });

  const resolution = await effort.resolve(
    context({ requested: 'reflex', task: 'design the migration protocol for the distributed store', agent: { agentId: 'a-1' }, turn: 3, step: 2 })
  );

  assert.equal(resolution.changed, true);
  assert.equal(resolution.trigger, 'request');
  assert.equal(resolution.effort, 'high');
  assert.equal(resolution.decision?.level, 'high');
  assert.equal(resolution.decision?.source, 'system-one');
  assert.ok((resolution.decision?.basis.length ?? 0) > 0, 'a decision must name its evidence');

  const entries = ledger.getEntries().filter((entry) => entry.type === 'effort-decision');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details?.level, 'high');
  assert.equal(entries[0].details?.applied, 'high');
  assert.equal(entries[0].details?.agentId, 'a-1');
  assert.equal(entries[0].details?.turn, 3);
  assert.equal(entries[0].details?.step, 2);
  assert.equal(entries[0].backend, 'mock-heuristic-v1');

  const status = feed.latest('a-1');
  assert.equal(status?.line, resolution.status?.line);
  assert.match(String(status?.line), /^reflex effort: high → high \(system-one \d\.\d\d, \d+ms\) deepseek:reasoner$/);
});

test('the auto alias behaves exactly like reflex', async () => {
  const { effort } = interceptor({ setting: 'auto' });

  const resolution = await effort.resolve(context({ requested: 'auto', task: 'fix the typo in the README' }));

  assert.equal(resolution.trigger, 'request');
  assert.equal(resolution.decision?.level, 'low');
  assert.equal(resolution.effort, 'low');
});

test('a configured marker decides a request that carries none', async () => {
  const { effort, ledger } = interceptor({ setting: 'reflex' });

  const resolution = await effort.resolve(context({ requested: undefined, task: 'analyze the race condition' }));

  assert.equal(resolution.trigger, 'config');
  assert.equal(resolution.effort, 'high');
  assert.equal(ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length, 1);
});

test('System 1 failures degrade to the deterministic cue vote', async () => {
  const failing = interceptor({
    setting: 'reflex',
    decide: async () => {
      throw new Error('backend offline');
    }
  });
  const degraded = await failing.effort.resolve(context({ requested: 'reflex', task: 'implement the config endpoint' }));
  assert.equal(degraded.decision?.source, 'cue-fallback');
  assert.equal(degraded.decision?.level, 'medium');
  assert.match(String(degraded.decision?.degradedReason), /backend offline/);
  assert.match(String(degraded.status?.line), /cue-fallback/);

  const foreign = interceptor({ setting: 'reflex', decide: async () => answer('turbo mode', 1) });
  const unknown = await foreign.effort.resolve(context({ requested: 'reflex', task: 'implement the config endpoint' }));
  assert.equal(unknown.decision?.source, 'cue-fallback');
  assert.match(String(unknown.decision?.degradedReason), /unknown option/);

  const shy = interceptor({ setting: 'reflex', decide: async () => answer('high deep reasoning', 0.1) });
  const floored = await shy.effort.resolve(context({ requested: 'reflex', task: 'design the protocol' }));
  assert.equal(floored.decision?.source, 'cue-fallback');
  assert.match(String(floored.decision?.degradedReason), /below the floor/);

  const confident = interceptor({ setting: 'reflex', decide: async () => answer('high deep reasoning', 0.9) });
  const trusted = await confident.effort.resolve(context({ requested: 'reflex', task: 'anything' }));
  assert.equal(trusted.decision?.source, 'system-one');
  assert.equal(trusted.decision?.confidence, 0.9);
  assert.deepEqual(trusted.decision?.basis, ['high'], 'the option label is the evidence');
});

test('a broken ledger or a hostile status carrier cannot veto a turn', async () => {
  const feed = new EffortStatusFeed();
  feed.subscribe(() => {
    throw new Error('carrier exploded');
  });
  const hostile = interceptor({
    setting: 'reflex',
    feed,
    ledger: {
      record: () => {
        throw new Error('ledger exploded');
      }
    } as unknown as DecisionLedger
  });

  const resolution = await hostile.effort.resolve(context({ requested: 'reflex', task: 'design the migration' }));

  assert.equal(resolution.effort, 'high');
  assert.equal(feed.latest()?.level, 'high', 'one broken carrier must not silence the others');
});

test('the audit payload truncates the turn input and counts one decision', async () => {
  const { effort, ledger } = interceptor({ setting: 'reflex' });
  const task = `design ${'x'.repeat(500)}`;

  const resolution = await effort.resolve(context({ requested: 'reflex', task }));

  assert.equal(resolution.status?.task?.length, 160, 'the audited excerpt is bounded');
  assert.match(String(resolution.status?.task), /^design x+$/);
  assert.equal(String(resolution.status?.task).length, 160);
  assert.equal(String(ledger.getEntries()[0].details?.goal).length, 160);
});

test('the status feed buckets by agent and can be cleared', () => {
  const feed = new EffortStatusFeed();
  const seen: ReflexEffortStatus[] = [];
  const stop = feed.subscribe((status) => seen.push(status));

  const make = (agentId: string, level: AdaptiveEffortLevel, at: number): ReflexEffortStatus => ({
    level,
    applied: level,
    outcome: 'supported',
    trigger: 'request',
    source: 'system-one',
    confidence: 0.5,
    latencyMs: 1,
    provider: 'deepseek',
    model: 'reasoner',
    line: `${agentId}:${level}`,
    at,
    agentId
  });

  feed.publish(make('a', 'low', 10));
  feed.publish(make('b', 'high', 20));
  feed.publish(make('a', 'medium', 30));

  assert.deepEqual(seen.map((status) => status.line), ['a:low', 'b:high', 'a:medium']);
  assert.equal(feed.latest('a')?.level, 'medium', 'the newest status of one agent wins');
  assert.equal(feed.latest('b')?.level, 'high');
  assert.equal(feed.latest()?.agentId, 'a', 'without an id the newest status of any agent wins');
  assert.equal(feed.statusLine('b'), 'b:high');
  assert.equal(feed.statusLine('nobody'), undefined);

  stop();
  feed.publish(make('a', 'off', 40));
  assert.equal(seen.length, 3, 'an unsubscribed carrier hears nothing');

  feed.clear();
  assert.equal(feed.latest(), undefined);
  assert.equal(feed.statusLine('a'), undefined);
});

test('the status line renders the decided level without a pin marker', () => {
  assert.equal(
    formatEffortStatusLine({
      level: 'high',
      applied: 'high',
      outcome: 'supported',
      trigger: 'request',
      source: 'system-one',
      confidence: 0.5,
      latencyMs: 2,
      provider: 'deepseek',
      model: 'reasoner',
      at: 0
    }),
    'reflex effort: high → high (system-one 0.50, 2ms) deepseek:reasoner'
  );
  assert.equal(
    formatEffortStatusLine({
      level: 'medium',
      outcome: 'cleared',
      trigger: 'request',
      source: 'cue-fallback',
      confidence: 0,
      latencyMs: 0,
      provider: 'plain',
      model: 'basic',
      at: 0
    }),
    'reflex effort: medium → none (cue-fallback 0.00, 0ms) plain:basic'
  );
});
