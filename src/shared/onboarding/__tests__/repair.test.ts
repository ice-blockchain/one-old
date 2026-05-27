import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { canRepairNewProjectOnboardingState, repairNewProjectOnboardingState } from '../repair';
import { initializeToolchainState } from '../../state/toolchain';

const TOOLCHAIN = Object.fromEntries(
  Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]),
);

function complete(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    openCode: { enabled: false, source: 'prompted' },
    codeGraphProvider: 'graphify',
    team: { mode: 'subagents', source: 'prompted', approved: true },
    performance: { level: 'high', source: 'prompted' },
    toolchain: TOOLCHAIN,
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

test('canRepairNewProjectOnboardingState: a complete-but-canonical state is repairable', () => {
  assert.equal(canRepairNewProjectOnboardingState(complete()), true);
});

test('canRepairNewProjectOnboardingState: rejects incomplete / unconfirmed / non-onboarded', () => {
  assert.equal(canRepairNewProjectOnboardingState(complete({ onboardingComplete: false })), false);
  assert.equal(canRepairNewProjectOnboardingState(complete({ confirmed: false })), false);
  assert.equal(canRepairNewProjectOnboardingState(complete({ codeGraphProvider: undefined })), false);
  assert.equal(canRepairNewProjectOnboardingState(complete({ team: { mode: 'main-agent', source: 'prompted' } })), false); // high needs subagents
  assert.equal(canRepairNewProjectOnboardingState(null), false);
});

test('repairNewProjectOnboardingState returns null when the state is not repairable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-repair-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    assert.equal(repairNewProjectOnboardingState(dir, complete({ onboardingComplete: false }), 'unit'), null);
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
