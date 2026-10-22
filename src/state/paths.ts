/**
 * Where the hook process keeps its external state, and which platform it may do
 * that on.
 *
 * A Claude Code command hook is a fresh process per event (design §3.1), so the
 * only thing two events share is a directory. The root is user-scoped rather
 * than project-scoped: a `.reflex/` next to the repository would be a git
 * pollutant, while `$XDG_STATE_HOME` is what the user's state directory is for.
 *
 * @module state/paths
 */
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/** Harness tag used for the state directory prefix; Claude Code for v0.2.0. */
export const DEFAULT_HARNESS = 'cc';

/** Environment variable that relocates the whole state root (design §3.2). */
export const STATE_DIR_ENV = 'HARNESS_REFLEX_STATE_DIR';

/**
 * Resolve the state root.
 *
 * Explicit `HARNESS_REFLEX_STATE_DIR` wins; otherwise the XDG state home
 * (`$XDG_STATE_HOME`, falling back to `~/.local/state`) plus `harness-reflex`.
 * @param env - environment to read (defaults to `process.env`).
 * @returns an absolute path to the state root.
 */
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[STATE_DIR_ENV]?.trim();
  if (explicit) return path.resolve(explicit);
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'harness-reflex');
  return path.join(os.homedir(), '.local', 'state', 'harness-reflex');
}

/**
 * The sixteen-hex-character identity of one session directory.
 *
 * The session id is hashed rather than used verbatim: it must never become a
 * path segment a host controls (design §3.4, "path traversal refused").
 * @param harness - harness tag.
 * @param sessionId - the host's session id.
 * @returns the first sixteen hex characters of `sha256(harness \0 sessionId)`.
 */
export function sessionHash(harness: string, sessionId: string): string {
  return createHash('sha256').update(`${harness}\u0000${sessionId}`).digest('hex').slice(0, 16);
}

/**
 * The directory name of one session: `cc-<sha16>`.
 * @param harness - harness tag.
 * @param sessionId - the host's session id.
 * @returns the directory name (a single, safe path segment).
 */
export function sessionDirName(harness: string, sessionId: string): string {
  return `${harness}-${sessionHash(harness, sessionId)}`;
}

/**
 * Refuse a platform whose filesystem semantics this store does not implement.
 *
 * The design names Windows explicitly: `mkdir` locks and `rename`-over-existing
 * behave differently there, so a silent degradation would be a correctness bug
 * rather than a portability gap. The hook reports the refusal on stderr and
 * exits non-zero (which every host treats as "abandoned, fail open").
 * @param platform - platform to check (defaults to `process.platform`).
 * @throws when the platform is Windows.
 */
export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new Error(
      'harness-reflex hook: Windows is not supported; this state store relies on POSIX mkdir locks, ' +
        'rename-over-existing and single-write O_APPEND semantics. Run Claude Code hooks under WSL2, Linux, or macOS.'
    );
  }
}
