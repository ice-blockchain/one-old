// src/shared/state/__tests__/mutation-results.test.ts
// The three-valued mutation contract from state/run-agent/mutation-result.ts.
//
// Every mutation here used to answer with a boolean or nothing at all, which
// collapsed two answers a caller must separate: "the precondition says no"
// (permanent — retrying changes nothing) and "I could not tell you" (transient —
// a contended lock, a refused write). A single `null` for both is what let a
// spawn gate treat an unrecorded claim as a decision and allow the spawn.
//
// The split rule these tests pin: ADVISORY mutations may proceed on
// `unavailable`; CLAIM MINTING and LEDGER TRANSITIONS must retry and then deny.
// A blanket "never deny on unavailable" is a safety violation, and so is the
// converse — denying on `precondition-failed` would block spawns whose role
// claim is already on disk.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ensureRunAgentClaimResult,
  ensureRunLedgerResult,
  releaseRunClaimsResult,
  transitionRunStatusResult,
} from '../run-agent';
import { holdRunLock } from './owned-lock-fixture';

const RUN_ID = 'run-mutation-results';
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-mutation-results-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', RUN_ID), { recursive: true });
  return dir;
}

function holdClaimsLock(cwd: string): void {
  holdRunLock(cwd, RUN_ID, 'claims');
}

// A ledger record returned for a file that was never written is the worst of the
// three answers: the caller announces the run active, and every later reader
// loads nothing. writeJson reports its refusals now, so the transition can say so.
test('a ledger transition whose file cannot be written reports unavailable, not a record', () => {
  const cwd = project();
  fs.symlinkSync(
    path.join(os.tmpdir(), 't1-ledger-elsewhere.json'),
    path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'run.json'),
  );

  const result = ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' });
  assert.equal(result.outcome, 'unavailable', 'a refused write is not a decision');
  assert.equal(result.reason, 'ledger-write-refused');
  assert.equal(result.value, null, 'no caller may be handed a record that is not on disk');
  assert.ok(!fs.existsSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'run.json')),
    'the symlink fence refused the write rather than following the link');
});

// The other half of the same contract: a rule the state machine ENFORCES is
// permanent, and must never be reported as `unavailable` — a caller that retries
// an illegal transition retries forever.
test('an illegal ledger transition is precondition-failed, never unavailable', () => {
  const cwd = project();
  assert.equal(ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' }).outcome, 'applied');
  const terminal = transitionRunStatusResult(cwd, RUN_ID, { status: 'failed', outcome: 'agent-failed' });
  assert.equal(terminal.outcome, 'applied');

  const revive = transitionRunStatusResult(cwd, RUN_ID, { status: 'active' });
  assert.equal(revive.outcome, 'precondition-failed');
  assert.match(revive.reason, /^illegal-transition-failed-to-active$/);
});

// The plan's scenario, at the layer that answers it: two SubagentStart hooks race
// for one role and one of them cannot take the claims lock. Before this it got
// `null` — the same value as an invalid role or a closed run — and all three mint
// call sites discarded it, so the spawn proceeded with no claim behind it.
test('a claim mint that cannot take the claims lock reports unavailable, not null', () => {
  const cwd = project();
  assert.equal(ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' }).outcome, 'applied');
  holdClaimsLock(cwd);

  const minted = ensureRunAgentClaimResult(cwd, { currentRunId: RUN_ID }, 'senior-backend', { session_id: 'p' });
  assert.equal(minted.outcome, 'unavailable', 'a lock this mint never held cannot be reported as a decision');
  assert.equal(minted.reason, 'lock-unavailable');
  assert.equal(minted.value, null);
});

// A mint refused by a RULE is the opposite case and must not deny: the run is
// closed, so respawning cannot help, and the gates that care about a closed run
// already have their own denies with the resume remedy in them.
test('a claim mint into a closed run is precondition-failed, so the spawn gate does not deny on it', () => {
  const cwd = project();
  assert.equal(ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' }).outcome, 'applied');
  assert.equal(transitionRunStatusResult(cwd, RUN_ID, { status: 'failed', outcome: 'agent-failed' }).outcome, 'applied');

  const minted = ensureRunAgentClaimResult(cwd, { currentRunId: RUN_ID }, 'senior-backend', { session_id: 'p' });
  assert.equal(minted.outcome, 'precondition-failed');
  assert.equal(minted.reason, 'ledger-not-active');
});

// The terminal sweep reported `0` for "already swept" and for "I never got the
// lock" alike, and that number is what settlement reports as the sweep's work.
test('a claim sweep that cannot take the lock reports unavailable, not a count of zero', () => {
  const cwd = project();
  assert.equal(ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' }).outcome, 'applied');
  const minted = ensureRunAgentClaimResult(cwd, { currentRunId: RUN_ID }, 'senior-backend', { session_id: 'p' });
  assert.equal(minted.outcome, 'applied');
  holdClaimsLock(cwd);

  const swept = releaseRunClaimsResult(cwd, RUN_ID, 'settled');
  assert.equal(swept.outcome, 'unavailable');
  assert.equal(swept.reason, 'claims-lock-unavailable',
    'the reason names WHICH of the two locks the sweep could not take');
  assert.equal(swept.value, null, 'an unswept run must not answer with a count');
  assert.equal(fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'pending')).length, 1,
    'and the claim it did not sweep is still there');
});
