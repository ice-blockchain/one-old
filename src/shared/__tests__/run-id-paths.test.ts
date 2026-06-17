import { test } from 'node:test';
import assert from 'node:assert/strict';

import { strayRunIdInText } from '../run-id-paths';

const CURRENT = '1781698183648';

test('strayRunIdInText: a date/ISO run-id path diverging from currentRunId is flagged', () => {
  // The incident: assignments written under a `date -u` ISO id.
  assert.equal(
    strayRunIdInText('.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // digests too, and absolute paths.
  assert.equal(
    strayRunIdInText('/proj/.traffic-one/digests/2026-06-17T12-09-40Z/architect.md', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // Windows-style backslashes normalize.
  assert.equal(
    strayRunIdInText('.traffic-one\\runs\\2026-06-17T12-09-40Z\\assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // A shell redirect into a stray run dir is caught.
  assert.equal(
    strayRunIdInText('echo x > .traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
});

test('strayRunIdInText: the correct currentRunId path is allowed', () => {
  assert.equal(strayRunIdInText(`.traffic-one/runs/${CURRENT}/assignments.json`, CURRENT), null);
  assert.equal(strayRunIdInText(`.traffic-one/digests/${CURRENT}/backend.md`, CURRENT), null);
  // Non-run-id paths are ignored entirely.
  assert.equal(strayRunIdInText('apps/web/src/index.ts', CURRENT), null);
  assert.equal(strayRunIdInText('.traffic-one/plan.md', CURRENT), null);
});

test('strayRunIdInText: no enforcement when currentRunId is empty (nothing minted yet)', () => {
  assert.equal(strayRunIdInText('.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', ''), null);
  assert.equal(strayRunIdInText('.traffic-one/runs/anything/x', undefined), null);
});

test('strayRunIdInText: among several targets the first divergent id wins', () => {
  const text = [
    `.traffic-one/runs/${CURRENT}/assignments.json`,    // ok
    '.traffic-one/digests/2026-06-17T12-09-40Z/architect.md', // stray
  ].join('\n');
  assert.equal(strayRunIdInText(text, CURRENT), '2026-06-17T12-09-40Z');
});
