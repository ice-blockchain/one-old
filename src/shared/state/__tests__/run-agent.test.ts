import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { claimThreadRole, ensureRunAgentClaim, inferRoleFromTranscript, resolveRunAgentContext, runIdNow, transcriptThreadId } from '../run-agent';
import { stackFingerprint } from '../materialization';

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
