import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeOpenCodeAdapter } from '../opencode';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const opencode = makeOpenCodeAdapter();

function inv(sub: string, payload: object) {
  return { stdin: JSON.stringify(payload), argv: ['node', 'opencode-hook-runtime', sub, '--host=opencode'] };
}

test('opencode: maps pinned raw tool names to canonical tool classes', () => {
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'bash', tool_input: { command: 'npm test' } })).tool?.class, 'shell');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'write', tool_input: { file_path: 'a.ts', content: 'x' } })).tool?.class, 'file-write');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch' } })).tool?.class, 'file-edit');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'apply_patch', tool_input: { file_path: 'a.ts', content: 'x' } })).tool?.class, 'file-write');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'edit', tool_input: { old_string: 'a', new_string: 'b' } })).tool?.class, 'file-edit');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'read', tool_input: { path: 'a.ts' } })).tool?.class, 'file-read');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'grep', tool_input: { pattern: 'x' } })).tool?.class, 'search');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'glob', tool_input: { pattern: '*.ts' } })).tool?.class, 'search');
  assert.equal(opencode.parse(inv('before-tool-use', { tool_name: 'task', tool_input: { prompt: 'go' } })).tool?.class, 'spawn-agent');
});

test('opencode: parses documented tool hook payload shape', () => {
  const parsed = opencode.parse(inv('before-tool-use', {
    event: 'tool.execute.before',
    cwd: '/repo',
    tool: 'bash',
    output: { args: { command: 'npm test' } },
  }));
  assert.equal(parsed.event, 'PreToolUse');
  assert.equal(parsed.tool?.rawName, 'bash');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');

  // The real apply_patch payload (string `tool`, args under `output.args`) must
  // classify as a file write/edit — not fall through to `other` and escape gates.
  const patched = opencode.parse(inv('before-tool-use', {
    event: 'tool.execute.before',
    cwd: '/repo',
    tool: 'apply_patch',
    output: { args: { file_path: 'a.ts', patch: '*** Begin Patch' } },
  }));
  assert.equal(patched.tool?.rawName, 'apply_patch');
  assert.equal(patched.tool?.class, 'file-edit');
  assert.equal(patched.tool?.patchText, '*** Begin Patch');

  const editArgs = {
    file_path: 'src/App.tsx',
    old_string: 'const title = "old";',
    new_string: 'const title = "new";',
    replace_all: false,
  };
  const edited = opencode.parse(inv('before-tool-use', {
    event: 'tool.execute.before',
    cwd: '/repo',
    tool: 'edit',
    output: { args: editArgs },
  }));
  assert.equal(edited.tool?.class, 'file-edit');
  assert.equal(edited.tool?.filePath, 'src/App.tsx');
  assert.deepEqual((edited.raw as Record<string, unknown>).tool_input, editArgs);
  assert.deepEqual((edited.raw as Record<string, unknown>).toolInput, editArgs);
});

test('opencode: canonicalizes camel/snake/diff apply_patch variants', () => {
  for (const [key, value] of Object.entries({ patchText: 'p1', patch_text: 'p2', diff: 'p3' })) {
    const parsed = opencode.parse(inv('before-tool-use', { tool_name: 'apply_patch', tool_input: { [key]: value } }));
    assert.equal(parsed.tool?.patchText, value);
  }
});

test('opencode: restores a Kilo-style macOS path missing its leading slash', () => {
  const parsed = opencode.parse(inv('before-tool-use', {
    cwd: '/Users/w3s/WebstormProjects/11',
    tool_name: 'write',
    tool_input: { filePath: 'Users/w3s/WebstormProjects/11/.traffic-one/runs/R/assignments.json', content: '{}' },
  }));
  assert.equal(parsed.tool?.filePath, '/Users/w3s/WebstormProjects/11/.traffic-one/runs/R/assignments.json');
});

test('opencode: maps chat.message and system transform hook events', () => {
  assert.equal(opencode.parse(inv('user-prompt-submit', { event: 'chat.message', prompt: 'build it' })).event, 'UserPromptSubmit');
  assert.equal(opencode.parse(inv('system-transform', { event: 'experimental.chat.system.transform', cwd: '/repo' })).event, 'SessionStart');
});

test('opencode: before-tool deny serializes as deny for wrapper throw', async () => {
  const handlers: Handler[] = [
    { id: 'd', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const out = JSON.parse(await dispatch(opencode, handlers, inv('before-tool-use', { tool_name: 'bash', tool_input: { command: 'rm -rf x' } })));
  assert.equal(out.kind, 'deny');
  // Verbatim: core/pipeline.ts echoes its "(traffic-one ref: ...)" correlation
  // suffix only when a decision record is actually written, on the same fence
  // as the write itself (stampDeny / projectWritesPermitted) — this fixture
  // project never answered the use-plugin question.
  assert.equal(out.reason, 'blocked');
  assert.equal(out.userReason, undefined);
});

test('opencode: deny serializes trimmed userReason when set; recipe stays on reason', async () => {
  const handlers: Handler[] = [
    {
      id: 'd',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: () => deny('no rm -rf — wizard http://127.0.0.1:9/', { userReason: '  Stay in this workspace.  ' }),
    },
  ];
  const out = JSON.parse(await dispatch(opencode, handlers, inv('before-tool-use', { tool_name: 'bash', tool_input: { command: 'rm -rf x' } })));
  assert.equal(out.kind, 'deny');
  assert.equal(out.reason, 'no rm -rf — wizard http://127.0.0.1:9/');
  assert.equal(out.userReason, 'Stay in this workspace.');
});

test('opencode: after-tool deny downgrades to context warning', async () => {
  const handlers: Handler[] = [
    { id: 'd', event: 'PostToolUse', tools: ['file-write'], priority: 0, run: () => deny('too late') },
  ];
  const out = JSON.parse(await dispatch(opencode, handlers, inv('after-tool-use', { tool_name: 'write', tool_input: { file_path: 'a.ts' } })));
  assert.equal(out.kind, 'context');
  assert.equal(out.warning, true);
  assert.match(out.context, /too late/);
});

test('opencode: context and noop use wrapper JSON protocol', async () => {
  const handlers: Handler[] = [
    { id: 'c', event: 'SessionStart', priority: 0, run: () => context('hello') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(opencode, handlers, inv('session-start', { cwd: '/x' }))), { kind: 'context', context: 'hello' });
  assert.deepEqual(JSON.parse(await dispatch(opencode, [{ id: 'n', event: 'SessionStart', priority: 0, run: () => noop() }], inv('session-start', {}))), { kind: 'noop' });
});

test('opencode: the session-idle subcommand maps to the Stop event (never the session catch-all)', () => {
  const adapter = makeOpenCodeAdapter();
  const parsed = adapter.parse({
    stdin: JSON.stringify({ event: 'session.idle', cwd: '/tmp/p', session_id: 's' }),
    argv: ['session-idle', '--host=opencode'],
  });
  assert.equal(parsed.event, 'Stop');
});
