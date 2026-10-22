import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';

/** Session-local, replayable evidence of an adaptive request's physical dispatch. */
export const ACTUAL_PROJECTION_KEY = 'reflexActual';
const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() });
const stateSchema = z.object({
  adaptive: z.boolean(),
  intent: routeSchema.nullable(),
  decision: routeSchema.nullable(),
  actual: routeSchema.nullable()
});
export type ActualState = z.infer<typeof stateSchema>;
const adaptive = (effort: unknown): boolean => effort === 'reflex' || effort === 'auto';

/** Only a matching request header corroborates a decision; selections invalidate stale evidence. */
export const actualProjection = {
  key: ACTUAL_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: (): ActualState => ({ adaptive: false, intent: null, decision: null, actual: null }),
  apply(state: ActualState, event: { type: string; data?: any }): ActualState {
    const data = event.data;
    if (event.type === 'model/selection') {
      const parsed = routeSchema.safeParse(data);
      if (!parsed.success) return state;
      return { adaptive: adaptive(data.reasoningEffort) || data.provider === 'reflex', intent: parsed.data, decision: null, actual: null };
    }
    if (event.type === 'plugin:dsh-reflex/effort') {
      // A fixed selection wins even if an older in-flight request reports late.
      if (state.intent !== null && !state.adaptive) return state;
      const parsed = routeSchema.safeParse({ provider: data?.provider, model: data?.model,
        ...(typeof data?.applied === 'string' ? { reasoningEffort: data.applied } : {}) });
      if (!parsed.success || parsed.data.provider === 'reflex') return state;
      return { ...state, adaptive: true, decision: parsed.data, actual: null };
    }
    if (event.type !== 'request/header') return state;
    const parsed = routeSchema.safeParse(data?.header?.config);
    if (!parsed.success) return state;
    const route = parsed.data;
    const decision = state.decision;
    const matches = decision !== null && route.provider === decision.provider && route.model === decision.model &&
      route.reasoningEffort === decision.reasoningEffort;
    // Unintercepted virtual headers and later fixed physical calls are not proof
    // that an older adaptive decision is still in force.
    const virtualDispatch = state.adaptive && state.intent?.provider === 'reflex' && route.provider !== 'reflex';
    return matches || virtualDispatch
      ? { ...state, actual: route }
      : { ...state, decision: null, actual: null };
  },
  wire: { viewSchema: stateSchema, view: (state: ActualState): ActualState => state }
};

/** Optional capability: do not park plugin activation on hosts without projections. */
export function installActualProjection(ctx: Context): void {
  const inject = (ctx as any).inject;
  if (typeof inject !== 'function') return;
  inject.call(ctx, ['sessionProjections'], (scope: any) => {
    scope.effect(() => scope.sessionProjections.register(actualProjection));
  });
}
