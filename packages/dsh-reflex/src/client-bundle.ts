/**
 * Bundler for the browser half of this plugin.
 *
 * DSH serves a client plugin as **one** artifact: `dsh.client` names an
 * `exports["./client"]` entry, and the host hands that file's
 * `__ModuleLoader__.load({ id, factory })` call a `require` that resolves
 * *package ids and platform seed words only*. A plugin's own internal modules
 * therefore cannot be reached with `require("./x")` at runtime — the dynamic
 * form (`require.async`) would need separately served chunks — so the artifact
 * has to be self-contained.
 *
 * This step produces exactly that, and refuses to guess while doing it:
 *
 * - The browser sources are compiled to CommonJS by `tsconfig.client.json`, so
 *   no source rewriting happens here. The bundler only *wraps* what `tsc` emits,
 *   which is why it can be this small: `require("./panel")` in the emitted code
 *   is already the call shape a local factory registry answers.
 * - Every non-relative specifier must appear in {@link ALLOWED_SEEDS}, and every
 *   relative one must name a bundled module. Anything else fails the build
 *   instead of the page: at runtime an unresolvable specifier throws inside the
 *   module table and the plugin never activates.
 * - `verifyClientPackage` cross-checks the artifact against the manifest, so
 *   `dsh.client.external`, `exports["./client"]`, and `files` cannot drift away
 *   from what the bundle actually needs.
 *
 * @module dsh-reflex/client-bundle
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `__ModuleLoader__` id of the bundle; the package name. */
export const CLIENT_BUNDLE_ID = 'dsh-reflex';

/** Bundled module key the factory block executes first. */
export const CLIENT_ENTRY_KEY = 'index';

/**
 * Module specifiers the bundle may require from the platform.
 *
 * The shell's seed table is the only source of shared modules for a client
 * bundle, and `react` is the one entry this plugin needs. Growing this list is a
 * deliberate act: every addition must be a documented seed word, or the require
 * throws at materialization time in the browser.
 */
export const ALLOWED_SEEDS: readonly string[] = ['react'];

/** Package-relative path of the committed artifact. */
export const BUNDLE_RELATIVE_PATH = 'client.js';

/** Directory the browser sources are compiled into. */
export const CLIENT_OUT_DIR = 'dist-client';

/** One compiled module on its way into the bundle. */
export interface BundleSource {
  /** Module key: the file's basename without its extension. */
  key: string;
  /** Compiled CommonJS body. */
  code: string;
}

/** Result of wrapping a set of compiled modules into one artifact. */
export interface BuiltBundle {
  /** The artifact text. */
  code: string;
  /** Module keys in emission order. */
  keys: string[];
  /** Non-relative specifiers the bundle requires, sorted. */
  externals: string[];
  /** Relative specifiers and the keys they resolved to. */
  localEdges: { spec: string; key: string }[];
}

/** One lexical token of a compiled module, comments excluded. */
export interface Token {
  kind: 'name' | 'string' | 'punct';
  /** Identifier text, string contents with escapes intact, or one punctuation character. */
  value: string;
}

/**
 * Tokenize JavaScript well enough to recognize `require(...)` calls.
 *
 * A regex over the raw text is not sufficient here: this package's prose
 * *discusses* `require` calls, and its doc comments and string literals both
 * contain parentheses, quotes and slashes. Tokenizing removes comments, keeps
 * string literals as single tokens (so a specifier is unambiguous), and drops
 * everything else into names and punctuation. Template literals are taken
 * whole — no bundled module interpolates a `require` call into one, and the
 * scanner is a build gate, not a parser.
 *
 * @param code - compiled CommonJS source.
 * @returns tokens in source order.
 */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index] as string;
    const next = code[index + 1];
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', index);
      index = end === -1 ? code.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2);
      index = end === -1 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let value = '';
      index += 1;
      while (index < code.length) {
        const inner = code[index] as string;
        index += 1;
        if (inner === '\\') {
          value += inner + ((code[index] as string) ?? '');
          index += 1;
          continue;
        }
        if (inner === quote) break;
        value += inner;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = char;
      index += 1;
      while (index < code.length && /[A-Za-z0-9_$]/.test(code[index] as string)) {
        value += code[index] as string;
        index += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    tokens.push({ kind: 'punct', value: char });
    index += 1;
  }
  return tokens;
}

/**
 * Collect every module specifier a compiled module requires.
 * @param code - compiled CommonJS source.
 * @returns specifiers in source order, without duplicates.
 */
export function collectRequires(code: string): string[] {
  const tokens = tokenize(code);
  const found: string[] = [];
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if ((tokens[index] as Token).value !== 'require' || (tokens[index] as Token).kind !== 'name') continue;
    if ((tokens[index + 1] as Token).value !== '(') continue;
    const spec = tokens[index + 2] as Token;
    if (spec.kind !== 'string' || (tokens[index + 3] as Token).value !== ')') continue;
    if (!found.includes(spec.value)) found.push(spec.value);
  }
  return found;
}

/** Resolve one relative specifier to a bundled module key. */
function keyOf(spec: string): string {
  return spec.replace(/^\.\//, '');
}

/**
 * Wrap compiled modules into one `__ModuleLoader__.load` artifact.
 *
 * @param sources - compiled modules, entry included.
 * @param options - bundle id, entry key, and the platform specifiers allowed.
 * @returns the artifact plus the edges it was built from.
 * @throws Error when the entry is absent, a relative specifier has no module, or a non-relative one is not an allowed seed.
 */
export function buildBundle(
  sources: readonly BundleSource[],
  options: { id?: string; entry?: string; allowedSeeds?: readonly string[] } = {}
): BuiltBundle {
  const id = options.id ?? CLIENT_BUNDLE_ID;
  const entry = options.entry ?? CLIENT_ENTRY_KEY;
  const allowedSeeds = options.allowedSeeds ?? ALLOWED_SEEDS;
  const byKey = new Map<string, string>();
  for (const source of sources) {
    if (byKey.has(source.key)) throw new Error(`client-bundle: duplicate module key "${source.key}"`);
    byKey.set(source.key, source.code);
  }
  if (!byKey.has(entry)) throw new Error(`client-bundle: the module set has no entry module "${entry}"`);

  const externals = new Set<string>();
  const localEdges: { spec: string; key: string }[] = [];
  for (const source of sources) {
    for (const spec of collectRequires(source.code)) {
      if (!spec.startsWith('./')) {
        if (!allowedSeeds.includes(spec)) {
          throw new Error(
            `client-bundle: "${source.key}" requires "${spec}", which is neither a relative module nor an allowed platform seed ` +
              `(${allowedSeeds.join(', ')}) — a client bundle may only require seed words and its own bundled modules`
          );
        }
        externals.add(spec);
        continue;
      }
      const key = keyOf(spec);
      if (key.includes('/')) {
        throw new Error(`client-bundle: "${source.key}" requires "${spec}" — only flat sibling modules are bundled`);
      }
      if (!byKey.has(key)) throw new Error(`client-bundle: "${source.key}" requires "${spec}" but no module "${key}" is bundled`);
      localEdges.push({ spec, key });
    }
  }

  const ordered = sources.map((source) => source.key);
  const body = sources
    .map((source) => {
      const indented = source.code
        .split('\n')
        .map((line) => (line.length === 0 ? line : `\t\t\t${line}`))
        .join('\n');
      return `\t\t"${source.key}": function (module, exports, require) {\n${indented}\n\t\t}`;
    })
    .join(',\n');

  const code = `window.__ModuleLoader__.load({
\tid: "${id}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tvar __factories = {
${body}
\t\t};
\t\tvar __cache = Object.create(null);
\t\tvar __load = function (key) {
\t\t\tvar cached = __cache[key];
\t\t\tif (cached !== undefined) return cached.exports;
\t\t\tvar factory = __factories[key];
\t\t\tif (factory === undefined) throw new Error("client-modules: no bundled module \\"" + key + "\\" in ${id}");
\t\t\tvar record = { exports: {} };
\t\t\t__cache[key] = record;
\t\t\tfactory(record, record.exports, __require);
\t\t\treturn record.exports;
\t\t};
\t\tvar __require = function (spec) {
\t\t\tif (spec.charCodeAt(0) === 46) return __load(spec.replace(/^\\.\\//, ""));
\t\t\treturn require(spec);
\t\t};
\t\t__cache["${entry}"] = module;
\t\t__factories["${entry}"](module, module.exports, __require);
\t\treturn module.exports;
\t}
});
`;

  return { code, keys: ordered, externals: [...externals].sort(), localEdges };
}

/**
 * Read every compiled module of a directory.
 * @param directory - the directory holding the compiled browser half.
 * @returns one source per `.js` file, entry first and the rest alphabetically.
 */
export function readSources(directory: string): BundleSource[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort();
  if (names.length === 0) {
    throw new Error(`client-bundle: no compiled modules in ${directory} — run the client TypeScript build first`);
  }
  return names.map((name) => ({
    key: name.slice(0, -3),
    code: readFileSync(join(directory, name), 'utf8')
  }));
}

/** What one artifact build produced. */
export interface ClientArtifact {
  outputPath: string;
  bytes: number;
  keys: string[];
  externals: string[];
}

/**
 * Compile-time view of the package.json fields this artifact depends on.
 *
 * Only the fields that must agree with the bundle are modelled; everything else
 * is ignored rather than copied, so the verifier cannot silently accept a
 * manifest shape it did not intend to check.
 */
export interface BundledPackageManifest {
  name?: unknown;
  files?: unknown;
  exports?: unknown;
  dsh?: unknown;
}

/**
 * Build `client.js` from a compiled browser half.
 * @param options - package directory and optional source/output overrides.
 * @returns what was written.
 */
export function buildClientArtifact(options: {
  packageDir: string;
  sourceDir?: string;
  outputPath?: string;
}): ClientArtifact {
  const sourceDir = options.sourceDir ?? join(options.packageDir, CLIENT_OUT_DIR);
  const outputPath = options.outputPath ?? join(options.packageDir, BUNDLE_RELATIVE_PATH);
  const built = buildBundle(readSources(sourceDir));
  writeFileSync(outputPath, built.code);
  return { outputPath, bytes: Buffer.byteLength(built.code), keys: built.keys, externals: built.externals };
}

/**
 * Check a package manifest against its built artifact.
 * @param pkg - the parsed `package.json`.
 * @param bundle - the artifact description.
 * @param bundleExists - whether `exports["./client"]` resolves to a real file.
 * @returns one message per problem; empty means the manifest and artifact agree.
 */
export function verifyClientPackage(
  pkg: BundledPackageManifest,
  bundle: Pick<BuiltBundle, 'externals' | 'keys'> | ClientArtifact,
  bundleExists: boolean
): string[] {
  const problems: string[] = [];
  const dsh = pkg.dsh;
  const client = dsh !== null && typeof dsh === 'object' ? (dsh as { client?: unknown }).client : undefined;
  if (client === null || typeof client !== 'object') {
    problems.push('package.json declares no dsh.client block');
    return problems;
  }
  const declaration = client as { platform?: unknown; inject?: unknown; external?: unknown; immediately?: unknown };
  if (declaration.platform !== 'web') problems.push(`dsh.client.platform must be "web" (got ${JSON.stringify(declaration.platform)})`);
  if (pkg.name !== CLIENT_BUNDLE_ID) {
    problems.push(`package name ${JSON.stringify(pkg.name)} must equal the bundle id "${CLIENT_BUNDLE_ID}"`);
  }
  const external = Array.isArray(declaration.external) ? declaration.external.filter((item): item is string => typeof item === 'string') : [];
  for (const spec of bundle.externals) {
    if (!external.includes(spec)) problems.push(`the bundle requires platform module "${spec}" but dsh.client.external does not list it`);
  }
  for (const spec of external) {
    if (!bundle.externals.includes(spec)) {
      problems.push(`dsh.client.external lists "${spec}" but the bundle never requires it`);
    }
  }
  const exportsField = pkg.exports;
  const clientExport =
    exportsField !== null && typeof exportsField === 'object' ? (exportsField as Record<string, unknown>)['./client'] : undefined;
  const clientPath =
    typeof clientExport === 'string'
      ? clientExport
      : clientExport !== null && typeof clientExport === 'object'
        ? ((clientExport as { default?: unknown }).default as string | undefined)
        : undefined;
  if (clientPath === undefined) {
    problems.push('package.json exports no "./client" entry, so the browser half is unreachable');
  } else if (clientPath !== `./${BUNDLE_RELATIVE_PATH}`) {
    problems.push(`exports["./client"] is ${JSON.stringify(clientPath)}, expected "./${BUNDLE_RELATIVE_PATH}"`);
  } else if (!bundleExists) {
    problems.push(`exports["./client"] points at ${clientPath}, which does not exist — the artifact is missing or stale`);
  }
  const files = Array.isArray(pkg.files) ? pkg.files.filter((item): item is string => typeof item === 'string') : [];
  if (!files.includes(BUNDLE_RELATIVE_PATH)) problems.push(`package.json "files" does not include "${BUNDLE_RELATIVE_PATH}"`);
  if (bundle.keys.length === 0) problems.push('the bundle carries no modules');
  if (!bundle.keys.includes(CLIENT_ENTRY_KEY)) problems.push(`the bundle has no entry module "${CLIENT_ENTRY_KEY}"`);
  return problems;
}

/**
 * Command-line entry: build the artifact and print what it produced.
 * @param argv - process arguments; the third may name the package directory.
 * @returns the process exit code.
 */
export function main(argv: readonly string[]): number {
  const here = fileURLToPath(import.meta.url);
  const packageDir = resolve(argv[2] ?? dirname(dirname(here)));
  try {
    const artifact = buildClientArtifact({ packageDir });
    process.stdout.write(
      `client-bundle: wrote ${artifact.outputPath} (${String(artifact.bytes)} bytes, ${String(artifact.keys.length)} modules, externals: ${artifact.externals.join(', ') || 'none'})\n`
    );
    return 0;
  } catch (error) {
    process.stderr.write(`client-bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Run only when this file *is* the program: importing it from a test must not
// write artifacts as a side effect.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
