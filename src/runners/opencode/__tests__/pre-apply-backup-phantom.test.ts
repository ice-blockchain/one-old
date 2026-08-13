// src/runners/opencode/__tests__/pre-apply-backup-phantom.test.ts
// A BACKUP THIS CODE RECORDS MUST EXIST ON DISK, because the rollback deletes the
// target before it restores.
//
// ── the defect this pins, which a read conversion INTRODUCED ──────────────────
// `copyPath` used to call `fs.copyFileSync(src, dst)`. The bounded-read lane
// routed it through `copyRegularFile`, which answers `false` — it does not throw
// — when the source is not a regular file, and the return value was DISCARDED.
// `copyPath`'s caller is `backupApplyTargets`, the pre-apply backup of the user's
// working tree, and it recorded `{ existed: true, backupPath }` unconditionally
// afterwards. `restoreApplyTargets` then `rmSync`s the target BEFORE copying the
// backup back, so a backup that never happened turned a rollback into a DELETION
// OF THE FILE IT EXISTS TO PROTECT. DRIVEN by the round-4 peer at a FIFO patch
// target: backup did not throw, `existed: true` with a `backupPath` absent from
// disk, restore failed `ENOENT … pre-apply-backup/0`, target GONE.
//
// The conversion also REMOVED A REAL HANG, and both halves matter: the
// pre-conversion `copyFileSync` sat in `open(2)` on that same FIFO until the
// parent SIGKILLed it at 8 018 ms. So the direction was right and the answer
// shape was dropped — which is why this file drives the sequence in a CHILD under
// a parent deadline (a hang and a phantom are different failures and the test has
// to tell them apart) and asserts the TARGET SURVIVES.
//
// ── why the invariant is the assertion, not the FIFO ─────────────────────────
// A FIFO at a patch target needs a local process — `mkfifo` — so it is not
// clone-deliverable, and a test that only planted one would pin the shape rather
// than the property. The property is: every record `backupApplyTargets` returns
// with `existed: true` carries a `backupPath` THAT IS ON DISK. That is what the
// phantom violated, it holds for every shape, and it is what makes the rollback's
// remove-then-restore order safe. The FIFO arm is how the property is provoked;
// the regular-file arm is the anti-vacuity control, and it must round-trip the
// bytes or the suite is asserting about a sequence that never ran.
//
// ── AND THAT INVARIANT WAS THE FIXED BRANCH'S, WHICH IS THIS ROUND'S CORRECTION
// The paragraph above is true and INSUFFICIENT, and the false half is recorded
// rather than rewritten because the shape of it is the finding: `copyPath` has
// THREE branches and the invariant above is a property of the one that was fixed.
// The DIRECTORY branch was `fs.cpSync(src, dst, { recursive: true, force: true })`,
// which silently omits a FIFO or a socket inside the tree, so `existed: true` came
// with a `backupPath` that IS on disk and cannot reconstruct the target. The peer
// evaluated this file's invariant inside both destroying arms and printed
// `pinInvariantHolds: true`. A pin shaped around the fix cannot see the sibling.
//
// So the assertion below is the OUTCOME instead: the ENTRY SET AND KINDS of the
// target after a rollback must equal what they were before it. That is what a
// backup owes — reconstruction, not existence — it is violated in one line by the
// FIFO-in-a-directory arm, and it holds for every shape and every branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'pre-apply-backup-child.ts');

// Well above the 8 018 ms the pre-conversion code took to be killed on this
// shape, so a SIGKILL here means the hang is back and not that the box is slow.
const CHILD_TIMEOUT_MS = 20_000;

interface Arm {
  readonly shape: string;
  readonly skipped?: string;
  readonly backupThrew: string | null;
  readonly records: {
    existed: boolean;
    backupPath: string | null;
    backupOnDisk: boolean;
    backupContents: string[] | null;
  }[];
  readonly restoreError: string | null;
  readonly targetKind: string;
  readonly targetBytes: string | null;
  readonly innerBytes: string | null;
  readonly entriesBefore: string[];
  readonly entriesAfter: string[];
}

/**
 * A HANG AND A PHANTOM MUST NOT WEAR THE SAME TEST TITLE, which is why the
 * deadline is not asserted in here.
 *
 * The round-5 peer drove both mutants of this pin — the answer discarded again
 * (returns in 1 051 ms with the recorded-phantom diagnostic) and the
 * pre-conversion `copyFileSync` (spends the full deadline in `open(2)`, dies on
 * the signal assertion at 21 372 ms) — and reported that they die for genuinely
 * different reasons but **under the same `not ok` line**. A reviewer grepping
 * titles cannot tell "the backup is a lie" from "the backup blocks forever", and
 * those have different remedies.
 *
 * So `drive` reports the two outcomes as DATA, the deadline is a test of its own
 * with its own title, and each arm below skips VISIBLY when its child never
 * returned — the mode is reported once, by the test named for it. Memoised so a
 * shape is still driven exactly once no matter how many tests read it.
 */
type Outcome = { readonly arm: Arm } | { readonly hang: string };

const driven = new Map<string, Outcome>();

function drive(shape: string): Outcome {
  // The fixture PROJECT is a working tree with a patch target in it, and it
  // cannot live inside this repository — the plugin-source stand-down fence
  // refuses project state here. `os.tmpdir()` at runtime, inside the test runner,
  // removed on the way out.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pre-apply-backup-'));
  try {
    const run = spawnSync(process.execPath, [
      '--import', PRELOAD, '--import', 'tsx', CHILD, root, shape,
    ], {
      cwd: REPO_ROOT, encoding: 'utf8', env: process.env,
      timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    if (run.signal !== null) {
      return {
        hang: `the ${shape} arm did not RETURN (${run.signal} after ${CHILD_TIMEOUT_MS} ms). The pre-apply backup `
          + 'is blocking again: `copyFileSync` on a FIFO waits for a writer forever, which is what routing '
          + `copyPath through copyRegularFile removed.\n${run.stdout ?? ''}\n${run.stderr ?? ''}`,
      };
    }
    const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    assert.ok(line, `the ${shape} arm printed no result: ${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    return { arm: JSON.parse(line) as Arm };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function outcomeOf(shape: string): Outcome {
  const seen = driven.get(shape);
  if (seen) return seen;
  const fresh = drive(shape);
  driven.set(shape, fresh);
  return fresh;
}

/** The arm, or a visible skip deferring to the deadline test above. */
function armOf(shape: string, t: { skip: (why: string) => void }): Arm | null {
  const outcome = outcomeOf(shape);
  if ('hang' in outcome) {
    t.skip(`the ${shape} child never returned — reported by the deadline test, not by this one`);
    return null;
  }
  return outcome.arm;
}

const SHAPES = ['regular', 'fifo', 'dir-regular', 'dir-fifo'] as const;

test('every arm RETURNS before the deadline — a BLOCKING backup is a different failure from a phantom one', () => {
  const hung = SHAPES.filter((shape) => 'hang' in outcomeOf(shape));
  const why = SHAPES.map((shape) => {
    const outcome = driven.get(shape);
    return outcome && 'hang' in outcome ? outcome.hang : null;
  }).filter((message): message is string => message !== null);
  assert.deepEqual(hung, [],
    `a child spent the whole ${CHILD_TIMEOUT_MS} ms deadline without returning, which is the HANG this `
    + 'conversion removed (8 018 ms of SIGKILL before it) and NOT the phantom-backup defect the arms below '
    + `pin. The two have different remedies, so they have different titles.\n\n${why.join('\n\n')}`);
});

test('a pre-apply backup is never RECORDED unless it is on disk (the regular-file control round-trips)', (t) => {
  const arm = armOf('regular', t);
  if (!arm) return;
  assert.equal(arm.skipped, undefined, 'the control arm cannot be skipped');
  assert.equal(arm.backupThrew, null, 'a regular file must back up without throwing');
  assert.deepEqual(arm.records.map((r) => [r.existed, r.backupOnDisk]), [[true, true]],
    'the backup this call recorded must be a file that exists');
  assert.equal(arm.restoreError, null, 'the rollback of a real backup must not report an error');
  // ANTI-VACUITY: the sequence really ran, and it really restored the bytes. Both
  // assertions above pass trivially against an empty record list.
  assert.equal(arm.targetKind, 'file', 'the target must survive its own rollback');
  assert.equal(arm.targetBytes, 'ORIGINAL BYTES\n', 'the rollback must restore the original bytes');
});

test('a NON-REGULAR patch target refuses the backup and the TARGET SURVIVES', (t) => {
  const arm = armOf('fifo', t);
  if (!arm) return;
  // VISIBLE, not a bare `return`. A `return` reports the test as PASSED with
  // `# skipped 0`, so the load-bearing arm going quiet is byte-indistinguishable
  // from a full pass — including in the counts a reviewer is told to assert.
  // DRIVEN by the peer with a failing `mkfifo` stub on PATH: `ok 2`, `# pass 2`,
  // `# skipped 0`, exit 0. Any TMPDIR on a filesystem that refuses FIFOs produces
  // it, which is a contest this session has already lost runs to.
  if (arm.skipped) { t.skip(`no FIFO available: ${arm.skipped}`); return; }
  // FAIL CLOSED, at the moment the evidence is created. `run-model.ts` catches
  // this and answers `kind: 'failed'` BEFORE `git apply` runs, so nothing is
  // applied and nothing is rolled back — which is what the pre-conversion code
  // achieved by hanging, and what the discarded boolean lost.
  assert.notEqual(arm.backupThrew, null,
    'a patch target that is not a regular file must REFUSE the apply. Answering `false` and recording the '
    + 'backup anyway is what turned the rollback into a deletion: restoreApplyTargets removes the target '
    + 'before it restores, so the phantom backup destroys the object it protects.');
  assert.match(arm.backupThrew ?? '', /not a regular file/,
    'the refusal must say what was wrong with the source');
  assert.deepEqual(arm.records, [], 'a refused backup must record nothing at all');
  assert.equal(arm.targetKind, 'fifo',
    'THE TARGET MUST STILL BE THERE. This is the byte-losing half of the finding: with the boolean discarded, '
    + 'the backup was recorded, the apply proceeded, and the rollback deleted the user\'s object.');
});

test('a DIRECTORY patch target round-trips its whole entry set through a rollback', (t) => {
  const arm = armOf('dir-regular', t);
  if (!arm) return;
  assert.equal(arm.skipped, undefined, 'the directory control arm cannot be skipped');
  assert.equal(arm.backupThrew, null, 'an ordinary directory must back up without throwing');
  assert.deepEqual(arm.records.map((r) => [r.existed, r.backupOnDisk]), [[true, true]],
    'the backup this call recorded must exist');
  assert.deepEqual(arm.records[0]?.backupContents, ['ordinary.txt:file'],
    'the backup of a directory must CONTAIN the directory\'s entries — this is the assertion the record-on-disk '
    + 'invariant cannot make, and the one the silent cpSync omission violated');
  assert.equal(arm.restoreError, null, 'the rollback of a real directory backup must not report an error');
  // ANTI-VACUITY, and the property in one line: the tree came back.
  assert.deepEqual(arm.entriesAfter, arm.entriesBefore,
    'the rollback must reconstruct the target exactly — same entries, same kinds');
  assert.equal(arm.innerBytes, 'ORIGINAL BYTES\n', 'the rollback must restore the bytes inside the directory');
});

test('a DIRECTORY holding a non-regular entry refuses the backup and the ENTRY SET SURVIVES', (t) => {
  const arm = armOf('dir-fifo', t);
  if (!arm) return;
  if (arm.skipped) { t.skip(`no FIFO available: ${arm.skipped}`); return; }

  // THE OUTCOME, not the record. `fs.cpSync` returned success here in ~2 ms with
  // the FIFO missing from the destination, `existed: true` and the backupPath on
  // disk — so the invariant the FILE branch is pinned by HELD while the backup
  // could not reconstruct the target. `restoreApplyTargets` then `rmSync`d the
  // target and copied the incomplete tree back, reporting `null`: a clean
  // rollback, having destroyed part of what it protected.
  assert.notEqual(arm.backupThrew, null,
    'a directory holding a FIFO, a socket or a device node must REFUSE the apply rather than record a backup '
    + 'that cannot reconstruct it. fs.cpSync omits such an entry SILENTLY and returns success, which is worse '
    + 'than the discarded boolean it sits beside: there is no answer to discard.');
  assert.match(arm.backupThrew ?? '', /cannot copy .*(?:FIFO|socket|device|not a regular file)/,
    'the refusal must name the entry it refused and what it was');
  assert.deepEqual(arm.records, [], 'a refused backup must record nothing at all');
  assert.deepEqual(arm.entriesAfter, arm.entriesBefore,
    'THE ENTRY SET MUST BE INTACT. This is the byte-losing half of the directory finding: the rollback removes '
    + 'the target first, so a backup that omitted an entry silently deletes it and reports success.');
  assert.ok(arm.entriesBefore.includes('pipe:fifo'),
    `FIXTURE the arm must actually have planted the FIFO inside the directory (before: ${arm.entriesBefore.join(', ')})`);
  assert.equal(arm.innerBytes, 'ORIGINAL BYTES\n',
    'and the ordinary file beside it must still hold its bytes');
});
