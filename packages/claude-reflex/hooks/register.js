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
 * Resolve the configured effort, or `undefined` when the user left it alone.
 *
 * `options` is what Claude Code passes to `register` (the plugin's declared
 * `userConfig` values with defaults filled in). `$.env` is the mods API, read
 * defensively so a unit test can supply a plain object.
 *
 * @param {Record<string, unknown>} [options] - plugin userConfig values.
 * @param {{ env?: { get?: (name: string) => string | undefined } }} [$] - mods API.
 * @returns {string | undefined} one of {@link EFFORT_LEVELS}, or `undefined`.
 */
export function resolveEffort(options = {}, $ = {}) {
  const fromOptions = typeof options.effort_level === 'string' ? options.effort_level : '';
  let fromEnv = '';
  try {
    fromEnv = typeof $.env?.get === 'function' ? String($.env.get('HARNESS_REFLEX_EFFORT') ?? '') : '';
  } catch {
    fromEnv = '';
  }
  const value = (fromOptions || fromEnv).trim().toLowerCase();
  if (!value || value === EFFORT_UNSET) return undefined;
  return EFFORT_LEVELS.includes(value) ? value : undefined;
}

/**
 * Install the mod's middleware.
 *
 * @param {(event: string, hook: Function) => unknown} on - the mods registration function.
 * @param {Record<string, unknown>} [options] - plugin `userConfig` values.
 * @returns {unknown[]} the registrations, in installation order.
 */
export function register(on, options = {}) {
  if (typeof on !== 'function') {
    throw new TypeError('harness-reflex mod: register(on, options) requires the mods `on` function');
  }

  const registrations = [];

  registrations.push(
    on('turn.step', async function* turnStep($, event, next) {
      let requested = event;
      try {
        const effort = resolveEffort(options, $);
        if (effort) requested = { ...event, effort };
      } catch {
        requested = event;
      }
      yield* next(requested);
    })
  );

  registrations.push(
    on('tool.call', async ($, event, next) => {
      // See the module header: the decision path lives in the command hooks in
      // S3. Forwarding keeps this handler observational and idempotent.
      return next(event);
    })
  );

  return registrations;
}
