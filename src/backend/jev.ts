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

export interface JevBackendConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Official Jev API Adapter
 * Connects to Jev Decision Gateway (or compatible proxy)
 */
export class JevDecisionBackend implements DecisionBackend {
  readonly name = 'jev-api';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config?: JevBackendConfig) {
    this.baseUrl = (config?.baseUrl || process.env.JEV_BASE_URL || 'https://api.jev.ai').replace(/\/$/, '');
    this.apiKey = config?.apiKey || process.env.JEV_API_KEY || '';
    this.model = config?.model || process.env.JEV_MODEL || 'jev-1.13.0';
    this.timeoutMs = config?.timeoutMs || 10000;
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Jev-Model': this.model
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Jev API error (${resp.status} ${resp.statusText}): ${text}`);
      }

      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async choice(req: ChoiceRequest): Promise<ChoiceResponse> {
    const start = performance.now();
    try {
      const data = await this.postJson<{
        options: Array<{ label: string; probability: number }>;
        bestOption?: string;
        confidence?: number;
      }>('/v1/choice', {
        question: req.question,
        options: req.options,
        context: req.context,
        temperature: req.temperature ?? 1.0,
        model: this.model
      });

      const options = data.options.sort((a, b) => b.probability - a.probability);
      return {
        options,
        bestOption: data.bestOption || options[0]?.label || '',
        confidence: data.confidence || options[0]?.probability || 0,
        uncalibrated: false,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      throw new Error(`[JevBackend.choice] Failed: ${err.message}`);
    }
  }

  async gate(req: GateRequest): Promise<GateResponse> {
    const start = performance.now();
    try {
      // Gate call: verify each assertion against evidence
      const data = await this.postJson<{
        passed: boolean;
        results: Array<{
          statement: string;
          outcome: 'verified' | 'contradicted' | 'not_addressed' | 'escalate';
          confidence: number;
          explanation: string;
        }>;
        needsEscalation: boolean;
      }>('/v1/gate', {
        assertions: req.assertions,
        evidence: req.evidence,
        strictness: req.strictness || 'normal',
        model: this.model
      });

      return {
        passed: data.passed,
        results: data.results,
        needsEscalation: data.needsEscalation,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      // CRITICAL DESIGN PRINCIPLE: Gate MUST fail-closed to 'escalate' on error
      return {
        passed: false,
        needsEscalation: true,
        results: req.assertions.map((a) => ({
          statement: a.statement,
          outcome: 'escalate',
          confidence: 0,
          explanation: `Jev API call failed: ${err.message}. Fail-closed escalation triggered.`
        })),
        latencyMs: Math.round(performance.now() - start)
      };
    }
  }

  async prune(req: PruneRequest): Promise<PruneResponse> {
    const start = performance.now();
    try {
      const data = await this.postJson<{
        prunedText: string;
        originalChars: number;
        prunedChars: number;
      }>('/v1/prune', {
        rawOutput: req.rawOutput,
        intent: req.intent,
        maxTokens: req.maxTokens,
        model: this.model
      });

      const originalChars = data.originalChars || req.rawOutput.length;
      const prunedChars = data.prunedChars || data.prunedText.length;
      const reduction = originalChars > 0 ? Number((((originalChars - prunedChars) / originalChars) * 100).toFixed(1)) : 0;
      const tokensSaved = Math.max(0, Math.ceil((originalChars - prunedChars) / 4));

      return {
        processedOutput: req.shadowMode ? req.rawOutput : data.prunedText,
        originalChars,
        prunedChars,
        estimatedTokensSaved: tokensSaved,
        reductionPercentage: reduction,
        shadow: !!req.shadowMode,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      // Fail-open for pruning: preserve original output if prune fails
      return {
        processedOutput: req.rawOutput,
        originalChars: req.rawOutput.length,
        prunedChars: req.rawOutput.length,
        estimatedTokensSaved: 0,
        reductionPercentage: 0,
        shadow: !!req.shadowMode,
        latencyMs: Math.round(performance.now() - start)
      };
    }
  }

  async checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse> {
    const start = performance.now();
    try {
      const data = await this.postJson<{
        isStuck: boolean;
        patternType?: 'repetition' | 'oscillation' | 'failing_retry' | 'zero_progress' | 'none';
        confidence: number;
        diagnosis?: string;
        recommendedIntervention?: string;
      }>('/v1/stagnation-check', {
        history: req.history,
        goal: req.goal,
        model: this.model
      });

      return {
        isStuck: data.isStuck,
        patternType: data.patternType || 'none',
        confidence: data.confidence,
        diagnosis: data.diagnosis,
        recommendedIntervention: data.recommendedIntervention,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      // Default to progressive (no false alarm) on backend error
      return {
        isStuck: false,
        patternType: 'none',
        confidence: 0.5,
        diagnosis: `Stagnation check backend unavailable: ${err.message}`,
        latencyMs: Math.round(performance.now() - start)
      };
    }
  }

  async route(req: RouteRequest): Promise<RouteResponse> {
    const start = performance.now();
    try {
      const data = await this.postJson<{
        rankedCandidates: Array<{ name: string; score: number; reason?: string }>;
      }>('/v1/route', {
        goal: req.goal,
        candidates: req.candidates,
        topK: req.topK || 3,
        model: this.model
      });

      return {
        rankedCandidates: data.rankedCandidates,
        bestCandidate: data.rankedCandidates[0]?.name,
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (err: any) {
      throw new Error(`[JevBackend.route] Failed: ${err.message}`);
    }
  }
}
