/**
 * Core types for Jev API and System 1 Decision Runtime
 */

export interface ChoiceOption {
  label: string;
  probability: number;
}

export interface ChoiceRequest {
  question: string;
  options: string[];
  context?: string;
  temperature?: number;
}

export interface ChoiceResponse {
  options: ChoiceOption[];
  bestOption: string;
  confidence: number;
  uncalibrated?: boolean;
  latencyMs: number;
}

export type GateOutcome = 'verified' | 'contradicted' | 'not_addressed' | 'escalate';

export interface GateAssertion {
  statement: string;
  criteria?: string;
}

export interface GateRequest {
  assertions: GateAssertion[];
  evidence: string;
  context?: string;
  strictness?: 'high' | 'normal' | 'lenient';
}

export interface GateResultItem {
  statement: string;
  outcome: GateOutcome;
  confidence: number;
  explanation: string;
}

export interface GateResponse {
  passed: boolean;
  results: GateResultItem[];
  needsEscalation: boolean;
  latencyMs: number;
}

export interface PruneRequest {
  rawOutput: string;
  intent: string;
  maxTokens?: number;
  shadowMode?: boolean;
}

export interface PruneResponse {
  processedOutput: string;
  originalChars: number;
  prunedChars: number;
  estimatedTokensSaved: number;
  reductionPercentage: number;
  shadow: boolean;
  latencyMs: number;
}

export interface ActionStep {
  tool: string;
  input: string;
  output?: string;
  error?: string;
  timestamp?: number;
}

export interface StagnationCheckRequest {
  history: ActionStep[];
  goal?: string;
  windowSize?: number;
}

export interface StagnationCheckResponse {
  isStuck: boolean;
  patternType?: 'repetition' | 'oscillation' | 'failing_retry' | 'zero_progress' | 'none';
  confidence: number;
  diagnosis?: string;
  recommendedIntervention?: string;
  latencyMs: number;
}

export interface RouteRequest {
  goal: string;
  candidates: Array<{ name: string; description: string; type?: 'tool' | 'skill' | 'action' }>;
  topK?: number;
}

export interface RouteResponse {
  rankedCandidates: Array<{ name: string; score: number; reason?: string }>;
  bestCandidate?: string;
  latencyMs: number;
}

/**
 * Common interface for decision backends (Jev official, Simple-Jev, vLLM, mock)
 */
export interface DecisionBackend {
  readonly name: string;
  readonly model: string;
  
  choice(req: ChoiceRequest): Promise<ChoiceResponse>;
  gate(req: GateRequest): Promise<GateResponse>;
  prune(req: PruneRequest): Promise<PruneResponse>;
  checkStagnation(req: StagnationCheckRequest): Promise<StagnationCheckResponse>;
  route(req: RouteRequest): Promise<RouteResponse>;
}
