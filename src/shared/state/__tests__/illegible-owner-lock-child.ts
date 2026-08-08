// src/shared/state/__tests__/illegible-owner-lock-child.ts
// One contender for the mutual-exclusion check in
// illegible-owner-lock-wedge.test.ts. Separate PROCESSES are the whole point:
// the reaper's compare-and-swap is a claim about two OS processes racing the
// same directory, and two closures in one process would serialize on the
// runtime rather than on the lock.

import * as fs from 'node:fs';

import { withOwnedDirLock } from '../run-agent/locks';

const args = JSON.parse(process.argv[2] ?? '{}') as {
  lockDir: string;
  log: string;
  ready: string;
  go: string;
  holdMs: number;
  timeoutMs: number;
  staleMs: number;
  retryMs: number;
};

// A start barrier, so every contender reads the SAME illegible sentinel and the
// reapers genuinely race. Staggered starts would let the first one replace the
// sentinel with a legible, fresh one of its own, and the rest would then be
// refused for an ordinary reason — which looks identical from the log and would
// make the mutual-exclusion claim below vacuous.
fs.writeFileSync(args.ready, String(process.pid));
const startBy = Date.now() + 60_000;
while (!fs.existsSync(args.go)) {
  if (Date.now() > startBy) throw new Error('start barrier never opened');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

const held = withOwnedDirLock(
  args.lockDir, args.timeoutMs, args.staleMs, args.retryMs,
  new Int32Array(new SharedArrayBuffer(4)),
  () => {
    // Appends, not writes: O_APPEND on a small line is the one way several
    // processes can share a log without a lock of its own — which this test
    // cannot use, since the lock is the thing under test.
    fs.appendFileSync(args.log, `IN ${process.pid}\n`);
    const until = Date.now() + args.holdMs;
    while (Date.now() < until) { /* stay in the critical section */ }
    fs.appendFileSync(args.log, `OUT ${process.pid}\n`);
  },
);

process.stdout.write(held ? 'held' : 'missed');
