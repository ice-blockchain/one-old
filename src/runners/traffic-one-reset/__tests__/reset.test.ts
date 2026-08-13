// The wedge, and the one command that gets a project out of it.
//
// THE WEDGE IS BUILT THROUGH THE REAL API, never by hand-writing run.json: the
// fixture drives planned -> active -> failed with `transitionRunStatus`, which
// is literally what `run-status --run-id <id> --status failed --outcome
// agent-failed` runs. A hand-written ledger would prove the runner can read a
// file this test wrote; driving it proves the runner recovers the state the
// product's own documented escape hatch produces.
//
// `failed` is terminal with NO outgoing edge (ledger.ts's
// runLedgerTransitionAllowed) and no writer in this product reopens it
// (run-settlement/types.ts, which states that as a rule the writers keep rather
// than a property of the file). What this test asserts is the narrower fact and
// the one that matters here — this runner leaves the bytes alone. The reset
// therefore
// RETIRES rather than settles, and the sharpest statement of that is in
// `terminal settlement stays immutable`: the failed run's run.json is compared
// BYTE FOR BYTE across the reset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { main, parseResetArgs, resetRun } from '../index';
import { readResetRecord } from '../resets';
import { bumpRunAgentActivity } from '../../../shared/state/run-agent/activity';
import { recordDenyRepeat } from '../../../shared/state/deny-repeat';
import { overrideProjectDir } from '../../../shared/override/paths';
import {
  ensureRunAgentClaimResult,
  ensureRunLedger,
  patchState,
  readState,
  runLedgerClaimAdmission,
  settleTerminalRunLedger,
  statePath,
  transitionRunStatus,
} from '../../../shared/state';
import { runAgentFile, runDir, runLedgerFile, runsRoot } from '../../../shared/state/run-agent/run-paths';
import { runSettlementPath } from '../../../shared/run-settlement';
import { beginFreshMaintenanceRun } from '../../../modules/session/triage-directive';
import type { Rec } from '../../../shared/obj';

const OLD = 'OLD-run';
const CHILD = 'child-of-old';
const fixtures: string[] = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOLDER = path.join(__dirname, 'registry-lease-holder.ts');

test.after(() => {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_HOST;
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

/**
 * A project wedged exactly the way the fix plan describes: a `failed` ledger
 * with `currentRunId` still pointing at it, holding real work.
 *
 * The architect digest is not decoration. Without an orchestrated artifact the
 * run is an `runIsEmptyFailedHusk` and the prompt-boundary router already
 * replaces it on its own — so a fixture without one would be recovered by
 * machinery that predates this runner, and would prove nothing about it. The
 * claim is here so the release half has something to release.
 */
function wedged(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-reset-${label}-`)));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_HOST = 'claude';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: true,
    confirmed: true,
    lifecycle: { phase: 'maintenance', source: 'heuristic', completedAt: new Date().toISOString() },
    team: { mode: 'subagents', approved: true },
    currentRunId: OLD,
    spawnIndex: { 'senior-frontend': 3 },
  }), 'utf8');

  const digests = path.join(dir, '.traffic-one', 'digests', OLD);
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, 'architect.md'), '# plan\nwork this run really did\n', 'utf8');

  const claim = runAgentFile(dir, OLD, CHILD);
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({
    version: 1,
    runId: OLD,
    claimId: 'senior-frontend-3-oldchild',
    role: 'senior-frontend',
    spawnIndex: 3,
    status: 'claimed',
    sessionId: CHILD,
    createdAt: new Date().toISOString(),
  }), 'utf8');

  // The documented escape hatch, run for real: this IS `run-status --status failed`.
  assert.ok(ensureRunLedger(dir, OLD, { status: 'planned', kind: 'agent-claim' }));
  assert.ok(transitionRunStatus(dir, OLD, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, OLD, { status: 'failed', outcome: 'agent-failed' }));
  return dir;
}

function onDiskRunId(dir: string): unknown {
  return (JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec).currentRunId;
}

function claimStatus(dir: string): unknown {
  return (JSON.parse(fs.readFileSync(runAgentFile(dir, OLD, CHILD), 'utf8')) as Rec).status;
}

function runDirs(dir: string): string[] {
  return fs.readdirSync(runsRoot(dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Fence a path whose CONTENT the writer reads before writing it. */
function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the reset reaches its write');
}

// ── the wedge is real ───────────────────────────────────────────────────────

test('the fixture really is wedged: nothing already in the product gets out of it', () => {
  const dir = wedged('is-wedged');

  assert.equal(runLedgerClaimAdmission(dir, OLD), 'closed',
    'no role can bind a claim in a failed run — this is what makes it unusable rather than merely finished');
  assert.equal(transitionRunStatus(dir, OLD, { status: 'active' }), null,
    'and `failed` has no outgoing edge…');
  assert.equal(
    transitionRunStatus(dir, OLD, { status: 'active', reason: 'user-authorized-extra-cycle' }),
    null,
    '…not even with the resume authorization, which unlocks `blocked` only',
  );

  const state = readState(dir);
  assert.equal(beginFreshMaintenanceRun(dir, state, 'claude'), true);
  assert.equal(onDiskRunId(dir), OLD,
    'the maintenance rotation reports no failure and still does not rotate: the run holds artifacts '
    + 'and has not settled, so the project stays pinned to a run it can do nothing in');

  const blocked = ensureRunAgentClaimResult(dir, readState(dir), 'senior-frontend', { session_id: 'fresh-child' });
  assert.equal(blocked.outcome, 'precondition-failed');
  assert.equal(blocked.reason, 'ledger-not-active', 'a new worker cannot start either');
});

// ── the acceptance test ─────────────────────────────────────────────────────

test('reset recovers the wedge, and a normal run starts immediately after', () => {
  const dir = wedged('recovers');

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, 'reset');
  assert.deepEqual(result.warnings, [], 'a clean project has no residue to report');

  const fresh = result.freshRunId as string;
  assert.match(fresh, /^\d{13}$/, 'the successor is an ordinary epoch-ms run id');
  assert.equal(onDiskRunId(dir), fresh, '.one.json names the successor, not the failed run');
  assert.deepEqual(readState(dir).spawnIndex, {},
    'and the per-run spawn index is cleared with the pointer — it counts spawns inside ONE run');
  assert.equal(runLedgerClaimAdmission(dir, fresh), 'admits', 'the successor admits claims');

  const ledger = JSON.parse(fs.readFileSync(runLedgerFile(dir, fresh), 'utf8')) as Rec;
  assert.equal(ledger.status, 'planned');
  assert.equal(ledger.kind, 'run-reset');
  assert.equal(ledger.supersedes, OLD, 'the successor records what it replaced — the retired run does not learn of it');

  assert.equal(claimStatus(dir), 'released', "the retired run's claim is released, not left counting as live");
  assert.ok((result.releasedClaims ?? 0) >= 1);

  // THE ACCEPTANCE CRITERION: the identical call that failed on the wedge works.
  const claim = ensureRunAgentClaimResult(dir, readState(dir), 'senior-frontend', { session_id: 'fresh-child' });
  assert.equal(claim.outcome, 'applied', 'a normal run can start in the recovered project');
  assert.equal(claim.value?.runId, fresh);
  assert.equal(runLedgerClaimAdmission(dir, fresh), 'admits');
});

test('reset destroys nothing: the retired run keeps its dir, its digests and its evidence', () => {
  const dir = wedged('destroys-nothing');
  const digest = path.join(dir, '.traffic-one', 'digests', OLD, 'architect.md');
  const before = fs.readFileSync(digest, 'utf8');

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true);

  assert.ok(fs.existsSync(runDir(dir, OLD)), 'the retired run dir survives');
  assert.equal(fs.readFileSync(digest, 'utf8'), before, 'and so does the work it holds');
  assert.deepEqual(runDirs(dir), [OLD, result.freshRunId as string].sort());
});

/**
 * Every file AND every directory under `dir`, path -> sha256 (or `<dir>`), so a
 * diff can NAME what moved.
 *
 * Directories are entries in their own right, and that is the whole point
 * rather than a detail: this helper hashed FILES only, so a side effect that
 * created a directory and put nothing in it was invisible to every "not one
 * byte moved" assertion built on it. That is exactly the shape of the defect
 * these differentials failed to catch — acquiring the project state lock
 * creates `.traffic-one/` unconditionally, so a refusal that ran after the
 * acquire left an empty state directory behind and the digests matched anyway.
 * A directory-blind differential cannot see the one class of side effect a
 * REFUSAL is most likely to have.
 */
function treeDigest(dir: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const rel = path.relative(dir, absolute);
      if (entry.isDirectory()) {
        digests.set(rel, '<dir>');
        walk(absolute);
      } else if (entry.isFile()) {
        digests.set(rel, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
      }
    }
  };
  // The root itself, so "the whole tree appeared" is a visible delta and not an
  // empty-vs-empty comparison.
  digests.set('.', fs.existsSync(dir) ? '<dir>' : '<absent>');
  if (fs.existsSync(dir)) walk(dir);
  return digests;
}

/**
 * Everything Traffic One owns in this project.
 *
 * Scoped to `.traffic-one/` rather than the whole fixture because the per-user
 * preference store is NOT project state — it only lands inside the fixture at
 * all because these tests pin TRAFFIC_ONE_PROJECT_PREFS_PATH there to keep the
 * suite out of the maintainer's real machine dir.
 */
function stateTree(dir: string): Map<string, string> {
  return treeDigest(path.join(dir, '.traffic-one'));
}

/**
 * Properties 3 and 4 of the RECOVERY_RUNNERS admission rule
 * (hooks/fail-closed.ts's `reset` row), as ONE differential rather than four
 * spot checks: a reset is purely ADDITIVE apart from two fields of `.one.json`.
 *
 * Stated that way it is the strongest form of both claims at once and it cannot
 * rot into a tautology — "it cannot fabricate progress" and "it destroys
 * nothing" are both consequences of the whole tree being append-only, and any
 * future write this runner learns to do shows up here by name whether or not
 * anyone thought to assert it. See hooks/__tests__/recovery-runners.test.ts for
 * the other two properties and the rule they serve.
 */
test('a reset is ADDITIVE except for the pointer: nothing destroyed, no verdict minted', () => {
  // THE CONTROL, and the test is uninterpretable without it. Every state write
  // normalizes the file it publishes — `writeState` fills schema defaults
  // (`version`, `technologies`, the surface flags) and `splitLocalPreferences`
  // routes host preferences like `team` out to the per-user store. Those
  // changes belong to the state funnel, not to this runner, so the question
  // worth asking is not "did `.one.json` change" but "did it change any
  // differently than a no-op write would". `patchState(control, {})` publishes
  // exactly the normalization and nothing else — over a CLONE rather than a
  // second `wedged()`, because two fixtures minted a millisecond apart differ
  // in their own timestamps and every such difference would read here as a
  // change the reset made.
  const dir = wedged('additive');
  const control = `${dir}-control`;
  fixtures.push(control);
  fs.cpSync(dir, control, { recursive: true });
  assert.equal(patchState(control, {}), true, 'fixture guard: the control publishes');
  const controlState = JSON.parse(fs.readFileSync(statePath(control), 'utf8')) as Rec;

  const before = stateTree(dir);
  const stateBefore = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec;

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true, result.message);
  const fresh = result.freshRunId as string;

  const after = stateTree(dir);
  const moved: string[] = [];
  for (const [file, digest] of before) {
    const now = after.get(file);
    if (now === undefined) moved.push(`DELETED ${file}`);
    else if (now !== digest) moved.push(`REWRITTEN ${file}`);
  }
  // The claim file is the one pre-existing file a reset is SUPPOSED to rewrite:
  // releasing a claim marks it released in place. Nothing else may be touched,
  // and nothing at all may be deleted.
  const stateTreeRoot = path.join(dir, '.traffic-one');
  assert.deepEqual(moved.sort(), [
    `REWRITTEN ${path.relative(stateTreeRoot, runAgentFile(dir, OLD, CHILD))}`,
    `REWRITTEN ${path.relative(stateTreeRoot, statePath(dir))}`,
  ].sort(), 'a reset may rewrite exactly two files that already existed — the pointer and the claim it releases');

  const stateAfter = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec;
  assert.deepEqual(Object.keys(stateAfter).sort(), Object.keys(controlState).sort(),
    'the reset adds and drops exactly the fields an ordinary no-op write does, and no others');
  for (const key of Object.keys(stateBefore)) {
    if (key === 'currentRunId' || key === 'spawnIndex') continue;
    if (!(key in stateAfter)) continue; // routed to the per-user store by the control too
    assert.deepEqual(stateAfter[key], controlState[key],
      `.one.json's '${key}' is not this command's business`);
  }

  // Everything NEW belongs to the successor, with ONE named exception. A reset
  // that wrote anywhere else is doing something its row does not license.
  //
  // The exception is `runs/.resets.json`, the project-level record of how often
  // this command has been used. It is deliberately outside every run, because a
  // record kept under the run being retired is a record the NEXT reset walks
  // away from — which is the same defect, one level up. It is named here rather
  // than folded into a looser predicate so that a THIRD write location still
  // fails this test.
  const successorDir = path.relative(stateTreeRoot, runDir(dir, fresh));
  const recordFile = path.relative(stateTreeRoot, path.join(runsRoot(dir), '.resets.json'));
  const added = [...after.keys()].filter((file) => !before.has(file)).sort();
  assert.ok(added.length > 0, 'fixture guard: the successor ledger really was written');
  assert.ok(added.includes(recordFile), 'the reset is recorded at the project level, so repeated use is legible');
  for (const file of added) {
    // The successor's own directory entry, its contents, and the record. A
    // stray directory ANYWHERE else still fails, which is the property the
    // file-only differential could not express at all.
    if (file === recordFile || file === successorDir) continue;
    assert.ok(file.startsWith(`${successorDir}${path.sep}`),
      `a reset may only create files under the successor run: ${file}`);
  }

  // No terminal outcome: `planned` is where a run starts anyway, and the field
  // that would record a verdict is absent, not merely benign.
  const successor = JSON.parse(fs.readFileSync(runLedgerFile(dir, fresh), 'utf8')) as Rec;
  assert.equal(successor.status, 'planned');
  assert.equal('outcome' in successor, false, 'the successor carries no outcome — there is no progress to claim');

  // No override minted. This is the capability the doctor grammar deliberately
  // refuses to expose (`doctor --unblock` is on no allowlist), so a mutating
  // recovery row that could reach it would be the bypass the rule forbids.
  assert.equal(fs.existsSync(overrideProjectDir(dir)), false,
    'a reset mints no override: it moves a pointer, it does not buy a gate decision');
});

// ── HARD CONSTRAINT 1: terminal immutability is untouched ───────────────────

test('terminal settlement stays immutable for every other caller after a reset', () => {
  const dir = wedged('immutable');
  const before = fs.readFileSync(runLedgerFile(dir, OLD), 'utf8');

  assert.equal(resetRun(dir, OLD).ok, true);

  assert.equal(fs.readFileSync(runLedgerFile(dir, OLD), 'utf8'), before,
    'the failed run.json is BYTE-IDENTICAL: retiring a run writes nothing to its ledger, '
    + 'so there is no hole in the immutability invariant for anyone else to reach through');

  assert.equal(transitionRunStatus(dir, OLD, { status: 'active' }), null,
    'the failed run is still unreopenable…');
  assert.equal(
    transitionRunStatus(dir, OLD, { status: 'active', reason: 'user-authorized-extra-cycle' }),
    null,
    '…including with the resume authorization…',
  );
  assert.equal(settleTerminalRunLedger(dir, OLD, 'verified'), null,
    '…and it still cannot be settled green');
  assert.equal(runLedgerClaimAdmission(dir, OLD), 'closed');
});

// ── HARD CONSTRAINT 4: a half-completed reset must not exist ────────────────

test('a reset whose pointer write is refused leaves the project exactly as it was', () => {
  const open = wedged('partial-baseline');
  assert.equal(resetRun(open, OLD).ok, true,
    'writable baseline: an unfenced reset lands — without this a fixture that stopped fencing would pass identically');
  assert.equal(claimStatus(open), 'released', 'writable baseline: and dismantles the outgoing run');

  const dir = wedged('partial-fenced');
  fenceMoveAside(statePath(dir));

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'state-write-refused');
  assert.equal(result.freshRunId, undefined, 'no successor is named for a reset that did not happen');

  assert.equal(onDiskRunId(dir), OLD, 'fixture guard: the pointer write really was refused');
  assert.equal(claimStatus(dir), 'claimed',
    'so the retired run was NOT dismantled: the run .one.json still names has to keep working. '
    + 'This is why the pointer is written FIRST — the only fatal step is the one that has touched nothing yet');
  assert.deepEqual(runDirs(dir), [OLD],
    'and no ledger was opened under an id nothing on disk carries');
});

/**
 * The write-then-verify re-read, pinned. It was the only check in this command
 * with no test, and a mutant that deleted it changed no outcome anywhere.
 *
 * IT IS NOT AN EQUIVALENCE, and the reason is what the two answers MEAN:
 * `patchState` reports the write FENCE's verdict, not the file's. Everything
 * after the pointer move — the claim release, the successor ledger, the carry —
 * is safe only because `.one.json` already names a different run, so a `true`
 * over a pointer that did not land aims the whole dismantling half at a run that
 * is still current. That is the shape of the lost update this lane has already
 * produced once.
 *
 * REACHED THE WAY IT HAPPENS: the fence approves, the durable write stages its
 * bytes, and the publishing rename does not land them — the one-shot swallow
 * below drops exactly that rename, for exactly this file, and leaves everything
 * else alone. No product code is stubbed, `patchState` runs whole and answers
 * `true` on its own, and the only thing the test manufactures is the disagreement
 * between the fence's answer and the file's contents that the check exists to
 * notice. The baseline is the same fixture with the swallow absent.
 */
test('a pointer write the fence approved but the FILE never took stops the reset before it dismantles', () => {
  const open = wedged('unverified-baseline');
  assert.equal(resetRun(open, OLD).ok, true,
    'baseline: this fixture resets cleanly, so the injection below is the only difference');
  assert.equal(claimStatus(open), 'released', 'baseline: and the dismantling half really does run');

  const dir = wedged('unverified-lost-update');
  const mutableFs = createRequire(__filename)('fs') as { renameSync: typeof fs.renameSync };
  const realRename = mutableFs.renameSync;
  let swallowed = 0;
  mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === statePath(dir) && swallowed === 0) {
      swallowed += 1;
      realRename(from, `${String(to)}.swallowed`);
      return;
    }
    realRename(from, to);
  }) as typeof fs.renameSync;

  const result = ((): ReturnType<typeof resetRun> => {
    try {
      return resetRun(dir, OLD);
    } finally {
      mutableFs.renameSync = realRename;
    }
  })();

  assert.equal(swallowed, 1, 'fixture guard: the publishing rename really was the one swallowed');
  const staged = (JSON.parse(fs.readFileSync(`${statePath(dir)}.swallowed`, 'utf8')) as Rec).currentRunId;
  assert.ok(typeof staged === 'string' && staged !== '' && staged !== OLD,
    `fixture guard: the write itself was well-formed and named a successor (${String(staged)}) — `
    + 'what failed is publication, which is the only thing a fence cannot see');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'state-write-unverified');
  assert.equal(onDiskRunId(dir), OLD, 'the pointer did not move, which is the whole premise');
  assert.equal(claimStatus(dir), 'claimed',
    'and NOTHING was dismantled: the release would have been aimed at the run .one.json still names');
  assert.deepEqual(runDirs(dir), [OLD], 'no successor ledger was opened under an id nothing points at');
  assert.equal(readResetRecord(dir).count, 0, 'and a reset that did not happen is not counted');
});

// ── HARD CONSTRAINT 5: nothing after the pointer move may THROW ─────────────
// The steps after the pointer write are all documented "best-effort, the caller
// is told" and none of them had an error boundary. What that cost is not the
// step: the pointer has already moved and the retired claims are already
// released, so an exception here leaves a recovered project whose recovery was
// never RECORDED — and the reset record is what the widening ladder reads, so
// every reset reaching a throwing path skipped the bound that prices repeated
// recovery. The operator saw a stack trace, and no warning named the rows that
// never ran.

test('a carry that throws is reported, and the reset is still counted', () => {
  const dir = wedged('carry-throws');
  bumpRunAgentActivity(dir, OLD, 'senior-frontend', 'child-A');

  // The measured cause, injected where it actually happens: a recursive
  // directory create under the successor's run path failing ENOTDIR, which is
  // what a non-directory sitting at that path produces. Injected rather than
  // planted because the successor id is minted inside the transaction — and,
  // since the id selection now refuses an occupied path, a planted file no
  // longer reaches this code at all. The row is the ACTIVITY tally, so the rows
  // after it are the ones the old shape skipped.
  // Patched on the module's own exports object (the ESM namespace is frozen),
  // which is the object every product module resolves `mkdirSync` through.
  const mutableFs = createRequire(__filename)('fs') as { mkdirSync: typeof fs.mkdirSync };
  const realMkdir = mutableFs.mkdirSync;
  let injected = 0;
  mutableFs.mkdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (String(target).includes('agent-activity')) {
      injected += 1;
      const error = new Error('ENOTDIR: not a directory, mkdir') as NodeJS.ErrnoException;
      error.code = 'ENOTDIR';
      throw error;
    }
    return (realMkdir as (p: fs.PathLike, o?: unknown) => string | undefined)(target, options);
  }) as typeof fs.mkdirSync;

  let result;
  try {
    result = resetRun(dir, OLD);
  } finally {
    mutableFs.mkdirSync = realMkdir;
  }

  assert.ok(injected > 0, 'fixture guard: the failing write was actually reached');
  assert.equal(result.ok, true, 'a failed carry is non-fatal by design; a throw out of here is the CLI crashing');
  assert.ok(result.warnings.some((line) => line.includes('agent-activity')),
    `the row that did not carry must be named: ${JSON.stringify(result.warnings)}`);
  assert.equal(readResetRecord(dir).count, 1,
    'and the reset is on the record the widening ladder reads — a bound that a failing carry could skip '
    + 'would be a bound anything able to fail a carry could skip');
  assert.equal(onDiskRunId(dir), result.freshRunId, 'the recovery itself completed');
});

test('a project state lock this process cannot take is a refusal, not a stack trace', () => {
  // TWO OPERATOR INVOCATIONS RACING, driven with a second real process, because
  // the contention path is the one that throws: the acquire loop ends at its
  // one-second deadline with `new Error(...)`, and nothing between it and the CLI
  // caught. The loser's own code has had a refusal ready all along.
  const dir = wedged('lock-contended');
  const holder = spawn(process.execPath, [
    '--import', './src/build/test-preload.mjs', '--import', 'tsx', HOLDER, dir, '2500', 'project',
  ], { cwd: REPO_ROOT, stdio: 'ignore' });
  try {
    const inside = path.join(dir, 'holder-inside');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 2_000 && !fs.existsSync(inside); i += 1) Atomics.wait(wait, 0, 0, 10);
    assert.ok(fs.existsSync(inside), 'fixture guard: the second process never took the lock');

    const result = resetRun(dir, OLD);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'state-lock-unavailable');
    assert.match(result.message, /retry in a moment/);
    assert.equal(onDiskRunId(dir), OLD, 'and nothing was written: the refusal is reached before the pointer');
  } finally {
    holder.kill();
  }
});

// ── the successor id ────────────────────────────────────────────────────────

test('the successor id never lands on a run directory that already exists', () => {
  // A CLOCK SET BACKWARDS, which this codebase handles explicitly elsewhere and
  // this guard did not: `runIdNow()` is epoch-ms, so a rolled-back clock re-mints
  // an id whose run directory is already there. The old guard compared against
  // the retired id only, so the project was repointed at a pre-existing —
  // possibly failed — run, and the only complaint was a warning: re-wedged by its
  // own recovery.
  const dir = wedged('successor-taken');
  const realNow = Date.now;
  const FROZEN = 1_700_000_000_000;
  const collided = String(FROZEN);
  // A pre-existing run at exactly the id the clock will mint, and a FAILED one,
  // so being repointed at it is the wedge rather than merely wrong.
  assert.ok(ensureRunLedger(dir, collided, { status: 'planned', kind: 'agent-claim' }));
  assert.ok(transitionRunStatus(dir, collided, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, collided, { status: 'failed', outcome: 'agent-failed' }));
  const before = fs.readFileSync(runLedgerFile(dir, collided), 'utf8');

  Date.now = () => FROZEN;
  let first;
  let second;
  try {
    first = resetRun(dir, OLD);
    // Both candidate spellings taken now: the frozen clock re-mints the same
    // occupied id, and the suffixed one is the run being retired.
    assert.ok(transitionRunStatus(dir, first.freshRunId as string, { status: 'active' }));
    assert.ok(transitionRunStatus(dir, first.freshRunId as string, { status: 'failed', outcome: 'agent-failed' }));
    second = resetRun(dir, first.freshRunId as string);
  } finally {
    Date.now = realNow;
  }

  assert.equal(first.ok, true);
  assert.equal(first.freshRunId, `${collided}-r`, 'the occupied id is stepped over, not adopted');
  assert.equal(fs.readFileSync(runLedgerFile(dir, collided), 'utf8'), before,
    'and the run that was already there is untouched');

  assert.equal(second.ok, false, 'with both spellings taken the reset refuses rather than repointing');
  assert.equal(second.code, 'successor-id-taken');
  assert.equal(onDiskRunId(dir), `${collided}-r`,
    'and a refused mint leaves the project exactly as it was, like every other pre-write refusal');
});

// ── refusals: the runner is self-guarding, which is what licenses the exemption ──

test('reset refuses a run that is not the current one', () => {
  const dir = wedged('refusals-other');

  const other = resetRun(dir, 'some-other-run');
  assert.equal(other.ok, false);
  assert.equal(other.code, 'not-current-run',
    'a mistyped id must never be read as "reset the current run instead"');
  assert.equal(onDiskRunId(dir), OLD);
});

/**
 * A project pinned to a run in some NON-failed ledger state.
 *
 * These are the states that make reset a gate bypass if it accepts them: an
 * `active` run is one an agent is being governed inside, and a `blocked` one
 * has an outgoing edge that costs the user's explicit authorization
 * (`--status active --reason user-authorized-extra-cycle`). Resetting out of
 * either is abandoning a live obligation, not recovering from a wedge.
 */
function pinnedTo(label: string, status: 'active' | 'blocked'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-reset-${label}-`)));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true, currentRunId: 'LIVE',
  }), 'utf8');
  assert.ok(ensureRunLedger(dir, 'LIVE', { status: 'planned', kind: 'agent-claim' }));
  assert.ok(transitionRunStatus(dir, 'LIVE', { status: 'active' }));
  if (status === 'blocked') {
    assert.ok(transitionRunStatus(dir, 'LIVE', { status: 'blocked', outcome: 'environment-blocked' }));
  }
  return dir;
}

test('reset refuses any run that is not terminally failed', () => {
  for (const status of ['active', 'blocked'] as const) {
    const dir = pinnedTo(`not-failed-${status}`, status);
    const result = resetRun(dir, 'LIVE');
    assert.equal(result.ok, false, `a '${status}' run must not be resettable`);
    assert.equal(result.code, 'run-not-failed');
    assert.equal((JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec).currentRunId, 'LIVE',
      'and the pointer does not move');
  }
});

/**
 * THE HALF-CARRIED WINDOW, and the two refusals that are its safety.
 *
 * Round 7 moved the successor ledger and the claim release out of the project
 * state lock, so between the pointer write and the last settled row there is a
 * period — up to 12.5s of carry budget plus three 2s lease budgets — in which
 * `.one.json` names the successor and the successor holds none of what the
 * retired run held. The hold used to exclude a second reset from that period.
 * Nothing excludes it now except these two refusals, and settleReset's docblock
 * cites them as the window's safety rather than as incidental id checks. That
 * citation is what this pins: it was a code read.
 *
 * REACHED, not hand-built. `.traffic-one/runs` at mode 0500 makes every write
 * under it fail while leaving every read working, so the pointer publishes and
 * verifies and then the ledger and the whole carry fail — the widest instance of
 * the window, deterministically, through the shipped command. It is the same
 * arrival state a carry that exhausts its lease budget under contention leaves
 * behind; the chmod only removes the timing. Skipped for a root runner, which
 * ignores the mode bits.
 */
test('a second reset arriving in the half-carried window can see it but cannot act on it', { skip: process.getuid?.() === 0 }, () => {
  const dir = wedged('window-refusals');
  for (let i = 0; i < 5; i += 1) recordDenyRepeat(dir, OLD, 'sig-ladder');
  const runs = runsRoot(dir);

  fs.chmodSync(runs, 0o500);
  let first;
  try {
    first = resetRun(dir, OLD);
  } finally {
    // Restored before the assertions so a failure cannot leave an unremovable
    // fixture behind, and so the refusals below are read on the window's state
    // rather than on the permissions that produced it.
    fs.chmodSync(runs, 0o700);
  }
  const fresh = first.freshRunId as string;

  assert.equal(first.ok, true, 'the pointer moved: the window is entered, not avoided');
  assert.equal(onDiskRunId(dir), fresh);
  assert.equal(fs.existsSync(runLedgerFile(dir, fresh)), false, 'and the successor has no ledger of its own yet');
  // Read the way a gate reads it: the next draw's own number.
  assert.equal(recordDenyRepeat(dir, fresh, 'sig-ladder'), 1,
    'the window is MORE PERMISSIVE than the state that settles — the next draw is the 1st where it would be the 6th');
  assert.equal(recordDenyRepeat(dir, OLD, 'sig-ladder'), 6,
    'and never a contradictory one: the retired ladder still reads exactly what it recorded, so no count that '
    + 'never existed is seen anywhere');

  const retired = resetRun(dir, OLD);
  assert.equal(retired.ok, false, 'the retired id is no longer current, so a second reset naming it refuses');
  assert.equal(retired.code, 'not-current-run');

  const successor = resetRun(dir, fresh);
  assert.equal(successor.ok, false, 'and the successor is not a failed run, so naming it refuses too');
  assert.equal(successor.code, 'ledger-absent',
    'named exactly: in the WIDEST window the successor has no ledger at all, so the refusal is `ledger-absent` '
    + 'rather than the `run-not-failed` a planned ledger draws. Both refuse; the code depends on how far '
    + 'settlement got, and the docblocks say so');
  // And it must not ACCUSE. This window is the ordinary arrival state of a
  // reset that got as far as the pointer, so nothing here is damaged: the
  // successor's ledger is milliseconds from existing and its settlement was
  // never written. Telling this operator that both records need checking sends
  // them to repair two files that are exactly as they should be.
  assert.doesNotMatch(successor.message as string, /TWO records/,
    'an undamaged window is not a wedge: the two-records remedy belongs to a damaged settlement, not to '
    + 'every refusal this branch can produce');

  assert.equal(onDiskRunId(dir), fresh,
    'so the window cannot be chained: neither refusal moves the pointer, and there is no third id to name');

  // The NARROWER window, which is the common one: the ledger landed and the
  // carry did not finish. A successor ledger opens `planned`, which is the shape
  // `run-not-failed` names.
  const clean = wedged('window-refusals-planned');
  const settled = resetRun(clean, OLD);
  assert.equal(settled.ok, true);
  const heir = settled.freshRunId as string;
  assert.equal(resetRun(clean, OLD).code, 'not-current-run', 'the retired id, again, on the settled arrival');
  const heirRefusal = resetRun(clean, heir);
  assert.equal(heirRefusal.ok, false);
  assert.equal(heirRefusal.code, 'run-not-failed',
    'a planned successor is not wedged, so the second refusal is the one settleReset cites');
  assert.equal(onDiskRunId(clean), heir, 'and the pointer stays put through both');
});

test('reset refuses a run whose ledger it cannot read, rather than replacing it blind', () => {
  const dir = wedged('illegible');
  fs.writeFileSync(runLedgerFile(dir, OLD), '{ not json', 'utf8');

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ledger-corrupt');
  assert.equal(onDiskRunId(dir), OLD, 'and nothing moved');
});

/**
 * WHICH RECORD DECIDES the two-records remedy — both directions, because the
 * paragraph is a claim about the OTHER record and a claim that is always made
 * is not a claim.
 *
 * The refusal above fires on the ledger; the sentence it can carry is about
 * `settlement-v2.json`. Keying it on the refusal's own cause meant every
 * illegible ledger was told its settlement might be damaged, including the
 * undamaged half-carried window above. Keyed on the settlement, it says nothing
 * when there is nothing to say and still covers the case it exists for: the
 * escape that repairs one record and leaves the other, which leaves no trace of
 * itself because the reset SUCCEEDS and only a later settlement write refuses.
 *
 * Same trigger as doctor/findings.ts and run-diagnostic-report.ts
 * (`runSettlementIllegible`), so the three cannot drift into disagreeing about
 * when a run is wedged in both halves.
 */
test('the two-records remedy is printed when the SETTLEMENT is damaged, and not otherwise', () => {
  const intact = wedged('remedy-settlement-ok');
  fs.writeFileSync(runLedgerFile(intact, OLD), '{ not json', 'utf8');
  const quiet = resetRun(intact, OLD);
  assert.equal(quiet.code, 'ledger-corrupt');
  assert.doesNotMatch(quiet.message as string, /TWO records/,
    'a torn ledger over an ABSENT settlement is one broken record, not two — repairing the ledger is the '
    + 'whole remedy, and naming a second file sends the operator looking for damage that is not there');

  const damaged = wedged('remedy-settlement-corrupt');
  fs.writeFileSync(runLedgerFile(damaged, OLD), '{ not json', 'utf8');
  fs.writeFileSync(runSettlementPath(damaged, OLD), '{ torn', 'utf8');
  const named = resetRun(damaged, OLD);
  assert.equal(named.code, 'ledger-corrupt', 'the refusal is unchanged — only what it discloses moves');
  assert.match(named.message as string, /TWO records/,
    'both records really are damaged here, so the refusal that sends the operator to run.json must also '
    + 'name settlement-v2.json — repairing only the first makes this command SUCCEED and every later '
    + 'settlement write refuse, which is the failure that leaves no trace of itself');
  assert.equal(onDiskRunId(damaged), OLD, 'and neither arm moved the pointer');
});

/**
 * An ILLEGIBLE `.one.json`, which a project arriving at this command is
 * disproportionately likely to have — the file every gate trusts is the same
 * file a wedged project's operator has most likely been editing by hand.
 *
 * Two distinct kinds, because fsjson.ts's JsonRead separates them and the
 * separation is load-bearing here: `corrupt` means bytes are there and we
 * cannot parse them (so they may still hold the pointer), `unreadable` means
 * something is there we cannot even open. `readState` answers both — and
 * `absent` — with the same `{}`, which is exactly how this runner used to
 * report a damaged state file as `no-current-run`: "there is no wedged run to
 * reset", said to someone holding a wedged project, pointing away from the one
 * file that needs repair.
 */
test('an illegible .one.json is named as itself, and nothing is written over it', () => {
  const cases: ReadonlyArray<readonly [string, string, (dir: string) => void]> = [
    // Torn bytes that still visibly contain the pointer — the case where
    // "there is no currentRunId" is not merely unhelpful but false.
    ['torn', 'state-corrupt', (dir) => fs.writeFileSync(statePath(dir), `{ "currentRunId": "${OLD}", "spawnI`, 'utf8')],
    // An empty file: the signature of an O_TRUNC open that never got its write.
    ['empty', 'state-corrupt', (dir) => fs.writeFileSync(statePath(dir), '', 'utf8')],
    // Something IS there and cannot be opened. A directory rather than a chmod,
    // so the case is reproduced identically for a root test runner.
    ['eisdir', 'state-unreadable', (dir) => { fs.rmSync(statePath(dir)); fs.mkdirSync(statePath(dir)); }],
  ];

  for (const [label, code, damage] of cases) {
    const dir = wedged(`illegible-state-${label}`);
    damage(dir);
    const before = treeDigest(dir);

    const result = resetRun(dir, OLD);
    assert.equal(result.ok, false, `${label}: an illegible state file is not something to reset through`);
    assert.equal(result.code, code, `${label}: the refusal names the state file, not a missing run`);
    assert.match(result.message, /STATE FILE/, `${label}: and says so where the operator will read it`);
    assert.equal(result.freshRunId, undefined, `${label}: no successor`);

    assert.deepEqual([...treeDigest(dir).entries()].sort(), [...before.entries()].sort(),
      `${label}: not one byte moved — a recovery command must never be the thing that finishes off a damaged file`);
    assert.equal(fs.existsSync(`${statePath(dir)}.corrupt`), false,
      `${label}: and it does not quarantine-and-replace either; that is writeState's move for a caller `
      + 'replacing the whole object, and a pointer repoint is not one');
  }
});

// ── the validations that run BEFORE the lock ────────────────────────────────
// Acquiring the project state lock creates `.traffic-one/` as its first act, so
// anything validated INSIDE the hold is validated too late to avoid littering.
// The existing "creates nothing" test only exercised the nested case, where the
// resolver finds a real project — so it never covered the directory the
// resolver cannot place, which is the one that gets littered. These do.

test('a non-project directory is refused without creating anything in it', () => {
  // The case that put a `.traffic-one/` in the plugin's own source repository.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-reset-notproject-')));
  fs.writeFileSync(path.join(dir, 'README.md'), '# not a Traffic One project\n', 'utf8');
  const before = treeDigest(dir);

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-a-project');
  assert.match(result.message, /not a Traffic One project/);

  assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false,
    'no state directory: the refusal happens before the lock, which is the whole point');
  assert.deepEqual([...treeDigest(dir).entries()].sort(), [...before.entries()].sort(),
    'not one byte AND not one directory moved — this differential now sees both');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a blank or missing run id is refused as an argument, not as a missing run', () => {
  const dir = wedged('blank-arg');
  for (const [label, argument] of [['empty', ''], ['whitespace', '   '], ['undefined', undefined]] as const) {
    const result = resetRun(dir, argument as unknown as string);
    assert.equal(result.ok, false, `${label}: refused`);
    assert.equal(result.code, 'invalid-run-id',
      `${label}: the entry point documents a contract about its argument, so it asserts one`);
    assert.match(result.message, /a run id is required/, `${label}: and says what was wrong with it`);
  }
});

test('a LEGACY NUMERIC pointer names its run, and the wedge is recoverable', () => {
  // The shape that made the wedge permanently unrecoverable. `currentRunId` is
  // supported as a number in three places deliberately — one of them called
  // unconditionally by the state writer, precisely BECAUSE that shape reaches
  // disk — but this command spelled its test as `typeof === 'string'`. So a
  // project whose pointer is the legacy number and names a genuinely failed run
  // was told "this project has no currentRunId": false, and with no route out,
  // because every writer that would canonicalise the pointer is one the wedge
  // blocks. Reading through the product's own coercion is the fix; re-deriving
  // the test here would just add a fourth spelling to disagree with.
  const numeric = 1700000000000;
  const dir = wedged('numeric-pointer');
  const state = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec;
  state.currentRunId = numeric;
  fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');
  // A legibly failed ledger under the CANONICAL (string) spelling of that id.
  fs.mkdirSync(runDir(dir, String(numeric)), { recursive: true });
  fs.writeFileSync(runLedgerFile(dir, String(numeric)),
    JSON.stringify({ runId: String(numeric), status: 'failed', outcome: 'agent-failed' }), 'utf8');

  const result = resetRun(dir, String(numeric));
  assert.equal(result.ok, true,
    'a numeric pointer to a failed run is recoverable; it used to report no currentRunId at all');
  assert.equal(result.code, 'reset');
  assert.ok(result.freshRunId, 'and a successor is minted');

  // And the wrong id is still refused, so the coercion widened the ACCEPTED
  // population without widening what the command will act on.
  const other = wedged('numeric-pointer-mismatch');
  const s2 = JSON.parse(fs.readFileSync(statePath(other), 'utf8')) as Rec;
  s2.currentRunId = numeric;
  fs.writeFileSync(statePath(other), JSON.stringify(s2), 'utf8');
  assert.equal(resetRun(other, 'SOME-OTHER-RUN').code, 'not-current-run');
});

test('a state file that is valid JSON but not an OBJECT names itself, not a missing run', () => {
  // The same misleading refusal on a narrower shape of the same population.
  // `readJsonResult` says `ok` for an array, a number or a bare string, and
  // `readState` hands back `{}` for all three — so the project landed on
  // "there is no wedged run to reset" while its pointer sat in element 0. An
  // array holding the pointer is exactly what a hand edit produces, and
  // hand-edited state is this command's stated target population.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['array', JSON.stringify([{ currentRunId: OLD }]), 'a JSON array'],
    ['number', '42', 'a JSON number'],
    ['string', '"OLD-run"', 'a JSON string'],
    ['boolean', 'true', 'a JSON boolean'],
  ];

  for (const [label, bytes, shape] of cases) {
    const dir = wedged(`not-object-${label}`);
    fs.writeFileSync(statePath(dir), bytes, 'utf8');
    const before = treeDigest(dir);

    const result = resetRun(dir, OLD);
    assert.equal(result.ok, false, `${label}: refused`);
    assert.equal(result.code, 'state-not-object',
      `${label}: named as a broken state file, not as a missing run`);
    assert.match(result.message, new RegExp(shape), `${label}: and the shape is named`);
    assert.match(result.message, /STATE FILE/, `${label}: where the operator will read it`);

    assert.deepEqual([...treeDigest(dir).entries()].sort(), [...before.entries()].sort(),
      `${label}: not one byte moved`);
    assert.equal(fs.existsSync(`${statePath(dir)}.corrupt`), false, `${label}: and nothing quarantined`);
  }
});

test('patchState itself refuses an illegible base rather than merging into {}', () => {
  // The guarantee the refusal above rests on, pinned at its source: even if the
  // legibility probe were removed, the write could not silently drop the fields
  // it failed to parse. Read-modify-write against a `{}` that really meant
  // "unparseable" is how a merely torn file becomes genuinely lost.
  const dir = wedged('patchstate-corrupt');
  const torn = `{ "currentRunId": "${OLD}", "team": { "mode": "sub`;
  fs.writeFileSync(statePath(dir), torn, 'utf8');

  assert.equal(patchState(dir, { currentRunId: 'SOMETHING-NEW' }), false);
  assert.equal(fs.readFileSync(statePath(dir), 'utf8'), torn,
    'the torn bytes survive intact, so whatever can be salvaged from them still can be');
});

test('reset refuses a project that has no current run at all', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-reset-none-')));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify({
    mode: 'new-project', stack: 'default', onboardingComplete: true, confirmed: true,
  }), 'utf8');

  const result = resetRun(dir, 'anything');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-current-run');
});

// ── the runner's own argv parser ────────────────────────────────────────────

function captured(fn: () => number): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: fn(), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test('the CLI reports the recovery on stdout and every refusal on stderr, with distinct exit codes', () => {
  const dir = wedged('cli');

  const bad = captured(() => main(['--status', 'failed'], dir));
  assert.equal(bad.code, 2, 'an unparseable argv is exit 2 — the usage error, not a refusal');
  assert.match(bad.err, /Usage: traffic-one-reset\.cjs --run-id <id>/);

  const help = captured(() => main(['--help'], dir));
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: traffic-one-reset\.cjs/);

  const wrong = captured(() => main(['--run-id', 'not-the-current-one'], dir));
  assert.equal(wrong.code, 1, 'a refusal is exit 1');
  assert.match(wrong.err, /is not this project's current run/);
  assert.equal(wrong.out, '', 'and says nothing on stdout, which is where success is reported');

  const done = captured(() => main(['--run-id', OLD, '--json'], dir));
  assert.equal(done.code, 0);
  const parsed = JSON.parse(done.out) as Rec;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.runId, OLD);
  assert.equal(onDiskRunId(dir), parsed.freshRunId);
});

/**
 * The module boundary, exercised end to end.
 *
 * `resetRun` lives in reset.ts and takes an ALREADY-RESOLVED root, because a
 * module holding a `withProjectStateLock` body may not be able to reach a
 * project-root resolver at all (shared/__tests__/path-spelling-contract.test.ts
 * proves that by import closure). Resolution therefore happens once, in this
 * entry, before the call — which means the entry is now the only place that
 * turns "where the operator's shell happens to be" into "the project". Every
 * other test in this file hands `resetRun` a root directly and would not notice
 * if that resolution stopped happening.
 */
test('the CLI entry resolves the project root, so the command works from a subdirectory', () => {
  const dir = wedged('nested-cwd');
  const nested = path.join(dir, 'src', 'components');
  fs.mkdirSync(nested, { recursive: true });

  const done = captured(() => main(['--run-id', OLD, '--json'], nested));
  assert.equal(done.code, 0, done.err);

  const parsed = JSON.parse(done.out) as Rec;
  assert.equal(parsed.ok, true, 'the run is recovered from a cwd that is not the project root');
  assert.equal(onDiskRunId(dir), parsed.freshRunId,
    "and the pointer moved in the PROJECT's .one.json, not in some state file minted under the subdirectory");
  assert.equal(fs.existsSync(path.join(nested, '.traffic-one')), false,
    'no stray state directory was created at the cwd the operator happened to be standing in');
});

test('parseResetArgs is a superset of the gate grammar and refuses everything else', () => {
  assert.deepEqual(parseResetArgs(['--run-id', '1785169657252']), { runId: '1785169657252', json: false });
  assert.deepEqual(parseResetArgs(['--run-id', 'OLD-run', '--json']), { runId: 'OLD-run', json: true });
  assert.deepEqual(parseResetArgs(['--json', '--run-id', 'OLD-run']), { runId: 'OLD-run', json: true });

  for (const argv of [
    [],
    ['--run-id'],
    ['--run-id', ''],
    ['--run-id', '../escape'],
    ['--run-id', 'a b'],
    ['--run-id', '--json'],
    ['--run-id', '1', '--run-id', '2'],
    ['--json', '--json', '--run-id', '1'],
    ['--run-id=1'],
    ['--status', 'failed'],
    ['1785169657252'],
  ]) {
    assert.equal(parseResetArgs(argv), null, `parser must refuse: ${JSON.stringify(argv)}`);
  }
});
