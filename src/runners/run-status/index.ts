// Idempotent CLI wrapper around the central run-ledger transition helper.
// Orchestrator prose uses this instead of hand-editing run.json, so lifecycle
// outcomes remain validated and transition history cannot be accidentally lost.

import {
  settleTerminalRunLedger,
  transitionRunStatus,
  type RunLedgerOutcome,
  type RunLedgerStatus,
} from '../../shared/state/run-agent';

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
  const ledger = terminalOutcome
    ? settleTerminalRunLedger(cwd, args.runId, terminalOutcome)
    : transitionRunStatus(cwd, args.runId, {
      status: args.status as RunLedgerStatus,
      ...(args.outcome ? { outcome: args.outcome } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
  if (!ledger) {
    process.stderr.write('run-status: transition rejected; preserve the existing run and inspect run.json.\n');
    return 1;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: ledger.runId,
    status: ledger.status,
    ...(ledger.outcome ? { outcome: ledger.outcome } : {}),
  })}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
