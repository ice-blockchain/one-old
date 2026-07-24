import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { maintenanceTriageDirective } from '../triage-directive';
import { runModelPolicyPath } from '../../../shared/run-model-policy';
import { currentHostModelTarget } from '../../../shared/current-model-tiers';
import type { Rec } from '../../../shared/obj';

// The maintenance triage directive starts a FRESH run (rotates currentRunId,
// clears spawnIndex) for a new request in subagents mode — but it must NEVER do so
// while the CURRENT orchestrated run is still live (assignments exist, no terminal
// verdict). Rotating then splits run state across two ids and the run-id gate
// resolves no scope for the in-flight role spawns. (The 2026-06-17 tests/9a bug.)

function setup(opts: { reviewer?: string; tester?: string; shipper?: boolean; assignments?: boolean; rolesAssignments?: boolean; orchestratorStamped?: boolean; completedAt?: string }): { dir: string; state: Rec } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-triage-'));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Rec = {
    mode: 'new-project',
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
    lifecycle: { phase: 'maintenance', source: opts.orchestratorStamped ? 'orchestrator' : 'heuristic', completedAt: opts.completedAt || new Date().toISOString() },
    team: { mode: 'subagents', approved: true },
    currentRunId: 'OLD',
    spawnIndex: { 'senior-frontend': 1, 'senior-backend': 1 },
  };
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
  if (opts.assignments || opts.rolesAssignments) {
    const rd = path.join(dir, '.traffic-one', 'runs', 'OLD');
    fs.mkdirSync(rd, { recursive: true });
    const manifest = opts.rolesAssignments
      // the non-conforming `roles` schema some orchestrators emit (gpt-5.5)
      ? { runId: 'OLD', roles: { 'senior-frontend': { ownedPaths: ['apps/web/**'] } } }
      : { version: 1, runId: 'OLD', assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/**'] } }] };
    fs.writeFileSync(path.join(rd, 'assignments.json'), JSON.stringify(manifest));
  }
  if (opts.reviewer || opts.tester || opts.shipper) {
    const dd = path.join(dir, '.traffic-one', 'digests', 'OLD');
    fs.mkdirSync(dd, { recursive: true });
    if (opts.reviewer) fs.writeFileSync(path.join(dd, 'reviewer.md'), `# reviewer\nverdict: ${opts.reviewer}\n`);
    if (opts.tester) fs.writeFileSync(path.join(dd, 'tester.md'), `# tester\nverdict: ${opts.tester}\n`);
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nverdict: SHIPPED\nurl: https://app.example\n');
    if (opts.tester === 'TESTS_GREEN') {
      const memoryDir = '.traffic' + '-one';
      const qaDir = path.join(dir, memoryDir, 'reports', 'qa', 'OLD');
      fs.mkdirSync(qaDir, { recursive: true });
      fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }), 'utf8');
    }
  }
  return { dir, state };
}

function cleanup(dir: string): void {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

const PROMPT = 'change the hero headline to Welcome';

function writeFreshClaim(dir: string, role = 'senior-frontend'): void {
  const runDir = path.join(dir, '.traffic-one', 'runs', 'OLD');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'kilo-leftover.json'), JSON.stringify({
    version: 1,
    runId: 'OLD',
    role,
    status: 'claimed',
    sessionId: 'kilo-child',
    createdAt: new Date().toISOString(),
  }));
}

test('does NOT rotate currentRunId while the current run is live (assignments + non-terminal reviewer)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'run-id must not rotate while the run is unsettled');
    assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 }, 'spawnIndex must not be cleared');
  } finally {
    cleanup(dir);
  }
});

test('does NOT rotate while a live run carries the non-conforming `roles` manifest (schema-agnostic guard)', () => {
  // The gpt-5.5 deviation: assignments.json uses a `roles` object. The guard must STILL
  // see the run (via raw artifact existence) and refuse to rotate while it is unsettled.
  const { dir, state } = setup({ rolesAssignments: true, reviewer: 'CHANGES_REQUESTED' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'a non-conforming manifest must not defeat the guard');
  } finally {
    cleanup(dir);
  }
});

test('a stale orchestrator lifecycle stamp does NOT green-light rotating a LATER live run', () => {
  // Regression guard: `lifecycle.source==='orchestrator'` is stamped once at the first
  // build and never reset. A 2nd maintenance feature that is mid-fix-cycle (CHANGES_REQUESTED)
  // must STILL be protected — the persistent stamp must not allow rotating it (would split).
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', orchestratorStamped: true });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'a live run is not rotated just because the project was orchestrator-stamped earlier');
  } finally {
    cleanup(dir);
  }
});

test('does NOT rotate while the run is live with a tester still TESTS_FAILING', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_FAILING' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

test('rotates currentRunId once the current run terminally settled (APPROVED + TESTS_GREEN)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD', 'run-id should rotate for a fresh maintenance run');
    assert.match(String(state.currentRunId), /^\d{13}$/);
    assert.deepEqual(state.spawnIndex, {}, 'spawnIndex cleared for the fresh run');
  } finally {
    cleanup(dir);
  }
});

test('rotation releases the settled run\'s claims (terminal sweep)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN' });
  // A build-time claim: created BEFORE the completion watermark (so it does not
  // suppress triage) but still fresh on disk — the 3c end-state shape.
  const claimFile = path.join(dir, '.traffic-one', 'runs', 'OLD', 'child9.json');
  fs.writeFileSync(claimFile, JSON.stringify({
    version: 1, runId: 'OLD', claimId: 'senior-frontend-1-z', role: 'senior-frontend',
    status: 'claimed', sessionId: 'child9',
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }));
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD');
    const released = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(released.status, 'released');
    assert.equal(released.releasedReason, 'run-rotated');
  } finally {
    cleanup(dir);
  }
});

test('rotates when there is no orchestrated run (no assignments) — common maintenance edit', () => {
  const { dir, state } = setup({});
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD', 'a plain maintenance edit with no orchestrated run still rotates');
    assert.match(String(state.currentRunId), /^\d{13}$/);
  } finally {
    cleanup(dir);
  }
});

test('F3: a rotated maintenance run freezes model-policy at mint (first followup is not denied)', () => {
  const { dir, state } = setup({});
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  // The MERGED state must carry the acknowledged catalog (readState strips
  // performance as a host pref, so beginFreshMaintenanceRun freezes off the
  // passed-in state, matching the build-run handler's effectiveState).
  const target = currentHostModelTarget('codex', 'pro', process.env);
  state.performance = {
    level: 'high',
    source: 'prompted',
    target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
  };
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'codex');
    assert.notEqual(state.currentRunId, 'OLD', 'a fresh maintenance run should rotate');
    assert.ok(fs.existsSync(runModelPolicyPath(dir, String(state.currentRunId))),
      'the maintenance run must freeze its model-policy at mint so the first followup_task is not denied on a missing policy');
  } finally {
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    cleanup(dir);
  }
});

test('F3: maintenance rotation stays best-effort when the model policy cannot be frozen', () => {
  // No performance level in state → buildRunModelPolicy returns null; the freeze
  // must no-op WITHOUT throwing, and the run must still rotate + route.
  const { dir, state } = setup({});
  try {
    let directive = '';
    assert.doesNotThrow(() => { directive = maintenanceTriageDirective(dir, state, PROMPT, {}, 'codex'); });
    assert.notEqual(state.currentRunId, 'OLD', 'rotation still happens even if the policy freeze no-ops');
    assert.ok(directive.length > 0, 'triage must still return its routing directive');
  } finally {
    cleanup(dir);
  }
});

test('Kilo prompt boundary bypasses stale claim suppression but preserves a nonterminal run id', () => {
  // Kilo does not emit a role-completion/resume event. Its completed task claims
  // therefore remain fresh after the initial build. A new chat.message may bypass
  // that stale claim, but a nonterminal verdict still requires the same run id.
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', completedAt });
  try {
    writeFreshClaim(dir);
    const directive = maintenanceTriageDirective(dir, state, 'create a new page named news', { session_id: 'kilo-parent' }, 'kilo');
    assert.equal(state.currentRunId, 'OLD', 'unresolved verification retains the same run even at a Kilo boundary');
    assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 }, 'existing role indexes remain resumable');
    assert.match(directive, /MAINTENANCE PHASE/);
    assert.match(directive, /Keyword hint: small/);
    assert.match(directive, /Do NOT spawn `senior-architect`/);
  } finally {
    cleanup(dir);
  }
});

test('runtime-control prompts bypass maintenance workers and do not rotate the run', () => {
  for (const prompt of [
    'start the dev server',
    'stop the preview server',
    'restart the local server',
    'restart the Vite dev server',
    'check port 5173',
    'check process 123456',
    'what process is listening on port 3000',
    'show me the local server logs',
    'show the logs for the Vite dev server',
  ]) {
    const { dir, state } = setup({});
    try {
      const directive = maintenanceTriageDirective(dir, state, prompt, { session_id: 'parent' }, 'claude');
      assert.equal(directive, '', `parent should handle runtime command: ${prompt}`);
      assert.equal(state.currentRunId, 'OLD', 'runtime commands do not mint maintenance runs');
      assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 });
    } finally {
      cleanup(dir);
    }
  }
});

test('server implementation near-misses still use normal maintenance routing', () => {
  for (const prompt of [
    'fix the server startup error',
    'change the server config',
    'add an endpoint',
    'restart the Vite dev server and change its config',
  ]) {
    const { dir, state } = setup({});
    try {
      const directive = maintenanceTriageDirective(dir, state, prompt, { session_id: 'parent' }, 'claude');
      assert.match(directive, /MAINTENANCE PHASE/, `implementation prompt should route: ${prompt}`);
      assert.notEqual(state.currentRunId, 'OLD', 'normal maintenance work gets its own run');
    } finally {
      cleanup(dir);
    }
  }
});

test('active claims still suppress triage on resumable hosts', () => {
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', completedAt });
  try {
    writeFreshClaim(dir);
    const directive = maintenanceTriageDirective(dir, state, 'create a new page named news', { session_id: 'cursor-parent' }, 'cursor');
    assert.equal(directive, '', 'Cursor keeps its live role session instead of splitting the active run');
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});
