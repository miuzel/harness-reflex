import * as readline from 'readline';
import { createDecisionBackend } from '../backend/factory.js';
import { ReflexGateService } from '../core/gate.js';
import { ToolResultPruner } from '../core/prune.js';
import { StagnationDetector } from '../core/stagnation.js';
import { ReflexRouter } from '../core/route.js';
import { DecisionLedger } from '../core/ledger.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export class ReflexMcpServer {
  private backend = createDecisionBackend();
  private ledger = DecisionLedger.getInstance();
  private gate = new ReflexGateService(this.backend, this.ledger);
  private pruner = new ToolResultPruner(this.backend, this.ledger);
  private stagnation = new StagnationDetector(this.backend, this.ledger);
  private router = new ReflexRouter(this.backend, this.ledger);

  start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const res = await this.handleRequest(req);
        if (res && req.id !== undefined && req.id !== null) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch (err: any) {
        const errResp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${err.message}`
          }
        };
        process.stdout.write(JSON.stringify(errResp) + '\n');
      }
    });
  }

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = req;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'harness-reflex-mcp',
            version: '0.1.0'
          }
        }
      };
    }

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {}
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          tools: [
            {
              name: 'reflex_gate',
              description: 'Strict fail-closed verification of assertions against concrete evidence. Returns verified, contradicted, or escalate.',
              inputSchema: {
                type: 'object',
                properties: {
                  assertions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        statement: { type: 'string', description: 'Assertion or criteria to verify' }
                      },
                      required: ['statement']
                    },
                    description: 'List of statements to verify against the evidence'
                  },
                  evidence: {
                    type: 'string',
                    description: 'The raw evidence (stdout, test output, file contents)'
                  },
                  strictness: {
                    type: 'string',
                    enum: ['high', 'normal', 'lenient'],
                    description: 'Strictness level for verification'
                  }
                },
                required: ['assertions', 'evidence']
              }
            },
            {
              name: 'reflex_prune',
              description: 'Prune bulky tool output (e.g. verbose logs, build traces, directory trees) while preserving critical diagnostic lines.',
              inputSchema: {
                type: 'object',
                properties: {
                  rawOutput: { type: 'string', description: 'The long tool output to prune' },
                  intent: { type: 'string', description: 'What information you are looking for (e.g. "find compiler error", "check test failures")' },
                  shadowMode: { type: 'boolean', description: 'If true, compute token reduction metrics without truncating text' }
                },
                required: ['rawOutput']
              }
            },
            {
              name: 'reflex_detect_stagnation',
              description: 'Check if the agent is stuck in an unproductive loop, oscillating between identical edits, or repeatedly failing.',
              inputSchema: {
                type: 'object',
                properties: {
                  recentAction: {
                    type: 'object',
                    properties: {
                      tool: { type: 'string', description: 'Tool that was executed' },
                      input: { type: 'string', description: 'Input provided to the tool' },
                      output: { type: 'string', description: 'Tool output or error summary' },
                      error: { type: 'string', description: 'Error message if failed' }
                    },
                    required: ['tool', 'input']
                  },
                  goal: { type: 'string', description: 'Current overall goal' }
                }
              }
            },
            {
              name: 'reflex_route',
              description: 'Score and rank candidate tools, skills, or next steps against a goal using probabilistic System 1 decision.',
              inputSchema: {
                type: 'object',
                properties: {
                  goal: { type: 'string', description: 'The goal or user task' },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        description: { type: 'string' }
                      },
                      required: ['name', 'description']
                    },
                    description: 'Candidate tools or skills to rank'
                  },
                  topK: { type: 'number', description: 'Number of candidates to return' }
                },
                required: ['goal', 'candidates']
              }
            },
            {
              name: 'reflex_status_ledger',
              description: 'Query the decision ledger: see total decisions made, net tokens saved, cost reductions, and latency metrics.',
              inputSchema: {
                type: 'object',
                properties: {
                  includeEntries: { type: 'boolean', description: 'Whether to include recent decision logs' }
                }
              }
            }
          ]
        }
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      try {
        let contentText = '';

        if (toolName === 'reflex_gate') {
          const res = await this.gate.verify(args.assertions || [], args.evidence || '', {
            strictness: args.strictness
          });
          contentText = JSON.stringify(res, null, 2);
        } else if (toolName === 'reflex_prune') {
          const res = await this.pruner.prune(args.rawOutput || '', {
            intent: args.intent,
            shadowMode: args.shadowMode
          });
          contentText = JSON.stringify(
            {
              tokensSaved: res.estimatedTokensSaved,
              reductionPercentage: `${res.reductionPercentage}%`,
              shadow: res.shadow,
              processedOutput: res.processedOutput
            },
            null,
            2
          );
        } else if (toolName === 'reflex_detect_stagnation') {
          if (args.recentAction) {
            this.stagnation.recordAction(args.recentAction);
          }
          const res = await this.stagnation.check(args.goal);
          contentText = JSON.stringify(res, null, 2);
        } else if (toolName === 'reflex_route') {
          const res = await this.router.selectBest(args.goal || '', args.candidates || [], args.topK || 3);
          contentText = JSON.stringify(res, null, 2);
        } else if (toolName === 'reflex_status_ledger') {
          const summary = this.ledger.getSummary();
          const responsePayload: any = { summary };
          if (args.includeEntries) {
            responsePayload.recentEntries = this.ledger.getEntries().slice(-10);
          }
          contentText = JSON.stringify(responsePayload, null, 2);
        } else {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`
            }
          };
        }

        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: contentText
              }
            ]
          }
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Tool execution failed: ${err.message}`
              }
            ]
          }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    };
  }
}
