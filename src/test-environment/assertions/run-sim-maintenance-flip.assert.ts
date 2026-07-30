// run-sim-maintenance-flip: a completed new project becomes a maintenance one.
//
// This is what routes the NEXT user request through post-build triage instead
// of a fresh architect run, so a project that never flips keeps re-planning
// work it already finished. Existing codebases are maintenance from detection
// (lifecycle.ts), so the flip is only meaningful on a new project and is only
// asserted there.

import type { Assertion } from '../core/types';
import { effState, readRunSimTranscript, rec, result, str } from './util';

export const assertion: Assertion = {
  id: 'run-sim-maintenance-flip',
  title: 'A finished new project moves to maintenance',
  appliesTo: (c) => c.layer === 'run-sim' && c.preSeed.mode === 'new-project',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    if (transcript.ok !== true) {
      return result(ctx, 'FAIL', `The simulated run did not complete: ${str(transcript.failure) || 'unknown failure'}`);
    }

    const facts = rec(transcript.facts);
    const phase = str(facts.lifecyclePhase);
    if (phase !== 'maintenance') {
      return result(ctx, 'FAIL', `Lifecycle phase is \`${phase ?? 'unset'}\` after a verified build; the project would re-enter the architect on the next request.`, {
        expected: 'maintenance',
        actual: phase,
      });
    }

    // Read it back live too: the transcript records what the flip returned, the
    // state file records what survived.
    const lifecycle = rec(effState(ctx).lifecycle);
    if (str(lifecycle.phase) !== 'maintenance') {
      return result(ctx, 'FAIL', `The flip reported maintenance but the persisted state says \`${str(lifecycle.phase) ?? 'unset'}\`.`);
    }

    return result(ctx, 'PASS', `Project moved to maintenance (source \`${str(facts.lifecycleSource) || str(lifecycle.source) || 'unknown'}\`) after settling.`);
  },
};
