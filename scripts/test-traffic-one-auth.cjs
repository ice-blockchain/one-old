#!/usr/bin/env node
'use strict';

// Comprehensive tests for the Traffic One auth system:
//   - scripts/traffic-one-auth.cjs      (login / refresh / status / logout)
//   - scripts/hook-runtime/handlers/handlers.cjs (the pre-tool auth gate + prompt flow)
//
// A tiny in-process mock MCP auth server makes the suite deterministic: it needs
// no real API key and no real server on :8787. Run:
//   node scripts/test-traffic-one-auth.cjs

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH = path.join(ROOT, 'scripts', 'traffic-one-auth.cjs');
const HOOK_RUNTIME = path.join(ROOT, 'scripts', 'hook-runtime.cjs');
const auth = require(AUTH);
const { FRESHNESS_REASON, authStateFreshness } = auth;

const VALID_KEY = 'tk_test_valid';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── in-process mock MCP auth server ──────────────────────────────────────────
// Speaks the JSON-RPC `tools/call` shape the client expects and wraps the tool
// result in { result: { content: [{ text: "<json>" }] } }. Bad keys / revoked
// tokens answer 401 so the client's rejection path is exercised.
function startMockAuthServer({ validKeys = new Set([VALID_KEY]), tokenTtlMs = 3600 * 1000 } = {}) {
  const sessions = new Map(); // token -> { keyId, expiresAt, revoked }
  let issued = 0;
  const mint = (key) => {
    issued += 1;
    const token = `tok_mock_${issued}_${Math.random().toString(36).slice(2, 8)}`;
    const keyId = `kid_${String(key).slice(-6)}`;
    const expiresAt = new Date(Date.now() + tokenTtlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    sessions.set(token, { keyId, expiresAt, revoked: false });
    return { authenticated: true, sessionToken: token, expiresAt, keyId };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let rpc = {};
      try { rpc = JSON.parse(body); } catch { /* ignore */ }
      const name = rpc && rpc.params && rpc.params.name;
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const reply = (obj, status = 200) => {
        const envelope = JSON.stringify({
          jsonrpc: '2.0',
          id: rpc && rpc.id != null ? rpc.id : 1,
          result: { content: [{ type: 'text', text: JSON.stringify(obj) }] },
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(envelope);
      };
      if (name === 'authenticate' || name === 'refresh') {
        if (validKeys.has(bearer)) return reply(mint(bearer));
        return reply({ authenticated: false, reason: 'invalid-credentials' }, 401);
      }
      if (name === 'auth_status') {
        const session = sessions.get(bearer);
        if (session && !session.revoked) {
          return reply({ authenticated: true, keyId: session.keyId, expiresAt: session.expiresAt });
        }
        return reply({ authenticated: false, reason: 'token-revoked' }, 401);
      }
      if (name === 'logout') { sessions.delete(bearer); return reply({ ok: true }); }
      return reply({ ok: false, reason: 'unknown-tool' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${port}/mcp`,
        sessions,
        revoke: (token) => { const s = sessions.get(token); if (s) s.revoked = true; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ── shared state set up in main() ────────────────────────────────────────────
let TMP;
let SRV;

function tmpStatePath(label) {
  return path.join(TMP, `auth-${label}-${Math.random().toString(36).slice(2, 8)}.json`);
}
function envFor(stateFile, endpoint, extra = {}) {
  const env = { ...process.env };
  return Object.assign(env, {
    TRAFFIC_ONE_AUTH_STATE_PATH: stateFile,
    TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: `${stateFile}.choice`,
    TRAFFIC_ONE_AUTH_CREDENTIAL_STORE: 'file',
    TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH: `${stateFile}.credentials`,
    TRAFFIC_ONE_MCP_KEY_ENDPOINT: endpoint,
  }, extra);
}
function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}
function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
function stateAt(endpoint, token, expiresAt) {
  return {
    version: auth.AUTH_STATE_VERSION,
    endpoint,
    sessionToken: token,
    expiresAt,
    keyId: 'kid',
    authenticatedAt: '2026-01-01T00:00:00Z',
    lastRemoteCheckedAt: '2026-01-01T00:00:00Z',
    lastRemoteCheckOkAt: '2026-01-01T00:00:00Z',
  };
}
function makeProject(label) {
  const dir = path.join(TMP, `proj-${label}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;\n', 'utf8');
  return dir;
}
// Async on purpose: the gate spawns a grandchild `traffic-one-auth.cjs` that
// calls back into the in-process mock server. If we blocked the event loop with
// spawnSync, the mock could never answer and every gate auth check would time
// out. Spawning asynchronously keeps the mock responsive.
function runHook(subcommand, { cwd, env, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_RUNTIME, subcommand], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// ── 1) freshness classifier (pure, no server) ───────────────────────────────
test('freshness: a valid future session is fresh', () => {
  const ep = 'http://127.0.0.1:8787/mcp';
  const env = { TRAFFIC_ONE_MCP_KEY_ENDPOINT: ep };
  assert.deepEqual(
    authStateFreshness(stateAt(ep, 'tok_x', '2099-01-01T00:00:00Z'), env),
    { fresh: true, reason: FRESHNESS_REASON.OK },
  );
});
test('freshness: each failure mode reports a distinct reason', () => {
  const ep = 'http://127.0.0.1:8787/mcp';
  const env = { TRAFFIC_ONE_MCP_KEY_ENDPOINT: ep };
  assert.equal(authStateFreshness(null, env).reason, FRESHNESS_REASON.MISSING);
  assert.equal(authStateFreshness({ ...stateAt(ep, 'tok_x', '2099-01-01T00:00:00Z'), version: 99 }, env).reason, FRESHNESS_REASON.VERSION_MISMATCH);
  assert.equal(authStateFreshness(stateAt(ep, 'not-a-token', '2099-01-01T00:00:00Z'), env).reason, FRESHNESS_REASON.MALFORMED_TOKEN);
  assert.equal(authStateFreshness(stateAt(ep, 'tok_x', 'not-a-date'), env).reason, FRESHNESS_REASON.MALFORMED_EXPIRY);
  assert.equal(authStateFreshness(stateAt('http://127.0.0.1:1234/mcp', 'tok_x', '2099-01-01T00:00:00Z'), env).reason, FRESHNESS_REASON.ENDPOINT_MISMATCH);
  assert.equal(authStateFreshness(stateAt(ep, 'tok_x', '2000-01-01T00:00:00Z'), env).reason, FRESHNESS_REASON.EXPIRED);
});

// ── 1b) auth instructions reference the active script by ABSOLUTE path ───────
test('authRequiredMessage embeds the absolute script path and keeps auth checks internal', () => {
  const expectedPath = path.join(ROOT, 'scripts', 'traffic-one-auth.cjs');
  const msg = auth.authRequiredMessage();
  assert.ok(msg.includes(expectedPath), 'should embed the absolute script path');
  assert.match(msg, /do not search/i);
  assert.match(msg, /mcp__mcp_auth__auth_status/);
  assert.match(msg, /status and refresh silently behind the scenes/i);
  assert.doesNotMatch(msg, /via your own shell tool/i);
  assert.doesNotMatch(msg, /node ".*traffic-one-auth\.cjs" login/);
});

// ── 2) script API: login / refresh / status / logout ────────────────────────
test('simple auth: login with a valid key writes a fresh tok_ session', async () => {
  const sf = tmpStatePath('login-ok');
  const env = envFor(sf, SRV.endpoint);
  const result = await auth.login([], env, { apiKey: VALID_KEY });
  assert.equal(result.ok, true);
  assert.equal(result.credentialStored, true);
  const state = readState(sf);
  assert.ok(state.sessionToken.startsWith('tok_'));
  assert.ok(state.credentialRef, 'auth.json should contain a credential reference');
  assert.doesNotMatch(JSON.stringify(state), new RegExp(VALID_KEY), 'auth.json must not contain the raw API key');
  assert.equal(auth.isAuthStateFresh(state, env), true);
});
test('login with an invalid key returns a structured error (no session written)', async () => {
  const sf = tmpStatePath('login-bad');
  const env = envFor(sf, SRV.endpoint);
  const result = await auth.login([], env, { apiKey: 'tk_wrong' });
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'invalid-api-key');
  assert.equal(result.endpoint, SRV.endpoint);
  assert.equal(readState(sf), null);
});
test('login with no key returns missing-api-key (never throws)', async () => {
  const sf = tmpStatePath('login-nokey');
  const env = envFor(sf, SRV.endpoint);
  const result = await auth.login([], env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-api-key');
  assert.equal(readState(sf), null);
});
test('login against an unreachable endpoint reports the endpoint + reason (never silent)', async () => {
  const sf = tmpStatePath('login-unreachable');
  const dead = 'http://127.0.0.1:59999/mcp';
  const env = envFor(sf, dead);
  const result = await auth.login([], env, { apiKey: VALID_KEY });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'auth-endpoint-unreachable');
  assert.equal(result.endpoint, dead, 'failure must name the endpoint it tried');
  assert.ok(result.error, 'failure must include the underlying error');
  assert.equal(readState(sf), null);
});
test('status (fresh, local-only) reports authenticated', async () => {
  const sf = tmpStatePath('status-fresh');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  const result = await auth.status([], env);
  assert.equal(result.authenticated, true);
});
test('refresh with a key mints a brand-new session token', async () => {
  const sf = tmpStatePath('refresh');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  const before = readState(sf).sessionToken;
  const result = await auth.refresh([], env, { apiKey: VALID_KEY });
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.reauthenticated, true);
  assert.notEqual(readState(sf).sessionToken, before);
});

// ── 3) Stored credential auto-refresh: expired token → silent, no user prompt ─
test('expired token + stored credential refreshes silently (status)', async () => {
  const sf = tmpStatePath('auto-refresh-credential');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  const before = readState(sf);
  writeState(sf, { ...before, expiresAt: '2000-01-01T00:00:00Z' }); // force expiry
  const result = await auth.status([], env);
  assert.equal(result.authenticated, true, 'expired session should auto-refresh from credential store');
  assert.equal(result.reauthenticated, true, 'a refresh should have happened');
  assert.equal(result.keySource, 'credential-store');
  const after = readState(sf);
  assert.notEqual(after.sessionToken, before.sessionToken, 'a new token was minted');
  assert.ok(after.credentialRef, 'credential reference should survive refresh');
  assert.doesNotMatch(JSON.stringify(after), new RegExp(VALID_KEY), 'auth.json must not contain the raw API key after refresh');
  assert.equal(authStateFreshness(after, env).fresh, true);
});
test('expired token + NO key → precise "expired" reason, session preserved (not deleted)', async () => {
  const sf = tmpStatePath('expired-nokey');
  const env = envFor(sf, SRV.endpoint);
  writeState(sf, stateAt(SRV.endpoint, 'tok_old', '2000-01-01T00:00:00Z'));
  const result = await auth.status([], env);
  assert.equal(result.authenticated, false);
  assert.equal(result.priorReason, FRESHNESS_REASON.EXPIRED);
  assert.ok(readState(sf), 'local-only status must not delete the session');
});

// ── 4) remote validation: status --remote ───────────────────────────────────
test('status --remote accepts a token the server still recognizes', async () => {
  const sf = tmpStatePath('remote-ok');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  const result = await auth.status(['--remote'], env);
  assert.equal(result.authenticated, true);
});
test('status --remote on a server-revoked token + stored credential → silent refresh', async () => {
  const sf = tmpStatePath('remote-revoked-credential');
  await auth.login([], envFor(sf, SRV.endpoint), { apiKey: VALID_KEY });
  const revoked = readState(sf).sessionToken;
  SRV.revoke(revoked);
  const result = await auth.status(['--remote'], envFor(sf, SRV.endpoint));
  assert.equal(result.authenticated, true);
  assert.equal(result.reauthenticated, true);
  assert.equal(result.keySource, 'credential-store');
  assert.notEqual(readState(sf).sessionToken, revoked);
});
test('status --remote on a revoked token + NO key and NO stored credential → state deleted, unauthenticated', async () => {
  const sf = tmpStatePath('remote-revoked-nokey');
  await auth.login([], envFor(sf, SRV.endpoint), { apiKey: VALID_KEY });
  const state = readState(sf);
  SRV.revoke(state.sessionToken);
  writeState(sf, { ...state, credentialRef: undefined });
  const result = await auth.status(['--remote'], envFor(sf, SRV.endpoint));
  assert.equal(result.authenticated, false);
  assert.equal(readState(sf), null, 'a definitive remote rejection clears the local session');
});
test('logout clears the local session', async () => {
  const sf = tmpStatePath('logout');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  assert.ok(readState(sf));
  const result = await auth.logout([], env);
  assert.equal(result.authenticated, false);
  assert.equal(result.credentialDeleted, true);
  assert.equal(readState(sf), null);
});

// ── 5) auth gate + prompt flow (hook-runtime subprocess) ─────────────────────
test('gate: "continue without traffic one" unblocks normal tools', async () => {
  const sf = tmpStatePath('continue');
  const cwd = makeProject('continue');
  const env = envFor(sf, SRV.endpoint); // unauthenticated
  const choose = await runHook('user-prompt-submit', { cwd, env, input: { prompt: 'continue without traffic one' } });
  assert.equal(choose.status, 0, choose.stderr);
  assert.match(choose.stdout, /continue without/i);
  const gate = await runHook('check-onboarding-gate', { cwd, env, input: { tool_name: 'Read', tool_input: { file_path: 'index.js' } } });
  assert.equal(gate.stdout.trim(), '', 'tools should be allowed after continue-without');
});
test('gate: the auth-required prompt steers to hook-internal auth (no agent shell-out, no stale-copy hunt)', async () => {
  const sf = tmpStatePath('abs-path');
  const cwd = makeProject('abs-path');
  const env = envFor(sf, SRV.endpoint); // unauthenticated, no prior choice
  const gate = await runHook('check-onboarding-gate', { cwd, env, input: { tool_name: 'Read', tool_input: { file_path: 'index.js' } } });
  // The agent must NOT be told to run the auth script itself — Claude Code's
  // security classifier blocks passing a key to a script (and a relative/searched
  // copy could be stale). The hook authenticates the pasted key internally via
  // the correct absolute AUTH_SCRIPT_PATH, so there is no stale-copy hunt.
  assert.match(gate.stdout, /authenticates it automatically inside the hook/i, 'deny reason should say the hook authenticates the key');
  assert.match(gate.stdout, /do NOT invoke/i, 'deny reason should forbid the agent from running the auth script');
  assert.match(gate.stdout, /mcp__mcp_auth__auth_status/, 'deny reason should forbid direct mcp-auth tool calls');
});
test('gate: simple auth — choose authenticate, paste key, session is created internally', async () => {
  const sf = tmpStatePath('prompt-auth');
  const cwd = makeProject('prompt-auth');
  const env = envFor(sf, SRV.endpoint);
  await runHook('user-prompt-submit', { cwd, env, input: { prompt: 'authenticate traffic one' } });
  const login = await runHook('user-prompt-submit', { cwd, env, input: { prompt: VALID_KEY } });
  assert.match(login.stdout, /authenticat/i);
  assert.equal(auth.isAuthStateFresh(readState(sf), env), true);
});
test('gate: expired session + NO key → focused session-expired re-auth prompt', async () => {
  const sf = tmpStatePath('gate-expired-nokey');
  const cwd = makeProject('gate-expired-nokey');
  const env = envFor(sf, SRV.endpoint);
  writeState(sf, stateAt(SRV.endpoint, 'tok_old', '2000-01-01T00:00:00Z'));
  const gate = await runHook('check-onboarding-gate', { cwd, env, input: { tool_name: 'Read', tool_input: { file_path: 'index.js' } } });
  assert.match(gate.stdout, /traffic-one\.auth\.session-expired/);
  assert.doesNotMatch(gate.stdout, /traffic-one\.auth\.choice/);
});
test('gate: expired session + stored credential auto-refreshes silently, no auth prompt', async () => {
  const sf = tmpStatePath('gate-expired-credential');
  const cwd = makeProject('gate-expired-credential');
  const env = envFor(sf, SRV.endpoint);
  await auth.login([], env, { apiKey: VALID_KEY });
  const before = readState(sf);
  writeState(sf, { ...before, expiresAt: '2000-01-01T00:00:00Z' });
  const gate = await runHook('check-onboarding-gate', { cwd, env, input: { tool_name: 'Read', tool_input: { file_path: 'index.js' } } });
  assert.doesNotMatch(gate.stdout, /traffic-one\.auth\.(choice|session-expired|api-key)/, 'must not prompt the user');
  const after = readState(sf);
  assert.ok(after, 'session preserved');
  assert.notEqual(after.sessionToken, before.sessionToken, 'token was auto-refreshed from the credential store');
  assert.equal(authStateFreshness(after, env).fresh, true);
});

// ── runner ───────────────────────────────────────────────────────────────────
async function main() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-auth-test-'));
  SRV = await startMockAuthServer();
  let passed = 0;
  let failed = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`ok - ${t.name}`);
        passed += 1;
      } catch (error) {
        failed += 1;
        console.error(`not ok - ${t.name}`);
        const detail = error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n  ') : String(error);
        console.error(`  ${detail}`);
      }
    }
  } finally {
    await SRV.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
