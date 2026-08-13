// The Cursor spawn ledger's publishers, over a store write the fence REFUSED.
//
// Every mutation of `cursor-spawns.json` is a read-modify-write inside
// `withCursorSpawnObservationLock`, and each one used to hand back the row it had
// just mutated IN MEMORY whether or not `writeCursorSpawnObservationStore`
// answered true — the refusal-blind publisher, seven times in two files. The
// caller then acted on a store that never changed: a correlated child transcript
// nothing on disk carries, a retry settled against a start that was never
// recorded, a one-shot follow-up "claimed" by a row every later hook still reads
// as pending. rule 2 of tests/refusal-contract.test.ts is the shape guard; these
// are the consequences, one per publisher.
//
// FENCING, and why the symlink half rather than the consent half: it is the only
// one that can refuse THIS ONE path while everything around it stays writable,
// and reads are never fenced — so the planted link still serves the store to
// `readCursorSpawnObservationStore` and every function under test reaches its
// write instead of bailing on a missing row. Move-aside rather than dangling for
// exactly that reason (see minted-over-refused-write.test.ts, the same fence for
// the neighbouring defect class).
//
// Every case asserts a WRITABLE BASELINE first: src/build/test-preload.mjs holds
// the consent fence open, so a fixture that stopped fencing would pass
// identically without one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claimCursorFollowupsBatch,
  consumeCursorSpawnObservation,
  markCursorSpawnObservationFollowupEmitted,
  markCursorSpawnObservationRetryHandled,
  suppressCursorFollowupsBatch,
} from '../cursor-followups';
import {
  claimCursorSpawnObservation,
  cursorParentObservationSnapshot,
  listCursorSpawnObservations,
  recordCursorSpawnObservation,
  updateCursorSpawnObservation,
  type CursorSpawnObservation,
} from '../cursor-observations';
import { runDir } from '../run-paths';

const PARENT = 'parent-refusal';
const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-spawn-refused-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  return cwd;
}

function storeFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'cursor-spawns.json');
}

/** Plant a link at the store, keeping its CONTENT readable through it. */
function fenceStore(cwd: string, runId: string): void {
  const target = storeFile(cwd, runId);
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted at the store');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so every writer reaches its write');
}

/** The rows on DISK, which is the only thing a later hook will ever see. */
function onDisk(cwd: string, runId: string): CursorSpawnObservation[] {
  return listCursorSpawnObservations(cwd, runId);
}

function spawn(cwd: string, runId: string, role: string, toolCallId: string, startedAtMs: number): void {
  assert.ok(recordCursorSpawnObservation(cwd, runId, {
    parentSessionId: PARENT,
    toolCallId,
    role,
    requestedModel: 'gpt-5.6-terra-medium',
    tier: 'highest',
    expectedModel: 'gpt-5.6-terra',
    startedAtMs,
  }), 'fixture guard: the spawn anchor is on disk');
}

/** A spawn correlated to a child and classified, but not yet consumed. */
function classified(cwd: string, runId: string, role: string, toolCallId: string, childId: string): void {
  spawn(cwd, runId, role, toolCallId, 1_000);
  assert.ok(claimCursorSpawnObservation(cwd, runId, toolCallId, childId, 2_000),
    'fixture guard: the child transcript is correlated on disk');
  assert.ok(updateCursorSpawnObservation(cwd, runId, childId, {
    outcome: 'api-limit',
    error: 'API usage limit reached.',
    directive: 'retry same role on the prescribed model',
  }, 3_000), 'fixture guard: the classified failure is on disk');
}

/** …and consumed, i.e. the finalized head the follow-up batch CAS requires. */
function finalized(cwd: string, runId: string, role: string, toolCallId: string, childId: string): void {
  classified(cwd, runId, role, toolCallId, childId);
  assert.ok(consumeCursorSpawnObservation(cwd, runId, childId, 4_000),
    'fixture guard: the failure is finalized on disk');
}

// ── recordCursorSpawnObservation ────────────────────────────────────────────
// The row is the RECEIPT for a spawn that happened. subagent-bind.ts settles a
// correlated retry only when this answers non-null, and a settle against a
// ledger with no start in it marks `retryHandled` on nothing — the retry is spent
// and the failure it was answering stays pending forever.

test('a spawn observation the store refused to publish is not handed back as recorded', () => {
  const runId = 'run-record';

  const open = project('record-baseline');
  spawn(open, runId, 'senior-architect', 'tool_seed', 1_000);
  assert.deepEqual(onDisk(open, runId).map((row) => row.toolCallId), ['tool_seed'],
    'writable baseline: the anchor it returned is the anchor on disk — the promise this test is about');

  const fenced = project('record-fenced');
  spawn(fenced, runId, 'senior-architect', 'tool_seed', 1_000);
  fenceStore(fenced, runId);

  assert.equal(recordCursorSpawnObservation(fenced, runId, {
    parentSessionId: PARENT,
    toolCallId: 'tool_refused',
    role: 'senior-backend',
    requestedModel: 'gpt-5.6-terra-medium',
    tier: 'balanced',
    expectedModel: 'gpt-5.6-terra',
    startedAtMs: 5_000,
  }), null, 'a spawn the store refused must not be answered with the observation it minted in memory');
  assert.deepEqual(onDisk(fenced, runId).map((row) => row.toolCallId), ['tool_seed'],
    'fixture guard: the publish really was refused');
});

// ── claim / update / consume ────────────────────────────────────────────────
// The correlation chain, and each link is only real once it is durable. A claim
// that exists in one process lets cursor-failure-persist.ts publish a failure
// under a childTranscriptId the store never learned, and the next transcript pass
// finds the spawn still unclaimed and correlates it a second time.

test('the correlation chain answers null for each store publish the fence refused', () => {
  const runId = 'run-chain';
  const childId = 'child-chain';

  const open = project('chain-baseline');
  spawn(open, runId, 'senior-architect', 'tool_chain', 1_000);
  assert.equal(claimCursorSpawnObservation(open, runId, 'tool_chain', childId, 2_000)?.childTranscriptId,
    childId, 'writable baseline: the claim is answered with the correlated row');
  assert.equal(onDisk(open, runId)[0]?.childTranscriptId, childId,
    'writable baseline: and the correlation is on disk');
  assert.equal(updateCursorSpawnObservation(open, runId, childId, { outcome: 'generic' }, 3_000)?.outcome,
    'generic', 'writable baseline: the classification is answered');
  assert.equal(consumeCursorSpawnObservation(open, runId, childId, 4_000)?.consumedAtMs, 4_000,
    'writable baseline: and the finalization is answered');

  const fenced = project('chain-fenced');
  spawn(fenced, runId, 'senior-architect', 'tool_chain', 1_000);
  spawn(fenced, runId, 'senior-backend', 'tool_pending', 1_500);
  // One row correlated and classified BEFORE the fence, so `update` and
  // `consume` below reach a target and are refused on the write rather than on a
  // precondition.
  assert.ok(claimCursorSpawnObservation(fenced, runId, 'tool_chain', childId, 2_000));
  assert.ok(updateCursorSpawnObservation(fenced, runId, childId, { outcome: 'generic' }, 3_000));
  fenceStore(fenced, runId);

  assert.equal(claimCursorSpawnObservation(fenced, runId, 'tool_pending', 'child-pending', 5_000), null,
    'a correlation the store refused is not a claim, and returning the row would publish a failure under it');
  assert.equal(updateCursorSpawnObservation(fenced, runId, childId, {
    directive: 'retry same role on the prescribed model',
  }, 6_000), null, 'a classification the store refused must not be reported as persisted');
  assert.equal(consumeCursorSpawnObservation(fenced, runId, childId, 7_000), null,
    'and a finalization the store refused is not a finalized failure');

  const rows = onDisk(fenced, runId);
  assert.equal(rows.find((row) => row.toolCallId === 'tool_pending')?.childTranscriptId, null,
    'fixture guard: the second spawn is still uncorrelated on disk');
  const target = rows.find((row) => row.toolCallId === 'tool_chain')!;
  assert.equal(target.directive, null, 'fixture guard: the directive never landed');
  assert.equal(target.consumedAtMs, null, 'fixture guard: and the row is still unconsumed');
});

// ── the one-shot markers ────────────────────────────────────────────────────
// `followupEmitted` and `retryHandled` are compare-and-SET: the whole value of a
// non-null answer is "this hook owns the action, no other hook will take it". Over
// a refused write two racing hooks are both told they own it.

test('a one-shot marker the store refused is not reported as claimed', () => {
  const runId = 'run-markers';

  const open = project('markers-baseline');
  finalized(open, runId, 'senior-architect', 'tool_mark', 'child-mark');
  assert.equal(markCursorSpawnObservationFollowupEmitted(open, runId, 'child-mark', 5_000)?.followupEmitted,
    true, 'writable baseline: the follow-up marker is claimed');
  assert.equal(onDisk(open, runId)[0]?.followupEmitted, true,
    'writable baseline: and the claim is on disk, which is what stops the second hook');

  const fenced = project('markers-fenced');
  finalized(fenced, runId, 'senior-architect', 'tool_mark', 'child-mark');
  finalized(fenced, runId, 'senior-backend', 'tool_retry', 'child-retry');
  fenceStore(fenced, runId);

  assert.equal(markCursorSpawnObservationFollowupEmitted(fenced, runId, 'child-mark', 5_000), null,
    'a CAS whose set was refused has won nothing, and null is already this function\'s "somebody else owns it"');
  assert.equal(markCursorSpawnObservationRetryHandled(fenced, runId, 'child-retry', 5_000), null,
    'the retry marker is the same CAS through the same writer');
  assert.deepEqual(onDisk(fenced, runId).map((row) => row.followupEmitted || row.retryHandled), [false, false],
    'fixture guard: neither marker landed, so a second hook would find both rows pending');
});

// ── the batches ─────────────────────────────────────────────────────────────
// Both hand back ARRAYS, so their refusal is the empty batch — the answer
// cursor-failures.ts already floors on (`if (!claimed.length) return noop()`).

test('a follow-up batch and a suppression the store refused come back empty', () => {
  const followupRequest = (cwd: string, runId: string, row: CursorSpawnObservation, fingerprint: string) => ({
    parentSessionId: PARENT,
    expectedParentFingerprint: fingerprint,
    role: row.role,
    childTranscriptId: row.childTranscriptId!,
    toolCallId: row.toolCallId,
    expectedLatestToolCallId: row.toolCallId,
    expectedLatestStartedAtMs: row.startedAtMs,
    directive: row.directive!,
    prescribedModel: row.prescribedModel,
  });
  const request = (cwd: string, runId: string) => {
    const snapshot = cursorParentObservationSnapshot(cwd, runId, PARENT)!;
    const row = snapshot.observations.find((item) => item.toolCallId === 'tool_batch')!;
    return followupRequest(cwd, runId, row, snapshot.fingerprint);
  };

  const runId = 'run-batches';

  const open = project('batch-baseline');
  finalized(open, runId, 'senior-architect', 'tool_batch', 'child-batch');
  assert.equal(claimCursorFollowupsBatch(open, runId, [request(open, runId)], 8_000).length, 1,
    'writable baseline: the batch is claimed');
  assert.equal(onDisk(open, runId)[0]?.followupEmitted, true,
    'writable baseline: and every row it returned carries the emission on disk');
  const openSuppressed = suppressCursorFollowupsBatch(open, runId, {
    scope: 'child',
    toolCallId: 'tool_batch',
    parentSessionId: PARENT,
    observedAtMs: 9_000,
    reason: 'subagent-stop-user-abort',
  });
  assert.equal(openSuppressed.length, 1, 'writable baseline: the suppression reports the row it changed');
  assert.equal(onDisk(open, runId)[0]?.followupSuppressed, true, 'writable baseline: durably');

  const fenced = project('batch-fenced');
  finalized(fenced, runId, 'senior-architect', 'tool_batch', 'child-batch');
  const pinned = request(fenced, runId);
  fenceStore(fenced, runId);

  assert.deepEqual(claimCursorFollowupsBatch(fenced, runId, [pinned], 8_000), [],
    'a batch whose emission was refused is not owned: returning it emits a continuation every later hook re-emits');
  assert.deepEqual(suppressCursorFollowupsBatch(fenced, runId, {
    scope: 'child',
    toolCallId: 'tool_batch',
    parentSessionId: PARENT,
    observedAtMs: 9_000,
    reason: 'subagent-stop-user-abort',
  }), [], 'and a suppression that did not reach disk has suppressed nothing');

  const row = onDisk(fenced, runId)[0]!;
  assert.equal(row.followupEmitted, false, 'fixture guard: the emission never landed');
  assert.equal(row.followupSuppressed, false, 'fixture guard: nor the suppression');
});
