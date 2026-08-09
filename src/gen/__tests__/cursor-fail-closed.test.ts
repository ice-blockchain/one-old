// src/gen/__tests__/cursor-fail-closed.test.ts
// The Cursor `failClosed` calibration, asserted against something other than
// itself.
//
// Cursor's per-hook `failClosed` defaults to FALSE: a hook that crashes, times
// out, emits invalid JSON, or exits anything but 0 or 2 has FAILED, and the
// action it was guarding proceeds (cursor.com/docs/agent/hooks, read
// 2026-08-09). Every Traffic One gate on Cursor took that default until the
// calibration in gen/sources/hooks.ts set the flag on the events where Traffic
// One can actually deny.
//
// Both directions are regressions and only one of them looks like one:
//
//   - Dropping the flag from an enforcement event restores the silent gap. It
//     changes no test output anywhere else, produces no failure, and is
//     invisible in review — a one-token edit that turns a certified host's
//     guarantee back off.
//   - Adding it to every event looks like more safety and is not. Cursor blocks
//     THE ACTION on failure, so a flag on `stop` or `afterFileEdit` cannot
//     enforce anything (Traffic One emits no permission decision on those, see
//     adapters/cursor.ts serialize) while still wedging the turn end or
//     withholding a completed edit's result on a broken runtime.
//
// So the set is pinned from the OTHER side: the runtime's own
// isCursorPreToolSubcommand(), which is what cursor-entry.ts already fails
// closed on in-process. The host-level flag and the in-process boundary must
// name the same four events or one of the two layers is guarding something the
// other is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CURSOR_EVENTS } from '../sources/hooks';
import { isCursorPreToolSubcommand } from '../../hooks/fail-closed';
import { makeCursorAdapter } from '../../adapters/cursor';

/** Events whose emitted hook definition carries `failClosed: true`. */
function failClosedEvents(): string[] {
  return CURSOR_EVENTS.filter((row) => row.failClosed).map((row) => row.event).sort();
}

test('cursor failClosed is set on exactly the events cursor-entry already fails closed on in-process', () => {
  const declared = failClosedEvents();
  const inProcess = CURSOR_EVENTS
    .filter((row) => isCursorPreToolSubcommand(row.subcommand))
    .map((row) => row.event)
    .sort();

  assert.deepEqual(
    declared, inProcess,
    'the host-level failClosed set and the in-process fail-closed set have diverged.\n'
    + 'Every Cursor event whose subcommand is an isCursorPreToolSubcommand (hooks/fail-closed.ts)\n'
    + 'must carry failClosed: true, and no other event may — see the calibration block in\n'
    + `gen/sources/hooks.ts.\n  host: ${declared.join(', ')}\n  in-process: ${inProcess.join(', ')}`,
  );
  // Anchored so an empty-vs-empty comparison cannot pass this test: deleting the
  // flag from every row AND emptying isCursorPreToolSubcommand would otherwise
  // agree at zero.
  assert.equal(declared.length, 4, `expected four fail-closed Cursor events, got ${declared.length}`);
});

test('cursor failClosed is set on exactly the events whose adapter can emit a deny', () => {
  const adapter = makeCursorAdapter();
  // The load-bearing property, read out of the adapter rather than asserted
  // about it: `permission: 'deny'` is the only output that blocks, and Cursor's
  // serialize() emits it only when the parsed event is PreToolUse. An event that
  // cannot be denied on SUCCESS must not be blocked on FAILURE.
  const canDeny = CURSOR_EVENTS.filter((row) => {
    const parsed = adapter.parse({ stdin: '{"cwd":"/tmp/x","command":"echo hi"}', argv: [row.subcommand] });
    const out = adapter.serialize({ kind: 'deny', reason: 'calibration probe' }, parsed);
    return (JSON.parse(out) as { permission?: string }).permission === 'deny';
  }).map((row) => row.event).sort();

  assert.deepEqual(
    failClosedEvents(), canDeny,
    'failClosed must cover exactly the Cursor events on which Traffic One can deny.\n'
    + 'An event missing from the flag is a gate that stops enforcing when the runtime breaks;\n'
    + 'an extra event blocks a user action to enforce a decision this adapter never makes.',
  );
});

test('cursor hook rows never state failClosed: false', () => {
  // Omission and an explicit `false` behave identically (false is Cursor's
  // default), so a stated `false` adds no enforcement and one false claim: that
  // fail-open was weighed and chosen for an event that cannot block at all. The
  // type already forbids it; this is the assertion that survives a type change.
  for (const row of CURSOR_EVENTS) {
    assert.notEqual(
      row.failClosed as boolean | undefined, false,
      `${row.event}: record the decision in the calibration comment, not as a restated default`,
    );
  }
});
