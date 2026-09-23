import * as fs from 'fs';
import * as path from 'path';

export class CodexAdapter {
  /**
   * Generates or updates Codex CLI configuration
   */
  static configureCodex(workspaceDir: string, binaryPath: string): { configPath: string; created: boolean } {
    const codexConfigDir = path.join(workspaceDir, '.codex');
    if (!fs.existsSync(codexConfigDir)) {
      fs.mkdirSync(codexConfigDir, { recursive: true });
    }

    const configPath = path.join(codexConfigDir, 'config.json');
    let config: any = { mcpServers: {} };

    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.mcpServers) config.mcpServers = {};
      } catch {
        config = { mcpServers: {} };
      }
    }

    config.mcpServers['harness-reflex'] = {
      command: 'node',
      args: [binaryPath, 'mcp'],
      env: {
        SYSTEM_ONE_BACKEND: process.env.SYSTEM_ONE_BACKEND || process.env.REFLEX_BACKEND || 'mock',
        SYSTEM_ONE_API_KEY: process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY || '',
        SYSTEM_ONE_BASE_URL: process.env.SYSTEM_ONE_BASE_URL || process.env.JEV_BASE_URL || ''
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { configPath, created: true };
  }

  static getCodexInstructions(): string {
    return `
# Codex Harness Reflex Rules
1. **Pre-flight & Post-flight Gate**: Do not submit PR or mark goal done without passing \`reflex_gate\`.
2. **Context Pruning**: Use \`reflex_prune\` on command stdout exceeding 1000 characters.
3. **Loop Breaker**: When hitting repeated bash exit code > 0, check \`reflex_detect_stagnation\`.
`;
  }
}
