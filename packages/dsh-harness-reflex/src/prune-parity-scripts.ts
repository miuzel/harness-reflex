/**
 * The fixed input corpus of the prune parity harness.
 *
 * These scripts are the *inputs* only. They deliberately contain no expected
 * output: the two engines (the frozen pre-refactor snapshot and the live one)
 * are their own oracle, and the harness asserts that they agree. Freezing a
 * hand-written expectation here would make the test a second implementation of
 * the pruning rule, which is exactly what this harness exists to avoid.
 *
 * Every script is a sequence of Host-shaped steps on one agent, replayed
 * through the engine's own public hook entry points (`toolResult`, `preStep`,
 * `turnStopping`) exactly as the Host would call them. `#pruneResult` is
 * reachable *only* through `toolResult` (it is a private method gated on
 * `!failed`), so the pipeline below mirrors the real dispatch rather than
 * calling the prune branch directly.
 *
 * @module prune-parity-scripts
 */

/** One step of a replayable script. */
export type PruneStep =
  /** `tools/pre-execute` → `agent/pre-step` → `tools/post-execute` for one call. */
  | {
      readonly ev: 'tool';
      readonly tool: string;
      readonly args?: unknown;
      /** The result text. */
      readonly out: string;
      /** Marks the result as a tool failure. */
      readonly isError?: boolean;
      /** What the rest of the waterfall decided for `tools/post-execute`. */
      readonly downstream?: 'accept' | 'block' | 'value';
      /** What the rest of the waterfall decided for `tools/pre-execute`. */
      readonly pre?: 'allow' | 'deny' | 'ask' | 'block';
      /** Turn to enter before the call; `agent/pre-step` fires when it changes. */
      readonly turn?: number;
      readonly step?: number;
      /** Switch the live policy's master mode *after* this call settled. */
      readonly switchModeTo?: 'off' | 'observe' | 'active';
    }
  /** `agent/pre-step` on its own, when a turn boundary matters without a call. */
  | { readonly ev: 'pre-step'; readonly turn: number; readonly step: number };

/** One script: a name, a human note, and the steps. */
export interface PruneScript {
  readonly id: string;
  /** What this script is for; the harness prints it on a mismatch. */
  readonly note: string;
  readonly steps: readonly PruneStep[];
  /** `true` when this script is only meaningful with a text-returning service. */
  readonly scratch?: boolean;
  /** `true` when this script is only meaningful with a segmenting service. */
  readonly segmented?: boolean;
  /**
   * `true` when this script only makes sense with a text-carrying service: its
   * middle observation is expected to be answerable from the memo.
   */
  readonly textCarrying?: boolean;
}

// ── payload shapes ──────────────────────────────────────────────────────────

/** Line-oriented output: the only shape pruning rewrites. */
function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index} of very noisy build output`).join('\n');
}

/** A payload with the given character length and at least four lines. */
function padded(length: number): string {
  const head = 'first diagnostic line\nsecond diagnostic line\nthird diagnostic line\n';
  const rest = 'x'.repeat(Math.max(0, length - head.length - 1));
  return `${head}${rest}Z`;
}

/** Line-oriented output of exactly `length` characters (>= 4 lines by construction). */
function lineOriented(length: number): string {
  const head = 'alpha diagnostic\nbeta diagnostic\ngamma diagnostic\ndelta diagnostic\n';
  if (length <= head.length) return head.slice(0, length);
  const body = 'y'.repeat(length - head.length - 1);
  return `${head}${body}\n`;
}

/** A single-line payload: large, but not line-oriented. */
function oneLongLine(length: number): string {
  return `{"error":"${'a'.repeat(length)}"}`;
}

/**
 * A line-oriented payload whose odd lines are much longer than its even ones.
 *
 * A candidate built from the short lines only is small enough that the floor
 * widens it, and *cannot* reach the requested share without rewriting lines —
 * which is exactly the "floor missed, install the candidate as-is" branch.
 */
function mixedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? `short ${index}` : `long ${'L'.repeat(300)} ${index}`)).join('\n');
}

/** A short payload below every threshold. */
const SHORT = 'ok';

// ── the corpus ──────────────────────────────────────────────────────────────

/**
 * The scripts, one concern each.
 *
 * The set is ordered so that a reader can find the scenario that broke: the
 * early ones are the ordinary paths, the middle ones the budget and retention
 * refusals, the last ones the cross-cutting invariants (memo identity, budget
 * interaction with the other capabilities, observe/active agreement).
 */
export const PRUNE_SCRIPTS: readonly PruneScript[] = [
  {
    id: 'active-installs-one-reduction',
    note: 'the ordinary path: one oversized trace is judged, floored, retained and installed',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'npm test' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'npm run build' }, out: lines(40, 'build'), turn: 1, step: 2 }
    ]
  },
  {
    id: 'below-threshold',
    note: 'a short payload is refused before anything is bought',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'echo ok' }, out: SHORT, turn: 1, step: 1 }]
  },
  {
    id: 'threshold-boundary',
    note: 'one character either side of the character threshold',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'a' }, out: lineOriented(99), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'b' }, out: lineOriented(100), turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'c' }, out: lineOriented(101), turn: 1, step: 3 }
    ]
  },
  {
    id: 'unsupported-payload',
    note: 'one runaway line is large but not line-oriented, so it is left alone',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'curl' }, out: oneLongLine(400), turn: 1, step: 1 }]
  },
  {
    id: 'exactly-min-lines',
    note: 'three lines are not line-oriented output; four are',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'three' }, out: `${'a'.repeat(200)}\n${'b'.repeat(200)}\n${'c'.repeat(200)}`, turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'four' }, out: `${'a'.repeat(200)}\n${'b'.repeat(200)}\n${'c'.repeat(200)}\n${'d'.repeat(200)}`, turn: 1, step: 2 }
    ]
  },
  {
    id: 'retention-too-large',
    note: 'a payload above the retention cap is refused before it is judged',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'big' }, out: lineOriented(100_001), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'edge' }, out: lineOriented(100_000), turn: 1, step: 2 }
    ]
  },
  {
    id: 'image-only-payload',
    note: 'a result with no text block has nothing to replace',
    steps: [{ ev: 'tool', tool: 'screenshot', args: {}, out: '', turn: 1, step: 1 }]
  },
  {
    id: 'value-shaped-accept',
    note: 'a value-shaped accept replaced the payload, so nothing here may touch it',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'v' }, out: lines(40), downstream: 'value', turn: 1, step: 1 }]
  },
  {
    id: 'downstream-block',
    note: 'the waterfall blocked the result, so prune passes it through untouched',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'b' }, out: lines(40), downstream: 'block', turn: 1, step: 1 }]
  },
  {
    id: 'floor-refuses-growth',
    note: 'the judged candidate is not smaller, so no reduction and no saving is recorded',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'grow' }, out: lines(40), turn: 1, step: 1 }]
  },
  {
    id: 'floor-misses-its-share',
    note: 'the floor cannot reach its share from whole lines, so the candidate is installed as-is',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'mixed' }, out: mixedLines(40), turn: 1, step: 1 }]
  },
  {
    id: 'observe-end-to-end',
    note: 'observe records the same plan active would make and installs nothing',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'obs-1' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'obs-2' }, out: lines(40, 'other'), turn: 1, step: 2 }
    ]
  },
  {
    id: 'repeat-payload-memo',
    note: 'the same payload judged once: the second call is answered from the memo',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'same' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'same-but-again' }, out: lines(40), turn: 1, step: 2 },
      { ev: 'tool', tool: 'read', args: { path: '/a' }, out: lines(40), turn: 1, step: 3 }
    ]
  },
  {
    id: 'observe-then-active-memo',
    note: 'the same payload judged under observe and then under active: the second answers from the memo',
    textCarrying: true,
    steps: [
      // The replay switches this agent's mode from observe to active after the
      // first call, so the second call meets the memo the first one wrote.
      { ev: 'tool', tool: 'bash', args: { command: 'cross-1' }, out: lines(40), turn: 1, step: 1, switchModeTo: 'active' },
      { ev: 'tool', tool: 'bash', args: { command: 'cross-2' }, out: lines(40), turn: 1, step: 2 }
    ]
  },
  {
    id: 'action-budget-exhausted',
    note: 'the per-turn action ceiling stops the fourth reduction without touching the downstream',
    steps: Array.from({ length: 5 }, (_, index) => ({
      ev: 'tool' as const,
      tool: 'bash',
      args: { command: `budget-${index}` },
      out: lines(40, `turn1-${index}`),
      turn: 1,
      step: index + 1
    }))
  },
  {
    id: 'action-budget-resets-per-turn',
    note: 'a new turn restores the action ceiling',
    steps: [
      ...Array.from({ length: 3 }, (_, index) => ({
        ev: 'tool' as const,
        tool: 'bash',
        args: { command: `t1-${index}` },
        out: lines(40, `t1-${index}`),
        turn: 1,
        step: index + 1
      })),
      { ev: 'tool' as const, tool: 'bash', args: { command: 't2-0' }, out: lines(40, 't2'), turn: 2, step: 1 }
    ]
  },
  {
    id: 'judgment-turn-cap',
    note: 'the per-turn judgment ceiling refuses the second payload before a candidate exists',
    steps: Array.from({ length: 3 }, (_, index) => ({
      ev: 'tool' as const,
      tool: 'bash',
      args: { command: `judge-${index}` },
      out: lines(40, `judge-${index}`),
      turn: 1,
      step: index + 1
    }))
  },
  {
    id: 'judgment-session-cap',
    note: 'the session judgment ceiling, reached across turns',
    steps: Array.from({ length: 4 }, (_, index) => ({
      ev: 'tool' as const,
      tool: 'bash',
      args: { command: `session-${index}` },
      out: lines(40, `session-${index}`),
      turn: index + 1,
      step: 1
    }))
  },
  {
    id: 'intervention-cap-before-judgment',
    note: 'a full action budget refuses the payload before a judgment is spent',
    steps: Array.from({ length: 4 }, (_, index) => ({
      ev: 'tool' as const,
      tool: 'bash',
      args: { command: `cap-${index}` },
      out: lines(40, `cap-${index}`),
      turn: 1,
      step: index + 1
    }))
  },
  {
    id: 'failed-result-skips-prune',
    note: 'a failing result goes to the correction branch, never to the prune branch',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'false' }, out: lines(40), isError: true, turn: 1, step: 1 }]
  },
  {
    id: 'refused-result-skips-prune',
    note: 'the same failing call refused by the gate twice: its result is not judged again',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'fail-repeat' }, out: lines(40), isError: true, turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'fail-repeat' }, out: lines(40), isError: true, turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'fail-repeat' }, out: lines(40), isError: true, turn: 1, step: 3 },
      { ev: 'tool', tool: 'bash', args: { command: 'fail-repeat' }, out: lines(40), isError: true, turn: 1, step: 4 }
    ]
  },
  {
    id: 'own-tools-never-pruned',
    note: 'the plugin never prunes its own output',
    steps: [
      { ev: 'tool', tool: 'reflex_choice', args: { question: 'q' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'foreign' }, out: lines(40), turn: 1, step: 2 }
    ]
  },
  {
    id: 'multiple-text-blocks',
    note: 'only the first text block is replaced; every other block survives in order',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'blocks' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'blocks-2' }, out: lines(40, 'again'), turn: 1, step: 2 }
    ]
  },
  {
    id: 'prune-then-stagnation-in-one-turn',
    note: 'a reduction and a refusal in the same turn draw on the same action allowance',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'prune-me' }, out: lines(40), turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'repeat' }, out: 'one', turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'repeat' }, out: 'two', turn: 1, step: 3 },
      { ev: 'tool', tool: 'bash', args: { command: 'repeat' }, out: 'three', turn: 1, step: 4 },
      { ev: 'tool', tool: 'bash', args: { command: 'after-cap' }, out: lines(40, 'after'), turn: 1, step: 5 }
    ]
  },
  {
    id: 'pre-execute-deny-passes-through',
    note: 'a call the rest of the waterfall denied still reaches post-execute untouched',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'denied' }, out: lines(40), pre: 'deny', turn: 1, step: 1 }]
  },
  {
    id: 'pre-execute-ask-passes-through',
    note: 'a call the rest of the waterfall asked about still reaches post-execute untouched',
    steps: [{ ev: 'tool', tool: 'bash', args: { command: 'asked' }, out: lines(40), pre: 'ask', turn: 1, step: 1 }]
  },
  {
    id: 'mixed-turns-and-shapes',
    note: 'a longer run mixing turns, payload shapes, and one repeat',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'm1' }, out: SHORT, turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'm2' }, out: oneLongLine(400), turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'm3' }, out: lines(40), turn: 1, step: 3 },
      { ev: 'tool', tool: 'bash', args: { command: 'm4' }, out: lines(40), turn: 2, step: 1 },
      { ev: 'tool', tool: 'grep', args: { pattern: 'x' }, out: lines(30, 'grep'), turn: 2, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'm6' }, out: padded(3_000), turn: 2, step: 3 }
    ]
  }
];
