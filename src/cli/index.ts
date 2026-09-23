#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { ReflexMcpServer } from '../mcp/server.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { AgyAdapter } from '../adapters/agy.js';
import { createDecisionBackend } from '../backend/factory.js';
import { ReflexGateService } from '../core/gate.js';
import { ToolResultPruner } from '../core/prune.js';
import { DecisionLedger } from '../core/ledger.js';
import { ReflexScreenService } from '../core/screen.js';
import { fitIsotonicRegression, calculateECE, CalibrationCurve, Calibrator } from '../core/calibrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'mcp': {
      const server = new ReflexMcpServer();
      server.start();
      break;
    }

    case 'setup': {
      const target = args[1] || 'all';
      const workspaceDir = process.cwd();
      // Locate the CLI entrypoint
      const entrypoint = path.resolve(__dirname, 'index.js');

      console.log(`[Harness Reflex] Setting up plugin for target: ${target}`);
      console.log(`[Harness Reflex] Workspace: ${workspaceDir}`);
      console.log(`[Harness Reflex] Binary: ${entrypoint}\n`);

      if (target === 'claude' || target === 'all') {
        const { configPath } = ClaudeAdapter.configureMcp(workspaceDir, entrypoint);
        console.log(`  ✓ Claude Code MCP config written to ${configPath}`);
        console.log(`    (Added 'harness-reflex' server to .mcp.json)`);
      }

      if (target === 'codex' || target === 'all') {
        const { configPath } = CodexAdapter.configureCodex(workspaceDir, entrypoint);
        console.log(`  ✓ Codex CLI MCP config written to ${configPath}`);
      }

      if (target === 'agy' || target === 'all') {
        const { pluginDir } = AgyAdapter.configureAgy(workspaceDir, entrypoint);
        console.log(`  ✓ Antigravity (AGY) plugin written to ${pluginDir}`);
        console.log(`    (Includes plugin.json, mcp_config.json, hooks.json, rules/AGENTS.md)`);
      }

      console.log('\nSetup complete! You can now start or reload Claude Code, Codex, or AGY.');
      break;
    }

    case 'gate': {
      // CLI gate runner: harness-reflex gate --statement "Tests pass" --evidence "..."
      let statement = '';
      let evidence = '';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--statement' || args[i] === '-s') statement = args[++i];
        if (args[i] === '--evidence' || args[i] === '-e') evidence = args[++i];
      }

      if (!statement) {
        console.error('Error: --statement is required.');
        process.exit(1);
      }

      if (!evidence && !process.stdin.isTTY) {
        // Read evidence from stdin
        evidence = fs.readFileSync(0, 'utf8');
      }

      const backend = createDecisionBackend();
      const gate = new ReflexGateService(backend);
      const res = await gate.verify([{ statement }], evidence);

      console.log(JSON.stringify(res, null, 2));
      process.exit(res.passed ? 0 : 1);
    }

    case 'prune': {
      let intent = 'extract error and results';
      let raw = '';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--intent') intent = args[++i];
      }

      if (!process.stdin.isTTY) {
        raw = fs.readFileSync(0, 'utf8');
      }

      const backend = createDecisionBackend();
      const pruner = new ToolResultPruner(backend);
      const res = await pruner.prune(raw, { intent });

      console.log(res.processedOutput);
      break;
    }

    case 'ledger': {
      const ledger = DecisionLedger.getInstance();
      const summary = ledger.getSummary();
      console.log('=== Harness Reflex Decision Ledger ===');
      console.log(`Total Decisions: ${summary.totalCalls}`);
      console.log(`Calls by Type:   ${JSON.stringify(summary.callsByType)}`);
      console.log(`Tokens Saved:    ${summary.totalTokensSaved.toLocaleString()}`);
      console.log(`Est. Cost Saved: $${summary.estimatedCostSavedUsd.toFixed(4)} USD`);
      console.log(`Avg Latency:     ${summary.avgLatencyMs} ms`);
      console.log(`Gate Pass/Fail:  ${summary.gatePassedCount} passed / ${summary.gateFailedCount} failed`);
      console.log(`Stagnation Alarms: ${summary.stagnationAlerts}`);
      break;
    }

    case 'screen': {
      let content = '';
      let strict = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--content' || args[i] === '-c') content = args[++i];
        if (args[i] === '--strict') strict = true;
      }
      if (!content && !process.stdin.isTTY) {
        content = fs.readFileSync(0, 'utf8');
      }

      const backend = createDecisionBackend();
      const screener = new ReflexScreenService(backend);
      const res = await screener.screen({ content, strict });
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.isSafe ? 0 : 1);
    }

    case 'choice': {
      let question = '';
      let optionsStr = '';
      let context = '';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--question' || args[i] === '-q') question = args[++i];
        if (args[i] === '--options' || args[i] === '-o') optionsStr = args[++i];
        if (args[i] === '--context') context = args[++i];
      }
      if (!question || !optionsStr) {
        console.error('Usage: harness-reflex choice --question "..." --options "opt1,opt2" [--context "..."]');
        process.exit(1);
      }
      const options = optionsStr.split(',').map((o) => o.trim());
      const backend = createDecisionBackend();
      const res = await backend.choice({ question, options, context });
      console.log(JSON.stringify(res, null, 2));
      break;
    }

    case 'score': {
      let statement = '';
      let criteria = 'Rate alignment on a scale from 0.0 to 1.0';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--statement' || args[i] === '-s') statement = args[++i];
        if (args[i] === '--criteria' || args[i] === '-c') criteria = args[++i];
      }
      if (!statement && !process.stdin.isTTY) {
        statement = fs.readFileSync(0, 'utf8');
      }
      const backend = createDecisionBackend();
      const evalRes = await backend.choice({
        question: `Evaluate statement against criteria: "${criteria}". Is alignment high, moderate, or low?`,
        options: ['High alignment (~0.9)', 'Moderate alignment (~0.5)', 'Poor alignment (~0.1)'],
        context: statement
      });
      const pHigh = evalRes.options.find((o) => o.label.includes('High'))?.probability || 0;
      const pMed = evalRes.options.find((o) => o.label.includes('Moderate'))?.probability || 0;
      const pLow = evalRes.options.find((o) => o.label.includes('Poor'))?.probability || 0;
      const score = Number((pHigh * 0.9 + pMed * 0.5 + pLow * 0.1).toFixed(3));
      console.log(JSON.stringify({ statement, score, distribution: { pHigh, pMed, pLow } }, null, 2));
      break;
    }

    case 'calibrate': {
      let datasetPath = '';
      let outputPath = path.join(process.cwd(), '.reflex', 'calibration.json');
      let targetModel = process.env.SYSTEM_ONE_MODEL || 'default-model';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--dataset' || args[i] === '-d') datasetPath = args[++i];
        if (args[i] === '--output' || args[i] === '-o') outputPath = args[++i];
        if (args[i] === '--model' || args[i] === '-m') targetModel = args[++i];
      }

      if (!datasetPath) {
        console.error('Error: --dataset <file.json> is required for calibration.');
        process.exit(1);
      }

      console.log(`[Calibration] Loading samples from ${datasetPath}...`);
      const rawData = fs.readFileSync(datasetPath, 'utf8');
      const samples = JSON.parse(rawData);

      // Samples format: Array<{ rawProbability: number, groundTruth: 0 | 1 }>
      // If samples contain assertions/evidence, run backend.gate() first to obtain raw probabilities
      const fittedSamples: Array<{ rawProbability: number; groundTruth: 0 | 1 }> = [];
      const backend = createDecisionBackend();

      for (const s of samples) {
        if (typeof s.rawProbability === 'number') {
          fittedSamples.push({ rawProbability: s.rawProbability, groundTruth: s.groundTruth });
        } else if (s.assertion && s.evidence) {
          const res = await backend.gate({
            assertions: [{ statement: s.assertion }],
            evidence: s.evidence
          });
          const rawProb = res.results[0]?.confidence ?? 0.5;
          fittedSamples.push({ rawProbability: rawProb, groundTruth: s.groundTruth });
        }
      }

      console.log(`[Calibration] Fitting Isotonic Regression on ${fittedSamples.length} samples...`);
      const bins = fitIsotonicRegression(fittedSamples);
      const eceBefore = calculateECE(fittedSamples.map((s) => ({ probability: s.rawProbability, groundTruth: s.groundTruth })));

      // Calibrate samples to compute ECE after
      const calibratedSamples = fittedSamples.map((s) => {
        let cal = s.rawProbability;
        for (const bin of bins) {
          if (s.rawProbability >= bin.rawMin && s.rawProbability <= bin.rawMax) {
            cal = bin.calibrated;
            break;
          }
        }
        return { probability: cal, groundTruth: s.groundTruth };
      });
      const eceAfter = calculateECE(calibratedSamples);

      const curve: CalibrationCurve = {
        targetModel,
        taskType: 'gate_verification',
        method: 'isotonic',
        createdAt: new Date().toISOString(),
        bins,
        eceBefore,
        eceAfter
      };

      const outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, JSON.stringify(curve, null, 2), 'utf8');

      console.log(`✓ Calibration curve saved to ${outputPath}`);
      console.log(`  Target Model: ${targetModel}`);
      console.log(`  ECE Before:   ${eceBefore} -> ECE After: ${eceAfter} (${(((eceBefore - eceAfter) / (eceBefore || 1)) * 100).toFixed(1)}% error reduction)`);
      console.log(`  Fitted Bins:  ${bins.length}`);
      break;
    }

    case 'hook': {
      // Internal hook dispatcher for AGY/Claude hooks
      const hookType = args[1] || 'default';
      // Hook executed silently
      break;
    }

    case 'help':
    default: {
      console.log(`
Harness Reflex - System One Decision Runtime for Codex, Claude Code & AGY

Usage:
  harness-reflex <command> [options]

Commands:
  mcp                 Start Model Context Protocol (MCP) server over stdio
  setup [target]      Configure target harness (claude | codex | agy | all)
  gate [options]      Evaluate assertions against evidence (fail-closed)
  prune [options]     Prune lengthy tool outputs on stdin
  ledger              Show decision ledger summary and token savings
  help                Display this help message

Environment Variables:
  SYSTEM_ONE_BACKEND  System One provider: 'jev' | 'vllm' | 'simple-jev' | 'mock' (default: mock)
  SYSTEM_ONE_API_KEY  API key for the chosen System One provider (or JEV_API_KEY)
  SYSTEM_ONE_BASE_URL Base URL for System One provider (or JEV_BASE_URL, VLLM_BASE_URL)
  SYSTEM_ONE_MODEL    Model identifier (e.g. 'jev-1.13.0', 'Qwen/Qwen2.5-7B-Instruct')
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('[Harness Reflex Error]', err);
  process.exit(1);
});
