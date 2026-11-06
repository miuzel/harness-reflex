import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import SessionRuntime, { Session, type SessionId } from '@deepseek-ai/dsh-session';
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';

import { applyReflex } from './index.js';
import type { ReflexConfig } from './config.js';
import {
  createToolContext,
  fakeAgent,
  registerPhysicalAdapter,
  userMessage
} from './testing.js';

/**
 * Subagent delegation vs. the adaptive effort marker (g-048).
 *
 * `executor.reasoning_effort: "reflex"` on a delegated agent used to fail on the
 * first step, because the *plugin* rewrote the reasoning effort inside the
 * `agent/request` waterfall — a contract `dsh-agent-loop` refuses:
 *
 *   proposed reasoning effort "low" after step preparation fixed "reflex";
 *   use agent.model.select() before step preparation
 *
 * The fix (C1) moves the decision one layer earlier: the child Session's own
 * `model/selection` marker is rewritten *before* the next step reads it, so the
 * loop's fixed selection already carries the level the request will send.
 *
 * These tests drive the real Session log, the real selection projection, and a
 * re-creation of the loop's post-waterfall validation. The validation is the
 * production contract copied verbatim from `dsh-agent-loop`
 * (`prepareRequest`, "use agent.model.select() before step preparation"); it is
 * reproduced here because the loop service itself is not part of this plugin's
 * test composition. A green run therefore means "the loop would not throw",
 * not "we asserted our own helper against itself".
 */

/** Reasoning vocabulary of the fake physical route used below. */
const PHYSICAL = { models: ['reasoner'], reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };

/** One virtual model over one physical target: routing stays deterministic. */
const POOLS: ReflexConfig['routing'] = {
  models: { 'reflex-auto': [{ provider: 'deepseek', model: 'reasoner', description: 'hard reasoning math' }] }
};

/** The reported deployment: a delegated agent inherits the `reflex` marker. */
const ADAPTIVE: ReflexConfig = { backend: 'mock', routing: POOLS, effort: { reasoningEffort: 'reflex' } };

/** Branded effort text, as the loop's config carries it. */
function effort(value: string): LlmCallConfig['reasoningEffort'] {
  return value as unknown as LlmCallConfig['reasoningEffort'];
}

/** The selection projection `dsh-agent` registers, re-created for a bare session. */
const selectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional()
  })
  .nullable();

const modelSelectionProjection = {
  key: 'modelSelection',
  stateVersion: 3,
  stateSchema: z.object({ lastUsed: selectionSchema, pending: selectionSchema }),
  init: () => ({ lastUsed: null, pending: null }),
  apply(state: { lastUsed: unknown; pending: unknown }, event: { type: string; data?: any }) {
    const same = (a: any, b: any) =>
      a === b ||
      (a && b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort);
    if (event.type === 'model/selection') return same(state.pending, event.data) ? state : { ...state, pending: event.data };
    if (event.type !== 'request/header') return state;
    const config = event.data?.header?.config;
    const lastUsed = config ? { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) } : null;
    const pending = same(state.pending, lastUsed) ? null : state.pending;
    return same(state.lastUsed, lastUsed) && pending === state.pending ? state : { lastUsed, pending };
  }
};

/** Boot a host whose sessions are real and whose selection projection is registered. */
async function withDelegatedHost<T>(
  config: ReflexConfig,
  body: (host: {
    ctx: Context;
    runtime: ReturnType<typeof applyReflex>;
    parent: Session;
    child: Session;
    step(agent: Agent, session: Session): Promise<LlmCallConfig>;
    current(session: Session): LlmCallConfig | undefined;
  }) => Promise<T>
): Promise<T> {
  const ctx = await createToolContext();
  await ctx.plugin(SessionRuntime);
  let runtime: ReturnType<typeof applyReflex> | undefined;
  runtime = applyReflex(ctx, config);
  registerPhysicalAdapter(ctx, 'deepseek', { models: PHYSICAL.models, reasoningEfforts: PHYSICAL.reasoningEfforts, defaultEffort: 'medium' });

  const parent = ctx.sessions.create('main-1' as SessionId);
  const child = ctx.sessions.create('sub-1' as SessionId, {
    meta: { origin: 'subagent', delegationDepth: 1, parentSession: 'main-1' as SessionId }
  });

  /**
   * Fold the session's `model/selection` events the way the host projection does.
   *
   * The check runs here is the contract, not the storage: `AgentModel.current()`
   * returns `pending ?? lastUsed`, and `pending` is the newest `model/selection`
   * that no matching `request/header` retired. A test that folded the log
   * differently from the host would prove nothing about the loop.
   * @param session - the agent's session.
   * @returns the selection `model.current()` would return, or undefined.
   */
  const current = (session: Session): LlmCallConfig | undefined => {
    let state: any = { lastUsed: null, pending: null };
    for (const event of session.snapshotEvents()) state = (modelSelectionProjection.apply as any)(state, event);
    return (state.pending ?? state.lastUsed ?? undefined) as LlmCallConfig | undefined;
  };

  /**
   * Drive one step the way `dsh-agent-loop` does, including its hard check.
   *
   * `preStep` reads `model.current()` BEFORE the `agent/pre-step` waterfall, then
   * `prepareRequest` seeds the `agent/request` waterfall with that same selection
   * and rejects any config whose effort differs. Both facts are reproduced here,
   * in that order, because together they are what made the reported failure
   * unavoidable: by the time the request waterfall ran, the effort was already
   * fixed and no plugin could still change it.
   * @param agent - the requesting agent.
   * @param session - the agent's session, whose selection the loop fixes.
   * @returns the config the request waterfall produced.
   */
  const step = async (agent: Agent, session: Session): Promise<LlmCallConfig> => {
    const events = agentEvents(ctx, agent);
    const signal = new AbortController().signal;
    const messages = [userMessage('design the migration protocol')];
    // 1. The loop fixes this step's selection before any plugin hook runs.
    const fixed = current(session);
    if (fixed === undefined) throw new Error(`agent "${agent.id}" has no provider/model`);
    const selection: LlmCallConfig = fixed;
    // 2. The pre-step waterfall sees that same selection.
    await events.waterfall(
      'agent/pre-step',
      { turn: 1, step: 1, signal, messages, modelSelection: selection },
      async () => ({ kind: 'enter' as const, messages })
    );
    // 3. The request waterfall may only re-route, never re-decide the effort.
    const seedConfig = { ...selection };
    const proposed = await events.waterfall('agent/request', { turn: 1, step: 1, signal }, async () => seedConfig);
    if (proposed.provider !== selection.provider || proposed.model !== selection.model) {
      throw new Error(`agent "${agent.id}": agent/request proposed route after step preparation fixed it`);
    }
    if (proposed.reasoningEffort !== selection.reasoningEffort) {
      throw new Error(
        `agent "${agent.id}": agent/request proposed reasoning effort "${proposed.reasoningEffort ?? 'adapter default'}" ` +
          `after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`
      );
    }
    return proposed;
  };

  try {
    return await body({ ctx, runtime: runtime!, parent, child, step, current });
  } finally {
    await ctx.fiber.dispose();
  }
}

/** The child agent shape the loop would hand to both waterfalls. */
function childAgent(child: Session): Agent {
  const agent = fakeAgent({ id: child.id, origin: 'subagent', delegationDepth: 1 });
  (agent as any).session = child;
  return agent;
}

/** The parent agent shape. */
function parentAgent(parent: Session): Agent {
  const agent = fakeAgent({ id: parent.id });
  (agent as any).session = parent;
  return agent;
}

/** Read the plugin records this fix writes to child sessions. */
function inheritRecords(session: Session): any[] {
  const records: any[] = [];
  for (const event of session.snapshotEvents()) {
    if ((event.type as string) !== 'plugin:dsh-reflex/effort-inherit') continue;
    records.push((event as any).data);
  }
  return records;
}

test('g-048: delegated agent with the reflex marker no longer fails the loop effort contract', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ child, parent, step }) => {
    // The parent is on a concrete level; the child inherits the adaptive marker
    // from `executor.reasoning_effort`, exactly as `applyConfiguredRoute` writes it.
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });

    // The rewrite is committed off the append that reported the marker (a
    // session cannot be appended to while its own event is being published), so
    // settle before the step reads the selection — exactly as a real driver does,
    // since it only starts the next step after this turn's events are committed.
    await Promise.resolve();
    // The regression: this used to throw "proposed reasoning effort ... after step
    // preparation fixed reflex". It must now complete and keep the fixed selection.
    const config = await step(childAgent(child), child);
    assert.equal(config.reasoningEffort, effort('high'), 'the request carries the level the selection already fixed');
    assert.notEqual(config.reasoningEffort, effort('reflex'), 'the marker never reaches an adapter');
  });
});

/** Let the off-append rewrite settle (it runs on a microtask after the append). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('g-048: the downgrade is recorded with the configured marker and the inherited level', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ child, parent }) => {
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();

    const records = inheritRecords(child);
    assert.equal(records.length, 1, 'exactly one record per rewrite');
    const record = records[0];
    assert.equal(record.requested, 'reflex', 'the configured marker is kept verbatim');
    assert.equal(record.applied, 'high', 'the level actually inherited');
    assert.equal(record.inherited, 'high');
    assert.equal(record.parentLevel, 'present');
    assert.equal(record.reason, 'subagent-cannot-decide');
    assert.equal(record.agentId, 'sub-1');
    assert.equal(record.delegationDepth, 1);
    assert.match(record.line, /configured "reflex".*inherited parent level "high"/);
    // The parent's own log is untouched: the downgrade belongs to the child.
    assert.equal(inheritRecords(parent).length, 0);
  });
});

test('g-048: a parent without a level removes the marker and says so', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ child, current }) => {
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();
    const selected = current(child);
    assert.equal(selected?.reasoningEffort, undefined, 'no marker reaches the adapter');
    assert.equal(selected?.provider, 'deepseek', 'the route is untouched');
    const record = inheritRecords(child)[0];
    assert.equal(record.applied, null);
    assert.equal(record.parentLevel, 'absent');
    assert.match(record.line, /marker removed \(adapter default\)/);
  });
});

test('g-048: effort.enabled=false keeps the existing behaviour and inherits nothing', async () => {
  const disabled: ReflexConfig = { ...ADAPTIVE, effort: { reasoningEffort: 'reflex', enabled: false } };
  await withDelegatedHost(disabled, async ({ child, parent, current }) => {
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();
    // Unchanged: the marker stays on the selection, and the interceptor clears it
    // on the way out — it must NOT fall back to the parent's `high`.
    assert.equal(current(child)?.reasoningEffort, 'reflex', 'the switch off path is untouched');
    assert.equal(inheritRecords(child).length, 0, 'no downgrade record when the layer is off');
  });
});

test('g-048: a main session keeps the adaptive marker — its behaviour is unchanged', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ parent, current }) => {
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();
    assert.equal(current(parent)?.reasoningEffort, 'reflex', 'the main agent still decides per turn');
    assert.equal(inheritRecords(parent).length, 0, 'nothing is recorded for a main session');
  });
});

test('g-048: a concrete level on a delegated agent is left exactly as recorded', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ child, parent, current }) => {
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('low') });
    await settle();
    assert.equal(current(child)?.reasoningEffort, 'low', "the caller's own choice is not overridden");
    assert.equal(inheritRecords(child).length, 0);
  });
});

test('g-048: only the newest selection counts, so a later parent change is inherited', async () => {
  await withDelegatedHost(ADAPTIVE, async ({ child, parent, current }) => {
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();
    assert.equal(current(child)?.reasoningEffort, undefined, 'no parent yet: marker removed');
    parent.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('high') });
    // The parent's level arriving later must still reach the child, and the
    // plugin records a second decision because the outcome changed.
    child.append('model/selection', { provider: 'deepseek', model: 'reasoner', reasoningEffort: effort('reflex') });
    await settle();
    assert.equal(current(child)?.reasoningEffort, 'high');
    assert.equal(inheritRecords(child).length, 2);
    assert.equal(inheritRecords(child)[1].applied, 'high');
  });
});
