import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  ALLOWED_SEEDS,
  BUNDLE_RELATIVE_PATH,
  CLIENT_BUNDLE_ID,
  CLIENT_ENTRY_KEY,
  CLIENT_OUT_DIR,
  buildBundle,
  collectRequires,
  readSources,
  tokenize,
  verifyClientPackage,
  type BundleSource
} from './client-bundle.js';

/**
 * Coverage of the browser-half build: the comment/require scanner the purity
 * gate rests on, the bundler's refusal paths, and the committed artifact —
 * freshness, manifest agreement, and the module-table contract a real
 * `__ModuleLoader__` enforces.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const artifactPath = join(packageDir, BUNDLE_RELATIVE_PATH);

/** Two-module module set with one platform require. */
function sources(): BundleSource[] {
  return [
    { key: 'index', code: '"use strict";\nconst p = require("./panel");\nconst r = require("react");\nexports.answer = () => p.answer + (r ? 1 : 0);\n' },
    { key: 'panel', code: '"use strict";\nexports.answer = 41;\n' }
  ];
}

test('tokenize drops comments and keeps literals whole', () => {
  const kinds = (code: string): string[] => tokenize(code).map((token) => `${token.kind}:${token.value}`);
  assert.deepEqual(kinds('a // tail\nb'), ['name:a', 'name:b']);
  assert.deepEqual(kinds('a /* mid */ b'), ['name:a', 'name:b']);
  assert.deepEqual(kinds('const u = "http://x//y";'), ['name:const', 'name:u', 'punct:=', 'string:http://x//y', 'punct:;']);
  assert.deepEqual(kinds("x('a/*b*/c')"), ['name:x', 'punct:(', 'string:a/*b*/c', 'punct:)']);
  assert.deepEqual(kinds('e("a\\"//b")'), ['name:e', 'punct:(', 'string:a\\"//b', 'punct:)']);
  assert.deepEqual(kinds('/* unterminated'), []);
  assert.deepEqual(kinds('$x1_2'), ['name:$x1_2']);
});

test('collectRequires finds call-shaped specifiers only', () => {
  assert.deepEqual(collectRequires('require("react");'), ['react']);
  assert.deepEqual(collectRequires("require( './panel' );"), ['./panel']);
  assert.deepEqual(collectRequires('require("react");require("react");'), ['react']);
  assert.deepEqual(collectRequires('// require("ghost")\nrequire("react");'), ['react']);
  assert.deepEqual(collectRequires('/* require("ghost") */'), []);
  assert.deepEqual(collectRequires('const s = \'require("ghost")\';'), []);
  assert.deepEqual(collectRequires('const t = `require("ghost")`;'), []);
  assert.deepEqual(collectRequires('require.async("./x")'), []);
  assert.deepEqual(collectRequires('require(name)'), []);
  assert.deepEqual(collectRequires('myrequire("react")'), []);
});

test('buildBundle wraps modules and reports its edges', () => {
  const built = buildBundle(sources());
  assert.deepEqual(built.keys, ['index', 'panel']);
  assert.deepEqual(built.externals, ['react']);
  assert.deepEqual(built.localEdges, [{ spec: './panel', key: 'panel' }]);
  assert.match(built.code, /window\.__ModuleLoader__\.load\(/);
  assert.match(built.code, new RegExp(`id: "${CLIENT_BUNDLE_ID}"`));
  // The entry runs against the outer module record, so its exports are the plugin's.
  assert.match(built.code, /"index": function \(module, exports, require\)/);
  assert.match(built.code, /__factories\["index"\]\(module, module\.exports, __require\)/);
});

test('buildBundle refuses a module set it cannot resolve', () => {
  assert.throws(() => buildBundle([{ key: 'panel', code: '' }]), /no entry module "index"/);
  assert.throws(() => buildBundle(sources().concat([{ key: 'index', code: '' }])), /duplicate module key "index"/);
  assert.throws(
    () => buildBundle([{ key: 'index', code: 'require("zod");' }]),
    /neither a relative module nor an allowed platform seed/
  );
  assert.throws(() => buildBundle([{ key: 'index', code: 'require("./missing");' }]), /no module "missing" is bundled/);
  assert.throws(() => buildBundle([{ key: 'index', code: 'require("./nested/x");' }]), /only flat sibling modules/);
});

test('verifyClientPackage reports manifest drift', () => {
  const bundle = { externals: ['react'], keys: [CLIENT_ENTRY_KEY] };
  const good = {
    name: CLIENT_BUNDLE_ID,
    files: [BUNDLE_RELATIVE_PATH],
    exports: { './client': `./${BUNDLE_RELATIVE_PATH}` },
    dsh: { client: { platform: 'web', external: ['react'] } }
  };
  assert.deepEqual(verifyClientPackage(good, bundle, true), []);
  assert.deepEqual(verifyClientPackage({ ...good, dsh: {} }, bundle, true), ['package.json declares no dsh.client block']);
  assert.match(verifyClientPackage({ ...good, name: 'other' }, bundle, true)[0] ?? '', /must equal the bundle id/);
  assert.match(
    verifyClientPackage({ ...good, dsh: { client: { platform: 'node', external: ['react'] } } }, bundle, true)[0] ?? '',
    /platform must be "web"/
  );
  assert.match(verifyClientPackage({ ...good, files: [] }, bundle, true).join('|'), /"files" does not include/);
  assert.match(verifyClientPackage({ ...good, exports: {} }, bundle, true).join('|'), /exports no "\.\/client"/);
  assert.match(verifyClientPackage({ ...good, exports: { './client': './other.js' } }, bundle, true).join('|'), /expected "\.\/client\.js"/);
  assert.match(verifyClientPackage(good, bundle, false).join('|'), /missing or stale/);
  assert.match(
    verifyClientPackage({ ...good, dsh: { client: { platform: 'web', external: [] } } }, bundle, true).join('|'),
    /does not list it/
  );
  assert.match(
    verifyClientPackage({ ...good, dsh: { client: { platform: 'web', external: ['react', 'zod'] } } }, bundle, true).join('|'),
    /never requires it/
  );
  assert.match(verifyClientPackage(good, { externals: [], keys: [] }, true).join('|'), /carries no modules/);
});

test('the committed artifact exists and agrees with the manifest', () => {
  assert.ok(existsSync(artifactPath), `${BUNDLE_RELATIVE_PATH} is missing — run npm run build:client`);
  const code = readFileSync(artifactPath, 'utf8');
  assert.ok(code.length > 0, 'the artifact is empty: the entry would activate and register nothing');
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const clientDir = join(packageDir, CLIENT_OUT_DIR);
  assert.ok(existsSync(clientDir), `${CLIENT_OUT_DIR} is missing — run npm run build:client`);
  const built = buildBundle(readSources(clientDir));
  assert.deepEqual(built.externals, ['react'], 'the bundle must require exactly the platform seeds it declares');
  assert.deepEqual(built.externals, ALLOWED_SEEDS);
  assert.deepEqual(verifyClientPackage(pkg, built, true), []);
  assert.equal(code, built.code, 'client.js is stale — run npm run build:client');
});

test('the committed artifact activates under a module-table host', () => {
  let captured: { id?: unknown; factory?: unknown } | undefined;
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (entry: { id?: unknown; factory?: unknown }): void => {
          captured = entry;
        }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(artifactPath, 'utf8'), sandbox, { filename: BUNDLE_RELATIVE_PATH });
  assert.ok(captured !== undefined, 'the artifact never called __ModuleLoader__.load');
  assert.equal(captured.id, CLIENT_BUNDLE_ID);
  assert.equal(typeof captured.factory, 'function');
  const required: string[] = [];
  // Every bundled module resolves its own imports when the factory runs, so the
  // module table is asked once per importing module: what matters is that the
  // *set* of requested specifiers is exactly the declared platform seeds.
  const reactor = { createElement: (): unknown => undefined };
  const factory = captured.factory as (require: (spec: string) => unknown) => Record<string, unknown>;
  const exported = factory((spec) => {
    required.push(spec);
    if (spec === 'react') return reactor;
    throw new Error(`unexpected platform require ${spec}`);
  });
  assert.ok(required.length > 0, 'the entry requested nothing from the module table');
  assert.deepEqual([...new Set(required)].sort(), [...ALLOWED_SEEDS].sort(), 'the bundle requested a specifier it does not declare as a seed');
  assert.equal(typeof exported.apply, 'function');
  assert.ok(Array.isArray(exported.inject));
  for (const service of exported.inject as string[]) {
    assert.ok(['slots', 'locale', 'configForms'].includes(service), `undeclared service dependency ${service}`);
  }
  assert.equal(Object.prototype.toString.call(exported), '[object Module]');
});
