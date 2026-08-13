// RECOVERY_RUNNERS is the only exemption anywhere in the fail-closed boundary,
// and until this file existed its admission rule lived entirely in a comment.
// A rule stated only in prose is one the next author satisfies by BELIEVING they
// satisfy it: nothing fails, nothing asks, and the row lands. These tests make
// the table's safety checkable — membership is pinned so a row cannot appear
// without a deliberate edit here, and ALL FIVE properties the mutating row
// claims are exercised here, in the order the row states them.
//
// ── WHY THE LAST THREE SECTIONS ARE HERE AT ALL, given they duplicate nothing
// The row's five properties used to be split: 1 and 2 asserted here, 3, 4 and 5
// asserted in the reset lane's own suites and CITED from RULE_AND_PROOFS below.
// The citations resolve — every named test exists — but a reader auditing the
// exemption had to leave the file to find out, and one of them was incomplete in
// a way that mattered: property 5 is the PRICE that the row's own argument uses
// to make property 2's admitted residual acceptable, and the two cited tests
// covered the classification and the carry while nothing here asserted that the
// price is actually paid, or that it survives an actor holding a lease. It did
// not, until the widening moved out of `exhausted-models.json`. Absent structure
// has no line for a mutation campaign to kill, so the gap was invisible to one.
//
// The differential in runners/traffic-one-reset/__tests__/reset.test.ts is still
// the strongest statement of 3 and 4 (a whole-tree append-only proof, which
// catches writes nobody thought to assert); the sections below name each
// property's own claim in its own words, so the row can be audited from the row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Ctx } from '../../core/types';
import { RECOVERY_RUNNERS, isFailClosedRecoveryExemption } from '../fail-closed';
import { correlatedCursorFailureGate } from '../../modules/agent-model/cursor-failures';
import { doctorScriptPath } from '../../shared/doctor-command';
import { overrideLedgerPath, overrideRoot } from '../../shared/override';
import { resetRecoveryLine, resetScriptPath } from '../../shared/reset-command';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand } from '../../shared/tool-classify';
import { modelExhaustionTerminalForRole } from '../../modules/agent-model/exhausted-models';
import { WIDEN_AT, carryRunObligations } from '../../runners/traffic-one-reset/obligations';
import { recordReset } from '../../runners/traffic-one-reset/resets';
import { resetRun } from '../../runners/traffic-one-reset/reset';
import { DENY_REPEAT_ESCALATE_AT, recordDenyRepeat } from '../../shared/state/deny-repeat';
import {
  ensureRunLedger,
  runLedgerStatusRecord,
  statePath,
  transitionRunStatus,
} from '../../shared/state';
import { runAgentFile, runDir, runLedgerFile } from '../../shared/state/run-agent/run-paths';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Exact membership. Two rows, and both of them argued for in fail-closed.ts.
const PINNED_ROWS = ['doctor', 'reset'];

// The five properties the mutating row claims, pinned as a list rather than as
// a count: the defect this file was written against was a rule naming five
// properties while two existed, and a count is satisfied by any five things.
const PINNED_PROPERTIES = [1, 2, 3, 4, 5];

const RULE_AND_PROOFS = [
  '',
  'RECOVERY_RUNNERS membership changed. Before you update this list, the rule:',
  '',
  '  A row must not be able to buy its caller a DECISION the gates would have',
  '  withheld. This boundary is reached precisely BECAUSE the machinery that',
  '  would have judged the call is broken, so whatever a row admits is admitted',
  '  UNJUDGED. The exemption is sound only if judged and unjudged produce the',
  '  same outcome.',
  '',
  'A read-only runner (doctor) clears that trivially: there is no decision to',
  'buy. A MUTATING runner (reset) clears it only the long way, by carrying every',
  'precondition the gates would have applied INSIDE itself, evaluated from disk',
  'under the project lock. If your row mutates, it owes all five proofs:',
  '',
  '  1. precondition from DISK, not argv',
  '       hooks/__tests__/recovery-runners.test.ts',
  '         "property 1: no admitted argv can carry a verdict..."',
  '  2. the documented command that creates the terminal status it recovers',
  '     from is never itself exempt, so the two exemptions cannot compose',
  '       hooks/__tests__/recovery-runners.test.ts',
  '         "property 2: the documented command that CREATES the wedge..."',
  '  3. no terminal outcome written, no override minted',
  '       hooks/__tests__/recovery-runners.test.ts',
  '         "property 3: a reset mints no verdict..."',
  '  4. nothing destroyed',
  '       hooks/__tests__/recovery-runners.test.ts',
  '         "property 4: a reset destroys nothing..."',
  '       runners/traffic-one-reset/__tests__/reset.test.ts',
  '         "a reset is ADDITIVE except for the pointer..." (the whole-tree form)',
  '  5. it does not MOVE A POINTER that a gate uses as a key to state it is',
  '     holding, unless it carries that state forward — AND it prices the',
  '     repetition, because several bounds are legitimately dropped and each',
  '     reset refreshes them. Properties 3 and 4 are about what the row WRITES;',
  '     this one is about what it DISCARDS, and a row can satisfy all of 1-4',
  '     honestly while laundering every obligation keyed by the pointer it',
  '     moves. The price is what property 2 leans on, so it owes an assertion',
  '     that the price survives an actor who defeats the bound.',
  '       hooks/__tests__/recovery-runners.test.ts',
  '         "property 5: the bounds follow the pointer..." (the carry)',
  '         "property 5: the price is paid even when..." (under contention)',
  '       runners/traffic-one-reset/__tests__/obligations.test.ts',
  '         "every run-scoped entry is classified..." (the enumeration)',
  '         "carrying bounds forward closes the laundering path" (the behaviour)',
  '       runners/traffic-one-reset/__tests__/reset-loop.test.ts',
  '         "the loop:..." (the price end to end, through the command)',
  '',
  'No proof, no row.',
  '',
].join('\n');

test('RECOVERY_RUNNERS membership is pinned: a new row cannot arrive quietly', () => {
  assert.deepEqual(RECOVERY_RUNNERS.map((runner) => runner.id), PINNED_ROWS, RULE_AND_PROOFS);
  assert.equal(new Set(PINNED_ROWS).size, PINNED_ROWS.length,
    'ids identify rows in the proofs above, so two rows may not share one');
});

/**
 * EVERY PROOF THIS FILE CITES RESOLVES TO A TEST THAT EXISTS.
 *
 * A citation is a claim, and a claim nothing checks is the failure mode this
 * whole file was written against: `RULE_AND_PROOFS` is printed to whoever adds
 * a row as the evidence standard, so a name in it that has quietly stopped
 * matching a real test is worse than no name — it certifies a property nobody
 * verified. Renaming a test in another lane is enough to produce that, silently.
 *
 * Prefix matching, because the citations are elided with `...` to stay readable;
 * the prefix is long enough to identify one test and short enough to survive a
 * clarifying suffix.
 */
test('every proof RULE_AND_PROOFS names is a test that exists', () => {
  const lines = RULE_AND_PROOFS.split('\n');
  const cited: Array<{ property: number; file: string; name: string }> = [];
  const properties: number[] = [];
  let file = '';
  let property = 0;
  for (const line of lines) {
    const numbered = /^ {2}(\d+)\. /.exec(line);
    if (numbered) { property = Number(numbered[1]); properties.push(property); file = ''; continue; }
    const filed = /^ {7}(\S+\.test\.ts)$/.exec(line);
    if (filed) { file = filed[1] as string; continue; }
    const named = /^ {9}"(.+?)(?:\.\.\.)?"/.exec(line);
    if (named && file) cited.push({ property, file, name: named[1] as string });
  }
  assert.ok(cited.length >= 6, `fixture guard: the proofs must be parseable, found ${cited.length}`);

  // PER PROPERTY, not in total, because the total is the count that could not
  // see the original defect. The row claims five properties and the rule block
  // owes a proof for each; with a `>= 6` guard alone, deleting property 3's only
  // citation left nine behind and the test stayed green — a property asserting
  // itself, which is exactly the state this file exists to make impossible.
  assert.deepEqual(properties, PINNED_PROPERTIES,
    'the rule block must state the same five properties the reset row claims (hooks/fail-closed.ts), '
    + 'in order: a property that loses its number here loses its proof requirement with it');

  // AND THE CITATION MUST BE ABOUT THE PROPERTY IT IS CITED UNDER, which
  // "some citation carries this number and the test it names exists" is not.
  // An adversarial review re-pointed property 3's only citation at property 4's
  // test — a real test, in the right file, under the wrong property — and this
  // file stayed 11 pass, 0 fail. The count had become a list, and the list was
  // satisfiable by any name that resolves: the same failure shape as the count,
  // one level in.
  //
  // Two rules, and neither of them reads the cited test's contents, because a
  // check that greps a test body for a number is satisfied by writing the
  // number into the body. The binding is carried by the NAME instead, where it
  // is visible at the citation and at the definition at once:
  //
  //   ANCHOR       every property owns at least one test whose name DECLARES
  //                its number. Corroborating citations may be named anything —
  //                the whole-tree differential and the enumeration are cited
  //                under the properties they serve and named for what they do.
  //   NO POACHING  a test whose name declares a number may not be cited under a
  //                different one. This is the rule that reds the mutant above.
  for (const number of PINNED_PROPERTIES) {
    assert.ok(
      cited.some((proof) => proof.property === number && proof.name.startsWith(`property ${number}:`)),
      `property ${number} has no ANCHOR proof: none of its citations names a test called `
      + `"property ${number}: ...". A property whose only citation was deleted is indistinguishable from `
      + 'one that never had one, and a property whose citation names some other property\'s test is '
      + 'indistinguishable from one that proved itself. No proof, no row',
    );
  }
  for (const proof of cited) {
    const declared = /^property (\d+):/.exec(proof.name);
    assert.ok(!declared || Number(declared[1]) === proof.property,
      `property ${proof.property} cites "${proof.name}", which is property ${declared?.[1]}'s own test. `
      + 'A citation is a claim that THIS test proves THIS property; a real test under the wrong number '
      + 'certifies a property nobody verified, and reads as verified to everyone after you');
  }

  for (const proof of cited) {
    const full = path.join(REPO_ROOT, 'src', proof.file);
    assert.ok(fs.existsSync(full), `RULE_AND_PROOFS names a file that does not exist: ${proof.file}`);
    const source = fs.readFileSync(full, 'utf8');
    assert.ok(source.includes(`test('${proof.name}`) || source.includes(`test(\`${proof.name}`),
      `RULE_AND_PROOFS cites a test that ${proof.file} does not define: "${proof.name}"`);
  }
});

// ── property 1: the precondition comes from disk, never from argv ───────────
// The disk half (reset refuses unless <id> IS currentRunId and its ledger
// legibly reads terminal `failed`) is pinned by reset.test.ts's refusal tests.
// The half that belongs HERE is the other direction, and it is the one that
// makes the disk half load-bearing: argv must have nowhere to put a verdict.
// The grammar admits exactly four words, so every token below lands outside it.

test('property 1: no admitted argv can carry a verdict — the grammar has no room for one', () => {
  const script = resetScriptPath();
  const admitted = `node ${script} --run-id 1785169657252`;
  const exempt = (command: string): boolean => isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command } }),
    'check-plan-write',
    'nested',
  );

  assert.equal(exempt(admitted), true, 'baseline: the recovery command itself is admitted');

  // Every spelling by which a caller might try to TELL the runner the answer
  // instead of letting it read one. None of these can reach the runner, so the
  // runner's own disk read is the only source of the verdict there is.
  for (const suffix of [
    '--status failed',
    '--status active',
    '--outcome agent-failed',
    '--force',
    '--yes',
    '--assume-failed',
    '--no-verify',
    '--override',
    '--unblock run-ledger',
    'failed',
  ]) {
    assert.equal(exempt(`${admitted} ${suffix}`), false,
      `argv must not be able to state the verdict: ${suffix}`);
    // …and it may not lead with it either, in case a future parser reorders.
    assert.equal(exempt(`node ${script} ${suffix} --run-id 1785169657252`), false,
      `nor before the id: ${suffix}`);
  }
});

// ── property 2: the DOCUMENTED wedge-maker stays gated ──────────────────────
// WHAT THIS PROPERTY IS NOT, because it was written as something stronger and
// that stronger reading was false. It used to say `failed` is unreachable by
// anything an agent may run, and concluded that `reset` therefore cannot
// compose with a wedge-maker into "declare the run over, then reset out of it".
// MEASURED FALSE: an OpenCode delegation that fails terminally with paid
// fallback disallowed writes `overallOutcome: failed` into maintenance.json,
// and reconcileRunSettlement — which runs at EVERY prompt boundary — adopts it
// as the canonical settlement and the ledger status. The delegation is a
// shipped, agent-issued command documented in a skill. Terminal `failed` is
// reachable, and no allowlist edit can make it otherwise, because the path runs
// through a legitimate feature working as designed.
//
// So this property is now only what it can actually assert: the DOCUMENTED
// wedge-maker (`run-status --status failed`) is never itself exempt, on any
// surface. That is worth keeping — it stops the two exemptions composing
// DIRECTLY — but it no longer carries the weight it was silently carrying, and
// the composition it used to rule out is instead defused at the other end, by
// property 5 below: reaching `failed` and resetting buys nothing, because the
// bounds come with you.
//
// The command is READ OUT OF THE SHIPPED SKILL rather than typed here, so this
// tracks the product's own spelling of the wedge-maker instead of a copy that
// can quietly stop resembling it.

const SKILL = path.join(
  REPO_ROOT, 'src', 'modules', 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md',
);

function documentedFailCommands(): string[] {
  const text = fs.readFileSync(SKILL, 'utf8');
  const found = text.match(/^node \S*run-status\.cjs .*--status (?:failed|completed|blocked).*$/gm) ?? [];
  return found.map((line) => line.replace(/^node ~/, `node ${os.homedir()}`));
}

test('property 2: the documented command that CREATES the wedge is never exempt, on any surface', () => {
  const commands = documentedFailCommands();
  assert.ok(commands.length >= 3,
    `fixture guard: the wedge-making commands must still be readable out of ${SKILL}`);
  assert.ok(commands.some((command) => command.includes('--status failed')),
    'fixture guard: including the `--status failed` one this property is about');

  for (const command of commands) {
    // Not a recovery row, on any wire shape a host can present.
    for (const [subcommand, surface, payload] of [
      ['check-plan-write', 'nested', { cwd: '/tmp', tool_name: 'Bash', tool_input: { command } }],
      ['before-shell-execution', 'cursor', { cwd: '/tmp', command }],
      ['before-tool-use', 'copilot', { cwd: '/tmp', tool_calls: [{ name: 'bash', args: { command } }] }],
      ['before-tool-use', 'wrapper', { cwd: '/tmp', tool: { name: 'Bash', args: { command } } }],
      ['pre_run_command', 'windsurf', { workspace_root: '/tmp', tool_info: { command_line: command } }],
    ] as const) {
      assert.equal(
        isFailClosedRecoveryExemption(JSON.stringify(payload), subcommand, surface as never),
        false,
        `run-status must stay gated on the ${surface} surface: ${command}`,
      );
    }
    // And not hoisted past the onboarding gate either: doctor and reset are the
    // only two commands lifted above it (onboarding-gate/handler.ts), and this
    // is what keeps that list from silently growing a third.
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false, command);
    assert.equal(isTrafficOneResetCommand('Bash', { command }), false, command);
  }
});

test('a batch does not launder the wedge-maker in beside a genuine recovery command', () => {
  const wedgeMaker = documentedFailCommands()
    .find((command) => command.includes('--status failed')) as string;
  const reset = `node ${resetScriptPath()} --run-id 1785169657252`;
  const doctor = `node ${doctorScriptPath()}`;
  const exempt = (...commands: string[]): boolean => isFailClosedRecoveryExemption(
    JSON.stringify({
      cwd: '/tmp',
      tool_calls: commands.map((command) => ({ name: 'bash', args: { command } })),
    }),
    'before-tool-use',
    'copilot',
  );

  assert.equal(exempt(reset), true, 'baseline: reset alone is exempt');
  assert.equal(exempt(reset, doctor), true, 'baseline: a batch of nothing but recovery rows is exempt');
  assert.equal(exempt(wedgeMaker, reset), false, 'wedge first, reset second');
  assert.equal(exempt(reset, wedgeMaker), false, 'reset first, wedge second — the ordering bug the batch rule fixed');
  assert.equal(exempt(doctor, wedgeMaker, reset), false, 'and it cannot hide in the middle');
});

// ── the wedge, for the three disk properties ────────────────────────────────
// The same shape runners/traffic-one-reset/__tests__/reset.test.ts uses, built
// through the product's own transitions rather than by writing a `failed`
// ledger: the point of the fixture is that the run really is one no in-product
// action can leave.

const ROLE = 'senior-frontend';
const OLD = 'OLD-run';
const CHILD = 'child-of-old';
const MODEL = 'gpt-5.6-terra-medium';
const fixtures: string[] = [];

/** A Cursor pre-spawn hook context — the surface `correlatedCursorFailureGate`
 *  is reached on (agent-model/gate-reuse.ts, inside agentModelGate). */
function cursorSpawn(cwd: string): Ctx {
  return {
    input: { event: 'PreToolUse', host: 'cursor', cwd, workspaceRoot: cwd, raw: {} },
    host: 'cursor',
    cwd,
    now: () => 'x',
  } as unknown as Ctx;
}

test.after(() => {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_HOST;
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function wedged(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-recovery-${label}-`)));
  fixtures.push(dir);
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_HOST = 'claude';
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
    currentRunId: OLD,
  }), 'utf8');
  const digests = path.join(dir, '.traffic-one', 'digests', OLD);
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, 'architect.md'), '# plan\nwork this run really did\n', 'utf8');
  const claim = runAgentFile(dir, OLD, CHILD);
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({
    version: 1,
    runId: OLD,
    claimId: 'senior-frontend-3-oldchild',
    role: ROLE,
    spawnIndex: 3,
    status: 'claimed',
    sessionId: CHILD,
    createdAt: new Date().toISOString(),
  }), 'utf8');
  assert.ok(ensureRunLedger(dir, OLD, { status: 'planned', kind: 'agent-claim' }));
  assert.ok(transitionRunStatus(dir, OLD, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, OLD, { status: 'failed', outcome: 'agent-failed' }));
  return dir;
}

/** Every file under `root`, with its bytes; empty when `root` does not exist. */
function filesUnder(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** Every path under the project's `.traffic-one`, with its bytes. */
function tree(dir: string): Map<string, string> {
  return filesUnder(path.join(dir, '.traffic-one'));
}

/**
 * Every path under the MACHINE override root — a different tree from `tree()`
 * above, and the distinction is the point: overrides live outside every project
 * on purpose, so a project-tree walk can never see one. The suite's preload pins
 * XDG_STATE_HOME per test file, so this resolves inside that file's own scratch.
 */
function overrideTree(): Map<string, string> {
  return filesUnder(overrideRoot());
}

// ── property 3: it cannot fabricate progress ────────────────────────────────
// The row's claim in its own words: no terminal outcome written, no override
// minted, the failed run's ledger untouched, the successor merely `planned` —
// which is where a run starts anyway. That last clause is the whole property:
// an exemption is sound when reaching it unjudged yields what reaching it
// judged would, and a run that starts `planned` has been given nothing.

test('property 3: a reset mints no verdict — the successor is `planned` and no override appears', () => {
  const dir = wedged('no-verdict');
  const retiredLedger = fs.readFileSync(runLedgerFile(dir, OLD), 'utf8');
  const before = tree(dir);

  // FIXTURE GUARD, and it is the whole reason this half of the property is
  // worth anything now: prove the watcher can SEE an override before trusting
  // it not to find one. A sentinel written to the exact path the product's own
  // resolver names for this project must show up in the watched tree, and must
  // leave when it does. Without this the assertion below is one relocated
  // helper away from being decorative again, silently.
  const ledger = overrideLedgerPath(dir);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, `${JSON.stringify({ sentinel: true })}\n`, 'utf8');
  assert.ok(overrideTree().has(path.relative(overrideRoot(), ledger)),
    'fixture guard: the override watcher must be looking where the product actually mints');
  fs.rmSync(ledger, { force: true });
  const overridesBefore = overrideTree();
  assert.equal(overridesBefore.has(path.relative(overrideRoot(), ledger)), false,
    'fixture guard: and the sentinel is gone again, so the differential starts clean');

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true, result.message);
  const fresh = result.freshRunId as string;

  const successor = runLedgerStatusRecord(dir, fresh);
  assert.equal(successor.legibility, 'ok');
  assert.equal(successor.status, 'planned',
    'the successor starts where every run starts; a reset that could hand back anything else would be '
    + 'buying a decision the gates never made');
  const successorLedger = JSON.parse(fs.readFileSync(runLedgerFile(dir, fresh), 'utf8')) as Record<string, unknown>;
  assert.equal(successorLedger.outcome, undefined, 'and carries no outcome at all, terminal or otherwise');

  assert.equal(fs.readFileSync(runLedgerFile(dir, OLD), 'utf8'), retiredLedger,
    "the retired run's terminal ledger is byte-identical: this runner retires, it never settles");

  const minted = [...tree(dir).keys()].filter((file) => !before.has(file));
  assert.deepEqual(minted.filter((file) => /override/i.test(file)), [],
    'nothing override-shaped lands in the project either');

  // No override, ASSERTED WHERE OVERRIDES ACTUALLY LIVE. This sentence had a
  // line for four rounds and no way to fail: it filtered the project tree, and
  // `overrideRoot()` is `globalTrafficOneDir(env)/overrides` — the MACHINE dir,
  // deliberately outside any project (shared/override/paths.ts: a token an agent
  // with project write access could forge is not a token). A reset that minted a
  // real override token through the product's own resolver left the old
  // assertion at 11 pass / 0 fail.
  const after = overrideTree();
  assert.deepEqual([...after.keys()].filter((file) => !overridesBefore.has(file)), [],
    'an agent that could mint its own override would have a bypass, not an escape hatch');
});

// ── property 4: it destroys nothing ─────────────────────────────────────────
// The evidence of the retired run is what an operator and a reviewer need after
// a recovery, and it is also the reason this row can be exempt: a command that
// deletes cannot be audited after the fact.

test('property 4: a reset destroys nothing — the retired run keeps its dir, ledger and digests', () => {
  const dir = wedged('destroys-nothing');
  const before = tree(dir);

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true, result.message);

  const after = tree(dir);
  const gone = [...before.keys()].filter((file) => !after.has(file));
  assert.deepEqual(gone, [], 'nothing a reset finds may be deleted');

  assert.ok(fs.existsSync(runDir(dir, OLD)), "the retired run's directory survives");
  assert.equal(after.get(path.join('digests', OLD, 'architect.md')), before.get(path.join('digests', OLD, 'architect.md')),
    'including the digests, which are the record of the work the retired run actually did');

  // The claim file is the ONE pre-existing file a reset rewrites, and it is
  // rewritten in place rather than removed: `releaseRunClaimsResult` marks it
  // released. "Destroys nothing" has to survive that, so it is asserted rather
  // than excluded.
  const claim = JSON.parse(fs.readFileSync(runAgentFile(dir, OLD, CHILD), 'utf8')) as Record<string, unknown>;
  assert.equal(claim.status, 'released');
  assert.equal(claim.claimId, 'senior-frontend-3-oldchild',
    'the released claim keeps its identity: the sweep marks, it does not erase');
});

// ── property 5: it does not launder what the pointer keys ───────────────────
// Two halves, and until this round only the first had an assertion anywhere.
//
//   THE CARRY. Every bound keyed by the run id follows the pointer, so reaching
//   `failed` and resetting does not refund it. Asserted here through the
//   ladder's own reader, which is the bound that made this property necessary.
//
//   THE PRICE. Carrying makes ONE reset conserving; several bounds are
//   legitimately dropped, so repeated resets stayed a way to buy budget until
//   the widening at WIDEN_AT. This is the half the row's argument LEANS ON —
//   property 2 admits that terminal `failed` is reachable by an agent, and
//   answers the composition with property 5's price — and it was the half with
//   no assertion, in a shape no mutation campaign could have found: there was no
//   line to mutate, only a missing one.
//
//   The price is asserted UNDER CONTENTION, because the version that existed
//   when this section was written was defeatable by the same capability that
//   defeats the bound: the widening was an extra carry into
//   `exhausted-models.json`, so one held lease dropped the bound AND suppressed
//   the price (measured over six cycles: `widened: []` every cycle). It is now
//   recorded in `.resets.json` — one writer, no lease — and this test holds the
//   lease to prove the difference.

test('property 5: the bounds follow the pointer, so a reset refunds nothing', () => {
  const dir = wedged('no-laundering');
  const signature = 'materialization-not-converged|src/app.ts';
  for (let draw = 0; draw < DENY_REPEAT_ESCALATE_AT + 2; draw += 1) recordDenyRepeat(dir, OLD, signature);

  const result = resetRun(dir, OLD);
  assert.equal(result.ok, true, result.message);
  const fresh = result.freshRunId as string;

  assert.equal(recordDenyRepeat(dir, fresh, signature), DENY_REPEAT_ESCALATE_AT + 3,
    'the escalated ladder is keyed by run id, and the next draw in the SUCCESSOR continues it — '
    + 'without the carry this reads 1, which is the laundering this property exists to close');
});

test('property 5: the price is paid even when the actor holds the lease that drops the bound', () => {
  const dir = wedged('price-under-contention');
  const successorRun = 'NEW-run';

  // The retired run burned a role's whole rotation, through the writer the
  // product uses, and the successor's exhaustion store is then held by a LIVE
  // holder — this process, whose pid the store's own reclaim rule refuses to
  // treat as dead, with a stamp too fresh to be aged out.
  fs.mkdirSync(runDir(dir, OLD), { recursive: true });
  fs.writeFileSync(path.join(runDir(dir, OLD), 'exhausted-models.json'), JSON.stringify({
    version: 2,
    roles: { [ROLE]: { entries: [{ model: 'gpt-5.6-terra-medium', at: new Date().toISOString() }], terminal: {} } },
  }), 'utf8');
  fs.mkdirSync(runDir(dir, successorRun), { recursive: true });
  const lockPath = path.join(runDir(dir, successorRun), 'exhausted-models.json.lock');
  fs.writeFileSync(lockPath, `${process.pid} ${Date.now()} hostile\n`, 'utf8');

  const outcome = carryRunObligations(dir, OLD, successorRun, { priorResets: WIDEN_AT - 1 });

  assert.ok(outcome.failed.includes('exhausted-models.json'),
    'fixture guard: the actor really does defeat the carry — the bound is genuinely dropped, which is '
    + 'the capability this test grants it');
  assert.deepEqual(outcome.obligation.terminalRoles, [ROLE],
    'and the price is computed anyway: nothing on its path takes a lease');

  assert.ok(recordReset(dir, {
    at: new Date().toISOString(), from: OLD, to: successorRun, status: 'failed', carried: outcome.carried,
  }, outcome.obligation));
  assert.equal(modelExhaustionTerminalForRole(dir, successorRun, ROLE), true,
    'the record answers terminal for the successor: holding the lease buys the bound, never the discount');

  // AND A GATE ACTUALLY REFUSES ON IT, which is the assertion this property was
  // missing and the reason the line above is not enough on its own. A reviewer
  // who traces the reader finds two call sites that merely skip a redundant
  // store write, concludes the widening prices nothing, and is wrong: the third
  // is correlatedCursorFailureGate, which is on the Cursor spawn path
  // (agent-model/gate-reuse.ts) and denies `cursor-api-limit-terminal` before it
  // looks at anything else. A price no consumer enforces is a claim, so the
  // property is asserted at the OUTCOME an agent would actually receive.
  const spawn = correlatedCursorFailureGate(cursorSpawn(dir), dir, successorRun, ROLE, MODEL);
  assert.equal(spawn?.kind, 'deny',
    'the successor must refuse the spawn the widened role is no longer entitled to — this is the price, '
    + 'and without it property 2 is leaning on a record nothing reads');
  assert.equal(spawn?.denyId, 'cursor-api-limit-terminal');

  // Attributable to the obligation and to nothing else: same fixture, same
  // gate, a role the reset never widened.
  //
  // THIS CONTROL IS WEAK ON ITS OWN and the attribution does not rest on it.
  // `senior-backend` returns null at `if (!parentSessionId) return null`, not for
  // anything role-specific downstream, so it would return null for the WIDENED
  // role too if the terminal check were hard-wired false. What carries the
  // attribution is the mutation: dropping the obligation half of
  // `modelExhaustionTerminalForRole` turns the deny above into null at this same
  // gate. The control's job is narrower than it looks — it rules out a
  // project-wide freeze — and that is all it should be read as.
  //
  // AND THE CLAIM IS NARROWED TO WHAT THE FIXTURE ESTABLISHES. Driven through
  // `agentModelGate` on an ordinary Cursor spawn, the deny fires end to end, and
  // the same mutation moves the refusal to `agent-materialization-missing` — a
  // downstream gate, on an unrelated ground. So what is established is that the
  // price REACHES the product entrypoint and is attributable to the obligation.
  // What is NOT established here is that it is the ONLY thing standing between
  // the agent and a spawn: this fixture's successor is never materialized, so a
  // downstream gate refuses either way, and a fully-materialized successor would
  // be needed to say the stronger thing. Property 2 leans on the price existing
  // and being unsuppressable, not on it being the last line.
  assert.equal(correlatedCursorFailureGate(cursorSpawn(dir), dir, successorRun, 'senior-backend', MODEL), null,
    'and only for the role that was widened: the price is per role, not a project-wide freeze');

  fs.unlinkSync(lockPath);
});

// ── the row is reachable for a command the product HANDS OUT ────────────────
// A membership rule about a command nobody is ever given is an exemption with
// no beneficiary. Until `resetRecoveryLine()` had a caller, `resetCommand()` and
// `resetShimCommand()` had ZERO non-test callers in `src/`, and no shipped
// SKILL.md or rule printed a reset command anywhere: the table kept a mutating
// row reachable, with a grammar, an identity check and this whole suite behind
// it, for a recovery no agent and no operator was told existed.
//
// The property the two tests below make LIVE rather than anchored is "we never
// print a command we block". Anchored, it was `isTrafficOneResetCommand` applied
// to a string this suite typed. Live, it is applied to the bytes the product
// actually emits, through the printer the deny site actually calls.

test('the recovery command the product PRINTS is one the fail-closed row admits', () => {
  const line = resetRecoveryLine('1785169657252');
  const printed = /`(node .+?)`/.exec(line)?.[1];
  assert.ok(printed, `the deny must hand over a runnable command; got: ${line}`);

  assert.equal(isTrafficOneResetCommand('Bash', { command: printed }), true,
    'the grammar must admit the exact bytes the product prints — this is the whole point of deriving '
    + 'the printed spelling and the admitted spelling from one list');
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: printed } }),
    'check-plan-write',
    'nested',
  ), true, 'and the fail-closed boundary must admit it too, which is the surface a wedged agent hits');

  // The other direction, and it is what makes the property a property of the
  // PRINTER instead of a property of the ids this test happened to choose: an
  // id the grammar would refuse produces no command at all.
  for (const hostile of ['', '   ', '--status', 'a b', 'id;rm -rf /', '$(whoami)', 'run\nid']) {
    assert.equal(resetRecoveryLine(hostile), '',
      `an id the grammar refuses must print nothing rather than an unrunnable command: ${JSON.stringify(hostile)}`);
  }
});

/**
 * THE CALLER IS REAL, and this is a source scan for a reason worth stating: the
 * deny it lives in needs a Codex child, a frozen run policy, a matching
 * bootstrap and a claim mint that fails — a fixture whose every part is
 * unrelated to the one line under test, and whose cost is how the line went
 * unwritten for six rounds. What is checkable cheaply is exactly what was
 * missing: that a non-test caller EXISTS, and that it is conditioned on the one
 * status the runner accepts. Printing this command at a `completed` run would
 * hand over a command the runner refuses with `run-not-failed` — prose that gets
 * refused is worse than no prose.
 */
test('the printer has a real, non-test caller and it fires only on the status the runner accepts', () => {
  const roots = ['modules', 'runners', 'hooks', 'shared', 'core'];
  const callers: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && full !== path.join(REPO_ROOT, 'src', 'shared', 'reset-command.ts')) {
        if (/\bresetRecoveryLine\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(full);
      }
    }
  };
  for (const root of roots) walk(path.join(REPO_ROOT, 'src', root));

  assert.ok(callers.length >= 1,
    'the recovery must be printed by something an agent can actually reach. A printer with no caller is '
    + 'an incomplete feature, not a held property — see reset-command.ts');

  for (const caller of callers) {
    const source = fs.readFileSync(caller, 'utf8');
    const call = /^.*\bresetRecoveryLine\(.*$/m.exec(source)?.[0] ?? '';
    assert.match(call, /'failed'/,
      `${path.relative(REPO_ROOT, caller)} must condition the printed recovery on a terminally 'failed' run: `
      + 'the runner refuses every other status with `run-not-failed`');

    // AND THE MESSAGE AROUND IT MUST NOT DISOWN IT. The one caller's deny said
    // "`completed` and `failed` runs cannot be reopened at all, and the command
    // below is refused for them" — true while the only command below was the
    // resume, false from the moment a recovery was appended on precisely those
    // statuses. Every single time the product handed the command over, the same
    // message told the agent it would be refused. Unqualified in a file that
    // PRINTS a recovery, that sentence is always a contradiction; qualified
    // ("the RESUME command below"), it is the true thing it was trying to say.
    // Commentary is stripped first: the property is about what the file PRINTS,
    // and the docblock recording this very defect necessarily quotes the
    // sentence it removed.
    //
    // WHICH STRIPPER DOES THE WORK, corrected — this was recorded wrongly and
    // the wrong half was the one described as clever. Measured on the one caller
    // (`agent-model/codex-child-model.ts`): it contains ZERO block comments
    // (`lastIndexOf('*/')` is -1), so all 9,882 removed bytes come from the `//`
    // line filter, and the docblock this assertion has to see past is a `//`
    // block. The block-comment strip removed nothing at all, so its behaviour
    // was never exercised by the case it was written for.
    //
    // It is kept, because a future caller may well use `/* */`, and ANCHORED TO
    // A LINE START, because unanchored it is a fail-OPEN blindness rather than
    // an unused branch: `/\/\*[\s\S]*?\*\//` is string-unaware, so any printed
    // string containing `/*` (a glob like `digests/*`) opens a comment that runs
    // to the next `*/` anywhere in the file and swallows whatever printed text
    // lies between — including a genuine occurrence of the sentence below. A
    // docblock starts its line; a glob inside a string does not. The residual is
    // named rather than closed: a printed TEMPLATE literal with a line whose
    // first characters are `/*` would still be read as a comment opener.
    const printed = source
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    assert.doesNotMatch(printed, /(?<!RESUME )command below is refused/,
      `${path.relative(REPO_ROOT, caller)} prints a recovery command and also says a command below it is `
      + 'refused. Say WHICH one: prose that hands over a command and disowns it in the same breath is worse '
      + 'than prose that hands over nothing');
  }
});
