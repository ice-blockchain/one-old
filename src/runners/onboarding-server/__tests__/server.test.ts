import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { startOnboardingServer, type RunningServer } from '../server';

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
    const res = await request(server.port, `/?t=secret`);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    // the redirect page builds the dashboard deep link with the token in the fragment
    assert.ok(res.body.includes('https://dash.example.test'));
    assert.ok(res.body.includes('/onboarding/agent'));
    // The token is NOT injected: `/` is a token-free public path, so a token in
    // the body is a token served to any unauthenticated local reader. The page
    // takes it from its own URL query, which is where the handed-out link
    // (registry record `url`) already carries it.
    assert.ok(!res.body.includes('secret'));
    assert.ok(res.body.includes('new URLSearchParams(location.search).get("t")'));
    assert.ok(!res.body.includes('%%T1_TOKEN%%'));
    assert.ok(!res.body.includes('%%T1_PORT%%'));
    assert.ok(!res.body.includes('%%T1_DASHBOARD%%'));
    // the per-session values that are NOT credentials are still injected
    assert.ok(res.body.includes(`var T1_INJECTED_PORT = "${server.port}"`));
  }, { TRAFFIC_ONE_DASHBOARD_URL: 'https://dash.example.test' });
});

test('server: `/local` serves the full fallback wizard (token-free public path)', async () => {
  await withServer(async (server) => {
    const res = await request(server.port, '/local'); // no ?t= — public path
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Traffic One'));
    assert.ok(res.body.includes('Setup complete')); // the real wizard, not the redirect shell
    // This test used to assert the OPPOSITE — that the token is "still injected
    // server-side for the page's own API calls" — which ratified the defect: the
    // route is public, so that injection handed the credential guarding /state
    // and /answer to any process that can reach loopback. The page reads the
    // token from its own URL query instead (`/local?t=…`, config/dashboard.ts).
    assert.ok(!res.body.includes('secret'));
    assert.ok(res.body.includes('new URLSearchParams(location.search).get("t")'));
    // nothing is substituted into this page at all, so no placeholder can survive
    assert.deepEqual(res.body.match(/%%[A-Z0-9_]+%%/g), null);
  });
});

// The defect this guards, reproduced end to end before the fix: an unauthenticated
// `GET /local` (and `GET /`) returned HTML containing the 32-byte session token;
// scraping it yielded `GET /state` → 200 and `POST /answer` → 200, which wrote the
// user's onboarding preferences to disk. The token gate was defeated by public
// routes that handed out the token. The property asserted here is the durable one:
// NO unauthenticated response body contains the token, whatever the route list says.
test('server: no unauthenticated response hands out the session token', async () => {
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-tokenleak-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json'),
    TRAFFIC_ONE_DASHBOARD_URL: 'https://dash.example.test',
  };
  const server = await startOnboardingServer({ cwd: dir, env, token, standalone: false, idleMs: 60_000 });
  try {
    for (const p of ['/', '/index.html', '/local', '/healthz', '/state', '/nope']) {
      const res = await request(server.port, p); // no token, on purpose
      assert.ok(!res.body.includes(token), `${p} must not disclose the session token (status ${res.status})`);
      // a scraper does not need to know the field name — 64 hex chars is enough
      assert.equal(/[0-9a-f]{64}/.test(res.body), false, `${p} must not disclose a token-shaped string`);
    }
    // and the routes the token protects are still refused to that caller
    assert.equal((await request(server.port, '/state')).status, 403);
    assert.equal((await request(server.port, '/answer')).status, 403);
    // while the caller holding the real token is unaffected
    assert.equal((await request(server.port, '/state', { 'x-t1-token': token })).status, 200);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.ok(!html.includes('catalogTiers'), 'the Performance tier-catalog card is removed');
  assert.ok(html.includes('renderPerformanceRepickNote'), 'Performance still explains why it reopened');
  assert.ok(html.includes('repickReason'), 'Performance must explain why it reopened');
  assert.ok(
    html.includes('c.tier === m.tier && c.model === m.model'),
    'Team selector defaults must identify the exact tier/model pair',
  );
  assert.ok(
    html.includes('c.tier + " · " + modelLabel'),
    'Team selector labels must expose the tier alongside the exact model',
  );
  assert.ok(
    html.includes('return { action: "approve", overrides, modelSelections }'),
    'Team confirmation must submit tier overrides and the complete exact model map',
  );
  assert.ok(!html.includes('performanceTargetToken'));
  assert.ok(!html.includes('targetToken'));
});

test('server: standalone:false does not write a registry record', async () => {
  await withServer(async (server) => {
    assert.ok(server.url.includes(`:${server.port}`));
    // standalone:false ⇒ no registry side effects (verified by clean temp dir)
  });
});

test('the wizard server has no browser-opening code path at all', () => {
  // Traffic One never opens the setup link: the agent posts it and the user clicks
  // it. The old TRAFFIC_ONE_OPEN_BROWSER opt-in is gone (it also popped the
  // LOOPING loopback root rather than the dashboard deep link), so there is no flag
  // that can reintroduce an auto-open.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
  assert.ok(!source.includes('TRAFFIC_ONE_OPEN_BROWSER'), 'no auto-open opt-in may survive');
  assert.ok(!/\bxdg-open\b/.test(source) && !/spawn\(/.test(source), 'no opener is spawned');
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

// End-to-end proof of the delivery signal: a REAL browser request through the real
// route stack is what silences the setup surfaces, not any surface merely printing
// the URL. Exercised over HTTP rather than by calling the helper directly, so the
// route-order (token gate → arrival record → dispatch) is covered too.
test('server: only a real wizard-UI request records the browser arrival', async () => {
  const { wizardOpenedByUser } = await import('../../../shared/onboarding-server/browser-arrival');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-arrival-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  const server = await startOnboardingServer({ cwd: dir, env, token: 'secret', standalone: false, idleMs: 60_000 });
  const open = (): boolean => wizardOpenedByUser(dir, 'secret', env, server.trafficHost);
  try {
    assert.equal(open(), false, 'nothing observed yet');

    // Our own liveness probe must never look like a user.
    await request(server.port, '/healthz');
    assert.equal(open(), false, '/healthz is the plugin polling itself');

    // The redirect shell is hit by link unfurlers and preview panes, not only users.
    await request(server.port, '/');
    assert.equal(open(), false, '/ is not proof a human saw a wizard');

    await request(server.port, '/favicon.ico');
    assert.equal(open(), false, 'browser chrome is not a user');

    await request(server.port, '/state', {}, 'OPTIONS');
    assert.equal(open(), false, 'a CORS preflight fires before anything is rendered');

    // An UNAUTHENTICATED /state is rejected at the token gate and must not count.
    assert.equal((await request(server.port, '/state')).status, 403);
    assert.equal(open(), false, 'a token-rejected caller is not the user\'s wizard');

    // `/local` is a PUBLIC route, so it renders for anyone — but rendering is not
    // arrival. This test previously asserted that a tokenless `/local` records the
    // arrival, which contradicted the token-rejected exclusion two lines above and
    // let any local process forge "the user already has the wizard open" and
    // silence every surface that offers the setup link.
    assert.equal((await request(server.port, '/local')).status, 200);
    assert.equal(open(), false, 'a tokenless /local poke is not the user\'s browser');

    // The loopback wizard actually loading — via the link the user was handed,
    // which always carries ?t= (config/dashboard.ts) — IS the signal.
    assert.equal((await request(server.port, '/local?t=secret')).status, 200);
    assert.equal(open(), true, 'the wizard UI loaded in a browser');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The hosted dashboard's first cross-origin call also proves it can reach loopback,
// which is the failure the local fallback exists for.
test('server: the hosted wizard authenticating against /state counts as arrival', async () => {
  const { wizardOpenedByUser } = await import('../../../shared/onboarding-server/browser-arrival');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-arrival2-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  const server = await startOnboardingServer({ cwd: dir, env, token: 'secret', standalone: false, idleMs: 60_000 });
  try {
    assert.equal((await request(server.port, '/state?t=secret')).status, 200);
    assert.equal(wizardOpenedByUser(dir, 'secret', env, server.trafficHost), true);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
