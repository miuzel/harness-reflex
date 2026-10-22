import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';

import { ReflexRuntime } from './bridge.js';
import { resolveConfig, type ReflexConfig } from './config.js';
import { PANEL_ROUTES, type PanelSource } from './panel-api.js';
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
  assert.deepEqual(context.routes.map((route) => route.path), [PANEL_ROUTES.snapshot, PANEL_ROUTES.health, PANEL_ROUTES.clearLedger]);
  assert.deepEqual([...new Set(context.routes.map((route) => route.kind))], ['exact']);

  context.deactivate();
  assert.deepEqual(context.disposed, [PANEL_ROUTES.snapshot, PANEL_ROUTES.health, PANEL_ROUTES.clearLedger]);
  dispose();
});

test('a registered route answers from the activation it was mounted for', () => {
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
  });

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
  });
  assert.equal(refused.status, 403);
});

test('one activation owns the panel and a second is reported and ignored', () => {
  const context = fakeContext();
  const first = mountReflexPanel(context.ctx, runtimeOf());
  const second = mountReflexPanel(context.ctx, runtimeOf());
  assert.equal(context.injections.length, 1, 'the second activation opened a second panel');
  assert.deepEqual(context.warnings, ['the reflex settings panel is already mounted on this context; the first activation owns it']);
  context.activate();
  assert.deepEqual(context.routes.map((route) => route.path), [PANEL_ROUTES.snapshot, PANEL_ROUTES.health, PANEL_ROUTES.clearLedger], 'the second activation registered routes');

  // Ownership is released with the first activation, so a later one may mount.
  first();
  second();
  const third = mountReflexPanel(context.ctx, runtimeOf());
  assert.equal(context.injections.length, 2);
  third();
});

//#endregion
