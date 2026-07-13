import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { HOST_IDS, HOST_PLAN_IDS } from '../../../config/model-tiers';
import { activeSkillsFor } from '../../skill-filters';
import { modelTierSnapshot } from '../../model-tiers';
import { GENERATED_MARKER } from '../generated';
import { cleanupPrevious } from '../cleanup';
import { hasMaterializedProjectAssets } from '../has-assets';
import { materializeProjectAssets } from '../materialize';
import { openCodeGlobalAgentPath } from '../opencode-assets';

// Build a temp pluginRoot containing a small rules/ + skills-catalog/.
function withPluginAndProject(fn: (project: string, plugin: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth gate rule\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules', 'core.md'), '# Core rule\nbody', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '# project-memory\nbody', 'utf8');
  for (const name of ['task-triage', 'model-tier-sync']) {
    const source = path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog', name, 'SKILL.md');
    const destination = path.join(plugin, 'skills-catalog', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const project = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env = process.env;
  const prevPlugin = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevHost = env.TRAFFIC_ONE_HOST;
  const prevHome = env.HOME;
  const prevXdgConfig = env.XDG_CONFIG_HOME;
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_HOST = 'codex';
  env.HOME = home;
  delete env.XDG_CONFIG_HOME;
  try {
    fn(project, plugin);
  } finally {
    if (prevPlugin === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevHost === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = prevHost;
    if (prevHome === undefined) delete env.HOME; else env.HOME = prevHome;
    if (prevXdgConfig === undefined) delete env.XDG_CONFIG_HOME; else env.XDG_CONFIG_HOME = prevXdgConfig;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function generatedProjectText(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(target);
    }
  };
  walk(root);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function modelTokenPattern(model: string): RegExp {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9/_.-])${escaped}(?=$|[^A-Za-z0-9/_.-])`, 'm');
}

test('materializeProjectAssets writes rules + skills + manifest + AGENTS.md/CLAUDE.md', () => {
  withPluginAndProject((project) => {
    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    const result = materializeProjectAssets(project, state);
    assert.ok(result.rules >= 1);
    assert.ok(result.skills >= 1);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'rules', 'common', 'auth-gate.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'project-memory', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), true);
    assert.equal(hasMaterializedProjectAssets(project, state), true);
    // re-run keeps the materialization valid
    materializeProjectAssets(project, state);
    assert.equal(hasMaterializedProjectAssets(project, state), true);
  });
});

test('cleanupPrevious removes a stale generated rule no longer in the next set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-'));
  try {
    const stale = path.join(dir, '.traffic-one', 'rules', 'old.md');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, `${GENERATED_MARKER}\nstale`, 'utf8');
    const removed = cleanupPrevious(dir, { rules: ['rules/old.md'], skills: [] }, new Set(['rules/common/auth-gate.md']), new Set());
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupPrevious moves legacy root docs into .traffic-one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-docs-'));
  try {
    fs.writeFileSync(path.join(dir, 'api.md'), '# API\n\nRoot API notes.\n', 'utf8');

    const removed = cleanupPrevious(dir, { rules: [], skills: [] }, new Set(), new Set());

    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(path.join(dir, 'api.md')), false);
    assert.equal(
      fs.readFileSync(path.join(dir, '.traffic-one', 'api.md'), 'utf8'),
      '# API\n\nRoot API notes.\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupPrevious compacts duplicate root security docs into .traffic-one/security.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-security-'));
  try {
    const trafficOne = path.join(dir, '.traffic-one');
    fs.mkdirSync(trafficOne, { recursive: true });
    fs.writeFileSync(path.join(trafficOne, 'security.md'), '# Security Memory\n\n- No secrets.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'security.md'), '# Security\n\n- RLS must be default-deny.\n', 'utf8');

    const removed = cleanupPrevious(dir, { rules: [], skills: [] }, new Set(), new Set());

    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(path.join(dir, 'security.md')), false);
    const security = fs.readFileSync(path.join(trafficOne, 'security.md'), 'utf8');
    assert.ok(security.includes('# Security Memory'));
    assert.ok(security.includes('## Migrated From Root `security.md`'));
    assert.ok(security.includes('RLS must be default-deny.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider-adopted skills are indexed in AGENTS.md but stay out of the manifest', () => {
  withPluginAndProject((project) => {
    // A provider skill relocated into .traffic-one/skills (not manifest-tracked).
    fs.mkdirSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide'), { recursive: true });
    fs.writeFileSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide', 'SKILL.md'), '# guide\n', 'utf8');

    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    materializeProjectAssets(project, state);

    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('gitnexus-guide'), 'adopted skill listed in the Active Skills index');
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(!manifest.skills.includes('gitnexus-guide'), 'manifest tracks only materialized skills');

    // Re-materialization must never sweep the adopted skill.
    materializeProjectAssets(project, state);
    assert.ok(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide', 'SKILL.md')));
  });
});

test('materialized project artifacts contain no bundled model ids or plugin-maintenance model sync skill', () => {
  withPluginAndProject((project, plugin) => {
    // Exercise the real authoring catalogs through read-only symlinks so this is
    // an artifact-tree scan, not only a fixture of the two previously offending files.
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
      onboardingComplete: true, mode: 'new-project',
    };
    assert.equal(activeSkillsFor(state).has('model-tier-sync'), true, 'model-tier-sync remains active in the plugin catalog');

    materializeProjectAssets(project, state);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.skills.includes('task-triage'), 'runtime-aware maintenance rubric remains project-visible');
    assert.ok(!manifest.skills.includes('model-tier-sync'), 'plugin-maintenance skill is never copied to a project');
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'model-tier-sync')), false);

    const bundledModels = new Set<string>();
    for (const host of HOST_IDS) {
      for (const plan of HOST_PLAN_IDS[host]) {
        for (const models of Object.values(modelTierSnapshot(host, plan))) {
          for (const model of models) bundledModels.add(model);
        }
      }
    }
    const text = generatedProjectText(project);
    for (const model of bundledModels) {
      assert.doesNotMatch(text, modelTokenPattern(model), `project artifact leaked bundled model id ${model}`);
    }
  });
});

test('non-OpenCode materialization cleans generated legacy OpenCode assets without writing global profiles', () => {
  withPluginAndProject((project) => {
    const projectAgents = path.join(project, '.opencode', 'agents');
    fs.mkdirSync(projectAgents, { recursive: true });
    const generated = path.join(projectAgents, 'senior-architect.md');
    const custom = path.join(projectAgents, 'my-agent.md');
    fs.writeFileSync(generated, `${GENERATED_MARKER}\nlegacy profile\n`, 'utf8');
    fs.writeFileSync(custom, 'user-authored profile\n', 'utf8');

    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
      onboardingComplete: true, mode: 'new-project',
      team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' },
    };
    materializeProjectAssets(project, state);

    assert.equal(fs.existsSync(generated), false, 'generated legacy profile is removed on every host');
    assert.equal(fs.readFileSync(custom, 'utf8'), 'user-authored profile\n');
    assert.equal(fs.existsSync(openCodeGlobalAgentPath(project, 'senior-architect')), false, 'Codex does not write OpenCode globals');
  });
});
