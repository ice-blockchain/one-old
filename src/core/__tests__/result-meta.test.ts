import { test } from 'node:test';
import assert from 'node:assert/strict';

import { context, deny, followup, mergeResults } from '../result';
import { makeClaudeAdapter } from '../../adapters/claude';
import { makeCursorAdapter } from '../../adapters/cursor';
import type { HookInput } from '../types';

const input: HookInput = { event: 'UserPromptSubmit', host: 'claude', cwd: '/x', raw: {} };

test('context + deny carry systemMessage + promptRequest', () => {
  const c = context('hi', { systemMessage: 'sys', promptRequest: { id: 'p' } });
  assert.equal(c.kind, 'context');
  if (c.kind === 'context') {
    assert.equal(c.systemMessage, 'sys');
    assert.deepEqual(c.promptRequest, { id: 'p' });
  }
  const d = deny('nope', { context: 'ctx', systemMessage: 'sys' });
  assert.equal(d.kind, 'deny');
  if (d.kind === 'deny') {
    assert.equal(d.context, 'ctx');
    assert.equal(d.systemMessage, 'sys');
  }
});

test('claude adapter serializes meta at the top level', () => {
  const out = JSON.parse(makeClaudeAdapter('claude').serialize(context('hi', { systemMessage: 'sys', promptRequest: { id: 'p' } }), input));
  assert.equal(out.systemMessage, 'sys');
  assert.deepEqual(out.promptRequest, { id: 'p' });
  assert.equal(out.hookSpecificOutput.additionalContext, 'hi');
});

test('cursor adapter maps systemMessage→user_message and drops promptRequest', () => {
  const out = JSON.parse(makeCursorAdapter().serialize(context('hi', { systemMessage: 'sys', promptRequest: { id: 'p' } }), input));
  assert.equal(out.additional_context, 'hi');
  assert.equal(out.user_message, 'sys');
  assert.equal('promptRequest' in out, false);
});

test('mergeResults keeps first systemMessage/promptRequest/followupMessage + concatenated context', () => {
  const r = mergeResults([
    context('a', { systemMessage: 's1' }),
    followup('continue once'),
    followup('ignored second continuation'),
    context('b', { promptRequest: { id: 'p' } }),
  ]);
  assert.equal(r.kind, 'context');
  if (r.kind === 'context') {
    assert.equal(r.context, 'a\n\nb');
    assert.equal(r.systemMessage, 's1');
    assert.deepEqual(r.promptRequest, { id: 'p' });
    assert.equal(r.followupMessage, 'continue once');
  }
});

test('followup rejects empty continuation text', () => {
  assert.deepEqual(followup('   '), { kind: 'noop' });
});
