// src/shared/state/__tests__/live-holder-lock-child.ts
// The holder half of live-holder-lock-theft.test.ts. NOT a test file: `npm test`
// globs `*.test.ts`, so this is never collected as one.
//
// One process, one holder. It takes the cursor spawn-observation lock and then
// STAYS INSIDE `mutate()` until the parent releases it. A promise in the
// parent's own process could not stand in for this: the property under test is
// that a second process enters the same critical section while the first is
// still executing it, and two callers sharing one event loop run one after the
// other by construction.

import * as fs from 'fs';
import * as path from 'path';

import { withCursorSpawnObservationLock } from '../run-agent/cursor-observations';

interface Job {
  readonly cwd: string;
  readonly runId: string;
  readonly barrier: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const inside = path.join(job.barrier, 'holder-inside');
const exited = path.join(job.barrier, 'holder-exited');
const release = path.join(job.barrier, 'release');

const held = withCursorSpawnObservationLock(job.cwd, job.runId, () => {
  // Announce the open critical section, then SPIN — the parent has to observe
  // the section while it is genuinely open, and a timer would hand control back
  // a scheduler tick late. Bounded so a wedged parent cannot orphan this.
  fs.writeFileSync(inside, String(process.pid));
  const abandonAt = Date.now() + 60_000;
  while (!fs.existsSync(release)) {
    if (Date.now() > abandonAt) return 'abandoned';
  }
  return 'held';
});

// Written AFTER mutate() returns, so the parent can distinguish "the holder is
// still in its critical section" from "the holder already finished".
fs.writeFileSync(exited, String(Date.now()));
process.stdout.write(`${JSON.stringify({ held })}\n`);
