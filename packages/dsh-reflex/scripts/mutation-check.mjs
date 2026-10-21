#!/usr/bin/env node
/**
 * Negative control for the `dsh-reflex` suite.
 *
 * A green suite proves nothing unless it can go red. This script copies the
 * plugin source into an ignored scratch directory, replays the suite once to
 * establish that the copy reproduces green, then injects deliberate faults —
 * one per acceptance area (surface completeness, teardown, argument validation,
 * configuration, virtual-provider ownership, audit trail, empty-pool
 * fail-closed behaviour, re-entrancy defence, loop-request identity,
 * opt-in interception, marker rewriting, caller-pinned transparency, safe
 * degradation on a non-thinking target, bounded audit payload, the System 1
 * confidence floor, the session audit log, the status event, and the
 * cache-affinity layer: the context size the decision is told, the policy it is
 * given, the sticky gate that keeps a warm session in place, the affinity fields
 * the router audits, the per-session memory the routing layer keeps, and the
 * panel projection of the switch flag, the per-tool switches, and the effort
 * capability switch) — and requires the suite to fail for each.
 *
 * Usage: `npm run test:mutation` (from the repository root).
 * Exit code 0 = every fault was caught; 1 = at least one fault survived, or the
 * baseline copy was not green.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.resolve(packageDir, '..', '..', 'tmp', 'reflex-mutation');
const srcDir = path.join(packageDir, 'src');
const testGlob = path.posix.join('dist', '**', '*.test.js');
/**
 * How many tests one run executed; 0 means the glob matched nothing.
 *
 * A floor, not an equality: it is here so a broken glob or a suite that silently
 * lost tests cannot make the baseline look green. It is kept at the suite's real
 * size, so losing any test at all fails the negative control before it judges a
 * single fault.
 */
const EXPECTED_TESTS = 412;

/** Each fault targets one acceptance area of the goal. */
const MUTATIONS = [
  {
    name: 'drop-tool-at-registration',
    area: 'registers every enabled tool',
    file: 'src/index.ts',
    from: 'for (const definition of defineReflexTools(runtime, config)) {',
    to: 'for (const definition of defineReflexTools(runtime, config).slice(0, 3)) {'
  },
  {
    name: 'route-default-drift',
    area: 'the opt-in tool stays off until it is asked for',
    file: 'src/tools.ts',
    from: '  route: false,',
    to: '  route: true,'
  },
  {
    name: 'ledger-command-unregistered',
    area: 'the ledger is reachable as /reflex-ledger',
    file: 'src/index.ts',
    from: '    const unregisterLedger = installLedgerCommand(ctx, runtime);',
    to: '    const unregisterLedger = () => {};'
  },
  {
    name: 'no-teardown',
    area: 'reversible lifecycle',
    file: 'src/index.ts',
    // The complete teardown, in its current order: stopping the observer is the
    // one step that survives, so the fault leaves routing, the ledger command,
    // the intervention hooks, the panel, the tool registrations and the runtime
    // mounted after unload.
    from: [
      '    return () => {',
      '      stopConfigWatch();',
      '      stopObserving();',
      '      stopRouting();',
      '      unregisterLedger();',
      '      interventions.dispose();',
      '      unmountPanel();',
      '      tools.dispose();',
      '      runtime.dispose();',
      '    };'
    ].join('\n'),
    to: ['    return () => {', '      stopObserving();', '    };'].join('\n')
  },
  {
    name: 'config-refresh-frozen',
    area: 'live routing configuration',
    file: 'src/bridge.ts',
    // A settings save is committed into the running activation; losing the
    // policy swap leaves the router on the activation-time pools and fallback.
    from: '    this.#modelRouter.updatePolicy({',
    to: '    if (false) this.#modelRouter.updatePolicy({'
  },
  {
    name: 'effort-policy-frozen',
    area: 'live effort policy',
    file: 'src/bridge.ts',
    // The effort switch/marker/fallback/confidence floor are committed without a
    // remount; losing the policy swap keeps the activation-time values.
    from: '    this.effort.updatePolicy({',
    to: '    if (false) this.effort.updatePolicy({'
  },
  {
    name: 'intervention-policy-frozen',
    area: 'live intervention policy',
    file: 'src/bridge.ts',
    from: '    this.#reconfigureInterventions?.(resolved.interventions, resolved.pruneThreshold);',
    to: '    if (false) this.#reconfigureInterventions?.(resolved.interventions, resolved.pruneThreshold);'
  },
  {
    name: 'tool-surface-frozen',
    area: 'live tool switches and prefix',
    file: 'src/bridge.ts',
    from: '    this.#reconfigureTools?.(resolved);',
    to: '    if (false) this.#reconfigureTools?.(resolved);'
  },
  {
    name: 'tool-prefix-keeps-old-registrations',
    area: 'a prefix edit leaves no orphaned tool',
    file: 'src/index.ts',
    from: '        if (wanted.has(name) && ctx.tools.get(name) !== undefined) continue;',
    to: '        if (true) continue;'
  },
  {
    name: 'intervention-listeners-never-detached',
    area: 'off is the absence of the intervention listeners',
    file: 'src/interventions.ts',
    from: [
      '    const detachers = groups.get(group);',
      '    if (!detachers) return;'
    ].join('\n'),
    to: [
      '    const detachers = groups.get(group);',
      '    if (!detachers) return;',
      '    if (detachers.length >= 0) return;'
    ].join('\n')
  },
  {
    name: 'no-root-argument-check',
    area: 'strict argument validation',
    file: 'src/tools.ts',
    from: '  if (unknown.length > 0) {',
    to: '  if (false) {'
  },
  {
    name: 'prefix-default-drift',
    area: 'deployment configuration',
    file: 'src/config.ts',
    from: "toolPrefix: z.string().default('reflex_')",
    to: "toolPrefix: z.string().default('rfx_')"
  },
  {
    name: 'route-foreign-provider',
    area: 'virtual route ownership',
    file: 'src/routing.ts',
    from: 'if (routes && router.owns(config.provider)) {',
    to: "if (config.provider !== '') {"
  },
  {
    name: 'route-cancelled-request',
    area: 'cancellation is respected',
    file: 'src/routing.ts',
    from: 'if (!rawConfig || payload.signal?.aborted) return rawConfig;',
    to: 'if (!rawConfig) return rawConfig;'
  },
  {
    name: 'unlabelled-route-audit',
    area: 'auditable routing decisions',
    file: 'src/router.ts',
    from: "      type: 'model-route',",
    to: "      type: 'route',"
  },
  {
    name: 'silent-empty-pool',
    area: 'empty pool fails closed',
    file: 'src/router.ts',
    from: 'if (pool.length === 0) {',
    to: 'if (false) {'
  },
  {
    name: 'allow-self-route',
    area: 'no routing into the virtual provider',
    file: 'src/router.ts',
    from: 'if (this.owns(target.provider)) {',
    to: 'if (false) {'
  },
  {
    name: 'lose-loop-request-identity',
    area: 'loop request identity survives routing',
    file: 'src/virtual-adapter.ts',
    from: '    if (isAgentLoopRequest(options)) {',
    to: '    if (false && isAgentLoopRequest(options)) {'
  },
  {
    name: 'route-without-pools',
    area: 'effort interception stays independent of routing',
    file: 'src/routing.ts',
    from: 'let routes = false;',
    to: 'let routes = true;'
  },
  {
    name: 'rewrite-drops-decision',
    area: 'the marker becomes the decided effort',
    file: 'src/routing.ts',
    from:
      '      const effort = resolution.changed ? resolution.effort : requested;',
    to: '      const effort = requested;'
  },
  {
    name: 'effort-overrides-caller-pin',
    area: 'an explicit caller effort stays transparent',
    file: 'src/effort.ts',
    from: "    if (isEffortTrigger(requested)) return this.#decideTurn('request', context);",
    to: "    if (isEffortTrigger(requested) || isEffortLevel(requested)) return this.#decideTurn('request', context);"
  },
  {
    name: 'effort-keeps-level-on-plain-model',
    area: 'a non-thinking target degrades safely',
    file: 'src/effort.ts',
    from: [
      "  if (support.kind === 'none') return { outcome: 'cleared' };",
      "  if (support.efforts.includes(level)) return { effort: level, outcome: 'supported' };",
      '',
      '  const snapped = snapEffort(level, support.efforts, support.defaultEffort);'
    ].join('\n'),
    to: [
      "  if (support.kind === 'none') return { effort: level, outcome: 'supported' };",
      "  if (support.efforts.includes(level)) return { effort: level, outcome: 'supported' };",
      '',
      '  const snapped = snapEffort(level, support.efforts, support.defaultEffort);'
    ].join('\n')
  },
  {
    name: 'effort-ignores-confidence-floor',
    area: 'System 1 answers below the floor fall back',
    file: 'src/effort.ts',
    from: '    if (confidence < this.minConfidence) {',
    to: '    if (false) {'
  },
  {
    name: 'effort-audit-unbounded',
    area: 'the audited turn excerpt stays bounded',
    file: 'src/effort.ts',
    from: '    ...(task.length === 0 ? {} : { task: task.slice(0, EFFORT_AUDIT_TASK_CHARS) })',
    to: '    ...(task.length === 0 ? {} : { task })'
  },
  {
    name: 'effort-hides-applied-level',
    area: 'the audit tells cleared from applied',
    file: 'src/session-audit.ts',
    from: '    applied: status.applied ?? null,',
    to: '    applied: null,'
  },
  {
    name: 'status-event-silenced',
    area: 'the decision is reported to the host',
    file: 'src/routing.ts',
    from: "    ctx.emit('reflex/effort', status);",
    to: "    if (false) ctx.emit('reflex/effort', status);"
  },
  // The settings panel (g-004): the browser half and its loopback route family.
  {
    name: 'panel-fence-off',
    area: 'the panel answers loopback clients only',
    file: 'src/panel-api.ts',
    from: "  if (typeof isPaired !== 'function') return false;",
    to: "  if (typeof isPaired !== 'function') return true;"

  },
  {
    name: 'panel-clears-without-confirmation',
    area: 'clearing the ledger needs an explicit confirmation',
    file: 'src/panel-api.ts',
    from: "      if (readQuery(request.url, 'confirm') !== 'clear') {",
    to: '      if (false) {'
  },
  {
    name: 'panel-drops-the-fallback-target',
    area: 'the routing page round-trips the authored fallback',
    file: 'src/client/panel.ts',
    from: '      fallback: asText(routing.fallback),',
    to: "      fallback: '',"
  },
  {
    name: 'panel-writes-when-read-only',
    area: 'a read-only settings document is never written',
    file: 'src/client/store.ts',
    from: '    if (!this.#state.writable) return false;',
    to: '    if (false) return false;'
  },
  {
    name: 'panel-effort-level-drift',
    area: 'the page offers exactly the levels the host accepts',
    file: 'src/client/panel.ts',
    from: "export const ADAPTIVE_EFFORT_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high'];",
    to: "export const ADAPTIVE_EFFORT_LEVELS: readonly string[] = ['off', 'high'];"
  },
  {
    name: 'panel-addresses-a-group-name-that-is-not-a-schema-path',
    area: 'every path the panel writes is a path the host declares volatile',
    // The reported bug, in one line: the runtime page's fields live at four
    // top-level paths (`toolPrefix`, `ledgerPath`, `pruneThreshold`,
    // `calibrationPath`), and addressing them by the page's own group name made
    // the host refuse the whole save as "not volatile".
    file: 'src/client/panel.ts',
    from: "        { path: ['pruneThreshold'], value: asNumber(draft.runtime.pruneThreshold) ?? 500 },",
    to: "        { path: [group], value: asNumber(draft.runtime.pruneThreshold) ?? 500 },"
  },
  {
    name: 'system-one-timeout-unchecked',
    area: 'System 1 connection parameters are validated',
    file: 'src/config.ts',
    from: '  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {',
    to: '  if (false) {'
  },
  // Cache affinity and session stickiness (g-006): the facts the decision is
  // told, the policy it is given, the gate that keeps a warm session put, and
  // the audit and panel fields that make the outcome visible.
  {
    name: 'affinity-drops-token-estimate',
    area: 'the decision is told the session context size',
    file: 'src/router.ts',
    from: 'request.contextTokens === undefined ? estimateContextTokens(contextChars) : toCount(request.contextTokens)',
    to: 'request.contextTokens === undefined ? 0 : toCount(request.contextTokens)'
  },
  {
    name: 'affinity-policy-not-stated',
    area: 'the decision prompt states the cache-affinity policy',
    file: 'src/router.ts',
    from: ' — prefer ${facts.currentModel} and switch away only when another candidate is clearly better suited to the task.`;',
    to: '.`;'
  },
  {
    name: 'sticky-gate-always-switches',
    area: 'a merely better challenger does not displace the cached model',
    file: 'src/router.ts',
    from: '&& winnerScore >= incumbentScore * (1 + this.#stickyMargin);',
    to: '&& true;'
  },
  {
    name: 'affinity-audit-loses-current-model',
    area: 'the routing audit records which model the session held',
    file: 'src/router.ts',
    from: '        currentModel: decision.currentModel ?? null,',
    to: '        currentModel: null,'
  },
  {
    name: 'routing-forgets-routed-model',
    area: 'session stickiness is remembered across turns',
    file: 'src/routing.ts',
    from: '      rememberTarget(facts, payload.agent, decision.target);',
    to: '      if (false) rememberTarget(facts, payload.agent, decision.target);'
  },
  {
    name: 'routing-reports-no-context',
    area: 'the context a session accumulated reaches the decision',
    file: 'src/routing.ts',
    from: '          contextTokens: estimateContextTokens(remembered?.contextChars ?? 0)',
    to: '          contextTokens: 0'
  },
  {
    name: 'panel-drops-switched-flag',
    area: 'the panel shows whether a decision switched models',
    file: 'src/panel-api.ts',
    from: '    ...(switched === undefined ? {} : { switched }),',
    to: ''
  },
  {
    name: 'prune-ignores-action-ceiling',
    area: 'a reduction draws on the turn’s shared action ceiling',
    file: 'src/interventions.ts',
    // The size gates are left intact: only the ceiling check disappears, so a turn
    // with no allowance left still plans reductions.
    from: [
      "      this.#skip('retention-unavailable', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });",
      '      return downstream;',
      '    }',
      '    if (!this.#actionWithinBudget(state)) {'
    ].join('\n'),
    to: [
      "      this.#skip('retention-unavailable', { capability: 'prune', state, agent: exec.agent, detail: payloadDetail });",
      '      return downstream;',
      '    }',
      '    if (false) {'
    ].join('\n')
  },
  {
    name: 'prune-observe-action-unbooked',
    area: 'a planned action is booked in both modes',
    file: 'src/interventions.ts',
    from: ['      this.#bookAction(state);', '      this.#conclude(plan, false, exec.agent, planCosts, judgment);'].join('\n'),
    to: '      this.#conclude(plan, false, exec.agent, planCosts, judgment);'
  },
  {
    name: 'prune-applied-action-unbooked',
    area: 'an installed reduction is booked',
    file: 'src/interventions.ts',
    from: ['    this.#bookAction(state);', '    this.#conclude(', '      plan,'].join('\n'),
    to: ['    this.#conclude(', '      plan,'].join('\n')
  },
  // Stagnation exemptions for legitimate waits (g-012): the structured identity
  // a wait is recognised by, and the window it must not dilute.
  {
    name: 'wait-exemption-ignores-shape',
    area: 'a wait is identified by its tool and its job-handle shape',
    file: 'src/interventions.ts',
    from: "typeof args[field] === 'string' && (args[field] as string).length > 0",
    to: 'true'
  },
  {
    name: 'wait-steps-count-as-progress',
    area: 'a wait is not progress a run can be repeating',
    file: 'src/interventions.ts',
    from: "return steps.some((step) => step.wait === true) ? steps.filter((step) => step.wait !== true) : steps;",
    to: 'return steps;'
  },
  // The two capability switches (g-009): the effort layer's on/off answer, and
  // the per-tool one. Each fault disables the switch itself, not a downstream
  // behaviour, so only a suite that actually exercises the *off* branch of that
  // switch can go red.
  {
    name: 'effort-switch-always-on',
    area: 'the effort capability switch can turn the layer off',
    file: 'src/config.ts',
    from: '  const effortEnabled = effort.enabled ?? true;',
    to: '  const effortEnabled = true;'
  },
  {
    name: 'tool-switch-ignores-close',
    area: 'a switched-off tool is not registered',
    file: 'src/tools.ts',
    from: '  return REFLEX_TOOL_SUFFIXES.filter((suffix) => config.tools?.enabled?.[suffix] ?? REFLEX_TOOL_DEFAULT_ENABLED[suffix]);',
    to: '  return [...REFLEX_TOOL_SUFFIXES];'
  }
];

/**
 * Run one command in the scratch copy.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @returns {{ ok: boolean, output: string }} the outcome and its combined output.
 */
function run(command, args) {
  try {
    const output = execFileSync(command, args, { cwd: workDir, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error);
    return { ok: false, output: `${stdout}${stderr}` };
  }
}

/**
 * Re-copy pristine sources, the tsconfig, and the published manifest and client
 * artifact into the scratch copy.
 *
 * The client half's tests read `package.json` and the generated `client.js` as
 * the DSH loader would, so the copy has to carry them; otherwise the baseline
 * would be red for a missing file rather than for a real fault.
 */
function resetSources() {
  rmSync(path.join(workDir, 'src'), { recursive: true, force: true });
  rmSync(path.join(workDir, 'dist'), { recursive: true, force: true });
  cpSync(srcDir, path.join(workDir, 'src'), { recursive: true });
  cpSync(path.join(packageDir, 'tsconfig.json'), path.join(workDir, 'tsconfig.json'));
  cpSync(path.join(packageDir, 'package.json'), path.join(workDir, 'package.json'));
  cpSync(path.join(packageDir, 'tsconfig.client.json'), path.join(workDir, 'tsconfig.client.json'));
  cpSync(path.join(packageDir, 'client.js'), path.join(workDir, 'client.js'));
}

/**
 * Build the scratch copy: the Host half, the browser half, and the artifact the
 * client tests load. The client bundle is generated from source here, so a fault
 * injected into `src/client/**` reaches the tests exactly as a real build would.
 * @returns true when every stage succeeded.
 */
function build() {
  if (!run('npx', ['tsc', '-p', 'tsconfig.json']).ok) return false;
  if (!run('npx', ['tsc', '-p', 'tsconfig.client.json']).ok) return false;
  return run(process.execPath, [path.join('dist', 'client-bundle.js'), '.']).ok;
}

/**
 * Run the plugin suite against the scratch copy.
 * @returns the outcome plus how many tests actually executed.
 */
function test() {
  const outcome = run(process.execPath, ['--test', testGlob]);
  const passed = /^[ℹ#] pass (\d+)$/m.exec(outcome.output);
  return { ...outcome, executed: passed ? Number(passed[1]) : 0 };
}

/**
 * Apply one mutation to the scratch copy.
 * @param {{ file: string, from: string, to: string }} mutation - the fault.
 * @throws Error when the anchor text is missing or ambiguous (a stale mutation).
 */
function mutate(mutation) {
  const target = path.join(workDir, mutation.file);
  if (!existsSync(target)) throw new Error(`mutation ${mutation.name} targets a missing file: ${mutation.file}`);
  const original = readFileSync(target, 'utf8');
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutation ${mutation.name} matched ${occurrences} times in ${mutation.file}; expected exactly 1`);
  }
  writeFileSync(target, original.replace(mutation.from, mutation.to));
}

/** One reported row. */
const results = [];
let failed = false;

mkdirSync(workDir, { recursive: true });
// Scratch outputs stay under the workspace's ignored tmp/, while resolving the
// exact same host dependencies as the package being checked.
if (!existsSync(path.join(workDir, 'node_modules'))) {
  symlinkSync(path.join(packageDir, 'node_modules'), path.join(workDir, 'node_modules'), 'dir');
}

resetSources();
const baselineBuild = build();
const baselineTest = baselineBuild ? test() : { ok: false, output: 'build failed', executed: 0 };
const baselineGreen = baselineBuild && baselineTest.ok && baselineTest.executed >= EXPECTED_TESTS;
results.push({ name: '(unmutated copy)', area: 'baseline', ok: baselineGreen });
if (!baselineGreen) {
  failed = true;
  console.error(
    `baseline copy is not green (built=${baselineBuild}, exit=${baselineTest.ok ? 0 : 1}, executed=${baselineTest.executed}) — the negative control cannot judge anything`
  );
  console.error(baselineTest.output.split('\n').slice(-15).join('\n'));
} else {
  for (const mutation of MUTATIONS) {
    resetSources();
    mutate(mutation);
    const built = build();
    const outcome = built ? test() : { ok: false };
    // A fault is caught either by the compiler or by the suite; both count, and
    // the report keeps them apart so the split stays visible.
    const stage = !built ? 'build' : !outcome.ok ? 'tests' : undefined;
    results.push({ name: mutation.name, area: mutation.area, stage, ok: stage !== undefined });
    if (!stage) failed = true;
  }
}

const width = Math.max(...results.map((row) => row.name.length));
const areaWidth = Math.max(...results.map((row) => row.area.length));
for (const row of results) {
  const verdict = row.area === 'baseline'
    ? row.ok ? 'GREEN' : 'RED'
    : row.ok ? `CAUGHT-BY-${row.stage.toUpperCase()}` : 'SURVIVED';
  console.log(`${row.name.padEnd(width)}  ${row.area.padEnd(areaWidth)}  ${verdict}`);
}

if (failed) {
  console.error('\nnegative control FAILED: the suite did not react to every injected fault');
  process.exitCode = 1;
} else {
  const byTests = results.filter((row) => row.stage === 'tests').length;
  const byBuild = results.filter((row) => row.stage === 'build').length;
  console.log(
    `\nnegative control OK: ${MUTATIONS.length}/${MUTATIONS.length} injected faults were caught (${byTests} by the suite, ${byBuild} by the compiler)`
  );
  rmSync(workDir, { recursive: true, force: true });
}
