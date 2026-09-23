import * as fs from 'fs';
import * as path from 'path';

export class AgyAdapter {
  /**
   * Generates Antigravity (AGY) plugin bundle inside .agents/plugins/harness-reflex/
   */
  static configureAgy(workspaceDir: string, binaryPath: string): { pluginDir: string } {
    const pluginDir = path.join(workspaceDir, '.agents', 'plugins', 'harness-reflex');
    const rulesDir = path.join(pluginDir, 'rules');

    fs.mkdirSync(rulesDir, { recursive: true });

    // 1. plugin.json
    const pluginManifest = {
      name: 'harness-reflex',
      description: 'System 1 decision runtime & Jev compatibility layer for Antigravity',
      version: '0.1.0'
    };
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf8');

    // 2. mcp_config.json
    const mcpConfig = {
      mcpServers: {
        'harness-reflex': {
          command: 'node',
          args: [binaryPath, 'mcp'],
          env: {
            REFLEX_BACKEND: process.env.REFLEX_BACKEND || 'mock',
            JEV_API_KEY: process.env.JEV_API_KEY || ''
          }
        }
      }
    };
    fs.writeFileSync(path.join(pluginDir, 'mcp_config.json'), JSON.stringify(mcpConfig, null, 2), 'utf8');

    // 3. hooks.json
    const hooksConfig = {
      'reflex-guard': {
        enabled: true,
        PostToolUse: [
          {
            matcher: 'run_command',
            hooks: [
              {
                type: 'command',
                command: `node "${binaryPath}" hook post-tool`
              }
            ]
          }
        ],
        Stop: [
          {
            type: 'command',
            command: `node "${binaryPath}" hook stop`
          }
        ]
      }
    };
    fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify(hooksConfig, null, 2), 'utf8');

    // 4. rules/AGENTS.md
    const ruleContent = `# Harness Reflex Guidelines

You are equipped with the **Harness Reflex** System 1 Decision Runtime.

### Core Guidelines:
1. **Evidence Verification Gate (\`reflex_gate\`)**:
   - Before presenting final completion to the user or closing an objective, verify each acceptance criterion against actual output/diffs using \`reflex_gate\`.
   - Never assume success based on absence of errors. If \`reflex_gate\` returns \`escalate\` or \`contradicted\`, continue fixing.

2. **Tool Output Pruning (\`reflex_prune\`)**:
   - For bulky stdout from test suites, greps, or builds, use \`reflex_prune\` to extract relevant diagnostic lines and save context window.

3. **Stagnation Recovery (\`reflex_detect_stagnation\`)**:
   - If an edit or command fails multiple times, invoke \`reflex_detect_stagnation\` to break loops and obtain corrective suggestions.

4. **Audit Ledger (\`reflex_status_ledger\`)**:
   - Access the decision ledger to observe token savings, decision latencies, and pass rates.
`;
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), ruleContent, 'utf8');

    return { pluginDir };
  }
}
