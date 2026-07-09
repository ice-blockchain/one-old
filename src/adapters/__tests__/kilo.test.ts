import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeKiloAdapter } from '../kilo';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const kilo = makeKiloAdapter();

function inv(sub: string, payload: object) {
  return { stdin: JSON.stringify(payload), argv: ['node', 'kilo-hook-runtime', sub, '--host=kilo'] };
}

test('kilo: maps OpenCode-compatible raw tool names to canonical tool classes', () => {
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'bash', tool_input: { command: 'npm test' } })).tool?.class, 'shell');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'write', tool_input: { file_path: 'a.ts', content: 'x' } })).tool?.class, 'file-write');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch' } })).tool?.class, 'file-edit');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'edit', tool_input: { old_string: 'a', new_string: 'b' } })).tool?.class, 'file-edit');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'read', tool_input: { path: 'a.ts' } })).tool?.class, 'file-read');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'grep', tool_input: { pattern: 'x' } })).tool?.class, 'search');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'glob', tool_input: { pattern: '*.ts' } })).tool?.class, 'search');
  assert.equal(kilo.parse(inv('before-tool-use', { tool_name: 'task', tool_input: { prompt: 'go' } })).tool?.class, 'spawn-agent');
});

test('kilo: parses documented tool hook payload shape', () => {
  const parsed = kilo.parse(inv('before-tool-use', {
    event: 'tool.execute.before',
    cwd: '/repo',
    tool: 'bash',
    output: { args: { command: 'npm test' } },
  }));
  assert.equal(parsed.host, 'kilo');
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.tool?.rawName, 'bash');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');
});

test('kilo: maps chat.message and system transform hook events', () => {
  assert.equal(kilo.parse(inv('user-prompt-submit', { event: 'chat.message', prompt: 'build it' })).event, 'UserPromptSubmit');
  assert.equal(kilo.parse(inv('system-transform', { event: 'experimental.chat.system.transform', cwd: '/repo' })).event, 'SessionStart');
});

test('kilo: before-tool deny serializes as deny for wrapper throw', async () => {
  const handlers: Handler[] = [
    { id: 'd', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const out = JSON.parse(await dispatch(kilo, handlers, inv('before-tool-use', { tool_name: 'bash', tool_input: { command: 'rm -rf x' } })));
  assert.deepEqual(out, { kind: 'deny', reason: 'blocked' });
});

test('kilo: after-tool deny downgrades to context warning', async () => {
  const handlers: Handler[] = [
    { id: 'd', event: 'PostToolUse', tools: ['file-write'], priority: 0, run: () => deny('too late') },
  ];
  const out = JSON.parse(await dispatch(kilo, handlers, inv('after-tool-use', { tool_name: 'write', tool_input: { file_path: 'a.ts' } })));
  assert.equal(out.kind, 'context');
  assert.equal(out.warning, true);
  assert.match(out.context, /too late/);
});

test('kilo: context and noop use wrapper JSON protocol', async () => {
  const handlers: Handler[] = [
    { id: 'c', event: 'SessionStart', priority: 0, run: () => context('hello') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(kilo, handlers, inv('session-start', { cwd: '/x' }))), { kind: 'context', context: 'hello' });
  assert.deepEqual(JSON.parse(await dispatch(kilo, [{ id: 'n', event: 'SessionStart', priority: 0, run: () => noop() }], inv('session-start', {}))), { kind: 'noop' });
});
