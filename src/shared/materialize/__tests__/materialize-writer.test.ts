import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { cleanupPrevious } from '../cleanup';
import { hasMaterializedProjectAssets } from '../has-assets';
import { materializeProjectAssets } from '../materialize';

// Build a temp pluginRoot containing a small rules/ + skills-catalog/.
function withPluginAndProject(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth gate rule\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules', 'core.md'), '# Core rule\nbody', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '# project-memory\nbody', 'utf8');
  const project = path.join(base, 'proj');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const prevPlugin = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  try {
    fn(project);
  } finally {
    if (prevPlugin === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(base, { recursive: true, force: true });
  }
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

// A temp pluginRoot with both orchestrator rules/skill and an implementation
// rule/skill, so we can prove team.mode="subagents" reduces the main agent's
// AGENTS.md to the orchestration set while the FULL set still lands on disk.
function withOrchestratorPlugin(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-orch-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth gate\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'senior-engineer-team.md'), '# Team\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules', 'core.md'), '# Core (implementation)\nbody', 'utf8');
  for (const skill of ['senior-eng-orchestrator', 'project-memory']) {
    fs.mkdirSync(path.join(plugin, 'skills-catalog', skill), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'skills-catalog', skill, 'SKILL.md'), `# ${skill}\nbody`, 'utf8');
  }
  const project = path.join(base, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const env = process.env;
  const prevPlugin = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  try {
    fn(project);
  } finally {
    if (prevPlugin === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const baseState = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };

test('subagents mode: AGENTS.md lists only orchestration rules/skill, but the full set still lands on disk + manifest', () => {
  withOrchestratorPlugin((project) => {
    materializeProjectAssets(project, { ...baseState, team: { mode: 'subagents', approved: true } });
    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');

    // Main agent sees only the orchestration set.
    assert.ok(agents.includes('.traffic-one/rules/common/auth-gate.md'));
    assert.ok(agents.includes('.traffic-one/rules/common/senior-engineer-team.md'));
    assert.ok(agents.includes('.traffic-one/skills/senior-eng-orchestrator/SKILL.md'));
    assert.ok(!agents.includes('.traffic-one/rules/core.md'), 'implementation rule excluded from main-agent context');
    assert.ok(!agents.includes('.traffic-one/skills/project-memory/SKILL.md'), 'implementation skill excluded from main-agent context');

    // …but the FULL set is still materialized for the subagents to read on demand.
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'rules', 'core.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'project-memory', 'SKILL.md')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.rules.includes('rules/core.md'), 'manifest keeps the full rule set');
    assert.ok(manifest.skills.includes('project-memory'), 'manifest keeps the full skill set');
  });
});

test('main-agent mode: AGENTS.md keeps the full implementation rules/skills (regression)', () => {
  withOrchestratorPlugin((project) => {
    materializeProjectAssets(project, { ...baseState, team: { mode: 'main-agent' } });
    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('.traffic-one/rules/core.md'), 'implementation rule present in main-agent mode');
    assert.ok(agents.includes('.traffic-one/skills/project-memory/SKILL.md'), 'implementation skill present in main-agent mode');
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
