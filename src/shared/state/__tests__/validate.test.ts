import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
  isTeamApproved,
} from '../validate';

test('hasValidPerformanceState requires a known level + source', () => {
  assert.equal(hasValidPerformanceState({ level: 'high', source: 'prompted' }), true);
  assert.equal(hasValidPerformanceState({ level: 'high' }), false);
  assert.equal(hasValidPerformanceState({ level: 'x', source: 'prompted' }), false);
  assert.equal(hasValidPerformanceState(null), false);
});

test('hasResolvedOpenCodeState requires a boolean enabled', () => {
  assert.equal(hasResolvedOpenCodeState({ enabled: false, source: 'prompted' }), true);
  assert.equal(hasResolvedOpenCodeState({ enabled: 'no', source: 'prompted' }), false);
  assert.equal(hasResolvedOpenCodeState([]), false);
});

test('hasValidTeamState requires a known mode + source', () => {
  assert.equal(hasValidTeamState({ mode: 'subagents', source: 'prompted' }), true);
  assert.equal(hasValidTeamState({ mode: 'x', source: 'prompted' }), false);
});

test('hasValidProjectContext requires the full shape', () => {
  const ok = { source: 'prompted', originalPrompt: 'p', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01' };
  assert.equal(hasValidProjectContext(ok), true);
  assert.equal(hasValidProjectContext({ ...ok, summary: '' }), false);
  assert.equal(hasValidProjectContext({ ...ok, answers: [] }), false);
});

test('isTeamApproved is strict-true only', () => {
  assert.equal(isTeamApproved({ approved: true }), true);
  assert.equal(isTeamApproved({ approved: false }), false);
});
