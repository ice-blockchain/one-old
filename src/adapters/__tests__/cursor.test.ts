import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCursorAdapter } from '../cursor';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const cursor = makeCursorAdapter();

function inv(sub: string, payload: object) {
  return { stdin: JSON.stringify(payload), argv: ['node', 'cursor-hook-runtime', sub] };
}

test('cursor: before-shell-execution → PreToolUse/shell; deny → flat permission shape', async () => {
  const handlers: Handler[] = [
    {
      id: 'g',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: (ctx) => (ctx.input.tool?.command === 'rm' ? deny('nope') : noop()),
    },
  ];
  const parsed = JSON.parse(await dispatch(cursor, handlers, inv('before-shell-execution', { command: 'rm' })));
  assert.equal(parsed.permission, 'deny');
  assert.equal(parsed.user_message, 'nope');
  assert.equal(parsed.agent_message, 'nope');
});

test('cursor: session-start context → flat additional_context', async () => {
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('ctx!') }];
  assert.deepEqual(JSON.parse(await dispatch(cursor, handlers, inv('session-start', {}))), {
    additional_context: 'ctx!',
  });
});

test('cursor: noop → {} (Cursor always wants a JSON object)', async () => {
  assert.equal(await dispatch(cursor, [], inv('after-shell-execution', { command: 'ls' })), '{}');
});

test('cursor: before-read-file extracts the path from document.uri alias', async () => {
  const handlers: Handler[] = [
    { id: 'r', event: 'PreToolUse', tools: ['file-read'], priority: 0, run: (ctx) => context(ctx.input.tool?.filePath ?? 'none') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(cursor, handlers, inv('before-read-file', { document: { uri: '/a/b.ts' } }))), {
    additional_context: '/a/b.ts',
  });
});
