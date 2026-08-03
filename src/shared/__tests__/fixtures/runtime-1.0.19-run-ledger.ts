// Compatibility fixture copied from commit 860a6d6c
// (`src/shared/state/run-agent.ts`, Traffic One runtime 1.0.19).
//
// Keep these transition/outcome predicates byte-for-byte equivalent to that
// release. The fixture deliberately accepts only the parsed run.json record;
// runtime 1.0.19 never discovers or parses settlement-v2.json or
// verification-v2.json, so sibling V2 sidecars cannot change this result.

type RunLedgerStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'failed';
type RunLedgerOutcome =
  | 'verified'
  | 'shipped'
  | 'review-cycle-cap'
  | 'test-cycle-cap'
  | 'environment-blocked'
  | 'agent-failed';

const RUN_LEDGER_STATUSES = new Set<RunLedgerStatus>(['planned', 'active', 'completed', 'blocked', 'failed']);
const RUN_LEDGER_OUTCOMES = new Set<RunLedgerOutcome>([
  'verified',
  'shipped',
  'review-cycle-cap',
  'test-cycle-cap',
  'environment-blocked',
  'agent-failed',
]);

function isRunLedgerStatus(value: unknown): value is RunLedgerStatus {
  return typeof value === 'string' && RUN_LEDGER_STATUSES.has(value as RunLedgerStatus);
}

function isRunLedgerOutcome(value: unknown): value is RunLedgerOutcome {
  return typeof value === 'string' && RUN_LEDGER_OUTCOMES.has(value as RunLedgerOutcome);
}

function runLedgerTransitionAllowed(from: RunLedgerStatus, to: RunLedgerStatus, reason: unknown): boolean {
  if (from === to) return true;
  if (from === 'planned') return to === 'active' || to === 'blocked' || to === 'failed' || to === 'completed';
  if (from === 'active') return to === 'completed' || to === 'blocked' || to === 'failed';
  if (from === 'blocked') return to === 'active' && reason === 'user-authorized-extra-cycle';
  return false;
}

function outcomeAllowedForStatus(status: RunLedgerStatus, outcome: RunLedgerOutcome | undefined): boolean {
  if (!outcome) return status === 'planned' || status === 'active';
  if (status === 'completed') return outcome === 'verified' || outcome === 'shipped';
  if (status === 'blocked') {
    return outcome === 'review-cycle-cap' || outcome === 'test-cycle-cap' || outcome === 'environment-blocked';
  }
  return status === 'failed' && outcome === 'agent-failed';
}

export function runtime1019AcceptsTransition(
  runJson: unknown,
  patch: { status: unknown; outcome?: unknown; reason?: unknown },
): boolean {
  const existing = runJson && typeof runJson === 'object' && !Array.isArray(runJson)
    ? runJson as Record<string, unknown>
    : {};
  const currentStatus = isRunLedgerStatus(existing.status) ? existing.status : 'planned';
  const requestedStatus = isRunLedgerStatus(patch.status) ? patch.status : currentStatus;
  const requestedOutcome = isRunLedgerOutcome(patch.outcome)
    ? patch.outcome
    : undefined;
  return runLedgerTransitionAllowed(currentStatus, requestedStatus, patch.reason)
    && outcomeAllowedForStatus(requestedStatus, requestedOutcome);
}
