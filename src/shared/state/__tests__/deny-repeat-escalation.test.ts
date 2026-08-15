// The deny-repeat counter existed and worked, and was wired into exactly ONE
// gate (plan-guard's plan-write aggregator). Every other refusal in the product
// — ~120 declared causes — could be drawn identically forever with nothing
// counting, which is the same failure the counter was built for, one level up.
// These tests cover the chokepoint that closes that (core/pipeline.ts's deny
// exits), the set of refusals deliberately left out of it, and the KEY, which
// the work item proposed replacing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runPipeline } from '../../../core/pipeline';
import { buildContext } from '../../../core/context';
import { deny, askUser } from '../../../core/result';
import { toolClassForRawName } from '../../../core/events';
import type { Handler, HookInput, HookResult } from '../../../core/types';
import {
  DENY_IDS,
  NEVER_ESCALATED_DENY_IDS,
  NEVER_OVERRIDABLE_DENY_IDS,
} from '../../../config/deny-ids';
import { mintOverride } from '../../override';
import { DENY_REPEAT_ESCALATE_AT, denyRepeatCounted, denySignature } from '../deny-repeat';
import { readDecisions } from '../decision-log';
import { recordPluginUseChoice } from '../plugin-use';
import { trackedTempDirs } from '../../../test-support/__tests__/temp-dirs';

const RUN_ID = 'R';

// Attributed by the PATH each fixture was handed at creation time, never by a
// prefix scan of os.tmpdir(): other runs of this same file are concurrent
// processes, and a prefix names the file rather than the run — see
// test-support/__tests__/temp-dirs.ts.
const dirs = trackedTempDirs('t1-deny-escalate-');
const savedEnv = {
  prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
  state: process.env.XDG_STATE_HOME,
};

function freshProject(): string {
  // The helper realpaths, because the override ledger keys on a hash of the
  // RESOLVED project root (macOS's tmpdir is a symlink) and the pipeline
  // consults it on every overridable deny — an unresolved fixture path reads a
  // different ledger than it writes.
  const dir = dirs.make();
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.traffic-one', '.one.json'),
    JSON.stringify({ currentRunId: RUN_ID }),
    'utf8',
  );
  // Consent and the override key both live OUTSIDE the project, in the per-user
  // machine dir, so leaving either unpinned makes this file's verdicts depend on
  // the state of the real `~/.traffic-one` — which every other suite in a
  // parallel run is also writing to, and which one of them sweeps. The deny path
  // reads both (consent fences the counter's write; the override lookup runs on
  // any refusal the never-overridable list does not cover), so both are pinned
  // inside our own temp root and nothing here touches machine state at all.
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.XDG_STATE_HOME = path.join(dir, 'machine-state');
  // The counter writes under `.traffic-one/runs/<id>/debug/`, which the consent
  // fence refuses while the use-plugin question is outstanding — by design, and
  // covered by deny-repeat.ts's own tests. These tests are about what happens
  // AFTER consent, so they answer it.
  recordPluginUseChoice(dir, true, 'test');
  return dir;
}

after(() => {
  if (savedEnv.prefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedEnv.prefs;
  if (savedEnv.state === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.state;
  dirs.cleanup();
});

function gate(id: string, run: () => HookResult): Handler {
  return { id, event: 'PreToolUse', priority: 20, run };
}

function ctxFor(cwd: string, rawTool = 'Write'): ReturnType<typeof buildContext> {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: {},
    tool: { class: toolClassForRawName(rawTool), rawName: rawTool },
  };
  return buildContext(input);
}

/** Refuse `times` times through the real pipeline; return each reason. */
async function refuse(cwd: string, handler: Handler, times: number): Promise<string[]> {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < times; attempt += 1) {
    const result = await runPipeline([handler], ctxFor(cwd));
    reasons.push(result.kind === 'deny' ? result.reason : `<${result.kind}>`);
  }
  return reasons;
}

function counterFile(cwd: string): string {
  return path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'debug', 'deny-repeats.json');
}

// ── the key ──────────────────────────────────────────────────────────────────
// The work item prescribed keying repeats on `(runId, gateId, denyId)`. That is
// coarser than the message key already in place, and coarser than BOTH of the
// looser keys deny-repeat.ts's header records as killed by live evidence — so
// this row is why the existing key stands and only the wiring generalised.

test('the proposed (runId, gateId, denyId) key merges the two loops live evidence split apart', () => {
  const proposed = (gateId: string, denyId: string): string => `${RUN_ID}::${gateId}::${denyId}`;

  // 16co: one agent clearing collapse a line at a time. Same file, same cause,
  // same gate, MOVED line — progress on a real defect, not a loop.
  const collapse = (line: number): string =>
    `Structural gate: STRUCT_COLLAPSED_LINE (LessonPage.tsx:${line}): Line ${line} packs an entire function/component onto one line.`;
  assert.equal(
    proposed('plan-guard.write', 'implementer-collapse-gate'),
    proposed('plan-guard.write', 'implementer-collapse-gate'),
    'the proposed key cannot see the line at all — both attempts are one bucket',
  );
  assert.notEqual(
    denySignature('src/pages/LessonPage.tsx', [collapse(57)]),
    denySignature('src/pages/LessonPage.tsx', [collapse(76)]),
    'the message key still keeps a converging agent out of the count',
  );

  // The other killed key's incident: two DIFFERENT collapsed files reported on
  // one digest write, so `denyTarget` is the same digest both times and only the
  // message differs. The proposed key drops the message, so it cannot see this
  // either — and unlike digit-normalisation (which at least compared file NAMES)
  // it discards the subject entirely.
  const digest = '.traffic-one/digests/R/frontend.md';
  const collapsedFile = (file: string): string =>
    `Frontend completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${file}\` packs an entire component/route onto a single line`;
  assert.notEqual(
    denySignature(digest, [collapsedFile('apps/web/src/pages/Home.tsx')]),
    denySignature(digest, [collapsedFile('apps/web/src/pages/Settings.tsx')]),
    'two different collapsed files are two different refusals',
  );

  // And the discrimination the proposed key WOULD have added is already there:
  // the pipeline signs `denyTarget` alongside the message, so one cause on two
  // files is two counts even when the two messages are identical.
  const sameText = 'Run-team enforcement gate: this file belongs to another role.';
  assert.notEqual(
    denySignature('apps/web/src/a.tsx', [sameText]),
    denySignature('apps/web/src/b.tsx', [sameText]),
  );
});

// ── the gap this lane closes ─────────────────────────────────────────────────

test('every gate escalates, not just plan-write — and two gates keep separate counts', async () => {
  const cwd = freshProject();
  // Neither gate knows the counter exists; both are ordinary refusals with a
  // declared id. Before the chokepoint, NEITHER of these would ever have said a
  // word about repeating, however many turns the agent spent on them.
  const boundary = gate('session.workspace-boundary', () => deny(
    'traffic-one — workspace boundary: this path is outside the opened workspace.',
    { denyId: 'workspace-boundary-guard', denyTarget: '../outside/x.ts' },
  ));
  const library = gate('plan-guard.library', () => deny(
    'traffic-one — library allowlist: `moment` is not in the allowlist.',
    { denyId: 'library-allowlist-forbidden', denyTarget: 'package.json' },
  ));

  const first = await refuse(cwd, boundary, DENY_REPEAT_ESCALATE_AT);
  assert.doesNotMatch(first[0] || '', /STOP RETRYING/, 'attempt 1 reads exactly as the gate wrote it');
  assert.doesNotMatch(first[1] || '', /STOP RETRYING/, 'attempt 2 too');
  assert.match(first[2] || '', /STOP RETRYING/, 'the third identical refusal from a NON-plan-write gate escalates');
  assert.match(first[2] || '', /\.\.\/outside\/x\.ts/, 'and names its own target');
  assert.match(first[2] || '', /BLOCKED/, 'and the honest exit');

  // A different gate's refusals are a different loop: the second gate must be at
  // 1, not inherit the first gate's 3. (Both live in one counter file, so this is
  // the assertion that the key is the message and not the run.)
  const second = await refuse(cwd, library, 1);
  assert.doesNotMatch(second[0] || '', /STOP RETRYING/, 'a different refusal starts its own count');

  const counts = JSON.parse(fs.readFileSync(counterFile(cwd), 'utf8')) as Record<string, number>;
  assert.deepEqual(Object.values(counts).sort(), [1, 3], `two independent loops: ${JSON.stringify(counts)}`);
});

// ── the false positive that matters more than the true positive ─────────────
// A run that is CONVERGING must never be told to stop. deny-repeat.ts's header
// states this as the principle the key was chosen for ("firing escalation at an
// agent that is converging is worse than never firing it at all"), and it is the
// stabilization theme in miniature: the product must not read "I am making
// progress" as "the answer is no" and take the branch that blocks.

test('an agent that is converging is never escalated, however many turns it spends', async () => {
  const cwd = freshProject();
  const target = 'apps/web/src/pages/LessonPage.tsx';
  // One gate, one file, one CAUSE — the realistic shape of a real fix session.
  // The agent clears defects one at a time, so the gate keeps refusing, and each
  // refusal names a different line because a different line is now the worst one.
  // This is 16co exactly, the incident that killed digit-normalisation.
  let line = 57;
  const converging = gate('plan-guard.write', () => deny(
    `traffic-one — plan gate violation(s):\n  - Structural gate: STRUCT_COLLAPSED_LINE (${target}:${line}): Line ${line} packs an entire function/component onto one line.`,
    { denyId: 'implementer-collapse-gate', denyTarget: target },
  ));

  const reasons: string[] = [];
  for (const next of [57, 76, 94, 111, 128, 140, 152]) {
    line = next;
    const result = await runPipeline([converging], ctxFor(cwd));
    reasons.push(result.kind === 'deny' ? result.reason : `<${result.kind}>`);
  }

  // SEVEN refusals — the length of the 17cl loop that motivated the feature —
  // from one gate, on one file, for one cause, and not one of them escalates.
  assert.equal(reasons.length, 7);
  for (const [index, reason] of reasons.entries()) {
    assert.doesNotMatch(reason, /STOP RETRYING/, `turn ${index + 1} punished a converging agent`);
  }
  const counts = JSON.parse(fs.readFileSync(counterFile(cwd), 'utf8')) as Record<string, number>;
  assert.deepEqual(
    Object.values(counts), [1, 1, 1, 1, 1, 1, 1],
    `each step of real progress is its own refusal, counted once: ${JSON.stringify(counts)}`,
  );
});

test('a deny interleaved with a DIFFERENT one does not accumulate toward escalation', async () => {
  const cwd = freshProject();
  const target = 'apps/web/src/pages/LessonPage.tsx';
  // The exact sequence to worry about: the agent hits A, fixes it, is refused for
  // an unrelated reason B, fixes that, and trips A once more. A has now been seen
  // twice across four turns with real work between them. Escalating here would be
  // the "I don't know" → "the answer is no" inversion: two sightings separated by
  // progress is not a loop, and the threshold must not be reachable by summing
  // across interleaving.
  const reasonA = 'traffic-one — plan gate violation(s):\n  - Structural gate: STRUCT_COLLAPSED_LINE: one statement per line.';
  const reasonB = 'traffic-one — plan gate violation(s):\n  - Import gate: `moment` is not in the library allowlist.';
  let current = reasonA;
  const alternating = gate('plan-guard.write', () => deny(current, {
    denyId: 'implementer-collapse-gate', denyTarget: target,
  }));

  const seen: string[] = [];
  for (const next of [reasonA, reasonB, reasonA]) {
    current = next;
    const result = await runPipeline([alternating], ctxFor(cwd));
    seen.push(result.kind === 'deny' ? result.reason : `<${result.kind}>`);
  }
  for (const [index, reason] of seen.entries()) {
    assert.doesNotMatch(reason, /STOP RETRYING/, `turn ${index + 1} escalated across an interleaved refusal`);
  }
  const counts = JSON.parse(fs.readFileSync(counterFile(cwd), 'utf8')) as Record<string, number>;
  assert.deepEqual(Object.values(counts).sort(), [1, 2], `A at 2, B at 1 — neither at the threshold: ${JSON.stringify(counts)}`);

  // And the threshold is still REACHABLE: a third genuine sighting of A escalates,
  // because at that point the agent has re-issued the identical rejected write
  // three times whatever it did in between. Escalation is deferred by progress,
  // never disabled by it.
  current = reasonA;
  const third = await runPipeline([alternating], ctxFor(cwd));
  assert.equal(third.kind, 'deny');
  if (third.kind === 'deny') assert.match(third.reason, /STOP RETRYING/, 'a real loop is still caught, just later');
});

test('escalation cannot wedge a run: the verdict and the gate\'s own text are byte-identical with it', async () => {
  const cwd = freshProject();
  const target = 'apps/web/src/x.tsx';
  const body = 'traffic-one — plan gate violation(s):\n  - Structural gate: STRUCT_COLLAPSED_LINE: one statement per line.';
  const looping = gate('plan-guard.write', () => deny(body, {
    denyId: 'implementer-collapse-gate', denyTarget: target,
  }));

  const results = [];
  for (let attempt = 0; attempt < DENY_REPEAT_ESCALATE_AT + 2; attempt += 1) {
    results.push(await runPipeline([looping], ctxFor(cwd)));
  }

  // The whole safety argument for escalating by default: it is ADVICE, appended.
  // Every attempt is still a deny (never an allow — this must not become a way
  // past a gate) and never anything harsher (never a hard stop that strands a run
  // whose next attempt was about to work). The verdict is identical throughout,
  // and the gate's own text still leads every message, so nothing an agent reads
  // for the remedy moved or was truncated.
  for (const [index, result] of results.entries()) {
    assert.equal(result.kind, 'deny', `attempt ${index + 1} changed the VERDICT, not just the advice`);
    if (result.kind !== 'deny') continue;
    assert.ok(result.reason.startsWith(body), `attempt ${index + 1} displaced the gate's own remedy text`);
  }
  // Escalated attempts differ from unescalated ones only by pipeline suffixes
  // (STOP RETRYING, the override hatch on attempts 1–2, the correlation ref).
  // The hatch is omitted once STOP RETRYING fires — it is not a new failure
  // mode, and stripping every suffix must recover the gate's own text.
  const strip = (reason: string): string => reason
    .replace(/\n\nSTOP RETRYING[\s\S]*?not one of the options\./, '')
    .replace(/\n\nStuck on this specific refusal\?[\s\S]*?verified\/shipped\./, '')
    .replace(/\n\n\(traffic-one ref: [^)]*\)/, '');
  assert.equal(new Set(results.map((r) => (r.kind === 'deny' ? strip(r.reason) : ''))).size, 1,
    'stripping the escalation, the override hint, and the ref leaves every attempt identical');
});

test('a repeatedly crashing gate escalates — never-overridable does not mean never-escalated', async () => {
  const cwd = freshProject();
  const crasher = gate('plan-guard.write', () => { throw new Error('boom'); });
  const reasons = await refuse(cwd, crasher, DENY_REPEAT_ESCALATE_AT);
  // The fail-closed crash deny is the most invisible loop of all: it prescribes
  // a remedy ("resolve the Traffic One setup/plugin error") that nobody inside
  // the run can apply, so without this the agent retries until the run dies.
  assert.match(reasons[0] || '', /blocked fail-closed/, 'still fail-closed, unchanged');
  assert.doesNotMatch(reasons[0] || '', /STOP RETRYING/);
  assert.match(reasons[2] || '', /STOP RETRYING/);
  assert.match(reasons[2] || '', /BLOCKED/, 'the one exit a crash loop actually has');
});

test('a refusal an operator override lifts is never counted', async () => {
  const cwd = freshProject();
  // An overridden deny never leaves the pipeline: the gate's turn is skipped and
  // the run continues. Counting it would charge the agent for a refusal it never
  // saw — and worse, an operator who unblocks a gate three times would have
  // primed the count so the first refusal the agent DOES see arrives already
  // escalated, telling it to report BLOCKED on its first attempt. Hence the
  // counter runs strictly after the override lookup.
  const minted = mintOverride({
    projectRoot: cwd, runId: RUN_ID, scope: 'gate', target: 'plan-guard.scaffold', snapshot: {},
  });
  assert.equal(minted.ok, true, `mint failed: ${minted.ok ? '' : minted.reason}`);
  const overridden = gate('plan-guard.scaffold', () => deny(
    'traffic-one — scaffold gate: the plan is not ready.',
    { denyId: 'scaffold-plan-gate', denyTarget: 'apps/web/src/x.tsx' },
  ));

  for (let attempt = 0; attempt < DENY_REPEAT_ESCALATE_AT + 1; attempt += 1) {
    const result = await runPipeline([overridden], ctxFor(cwd));
    assert.notEqual(result.kind, 'deny', 'the override is doing its job');
  }
  assert.equal(fs.existsSync(counterFile(cwd)), false, 'a lifted refusal wrote a count');

  // A gate the token does NOT name still refuses, on the same file, and its count
  // starts at 1: escalation lands on the third refusal the AGENT saw, never on a
  // base the operator's own unblocks laid down. (A different gate id, because the
  // token is scoped to `(run, gate)` and lifts every deny id that gate raises.)
  const other = gate('plan-guard.collapse', () => deny(
    'traffic-one — collapse gate: a different refusal entirely.',
    { denyId: 'implementer-collapse-gate', denyTarget: 'apps/web/src/x.tsx' },
  ));
  const reasons = await refuse(cwd, other, DENY_REPEAT_ESCALATE_AT);
  assert.doesNotMatch(reasons[0] || '', /STOP RETRYING/, 'the first refusal the agent sees is its first');
  assert.match(reasons[2] || '', /STOP RETRYING/);
});

// ── the exclusion list ───────────────────────────────────────────────────────

test('a refusal that is waiting on a human is never escalated, and never counted at all', async () => {
  const cwd = freshProject();
  // The onboarding link deny: the agent's only correct move is to show it and
  // retry, so the repeat IS the mechanism. Escalating would tell a run that is
  // behaving correctly to report BLOCKED.
  const waiting = gate('onboarding-gate', () => deny(
    'traffic-one — setup required. Show this link to the user: https://example.test/setup',
    { denyId: 'onboarding-server-deny-repeat' },
  ));
  const reasons = await refuse(cwd, waiting, DENY_REPEAT_ESCALATE_AT + 3);
  for (const [index, reason] of reasons.entries()) {
    assert.doesNotMatch(reason, /STOP RETRYING/, `attempt ${index + 1} must read exactly as before`);
  }

  // Not counted, not merely un-escalated. The counter tracks a bounded number of
  // signatures and evicts the coldest half on overflow, so a forty-turn wait for
  // a human would otherwise evict the loop this feature exists to catch — and a
  // waiting project stays free of a write per turn.
  assert.equal(fs.existsSync(counterFile(cwd)), false, 'an excluded refusal writes no counter file');
  const records = readDecisions(cwd, RUN_ID).filter((record) => record.decision === 'deny');
  assert.equal(records.length, reasons.length, 'the refusals are still fully recorded');
  assert.deepEqual(
    [...new Set(records.map((record) => record.repeatCount))],
    [undefined],
    'and carry no repeatCount: "excluded by policy" is not "refused once"',
  );
});

test('a gate that already legislates its own repeats is not second-guessed', async () => {
  const cwd = freshProject();
  // Found by auditing all 167 escalatable ids' own prose, not by intuition. This
  // gate's text says "Retry the SAME spawn, unchanged… clears in about two
  // seconds. If the same deny repeats more than twice, run doctor." A generic
  // "STOP RETRYING / apply the remedy / else report BLOCKED" fires at exactly the
  // count that prose legislates, and every branch it offers is wrong here: the
  // remedy IS re-issuing unchanged, and reporting BLOCKED aborts a run whose lock
  // was about to clear.
  const locked = gate('agent-model.enforcement', () => deny(
    'traffic-one — spawn blocked: a concurrent hook holds this run\'s claims lock. Retry the SAME spawn, unchanged, in your next message.',
    { denyId: 'spawn-claim-unavailable', denyTarget: 'senior-frontend' },
  ));
  for (const reason of await refuse(cwd, locked, DENY_REPEAT_ESCALATE_AT + 2)) {
    assert.doesNotMatch(reason, /STOP RETRYING/, 'the gate\'s own repeat instruction stands unopposed');
  }

  // The claim-persist failure is the same shape: "Retry this tool once; if it
  // repeats, replace the child from the parent" — a parent-side action, not the
  // digest verdict this escalation prescribes.
  const persist = gate('agent-model.codex-child', () => deny(
    'traffic-one — Codex child blocked: the verified role claim could not be persisted atomically. Retry this tool once; if it repeats, replace the child from the parent.',
    { denyId: 'codex-child-model-claim-persist-failed', denyTarget: 'senior-frontend' },
  ));
  for (const reason of await refuse(cwd, persist, DENY_REPEAT_ESCALATE_AT + 2)) {
    assert.doesNotMatch(reason, /STOP RETRYING/);
  }
  assert.equal(fs.existsSync(counterFile(cwd)), false, 'and neither is counted, so neither evicts a real loop');

  // Their nearest siblings deliberately DO escalate: both tell the agent not to
  // retry unchanged, so three identical draws is a loop against instructions.
  for (const id of ['codex-child-model-role-held', 'spawn-role-conflict'] as const) {
    assert.equal(denyRepeatCounted({ reason: 'x', denyId: id }), true, `${id} must keep escalating`);
  }
});

test('an approval prompt and an undeclared id are both left alone', async () => {
  const cwd = freshProject();
  // askUser is a live approve/reject modal, not a refusal. Appending "STOP
  // RETRYING / report BLOCKED" to the QUESTION rendered inside the dialog is the
  // same mistake stampDeny already refuses to make with the correlation ref.
  const asking = gate('plan-guard.deploy', () => askUser('Deploy to production?', 'awaiting approval'));
  for (const reason of await refuse(cwd, asking, DENY_REPEAT_ESCALATE_AT + 1)) {
    assert.equal(reason, 'Deploy to production?', 'a modal question stays byte-identical');
  }

  // A gate that declared no id gets the pipeline's synthetic
  // `unattributed-handler:<gateId>`, which is deliberately not a declared id: an
  // id nobody has classified against the exclusion rule cannot be asserted to
  // have an in-session remedy, so it reads as it does today.
  // tests/deny-id-completeness.test.ts is what keeps this path empty.
  const anonymous = gate('some.new-gate', () => deny('traffic-one — refused for reasons.'));
  for (const reason of await refuse(cwd, anonymous, DENY_REPEAT_ESCALATE_AT + 1)) {
    assert.doesNotMatch(reason, /STOP RETRYING/, 'an unreviewed id gets neither relaxation nor escalation');
  }
  assert.equal(fs.existsSync(counterFile(cwd)), false);

  // Asserted on the classifier directly as well, on the exact string the pipeline
  // mints and the log records. Through the pipeline alone this row is decided by
  // `denyId: undefined` and would keep passing if the classifier started
  // accepting every unrecognized id, which is the failure mode that matters here:
  // the two shapes it must refuse are the fallback and an id from another build.
  assert.equal(denyRepeatCounted({ reason: 'x', denyId: 'unattributed-handler:some.new-gate' }), false);
  assert.equal(denyRepeatCounted({ reason: 'x', denyId: 'a-gate-from-a-future-build' }), false);
  assert.equal(denyRepeatCounted({ reason: 'x', denyId: undefined }), false);
  assert.equal(denyRepeatCounted({ reason: 'x', denyId: 'workspace-boundary-guard' }), true, 'a declared, non-excluded id is counted');
  assert.equal(denyRepeatCounted({ reason: 'x', denyId: 'workspace-boundary-guard', askUser: true }), false, 'askUser wins over the id');
});

test('the never-escalated and never-overridable sets are different sets, in both directions', () => {
  const escalationExcluded = new Set<string>(NEVER_ESCALATED_DENY_IDS);
  const overrideExcluded = new Set<string>(NEVER_OVERRIDABLE_DENY_IDS);

  // Both lists must stay inside the declared catalog, or an entry silently stops
  // matching anything. (`satisfies readonly DenyId[]` enforces this at compile
  // time; asserted here too so a widened type cannot quietly drop the check.)
  const declared = new Set<string>(DENY_IDS);
  for (const id of escalationExcluded) assert.ok(declared.has(id), `${id} is not a declared deny id`);

  // Never-overridable but escalatable: refusals nothing may lift, where the
  // agent still has an action to take (or, for the crash deny, a report to
  // write). Merging the lists would have silenced escalation on every one.
  for (const id of ['pipeline-handler-crashed', 'workspace-boundary-guard', 'authoring-guard', 'verifier-independence-gate', 'frontend-structure-completion-gate', 'deploy-gate-shipper-approval-required']) {
    assert.ok(overrideExcluded.has(id), `${id} should be never-overridable`);
    assert.ok(!escalationExcluded.has(id), `${id} must still escalate: a human may not lift it, and repeating it is still a loop`);
  }

  // Escalation-excluded but overridable: refusals a human could lift, where
  // repeating is exactly what the agent should be doing.
  for (const id of ['onboarding-use-plugin-question', 'onboarding-server-deny-repeat', 'model-choice-stop-repeat', 'plan-write-model-choice-pending', 'team-confirmation', 'agent-reuse-await-cursor-id']) {
    assert.ok(escalationExcluded.has(id), `${id} should be never-escalated`);
    assert.ok(!overrideExcluded.has(id), `${id} is overridable, so the two lists cannot be one list`);
  }

  // The overlap is small and deliberate, so name it exactly: a change to either
  // list that grows this has to say why here.
  const both = [...escalationExcluded].filter((id) => overrideExcluded.has(id)).sort();
  assert.deepEqual(both, [
    // An approval prompt: a token would answer the human's question for them,
    // and a "stop retrying" would nag them about their own dialog.
    'subagent-bind-model-choice-pending',
    'user-approval-request',
    // Genuinely both, for two unrelated reasons — which is exactly why the lists
    // are separate. Not overridable: lifting it lets a Codex child bind a role
    // whose claim was never persisted, i.e. an identity nothing can later verify.
    // Not escalated: its own prose is "retry this tool once; if it repeats,
    // replace the child from the parent", so a generic "report BLOCKED" would
    // override a narrower, better instruction.
    'codex-child-model-claim-persist-failed',
  ].sort(), 'the two sets intersect only where a refusal is genuinely both');
});
