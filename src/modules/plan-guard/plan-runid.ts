// src/modules/plan-guard/plan-runid.ts
// Run-id write-guard: a feature build's run-id is `currentRunId` (a gate-minted
// epoch-ms number). Refuse any write to `.traffic-one/runs/<id>/…` or
// `.traffic-one/digests/<id>/…` whose <id> diverges from `currentRunId`, so a
// self-generated `date`/ISO run-id can't strand assignments/digests under a stray
// tree (the run-id split that blocks implementer spawns). Returns a single deny
// reason (or null). Enforcement-bearing: a verbatim TS fallback ships the prose.

import * as fs from 'fs';
import * as path from 'path';

import type { Rec } from '../../shared/obj';
import { shellCommandHasWritePrimitive } from '../../shared/feature-source';
import { strayRunIdInText } from '../../shared/run-id-paths';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

interface RunIdArgs {
  state: Rec;
  relTargets: string[];   // project-relative write targets (Write/Edit/apply_patch)
  command: string;        // raw shell command (catches `> .traffic-one/runs/<id>/…`)
  block: Block;
  projectRoot?: string;   // enables the run-rotation exemption below
}

// A child spawned into run A writes the handoff digest it was TOLD to write.
// If `currentRunId` moved to run B underneath it, that is a run split, not the
// fabricated `date`/ISO id this gate exists to catch — and denying it strands
// the child with no way to report its work. Exempt a stray id that names a real
// run directory, strictly epoch-ms so an ISO id can never qualify.
function strayNamesRealRun(projectRoot: string | undefined, stray: string): boolean {
  if (!projectRoot || !/^\d{13}$/.test(stray)) return false;
  try {
    return fs.existsSync(path.join(projectRoot, '.traffic-one', 'runs', stray, 'run.json'));
  } catch {
    return false;
  }
}

export function runIdPathViolation(args: RunIdArgs): string | null {
  const { state, relTargets, command, block, projectRoot } = args;
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!currentRunId) return null;           // not minted yet → nothing to enforce against
  // relTargets are Write/Edit/apply_patch destinations — always writes, always
  // scanned. The shell `command` is scanned only when it actually WRITES (a
  // redirect/tee/heredoc/cp/mv/sed -i under a runs|digests path is what strands
  // state); a pure read that merely NAMES another run dir — e.g. `sed -n '1,80p'
  // .traffic-one/runs/<other-id>/model-policy.json`, which the agent runs after a
  // run-id-announce points it at a now-stale id — must not be denied (observed
  // 11c: a read of the announced-but-orphaned run dir was blocked here).
  const commandWrites = shellCommandHasWritePrimitive(command) ? command : '';
  const haystack = [...relTargets, commandWrites].filter(Boolean).join('\n');
  const stray = strayRunIdInText(haystack, currentRunId);
  if (!stray) return null;
  if (strayNamesRealRun(projectRoot, stray)) return null;
  return block('run-id-mismatch',
    `Run-id gate: this run's id (\`currentRunId\` in .traffic-one/.one.json) is \`${currentRunId}\`, but this write targets run-id \`${stray}\`. The run-id is a plain epoch-millisecond number Traffic One mints for you — do NOT generate one with \`date\` (an ISO/UTC string like \`2026-06-17T12-09-40Z\` splits run state: assignments and digests land under a stray \`.traffic-one/runs/${stray}/\` that the run-team and OpenCode gates — keyed on \`${currentRunId}\` — cannot see, blocking implementer spawns). Read \`currentRunId\` from .traffic-one/.one.json and write under \`.traffic-one/runs/${currentRunId}/\` and \`.traffic-one/digests/${currentRunId}/\` instead.`,
    { EXPECTED: currentRunId, WRONG: stray });
}
