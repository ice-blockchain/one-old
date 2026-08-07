import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureAgentTeamsEnv, ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, resetUncertifiedHostBannerThrottle, shouldBuildCodeGraph, sweepOldDigests, tokenEconomyBanner, uncertifiedHostBanner } from '../session-start-lib';
import { writeMaterializedContent } from '../../../shared/materialize/__tests__/fixtures/materialized-content';
import { materializeProjectAssets } from '../../../shared/materialize/materialize';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import { readJsonResult } from '../../../shared/fsjson';
import { readState } from '../../../shared/state';

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

const TEAMS_FLAG = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const readSettingsEnv = (cwd: string): Record<string, unknown> => {
  const p = path.join(cwd, '.claude', 'settings.local.json');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (parsed.env || {}) as Record<string, unknown>;
};

test('ensureAgentTeamsEnv: fresh Claude project → writes the flag + returns a restart nudge', () => {
  withTmp((cwd) => {
    const notice = ensureAgentTeamsEnv(cwd, 'claude', {} as NodeJS.ProcessEnv); // flag not yet live in this process
    assert.equal(readSettingsEnv(cwd)[TEAMS_FLAG], '1');
    assert.ok(notice.includes('restart Claude Code'), 'nudges the user to restart');
  });
});

test('ensureAgentTeamsEnv: flag already live in the process → ensures settings but stays silent', () => {
  withTmp((cwd) => {
    const notice = ensureAgentTeamsEnv(cwd, 'claude', { [TEAMS_FLAG]: '1' } as NodeJS.ProcessEnv);
    assert.equal(readSettingsEnv(cwd)[TEAMS_FLAG], '1');
    assert.equal(notice, '', 'no nudge once the feature is active');
  });
});

test('ensureAgentTeamsEnv: merge-preserving — keeps existing env + never overrides an explicit value', () => {
  withTmp((cwd) => {
    const dir = path.join(cwd, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    // User has their own env var AND an explicit disable of the flag.
    fs.writeFileSync(path.join(dir, 'settings.local.json'),
      JSON.stringify({ env: { FOO: 'bar', [TEAMS_FLAG]: '0' }, permissions: { allow: ['Read(./**)'] } }), 'utf8');
    const notice = ensureAgentTeamsEnv(cwd, 'claude', {} as NodeJS.ProcessEnv);
    const env = readSettingsEnv(cwd);
    assert.equal(env.FOO, 'bar', 'unrelated env preserved');
    assert.equal(env[TEAMS_FLAG], '0', 'explicit user "0" is not overridden');
    assert.equal(notice, '', 'an explicit disable is respected (no write, no nudge)');
    // permissions block survives the merge.
    const full = JSON.parse(fs.readFileSync(path.join(dir, 'settings.local.json'), 'utf8'));
    assert.deepEqual(full.permissions.allow, ['Read(./**)']);
  });
});

test('ensureAgentTeamsEnv: non-Claude hosts and the plugin authoring root are no-ops', () => {
  withTmp((cwd) => {
    assert.equal(ensureAgentTeamsEnv(cwd, 'codex', {} as NodeJS.ProcessEnv), '');
    assert.equal(ensureAgentTeamsEnv(cwd, 'cursor', {} as NodeJS.ProcessEnv), '');
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), false, 'no write on non-Claude hosts');
  });
});

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
    // new-project self-heals once onboarding is COMPLETE + provider set + no graph yet —
    // covers BOTH a deferred onboarding install (graphDeferredAt) AND a build that degraded
    // before its Phase-5 graph refresh (the Cursor tests/4b case, no graphDeferredAt).
    const np = { mode: 'new-project', codeGraphProvider: 'graphify', onboardingComplete: true };
    assert.equal(shouldBuildCodeGraph(cwd, { ...np, graphDeferredAt: '2026-06-08T11:00:00Z' }, NOW), true);
    assert.equal(shouldBuildCodeGraph(cwd, { ...np }, NOW), true); // broadened: no deferral marker needed
    // but a mid-onboarding scaffold (onboardingComplete not yet true) is NOT scanned early
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'new-project', codeGraphProvider: 'graphify', onboardingComplete: false }, NOW), false);
    // gitnexus keys on .gitnexus/
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), true);
    fs.mkdirSync(path.join(cwd, '.traffic-one', '.gitnexus'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 3, nodes: 9 } }), 'utf8');
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), false);
    const old = new Date(NOW - 60_000);
    fs.utimesSync(path.join(cwd, '.traffic-one', '.gitnexus'), old, old);
    fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const newer = true;', 'utf8');
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), true);
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
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graph-preview.md'), 'Provider: graphify\nmodules: a, b', 'utf8');
    assert.ok(readGraphPreview(cwd).includes('modules: a, b'));
    assert.ok(readGraphPreview(cwd, 'graphify').includes('modules: a, b'));
    assert.equal(readGraphPreview(cwd, 'gitnexus'), '', 'a preview from the previous provider is not injected');
  });
});

test('tokenEconomyBanner surfaces memory + graph hints, and toolchain drift via the probe', () => {
  withTmp((cwd) => {
    assert.equal(tokenEconomyBanner(cwd), ''); // nothing present
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'stack.md'), 'x', 'utf8');
    // Graph artifacts live under .traffic-one/ (relocated); the banner must
    // probe the relocated paths, not the legacy root ones.
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), 'g', 'utf8');
    assert.ok(!tokenEconomyBanner(cwd).includes('[graph: graphify]'), 'legacy root path must not trigger the banner');
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), 'g', 'utf8');
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

// The third case is the one that needs a real fixture. It used to hand-roll a
// manifest listing one rule and one skill, which is the shape a partially copied
// plugin root leaves behind, so materializedContentIsIncomplete (has-assets.ts)
// re-converged it: the call returned false and the reporter fired via the
// REFUSAL path (no plugin root here), not the short-circuit the case is named
// for. Measured — deleting that short-circuit from converge.ts outright left
// this test green. Deriving the content from config is what makes the third
// assertion mean what it says.
test('ensureSessionMaterialization no-ops for incomplete / already-current state', () => {
  withTmp((cwd) => {
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: false }), false);
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: true, stack: 'not-a-stack' }), false);
    // already materialized → false + reporter fires
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none' };
    writeMaterializedContent(cwd, { state });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
    let reported = 0;
    assert.equal(ensureSessionMaterialization(cwd, state, () => { reported += 1; }), false);
    assert.equal(reported, 1);
  });
});

// A plugin root the writer accepts as INSTALLED, built in tmp so this does not
// depend on `dist/` existing (src/build/test-preload.mjs pins the plugin root to
// the source checkout, which materializeProjectAssets correctly refuses).
//
// The content is converged from the writer's OWN torn-root evidence rather than
// listed here: seed one rule so the layout classifies as installed, then fill in
// exactly what it reports missing. tornRootRefusal compares candidates against
// resolved, and the candidate set is wider than the mandatory spine and moves
// with config, so a hand-listed fixture would rot into a vacuous skip.
function withInstalledPluginRoot(fn: (base: string, plugin: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-sslib-materialize-')));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// runtime\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'core.md'), '# core\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-catalog'), { recursive: true });
  const env = process.env;
  const prevRoot = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  try {
    fn(base, plugin);
  } finally {
    if (prevRoot === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const MATERIALIZABLE_STATE = {
  mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
  mobile: { framework: 'none' }, onboardingComplete: true,
} as const;

function seedProject(base: string, name: string): string {
  const cwd = path.join(base, name);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ ...MATERIALIZABLE_STATE }), 'utf8');
  return cwd;
}

/** Fill the fake plugin root from the writer's torn-root report until it stops tearing. */
function convergePluginRoot(plugin: string, probeCwd: string): void {
  for (let pass = 0; pass < 4; pass += 1) {
    const probe = materializeProjectAssets(probeCwd, { ...MATERIALIZABLE_STATE });
    if (!probe.skipped) return;
    const torn = probe.torn;
    assert.ok(torn, `fixture guard: the fake plugin root was refused for ${probe.skipped}, which this fixture cannot fill`);
    for (const rel of torn.rules.missing) {
      const target = path.join(plugin, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `# ${rel}\n`, 'utf8');
    }
    for (const name of torn.skills.missing) {
      const dir = path.join(plugin, 'skills-catalog', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`, 'utf8');
    }
  }
  assert.fail('fixture guard: the fake plugin root never converged');
}

// The three stamps (materializedStack/materializedAt/materializedVersion) are the
// entire record that this convergence happened — `isMaterialized` reads them next
// session and `materializedVersion` is what the version-drift heal compares. They
// went through a `void` writeState, so a refused write lost all three while this
// returned true and announced 'session materialization' to one-mcp.
//
// The ARTIFACTS are not what is at stake: materializeProjectAssets has already
// written them with raw fs by then (which is why an unrecorded pass is convergent
// rather than broken — the next session simply re-materializes). What was wrong is
// being told it was recorded when it was not.
test('a materialization whose state stamp is refused is reported as not recorded', () => {
  withInstalledPluginRoot((base, plugin) => {
    const open = seedProject(base, 'baseline');
    convergePluginRoot(plugin, open);
    fs.rmSync(path.join(open, '.traffic-one', 'manifest.json'), { force: true });

    const openTriggers: string[] = [];
    assert.equal(ensureSessionMaterialization(open, { ...MATERIALIZABLE_STATE },
      (_cwd, _state, trigger) => { openTriggers.push(trigger); }), true,
      'writable baseline: an unfenced materialization records itself');
    assert.deepEqual(openTriggers, ['session materialization']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(open, '.traffic-one', '.one.json'), 'utf8')).materializedStack,
      'default|react-vite|supabase|none', 'writable baseline: and the stamp is on disk');

    const fenced = seedProject(base, 'fenced');
    // Only `.one.json` is fenced: everything materialization writes under
    // `.traffic-one/` stays writable, so the refusal is the stamp and nothing else.
    // Move-aside rather than dangling because writeState reads the current file
    // (preserveCurrentRunId) inside the lock.
    const statePath = path.join(fenced, '.traffic-one', '.one.json');
    const aside = `${statePath}.aside`;
    fs.renameSync(statePath, aside);
    fs.symlinkSync(aside, statePath);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).stack, 'default',
      'fixture guard: reads still resolve through the link');

    const fencedTriggers: string[] = [];
    assert.equal(ensureSessionMaterialization(fenced, { ...MATERIALIZABLE_STATE },
      (_cwd, _state, trigger) => { fencedTriggers.push(trigger); }), false,
      'a materialization the state write refused must not be reported as recorded');
    assert.deepEqual(fencedTriggers, ['session materialization not recorded'],
      'and one-mcp must not be told about a state change that is not in the state');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).materializedStack, undefined,
      'fixture guard: the stamp really was refused');
    assert.ok(fs.existsSync(path.join(fenced, 'AGENTS.md')),
      'fixture guard: the artifacts DID land, so this test is about the record and not the writer');
  });
});

// Env sandbox for ensureOpenCodeDelegationReady: a fake plugin root (with the
// runner script the self-heal spawns), a sandboxed managed-toolchain root, a
// tmp CODEX_HOME, and explicit host control via the *_PLUGIN_ROOT vars.
function withOpenCodeEnv(host: 'codex' | 'codex-desktop' | 'other', fn: (cwd: string, fixtures: { codexHome: string; managedBin: string }) => void): void {
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
  const marketplacePlugin = path.join(codexHome, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one');
  fs.mkdirSync(path.join(marketplacePlugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(marketplacePlugin, 'scripts', 'opencode-mcp.cjs'), '#!/usr/bin/env node\n', 'utf8');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed');
  env.CODEX_HOME = codexHome;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_PLUGIN_ROOT;
  if (host === 'codex') {
    env.TRAFFIC_ONE_PLUGIN_ROOT = pluginDir;
    env.CODEX_PLUGIN_ROOT = pluginDir;
  } else if (host === 'codex-desktop') {
    delete env.TRAFFIC_ONE_PLUGIN_ROOT;
    delete env.CODEX_PLUGIN_ROOT;
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
  } else {
    env.TRAFFIC_ONE_PLUGIN_ROOT = pluginDir;
    delete env.CODEX_PLUGIN_ROOT;
  }
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

test('ensureOpenCodeDelegationReady: Codex Desktop without plugin-root env discovers marketplace install', () => {
  withOpenCodeEnv('codex-desktop', (cwd, { codexHome, managedBin }) => {
    installStubCli(managedBin);
    const notice = ensureOpenCodeDelegationReady(cwd, {
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
    });
    assert.ok(notice.includes('restart Codex once'));
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(toml.includes('[mcp_servers.opencode-worker]'));
    assert.ok(toml.includes('local-marketplaces/traffic-one-local/plugins/traffic-one/scripts/opencode-mcp.cjs'));
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

// The whole point of the backfill is that the authorization is MACHINE-READABLE
// at call time — the spawn gate cites `openCodeDelegation` to prove the user
// authorized delegation. A refused write leaves it invisible, so opencode_delegate
// keeps being rejected as "not explicitly authorized" while this function reports
// nothing at all. Move-aside rather than dangling: writeState reads `.one.json`
// (preserveCurrentRunId) and readState is called into the write itself, so a
// dangling link would make the read fail before the write is attempted.
test('ensureOpenCodeDelegationReady: a refused authorization backfill is reported in the notice', () => {
  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'existing-codebase' }), 'utf8');

    const baseline = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).openCodeDelegation?.approved, true,
      'writable baseline: an unfenced backfill lands');
    assert.doesNotMatch(baseline, /could not be recorded/, 'writable baseline: and says nothing about a refusal');
  });

  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    const aside = `${statePath}.aside`;
    fs.renameSync(statePath, aside);
    fs.symlinkSync(aside, statePath);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).mode, 'existing-codebase',
      'fixture guard: reads still resolve through the link, so the backfill reaches its write');

    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.match(notice, /delegation authorization could not be recorded/,
      'a backfill the fence refused must be said out loud — the gate that cites this field will reject the delegation');
    assert.match(notice, /\.one\.json/, 'and the notice names the exact refused path');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).openCodeDelegation, undefined,
      'fixture guard: the record really is not on disk');
  });
});

// The kind of failure the fence case above cannot reach, and the one that used
// to be silent AND destructive at the same time. `patchState` re-reads
// `.one.json` inside the state lock and refuses an illegible base; the old
// `writeState(cwd, { ...readState(cwd), openCodeDelegation: record })` read a
// torn file as `{}` and made this one backfill the project's ENTIRE state —
// stack, mode, onboardingComplete gone to `.one.json.corrupt` — while returning
// no notice at all, because it answered true.
//
// CORRUPT is the discriminating kind. `unreadable` is a CONTROL, labelled as
// one: `writeState` already refused bytes it could not copy, so both spellings
// answer false there. EACCES rather than a directory at the path, because a
// directory THROWS out through the write and into this function's own
// `catch { /* best-effort */ }`, which swallows it — the case would then measure
// the catch rather than the read. A root uid reads mode-000 straight through,
// hence the hard guard.
test('ensureOpenCodeDelegationReady: an authorization backfill over an illegible `.one.json` is refused, not merged', () => {
  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const torn = '{"mode":"new-project","stack":"default","onboardingComplete":tr';
    fs.writeFileSync(statePath, torn, 'utf8');
    assert.equal(readJsonResult(statePath).kind, 'corrupt', 'fixture guard: the base is unparseable');
    assert.deepEqual(readState(cwd), {},
      'the base the old spelling merged onto: a torn file reads as an EMPTY project, so this one '
      + "backfill used to become the file's entire contents");

    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    assert.match(notice, /delegation authorization could not be recorded/,
      'a backfill whose base could not be read must be said out loud — the gate that cites this field will reject the delegation');
    assert.match(notice, /could not be read/,
      'and it names WHY, because a torn file needs a different repair from a planted symlink');
    assert.equal(fs.readFileSync(statePath, 'utf8'), torn,
      "the user's state is byte-identical — a patch it could not read the base of destroys nothing");
    assert.equal(fs.existsSync(`${statePath}.corrupt`), false,
      'and nothing was quarantined, because nothing was replaced');
  });

  withOpenCodeEnv('other', (cwd, { managedBin }) => {
    installStubCli(managedBin);
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const bytes = JSON.stringify({ mode: 'existing-codebase' });
    fs.writeFileSync(statePath, bytes, 'utf8');
    fs.chmodSync(statePath, 0o000);
    const guard = readJsonResult(statePath).kind;
    const notice = ensureOpenCodeDelegationReady(cwd, { openCode: { enabled: true } });
    fs.chmodSync(statePath, 0o644);

    assert.equal(guard, 'unreadable',
      'fixture guard: this environment must actually produce an unreadable read (a root uid ignores '
      + 'the mode bits, and an `ok` read here would measure nothing)');
    assert.match(notice, /delegation authorization could not be recorded/,
      'control: bytes that exist and cannot be copied are refused too');
    assert.equal(fs.readFileSync(statePath, 'utf8'), bytes, 'and they survive');
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

// The uncertified-host banner. Pre-consent is the DEFAULT state of a fresh
// project, so "no consent yet" is the common path, not an edge case: the
// once-marker cannot be written there (consent write fence), and for a while
// that meant no throttle at all — the banner re-emitted on every SessionStart,
// and on OpenCode/Kilo, whose wrapper can invoke the SessionStart transform
// several times per chat in ONE process, once per prompt.
const onceMarkerNames = (cwd: string): string[] => {
  try { return fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', '.once')); } catch { return []; }
};

// The default state of a fresh project: the use-plugin question is PENDING.
// test-preload.mjs pins TRAFFIC_ONE_ASK_USE_PLUGIN=0 suite-wide (a bare tmpdir
// then reads as "already said yes"), so the fenced window has to be asked for
// explicitly — same as the ask-first cases in session-start/prompt-submit.
function withPendingConsent(fn: (cwd: string) => void): void {
  withTmp((cwd) => {
    const prev = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    resetPluginUseCache();
    try { fn(cwd); } finally {
      if (prev === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prev;
      resetPluginUseCache();
    }
  });
}

test('uncertifiedHostBanner: pre-consent → emits ONCE per process, and writes nothing', () => {
  withPendingConsent((cwd) => {
    resetUncertifiedHostBannerThrottle();
    const before = fs.readdirSync(cwd);
    assert.match(uncertifiedHostBanner(cwd, 'copilot', 'sess-1'), /is not a certified host/);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      assert.equal(uncertifiedHostBanner(cwd, 'copilot', 'sess-1'), '', 'repeat SessionStart stays silent');
    }
    // The consent fence: an unanswered project stays byte-identical, so the
    // throttle may not fall back to a disk marker here.
    assert.deepEqual(fs.readdirSync(cwd), before, 'pre-consent project untouched');
    assert.deepEqual(onceMarkerNames(cwd), []);
  });
});

test('uncertifiedHostBanner: pre-consent with NO session id still throttles (no 30-minute TTL window)', () => {
  withPendingConsent((cwd) => {
    resetUncertifiedHostBannerThrottle();
    // firstEmitThisSession falls back to a time-bucketed key without a session
    // id; the in-process marker does not, so this is once, not once-per-30-min.
    assert.notEqual(uncertifiedHostBanner(cwd, 'kilo', null), '');
    assert.equal(uncertifiedHostBanner(cwd, 'kilo', undefined), '');
    assert.equal(uncertifiedHostBanner(cwd, 'kilo', null), '');
  });
});

test('uncertifiedHostBanner: throttled per session, not forever — a new session sees it again', () => {
  withTmp((cwd) => {
    resetUncertifiedHostBannerThrottle();
    assert.notEqual(uncertifiedHostBanner(cwd, 'windsurf', 'sess-a'), '');
    assert.equal(uncertifiedHostBanner(cwd, 'windsurf', 'sess-a'), '');
    assert.notEqual(uncertifiedHostBanner(cwd, 'windsurf', 'sess-b'), '', 'a different session is a new first contact');
  });
});

test('uncertifiedHostBanner: after consent it still emits once, and records the durable marker', () => {
  withTmp((cwd) => {
    resetUncertifiedHostBannerThrottle();
    resetPluginUseCache();
    recordPluginUseChoice(cwd, true, 'test');
    assert.notEqual(uncertifiedHostBanner(cwd, 'opencode', 'sess-c'), '');
    assert.equal(uncertifiedHostBanner(cwd, 'opencode', 'sess-c'), '');
    assert.deepEqual(onceMarkerNames(cwd), ['uncertified-host-banner-opencode-sess-c']);
    // Durable, not process-scoped: a NEW process (same session) stays silent.
    resetUncertifiedHostBannerThrottle();
    assert.equal(uncertifiedHostBanner(cwd, 'opencode', 'sess-c'), '', 'disk marker survives the process');
    resetPluginUseCache();
  });
});

test('uncertifiedHostBanner: certified hosts are silent; an unknown host is treated as uncertified', () => {
  withTmp((cwd) => {
    resetUncertifiedHostBannerThrottle();
    for (const host of ['claude', 'codex', 'cursor']) {
      assert.equal(uncertifiedHostBanner(cwd, host, 'sess-d'), '', host);
    }
    // Fail closed: a typo in TRAFFIC_ONE_HOST must not buy silence.
    assert.match(uncertifiedHostBanner(cwd, 'copliot', 'sess-d'), /is not a certified host/);
  });
});
