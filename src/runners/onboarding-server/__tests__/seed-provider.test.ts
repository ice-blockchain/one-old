import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { seedGlobalCodeGraphProviderIfInstalled } from '../seed-provider';
import { nextOnboardingStep } from '../../../shared/onboarding/prompts';
import { readGlobalCodeGraphProvider, writeGlobalCodeGraphProvider } from '../../../shared/state';
import { initializeToolchainState } from '../../../shared/state/toolchain';

const TOOLCHAIN = Object.fromEntries(
  Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]),
);

function nearCompleteNewProject(provider?: string): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    openCode: { enabled: false, source: 'prompted' },
    openCodeDelegation: { approved: false },
    ...(provider ? { codeGraphProvider: provider } : {}),
    team: { mode: 'subagents', source: 'prompted', approved: true },
    performance: { level: 'high', source: 'prompted' },
    toolchain: TOOLCHAIN,
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  };
}

// Isolate every input the detection reads so the result is deterministic on any
// machine: the global store (one.json), the per-project prefs (stamp target), the
// managed-toolchain root, PATH (which() scans it), and HOME (findNvmNode22 globs
// ~/.nvm). With HOME pointing at an empty dir, nvm-based detection is disabled.
function withSeedEnv(searchPath: string, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-seed-'));
  const env = process.env;
  const saved = {
    path: env.PATH, home: env.HOME, root: env.TRAFFIC_ONE_TOOLCHAIN_ROOT,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, state: env.TRAFFIC_ONE_STATE_PATH,
  };
  env.HOME = path.join(dir, 'home'); // empty → findNvmNode22() === null
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed'); // no managed bins
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.PATH = searchPath;
  try {
    fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      PATH: saved.path, HOME: saved.home, TRAFFIC_ONE_TOOLCHAIN_ROOT: saved.root,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs, TRAFFIC_ONE_STATE_PATH: saved.state,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeBin(dir: string, name: string, versionLine: string): void {
  fs.writeFileSync(
    path.join(dir, name),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; fi\nexit 0\n`,
    { mode: 0o755 },
  );
}

test('seed: an already-set global provider short-circuits (no probing, no write needed)', () => {
  withSeedEnv('', (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    assert.equal(seedGlobalCodeGraphProviderIfInstalled(cwd), 'gitnexus');
    assert.equal(readGlobalCodeGraphProvider(), 'gitnexus');
  });
});

test('seed: nothing installed → returns null and leaves the global unset', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 't1-emptypath-'));
  try {
    withSeedEnv(empty, (cwd) => {
      assert.equal(seedGlobalCodeGraphProviderIfInstalled(cwd), null);
      assert.equal(readGlobalCodeGraphProvider(), null);
    });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('seed: an installed graphify binary is detected, one.json stays unset, step still code-graph', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-seedbin-'));
  fakeBin(binDir, 'graphify', 'graphify 0.9.13');
  try {
    withSeedEnv(binDir, (cwd) => {
      assert.equal(seedGlobalCodeGraphProviderIfInstalled(cwd), 'graphify');
      assert.equal(readGlobalCodeGraphProvider(), null);
      const state = nearCompleteNewProject(readGlobalCodeGraphProvider() ?? undefined);
      assert.equal(nextOnboardingStep(state), 'code-graph');
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('seed: both gitnexus and graphify on PATH → detect gitnexus, no auto-write', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-seedboth-'));
  fakeBin(binDir, 'gitnexus', 'gitnexus 1.6.9');
  fakeBin(binDir, 'graphify', 'graphify 0.9.13');
  try {
    withSeedEnv(binDir, (cwd) => {
      assert.equal(seedGlobalCodeGraphProviderIfInstalled(cwd), 'gitnexus');
      assert.equal(readGlobalCodeGraphProvider(), null);
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
