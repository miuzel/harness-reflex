/**
 * Adaptive reasoning-effort interception for one agent turn.
 *
 * A deployment may configure `reasoningEffort: 'reflex'` (alias `'auto'`), or an
 * upstream caller may put either marker on the request itself. Neither marker is
 * a physical effort id, so the `agent/request` waterfall cannot forward it: this
 * module turns the marker into a per-turn decision taken by the System 1 choice
 * backend (keyword heuristics offline, the Jev endpoint in production) and
 * projects the decided level onto the vocabulary the routed model actually
 * declares.
 *
 * A deterministic cue classifier runs whenever System 1 is unreachable,
 * malformed, or not confident enough to distinguish the levels. It keeps the
 * interceptor total: a decision is always produced, in milliseconds, and the
 * request never fails because System 1 did.
 *
 * Everything here is deliberately free of Cordis and DSH imports. The decision,
 * the projection, and the status feed are pure functions over plain data, so the
 * rewrite rules are directly testable and the request path stays allocation-light.
 */
import type { ChoiceRequest, ChoiceResponse, DecisionLedger } from './vendor/harness-reflex/index.js';

import { alignReasoningEffort, type PhysicalTarget, type ReasoningProbe, type ReasoningSupport } from './router.js';

/**
 * Selectable reasoning-effort ladder, cheapest first. `minimal` and `max` are
 * part of the vocabulary so a physical model that declares them can be snapped
 * to; the adaptive decision itself only ever chooses `off`, `low`, `medium`, or
 * `high`, which every first-party adapter we target understands.
 */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max'] as const;

/** One selectable reasoning effort. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Levels the adaptive decision and the deployment pin may choose from. */
export const ADAPTIVE_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;

/** One level the adaptive decision may return. */
export type AdaptiveEffortLevel = (typeof ADAPTIVE_EFFORT_LEVELS)[number];

/**
 * Marker asking the plugin to decide this turn's effort itself. `auto` is an
 * accepted alias of `reflex`; both are configurably equivalent to
 * {@link ReasoningEffortSetting}.
 */
export const EFFORT_TRIGGERS = ['reflex', 'auto'] as const;

/** The adaptive trigger marker. */
export type EffortTrigger = (typeof EFFORT_TRIGGERS)[number];

/**
 * What a deployment may put in `reasoningEffort`: a trigger marker (decide per
 * turn) or one concrete level (pin every request that carries no effort).
 */
export type ReasoningEffortSetting = EffortTrigger | EffortLevel;

/** Where one turn's effort came from. */
export type EffortSource = 'system-one' | 'cue-fallback';

/** What the decided level became on the physical route. */
export type EffortOutcome = 'supported' | 'snapped' | 'cleared' | 'unknown' | 'passthrough';

/** What asked for the decision. */
export type EffortTriggerKind = 'request' | 'config' | 'fixed-config';

/** Characters of the turn input handed to System 1 as the question. */
export const EFFORT_QUESTION_CHARS = 600;

/** Characters of the turn input kept in the audit surfaces. */
export const EFFORT_AUDIT_TASK_CHARS = 160;

/**
 * Scenario vocabulary of one adaptive level. The first token of every rendered
 * option is the level id, so a backend answer is parsed by prefix; the remaining
 * words are the evidence vocabulary that keyword-scoring backends match against
 * the question. It stays deliberately close to how a human reads a task
 * ("rename this variable" versus "design the migration"), and it carries the
 * common Chinese phrasings of the same tiers so a bilingual prompt lands on the
 * same level.
 */
export const EFFORT_LEVEL_DESCRIPTIONS: Record<AdaptiveEffortLevel, string> = {
  off: 'no thinking needed: greeting acknowledgement chit chat small talk thanks confirmation yes no 你好 您好 谢谢 好的 收到 继续 没问题',
  low: 'minimal thinking: rename typo whitespace formatting lint comment version bump revert reword simple lookup list files read file one liner 改名 重命名 错字 错别字 注释 格式化 简单 查看文件 列出文件',
  medium:
    'moderate thinking: implement add write update fix change adjust extend wire register support expose test docs config endpoint handler function method class module service component cli api 实现 添加 编写 修改 修复 测试 单元测试 文档 配置 接口 函数 组件 命令行',
  high: 'deep thinking: architecture design security threat concurrency race deadlock performance optimize throughput latency scalability algorithm complexity migration distributed invariant protocol prove proof theorem analyze analysis root cause trade off audit benchmark profile semantics refactor backward compatibility 架构 并发 死锁 性能 优化 吞吐 延迟 迁移 分布式 不变量 证明 定理 根因 权衡 安全审计 语义'
};

/**
 * Candidate levels System 1 ranks against the turn input, in ladder order.
 *
 * Kept as the deployment-wide default (no model capability known yet). Once the
 * routed model is known, {@link buildEffortChoiceOptions} narrows this to the
 * levels that model actually declares, so the adaptive decision never has to be
 * snapped afterwards.
 */
export const EFFORT_CHOICE_OPTIONS: readonly string[] = ADAPTIVE_EFFORT_LEVELS.map(
  (level) => `${level} ${EFFORT_LEVEL_DESCRIPTIONS[level]}`
);

/** Matched cue words per tier, plus cheap shape facts about the input. */
export interface EffortCues {
  /** Characters in the trimmed turn input. */
  length: number;
  /** Ordering words that need no reasoning at all. */
  trivial: string[];
  /** Mechanical edits a smaller model handles as well as a large one. */
  light: string[];
  /** Ordinary implementation work. */
  moderate: string[];
  /** Work whose cost of being wrong justifies the expensive level. */
  deep: string[];
}

/** One adaptive decision, before it is projected onto a physical route. */
export interface EffortDecision {
  level: AdaptiveEffortLevel;
  source: EffortSource;
  /** 0 – 1 confidence of the winning evidence; 0 means nothing matched. */
  confidence: number;
  /** Wall-clock milliseconds the decision cost. */
  latencyMs: number;
  /** Verbatim evidence the decision rested on (matched cue words, or the option). */
  basis: string[];
  /** Set when System 1 answered but the engine still had to fall back to cues. */
  degradedReason?: string;
}

/** Executes one System 1 choice; matches `DecisionBackend['choice']`. */
export type EffortDecider = (request: ChoiceRequest) => Promise<ChoiceResponse>;

/** Agent attribution carried into the audit surfaces. */
export interface EffortAgentFacts {
  agentId?: string;
  role?: string;
  delegationDepth?: number;
}

/** Everything one request needs decided about its reasoning effort. */
export interface EffortRequestContext {
  /** Effort the resolved request carries (after the LLM waterfall). */
  requested?: string;
  /** Physical route the rewritten request will reach. */
  target: PhysicalTarget;
  /** Capability lookup for that route; absent leaves the level unprojected. */
  probe?: ReasoningProbe;
  /** Turn input captured on `agent/pre-step`. */
  task?: string;
  agent?: EffortAgentFacts;
  turn?: number;
  step?: number;
  /** Provider the request named before routing, for the status line. */
  requestedProvider?: string;
  /** Model the request named before routing, for the status line. */
  requestedModel?: string;
  /** Whether routing moved the request onto another provider/model. */
  switched?: boolean;
  /** Whether the request stayed on the current model due to prompt-cache affinity. */
  heldForCache?: boolean;
  /**
   * Pre-computed capability result for `target`. Supplying it skips the second
   * probe when the caller already resolved the route's declared vocabulary.
   */
  support?: ReasoningSupport;
}

/** The rewrite instruction one request produces. */
export interface EffortResolution {
  /** Effort the rewritten request must carry; absent clears the key. */
  effort?: string;
  /** Whether the caller must rewrite `reasoningEffort`. */
  changed: boolean;
  outcome: EffortOutcome;
  /** Set when this turn's effort was decided (adaptive or pinned by config). */
  trigger?: EffortTriggerKind;
  /** The adaptive decision, when one was taken. */
  decision?: EffortDecision;
  /** Status-bar payload, when one was produced. */
  status?: ReflexEffortStatus;
}

/** One published effort status, shaped for a status bar and for the audit log. */
export interface ReflexEffortStatus {
  level: AdaptiveEffortLevel;
  /** Effort actually carried by the rewritten request; absent = cleared. */
  applied?: string;
  outcome: EffortOutcome;
  trigger: EffortTriggerKind;
  source: EffortSource;
  confidence: number;
  latencyMs: number;
  provider: string;
  model: string;
  /** Single-line rendering, ready for a status bar. */
  line: string;
  /** Unix epoch milliseconds of the decision. */
  at: number;
  agentId?: string;
  role?: string;
  delegationDepth?: number;
  turn?: number;
  step?: number;
  /** Verbatim evidence the decision rested on. */
  basis?: string[];
  /** Set when System 1 could not be used. */
  degradedReason?: string;
  /** Turn input excerpt; audit only, never re-sent to a model. */
  task?: string;
  /** Provider named by the request before routing (the virtual one, when routed). */
  requestedProvider?: string;
  /** Model named by the request before routing. */
  requestedModel?: string;
  /** Whether the request actually moved to another provider/model. */
  switched?: boolean;
  /** Whether the model was held to defend upstream prompt-cache affinity. */
  heldForCache?: boolean;
  /** Effort ids the routed model declares; `[]` when it declares none. */
  supportedEfforts?: string[];
}

/** Whether a value is the adaptive trigger marker. */
export function isEffortTrigger(value: string | undefined): value is EffortTrigger {
  return value !== undefined && (EFFORT_TRIGGERS as readonly string[]).includes(value);
}

/** Whether a value is one concrete level of the ladder. */
export function isEffortLevel(value: string | undefined): value is EffortLevel {
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Whether a value is a level the adaptive decision itself may return. */
export function isAdaptiveEffortLevel(value: string | undefined): value is AdaptiveEffortLevel {
  return value !== undefined && (ADAPTIVE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Position of one effort on the shared ladder.
 * @param level - any effort id.
 * @returns the zero-based rank, or -1 when the ladder does not know the id.
 */
export function effortRank(level: string): number {
  return (EFFORT_LEVELS as readonly string[]).indexOf(level);
}

/**
 * Choose the declared effort closest to the decided level.
 *
 * A physical model rarely declares exactly our four levels (DeepSeek, for one,
 * declares `off`, `low`, `high`, and `max`). Rather than letting an absent
 * `medium` collapse onto the provider default, this picks the neighbour on the
 * ladder; an exact tie takes the cheaper side, because the decision already
 * carries the intent and overspending is the failure mode that costs money.
 *
 * @param level - the decided level.
 * @param efforts - effort ids the target declares.
 * @param defaultEffort - the target's declared default, used when no id is rankable.
 * @returns the effort to send, or `undefined` when nothing can be ranked.
 */
export function snapEffort(
  level: EffortLevel,
  efforts: readonly string[],
  defaultEffort?: string
): string | undefined {
  const wanted = EFFORT_LEVELS.indexOf(level);
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of efforts) {
    const rank = effortRank(candidate);
    if (rank < 0) continue;
    const distance = Math.abs(rank - wanted);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (best !== undefined) return best;
  if (defaultEffort !== undefined && efforts.includes(defaultEffort)) return defaultEffort;
  return undefined;
}

/**
 * Project one decided level onto the routed model's declared vocabulary.
 *
 * - the target declares the level: send it unchanged;
 * - the target declares other levels: slide to the nearest declared neighbour;
 * - the target declares no reasoning at all: clear the key, so a
 *   non-thinking model is asked exactly what it can answer;
 * - the capability is unknown (no LLM runtime, or a resolver failure): keep the
 *   level and let the adapter decide, as it does for any other route.
 *
 * @param level - the decided level.
 * @param target - the physical route the request will reach.
 * @param probe - optional capability lookup.
 * @returns the effort to send (absent clears the key) and what happened.
 */
export async function projectEffort(
  level: EffortLevel,
  target: PhysicalTarget,
  probe?: ReasoningProbe
): Promise<{ effort?: string; outcome: EffortOutcome }> {
  if (!probe) return { effort: level, outcome: 'unknown' };

  let support;
  try {
    support = await probe(target);
  } catch {
    return { effort: level, outcome: 'unknown' };
  }

  if (support.kind === 'unknown') return { effort: level, outcome: 'unknown' };
  if (support.kind === 'none') return { outcome: 'cleared' };
  if (support.efforts.includes(level)) return { effort: level, outcome: 'supported' };

  const snapped = snapEffort(level, support.efforts, support.defaultEffort);
  return snapped === undefined ? { outcome: 'cleared' } : { effort: snapped, outcome: 'snapped' };
}

/**
 * Project one decided level that was *already chosen inside* the model's
 * candidate set.
 *
 * Unlike {@link projectEffort} this never snaps silently: a decision taken
 * within the declared vocabulary is `supported` by construction, and only a
 * degenerate declaration (no adaptive id at all) can still need a slide. The
 * distinction is what removes `snapped` from the正常 path: the interceptor now
 * reads the declaration first instead of repairing the answer afterwards.
 *
 * @param level - the decided level.
 * @param support - the routed model's declared vocabulary.
 * @returns the effort to send (absent clears the key) and what happened.
 */
export function projectWithinSupport(
  level: AdaptiveEffortLevel,
  support: ReasoningSupport
): { effort?: string; outcome: EffortOutcome } {
  if (support.kind === 'unknown') return { effort: level, outcome: 'unknown' };
  if (support.kind === 'none') return { outcome: 'cleared' };
  if (support.efforts.includes(level)) return { effort: level, outcome: 'supported' };

  const candidates = adaptiveCandidateLevels(support.efforts);
  const near = nearestCandidate(level, candidates);
  if (support.efforts.includes(near)) return { effort: near, outcome: 'supported' };

  const snapped = snapEffort(near, support.efforts, support.defaultEffort);
  return snapped === undefined ? { outcome: 'cleared' } : { effort: snapped, outcome: 'snapped' };
}

/**
 * Read the routed model's declared vocabulary, never throwing.
 * @param context - request context; a pre-computed `support` skips the probe.
 * @returns the declaration, or `unknown` when no probe can answer.
 */
async function resolveSupport(context: EffortRequestContext): Promise<ReasoningSupport> {
  if (context.support) return context.support;
  if (!context.probe) return { kind: 'unknown' };
  try {
    return await context.probe(context.target);
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The adaptive levels a model that declares `efforts` can actually be asked for.
 *
 * This is the S3 fix in one function: instead of deciding on the fixed
 * `off/low/medium/high` ladder and snapping the answer afterwards (which made
 * `medium → low` on DeepSeek and `off → low` on GPT a *normal* outcome), the
 * candidate set is derived from the declaration first, so the decision and the
 * dispatched effort are the same value.
 *
 * - no declaration known: the whole adaptive ladder;
 * - a declared level is offered whenever it is an adaptive level (so DeepSeek's
 *   `off/low/high` and GPT's `low/medium/high` are used as-is);
 * - a declaration that shares no adaptive id (Say `minimal`/`max` only) is
 *   projected onto the nearest adaptive level, so a candidate set always exists.
 *
 * @param efforts - effort ids the routed model declares.
 * @returns candidate levels in ladder order, never empty.
 */
export function adaptiveCandidateLevels(efforts?: readonly string[]): AdaptiveEffortLevel[] {
  if (!efforts || efforts.length === 0) return [...ADAPTIVE_EFFORT_LEVELS];

  const declared = new Set(efforts);
  const direct = ADAPTIVE_EFFORT_LEVELS.filter((level) => declared.has(level));
  if (direct.length > 0) return direct;

  const projected = new Set<AdaptiveEffortLevel>();
  for (const effort of efforts) {
    const rank = effortRank(effort);
    if (rank < 0) continue;
    projected.add(nearestAdaptiveLevel(rank));
  }
  return projected.size === 0 ? [...ADAPTIVE_EFFORT_LEVELS] : ADAPTIVE_EFFORT_LEVELS.filter((level) => projected.has(level));
}

/**
 * Nearest adaptive level to one ladder rank, preferring the cheaper side.
 * @param rank - rank on {@link EFFORT_LEVELS}.
 * @returns the closest adaptive level.
 */
function nearestAdaptiveLevel(rank: number): AdaptiveEffortLevel {
  let best: AdaptiveEffortLevel = 'medium';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of ADAPTIVE_EFFORT_LEVELS) {
    const distance = Math.abs(effortRank(level) - rank);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Project one decided level into a candidate set.
 *
 * An exact member is returned unchanged (the normal case). A level the model
 * does not offer slides to the nearest candidate; an exact tie takes the cheaper
 * side, because the decision already carries the intent and overspending is the
 * failure mode that costs money.
 *
 * @param level - the decided level.
 * @param candidates - candidate levels derived from the model declaration.
 * @returns a member of `candidates`.
 */
export function nearestCandidate(level: AdaptiveEffortLevel, candidates: readonly AdaptiveEffortLevel[]): AdaptiveEffortLevel {
  const pool = candidates.length > 0 ? candidates : ADAPTIVE_EFFORT_LEVELS;
  if (pool.includes(level)) return level;

  const wanted = effortRank(level);
  let best: AdaptiveEffortLevel = pool[0] ?? level;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const distance = Math.abs(effortRank(candidate) - wanted);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Render the System 1 candidate options for one model declaration.
 *
 * A level the model does not declare is not silently dropped: its scenarios are
 * absorbed by the neighbouring candidates, so the backend still sees vocabulary
 * for every kind of task. `off` (below the cheapest candidate) is absorbed by
 * the cheapest one — GPT, whose lowest level is `low`, therefore answers `low`
 * for a greeting instead of producing `off → low (snapped)`. `medium`, which
 * sits *between* two declared levels, is absorbed by both neighbours, which is
 * what makes "ordinary implementation work" readable as either `low` or `high`
 * on a model that declares `off/low/high`.
 *
 * @param efforts - effort ids the routed model declares.
 * @returns one option per candidate, in ladder order.
 */
export function buildEffortChoiceOptions(efforts?: readonly string[]): string[] {
  const candidates = adaptiveCandidateLevels(efforts);
  const cheapest = candidates[0] ?? 'low';
  const absorbed = new Map<AdaptiveEffortLevel, AdaptiveEffortLevel[]>([
    ...candidates.map((level) => [level, [level]] as [AdaptiveEffortLevel, AdaptiveEffortLevel[]])
  ]);

  for (const missing of ADAPTIVE_EFFORT_LEVELS) {
    if (candidates.includes(missing)) continue;
    const below = candidates.filter((level) => effortRank(level) < effortRank(missing)).pop();
    const above = candidates.find((level) => effortRank(level) > effortRank(missing));
    if (below === undefined && above === undefined) {
      absorbed.get(cheapest)?.push(missing);
      continue;
    }
    // Below the cheapest candidate: the cheapest one answers for it.
    if (below === undefined) {
      if (above !== undefined) absorbed.get(above)?.push(missing);
      continue;
    }
    absorbed.get(below)?.push(missing);
    // Between two candidates: both neighbours offer it, so its vocabulary stays
    // reachable from either side of the gap.
    if (above !== undefined) absorbed.get(above)?.push(missing);
  }

  return candidates.map((level) => {
    const levels = (absorbed.get(level) ?? [level]).slice().sort((left, right) => effortRank(left) - effortRank(right));
    const description = levels.map((entry) => EFFORT_LEVEL_DESCRIPTIONS[entry]).join(' ');
    return `${level} ${description}`;
  });
}

/** Cue weights: an explicit deep cue outweighs a pile of mechanical ones. */
const CUE_WEIGHTS: Record<'trivial' | 'light' | 'moderate' | 'deep', number> = {
  trivial: 3,
  light: 2,
  moderate: 2,
  deep: 3
};

/** Priority used when two tiers score the same: more thinking wins. */
const CUE_TIE_BREAK: readonly (keyof typeof CUE_WEIGHTS)[] = ['deep', 'moderate', 'light', 'trivial'];

/** Tier that decides the level when a tier wins the vote. */
const TIER_LEVEL: Record<keyof typeof CUE_WEIGHTS, AdaptiveEffortLevel> = {
  trivial: 'off',
  light: 'low',
  moderate: 'medium',
  deep: 'high'
};

/** Cue vocabulary. Order inside one tier does not matter; tiers are scored apart. */
const CUE_VOCABULARY: Record<'trivial' | 'light' | 'moderate' | 'deep', readonly RegExp[]> = {
  trivial: [
    /\b(?:hi|hello|hey|yo|thanks|thank you|thx|ok|okay|yes|no|sure|ack|acknowledged|proceed|continue|go ahead|sounds good|got it)\b/g,
    /(?:你好|您好|谢谢|好的|收到|继续|没问题)/g
  ],
  light: [
    /\b(?:rename|typo|typos|whitespace|format|formatting|reformat|lint|comment|comments|docstring|version|bump|revert|reword|wording|typos?)\b/g,
    /\b(?:list|show)\s+(?:the\s+)?files?\b/g,
    /\b(?:read|open|cat)\s+(?:the\s+)?file\b/g,
    /\blook\s?up\b/g,
    /\bone[- ]liner\b/g,
    /\bsimple\b/g,
    /(?:改名|重命名|错字|错别字|注释|格式化|简单|查看文件|列出文件)/g
  ],
  moderate: [
    /\b(?:implement|add|added|write|update|fix|fixed|change|adjust|extend|wire|register|support|expose|test|tests|docs|documentation|config|configuration|endpoint|handler|function|method|class|module|service|component|cli|api|refactor)\b/g,
    /(?:实现|添加|编写|修改|修复|测试|单元测试|文档|配置|接口|函数|组件|命令行)/g
  ],
  deep: [
    /\b(?:architect(?:ure|ural)?|design|security|threat|concurren(?:cy|t)|race condition|deadlock|performance|optimiz(?:e|ation)|throughput|latency|scal(?:e|ability|ing)|algorithm|complexity|migration|migrate|distributed|invariant|protocol|prove|proof|theorem|analy(?:ze|sis)|root cause|trade[- ]?off|audit|benchmark|profile|semantics|debug|backward compatib\w*)\b/g,
    /(?:架构|并发|死锁|性能|优化|吞吐|延迟|迁移|分布式|不变量|证明|定理|根因|权衡|安全审计|语义)/g
  ]
};

/**
 * Instructions that ask for a literal restatement rather than work: "only return
 * this verbatim", "do not analyze it", `原样返回`, and their kin.
 *
 * P9 is the regression this guards: the payload inside the quotes was scanned as
 * if the task were about architecture, concurrency, and proofs, and the turn was
 * billed at `high` for copying six words.
 */
const VERBATIM_INSTRUCTION =
  /(?:\b(?:only|just)\s+return|\breturn\b[^.;\n]{0,40}?\bverbatim|\brepeat\s+(?:it\s+)?verbatim|\bverbatim\b|\becho\s+back\b|\bcopy\s+verbatim\b|\bquoted text\b|\bwithout\s+analyzing\b|\bdo\s+not\s+analyze\b|\bdon'?t\s+analyze\b|原样返回|原样发给我|原样发给|原样输出|原文照抄|照抄|只返回|仅返回|逐字|不分析|不要分析|无需分析)/iu;

/** A negation clause whose cue words describe what *not* to do. */
const NEGATED_CUE_CLAUSE =
  /(?:\b(?:without|do\s+not|don'?t|never|no\s+need\s+to)\s+(?:\w+\s+){0,2}(?:analy\w*|prov\w*|architect\w*|design\w*|audit\w*|refactor\w*|optimiz\w*)|不(?:必|用|要)?(?:分析|证明|设计|重构|审计)|无需(?:分析|证明|设计|重构|审计))/giu;

/** One quoted literal payload: ASCII or typographic quotation, backticks. */
const QUOTED_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」/gu;

/** Placeholder substituted for a stripped quoted payload. */
export const QUOTED_LITERAL_PLACEHOLDER = '[quoted literal]';

/** Result of removing restatement noise from one turn input. */
export interface CleanedEffortTask {
  /** The input with negation clauses and (for restatements) quoted payloads removed. */
  text: string;
  /** Whether the input asks for a literal restatement or echo. */
  verbatim: boolean;
  /** Quoted payloads that were stripped, longest first. */
  quoted: string[];
}

/**
 * Strip the parts of a turn input that can only mislead a depth classifier.
 *
 * Two independent cleanups, both evidence-driven:
 *
 * 1. Negation clauses (`without analyzing`, `不要分析`, ...) are removed
 *    unconditionally: the words inside them name what the turn does *not* ask
 *    for, so scoring them as depth cues is a pure false positive.
 * 2. When the turn is a restatement instruction, quoted payloads are replaced by
 *    a neutral placeholder. The quoted words are data the model must echo, not
 *    work it must reason about — P9's six deep-looking words are exactly that.
 *
 * @param task - the raw turn input.
 * @returns the cleaned text plus the facts the caller needs to explain it.
 */
export function cleanEffortTaskText(task: string): CleanedEffortTask {
  const original = task.trim();
  let text = original.replace(NEGATED_CUE_CLAUSE, ' ');
  const verbatim = VERBATIM_INSTRUCTION.test(original);
  const quoted: string[] = [];

  if (verbatim) {
    text = text.replace(QUOTED_LITERAL, (match) => {
      quoted.push(match);
      return ` ${QUOTED_LITERAL_PLACEHOLDER} `;
    });
  }

  return { text: text.replace(/\s+/g, ' ').trim(), verbatim, quoted };
}

/**
 * Read the cue words and the shape facts of one turn input.
 * @param task - the turn input captured before the request.
 * @returns matched cue words per tier, deduplicated, plus the input length.
 */
export function readEffortCues(task: string): EffortCues {
  const cleaned = cleanEffortTaskText(task);
  const text = cleaned.text;
  const lower = text.toLowerCase();
  const cues: EffortCues = { length: text.length, trivial: [], light: [], moderate: [], deep: [] };

  for (const tier of CUE_TIE_BREAK) {
    const matched = new Set<string>();
    for (const pattern of CUE_VOCABULARY[tier]) {
      // A fresh lastIndex per call: a shared /g regex would carry state across turns.
      pattern.lastIndex = 0;
      for (const match of lower.matchAll(pattern)) {
        const word = match[0].trim();
        if (word.length > 0) matched.add(word);
      }
    }
    cues[tier] = [...matched];
  }

  if (cleaned.verbatim) {
    // The turn's real work is a copy, whatever words the payload contained. Any
    // depth cue that survived the cleanup came from the instruction's own
    // phrasing, and is not evidence about the task.
    cues.moderate = [];
    cues.deep = [];
    cues.light = [];
    cues.trivial = ['verbatim restatement'];
  }

  return cues;
}

/** One tier's vote. */
export interface EffortCueVote {
  level: AdaptiveEffortLevel;
  tier: keyof typeof CUE_WEIGHTS;
  score: number;
  total: number;
  basis: string[];
  /** The tier's level before it was projected into the model's candidate set. */
  decided?: AdaptiveEffortLevel;
}

/**
 * Decide one turn's effort from cue words alone.
 *
 * Deterministic by construction: tier weights, then the cheap shape facts
 * (a very short input that asks nothing else, a diff-sized input), then a fixed
 * tie-break that prefers more thinking. This is the fail-safe path, so it must
 * never depend on a backend, a clock, or a random source.
 *
 * @param cues - cue words of one turn input.
 * @param fallback - level used when no tier matches at all.
 * @param efforts - effort ids the routed model declares; omitted keeps the whole ladder.
 * @returns the winning level, its tier, and the evidence behind it.
 */
export function classifyByCues(
  cues: EffortCues,
  fallback: AdaptiveEffortLevel = 'medium',
  efforts?: readonly string[]
): EffortCueVote {
  const scores: Record<keyof typeof CUE_WEIGHTS, number> = {
    trivial: CUE_WEIGHTS.trivial * cues.trivial.length,
    light: CUE_WEIGHTS.light * cues.light.length,
    moderate: CUE_WEIGHTS.moderate * cues.moderate.length,
    deep: CUE_WEIGHTS.deep * cues.deep.length
  };

  const totalCues = cues.trivial.length + cues.light.length + cues.moderate.length + cues.deep.length;
  if (cues.length > 0 && cues.length <= 24 && cues.light.length === 0 && cues.moderate.length === 0 && cues.deep.length === 0) {
    // "ok go ahead" is an instruction, not a task; it needs no reasoning budget.
    scores.trivial += 2;
  }
  if (cues.length > 600 && cues.deep.length === 0) {
    // A pasted diff or log is ordinary work with a large payload.
    scores.moderate += 1;
  }

  const total = scores.trivial + scores.light + scores.moderate + scores.deep;
  if (total === 0 || totalCues === 0) {
    const level = nearestCandidate(fallback, adaptiveCandidateLevels(efforts));
    return { level, tier: 'moderate', score: 0, total: 0, basis: [], decided: fallback };
  }

  let winner: keyof typeof CUE_WEIGHTS = 'moderate';
  for (const tier of CUE_TIE_BREAK) {
    if (scores[tier] > scores[winner]) winner = tier;
  }

  const decided = TIER_LEVEL[winner];
  return {
    level: nearestCandidate(decided, adaptiveCandidateLevels(efforts)),
    tier: winner,
    score: scores[winner],
    total,
    basis: cues[winner].slice(0, 8),
    decided
  };
}

/**
 * Build the System 1 choice request for one turn input.
 *
 * The candidate options are the routed model's own levels (see
 * {@link buildEffortChoiceOptions}), and the question is the cleaned turn input
 * (see {@link cleanEffortTaskText}). The context stays neutral on purpose: the
 * old implementation pasted the raw matched keyword list into
 * `reasoning depth cues in this task: architecture algorithm proof ...`, which
 * handed a keyword-scoring backend the exact words the cleanup had just removed
 * — the second half of the P9 regression.
 *
 * @param task - the turn input captured before the request.
 * @param cues - its cue words (already cleaned).
 * @param efforts - effort ids the routed model declares; omitted keeps the whole ladder.
 * @returns the question and the level candidates.
 */
export function buildEffortChoice(task: string, cues: EffortCues, efforts?: readonly string[]): ChoiceRequest {
  const cleaned = cleanEffortTaskText(task);
  const question =
    cleaned.text.length > 0 ? cleaned.text.slice(0, EFFORT_QUESTION_CHARS) : 'the agent received no new instruction this turn';
  const options = buildEffortChoiceOptions(efforts);

  let context: string | undefined;
  if (cleaned.verbatim) {
    context =
      `${QUOTED_LITERAL_PLACEHOLDER} marks a quoted payload the task only asks to restate; judge the instruction, not the quoted words.`;
  } else if (efforts !== undefined && efforts.length > 0) {
    // The candidate levels are already the head of every option below, so the
    // context only has to say *that* the choice is bounded — naming them again
    // would reward whichever description happens to spell a level out.
    context = 'the routed model offers a bounded set of reasoning levels; choose the one this turn needs';
  }

  return {
    question,
    options,
    ...(context === undefined ? {} : { context })
  };
}

/**
 * Read the level out of one candidate option.
 * @param option - an option produced by {@link EFFORT_CHOICE_OPTIONS}.
 * @returns the level id, or `undefined` for a foreign or malformed option.
 */
export function levelOfChoiceOption(option: string): AdaptiveEffortLevel | undefined {
  const head = option.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return isAdaptiveEffortLevel(head) ? head : undefined;
}

/** Options of {@link EffortInterceptor}. */
export interface EffortInterceptorOptions {
  /** Deployment `reasoningEffort`: a trigger marker or one pinned level. */
  setting?: ReasoningEffortSetting;
  /**
   * Deployment `effort.enabled` switch; `false` makes the whole interceptor
   * inert. Defaults to `true`, which is why an activation that never asked for
   * the switch behaves exactly as it did before it existed.
   */
  enabled?: boolean;
  /** Level used when no cue matches; defaults to `medium`. */
  fallback?: AdaptiveEffortLevel;
  /** Minimum System 1 confidence for its answer to be trusted; defaults to 0.3. */
  minConfidence?: number;
  /** System 1 choice execution. */
  decide: EffortDecider;
  /** Backend name recorded in the ledger. */
  backendName: string;
  /** Audit sink; one `effort-decision` entry per adaptive decision. */
  ledger?: DecisionLedger;
  /** Status feed the decision is published to. */
  feed?: EffortStatusFeed;
  /** Monotonic clock, injectable for tests. */
  now?: () => number;
}

/**
 * Turns one request's marker into a rewritten reasoning effort.
 *
 * The interceptor is the whole policy in one place: it recognises the trigger,
 * asks System 1, falls back to cues, projects onto the route, audits, and
 * publishes. It never throws: a broken backend, a hostile option list, or a
 * failing ledger must not be able to veto an agent turn.
 */
export class EffortInterceptor {
  readonly setting: ReasoningEffortSetting | undefined;
  /**
   * The deployment switch. When `false` this interceptor decides nothing: no
   * System 1 round trip, no cue vote, no ledger entry, no status, and no rewrite
   * — only the marker is cleared, because it is an intent no adapter accepts.
   */
  readonly enabled: boolean;
  readonly fallback: AdaptiveEffortLevel;
  readonly minConfidence: number;

  #decide: EffortDecider;
  #backendName: string;
  #ledger: DecisionLedger | undefined;
  #feed: EffortStatusFeed | undefined;
  #now: () => number;

  /**
   * @param options - deployment setting, System 1 seam, and audit sinks.
   */
  constructor(options: EffortInterceptorOptions) {
    this.setting = options.setting;
    this.enabled = options.enabled ?? true;
    this.fallback = options.fallback ?? 'medium';
    this.minConfidence = options.minConfidence ?? 0.3;
    this.#decide = options.decide;
    this.#backendName = options.backendName;
    this.#ledger = options.ledger;
    this.#feed = options.feed;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Whether this activation has an adaptive policy to apply at all. */
  get adaptive(): boolean {
    return this.enabled && this.setting !== undefined;
  }

  /**
   * Decide what one request should carry.
   * @param context - resolved request, routed target, turn input, and attribution.
   * @returns the rewrite instruction, plus the audit status when a decision was taken.
   */
  async resolve(context: EffortRequestContext): Promise<EffortResolution> {
    const { requested } = context;

    if (!this.enabled) {
      // The switch is off, so this layer has no policy left: a concrete level or
      // a silent request is passed through untouched (the deployment asked for
      // the effort plumbing to stay out of the way), and a marker is *cleared*
      // rather than translated. Clearing is the safe fallback the adapter
      // boundary needs — the request lands on the provider's own default, and
      // the plugin's marker can never reach a provider that never heard of it.
      if (isEffortTrigger(requested)) return { changed: true, outcome: 'cleared' };
      return { changed: false, outcome: 'passthrough' };
    }

    if (isEffortTrigger(requested)) return this.#decideTurn('request', context);
    if (requested === undefined && isEffortTrigger(this.setting)) return this.#decideTurn('config', context);

    if (requested === undefined && isEffortLevel(this.setting)) {
      // A pinned deployment level is not a decision: no System 1 round trip, no
      // cue vote, no ledger entry, and no status to report — it only has to be
      // projected onto the physical route the request will reach.
      const projection = await projectEffort(this.setting, context.target, context.probe);
      return {
        ...projection,
        changed: projection.effort !== undefined,
        trigger: 'fixed-config'
      };
    }

    // Anything else is the caller's own business: an explicit concrete level is
    // passed through untouched, and only alignment onto the routed target's
    // vocabulary is applied, exactly as it was before this interceptor existed.
    // The outcome stays `passthrough` even when alignment moved the level: this
    // is not an adaptive decision, and the observation S3 asks for — "is the
    // adaptive strategy still producing levels the model cannot answer?" — is
    // read from the *decision* path's outcome, where `snapped` now means exactly
    // that a decided level did not exist in the routed model's own set.
    if (requested === undefined) return { changed: false, outcome: 'passthrough' };
    if (!context.probe) return { changed: false, effort: requested, outcome: 'unknown' };

    const aligned = await alignReasoningEffort(requested, context.target, context.probe);
    return {
      changed: aligned !== requested,
      ...(aligned === undefined ? {} : { effort: aligned }),
      outcome: 'passthrough'
    };
  }

  /**
   * Decide one adaptive turn: resolve the model's own levels, then System 1,
   * then the cue classifier as the fail-safe.
   *
   * The order is the S3 fix. The routed model's declared vocabulary is read
   * *first*; the decision is then taken inside that set, so "decided `medium`
   * but dispatched `low`" is no longer a normal outcome. A model that declares
   * no reasoning at all is decided from its cues alone — there is nothing to
   * choose, so the round trip would buy nothing.
   *
   * @param trigger - what asked for the decision.
   * @param context - request context.
   * @returns the rewrite instruction plus the status payload.
   */
  async #decideTurn(trigger: EffortTriggerKind, context: EffortRequestContext): Promise<EffortResolution> {
    const task = context.task ?? '';
    const started = this.#now();
    const support = await resolveSupport(context);
    const efforts = support.kind === 'declared' ? [...support.efforts] : undefined;

    if (support.kind === 'none') {
      // The model cannot think, so no System 1 round trip is worth buying: the
      // turn's level is still *reported* — the status row and the audit have to
      // say how deep the turn was — but the request must not carry the key.
      const decision = this.#decideByCues(
        readEffortCues(task),
        started,
        undefined,
        'target model declares no reasoning; the level is reported but never sent'
      );
      const status = buildEffortStatus(decision, { outcome: 'cleared' }, trigger, context, support);
      this.#publish(decision, status, task);

      return { changed: context.requested !== undefined, outcome: 'cleared', trigger, decision, status };
    }

    const cues = readEffortCues(task);
    // A restatement instruction is decided by its shape, not by its content: the
    // payload may be unquoted (`原文照抄：design the migration protocol`) and the
    // instruction's own phrasing may survive the negation cleanup (`不要优化…`).
    // Asking a backend to grade those words would re-introduce exactly the P9
    // false positive the cleanup exists to remove, so the cue verdict stands.
    const attempt = cleanEffortTaskText(task).verbatim
      ? { reason: 'the turn is a restatement instruction; the payload is a copy, not work to grade' }
      : await this.#askSystemOne(task, cues, started, efforts);
    const decision = attempt.decision ?? this.#decideByCues(cues, started, efforts, attempt.reason);

    const projection = projectWithinSupport(decision.level, support);
    const status = buildEffortStatus(decision, projection, trigger, context, support);
    this.#publish(decision, status, task);

    return {
      changed: projection.effort !== context.requested,
      ...(projection.effort === undefined ? {} : { effort: projection.effort }),
      outcome: projection.outcome,
      trigger,
      decision,
      status
    };
  }

  /**
   * Ask System 1 for the level, tolerating every failure mode.
   * @param task - turn input.
   * @param cues - its cue words.
   * @param started - monotonic start of the decision.
   * @param efforts - effort ids the routed model declares, when known.
   * @returns the decision, or the diagnosis of why System 1 could not be trusted.
   */
  async #askSystemOne(task: string, cues: EffortCues, started: number, efforts?: readonly string[]): Promise<SystemOneAttempt> {
    let response: ChoiceResponse;
    try {
      response = await this.#decide(buildEffortChoice(task, cues, efforts));
    } catch (error) {
      return { reason: `system-one call failed: ${errorMessage(error)}` };
    }

    const option = String(response?.bestOption ?? '');
    const level = levelOfChoiceOption(option);
    if (level === undefined) return { reason: `system-one answered with an unknown option: ${option.slice(0, 40) || '(empty)'}` };

    const confidence = Number(response?.confidence);
    if (!Number.isFinite(confidence)) return { reason: `system-one answered without a confidence: ${option.slice(0, 40)}` };

    // A tie is not a decision. A backend that scores every option equally
    // answers `1 / candidates`, which for three or more candidates clears the
    // absolute floor while carrying no evidence at all — the winner is then
    // whichever level merely came first in the ladder. Require the answer to
    // beat the uniform baseline outright before it is trusted.
    const candidateCount = adaptiveCandidateLevels(efforts).length;
    const uniform = candidateCount > 1 ? 1 / candidateCount : 0;
    if (confidence < this.minConfidence) {
      return { reason: `system-one confidence ${confidence.toFixed(2)} is below the floor ${this.minConfidence.toFixed(2)}` };
    }
    if (confidence <= uniform) {
      return {
        reason: `system-one confidence ${confidence.toFixed(2)} does not beat the ${candidateCount}-way baseline ${uniform.toFixed(2)}`
      };
    }

    return {
      decision: {
        level: nearestCandidate(level, adaptiveCandidateLevels(efforts)),
        source: 'system-one',
        confidence,
        latencyMs: elapsed(this.#now(), started),
        basis: [option.trim().split(/\s+/, 1)[0] ?? level]
      }
    };
  }

  /**
   * Deterministic fail-safe vote.
   * @param cues - cue words of the turn input.
   * @param started - monotonic start of the decision.
   * @param efforts - effort ids the routed model declares, when known.
   * @param reason - why System 1 was not used, when it was tried.
   * @returns the decision.
   */
  #decideByCues(cues: EffortCues, started: number, efforts?: readonly string[], reason?: string): EffortDecision {
    const vote = classifyByCues(cues, this.fallback, efforts);
    const confidence = vote.total > 0 ? Number((vote.score / vote.total).toFixed(4)) : 0;

    return {
      level: vote.level,
      source: 'cue-fallback',
      confidence,
      latencyMs: elapsed(this.#now(), started),
      basis: vote.basis,
      ...(reason === undefined ? {} : { degradedReason: reason })
    };
  }

  /**
   * Record one decision in the ledger and publish it to the status feed.
   * @param decision - the decision.
   * @param status - its published status.
   * @param task - the turn input the decision saw.
   */
  #publish(decision: EffortDecision, status: ReflexEffortStatus, task: string): void {
    try {
      this.#ledger?.record({
        type: 'effort-decision',
        backend: this.#backendName,
        latencyMs: decision.latencyMs,
        details: {
          goal: task.trim().slice(0, EFFORT_AUDIT_TASK_CHARS) || '(no turn input)',
          level: decision.level,
          applied: status.applied ?? null,
          outcome: status.outcome,
          trigger: status.trigger,
          source: decision.source,
          confidence: decision.confidence,
          basis: decision.basis,
          provider: status.provider,
          model: status.model,
          ...(decision.degradedReason ? { degraded: decision.degradedReason } : {}),
          ...(status.agentId ? { agentId: status.agentId } : {}),
          ...(status.role ? { role: status.role } : {}),
          ...(status.delegationDepth === undefined ? {} : { delegationDepth: status.delegationDepth }),
          ...(status.turn === undefined ? {} : { turn: status.turn }),
          ...(status.step === undefined ? {} : { step: status.step })
        }
      });
    } catch {
      // The ledger is an audit sink; losing an entry must never fail a turn.
    }

    try {
      this.#feed?.publish(status);
    } catch {
      // Same for the status feed.
    }
  }

  /**
   * The newest published status, for a status bar that polls instead of subscribing.
   * @param agentId - the agent to read; omit for the newest status of any agent.
   * @returns the current status, or `undefined` when nothing was decided yet.
   */
  statusFor(agentId?: string): ReflexEffortStatus | undefined {
    return this.#feed?.latest(agentId);
  }

  /** The status feed, when one was supplied. */
  get feed(): EffortStatusFeed | undefined {
    return this.#feed;
  }
}

/**
 * Outcome of one System 1 attempt: either a trusted decision, or why there is none.
 */
interface SystemOneAttempt {
  decision?: EffortDecision;
  reason?: string;
}

/** Short, single-line rendering of a caught value. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0]?.slice(0, 120) || 'unknown error';
}

/** Milliseconds since a monotonic start, never negative. */
function elapsed(now: number, started: number): number {
  const delta = now - started;
  return Number.isFinite(delta) && delta > 0 ? Math.round(delta) : 0;
}

/**
 * Compose the published status of one decision.
 * @param decision - the decision.
 * @param projection - what it became on the physical route.
 * @param trigger - what asked for the decision.
 * @param context - request context.
 * @param support - the routed model's declared vocabulary, when it was read.
 * @returns the status payload.
 */
function buildEffortStatus(
  decision: EffortDecision,
  projection: { effort?: string; outcome: EffortOutcome },
  trigger: EffortTriggerKind,
  context: EffortRequestContext,
  support?: ReasoningSupport
): ReflexEffortStatus {
  const task = context.task?.trim() ?? '';
  const status: ReflexEffortStatus = {
    level: decision.level,
    ...(projection.effort === undefined ? {} : { applied: projection.effort }),
    outcome: projection.outcome,
    trigger,
    source: decision.source,
    confidence: decision.confidence,
    latencyMs: decision.latencyMs,
    provider: context.target.provider,
    model: context.target.model,
    line: '',
    at: Date.now(),
    ...(context.agent?.agentId ? { agentId: context.agent.agentId } : {}),
    ...(context.agent?.role ? { role: context.agent.role } : {}),
    ...(context.agent?.delegationDepth === undefined ? {} : { delegationDepth: context.agent.delegationDepth }),
    ...(context.turn === undefined ? {} : { turn: context.turn }),
    ...(context.step === undefined ? {} : { step: context.step }),
    ...(decision.basis.length === 0 ? {} : { basis: decision.basis }),
    ...(decision.degradedReason ? { degradedReason: decision.degradedReason } : {}),
    ...(task.length === 0 ? {} : { task: task.slice(0, EFFORT_AUDIT_TASK_CHARS) }),
    ...(context.requestedProvider === undefined ? {} : { requestedProvider: context.requestedProvider }),
    ...(context.requestedModel === undefined ? {} : { requestedModel: context.requestedModel }),
    ...(context.switched === undefined ? {} : { switched: context.switched }),
    ...(context.heldForCache === undefined ? {} : { heldForCache: context.heldForCache }),
    ...(support?.kind === 'declared' ? { supportedEfforts: [...support.efforts] } : {}),
    ...(support?.kind === 'none' ? { supportedEfforts: [] } : {})
  };

  return { ...status, line: formatEffortStatusLine(status) };
}

/**
 * Render one status as a single line for a status bar or a log record.
 * @param status - the status payload (its own `line` is ignored).
 * @returns the line, e.g. `reflex effort: medium → medium (system-one 0.62, 3ms) deepseek:reasoner`.
 */
export function formatEffortStatusLine(status: Omit<ReflexEffortStatus, 'line'> & { line?: string }): string {
  const applied = status.applied ?? 'none';
  const evidence = status.source === 'system-one' ? `system-one ${status.confidence.toFixed(2)}` : `cue-fallback ${status.confidence.toFixed(2)}`;
  const pinned = status.trigger === 'fixed-config' ? ' fixed' : '';
  const affinity = status.heldForCache ? ' (cache affinity)' : '';
  return `reflex effort: ${status.level} → ${applied} (${evidence}, ${status.latencyMs}ms)${pinned} ${status.provider}:${status.model}${affinity}`;
}

/**
 * Process-local feed of the most recent effort decision per agent.
 *
 * This is the status-bar surface: a carrier (the GUI status row, a session
 * panel, or another plugin) subscribes once and renders {@link line} verbatim,
 * while anything that cannot subscribe can pull {@link latest} or
 * {@link statusLine}. It holds one entry per agent, so a long session cannot
 * grow it without bound.
 */
export class EffortStatusFeed {
  /** Most recent status per agent id; `''` is the fallback bucket. */
  readonly #latest = new Map<string, ReflexEffortStatus>();
  readonly #listeners = new Set<(status: ReflexEffortStatus) => void>();

  /**
   * Publish one status to every subscriber.
   * @param status - the status payload.
   */
  publish(status: ReflexEffortStatus): void {
    this.#latest.set(status.agentId ?? '', status);
    for (const listener of this.#listeners) {
      try {
        listener(status);
      } catch {
        // One broken carrier must not silence the others, or the decision itself.
      }
    }
  }

  /**
   * Subscribe to published statuses.
   * @param listener - receives every status from now on.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (status: ReflexEffortStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The latest status, per agent when one is named.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the status, or `undefined` before the first decision.
   */
  latest(agentId?: string): ReflexEffortStatus | undefined {
    if (agentId !== undefined) return this.#latest.get(agentId);
    let newest: ReflexEffortStatus | undefined;
    for (const status of this.#latest.values()) {
      if (!newest || status.at >= newest.at) newest = status;
    }
    return newest;
  }

  /**
   * The rendered status bar line.
   * @param agentId - agent to read; omitted reads the most recent of any agent.
   * @returns the line, or `undefined` before the first decision.
   */
  statusLine(agentId?: string): string | undefined {
    return this.latest(agentId)?.line;
  }

  /** Forget every published status. Called when the activation is disposed. */
  clear(): void {
    this.#latest.clear();
    this.#listeners.clear();
  }
}
