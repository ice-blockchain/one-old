// tests/replay-corpus/snapshot.ts
// The on-disk snapshot format: one tab-separated line per case, sorted by id.
// A verdict change touches exactly the lines of the cases it affects — nothing
// else moves.
//
// Columns are the identity a later deny budget / decision-log consumer keys on
// (see core/types.ts's ResultMeta): `<case id> <decision> <gate> <denyId>
// <denyTarget>`. denyTarget is stored as a REDUCED SHAPE, never the raw value —
// see run-case.ts's denyTargetShape for why (the raw value is a temp-dir
// absolute path or a freshly minted run id for several gates, i.e. exactly the
// two things that must never enter a byte-compared baseline).
//
// `repeatCount` — the other field the plan names — is deliberately absent: it
// exists on DecisionRecord (shared/state/decision-log.ts) but NOT on
// ResultMeta/HookResult, so a harness that reads runPipeline's return value has
// nothing to read. core/pipeline.ts documents the same gap at its own
// recordDecision (the count is call-site-owned inside deny-repeat.ts and is
// already baked into the rendered prose by the time a deny leaves a handler).
// Adding it would take a src/** change this corpus does not own.

import * as path from 'path';
import type { ReplayOutcome } from './run-case';

export const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.txt');

const HEADER = `# tests/replay-corpus/snapshot.txt — REVIEW EVERY DIFF, DO NOT BLINDLY ACCEPT.
#
# This is the checked-in verdict baseline for the replay corpus
# (tests/replay-corpus/replay.test.ts). Each line is one case's outcome:
#   <case id>\\t<decision>\\t<gate>\\t<denyId>\\t<denyTarget shape>
# sorted by case id. Regenerated ONLY by:
#   npm run replay:rebaseline -- --confirm-verdict-change
# (deliberately not "npm run golden:update" — this file is hand-authored
# corpus, not a generated artifact, and golden:update must never be the way a
# verdict diff goes away; see the harness's own report for why.)
# That script refuses to run without the flag, and its own second line of
# output on success is a reminder to re-read the diff it just produced. A
# diff here means the pipeline's DECISIONS changed for a real payload+state
# pair — every changed line must be read and is either an intentional,
# annotated relaxation/tightening (name it in the same commit) or a
# regression. Never regenerate this file just to make a red run go green.
`;

function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

export function formatSnapshot(outcomes: readonly ReplayOutcome[]): string {
  const sorted = [...outcomes].sort((a, b) => a.id.localeCompare(b.id));
  const lines = sorted.map((o) => [o.id, o.decision, o.gate, o.denyId, o.denyTarget].map(escapeField).join('\t'));
  return HEADER + lines.join('\n') + '\n';
}

export interface SnapshotRow {
  readonly id: string;
  readonly decision: string;
  readonly gate: string;
  readonly denyId: string;
  readonly denyTarget: string;
}

export function parseSnapshot(text: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [id, decision, gate, denyId, denyTarget] = line.split('\t');
    if (!id) continue;
    rows.push({
      id,
      decision: decision ?? '',
      gate: gate ?? '',
      denyId: denyId ?? '',
      denyTarget: denyTarget ?? '',
    });
  }
  return rows;
}

// The one place that decides whether two rows are the same VERDICT, shared by
// the test and by rebaseline's diff so they can never disagree about what a
// change is.
export function sameVerdict(a: SnapshotRow, b: SnapshotRow): boolean {
  return a.decision === b.decision && a.gate === b.gate && a.denyId === b.denyId && a.denyTarget === b.denyTarget;
}

export function describeRow(row: SnapshotRow): string {
  return `decision=${row.decision} gate=${row.gate} denyId=${row.denyId} denyTarget=${row.denyTarget}`;
}
