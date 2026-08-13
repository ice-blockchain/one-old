// A gate refuses and prescribes a remedy; nothing in the product has ever
// established whether the remedy was applied. shared/state/deny-expectation.ts
// is the missing half, and this file pins the four properties that make it
// worth having AND the four that keep it from becoming a nuisance.
//
// The pipeline legs are exercised HERE rather than in core/__tests__ because
// they are this module's behaviour: which refusals earn an expectation, which
// event closes one, and which event reports one are all decisions made in
// deny-expectation.ts's header and merely WIRED in core/pipeline.ts. Keeping
// them together is also what lets one file assert the escalation threshold from
// both sides — the deny that does not open an expectation is as load-bearing as
// the one that does.
//
// Every negative assertion below is preceded by the positive it is the absence
// of. A test that only asserts "nothing happened" passes just as happily when
// the machinery it is testing was never reached.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { trackedTempDirs } from '../../../test-support/__tests__/temp-dirs';
import {
  denyExpectationSubject,
  openDenyExpectation,
  satisfyDenyExpectation,
  takeUnmetDenyExpectations,
  unmetDenyExpectationNotice,
} from '../deny-expectation';
import { DENY_REPEAT_ESCALATE_AT } from '../deny-repeat';
import { recordPluginUseChoice } from '../plugin-use';
import { SUBAGENT_STALE_MS } from '../../../config/state';
import { runPipeline } from '../../../core/pipeline';
import { buildContext } from '../../../core/context';
import { deny, noop } from '../../../core/result';
import { toolClassForRawName } from '../../../core/events';
import type { Ctx, Handler, HookInput, HookResult } from '../../../core/types';

// The per-user machine dir is redirected for the life of this file: the consent
// answer this module's fence reads lives there, and an unpinned run would write
// a stray entry into the developer's own ~/.traffic-one/projects/ per test.
// XDG_STATE_HOME rather than TRAFFIC_ONE_PROJECT_PREFS_PATH, so prefs stay keyed
// PER PROJECT — the pending-consent case below rests on one project having no
// answer while its neighbours do. Same reasoning as core/__tests__/pipeline.test.ts.
const dirs = trackedTempDirs('t1-deny-expectation-');
const TMP_ROOT = dirs.make();
const savedStateHome = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = path.join(TMP_ROOT, 'machine-state');
let dirSeq = 0;

after(() => {
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  dirs.cleanup();
});

/** A project that answered "yes" to the use-plugin question. */
function project(): string {
  dirSeq += 1;
  const dir = path.join(TMP_ROOT, `p${dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  recordPluginUseChoice(dir, true, 'test');
  return dir;
}

/**
 * A project that has not answered it, with the ask-first question ON for the
 * duration of `body`. The write fence then refuses everything under its
 * `.traffic-one/`, which is the byte-identity half of the product contract.
 *
 * The local pin is required rather than tidy: src/build/test-preload.mjs sets
 * TRAFFIC_ONE_ASK_USE_PLUGIN=0 for the whole suite (a fixture project means "a
 * project the user already said yes to"), so without it this test would
 * characterize a WRITABLE project and pass for the wrong reason. Same pin the
 * five existing fence tests its comment names already apply.
 */
function withPendingProject(body: (cwd: string) => void): void {
  dirSeq += 1;
  const dir = path.join(TMP_ROOT, `pending${dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const saved = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  try {
    body(dir);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = saved;
  }
}

function ledgerFile(cwd: string): string {
  return path.join(cwd, '.traffic-one', 'debug', 'deny-expectations.json');
}

function readLedger(cwd: string): Record<string, { denyId: string; at: string; runId: string }> {
  try {
    return JSON.parse(fs.readFileSync(ledgerFile(cwd), 'utf8')) as Record<string, { denyId: string; at: string; runId: string }>;
  } catch {
    return {};
  }
}

/** Write the ledger straight to disk, past the fence — a fixture, not a writer. */
function seedLedger(cwd: string, value: Record<string, { denyId: string; at: string; runId: string }>): void {
  fs.mkdirSync(path.dirname(ledgerFile(cwd)), { recursive: true });
  fs.writeFileSync(ledgerFile(cwd), `${JSON.stringify(value, null, 2)}\n`);
}

function stampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── the unit half ───────────────────────────────────────────────────────────

test('an expectation opens, survives, and is closed by the subject completing', () => {
  const cwd = project();
  const subject = 'apps/web/src/pages/Home.tsx';

  assert.equal(
    openDenyExpectation(cwd, 'R1', subject, 'frontend-collapse-gate'),
    true,
    'PRECONDITION: the record must actually persist, or every assertion below is about an empty file',
  );
  assert.deepEqual(Object.keys(readLedger(cwd)), [subject], 'the ledger is keyed by the refused subject');
  assert.equal(readLedger(cwd)[subject]?.denyId, 'frontend-collapse-gate', 'the declared cause is carried for the report');

  // An unrelated action completing leaves it alone — the detector must not
  // discharge a remedy because SOMETHING succeeded.
  assert.equal(satisfyDenyExpectation(cwd, 'apps/web/src/pages/Settings.tsx'), 'none');
  assert.deepEqual(Object.keys(readLedger(cwd)), [subject], 'an unrelated completion closes nothing');

  assert.equal(satisfyDenyExpectation(cwd, subject), 'closed', 'the same subject completing closes it');
  assert.deepEqual(readLedger(cwd), {}, 'a closed expectation is gone, not flagged');
  assert.equal(satisfyDenyExpectation(cwd, subject), 'none', 'and closing it twice is not an error');
});

test('two gates refusing one subject are one remedy, and one completion clears both', () => {
  const cwd = project();
  const subject = 'apps/web/src/App.tsx';
  assert.equal(openDenyExpectation(cwd, 'R1', subject, 'frontend-collapse-gate'), true);
  assert.equal(openDenyExpectation(cwd, 'R1', subject, 'component-placement'), true);
  assert.equal(
    Object.keys(readLedger(cwd)).length,
    1,
    'the subject is the key: a second gate refusing the same file is the same outstanding remedy, not a second entry',
  );
  assert.equal(readLedger(cwd)[subject]?.denyId, 'component-placement', 're-opening refreshes the cause');
  assert.equal(satisfyDenyExpectation(cwd, subject), 'closed');
  assert.deepEqual(readLedger(cwd), {}, 'one completed call clears everything that was refusing that subject');
});

test('the subject is the file path, then the command, then nothing at all', () => {
  assert.equal(denyExpectationSubject({ filePath: 'src/a.ts', command: 'npm test' }), 'src/a.ts', 'a path wins over a command');
  assert.equal(denyExpectationSubject({ command: '  npm run deploy  ' }), 'npm run deploy', 'a shell refusal is keyed by its command');
  assert.equal(denyExpectationSubject({}), '', 'a refusal with no recognisable action gets no expectation');
  assert.equal(denyExpectationSubject(undefined), '', 'and neither does an event with no tool');
  assert.equal(
    denyExpectationSubject({ filePath: 'x'.repeat(400) }).length < 400,
    true,
    'a subject is bounded by the same shrink() contract every capture in this directory uses',
  );
});

test('a report discharges what it reports, exactly once', () => {
  const cwd = project();
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/a.ts', 'no-any'), true);
  assert.equal(openDenyExpectation(cwd, 'R1', 'npm run build', 'run-team-shell'), true);

  const unmet = takeUnmetDenyExpectations(cwd);
  assert.deepEqual(
    unmet.map((entry) => entry.subject).sort(),
    ['npm run build', 'src/a.ts'],
    'every outstanding expectation is handed over',
  );
  assert.deepEqual(readLedger(cwd), {}, 'and removed, so the same remedy is never reported twice');
  assert.deepEqual(takeUnmetDenyExpectations(cwd), [], 'a second prompt reports nothing');

  const notice = unmetDenyExpectationNotice(unmet);
  assert.match(notice, /src\/a\.ts/, 'the notice names what was never resolved');
  assert.match(notice, /Nothing is blocked/, 'and says so, because a report that reads like a refusal is a refusal');
  assert.match(notice, /BLOCKED/, 'it offers the honest exit the escalation already named');
  assert.equal(unmetDenyExpectationNotice([]), '', 'an empty set says nothing');
});

// ── the bound ───────────────────────────────────────────────────────────────

test('an expectation older than SUBAGENT_STALE_MS is reclaimed, and so is one no clock could have stamped', () => {
  const cwd = project();
  seedLedger(cwd, {
    fresh: { denyId: 'no-any', at: stampAgo(60_000), runId: 'R1' },
    stale: { denyId: 'no-any', at: stampAgo(SUBAGENT_STALE_MS + 60_000), runId: 'R1' },
    future: { denyId: 'no-any', at: new Date(Date.now() + (48 * 60 * 60 * 1000)).toISOString(), runId: 'R1' },
    unparseable: { denyId: 'no-any', at: 'not-a-date', runId: 'R1' },
  });
  assert.deepEqual(
    takeUnmetDenyExpectations(cwd).map((entry) => entry.subject),
    ['fresh'],
    'only a live expectation is reported; age, a stepped clock and an unusable stamp all reclaim',
  );
});

test('the ledger is capped at the bound deny-repeat puts on the table it is a subset of', () => {
  const cwd = project();
  const seeded: Record<string, { denyId: string; at: string; runId: string }> = {};
  for (let i = 0; i < 70; i += 1) {
    seeded[`src/f${String(i).padStart(3, '0')}.ts`] = { denyId: 'no-any', at: stampAgo(70_000 - (i * 1_000)), runId: 'R1' };
  }
  seedLedger(cwd, seeded);
  assert.equal(Object.keys(readLedger(cwd)).length, 70, 'PRECONDITION: the fixture really is over the cap');

  // READ side. An over-cap ledger can exist without this module having written
  // it — a hand edit, a wider cap in an older build — so the cap has to hold on
  // the way OUT too, or the report is the unbounded thing.
  const reported = takeUnmetDenyExpectations(cwd).map((entry) => entry.subject);
  assert.equal(reported.length, 64, 'a report read out of an over-cap ledger is capped as well');
  assert.ok(reported.includes('src/f069.ts'), 'the FRESHEST expectations are the ones kept');
  assert.ok(!reported.includes('src/f000.ts'), 'and the oldest, the entry the age sweep was about to take, is the one dropped');

  // WRITE side.
  seedLedger(cwd, seeded);
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/newest.ts', 'no-any'), true);
  const kept = Object.keys(readLedger(cwd));
  assert.equal(kept.length, 64, 'the ledger cannot grow past 64 entries');
  assert.ok(kept.includes('src/newest.ts'), 'the entry just opened survives its own eviction pass');
  assert.ok(!kept.includes('src/f000.ts'), 'and the oldest is the one that goes');
});

test('refreshing a subject already in a full ledger costs no slot, so it evicts nobody', () => {
  const cwd = project();
  const seeded: Record<string, { denyId: string; at: string; runId: string }> = {};
  for (let i = 0; i < 64; i += 1) {
    seeded[`src/f${String(i).padStart(3, '0')}.ts`] = { denyId: 'no-any', at: stampAgo(70_000 - (i * 1_000)), runId: 'R1' };
  }
  seedLedger(cwd, seeded);
  assert.equal(Object.keys(readLedger(cwd)).length, 64, 'PRECONDITION: the fixture is exactly at the cap');

  // A subject from the MIDDLE: re-opening the oldest one would hide the bug,
  // because the slot the cap drops would be that same entry's stale copy.
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/f032.ts', 'component-placement'), true);
  const kept = Object.keys(readLedger(cwd));
  assert.equal(kept.length, 64, 'the fourth refusal of a file already in the ledger is the same outstanding remedy, not a new entry');
  assert.ok(kept.includes('src/f000.ts'), 'so refreshing one subject must not evict an unrelated one');
  assert.equal(readLedger(cwd)['src/f032.ts']?.denyId, 'component-placement', 'and the refresh is what survives');
});

// ── the fence ───────────────────────────────────────────────────────────────

test('a project whose use-plugin question is unanswered gets no ledger and no report', () => {
  // The positive first, on a project that DID answer: without it "nothing was
  // written" is satisfied just as well by a writer that never ran.
  const answered = project();
  assert.equal(openDenyExpectation(answered, 'R1', 'src/a.ts', 'no-any'), true, 'PRECONDITION: this writer does write');

  withPendingProject((cwd) => {
    assert.equal(
      openDenyExpectation(cwd, 'R1', 'src/a.ts', 'no-any'),
      false,
      'the consent fence refuses the write and the refusal is ANSWERED, not swallowed',
    );
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'the project stays byte-identical');
    assert.deepEqual(takeUnmetDenyExpectations(cwd), [], 'and there is nothing to report');
  });
});

test('a refused discharge reports nothing rather than reporting forever', () => {
  const cwd = project();
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/a.ts', 'no-any'), true);
  assert.equal(takeUnmetDenyExpectations(cwd).length, 1, 'PRECONDITION: it is reportable while the path is ordinary');

  // MOVE-ASIDE-PLUS-LINK, not a dangling link: `takeUnmetDenyExpectations` READS
  // the ledger before it writes, and reads deliberately follow symlinks. The
  // bytes therefore have to stay reachable through the link while the write is
  // refused for the link's own sake (fsjson.ts's isSymlink pre-check).
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/b.ts', 'no-any'), true);
  const real = `${ledgerFile(cwd)}.moved`;
  fs.renameSync(ledgerFile(cwd), real);
  fs.symlinkSync(real, ledgerFile(cwd));

  assert.equal(
    JSON.parse(fs.readFileSync(ledgerFile(cwd), 'utf8')).hasOwnProperty('src/b.ts'),
    true,
    'PRECONDITION: the entry is still READABLE through the link, so an empty answer means the WRITE was refused',
  );
  assert.deepEqual(
    takeUnmetDenyExpectations(cwd),
    [],
    'a discharge that did not persist hands back nothing, so the notice is never emitted twice',
  );
  assert.equal(satisfyDenyExpectation(cwd, 'src/b.ts'), 'refused', 'and a close through the same link says refused, not closed');
});

// ── the pipeline legs ───────────────────────────────────────────────────────

function ctxFor(cwd: string, event: HookInput['event'], tool?: { rawName: string; filePath?: string; command?: string }): Ctx {
  const input: HookInput = {
    event,
    host: 'claude',
    cwd,
    raw: {},
    ...(tool
      ? {
        tool: {
          class: toolClassForRawName(tool.rawName),
          rawName: tool.rawName,
          ...(tool.filePath ? { filePath: tool.filePath } : {}),
          ...(tool.command ? { command: tool.command } : {}),
        },
      }
      : {}),
  };
  return buildContext(input);
}

function denyingHandler(reason: string): Handler {
  return {
    id: 'test.gate',
    event: 'PreToolUse',
    priority: 10,
    run: (): HookResult => deny(reason, { denyId: 'no-any', denyTarget: 'src/a.ts' }),
  };
}

async function refuse(cwd: string, times: number, reason = 'Structural gate: no `any`. Fix it, then re-issue.'): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await runPipeline([denyingHandler(reason)], ctxFor(cwd, 'PreToolUse', { rawName: 'Write', filePath: 'src/a.ts' }));
  }
}

test('the pipeline opens an expectation only once the refusal ESCALATES', async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'R1' }));

  await refuse(cwd, DENY_REPEAT_ESCALATE_AT - 1);
  assert.deepEqual(
    readLedger(cwd),
    {},
    'a first or second refusal prescribes nothing, so it records nothing — the population is bounded here, not by a list',
  );

  await refuse(cwd, 1);
  assert.deepEqual(
    Object.keys(readLedger(cwd)),
    ['src/a.ts'],
    'the third byte-identical refusal is the one that says STOP RETRYING, and that is the one that earns an expectation',
  );
});

test('a refusal with no recognisable action never earns an expectation, however often it repeats', async () => {
  const cwd = project();
  // The `.one.json` is load-bearing, not scaffolding: deny-repeat.ts counts per
  // RUN, so without a current run every refusal is the first one and the count
  // never reaches DENY_REPEAT_ESCALATE_AT. An earlier draft of this test omitted
  // it and passed while the open leg was unreachable — measured directly: with a
  // run id the counts are [1,2,3,4,5], without one they are [1,1,1,1,1].
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'R1' }));

  const spawnDeny: Handler = {
    id: 'test.spawn',
    event: 'PreToolUse',
    priority: 10,
    run: (): HookResult => deny('Spawn refused: the role is held.', { denyId: 'agent-reuse-continue', denyTarget: 'senior-frontend' }),
  };
  for (let i = 0; i < DENY_REPEAT_ESCALATE_AT + 2; i += 1) {
    await runPipeline([spawnDeny], ctxFor(cwd, 'PreToolUse', { rawName: 'Task' }));
  }
  assert.deepEqual(
    readLedger(cwd),
    {},
    'satisfaction is observed by seeing the action complete, so a refusal with no action would be unsatisfiable by construction',
  );

  // The positive control, in the SAME project and past the SAME threshold: it
  // is the subject that is missing, not the escalation.
  await refuse(cwd, DENY_REPEAT_ESCALATE_AT);
  assert.deepEqual(
    Object.keys(readLedger(cwd)),
    ['src/a.ts'],
    'PRECONDITION-BY-CONTRAST: a subject-bearing refusal in this very project does earn one, so the empty ledger above is the exclusion and not an unreached code path',
  );
});

test('a PostToolUse for the same subject closes it; the allow path never touches the ledger', async () => {
  const cwd = project();
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/a.ts', 'no-any'), true);

  const allow: Handler = { id: 'test.allow', event: 'PreToolUse', priority: 10, run: (): HookResult => noop() };
  await runPipeline([allow], ctxFor(cwd, 'PreToolUse', { rawName: 'Write', filePath: 'src/a.ts' }));
  assert.deepEqual(
    Object.keys(readLedger(cwd)),
    ['src/a.ts'],
    'PRECONDITION: a PreToolUse allow leaves it open — the close is on the post event, which is what keeps the 150 ms budget path free of this',
  );

  await runPipeline([], ctxFor(cwd, 'PostToolUse', { rawName: 'Write', filePath: 'src/a.ts' }));
  assert.deepEqual(readLedger(cwd), {}, 'the completed call proves the gate stopped objecting');
});

test('an unmet expectation is reported as CONTEXT at the next user prompt, and never as a deny', async () => {
  const cwd = project();
  assert.equal(openDenyExpectation(cwd, 'R1', 'src/a.ts', 'frontend-collapse-gate'), true);

  const result = await runPipeline([], ctxFor(cwd, 'UserPromptSubmit'));
  assert.equal(result.kind, 'context', 'a detector that denied could wedge the agent that obeyed the escalation');
  assert.match(
    result.kind === 'context' ? result.context : '',
    /src\/a\.ts/,
    'the report names the refusal whose remedy was never applied',
  );
  assert.deepEqual(readLedger(cwd), {}, 'and reporting discharges it');

  const second = await runPipeline([], ctxFor(cwd, 'UserPromptSubmit'));
  assert.equal(second.kind, 'noop', 'the next prompt is silent — this must not become a per-prompt nag');
});

test('an expectation the agent satisfied is never reported', async () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'R1' }));

  await refuse(cwd, DENY_REPEAT_ESCALATE_AT);
  assert.deepEqual(Object.keys(readLedger(cwd)), ['src/a.ts'], 'PRECONDITION: the refusal escalated and was recorded');

  await runPipeline([], ctxFor(cwd, 'PostToolUse', { rawName: 'Write', filePath: 'src/a.ts' }));
  const result = await runPipeline([], ctxFor(cwd, 'UserPromptSubmit'));
  assert.equal(
    result.kind,
    'noop',
    'the whole point: a remedy that WAS applied produces no report, so the report means what it says',
  );
});
