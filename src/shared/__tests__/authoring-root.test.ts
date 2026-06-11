import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findAuthoringRootContaining,
  hasPluginAuthoringMarkers,
  isInsidePluginAuthoringRoot,
  isPluginAuthoringRoot,
  resetAuthoringRootCache,
} from '../authoring-root';

function makeSourceRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), '// gen', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
}

function makeGeneratedTree(base: string): void {
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'scripts', 'hook-runtime.cjs'), '// runtime', 'utf8');
  fs.writeFileSync(path.join(base, 'scripts', 'traffic-one-auth.cjs'), '// auth', 'utf8');
  fs.mkdirSync(path.join(base, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(base, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
}

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-'));
  resetAuthoringRootCache();
  try {
    fn(fs.realpathSync(dir));
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('source-repo markers detect the root AND any subdirectory/file inside it', () => {
  withTmp((dir) => {
    makeSourceRepo(dir);
    assert.equal(hasPluginAuthoringMarkers(dir), true);
    assert.equal(isPluginAuthoringRoot(dir), true);

    // Subdirectory cwd (the Codex-in-one/src case) walks up to the repo.
    const sub = path.join(dir, 'src', 'modules', 'session');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(isPluginAuthoringRoot(sub), true);
    assert.equal(findAuthoringRootContaining(path.join(sub, 'handler.ts')), dir);
    assert.equal(isInsidePluginAuthoringRoot(path.join(dir, '.traffic-one', '.one.json')), true);
  });
});

test('generated plugin tree (dist layout + installed layout) detects', () => {
  withTmp((dir) => {
    makeGeneratedTree(path.join(dir, 'dist'));
    assert.equal(isPluginAuthoringRoot(dir), true);
  });
  withTmp((dir) => {
    makeGeneratedTree(dir); // installed plugin / legacy root layout
    assert.equal(isPluginAuthoringRoot(path.join(dir, 'skills-catalog')), true);
  });
});

test('end-user projects are never authoring roots — even with Traffic One state', () => {
  withTmp((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', stack: 'minimal' }), 'utf8');
    assert.equal(isPluginAuthoringRoot(dir), false);
    assert.equal(findAuthoringRootContaining(path.join(dir, 'src', 'app.ts')), null);
  });
});

test('a stray onboarded state file INSIDE the authoring repo still detects as authoring', () => {
  withTmp((dir) => {
    makeSourceRepo(dir);
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    assert.equal(isPluginAuthoringRoot(dir), true);
  });
});

test('the real repo detects (root and subdir)', () => {
  const repo = path.resolve(__dirname, '..', '..', '..');
  resetAuthoringRootCache();
  assert.equal(isPluginAuthoringRoot(repo), true);
  assert.equal(isPluginAuthoringRoot(path.join(repo, 'src', 'shared')), true);
  resetAuthoringRootCache();
});

// ── Choke-point contracts: state/report/claims/wizard writers refuse the repo ──

test('writeState is a silent no-op at an authoring root (and still writes elsewhere)', async () => {
  const { writeState, readState } = await import('../state');
  withTmp((dir) => {
    makeSourceRepo(dir);
    writeState(dir, { mode: 'existing-codebase', stack: 'minimal' });
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false, 'no .traffic-one in the repo');
  });
  withTmp((dir) => {
    writeState(dir, { mode: 'existing-codebase', stack: 'minimal' });
    assert.equal((readState(dir) as Record<string, unknown>).mode, 'existing-codebase', 'plain projects still write');
  });
});

test('prepareReport refuses an authoring root before minting anything', async () => {
  const { prepareReport } = await import('../../runners/one-mcp-report/prepareReport');
  withTmp((dir) => {
    makeSourceRepo(dir);
    const result = prepareReport(dir, { spawn: false, allowUnauthenticated: true });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'plugin-authoring-root');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);
  });
});

test('run claims refuse an authoring root', async () => {
  const { ensureRunAgentClaim, claimThreadRole, tryFallbackClaim } = await import('../state');
  withTmp((dir) => {
    makeSourceRepo(dir);
    assert.equal(ensureRunAgentClaim(dir, { currentRunId: 'r1' }, 'senior-frontend', {}), null);
    assert.equal(claimThreadRole(dir, { currentRunId: 'r1' }, 'thread-1', 'senior-frontend'), null);
    const fallback = tryFallbackClaim(dir, { runId: 'r1', role: 'senior-frontend', sessionId: 's1' } as never, 'src/x.ts');
    assert.deepEqual(fallback, { blocked: false });
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);
  });
});

test('onboarding server refuses an authoring root (no spawn, no launch.json)', async () => {
  const { ensureOnboardingServer } = await import('../onboarding-server/ensure');
  withTmp((dir) => {
    makeSourceRepo(dir);
    const result = ensureOnboardingServer(dir, { env: { ...process.env } });
    assert.equal(result.port, 0);
    assert.equal(result.started, false);
    assert.equal(fs.existsSync(path.join(dir, '.claude', 'launch.json')), false);
  });
});
