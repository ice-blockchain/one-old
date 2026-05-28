import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

test('codex: namespaced multi-agent spawn hits spawn-agent gates', async () => {
  const codex = makeClaudeAdapter('codex');
  const handlers: Handler[] = [
    { id: 'spawn-gate', event: 'PreToolUse', tools: ['spawn-agent'], priority: 0, run: () => deny('claim required') },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'multi_agent_v1.spawn_agent',
    tool_input: { agent_type: 'worker', message: 'You are the Traffic One senior-frontend role.' },
  });
  const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'claim required');
});

test('codex: exec_command parses cmd/workdir and routes context to the inner app', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-adapter-')));
  const child = path.join(root, 'one-nextjs');
  try {
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}', 'utf8');
    const codex = makeClaudeAdapter('codex');
    const handlers: Handler[] = [
      {
        id: 'inspect',
        event: 'PreToolUse',
        tools: ['shell'],
        priority: 0,
        run: (ctx) => context(`cwd=${ctx.cwd}\ncommand=${ctx.input.tool?.command || ''}`),
      },
    ];
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec_command',
      tool_input: { cmd: 'npm test', workdir: 'one-nextjs' },
      cwd: root,
    });
    const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
    assert.equal(parsed.hookSpecificOutput.additionalContext, `cwd=${child}\ncommand=npm test`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
