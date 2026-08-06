// run-sim-settlement: the run actually CLOSED.
//
// This is the end of the chain and the thing no unit test can assert: reviewer
// APPROVED + tester TESTS_GREEN + validated evidence must leave the run
// `terminal`. Observed twice in live runs (cursor-16c, codex-10co) that all
// three could be present and the run still never settled — silently, with no
// deny and nothing to read. A run that does everything right and does not close
// is the most expensive failure mode there is, because it burns a whole budget
// and looks like success until someone checks.

import { readRunSettlement } from '../../shared/run-settlement';
import { runVerificationState } from '../../shared/state/run-agent';
import type { Assertion } from '../core/types';
import { effState, latestRunId, readRunSimTranscript, rec, result, runSimIncomplete, str } from './util';

export const assertion: Assertion = {
  id: 'run-sim-settlement',
  title: 'The run reached a terminal verdict',
  appliesTo: (c) => c.layer === 'run-sim',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    if (transcript.ok !== true) {
      return runSimIncomplete(ctx, transcript, 'The simulated run did not complete, so settlement was never reached');
    }

    const runId = str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');

    // Read it live rather than trusting the transcript's snapshot: the point is
    // what the runtime says NOW, from the artifacts on disk.
    const state = runVerificationState(ctx.cwd, runId);
    const settlement = readRunSettlement(ctx.cwd, runId);
    if (state !== 'terminal') {
      return result(ctx, 'FAIL', `runVerificationState is \`${state}\` (settlement status \`${settlement?.status ?? 'absent'}\`). Reviewer APPROVED and tester TESTS_GREEN were both written, so a non-terminal run here means evidence the gates accepted is not evidence settlement accepts.`, {
        expected: 'terminal',
        actual: state,
      });
    }

    // The canonical settlement must have advanced too. `terminal` alone is the
    // digest-derived verdict; `verified` is the ledger actually closing, which
    // is what lets the next run start clean.
    if (settlement?.status !== 'verified') {
      return result(ctx, 'FAIL', `runVerificationState is terminal but the canonical settlement is \`${settlement?.status ?? 'absent'}\` — settleTerminalRunLedger did not close the ledger.`, {
        expected: 'verified',
        actual: settlement?.status ?? 'absent',
      });
    }

    // A maintenance run must close too, or the project is left with a live run
    // that would block the next request.
    const phase2RunId = str(rec(transcript.facts).phase2RunId);
    if (phase2RunId) {
      const secondState = runVerificationState(ctx.cwd, phase2RunId);
      const secondSettlement = readRunSettlement(ctx.cwd, phase2RunId);
      if (secondState !== 'terminal' || secondSettlement?.status !== 'verified') {
        return result(ctx, 'FAIL', `The maintenance run ${phase2RunId} did not close: state \`${secondState}\`, settlement \`${secondSettlement?.status ?? 'absent'}\`.`, {
          expected: 'terminal/verified',
          actual: `${secondState}/${secondSettlement?.status ?? 'absent'}`,
        });
      }
      return result(ctx, 'PASS', `Both runs closed: build ${runId} and maintenance ${phase2RunId}, each terminal with settlement=verified.`);
    }

    return result(ctx, 'PASS', `Run ${runId} closed: runVerificationState=terminal and canonical settlement=verified.`);
  },
};
