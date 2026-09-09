// What the two settlement DERIVERS do when the files they derive from cannot be
// read. The sibling file (run-settlement-illegible-base.test.ts) covers the
// projection WRITERS; these two are the readers that decide a canonical status.
//
// THE DEFECT is the same epistemic inversion: `readJson(path, fallback)` answers
// an ABSENT file and an ILLEGIBLE one (unparseable, EMPTY — the signature of an
// O_TRUNC open whose write never landed — or unreadable) with the same value, so
// "I could not read it" arrives as a confident fact about the run.
//
// Both sites REFUSE, and each refuses only what it derives:
//
//   - reconcileRunSettlement refuses the whole pass. It is pure derivation from
//     `run.json` and `maintenance.json`; with neither readable there is nothing
//     honest to publish, and `| null` is already its answer for a run that has
//     not activated the V2 lifecycle. It writes NOTHING on the way out, so the
//     bytes recording the run's real history stay on disk for a repair to read.
//   - writeRunSettlement refuses only CERTIFICATION. `verified` is the one status
//     it derives from the marker, and a certificate is a claim about evidence.
//     Every other status still publishes, which is what stops the refusal from
//     stranding a run: it stays non-terminal and drivable, and the ledger can
//     still settle it `failed` or `blocked`.
//
// ── why the fixtures are shaped the way they are ─────────────────────────────
// EVERY unreadable case here is a mode-000 file (EACCES), never a DIRECTORY at
// the path (EISDIR), and the choice is deliberate per site rather than uniform
// taste. reconcile's own pass calls `writeLegacyProjection`, which WRITES
// `run.json`; a directory there throws EISDIR out through that write and into
// reconcile's outer `catch`, which returns the same `null` the fix returns — so
// the reverted code would satisfy these assertions for a reason that has nothing
// to do with the read, and the case would pass vacuously. EACCES does not throw
// anywhere on this path, so `null` can only have come from the refusal. The
// price is that a root uid reads a mode-000 file straight through, so every one
// of them carries a hard fixture guard asserting the read really is `unreadable`.
//
// Non-vacuity is stated rather than assumed: each illegible case is paired with
// the SAME fixture holding the exact value the fallback used to substitute
// (`{}` for the ledger, `{}` for the marker), so the reader can see that the
// refusal replaced a real, different outcome and not a no-op.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stableContractJson } from '../architecture-contract';
import { readJsonResult } from '../fsjson';
import { createPaidFallbackCompletion } from '../maintenance/fallback-proof';
import { qaReportV2Path, recordStackResolution } from '../qa-report-v2';
import { sha256 } from '../text';
import {
  DEFAULT_LIGHTHOUSE_THRESHOLDS,
  currentVerificationSourceHash,
  verificationContractPath,
  type VerificationContractV2,
} from '../verification-contract';
import { reconcileRunSettlement, readRunSettlement, writeRunSettlement } from '../run-settlement';
import { fallbackCompletionMatch, recordsPaidFallback } from '../run-settlement/io';

const fixtures: string[] = [];
const unreadable: string[] = [];

// One `after` over module-level lists, never per-test cleanup: a failing
// assertion returns before a per-test call, which is exactly when it is needed.
// The chmod restore is here for the same reason — a mode-000 file left behind
// makes the recursive rm fail on some platforms.
test.after(() => {
  for (const file of unreadable) {
    try { fs.chmodSync(file, 0o644); } catch { /* already gone */ }
  }
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `t1-illegible-derive-${label}-`));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'R'), { recursive: true });
  return cwd;
}

const runDir = (cwd: string): string => path.join(cwd, '.traffic-one', 'runs', 'R');
const ledgerPath = (cwd: string): string => path.join(runDir(cwd), 'run.json');
const markerPath = (cwd: string): string => path.join(runDir(cwd), 'maintenance.json');

/** Make `file` answer `unreadable`, and prove it did. */
function makeUnreadable(file: string): void {
  fs.chmodSync(file, 0o000);
  unreadable.push(file);
  assert.equal(readJsonResult(file).kind, 'unreadable',
    'fixture guard: this environment must actually produce an unreadable read (a root uid ignores '
    + 'the mode bits, and an `ok` read here would measure nothing)');
}

function assertCorrupt(file: string): void {
  assert.equal(readJsonResult(file).kind, 'corrupt', 'fixture guard: the file is unparseable');
}

function digest(cwd: string, name: string, body: string): void {
  const dir = path.join(cwd, '.traffic-one', 'digests', 'R');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

/**
 * The runtime-owned VerificationContractV2 + matching QaReportV2 that
 * `writeRunSettlement` demands before it will certify anything at all.
 *
 * Present in EVERY fixture that expects `verified`, and the reason is a finding
 * in its own right: without it a `verified` update is already downgraded to
 * `validating` with `verification-evidence-incomplete`, so a fixture that
 * omitted it would show the right status for entirely the wrong reason and
 * measure nothing about the marker.
 */
function writeStrictVerificationEvidence(cwd: string): void {
  const now = '2020-01-03T00:00:00.000Z';
  const withoutHash: Omit<VerificationContractV2, 'contractHash'> = {
    schemaVersion: 2,
    runId: 'R',
    architectureHash: sha256('architecture'),
    baseline: {
      kind: 'file-manifest', identity: 'manifest:illegible-derivation', capturedAt: now,
      filesHash: sha256('files'), fileCount: 0, files: [],
    },
    uiImpact: 'none', uiImpactSource: 'runtime', changedPaths: [], changedRoutes: [],
    scanComplete: true, requiredChecks: ['stack-build', 'stack-test', 'stack-lint'],
    browserRequired: false, nativeAdapter: null, requiredScreenshotWidths: [],
    tabletRisk: false, buildIdentityRequired: false,
    performance: {
      required: false, advisory: false, reason: 'not-required',
      thresholds: { ...DEFAULT_LIGHTHOUSE_THRESHOLDS }, advisoryTolerancePercent: 3,
    },
    generatedAt: now,
  };
  const contract = { ...withoutHash, contractHash: sha256(stableContractJson(withoutHash)) };
  fs.writeFileSync(verificationContractPath(cwd, 'R'), JSON.stringify(contract), 'utf8');
  const reportPath = qaReportV2Path(cwd, 'R');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 2, runId: 'R', verificationContractHash: contract.contractHash,
    generatedAt: now, producer: 'senior-tester', status: 'passed',
    sourceHash: currentVerificationSourceHash(cwd, contract).hash,
    checks: contract.requiredChecks.map((id) => ({ id, status: 'passed' })), routes: [],
  }), 'utf8');
  digest(cwd, 'reviewer.md', '# Reviewer\nverdict: APPROVED\n');
  digest(cwd, 'tester.md', '# Tester\nverdict: TESTS_GREEN\n');
  const resolved: Record<string, { declared: 'declared'; executed: 'passed' }> = {};
  for (const id of withoutHash.requiredChecks) resolved[id] = { declared: 'declared', executed: 'passed' };
  if (!recordStackResolution(cwd, 'R', resolved)) {
    throw new Error('fixture guard: runtime passed record must persist');
  }
}

// ── reconcile: run.json ──────────────────────────────────────────────────────
// The terminal arms (`ledgerStatus === 'failed'` / `'blocked'` / a
// completed+verified ledger) are decided from these bytes. `readJson`'s `{}`
// answered '' — not terminal — so a FAILED run whose ledger was torn fell
// through to the digest arms and reconciled as `code-delivered`, and
// `writeLegacyProjection` then healed run.json into an in-flight projection
// carrying that status. The finished run came back alive and the only record
// that said otherwise was overwritten in the same pass. Same shape the sibling
// lane fixed in `activateRunV2RollbackBarrier`.

const FAILED_LEDGER = {
  version: 2,
  runId: 'R',
  kind: 'orchestration',
  qaContractVersion: 2,
  status: 'failed',
  outcome: 'agent-failed',
  canonicalStatus: 'failed',
  createdAt: '2020-01-01T00:00:00.000Z',
  finishedAt: '2020-01-02T00:00:00.000Z',
  transitionHistory: [{ from: 'active', to: 'failed', at: '2020-01-02T00:00:00.000Z' }],
};

/** A run that has activated V2 and has delivered code but not verified it. */
function failedRun(label: string): string {
  const cwd = project(label);
  fs.writeFileSync(path.join(runDir(cwd), 'verification-v2.json'), '{}', 'utf8');
  digest(cwd, 'frontend.md', '# Frontend\nverdict: IMPLEMENTED\n');
  return cwd;
}

test('a failed run is not resurrected by a ledger that cannot be read', () => {
  // Legible: the terminal arm fires.
  const legible = failedRun('recon-ledger-legible');
  fs.writeFileSync(ledgerPath(legible), JSON.stringify(FAILED_LEDGER), 'utf8');
  assert.equal(reconcileRunSettlement(legible, 'R')?.status, 'failed',
    'legible baseline: a ledger that says failed settles the run failed');

  // NON-VACUITY, and the measurement this whole site rests on: the SAME fixture
  // with the ledger holding exactly `readJson`'s fallback resurrects the run.
  // Without this pair a `null` below could be a refusal for any unrelated reason.
  const substituted = failedRun('recon-ledger-fallback-value');
  fs.writeFileSync(ledgerPath(substituted), '{}', 'utf8');
  assert.equal(reconcileRunSettlement(substituted, 'R')?.status, 'code-delivered',
    'the value the fallback substituted really does reopen a finished run as in-flight');

  // CORRUPT — a torn write, which is what the run actually finished with.
  const torn = failedRun('recon-ledger-torn');
  const tornBytes = JSON.stringify(FAILED_LEDGER).slice(0, 70);
  fs.writeFileSync(ledgerPath(torn), tornBytes, 'utf8');
  assertCorrupt(ledgerPath(torn));
  assert.equal(reconcileRunSettlement(torn, 'R'), null,
    'a derivation whose input cannot be read has nothing honest to publish');
  assert.equal(fs.readFileSync(ledgerPath(torn), 'utf8'), tornBytes,
    'and it writes NOTHING: the bytes recording the run are still there for a repair to read');
  assert.equal(fs.existsSync(path.join(runDir(torn), 'settlement-v2.json')), false,
    'no canonical settlement was minted from a status nobody could read');

  // EMPTY — the O_TRUNC signature, `corrupt` rather than `absent`.
  const blank = failedRun('recon-ledger-blank');
  fs.writeFileSync(ledgerPath(blank), '', 'utf8');
  assertCorrupt(ledgerPath(blank));
  assert.equal(reconcileRunSettlement(blank, 'R'), null,
    'an empty ledger is a torn write, not a run with no status');
  assert.equal(fs.readFileSync(ledgerPath(blank), 'utf8'), '', 'and it stays empty');

  // UNREADABLE — bytes exist and cannot be seen.
  const locked = failedRun('recon-ledger-locked');
  const lockedBytes = JSON.stringify(FAILED_LEDGER);
  fs.writeFileSync(ledgerPath(locked), lockedBytes, 'utf8');
  makeUnreadable(ledgerPath(locked));
  assert.equal(reconcileRunSettlement(locked, 'R'), null,
    'a ledger we cannot see is the case where guessing is least defensible');
  fs.chmodSync(ledgerPath(locked), 0o644);
  assert.equal(fs.readFileSync(ledgerPath(locked), 'utf8'), lockedBytes, 'and its bytes survive');
});

test('an ABSENT ledger still reconciles, so the refusal wedges no ordinary run', () => {
  // The whole risk of refusing is stranding runs that were never broken. A run
  // with no run.json at all is the ordinary early-lifecycle case and must be
  // indistinguishable from before.
  const cwd = failedRun('recon-ledger-absent');
  assert.equal(fs.existsSync(ledgerPath(cwd)), false, 'fixture guard: there is no ledger');
  assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'code-delivered',
    'absent is not illegible — a run whose ledger has not been written yet still settles');
});

// ── reconcile: maintenance.json ──────────────────────────────────────────────
// The `fallback-pending` arm is decided from these bytes, and
// `maintenanceOutcome(null)` is ''. A run owing a paid fallback whose marker was
// torn skipped that arm entirely and took the ledger's word instead: the debt was
// not merely untracked, it was LAUNDERED, because this settlement is what the
// finalizer later checks the debt against.

const PENDING_MARKER = {
  version: 1,
  kind: 'opencode-delegation',
  role: 'senior-frontend',
  outcome: 'failed',
  overallOutcome: 'fallback-pending',
  fallbackAllowed: true,
  workUnitContractHash: sha256('c1'),
  allowlistHash: sha256('a1'),
};

const VERIFIED_LEDGER = {
  version: 2, runId: 'R', kind: 'orchestration', qaContractVersion: 2,
  status: 'completed', outcome: 'verified', canonicalStatus: 'verified',
  createdAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-02T00:00:00.000Z',
};

/** A run whose ledger says verified — so only the marker can hold it back. */
function verifiedRun(label: string): string {
  const cwd = project(label);
  fs.writeFileSync(ledgerPath(cwd), JSON.stringify(VERIFIED_LEDGER), 'utf8');
  writeStrictVerificationEvidence(cwd);
  return cwd;
}

test('a paid-fallback debt is not laundered by a marker that cannot be read', () => {
  // Legible: the debt is seen and the run is held active.
  const legible = verifiedRun('recon-marker-legible');
  fs.writeFileSync(markerPath(legible), JSON.stringify(PENDING_MARKER), 'utf8');
  const held = reconcileRunSettlement(legible, 'R');
  assert.equal(held?.status, 'active', 'legible baseline: an unpaid debt holds the run');
  assert.equal(held?.reason, 'fallback-pending');
  assert.equal(held?.fallback?.state, 'pending',
    'legible baseline: and the debt is pinned into the settlement the finalizer checks');

  // NON-VACUITY: the same fixture with the marker holding `readJson`'s fallback
  // value certifies the run instead. That is the laundering, demonstrated.
  const substituted = verifiedRun('recon-marker-fallback-value');
  fs.writeFileSync(markerPath(substituted), '{}', 'utf8');
  assert.equal(reconcileRunSettlement(substituted, 'R')?.status, 'verified',
    'a marker with no outcome lets the ledger certify the run — the outcome an illegible read used to buy');

  // CORRUPT.
  const torn = verifiedRun('recon-marker-torn');
  const tornBytes = JSON.stringify(PENDING_MARKER).slice(0, 80);
  fs.writeFileSync(markerPath(torn), tornBytes, 'utf8');
  assertCorrupt(markerPath(torn));
  assert.equal(reconcileRunSettlement(torn, 'R'), null,
    'a debt we cannot read is not a debt that is not owed');
  assert.equal(fs.readFileSync(markerPath(torn), 'utf8'), tornBytes, 'and the marker bytes are untouched');
  assert.equal(fs.existsSync(path.join(runDir(torn), 'settlement-v2.json')), false,
    'no certificate was minted over it');

  // UNREADABLE.
  const locked = verifiedRun('recon-marker-locked');
  const lockedBytes = JSON.stringify(PENDING_MARKER);
  fs.writeFileSync(markerPath(locked), lockedBytes, 'utf8');
  makeUnreadable(markerPath(locked));
  assert.equal(reconcileRunSettlement(locked, 'R'), null,
    'same answer for bytes that exist and cannot be seen');
  fs.chmodSync(markerPath(locked), 0o644);
  assert.equal(fs.readFileSync(markerPath(locked), 'utf8'), lockedBytes, 'and they survive');
});

test('an ABSENT maintenance marker still reconciles, and still means no debt', () => {
  const cwd = verifiedRun('recon-marker-absent');
  assert.equal(fs.existsSync(markerPath(cwd)), false, 'fixture guard: there is no marker');
  assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'verified',
    'most runs never delegate at all; refusing them would strand every ordinary run');
});

// ── writeRunSettlement: the certification guard ──────────────────────────────
// This was triaged as erring conservatively — a corrupt marker reads as "no
// marker", which for a run whose settlement already TRACKS a pending fallback
// does hold it at `validating`. The triage is right for that case and WRONG for
// the untracked one, which is what the first test below measures.

const PAID_MARKER = (() => {
  const completion = createPaidFallbackCompletion({
    role: 'quick-fix',
    envelopeHash: sha256('env'),
    workUnitContractHash: sha256('c1'),
    allowlistHash: sha256('a1'),
    digestPath: '.traffic-one/digests/R/quick-fix.md',
    digestHash: sha256('digest'),
    sourceBaselineHash: sha256('before'),
    sourceResultHash: sha256('after'),
    runBaselineHash: sha256('baseline'),
    changedPaths: ['src/a.ts'],
    completedAt: '2020-01-02T00:00:00.000Z',
  });
  return {
    version: 1, kind: 'opencode-delegation', role: 'quick-fix',
    outcome: 'fallback-paid', overallOutcome: 'fallback-paid', fallbackAllowed: false,
    workUnitContractHash: sha256('c1'), allowlistHash: sha256('a1'),
    fallbackCompletion: completion,
  };
})();

test('the marker changes the verdict for a run with NO tracked fallback — which is what the `null` fallback hid', () => {
  // The mechanism, stated directly. The whole fallback check is entered only for
  // `previous.fallback || recordsPaidFallback(marker)`, so with nothing tracked
  // the MARKER is the only thing that can open it — and `readJson`'s `null`
  // never does. That is the inversion: the check is not failed conservatively,
  // it is not reached.
  assert.equal(recordsPaidFallback(PAID_MARKER), true,
    'a legible marker recording paid work opens the fallback check');
  assert.equal(recordsPaidFallback(null), false,
    "…and `readJson`'s `null` skips it entirely, which is how an illegible marker certified the run");
  assert.equal(fallbackCompletionMatch(undefined, PAID_MARKER), 'marker-missing',
    'and once opened, paid work the settlement never pinned is a hold');

  const legible = project('io-paid-legible');
  writeStrictVerificationEvidence(legible);
  fs.writeFileSync(markerPath(legible), JSON.stringify(PAID_MARKER), 'utf8');
  const heldByMarker = writeRunSettlement(legible, 'R', { status: 'verified' });
  assert.equal(heldByMarker?.status, 'validating',
    'legible baseline: a marker citing paid work the settlement never tracked holds certification');
  assert.equal(heldByMarker?.reason, 'fallback-marker-missing');

  const absent = project('io-paid-absent');
  writeStrictVerificationEvidence(absent);
  assert.equal(writeRunSettlement(absent, 'R', { status: 'verified' })?.status, 'verified',
    'and with no marker at all the run certifies — absent is not illegible, and the guard is not a blanket veto');
});

test('certification is refused over a marker that cannot be read, under its own name', () => {
  const torn = project('io-paid-torn');
  writeStrictVerificationEvidence(torn);
  const tornBytes = JSON.stringify(PAID_MARKER).slice(0, 90);
  fs.writeFileSync(markerPath(torn), tornBytes, 'utf8');
  assertCorrupt(markerPath(torn));
  const tornSettlement = writeRunSettlement(torn, 'R', { status: 'verified' });
  assert.equal(tornSettlement?.status, 'validating',
    'an unreadable ledger of paid work is not evidence that none is owed');
  assert.equal(tornSettlement?.reason, 'fallback-marker-unreadable',
    'and it says which of the two holds it: we could not look, rather than we looked and found a gap');
  assert.ok(tornSettlement?.incompleteChecks.includes('fallback-marker-unreadable'),
    'the check is enumerated for the readers that list what is outstanding');
  assert.equal(fs.readFileSync(markerPath(torn), 'utf8'), tornBytes, 'and the marker is untouched');

  const locked = project('io-paid-locked');
  writeStrictVerificationEvidence(locked);
  const lockedBytes = JSON.stringify(PAID_MARKER);
  fs.writeFileSync(markerPath(locked), lockedBytes, 'utf8');
  makeUnreadable(markerPath(locked));
  const lockedSettlement = writeRunSettlement(locked, 'R', { status: 'verified' });
  assert.equal(lockedSettlement?.status, 'validating', 'same answer for EACCES as for a torn file');
  assert.equal(lockedSettlement?.reason, 'fallback-marker-unreadable');
  fs.chmodSync(markerPath(locked), 0o644);
  assert.equal(fs.readFileSync(markerPath(locked), 'utf8'), lockedBytes, 'and its bytes survive');
});

test('only CERTIFICATION is refused: every other status still publishes over an illegible marker', () => {
  // The reason this refusal strands nothing. If it applied to all statuses the
  // run would be undrivable while the marker stayed broken; instead it stays
  // non-terminal, keeps advancing, and can still reach a terminal verdict that
  // is not a certificate.
  const cwd = project('io-other-statuses');
  fs.writeFileSync(markerPath(cwd), JSON.stringify(PAID_MARKER).slice(0, 90), 'utf8');
  assertCorrupt(markerPath(cwd));

  assert.equal(writeRunSettlement(cwd, 'R', { status: 'active' })?.status, 'active',
    'the run keeps moving');
  assert.equal(writeRunSettlement(cwd, 'R', { status: 'code-delivered' })?.status, 'code-delivered');
  assert.equal(writeRunSettlement(cwd, 'R', { status: 'failed' })?.status, 'failed',
    'and a terminal verdict that claims nothing about paid work still lands');
  assert.equal(readRunSettlement(cwd, 'R')?.status, 'failed', 'durably');
});

test('the tracked-debt hold this extends is PRE-EXISTING, not introduced here', () => {
  // The known wedge — a `fallback:pending` debt whose only discharge is a
  // completion record in a file nothing can read — already fires today for a run
  // whose settlement tracks the debt, because `fallbackCompletionMatch` reads the
  // illegible marker as no marker and answers `pending`. Pinned so the claim in
  // io.ts's comment ("this only extends the same hold to the UNTRACKED case") is
  // measured rather than argued.
  const cwd = project('io-wedge-precedent');
  writeStrictVerificationEvidence(cwd);
  const tracked = {
    state: 'pending' as const,
    workUnitContractHash: sha256('c1'),
    allowlistHash: sha256('a1'),
  };
  assert.equal(fallbackCompletionMatch(tracked, null), 'pending',
    'a tracked debt with no readable marker was already unmatched before this change');

  writeRunSettlement(cwd, 'R', {
    status: 'active',
    reason: 'fallback-pending',
    fallback: tracked,
    incompleteChecks: ['fallback-pending'],
  });
  assert.equal(readRunSettlement(cwd, 'R')?.fallback?.state, 'pending',
    'fixture guard: the debt is tracked in the settlement');

  const held = writeRunSettlement(cwd, 'R', {
    status: 'verified',
    fallback: { ...tracked, state: 'completed' },
  });
  assert.equal(held?.status, 'validating',
    'with no marker on disk at all, the tracked debt already holds certification');
  assert.equal(held?.reason, 'fallback-pending',
    'under the pre-existing name — which is why the new hold needed a different one');
});
