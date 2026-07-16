import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDevinAdapter } from '../devin';

test('Devin adapter maps native exec hooks to Windsurf shell events', () => {
  const adapter = makeDevinAdapter();
  const input = adapter.parse({
    stdin: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/tmp/project', tool_name: 'exec', tool_input: { command: 'npm run build' } }),
    argv: ['check-onboarding-gate'],
  });
  assert.equal(input.host, 'windsurf');
  assert.equal(input.event, 'PreToolUse');
  assert.equal(input.tool?.class, 'shell');
  assert.equal(input.tool?.command, 'npm run build');
});

test('Devin adapter emits native block and context wire shapes', () => {
  const adapter = makeDevinAdapter();
  const prompt = adapter.parse({ stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: '/tmp/project', prompt: 'build' }), argv: [] });
  assert.deepEqual(JSON.parse(adapter.serialize({ kind: 'context', context: 'open setup' }, prompt)), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'open setup' },
  });
  assert.deepEqual(JSON.parse(adapter.serialize({ kind: 'deny', reason: 'setup first' }, { ...prompt, event: 'PreToolUse' })), {
    decision: 'block', reason: 'setup first',
  });
});
