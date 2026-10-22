/**
 * FileStateStore fixtures: layout, locking, retention, corruption, and the
 * kill-and-replay invariance the design demands of append-only state.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FileStateStore, MAX_BAD_LINES, type FileStateStoreOptions, type HookLedgerRecord } from './file-store.js';
import { FixedClock } from './clock.js';
import {
  assertSupportedPlatform,
  resolveStateRoot,
  sessionDirName,
  sessionHash
} from './paths.js';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-store-'));
  roots.push(dir);
  return dir;
}

function storeFor(root: string, overrides: Partial<FileStateStoreOptions> = {}): FileStateStore {
  return new FileStateStore({ root, clock: new FixedClock(NOW), ...overrides });
}

function ledgerRecord(key: string, overrides: Partial<HookLedgerRecord> = {}): HookLedgerRecord {
  return {
    id: `id-${key}`,
    timestamp: new Date(NOW).toISOString(),
    type: 'noop',
    harness: 'cc',
    event: 'pretooluse',
    backend: 'mock',
    latencyMs: 0,
    dedupeKey: key,
    turnNo: 0,
    ...overrides
  };
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('state root: explicit env, XDG, and default all resolve', () => {
  assert.equal(resolveStateRoot({ HARNESS_REFLEX_STATE_DIR: '/tmp/explicit' } as NodeJS.ProcessEnv), path.resolve('/tmp/explicit'));
  assert.equal(
    resolveStateRoot({ XDG_STATE_HOME: '/tmp/xdg' } as NodeJS.ProcessEnv),
    path.join(path.resolve('/tmp/xdg'), 'harness-reflex')
  );
  const fallback = resolveStateRoot({} as NodeJS.ProcessEnv);
  assert.ok(fallback.endsWith(path.join('.local', 'state', 'harness-reflex')));
});

test('session identity is a 16-hex hash and never the raw id', () => {
  const hash = sessionHash('cc', '../../etc/passwd');
  assert.match(hash, /^[0-9a-f]{16}$/);
  const name = sessionDirName('cc', '../../etc/passwd');
  assert.equal(name, `cc-${hash}`);
  assert.ok(!name.includes('..'));
  assert.ok(!name.includes('/'));
});

test('ensureSession creates the documented layout, meta, and 0700/0600 modes', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('session-1', 'active');
  assert.equal(paths.dir, path.join(root, 'sessions', sessionDirName('cc', 'session-1')));
  assert.ok(fs.existsSync(paths.meta));
  assert.ok(fs.existsSync(paths.events));
  assert.ok(fs.existsSync(paths.ledger));
  assert.ok(fs.statSync(paths.originals).isDirectory());
  assert.ok(fs.statSync(paths.decisions).isDirectory());
  const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8')) as { sessionId: string; mode: string };
  assert.equal(meta.sessionId, 'session-1');
  assert.equal(meta.mode, 'active');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.meta).mode & 0o777, 0o600);
  }
});

test('a directory whose meta hashes elsewhere is quarantined under orphans/', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('real-session', 'active');
  fs.writeFileSync(paths.meta, `${JSON.stringify({ harness: 'cc', sessionId: 'some-other-session', createdAt: 'x', harnessVersion: 'x', mode: 'active' })}\n`);
  const ensured = store.ensureSession('real-session', 'active');
  assert.ok(fs.existsSync(ensured.meta));
  const meta = JSON.parse(fs.readFileSync(ensured.meta, 'utf8')) as { sessionId: string };
  assert.equal(meta.sessionId, 'real-session');
  const orphans = fs.readdirSync(path.join(root, 'orphans'));
  assert.equal(orphans.length, 1);
  assert.ok(orphans[0]!.startsWith(sessionDirName('cc', 'real-session')));
});

test('events and ledger are single-write JSONL appends that read back', () => {
  const root = tempRoot();
  const store = storeFor(root);
  store.ensureSession('s', 'active');
  store.appendEvent('s', { v: 1, kind: 'pre', at: NOW, atIso: new Date(NOW).toISOString(), turnNo: 0, tool: 'Bash', signature: 'Bash:abc' });
  store.appendLedger('s', ledgerRecord('k1'));
  store.appendLedger('s', ledgerRecord('k2', { type: 'prune', tokensSaved: 12 }));
  const events = store.readEvents('s');
  const ledger = store.readLedger('s');
  assert.equal(events.length, 1);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1]!.tokensSaved, 12);
  assert.equal(store.ledgerHasKey('s', 'k2'), true);
  assert.equal(store.ledgerHasKey('s', 'missing'), false);
});

test('a fresh lock blocks updateState; a stale lock is taken over', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('s', 'active');
  fs.mkdirSync(paths.lock);
  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: 999, startedMs: NOW }));
  const blocked = store.updateState('s', (state) => {
    state.turnNo += 1;
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, 'lock-contention');
  assert.ok(fs.existsSync(paths.lock));

  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: 999, startedMs: NOW - 10_000 }));
  const taken = store.updateState('s', (state) => {
    state.turnNo += 1;
    return state.turnNo;
  });
  assert.equal(taken.acquired, true);
  assert.equal(taken.value, 1);
  assert.equal(fs.existsSync(paths.lock), false);
});

test('state.json is a discardable cache: corrupt and truncated files rebuild from logs', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('s', 'active');
  store.appendEvent('s', { v: 1, kind: 'stop', at: NOW, atIso: new Date(NOW).toISOString(), turnNo: 1 });
  store.appendEvent('s', { v: 1, kind: 'stop', at: NOW, atIso: new Date(NOW).toISOString(), turnNo: 2 });
  fs.writeFileSync(paths.state, '{"version":1,"turnNo":');
  const rebuilt = store.readState('s');
  assert.equal(rebuilt.turnNo, 2);
  fs.writeFileSync(paths.state, 'not json');
  const again = store.readState('s');
  assert.equal(again.turnNo, 2);
  assert.ok(fs.existsSync(paths.state));
});

test('bad JSONL lines are isolated; more than five void the whole read', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('s', 'active');
  store.appendLedger('s', ledgerRecord('good'));
  fs.appendFileSync(paths.ledger, '{"half": \n');
  const records = store.readLedger('s');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.dedupeKey, 'good');
  const corruptLogs = fs.readdirSync(paths.dir).filter((name) => name.startsWith('corrupt-'));
  assert.equal(corruptLogs.length, 1);

  for (let index = 0; index < MAX_BAD_LINES; index += 1) {
    fs.appendFileSync(paths.ledger, `broken-line-${index}\n`);
  }
  assert.deepEqual(store.readLedger('s'), []);
});

test('retention enforces the cap, evicts oldest first, and downgrades when it cannot fit', () => {
  const root = tempRoot();
  const store = storeFor(root);
  const paths = store.ensureSession('s', 'active');
  // File mtimes are what LRU reads; assign distinct ages instead of sleeping.
  const first = store.retainOriginal('s', 'aaa', 'x'.repeat(60));
  assert.equal(first.retained, true);
  const firstFile = path.join(paths.originals, 'aaa.txt');
  fs.utimesSync(firstFile, new Date(NOW - 20_000), new Date(NOW - 20_000));
  const second = store.retainOriginal('s', 'bbb', 'y'.repeat(60));
  assert.equal(second.retained, true);
  const secondFile = path.join(paths.originals, 'bbb.txt');
  fs.utimesSync(secondFile, new Date(NOW - 10_000), new Date(NOW - 10_000));
  const capped = storeFor(root, { maxOriginalBytes: 120 });
  const evicting = capped.retainOriginal('s', 'ccc', 'z'.repeat(30));
  assert.equal(evicting.retained, true);
  assert.deepEqual(evicting.evicted, ['aaa']);
  assert.ok(!fs.existsSync(firstFile));
  assert.ok(fs.existsSync(path.join(paths.originals, 'bbb.txt')));

  const tooSmall = storeFor(root, { maxOriginalBytes: 10 });
  const refused = tooSmall.retainOriginal('s', 'ddd', 'w'.repeat(100));
  assert.equal(refused.retained, false);
  assert.equal(refused.reason, 'retention-cap');
  assert.ok(fs.existsSync(path.join(paths.originals, 'bbb.txt')));
});

test('gcSessions removes only directories older than seven days', () => {
  const root = tempRoot();
  const clock = new FixedClock(NOW);
  const store = new FileStateStore({ root, clock });
  const oldPaths = store.ensureSession('old', 'active');
  const freshPaths = store.ensureSession('fresh', 'active');
  const old = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(oldPaths.dir)) {
    fs.utimesSync(path.join(oldPaths.dir, entry), old, old);
  }
  fs.utimesSync(oldPaths.dir, old, old);
  const removed = store.gcSessions();
  assert.deepEqual(removed, [path.basename(oldPaths.dir)]);
  assert.equal(fs.existsSync(oldPaths.dir), false);
  assert.equal(fs.existsSync(freshPaths.dir), true);
});

test('gcOriginals trims one session to the cap', () => {
  const root = tempRoot();
  const store = storeFor(root, { maxOriginalBytes: 100 });
  store.ensureSession('s', 'active');
  const first = store.retainOriginal('s', 'one', 'a'.repeat(60));
  const second = store.retainOriginal('s', 'two', 'b'.repeat(60));
  assert.equal(first.retained, true);
  assert.equal(second.retained, true);
  assert.deepEqual(second.evicted, ['one']);
  assert.deepEqual(store.gcOriginals('s'), []);
  // A file written outside retain (e.g. before the cap was lowered) is trimmed.
  fs.writeFileSync(path.join(store.sessionPaths('s').originals, 'three.txt'), 'c'.repeat(200));
  assert.deepEqual(store.gcOriginals('s').sort(), ['three', 'two']);
});

test('Windows is refused explicitly rather than degraded', () => {
  assert.throws(() => assertSupportedPlatform('win32'), /Windows is not supported/);
  assert.doesNotThrow(() => assertSupportedPlatform('linux'));
});

test('kill -9 mid-append then replay loses nothing and duplicates nothing', async () => {
  const root = tempRoot();
  const storeUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'file-store.js')).href;
  const script = `
    const { FileStateStore } = await import(${JSON.stringify(storeUrl)});
    const store = new FileStateStore({ root: process.env.KILL_ROOT });
    store.ensureSession('kill-session', 'active');
    const total = 500;
    for (let i = 0; i < total; i += 1) {
      const key = 'k' + i;
      if (store.ledgerHasKey('kill-session', key, 10000)) continue;
      store.appendLedger('kill-session', {
        id: 'id-' + key, timestamp: new Date(0).toISOString(), type: 'noop', harness: 'cc',
        event: 'pretooluse', backend: 'mock', latencyMs: 0, dedupeKey: key, turnNo: 0
      });
      store.writeDecision('kill-session', key, { i });
    }
  `;
  const store = storeFor(root);
  const ledgerPath = path.join(store.sessionDir('kill-session'), 'ledger.jsonl');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env: { ...process.env, KILL_ROOT: root } });
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).length;
        if (lines >= 20) {
          clearInterval(timer);
          child.kill('SIGKILL');
          resolve();
        }
      } catch {
        // not created yet
      }
    }, 5);
    child.on('exit', () => {
      clearInterval(timer);
      resolve();
    });
  });
  await new Promise((resolve) => child.on('close', resolve));

  const replay = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env: { ...process.env, KILL_ROOT: root } });
  const code = await new Promise<number>((resolve) => replay.on('exit', (value) => resolve(value ?? -1)));
  assert.equal(code, 0);

  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 500);
  const keys = new Set<string>();
  for (const line of lines) {
    const record = JSON.parse(line) as { dedupeKey: string };
    assert.equal(keys.has(record.dedupeKey), false, `duplicate ${record.dedupeKey}`);
    keys.add(record.dedupeKey);
  }
  assert.equal(keys.size, 500);
});
