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
  const parsed = windsurf.parse(inv('pre_run_command', { command_line: 'npm test', cwd: '/tmp/agent' }, { cwd: '/repo' }));
  assert.equal(parsed.host, 'windsurf');
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.cwd, '/repo');
  assert.equal(parsed.tool?.workdir, '/tmp/agent');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');
});

test('windsurf: tool_info.cwd is workdir only; session cwd comes from payload fields', () => {
  const fromCwd = windsurf.parse(inv('pre_run_command', { command_line: 'ls', cwd: '/tmp' }, { cwd: '/workspace' }));
  assert.equal(fromCwd.cwd, '/workspace');
  assert.equal(fromCwd.tool?.workdir, '/tmp');

  const fromWorkspace = windsurf.parse(inv('pre_run_command', { command_line: 'ls', cwd: '/tmp' }, { workspace_root: '/opened' }));
  assert.equal(fromWorkspace.cwd, '/opened');
  assert.equal(fromWorkspace.tool?.workdir, '/tmp');

  const fromRootPath = windsurf.parse(inv('pre_run_command', { command_line: 'ls', working_directory: '/tmp' }, { root_workspace_path: '/root-ws' }));
  assert.equal(fromRootPath.cwd, '/root-ws');
  assert.equal(fromRootPath.tool?.workdir, '/tmp');

  const agentOnly = windsurf.parse(inv('pre_run_command', { command_line: 'ls', cwd: '/tmp' }));
  assert.notEqual(agentOnly.cwd, '/tmp');
  assert.equal(agentOnly.tool?.workdir, '/tmp');
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
    cwd: '/tmp/agent',
  }, { cwd: '/repo' }));
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.cwd, '/repo');
  assert.equal(parsed.tool?.class, 'spawn-agent');
  assert.equal(parsed.tool?.rawName, 'devin.run_subagent');
  assert.equal(parsed.tool?.workdir, '/tmp/agent');
  const raw = parsed.raw as { tool_name?: string; tool_input?: Record<string, unknown> };
  assert.equal(raw.tool_name, 'devin.run_subagent');
  assert.equal(raw.tool_input?.profile, 'senior-frontend');
});

test('windsurf: pre_mcp_tool_use classifies write/shell MCP by tool_info args', () => {
  const write = windsurf.parse(inv('pre_mcp_tool_use', {
    mcp_server_name: 'filesystem',
    mcp_tool_name: 'write_file',
    path: '/repo/src/a.ts',
    content: 'export const x = 1;',
  }, { cwd: '/repo' }));
  assert.equal(write.event, 'PreToolUse');
  assert.equal(write.tool?.class, 'file-write');
  assert.equal(write.tool?.rawName, 'filesystem.write_file');
  assert.equal(write.tool?.filePath, '/repo/src/a.ts');

  const post = windsurf.parse(inv('post_mcp_tool_use', {
    mcp_server_name: 'filesystem',
    mcp_tool_name: 'write_file',
    file_path: '/repo/src/a.ts',
    new_string: 'z',
  }, { cwd: '/repo' }));
  assert.equal(post.event, 'PostToolUse');
  assert.equal(post.tool?.class, 'file-write');

  const shell = windsurf.parse(inv('pre_mcp_tool_use', {
    mcp_server_name: 'shell',
    mcp_tool_name: 'run',
    command: 'npm test',
  }, { cwd: '/repo' }));
  assert.equal(shell.tool?.class, 'shell');
  assert.equal(shell.tool?.command, 'npm test');

  const other = windsurf.parse(inv('pre_mcp_tool_use', {
    mcp_server_name: 'search',
    mcp_tool_name: 'query',
    query: 'todos',
  }, { cwd: '/repo' }));
  assert.equal(other.tool?.class, 'other');
});

test('windsurf: deny serializes as runtime envelope', async () => {
  const handlers: Handler[] = [
    { id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const out = JSON.parse(await dispatch(windsurf, handlers, inv('pre_run_command', { command_line: 'rm -rf x' })));
  assert.equal(out.kind, 'deny');
  // Verbatim: core/pipeline.ts echoes its "(traffic-one ref: ...)" correlation
  // suffix only when a decision record is actually written, on the same fence
  // as the write itself (stampDeny / projectWritesPermitted) — this fixture
  // project never answered the use-plugin question.
  assert.equal(out.reason, 'blocked');
  assert.equal(out.userReason, undefined);
});

test('windsurf: deny serializes trimmed userReason when set; recipe stays on reason (entry joins both onto stderr)', async () => {
  const handlers: Handler[] = [
    {
      id: 'g',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: () => deny('no rm -rf — wizard http://127.0.0.1:9/', { userReason: '  Stay in this workspace.  ' }),
    },
  ];
  const out = JSON.parse(await dispatch(windsurf, handlers, inv('pre_run_command', { command_line: 'rm -rf x' })));
  assert.equal(out.kind, 'deny');
  assert.equal(out.reason, 'no rm -rf — wizard http://127.0.0.1:9/');
  assert.equal(out.userReason, 'Stay in this workspace.');
});

test('windsurf: deny omits whitespace-only userReason so wizard URLs in reason stay visible', () => {
  const input = windsurf.parse(inv('pre_run_command', { command_line: 'rm' }));
  const parsed = JSON.parse(windsurf.serialize(deny('blocked', { userReason: '   ' }), input));
  assert.equal(parsed.kind, 'deny');
  assert.equal(parsed.reason, 'blocked');
  assert.equal(parsed.userReason, undefined);
});

test('windsurf: context serializes as runtime envelope', async () => {
  const handlers: Handler[] = [
    { id: 'c', event: 'UserPromptSubmit', priority: 0, run: () => context('hello', { systemMessage: 'traffic-one' }) },
  ];
  const out = JSON.parse(await dispatch(windsurf, handlers, inv('pre_user_prompt', { user_prompt: 'hi' })));
  assert.deepEqual(out, { kind: 'context', context: 'hello', systemMessage: 'traffic-one' });
});
