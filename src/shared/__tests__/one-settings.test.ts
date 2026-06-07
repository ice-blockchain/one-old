import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
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
    assert.equal(after.version, 1);
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
    assert.equal(s.auth, null);
    assert.equal(s.authChoice, null);
    assert.equal(s.codeGraphProvider, null);
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
