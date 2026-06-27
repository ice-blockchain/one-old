import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OPENCODE_HOST_AGENTS_REL, OPENCODE_HOST_SKILLS_REL } from '../../../config/opencode-host';
import { writeOpenCodeHostAssets } from '../opencode-assets';
import { GENERATED_MARKER } from '../generated';

// Role model resolution reads detectHostPlan('opencode'), which inspects the REAL
// machine's auth.json — so the rendered model differs on a free machine vs an
// OpenCode Go subscriber. Pin TRAFFIC_ONE_USER_PLAN so the assertions are hermetic
// regardless of where the suite runs (plan defaults to free; pass 'go' to exercise
// the paid opencode-go namespace).
function withPlugin(fn: (project: string) => void, plan = 'free'): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-assets-'));
  const plugin = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '# project-memory\nbody\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'src', 'modules', 'senior-architect'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'src', 'modules', 'senior-architect', 'agent.md'), '---\nname: senior-architect\n---\nRequired project-memory baseline\nPLAN_READY\n', 'utf8');
  fs.mkdirSync(project, { recursive: true });
  const prevRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  process.env.TRAFFIC_ONE_USER_PLAN = plan;
  try {
    fn(project);
  } finally {
    if (prevRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('writeOpenCodeHostAssets writes mode:subagent role files (agents) — free plan → opencode/ namespace', () => {
  withPlugin((project) => {
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    const n = writeOpenCodeHostAssets(project, state, ['project-memory']);
    assert.ok(n >= 1);
    const architect = fs.readFileSync(path.join(project, OPENCODE_HOST_AGENTS_REL, 'senior-architect.md'), 'utf8');
    assert.match(architect, /^mode: subagent$/m);
    assert.match(architect, /^model: opencode\//m);
    assert.match(architect, /Required project-memory baseline/);
    assert.match(architect, /PLAN_READY/);
  });
});

test('writeOpenCodeHostAssets pins paid open-weight models on the OpenCode Go plan (opencode-go/ namespace)', () => {
  // A Go subscriber must get the paid open-weight catalog, never the free gateway —
  // this is the materialize-layer guarantee behind the resolveModel Go overlay.
  withPlugin((project) => {
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeOpenCodeHostAssets(project, state, ['project-memory']);
    const architect = fs.readFileSync(path.join(project, OPENCODE_HOST_AGENTS_REL, 'senior-architect.md'), 'utf8');
    assert.match(architect, /^model: opencode-go\//m);
  }, 'go');
});

test('writeOpenCodeHostAssets does NOT mirror skills to .opencode/skills (deduped with .traffic-one/skills)', () => {
  withPlugin((project) => {
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeOpenCodeHostAssets(project, state, ['project-memory']);
    assert.equal(
      fs.existsSync(path.join(project, OPENCODE_HOST_SKILLS_REL, 'project-memory')), false,
      'skills must not be copied to .opencode/skills (the agent reads .traffic-one/skills)',
    );
  });
});

test('writeOpenCodeHostAssets removes a previously-generated .opencode/skills copy', () => {
  withPlugin((project) => {
    // Simulate a stale copy from the old (duplicating) materializer.
    const skillDir = path.join(project, OPENCODE_HOST_SKILLS_REL, 'project-memory');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${GENERATED_MARKER}\n# project-memory\nbody\n`, 'utf8');
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeOpenCodeHostAssets(project, state, ['project-memory']);
    assert.equal(fs.existsSync(skillDir), false, 'stale generated skill dir is removed');
    assert.equal(fs.existsSync(path.join(project, OPENCODE_HOST_SKILLS_REL)), false, 'now-empty .opencode/skills dir is removed');
  });
});
