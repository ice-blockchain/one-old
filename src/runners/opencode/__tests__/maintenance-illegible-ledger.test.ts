// What `recordMaintenanceDelegationOutcome` does when the per-unit ledger it
// merges into cannot be read.
//
// THE DEFECT: the marker is read-modify-write, and `readJson(file, null)`
// answered a corrupt, an EMPTY (the signature of an O_TRUNC open whose write
// never landed) and an UNREADABLE marker with the same `null` an ABSENT one
// gets. So the merge started from `{}` and every prior unit's row went with it —
// including a still-owed `fallback-pending` debt and the two hashes that identify
// it — and the write then destroyed the bytes that recorded them.
//
// The erasure is not merely a lost field. The settlement below the merge follows
// the PROJECTION of the ledger, so a sibling unit's success settles the run
// `code-delivered` over an obligation nothing can find any more. That is the
// exact laundering the per-unit ledger was introduced to prevent (see the
// docblock on MaintenanceUnitRecord), arriving through the read instead of
// through the wholesale overwrite.
//
// THE ANSWER IS REFUSAL, both kinds, and it is not the answer run.json's
// projection gets. This is a merge into a base, and unlike run.json there is no
// canonical record to rebuild from: `settlement-v2.json` carries no `units`, so
// "heal" could only ever mean publishing one unit's outcome as the whole batch's.
// The refusal deliberately precedes the settlement write, for the same reason the
// ledger write's own refusal does — pinning a `fallback-pending` debt whose only
// discharge is a completion record in a file we just refused would hold the run
// at `validating` forever.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readJsonResult } from '../../../shared/fsjson';
import { readRunSettlement } from '../../../shared/run-settlement';
import type { RunBootstrapEnvelopeV2 } from '../../../shared/run-bootstrap-policy';
import { recordMaintenanceDelegationOutcome } from '../maintenance';
import type { DelegateResult, Rec } from '../types';

const fixtures: string[] = [];
const unreadable: string[] = [];

// One `after` over module-level lists, never per-test cleanup: a failing
// assertion returns before a per-test call, which is precisely when it is needed.
test.after(() => {
  for (const file of unreadable) {
    try { fs.chmodSync(file, 0o644); } catch { /* already gone */ }
  }
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const MAINTENANCE_STATE: Rec = {
  version: 1,
  mode: 'existing-codebase',
  stack: 'default',
  lifecycle: { phase: 'maintenance' },
};

/** Only the fields recordMaintenanceDelegationOutcome reads off an envelope. */
const BOOTSTRAP = {
  runId: 'R',
  workUnit: { contractHash: 'c2', allowlist: ['src/**'], allowlistExclude: [] },
} as unknown as RunBootstrapEnvelopeV2;

const DELIVERED: DelegateResult = {
  ok: true, action: 'delegated', touched: [], error: null, model: 'm',
} as unknown as DelegateResult;

/**
 * A prior unit that OWES a paid fallback. `startedAt` is what
 * `projectMaintenanceMarker` sorts on, so an older pending row is the projection
 * a later success must not be able to replace.
 */
const OWED = {
  version: 1,
  kind: 'opencode-delegation',
  role: 'senior-frontend',
  overallOutcome: 'fallback-pending',
  workUnitContractHash: 'c1',
  allowlistHash: 'a1',
  units: {
    u1: {
      role: 'senior-frontend',
      outcome: 'failed',
      opencodeOutcome: 'failed',
      overallOutcome: 'fallback-pending',
      fallbackAllowed: true,
      workUnitContractHash: 'c1',
      allowlistHash: 'a1',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:00:01.000Z',
    },
  },
};

function project(label: string, marker: string | null): { cwd: string; file: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `t1-illegible-ledger-${label}-`));
  fixtures.push(cwd);
  const dir = path.join(cwd, '.traffic-one', 'runs', 'R');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'maintenance.json');
  if (marker !== null) fs.writeFileSync(file, marker);
  return { cwd, file };
}

function record(cwd: string, unitId: string): void {
  recordMaintenanceDelegationOutcome(
    cwd, MAINTENANCE_STATE, 'R', 'senior-backend', DELIVERED, Date.now(), false, BOOTSTRAP, unitId,
  );
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

test("a legible prior ledger keeps its debt, and the settlement follows the batch's projection", () => {
  // The writable baseline for every case below, and it carries the two claims
  // that make them non-vacuous: this harness DOES reach the ledger write, and it
  // DOES reach the settlement write past it. Without the second, "no settlement
  // was written" in the illegible cases would pass for the wrong reason — a
  // preflight rejection returns before the settlement without any refusal.
  const { cwd, file } = project('legible', JSON.stringify(OWED));
  record(cwd, 'u2');

  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(merged.units).sort(), ['u1', 'u2'],
    "the prior unit's row survives the new one");
  assert.equal(merged.overallOutcome, 'fallback-pending',
    'and the projection still reports the oldest still-owed debt, not this unit`s success');
  assert.equal(readRunSettlement(cwd, 'R')?.reason, 'fallback-pending',
    'so the settlement pins the debt rather than settling the run code-delivered');
  assert.equal(readRunSettlement(cwd, 'R')?.fallback?.workUnitContractHash, 'c1',
    'against the OWING unit`s contract hash');
});

test('a corrupt ledger refuses the record instead of dropping the debt it holds', () => {
  const tornBytes = JSON.stringify(OWED).slice(0, 120);
  const { cwd, file } = project('corrupt', tornBytes);
  assert.equal(readJsonResult(file).kind, 'corrupt', 'fixture guard: the ledger is unparseable');

  record(cwd, 'u2');

  assert.equal(fs.readFileSync(file, 'utf8'), tornBytes,
    'the bytes that record the debt are byte-identical: a repair can still read them');
  assert.equal(readRunSettlement(cwd, 'R'), null,
    'and NO settlement was written — the refusal precedes it, so nothing pins a debt whose '
    + 'discharge record would have to live in the file we just refused');
});

test('an EMPTY ledger is a torn write, not a first delegation', () => {
  const { cwd, file } = project('empty', '');
  assert.equal(readJsonResult(file).kind, 'corrupt', 'fixture guard: an empty file is not absent');

  record(cwd, 'u2');

  assert.equal(fs.readFileSync(file, 'utf8'), '', 'the marker is not replaced');
  assert.equal(readRunSettlement(cwd, 'R'), null, 'and no settlement is derived from it');
});

test('an unreadable ledger is refused rather than replaced', () => {
  const bytes = JSON.stringify(OWED);
  const { cwd, file } = project('unreadable', bytes);
  makeUnreadable(file);

  record(cwd, 'u2');

  fs.chmodSync(file, 0o644);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes,
    'bytes that exist and cannot be copied must not be replaced');
  assert.equal(readRunSettlement(cwd, 'R'), null, 'and nothing is derived from what we could not read');
});

test('an ABSENT marker still records: a first delegation must not be refused', () => {
  const { cwd, file } = project('absent', null);
  assert.equal(readJsonResult(file).kind, 'absent', 'fixture guard: there is genuinely no marker');

  record(cwd, 'u2');

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written.units), ['u2'], 'the first unit is recorded');
  assert.equal(readRunSettlement(cwd, 'R')?.status, 'code-delivered',
    'and its settlement follows, exactly as before — `absent` is not `illegible`');
});
