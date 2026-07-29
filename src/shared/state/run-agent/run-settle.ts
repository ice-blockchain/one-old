// src/shared/state/run-agent/run-settle.ts
// Settling verified runs into the ledger and rotation checks.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson } from '../../fsjson';
import { isMaintenanceTerminal } from '../../maintenance/terminal';
import {
  activeRunClaimCount,
} from '../../run-settlement';

import {
  assignmentsFile,
  runDir,
  runLedgerFile,
} from './run-paths';
import {
  transitionRunStatus,
  type RunLedgerOutcome,
} from './ledger';
import {
  releaseRunClaims,
} from './claims-store';
import {
  buildRunReachedTerminalVerdict,
  digestDir,
  readDigest,
  reviewerDigestApprovedForRun,
  runHasExplicitBlockedQaOutcome,
  runHasQaEvidence,
  runLedgerStatusRecord,
  runProducedImplementerOutput,
  runReachedTerminalVerdict,
  runUsesStrictQaContract,
  shipperDigestCompleted,
  testerDigestPassedForRun,
} from './terminal-verdict';

// Reconcile a fully verified/shipped build into the central run ledger. This is
// intentionally separate from runReachedTerminalVerdict: callers performing a
// read-only probe do not mutate state, while lifecycle settlement can opt in.
export function settleTerminalRunLedger(
  cwd: string,
  runId: unknown,
  expectedOutcome?: Extract<RunLedgerOutcome, 'verified' | 'shipped'>,
): Rec | null {
  if (typeof runId !== 'string' || !runId) return null;
  const ledgerState = runLedgerStatusRecord(cwd, runId);
  if (ledgerState.status === 'completed'
    && (ledgerState.outcome === 'verified' || ledgerState.outcome === 'shipped')) {
    if (activeRunClaimCount(cwd, runId) > 0) return null;
    if (!expectedOutcome || expectedOutcome === ledgerState.outcome) {
      return transitionRunStatus(cwd, runId, {
        status: 'completed',
        outcome: ledgerState.outcome,
      });
    }
    if (ledgerState.outcome === 'shipped' && expectedOutcome === 'verified') return null;
    // verified→shipped continues below and still requires a positive shipper digest.
  }
  const preserveLegacyQaContract = !obj(readJson(runLedgerFile(cwd, runId), null));
  const shipperCompleted = shipperDigestCompleted(cwd, runId);
  if (expectedOutcome === 'shipped' && !shipperCompleted) return null;
  if (shipperCompleted && expectedOutcome !== 'verified') {
    releaseRunClaims(cwd, runId, 'terminal-shipped-evidence');
    return transitionRunStatus(cwd, runId, {
      status: 'completed',
      outcome: 'shipped',
      preserveLegacyQaContract,
    });
  }
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = reviewerDigestApprovedForRun(cwd, runId, reviewer);
  const testerPassed = testerDigestPassedForRun(cwd, runId, tester);
  if (!reviewerApproved || !testerPassed || !runHasQaEvidence(cwd, runId)) return null;
  releaseRunClaims(cwd, runId, 'terminal-verified-evidence');
  return transitionRunStatus(cwd, runId, {
    status: 'completed',
    outcome: 'verified',
    preserveLegacyQaContract,
  });
}

// Prompt-boundary "settled enough to rotate the run id" — used ONLY by the maintenance
// run-id rotation guard (triage-directive.beginFreshMaintenanceRun), NEVER by the mid-turn
// maintenance flip. A run that produced implementer output AND earned reviewer APPROVED +
// tester TESTS_GREEN is finished; rotating away from it at a prompt boundary is safe even if
// the QA-evidence gate didn't pass — otherwise a frontend build that skipped QA artifacts
// (and omitted the N/A escape) pins currentRunId forever while the project still flips to
// maintenance via anyRunProducedImplementerOutput, and the next feature reuses the stale run
// id + spawnIndex. The STRICT bar (runReachedTerminalVerdict, incl. the QA gate) is kept
// everywhere else. Both green verdicts co-occur only after the run is done, so this never
// rotates a genuinely in-flight (still-verifying) run.
export function runSettledForRotation(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  // Contract-v1 runs never rotate on textual verdicts alone: the strict parser,
  // screenshots, freshness, and full matrix must all have passed. Generic
  // maintenance blocked/failed markers are legacy settlement, not a v1 bypass.
  if (runUsesStrictQaContract(cwd, runId)) return buildRunReachedTerminalVerdict(cwd, runId);
  if (runReachedTerminalVerdict(cwd, runId)) return true;
  if (!runProducedImplementerOutput(cwd, runId) || runHasExplicitBlockedQaOutcome(cwd, runId)) return false;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = /\bAPPROVED\b/.test(reviewer) && !/\bCHANGES_REQUESTED\b/.test(reviewer);
  const testerPassed = /\b(TESTS_GREEN|APPROVED)\b/.test(tester) && !/\b(TESTS_FAILING|DELEGATED_OK)\b/.test(tester);
  return reviewerApproved && testerPassed;
}

export function maintenanceRunReachedTerminal(cwd: string, runId: string): boolean {
  try {
    const parsed = readJson(path.join(runDir(cwd, runId), 'maintenance.json'), null);
    const rec = obj(parsed);
    if (!rec || rec.version !== 1) return false;
    return isMaintenanceTerminal(rec);
  } catch {
    return false;
  }
}

// Schema-agnostic "an orchestrated run exists under <runId>" check — raw artifact
// EXISTENCE, never manifest parsing (so it survives the `roles`-schema deviation and
// any future shape). Used by the maintenance-rotation guard to decide whether a run is
// real before refusing to rotate its id. assignments.json OR an implementer/architect
// digest both prove the architect ran for this id.
export function runHasOrchestratedArtifacts(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  try {
    if (fs.existsSync(assignmentsFile(cwd, runId))) return true;
    const dd = digestDir(cwd, runId);
    return ['architect.md', 'frontend.md', 'backend.md', 'reviewer.md', 'tester.md',
      'senior-architect.md', 'senior-frontend.md', 'senior-backend.md', 'senior-reviewer.md', 'senior-tester.md']
      .some((n) => fs.existsSync(path.join(dd, n)));
  } catch {
    return false;
  }
}

// A run that settled `failed` while holding NOTHING: no assignments, no digest,
// no live claim. `failed` is the one ledger status with no transition out, so
// such a run is permanently unusable — no role can ever bind a claim in it — yet
// nothing is lost by replacing it. The prompt-boundary router uses this to fall
// through to maintenance triage (which mints a fresh id) instead of routing to
// the unresolved-run continuation forever, which is how a single sub-step
// failure used to wedge a project across sessions.
//
// Deliberately narrow, and deliberately NOT folded into runVerificationState:
// that predicate must keep reporting `nonterminal` for a failed ledger (an agent
// failure IS unresolved), and blocked runs keep their explicit user-authorized
// resume. Only an EMPTY failed run is replaceable — the artifact and claim
// checks are what stop this from discarding real work.
export function runIsEmptyFailedHusk(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (runLedgerStatusRecord(cwd, runId).status !== 'failed') return false;
  if (runHasOrchestratedArtifacts(cwd, runId)) return false;
  return activeRunClaimCount(cwd, runId) === 0;
}

// True when ANY run dir under .traffic-one/digests has a terminal verdict. The
// build-completion heuristic scans all run dirs (it does not assume currentRunId).
export function anyRunReachedTerminalVerdict(cwd: string): boolean {
  try {
    const base = path.join(cwd, '.traffic-one', 'digests');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && runReachedTerminalVerdict(cwd, entry.name)) return true;
    }
  } catch {
    // best-effort — no digests dir means nothing has reached verification
  }
  return false;
}

// True when ANY run dir under .traffic-one/digests has an IMPLEMENTER digest
// (frontend.md or backend.md) — proof the orchestrator got past planning and an
// implementer actually wrote code. WEAKER than a terminal verdict: it does NOT
// require a reviewer `APPROVED` + tester `TESTS_GREEN`. Used only at the prompt
// boundary by the maintenance flip, where the build turn has already ended — a
// build that produced real implementer output but never recorded a clean
// reviewer/tester verdict (interrupted verification, a role that skipped its
// digest, a multi-session resume) must still settle to maintenance so follow-ups
// get triaged, instead of staying pinned in "building" forever. The strict
// terminal-verdict gate still guards the mid-turn (PostToolUse) flip.
export function anyRunProducedImplementerOutput(cwd: string): boolean {
  try {
    const base = path.join(cwd, '.traffic-one', 'digests');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dd = digestDir(cwd, entry.name);
      // Accept both bare and senior-* implementer digest names. Cursor's write path can
      // emit senior-frontend.md / senior-backend.md; checking only the bare forms here
      // (while runHasOrchestratedArtifacts/readDigest accept both) would leave a
      // senior-*-only build wedged in 'building' at the prompt boundary.
      if (['frontend.md', 'backend.md', 'senior-frontend.md', 'senior-backend.md']
        .some((n) => fs.existsSync(path.join(dd, n)))) return true;
    }
  } catch {
    // best-effort — no digests dir means nothing has been implemented yet
  }
  return false;
}

// Resolve which assignment a writing agent owns. Prefer an indexed agentKey
// (`<role>#<spawnIndex>`), then a role-named agentKey, then the sole entry for the
// role. Null when the role maps to zero or ambiguously-many entries.
