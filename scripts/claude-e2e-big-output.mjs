#!/usr/bin/env node
/**
 * Deterministic oversized tool output for the Claude Code e2e.
 *
 * The mock prune drops progress bars and deep `node_modules/` lines; the rest
 * falls under the 50 % floor, so an active plugin installs a floored form with
 * a locator. No trailing newline: the e2e compares the retained original
 * byte-for-byte.
 */
const lines = [];
for (let index = 0; index < 160; index += 1) {
  lines.push(`[=== progress ${index % 100}% ===] downloading artifact ${index}`);
}
for (let index = 0; index < 10; index += 1) {
  lines.push(`line ${index}: generated output that the reduction may keep or drop`);
}
lines.push('node_modules/example/dist/index.js: 1 error');
lines.push('ERROR: cannot find module "example"');
process.stdout.write(lines.join('\n'));
