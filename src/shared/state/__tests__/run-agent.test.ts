import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  anyRunProducedImplementerOutput,
  anyRunReachedTerminalVerdict,
  claimThreadRole,
  continuationAgentId,
  ensureCurrentRunId,
  ensureRunAgentClaim,
  ensureRunLedger,
  hasActiveRunClaims,
  hasRunAgentState,
  inferRoleFromTranscript,
  markRunAgentReplaced,
  pruneExpiredPendingClaims,
  readRunAgentRegistry,
  readRunAssignments,
  readRunAssignmentsResilient,
  refreshCursorRunAgentFromTranscriptCache,
  recordRunAgent,
  resolveRunAgentContext,
  runHasOrchestratedArtifacts,
  runIdNow,
  runReachedTerminalVerdict,
  runSettledForRotation,
  transcriptThreadId,
} from '../run-agent';
import { stackFingerprint } from '../materialization';

function writeDigest(dir: string, runId: string, name: string, verdict: string): void {
  const d = path.join(dir, '.traffic-one', 'digests', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), `# ${name}\nverdict: ${verdict}\n`, 'utf8');
}

function writeMaintenanceMarker(dir: string, runId: string, outcome: string): void {
  const memoryDir = ['.traffic', '-one'].join('');
  const d = path.join(dir, memoryDir, 'runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'maintenance.json'), JSON.stringify({ version: 1, outcome }), 'utf8');
}

test('QA-evidence gate is per-run: backend-only run is terminal; frontend run still needs QA but can rotate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-perrun-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    // Frontend project → QA is required project-wide (the old project-level gate).
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase' }));
    // BACKEND-ONLY run: green verdicts + backend.md, but NO frontend.md and NO QA artifacts.
    // Must be terminal — gating it on project-level frontend config pinned currentRunId forever.
    writeDigest(dir, 'rb', 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rb', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'rb', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'rb'), true, 'backend-only run does not require QA evidence');
    // FRONTEND run (frontend.md present), green, but no QA artifacts → still NOT terminal
    // (the QA enforcement for genuine frontend runs is preserved)...
    writeDigest(dir, 'rf', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rf', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'rf', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'rf'), false, 'frontend run still requires QA evidence');
    // ...but it is "settled enough to rotate" at a prompt boundary, so currentRunId is never
    // pinned forever (the rotation-deadlock class). An in-flight run (no green verdicts) is not.
    assert.equal(runSettledForRotation(dir, 'rf'), true, 'finished frontend run rotates even without QA');
    writeDigest(dir, 'rx', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rx', 'reviewer.md', 'CHANGES_REQUESTED');
    assert.equal(runSettledForRotation(dir, 'rx'), false, 'a still-verifying run does not rotate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runReachedTerminalVerdict requires terminal verdict tokens, not mere digest existence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verdict-'));
  try {
    // No digests at all → not terminal.
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer mid-fix-cycle (CHANGES_REQUESTED), no tester → not terminal.
    writeDigest(dir, 'r1', 'reviewer.md', 'CHANGES_REQUESTED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer APPROVED but no tester digest → still not terminal (needs both).
    writeDigest(dir, 'r1', 'reviewer.md', 'APPROVED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Tester delegated-but-unverified token is non-terminal by design.
    writeDigest(dir, 'r1', 'tester.md', 'DELEGATED_OK');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Tester TESTS_FAILING → not terminal.
    writeDigest(dir, 'r1', 'tester.md', 'TESTS_FAILING');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer APPROVED + tester TESTS_GREEN → terminal.
    writeDigest(dir, 'r1', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), true);
    // Orchestrators deviate: a tester digest with `verdict: APPROVED` (observed: gpt-5.5)
    // is also a PASSING tester → terminal (was a false-negative before the broadening).
    writeDigest(dir, 'r1', 'tester.md', 'APPROVED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), true);
    // A shipper digest (written only post-deploy) is terminal on its own.
    writeDigest(dir, 'r2', 'shipper.md', 'deployed https://app.example');
    assert.equal(runReachedTerminalVerdict(dir, 'r2'), true);
    // anyRunReachedTerminalVerdict scans every run dir.
    assert.equal(anyRunReachedTerminalVerdict(dir), true);
    assert.equal(anyRunReachedTerminalVerdict(path.join(dir, 'nope')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runReachedTerminalVerdict treats terminal maintenance markers as settled runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-maint-verdict-'));
  try {
    assert.equal(runReachedTerminalVerdict(dir, 'quick-1'), false);
    writeMaintenanceMarker(dir, 'quick-1', 'failed');
    assert.equal(runReachedTerminalVerdict(dir, 'quick-1'), true);
    writeMaintenanceMarker(dir, 'quick-2', 'running');
    assert.equal(runReachedTerminalVerdict(dir, 'quick-2'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyRunProducedImplementerOutput detects senior-* implementer digests (Cursor double-emit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl-senior-'));
  try {
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // Cursor's write path can emit only the senior-prefixed digest. It must still count as
    // implementer output, or a finished build wedges in 'building' at the prompt boundary.
    writeDigest(dir, 'r1', 'senior-frontend.md', 'BUILD_COMPLETE');
    assert.equal(anyRunProducedImplementerOutput(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyRunProducedImplementerOutput sees frontend/backend digests, not architect-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl-'));
  try {
    // No digests dir at all → no implementer output.
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // Only an architect digest (the build merely planned) → not implementer output.
    writeDigest(dir, 'r1', 'architect.md', 'PLAN_READY');
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // A frontend digest (code was written) → implementer output, even with no verdict.
    writeDigest(dir, 'r1', 'frontend.md', 'done');
    assert.equal(anyRunProducedImplementerOutput(dir), true);
    // Scans every run dir; a backend-only digest in another run also counts.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl2-'));
    try {
      writeDigest(dir2, 'r9', 'backend.md', 'done');
      assert.equal(anyRunProducedImplementerOutput(dir2), true);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignments tolerates the `roles`-object schema (ownedPaths/readOnlyPaths)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-roles-'));
  try {
    const d = path.join(dir, '.traffic-one', 'runs', 'R');
    fs.mkdirSync(d, { recursive: true });
    // The exact deviation observed live (gpt-5.5 architect): a `roles` object, no `assignments` array.
    fs.writeFileSync(path.join(d, 'assignments.json'), JSON.stringify({
      runId: 'R', installOwner: 'senior-backend',
      roles: {
        'senior-frontend': { ownedPaths: ['apps/web/**', 'packages/ui/**'], readOnlyPaths: ['supabase/**'] },
        'senior-backend': { ownedPaths: ['supabase/**', 'packages/api-client/**'] },
      },
      nonOverlapAssertion: 'no overlap',
    }), 'utf8');
    const m = readRunAssignments(dir, 'R');
    assert.ok(m, 'roles schema must parse');
    assert.equal(m?.assignments.length, 2);
    const fe = m?.assignments.find((a) => a.role === 'senior-frontend');
    assert.deepEqual(fe?.scope.include, ['apps/web/**', 'packages/ui/**']);
    assert.deepEqual(fe?.scope.exclude, ['supabase/**']); // readOnlyPaths → exclude
    const be = m?.assignments.find((a) => a.role === 'senior-backend');
    assert.deepEqual(be?.scope.include, ['supabase/**', 'packages/api-client/**']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runHasOrchestratedArtifacts: schema-agnostic raw-existence of assignments OR a digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-artifacts-'));
  try {
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), false); // nothing yet
    ensureRunLedger(dir, 'R', { status: 'planned', kind: 'maintenance-triage' });
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), false, 'run.json alone is not an orchestrated run');
    // A non-conforming assignments.json (would NOT parse) still counts — raw existence.
    const rd = path.join(dir, '.traffic-one', 'runs', 'R');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'assignments.json'), '{"totally":"unparseable-for-scope"}', 'utf8');
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), true);
    // A digest alone also counts (no assignments file).
    writeDigest(dir, 'R2', 'architect.md', 'PLAN_READY');
    assert.equal(runHasOrchestratedArtifacts(dir, 'R2'), true);
    assert.equal(runHasOrchestratedArtifacts(dir, ''), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withPrefs<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runagent-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runIdNow returns a unix epoch millisecond string', () => {
  assert.match(runIdNow(), /^\d{13}$/);
});

test('ensureCurrentRunId writes a minimal planned run ledger', () => {
  withPrefs((dir) => {
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
    const runId = ensureCurrentRunId(dir, state);
    assert.match(runId, /^\d{13}$/);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'planned');
    assert.equal(ledger.kind, 'spawn-gate');
    assert.equal(ledger.runId, runId);
    assert.equal(runHasOrchestratedArtifacts(dir, runId), false);
  });
});

test('hasActiveRunClaims ignores run.json planned ledgers without agent claims', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = ensureCurrentRunId(dir, state);
    assert.equal(hasActiveRunClaims(dir, state), false);
    assert.equal(hasRunAgentState(dir, state), false);
    assert.ok(fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json')));
  });
});

test('hasRunAgentState counts real run-agent artifacts, not planned ledger directories', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = ensureCurrentRunId(dir, state);
    assert.equal(hasRunAgentState(dir, state), false);
    writeAssignments(dir, runId, 'senior-frontend');
    assert.equal(hasRunAgentState(dir, state), true);
  });
});

function writeAssignments(dir: string, runId: string, role: string): void {
  const d = path.join(dir, '.traffic-one', 'runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'assignments.json'), JSON.stringify({
    version: 1, runId, assignments: [{ role, scope: { include: ['apps/web/**'] } }],
  }), 'utf8');
}

test('readRunAssignmentsResilient recovers from a run-id split (assignments under a stray id)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runassign-'));
  try {
    // Architect wrote assignments under a stray ISO id; the gate's currentRunId differs.
    writeAssignments(dir, '2026-06-17T10-30-00Z', 'senior-frontend');
    const m = readRunAssignmentsResilient(dir, '1781692097241');
    assert.ok(m && m.assignments[0]?.role === 'senior-frontend', 'found assignments despite the split');
    // Nothing anywhere → null.
    assert.equal(readRunAssignmentsResilient(path.join(dir, 'nope'), '1781692097241'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignmentsResilient prefers the exact runId over the fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runassign2-'));
  try {
    writeAssignments(dir, '1781692097241', 'senior-backend');     // matches currentRunId
    writeAssignments(dir, '2026-06-17T10-30-00Z', 'senior-frontend'); // stray (newer name, but exact wins)
    const m = readRunAssignmentsResilient(dir, '1781692097241');
    assert.ok(m && m.assignments[0]?.role === 'senior-backend', 'exact runId match preferred');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignments tolerates scope.include and object-shaped writeScope assignments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-assign-shapes-'));
  try {
    const d1 = path.join(dir, '.traffic-one', 'runs', 'roles-scope');
    fs.mkdirSync(d1, { recursive: true });
    fs.writeFileSync(path.join(d1, 'assignments.json'), JSON.stringify({
      roles: {
        'senior-frontend': { scope: { include: ['apps/web/**'], exclude: ['services/**'] } },
      },
    }), 'utf8');
    assert.deepEqual(readRunAssignments(dir, 'roles-scope')?.assignments[0]?.scope, {
      include: ['apps/web/**'],
      exclude: ['services/**'],
    });

    const d2 = path.join(dir, '.traffic-one', 'runs', 'object-shape');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'assignments.json'), JSON.stringify({
      assignments: {
        'senior-backend': { description: 'API', writeScope: ['services/api/**'] },
      },
    }), 'utf8');
    const m = readRunAssignments(dir, 'object-shape');
    assert.equal(m?.assignments[0]?.role, 'senior-backend');
    assert.equal(m?.assignments[0]?.summary, 'API');
    assert.deepEqual(m?.assignments[0]?.scope.include, ['services/api/**']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureRunAgentClaim writes a pending claim and stamps run state', () => {
  withPrefs((dir) => {
    const claim = ensureRunAgentClaim(dir, { stack: 'default' }, 'senior-frontend', {}, { toolName: 'Task' });
    assert.ok(claim);
    assert.equal(claim!.role, 'senior-frontend');
    assert.equal(claim!.status, 'pending');
    assert.equal(claim!.spawnIndex, 1);

    const runId = claim!.runId as string;
    const pending = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    assert.equal(fs.existsSync(pending), true);
    assert.equal(fs.readdirSync(pending).filter((f) => f.endsWith('.json')).length, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.kind, 'agent-claim');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.currentRunId, runId);
    assert.deepEqual(onDisk.spawnIndex, { 'senior-frontend': 1 });
  });
});

test('ensureRunAgentClaim rejects unknown roles', () => {
  withPrefs((dir) => {
    assert.equal(ensureRunAgentClaim(dir, {}, 'bogus-role', {}, {}), null);
  });
});

test('pruneExpiredPendingClaims removes stale pending claims and keeps fresh ones', () => {
  withPrefs((dir) => {
    const runId = 'run-prune';
    const pending = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'old.json'), JSON.stringify({
      version: 1,
      runId,
      claimId: 'old',
      role: 'senior-backend',
      status: 'pending',
      createdAt: '1970-01-01T00:00:00Z',
    }), 'utf8');
    fs.writeFileSync(path.join(pending, 'fresh.json'), JSON.stringify({
      version: 1,
      runId,
      claimId: 'fresh',
      role: 'senior-frontend',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    assert.equal(pruneExpiredPendingClaims(dir, runId), 1);
    const remaining = fs.readdirSync(pending).filter((name) => name.endsWith('.json'));
    assert.equal(remaining.length, 1);
    assert.ok(!remaining.includes('old.json'));
  });
});

// A materialized state whose fingerprint matches materializedStack, so claims pass
// claimAllowsState (the run-context guard).
function materializedState(): Record<string, unknown> {
  const base = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  return { ...base, materializedStack: stackFingerprint(base) };
}

const FRONTEND_TRANSCRIPT = '/Users/x/.codex/sessions/2026/05/29/rollout-2026-05-29T14-48-49-019e7390-ca45-7e03-84d3-284bda1ba905.jsonl';
const FRONTEND_THREAD = '019e7390-ca45-7e03-84d3-284bda1ba905';

test('transcriptThreadId parses the running thread uuid from a rollout filename', () => {
  assert.equal(transcriptThreadId(FRONTEND_TRANSCRIPT), FRONTEND_THREAD);
  assert.equal(transcriptThreadId('rollout-2026-05-29T14-48-49-019e7390-ca45-7e03-84d3-284bda1ba905.jsonl'), FRONTEND_THREAD);
  assert.equal(transcriptThreadId('/tmp/not-a-rollout.txt'), null);
  assert.equal(transcriptThreadId(null), null);
});

test('claimThreadRole stakes a role claim keyed by thread id; a child write resolves it via transcript_path', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const ctx = claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' });
    assert.ok(ctx);
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);

    // Codex reports the PARENT session_id on the child's write, but its own
    // transcript_path → resolves by threadId, no pending-claiming.
    const resolved = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: FRONTEND_TRANSCRIPT,
    }, { claimPending: false });
    assert.equal(resolved?.role, 'senior-frontend');

    // Idempotent.
    assert.equal(claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend')?.sessionId, FRONTEND_THREAD);
  });
});

test('a thread with no claim (the orchestrator) resolves to no role', () => {
  withPrefs((dir) => {
    const state = materializedState();
    claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend');
    const main = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: '/x/rollout-2026-05-29T14-00-00-019e7389-0000-7000-8000-000000000000.jsonl',
    }, { claimPending: false });
    assert.equal(main, null);
  });
});

test('claimThreadRole rejects unknown roles and empty thread ids', () => {
  withPrefs((dir) => {
    const state = materializedState();
    assert.equal(claimThreadRole(dir, state, FRONTEND_THREAD, 'bogus-role'), null);
    assert.equal(claimThreadRole(dir, state, '', 'senior-frontend'), null);
  });
});

// A real Codex spawn prompt names the ASSIGNED role AND cross-references others
// ("avoid backend-owned paths", "senior-backend owns the API") — the inference must
// pick the assigned one, anchored on "You are …", not bail on the multiple tokens.
function writeChildTranscript(dir: string, threadId: string, body: string): string {
  const file = path.join(dir, `rollout-2026-05-29T16-44-54-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
  })}\n`, 'utf8');
  return file;
}

test('inferRoleFromTranscript reads the assigned role despite cross-referenced roles', () => {
  withPrefs((dir) => {
    const fe = writeChildTranscript(dir, FRONTEND_THREAD,
      'You are Traffic One `senior-frontend` for run `R` in /x. You are not alone; avoid backend-owned paths. senior-backend owns the API.');
    assert.equal(inferRoleFromTranscript(fe), 'senior-frontend');

    const be = writeChildTranscript(dir, '019e7402-3e75-7ef0-bc01-115940d1a574',
      'You are Traffic One `senior-backend` for run `R`. Coordinate with senior-frontend on contracts.');
    assert.equal(inferRoleFromTranscript(be), 'senior-backend');

    // No assignment (orchestrator transcript) → null.
    const main = writeChildTranscript(dir, '019e7389-0000-7000-8000-000000000000', 'Build the portfolio app. Spawn the team.');
    assert.equal(inferRoleFromTranscript(main), null);
    assert.equal(inferRoleFromTranscript('/no/such/file.jsonl'), null);
  });
});

test('resolveRunAgentContext self-heals: a subagent write with no claim infers role from its transcript and stakes it', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const transcript = writeChildTranscript(dir, FRONTEND_THREAD,
      'You are Traffic One `senior-frontend` for run `R`. Avoid backend-owned paths; senior-backend owns the API.');

    // Child write: Codex reports the PARENT session_id, threadId from transcript differs → self-heal.
    const ctx = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: transcript,
    }, { claimPending: true });
    assert.ok(ctx, 'expected the subagent write to self-heal a role claim');
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);

    // The claim is now persisted → a second resolution hits the fast exact-match path.
    const again = resolveRunAgentContext(dir, state, { session_id: 'orchestrator-parent', transcript_path: transcript }, { claimPending: false });
    assert.equal(again?.role, 'senior-frontend');

    // The orchestrator itself (threadId === sessionId, no claim) never self-heals a role.
    const orch = '019e7389-8edd-7e50-b566-2e9a0d52b9d9';
    const orchTranscript = writeChildTranscript(dir, orch, 'Build the portfolio app and spawn the team.');
    const main = resolveRunAgentContext(dir, state, { session_id: orch, transcript_path: orchTranscript }, { claimPending: true });
    assert.equal(main, null);
  });
});

// The dominant real-world spawn phrasing (observed live on Codex) has no "You are":
// "Traffic One senior-frontend fix-cycle role for project … Run id: …". Without
// matching it, every worker failed transcript inference and fell to FIFO pending
// matching, which misclaims roles under parallel spawns.
test('inferRoleFromTranscript reads the "Traffic One senior-X …" prompt shape', () => {
  withPrefs((dir) => {
    const fix = writeChildTranscript(dir, FRONTEND_THREAD,
      'Traffic One senior-frontend fix-cycle role for project /x. Run id: 1781253608942.\n\nRead the reviewer digest first. senior-backend owns the API surfaces.');
    assert.equal(inferRoleFromTranscript(fix), 'senior-frontend');

    const retry = writeChildTranscript(dir, '019e7402-3e75-7ef0-bc01-115940d1a574',
      'Traffic One senior-tester paid fallback for /x. Run id: 1781253608942. Add tests only.');
    assert.equal(inferRoleFromTranscript(retry), 'senior-tester');
  });
});

test('pending-claim matching is role-aware and keys the claim by thread id', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = (state as Record<string, unknown>).currentRunId as string;
    // Parent staked two pending claims (fix-cycle frontend + backend).
    ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: 'orchestrator-parent' }, { toolName: 'spawn_agent' });
    ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: 'orchestrator-parent' }, { toolName: 'spawn_agent' });

    // The frontend thread's transcript names ONLY its own assignment — it must
    // claim the senior-frontend pending file even though backend's is older
    // (FIFO order), and the claimed file must be keyed by the THREAD id, not the
    // parent session id Codex repeats for every worker.
    const transcript = writeChildTranscript(dir, FRONTEND_THREAD,
      'Traffic One senior-frontend fix-cycle role for project /x. Run id: ' + runId + '.');
    const ctx = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: transcript,
    }, { claimPending: true });
    assert.ok(ctx);
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);
  });
});

test('inferRoleFromTranscript honors the [t1-role:] marker contract', () => {
  withPrefs((dir) => {
    const file = writeChildTranscript(dir, FRONTEND_THREAD,
      '[t1-role: senior-reviewer]\nRead-only review for run R. senior-frontend and senior-backend own the implementation.');
    assert.equal(inferRoleFromTranscript(file), 'senior-reviewer');
  });
});

test('inferRoleFromTranscript parses the CURSOR {role, message} transcript shape', () => {
  withPrefs((dir) => {
    // Cursor's subagent transcript is {role, message} per line — NOT the Codex
    // payload/content shape. This is the run-team-not-subagent block: parsing only
    // the Codex shape returned null for every Cursor subagent. (tests/4b live bug.)
    const f1 = path.join(dir, 'rollout-cursor-be.jsonl');
    fs.writeFileSync(f1, [
      JSON.stringify({ role: 'user', message: '[t1-role: senior-backend]\nRun R. Implement the API layer.', type: 'message', status: 'ok' }),
      JSON.stringify({ role: 'assistant', message: 'Working on it.' }),
    ].join('\n') + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f1), 'senior-backend');

    // Cursor message-as-object shape ({content:string}) also resolves.
    const f2 = path.join(dir, 'rollout-cursor-fe.jsonl');
    fs.writeFileSync(f2, JSON.stringify({
      role: 'user', message: { content: 'You are Traffic One `senior-frontend` for run R. senior-backend owns the API.' },
    }) + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f2), 'senior-frontend');

    // Last-resort raw marker scan: marker present but in an unrecognized line shape.
    const f3 = path.join(dir, 'rollout-cursor-odd.jsonl');
    fs.writeFileSync(f3, JSON.stringify({ kind: 'thread_item', data: { text: 'spawn [t1-role: senior-tester] user' } }) + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f3), 'senior-tester');
  });
});

function cursorProjectKey(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/[/:\s]+/g, '-');
}

function writeCursorSubagentTranscript(cursorProjectsRoot: string, projectRoot: string, parentId: string, childId: string, body: string): string {
  const file = path.join(cursorProjectsRoot, cursorProjectKey(projectRoot), 'agent-transcripts', parentId, 'subagents', `${childId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: body }] },
  }) + '\n', 'utf8');
  return file;
}

test('resolveRunAgentContext binds Cursor child writes from the local subagent transcript cache', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = '8a93bb38-0503-4c9a-ab15-fec68978ad1b';
      const childId = '8602964e-64f8-4b29-94d6-6836622a27b0';
      const state = { ...materializedState(), currentRunId: 'run-cursor-child' };
      ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: parentId }, { toolName: 'Task' });
      recordRunAgent(dir, 'run-cursor-child', 'senior-frontend', {
        agentId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
        toolCallId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        'You are senior-frontend for DevLearn. Read .traffic-one/runs/run-cursor-child/assignments.json and write only your scope.');

      const ctx = resolveRunAgentContext(dir, state, {
        conversation_id: childId,
        session_id: childId,
        workspace_roots: [dir],
        transcript_path: null,
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
      }, { claimPending: true });

      assert.ok(ctx, 'Cursor child write should resolve instead of being treated as main agent');
      assert.equal(ctx!.role, 'senior-frontend');
      assert.equal(ctx!.sessionId, childId);
      assert.equal(ctx!.spawnIndex, 1, 'the child consumes the existing pending spawn claim');
      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-child', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);

      const entry = readRunAgentRegistry(dir, 'run-cursor-child')['senior-frontend'];
      assert.ok(entry, 'child bind should mirror the resumable Cursor conversation id into agents.json');
      assert.equal(entry!.agentId, childId);
      assert.equal(entry!.resumeId, childId);
      assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
      assert.equal(continuationAgentId(entry!, 'cursor'), childId);

      const again = resolveRunAgentContext(dir, state, { session_id: childId }, { claimPending: false });
      assert.equal(again?.role, 'senior-frontend');
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('Cursor child bind prefers the matching exact-model pending claim and clears stale siblings', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = 'ab2a10f9-9117-4e8d-83c2-b15bebe7b08d';
      const childId = '91535f31-5c62-4e8b-acce-5ccff7439d22';
      const state = { ...materializedState(), currentRunId: 'run-cursor-model' };
      const stale = ensureRunAgentClaim(dir, state, 'senior-architect', { session_id: parentId }, {
        toolName: 'Task',
        model: 'claude-opus-4-8',
      });
      const exact = ensureRunAgentClaim(dir, state, 'senior-architect', { session_id: parentId }, {
        toolName: 'Task',
        model: 'claude-opus-4-8-thinking-medium',
      });
      recordRunAgent(dir, 'run-cursor-model', 'senior-architect', {
        agentId: 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a',
        toolCallId: 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        '[t1-role: senior-architect]\nArchitect learning platform plan.');

      const ctx = resolveRunAgentContext(dir, state, {
        conversation_id: childId,
        session_id: childId,
        workspace_roots: [dir],
        model: 'claude-opus-4-8-thinking-medium',
        transcript_path: null,
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
      }, { claimPending: true });

      assert.ok(ctx);
      assert.equal(ctx!.role, 'senior-architect');
      assert.equal(ctx!.spawnIndex, 2, 'the successful exact-model retry claim wins over the older family claim');
      assert.notEqual(stale?.claimId, exact?.claimId);
      assert.equal(ctx!.claimId, exact?.claimId);

      const claimed = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'run-cursor-model', `${childId}.json`), 'utf8'));
      assert.equal(claimed.model, 'claude-opus-4-8-thinking-medium');
      assert.equal(claimed.claimId, exact?.claimId);

      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-model', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);

      const entry = readRunAgentRegistry(dir, 'run-cursor-model')['senior-architect'];
      assert.equal(entry?.agentId, childId);
      assert.equal(entry?.resumeId, childId);
      assert.equal(entry?.toolCallId, 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a');
      assert.equal(entry?.model, 'claude-opus-4-8-thinking-medium');
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('refreshCursorRunAgentFromTranscriptCache upgrades read-only Cursor agents before they write', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = '8a93bb38-0503-4c9a-ab15-fec68978ad1b';
      const childId = 'e391ca30-0b3d-4bba-896d-431c4b49f405';
      const state = { ...materializedState(), currentRunId: 'run-cursor-reviewer' };
      ensureRunAgentClaim(dir, state, 'senior-reviewer', { session_id: parentId }, { toolName: 'Task' });
      recordRunAgent(dir, 'run-cursor-reviewer', 'senior-reviewer', {
        agentId: 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd',
        toolCallId: 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        '[t1-role: senior-reviewer]\nReview the implementation and write only a digest.');

      const upgraded = refreshCursorRunAgentFromTranscriptCache(dir, state, {
        session_id: parentId,
        workspace_roots: [dir],
      }, 'run-cursor-reviewer', 'senior-reviewer', parentId);

      assert.ok(upgraded, 'expected the real Cursor child id to be discovered');
      assert.equal(upgraded!.agentId, childId);
      assert.equal(upgraded!.resumeId, childId);
      assert.equal(upgraded!.toolCallId, 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd');
      assert.equal(continuationAgentId(upgraded!, 'cursor'), childId);
      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-reviewer', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('recordRunAgent: Cursor tool_* id is stored separately from Task resume UUID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-resume-id-'));
  try {
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
      toolCallId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
      model: 'composer-2.5-fast',
      agentType: 'senior-frontend',
      parentSessionId: 'parent-1',
    });
    let entry = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.ok(entry);
    assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
    assert.equal(entry!.resumeId, null);
    assert.equal(continuationAgentId(entry!, 'cursor'), '');

    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
      resumeId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
      parentSessionId: 'parent-1',
    });
    entry = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.equal(entry!.resumeId, 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
    assert.equal(entry!.agentId, 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
    assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
    assert.equal(entry!.model, 'composer-2.5-fast');
    assert.equal(entry!.agentType, 'senior-frontend');
    assert.equal(entry!.parentSessionId, 'parent-1');
    assert.equal(entry!.tasks, 2);
    assert.equal(continuationAgentId(entry!, 'cursor'), 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRunAgent preserves replacement history while keeping the live role slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agent-history-'));
  try {
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'agent-old',
      parentSessionId: 'parent-1',
      model: 'old-model',
    });
    markRunAgentReplaced(dir, 'run-1', 'senior-frontend');
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'agent-new',
      parentSessionId: 'parent-1',
      model: 'new-model',
    });

    const live = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.equal(live?.agentId, 'agent-new');
    assert.equal(live?.replaced, false);
    assert.equal(live?.tasks, 1);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'run-1', 'agents.json'), 'utf8'));
    assert.equal(raw.history.length, 1);
    assert.equal(raw.history[0].role, 'senior-frontend');
    assert.equal(raw.history[0].oldAgentId, 'agent-old');
    assert.equal(raw.history[0].newAgentId, 'agent-new');
    assert.equal(raw.history[0].replacementReason, 'explicit-replace-agent-marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
