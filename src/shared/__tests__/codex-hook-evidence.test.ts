import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codexHookEvidenceEvent,
  codexHookEvidenceMarker,
  isCodexHookEvent,
  markCodexHookContext,
  type CodexHookEvent,
} from '../codex-hook-evidence';

test('Codex hook evidence markers round-trip every supported event', () => {
  const events: CodexHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'Stop'];
  for (const event of events) {
    assert.equal(isCodexHookEvent(event), true);
    assert.equal(codexHookEvidenceEvent(codexHookEvidenceMarker(event)), event);
  }
  assert.equal(isCodexHookEvent('SubagentStop'), false);
  assert.equal(codexHookEvidenceEvent('<!-- traffic-one-hook-context:v2 event=SessionStart -->'), null);
});

test('markCodexHookContext is idempotent and leaves empty context empty', () => {
  const marked = markCodexHookContext('PreToolUse', 'repair this state');
  assert.equal(markCodexHookContext('PreToolUse', marked), marked);
  assert.equal(markCodexHookContext('PreToolUse', ''), '');
  assert.equal(markCodexHookContext('PreToolUse', '  '), '  ');
});
