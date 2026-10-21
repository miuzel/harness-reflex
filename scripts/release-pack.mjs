#!/usr/bin/env node
/**
 * Pack, verify and install-smoke the two release tarballs.
 *
 * The step exists because "it built" is not "it ships": npm decides what enters
 * a tarball from `files` plus a pile of default rules, and the failure mode is
 * silent — a missing `dist/` entry or a source map pointing at a file nobody
 * ships only shows up in a consumer's terminal. So this script:
 *
 * 1. packs the root package and the DSH plugin into `release/`;
 * 2. extracts both and audits the real entry list (required files present, no
 *    test build, no temporary directory, no absolute developer path);
 * 3. resolves every relative import, `require` and source-map target against
 *    the extracted tree — a dead link is a hard failure;
 * 4. installs the root tarball into a scratch directory with `npm install`
 *    (offline: the root package has no runtime dependencies), then runs its
 *    `bin`, imports it, and speaks one stdio MCP `tools/list` handshake;
 * 5. assembles the plugin's runtime tree by extraction (its host peers come
 *    from DSH at run time, per its `peerDependencies`) and imports it, which
 *    proves the published module graph resolves outside the repository;
 * 6. writes `release/SHA256SUMS`, `release/release-report.json` and the
 *    human-readable release notes with the artifact list and verification log.
 *
 * Usage: node scripts/release-pack.mjs [--keep] [--skip-install]
 *   --keep          leave the scratch directories in place for inspection
 *   --skip-install  skip the two install smokes (structure audit still runs)
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');
const tmpDir = path.join(repoRoot, 'tmp', 'release-pack');
const npmCache = path.join(repoRoot, 'tmp', 'npm-cache');

const keepScratch = process.argv.includes('--keep');
const skipInstall = process.argv.includes('--skip-install');

/** Node builtins are always resolvable, prefixed or not. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'node:test', 'node:test/reporters']);

const checks = [];
/** Record one verification step; a failed check aborts the run at the end. */
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail.length > 0 ? ` (${detail})` : ''}`);
}
const failures = [];

/** Run a command, capturing output, and fail loudly on a non-zero exit. */
function run(command, args, options = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const isolatedHome = path.join(tmpDir, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const cleanEnv = { ...process.env, HOME: isolatedHome, npm_config_cache: npmCache, npm_config_audit: 'false', npm_config_fund: 'false', ...options.env };
  delete cleanEnv.npm_config_allow_scripts;
  delete cleanEnv.npm_config_allow_scripts_pending;
  delete cleanEnv.npm_config_allow_scripts_pin;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: cleanEnv,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/** Every entry name inside a tarball. */
function entries(tarball) {
  return run('tar', ['-tzf', tarball])
    .stdout.split('\n')
    .filter((line) => line.trim().length > 0);
}

/** Extract one tarball into `destination` (the `package/` prefix is stripped). */
function extract(tarball, destination) {
  fs.mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1']);
  return destination;
}

/** Read the `files` allow-list of a package. */
function manifests() {
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pluginDir = path.join(repoRoot, 'packages', 'dsh-reflex');
  const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  return { root, plugin, pluginDir };
}

//#region packing

const { root, plugin } = manifests();

// Packing a stale build is the one mistake this script cannot detect later: the
// tarball would be internally consistent but simply old. Both halves are built by
// `npm run build:all`; refuse to package a tree that was edited afterwards.
const newest = (dir) => {
  let latest = 0;
  for (const file of walk(dir)) latest = Math.max(latest, fs.statSync(path.join(dir, file)).mtimeMs);
  return latest;
};
for (const [label, sourceDir, products] of [
  ['root', path.join(repoRoot, 'src'), ['dist/index.js']],
  ['plugin', path.join(repoRoot, 'packages', 'dsh-reflex', 'src'), ['packages/dsh-reflex/dist/index.js', 'packages/dsh-reflex/client.js']]
]) {
  const oldest = Math.min(...products.map((product) => fs.statSync(path.join(repoRoot, product)).mtimeMs));
  check(`${label}: the build is newer than the sources`, oldest >= newest(sourceDir), `run npm run build:all before packing`);
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(npmCache, { recursive: true });

/** The filename `npm pack --json` reported (npm 12 keys the object by package name). */
function packedFilename(stdout) {
  const parsed = JSON.parse(stdout);
  const records = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const filename = records[0]?.filename;
  if (typeof filename !== 'string') throw new Error(`npm pack reported no filename: ${stdout.slice(0, 200)}`);
  return filename;
}

const rootPack = run('npm', ['pack', '--json', '--pack-destination', releaseDir]);
const rootTarball = path.join(releaseDir, packedFilename(rootPack.stdout));
const pluginPack = run('npm', ['pack', '--json', '--pack-destination', releaseDir], { cwd: path.join(repoRoot, 'packages', 'dsh-reflex') });
const pluginTarball = path.join(releaseDir, packedFilename(pluginPack.stdout));

for (const [what, tarball] of [
  ['root', rootTarball],
  ['plugin', pluginTarball]
]) {
  check(`${what}: tarball exists`, fs.existsSync(tarball), path.basename(tarball));
}
check('root: the packed version matches package.json', path.basename(rootTarball).includes(root.version), path.basename(rootTarball));
check('plugin: the packed version matches package.json', path.basename(pluginTarball).includes(plugin.version), path.basename(pluginTarball));

//#endregion

//#region structure audit

/** Entry names that must never ship, in either package. */
const FORBIDDEN = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)tmp\//,
  /(^|\/)release\//,
  /(^|\/)\.dsh-graph\//,
  /(^|\/)\.agents\//,
  /(^|\/)\.claude\//,
  /(^|\/)\.codex\//,
  /(^|\/)dist-client\//,
  /\.tgz$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.env/,
  /\.test\.[cm]?js(\.map)?$/,
  /\.test\.d\.ts(\.map)?$/,
  /(^|\/)\.DS_Store$/
];

const ROOT_REQUIRED = [
  'package.json',
  'README.md',
  'USER_GUIDE.md',
  'docs/USER_GUIDE.en.md',
  'docs/dsh-plugin.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/index.js',
  'dist/mcp/server.js',
  'dist/core/gate.js',
  'dist/core/ledger.js',
  'experiments/index.ts',
  'experiments/data/calibration_sample.json'
];

const PLUGIN_REQUIRED = [
  'package.json',
  'README.md',
  'client.js',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/tools.js',
  'dist/router.js',
  'dist/effort.js'
];

/** Absolute paths of a developer checkout may never leak into a published file. */
function assertNoAbsolutePaths(dir, relativeFiles) {
  const offenders = [];
  for (const relative of relativeFiles) {
    if (!/\.(?:js|map|json|md|ts|yml|cjs|mjs)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(dir, relative), 'utf8');
    if (text.includes('/home/') || text.includes('/Users/')) offenders.push(relative);
  }
  return offenders;
}

/** Every file under `dir`, relative and POSIX-shaped. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

/**
 * Resolve every module reference and source-map target inside an extracted package.
 *
 * Only references a consumer's tooling actually follows are treated as links:
 * relative `require`/`import` specifiers, `sourceMappingURL` targets and the
 * package's own `exports`/`bin`/`main` targets. Source maps are self-contained
 * (`inlineSources`), so their internal `sources` list cannot dangle. Comments are
 * stripped before scanning so prose can never masquerade as an import, and the
 * browser bundle is exempt from the module scan: its `require('./view')` calls are
 * answered by the bundle's own module table, not by the filesystem.
 */
function deadLinks(dir, relativeFiles, manifest, browserArtifacts = []) {
  const present = new Set(relativeFiles);
  const dead = [];
  const bare = new Set();

  const resolveRelative = (from, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const candidates = [base, `${base}.js`, `${base}.json`, `${base}.d.ts`, `${base}/index.js`];
    if (spec.endsWith('.js')) candidates.unshift(base, base.replace(/\.js$/, '.d.ts'), base.replace(/\.js$/, '.js.map'));
    return candidates.find((candidate) => present.has(candidate));
  };

  for (const relative of relativeFiles) {
    if (relative.endsWith('.map')) {
      const map = JSON.parse(fs.readFileSync(path.join(dir, relative), 'utf8'));
      const sources = map.sources ?? [];
      // A map that carries its own `sourcesContent` is self-contained and needs
      // nothing from the package; one that does not must find each source here.
      if (sources.length > 0 && (map.sourcesContent ?? []).length !== sources.length) {
        for (const source of sources) {
          if (typeof source === 'string' && source.startsWith('.') && resolveRelative(relative, source) === undefined) {
            dead.push(`${relative} → ${source} (no sourcesContent)`);
          }
        }
      }
      continue;
    }
    if (!/\.(?:js|cjs|mjs|d\.ts)$/.test(relative)) continue;
    const runtimeModule = !relative.endsWith('.d.ts');
    const raw = fs.readFileSync(path.join(dir, relative), 'utf8');
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    if (!browserArtifacts.includes(relative)) {
      for (const match of text.matchAll(/(?:require\(|from\s+|import\()\s*["']([^"']+)["']/g)) {
        const spec = match[1];
        if (spec.startsWith('.')) {
          if (resolveRelative(relative, spec) === undefined) dead.push(`${relative} → ${spec}`);
        } else if (runtimeModule && !BUILTINS.has(spec)) {
          // Only runtime imports create a dependency a consumer must install;
          // `.d.ts` imports are type-level and are covered by the peer list.
          bare.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
        }
      }
    }
    for (const match of text.matchAll(/sourceMappingURL=([^\s*]+)/g)) {
      const target = match[1];
      const resolved = target.startsWith('data:') ? true : resolveRelative(relative, target.startsWith('.') ? target : `./${target}`);
      if (resolved === undefined || resolved === false) dead.push(`${relative} → ${target}`);
    }
  }

  // Declared entry points must exist too.
  for (const [field, target] of [
    ['main', manifest.main],
    ['types', manifest.types],
    ['bin', typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0]]
  ]) {
    if (typeof target === 'string' && !present.has(target.replace(/^\.\//, ''))) dead.push(`package.json ${field} → ${target}`);
  }
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value);
    for (const target of targets) {
      if (typeof target !== 'string' || target.includes('*')) continue;
      if (!present.has(target.replace(/^\.\//, ''))) dead.push(`package.json exports["${subpath}"] → ${target}`);
    }
  }

  return { dead, bare: [...bare].sort() };
}

/** Required/forbidden/links audit of one extracted package. */
function audit(label, dir, required, manifest, allowedBare, browserArtifacts = []) {
  const files = walk(dir).filter((file) => !file.endsWith('/'));
  check(`${label}: no node_modules or temporary directory shipped`, files.every((file) => !FORBIDDEN.some((rule) => rule.test(file))), `${String(files.length)} entries`);
  check(`${label}: every required file is present`, required.every((file) => files.includes(file)), required.filter((file) => !files.includes(file)).join(', ') || `${String(required.length)} files`);
  const offenders = assertNoAbsolutePaths(dir, files);
  check(`${label}: no absolute developer path in a published file`, offenders.length === 0, offenders.slice(0, 3).join(', '));
  const { dead, bare } = deadLinks(dir, files, manifest, browserArtifacts);
  check(`${label}: zero dead links`, dead.length === 0, dead.slice(0, 3).join(', '));
  const unexpected = bare.filter((spec) => !allowedBare.includes(spec));
  check(`${label}: no undeclared runtime dependency`, unexpected.length === 0, unexpected.join(', '));
  return { files: files.length, bare };
}

const rootDir = extract(rootTarball, path.join(tmpDir, 'root'));
const pluginDir = extract(pluginTarball, path.join(tmpDir, 'plugin'));

const rootAudit = audit('root', rootDir, ROOT_REQUIRED, root, [
  'harness-reflex',
  ...Object.keys({ ...root.dependencies, ...root.peerDependencies })
]);
const pluginAudit = audit(
  'plugin',
  pluginDir,
  PLUGIN_REQUIRED,
  plugin,
  ['harness-reflex', 'react', ...Object.keys({ ...plugin.dependencies, ...plugin.peerDependencies })],
  ['client.js']
);

check(
  'root: experiments ship as sources, never as build output',
  rootAudit.files > 0 && !walk(rootDir).some((file) => /^experiments\/.*\.js$/.test(file))
);
check('plugin: the browser half is one self-contained artifact', fs.statSync(path.join(pluginDir, 'client.js')).size > 100_000);
check(
  'plugin: the shipped guide is the repository revision',
  (() => {
    const artifact = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8');
    const zh = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'USER_GUIDE.md'), 'utf8')).digest('hex');
    const en = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'docs', 'USER_GUIDE.en.md'), 'utf8')).digest('hex');
    return artifact.includes(zh.slice(0, 12)) && artifact.includes(en.slice(0, 12));
  })(),
  'client.js must carry both guide digests'
);
check(
  'root: the shipped guide is the repository revision',
  createHash('sha256').update(fs.readFileSync(path.join(rootDir, 'USER_GUIDE.md'), 'utf8')).digest('hex') ===
    createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'USER_GUIDE.md'), 'utf8')).digest('hex')
);

//#endregion

//#region install smokes

const smoke = { root: {}, plugin: {} };

if (!skipInstall) {
  // (1) The root package is dependency-free, so a real offline install is a fair test.
  const scratch = path.join(tmpDir, 'root-install');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), `${JSON.stringify({ name: 'reflex-release-smoke', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  run('npm', ['install', rootTarball, '--no-audit', '--no-fund', '--offline', '--cache', npmCache], {
    cwd: scratch
  });

  const installed = path.join(scratch, 'node_modules', 'harness-reflex');
  check('smoke: npm install of the root tarball succeeds offline', fs.existsSync(path.join(installed, 'dist', 'index.js')));

  // Run the shim npm created, not the file behind it: that is what a consumer's
  // shell runs, and it only works when npm kept the declared entry executable.
  const bin = path.join(scratch, 'node_modules', '.bin', 'harness-reflex');
  const help = run(bin, ['--help'], { cwd: scratch, allowFailure: true });
  check('smoke: the installed bin runs and prints usage', help.status === 0 && /(usage|harness-reflex)/i.test(`${help.stdout}${help.stderr}`), `exit ${String(help.status)}`);
  check('smoke: npm linked the declared bin', fs.existsSync(bin));

  const imported = run(process.execPath, ['--input-type=module', '-e', "const m = await import('harness-reflex'); console.log(JSON.stringify(Object.keys(m).sort()));"], { cwd: scratch });
  const exportedKeys = JSON.parse(imported.stdout.trim().split('\n').pop());
  check('smoke: the installed package imports by name', exportedKeys.length >= 20, `${String(exportedKeys.length)} exports`);

  const mcp = run(
    process.execPath,
    ['--input-type=module', '-e', `
      import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, [${JSON.stringify(path.join(installed, 'dist', 'cli', 'index.js'))}, 'mcp'], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\\n',
        encoding: 'utf8'
      });
      const line = child.stdout.trim().split('\\n').filter((row) => row.length > 0).pop();
      const tools = JSON.parse(line).result.tools.map((tool) => tool.name);
      console.log(JSON.stringify(tools));
    `],
    { cwd: scratch, env: { SYSTEM_ONE_BACKEND: 'mock', SYSTEM_ONE_API_KEY: '', SYSTEM_ONE_BASE_URL: '' } }
  );
  const tools = JSON.parse(mcp.stdout.trim().split('\n').pop());
  smoke.root = { exports: exportedKeys.length, tools: tools.length };
  check('smoke: the installed MCP server advertises the frozen eight tools', tools.length === 8, tools.sort().join(', '));

  // (2) The plugin's host peers belong to DSH at run time; the tree is assembled
  // by extraction so the audit stays offline and deterministic.
  const pluginScratch = path.join(tmpDir, 'plugin-import');
  const modules = path.join(pluginScratch, 'node_modules');
  fs.rmSync(pluginScratch, { recursive: true, force: true });
  fs.mkdirSync(modules, { recursive: true });
  // npm installs a package under `node_modules/` + its name segments (one level
  // deeper for a scoped name), so the extracted tree has to land there to be
  // importable by its real id — whatever the manifest currently calls it.
  const packageDir = path.join(modules, ...plugin.name.split('/'));
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.renameSync(pluginDir, packageDir);
  extract(rootTarball, path.join(modules, 'harness-reflex'));
  const linkedFrom = path.join(repoRoot, 'packages', 'dsh-reflex', 'node_modules');
  const linked = [];
  // The host packages are supplied by DSH at run time (peerDependencies); the
  // locally linked copies stand in for that host during the import smoke.
  const source = path.join(linkedFrom, '@deepseek-ai');
  if (fs.existsSync(source)) {
    fs.symlinkSync(fs.realpathSync(source), path.join(modules, '@deepseek-ai'), 'dir');
    linked.push('@deepseek-ai');
  }
  // The session-local projection owns a declared Zod runtime dependency.
  // Resolve it from the development installation for this offline import smoke.
  const zodSource = path.join(linkedFrom, 'zod');
  if (fs.existsSync(zodSource)) {
    fs.symlinkSync(fs.realpathSync(zodSource), path.join(modules, 'zod'), 'dir');
    linked.push('zod');
  }
  fs.writeFileSync(path.join(pluginScratch, 'package.json'), `${JSON.stringify({ name: 'reflex-plugin-smoke', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  const pluginImport = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m = await import('dsh-harness-reflex'); console.log(JSON.stringify({ apply: typeof m.apply, reader: typeof m.readPrunedOriginal, locator: typeof m.pruneLocator, keys: Object.keys(m).sort() }));"
    ],
    { cwd: pluginScratch }
  );
  const pluginExports = JSON.parse(pluginImport.stdout.trim().split('\n').pop());
  smoke.plugin = { linked, apply: pluginExports.apply, reader: pluginExports.reader };
  check('smoke: the extracted plugin resolves and exposes apply()', pluginExports.apply === 'function' && linked.includes('@deepseek-ai'), `linked ${linked.join(', ')}`);
  // The user guide tells a reader to import the retrieval API from the package root,
  // so the installed root — not an internal subpath — has to carry it.
  check(
    'smoke: the extracted plugin exposes the documented retrieval API from its root',
    pluginExports.reader === 'function' && pluginExports.locator === 'function',
    `reader ${String(pluginExports.reader)}, locator ${String(pluginExports.locator)}`
  );
} else {
  check('smoke: skipped on request', true, '--skip-install');
}

//#endregion

//#region report

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const artifacts = [rootTarball, pluginTarball].map((file) => ({
  file: path.basename(file),
  bytes: fs.statSync(file).size,
  entries: entries(file).length,
  // The exact entry list, so the release checklist is auditable without unpacking.
  entryList: entries(file)
    .map((entry) => entry.replace(/^package\//, ''))
    .sort(),
  sha256: sha256(file)
}));

fs.writeFileSync(
  path.join(releaseDir, 'SHA256SUMS'),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join('\n')}\n`,
  'utf8'
);

const modified = run('git', ['status', '--porcelain'], { allowFailure: true }).stdout.trim().split('\n').filter((line) => line.length > 0);
const report = {
  package: root.name,
  version: root.version,
  generatedAt: new Date().toISOString(),
  node: process.version,
  npm: run('npm', ['--version']).stdout.trim(),
  artifacts,
  checks,
  smoke,
  workingTreeEntries: modified.length,
  failures
};
fs.writeFileSync(path.join(releaseDir, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const notes = `# harness-reflex / dsh-harness-reflex ${root.version} — release artifacts

Generated by \`npm run release\` (\`scripts/release-pack.mjs\`) on ${report.generatedAt} with node ${report.node}, npm ${report.npm}.

## Artifacts

| File | Size | Entries | sha256 |
| --- | --- | --- | --- |
${artifacts.map((artifact) => `| \`release/${artifact.file}\` | ${String(Math.round(artifact.bytes / 1024))} KiB | ${String(artifact.entries)} | \`${artifact.sha256.slice(0, 16)}…\` |`).join('\n')}

Install either one directly:

\`\`\`bash
npm install ./release/${path.basename(rootTarball)}
# the DSH host plugin installs through the dsh CLI; its core is vendored, so no
# separate harness-reflex version range is resolved
dsh plugin --profile web add --force ./release/${path.basename(pluginTarball)}
\`\`\`

## What is verified

${checks.map((entry) => `- ${entry.ok ? '✅' : '❌'} ${entry.name}${entry.detail.length > 0 ? ` (${entry.detail})` : ''}`).join('\n')}

The audit runs against the real entry list of each tarball, not against the
manifest: it extracts both packages, checks every required file, forbids test
builds, temporary directories and absolute developer paths, and resolves every
relative import, \`require\` and source-map target inside the extracted tree.
The root package is then installed offline with \`npm install\`, its \`bin\`, its
named import and the stdio MCP \`tools/list\` handshake are exercised.

## Contents

- \`harness-reflex\` — core runtime, CLI, stdio MCP server, adapters, backend
  implementations, \`dist/\` with declarations and self-contained source maps,
  \`README.md\`, \`USER_GUIDE.md\`, \`docs/\` and the \`experiments/\` sources.
- \`dsh-harness-reflex\` (\`dsh-harness-reflex-<version>.tgz\`) — DSH Host plugin: \`dist/\`, the single-file browser half
  \`client.js\` (settings panel **including the embedded user guide**),
  \`cordis.patch.yml\` and \`locale/\`.

Full checklist: \`release/release-report.json\`. Manual: [\`USER_GUIDE.md\`](../USER_GUIDE.md)
(English: [\`docs/USER_GUIDE.en.md\`](../docs/USER_GUIDE.en.md)).
`;
fs.writeFileSync(path.join(releaseDir, `RELEASE-${root.version}.md`), notes, 'utf8');

console.log(`\nrelease-pack: ${artifacts.map((artifact) => `${artifact.file} (${String(artifact.entries)} entries, ${String(Math.round(artifact.bytes / 1024))} KiB)`).join(' + ')}`);
console.log(`release-pack: ${String(checks.length - failures.length)}/${String(checks.length)} checks passed`);

if (!keepScratch) fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`release-pack: ${String(failures.length)} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

//#endregion
