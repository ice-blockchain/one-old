import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { captureClaimDebug, capturePlanGuardDebug } from '../claim-capture';
import { drainStateWrites } from '../state-write-log';

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

// ── decision-log hand-off: both captures announce their write outcome ──────
// so a decision record built while one of these ran can see it in
// `stateWrites` (see state-write-log.ts / decision-log.ts).
//
// Announced by the CHOKEPOINT (fsjson.ts's appendTextFile) rather than from
// inside these two functions. They each used to record it a second time under
// their own op label, which after the chokepoint was instrumented produced two
// records for one write — and the second one's errno came from a `catch` around
// statSync and JSON.stringify as well as the write, so a non-write failure could
// be reported as a failed write. The path already says which capture it was.

test('captureClaimDebug reports its write to the state-write-log collector, success and failure', () => {
  withTmp((cwd) => {
    drainStateWrites(); // clear any leakage from an earlier test in this process
    captureClaimDebug(cwd, 'run-1', 'runteam-write', { session_id: 's' });
    const records = drainStateWrites();
    assert.equal(records.length, 1, 'one write, one record');
    assert.equal(records[0]?.op, 'append-text');
    assert.equal(records[0]?.ok, true);
    assert.equal(records[0]?.path, logFile(cwd, 'run-1'));

    // Force a real failure: replace the debug dir with a file so mkdirSync underneath it fails.
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'run-2');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'debug'), 'not a directory', 'utf8');
    captureClaimDebug(cwd, 'run-2', 'runteam-write', { session_id: 's' });
    const [failed] = drainStateWrites();
    assert.equal(failed?.op, 'append-text');
    assert.equal(failed?.ok, false);
    assert.equal(failed?.path, logFile(cwd, 'run-2'));
    assert.ok(failed?.errno, 'a real fs failure must carry an errno code');
  });
});

test('capturePlanGuardDebug reports its write to the state-write-log collector', () => {
  withTmp((cwd) => {
    drainStateWrites();
    capturePlanGuardDebug(cwd, 'run-1', { filePath: 'x.ts' });
    const records = drainStateWrites();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.op, 'append-text');
    assert.equal(records[0]?.ok, true);
    assert.match(records[0]?.path ?? '', /plan-guard-deny\.jsonl$/);
  });
});
