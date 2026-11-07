import type { Context } from '@deepseek-ai/cordis';

import { inspectDelegationTool } from './delegation-dispatch.js';

/**
 * Runtime detection of a *broken* delegation capability.
 *
 * `reflex_delegate` is only registered while the Host's delegation tool declares
 * `reasoning_effort` (i.e. while `modelSelection` is on). That declaration is
 * read from the live tool registry, and the registry can change under a running
 * activation: a reload of the `tool-subagent` row, a patch edit picked up by the
 * loader, or a Host that replaces the tool.
 *
 * What the plugin may do about that is deliberately narrow, and the boundary is
 * the point of this module:
 *
 * - it **withdraws** `reflex_delegate` from the enabled set at runtime, so a
 *   model never sees a tool whose every call could not carry a level;
 * - it **warns** once per failure, with the reason a person can act on;
 * - it **reads** the profile patch to say whether the user's own file still
 *   asks for the field.
 *
 * It never writes configuration in response. A patch that stops asking for
 * `modelSelection` is indistinguishable from a user who deliberately turned it
 * back off, and turning a user's switch back on is exactly the boundary the goal
 * forbids. Re-enabling is a user action: tick the switch again, which is a fresh
 * consent and a fresh write.
 *
 * @module dsh-reflex/delegation-health
 */

/** Why the delegate capability is (or is not) usable right now. */
export type DelegationHealthState =
  /** The Host delegation tool declares `reasoning_effort`; the wrapper works. */
  | 'ready'
  /** The Host exposes no delegation tool at all. */
  | 'missing-tool'
  /** The Host delegation tool exists but cannot carry a reasoning level. */
  | 'model-selection-off';

/** One reading of the live Host, plus the consequence for this activation. */
export interface DelegationHealth {
  /** What the live registry says. */
  state: DelegationHealthState;
  /** Registered name of the Host delegation tool, when one exists. */
  toolName?: string;
  /** One-line reason, present whenever the state is not `ready`. */
  reason?: string;
  /** Whether `reflex_delegate` may be registered / kept registered. */
  delegateAvailable: boolean;
}

/** The log line emitted when a previously working delegation stops working. */
export const DELEGATION_BROKEN_WARNING =
  'dsh-reflex: reflex_delegate was withdrawn at runtime because the subagent tool no longer declares reasoning_effort (modelSelection is off again). ' +
  'The reasoning level a delegation needs cannot be passed to the child. ' +
  'Nothing in your configuration was changed: re-tick "Delegation" in the Reflex settings after restarting DSH, and the level is passed again.';

/** The reason shown on the panel when the capability is not usable. */
export const DELEGATION_MODEL_SELECTION_OFF_REASON =
  'The host subagent tool no longer declares reasoning_effort, so a decided level cannot reach the child. reflex_delegate has been withdrawn; tick Delegation again to write the host modelSelection switch (takes effect after a DSH restart).';

/** The panel reason when there is no Host delegation tool at all. */
export const DELEGATION_TOOL_MISSING_REASON =
  'This host exposes no subagent tool, so there is nothing for reflex_delegate to wrap.';

/**
 * Read the live delegation capability of one Host context.
 * @param ctx - a context whose `tools` registry is live.
 * @returns the state, its reason, and whether the delegate may be registered.
 */
export function readDelegationHealth(ctx: Context): DelegationHealth {
  const target = inspectDelegationTool(ctx);
  if (target === undefined) {
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
 * Only a capability that was observably working and then stopped is reported, and
 * reported through every surface (log, panel reason, withdrawn registration).
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
