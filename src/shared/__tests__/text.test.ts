import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nowIso, sha256, shortHash } from '../text';

test('nowIso is ISO-8601 with Z', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('sha256 matches the known vector for "abc"', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('shortHash honours length', () => {
  assert.equal(shortHash('abc').length, 12);
  assert.equal(shortHash('abc', 8).length, 8);
});
