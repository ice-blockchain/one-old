import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  buildOpenCodePlanBatchDenyContext,
  buildOpenCodePlanBatchPendingDirective,
  buildPostPlanReadyOpenCodeDirective,
  buildPreSpawnOpenCodeDirective,
  shouldWaitForOpenCodePlanBatch,
} from '../opencode-plan-directive';
import { markOpenCodePlanBatchComplete } from '../opencode-roles';
import { hostScopedPerformancePrefs } from '../../test-support/host-prefs';

function queueDelegateRoles(cwd: string, roles: string[]): void {
  const t1 = path.join(cwd, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(
    path.join(t1, 'plan.md'),
    `<!-- opencode-delegate:start -->\n${roles.map((role, index) => `- id: ${role.replace(/^senior-/, '')}-${index + 1} | role: ${role} | files: x.ts | task: one bounded unit. Acceptance: ok.`).join('\n')}\n<!-- opencode-delegate:end -->\n`,
    'utf8',
  );
}

function withOpenCodeProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocdir-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project',
    stack: 'default',
    onboardingComplete: true,
    currentRunId: 'run-oc-dir',
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    ...hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    ),
    openCode: { enabled: true },
    toolchain: { opencode: { installedVersion: '1.17.8' } },
  }), 'utf8');
  queueDelegateRoles(dir, ['frontend', 'backend']);
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pre-spawn directive is proactive before plan queue exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocdir-pre-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project',
    onboardingComplete: true,
    currentRunId: 'run-pre',
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    ...hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    ),
    openCode: { enabled: true },
    toolchain: { opencode: { installedVersion: '1.17.8' } },
  }), 'utf8');
  try {
    const directive = buildPreSpawnOpenCodeDirective(dir);
    assert.ok(directive.includes('OpenCode Step 0'));
    assert.ok(directive.includes('opencode_delegate_from_plan'));
    assert.ok(directive.includes('Do NOT spawn implementers in the same assistant message'));
    assert.ok(directive.includes(dir));
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('directives empty when OpenCode delegation is inactive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocdir-off-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project',
    onboardingComplete: true,
    currentRunId: 'run-off',
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    ...hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    ),
    openCode: { enabled: false },
  }), 'utf8');
  queueDelegateRoles(dir, ['frontend']);
  try {
    assert.equal(buildPreSpawnOpenCodeDirective(dir), '');
    assert.equal(buildPostPlanReadyOpenCodeDirective(dir), '');
    assert.equal(buildOpenCodePlanBatchPendingDirective(dir), '');
    assert.equal(shouldWaitForOpenCodePlanBatch(dir, 'run-off', JSON.parse(fs.readFileSync(path.join(t1, '.one.json'), 'utf8'))), false);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending directive reminds orchestrator to run Step 0 before implementer spawns', () => {
  withOpenCodeProject((cwd) => {
    const directive = buildOpenCodePlanBatchPendingDirective(cwd);
    assert.ok(directive.includes('OpenCode Step 0 still pending'));
    assert.ok(directive.includes('opencode_delegate_from_plan'));
    assert.ok(directive.includes('HARD STOP'));
    assert.ok(directive.includes('frontend, backend'));
    assert.ok(directive.includes('run-oc-dir'));
    assert.ok(directive.includes('do NOT use any shell fallback while `running:true`'));
    assert.ok(directive.includes('Fail-open'));
  });
});

test('post PLAN_READY directive re-injects Step 0 contract', () => {
  withOpenCodeProject((cwd) => {
    const directive = buildPostPlanReadyOpenCodeDirective(cwd);
    assert.ok(directive.includes('PLAN_READY received'));
    assert.ok(directive.includes('NEXT action is ONLY the Step-0 batch'));
    assert.ok(directive.includes('do NOT call Task/spawn_agent'));
  });
});

test('deny context tells orchestrator not to retry implementer spawns this turn', () => {
  withOpenCodeProject((cwd) => {
    const ctx = buildOpenCodePlanBatchDenyContext(cwd, 'run-oc-dir', ['frontend', 'backend']);
    assert.ok(ctx.includes('do NOT retry Task spawns'));
    assert.ok(ctx.includes('opencode_delegate_from_plan'));
    assert.ok(ctx.includes('frontend, backend'));
  });
});

test('directives clear after plan batch is terminal', () => {
  withOpenCodeProject((cwd) => {
    markOpenCodePlanBatchComplete(cwd, 'run-oc-dir');
    assert.equal(buildOpenCodePlanBatchPendingDirective(cwd), '');
    assert.equal(buildPostPlanReadyOpenCodeDirective(cwd), '');
  });
});
