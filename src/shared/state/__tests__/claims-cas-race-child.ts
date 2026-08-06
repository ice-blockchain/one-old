// src/shared/state/__tests__/claims-cas-race-child.ts
// The child half of the forked CAS race in claims-cas-race.test.ts. NOT a test
// file: `npm test` globs `*.test.ts`, so this is never collected as one.
//
// One process, one contender. The parent starts two of these and reads one JSON
// line from each. Real processes and not promises because the thing under test
// is an OS-level exclusive create: two contenders sharing this process's event
// loop would run one after the other and assert nothing.

import * as fs from 'fs';
import * as path from 'path';

import { createJsonExclusive } from '../../fsjson';
import { ensureRunAgentClaimResult } from '../run-agent';

interface Job {
  readonly mode: 'mint' | 'create';
  readonly cwd: string;
  readonly runId: string;
  readonly role: string;
  readonly sessionId: string;
  readonly barrier: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;

// A released barrier rather than a start time: importing the modules above costs
// ~1s under tsx, and any fixed head start long enough to cover that on a loaded
// machine is one the winner could also finish inside, which would quietly demote
// the race to two sequential calls. So each child announces that it is loaded
// and then SPINS — a bare existsSync loop, because the release has to be
// observed in microseconds; a timer or a watcher would hand the loser its
// callback a scheduler tick late.
fs.writeFileSync(path.join(job.barrier, `${job.sessionId}.ready`), '');
const go = path.join(job.barrier, 'go');
const abandonAt = Date.now() + 30_000;
while (!fs.existsSync(go)) {
  if (Date.now() > abandonAt) {
    process.stderr.write('barrier never released\n');
    process.exit(2);
  }
}

if (job.mode === 'mint') {
  const result = ensureRunAgentClaimResult(
    job.cwd,
    { currentRunId: job.runId },
    job.role,
    { session_id: job.sessionId },
    { toolName: 'task', agentType: job.role },
  );
  process.stdout.write(`${JSON.stringify({
    outcome: result.outcome,
    reason: result.reason,
    claimId: typeof result.value?.claimId === 'string' ? result.value.claimId : null,
    spawnIndex: typeof result.value?.spawnIndex === 'number' ? result.value.spawnIndex : null,
  })}\n`);
} else {
  // The write chokepoint addressed directly, with no claims lock in front of it,
  // so the exclusive create is the ONLY thing between two writers. This is the
  // half that survives the lock: a lease is stolen once its owner is dead
  // (locks.ts's reclaimStaleOwnedDirLock), and a lock directory removed by an
  // external sweep excludes nobody at all.
  const file = path.join(job.cwd, '.traffic-one', 'runs', job.runId, 'pending', `${job.role}.json`);
  process.stdout.write(`${JSON.stringify({
    create: createJsonExclusive(file, { role: job.role, sessionId: job.sessionId, status: 'pending' }),
  })}\n`);
}
