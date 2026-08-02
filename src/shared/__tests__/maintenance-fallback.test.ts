import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  captureMaintenanceFallbackBaseline,
  finalizePaidMaintenanceFallback,
  supersedeSkippedDelegationFallback,
  workUnitAllowlistHash,
} from '../maintenance/fallback';
import { fallbackContractMatches } from '../run-bootstrap-policy/envelope-io';
import { paidFallbackCompletionFromMaintenance } from '../maintenance/fallback-proof';
import { maintenanceContractPreflight, recordMaintenanceDelegationOutcome } from '../../runners/opencode/maintenance';
import { isMaintenanceTerminal } from '../maintenance/terminal';
import { ensureRunBootstrap, quickFixDigestPath } from '../run-bootstrap-policy';
import { readRunSettlement, writeRunSettlement } from '../run-settlement';
import {
  architectureInputPath,
  compileArchitectureForRun,
  publishRuntimeAssignments,
} from '../architecture-contract';
import { compileVerificationContract } from '../verification-contract';

const RUN_ID = 'paid-fallback';
const SOURCE = 'src/value.ts';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function withFallbackProject(
  run: (fixture: {
    cwd: string;
    markerPath: string;
    digestPath: string;
    contractHash: string;
    allowlistHash: string;
  }) => void,
  options: { role?: 'quick-fix' | 'senior-frontend' } = {},
): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-paid-fallback-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const role = options.role || 'quick-fix';
    const state = {
      version: 1,
      mode: 'existing-codebase',
      stack: role === 'senior-frontend' ? 'default' : 'custom-backend',
      frontend: role === 'senior-frontend' ? 'react-vite' : 'none',
      backend: role === 'senior-frontend' ? 'supabase' : 'python',
      currentRunId: RUN_ID,
      lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));
    const bootstrap = ensureRunBootstrap(cwd, RUN_ID, role, state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent',
      modelPolicyId: 'test-policy',
      boundedOutputs: [SOURCE],
      boundedAllowlist: [SOURCE],
    });
    assert.ok(bootstrap);
    const digestRelative = role === 'quick-fix'
      ? quickFixDigestPath(RUN_ID)
      : `.traffic-one/digests/${RUN_ID}/frontend.md`;
    assert.ok(bootstrap.workUnit.outputs.includes(digestRelative));
    assert.ok(bootstrap.workUnit.allowlist.includes(digestRelative));
    const fallbackSourceBaseline = captureMaintenanceFallbackBaseline(cwd, bootstrap);
    assert.ok(fallbackSourceBaseline);
    const allowlistHash = workUnitAllowlistHash(bootstrap);
    const markerPath = path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      kind: 'opencode-delegation',
      role,
      outcome: 'failed',
      overallOutcome: 'fallback-pending',
      fallbackAllowed: true,
      workUnitContractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
      fallbackSourceBaseline,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    }));
    writeRunSettlement(cwd, RUN_ID, {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
      fallback: {
        state: 'pending',
        workUnitContractHash: bootstrap.workUnit.contractHash,
        allowlistHash,
      },
      incompleteChecks: ['fallback-pending'],
    });
    run({
      cwd,
      markerPath,
      digestPath: path.join(cwd, digestRelative),
      contractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeImplementedDigest(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# quick-fix\n\nverdict: IMPLEMENTED\n');
}

// The observed no-git existing-codebase deadlock: a delegation that never ran
// left `fallback-pending` pinned to the bounded unit's hashes, and every
// future work unit for the role — including the architect's freshly compiled
// contracts — was vetoed by fallbackContractMatches. Superseding is legal only
// for the skipped shape (nothing delegated, nothing touched); a delegation
// that RAN and failed keeps its pending fallback and its proof chain.
test('a skipped delegation fallback is superseded by compiled contracts; a failed one is not', () => {
  withFallbackProject(({ cwd, markerPath, contractHash, allowlistHash }) => {
    // As written by the harness the delegation FAILED — supersede refuses.
    assert.equal(supersedeSkippedDelegationFallback(cwd, RUN_ID, 'arch-hash'), false);

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, JSON.stringify({
      ...marker,
      outcome: 'skipped',
      action: 'skipped',
      failureKind: 'skipped',
      touched: [],
      error: 'No git HEAD to sandbox the delegation; run a normal subagent',
    }));
    assert.equal(supersedeSkippedDelegationFallback(cwd, RUN_ID, 'arch-hash'), true);

    const after = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(after.overallOutcome, 'superseded');
    assert.equal(after.fallbackAllowed, false);
    assert.equal(after.supersededByArchitectureHash, 'arch-hash');
    // Deliberately NON-terminal: a terminal outcome mid-run made per-prompt
    // reconciliation read the re-planned run as a completed maintenance run.
    assert.equal(isMaintenanceTerminal(after), false);

    // The settlement pin is gone: no fallback state, no pinned hashes.
    const settlement = readRunSettlement(cwd, RUN_ID);
    assert.ok(settlement);
    assert.equal(settlement!.fallback, undefined);
    assert.equal(settlement!.workUnitContractHash, undefined);

    // The per-role work-unit veto is lifted: a DIFFERENT contract now passes.
    const supersededUnit = {
      contractHash: `not-${contractHash}`,
      allowlist: ['src/other.ts'],
      allowlistExclude: [],
    } as unknown as Parameters<typeof fallbackContractMatches>[3];
    assert.equal(fallbackContractMatches(cwd, RUN_ID, marker.role, supersededUnit), true);
    assert.notEqual(allowlistHash, '');

    // Idempotent: a second call has nothing pending to supersede.
    assert.equal(supersedeSkippedDelegationFallback(cwd, RUN_ID, 'arch-hash'), false);
  }, { role: 'senior-frontend' });
});

// The ordering guarantee the PLAN_READY accept path relies on: while the
// skipped-delegation pin is pending, publishing a COMPILED envelope for the
// pinned role fails (fallbackContractMatches veto) — the supersede transition
// must run before ensureRunPolicyBootstraps, or run 1785623723274's deadlock
// silently returns with every unit test still green.
test('a pending skipped-delegation pin vetoes compiled envelopes until superseded', () => {
  withFallbackProject(({ cwd, markerPath }) => {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, JSON.stringify({
      ...marker, outcome: 'skipped', action: 'skipped', touched: [],
    }));
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    const inputPath = architectureInputPath(cwd, RUN_ID);
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify({
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    }));
    const architecture = compileArchitectureForRun(cwd, RUN_ID, state);
    const verification = compileVerificationContract(cwd, RUN_ID, state, architecture, {
      changedPaths: [],
    });
    publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    const publish = () => ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent',
      modelPolicyId: 'test-policy',
    });
    assert.equal(publish(), null, 'the stale bounded pin must veto the compiled envelope');
    assert.equal(supersedeSkippedDelegationFallback(cwd, RUN_ID, architecture.contractHash), true);
    const envelope = publish();
    assert.ok(envelope, 'after supersede the compiled envelope publishes');
    assert.equal(envelope!.workUnit.unitId, 'senior-frontend:bootstrap');
  }, { role: 'senior-frontend' });
});

test('paid fallback finalizer requires a source delta and rejects wrong role/hash evidence', () => {
  withFallbackProject(({ cwd, markerPath, digestPath }) => {
    writeImplementedDigest(digestPath);
    assert.deepEqual(finalizePaidMaintenanceFallback(cwd, RUN_ID), {
      status: 'pending',
      reason: 'paid fallback has not produced an in-allowlist source delta',
    });

    const original = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(markerPath, JSON.stringify({ ...original, role: 'senior-backend' }));
    assert.equal(finalizePaidMaintenanceFallback(cwd, RUN_ID).status, 'invalid');

    fs.writeFileSync(markerPath, JSON.stringify({
      ...original,
      workUnitContractHash: '0'.repeat(64),
    }));
    assert.equal(finalizePaidMaintenanceFallback(cwd, RUN_ID).status, 'invalid');
    assert.equal(readRunSettlement(cwd, RUN_ID)?.fallback?.state, 'pending');
  });
});

test('paid fallback finalizer atomically publishes fallback-paid and code-delivered, and replay is idempotent', () => {
  withFallbackProject(({ cwd, markerPath, digestPath, contractHash, allowlistHash }) => {
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 2;\n');
    writeImplementedDigest(digestPath);

    const completed = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.changedPaths, [SOURCE]);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const proof = paidFallbackCompletionFromMaintenance(marker);
    assert.ok(proof);
    assert.equal(marker.outcome, 'fallback-paid');
    assert.equal(marker.overallOutcome, 'fallback-paid');
    assert.equal(isMaintenanceTerminal(marker), true);
    assert.equal(proof.role, 'quick-fix');
    assert.equal(proof.workUnitContractHash, contractHash);
    assert.equal(proof.allowlistHash, allowlistHash);
    assert.deepEqual(proof.changedPaths, [SOURCE]);

    const settlement = readRunSettlement(cwd, RUN_ID);
    assert.equal(settlement?.status, 'code-delivered');
    assert.equal(settlement?.fallback?.state, 'completed');
    assert.equal(settlement?.workUnitContractHash, contractHash);
    assert.equal(settlement?.allowlistHash, allowlistHash);
    assert.notEqual(settlement?.status, 'verified');

    const replay = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    const replayedSettlement = readRunSettlement(cwd, RUN_ID);
    assert.equal(replay.status, 'already-completed');
    assert.equal(replayedSettlement?.revision, settlement?.revision);
    assert.equal(replayedSettlement?.settlementHash, settlement?.settlementHash);
  });
});

test('paid frontend fallback finalizes against the same exact bounded role contract', () => {
  withFallbackProject(({ cwd, markerPath, digestPath, contractHash }) => {
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 3;\n');
    writeImplementedDigest(digestPath);

    const completed = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(completed.status, 'completed');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const proof = paidFallbackCompletionFromMaintenance(marker);
    assert.ok(proof);
    assert.equal(proof.role, 'senior-frontend');
    assert.equal(proof.workUnitContractHash, contractHash);
    assert.equal(proof.digestPath, `.traffic-one/digests/${RUN_ID}/frontend.md`);
    assert.equal(readRunSettlement(cwd, RUN_ID)?.status, 'code-delivered');
  }, { role: 'senior-frontend' });
});

// ── The 16co news batch, replayed ────────────────────────────────────────────
// Three same-role units; unit 1 failed with a fallback owed. The single-slot
// marker then (a) killed unit 2 in 28ms pre-model — `fallbackContractMatches`
// voided every new bounded envelope while the pin was armed — and (b) let unit
// 2's rejection overwrite unit 1's debt wholesale, which disarmed the guard
// long enough for a full-scope republish, after which unit 3's failure pinned
// hashes the active envelope no longer held. Reproduced end-to-end with
// controls before this fix: the latch was the sole cause.
test('a sibling bounded unit publishes while a debt is pending, and the debt survives it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-batch-latch-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), 'export const b = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const state = {
      version: 1,
      mode: 'existing-codebase',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      currentRunId: RUN_ID,
      lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));

    // Unit A: bounded envelope publishes, the unit fails, the debt is armed.
    const bootstrapA = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'test-policy',
      boundedOutputs: ['src/a.ts'],
      boundedAllowlist: ['src/a.ts'],
    });
    assert.ok(bootstrapA, 'unit A must publish its bounded envelope');
    recordMaintenanceDelegationOutcome(
      cwd, state, RUN_ID, 'senior-frontend',
      { ok: false, action: 'failed', digest: null, touched: [], error: 'oversized module', failureKind: 'verification-failed' },
      Date.now(), true, bootstrapA, 'news-fixtures',
    );
    const armed = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), 'utf8'));
    assert.equal(armed.overallOutcome, 'fallback-pending', 'unit A must arm the debt');

    // Unit B: a DIFFERENT bounded envelope must now publish. This is the row
    // that fails before the fix — the pin voided every non-matching envelope,
    // so unit B died in preflight without ever reaching a model.
    const bootstrapB = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'test-policy',
      boundedOutputs: ['src/b.ts'],
      boundedAllowlist: ['src/b.ts'],
    });
    assert.ok(bootstrapB, 'a sibling bounded unit must not be pre-model-killed by another unit\'s debt');

    // Unit B fails too — and unit A's debt SURVIVES the write.
    recordMaintenanceDelegationOutcome(
      cwd, state, RUN_ID, 'senior-frontend',
      { ok: false, action: 'failed', digest: null, touched: [], error: 'typecheck failed', failureKind: 'verification-failed' },
      Date.now() + 1, true, bootstrapB, 'news-article',
    );
    const after = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), 'utf8'));
    assert.ok(after.units && after.units['news-fixtures'], 'unit A\'s record must survive unit B\'s outcome');
    assert.equal(after.units['news-fixtures'].overallOutcome, 'fallback-pending', 'the debt is not erased');
    assert.equal(after.units['news-article'].overallOutcome, 'fallback-pending');
    // The projection pins the OLDEST debt, so the finalizer discharges in order.
    assert.equal(after.workUnitContractHash, bootstrapA.workUnit.contractHash, 'top level projects the oldest debt');

    // The widen guard is intact: a full-scope candidate is still void. The
    // 21:44:55 write in 16co — a parent policy preflight republishing the
    // full-scope envelope mid-batch — must keep failing while any debt is live.
    const fullScope = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'parent-policy-preflight',
      modelPolicyId: 'test-policy',
    });
    assert.equal(fullScope, null, 'a full-scope envelope must stay void while a debt is pending');

    // And so must a bounded candidate that TOUCHES an owed file — that is a
    // takeover of the debt, not a sibling. Sibling admissibility is disjointness,
    // never the unit-id string alone.
    const overlapping = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'test-policy',
      boundedOutputs: ['src/a.ts', 'src/c.ts'],
      boundedAllowlist: ['src/a.ts', 'src/c.ts'],
    });
    assert.equal(overlapping, null, 'a bounded envelope overlapping a pinned debt must stay void');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The projection keeps EVERY legacy reader on the single-record shape: while
// any debt is pending the marker reads fallback-pending (non-terminal), and
// only when the last debt resolves does the latest outcome show through.
test('the marker projection is non-terminal while any debt is pending', () => {
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'fallback-pending' }), false);
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'preflight-rejected' }), false);
});

// Two debts in the batch: discharging the FIRST must not advertise the run as
// delivered while the second is still owed. The settlement follows the
// projection to the next debt, and the discharged unit's proof survives inside
// its own record. Pre-refactor this shape was impossible to even reach — the
// second debt no longer existed by finalize time.
test('the finalizer discharges one debt and the settlement moves to the next', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-two-debts-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), 'export const b = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const state = {
      version: 1,
      mode: 'existing-codebase',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      currentRunId: RUN_ID,
      lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));

    // Arm debt A, then debt B, through the real writer.
    const bootA = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p', boundedOutputs: ['src/a.ts'], boundedAllowlist: ['src/a.ts'],
    });
    assert.ok(bootA);
    recordMaintenanceDelegationOutcome(cwd, state, RUN_ID, 'senior-frontend',
      { ok: false, action: 'failed', digest: null, touched: [], error: 'x', failureKind: 'verification-failed' },
      Date.now() - 1000, true, bootA, 'unit-a');
    const bootB = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p', boundedOutputs: ['src/b.ts'], boundedAllowlist: ['src/b.ts'],
    });
    assert.ok(bootB);
    recordMaintenanceDelegationOutcome(cwd, state, RUN_ID, 'senior-frontend',
      { ok: false, action: 'failed', digest: null, touched: [], error: 'y', failureKind: 'verification-failed' },
      Date.now(), true, bootB, 'unit-b');

    // The projection pins A (older); B's publish left B's envelope active, so
    // finalizing A first requires republishing A's exact envelope — the same
    // recovery the runtime's own retry path performs.
    const bootA2 = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p', boundedOutputs: ['src/a.ts'], boundedAllowlist: ['src/a.ts'],
    });
    assert.ok(bootA2, 'the owed unit\'s exact envelope must republish (it matches its own pin)');
    assert.equal(bootA2.workUnit.contractHash, bootA.workUnit.contractHash);

    // The paid fallback delivers A's change + the role digest.
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 2;\n');
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'digests', RUN_ID), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'digests', RUN_ID, 'frontend.md'),
      '# frontend\n\nverdict: IMPLEMENTED\n',
    );

    const first = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.match(first.reason, /sibling unit's fallback remains pending/);

    const marker = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), 'utf8'));
    assert.equal(marker.units['unit-a'].overallOutcome, 'fallback-paid', 'debt A is discharged in its own record');
    assert.equal(marker.units['unit-b'].overallOutcome, 'fallback-pending', 'debt B survives the discharge');
    assert.equal(marker.overallOutcome, 'fallback-pending', 'the projection moves to the next debt');
    assert.equal(marker.workUnitContractHash, bootB.workUnit.contractHash);

    const settlement = readRunSettlement(cwd, RUN_ID);
    assert.equal(settlement?.status, 'active', 'the run is NOT delivered while a debt is owed');
    assert.equal(settlement?.fallback?.state, 'pending');
    assert.equal(settlement?.fallback?.workUnitContractHash, bootB.workUnit.contractHash);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The preflight's error text has always said directories cannot authorize a
// paid fallback; the filter was pure string matching, so a bare directory
// passed and the refusal landed nine minutes later as an IMMUTABLE failed
// settlement (captureFallbackSourceSnapshot returns null on a directory).
// Now the refusal is immediate, cheap, and non-terminal.
test('a directory in the maintenance allowlist is refused at preflight, not nine minutes later', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-dir-preflight-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src', 'features', 'news'), { recursive: true });
    const state = {
      version: 1, mode: 'existing-codebase', stack: 'default',
      frontend: 'react-vite', backend: 'supabase',
      currentRunId: RUN_ID, lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));
    const preflight = maintenanceContractPreflight(cwd, state, RUN_ID, 'senior-frontend', 'src/features/news');
    assert.equal(preflight.bootstrap, null);
    assert.match(String(preflight.error), /globs and directories cannot authorize/);
    // Negative row: a not-yet-created FILE under the same directory is a legal
    // bounded output and proceeds past this check (it fails later only on the
    // missing model policy this bare fixture never wrote).
    const file = maintenanceContractPreflight(cwd, state, RUN_ID, 'senior-frontend', 'src/features/news/selectors.ts');
    assert.doesNotMatch(String(file.error), /globs and directories/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The union envelope: one paid child, every owed file. Without it two debts for
// one role could never both be discharged — no publisher can synthesize an
// envelope matching more than one pin — so the settlement stayed
// `active/fallback-pending` forever (measured on 16co's own artifacts: the
// union candidate returned false, and the paid child died envelope-dead).
test('a union envelope is admitted exactly, discharges per-debt, and refuses any superset', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-union-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'extra.ts'), 'export const x = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const state = {
      version: 1, mode: 'existing-codebase', stack: 'default',
      frontend: 'react-vite', backend: 'supabase',
      currentRunId: RUN_ID, lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));
    const arm = (files: string[], unitId: string, at: number): void => {
      const boot = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
        host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
        modelPolicyId: 'p', boundedOutputs: files, boundedAllowlist: files,
      });
      assert.ok(boot, `unit ${unitId} must publish`);
      recordMaintenanceDelegationOutcome(cwd, state, RUN_ID, 'senior-frontend',
        { ok: false, action: 'failed', digest: null, touched: [], error: 'x', failureKind: 'verification-failed' },
        at, true, boot, unitId);
    };
    arm(['src/a.ts'], 'unit-a', Date.now() - 2000);
    arm(['src/b.ts'], 'unit-b', Date.now() - 1000);

    // Superset REFUSED: the union plus one extra file is a widening — the exact
    // backdoor the set-equality rule exists to close.
    const superset = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'parent-maintenance-preflight',
      modelPolicyId: 'p',
      boundedOutputs: ['src/a.ts', 'src/b.ts', 'src/extra.ts'],
      boundedAllowlist: ['src/a.ts', 'src/b.ts', 'src/extra.ts'],
    });
    assert.equal(superset, null, 'union + one extra file must be refused');

    // The EXACT union publishes — this is the paid child's envelope.
    const union = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'parent-maintenance-preflight',
      modelPolicyId: 'p',
      boundedOutputs: ['src/a.ts', 'src/b.ts'],
      boundedAllowlist: ['src/a.ts', 'src/b.ts'],
    });
    assert.ok(union, 'the exact union of pending debts must be admitted');

    // Partial delivery: only debt A's file changes. Discharge must be
    // delta-proven per debt — A flips, B stays, settlement stays pending on B.
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 2;\n');
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'digests', RUN_ID), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'digests', RUN_ID, 'frontend.md'),
      '# frontend\n\nverdict: IMPLEMENTED\n',
    );
    const partial = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(partial.status, 'completed', JSON.stringify(partial));
    assert.deepEqual(partial.changedPaths, ['src/a.ts']);
    let marker = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), 'utf8'));
    assert.equal(marker.units['unit-a'].overallOutcome, 'fallback-paid');
    assert.equal(marker.units['unit-b'].overallOutcome, 'fallback-pending', 'a single write must not close two debts');
    assert.equal(readRunSettlement(cwd, RUN_ID)?.fallback?.state, 'pending');

    // Debt B delivers too — the SAME union envelope discharges it and the run
    // reaches code-delivered with zero pending records.
    fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), 'export const b = 2;\n');
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'digests', RUN_ID, 'frontend.md'),
      '# frontend\n\nverdict: IMPLEMENTED\n\nboth units delivered\n',
    );
    const full = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(full.status, 'completed', JSON.stringify(full));
    marker = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), 'utf8'));
    assert.equal(marker.units['unit-b'].overallOutcome, 'fallback-paid');
    assert.equal(marker.overallOutcome, 'fallback-paid', 'nothing pending → the projection is terminal');
    const settled = readRunSettlement(cwd, RUN_ID);
    assert.equal(settled?.status, 'code-delivered');
    assert.equal(settled?.fallback?.state, 'completed');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Legacy marker (v1.0.47 shape, no `units` key — exactly what sits in 16co):
// still fails closed on a widening and still admits its own exact pin.
test('a legacy single-slot marker keeps its exact-pin semantics', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-legacy-marker-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const state = {
      version: 1, mode: 'existing-codebase', stack: 'default',
      frontend: 'react-vite', backend: 'supabase',
      currentRunId: RUN_ID, lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));
    const boot = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p', boundedOutputs: ['src/a.ts'], boundedAllowlist: ['src/a.ts'],
    });
    assert.ok(boot);
    const baseline = captureMaintenanceFallbackBaseline(cwd, boot);
    assert.ok(baseline);
    // Hand-write the v1.0.47 single-record shape — no `units`.
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json'), JSON.stringify({
      version: 1, kind: 'opencode-delegation', role: 'senior-frontend',
      outcome: 'failed', overallOutcome: 'fallback-pending', fallbackAllowed: true,
      workUnitContractHash: boot.workUnit.contractHash,
      allowlistHash: workUnitAllowlistHash(boot),
      fallbackSourceBaseline: baseline,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    }));
    // Its own exact pin republishes.
    const exact = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p', boundedOutputs: ['src/a.ts'], boundedAllowlist: ['src/a.ts'],
    });
    assert.ok(exact, 'the legacy pin must admit its own exact envelope');
    // A widening is still refused.
    const widened = ensureRunBootstrap(cwd, RUN_ID, 'senior-frontend', state, {
      host: 'codex', hostAgentType: null, evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'p',
      boundedOutputs: ['src/a.ts', 'src/z.ts'],
      boundedAllowlist: ['src/a.ts', 'src/z.ts'],
    });
    assert.equal(widened, null, 'a legacy marker must still refuse a widening');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
