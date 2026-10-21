/**
 * The release manifest: what `npm pack` may ship, and what it must not.
 *
 * A packaging mistake is invisible to the test suite that guards behaviour — the
 * code all passes while the tarball is missing a file, carries a stale one, or
 * depends on a package nobody declares. These tests read the *manifest* against
 * the real tree instead, and they are the fast half of the guarantee: the slow
 * half is `scripts/release-pack.mjs`, which packs both packages, audits the real
 * entry list and installs the root tarball offline.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(repoRoot, 'packages', 'dsh-reflex');
const releaseDir = join(repoRoot, 'release');

const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Manifest;
const plugin = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as Manifest;

interface Manifest {
  name: string;
  version: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; external?: string[]; inject?: string[] } };
}

/**
 * Decide whether npm's `files` allow-list would ship one repo-relative path.
 *
 * This is the documented subset of npm's glob semantics: `**` crosses
 * directories, `*` does not, and a later negation wins over an earlier positive.
 * The handful of names npm always ships are added on top, because those are
 * exactly what a `files` list can never take away.
 */
const ALWAYS_PACKED = ['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md'];

function packed(patterns: readonly string[], file: string): boolean {
  if (ALWAYS_PACKED.includes(file)) return true;
  const toRegExp = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        // `**/` may match no directory at all, so `docs/**/*.md` also covers `docs/x.md`.
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:[^/]+/)*')
        .replace(/\u0001/g, '.*')}$`
    );
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    if (toRegExp(negative ? pattern.slice(1) : pattern).test(file)) included = !negative;
  }
  return included;
}

/** Every file under `dir`, repo-relative, POSIX-shaped. */
function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

/** Bare `@scope/name` specifiers one set of built files imports. */
function importedHostPackages(dir: string, extensions: RegExp): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(dir, 'dist'), 'dist')) {
    if (!extensions.test(file)) continue;
    // Test bundles are excluded from the tarball (`files` in the plugin
    // manifest), so a host package a *test* imports is not a runtime promise to
    // consumers. The guards below are about what ships.
    if (/\.test\.(?:js|cjs|mjs|d\.ts)$/.test(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const match of text.matchAll(/(?:require\(|from\s+|import\()\s*["']([^"']+)["']/g)) {
      const spec = match[1] as string;
      if (spec.startsWith('@deepseek-ai/')) found.add(spec.split('/').slice(0, 2).join('/'));
    }
  }
  return found;
}

//#region the root package

test('the root manifest publishes the runtime surface a consumer resolves', () => {
  assert.equal(root.name, 'harness-reflex');
  assert.equal(root.main, 'dist/index.js');
  assert.equal(root.types, 'dist/index.d.ts');
  assert.equal(root.bin?.['harness-reflex'], 'dist/cli/index.js');
  assert.deepEqual(
    Object.keys(root.exports ?? {}).sort(),
    ['.', './core/*', './mcp', './package.json'],
    'the published entry points changed; a consumer import may have broken'
  );

  const entry = root.exports?.['.'] as Record<string, string>;
  assert.equal(entry.default, './dist/index.js');
  assert.equal(entry.types, './dist/index.d.ts');
  const mcp = root.exports?.['./mcp'] as Record<string, string>;
  assert.equal(mcp.default, './dist/mcp/server.js');

  // Every declared target must exist: `exports` is a promise about the tarball.
  const targets: [string, string][] = [
    ['main', root.main as string],
    ['types', root.types as string],
    ['bin', root.bin?.['harness-reflex'] as string],
    ...Object.entries(root.exports ?? {})
      .filter(([subpath]) => subpath !== './core/*' && subpath !== './package.json')
      .flatMap(([subpath, value]) => Object.entries(value as Record<string, string>).map(([key, target]) => [`exports["${subpath}"].${key}`, target] as [string, string])),
    ['exports["./core/*"] (probed via gate)', './dist/core/gate.js']
  ];
  for (const [what, target] of targets) {
    assert.ok(existsSync(join(repoRoot, target)), `${what} points at a file the package does not contain: ${target}`);
  }
  // The CLI must stay executable: npm preserves the shebang and the mode.
  assert.match(readFileSync(join(repoRoot, 'dist/cli/index.js'), 'utf8').split('\n')[0] as string, /^#!\/usr\/bin\/env node/);
});

test('the root files allow-list ships the release promises and nothing else', () => {
  const files = root.files ?? [];
  assert.ok(files.length > 0, 'the root package has no files allow-list; npm would fall back to .gitignore');

  const shipped = [
    'package.json',
    'README.md',
    'USER_GUIDE.md',
    'docs/USER_GUIDE.en.md',
    'docs/dsh-plugin.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/index.js.map',
    'dist/cli/index.js',
    'dist/mcp/server.js',
    'dist/core/gate.js',
    'experiments/index.ts',
    'experiments/runner.ts',
    'experiments/data/calibration_sample.json'
  ];
  for (const file of shipped) {
    assert.ok(packed(files, file), `the allow-list does not ship ${file}`);
  }

  const withheld = [
    'dist/index.test.js',
    'dist/index.test.js.map',
    'dist/core/ledger.test.js',
    'dist/core/ledger.test.d.ts',
    'experiments/index.js',
    'experiments/index.d.ts',
    'experiments/runner.js',
    'src/index.ts',
    'tsconfig.json',
    '.mcp.json',
    '.codex/config.json',
    '.claude/settings.json',
    '.agents/plugins/harness-reflex/plugin.json',
    '.dsh-graph/project.yaml',
    'node_modules/typescript/package.json',
    'tmp/npm-cache/index.js',
    `release/harness-reflex-${root.version}.tgz`,
    `harness-reflex-${root.version}.tgz`
  ];
  for (const file of withheld) {
    assert.equal(packed(files, file), false, `the allow-list ships ${file}`);
  }

  // A literal (glob-free) positive pattern that matches nothing is a typo.
  for (const pattern of files.filter((candidate) => !candidate.startsWith('!') && !candidate.includes('*'))) {
    assert.ok(existsSync(join(repoRoot, pattern)), `the allow-list names a path that does not exist: ${pattern}`);
  }
  // The test-build negations must actually withhold something, or they rot silently.
  const builtTests = walk(join(repoRoot, 'dist'), 'dist').filter((file) => file.includes('.test.'));
  assert.ok(builtTests.length >= 3, `expected the build to contain test artifacts, found ${String(builtTests.length)}`);
});

test('the repository keeps release archives out of the package root', () => {
  const stray = readdirSync(repoRoot).filter((entry) => entry.endsWith('.tgz'));
  assert.deepEqual(stray, [], 'tarballs belong in release/, not in the published package root');
});

//#endregion

//#region the plugin package

test('the plugin manifest ships the browser half and the guide it renders', () => {
  assert.equal(plugin.name, 'dsh-harness-reflex');
  assert.equal(plugin.version, root.version, 'the two packages release in lockstep');
  assert.equal(plugin.exports?.['./client'], './client.js');
  assert.ok((plugin.files ?? []).includes('client.js'), 'the browser half is not in the allow-list');
  assert.equal(plugin.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(plugin.dsh?.client?.platform, 'web');
  assert.deepEqual(plugin.dsh?.client?.external, ['react'], 'the seed allow-list is part of the client contract');
  assert.deepEqual(
    [...(plugin.dsh?.client?.inject ?? [])].sort(),
    ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']
  );

  // Both files the DSH loader reads must exist and be non-trivial.
  assert.ok(existsSync(join(pluginDir, 'cordis.patch.yml')));
  const artifact = readFileSync(join(pluginDir, 'client.js'), 'utf8');
  assert.ok(statSync(join(pluginDir, 'client.js')).size > 100_000, 'the client artifact looks truncated');
  for (const probe of ['__ModuleLoader__', 'settings.section', 'dsh-reflex', 'reflex_status_ledger']) {
    assert.ok(artifact.includes(probe), `the client artifact does not contain ${probe}`);
  }

  // The client half lives in the bundle, never in the Host build output.
  assert.equal(existsSync(join(pluginDir, 'dist', 'client')), false, 'the Host build leaked the browser half into dist/');
  const files = plugin.files ?? [];
  for (const withheld of [
    'dist/index.test.js',
    'dist/index.test.d.ts',
    'dist/index.d.ts.map',
    'dist-client/index.js',
    'src/client/index.ts',
    'client.test.js',
    'node_modules/@deepseek-ai/cordis/package.json'
  ]) {
    assert.equal(packed(files, withheld), false, `the plugin allow-list ships ${withheld}`);
  }
});

test('the plugin declares every host package its build imports', () => {
  const declared = new Set([...Object.keys(plugin.dependencies ?? {}), ...Object.keys(plugin.peerDependencies ?? {})]);
  const runtimeImports = importedHostPackages(pluginDir, /\.(?:js|cjs|mjs)$/);
  assert.ok(runtimeImports.size >= 3, `expected runtime host imports, found ${String(runtimeImports.size)}`);
  for (const specifier of runtimeImports) {
    assert.ok(declared.has(specifier), `dist/ imports ${specifier} at run time but the manifest never declares it`);
  }
  // Type-level imports ship inside the declarations, so consumers need them too.
  for (const specifier of importedHostPackages(pluginDir, /\.d\.ts$/)) {
    assert.ok(declared.has(specifier), `the published declarations import ${specifier} but the manifest never declares it`);
  }
});

test('the packed tarball is self-contained with no unpublishable dependencies', () => {
  // dsh-harness-reflex vendors harness-reflex directly into dist/vendor so that it
  // installs cleanly in private DSH profiles without needing a public npm publication.
  assert.equal(plugin.dependencies?.['harness-reflex'], undefined, 'the plugin should not depend on unreleased harness-reflex');
  assert.ok(existsSync(join(pluginDir, 'dist', 'vendor', 'harness-reflex', 'index.js')), 'the vendored runtime must be compiled into dist/');
});

//#endregion

//#region the release directory

test('a packed release directory is internally consistent', () => {
  if (!existsSync(releaseDir)) {
    // Nothing packed yet: `npm run release` produces this directory.
    assert.ok(true);
    return;
  }
  const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.ok(sums.length >= 2, 'SHA256SUMS does not cover both packages');
  for (const line of sums) {
    const [sha, file] = line.split(/\s+/);
    const path = join(releaseDir, file as string);
    assert.ok(existsSync(path), `SHA256SUMS names a missing artifact: ${String(file)}`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(actual, sha, `SHA256SUMS disagrees with the bytes of ${String(file)}`);
  }
  // A version bump leaves the previous artifacts in place until the next pack
  // runs, so "no tarball for *this* version" means the tree is not packed yet,
  // not that the packed release is broken: the pack run is what asserts presence
  // (`release-pack.mjs` fails on a missing artifact). Jumping to the checks below
  // would compare the old artifacts against the new version and report a lie.
  const artifacts = [`harness-reflex-${root.version}.tgz`, `dsh-harness-reflex-${plugin.version}.tgz`];
  if (artifacts.some((artifact) => !existsSync(join(releaseDir, artifact)))) {
    assert.ok(true, `not packed for this version yet: ${artifacts.join(', ')}`);
    return;
  }

  const report = JSON.parse(readFileSync(join(releaseDir, 'release-report.json'), 'utf8')) as {
    failures: unknown[];
    checks: { ok: boolean }[];
    artifacts: { file: string }[];
  };
  assert.deepEqual(report.failures, [], `the last pack run reported failures: ${JSON.stringify(report.failures)}`);
  assert.ok(report.checks.length >= 20, 'the pack run recorded too few checks to be meaningful');
  assert.ok(
    report.artifacts.some((artifact) => artifact.file === `dsh-harness-reflex-${plugin.version}.tgz`),
    'the report does not cover the plugin tarball'
  );
});

test('the documentation names the release paths it ships', () => {
  const guide = readFileSync(join(repoRoot, 'USER_GUIDE.md'), 'utf8');
  const english = readFileSync(join(repoRoot, 'docs', 'USER_GUIDE.en.md'), 'utf8');
  for (const document of [guide, english]) {
    assert.match(document, /release\//, 'the guide does not name the release output directory');
    assert.match(document, /npm run build:all/, 'the guide does not document the build command');
    assert.match(document, /USER_GUIDE\.md/, 'the guide does not name its own source document');
  }
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /USER_GUIDE\.md/, 'the README does not link the user guide');
  assert.match(readme, /release\//, 'the README does not name the release output directory');
});

//#endregion
