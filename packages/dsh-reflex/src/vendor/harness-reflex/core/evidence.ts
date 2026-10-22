/**
 * Evidence candidates and their budget.
 *
 * The closing judgment reads a bounded, prioritised digest of what the turn's
 * tool results said. This module builds those candidates from a *structural*
 * result value — an error flag, a canonical value, a message — and truncates
 * them by priority. It imports no tool-execution or message type from a host.
 *
 * @module core/evidence
 */
import type { TextBlockLike } from './text.js';
import { clip } from './text.js';

/** When one evidence line was retained, for truncation priority. */
export type EvidencePriority = 'diagnostic' | 'tail' | 'other';

/** One candidate the closing judgment may read. */
export interface EvidenceEntry {
  /** Tool that produced the result. */
  tool: string;
  /** Bounded line or summary. */
  text: string;
  /** Truncation priority (lower is safer). */
  priority: EvidencePriority;
  /** Whether the result behind this entry is a failure suspicion. */
  suspect: boolean;
}

/** The structural result facts this module reads: no host type required. */
export interface ToolResultLike {
  readonly isError?: boolean;
  readonly value?: unknown;
  readonly content?: readonly TextBlockLike[];
  readonly error?: { readonly message?: string };
}

/** Characters of one evidence line. */
export const EVIDENCE_CHARS = 400;
/** Characters of one result's tail summary. */
export const EVIDENCE_TAIL_CHARS = 240;
/** Characters of the "other" (non-diagnostic, non-tail) fallback per result. */
export const EVIDENCE_OTHER_CHARS = 120;

/**
 * Matches the failure markers that make a result a *candidate* for the closing
 * evidence. A hit is a safety floor: the line is kept whatever the budget says.
 * A miss is never a "failure-free" conclusion — the tail summary goes to System
 * One, which decides what the result means.
 */
export const FAILURE_MARKER = /(\berror\b|\berrors\b|\bfailed\b|\bfailure\b|\bfailures\b|\bfail\b|exit code [1-9]|\bnot ok\b|\bFAIL\b|\bexception\b|\btraceback\b)/i;

/**
 * Prefilter for a failure *suspicion* — the deterministic trigger that makes a
 * closing judgment worth buying. It is broader than {@link FAILURE_MARKER}
 * because `{ok:false}`, a timeout, and a Chinese error must reach System One
 * too; none of these decides anything by itself.
 */
const FAILURE_CUE = new RegExp(
  `${FAILURE_MARKER.source}|\\bok\\b\\s*[:=]\\s*false|"ok"\\s*:\\s*false|\\btimed?\\s*out\\b|\\btimeout\\b|`
    + '失败|错误|异常|超时|无法|未通过|仍有失败|还有失败|报错',
  'i'
);

/**
 * The exit status one tool result carries in its own canonical value.
 *
 * A shell result is *reported*, not errored: a command that exits 1 returns a
 * successful result whose `value.exitCode` is the whole truth. The distinction
 * matters twice over — a correction that never fires because the failure looked
 * like a success, and a closing check that reads a green claim over a red build
 * — so the status is taken from the tool's own structured field whenever the
 * payload exposes one.
 *
 * @param value - the result's canonical value, when it has one.
 * @returns the exit status, or `undefined` when the value is not a shell result.
 */
export function structuredExitStatus(value: unknown): { exitCode: number; signal?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { exitCode?: unknown; signal?: unknown };
  if (typeof candidate.exitCode !== 'number' || !Number.isFinite(candidate.exitCode)) return undefined;
  const status: { exitCode: number; signal?: string } = { exitCode: candidate.exitCode };
  if (typeof candidate.signal === 'string') status.signal = candidate.signal;
  return status;
}

/**
 * Whether the text ends in the host's own exit marker for a failed command.
 *
 * The marker is the last line of the model-facing content, so anchoring it to the
 * end of the text keeps an *ordinary* result that merely mentions "exit code 1"
 * in its body from being misread as a failure. This is the fallback for a result
 * that carries no structured value — a virtual tool, a replay from an older
 * record — not a replacement for {@link structuredExitStatus}.
 * @param text - the model-facing text.
 * @returns whether the last marker line reports a non-zero exit or a signal.
 */
export function exitMarkerFailure(text: string): boolean {
  const match = /(?:^|\n)\[exit code: ([0-9]+)\]\s*$/.exec(text);
  if (match) return Number(match[1]) !== 0;
  return /(?:^|\n)\[killed by signal: [^\]\n]+\]\s*$/.test(text);
}

/**
 * Whether one result is a failure the interventions may act on.
 *
 * Three sources, in order of authority: the host's own `isError` flag, the exit
 * status inside the tool's structured value, and the exit marker the host appends
 * to the text. A text heuristic over words like "failed" is deliberately absent:
 * a test log that prints the word is not a failing command.
 *
 * @param result - the execution-local result.
 * @param text - the effective model-facing text of that result.
 * @returns whether the result proves a failure.
 */
export function failureOf(result: Readonly<ToolResultLike> | undefined, text: string): boolean {
  if (!result) return false;
  if (result.isError === true) return true;
  const status = structuredExitStatus(result.value);
  if (status) return status.exitCode !== 0 || status.signal !== undefined;
  return exitMarkerFailure(text);
}

/** The primitive structured facts one result exposes, for the tail summary. */
function structuredFacts(result: Readonly<ToolResultLike> | undefined): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {};
  if (!result) return facts;
  if (result.isError !== undefined) facts.isError = result.isError === true;
  const status = structuredExitStatus(result.value);
  if (status) {
    facts.exitCode = status.exitCode;
    if (status.signal !== undefined) facts.signal = status.signal;
  }
  let value: unknown = result.value;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['ok', 'status', 'timedOut', 'timeout', 'isError', 'exitCode', 'signal']) {
      const field = record[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') facts[key] = field;
    }
  }
  return facts;
}

/** Whether structured facts alone prove (or at least suspect) a failure. */
function factsSuspectFailure(facts: Readonly<Record<string, string | number | boolean>>): boolean {
  if (facts.isError === true) return true;
  if (typeof facts.exitCode === 'number' && facts.exitCode !== 0) return true;
  if (typeof facts.signal === 'string' && facts.signal.length > 0) return true;
  if (facts.ok === false || facts.timedOut === true || facts.timeout === true) return true;
  if (typeof facts.status === 'string' && /fail|error|timeout|timed_?out/i.test(facts.status)) return true;
  return false;
}

/**
 * Turn one observed result into closing-evidence candidates.
 *
 * The regex is a prefilter and a floor, never a conclusion: matching lines are
 * kept whatever else happens, and a non-matching result still contributes its
 * tail summary (with the structured facts) to System One. A result is a failure
 * *suspicion* when a structured fact, a marker line, or a broader cue says so;
 * what the result really means is decided by the closing judgment.
 *
 * @param tool - tool name that produced the result.
 * @param result - the execution-local result.
 * @param text - the effective model-facing text.
 * @returns bounded candidates, diagnostics first.
 */
export function evidenceOf(
  tool: string,
  result: Readonly<ToolResultLike> | undefined,
  text: string
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  const lines = text.split(/\r?\n/);
  const diagnostics = lines.filter((line) => FAILURE_MARKER.test(line));
  for (const line of diagnostics) {
    const clipped = clip(line.trim(), EVIDENCE_CHARS);
    if (clipped.length > 0) entries.push({ tool, text: clipped, priority: 'diagnostic', suspect: true });
  }
  const facts = structuredFacts(result);
  const factText = Object.keys(facts).length > 0 ? `{${JSON.stringify(facts)}} ` : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const tail = clip(`${factText}${collapsed}`, EVIDENCE_TAIL_CHARS);
  if (tail.length > 0) {
    entries.push({
      tool,
      text: `${tool} tail: ${tail}`,
      priority: 'tail',
      suspect:
        failureOf(result, text)
        || diagnostics.length > 0
        || factsSuspectFailure(facts)
        || FAILURE_CUE.test(text)
    });
  }
  if (diagnostics.length === 0) {
    const head = clip(collapsed, EVIDENCE_OTHER_CHARS);
    if (head.length > 0) {
      entries.push({ tool, text: `${tool}: ${head}`, priority: 'other', suspect: FAILURE_CUE.test(text) });
    }
  }
  return entries;
}

/**
 * Assemble the turn's evidence candidates into one budgeted string.
 *
 * Priority order is diagnostic → tail → other. A diagnostic line is the safety
 * floor and is never dropped; everything else competes for the budget and the
 * dropped characters are reported so the truncation is auditable.
 *
 * @param entries - candidates, oldest first.
 * @param budget - character budget of the assembled text.
 * @returns assembled text plus the kept/dropped character counts.
 */
export function assembleEvidence(
  entries: readonly EvidenceEntry[],
  budget: number
): { text: string; retainedChars: number; truncatedChars: number } {
  const lines: string[] = [];
  let retained = 0;
  let truncated = 0;
  for (const priority of ['diagnostic', 'tail', 'other'] as const) {
    for (const entry of entries) {
      if (entry.priority !== priority) continue;
      const size = entry.text.length + (lines.length > 0 ? 1 : 0);
      const fits = priority === 'diagnostic' || retained + size <= budget;
      if (!fits) {
        truncated += size;
        continue;
      }
      lines.push(entry.text);
      retained += size;
    }
  }
  return { text: lines.join('\n'), retainedChars: retained, truncatedChars: truncated };
}
