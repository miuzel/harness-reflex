/**
 * Host-side mounting of the Reflex settings panel routes.
 *
 * Kept apart from {@link applyReflex} for one reason: the panel is the only
 * part of this plugin that needs a Web server, and the plugin must stay fully
 * functional without one (stdio MCP hosts, tests, headless embeds). So the
 * routes are mounted through a *scoped* cordis injection — `ctx.inject(
 * ['webServer'], …)` — which simply never activates when the service is absent,
 * instead of adding `webServer` to the plugin's own `inject` list and stalling
 * every activation on a service a headless host will never provide.
 *
 * One panel per registrant context: a deployment may activate this plugin more
 * than once (different tool prefixes), but two families on the same paths would
 * fight over the same URLs, so the first activation owns the panel and later
 * ones are reported and ignored.
 *
 * @module dsh-reflex/panel-mount
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';

import { resolveApiKey, routingActive } from './config.js';
import { formatTargetName } from './router.js';
import type { ReflexRuntime } from './bridge.js';
import {
  buildPanelSnapshot,
  isPanelRequestAllowed,
  makePanelRoutes,
  type PanelPoolView,
  type PanelRuntimeFacts,
  type PanelSource
} from './panel-api.js';

/** Contexts that already mounted a panel; released when the activation disposes. */
const mounted = new WeakSet<object>();

/**
 * Project this activation's model pools onto the panel view.
 * @param runtime - the activation's runtime.
 * @returns one row per configured virtual model, in authored order.
 */
export function panelPools(runtime: ReflexRuntime): PanelPoolView[] {
  return runtime.modelRouter.modelIds.map((model) => ({
    model,
    entries: (runtime.modelRouter.poolFor(model) ?? []).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.tags === undefined ? {} : { tags: [...entry.tags] })
    }))
  }));
}

/**
 * Gather one activation's live facts.
 *
 * Read fresh on every request rather than cached: the ledger grows between
 * polls, and a settings write re-resolves the config, so a cached snapshot would
 * be the one thing the panel must never show.
 * @param runtime - the activation's runtime.
 * @param env - environment the API-key indirection reads.
 * @returns the facts {@link buildPanelSnapshot} projects.
 */
// In-memory cache for models populated asynchronously
const catalogCache = new Map<object, PanelRuntimeFacts['modelCatalog']>();

export function panelFacts(
  runtime: ReflexRuntime,
  env: Record<string, string | undefined> = process.env,
  ctx?: Context
): PanelRuntimeFacts {
  const cached = ctx ? catalogCache.get(ctx) : undefined;
  if (ctx && (!cached || cached.length === 0 || cached.every(g => g.models.length === 0))) {
    // Background async fetch so panelFacts remains synchronous
    (async () => {
      try {
        const llm = (ctx as any).get?.('llm');
        if (llm?.listProviders) {
          const providers = (await llm.listProviders()) ?? [];
          const list = (
            await Promise.all(
              providers.map(async (p: any) => {
                const pid = typeof p === 'string' ? p : (p?.id ?? p);
                const pname = typeof p === 'string' ? p : (p?.name ?? pid);
                if (pid === runtime.config.routing.virtualProvider) return null;
                let models: any[] = [];
                try {
                  models = (await llm.listModels?.(pid)) ?? [];
                } catch {}
                return {
                  id: pid,
                  name: pname,
                  models: models.map((m: any) => ({
                    id: typeof m === 'string' ? m : m.id,
                    name: typeof m === 'string' ? m : (m.name ?? m.id)
                  }))
                };
              })
            )
          ).filter(Boolean);
          if (list.length > 0) catalogCache.set(ctx, list);
        }
      } catch (err: any) {}
    })();
  }

  const modelCatalog = ctx ? catalogCache.get(ctx) : undefined;

  const systemOneHealth = runtime.systemOneHealth();
  // `panelPools` and the fallback read the router, whose policy is live: the
  // loader commits a routing edit without remounting the plugin, so what the
  // panel reports is the value the next request will actually use.
  const pools = panelPools(runtime);
  const fallback = runtime.modelRouter.fallback;

  return {
    // `effectiveConfig` reports activation-time values for blocks whose live
    // path is a separate slice, and the values currently in force for effort and
    // interventions: a settings save changes those without a remount, so the
    // startup snapshot would be exactly the stale value the panel must not show.
    config: runtime.effectiveConfig,
    backendName: runtime.backendName,
    pools,
    routingFallback: fallback === undefined ? null : formatTargetName(fallback),
    routingActive: routingActive(runtime.config),
    // Copied, not aliased: the runtime republishes its surface on every
    // `tools/change`, and a snapshot must not follow it after the fact.
    toolSurface: [...runtime.toolSurface],
    ledger: runtime.ledger,
    effort: runtime.effortStatusFeed.latest(),
    apiKeyPresent: resolveApiKey(runtime.config.systemOne, env) !== undefined,
    ...(systemOneHealth === undefined ? {} : { systemOneHealth }),
    ...(modelCatalog === undefined ? {} : { modelCatalog })
  };
}

/** Shape of the optional pairing service, as far as this plugin depends on it. */
interface PairingService {
  isPairedDevice(request: IncomingMessage): boolean;
}

/**
 * Read the optional `remoteWebUiPairing` service.
 * @param ctx - any context in the registrant's tree.
 * @returns the service, or `undefined` when the deployment has no pairing.
 */
function pairingOf(ctx: Context): PairingService | undefined {
  const get = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  let value: unknown;
  try {
    value = get.call(ctx, 'remoteWebUiPairing', false);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PairingService>;
  return typeof candidate.isPairedDevice === 'function' ? (candidate as PairingService) : undefined;
}

/**
 * Build the live source the panel routes answer from.
 * @param ctx - the registrant context, used only for the optional pairing check.
 * @param runtime - the activation's runtime.
 * @param env - environment the API-key indirection reads.
 * @returns the source {@link makePanelRoutes} serves.
 */
export function createPanelSource(
  ctx: Context,
  runtime: ReflexRuntime,
  env: Record<string, string | undefined> = process.env
): PanelSource {
  const pairing = pairingOf(ctx);
  return {
    allows: (request) =>
      isPanelRequestAllowed(request, {
        isPaired: pairing === undefined ? undefined : (candidate) => pairing.isPairedDevice(candidate)
      }),
    snapshot: (limit) => buildPanelSnapshot(panelFacts(runtime, env, ctx), limit),
    clearLedger: () => {
      const cleared = runtime.ledger.getEntries().length;
      runtime.ledger.clear();
      return cleared;
    }
  };
}

/**
 * Mount the panel routes for one activation, if this Host serves HTTP.
 *
 * @param ctx - the registrant context.
 * @param runtime - the activation's runtime.
 * @returns a disposer that releases this activation's panel ownership.
 */
export function mountReflexPanel(ctx: Context, runtime: ReflexRuntime): () => void {
  const inject = (ctx as { inject?: unknown }).inject;
  if (typeof inject !== 'function') return () => {};
  if (mounted.has(ctx)) {
    ctx.logger?.('dsh-reflex')?.warn('the reflex settings panel is already mounted on this context; the first activation owns it');
    return () => {};
  }
  mounted.add(ctx);

  ctx.inject(['webServer'], (scope: any) => {
    scope.effect(() => {
      const source = createPanelSource(scope, runtime);
      const disposers = makePanelRoutes(source).map((route) => scope.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'reflex panel routes');
  });

  return () => {
    mounted.delete(ctx);
  };
}
