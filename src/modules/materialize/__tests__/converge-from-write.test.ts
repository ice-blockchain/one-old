import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { materializeFromProjectMemoryWrite, materializeFromToolInputHints } from '../converge-from-write';
import { modelChoicePrompted } from '../../agent-model/model-choice';

function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw-')));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  if (state) fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('materializeFromProjectMemoryWrite: null for non-memory paths', () => {
  withProject({ stack: 'default', onboardingComplete: true }, (cwd) => {
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, 'src', 'app.ts')), null);
    // a generated subtree write is not project memory
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'rules', 'core.md')), null);
  });
});

test('materializeFromProjectMemoryWrite: null when stack/onboarding incomplete', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // a project-memory write but no valid stack / not onboarded → no materialization
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'product.md')), null);
  });
});

test('materializeFromProjectMemoryWrite: a cursor-models capture missing a PICKED model asks the user (visible systemMessage)', () => {
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    const baseState = {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
      currentRunId: 'run-model-choice',
    };
    // architect overridden to balanced → picks claude-4.6-sonnet, which the captured list LACKS.
    withProject(baseState, (cwd) => {
      fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
        performance: { level: 'high', source: 'prompted' },
        team: { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-architect': 'balanced' } },
      }), 'utf8');
      fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'),
        JSON.stringify({ models: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'] }), 'utf8');

      const out = materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'cursor-models.json'));
      const sm = (out && out.systemMessage) || '';
      // systemMessage → user_message on Cursor (the channel the user actually sees, unlike the
      // Task-spawn deny which renders as a terse "Couldn't start").
      assert.ok(/model choice required/i.test(sm), 'surfaces the choice to the USER');
      assert.ok(sm.includes('claude-4.6-sonnet'), 'names the picked-but-unavailable model');
      assert.ok(/gpt-5\.5/.test(sm), 'names the fallback it would use');
      assert.ok(/enable/i.test(sm) && /fallback/i.test(sm), 'offers enable / fallback');
      assert.ok(/will NOT spawn until you reply/i.test(sm), 'fail closed — no default fallback');
      assert.equal(modelChoicePrompted(cwd, 'run-model-choice'), false, 'notice alone does not imply consent');
    });

    // Every picked model IS offered (incl. a sonnet reasoning variant) → no choice prompt.
    withProject(baseState, (cwd) => {
      fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
        performance: { level: 'high', source: 'prompted' },
        team: { mode: 'subagents', source: 'prompted', approved: true },
      }), 'utf8');
      fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'),
        JSON.stringify({ models: ['claude-opus-4-8-thinking-high', 'claude-4.6-sonnet-thinking', 'composer-2.5-fast'] }), 'utf8');
      const out = materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'cursor-models.json'));
      const sm = (out && out.systemMessage) || '';
      assert.ok(!/model choice required/i.test(sm), 'no choice prompt when every picked model is offered');
    });
  } finally {
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
  }
});

test('materializeFromToolInputHints: null when no tool-input hints resolve to a project', () => {
  withProject({ stack: 'default', onboardingComplete: true }, (cwd) => {
    assert.equal(materializeFromToolInputHints(cwd, { command: 'ls -la' }), null);
    assert.equal(materializeFromToolInputHints(cwd, {}), null);
  });
});

test('materializeFromToolInputHints: shell-written cursor-models capture gets stamped + user notice', () => {
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    withProject({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
      currentRunId: 'run-shell-models',
    }, (cwd) => {
      fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
        performance: { level: 'high', source: 'prompted' },
        team: { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-architect': 'balanced' } },
      }), 'utf8');
      fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'),
        JSON.stringify({ models: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'] }), 'utf8');

      const out = materializeFromToolInputHints(cwd, { command: 'cat > .traffic-one/cursor-models.json' });
      const sm = (out && out.systemMessage) || '';
      const stamped = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'), 'utf8'));
      assert.equal(stamped.plan, 'pro', 'shell capture is stamped with the active plan');
      assert.equal(typeof stamped.capturedAt, 'string', 'shell capture is timestamped');
      assert.ok(/model choice required/i.test(sm), 'shell capture gets the visible model-choice notice');
      assert.equal(modelChoicePrompted(cwd, 'run-shell-models'), false, 'shell capture does not auto-consent');
    });
  } finally {
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
  }
});

test('materializeFromToolInputHints: reporter is invoked for a resolved already-materialized root (returns null)', () => {
  // a fully-materialized project so materializeProjectIfNeeded early-returns null (no heavy writer)
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw2-')));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
    fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
    fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none' }), 'utf8');
    let reported = 0;
    const out = materializeFromToolInputHints(dir, { file_path: path.join(dir, 'apps', 'web', 'x.ts') }, { reportOneMcp: () => { reported += 1; } });
    assert.equal(out, null); // already materialized → nothing to converge
    assert.equal(reported, 1); // reporter fires once for the resolved root
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
