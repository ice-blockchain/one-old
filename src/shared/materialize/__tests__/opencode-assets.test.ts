import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OPENCODE_HOST_AGENTS_REL, OPENCODE_HOST_SKILLS_REL } from '../../../config/opencode-host';
import { openCodeGlobalAgentPath, writeOpenCodeHostAssets } from '../opencode-assets';
import { GENERATED_MARKER } from '../generated';

function withPlugin(fn: (project: string, home: string) => void, plan = 'free'): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-assets-'));
  const plugin = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '# project-memory\nbody\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'src', 'modules', 'senior-architect'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'src', 'modules', 'senior-architect', 'agent.md'), '---\nname: senior-architect\n---\nRequired project-memory baseline\nPLAN_READY\n', 'utf8');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const prevRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  const prevHome = process.env.HOME;
  const prevXdgConfig = process.env.XDG_CONFIG_HOME;
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  process.env.TRAFFIC_ONE_USER_PLAN = plan;
  process.env.HOME = home;
  process.env.TRAFFIC_ONE_HOST = 'opencode';
  delete process.env.XDG_CONFIG_HOME;
  try {
    fn(project, home);
  } finally {
    if (prevRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST; else process.env.TRAFFIC_ONE_HOST = prevHost;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('writeOpenCodeHostAssets writes project-scoped model-pinned agents in the user config directory', () => {
  withPlugin((project, home) => {
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    const n = writeOpenCodeHostAssets(project, state, ['project-memory']);
    assert.ok(n >= 1);

    const architectPath = openCodeGlobalAgentPath(project, 'senior-architect');
    assert.equal(path.dirname(architectPath), path.join(home, '.config', 'opencode', 'agents'));
    assert.match(path.basename(architectPath), /^traffic-one-[a-f0-9]{12}-senior-architect\.md$/);
    const architect = fs.readFileSync(architectPath, 'utf8');
    assert.match(architect, /^mode: subagent$/m);
    assert.match(architect, /^model: opencode\//m);
    assert.match(architect, /Required project-memory baseline/);
    assert.match(architect, /PLAN_READY/);
    assert.equal(fs.existsSync(path.join(project, OPENCODE_HOST_AGENTS_REL, 'senior-architect.md')), false);
  });
});

test('writeOpenCodeHostAssets pins paid OpenCode Go models in the user profile', () => {
  withPlugin((project) => {
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeOpenCodeHostAssets(project, state, ['project-memory']);
    const architect = fs.readFileSync(openCodeGlobalAgentPath(project, 'senior-architect'), 'utf8');
    assert.match(architect, /^model: opencode-go\//m);
  }, 'go');
});

test('writeOpenCodeHostAssets cleans only generated project agents and preserves user-authored files', () => {
  withPlugin((project) => {
    const projectAgents = path.join(project, OPENCODE_HOST_AGENTS_REL);
    fs.mkdirSync(projectAgents, { recursive: true });
    const generated = path.join(projectAgents, 'senior-architect.md');
    const custom = path.join(projectAgents, 'my-agent.md');
    fs.writeFileSync(generated, `${GENERATED_MARKER}\nold generated profile\n`, 'utf8');
    fs.writeFileSync(custom, 'user profile\n', 'utf8');

    writeOpenCodeHostAssets(project, { team: { mode: 'subagents' }, performance: { level: 'balanced' } }, []);

    assert.equal(fs.existsSync(generated), false);
    assert.equal(fs.readFileSync(custom, 'utf8'), 'user profile\n');
  });
});

test('writeOpenCodeHostAssets preserves a user-authored global file at the deterministic target', () => {
  withPlugin((project) => {
    const target = openCodeGlobalAgentPath(project, 'senior-architect');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '---\nname: custom\n---\nuser global profile\n', 'utf8');

    writeOpenCodeHostAssets(project, { team: { mode: 'subagents' }, performance: { level: 'balanced' } }, []);

    assert.equal(fs.readFileSync(target, 'utf8'), '---\nname: custom\n---\nuser global profile\n');
  });
});

test('writeOpenCodeHostAssets removes this project\'s generated global profiles in main-agent mode', () => {
  withPlugin((project) => {
    const enabled = { team: { mode: 'subagents' }, performance: { level: 'balanced' } };
    writeOpenCodeHostAssets(project, enabled, []);
    const target = openCodeGlobalAgentPath(project, 'senior-architect');
    assert.equal(fs.existsSync(target), true);

    const unrelated = path.join(path.dirname(target), 'traffic-one-deadbeefdead-senior-architect.md');
    fs.writeFileSync(unrelated, `${GENERATED_MARKER}\nunrelated project\n`, 'utf8');
    writeOpenCodeHostAssets(project, { team: { mode: 'main-agent' }, performance: { level: 'low' } }, []);

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(unrelated), true);
  });
});

test('writeOpenCodeHostAssets does not mirror skills and removes a stale generated copy', () => {
  withPlugin((project) => {
    const skillDir = path.join(project, OPENCODE_HOST_SKILLS_REL, 'project-memory');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${GENERATED_MARKER}\n# project-memory\nbody\n`, 'utf8');

    writeOpenCodeHostAssets(project, { team: { mode: 'subagents' }, performance: { level: 'balanced' } }, ['project-memory']);

    assert.equal(fs.existsSync(skillDir), false);
    assert.equal(fs.existsSync(path.join(project, OPENCODE_HOST_SKILLS_REL)), false);
  });
});

test('OpenCode lineup excludes frontend for a detected Go API', () => {
  withPlugin((project) => {
    fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    const state = {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'other',
      mobile: { framework: 'none' },
      team: { mode: 'subagents', approved: true },
      performance: { level: 'balanced' },
    };
    writeOpenCodeHostAssets(project, state, []);
    assert.equal(fs.existsSync(openCodeGlobalAgentPath(project, 'senior-backend')), true);
    assert.equal(fs.existsSync(openCodeGlobalAgentPath(project, 'senior-frontend')), false);
  });
});
