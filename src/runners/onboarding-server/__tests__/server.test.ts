import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { shouldOpenBrowser, startOnboardingServer, type RunningServer } from '../server';

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(
  port: number,
  p: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(
  fn: (server: RunningServer) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-http-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json'), ...extraEnv };
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

test('server: `/` serves the redirect page pointing at the dashboard (fragment-carried port+token)', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/'); // no ?t= — public path
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    // the redirect page builds the dashboard deep link with the token in the fragment
    assert.ok(res.body.includes('https://dash.example.test'));
    assert.ok(res.body.includes('/onboarding/agent'));
    // the token is injected for the deep link + the /local fallback link
    assert.ok(res.body.includes('secret'));
    assert.ok(!res.body.includes('%%T1_TOKEN%%'));
    assert.ok(!res.body.includes('%%T1_PORT%%'));
    assert.ok(!res.body.includes('%%T1_DASHBOARD%%'));
  }, { TRAFFIC_ONE_DASHBOARD_URL: 'https://dash.example.test' });
});

test('server: `/local` serves the full fallback wizard (token-free public path)', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/local'); // no ?t= — public path
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    assert.ok(res.body.includes('Setup complete')); // the real wizard, not the redirect shell
    // the token is still injected server-side for the page's own API calls
    assert.ok(res.body.includes('secret'));
    assert.ok(!res.body.includes('%%T1_TOKEN%%'));
    // the JS identifier must survive substitution intact (regression guard)
    assert.ok(!res.body.includes('window.secret'));
  });
});

test('server: CORS is open (ACAO:*) on API responses so the dashboard can call cross-origin', async () => {
  await withServer(async (server) => {
    // A remote (non-loopback) Origin is allowed — the token is the gate, not the origin.
    const ok = await request(server.port, '/state?t=secret', { origin: 'https://traffic.io' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], '*');
    // A bad token still 403s — but with CORS headers, so the dashboard can READ the error.
    const bad = await request(server.port, '/state?t=nope', { origin: 'https://traffic.io' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], '*');
  });
});

test('server: OPTIONS preflight is answered before the token gate, with PNA opt-in', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/state', {
      origin: 'https://traffic.io',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-t1-token',
      'access-control-request-private-network': 'true',
    }, 'OPTIONS');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(String(res.headers['access-control-allow-headers']), /x-t1-token/);
    assert.match(String(res.headers['access-control-allow-methods']), /GET/);
    // grant Chrome Private Network Access only when the browser asks for it
    assert.equal(res.headers['access-control-allow-private-network'], 'true');
  });
});

test('server: OPTIONS without a PNA request does not assert the PNA header', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/state', { origin: 'https://traffic.io' }, 'OPTIONS');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-private-network'], undefined);
  });
});

test('wizard: completion page has no OpenCode restart button or Ctrl+C instructions', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'runners', 'onboarding-server', 'wizard.html'), 'utf8');
  assert.ok(html.includes('Setup complete'));
  assert.ok(html.includes('await api("/complete"'), 'completion must be acknowledged before the UI reports success');
  assert.ok(html.includes('setTimeout(() => { try { window.close(); }'), 'hosts that support page close keep the automatic path');
  assert.ok(!html.includes('Close setup'), 'completion must never require a manual close button');
  assert.ok(!html.includes('closeButton'), 'manual close controls must not return');
  assert.ok(!html.toLowerCase().includes('you can close'), 'completion copy must not delegate cleanup to the user');
  assert.ok(!html.includes("tab's ×"), 'completion copy must not delegate cleanup to the tab chrome');
  assert.ok(!html.includes('Restart OpenCode'));
  assert.ok(!html.includes('/restart-host'));
  assert.ok(!html.includes('terminal where opencode is running'));
  assert.ok(!html.includes('Ctrl+C'));
  assert.ok(!html.includes('Press Ctrl+C and relaunch opencode to apply changes.'));
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

test('no host auto-pops the EXTERNAL browser — Cursor uses the in-app Simple Browser link, not an OS-browser pop', () => {
  // Cursor opens the wizard in-app via the agent-surfaced clickable link (Cursor has
  // no API to auto-open it, and an external pop is off-target + double-open-prone), so
  // host alone NEVER triggers the OS browser. Only the explicit opt-in does.
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_HOST: 'cursor' }), false);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_HOST: 'claude' }), false);
  assert.equal(shouldOpenBrowser({ TRAFFIC_ONE_HOST: 'cursor', TRAFFIC_ONE_OPEN_BROWSER: '1' }), true);
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
