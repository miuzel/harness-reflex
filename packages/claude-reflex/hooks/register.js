/**
 * The Claude Code mod for harness-reflex.
 *
 * A mod is the one in-process surface a plugin has: `register(on, options)` is
 * called once per session and every `on(...)` call installs middleware.
 *
 * Scope in v0.2.0 S3, deliberately narrow:
 *
 * - `turn.step` is the effort seam. The mod only forwards the request, unless
 *   the plugin's `userConfig.effort_level` (or `HARNESS_REFLEX_EFFORT`) names a
 *   valid Claude Code effort. No routing strategy is implemented here.
 * - `tool.call` is a pass-through. Pruning, stagnation and failure correction
 *   are owned by the settings hooks (`hooks/hooks.json`), which run as separate
 *   processes against the same on-disk state. Judging a call in both places
 *   would double-intervene on one call, so the mod stays out of the decision
 *   path; this handler is the seam a later in-process decision will attach to.
 *
 * Everything is defensive: a mod hook that throws is a harness-level failure,
 * not an intervention, so a bad configuration must degrade to "forward
 * unchanged".
 *
 * @module claude-reflex/hooks/register
 */

/** The effort values Claude Code documents (`low` … `max`). */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** The user-visible "do not touch" value for the effort option. */
export const EFFORT_UNSET = 'off';

/**
 * Reduce one authored value to an effort Claude Code accepts.
 *
 * Pure on purpose: the mods scanner refuses a hook that passes `$` around, so
 * the env read happens at the call site and only the string reaches this
 * helper. `''`, `off` and anything unknown all mean "leave the request alone".
 *
 * @param {unknown} value - a `userConfig` value or an environment value.
 * @returns {string | undefined} one of {@link EFFORT_LEVELS}, or `undefined`.
 */
export function normalizeEffort(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || trimmed === EFFORT_UNSET) return undefined;
  return EFFORT_LEVELS.includes(trimmed) ? trimmed : undefined;
}

/**
 * Resolve the configured effort from the plugin's `userConfig` alone.
 *
 * @param {Record<string, unknown>} [options] - plugin `userConfig` values.
 * @returns {string | undefined} one of {@link EFFORT_LEVELS}, or `undefined`.
 */
export function resolveEffort(options = {}) {
  return normalizeEffort(options.effort_level);
}

/**
 * Install the mod's middleware.
 *
 * The mods scanner accepts `on` only as a direct call and `$` only as
 * `$.noun.method(...)` at the call site, so this function neither stores the
 * registrations nor hands `$` to a helper: each hook below is a call statement
 * and every API use is written in full.
 *
 * @param {(event: string, hook: Function) => unknown} on - the mods registration function.
 * @param {Record<string, unknown>} [options] - plugin `userConfig` values.
 */
export function register(on, options = {}) {
  on('turn.step', async function* ($, e, next) {
    let fromEnv = '';
    try {
      fromEnv = String($.env.get('HARNESS_REFLEX_EFFORT') ?? '');
    } catch {
      fromEnv = '';
    }
    const authored = typeof options.effort_level === 'string' ? options.effort_level : '';
    const effort = normalizeEffort(authored.trim() === '' ? fromEnv : authored);
    yield* next(effort === undefined ? e : { ...e, effort });
  });

  on('tool.call', async ($, e, next) => next(e));
}
