/**
 * The deterministic floor of a judged reduction.
 *
 * A prune judgment proposes; this module disposes. Given the original payload,
 * the judged candidate, and the floor options, it decides whether the head /
 * extract / tail form replaces the candidate, composes that form out of whole
 * lines, and reports the size the installed text really has. Everything here is
 * pure arithmetic over strings: no host type, no retention sink, no audit.
 *
 * @module core/prune-plan
 */

/** Default share of a floored reduction's context budget taken from the head. */
export const FLOOR_HEAD_CHARS = 400;
/** Default share of a floored reduction's context budget taken from the tail. */
export const FLOOR_TAIL_CHARS = 400;

/**
 * The floor decision of one reduction, computed from lengths alone.
 *
 * {@link pruneFloorPlan} returns the *decision*: whether the floor applies and
 * the size that decision was modelled on. {@link applyPruneFloor} returns the
 * same decision next to the size the composed text *really* has, because line
 * alignment and duplicate removal move that size. Callers account for the text
 * a mode really installs, so the composed numbers are the authoritative ones.
 */
export interface PruneFloorPlan {
  /** Whether the floor form replaces the judged candidate. */
  floored: boolean;
  /**
   * Whether the installed reduction fell short of the floor's promised share.
   *
   * True exactly when the composition could not build a form that both carries
   * `floorRatio` of the original and stays smaller than it, so the judged
   * candidate itself was installed. It is what separates "nothing was reduced"
   * from "the reduction was real, but it did not reach the floor's promise"; a
   * plan that never needed the floor reports `false`.
   */
  floorMissed: boolean;
  /** Characters the installed text carries: modelled by the plan, real once composed. */
  resultChars: number;
  /** Characters the installed form does not carry. */
  omittedChars: number;
  /** Context characters taken from the head of the original. */
  headChars: number;
  /** Context characters taken from the tail of the original. */
  tailChars: number;
  /**
   * Marker characters the installed form carries, summed over its sides.
   *
   * Zero when nothing is floored, one marker when only the mandatory locator side
   * fits, two when the share's budget can pay for a matching marker after the
   * candidate. Publishing it is what lets {@link applyPruneFloor} rebuild exactly
   * the form whose size the plan promised.
   */
  markerChars: number;
  /**
   * Whether a floor-missed install wanted the locator marker but could not carry it.
   *
   * The marker is what tells a reader that the reduction happened and where the
   * full payload lives, so a candidate that fits only *without* it is still
   * installed — the reduction is real — but the omission is recorded instead of
   * being silently dropped. Always `false` when `floorMissed` is false.
   */
  markerOmitted: boolean;
}

/** The floor options shared by the plan and the composition. */
export interface PruneFloorOptions {
  /** Lowest share of the original a reduction may keep. */
  floorRatio: number;
  /** Default split of the context budget, in characters. */
  headChars?: number;
  /** Default split of the context budget, in characters. */
  tailChars?: number;
  /**
   * Length of the marker the installed form carries per side.
   *
   * A caller that composes a locator-carrying form passes the real marker
   * length here; a caller that only accounts for it passes the same number. That
   * is what keeps the predicted size and the installed size identical in both
   * modes.
   */
  markerChars?: number;
}

/**
 * Decide the deterministic floor of one reduction from lengths alone.
 *
 * Lengths are enough because the floor form is fixed: context, marker, candidate,
 * marker, context. Deciding it this way is what lets `observe` account for the
 * *same* candidate `active` would install without building it.
 *
 * The floor is a *share*, not a suggestion. `pruneFloorRatio` says how much of
 * the original must survive, so the context budget is derived from it rather than
 * capped by the head/tail hints: a candidate that keeps 8% of a long payload is
 * not "floored" to 8% plus two small slices, it is widened until the installed
 * form really carries the promised share. The head/tail hints only decide how
 * that budget is split. A plan that cannot reach the share — because the marker
 * alone would eat the whole allowance — is refused, so a reduction never grows
 * the context.
 *
 * @param originalChars - length of the raw payload.
 * @param candidateChars - length of the judged candidate.
 * @param options - floor ratio, split hints, and marker length.
 * @returns the floor decision.
 */
export function pruneFloorPlan(
  originalChars: number,
  candidateChars: number,
  options: PruneFloorOptions
): PruneFloorPlan {
  if (candidateChars === 0 || candidateChars >= originalChars) {
    return idleFloorPlan(originalChars);
  }
  const marker = Math.max(0, options.markerChars ?? 0);
  const head = Math.max(0, options.headChars ?? FLOOR_HEAD_CHARS);
  const tail = Math.max(0, options.tailChars ?? FLOOR_TAIL_CHARS);
  const share = Math.min(1, Math.max(0, options.floorRatio));
  const target = Math.ceil(originalChars * share);
  // The judged candidate is already the installed text when the floor does not
  // apply, and it carries no marker; only a deeper cut pays for the marker.
  if (candidateChars >= target) {
    return {
      floored: false,
      floorMissed: false,
      resultChars: candidateChars,
      omittedChars: originalChars - candidateChars,
      headChars: 0,
      tailChars: 0,
      markerChars: 0,
      markerOmitted: false
    };
  }
  // One marker side is mandatory: it carries the locator of the original. The
  // second is bought only when the share's budget leaves room for it. A candidate
  // that cannot even pay for the mandatory marker is still a real reduction, so
  // it is installed *without* the marker and the omission is recorded: dropping
  // it would trade a smaller answer for the whole payload over a missing line.
  if (candidateChars + marker >= originalChars) {
    return {
      floored: false,
      floorMissed: true,
      resultChars: candidateChars,
      omittedChars: originalChars - candidateChars,
      headChars: 0,
      tailChars: 0,
      markerChars: 0,
      markerOmitted: true
    };
  }
  let budget = Math.max(candidateChars + marker, Math.min(originalChars, target));
  let markerChars = marker;
  let context = budget - candidateChars - markerChars;
  if (context >= marker) {
    markerChars += marker;
    context -= marker;
  }
  const split = splitContext(context, head, tail);
  const resultChars = candidateChars + markerChars + context;
  if (resultChars >= originalChars) return idleFloorPlan(originalChars);
  return {
    floored: true,
    floorMissed: false,
    resultChars,
    omittedChars: originalChars - resultChars,
    headChars: split.head,
    tailChars: split.tail,
    markerChars,
    markerOmitted: false
  };
}

/**
 * Split one context budget between the head and the tail.
 *
 * The hints describe the *shape* of the context, not its ceiling, so a large
 * budget keeps their proportion instead of stopping at their sum. A zero-shaped
 * split degrades to an even one rather than dropping the context.
 * @param context - characters available for context.
 * @param head - head hint.
 * @param tail - tail hint.
 * @returns the two slice lengths, summing to the context.
 */
function splitContext(context: number, head: number, tail: number): { head: number; tail: number } {
  const total = head + tail;
  const headChars = total <= 0 ? Math.ceil(context / 2) : Math.ceil((context * head) / total);
  return { head: Math.min(context, headChars), tail: context - Math.min(context, headChars) };
}

/** The plan of a reduction that is not happening. */
function idleFloorPlan(originalChars: number): PruneFloorPlan {
  return {
    floored: false,
    floorMissed: false,
    resultChars: originalChars,
    omittedChars: 0,
    headChars: 0,
    tailChars: 0,
    markerChars: 0,
    markerOmitted: false
  };
}

/** The marker one floored reduction carries on each side of its candidate. */
export function pruneMarker(locator: string): string {
  return `\n… [reflex prune: full original retrievable as ${locator}] …\n`;
}

/**
 * The marker a floor-missed install appends after its candidate.
 *
 * The floored form opens with the marker because the head has just ended with a
 * newline. A candidate that already ends with one needs no blank line before the
 * marker, so only the leading newline is dropped in that case; the trailing
 * newline is the same one the floored form carries.
 * @param candidate - the judged candidate about to be installed.
 * @param marker - the locator marker.
 * @returns the suffix to append.
 */
function pruneMarkerSuffix(candidate: string, marker: string): string {
  return candidate.endsWith('\n') ? marker.slice(1) : marker;
}

/** Split one payload into whole lines, the terminator kept with its line. */
function floorLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The identity of one line for the duplicate test: its text without its terminator. */
function floorLineIdentity(line: string): string {
  return line.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/**
 * How many whole lines of the head a budget can pay for.
 *
 * The head never crosses its budget and never stops inside a line: a cut that
 * cannot pay for the next line stops before it, so the kept prefix is always a
 * run of complete lines.
 * @param lines - the payload, split into whole lines.
 * @param budget - characters the head may spend.
 * @returns the number of lines to keep from the top.
 */
function alignedHeadLines(lines: readonly string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    if (used + line.length > budget) break;
    used += line.length;
    count += 1;
  }
  return count;
}

/**
 * How many whole lines of the tail a budget needs.
 *
 * The tail is the *shortest* run of complete lines from the end that still
 * carries the budget. A payload whose lines are longer than the budget cannot
 * honour it with a line-aligned suffix; the caller refuses instead of cutting
 * one, because half a line is not a shorter answer but a broken one.
 * @param lines - the payload, split into whole lines.
 * @param budget - characters the tail must carry.
 * @returns the number of lines to keep from the bottom.
 */
function alignedTailLines(lines: readonly string[], budget: number): number {
  if (budget <= 0) return 0;
  let used = 0;
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    used += lines[index]!.length;
    count += 1;
    if (used >= budget) break;
  }
  return count;
}

/**
 * Drop the candidate lines the kept context already shows verbatim.
 *
 * The judgment reads the whole payload, so its extract repeats the lines a
 * reader can already see around it — `BEGIN`, `RESULT`, `END` in the trace that
 * prompted this. Repeating them is pure cost: the same line twice in one
 * message. Removal is per line and verbatim, so a diagnostic the context does
 * *not* carry always survives.
 * @param candidate - the judged extract.
 * @param head - the kept head.
 * @param tail - the kept tail.
 * @returns the candidate without the lines the context already shows.
 */
function dedupeCandidateLines(candidate: string, head: string, tail: string): string {
  const seen = new Set([...floorLines(head), ...floorLines(tail)].map(floorLineIdentity));
  const lines = floorLines(candidate);
  if (seen.size === 0 || lines.length === 0) return candidate;
  return lines.filter((line) => !seen.has(floorLineIdentity(line))).join('');
}

/** One composed floor form and the sizes it really kept. */
interface ComposedFloor {
  text: string;
  headChars: number;
  tailChars: number;
  markerChars: number;
}

/**
 * Compose one floored form out of whole lines of the original.
 * @param lines - the original, split into whole lines.
 * @param headCount - lines kept from the top.
 * @param tailCount - lines kept from the bottom.
 * @param candidate - the judged extract.
 * @param marker - the locator marker.
 * @param secondMarker - the closing marker, or `''` when the share cannot pay for it.
 * @returns the installed text and the sizes it really carries.
 */
function composeFloorLines(
  lines: readonly string[],
  headCount: number,
  tailCount: number,
  candidate: string,
  marker: string,
  secondMarker: string
): ComposedFloor {
  const head = lines.slice(0, headCount).join('');
  const tail = tailCount === 0 ? '' : lines.slice(lines.length - tailCount).join('');
  const middle = dedupeCandidateLines(candidate, head, tail);
  // The marker opens with a newline so it sits on its own line after the head.
  // With no head there is nothing to separate it from, and a leading blank line
  // would be the first thing a reader sees.
  const lead = head.length === 0 ? marker.replace(/^\n/, '') : marker;
  const closing = middle.length === 0 ? '' : secondMarker;
  return {
    text: `${head}${lead}${middle}${closing}${tail}`,
    headChars: head.length,
    tailChars: tail.length,
    markerChars: lead.length + closing.length
  };
}

/**
 * The plan of a floor the composition refused.
 *
 * A refusal is *not* a reason to throw the candidate away. The candidate is the
 * reduction the judgment already produced, and a floor that cannot widen it
 * without either breaking the share or growing past the original has simply
 * missed the floor, not invalidated the reduction: installing the candidate is
 * strictly better than carrying the whole payload. So the candidate is installed
 * with `floored: false` (no head/tail form was built) and `floorMissed: true`
 * (the promised share is not carried), and the sizes are booked against the text
 * that is really installed.
 *
 * The locator marker is appended when the candidate can still pay for it, so the
 * reader sees that a prune happened and where the full payload lives. When the
 * marker would push the install to the original's size or past it, the reduction
 * wins and the marker is omitted — recorded as `markerOmitted: true`, never
 * silently dropped.
 *
 * Only a candidate that is not actually smaller leaves the original untouched —
 * that is a real "no reduction", and the caller's own degradation path owns it.
 *
 * @param original - the raw payload.
 * @param candidate - the judged reduction the composition could not widen.
 * @param marker - the locator marker a floor-missed install wants to carry.
 * @returns the text to install and the floor decision that says why.
 */
function refusedFloor(original: string, candidate: string, marker: string): PruneFloorPlan & { text: string } {
  if (candidate.length >= original.length) {
    return { ...idleFloorPlan(original.length), text: original };
  }
  const suffix = pruneMarkerSuffix(candidate, marker);
  if (candidate.length + suffix.length < original.length) {
    return {
      floored: false,
      floorMissed: true,
      resultChars: candidate.length + suffix.length,
      omittedChars: original.length - candidate.length - suffix.length,
      headChars: 0,
      tailChars: 0,
      markerChars: suffix.length,
      markerOmitted: false,
      text: `${candidate}${suffix}`
    };
  }
  return {
    floored: false,
    floorMissed: true,
    resultChars: candidate.length,
    omittedChars: original.length - candidate.length,
    headChars: 0,
    tailChars: 0,
    markerChars: 0,
    markerOmitted: true,
    text: candidate
  };
}

/**
 * Enforce the deterministic floor of a judged reduction.
 *
 * The judgment proposes; this floor disposes. A candidate that cut deeper than
 * {@link ResolvedInterventionsConfig.pruneFloorRatio} of the original is replaced
 * by a form that keeps the head and the tail — the two places a compiler error, a
 * stack-trace summary, and a final result usually are — around the judgment's own
 * extract, with explicit markers that name where the full original was retained.
 * A candidate that is not actually smaller is refused outright, so a "reduction"
 * can never grow the context.
 *
 * The context is composed out of *whole lines* of the original, never out of
 * character slices: a cut that lands mid-line leaves the reader a fragment like
 * `=] progress 092`, which is not a shorter answer but a broken one. The head is
 * the longest run of complete lines its budget can pay for, the tail the shortest
 * run of complete lines that still carries its own, and any candidate line the
 * kept context already shows verbatim is dropped as a duplicate. Alignment and
 * removal move the real size, so the decision's modelled size is replaced here by
 * the size the text really has: a form that would fall short of the promised
 * share, or that would not be smaller than the original at all, is refused. A
 * refusal installs the judgment's own candidate with `floorMissed: true` rather
 * than the original — the candidate is a real reduction, and dropping it would
 * trade a smaller answer for the whole payload just because the floor form could
 * not be built.
 *
 * @param original - the raw payload.
 * @param candidate - the judged reduction.
 * @param options - floor options plus the locator the replacement publishes.
 * @returns the text to install, the floor decision, and the sizes involved.
 */
export function applyPruneFloor(
  original: string,
  candidate: string,
  options: PruneFloorOptions & { locator: string }
): PruneFloorPlan & { text: string } {
  const marker = pruneMarker(options.locator);
  const plan = pruneFloorPlan(original.length, candidate.length, { ...options, markerChars: marker.length });
  if (!plan.floored) {
    return { ...plan, text: plan.resultChars === candidate.length ? candidate : original };
  }
  const lines = floorLines(original);
  const share = Math.min(1, Math.max(0, options.floorRatio));
  const target = Math.ceil(original.length * share);
  const secondMarker = plan.markerChars > marker.length ? marker : '';
  let headCount = alignedHeadLines(lines, plan.headChars);
  if (headCount === 0 && plan.headChars > 0 && lines.length > 0) {
    // A first line longer than the head budget: taking it whole keeps a real line
    // where a cut could only produce a fragment. Whether the enlarged form is
    // installable at all is decided by the size checks below.
    headCount = 1;
  }
  let tailCount = alignedTailLines(lines, plan.tailChars);
  if (headCount + tailCount > lines.length) return refusedFloor(original, candidate, marker);
  let composed = composeFloorLines(lines, headCount, tailCount, candidate, marker, secondMarker);
  // The share is a promise, and rounding to a boundary or dropping duplicates can
  // fall short of it: widen by whole lines until the form really carries the
  // share. A payload with no room left is refused by the checks below, never
  // installed short.
  while (composed.text.length < target) {
    // Grow the smaller side first, so the two keep their configured proportion.
    const order = composed.headChars <= composed.tailChars ? [0, 1] : [1, 0];
    let grew = false;
    for (const side of order) {
      const nextHead = side === 0 ? headCount + 1 : headCount;
      const nextTail = side === 1 ? tailCount + 1 : tailCount;
      if (nextHead + nextTail > lines.length) continue;
      const next = composeFloorLines(lines, nextHead, nextTail, candidate, marker, secondMarker);
      if (next.text.length <= composed.text.length) continue;
      headCount = nextHead;
      tailCount = nextTail;
      composed = next;
      grew = true;
      break;
    }
    if (!grew) break;
  }
  if (composed.text.length >= original.length || composed.text.length < target) {
    return refusedFloor(original, candidate, marker);
  }
  return {
    ...plan,
    resultChars: composed.text.length,
    omittedChars: original.length - composed.text.length,
    headChars: composed.headChars,
    tailChars: composed.tailChars,
    markerChars: composed.markerChars,
    text: composed.text
  };
}
