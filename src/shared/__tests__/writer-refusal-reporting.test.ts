// What a writer REPORTS when shared/fsjson.ts refuses its write — the sites whose
// callee had no channel at all.
//
// These are the rule-3/rule-4 half of the defect class characterized in
// publisher-write-refusal.test.ts. There the write's boolean existed and was
// dropped. Here it died one frame lower: `writeState` was `void`, so five of its
// 30-odd callers could not have seen a refusal even in principle, and each
// invented its own answer — `return true` — for a state file that is not on disk.
//
// FENCING, and why exactly one path: every case plants a symlink at ONE named
// file, so everything around it stays writable and a refusal can only be about
// that path (classifyStateWrite in fsjson.ts refuses the LINK-ness of a target,
// dangling or not). Two variants, and picking the wrong one passes vacuously:
//
//   - DANGLING link for a path that is only written.
//   - MOVE-ASIDE link (rename the real file, symlink the original name to it) for
//     a path the writer READS first. A dangling link there makes that read fail,
//     the writer bails on its own precondition, and the write is never attempted:
//     the test passes having proved nothing, and the writable baseline does not
//     catch it because the baseline is a different path. Those cases assert the
//     read still resolves before asserting anything about the write.
//
// Every case asserts a WRITABLE BASELINE first. src/build/test-preload.mjs pins
// TRAFFIC_ONE_ASK_USE_PLUGIN='0' so the consent fence is held open; without the
// baseline, a fixture that stopped fencing — or a consent fence that closed for
// an unrelated reason — would pass identically.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { firstEmitThisSession, resetUnpersistedEmitThrottle } from '../once';
import { markMaintenance, projectPhase } from '../state/lifecycle';
import { readState, scrubProjectStateLocalPrefs, statePath } from '../state/normalize';
import { writeRunSettlement } from '../run-settlement';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-writer-refusal-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  return cwd;
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

function withScopedPrefs(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-writer-refusal-prefs-'));
  fixtures.push(dir);
  const previous = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous;
  }
}

function seedBuildingProject(cwd: string, runId: string): string {
  fs.writeFileSync(statePath(cwd), JSON.stringify({
    mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none', currentRunId: runId,
  }), 'utf8');
  const claimFile = path.join(cwd, '.traffic-one', 'runs', runId, 'child1.json');
  fs.mkdirSync(path.dirname(claimFile), { recursive: true });
  fs.writeFileSync(claimFile, JSON.stringify({
    version: 1, runId, claimId: 'senior-frontend-1-a', role: 'senior-frontend',
    status: 'claimed', createdAt: new Date().toISOString(), sessionId: 'child1',
  }), 'utf8');
  return claimFile;
}

// ── markMaintenance ──────────────────────────────────────────────────────────
// The flip is the PRECONDITION for its two side effects, not their neighbour:
// sweeping the run's claims is only correct because the build is recorded as
// settled, and `ensureInitialCommit` makes a git commit on the strength of the
// same fact. With `writeState` void, a refused flip left both done, `return true`
// told build-complete the project had moved to maintenance, and build-complete
// pruned pending claims over a state file that still says "building".

test('a refused maintenance flip is reported false, and its side effects do not happen without it', () => {
  withScopedPrefs(() => {
    const open = project('flip-baseline');
    const openClaim = seedBuildingProject(open, 'run-open');
    assert.equal(projectPhase(readState(open), 'new-project'), 'building');

    assert.equal(markMaintenance(open, 'heuristic'), true,
      'writable baseline: an unfenced flip lands');
    assert.equal(JSON.parse(fs.readFileSync(openClaim, 'utf8')).status, 'released',
      'writable baseline: and its claim sweep runs');

    const fenced = project('flip-fenced');
    const fencedClaim = seedBuildingProject(fenced, 'run-fenced');
    // markMaintenance reads the state to decide the phase, so the link must
    // resolve for reads or it never reaches the write it is being tested on.
    fenceMoveAside(statePath(fenced));
    assert.equal(projectPhase(readState(fenced), 'new-project'), 'building',
      'fixture guard: the read still resolves, so the flip is attempted');

    assert.equal(markMaintenance(fenced, 'heuristic'), false,
      'a flip the fence refused must not be reported as a completed flip');
    assert.equal(JSON.parse(fs.readFileSync(fencedClaim, 'utf8')).status, 'claimed',
      'and the claim sweep must not run for a build that is not recorded as settled');
    const after = readState(fenced);
    assert.equal(after.lifecycle, undefined, 'fixture guard: the flip really did not land');
    assert.equal(projectPhase(after, after.mode as string), 'building');
  });
});

// ── scrubProjectStateLocalPrefs ──────────────────────────────────────────────
// `true` meant "the machine-local fields are out of the COMMITTED state file".
// A refused rewrite leaves them in it — and the caller's next honest move (say so,
// try again next session) is not the same as the one for "already clean".

test('a refused local-pref scrub is reported false, so the leak is not reported as cleaned', () => {
  withScopedPrefs(() => {
    const open = project('scrub-baseline');
    const leaked = {
      mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none',
      performance: { tier: 'fast' },
    };
    fs.writeFileSync(statePath(open), JSON.stringify(leaked), 'utf8');
    assert.equal(scrubProjectStateLocalPrefs(open), true, 'writable baseline: an unfenced scrub lands');
    assert.equal(JSON.parse(fs.readFileSync(statePath(open), 'utf8')).performance, undefined,
      'writable baseline: and the field really left the file');

    const fenced = project('scrub-fenced');
    fs.writeFileSync(statePath(fenced), JSON.stringify(leaked), 'utf8');
    // It reads the RAW file to find the leak, so this must be a move-aside.
    fenceMoveAside(statePath(fenced));
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(fenced), 'utf8')).performance, { tier: 'fast' },
      'fixture guard: the leak is still readable, so the scrub is attempted');

    assert.equal(scrubProjectStateLocalPrefs(fenced), false,
      'a scrub the fence refused must not be reported as a scrub');
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(fenced), 'utf8')).performance, { tier: 'fast' },
      'fixture guard: and the field is indeed still committed');
  });
});

// ── writeLegacyProjection (through writeRunSettlement) ───────────────────────
// Two writes, two paths, both refusals dropped: run.json and then maintenance.json
// carrying the SAME `canonicalStatus` and `settlementHash`. Refuse the first and
// land the second and the sidecar cites a settlement that the file every legacy
// reader consults (`effectiveLegacyRunStatus` reads run.json) has never heard of.

function seedRun(cwd: string, runId: string): { run: string; maintenance: string } {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const run = path.join(dir, 'run.json');
  const maintenance = path.join(dir, 'maintenance.json');
  fs.writeFileSync(run, JSON.stringify({ version: 2, runId, status: 'active', canonicalStatus: 'active' }), 'utf8');
  fs.writeFileSync(maintenance, JSON.stringify({ version: 1, runId }), 'utf8');
  return { run, maintenance };
}

test('a refused run.json projection does not stamp the maintenance sidecar with a status run.json lacks', () => {
  const cwd = project('projection');

  const open = seedRun(cwd, 'baseline');
  assert.ok(writeRunSettlement(cwd, 'baseline', { status: 'active', incompleteChecks: [] }),
    'writable baseline: an unfenced settlement publishes');
  const openRun = JSON.parse(fs.readFileSync(open.run, 'utf8'));
  const openSidecar = JSON.parse(fs.readFileSync(open.maintenance, 'utf8'));
  assert.equal(typeof openRun.settlementHash, 'string', 'writable baseline: run.json is projected');
  assert.equal(openSidecar.settlementHash, openRun.settlementHash,
    'writable baseline: and the sidecar agrees with it — the pair this test is about');

  const fenced = seedRun(cwd, 'fenced');
  // The projection reads run.json to derive the rollback guard and the previous
  // effective outcome, so a dangling link would stop it before either write.
  fenceMoveAside(fenced.run);
  assert.equal(JSON.parse(fs.readFileSync(fenced.run, 'utf8')).canonicalStatus, 'active',
    'fixture guard: the read still resolves, so the projection reaches its writes');

  assert.ok(writeRunSettlement(cwd, 'fenced', { status: 'active', incompleteChecks: [] }),
    'the canonical settlement itself is unfenced and still lands');
  assert.equal(JSON.parse(fs.readFileSync(fenced.run, 'utf8')).settlementHash, undefined,
    'fixture guard: run.json really was refused');
  assert.equal(JSON.parse(fs.readFileSync(fenced.maintenance, 'utf8')).settlementHash, undefined,
    'the sidecar must not carry a settlementHash the primary projection does not');
  assert.equal(JSON.parse(fs.readFileSync(fenced.maintenance, 'utf8')).canonicalStatus, undefined,
    'nor a canonicalStatus, which is the half a reader would act on');
});

// ── firstEmitThisSession ─────────────────────────────────────────────────────
// `return true` is CORRECT here and stays: a marker the fence refuses pre-consent
// must not silence the product. What was wrong is that the write's boolean decided
// only whether to sweep, so every LATER call also answered "first" — a
// once-per-session throttle degraded to every-call, silently. Several callers
// spend this boolean on choosing a full instruction over a short repeat (and pair
// them with distinct deny ids), so the repeat form became unreachable.

test('an unpersistable once-marker still emits once, rather than emitting forever', () => {
  const cwd = project('once');
  resetUnpersistedEmitThrottle();
  try {
    assert.equal(firstEmitThisSession(cwd, 'baseline-label', 'sess-1'), true,
      'writable baseline: the first emit is first');
    assert.equal(firstEmitThisSession(cwd, 'baseline-label', 'sess-1'), false,
      'writable baseline: the disk marker throttles the second');

    const marker = path.join(cwd, '.traffic-one', 'runs', '.once', 'fenced-label-sess-1');
    fenceDangling(marker);

    assert.equal(firstEmitThisSession(cwd, 'fenced-label', 'sess-1'), true,
      'a refused marker must not silence the first emit — that is the whole point of the true');
    assert.equal(fs.existsSync(marker), false,
      'fixture guard: the marker really could not be persisted');
    assert.equal(firstEmitThisSession(cwd, 'fenced-label', 'sess-1'), false,
      'but the SECOND call is not a first emit, and a once-per-session answer must not say it is');
  } finally {
    resetUnpersistedEmitThrottle();
  }
});
