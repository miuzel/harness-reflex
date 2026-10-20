import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { KNOWN_SESSION_EVENT_TYPES, Session, type SessionId } from '@deepseek-ai/dsh-session';
import { defineTool, type PostToolDecision, type PreToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { UserMessage } from '@deepseek-ai/dsh-llm';

import { INTERVENTION_MODES, resolveConfig, type ReflexConfig } from './config.js';
import { applyReflex } from './index.js';
import {
  applyPruneFloor,
  countTrailingFailures,
  countTrailingRepeats,
  detectOscillation,
  digestOf,
  estimateTokens,
  failureOf,
  installInterventions,
  InterventionEngine,
  pruneFloorPlan,
  pruneMarker,
  suspicionOf,
  textOfContent,
  type InterventionEngineOptions
} from './interventions.js';
import {
  INTERVENTION_RECORD_TYPE,
  interventionRecordsOf,
  pruneLocator,
  prunedOriginalsOf,
  readPrunedOriginal,
  appendPrunedOriginal,
  PRUNED_ORIGINAL_RECORD_TYPE
} from './session-audit.js';
import { createToolContext, fakeAgent, resultText } from './testing.js';
import type { ActionStep, GateResponse, PruneResponse, StagnationCheckResponse } from './vendor/harness-reflex/index.js';

/**
 * Coverage for the automatic interventions: the three-state contract, the
 * observable difference between observing and applying, the safety envelope, and
 * the cost accounting.
 *
 * The tests drive both layers on purpose. Unit-level tests call one hook with a
 * fabricated execution, which is the only way to place a payload *and* a budget
 * exactly where the assertion needs them; integration tests dispatch through the
 * real Host — the real tool registry, the real `agent/*` waterfalls, a real
 * Session log — which is the only way to prove the listeners are registered on
 * the hooks the loop actually fires.
 */

// ── fixtures ────────────────────────────────────────────────────────────────

/** A successful result carrying one text block. */
function resultOf(text: string, isError = false): Readonly<ToolExecutionResult> {
  return {
    isError,
    ...(isError ? { error: { name: 'ToolError', message: text } } : { value: text }),
    content: [{ type: 'text', text }],
    meta: {}
  } as unknown as Readonly<ToolExecutionResult>;
}

/** A tool call about to run, attributed to an agent. */
function execOf(name: string, args: unknown, agent?: unknown): ToolExecution {
  return {
    callId: `call-${name}`,
    token: `token-${name}`,
    rootCallId: `root-${name}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent })
  } as unknown as ToolExecution;
}

/** An accept decision carrying the result's own content. */
function acceptOf(result: Readonly<ToolExecutionResult>): PostToolDecision {
  return { kind: 'accept', content: [...(result.content ?? [])] } as PostToolDecision;
}

/** A stagnation service that always confirms one pattern. */
function stagnationStub(
  response: Partial<StagnationCheckResponse> = {},
  latencyMs = 0
): { service: InterventionEngineOptions['stagnation']; calls: ActionStep[][] } {
  const calls: ActionStep[][] = [];
  return {
    calls,
    service: {
      check: async (_goal: string | undefined, history?: ActionStep[]) => {
        calls.push(history ?? []);
        return {
          isStuck: true,
          patternType: 'repetition',
          confidence: 0.9,
          diagnosis: 'stub',
          latencyMs,
          ...response
        } as StagnationCheckResponse;
      }
    } as InterventionEngineOptions['stagnation']
  };
}

/** A pruning service returning one controlled candidate. */
function pruneStub(candidate: (raw: string) => string, latencyMs = 0): InterventionEngineOptions['prune'] {
  return {
    prune: async (raw: string) => {
      const text = candidate(raw);
      return {
        processedOutput: text,
        originalChars: raw.length,
        prunedChars: text.length,
        estimatedTokensSaved: Math.max(0, Math.ceil((raw.length - text.length) / 4)),
        reductionPercentage: raw.length === 0 ? 0 : Math.round(((raw.length - text.length) / raw.length) * 1000) / 10,
        shadow: false,
        latencyMs
      } satisfies PruneResponse;
    }
  } as InterventionEngineOptions['prune'];
}

/** A gate service returning one controlled verdict. */
function gateStub(outcome: 'verified' | 'contradicted' | 'escalate', statements = 1): InterventionEngineOptions['gate'] {
  return {
    verify: async (assertions: readonly { statement: string }[]) =>
      ({
        passed: outcome === 'verified',
        results: assertions.slice(0, statements).map((assertion) => ({
          statement: assertion.statement,
          outcome,
          confidence: 0.9,
          explanation: 'stub'
        })),
        needsEscalation: outcome === 'escalate',
        latencyMs: 0
      }) satisfies GateResponse
  } as InterventionEngineOptions['gate'];
}

/**
 * A retention sink that keeps originals in memory the way the session log does.
 *
 * The locator is derived from the payload, exactly like the production sink, so a
 * test can predict the locator the engine will publish without being told it.
 * @param options - `fail` makes every retention unavailable.
 * @returns the sink, and the originals it holds by locator.
 */
function retentionStub(options: { fail?: boolean } = {}): {
  retain: NonNullable<InterventionEngineOptions['retain']>;
  originals: Map<string, string>;
} {
  const originals = new Map<string, string>();
  return {
    originals,
    retain: (_session, request) => {
      if (options.fail) return undefined;
      const locator = pruneLocator(request.digest);
      originals.set(locator, request.text);
      return { locator };
    }
  };
}

/** The locator the engine publishes for one payload. */
function locatorOf(text: string): string {
  return pruneLocator(digestOf(text));
}

/** One engine over a config, with stubs for the services a test does not need. */
function engineFor(
  interventions: ReflexConfig['interventions'],
  overrides: Partial<InterventionEngineOptions> = {},
  pruneThreshold = 100
): InterventionEngine {
  const resolved = resolveConfig({ backend: 'mock', ...(interventions === undefined ? {} : { interventions }) });
  return new InterventionEngine({
    config: resolved.interventions,
    pruneThreshold,
    stagnation: overrides.stagnation ?? stagnationStub().service,
    prune: overrides.prune ?? pruneStub((raw) => raw.slice(0, 40)),
    gate: overrides.gate ?? gateStub('contradicted'),
    // Retention is a precondition of replacing anything, so a test that does not
    // care about it still gets the real path: an in-memory sink that hands back a
    // locator. A test that cares passes its own.
    retain: overrides.retain ?? retentionStub().retain,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.audit === undefined ? {} : { audit: overrides.audit }),
    ...(overrides.ownTools === undefined ? {} : { ownTools: overrides.ownTools })
  });
}

/** A payload long enough to be a pruning candidate, with a much smaller candidate. */
const LONG_RESULT = `${Array.from({ length: 40 }, (_, index) => `line ${index} of very noisy output`).join('\n')}\ntail marker`;

/**
 * A dependency-style trace of the size the reviewer's reproduction used (~2.5k
 * characters, line oriented, a real reduction available), for the tests that
 * exercise the turn's action ceiling.
 */
const DEPENDENCY_TRACE = `${Array.from(
  { length: 32 },
  (_, index) => `at /repo/node_modules/dep-${index}/index.js:${index}:11 cannot resolve 'dep-${index + 1}' from '/repo/src/app.ts'`
).join('\n')}\nbuild finished with 1 warning`;

/**
 * A payload the real backend actually reduces (deep dependency paths and
 * progress bars), for the integration tests that must not use a stub.
 */
const REDUCIBLE_RESULT = `${Array.from({ length: 40 }, (_, index) => `at /repo/node_modules/pkg${index}/index.js:${index}:1`).join('\n')}\nbuild finished ok`;

/**
 * Run one call the way the loop does: the result is recorded, then the next
 * identical proposal is made. The pre-execute window only sees calls that have
 * already been recorded, exactly as in production.
 * @param engine - the engine under test.
 * @param exec - the call to make.
 * @param result - what the previous attempt returned.
 * @returns the pre-execute decision of the next identical proposal.
 */
async function attempt(engine: InterventionEngine, exec: ToolExecution, result: Readonly<ToolExecutionResult>): Promise<PreToolDecision> {
  await engine.toolResult(exec, result, async () => acceptOf(result));
  return engine.toolCall(exec, async () => ({ kind: 'allow' }));
}

/** A pre-step payload for one agent. */
function stepPayload(agent: unknown, turn: number, step: number, messages: UserMessage[] = []): {
  agent: unknown;
  messages: UserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
} {
  return { agent, messages, turn, step, signal: new AbortController().signal };
}

/** The text of a decision's content, as a test narrowed it. */
function installedText(decision: { content?: unknown }): string {
  return textOfContent(decision.content as never);
}

/** One text message the way the loop carries it. */
function message(text: string): UserMessage {
  return { id: `m-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as UserMessage;
}

// ── criterion 1: one authored contract, three states ────────────────────────

test('the three intervention states resolve from one authored contract, defaulting to observe', () => {
  assert.deepEqual(INTERVENTION_MODES, ['off', 'observe', 'active']);

  const byDefault = resolveConfig({ backend: 'mock' });
  assert.equal(byDefault.interventions.mode, 'observe', 'the default is observe, never active');
  assert.equal(byDefault.interventions.enabled, true);
  assert.deepEqual(byDefault.interventions.capabilities, {
    stagnation: 'observe',
    prune: 'observe',
    gate: 'observe',
    closing: 'observe'
  });

  for (const mode of INTERVENTION_MODES) {
    const resolved = resolveConfig({ backend: 'mock', interventions: { mode } });
    assert.equal(resolved.interventions.mode, mode);
    assert.equal(resolved.interventions.enabled, mode !== 'off');
    for (const capability of ['stagnation', 'prune', 'gate', 'closing'] as const) {
      assert.equal(resolved.interventions.capabilities[capability], mode);
    }
  }

  // Irreversible or unsupported values are refused at the one resolution point,
  // so no consumer ever has to guess.
  assert.throws(() => resolveConfig({ backend: 'mock', interventions: { mode: 'shadow' as never } }), /interventions\.mode/);
  assert.throws(
    () => resolveConfig({ backend: 'mock', interventions: { capabilities: { prune: 'on' as never } } }),
    /interventions\.capabilities\.prune/
  );
});

test('a capability override enables one capability while the master mode stays off', () => {
  const resolved = resolveConfig({ backend: 'mock', interventions: { mode: 'off', capabilities: { prune: 'active' } } });
  assert.equal(resolved.interventions.mode, 'off');
  assert.equal(resolved.interventions.capabilities.prune, 'active');
  assert.equal(resolved.interventions.capabilities.stagnation, 'off');
  assert.equal(resolved.interventions.enabled, true, 'the switch follows effective modes, not the master alone');

  const engine = engineFor({ mode: 'off', capabilities: { prune: 'active' } });
  assert.equal(engine.serves('prune'), true);
  assert.equal(engine.serves('stagnation'), false);
  assert.equal(engine.serves('closing'), false);

  // Reversibility: the same authored block resolves to the same effective
  // contract every time, with no state carried between resolutions.
  const again = resolveConfig({ backend: 'mock', interventions: { mode: 'off', capabilities: { prune: 'active' } } });
  assert.deepEqual(again.interventions, resolved.interventions);
  const back = resolveConfig({ backend: 'mock', interventions: { mode: 'off', capabilities: { prune: 'inherit' } } });
  assert.equal(back.interventions.capabilities.prune, 'off');
  assert.equal(back.interventions.enabled, false);
});

// ── criterion 2: off is the absence of the feature ──────────────────────────

test('off installs no listener at all on a real host', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({ backend: 'mock', interventions: { mode: 'off' } }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 10)),
      gate: gateStub('contradicted')
    });
    assert.equal(installation.engine.enabled, false);
    assert.deepEqual(installation.disposers, [], 'an inactive deployment registers nothing');
    assert.equal(installation.engine.serves('prune'), false);
    assert.equal(installation.engine.serves('stagnation'), false);
    assert.equal(installation.engine.serves('gate'), false);
    assert.equal(installation.engine.serves('closing'), false);
    assert.deepEqual(installation.engine.report().recent, []);
    assert.deepEqual(installation.engine.report().skips, {});
  } finally {
    await ctx.fiber.dispose();
  }
});

test('off leaves a tool result byte-identical and cannot turn a deny into an allow', async () => {
  const engine = engineFor({ mode: 'off' });
  const result = resultOf(LONG_RESULT);
  const downstream = acceptOf(result);
  const decision = await engine.toolResult(execOf('read', { path: 'a' }), result, async () => downstream);
  assert.equal(decision, downstream, 'the very decision object of the waterfall is returned');
  assert.equal(installedText(decision as { content?: unknown }), LONG_RESULT);

  const allowed = await engine.toolCall(execOf('read', { path: 'a' }), async () => ({ kind: 'allow' }));
  assert.deepEqual(allowed, { kind: 'allow' });
  const asked = await engine.toolCall(execOf('read', { path: 'a' }), async () => ({ kind: 'ask', reason: 'outer' }));
  assert.deepEqual(asked, { kind: 'ask', reason: 'outer' }, 'off never rewrites another listener decision');
  const report = engine.report();
  assert.equal(report.observe.plans + report.active.plans, 0, 'off plans nothing');
  assert.equal(report.observe.judgments + report.active.judgments, 0, 'off judges nothing');
});

// ── criterion 3: observe detects and judges, and changes nothing ────────────

test('observe plans the reduction it would apply and still hands the result on untouched', async () => {
  const prune = pruneStub((raw) => raw.slice(0, 120));
  const engine = engineFor({ mode: 'observe' }, { prune });
  const result = resultOf(LONG_RESULT);
  const downstream = acceptOf(result);
  const decision = await engine.toolResult(execOf('bash', { command: 'build' }), result, async () => downstream);

  assert.equal(decision, downstream, 'observe returns the downstream decision itself');
  assert.equal(installedText(decision as { content?: unknown }), LONG_RESULT, 'the payload is unchanged');
  assert.deepEqual((decision as { additionalContexts?: unknown }).additionalContexts, undefined, 'observe attaches nothing');

  const report = engine.report();
  assert.equal(report.observe.plans, 1, 'the decision was planned');
  assert.equal(report.observe.applied, 0);
  const planned = applyPruneFloor(LONG_RESULT, LONG_RESULT.slice(0, 120), { floorRatio: 0.5, locator: locatorOf(LONG_RESULT) });
  assert.equal(report.observe.candidateTokens, estimateTokens(planned.text), 'the plan carries the floored size');
  assert.equal(report.observe.potentialSavedTokens, estimateTokens(LONG_RESULT) - estimateTokens(planned.text));
  assert.ok(report.observe.potentialSavedTokens > 0);
  assert.equal(report.observe.actualSavedTokens, 0, 'a measurement saves nothing');
  assert.equal(report.observe.injectedTokens, 0);
  assert.equal(report.observe.originalTokens, estimateTokens(LONG_RESULT));
  assert.equal(report.observe.judgments, 1, 'observe pays for the judgment it reports');
  assert.equal(report.active.plans, 0, 'nothing is attributed to the active column');
  assert.equal(report.baseline.originalTokens, estimateTokens(LONG_RESULT));
  assert.equal(report.byCapability.prune.plans, 1);
});

test('active applies exactly what observe planned, on the same payload', async () => {
  const prune = pruneStub((raw) => raw.slice(0, 120));
  const observing = engineFor({ mode: 'observe' }, { prune });
  const acting = engineFor({ mode: 'active' }, { prune });
  const result = resultOf(LONG_RESULT);

  await observing.toolResult(execOf('bash', { command: 'build' }), result, async () => acceptOf(result));
  const applied = await acting.toolResult(execOf('bash', { command: 'build' }), result, async () => acceptOf(result));

  const observeReport = observing.report();
  const activeReport = acting.report();
  assert.equal(applied.kind, 'accept');
  const installed = installedText(applied as { content?: unknown });
  assert.notEqual(installed, LONG_RESULT, 'active replaced the payload');
  assert.ok(installed.length < LONG_RESULT.length);
  assert.equal(
    activeReport.active.candidateTokens,
    observeReport.observe.candidateTokens,
    'the candidate size is the same number in both columns'
  );
  assert.equal(activeReport.active.potentialSavedTokens, observeReport.observe.potentialSavedTokens);
  assert.equal(activeReport.active.actualSavedTokens, observeReport.observe.potentialSavedTokens, 'active really removed it');
  assert.equal(observeReport.observe.actualSavedTokens, 0, 'observe really did not');
  // A reduction injects nothing: the note explaining it is recorded for the
  // operator and never travels into the context it just shrank.
  const note = activeReport.recent[0]!.feedback;
  assert.ok(note.length > 0);
  assert.equal(activeReport.active.injectedTokens, 0);
  assert.equal(installed.includes(note), false, 'the note is not in what the model reads');
});

test('observe never injects a message, steers a turn, or blocks a result', async () => {
  const engine = engineFor({ mode: 'observe' });
  const agent = { ...fakeAgent({ id: 'observe-agent' }), steer: () => { throw new Error('observe must not steer'); } };
  const messages = [message('continue')];

  // Three identical calls: the deterministic trigger fires, System 1 confirms,
  // and the call is still allowed to run.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.toolResult(execOf('bash', { command: 'ls' }, agent), resultOf('ok'), async () => acceptOf(resultOf('ok')));
  }

  const allowed = await engine.toolCall(execOf('bash', { command: 'ls' }, agent), async () => ({ kind: 'allow' }));
  assert.deepEqual(allowed, { kind: 'allow' }, 'observe refuses nothing');

  const decision = (await engine.preStep(stepPayload(agent, 1, 2, messages), async () => ({
    kind: 'enter' as const,
    messages
  }))) as { kind: string; messages: unknown[] };
  assert.equal(decision.messages, messages, 'the message array is passed through by identity');
  assert.equal(decision.messages.length, 1);

  // A closing turn whose own evidence contradicts its claim is still left alone.
  engine.observeAssistantStream({
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Everything is green: all 12 tests passed.' } }
  });
  await engine.toolResult(execOf('bash', { command: 'test' }, agent), resultOf('AssertionError: 2 failed', true), async () => acceptOf(resultOf('x', true)));
  await engine.turnStopping({ agent, turn: 1 });
  const report = engine.report();
  assert.ok(report.observe.plans >= 1, 'detection ran');
  assert.equal(report.observe.applied, 0);
  assert.equal(report.observe.injectedTokens, 0);
  assert.equal(report.active.plans, 0);
});

// ── criterion 4: active runs the whole chain on the Host's own hooks ────────

test('active prunes an oversized result before it enters the context', async () => {
  const engine = engineFor({ mode: 'active' }, { prune: pruneStub((raw) => raw.slice(0, 300)) });
  const result = resultOf(LONG_RESULT);
  const decision = (await engine.toolResult(execOf('bash', { command: 'build' }), result, async () => acceptOf(result))) as {
    kind: string;
    content: { type: string; text: string }[];
    additionalContexts?: unknown;
  };
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.content.length, 1);
  assert.ok(decision.content[0]!.text.length < LONG_RESULT.length);
  assert.equal(
    installedText(decision),
    applyPruneFloor(LONG_RESULT, LONG_RESULT.slice(0, 300), {
      floorRatio: 0.5,
      headChars: 400,
      tailChars: 400,
      locator: locatorOf(LONG_RESULT)
    }).text,
    'the installed text is exactly the floored candidate'
  );
  const record = engine.report().recent[0]!;
  assert.equal(record.applied, true);
  assert.equal(record.action, 'prune-result');
  assert.ok(record.actualSavedTokens > 0);
  assert.equal(record.actualSavedTokens, record.potentialSavedTokens);
});

test('active denies a repeated call through the real registry without any reflex tool call', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'active', capabilities: { stagnation: 'active' } } });
    const runs: string[] = [];
    ctx.tools.register(
      defineTool({
        name: 'iv_probe',
        description: 'Test-only tool whose executions are counted.',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        async execute(args: { command: string }) {
          runs.push(args.command);
          return { ran: args.command };
        }
      })
    );
    let calls = 0;
    const execute = (): Promise<ToolExecutionResult> =>
      ctx.tools.execute({
        callId: `iv-${++calls}` as never,
        name: 'iv_probe',
        arguments: { command: 'ls' },
        signal: new AbortController().signal
      });

    assert.equal((await execute()).isError, false);
    assert.equal((await execute()).isError, false);
    const third = await execute();
    assert.equal(runs.length, 2, 'two calls ran before the third was proposed');
    assert.equal(third.isError, true, 'the third identical call is refused before it runs');
    assert.match(resultText(third), /Reflex intervention/);
    assert.equal(runs.length, 2, 'the refused call never reached the tool body');

    // A legal retry is not blocked: the refusal is a single, per-signature
    // decision, so the next attempt is observed rather than refused again.
    assert.equal((await execute()).isError, false, 'the retry runs');
    assert.equal(runs.length, 3);

    const report = runtime.interventions!.report();
    assert.equal(report.active.applied, 1);
    assert.equal(report.active.actualSavedTokens, 0, 'a refusal removes nothing from the context');
    assert.ok(report.active.injectedTokens > 0, 'the refusal text is the one thing it adds');
    assert.equal(runs.length > 0, true, 'no reflex_* tool was involved: the harness intervened by itself');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('active attaches the corrective context to the step after a repeated loop', async () => {
  const engine = engineFor({ mode: 'active' });
  const agent = fakeAgent({ id: 'active-step' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.toolResult(execOf('bash', { command: 'ls' }, agent), resultOf('ok'), async () => acceptOf(resultOf('ok')));
  }
  const messages = [message('keep going')];
  const decision = (await engine.preStep(stepPayload(agent, 1, 1, messages), async () => ({
    kind: 'enter' as const,
    messages
  }))) as { messages: UserMessage[] };
  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1]!;
  assert.equal(injected.role, 'user');
  assert.equal((injected.source as { kind: string }).kind, 'plugin:dsh-reflex', 'the producer owns the source kind');
  assert.equal((injected.source as { form: string }).form, 'notice');
  assert.match(textOfContent(injected.content as never), /Reflex intervention/);
  assert.equal(messages.length, 1, 'the downstream array is not mutated in place');

  const record = engine.report().recent.at(-1)!;
  assert.equal(record.capability, 'stagnation');
  assert.equal(record.action, 'corrective-context');
  assert.equal(record.applied, true);
  assert.equal(record.injectedTokens, estimateTokens(record.feedback));
});

test('active turns a repeated failing result into corrective feedback', async () => {
  const engine = engineFor({ mode: 'active' });
  const failing = resultOf('Error: cannot find module "left-pad"', true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = await engine.toolResult(execOf('bash', { command: 'node x' }), failing, async () => acceptOf(failing));
    assert.equal(decision.kind, 'accept', 'the first two results are accepted untouched');
  }
  const decision = (await engine.toolResult(execOf('bash', { command: 'node x' }), failing, async () => acceptOf(failing))) as {
    kind: string;
    feedback: { type: string; text: string }[];
  };
  assert.equal(decision.kind, 'block');
  assert.match(decision.feedback[0]!.text, /failed 3 consecutive times/);
  const record = engine.report().recent.at(-1)!;
  assert.equal(record.capability, 'gate');
  assert.equal(record.applied, true);
});

test('active objects to a turn closing on contradicted evidence, and observe does not', async () => {
  const steered: UserMessage[] = [];
  const agent = { ...fakeAgent({ id: 'closing-agent' }), steer: (m: UserMessage) => steered.push(m) };

  for (const mode of ['observe', 'active'] as const) {
    steered.length = 0;
    const engine = engineFor({ mode });
    engine.observeAssistantStream({
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Verification: all 12 tests passed and the build is green.' } }
    });
    await engine.toolResult(execOf('bash', { command: 'npm test' }, agent), resultOf('2 failed, 10 passed', true), async () =>
      acceptOf(resultOf('2 failed', true))
    );
    await engine.turnStopping({ agent, turn: 1 });
    const record = engine.report().recent.at(-1);
    assert.equal(record?.capability, 'closing', `${mode} ran the closing check`);
    assert.equal(record?.applied, mode === 'active');
    assert.equal(steered.length, mode === 'active' ? 1 : 0, `${mode} steering matches the mode`);
    if (mode === 'active') {
      const text = textOfContent(steered[0]!.content as never);
      assert.match(text, /about to close/);
      assert.equal((steered[0]!.source as { kind: string }).kind, 'plugin:dsh-reflex');
    }
  }
});

test('a consistent closing turn is never objected to, in either mode', async () => {
  for (const mode of ['observe', 'active'] as const) {
    const steered: UserMessage[] = [];
    const agent = { ...fakeAgent({ id: `clean-${mode}` }), steer: (m: UserMessage) => steered.push(m) };
    const engine = engineFor({ mode }, { gate: gateStub('verified') });
    engine.observeAssistantStream({
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'The suite is green: all tests passed.' } }
    });
    await engine.toolResult(execOf('bash', { command: 'npm test' }, agent), resultOf('1 failed', true), async () => acceptOf(resultOf('x', true)));
    await engine.turnStopping({ agent, turn: 1 });
    assert.deepEqual(steered, []);
    assert.equal(engine.report().active.applied + engine.report().observe.applied, 0);
  }
});

// ── criterion 5: fail-open, monotonic permissions, dedup, caps, isolation ───

test('every hook fails open when a service throws', async () => {
  const throwing = {
    check: async () => {
      throw new Error('backend down');
    }
  } as unknown as InterventionEngineOptions['stagnation'];
  const throwingPrune = {
    prune: async () => {
      throw new Error('backend down');
    }
  } as unknown as InterventionEngineOptions['prune'];
  const throwingGate = {
    verify: async () => {
      throw new Error('backend down');
    }
  } as unknown as InterventionEngineOptions['gate'];

  const engine = engineFor({ mode: 'active' }, { stagnation: throwing, prune: throwingPrune, gate: throwingGate });
  const agent = fakeAgent({ id: 'throwing' });
  const result = resultOf(LONG_RESULT);
  const downstream = acceptOf(result);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.toolResult(execOf('bash', { command: 'build' }, agent), result, async () => downstream);
    await engine.toolCall(execOf('bash', { command: 'build' }, agent), async () => ({ kind: 'allow' }));
  }
  const decision = await engine.toolResult(execOf('bash', { command: 'build' }, agent), result, async () => downstream);
  assert.equal(decision, downstream, 'a broken backend never rewrites a result');

  const messages = [message('go')];
  const stepDecision = await engine.preStep(stepPayload(agent, 1, 1, messages), async () => ({ kind: 'enter' as const, messages }));
  assert.deepEqual(stepDecision, { kind: 'enter', messages });

  engine.observeAssistantStream({
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'all tests passed' } }
  });
  await engine.turnStopping({ agent, turn: 1 });
  assert.ok((engine.report().skips['planning-error'] ?? 0) > 0, 'the refusal is counted, not silent');
});

test('the tool gate can only ever deny, never approve', async () => {
  const engine = engineFor({ mode: 'active' });
  const agent = fakeAgent({ id: 'monotonic' });
  const exec = execOf('bash', { command: 'ls' }, agent);
  const ok = resultOf('ok');
  await engine.toolResult(exec, ok, async () => acceptOf(ok));
  await engine.toolResult(exec, ok, async () => acceptOf(ok));
  const denied = await engine.toolCall(exec, async () => ({ kind: 'allow' }));
  assert.equal((denied as { kind: string }).kind, 'deny', 'a plain allow is the only decision it narrows');
  assert.ok(!('value' in denied) && !('displayReason' in denied));
  assert.equal(engine.report().active.applied, 1);

  // A block from a later listener keeps the last word, and active mode does not
  // add a second correction on top of it.
  const blocked = { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'outer' }] };
  const engine2 = engineFor({ mode: 'active' });
  const failures = resultOf('Error: nope', true);
  const screens = [acceptOf(failures), acceptOf(failures), blocked];
  let call = 0;
  let last: PostToolDecision = acceptOf(failures);
  for (let index = 0; index < screens.length; index += 1) {
    last = await engine2.toolResult(execOf('bash', { command: 'x' }, agent), failures, async () => screens[Math.min(call++, 2)]!);
  }
  assert.equal(call, 3, 'every attempt delegated downstream exactly once');
  assert.equal(last, blocked, 'an outer block is returned by identity');
  assert.equal(engine2.report().active.applied, 0);
});

test('an intervention is applied once per identity, and never more than the turn cap', async () => {
  const engine = engineFor({ mode: 'active' });
  const agent = fakeAgent({ id: 'dedup' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await engine.toolResult(execOf('bash', { command: 'ls' }, agent), resultOf('ok'), async () => acceptOf(resultOf('ok')));
  }
  const messages = [message('go')];
  for (let step = 1; step <= 6; step += 1) {
    await engine.preStep(stepPayload(agent, 1, step, messages), async () => ({ kind: 'enter' as const, messages }));
  }
  const report = engine.report();
  assert.equal(report.active.applied, 1, 'one identity is corrected once per turn');
  assert.ok((report.skips['duplicate-intervention'] ?? 0) >= 1, 'the repeat is reported rather than silently dropped');

  const cappedEngine = engineFor({ mode: 'active', maxInterventionsPerTurn: 1 });
  const other = fakeAgent({ id: 'capped' });
  const failure = resultOf('Error: nope', true);
  let blocked = 0;
  for (const command of ['a', 'a', 'a', 'b', 'b', 'b']) {
    const decision = await cappedEngine.toolResult(execOf('bash', { command }, other), failure, async () => acceptOf(failure));
    if (decision.kind === 'block') blocked += 1;
  }
  assert.equal(blocked, 1, 'the turn cap allows exactly one correction');
  assert.equal(cappedEngine.report().active.applied, 1);
  assert.ok((cappedEngine.report().skips['intervention-cap'] ?? 0) >= 1);
});

test('judgments are capped per turn so a pathological turn cannot spend without bound', async () => {
  const resolved = resolveConfig({ backend: 'mock', interventions: { mode: 'observe', maxJudgmentsPerTurn: 1 } });
  const stagnation = stagnationStub();
  const engine = new InterventionEngine({
    config: resolved.interventions,
    pruneThreshold: 100,
    stagnation: stagnation.service,
    prune: pruneStub((raw) => raw.slice(0, 10)),
    gate: gateStub('contradicted')
  });
  const agent = fakeAgent({ id: 'judgment-cap' });
  const failure = resultOf('Error: nope', true);
  for (const command of ['a', 'a', 'a', 'b', 'b', 'b']) {
    await engine.toolResult(execOf('bash', { command }, agent), failure, async () => acceptOf(failure));
  }
  assert.equal(stagnation.calls.length, 1, 'the second suspicion of the turn is not judged');
  assert.equal(engine.report().observe.judgments, 1);
  assert.ok((engine.report().skips['judgment-turn-cap'] ?? 0) >= 1);
});

test('two agents never share detection state, verdicts, or budgets', async () => {
  const engine = engineFor({ mode: 'active' });
  const first = fakeAgent({ id: 'agent-a' });
  const second = fakeAgent({ id: 'agent-b' });
  const exec = execOf('bash', { command: 'ls' }, first);
  const ok = resultOf('ok');
  // The same identity twice for one agent, then the same call for another: the
  // second agent has no history of its own and is not suspicious.
  await engine.toolResult(exec, ok, async () => acceptOf(ok));
  await engine.toolResult(exec, ok, async () => acceptOf(ok));
  const denied = await engine.toolCall(exec, async () => ({ kind: 'allow' }));
  assert.equal((denied as { kind: string }).kind, 'deny', 'the third call of one agent is refused');
  const untouched = await engine.toolCall(execOf('bash', { command: 'ls' }, second), async () => ({ kind: 'allow' }));
  assert.deepEqual(untouched, { kind: 'allow' }, 'the other agent sees its own, empty window');
  assert.equal(engine.stateOf('agent-a')!.steps, 2);
  assert.equal(engine.stateOf('agent-b')!.steps, 0, 'a fresh agent carries an empty window');

  // Budgets are per agent too: exhausting one leaves another its own allowance.
  const budget = resolveConfig({
    backend: 'mock',
    interventions: { mode: 'observe', maxJudgmentsPerTurn: 3, maxJudgmentsPerSession: 1 }
  });
  const stagnation = stagnationStub();
  const bounded = new InterventionEngine({
    config: budget.interventions,
    pruneThreshold: 100,
    stagnation: stagnation.service,
    prune: pruneStub((raw) => raw.slice(0, 10)),
    gate: gateStub('contradicted')
  });
  const failure = resultOf('Error: nope', true);
  const worker = fakeAgent({ id: 'worker' });
  for (const command of ['a', 'a', 'a', 'b', 'b', 'b']) {
    await bounded.toolResult(execOf('bash', { command }, worker), failure, async () => acceptOf(failure));
  }
  assert.equal(stagnation.calls.length, 1, 'the worker spent its single judgment');
  assert.ok((bounded.report().skips['judgment-session-cap'] ?? 0) >= 1);
  const stranger = fakeAgent({ id: 'stranger' });
  for (const command of ['a', 'a', 'a']) {
    await bounded.toolResult(execOf('bash', { command }, stranger), failure, async () => acceptOf(failure));
  }
  assert.equal(stagnation.calls.length, 2, 'each agent got its own session budget');
  assert.equal(bounded.stateOf('stranger')!.judgmentsSession, 1);
});

test('disposal detaches every listener and drops every engine state', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({ backend: 'mock', interventions: { mode: 'active' } }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 60)),
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    assert.equal(installation.disposers.length, 6, 'one detacher per registered hook');
    let calls = 0;
    ctx.tools.register(
      defineTool({
        name: 'iv_disposal',
        description: 'Test-only tool returning a bulky result.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' as const },
          render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }]
        },
        async execute(args: { text: string }) {
          calls += 1;
          return args.text;
        }
      })
    );
    const execute = (): Promise<ToolExecutionResult> =>
      ctx.tools.execute({
        callId: `disposal-${calls}` as never,
        name: 'iv_disposal',
        arguments: { text: LONG_RESULT },
        signal: new AbortController().signal
      });

    const before = await execute();
    assert.equal(before.isError, false);
    const installed = installation.engine.report();
    assert.equal(installed.active.applied, 1, 'the listener pruned the result while it was attached');
    assert.ok(installed.recent.length > 0);

    for (const dispose of installation.disposers) dispose();

    // The host still runs the tool, but nothing intervenes on it any more: this
    // is the difference between "the engine is idle" and "the plugin is gone".
    const afterDetach = await execute();
    assert.equal(afterDetach.isError, false);
    assert.equal(resultText(afterDetach), LONG_RESULT, 'the payload reaches the model untouched');
    const detached = installation.engine.report();
    assert.equal(detached.active.applied, 1, 'no listener drove the engine after the detach');
    assert.equal(detached.recent.length, installed.recent.length);

    installation.engine.reset();
    assert.equal(installation.engine.stateOf('anonymous'), undefined, 'agent state is dropped');
    assert.deepEqual(installation.engine.report().recent, []);
    assert.deepEqual(installation.engine.report().skips, {});
    assert.equal(installation.engine.hasApplied('anonymous', 'prune:x'), false);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the plugin runtime releases the intervention engine with everything else', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'observe' } });
    const engine = runtime.interventions;
    assert.ok(engine, 'the runtime publishes the engine it installed');
    const agent = fakeAgent({ id: 'runtime-unload' });
    await engine!.toolResult(execOf('bash', { command: 'x' }, agent), resultOf(LONG_RESULT), async () =>
      acceptOf(resultOf(LONG_RESULT))
    );
    assert.ok(engine!.stateOf('runtime-unload'));

    runtime.dispose();
    assert.equal(runtime.interventions, undefined, 'no engine survives its runtime');
    assert.equal(engine!.stateOf('runtime-unload'), undefined, 'no per-agent state survives either');
    assert.deepEqual(engine!.report().recent, []);
  } finally {
    await ctx.fiber.dispose();
  }

  // An inactive activation is inert, on its own host so the two loads cannot
  // collide in the tool registry.
  const idle = await createToolContext();
  try {
    const inactive = applyReflex(idle, { backend: 'mock', interventions: { mode: 'off' } });
    assert.equal(inactive.interventions?.enabled, false, 'an inactive activation installs an inert engine');
    assert.deepEqual(inactive.interventions?.report().skips, {});
    assert.deepEqual(inactive.interventions?.report().recent, []);
  } finally {
    await idle.fiber.dispose();
  }
});

test('the frozen eight tools are never judged, refused, or re-pruned', async () => {
  const names = ['reflex_choice', 'reflex_score', 'reflex_route', 'reflex_screen', 'reflex_gate', 'reflex_prune', 'reflex_detect_stagnation', 'reflex_status_ledger'];
  const engine = engineFor({ mode: 'active', capabilities: { stagnation: 'active', prune: 'active', gate: 'active' } }, {
    ownTools: names
  });
  const agent = fakeAgent({ id: 'frozen' });
  const result = resultOf(LONG_RESULT);
  let refused = 0;
  for (const name of names) {
    // Two recorded calls and a third proposal: an ordinary tool would now be
    // refused by the repetition gate.
    const exec = execOf(name, { question: 'Ship it?', options: ['yes', 'no'] }, agent);
    await engine.toolResult(exec, result, async () => acceptOf(result));
    await engine.toolResult(exec, result, async () => acceptOf(result));
    const decision = await engine.toolCall(exec, async () => ({ kind: 'allow' }));
    if (decision.kind !== 'allow') refused += 1;
  }
  assert.equal(refused, 0, 'an own tool is never refused');
  const report = engine.report();
  assert.equal(report.active.plans, 0, 'an own result is never a pruning candidate');
  assert.equal(report.active.judgments, 0, 'and never costs a judgment');
  assert.equal(report.baseline.results, 0);
});

test('observe plans exactly the interventions active applies, and bills them apart', async () => {
  const overrides = {
    stagnation: stagnationStub().service,
    prune: pruneStub((raw) => raw.slice(0, 60)),
    gate: gateStub('contradicted')
  };
  const failure = resultOf('Error: nope', true);
  const run = async (mode: 'observe' | 'active'): Promise<{ plans: number; applied: number; saved: number }> => {
    const engine = engineFor({ mode, capabilities: { gate: 'inherit' } }, overrides);
    const agent = fakeAgent({ id: `parity-${mode}` });
    for (const command of ['a', 'a', 'a', 'a']) {
      await engine.toolResult(execOf('bash', { command }, agent), failure, async () => acceptOf(failure));
    }
    const report = engine.report()[mode];
    return { plans: report.plans, applied: report.applied, saved: report.actualSavedTokens };
  };
  const observed = await run('observe');
  const acted = await run('active');
  assert.equal(observed.plans, acted.plans, 'the same episode is planned in both modes');
  assert.equal(observed.plans, 1, 'one refused episode is one plan, not two');
  assert.equal(observed.applied, 0);
  assert.equal(observed.saved, 0, 'observe removes nothing from the context');
  assert.equal(acted.applied, 1);
  assert.equal(acted.saved, 0, 'corrective feedback replaces nothing; it adds');
});

test('a repeated payload is judged once in either mode, and installed once in active', async () => {
  const overrides = { prune: pruneStub((raw) => raw.slice(0, 40)) };
  const run = async (mode: 'observe' | 'active') => {
    const engine = engineFor({ mode, capabilities: { prune: 'inherit' } }, overrides);
    const agent = fakeAgent({ id: `prune-parity-${mode}` });
    const result = resultOf(LONG_RESULT);
    const exec = execOf('bash', { command: 'build' }, agent);
    const first = await engine.toolResult(exec, result, async () => acceptOf(result));
    const second = await engine.toolResult(exec, result, async () => acceptOf(result));
    const report = engine.report()[mode];
    return { first, second, plans: report.plans, applied: report.applied, judgments: report.judgments, memos: report.memoHits };
  };
  const observed = await run('observe');
  const acted = await run('active');
  assert.equal(observed.plans, acted.plans, 'the same two payloads produce the same two plans');
  assert.equal(observed.judgments, acted.judgments, 'and cost the same number of judgments');
  assert.equal(observed.judgments, 1, 'the second identical payload is answered from the memo');
  assert.equal(observed.memos, acted.memos);
  assert.equal(observed.applied, 0);
  assert.equal(installedText(observed.first as { content?: unknown }), LONG_RESULT, 'observe installs nothing');
  assert.equal(installedText(observed.second as { content?: unknown }), LONG_RESULT);
  assert.equal(acted.applied, 2, 'active installs the reduction on every oversized result');
  assert.notEqual(installedText(acted.first as { content?: unknown }), LONG_RESULT);
  assert.equal(installedText(acted.first as { content?: unknown }), installedText(acted.second as { content?: unknown }));
});

// ── criterion 6: cost, compatibility, traceability ──────────────────────────

test('the report separates raw, judgment, injected, and actual from potential savings', async () => {
  const engine = engineFor({ mode: 'active' }, { stagnation: stagnationStub({}, 7).service });
  const agent = fakeAgent({ id: 'accounting' });
  const result = resultOf(LONG_RESULT);
  await engine.toolResult(execOf('bash', { command: 'build' }, agent), result, async () => acceptOf(result));
  const report = engine.report();
  assert.equal(report.baseline.results, 1);
  assert.equal(report.baseline.originalTokens, estimateTokens(LONG_RESULT), 'the baseline is what the hook was shown');
  assert.equal(report.active.originalTokens, estimateTokens(LONG_RESULT));
  assert.equal(report.observe.originalTokens, 0);
  assert.ok(report.active.judgeTokens > 0, 'the judgment cost is its own column');
  assert.ok(report.active.localLatencyMs >= 0);
  assert.equal(report.active.actualSavedTokens, report.active.potentialSavedTokens, 'active makes them equal');
  // A reduction injects nothing, so its column stays empty even though the plan
  // carries a note: the note is audit evidence, not context. A refusal, which
  // *does* add text, is where a non-zero column comes from.
  assert.equal(report.active.injectedTokens, 0);
  assert.equal(
    report.active.potentialSavedTokens - report.active.injectedTokens,
    report.active.actualSavedTokens,
    'the injected text is a separate column a reader subtracts, not a saving'
  );
  assert.ok(report.recent[0]!.feedback.length > 0, 'the note is still recorded for the operator');
  assert.equal(report.baseline.results, 1, 'the raw column counts what the hook was shown');
  assert.equal(report.active.plans, report.active.applied, 'in active mode every plan applied');
  assert.equal(Object.keys(report.byCapability).length, 4);
});

test('the remote and local halves of a judgment are separated, and one turn pays once', async () => {
  const resolved = resolveConfig({ backend: 'mock', interventions: { mode: 'observe' } });
  const stagnation = stagnationStub({}, 7);
  const engine = new InterventionEngine({
    config: resolved.interventions,
    pruneThreshold: 100,
    stagnation: stagnation.service,
    prune: pruneStub((raw) => raw.slice(0, 30)),
    gate: gateStub('contradicted')
  });
  const agent = fakeAgent({ id: 'latency' });
  const result = resultOf('ok');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.toolResult(execOf('bash', { command: 'ls' }, agent), result, async () => acceptOf(result));
  }
  const messages = [message('go')];
  const first = (await engine.preStep(stepPayload(agent, 1, 4, messages), async () => ({
    kind: 'enter' as const,
    messages
  }))) as { messages: unknown[] };
  const second = await engine.preStep(stepPayload(agent, 1, 5, messages), async () => ({ kind: 'enter' as const, messages }));
  assert.deepEqual(second, first, 'the second step of the turn enters with the same decision');
  const report = engine.report();
  assert.equal(report.observe.judgments, 1, 'the loop is judged once in the turn');
  assert.equal(report.observe.remoteLatencyMs, 7, 'the backend latency is the remote half');
  assert.equal(stagnation.calls.length, 1);
  assert.equal(report.observe.memoHits, 0);
  // The second step sees the same trailing signature, and that episode was already
  // intervened on: it is not a second question, it is the same one, and asking it
  // again is exactly the duplicate the latch exists to prevent.
  assert.equal(engine.report().skips['duplicate-intervention'], 1);
});

test('two capabilities of one turn share a single paid judgment, and report the reuse', async () => {
  const resolved = resolveConfig({ backend: 'mock', interventions: { mode: 'observe' } });
  const stagnation = stagnationStub({}, 7);
  const engine = new InterventionEngine({
    config: resolved.interventions,
    pruneThreshold: 100,
    stagnation: stagnation.service,
    prune: pruneStub((raw) => raw.slice(0, 30)),
    gate: gateStub('contradicted')
  });
  const agent = fakeAgent({ id: 'shared-verdict' });
  const failing = resultOf('boom', true);
  const exec = execOf('bash', { command: 'node x' }, agent);
  const messages = [message('go')];
  // The pre-step is the turn authority: the tool hooks of a turn run after the
  // pre-step that opened it, which is what lets one verdict serve all of them.
  await engine.preStep(stepPayload(agent, 1, 1, messages), async () => ({ kind: 'enter' as const, messages }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.toolResult(exec, failing, async () => acceptOf(failing));
  }
  await engine.preStep(stepPayload(agent, 1, 2, messages), async () => ({ kind: 'enter' as const, messages }));

  const report = engine.report();
  assert.equal(report.observe.plans, 2, 'the failure correction and the step correction were both planned');
  assert.equal(stagnation.calls.length, 1, 'the backend answered the same question once');
  assert.equal(report.observe.judgments, 1, 'and the turn paid for one judgment');
  assert.equal(report.observe.memoHits, 1, 'the second capability reports the reuse as a memo hit');
  assert.equal(report.observe.remoteLatencyMs, 7, 'the one remote call carries the remote half');
});

test('a floored reduction honours the share, keeps the judged middle, and names the original', async () => {
  // The key diagnostic lives in the *middle* of the payload, where neither the
  // head nor the tail slice reaches it: the only thing that can carry it into the
  // installed form is the judgment's own extract.
  const key = 'KEY-ERROR: undefined symbol while linking libfoo.so';
  // Line-oriented, like the compiler output this reduction exists for — and the
  // key diagnostic sits in the middle, out of reach of both the head and the tail.
  const noise = (fill: string): string => `${Array.from({ length: 3 }, (_, index) => `${fill}${index}`).join('\n')}\n`;
  const original = `${'H'.repeat(500)}\n${noise('M'.repeat(295))}${key}\n${noise('M'.repeat(295))}${'T'.repeat(500)}\n`;
  const judged = key;
  const locator = locatorOf(original);
  const plan = pruneFloorPlan(original.length, judged.length, {
    floorRatio: 0.5,
    headChars: 500,
    tailChars: 500,
    markerChars: pruneMarker(locator).length
  });
  assert.equal(plan.floored, true, 'a candidate far below the floor ratio is floored, not discarded');
  // The ratio is a share, not a suggestion: the installed form really carries it.
  assert.ok(plan.resultChars >= Math.ceil(original.length * 0.5), 'the promised share survives in practice');
  assert.ok(plan.resultChars < original.length, 'and the reduction is still a reduction');
  assert.equal(plan.omittedChars, original.length - plan.resultChars);

  const floored = applyPruneFloor(original, judged, { floorRatio: 0.5, headChars: 500, tailChars: 500, locator });
  assert.equal(floored.resultChars, floored.text.length, 'the returned plan reports the size the text really has');
  assert.equal(floored.floored, true);
  assert.ok(floored.text.startsWith(original.slice(0, floored.headChars)), 'the head survives verbatim');
  assert.ok(floored.text.endsWith(original.slice(original.length - floored.tailChars)), 'so does the tail');
  assert.equal(original[floored.headChars - 1], '\n', 'the head ends where a line ends, never inside one');
  assert.equal(original[original.length - floored.tailChars - 1], '\n', 'and the tail starts where a line starts');
  assert.ok(floored.text.includes(key), 'the middle diagnostic the judgment kept is not dropped by the floor');
  assert.ok(floored.text.includes(locator), 'the installed form says where the original is');
  assert.ok(floored.text.length >= Math.ceil(original.length * 0.5));

  // The engine installs exactly the plan its audit record describes, and retains
  // the original it replaced.
  const retention = retentionStub();
  const engine = engineFor({ mode: 'active' }, { prune: pruneStub(() => judged), retain: retention.retain });
  const result = resultOf(original);
  const decision = (await engine.toolResult(execOf('bash', { command: 'build' }), result, async () =>
    acceptOf(result)
  )) as { content: { type: string; text: string }[] };
  const engineText = applyPruneFloor(original, judged, { floorRatio: 0.5, headChars: 400, tailChars: 400, locator });
  assert.equal(installedText(decision), engineText.text, 'the configured head and tail sizes are the ones used');
  const record = engine.report().recent[0]!;
  assert.equal(record.floorApplied, true);
  assert.equal(record.originalTokens, estimateTokens(original));
  assert.equal(record.candidateTokens, estimateTokens(engineText.text));
  assert.equal(record.digest, digestOf(original), 'the record points back at the payload it reduced');
  assert.equal(record.originalLocator, locator, 'and at the retained copy it can be read back from');
  assert.equal(retention.originals.get(locator), original, 'the retained copy is the payload, byte for byte');
  assert.equal(engine.report().retained.copies, 1);
  assert.deepEqual(engine.report().retained.locators, [locator]);
});

test('the floor keeps whole lines, so no cut can leave a fragment of one behind', () => {
  // The payload of the report that opened this: progress lines that begin with their
  // own prefix, which a character slice cuts through the middle of — the reader saw
  // `=] progress 092` where a whole line used to be.
  const lines = Array.from({ length: 40 }, (_, index) => `=] progress ${String(index).padStart(3, '0')} ${'x'.repeat(40)}\n`);
  const original = lines.join('');
  const judged = 'KEY: cannot open shared object file\n';
  const locator = locatorOf(original);
  const floored = applyPruneFloor(original, judged, { floorRatio: 0.5, headChars: 400, tailChars: 400, locator });

  assert.equal(floored.floored, true, 'a candidate far below the share is floored, not discarded');
  assert.ok(floored.headChars > 0 && floored.tailChars > 0, 'both sides kept something');
  assert.equal(original[floored.headChars - 1], '\n', 'the head stops at a line end, never inside a line');
  assert.equal(original[original.length - floored.tailChars - 1], '\n', 'the tail starts at a line start');
  // Every line the head kept is a whole line of the original…
  const headText = floored.text.slice(0, floored.headChars);
  assert.equal(headText.endsWith('\n'), true);
  for (const line of headText.split('\n').slice(0, -1)) {
    assert.equal(original.includes(`${line}\n`), true, `the head kept a whole line: ${line}`);
  }
  // …and the line the budget landed inside is dropped whole rather than trimmed: the
  // fragment the report quoted must not appear anywhere in the installed form.
  const straddled = original.slice(floored.headChars, original.indexOf('\n', floored.headChars));
  assert.ok(straddled.startsWith('=] progress'), 'the head budget really lands inside a prefixed progress line');
  assert.equal(floored.text.includes(straddled), false, 'that line is neither kept nor half-kept');
  assert.equal(floored.text.includes('=] progress 006'), true, 'the last whole line inside the budget is kept');
  assert.equal(floored.text.includes('=] progress 039'), true, 'and the tail keeps the last line');
  assert.equal(floored.text.includes(judged.trim()), true, 'the judgment’s own extract survives the floor');
  assert.ok(floored.text.length >= Math.ceil(original.length * 0.5), 'the promised share is really carried');
  assert.ok(floored.text.length < original.length, 'and the form is still a reduction');
});

test('a CRLF payload keeps whole lines too, and never strands a carriage return', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `row ${String(index).padStart(2, '0')} ${'r'.repeat(50)}\r\n`);
  const original = lines.join('');
  const judged = 'KEY: crlf diagnostic\r\n';
  const locator = locatorOf(original);
  const floored = applyPruneFloor(original, judged, { floorRatio: 0.5, headChars: 400, tailChars: 400, locator });

  assert.equal(floored.floored, true);
  assert.equal(original[floored.headChars - 1], '\n', 'the head ends after a terminator');
  assert.equal(original[floored.headChars - 2], '\r', 'and the terminator it ends after is the whole CRLF');
  assert.equal(original[original.length - floored.tailChars - 1], '\n', 'the tail begins after a terminator');
  assert.equal(original[original.length - floored.tailChars - 2], '\r');
  assert.equal(/\r(?!\n)/.test(floored.text), false, 'no bare carriage return is stranded in the text');
  assert.equal(floored.text.includes(judged.trim()), true, 'the judgment’s own extract survives');
  assert.ok(floored.text.length >= Math.ceil(original.length * 0.5));
  assert.ok(floored.text.length < original.length);
});

test('a payload with no line to keep is refused, never cut into a fragment', () => {
  // One runaway line and no terminator at all: there is no whole line to keep, so
  // there is no floor form — the original is handed back rather than chopped.
  const original = 'L'.repeat(1200);
  const floored = applyPruneFloor(original, 'L'.repeat(80), {
    floorRatio: 0.5,
    headChars: 400,
    tailChars: 400,
    locator: locatorOf(original)
  });
  assert.equal(floored.floored, false, 'the floor refuses a payload it cannot align');
  assert.equal(floored.text, original, 'the original is handed back whole');
  assert.equal(floored.resultChars, original.length);
  assert.equal(floored.omittedChars, 0, 'nothing was left out, so nothing was claimed');
  assert.equal(floored.text.includes('reflex prune'), false, 'and no marker was installed');
});

test('a first line longer than its budget is refused rather than trimmed', () => {
  // The head budget cannot pay for a whole first line, and the tail cannot reach the
  // share without overlapping it: the form would have to cut a line, so it is refused.
  const original = `${'A'.repeat(600)}\n${Array.from({ length: 4 }, (_, index) => `tail line ${index}\n`).join('')}`;
  const floored = applyPruneFloor(original, 'DIAGNOSTIC\n', {
    floorRatio: 0.5,
    headChars: 400,
    tailChars: 400,
    locator: locatorOf(original)
  });
  assert.equal(floored.floored, false);
  assert.equal(floored.text, original);
  assert.equal(floored.omittedChars, 0);
  assert.equal(floored.text.includes('DIAGNOSTIC'), false, 'the refused form is the original, and nothing of the candidate');
  assert.equal(floored.text.includes('reflex prune'), false, 'nothing half-line was installed');
});

test('the floor drops the candidate lines the kept context already shows, and keeps the unique ones', () => {
  const rows = Array.from({ length: 40 }, (_, index) => `noise row ${String(index).padStart(2, '0')} ${'n'.repeat(60)}\n`);
  const original = rows.join('');
  const diagnostic = 'KEY: cannot open shared object file: No such file or directory\n';
  // The judgment reads the whole payload, so its extract repeats rows the context
  // already carries — the trace that prompted this showed BEGIN/RESULT/END twice.
  const judged = `${rows[35]}${diagnostic}${rows[36]}`;
  const floored = applyPruneFloor(original, judged, {
    floorRatio: 0.5,
    headChars: 400,
    tailChars: 400,
    locator: locatorOf(original)
  });

  assert.equal(floored.floored, true);
  assert.equal(floored.text.includes(diagnostic.trim()), true, 'the diagnostic only the judgment saw survives');
  const kept = floored.text.split('\n');
  assert.equal(
    kept.filter((line) => line === rows[35]!.replace(/\n$/, '')).length,
    1,
    'a line the tail already shows is carried once, not twice'
  );
  assert.equal(kept.filter((line) => line === rows[36]!.replace(/\n$/, '')).length, 1);
  assert.equal(floored.text.split(diagnostic.trim()).length - 1, 1, 'the diagnostic is carried once as well');
  assert.ok(floored.text.length >= Math.ceil(original.length * 0.5));
  assert.ok(floored.text.length < original.length);
});

test('a candidate that was nothing but duplicates still composes a legal, complete form', () => {
  const rows = Array.from({ length: 40 }, (_, index) => `noise row ${String(index).padStart(2, '0')} ${'n'.repeat(60)}\n`);
  const original = rows.join('');
  const locator = locatorOf(original);
  // Every line of this extract is a line the tail already shows: the floor must not
  // install an empty middle, a dangling closing marker, or a form short of the share.
  const floored = applyPruneFloor(original, `${rows[36]}${rows[37]}`, {
    floorRatio: 0.5,
    headChars: 400,
    tailChars: 400,
    locator
  });

  assert.equal(floored.floored, true, 'the share can still be carried, so the form is installed');
  const marker = pruneMarker(locator);
  assert.equal(floored.text.indexOf(marker), floored.text.lastIndexOf(marker), 'no closing marker without a middle');
  assert.equal(floored.text.includes(rows[37]!.trim()), true, 'the context still shows the line');
  assert.equal(floored.text.split(rows[37]!.trim()).length - 1, 1, 'exactly once');
  assert.ok(floored.text.length >= Math.ceil(original.length * 0.5), 'the promised share is still carried');
  assert.ok(floored.text.length < original.length, 'and the form is still a reduction');
});

test('a composed form is its own fixed point, so a memo hit reinstalls the same bytes', () => {
  // The engine answers a memo hit through the same composition the first install went
  // through (the memo keeps the form, not the candidate). That is only sound while
  // flooring an already floored form is a no-op: the form carries the share, so the
  // plan of those lengths stays "not floored" and hands the text straight back.
  const rows = Array.from({ length: 40 }, (_, index) => `noise row ${String(index).padStart(2, '0')} ${'n'.repeat(60)}\n`);
  const original = rows.join('');
  const options = { floorRatio: 0.5, headChars: 400, tailChars: 400, locator: locatorOf(original) };
  const first = applyPruneFloor(original, 'KEY: cannot open shared object file\n', options);
  assert.equal(first.floored, true);
  assert.ok(first.text.length >= Math.ceil(original.length * 0.5), 'the form carries the share');

  const second = applyPruneFloor(original, first.text, options);
  assert.equal(second.text, first.text, 'the second pass returns the same bytes');
  assert.equal(second.resultChars, first.text.length, 'and books the size it really has');
  assert.equal(second.floored, false, 'it is not floored twice: it already carries the share');
});

test('a candidate that is not actually smaller is refused', async () => {  const engine = engineFor({ mode: 'active' }, { prune: pruneStub((raw) => `${raw}${raw}`) });
  const result = resultOf(LONG_RESULT);
  const decision = await engine.toolResult(execOf('bash', { command: 'build' }), result, async () => acceptOf(result));
  assert.equal(installedText(decision as { content?: unknown }), LONG_RESULT);
  assert.equal(engine.report().active.applied, 0);
  assert.ok((engine.report().skips['no-reduction'] ?? 0) >= 1);
  assert.equal(engine.report().active.actualSavedTokens, 0);
});

test('the shared ledger never books a shadow measurement as an actual saving', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'off' } });
    const text = REDUCIBLE_RESULT.repeat(2);
    const shadow = await runtime.pruneService.prune(text, { shadowMode: true });
    assert.equal(shadow.shadow, true);
    assert.equal(shadow.processedOutput, text, 'a shadow response withholds the candidate');
    assert.ok(shadow.estimatedTokensSaved > 0, 'it still measures the candidate');
    const entry = runtime.ledger.getEntries().at(-1)!;
    assert.equal(entry.shadow, true);
    assert.equal(entry.tokensSaved, 0, 'nothing was removed from the context');
    assert.equal((entry.details as { potentialTokensSaved?: number }).potentialTokensSaved, shadow.estimatedTokensSaved);

    const applied = await runtime.pruneService.prune(text, { shadowMode: false });
    const appliedEntry = runtime.ledger.getEntries().at(-1)!;
    assert.equal(appliedEntry.shadow, false);
    assert.equal(appliedEntry.tokensSaved, applied.estimatedTokensSaved);
    assert.ok(appliedEntry.tokensSaved! > 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the observe column of a real session leaves a durable record and no model-visible trace', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'observe' } });
    const session = Session.create('interventions-observe' as SessionId);
    const agent = { ...fakeAgent({ id: 'audited' }), session } as unknown as Agent;
    ctx.tools.register(
      defineTool({
        name: 'iv_noisy',
        description: 'Test-only tool returning a bulky result.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' as const },
          render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }]
        },
        async execute(args: { text: string }) {
          return args.text;
        }
      })
    );
    const result = await ctx.tools.execute({
      callId: 'iv-noisy-1' as never,
      name: 'iv_noisy',
      arguments: { text: REDUCIBLE_RESULT },
      signal: new AbortController().signal,
      agent
    });
    assert.equal(result.isError, false);
    assert.equal(resultText(result), REDUCIBLE_RESULT, 'the model reads the raw result');

    const records = interventionRecordsOf(session.ownEvents());
    assert.equal(records.length, 1, 'the decision is auditable');
    const record = records[0]!;
    assert.equal(record.mode, 'observe');
    assert.equal(record.applied, false);
    assert.equal(record.feedback, '', 'an observation has nothing model-facing to record');
    assert.equal(record.actualSavedTokens, 0);
    assert.ok(record.potentialSavedTokens > 0);
    assert.equal(record.agentId, 'audited');
    assert.equal(record.digest, digestOf(REDUCIBLE_RESULT));

    // The record lives in the session log, not in the surface the model reads.
    for (const event of session.ownEvents()) {
      assert.equal(JSON.stringify(event).includes('Reflex intervention:'), false, 'no intervention text entered a message');
    }

    // …and the pre-step the loop would run next still carries only its own input.
    const messages = [message('carry on')];
    const decision = (await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { turn: 1, step: 2, signal: new AbortController().signal, messages } as never,
      async () => ({ kind: 'enter' as const, messages })
    )) as { messages: unknown[] };
    assert.equal(decision.messages.length, 1);
    assert.equal(runtime.interventions!.report().observe.applied, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the engine stays correct on the pure helpers a reader can call directly', () => {
  const steps = ['a', 'b', 'a', 'b'].map((signature, index) => ({
    signature,
    tool: signature,
    input: signature,
    output: '',
    error: '',
    failed: false,
    turn: 1,
    at: index
  }));
  assert.equal(countTrailingRepeats(steps, 'b'), 1);
  assert.equal(countTrailingRepeats(steps, 'missing'), 0);
  assert.equal(detectOscillation(steps, 6), true);
  assert.equal(detectOscillation([...steps, steps[0]!], 6), true, 'a b a b a is still an alternation');
  assert.equal(detectOscillation(steps.slice(0, 3), 6), false, 'three entries cannot establish an alternation');
  assert.equal(countTrailingFailures([{ ...steps[0]!, failed: true }, { ...steps[1]!, failed: true }]), 2);
  assert.equal(
    suspicionOf(steps, { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: 'b' }).pattern,
    'oscillation'
  );
  assert.equal(suspicionOf(steps, { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: 'b' }).suspicious, true);
  assert.equal(suspicionOf([steps[0]!], { repeatThreshold: 3, failureThreshold: 3, window: 6, signature: 'a' }).suspicious, false);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(digestOf('same'), digestOf('same'));
  assert.notEqual(digestOf('same'), digestOf('other'));
});

test('the audit record type is owned by this plugin and never collides with the effort trail', () => {
  assert.equal(INTERVENTION_RECORD_TYPE, 'plugin:dsh-reflex/intervention');
  assert.equal(interventionRecordsOf([]).length, 0);
  assert.equal(interventionRecordsOf(undefined).length, 0);
});

// ── rework regressions: the real pipeline, not a stand-in ───────────────────
//
// The brief for this round was specific about *how* the above had to be proven:
// through the Host's own registry and hooks, with the payloads it really
// produces, and with every "saved" number derived from what actually came back.
// These tests are that proof. Where a real Host artefact cannot be imported
// without adding a dependency to this package — the shell tool itself — the test
// uses the contract the tool source guarantees (its structured `exitCode`, and
// the exit badge the Host appends as the last line of the content) and drives a
// **real** child process for the exit code.

/** The canonical value the Host's shell tool returns, per its own declaration. */
function bashValueOf(exitCode: number, stdout = ''): Record<string, unknown> {
  return {
    cwd: '/work',
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false }
  };
}

/** The Host's rendering rule: the body (or its placeholder), then the badge. */
function bashRenderOf(value: Record<string, unknown>): string {
  const body = (value.stdout as { text: string }).text;
  return `${body.length === 0 ? '(no output)' : body}\n[exit code: ${String(value.exitCode)}]`;
}

/** One shell result exactly as the registry hands it to the hooks. */
function bashResultOf(value: Record<string, unknown>): Readonly<ToolExecutionResult> {
  return {
    isError: false,
    value,
    content: [{ type: 'text', text: bashRenderOf(value) }],
    meta: {}
  } as unknown as Readonly<ToolExecutionResult>;
}

test('a failure is decided by the exit evidence the tool source guarantees, never by wording', async () => {
  const { spawnSync } = await import('node:child_process');
  const realExit = (code: number): number | null => spawnSync(process.execPath, ['-e', `process.exit(${code})`]).status;
  assert.equal(realExit(1), 1, 'a real child process really exits 1');
  assert.equal(realExit(0), 0, 'and a real child process really exits 0');

  // 1) the structured field of a real non-zero exit.
  const failed = bashResultOf(bashValueOf(1, 'compiling…'));
  assert.equal(failureOf(failed, bashRenderOf(bashValueOf(1, 'compiling…'))), true);
  // 2) …and of a real zero exit, which is *reported*, not errored.
  const ok = bashResultOf(bashValueOf(0, 'compiling…'));
  assert.equal(failureOf(ok, bashRenderOf(bashValueOf(0, 'compiling…'))), false);
  // 3) the Host's own badge, for a result that carries no structured value.
  const badged = (text: string) =>
    ({ isError: false, content: [{ type: 'text', text }] }) as unknown as Readonly<ToolExecutionResult>;
  assert.equal(failureOf(badged('boom\n[exit code: 1]'), 'boom\n[exit code: 1]'), true);
  assert.equal(failureOf(badged('fine\n[exit code: 0]'), 'fine\n[exit code: 0]'), false);
  assert.equal(failureOf(badged('(no output)\n[exit code: 2]'), '(no output)\n[exit code: 2]'), true);
  assert.equal(failureOf(badged('boom\n[killed by signal: SIGKILL]'), 'boom\n[killed by signal: SIGKILL]'), true);
  assert.equal(failureOf(undefined, 'boom\n[exit code: 1]'), false, 'with no result at all there is nothing to act on');
  // 4) an ordinary source that merely *mentions* failure is not one.
  const noisy = 'const msg = "assertion failed";\nif (failed) report(failed);';
  assert.equal(failureOf(bashResultOf(bashValueOf(0, noisy)), `${noisy}\n[exit code: 0]`), false);
  assert.equal(failureOf(badged(`${noisy}\n[exit code: 0]`), `${noisy}\n[exit code: 0]`), false, 'the word is not the evidence');
  // 5) a badge in the middle of the text is not the badge.
  assert.equal(failureOf(badged('line\n[exit code: 1]\nmore output'), 'line\n[exit code: 1]\nmore output'), false);

  // 6) end to end: three real non-zero exits are a loop; three real zeros are not.
  const run = async (exitCode: number) => {
    const engine = engineFor({ mode: 'active' }, { gate: gateStub('contradicted') });
    const agent = fakeAgent({ id: `bash-exit-${exitCode}` });
    const value = bashValueOf(exitCode, 'noisy build log');
    const result = bashResultOf(value);
    const exec = execOf('bash', { command: 'npm run build' }, agent);
    let last: PostToolDecision | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await engine.toolResult(exec, result, async () => acceptOf(result));
    }
    return { engine, last: last!, report: engine.report() };
  };
  const red = await run(1);
  assert.equal(red.last.kind, 'block', 'a green-looking wrapper over a real failure is corrected');
  assert.equal(red.report.active.applied, 1);
  assert.equal(red.report.baseline.failures, 3, 'all three real failures are in the baseline');
  const green = await run(0);
  assert.equal(green.last.kind, 'accept', 'a real success is not corrected, however noisy the log');
  assert.equal(green.report.active.applied, 0);
  assert.equal(green.report.baseline.failures, 0);

  // 7) the closing check reads the same evidence: a claim of success over a real
  //    non-zero exit is contradicted, and over a real zero exit it is not.
  const closing = async (exitCode: number, gate: 'contradicted' | 'verified') => {
    const steered: UserMessage[] = [];
    const agent = { ...fakeAgent({ id: `bash-closing-${exitCode}` }), steer: (m: UserMessage) => steered.push(m) };
    const engine = engineFor({ mode: 'active' }, { gate: gateStub(gate) });
    engine.observeAssistantStream({
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'All 42 tests passed and the build is green.' } }
    });
    const value = bashValueOf(exitCode, 'log');
    const result = bashResultOf(value);
    await engine.toolResult(execOf('bash', { command: 'npm test' }, agent), result, async () => acceptOf(result));
    await engine.turnStopping({ agent, turn: 1 });
    return { steered, report: engine.report() };
  };
  const objected = await closing(1, 'contradicted');
  assert.equal(objected.steered.length, 1, 'the objection reaches the agent');
  assert.equal(objected.report.active.applied, 1);
  assert.match(textOfContent(objected.steered[0]!.content as never), /about to close/);
  const accepted = await closing(0, 'contradicted');
  assert.equal(accepted.steered.length, 0, 'a real success leaves the turn boundary alone');
  assert.equal(accepted.report.active.applied, 0);
  assert.equal(accepted.report.skips['planning-error'], undefined, 'and not because of a failure');

  // 8) evidence is refreshed: two failures and then a success are not a loop.
  const refreshing = engineFor({ mode: 'active' }, { gate: gateStub('contradicted') });
  const agent = fakeAgent({ id: 'bash-refresh' });
  const exec = execOf('bash', { command: 'npm run build' }, agent);
  const state = refreshing.stateOf('bash-refresh');
  for (const exitCode of [1, 1, 0]) {
    const result = bashResultOf(bashValueOf(exitCode, 'log'));
    await refreshing.toolResult(exec, result, async () => acceptOf(result));
  }
  assert.equal(refreshing.report().active.applied, 0, 'the success broke the failing run');
  assert.equal(refreshing.report().baseline.failures, 2);
  assert.equal(state === undefined, true, 'the engine keeps agent state, not test state');
});

test('active reduces the payload the registry really returns, and retains the original it replaced', async () => {
  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'active' }, pruneThreshold: 200 });
    const session = Session.create('interventions-prune-active' as SessionId);
    const agent = { ...fakeAgent({ id: 'pruned' }), session } as unknown as Agent;
    ctx.tools.register(
      defineTool({
        name: 'iv_bulky',
        description: 'Test-only tool returning a bulky result.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' as const },
          render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }]
        },
        async execute(args: { text: string }) {
          return args.text;
        }
      })
    );

    // No post-execute listener of this test's own: the registry's default accept
    // is the decision the engine has to work from, and it carries no content.
    const result = await ctx.tools.execute({
      callId: 'iv-bulky-1' as never,
      name: 'iv_bulky',
      arguments: { text: REDUCIBLE_RESULT },
      signal: new AbortController().signal,
      agent
    });
    assert.equal(result.isError, false);
    const installed = resultText(result);
    assert.ok(installed.length > 0);
    assert.ok(installed.length < REDUCIBLE_RESULT.length, 'what the registry returns for the model really shrank');
    assert.equal(installed.includes('build finished ok'), true, 'the tail of the result survives');

    const report = runtime.interventions!.report();
    assert.equal(report.active.plans, 1);
    assert.equal(report.active.applied, 1);
    assert.equal(report.active.originalTokens, estimateTokens(REDUCIBLE_RESULT));
    assert.equal(report.active.candidateTokens, estimateTokens(installed), 'the candidate is the installed size');
    assert.equal(
      report.active.actualSavedTokens,
      estimateTokens(REDUCIBLE_RESULT) - estimateTokens(installed),
      'the saving is measured against the payload that really came back'
    );
    assert.equal(report.active.injectedTokens, 0, 'a reduction injects nothing');
    assert.equal(report.baseline.originalTokens, estimateTokens(REDUCIBLE_RESULT));

    // The original is retrievable through the locator the installed text carries.
    const record = interventionRecordsOf(session.ownEvents())[0]!;
    assert.ok(typeof record.originalLocator === 'string' && record.originalLocator.length > 0);
    assert.equal(installed.includes(record.originalLocator!), true, 'the model is told where the original is');
    const retrieved = readPrunedOriginal(session.ownEvents(), record.originalLocator!);
    assert.ok(retrieved, 'the locator names a record');
    assert.equal(retrieved!.text, REDUCIBLE_RESULT, 'and its text is the original, byte for byte');
    assert.equal(retrieved!.chars, REDUCIBLE_RESULT.length, 'with the size it was retained at');
    assert.equal(retrieved!.digest, record.digest, 'and the digest the decision was made under');

    // A duplicate payload reuses the retained copy instead of writing a second one.
    const second = await ctx.tools.execute({
      callId: 'iv-bulky-2' as never,
      name: 'iv_bulky',
      arguments: { text: REDUCIBLE_RESULT },
      signal: new AbortController().signal,
      agent
    });
    assert.equal(resultText(second), installed, 'the same payload reduces to the same installed text');
    const replicated = prunedOriginalsOf(session.ownEvents());
    assert.equal(replicated.length, 1, 'retention is per payload, not per install');
    assert.equal(readPrunedOriginal(session.ownEvents(), replicated[0]!.locator)!.text, REDUCIBLE_RESULT);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the reduction is computed from the content the waterfall really returns, not from the raw result', async () => {
  const ctx = await createToolContext();
  // Line-oriented, like the compiler output this reduction exists for: the floor
  // composes whole lines, so a payload that is one runaway line has no floor at all.
  const replaced = `${Array.from({ length: 40 }, () => `${'E'.repeat(70)}\n`).join('')}the tail`;
  const seen: string[] = [];
  try {
    ctx.tools.register(
      defineTool({
        name: 'iv_replaced',
        description: 'Test-only tool whose result another listener replaces.',
        parameters: {},
        output: {
          schema: { type: 'json' as const },
          render: () => [{ type: 'text' as const, text: 'the raw result nobody will read' }]
        },
        async execute() {
          return 'raw';
        }
      })
    );
    const installation = installInterventions(ctx, {
      config: resolveConfig({ backend: 'mock', interventions: { mode: 'active' } }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: {
        prune: async (raw: string) => {
          seen.push(raw);
          const text = raw.slice(0, 60);
          return {
            processedOutput: text,
            originalChars: raw.length,
            prunedChars: text.length,
            estimatedTokensSaved: 0,
            reductionPercentage: 50,
            shadow: false,
            latencyMs: 0
          } satisfies PruneResponse;
        }
      } as InterventionEngineOptions['prune'],
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    // Registered after the engine, so it sits deeper in the waterfall: the engine
    // asks for the rest of the chain and reads what comes back.
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next();
      return { kind: 'accept', content: [{ type: 'text', text: replaced }] } as PostToolDecision;
    });

    const result = await ctx.tools.execute({
      callId: 'iv-replaced-1' as never,
      name: 'iv_replaced',
      arguments: {},
      signal: new AbortController().signal,
      agent: fakeAgent({ id: 'replaced' })
    });
    assert.deepEqual(seen, [replaced], 'the judgment ran on the replacement, not on the result it shadowed');
    const installed = resultText(result);
    assert.notEqual(installed, replaced, 'the replacement is the text that got reduced');
    assert.ok(installed.length < replaced.length);
    assert.equal(installation.engine.report().active.originalTokens, estimateTokens(replaced));
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a value-shaped accept, a block, and an image-only payload are handed back by identity', async () => {
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } };
  const engine = engineFor({ mode: 'active' });
  const exec = execOf('bash', { command: 'build' });
  const result = resultOf(LONG_RESULT);

  const valued = { kind: 'accept', value: { ok: true } } as unknown as PostToolDecision;
  assert.equal(await engine.toolResult(exec, result, async () => valued), valued, 'a value-shaped accept is returned by identity');

  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] } as unknown as PostToolDecision;
  assert.equal(await engine.toolResult(exec, result, async () => blocked), blocked, 'a block is returned by identity');

  const imagesOnly = { kind: 'accept', content: [image] } as unknown as PostToolDecision;
  assert.equal(await engine.toolResult(exec, result, async () => imagesOnly), imagesOnly, 'a payload with no text has nothing to reduce');
  assert.equal(engine.report().skips['no-text-block'], 1);

  // Mixed content: the text block is replaced, the image survives untouched.
  const mixed = { kind: 'accept', content: [{ type: 'text', text: LONG_RESULT }, image] } as unknown as PostToolDecision;
  const decision = (await engine.toolResult(exec, result, async () => mixed)) as { content: { type: string }[] };
  assert.notEqual(decision, mixed);
  assert.equal(decision.content.length, 2);
  assert.equal(decision.content[1], image, 'the non-text block is the same object');
  assert.ok(textOfContent(decision.content as never).length < LONG_RESULT.length);
  assert.equal(engine.report().active.applied, 1);
});

test('a result the retention cannot describe is left byte-identical, and costs nothing', async () => {
  const engine = engineFor({ mode: 'active' });
  const exec = execOf('bash', { command: 'build' });

  const oneLine = resultOf('x'.repeat(4000));
  const untouched = await engine.toolResult(exec, oneLine, async () => acceptOf(oneLine));
  assert.equal(installedText(untouched as { content?: unknown }), 'x'.repeat(4000));
  assert.equal(engine.report().skips['unsupported-payload'], 1, 'a single line is not a payload this module will rewrite');
  assert.equal(engine.report().baseline.originalTokens, estimateTokens('x'.repeat(4000)));
  assert.equal(engine.report().active.judgments, 0, 'and it did not pay for a judgment');

  const huge = `${'y'.repeat(1000)}\n`.repeat(200);
  const oversized = resultOf(huge);
  await engine.toolResult(execOf('bash', { command: 'cat log' }), oversized, async () => acceptOf(oversized));
  assert.equal(engine.report().skips['retention-too-large'], 1, 'a hundred-kilobyte copy is not kept');
  assert.equal(engine.report().active.judgments, 0);
});

test('nothing is replaced when the original cannot be retained', async () => {
  const engine = engineFor({ mode: 'active' }, { retain: retentionStub({ fail: true }).retain });
  const result = resultOf(LONG_RESULT);
  const downstream = acceptOf(result);
  const decision = await engine.toolResult(execOf('bash', { command: 'build' }), result, async () => downstream);
  assert.equal(decision, downstream, 'the result is handed on by identity');
  assert.equal(installedText(decision as { content?: unknown }), LONG_RESULT);
  const report = engine.report();
  assert.equal(report.active.applied, 0);
  assert.equal(report.active.actualSavedTokens, 0, 'nothing was saved, so nothing is claimed');
  assert.equal(report.active.plans, 0, 'and nothing is described as a reduction that never happened');
  assert.equal(report.active.judgments, 1, 'the judgment that got this far is still charged');
  assert.ok(report.active.judgeTokens > 0);
  assert.equal(report.skips['retention-failed'], 1);

  // The production sink refuses an agent with no session at all.
  const request = { digest: 'd', callId: 'c', tool: 'bash', turn: 1, step: 1, text: LONG_RESULT };
  assert.equal(appendPrunedOriginal(undefined, request), undefined);
  assert.equal(appendPrunedOriginal({} as never, request), undefined);
});

test('the real pruning service keeps observe and active on one form, one cost, one budget', async () => {
  const run = async (mode: 'observe' | 'active') => {
    const ctx = await createToolContext();
    try {
      const runtime = applyReflex(ctx, {
        backend: 'mock',
        interventions: { mode, maxJudgmentsPerTurn: 6, maxJudgmentsPerSession: 10 }
      });
      // A real session: active mode must be able to retain the original, and the
      // session log is where retention lives.
      const session = Session.create(`parity-${mode}` as SessionId);
      const agent = { ...fakeAgent({ id: `parity-${mode}` }), session } as unknown as Agent;
      const events = agentEvents(ctx, agent);
      const messages = [message('go')];
      const enter = (turn: number, step: number) =>
        events.waterfall(
          'agent/pre-step',
          { turn, step, signal: new AbortController().signal, messages } as never,
          async () => ({ kind: 'enter' as const, messages })
        );
      const read = async (step: number) =>
        ctx.tools.execute({
          callId: `parity-${mode}-${step}` as never,
          name: 'reflex_prune',
          arguments: { text: 'x' },
          signal: new AbortController().signal,
          agent
        });
      void read;
      await enter(1, 1);
      // Two identical reducible payloads (the second must hit the memo), then a
      // second step of the same turn, then the turn boundary.
      const payload = REDUCIBLE_RESULT;
      const installed: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const decision = await runtime.interventions!.toolResult(
          execOf('bash', { command: 'build' }, agent),
          resultOf(payload),
          async () => acceptOf(resultOf(payload))
        );
        installed.push(installedText(decision as { content?: unknown }));
      }
      await enter(1, 2);
      runtime.interventions!.observeAssistantStream({
        agent,
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'All checks passed.' } }
      });
      await runtime.interventions!.turnStopping({ agent, turn: 1 });
      const report = runtime.interventions!.report();
      // The audit of the session: the per-decision record is where the provenance of
      // each plan is written, memo hits included.
      const records = interventionRecordsOf(session.ownEvents()).filter((record) => record.capability === 'prune');
      // The real ledger of the real service, which is the only place that can say
      // whether observe asked for a withheld measurement or for the real reduction.
      const ledger = runtime.ledger.getEntries().map((entry) => ({
        type: entry.type,
        shadow: entry.shadow,
        // What the service says the harness stopped carrying…
        saved: entry.tokensSaved,
        // …and, when a caller asked for a withheld measurement, the size it did not install.
        candidate: (entry.details as { potentialTokensSaved?: number } | undefined)?.potentialTokensSaved,
        original: entry.originalTokens,
        pruned: entry.prunedTokens
      }));
      // One more call to the very same service, made *after* both snapshots, to
      // recompose the form independently of the engine: what the plan column books
      // has to be exactly this text, and active has to install exactly it.
      const engineConfig = runtime.interventions!.config;
      const probe = await runtime.pruneService.prune(payload);
      const expected = applyPruneFloor(payload, probe.processedOutput, {
        floorRatio: engineConfig.pruneFloorRatio,
        headChars: engineConfig.pruneHeadChars,
        tailChars: engineConfig.pruneTailChars,
        locator: locatorOf(payload)
      });
      return { report, ledger, installed, records, expected: expected.text };
    } finally {
      await ctx.fiber.dispose();
    }
  };

  const observed = await run('observe');
  const acted = await run('active');
  for (const capability of ['prune', 'stagnation', 'closing'] as const) {
    assert.equal(
      observed.report.byCapability[capability].plans,
      acted.report.byCapability[capability].plans,
      `${capability}: the same input plans the same decisions`
    );
    assert.equal(
      observed.report.byCapability[capability].candidateTokens,
      acted.report.byCapability[capability].candidateTokens,
      `${capability}: the same candidate sizes`
    );
    assert.equal(
      observed.report.byCapability[capability].judgments,
      acted.report.byCapability[capability].judgments,
      `${capability}: the same judgment budget`
    );
    assert.equal(observed.report.byCapability[capability].applied, 0, `${capability}: observe applies nothing`);
  }
  assert.equal(observed.report.observe.actualSavedTokens, 0, 'observe saves nothing for real');
  assert.ok(acted.report.active.actualSavedTokens > 0, 'active really removed tokens');
  assert.equal(observed.report.observe.potentialSavedTokens, acted.report.active.potentialSavedTokens);
  assert.equal(observed.report.observe.judgeTokens, acted.report.active.judgeTokens);
  assert.equal(observed.report.observe.memoHits, acted.report.active.memoHits, 'the memo behaves the same in both modes');
  assert.equal(observed.report.skips['duplicate-intervention'], acted.report.skips['duplicate-intervention']);
  // One form, planned by both modes and installed by the one allowed to install it.
  assert.equal(observed.installed[0], REDUCIBLE_RESULT, 'observe hands the payload on untouched');
  assert.equal(observed.installed[1], REDUCIBLE_RESULT, 'and again on the memo hit');
  assert.equal(acted.installed[0], observed.expected, 'active installs exactly the form the plan describes');
  assert.equal(acted.installed[0], acted.expected, 'and both modes compose that form from the same candidate');
  assert.equal(acted.installed[1], observed.expected, 'the memo hit reinstalls the same bytes');
  assert.equal(observed.report.observe.candidateTokens, 2 * estimateTokens(observed.expected), 'the plan books that form’s size, once per planned payload');
  assert.ok(observed.expected.length < REDUCIBLE_RESULT.length, 'the form really is a reduction');
  // Both modes now ask the service for the *real* reduction: the candidate's text is
  // what the floor composes from, so a withheld measurement would not be the same
  // input at all. Both therefore read the same payload, the same candidate and the
  // same candidate size out of it — one plan, one cost, one budget, one number.
  const observedPrunes = observed.ledger.filter((entry) => entry.type === 'prune');
  const actedPrunes = acted.ledger.filter((entry) => entry.type === 'prune');
  assert.equal(observedPrunes.length, actedPrunes.length, 'the service is called the same number of times');
  assert.equal(observedPrunes.length, 1, 'the second identical payload was answered from the memo, not from the service');
  assert.equal(observedPrunes.every((entry) => entry.shadow === false), true, 'observe asks for the real reduction too');
  assert.deepEqual(
    observedPrunes.map((entry) => [entry.original, entry.pruned, entry.saved]),
    actedPrunes.map((entry) => [entry.original, entry.pruned, entry.saved]),
    'both modes read the same payload, the same candidate and the same candidate size'
  );
  assert.ok(actedPrunes.every((entry) => entry.saved! > 0), 'the service really did reduce the payload');
  // `tokensSaved` there is the service's measure of the reduction it produced, not a
  // claim about what a mode installed: active already books a candidate the floor may
  // refuse to install, and observe books the one it measured. What each mode really
  // did is booked in the intervention columns asserted above — observe saved nothing
  // for real, and active saved exactly the form it installed.
  assert.equal(observed.report.observe.actualSavedTokens, 0, 'the observe column stays honest');
  assert.equal(
    acted.report.active.actualSavedTokens,
    observed.report.observe.potentialSavedTokens,
    'and the active column books exactly the saving both columns planned'
  );
  // The audit books the same plan in both modes, memo hit included: the reused form
  // keeps the provenance of the plan that composed it instead of degrading to "not
  // floored" just because its own lengths now satisfy the share.
  assert.equal(observed.records.length, 2, 'one record per payload, the second one the memo hit');
  assert.deepEqual(observed.records.map((record) => record.memoHit === true), [false, true], 'the second payload was answered from the memo');
  assert.deepEqual(
    observed.records.map((record) => [record.floorApplied, record.originalTokens, record.candidateTokens]),
    acted.records.map((record) => [record.floorApplied, record.originalTokens, record.candidateTokens]),
    'both modes book the same plan, provenance included'
  );
  assert.deepEqual(observed.records.map((record) => record.floorApplied), [true, true], 'the plan and its memo hit both carry the floor');
});

test('the observe column really has no latch of its own: mode changes the effect, never the plan', async () => {
  const run = async (mode: 'observe' | 'active') => {
    const engine = engineFor({ mode });
    const agent = fakeAgent({ id: `latch-${mode}` });
    const messages = [message('go')];
    for (let step = 1; step <= 6; step += 1) {
      await engine.preStep(stepPayload(agent, 1, step, messages), async () => ({ kind: 'enter' as const, messages }));
      await engine.toolResult(execOf('bash', { command: 'ls' }, agent), resultOf('ok'), async () => acceptOf(resultOf('ok')));
    }
    const report = engine.report();
    return { plans: report[mode].plans, applied: report[mode].applied, skips: report.skips, interventions: report.recent.length };
  };
  const observed = await run('observe');
  const acted = await run('active');
  assert.equal(observed.plans, acted.plans, 'one plan per detected step, in both modes');
  assert.equal(observed.plans, 1, 'the loop is detected once per turn');
  assert.equal(observed.interventions, acted.interventions);
  assert.equal(observed.skips['duplicate-intervention'], acted.skips['duplicate-intervention']);
  assert.equal(observed.applied, 0);
  assert.equal(acted.applied, 1);
});

test('a capability-only activation still gets the turn frame, the result pipeline, and its own budget', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({
        backend: 'mock',
        interventions: { mode: 'off', capabilities: { gate: 'active' }, maxInterventionsPerTurn: 1 }
      }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 40)),
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    // The gate reads results, and it needs the pre-step frame: without it the turn
    // never advances and the per-turn budget would never reset.
    assert.equal(installation.disposers.length, 4);
    let calls = 0;
    ctx.tools.register(
      defineTool({
        name: 'iv_gate_only',
        description: 'Test-only tool that always fails.',
        parameters: { command: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' as const },
          render: () => [{ type: 'text' as const, text: 'build failed' }]
        },
        async execute() {
          calls += 1;
          throw new Error('build failed');
        }
      })
    );
    const agent = fakeAgent({ id: 'gate-only' });
    const events = agentEvents(ctx, agent);
    const messages = [message('go')];
    const enter = (turn: number, step: number) =>
      events.waterfall(
        'agent/pre-step',
        { turn, step, signal: new AbortController().signal, messages } as never,
        async () => ({ kind: 'enter' as const, messages })
      );
    const failing = () =>
      ctx.tools.execute({
        callId: `gate-only-${calls}` as never,
        name: 'iv_gate_only',
        arguments: { command: 'npm run build' },
        signal: new AbortController().signal,
        agent
      });

    await enter(1, 1);
    const firstTurn: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) firstTurn.push(resultText(await failing()));
    // A second, different failing signature in the same turn is over the cap.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ctx.tools.execute({
        callId: `gate-only-other-${attempt}` as never,
        name: 'iv_gate_only',
        arguments: { command: 'npm test' },
        signal: new AbortController().signal,
        agent
      });
    }
    const report = installation.engine.report();
    assert.equal(report.active.applied, 1, 'one correction in the turn, exactly the cap');
    assert.ok(report.skips['intervention-cap'] >= 1, 'the second loop of the turn is refused by the cap');

    await enter(2, 1);
    for (let attempt = 0; attempt < 3; attempt += 1) await failing();
    const second = installation.engine.report();
    assert.equal(second.active.applied, 2, 'the pre-step reset the turn budget, so turn two intervenes again');
    assert.deepEqual(
      second.recent.map((record) => record.turn),
      [1, 2]
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a capability with a zero budget plans nothing and touches nothing', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({
        backend: 'mock',
        interventions: { mode: 'off', capabilities: { gate: 'active' }, maxJudgmentsPerTurn: 0 }
      }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 40)),
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    const agent = fakeAgent({ id: 'zero-budget' });
    const failing = resultOf('boom', true);
    const exec = execOf('bash', { command: 'node x' }, agent);
    let decision: PostToolDecision | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      decision = await installation.engine.toolResult(exec, failing, async () => acceptOf(failing));
    }
    assert.equal(decision!.kind, 'accept', 'the result is handed on unchanged');
    const report = installation.engine.report();
    assert.equal(report.active.applied, 0);
    assert.equal(report.active.plans, 0);
    assert.ok(report.skips['judgment-turn-cap'] >= 1, 'the detection happened, the judgment could not be bought');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a prune-only activation reduces across turns, and finds the original with the locator', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({ backend: 'mock', interventions: { mode: 'off', capabilities: { prune: 'active' } } })
        .interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 60)),
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    assert.equal(installation.disposers.length, 4, 'prune needs the turn frame and the result pipeline');
    const agent = fakeAgent({ id: 'prune-only' });
    const events = agentEvents(ctx, agent);
    const messages = [message('go')];
    await events.waterfall(
      'agent/pre-step',
      { turn: 1, step: 1, signal: new AbortController().signal, messages } as never,
      async () => ({ kind: 'enter' as const, messages })
    );

    const first = resultOf(LONG_RESULT);
    const decision = (await installation.engine.toolResult(execOf('bash', { command: 'a' }, agent), first, async () =>
      acceptOf(first)
    )) as { content: { type: string; text: string }[] };
    assert.ok(textOfContent(decision.content as never).length < LONG_RESULT.length);
    const record = installation.engine.report().recent[0]!;
    assert.equal(record.capability, 'prune');
    assert.ok(record.originalLocator);

    // A different payload is its own question, and is reduced too.
    const other = resultOf(`${LONG_RESULT}\nextra tail line`);
    await installation.engine.toolResult(execOf('bash', { command: 'b' }, agent), other, async () => acceptOf(other));
    const report = installation.engine.report();
    assert.equal(report.active.applied, 2);
    assert.equal(report.active.judgments, 2, 'two different payloads are two questions');
    assert.equal(report.active.memoHits, 0);
    assert.equal(installation.engine.report().skips['judgment-turn-cap'], undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a closing-only activation steers once per turn, and only on a real contradiction', async () => {
  const ctx = await createToolContext();
  try {
    const installation = installInterventions(ctx, {
      config: resolveConfig({
        backend: 'mock',
        interventions: { mode: 'off', capabilities: { closing: 'active' }, maxJudgmentsPerTurn: 1 }
      }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 40)),
      gate: gateStub('contradicted'),
      retain: retentionStub().retain
    });
    // The closing check needs the turn boundary, the stream it reads, and the
    // result pipeline that produces the failing evidence.
    assert.equal(installation.disposers.length, 6);
    assert.equal(installation.engine.serves('closing'), true);

    for (const turn of [1, 2]) {
      const steered: UserMessage[] = [];
      const agent = { ...fakeAgent({ id: `closing-only-${turn}` }), steer: (m: UserMessage) => steered.push(m) };
      installation.engine.observeAssistantStream({
        agent,
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Everything is green: all 12 tests passed.' } }
      });
      const failing = resultOf('2 failed, 10 passed', true);
      await installation.engine.toolResult(execOf('bash', { command: 'npm test' }, agent), failing, async () =>
        acceptOf(failing)
      );
      await installation.engine.turnStopping({ agent, turn });
      assert.equal(steered.length, 1, `turn ${turn} objected once`);
      // The episode is consumed: a second boundary call of the same turn adds none.
      await installation.engine.turnStopping({ agent, turn });
      assert.equal(steered.length, 1, `turn ${turn} did not repeat itself`);
    }
    assert.equal(installation.engine.report().active.applied, 2, 'one intervention per turn');

    // A backend that cannot decide is not a contradiction: nothing steers.
    const undecided = installInterventions(ctx, {
      config: resolveConfig({ backend: 'mock', interventions: { mode: 'active' } }).interventions,
      pruneThreshold: 100,
      stagnation: stagnationStub().service,
      prune: pruneStub((raw) => raw.slice(0, 40)),
      gate: gateStub('escalate'),
      retain: retentionStub().retain
    });
    const steered: UserMessage[] = [];
    const agent = { ...fakeAgent({ id: 'closing-escalate' }), steer: (m: UserMessage) => steered.push(m) };
    undecided.engine.observeAssistantStream({
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'All checks passed.' } }
    });
    const failing = resultOf('boom', true);
    await undecided.engine.toolResult(execOf('bash', { command: 'npm test' }, agent), failing, async () => acceptOf(failing));
    await undecided.engine.turnStopping({ agent, turn: 1 });
    assert.equal(steered.length, 0, 'an undecided backend fails open');
    assert.equal(undecided.engine.report().active.applied, 0);
    assert.equal(undecided.engine.report().skips['closing-undecided'], 1);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a decision never rewrites a decision that was already stricter, or already cancelled', async () => {
  const engine = engineFor({ mode: 'active' });
  const agent = fakeAgent({ id: 'monotone' });
  const exec = execOf('bash', { command: 'ls' }, agent);
  const ok = resultOf('ok');
  await engine.toolResult(exec, ok, async () => acceptOf(ok));
  await engine.toolResult(exec, ok, async () => acceptOf(ok));

  const cases = [
    { kind: 'ask', reason: 'needs approval', displayReason: 'Approve?' },
    { kind: 'deny', reason: 'policy', info: { name: 'PolicyError', code: 'E_POLICY', reason: 'blocked by policy' } },
    { kind: 'cancel' }
  ] as unknown as PreToolDecision[];
  for (const decision of cases) {
    const returned = await engine.toolCall(exec, async () => decision);
    assert.equal(returned, decision, `${(decision as { kind: string }).kind} is returned by identity`);
    if ((decision as { kind: string }).kind === 'deny') {
      assert.deepEqual((returned as { info?: unknown }).info, (decision as { info?: unknown }).info, 'its error information survives');
    }
  }

  // An aborted call and a failing backend are both let through untouched.
  const aborted = execOf('bash', { command: 'ls' }, agent);
  (aborted as { signal: AbortSignal }).signal = AbortSignal.abort();
  const allowed = { kind: 'allow' } as PreToolDecision;
  assert.equal(await engine.toolCall(aborted, async () => allowed), allowed);

  const broken = new InterventionEngine({
    config: resolveConfig({ backend: 'mock', interventions: { mode: 'active' } }).interventions,
    pruneThreshold: 100,
    stagnation: {
      check: async () => {
        throw new Error('backend down');
      }
    } as InterventionEngineOptions['stagnation'],
    prune: pruneStub((raw) => raw.slice(0, 40)),
    gate: gateStub('contradicted'),
    retain: retentionStub().retain
  });
  const agentBroken = fakeAgent({ id: 'monotone-broken' });
  const execBroken = execOf('bash', { command: 'ls' }, agentBroken);
  await broken.toolResult(execBroken, ok, async () => acceptOf(ok));
  await broken.toolResult(execBroken, ok, async () => acceptOf(ok));
  assert.equal(await broken.toolCall(execBroken, async () => allowed), allowed, 'a failed judgment never blocks a call');
  assert.ok(broken.report().skips['planning-error'] >= 1);
});

// ── the public retrieval API, and the turn's shared action ceiling ──────────

/** The package directory this test file was built into (`…/dist/…` → `…/dsh-reflex`). */
function packageDir(): string {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}

/** The entry the package's own `exports['.']` declares, resolved from its `package.json`. */
function declaredEntry(): string {
  const manifest = JSON.parse(readFileSync(path.join(packageDir(), 'package.json'), 'utf8')) as {
    exports?: { '.'?: { default?: string } };
  };
  const entry = manifest.exports?.['.']?.default;
  assert.ok(typeof entry === 'string' && entry.length > 0, 'the package declares a root entry');
  return path.join(packageDir(), entry);
}

test('the reader the guide documents is an export of the package root, and returns the retained original', async () => {
  // 1. Reached the way an installed consumer reaches it: a bare specifier from an
  //    isolated package root, with no knowledge of any internal module path.
  const scratch = path.join(packageDir(), '..', '..', 'tmp', `public-entry-${process.pid}`);
  const moduleRoot = path.join(scratch, 'node_modules');
  assert.equal(existsSync(path.join(packageDir(), 'node_modules', '@deepseek-ai')), true, 'the package can resolve its host deps');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(moduleRoot, { recursive: true });
  symlinkSync(packageDir(), path.join(moduleRoot, 'dsh-reflex'), 'dir');
  for (const dependency of ['@deepseek-ai', 'zod']) {
    const from = path.join(packageDir(), 'node_modules', dependency);
    if (existsSync(from)) symlinkSync(from, path.join(moduleRoot, dependency), 'dir');
  }
  const probePath = path.join(scratch, 'probe.mjs');
  writeFileSync(
    probePath,
    "import * as mod from 'dsh-reflex';\n" +
      'process.stdout.write(JSON.stringify({ reader: typeof mod.readPrunedOriginal,' +
      " locatorBuilder: typeof mod.pruneLocator, recordType: mod.PRUNED_ORIGINAL_RECORD_TYPE," +
      " tools: mod.reflexToolNames(mod.resolveConfig({ backend: 'mock' })) }));\n"
  );
  const probe = spawnSync(process.execPath, [probePath], { cwd: scratch, encoding: 'utf8' });
  rmSync(scratch, { recursive: true, force: true });
  assert.equal(probe.status, 0, `importing the package root by name works: ${probe.stderr}`);
  const surface = JSON.parse(probe.stdout) as { reader: string; locatorBuilder: string; recordType: string; tools: string[] };
  assert.equal(surface.reader, 'function', 'readPrunedOriginal is reachable from the package root');
  assert.equal(surface.locatorBuilder, 'function', 'and so is the locator builder a decision record needs');
  assert.equal(surface.recordType, PRUNED_ORIGINAL_RECORD_TYPE);
  assert.equal(surface.tools.length, 8, 'the public surface still advertises exactly the frozen eight tools');

  // 2. The same function through the declared entry, doing the real retrieval.
  const publicModule = (await import(pathToFileURL(declaredEntry()).href)) as { readPrunedOriginal?: typeof readPrunedOriginal };
  assert.equal(typeof publicModule.readPrunedOriginal, 'function', 'the declared root entry exposes it');
  assert.equal(publicModule.readPrunedOriginal, readPrunedOriginal, 'and it is the implementation the plugin itself uses');

  const ctx = await createToolContext();
  try {
    const runtime = applyReflex(ctx, { backend: 'mock', interventions: { mode: 'active' }, pruneThreshold: 200 });
    const session = Session.create('interventions-public-reader' as SessionId);
    const agent = { ...fakeAgent({ id: 'public-reader' }), session } as unknown as Agent;
    ctx.tools.register(
      defineTool({
        name: 'iv_public',
        description: 'Test-only tool returning a bulky result.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' as const },
          render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }]
        },
        async execute(args: { text: string }) {
          return args.text;
        }
      })
    );
    const result = await ctx.tools.execute({
      callId: 'iv-public-1' as never,
      name: 'iv_public',
      arguments: { text: REDUCIBLE_RESULT },
      signal: new AbortController().signal,
      agent
    });
    const installed = resultText(result);
    assert.ok(installed.length > 0 && installed.length < REDUCIBLE_RESULT.length, 'the result the model reads really shrank');
    const locator = interventionRecordsOf(session.ownEvents())[0]?.originalLocator;
    assert.ok(typeof locator === 'string' && locator.length > 0, 'the decision names the retained original');
    const retrieved = publicModule.readPrunedOriginal!(session.ownEvents(), locator!);
    assert.equal(retrieved?.text, REDUCIBLE_RESULT, 'the public reader returns the original byte for byte');
    assert.equal(retrieved?.chars, REDUCIBLE_RESULT.length);
    assert.equal(retrieved?.digest, digestOf(REDUCIBLE_RESULT));

    // 3. Retention is a log entry, never a message: the host marks it ignorable, no
    //    built-in event type interprets it — the payload type is outside the union
    //    the log's own events use — and no other event carries the payload.
    const retentionEvents = session.ownEvents().filter((event) => String(event.type) === PRUNED_ORIGINAL_RECORD_TYPE);
    assert.equal(retentionEvents.length, 1, 'the original is retained once');
    for (const event of retentionEvents) {
      assert.equal((event as { ignorable?: boolean }).ignorable, true, 'a retention record is an ignorable plugin event');
    }
    assert.equal(
      KNOWN_SESSION_EVENT_TYPES.has(PRUNED_ORIGINAL_RECORD_TYPE),
      false,
      'no built-in event type projects this record into a message'
    );
    for (const event of session.ownEvents()) {
      if (String(event.type) === PRUNED_ORIGINAL_RECORD_TYPE) continue;
      assert.equal(
        JSON.stringify(event).includes(REDUCIBLE_RESULT),
        false,
        `no model-visible event carries the original (${event.type})`
      );
    }
    const messages = [message('carry on')];
    const decision = (await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { turn: 1, step: 2, signal: new AbortController().signal, messages } as never,
      async () => ({ kind: 'enter' as const, messages })
    )) as { messages: unknown[] };
    assert.equal(decision.messages.length, 1, 'the step carries the loop’s own messages and nothing else');
    assert.equal(JSON.stringify(decision.messages).includes(REDUCIBLE_RESULT), false);
    assert.equal(runtime.interventions!.report().active.applied, 1);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a prune action is bound by the turn’s shared intervention ceiling, in both modes', async () => {
  const run = async (
    mode: 'observe' | 'active',
    cap: number
  ): Promise<{ plans: number; applied: number; memos: number; capSkips: number; booked: number; texts: string[] }> => {
    const engine = engineFor({ mode, maxInterventionsPerTurn: cap, capabilities: { prune: 'inherit' } }, {}, 200);
    const agent = fakeAgent({ id: `ceiling-${mode}-${cap}` });
    // The turn opens the way the loop opens it, so the ceiling is exercised inside a
    // real turn rather than in whatever state the engine happened to start in.
    await engine.preStep(stepPayload(agent, 1, 1), async () => ({ kind: 'enter', messages: [] }));
    const texts: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = resultOf(DEPENDENCY_TRACE);
      const decision = await engine.toolResult(execOf('bash', { command: 'build' }, agent), result, async () => acceptOf(result));
      texts.push(installedText(decision as { content?: unknown }));
    }
    const report = engine.report()[mode];
    return {
      plans: report.plans,
      applied: report.applied,
      memos: report.memoHits,
      capSkips: engine.report().skips['intervention-cap'] ?? 0,
      booked: engine.stateOf(`ceiling-${mode}-${cap}`)!.interventions,
      texts
    };
  };

  for (const mode of ['observe', 'active'] as const) {
    const none = await run(mode, 0);
    assert.equal(none.plans, 0, `${mode} plans nothing when the turn allows no action`);
    assert.equal(none.applied, 0);
    assert.equal(none.booked, 0, `${mode} books nothing either`);
    assert.equal(none.capSkips, 4, 'every payload is refused by the ceiling, not silently planned');
    for (const text of none.texts) assert.equal(text, DEPENDENCY_TRACE, `${mode} hands each payload back untouched`);

    const one = await run(mode, 1);
    assert.equal(one.plans, 1, `${mode} plans at most one action per turn`);
    assert.equal(one.applied, mode === 'active' ? 1 : 0);
    assert.equal(one.booked, 1);
    assert.equal(one.capSkips, 3);
    assert.equal(one.texts[0] === DEPENDENCY_TRACE, mode === 'observe', `${mode} installs only what its mode allows`);
    for (const text of one.texts.slice(1)) assert.equal(text, DEPENDENCY_TRACE, 'a refused payload passes through untouched');

    const two = await run(mode, 2);
    assert.equal(two.plans, 2, 'the second action is the one the ceiling still allows');
    assert.equal(two.booked, 2);
    assert.ok(two.memos >= 1, 'a memo hit is an action too, and it draws on the same allowance');
    assert.equal(two.capSkips, 2);
  }
});

test('the ceiling is shared with the other capabilities, and the next turn gets a fresh one', async () => {
  const steered: UserMessage[] = [];
  const agent = { ...fakeAgent({ id: 'shared-ceiling' }), steer: (m: UserMessage) => steered.push(m) };
  const engine = engineFor(
    {
      mode: 'active',
      maxInterventionsPerTurn: 1,
      capabilities: { prune: 'inherit', closing: 'inherit', gate: 'off', stagnation: 'off' }
    },
    {},
    200
  );
  const claim = 'Verification: all 12 tests passed and the build is green.';

  // Turn 1: the reduction takes the turn's only action slot…
  await engine.preStep(stepPayload(agent, 1, 1), async () => ({ kind: 'enter', messages: [] }));
  const bulky = resultOf(DEPENDENCY_TRACE);
  const reduced = await engine.toolResult(execOf('bash', { command: 'build' }, agent), bulky, async () => acceptOf(bulky));
  assert.ok(installedText(reduced as { content?: unknown }).length < DEPENDENCY_TRACE.length, 'the reduction was installed');
  assert.equal(engine.stateOf('shared-ceiling')!.interventions, 1);

  // …so the closing check of the same turn has nothing left to spend, and must not steer.
  engine.observeAssistantStream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: claim } } });
  const failed = resultOf('2 failed, 10 passed', true);
  await engine.toolResult(execOf('bash', { command: 'npm test' }, agent), failed, async () => acceptOf(failed));
  await engine.turnStopping({ agent, turn: 1 });
  assert.deepEqual(steered, [], 'a spent turn is not steered');
  assert.ok((engine.report().skips['intervention-cap'] ?? 0) >= 1, 'the closing check was refused by the shared ceiling');
  assert.equal(engine.report().recent.some((record) => record.capability === 'closing'), false, 'and it planned nothing');

  // Turn 2: the allowance resets, so the same turn shape can act again.
  await engine.preStep(stepPayload(agent, 2, 1), async () => ({ kind: 'enter', messages: [] }));
  assert.equal(engine.stateOf('shared-ceiling')!.interventions, 0, 'the next turn starts with a fresh allowance');
  engine.observeAssistantStream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: claim } } });
  const failedAgain = resultOf('1 failed, 11 passed', true);
  await engine.toolResult(execOf('bash', { command: 'npm test' }, agent), failedAgain, async () => acceptOf(failedAgain));
  await engine.turnStopping({ agent, turn: 2 });
  assert.equal(steered.length, 1, 'the next turn has room, and the objection is made');
});

test('a retention that fails books no action and leaves the allowance for the next payload', async () => {
  const sink = retentionStub();
  let calls = 0;
  const engine = engineFor(
    { mode: 'active', maxInterventionsPerTurn: 1, capabilities: { prune: 'inherit' } },
    { retain: (session, request) => (calls++ === 0 ? undefined : sink.retain(session, request)) },
    200
  );
  const agent = fakeAgent({ id: 'retention-quota' });
  const first = resultOf(`${DEPENDENCY_TRACE}\nfirst payload`);
  const second = resultOf(`${DEPENDENCY_TRACE}\nsecond payload`);

  const kept = await engine.toolResult(execOf('bash', { command: 'build' }, agent), first, async () => acceptOf(first));
  assert.equal(installedText(kept as { content?: unknown }), textOfContent(first.content as never), 'an unrestorable payload is handed back untouched');
  assert.equal(engine.stateOf('retention-quota')!.interventions, 0, 'a failed retention books no action');
  assert.equal(engine.report().active.plans, 0, 'and plans nothing');
  assert.ok((engine.report().skips['retention-failed'] ?? 0) >= 1);

  const acted = await engine.toolResult(execOf('bash', { command: 'build' }, agent), second, async () => acceptOf(second));
  const installed = installedText(acted as { content?: unknown });
  assert.ok(installed.length < textOfContent(second.content as never).length, 'the next payload still has the turn’s allowance');
  assert.equal(engine.stateOf('retention-quota')!.interventions, 1);
  assert.equal(engine.report().active.applied, 1);
});
