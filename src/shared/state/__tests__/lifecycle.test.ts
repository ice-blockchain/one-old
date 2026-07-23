import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isMaintenancePhase, maintenanceLifecycle, markMaintenance, projectPhase } from '../lifecycle';
import { readState, statePath } from '../normalize';

test('projectPhase infers maintenance for any existing-* mode and building for new-project', () => {
  assert.equal(projectPhase({ mode: 'existing-codebase' }), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-with-supabase' }), 'maintenance');
  assert.equal(projectPhase({ mode: 'new-project' }), 'building');
  assert.equal(projectPhase({}), 'building');
  // explicit mode argument takes precedence over state.mode for inference
  assert.equal(projectPhase({}, 'existing-codebase'), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-codebase' }, 'new-project'), 'building');
});

test('explicit lifecycle.phase overrides mode inference', () => {
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: 'maintenance' } }), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-codebase', lifecycle: { phase: 'building' } }), 'building');
});

test('projectPhase is tolerant of hand-edited casing/whitespace, falls back on garbage', () => {
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: '  Maintenance ' } }), 'maintenance');
  // invalid phase value → fall back to mode inference, not a crash
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: 'bogus' } }), 'building');
  assert.equal(projectPhase({ mode: 'existing-codebase', lifecycle: 'nope' }), 'maintenance');
});

test('isMaintenancePhase mirrors projectPhase', () => {
  assert.equal(isMaintenancePhase({ mode: 'existing-codebase' }), true);
  assert.equal(isMaintenancePhase({ mode: 'new-project' }), false);
  assert.equal(isMaintenancePhase({ mode: 'new-project', lifecycle: { phase: 'maintenance' } }), true);
});

test('maintenanceLifecycle builds a canonical stamped object', () => {
  const lc = maintenanceLifecycle('orchestrator');
  assert.equal(lc.phase, 'maintenance');
  assert.equal(lc.source, 'orchestrator');
  assert.equal(typeof lc.completedAt, 'string');
  assert.ok((lc.completedAt as string).length > 0);
});

test('markMaintenance persists the flag and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-lifecycle-'));
  const prefs = path.join(dir, 'prefs.json');
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none', currentRunId: 'run-flip' }));
    const claimFile = path.join(dir, '.traffic-one', 'runs', 'run-flip', 'child1.json');
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(claimFile, JSON.stringify({
      version: 1, runId: 'run-flip', claimId: 'senior-frontend-1-a', role: 'senior-frontend',
      status: 'claimed', createdAt: new Date().toISOString(), sessionId: 'child1',
    }), 'utf8');

    assert.equal(projectPhase(readState(dir), 'new-project'), 'building');

    assert.equal(markMaintenance(dir, 'heuristic'), true);
    // The flip sweeps the settled run's claims: claimed → released.
    const releasedClaim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(releasedClaim.status, 'released');
    assert.equal(releasedClaim.releasedReason, 'maintenance-flip');
    const after = readState(dir);
    assert.equal(projectPhase(after, after.mode), 'maintenance');
    const lifecycle = after.lifecycle as Record<string, unknown>;
    assert.equal(lifecycle.phase, 'maintenance');
    assert.equal(lifecycle.source, 'heuristic');

    // a second heuristic call is a no-op…
    assert.equal(markMaintenance(dir, 'heuristic'), false);
    // …but the orchestrator source refreshes the completion watermark, so a
    // finished maintenance run does not suppress triage behind stale claims
    assert.equal(markMaintenance(dir, 'orchestrator'), true);
    const refreshed = readState(dir).lifecycle as Record<string, unknown>;
    assert.equal(refreshed.source, 'orchestrator');
    assert.equal(markMaintenance(dir, 'heuristic'), false);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
