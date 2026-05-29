import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSkillBlock } from '../../../shared/skill-block';
import { pluginRoot } from '../../../shared/paths';

const skillBlock = makeSkillBlock(pluginRoot);

test('session auth blocks resolve and substitute {{MCP_TOOL_WARNING}}', () => {
  const gate = skillBlock('session', 'session-start-gate', { MCP_TOOL_WARNING: 'WARNING-LINE' });
  assert.ok(gate.includes('Authenticate Traffic One (Recommended)'));
  assert.ok(gate.includes('WARNING-LINE'));
  assert.ok(!gate.includes('{{MCP_TOOL_WARNING}}'));
});

test('login-success / login-failed blocks resolve with vars', () => {
  assert.ok(skillBlock('session', 'login-success', {}).includes('Traffic One enabled'));
  assert.ok(skillBlock('session', 'login-failed', { REASON: 'bad-key' }).includes('bad-key'));
});
