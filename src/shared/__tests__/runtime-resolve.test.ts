import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { npmNextToNode, resolveNode, resolvePython, runtimeMissingMessage } from '../runtime-resolve';
import type { ResolvedRuntime } from '../runtime-resolve';

test('runtimeMissingMessage spells out the Python minimum', () => {
  const msg = runtimeMissingMessage('graphify', 'python', 3, 10);
  assert.match(msg, /Python >=3\.10/);
  assert.match(msg, /graphify/);
});

test('runtimeMissingMessage spells out the Node minimum (minor omitted)', () => {
  const msg = runtimeMissingMessage('gitnexus', 'node', 22);
  assert.match(msg, /Node >=22/);
  assert.match(msg, /gitnexus/);
});

// Shape-only assertions: the resolvers probe the real machine, so we must not
// hard-code a version. Either null (nothing satisfying found) OR an absolute
// interpreter path with numeric major/minor that meets the requested minimum.
function assertResolvedShape(
  r: ResolvedRuntime | null,
  minMajor: number,
  minMinor: number,
): void {
  if (r === null) return; // graceful "none found" is a valid outcome
  assert.equal(typeof r.path, 'string');
  assert.ok(r.path.length > 0);
  assert.ok(path.isAbsolute(r.path), `expected absolute path, got ${r.path}`);
  assert.equal(typeof r.major, 'number');
  assert.equal(typeof r.minor, 'number');
  assert.ok(Number.isInteger(r.major));
  assert.ok(Number.isInteger(r.minor));
  assert.equal(typeof r.version, 'string');
  // Must satisfy the requested minimum (the whole point of the resolver).
  const meets = r.major > minMajor || (r.major === minMajor && r.minor >= minMinor);
  assert.ok(meets, `resolved ${r.major}.${r.minor} does not meet >=${minMajor}.${minMinor}`);
}

test('resolvePython returns null or an absolute interpreter meeting the min', () => {
  assertResolvedShape(resolvePython(3, 10), 3, 10);
});

test('resolveNode returns null or an absolute interpreter meeting the min', () => {
  const r = resolveNode(22);
  if (r !== null) {
    assert.equal(typeof r.path, 'string');
    assert.ok(path.isAbsolute(r.path), `expected absolute path, got ${r.path}`);
    assert.equal(typeof r.major, 'number');
    assert.ok(Number.isInteger(r.major));
    assert.ok(r.major >= 22, `resolved node major ${r.major} does not meet >=22`);
  }
});

test('npmNextToNode returns null for a non-existent node path', () => {
  assert.equal(npmNextToNode(path.join(path.sep, 'nope', 'does', 'not', 'exist', 'node')), null);
});
