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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';

import {
  connectionTarget,
  resolveApiKeyWithSource,
  routingActive,
  type ResolvedSystemOneConfig
} from './config.js';
import { enableHostModelSelection, inspectHostModelSelection, type HostPatchOptions } from './host-patch.js';
import { formatTargetName } from './router.js';
import type { ReflexRuntime } from './bridge.js';
import {
  buildPanelSnapshot,
  isPanelRequestAllowed,
  makePanelRoutes,
  type PanelPoolView,
  type PanelProbeAnswer,
  type PanelRuntimeFacts,
  type PanelSource
} from './panel-api.js';
import { probeSystemOne } from './systemone-probe.js';
import type { DelegationHealthState } from './delegation-health.js';

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
  ctx?: Context,
  hostPatch?: HostPatchOptions
): PanelRuntimeFacts {
  // Tell the lifecycle which scope to read the delegation capability in. A
  // preset-hosted `subagent` is invisible from the registry's global view, so a
  // panel that probes without a scope reports "unknown" forever on a host whose
  // delegation is perfectly configured. A live agent (or, before any exists, a
  // live preset) is the scope a session would actually be served from.
  const scope = delegationScopeOf(ctx);
  if (scope !== undefined) runtime.noteDelegationScope(scope);

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
                if (pid === effective.routing.virtualProvider) return null;
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

  // One read of the live projection: it also lazily applies a committed
  // config-only save, so a poll right after the panel's own write already shows
  // the new values instead of the previous activation snapshot.
  const effective = runtime.effectiveConfig;
  const systemOneHealth = runtime.systemOneHealth();
  // `panelPools` and the fallback read the router, whose policy is live: the
  // loader commits a routing edit without remounting the plugin, so what the
  // panel reports is the value the next request will actually use.
  const pools = panelPools(runtime);
  const fallback = runtime.modelRouter.fallback;

  return {
    // `effectiveConfig` reports the values currently in force for every block a
    // config-only save can change (effort, interventions, tools, backend,
    // ledger sink, routing lifecycle): the startup snapshot would be exactly
    // the stale value the panel must not show.
    config: effective,
    backendName: runtime.backendName,
    pools,
    routingFallback: fallback === undefined ? null : formatTargetName(fallback),
    routingActive: routingActive(effective),
    // Copied, not aliased: the runtime republishes its surface on every
    // `tools/change`, and a snapshot must not follow it after the fact.
    toolSurface: [...runtime.toolSurface],
    ledger: runtime.ledger,
    effort: runtime.effortStatusFeed.latest(),
    // Resolved through the same function the backend construction and the probe
    // use, so "the panel says the env var is empty" can no longer contradict a
    // working backend: presence *and* provenance come from one chain.
    ...apiKeyFacts(effective.systemOne, env),
    // Presence only, per profile. Gathered here (and not by the projection) so
    // the one place that reads the environment is this file, and so the wire
    // projection is handed booleans rather than anything it could leak.
    profileKeys: profileKeyPresence(effective.systemOne, env),
    // Both are read on every poll: the registry can change under a running host,
    // and the patch file can be edited by a person while the panel is open. A
    // cached copy of either would be exactly the stale fact the panel must not
    // show.
    delegationHealth: delegationHealthOf(runtime),
    hostPatch: inspectHostModelSelection(hostPatch ?? { env }),
    ...(systemOneHealth === undefined ? {} : { systemOneHealth }),
    ...(modelCatalog === undefined ? {} : { modelCatalog })
  };
}

/**
 * Key readiness as the panel needs it: presence, provenance, and the *reason*
 * for an absence.
 *
 * `apiKeyLocked` is the fact g-059 added: the block **named** a variable and that
 * variable is empty. It is deliberately separate from plain
 * `apiKeyPresent === false`, which now means "nothing was named and nothing was
 * exported" — the two need different copy, and "the name I typed is empty" must
 * not read as "no key anywhere".
 *
 * The value is never part of this type: the facts are booleans, a source tag,
 * and a variable *name*.
 */
export interface ApiKeyFacts {
  /** Whether a key resolved. */
  apiKeyPresent: boolean;
  /** Where the key came from when {@link apiKeyPresent}. */
  apiKeySource?: 'profile' | 'env' | 'fallback';
  /**
   * The variable behind the key (when present), or the named-but-empty variable
   * (when locked). Absent only when nothing was named and nothing resolved.
   */
  apiKeyVariable?: string;
  /**
   * The block named a variable, that variable is empty, and the lookup stopped
   * there on purpose: no fallback was consulted and none will be.
   */
  apiKeyLocked?: boolean;
}

/**
 * The readiness facts the snapshot reports about the key in force.
 *
 * Presence and provenance are read from {@link resolveApiKeyWithSource} — the
 * one chain — so the panel can say *where* the key came from instead of guessing
 * from `apiKeyEnv`.
 *
 * @param systemOne - the connection block in force.
 * @param env - environment the chain reads.
 * @returns the presence/provenance facts for the snapshot.
 */
export function apiKeyFacts(
  systemOne: Pick<ResolvedSystemOneConfig, 'apiKey' | 'apiKeyEnv'>,
  env: Record<string, string | undefined> = process.env
): ApiKeyFacts {
  const resolved = resolveApiKeyWithSource(systemOne, env);
  if (resolved === undefined) return { apiKeyPresent: false };
  if (!('key' in resolved)) {
    return { apiKeyPresent: false, apiKeyLocked: true, apiKeyVariable: resolved.variable };
  }
  return {
    apiKeyPresent: true,
    apiKeySource: resolved.source,
    ...(resolved.variable === undefined ? {} : { apiKeyVariable: resolved.variable })
  };
}

/**
 * Gather key *presence* and provenance for every authored profile.
 *
 * Returns facts and nothing else: the panel renders a placeholder from
 * `present` and never needs the value. `fromProfile` distinguishes a key stored in
 * the settings document from one read out of the environment, and `variable`
 * names the variable that supplied it — still without the value. Each row goes
 * through {@link resolveApiKeyWithSource}, so a profile inheriting a fallback
 * variable is reported the same way the backend would resolve it.
 *
 * @param systemOne - the connection block in force.
 * @param env - environment the chain reads.
 * @returns one presence record per profile name.
 */
export function profileKeyPresence(
  systemOne: Pick<ResolvedSystemOneConfig, 'profiles'>,
  env: Record<string, string | undefined> = process.env
): Record<string, { present: boolean; fromProfile: boolean; variable?: string; locked?: boolean }> {
  const out: Record<string, { present: boolean; fromProfile: boolean; variable?: string; locked?: boolean }> = {};
  for (const [name, profile] of Object.entries(systemOne.profiles ?? {})) {
    // The profile's own fields, with no flat block folded in: a row reports what
    // *it* supplies, and the panel already shows the flat block's own status.
    const resolved = resolveApiKeyWithSource(profile, env);
    // `locked` mirrors {@link ApiKeyFacts.apiKeyLocked}: the row named a variable
    // that is empty, so the row says so instead of "no key anywhere".
    const present = resolved !== undefined && 'key' in resolved;
    out[name] = {
      present,
      fromProfile: present && resolved.source === 'profile',
      ...(resolved?.variable === undefined ? {} : { variable: resolved.variable }),
      ...(present ? {} : { locked: resolved !== undefined })
    };
  }
  return out;
}

/**
 * Build the probe the test route calls for one profile name.
 *
 * Reads the profile out of the *live* configuration on every call, so a test
 * started right after a save probes what was just saved. The key is handed to
 * {@link probeSystemOne} and never leaves this process.
 *
 * @param runtime - the activation's runtime.
 * @param env - environment the `apiKeyEnv` indirection reads.
 * @returns the probe callback the panel source exposes.
 */
export function createSystemOneProbe(
  runtime: ReflexRuntime,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): (profile: string | undefined, signal: AbortSignal) => Promise<PanelProbeAnswer> {
  return async (profile, signal) => {
    const effective = runtime.effectiveConfig.systemOne;
    // Only a profile names a connection (g-066). There is no block to fold in
    // and, crucially, no "probe the active one" for an invocation that names
    // nothing: `active` is what the runtime uses, so it is what the test has to
    // use too, and when there is no active profile there is nothing to test.
    const name = profile ?? effective.active;
    if (name === undefined || name.length === 0) {
      // An unnamed probe used to test whatever the flat block said, which is the
      // implicit connection this goal removes. Say why nothing was tested.
      return {
        ok: false,
        status: 'misconfigured',
        latencyMs: 0,
        profile: null,
        detail: `no active profile is selected (${effective.unconfigured ?? 'unconfigured'}); activate a connection first`
      };
    }
    const targetProfile = effective.profiles?.[name];
    if (targetProfile === undefined) {
      // Naming a profile that does not exist is a caller error, not a connection
      // failure: say so instead of probing something else under a wrong label.
      return { ok: false, status: 'misconfigured', latencyMs: 0, profile: name, detail: `no profile named "${name}" is configured` };
    }
    // The same projection the runtime uses, including the profile's *selected*
    // model: testing a connection tests the request the next decision sends.
    const target = connectionTarget(effective, name, targetProfile);
    const result = await probeSystemOne(target, { env, signal, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
    return {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      profile: name ?? null,
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.endpoint === undefined ? {} : { endpoint: result.endpoint })
    };
  };
}

/**
 * The scope a delegation-capability read should use, when one is available.
 *
 * Prefers a live agent: that is the scope whose view actually serves a session's
 * tool calls. Falls back to the root agent, then to a live preset (the scope a
 * fresh session would be composed from). `undefined` when the host exposes
 * neither — the reading is then `unknown`, which is honest, rather than a global
 * view that a preset-hosted tool can never appear in.
 *
 * ## Why the whole read sits inside one `try` (and why `get` comes first)
 *
 * On a real cordis context a missing `inject` entry does not read as
 * `undefined`: the context proxy *throws* `cannot get property "agents" without
 * inject`. This plugin deliberately does not inject `agents` (a host without
 * that service must still activate the panel), so `ctx.agents` is precisely the
 * read that throws here — and a `try` wrapped around only the *calls* leaves the
 * failing read outside it. Optional chaining is no defence either: it guards
 * against `null`/`undefined`, not against a getter that throws.
 *
 * `ctx.get(name)` is the reflection form: it reads the service store without the
 * inject requirement and answers `undefined` when the service is absent. The
 * property form stays as a fallback for hosts that expose no `get` (and for the
 * plain-object contexts tests build) — inside the same `try`, because on cordis
 * it is the throwing form.
 *
 * @param ctx - any context carrying the agent registry, when the host has one.
 * @returns a readable scope, or `undefined` when nothing can be read as.
 */
function delegationScopeOf(ctx: Context | undefined): Agent | undefined {
  try {
    const holder = ctx as { get?: (name: string) => unknown; agents?: unknown } | undefined;
    if (holder === undefined || holder === null) return undefined;
    // `get` first: it cannot throw for an uninjected service. `??` then falls
    // back to the property form for hosts that do not expose `get` — that read
    // is the throwing one, which is why it stays inside this `try`.
    const registry = (holder.get?.('agents') ?? holder.agents) as
      | { list?: () => Agent[]; roots?: () => Agent[] }
      | undefined;
    if (registry === undefined || registry === null) return undefined;
    const live = typeof registry.list === 'function' ? registry.list() : [];
    if (Array.isArray(live) && live.length > 0) return live[0];
    const roots = typeof registry.roots === 'function' ? registry.roots() : [];
    if (Array.isArray(roots) && roots.length > 0) return roots[0];
  } catch {
    // Either the service is not injected (cordis throws on the property read) or
    // the registry is closing mid-read. Neither is a capability fault: report no
    // scope, which the panel shows as `unknown`, rather than pretend the host
    // turned the capability off.
    return undefined;
  }
  return undefined;
}

/**
 * The live delegation reading, reduced to what the projection carries.
 *
 * `undefined` — not a fabricated `missing-tool` — when this activation has no
 * reading attached: a runtime built without the plugin lifecycle (a test, an
 * embedder) must not be reported as a broken deployment.
 * @param runtime - the activation's runtime.
 * @returns the state and its reason, when one is known.
 */
function delegationHealthOf(runtime: ReflexRuntime): { state: DelegationHealthState; reason?: string } | undefined {
  const health = runtime.delegationHealth;
  if (health === undefined) return undefined;
  return { state: health.state, ...(health.reason === undefined ? {} : { reason: health.reason }) };
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
  env: Record<string, string | undefined> = process.env,
  hostPatch?: HostPatchOptions
): PanelSource {
  const pairing = pairingOf(ctx);
  return {
    allows: (request) =>
      isPanelRequestAllowed(request, {
        isPaired: pairing === undefined ? undefined : (candidate) => pairing.isPairedDevice(candidate)
      }),
    snapshot: (limit) => buildPanelSnapshot(panelFacts(runtime, env, ctx, hostPatch), limit),
    testSystemOne: createSystemOneProbe(runtime, env),
    clearLedger: () => {
      const cleared = runtime.ledger.getEntries().length;
      runtime.ledger.clear();
      return cleared;
    },
    // The one write outside this plugin's settings section. It is *not* a
    // reaction to a broken capability — it is the user's explicit consent, sent
    // from the toggle — and it never retries or repairs on its own.
    enableDelegation: () => {
      const result = enableHostModelSelection(hostPatch ?? { env });
      const wrote = result.outcome === 'added-field' || result.outcome === 'added-row' || result.outcome === 'added-field-after-name';
      return {
        outcome: result.outcome,
        ...(result.path === undefined ? {} : { path: result.path }),
        ...(result.source === undefined ? {} : { source: result.source }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
        // Only a real edit needs a restart; "already enabled" needs nothing.
        restartRequired: wrote
      };
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
export function mountReflexPanel(
  ctx: Context,
  runtime: ReflexRuntime,
  options: { hostPatch?: HostPatchOptions } = {}
): () => void {
  const inject = (ctx as { inject?: unknown }).inject;
  if (typeof inject !== 'function') return () => {};
  if (mounted.has(ctx)) {
    ctx.logger?.('dsh-reflex')?.warn('the reflex settings panel is already mounted on this context; the first activation owns it');
    return () => {};
  }
  mounted.add(ctx);

  ctx.inject(['webServer'], (scope: any) => {
    scope.effect(() => {
      const source = createPanelSource(scope, runtime, process.env, options.hostPatch);
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
