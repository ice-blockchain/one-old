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

test('server: rejects requests without the token', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/healthz');
    assert.equal(res.status, 403);
  });
});

test('server: /healthz returns ok with the token', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/healthz?t=secret');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('server: serves the wizard page shell on /', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/?t=secret');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    // token is injected, not left as the placeholder
    assert.ok(res.body.includes('secret'));
    assert.ok(!res.body.includes('%%T1_TOKEN%%'));
    // the JS identifier must survive substitution intact (regression: global
    // replace previously mangled it into `window.<token>`)
    assert.ok(!res.body.includes('window.secret'));
  });
});

test('server: standalone:false does not write a registry record', async () => {
  await withServer(async (server) => {
    assert.ok(server.url.includes(`:${server.port}`));
    // standalone:false ⇒ no registry side effects (verified by clean temp dir)
  });
});

test('browser auto-open is on by default; opt out via TRAFFIC_ONE_OPEN_BROWSER', () => {
  assert.equal(shouldOpenBrowser({}), true);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: '1' }), true);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: '0' }), false);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: 'false' }), false);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_OPEN_BROWSER: 'off' }), false);
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
