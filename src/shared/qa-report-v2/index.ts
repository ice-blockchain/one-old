// Canonical QaReportV2 validation. The heavy lifting lives in the
// -schema/-artifacts/-build/-evidence siblings; this file keeps the
// validateQaReportV2 orchestrator and re-exports the original public surface.

import {
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
} from '../qa-evidence-runtime';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type VerificationContractV2,
} from '../verification-contract';

import {
  TEST_EVIDENCE_CHECK_IDS,
  formatSchemaIssues,
  inconclusiveCheckSummary,
  isRecord,
  isoMs,
  newSchemaIssues,
  notApplicableDisposition,
  parseReport,
  qaReportV2Path,
  type QaReportV2,
  type QaV2FailureCode,
  type QaV2ValidationRejected,
  type QaV2ValidationResult,
} from './schema';
import { stackCommandUndeclared } from './stack-resolution';
import { qaDimensions } from './dimensions';
import {
  PERFORMANCE_GATE_ID,
  failedGate,
  persistGateRejection,
} from './gates';
import {
  acceptanceAttests,
  acceptanceRestoresReport,
  artifactValid,
  writeAcceptanceAttestation,
} from './artifacts';
import {
  validateBuild,
} from './build';
import {
  validateLighthouseEvidence,
  validateMachineEvidence,
  validateNativeEvidence,
  viewportPassed,
} from './evidence';
import { readRegularFileOrThrow } from '../bounded-read';

/**
 * The ids a project is allowed to not declare, exported so the producible-check
 * invariant can assert the other direction: every entry here must name an id
 * some producer can also emit `passed` for. An exemption that is the ONLY
 * reachable outcome is not a justification, it is an unfailable check — the
 * mirror image of an id with no producer at all, and it hides the next one.
 *
 * `stack-build` is deliberately excluded: a backend that does not build is
 * broken, and every supported backend has a build form. Test and lint coverage
 * is still guarded independently by the tester's own completion gate, so this
 * cannot become the only thing standing between an untested service and
 * settlement.
 *
 * WHAT REMAINS OPEN, recorded rather than decided here. With the
 * declared-but-unrunnable routes closed below, one route into this allowlist
 * survives on purpose: a project that genuinely declares no test command at
 * all. Measured today on a nonvisual contract — a `package.json` with a
 * `build` script and no `test` script, no go.mod, no pytest configuration —
 * `stack-test` reports `not-applicable / no-command-declared`, the exemption
 * grants it, and the run settles `passed / ok / passed` across producer,
 * validator and disk with no test evidence of any kind. Whether that should be
 * settleable is a PRODUCT question, not this file's: refusing it would make
 * every service without a test suite unfinishable until someone writes one,
 * which is a policy about what Traffic One requires of a project rather than a
 * statement about what this run measured. It is flagged here so the next reader
 * meets the question rather than rediscovering the route.
 */
export const JUSTIFIED_NO_STACK_COMMAND_CHECK_IDS = [
  'stack-test', 'stack-lint', 'stack-format', 'stack-performance',
] as const;

function metric(
  evidence: QaLighthouseEvidenceV1,
  key: keyof QaLighthouseEvidenceV1,
): number | undefined {
  const value = evidence[key];
  return typeof value === 'number' ? value : undefined;
}

function thresholdFailures(
  evidence: QaLighthouseEvidenceV1,
  thresholds: LighthouseThresholdsV1,
  tolerancePercent: number,
): string[] {
  const failures: string[] = [];
  const mins: Array<[keyof LighthouseThresholdsV1, keyof QaLighthouseEvidenceV1]> = [
    ['performanceMin', 'performance'],
    ['accessibilityMin', 'accessibility'],
    ['bestPracticesMin', 'bestPractices'],
    ['seoMin', 'seo'],
  ];
  for (const [thresholdKey, evidenceKey] of mins) {
    const threshold = thresholds[thresholdKey];
    if (threshold === undefined) continue;
    const observed = metric(evidence, evidenceKey);
    const floor = threshold * (1 - tolerancePercent / 100);
    if (observed === undefined || observed < floor) failures.push(`${String(evidenceKey)} ${observed ?? 'missing'} < ${floor}`);
  }
  const maxes: Array<[keyof LighthouseThresholdsV1, keyof QaLighthouseEvidenceV1]> = [
    ['lcpMaxMs', 'lcpMs'],
    ['clsMax', 'cls'],
    ['inpMaxMs', 'inpMs'],
    // Judgeable on the canonical path so a declared first-paint / blocking-time
    // budget is enforced HERE and not only inside the standalone runner.
    ['fcpMaxMs', 'fcpMs'],
    ['tbtMaxMs', 'tbtMs'],
  ];
  for (const [thresholdKey, evidenceKey] of maxes) {
    const threshold = thresholds[thresholdKey];
    if (threshold === undefined) continue;
    const observed = metric(evidence, evidenceKey);
    const ceiling = threshold * (1 + tolerancePercent / 100);
    if (observed === undefined || observed > ceiling) failures.push(`${String(evidenceKey)} ${observed ?? 'missing'} > ${ceiling}`);
  }
  return failures;
}

function reject(
  projectRoot: string,
  runId: string,
  code: QaV2FailureCode,
  message: string,
  report?: QaReportV2,
  contract?: VerificationContractV2,
  lighthouse?: { hasEvidence: boolean; thresholdFailures: string[] },
): QaV2ValidationRejected {
  return {
    ok: false,
    code,
    message,
    reportPath: qaReportV2Path(projectRoot, runId),
    ...(report ? { report } : {}),
    ...(contract ? { contract } : {}),
    // Carried on the failure path too: "which dimension failed" is exactly what
    // a rejected run needs to report, and it is what tells a fix cycle whether
    // it has anything blocking to fix at all.
    dimensions: qaDimensions(report, contract, lighthouse),
  };
}

/**
 * Judge the report, then make a rejection DURABLE.
 *
 * `reject()` computes a verdict and writes nothing, so the runner's optimistic
 * `"status":"passed"` publication used to remain the only record on disk even
 * when this validator failed the run on a non-browser gate (observed 10co-e2e:
 * a `passed` sidecar next to Lighthouse evidence of performance 74 against a
 * required floor of 90). Every reader after the run — settlement, the tester
 * completion gate, a human — reads that file.
 */
export function validateQaReportV2(
  value: unknown,
  projectRoot: string,
  runId: string,
  contract: VerificationContractV2,
): QaV2ValidationResult {
  const result = evaluateQaReportV2(value, projectRoot, runId, contract);
  if (!result.ok) persistGateRejection(projectRoot, runId, result);
  return result;
}

function evaluateQaReportV2(
  value: unknown,
  projectRoot: string,
  runId: string,
  contract: VerificationContractV2,
): QaV2ValidationResult {
  // Name the offending fields. "does not match QaReportV2." named nothing —
  // observed live (13cl): the tester hand-edited the sidecar blindly and hit
  // the same byte-identical deny 6+ times in 90 seconds. The concrete
  // violations plus the runner command are the diagnosable exit.
  const schemaIssues = newSchemaIssues();
  const report = parseReport(value, schemaIssues);
  if (!report) {
    return reject(
      projectRoot,
      runId,
      'invalid-schema',
      `QA sidecar does not match QaReportV2 — ${formatSchemaIssues(schemaIssues)}. `
        + 'Regenerate it with the canonical QA evidence runner '
        + '(`node ~/.traffic-one/bin/qa-evidence-runner.cjs browser …`, or `stack` for no-browser contracts; '
        + "the shim runs the plugin's `scripts/qa-evidence-runner.cjs`) — "
        + 'a hand-authored report-v2.json cannot carry the machine evidence this validation requires.',
      undefined,
      contract,
    );
  }
  if (report.runId !== runId || report.verificationContractHash !== contract.contractHash) {
    return reject(projectRoot, runId, 'contract-mismatch', 'QA report does not belong to the active verification contract.', report, contract);
  }
  const source = currentVerificationSourceHash(projectRoot, contract);
  // An incomplete scan is still a refusal — with ONE exception, and it is an
  // exception about the CONSEQUENCE, not about the detection. See
  // `currentVerificationSourceHash`: a skip-authority name disclosure names a
  // gap that is real, bounded, and usually the run's own build output, and the
  // rest of this tree already treats that class as survivable (plan-guard
  // records STRUCT_SCAN_INCOMPLETE and publishes a pinned contract instead of
  // denying PLAN_READY). This validator was the only place that escalated it to
  // a total refusal.
  if (!source.complete && !source.qualification) {
    return reject(projectRoot, runId, 'scan-incomplete', source.reason || 'source identity scan incomplete', report, contract);
  }
  if (report.sourceHash !== source.hash) {
    return reject(projectRoot, runId, 'source-mismatch', 'QA report source hash is stale or belongs to another build.', report, contract);
  }
  // The price of proceeding. A qualified run may settle; a qualified run that
  // reports clean, unqualified evidence may not — that would be the silent
  // upgrade the whole degradation is only defensible without. The refusal keeps
  // its `scan-incomplete` code on purpose: the condition IS an incomplete scan,
  // and a second code for "an incomplete scan nobody wrote down" would split one
  // fact across two vocabularies.
  //
  // AFTER the identity check, not before. A report that is BOTH stale and
  // undisclosed is primarily stale — republishing it is the fix either way, and
  // sending its reader to hunt a missing disclosure on an artifact that belongs
  // to another build names the wrong cause. Ordered on the same principle the
  // stage/bound split in native.ts was: the more specific true fact wins.
  if (source.qualification && !report.settledWithIncompleteScan) {
    return reject(
      projectRoot,
      runId,
      'scan-incomplete',
      `${source.qualification} — this run may still settle, but only on a report that says so. `
      + 'Republish it with the canonical QA evidence runner, which records the disclosure in '
      + 'settledWithIncompleteScan; a report that omits it claims evidence over a diff that '
      + 'could not see everything.',
      report,
      contract,
    );
  }
  if (report.status === 'blocked-environment') {
    if (!contract.browserRequired && contract.uiImpact !== 'native-ui') {
      return reject(projectRoot, runId, 'invalid-schema', 'Environment blocker is invalid for none/nonvisual verification.', report, contract);
    }
    return reject(projectRoot, runId, 'blocked-environment', report.blockerSummary || 'Required runtime environment is unavailable.', report, contract);
  }
  // The durable acceptance attestation outranks every LIVE-STATE recheck below
  // (persisted gates, the build-output manifest, server identity): it is this
  // validator's own record that this exact report + evidence set + build
  // identity already passed the complete live validation, judged strictly by
  // content hashes on top of the live sourceHash check above. Without it, a
  // post-acceptance rebuild of the output dir (observed 14cl: the reviewer's
  // probe build) failed the machine-evidence manifest recheck and
  // `persistGateRejection` durably flipped the accepted report to `failed` —
  // a fully green run that could never settle. Any changed byte in the report
  // or evidence, or any source drift, and this returns null so the full live
  // validation still runs and still fails closed.
  const acceptedReport = acceptanceRestoresReport(projectRoot, runId, report, contract, source.hash);
  if (acceptedReport) {
    const acceptedGeneratedAtMs = isoMs(acceptedReport.generatedAt);
    return {
      ok: true,
      report: acceptedReport,
      contract,
      reportPath: qaReportV2Path(projectRoot, runId),
      // Advisory warnings were already surfaced when the report was first
      // accepted; an attestation-backed re-read does not recompute them.
      advisories: [],
      dimensions: qaDimensions(acceptedReport, contract, {
        hasEvidence: Boolean(acceptedReport.lighthouse?.evidencePath),
        thresholdFailures: [],
      }),
      ...(acceptedGeneratedAtMs === null ? {} : { acceptedGeneratedAtMs }),
    };
  }
  // A gate verdict persisted by an earlier validation keeps its ORIGINAL code
  // and message. Without this the durable correction would degrade on the next
  // read to a generic `functional-failure`, and a fix cycle would lose the one
  // thing it needs: which dimension failed.
  const persisted = failedGate(report);
  if (persisted) {
    return reject(
      projectRoot,
      runId,
      persisted.code,
      persisted.summary,
      report,
      contract,
      persisted.id === PERFORMANCE_GATE_ID
        ? {
            hasEvidence: Boolean(report.lighthouse?.evidencePath),
            thresholdFailures: [persisted.summary],
          }
        : undefined,
    );
  }
  const checks = new Map(report.checks.map((check) => [check.id, check]));
  // Which required checks settled on the exemption rather than on evidence. The
  // product decision this carries is DISCLOSE, NOT REFUSE: a project with a
  // build script and no test script may still settle, and the absence must be
  // explicit in the verdict, in the durable artifact, and in what a human is
  // told. This list is where the first of those three comes from — see the
  // advisory pushed below, and `settledWithoutTestEvidence` in the report.
  const exemptedWithoutCommand: string[] = [];
  for (const required of contract.requiredChecks) {
    const check = checks.get(required);
    // A quality command the project does not declare is honestly reported, not
    // silently passed. The `axe-when-dom` arm that used to sit beside this one
    // is gone with the check itself: it excused a `not-applicable` whose prose
    // no runner ever wrote, so the only report it ever accepted was a
    // hand-authored one — see requiredChecks in verification-contract/impact.ts.
    //
    // A check the runner CUT SHORT is excluded from the exemption, and that is
    // the sharpest edge in this loop. The exemption exists for a command that
    // had nothing to run; a suite that hung until the runner SIGKILLed it had
    // everything to run and produced no evidence at all. Both used to arrive
    // here as `not-applicable / "could not be executed"`, and since stack-test
    // is on the allowlist above, a hung test suite settled the run GREEN — the
    // most expensive shape this validator can accept, because `stack-test` is
    // the only thing between untested source and a settled nonvisual run.
    //
    // THE PREDICATE READS A FACT THE RUNNER RECORDED, NOT A FIELD THE REPORT'S
    // AUTHOR WROTE, and the difference is the whole of this round's repair.
    //
    // The previous round moved the decision off the check's PROSE and onto a
    // `notApplicable` reason field, and recorded that as "the predicate reads a
    // FACT, not a sentence". At this boundary that was not true. `report-v2.json`
    // sits at `.traffic-one/reports/qa/<runId>/report-v2.json`, which
    // `artifactContract` attributes to the `senior-tester` role and which no
    // runtime-sidecar fence covers, so the agent that AUTHORS the report owns
    // the field that grants it the exemption — and `validateMachineEvidence`
    // below runs only under `contract.browserRequired`, so on the nonvisual
    // contracts this exemption exists for, nothing else was checking anything.
    // Driven end to end: an honest api-only Node run whose `npm test` exits 127
    // settles `failed / required-check-failed / failed`, and three hand edits to
    // that one file — this reason, the persisted `gates` array, the status —
    // settled it green. Prose was author-writable; the field was author-writable;
    // they were in the same author-writable file.
    //
    // `stackCommandUndeclared` is the half the author cannot reach. The runner
    // writes what `resolveStackCommand` actually answered into
    // `.traffic-one/runs/<runId>/`, which `runtimeOwnedRunSidecar` refuses to
    // every agent outright — the same fence the browser path's machine evidence
    // already rests on. Both must agree, so a forged reason now needs a file its
    // forger cannot write. NOT re-derived here: `resolveStackCommand` reads only
    // the cwd it is handed, the producer resolves at `serverCwd` when one was
    // passed, and `serverCwd` is in neither the contract nor the report — a
    // validator re-deriving at `projectRoot` would refuse the honest exemption of
    // every monorepo whose served package declares less than its root manifest.
    // See shared/qa-report-v2/stack-resolution.ts.
    //
    // It used to be two regular expressions over the summary — `not
    // run:` plus `declares no|could not be executed` — and THREE producers in
    // stack.ts wrote prose satisfying both, for two incompatible reasons. Only
    // the resolution arm ("no matching manifest script and no pinned language
    // default") is the intended one. The other two — `kind: 'unavailable'`, a
    // declared command whose binary is absent or unexecutable, and exit 127, a
    // declared command the shell could not find — mean a test command WAS
    // declared and zero tests ran, and both were excused. Measured on real
    // contract-compiled projects before this change: a Node api-only project
    // whose `npm run build` succeeds and whose `npm test` exits 127 settled
    // `producerStatus: passed / validatorOk: true / onDiskStatus: passed`, and
    // so did a Python project with `pytest` absent, and again with `pytest`
    // present but not executable. That is the everyday fresh-clone shape on the
    // most common stack in this repository, and the cut-short work above never
    // touched it: nothing was cut short, so no marker was ever written.
    //
    // `QA_NOT_APPLICABLE_REASONS` is that distinction carried instead of
    // described, decided where it is known (`resolveStackCommand`) rather than
    // reconstructed here from prose. Every route into this predicate is
    // enumerated and classified in __tests__/exemption-provenance.test.ts,
    // which walks every producer of a `not-applicable` check in the runner —
    // the five in stack.ts, plus computeBrowserCheckStatuses and
    // nativeCheckStatuses — and asserts the reason each one carries; the
    // classification is therefore pinned by ABSENCE of an unclassified route,
    // not only by mutation of a classified one.
    //
    // THE SUMMARY CLAUSE IS NOT A SECOND GUARD AND IS NOT COUNTED AS ONE. A
    // producer that stamps `no-command-declared` on a check it also marked
    // inconclusive has contradicted itself, and no producer does: the reason is
    // assigned in the same object literal as the prose at all seven sites, and
    // only one of the seven says `no-command-declared`. It is here
    // so that a future producer's self-contradiction fails closed rather than
    // open, which is defence in depth behind the reason — not an independent
    // reason to believe the property.
    const justifiedNoStackCommand = (JUSTIFIED_NO_STACK_COMMAND_CHECK_IDS as readonly string[]).includes(required)
      && check?.status === 'not-applicable'
      && notApplicableDisposition(check.notApplicable) === 'excusable'
      && stackCommandUndeclared(projectRoot, runId, required)
      && !inconclusiveCheckSummary(check.summary);
    if (check?.status !== 'passed' && !justifiedNoStackCommand) {
      const claimedButUnwitnessed = check?.status === 'not-applicable'
        && notApplicableDisposition(check.notApplicable) === 'excusable'
        && !stackCommandUndeclared(projectRoot, runId, required);
      return reject(
        projectRoot,
        runId,
        'required-check-failed',
        claimedButUnwitnessed
          // The forgery's own deny, and it is separated from the ordinary one
          // because the two remedies are opposite: an ordinary red is fixed by
          // fixing the code, and this one is fixed by running the canonical
          // runner instead of writing what it would have said.
          ? `Required check ${required} claims no command was declared, but this run's runtime `
            + 'record does not say so. That record is written by the QA evidence runner at the '
            + `moment it resolves each command (.traffic-one/runs/${runId}/`
            + 'qa-stack-resolution-v1.json) and cannot be produced by editing the report. Re-run '
            + 'the canonical runner for this run id.'
          : `Required check ${required} did not pass.`,
        report,
        contract,
      );
    }
    if (justifiedNoStackCommand) exemptedWithoutCommand.push(required);
  }
  // A CUT-SHORT check is rejectable wherever it appears, and not only where the
  // loop above happens to look.
  //
  // Everything in this validator that judges "the runner killed this step and it
  // produced no verdict" was inside the requiredChecks loop, which means the
  // guarantee was conditional on a list. `requiredChecks('behavioral')` does not
  // include `stack-test`; the blanket rule below fires only on `failed`; and a
  // cut-short check is `not-applicable` with `inconclusive:` prose and leaves
  // `report.status` at `passed` (stack.ts's `stackReportStatus` only reds a
  // report on a `failed` check). Measured on a real nonvisual run: a report that
  // settled `ok` kept settling `ok` with an inconclusive check appended for an id
  // the contract did not require. The point of the marker is that signal death
  // must not be laundered into a pass, and routing it to a status that settles
  // anyway launders it by a different door.
  //
  // Today no producer walks through that door — measured across all five impact
  // classes, `computeBrowserCheckStatuses`, `nativeCheckStatuses` and
  // `runStackChecks` each emit exactly the ids they are handed, which are
  // `contract.requiredChecks`, and the report's contract hash is pinned above so
  // the list cannot change underneath a report. So this refuses nothing that
  // settles today: its whole value is that the property stops depending on an
  // invariant that lives in three other files and is asserted in none of them.
  //
  // Same code as the required path deliberately. One condition — a check with no
  // verdict — should not report two different codes depending on whether an id
  // is on a list.
  //
  // Either spelling of the same fact catches it: the marker in the prose, or a
  // reason whose DISPOSITION is `no-verdict`. Every producer in this runner
  // writes both, in one expression, so against a report this runner produced
  // they are one condition asked twice — and the mutation score says exactly
  // that: deleting the reason half survives the whole lane, and only deleting
  // both is caught.
  //
  // THE HALVES ARE NOT INTERCHANGEABLE, THOUGH, and it is the prose half that
  // is doing the work. Deleting it alone IS killed, by a report this runner did
  // not write: a hand-authored sidecar, or one from a runner older than the
  // reason field, carries the marker and no reason at all. This validator reads
  // reports it did not produce — that is the whole reason it exists — so the
  // half that covers them is load-bearing and the half that covers a
  // self-contradicting future producer is the defence in depth.
  //
  // ONE CORRECTION TO THAT, from a branch census over the lane suite counting
  // which disjunct DECIDES: `cutShortSeen: 1, cutShortProseOnly: 1,
  // cutShortReasonOnly: 0, cutShortBoth: 0`. The rule fires once in the whole
  // suite and the prose half decides alone that once, which confirms the
  // paragraph above — but `cutShortBoth: 0` means the sentence "against a report
  // this runner produced they are one condition asked twice" is never actually
  // exercised. It is true of the producers and it has no fixture. The claim is
  // right; its supporting example does not run.
  //
  // The reason half asks `notApplicableDisposition` rather than comparing
  // against the literal `'cut-short'`, and that is the fifth-reason repair. A
  // member added to `QA_NOT_APPLICABLE_REASONS` denoting a new way for signal to
  // die used to be refused the exemption above (fail closed) and slip THIS rule
  // (fail open) — two literals, in two files, failing in opposite directions
  // from one addition. The disposition switch cannot compile until the new
  // member is classified, and both rules then read the same classification.
  const cutShort = report.checks.find((check) => (
    inconclusiveCheckSummary(check.summary)
    || (check.status === 'not-applicable' && notApplicableDisposition(check.notApplicable) === 'no-verdict')
  ));
  if (cutShort) {
    return reject(
      projectRoot,
      runId,
      'required-check-failed',
      `Check ${cutShort.id} was cut short and produced no verdict in either direction.`,
      report,
      contract,
    );
  }
  if (report.checks.some((check) => check.status === 'failed') || report.status === 'failed') {
    return reject(projectRoot, runId, 'functional-failure', 'QA report contains a failed check.', report, contract);
  }

  const requiresBuildIdentity = contract.buildIdentityRequired
    || contract.performance.required
    || Boolean(report.lighthouse?.evidencePath);
  let machineEvidence: QaMachineEvidenceV1 | null = null;
  if (contract.browserRequired) {
    const machine = validateMachineEvidence(report, contract, source.hash, projectRoot);
    if (machine.error || !machine.evidence) {
      return reject(
        projectRoot,
        runId,
        'machine-evidence-invalid',
        machine.error || 'runtime Playwright evidence is missing',
        report,
        contract,
      );
    }
    machineEvidence = machine.evidence;
  }
  const previouslyAttested = requiresBuildIdentity
    && acceptanceAttests(projectRoot, runId, report, contract, source.hash);
  if (requiresBuildIdentity && !previouslyAttested) {
    const buildFailure = validateBuild(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (buildFailure) return reject(projectRoot, runId, 'build-identity-invalid', buildFailure, report, contract);
  }

  if (contract.browserRequired) {
    const byRoute = new Map(report.routes.map((route) => [route.route, route]));
    for (const requiredRoute of contract.changedRoutes) {
      const route = byRoute.get(requiredRoute);
      if (!route || route.viewports.length === 0) {
        return reject(projectRoot, runId, 'route-matrix-incomplete', `Missing browser evidence for ${requiredRoute}.`, report, contract);
      }
      const widths = new Set(route.viewports.map((viewport) => viewport.width));
      for (const width of contract.requiredScreenshotWidths) {
        if (!widths.has(width)) {
          return reject(projectRoot, runId, 'route-matrix-incomplete', `${requiredRoute} is missing width ${width}.`, report, contract);
        }
      }
      for (const viewport of route.viewports) {
        if (!viewportPassed(viewport)) {
          return reject(projectRoot, runId, 'functional-failure', `${requiredRoute} width ${viewport.width} failed runtime assertions.`, report, contract);
        }
        const artifactAt = Date.parse(viewport.artifactAt);
        const minimumAt = report.build ? Date.parse(report.build.startedAt) : Date.parse(contract.baseline.capturedAt);
        if (artifactAt < minimumAt || artifactAt > Date.parse(report.generatedAt)) {
          return reject(projectRoot, runId, 'build-identity-invalid', `${requiredRoute} width ${viewport.width} artifact timestamp is stale.`, report, contract);
        }
        if (viewport.screenshotPath && !artifactValid(
          projectRoot,
          runId,
          viewport.screenshotPath,
          artifactAt,
          Date.parse(report.generatedAt),
          viewport.width,
        )) {
          return reject(projectRoot, runId, 'screenshot-invalid', `${requiredRoute} width ${viewport.width} screenshot is invalid or stale.`, report, contract);
        }
        if (
          contract.requiredScreenshotWidths.includes(viewport.width)
          && !viewport.screenshotPath
        ) {
          return reject(projectRoot, runId, 'screenshot-invalid', `${requiredRoute} width ${viewport.width} requires a fresh screenshot.`, report, contract);
        }
      }
    }
  }

  if (contract.uiImpact === 'native-ui') {
    const native = validateNativeEvidence(report, contract, source.hash, projectRoot);
    if (native.error || !native.evidence) {
      return reject(
        projectRoot,
        runId,
        'native-evidence-invalid',
        native.error || 'Native simulator/emulator evidence is missing.',
        report,
        contract,
      );
    }
  }

  // THE DISCLOSURE, at the moment the exemption is granted.
  //
  // The product decision is DISCLOSE, NOT REFUSE: a Node or plain-PHP project
  // with a build script and no test script may still settle, and the absence of
  // test evidence must be explicit in the VERDICT, in the DURABLE ARTIFACT, and
  // in what the user is told. Before this, none of the three happened. The
  // verdict said `passed` and said nothing; `advisories` was produced only for
  // Lighthouse thresholds, so an exemption emitted none; `publishStackReport`
  // dropped the field from its return type entirely, so on the stack path — the
  // exact shape the decision is about — the channel did not exist; and the one
  // consumer of `validation.advisories` wrote it into the lighthouse command's
  // stdout JSON, which the tester completion gate never reads.
  //
  // `notApplicable` stays the FACT and is deliberately NOT overloaded to also
  // mean "a human must be told". It is a per-check classification with a closed
  // enumeration; fusing a classification with a notification duty makes the next
  // person who adds a reason inherit the duty silently. The duty lives here and
  // in `settledWithoutTestEvidence`, both derived from the same check set.
  //
  // NARROWED TO TEST EVIDENCE, and the first version of this was not. It
  // advised on every exempted check, and the ordinary Node project excuses
  // `stack-lint` and `stack-format` as well — so the very first honest run it
  // was measured against produced "settled without stack-lint, stack-format
  // evidence … nothing here says the code is covered", about a missing
  // formatter. An advisory that fires on nearly every run is one nobody reads
  // by the second week, and it would have made the one case this exists for
  // indistinguishable from noise. A missing formatter is still reported — it is
  // in the checks array with its reason, where a per-check fact belongs.
  const advisories: string[] = [];
  // The disclosure that bought this run its verdict, on the channel a human and
  // the tester completion gate both read. Derived from the LIVE scan rather than
  // echoed from the report, so the advisory cannot be authored by the artifact it
  // is about; the report's own copy is the durable record and its absence has
  // already been refused above.
  if (source.qualification) {
    advisories.push(
      `settled on an incomplete diff: ${source.qualification}. Those bytes were compared by neither `
      + 'side of this run\'s diff, so nothing here says they are unchanged. Add the directory to '
      + '.gitignore if it is build output, or move the source out of it if it is not.',
    );
  }
  const excusedTestEvidence = exemptedWithoutCommand
    .filter((id) => (TEST_EVIDENCE_CHECK_IDS as readonly string[]).includes(id));
  if (excusedTestEvidence.length > 0) {
    advisories.push(
      `settled without ${excusedTestEvidence.join(', ')} evidence: this project declares no such `
      + 'command, and the runtime confirmed it, so the check was excused rather than measured. '
      + 'Nothing here says the code is covered.',
    );
  }
  let lighthouseEvidence: QaLighthouseEvidenceV1 | null = null;
  if (contract.performance.required) {
    const lighthouse = validateLighthouseEvidence(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (lighthouse.error || !lighthouse.evidence) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        lighthouse.error || 'Required Lighthouse evidence is missing.',
        report,
        contract,
      );
    }
    lighthouseEvidence = lighthouse.evidence;
    // Judge the contract's EFFECTIVE budget, not just what the plan declared.
    // `explicitThresholds || {}` meant a required performance contract with no
    // declared numbers enforced nothing here, while the standalone runner
    // applied its own defaults — the two paths reached opposite verdicts on the
    // same audit (observed 10co).
    const exactFailures = thresholdFailures(lighthouseEvidence, contract.performance.thresholds || {}, 0);
    if (exactFailures.length > 0) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        exactFailures.join('; '),
        report,
        contract,
        { hasEvidence: true, thresholdFailures: exactFailures },
      );
    }
  } else if (report.lighthouse?.evidencePath) {
    const lighthouse = validateLighthouseEvidence(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (lighthouse.error || !lighthouse.evidence) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        lighthouse.error || 'Optional Lighthouse evidence is invalid.',
        report,
        contract,
      );
    }
    lighthouseEvidence = lighthouse.evidence;
  }
  if (lighthouseEvidence && contract.performance.advisoryThresholds) {
    advisories.push(...thresholdFailures(
      lighthouseEvidence,
      contract.performance.advisoryThresholds,
      contract.performance.advisoryTolerancePercent,
    ));
  }
  // An ADVISORY performance contract is measured against the same effective
  // budget as a required one, but a miss is a warning: it is reported, it never
  // rejects the run, and it must never start a fix cycle.
  const advisoryThresholdFailures = lighthouseEvidence && contract.performance.advisory
    ? thresholdFailures(
      lighthouseEvidence,
      contract.performance.thresholds || {},
      contract.performance.advisoryTolerancePercent,
    )
    : [];
  advisories.push(...advisoryThresholdFailures.map((failure) => `advisory page-speed: ${failure}`));
  const lighthouseSummary = {
    hasEvidence: Boolean(lighthouseEvidence),
    thresholdFailures: advisoryThresholdFailures,
  };
  if (requiresBuildIdentity
    && !previouslyAttested
    && !writeAcceptanceAttestation(projectRoot, runId, report, contract, source.hash)) {
    return reject(
      projectRoot,
      runId,
      'build-identity-invalid',
      'Live build identity passed, but its durable QA acceptance attestation could not be persisted.',
      report,
      contract,
      lighthouseSummary,
    );
  }
  return {
    ok: true,
    report,
    contract,
    reportPath: qaReportV2Path(projectRoot, runId),
    advisories,
    dimensions: qaDimensions(report, contract, lighthouseSummary),
  };
}

export function readQaReportV2(projectRoot: string, runId: string): QaV2ValidationResult {
  const contract = readVerificationContract(projectRoot, runId);
  if (!contract) return reject(projectRoot, runId, 'contract-missing', 'VerificationContractV2 is missing or invalid.');
  const reportPath = qaReportV2Path(projectRoot, runId);
  let value: unknown;
  try { value = JSON.parse(readRegularFileOrThrow(reportPath)); } catch (error) {
    const code = isRecord(error) && error.code === 'ENOENT' ? 'report-missing' : 'invalid-json';
    return reject(projectRoot, runId, code, code === 'report-missing' ? 'QaReportV2 sidecar is missing.' : 'QaReportV2 is not valid JSON.', undefined, contract);
  }
  return validateQaReportV2(value, projectRoot, runId, contract);
}


export {
  CHECK_INCONCLUSIVE_PREFIX,
  QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION,
  QA_NOT_APPLICABLE_REASONS,
  QA_BUILD_IDENTITY_PROBE_PATH,
  TEST_EVIDENCE_CHECK_IDS,
  expectedBuildFingerprint,
  inconclusiveCheckSummary,
  notApplicableDisposition,
  qaAcceptanceAttestationPath,
  qaReportV2Path,
  reportSettledWithoutTestEvidence,
  type QaAcceptanceAttestationV1,
  type QaNotApplicableDisposition,
  type QaBuildIdentityV2,
  type QaDimensionStatus,
  type QaDimensionsV1,
  type QaGateV2,
  type QaNotApplicableReason,
  type QaReportV2,
  type QaV2FailureCode,
  type QaV2ValidationRejected,
  type QaV2ValidationResult,
  type QaViewportV2,
} from './schema';
export { qaDimensions } from './dimensions';
export { qaReportV2ContentHash } from './artifacts';
export { PERFORMANCE_GATE_ID, failedGate } from './gates';
export {
  qaStackResolutionPath,
  readStackResolution,
  recordStackResolution,
  stackCommandUndeclared,
  type QaStackResolutionOutcome,
  type QaStackResolutionV1,
} from './stack-resolution';
