// src/runners/qa-evidence/__tests__/audit-not-measured.test.ts
// An audit that was KILLED measured no performance budget, and saying it failed
// is the same laundering as saying it passed, with the sign flipped.
//
// `runBoundedCommand` rejects a bound with `Lighthouse timed out after Nms` and
// a signal death with `Lighthouse exited SIGTERM: …`. The catch in
// `runLighthouseOnOwnedServer` matched a Chrome-missing pattern in that prose
// and called everything else `status: 'failed'` — so an audit killed at its own
// bound, and a Chrome the OOM killer took, were both reported as a PRODUCT
// failure. The stack lane argues against exactly this in its own words:
// "`failed` invents a red nobody observed."
//
// The repair is the one the other two lanes already use: the classification
// travels as a KIND on the rejection rather than as prose, and a switch over
// `BOUNDED_PROCESS_KINDS` decides it, so a new ending cannot default to a
// verdict here either. The rows below are the two endings the peer named, driven
// through the real `runLighthouseOnOwnedServer`, plus the one that must stay
// `failed` — because a lane that answers `blocked-environment` to everything has
// only moved the lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CHECK_INCONCLUSIVE_PREFIX } from '../../../shared/qa-report-v2';
import {
  auditNotMeasured,
  boundedCommandOutcome,
  runBoundedCommand,
  runLighthouseOnOwnedServer,
} from '../lighthouse';
import { BOUNDED_PROCESS_KINDS, type BoundedProcessKind } from '../native-process';
import { type LoadedRun } from '../run-context';
import { type OwnedServer, type RunnerArgs } from '../types';

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX signals' : false };
const TEST_TIMEOUT_MS = 30_000;

// THE UNION, not the two shapes the tests below happen to build.
//
// `unavailable` is on the not-measured side here and on the EXEMPT side in
// stack.ts, and that difference is deliberate rather than an inconsistency: a
// project that declares no test command has nothing to run, while an audit that
// never started measured no budget. The only route to `failed` left is a
// Lighthouse that ran, reported, and exited non-zero — which is `completed`
// with no signal, the single null below.
test('every way a bounded audit can end is decided, and only one of them is a verdict', () => {
  const measured = BOUNDED_PROCESS_KINDS
    .filter((kind) => auditNotMeasured({ kind, signal: null }) === null);
  assert.deepEqual(measured, ['completed'], 'only a Lighthouse that ran to an exit code has measured anything');
  assert.notEqual(
    auditNotMeasured({ kind: 'completed', signal: 'SIGKILL' }),
    null,
    'a Chrome the OOM killer took is `completed` by kind and measured nothing — the signal is the whole difference',
  );
  // The fail-closed backstop, for a kind that arrives through a cast or an older
  // sidecar: an ending nobody classified must never read as a measurement.
  assert.notEqual(
    auditNotMeasured({ kind: 'reaped-by-cgroup' as BoundedProcessKind, signal: null }),
    null,
  );
});

test('a bounded audit that outruns its bound rejects with the ending, not just with prose', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-audit-'));
  try {
    const error = await runBoundedCommand('/bin/sh', ['-c', 'sleep 30'], dir, 300).then(
      () => null,
      (rejected: unknown) => rejected,
    );
    assert.ok(error instanceof Error, 'the bound must reject');
    assert.match(error.message, /timed out after 300ms/);
    const outcome = boundedCommandOutcome(error);
    assert.deepEqual(outcome, { kind: 'timeout', signal: null }, 'and the rejection must carry WHY, in the channel the caller reads');
    assert.notEqual(auditNotMeasured(outcome!), null, 'a bound that fired measured nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A project-local `lighthouse` that does whatever the caller says. */
function fakeAudit(dir: string, body: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'lighthouse');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

const LOADED = {
  contract: { contractHash: 'contract', changedRoutes: ['/'] },
  sourceHash: 'source',
  fingerprint: 'fingerprint',
  manifest: { files: [], manifestHash: 'build', outputRoot: '.' },
} as unknown as LoadedRun;

async function auditOutcome(body: string): Promise<{ status: string; blockerSummary?: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-audit-run-'));
  try {
    fakeAudit(dir, body);
    const args = {
      command: 'browser',
      projectRoot: dir,
      runId: 'R',
      buildDir: 'dist',
      withLighthouse: true,
      timeoutMs: 1_000,
    } as unknown as RunnerArgs;
    const owned = { url: 'http://127.0.0.1:1', startedAt: new Date().toISOString() } as unknown as OwnedServer;
    const result = await runLighthouseOnOwnedServer(args, LOADED, owned);
    return { status: result.status, blockerSummary: result.blockerSummary };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// THE OOM-KILLED CHROME, which is the shape that costs a developer the most: the
// audit is told its performance budget failed when what happened is that the
// kernel took its browser. Its own SIGKILL stands in for the kernel's — the
// runner cannot tell the two apart, which is the point.
test('an audit killed by a signal is an environment block, not a failed budget', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await auditOutcome('kill -9 $$');
  assert.equal(result.status, 'blocked-environment', 'nobody observed a slow page here');
  assert.ok(
    String(result.blockerSummary).startsWith(CHECK_INCONCLUSIVE_PREFIX),
    `the marker is what keeps a downstream reader from excusing it: ${result.blockerSummary}`,
  );
  assert.match(String(result.blockerSummary), /SIGKILL/, 'and the cause must be named');
});

// RULE 1, transplanted from the latency-budget discipline: never manufacture an
// inconclusive where there was a verdict. A Lighthouse that RAN and exited
// non-zero has reported on the product, and that is a red.
test('an audit that ran and exited non-zero is still a failure', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await auditOutcome('echo "audit finished with a low score" >&2\nexit 1');
  assert.equal(result.status, 'failed', 'the audit ran; its verdict is the product\'s');
  assert.ok(
    !String(result.blockerSummary).startsWith(CHECK_INCONCLUSIVE_PREFIX),
    `a run that produced a verdict must not carry the inconclusive marker: ${result.blockerSummary}`,
  );
});

// And the pattern the KIND cannot see, which is why it stays: a Lighthouse that
// ran, exited non-zero, and said in its own output that it could not launch a
// browser. `completed` with no signal is a verdict by kind; the prose is the
// only evidence that it is not one about the product.
test('an audit that ran but could not launch a browser stays an environment block', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await auditOutcome('echo "Chrome could not be found or launched" >&2\nexit 1');
  assert.equal(result.status, 'blocked-environment');
});
