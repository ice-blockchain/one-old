import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { maybeFlipToMaintenance } from '../build-complete';
import { projectPhase, readState } from '../../../shared/state';

const prefsFile = path.join(os.tmpdir(), `to-bc-prefs-${process.pid}.json`);
let prevPrefs: string | undefined;
before(() => {
  prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsFile;
});
after(() => {
  if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
});

interface ProjectOpts { mode?: string; files?: number; digest?: boolean; claimFresh?: boolean; }

function mkproject(opts: ProjectOpts): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-build-complete-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: opts.mode ?? 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
  }));
  const files = opts.files ?? 0;
  if (files > 0) {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < files; i += 1) fs.writeFileSync(path.join(src, `f${i}.ts`), 'export const x = 1;\n');
  }
  if (opts.digest) {
    const dd = path.join(dir, '.traffic-one', 'digests', '123');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'architect.md'), '# plan\n');
  }
  if (opts.claimFresh) {
    const rd = path.join(dir, '.traffic-one', 'runs', '123');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'sess.json'), JSON.stringify({ role: 'senior-frontend', runId: '123', createdAt: new Date().toISOString() }));
  }
  return dir;
}

function run(dir: string): boolean {
  try {
    return maybeFlipToMaintenance(dir, readState(dir));
  } finally {
    // leave the dir for assertions; cleaned by the OS temp reaper
  }
}

test('no flip for an existing-codebase (heuristic is new-project only)', () => {
  const dir = mkproject({ mode: 'existing-codebase', files: 30, digest: true });
  assert.equal(run(dir), false);
});

test('no flip without an architect digest (orchestrator never planned a build)', () => {
  const dir = mkproject({ files: 30, digest: false });
  assert.equal(run(dir), false);
});

test('no flip while a subagent claim is still active (never mid-orchestration)', () => {
  const dir = mkproject({ files: 30, digest: true, claimFresh: true });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('no flip when the codebase has not produced real output yet', () => {
  const dir = mkproject({ files: 4, digest: true });
  assert.equal(run(dir), false);
});

test('flips to maintenance when every guard holds, and is idempotent', () => {
  const dir = mkproject({ files: 30, digest: true });
  assert.equal(run(dir), true);
  const state = readState(dir);
  assert.equal(projectPhase(state, 'new-project'), 'maintenance');
  assert.equal((state.lifecycle as Record<string, unknown>).source, 'heuristic');
  // second call: already maintenance → no-op
  assert.equal(run(dir), false);
});
