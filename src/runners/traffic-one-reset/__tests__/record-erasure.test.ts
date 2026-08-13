// WHAT ERASING `.traffic-one/runs/.resets.json` BUYS — measured, in real bash.
//
// The record is fenced by `reset-record-owner-gate`, and three classes of shell
// line get past that fence because they hide the path from static reading: a
// substitution's PRINTED value, an `eval` body naming the runs directory with no
// run directory for the sibling sidecar fence to answer first, and an interpreter
// join that splits both names through the middle. Five rounds of adding spellings
// to the detector were each followed by a hand-found sixth, and no reader of
// command text can enumerate a value produced at run time.
//
// So this file does not test the detector. It tests THE PAYOFF, which is what the
// mirror in the successor's ledger removes (resets.ts THE MIRROR):
//
//   the ERASURE ITSELF is performed here by `/bin/bash`, through the spelling
//   that no fence sees, and the two decisions the record feeds must be
//   UNCHANGED afterwards — the count that prices the next reset, and the
//   terminal model exhaustion that stops an exhausted role respawning without
//   the user's enable/retry answer.
//
// It also pins the one ordering that a future refactor of the read could break
// in silence: the user's discharge is evaluated AHEAD of both sources, so a
// stale mirror cannot hand back an obligation the user already cleared. The
// mutant is spelled out below and asserted to differ, because a comment saying
// "keep the discharge first" is not a test.
//
// And it pins the false-positive side, which is the whole risk of a second
// source: a fresh project, a project whose `.traffic-one` the user deleted, and
// a runs directory retention has swept must each answer exactly what they
// answered before the mirror existed — nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resetRun } from '../reset';
import { priorResetCount, readResetRecord, resetObligationFor } from '../resets';
import { WIDEN_AT } from '../obligations';
import {
  ensureRunLedger,
  runLedgerClaimAdmission,
  statePath,
  transitionRunStatus,
} from '../../../shared/state';
import {
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';
import { markModelChoicePrompted, readModelChoice, writeModelChoice } from '../../../modules/agent-model/model-choice';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';

const ROLE = 'senior-frontend';
const MODEL = 'gpt-5.6-terra-medium';
const RECORD_REL = path.join('.traffic-one', 'runs', '.resets.json');

const fixtures: string[] = [];

test.after(() => {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_HOST;
  resetAuthoringRootCache();
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function project(label: string, runId: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `one-resets-${label}-`)));
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

/** One cycle of the thing this whole mechanism prices: a role burns its rotation
 *  terminally, the run wedges in `failed`, and recovery mints a successor. */
function resetOnce(dir: string, runId: string): { fresh: string; warnings: readonly string[] } {
  recordExhaustedModel(dir, runId, ROLE, MODEL);
  assert.ok(markModelExhaustionTerminal(dir, runId, ROLE));
  markModelChoicePrompted(dir, runId);
  ensureRunLedger(dir, runId, { status: 'planned', kind: 'agent-claim' });
  assert.ok(transitionRunStatus(dir, runId, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, runId, { status: 'failed', outcome: 'agent-failed' }));
  assert.equal(runLedgerClaimAdmission(dir, runId), 'closed', 'fixture guard: really wedged');
  const result = resetRun(dir, runId);
  assert.ok(result.ok && result.freshRunId, `fixture: reset refused (${result.code})`);
  return { fresh: result.freshRunId as string, warnings: result.warnings };
}

function driveTo(dir: string, first: string, cycles: number): string {
  let current = first;
  for (let cycle = 0; cycle < cycles; cycle += 1) current = resetOnce(dir, current).fresh;
  return current;
}

function ledger(dir: string, runId: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json'), 'utf8')) as Record<string, unknown>;
  } catch { return {}; }
}

/** The erasure itself, by `/bin/bash`, through the class that survives every
 *  fence: the path is never spelled in the command — it is what a substitution
 *  PRINTS. Nothing here asks a gate anything; the point is what remains true
 *  after the file is genuinely gone. */
function eraseTheRecordInRealBash(dir: string): void {
  fs.writeFileSync(path.join(dir, '.where'), RECORD_REL, 'utf8');
  execFileSync('/bin/bash', ['-c', 'rm -f "$(cat .where)"'], { cwd: dir, stdio: 'ignore' });
  assert.equal(fs.existsSync(path.join(dir, RECORD_REL)), false, 'fixture guard: the record is really gone');
}

test('erasing the record no longer buys a free reset or an unbound respawn', () => {
  let current = 'ERASE-0';
  const dir = project('erase', current);
  current = driveTo(dir, current, WIDEN_AT);

  // Before: the widening is live, on the record, and reaching the gate's input.
  assert.equal(readResetRecord(dir).count, WIDEN_AT);
  assert.deepEqual(resetObligationFor(dir, current).terminalRoles, [ROLE]);
  assert.equal(modelExhaustionTerminalForRole(dir, current, ROLE), true);
  // And the same two facts are in the successor's own ledger, beside the
  // `supersedes` the reset already wrote.
  assert.equal(ledger(dir, current).resetSeq, WIDEN_AT);
  assert.deepEqual(ledger(dir, current).inheritedTerminalRoles, [ROLE]);

  eraseTheRecordInRealBash(dir);

  // The record itself is empty — this row is not pretending the file survived.
  assert.equal(readResetRecord(dir).count, 0, 'the shipped record reads empty, because it was deleted');
  assert.deepEqual(readResetRecord(dir).obligations, {});

  // AND NOTHING THE RECORD FEEDS MOVED.
  assert.equal(priorResetCount(dir, current), WIDEN_AT,
    'the next reset is priced at the count the ladder had reached, not at zero');
  assert.deepEqual(resetObligationFor(dir, current).terminalRoles, [ROLE],
    'the inherited terminal exhaustion survives the erasure');
  assert.equal(modelExhaustionTerminalForRole(dir, current, ROLE), true,
    "the deny's input is unchanged, so the exhausted role still cannot respawn without the user's answer");

  // The proof that the COUNT half is load-bearing and not decorative: the reset
  // taken after the erasure still widens, and the successor is stamped at the
  // real height of the ladder rather than at 1.
  const next = resetOnce(dir, current);
  assert.equal(ledger(dir, next.fresh).resetSeq, WIDEN_AT + 1,
    'the ladder continued from where it stood; an erasure does not roll it back to free');
  assert.equal(next.warnings.filter((line) => line.includes('so the successor inherits')).length, 1,
    'and the widening still applies to the successor, which is what the erasure was for');
  assert.deepEqual(resetObligationFor(dir, next.fresh).terminalRoles, [ROLE]);
});

// ── THE ORDERING. This is the row to read if the mirror is ever refactored. ───
//
// The mirror is a SNAPSHOT of the value `recordReset` was handed, so it cannot
// say more than the record would have — except in one direction: time. The user
// answers enable/retry, `resetObligationFor` folds that answer in rather than
// deleting the record's row, and a second copy read WITHOUT that fold hands the
// discharged obligation straight back. The fold is therefore ahead of both
// sources, and this row fails if it moves.
test('the enable/retry answer discharges the MIRROR too, because the discharge is ahead of both sources', () => {
  let current = 'DISCHARGE-0';
  const dir = project('discharge', current);
  current = driveTo(dir, current, WIDEN_AT);
  assert.deepEqual(resetObligationFor(dir, current).terminalRoles, [ROLE], 'fixture guard: bound before the answer');
  assert.deepEqual(ledger(dir, current).inheritedTerminalRoles, [ROLE], 'fixture guard: the mirror holds it too');

  assert.ok(writeModelChoice(dir, current, 'enable-retry'));

  assert.deepEqual(resetObligationFor(dir, current).terminalRoles, [],
    "the user's answer clears the obligation even though the ledger mirror still holds the role");
  assert.equal(modelExhaustionTerminalForRole(dir, current, ROLE), false,
    'so the role is admissible again in place, with no further reset — the route out is unchanged');

  // The mirror is deliberately NOT rewritten by the discharge: `.resets.json` has
  // exactly one writer and the ledger keeps the reset's own snapshot. What makes
  // that safe is only the read order, so here is the order that is NOT shipped —
  // the record discharged, the mirror consulted anyway, which is precisely the
  // shape a refactor produces when it hoists the two reads above the fold.
  const unionBeforeDischarge = (runId: string): readonly string[] => {
    const discharged = readModelChoice(dir, runId) === 'enable-retry';
    const recorded = discharged ? [] : readResetRecord(dir).obligations[runId]?.terminalRoles ?? [];
    const raw = ledger(dir, runId).inheritedTerminalRoles;
    const mirrored = Array.isArray(raw) ? raw.filter((role): role is string => typeof role === 'string') : [];
    return [...new Set([...recorded, ...mirrored])].sort();
  };
  assert.deepEqual(unionBeforeDischarge(current), [ROLE],
    'the mutant read order resurrects the discharged obligation — that is what this row exists to catch');
  assert.notDeepEqual(resetObligationFor(dir, current).terminalRoles, unionBeforeDischarge(current),
    'and the shipped read disagrees with it, which is the assertion that fails if the order is changed');
});

test('a fresh project, a deleted .traffic-one, and a swept runs directory answer exactly what they did before', () => {
  // FRESH: no record, no mirror, nothing to be suspicious of. A second source
  // that guessed at absent state would refuse real work here; this one is silent.
  const fresh = project('fresh', 'FRESH-1');
  ensureRunLedger(fresh, 'FRESH-1', { status: 'planned', kind: 'agent-claim' });
  assert.equal(fs.existsSync(path.join(fresh, RECORD_REL)), false);
  assert.equal(priorResetCount(fresh, 'FRESH-1'), 0);
  assert.deepEqual(resetObligationFor(fresh, 'FRESH-1').terminalRoles, []);
  assert.equal(modelExhaustionTerminalForRole(fresh, 'FRESH-1', ROLE), false);

  // DELETED BY THE USER: the whole directory, which is a supported thing to do.
  const wiped = project('wiped', 'WIPED-1');
  driveTo(wiped, 'WIPED-1', 1);
  fs.rmSync(path.join(wiped, '.traffic-one'), { recursive: true, force: true });
  assert.equal(priorResetCount(wiped, 'WIPED-1'), 0);
  assert.deepEqual(resetObligationFor(wiped, 'WIPED-1').terminalRoles, []);
  assert.equal(modelExhaustionTerminalForRole(wiped, 'WIPED-1', ROLE), false);

  // SWEPT: retention deletes RETIRED run directories and reserves the current
  // one. The mirror that matters is the current run's, so the sweep takes
  // nothing the readers need — and the record, which retention never removes,
  // is untouched.
  let current = 'SWEPT-0';
  const swept = project('swept', current);
  current = driveTo(swept, current, WIDEN_AT);
  const runs = path.join(swept, '.traffic-one', 'runs');
  for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== current) fs.rmSync(path.join(runs, entry.name), { recursive: true, force: true });
  }
  assert.equal(priorResetCount(swept, current), WIDEN_AT);
  assert.deepEqual(resetObligationFor(swept, current).terminalRoles, [ROLE]);

  // And the symmetric loss — the CURRENT run's directory gone, the record
  // intact — is answered by the record alone, exactly as it was before.
  fs.rmSync(path.join(runs, current), { recursive: true, force: true });
  assert.equal(priorResetCount(swept, current), WIDEN_AT);
  assert.deepEqual(resetObligationFor(swept, current).terminalRoles, [ROLE]);
});

test('a reset whose record write FAILS still prices itself, and the route out is the same one', () => {
  let current = 'UNWRITABLE-0';
  const dir = project('unwritable', current);
  current = driveTo(dir, current, WIDEN_AT - 1);

  // The one writer made to fail for real, not stubbed: a directory where the
  // record's file belongs. `writeJson` cannot publish onto it and `readResetRecord`
  // reads it as empty, which is the same observable state as an erasure.
  fs.rmSync(path.join(dir, RECORD_REL), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, RECORD_REL), { recursive: true });

  const widening = resetOnce(dir, current);
  assert.equal(readResetRecord(dir).count, 0, 'fixture guard: nothing was recorded');
  assert.ok(widening.warnings.some((line) => line.includes('was not added to')),
    'the caller is told the record write failed');
  assert.ok(widening.warnings.some((line) => line.includes("successor's own ledger still carries")),
    'and is told the price stands anyway, so the next spawn deny is not a contradiction');

  // The price stands: the widening applies from the ledger alone.
  assert.deepEqual(resetObligationFor(dir, widening.fresh).terminalRoles, [ROLE]);
  assert.equal(modelExhaustionTerminalForRole(dir, widening.fresh, ROLE), true);
  assert.equal(ledger(dir, widening.fresh).resetSeq, WIDEN_AT);

  // …with the route out unchanged, which is what keeps it a cost and not a brick.
  assert.ok(writeModelChoice(dir, widening.fresh, 'enable-retry'));
  assert.deepEqual(resetObligationFor(dir, widening.fresh).terminalRoles, []);
  assert.equal(modelExhaustionTerminalForRole(dir, widening.fresh, ROLE), false);
});
