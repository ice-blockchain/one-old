// tests/replay-corpus/replay.test.ts
// Replays the entire recorded payload corpus through the REAL runPipeline
// (real dynamically-loaded handlers, no synthetic gates) and asserts, for every
// case: the gate it CLAIMS to characterize actually produced its verdict, and
// the {decision, gate, denyId, denyTarget} record matches the checked-in
// snapshot (snapshot.txt). See that file's header for the re-baseline
// discipline, run-case.ts for the replay primitive, fixtures.ts for the
// project-state builders, cases/*.cases.ts for the corpus itself, and
// coverage.test.ts for the reach floor that keeps it from rotting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';

import { replayCase } from './run-case';
import { ALL_CASES, assertUniqueCaseIds } from './cases';
import { cleanupReplayTempTrees } from './fixtures';
import { describeRow, formatSnapshot, parseSnapshot, sameVerdict, SNAPSHOT_PATH } from './snapshot';

// Frees the isolated HOME (with the synthetic plugin root) and every fixture
// project as soon as this file's tests finish, instead of holding ~100 project
// trees until process exit. env.ts/fixtures.ts also register the same cleanups
// on 'exit' as a crash backstop; both are idempotent.
test.after(cleanupReplayTempTrees);

test('replay corpus: every case id is unique', () => {
  assertUniqueCaseIds(ALL_CASES);
});

test('replay corpus: every case declares the gate it characterizes', () => {
  for (const spec of ALL_CASES) {
    assert.ok(
      spec.expectGate === null || (typeof spec.expectGate === 'string' && spec.expectGate.length > 0),
      `case ${spec.id}: expectGate must be a handler id, or null for a control case`,
    );
  }
});

test('replay corpus: at least 80 cases, every canonical event, every host', () => {
  assert.ok(ALL_CASES.length >= 80, `expected >= 80 cases, got ${ALL_CASES.length}`);
  const events = new Set(ALL_CASES.map((c) => c.event));
  const hosts = new Set(ALL_CASES.map((c) => c.host));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) {
    assert.ok(events.has(event as never), `no case exercises canonical event ${event}`);
  }
  for (const host of ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo']) {
    assert.ok(hosts.has(host as never), `no case exercises host ${host}`);
  }
});

test('replay corpus matches the checked-in snapshot', async () => {
  const outcomes = [];
  for (const spec of ALL_CASES) outcomes.push(await replayCase(spec));
  const actual = formatSnapshot(outcomes);
  const actualRows = parseSnapshot(actual);

  // Asserted BEFORE the snapshot comparison: a case landing on a different gate
  // is a mis-specified case, and saying so names the actual culprit instead of
  // reporting a snapshot diff whose cause the reader has to go and find. This is
  // what the corpus lacked when all ten plan-guard cases silently characterized
  // onboarding-gate's convergence deny.
  const wrongGate: string[] = [];
  for (const spec of ALL_CASES) {
    const row = actualRows.find((candidate) => candidate.id === spec.id);
    if (!row) continue;
    if (spec.expectGate === null) {
      if (row.decision === 'deny') {
        wrongGate.push(`${spec.id}: declared a control case (expectGate: null) but was DENIED by ${row.gate} (${row.denyId})`);
      }
      continue;
    }
    if (row.decision !== 'deny') {
      wrongGate.push(`${spec.id}: expected a deny from ${spec.expectGate}, got decision=${row.decision}`);
    } else if (row.gate !== spec.expectGate) {
      wrongGate.push(`${spec.id}: expected the deny to come from ${spec.expectGate}, got ${row.gate} (${row.denyId})`);
    }
  }
  assert.ok(
    wrongGate.length === 0,
    'replay corpus: case(s) did not reach the gate they declare (fix the case\'s fixture/payload, or\n'
    + 'correct its expectGate + notes if the real verdict is the interesting one):\n\n'
    + `${wrongGate.join('\n')}`,
  );

  // Determinism guard for the one column that is REDUCED rather than recorded
  // verbatim (denyTarget — see run-case.ts's denyTargetShape). Every fixture
  // root and the synthetic plugin root live under the OS temp dir, so a raw
  // value leaking through the reduction would embed a machine-specific,
  // per-run path in the baseline and break every later verification.
  const tmp = fs.realpathSync(os.tmpdir());
  for (const row of actualRows) {
    for (const field of [row.denyTarget, row.gate, row.denyId]) {
      assert.ok(
        !field.includes(tmp) && !field.includes(os.tmpdir()),
        `${row.id}: snapshot field contains an absolute temp path (${field}) — the reduction in `
        + 'run-case.ts must name its shape instead',
      );
    }
  }

  let expectedText: string;
  try {
    expectedText = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    assert.fail(
      `${SNAPSHOT_PATH} does not exist yet. Create the initial baseline with:\n`
      + '  npm run replay:rebaseline -- --confirm-verdict-change\n'
      + 'then review the printed diff before committing it.',
    );
    return;
  }
  const expectedRows = parseSnapshot(expectedText);
  const expectedById = new Map(expectedRows.map((r) => [r.id, r]));
  const actualById = new Map(actualRows.map((r) => [r.id, r]));

  const mismatches: string[] = [];
  for (const row of actualRows) {
    const expected = expectedById.get(row.id);
    if (!expected) {
      mismatches.push(`+ ${row.id}: new case, not in snapshot (run rebaseline after review)`);
      continue;
    }
    if (!sameVerdict(expected, row)) {
      mismatches.push(`~ ${row.id}:\n    snapshot: ${describeRow(expected)}\n    actual:   ${describeRow(row)}`);
    }
  }
  for (const row of expectedRows) {
    if (!actualById.has(row.id)) mismatches.push(`- ${row.id}: case removed but still present in the snapshot`);
  }

  assert.ok(
    mismatches.length === 0,
    'replay corpus verdict drift (review each line — an intended change still needs\n'
    + 're-baselining via npm run replay:rebaseline -- --confirm-verdict-change):\n\n'
    + `${mismatches.join('\n')}`,
  );
});
