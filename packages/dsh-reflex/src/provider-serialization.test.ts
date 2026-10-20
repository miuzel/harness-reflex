import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

/**
 * 8.1 coverage at the provider boundary: what the *installed* serializers send
 * for a decided effort, and what they refuse to send.
 *
 * The DeepSeek and OpenAI-compatible serializers live in sibling packages of the
 * harness (`@deepseek-ai/dsh-llm-deepseek`, `@earendil-works/pi-ai`) that this
 * package does not depend on and cannot import. Driving them for real would mean
 * loading a foreign module graph and hand-mocking its transport, so instead these
 * tests pin the wire contract structurally, against the source that is actually
 * installed next to the running harness: a request-body shape that changes there
 * must fail here, and the tests skip (never silently pass) when the package is
 * absent. The behavioural half of 8.1 — that the engine never lets the adaptive
 * marker reach a provider — is covered by `adaptive-effort-surface.test.ts` and
 * `router.test.ts`.
 */

/**
 * Directory holding the harness's own installed dependency packages.
 * @returns the `node_modules` directory, or `undefined` when it cannot be located.
 */
function upstreamModulesDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // `<modules>/@deepseek-ai/dsh-llm/package.json` → `<modules>`.
    return dirname(dirname(dirname(realpathSync(require.resolve('@deepseek-ai/dsh-llm/package.json')))));
  } catch {
    return undefined;
  }
}

/**
 * Read one installed sibling package file.
 * @param relativePath - path below the harness's `node_modules`.
 * @returns the source text, or `undefined` when the file is not installed.
 */
function upstreamSource(relativePath: string): string | undefined {
  const modules = upstreamModulesDir();
  if (modules === undefined) return undefined;
  const file = join(modules, relativePath);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

const DEEPSEEK = '@deepseek-ai/dsh-llm-deepseek/lib/index.js';
const OPENAI_COMPLETIONS = '@earendil-works/pi-ai/dist/api/openai-completions.js';
const PI_AI_WRAPPER = '@deepseek-ai/dsh-llm-pi-ai/lib/index.js';

test('the installed DeepSeek serializer encodes the decided effort in the request body', (t) => {
  const source = upstreamSource(DEEPSEEK);
  if (source === undefined) return t.skip(`${DEEPSEEK} is not installed next to the harness`);

  assert.match(
    source,
    /const effort = options\.reasoningEffort \?\? connection\.defaults\.reasoningEffort \?\? \(connection\.defaults\.thinking === "disabled" \? "off" : "high"\);/,
    'the request-level effort must win over the connection default and the thinking flag'
  );
  assert.match(
    source,
    /thinking: \{ type: effort === "off" \? "disabled" : "enabled" \}/,
    'off must disable thinking rather than send a level'
  );
  assert.match(
    source,
    /\.\.\.effort === "off" \? \{\} : \{ output_config: \{ effort \} \}/,
    'a decided low/high/max must cross the wire as output_config.effort'
  );
});

test('the installed DeepSeek serializer refuses every level outside its own vocabulary', (t) => {
  const source = upstreamSource(DEEPSEEK);
  if (source === undefined) return t.skip(`${DEEPSEEK} is not installed next to the harness`);

  assert.match(
    source,
    /if \(!\[\s*"off",\s*"low",\s*"high",\s*"max"\s*\]\.includes\(effort\)/,
    'the adapter must white-list exactly the levels it can encode'
  );
  assert.match(source, /UNSUPPORTED_REASONING_EFFORT/, 'and reject anything else with the documented error code');
  assert.doesNotMatch(
    source,
    /reflex/i,
    'the adaptive marker is engine-side: the provider adapter must never learn about it'
  );
});

test('the installed OpenAI-compatible serializer crosses the level verbatim and omits it for a non-thinking model', (t) => {
  const source = upstreamSource(OPENAI_COMPLETIONS);
  if (source === undefined) return t.skip(`${OPENAI_COMPLETIONS} is not installed next to the harness`);

  assert.match(
    source,
    /const reasoningEffort = clampedReasoning === "off" \? undefined : clampedReasoning;/,
    'off must mean "send no reasoning option", which is what makes a non-thinking model safe'
  );
  assert.match(
    source,
    /params\.reasoning_effort = model\.thinkingLevelMap\?\.\[options\.reasoningEffort\] \?\? options\.reasoningEffort;/,
    'the decided low/medium/high must reach the request unchanged (or through the model map)'
  );

  // Every `reasoning_effort` assignment must sit in a branch guarded by
  // `model.reasoning`, so a catalog entry that declares no reasoning never
  // receives a reasoning option at all.
  const assignments = [...source.matchAll(/params\.reasoning_effort =/g)];
  assert.ok(assignments.length >= 1, 'the OpenAI-compatible request builder is expected to map reasoning_effort');
  for (const assignment of assignments) {
    const guard = source.slice(Math.max(0, (assignment.index ?? 0) - 500), assignment.index);
    assert.match(
      guard,
      /model\.reasoning/,
      `an unguarded reasoning_effort assignment at offset ${assignment.index} would send the field to a non-thinking model`
    );
  }
});

test('the installed pi-ai wrapper validates an explicit level instead of clamping it', (t) => {
  const source = upstreamSource(PI_AI_WRAPPER);
  if (source === undefined) return t.skip(`${PI_AI_WRAPPER} is not installed next to the harness`);

  assert.match(
    source,
    /function resolveReasoningLevel\(model, effort\) \{\s*if \(effort === void 0\) return void 0;\s*if \(getSupportedThinkingLevels\(model\)\.some\(\(level\) => level === effort\)\) return effort;/,
    'an explicit effort must be accepted only when the model declares it'
  );
  assert.match(
    source,
    /does not support reasoning effort "\$\{effort\}"`, "UNSUPPORTED_REASONING_EFFORT"\);/,
    'an undeclared effort must be refused, which is the boundary the engine projects onto before dispatch'
  );
  assert.match(
    source,
    /const enabledReasoning = reasoning === "off" \? void 0 : reasoning;/,
    'off must drop the reasoning option entirely, matching the DeepSeek adapter'
  );
  assert.match(
    source,
    /\.\.\.enabledReasoning === void 0 \? \{\} : \{ reasoning: enabledReasoning \}/,
    'and no reasoning key is sent in its place'
  );
});
