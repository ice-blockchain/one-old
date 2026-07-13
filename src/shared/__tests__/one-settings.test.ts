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
  readOneHostSettings,
  readOneSettings,
  updateOneSettings,
  writeOneHostSettings,
  writeOneSection,
} from '../one-settings';
import { hostModelSnapshot } from '../model-tiers';
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

test('oneSettingsPath honors TRAFFIC_ONE_STATE_PATH and the TRAFFIC_ONE_AUTH_STATE_PATH alias', () => {
  assert.equal(oneSettingsPath({ TRAFFIC_ONE_STATE_PATH: '/tmp/x/one.json' } as NodeJS.ProcessEnv), '/tmp/x/one.json');
  // Back-compat alias (old auth-state path) when the canonical override is absent.
  assert.equal(oneSettingsPath({ TRAFFIC_ONE_AUTH_STATE_PATH: '/tmp/y/auth.json' } as NodeJS.ProcessEnv), '/tmp/y/auth.json');
});

test('writeOneSection writes 0o600, round-trips, and preserves other sections', () => {
  withStore((file) => {
    writeOneSection('auth', { version: 1, sessionToken: 'tok_x.sig' });
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
    assert.equal(readOneSettings().auth?.sessionToken, 'tok_x.sig');

    // A second section write must NOT clobber the first (read-merge-write).
    writeOneSection('codeGraphProvider', 'gitnexus');
    const after = readOneSettings();
    assert.equal(after.auth?.sessionToken, 'tok_x.sig');
    assert.equal(after.codeGraphProvider, 'gitnexus');
    assert.equal(after.schemaVersion, 2);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 2);
    assert.equal('version' in onDisk, false);
  });
});

test('legacy version envelope is read and migrated to schemaVersion on write', () => {
  withStore((file) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, codeGraphProvider: 'graphify' }), 'utf8');
    assert.equal(readOneSettings().schemaVersion, 1);

    writeOneSection('codeGraphProvider', 'gitnexus');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 2);
    assert.equal('version' in onDisk, false);
    assert.equal(onDisk.codeGraphProvider, 'gitnexus');
  });
});

test('updateOneSettings applies multiple sections atomically', () => {
  withStore(() => {
    writeOneSection('authChoice', { version: 3, globalChoice: null, choices: {} });
    updateOneSettings({ auth: { version: 1, sessionToken: 'tok_a.sig' }, authChoice: null });
    const s = readOneSettings();
    assert.equal(s.auth?.sessionToken, 'tok_a.sig');
    assert.equal(s.authChoice, null); // cleared in the same write
  });
});

test('deleteOneSection drops one section but leaves the file + other sections', () => {
  withStore((file) => {
    updateOneSettings({ auth: { version: 1, sessionToken: 'tok_x.sig' }, codeGraphProvider: 'graphify' });
    assert.equal(deleteOneSection('auth'), true);
    assert.equal(fs.existsSync(file), true); // file persists
    const s = readOneSettings();
    assert.equal(s.auth, null);
    assert.equal(s.codeGraphProvider, 'graphify'); // untouched
  });
});

test('readOneSettings on a missing file returns safe defaults', () => {
  withStore(() => {
    const s = readOneSettings();
    assert.equal(s.schemaVersion, 2);
    assert.equal(s.auth, null);
    assert.equal(s.authChoice, null);
    assert.equal(s.codeGraphProvider, null);
    assert.deepEqual(s.hosts, {});
  });
});

test('host model snapshots round-trip per host and survive unrelated section writes/deletes', () => {
  withStore((file) => {
    const codex = hostModelSnapshot('codex', 'pro');
    const cursor = hostModelSnapshot('cursor', 'max');
    writeOneHostSettings('codex', codex);
    writeOneHostSettings('cursor', cursor);
    writeOneSection('auth', { version: 1, sessionToken: 'tok_x.sig' });
    writeOneSection('codeGraphProvider', 'gitnexus');
    assert.equal(deleteOneSection('auth'), true);

    assert.deepEqual(readOneHostSettings('codex'), codex);
    assert.deepEqual(readOneHostSettings('cursor'), cursor);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(onDisk.hosts).sort(), ['codex', 'cursor']);
    assert.equal(onDisk.schemaVersion, 2);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('updateOneSettings merges hosts by host key instead of replacing the catalog', () => {
  withStore(() => {
    const codex = hostModelSnapshot('codex', 'pro');
    const cursor = hostModelSnapshot('cursor', 'pro');
    updateOneSettings({ hosts: { codex } });
    updateOneSettings({ hosts: { cursor } });
    assert.deepEqual(readOneSettings().hosts, { codex, cursor });
  });
});

test('readOneSettings drops malformed host snapshots without losing valid hosts', () => {
  withStore((file) => {
    const codex = hostModelSnapshot('codex', 'pro');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      auth: { keep: true },
      hosts: {
        codex,
        cursor: { ...hostModelSnapshot('cursor', 'pro'), tiers: { highest: ['bad\nmodel'], balanced: ['ok'], cheapest: ['ok'] } },
        unknown: hostModelSnapshot('codex', 'pro'),
      },
    }), 'utf8');
    const settings = readOneSettings();
    assert.deepEqual(settings.hosts, { codex });
    assert.equal(settings.auth?.keep, true);
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
    assert.throws(() => writeOneHostSettings('codex', hostModelSnapshot('codex', 'pro')), /lock|busy|timed out/i);
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

    assert.throws(() => writeOneHostSettings('codex', hostModelSnapshot('codex', 'pro')), /lock|timed out/i);
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

    const snapshot = hostModelSnapshot('codex', 'pro');
    writeOneHostSettings('codex', snapshot);
    assert.deepEqual(readOneHostSettings('codex'), snapshot);
    assert.equal(fs.existsSync(lockDir), false);
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

    assert.throws(() => writeOneHostSettings('codex', hostModelSnapshot('codex', 'pro')), /lock|timed out/i);
    assert.equal(fs.existsSync(path.join(lockDir, `owner-${token}.json`)), true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('concurrent host writers preserve both host snapshots', async () => {
  await withStoreAsync(async (file) => {
    const modulePath = path.resolve(__dirname, '..', 'one-settings.ts');
    const modelModulePath = path.resolve(__dirname, '..', 'model-tiers.ts');
    const childSource = [
      `const { writeOneHostSettings } = require(${JSON.stringify(modulePath)});`,
      `const { hostModelSnapshot } = require(${JSON.stringify(modelModulePath)});`,
      'const host = process.argv[1];',
      'const plan = process.argv[2];',
      'for (let i = 0; i < 20; i += 1) writeOneHostSettings(host, hostModelSnapshot(host, plan));',
    ].join(' ');
    const run = (host: string, plan: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, host, plan], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, TRAFFIC_ONE_STATE_PATH: file },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });

    await Promise.all([run('codex', 'pro'), run('cursor', 'max')]);
    const settings = readOneSettings({ TRAFFIC_ONE_STATE_PATH: file } as NodeJS.ProcessEnv);
    assert.deepEqual(settings.hosts.codex, hostModelSnapshot('codex', 'pro'));
    assert.deepEqual(settings.hosts.cursor, hostModelSnapshot('cursor', 'max'));
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

test('legacy auth.json/auth-choice.json are removed at the DEFAULT location only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onelegacy-'));
  const env = process.env;
  const saved = { home: env.HOME, xdg: env.XDG_STATE_HOME, state: env.TRAFFIC_ONE_STATE_PATH, auth: env.TRAFFIC_ONE_AUTH_STATE_PATH };
  try {
    // Default location: HOME/.traffic-one, no path override.
    const home = path.join(dir, 'home');
    const t1 = path.join(home, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, 'auth.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(t1, 'auth-choice.json'), '{}', 'utf8');
    env.HOME = home;
    delete env.XDG_STATE_HOME;
    delete env.TRAFFIC_ONE_STATE_PATH;
    delete env.TRAFFIC_ONE_AUTH_STATE_PATH;
    writeOneSection('codeGraphProvider', 'gitnexus');
    assert.equal(fs.existsSync(path.join(t1, 'auth.json')), false); // hard cutover removed it
    assert.equal(fs.existsSync(path.join(t1, 'auth-choice.json')), false);

    // Override location: legacy files beside the override must be left untouched.
    const custom = path.join(dir, 'custom');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'auth.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(custom, 'auth-choice.json'), '{}', 'utf8');
    env.TRAFFIC_ONE_STATE_PATH = path.join(custom, 'one.json');
    writeOneSection('codeGraphProvider', 'graphify');
    assert.equal(fs.existsSync(path.join(custom, 'auth.json')), true); // preserved under an override
    assert.equal(fs.existsSync(path.join(custom, 'auth-choice.json')), true);
  } finally {
    for (const [k, v] of Object.entries({
      HOME: saved.home, XDG_STATE_HOME: saved.xdg, TRAFFIC_ONE_STATE_PATH: saved.state, TRAFFIC_ONE_AUTH_STATE_PATH: saved.auth,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
