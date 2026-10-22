/**
 * The dependency fence of the decision core.
 *
 * A shared core is only shared if it cannot reach back into a host. These tests
 * read the *source* (not the compiled output) and fail when a dependency points
 * the wrong way, when a new decision module learns a harness concept, or when the
 * plugin's vendored copy has drifted from the single source of truth.
 *
 * The fence is deliberately one test so a reviewer can point at exactly one
 * negative control: temporarily making a core module import an adapter makes
 * this test — and only this test — go red.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const coreDir = join(repoRoot, 'src', 'core');
const portsDir = join(repoRoot, 'src', 'ports');
const adaptersDir = join(repoRoot, 'src', 'adapters');
/**
 * Locate the DSH plugin package by its manifest name rather than its directory
 * name, so renaming the directory cannot silently break this test.
 */
function findPluginDir(): string {
  const packagesDir = join(repoRoot, 'packages');
  for (const entry of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    if (manifest.name === 'dsh-harness-reflex') return join(packagesDir, entry);
  }
  throw new Error('no package named dsh-harness-reflex under packages/');
}

const pluginDir = findPluginDir();
const pluginSrc = join(pluginDir, 'src');
const vendorRoot = join(pluginSrc, 'vendor', 'harness-reflex');

/** The decision modules extracted in v0.2.0 S1, plus their shared text helper. */
const DECISION_MODULES = ['text.ts', 'policy.ts', 'judge.ts', 'closing.ts', 'evidence.ts', 'prune-plan.ts'];

/** Strip comments so a quotation inside prose is never read as an import. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Relative specifiers a source file imports. */
function importSpecifiers(source: string): string[] {
  const text = withoutComments(source);
  const specs: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    specs.push(match[1] as string);
  }
  return specs;
}

/** Every non-test TypeScript file directly under one directory, sorted. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => join(dir, entry));
}

/** Resolve one import specifier to a repo-relative POSIX path, or undefined for a bare specifier. */
function resolvedTarget(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), spec);
  const candidates = base.endsWith('.js') ? [base.slice(0, -3) + '.ts', base] : [base + '.ts', base];
  const found = candidates.find((candidate) => existsSync(candidate));
  return relative(repoRoot, found ?? candidates[0]!).split('\\').join('/');
}

test('architecture: the decision core only depends downward and stays harness-free', () => {
  // 1. No core module may reach into an adapter, a state implementation, or the
  //    plugin package — the dependency arrow only points from adapters to core.
  for (const file of [...sourceFiles(coreDir), ...sourceFiles(portsDir)]) {
    const text = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(text)) {
      const target = resolvedTarget(file, spec);
      assert.ok(
        target === undefined || !/^(packages\/|src\/adapters\/|src\/state\/)/.test(target),
        `${relative(repoRoot, file)} imports ${spec} (${target}); the core may not depend on an adapter, state, or a host package`
      );
    }
  }

  // 2. The extracted decision modules are stricter still: core/, ports/, the
  //    backend's pure types, or a Node builtin. Nothing else — and no harness
  //    concept in the source at all.
  const harnessWord = /\b(DSH|Claude|pi)\b/;
  for (const name of DECISION_MODULES) {
    const file = join(coreDir, name);
    assert.ok(existsSync(file), `missing decision module: src/core/${name}`);
    const text = readFileSync(file, 'utf8');
    assert.ok(!harnessWord.test(text), `src/core/${name} mentions a harness concept (DSH/Claude/pi)`);
    for (const spec of importSpecifiers(text)) {
      const target = resolvedTarget(file, spec);
      if (target === undefined) {
        assert.ok(spec.startsWith('node:') || spec === 'fs' || spec === 'path', `src/core/${name} imports a non-stdlib bare module: ${spec}`);
        continue;
      }
      assert.ok(
        /^src\/core\//.test(target) || /^src\/ports\//.test(target) || target === 'src/backend/types.ts',
        `src/core/${name} imports ${spec} (${target}); a decision module may only depend on core/, ports/, and backend/types`
      );
    }
  }

  // 3. Ports are interfaces over the pure backend types; they may not import the
  //    core that consumes them.
  for (const file of sourceFiles(portsDir)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!harnessWord.test(text), `${relative(repoRoot, file)} mentions a harness concept (DSH/Claude/pi)`);
    for (const spec of importSpecifiers(text)) {
      const target = resolvedTarget(file, spec);
      if (target === undefined) {
        assert.ok(spec.startsWith('node:'), `${relative(repoRoot, file)} imports a non-stdlib bare module: ${spec}`);
        continue;
      }
      assert.ok(
        /^src\/ports\//.test(target) || target === 'src/backend/types.ts',
        `${relative(repoRoot, file)} imports ${spec} (${target}); ports may only depend on ports/ and backend/types`
      );
    }
  }

  // 4. Adapters never import each other: the only cross-harness sharing is the
  //    core plus the ports.
  const adapters = sourceFiles(adaptersDir);
  for (const file of adapters) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolvedTarget(file, spec);
      if (target === undefined) continue;
      const sibling = adapters.find((other) => other !== file && relative(repoRoot, other).split('\\').join('/') === target);
      assert.equal(
        sibling,
        undefined,
        `${relative(repoRoot, file)} imports another adapter (${target}); adapters may only share core/ and ports/`
      );
    }
  }

  // 5. The plugin is an adapter too: it must consume the vendored core, and it
  //    must not reach into the root package's adapters or decision source.
  let consumesCore = false;
  for (const file of walkTypeScript(pluginSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(text)) {
      assert.ok(
        !spec.includes('/adapters/') && !spec.includes('../../../../src/core/'),
        `${relative(repoRoot, file)} reaches outside its package: ${spec}`
      );
      if (spec.includes('vendor/harness-reflex/core/') || spec.includes('vendor/harness-reflex/ports/')) {
        consumesCore = true;
      }
    }
  }
  assert.ok(consumesCore, 'the host adapter no longer imports the decision core');

  // 6. The vendored copy is generated, not hand-maintained: drift is a failure.
  const mirrored = [
    ...DECISION_MODULES.map((name) => [`src/core/${name}`, `core/${name}`]),
    ...sourceFiles(portsDir).map((file) => [`src/ports/${file.slice(portsDir.length + 1)}`, `ports/${file.slice(portsDir.length + 1)}`])
  ];
  for (const [source, vendored] of mirrored) {
    const sourceText = readFileSync(join(repoRoot, source!), 'utf8');
    const vendoredPath = join(vendorRoot, vendored!);
    assert.ok(existsSync(vendoredPath), `missing vendored copy: ${relative(repoRoot, vendoredPath)} (run npm run sync:core)`);
    assert.equal(readFileSync(vendoredPath, 'utf8'), sourceText, `vendored copy drifted: ${relative(repoRoot, vendoredPath)} (run npm run sync:core)`);
  }
});

/** Every TypeScript file under a directory tree, excluding tests. */
function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'client' || entry.name === 'vendor') continue;
      out.push(...walkTypeScript(target));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(target);
    }
  }
  return out;
}
