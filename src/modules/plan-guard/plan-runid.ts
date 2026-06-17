// src/modules/plan-guard/plan-runid.ts
// Run-id write-guard: a feature build's run-id is `currentRunId` (a gate-minted
// epoch-ms number). Refuse any write to `.traffic-one/runs/<id>/…` or
// `.traffic-one/digests/<id>/…` whose <id> diverges from `currentRunId`, so a
// self-generated `date`/ISO run-id can't strand assignments/digests under a stray
// tree (the run-id split that blocks implementer spawns). Returns a single deny
// reason (or null). Enforcement-bearing: a verbatim TS fallback ships the prose.

import type { Rec } from '../../shared/obj';
import { strayRunIdInText } from '../../shared/run-id-paths';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

export interface RunIdArgs {
  state: Rec;
  relTargets: string[];   // project-relative write targets (Write/Edit/apply_patch)
  command: string;        // raw shell command (catches `> .traffic-one/runs/<id>/…`)
  block: Block;
}

export function runIdPathViolation(args: RunIdArgs): string | null {
  const { state, relTargets, command, block } = args;
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!currentRunId) return null;           // not minted yet → nothing to enforce against
  const haystack = [...relTargets, command].filter(Boolean).join('\n');
  const stray = strayRunIdInText(haystack, currentRunId);
  if (!stray) return null;
  return block('run-id-mismatch',
    `Run-id gate: this run's id (\`currentRunId\` in .traffic-one/.one.json) is \`${currentRunId}\`, but this write targets run-id \`${stray}\`. The run-id is a plain epoch-millisecond number Traffic One mints for you — do NOT generate one with \`date\` (an ISO/UTC string like \`${stray}\` splits run state: assignments and digests land under a stray \`.traffic-one/runs/${stray}/\` that the run-team and OpenCode gates — keyed on \`${currentRunId}\` — cannot see, blocking implementer spawns). Read \`currentRunId\` from .traffic-one/.one.json and write under \`.traffic-one/runs/${currentRunId}/\` and \`.traffic-one/digests/${currentRunId}/\` instead.`,
    { EXPECTED: currentRunId, WRONG: stray });
}
