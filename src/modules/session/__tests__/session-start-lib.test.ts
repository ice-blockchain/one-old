import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, shouldBuildCodeGraph, sweepOldDigests, tokenEconomyBanner } from '../session-start-lib';

function withTmp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sslib-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('shouldBuildCodeGraph: builds for existing project missing a graph; guards otherwise', () => {
  withTmp((cwd) => {
    const NOW = Date.parse('2026-06-08T12:00:00Z');
    const base = { mode: 'existing-codebase', codeGraphProvider: 'graphify' };
    // existing + provider + no artifact → build
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), true);
    // artifact present → skip
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# g', 'utf8');
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), false);
    fs.rmSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true, force: true });
    // cooldown via disk lock: recent attempt → skip; stale (>30min) → build again
    const lock = path.join(cwd, '.traffic-one', '.codegraph-build-lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '2026-06-08T11:50:00Z', 'utf8'); // 10 min ago
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), false);
    fs.writeFileSync(lock, '2026-06-08T11:00:00Z', 'utf8'); // 60 min ago
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), true);
    fs.rmSync(lock, { force: true });
    // new-project mode → never; no provider → never; auto-run off → never
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'new-project', codeGraphProvider: 'graphify' }, NOW), false);
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase' }, NOW), false);
    assert.equal(shouldBuildCodeGraph(cwd, { ...base, codeGraphAutoRun: false }, NOW), false);
    // gitnexus keys on .gitnexus/
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), true);
    fs.mkdirSync(path.join(cwd, '.traffic-one', '.gitnexus'), { recursive: true });
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), false);
  });
});

test('sweepOldDigests keeps the newest N digest runs', () => {
  withTmp((cwd) => {
    const digests = path.join(cwd, '.traffic-one', 'digests');
    for (const n of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      fs.mkdirSync(path.join(digests, n), { recursive: true });
    }
    assert.equal(sweepOldDigests(cwd, 2), 2); // removed the 2 oldest
    const remaining = fs.readdirSync(digests).sort();
    assert.deepEqual(remaining, ['2026-01-03', '2026-01-04']);
    // no digests dir → 0
    assert.equal(sweepOldDigests(path.join(cwd, 'nope'), 2), 0);
  });
});

test('readGraphPreview returns the preview content or empty string', () => {
  withTmp((cwd) => {
    assert.equal(readGraphPreview(cwd), '');
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graph-preview.md'), 'modules: a, b', 'utf8');
    assert.ok(readGraphPreview(cwd).includes('modules: a, b'));
  });
});

test('tokenEconomyBanner surfaces memory + graph hints, and toolchain drift via the probe', () => {
  withTmp((cwd) => {
    assert.equal(tokenEconomyBanner(cwd), ''); // nothing present
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'stack.md'), 'x', 'utf8');
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), 'g', 'utf8');
    const banner = tokenEconomyBanner(cwd);
    assert.ok(banner.includes('[memory]'));
    assert.ok(banner.includes('[graph: graphify]'));
    // a probe surfaces toolchain drift; without one, no [toolchain] line
    assert.ok(!banner.includes('[toolchain]'));
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ toolchain: { gitnexus: { installedVersion: '1.0.0' } } }), 'utf8');
    const probe = {
      toolStatus: () => ({ status: 'outdated', installed: '1.0.0', recommended: '2.0.0' }),
      getToolSpec: () => ({ installCommand: 'npm i -g gitnexus' }),
    };
    assert.ok(tokenEconomyBanner(cwd, probe).includes('[toolchain] gitnexus 1.0.0 installed; recommended is 2.0.0'));
  });
});

test('ensureSessionMaterialization no-ops for incomplete / already-current state', () => {
  withTmp((cwd) => {
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: false }), false);
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: true, stack: 'not-a-stack' }), false);
    // already materialized → false + reporter fires
    const t1 = path.join(cwd, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
    fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
    fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none' };
    let reported = 0;
    assert.equal(ensureSessionMaterialization(cwd, state, () => { reported += 1; }), false);
    assert.equal(reported, 1);
  });
});

// Env sandbox for ensureOpenCodeDelegationReady: a fake plugin root (with the
// runner script the self-heal spawns), a sandboxed managed-toolchain root, a
// tmp CODEX_HOME, and explicit host control via the *_PLUGIN_ROOT vars.
function withOpenCodeEnv(host: 'codex' | 'other', fn: (cwd: string, fixtures: { codexHome: string; managedBin: string }) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocready-'));
  const env = process.env;
  const saved: Record<string, string | undefined> = {};
  for (const k of [
    'TRAFFIC_ONE_PROJECT_PREFS_PATH',
    'TRAFFIC_ONE_TOOLCHAIN_ROOT',
    'TRAFFIC_ONE_PLUGIN_ROOT',
    'CODEX_PLUGIN_ROOT',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_THREAD_ID',
    'CURSOR_PLUGIN_ROOT',
    'CODEX_HOME',
  ]) saved[k] = env[k];
  const cwd = path.join(dir, 'proj');
  const pluginDir = path.join(dir, 'plugin');
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  // The self-heal spawns this detached; a no-op keeps the test hermetic.
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'onboarding-toolchain-runner.cjs'), 'process.exit(0);\n', 'utf8');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed');
  env.TRAFFIC_ONE_PLUGIN_ROOT = pluginDir;
  env.CODEX_HOME = codexHome;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_PLUGIN_ROOT;
  if (host === 'codex') env.CODEX_PLUGIN_ROOT = pluginDir; else delete env.CODEX_PLUGIN_ROOT;
  const managedBin = path.join(env.TRAFFIC_ONE_TOOLCHAIN_ROOT, 'opencode', 'npm-prefix', 'bin', 'opencode');
  try {
    fn(cwd, { codexHome, managedBin });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function installStubCli(managedBin: string): void {
  fs.mkdirSync(path.dirname(managedBin), { recursive: true });
  fs.writeFileSync(managedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('ensureOpenCodeDelegationReady: codex + enabled → registers MCP server once with a restart notice', () => {
  withOpenCodeEnv('codex', (cwd, { codexHome, managedBin }) => {
    installStubCli(managedBin); // CLI present → no install branch
    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.ok(notice.includes('restart Codex once'));
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(toml.includes('[mcp_servers.opencode-worker]'));
    // idempotent: second session → already-present → silent
    assert.equal(ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } }), '');
  });
});

test('ensureOpenCodeDelegationReady: silent no-op when delegation is disabled or host is not codex', () => {
  withOpenCodeEnv('codex', (cwd, { codexHome }) => {
    // disabled → nothing happens (no registration, no heal lock) even with CLI missing
    assert.equal(ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: false } }), '');
    assert.equal(ensureOpenCodeDelegationReady(cwd, {}), '');
    assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.opencode-heal-lock')), false);
  });
  withOpenCodeEnv('other', (cwd, { codexHome, managedBin }) => {
    installStubCli(managedBin);
    // non-codex host: registration skipped, no notice
    assert.equal(ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } }), '');
    assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false);
  });
});

test('ensureOpenCodeDelegationReady: backfills the .one.json authorization record for enabled projects', () => {
  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const state: Record<string, unknown> = { openCode: { enabled: true } };
    ensureOpenCodeDelegationReady(cwd, state);
    // committed .one.json got the durable record…
    const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(one.openCodeDelegation?.approved, true);
    assert.equal(one.openCodeDelegation?.source, 'backfilled-from-enabled-pref');
    // …and the in-memory state too (SessionStart writes state afterwards).
    assert.equal((state.openCodeDelegation as Record<string, unknown>)?.approved, true);
    // already recorded → untouched (no re-stamp)
    const before = fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8');
    ensureOpenCodeDelegationReady(cwd, state);
    assert.equal(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'), before);
  });
  withOpenCodeEnv('other', (cwd) => {
    // disabled → nothing recorded
    ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: false } });
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), false);
  });
});

test('ensureOpenCodeDelegationReady: missing CLI → background managed install behind a cooldown lock', () => {
  withOpenCodeEnv('other', (cwd) => {
    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.ok(notice.includes('managed install started'));
    const lock = path.join(cwd, '.traffic-one', '.opencode-heal-lock');
    assert.equal(fs.existsSync(lock), true);
    // cooldown: an immediate second session does not re-spawn or re-notice
    assert.equal(ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } }), '');
  });
});

test('ensureOpenCodeDelegationReady: present-but-UNSTAMPED opencode → silent background stamp-heal (no install notice)', () => {
  // A user's global opencode is present (CLI resolves) but toolchain.opencode was
  // never stamped, so openCodeDelegationActive() is false and triage/gate silently
  // skip free delegation. The heal must still fire (to stamp it) — without a
  // user-facing "installing" notice, since nothing is being installed.
  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin); // CLI present (installed=true), but state carries no toolchain stamp
    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.ok(!notice.includes('managed install started'), 'present CLI → no install notice');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.opencode-heal-lock')), true, 'heal fired to stamp the present CLI');
  });
});

test('ensureOpenCodeDelegationReady: present AND already-stamped opencode → no heal (idempotent, no lock)', () => {
  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const state = { openCode: { enabled: true }, toolchain: { opencode: { installedVersion: '1.15.13', installedAt: 'now' } } };
    ensureOpenCodeDelegationReady(cwd, state);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.opencode-heal-lock')), false, 'stamped → nothing to heal');
  });
});
