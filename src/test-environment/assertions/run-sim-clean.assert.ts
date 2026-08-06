// run-sim-clean: every scripted write was allowed at the moment a competent
// role would have made it.
//
// This is the tier's primary claim. A false deny anywhere in the chain — a gate
// that fires on correct work — is the failure mode that costs a real run its
// budget and sends the orchestrator into a re-plan loop. Here it costs one
// assertion, and the transcript names the file, the role, the ordinal, and the
// verbatim deny the model would have read.
//
// Expected denies (negative-gate rows) are declared per write and are NOT
// failures; a row that stops denying is, because that means a gate went quiet.

import type { Assertion } from '../core/types';
import { readRunSimTranscript, result, runSimIncomplete, str } from './util';

interface WriteRow {
  ordinal?: unknown;
  phase?: unknown;
  role?: unknown;
  path?: unknown;
  denied?: unknown;
  expected?: unknown;
  reason?: unknown;
}

function describe(row: WriteRow): string {
  const ordinal = typeof row.ordinal === 'number' ? `#${row.ordinal}` : '#?';
  return `${ordinal} ${String(row.phase ?? '?')} ${String(row.role ?? 'parent')} → ${String(row.path ?? '?')}`;
}

export const assertion: Assertion = {
  id: 'run-sim-clean',
  title: 'Every scripted write passed the gate it should have',
  appliesTo: (c) => c.layer === 'run-sim',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) {
      return result(ctx, 'FAIL', 'No run-sim transcript was persisted — the simulated run never started.');
    }
    const writes = Array.isArray(transcript.writes) ? transcript.writes as WriteRow[] : [];
    if (writes.length === 0) {
      return result(ctx, 'FAIL', 'The simulated run recorded no writes at all.');
    }

    // A write that was denied without declaring it: a false deny on correct work.
    const falseDenies = writes.filter((row) => row.denied === true && row.expected !== true);
    if (falseDenies.length > 0) {
      const first = falseDenies[0]!;
      const detail = [
        `${falseDenies.length} unexpected deny/denies. First: ${describe(first)}`,
        '',
        str(first.reason) || '(no reason recorded)',
      ].join('\n');
      return result(ctx, 'FAIL', detail, {
        expected: 'allowed',
        actual: falseDenies.map(describe),
      });
    }

    // A negative row that stopped denying: the gate it guards went quiet.
    const silentGates = writes.filter((row) => row.expected === true && row.denied !== true);
    if (silentGates.length > 0) {
      return result(ctx, 'FAIL', `${silentGates.length} write(s) were expected to be DENIED but were allowed — the guarding gate has gone quiet: ${silentGates.map(describe).join('; ')}.`, {
        expected: 'denied',
        actual: silentGates.map(describe),
      });
    }

    // Deliberately last: every gate verdict above is judged on its own merits
    // first, so a false deny is still a FAIL even when the run later stopped for
    // a missing toolchain.
    if (transcript.ok !== true) {
      return runSimIncomplete(ctx, transcript, 'No write was falsely denied, but the run did not complete');
    }

    const phases = Array.isArray(transcript.phasesCompleted)
      ? transcript.phasesCompleted.join(' → ')
      : '(none)';
    const expectedDenies = writes.filter((row) => row.expected === true).length;
    return result(ctx, 'PASS', `${writes.length} scripted write(s) across ${phases}; 0 false denies${expectedDenies > 0 ? `, ${expectedDenies} expected deny/denies confirmed` : ''}.`);
  },
};
