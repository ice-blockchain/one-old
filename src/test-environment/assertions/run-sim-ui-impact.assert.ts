// run-sim-ui-impact: the published contract carries the impact this shape is
// supposed to produce, and the required checks that impact implies.
//
// Why a separate assertion rather than trusting qa.mode: `none` and `nonvisual`
// both answer browserRequired=false, so the mode declaration cannot tell them
// apart. For a long time this tier produced ONLY `none` and `visual`, and
// `nonvisual` — the base impact of every project with a web surface, i.e. the
// commonest change shape in the product (types, utils, config, schemas) — was
// never exercised. A hard settlement deadlock on it survived the one suite that
// tests composition: `requiredChecks('nonvisual')` asked for
// `unit-or-component-tests` and `axe-when-dom`, ids no producer could emit, so
// validateQaReportV2 rejected `required-check-failed` on every such run forever.
//
// Both halves are checked because they failed independently: the impact came
// from the compiler, the check list from a hand-kept table beside it, and the
// deadlock needed only the second to be wrong.

import { readVerificationContract, requiredChecks } from '../../shared/verification-contract';
import type { Assertion } from '../core/types';
import { effState, latestRunId, readRunSimTranscript, result, runSimStop, str } from './util';

export const assertion: Assertion = {
  id: 'run-sim-ui-impact',
  title: 'The published contract carries the expected uiImpact and required checks',
  appliesTo: (c) => c.layer === 'run-sim' && Boolean(c.runSim?.expectUiImpact),
  run: (ctx) => {
    const expected = ctx.testCase.runSim?.expectUiImpact;
    if (!expected) return result(ctx, 'SKIP', 'The case declares no expected uiImpact.');
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    // The contract is published by the PLAN_READY transaction, so a later
    // toolchain block leaves it fully readable.
    const stop = runSimStop(ctx, transcript, 'The simulated run did not reach PLAN_READY', 'plan-ready');
    if (stop) return stop;

    const runId = str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');
    const contract = readVerificationContract(ctx.cwd, runId);
    if (!contract) return result(ctx, 'FAIL', 'VerificationContractV2 is missing or fails its own hash self-check.');

    if (contract.uiImpact !== expected) {
      return result(ctx, 'FAIL', `This shape must compile to uiImpact=\`${expected}\` and produced \`${contract.uiImpact}\`. Either the shape stopped being the one the case represents, or the impact derivation moved — and an impact this tier no longer produces is an impact nothing composed tests.`, {
        expected,
        actual: contract.uiImpact,
      });
    }

    // The contract must ask for exactly what the impact implies. A contract that
    // published its own list would be the drift that caused the deadlock.
    const implied = requiredChecks(expected, contract.performance?.required === true);
    const missing = implied.filter((id) => !contract.requiredChecks.includes(id));
    const extra = contract.requiredChecks.filter((id) => !implied.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      return result(ctx, 'FAIL', `The contract's requiredChecks do not match requiredChecks('${expected}')${missing.length ? `; missing: ${missing.join(', ')}` : ''}${extra.length ? `; unexpected: ${extra.join(', ')}` : ''}.`, {
        expected: implied,
        actual: contract.requiredChecks,
      });
    }

    return result(ctx, 'PASS', `uiImpact=${contract.uiImpact} (browserRequired=${contract.browserRequired}), requiredChecks=[${contract.requiredChecks.join(', ')}] — exactly what requiredChecks('${expected}') implies.`);
  },
};
