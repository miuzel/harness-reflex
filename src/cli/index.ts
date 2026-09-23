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
