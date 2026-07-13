import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOST_IDS } from '../../config/model-tiers';
import { hostModelSnapshot } from '../../shared/model-tiers';
import { nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { readEffectiveState, readProjectPrefs } from '../../shared/state';
import { preseed } from './preseed';

test('preseed writes complete performance preferences for the active host across all hosts', () => {
  for (const host of HOST_IDS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-preseed-${host}-`));
    const env = process.env;
    const saved = {
      host: env.TRAFFIC_ONE_HOST,
      plan: env.TRAFFIC_ONE_USER_PLAN,
      prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
      state: env.TRAFFIC_ONE_STATE_PATH,
    };
    env.TRAFFIC_ONE_HOST = host;
    env.TRAFFIC_ONE_USER_PLAN = 'free';
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'preferences.json');
    env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');

    try {
      preseed(dir, {
        mode: 'new-project',
        stack: 'default',
        frontend: 'react-vite',
        backend: 'supabase',
        mobile: { enabled: false, framework: 'none' },
        performance: 'balanced',
        team: { mode: 'subagents', approved: true },
        openCode: false,
        codeGraphProvider: 'gitnexus',
        projectContext: { originalPrompt: 'Build an app with users and an admin dashboard' },
      });

      const prefs = readProjectPrefs(dir);
      const active = (prefs.hosts as Record<string, Record<string, unknown>>)[host];
      assert.ok(active, host);
      assert.deepEqual(active.performance, { level: 'balanced', source: 'prompted' }, host);
      assert.deepEqual(active.team, { mode: 'subagents', source: 'prompted', approved: true }, host);
      const snapshot = hostModelSnapshot(host, 'free');
      assert.deepEqual(active.configuredFor, {
        plan: snapshot.plan,
        modelsUpdatedAt: snapshot.updatedAt,
      }, host);
      assert.deepEqual(Object.keys(prefs.hosts as Record<string, unknown>), [host], host);
      assert.equal(nextLocalPreferenceStep(readEffectiveState(dir), host), null, host);
    } finally {
      if (saved.host === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = saved.host;
      if (saved.plan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = saved.plan;
      if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
      if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
