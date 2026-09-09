import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

import { ONE_MCP_MAX_RESPONSE_BYTES } from '../../../config/one-mcp';
import { readUnknownAuthGate401 } from '../../../shared/auth/auth-gate-drift';
import {
  AUTH_GATE_401_CODES,
  authGateErrorCode,
  isAuthoritativeKeyRejection,
  probeAuthenticatedUpdates,
  unrecognizedAuthGate401Code,
  validateApiKey,
  type AuthProbe,
} from '../validate-key';

const isolatedMachine = fs.mkdtempSync(path.join(os.tmpdir(), 't1-validate-key-'));
const prevStatePath = process.env.TRAFFIC_ONE_STATE_PATH;
before(() => {
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(isolatedMachine, 'one.json');
});
after(() => {
  if (prevStatePath === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
  else process.env.TRAFFIC_ONE_STATE_PATH = prevStatePath;
  fs.rmSync(isolatedMachine, { recursive: true, force: true });
});

// A loopback mock of the gated auth endpoint, mirroring the REAL server's
// behavior. VERIFIED LIVE against production on 2026-08-08 (curl, four probes):
// the Unkey Bearer gate 401s before method dispatch, and the body is the shared
// errorHandler envelope `{"error":{"code":…,"message":…,"reqId":…}}`. A valid
// key gets a 2xx JSON-RPC `result` for tools/list listing the ONE tool the
// authenticated mount exposes — `updates`. (`get_config` and
// `report_codebase_metadata` are on the PUBLIC mount and must not appear here;
// a fixture that lists them teaches the wrong contract.) http is allowed for
// loopback by authEndpointUrl, so no TLS.
function mockAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if ((req.headers.authorization || '') !== 'Bearer sk-good') {
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token", realm="traffic-one-mcp"' });
          res.end(JSON.stringify({ error: { code: 'invalid_token', message: 'Bearer token is not a valid Unkey key', reqId: 'r' } }));
          return;
        }
            const envelope = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
            if (envelope.method === 'tools/call' && envelope.params?.name === 'updates') {
              const result = { items: [], nextCursor: null, hasMore: false };
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result },
              }));
              return;
            }
            // The probe must be tools/call on `updates`. Anything else gets a
            // JSON-RPC error, which classifies as unreachable — so a regression
            // back to tools/list turns the ok-path tests red instead of passing
            // quietly against a method that proves less.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unexpected validation method' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A server that answers every request with one canned status + body. */
function cannedServer(status: number, body: string, headers: Record<string, string> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Like cannedServer, but records every request envelope it was sent. */
function recordingServer(sink: unknown[], status: number, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { sink.push(JSON.parse(raw)); } catch { sink.push(raw); }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function probeOf(status: number, body: string, headers?: Record<string, string>): Promise<AuthProbe> {
  const srv = await cannedServer(status, body, headers);
  try {
    return await probeAuthenticatedUpdates('sk-x', { endpoint: srv.url, timeoutMs: 2000 });
  } finally { await srv.close(); }
}

async function reasonFor(status: number, body: string, headers?: Record<string, string>): Promise<string | true> {
  const srv = await cannedServer(status, body, headers);
  try {
    const r = await validateApiKey('sk-x', { endpoint: srv.url, timeoutMs: 2000 });
    return r.ok ? true : r.reason;
  } finally { await srv.close(); }
}

test('validateApiKey: a valid key reaches the `updates` tool → ok', async () => {
  const srv = await mockAuthServer();
  try {
    assert.deepEqual(await validateApiKey('sk-good', { endpoint: srv.url }), { ok: true });
  } finally { await srv.close(); }
});

test('the probe is tools/call on `updates` — the strongest proof the key reaches the tool surface', async () => {
  const seen: unknown[] = [];
  const srv = await recordingServer(seen, 200, JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { items: [], nextCursor: null, hasMore: false } },
  }));
  try {
    await probeAuthenticatedUpdates('sk-good', { endpoint: srv.url, timeoutMs: 2000 });
  } finally { await srv.close(); }
  assert.deepEqual(seen[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'updates', arguments: {} },
  }, 'tools/list proves only that the gate opened; calling the tool proves the identity behind the key resolves');
});

test('a cursor is passed back VERBATIM and `limit` is never sent (the server default is the borrowed page size)', async () => {
  const seen: unknown[] = [];
  // A real cursor: base64url of {"v":2,"after":"41","u":"user_x"}. This client
  // must move these bytes and nothing else — no parse, no re-encode, no trim.
  const cursor = 'eyJ2IjoyLCJhZnRlciI6IjQxIiwidSI6InVzZXJfeCJ9';
  const srv = await recordingServer(seen, 200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
  try {
    await probeAuthenticatedUpdates('sk-good', { endpoint: srv.url, timeoutMs: 2000, cursor });
  } finally { await srv.close(); }
  const params = (seen[0] as { params: { arguments: Record<string, unknown> } }).params;
  assert.deepEqual(params.arguments, { cursor }, 'the cursor is opaque, user-bound and version-tagged; altering it makes the server reject the page');
  assert.equal('limit' in params.arguments, false, 'omitting limit takes the server-documented default of 25 rather than inventing a page size here');
});

test('a backend fault inside the tool CONFIRMS the key — it is the feed that degraded, not the credential', async () => {
  // The exact wire shape @modelcontextprotocol/sdk@1.29 produces for a throw
  // inside a tool callback: the CallToolRequestSchema handler catches and
  // returns createToolError(...), i.e. a JSON-RPC RESULT with isError: true at
  // HTTP 200 — NOT a JSON-RPC `error` member.
  const probe = await probeOf(200, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'updates: temporary backend error' }], isError: true },
  }));
  assert.deepEqual(
    probe.validation,
    { ok: true },
    'the request passed the Bearer gate, resolved an identity and reached tool dispatch: that is a confirmation. '
    + 'Grace-ing it would spend the offline window on a fault that says nothing about the subscription',
  );
  assert.equal((probe.result as { isError?: unknown }).isError, true, 'the caller still needs to see that the feed produced nothing');
});

test('a JSON-RPC error member (no result) is indeterminate — never a rejection', async () => {
  const probe = await probeOf(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
  assert.equal(probe.validation.ok, false);
  assert.equal(probe.validation.ok === false && probe.validation.reason, 'auth-endpoint-unreachable');
  assert.equal(probe.result, undefined);
});

test('a 2xx that is not the MCP transport answering cannot confirm a key', async () => {
  for (const body of [
    // A captive portal or proxy interstitial that happens to contain the word.
    '<html><body>Sign in to continue. {"result": "ok"}</body></html>',
    // JSON, but not JSON-RPC.
    JSON.stringify({ result: { items: [] } }),
    // JSON-RPC, but the wrong version.
    JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} }),
    // A `result` that is not an object.
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }),
  ]) {
    const probe = await probeOf(200, body);
    assert.equal(
      probe.validation.ok,
      false,
      `only the MCP transport can confirm a key, and this is not it: ${body.slice(0, 46)}`,
    );
  }
});

test('validateApiKey: a rejected key (401 invalid_token) → invalid-api-key (not accepted)', async () => {
  const srv = await mockAuthServer();
  try {
    const r = await validateApiKey('test', { endpoint: srv.url });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'invalid-api-key');
  } finally { await srv.close(); }
});

test('validateApiKey: empty key → invalid-api-key, no network call', async () => {
  const r = await validateApiKey('   ');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'invalid-api-key');
});

test('validateApiKey: unreachable endpoint → auth-endpoint-unreachable (fail-closed)', async () => {
  // Dead loopback port with no listener → connection refused.
  const r = await validateApiKey('sk-x', {
    endpoint: 'http://127.0.0.1:1/mcp',
    timeoutMs: 2000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'auth-endpoint-unreachable');
});

test('validateApiKey: a 2xx without a JSON-RPC result (server anomaly) fails closed', async () => {
  assert.equal(await reasonFor(200, JSON.stringify({ error: { code: 'weird', message: 'no result here' } })), 'auth-endpoint-unreachable');
});

// ── the four 401 codes ──────────────────────────────────────────────────────
// The whole point of this block: a 401 is not one answer. Bodies are the exact
// bytes production returned on 2026-08-08 for three of the four; the
// `unkey_unavailable` body is built from the same server-side envelope
// (_shared/http.ts errorHandler) and the message string in withMcpKey.ts's
// `reject(c, 'unkey_unavailable', 'Unkey verification failed', …)`, because it
// can only be produced by an actual Unkey outage.

test('the auth gate 401 code table is the server\'s, verbatim, and only ONE code rejects the key', () => {
  // Pinned against one-dashboard-backend supabase/functions/traffic-one-mcp/
  // withMcpKey.ts. There is no shared artifact between the two repositories, so
  // this list is the only place a rename becomes a conversation.
  assert.deepEqual(Object.keys(AUTH_GATE_401_CODES).sort(), [
    'bad_authorization_header', 'invalid_token', 'no_user', 'unkey_unavailable',
  ]);
  assert.deepEqual(
    Object.entries(AUTH_GATE_401_CODES).filter(([, kind]) => kind === 'rejects-the-key').map(([code]) => code),
    ['invalid_token'],
    'only invalid_token is the server saying no about THIS KEY; the other three describe the request or the provider',
  );
});

test('an auth-provider outage (401 unkey_unavailable) is graced, NOT treated as a revoked key', async () => {
  const reason = await reasonFor(
    401,
    JSON.stringify({ error: { code: 'unkey_unavailable', message: 'Unkey verification failed', reqId: 'r' } }),
    // The header is IDENTICAL to invalid_token's — the whole reason the body is
    // the discriminator. If this test ever passes by reading the header, this
    // line is what makes it wrong.
    { 'www-authenticate': 'Bearer error="invalid_token", realm="traffic-one-mcp"' },
  );
  assert.equal(
    reason,
    'auth-endpoint-unreachable',
    'a 401 that means "we could not check" must spend the offline grace window; treating it as a rejection '
    + 'signs every user out on every machine for the duration of an Unkey outage, and they cannot sign back in',
  );
});

test('a malformed REQUEST 401 (no_user / bad_authorization_header) blames this client, not the key', async () => {
  for (const [code, message] of [
    ['no_user', 'Authorization header is required'],
    ['bad_authorization_header', 'Authorization must use the Bearer scheme'],
  ] as const) {
    const reason = await reasonFor(401, JSON.stringify({ error: { code, message, reqId: 'r' } }));
    assert.equal(reason, 'auth-endpoint-unreachable', `${code} describes the request, so it cannot condemn the key`);
  }
});

test('an unrecognised 401 — unknown code, foreign body, or no body — is an UNKNOWN, never a rejection', async () => {
  for (const body of [
    JSON.stringify({ error: { code: 'some_future_code', message: 'x' } }),
    JSON.stringify({ error: { message: 'no code field' } }),
    JSON.stringify({ error: 'not an object' }),
    JSON.stringify({ code: 'invalid_token' }), // right code, wrong envelope depth
    '<html>407 Proxy Authentication Required</html>',
    '',
  ]) {
    assert.equal(
      await reasonFor(401, body),
      'auth-endpoint-unreachable',
      `a 401 body this client cannot read is not the authority rejecting the key: ${body.slice(0, 40)}`,
    );
  }
});

test('an unknown 401 code still grants grace, and writes a doctor-visible sidecar', async () => {
  const env = { ...process.env, TRAFFIC_ONE_STATE_PATH: path.join(isolatedMachine, 'drift-case.json') };
  const body = JSON.stringify({ error: { code: 'some_future_code', message: 'x' } });
  assert.equal(unrecognizedAuthGate401Code(body), 'some_future_code');
  assert.equal(unrecognizedAuthGate401Code(JSON.stringify({ error: { code: 'invalid_token' } })), null);
  assert.equal(unrecognizedAuthGate401Code(JSON.stringify({ error: { code: 'unkey_unavailable' } })), null);
  const srv = await cannedServer(401, body);
  try {
    const r = await validateApiKey('sk-x', { endpoint: srv.url, timeoutMs: 2000, env });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'auth-endpoint-unreachable');
  } finally {
    await srv.close();
  }
  const drift = readUnknownAuthGate401(env);
  assert.equal(drift?.code, 'some_future_code');
  assert.match(drift?.logLine ?? '', /granting offline grace/);
});

test('403 is not the auth gate — it emits no 403 — so it cannot clear a credential either', async () => {
  assert.equal(await reasonFor(403, JSON.stringify({ error: { code: 'forbidden' } })), 'auth-endpoint-unreachable');
  // …unless something upstream really did forward the gate's own rejection.
  assert.equal(await reasonFor(403, JSON.stringify({ error: { code: 'invalid_token' } })), 'invalid-api-key');
});

test('a throttled probe (429 from the pre-auth rate limiters) never invalidates a key', async () => {
  // The three verify rate limiters mount BEFORE withMcpKey and throw
  // HttpError(429, 'rate_limited'), so a user with many machines can be
  // throttled while holding a perfectly good subscription.
  assert.equal(await reasonFor(429, JSON.stringify({ error: { code: 'rate_limited', message: 'rate_limited' } })), 'auth-endpoint-unreachable');
});

test('authGateErrorCode reads only the shared error envelope', () => {
  assert.equal(authGateErrorCode('{"error":{"code":"invalid_token","message":"m","reqId":"r"}}'), 'invalid_token');
  assert.equal(authGateErrorCode('{"error":{"code":"  invalid_token  "}}'), 'invalid_token');
  for (const body of ['', 'null', '[]', '{"error":[]}', '{"error":{"code":42}}', '{"error":{"code":""}}', 'not json']) {
    assert.equal(authGateErrorCode(body), null, body);
  }
  assert.equal(isAuthoritativeKeyRejection('{"error":{"code":"invalid_token"}}'), true);
  assert.equal(isAuthoritativeKeyRejection('{"error":{"code":"unkey_unavailable"}}'), false);
});

test('an oversize response body is bounded and cannot be read as a verdict', async () => {
  // A 401 whose real code sits past the cap: the truncated body no longer
  // parses, so the classifier lands on UNKNOWN rather than on a rejection it
  // read half of. Also proves the read terminates instead of buffering forever.
  const filler = 'x'.repeat(ONE_MCP_MAX_RESPONSE_BYTES + 4096);
  const reason = await reasonFor(401, JSON.stringify({ padding: filler, error: { code: 'invalid_token' } }));
  assert.equal(reason, 'auth-endpoint-unreachable', 'a body this client could not read whole decides nothing');

  // The same cap on the success path: an over-cap 2xx is not a confirmation.
  assert.equal(
    await reasonFor(200, JSON.stringify({ padding: filler, jsonrpc: '2.0', id: 1, result: { tools: [] } })),
    'auth-endpoint-unreachable',
  );
  // …and a normal-sized success still is, so the cap is not swallowing everything.
  assert.equal(await reasonFor(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'updates' }] } })), true);
});
