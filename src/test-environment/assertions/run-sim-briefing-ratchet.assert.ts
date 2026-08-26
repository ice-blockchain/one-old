// run-sim-briefing-ratchet: Class-Briefing must not fire on a first attempt,
// and the named briefing/process/user-required ids must not appear as denies
// on a fully-briefed (post-onboarding) simulated run.
//
// Negative-gate / expectDeny rows are excluded. Sequencing/Safety remaining
// on a first attempt is acceptable. A missing transcript fails the same way
// run-sim-clean does: the simulated run never started.

import {
  tallyFirstAttemptBriefing,
  type BriefingTallyEvent,
} from '../core/briefing-ratchet';
import type { Assertion } from '../core/types';
import { readRunSimTranscript, result, runSimIncomplete, str } from './util';

interface DenyRow {
  denied?: unknown;
  expected?: unknown;
  denyId?: unknown;
  spawnIndex?: unknown;
  host?: unknown;
  path?: unknown;
  role?: unknown;
  phase?: unknown;
}

function hostOf(row: DenyRow): string {
  return str(row.host) || 'claude';
}

function eventOf(row: DenyRow): BriefingTallyEvent {
  return {
    denyId: str(row.denyId),
    host: hostOf(row),
    ...(row.expected === true ? { expected: true } : {}),
    ...(typeof row.spawnIndex === 'number' ? { spawnIndex: row.spawnIndex } : {}),
  };
}

function describe(row: DenyRow, denyId: string, spawnIndex: number, host: string): string {
  const role = str(row.role) || 'parent';
  const path = str(row.path) || str(row.phase) || role;
  return `${denyId} spawnIndex=${spawnIndex} host=${host} ${role} → ${path}`;
}

function matchingRow(
  rows: DenyRow[],
  denyId: string,
  spawnIndex: number,
  host: string,
): DenyRow | undefined {
  return rows.find((row) => {
    if (row.expected === true) return false;
    if (str(row.denyId) !== denyId) return false;
    if (hostOf(row) !== host) return false;
    const recorded = typeof row.spawnIndex === 'number' ? row.spawnIndex : 1;
    return recorded === spawnIndex;
  });
}

export const assertion: Assertion = {
  id: 'run-sim-briefing-ratchet',
  title: 'No first-attempt Briefing-class deny on a fully-briefed simulated run',
  appliesTo: (c) => c.layer === 'run-sim',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) {
      return result(ctx, 'FAIL', 'No run-sim transcript was persisted — the simulated run never started.');
    }

    const writes = Array.isArray(transcript.writes) ? transcript.writes as DenyRow[] : [];
    const spawns = Array.isArray(transcript.spawns) ? transcript.spawns as DenyRow[] : [];
    const denied = [...writes, ...spawns].filter((row) => row.denied === true);
    const tally = tallyFirstAttemptBriefing(denied.map(eventOf));

    if (tally.briefingFirstAttempt.length > 0 || tally.namedRatchetHits.length > 0) {
      const lines: string[] = [];
      for (const hit of tally.briefingFirstAttempt) {
        const row = matchingRow(denied, hit.denyId, hit.spawnIndex, hit.host);
        lines.push(`briefing-first-attempt: ${describe(row ?? {}, hit.denyId, hit.spawnIndex, hit.host)}`);
      }
      for (const hit of tally.namedRatchetHits) {
        const row = matchingRow(denied, hit.denyId, hit.spawnIndex, hit.host);
        lines.push(`named-ratchet: ${describe(row ?? {}, hit.denyId, hit.spawnIndex, hit.host)}`);
      }
      return result(ctx, 'FAIL', `${lines.length} briefing-ratchet hit(s).\n${lines.join('\n')}`, {
        expected: [],
        actual: lines,
      });
    }

    if (transcript.ok !== true) {
      return runSimIncomplete(ctx, transcript, 'No first-attempt Briefing-class deny, but the run did not complete');
    }

    return result(ctx, 'PASS', `${denied.length} deny event(s) across writes/spawns; 0 first-attempt Briefing-class, 0 named-ratchet hits.`);
  },
};
