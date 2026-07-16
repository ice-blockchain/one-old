import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findAuthoringRootContaining,
  hasPluginAuthoringMarkers,
  isInsidePluginAuthoringRoot,
  isMachineConfigRoot,
  isNonProjectRoot,
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

test('exact system-temp roots are machine-config space; temp SUBDIRS stay eligible (B7)', () => {
  // A stray .traffic-one minted into /tmp-family roots must never make them
  // adoptable project roots (the stale-bootstrap incident) — but real/test
  // projects in a temp SUBDIRECTORY are unaffected.
  assert.equal(isMachineConfigRoot(os.tmpdir()), true);
  assert.equal(isMachineConfigRoot('/tmp'), true);
  if (fs.existsSync('/private/tmp')) assert.equal(isMachineConfigRoot('/private/tmp'), true);
  if (fs.existsSync('/var/tmp')) assert.equal(isMachineConfigRoot('/var/tmp'), true);
  withTmp((dir) => {
    assert.equal(isMachineConfigRoot(dir), false);
    assert.equal(isMachineConfigRoot(path.join(dir, 'nested')), false);
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
  const userState = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-user-state-'));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(userState, 'projects', 'preferences.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(userState, 'one.json');
  try {
    withTmp((dir) => {
      makeSourceRepo(dir);
      writeState(dir, { mode: 'existing-codebase', stack: 'minimal' });
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false, 'no .traffic-one in the repo');
    });
    withTmp((dir) => {
      writeState(dir, { mode: 'existing-codebase', stack: 'minimal' });
      assert.equal((readState(dir) as Record<string, unknown>).mode, 'existing-codebase', 'plain projects still write');
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'preferences.json')), false, 'plain projects never receive private preferences');
    });
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    fs.rmSync(userState, { recursive: true, force: true });
  }
});

test('prepareReport refuses an authoring root before minting anything', async () => {
  const { prepareReport } = await import('../../runners/one-mcp-report/prepareReport');
  withTmp((dir) => {
    makeSourceRepo(dir);
    const result = prepareReport(dir, { spawn: false });
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

test('machine-config space is never a project root: $HOME, /, and the machine state dir', () => {
  withTmp((dir) => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.traffic-one', 'projects'), { recursive: true });
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
    try {
      assert.equal(isMachineConfigRoot(home), true); // $HOME itself
      assert.equal(isMachineConfigRoot(path.parse(home).root), true); // filesystem root
      assert.equal(isMachineConfigRoot(path.join(home, '.traffic-one')), true);
      assert.equal(isMachineConfigRoot(path.join(home, '.traffic-one', 'projects')), true);
      assert.equal(isNonProjectRoot(home), true);
      // A normal project under home stays a valid project root.
      const project = path.join(home, 'work', 'app');
      fs.mkdirSync(project, { recursive: true });
      assert.equal(isMachineConfigRoot(project), false);
      assert.equal(isNonProjectRoot(project), false);
      // An XDG override moves the machine dir — guarded at the new location too.
      process.env.XDG_STATE_HOME = path.join(dir, 'xdg');
      assert.equal(isMachineConfigRoot(path.join(dir, 'xdg', 'traffic-one', 'rules')), true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    }
  });
});

test('isNonProjectRoot covers the authoring repo exactly like isPluginAuthoringRoot', () => {
  withTmp((dir) => {
    makeSourceRepo(dir);
    assert.equal(isNonProjectRoot(dir), true);
    assert.equal(isNonProjectRoot(path.join(dir, 'src')), true);
  });
});
