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
/**
 * The repository root this package sits in.
 *
 * The scratch copy carries its own copies of the two guides, so `guide.test.ts`
 * — which walks *up* from its build looking for `USER_GUIDE.md` and
 * `docs/USER_GUIDE.en.md` — finds the copy's documents rather than this
 * checkout's. Without them it resolves against the checkout, and the copy's
 * freshly generated guide artifact is compared with documents it was never built
 * from: a baseline red that has nothing to do with any injected fault.
 */
const repoRoot = path.resolve(packageDir, '..', '..');
const testGlob = path.posix.join('dist', '**', '*.test.js');
/**
 * How many tests one run executed; 0 means the glob matched nothing.
 *
 * A floor, not an equality: it is here so a broken glob or a suite that silently
 * lost tests cannot make the baseline look green. It is kept at the suite's real
 * size, so losing any test at all fails the negative control before it judges a
 * single fault.
 *
 * Counted as the run's *passing* tests (g-058: 651 of 652). The one test this
 * checkout cannot pass is `an unresolvable host is unreachable`, which needs a
 * resolver that fails fast: on this WSL2 host `/etc/resolv.conf` lists two
 * unreachable nameservers, so DNS never answers and the probe reports `timeout`
 * at its own bound. It fails identically on the g-057 merge commit this branch
 * was cut from, so it is an environment fact rather than a regression — and it
 * is the reason this floor is the pass count, not the total.
 *
 * g-063 moved the pass count 659 → 668: it added 13 tests (3 same-turn reuse,
 * 3 effort-routing, 7 effort-input) and retired 4 that pinned the old contract —
 * a new instruction was "never graded against earlier turns", which is exactly
 * what the goal changed. The replacements assert the new contract, so the net is
 * +9 rather than a silent loss.
 *
 * g-066 moved the pass count 695 → 728. The goal removed the flat connection
 * fallback, so its own tests were *rewritten* rather than kept (the old ones
 * pinned the behaviour being deleted: "a profile inherits every flat field",
 * "connectionTarget merges a profile over the flat block", the compatibility
 * fold's four page tests). Nothing was dropped without a replacement asserting
 * the new contract, and 33 tests were added: the rename-secret plan (15, one per
 * way a rename can reach a stored key), the model list and its selection (9),
 * the "nothing connects" states (4), the keystroke-level name editing (3) and the
 * wire-level no-request check (1).
 *
 * g-064 moved the pass count 681 → 684: it added 6 tests (the filled-in unnamed
 * row being refused, the blank row not blocking the save, the named save's narrow
 * paths, the validator's own row numbers, and a page case for the visible marker
 * plus the name field) and *rewrote* 2 that pinned the old contract — "an unnamed
 * row is skipped" and "an unnamed row is never written, and survives the save"
 * both asserted a save that returned `true` and wrote nothing, which is the bug.
 * No test was deleted: the two survivors assert the row is still never written
 * *and* is now refused with the row number.
 */
/**
 * Lower bound on the plugin suite's size; the run is refused below it, so a
 * loader bug that silently executes nothing cannot pass for a green baseline.
 *
 * g-068 (att-002) raised the observed count to 780 with five tests that pin
 * per-call attribution under overlapping calls, the append-only ledger, the
 * vLLM "no evidence means unknown" rule and the panel projection. The floor
 * follows the real count so the comment no longer drifts from the suite.
 */
const EXPECTED_TESTS = 780;

/** Each fault targets one acceptance area of the goal. */
const MUTATIONS = [
  {
    name: 'drop-tool-at-registration',
    area: 'registers every enabled tool',
    file: 'src/index.ts',
    from: 'for (const definition of defineReflexTools(runtime, config, seam)) {',
    to: 'for (const definition of defineReflexTools(runtime, config, seam).slice(0, 3)) {'
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
      '      inheritance.dispose();',
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
    // g-056: the gate is now `onVirtualRoute`, computed once per step from the
    // caller's intent and the step's own selection.
    from: "  const onVirtualRoute = routes && ((intent !== undefined && router.owns(intent)) || stepOwnsRoute);",
    to: "  const onVirtualRoute = routes;"
  },
  {
    name: 'route-cancelled-request',
    area: 'cancellation is respected',
    file: 'src/routing.ts',
    // g-056: the request waterfall no longer decides anything, so the guard that
    // matters is the one in front of the step's decision.
    from: '  if (signal?.aborted) return undefined;',
    to: '  if (false) return undefined;'
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
    from: '  const decidedEffort = resolution.changed ? resolution.effort : requested;',
    to: '  const decidedEffort = requested;'
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
    from: '    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {',
    to: '    if (false) {'
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
    from: '    rememberTarget(facts, agent, decision.target);',
    to: '    if (false) rememberTarget(facts, agent, decision.target);'
  },
  {
    name: 'routing-reports-no-context',
    area: 'the context a session accumulated reaches the decision',
    file: 'src/routing.ts',
    from: '      contextTokens: estimateContextTokens(remembered?.contextChars ?? 0)',
    to: '      contextTokens: 0'
  },
  {
    name: 'panel-drops-switched-flag',
    area: 'the panel shows whether a decision switched models',
    file: 'src/panel-api.ts',
    from: '    ...(switched === undefined ? {} : { switched }),',
    to: ''
  },
  // The pruning decision itself now lives in the shared core, which the plugin
  // vendors verbatim; these faults are injected into the vendored copy so they
  // exercise exactly the code that decides at runtime.
  {
    name: 'prune-ignores-action-ceiling',
    area: 'a reduction draws on the turn’s shared action ceiling',
    file: 'src/vendor/harness-reflex/core/orchestrate.ts',
    // The size gates are left intact: only the ceiling check disappears, so a turn
    // with no allowance left still plans reductions.
    from: '  if (!actionWithinBudget(port.budget(), port.policy())) {',
    to: '  if (false) {'
  },
  {
    name: 'prune-observe-action-unbooked',
    area: 'a planned action is booked in both modes',
    file: 'src/vendor/harness-reflex/core/orchestrate.ts',
    from: ['    bookAction(port.budget());', '    port.conclude(plan, false, planCosts, judgment);'].join('\n'),
    to: '    port.conclude(plan, false, planCosts, judgment);'
  },
  {
    name: 'prune-applied-action-unbooked',
    area: 'an installed reduction is booked',
    file: 'src/vendor/harness-reflex/core/orchestrate.ts',
    from: ['  bookAction(port.budget());', '  const installedCosts = {'].join('\n'),
    to: '  const installedCosts = {'
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
    // The window rule moved into the shared core with the stagnation decision
    // (P2), so the fault is injected where the rule now lives — the vendored
    // copy is what decides at runtime, exactly as for the prune faults above.
    name: 'wait-steps-count-as-progress',
    area: 'a wait is not progress a run can be repeating',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: "return steps.some((step) => step.wait === true) ? steps.filter((step) => step.wait !== true) : steps;",
    to: 'return steps;'
  },
  // The stagnation decision itself now lives in the shared core (P2). These
  // faults target the rules that moved there, one per rule a reader would most
  // expect a refactor to lose.
  {
    name: 'stagnation-refuses-a-stricter-decision',
    area: 'a refusal is only ever added on top of an allow',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: "  return downstreamKind === 'allow';",
    to: '  return true;'
  },
  {
    // The line that only active mode may add a refusal. Without it a call the
    // waterfall allowed is vetoed while the capability is only observing.
    name: 'stagnation-observe-blocks',
    area: 'observe plans a refusal without refusing anything',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: "  const applies = mode === 'active' && mayAddDecision(invocation.downstreamKind);",
    to: '  const applies = mayAddDecision(invocation.downstreamKind);'
  },
  {
    // Anchored on the refusal's own return, so it is the pre-execute site and not
    // the pre-step one that loses its booking.
    name: 'stagnation-refusal-unbooked',
    area: 'a planned refusal draws on the turn\'s action ceiling',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: [
      '  port.latchIntervened();',
      '  bookAction(port.budget());',
      '  port.conclude(plan, applies, charge);',
      '  return applies',
      "    ? { result: port.deny(plan.feedback), action: 'deny' }"
    ].join('\n'),
    to: [
      '  port.latchIntervened();',
      '  port.conclude(plan, applies, charge);',
      '  return applies',
      "    ? { result: port.deny(plan.feedback), action: 'deny' }"
    ].join('\n')
  },
  {
    // ... and this one on the correction's, which returns `port.correct`.
    name: 'correction-unbooked',
    area: 'a planned correction draws on the same ceiling',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: [
      '  port.latchIntervened();',
      '  bookAction(port.budget());',
      '  port.conclude(plan, applies, charge);',
      '  return applies',
      '    ? { result: port.correct(plan.feedback), action: \'allow\' }'
    ].join('\n'),
    to: [
      '  port.latchIntervened();',
      '  port.conclude(plan, applies, charge);',
      '  return applies',
      '    ? { result: port.correct(plan.feedback), action: \'allow\' }'
    ].join('\n')
  },
  {
    // The pre-step guard that keeps a legitimate poll from being corrected as a
    // loop. Its fault removes the branch entirely, so a judged wait falls through
    // to the repetition trigger.
    name: 'wait-step-not-exempt-in-pre-step',
    area: 'a judged poll is not corrected as a loop',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    from: "    port.skip(port.wasClassifiedAsWait(last.signature) ? 'wait-query' : 'wait-query-unjudged');\n    return passThrough();",
    to: '    void 0;'
  },
  {
    name: 'stagnation-episode-not-latched',
    area: 'one episode is acted on once, not once per attempt',
    file: 'src/vendor/harness-reflex/core/orchestrate-stagnation.ts',
    // Anchored on the refusal's own `noteRefused`, which the pre-step hook does
    // not have, so this is the pre-execute site.
    from: ['  invocation.noteRefused?.();'].join('\n'),
    to: ['  void 0;'].join('\n')
  },
  // The failure-correction decision now lives in the shared core (P3). These
  // faults target the order and the rules that moved there, one per rule a
  // reader would most expect a refactor to lose.
  {
    name: 'correction-ignores-action-ceiling',
    area: 'a correction draws on the turn\u2019s shared action ceiling',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    // The trigger and the latch are left intact: only the ceiling check
    // disappears, so an episode with no allowance left is still corrected.
    from: '  if (!actionWithinBudget(port.budget(), port.policy())) {',
    to: '  if (false) {'
  },
  {
    name: 'correction-episode-not-latched',
    area: 'one failure episode is corrected once, not once per attempt',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    from: '  if (port.alreadyCorrected()) {',
    to: '  if (false) {'
  },
  {
    name: 'correction-rewrites-a-blocked-result',
    area: 'a result the rest of the waterfall blocked is left alone',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    from: '  if (invocation.blockedByDownstream) return passThrough();',
    to: '  void 0;'
  },
  {
    // The line that only active mode may install the rewrite. Without it the
    // model reads a correction while the capability is only observing.
    name: 'correction-observe-installs',
    area: 'observe plans a correction without installing it',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    from: "  const applies = mode === 'active';",
    to: '  const applies = true;'
  },
  {
    // Named apart from the stagnation batch's `correction-unbooked` (that one is
    // the pre-step message); this is post-execute's rewritten result.
    name: 'correction-feedback-unbooked',
    area: 'a planned correction draws on the same ceiling',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    from: ['  bookAction(port.budget());', '  port.conclude(plan, applies, charge);'].join('\n'),
    to: '  port.conclude(plan, applies, charge);'
  },
  {
    name: 'correction-judgment-unbilled',
    area: 'a judgment whose plan was abandoned is still billed',
    file: 'src/vendor/harness-reflex/core/orchestrate-correction.ts',
    from: ['    port.chargeJudgment(charge);', '    const skip'].join('\n'),
    to: '    const skip'
  },
  {
    name: 'correction-dsh-window-filtered',
    area: 'a failing poll is still a failure to correct',
    file: 'src/interventions.ts',
    // Anchored on the two neighbouring port methods, because the stagnation ports
    // have the same window line and must keep theirs.
    from: [
      '      error: () => error,',
      '      // Deliberately the raw window, not the progress-only one: see the doc above.',
      '      window: () => state.steps,'
    ].join('\n'),
    to: [
      '      error: () => error,',
      '      // Deliberately the raw window, not the progress-only one: see the doc above.',
      '      window: () => sharedProgressSteps(state.steps),'
    ].join('\n')
  },
  // ── the closing check (P4) ────────────────────────────────────────────────
  // The closing decision is the one whose *only* model-visible consequence is a
  // steered message, so each fault below makes the check say something it must
  // not (or act when it must not). None of them can be caught by the prune or
  // stagnation anchors: they all target a file those batches never wrote.
  {
    // The single most dangerous fault in this batch: an undecided verdict is how
    // an unavailable backend degrades, and steering on it turns a service failure
    // into a model-visible objection.
    name: 'closing-escalate-steers',
    area: 'an undecided verdict is never turned into an objection',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "    .filter((item) => item.outcome === 'contradicted')",
    to: "    .filter((item) => item.outcome === 'contradicted' || item.outcome === 'escalate')"
  },
  {
    // `evidence-truncated` is the one note that must not return. Making it a
    // refusal disables the check on exactly the long runs that need it.
    name: 'closing-truncation-refuses',
    area: 'truncated evidence is noted, and the decision continues',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "  if (assembled.truncatedChars > 0) note('evidence-truncated');",
    to: "  if (assembled.truncatedChars > 0) return refuse('evidence-truncated');"
  },
  {
    // The latch is the turn, not the signature: a closing episode is the turn
    // itself, so dropping it objects at every boundary of the same turn.
    name: 'closing-turn-not-latched',
    area: 'one turn is objected to once, not once per boundary',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "  if (port.alreadyObjected()) return refuse('duplicate-intervention');",
    to: "  if (false) return refuse('duplicate-intervention');"
  },
  {
    // The classifier failing is a decision-local fail-open with its own reason.
    // Folding it into the outer catch loses which half of the judgment was down.
    name: 'closing-classifier-not-local',
    area: 'an unavailable classifier fails open inside the decision',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "    return refuse('closing-claim-unavailable');",
    to: "    throw new Error('classifier unavailable');"
  },
  {
    // Observe measures the same decision active would make. Publishing in it
    // would make the mode a second policy rather than a preview.
    name: 'closing-observe-steers',
    area: 'observe plans the objection without steering it',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "  const applies = mode === 'active';",
    to: '  const applies = true;'
  },
  {
    // The ceiling is asked before the judgment, so a refused turn buys nothing.
    name: 'closing-cap-after-judgment',
    area: 'the turn ceiling is asked before any judgment is bought',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "  if (!actionWithinBudget(state, policy)) return refuse('intervention-cap');",
    to: "  if (false) return refuse('intervention-cap');"
  },
  {
    // Two requests, one judgment. Billing the classification separately spends a
    // slot the turn budget did not grant.
    name: 'closing-classification-not-billed',
    area: 'a classification that finds no claim is still billed',
    file: 'src/vendor/harness-reflex/core/orchestrate-closing.ts',
    from: "    return refuse('closing-no-claim', classificationCharge);",
    to: "    return refuse('closing-no-claim');"
  },
  {
    // The engine-level counter is not per-agent; dropping it leaves the panel
    // reporting a number no run produced.
    name: 'closing-evidence-not-counted',
    area: 'the engine-level evidence counters record what was assembled',
    file: 'src/interventions.ts',
    from: [
      '        noteEvidence: (stats) => {',
      '          this.#evidenceStats.retainedChars += stats.retainedChars;'
    ].join('\n'),
    to: [
      '        noteEvidence: (stats) => {',
      '          this.#evidenceStats.retainedChars += 0;'
    ].join('\n')
  },
  {
    // The empty-state rule: `off` must leave no trace, not even an agent state.
    name: 'closing-off-creates-state',
    area: 'a capability that is off leaves no trace at all',
    file: 'src/interventions.ts',
    from: "    if (this.modeOf('closing') === 'off' || !this.config.enabled) return;\n    const started = this.#now();",
    to: "    const started = this.#now();"
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
  },
  {
    name: 'backend-swap-frozen',
    area: 'a backend/systemOne save swaps the transport',
    file: 'src/bridge.ts',
    from: '      this.#liveBackend.swap(createBackend(resolved));',
    to: '      if (false) this.#liveBackend.swap(createBackend(resolved));'
  },
  {
    name: 'ledger-sink-frozen',
    area: 'a ledgerPath save moves the JSONL sink',
    file: 'src/bridge.ts',
    from: '    if (resolved.ledgerPath !== this.#ledgerPath) {',
    to: '    if (false) {'
  },
  {
    name: 'routing-lifecycle-frozen',
    area: 'routing.enabled and the provider name reconcile live',
    file: 'src/bridge.ts',
    from: '    this.#reconfigureRouting?.(resolved.routing);',
    to: '    if (false) this.#reconfigureRouting?.(resolved.routing);'
  },
  {
    name: 'delegate-default-off',
    area: 'reflex_delegate is on by default and switchable',
    file: 'src/tools.ts',
    from: '  delegate: true\n};',
    to: '  delegate: false\n};'
  },
  {
    // Type-level: the level has its own union, so the compiler catches it too.
    name: 'delegate-marker-forwarded',
    area: 'the delegated level is a concrete one, never the reflex marker',
    file: 'src/delegation-dispatch.ts',
    from: '        reasoning_effort: effort,',
    to: '        reasoning_effort: "reflex",'
  },
  {
    // Runtime-level, casts past the union: only the *behavioural* assertion
    // (what the Host tool actually received) can catch this one.
    name: 'delegate-marker-forwarded-at-runtime',
    area: 'the delegated level is a concrete one, never the reflex marker',
    file: 'src/delegation-dispatch.ts',
    from: '        reasoning_effort: effort,',
    to: '        reasoning_effort: ("reflex" as unknown) as DelegationEffort,'
  },
  {
    // g-054: the read has to be *scoped*. Dropping the scope argument restores
    // the exact bug — the global view cannot see a preset-hosted tool, so a
    // correctly configured Host reads as "no delegation tool".
    name: 'delegate-inspect-ignores-scope',
    area: 'the delegation probe reads the caller scope, not the global view',
    file: 'src/delegation-dispatch.ts',
    from: '    const definition = ctx.tools.get(candidate, agent);',
    to: '    const definition = ctx.tools.get(candidate);'
  },
  {
    // g-054: registration is decided by configuration alone. Re-introducing a
    // registry probe in the mount path is the regression under test.
    name: 'delegate-registration-probes-global-view',
    area: 'reflex_delegate registers from configuration, not from a mount-time probe',
    file: 'src/index.ts',
    from: '      delegationExecutables(config, DELEGATION_TOOL_NAME)',
    to: '      delegationExecutables(config, ctx.tools.get(DELEGATION_TOOL_NAME) === undefined ? undefined : DELEGATION_TOOL_NAME)'
  },
  {
    name: 'delegate-accepts-injected-level',
    area: 'argument validation is declared by the tool',
    file: 'src/tools.ts',
    from: "          assertDeclaredArguments(name('delegate'), ['prompt', 'description', 'provider', 'model', 'cwd'], args as never);\n",
    to: ''
  },
  {
    // The consent switch is what stands between "the tool works" and "a wrapper
    // that silently drops the level". Defaulting it on is the tempting mistake.
    name: 'delegation-default-on',
    area: 'the delegation capability is opt-in, off by default',
    file: 'src/config.ts',
    from: '  return { enabled: value ?? false };',
    to: '  return { enabled: value ?? true };'
  },
  {
    // Registration must require consent *and* a capable host. Dropping the consent
    // half makes every deployment advertise a tool whose level cannot arrive.
    name: 'delegation-consent-ignored',
    area: 'the delegation capability is opt-in, off by default',
    file: 'src/tools.ts',
    from: '  return config.delegation.enabled && delegateTarget !== undefined ? { delegateTarget } : {};',
    to: '  return delegateTarget !== undefined ? { delegateTarget } : {};'
  },
  {
    // The self-heal's boundary: a broken capability is reported, never repaired.
    // A "helpful" rewrite of the patch is the one thing the design forbids.
    name: 'self-heal-writes-config',
    area: 'a broken capability is withdrawn and reported, never silently repaired',
    file: 'src/delegation-health.ts',
    from: '    } else if (wasAvailable && !reported && next.state === \'model-selection-off\') {',
    to: '    } else if (wasAvailable && !reported && next.state === \'model-selection-off\') {\n      enableHostModelSelection();'
  },
  {
    // A capability that never worked must not warn: warning there is noise about a
    // state the user never had, and it would train people to ignore the line.
    name: 'self-heal-warns-without-a-break',
    area: 'a broken capability is withdrawn and reported, never silently repaired',
    file: 'src/delegation-health.ts',
    from: '    } else if (wasAvailable && !reported && next.state === \'model-selection-off\') {',
    to: '    } else if (!reported \u0026\u0026 next.state === \'model-selection-off\') {'
  },
  {
    // g-054: an unreadable view must stay `unknown`. Reporting it as "the tool is
    // missing" is the false claim the panel showed on every preset-hosted Host.
    name: 'health-unreadable-view-reported-as-missing',
    area: 'an unprobed capability is unknown, never reported as off',
    file: 'src/delegation-health.ts',
    from: '    if (agent === undefined) {\n      return { state: \'unknown\', reason: DELEGATION_UNPROBED_REASON, delegateAvailable: false };\n    }',
    to: '    if (agent === undefined) {\n      return { state: \'missing-tool\', reason: DELEGATION_TOOL_MISSING_REASON, delegateAvailable: false };\n    }'
  },
  {
    // The patch edit must merge, not rewrite. Appending a second row when one
    // exists would shadow the user's own (`provider`, `toolName`, …).
    name: 'patch-edit-always-appends',
    area: 'the profile patch is merged, never rewritten',
    file: 'src/host-patch.ts',
    from: '  if (located.spans.length === 0) {',
    to: '  if (true) {'
  },
  {
    // The whole safety argument for the text editor: refuse what cannot be read
    // exactly. Accepting two same-id rows would silently pick one by loader
    // precedence this module does not implement.
    name: 'patch-edit-accepts-ambiguous-row',
    area: 'the profile patch is merged, never rewritten',
    file: 'src/host-patch.ts',
    from: '  if (located.spans.length > 1) {',
    to: '  if (located.spans.length > 999) {'
  },
  {
    // A row that disables the entry cannot be enabled from underneath it.
    name: 'patch-edit-enables-disabled-row',
    area: 'the profile patch is merged, never rewritten',
    file: 'src/host-patch.ts',
    from: '  if (disabled) {',
    to: '  if (false) {'
  },
  {
    // "Saved" must never read as "in effect": the restart window is the honest
    // answer while the host still refuses the field.
    name: 'panel-claims-no-restart-needed',
    area: 'the panel says a restart applies the write, and never claims otherwise',
    file: 'src/panel-api.ts',
    from: '    restartRequired: enabled && patchEnabled && state === \'model-selection-off\',',
    to: '    restartRequired: false,'
  },
  {
    // The write route must not be reachable by an accidental GET or an unconfirmed
    // POST: it edits a file outside this plugin's settings section.
    name: 'panel-write-route-unguarded',
    area: 'the profile patch is written only on an explicit, confirmed request',
    file: 'src/panel-api.ts',
    from: "      if (readQuery(request.url, 'confirm') !== 'delegation') {",
    to: '      if (false) {'
  },
  {
    name: 'rename-route-frozen',
    area: 'renaming the virtual provider withdraws the old name',
    file: 'src/routing.ts',
    from: '    if (router.virtualProvider !== policy.virtualProvider) renameRoute(policy.virtualProvider);',
    to: '    if (false) renameRoute(policy.virtualProvider);'
  },
  // ── g-056: the decision lives in `agent/pre-step` ──────────────────────────
  {
    // The whole point of the move: a selection the step fixed must be the
    // selection the step is requested with. Dropping the write leaves the marker
    // in place, so the guards compare two different values.
    name: 'pre-step-drops-selection-write',
    area: 'the step decision reaches payload.modelSelection',
    file: 'src/routing.ts',
    from: '        applyPlan(selection, settled);',
    to: '        void [selection, settled];'
  },
  {
    // `next()` inside the try swallows a rejection: a refused step would be
    // admitted instead of failing.
    name: 'next-rejection-swallowed',
    area: 'a rejected step stays rejected',
    file: 'src/routing.ts',
    from: [
      '      // Outside the try: a rejection here must reach the loop unchanged.',
      '      const decision = await next();'
    ].join('\n'),
    to: [
      '      const decision = await next().catch(() => ({ kind: "enter" as const, messages: [] }));'
    ].join('\n')
  },
  {
    // A decision that never returns must not hold the step open.
    name: 'step-decision-unguarded',
    area: 'a hung decision cannot stall a turn',
    file: 'src/routing.ts',
    from: '        const settled = await withBudget(attempt, budget);',
    to: '        const settled = await attempt;'
  },
  {
    // Freezing must degrade, not throw out of the listener.
    name: 'pre-step-write-unguarded',
    area: 'a read-only selection degrades instead of failing the step',
    file: 'src/routing.ts',
    from: '        applyPlan(selection, settled);',
    to: '        (selection as { provider: string }).provider = settled.provider ?? selection.provider;'
  },
  {
    // Later steps of one turn must replay the turn's plan, or System 1 runs
    // once per tool call.
    name: 'followup-step-redispatches',
    area: 'one decision per turn',
    file: 'src/routing.ts',
    from: '  if (remembered?.decided && isFollowupStep && sameVirtualModel && onVirtualRoute) {',
    to: '  if (remembered?.decided !== undefined && isFollowupStep && !sameVirtualModel) {'
  },
  {
    // The non-adaptive alignment moved here too; without the write it is lost.
    name: 'alignment-not-written',
    area: 'a concrete level is aligned before the request',
    file: 'src/routing.ts',
    from: '    return settle(aligned, aligned !== requested);',
    to: '    return settle(requested, false);'
  },
  {
    // The ledger/status must be fed from the decision site, not the request.
    name: 'pre-step-audit-silenced',
    area: 'the decision is audited where it is made',
    file: 'src/routing.ts',
    from: '  if (resolution.status) reportEffort(ctx, agent, resolution.status);',
    to: '  if (resolution.status && resolution.status.latencyMs < 0) reportEffort(ctx, agent, resolution.status);'
  },
  {
    // The intent probe is what keeps routing alive after the first step wrote a
    // physical provider into the selection.
    // The caller's durable intent is what keeps a later turn on the virtual
    // route once a step's selection has been rewritten to the physical target.
    name: 'routing-stops-after-first-step',
    area: 'routing survives its own write',
    file: 'src/routing.ts',
    from: '  const config = resolveAdaptiveIntent(ctx, agent, base, (provider) => router.owns(provider));',
    to: '  const config: LlmCallConfig = base;'
  },
  // Multi-profile System One connections (g-057): the precedence chain, the
  // write-only key, and the page's narrow-path write.
  {
    // The active profile is the whole point of the feature: resolving the flat
    // block over it would silently ignore the user's selection.
    // g-066: the flat block is gone, so the property is now "the active profile is
    // the only source". Resolving the *inactive* one instead is the same class of
    // fault the old anchor covered — the running connection answering to a row the
    // user did not activate.
    name: 'inactive-profile-serves-the-runtime',
    area: 'the active profile is the only connection',
    file: 'src/config.ts',
    from: '  const activeProfile = active === undefined ? undefined : profiles[active];',
    to: '  const activeProfile = active === undefined ? undefined : (Object.values(profiles).find((entry) => entry !== profiles[active]) ?? profiles[active]);'
  },
  {
    // A mistyped active name must be reported, not quietly resolved away.
    name: 'missing-active-profile-is-swallowed',
    area: 'an active name that matches no profile is reported',
    file: 'src/config.ts',
    from: '  const activeProfileMissing = active !== undefined && activeProfile === undefined;',
    to: '  const activeProfileMissing = false;'
  },
  {
    // A profile's own key must outrank the environment variable it names,
    // otherwise a stored secret could never take effect on a host that also
    // exports the variable.
    name: 'profile-key-loses-to-the-environment',
    area: 'a profile key wins over its apiKeyEnv',
    file: 'src/config.ts',
    // g-058: the chain moved into `resolveApiKeyWithSource`; the fault is the same
    // one — a stored profile key losing to the environment variable beside it.
    from: "  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return { key: config.apiKey, source: 'profile' };",
    to: '  if (false) return undefined;'
  },
  {
    // The declared role is the only thing that strips the key at the wire
    // boundary; dropping it would publish every stored secret on the panel.
    name: 'api-key-loses-its-secret-role',
    area: 'apiKey is a schema-declared secret',
    file: 'src/config.ts',
    from: "  apiKey: z\n    .string()\n    .role('secret')",
    to: "  apiKey: z\n    .string()"
  },
  {
    // Write-only means the panel reports presence from facts it gathered, never
    // by reading the value it was handed.
    name: 'panel-projects-the-profile-key-value',
    area: 'the panel projects key presence, never the key',
    file: 'src/panel-api.ts',
    from: '    const keys = keyFacts(name, profile);',
    to: '    const keys = { present: profile.apiKey !== undefined, fromProfile: true };'
  },
  {
    // A whole-group write deletes every stored secret the page never received;
    // this is the exact fault the narrow-path write exists to prevent.
    // g-066: there is no `flat` object any more, so the group write it used to
    // guard against is expressed with the row it would replace: one `set` on the
    // whole `systemOne` subtree deletes every stored secret it does not restate.
    // The activation is written as a narrow path plus the rows, never as a whole
    // `systemOne` group: a group write re-states the block from what the page
    // knows, which does not include the stored `apiKey` (g-066), so it would
    // silently delete every key. g-067 moved the activation out of `groupWrites`
    // and into `diffDraft`; the invariant is the same, so the probe follows it.
    name: 'panel-writes-the-whole-system-one-group',
    area: 'the page writes the connection block on narrow paths only',
    file: 'src/client/panel.ts',
    from: "  if (activationChanged(original, draft)) {\n    ops.push({ op: 'set', path: ['systemOne', 'active'], value: activationTarget });",
    to: "  if (activationChanged(original, draft)) {\n    ops.push({ op: 'set', path: ['systemOne'], value: { active: activationTarget } });"
  },
  {
    // Empty input means "leave the stored key alone": treating it as a write
    // would erase a key the user never saw.
    name: 'empty-key-input-clears-the-stored-key',
    area: 'an empty key input writes nothing',
    file: 'src/client/panel.ts',
    from: '        } else if (profile.apiKey.trim().length > 0) {',
    to: '        } else if (true) {'
  },
  {
    // A probe must classify a rejected key apart from an unreachable host.
    name: 'probe-collapses-auth-failure-into-unreachable',
    area: 'the connection probe distinguishes a rejected key from a dead endpoint',
    file: 'src/systemone-probe.ts',
    from: '  if (status === 401 || status === 403) {',
    to: '  if (false) {'
  },
  {
    // The probe's detail is redacted before it leaves; an unredacted echo would
    // publish whatever the gateway reflected back.
    name: 'probe-detail-is-not-redacted',
    area: 'the probe redacts every credential-shaped substring',
    file: 'src/systemone-probe.ts',
    from: '  out = out.replace(/Bearer\\s+[^\\s\"\',;}]+/gi, \'Bearer ***\');',
    to: '  out = out;'
  },
  // One API-key chain (g-058): the panel, the backend construction, and the
  // probe all resolve the key through `resolveApiKeyWithSource`. Each fault below
  // makes one of them disagree with the others — the exact shape of the bug
  // ("the panel says the env var is empty while the backend works").
  {
    // g-059 reversed this one. Naming a variable now LOCKS the lookup, so the
    // fault is the old behaviour coming back: a named-but-empty variable falling
    // through to the fallback list, i.e. the panel reporting a lock the runtime
    // never honoured.
    name: 'named-empty-variable-falls-through-to-the-fallback',
    area: 'naming a variable locks the lookup (g-059)',
    file: 'src/config.ts',
    from: "    return { missing: 'named', variable: config.apiKeyEnv };",
    to: '    return undefined;'
  },
  {
    // The fallback loop must not run when a variable was named: even if the lock
    // branch returned, a `for` that still executes would let a fallback variable
    // answer a locked lookup.
    name: 'fallback-loop-runs-after-a-lock',
    area: 'a locked lookup never consults the fallback list',
    file: 'src/config.ts',
    from: "export function resolvedKeyOf(resolution: ApiKeyResolution | undefined): string | undefined {\n  return resolution === undefined || !('key' in resolution) ? undefined : resolution.key;",
    to: "export function resolvedKeyOf(resolution: ApiKeyResolution | undefined): string | undefined {\n  if (resolution !== undefined && !('key' in resolution)) { for (const v of API_KEY_ENV_FALLBACKS) { const x = process.env[v]; if (x) return x; } }\n  return resolution === undefined || !('key' in resolution) ? undefined : resolution.key;"
  },
  {
    // The panel must distinguish "named but empty" from "nothing configured": the
    // two call for different fixes. Collapsing the locked fact to a plain absence
    // is the fault this asserts against.
    name: 'panel-collapses-locked-into-missing',
    area: 'the panel reports a locked lookup separately from an unconfigured one',
    file: 'src/panel-mount.ts',
    from: '    return { apiKeyPresent: false, apiKeyLocked: true, apiKeyVariable: resolved.variable };',
    to: '    return { apiKeyPresent: false };'
  },
  {
    // And the backend must not re-read the environment behind the panel's back:
    // dropping the flag hands a locked (empty) resolution to a backend that would
    // authenticate from SYSTEM_ONE_API_KEY / JEV_API_KEY anyway.
    name: 'backend-drops-the-resolved-key-flag',
    area: 'the plugin backend is told the credential is already resolved (g-059)',
    file: 'src/bridge.ts',
    from: "        // The chain above is the whole chain: no second read behind its back.\n        apiKeyResolved: true,",
    to: '        apiKeyResolved: false,'
  },
  {
    // `auto` is the DEFAULT backend: if the plugin forgets to hand the resolved
    // credential to the factory, the lock silently stops holding for everyone who
    // never configured an explicit backend — the majority of deployments.
    name: 'auto-backend-forgets-the-resolved-key',
    area: 'the default `auto` backend honours the locked lookup (g-059)',
    file: 'src/bridge.ts',
    from: '        ...(apiKey === undefined ? {} : { apiKey }),\n        // The chain above is the whole chain: no second read behind its back.\n        apiKeyResolved: true,',
    to: '        // The chain above is the whole chain: no second read behind its back.\n        apiKeyResolved: true,'
  },
  {
    // g-067 att-002, the blocking defect itself: the shipped factory row must bind
    // its implementation. Without `backend` a fresh document resolves to `auto`,
    // which reads the environment — the key leak the review captured.
    name: 'factory-row-does-not-bind-its-implementation',
    area: 'the factory connection cannot be redirected by the environment (g-067 att-002)',
    file: 'src/config.ts',
    from: "  apiKeyEnv: FACTORY_PROFILE_API_KEY_ENV,\n  backend: 'jev'\n}) satisfies Readonly<ReflexSystemOneProfile>;",
    to: "  apiKeyEnv: FACTORY_PROFILE_API_KEY_ENV\n}) satisfies Readonly<ReflexSystemOneProfile>;"
  },
  {
    // The test button must ask the same resolver as the runtime. Pinning it back
    // to "auto means Jev" is the false green the review found.
    name: 'probe-hardcodes-auto-as-jev',
    area: 'the connection test probes what the runtime runs (g-067 att-002)',
    file: 'src/systemone-probe.ts',
    from: '  const backend = connectionImplementation(target.backend, env);',
    to: "  const backend = target.backend === 'auto' ? 'jev' : target.backend;"
  },
  {
    // An explicit top-level `mock` must keep meaning "answer in-process": the
    // factory row's bound `jev` otherwise turns local deployments into live calls.
    name: 'factory-binding-overrules-an-explicit-mock',
    area: 'an explicit mock deployment still answers in-process (g-067 att-002)',
    file: 'src/config.ts',
    from: "  if ((selected === 'mock' || selected === 'vllm') && rowBackend === 'jev' && isShippedFactoryRow(profile)) {",
    to: "  if (false && (selected === 'mock' || selected === 'vllm') && rowBackend === 'jev' && isShippedFactoryRow(profile)) {"
  },
  {
    // The factory must not re-read the environment for the key once the caller
    // resolved it, while still selecting the provider from that same environment.
    name: 'factory-rereads-the-environment-for-a-resolved-key',
    area: 'the vendored factory never re-reads the key once it is resolved',
    file: 'src/vendor/harness-reflex/backend/factory.ts',
    from: '    override?.apiKeyResolved === true',
    to: '    false'
  },
  {
    // The vendored Jev backend must honour that flag; without it the transport
    // reads the environment even when the caller resolved "no key".
    name: 'vendored-jev-ignores-the-resolved-flag',
    area: 'the vendored Jev backend never re-reads the environment once resolved',
    file: 'src/vendor/harness-reflex/backend/jev.ts',
    from: '      config?.apiKeyResolved === true',
    to: '      false'
  },
  {
    // The fallback order is the documented priority; reversing it silently makes
    // a stale OPENAI_API_KEY outrank the gateway key the user actually exports.
    name: 'key-fallback-order-reversed',
    area: 'the fallback chain keeps its documented order',
    file: 'src/config.ts',
    from: '  for (const variable of API_KEY_ENV_FALLBACKS) {',
    to: '  for (const variable of [...API_KEY_ENV_FALLBACKS].reverse()) {'
  },
  {
    // The panel reports *where* the key came from. Reporting the variable the
    // configuration named instead of the one that answered is the exact false
    // claim this goal removes.
    name: 'panel-reports-the-named-variable-not-the-resolved-one',
    area: 'the panel reports the variable that supplied the key',
    file: 'src/panel-mount.ts',
    from: '    ...(resolved.variable === undefined ? {} : { apiKeyVariable: resolved.variable })',
    to: '    ...(resolved.variable === undefined ? {} : { apiKeyVariable: systemOne.apiKeyEnv })'
  },
  {
    // Readiness must come from the chain, not from "did the block name a
    // variable": presence is the fact the page renders.
    // Readiness must come from the chain, not from "did the block name a
    // variable": presence is the fact the page renders. g-059 split the outcome
    // into three branches, so the fault is aimed at the *resolved* one — report
    // "absent" whenever nothing was named by hand, i.e. ignore a fallback that
    // actually supplied a key.
    name: 'panel-readiness-ignores-the-resolved-key',
    area: 'the panel readiness follows the resolved chain',
    file: 'src/panel-mount.ts',
    from: "  return {\n    apiKeyPresent: true,\n    apiKeySource: resolved.source,",
    to: "  return {\n    apiKeyPresent: systemOne.apiKeyEnv !== undefined,\n    apiKeySource: resolved.source,"
  },
  {
    // The probe and the real request must send the same credential. Reverting the
    // probe to "the one named variable" restores the test-button/runtime split.
    name: 'probe-skips-the-fallback-chain',
    area: 'the connection probe sends the key the runtime would send',
    file: 'src/systemone-probe.ts',
    from: '  const key = resolvedKeyOf(resolveApiKeyWithSource(target, env));',
    to: "  const key = target.apiKeyEnv === undefined ? undefined : env[target.apiKeyEnv];"
  },
  {
    // The backend construction must receive the chain-resolved key explicitly;
    // without it a fallback-var key reaches the transport only through the
    // backend's own read, which the panel cannot see.
    name: 'backend-drops-the-resolved-key',
    area: 'the backend is constructed with the chain-resolved key',
    file: 'src/bridge.ts',
    from: '  const apiKey = resolvedKeyOf(resolveApiKeyWithSource(config.systemOne, env));',
    to: '  const apiKey = undefined;'
  },
  // g-066 removed the flat connection block (and its fold) outright. The fault this
  // entry guarded — "the compatibility fold starts open" — has no code left to
  // inject into, so it is retired rather than re-pointed; the fence it served is
  // now `flat-editor-comes-back`, which asserts the whole surface stays absent.
  {
    // g-063 B: the earlier turns are what makes a short prompt decidable. Dropping
    // them from the composed input is the "grade the few characters alone"
    // behaviour the goal removes, and it must never reach a backend again.
    name: 'decision-input-drops-the-earlier-turns',
    area: 'every decision input carries the recent turns',
    file: 'src/effort.ts',
    from: '  const parts = [formatPreviousLevelLine(fromState), context, task].filter((part) => part.length > 0);',
    to: '  const parts = [formatPreviousLevelLine(fromState), task].filter((part) => part.length > 0);'
  },
  {
    // g-063 B: the previous level is the one piece of state the decision is told
    // about. Never handing it over makes `lastAdaptiveEffort` write-only again.
    name: 'previous-level-never-reaches-the-decision',
    area: 'the previous level is part of the decision input',
    file: 'src/routing.ts',
    from: '    ...(remembered?.lastAdaptiveEffort ? { previousLevel: remembered.lastAdaptiveEffort } : {}),',
    to: '    ...(undefined && remembered?.lastAdaptiveEffort ? { previousLevel: remembered.lastAdaptiveEffort } : {}),'
  },
  {
    // g-063 A: a later step of the same turn replays the turn's decision. Asking
    // again whenever a step carries text is the per-step re-decision this goal
    // removes, and it makes one turn oscillate between levels.
    name: 'later-step-of-a-turn-decides-again',
    area: 'a turn is decided once, whatever its later steps carry',
    file: 'src/routing.ts',
    from: '    remembered.decided.turn === input.turn &&\n    // A config-only save',
    to: '    remembered.decided.turn === input.turn &&\n    task === undefined &&\n    // A config-only save'
  },
  // ── g-066: one connection, its model list, and the write-only key ──────────
  // Each fault restores a behaviour the goal removes, so "the suite stayed green"
  // is exactly the regression the user reported.
  {
    // The flat block is the fallback the goal deletes: letting it answer again
    // makes a document with no active profile connect to an address nobody
    // selected.
    name: 'unconfigured-falls-back-to-a-flat-field',
    area: 'nothing connects without an active profile',
    file: 'src/config.ts',
    from: "    return { ...authoredShape, unconfigured };",
    to: "    return { ...authoredShape, unconfigured, ...(optionalText(authored?.baseUrl) === undefined ? {} : { baseUrl: optionalText(authored?.baseUrl) }) };"
  },
  {
    // `createBackend` is the last gate before the wire: skipping it means the
    // vendored factory picks a provider from the environment and starts calling.
    name: 'unconfigured-connects-through-the-factory',
    area: 'an unconfigured activation makes no external request',
    file: 'src/bridge.ts',
    from: "  if (config.systemOne.unconfigured !== undefined) {\n    return new UnconfiguredBackend(config.systemOne.unconfigured);\n  }",
    to: '  void config.systemOne.unconfigured;'
  },
  {
    // The radio group must reach the page as `Field`'s control. Passing it as a
    // `children` key of the props object loses it (h overwrites it with the empty
    // third-argument list), so the row rendered its label and help but no radios
    // at all — invisible to every unit test of the group itself.
    name: 'model-radios-never-render',
    area: 'the multi-model selection renders as radios on the page',
    file: 'src/client/view.ts',
    from: '  if (ids.length === 0) return null;\n  // Rendered through `Field`',
    to: '  if (ids.length >= 0) return null;\n  // Rendered through `Field`'
  },
  {
    // A broken selection must resolve to *no* model. Falling back to the first
    // id is the "runs a model I did not pick" behaviour (g-066 att-002).
    name: 'invalid-selection-runs-the-first-model',
    area: 'a selection outside the list never runs another model',
    file: 'src/config.ts',
    from: "  if (selected.missing === true) return { unusable: 'model-selection-invalid' };",
    to: '  if (selected.missing === true) return { model: modelIds[0] };'
  },
  {
    // The refusal that stops a transport being built for an unusable model.
    // Without it the backend's own `|| DEFAULT_MODEL` sends a model nobody
    // selected — the finding that blocked att-001.
    name: 'unusable-model-still-connects',
    area: 'an unusable model builds no transport at all',
    file: 'src/config.ts',
    from: '  if (planned.unusable !== undefined) return { ...connection, unconfigured: planned.unusable };',
    to: '  if (planned.unusable !== undefined) return { ...connection, model: planned.model };'
  },
  {
    // The selection must be refused where it is authored, not stored and
    // re-interpreted later.
    name: 'author-a-selection-outside-the-list',
    area: 'a selection outside the list is refused on save',
    file: 'src/config.ts',
    from: '  if (selectedModel !== undefined && !modelIds.includes(selectedModel)) {',
    to: '  if (false) {'
  },
  {
    // The probe must test the *selected* model. Probing the first one reports on
    // a request the runtime never sends.
    name: 'probe-tests-another-model',
    area: 'the connection test probes the selected model',
    file: 'src/config.ts',
    from: '  const resolved = plannedModel(modelIds, backend, modelForProfile(profile, modelIds));',
    to: '  const resolved = { model: modelIds[0] };'
  },
  {
    // The rename guard is the only thing standing between a rename and a lost
    // credential: without it the save succeeds and the key is gone.
    name: 'rename-drops-the-secret-guard',
    area: 'a rename never loses a stored key silently',
    file: 'src/client/rename-secrets.ts',
    from: "    if (!was.apiKeyFromProfile) continue;",
    to: '    continue;'
  },
  {
    // Blocking an env-backed rename makes every environment-variable deployment
    // unable to rename its connection — the guard must stay narrow.
    name: 'rename-blocks-every-row',
    area: 'renaming an env-backed connection still saves',
    file: 'src/client/rename-secrets.ts',
    from: "    if (!was.apiKeyFromProfile) continue;",
    to: '    void was.apiKeyFromProfile;'
  },
  {
    // The name must stay an editable input for a *named* row: rendering text once
    // the row is named is the reported "locked after one character" bug.
    name: 'named-row-name-is-not-editable',
    area: 'a saved row can be renamed',
    file: 'src/client/view.ts',
    // The name field stops accepting edits — the visible symptom of the bug: the
    // control still renders, the caret still lands in it, and typing does nothing.
    from: "        'data-profile-name': profile.id,",
    to: "        'data-profile-name': profile.id,\n        readOnly: true,"
  },
  {
    // The compatibility editor is gone; re-rendering it is the two-editors problem
    // the goal removes (and the second one writes nothing the runtime reads).
    name: 'flat-editor-comes-back',
    area: 'the flat connection editor is gone',
    file: 'src/client/view.ts',
    // The flat values are read back *and rendered*: the runtime card regains them
    // as visible fields, which is the two-editors problem the goal removes. A
    // draft-only mutation would be unobservable — this one reaches the screen.
    from: "        { style: S.field },\n        h(\n          'div',\n          { style: S.fieldRow },\n          GuidedField({\n            t,\n            path: 'backend',",
    to: "        { style: S.field },\n        h('div', { 'data-reflex-path': 'systemOne.baseUrl' }, 'flat again'),\n        h(\n          'div',\n          { style: S.fieldRow },\n          GuidedField({\n            t,\n            path: 'backend',"
  },
  {
    // The page must not write the flat fields back: a save that addresses them
    // would rewrite (or delete) a document it no longer reads.
    name: 'save-writes-a-flat-field',
    area: 'a save never writes the flat connection fields',
    file: 'src/client/panel.ts',
    // `groupWrites` runs for both the baseline and the draft, so a fault inside it
    // cancels out and the per-path filter drops it. The save pipeline is where a
    // stray write becomes real: an extra flat path reaching the Host.
    from: "  for (const group of DRAFT_GROUPS) {\n    const before = groupWrites(original, group);",
    to: "  ops.push({ op: 'set', path: ['systemOne', 'baseUrl'], value: 'http://flat' });\n  for (const group of DRAFT_GROUPS) {\n    const before = groupWrites(original, group);"
  }
];

/**
 * How long a single child command may run before it is killed.
 *
 * Without this bound a fault that sends the suite into a loop hangs the whole
 * negative control with no output at all: `execFileSync` blocks the parent, so
 * nothing is ever flushed and the run looks identical to a slow one. A timed-out
 * command is reported as a failure whose cause names the timeout, which makes the
 * offending mutation visible instead of mysterious.
 */
const COMMAND_TIMEOUT_MS = Number(process.env.REFLEX_MUTATION_TIMEOUT_MS ?? 180_000);

/**
 * Run one command in the scratch copy.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @returns {{ ok: boolean, output: string, timedOut?: boolean }} the outcome, its combined
 *   output, and whether the command had to be killed for exceeding the time bound.
 */
function run(command, args) {
  const started = Date.now();
  try {
    const output = execFileSync(command, args, {
      cwd: workDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    });
    return { ok: true, output };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    // A killed child and a failing child both land here; only the signal tells
    // them apart, and the difference decides whether the mutation was caught or
    // the harness gave up.
    if (error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        timedOut: true,
        output: `${stdout}${stderr}\n[timeout] ${command} ${args.join(' ')} exceeded ${COMMAND_TIMEOUT_MS}ms after ${elapsed}s`
      };
    }
    return { ok: false, output: `${stdout}${stderr}` };
  }
}

/**
 * Re-copy pristine sources, the tsconfig, and the published manifest and client
 * artifact into the scratch copy.
 *
 * The client half's tests read `package.json`, `README.md` and the generated
 * `client.js` as the DSH loader would, so the copy has to carry them; otherwise
 * the baseline would be red for a missing file rather than for a real fault.
 */
function resetSources() {
  rmSync(path.join(workDir, 'src'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(path.join(workDir, 'dist'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(srcDir, path.join(workDir, 'src'), { recursive: true });
  cpSync(path.join(packageDir, 'tsconfig.json'), path.join(workDir, 'tsconfig.json'));
  cpSync(path.join(packageDir, 'package.json'), path.join(workDir, 'package.json'));
  cpSync(path.join(packageDir, 'tsconfig.client.json'), path.join(workDir, 'tsconfig.client.json'));
  cpSync(path.join(packageDir, 'README.md'), path.join(workDir, 'README.md'));
  cpSync(path.join(packageDir, 'client.js'), path.join(workDir, 'client.js'));
  // The guides travel with the copy: the embedded guide and its provenance check
  // must describe *this* copy's documents (see `repoRoot`).
  cpSync(path.join(repoRoot, 'USER_GUIDE.md'), path.join(workDir, 'USER_GUIDE.md'));
  cpSync(path.join(repoRoot, 'docs', 'USER_GUIDE.en.md'), path.join(workDir, 'docs', 'USER_GUIDE.en.md'));
  cpSync(path.join(repoRoot, 'scripts', 'embed-user-guide.mjs'), path.join(workDir, 'scripts', 'embed-user-guide.mjs'));
}

/**
 * Build the scratch copy: the Host half, the browser half, and the artifact the
 * client tests load. The client bundle is generated from source here, so a fault
 * injected into `src/client/**` reaches the tests exactly as a real build would.
 * @returns true when every stage succeeded.
 */
function build() {
  // Regenerate the embedded guide from the copy's own documents first, exactly as
  // `npm run build:all` does in a checkout. The script resolves its root from its
  // own location, so the copy carries its own `scripts/embed-user-guide.mjs` — run
  // from here it writes the copy's `guide.generated.ts`, never this checkout's.
  if (!run(process.execPath, [path.join('scripts', 'embed-user-guide.mjs')]).ok) return false;
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
 * Tests this machine cannot pass for reasons that have nothing to do with this
 * package, matched by their reported name.
 *
 * The baseline has to be green for the negative control to mean anything, and a
 * red baseline would disable the whole run — so an environment-dependent failure
 * is excused explicitly and *by name and count*, never by tolerating arbitrary
 * red. Each entry is a fact about the machine, verified to fail identically on
 * the commit this branch was cut from:
 *
 * - `an unresolvable host is unreachable` expects a resolver that fails fast.
 *   This WSL2 host's `/etc/resolv.conf` lists two unreachable nameservers, so
 *   `reflex-probe.invalid` never answers and the probe reports `timeout` at its
 *   bound instead of `unreachable`. Nothing about it changed in this branch.
 */
const ENVIRONMENT_FAILURES = ['an unresolvable host is unreachable'];

/**
 * Split a suite run into its failing test names.
 * @param output - the run's combined output.
 * @returns the names reported under the runner's "failing tests" section.
 */
function failingTests(output) {
  const start = output.indexOf('failing tests:');
  if (start === -1) return [];
  return [...output.slice(start).matchAll(/^✖ (.+?)(?: \([\d.]+ms\))?$/gm)].map((match) => match[1]);
}

/**
 * Whether one run failed *only* for the excused environment failures.
 * @param outcome - a {@link run} result.
 * @param executed - how many tests passed.
 * @returns true when the run is green apart from the excused names.
 */
function greenApartFromEnvironment(outcome, executed) {
  if (outcome.ok) return true;
  if (executed < EXPECTED_TESTS) return false;
  const failing = failingTests(outcome.output);
  if (failing.length === 0) return false;
  return failing.every((name) => ENVIRONMENT_FAILURES.includes(name));
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

/**
 * Print one progress line for a step that is about to run.
 *
 * The whole run is a chain of blocking `execFileSync` calls, so without this the
 * process emits nothing between start and finish and a stall is indistinguishable
 * from a slow suite. Writing straight to stderr keeps the lines visible even when
 * stdout is redirected into a file.
 * @param {string} label - what is starting.
 */
function announce(label) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);
}

resetSources();
announce('baseline: building the unmutated copy');
const baselineBuild = build();
announce(`baseline: build ${baselineBuild ? 'ok' : 'FAILED'}, running the suite`);
const baselineTest = baselineBuild ? test() : { ok: false, output: 'build failed', executed: 0 };
const baselineGreen =
  baselineBuild && baselineTest.executed >= EXPECTED_TESTS && greenApartFromEnvironment(baselineTest, baselineTest.executed);
results.push({ name: '(unmutated copy)', area: 'baseline', ok: baselineGreen });
if (!baselineGreen) {
  failed = true;
  console.error(
    `baseline copy is not green (built=${baselineBuild}, exit=${baselineTest.ok ? 0 : 1}, executed=${baselineTest.executed}) — the negative control cannot judge anything`
  );
  console.error(baselineTest.output.split('\n').slice(-15).join('\n'));
} else {
  announce(`baseline: GREEN (${baselineTest.executed} tests); injecting ${MUTATIONS.length} faults`);
  let index = 0;
  for (const mutation of MUTATIONS) {
    index += 1;
    announce(`[${index}/${MUTATIONS.length}] ${mutation.name}: building`);
    resetSources();
    mutate(mutation);
    const built = build();
    if (built) announce(`[${index}/${MUTATIONS.length}] ${mutation.name}: build ok, running the suite`);
    const outcome = built ? test() : { ok: false };
    // A fault is caught either by the compiler or by the suite; both count, and
    // the report keeps them apart so the split stays visible. The environment
    // failures excused from the baseline are excused here too — they fail under
    // every fault as well, and counting them would mark every fault "caught".
    //
    // `stage` is the *way* a fault was caught; `undefined` means it was not.
    // A timed-out suite counts as caught — the fault made the suite hang, which
    // is a reaction — but it must arrive as its own label. It used to share the
    // `undefined` branch with "the suite passed", so a timeout was reported as
    // SURVIVED: the exact opposite of the line right above it, and a false alarm
    // on a fault that is genuinely caught whenever the suite fits its budget.
    const stage = !built
      ? 'build'
      : outcome.timedOut
        ? 'timeout'
        : outcome.ok || greenApartFromEnvironment(outcome, outcome.executed)
          ? undefined
          : 'tests';
    if (built && outcome.timedOut) {
      announce(`[${index}/${MUTATIONS.length}] ${mutation.name}: the suite TIMED OUT after ${COMMAND_TIMEOUT_MS}ms`);
    }
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
