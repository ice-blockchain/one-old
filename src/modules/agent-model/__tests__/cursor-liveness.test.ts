// src/modules/agent-model/__tests__/cursor-liveness.test.ts
// The Cursor no-resume liveness policy, and the two inputs it used to read as
// permanent proof of life.
//
// `cursorAgentPresumedDead` is a PREDICATE ABOUT DEATH, so `false` means "not
// dead" and every early `return false` is a grant of immortality. Two of them
// were unconditional: the presence of a continuation id, and a recordedAt that
// could not be parsed. Both are answered here against the shared predicate the
// rest of the run stores use, which fails closed on exactly those inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_RESUME_ID_GRACE_MS,
  CURSOR_RESUME_ID_HARD_MS,
  STATE_TIMESTAMP_FUTURE_SKEW_MS,
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import { continuationAgentId, type RunAgentEntry } from '../../../shared/state';
import { cursorAgentPresumedDead } from '../cursor-liveness';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const TOOL_CALL_ID = 'tool_11112222-3333-4444-8555-666677778888';
const RESUME_ID = '019e7390-ca45-7e03-84d3-284bda1ba905';

function entry(overrides: Partial<RunAgentEntry> = {}): RunAgentEntry {
  return {
    agentId: TOOL_CALL_ID,
    resumeId: null,
    toolCallId: TOOL_CALL_ID,
    role: 'senior-architect',
    model: 'gpt-5.6-terra-medium',
    agentType: 'senior-architect',
    parentSessionId: 'parent-1',
    recordedAt: new Date(NOW - 1_000).toISOString(),
    tasks: 1,
    replaced: false,
    ...overrides,
  };
}

function agedRow(ageMs: number, overrides: Partial<RunAgentEntry> = {}): RunAgentEntry {
  return entry({ recordedAt: new Date(NOW - ageMs).toISOString(), ...overrides });
}

test('a no-resume-id agent keeps the 90/270-second windows', () => {
  const dead = (ageMs: number, corroborated: boolean): boolean => cursorAgentPresumedDead(
    agedRow(ageMs),
    { corroborated, nowMs: NOW },
  );
  assert.equal(continuationAgentId(agedRow(0), 'cursor'), '', 'PRECONDITION: a tool_* row has no continuation id');

  assert.equal(dead(CURSOR_RESUME_ID_HARD_MS - 1_000, false), false, 'a signal-less retry waits out the hard window');
  assert.equal(dead(CURSOR_RESUME_ID_HARD_MS + 1_000, false), true);
  assert.equal(dead(CURSOR_RESUME_ID_GRACE_MS - 1_000, true), false, 'a corroborated death still respects the grace');
  assert.equal(dead(CURSOR_RESUME_ID_GRACE_MS + 1_000, true), true);
});

test('a continuation id is a precondition for resuming, not evidence of a running agent', () => {
  const resumable = agedRow(0, { agentId: RESUME_ID, resumeId: RESUME_ID });
  assert.equal(continuationAgentId(resumable, 'cursor'), RESUME_ID, 'PRECONDITION: this row IS resume-capable');

  assert.equal(
    cursorAgentPresumedDead(resumable, { corroborated: false, nowMs: NOW }),
    false,
    'a fresh resume-capable agent is alive',
  );
  // The id lifts the wait past the no-resume-id windows — there is nothing left
  // to wait for — but it does not lift the staleness bound.
  assert.equal(
    cursorAgentPresumedDead(agedRow(CURSOR_RESUME_ID_HARD_MS + 60_000, { agentId: RESUME_ID, resumeId: RESUME_ID }), {
      corroborated: true,
      nowMs: NOW,
    }),
    false,
    'and it is not held to a window that exists only to wait for the id it already has',
  );
  assert.equal(
    cursorAgentPresumedDead(agedRow(SUBAGENT_STALE_MS - 60_000, { agentId: RESUME_ID, resumeId: RESUME_ID }), {
      corroborated: true,
      nowMs: NOW,
    }),
    false,
  );
  assert.equal(
    cursorAgentPresumedDead(agedRow(SUBAGENT_STALE_MS + 60_000, { agentId: RESUME_ID, resumeId: RESUME_ID }), {
      corroborated: false,
      nowMs: NOW,
    }),
    true,
    'past the window every other reader of this row uses, an id is no longer a reason to protect it',
  );
});

test('a recordedAt that cannot be trusted is not a reason to presume an agent alive', () => {
  const unusable = ['', 'not-a-date', '   '];
  for (const recordedAt of unusable) {
    assert.equal(
      cursorAgentPresumedDead(entry({ recordedAt }), { corroborated: false, nowMs: NOW }),
      true,
      `an unparseable stamp (${JSON.stringify(recordedAt)}) is ignorance, and must not read as life`,
    );
  }
  // A row whose stamp is unusable but whose immutable SubagentStart time is known
  // falls back to that time rather than to a verdict.
  assert.equal(
    cursorAgentPresumedDead(entry({ recordedAt: 'not-a-date' }), {
      corroborated: false,
      nowMs: NOW,
      startedAtMs: NOW - 1_000,
    }),
    false,
    'the immutable start time is real evidence and still governs',
  );
  assert.equal(
    cursorAgentPresumedDead(entry({ recordedAt: 'not-a-date' }), {
      corroborated: false,
      nowMs: NOW,
      startedAtMs: NOW - (CURSOR_RESUME_ID_HARD_MS + 60_000),
    }),
    true,
  );
  // Nothing at all: no row, no start time.
  assert.equal(cursorAgentPresumedDead(null, { corroborated: false, nowMs: NOW }), true);
});

test('a recordedAt from the future is an untrustworthy clock, not a young agent', () => {
  const future = (ms: number): RunAgentEntry => entry({ recordedAt: new Date(NOW + ms).toISOString() });
  assert.equal(
    cursorAgentPresumedDead(future(STATE_TIMESTAMP_FUTURE_SKEW_MS - 60_000), { corroborated: false, nowMs: NOW }),
    false,
    'inside the skew allowance a slightly-ahead stamp is ordinary jitter',
  );
  assert.equal(
    cursorAgentPresumedDead(future(24 * 60 * 60 * 1000), { corroborated: false, nowMs: NOW }),
    true,
    'a stamp a day ahead would otherwise be immortal: a negative age passes every window',
  );
  assert.equal(
    cursorAgentPresumedDead(future(24 * 60 * 60 * 1000), { corroborated: false, nowMs: NOW, startedAtMs: NOW - 1_000 }),
    true,
    'the registry stamp is still preferred over the start time when it parses — it is simply not trusted',
  );
});
