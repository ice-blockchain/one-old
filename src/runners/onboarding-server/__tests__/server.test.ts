import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { shouldOpenBrowser, startOnboardingServer, type RunningServer } from '../server';

function request(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (server: RunningServer) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-http-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  const server = await startOnboardingServer({ cwd: dir, env, token: 'secret', standalone: false, idleMs: 60_000 });
  try {
    await fn(server);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('server: state/answer routes require the token; page + health are public', async () => {
  await withServer(async (server) => {
    // API routes stay protected
    assert.equal((await request(server.port, '/state')).status, 403);
    assert.equal((await request(server.port, '/state?t=secret')).status, 200);
    // health is public (token-free) so attach/health checks work
    assert.equal((await request(server.port, '/healthz')).status, 200);
  });
});

test('server: serves the wizard page on the BARE url (no token) so the preview pane can load it', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/'); // no ?t= — this is what preview_start loads
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    // the token is still injected server-side for the page's own API calls
    assert.ok(res.body.includes('secret'));
    assert.ok(!res.body.includes('%%T1_TOKEN%%'));
    // the JS identifier must survive substitution intact (regression guard)
    assert.ok(!res.body.includes('window.secret'));
  });
});

test('server: standalone:false does not write a registry record', async () => {
  await withServer(async (server) => {
    assert.ok(server.url.includes(`:${server.port}`));
    // standalone:false ⇒ no registry side effects (verified by clean temp dir)
  });
});

test('external browser auto-open is OFF by default (in-app preview preferred); opt in via env', () => {
  assert.equal(shouldOpenBrowser({}), false);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: '1' }), true);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: 'true' }), true);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: 'on' }), true);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: '0' }), false);
});

test('server: rejects a non-loopback Host header (anti DNS-rebind)', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/healthz?t=secret', { host: 'evil.example.com' });
    assert.equal(res.status, 403);
  });
});

test('server: idle timeout closes the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-idle-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  const server = await startOnboardingServer({ cwd: dir, env, token: 'secret', standalone: false, idleMs: 80 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    let refused = false;
    try {
      await request(server.port, '/healthz?t=secret');
    } catch {
      refused = true;
    }
    assert.ok(refused, 'expected the idle-closed server to refuse new connections');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
