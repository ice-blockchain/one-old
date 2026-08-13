// The state-loss notice, priced row by row against every way a project can
// present with no `.traffic-one/.one.json`.
//
// The table is the deliverable, not the notice: removing the state directory is
// a supported user action, so the only thing that makes an advisory about it
// safe is knowing exactly which projects it stays silent on. Six rows must fire
// and five must not, and the five are the expensive half — a notice that tells a
// fresh checkout it lost state it never had is worse than the silence it
// replaces.
//
// Fixtures are driven through the real writers (`recordPluginUseChoice`,
// `mergeProjectPrefs`, `writeState`, `resetRun`, `sweepTrafficOneRetention`) in
// mkdtemp project roots: every path inside this checkout is a plugin authoring
// root, where `writeState` refuses and the product stands down, so an in-repo
// fixture measures the stand-down rather than the notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pointerLoss, stateLossEvidence, stateLossNotice } from '../state-loss';
import { statePath, writeState } from '../normalize';
import { recordPluginUseChoice } from '../plugin-use';
import { mergeProjectPrefs } from '../local-prefs';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { resetAuthoringRootCache } from '../../authoring-root';
import { sweepTrafficOneRetention } from '../../retention';
import { ensureRunLedger, transitionRunStatus } from '../run-agent/ledger';
import { runLedgerStatusRecord } from '../run-agent/terminal-verdict';
import { resetRun } from '../../../runners/traffic-one-reset/reset';
import { priorResetCount, readResetRecord, resetObligationFor } from '../../../runners/traffic-one-reset/resets';
import {
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';

const ROLE = 'senior-frontend';
const MODEL = 'gpt-5.6-terra-medium';
const created: string[] = [];

function fixture(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-stateloss-${label}-`)));
  created.push(dir);
  resetAuthoringRootCache();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  return dir;
}

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', message], { stdio: 'ignore' });
}

/** The answers a completed setup step leaves in the out-of-tree bucket. */
function answerSetupQuestions(dir: string): void {
  recordPluginUseChoice(dir, true, 'state-loss-test');
  mergeProjectPrefs(dir, hostScopedPerformancePrefs(
    { level: 'high', source: 'prompted' },
    { mode: 'subagents', source: 'prompted', approved: true },
    'pro',
  ) as Record<string, unknown>);
  mergeProjectPrefs(dir, { openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' } });
}

function onboardedState(runId = 'SL-0'): Record<string, unknown> {
  return {
    mode: 'existing-codebase', stack: 'minimal', frontend: 'none', backend: 'other', realtime: 'none',
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    currentRunId: runId,
  };
}

/** A project set up here, with real run state and a real reset ladder. */
function onboarded(label: string, opts: {
  git?: boolean;
  gitignoreState?: boolean;
  gitignoreRunState?: boolean;
  resets?: number;
} = {}): { dir: string; live: string } {
  const dir = fixture(label);
  if (opts.git !== false) git(dir, ['init', '-q']);
  if (opts.gitignoreState) fs.writeFileSync(path.join(dir, '.gitignore'), '.traffic-one/\n', 'utf8');
  if (opts.gitignoreRunState) gitignoredRunState(dir);
  answerSetupQuestions(dir);
  assert.equal(writeState(dir, onboardedState()), true, 'fixture guard: the real writer accepted the state file');
  let live = 'SL-0';
  for (let cycle = 0; cycle < (opts.resets ?? 0); cycle += 1) {
    const from = live;
    recordExhaustedModel(dir, from, ROLE, MODEL);
    markModelExhaustionTerminal(dir, from, ROLE);
    ensureRunLedger(dir, from, { status: 'planned', kind: 'agent-claim' });
    transitionRunStatus(dir, from, { status: 'active' });
    transitionRunStatus(dir, from, { status: 'failed', outcome: 'agent-failed' });
    const result = resetRun(dir, from);
    assert.equal(result.ok, true, `fixture guard: reset ${cycle} was accepted`);
    live = String(result.freshRunId);
  }
  if (opts.git !== false) commitAll(dir, 'project with traffic-one state');
  return { dir, live };
}

function wipe(dir: string): void {
  fs.rmSync(path.join(dir, '.traffic-one'), { recursive: true, force: true });
}

// ─── the six rows that MUST fire ────────────────────────────────────────────

test('row 2 — an agent wipes an onboarded, committed project: both anchors answer', () => {
  const { dir } = onboarded('row2');
  wipe(dir);
  const notice = stateLossNotice(dir);
  assert.ok(notice, 'the wipe is disclosed');
  const evidence = stateLossEvidence(dir);
  assert.ok(evidence.prefs, 'the out-of-tree preferences bucket answers');
  assert.ok(evidence.committed, 'git answers');
  assert.match(notice!, /STATE WAS RESET/);
  assert.match(notice!, /is missing/, 'the absent spelling is named as absent');
});

test('row 3 — a user wipes the same project: identical evidence, identical notice', () => {
  const a = onboarded('row3a');
  const b = onboarded('row3b');
  wipe(a.dir);
  wipe(b.dir);
  const agent = stateLossNotice(a.dir);
  const user = stateLossNotice(b.dir);
  assert.ok(agent && user, 'both fire');
  // The point of the row: nothing in the evidence distinguishes them, which is
  // why this is a disclosure and not a refusal. Compare with the project paths
  // and run ids (which differ by construction) removed.
  const shape = (text: string, dir: string): string => text
    .split(dir).join('<dir>')
    .replace(/run `[^`]+`/g, 'run `<id>`')
    .replace(/[a-f0-9]{64}/g, '<project-hash>');
  assert.equal(shape(agent!, a.dir), shape(user!, b.dir), 'one wording for two intents — the notice cannot tell them apart, and says nothing that implies it can');
});

test('row 6 — a clone at a new path has no bucket, and git alone carries it', () => {
  const source = onboarded('row6src');
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-stateloss-row6clone-')));
  created.push(clone);
  fs.rmSync(clone, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', source.dir, clone], { stdio: 'ignore' });
  const cloned = fs.realpathSync(clone);
  assert.equal(stateLossNotice(cloned), null, 'fixture guard: the clone RESTORES the committed pointer, so nothing is lost yet');
  wipe(cloned);
  const evidence = stateLossEvidence(cloned);
  assert.equal(evidence.prefs, null, 'the bucket is keyed by path — a clone elsewhere has none');
  assert.ok(evidence.committed, 'git is the only surviving anchor here');
  assert.ok(stateLossNotice(cloned), 'and it is enough');
});

test('row 7 — a gitignored state directory leaves only the bucket, and that is enough', () => {
  const { dir } = onboarded('row7', { gitignoreState: true });
  wipe(dir);
  const evidence = stateLossEvidence(dir);
  assert.ok(evidence.prefs, 'the bucket answers');
  assert.equal(evidence.committed, null, 'git never tracked the pointer');
  assert.ok(stateLossNotice(dir), 'the notice still fires');
});

test('row 8 — no git repository at all: the bucket carries it', () => {
  const { dir } = onboarded('row8', { git: false });
  wipe(dir);
  const evidence = stateLossEvidence(dir);
  assert.ok(evidence.prefs);
  assert.equal(evidence.committed, null, 'no repository to ask');
  assert.ok(stateLossNotice(dir));
});

test('the permitted narrow spellings against the pointer are disclosed too, not only the tree wipe', () => {
  // Measured as PERMITTED by every gate in every project state: removing the
  // pointer, truncating it, and overwriting it with an empty object.
  const removed = onboarded('spell-rm');
  fs.rmSync(statePath(removed.dir));
  assert.equal(pointerLoss(removed.dir), 'absent');
  assert.ok(stateLossNotice(removed.dir));

  const truncated = onboarded('spell-trunc');
  fs.writeFileSync(statePath(truncated.dir), '', 'utf8');
  assert.equal(pointerLoss(truncated.dir), 'blank');
  assert.match(stateLossNotice(truncated.dir)!, /holds nothing/, 'a truncated pointer is not described as missing');

  const emptied = onboarded('spell-empty');
  fs.writeFileSync(statePath(emptied.dir), '{}', 'utf8');
  assert.equal(pointerLoss(emptied.dir), 'blank');
  assert.ok(stateLossNotice(emptied.dir));
});

test('row 10 — a checkout whose working tree lacks the committed directory fires, and that is accepted', () => {
  // HEAD has the pointer, the working tree does not: byte-identical evidence to
  // row 2, so this fires. It is the notice's one known unasked-for case, and it
  // is correct as far as it goes — state IS missing — which is exactly why this
  // is a disclosure rather than a refusal. A refusal here would stop work in a
  // partial checkout.
  const { dir } = onboarded('row10');
  fs.rmSync(path.join(dir, '.traffic-one'), { recursive: true, force: true });
  const notice = stateLossNotice(dir);
  assert.ok(notice, 'the notice fires');
  assert.match(notice!, /THE USER, in their own terminal[\s\S]*git restore \.traffic-one/, 'and the remedy it offers is the right one for this row');
});

// ─── the five rows that MUST stay silent ─────────────────────────────────────

test('row 1 — an intact onboarded project says nothing', () => {
  const { dir } = onboarded('row1');
  assert.equal(pointerLoss(dir), null, 'the pointer is usable');
  assert.equal(stateLossNotice(dir), null);
});

test('row 4 — a project that never onboarded says nothing', () => {
  const dir = fixture('row4');
  git(dir, ['init', '-q']);
  commitAll(dir, 'fresh');
  assert.equal(pointerLoss(dir), 'absent', 'there is no pointer — but nothing says there ever was one');
  assert.equal(stateLossEvidence(dir).prefs, null);
  assert.equal(stateLossEvidence(dir).committed, null);
  assert.equal(stateLossNotice(dir), null);
});

test('row 5 — a fresh clone gets the committed pointer back, so nothing is missing', () => {
  const source = onboarded('row5src');
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-stateloss-row5clone-')));
  created.push(clone);
  fs.rmSync(clone, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', source.dir, clone], { stdio: 'ignore' });
  assert.equal(stateLossNotice(fs.realpathSync(clone)), null);
});

test('row 9 — the product\'s own retention sweep is silent: it never touches the pointer', () => {
  const { dir } = onboarded('row9', { resets: 1 });
  const before = fs.readFileSync(statePath(dir), 'utf8');
  sweepTrafficOneRetention(dir, { dryRun: false });
  assert.equal(fs.readFileSync(statePath(dir), 'utf8'), before, 'fixture guard: the sweep left the pointer byte-identical');
  assert.equal(stateLossNotice(dir), null);
});

test('row 11 — a project that has answered ONLY the use-plugin question is not a project that lost state', () => {
  // The trap this row exists for: consent is recorded BEFORE any setup step
  // runs, so keying the notice on `pluginUse` would greet every brand-new
  // project with a report of a loss it never had.
  const dir = fixture('row11');
  git(dir, ['init', '-q']);
  commitAll(dir, 'fresh');
  recordPluginUseChoice(dir, true, 'state-loss-test');
  assert.equal(pointerLoss(dir), 'absent');
  assert.equal(stateLossEvidence(dir).prefs, null, 'consent alone is not evidence of setup');
  assert.equal(stateLossNotice(dir), null);
});

test('a DEGRADED pointer is not reported as a wipe — that is the session header\'s job', () => {
  const { dir } = onboarded('degraded');
  fs.writeFileSync(statePath(dir), '{ "mode": "existing-codeba', 'utf8');
  assert.equal(pointerLoss(dir), null, 'unparseable non-empty bytes are a torn write, not a removal');
  assert.equal(stateLossNotice(dir), null);
});

// ─── requirement 4: the recovery the notice prints has to work ───────────────

// The generated `.gitignore` excludes `.traffic-one/runs/`, so an onboarded
// project's bounds are normally untracked and a restore cannot bring them back.
// This is the fixture for that, the ordinary case.
function gitignoredRunState(dir: string): void {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.traffic-one/runs/\n', 'utf8');
}

test('recovery, ordinary project: git restores the pointer and the bounds do NOT come back', () => {
  const { dir, live } = onboarded('recovery', { resets: 3, gitignoreRunState: true });
  // Ground truth before the wipe, through the product's own readers.
  assert.equal(readResetRecord(dir).count, 3);
  assert.equal(priorResetCount(dir, live), 3);
  assert.deepEqual(resetObligationFor(dir, live).terminalRoles, [ROLE]);
  assert.equal(modelExhaustionTerminalForRole(dir, live, ROLE), true);
  assert.equal(runLedgerStatusRecord(dir, live).legibility, 'ok', 'fixture guard: the live run has a legible ledger');

  // What the notice says to run. `git restore` is the modern spelling; the
  // notice offers `git checkout --` for older git and this is the same operation.
  wipe(dir);
  const notice = stateLossNotice(dir);
  assert.ok(notice);
  // The command is addressed to the human, who is not gated. An agent running it
  // is refused in every state — measured, and pinned by the actor-split tests
  // below.
  assert.match(notice!, /THE USER, in their own terminal, is not gated by any of this: `git restore \.traffic-one`/);
  git(dir, ['restore', '.traffic-one']);

  // Half one: the pointer is back, and the project is usable rather than wedged.
  assert.equal(pointerLoss(dir), null, 'the committed pointer is restored');
  assert.equal(stateLossNotice(dir), null, 'and the notice stops firing, so the remedy is observably complete');
  const restored = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
  assert.equal(restored.onboardingComplete, true, 'setup does not have to be redone');

  // Half two, which is the half the notice must not overstate: the run
  // directories were untracked, so every bound is still gone. This is measured
  // rather than asserted from the .gitignore text.
  assert.equal(readResetRecord(dir).count, 0, 'the reset ladder does not come back');
  assert.equal(priorResetCount(dir, live), 0);
  assert.deepEqual(resetObligationFor(dir, live).terminalRoles, [], 'nor the obligation');
  assert.equal(modelExhaustionTerminalForRole(dir, live, ROLE), false, 'nor the terminal exhaustion');
  assert.equal(runLedgerStatusRecord(dir, live).legibility, 'absent', 'nor the ledger');
  assert.match(notice!, /Not the bounds above/, 'and the notice said so before the user ran it');
});

test('recovery, project that committed its run state anyway: the notice says so, and the bounds DO come back', () => {
  // git never untracks what is already committed, so a project committed before
  // the generated `.gitignore` block landed really does recover its bounds. The
  // notice must not tell that user they are unrecoverable.
  const { dir, live } = onboarded('recovery-tracked', { resets: 3 });
  assert.equal(readResetRecord(dir).count, 3, 'fixture guard');
  wipe(dir);
  const notice = stateLossNotice(dir)!;
  assert.match(notice, /HEAD carries `\.traffic-one\/runs\/` as well, which is unusual/, 'the notice reports the unusual case');
  assert.ok(!/Not the bounds above/.test(notice), 'and does not claim the ordinary case');
  git(dir, ['restore', '.traffic-one']);
  assert.equal(readResetRecord(dir).count, 3, 'the ladder is genuinely restored');
  assert.equal(priorResetCount(dir, live), 3);
  assert.deepEqual(resetObligationFor(dir, live).terminalRoles, [ROLE]);
  assert.equal(modelExhaustionTerminalForRole(dir, live, ROLE), true);
  assert.equal(stateLossNotice(dir), null, 'and the notice stops firing');
});

test('with no committed pointer the notice offers no restore it cannot deliver', () => {
  const { dir } = onboarded('no-restore', { git: false });
  wipe(dir);
  const notice = stateLossNotice(dir)!;
  assert.match(notice, /git has no committed `\.traffic-one\/\.one\.json` at HEAD/, 'it says why there is nothing to restore');
  assert.ok(!/git restore \.traffic-one`/.test(notice), 'and never prints a command that would do nothing');
  assert.match(notice, /relay the setup link when it appears/);
});

// ─── the actor split, which is the whole point of the recovery clause ────────
// Measured through the real PreToolUse pipeline, as a verdict matrix: with the
// pointer absent or blank, every git restore spelling is refused for an AGENT by
// the onboarding gate, and the whole-directory restore is refused even on an
// intact project by the plan gate.
// A human in their own terminal never meets PreToolUse. So the notice must not
// hand the agent a command it will be denied.

test('the agent is told not to run any git restore, and is given the route that was measured to work', () => {
  const { dir } = onboarded('actors', { gitignoreRunState: true });
  wipe(dir);
  const notice = stateLossNotice(dir)!;
  assert.match(notice, /YOU, THE AGENT, CANNOT RESTORE THIS FROM GIT/);
  for (const refused of ['git restore', 'git checkout --', 'git checkout HEAD --', 'git stash pop', 'git reset --hard', 'git clean -fdx']) {
    assert.ok(notice.includes(refused), `the refused spelling ${refused} is named so the agent does not discover it by being denied`);
  }
  assert.match(notice, /Do not run them and do not retry them/, 'no retry loop');
  assert.match(notice, /git show HEAD:\.traffic-one\/\.one\.json/, 'the permitted read');
  assert.match(notice, /with Write or apply_patch/, 'the permitted write');
  assert.match(notice, /re-run the architect to PLAN_READY/, 'and what the route does not restore');
});

test('every command the notice addresses to the agent is one a wiped project permits', () => {
  // The guard against the defect this correction fixes: any shell command the
  // notice tells the AGENT to run must appear on the permitted side of the arm K
  // matrix. The permitted set is small and measured — reads only.
  const { dir } = onboarded('agent-cmds');
  wipe(dir);
  const notice = stateLossNotice(dir)!;
  const agentSection = notice.slice(notice.indexOf('YOU, THE AGENT'), notice.indexOf('· THE USER'));
  const measuredPermitted = [
    'git show HEAD:.traffic-one/.one.json',
    'git cat-file -p HEAD:.traffic-one/.one.json',
    'echo', 'ls', 'cat', 'git status',
  ];
  // Every backticked shell-looking command in the agent's own instruction line,
  // minus the ones it explicitly says are REFUSED, must be in the permitted set.
  const instruction = agentSection.slice(agentSection.indexOf('IF THE USER SAYS IT WAS NOT'));
  for (const match of instruction.matchAll(/`([^`]+)`/g)) {
    const command = match[1] || '';
    if (command.startsWith('.traffic-one')) continue; // a path, not a command
    assert.ok(
      measuredPermitted.some((permitted) => command.startsWith(permitted)),
      `the notice tells the agent to run \`${command}\`, which is not on the measured permitted list`,
    );
  }
});

test('every clause of the notice is a fact read off a surviving record', () => {
  // `onboarded` commits AFTER the reset ladder, so HEAD already carries the live
  // pointer — a second commit here would have nothing to record.
  const { dir, live } = onboarded('clauses', { resets: 1 });
  const committed = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
  wipe(dir);
  const notice = stateLossNotice(dir)!;
  assert.ok(notice.includes(`mode \`${String(committed.mode)}\``), 'the mode is git\'s, not a guess');
  assert.ok(notice.includes(`stack \`${String(committed.stack)}\``));
  assert.ok(notice.includes(`run \`${live}\``), 'the run id is the one HEAD carries');
  // And the half it must not claim: no number, no "3 resets", no list of what
  // this project actually had.
  assert.match(notice, /cannot tell you WHICH of those this project had/);
  assert.ok(!/\b3 resets\b/.test(notice));
});

test('cleanup', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
