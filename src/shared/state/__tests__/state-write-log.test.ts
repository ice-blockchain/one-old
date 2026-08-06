// The collector as a DATA STRUCTURE: bound, eviction policy, errno extraction.
// Deliberately no consent dimension and no filesystem — the collector does not
// know what a project or a fence is, and every test here calls recordStateWrite
// directly with synthetic records.
//
// What is NOT here, so nobody adds it twice: that the chokepoint actually calls
// this collector, and calls it with `errno: 'consent-fence'` on a consent
// refusal. That is a fact about shared/fsjson.ts, and it is pinned in
// consent-write-fence.test.ts alongside the fence it describes. Measured, so it
// is not an assumption: stubbing out the chokepoint's refusal-recording call
// leaves every test in THIS file green and fails that one, on
// `every refusal above is recorded as a consent-fence refusal: []`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drainStateWrites, errnoOf, recordStateWrite } from '../state-write-log';

test('drainStateWrites returns and clears everything recorded since the last drain', () => {
  drainStateWrites(); // clear any leakage from a previous test in this process
  recordStateWrite({ path: '/a', op: 'write-json', ok: true });
  recordStateWrite({ path: '/b', op: 'append', ok: false, errno: 'EACCES' });
  const drained = drainStateWrites();
  assert.deepEqual(drained, [
    { path: '/a', op: 'write-json', ok: true },
    { path: '/b', op: 'append', ok: false, errno: 'EACCES' },
  ]);
  assert.deepEqual(drainStateWrites(), []); // drained buffer stays empty until the next record
});

test('recordStateWrite is bounded — a pathological write loop cannot make the buffer unbounded', () => {
  drainStateWrites();
  for (let i = 0; i < 500; i += 1) recordStateWrite({ path: `/f${i}`, op: 'write', ok: true });
  const drained = drainStateWrites();
  assert.ok(drained.length < 500, 'the collector must cap itself well below a pathological write count');
});

// The bound above is what makes this necessary. One materialization pushes ~190
// writes through the instrumented chokepoint in a SINGLE hook call, so the buffer
// fills long before the call ends, and a plain "keep the first N" meant every
// refusal after that point was dropped — the one outcome that cannot be
// reconstructed by looking at the tree afterwards, and the reason the field exists.
test('a full buffer still admits a refusal, by evicting the oldest success', () => {
  drainStateWrites();
  for (let i = 0; i < 500; i += 1) recordStateWrite({ path: `/ok${i}`, op: 'write', ok: true });
  recordStateWrite({ path: '/refused', op: 'write-json', ok: false, errno: 'symlink' });
  const drained = drainStateWrites();

  assert.deepEqual(drained.filter((record) => !record.ok), [
    { path: '/refused', op: 'write-json', ok: false, errno: 'symlink' },
  ], 'the refusal must survive a buffer already full of successes');
  assert.equal(drained.length <= 64, true, 'and it must not have grown the buffer to make room');
  assert.equal(drained[0]?.path, '/ok1', 'the OLDEST success is what got evicted');
});

test('a buffer full of nothing but refusals keeps the earliest ones rather than churning', () => {
  drainStateWrites();
  for (let i = 0; i < 500; i += 1) recordStateWrite({ path: `/no${i}`, op: 'write', ok: false, errno: 'symlink' });
  const drained = drainStateWrites();
  assert.equal(drained[0]?.path, '/no0', 'the first refusals are the ones an operator needs');
  assert.ok(drained.length <= 64);
});

test('errnoOf extracts the symbolic fs error code, and degrades to undefined for anything else', () => {
  assert.equal(errnoOf(Object.assign(new Error('nope'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errnoOf(new Error('no code here')), undefined);
  assert.equal(errnoOf('a plain string'), undefined);
  assert.equal(errnoOf(null), undefined);
});
