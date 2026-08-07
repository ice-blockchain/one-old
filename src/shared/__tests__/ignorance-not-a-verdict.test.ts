// A function that could not read, or could not finish reading, must say so
// rather than answer with a verdict — and the SAME ignorance needs opposite
// treatment in its two consumer classes. Three sites, one shape:
//
//   - activeRunClaimScan's truncation/read failure, rendered as a LIVE claim.
//   - the same scan's staleness test, with no lower bound on the age.
//   - the run ledger's claim-admission and identity-freeze probes, which both
//     read an illegible ledger as a definite answer, in opposite directions.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_TIMESTAMP_FUTURE_SKEW_MS, SUBAGENT_STALE_MS } from '../../config/state';
import { readJsonResult } from '../fsjson';
import {
  activeRunClaimCount,
  activeRunClaimScan,
  runLiveClaimEvidence,
  writeRunSettlement,
} from '../run-settlement';
import {
  ensureRunLedgerResult,
  runIdentityFrozen,
  runLedgerAdmitsClaims,
  runLedgerClaimAdmission,
  withRunLedgerLock,
} from '../state/run-agent/ledger';
import { projectRunLedgerForV2Rollback } from '../run-settlement';
import { transitionRunStatus } from '../state';

function withProject(run: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-laneA-ignorance-'));
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'R'), { recursive: true });
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function claimFile(cwd: string, name: string, stampedAt: Date | null, runId = 'R'): string {
  const target = path.join(cwd, '.traffic-one', 'runs', runId, `${name}.json`);
  const at = stampedAt ? stampedAt.toISOString() : undefined;
  fs.writeFileSync(target, JSON.stringify({
    claimId: `senior-backend-${name}`,
    runId,
    role: 'senior-backend',
    status: 'claimed',
    ...(at ? { claimedAt: at, updatedAt: at } : {}),
  }), 'utf8');
  return target;
}

// ── item 2: the future-timestamp veto ────────────────────────────────────────

test('a claim stamped ahead of now is an untrustworthy clock, not a live agent', () => {
  withProject((cwd) => {
    // BASELINE, asserted first so every refusal below is measured against a
    // scan that demonstrably counts. Without it a `count: 0` proves only that
    // the fixture never produced a countable record.
    claimFile(cwd, 'live', new Date(Date.now() - 60_000));
    assert.equal(activeRunClaimScan(cwd, 'R').count, 1, 'baseline: a fresh claim is counted');

    // Inside the tolerance the repo already applies to a stamp ahead of now, a
    // negative age is ordinary clock jitter and must STILL veto. This row is
    // what stops the fix from degenerating into "any negative age is ignored" —
    // that version passes every other assertion in this test.
    claimFile(cwd, 'jitter', new Date(Date.now() + STATE_TIMESTAMP_FUTURE_SKEW_MS - 30_000));
    assert.equal(
      activeRunClaimScan(cwd, 'R').count,
      2,
      'a stamp inside the future-skew tolerance is still a live agent',
    );

    // Past it, it is not evidence about an agent at all. `ageMs > STALE_MS` had
    // no lower bound, so this record vetoed until wall-clock time caught up.
    claimFile(cwd, 'skewed', new Date(Date.now() + 6 * 60 * 60 * 1000));
    assert.equal(
      activeRunClaimScan(cwd, 'R').count,
      2,
      'a stamp beyond the skew bound is a clock that stepped, not a third agent',
    );

    // And the ordinary stale row still behaves, so the bound was added rather
    // than the upper one replaced.
    claimFile(cwd, 'stale', new Date(Date.now() - SUBAGENT_STALE_MS - 60_000));
    assert.equal(activeRunClaimScan(cwd, 'R').count, 2, 'the staleness bound is unchanged');
  });
});

test('the mtime fallback carries the same lower bound as the stamp it replaces', () => {
  withProject((cwd) => {
    // No usable timestamp field at all, so the scan falls back to the record's
    // own mtime — a subtraction with exactly the same negative-age hole.
    const target = claimFile(cwd, 'no-stamp', null);
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
    fs.utimesSync(target, future, future);
    // Fixture guard: the record must genuinely carry no parseable stamp, or
    // this measures the stamp path and the mtime path is never reached.
    const parsed = readJsonResult<Record<string, unknown>>(target);
    assert.equal(parsed.kind, 'ok');
    assert.equal(parsed.kind === 'ok' && parsed.value.claimedAt, undefined, 'fixture: no stamp');

    assert.equal(activeRunClaimScan(cwd, 'R').count, 0, 'a future mtime is not liveness either');

    // Baseline for the same path: a RECENT mtime with no stamp must still count.
    const recent = new Date(Date.now() - 60_000);
    fs.utimesSync(target, recent, recent);
    assert.equal(activeRunClaimScan(cwd, 'R').count, 1, 'baseline: mtime liveness still counts');
  });
});

test('a future-stamped claim no longer holds a settlement at validating', () => {
  withProject((cwd) => {
    // Measured end to end, on the field the veto actually writes.
    // `writeRunSettlement` downgrades `verified` on `activeClaims > 0`.
    claimFile(cwd, 'live', new Date(Date.now() - 60_000));
    const held = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(held?.activeClaims, 1, 'baseline: a live claim is carried into the settlement');
    assert.ok(held?.incompleteChecks.includes('active-claims'));

    fs.rmSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'live.json'));
    claimFile(cwd, 'skewed', new Date(Date.now() + 6 * 60 * 60 * 1000));
    const released = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(released?.activeClaims, 0, 'a skewed stamp must not veto certification');
    assert.equal(
      released?.incompleteChecks.includes('active-claims'),
      false,
      'and the veto must not be re-added under another name',
    );
  });
});

// ── item 1: the truncation sentinel ──────────────────────────────────────────

function seedStaleClaims(cwd: string, count: number): void {
  const at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (let index = 0; index < count; index += 1) {
    claimFile(cwd, String(index).padStart(5, '0'), at);
  }
}

test('runLiveClaimEvidence separates "no live claim" from "could not finish looking"', () => {
  withProject((cwd) => {
    assert.equal(runLiveClaimEvidence(cwd, 'R'), 'none', 'an empty run is positively empty');

    claimFile(cwd, 'live', new Date(Date.now() - 60_000));
    assert.equal(runLiveClaimEvidence(cwd, 'R'), 'live');

    fs.rmSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'live.json'));
    assert.equal(runLiveClaimEvidence(cwd, 'R'), 'none');
  });
});

test('a scan that hits its bound reports ignorance, and the veto sentinel is untouched', () => {
  withProject((cwd) => {
    // Every record is 30 days stale, so a scan that FINISHED would answer
    // "nothing is alive here" — the answer a deleter needs and never gets.
    seedStaleClaims(cwd, 2_049);
    const scan = activeRunClaimScan(cwd, 'R');
    assert.equal(scan.complete, false, 'fixture: the bound must actually be hit');
    assert.equal(scan.count, 0, 'fixture: nothing in the inspected prefix is alive');

    assert.equal(runLiveClaimEvidence(cwd, 'R'), 'unknown');
    // The whole point of not folding this into the sentinel: the four vetoes
    // that read the count must keep getting their conservative >= 1.
    assert.equal(activeRunClaimCount(cwd, 'R'), 1, 'the settlement veto still refuses');
  });
});

test('positive evidence outranks the bound: a live claim inside the prefix is still live', () => {
  withProject((cwd) => {
    // Names sort before the padded numerics, so this one lands in the prefix
    // the scan actually reads. Asserted rather than assumed.
    claimFile(cwd, '00000-live', new Date(Date.now() - 60_000));
    seedStaleClaims(cwd, 2_049);
    const scan = activeRunClaimScan(cwd, 'R');
    assert.equal(scan.complete, false, 'fixture: the bound is still hit');
    assert.equal(scan.count, 1, 'fixture: the live claim was inside the inspected prefix');
    assert.equal(runLiveClaimEvidence(cwd, 'R'), 'live', 'seen beats unfinished');
  });
});

test('an unreadable subdirectory is the same ignorance without any bound being hit', () => {
  withProject((cwd) => {
    const sub = path.join(cwd, '.traffic-one', 'runs', 'R', 'pending');
    fs.mkdirSync(sub, { recursive: true });
    fs.chmodSync(sub, 0o000);
    try {
      // HARD fixture guard. A mode-000 directory is read straight through by
      // root, and this whole case would then be a vacuous pass on a readable
      // dir. Nothing below runs unless the process genuinely cannot enumerate.
      let enumerable = true;
      try { fs.readdirSync(sub); } catch { enumerable = false; }
      assert.equal(enumerable, false, 'fixture: the subdirectory must be unreadable to THIS process');

      const scan = activeRunClaimScan(cwd, 'R');
      assert.equal(scan.scanned, 0, 'no bound was hit — one EACCES is enough');
      assert.equal(scan.complete, false);
      assert.equal(runLiveClaimEvidence(cwd, 'R'), 'unknown');
      assert.equal(activeRunClaimCount(cwd, 'R'), 1, 'the veto sentinel is unchanged here too');
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });
});

// ── item 3: the illegible ledger ─────────────────────────────────────────────

function corruptLedger(cwd: string, runId: string): void {
  fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', runId, 'run.json'), '{"status": "acti');
}

// A DIRECTORY, not a mode-000 file: `readJsonResult` catches the EISDIR rather
// than throwing, so there is no write path for an outer catch to hide, and
// EISDIR is returned for every user INCLUDING root — which mode 000 is not.
// Both probes under test are read-only, so nothing needs the path to be
// writable afterwards.
function unreadableLedger(cwd: string, runId: string): void {
  const target = path.join(cwd, '.traffic-one', 'runs', runId, 'run.json');
  fs.rmSync(target, { force: true });
  fs.mkdirSync(target, { recursive: true });
  const read = readJsonResult(target);
  assert.equal(read.kind, 'unreadable', 'fixture: the ledger must read as unreadable');
}

test('runLedgerClaimAdmission names the case the boolean could not', () => {
  withProject((cwd) => {
    for (const id of ['absent', 'active', 'terminal', 'corrupt', 'unreadable']) {
      fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', id), { recursive: true });
    }
    assert.equal(runLedgerClaimAdmission(cwd, ''), 'closed');
    assert.equal(runLedgerClaimAdmission(cwd, 'absent'), 'admits', 'no ledger reads as planned');

    assert.ok(transitionRunStatus(cwd, 'active', { status: 'active' }));
    assert.equal(runLedgerClaimAdmission(cwd, 'active'), 'admits');

    assert.ok(transitionRunStatus(cwd, 'terminal', { status: 'active' }));
    assert.ok(transitionRunStatus(cwd, 'terminal', { status: 'failed', outcome: 'agent-failed' }));
    assert.equal(runLedgerClaimAdmission(cwd, 'terminal'), 'closed');

    corruptLedger(cwd, 'corrupt');
    assert.equal(runLedgerClaimAdmission(cwd, 'corrupt'), 'unknown');
    unreadableLedger(cwd, 'unreadable');
    assert.equal(runLedgerClaimAdmission(cwd, 'unreadable'), 'unknown');
  });
});

test('the boolean keeps admitting on ignorance — a gate must not strand a healthy child', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'C'), { recursive: true });
    assert.ok(transitionRunStatus(cwd, 'C', { status: 'active' }));
    assert.equal(runLedgerAdmitsClaims(cwd, 'C'), true, 'baseline');
    corruptLedger(cwd, 'C');
    // Byte-identical to the pre-fix behaviour, deliberately: model-rotation.ts
    // replaces an agent this returns false for, and codex-child-model.ts /
    // plan-runteam.ts render a deny from it. Nothing about the shipped prose
    // moves as a result of this change.
    assert.equal(runLedgerAdmitsClaims(cwd, 'C'), true);
  });
});

test('the mirror it claims is broken exactly at the illegible read', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'M'), { recursive: true });
    assert.ok(transitionRunStatus(cwd, 'M', { status: 'active' }));
    corruptLedger(cwd, 'M');
    // The predicate says a claim may be staked; the thing it mirrors refuses.
    // Only the three-valued form can carry that, and it is the reason a caller
    // rendering "respawn will not help" prose needs a third answer.
    assert.equal(runLedgerAdmitsClaims(cwd, 'M'), true);
    assert.equal(runLedgerClaimAdmission(cwd, 'M'), 'unknown');
    const attempt = ensureRunLedgerResult(cwd, 'M', { status: 'active', kind: 'agent-claim' });
    assert.equal(attempt.outcome, 'unavailable');
    assert.equal(attempt.reason, 'ledger-corrupt');
  });
});

test('the admission probe still takes no lock and still reads the V2 rollback projection', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'L'), { recursive: true });
    // Physically `failed`, canonically active behind the rollback barrier. A
    // probe that read `status` raw would call this run closed and every child
    // in it unbindable.
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'L', 'run.json'),
      JSON.stringify(projectRunLedgerForV2Rollback({ runId: 'L' }, 'active')),
    );
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'L', 'run.json'), 'utf8'));
    assert.equal(raw.status, 'failed', 'fixture: the projection must be the barrier shape');
    assert.equal(runLedgerClaimAdmission(cwd, 'L'), 'admits');

    // No lock: it answers while the ledger lock is HELD, and it leaves no lock
    // dir of its own behind.
    let answeredUnderLock: string | null = null;
    const held = withRunLedgerLock(cwd, 'L', () => {
      answeredUnderLock = runLedgerClaimAdmission(cwd, 'L');
    });
    assert.equal(held, true, 'fixture: the lock must actually have been taken');
    assert.equal(answeredUnderLock, 'admits');

    fs.rmSync(path.join(cwd, '.traffic-one', 'runs', 'L', 'run.json'));
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'L2'), { recursive: true });
    runLedgerClaimAdmission(cwd, 'L2');
    runLedgerAdmitsClaims(cwd, 'L2');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', 'L2')), [],
      'the probe writes nothing, including no lock dir');
  });
});

test('an illegible ledger FREEZES the run identity instead of licensing a re-stamp', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'F'), { recursive: true });

    // Baseline both ways, so the corrupt row below cannot pass for a reason
    // unrelated to legibility.
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'F' }), false, 'baseline: no ledger, not frozen');
    assert.ok(transitionRunStatus(cwd, 'F', { status: 'active' }));
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'F' }), true, 'baseline: an active run is frozen');
    assert.ok(transitionRunStatus(cwd, 'F', { status: 'failed', outcome: 'agent-failed' }));
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'F' }), false, 'baseline: a settled run is not');

    // The run the fix is about: active, then its ledger is truncated mid-write.
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'G'), { recursive: true });
    assert.ok(transitionRunStatus(cwd, 'G', { status: 'active' }));
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'G' }), true, 'baseline before corruption');
    corruptLedger(cwd, 'G');
    // detection-stamp.ts spends `false` here as permission to overwrite
    // stack/backend/frontend with a live re-detection — the exact re-stamp that
    // unbinds every live role claim, and it also skips the drift record.
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'G' }), true);

    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'H'), { recursive: true });
    assert.ok(transitionRunStatus(cwd, 'H', { status: 'active' }));
    unreadableLedger(cwd, 'H');
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'H' }), true);

    // The two ignorances answered OPPOSITELY, on the same bytes, in one file.
    assert.equal(runLedgerAdmitsClaims(cwd, 'G'), true, 'a gate keeps admitting');
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'G' }), true, 'permission is withheld');

    // An ABSENT ledger is untouched: nothing is on disk to be in flight.
    assert.equal(runIdentityFrozen(cwd, { currentRunId: 'nope' }), false);
    assert.equal(runIdentityFrozen(cwd, {}), false);
  });
});
