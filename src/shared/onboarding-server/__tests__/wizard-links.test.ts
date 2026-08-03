import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyDashboardStatus } from '../../../config/dashboard';
import { isWizardArrivalPath, noteBrowserArrival, wizardOpenedByUser } from '../browser-arrival';
import { awaitDashboardHealth, writeDashboardHealth } from '../dashboard-health';
import { localFallbackLine, localFallbackSection, wizardOpened } from '../wizard-links';

const LOCAL = 'http://127.0.0.1:55174/local?t=secret-token';

function withRuntime(fn: (cwd: string, env: NodeJS.ProcessEnv) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-links-'));
  const prefs = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-prefs-'));
  try {
    fn(cwd, { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(prefs, 'prefs.json') });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(prefs, { recursive: true, force: true });
  }
}

test('dashboard status classification: only a missing or broken page earns the local fallback', () => {
  for (const ok of [200, 204, 301, 302, 401, 403, 405, 429]) {
    assert.equal(classifyDashboardStatus(ok), 'healthy', `${ok} must not add a second link`);
  }
  for (const bad of [404, 410, 500, 502, 503]) {
    assert.equal(classifyDashboardStatus(bad), 'unhealthy', `${bad} must add the local fallback`);
  }
});

test('401/403 stay healthy: a sign-in wall is the intended hosted flow, not an outage', () => {
  // Regression guard for 2cu, where the agent read "the hosted page asks you to
  // sign in" as a failure and the user had to ask for the local link.
  assert.equal(classifyDashboardStatus(401), 'healthy');
  assert.equal(classifyDashboardStatus(403), 'healthy');
});

test('only a real wizard-UI request counts as the user having received the link', () => {
  assert.equal(isWizardArrivalPath('GET', '/local'), true);
  assert.equal(isWizardArrivalPath('GET', '/state'), true);
  // Our own liveness probe, the redirect shell, browser chrome and preflights are
  // all reachable without a human ever seeing a link.
  assert.equal(isWizardArrivalPath('GET', '/healthz'), false);
  assert.equal(isWizardArrivalPath('GET', '/'), false);
  assert.equal(isWizardArrivalPath('GET', '/index.html'), false);
  assert.equal(isWizardArrivalPath('GET', '/favicon.ico'), false);
  assert.equal(isWizardArrivalPath('OPTIONS', '/state'), false);
});

test('suppression requires an observed browser arrival, and is scoped to the live token', () => {
  withRuntime((cwd, env) => {
    assert.equal(wizardOpened(cwd, 'tok', env, 'cursor'), false, 'nothing observed yet → keep offering the link');
    noteBrowserArrival(cwd, 'tok', env, 'cursor');
    assert.equal(wizardOpened(cwd, 'tok', env, 'cursor'), true);
    // A relaunched server mints a new token, so stale evidence cannot silence a
    // fresh onboarding.
    assert.equal(wizardOpened(cwd, 'other-token', env, 'cursor'), false);
  });
});

test('arrival expires so a user who walks away is re-offered the link', () => {
  withRuntime((cwd, env) => {
    noteBrowserArrival(cwd, 'tok', env, 'cursor');
    assert.equal(wizardOpenedByUser(cwd, 'tok', env, 'cursor', 60_000), true);
    assert.equal(wizardOpenedByUser(cwd, 'tok', env, 'cursor', -1), false,
      'past the TTL the wizard is no longer considered open');
  });
});

test('the local fallback appears only when the hosted dashboard is not healthy', () => {
  withRuntime((cwd, env) => {
    // No verdict yet (probe still in flight) → both links, the safe default.
    assert.match(String(localFallbackSection(cwd, LOCAL, env, 'cursor')), /127\.0\.0\.1/);

    writeDashboardHealth(cwd, 'healthy', env, 'cursor');
    assert.equal(localFallbackSection(cwd, LOCAL, env, 'cursor'), '',
      'a healthy hosted page earns exactly one link');
    assert.equal(localFallbackLine(cwd, LOCAL, env, 'cursor'), '');

    writeDashboardHealth(cwd, 'unhealthy', env, 'cursor');
    assert.match(String(localFallbackSection(cwd, LOCAL, env, 'cursor')), /127\.0\.0\.1/);
    assert.match(String(localFallbackLine(cwd, LOCAL, env, 'cursor')), /127\.0\.0\.1/);
  });
});

test('the OpenCode fallback line stays bare — no markdown, no negations', () => {
  withRuntime((cwd, env) => {
    writeDashboardHealth(cwd, 'unhealthy', env, 'opencode');
    const line = String(localFallbackLine(cwd, LOCAL, env, 'opencode'));
    assert.ok(!line.includes('['), 'no markdown links: OpenCode rejects walkthrough-shaped prose');
    assert.ok(!/\bnot\b|\bdo NOT\b/i.test(line), 'no behavioural negations');
  });
});

test('a verdict recorded for a different dashboard origin is never reused', () => {
  withRuntime((cwd, env) => {
    writeDashboardHealth(cwd, 'healthy', { ...env, TRAFFIC_ONE_DASHBOARD_URL: 'https://staging.example' }, 'cursor');
    assert.match(String(localFallbackSection(cwd, LOCAL, env, 'cursor')), /127\.0\.0\.1/,
      'the default origin has no verdict of its own → both links');
  });
});

test('awaitDashboardHealth returns immediately when a verdict exists and gives up on its bound otherwise', () => {
  withRuntime((cwd, env) => {
    writeDashboardHealth(cwd, 'healthy', env, 'cursor');
    const t0 = Date.now();
    assert.equal(awaitDashboardHealth(cwd, env, 'cursor', 5_000), 'healthy');
    assert.ok(Date.now() - t0 < 500, 'an existing verdict must not be waited on');
  });

  withRuntime((cwd, env) => {
    // No detached server will ever write one here — the caller falls back to the
    // safe both-links default instead of blocking the setup link behind a probe.
    const t0 = Date.now();
    assert.equal(awaitDashboardHealth(cwd, env, 'cursor', 150), null);
    const waited = Date.now() - t0;
    assert.ok(waited >= 100 && waited < 2_000, `bounded wait, got ${waited}ms`);
  });
});
