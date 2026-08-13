import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { trackedTempDirs } from '../../test-support/__tests__/temp-dirs';
import { runPipeline, selectHandlers } from '../pipeline';
import { buildContext } from '../context';
import { askUser, context, deny, mergeResults, noop } from '../result';
import { toolClassForRawName } from '../events';
import { readDecisions } from '../../shared/state/decision-log';
import { writeJson } from '../../shared/fsjson';
import { recordPluginUseChoice } from '../../shared/state/plugin-use';
import type { Ctx, Handler, HookInput, HookResult } from '../types';

// runPipeline now appends one decision-log record per verdict (see
// pipeline.ts's header), so every test that calls it does REAL, small,
// disposable disk I/O the way every other state-writing test in this
// codebase already does (mkdtempSync + a teardown) — a fake Ctx with only
// `input`/`host`/`cwd`/`now` (the pre-existing fixture) no longer has the
// fsjson/paths/log members runPipeline now reads, so buildContext() (the
// real composition root) replaces it.
const dirs = trackedTempDirs('t1-pipeline-test-');
const TMP_ROOT = dirs.make();
let dirSeq = 0;
const savedStateHome = process.env.XDG_STATE_HOME;
// The whole per-user machine dir is redirected under TMP_ROOT for the life of
// this file, because everything runPipeline reads outside the project lives
// there: the use-plugin answer, and the operator-override key and ledger the
// deny exit consults. Unpinned, recording consent wrote one stray entry into the
// developer's own `~/.traffic-one/projects/` per test — keyed by a hash of a temp
// path that stops existing at teardown, so nothing ever collects them — and a
// passing test would be reading their real ledger.
//
// XDG_STATE_HOME rather than TRAFFIC_ONE_PROJECT_PREFS_PATH: the latter names one
// exact FILE for every project, so a project that deliberately has no consent
// (the pending-answer tests below) would read the answer another project wrote.
// Redirecting the root keeps prefs keyed per project, which is the property those
// tests rest on.
process.env.XDG_STATE_HOME = path.join(TMP_ROOT, 'machine-state');

// Consent is recorded because the log obeys projectWritesPermitted: with
// ask-first on by default, a project that never answered the use-plugin
// question gets no files at all (see decision-log.ts's fence and its two
// dedicated tests). These tests are about recording, so they need a project
// that is genuinely allowed to be written to.
function freshProjectDir(): string {
  dirSeq += 1;
  const dir = path.join(TMP_ROOT, `p${dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  recordPluginUseChoice(dir, true, 'test');
  return dir;
}
after(() => {
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  dirs.cleanup();
});

function ctxFor(event: HookInput['event'], rawTool?: string, cwd: string = freshProjectDir()): Ctx {
  const input: HookInput = {
    event,
    host: 'claude',
    cwd,
    raw: {},
    ...(rawTool ? { tool: { class: toolClassForRawName(rawTool), rawName: rawTool } } : {}),
  };
  return buildContext(input);
}

function withCurrentRunId(cwd: string, runId: string): void {
  const t1 = path.join(cwd, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ currentRunId: runId }), 'utf8');
}

function gate(
  id: string,
  priority: number,
  run: () => HookResult,
  tools?: Handler['tools'],
): Handler {
  return { id, event: 'PreToolUse', priority, run, ...(tools ? { tools } : {}) };
}

test('pipeline sorts by priority and short-circuits on first deny', async () => {
  const calls: string[] = [];
  const handlers: Handler[] = [
    gate('b', 20, () => { calls.push('b'); return deny('blocked by b'); }, ['shell']),
    gate('a', 10, () => { calls.push('a'); return context('a-context'); }, ['shell']),
    gate('c', 30, () => { calls.push('c'); return noop(); }, ['shell']),
  ];
  const result = await runPipeline(handlers, ctxFor('PreToolUse', 'Bash'));
  assert.deepEqual(calls, ['a', 'b']); // c never runs — short-circuit at b
  assert.equal(result.kind, 'deny');
  // The correlation-id suffix is appended AFTER the handler's own reason —
  // exact equality on the ORIGINAL reason no longer holds (see pipeline.ts's
  // stampDeny), but the handler's own text is still the prefix, verbatim.
  if (result.kind === 'deny') assert.match(result.reason, /^blocked by b\n\n\(traffic-one ref: /);
});

test('pipeline filters by event and tool class', async () => {
  const handlers: Handler[] = [
    gate('shell-only', 10, () => context('shell'), ['shell']),
    { id: 'read-only', event: 'PreToolUse', priority: 10, tools: ['file-read'], run: () => context('read') },
  ];
  const cwd = freshProjectDir();
  const selected = selectHandlers(handlers, ctxFor('PreToolUse', 'Read', cwd)).map((h) => h.id);
  assert.deepEqual(selected, ['read-only']);
  const result = await runPipeline(handlers, ctxFor('PreToolUse', 'Read', cwd));
  assert.equal(result.kind, 'context');
  if (result.kind === 'context') assert.equal(result.context, 'read');
});

test('a throwing PreToolUse handler is denied fail-closed instead of escaping to a host fail-open wrapper', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-crash');
  const failure = Object.assign(new Error('sandbox denied global state'), { code: 'EPERM' });
  const result = await runPipeline([
    gate('onboarding', 10, () => { throw failure; }, ['shell']),
  ], ctxFor('PreToolUse', 'exec_command', cwd));
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') {
    assert.match(result.reason, /onboarding gate failed \(EPERM\)/);
    assert.match(result.reason, /blocked fail-closed/);
    // The IDENTITY of the crash deny, not just its prose. This is the one id
    // the deny-budget plan marks non-overridable (a crashed gate may never be
    // allowed through at N), and asserting only the reason text let stampDeny
    // drop both ids with the suite still green.
    assert.equal(result.denyId, 'pipeline-handler-crashed');
    assert.equal(result.gateId, 'onboarding', 'the crashing handler is named, so `which gate` survives into the log');
  }
  const records = readDecisions(cwd, 'run-crash');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.decision, 'deny');
  assert.equal(records[0]!.denyId, 'pipeline-handler-crashed');
  assert.equal(records[0]!.gateId, 'onboarding');
});

test('a throwing non-tool handler still propagates to the host lifecycle fallback', async () => {
  const handler: Handler = {
    id: 'session',
    event: 'SessionStart',
    priority: 10,
    run: () => { throw new Error('session failed'); },
  };
  await assert.rejects(runPipeline([handler], ctxFor('SessionStart')), /session failed/);
});

test('mergeResults concatenates contexts when no deny', () => {
  const merged = mergeResults([context('one'), noop(), context('two')]);
  assert.equal(merged.kind, 'context');
  if (merged.kind === 'context') assert.equal(merged.context, 'one\n\ntwo');
});

test('toolClassForRawName maps all three hosts to one vocabulary', () => {
  assert.equal(toolClassForRawName('Bash'), 'shell');
  assert.equal(toolClassForRawName('exec_command'), 'shell');
  assert.equal(toolClassForRawName('Edit'), 'file-edit');
  assert.equal(toolClassForRawName('spawn_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('multi_agent_v1.spawn_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('wait_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('multi_agent_v1.wait_agent'), 'spawn-agent');
  assert.equal(toolClassForRawName('followup_task'), 'spawn-agent');
  assert.equal(toolClassForRawName('collaboration.followup_task'), 'spawn-agent');
  assert.equal(toolClassForRawName('send_message'), 'spawn-agent');
  assert.equal(toolClassForRawName('collaboration.send_message'), 'spawn-agent');
  assert.equal(toolClassForRawName('send_input'), 'spawn-agent');
  assert.equal(toolClassForRawName('Grep'), 'search');
  assert.equal(toolClassForRawName('SomethingElse'), 'other');
});

// ── decision log integration ─────────────────────────────────────────────────

test('runPipeline records exactly one decision per verdict, for all four decision kinds', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-decisions');

  // deny — any event.
  await runPipeline([gate('g', 10, () => deny('no', { denyId: 'workspace-boundary-guard' }))],
    ctxFor('PreToolUse', 'Bash', cwd));
  // allow — PreToolUse, no deny (context or noop content, both read as 'allow').
  await runPipeline([gate('g', 10, () => context('fyi'))], ctxFor('PreToolUse', 'Read', cwd));
  await runPipeline([gate('g', 10, () => noop())], ctxFor('PreToolUse', 'Write', cwd));
  // context — a non-PreToolUse event producing real context is reported as
  // bookkeeping, never as an "allow" (there was no tool call to allow).
  await runPipeline([
    { id: 'g', event: 'SessionStart', priority: 10, run: () => context('session context') },
  ], ctxFor('SessionStart', undefined, cwd));
  // noop — a non-PreToolUse event with nothing to say.
  await runPipeline([
    { id: 'g', event: 'PostToolUse', priority: 10, run: () => noop() },
  ], ctxFor('PostToolUse', undefined, cwd));

  const records = readDecisions(cwd, 'run-decisions');
  assert.equal(records.length, 5);
  assert.deepEqual(records.map((r) => r.decision), ['deny', 'allow', 'allow', 'context', 'noop']);
  assert.equal(records[0]!.denyId, 'workspace-boundary-guard');
  assert.equal(records[0]!.gateId, 'g');
  // hookSeq is strictly increasing within this one run.
  const seqs = records.map((r) => r.hookSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test('the correlation id echoed into a deny\'s reason is the exact id the decision record carries', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-correlate');
  const result = await runPipeline(
    [gate('workspace-boundary-guard', 10, () => deny('blocked'))],
    ctxFor('PreToolUse', 'Bash', cwd),
  );
  assert.equal(result.kind, 'deny');
  const match = result.kind === 'deny' ? /\(traffic-one ref: ([^)]+)\)/.exec(result.reason) : null;
  assert.ok(match, 'deny reason must carry a "(traffic-one ref: ...)" suffix');
  const correlationId = match![1]!;
  assert.match(correlationId, /^run-correlate:\d+:\d+$/);

  const records = readDecisions(cwd, 'run-correlate');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.correlationId, correlationId);
  assert.equal(String(records[0]!.pid), correlationId.split(':')[2]);
});

// ── deny identity: the fallback, askUser, and the echoed ref ────────────────

// Nothing asserted this before, in either direction: two tests above happen to
// run handlers that declare no denyId (so they exercise the fallback) without
// ever looking at what it produced. The fallback is the ONE place a synthetic
// id is minted, and its exact `unattributed-handler:<gateId>` shape is what
// makes a gap visible to anything iterating DENY_IDS — a consumer greps that
// prefix to tell "no id was declared" from a real cause.
test('a handler that declares no denyId gets the unattributed-handler:<gateId> fallback, on the result and in the log', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-fallback');
  const result = await runPipeline(
    [gate('some-unlabelled-gate', 10, () => deny('refused with no declared id'))],
    ctxFor('PreToolUse', 'Bash', cwd),
  );
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') {
    assert.equal(result.denyId, 'unattributed-handler:some-unlabelled-gate');
    assert.equal(result.gateId, 'some-unlabelled-gate');
  }
  const records = readDecisions(cwd, 'run-fallback');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.denyId, 'unattributed-handler:some-unlabelled-gate');
});

// A declared id is never overwritten by the fallback — the fallback only fills
// the hole. (Also the guard against a future "always stamp" refactor.)
test('a handler\'s own denyId survives the pipeline untouched', async () => {
  const result = await runPipeline(
    [gate('g', 10, () => deny('no', { denyId: 'workspace-boundary-guard', denyTarget: '/x/y' }))],
    ctxFor('PreToolUse', 'Bash'),
  );
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') {
    assert.equal(result.denyId, 'workspace-boundary-guard');
    assert.equal(result.denyTarget, '/x/y');
  }
});

// askUser reuses the deny KIND, but its `reason` is the question rendered in
// Cursor's approve/reject modal — a "(traffic-one ref: run-x:42:9912)" inside a
// yes/no dialog is product noise, and `agentMessage` (which the adapter emits
// beside it) is never stamped, so the two fields disagreed about whether a ref
// existed. It also carries its own catalog id rather than being reported as an
// unattributed fallback: a budget must be able to SKIP approval prompts, and
// `unattributed-handler:` is reserved for genuine gaps.
test('askUser keeps its question suffix-free and carries its own denyId, not the fallback', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-ask');
  const question = 'traffic-one — a model you picked is unavailable. Approve to continue on the fallback?';
  const result = await runPipeline(
    [gate('agent-model.model-gate-shell', 10, () => askUser(question, 'agent-facing branch instructions')),],
    ctxFor('PreToolUse', 'Bash', cwd),
  );
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') {
    assert.equal(result.reason, question, 'the modal question is passed through verbatim — no correlation suffix');
    assert.equal(result.askUser, true);
    assert.equal(result.agentMessage, 'agent-facing branch instructions');
    assert.equal(result.denyId, 'user-approval-request');
    assert.equal(result.gateId, 'agent-model.model-gate-shell');
  }
  // Still recorded (an approval prompt is evidence too) — just recorded as
  // itself, so a later budget can exclude it by id instead of guessing.
  const records = readDecisions(cwd, 'run-ask');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.denyId, 'user-approval-request');
});

// The suffix and the log obey ONE fence. appendDecision (decision-log.ts)
// declines to write for a project whose use-plugin question is still pending,
// so a deny there used to hand the user a ref to a decisions.jsonl that was
// never created — a dead pointer for them and for `doctor`.
test('no correlation ref is echoed when the use-plugin answer is still pending (nothing was written to point at)', async () => {
  const dir = path.join(TMP_ROOT, 'pending-consent');
  fs.mkdirSync(dir, { recursive: true });
  withCurrentRunId(dir, 'run-pending');
  const previous = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1'; // pin the ask-first flow, don't rely on the default
  try {
    const result = await runPipeline(
      [gate('g', 10, () => deny('blocked before consent', { denyId: 'workspace-boundary-guard' }))],
      ctxFor('PreToolUse', 'Bash', dir),
    );
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') {
      assert.equal(result.reason, 'blocked before consent', 'no ref: there is no record to correlate with');
      assert.equal(result.denyId, 'workspace-boundary-guard', 'the verdict and its identity are unchanged');
    }
    assert.deepEqual(readDecisions(dir, 'run-pending'), [], 'and indeed nothing was written');
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = previous;
  }
});

// ── the two load-bearing record fields the log could not previously fill ─────

test('a deny records the repeatCount its own prose was rendered from, and only on a deny', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-repeats');
  // An ORDINARY gate: it renders one fixed refusal and knows nothing about the
  // counter. That is the change this test now guards — the count and the
  // escalation used to be the gate's own job (plan-guard's plan-write was the
  // only gate that did it, and this test modelled its shape), and are now
  // pipeline.ts's, so a gate written by anyone gets both for free.
  const denyingGate = gate('plan-guard.plan-write', 10,
    () => deny('refused', { denyId: 'plan-write-violation-unattributed', denyTarget: 'src/app.tsx' }));

  const reasons: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runPipeline([denyingGate], ctxFor('PreToolUse', 'Write', cwd));
    if (result.kind === 'deny') reasons.push(result.reason);
  }
  const denies = readDecisions(cwd, 'run-repeats').filter((record) => record.decision === 'deny');
  assert.deepEqual(denies.map((record) => record.repeatCount), [1, 2, 3], 'the count climbs with the refusals');
  // The third one is the one that escalated, so the record and the prose the
  // agent actually saw agree about the number.
  assert.equal(denies[2]!.repeatCount, 3);
  assert.doesNotMatch(reasons[0] || '', /STOP RETRYING/, 'a first refusal reads exactly as the gate wrote it');
  assert.doesNotMatch(reasons[1] || '', /STOP RETRYING/);
  assert.match(reasons[2] || '', /STOP RETRYING/, 'the third identical refusal says so');
  assert.match(reasons[2] || '', /src\/app\.tsx/, 'and names what is looping');

  // The counted signature is the reason as the GATE rendered it, never the
  // stamped one: the correlation ref appended below carries a hookSeq and a pid,
  // so signing the outgoing text would make every refusal unique and the count
  // could never leave 1. Same for the escalation itself, which is why attempt 4
  // keeps climbing instead of resetting now that attempt 3's text changed.
  const fourth = await runPipeline([denyingGate], ctxFor('PreToolUse', 'Write', cwd));
  assert.equal(fourth.kind === 'deny' ? fourth.reason.includes('4 times') : false, true, `escalation must keep counting: ${JSON.stringify(fourth)}`);

  // An ALLOW in the same project carries no repeatCount: a count belongs to a
  // refusal, and a stale value must not surface on an unrelated later verdict.
  await runPipeline([gate('g', 10, () => context('fyi'))], ctxFor('PreToolUse', 'Read', cwd));
  const allows = readDecisions(cwd, 'run-repeats').filter((record) => record.decision === 'allow');
  assert.deepEqual(allows.map((record) => record.repeatCount), [undefined]);
});

test('stateWrites carries the chokepoint\'s own writes, refusals included', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-writes');
  // A gate that writes state the way every gate does — through fsjson — plus one
  // write the symlink fence must refuse. Before the chokepoint was instrumented
  // neither appeared: `stateWrites` was wired into two call sites only, so every
  // refusal (the event the field exists to explain) went unrecorded.
  const linked = path.join(cwd, '.traffic-one', 'runs', 'run-writes', 'planted.json');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  const outside = path.join(cwd, 'outside.json');
  fs.writeFileSync(outside, '{"keep":true}\n', 'utf8');
  fs.symlinkSync(outside, linked);

  await runPipeline([gate('g', 10, () => {
    writeJson(path.join(cwd, '.traffic-one', 'runs', 'run-writes', 'landed.json'), { ok: true });
    writeJson(linked, { pwned: true });
    return deny('refused', { denyId: 'workspace-boundary-guard' });
  })], ctxFor('PreToolUse', 'Write', cwd));

  const [record] = readDecisions(cwd, 'run-writes');
  const writes = record?.stateWrites ?? [];
  assert.ok(writes.some((write) => write.path.endsWith('landed.json') && write.ok), `the successful write is recorded: ${JSON.stringify(writes)}`);
  const refused = writes.find((write) => write.path.endsWith('planted.json'));
  assert.equal(refused?.ok, false, 'the refusal is recorded');
  assert.equal(refused?.errno, 'symlink', 'and it says WHY it was refused');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"keep":true}\n');
});

test('one invocation\'s state writes never reach the next invocation\'s record', async () => {
  const cwd = freshProjectDir();
  withCurrentRunId(cwd, 'run-drain');
  const write = (name: string): void => {
    writeJson(path.join(cwd, '.traffic-one', 'runs', 'run-drain', name), { ok: true });
  };

  // The buffer behind `stateWrites` is module-level and lives as long as the
  // process, so what makes it safe is being emptied on EVERY runPipeline exit.
  // The drain used to sit inside the record builder, which the pipeline calls
  // only when logging is on — so a logging-off invocation left its writes in the
  // buffer, and the next invocation in the same process reported them as its own.
  // One-shot hook processes hid it; the replay corpus, test:env and doctor's run
  // reconstruction all dispatch more than one hook per process.
  const saved = process.env.T1_DECISION_LOG;
  try {
    process.env.T1_DECISION_LOG = 'false';
    await runPipeline([gate('g', 10, () => { write('logging-off.json'); return context('fyi'); })], ctxFor('PreToolUse', 'Write', cwd));
    assert.deepEqual(readDecisions(cwd, 'run-drain'), [], 'logging off means no record, which is the premise');

    process.env.T1_DECISION_LOG = 'true';
    await runPipeline([gate('g', 10, () => { write('logging-on.json'); return context('fyi'); })], ctxFor('PreToolUse', 'Write', cwd));
  } finally {
    if (saved === undefined) delete process.env.T1_DECISION_LOG; else process.env.T1_DECISION_LOG = saved;
  }

  const [record] = readDecisions(cwd, 'run-drain');
  const paths = (record?.stateWrites ?? []).map((entry) => path.basename(entry.path));
  assert.ok(paths.includes('logging-on.json'), `its own write is there: ${JSON.stringify(paths)}`);
  assert.ok(
    !paths.includes('logging-off.json'),
    `a previous invocation's write was attributed to this one: ${JSON.stringify(paths)}`,
  );
});

test('a decision-log write failure is fail-open: the verdict is unaffected', async () => {
  const cwd = freshProjectDir();
  // `.traffic-one` exists as a FILE, not a directory — every mkdirSync the
  // decision log attempts underneath it fails with ENOTDIR/ENOENT, so this
  // exercises the real fs-failure path, not a mocked one.
  fs.writeFileSync(path.join(cwd, '.traffic-one'), 'not a directory', 'utf8');
  const result = await runPipeline(
    [gate('g', 10, () => deny('blocked regardless'))],
    ctxFor('PreToolUse', 'Bash', cwd),
  );
  assert.equal(result.kind, 'deny');
  if (result.kind === 'deny') {
    // The verdict and its own reason text are untouched; only the log write
    // (which requires a WRITABLE .traffic-one dir) failed underneath it.
    assert.match(result.reason, /^blocked regardless/);
  }
});
