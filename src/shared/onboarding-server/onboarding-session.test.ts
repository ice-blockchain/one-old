import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../config/state';
import { resetAuthoringRootCache } from '../authoring-root';
import { isForeignOnboardingThread, recordMainOnboardingSession, ONBOARDING_MAIN_TTL_MS } from './onboarding-session';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onbsess-'));
}

test('isForeignOnboardingThread: nobody is foreign until a main (orchestrator) session is recorded', () => {
  const cwd = tmp();
  try {
    // No main recorded yet (no subagentStart) → never suppress (the real wizard must show).
    assert.equal(isForeignOnboardingThread(cwd, 'orchestrator'), false);
    assert.equal(isForeignOnboardingThread(cwd, 'anything'), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('isForeignOnboardingThread: once the orchestrator is recorded, a DIFFERENT session is foreign', () => {
  const cwd = tmp();
  try {
    // subagentStart records the parent/orchestrator session as MAIN.
    recordMainOnboardingSession(cwd, 'orchestrator-conv');
    // The orchestrator's own events are NOT foreign.
    assert.equal(isForeignOnboardingThread(cwd, 'orchestrator-conv'), false);
    // The architect subagent's own events (a different conversation id) ARE foreign → gate no-ops.
    assert.equal(isForeignOnboardingThread(cwd, 'architect-subagent-conv'), true);
    // Multiple orchestrators (e.g. two main threads) are all recognized.
    recordMainOnboardingSession(cwd, 'orchestrator-2');
    assert.equal(isForeignOnboardingThread(cwd, 'orchestrator-2'), false);
    assert.equal(isForeignOnboardingThread(cwd, 'architect-subagent-conv'), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordMainOnboardingSession: empty id is a no-op; a stale main (TTL) stops suppressing', () => {
  const cwd = tmp();
  const now = 1_000_000_000_000;
  try {
    recordMainOnboardingSession(cwd, '', now);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.onboarding-main-sessions.json')), false, 'empty id does not write');
    recordMainOnboardingSession(cwd, 'orch', now);
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now + 1000), true, 'subagent foreign while the main is fresh');
    // After the TTL the recorded main expires → the set is empty again → nobody suppressed.
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now + ONBOARDING_MAIN_TTL_MS + 1), false, 'stale main no longer suppresses');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function writeStore(cwd: string, sessions: Record<string, number>): void {
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.traffic-one', '.onboarding-main-sessions.json'),
    JSON.stringify({ sessions }),
    'utf8',
  );
}

test('a future-stamped store does not classify anyone as foreign (cannot silence Cursor consent)', () => {
  const cwd = tmp();
  const now = 1_000_000_000_000;
  try {
    writeStore(cwd, { orch: now + STATE_TIMESTAMP_FUTURE_SKEW_MS + 1 });
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now), false, 'unusable future stamp is not a known orchestrator');
    assert.equal(isForeignOnboardingThread(cwd, 'orch', now), false, 'the stamped id itself is not treated as a live main');

    writeStore(cwd, { orch: now + STATE_TIMESTAMP_FUTURE_SKEW_MS });
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now), true, 'inside the skew allowance the stamp is still fresh');

    writeStore(cwd, { orch: Number.POSITIVE_INFINITY });
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now), false, 'a non-finite stamp is unusable');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordMainOnboardingSession drops an unusable future stamp when rewriting the store', () => {
  const cwd = tmp();
  const now = 1_000_000_000_000;
  try {
    writeStore(cwd, { staleOrch: now + STATE_TIMESTAMP_FUTURE_SKEW_MS + 60_000 });
    recordMainOnboardingSession(cwd, 'live-orch', now);
    const stored = JSON.parse(
      fs.readFileSync(path.join(cwd, '.traffic-one', '.onboarding-main-sessions.json'), 'utf8'),
    ) as { sessions: Record<string, number> };
    assert.equal(stored.sessions.staleOrch, undefined, 'the future stamp is not persisted');
    assert.equal(stored.sessions['live-orch'], now);
    assert.equal(isForeignOnboardingThread(cwd, 'sub', now), true);
    assert.equal(isForeignOnboardingThread(cwd, 'live-orch', now), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordMainOnboardingSession: plugin authoring roots never receive local onboarding state', () => {
  const cwd = tmp();
  try {
    fs.mkdirSync(path.join(cwd, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"traffic-one"}\n');
    fs.writeFileSync(path.join(cwd, 'src', 'gen', 'index.ts'), 'export {};\n');
    resetAuthoringRootCache();

    recordMainOnboardingSession(cwd, 'orchestrator');

    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false);
    assert.equal(isForeignOnboardingThread(cwd, 'subagent'), false);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
