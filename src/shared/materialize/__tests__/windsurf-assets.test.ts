import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { writeWindsurfHostAssets } from '../windsurf-assets';
import { WINDSURF_RULES_REL } from '../../windsurf-rules';

const LEGACY_WINDSURF_SKILLS_REL = path.join('.windsurf', 'skills');

function withPlugin(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-assets-'));
  const plugin = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth Gate\n\nAuth body.\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'rules', 'frontend', 'react'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'frontend', 'react', 'components.md'), [
    '---',
    'paths:',
    '  - "src/components/**"',
    '---',
    '',
    '# Components',
    '',
    'Component body.',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'agents', 'senior-architect.md'), '# Senior Architect\n\nPLAN_READY\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '---\nname: project-memory\ndescription: Memory\n---\n# Skill\n', 'utf8');
  fs.mkdirSync(project, { recursive: true });
  const previousRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  try {
    fn(project);
  } finally {
    if (previousRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previousRoot;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('writeWindsurfHostAssets mirrors active rules and role docs; skills stay canonical under .traffic-one', () => {
  withPlugin((project) => {
    const result = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md', 'rules/frontend/react/components.md']);
    assert.equal(result.skills, 0);
    assert.ok(result.rules >= 3);

    const auth = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'auth-required.md'), 'utf8');
    assert.match(auth, /^trigger: always_on$/m);
    const components = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'react-components.md'), 'utf8');
    assert.match(components, /^trigger: glob$/m);
    assert.match(components, /^globs: /m);
    const architect = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, '00-agent-senior-architect.md'), 'utf8');
    assert.match(architect, /PLAN_READY/);

    assert.equal(fs.existsSync(path.join(project, LEGACY_WINDSURF_SKILLS_REL)), false);
  });
});

test('writeWindsurfHostAssets removes stale generated Windsurf files and legacy skill mirrors only', () => {
  withPlugin((project) => {
    const staleRule = path.join(project, WINDSURF_RULES_REL, 'stale.md');
    const manualRule = path.join(project, WINDSURF_RULES_REL, 'manual.md');
    const staleSkill = path.join(project, LEGACY_WINDSURF_SKILLS_REL, 'old-skill');
    const manualSkill = path.join(project, LEGACY_WINDSURF_SKILLS_REL, 'manual-skill');
    fs.mkdirSync(path.dirname(staleRule), { recursive: true });
    fs.writeFileSync(staleRule, `${GENERATED_MARKER}\n# stale\n`, 'utf8');
    fs.writeFileSync(manualRule, '# manual\n', 'utf8');
    fs.mkdirSync(staleSkill, { recursive: true });
    fs.writeFileSync(path.join(staleSkill, 'SKILL.md'), `${GENERATED_MARKER}\n# old\n`, 'utf8');
    fs.mkdirSync(manualSkill, { recursive: true });
    fs.writeFileSync(path.join(manualSkill, 'SKILL.md'), '# manual\n', 'utf8');

    const result = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md']);
    assert.ok(result.removed >= 2);
    assert.equal(fs.existsSync(staleRule), false);
    assert.equal(fs.existsSync(staleSkill), false);
    assert.equal(fs.existsSync(manualSkill), true);
    assert.equal(fs.existsSync(manualRule), true);
  });
});
