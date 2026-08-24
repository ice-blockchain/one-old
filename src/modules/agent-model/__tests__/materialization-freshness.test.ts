// src/modules/agent-model/__tests__/materialization-freshness.test.ts
// Why the spawn gate's materialization predicate does NOT carry the plugin-build
// freshness term that every other convergence point now does.
//
// This is a RULING recorded as a test, not a feature. The first case pins the
// decision (a build mismatch alone must not enter the deny branch); the second
// executes the wedge that adding the term would open, so a future reader who
// adds it sees both the red assertion and the reason in one place.
//
// gate-enforcement.ts's branch is:
//
//   if (isNewProject && !isCompletedTrafficOneMaterialization(cwd, state)) {
//     const stamped = materializeIfNeeded(cwd);
//     g.state = readEffectiveState(cwd);
//     if (!isCompletedTrafficOneMaterialization(cwd, g.state)) return deny('agent-materialization-missing', { CAUSE: stamped ? '' : <refused-stamp cause> });
//     // fall through — successful converge is not a teaching deny
//   }
//
// The incomplete arm still denies. Adding the freshness term to this predicate
// would still be a new class of denied spawn: the same predicate is the
// read-back after the sweep, so a torn plugin root would deny missing forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { materializedFromDifferentPluginBuild } from '../../../shared/materialize/has-assets';
import { materializeProjectAssets } from '../../../shared/materialize/materialize';
import { assertInstalledPluginRoot } from '../../../shared/materialize/__tests__/fixtures/installed-root';
import { hasMaterializedProjectAssets } from '../../../shared/materialize';
import { isMaterialized, readEffectiveState, stateVersion } from '../../../shared/state';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from '../converge';
import { modelEnforcementGates } from '../gate-enforcement';
import type { GateContext } from '../gate-context';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const MATERIALIZABLE_STATE = {
  mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
  mobile: { framework: 'none' }, onboardingComplete: true,
} as const;

// A plugin root the writer accepts as INSTALLED, built in tmp because the suite
// pins the plugin root to this source checkout, which the writer refuses. Its
// content is converged from the writer's own torn-root evidence rather than
// listed here — the candidate set moves with config, so a hand-listed fixture
// would rot into a vacuous skip.
function withInstalledPluginRoot(fn: (base: string, plugin: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-spawn-freshness-')));
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
    // convergePluginRoot below fills this root from the writer's torn evidence,
    // which only arrives once the LAYOUT check has already passed — so assert
    // the layout here rather than inferring it from the loop terminating.
    assertInstalledPluginRoot('materialization-freshness fixture');
    fn(base, plugin);
  } finally {
    if (prevRoot === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function seedProject(base: string, name: string): string {
  const cwd = path.join(base, name);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ ...MATERIALIZABLE_STATE }), 'utf8');
  return cwd;
}

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

function stampPluginBuild(plugin: string, sourceHash: string): void {
  fs.writeFileSync(path.join(plugin, 'build-provenance.json'),
    `${JSON.stringify({ gitSha: 'sha', sourceHash })}\n`, 'utf8');
}

const projectStamp = (cwd: string): unknown => (
  JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'manifest.json'), 'utf8')).pluginContentHash
);

/** A fully materialized new-project against `plugin` stamped with `hash`. */
function materializedProject(base: string, plugin: string, name: string, hash: string): string {
  const cwd = seedProject(base, name);
  convergePluginRoot(plugin, cwd);
  stampPluginBuild(plugin, hash);
  const state = readEffectiveState(cwd);
  assert.equal(materializeProjectAssets(cwd, state).skipped, undefined, 'fixture guard: the seeding sweep was not refused');
  assert.equal(materializeIfNeeded(cwd), true, 'fixture guard: and its stamp landed');
  assert.equal(projectStamp(cwd), hash, 'fixture guard: the project records the build it came from');
  return cwd;
}

test('the spawn gate does not deny a spawn for a plugin-build mismatch alone', () => {
  withInstalledPluginRoot((base, plugin) => {
    const cwd = materializedProject(base, plugin, 'upgraded', HASH_A);
    stampPluginBuild(plugin, HASH_B);

    const state = readEffectiveState(cwd);
    // The mismatch is live and every other signal says "current" — so this case
    // is exactly the one the freshness term exists for, and the assertion below
    // is a decision rather than an accident of the fixture.
    assert.equal(materializedFromDifferentPluginBuild(cwd), true, 'the project was materialized from a different build');
    assert.equal(isMaterialized(state), true, 'the version signal says current');
    assert.equal(state.materializedVersion, stateVersion(), 'and by equality, not by absence');
    assert.equal(hasMaterializedProjectAssets(cwd, state), true, 'every tracked file is on disk');

    assert.equal(isCompletedTrafficOneMaterialization(cwd, state), true,
      'a build mismatch alone must not enter gate-enforcement.ts\'s branch: adding the term to this predicate would make the incomplete arm fire forever on a torn root');
  });
});

// What adding the term would cost, run rather than argued. The input is the one
// a plugin upgrade actually produces: a marketplace sync that has landed the new
// build's provenance and not all of its content. `pluginRootInfo` still
// classifies that root 'installed' (a runtime file plus a non-empty content
// dir), so the freshness term fires — and the writer refuses it, so nothing can
// clear the mismatch.
test('a stricter predicate would deny every spawn forever against a torn plugin root', () => {
  withInstalledPluginRoot((base, plugin) => {
    const cwd = materializedProject(base, plugin, 'torn', HASH_A);

    const catalog = path.join(plugin, 'skills-catalog');
    const victim = fs.readdirSync(catalog)[0];
    assert.ok(victim, 'fixture guard: the converged root really has skills to tear');
    fs.rmSync(path.join(catalog, victim), { recursive: true, force: true });
    stampPluginBuild(plugin, HASH_B);

    // The hypothetical: `isCompletedTrafficOneMaterialization` with the term.
    const strict = (root: string): boolean => (
      isCompletedTrafficOneMaterialization(root, readEffectiveState(root))
      && !materializedFromDifferentPluginBuild(root)
    );

    for (const spawn of [1, 2, 3]) {
      assert.equal(strict(cwd), false, `spawn ${spawn}: the strict predicate enters the deny branch`);
      // gate-enforcement.ts's repair. `true` means "no stamp write was refused",
      // which is what makes {{CAUSE}} render empty — the sweep was refused for a
      // reason this boolean structurally cannot report.
      assert.equal(materializeIfNeeded(cwd), true, `spawn ${spawn}: the repair reports nothing to name`);
      assert.equal(projectStamp(cwd), HASH_A, `spawn ${spawn}: and the manifest still carries the previous build`);
      assert.equal(strict(cwd), false,
        `spawn ${spawn}: so the read-back denies agent-materialization-missing, with an empty CAUSE`);
    }

    // Every path that deny's prose tells the operator to check is correct here,
    // which is why it could not name this cause: it would send them looking for
    // files that exist.
    const state = readEffectiveState(cwd);
    assert.equal(isMaterialized(state), true);
    assert.equal(hasMaterializedProjectAssets(cwd, state), true);
    for (const rel of ['.traffic-one/manifest.json', 'AGENTS.md', 'CLAUDE.md']) {
      assert.ok(fs.existsSync(path.join(cwd, rel)), `${rel} is present, exactly as the deny text requires`);
    }

    // And the shipped predicate — the one this lane declined to change — allows
    // the spawn, which is the outcome the ruling chose: one spawn against the
    // previous release's complete assets, rather than a permanent refusal whose
    // text describes a condition that is false.
    assert.equal(isCompletedTrafficOneMaterialization(cwd, state), true);
  });
});

function architectGateContext(cwd: string, host: 'claude' | 'cursor', model?: string): GateContext {
  const toolInput: Record<string, unknown> = {
    subagent_type: 'senior-architect',
    prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan.',
    ...(model ? { model } : {}),
  };
  const input: HookInput = {
    event: 'PreToolUse', host, cwd,
    raw: { tool_name: 'Task', tool_input: toolInput },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  const ctx = { input, host, cwd, now: () => 'x' } as unknown as Ctx;
  return {
    ctx,
    cwd,
    state: readEffectiveState(cwd) as never,
    raw: {},
    toolName: 'Task',
    toolInput,
    role: 'senior-architect',
    roleEvidence: { role: 'senior-architect' } as never,
    spawnRunId: '1700000000000',
    runPolicy: null,
    subagentTeam: true,
    spawnPromptText: String(toolInput.prompt),
    allowSpawn: (r) => r,
  } as GateContext;
}

test('first High/subagents architect spawn after converge is not agent-materialization-deny', () => {
  withInstalledPluginRoot((base, plugin) => {
    const cwd = seedProject(base, 'high-unmaterialized');
    convergePluginRoot(plugin, cwd);
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    assert.ok(prefsPath, 'fixture guard: installed-root helper pins prefs');
    fs.writeFileSync(prefsPath, JSON.stringify(hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    )), 'utf8');
    const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    try {
      const stampedState = readEffectiveState(cwd);
      assert.equal(isCompletedTrafficOneMaterialization(cwd, stampedState), false,
        'fixture guard: the project is onboarded and not yet materialized');
      assert.equal((stampedState.performance as { level?: string } | undefined)?.level, 'high',
        'fixture guard: prefs applied High so the next gate cannot be performance-main-agent');
      assert.equal((stampedState.team as { mode?: string } | undefined)?.mode, 'subagents',
        'fixture guard: prefs applied subagents');

      const claude = modelEnforcementGates(architectGateContext(cwd, 'claude', 'opus'));
      assert.notEqual(claude.kind === 'deny' ? claude.denyId : undefined, 'agent-materialization-deny',
        'successful converge must not teach via agent-materialization-deny');
      assert.notEqual(claude.kind === 'deny' ? claude.denyId : undefined, 'agent-materialization-missing',
        'writable High/subagents converge must complete, then leave materialization');
      assert.notEqual(claude.kind === 'deny' ? claude.denyId : undefined, 'performance-main-agent',
        'High/subagents must not fall through into the low/main-agent deny');
      assert.equal(isCompletedTrafficOneMaterialization(cwd, readEffectiveState(cwd)), true,
        'the first spawn stamped the project so later gates see completed materialization');

      const cursor = modelEnforcementGates(architectGateContext(cwd, 'cursor'));
      assert.notEqual(cursor.kind === 'deny' ? cursor.denyId : undefined, 'agent-materialization-deny',
        'a later Cursor model deny is fine; materialization must not re-issue');
    } finally {
      if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
      else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    }
  });
});
