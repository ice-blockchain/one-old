import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline, selectHandlers } from '../pipeline';
import { context, deny, mergeResults, noop } from '../result';
import { toolClassForRawName } from '../events';
import type { Ctx, Handler, HookInput, HookResult } from '../types';

function ctxFor(event: HookInput['event'], rawTool?: string): Ctx {
  const input: HookInput = {
    event,
    host: 'claude',
    cwd: '/tmp/x',
    raw: {},
    ...(rawTool ? { tool: { class: toolClassForRawName(rawTool), rawName: rawTool } } : {}),
  };
  // Tests exercise only ctx.input; the service members are not used here.
  return { input, host: 'claude', cwd: '/tmp/x', now: () => '2026-01-01T00:00:00Z' } as unknown as Ctx;
}

function gate(
  id: string,
  priority: number,
  run: () => HookResult,
  tools?: Handler['tools'],
): Handler {
  return { id, event: 'PreToolUse', priority, run, ...(tools ? { tools } : {}) };
}

test('pipeline sorts by priority and short-circuits on first deny', async () => {
  const calls: string[] = [];
  const handlers: Handler[] = [
    gate('b', 20, () => { calls.push('b'); return deny('blocked by b'); }, ['shell']),
    gate('a', 10, () => { calls.push('a'); return context('a-context'); }, ['shell']),
    gate('c', 30, () => { calls.push('c'); return noop(); }, ['shell']),
  ];
  const result = await runPipeline(handlers, ctxFor('PreToolUse', 'Bash'));
  assert.deepEqual(calls, ['a', 'b']); // c never runs — short-circuit at b
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') assert.equal(result.reason, 'blocked by b');
});

test('pipeline filters by event and tool class', async () => {
  const handlers: Handler[] = [
    gate('shell-only', 10, () => context('shell'), ['shell']),
    { id: 'read-only', event: 'PreToolUse', priority: 10, tools: ['file-read'], run: () => context('read') },
  ];
  const selected = selectHandlers(handlers, ctxFor('PreToolUse', 'Read')).map((h) => h.id);
  assert.deepEqual(selected, ['read-only']);
  const result = await runPipeline(handlers, ctxFor('PreToolUse', 'Read'));
  assert.equal(result.kind, 'context');
  if (result.kind === 'context') assert.equal(result.context, 'read');
});

test('mergeResults concatenates contexts when no deny', () => {
  const merged = mergeResults([context('one'), noop(), context('two')]);
  assert.equal(merged.kind, 'context');
  if (merged.kind === 'context') assert.equal(merged.context, 'one\n\ntwo');
});

test('toolClassForRawName maps all three hosts to one vocabulary', () => {
  assert.equal(toolClassForRawName('Bash'), 'shell');
  assert.equal(toolClassForRawName('exec_command'), 'shell');
  assert.equal(toolClassForRawName('Edit'), 'file-edit');
  assert.equal(toolClassForRawName('spawn_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('multi_agent_v1.spawn_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('wait_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('multi_agent_v1.wait_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('followup_task'), 'spawn-agent');
  assert.equal(toolClassForRawName('collaboration.followup_task'), 'spawn-agent');
  assert.equal(toolClassForRawName('send_message'), 'spawn-agent');
  assert.equal(toolClassForRawName('collaboration.send_message'), 'spawn-agent');
  assert.equal(toolClassForRawName('send_input'), 'spawn-agent');
  assert.equal(toolClassForRawName('Grep'), 'search');
  assert.equal(toolClassForRawName('SomethingElse'), 'other');
});
