import {
  DecisionBackend,
  ChoiceRequest,
  ChoiceResponse,
  ClaimClassification,
  ClaimClassificationRequest,
  ClaimClassificationResponse,
  GateRequest,
  GateResponse,
  PruneRequest,
  PruneResponse,
  StagnationCheckRequest,
  StagnationCheckResponse,
  RouteRequest,
  RouteResponse,
  GateResultItem,
  GateOutcome
} from './types.js';

/**
 * Vocabulary one option contributes to the overlap score.
 *
 * ASCII words keep the historical `length > 2` filter. Chinese is written
 * without spaces and nearly every technical term is two characters (并发, 证明,
 * 迁移), so a whitespace split drops the entire vocabulary of a Chinese turn and
 * collapses every option into an indistinguishable tie — which then reads as a
 * confident decision. A Han run therefore contributes its two-character grams as
 * well as the run itself, so an option's cue word matches inside an unspaced
 * sentence.
 *
 * @param text - one candidate option.
 * @returns distinct matchable terms, in option order.
 */
function matchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const chunk of text.toLowerCase().split(/[^\p{Script=Han}a-z0-9_]+/u)) {
    if (chunk.length === 0) continue;
    if (!/\p{Script=Han}/u.test(chunk)) {
      if (chunk.length > 2) terms.push(chunk);
      continue;
    }
    for (let i = 0; i + 2 <= chunk.length; i++) terms.push(chunk.slice(i, i + 2));
    if (chunk.length > 2) terms.push(chunk);
  }
  return terms;
}

/**
 * Ignore explicit zero counters, not failure words in general. Both count-first
 * (pytest/Jest) and label-first (node:test) summaries occur in captured output.
 * Replace nonzero counters with a cue so another zero counter cannot hide them.
 * This is only a mock heuristic, not semantic verification of arbitrary logs.
 */
function hasFailureEvidence(evidence: string): boolean {
  const withoutCounters = evidence.replace(
    /\b(\d+(?:[.,]\d+)*|zero)\s+(fail(?:ed|ures?)?|errors?)\b|\b(fail(?:ed|ures?)?|errors?)\s*[:=]?\s*(\d+(?:[.,]\d+)*|zero)\b/g,
    (_match, before: string | undefined, _beforeLabel: string | undefined, _afterLabel: string | undefined, after: string | undefined) => {
      const count = before ?? after!;
      return count === 'zero' || Number(count.replaceAll(',', '')) === 0 ? '' : ' failure ';
    }
  );
  // An explicit error diagnostic is not a summary, even if its message starts with 0.
  return evidence.includes('error:') || /fail|\berrors?\b/.test(withoutCounters);
}

/** A negated or unfinished outcome, which is never a completion claim. */
const MOCK_CLAIM_NEGATION =
  /(not\s+(?:yet\s+)?(?:complete|completed|done|finished|passing|passed|successful|success)|isn'?t\s+(?:complete|done|finished)|still\s+(?:failing|fails|broken|running)|没有通过|未通过|尚未完成|尚未通过|还没完成|还没通过|并未完成|仍然失败|仍有失败|还有失败)/i;

/** A completion assertion in English or Chinese. */
const MOCK_CLAIM_WORD =
  /(\b(?:pass|passed|passing|green|success|successful|succeed|succeeded|complete|completed|finished|done|verified|works)\b|全部通过|全部通过|所有测试通过|已完成|完成了|已通过|通过|成功|跑通|全绿|搞定)/i;

/**
 * Deterministic stand-in for the closing-claim classification.
 *
 * The mock exists to keep the offline path honest, not to be the semantic
 * judge: it reads a negated outcome first and only then looks for a completion
 * word, which is enough to cover the English/Chinese and negation cases the
 * unit suite exercises. Production deployments use the Jev backend.
 * @param statement - one candidate sentence.
 * @returns whether it reads as a completion claim and with what certainty.
 */
function mockClaimClassification(statement: string): ClaimClassification {
  if (MOCK_CLAIM_NEGATION.test(statement)) return { statement, isClaim: false, confidence: 0.96 };
  if (MOCK_CLAIM_WORD.test(statement)) return { statement, isClaim: true, confidence: 0.92 };
  return { statement, isClaim: false, confidence: 0.9 };
}

/**
 * Mock & Heuristic Decision Backend
 * Provides instant (<5ms) deterministic decision evaluation for testing,
 * local development, and offline baseline comparisons.
 */
export class MockDecisionBackend implements DecisionBackend {
  readonly name = 'mock-heuristic-v1';
  readonly model = 'mock-system-one';

  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    const start = performance.now();
    if (req.options.length === 0) {
      throw new Error('Choice options cannot be empty');
    }

    // Heuristic: rank options based on semantic relevance to question & context
    const qLower = req.question.toLowerCase();
    const ctxLower = (req.context || '').toLowerCase();

    const scores = req.options.map((opt) => {
      let score = 1.0;
      // Match the option's own vocabulary against the question and the context.
      for (const term of matchTerms(opt)) {
        if (qLower.includes(term)) score += 2.0;
        if (ctxLower.includes(term)) score += 1.5;
      }
      return score;
    });

    const sum = scores.reduce((a, b) => a + b, 0);
    const options = req.options.map((opt, i) => ({
      label: opt,
      probability: Number((scores[i] / sum).toFixed(4))
    }));

    // Sort descending
    options.sort((a, b) => b.probability - a.probability);

    return {
      options,
      bestOption: options[0].label,
      confidence: options[0].probability,
      uncalibrated: true,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async gate(req: GateRequest): Promise<GateResponse> {
    const start = performance.now();
    const evidenceLower = req.evidence.toLowerCase();
    const hasErrorOrFail = hasFailureEvidence(evidenceLower);
    const results: GateResultItem[] = [];
    let allPassed = true;
    let needsEscalation = false;

    for (const assertion of req.assertions) {
      const stmt = assertion.statement;
      const stmtLower = stmt.toLowerCase();

      // Check for contradiction cues
      const claimsSuccess = stmtLower.includes('success') || stmtLower.includes('pass') || stmtLower.includes('finished') || stmtLower.includes('complete');

      let outcome: GateOutcome = 'not_addressed';
      let confidence = 0.85;
      let explanation = 'Evaluated against evidence.';

      if (claimsSuccess && hasErrorOrFail) {
        outcome = 'contradicted';
        explanation = 'Assertion claims success, but evidence contains explicit error or failure output.';
        allPassed = false;
      } else {
        // Keyword overlap
        const words = stmtLower.replace(/[^a-z0-9_\s]/g, '').split(/\s+/).filter((w) => w.length > 3);
        const matches = words.filter((w) => evidenceLower.includes(w));
        const matchRatio = words.length > 0 ? matches.length / words.length : 0;

        if (matchRatio >= 0.4) {
          outcome = 'verified';
          explanation = `Direct evidence found supporting assertion (matching terms: ${matches.slice(0, 3).join(', ')}).`;
        } else if (words.length > 0) {
          outcome = 'not_addressed';
          explanation = 'Evidence does not contain sufficient details to verify this assertion.';
          allPassed = false;
          if (req.strictness === 'high') {
            needsEscalation = true;
          }
        } else {
          outcome = 'escalate';
          explanation = 'Insufficient assertion details to determine truth.';
          needsEscalation = true;
          allPassed = false;
        }
      }

      results.push({
        statement: stmt,
        outcome,
        confidence,
        explanation
      });
    }

    return {
      passed: allPassed && !needsEscalation,
      results,
      needsEscalation,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async prune(req: PruneRequest): Promise<PruneResponse> {
    const start = performance.now();
    const raw = req.rawOutput;
    const lines = raw.split('\n');

    // Deterministic + Semantic pruning:
    // Drop repetitive progress bars, redundant empty lines, unhelpful stack traces
    const filteredLines: string[] = [];
    const intentWords = req.intent.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    let consecutiveEmpty = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        consecutiveEmpty++;
        if (consecutiveEmpty <= 1) filteredLines.push(line);
        continue;
      }
      consecutiveEmpty = 0;

      // Filter progress bar indicators
      if (line.includes('[===') || line.includes('████') || line.includes('\r')) {
        continue;
      }

      // Filter typical node_modules / site-packages deep internals unless relevant
      if (line.includes('node_modules/') && !intentWords.some((w) => line.toLowerCase().includes(w))) {
        continue;
      }

      filteredLines.push(line);
    }

    const prunedOutput = filteredLines.join('\n');
    const originalChars = raw.length;
    const prunedChars = prunedOutput.length;
    const estOriginalTokens = Math.ceil(originalChars / 4);
    const estPrunedTokens = Math.ceil(prunedChars / 4);
    const tokensSaved = Math.max(0, estOriginalTokens - estPrunedTokens);
    const reduction = originalChars > 0 ? Number((((originalChars - prunedChars) / originalChars) * 100).toFixed(1)) : 0;

    return {
      processedOutput: req.shadowMode ? raw : prunedOutput,
      originalChars,
      prunedChars,
      estimatedTokensSaved: tokensSaved,
      reductionPercentage: reduction,
      shadow: !!req.shadowMode,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse> {
    const start = performance.now();
    const history = req.history || [];
    const window = req.windowSize || 6;
    const recent = history.slice(-window);

    if (recent.length < 3) {
      return {
        isStuck: false,
        confidence: 0.95,
        diagnosis: 'Action history too short to establish stagnation.',
        latencyMs: Math.round(performance.now() - start)
      };
    }

    // Check 1: Identical consecutive tool calls
    const tools = recent.map((r) => `${r.tool}:${r.input.trim()}`);
    let identicalCount = 1;
    for (let i = tools.length - 1; i > 0; i--) {
      if (tools[i] === tools[i - 1]) {
        identicalCount++;
      } else {
        break;
      }
    }

    if (identicalCount >= 3) {
      return {
        isStuck: true,
        patternType: 'repetition',
        confidence: 0.98,
        diagnosis: `Identical tool execution repeated ${identicalCount} times consecutively with no change in input.`,
        recommendedIntervention: 'Interrupt execution. Suggest alternative tool or inspect previous failure output.',
        latencyMs: Math.round(performance.now() - start)
      };
    }

    // Check 2: Repeated failure / error cycle
    const failingSteps = recent.filter((r) => !!r.error || (r.output && (r.output.includes('Error') || r.output.includes('Failed'))));
    if (failingSteps.length >= 3 && recent.length >= 4) {
      return {
        isStuck: true,
        patternType: 'failing_retry',
        confidence: 0.91,
        diagnosis: `${failingSteps.length} of the last ${recent.length} actions failed with recurring errors.`,
        recommendedIntervention: 'Step back to analyze root cause before attempting the same action again.',
        latencyMs: Math.round(performance.now() - start)
      };
    }

    // Check 3: Oscillation between two files or two commands
    if (recent.length >= 4) {
      const last4 = recent.slice(-4);
      if (last4[0].tool === last4[2].tool && last4[1].tool === last4[3].tool && last4[0].input === last4[2].input && last4[1].input === last4[3].input) {
        return {
          isStuck: true,
          patternType: 'oscillation',
          confidence: 0.94,
          diagnosis: 'Agent is oscillating between two identical alternating commands/edits.',
          recommendedIntervention: 'Break loop: stop alternating and clarify requirements or test independently.',
          latencyMs: Math.round(performance.now() - start)
        };
      }
    }

    return {
      isStuck: false,
      patternType: 'none',
      confidence: 0.88,
      diagnosis: 'Execution flow appears progressive.',
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async route(req: RouteRequest): Promise<RouteResponse> {
    const start = performance.now();
    const goalLower = req.goal.toLowerCase();
    
    const scored = req.candidates.map((cand) => {
      let score = 0.1;
      const text = `${cand.name} ${cand.description}`.toLowerCase();
      const words = goalLower.split(/\s+/).filter((w) => w.length > 2);
      for (const w of words) {
        if (text.includes(w)) score += 1.0;
      }
      return {
        name: cand.name,
        score: Number(score.toFixed(3)),
        reason: `Matched ${words.filter((w) => text.includes(w)).length} query keywords`
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const topK = req.topK || 3;
    const ranked = scored.slice(0, topK);

    return {
      rankedCandidates: ranked,
      bestCandidate: ranked[0]?.name,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async classifyClaims(req: ClaimClassificationRequest): Promise<ClaimClassificationResponse> {
    const start = performance.now();
    const statements = Array.isArray(req.statements) ? req.statements : [];
    return {
      results: statements.map(mockClaimClassification),
      latencyMs: Math.round(performance.now() - start)
    };
  }
}
