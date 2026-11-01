/**
 * harness-reflex for OpenCode.
 *
 * OpenCode is the one host in this repository whose extension point is **not**
 * a shell command: plugins are JavaScript/TypeScript modules whose exported
 * function returns a hooks object. That is why this package ships code instead
 * of a config fragment — "use a shell hook where the host offers one" cannot be
 * satisfied by inventing a shell mechanism the host does not have.
 *
 * The decision itself is never reimplemented here. Each interception builds the
 * payload in the vocabulary `harness-reflex hook <event>` already reads, runs
 * that command, and maps the verdict onto the effect the host documents:
 *
 * | verdict                              | OpenCode effect                                  |
 * | ------------------------------------ | ------------------------------------------------ |
 * | `{}`                                 | nothing (allow)                                  |
 * | `permissionDecision: "deny"`         | `throw` from `tool.execute.before` blocks the call |
 * | `updatedToolOutput`                  | replace `output.output` in `tool.execute.after`   |
 * | `decision: "block"` (Stop)           | logged; the host exposes no turn-end veto         |
 *
 * Zero runtime dependencies: `node:child_process` plus the installed CLI. The
 * `@opencode-ai/plugin` types are documentation here, not a dependency — a
 * plugin that imported them would need the host's package installed to load,
 * and a failure to load is a failure to intervene.
 *
 * Every path is fail-open: a spawn error, a timeout, unparseable output, or an
 * exception thrown by the host's own objects degrades to "no instruction".
 *
 * @module opencode-reflex
 */

import { spawn } from 'node:child_process';

/** The default command; an installed CLI is what the other hosts use too. */
const DEFAULT_BIN = 'harness-reflex';

/** Upper bound on one decision; the design's largest host budget plus slack. */
const DEFAULT_TIMEOUT_MS = 3000;

/** Upper bound on one stdout/stderr read, so a runaway child cannot grow us. */
const MAX_OUTPUT_BYTES = 1 << 20;

/**
 * Run `harness-reflex hook <event>` and return its verdict object.
 *
 * Resolves to `undefined` for "no instruction", which is also what every failure
 * path returns: a plugin must never turn its own malfunction into a block.
 *
 * @param {string} event - one of the decision events (`pretooluse`, ...).
 * @param {Record<string, unknown>} payload - the host-facing stdin object.
 * @param {{ bin?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export function runHook(event, payload, options = {}) {
  const bin = options.bin ?? DEFAULT_BIN;
  const env = options.env ?? process.env;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['hook', event], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore: the settle below is what matters
      }
      settle(undefined);
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    // A child that dies early makes stdin writes fail; that is not our problem.
    child.stdin.on('error', () => {});
    child.on('error', () => settle(undefined));
    child.on('close', () => {
      const text = stdout.trim();
      if (text.length === 0) {
        settle(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        settle(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined);
      } catch {
        settle(undefined);
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      settle(undefined);
    }
  });
}

/**
 * Map one verdict onto the host effect it authorizes.
 *
 * Pure on purpose: the four decision paths are asserted here, with the verdict
 * objects produced by a real hook run, instead of being smeared across four
 * event handlers that each need a host to exist.
 *
 * @param {Record<string, unknown> | undefined} verdict
 * @returns {{ denyReason?: string, replacement?: string, blockedReason?: string }}
 */
export function mapVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return {};
  const specific = verdict.hookSpecificOutput;
  if (specific && typeof specific === 'object') {
    if (specific.permissionDecision === 'deny') {
      const reason = typeof specific.permissionDecisionReason === 'string' && specific.permissionDecisionReason.length > 0
        ? specific.permissionDecisionReason
        : 'blocked by harness-reflex';
      return { denyReason: reason };
    }
    if (typeof specific.updatedToolOutput === 'string') return { replacement: specific.updatedToolOutput };
  }
  // A Stop objection. OpenCode documents no plugin-level veto for a finished
  // turn, so the reason is reported rather than enforced — see README.md.
  if (verdict.decision === 'block') {
    const reason = typeof verdict.reason === 'string' && verdict.reason.length > 0 ? verdict.reason : 'completion claim contradicted';
    return { blockedReason: reason };
  }
  return {};
}

/** Build the payload for a tool interception, in the hook CLI's vocabulary. */
export function toolPayload(input, output, extra = {}) {
  return {
    session_id: typeof input?.sessionID === 'string' ? input.sessionID : '',
    tool_name: typeof input?.tool === 'string' ? input.tool : '',
    tool_input: output?.args ?? {},
    tool_use_id: typeof input?.callID === 'string' ? input.callID : '',
    ...extra
  };
}

/**
 * Resolve the runtime settings, letting the environment fill the gaps.
 *
 * An explicit option always wins, so a caller (and the tests) stay in control;
 * the environment is only a fallback for the case where the host calls the
 * plugin with no options at all.
 *
 * @param {{ bin?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} options
 */
function resolveSettings(options) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? (env.HARNESS_REFLEX_BIN?.trim() || undefined);
  let timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs)) {
    const fromEnv = Number(env.HARNESS_REFLEX_TIMEOUT_MS);
    timeoutMs = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
  }
  return { bin, env: options.env, timeoutMs };
}

/**
 * The plugin entry point OpenCode calls once per session.
 *
 * @param {{ client?: unknown, directory?: string, worktree?: string }} input
 * @param {{ bin?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export const ReflexPlugin = async (input, options = {}) => {
  const settings = resolveSettings(options);
  const log = async (level, message, extra) => {
    // `client.app.log` is the documented logging surface; a missing client (or a
    // failing one) must not break the plugin.
    try {
      await input?.client?.app?.log({ body: { service: 'harness-reflex', level, message, extra } });
    } catch {
      // ignore
    }
  };
  const decide = (event, payload) => runHook(event, payload, settings);

  return {
    // Deny surface: throwing from this hook stops the tool call (the host's own
    // documented pattern for refusing a call).
    'tool.execute.before': async (hookInput, hookOutput) => {
      const verdict = await decide('pretooluse', toolPayload(hookInput, hookOutput, { hook_event_name: 'PreToolUse' }));
      const mapped = mapVerdict(verdict);
      if (mapped.denyReason !== undefined) throw new Error(mapped.denyReason);
    },

    // Rewrite surface: `output.output` is the text the model reads, so this is
    // where pruning actually takes effect on OpenCode.
    'tool.execute.after': async (hookInput, hookOutput) => {
      // OpenCode hands over one output string, so it is forwarded as a string
      // rather than as `{stdout, stderr}`: the decision layer joins that pair
      // with a newline, which would make a retained original differ from the
      // bytes the host produced.
      const text = typeof hookOutput?.output === 'string' ? hookOutput.output : '';
      const verdict = await decide('posttooluse', toolPayload(hookInput, hookOutput, {
        hook_event_name: 'PostToolUse',
        tool_response: text
      }));
      const mapped = mapVerdict(verdict);
      if (mapped.replacement !== undefined) hookOutput.output = mapped.replacement;
    },

    // Session boundaries. OpenCode documents these as one-shot events, so the
    // decision is recorded in the ledger and nothing is injected into context.
    event: async ({ event } = {}) => {
      try {
        if (event?.type === 'session.created') {
          await decide('sessionstart', {
            hook_event_name: 'SessionStart',
            session_id: event.properties?.info?.id ?? '',
            source: 'startup',
            cwd: input?.directory
          });
        } else if (event?.type === 'session.deleted') {
          await decide('sessionend', {
            hook_event_name: 'SessionEnd',
            session_id: event.properties?.info?.id ?? '',
            reason: 'exit'
          });
        } else if (event?.type === 'session.idle') {
          // Recorded only: the event carries no assistant text, and the host
          // offers no way to block a finished turn, so a Stop verdict here can
          // be reported but not enforced.
          const verdict = await decide('stop', {
            hook_event_name: 'Stop',
            session_id: event.properties?.sessionID ?? '',
            stop_hook_active: false
          });
          const mapped = mapVerdict(verdict);
          if (mapped.blockedReason !== undefined) await log('warn', mapped.blockedReason, { event: 'Stop' });
        }
      } catch {
        // An event handler that throws is a harness-level failure, not a decision.
      }
    }
  };
};

export default ReflexPlugin;
