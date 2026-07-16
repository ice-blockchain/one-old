import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { hostModelSnapshot } from '../model-tiers';
import { sessionPerformanceContext } from '../session-performance-context';
import { writeOneHostSettings } from '../one-settings';

test('SessionStart injects active host performance and role models from one.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-session-performance-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_USER_PLAN: 'pro',
  } as NodeJS.ProcessEnv;
  try {
    writeOneHostSettings('codex', {
      ...hostModelSnapshot('codex', 'pro'),
      updatedAt: '2026-07-13',
      tiers: {
        highest: ['local-high'],
        balanced: ['local-balanced'],
        cheapest: ['local-cheap'],
      },
    }, env);
    const text = sessionPerformanceContext({
      performance: { level: 'balanced' },
      team: { mode: 'subagents', approved: true },
    }, 'codex', env);
    assert.match(text, /performance: balanced/);
    assert.match(text, /host: codex · plan: pro · catalog: 2026-07-13/);
    assert.match(text, /senior-architect → balanced → local-balanced/);
    assert.match(text, /senior-tester → cheapest → local-cheap/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart performance context is empty until the active host is configured', () => {
  assert.equal(sessionPerformanceContext({}, 'codex', {}), '');
});
