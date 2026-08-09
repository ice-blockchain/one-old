// The write-set transaction: shared/fsjson.ts#writeJsonSet, and the one site
// that adopts it.
//
// THE DEFECT, and it is not a lost write. Two artifacts on disk that DISAGREE,
// each writer individually looking fine. `writeLegacyProjection` is the
// archetype tests/refusal-contract.test.ts's rule 4 was built from: run.json and
// maintenance.json carrying the same `canonicalStatus`/`settlementHash`, so
// refusing either one leaves the survivor citing a settlement the other has
// never heard of. Ordering the pair and consuming the primary's boolean closed
// the run.json-refused direction; NO ordering closes the other one, because by
// the time the sidecar is refused the primary has already landed.
//
// WHAT IS PROVEN HERE IS THE REFUSAL HALF OF THE GUARANTEE, WHICH IS THE HALF
// THAT EXISTS. writeJsonSet is all-or-nothing against a refusal because every
// member's fence verdict is decided before anything is staged. It is NOT
// crash-atomic — committing N paths is N renames — and nothing below claims it
// is. A test that asserted atomicity would be asserting the claim rather than
// the code.
//
// FENCING, one path at a time, and the variant is load-bearing (the convention
// writer-refusal-reporting.test.ts documents):
//   - DANGLING link for a path that is only ever WRITTEN. That is every member
//     of a bare writeJsonSet call: the primitive reads nothing.
//   - MOVE-ASIDE link (rename the real file, symlink the original name to it)
//     for maintenance.json, which writeLegacyProjection `existsSync`-es and then
//     READS to merge into. A dangling link there is `existsSync` false, so the
//     sidecar never becomes a member of the set at all and the case passes
//     having exercised nothing. The writable baseline cannot catch that, because
//     the baseline is a different run directory.
//
// Every case asserts a WRITABLE BASELINE first: src/build/test-preload.mjs pins
// TRAFFIC_ONE_ASK_USE_PLUGIN='0' to hold the consent fence open, and a fixture
// that quietly stopped fencing would otherwise pass identically.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readJsonResult, stateWritePermitted, writeJsonSet } from '../fsjson';
import { writeRunSettlement } from '../run-settlement';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-write-json-set-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  return cwd;
}

function statePath(cwd: string, ...parts: string[]): string {
  const target = path.join(cwd, '.traffic-one', ...parts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

/** Fence a path that is only ever written. */
function fenceDangling(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(target), 'no-such-target'), target);
  assert.equal(fs.existsSync(target), false, 'fixture guard: the link is dangling');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
}

/** Fence a path whose CONTENT the writer reads before writing it. */
function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the writer reaches its write');
}

/** Any staging residue this call left behind, so a leak is a failure and not a mess. */
function tempResidue(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.set.tmp'));
}

test('a refused member refuses the whole set, and the permitted ones do not land', () => {
  const cwd = project('refusal');

  // Writable baseline: both members land, so the fence below is what stops them.
  const openA = statePath(cwd, 'runs', 'open', 'a.json');
  const openB = statePath(cwd, 'runs', 'open', 'b.json');
  assert.equal(writeJsonSet([{ path: openA, value: { n: 1 } }, { path: openB, value: { n: 1 } }]), true,
    'writable baseline: an unfenced set publishes');
  assert.deepEqual(readJsonResult(openA), { kind: 'ok', value: { n: 1 } },
    'writable baseline: the first member is on disk');
  assert.deepEqual(readJsonResult(openB), { kind: 'ok', value: { n: 1 } },
    'writable baseline: and so is the second');

  // The fence goes on the SECOND member, which is the case the sequential shape
  // gets wrong: by the time it is refused, the first has already been renamed
  // into place. Nothing here may reach that point.
  const first = statePath(cwd, 'runs', 'fenced', 'primary.json');
  const second = statePath(cwd, 'runs', 'fenced', 'sidecar.json');
  fs.writeFileSync(first, JSON.stringify({ revision: 1 }), 'utf8');
  fenceDangling(second);

  assert.equal(writeJsonSet([{ path: first, value: { revision: 2 } }, { path: second, value: { revision: 2 } }]), false,
    'a set with a fenced member is refused');
  assert.deepEqual(readJsonResult(first), { kind: 'ok', value: { revision: 1 } },
    'the permitted member must not land when a sibling of the same update was refused — '
    + 'a partial landing is the divergence this primitive exists to make unrepresentable');
  assert.equal(fs.existsSync(second), false,
    'fixture guard: the fenced member really was refused');
  assert.deepEqual(tempResidue(path.dirname(first)), [],
    'and a refused set leaves no staged temp behind');
});

test('an empty set is not a refusal', () => {
  assert.equal(writeJsonSet([]), true, 'nothing was declined, because nothing was asked');
});

// The OTHER half of the all-or-nothing guarantee, and it is the half a reader
// would assume rather than check: staging every payload to a temp sibling before
// committing ANY of them means a plain errno — ENOSPC, a path whose ancestor is
// not a directory — also lands nothing, where the sequential shape would already
// have committed the members before it.
//
// This case exists because a mutation proved the tests could not see it. With
// the up-front classification left in place, collapsing the two phases into one
// stage-and-commit loop per member passed everything else in this file: the
// docblock claimed staging atomicity and only the refusal half was pinned.
//
// The fixture is a regular FILE where member two's parent directory must be, so
// the recursive `mkdir` cannot proceed. That is a shape question rather than a
// permission one, so it holds for every user INCLUDING root — and it is not a
// refusal (`stateWritePermitted` is true for the path), which is what keeps this
// distinct from the fenced case above.
test('an errno while staging lands nothing, not a prefix', () => {
  const cwd = project('staging');
  const first = statePath(cwd, 'runs', 'staging', 'primary.json');
  const ancestor = statePath(cwd, 'runs', 'staging', 'notadir');
  fs.writeFileSync(ancestor, 'x', 'utf8');
  const second = path.join(ancestor, 'sidecar.json');
  assert.equal(stateWritePermitted(second), true,
    'fixture guard: the second member is PERMITTED, so this is an errno and not a refusal');

  assert.throws(
    () => writeJsonSet([{ path: first, value: { n: 1 } }, { path: second, value: { n: 1 } }]),
    /EEXIST|ENOTDIR/,
    'an errno is the caller\'s problem and must not become a silent no-op',
  );
  assert.equal(readJsonResult(first).kind, 'absent',
    'the member that staged cleanly must not be on disk — nothing commits until every '
    + 'payload is staged, which is what makes an errno all-or-nothing too');
  assert.deepEqual(tempResidue(path.dirname(first)), [],
    'and the staged temp is cleaned up on the way out');
});

// The DECLARED BOUND, asserted rather than trusted. Refusal is all-or-nothing;
// the commit loop is not, and a failure there may leave a prefix landed. The
// property that keeps that honest is that such a failure ESCAPES as an errno
// instead of coming back as a clean `false` — a caller told "refused" over a
// half-landed set is the exact lie the docblock's bound exists to avoid.
//
// A DIRECTORY at the destination is the fence here, deliberately, and not one of
// the permission shapes: `rename` onto a directory is EISDIR for every user
// INCLUDING root, so there is no reading of this fixture under which it degrades
// to a no-op and passes vacuously.
test('a commit-phase failure escapes as an errno and does not masquerade as a refusal', () => {
  const cwd = project('commit-bound');
  const landed = statePath(cwd, 'runs', 'bound', 'primary.json');
  const blocked = statePath(cwd, 'runs', 'bound', 'sidecar.json');
  fs.mkdirSync(blocked, { recursive: true });
  assert.ok(fs.statSync(blocked).isDirectory(), 'fixture guard: the second member is a directory');

  assert.throws(
    () => writeJsonSet([{ path: landed, value: { n: 1 } }, { path: blocked, value: { n: 1 } }]),
    /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|EPERM/,
    'a rename that cannot complete must not be reported as a refusal — `false` means the '
    + 'fence declined the whole set, and here a prefix of it is already on disk',
  );
  assert.deepEqual(readJsonResult(landed), { kind: 'ok', value: { n: 1 } },
    'the prefix really did land, which is the bound this primitive declares rather than closes');
  assert.deepEqual(tempResidue(path.dirname(landed)), [],
    'and the members that never committed leave no staged temp behind');
});

// ── the adopting site ────────────────────────────────────────────────────────
// writeLegacyProjection, through writeRunSettlement — the only production
// caller, and the archetype rule 4 was built from.

function seedRun(cwd: string, runId: string): { run: string; maintenance: string } {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const run = path.join(dir, 'run.json');
  const maintenance = path.join(dir, 'maintenance.json');
  fs.writeFileSync(run, JSON.stringify({ version: 2, runId, status: 'active', canonicalStatus: 'active' }), 'utf8');
  fs.writeFileSync(maintenance, JSON.stringify({ version: 1, runId, kind: 'opencode-delegation' }), 'utf8');
  return { run, maintenance };
}

test('a refused maintenance sidecar no longer lets run.json advance past it', () => {
  const cwd = project('projection');

  const open = seedRun(cwd, 'baseline');
  assert.ok(writeRunSettlement(cwd, 'baseline', { status: 'active', incompleteChecks: [] }),
    'writable baseline: an unfenced settlement publishes');
  const openRun = JSON.parse(fs.readFileSync(open.run, 'utf8'));
  assert.equal(typeof openRun.settlementHash, 'string', 'writable baseline: run.json is projected');
  assert.equal(JSON.parse(fs.readFileSync(open.maintenance, 'utf8')).settlementHash, openRun.settlementHash,
    'writable baseline: and the sidecar agrees with it — the pair this test is about');

  // MOVE-ASIDE, not dangling: the projection `existsSync`-es this path and then
  // reads it to merge into. A dangling link is `existsSync` false, which drops
  // the sidecar out of the set entirely and would let this pass vacuously.
  const fenced = seedRun(cwd, 'fenced');
  fenceMoveAside(fenced.maintenance);
  assert.equal(readJsonResult(fenced.maintenance).kind, 'ok',
    'fixture guard: the sidecar is legible, so it really is a member of the set');

  // The canonical record is NOT a member of this set, deliberately. run.json and
  // maintenance.json are peers — the same two fields from the same settlement,
  // neither derived from the other — while `settlement-v2.json` is what both are
  // projections OF. Folding it in would make the canonical record hostage to its
  // own compatibility projection, which is the layering inversion an atomic set
  // buys at the cost of the weaker member vetoing the stronger one.
  assert.ok(writeRunSettlement(cwd, 'fenced', { status: 'active', incompleteChecks: [] }),
    'the canonical settlement is unfenced and still lands');
  assert.equal(JSON.parse(fs.readFileSync(fenced.maintenance, 'utf8')).settlementHash, undefined,
    'fixture guard: the sidecar really was refused');
  assert.equal(JSON.parse(fs.readFileSync(fenced.run, 'utf8')).settlementHash, undefined,
    'run.json must not advance past a sidecar that was refused — the two carry the SAME '
    + 'settlementHash, so either one alone is two artifacts disagreeing');
  assert.equal(JSON.parse(fs.readFileSync(fenced.run, 'utf8')).canonicalStatus, 'active',
    'and the previous consistent projection is what legacy readers are left on, which is '
    + 'exactly what writeLegacyProjection\'s `void` has always claimed');
});
