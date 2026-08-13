// A MutationResult (or a run id) MINTED over a write the fence refused — the
// run-agent half of that defect class.
//
// This is not the truthiness defect (a MutationResult read in a boolean position)
// and it is not the refusal-blind publisher (a boolean dropped by its caller). It
// is the mutation FABRICATING its own success: `applied` returned over a
// `writeState` that answered `false`, and an id handed back that `.one.json` does
// not carry. Every consumer downstream then behaves correctly on a lie, which is
// why these three sat above the rest of their cohort.
//
// FENCING, and why exactly one path: each case plants a link at ONE named file so
// everything around it stays writable and a refusal can only be about that path
// (classifyStateWrite in fsjson.ts refuses a LINK target, dangling or not). Every
// `.one.json` case is a MOVE-ASIDE — `writeState` reads the file it is about to
// replace (`readJson(filePath, {})` under the lock, for preserveCurrentRunId), and
// so do all three functions here, so a dangling link makes the READ fail, the
// function bails on its own precondition, and the case passes having proved
// nothing. The writable baseline does not catch that, because the baseline is a
// different directory.
//
// Every case asserts a WRITABLE BASELINE first: src/build/test-preload.mjs holds
// the consent fence open, and without the baseline a fixture that stopped fencing
// would pass identically.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { statePath } from '../normalize';
import { ensureCurrentRunId, pendingDir, runAgentFile, runsRoot } from '../run-agent/run-paths';
import { ensureRunLedger } from '../run-agent/ledger';
import { ensureRunAgentClaimResult } from '../run-agent/claims-store';
import { reconcileRunIdentityDrift } from '../run-agent/identity-drift';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-minted-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  return cwd;
}

/** Fence a path whose CONTENT the writer reads before writing it. */
function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the writer reaches its write');
}

function seedState(cwd: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(statePath(cwd), JSON.stringify({
    mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none', ...extra,
  }), 'utf8');
}

function readRaw(cwd: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as Record<string, unknown>;
}

// ── run-paths.ts#ensureCurrentRunId ─────────────────────────────────────────
// The id it returns is a PROMISE that the next disk read finds it: every consumer
// that does not call back through here reads `currentRunId` straight off
// `.one.json`. A refused persist broke that promise silently — and the damage is
// not the lost field, it is the SIBLING RUN minted the moment the run leaves
// recentAdoptableRunId's window, which is the incident the function's own :49-55
// comment exists to prevent.

test('a run id the fence refused to persist is not handed back as if it were on disk', () => {
  const open = project('mint-baseline');
  seedState(open);
  const baseline = ensureCurrentRunId(open, { mode: 'new-project' });
  assert.match(baseline, /^\d{13}$/, 'writable baseline: an unfenced mint returns an id');
  assert.equal(readRaw(open).currentRunId, baseline,
    'writable baseline: and .one.json carries the id it returned — the promise this test is about');

  const fenced = project('mint-fenced');
  seedState(fenced);
  fenceMoveAside(statePath(fenced));

  assert.equal(ensureCurrentRunId(fenced, { mode: 'new-project' }), '',
    'a mint the fence refused must not be answered with the id, because no later disk read will find it');
  assert.equal(readRaw(fenced).currentRunId, undefined,
    'fixture guard: the persist really was refused');
  assert.equal(fs.existsSync(runsRoot(fenced)), false,
    'and no ledger was opened for a run id nothing on disk carries');
});

test('a blanked currentRunId that cannot be re-persisted is not reported as adopted', () => {
  // The re-persist IS the adoption. Without it `.one.json` still reads blank, so
  // the adoption has to be re-derived by every later call and stops working the
  // moment the run ages out of the window — at which point the next call mints a
  // sibling beside the live team. Fail closed instead.
  const seedAdoptable = (cwd: string): string => {
    const runId = String(Date.now() - 1_000);
    assert.ok(ensureRunLedger(cwd, runId, { status: 'planned', kind: 'spawn-gate' }),
      'fixture guard: the adoptable spawn-gate ledger is on disk');
    return runId;
  };

  const open = project('adopt-baseline');
  seedState(open);
  const openRun = seedAdoptable(open);
  assert.equal(ensureCurrentRunId(open, { mode: 'new-project' }), openRun,
    'writable baseline: an unfenced call adopts the blanked id rather than minting a sibling');
  assert.equal(readRaw(open).currentRunId, openRun,
    'writable baseline: and re-persists it, which is what makes the adoption stick');

  const fenced = project('adopt-fenced');
  seedState(fenced);
  const fencedRun = seedAdoptable(fenced);
  fenceMoveAside(statePath(fenced));

  assert.equal(ensureCurrentRunId(fenced, { mode: 'new-project' }), '',
    'an adoption whose re-persist was refused is not an adoption and must not answer with the id');
  assert.equal(readRaw(fenced).currentRunId, undefined, 'fixture guard: the re-persist really was refused');
  assert.deepEqual(fs.readdirSync(runsRoot(fenced)), [fencedRun],
    'and no sibling run was minted beside the one it declined to adopt');
});

// ── run-paths.ts#ensureCurrentRunId, the ERRNO route ────────────────────────
// A SIBLING of the two rows above and deliberately not the same claim. There the
// fence DECLINED, `writeState` answered `false`, and the function already had a
// branch for it. Here nothing declines: the filesystem RAISES, and it raises out
// of the recovery the `catch` runs — so the throw escapes the `catch` itself and
// the caller's hook ends as an uncaught exception rather than as a gate's deny.
//
// The recovery is `mint()`, which publishes through `writeState`, which takes the
// project state lock — the very lock whose failure put us in that `catch`. So the
// "keep the previous unserialized behavior" the arm promises has never existed:
// both routes below re-raise identically, one line later.
//
// Driven through the real gates before the guard: on PreToolUse core/pipeline.ts
// answered `pipeline-handler-crashed` ("Traffic One agent-model gate failed
// (EACCES)"), a deny no gate chose; on SessionStart — which
// session/session-start.ts reaches on every subagent-enabled project — the throw
// left the pipeline altogether, because only the PreToolUse arm converts one.

/**
 * Run `fn` with `target` unwritable, restoring its mode whatever happens.
 *
 * The `finally` is not tidiness: a 0o555 directory left behind survives this
 * file's own teardown (`rmSync` cannot unlink entries inside it) and fails a
 * LATER, unrelated test in a shape that looks like the defect under measurement.
 */
function withUnwritable(target: string, fn: () => void): void {
  const mode = fs.statSync(target).mode & 0o777;
  fs.chmodSync(target, 0o555);
  try {
    fn();
  } finally {
    fs.chmodSync(target, mode);
  }
}

test('a state dir this process may not write fails closed rather than throwing out of the hook', () => {
  const open = project('eacces-baseline');
  seedState(open);
  assert.match(ensureCurrentRunId(open, { mode: 'new-project' }), /^\d{13}$/,
    'writable baseline: the identical fixture mints, so the row below is about the MODE and nothing else');

  const locked = project('eacces-locked');
  seedState(locked);
  const before = fs.readFileSync(statePath(locked), 'utf8');
  withUnwritable(path.join(locked, '.traffic-one'), () => {
    assert.equal(ensureCurrentRunId(locked, { mode: 'new-project' }), '',
      'EACCES is the documented fail-closed exit, not an exception: the lock stages a directory INSIDE '
      + 'the state dir, so acquisition raises — and so does the mint the catch runs to recover from it');
  });
  assert.equal(fs.readFileSync(statePath(locked), 'utf8'), before,
    'and nothing was written: the containment is about the ERROR, never about when a mint happens');
  assert.equal(fs.existsSync(runsRoot(locked)), false,
    'no ledger was opened for an id no disk read would ever find');
});

test('a project state lock held by a live owner fails closed rather than throwing out of the hook', () => {
  // The contention edge the `catch` names in its own first sentence, and the one
  // it never handled: the recovery re-enters the same lock, spends a second full
  // deadline against the same holder, and raises the same timeout.
  const plantLiveLock = (cwd: string): string => {
    const lockPath = `${statePath(cwd)}.report-id.lock`;
    fs.mkdirSync(lockPath);
    // OUR pid, so neither reaper may take it: `processAlive` guards both arms
    // unconditionally, which makes the contention deterministic instead of a
    // race against a stale-window clock.
    const token = 'contendedlock';
    fs.writeFileSync(
      path.join(lockPath, `owner-${token}.json`),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      'utf8',
    );
    return lockPath;
  };

  const open = project('contended-baseline');
  seedState(open);
  assert.match(ensureCurrentRunId(open, { mode: 'new-project' }), /^\d{13}$/,
    'writable baseline: the same fixture with no holder mints, so the row below is about the LOCK');

  const contended = project('contended');
  seedState(contended);
  const lockPath = plantLiveLock(contended);
  assert.equal(ensureCurrentRunId(contended, { mode: 'new-project' }), '',
    'a lock held by a live owner reaches the same fail-closed exit — callers gate on the empty string');
  assert.equal(readRaw(contended).currentRunId, undefined,
    'fixture guard: nothing was persisted past a lock this call never held');
  assert.ok(fs.existsSync(lockPath),
    'fixture guard: the live holder kept its lock, so this really was contention and not a reclaim');
});

// ── claims-store.ts#ensureRunAgentClaimResult ───────────────────────────────
// The sharpest of the fifteen: the claim row lands under `runId` and then the
// write that records WHICH RUN the project is in is refused — and the mutation
// returns `applied` anyway. `unavailable` is the outcome gate-enforcement.ts's
// claimMintDeny already retries and then DENIES a spawn on; `precondition-failed`
// lets the spawn proceed, which is exactly the child that binds no role.

test('a claim whose run-state write was refused is reported unavailable, not applied', () => {
  const role = 'senior-frontend';
  const raw = { session_id: 'parent-1' };

  const open = project('claim-baseline');
  const openRun = String(Date.now() - 2_000);
  seedState(open, { currentRunId: openRun });
  const openResult = ensureRunAgentClaimResult(open, { mode: 'new-project', currentRunId: openRun }, role, raw);
  assert.equal(openResult.outcome, 'applied', 'writable baseline: an unfenced claim mint is applied');
  assert.deepEqual(readRaw(open).spawnIndex, { [role]: 1 },
    'writable baseline: and .one.json agrees with the claim row about the spawn index');

  const fenced = project('claim-fenced');
  const fencedRun = String(Date.now() - 2_000);
  seedState(fenced, { currentRunId: fencedRun });
  fenceMoveAside(statePath(fenced));

  const result = ensureRunAgentClaimResult(fenced, { mode: 'new-project', currentRunId: fencedRun }, role, raw);
  assert.equal(result.outcome, 'unavailable',
    'a MutationResult must not be minted `applied` over a write the fence refused');
  assert.equal(result.reason, 'run-state-write-refused',
    'and the reason names the write, so the deny message can say which one');

  // The split state the old `applied` was hiding, pinned as a fact: the claim row
  // IS on disk. That is what makes this worse than a lost field — the two halves
  // disagree and the result used to certify both.
  assert.ok(fs.existsSync(path.join(pendingDir(fenced, fencedRun), `${role}.json`)),
    'fixture guard: the claim row landed, so this really is the half-applied case');
  assert.equal(readRaw(fenced).spawnIndex, undefined,
    'while .one.json carries no spawn index for it');
});

// ── identity-drift.ts#reconcileRunIdentityDrift ─────────────────────────────
// The re-point is the PRECONDITION for the loop that follows it, not its
// neighbour: releasing the losers' claims and failing their ledgers is only
// correct because `currentRunId` now names the survivor. A refused re-point left
// the losers settled while `.one.json` still pointed at one of them, so the next
// hook read a run whose claims this pass had just released — strictly worse than
// not repairing at all.

test('a refused currentRunId re-point does not release and fail the runs it was repairing', () => {
  const seedDrift = (cwd: string): { survivor: string; loser: string } => {
    const now = Date.now();
    const survivor = String(now - 1_000);
    const loser = String(now - 2_000);
    for (const runId of [survivor, loser]) {
      assert.ok(ensureRunLedger(cwd, runId, { status: 'active', kind: 'agent-claim' }),
        'fixture guard: both ledgers are on disk and non-terminal');
      // A CLAIMED (activated) agent in each run is what makes them both "live",
      // which is the drift shape this repair exists for.
      const claimed = runAgentFile(cwd, runId, `child-${runId}`);
      fs.mkdirSync(path.dirname(claimed), { recursive: true });
      fs.writeFileSync(claimed, JSON.stringify({
        version: 1, runId, claimId: `senior-frontend-1-${runId}`, role: 'senior-frontend',
        spawnIndex: 1, status: 'claimed', createdAt: new Date().toISOString(), sessionId: `child-${runId}`,
      }), 'utf8');
    }
    // `survivor` wins on evidence, so the repair must re-point away from `loser`.
    fs.writeFileSync(path.join(runsRoot(cwd), survivor, 'architecture-v1.json'), '{}', 'utf8');
    return { survivor, loser };
  };
  const loserClaimStatus = (cwd: string, loser: string): string => {
    const file = runAgentFile(cwd, loser, `child-${loser}`);
    return String((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).status);
  };

  const open = project('drift-baseline');
  const openRuns = seedDrift(open);
  seedState(open, { currentRunId: openRuns.loser });
  const openState: Record<string, unknown> = { mode: 'new-project', currentRunId: openRuns.loser };
  assert.equal(reconcileRunIdentityDrift(open, openState), true,
    'writable baseline: an unfenced repair reports a change');
  assert.equal(readRaw(open).currentRunId, openRuns.survivor,
    'writable baseline: and .one.json now names the survivor');
  assert.equal(loserClaimStatus(open, openRuns.loser), 'released',
    'writable baseline: which is what licenses releasing the loser — the pair this test is about');

  const fenced = project('drift-fenced');
  const fencedRuns = seedDrift(fenced);
  seedState(fenced, { currentRunId: fencedRuns.loser });
  fenceMoveAside(statePath(fenced));
  const fencedState: Record<string, unknown> = { mode: 'new-project', currentRunId: fencedRuns.loser };

  reconcileRunIdentityDrift(fenced, fencedState);
  assert.equal(readRaw(fenced).currentRunId, fencedRuns.loser,
    'fixture guard: the re-point really was refused, so .one.json still names the loser');
  assert.equal(loserClaimStatus(fenced, fencedRuns.loser), 'claimed',
    'so the loser must NOT be released: the run .one.json still points at has to keep working');
  assert.equal(fencedState.currentRunId, fencedRuns.loser,
    'and the in-memory state must not be advanced past a re-point that is not on disk');
});
