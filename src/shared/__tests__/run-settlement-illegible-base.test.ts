// What the run-settlement projection does when the file it reads BEFORE writing
// cannot be read.
//
// THE DEFECT these characterize is epistemic inversion in the READ, not the
// write: `readJson(path, fallback)` answers an ABSENT file and an UNPARSEABLE one
// with the same caller-supplied value, so "I could not read it" arrives as a
// confident "here is the answer" — and both writers below are read-modify-write.
// An EMPTY file counts as unparseable: it is the signature of an O_TRUNC open
// whose write never landed. `readJsonResult` (shared/fsjson.ts) is the tri-state
// reader that lets each site answer for itself.
//
// The two sites get OPPOSITE answers on purpose, and the asymmetry is the whole
// judgement rather than an inconsistency:
//
//   - activateRunV2RollbackBarrier REFUSES. It is a conditional status advance
//     whose only guard is the terminal status IN the bytes it could not read, so
//     there is nothing honest to publish — patchState's answer. Its `| null` is
//     already consumed by plan-readiness, so refusing needs no new channel.
//   - writeLegacyProjection PRESERVES THE BYTES AND HEALS run.json. Its
//     authoritative content is `settlement-v2.json`, which io.ts has already put
//     on disk, so it is a whole-file replacement of a DERIVED file —
//     writeState's answer — and a corrupt run.json is not the "previous
//     consistent projection" its docblock's `void` argument rests on.
//   - …but the maintenance.json half of that same function refuses, because that
//     one IS a field merge into content nothing can rebuild.
//
// `unreadable` (EACCES/EISDIR/EIO) gets the opposite answer to `corrupt`
// everywhere the two can differ: there are bytes there and we cannot copy them,
// so replacing the file would destroy content nothing ever saw.
//
// ── how the fixtures fence, and how they avoid passing for the wrong reason ──
// Every unreadable case asserts, as a FIXTURE GUARD, that readJsonResult really
// answers `unreadable` — a root uid ignores the mode bits, and this must fail
// loudly there instead of quietly measuring an `ok` read.
// The write-refusal cases follow shared/__tests__/publisher-write-refusal.test.ts:
// a DANGLING link for a path that is only written (the `.corrupt` quarantine),
// MOVE-ASIDE for a path that is read first (run.json), each with a writable
// baseline asserted before it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readJsonResult } from '../fsjson';
import {
  activateRunV2RollbackBarrier,
  effectiveLegacyRunStatus,
  readRunSettlement,
  writeRunSettlement,
} from '../run-settlement';

const fixtures: string[] = [];

// One `after` over a module-level list, never per-test cleanup: a failing
// assertion returns before a per-test call, which is exactly when it is needed.
// The chmod restore is here too, for the same reason — a mode-000 file left
// behind makes the recursive rm fail on some platforms.
test.after(() => {
  for (const dir of fixtures) {
    for (const file of unreadable) {
      try { fs.chmodSync(file, 0o644); } catch { /* not ours, or already gone */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const unreadable: string[] = [];

function project(label: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `t1-illegible-base-${label}-`));
  fixtures.push(cwd);
  return cwd;
}

function runDir(cwd: string, runId: string): string {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Make `file` answer `unreadable`, and prove it did. */
function makeUnreadable(file: string): void {
  fs.chmodSync(file, 0o000);
  unreadable.push(file);
  assert.equal(
    readJsonResult(file).kind,
    'unreadable',
    'fixture guard: this environment must actually produce an unreadable read (a root uid ignores '
    + 'the mode bits, and an `ok` read here would measure nothing)',
  );
}

/** Fence a path that is only ever written. */
function fenceDangling(target: string): void {
  fs.symlinkSync(path.join(path.dirname(target), 'no-such-target'), target);
  assert.equal(fs.existsSync(target), false, 'fixture guard: the link is dangling');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
}

/** Fence a path whose CONTENT is read before it is written. */
function fenceMoveAside(target: string): string {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the writer reaches its write');
  return before;
}

/**
 * The `.corrupt` copy exists AND holds exactly the bytes that were there. Two
 * assertions, because a missing copy would otherwise fail as an ENOENT from
 * `readFileSync` — a red test either way, but one that names the wrong thing.
 */
function assertQuarantined(ledger: string, bytes: string, message: string): void {
  assert.equal(fs.existsSync(`${ledger}.corrupt`), true,
    `${message} — no quarantine copy was written at all`);
  assert.equal(fs.readFileSync(`${ledger}.corrupt`, 'utf8'), bytes, message);
}

const TERMINAL_LEDGER = {
  version: 2,
  runId: 'R',
  kind: 'orchestration',
  qaContractVersion: 2,
  status: 'completed',
  outcome: 'verified',
  canonicalStatus: 'verified',
  createdAt: '2020-01-01T00:00:00.000Z',
  finishedAt: '2020-01-02T00:00:00.000Z',
  transitionHistory: [{ from: 'active', to: 'completed', at: '2020-01-02T00:00:00.000Z' }],
};

// ── activateRunV2RollbackBarrier ─────────────────────────────────────────────
// The early return on a terminal effective status is this function's ENTIRE
// safety property. Under the `{}` fallback an illegible ledger produced an
// effective status of '' — not terminal — so the check was bypassed and the
// record was rebuilt from nothing: fresh `createdAt`, fabricated
// `kind: 'orchestration'`, emptied `transitionHistory`, no `finishedAt`, and
// `canonicalStatus: 'active'`. A settled run came back RESUMABLE to
// `runLedgerAdmitsClaims`, to `writeRunLedgerTransition`'s legality check and to
// `recentAdoptableRunId` — whose `qaContractVersion !== 2` guard this write
// satisfies on its way past.

test('the terminal-status guard is exactly what an illegible read used to bypass', () => {
  // Non-vacuity for every case below, stated directly rather than assumed: the
  // guard fires on the parsed ledger and does NOT fire on the value the fallback
  // substituted for it. Without this pair, a refusal below could be a refusal for
  // some unrelated reason.
  assert.equal(effectiveLegacyRunStatus(TERMINAL_LEDGER), 'completed',
    'the readable ledger IS terminal, so the guard has something to catch');
  assert.equal(effectiveLegacyRunStatus({}), '',
    "and `readJson`'s fallback is not — which is how the guard was bypassed");
  assert.equal(['completed', 'failed', 'blocked'].includes(''), false,
    'an empty effective status passes the terminal test, i.e. activation proceeds');
});

test('a barrier is refused over a run.json that cannot be read, and the bytes are left alone', () => {
  const cwd = project('barrier');

  // Writable, LEGIBLE baseline: an ordinary in-flight ledger still activates.
  // Without it a fixture that stopped reaching the write would pass identically.
  const open = path.join(runDir(cwd, 'open'), 'run.json');
  fs.writeFileSync(open, JSON.stringify({
    version: 1, runId: 'open', status: 'active', kind: 'orchestration',
  }));
  assert.ok(activateRunV2RollbackBarrier(cwd, 'open'), 'legible baseline: a live run activates');
  assert.equal(JSON.parse(fs.readFileSync(open, 'utf8')).qaContractVersion, 2,
    'legible baseline: and the barrier really landed');

  // Control: a legible TERMINAL ledger is refused. This is the behaviour the
  // illegible cases must match, not a new one.
  const done = path.join(runDir(cwd, 'done'), 'run.json');
  fs.writeFileSync(done, JSON.stringify({ ...TERMINAL_LEDGER, runId: 'done' }));
  const doneBefore = fs.readFileSync(done, 'utf8');
  assert.equal(activateRunV2RollbackBarrier(cwd, 'done'), null,
    'control: a finished run is refused when its status can be read');
  assert.equal(fs.readFileSync(done, 'utf8'), doneBefore, 'control: and nothing was written');

  // CORRUPT — a truncated write, the file this run finished with.
  const torn = path.join(runDir(cwd, 'torn'), 'run.json');
  const tornBytes = JSON.stringify(TERMINAL_LEDGER).slice(0, 64);
  fs.writeFileSync(torn, tornBytes);
  assert.equal(readJsonResult(torn).kind, 'corrupt', 'fixture guard: the ledger is unparseable');
  assert.equal(activateRunV2RollbackBarrier(cwd, 'torn'), null,
    'a barrier must not be activated over a status that cannot be read');
  assert.equal(fs.readFileSync(torn, 'utf8'), tornBytes,
    'and the bytes are byte-identical: no fabricated record, and the only copy of the '
    + "run's history is still there");

  // EMPTY — the O_TRUNC signature, which is `corrupt` and not `absent`.
  const blank = path.join(runDir(cwd, 'blank'), 'run.json');
  fs.writeFileSync(blank, '');
  assert.equal(readJsonResult(blank).kind, 'corrupt', 'fixture guard: an empty file is not absent');
  assert.equal(activateRunV2RollbackBarrier(cwd, 'blank'), null,
    'an empty ledger is a torn write, not a fresh run');
  assert.equal(fs.readFileSync(blank, 'utf8'), '', 'and it stays empty rather than becoming an active run');

  // ABSENT still activates: a run whose ledger has not been written yet is the
  // ordinary case, and refusing it would wedge every new run.
  runDir(cwd, 'fresh');
  assert.ok(activateRunV2RollbackBarrier(cwd, 'fresh'),
    'an ABSENT ledger is not an illegible one — a fresh run must still activate');

  // UNREADABLE — bytes exist and cannot be seen. Measured before the fix: the
  // temp+rename never opens the destination for reading, so this was overwritten
  // with no throw at all.
  const locked = path.join(runDir(cwd, 'locked'), 'run.json');
  const lockedBytes = JSON.stringify({ ...TERMINAL_LEDGER, runId: 'locked' });
  fs.writeFileSync(locked, lockedBytes);
  makeUnreadable(locked);
  assert.equal(activateRunV2RollbackBarrier(cwd, 'locked'), null,
    'a ledger we cannot see is the case where overwriting is least defensible');
  fs.chmodSync(locked, 0o644);
  assert.equal(fs.readFileSync(locked, 'utf8'), lockedBytes, 'and its bytes survive');
});

// ── writeLegacyProjection: run.json ──────────────────────────────────────────
// Driven through `writeRunSettlement`, which is the only production caller and
// the thing that establishes `settlement-v2.json` on disk first — the fact that
// makes healing from it legitimate here.

function blockedSettlement(cwd: string, runId: string, reason: string): void {
  const settlement = writeRunSettlement(cwd, runId, {
    status: 'blocked',
    reason,
    incompleteChecks: [],
  });
  assert.equal(settlement?.status, 'blocked', `fixture guard: the ${reason} settlement is canonical`);
  assert.equal(readRunSettlement(cwd, runId)?.reason, reason,
    'fixture guard: and it is on disk, which is what the projection heals from');
}

test('a corrupt run.json is preserved beside itself and re-projected from the settlement', () => {
  const cwd = project('projection-corrupt');

  // Legible baseline: no quarantine file is minted for a readable base.
  const openDir = runDir(cwd, 'open');
  fs.writeFileSync(path.join(openDir, 'run.json'), JSON.stringify({
    version: 2, runId: 'open', kind: 'orchestration', qaContractVersion: 2,
    status: 'blocked', outcome: 'review-cycle-cap', canonicalStatus: 'blocked',
    createdAt: '2020-01-01T00:00:00.000Z',
    runtimeV2RollbackGuard: {
      minimumRuntimeVersion: '1.0.20', canonicalStatus: 'blocked', canonicalOutcome: 'review-cycle-cap',
    },
  }));
  blockedSettlement(cwd, 'open', 'operator-halt');
  assert.equal(fs.existsSync(path.join(openDir, 'run.json.corrupt')), false,
    'legible baseline: a readable base is not quarantined');
  assert.equal(JSON.parse(fs.readFileSync(path.join(openDir, 'run.json'), 'utf8'))
    .runtimeV2RollbackGuard.canonicalOutcome, 'review-cycle-cap',
    'legible baseline: and the base outcome is carried, which is the value the corrupt case loses');

  // CORRUPT base. The bytes must be preserved, and the ROLLBACK GUARD must not
  // collapse with them: `qaContractVersion` is unreadable exactly when the file
  // is, so this used to fall through to the unprotected branch and publish a bare
  // `status: 'blocked'` — which runtime 1.0.19 permits reopening after a resume
  // reason, the one thing the barrier exists to prevent.
  const tornDir = runDir(cwd, 'torn');
  const ledger = path.join(tornDir, 'run.json');
  const tornBytes = '{"version":2,"runId":"torn","qaContractVersion":2,"outcome":"review-cycle-c';
  fs.writeFileSync(ledger, tornBytes);
  assert.equal(readJsonResult(ledger).kind, 'corrupt', 'fixture guard: the base is unparseable');

  blockedSettlement(cwd, 'torn', 'operator-halt');

  assertQuarantined(ledger, tornBytes,
    'the unparseable bytes are preserved beside the file, byte for byte');
  const healed = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(healed.canonicalStatus, 'blocked', 'run.json is re-projected from the canonical settlement');
  assert.equal(healed.status, 'failed',
    'and stays rollback-PROTECTED: `failed` is the one legacy terminal state 1.0.19 cannot reopen');
  assert.equal(healed.runtimeV2RollbackGuard?.canonicalStatus, 'blocked',
    'the guard an illegible base used to strip is present');
  assert.equal(effectiveLegacyRunStatus(healed), 'blocked',
    'so a current runtime still recovers the canonical status through the guard');
});

test('the settlement outranks an illegible base for the blocked OUTCOME', () => {
  const cwd = project('projection-outcome');
  const dir = runDir(cwd, 'R');
  const ledger = path.join(dir, 'run.json');
  fs.writeFileSync(ledger, '{"qaContractVersion":2,"outcome":"review-cycle-c');
  assert.equal(readJsonResult(ledger).kind, 'corrupt', 'fixture guard: the base is unparseable');

  // The clause this file's own comment already named for a transiently
  // non-blocked base covers the illegible one by the same route — '' out of
  // `effectiveLegacyRunOutcome`. Pinned so a later edit cannot quietly reinstate
  // the 10co rewrite for this input.
  blockedSettlement(cwd, 'R', 'review-cycle-cap');
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8'))
    .runtimeV2RollbackGuard?.canonicalOutcome, 'review-cycle-cap',
    "the settlement's own reason is projected, not the `environment-blocked` default");
});

test('an unreadable run.json is refused rather than replaced', () => {
  const cwd = project('projection-unreadable');
  const dir = runDir(cwd, 'R');
  const ledger = path.join(dir, 'run.json');
  const bytes = JSON.stringify({ ...TERMINAL_LEDGER, runId: 'R' });
  fs.writeFileSync(ledger, bytes);
  makeUnreadable(ledger);

  blockedSettlement(cwd, 'R', 'operator-halt');

  fs.chmodSync(ledger, 0o644);
  assert.equal(fs.readFileSync(ledger, 'utf8'), bytes,
    'bytes that exist and cannot be copied must not be replaced');
  assert.equal(fs.existsSync(`${ledger}.corrupt`), false,
    'and nothing is quarantined, because there was nothing we could read to preserve');
});

test('a quarantine the fence refuses stops the whole projection', () => {
  const cwd = project('projection-quarantine');

  // Writable baseline: the same corrupt base with the quarantine path unfenced
  // both preserves and replaces. Without it, a fixture that stopped fencing —
  // or a consent fence closed for an unrelated reason — would pass identically.
  const openDir = runDir(cwd, 'open');
  const openLedger = path.join(openDir, 'run.json');
  fs.writeFileSync(openLedger, '{"qaContractVersion":2,"trunc');
  blockedSettlement(cwd, 'open', 'operator-halt');
  assertQuarantined(openLedger, '{"qaContractVersion":2,"trunc', 'writable baseline: the quarantine lands');
  assert.equal(JSON.parse(fs.readFileSync(openLedger, 'utf8')).canonicalStatus, 'blocked',
    'writable baseline: and the projection lands after it');

  // Dangling, not move-aside: `run.json.corrupt` is only ever WRITTEN, so there
  // is no read to keep alive.
  const fencedDir = runDir(cwd, 'fenced');
  const fencedLedger = path.join(fencedDir, 'run.json');
  const bytes = '{"qaContractVersion":2,"trunc';
  fs.writeFileSync(fencedLedger, bytes);
  fenceDangling(`${fencedLedger}.corrupt`);

  blockedSettlement(cwd, 'fenced', 'operator-halt');

  assert.equal(fs.readFileSync(fencedLedger, 'utf8'), bytes,
    'a base we could not preserve is not replaced either — preservation comes first, and its '
    + 'refusal refuses the pass');
  assert.equal(fs.existsSync(`${fencedLedger}.corrupt`), false,
    'fixture guard: the quarantine really was refused');
});

test('a refused run.json write still stops the sidecar, with a corrupt base quarantined first', () => {
  const cwd = project('projection-fenced-primary');
  const dir = runDir(cwd, 'R');
  const ledger = path.join(dir, 'run.json');
  const sidecar = path.join(dir, 'maintenance.json');
  const bytes = '{"qaContractVersion":2,"trunc';
  fs.writeFileSync(ledger, bytes);
  fs.writeFileSync(sidecar, JSON.stringify({ version: 1, kind: 'opencode-delegation' }));
  // MOVE-ASIDE, not dangling: this writer READS run.json, and a dangling link
  // would make that read `absent` — a legible base, which skips the quarantine
  // entirely and would let this case pass without exercising it.
  const throughLink = fenceMoveAside(ledger);
  assert.equal(throughLink, bytes, 'fixture guard: the corrupt base is still what the reader sees');

  blockedSettlement(cwd, 'R', 'operator-halt');

  assertQuarantined(ledger, bytes, 'the bytes were preserved before the write was attempted');
  assert.equal(fs.readFileSync(ledger, 'utf8'), bytes,
    'fixture guard: the primary write really was refused');
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).settlementHash, undefined,
    'and the sidecar must not carry a settlement the primary projection does not');
});

// ── writeLegacyProjection: maintenance.json ──────────────────────────────────
// The sidecar half is a FIELD MERGE into content this function cannot derive:
// the per-unit delegation ledger, `overallOutcome`, and the WorkUnit/allowlist
// hashes a pending paid fallback is pinned by. Under the `{}` fallback the write
// replaced all of it with two settlement fields, destroying the unparseable bytes
// that recorded the debt on the way. `fallbackCompletionMatch` then reads back a
// file with no marker and holds the run at `validating`.

const UNIT_LEDGER = {
  version: 1,
  kind: 'opencode-delegation',
  role: 'senior-frontend',
  overallOutcome: 'fallback-pending',
  workUnitContractHash: 'c1',
  allowlistHash: 'a1',
  units: { u1: { role: 'senior-frontend', overallOutcome: 'fallback-pending' } },
};

test('an illegible maintenance sidecar is refused, and run.json is still projected', () => {
  const cwd = project('sidecar');

  // Writable, LEGIBLE baseline: the stamp lands AND the ledger survives it.
  const openDir = runDir(cwd, 'open');
  fs.writeFileSync(path.join(openDir, 'run.json'), JSON.stringify({
    version: 2, runId: 'open', status: 'active', canonicalStatus: 'active',
  }));
  fs.writeFileSync(path.join(openDir, 'maintenance.json'), JSON.stringify(UNIT_LEDGER));
  assert.ok(writeRunSettlement(cwd, 'open', { status: 'active', incompleteChecks: [] }),
    'legible baseline: the settlement publishes');
  const stamped = JSON.parse(fs.readFileSync(path.join(openDir, 'maintenance.json'), 'utf8'));
  assert.equal(stamped.canonicalStatus, 'active', 'legible baseline: the sidecar is stamped');
  assert.deepEqual(Object.keys(stamped.units), ['u1'], 'legible baseline: and the unit ledger survives');
  assert.equal(stamped.workUnitContractHash, 'c1',
    'legible baseline: with the hashes a pending debt is pinned by');

  // CORRUPT sidecar.
  const tornDir = runDir(cwd, 'torn');
  fs.writeFileSync(path.join(tornDir, 'run.json'), JSON.stringify({
    version: 2, runId: 'torn', status: 'active', canonicalStatus: 'active',
  }));
  const torn = path.join(tornDir, 'maintenance.json');
  const tornBytes = JSON.stringify(UNIT_LEDGER).slice(0, 90);
  fs.writeFileSync(torn, tornBytes);
  assert.equal(readJsonResult(torn).kind, 'corrupt', 'fixture guard: the sidecar is unparseable');

  assert.ok(writeRunSettlement(cwd, 'torn', { status: 'active', incompleteChecks: [] }),
    'the canonical settlement is unfenced and still lands');
  assert.equal(fs.readFileSync(torn, 'utf8'), tornBytes,
    'the debt-bearing bytes are not replaced by two settlement fields');
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(tornDir, 'run.json'), 'utf8')).settlementHash,
    'string',
    'while run.json — the primary every legacy reader consults — is projected as usual');

  // UNREADABLE sidecar.
  const lockedDir = runDir(cwd, 'locked');
  fs.writeFileSync(path.join(lockedDir, 'run.json'), JSON.stringify({
    version: 2, runId: 'locked', status: 'active', canonicalStatus: 'active',
  }));
  const locked = path.join(lockedDir, 'maintenance.json');
  const lockedBytes = JSON.stringify(UNIT_LEDGER);
  fs.writeFileSync(locked, lockedBytes);
  makeUnreadable(locked);

  assert.ok(writeRunSettlement(cwd, 'locked', { status: 'active', incompleteChecks: [] }),
    'the canonical settlement still lands');
  fs.chmodSync(locked, 0o644);
  assert.equal(fs.readFileSync(locked, 'utf8'), lockedBytes, 'and the sidecar we cannot read survives');
});
