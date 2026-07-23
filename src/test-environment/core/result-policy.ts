import type { ReportSummary } from '../reporting/aggregate-report';

// UNSUPPORTED is a declared host-capability absence, not an uninspected result.
// SKIP and INCONCLUSIVE still fail strict releases, as do all assertion FAILs.
export function releaseResultFailed(
  summary: Pick<ReportSummary, 'fail' | 'skip' | 'inconclusive'>,
  strict: boolean,
): boolean {
  return summary.fail > 0 || (strict && summary.skip + summary.inconclusive > 0);
}
