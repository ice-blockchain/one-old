// Idempotent CLI wrapper around the central run-ledger transition helper.
// Orchestrator prose uses this instead of hand-editing run.json, so lifecycle
// outcomes remain validated and transition history cannot be accidentally lost.

import {
  describeTerminalSettleBlockers,
  releaseRunClaims,
  runLedgerStatusRecord,
  settleTerminalRunLedger,
  transitionRunStatus,
  type RunLedgerOutcome,
  type RunLedgerStatus,
} from '../../shared/state/run-agent';
import { sweepAfterTerminalSettlement } from '../../shared/retention';

interface RunStatusArgs {
  runId: string;
  status: RunLedgerStatus | '';
  outcome?: RunLedgerOutcome;
  reason?: string;
}

const STATUSES = new Set<RunLedgerStatus>(['planned', 'active', 'completed', 'blocked', 'failed']);
const OUTCOMES = new Set<RunLedgerOutcome>([
  'verified',
  'shipped',
  'review-cycle-cap',
  'test-cycle-cap',
  'environment-blocked',
  'agent-failed',
]);

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1]!.trim() : '';
}

export function parseRunStatusArgs(argv: readonly string[]): RunStatusArgs | null {
  const runId = valueAfter(argv, '--run-id');
  const statusValue = valueAfter(argv, '--status');
  const outcomeValue = valueAfter(argv, '--outcome');
  const reason = valueAfter(argv, '--reason');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) || !STATUSES.has(statusValue as RunLedgerStatus)) return null;
  if (outcomeValue && !OUTCOMES.has(outcomeValue as RunLedgerOutcome)) return null;
  if (reason && reason !== 'user-authorized-extra-cycle') return null;
  return {
    runId,
    status: statusValue as RunLedgerStatus,
    ...(outcomeValue ? { outcome: outcomeValue as RunLedgerOutcome } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): number {
  const args = parseRunStatusArgs(argv);
  if (!args) {
    process.stderr.write(
      'Usage: run-status.cjs --run-id <id> --status <planned|active|completed|blocked|failed> '
      + '[--outcome <verified|shipped|review-cycle-cap|test-cycle-cap|environment-blocked|agent-failed>] '
      + '[--reason user-authorized-extra-cycle]\n',
    );
    return 2;
  }
  const terminalOutcome = args.status === 'completed'
    && (args.outcome === 'verified' || args.outcome === 'shipped')
    ? args.outcome
    : null;
  // A run that ends WITHOUT a green verdict — a review/test cycle cap, an
  // environment block, or an outright agent failure — still holds every role
  // claim it staked forever: `releaseRunClaims` is reached only from the
  // verified and shipped branches of `settleTerminalRunLedger`. The held claims
  // do not veto this transition (the active-claim veto exists only on the
  // `completed` path), but they keep the dead run READING as live everywhere
  // claim liveness is consulted — settlement `activeClaims` stays positive,
  // pending/fallback claim files linger, and the spawn-index/identity paths
  // still count the run as occupied. Observed 12co: five claims held on a
  // failed run, the architect's four minutes after it finished. Same
  // "release BEFORE settling" invariant identity-drift documents.
  //
  // Deliberately NOT applied to `completed`: the active-claim veto on a
  // `verified` settlement is what stops a run being certified green while its
  // agents are still live, so releasing there would manufacture a fake green.
  // That path keeps its existing evidence-gated release.
  if (args.status === 'blocked' || args.status === 'failed') {
    releaseRunClaims(cwd, args.runId, `terminal-${args.outcome || args.status}`);
  }
  const ledger = terminalOutcome
    ? settleTerminalRunLedger(cwd, args.runId, terminalOutcome)
    : transitionRunStatus(cwd, args.runId, {
      status: args.status as RunLedgerStatus,
      ...(args.outcome ? { outcome: args.outcome } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
  if (!ledger) {
    // Name the concrete failed check. The old one-liner ("inspect run.json")
    // sent a live orchestrator (14cl) to the rollback-barrier MASK — run.json
    // physically reads status 'failed'/outcome 'agent-failed' for a run that is
    // canonically still 'validating' — and it invented an agent-death recovery
    // story from it. Never point at run.json without that caveat.
    if (terminalOutcome) {
      const blockers = describeTerminalSettleBlockers(cwd, args.runId, terminalOutcome);
      const detail = blockers.length > 0
        ? `${blockers.join('; ')}. Fix the named check(s), then re-run this exact command`
        : 'every evidence check passes, so the ledger/settlement write itself failed '
          + '(lock contention or an unwritable .traffic-one) — re-run this exact command';
      process.stderr.write(
        `run-status: ${args.status}/${terminalOutcome} rejected for run ${args.runId} — ${detail}. `
        + 'Note: status/outcome in run.json are a compatibility projection for older runtimes; '
        + 'canonicalStatus (and runtimeV2RollbackGuard.canonicalStatus) is the truth.\n',
      );
      return 1;
    }
    const from = runLedgerStatusRecord(cwd, args.runId).status ?? 'planned';
    process.stderr.write(
      `run-status: transition rejected for run ${args.runId} — the run ledger is `
      + `'${from}' and '${from}' -> '${args.status}'`
      + `${args.outcome ? ` (outcome '${args.outcome}')` : ''} is not a legal edge`
      + (from === 'blocked' && args.status === 'active'
        ? " without `--reason user-authorized-extra-cycle` (requires the user's explicit authorization)"
        : '')
      + '. Preserve the existing run. '
      + 'Note: status/outcome in run.json are a compatibility projection for older runtimes; '
      + 'canonicalStatus (and runtimeV2RollbackGuard.canonicalStatus) is the truth.\n',
    );
    return 1;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: ledger.runId,
    status: ledger.status,
    ...(ledger.outcome ? { outcome: ledger.outcome } : {}),
  })}\n`);
  // The run just reached a terminal ledger state — reclaim superseded artefacts
  // now instead of waiting for the next SessionStart. Never on planned/active.
  if (args.status === 'completed' || args.status === 'blocked' || args.status === 'failed') {
    sweepAfterTerminalSettlement(cwd);
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
