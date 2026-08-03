import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAnswer, computeOnboarding } from '../flow';
import { clearAuthentication, readSimpleAuth, writeSimpleAuth } from '../../auth';
import { recordPluginUseChoice } from '../../state/plugin-use';

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

test('pluginUse decline is terminal before enforced auth and uses the explicit environment', () => {
  withProject({ committed: { mode: 'new-project' } }, (dir) => {
    const env = {
      ...process.env,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'declined-preferences.json'),
      TRAFFIC_ONE_STATE_PATH: path.join(dir, 'declined-one.json'),
      TRAFFIC_ONE_AUTH: '1',
    } as NodeJS.ProcessEnv;
    // Keep this explicit even if the suite helper later seeds process.env auth:
    // the regression requires the supplied environment to be unauthenticated.
    assert.equal(clearAuthentication(env), true);
    assert.equal(readSimpleAuth(env), null);
    recordPluginUseChoice(dir, false, 'test', env);

    const view = computeOnboarding(dir, env);
    assert.equal(view.done, true);
    assert.equal(view.step, null);
    assert.equal(view.meta.declined, true);
    assert.equal(fs.existsSync(path.join(dir, 'declined-one.json')), false, 'auth is not read or written into a new state file');
  });
});

test('generic answer flow cannot persist an unvalidated API key', () => {
  withProject({ committed: { mode: 'new-project' } }, (dir) => {
    assert.equal(applyAnswer(dir, 'api-key', { apiKey: 'sk-unvalidated' }).ok, false);
    assert.equal(computeOnboarding(dir).step, 'api-key');
  });
});

test('onboarded project + invalidated auth → api-key ONLY (re-auth), then done again', () => {
  withProject({ committed: ONBOARDED }, (dir) => {
    // Seed the already-validated key, then resolve local preferences → done.
    writeSimpleAuth('sk-telemetry-123');
    applyAnswer(dir, 'open-code', 'not_now');
    applyAnswer(dir, 'performance', 'low');
    applyAnswer(dir, 'code-graph', 'graphify');
    assert.equal(computeOnboarding(dir).done, true);

    // Simulate invalidating auth → the ONLY pending step is api-key.
    clearAuthentication();
    const v = computeOnboarding(dir);
    assert.equal(v.step, 'api-key');
    assert.equal(v.done, false);

    // Store a newly validated key → onboarding is complete again (prefs remain).
    writeSimpleAuth('sk-telemetry-123');
    assert.equal(computeOnboarding(dir).done, true);
  });
});

test('enforcement off → the api-key gate is inert (normal onboarding flow)', () => {
  withProject({ committed: { mode: 'new-project' }, authFlag: '0' }, (dir) => {
    assert.notEqual(computeOnboarding(dir).step, 'api-key');
  });
});
