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

/**
 * Byte accounting used to be a Claude-only feature by accident: the result was read
 * as `tool_response || tool_result` — two of the four wrapper spellings and no
 * container at all — and the input as `tool_input` alone, which Cursor never sends.
 * Measured on one payload from each of the five host families, four of them logged
 * a tool result of size 0 and two an input of size 0, so `estTokens` was short by
 * the whole tool call on every host but one.
 *
 * The rows below are the five families plus a sixth nobody has written yet, and the
 * sixth is the point: a family whose container this build cannot name must log 0
 * rather than a number measured off the payload, because a wrong number reads as a
 * measurement while a zero reads as what it is.
 */
const RESULT_TEXT = 'ready in 412 ms';
const LOGGED_COMMAND = 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /';

function entryFor(raw: Record<string, unknown>, canonical?: Record<string, unknown>): { inputBytes: number; outputBytes: number } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-tokenlog-shape-')));
  try {
    withFlag('1', () => logToolUse(dir, raw, canonical));
    const file = path.join(dir, '.traffic-one', 'token-log.jsonl');
    assert.ok(fs.existsSync(file), 'the log line must be written');
    return JSON.parse(fs.readFileSync(file, 'utf8').trim()) as { inputBytes: number; outputBytes: number };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a tool result is measured in every host family, and refused in an unknown one', () => {
  const rows: { family: string; raw: Record<string, unknown>; canonical?: Record<string, unknown>; measured: boolean }[] = [
    { family: 'wrapper', raw: { tool_input: { command: LOGGED_COMMAND }, tool_response: { stdout: RESULT_TEXT } }, measured: true },
    { family: 'wrapper, camel spelling', raw: { tool_input: { command: LOGGED_COMMAND }, toolResponse: { output: RESULT_TEXT } }, measured: true },
    { family: 'flat top level (cursor)', raw: { command: LOGGED_COMMAND, output: RESULT_TEXT, exit_code: 0 }, canonical: { command: LOGGED_COMMAND }, measured: true },
    { family: 'output container (opencode, kilo)', raw: { tool_input: { command: LOGGED_COMMAND }, output: { title: 'bash', args: { command: LOGGED_COMMAND }, output: RESULT_TEXT } }, measured: true },
    { family: 'cascade tool_info', raw: { tool_info: { command_line: LOGGED_COMMAND, output: RESULT_TEXT } }, canonical: { command: LOGGED_COMMAND }, measured: true },
    { family: 'a sixth family, container not named', raw: { tool_input: { command: LOGGED_COMMAND }, some_future_result: { body: RESULT_TEXT } }, measured: false },
  ];
  const commandBytes = Buffer.byteLength(LOGGED_COMMAND, 'utf8');
  for (const row of rows) {
    const entry = entryFor(row.raw, row.canonical);
    assert.ok(entry.inputBytes >= commandBytes, `${row.family}: the command is the input and must be counted once`);
    if (row.measured) {
      assert.ok(
        entry.outputBytes >= Buffer.byteLength(RESULT_TEXT, 'utf8'),
        `${row.family}: the tool result must be counted, not logged as zero`,
      );
      // The command must never be counted as OUTPUT — on OpenCode and Kilo it sits
      // inside the very object that carries the result.
      assert.ok(
        entry.outputBytes < commandBytes + Buffer.byteLength(RESULT_TEXT, 'utf8') + 40,
        `${row.family}: the input must not be counted into the output total`,
      );
    } else {
      assert.equal(entry.outputBytes, 0, `${row.family}: an unidentifiable result is zero, never a guess`);
    }
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
