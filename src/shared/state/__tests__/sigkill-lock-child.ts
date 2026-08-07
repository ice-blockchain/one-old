// src/shared/state/__tests__/sigkill-lock-child.ts
// The doomed holder half of sigkill-lock-recovery.test.ts. NOT a test file:
// `npm test` globs `*.test.ts`, so this is never collected as one.
//
// One process, one lease, taken through the PRODUCTION acquire and then never
// released — the parent SIGKILLs this process by pid while it is still inside
// `mutate()`. That is the whole point: SIGKILL runs no `finally`, no exit hook
// and no signal handler, so `releaseOwnedDirLock` never executes and the owner
// record left on disk is one that production wrote, not one a fixture typed.
//
// It cannot be a promise, a worker or an in-process fake. `processDefinitelyDead`
// asks the KERNEL whether the owner pid is gone, so the owner has to be a real
// process that really dies.

import * as fs from 'fs';
import * as path from 'path';

import { withOwnedDirLock } from '../run-agent/locks';

interface Job {
  /** 'hold' takes the lease properly; 'gap' stops where a kill between the
   * acquire's raw mkdir and its owner write would leave the directory. */
  readonly mode: 'hold' | 'gap';
  readonly lockDir: string;
  readonly barrier: string;
  readonly staleMs: number;
  readonly timeoutMs: number;
  readonly retryMs: number;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const inside = path.join(job.barrier, 'inside');

// Announce the open critical section, then SPIN. Bounded, so a parent that dies
// before it can kill this process cannot leave it burning a core for the rest of
// the session; the parent kills within a second of the marker appearing.
function holdUntilKilled(): void {
  fs.writeFileSync(inside, String(process.pid));
  const abandonAt = Date.now() + 30_000;
  while (Date.now() < abandonAt) { /* hold the lease until SIGKILL */ }
}

if (job.mode === 'gap') {
  // locks.ts's acquire is `fs.mkdirSync(lockDir)` and THEN
  // `fs.writeFileSync(ownerFile, …)`. A kill landing between those two lines
  // leaves exactly this: the lock directory published, with no owner sentinel
  // inside it and therefore no pid for any later reaper to interrogate.
  fs.mkdirSync(job.lockDir, { recursive: true });
  holdUntilKilled();
} else {
  withOwnedDirLock(
    job.lockDir,
    job.timeoutMs,
    job.staleMs,
    job.retryMs,
    new Int32Array(new SharedArrayBuffer(4)),
    holdUntilKilled,
  );
}

// Only reachable if the parent never killed this process, which every case
// treats as the measurement having failed rather than as a pass.
process.stdout.write('never-killed\n');
