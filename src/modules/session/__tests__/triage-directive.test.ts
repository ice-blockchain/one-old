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

function setup(opts: { reviewer?: string; tester?: string; shipper?: boolean; assignments?: boolean }): { dir: string; state: Rec } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-triage-'));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Rec = {
    mode: 'new-project',
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
    lifecycle: { phase: 'maintenance', source: 'heuristic', completedAt: new Date().toISOString() },
    team: { mode: 'subagents', approved: true },
    currentRunId: 'OLD',
    spawnIndex: { 'senior-frontend': 1, 'senior-backend': 1 },
  };
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
  if (opts.assignments) {
    const rd = path.join(dir, '.traffic-one', 'runs', 'OLD');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'assignments.json'), JSON.stringify({
      version: 1, runId: 'OLD', assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/**'] } }],
    }));
  }
  if (opts.reviewer || opts.tester || opts.shipper) {
    const dd = path.join(dir, '.traffic-one', 'digests', 'OLD');
    fs.mkdirSync(dd, { recursive: true });
    if (opts.reviewer) fs.writeFileSync(path.join(dd, 'reviewer.md'), `# reviewer\nverdict: ${opts.reviewer}\n`);
    if (opts.tester) fs.writeFileSync(path.join(dd, 'tester.md'), `# tester\nverdict: ${opts.tester}\n`);
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nurl: https://app.example\n');
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
