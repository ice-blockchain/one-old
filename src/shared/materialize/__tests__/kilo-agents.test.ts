import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KILO_HOST_AGENTS_REL } from '../../../config/kilo-host';
import { KILO_AGENT_MARKER, writeKiloAgentFiles } from '../kilo-agents';

const FULL_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function withPlugin(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-agents-'));
  const plugin = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(plugin, 'src', 'modules', 'senior-architect'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'src', 'modules', 'senior-architect', 'agent.md'), '---\nname: senior-architect\n---\nRequired project-memory baseline\nPLAN_READY\n', 'utf8');
  fs.mkdirSync(project, { recursive: true });
  const prevRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  process.env.TRAFFIC_ONE_USER_PLAN = 'free';
  try {
    fn(project);
  } finally {
    if (prevRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('writeKiloAgentFiles writes model-agnostic role contracts without local preferences', () => {
  withPlugin((project) => {
    const written = writeKiloAgentFiles(project, FULL_STATE);
    assert.ok(written >= 6);
    const architect = fs.readFileSync(path.join(project, KILO_HOST_AGENTS_REL, 'senior-architect.md'), 'utf8');
    assert.ok(architect.includes(KILO_AGENT_MARKER));
    assert.match(architect, /^mode: subagent$/m);
    assert.doesNotMatch(architect, /^model:/m);
    assert.match(architect, /Required project-memory baseline/);
    assert.match(architect, /role contract for a Kilo `general` task subagent/);
    const reviewer = fs.readFileSync(path.join(project, KILO_HOST_AGENTS_REL, 'senior-reviewer.md'), 'utf8');
    assert.match(reviewer, /^permission:\n  edit: deny$/m);
  });
});

test('writeKiloAgentFiles preserves a user-authored role and cleans only generated files', () => {
  withPlugin((project) => {
    const dir = path.join(project, KILO_HOST_AGENTS_REL);
    fs.mkdirSync(dir, { recursive: true });
    const custom = path.join(dir, 'senior-architect.md');
    fs.writeFileSync(custom, '---\ndescription: custom\n---\nuser agent\n', 'utf8');
    writeKiloAgentFiles(project, FULL_STATE);
    assert.equal(fs.readFileSync(custom, 'utf8'), '---\ndescription: custom\n---\nuser agent\n');
    assert.equal(fs.existsSync(path.join(dir, 'senior-frontend.md')), true);
    writeKiloAgentFiles(project, { ...FULL_STATE, team: { mode: 'main-agent' }, performance: { level: 'low' } });
    assert.equal(fs.existsSync(path.join(dir, 'senior-frontend.md')), true);
    assert.equal(fs.existsSync(custom), true);
  });
});
