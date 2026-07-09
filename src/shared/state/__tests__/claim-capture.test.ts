import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { captureClaimDebug, capturePlanGuardDebug } from '../claim-capture';

function withTmp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-capture-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const logFile = (cwd: string, runId: string): string =>
  path.join(cwd, '.traffic-one', 'runs', runId, 'debug', 'claim-capture.jsonl');

test('captureClaimDebug: appends a JSONL line preserving keys, truncating long strings', () => {
  withTmp((cwd) => {
    const raw = {
      session_id: 'sess-1',
      parent_session_id: 'parent-1',
      tool_input: { prompt: 'x'.repeat(1000), subagent_type: 'senior-frontend' },
    };
    captureClaimDebug(cwd, 'run-1', 'runteam-write', raw, { filePath: 'apps/web/src/App.tsx', resolved: false });
    const lines = fs.readFileSync(logFile(cwd, 'run-1'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] as string);
    assert.equal(entry.label, 'runteam-write');
    assert.equal(entry.filePath, 'apps/web/src/App.tsx');
    assert.equal(entry.resolved, false);
    // identity keys preserved verbatim…
    assert.equal(entry.raw.session_id, 'sess-1');
    assert.equal(entry.raw.parent_session_id, 'parent-1');
    assert.equal(entry.raw.tool_input.subagent_type, 'senior-frontend');
    // …long prose truncated, not dropped.
    assert.ok(entry.raw.tool_input.prompt.length < 300 && entry.raw.tool_input.prompt.includes('…[+'));
  });
});

test('captureClaimDebug: a second call appends (one line per attempt)', () => {
  withTmp((cwd) => {
    captureClaimDebug(cwd, 'run-1', 'subagent-start', { agent_id: 'a' });
    captureClaimDebug(cwd, 'run-1', 'runteam-write', { session_id: 's' });
    const lines = fs.readFileSync(logFile(cwd, 'run-1'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => JSON.parse(l).label), ['subagent-start', 'runteam-write']);
  });
});

test('captureClaimDebug: no-op without a runId', () => {
  withTmp((cwd) => {
    captureClaimDebug(cwd, null, 'runteam-write', { session_id: 's' });
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs')), false);
  });
});

test('captureClaimDebug: stops appending once the log passes its size cap', () => {
  withTmp((cwd) => {
    const file = logFile(cwd, 'run-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1), 'utf8'); // already over cap
    captureClaimDebug(cwd, 'run-1', 'runteam-write', { session_id: 's' });
    // the over-cap file is left untouched (no new line appended)
    assert.equal(fs.readFileSync(file, 'utf8').includes('runteam-write'), false);
  });
});

test('capturePlanGuardDebug: appends plan-guard deny lines', () => {
  withTmp((cwd) => {
    capturePlanGuardDebug(cwd, 'run-1', { filePath: '.traffic-one/coding.md', violations: ['architect-memory-baseline-gate'] });
    const file = path.join(cwd, '.traffic-one', 'runs', 'run-1', 'debug', 'plan-guard-deny.jsonl');
    assert.equal(fs.existsSync(file), true);
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(line.label, 'plan-guard-deny');
    assert.equal(line.filePath, '.traffic-one/coding.md');
  });
});
