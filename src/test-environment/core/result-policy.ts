import type { ReportSummary } from '../reporting/aggregate-report';

// A strict release is a certification claim, so a declared-but-unexercised
// capability is not enough: UNSUPPORTED must fail alongside SKIP and
// INCONCLUSIVE. Non-strict exploratory runs still report it separately.
export function releaseResultFailed(
  summary: Pick<ReportSummary, 'fail' | 'skip' | 'inconclusive'>
    & Partial<Pick<ReportSummary, 'unsupported' | 'hostUncertified' | 'manualUncertified'>>,
  strict: boolean,
): boolean {
  return summary.fail > 0 || (strict && (
    summary.skip + summary.inconclusive > 0
    || (summary.unsupported ?? 0) > 0
    || (summary.hostUncertified ?? 0) > 0
    || (summary.manualUncertified ?? 0) > 0
  ));
}
