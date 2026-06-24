import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { maintenanceTriageDirective } from '../triage-directive';
import type { Rec } from '../../../shared/obj';

// The maintenance triage directive starts a FRESH run (rotates currentRunId,
// clears spawnIndex) for a new request in subagents mode — but it must NEVER do so
// while the CURRENT orchestrated run is still live (assignments exist, no terminal
// verdict). Rotating then splits run state across two ids and the run-id gate
// resolves no scope for the in-flight role spawns. (The 2026-06-17 tests/9a bug.)

function setup(opts: { reviewer?: string; tester?: string; shipper?: boolean; assignments?: boolean; rolesAssignments?: boolean; orchestratorStamped?: boolean }): { dir: string; state: Rec } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-triage-'));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Rec = {
    mode: 'new-project',
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
    lifecycle: { phase: 'maintenance', source: opts.orchestratorStamped ? 'orchestrator' : 'heuristic', completedAt: new Date().toISOString() },
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
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nurl: https://app.example\n');
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
