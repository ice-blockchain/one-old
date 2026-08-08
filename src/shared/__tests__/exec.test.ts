// src/shared/__tests__/exec.test.ts
// The ONE process/exec layer's two properties: every subprocess is bounded, and
// the four things that used to arrive as `code: 1` are separable.
//
// Why this file exists. `exec.run` was `spawnSync(cmd, args, { cwd, encoding })`
// with NO timeout, and it is reachable from a hook: SessionStart ->
// session-start-lib.ts's ensureOpenCodeDelegationReady -> git-init.ts's
// ensureInitialCommit issues up to eight git subprocesses through it. A git that
// blocks on an index.lock, a credential prompt, or an unreachable filesystem
// therefore hung the hook with no bound at all. The second half is the same
// defect one layer up: `code: typeof result.status === 'number' ? … : 1` gave a
// hang, a missing binary and a signal-kill the SAME value that `git rev-parse
// --verify --quiet HEAD` returns to mean "this repo has no commits".

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { EXEC_DEFAULT_TIMEOUT_MS, exec, execTimeoutMs } from '../exec';

/** A node child that outlives any timeout we would give it. */
const SLEEP_FOREVER = 'setTimeout(() => {}, 60_000)';

test('exec.runResult reports a bounded overrun as timed-out, not as an exit code', () => {
  const started = Date.now();
  const outcome = exec.runResult(process.execPath, ['-e', SLEEP_FOREVER], { timeoutMs: 250 });
  const elapsed = Date.now() - started;

  assert.equal(outcome.kind, 'timed-out', `expected timed-out, got ${JSON.stringify(outcome)}`);
  if (outcome.kind === 'timed-out') assert.equal(outcome.timeoutMs, 250);
  // The bound is the point: without one this call never returns. A generous
  // ceiling (40x the bound) keeps the assertion about "it was bounded at all"
  // rather than about this machine's scheduling.
  assert.ok(elapsed < 250 * 40, `the call took ${elapsed} ms against a 250 ms bound — it was not bounded`);
});

test('exec.run maps a timeout to the historical code 1, unchanged', () => {
  // The wrapper's contract is behaviour-identity with the `typeof status ===
  // 'number' ? status : 1` it replaced — the same relationship readJson has to
  // readJsonResult. A timeout is a non-numeric status, so it is a 1.
  const result = exec.run(process.execPath, ['-e', SLEEP_FOREVER], { timeoutMs: 250 });
  assert.equal(result.code, 1);
});

test('exec.runResult separates a missing binary from a real non-zero exit', () => {
  const missing = exec.runResult(
    path.join(os.tmpdir(), 't1-no-such-binary-9d3f1a', 'nope'), [], { timeoutMs: 5_000 },
  );
  assert.equal(missing.kind, 'not-run', `expected not-run, got ${JSON.stringify(missing)}`);

  const exited = exec.runResult(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 5_000 });
  assert.equal(exited.kind, 'exited');
  if (exited.kind === 'exited') assert.equal(exited.code, 1);

  // Both are `code: 1` through the legacy wrapper — which is exactly why the
  // discriminated sibling had to exist for the callers that must tell them
  // apart (see git-init.ts's gitProbe).
  assert.equal(exec.run(path.join(os.tmpdir(), 't1-no-such-binary-9d3f1a', 'nope'), []).code, 1);
  assert.equal(exec.run(process.execPath, ['-e', 'process.exit(1)']).code, 1);
});

test('exec.runResult still reports an ordinary success verbatim', () => {
  const outcome = exec.runResult(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 5_000 });
  assert.equal(outcome.kind, 'exited');
  if (outcome.kind === 'exited') {
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout, 'hi');
  }
});

test('a caller that names no bound still gets one', () => {
  // The anti-regression assertion for the actual defect: the default must be a
  // finite number that spawnSync will honour, not `undefined`. Asserting the
  // VALUE would only restate the constant, so this asserts the property that
  // makes the constant matter, plus the precedent it was borrowed from
  // (runners/opencode/git-sandbox.ts's `timeout = 60_000` default).
  assert.equal(Number.isFinite(EXEC_DEFAULT_TIMEOUT_MS), true);
  assert.ok(EXEC_DEFAULT_TIMEOUT_MS > 0, 'a non-positive default would disable the bound');

  // The resolution itself, at the seam runResult uses. `spawnSync` treats an
  // `undefined` timeout as "no timeout", so a default that stops being applied
  // restores the unbounded hang while every other assertion in this file — all
  // of which name their own bound — stays green.
  assert.equal(execTimeoutMs(), EXEC_DEFAULT_TIMEOUT_MS, 'a caller that names no bound was given none');
  assert.equal(execTimeoutMs({}), EXEC_DEFAULT_TIMEOUT_MS);
  assert.equal(execTimeoutMs({ cwd: os.tmpdir() }), EXEC_DEFAULT_TIMEOUT_MS);
  assert.equal(execTimeoutMs({ timeoutMs: 250 }), 250, 'an explicit bound must still win');

  const sandbox = fs.readFileSync(
    path.join(__dirname, '..', '..', 'runners', 'opencode', 'git-sandbox.ts'), 'utf8',
  );
  assert.ok(
    sandbox.includes(`timeout = ${EXEC_DEFAULT_TIMEOUT_MS.toLocaleString('en-US').replace(/,/g, '_')}`),
    'EXEC_DEFAULT_TIMEOUT_MS claims to be borrowed from git-sandbox.ts\'s bounded git exec default; '
    + 'that default no longer reads as the same number, so the citation is stale.',
  );
});
