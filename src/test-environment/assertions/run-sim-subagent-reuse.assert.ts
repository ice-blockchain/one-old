// run-sim-subagent-reuse: a review round-trip REUSES the live implementer.
//
// The requirement is a token-economy one — subagents are not recreated unless
// they are gone — and it is prose-enforced (v1.0.14 made continuation the
// default and respawn the fallback). Prose cannot be asserted, but its effect
// on disk can: a reused agent leaves `nextSpawnIndex` and the claim set exactly
// where they were, while a respawn increments the index and mints a new claim.
//
// What this does NOT prove is that a real orchestrator CHOOSES to continue
// rather than respawn; that is model behaviour and stays with a live run. What
// it does prove is that the state machine supports continuation — that writing
// through an existing session after CHANGES_REQUESTED is accepted and costs no
// new agent. When that broke (observed 15c, and again as a design regression in
// 17c) the symptom was silent: fix cycles quietly spawned senior_<role>_fix_N.

import type { Assertion } from '../core/types';
import { readRunSimTranscript, rec, result, str } from './util';

interface Snapshot { spawnIndex?: unknown; claimIds?: unknown }

function ids(snapshot: Snapshot): string[] {
  return Array.isArray(snapshot.claimIds) ? snapshot.claimIds as string[] : [];
}

export const assertion: Assertion = {
  id: 'run-sim-subagent-reuse',
  title: 'A fix cycle reuses the implementer instead of respawning it',
  appliesTo: (c) => c.layer === 'run-sim' && c.runSim?.fixCycle === true,
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    if (transcript.ok !== true) {
      return result(ctx, 'FAIL', `The simulated run did not complete: ${str(transcript.failure) || 'unknown failure'}`);
    }

    const cycle = rec(rec(transcript.facts).fixCycle);
    const before = rec(cycle.before) as Snapshot;
    const after = rec(cycle.after) as Snapshot;
    if (before.spawnIndex === undefined || after.spawnIndex === undefined) {
      return result(ctx, 'FAIL', 'The run recorded no fix-cycle claim snapshot, so reuse was never measured.');
    }

    if (after.spawnIndex !== before.spawnIndex) {
      return result(ctx, 'FAIL', `spawnIndex moved ${String(before.spawnIndex)} → ${String(after.spawnIndex)} across the fix cycle: the implementer was respawned rather than continued.`, {
        expected: before.spawnIndex,
        actual: after.spawnIndex,
      });
    }

    const beforeIds = ids(before);
    const afterIds = ids(after);
    if (beforeIds.join('|') !== afterIds.join('|')) {
      return result(ctx, 'FAIL', `The claim set changed across the fix cycle: [${beforeIds.join(', ')}] → [${afterIds.join(', ')}]. A reused agent keeps its claim.`, {
        expected: beforeIds,
        actual: afterIds,
      });
    }

    // The round-trip must have actually happened, or this passes vacuously.
    const phases = Array.isArray(transcript.phasesCompleted) ? transcript.phasesCompleted : [];
    if (!phases.includes('fix-cycle')) {
      return result(ctx, 'FAIL', 'No fix-cycle phase ran, so unchanged claim state proves nothing.');
    }

    return result(ctx, 'PASS', `Role ${str(cycle.role) || 'implementer'} survived a CHANGES_REQUESTED round-trip with spawnIndex ${String(before.spawnIndex)} and claim(s) [${beforeIds.join(', ')}] unchanged.`);
  },
};
