#!/usr/bin/env node
/**
 * Embed the user guide into the browser half of `dsh-reflex`.
 *
 * The settings panel renders the very same Markdown the repository ships as
 * `USER_GUIDE.md` (Chinese) and `docs/USER_GUIDE.en.md` (English). A client
 * bundle cannot `fetch` a repository file, and a second hand-maintained copy
 * inside the bundle would drift within one release — so the Markdown files stay
 * the single source of truth and this step compiles them into a generated
 * module the TypeScript client build picks up.
 *
 * Both files are hashed into the artifact: `USER_GUIDE_DIGESTS` lets
 * `src/guide.test.ts` prove that the bundle the panel loads carries *this*
 * revision of the document, and lets a release reader tell which revision was
 * packaged.
 *
 * Usage: node scripts/embed-user-guide.mjs [--check]
 *   --check   write nothing; exit 1 when the generated module is stale
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'packages', 'dsh-reflex', 'src', 'client', 'guide.generated.ts');

/** Source documents, in both supported languages. */
const SOURCES = {
  zh: 'USER_GUIDE.md',
  en: path.join('docs', 'USER_GUIDE.en.md')
};

const checkOnly = process.argv.includes('--check');

/** Read one guide document, refusing an empty or unreadable file. */
function readGuide(relative) {
  const absolute = path.join(repoRoot, relative);
  const text = fs.readFileSync(absolute, 'utf8');
  if (text.trim().length === 0) throw new Error(`embed-user-guide: ${relative} is empty`);
  return { absolute, relative, text, digest: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** Render the generated module exactly as it is written to disk. */
function render(documents) {
  const line = (name, value) => `export const ${name} = ${JSON.stringify(value)};`;
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' *',
    ' * Produced by `node scripts/embed-user-guide.mjs` from the repository documents,',
    ' * which are the single source of truth for the in-panel guide:',
    ...Object.values(documents).map((document) => ` *   - ${document.relative} (sha256 ${document.digest})`),
    ' *',
    ' * `npm run build:all` regenerates this module before the browser half is compiled;',
    ' * `npm run test:plugin` fails when the digests no longer match the documents.',
    ' */',
    '',
    '/** Document paths, relative to the repository root. */',
    `export const GUIDE_SOURCES = ${JSON.stringify(
      Object.fromEntries(Object.entries(documents).map(([language, document]) => [language, document.relative]))
    )} as const;`,
    '',
    '/** sha256 of each document, used to pin the packaged revision. */',
    `export const GUIDE_DIGESTS = ${JSON.stringify(
      Object.fromEntries(Object.entries(documents).map(([language, document]) => [language, document.digest]))
    )} as const;`,
    '',
    '/** Guide languages this build carries. */',
    `export const GUIDE_LANGUAGES = ${JSON.stringify(Object.keys(documents))} as const;`,
    '',
    ...Object.entries(documents).flatMap(([language, document]) => [
      `/** ${language} user guide, verbatim Markdown. */`,
      line(`GUIDE_${language.toUpperCase()}`, document.text),
      ''
    ])
  ].join('\n');
}

const documents = Object.fromEntries(Object.entries(SOURCES).map(([language, relative]) => [language, readGuide(relative)]));
const rendered = render(documents);

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
  if (current === rendered) {
    console.log(`embed-user-guide: up to date (${Object.values(documents).map((document) => document.digest.slice(0, 12)).join(', ')})`);
    process.exit(0);
  }
  console.error('embed-user-guide: guide.generated.ts is stale — run node scripts/embed-user-guide.mjs');
  process.exit(1);
}

const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
if (existing === rendered) {
  console.log(`embed-user-guide: unchanged (${path.relative(repoRoot, outputPath)})`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered, 'utf8');
  console.log(
    `embed-user-guide: wrote ${path.relative(repoRoot, outputPath)} ` +
      `(${Object.entries(documents)
        .map(([language, document]) => `${language} ${document.digest.slice(0, 12)} ${String(document.text.length)}B`)
        .join(', ')})`
  );
}
