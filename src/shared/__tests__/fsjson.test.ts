import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { parseJson, readJson, readText, writeJson } from '../fsjson';

test('parseJson handles valid, invalid, and empty input', () => {
  assert.deepEqual(parseJson('{"a":1}', {}), { a: 1 });
  assert.deepEqual(parseJson('not json', { fallback: true }), { fallback: true });
  assert.deepEqual(parseJson('', { f: 1 }), { f: 1 });
});

test('readText returns null when missing; writeJson/readJson round-trips with trailing newline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fsjson-'));
  try {
    assert.equal(readText(path.join(dir, 'nope.txt')), null);
    const filePath = path.join(dir, 'sub', 'x.json');
    writeJson(filePath, { hello: 'world' });
    assert.deepEqual(readJson(filePath, {}), { hello: 'world' });
    assert.equal(readText(filePath)?.endsWith('\n'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
