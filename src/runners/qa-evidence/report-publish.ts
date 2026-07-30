// src/runners/qa-evidence/report-publish.ts
// Per-check truth for QaReportV2 checks plus the runner's progress heartbeat.
//
// Before 1.0.37 every required check got a blanket status derived from the
// overall report status ("Runtime QA evidence did not pass." on all nine ids,
// including network-errors with empty arrays, and the Lighthouse-missing
// blocker stamped onto stack-build/playwright/dom checks that never ran —
// observed 8co). Checks are now computed from the evidence that actually
// exists; checks that could not run are 'not-applicable' with the blocker
// named. The validator is NOT relaxed: a green report still requires every
// required check 'passed', so fake-green stays impossible.

import { type QaReportV2 } from '../../shared/qa-report-v2';

type QaCheck = QaReportV2['checks'][number];
type ReportRoutes = QaReportV2['routes'];
type ReportViewport = ReportRoutes[number]['viewports'][number];

export interface CheckEvidenceInput {
  routes: ReportRoutes;
  visual: boolean;
  playwrightOk: boolean;
  launchBlocker: string | null;
  servedOk: boolean;
  blockerSummary?: string;
}

const RUNNER_PASS_SUMMARY = 'Executed by traffic-one-qa-runner.';

function bounded(value: string): string {
  // Check summaries must satisfy the schema's safe-string rule: no control
  // characters, 1..500 chars. Filter by char code — no control characters may
  // appear in this source file either.
  let stripped = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'Runtime QA evidence did not pass.';
}

export function computeBrowserCheckStatuses(
  requiredChecks: readonly string[],
  input: CheckEvidenceInput,
): QaCheck[] {
  const ranBrowser = input.playwrightOk && input.routes.length > 0;
  const every = (predicate: (viewport: ReportViewport) => boolean): boolean => (
    input.routes.length > 0
    && input.routes.every((route) => (
      route.viewports.length > 0 && route.viewports.every(predicate)
    ))
  );
  const notRunSummary = bounded(`not run: ${input.blockerSummary || input.launchBlocker || 'browser evidence was not captured'}`);
  const evidenceCheck = (ok: boolean, failSummary: string): { status: QaCheck['status']; summary: string } => (
    !ranBrowser
      ? { status: 'not-applicable' as const, summary: notRunSummary }
      : ok
        ? { status: 'passed' as const, summary: RUNNER_PASS_SUMMARY }
        : { status: 'failed' as const, summary: bounded(failSummary) }
  );
  return requiredChecks.map((id) => {
    switch (id) {
      case 'stack-build': {
        const result = input.servedOk
          ? { status: 'passed' as const, summary: 'Build output manifest verified; served responses matched it.' }
          : !ranBrowser
            ? { status: 'not-applicable' as const, summary: notRunSummary }
            : { status: 'failed' as const, summary: 'Served responses did not match the build output manifest.' };
        return { id, ...result };
      }
      case 'playwright-local': {
        const result = !input.playwrightOk
          ? { status: 'failed' as const, summary: 'Project-local Playwright is unavailable. Install @playwright/test and its browser binary.' }
          : input.launchBlocker
            ? { status: 'failed' as const, summary: bounded(input.launchBlocker) }
            : ranBrowser
              ? { status: 'passed' as const, summary: RUNNER_PASS_SUMMARY }
              : { status: 'not-applicable' as const, summary: notRunSummary };
        return { id, ...result };
      }
      case 'dom-assertions':
        return { id, ...evidenceCheck(every((viewport) => viewport.domAssertionsPassed), 'DOM assertions failed on at least one route/viewport.') };
      case 'actions':
        return {
          id,
          ...evidenceCheck(
            every((viewport) => viewport.actionsPassed && (viewport.actionErrors ?? []).length === 0),
            'An interactive step failed or timed out on at least one route/viewport.',
          ),
        };
      case 'routing':
        return { id, ...evidenceCheck(every((viewport) => viewport.routingPassed), 'Routing did not land on the expected final path on at least one route/viewport.') };
      case 'hydration':
        return { id, ...evidenceCheck(every((viewport) => viewport.hydrationPassed), 'Hydration/runtime interactivity was not observed on at least one route/viewport.') };
      case 'console-errors':
        return { id, ...evidenceCheck(every((viewport) => viewport.consoleErrors.length === 0), 'Console errors were captured on at least one route/viewport.') };
      case 'network-errors':
        return { id, ...evidenceCheck(every((viewport) => viewport.networkErrors.length === 0), 'Failed or >=400 network responses were captured on at least one route/viewport.') };
      case 'responsive-screenshots':
        return {
          id,
          ...evidenceCheck(
            !input.visual || every((viewport) => Boolean(viewport.screenshotPath)),
            'A required responsive screenshot is missing on at least one route/viewport.',
          ),
        };
      default:
        // Fail closed: an id this runner does not compute must never read as
        // covered.
        return { id, status: 'failed' as const, summary: 'Not computed by the canonical QA runner.' };
    }
  });
}

// Wholesale mapping for report shapes with no per-route evidence (native
// adapter results): pass-through on passed/failed, but a blocked environment
// marks the checks 'not-applicable' instead of fabricating failures for
// checks that never ran.
export function wholesaleCheckStatuses(
  requiredChecks: readonly string[],
  status: QaReportV2['status'],
  blockerSummary?: string,
): QaCheck[] {
  return requiredChecks.map((id) => (
    status === 'passed'
      ? { id, status: 'passed' as const, summary: RUNNER_PASS_SUMMARY }
      : status === 'blocked-environment'
        ? { id, status: 'not-applicable' as const, summary: bounded(`not run: ${blockerSummary || 'required runtime environment is unavailable'}`) }
        : { id, status: 'failed' as const, summary: bounded(blockerSummary || 'Runtime QA evidence did not pass.') }
  ));
}

// Progress heartbeat: stderr only — stdout stays reserved for the single
// terminal JSON line. The runner shim spawns with stdio 'inherit', so these
// lines reach the calling agent live. A multi-minute silent run reads as dead
// and gets relaunched (observed 8co: four concurrent runners over the same
// artifacts).
export function emitProgress(message: string): void {
  process.stderr.write(`qa-evidence: ${message}\n`);
}
