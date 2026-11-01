#!/usr/bin/env node
/**
 * Mirror the harness-agnostic decision core into the DSH plugin's vendor tree.
 *
 * The plugin is a separate package: its `tsconfig.json` owns `src/`, so it
 * cannot import the root package's `src/core/**` or `src/ports/**` at build
 * time. The vendored copy is therefore generated from the single source of
 * truth rather than hand-maintained — `src/core/**` and `src/ports/**` stay the
 * only place a decision rule is edited, and this script keeps the plugin's copy
 * byte-identical (the architecture test asserts the equality).
 *
 * Usage: node scripts/sync-vendor-core.mjs [--check]
 *   --check  report drift and exit 1 without writing anything.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(repoRoot, 'packages', 'dsh-harness-reflex', 'src', 'vendor', 'harness-reflex');
const checkOnly = process.argv.includes('--check');

/**
 * The modules the plugin vendors.
 *
 * Directories are mirrored in full (minus tests); `core` names its new modules
 * explicitly because the plugin's vendor `core/` also carries the older,
 * hand-ported decision modules that predate this split.
 */
const CORE_MODULES = [
  'text.ts',
  'policy.ts',
  'judge.ts',
  'closing.ts',
  'evidence.ts',
  'prune-plan.ts',
  'orchestrate.ts',
  'orchestrate-stagnation.ts'
];
const PORT_DIR = 'ports';

/** Read one file as UTF-8, or undefined when it does not exist. */
function read(target) {
  return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
}

/** Write one file, creating its directory. */
function write(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const drift = [];
let written = 0;

for (const name of CORE_MODULES) {
  const source = path.join(repoRoot, 'src', 'core', name);
  const target = path.join(vendorRoot, 'core', name);
  const text = read(source);
  if (text === undefined) throw new Error(`missing core source: ${path.relative(repoRoot, source)}`);
  if (read(target) !== text) {
    drift.push(path.relative(repoRoot, target));
    if (!checkOnly) {
      write(target, text);
      written += 1;
    }
  }
}

const portSource = path.join(repoRoot, 'src', PORT_DIR);
const portTarget = path.join(vendorRoot, PORT_DIR);
for (const name of readdirSync(portSource).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts')).sort()) {
  const text = read(path.join(portSource, name));
  if (text === undefined) continue;
  const target = path.join(portTarget, name);
  if (read(target) !== text) {
    drift.push(path.relative(repoRoot, target));
    if (!checkOnly) {
      write(target, text);
      written += 1;
    }
  }
}

if (checkOnly) {
  if (drift.length > 0) {
    console.error(`vendored core is out of date:\n${drift.map((file) => `  ${file}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('vendored core is in sync');
  }
} else {
  console.log(written === 0 ? 'vendored core already in sync' : `synced ${written} file(s) into packages/dsh-harness-reflex/src/vendor/harness-reflex`);
}
