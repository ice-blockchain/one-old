import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { validateApiKey } from '../validate-key';

// A loopback mock of the gated auth endpoint, mirroring the REAL server's
// behavior (observed 2026-07-10): the Unkey Bearer gate 401s an invalid key
// before method dispatch; a valid key gets a 2xx JSON-RPC `result` for
// tools/list. http is allowed for loopback by authEndpointUrl, so no TLS.
function mockAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if ((req.headers.authorization || '') !== 'Bearer sk-good') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_token', message: 'Bearer token is not a valid Unkey key' } }));
          return;
        }
        const method = (() => { try { return JSON.parse(raw).method; } catch { return ''; } })();
        if (method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'report_codebase_metadata' }] } }));
          return;
        }
        // The wizard must use tools/list. Return a harmless MCP error for any
        // other method so the test catches a validation-method regression.
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

test('validateApiKey: a valid key passes the Bearer gate (tools/list result) → ok', async () => {
  const srv = await mockAuthServer();
  try {
    assert.deepEqual(await validateApiKey('sk-good', { endpoint: srv.url }), { ok: true });
  } finally { await srv.close(); }
});

test('validateApiKey: a rejected key (401) → invalid-api-key (not accepted)', async () => {
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
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'weird', message: 'no result here' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await validateApiKey('sk-x', {
      endpoint: `http://127.0.0.1:${port}/mcp`,
      timeoutMs: 2000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'auth-endpoint-unreachable');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
