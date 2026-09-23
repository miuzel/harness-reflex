import {
  DecisionBackend,
  ChoiceRequest,
  ChoiceResponse,
  GateRequest,
  GateResponse,
  PruneRequest,
  PruneResponse,
  StagnationCheckRequest,
  StagnationCheckResponse,
  RouteRequest,
  RouteResponse
} from './types.js';

export interface SimpleJevConfig {
  vllmBaseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Logits-based System One Provider (Zero-RLCD, Next-Token Logits Scoring via vLLM / OpenAI API)
 *
 * Implements System One decision API on top of standard open LLM weights (e.g. Qwen2.5 / DeepSeek)
 * using next-token logprobs with max_tokens: 1.
 */
export class LogitsSystemOneBackend implements DecisionBackend {
  readonly name = 'system-one-logits';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config?: SimpleJevConfig) {
    this.baseUrl = (
      config?.vllmBaseUrl ||
      process.env.SYSTEM_ONE_BASE_URL ||
      process.env.VLLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'http://localhost:8000'
    ).replace(/\/$/, '');
    this.apiKey =
      config?.apiKey ||
      process.env.SYSTEM_ONE_API_KEY ||
      process.env.VLLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      'dummy';
    this.model =
      config?.model ||
      process.env.SYSTEM_ONE_MODEL ||
      process.env.VLLM_MODEL ||
      'Qwen/Qwen2.5-7B-Instruct';
    this.timeoutMs = config?.timeoutMs || 8000;
  }

  /**
   * Request next-token logprobs from vLLM /v1/completions
   */
  private async getNextTokenLogprobs(prompt: string, topLogprobs: number = 20): Promise<Record<string, number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}/v1/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          max_tokens: 1,
          temperature: 0.0,
          logprobs: topLogprobs
        }),
        signal: controller.signal
      });

      if (!resp.ok) {
        throw new Error(`vLLM endpoint error: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json() as any;
      const firstChoice = data?.choices?.[0];
      const logprobsObj = firstChoice?.logprobs?.top_logprobs?.[0] || {};
      return logprobsObj;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Normalizes logprobs across target token labels via Softmax
   */
  private computeNormalizedProbabilities(
    logprobsMap: Record<string, number>,
    labels: string[]
  ): Array<{ label: string; probability: number }> {
    // Extract logprobs for each label (accounting for leading spaces)
    const logValues = labels.map((label) => {
      let maxLog = -Infinity;
      for (const [token, logp] of Object.entries(logprobsMap)) {
        if (token.trim().toLowerCase() === label.trim().toLowerCase()) {
          if (logp > maxLog) maxLog = logp;
        }
      }
      return maxLog === -Infinity ? -20 : maxLog; // baseline floor for unseen tokens
    });

    const maxLogVal = Math.max(...logValues);
    const expValues = logValues.map((v) => Math.exp(v - maxLogVal));
    const sumExp = expValues.reduce((a, b) => a + b, 0);

    return labels.map((label, idx) => ({
      label,
      probability: Number((expValues[idx] / sumExp).toFixed(4))
    }));
  }

  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    const start = performance.now();
    const optionsLetters = req.options.map((_, i) => String.fromCharCode(65 + i)); // A, B, C...

    const prompt = `Context: ${req.context || 'None'}
Question: ${req.question}
Options:
${req.options.map((opt, i) => `${optionsLetters[i]}. ${opt}`).join('\n')}

Answer with the single letter of the best option:`;

    try {
      const topLogprobs = await this.getNextTokenLogprobs(prompt, 20);
      const probabilities = this.computeNormalizedProbabilities(topLogprobs, optionsLetters);

      const mappedOptions = req.options.map((opt, i) => ({
        label: opt,
        probability: probabilities[i].probability
      }));

      mappedOptions.sort((a, b) => b.probability - a.probability);

      return {
        options: mappedOptions,
        bestOption: mappedOptions[0].label,
        confidence: mappedOptions[0].probability,
        uncalibrated: true,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      throw new Error(`[SimpleJevBackend.choice] Failed: ${err.message}`);
    }
  }

  async gate(req: GateRequest): Promise<GateResponse> {
    const start = performance.now();
    const results = [];
    let allPassed = true;
    let needsEscalation = false;

    try {
      for (const assertion of req.assertions) {
        const prompt = `Evidence:
"""
${req.evidence.slice(0, 3000)}
"""

Statement: "${assertion.statement}"

Is this statement strictly verified by the evidence?
Options:
A. Yes (Verified)
B. No (Contradicted or False)
C. Unknown (Not addressed in evidence)

Best Answer (A, B, or C):`;

        const logprobs = await this.getNextTokenLogprobs(prompt, 10);
        const probs = this.computeNormalizedProbabilities(logprobs, ['A', 'B', 'C']);
        const top = probs.sort((a, b) => b.probability - a.probability)[0];

        let outcome: 'verified' | 'contradicted' | 'not_addressed' | 'escalate' = 'not_addressed';
        if (top.label === 'A') outcome = 'verified';
        else if (top.label === 'B') outcome = 'contradicted';
        else outcome = 'not_addressed';

        if (outcome !== 'verified') {
          allPassed = false;
        }

        results.push({
          statement: assertion.statement,
          outcome,
          confidence: top.probability,
          explanation: `Classified via token logits: P(${top.label}) = ${top.probability}`
        });
      }

      return {
        passed: allPassed,
        results,
        needsEscalation,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      // Fail-closed to escalate
      return {
        passed: false,
        needsEscalation: true,
        results: req.assertions.map((a) => ({
          statement: a.statement,
          outcome: 'escalate' as const,
          confidence: 0,
          explanation: `SimpleJev backend failed: ${err.message}. Fail-closed escalation.`
        })),
        latencyMs: Math.round(performance.now() - start)
      };
    }
  }

  async prune(req: PruneRequest): Promise<PruneResponse> {
    const start = performance.now();
    // In Simple-Jev, line scoring can be done by heuristic filter + teacher-forcing scoring
    // Here we provide high-throughput line extraction
    const raw = req.rawOutput;
    const lines = raw.split('\n');
    const intentLower = req.intent.toLowerCase();

    const selectedLines = lines.filter((line) => {
      const lower = line.toLowerCase();
      if (lower.includes('error') || lower.includes('fail') || lower.includes('warning')) return true;
      if (lower.includes('passed') || lower.includes('complete') || lower.includes('status')) return true;
      return intentLower.split(/\s+/).some((term) => term.length > 3 && lower.includes(term));
    });

    const prunedOutput = selectedLines.length > 0 ? selectedLines.join('\n') : lines.slice(0, 30).join('\n');
    const originalChars = raw.length;
    const prunedChars = prunedOutput.length;
    const reduction = originalChars > 0 ? Number((((originalChars - prunedChars) / originalChars) * 100).toFixed(1)) : 0;
    const tokensSaved = Math.max(0, Math.ceil((originalChars - prunedChars) / 4));

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
    if (history.length < 3) {
      return {
        isStuck: false,
        confidence: 0.9,
        diagnosis: 'Action history short.',
        latencyMs: Math.round(performance.now() - start)
      };
    }

    const summary = history.slice(-5).map((h, i) => `${i + 1}. Tool: ${h.tool} | Input: ${h.input.slice(0, 80)} | Output: ${(h.output || h.error || '').slice(0, 80)}`).join('\n');
    const prompt = `Inspect this recent agent execution trajectory:
${summary}

Is the agent stuck in an unproductive loop (repeating failing actions or oscillating without progress)?
Options:
A. Yes, stuck
B. No, making progress

Answer (A or B):`;

    try {
      const logprobs = await this.getNextTokenLogprobs(prompt, 5);
      const probs = this.computeNormalizedProbabilities(logprobs, ['A', 'B']);
      const aProb = probs.find((p) => p.label === 'A')?.probability ?? 0;
      const isStuck = aProb > 0.6;

      return {
        isStuck,
        patternType: isStuck ? 'repetition' : 'none',
        confidence: probs[0].probability,
        diagnosis: isStuck ? 'Logits classified execution trajectory as unproductive repeating loop.' : 'Trajectory classified as progressive.',
        recommendedIntervention: isStuck ? 'Stop repeating this command. Change approach or review inputs.' : undefined,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      return {
        isStuck: false,
        confidence: 0.5,
        diagnosis: `SimpleJev stagnation check failed: ${err.message}`,
        latencyMs: Math.round(performance.now() - start)
      };
    }
  }

  async route(req: RouteRequest): Promise<RouteResponse> {
    const start = performance.now();
    const options = req.candidates.map((c) => c.name);
    const choiceRes = await this.choice({
      question: `Which tool or skill is best suited to achieve the goal: "${req.goal}"?`,
      options,
      context: req.candidates.map((c) => `${c.name}: ${c.description}`).join('\n')
    });

    return {
      rankedCandidates: choiceRes.options.map((o) => ({ name: o.label, score: o.probability })),
      bestCandidate: choiceRes.bestOption,
      latencyMs: Math.round(performance.now() - start)
    };
  }
}

export const SimpleJevDecisionBackend = LogitsSystemOneBackend;

