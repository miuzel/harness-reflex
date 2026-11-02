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
  | {
      readonly ev: 'pre-step';
      readonly turn: number;
      readonly step: number;
      /** What the rest of the waterfall decided for `agent/pre-step`. */
      readonly downstream?: 'enter' | 'reject';
      /** Mark the pre-step payload's signal aborted, as a cancelling turn does. */
      readonly aborted?: boolean;
    }
  /**
   * `tools/post-execute` on its own, with no `tools/pre-execute` proposal.
   *
   * The Host always proposes before it executes, but a proposal is not what makes
   * a result: a tool the run never asked this engine about still produces one, and
   * only this event can model a window whose repetitions were recorded without any
   * call being refused in front of them.
   */
  | {
      readonly ev: 'result';
      readonly tool: string;
      readonly args?: unknown;
      readonly out: string;
      readonly isError?: boolean;
    }
  /**
   * `agent/turn-stopping` on its own: the closing check. It is not the stagnation
   * path, but it shares the engine's state, budgets and audit trail, so it is a
   * cross-check that the stagnation batch moved nothing it should not have.
   */
  | {
      readonly ev: 'turn-stop';
      readonly turn: number;
      readonly step: number;
      /** The assistant's claim for the turn, as the stream carried it. */
      readonly claims: string;
    };

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
  /** Override the stagnation service's answer for this script (default: confirms). */
  readonly stagnation?: StagnationShape;
  /**
   * Mark the pre-execute call's signal aborted.
   *
   * Only `toolCall` consults the signal, so this applies to every `tool` step's
   * execution rather than to the script as a whole.
   */
  readonly abortedCall?: boolean;
}

/**
 * How a script's stagnation service answers.
 *
 * A parity corpus that only ever says "stuck" would agree trivially on the
 * refusal branch and never reach the paid skip, the confidence floor, or the
 * fail-open path — each of which is a different position in the pre-execute
 * order. These shapes put the corpus on each of them.
 */
export type StagnationShape =
  /** Confirms a repetition. */
  | 'stuck'
  /** Answers "not stuck": the `unconfirmed` branch, which still charges a judgment. */
  | 'not-stuck'
  /** Confirms, but below the configured confidence floor. */
  | 'low-confidence'
  /** Throws on every question: the fail-open branch. */
  | 'throw'
  /** Answers the first question stuck and every later one not-stuck. */
  | 'stuck-then-not';

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

/**
 * One repeated call, `times` times in one turn, each with its own result record.
 *
 * A repetition is only a repetition once the *earlier* calls were recorded, so
 * each step proposes, settles, and moves on; the third proposal is the one the
 * cheap trigger sees as a loop.
 */
function repeats(times: number, tool: string, args: unknown, out: string, turn = 1): PruneStep[] {
  return Array.from({ length: times }, (_, index) => ({
    ev: 'tool' as const,
    tool,
    args,
    out,
    turn,
    step: index + 1
  }));
}

/**
 * A repeated call whose every step is a legitimate background-job poll.
 *
 * The handle is *constant* across the series, which is exactly the sanctioned
 * poll: the same job observed again. This is the shape the wait exemption has to
 * keep out of both the pre-execute refusal and the pre-step correction.
 */
function pollSeries(times: number, tool: string, args: unknown): PruneStep[] {
  return Array.from({ length: times }, (_, index) => ({
    ev: 'tool' as const,
    tool,
    args,
    out: `job still running (poll ${index + 1})`,
    turn: 1,
    step: index + 1
  }));
}

// ── the failure-correction corpus ───────────────────────────────────────────

/**
 * A failing call, `times` times in one turn.
 *
 * The correction branch lives on `tools/post-execute` behind the layer's own
 * reading of a failure, so the *only* way to reach it is a result it reads as a
 * failure. The error text is what the feedback quotes, which is why each series
 * carries its own.
 */
function failures(times: number, tool: string, args: unknown, error: string, turn = 1): PruneStep[] {
  return Array.from({ length: times }, (_, index) => ({
    ev: 'tool' as const,
    tool,
    args,
    out: error,
    isError: true,
    turn,
    step: index + 1
  }));
}

/**
 * The same failure series with the rest of the waterfall's decision overridden.
 *
 * Kept as its own helper because the override belongs to the `tool` variant of
 * {@link PruneStep} only: spreading a literal inside a callback loses the
 * variant's identity and TypeScript then widens it to the other variants.
 * @param times - how many attempts.
 * @param tool - tool name.
 * @param args - the call's arguments.
 * @param error - the failure text.
 * @param downstream - what the rest of the waterfall decided for this result.
 * @returns the steps.
 */
function failuresWithDownstream(
  times: number,
  tool: string,
  args: unknown,
  error: string,
  downstream: 'block' | 'value'
): PruneStep[] {
  const out: PruneStep[] = [];
  for (const [index, step] of failures(times, tool, args, error).entries()) {
    out.push({ ...(step as Extract<PruneStep, { ev: 'tool' }>), step: index + 1, downstream } as PruneStep);
  }
  return out;
}

/** One failing call, for the scripts that interleave outcomes. */
function oneFailure(tool: string, args: unknown, error: string, turn: number, step: number): PruneStep {
  return { ev: 'tool', tool, args, out: error, isError: true, turn, step };
}

/** One succeeding call, for the scripts that interleave outcomes. */
function oneSuccess(tool: string, args: unknown, out: string, turn: number, step: number): PruneStep {
  return { ev: 'tool', tool, args, out, turn, step };
}

/**
 * A failing *poll*: the call shapes a wait, and its result is a failure.
 *
 * Which of the two facts wins is the question. The wait exemption is read off the
 * call and the failure off the result, so a correction that mistook one for the
 * other would change the model-visible surface on exactly the calls a run makes
 * while it waits for a job.
 */
function failingPolls(times: number, tool: string, args: unknown): PruneStep[] {
  return Array.from({ length: times }, (_, index) => ({
    ev: 'tool' as const,
    tool,
    args,
    out: `job_output failed (attempt ${index + 1})`,
    isError: true,
    turn: 1,
    step: index + 1
  }));
}

/**
 * Failures separated by successes, so the trailing-failure count is what decides.
 *
 * The correction's own order is: the failure latch, then the action ceiling, then
 * the trigger. A corpus made only of straight repeated failures can never reach
 * the branch where the budget checks *passed* and the trigger then said no, so a
 * reordering of those three would be invisible without this shape.
 */
function alternating(failCount: number, succeedEvery: number): PruneStep[] {
  const out: PruneStep[] = [];
  let step = 0;
  for (let index = 0; index < failCount; index += 1) {
    step += 1;
    out.push(oneFailure('bash', { command: `alt-${index % 2}` }, `alt failure ${index}`, 1, step));
    if ((index + 1) % succeedEvery === 0) {
      step += 1;
      out.push(oneSuccess('bash', { command: `ok-${index}` }, `ok ${index}`, 1, step));
    }
  }
  return out;
}

/**
 * The scripts that exercise the stagnation path: `tools/pre-execute` and
 * `agent/pre-step`.
 *
 * They are kept apart from {@link PRUNE_SCRIPTS} so that a reader can see which
 * corpus belongs to which batch, but both are replayed through the same harness:
 * the two engines are their own oracle, and the corpus is the only input.
 *
 * The *whole* engine runs on every script here, pruning included; a stagnation
 * batch that disturbed the prune branch, the closing check, or the accounting
 * shared by all of them fails these scripts too.
 */
export const STAGNATION_SCRIPTS: readonly PruneScript[] = [
  {
    id: 'stagnation-denies-the-third-identical-call',
    note: 'the ordinary path: three identical calls, the third is judged and refused',
    steps: repeats(4, 'bash', { command: 'npm test' }, 'exit 1: 3 tests failed')
  },
  {
    id: 'stagnation-two-identical-calls-are-not-a-loop',
    note: 'the trigger fires at the threshold, not before it',
    steps: repeats(3, 'bash', { command: 'ls' }, 'total 0')
  },
  {
    id: 'stagnation-step-correction-after-a-loop',
    note: 'the pre-step that follows a refused loop attaches the correction',
    steps: [
      ...repeats(4, 'bash', { command: 'same' }, 'nothing changed'),
      { ev: 'pre-step', turn: 1, step: 5 },
      { ev: 'pre-step', turn: 1, step: 6 }
    ]
  },
  {
    id: 'stagnation-pre-step-corrects-a-repeated-window',
    note: 'the correction is its own decision, reached without any pre-execute proposal in front of it',
    steps: [
      // Three results are recorded and no call is ever proposed, so nothing has
      // been latched by pre-execute and the step boundary is the only decision
      // left to make. This is the shape a paused step sees: the loop already ran
      // and the next step is about to be admitted.
      // The turn is entered first (with no observation behind it), the three
      // repetitions are then recorded without ever being proposed, and the step
      // boundary that follows is the only decision left to make.
      { ev: 'pre-step', turn: 1, step: 1 },
      // The same call three times: a repetition is measured on the call's own
      // identity, so three *different* calls would only be three recorded steps.
      ...[1, 2, 3].map(() => ({ ev: 'result' as const, tool: 'bash', args: { command: 'repeat-me' }, out: 'failed' })),
      { ev: 'pre-step', turn: 1, step: 4 }
    ]
  },
  {
    id: 'stagnation-pre-step-before-any-call',
    note: 'a pre-step with no observation behind it has nothing to correct',
    steps: [{ ev: 'pre-step', turn: 1, step: 1 }]
  },
  {
    id: 'stagnation-pre-step-rejected-downstream',
    note: 'a pre-step the rest of the waterfall rejected is not corrected',
    steps: [
      ...repeats(4, 'bash', { command: 'rejected' }, 'failed'),
      { ev: 'pre-step', turn: 1, step: 5, downstream: 'reject' }
    ]
  },
  {
    id: 'stagnation-pre-step-aborted',
    note: 'a pre-step whose turn is being cancelled is left alone',
    steps: [
      ...repeats(4, 'bash', { command: 'cancelled' }, 'failed'),
      { ev: 'pre-step', turn: 1, step: 5, aborted: true }
    ]
  },
  {
    id: 'stagnation-pre-execute-aborted',
    note: 'a call whose signal is already aborted is never vetoed',
    abortedCall: true,
    steps: repeats(4, 'bash', { command: 'abort-me' }, 'failed')
  },
  {
    id: 'stagnation-downstream-denied-passes-through',
    note: 'the engine adds nothing on top of a decision the waterfall already made',
    steps: [
      ...repeats(3, 'bash', { command: 'denied' }, 'failed'),
      { ev: 'tool', tool: 'bash', args: { command: 'denied' }, out: 'failed', pre: 'deny', turn: 1, step: 4 },
      { ev: 'tool', tool: 'bash', args: { command: 'denied' }, out: 'failed', pre: 'ask', turn: 1, step: 5 },
      { ev: 'tool', tool: 'bash', args: { command: 'denied' }, out: 'failed', pre: 'block', turn: 1, step: 6 }
    ]
  },
  {
    id: 'stagnation-permission-is-monotone',
    note: 'a confirmed loop refuses an allow, and cannot do anything else to a stricter decision',
    steps: [
      // The refusals of steps 3 and 4 latch the signature, so the allow at the
      // end is refused again rather than re-judged — and the deny/ask/block
      // calls in between hand back the downstream object untouched.
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', turn: 1, step: 3 },
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', pre: 'ask', turn: 1, step: 4 },
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', pre: 'block', turn: 1, step: 5 },
      { ev: 'tool', tool: 'bash', args: { command: 'mono' }, out: 'failed', pre: 'allow', turn: 1, step: 6 }
    ]
  },
  {
    id: 'stagnation-refuses-only-an-allow',
    note: 'a call the waterfall already decided is never re-decided by the engine',
    steps: [
      // Three recorded failures make every following proposal suspicious, so each
      // of these four calls reaches the confirmation and is refused or handed back
      // depending on nothing but what the waterfall said first.
      { ev: 'tool', tool: 'bash', args: { command: 'strict' }, out: 'failed', turn: 1, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict' }, out: 'failed', turn: 1, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict' }, out: 'failed', pre: 'ask', turn: 1, step: 3 },
      { ev: 'pre-step', turn: 1, step: 3 },
      { ev: 'pre-step', turn: 1, step: 4 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-2' }, out: 'failed', turn: 2, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-2' }, out: 'failed', turn: 2, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-2' }, out: 'failed', pre: 'deny', turn: 2, step: 3 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-2' }, out: 'failed', pre: 'block', turn: 2, step: 4 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-3' }, out: 'failed', turn: 3, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-3' }, out: 'failed', turn: 3, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'strict-3' }, out: 'failed', pre: 'ask', turn: 3, step: 3 }
    ]
  },
  {
    id: 'stagnation-own-tools-exempt',
    note: 'the plugin never vetoes its own tools',
    steps: [...repeats(5, 'reflex_choice', { question: 'q' }, 'p=0.9'), { ev: 'pre-step', turn: 1, step: 6 }]
  },
  {
    id: 'stagnation-wait-query-exempt',
    note: 'a repeated poll of one job is a wait, not a loop',
    steps: [...pollSeries(5, 'job_output', { job_id: 'job-7' }), { ev: 'pre-step', turn: 1, step: 6 }]
  },
  {
    id: 'stagnation-wait-list-exempt',
    note: 'listing ones own jobs is a status query too',
    steps: pollSeries(4, 'job_list', {})
  },
  {
    id: 'stagnation-wait-output-is-not-a-wait',
    note: 'the exemption is the call identity, not words in the result',
    steps: repeats(4, 'bash', { command: 'sleep 30; wait' }, 'waiting for job_output of job-7')
  },
  {
    id: 'stagnation-job-kill-is-a-poll-suspect',
    note: 'terminating a job is not a wait, but its job handle makes it worth asking about',
    steps: pollSeries(4, 'job_kill', { job_id: 'job-7' })
  },
  {
    id: 'stagnation-external-poller-is-asked',
    note: 'a handle-shaped repetition outside the name list is put to System One',
    steps: pollSeries(4, 'task_poll', { task_id: 'task-3' })
  },
  {
    id: 'stagnation-wait-flag-without-handle',
    note: 'a bare wait flag names no job, so it is an ordinary repetition',
    steps: pollSeries(4, 'job_output', { wait: true })
  },
  {
    id: 'stagnation-unconfirmed-still-charges',
    note: 'a judgment that answers "not stuck" is paid for and recorded',
    stagnation: 'not-stuck',
    steps: [...repeats(4, 'bash', { command: 'maybe' }, 'no change'), { ev: 'pre-step', turn: 1, step: 5 }]
  },
  {
    id: 'stagnation-low-confidence-is-unconfirmed',
    note: 'a verdict under the confidence floor justifies nothing',
    stagnation: 'low-confidence',
    steps: repeats(4, 'bash', { command: 'unsure' }, 'no change')
  },
  {
    id: 'stagnation-judge-throws-fails-open',
    note: 'a service that cannot answer never vetoes an allowed call',
    stagnation: 'throw',
    steps: [
      ...repeats(4, 'bash', { command: 'down' }, 'no change'),
      // A poll series in its own turn, so its repetition is what fails and the
      // fail-open reason is the wait-specific one rather than the generic one.
      ...pollSeries(4, 'job_output', { job_id: 'job-9' }).map((step) => ({ ...step, turn: 2, step: (step as { step: number }).step }))
    ]
  },
  {
    id: 'stagnation-stuck-then-not',
    note: 'the first episode is refused and a later, different one is not',
    stagnation: 'stuck-then-not',
    steps: [
      ...repeats(4, 'bash', { command: 'first' }, 'no change'),
      { ev: 'tool', tool: 'bash', args: { command: 'second' }, out: 'different', turn: 1, step: 5 },
      { ev: 'tool', tool: 'bash', args: { command: 'second' }, out: 'different', turn: 1, step: 6 },
      { ev: 'tool', tool: 'bash', args: { command: 'second' }, out: 'different', turn: 1, step: 7 },
      { ev: 'tool', tool: 'bash', args: { command: 'second' }, out: 'different', turn: 1, step: 8 }
    ]
  },
  {
    id: 'stagnation-turn-boundary-resets-the-loop',
    note: 'a new turn clears the window, the latches and the budget',
    steps: [
      ...repeats(4, 'bash', { command: 'turn-1' }, 'failed'),
      { ev: 'tool', tool: 'bash', args: { command: 'turn-1' }, out: 'failed', turn: 2, step: 1 },
      { ev: 'tool', tool: 'bash', args: { command: 'turn-1' }, out: 'failed', turn: 2, step: 2 },
      { ev: 'tool', tool: 'bash', args: { command: 'turn-1' }, out: 'failed', turn: 2, step: 3 }
    ]
  },
  {
    id: 'stagnation-action-ceiling-exhausted',
    note: 'the turn action ceiling refuses the second episode without judging it',
    steps: [
      ...repeats(4, 'bash', { command: 'cap-a' }, 'failed'),
      { ev: 'tool', tool: 'bash', args: { command: 'cap-b' }, out: 'failed', turn: 1, step: 5 },
      { ev: 'tool', tool: 'bash', args: { command: 'cap-b' }, out: 'failed', turn: 1, step: 6 },
      { ev: 'tool', tool: 'bash', args: { command: 'cap-b' }, out: 'failed', turn: 1, step: 7 }
    ]
  },
  {
    id: 'stagnation-judgment-ceiling',
    note: 'the judgment ceiling stops the second episode before a verdict exists',
    steps: [
      ...repeats(4, 'bash', { command: 'judge-a' }, 'failed'),
      { ev: 'tool', tool: 'bash', args: { command: 'judge-b' }, out: 'failed', turn: 1, step: 5 },
      { ev: 'tool', tool: 'bash', args: { command: 'judge-b' }, out: 'failed', turn: 1, step: 6 },
      { ev: 'tool', tool: 'bash', args: { command: 'judge-b' }, out: 'failed', turn: 1, step: 7 },
      { ev: 'pre-step', turn: 1, step: 8 }
    ]
  },
  {
    id: 'stagnation-observe-plans-without-refusing',
    note: 'observe makes the same plan, refuses nothing, and books the same action',
    steps: [
      ...repeats(4, 'bash', { command: 'observed' }, 'failed'),
      { ev: 'pre-step', turn: 1, step: 5 }
    ]
  },
  {
    id: 'stagnation-off-changes-nothing',
    note: 'off is the absence of the decision, not a weaker one',
    steps: [
      ...repeats(4, 'bash', { command: 'off-path' }, 'failed'),
      { ev: 'pre-step', turn: 1, step: 5 }
    ]
  },
  {
    id: 'stagnation-then-prune-shares-the-budget',
    note: 'a refusal and a reduction draw on the same allowance, in that order',
    steps: [
      ...repeats(4, 'bash', { command: 'shared-budget' }, lines(40)),
      { ev: 'tool', tool: 'bash', args: { command: 'after' }, out: lines(40, 'after'), turn: 1, step: 5 }
    ]
  },
  {
    id: 'stagnation-closing-still-consistent',
    note: 'the closing check keeps its answer while the stagnation path moves',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'false' }, out: 'Exit code 1: cannot resolve module', isError: true, turn: 1, step: 1 },
      { ev: 'turn-stop', turn: 1, step: 1, claims: 'All tests pass and the build is green.' }
    ]
  },
  {
    id: 'stagnation-many-agents-are-independent',
    note: 'one agent looping does not touch another agent corpus',
    steps: [
      ...repeats(4, 'bash', { command: 'agent-a' }, 'failed'),
      { ev: 'pre-step', turn: 1, step: 5 }
    ]
  }
];

/**
 * The scripts that exercise the failure-correction path: `tools/post-execute`
 * on a result the layer reads as a failure.
 *
 * Same contract as {@link STAGNATION_SCRIPTS}: inputs only, no expected output,
 * replayed through the engine's public hooks so the two engines are their own
 * oracle. The corpus is ordered from the ordinary path outwards — threshold, the
 * two latches, each budget, the two anchors the layer refuses to act on, the
 * service's three answers, and then the accounting that is shared with the other
 * two capabilities.
 */
export const CORRECTION_SCRIPTS: readonly PruneScript[] = [
  {
    id: 'correction-the-third-failure-is-corrected',
    note: 'the ordinary path: a failure that keeps failing is judged and rewritten',
    steps: failures(4, 'bash', { command: 'npm test' }, 'Error: 3 tests failed in src/core/policy.ts')
  },
  {
    id: 'correction-below-the-threshold',
    note: 'the trigger fires at the failure threshold, not before it',
    steps: failures(3, 'bash', { command: 'npm test' }, 'Error: 3 tests failed')
  },
  {
    id: 'correction-threshold-of-two',
    note: 'a policy that lowers the failure threshold corrects one failure earlier',
    steps: failures(3, 'bash', { command: 'npm run typecheck' }, 'TS2345: argument of type string is not assignable')
  },
  {
    id: 'correction-single-episode-latch',
    note: 'one episode is corrected once; the later failures are latched, not re-judged',
    steps: failures(6, 'bash', { command: 'same-failure' }, 'E: identical failure text')
  },
  {
    id: 'correction-two-episodes-one-turn',
    note: 'a second independent episode is its own decision, subject to the same ceiling',
    steps: [
      ...failures(4, 'bash', { command: 'first-episode' }, 'E: first failure'),
      ...failures(4, 'bash', { command: 'second-episode' }, 'E: second failure').map((step) => ({
        ...step,
        step: (step as { step: number }).step + 4
      }))
    ]
  },
  {
    id: 'correction-action-ceiling',
    note: 'the turn action ceiling stops the second episode without judging it',
    steps: [
      ...failures(4, 'bash', { command: 'ceiling-a' }, 'E: ceiling a'),
      ...failures(4, 'bash', { command: 'ceiling-b' }, 'E: ceiling b').map((step) => ({
        ...step,
        step: (step as { step: number }).step + 4
      }))
    ]
  },
  {
    id: 'correction-budget-shared-with-a-refusal',
    note: 'a stagnation refusal and a correction draw on the same allowance, in that order',
    steps: [
      ...repeats(4, 'bash', { command: 'shared' }, 'failed'),
      ...failures(4, 'bash', { command: 'after-the-refusal' }, 'E: after the refusal').map((step) => ({
        ...step,
        step: (step as { step: number }).step + 4
      }))
    ]
  },
  {
    id: 'correction-budget-shared-with-a-reduction',
    note: 'a reduction and a correction draw on the same allowance, in that order',
    steps: [
      { ev: 'tool', tool: 'bash', args: { command: 'cat big.log' }, out: lines(40), turn: 1, step: 1 },
      ...failures(4, 'bash', { command: 'after-the-reduction' }, 'E: after the reduction').map((step) => ({
        ...step,
        step: (step as { step: number }).step + 1
      }))
    ]
  },
  {
    id: 'correction-judgment-ceiling',
    note: 'the judgment ceiling stops the second episode before a verdict exists',
    steps: [
      ...failures(4, 'bash', { command: 'judge-a' }, 'E: judge a'),
      ...failures(4, 'bash', { command: 'judge-b' }, 'E: judge b').map((step) => ({
        ...step,
        step: (step as { step: number }).step + 4
      }))
    ]
  },
  {
    id: 'correction-downstream-blocked',
    note: 'a result the rest of the waterfall blocked is already unreadable, so it is left alone',
    steps: failuresWithDownstream(4, 'bash', { command: 'blocked-result' }, 'E: blocked result', 'block')
  },
  {
    id: 'correction-value-shaped-accept',
    note: 'a value-shaped accept replaced the payload before this point',
    steps: failuresWithDownstream(4, 'bash', { command: 'value-shaped' }, 'E: value shaped', 'value')
  },
  {
    id: 'correction-own-tool-failure',
    note: 'the plugin never corrects its own tools',
    steps: failures(5, 'reflex_choice', { question: 'q' }, 'E: the plugin tool failed')
  },
  {
    id: 'correction-after-a-refused-call',
    note: 'the result of a call this layer refused is the refusal, so it is neither pruned nor corrected',
    steps: [
      ...repeats(4, 'bash', { command: 'refused-then-failed' }, 'failed'),
      oneFailure('bash', { command: 'refused-then-failed' }, 'E: the refused call also failed', 1, 5)
    ]
  },
  {
    id: 'correction-unconfirmed-still-charges',
    note: 'a judgment that answers "not stuck" is paid for and recorded',
    stagnation: 'not-stuck',
    steps: failures(4, 'bash', { command: 'maybe' }, 'E: maybe not stuck')
  },
  {
    id: 'correction-low-confidence',
    note: 'a verdict under the confidence floor justifies nothing',
    stagnation: 'low-confidence',
    steps: failures(4, 'bash', { command: 'unsure' }, 'E: unsure')
  },
  {
    id: 'correction-judge-throws-fails-open',
    note: 'a service that cannot answer never rewrites a result',
    stagnation: 'throw',
    steps: failures(4, 'bash', { command: 'down' }, 'E: service down')
  },
  {
    id: 'correction-turn-boundary-resets-the-episode',
    note: 'a new turn clears the latch, the window and the budget',
    steps: [
      ...failures(4, 'bash', { command: 'turn-1' }, 'E: turn one'),
      ...failures(4, 'bash', { command: 'turn-1' }, 'E: turn one again', 2).map((step) => ({
        ...step,
        step: (step as { step: number }).step
      }))
    ]
  },
  {
    id: 'correction-alternating-outcomes',
    note: 'a failure interrupted by a success is not a run of failures',
    steps: alternating(8, 1)
  },
  {
    id: 'correction-failing-polls',
    note: 'a poll whose result failed is read by the call it was, not only by its result',
    steps: failingPolls(5, 'job_output', { job_id: 'job-11' })
  },
  {
    id: 'correction-failing-kill',
    note: 'terminating a job is not a wait, and its failure is a failure',
    steps: failingPolls(5, 'job_kill', { job_id: 'job-12' })
  },
  {
    id: 'correction-non-ascii-failure',
    note: 'the feedback quotes the error, so its bytes are part of the surface',
    steps: failures(4, 'bash', { command: 'locale' }, '错误：找不到模块 “core/policy” 的声明文件')
  },
  {
    id: 'correction-long-and-multiline-error',
    note: 'a long multi-line error is quoted through the same clipping and whitespace rules',
    steps: failures(
      4,
      'bash',
      { command: 'build' },
      `Error: build failed\n${Array.from({ length: 30 }, (_, index) => `  at frame ${index} of the transitive dependency chain`).join('\n')}\n${'z'.repeat(400)}`
    )
  },
  {
    id: 'correction-then-closing',
    note: 'the closing check keeps its answer while the correction path moves',
    steps: [
      ...failures(4, 'bash', { command: 'npm test' }, 'E: tests failed'),
      { ev: 'turn-stop', turn: 1, step: 4, claims: 'All tests pass and the build is green.' }
    ]
  }
];
