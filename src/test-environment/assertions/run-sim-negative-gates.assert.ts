// run-sim-negative-gates: the gates still REFUSE what they exist to refuse.
//
// Everything else in this tier proves gates accept correct work. That is only
// half a guarantee: a gate that quietly turned permissive — retired, misrouted,
// or narrowed by a well-meant fix — would keep every other assertion green
// while the product stopped protecting anything. Traffic One has shipped that
// exact failure before (7c: eight pre_tool_use hooks were dead for weeks and
// the suite never noticed).
//
// Each row pins the gate by a distinctive phrase from its own deny text.
// Asserting only "the write was denied" would pass when the WRONG gate refuses
// for the wrong reason, which is how a coverage gap hides in plain sight.

import type { Assertion } from '../core/types';
import { readRunSimTranscript, result, str } from './util';

interface WriteRow {
  ordinal?: unknown;
  path?: unknown;
  denied?: unknown;
  expected?: unknown;
  denyMatch?: unknown;
  reason?: unknown;
}

export const assertion: Assertion = {
  id: 'run-sim-negative-gates',
  title: 'Every adversarial write was refused by the gate that owns it',
  appliesTo: (c) => c.layer === 'run-sim' && c.runSim?.negativeGates === true,
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');

    const writes = Array.isArray(transcript.writes) ? transcript.writes as WriteRow[] : [];
    const rows = writes.filter((row) => row.expected === true);
    if (rows.length === 0) {
      return result(ctx, 'FAIL', 'The run declares negativeGates but recorded no adversarial rows, so nothing was proven.');
    }

    // Allowed when it must be denied: the gate has gone quiet.
    const allowed = rows.filter((row) => row.denied !== true);
    if (allowed.length > 0) {
      return result(ctx, 'FAIL', `${allowed.length} adversarial write(s) were ALLOWED — the guarding gate no longer refuses: ${allowed.map((row) => String(row.path)).join(', ')}.`, {
        expected: 'denied',
        actual: allowed.map((row) => String(row.path)),
      });
    }

    // Denied, but by something else: the row no longer covers its gate.
    const misrouted = rows.filter((row) => {
      const needle = str(row.denyMatch);
      if (!needle) return false;
      return !String(row.reason ?? '').includes(needle);
    });
    if (misrouted.length > 0) {
      const first = misrouted[0]!;
      return result(ctx, 'FAIL', `A different gate refused ${String(first.path)} than the one this row covers. Expected the deny to mention "${str(first.denyMatch)}"; it said:\n\n${String(first.reason ?? '').slice(0, 400)}`, {
        expected: str(first.denyMatch),
        actual: String(first.reason ?? '').slice(0, 200),
      });
    }

    const unpinned = rows.filter((row) => !str(row.denyMatch)).length;
    return result(ctx, 'PASS', `${rows.length} adversarial write(s) refused by the gate that owns each${unpinned > 0 ? ` (${unpinned} unpinned)` : ''}: ${rows.map((row) => String(row.path)).join(', ')}.`);
  },
};
