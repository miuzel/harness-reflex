/**
 * The Codex adapter: event table, `hooks.json`, `config.toml`, and the setup entry
 * point.
 *
 * Everything here is grounded in codex-cli 0.163.0 rather than in its
 * documentation, because the documentation does not cover hooks yet. The event
 * table was read out of the binary (`hooks/src/engine/command_runner.rs`) and
 * then confirmed by running a real `codex exec` against a probe hook:
 *
 * - **Twelve events**, not ten. `Stop` and `Interrupt` are in the binary's
 *   normalized list and `Stop` fires on every completed turn.
 * - **`args` is not passed to the hook process.** A handler declared as
 *   `{command: "/path/hook.sh", args: ["session-start"]}` runs with `argv = []`.
 *   The event therefore has to ride in the command string itself.
 * - **Codex clamps the SessionEnd timeout to 3 s** and warns when `hooks.json`
 *   asks for more, so the table stays under 3.
 * - **The event name is in the payload** (`hook_event_name`, PascalCase), which
 *   is what the probe records and what the normalizer trusts over `argv`.
 *
 * The payload normalizer itself lives in `hook/payload` because it describes the
 * stdin shape of every host; an adapter that imported another adapter would
 * break the dependency fence this repository tests.
 *
 * @module adapters/codex
 */
import * as fs from 'fs';
import * as path from 'path';
import { CODEX_ONLY_HOOK_EVENTS, EVENT_BUDGETS, type CodexOnlyHookEvent, type HookEvent } from '../hook/contract.js';

/** One Codex hook event, as the binary spells it in all three notations. */
export interface CodexHookEventSpec {
  /** The `hook_event_name` value Codex puts in the payload and reads back. */
  readonly pascal: string;
  /** The kebab-case subcommand this runtime accepts for the event. */
  readonly kebab: string;
  /** The `harness-reflex hook <subcommand>` token for the event. */
  readonly subcommand: string;
  /**
   * The canonical event this maps to, or `null` when the runtime has no
   * capability for it and must answer `{}`.
   */
  readonly canonical: HookEvent | null;
  /**
   * The Codex-only event, when {@link canonical} is `null` and the event is
   * still recognized. `null` on both means a genuinely unsupported event.
   */
  readonly codexOnly: CodexOnlyHookEvent | null;
  /** Handler timeout in seconds, kept inside both budgets. */
  readonly timeoutSec: number;
}

/** The SessionEnd timeout Codex clamps to, discovered from its own warning. */
export const CODEX_SESSION_END_TIMEOUT_SEC = 3;

/**
 * Convert a host timeout in milliseconds to the whole seconds `hooks.json` takes.
 *
 * Rounded **up**: the host timeout must never be shorter than the internal
 * decision budget, or a decision that would have finished is killed by the host
 * and the event silently fails open.
 */
function toHostSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * The twelve Codex hook events and what this runtime does with each.
 *
 * Order follows the binary so a diff against `command_runner.rs` is readable.
 */
export const CODEX_HOOK_EVENTS: readonly CodexHookEventSpec[] = [
  {
    pascal: 'PreToolUse',
    kebab: 'pre-tool-use',
    subcommand: 'pretooluse',
    canonical: 'pretooluse',
    codexOnly: null,
    timeoutSec: toHostSeconds(EVENT_BUDGETS.pretooluse.hookTimeoutMs)
  },
  {
    pascal: 'PermissionRequest',
    kebab: 'permission-request',
    subcommand: 'permissionrequest',
    canonical: null,
    codexOnly: 'permissionrequest',
    timeoutSec: 1
  },
  {
    pascal: 'PostToolUse',
    kebab: 'post-tool-use',
    subcommand: 'posttooluse',
    canonical: 'posttooluse',
    codexOnly: null,
    timeoutSec: toHostSeconds(EVENT_BUDGETS.posttooluse.hookTimeoutMs)
  },
  {
    pascal: 'PreCompact',
    kebab: 'pre-compact',
    subcommand: 'precompact',
    canonical: null,
    codexOnly: 'precompact',
    timeoutSec: 1
  },
  {
    pascal: 'PostCompact',
    kebab: 'post-compact',
    subcommand: 'postcompact',
    canonical: null,
    codexOnly: 'postcompact',
    timeoutSec: 1
  },
  {
    pascal: 'SessionStart',
    kebab: 'session-start',
    subcommand: 'sessionstart',
    canonical: 'sessionstart',
    codexOnly: null,
    timeoutSec: toHostSeconds(EVENT_BUDGETS.sessionstart.hookTimeoutMs)
  },
  {
    pascal: 'SessionEnd',
    kebab: 'session-end',
    subcommand: 'sessionend',
    canonical: 'sessionend',
    codexOnly: null,
    // Codex clamps this one to 3 s and warns, so ask for 3 and stay quiet.
    timeoutSec: Math.min(CODEX_SESSION_END_TIMEOUT_SEC, toHostSeconds(EVENT_BUDGETS.sessionend.hookTimeoutMs))
  },
  {
    pascal: 'UserPromptSubmit',
    kebab: 'user-prompt-submit',
    subcommand: 'userpromptsubmit',
    canonical: null,
    codexOnly: 'userpromptsubmit',
    timeoutSec: 1
  },
  {
    pascal: 'SubagentStart',
    kebab: 'subagent-start',
    subcommand: 'subagentstart',
    canonical: null,
    codexOnly: 'subagentstart',
    timeoutSec: 1
  },
  {
    pascal: 'SubagentStop',
    kebab: 'subagent-stop',
    subcommand: 'substop',
    canonical: 'substop',
    codexOnly: null,
    timeoutSec: toHostSeconds(EVENT_BUDGETS.substop.hookTimeoutMs)
  },
  {
    pascal: 'Stop',
    kebab: 'stop',
    subcommand: 'stop',
    canonical: 'stop',
    codexOnly: null,
    timeoutSec: toHostSeconds(EVENT_BUDGETS.stop.hookTimeoutMs)
  },
  {
    pascal: 'Interrupt',
    kebab: 'interrupt',
    subcommand: 'interrupt',
    canonical: null,
    codexOnly: 'interrupt',
    timeoutSec: 1
  }
];

/** Normalize any spelling of a Codex event to its spec. */
function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Resolve a Codex event from any spelling: PascalCase, kebab-case, snake_case,
 * the hook subcommand, or the canonical name.
 * @param raw - the event name to resolve.
 * @returns the matching spec, or `undefined` for an unsupported name.
 */
export function parseCodexHookEvent(raw: string | undefined): CodexHookEventSpec | undefined {
  if (!raw) return undefined;
  const wanted = normalizeName(raw);
  for (const spec of CODEX_HOOK_EVENTS) {
    if (
      normalizeName(spec.pascal) === wanted ||
      normalizeName(spec.kebab) === wanted ||
      normalizeName(spec.subcommand) === wanted
    ) {
      return spec;
    }
  }
  return undefined;
}

/** The spec for one canonical event, for tests and for the reverse mapping. */
export function codexSpecForCanonical(event: HookEvent): CodexHookEventSpec | undefined {
  return CODEX_HOOK_EVENTS.find((spec) => spec.canonical === event);
}

/** Every Codex-only event the runtime recognizes but cannot decide. */
export function codexOnlyEvents(): readonly CodexOnlyHookEvent[] {
  return CODEX_ONLY_HOOK_EVENTS;
}

/**
 * Render the whole command Codex should run for one event.
 *
 * Codex does not forward handler `args`, so the event is part of the command
 * string. Two shapes are supported and distinguished by the entry itself:
 *
 * - a **script path** (`/x/dist/cli/index.js`, `./cli.js`) runs under this Node
 *   binary, because Codex spawns the command without knowing it is JS;
 * - a **command name** (`harness-reflex`, the installed bin) runs as-is.
 *
 * Anything that looks like a path is quoted, so a directory with spaces works.
 * @param entry - an absolute script path or an installed command name.
 * @param spec - the event to wire.
 * @returns the command string for `hooks.json`.
 */
export function renderCodexHookCommand(entry: string, spec: CodexHookEventSpec): string {
  const looksLikeScript = entry.includes('/') || entry.includes('\\') || /\.(?:js|mjs|cjs)$/.test(entry);
  const program = looksLikeScript ? `node ${quote(entry)}` : entry;
  return `${program} hook ${spec.subcommand}`;
}

/** Quote one shell word when it contains anything a shell would split on. */
function quote(word: string): string {
  return /^[A-Za-z0-9_./:@%+-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** One matcher group of a Codex `hooks.json` event. */
export interface CodexHookMatcherGroup {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout: number }[];
}

/** The `hooks.json` document Codex loads from `$CODEX_HOME/hooks.json`. */
export interface CodexHooksConfig {
  hooks: Record<string, CodexHookMatcherGroup[]>;
}

/**
 * Build the `hooks.json` document for this runtime.
 *
 * `PreToolUse` and `PostToolUse` get a `matcher` that covers both the built-in
 * shell tools and any MCP tool, because the probe showed `matcher: ".*"` is
 * honored and a matcher that only names MCP tools would miss every shell call.
 * @param entryScript - absolute path to `dist/cli/index.js`.
 * @param options - `events` narrows the wired set; `matcher` overrides the tool
 *   matcher for the tool-scoped events.
 * @returns the document, ready to serialize.
 */
export function buildCodexHooksConfig(
  entryScript: string,
  options: { events?: readonly CodexHookEventSpec[]; matcher?: string } = {}
): CodexHooksConfig {
  const events = options.events ?? CODEX_HOOK_EVENTS;
  // `.*` is what was verified against a real exec run; it covers exec_command,
  // apply_patch, and mcp__* alike.
  const matcher = options.matcher ?? '.*';
  const hooks: Record<string, CodexHookMatcherGroup[]> = {};
  for (const spec of events) {
    const handler = {
      type: 'command' as const,
      command: renderCodexHookCommand(entryScript, spec),
      timeout: spec.timeoutSec
    };
    hooks[spec.pascal] =
      spec.pascal === 'PreToolUse' || spec.pascal === 'PostToolUse'
        ? [{ matcher, hooks: [handler] }]
        : [{ hooks: [handler] }];
  }
  return { hooks };
}

/**
 * Build the `config.toml` fragment that registers the MCP server.
 *
 * Codex reads MCP servers from `config.toml` (`[mcp_servers.<name>]`), which
 * `codex mcp list --json` reports back and which the probe confirmed. The
 * `.codex/config.json` file this repository wrote before that is kept for
 * backwards compatibility but is not what Codex reads.
 * @param entryScript - absolute path to `dist/cli/index.js`.
 * @param options - `name` overrides the server name; `env` overrides the
 *   environment table (empty values are dropped, an empty object emits no table).
 * @returns the TOML fragment, without the surrounding config.
 */
export function renderCodexMcpToml(
  entryScript: string,
  options: { name?: string; env?: Record<string, string> } = {}
): string {
  const name = options.name ?? 'harness-reflex';
  const env = options.env ?? {
    SYSTEM_ONE_BACKEND: process.env.SYSTEM_ONE_BACKEND || process.env.REFLEX_BACKEND || 'mock',
    SYSTEM_ONE_API_KEY: process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY || '',
    SYSTEM_ONE_BASE_URL: process.env.SYSTEM_ONE_BASE_URL || process.env.JEV_BASE_URL || ''
  };
  const lines = [
    `[mcp_servers.${name}]`,
    'command = "node"',
    `args = [${JSON.stringify(entryScript)}, "mcp"]`,
    'startup_timeout_sec = 20'
  ];
  // Emit the env table only when there is at least one non-empty value.
  const entries = Object.entries(env).filter(([, value]) => value !== '');
  if (entries.length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of entries) lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** What one Codex configuration run wrote. */
export interface CodexSetupResult {
  /** `.codex/config.json` — the legacy MCP block, kept for compatibility. */
  configPath: string;
  /** `.codex/hooks.json` — the hook wiring Codex actually loads. */
  hooksPath: string;
  /** `.codex/config.toml` — the MCP block Codex actually reads. */
  tomlPath: string;
  created: boolean;
}

export class CodexAdapter {
  /**
   * Generates or updates Codex CLI configuration: MCP (both files) and hooks.
   *
   * Codex reads MCP servers from `config.toml`, not `config.json` — the latter
   * is what this repository wrote before and is kept so existing setups keep
   * working. Hooks come from `$CODEX_HOME/hooks.json`, so the same directory is
   * written here; a user who points `CODEX_HOME` at `<workspace>/.codex` gets a
   * complete setup.
   * @param workspaceDir - the directory that holds `.codex/`.
   * @param binaryPath - absolute path to `dist/cli/index.js`.
   */
  static configureCodex(workspaceDir: string, binaryPath: string): CodexSetupResult {
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

    // `config.toml` is the file Codex actually reads for MCP servers. Merge the
    // managed block in without touching whatever else the user keeps there.
    const tomlPath = path.join(codexConfigDir, 'config.toml');
    const block = renderCodexMcpToml(binaryPath);
    writeManagedTomlBlock(tomlPath, block);

    const hooks = CodexAdapter.buildHooksConfig(binaryPath);
    const hooksPath = path.join(codexConfigDir, 'hooks.json');
    fs.writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');

    return { configPath, hooksPath, tomlPath, created: true };
  }

  /**
   * Write only the hook wiring, leaving any MCP configuration alone.
   * @param workspaceDir - the directory that holds `.codex/`.
   * @param binaryPath - absolute path to `dist/cli/index.js`.
   */
  static configureCodexHooks(workspaceDir: string, binaryPath: string): { hooksPath: string } {
    const codexConfigDir = path.join(workspaceDir, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    const hooksPath = path.join(codexConfigDir, 'hooks.json');
    fs.writeFileSync(hooksPath, `${JSON.stringify(CodexAdapter.buildHooksConfig(binaryPath), null, 2)}\n`, 'utf8');
    return { hooksPath };
  }

  /**
   * The `hooks.json` document for every Codex event.
   * @param binaryPath - absolute path to `dist/cli/index.js`.
   */
  static buildHooksConfig(binaryPath: string): CodexHooksConfig {
    return buildCodexHooksConfig(binaryPath, { events: CODEX_HOOK_EVENTS });
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

/** The marker that delimits the block this adapter owns inside `config.toml`. */
const TOML_BLOCK_START = '# >>> harness-reflex (managed) >>>';
const TOML_BLOCK_END = '# <<< harness-reflex (managed) <<<';

/**
 * Replace the managed block in a TOML file, leaving every other byte alone.
 * @param tomlPath - the file to update; created when missing.
 * @param block - the block body, without markers.
 */
function writeManagedTomlBlock(tomlPath: string, block: string): void {
  const managed = `${TOML_BLOCK_START}\n${block.trimEnd()}\n${TOML_BLOCK_END}`;
  let existing = '';
  if (fs.existsSync(tomlPath)) {
    existing = fs.readFileSync(tomlPath, 'utf8');
  }
  const start = existing.indexOf(TOML_BLOCK_START);
  const end = existing.indexOf(TOML_BLOCK_END);
  let next: string;
  if (start >= 0 && end > start) {
    next = `${existing.slice(0, start)}${managed}${existing.slice(end + TOML_BLOCK_END.length)}`;
  } else {
    const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${separator}${managed}\n`;
  }
  fs.writeFileSync(tomlPath, next, 'utf8');
}
