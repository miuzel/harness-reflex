/**
 * The eight `reflex_*` tools, registered through pi's `registerTool`.
 *
 * These are the same eight tools the MCP surface exposes, with the same names,
 * the same input schemas, and the same payloads. That is a deliberate choice:
 * an agent that has learned `reflex_gate` on the MCP surface must not have to
 * relearn it inside pi, and the two surfaces can be compared line by line.
 *
 * ## Why the schemas are plain objects
 *
 * pi validates `parameters` with TypeBox, which is happy with any object that
 * carries `type`/`properties`/`required` — the same shape MCP's `inputSchema`
 * already uses. Writing them as JSON Schema values instead of `Type.Object({…})`
 * calls keeps this package free of a runtime type-builder dependency, which is
 * the package's contract: zero `dependencies`, hosts in `peerDependencies`.
 *
 * ## Why the ledger is memory-only here
 *
 * `DecisionLedger` writes JSONL to `<cwd>/.reflex/ledger.jsonl` by default. A
 * tool call must not create files in the user's project as a side effect, so the
 * instance is constructed with `null`: it accumulates in process and is the
 * same object the extension's intervention path records into. A caller that
 * wants the file reuses {@link piReflexServices}.
 *
 * @module pi-reflex/tools
 */
import { createDecisionBackend } from '../../../src/backend/factory.js';
import type { DecisionBackend } from '../../../src/backend/types.js';
import { Calibrator } from '../../../src/core/calibrate.js';
import { ReflexGateService } from '../../../src/core/gate.js';
import { DecisionLedger } from '../../../src/core/ledger.js';
import { ToolResultPruner } from '../../../src/core/prune.js';
import { ReflexRouter } from '../../../src/core/route.js';
import { scoreStatement } from '../../../src/core/score.js';
import { ReflexScreenService } from '../../../src/core/screen.js';
import { StagnationDetector } from '../../../src/core/stagnation.js';

/** The service graph the eight tools call, all sharing one ledger. */
export interface PiReflexServices {
  backend: DecisionBackend;
  ledger: DecisionLedger;
  calibrator: Calibrator;
  gate: ReflexGateService;
  pruner: ToolResultPruner;
  stagnation: StagnationDetector;
  router: ReflexRouter;
  screen: ReflexScreenService;
}

/**
 * Build the service graph.
 *
 * The backend comes from the shared factory, so the same environment variables
 * (`SYSTEM_ONE_BACKEND`, keys, base URLs) select the backend inside pi as they
 * do in every other host. The ledger is memory-only by default.
 * @param options - injection seams for tests.
 * @returns the services.
 */
export function piReflexServices(
  options: {
    backend?: DecisionBackend;
    /** `null` (default) keeps the ledger in memory; a path appends JSONL. */
    ledgerPath?: string | null;
  } = {}
): PiReflexServices {
  const backend = options.backend ?? createDecisionBackend();
  const ledger = new DecisionLedger(options.ledgerPath === undefined ? null : options.ledgerPath);
  const calibrator = Calibrator.getInstance();
  return {
    backend,
    ledger,
    calibrator,
    gate: new ReflexGateService(backend, ledger, calibrator),
    pruner: new ToolResultPruner(backend, ledger),
    stagnation: new StagnationDetector(backend, ledger),
    router: new ReflexRouter(backend, ledger),
    screen: new ReflexScreenService(backend, ledger)
  };
}

/** One registered tool: its declaration and its pure executor. */
export interface ReflexToolSpec {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the parameters; pi validates against it. */
  parameters: Record<string, unknown>;
  /**
   * Run the tool.
   * @param args - the validated arguments.
   * @param services - the shared service graph.
   * @returns the model-facing text.
   */
  execute(args: Record<string, unknown>, services: PiReflexServices): Promise<string>;
}

/** Stable JSON, so a tool's text payload is diffable. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Read a string argument, or `undefined` when it is not a string. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean argument, defaulting to `false`. */
function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

/** The eight tool specs, in the MCP surface's order. */
export const REFLEX_TOOLS: readonly ReflexToolSpec[] = [
  {
    name: 'reflex_gate',
    label: 'Reflex Gate',
    description:
      'Strict fail-closed verification of assertions against concrete evidence. Returns verified, contradicted, or escalate.',
    parameters: {
      type: 'object',
      properties: {
        assertions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { statement: { type: 'string', description: 'Assertion or criteria to verify' } },
            required: ['statement']
          },
          description: 'List of statements to verify against the evidence'
        },
        evidence: { type: 'string', description: 'The raw evidence (stdout, test output, file contents)' },
        strictness: {
          type: 'string',
          enum: ['high', 'normal', 'lenient'],
          description: 'Strictness level for verification'
        }
      },
      required: ['assertions', 'evidence']
    },
    async execute(args, services) {
      const assertions = Array.isArray(args.assertions)
        ? (args.assertions as Array<{ statement: string }>)
        : [];
      const strictness = str(args, 'strictness') as 'high' | 'normal' | 'lenient' | undefined;
      const result = await services.gate.verify(assertions, str(args, 'evidence') ?? '', {
        ...(strictness === undefined ? {} : { strictness })
      });
      return json(result);
    }
  },
  {
    name: 'reflex_prune',
    label: 'Reflex Prune',
    description:
      'Prune bulky tool output (e.g. verbose logs, build traces, directory trees) while preserving critical diagnostic lines.',
    parameters: {
      type: 'object',
      properties: {
        rawOutput: { type: 'string', description: 'The long tool output to prune' },
        intent: {
          type: 'string',
          description: 'What information you are looking for (e.g. "find compiler error", "check test failures")'
        },
        shadowMode: {
          type: 'boolean',
          description: 'If true, compute token reduction metrics without truncating text'
        }
      },
      required: ['rawOutput']
    },
    async execute(args, services) {
      const result = await services.pruner.prune(str(args, 'rawOutput') ?? '', {
        ...(str(args, 'intent') === undefined ? {} : { intent: str(args, 'intent')! }),
        shadowMode: bool(args, 'shadowMode')
      });
      return json({
        tokensSaved: result.estimatedTokensSaved,
        reductionPercentage: `${result.reductionPercentage}%`,
        shadow: result.shadow,
        processedOutput: result.processedOutput
      });
    }
  },
  {
    name: 'reflex_detect_stagnation',
    label: 'Reflex Detect Stagnation',
    description:
      'Check if the agent is stuck in an unproductive loop, oscillating between identical edits, or repeatedly failing.',
    parameters: {
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
        goal: { type: 'string', description: 'Current overall goal' },
        history: {
          type: 'array',
          description:
            'Earlier steps of the run, oldest first, when this process did not record them itself (a resumed or delegated run).',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Tool that was executed' },
              input: { type: 'string', description: 'Input provided to the tool' },
              output: { type: 'string', description: 'Tool output or error summary' },
              error: { type: 'string', description: 'Error message if failed' }
            },
            required: ['tool', 'input']
          }
        }
      }
    },
    async execute(args, services) {
      const recent = args.recentAction;
      if (recent && typeof recent === 'object') {
        services.stagnation.recordAction(recent as { tool: string; input: string });
      }
      const history = Array.isArray(args.history)
        ? (args.history as Array<{ tool: string; input: string }>)
        : undefined;
      return json(await services.stagnation.check(str(args, 'goal'), history));
    }
  },
  {
    name: 'reflex_route',
    label: 'Reflex Route',
    description:
      'Score and rank candidate tools, skills, or next steps against a goal using probabilistic System 1 decision.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal or user task' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name', 'description']
          },
          description: 'Candidate tools or skills to rank'
        },
        topK: { type: 'number', description: 'Number of candidates to return' }
      },
      required: ['goal', 'candidates']
    },
    async execute(args, services) {
      const candidates = Array.isArray(args.candidates)
        ? (args.candidates as Array<{ name: string; description: string }>)
        : [];
      const topK = typeof args.topK === 'number' ? args.topK : 3;
      return json(await services.router.selectBest(str(args, 'goal') ?? '', candidates, topK));
    }
  },
  {
    name: 'reflex_status_ledger',
    label: 'Reflex Status Ledger',
    description:
      'Query the decision ledger: see total decisions made, net tokens saved, cost reductions, and latency metrics.',
    parameters: {
      type: 'object',
      properties: {
        includeEntries: { type: 'boolean', description: 'Whether to include recent decision logs' }
      }
    },
    async execute(args, services) {
      const summary = services.ledger.getSummary();
      const payload: Record<string, unknown> = { summary };
      if (bool(args, 'includeEntries')) {
        payload.recentEntries = services.ledger.getEntries().slice(-10);
      }
      return json(payload);
    }
  },
  {
    name: 'reflex_choice',
    label: 'Reflex Choice',
    description:
      'General-purpose System One multi-class choice. Evaluates a question over options and returns probability distribution in single-digit milliseconds without generative token overhead.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question or classification prompt' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'The candidate options to score'
        },
        context: { type: 'string', description: 'Optional background context' }
      },
      required: ['question', 'options']
    },
    async execute(args, services) {
      const options = Array.isArray(args.options) ? (args.options as string[]) : [];
      const result = await services.backend.choice({
        question: str(args, 'question') ?? '',
        options,
        ...(str(args, 'context') === undefined ? {} : { context: str(args, 'context')! })
      });
      const calibratedConfidence = services.calibrator.isLoaded()
        ? services.calibrator.calibrate(result.confidence).calibrated
        : undefined;
      return json({ ...result, calibratedConfidence });
    }
  },
  {
    name: 'reflex_score',
    label: 'Reflex Score',
    description:
      'Score or evaluate a statement/code snippet against criteria on a 0.0 to 1.0 continuous scale.',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'Statement, output, or code to evaluate' },
        criteria: { type: 'string', description: 'Evaluation rubric or criteria' },
        context: { type: 'string', description: 'Surrounding context or evidence' }
      },
      required: ['statement']
    },
    async execute(args, services) {
      const request: { statement: string; criteria?: string; context?: string } = {
        statement: str(args, 'statement') ?? ''
      };
      if (str(args, 'criteria') !== undefined) request.criteria = str(args, 'criteria')!;
      if (str(args, 'context') !== undefined) request.context = str(args, 'context')!;
      return json(await scoreStatement(services.backend, request));
    }
  },
  {
    name: 'reflex_screen',
    label: 'Reflex Screen',
    description:
      'Screen untrusted content (e.g. tool output, external PR, web fetch, user input) for prompt injection, system overrides, or credential exfiltration attempts.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Untrusted content to screen' },
        source: {
          type: 'string',
          enum: ['tool_output', 'web_page', 'user_input', 'file_content'],
          description: 'Source of the content'
        },
        strict: { type: 'boolean', description: 'If true, enforce secondary deep model screening' }
      },
      required: ['content']
    },
    async execute(args, services) {
      const source = str(args, 'source') as
        | 'tool_output'
        | 'web_page'
        | 'user_input'
        | 'file_content'
        | undefined;
      const result = await services.screen.screen({
        content: str(args, 'content') ?? '',
        ...(source === undefined ? {} : { source }),
        strict: bool(args, 'strict')
      });
      return json(result);
    }
  }
];

/** The eight tool names, which the e2e asserts against pi's tool list. */
export const REFLEX_TOOL_NAMES: readonly string[] = REFLEX_TOOLS.map((tool) => tool.name);
