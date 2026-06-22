import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
