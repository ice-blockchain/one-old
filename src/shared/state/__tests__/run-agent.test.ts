import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { anyRunReachedTerminalVerdict, claimThreadRole, ensureRunAgentClaim, inferRoleFromTranscript, readRunAssignmentsResilient, resolveRunAgentContext, runIdNow, runReachedTerminalVerdict, transcriptThreadId } from '../run-agent';
import { stackFingerprint } from '../materialization';

function writeDigest(dir: string, runId: string, name: string, verdict: string): void {
  const d = path.join(dir, '.traffic-one', 'digests', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), `# ${name}\nverdict: ${verdict}\n`, 'utf8');
}

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
