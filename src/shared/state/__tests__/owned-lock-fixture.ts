// src/shared/state/__tests__/owned-lock-fixture.ts
// Hold one of the run-scoped owned-dir locks from the TEST process, so a
// mutation under test reports `unavailable` instead of doing its work. NOT a
// test file: `npm test` globs `*.test.ts`, so this is never collected as one.
//
// The owner sentinel names THIS process and is stamped now, which is what makes
// the lease unstealable: state/run-agent/locks.ts reclaims a lease only when its
// owner pid is definitely dead (ESRCH) or the directory is empty and older than
// staleMs. So every contender times out on its own 2s budget and none of them
// takes the lock out from under the test.

import * as fs from 'fs';
import * as path from 'path';

/** The four run-scoped lock directories, each named by the module that owns it.
 * Kept as literals rather than imported because every one of these path helpers
 * is module-private; a name that drifts fails LOUDLY (the mutation acquires the
 * lock, does its work, and the row's `unavailable` assertion fails) rather than
 * quietly turning a row vacuous. */
const LOCK_DIRS = {
  /** claims-store.ts — runAgentClaimsLockDir */
  claims: '.agent-claims.lock',
  /** fallback-claims.ts — fallbackClaimsLockDir */
  fallbackClaims: '.claims.lock',
  /** registry.ts — agentRegistryLockDir */
  registry: '.agents.lock',
  /** ledger.ts — runLedgerLockDir */
  ledger: '.run-ledger.lock',
} as const;

export type RunLockName = keyof typeof LOCK_DIRS;

export function runLockDir(cwd: string, runId: string, lock: RunLockName): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, LOCK_DIRS[lock]);
}

export function holdRunLock(cwd: string, runId: string, lock: RunLockName): void {
  const dir = runLockDir(cwd, runId, lock);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.owner-held-by-test.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
  );
}
