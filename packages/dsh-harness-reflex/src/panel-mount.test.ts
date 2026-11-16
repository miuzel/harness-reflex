import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';

import { ReflexRuntime } from './bridge.js';
import { resolveConfig, type ReflexConfig } from './config.js';
import { PANEL_ROUTES, buildPanelSnapshot, type PanelSource } from './panel-api.js';
import { createPanelSource, mountReflexPanel, panelFacts, panelPools } from './panel-mount.js';

/**
 * Host-side mounting: which facts reach the panel, who may read them, and when
 * the routes are actually registered on a Web server. The mount runs through a
 * scoped injection, so this suite drives a fake cordis context rather than a
 * server: what matters is that a Host without `webServer` is unaffected and a
 * second activation cannot claim the same URLs.
 */

const AUTHORED: ReflexConfig = {
  backend: 'auto',
  routing: {
    enabled: true,
    virtualProvider: 'reflex',
    fallback: 'deepseek:deepseek-chat',
    maxTaskChars: 400,
    models: {
      'reflex-pro': [
        { provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] },
        { provider: 'moonshot', model: 'kimi-k2' }
      ],
      'reflex-lite': [{ provider: 'deepseek', model: 'deepseek-chat' }]
    }
  },
  effort: { reasoningEffort: 'reflex', fallback: 'low', minConfidence: 0.3 },
  systemOne: { apiKeyEnv: 'REFLEX_MOUNT_KEY' }
};

/** A live runtime on the given authored config. */
function runtimeOf(authored: ReflexConfig = AUTHORED): ReflexRuntime {
  return new ReflexRuntime(resolveConfig(authored));
}

/** A request stub carrying only the socket the fence reads. */
function request(remoteAddress = '127.0.0.1'): IncomingMessage {
  return { method: 'GET', url: PANEL_ROUTES.snapshot, headers: {}, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** The handler `WebRoute` carries, narrowed to what a fake server must supply. */
type PanelHandler = (
  request: IncomingMessage,
  response: { writeHead(status: number, headers?: Record<string, string>): unknown; end(chunk?: string): unknown }
) => void;

/** One route the mount registered, with the handler the server would call. */
interface RegisteredRoute {
  kind: string;
  path: string;
  handler: PanelHandler;
}

/** What one fake context recorded. */
interface FakeContext {
  ctx: Context;
  injections: string[][];
  effects: string[];
  routes: RegisteredRoute[];
  disposed: string[];
  warnings: string[];
  /** Run the scope callbacks the mount registered. */
  activate(): void;
  /** Release everything the mount registered. */
  deactivate(): void;
}

/** A context with just enough cordis surface for the mount. */
function fakeContext(options: { inject?: boolean; pairing?: unknown; pairingThrows?: boolean } = {}): FakeContext {
  const injections: string[][] = [];
  const effects: string[] = [];
  const routes: RegisteredRoute[] = [];
  const disposed: string[] = [];
  const warnings: string[] = [];
  const pending: (() => void)[] = [];
  const teardowns: (() => void)[] = [];

  const scope = {
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.push(route);
        return () => {
          disposed.push(route.path);
        };
      }
    },
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '');
      const teardown = callback();
      if (typeof teardown === 'function') teardowns.push(teardown as () => void);
      return teardown;
    }
  };

  const ctx: Record<string, unknown> = {
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
    get: (name: string) => {
      if (options.pairingThrows === true) throw new Error('service tree unavailable');
      return name === 'remoteWebUiPairing' ? options.pairing : undefined;
    }
  };
  if (options.inject !== false) {
    ctx.inject = (names: string[], callback: (scope: unknown) => void) => {
      injections.push(names);
      pending.push(() => callback(scope));
    };
  }

  return {
    ctx: ctx as unknown as Context,
    injections,
    effects,
    routes,
    disposed,
    warnings,
    activate: () => {
      for (const run of pending.splice(0)) run();
    },
    deactivate: () => {
      for (const teardown of teardowns.splice(0)) teardown();
    }
  };
}

//#region facts

test('the pool view mirrors the authored models in authored order', () => {
  const pools = panelPools(runtimeOf());
  assert.deepEqual(
    pools.map((pool) => pool.model),
    ['reflex-pro', 'reflex-lite']
  );
  assert.deepEqual(pools[0], {
    model: 'reflex-pro',
    entries: [
      { provider: 'deepseek', model: 'deepseek-chat', description: 'fast', tags: ['cheap'] },
      { provider: 'moonshot', model: 'kimi-k2' }
    ]
  });
});

test('the pool view is detached from the runtime', () => {
  const runtime = runtimeOf();
  const pools = panelPools(runtime);
  pools[0]?.entries[0]?.tags?.push('mutated');
  assert.deepEqual(runtime.modelRouter.poolFor('reflex-pro')?.[0]?.tags, ['cheap']);
});

test('the api key is reported as a presence flag derived from the environment', () => {
  const runtime = runtimeOf();
  assert.equal(panelFacts(runtime, {}).apiKeyPresent, false);
  assert.equal(panelFacts(runtime, { REFLEX_MOUNT_KEY: 'sk-live' }).apiKeyPresent, true);
  // An empty variable is not a key.
  assert.equal(panelFacts(runtime, { REFLEX_MOUNT_KEY: '' }).apiKeyPresent, false);
  const facts = panelFacts(runtime, { REFLEX_MOUNT_KEY: 'sk-live' });
  assert.equal(JSON.stringify(facts).includes('sk-live'), false, 'the facts carry the key itself');
});

test('the facts follow the runtime as it changes', () => {
  const runtime = runtimeOf();
  const before = panelFacts(runtime).ledger.getEntries().length;
  runtime.ledger.record({ type: 'gate', backend: 'auto', latencyMs: 3, passed: true });
  assert.equal(panelFacts(runtime).ledger.getEntries().length, before + 1, 'facts must be read fresh, not cached');
});

//#endregion

//#region source

test('the source answers the loopback peer and refuses anyone else', () => {
  const context = fakeContext();
  const source = createPanelSource(context.ctx, runtimeOf(), {});
  assert.equal(source.allows(request()), true);
  assert.equal(source.allows(request('192.168.0.20')), false);
});

test('a pairing service opens the door for a recognised device only', () => {
  const seen: string[] = [];
  const pairing = {
    isPairedDevice: (incoming: IncomingMessage) => {
      seen.push(String(incoming.socket.remoteAddress));
      return true;
    }
  };
  const source = createPanelSource(fakeContext({ pairing }).ctx, runtimeOf(), {});
  assert.equal(source.allows(request('10.1.2.3')), true);
  assert.deepEqual(seen, ['10.1.2.3']);

  const deny = createPanelSource(fakeContext({ pairing: { isPairedDevice: () => false } }).ctx, runtimeOf(), {});
  assert.equal(deny.allows(request('10.1.2.3')), false);
});

test('an unusable pairing service fails closed', () => {
  const throwing = {
    isPairedDevice: () => {
      throw new Error('pairing store offline');
    }
  };
  assert.equal(createPanelSource(fakeContext({ pairing: throwing }).ctx, runtimeOf(), {}).allows(request('10.1.2.3')), false);
  // A context whose service tree itself throws has no pairing, i.e. loopback only.
  const broken = createPanelSource(fakeContext({ pairingThrows: true }).ctx, runtimeOf(), {});
  assert.equal(broken.allows(request('10.1.2.3')), false);
  assert.equal(broken.allows(request()), true);
  // A service that is not a pairing service is ignored rather than trusted.
  const wrong = createPanelSource(fakeContext({ pairing: { other: () => true } }).ctx, runtimeOf(), {});
  assert.equal(wrong.allows(request('10.1.2.3')), false);
});

test('the source projects the live ledger and clears it on request', () => {
  const runtime = runtimeOf();
  runtime.ledger.record({ type: 'gate', backend: 'auto', latencyMs: 3, passed: true });
  runtime.ledger.record({ type: 'model-route', backend: 'auto', latencyMs: 4 });
  const source: PanelSource = createPanelSource(fakeContext().ctx, runtime, {});

  const snapshot = source.snapshot(10);
  assert.equal(snapshot.ledger.recent.length, 2);
  assert.equal(snapshot.routing.candidates, 3);

  assert.equal(source.clearLedger(), 2);
  assert.equal(source.snapshot(10).ledger.recent.length, 0, 'clearing did not take effect');
  assert.equal(source.clearLedger(), 0, 'clearing an empty ledger must still be a no-op, not an error');
});

//#endregion

//#region mount

test('a context without scoped injection stays unmounted and unaffected', () => {
  const context = fakeContext({ inject: false });
  const dispose = mountReflexPanel(context.ctx, runtimeOf());
  assert.deepEqual(context.injections, []);
  assert.deepEqual(context.routes, []);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('the mount registers the route family on the Web server only when it exists', () => {
  const context = fakeContext();
  const dispose = mountReflexPanel(context.ctx, runtimeOf());
  assert.deepEqual(context.injections, [['webServer']], 'the panel must depend on webServer through a scoped injection');
  assert.equal(context.routes.length, 0, 'routes were registered before the service was available');

  context.activate();
  assert.deepEqual(context.effects, ['reflex panel routes']);
  assert.deepEqual(context.routes.map((route) => route.path), [
    PANEL_ROUTES.snapshot,
    PANEL_ROUTES.health,
    PANEL_ROUTES.clearLedger,
    PANEL_ROUTES.delegation,
    PANEL_ROUTES.systemOneTest
  ]);
  assert.deepEqual([...new Set(context.routes.map((route) => route.kind))], ['exact']);

  context.deactivate();
  assert.deepEqual(context.disposed, [
    PANEL_ROUTES.snapshot,
    PANEL_ROUTES.health,
    PANEL_ROUTES.clearLedger,
    PANEL_ROUTES.delegation,
    PANEL_ROUTES.systemOneTest
  ]);
  dispose();
});

test('a registered route answers from the activation it was mounted for', async () => {
  const runtime = runtimeOf();
  runtime.ledger.record({ type: 'model-route', backend: 'auto', latencyMs: 4, tokensSaved: 128 });
  const context = fakeContext();
  mountReflexPanel(context.ctx, runtime);
  context.activate();

  const snapshotRoute = context.routes.find((route) => route.path === PANEL_ROUTES.snapshot);
  assert.ok(snapshotRoute !== undefined);
  const written: { status: number; body: string } = { status: 0, body: '' };
  snapshotRoute.handler(request(), {
    writeHead: (status: number) => {
      written.status = status;
    },
    end: (chunk?: string) => {
      written.body = chunk ?? '';
    }
  } as never);
  // The handler dispatches through the async resolver, so let a microtask turn.
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

  assert.equal(written.status, 200);
  const body = JSON.parse(written.body) as { routing: { candidates: number }; ledger: { recent: { tokensSaved?: number }[] } };
  assert.equal(body.routing.candidates, 3);
  assert.deepEqual(body.ledger.recent.map((row) => row.tokensSaved), [128]);

  // The same route refuses a peer the fence does not recognise.
  const refused: { status: number } = { status: 0 };
  snapshotRoute.handler(request('10.9.9.9'), {
    writeHead: (status: number) => {
      refused.status = status;
    },
    end: () => undefined
  } as never);
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(refused.status, 403);
});

test('one activation owns the panel and a second is reported and ignored', () => {
  const context = fakeContext();
  const first = mountReflexPanel(context.ctx, runtimeOf());
  const second = mountReflexPanel(context.ctx, runtimeOf());
  assert.equal(context.injections.length, 1, 'the second activation opened a second panel');
  assert.deepEqual(context.warnings, ['the reflex settings panel is already mounted on this context; the first activation owns it']);
  context.activate();
  assert.deepEqual(
    context.routes.map((route) => route.path),
    [PANEL_ROUTES.snapshot, PANEL_ROUTES.health, PANEL_ROUTES.clearLedger, PANEL_ROUTES.delegation, PANEL_ROUTES.systemOneTest],
    'the second activation registered routes'
  );

  // Ownership is released with the first activation, so a later one may mount.
  first();
  second();
  const third = mountReflexPanel(context.ctx, runtimeOf());
  assert.equal(context.injections.length, 2);
  third();
});

//#endregion

//#region cordis-like contexts (missing-inject reads throw)

/**
 * A context that behaves the way a **real** cordis context does on a service the
 * plugin does not `inject`.
 *
 * This is the regression this suite existed to miss. Every other fake context in
 * this file is a plain object, where `ctx.agents` answers `undefined` and nothing
 * can fail. Cordis' context proxy instead *throws* `cannot get property "agents"
 * without inject` for an uninjected service — so `?.` and any `try` that wraps
 * only the *calls* leave the failing read unguarded. The panel then threw inside
 * `snapshot`, the Host mapped it onto an empty `400`, and the panel was
 * unopenable on the machine it shipped to.
 *
 * The trap is deliberately faithful: symbols and `_`-prefixed names are the ones
 * cordis itself treats as special (see `isSpecialProperty`), and everything else
 * is a service read that must be declared.
 */
function cordisLikeContext(services: Record<string, unknown> = {}): Context {
  const own = {
    // The reflection form reads the service store without the inject
    // requirement — this is what makes an optional service readable at all.
    get: (name: string): unknown => services[name]
  };
  return new Proxy(own, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (prop.startsWith('_')) return undefined;
      throw new Error(`cannot get property "${prop}" without inject`);
    }
  }) as unknown as Context;
}

test('a context that throws on an uninjected `agents` read still yields facts', () => {
  const runtime = runtimeOf();
  const context = cordisLikeContext();

  // The premise: the read this function used to perform really does throw here.
  assert.throws(
    () => (context as unknown as { agents?: unknown }).agents,
    /cannot get property "agents" without inject/
  );

  // And the panel path must survive it end to end.
  const facts = panelFacts(runtime, {}, context);
  assert.equal(facts.delegationHealth, undefined, 'no reading is attached to this runtime');
  const snapshot = buildPanelSnapshot(facts);
  assert.equal(snapshot.delegation.state, 'unknown', 'a missing agents service must read as unknown, not as a fault');
  assert.notEqual(snapshot.delegation.state, 'missing-tool');
  assert.notEqual(snapshot.delegation.state, 'model-selection-off');
});

test('the throwing context does not merely fail soft: the same snapshot is served', () => {
  // Guards against a fix that swallows the read but also loses the rest of the
  // payload — the panel is worthless if it answers 200 with half a body.
  const runtime = runtimeOf();
  const plain = buildPanelSnapshot(panelFacts(runtimeOf(), {}));
  const snapshot = buildPanelSnapshot(panelFacts(runtime, {}, cordisLikeContext()));
  assert.equal(snapshot.routing.candidates, 3);
  assert.equal(snapshot.routing.pools.length, plain.routing.pools.length);
  assert.equal(snapshot.delegation.enabled, false);
  assert.equal(typeof snapshot.delegation.registered, 'boolean');
});

test('the scope is read through ctx.get when the host exposes it', () => {
  const runtime = runtimeOf();
  const agent = { id: 'live-agent' } as never;
  const services = {
    agents: {
      list: () => [agent],
      roots: () => {
        throw new Error('roots must not be consulted while a live agent exists');
      }
    }
  };
  // A cordis-like context whose `agents` property would throw: only `get` may
  // be used, so a working read here proves the reflection form is preferred.
  const context = cordisLikeContext(services);
  const notes: unknown[] = [];
  runtime.attachDelegationScope((scope) => {
    notes.push(scope);
  });

  panelFacts(runtime, {}, context);
  assert.deepEqual(notes, [agent], 'the live agent from ctx.get was not used as the delegation scope');
});

test('the scope falls back to the property read when the context has no get', () => {
  const runtime = runtimeOf();
  const agent = { id: 'via-property' } as never;
  // A plain-object host: no reflection layer, the service on the property path.
  const context = { agents: { list: () => [agent] } } as unknown as Context;
  const notes: unknown[] = [];
  runtime.attachDelegationScope((scope) => {
    notes.push(scope);
  });

  panelFacts(runtime, {}, context);
  assert.deepEqual(notes, [agent], 'the property fallback must still find the registry');
});

test('the scope falls back to root agents when no live agent exists', () => {
  const runtime = runtimeOf();
  const root = { id: 'root-agent' } as never;
  const context = { agents: { list: () => [], roots: () => [root] } } as unknown as Context;
  const notes: unknown[] = [];
  runtime.attachDelegationScope((scope) => {
    notes.push(scope);
  });

  panelFacts(runtime, {}, context);
  assert.deepEqual(notes, [root]);
});

test('an unreadable registry is reported as no scope, never as a throw', () => {
  const runtime = runtimeOf();
  const poisoned = [
    { agents: { list: () => { throw new Error('registry closing'); } } },
    { agents: { list: () => [], roots: () => { throw new Error('registry closing'); } } },
    // A host whose `get` itself throws must not take the panel with it.
    { get: () => { throw new Error('service tree unavailable'); } }
  ] as unknown as Context[];
  for (const context of poisoned) {
    const notes: unknown[] = [];
    runtime.attachDelegationScope((scope) => {
      notes.push(scope);
    });
    assert.doesNotThrow(() => panelFacts(runtime, {}, context));
    assert.deepEqual(notes, [], 'an unreadable registry must not be mistaken for a live scope');
  }

  // A registry whose callbacks are not functions, and a null service, are both
  // "no scope" rather than crashes.
  for (const context of [{ agents: {} }, { agents: null }, { get: () => null }] as unknown as Context[]) {
    assert.doesNotThrow(() => panelFacts(runtimeOf(), {}, context));
  }
});

//#endregion
