import * as fs from 'fs';
import * as path from 'path';

export interface LedgerEntry {
  id: string;
  timestamp: string;
  /**
   * `route` ranks generic candidates (tools, skills); `model-route` is the
   * dedicated audit record of one virtual→physical model routing decision
   * (candidate pool, chosen target, latency, reason); `effort-decision` is one
   * per-turn adaptive reasoning-effort decision (decided level, effort actually
   * dispatched, projection outcome, evidence).
   */
  type: 'gate' | 'prune' | 'stagnation' | 'route' | 'choice' | 'model-route' | 'effort-decision';
  backend: string;
  latencyMs: number;
  tokensSaved?: number;
  originalTokens?: number;
  prunedTokens?: number;
  passed?: boolean;
  isStuck?: boolean;
  skipReason?: string;
  shadow?: boolean;
  details?: Record<string, any>;
}

export interface LedgerSummary {
  totalCalls: number;
  callsByType: Record<string, number>;
  totalTokensSaved: number;
  avgLatencyMs: number;
  estimatedCostSavedUsd: number;
  stagnationAlerts: number;
  gatePassedCount: number;
  gateFailedCount: number;
}

export class DecisionLedger {
  private static instance: DecisionLedger;
  private entries: LedgerEntry[] = [];
  /** Append-only JSONL sink; `null` keeps the ledger purely in process memory. */
  private logPath: string | null;

  /**
   * @param customPath - JSONL file to append to and replay from startup.
   *   Omit for the default `<cwd>/.reflex/ledger.jsonl`; pass `null` for an
   *   in-memory-only ledger that never touches the filesystem (embedded Hosts).
   */
  constructor(customPath?: string | null) {
    const dir = path.join(process.cwd(), '.reflex');
    this.logPath = customPath === null ? null : customPath || path.join(dir, 'ledger.jsonl');
    if (this.logPath) this.loadFromDisk();
  }

  /** The JSONL sink this ledger appends to, or `null` when memory-only. */
  getLogPath(): string | null {
    return this.logPath;
  }

  static getInstance(): DecisionLedger {
    if (!DecisionLedger.instance) {
      DecisionLedger.instance = new DecisionLedger();
    }
    return DecisionLedger.instance;
  }

  private loadFromDisk(): void {
    if (!this.logPath) return;
    try {
      if (fs.existsSync(this.logPath)) {
        const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.entries.push(JSON.parse(line));
          }
        }
      }
    } catch {
      // ignore read errors
    }
  }

  record(entry: Omit<LedgerEntry, 'id' | 'timestamp'>): LedgerEntry {
    const fullEntry: LedgerEntry = {
      id: `ref_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry
    };

    this.entries.push(fullEntry);

    if (this.logPath) {
      try {
        const dir = path.dirname(this.logPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.logPath, JSON.stringify(fullEntry) + '\n', 'utf8');
      } catch {
        // non-fatal in restricted or readonly filesystems
      }
    }

    return fullEntry;
  }

  getEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  getSummary(): LedgerSummary {
    let totalTokensSaved = 0;
    let totalLatency = 0;
    let stagnationAlerts = 0;
    let gatePassedCount = 0;
    let gateFailedCount = 0;
    const callsByType: Record<string, number> = {};

    for (const e of this.entries) {
      callsByType[e.type] = (callsByType[e.type] || 0) + 1;
      totalTokensSaved += e.tokensSaved || 0;
      totalLatency += e.latencyMs;
      if (e.type === 'stagnation' && e.isStuck) {
        stagnationAlerts++;
      }
      if (e.type === 'gate') {
        if (e.passed) gatePassedCount++;
        else gateFailedCount++;
      }
    }

    const totalCalls = this.entries.length;
    const avgLatencyMs = totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0;
    // Assume average input cost $3.00 per million tokens ($0.000003 per token)
    const estimatedCostSavedUsd = Number(((totalTokensSaved * 3.0) / 1_000_000).toFixed(4));

    return {
      totalCalls,
      callsByType,
      totalTokensSaved,
      avgLatencyMs,
      estimatedCostSavedUsd,
      stagnationAlerts,
      gatePassedCount,
      gateFailedCount
    };
  }

  clear(): void {
    this.entries = [];
    if (!this.logPath) return;
    try {
      if (fs.existsSync(this.logPath)) {
        fs.unlinkSync(this.logPath);
      }
    } catch {
      // ignore
    }
  }
}
