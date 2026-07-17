import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWindsurfAdapter } from '../windsurf';
import { dispatch } from '../../core/dispatch';
import { context, deny } from '../../core/result';
import type { Handler } from '../../core/types';

const windsurf = makeWindsurfAdapter();

function inv(action: string, toolInfo: object = {}, extra: object = {}) {
  return {
    stdin: JSON.stringify({ agent_action_name: action, tool_info: toolInfo, ...extra }),
    argv: ['node', 'windsurf-hook-runtime', action, '--host=windsurf'],
  };
}

test('windsurf: pre_run_command maps to PreToolUse/shell', () => {
  const parsed = windsurf.parse(inv('pre_run_command', { command_line: 'npm test', cwd: '/repo' }));
  assert.equal(parsed.host, 'windsurf');
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.cwd, '/repo');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');
});

test('windsurf: pre_write_code maps edits and content', () => {
  const parsed = windsurf.parse(inv('pre_write_code', {
    file_path: '/repo/src/a.ts',
    edits: [{ old_string: 'a', new_string: 'b' }],
  }));
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.cwd, '/repo/src');
  assert.equal(parsed.tool?.class, 'file-edit');
  assert.equal(parsed.tool?.filePath, '/repo/src/a.ts');
  assert.equal(parsed.tool?.content, 'b');
});

test('windsurf: pre_write_code canonicalizes an explicit apply_patch payload', () => {
  const parsed = windsurf.parse(inv('pre_write_code', {
    tool_name: 'apply_patch',
    patchText: '*** Begin Patch',
    cwd: '/repo',
  }));
  assert.equal(parsed.tool?.rawName, 'apply_patch');
  assert.equal(parsed.tool?.patchText, '*** Begin Patch');
});

test('windsurf: pre_user_prompt maps prompt text', () => {
  const parsed = windsurf.parse(inv('pre_user_prompt', { user_prompt: 'build a dashboard' }, { workspace_root: '/repo' }));
  assert.equal(parsed.event, 'UserPromptSubmit');
  assert.equal(parsed.prompt, 'build a dashboard');
  assert.equal(parsed.workspaceRoot, '/repo');
});

test('windsurf: run_subagent MCP calls map to spawn-agent with normalized raw tool input', () => {
  const parsed = windsurf.parse(inv('pre_mcp_tool_use', {
    mcp_server_name: 'devin',
    mcp_tool_name: 'run_subagent',
    profile: 'senior-frontend',
    prompt: '[t1-role: senior-frontend]\nbuild the UI',
    cwd: '/repo',
  }));
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.tool?.class, 'spawn-agent');
  assert.equal(parsed.tool?.rawName, 'devin.run_subagent');
  const raw = parsed.raw as { tool_name?: string; tool_input?: Record<string, unknown> };
  assert.equal(raw.tool_name, 'devin.run_subagent');
  assert.equal(raw.tool_input?.profile, 'senior-frontend');
});

test('windsurf: deny serializes as runtime envelope', async () => {
  const handlers: Handler[] = [
    { id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const out = JSON.parse(await dispatch(windsurf, handlers, inv('pre_run_command', { command_line: 'rm -rf x' })));
  assert.deepEqual(out, { kind: 'deny', reason: 'blocked' });
});

test('windsurf: context serializes as runtime envelope', async () => {
  const handlers: Handler[] = [
    { id: 'c', event: 'UserPromptSubmit', priority: 0, run: () => context('hello', { systemMessage: 'traffic-one' }) },
  ];
  const out = JSON.parse(await dispatch(windsurf, handlers, inv('pre_user_prompt', { user_prompt: 'hi' })));
  assert.deepEqual(out, { kind: 'context', context: 'hello', systemMessage: 'traffic-one' });
});
