import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { cleanupPrevious } from '../cleanup';
import { hasMaterializedProjectAssets } from '../has-assets';
import { materializeProjectAssets } from '../materialize';

// Build a temp pluginRoot containing a small rules-templates/ + skills-templates/.
function withPluginAndProject(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'rules-templates', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules-templates', 'common', 'auth-gate.md'), '# Auth gate rule\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules-templates', 'core.md'), '# Core rule\nbody', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-templates', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-templates', 'project-memory', 'SKILL.md'), '# project-memory\nbody', 'utf8');
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
