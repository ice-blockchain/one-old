// The maintenance rotation over a write the fence REFUSED.
//
// beginFreshMaintenanceRun used to settle the outgoing run's ledger and release
// its agent claims BEFORE the write that installs the fresh id, then mutate
// `state` to that id whatever the write answered. Its return type was `void`, so
// there was no success to falsify and the static refusal contract could not see
// it: the whole harm arrives through the in-memory mutation that outlives the
// call and through the two irreversible acts taken before the write.
//
// What a refusal cost, and why it is worse than a lost field: `.one.json` went on
// naming a run whose claims had just been released and whose ledger had just been
// settled terminal, while this process — and the routing directive it emits, and
// the `opencode_delegate` runId inside it — named an id nothing on disk carried.
// Every consumer that does not route through ensureCurrentRunId reads
// `currentRunId` straight off `.one.json`, so the hook and the gates disagreed
// about which run the request belongs to, and a ledger plus a CREATE-ONCE model
// policy were opened under the id that was never recorded.
//
// FENCING: `.one.json` is a MOVE-ASIDE (rename the real file, symlink the
// original name to it), never a dangling link — writeState READS the file it is
// about to replace, under the lock, for preserveCurrentRunId. A dangling link
// makes that read fail, the rotation bails on its own precondition, and the case
// passes having proved nothing; the writable baseline cannot catch that, because
// the baseline is a different directory. Each case asserts its writable baseline
// FIRST: src/build/test-preload.mjs holds the consent fence open, so without the
// baseline a fixture that stopped fencing would pass identically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { beginFreshMaintenanceRun, maintenanceTriageDirective } from '../triage-directive';
import { ensureRunAgentClaimResult, readState, statePath, writeState } from '../../../shared/state';
import { ensureRunLedger, transitionRunStatus } from '../../../shared/state/run-agent/ledger';
import { runAgentFile, runDir, runsRoot } from '../../../shared/state/run-agent/run-paths';
import { writeJson } from '../../../shared/fsjson';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import type { Rec } from '../../../shared/obj';

const PROMPT = 'change the hero headline to Welcome';
const CHILD = 'child-old-run';
const fixtures: string[] = [];

test.after(() => {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_HOST;
  delete process.env.TRAFFIC_ONE_USER_PLAN;
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

/**
 * A maintenance-phase project on run "OLD" with one CLAIMED agent in it.
 *
 * The claim is stamped a minute BEFORE the lifecycle watermark on purpose: a
 * claim newer than `lifecycle.completedAt` reads as an in-flight orchestration
 * and suppresses triage outright (hasActiveRunClaims), so the rotation this file
 * is about would never be reached. Older, it still releases — which is the act
 * whose ordering is under test.
 */
function project(label: string): { dir: string; state: Rec } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-rotate-${label}-`)));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_HOST = 'claude';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const completedAt = new Date().toISOString();
  const state: Rec = {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: true,
    confirmed: true,
    lifecycle: { phase: 'maintenance', source: 'heuristic', completedAt },
    team: { mode: 'subagents', approved: true },
    currentRunId: 'OLD',
    spawnIndex: { 'senior-frontend': 3 },
  };
  fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');
  const claim = runAgentFile(dir, 'OLD', CHILD);
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({
    version: 1,
    runId: 'OLD',
    claimId: 'senior-frontend-3-oldchild',
    role: 'senior-frontend',
    spawnIndex: 3,
    status: 'claimed',
    sessionId: CHILD,
    createdAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
  }), 'utf8');
  return { dir, state };
}

/** Fence a path whose CONTENT the writer reads before writing it. */
function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the rotation reaches its write');
}

/** Undo the fence, leaving the same bytes at the same path. */
function unfence(target: string): void {
  fs.unlinkSync(target);
  fs.renameSync(`${target}.aside`, target);
}

function onDiskRunId(dir: string): unknown {
  return (JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Rec).currentRunId;
}

function claimStatus(dir: string): unknown {
  return (JSON.parse(fs.readFileSync(runAgentFile(dir, 'OLD', CHILD), 'utf8') ) as Rec).status;
}

function runDirs(dir: string): string[] {
  return fs.readdirSync(runsRoot(dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('a rotation the fence refused leaves the outgoing run intact instead of dismantling it', () => {
  const open = project('baseline');
  assert.equal(beginFreshMaintenanceRun(open.dir, open.state, 'claude'), true,
    'writable baseline: an unfenced rotation reports that it landed');
  const minted = String(open.state.currentRunId);
  assert.match(minted, /^\d{13}$/, 'writable baseline: and a fresh id was minted');
  assert.equal(onDiskRunId(open.dir), minted,
    'writable baseline: .one.json carries the id the caller now runs under');
  assert.equal(claimStatus(open.dir), 'released',
    'writable baseline: which is what licenses releasing the outgoing run — the pair this test is about');

  const fenced = project('fenced');
  fenceMoveAside(statePath(fenced.dir));

  assert.equal(beginFreshMaintenanceRun(fenced.dir, fenced.state, 'claude'), false,
    'a rotation whose state write was refused must say so, because no later disk read will find the id');
  assert.equal(onDiskRunId(fenced.dir), 'OLD', 'fixture guard: the rotation write really was refused');
  assert.equal(claimStatus(fenced.dir), 'claimed',
    'so the outgoing claims must NOT be released: the run .one.json still names has to keep working');
  assert.equal(fenced.state.currentRunId, 'OLD',
    'and the in-memory id must not advance past a rotation that is not on disk — this object is what the rest of the hook routes on');
  assert.deepEqual(fenced.state.spawnIndex, { 'senior-frontend': 3 },
    'nor may the spawn-index floor be reset in memory only, while disk keeps the old map');
  assert.deepEqual(runDirs(fenced.dir), ['OLD'],
    'and no ledger or create-once model policy was opened under an id nothing on disk carries');
});

test('a refused rotation is refused to the agent, and the full rubric is still owed', () => {
  const open = project('directive-baseline');
  const routed = maintenanceTriageDirective(open.dir, open.state, PROMPT, { session_id: 'parent' }, 'claude');
  assert.match(routed, /MAINTENANCE PHASE/, 'writable baseline: an unfenced prompt gets the routing rubric');
  assert.equal(onDiskRunId(open.dir), open.state.currentRunId,
    'writable baseline: and the run the rubric routes into is the one on disk');

  const fenced = project('directive-fenced');
  fenceMoveAside(statePath(fenced.dir));

  const refused = maintenanceTriageDirective(fenced.dir, fenced.state, PROMPT, { session_id: 'parent' }, 'claude');
  assert.match(refused, /^TRAFFIC_ONE_RUN_ROTATION_REFUSED\n/,
    'the agent is told the run was never recorded, instead of being routed into it');
  assert.match(refused, /\.traffic-one\/\.one\.json/, 'and the message names the refused path');
  assert.match(refused, /still on run "OLD"/,
    'naming the run that IS on disk — the id this process minted is the one nobody can resolve');
  assert.doesNotMatch(refused, /\d{13}/,
    'the unpersisted id must appear nowhere: naming it for `opencode_delegate` is the contradiction');

  // The refusal returns BEFORE the once-per-session marker is burned, so an agent
  // that only ever received it still gets the FULL rubric — never the one-line
  // reminder pointing back at prose it has never seen.
  unfence(statePath(fenced.dir));
  const later = maintenanceTriageDirective(fenced.dir, fenced.state, PROMPT, { session_id: 'parent' }, 'claude');
  assert.match(later, /MAINTENANCE PHASE — post-build triage/, 'the rubric is still owed once the state file is writable');
  assert.doesNotMatch(later, /triage reminder/);
});

// ── the ERRNO arm of the same split ─────────────────────────────────────────
// The harm this file's fix prevents is a role claim on disk under a run id
// `.one.json` does not carry. On the SYMLINK arm that is unreachable through the
// claim mint: its own final `writeState` is guarded and answers
// `unavailable('run-state-write-refused')`, which gate-enforcement denies on.
//
// The errno arm does NOT work that way, and the difference is worth pinning
// because it is easy to inherit the wrong premise: fsjson.ts's `act` returns
// `false` for exactly two causes — the consent/path guard, and ELOOP — and
// RETHROWS every other errno. So an EACCES on `.one.json` never becomes a
// boolean at all, and the claim mint aborts by exception with its claim row
// already written.
//
// That split IS constructible, and it is reported — through the exception, which
// core/pipeline.ts turns into the non-overridable `pipeline-handler-crashed`
// fail-closed deny for any PreToolUse (pinned, with an errno-bearing error, by
// src/core/__tests__/pipeline.test.ts's "a throwing PreToolUse handler is denied
// fail-closed"). So no child is ever spawned to bind to the orphan row, and the
// row is `pending`, which listPendingClaims prunes on SUBAGENT_STALE_MS.
//
// INJECTION: chmod `.traffic-one` to r-x. writeJson is temp-file + rename, so
// creating `.one.json.<pid>.tmp` needs write permission on that directory, while
// the claim path is one level deeper and permissions are per-directory — so the
// claim still lands. Both halves are asserted, and the writable control below is
// what shows the split is the errno's doing rather than the divergent state's.
function errnoProject(): { dir: string; diskRun: string; memoryRun: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-errno-split-')));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","version":"0.0.0"}', 'utf8');
  recordPluginUseChoice(dir, true, 'errno-split-test');
  const diskRun = '1700000000000';
  const memoryRun = '1700000000999';
  // Asserted, not discarded: a fixture that hands back a project whose seed the
  // fence refused measures something other than what it names — and this helper
  // returns that project, which is the exact shape the refusal contract reports.
  assert.ok(writeState(dir, {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'none',
    onboardingComplete: true, confirmed: true, currentRunId: diskRun,
    team: { mode: 'subagents', approved: true },
  }), 'fixture: the errno-split project must actually be seeded before anything is fenced');
  ensureRunLedger(dir, diskRun, { status: 'planned', kind: 'maintenance-triage' });
  transitionRunStatus(dir, diskRun, { status: 'active', reason: 'errno-split-test' });
  // Pre-create the claim subtree for both ids: only `.traffic-one` itself may
  // become unwritable, or the claim write fails too and the split is untestable.
  for (const runId of [diskRun, memoryRun]) {
    for (const rel of ['pending', 'agents', 'locks']) {
      fs.mkdirSync(path.join(runDir(dir, runId), rel), { recursive: true });
    }
  }
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', '.locks'), { recursive: true });
  return { dir, diskRun, memoryRun };
}

function pendingRoles(dir: string, runId: string): string[] {
  const p = path.join(runDir(dir, runId), 'pending');
  try { return fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
}

test('an errno on .one.json reports by THROWING, not by the boolean — with the claim already written', () => {
  // Control first, and it is the writable baseline: the same divergent state with
  // nothing fenced mints normally AND moves `.one.json` onto the id, so the split
  // below is the errno's doing and not the divergence's.
  const control = errnoProject();
  const controlMint = ensureRunAgentClaimResult(
    control.dir,
    { ...readState(control.dir), currentRunId: control.memoryRun },
    'senior-frontend', { prompt: 'x' }, { toolName: 'Task' },
  );
  assert.equal(controlMint.outcome, 'applied', 'writable control: the mint applies');
  assert.equal(readState(control.dir).currentRunId, control.memoryRun,
    'writable control: and .one.json is moved onto the id the claim was parented under — no split');

  const { dir, diskRun, memoryRun } = errnoProject();
  const stateDir = path.join(dir, '.traffic-one');
  const mode = fs.statSync(stateDir).mode & 0o777;
  fs.chmodSync(stateDir, 0o555);
  try {
    // Fixture guard, and the premise correction it pins: an errno is NOT a
    // `false`. If this environment cannot produce EACCES (a root uid ignores the
    // mode bits), this throws the assertion instead of letting the case pass
    // vacuously on a write that quietly succeeded.
    assert.throws(
      () => writeJson(statePath(dir), { probe: true }),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES',
      'fixture guard: the injection really does make .one.json writes take EACCES, and fsjson rethrows it rather than answering false',
    );
    assert.equal(readState(dir).currentRunId, diskRun, 'fixture guard: reads still resolve, so the mint reaches its write');
    assert.deepEqual(pendingRoles(dir, memoryRun), [], 'fixture guard: no claim under the divergent id yet');

    // The mint aborts by EXCEPTION, not by `unavailable('run-state-write-refused')`.
    assert.throws(
      () => ensureRunAgentClaimResult(
        dir,
        { ...readState(dir), currentRunId: memoryRun },
        'senior-frontend', { prompt: 'x' }, { toolName: 'Task' },
      ),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES',
      'the errno arm has no boolean to consult: the claim mint throws, which is the channel core/pipeline.ts turns into pipeline-handler-crashed',
    );

    // The split itself, both halves — this is the state the throw is reporting.
    assert.deepEqual(pendingRoles(dir, memoryRun), ['senior-frontend.json'],
      'the claim row DID land under the divergent id: the split is reachable on the errno arm');
    assert.equal(readState(dir).currentRunId, diskRun,
      'while .one.json still names the previous run — so the row is parented under an id nothing on disk carries');
    // And the reason it is not the harm: the throw blocks the spawn, so no child
    // exists to bind to that row, and `pending` is the status the stale sweep prunes.
    const row = JSON.parse(fs.readFileSync(path.join(runDir(dir, memoryRun), 'pending', 'senior-frontend.json'), 'utf8')) as Rec;
    assert.equal(row.status, 'pending', 'the orphan row is pending, which listPendingClaims prunes on SUBAGENT_STALE_MS');
  } finally {
    fs.chmodSync(stateDir, mode);
  }
});
