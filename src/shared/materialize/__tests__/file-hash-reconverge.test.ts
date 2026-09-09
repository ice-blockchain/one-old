// Per-file hash re-convergence: runtime-owned rules, skills, and generated
// root AGENTS.md are stamped into manifest.json, and an in-place edit
// (bytes changed, file still present) is permission to call the SAME writer.
//
// hasMaterializedProjectAssets is presence-only, so these cases all look
// "current" to the older conjunction. KNOWN-ISSUES #11 still holds: a torn
// plugin root refuses and writes nothing — hash-drift does not grow a
// delete/overwrite path of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pluginRootInfo } from '../../paths';
import { resetPluginUseCache } from '../../state/plugin-use';
import { isMaterialized, stateVersion, writeGlobalCodeGraphProvider } from '../../state';
import { materializeProjectFromState, materializeProjectIfNeeded } from '../converge';
import {
  hasMaterializedProjectAssets,
  materializedContentIsIncomplete,
  materializedFileHashes,
  materializedFileHashesDrifted,
  materializedFromDifferentPluginBuild,
} from '../has-assets';
import { materializeProjectAssets } from '../materialize';
import { sha256 } from '../../text';
import { assertInstalledPluginRoot } from './fixtures/installed-root';

const MODULES = path.resolve(__dirname, '..', '..', '..', 'modules');
const SOURCE_RULES = path.join(MODULES, 'rules', 'rules');
const SOURCE_SKILLS = path.join(MODULES, 'skills', 'skills-catalog');

const MUTABLE_SKILL = 'project-memory';
const HASH_A = 'a'.repeat(64);

function linkOrCopyDir(src: string, dest: string): void {
  try {
    fs.symlinkSync(src, dest, 'dir');
  } catch {
    fs.cpSync(src, dest, { recursive: true });
  }
}

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
  projectContext: { source: 'prompted', originalPrompt: 'x', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
  realtime: 'none',
  supabaseFunctionsAutoDeploy: 'ask',
  confirmed: true,
  confirmedAt: '2026-01-01T00:00:00Z',
  onboardingComplete: true,
} as const;

interface Fixture {
  project: string;
  plugin: string;
}

function setProvenance(plugin: string, hash: string | null): void {
  const file = path.join(plugin, 'build-provenance.json');
  if (hash === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, gitSha: null, sourceHash: hash }, null, 2)}\n`, 'utf8');
}

function withFixture(
  opts: { provenance?: string | null },
  fn: (fixture: Fixture) => void,
): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-file-hash-')));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  linkOrCopyDir(SOURCE_RULES, path.join(plugin, 'rules'));
  linkOrCopyDir(SOURCE_SKILLS, path.join(plugin, 'skills-catalog'));
  if (opts.provenance !== undefined) setProvenance(plugin, opts.provenance);

  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const saved = {
    root: env.TRAFFIC_ONE_PLUGIN_ROOT,
    host: env.TRAFFIC_ONE_HOST,
    plan: env.TRAFFIC_ONE_USER_PLAN,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_HOST = 'codex';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(base, 'one.json');
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  try {
    assertInstalledPluginRoot('file-hash-reconverge fixture');
    fn({ project, plugin });
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: saved.root,
      TRAFFIC_ONE_HOST: saved.host,
      TRAFFIC_ONE_USER_PLAN: saved.plan,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_STATE_PATH: saved.state,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function seedProjectState(project: string): void {
  const t1 = path.join(project, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ ...STATE }), 'utf8');
  fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    hosts: {
      codex: {
        performance: { level: 'low', source: 'prompted', target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 } },
        team: { mode: 'main-agent', source: 'prompted' },
      },
    },
  }), 'utf8');
  writeGlobalCodeGraphProvider('graphify');
}

const readState = (project: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', '.one.json'), 'utf8'));

const readManifest = (project: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));

function assertPresenceSaysCurrent(project: string, why: string): void {
  const state = readState(project);
  assert.equal(state.materializedVersion, stateVersion(), `${why}: the version stamp is unchanged`);
  assert.equal(isMaterialized(state), true, `${why}: isMaterialized still says current`);
  assert.equal(hasMaterializedProjectAssets(project, state), true, `${why}: every tracked asset is still on disk`);
  assert.equal(materializedContentIsIncomplete(project, state), false, `${why}: the declared content set is satisfied`);
  assert.equal(materializedFromDifferentPluginBuild(project), false, `${why}: the plugin build did not move`);
}

function materializeHealthy(project: string): void {
  seedProjectState(project);
  const first = materializeProjectFromState(project, { trigger: 'unit: seed' });
  assert.equal(first.status, 'materialized', first.context);
  assert.equal(pluginRootInfo().layout, 'installed');
}

test('materializedFileHashesDrifted: the whole truth table', () => {
  withFixture({ provenance: HASH_A }, ({ project, plugin }) => {
    seedProjectState(project);
    const write = (manifest: Record<string, unknown> | null): void => {
      const file = path.join(project, '.traffic-one', 'manifest.json');
      if (!manifest) { fs.rmSync(file, { force: true }); return; }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    };
    const live = sha256(Buffer.from('live-bytes'));
    const other = sha256(Buffer.from('other-bytes'));
    const ruleRel = 'rules/core.md';
    fs.mkdirSync(path.join(project, '.traffic-one', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(project, '.traffic-one', ruleRel), 'live-bytes', 'utf8');

    write({
      generatedBy: 'traffic-one',
      pluginContentHash: HASH_A,
      rules: [ruleRel],
      skills: [],
      fileHashes: { [ruleRel]: live },
    });
    assert.equal(materializedFileHashesDrifted(project), false, 'matching hashes: nothing to do');

    write({
      generatedBy: 'traffic-one',
      pluginContentHash: HASH_A,
      rules: [ruleRel],
      skills: [],
      fileHashes: { [ruleRel]: other },
    });
    assert.equal(materializedFileHashesDrifted(project), true, 'a drifted file is stale');

    write({ generatedBy: 'traffic-one', pluginContentHash: HASH_A, rules: [ruleRel], skills: [] });
    assert.equal(materializedFileHashesDrifted(project), true, 'no stamp at all is stale — once');

    write({
      generatedBy: 'traffic-one',
      pluginContentHash: HASH_A,
      rules: [ruleRel],
      skills: [],
      fileHashes: { [ruleRel]: 'not-a-hash' },
    });
    assert.equal(materializedFileHashesDrifted(project), true, 'a malformed stamp is stale — once');

    write({ generatedBy: 'someone-else', pluginContentHash: HASH_A, rules: [ruleRel], skills: [] });
    assert.equal(materializedFileHashesDrifted(project), false, 'not our manifest, not our judgement');

    write(null);
    assert.equal(materializedFileHashesDrifted(project), false, 'no manifest: hasMaterializedProjectAssets owns that');

    write({
      generatedBy: 'traffic-one',
      pluginContentHash: HASH_A,
      rules: [ruleRel],
      skills: [],
      fileHashes: { [ruleRel]: other },
    });
    setProvenance(plugin, null);
    assert.equal(materializedFileHashesDrifted(project), false, 'an unstamped root is not evidence of staleness');
  });
});

test('a healthy materialize stamps fileHashes; a second call with no drift short-circuits', () => {
  withFixture({ provenance: HASH_A }, ({ project }) => {
    materializeHealthy(project);
    const manifest = readManifest(project);
    const hashes = manifest.fileHashes as Record<string, string>;
    assert.ok(hashes && typeof hashes === 'object' && !Array.isArray(hashes));
    const rules = manifest.rules as string[];
    const skills = manifest.skills as string[];
    assert.deepEqual(hashes, materializedFileHashes(project, rules, skills));
    assert.ok(hashes['AGENTS.md']);
    assert.ok(hashes[`skills/${MUTABLE_SKILL}/SKILL.md`]);
    for (const rel of rules) {
      assert.equal(typeof hashes[rel], 'string', `${rel} is stamped`);
    }
    for (const name of skills) {
      assert.equal(typeof hashes[`skills/${name}/SKILL.md`], 'string', `${name} is stamped`);
    }

    assertPresenceSaysCurrent(project, 'fresh healthy materialize');
    assert.equal(materializedFileHashesDrifted(project), false);
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: no drift' }), null);
  });
});

test('an agent-edited rule (bytes changed, file still present) re-converges and restores the bytes', () => {
  withFixture({ provenance: HASH_A }, ({ project }) => {
    materializeHealthy(project);
    const manifest = readManifest(project);
    const rel = (manifest.rules as string[])[0];
    assert.ok(rel, 'fixture guard: a tracked rule exists');
    const target = path.join(project, '.traffic-one', rel);
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, `${original}\nAGENT-EDIT\n`, 'utf8');

    assertPresenceSaysCurrent(project, 'after an in-place rule edit');
    assert.equal(materializedFileHashesDrifted(project), true, 'only the per-file stamp can see this');
    assert.notEqual(materializeProjectIfNeeded(project, { trigger: 'unit: rule edit' }), null);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'the healthy root restored the rule bytes');
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null);
  });
});

test('an agent-edited skill SKILL.md re-converges and restores the bytes', () => {
  withFixture({ provenance: HASH_A }, ({ project }) => {
    materializeHealthy(project);
    const target = path.join(project, '.traffic-one', 'skills', MUTABLE_SKILL, 'SKILL.md');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, `${original}\nAGENT-EDIT\n`, 'utf8');

    assertPresenceSaysCurrent(project, 'after an in-place skill edit');
    assert.equal(materializedFileHashesDrifted(project), true);
    assert.notEqual(materializeProjectIfNeeded(project, { trigger: 'unit: skill edit' }), null);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'the healthy root restored the skill bytes');
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null);
  });
});

test('an agent-edited generated AGENTS.md re-converges and restores the bytes', () => {
  withFixture({ provenance: HASH_A }, ({ project }) => {
    materializeHealthy(project);
    const target = path.join(project, 'AGENTS.md');
    const original = fs.readFileSync(target, 'utf8');
    assert.ok(original.includes('GENERATED BY traffic-one'), 'fixture guard: AGENTS.md is generated');
    fs.writeFileSync(target, `${original}\nAGENT-EDIT\n`, 'utf8');

    assertPresenceSaysCurrent(project, 'after an in-place AGENTS.md edit');
    assert.equal(materializedFileHashesDrifted(project), true);
    assert.notEqual(materializeProjectIfNeeded(project, { trigger: 'unit: agents edit' }), null);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'the healthy root restored AGENTS.md');
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null);
  });
});

test('a torn plugin root plus a drifted project file refuses: project bytes unchanged', () => {
  withFixture({ provenance: HASH_A }, ({ project, plugin }) => {
    materializeHealthy(project);
    const skillPath = path.join(project, '.traffic-one', 'skills', MUTABLE_SKILL, 'SKILL.md');
    const original = fs.readFileSync(skillPath, 'utf8');
    const drifted = `${original}\nAGENT-EDIT\n`;
    fs.writeFileSync(skillPath, drifted, 'utf8');

    const skillsRoot = path.join(project, '.traffic-one', 'skills');
    const before = new Map(
      fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [
          entry.name,
          fs.readFileSync(path.join(skillsRoot, entry.name, 'SKILL.md'), 'utf8'),
        ]),
    );

    // Replace the catalog symlink — do not delete through it, or the checkout
    // skills-catalog is the casualty.
    const catalog = path.join(plugin, 'skills-catalog');
    fs.rmSync(catalog, { force: true });
    fs.mkdirSync(path.join(catalog, MUTABLE_SKILL), { recursive: true });
    fs.copyFileSync(
      path.join(SOURCE_SKILLS, MUTABLE_SKILL, 'SKILL.md'),
      path.join(catalog, MUTABLE_SKILL, 'SKILL.md'),
    );

    assertPresenceSaysCurrent(project, 'hash-drift against a torn root');
    assert.equal(materializedFileHashesDrifted(project), true, 'hash-drift asks for a convergence');

    const result = materializeProjectAssets(project, { ...STATE });
    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.removed, 0, 'not one skill may be swept by a hash-driven convergence');
    assert.equal(result.written, 0);
    assert.equal(fs.readFileSync(skillPath, 'utf8'), drifted, 'the drifted file is not replaced from a torn set');
    for (const [name, bytes] of before) {
      assert.equal(
        fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8'),
        bytes,
        `${name} is byte-identical`,
      );
    }
  });
});

test('a project materialized before fileHashes existed converges exactly once', () => {
  withFixture({ provenance: HASH_A }, ({ project }) => {
    materializeHealthy(project);
    const manifest = readManifest(project);
    delete manifest.fileHashes;
    fs.writeFileSync(path.join(project, '.traffic-one', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assertPresenceSaysCurrent(project, 'a pre-fileHashes install');
    assert.equal(materializedFileHashesDrifted(project), true);

    const converged = materializeProjectIfNeeded(project, { trigger: 'unit: legacy hashes' });
    assert.ok(converged, 'a pre-stamp project converges once so the hashes can land');
    assert.ok(readManifest(project).fileHashes);
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null);
  });
});
