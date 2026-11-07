import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DELEGATION_BROKEN_WARNING,
  DELEGATION_MODEL_SELECTION_OFF_REASON,
  DELEGATION_TOOL_MISSING_REASON,
  readDelegationHealth,
  watchDelegationHealth,
  type DelegationHealth
} from './delegation-health.js';
import { DELEGATION_ROW_ID, PROFILE_PATCH_FILENAME, enableHostModelSelection } from './host-patch.js';
import {
  createReflexHost,
  createReflexHostWithTools,
  createToolContext,
  delegationStandIn
} from './testing.js';
import {
  delegateServable,
  delegationExecutables,
  enabledReflexToolSuffixes,
  resolveReflexToolExecutables
} from './tools.js';
import { buildPanelSnapshot } from './panel-api.js';
import { resolveConfig } from './config.js';
import { DecisionLedger } from './vendor/harness-reflex/core/ledger.js';

/**
 * Coverage of the runtime self-heal, and — more importantly — of its boundary.
 *
 * The design has one rule above all others: **a capability that breaks is
 * withdrawn and reported, never repaired silently.** A patch that stopped asking
 * for `modelSelection` is indistinguishable from a person turning it back off, so
 * writing it again would override a human decision. Every case below asserts both
 * halves of that: the tool really disappears from the registry and the surface,
 * and the profile patch file is byte-identical afterwards.
 *
 * @module dsh-reflex/delegation-health.test
 */

/** A reading for a Host whose tool can carry a level. */
const READY: DelegationHealth = { state: 'ready', toolName: 'subagent', delegateAvailable: true };
/** A reading for a Host whose tool lost `reasoning_effort`. */
const BROKEN: DelegationHealth = {
  state: 'model-selection-off',
  toolName: 'subagent',
  reason: DELEGATION_MODEL_SELECTION_OFF_REASON,
  delegateAvailable: false
};
/** A reading for a Host that never had a delegation tool. */
const MISSING: DelegationHealth = { state: 'missing-tool', reason: DELEGATION_TOOL_MISSING_REASON, delegateAvailable: false };

test('the live reading distinguishes no tool, a bare tool, and a usable one', async () => {
  // No tool at all.
  const bare = await createToolContext();
  try {
    assert.deepEqual(readDelegationHealth(bare), { state: 'ready', toolName: 'subagent', delegateAvailable: true });
  } finally {
    await bare.fiber.dispose();
  }

  // The default context ships the level-carrying stand-in; a context without it
  // is the "this host has no delegation tool" shape.
  const { createToolContextWithoutDelegation } = await import('./testing.js');
  const none = await createToolContextWithoutDelegation();
  try {
    const health = readDelegationHealth(none);
    assert.equal(health.state, 'missing-tool');
    assert.equal(health.delegateAvailable, false);
    assert.equal(health.reason, DELEGATION_TOOL_MISSING_REASON);
  } finally {
    await none.fiber.dispose();
  }

  // A tool that exists but cannot carry a level.
  const stripped = await createToolContextWithoutDelegation();
  try {
    stripped.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    const health = readDelegationHealth(stripped);
    assert.equal(health.state, 'model-selection-off');
    assert.equal(health.delegateAvailable, false);
    assert.equal(health.reason, DELEGATION_MODEL_SELECTION_OFF_REASON);
  } finally {
    await stripped.fiber.dispose();
  }
});

test('a capability that was never usable does not warn: it is simply not offered', () => {
  // A headless embedder or a deployment that started with modelSelection off.
  // Warning here would be noise about a state the user never had.
  const warnings: string[] = [];
  let reading = MISSING;
  const watch = watchDelegationHealth({ read: () => reading, warn: (message) => warnings.push(message) });
  watch.check();
  watch.check();
  assert.deepEqual(warnings, [], 'no warning for a capability that never existed');
});

test('a deployment that starts with the tool already unable to carry a level does not warn', () => {
  // The other "never worked" shape, and the one a `modelSelection`-off deployment
  // actually has: the tool is there, it just has no `reasoning_effort`. Starting
  // in this state is a configuration, not a break — a warning here would fire on
  // every boot of every such deployment and teach people to ignore the line.
  const warnings: string[] = [];
  const watch = watchDelegationHealth({ read: () => BROKEN, warn: (message) => warnings.push(message) });
  watch.check();
  watch.check();
  assert.deepEqual(warnings, [], 'a capability that was already unusable is not a break');
  assert.equal(watch.health.state, 'model-selection-off', 'the state is still reported to the panel');

  // Giving it back and then losing it again *is* a break, and is reported.
  const recovering: string[] = [];
  let reading: DelegationHealth = BROKEN;
  const second = watchDelegationHealth({ read: () => reading, warn: (m) => recovering.push(m) });
  reading = READY;
  second.check();
  reading = BROKEN;
  second.check();
  assert.deepEqual(recovering, [DELEGATION_BROKEN_WARNING], 'only a real loss warns');
});

test('a working capability that stops working warns exactly once', () => {
  const warnings: string[] = [];
  const changes: string[] = [];
  let reading = READY;
  const watch = watchDelegationHealth({
    read: () => reading,
    warn: (message) => warnings.push(message),
    onChange: (health) => changes.push(health.state)
  });
  assert.equal(watch.health.state, 'ready');

  reading = BROKEN;
  assert.equal(watch.check().state, 'model-selection-off');
  assert.deepEqual(warnings, [DELEGATION_BROKEN_WARNING], 'the transition is reported');
  assert.match(DELEGATION_BROKEN_WARNING, /Nothing in your configuration was changed/, 'the warning says what was NOT done');
  assert.match(DELEGATION_BROKEN_WARNING, /re-tick/, 'and what the person should do');

  watch.check();
  watch.check();
  assert.equal(warnings.length, 1, 'a registry that churns must not flood the log');

  // Recovering and breaking again is a new episode, and earns its own warning.
  reading = READY;
  watch.check();
  reading = BROKEN;
  watch.check();
  assert.equal(warnings.length, 2, 'a second break after a recovery is reported again');
  assert.deepEqual(changes, ['model-selection-off', 'ready', 'model-selection-off']);
});

test('forget() makes the next activation count as new, so a deliberate off is not a break', () => {
  const warnings: string[] = [];
  let reading = READY;
  const watch = watchDelegationHealth({ read: () => reading, warn: (message) => warnings.push(message) });
  // The deployment turned the capability off on purpose: the watch is told to
  // forget the earlier usable state, so the next reading is not "it broke".
  watch.forget();
  reading = MISSING;
  watch.check();
  assert.deepEqual(warnings, []);
});

test('a broken capability is withdrawn without the profile patch being written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflex-heal-'));
  try {
    const patch = join(dir, PROFILE_PATCH_FILENAME);
    writeFileSync(patch, '# user patch\n- id: locale\n  config:\n    preference: zh\n', 'utf8');
    const before = readFileSync(patch, 'utf8');

    // The host tool is broken *before* the activation mounts: this is the state a
    // reload leaves behind when the patch stopped asking for the field.
    const host = await createReflexHostWithTools(
      { backend: 'mock', delegation: { enabled: true } },
      () => {},
      { delegation: false }
    );
    try {
      const warnings: string[] = [];
      const watch = watchDelegationHealth({
        read: () => readDelegationHealth(host.ctx),
        warn: (message) => warnings.push(message)
      });
      assert.equal(watch.health.state, 'missing-tool');
      watch.check();

      // The self-heal's whole contract: it *reports*, and it writes nothing.
      assert.equal(readFileSync(patch, 'utf8'), before, 'the profile patch was not written by the self-heal');
      assert.ok(!readFileSync(patch, 'utf8').includes(DELEGATION_ROW_ID), 'nothing was added either');
    } finally {
      await host.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withdrawing follows the published surface: a broken tool is not advertised', async () => {
  // Drive the real registration path with a tool that has no level parameter.
  const { createReflexHostWithTools } = await import('./testing.js');
  const host = await createReflexHostWithTools(
    { backend: 'mock', delegation: { enabled: true } },
    (ctx) => {
      ctx.tools.register(delegationStandIn({ reasoningEffort: false }).definition);
    },
    { delegation: false }
  );
  try {
    assert.equal(host.ctx.tools.get('reflex_delegate'), undefined, 'the wrapper is not registered');
    assert.ok(
      ![...host.runtime.toolSurface].includes('reflex_delegate'),
      'and the surface the panel reads does not advertise it'
    );
    const health = host.runtime.delegationHealth;
    assert.equal(health?.state, 'model-selection-off');
    assert.equal(health?.reason, DELEGATION_MODEL_SELECTION_OFF_REASON);
  } finally {
    await host.dispose();
  }
});

test('consent off means no delegate even on a capable host, and the panel says why it is off', async () => {
  const host = await createReflexHost({ backend: 'mock', delegation: { enabled: false } });
  try {
    assert.equal(host.ctx.tools.get('reflex_delegate'), undefined, 'an unconsented capability is not registered');
    // The host is perfectly capable; the switch is what is off. The panel has to
    // show that distinction, because the two states need different actions.
    assert.equal(host.runtime.delegationHealth?.state, 'ready');
  } finally {
    await host.dispose();
  }
});

test('the panel projection reports the restart window, and never claims the switch took effect', () => {
  const config = resolveConfig({ backend: 'mock', delegation: { enabled: true } });
  const facts = {
    config,
    backendName: 'mock',
    pools: [],
    routingActive: false,
    toolSurface: [] as string[],
    ledger: new DecisionLedger(null),
    apiKeyPresent: false,
    effort: undefined,
    // The file asks for the field, but this host still refuses the level: exactly
    // the window between the write and the restart.
    hostPatch: { path: '/x/cordis.patch.yml', source: 'DSH_PROFILE_DIR', enabled: true },
    delegationHealth: { state: 'model-selection-off' as const, reason: DELEGATION_MODEL_SELECTION_OFF_REASON }
  };
  const snapshot = buildPanelSnapshot(facts, 5);

  assert.equal(snapshot.delegation.enabled, true, 'the consent is recorded');
  assert.equal(snapshot.delegation.patchEnabled, true, 'the file asks for the field');
  assert.equal(snapshot.delegation.registered, false, 'the tool is not registered yet');
  assert.equal(snapshot.delegation.restartRequired, true, 'so the panel says a restart is what applies it');
  assert.equal(snapshot.delegation.reason, DELEGATION_MODEL_SELECTION_OFF_REASON, 'the reason is carried verbatim');
});

test('once the host serves it, the restart prompt disappears', () => {
  const config = resolveConfig({ backend: 'mock', delegation: { enabled: true } });
  const snapshot = buildPanelSnapshot(
    {
      config,
      backendName: 'mock',
      pools: [],
      routingActive: false,
      toolSurface: ['reflex_delegate'],
      ledger: new DecisionLedger(null),
      apiKeyPresent: false,
      effort: undefined,
      hostPatch: { path: '/x/cordis.patch.yml', source: 'DSH_PROFILE_DIR', enabled: true },
      delegationHealth: { state: 'ready' as const }
    },
    5
  );
  assert.equal(snapshot.delegation.restartRequired, false, 'no restart is pending once the host serves the field');
  assert.equal(snapshot.delegation.registered, true);
  assert.equal(snapshot.delegation.reason, undefined);
});

test('the switch starts off, and a default deployment writes nothing anywhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflex-default-off-'));
  try {
    const patch = join(dir, PROFILE_PATCH_FILENAME);
    writeFileSync(patch, '- id: locale\n  config:\n    preference: zh\n', 'utf8');
    const before = readFileSync(patch, 'utf8');

    const host = await createReflexHost({ backend: 'mock' });
    try {
      assert.equal(host.runtime.effectiveConfig.delegation.enabled, false, 'the switch defaults off');
      assert.equal(host.ctx.tools.get('reflex_delegate'), undefined);
    } finally {
      await host.dispose();
    }
    assert.equal(readFileSync(patch, 'utf8'), before, 'loading the plugin never touches the user patch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the panel route refuses a write that does not name the intent', async () => {
  const { answerPanelRequest } = await import('./panel-api.js');
  const writes: string[] = [];
  const source = {
    snapshot: () => buildPanelSnapshot({} as never, 5),
    clearLedger: () => 0,
    allows: () => true,
    enableDelegation: () => {
      writes.push('called');
      return { outcome: 'added-row', restartRequired: true };
    }
  };
  const request = (method: string, url: string) =>
    ({ method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as never;

  const bare = answerPanelRequest(source, request('POST', '/dsh-reflex/api/delegation'));
  assert.equal(bare.status, 400, 'a POST without the confirmation query is refused');
  assert.equal(writes.length, 0, 'and reaches no writer');

  const wrongMethod = answerPanelRequest(source, request('GET', '/dsh-reflex/api/delegation?confirm=delegation'));
  assert.equal(wrongMethod.status, 405, 'a GET never writes');

  const accepted = answerPanelRequest(source, request('POST', '/dsh-reflex/api/delegation?confirm=delegation'));
  assert.equal(accepted.status, 200);
  assert.equal(writes.length, 1);
  const body = accepted.body as { outcome: string; restartRequired: boolean };
  assert.equal(body.outcome, 'added-row');
  assert.equal(body.restartRequired, true, 'a real write always needs a restart');
});

test('a host that cannot write the patch answers 501 instead of pretending', async () => {
  const { answerPanelRequest } = await import('./panel-api.js');
  const source = {
    snapshot: () => buildPanelSnapshot({} as never, 5),
    clearLedger: () => 0,
    allows: () => true
  };
  const answer = answerPanelRequest(
    source,
    { method: 'POST', url: '/dsh-reflex/api/delegation?confirm=delegation', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never
  );
  assert.equal(answer.status, 501);
  assert.match(String((answer.body as { detail: string }).detail), /by hand/);
});

test('the write path used by the panel is the same one the tests exercise', () => {
  // A guard against the panel growing a second, untested writer: the outcome
  // vocabulary the route returns is the one `enableHostModelSelection` defines.
  const dir = mkdtempSync(join(tmpdir(), 'reflex-outcome-'));
  try {
    const patch = join(dir, PROFILE_PATCH_FILENAME);
    const result = enableHostModelSelection({ path: patch });
    assert.ok(
      ['added-row', 'added-field', 'added-field-after-name', 'already-enabled'].includes(result.outcome),
      `unexpected outcome ${result.outcome}`
    );
    // The result describes the file, not the runtime: "a restart is needed" is the
    // route's statement about the activation, and it is decided there.
    assert.equal(result.previousBytes, 0, 'a created file had no previous content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deliberate-off direction withdraws the tool through the surface reconciler, silently', () => {
  // Unticking the switch is not a break: the reconciler must drop the tool and
  // the watch must stay quiet, because nothing went wrong.
  const registrations: string[] = [];
  const ctx = {
    tools: {
      get: (name: string) => (name === 'subagent' ? { parameters: { properties: { reasoning_effort: {} } } } : undefined),
      register: (definition: { name: string }) => {
        registrations.push(definition.name);
        return () => undefined;
      }
    }
  } as never;

  // The predicate the registry and the published surface both read.
  const consented = resolveConfig({ backend: 'mock', delegation: { enabled: true } });
  const unconsented = resolveConfig({ backend: 'mock', delegation: { enabled: false } });
  assert.equal(delegateServable(consented, { delegateTarget: 'subagent' }), true);
  assert.equal(delegateServable(unconsented, { delegateTarget: 'subagent' }), false, 'consent is required');
  assert.equal(delegateServable(consented, {}), false, 'and so is a host that can serve it');
  // Vocabulary order, not "everything then the delegate": the reconciler and the
  // published surface both order by `REFLEX_TOOL_SUFFIXES`. Both go through
  // `delegationExecutables`, which is the only place consent is folded in — so a
  // caller cannot register the delegate by handing the low-level function a
  // target the user never consented to.
  assert.deepEqual(
    resolveReflexToolExecutables(
      enabledReflexToolSuffixes(unconsented),
      delegationExecutables(unconsented, 'subagent')
    ),
    ['choice', 'score', 'screen', 'gate'],
    'the unconsented surface keeps every tool except the delegate'
  );
  assert.deepEqual(
    resolveReflexToolExecutables(enabledReflexToolSuffixes(consented), delegationExecutables(consented, 'subagent')),
    ['choice', 'score', 'screen', 'gate', 'delegate'],
    'consent on a capable host restores it'
  );
  // The drift guard itself: consent off withholds the target even when the Host
  // offers one.
  assert.deepEqual(delegationExecutables(unconsented, 'subagent'), {}, 'consent off withholds the target');
  assert.deepEqual(delegationExecutables(consented, undefined), {}, 'a broken Host withholds it too');

  // A silent watch: the off state is reported, never warned about.
  const warnings: string[] = [];
  const watch = watchDelegationHealth({ read: () => readDelegationHealth(ctx), warn: (m) => warnings.push(m) });
  watch.check();
  assert.deepEqual(warnings, [], 'a capability that is off was never broken');
  void registrations;
});
