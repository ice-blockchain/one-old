import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeClaudeAdapter } from '../claude';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const claude = makeClaudeAdapter('claude');

test('claude: PreToolUse Bash deny → nested permissionDecision JSON', async () => {
  const handlers: Handler[] = [
    {
      id: 'block-rm',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: (ctx) => (ctx.input.tool?.command?.includes('rm -rf') ? deny('no rm -rf') : noop()),
    },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    cwd: '/tmp/p',
  });
  const parsed = JSON.parse(await dispatch(claude, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'no rm -rf');
});

test('claude: SessionStart context → additionalContext JSON', async () => {
  const handlers: Handler[] = [
    { id: 'greet', event: 'SessionStart', priority: 0, run: () => context('hello session') },
  ];
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/tmp/p' });
  const parsed = JSON.parse(await dispatch(claude, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'hello session');
});

test('claude: no matching handler → empty stdout (noop)', async () => {
  const out = await dispatch(claude, [], {
    stdin: JSON.stringify({ hook_event_name: 'PostToolUse' }),
    argv: [],
  });
  assert.equal(out, '');
});

test('codex: exec_command hits the SAME canonical shell gate as Claude Bash', async () => {
  const codex = makeClaudeAdapter('codex');
  const handlers: Handler[] = [
    { id: 'shell-gate', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { command: 'ls' },
  });
  const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'blocked');
});
