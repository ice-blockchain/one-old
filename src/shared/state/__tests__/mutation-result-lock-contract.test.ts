// src/shared/state/__tests__/mutation-result-lock-contract.test.ts
// One table over every remaining lock-taking mutation in state/run-agent/**:
// with the lock it needs held by another live process, each must answer
// `unavailable` — and specifically NOT `precondition-failed`.
//
// This is regression prevention, not a bug hunt. mutation-results.test.ts already
// proves the harm at the three sites where a lost result changed a decision. The
// sites below are advisory or post-hoc observations of a child that already
// started, so today nothing user-visible breaks when one of them loses its lock.
// The whole VALUE of the change, though, is that a caller can tell the two
// answers apart — and nothing asserted that at these sites. A later refactor that
// collapsed `unavailable` back into `false`, or that reported a contended lock as
// `precondition-failed` (permanent — a caller that retries it retries forever),
// would have passed green at every one of them.
//
// Each row is checked TWICE: contended, where it must be `unavailable` with the
// reason an operator reads; and uncontended in a fresh project, where it must NOT
// be `unavailable`. The second half is what keeps a row honest — without it a row
// whose preconditions were mis-set, or that reported `unavailable` for an
// unrelated refused write, would pass while measuring nothing about the lock.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  disownConflictedRoleAgentResult,
  ensureRunLedgerResult,
  markRunAgentReplacedIfMatchesResult,
  markRunAgentReplacedResult,
  recordRunAgentResult,
  recordRunStackDriftResult,
  releaseRunClaimsResult,
  retireUnverifiedCodexRunAgentResult,
  type MutationResult,
  type RunAgentEntry,
} from '../run-agent';
// Not re-exported by the barrel — its only product caller is the boolean wrapper
// in the same module — so it is imported where it lives rather than widening the
// public surface of the state layer for a test.
import { backfillRunLedgerFingerprintResult } from '../run-agent/identity-drift';
// Same reason, one directory over: its two product callers both live inside
// state/run-agent/**.
import { annotateClaimRoleSourceResult } from '../run-agent/context-resolve';
import { holdRunLock, type RunLockName } from './owned-lock-fixture';

const RUN_ID = 'run-lock-contract';
const ROLE = 'senior-backend';
const FROZEN_FINGERPRINT = 'fp-frozen-identity';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lock-contract-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', RUN_ID), { recursive: true });
  return dir;
}

function runFile(cwd: string, name: string): string {
  return path.join(cwd, '.traffic-one', 'runs', RUN_ID, name);
}

const codexEntry: RunAgentEntry = {
  agentId: '019f69ff-0000-7000-8000-0000000000aa',
  resumeId: '019f69ff-0000-7000-8000-0000000000aa',
  role: ROLE,
  model: 'gpt-5.6-terra-medium',
  agentType: ROLE,
  parentSessionId: 'parent-session',
  recordedAt: new Date().toISOString(),
  tasks: 1,
  replaced: false,
};

interface Row {
  /** The site, numbered when it is one of the eleven, so a failure names it directly. */
  readonly site: string;
  readonly lock: RunLockName;
  /** Everything the call needs in order to REACH the lock. A row whose
   * preconditions are unmet never gets there, and the uncontended half of the
   * check is what catches that. */
  readonly setup?: (cwd: string) => void;
  readonly invoke: (cwd: string) => MutationResult<unknown>;
  /** The `reason` an operator reads. Only the sweep names WHICH lock, because it
   * takes two and a caller cannot otherwise tell which half it lost. */
  readonly reason: string;
  /** What the same call answers when the lock is free — asserted only to be
   * something OTHER than `unavailable`. */
  readonly uncontended: 'applied' | 'precondition-failed';
}

/** A claimed-agent file carrying a stack fingerprint: what backfill inherits
 * from. Written directly because the ledger must stay unstamped, which the
 * claim-minting path would not leave it. */
function seedFingerprintedClaim(cwd: string): void {
  fs.writeFileSync(runFile(cwd, 'claimed-agent.json'), JSON.stringify({
    version: 1,
    runId: RUN_ID,
    claimId: `${ROLE}-1-seed`,
    role: ROLE,
    status: 'claimed',
    stackFingerprint: FROZEN_FINGERPRINT,
  }), 'utf8');
}

const ANNOTATED_CLAIM_KEY = 'annotated-thread';
const ANNOTATED_CLAIM_ID = `${ROLE}-1-annotated`;
const ANNOTATED_EVIDENCE = {
  role: ROLE,
  source: 'codex-session-meta-agent-path',
  authority: 'authoritative' as const,
};

/** The claim `annotateClaimRoleSourceResult` compare-and-swaps against, unstamped
 * so the annotation has work to do and its lock is therefore load-bearing. */
function seedAnnotatableClaim(cwd: string): void {
  fs.writeFileSync(runFile(cwd, `${ANNOTATED_CLAIM_KEY}.json`), JSON.stringify({
    version: 1,
    runId: RUN_ID,
    claimId: ANNOTATED_CLAIM_ID,
    role: ROLE,
    spawnIndex: 1,
    status: 'claimed',
    sessionId: ANNOTATED_CLAIM_KEY,
  }), 'utf8');
}

const ROWS: readonly Row[] = [
  {
    // The twelfth site, found after the eleven: the boolean claims lock made a
    // contended lock indistinguishable from a lost claim CAS, and its second
    // caller turned that into "this hook resolves no role" (run-agent.test.ts, 'a
    // contended claims lock cannot un-resolve a Codex child whose claim already
    // carries the proven role'). Unlike #4 it is importable, so the contract is
    // asserted here rather than only at its product surfaces.
    site: 'annotateClaimRoleSourceResult (claims lock)',
    lock: 'claims',
    setup: seedAnnotatableClaim,
    invoke: (cwd) => annotateClaimRoleSourceResult(cwd, RUN_ID, ANNOTATED_CLAIM_KEY, {
      role: ROLE,
      claimId: ANNOTATED_CLAIM_ID,
    }, ANNOTATED_EVIDENCE),
    reason: 'lock-unavailable',
    uncontended: 'applied',
  },
  {
    site: '#1 disownConflictedRoleAgentResult (registry lock)',
    lock: 'registry',
    invoke: (cwd) => disownConflictedRoleAgentResult(cwd, RUN_ID, ROLE, ['thread-a'], 'model-conflict'),
    reason: 'lock-unavailable',
    uncontended: 'precondition-failed',
  },
  {
    // The sweep's SECOND lock, separable from the claims-lock case already
    // covered in mutation-results.test.ts by holding only this one: the claims
    // half then applies and the fallback half is the only thing that fails.
    site: '#3 releaseRunClaimsResult (fallback-claims lock)',
    lock: 'fallbackClaims',
    invoke: (cwd) => releaseRunClaimsResult(cwd, RUN_ID, 'settled'),
    reason: 'fallback-lock-unavailable',
    uncontended: 'applied',
  },
  {
    site: '#5 retireUnverifiedCodexRunAgentResult (registry lock)',
    lock: 'registry',
    invoke: (cwd) => retireUnverifiedCodexRunAgentResult(cwd, RUN_ID, ROLE, codexEntry, 'model-drift'),
    reason: 'lock-unavailable',
    uncontended: 'precondition-failed',
  },
  {
    site: '#6 backfillRunLedgerFingerprintResult (ledger lock)',
    lock: 'ledger',
    setup: seedFingerprintedClaim,
    invoke: (cwd) => backfillRunLedgerFingerprintResult(cwd, RUN_ID),
    reason: 'lock-unavailable',
    uncontended: 'applied',
  },
  {
    site: '#7 recordRunStackDriftResult (ledger lock)',
    lock: 'ledger',
    // Drift needs a FROZEN identity to have drifted from, so this row stamps the
    // ledger where the row above deliberately leaves it unstamped.
    setup: (cwd) => {
      const stamped = ensureRunLedgerResult(cwd, RUN_ID, {
        status: 'active',
        kind: 'contract',
        stackFingerprint: FROZEN_FINGERPRINT,
      });
      assert.equal(stamped.outcome, 'applied');
    },
    invoke: (cwd) => recordRunStackDriftResult(cwd, { currentRunId: RUN_ID }, 'fp-observed-elsewhere'),
    reason: 'lock-unavailable',
    uncontended: 'applied',
  },
  {
    site: '#9 markRunAgentReplacedResult (registry lock)',
    lock: 'registry',
    invoke: (cwd) => markRunAgentReplacedResult(cwd, RUN_ID, ROLE),
    reason: 'lock-unavailable',
    uncontended: 'precondition-failed',
  },
  {
    site: '#10 markRunAgentReplacedIfMatchesResult (registry lock)',
    lock: 'registry',
    invoke: (cwd) => markRunAgentReplacedIfMatchesResult(cwd, RUN_ID, ROLE, codexEntry.agentId),
    reason: 'lock-unavailable',
    uncontended: 'precondition-failed',
  },
  {
    site: '#11 recordRunAgentResult (registry lock)',
    lock: 'registry',
    invoke: (cwd) => recordRunAgentResult(cwd, RUN_ID, ROLE, { agentId: codexEntry.agentId }),
    reason: 'lock-unavailable',
    uncontended: 'applied',
  },
];

function prepared(row: Row): string {
  const cwd = project();
  const ledger = ensureRunLedgerResult(cwd, RUN_ID, { status: 'active', kind: 'contract' });
  assert.equal(ledger.outcome, 'applied', `${row.site}: the run must exist before the row runs`);
  row.setup?.(cwd);
  return cwd;
}

test('every lock-taking run-agent mutation reports a contended lock as unavailable, never precondition-failed', () => {
  for (const row of ROWS) {
    const contended = prepared(row);
    holdRunLock(contended, RUN_ID, row.lock);
    const held = row.invoke(contended);

    assert.notEqual(held.outcome, 'precondition-failed',
      `${row.site}: a contended lock is TRANSIENT. Reported as precondition-failed, a caller that retries it retries forever.`);
    assert.equal(held.outcome, 'unavailable',
      `${row.site}: expected unavailable with the ${row.lock} lock held, got ${held.outcome} (${held.reason})`);
    assert.equal(held.reason, row.reason,
      `${row.site}: the reason is the field an operator reads`);
    assert.equal(held.value, null,
      `${row.site}: a mutation that did not run must not hand back a value`);

    // The row measures the LOCK and nothing else: free the lock, keep the setup.
    const free = row.invoke(prepared(row));
    assert.notEqual(free.outcome, 'unavailable',
      `${row.site}: with the lock free this call must not be unavailable, or the row above proves nothing about the lock (got ${free.reason})`);
    assert.equal(free.outcome, row.uncontended,
      `${row.site}: uncontended outcome drifted — got ${free.outcome} (${free.reason})`);
  }
});

// Two of the eleven are deliberately absent from the table above, and both would
// have been vacuous rows.
//
// #4 annotateCodexRegistryEvidence is module-private, so a row here would mean
// exporting a helper no product code calls. Its one internal caller no longer
// maps both answers to the same terminal verdict, though: validateCodexLiveRunAgent
// reports the contended lock as `codex-registry-evidence-lock-unavailable` and
// keeps `codex-registry-evidence-cas-lost` for the lost CAS, which is the
// distinction this table exists to protect. It is asserted at that product
// surface instead — run-agent.test.ts, 'a contended registry lock cannot report a
// verified Codex reuse as a lost evidence CAS' — with the same contended/free
// pair of halves every row above uses.
//
// #8 refreshCursorRunAgentFromTranscriptCache returns `RunAgentEntry | null`. With
// the registry lock held for the whole call, `unavailable` and
// `precondition-failed` are both `null`, so a row here could not fail. The
// difference it makes is control flow — `unavailable` ABORTS the candidate scan
// where a precondition failure moves to the next candidate — which is only
// observable with two candidates and the lock released between them.
//
// This test exists so that stays true by assertion rather than by memory: if
// either function ever grows a three-valued public face, it belongs in ROWS.
test('the table covers every lock-taking mutation that exposes a three-valued result', () => {
  assert.equal(ROWS.length, 9);
  assert.deepEqual(
    ROWS.map((row) => row.lock).filter((lock, index, all) => all.indexOf(lock) === index).sort(),
    ['claims', 'fallbackClaims', 'ledger', 'registry'],
    'all four run-scoped locks now have a row; the claims lock is additionally covered by mutation-results.test.ts (the mint and the sweep)',
  );
});
