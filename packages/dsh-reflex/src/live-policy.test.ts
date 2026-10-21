import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import LlmRuntime, { type LlmCallConfig } from '@deepseek-ai/dsh-llm';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';

import type { ReflexRuntime } from './bridge.js';
import { Config, type ReflexConfig } from './config.js';
import { EffortInterceptor } from './effort.js';
import { applyReflex, inject, name } from './index.js';
import { buildPanelSnapshot } from './panel-api.js';
import { panelFacts } from './panel-mount.js';
import {
  dispatchAgentRequest,
  fakeAgent,
  registerPhysicalAdapter,
  resultText
} from './testing.js';

/**
 * Live policy: `effort.*` and `interventions.*` edited through a *real* loader
 * config-only commit.
 *
 * The loader marks these blocks `volatile`, so a settings save commits the new
 * values into the running fiber and dispatches `loader/volatile-update` without
 * remounting the plugin. These tests mount through the real loader (this module
 * is the entry the loader imports), commit the way the loader does, and assert
 * at production seams: the next rewritten request, the next tool call through
 * the registry, the listener count, the panel snapshot, and the schema-resolve
 * counter. Nothing is asserted at an internal of the interceptor or the engine
 * except the numbers those seams publish.
 */

export { Config, inject, name };

/** Real remounts of this module (the loader calls {@link apply}). */
let loaderApplies = 0;
/** Runtime of the last loader-applied activation. */
let loaderRuntime: ReflexRuntime | undefined;

/**
 * The plugin callback the loader invokes; counts real applies so every test can
 * prove a config-only save did *not* restart the plugin.
 * @param ctx - the entry's context.
 * @param config - the loader-resolved config (volatile references included).
 */
export function apply(ctx: Context, config?: ReflexConfig): void {
  loaderApplies += 1;
  loaderRuntime = applyReflex(ctx, config);
}

/**
 * Commit one freshly resolved config block into the live volatile reference,
 * exactly as the loader's `updateVolatile` does: `target[write](source.get())`.
 * @param live - the reference currently held by the running fiber.
 * @param next - a reference resolved from the next authored config.
 */
function commitVolatile(live: unknown, next: { get: () => unknown }): void {
  const reference = live as Record<symbol, unknown> & { get?: unknown };
  const write = Object.getOwnPropertySymbols(reference).find((key) => typeof reference[key] === 'function');
  assert.ok(write, 'a schema-declared volatile block must expose its commit function');
  (reference[write] as (value: unknown) => void)(next.get());
}

/** One loader-mounted activation under test. */
interface LiveHost {
  ctx: Context;
  runtime: ReflexRuntime;
  /** Commit an authored config the way a real config-only save does. */
  commit(next: ReflexConfig): void;
  dispose(): Promise<void>;
}

/**
 * Boot the real Host services and mount this module through the real Cordis
 * loader, then expose the exact commit path a settings save takes.
 * @param authored - the authored deployment config.
 * @returns the mounted activation.
 */
async function bootLoader(authored: ReflexConfig): Promise<LiveHost> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href });

  loaderApplies = 0;
  loaderRuntime = undefined;
  const id = await ctx.loader.create({ name: './live-policy.test.js', config: authored });
  await ctx.loader.await();

  const entry = ctx.loader.resolve(id);
  const runtime = loaderRuntime;
  assert.ok(runtime, 'the loader applied the plugin and exposed its runtime');
  assert.equal(entry.fiber?.state, 2, 'the mounted plugin is active');

  return {
    ctx,
    runtime,
    commit(next: ReflexConfig): void {
      const resolved = Config(next) as unknown as Record<string, { get(): unknown }>;
      const live = entry.fiber!.config as unknown as Record<string, unknown>;
      for (const key of Object.keys(resolved)) commitVolatile(live[key], resolved[key]!);
      const self = Object.create(entry.fiber!.ctx) as Record<symbol, unknown>;
      self[Context.filter] = (owner: { fiber?: unknown }) => owner.fiber === entry.fiber;
      entry.fiber!.ctx.emit(self, 'loader/volatile-update', [Object.keys(next)] as never);
    },
    dispose: () => ctx.fiber.dispose()
  };
}

/** A real session, so a prune's retention sink can verify what it kept. */
function agentWithSession(id: string): Agent {
  const session = Session.create(id as unknown as SessionId);
  return { ...fakeAgent({ id }), session } as unknown as Agent;
}

/** The physical route used by the effort tests. */
const THINKING = { models: ['reasoner'], reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'low' };

const TASK_DEEP = 'design the migration protocol for the distributed store';
/** No cue words at all: System 1 ties, so the cue fallback picks the level. */
const TASK_NEUTRAL = 'qwerty zxcv';

const POOLS: ReflexConfig['routing'] = {
  models: { 'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'reasoning target' }] }
};

// ── effort ─────────────────────────────────────────────────────────────────

test('effort.enabled and reasoningEffort edits take effect on the very next request', async () => {
  const host = await bootLoader({
    backend: 'mock',
    routing: POOLS,
    effort: { reasoningEffort: 'reflex', enabled: true, fallback: 'medium', minConfidence: 0.3 }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'live-effort' });
    const request = { provider: 'reflex', model: 'reflex-auto' };

    // The selector seam: with setting=reflex the virtual route is armed.
    const armed = await host.ctx.llm.resolveCallConfig(request as LlmCallConfig);
    assert.equal(armed.reasoningEffort, 'reflex', 'the deployment marker arms the virtual route');

    const before = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 1, config: request });
    assert.equal(before.reasoningEffort, 'high', 'the positive control: the marker is decided');
    const decisions = () => host.runtime.ledger.getEntries().filter((entry) => entry.type === 'effort-decision').length;
    assert.equal(decisions(), 1);

    // Save `effort.enabled: false` — no remount.
    host.commit({ backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex', enabled: false } });
    assert.equal(loaderApplies, 1, 'the plugin fiber never restarts');
    assert.equal(host.runtime.effort.enabled, false, 'the live interceptor reads the new switch');
    assert.equal(buildPanelSnapshot(panelFacts(host.runtime)).effort.enabled, false, 'the panel reports the new switch');

    const off = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 2, config: request });
    assert.deepEqual(off, { provider: 'deepseek', model: 'reasoner' }, 'a switched-off layer leaves no effort key at all');
    assert.equal(decisions(), 1, 'a switched-off layer spends no decision');

    // Save `reasoningEffort: ""` while enabled: a deployment with no policy.
    host.commit({ backend: 'mock', routing: POOLS, effort: { enabled: true } });
    assert.equal(host.runtime.effort.setting, undefined, 'the live interceptor reads the cleared marker');
    const snapshot = buildPanelSnapshot(panelFacts(host.runtime));
    assert.equal(snapshot.effort.setting, null, 'the panel reports the cleared marker');
    assert.equal(snapshot.effort.enabled, true);

    const disarmed = await host.ctx.llm.resolveCallConfig(request as LlmCallConfig);
    assert.equal(disarmed.reasoningEffort, undefined, 'a bare virtual request is no longer armed');

    const cleared = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 3, config: request });
    assert.deepEqual(cleared, { provider: 'deepseek', model: 'reasoner' }, 'a deployment with no marker writes no effort key');
    assert.equal(decisions(), 1, 'still no decision was taken');
  } finally {
    await host.dispose();
  }
});

test('an edited effort.fallback is the level the very next undecided turn uses', async () => {
  const host = await bootLoader({
    backend: 'mock',
    routing: POOLS,
    // The high floor makes System 1 unusable on purpose, so the next turn is
    // decided by the cue fallback — the value the edit changes.
    effort: { reasoningEffort: 'reflex', fallback: 'medium', minConfidence: 0.9 }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'live-fallback' });
    const request = { provider: 'reflex', model: 'reflex-auto' };

    const medium = await dispatchAgentRequest(host.ctx, agent, { task: TASK_NEUTRAL, turn: 1, config: request });
    assert.equal(medium.reasoningEffort, 'medium', 'the neutral turn falls back to the configured level');
    const firstStatus = host.runtime.effortStatus('live-fallback');
    assert.equal(firstStatus?.source, 'cue-fallback', 'the decision is the fail-safe, not System 1');

    host.commit({
      backend: 'mock',
      routing: POOLS,
      effort: { reasoningEffort: 'reflex', fallback: 'high', minConfidence: 0.9 }
    });
    const high = await dispatchAgentRequest(host.ctx, agent, { task: TASK_NEUTRAL, turn: 2, config: request });
    assert.equal(high.reasoningEffort, 'high', 'the next undecided turn uses the edited fallback');
    assert.equal(host.runtime.effort.fallback, 'high', 'the interceptor itself reads the new value');
  } finally {
    await host.dispose();
  }
});

test('an edited effort.minConfidence changes the decision source on the next request', async () => {
  const host = await bootLoader({
    backend: 'mock',
    routing: POOLS,
    effort: { reasoningEffort: 'reflex', minConfidence: 0.3 }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const agent = fakeAgent({ id: 'live-min-confidence' });
    const request = { provider: 'reflex', model: 'reflex-auto' };

    const trusted = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 1, config: request });
    assert.equal(trusted.reasoningEffort, 'high');
    assert.equal(host.runtime.effortStatus('live-min-confidence')?.source, 'system-one', 'the positive control trusts System 1');

    host.commit({ backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex', minConfidence: 0.9 } });
    const rejected = await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 2, config: request });
    assert.equal(rejected.reasoningEffort, 'high', 'the cue vote still lands on high for a deep task');
    const status = host.runtime.effortStatus('live-min-confidence');
    assert.equal(status?.source, 'cue-fallback', 'but System 1 is no longer trusted');
    assert.match(status?.degradedReason ?? '', /below the floor/);
    assert.equal(host.runtime.effort.minConfidence, 0.9, 'the interceptor reads the new floor');
  } finally {
    await host.dispose();
  }
});

test('an edited effort.minConfidence re-runs the adaptive decision instead of reusing the old floor', async () => {
  const interceptor = new EffortInterceptor({
    setting: 'reflex',
    enabled: true,
    fallback: 'medium',
    minConfidence: 0.3,
    backendName: 'stub',
    decide: async () => ({
      options: [{ label: 'low minimal thinking: rename typo', probability: 0.5 }],
      bestOption: 'low minimal thinking: rename typo',
      confidence: 0.5,
      latencyMs: 0,
      uncalibrated: true
    })
  });
  const context = {
    requested: 'reflex' as const,
    target: { provider: 'physical', model: 'target' },
    probe: async () => ({ kind: 'declared' as const, efforts: ['off', 'low', 'medium', 'high'] }),
    task: 'implement the handler',
    agent: { agentId: 'unit-min-confidence' },
    turn: 1,
    step: 1,
    requestedProvider: 'physical',
    requestedModel: 'target'
  };
  const trusted = await interceptor.resolve(context);
  assert.equal(trusted.effort, 'low', 'a 0.5 answer clears the 0.3 floor');
  assert.equal(trusted.status?.source, 'system-one');

  interceptor.updatePolicy({ enabled: true, setting: 'reflex', fallback: 'medium', minConfidence: 0.6 });
  assert.equal(interceptor.generation, 1, 'every policy update bumps the generation');

  const rejected = await interceptor.resolve(context);
  assert.equal(rejected.effort, 'medium', 'the 0.5 answer is rejected and the cue vote decides');
  assert.equal(rejected.status?.source, 'cue-fallback');
  assert.match(rejected.status?.degradedReason ?? '', /below the floor/);
});

// ── interventions ──────────────────────────────────────────────────────────

const STAGNATION_ACTIVE: ReflexConfig = {
  backend: 'mock',
  routing: { enabled: false },
  interventions: {
    mode: 'active',
    capabilities: { stagnation: 'active', prune: 'off', gate: 'off', closing: 'off' }
  }
};

/** Register one counted probe tool that returns its argument verbatim. */
function registerProbe(ctx: Context, nameOfTool: string): { runs: string[] } {
  const runs: string[] = [];
  ctx.tools.register(
    defineTool({
      name: nameOfTool,
      description: 'Test-only probe for live intervention policy.',
      parameters: { text: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }]
      },
      async execute(args: { text: string }) {
        runs.push(args.text);
        return args.text;
      }
    })
  );
  return { runs };
}

/** Execute one probe call attributed to an agent. */
async function callProbe(ctx: Context, tool: string, agent: Agent, text: string, id: number): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `${tool}-${id}` as never,
    name: tool,
    arguments: { text },
    signal: new AbortController().signal,
    agent
  });
}

test('mode and capability edits add and remove the listeners, and the next call obeys them', async () => {
  const host = await bootLoader(STAGNATION_ACTIVE);
  try {
    const tool = 'livepol_probe';
    const { runs } = registerProbe(host.ctx, tool);
    let call = 0;
    const callAgent = (agent: Agent) => callProbe(host.ctx, tool, agent, 'ls', ++call);

    assert.equal(host.runtime.interventionListenerCount, 4, 'frame + result pipeline, closing off');

    // active: the third identical call is refused.
    const activeAgent = fakeAgent({ id: 'live-active' });
    assert.equal((await callAgent(activeAgent)).isError, false);
    assert.equal((await callAgent(activeAgent)).isError, false);
    const denied = await callAgent(activeAgent);
    assert.equal(denied.isError, true, 'active refuses the repeated call');
    assert.match(resultText(denied), /Reflex intervention/);
    assert.equal(runs.length, 2, 'the refused call never ran');
    assert.equal(host.runtime.interventions!.report().active.applied, 1);

    // mode=off: zero listeners and no audit at all.
    host.commit({ backend: 'mock', routing: { enabled: false }, interventions: { mode: 'off' } });
    assert.equal(loaderApplies, 1, 'still no remount');
    assert.equal(host.runtime.interventionListenerCount, 0, 'off is zero listeners, not a flag');
    assert.equal(host.runtime.interventions!.enabled, false);
    const recents = host.runtime.interventions!.report().recent.length;
    const skips = JSON.stringify(host.runtime.interventions!.report().skips);

    const offAgent = fakeAgent({ id: 'live-off' });
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await callAgent(offAgent)).isError, false, 'off never refuses a call');
    }
    assert.equal(host.runtime.interventions!.report().recent.length, recents, 'off records no decision');
    assert.equal(JSON.stringify(host.runtime.interventions!.report().skips), skips, 'off records no skip');

    // observe: detection comes back, execution does not.
    host.commit({ backend: 'mock', routing: { enabled: false }, interventions: { mode: 'observe' } });
    assert.equal(host.runtime.interventionListenerCount, 6, 'frame + pipeline + closing are back');
    const observeAgent = fakeAgent({ id: 'live-observe' });
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await callAgent(observeAgent)).isError, false, 'observe never refuses');
    }
    const observed = host.runtime.interventions!.report();
    assert.equal(observed.recent.at(-1)?.capability, 'stagnation', 'observe writes the decision record');
    assert.equal(observed.recent.at(-1)?.action, 'deny-call');
    assert.equal(observed.recent.at(-1)?.applied, false, 'observe applied nothing');
    assert.ok(observed.observe.plans >= 1, 'the observe column records the plan');
    assert.equal(observed.active.applied, 1, 'the earlier active refusal is still its own account');

    // active again, with a raised repeat threshold: 3 is no longer a loop, 5 is.
    host.commit({
      backend: 'mock',
      routing: { enabled: false },
      interventions: {
        mode: 'active',
        capabilities: { stagnation: 'active', prune: 'off', gate: 'off', closing: 'off' },
        repeatThreshold: 5
      }
    });
    assert.equal(host.runtime.interventions!.config.repeatThreshold, 5, 'the engine reads the live threshold');
    const thresholdAgent = fakeAgent({ id: 'live-threshold' });
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await callAgent(thresholdAgent)).isError, false, `call ${index + 1} is below the new threshold`);
    }
    const fifth = await callAgent(thresholdAgent);
    assert.equal(fifth.isError, true, 'the fifth identical call is refused');

    const panel = buildPanelSnapshot(panelFacts(host.runtime));
    assert.equal(panel.interventions.mode, 'active');
    assert.equal(panel.interventions.enabled, true);
    assert.deepEqual(panel.interventions.capabilities, {
      stagnation: 'active',
      prune: 'off',
      gate: 'off',
      closing: 'off'
    }, 'the panel reports the effective modes');
  } finally {
    await host.dispose();
  }
});

test('a capability switched off then on, and a raised prune threshold, drive the next result', async () => {
  const host = await bootLoader({
    backend: 'mock',
    routing: { enabled: false },
    interventions: {
      mode: 'active',
      capabilities: { stagnation: 'off', prune: 'off', gate: 'off', closing: 'off' }
    },
    pruneThreshold: 500
  });
  try {
    const tool = 'livepol_prune';
    registerProbe(host.ctx, tool);
    let call = 0;
    const callAgent = (agent: Agent) => callProbe(host.ctx, tool, agent, LONG, ++call);

    assert.equal(host.runtime.interventionListenerCount, 0, 'every capability off installs nothing');

    // prune on: the next oversized result reaches the pruning decision.
    host.commit({
      backend: 'mock',
      routing: { enabled: false },
      interventions: {
        mode: 'active',
        capabilities: { stagnation: 'off', prune: 'active', gate: 'off', closing: 'off' }
      },
      pruneThreshold: 500
    });
    assert.equal(host.runtime.interventionListenerCount, 4, 'the pipeline is installed for prune');
    const pruneAgent = agentWithSession('live-prune');
    const pruned = await callAgent(pruneAgent);
    assert.equal(pruned.isError, false);
    const report = host.runtime.interventions!.report();
    assert.equal(report.skips['below-threshold'] ?? 0, 0, 'the payload is above the live threshold');
    assert.ok(report.recent.length > 0 || Object.keys(report.skips).length > 0, 'the pruning decision was audited');
    assert.notEqual(resultText(pruned), LONG, 'the oversized payload was reduced while retention was available');

    // Raise the threshold past the payload: the same result must now be left alone.
    host.commit({
      backend: 'mock',
      routing: { enabled: false },
      interventions: {
        mode: 'active',
        capabilities: { stagnation: 'off', prune: 'active', gate: 'off', closing: 'off' },
        pruneJudgeMinChars: 20000
      },
      pruneThreshold: 20000
    });
    assert.equal(host.runtime.effectiveConfig.pruneThreshold, 20000, 'the runtime reports the live threshold');
    assert.equal(buildPanelSnapshot(panelFacts(host.runtime)).plugin.pruneThreshold, 20000, 'and so does the panel');
    const untouched = await callAgent(agentWithSession('live-prune-raised'));
    assert.equal(resultText(untouched), LONG, 'a below-threshold payload is byte-identical');
    assert.ok(
      (host.runtime.interventions!.report().skips['below-threshold'] ?? 0) >= 1,
      'the skip names the live threshold as the reason'
    );
  } finally {
    await host.dispose();
  }
});

// ── hot-path cost ──────────────────────────────────────────────────────────

test('the unchanged hot path compares snapshots and never re-runs the schema', async (t) => {
  const host = await bootLoader({
    backend: 'mock',
    routing: POOLS,
    effort: { reasoningEffort: 'reflex' },
    interventions: { mode: 'observe' }
  });
  try {
    registerPhysicalAdapter(host.ctx, 'deepseek', THINKING);
    const runtime = host.runtime;
    const resolveCount = (): number => runtime.configResolveCount;

    // Warm-up, then 2,000 unchanged pre-step checks: exactly what a step adds.
    for (let index = 0; index < 50; index += 1) assert.equal(runtime.refreshIfChanged(), false);
    const checkStarted = performance.now();
    for (let index = 0; index < 2000; index += 1) runtime.refreshIfChanged();
    const checkUs = ((performance.now() - checkStarted) * 1000) / 2000;

    // A full request also goes through the same lazy check, still unparsed.
    const agent = fakeAgent({ id: 'live-cost' });
    await dispatchAgentRequest(host.ctx, agent, { task: TASK_DEEP, turn: 1, config: { provider: 'reflex', model: 'reflex-auto' } });
    assert.equal(resolveCount(), 0, 'no schema resolution happened without a committed change');

    // Getter-only hot reads: the effort policy and intervention thresholds.
    const readStarted = performance.now();
    for (let index = 0; index < 2000; index += 1) {
      void runtime.effort.enabled;
      void runtime.effort.fallback;
      void runtime.effort.minConfidence;
      void runtime.interventions?.config.repeatThreshold;
      void runtime.effectiveConfig.pruneThreshold;
    }
    const readUs = ((performance.now() - readStarted) * 1000) / 2000;

    // One real commit: exactly one schema resolution, then quiet again.
    host.commit({ backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex', enabled: true } });
    assert.equal(resolveCount(), 1, 'one commit, one schema run');
    for (let index = 0; index < 2000; index += 1) runtime.refreshIfChanged();
    assert.equal(resolveCount(), 1, 'unchanged checks after the commit still parse nothing');

    t.diagnostic(`refreshIfChanged: ${checkUs.toFixed(3)} µs/call; live getters: ${readUs.toFixed(3)} µs/call; schema parses: ${resolveCount()}`);
    assert.ok(checkUs < 50, `snapshot check must stay cheap (got ${checkUs.toFixed(3)} µs)`);
    assert.ok(readUs < 20, `live reads must stay cheap (got ${readUs.toFixed(3)} µs)`);
  } finally {
    await host.dispose();
  }
});

/** A bulky, line-oriented payload the pruner can actually reduce. */
const LONG = [
  '# build log',
  ...Array.from({ length: 25 }, (_, index) => `[===] progress ${String(index).padStart(3, '0')} ${'x'.repeat(90)}`),
  ...Array.from({ length: 20 }, (_, index) => `  at node_modules/pkg-${index}/index.js:${index + 1}:1`),
  'FAIL src/thing.test.js',
  '  AssertionError: expected 3 to equal 4',
  'ℹ tests 9',
  'ℹ fail 1'
].join('\n');
