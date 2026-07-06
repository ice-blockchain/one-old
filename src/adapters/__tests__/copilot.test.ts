import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCopilotAdapter } from '../copilot';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'copilot');

function inv(sub: string, payload: object, surface?: 'cli' | 'vscode') {
  const env = surface === 'vscode' ? { VSCODE_PID: '1' } : { TRAFFIC_ONE_COPILOT_WIRE: 'cli' };
  const adapter = makeCopilotAdapter(surface);
  return { adapter, raw: { stdin: JSON.stringify(payload), argv: ['node', 'copilot-hook-runtime', sub] }, env };
}

test('copilot CLI: before-tool-use parses toolArgs JSON string', () => {
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pre-tool-use-input.json'), 'utf8'));
  const { adapter, raw } = inv('before-tool-use', payload, 'cli');
  const parsed = adapter.parse(raw);
  assert.equal(parsed.host, 'copilot');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');
  assert.equal(parsed.workspaceRoot, '/Users/dev/my-app');
  assert.deepEqual((parsed.raw as Record<string, unknown>).tool_input, { command: 'npm test' });
});

test('copilot CLI: spawn toolArgs are visible to raw-input gates', () => {
  const { adapter, raw } = inv('before-tool-use', {
    tool_name: 'agent',
    tool_args: JSON.stringify({
      agentName: 'senior-frontend',
      model: 'claude-opus-4-8',
      prompt: '[t1-role: senior-frontend] build the UI',
    }),
  }, 'cli');
  const parsed = adapter.parse(raw);
  const toolInput = (parsed.raw as Record<string, unknown>).tool_input as Record<string, unknown>;
  assert.equal(parsed.tool?.class, 'spawn-agent');
  assert.equal(toolInput.agentName, 'senior-frontend');
  assert.equal(toolInput.model, 'claude-opus-4-8');
});

test('copilot CLI: PreToolUse deny → flat permissionDecision shape', async () => {
  const { adapter, raw } = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }, 'cli');
  const handlers: Handler[] = [
    {
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: (ctx) => (ctx.input.tool?.command?.includes('rm') ? deny('blocked', { context: 'ctx' }) : noop()),
    },
  ];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.permissionDecisionReason, 'blocked');
  assert.equal(out.additionalContext, 'ctx');
});

test('copilot CLI: session-start context → flat additionalContext', async () => {
  const { adapter, raw } = inv('session-start', {}, 'cli');
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('auth!') }];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.additionalContext, 'auth!');
});

test('copilot VS Code: session-start context → hookSpecificOutput', async () => {
  const { adapter, raw } = inv('session-start', {}, 'vscode');
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('auth!') }];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput?.additionalContext, 'auth!');
});

test('copilot fixtures match documented spike stdout shapes', () => {
  const cliDeny = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cli-pre-tool-deny-stdout.json'), 'utf8'));
  assert.equal(cliDeny.permissionDecision, 'deny');
  const cliStart = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cli-session-start-stdout.json'), 'utf8'));
  assert.ok(cliStart.additionalContext);
  const vscodeStart = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'vscode-session-start-stdout.json'), 'utf8'));
  assert.ok(vscodeStart.hookSpecificOutput?.additionalContext);
});
