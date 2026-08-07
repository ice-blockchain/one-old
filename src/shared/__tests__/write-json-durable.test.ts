// fsjson.writeJsonDurable — the writer that is BOTH fenced and durable.
//
// THE STRUCTURAL DEFECT it closes: this repo already had the durable recipe, in
// runners/one-mcp-report/lib.ts's own private writeJson — exclusive temp open,
// write, fsync the fd, rename, fsync the directory. That writer bypasses the
// consent/symlink chokepoint and returns `void`. The chokepoint's writeJson is
// atomic in the VISIBILITY sense (temp + rename) and performs no fsync at all,
// so a crash can leave the rename durable and the data not. The two properties a
// state write needs were implemented in two different functions and no writer
// had both.
//
// Durability is not observable from the filesystem afterwards — a file written
// with fsync and one written without are byte-identical — so the fsync is proven
// by INTERCEPTION here, not by inspection. Without that, deleting the fsync
// would leave every assertion in this file green.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { readJson, writeJson, writeJsonDurable } from '../fsjson';
import { drainStateWrites, type StateWriteRecord } from '../state/state-write-log';

interface Fixture {
  project: string;
  stateDir: string;
  outside: string;
  secret: string;
}

const SECRET = 'DO NOT TOUCH\n';
const fixtures: string[] = [];

function fixture(label: string): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `t1lane-durable-${label}-`));
  fixtures.push(base);
  const project = path.join(base, 'project');
  const stateDir = path.join(project, '.traffic-one');
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, SECRET, 'utf8');
  drainStateWrites();
  return { project, stateDir, outside, secret };
}

// One teardown for every fixture this file creates, registered once. A per-test
// `cleanup()` call is skipped by the very thing it exists for — a FAILING
// assertion returns before it — and this machine has already had real failures
// from leaked trees.
after(() => {
  for (const dir of fixtures.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function refusal(op: string): StateWriteRecord {
  const records = drainStateWrites();
  const found = records.find((record) => record.op === op && !record.ok);
  assert.ok(found, `expected a recorded ${op} refusal, got ${JSON.stringify(records)}`);
  return found;
}

// ── durability, by interception ──────────────────────────────────────────────

/**
 * Count fsync calls, and classify each by what the fd is actually open on.
 *
 * The patch goes on the CJS `fs` module object, deliberately: `fsjson.ts` is
 * compiled to CommonJS and reaches `fs.fsyncSync` as a property of exactly this
 * object at CALL time, so this is a real interception of the code under test.
 * The ESM namespace this file imports is getter-only and patching it would
 * intercept nothing while looking identical.
 *
 * The fd is still open when fsyncSync runs, so `fstatSync` answers whether it is
 * the temp file or the directory without having to shadow `openSync` too.
 */
const cjsFs = createRequire(__filename)('fs') as typeof fs;

function recordingFsync<T>(fn: (log: { fds: number[]; dirs: number }) => T): T {
  const log = { fds: [] as number[], dirs: 0 };
  const real = cjsFs.fsyncSync;
  cjsFs.fsyncSync = ((fd: number) => {
    log.fds.push(fd);
    try {
      if (fs.fstatSync(fd).isDirectory()) log.dirs += 1;
    } catch { /* classification is best-effort; the count is not */ }
    return real(fd);
  }) as typeof fs.fsyncSync;
  try {
    return fn(log);
  } finally {
    cjsFs.fsyncSync = real;
  }
}

test('writeJsonDurable fsyncs the FILE before the rename, and the DIRECTORY after it', () => {
  const fx = fixture('fsync');
  const target = path.join(fx.stateDir, '.one.json');

  const log = recordingFsync((entry) => {
    assert.equal(writeJsonDurable(target, { stack: 'default' }), true);
    return entry;
  });

  assert.ok(log.fds.length >= 2,
    `expected an fsync of the temp file and one of the directory, got ${log.fds.length}`);
  assert.equal(log.dirs, 1, 'the directory entry the rename created is flushed too');
  assert.deepEqual(readJson(target, {}), { stack: 'default' });
});

test('the non-durable writeJson makes no fsync at all — the difference is the whole point', () => {
  const fx = fixture('fsync-control');
  const target = path.join(fx.stateDir, 'plain.json');

  const log = recordingFsync((entry) => {
    assert.equal(writeJson(target, { stack: 'default' }), true);
    return entry;
  });

  assert.deepEqual(log.fds, [],
    'writeJson never flushed anything; if this ever fails, the two writers have merged and the cost measurement is void');
});

// ── the same fence as every other primitive in the module ────────────────────

test('writeJsonDurable refuses a state path that is a symlink, and reports it', () => {
  const fx = fixture('symlink');
  // A writable BASELINE first: without it a refusal proves only that something
  // said no, and the consent fence would say no for a different reason.
  const control = path.join(fx.stateDir, 'control.json');
  assert.equal(writeJsonDurable(control, { control: true }), true, 'the fence is open, so the refusal below is about the link');
  drainStateWrites();

  const target = path.join(fx.stateDir, '.one.json');
  fs.symlinkSync(fx.secret, target);
  assert.equal(writeJsonDurable(target, { pwned: true }), false);
  assert.equal(refusal('write-json-durable').errno, 'symlink');
  assert.equal(fs.readFileSync(fx.secret, 'utf8'), SECRET, 'the file outside the project was written through');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'a planted link is refused, not replaced');
});

// A DANGLING link is the variant this writer must survive on its own terms: it
// stats the destination to preserve its mode, and a dangling link makes that
// stat fail. A writer that bailed on its own precondition would pass this test
// while proving nothing, so the assertion is that the TARGET is never created —
// the thing plain writeFileSync does not merely follow but CREATES.
test('a DANGLING symlink at the destination never gets its target created', () => {
  const fx = fixture('dangling');
  const control = path.join(fx.stateDir, 'control.json');
  assert.equal(writeJsonDurable(control, { control: true }), true);
  drainStateWrites();

  const victim = path.join(fx.outside, 'authorized_keys');
  const target = path.join(fx.stateDir, '.one.json');
  fs.symlinkSync(victim, target);

  assert.equal(writeJsonDurable(target, { pwned: true }), false);
  assert.equal(refusal('write-json-durable').errno, 'symlink');
  assert.equal(fs.existsSync(victim), false, 'the link target was created out of nothing');
});

test('an INTERMEDIATE symlinked directory is refused by containment, like every sibling primitive', () => {
  const fx = fixture('intermediate');
  fs.symlinkSync(fx.outside, path.join(fx.stateDir, 'runs'), 'dir');
  const target = path.join(fx.stateDir, 'runs', 'r1', 'run.json');

  assert.equal(writeJsonDurable(target, { pwned: true }), false);
  assert.equal(refusal('write-json-durable').errno, 'escapes-state-dir');
  assert.deepEqual(fs.readdirSync(fx.outside), ['secret.txt'], 'nothing was created in the link target');
});

// ── parity with writeJson, so 30-odd writeState callers see no change ────────

test('a successful durable write is recorded like any other state write', () => {
  const fx = fixture('recorded');
  const target = path.join(fx.stateDir, '.one.json');
  assert.equal(writeJsonDurable(target, { stack: 'default' }), true);
  const records = drainStateWrites();
  assert.deepEqual(
    records.filter((record) => record.op === 'write-json-durable' && record.ok).length,
    1,
    'the chokepoint reports the durable writer too, or a refusal of it would be invisible to the decision log',
  );
});

test('an existing destination keeps its mode; a new one gets exactly what writeJson would have given it', () => {
  const fx = fixture('mode');
  const existing = path.join(fx.stateDir, 'existing.json');
  fs.writeFileSync(existing, '{}\n', { encoding: 'utf8', mode: 0o640 });
  fs.chmodSync(existing, 0o640);
  assert.equal(writeJsonDurable(existing, { a: 1 }), true);
  assert.equal(fs.statSync(existing).mode & 0o777, 0o640, 'a durable rewrite must not re-mode a committed, shared file');

  // The lifted recipe creates a NEW file 0o600. That is deliberately not carried
  // over: `.one.json` is committed and shared, and 30-odd writeState callers
  // must not silently start narrowing it.
  const fresh = path.join(fx.stateDir, 'fresh-durable.json');
  const control = path.join(fx.stateDir, 'fresh-plain.json');
  assert.equal(writeJsonDurable(fresh, { a: 1 }), true);
  assert.equal(writeJson(control, { a: 1 }), true);
  assert.equal(fs.statSync(fresh).mode & 0o777, fs.statSync(control).mode & 0o777,
    'a new file written durably must have the same permissions as one written by writeJson');
});

test('the durable write is atomic and leaves no temp file behind', () => {
  const fx = fixture('atomic');
  const target = path.join(fx.stateDir, '.one.json');
  assert.equal(writeJsonDurable(target, { generation: 1 }), true);
  assert.equal(writeJsonDurable(target, { generation: 2 }), true);
  assert.deepEqual(readJson(target, {}), { generation: 2 });
  assert.deepEqual(fs.readdirSync(fx.stateDir).filter((name) => name.includes('.tmp')), []);
  assert.equal(fs.readFileSync(target, 'utf8').endsWith('\n'), true, 'same trailing newline as writeJson');
});
