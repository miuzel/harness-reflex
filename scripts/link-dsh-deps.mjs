#!/usr/bin/env node
/**
 * Link the local DeepSeek Harness (DSH) installation into this checkout so that
 * `packages/dsh-reflex` can be type-checked, built, and tested without
 * publishing it or reaching a registry.
 *
 * The plugin declares its Host contract as peerDependencies
 * (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`);
 * at runtime the Host supplies them. For local development we symlink the exact
 * copies the installed `dsh` binary resolves, which keeps a single physical
 * copy of every module — so the plugin and the Host share one Cordis instance
 * instead of loading two.
 *
 * Idempotent: re-running only repairs missing or stale links, and never
 * overwrites a real directory.
 *
 * Usage: node scripts/link-dsh-deps.mjs [--check]
 *   --check  report what would change, write nothing (exit 1 when links are missing)
 *
 * Override discovery with DSH_HOST_MODULES=<dir containing @deepseek-ai> or
 * DSH_BIN=<path to the dsh executable>.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'packages', 'dsh-reflex');

/** Modules the plugin resolves from the Host at build/test time. */
const HOST_MODULES = [
  '@deepseek-ai/cordis',
  // The loader is used by `live-config.test.ts` to reproduce the real
  // config-only commit path; it is a Host module, never a runtime dependency.
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/schemastery',
  'zod',
];

const checkOnly = process.argv.includes('--check');

/** Run a command and return its trimmed stdout, or undefined when it fails. */
function tryExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Resolve a real (symlink-free) path, tolerating a missing target. */
function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Locate the `node_modules` directory that holds the installed `@deepseek-ai` scope. */
function findDshPackageDir() {
  const candidates = [];
  if (process.env.DSH_HOST_MODULES) candidates.push(process.env.DSH_HOST_MODULES);

  const dshBin = process.env.DSH_BIN ?? tryExec('which', ['dsh']);
  if (dshBin) {
    const realBin = realpathOrNull(dshBin) ?? dshBin;
    // <pkg>/lib/bin.js -> <pkg>/node_modules
    candidates.push(path.join(path.dirname(path.dirname(realBin)), 'node_modules'));
  }

  const npmRoot = tryExec('npm', ['root', '-g']);
  if (npmRoot) candidates.push(path.join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules'));

  candidates.push(
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions', process.version, 'installation', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, '@deepseek-ai', 'cordis', 'package.json'))) return candidate;
  }
  return undefined;
}

/** Create or repair one directory symlink. Returns a human-readable action. */
function ensureLink(linkPath, target) {
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      const resolved = path.resolve(path.dirname(linkPath), current);
      if (resolved === target) return `ok      ${linkPath}`;
      if (checkOnly) return `stale   ${linkPath} -> ${current}`;
      fs.unlinkSync(linkPath);
      fs.symlinkSync(target, linkPath, 'dir');
      return `relink  ${linkPath} -> ${target}`;
    }
    return `skip    ${linkPath} (real file/directory already present)`;
  }
  if (checkOnly) return `missing ${linkPath}`;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
  return `link    ${linkPath} -> ${target}`;
}

const hostDir = findDshPackageDir();
const actions = [];

// The plugin's own package directory always resolves the workspace root first.
actions.push(ensureLink(path.join(pluginRoot, 'node_modules', 'harness-reflex'), repoRoot));

if (hostDir) {
  for (const moduleName of HOST_MODULES) {
    const target = path.join(hostDir, ...moduleName.split('/'));
    if (!fs.existsSync(path.join(target, 'package.json'))) {
      actions.push(`absent  ${moduleName} (not installed beside dsh)`);
      continue;
    }
    actions.push(ensureLink(path.join(pluginRoot, 'node_modules', ...moduleName.split('/')), fs.realpathSync(target)));
  }
} else {
  actions.push("absent  DSH installation not found: set DSH_HOST_MODULES=<node_modules dir containing @deepseek-ai>");
}

for (const action of actions) console.log(action);

const unresolved = actions.filter((action) => /^(missing|stale|absent)/.test(action));
if (checkOnly) {
  console.log(unresolved.length === 0 ? '\nlink check: every DSH dependency is linked' : `\nlink check: ${unresolved.length} unresolved entry(ies)`);
  process.exit(unresolved.length === 0 ? 0 : 1);
}
console.log(`\nlinked ${actions.filter((a) => a.startsWith('link') || a.startsWith('relink')).length} new link(s)`);
