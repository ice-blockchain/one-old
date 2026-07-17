import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import {
  ONE_SETTINGS_LOCK_TIMEOUT_MS,
  deleteOneSection,
  oneSettingsPath,
  readOneSettings,
  updateOneSettings,
  writeOneSection,
} from '../one-settings';
import {
  applyGlobalCodeGraphProvider,
  readGlobalCodeGraphProvider,
  writeGlobalCodeGraphProvider,
} from '../state';

// Run a body with one.json isolated to a temp file (TRAFFIC_ONE_STATE_PATH), then
// restore + clean up.
function withStore(fn: (file: string, dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onestore-'));
  const prev = process.env.TRAFFIC_ONE_STATE_PATH;
  const file = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_STATE_PATH = file;
  try {
    fn(file, dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(fn: (file: string, dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onestore-'));
  const file = path.join(dir, 'one.json');
  try {
    await fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('oneSettingsPath honors only TRAFFIC_ONE_STATE_PATH', () => {
  assert.equal(oneSettingsPath({ TRAFFIC_ONE_STATE_PATH: '/tmp/x/one.json' } as NodeJS.ProcessEnv), '/tmp/x/one.json');
  assert.equal(oneSettingsPath({ HOME: '/tmp/home' } as NodeJS.ProcessEnv), '/tmp/home/.traffic-one/one.json');
});

test('writeOneSection writes 0o600, round-trips, and preserves other sections', () => {
  withStore((file) => {
    writeOneSection('auth', { version: 1, authenticated: true, apiKey: 'sk-x', updatedAt: '2026-07-15T00:00:00Z' });
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
    assert.equal(readOneSettings().auth?.apiKey, 'sk-x');

    // A second section write must NOT clobber the first (read-merge-write).
    writeOneSection('codeGraphProvider', 'gitnexus');
    const after = readOneSettings();
    assert.equal(after.auth?.apiKey, 'sk-x');
    assert.equal(after.codeGraphProvider, 'gitnexus');
    assert.equal(after.schemaVersion, 3);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal('version' in onDisk, false);
  });
});

test('updateOneSettings applies multiple sections atomically', () => {
  withStore(() => {
    updateOneSettings({
      auth: { version: 1, authenticated: true, apiKey: 'sk-a', updatedAt: '2026-07-15T00:00:00Z' },
      codeGraphProvider: 'graphify',
    });
    const s = readOneSettings();
    assert.equal(s.auth?.apiKey, 'sk-a');
    assert.equal(s.codeGraphProvider, 'graphify');
  });
});

test('deleteOneSection drops one section but leaves the file + other sections', () => {
  withStore((file) => {
    updateOneSettings({
      auth: { version: 1, authenticated: true, apiKey: 'sk-x', updatedAt: '2026-07-15T00:00:00Z' },
      codeGraphProvider: 'graphify',
    });
    assert.equal(deleteOneSection('auth'), true);
    assert.equal(fs.existsSync(file), true); // file persists
    const s = readOneSettings();
    assert.equal(s.auth, undefined);
    assert.equal(s.codeGraphProvider, 'graphify'); // untouched
  });
});

test('readOneSettings on a missing file returns safe defaults', () => {
  withStore(() => {
    const s = readOneSettings();
    assert.equal(s.schemaVersion, 3);
    assert.equal(s.auth, undefined);
    assert.equal(s.codeGraphProvider, null);
  });
});

test('one.json writers preserve unknown raw sections and remove the retired hosts mirror', () => {
  withStore((file) => {
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 3,
      auth: { version: 1, authenticated: true, apiKey: 'sk-keep', updatedAt: '2026-07-15T00:00:00Z' },
      codeGraphProvider: 'graphify',
      futureSection: { writtenBy: 'newer-host', nested: { keep: true } },
      hosts: { cursor: { obsolete: true } },
    }, null, 2)}\n`, 'utf8');

    writeOneSection('codeGraphProvider', 'gitnexus');
    assert.equal(deleteOneSection('auth'), true);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(raw.futureSection, { writtenBy: 'newer-host', nested: { keep: true } });
    assert.equal('hosts' in raw, false);
    assert.equal(raw.codeGraphProvider, 'gitnexus');
    assert.equal('auth' in raw, false);
    assert.equal(raw.schemaVersion, 3);
  });
});

test('one.json lock wait is bounded and never steals a live lock', () => {
  withStore((file) => {
    const lockDir = `${file}.lock`;
    const token = '1a1e123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}.json`),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      'utf8',
    );
    const started = Date.now();
    assert.throws(() => writeOneSection('codeGraphProvider', 'gitnexus'), /lock|busy|timed out/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= ONE_SETTINGS_LOCK_TIMEOUT_MS - 50, `waited for bounded lock window (${elapsed}ms)`);
    assert.ok(elapsed < ONE_SETTINGS_LOCK_TIMEOUT_MS + 1_000, `did not wait indefinitely (${elapsed}ms)`);
    assert.equal(fs.existsSync(lockDir), true, 'live lock remains owned by its holder');
    assert.equal(fs.existsSync(file), false, 'timed-out writer did not write unlocked');
  });
});

test('stale recovery never reaps a fresh replacement owner', () => {
  withStore((file) => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const staleToken = '57a1e123';
    const freshToken = 'f2e5a123';
    fs.writeFileSync(
      path.join(lockDir, `owner-${staleToken}.json`),
      JSON.stringify({ pid: 1, token: staleToken, createdAt: Date.now() - 60_000 }),
      'utf8',
    );
    // Models the replacement appearing after a stale owner was observed. The
    // token-addressed directory protocol treats multiple/different owners as
    // non-reapable instead of blindly unlinking the lock pathname.
    fs.writeFileSync(
      path.join(lockDir, `owner-${freshToken}.json`),
      JSON.stringify({ pid: process.pid, token: freshToken, createdAt: Date.now() }),
      'utf8',
    );

    assert.throws(() => writeOneSection('codeGraphProvider', 'gitnexus'), /lock|timed out/i);
    assert.equal(fs.existsSync(path.join(lockDir, `owner-${freshToken}.json`)), true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('an abandoned single-owner settings lock is recovered safely', () => {
  withStore((file) => {
    const lockDir = `${file}.lock`;
    const token = 'abadd0ed123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}.json`),
      JSON.stringify({ pid: 2_147_483_647, token, createdAt: Date.now() - 60_000 }),
      'utf8',
    );

    writeOneSection('codeGraphProvider', 'gitnexus');
    assert.equal(readOneSettings().codeGraphProvider, 'gitnexus');
    assert.equal(fs.existsSync(lockDir), false);
  });
});

test('an old empty settings lock left by an interrupted release is recovered', () => {
  withStore((file) => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const abandonedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, abandonedAt, abandonedAt);

    writeOneSection('codeGraphProvider', 'graphify');

    assert.equal(readOneSettings().codeGraphProvider, 'graphify');
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.released')),
      [],
    );
  });
});

test('an old lock held by a live process is never reaped by age alone', () => {
  withStore((file) => {
    const lockDir = `${file}.lock`;
    const token = '11fe123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}.json`),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() - 60_000 }),
      'utf8',
    );

    assert.throws(() => writeOneSection('codeGraphProvider', 'gitnexus'), /lock|timed out/i);
    assert.equal(fs.existsSync(path.join(lockDir, `owner-${token}.json`)), true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('concurrent auth and codeGraphProvider writers preserve both sections', async () => {
  await withStoreAsync(async (file) => {
    const modulePath = path.resolve(__dirname, '..', 'one-settings.ts');
    const childSource = [
      `const { writeOneSection } = require(${JSON.stringify(modulePath)});`,
      'const section = process.argv[1];',
      "const value = section === 'auth'",
      "  ? { version: 1, authenticated: true, apiKey: 'sk-concurrent', updatedAt: '2026-07-15T00:00:00Z' }",
      "  : 'gitnexus';",
      'for (let i = 0; i < 20; i += 1) writeOneSection(section, value);',
    ].join(' ');
    const run = (section: 'auth' | 'codeGraphProvider') => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, section], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, TRAFFIC_ONE_STATE_PATH: file },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });

    await Promise.all([run('auth'), run('codeGraphProvider')]);
    const settings = readOneSettings({ TRAFFIC_ONE_STATE_PATH: file } as NodeJS.ProcessEnv);
    assert.equal(settings.auth?.apiKey, 'sk-concurrent');
    assert.equal(settings.codeGraphProvider, 'gitnexus');
  });
});

test('global codeGraphProvider: write canonicalizes, read returns it, invalid is rejected', () => {
  withStore(() => {
    assert.equal(readGlobalCodeGraphProvider(), null);
    assert.equal(writeGlobalCodeGraphProvider('GitNexus'), 'gitnexus'); // canonicalized
    assert.equal(readGlobalCodeGraphProvider(), 'gitnexus');
    assert.equal(writeGlobalCodeGraphProvider('neo4j'), null); // invalid → not written
    assert.equal(readGlobalCodeGraphProvider(), 'gitnexus'); // unchanged
  });
});

test('applyGlobalCodeGraphProvider injects when set, clears when unset', () => {
  withStore(() => {
    const a = applyGlobalCodeGraphProvider({ codeGraphProvider: 'gitnexus', other: 1 });
    assert.equal('codeGraphProvider' in a, false); // global unset → cleared

    writeGlobalCodeGraphProvider('graphify');
    const b = applyGlobalCodeGraphProvider({ other: 1 });
    assert.equal(b.codeGraphProvider, 'graphify'); // injected from the store
    assert.equal(b.other, 1);
  });
});
