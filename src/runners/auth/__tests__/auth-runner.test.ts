import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  credentialRefFor,
  credentialStoreKind,
  deleteCredential,
  readCredential,
  storeCredential,
} from '../credential-store';
import { buildMcpPayload, extractToolText } from '../mcp-client';
import {
  authStateFromResult,
  deleteAuthState,
  errorMessage,
  isRemoteAuthRejection,
  keyFromArgsOrCredential,
  keyLookupFromArgs,
  writeAuthState,
  writeSessionResult,
} from '../lib';
import { login, logout, refresh, status } from '../commands';

const DEAD_ENDPOINT = 'http://127.0.0.1:8787/mcp';

// Isolate ALL auth paths into a temp dir; force the file credential store.
// NEVER points at a live :8787 server (a real one deletes the fixture); the
// dead port is only used so endpoint-match checks pass without any network.
function withAuthEnv(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authcli-'));
  const env = process.env;
  const saved = {
    endpoint: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
    state: env.TRAFFIC_ONE_AUTH_STATE_PATH,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    cred: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH,
    credKind: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE,
    choice: env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH,
  };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = DEAD_ENDPOINT;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH = path.join(dir, 'credentials.json');
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'auth-choice.json');
  delete env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE;
  try {
    fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.endpoint,
      TRAFFIC_ONE_AUTH_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH: saved.cred,
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE: saved.credKind,
      TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
    })) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freshFixture(dir: string): void {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    version: 1, endpoint: DEAD_ENDPOINT, sessionToken: 'tok_x.sig',
    expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z', keyId: 'k1',
  }), 'utf8');
}

test('buildMcpPayload + extractToolText', () => {
  assert.deepEqual(buildMcpPayload('authenticate', { a: 1 }), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'authenticate', arguments: { a: 1 } },
  });
  const direct = JSON.stringify({ result: { content: [{ text: '{"authenticated":true}' }] } });
  assert.equal(extractToolText(direct), '{"authenticated":true}');
  const sse = `event: message\ndata: ${direct}\n\n`;
  assert.equal(extractToolText(sse), '{"authenticated":true}');
  assert.equal(extractToolText('garbage'), null);
});

test('credential store (file backend) round-trips the secret + never returns it from state', () => {
  withAuthEnv((dir) => {
    assert.equal(credentialStoreKind(), 'file');
    const ref = credentialRefFor(DEAD_ENDPOINT, 'k1');
    assert.ok(ref);
    assert.equal(ref?.store, 'file');
    const stored = storeCredential(ref, 'sk-secret-123');
    assert.equal(stored.ok, true);
    assert.equal(readCredential(ref).secret, 'sk-secret-123');
    // The secret lives only in the credential store file, not anywhere else.
    const credFile = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
    assert.ok(credFile.includes('sk-secret-123'));
    assert.equal((fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777), 0o600);
    const del = deleteCredential(ref);
    assert.equal(del.deleted, true);
    assert.equal(readCredential(ref).ok, false);
  });
});

test('writeAuthState writes 0o600; deleteAuthState removes it', () => {
  withAuthEnv((dir) => {
    const p = writeAuthState({ version: 1, sessionToken: 'tok_x.sig' });
    assert.equal(p, path.join(dir, 'auth.json'));
    assert.equal((fs.statSync(p).mode & 0o777), 0o600);
    assert.equal(deleteAuthState(), true);
    assert.equal(fs.existsSync(p), false);
  });
});

test('writeSessionResult stores a credentialRef (NOT the raw key) in state', () => {
  withAuthEnv((dir) => {
    const result = { authenticated: true, sessionToken: 'tok_abc.sig', expiresAt: '2099-01-01T00:00:00Z', keyId: 'k1' };
    const written = writeSessionResult(DEAD_ENDPOINT, result, process.env, { apiKey: 'sk-raw-key-xyz' });
    assert.equal(written.credential.ok, true);
    // State holds a reference, never the raw secret.
    assert.ok(written.state.credentialRef);
    const stateText = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    assert.ok(!stateText.includes('sk-raw-key-xyz'), 'raw API key must not be written to auth state');
    // The secret is retrievable from the credential store via the ref.
    const ref = written.state.credentialRef as Parameters<typeof readCredential>[0];
    assert.equal(readCredential(ref).secret, 'sk-raw-key-xyz');
  });
});

test('authStateFromResult + keyFromArgsOrCredential', () => {
  withAuthEnv(() => {
    const state = authStateFromResult(DEAD_ENDPOINT, { sessionToken: 'tok_x.sig', expiresAt: '2099', keyId: 'k1' });
    assert.equal(state.version, 1);
    assert.equal(state.endpoint, DEAD_ENDPOINT);
    assert.equal(state.sessionToken, 'tok_x.sig');
    // No state + no args → missing-api-key.
    assert.equal(keyFromArgsOrCredential([], process.env, null).reason, 'missing-api-key');
    // With a credentialRef pointing at a stored secret → resolves the key.
    const ref = credentialRefFor(DEAD_ENDPOINT, 'k1');
    storeCredential(ref, 'sk-stored');
    const lookup = keyFromArgsOrCredential([], process.env, { credentialRef: ref });
    assert.equal(lookup.key, 'sk-stored');
    assert.equal(lookup.source, 'credential-store');
  });
});

test('keyLookupFromArgs + small helpers', () => {
  assert.equal(keyLookupFromArgs([], process.env, { apiKey: 'sk-internal' }).source, 'internal');
  assert.equal(keyLookupFromArgs([], process.env).source, 'none');
  assert.equal(isRemoteAuthRejection({ statusCode: 401 }), true);
  assert.equal(isRemoteAuthRejection({ statusCode: 500 }), false);
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage({ errors: [{ message: 'a' }, { message: 'b' }] }), 'a; b');
  assert.equal(errorMessage({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
});

// ── Command no-network branches (never touch :8787) ──────────────────────────
test('login() returns missing-api-key without any network', async () => {
  await withAuthEnvAsync(async () => {
    const r = await login([]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing-api-key');
  });
});

test('refresh() with no key + no credential is reauthentication-not-possible', async () => {
  await withAuthEnvAsync(async () => {
    const r = await refresh([]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'reauthentication-not-possible');
  });
});

test('status() reports missing-auth-state when nothing is stored', async () => {
  await withAuthEnvAsync(async () => {
    const r = await status([]);
    assert.equal(r.authenticated, false);
    assert.equal(r.reason, 'missing-auth-state');
  });
});

test('status() (local, no --remote) reports authenticated from a fresh fixture', async () => {
  await withAuthEnvAsync(async (dir) => {
    freshFixture(dir);
    const r = await status([]);
    assert.equal(r.ok, true);
    assert.equal(r.authenticated, true);
    assert.equal(r.keyId, 'k1');
  });
});

test('logout() with no live session deletes local state without network', async () => {
  await withAuthEnvAsync(async (dir) => {
    fs.writeFileSync(path.join(dir, 'auth-choice.json'), JSON.stringify({ version: 3 }), 'utf8');
    const r = await logout([]);
    assert.equal(r.ok, true);
    assert.equal(r.authenticated, false);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'auth-choice.json')), false);
  });
});

// Async variant of withAuthEnv (awaits the body before cleanup).
async function withAuthEnvAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authcli-'));
  const env = process.env;
  const saved = {
    endpoint: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
    state: env.TRAFFIC_ONE_AUTH_STATE_PATH,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    cred: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH,
    credKind: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE,
    choice: env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH,
  };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = DEAD_ENDPOINT;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH = path.join(dir, 'credentials.json');
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'auth-choice.json');
  delete env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE;
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.endpoint,
      TRAFFIC_ONE_AUTH_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH: saved.cred,
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE: saved.credKind,
      TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
    })) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
