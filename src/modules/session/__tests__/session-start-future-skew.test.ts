// src/modules/session/__tests__/session-start-future-skew.test.ts
// The self-heal cooldowns. Both are disk locks holding an ISO stamp this
// process wrote, and both are spelled `now - lock < COOLDOWN`, so a lock stamped
// ahead of now made the cooldown permanent — and the heal it gates unreachable.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, test } from 'node:test';

import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../../config/state';
import { shouldBuildCodeGraph } from '../session-start-lib';

const COOLDOWN_MS = 30 * 60 * 1000;
const roots: string[] = [];
after(() => {
  for (const dir of roots) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// A project that WANTS its graph built: existing codebase, provider set, no
// artefact on disk. The only remaining question is the cooldown lock.
function projectNeedingGraph(lockStampMs: number | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneB-skew-heal-'));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  if (lockStampMs !== null) {
    fs.writeFileSync(
      path.join(dir, '.traffic-one', '.codegraph-build-lock'),
      new Date(lockStampMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'utf8',
    );
  }
  return dir;
}
const state = { mode: 'existing-codebase', codeGraphProvider: 'graphify' };

test('with no cooldown lock the heal runs (the control)', () => {
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(null), { ...state }, Date.now()), true);
});

test('a recent cooldown lock suppresses the heal (the control)', () => {
  const now = Date.now();
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(now - 60_000), { ...state }, now), false);
});

test('a cooldown lock older than the window releases the heal (the control)', () => {
  const now = Date.now();
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(now - COOLDOWN_MS - 60_000), { ...state }, now), true);
});

test('a future-stamped cooldown lock does not suppress the heal forever', () => {
  const now = Date.now();
  const cwd = projectNeedingGraph(now + 6 * 60 * 60 * 1000);
  assert.equal(shouldBuildCodeGraph(cwd, { ...state }, now), true,
    'a lock six hours ahead made `nowMs - lockMs` negative, so the 30-minute cooldown could never elapse');
});

test('a cooldown lock inside the skew allowance still suppresses the heal', () => {
  const now = Date.now();
  const cwd = projectNeedingGraph(now + STATE_TIMESTAMP_FUTURE_SKEW_MS - 60_000);
  assert.equal(shouldBuildCodeGraph(cwd, { ...state }, now), false,
    'ordinary jitter must not turn the cooldown off');
});

// Non-vacuity: `shouldBuildCodeGraph` returns false for many reasons that have
// nothing to do with the lock (wrong mode, no provider, auto-run disabled). If
// the harness were producing one of those, the "future lock" test would be
// asserting true against a project that was never eligible. These pin that the
// eligibility gates are the ones being satisfied, and that the lock is the only
// live variable.
test('the harness project is eligible for exactly the reason under test', () => {
  const now = Date.now();
  const future = now + 6 * 60 * 60 * 1000;
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(future), { ...state, codeGraphProvider: 'none' }, now), false,
    'no provider — eligibility, not the lock');
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(future), { ...state, mode: 'new-project' }, now), false,
    'a new project mid-onboarding is out of scope — eligibility, not the lock');
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(future), { ...state, codeGraphAutoRun: false }, now), false,
    'auto-run disabled — eligibility, not the lock');
  assert.equal(shouldBuildCodeGraph(projectNeedingGraph(future), { ...state }, now), true,
    'and with every eligibility gate satisfied, the future lock no longer blocks');
});
