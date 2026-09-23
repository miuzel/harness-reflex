import { DecisionBackend } from '../src/index.js';
export interface BenchmarkResult {
    taskName: string;
    metric: string;
    withoutPlugin: {
        tokens: number;
        latencyMs: number;
        successRate: string;
        turns: number;
    };
    withReflexPlugin: {
        tokens: number;
        latencyMs: number;
        successRate: string;
        turns: number;
    };
    delta: {
        tokenSavingsPercent: string;
        speedup: string;
        accuracyDelta: string;
    };
}
export declare function runMicroProjectBenchmarks(backend: DecisionBackend): Promise<BenchmarkResult[]>;
