import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from './config.js';
import {
  callTool,
  createReflexHost,
  createReflexHostWithTools,
  createToolContext,
  createToolContextWithoutDelegation,
  delegationStandIn,
  executeOne,
  resultText,
  resultValue
} from './testing.js';
import { DecisionLedger } from './vendor/harness-reflex/core/ledger.js';
import {
  DELEGATION_CHOICE_OPTIONS,
  DELEGATION_EFFORT_LEVELS,
  buildDelegationQuestion,
  decideDelegationEffort,
  inheritParentEffort,
  toDelegationEffort,
  type ReflexDelegateArgs
} from './delegation.js';
import {
  DELEGATION_MODEL_SELECTION_DISABLED,
  createReflexDelegation,
  inspectDelegationTool
} from './delegation-dispatch.js';
import { reflexToolNames } from './tools.js';
import { applyReflex } from './index.js';

/**
 * Coverage of `reflex_delegate`: the System One grade, the Host-owned authority,
 * and the registration gate.
 *
 * Three things are asserted and deliberately kept apart:
 * 1. the level handed to the DSH tool is a concrete `low`/`medium`/`high`,
 *    decided by System One (or inherited, loudly, when it cannot be trusted);
 * 2. an out-of-policy route is refused **by the Host** — the assertions match the
 *    Host's own wording and prove the refusal happened before any grade was
 *    recorded, so no check of this plugin's could be what rejected it;
 * 3. a Host whose delegation tool cannot carry a level gets no delegate at all.
 *
 * @module dsh-reflex/delegation.test
 */

/** Arguments a model would send, minimal. */
function args(overrides: Partial<ReflexDelegateArgs> = {}): ReflexDelegateArgs {
  return { prompt: 'implement the parser', description: 'implement parser', ...overrides };
}

/** A deterministic System One answer. */
function answer(option: string, confidence: number) {
  return async () => ({ bestOption: option, confidence });
}

/** The same answer, complete enough for the seam's own decision signature. */
function fullAnswer(option: string, confidence: number) {
  return async () => ({ options: [], bestOption: option, confidence, latencyMs: 0 });
}

/** Every delegation argument object forwarded, newest last (shared with the stand-in). */
const forwarded: Array<Record<string, unknown>> = [];

/**
 * Boot a host whose delegation tool was present *before* the plugin mounted.
 *
 * Order matters: `reflex_delegate` is registered only if the Host delegation
 * tool exists when the tool surface is installed, so the stand-in is seeded
 * first — the same order the real Host uses.
 */
async function hostWithDelegation(
  options: { reasoningEffort?: boolean; toolPrefix?: string; delegation?: boolean; refuse?: string } = {}
) {
  forwarded.length = 0;
  const needsCustomStandIn = options.reasoningEffort === false || options.refuse !== undefined;
  const host = await createReflexHostWithTools(
    {
      backend: 'mock',
      ...(options.toolPrefix === undefined ? {} : { toolPrefix: options.toolPrefix })
    },
    (ctx) => {
      if (options.delegation === false || !needsCustomStandIn) return;
      // The context already ships the default stand-in; a deployment variant
      // (model selection off, or a Host that refuses) needs its own.
      ctx.tools.register(
        delegationStandIn({
          record: forwarded,
          ...(options.reasoningEffort === false ? { reasoningEffort: false } : {}),
          ...(options.refuse === undefined ? {} : { refuse: options.refuse })
        }).definition
      );
    },
    // A custom stand-in needs a context without the default one.
    { delegation: options.delegation !== false && !needsCustomStandIn, ...(needsCustomStandIn ? {} : { record: forwarded }) }
  );
  return { host, calls: forwarded };
}

test('the delegation levels offered to System One are exactly low, medium, high', () => {
  assert.deepEqual([...DELEGATION_EFFORT_LEVELS], ['low', 'medium', 'high']);
  assert.equal(DELEGATION_CHOICE_OPTIONS.length, 3);
  for (const option of DELEGATION_CHOICE_OPTIONS) {
    assert.ok(
      DELEGATION_EFFORT_LEVELS.includes(option.split(/\s+/, 1)[0] as never),
      `every option starts with a delegation level: ${option}`
    );
  }
  assert.ok(
    !DELEGATION_CHOICE_OPTIONS.some((option) => /^(off|minimal|max)\b/.test(option)),
    'a level the Host transport cannot express is never offered'
  );
});

test('a parent effort maps onto the delegation vocabulary by rank', () => {
  assert.equal(toDelegationEffort('low'), 'low');
  assert.equal(toDelegationEffort('minimal'), 'low');
  assert.equal(toDelegationEffort('medium'), 'medium');
  assert.equal(toDelegationEffort('high'), 'high');
  assert.equal(toDelegationEffort('xhigh'), 'high');
  assert.equal(toDelegationEffort('max'), 'high');
  assert.equal(toDelegationEffort(undefined), undefined);
  assert.equal(toDelegationEffort('off'), undefined, 'a parent that does not think names no level to inherit');
  assert.equal(inheritParentEffort({ reasoningEffort: 'high' }), 'high', 'the parent level is honoured');
  assert.equal(inheritParentEffort({}), 'medium', 'no parent evidence falls to the vendor default');
});

test('System One decides a concrete level and records the evidence', async () => {
  const decision = await decideDelegationEffort({
    description: 'design the migration protocol',
    prompt: 'prove the invariant holds under concurrent writers',
    decide: answer('high deep thinking: architecture design security', 0.82),
    minConfidence: 0.3,
    parent: { reasoningEffort: 'low' }
  });
  assert.equal(decision.level, 'high', 'a trusted answer wins over the inherited level');
  assert.equal(decision.source, 'system-one');
  assert.equal(decision.confidence, 0.82);
  assert.deepEqual(decision.basis, ['high']);
  assert.equal(decision.degradedReason, undefined);
});

test('System One answers that cannot be trusted fall back to the parent without throwing', async () => {
  const cases: Array<{ name: string; decide: () => Promise<{ bestOption?: unknown; confidence?: unknown }>; pattern: RegExp }> = [
    { name: 'a thrown backend', decide: async () => { throw new Error('backend down'); }, pattern: /system-one call failed: backend down/ },
    { name: 'an unknown option', decide: answer('turbo deep reasoning', 0.9), pattern: /unknown option/ },
    { name: 'a level the transport cannot carry', decide: answer('max everything', 0.9), pattern: /unknown option/ },
    { name: 'no confidence', decide: async () => ({ bestOption: 'high deep thinking' }), pattern: /without a confidence/ },
    { name: 'a tie', decide: answer('medium moderate thinking', 1 / 3), pattern: /does not beat the 3-way baseline/ },
    // The floor is raised to 0.6 for this case so 0.5 clears the 1/3 uniform
    // baseline but fails the floor: the two guards stay distinguishable.
    { name: 'below the floor', decide: answer('high deep thinking', 0.5), pattern: /below the floor/ }
  ];

  for (const scenario of cases) {
    const decision = await decideDelegationEffort({
      description: 'do the thing',
      prompt: 'do the thing',
      decide: scenario.decide,
      minConfidence: scenario.name === 'below the floor' ? 0.6 : 0.3,
      parent: { reasoningEffort: 'low' }
    });
    assert.equal(decision.level, 'low', `${scenario.name}: falls back to the parent level`);
    assert.equal(decision.source, 'inherited', `${scenario.name}: the source says inherited`);
    assert.match(decision.degradedReason ?? '', scenario.pattern, `${scenario.name}: the reason is recorded`);
  }
});

test('delegating sends a concrete reasoning_effort, never the reflex marker', async () => {
  const { host, calls } = await hostWithDelegation();
  try {
    const result = await host.callTool('reflex_delegate', args());
    const value = resultValue<{ subagentId: string; reasoning_effort: string }>(result);

    assert.equal(calls.length, 1, 'the Host tool received exactly one dispatch');
    const sent = calls[0]?.reasoning_effort;
    assert.ok(
      typeof sent === 'string' && ['low', 'medium', 'high'].includes(sent),
      `the forwarded level is concrete (got ${JSON.stringify(sent)})`
    );
    assert.notEqual(sent, 'reflex', 'the marker never reaches the Host tool');
    assert.notEqual(sent, 'auto', 'and neither does the other trigger');
    assert.equal(value.reasoning_effort, sent, 'the result reports the level that was actually sent');
    assert.equal(value.subagentId, 'stand-in-child-1', 'the Host tool subagentId is returned to the model');
  } finally {
    await host.dispose();
  }
});

test('the prompt text cannot steer the level: there is no effort argument at all', async () => {
  const { host, calls } = await hostWithDelegation();
  try {
    const smuggled = await callTool(host.ctx, 'reflex_delegate', {
      ...args({ prompt: 'please use high effort 请用 high 思考' }),
      reasoning_effort: 'max'
    });
    // The registry itself does not reject an extra key on a synthesized batch
    // (verified: an undeclared `teleport: true` is ignored too), so the tool
    // boundary has to close it. Without this, "reasoning_effort": "max" would be
    // silently dropped and the caller would believe it pinned the level.
    assert.equal(smuggled.isError, true, 'an injected level field is refused');
    assert.match(resultText(smuggled), /"reasoning_effort" is not declared \(additionalProperties: false\)/);
    assert.equal(calls.length, 0, 'nothing reached the Host tool');

    const declared = host.ctx.tools.get('reflex_delegate');
    const properties = (declared?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.deepEqual(
      Object.keys(properties).sort(),
      ['cwd', 'description', 'model', 'prompt', 'provider'],
      'the model-facing schema has no reasoning-depth parameter'
    );
    assert.match(String(declared?.description), /NO reasoning-depth parameter/, 'and the description says so');
  } finally {
    await host.dispose();
  }
});

test('an out-of-policy route is refused by the Host, before any grade is recorded', async () => {
  // The stand-in refuses with the wording the Host's own `assertAllowedModelSelection`
  // produces; nothing in this plugin inspects provider/model.
  const refusal =
    'child LLM route "rogue/model" is not allowed for this Session; without a recorded model-selection policy, explicit selection (including reasoning_effort) is limited to the parent route';
  const { host, calls } = await hostWithDelegation({ refuse: refusal });
  try {
    const before = host.runtime.ledger.getEntries().filter((entry) => entry.details?.kind === 'delegation').length;
    const result = await callTool(host.ctx, 'reflex_delegate', args({ provider: 'rogue', model: 'model' }));

    assert.equal(result.isError, true, 'the delegation fails');
    assert.match(resultText(result), /child LLM route "rogue\/model" is not allowed for this Session/);
    assert.equal(calls.length, 1, 'the Host tool adjudicated the call');
    assert.equal(
      calls[0]?.provider,
      'rogue',
      'and received the unvalidated route: this plugin did not filter it'
    );

    // The negative half of the proof. A route check written *here* would have to
    // run before a level could be decided, so it would leave no grade behind. The
    // grade that exists — with the refused route recorded on it — shows the level
    // was decided by this plugin and the refusal happened afterwards, inside the
    // Host's dispatch. Assertions above show that refusal came back in the Host's
    // own words.
    const graded = host.runtime.ledger.getEntries().filter((entry) => entry.details?.kind === 'delegation');
    assert.equal(graded.length, before + 1, 'the grade is decided before the Host adjudicates the route');
    assert.equal(graded.at(-1)?.details?.provider, 'rogue', 'and it records the route the Host then refused');
  } finally {
    await host.dispose();
  }
});

test('every delegation records an auditable grade in the ledger', async () => {
  const { host } = await hostWithDelegation();
  try {
    await host.callTool('reflex_delegate', args({ description: 'wire the endpoint', prompt: 'update the handler' }));
    const entries = host.runtime.ledger.getEntries().filter((entry) => entry.details?.kind === 'delegation');
    assert.equal(entries.length, 1, 'exactly one grade per delegation');
    const entry = entries[0]!;
    assert.equal(entry.type, 'effort-decision');
    assert.equal(entry.backend, 'reflex-delegate');
    assert.ok(['low', 'medium', 'high'].includes(String(entry.details?.level)), 'the decided level is audited');
    assert.ok(['system-one', 'inherited'].includes(String(entry.details?.source)), 'and its provenance');
    assert.equal(entry.details?.goal, 'wire the endpoint');
  } finally {
    await host.dispose();
  }
});

test('a Host whose delegation tool cannot carry a level gets no delegate at all', async () => {
  // Drive the *real* registration path: the default context ships the
  // delegation tool, and this test swaps in the model-selection-off shape
  // *before* the plugin mounts. The context is not relaxed in any way, so a
  // broken gate here really does register a delegate.
  const bare = await createReflexHostWithTools(
    { backend: 'mock' },
    (ctx) => {
      const existing = ctx.tools.get('subagent');
      assert.ok(existing, 'the pre-condition: the Host delegation tool is present');
      assert.ok(
        (existing.parameters as { properties?: Record<string, unknown> }).properties?.reasoning_effort,
        'the pre-condition: the default stand-in declares the level, so only the swap below removes it'
      );
    },
    { record: forwarded }
  );
  await bare.dispose();

  const withDefault = await createReflexHost({ backend: 'mock' });
  try {
    assert.ok(
      withDefault.ctx.tools.get('reflex_delegate'),
      'positive control: with a level-carrying Host tool the delegate IS registered'
    );
  } finally {
    await withDefault.dispose();
  }

  // The Host tool without the parameter = model selection disabled.
  const disabled = await createReflexHostWithTools(
    { backend: 'mock' },
    (ctx) => {
      ctx.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    },
    { delegation: false }
  );
  try {
    const target = inspectDelegationTool(disabled.ctx);
    assert.deepEqual(target, { toolName: 'subagent', acceptsReasoningEffort: false });
    assert.equal(
      disabled.ctx.tools.get('reflex_delegate'),
      undefined,
      'the wrapper is not registered when the Host tool omits reasoning_effort (modelSelection off)'
    );
    assert.ok(
      reflexToolNames(disabled.runtime.effectiveConfig).includes('reflex_delegate'),
      'the configuration still enables it: the gate that removed it is the executable check, not the switch'
    );
    assert.ok(
      ![...disabled.runtime.toolSurface].includes('reflex_delegate'),
      'the published surface does not advertise a tool that cannot carry a level'
    );
  } finally {
    await disabled.dispose();
  }
});

test('the registration gate itself: no level parameter means no delegate, and the warning is emitted', async () => {
  // Call the seam factory directly with a Host tool whose schema has no
  // `reasoning_effort`. This is the gate in isolation, so a mutant that drops
  // the refusal (or widens the check to "the tool exists") cannot pass.
  const ctx = await createToolContextWithoutDelegation();
  const warnings: string[] = [];
  try {
    ctx.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    const seam = createReflexDelegation({
      ctx,
      ledger: new DecisionLedger(null),
      decide: fullAnswer('high deep thinking', 0.9),
      minConfidence: 0.3,
      warn: (message) => warnings.push(message)
    });
    assert.equal(seam, undefined, 'the seam refuses to build when the level cannot be carried');
    assert.equal(warnings.length, 1, 'and it says so instead of degrading silently');
    assert.equal(warnings[0], DELEGATION_MODEL_SELECTION_DISABLED);
  } finally {
    await ctx.fiber.dispose();
  }

  // Same call, with the parameter present: the seam is built.
  const capable = await createToolContext();
  try {
    const seam = createReflexDelegation({
      ctx: capable,
      ledger: new DecisionLedger(null),
      decide: fullAnswer('high deep thinking', 0.9),
      minConfidence: 0.3
    });
    assert.ok(seam, 'a level-carrying Host tool yields a seam');
    assert.equal(seam.toolName, 'subagent');
  } finally {
    await capable.fiber.dispose();
  }
});

test('the registry and the published surface agree: registration is gated on the level parameter', async () => {
  // Boot the *default* context (which ships a level-carrying Host tool), then
  // model a deployment whose Host tool lost the parameter by swapping it before
  // the plugin mounts. Registration and the published surface must both follow
  // the same predicate; a gate that only asks "the tool exists" fails here.
  const ctx = await createToolContextWithoutDelegation();
  try {
    ctx.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    const runtime = applyReflex(ctx, {
      backend: 'mock',
      tools: { enabled: { delegate: true } }
    });
    assert.equal(runtime.effectiveConfig.tools.enabled.delegate, true, 'the switch is on');
    assert.equal(
      ctx.tools.get('reflex_delegate'),
      undefined,
      'an on switch plus a Host tool with no level parameter must not register the delegate'
    );
    assert.deepEqual(
      [...runtime.toolSurface],
      reflexToolNames(runtime.effectiveConfig).filter((name) => name !== 'reflex_delegate'),
      'and the published surface must not list it either'
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('inspectDelegationTool distinguishes no tool, a level-carrying tool, and a bare one', async () => {
  // The bare tool (modelSelection off) is seeded before the plugin mounts.
  const bare = await createReflexHostWithTools(
    { backend: 'mock' },
    (ctx) => {
      ctx.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    },
    { delegation: false }
  );
  try {
    assert.deepEqual(
      inspectDelegationTool(bare.ctx),
      { toolName: 'subagent', acceptsReasoningEffort: false },
      'the tool is found and reported as unable to carry a level'
    );
  } finally {
    await bare.dispose();
  }

  // The same tool, declaring the parameter: the Host's `modelSelection: true` shape.
  const capable = await hostWithDelegation();
  try {
    assert.deepEqual(
      inspectDelegationTool(capable.host.ctx),
      { toolName: 'subagent', acceptsReasoningEffort: true },
      'a tool that declares reasoning_effort is usable as a delegate target'
    );
  } finally {
    await capable.host.dispose();
  }

  const none = await createReflexHostWithTools({ backend: 'mock' }, () => {}, { delegation: false });
  try {
    assert.equal(inspectDelegationTool(none.ctx), undefined, 'no Host delegation tool means nothing to wrap');
    assert.equal(none.ctx.tools.get('reflex_delegate'), undefined);
  } finally {
    await none.dispose();
  }
});

test('the fallback inherits the calling agent\'s own level through exec.agent', async () => {
  const { host, calls } = await hostWithDelegation();
  try {
    // A parent already thinking at `high` must not hand a `medium` child the
    // work. System One answers a 3-way tie here, which the tie guard refuses, so
    // the inherited path is what decides.
    const agent = {
      id: 'parent-1',
      options: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      session: { header: {}, requestHeader: () => ({ origin: 'user' }) }
    } as never;
    const result = await executeOne(host.ctx, {
      callId: 'delegate-inherit',
      agent,
      name: 'reflex_delegate',
      args: args({ description: 'do the thing', prompt: 'do the thing' })
    });
    const value = resultValue<{ reasoning_effort: string; effortSource: string }>(result);
    assert.equal(value.effortSource, 'inherited', 'the level was inherited, not decided');
    assert.equal(value.reasoning_effort, 'high', 'the parent selection is honoured');
    assert.equal(calls[0]?.reasoning_effort, 'high', 'and that is what the Host tool received');
  } finally {
    await host.dispose();
  }
});

test('the delegation switch closes the tool like any other', async () => {
  // The Host tool is executable here; only the switch keeps the delegate out.
  const { host } = await hostWithDelegation({ toolPrefix: 'reflex_' });
  await host.dispose();

  const closed = await createReflexHost({ backend: 'mock', tools: { enabled: { delegate: false } } });
  try {
    assert.equal(
      reflexToolNames(resolveConfig({ backend: 'mock', tools: { enabled: { delegate: false } } })).includes('reflex_delegate'),
      false
    );
    assert.equal(closed.ctx.tools.get('reflex_delegate'), undefined, 'a closed delegate is not registered even when executable');
    assert.ok(closed.ctx.tools.get('reflex_choice'), 'its siblings stay registered');
  } finally {
    await closed.dispose();
  }
});

test('the System One question carries the description and the prompt body', () => {
  const question = buildDelegationQuestion('  wire the endpoint ', ' update the handler ');
  assert.equal(question, 'wire the endpoint\n\nupdate the handler');
  assert.equal(buildDelegationQuestion('', 'only the prompt').trim(), 'only the prompt');
  assert.equal(buildDelegationQuestion('', ''), '');
});

test('the modelSelection-disabled warning names the exact remedy', () => {
  assert.match(DELEGATION_MODEL_SELECTION_DISABLED, /reflex_delegate is not registered because the subagent tool has modelSelection disabled/);
  assert.match(DELEGATION_MODEL_SELECTION_DISABLED, /enable it to let System 1 choose the child's reasoning level/);
});
