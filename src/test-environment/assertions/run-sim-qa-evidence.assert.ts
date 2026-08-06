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

    // The report that must validate NOW is the newest run that produced QA
    // evidence: the maintenance pass when one ran, else the resolve-run leg,
    // else the first run. Earlier runs' evidence was correct when produced and
    // is recorded in the transcript, but the tree has legitimately moved since.
    const facts = rec(transcript.facts);
    const phase2RunId = str(facts.phase2RunId);
    const lastQaRunId = str(facts.lastQaRunId);
    const lastQaSource = str(facts.lastQaSource) ?? '';
    const runId = lastQaRunId || phase2RunId || str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');
    // The expectation travels with whichever pass produced this report.
    const legMatch = /^leg-(\d+)$/.exec(lastQaSource);
    const legSpec = legMatch ? ctx.testCase.runSim?.maintenance?.[Number(legMatch[1]) - 1] : undefined;
    const expectation = legSpec && legSpec.kind === 'resolve-run'
      ? legSpec.qa
      : (runId === phase2RunId ? ctx.testCase.runSim?.phase2?.qa : ctx.testCase.runSim?.qa);

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
    // Fence 3, first arm — the runner's OWN blocked-environment verdict. Placed
    // after fence 1 on purpose: a case that declares the wrong qa.mode still
    // FAILS, because that is a product/contract disagreement and has nothing to
    // do with this machine's toolchain.
    //
    // Before this branch existed, a machine with no project-local Playwright made
    // this assertion report "The published QA report was rejected by its own
    // validator (blocked-environment: Project-local Playwright is unavailable)"
    // as a FAIL — 48 of them. The report was not fabricated and the product was
    // not broken; there was no browser to look through. AGENTS.md always
    // specified INCONCLUSIVE here, and `--strict` still fails the release verdict
    // on it, so nothing is laundered.
    if (!report.ok && report.code === 'blocked-environment') {
      return result(ctx, 'INCONCLUSIVE', `The QA runner reported blocked-environment for uiImpact=${contract.uiImpact} (${expectedMode} mode): ${report.message}. A required toolchain is absent on this machine, so this run cannot say whether the product's evidence is good — it is not a pass and not a failure.`);
    }
    if (!report.ok) {
      // Maintenance legs that ran AFTER this report legitimately moved the
      // tree — that is what the maintenance phase IS. Tolerate the validator's
      // drift complaints if and only if the drift is attributable to writes a
      // LATER leg put through the gate; anything else is real fabrication.
      const lastQaLeg = /^leg-(\d+)$/.exec(lastQaSource);
      const lastQaOrdinal = lastQaLeg ? Number(lastQaLeg[1]) : 0;
      const legWritesAfterQa = (Array.isArray(transcript.writes) ? transcript.writes : [])
        .map((row) => rec(row))
        .filter((row) => {
          if (row.denied === true) return false;
          const leg = /^leg-(\d+)[.:]?/.exec(String(row.phase ?? ''));
          return leg !== null && Number(leg[1]) > lastQaOrdinal;
        });
      const legPaths = new Set(legWritesAfterQa.map((row) => String(row.path)));
      const message = String(report.message ?? '');
      // Arm 1: the validator NAMES the offending paths — every one must be a
      // later-leg write.
      const drift = /changed paths outside verification contract: (.+)$/.exec(message);
      const offending = drift ? drift[1]!.split(',').map((p) => p.trim()).filter(Boolean) : null;
      const namedDriftTolerated = offending !== null
        && legPaths.size > 0
        && offending.every((p) => legPaths.has(p));
      // Arm 2: the source hash went stale with no path attribution — accept
      // only when later legs actually wrote source, which is the one honest
      // explanation for a report that validated when it was produced.
      const staleTolerated = report.code === 'source-mismatch' && legPaths.size > 0;
      if (!(namedDriftTolerated || staleTolerated) || !report.report) {
        return result(ctx, 'FAIL', `The published QA report was rejected by its own validator (${report.code}: ${report.message}).`);
      }
    }
    if (!report.report) {
      return result(ctx, 'FAIL', `The QA report could not be parsed (${report.ok === false ? `${report.code}: ${report.message}` : 'no report body'}).`);
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
