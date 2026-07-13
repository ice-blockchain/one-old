import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { modelChoiceGate } from '../index';
import { writeModelChoice } from '../../agent-model/model-choice';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';

function withProject(fn: (cwd: string, runId: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-model-choice-gate-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
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
    fn(dir, runId);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
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
