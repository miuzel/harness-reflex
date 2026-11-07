import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';

import { inspectDelegationTool } from './delegation-dispatch.js';

/**
 * Runtime detection of a *broken* delegation capability.
 *
 * `reflex_delegate` hands the DSH delegation tool a System One reasoning level,
 * which only a Host with `modelSelection: true` accepts. What this module
 * reports is deliberately restricted to what it can actually **observe**, and
 * the restriction is the point:
 *
 * - a reading is taken in a **scope** that can be read; without one the answer
 *   is `unknown`, never a guess (see below);
 * - `missing-tool` and `model-selection-off` are reported only when the tool is
 *   genuinely absent from, or genuinely bare in, that scope;
 * - it never writes configuration in response. A patch that stops asking for
 *   `modelSelection` is indistinguishable from a user who deliberately turned it
 *   back off, and turning a user's switch back on is exactly the boundary the
 *   goal forbids. Re-enabling is a user action: tick the switch again, which is
 *   a fresh consent and a fresh write.
 *
 * ## Why "unknown" exists (and why it is not "off")
 *
 * `dsh-tools` is a scoped registry: `get(name)` with no scope reads the **global**
 * view, and a tool attached inside an **agent preset** — where a real deployment
 * puts `tool-subagent` — is not in it. Asking the global view therefore answers
 * "no such tool" on *every* preset-hosted deployment, however correctly
 * `modelSelection` is configured.
 *
 * Reporting that as `model-selection-off` was actively misleading: the panel said
 * a working capability was switched off, and the registration path (which read
 * the same view) refused to register the tool. "This scope does not show the
 * tool" is not evidence that "the capability is off". So an unreadable scope is
 * reported as `unknown`, which is the honest answer and the one the panel shows
 * as "not probed yet" rather than as a fault.
 *
 * @module dsh-reflex/delegation-health
 */

/** Why the delegate capability is (or is not) usable right now. */
export type DelegationHealthState =
  /** The Host delegation tool, read in a readable scope, declares `reasoning_effort`. */
  | 'ready'
  /** The scope that was read genuinely exposes no delegation tool. */
  | 'missing-tool'
  /** The scope that was read exposes a delegation tool without the level parameter. */
  | 'model-selection-off'
  /**
   * Nothing was observed, so nothing is claimed.
   *
   * No scope was available to read (the mount path has none), so neither
   * "ready" nor "broken" is known. This is a *reporting* state, never a reason
   * to withdraw anything.
   */
  | 'unknown';

/** One reading of the live Host, plus the consequence for this activation. */
export interface DelegationHealth {
  /** What the live registry says, or `unknown` when no scope could be read. */
  state: DelegationHealthState;
  /** Registered name of the Host delegation tool, when one was observed. */
  toolName?: string;
  /** One-line reason, present whenever the state is not `ready`. */
  reason?: string;
  /**
   * Whether a *broken* capability was observed.
   *
   * `false` for `unknown`: nothing observed is nothing withdrawn. Registration is
   * decided by configuration, so this flag never gates the wrapper.
   */
  delegateAvailable: boolean;
}

/** The log line emitted when a previously working delegation stops working. */
export const DELEGATION_BROKEN_WARNING =
  'dsh-reflex: the subagent tool no longer declares reasoning_effort (modelSelection is off again), so a delegated call carrying a reasoning level will be refused by the Host. ' +
  'Nothing in your configuration was changed: re-tick "Delegation" in the Reflex settings after restarting DSH, and the level is passed again.';

/** The reason shown on the panel when a read scope genuinely lacks the parameter. */
export const DELEGATION_MODEL_SELECTION_OFF_REASON =
  'The host subagent tool does not declare reasoning_effort, so a decided level cannot reach the child. Tick Delegation again to write the host modelSelection switch (takes effect after a DSH restart).';

/** The panel reason when the read scope genuinely has no delegation tool. */
export const DELEGATION_TOOL_MISSING_REASON =
  'This host exposes no subagent tool in the scope that was read, so there is nothing for reflex_delegate to wrap.';

/** The panel reason when no scope could be read, so no claim is made. */
export const DELEGATION_UNPROBED_REASON =
  'The host capability was not probed: no agent scope was available to read, and a preset-hosted subagent tool is not visible from the global view. reflex_delegate is registered from configuration; whether a level can be carried is settled by the Host when a delegation is called.';

/**
 * Read the live delegation capability of one Host context.
 *
 * Without `agent` this reads the global view, which cannot see a preset-hosted
 * tool; the reading is then only trusted when it finds the tool (a tool that *is*
 * visible globally is genuinely there). Finding nothing proves nothing, and is
 * reported as `unknown`.
 * @param ctx - a context whose `tools` registry is live.
 * @param agent - the scope to read as (the calling agent, or a preset); omitted
 *   selects the global view.
 * @returns the state, its reason, and whether a *broken* capability was observed.
 */
export function readDelegationHealth(ctx: Context, agent?: Agent): DelegationHealth {
  const target = inspectDelegationTool(ctx, agent);
  if (target === undefined) {
    // A global view that shows no tool proves nothing: the tool may simply live
    // in a preset scope this view cannot see. Only a readable scope that lacks
    // it is evidence. "Cannot see" must never be reported as "is off".
    if (agent === undefined) {
      return { state: 'unknown', reason: DELEGATION_UNPROBED_REASON, delegateAvailable: false };
    }
    return {
      state: 'missing-tool',
      reason: DELEGATION_TOOL_MISSING_REASON,
      delegateAvailable: false
    };
  }
  if (!target.acceptsReasoningEffort) {
    return {
      state: 'model-selection-off',
      toolName: target.toolName,
      reason: DELEGATION_MODEL_SELECTION_OFF_REASON,
      delegateAvailable: false
    };
  }
  return { state: 'ready', toolName: target.toolName, delegateAvailable: true };
}

/** What one detection pass observed and did. */
export interface DelegationHealthWatch {
  /** The current reading. */
  readonly health: DelegationHealth;
  /**
   * Re-read the live registry, warning once on a ready → broken transition.
   * @returns the new reading.
   */
  check(): DelegationHealth;
  /**
   * Forget that a tool was ever usable.
   *
   * Called when the deployment itself turned the capability off (the user
   * unticked the switch): the next activation of the tool must not be reported
   * as "it broke".
   */
  forget(): void;
}

/** Options of {@link watchDelegationHealth}. */
export interface DelegationHealthWatchOptions {
  /** Live registry read. */
  readonly read: () => DelegationHealth;
  /** Warning sink; called at most once per ready → broken transition. */
  readonly warn?: (message: string) => void;
  /** Called after a reading that changed the answer the surface should show. */
  readonly onChange?: (health: DelegationHealth) => void;
}

/**
 * Build the watch a tool surface keeps beside its reconcile callback.
 *
 * The transition discipline is the whole behaviour: a Host that *never* exposed
 * the capability (a headless embedder, a deployment with `modelSelection` off
 * from the start) is not an error and must not warn — it is simply not offered.
 * Only a capability that was observably working and then stopped is reported.
 *
 * An `unknown` reading neither warns nor counts as an episode: it is the absence
 * of evidence, and "we did not look" must not read as "it broke".
 * @param options - the live read, a warning sink, and a change observer.
 * @returns the watch, with its current reading.
 */
export function watchDelegationHealth(options: DelegationHealthWatchOptions): DelegationHealthWatch {
  let current = options.read();
  /** Whether this watch has ever seen the wrapper usable. */
  let wasAvailable = current.delegateAvailable;
  /** Whether the withdrawal has already been reported for this episode. */
  let reported = false;

  const observe = (next: DelegationHealth): DelegationHealth => {
    const changed = next.state !== current.state;
    current = next;
    if (next.delegateAvailable) {
      wasAvailable = true;
      reported = false;
    } else if (wasAvailable && !reported && next.state === 'model-selection-off') {
      // One warning per episode: a registry that churns must not flood the log,
      // which is what makes the single line worth reading.
      reported = true;
      options.warn?.(DELEGATION_BROKEN_WARNING);
    }
    if (changed) options.onChange?.(next);
    return next;
  };

  return {
    get health(): DelegationHealth {
      return current;
    },
    check(): DelegationHealth {
      return observe(options.read());
    },
    forget(): void {
      wasAvailable = false;
      reported = false;
    }
  };
}
