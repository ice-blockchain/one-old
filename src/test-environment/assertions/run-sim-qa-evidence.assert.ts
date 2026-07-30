// run-sim-qa-evidence: the run produced REAL, validated QA evidence for the
// contract it actually published.
//
// Three fences, because this is the assertion most able to go quietly wrong:
//
//   1. The case DECLARES qa.mode; this checks it against the published
//      contract.browserRequired. If a compiler change lowers a shape's impact,
//      the declaration stops matching and the case fails — a shape can never
//      silently slide onto the cheap `stack` path.
//   2. expectChecks pins each check's status. stackReportStatus returns
//      `passed` whenever nothing FAILED, so an all-`not-applicable` report
//      would otherwise read as a pass.
//   3. `not-applicable` is only acceptable when the project genuinely declares
//      no such command. When the command resolved but could not be EXECUTED
//      (missing binary), that is an environment gap: INCONCLUSIVE, never PASS.
//      Reporting green there is exactly how a suite claims coverage it does
//      not have.

import { readQaReportV2 } from '../../shared/qa-report-v2';
import { readVerificationContract } from '../../shared/verification-contract';
import type { Assertion } from '../core/types';
import { effState, latestRunId, readRunSimTranscript, rec, result, str } from './util';

// The runner's own wording for the two distinct not-applicable causes
// (qa-evidence/stack.ts:174 vs :193).
const NOT_EXECUTABLE_RE = /could not be executed/i;

export const assertion: Assertion = {
  id: 'run-sim-qa-evidence',
  title: 'QA evidence is real, validated, and matches the published contract',
  appliesTo: (c) => c.layer === 'run-sim',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');

    // When a maintenance run followed, ITS report is the one that must validate
    // now: the first run's evidence was correct when produced and is recorded
    // in the transcript, but the tree has legitimately moved since.
    const phase2RunId = str(rec(transcript.facts).phase2RunId);
    const runId = phase2RunId || str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');
    const expectation = phase2RunId
      ? ctx.testCase.runSim?.phase2?.qa
      : ctx.testCase.runSim?.qa;

    const contract = readVerificationContract(ctx.cwd, runId);
    if (!contract) return result(ctx, 'FAIL', 'VerificationContractV2 is missing or fails its own hash self-check.');

    // Fence 1 — the declaration must match reality.
    const declared = expectation?.mode;
    const expectedMode = contract.browserRequired ? 'browser' : 'stack';
    if (declared !== expectedMode) {
      return result(ctx, 'FAIL', `The case declares qa.mode=\`${declared}\` but the published contract (uiImpact=${contract.uiImpact}, browserRequired=${contract.browserRequired}) needs \`${expectedMode}\`.`, {
        expected: expectedMode,
        actual: declared,
      });
    }

    const report = readQaReportV2(ctx.cwd, runId);
    if (!report.ok) {
      return result(ctx, 'FAIL', `The published QA report was rejected by its own validator (${report.code}: ${report.message}).`);
    }

    const byId = new Map(report.report.checks.map((check) => [check.id, check]));
    const missing = contract.requiredChecks.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return result(ctx, 'FAIL', `The report omits required check(s): ${missing.join(', ')}.`, {
        expected: contract.requiredChecks,
        actual: [...byId.keys()],
      });
    }

    // Fence 3 — separate "no such command" from "the binary is missing".
    const unrunnable = report.report.checks.filter((check) => (
      check.status === 'not-applicable' && NOT_EXECUTABLE_RE.test(check.summary ?? '')
    ));
    if (unrunnable.length > 0) {
      return result(ctx, 'INCONCLUSIVE', `The toolchain is missing on this machine, so ${unrunnable.length} required check(s) resolved to a command that could not run: ${unrunnable.map((check) => `${check.id} (${check.summary})`).join('; ')}. This is an environment gap — it must not be read as coverage.`);
    }

    // Every not-applicable must carry a reason; a bare one reads as covered.
    const unexplained = report.report.checks.filter((check) => (
      check.status === 'not-applicable' && !(check.summary ?? '').trim()
    ));
    if (unexplained.length > 0) {
      return result(ctx, 'FAIL', `not-applicable without a stated reason: ${unexplained.map((check) => check.id).join(', ')}.`);
    }

    // Fence 2 — pinned statuses.
    const pinned = expectation?.expectChecks ?? {};
    const wrong: string[] = [];
    for (const [id, expected] of Object.entries(pinned)) {
      const actual = byId.get(id)?.status;
      if (actual !== expected) wrong.push(`${id}: expected ${expected}, got ${actual ?? 'absent'}`);
    }
    if (wrong.length > 0) {
      return result(ctx, 'FAIL', `Pinned check statuses did not hold: ${wrong.join('; ')}.`, {
        expected: pinned,
        actual: Object.fromEntries(report.report.checks.map((check) => [check.id, check.status])),
      });
    }

    // `browser` must exit 0 on a contract with no browser surface, rather than
    // failing on a build manifest an api-only project will never have. Only
    // meaningful for stack shapes; browser shapes ran it for real above.
    const browserExit = declared === 'stack' ? rec(transcript.facts).browserExitCode : undefined;
    if (typeof browserExit === 'number' && browserExit !== 0) {
      return result(ctx, 'FAIL', `\`browser\` exited ${browserExit} on a contract with browserRequired=false; it must exit 0 and point at the stack runner.`, {
        expected: 0,
        actual: browserExit,
      });
    }

    const summary = report.report.checks.map((check) => `${check.id}=${check.status}`).join(', ');
    return result(ctx, 'PASS', `Validated report-v2.json for uiImpact=${contract.uiImpact}: ${summary}. Report status ${report.report.status}; \`browser\` exited ${String(browserExit ?? 'n/a')}.`);
  },
};
