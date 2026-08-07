// src/shared/state/__tests__/identity-drift-race-child.ts
// One host's SessionStart, as its own process. NOT a test file: `npm test` globs
// `*.test.ts`, so this is never collected as one.
//
// The parent starts one of these per host and reads a JSON line from each. Real
// processes because `reconcileRunIdentityDrift` is DESTRUCTIVE on a plurality
// condition (every loser is `releaseRunClaims`'d and transitioned to
// failed/agent-failed) and runs on EVERY SessionStart, so the input that matters
// is two hosts electing a survivor from the same on-disk run set at the same
// time. Two calls sharing one event loop run one after the other, by which point
// the first has already released the losers and the second sees no plurality at
// all — the exact condition under test, absent.

import * as fs from 'fs';
import * as path from 'path';

import { activeRunClaimCount } from '../../run-settlement';
import { reconcileRunIdentityDrift } from '../run-agent';

interface Job {
  readonly cwd: string;
  readonly barrier: string;
  readonly sessionId: string;
  /** The run THIS host believes it is in — the drifted pointer being repaired. */
  readonly pointsAt: string;
  /** Every run the fixture planted, so the child can report what it could see. */
  readonly runIds: readonly string[];
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;

// Same barrier idiom as claims-cas-race-child.ts: announce readiness, then SPIN
// on a bare existsSync. Importing the modules above costs ~1s under tsx, and any
// fixed head start large enough to cover that is one a whole reconciliation
// could also finish inside — which would silently demote this to two sequential
// passes and assert nothing.
fs.writeFileSync(path.join(job.barrier, `${job.sessionId}.ready`), '');
const go = path.join(job.barrier, 'go');
const abandonAt = Date.now() + 30_000;
while (!fs.existsSync(go)) {
  if (Date.now() > abandonAt) {
    process.stderr.write('barrier never released\n');
    process.exit(2);
  }
}

// What this host could see immediately before its pass — the same question
// `reconcileRunIdentityDrift` asks at identity-drift.ts:124 to decide whether a
// run is a drift candidate. Reported so the parent can say whether the plurality
// condition was genuinely live for BOTH hosts, rather than assuming it.
const observedClaims = Object.fromEntries(
  job.runIds.map((runId) => [runId, activeRunClaimCount(job.cwd, runId)]),
);

const state: Record<string, unknown> = { mode: 'new-project', currentRunId: job.pointsAt };
const startedAt = Date.now();
let changed: boolean | null = null;
let threw: string | null = null;
try {
  changed = reconcileRunIdentityDrift(job.cwd, state);
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
const finishedAt = Date.now();

process.stdout.write(`${JSON.stringify({
  sessionId: job.sessionId,
  changed,
  threw,
  startedAt,
  finishedAt,
  observedClaims,
  // The pointer this host would go on to use for the rest of its session.
  currentRunIdAfter: state.currentRunId,
})}\n`);
