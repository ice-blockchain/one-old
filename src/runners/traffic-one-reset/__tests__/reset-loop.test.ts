// THE LOOP: what repeated resets buy, and what stops them buying it.
//
// One reset is made conserving by obligations.ts. TEN were not, and the reason
// was not the carry rule — it was that `runs/.resets.json` was WRITE-ONLY.
// Nothing in `src/**` read it, so every cycle handed the successor a clean copy
// of the whole dropped bucket, at full value, without limit. The five-cycle
// measurement that preceded this file only tracked the CARRIED bucket, so it
// could not see that.
//
// A cap is still the wrong answer (resets.ts's header argues that at length: a
// cap is a wedge with a counter on it, and the population this command serves is
// projects where every other route out is already blocked). The answer is a
// record that is READ: at WIDEN_AT resets the carry widens, and the file below
// is the proof obligation that comes with widening —
//
//   RECOVERY MUST NEVER STOP WORKING. At every cycle, including well past
//   WIDEN_AT, the reset succeeds, the successor admits claims, a role can bind
//   one, and a role that did not itself exhaust its rotation has an admissible
//   model. The widened bound is a COST with a route out, not a brick.
//
// Driven to WIDEN_AT + 5 cycles, which is where the previous measurement stopped
// looking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resetRun } from '../reset';
import { readResetRecord } from '../resets';
import { WIDEN_AT } from '../obligations';
import {
  ensureRunAgentClaimResult,
  ensureRunLedger,
  readState,
  runLedgerClaimAdmission,
  statePath,
  transitionRunStatus,
} from '../../../shared/state';
import {
  clearExhaustedModels,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';
import { markModelChoicePrompted, modelChoiceReplyPending, writeModelChoice } from '../../../modules/agent-model/model-choice';
import { bumpRunAgentActivity, readRunAgentActivity } from '../../../shared/state/run-agent/activity';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';

const CYCLES = WIDEN_AT + 5;
const MODEL = 'gpt-5.6-terra-medium';

const fixtures: string[] = [];

test.after(() => {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_HOST;
  resetAuthoringRootCache();
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function wedgedProject(label: string, runId: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `one-reset-loop-${label}-`)));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_HOST = 'claude';
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    pluginUse: { enabled: true, source: 'test', decidedAt: new Date().toISOString() },
  }), 'utf8');
  resetAuthoringRootCache();
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: true,
    confirmed: true,
    lifecycle: { phase: 'maintenance', source: 'heuristic', completedAt: new Date().toISOString() },
    team: { mode: 'subagents', approved: true },
    currentRunId: runId,
  }), 'utf8');
  return dir;
}

function driveToFailed(dir: string, runId: string): void {
  // Best-effort: from the second cycle onward the reset has already opened the
  // successor's ledger (kind `run-reset`), and the transitions below are what
  // actually prove it is usable.
  ensureRunLedger(dir, runId, { status: 'planned', kind: 'agent-claim' });
  assert.ok(transitionRunStatus(dir, runId, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, runId, { status: 'failed', outcome: 'agent-failed' }));
}

interface Cycle {
  readonly reset: number;
  readonly ok: boolean;
  readonly admitsClaims: boolean;
  readonly bindsAClaim: boolean;
  /** The role that never exhausted anything: it must ALWAYS have a model. */
  readonly freshRoleHasModel: boolean;
  /** The role that burned its whole rotation every cycle. */
  readonly burnedRoleHasModel: boolean;
  readonly ttlCondemnationCarried: boolean;
  readonly terminalCarried: boolean;
  readonly buildPauseHeld: boolean;
  readonly tally: number;
  readonly widened: readonly string[];
}

test(`the loop: ${CYCLES} resets, and the widening never wedges the successor`, () => {
  let current = 'LOOP-0';
  const dir = wedgedProject('widen', current);
  const observed: Cycle[] = [];

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    // The same three bounds burned in every cycle, by the product's writers:
    // a whole model rotation for one role, an unanswered build pause, and an
    // over-cap exploration tally.
    recordExhaustedModel(dir, current, 'senior-frontend', MODEL);
    assert.ok(markModelExhaustionTerminal(dir, current, 'senior-frontend'));
    markModelChoicePrompted(dir, current);
    bumpRunAgentActivity(dir, current, 'senior-frontend', 'child-A');

    driveToFailed(dir, current);
    assert.equal(runLedgerClaimAdmission(dir, current), 'closed', 'fixture guard: really wedged');

    const result = resetRun(dir, current);
    const fresh = result.freshRunId as string;
    const claim = result.ok
      ? ensureRunAgentClaimResult(dir, readState(dir), 'senior-frontend', { session_id: `child-${cycle}` })
      : null;

    observed.push({
      reset: cycle + 1,
      ok: result.ok,
      admitsClaims: result.ok && runLedgerClaimAdmission(dir, fresh) === 'admits',
      bindsAClaim: claim?.outcome === 'applied',
      freshRoleHasModel: !modelIsExhausted(dir, fresh, 'senior-backend', MODEL)
        && !modelExhaustionTerminalForRole(dir, fresh, 'senior-backend'),
      burnedRoleHasModel: !modelIsExhausted(dir, fresh, 'senior-frontend', MODEL)
        && !modelExhaustionTerminalForRole(dir, fresh, 'senior-frontend'),
      ttlCondemnationCarried: modelIsExhausted(dir, fresh, 'senior-frontend', MODEL),
      terminalCarried: modelExhaustionTerminalForRole(dir, fresh, 'senior-frontend'),
      buildPauseHeld: modelChoiceReplyPending(dir, readState(dir) as Record<string, unknown>),
      tally: readRunAgentActivity(dir, fresh, 'senior-frontend').bySession['child-A'] ?? 0,
      widened: result.warnings.filter((line) => line.includes('so the successor inherits')),
    });
    current = fresh;
  }

  // ── RECOVERY NEVER STOPS WORKING ──────────────────────────────────────────
  assert.deepEqual(observed.map((c) => c.ok), Array(CYCLES).fill(true),
    'every reset succeeds, at every count: this is not a cap');
  assert.deepEqual(observed.map((c) => c.admitsClaims), Array(CYCLES).fill(true),
    'the successor admits claims at every count');
  assert.deepEqual(observed.map((c) => c.bindsAClaim), Array(CYCLES).fill(true),
    'and a role actually binds one — the first legitimate action always succeeds');
  assert.deepEqual(observed.map((c) => c.freshRoleHasModel), Array(CYCLES).fill(true),
    'a role that never exhausted its rotation has an admissible model at every step, '
    + 'including every widened cycle: the widening is per role, not per project');

  // ── AND THE LOOP STOPS PAYING ─────────────────────────────────────────────
  // Before: every cycle handed back a clean model ledger and released the
  // user-reply pause again. Both are now conserved from the first cycle.
  assert.deepEqual(observed.map((c) => c.ttlCondemnationCarried), Array(CYCLES).fill(true),
    'the TTL condemnation follows every time: the rate-limited model is never refunded');
  assert.deepEqual(observed.map((c) => c.buildPauseHeld), Array(CYCLES).fill(true),
    'the pause waiting on a human is never released by a pointer move');
  assert.deepEqual(observed.map((c) => c.tally), Array.from({ length: CYCLES }, (_, i) => i + 1),
    'and the exploration tally accumulates rather than restarting');

  // ── THE WIDENING ──────────────────────────────────────────────────────────
  const widenedFrom = observed.findIndex((c) => c.widened.length > 0) + 1;
  assert.equal(widenedFrom, WIDEN_AT, `the widening lands at reset ${WIDEN_AT}, not before`);
  assert.deepEqual(
    observed.map((c) => c.terminalCarried),
    Array.from({ length: CYCLES }, (_, i) => i + 1 >= WIDEN_AT),
    'the non-expiring terminal marker is forgiven for the first two recoveries and '
    + 'inherited from the third onward — recovery stays available, it stops being free',
  );
  for (const cycle of observed.slice(WIDEN_AT - 1)) {
    assert.ok(cycle.widened.length === 1,
      `reset ${cycle.reset} widened, so the caller must be TOLD which bound followed`);
  }
  // WHERE the price is paid, not just that it is. The successor's own store must
  // NOT hold the marker: it is recorded in `.resets.json` precisely because the
  // store is the file one held lease defeats (see resets.ts ResetObligation),
  // and a copy left in the store would quietly restore the defeatable route.
  assert.deepEqual(
    readResetRecord(dir).obligations[current]?.terminalRoles ?? [],
    ['senior-frontend'],
    'the widening is recorded against the successor, in the one file with a single writer and no lease',
  );

  // ── AND THE ROUTE OUT OF THE WIDENED BOUND IS THE ONE THE PRODUCT ALREADY
  //    ASKS FOR. This is what makes the cost a cost rather than a brick: the
  //    user's "I fixed the budget" answer records `enable-retry` and then calls
  //    clearExhaustedModels, in that order (choice-reply.ts), and the burned
  //    role is immediately admissible again — inside the same run, with no
  //    further reset. Both steps, because they discharge the two halves the
  //    widening is paid into: the answer discharges the recorded obligation
  //    (resetObligationFor folds it in rather than deleting it, which is what
  //    keeps `.resets.json` to one writer), the unlink clears this run's store.
  assert.equal(observed[CYCLES - 1]?.burnedRoleHasModel, false,
    'fixture guard: by the last cycle the burned role is carrying its own terminal marker');
  assert.ok(writeModelChoice(dir, current, 'enable-retry'));
  clearExhaustedModels(dir, current);
  assert.equal(modelExhaustionTerminalForRole(dir, current, 'senior-frontend'), false);
  assert.equal(modelIsExhausted(dir, current, 'senior-frontend', MODEL), false,
    "the user's enable/retry answer clears it in place: the widened bound has a route out that is not another reset");

  assert.equal(readResetRecord(dir).count, CYCLES, 'and every cycle is on the record that drove the widening');
});
