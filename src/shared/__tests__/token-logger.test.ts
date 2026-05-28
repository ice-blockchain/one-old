import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { estimateTokens, isEnabled, logToolUse, readSizeFromValue } from '../token-logger';

function withFlag(value: string | undefined, fn: () => void): void {
  const saved = process.env.TRAFFIC_ONE_TOKEN_LOG;
  if (value === undefined) delete process.env.TRAFFIC_ONE_TOKEN_LOG; else process.env.TRAFFIC_ONE_TOKEN_LOG = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_TOKEN_LOG; else process.env.TRAFFIC_ONE_TOKEN_LOG = saved;
  }
}

test('isEnabled honors TRAFFIC_ONE_TOKEN_LOG', () => {
  withFlag('1', () => assert.equal(isEnabled(), true));
  withFlag('true', () => assert.equal(isEnabled(), true));
  withFlag('yes', () => assert.equal(isEnabled(), true));
  withFlag(undefined, () => assert.equal(isEnabled(), false));
  withFlag('0', () => assert.equal(isEnabled(), false));
});

test('estimateTokens ~= bytes/4 (ceil), guards non-positive', () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-5), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
});

test('readSizeFromValue handles strings, objects, and null', () => {
  assert.equal(readSizeFromValue(null), 0);
  assert.equal(readSizeFromValue('abc'), 3);
  assert.equal(readSizeFromValue({ a: 1 }), Buffer.byteLength('{"a":1}', 'utf8'));
});

test('logToolUse is a no-op when disabled (no file written)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tokenlog-off-'));
  try {
    withFlag(undefined, () => logToolUse(dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'token-log.jsonl')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logToolUse appends one JSONL entry when enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tokenlog-on-'));
  try {
    withFlag('1', () => logToolUse(dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: 'file listing output' }));
    const logPath = path.join(dir, '.traffic-one', 'token-log.jsonl');
    assert.ok(fs.existsSync(logPath));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.toolName, 'Bash');
    assert.equal(entry.hookEvent, 'PostToolUse');
    assert.ok(entry.inputBytes > 0);
    assert.ok(entry.outputBytes > 0);
    assert.ok(entry.estTokens > 0);
    assert.equal(entry.runId, null); // no project state in the temp dir
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
