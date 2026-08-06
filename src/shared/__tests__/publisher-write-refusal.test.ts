// What a PUBLISHER does when shared/fsjson.ts refuses its write.
//
// THE DEFECT these characterize: `writeJson` returns `false` for a refusal the
// product makes on purpose — an unanswered consent question, a planted symlink,
// a path escaping the state dir — and each publisher below dropped it, then went
// on to describe the artifact as though it had landed. That is worse than an
// untidy return value, because Traffic One's own gates re-read these files: the
// producer certifies while the consumer denies the run for the same artifact
// being missing, and neither message mentions the other.
//
// ── HOW EACH FIXTURE FENCES ONE PATH ────────────────────────────────────────
// Every case fences EXACTLY ONE named file with a symlink at it, so everything
// around it stays writable and a refusal can only be about that path. Two
// variants, and picking the wrong one passes vacuously:
//
//   - DANGLING link, for a publisher that only writes. Nothing to preserve.
//   - MOVE-ASIDE link (rename the real file, link to it), for a publisher that
//     READS the path before writing it. A dangling link would make that read
//     return null, the publisher would bail on its own precondition, and the
//     test would pass without the write ever being attempted. Each of those
//     cases therefore asserts the read still resolves before it asserts
//     anything about the write.
//
// And every case asserts a WRITABLE BASELINE first: src/build/test-preload.mjs
// pins TRAFFIC_ONE_ASK_USE_PLUGIN='0' so the consent fence is held open, but
// without the baseline a fixture that silently stopped fencing — or one whose
// consent fence closed for an unrelated reason — would pass identically and
// prove nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  architectureInputPath,
  compileArchitectureForRun,
  compiledArchitecturePath,
  persistCompiledArchitecture,
  publishRuntimeAssignments,
  readRuntimeAssignments,
  runtimeAssignmentsPath,
} from '../architecture-contract';
import { compileVerificationContract } from '../verification-contract';
import { ensureRunHostCapability, runHostCapabilityPath } from '../host/capabilities';
import {
  activateRunV2RollbackBarrier,
  readRunSettlement,
  writeRunSettlement,
} from '../run-settlement';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `t1-write-refusal-${label}-`));
  fixtures.push(cwd);
  return cwd;
}

function runDir(cwd: string, runId: string): string {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fence a path that is only ever written. */
function fenceDangling(target: string): void {
  fs.symlinkSync(path.join(path.dirname(target), 'no-such-target'), target);
  assert.equal(fs.existsSync(target), false, 'fixture guard: the link is dangling');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
}

/**
 * Fence a path whose CONTENT the publisher reads before writing. Returns the
 * bytes the caller should still be able to read through the link.
 */
function fenceMoveAside(target: string): string {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the publisher reaches its write');
  return before;
}

// ── writeRunSettlement ───────────────────────────────────────────────────────
// The `| null` return already existed; it carried only the `catch`. So a refused
// settlement came back as a non-null, hash-bearing record, and — the part that
// makes it more than a wrong return value — `writeLegacyProjection` ran on the
// next line regardless, stamping run.json with the `settlementHash` and
// `canonicalStatus` of a settlement-v2.json that does not exist. The
// compatibility projection described a canonical record no reader can find.

test('a refused settlement write is reported as null and projects nothing into run.json', () => {
  const cwd = project('settlement');
  runDir(cwd, 'baseline');
  const baseline = writeRunSettlement(cwd, 'baseline', {
    status: 'active',
    incompleteChecks: ['verification-not-started'],
  });
  assert.ok(baseline, 'writable baseline: an unfenced settlement publishes');
  assert.equal(readRunSettlement(cwd, 'baseline')?.status, 'active');

  const fenced = runDir(cwd, 'fenced');
  fenceDangling(path.join(fenced, 'settlement-v2.json'));

  assert.equal(writeRunSettlement(cwd, 'fenced', {
    status: 'active',
    incompleteChecks: ['verification-not-started'],
  }), null, 'the refusal reaches the caller through the return channel it already had');
  assert.equal(readRunSettlement(cwd, 'fenced'), null, 'nothing canonical landed');
  assert.equal(fs.existsSync(path.join(fenced, 'run.json')), false,
    'the legacy projection must not describe a settlement that does not exist');
});

// ── activateRunV2RollbackBarrier ─────────────────────────────────────────────
// Its whole job is to be the atomic write that PRECEDES the first V2-only
// sidecar, so that a crash between the two leaves an older runtime reading a
// run it refuses to reopen. Reporting an activation that never landed hands
// plan-readiness the opposite: verification-v2.json published behind a run.json
// that still looks resumable — the exact window this separate write closes.

test('a refused rollback-barrier activation is reported as null', () => {
  const cwd = project('barrier');
  const baseline = runDir(cwd, 'baseline');
  fs.writeFileSync(path.join(baseline, 'run.json'), JSON.stringify({
    version: 1, runId: 'baseline', status: 'active', kind: 'orchestration',
  }));
  assert.ok(activateRunV2RollbackBarrier(cwd, 'baseline'),
    'writable baseline: an unfenced barrier activates');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(baseline, 'run.json'), 'utf8')).qaContractVersion,
    2,
  );

  const fenced = runDir(cwd, 'fenced');
  const ledger = path.join(fenced, 'run.json');
  fs.writeFileSync(ledger, JSON.stringify({
    version: 1, runId: 'fenced', status: 'active', kind: 'orchestration',
  }));
  // Move-aside, not dangling: the barrier reads the ledger to refuse terminal
  // runs. Through a dangling link that read returns {}, which is still
  // non-terminal, so this particular publisher would reach its write either
  // way — but the fixture must not depend on that.
  const before = fenceMoveAside(ledger);

  assert.equal(activateRunV2RollbackBarrier(cwd, 'fenced'), null,
    'the refusal reaches the caller, which already denies on null');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before,
    'the ledger is byte-identical: no barrier was activated');
});

// ── persistCompiledArchitecture ──────────────────────────────────────────────
// Both callers dropped the refusal and carried on describing a sidecar that was
// never written. It was caught downstream only incidentally, and for the wrong
// file: publishRuntimeAssignments re-reads architecture-v1.json, so the run was
// denied for "runtime assignments could not be persisted" while assignments.json
// was fine. A throw, for the reason compileVerificationContract already gives —
// the value both callers hand back is non-nullable, and both production paths
// run inside a gate's try/catch that turns this into that gate's own deny.

const ARCHITECTURE_STATE = {
  version: 1,
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  currentRunId: 'R',
  lifecycle: { phase: 'maintenance' },
};

/** A project with a valid ArchitectureInputV1 for run `R`, ready to compile. */
function architectureProject(label: string): string {
  const cwd = project(label);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(ARCHITECTURE_STATE));
  const input = architectureInputPath(cwd, 'R');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, JSON.stringify({
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [
      { id: 'app-shell', name: 'App', kind: 'app-shell' },
      { id: 'home', name: 'Home', kind: 'page' },
    ],
  }));
  return cwd;
}

test('a refused compiled-architecture write throws instead of returning a phantom contract', () => {
  const cwd = architectureProject('architecture');
  const state = ARCHITECTURE_STATE;

  // `persist: false` is the production shape (the completion gate validates the
  // whole candidate set before anything touches disk), and it is what lets this
  // test hold a compiled contract while the destination is still unfenced.
  const compiled = compileArchitectureForRun(cwd, 'R', state, { persist: false });
  const sidecar = compiledArchitecturePath(cwd, 'R');
  assert.equal(fs.existsSync(sidecar), false, 'persist:false wrote nothing');

  persistCompiledArchitecture(cwd, compiled);
  assert.equal(fs.existsSync(sidecar), true, 'writable baseline: an unfenced persist lands');

  fs.rmSync(sidecar);
  fenceDangling(sidecar);
  assert.throws(
    () => persistCompiledArchitecture(cwd, compiled),
    /project state write fence refused/,
    'the refusal is named as itself, and as this file',
  );
  // The same refusal reached through the default (persisting) entry point, which
  // used to return the in-memory object as though it were on disk.
  assert.throws(
    () => compileArchitectureForRun(cwd, 'R', state),
    /project state write fence refused/,
    'the publishing entry point cannot hand back a contract that never landed',
  );
});

// ── publishRuntimeAssignments: the read-back that makes it BENIGN ────────────
// This one discards writeJson's boolean too, and it looks exactly like the shape
// that had to be fixed elsewhere — a publisher returning a non-nullable value
// after an unchecked write. It is not. It returns `persisted`, re-read from disk
// and hash-compared against the candidate, so a refused write cannot survive the
// next three lines; both production callers run inside a gate's try/catch and
// convert the throw into that gate's deny.
//
// Pinned here because the read-back is the ONLY thing standing between this
// function and the defect: delete it, return `candidate`, and nothing else in
// the suite notices.

test('a refused runtime-assignments write cannot be reported as published', () => {
  const cwd = architectureProject('assignments');
  const compiled = compileArchitectureForRun(cwd, 'R', ARCHITECTURE_STATE);
  const verification = compileVerificationContract(cwd, 'R', ARCHITECTURE_STATE, compiled, {
    changedPaths: [],
  });

  const baseline = publishRuntimeAssignments(cwd, compiled, verification.contractHash);
  assert.ok(baseline.assignmentsHash, 'writable baseline: an unfenced publish returns a persisted manifest');
  assert.equal(readRuntimeAssignments(cwd, 'R')?.assignmentsHash, baseline.assignmentsHash);

  // Remove and fence, so the read-back has nothing valid to find.
  const sidecar = runtimeAssignmentsPath(cwd, 'R');
  fs.rmSync(sidecar);
  fenceDangling(sidecar);

  assert.throws(
    () => publishRuntimeAssignments(cwd, compiled, verification.contractHash),
    /could not be persisted/,
    'the existing read-back already refuses to hand back a manifest that is not on disk',
  );
  assert.equal(readRuntimeAssignments(cwd, 'R'), null, 'and nothing landed');
});

// ── ensureRunHostCapability ──────────────────────────────────────────────────
// A read-back existed here but did not compare hashes, so a refused write left
// it returning the STALE record as though the fresh observation had landed — a
// host that lost a blocking point mid-run kept a record saying it still had one.
// The fence was also the only failure treated that way: an EACCES throws and the
// catch already returns null.

test('a refused host-capability write reports null instead of the stale record', () => {
  const cwd = project('host-capability');
  runDir(cwd, 'baseline');
  assert.ok(ensureRunHostCapability(cwd, 'baseline', 'codex', {
    point: 'PreToolUse', event: 'PreToolUse', source: 'test', outcome: 'denied',
  }), 'writable baseline: an unfenced observation records');

  const fenced = runDir(cwd, 'fenced');
  const first = ensureRunHostCapability(cwd, 'fenced', 'codex', {
    point: 'PreToolUse', event: 'PreToolUse', source: 'test', outcome: 'allowed',
  });
  assert.ok(first, 'the first observation lands, so there IS a stale record to return');

  // Move-aside: the publisher reads the existing record and refuses to replace
  // a published-but-invalid one, so the read has to keep working.
  const sidecar = runHostCapabilityPath(cwd, 'fenced');
  fenceMoveAside(sidecar);

  const refused = ensureRunHostCapability(cwd, 'fenced', 'codex', {
    point: 'PreToolUse', event: 'PreToolUse', source: 'test', outcome: 'denied',
  });
  assert.equal(refused, null,
    'a refused observation is reported, not answered with the record it failed to replace');
});
