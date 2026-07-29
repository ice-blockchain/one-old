import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { modelChoiceGate } from '../index';
import { markModelChoicePrompted, writeModelChoice } from '../../agent-model/model-choice';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import {
  claimCursorSpawnObservation,
  claimThreadRole,
  readEffectiveState,
  recordCursorSpawnObservation,
  updateCursorSpawnObservation,
} from '../../../shared/state';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';
import { modelGateCommand } from '../../../shared/model-gate-command';
import { resolveModel } from '../../../shared/model-tiers';

// Derived, never hardcoded: which family anchors a tier is editable policy.
const CURSOR_HIGHEST_SLUG = `${resolveModel('highest', 'cursor', 'pro')}-thinking-high`;

function withProject(fn: (cwd: string, runId: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-model-choice-gate-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevXdgState = env.XDG_STATE_HOME;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const runId = '1780000000000';
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const prefs = hostScopedPerformancePrefs(
        { level: 'high', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-architect': 'balanced' } },
        'pro',
      );
    withCursorAvailableModels(prefs, ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'], 'pro');
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      onboardingComplete: true,
      materializedStack: 'default|react-vite|supabase|none',
      currentRunId: runId,
    }), 'utf8');
    const state = readEffectiveState(dir, { ...env, TRAFFIC_ONE_HOST: 'cursor' });
    assert.ok(
      ensureRunModelPolicy(dir, runId, 'cursor', state, { ...env, TRAFFIC_ONE_HOST: 'cursor' }),
      'the parent fixture must freeze the Cursor policy before run-level choice gates execute',
    );
    fn(dir, runId);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevXdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = prevXdgState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctx(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>, sessionId = 's1'): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'cursor',
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput, session_id: sessionId, workspace_roots: [cwd] },
    tool: {
      class: cls,
      rawName,
      ...(typeof toolInput.command === 'string' ? { command: toolInput.command } : {}),
      ...(typeof toolInput.file_path === 'string' ? { filePath: toolInput.file_path } : {}),
      ...(typeof toolInput.content === 'string' ? { content: toolInput.content } : {}),
    },
  };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

test('modelChoiceGate: first pending-choice tool denies visibly, then read-only orientation is allowed', () => {
  withProject((cwd) => {
    const first = modelChoiceGate(ctx(cwd, 'Read', 'file-read', { file_path: 'package.json' }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(/model-choice gate|model choice required/i.test(first.reason));
      assert.ok(/fallback/i.test(first.reason) && /enable/i.test(first.reason));
      assert.ok(/end your turn/i.test(first.reason));
    }

    const readAgain = modelChoiceGate(ctx(cwd, 'Read', 'file-read', { file_path: 'README.md' }));
    assert.equal(readAgain.kind, 'noop', 'read-only orientation is allowed after the first visible stop');

    const write = modelChoiceGate(ctx(cwd, 'Write', 'file-write', { file_path: 'README.md', content: '# x\n' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(/still paused/i.test(write.reason));
  });
});

test('modelChoiceGate: recorded fallback clears the gate', () => {
  withProject((cwd, runId) => {
    writeModelChoice(cwd, runId, 'use-fallback');
    const write = modelChoiceGate(ctx(cwd, 'Write', 'file-write', { file_path: 'README.md', content: '# x\n' }));
    assert.equal(write.kind, 'noop');
  });
});

test('modelChoiceGate: only the exact active-project model runner bypasses a pending choice', () => {
  withProject((cwd) => {
    const exact = modelChoiceGate(ctx(cwd, 'Bash', 'shell', {
      command: modelGateCommand(cwd, 'cursor'),
    }));
    assert.equal(exact.kind, 'noop');

    const falseCommands = [
      modelGateCommand(path.join(path.dirname(cwd), 'sibling'), 'cursor'),
      modelGateCommand(cwd, 'claude'),
      modelGateCommand(cwd, 'cursor').replace(/model-gate\.cjs/, 'evil-model-gate.cjs'),
      `${modelGateCommand(cwd, 'cursor')} && echo bypass`,
    ];
    for (const [index, command] of falseCommands.entries()) {
      const result = modelChoiceGate(ctx(cwd, 'Bash', 'shell', { command }, `strict-${index}`));
      assert.equal(result.kind, 'deny', `pending choice must block false model command: ${command}`);
    }
  });
});

// The api-limit pause shape (tests/cursor/13): no captured-model gap — pending
// is armed by the prompted marker after a role's runtime failure. The parent
// freezes a policy whose exact preferred slugs are all present, so
// cursorUnavailablePicks is empty and the pause remains role-scoped.
function withApiLimitPause(fn: (cwd: string, runId: string, state: Record<string, unknown>) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-model-choice-scope-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevXdgState = env.XDG_STATE_HOME;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const runId = '1780000000000';
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const prefs = hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    );
    withCursorAvailableModels(
      prefs,
      [CURSOR_HIGHEST_SLUG, 'gpt-5.6-terra-medium', 'composer-2.5-fast'],
      'pro',
    );
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
    const projectState = {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
      currentRunId: runId,
    };
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(projectState), 'utf8');
    const state = readEffectiveState(dir, { ...env, TRAFFIC_ONE_HOST: 'cursor' });
    assert.ok(
      ensureRunModelPolicy(dir, runId, 'cursor', state, { ...env, TRAFFIC_ONE_HOST: 'cursor' }),
      'the parent fixture must freeze the Cursor policy before an API-limit pause',
    );
    markModelChoicePrompted(dir, runId);
    // The failed role's observation (backend hit an API usage limit)
    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'orchestrator', toolCallId: 'tc-backend-1', role: 'senior-backend',
      requestedModel: 'gpt-5.6-terra-medium', tier: 'balanced', expectedModel: 'gpt-5.6-terra',
      startedAtMs: 1000,
    }));
    assert.ok(claimCursorSpawnObservation(dir, runId, 'tc-backend-1', 'child-backend-1', 1001));
    assert.ok(updateCursorSpawnObservation(dir, runId, 'child-backend-1', {
      outcome: 'api-limit', error: 'API usage limit reached',
    }));
    fn(dir, runId, state);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevXdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = prevXdgState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('modelChoiceGate: api-limit pause allows healthy claimed sibling roles (A2)', () => {
  withApiLimitPause((cwd, runId, state) => {
    // healthy in-flight frontend keeps working
    assert.ok(claimThreadRole(cwd, state, 'fe-session', 'senior-frontend', { parentSessionId: 'orchestrator' }));
    const healthy = modelChoiceGate(ctx(cwd, 'Write', 'file-write',
      { file_path: 'apps/web/src/x.ts', content: 'export {};\n' }, 'fe-session'));
    assert.equal(healthy.kind, 'noop', 'healthy sibling role must not be paused by another role\'s api-limit');

    // the failed role itself stays paused
    assert.ok(claimThreadRole(cwd, state, 'be-session', 'senior-backend', { parentSessionId: 'orchestrator' }));
    const failed = modelChoiceGate(ctx(cwd, 'Write', 'file-write',
      { file_path: 'supabase/migrations/x.sql', content: 'select 1;\n' }, 'be-session'));
    assert.equal(failed.kind, 'deny');

    // unresolved identity (the orchestrator) fails closed — no new spawns/writes
    const orchestrator = modelChoiceGate(ctx(cwd, 'Write', 'file-write',
      { file_path: 'README.md', content: '# x\n' }, 'orchestrator-session'));
    assert.equal(orchestrator.kind, 'deny');
  });
});

test('modelChoiceGate: unavailable captured picks stay run-level for every role', () => {
  withProject((cwd, runId) => {
    // withProject arms pending via a captured-model gap → account-wide pause
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(claimThreadRole(cwd, state, 'fe-session', 'senior-frontend', { parentSessionId: 'orchestrator' }));
    const first = modelChoiceGate(ctx(cwd, 'Write', 'file-write',
      { file_path: 'apps/web/src/x.ts', content: 'export {};\n' }, 'fe-session'));
    assert.equal(first.kind, 'deny', 'captured-pick unavailability pauses every role (account-wide toggle)');
  });
});
