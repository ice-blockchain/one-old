import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDigestFinishedAt, stampInstant } from '../digest-finished-at';

const NOW = Date.parse('2026-07-22T09:40:00Z');
const digest = (finishedAt: string | null): string =>
  `# backend digest — run 1\n\nverdict: TESTS_GREEN\n${finishedAt === null ? '' : `finished_at: ${finishedAt}\n`}\n## Touched\n- x.ts\n`;

test('future timestamp is host-stamped to real now', () => {
  const fix = normalizeDigestFinishedAt(digest('2026-07-22T12:10:00Z'), NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'future');
  assert.equal(fix.from, '2026-07-22T12:10:00Z');
  assert.equal(fix.to, '2026-07-22T09:40:00Z');
  assert.match(fix.content, /^finished_at: 2026-07-22T09:40:00Z$/m);
  assert.doesNotMatch(fix.content, /12:10:00Z/);
});

test('local-time-as-UTC (5c frontend failure mode) is caught as future', () => {
  const fix = normalizeDigestFinishedAt(digest('2026-07-22T11:35:00Z'), NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'future');
});

test('malformed timestamp is host-stamped', () => {
  const fix = normalizeDigestFinishedAt(digest('yesterday'), NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'malformed');
  assert.equal(fix.from, 'yesterday');
});

test('calendar-rollover instant (2026-02-30) is malformed → host-stamped', () => {
  const fix = normalizeDigestFinishedAt(digest('2026-02-30T10:00:00Z'), NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'malformed');
});

test('plausible near-now value is left untouched (null)', () => {
  assert.equal(normalizeDigestFinishedAt(digest('2026-07-22T09:39:31Z'), NOW), null);
});

test('millisecond precision is canonical → untouched', () => {
  assert.equal(normalizeDigestFinishedAt(digest('2026-07-22T09:39:31.250Z'), NOW), null);
});

test('future within the 2-min skew is tolerated', () => {
  assert.equal(normalizeDigestFinishedAt(digest('2026-07-22T09:41:30Z'), NOW), null); // +90s
});

test('missing finished_at line is inserted under the verdict', () => {
  const fix = normalizeDigestFinishedAt(digest(null), NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'missing');
  assert.equal(fix.from, null);
  assert.match(fix.content, /verdict: TESTS_GREEN\nfinished_at: 2026-07-22T09:40:00Z/);
});

test('missing line with no verdict is prepended', () => {
  const fix = normalizeDigestFinishedAt('# note\n\nbody\n', NOW);
  assert.ok(fix);
  assert.equal(fix.reason, 'missing');
  assert.match(fix.content, /^finished_at: 2026-07-22T09:40:00Z\n# note/);
});

test('empty finished_at value is corrected in place', () => {
  const fix = normalizeDigestFinishedAt('verdict: X\nfinished_at:\n\nbody\n', NOW);
  assert.ok(fix);
  assert.equal(fix.from, null);
  assert.match(fix.content, /^finished_at: 2026-07-22T09:40:00Z$/m);
});

test('before-run placeholder is caught when run start is known', () => {
  const runStartMs = Date.parse('2026-07-22T07:41:41Z');
  const fix = normalizeDigestFinishedAt(digest('2026-07-22T00:00:00Z'), NOW, { runStartMs });
  assert.ok(fix);
  assert.equal(fix.reason, 'before-run');
});

test('past-but-after-run value is NOT a false positive', () => {
  const runStartMs = Date.parse('2026-07-22T07:41:41Z');
  // the 5c backend actually finished ~08:20:57Z — plausible, must stay untouched
  assert.equal(normalizeDigestFinishedAt(digest('2026-07-22T08:20:57Z'), NOW, { runStartMs }), null);
});

test('stampInstant emits date -u form (no milliseconds)', () => {
  assert.equal(stampInstant(Date.parse('2026-07-22T09:40:12.678Z')), '2026-07-22T09:40:12Z');
});
