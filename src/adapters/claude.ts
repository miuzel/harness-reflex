import * as fs from 'fs';
import * as path from 'path';

export class ClaudeAdapter {
  /**
   * Generates or updates Claude Code MCP config (.mcp.json or claude_desktop_config.json)
   */
  static configureMcp(workspaceDir: string, binaryPath: string): { configPath: string; created: boolean } {
    const mcpJsonPath = path.join(workspaceDir, '.mcp.json');
    let config: any = { mcpServers: {} };

    if (fs.existsSync(mcpJsonPath)) {
      try {
        config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
        if (!config.mcpServers) config.mcpServers = {};
      } catch {
        config = { mcpServers: {} };
      }
    }

    config.mcpServers['harness-reflex'] = {
      command: 'node',
      args: [binaryPath, 'mcp'],
      env: {
        REFLEX_BACKEND: process.env.REFLEX_BACKEND || 'mock',
        JEV_API_KEY: process.env.JEV_API_KEY || '',
        JEV_BASE_URL: process.env.JEV_BASE_URL || ''
      }
    };

    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf8');
    return { configPath: mcpJsonPath, created: true };
  }

  /**
   * Generates guidelines for Claude Code's CLAUDE.md
   */
  static getClaudePromptGuidelines(): string {
    return `
## Harness Reflex (System 1 Decision & Verification)
You have access to the \`harness-reflex\` MCP tools:
- **reflex_gate**: BEFORE declaring any task complete or claiming success, ALWAYS run \`reflex_gate\` to verify your claims against test output or diffs. If the gate fails or escalates, do NOT stop.
- **reflex_prune**: When dealing with build logs or test outputs exceeding 50 lines, prune them using \`reflex_prune\` to avoid context bloat.
- **reflex_detect_stagnation**: If you find yourself retrying the same command or editing the same lines more than twice, invoke \`reflex_detect_stagnation\` to get an objective diagnosis.
- **reflex_status_ledger**: Check your token savings and decision metrics at any time.
`;
  }
}
