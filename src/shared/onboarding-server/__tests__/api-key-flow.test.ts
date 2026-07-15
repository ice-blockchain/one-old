import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAnswer, computeOnboarding } from '../flow';
import { clearAuthentication, isLocallyAuthenticated } from '../../auth';

const HOST_ENV_KEYS = ['TRAFFIC_ONE_HOST', 'CURSOR_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_THREAD_ID'] as const;

// Isolate prefs + one.json (state/auth/codeGraph all live there) and pin auth
// enforcement — the api-key gate only fires when auth is enforced.
function withProject(
  opts: { committed?: Record<string, unknown> | null; authFlag?: string },
  fn: (cwd: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apikey-'));
  const env = process.env;
  const saved: Record<string, string | undefined> = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    auth: env.TRAFFIC_ONE_AUTH,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  const prevHost = new Map<string, string | undefined>();
  for (const k of HOST_ENV_KEYS) { prevHost.set(k, env[k]); delete env[k]; }
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_AUTH = opts.authFlag ?? '1';
  env.TRAFFIC_ONE_USER_PLAN = 'max';
  if (opts.committed) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(opts.committed), 'utf8');
  }
  try {
    fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs, TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_AUTH: saved.auth, TRAFFIC_ONE_USER_PLAN: saved.plan,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    for (const [k, v] of prevHost) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ONBOARDED = { mode: 'existing-codebase', stack: 'minimal', confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z' };

test('enforced + no key → api-key is the FIRST step (text_input, not done)', () => {
  withProject({ committed: { mode: 'new-project' } }, (dir) => {
    const v = computeOnboarding(dir);
    assert.equal(v.step, 'api-key');
    assert.equal(v.done, false);
    assert.equal(v.meta.kind, 'text_input');
  });
});

test('entering the key authenticates and clears the api-key step', () => {
  withProject({ committed: { mode: 'new-project' } }, (dir) => {
    const out = applyAnswer(dir, 'api-key', { apiKey: 'sk-telemetry-123' });
    assert.equal(out.ok, true);
    assert.equal(out.task, undefined); // never fires the toolchain install task
    assert.equal(isLocallyAuthenticated(), true);
    assert.notEqual(computeOnboarding(dir).step, 'api-key');
  });
});

test('applyAnswer tolerates a bare string key and rejects an empty one', () => {
  withProject({ committed: { mode: 'new-project' } }, (dir) => {
    assert.equal(applyAnswer(dir, 'api-key', '   ').ok, false);
    assert.equal(applyAnswer(dir, 'api-key', 'sk-bare-string').ok, true);
    assert.equal(isLocallyAuthenticated(), true);
  });
});

test('onboarded project + 401-invalidated key → api-key ONLY (re-auth), then done again', () => {
  withProject({ committed: ONBOARDED }, (dir) => {
    // Enter the key, then resolve the remaining local preferences → done.
    applyAnswer(dir, 'api-key', { apiKey: 'sk-telemetry-123' });
    applyAnswer(dir, 'open-code', 'not_now');
    applyAnswer(dir, 'performance', 'low');
    applyAnswer(dir, 'code-graph', 'graphify');
    assert.equal(computeOnboarding(dir).done, true);

    // A 401 clears the flag → the ONLY pending step is api-key (nothing else re-asked).
    clearAuthentication();
    const v = computeOnboarding(dir);
    assert.equal(v.step, 'api-key');
    assert.equal(v.done, false);

    // Re-enter the key → onboarding is complete again (prefs were never lost).
    applyAnswer(dir, 'api-key', { apiKey: 'sk-telemetry-123' });
    assert.equal(computeOnboarding(dir).done, true);
  });
});

test('enforcement off → the api-key gate is inert (normal onboarding flow)', () => {
  withProject({ committed: { mode: 'new-project' }, authFlag: '0' }, (dir) => {
    assert.notEqual(computeOnboarding(dir).step, 'api-key');
  });
});
