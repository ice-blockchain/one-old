import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runSessionStart, runSessionStartAuthed } from '../session-start';
import type { Ctx, HookInput } from '../../../core/types';

function ctx(cwd: string): Ctx {
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: {} };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// A temp project with isolated prefs. The post-auth body (runSessionStartAuthed)
// needs no auth — SessionStart's forced remote probe is tested separately.
function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sstart-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runSessionStart is a noop in the plugin authoring root (before any auth probe)', () => {
  assert.equal(runSessionStart(ctx(process.cwd())).kind, 'noop');
});

test('Flow 3: a new project gets the first-run onboarding directive + baseline rules', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('FIRST-RUN ONBOARDING (new project)'));
      assert.ok(r.context.includes('Baseline rules'));
    }
  });
});

test('Flow 1: an onboarded minimal project gets the packed rule bundle header', () => {
  withProject({
    mode: 'existing-codebase', stack: 'minimal', frontend: 'none', backend: 'other',
    realtime: 'none', confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  }, (cwd) => {
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('stack: minimal'));
      assert.ok(r.context.includes('mode: existing-codebase'));
    }
  });
});

test('Flow 2: an existing codebase with no state auto-detects a stack + announces it', () => {
  withProject(null, (cwd) => {
    // package.json marker → detectMode → existing-codebase path; no .one.json.
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }), 'utf8');
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes('auto-detected') || r.context.includes('stack:'));
  });
});
