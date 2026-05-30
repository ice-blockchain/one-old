import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectHost } from '../host';

const E = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => extra as NodeJS.ProcessEnv;

test('defaults to claude with a clean env', () => {
  assert.equal(detectHost(E(), []), 'claude');
});

test('cursor via flag or CURSOR_PLUGIN_ROOT', () => {
  assert.equal(detectHost(E(), ['--host=cursor']), 'cursor');
  assert.equal(detectHost(E({ CURSOR_PLUGIN_ROOT: '/x' }), []), 'cursor');
});

test('codex via CLI plugin root', () => {
  assert.equal(detectHost(E({ CODEX_PLUGIN_ROOT: '/x' }), []), 'codex');
});

test('codex via Codex Desktop originator override (no CODEX_PLUGIN_ROOT in Desktop hook env)', () => {
  assert.equal(detectHost(E({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }), []), 'codex');
});

test('codex via subagent thread id', () => {
  assert.equal(detectHost(E({ CODEX_THREAD_ID: '019e-…' }), []), 'codex');
});

test('cursor wins over codex when both are present', () => {
  assert.equal(detectHost(E({ CURSOR_PLUGIN_ROOT: '/x', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }), []), 'cursor');
});
