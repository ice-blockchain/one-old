// Coverage for the decision log itself (appendDecision/readDecisions/
// nextHookSeq/decisionLoggingEnabled) — see decision-log.ts's header for the
// design rationale each test below is protecting.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
  DECISION_LOG_MAX_BYTES,
  appendDecision,
  buildCorrelationId,
  decisionLoggingEnabled,
  nextHookSeq,
  readDecisions,
  type DecisionRecord,
} from '../decision-log';
import { recordPluginUseChoice } from '../plugin-use';
import { drainStateWrites, type StateWriteRecord } from '../state-write-log';

// This file characterizes the ask-first FENCE, so it pins the question on rather
// than inheriting it: the suite preload (src/build/test-preload.mjs) turns it off
// by default so a bare mkdtemp fixture reads as a consented project.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';

// Ask-first is on by default (config/onboarding.ts ASK_USE_PLUGIN_FIRST), and
// the log obeys projectWritesPermitted — so a project that never answered gets
// no files at all. Every test below about log MECHANICS therefore records
// consent first, exactly as a real logging project has; the fence itself is
// covered separately at the bottom of this file.
// One registry, one sweep, and every fixture dir enters it the instant it exists.
// The per-call `finally` below still removes each tree eagerly (so a full run
// never holds more than one at a time); this is the backstop for the paths a
// `finally` cannot cover — anything that throws BETWEEN mkdtemp and the try, as
// the consent write two lines down would.
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempProjectDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function withProject(fn: (cwd: string) => void): void {
  const cwd = tempProjectDir('t1-decision-log-');
  recordPluginUseChoice(cwd, true, 'test');
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function withUndecidedProject(fn: (cwd: string) => void): void {
  const cwd = tempProjectDir('t1-decision-log-undecided-');
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function baseRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: new Date().toISOString(),
    correlationId: buildCorrelationId('r1', 1, process.pid),
    runId: 'r1',
    hookSeq: 1,
    pid: process.pid,
    event: 'PreToolUse',
    host: 'claude',
    decision: 'allow',
    inputs: {},
    stateWrites: [],
    ...overrides,
  };
}

test('appendDecision + readDecisions round-trip a well-formed record', () => {
  withProject((cwd) => {
    appendDecision(cwd, baseRecord({ decision: 'deny', gateId: 'g', denyId: 'workspace-boundary-guard', denyTarget: 'x.ts' }));
    const records = readDecisions(cwd, 'r1');
    assert.equal(records.length, 1);
    assert.equal(records[0]!.decision, 'deny');
    assert.equal(records[0]!.gateId, 'g');
    assert.equal(records[0]!.denyId, 'workspace-boundary-guard');
    assert.equal(records[0]!.denyTarget, 'x.ts');
    assert.equal(records[0]!.correlationId, 'r1:1:' + process.pid);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'r1', 'debug', 'decisions.jsonl')));
  });
});

test('a null runId writes to the project-level debug log, not a run directory', () => {
  withProject((cwd) => {
    appendDecision(cwd, baseRecord({ runId: null, correlationId: buildCorrelationId(null, 1, process.pid) }));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'debug', 'decisions.jsonl')));
    assert.ok(!fs.existsSync(path.join(cwd, '.traffic-one', 'runs')));
  });
});

test('buildCorrelationId shape: "<runId>:<hookSeq>:<pid>", with "no-run" standing in for no run', () => {
  assert.equal(buildCorrelationId('run-1', 7, 4242), 'run-1:7:4242');
  // A word, not `null`: this ref is appended verbatim to user-facing deny text.
  assert.equal(buildCorrelationId(null, 1, 4242), 'no-run:1:4242');
  assert.doesNotMatch(buildCorrelationId(null, 1, 4242), /null/);
});

test('readDecisions tolerates a missing file, a truncated trailing line, and an unparseable line', () => {
  withProject((cwd) => {
    assert.deepEqual(readDecisions(cwd, 'absent-run'), []);

    appendDecision(cwd, baseRecord({ runId: 'r2', hookSeq: 1, correlationId: buildCorrelationId('r2', 1, process.pid) }));
    appendDecision(cwd, baseRecord({ runId: 'r2', hookSeq: 2, correlationId: buildCorrelationId('r2', 2, process.pid) }));
    const file = path.join(cwd, '.traffic-one', 'runs', 'r2', 'debug', 'decisions.jsonl');
    // A truncated final line (the exact shape a killed hook process leaves
    // behind — cut off mid-write) and an unrelated garbage line, both
    // appended AFTER the two well-formed records above.
    fs.appendFileSync(file, 'not json at all\n{"correlationId":"r2:3', 'utf8');

    const records = readDecisions(cwd, 'r2');
    assert.equal(records.length, 2); // both well-formed lines; the corrupt trailer is skipped
    assert.deepEqual(records.map((r) => r.hookSeq), [1, 2]);
  });
});

test('readDecisions skips a well-formed JSON line missing required fields', () => {
  withProject((cwd) => {
    const dir = path.join(cwd, '.traffic-one', 'runs', 'r3', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'), `${JSON.stringify({ decision: 'deny' })}\n`, 'utf8');
    assert.deepEqual(readDecisions(cwd, 'r3'), []);
  });
});

test('the log is bounded: exceeding the byte cap drops the OLDEST records and keeps the NEWEST', () => {
  withProject((cwd) => {
    // Wide flat objects survive shrink() with every key intact (only string
    // VALUES and depth/array-length are capped) — a cheap way to author
    // records of a known, substantial size without inflating any one field
    // past shrink's own truncation.
    const padding = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 'x'.repeat(200)]));
    const total = Math.ceil((DECISION_LOG_MAX_BYTES * 1.5) / 13_000); // ~13 KB/record
    for (let i = 1; i <= total; i += 1) {
      appendDecision(cwd, baseRecord({
        hookSeq: i,
        correlationId: buildCorrelationId('big-run', i, process.pid),
        runId: 'big-run',
        inputs: padding,
      }));
    }
    const file = path.join(cwd, '.traffic-one', 'runs', 'big-run', 'debug', 'decisions.jsonl');
    const size = fs.statSync(file).size;
    assert.ok(size <= DECISION_LOG_MAX_BYTES, `expected trimmed file <= ${DECISION_LOG_MAX_BYTES} bytes, got ${size}`);

    const records = readDecisions(cwd, 'big-run');
    assert.ok(records.length > 0);
    // The newest record (the very last one appended) must have survived.
    assert.equal(records[records.length - 1]!.hookSeq, total);
    // Some earliest record must have been evicted — the whole point of the test.
    assert.ok(records[0]!.hookSeq > 1, 'the oldest record should have been trimmed away');
    // What remains is still a contiguous, strictly increasing tail.
    const seqs = records.map((r) => r.hookSeq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });
});

test('decisionLoggingEnabled honours T1_DECISION_LOG (unset/anything else = on; off/false/0 = off)', () => {
  const saved = process.env.T1_DECISION_LOG;
  try {
    delete process.env.T1_DECISION_LOG;
    assert.equal(decisionLoggingEnabled(), true);
    for (const off of ['off', 'false', '0', 'OFF', 'False']) {
      process.env.T1_DECISION_LOG = off;
      assert.equal(decisionLoggingEnabled(), false, `expected T1_DECISION_LOG=${off} to disable`);
    }
    for (const on of ['true', '1', 'on', 'yes']) {
      process.env.T1_DECISION_LOG = on;
      assert.equal(decisionLoggingEnabled(), true, `expected T1_DECISION_LOG=${on} to stay enabled`);
    }
  } finally {
    if (saved === undefined) delete process.env.T1_DECISION_LOG; else process.env.T1_DECISION_LOG = saved;
  }
});

test('appendDecision/nextHookSeq no-op inside a non-project root without throwing', () => {
  const tmpRootExact = fs.realpathSync(os.tmpdir());
  assert.doesNotThrow(() => appendDecision(tmpRootExact, baseRecord()));
  assert.doesNotThrow(() => nextHookSeq(tmpRootExact, 'r1'));
  assert.ok(!fs.existsSync(path.join(tmpRootExact, '.traffic-one')));
});

test('nextHookSeq is strictly monotonic and gapless within one run, sequentially', () => {
  withProject((cwd) => {
    const seqs = Array.from({ length: 10 }, () => nextHookSeq(cwd, 'seq-run'));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // A DIFFERENT run gets its own counter, starting over — a loop/sequence
    // is a property of one run, same convention as deny-repeat.ts's counters.
    assert.equal(nextHookSeq(cwd, 'other-run'), 1);
  });
});

function runSeqChild(scriptPath: string, cwd: string, runId: string, count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, cwd, runId, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`child exited ${code}: ${err}`)); return; }
      try { resolve(JSON.parse(out) as number[]); } catch (error) { reject(error as Error); }
    });
  });
}

test('nextHookSeq is monotonic and collision-free across two concurrent hook PROCESSES', async () => {
  await withProjectAsync(async (cwd) => {
    const scriptPath = path.join(cwd, 'seq-child.ts');
    const modulePath = path.resolve(__dirname, '..', 'decision-log').replace(/\\/g, '/');
    fs.writeFileSync(scriptPath, [
      `import { nextHookSeq } from '${modulePath}';`,
      'const [, , root, runId, countRaw] = process.argv;',
      'const count = Number(countRaw);',
      'const out: number[] = [];',
      'for (let i = 0; i < count; i += 1) out.push(nextHookSeq(root, runId));',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n'), 'utf8');

    const perProcess = 25;
    const [a, b] = await Promise.all([
      runSeqChild(scriptPath, cwd, 'concurrent-run', perProcess),
      runSeqChild(scriptPath, cwd, 'concurrent-run', perProcess),
    ]);
    assert.equal(a.length, perProcess);
    assert.equal(b.length, perProcess);
    const all = [...a, ...b].sort((x, y) => x - y);
    // Two independent OS processes, sharing only the on-disk lock: the union
    // of both sequences must be exactly 1..2*perProcess with no gap and no
    // collision — a strictly stronger claim than "increasing", and one that
    // only holds if the cross-process lock actually serialized every
    // increment (see decision-log.ts's nextHookSeq doc for what happens
    // instead when the lock is contended past its timeout).
    assert.deepEqual(all, Array.from({ length: perProcess * 2 }, (_, i) => i + 1));
  });
});

async function withProjectAsync(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = tempProjectDir('t1-decision-log-async-');
  recordPluginUseChoice(cwd, true, 'test');
  try { await fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

// ── the consent write fence ──────────────────────────────────────────────────
// The log is on by default and runs on EVERY hook, which makes it the surface
// most likely to breach the product contract that an undecided or declined
// project stays byte-identical. It did: nextHookSeq's counter file created
// `.traffic-one/` before the user had answered the use-plugin question, which
// surfaced as a windsurf ask-first regression. These two tests are the ones
// that would have caught it directly.

test('an UNDECIDED project gets no decision-log files at all — not even the hookSeq counter', () => {
  withUndecidedProject((cwd) => {
    const seq = nextHookSeq(cwd, 'r1');
    appendDecision(cwd, baseRecord());
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'the project must stay byte-identical until the question is answered');
    assert.equal(readDecisions(cwd, 'r1').length, 0);
    // The hook still works: a correlation id is minted from the in-process
    // ordinal, so the deny text keeps its ref even with nothing persisted.
    assert.ok(Number.isInteger(seq) && seq > 0);
  });
});

test('a DECLINED project gets no decision-log files either', () => {
  withUndecidedProject((cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    nextHookSeq(cwd, 'r1');
    appendDecision(cwd, baseRecord());
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'a decline leaves the project untouched');
  });
});

// The two above assert the OUTCOME — nothing on disk — and that is deliberately
// insensitive to WHICH of the two fences produced it: measured, both survive
// deleting this module's own consent checks outright, because the path fence in
// shared/fsjson.ts then refuses every write they would have made.
//
// That redundancy is the design (plugin-use.ts: "the second lock on the same
// door"), and it is also why nothing pinned THIS half. nextHookSeq's own check
// was killed by nothing in the whole suite. What it protects is not the write —
// the path fence has that — but the two things that happen on the way to a write
// that never lands: a cross-process lock acquisition attempted on EVERY hook
// event of every pending project, and a correlation id minted from `Date.now()`
// instead of the documented in-process ordinal, i.e. a 13-digit number in text
// shown to a user.
test('an UNDECIDED project stands DOWN in nextHookSeq rather than reaching a write the fence then refuses', () => {
  withUndecidedProject((cwd) => {
    drainStateWrites(); // the collector is per-process; earlier tests have used it

    const first = nextHookSeq(cwd, 'r1');
    const second = nextHookSeq(cwd, 'r1');

    // The in-process ordinal, not the `Date.now()`-scale fallback a refused
    // counter persist takes. Magnitude is what separates them: an ordinal counts
    // this process's calls, a timestamp is epoch milliseconds.
    for (const seq of [first, second]) {
      assert.ok(
        Number.isInteger(seq) && seq > 0 && seq < 1_000_000,
        `expected the in-process ordinal, got ${seq} — that is the Date.now() fallback, so the pending check was skipped and the lock/persist path ran`,
      );
    }
    assert.equal(second, first + 1, 'and it is still a sequence');
    // Not one state write was ATTEMPTED, refused or otherwise. The lock dir this
    // would have tried to create is under `.traffic-one/`, so a refusal leaves
    // nothing on disk to notice — the collector is the only place it is visible.
    assert.deepEqual(
      drainStateWrites(), [],
      'a pending project must not reach the chokepoint at all, not even to be refused',
    );
  });
});

// ── a REFUSED counter write is not a sequence ────────────────────────────────

test('nextHookSeq never re-mints a number when its counter write was refused', () => {
  withProject((cwd) => {
    // The counter file is a symlink, so fsjson refuses the persist while the
    // lock is acquired perfectly normally — the one case where `seq` is computed
    // and cannot be trusted. writeJson used to return `void`, so this was
    // indistinguishable from a durable write: both calls read base 0, both
    // returned 1, and two hook invocations claimed one correlation id in the log
    // an operator was reading precisely to tell them apart.
    const dir = path.join(cwd, '.traffic-one', 'runs', 'refused-run', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(cwd, 'outside-seq.json');
    fs.writeFileSync(outside, '{"seq":41}\n', 'utf8');
    fs.symlinkSync(outside, path.join(dir, 'decisions.seq.json'));

    const first = nextHookSeq(cwd, 'refused-run');
    const second = nextHookSeq(cwd, 'refused-run');
    assert.notEqual(first, second, 'a refused counter must never hand out the same number twice');
    assert.ok(Number.isInteger(first) && first > 0 && Number.isInteger(second) && second > 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), '{"seq":41}\n', 'and nothing was written through the link');

    // The healthy path still persists and still counts, in the same project.
    assert.deepEqual([nextHookSeq(cwd, 'ok-run'), nextHookSeq(cwd, 'ok-run')], [1, 2]);
  });
});

// ── …and neither is a counter it cannot READ ─────────────────────────────────
// The same incident from the other side. `readJson(file, {})` answered a counter
// file that is present and unreadable with the `{}` it answers an absent one
// with, so `base` fell to 0 and `seq` restarted at 1 — and, because the persist
// then SUCCEEDED, the file was healed to `{"seq":1}` and the whole earlier
// sequence was replayed number for number, not just one value duplicated.

test('nextHookSeq never restarts its sequence over a counter file it cannot read', () => {
  withProject((cwd) => {
    const dir = path.join(cwd, '.traffic-one', 'runs', 'degraded-run', 'debug');
    const file = path.join(dir, 'decisions.seq.json');
    assert.deepEqual(
      [nextHookSeq(cwd, 'degraded-run'), nextHookSeq(cwd, 'degraded-run'), nextHookSeq(cwd, 'degraded-run')],
      [1, 2, 3],
      'fixture: the persisted path really ran, so 1..3 are ids an operator has already seen',
    );

    const torn = '{"seq":';
    fs.writeFileSync(file, torn, 'utf8');
    const afterCorrupt = nextHookSeq(cwd, 'degraded-run');
    assert.ok(
      afterCorrupt > 3,
      `expected a number no earlier invocation minted, got ${afterCorrupt} — the sequence restarted`,
    );
    // Magnitude is what separates the two channels, exactly as the pending-project
    // row above uses it: an ordinal counts calls, the documented fallback is epoch
    // milliseconds.
    assert.ok(afterCorrupt > 1_000_000_000_000, 'and it is the documented fallback, not a fresh small counter');
    assert.equal(fs.readFileSync(file, 'utf8'), torn, 'the unparseable bytes are left in place, not replaced by a `1`');

    // A directory, not a chmod: EISDIR is `unreadable` for every user including
    // root, while a 000 mode is read straight through by a root test runner.
    fs.rmSync(file);
    fs.mkdirSync(file);
    const afterUnreadable = nextHookSeq(cwd, 'degraded-run');
    assert.ok(afterUnreadable > 1_000_000_000_000, `expected the fallback, got ${afterUnreadable}`);
    assert.notEqual(afterUnreadable, afterCorrupt);

    // The healthy path in the same project still counts from its own base.
    assert.deepEqual([nextHookSeq(cwd, 'ok-run'), nextHookSeq(cwd, 'ok-run')], [1, 2]);
  });
});

// ── the trim is a write and a delete, so it obeys the same fences ────────────

test('an oversized decisions.jsonl that is a SYMLINK is never trimmed or appended through', () => {
  withProject((cwd) => {
    const dir = path.join(cwd, '.traffic-one', 'runs', 'trim-run', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    // The link target is over the byte cap, so statSync (which follows) triggers
    // the trim — the code path that used to be a raw writeFileSync + renameSync
    // and so bypassed both fences entirely.
    const outside = path.join(cwd, 'outside-log.jsonl');
    const line = `${JSON.stringify({ filler: 'x'.repeat(200) })}\n`;
    fs.writeFileSync(outside, line.repeat(Math.ceil((DECISION_LOG_MAX_BYTES + 1024) / line.length)), 'utf8');
    const before = fs.statSync(outside).size;
    assert.ok(before > DECISION_LOG_MAX_BYTES, 'the fixture must actually be over the cap');
    fs.symlinkSync(outside, path.join(dir, 'decisions.jsonl'));

    drainStateWrites(); // the collector is per-process and earlier tests have used it
    appendDecision(cwd, baseRecord({ runId: 'trim-run', correlationId: buildCorrelationId('trim-run', 1, process.pid) }));

    assert.equal(fs.statSync(outside).size, before, 'the file behind the link was neither trimmed nor appended to');
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp')).length, 0, 'no temp file was left behind');
    // The raw fs.writeFileSync + fs.renameSync this replaced left the first two
    // assertions above TRUE and still lost: `rename` REPLACES a destination link
    // rather than writing through it, so the trimmed copy of the link target
    // landed in the project as a regular file and the link silently vanished.
    const link = path.join(dir, 'decisions.jsonl');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is left exactly as it was, not replaced by a regular file');
    assert.equal(fs.readlinkSync(link), outside, 'and still points where it did');
    // Nothing derived from the link target may be written at ALL, not even
    // transiently: the trim reads its destination, so a refusal that arrives only
    // at the final move has already copied ~1MB of whatever the link pointed at
    // into a temp file inside the project. That file is then cleaned up, so the
    // tree cannot show it after the fact — the recorded writes are what make it
    // visible, and a refused trim must leave nothing but refusals behind.
    const wrote = drainStateWrites().filter((record) => record.ok);
    assert.deepEqual(wrote, [], 'a refused trim performed a write anyway');
  });
});

// ── the ref names a place that exists ────────────────────────────────────────

test('the correlation ref and the log directory agree, even for a run id that is not a safe path segment', () => {
  withProject((cwd) => {
    // `currentRunId` is read back off `.traffic-one/.one.json`, a file a cloned
    // repo ships, so it is not trusted input. The ref used to echo it raw: the
    // text handed to the user named a directory that does not exist, and could
    // carry path separators.
    const hostile = '../../etc/run 1';
    const id = buildCorrelationId(hostile, 7, 4242);
    assert.equal(id, '.._.._etc_run_1:7:4242');
    assert.doesNotMatch(id, /[/\\]/, 'a ref shown to a user must never contain a path separator');

    appendDecision(cwd, baseRecord({ runId: hostile, correlationId: id }));
    const segment = id.split(':')[0]!;
    const file = path.join(cwd, '.traffic-one', 'runs', segment, 'debug', 'decisions.jsonl');
    assert.ok(fs.existsSync(file), 'the directory the ref names is the directory the record landed in');
    const [record] = readDecisions(cwd, hostile);
    assert.equal(record?.runId, segment, 'the record agrees with its own ref rather than echoing the raw id');

    // A run id that sanitizes away to nothing is not a run id: it takes the
    // project-level bucket rather than producing `runs//debug`.
    assert.equal(buildCorrelationId('   ', 1, 42), 'no-run:1:42');
    appendDecision(cwd, baseRecord({ runId: '   ', correlationId: buildCorrelationId('   ', 1, 42) }));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'debug', 'decisions.jsonl')));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'debug')), false);
  });
});

// ── stateWrites: the refusals are what must survive the bound ────────────────

test('the stateWrites bound drops successes before refusals', () => {
  withProject((cwd) => {
    // 60 writes in one hook call is ordinary once the chokepoint is instrumented
    // (a materialization is ~190), and the two that were REFUSED are the only
    // ones an operator cannot reconstruct from the tree on disk. A plain
    // "keep the first 31" threw exactly those away.
    const writes: StateWriteRecord[] = Array.from({ length: 60 }, (_, i) => ({
      path: `/p/.traffic-one/ok-${i}.json`, op: 'write-json', ok: true,
    }));
    writes.splice(40, 0, { path: '/p/.traffic-one/refused.json', op: 'write-json', ok: false, errno: 'consent-fence' });
    writes.push({ path: '/p/.traffic-one/linked.jsonl', op: 'append-text', ok: false, errno: 'symlink' });

    appendDecision(cwd, baseRecord({ runId: 'bound-run', correlationId: buildCorrelationId('bound-run', 1, process.pid), stateWrites: writes }));
    const [record] = readDecisions(cwd, 'bound-run');
    const kept = record?.stateWrites ?? [];
    assert.ok(kept.length <= 32, `the bound must hold, got ${kept.length}`);
    assert.deepEqual(
      kept.filter((write) => !write.ok).map((write) => write.errno),
      ['consent-fence', 'symlink'],
      'every refusal survived the bound, in order',
    );
    assert.equal(kept[kept.length - 1]?.op, 'truncated', 'and the omission is stated rather than silent');
  });
});
