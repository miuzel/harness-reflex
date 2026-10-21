import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';

import type { ReflexLedgerResult, ReflexRuntime } from './bridge.js';
import type { BackendHealth } from './vendor/harness-reflex/index.js';

/**
 * The human command that reads this activation's decision ledger.
 *
 * The ledger used to be a `reflex_status_ledger` tool. It is not a decision the
 * model should have to spend a turn on — it is an audit question a person asks —
 * so it lives in the Host's command registry instead: `/reflex-ledger` answers
 * it without a model turn and without a slot on the tool surface. The capability
 * is unchanged: this is the same `runtime.statusLedger` read, formatted for a
 * person rather than for a model.
 *
 * @module dsh-reflex/command
 */

/** Registered name of the ledger command, without the leading slash. */
export const REFLEX_LEDGER_COMMAND = 'reflex-ledger';

/** Description the Host advertises for {@link REFLEX_LEDGER_COMMAND}. */
export const REFLEX_LEDGER_COMMAND_DESCRIPTION = '查看 Reflex 决策账本汇总';

/** How many recent decisions the command prints. */
export const LEDGER_COMMAND_ENTRIES = 5;

/** Name the context exposes the command registry under. */
const COMMANDS_SERVICE = 'commands';

/** The slice of the registry this module uses. */
interface CommandRegistry {
  register(definition: { name: string; description: string; handler: () => CommandResult }): () => void;
  /** Resolve one definition, or `undefined` when the name is free. */
  find?(agent: undefined, name: string): unknown;
}

/** One audit entry, in the shape {@link ReflexRuntime.statusLedger} returns. */
type LedgerEntry = NonNullable<ReflexLedgerResult['recentEntries']>[number];

/**
 * Format one instant from the ledger as local `HH:MM:SS`.
 * @param iso - the entry's ISO timestamp.
 * @returns the clock time, or the input when it is not a date.
 */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Format one latency, keeping a tenth of a millisecond when the backend reports
 * a fractional one.
 * @param latencyMs - measured latency.
 * @returns the human reading.
 */
function latencyOf(latencyMs: number): string {
  return `${Number.isInteger(latencyMs) ? latencyMs : latencyMs.toFixed(1)} ms`;
}

/**
 * Render one entry as a single line: time, type, and the facts that entry owns.
 * @param entry - one ledger record.
 * @returns the line, without a trailing newline.
 */
function entryLine(entry: LedgerEntry): string {
  const facts = [latencyOf(entry.latencyMs)];
  if (entry.tokensSaved) facts.push(`节省 ${entry.tokensSaved} token`);
  if (entry.type === 'gate') facts.push(entry.passed ? '通过' : '未通过');
  if (entry.type === 'stagnation') facts.push(entry.isStuck ? '判定停滞' : '未见停滞');
  if (entry.shadow) facts.push('shadow');
  if (entry.skipReason) facts.push(`跳过：${entry.skipReason}`);
  return `- ${clockOf(entry.timestamp)} ${entry.type} · ${facts.join(' · ')}`;
}

/**
 * Render the degraded-backend notice appended to the command reply, if any.
 *
 * The line is bilingual because the panel is, and it stays in the command text:
 * it is a fact for the person typing `/reflex-ledger`, never a message the agent
 * reads. A recovered backend returns `undefined`, so the notice disappears on
 * its own.
 * @param health - backend health at read time, when the backend tracks it.
 * @returns the notice line, or `undefined` when the backend is healthy.
 */
export function systemOneHealthLine(health: BackendHealth | undefined): string | undefined {
  if (health === undefined || health.available) return undefined;
  const reason = health.lastFailureReason ?? 'unknown error';
  const count = health.consecutiveFailures;
  const when = health.lastFailureAt === undefined ? '' : `，最近 ${clockOf(health.lastFailureAt)}`;
  const whenEn = health.lastFailureAt === undefined ? '' : `, latest ${clockOf(health.lastFailureAt)}`;
  return [
    `⚠ System One 后端不可用（${reason}，连续 ${String(count)} 次失败${when}）；决策已降级为本地压缩与确定性兜底。`,
    `System One backend unavailable (${reason}, ${String(count)} consecutive failures${whenEn}); decisions degraded to local compression and deterministic fallback.`
  ].join(' / ');
}

/**
 * Render the ledger summary as plain text a person reads in the command output.
 *
 * The aggregate is always printed; the recent decisions are printed newest
 * first, because "what just happened" is the question the command is typed to
 * answer. An empty ledger is a normal state, not an error: it says so instead of
 * printing zeroes that look like a measurement.
 * @param result - the ledger read, with entries attached.
 * @returns the text of the command's reply.
 */
export function formatLedgerReport(result: ReflexLedgerResult): string {
  const { summary } = result;
  const health = systemOneHealthLine(result.systemOneHealth);
  const withHealth = (lines: string[]): string => {
    if (health !== undefined) lines.push(health);
    return lines.join('\n');
  };
  if (summary.totalCalls === 0) {
    return withHealth([
      `Reflex 决策账本（${REFLEX_LEDGER_COMMAND}）：暂无记录`,
      '本插件激活以来，System 1 还没有做出任何判定。',
      '第一次判定之后（工具调用或自动干预），这里会给出调用数、时延、节省的 token、门禁结果与停滞告警。'
    ]);
  }

  const byType = Object.entries(summary.callsByType)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([type, count]) => `${type} ${count}`)
    .join('、');

  const lines = [
    `Reflex 决策账本（${REFLEX_LEDGER_COMMAND}）`,
    `总调用数：${summary.totalCalls}`,
    `平均时延：${latencyOf(summary.avgLatencyMs)}`,
    `节省 token：${summary.totalTokensSaved}（约 $${summary.estimatedCostSavedUsd.toFixed(4)}）`,
    `门禁：通过 ${summary.gatePassedCount} / 失败 ${summary.gateFailedCount}`,
    `停滞告警：${summary.stagnationAlerts}`,
    `按类型：${byType}`
  ];

  const recent = (result.recentEntries ?? []).slice(-LEDGER_COMMAND_ENTRIES).reverse();
  if (recent.length > 0) {
    lines.push(`最近 ${recent.length} 条决策（最新在前）：`);
    for (const entry of recent) lines.push(entryLine(entry));
  }
  return withHealth(lines);
}

/**
 * Register `/reflex-ledger` on the Host's command registry.
 *
 * The handler takes no arguments and never reaches the model: the Host renders
 * whatever {@link formatLedgerReport} returns. A deployment whose services were
 * already disposed, and a Host whose command registry is not available, both end
 * as a text answer rather than a crash — the ledger is a diagnostic, and a
 * diagnostic must not be able to break the surface that asks for it.
 *
 * The registry is read through `ctx.reflect.get`, not as `ctx.commands`: the
 * property form throws for a context that does not inject `commands`, and the
 * Host loader is not the only caller of `applyReflex`. The read is still the
 * plain service, so a context that does inject it gets the same object.
 * @param ctx - context carrying the `commands` service.
 * @param runtime - the activation whose ledger is read.
 * @returns the disposer that unregisters this exact command.
 */
export function installLedgerCommand(ctx: Context, runtime: ReflexRuntime): () => void {
  const registry = ctx.reflect?.get?.(COMMANDS_SERVICE) as CommandRegistry | undefined;
  if (registry === undefined || typeof registry.register !== 'function') return () => {};

  // The name is context-global, while this plugin can be activated more than
  // once on one context (each activation owning its own tools). The first
  // activation owns the command and answers for the ledger; a later one leaves
  // the registry alone rather than failing its whole activation over a
  // diagnostic. The same holds if someone else already claimed the name.
  if (typeof registry.find === 'function' && registry.find(undefined, REFLEX_LEDGER_COMMAND) !== undefined) {
    return () => {};
  }

  try {
    return registry.register({
      name: REFLEX_LEDGER_COMMAND,
      description: REFLEX_LEDGER_COMMAND_DESCRIPTION,
      handler: (): CommandResult => {
        try {
          return { kind: 'success', text: formatLedgerReport(runtime.statusLedger({ includeEntries: true })) };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { kind: 'error', text: `Reflex 决策账本读取失败：${reason}` };
        }
      }
    });
  } catch (error) {
    // A registry too old to answer `find` still reports the collision; it is the
    // one failure that means "someone else owns this name", not "broken setup".
    if (error instanceof Error && error.message.includes('already registered')) return () => {};
    throw error;
  }
}
