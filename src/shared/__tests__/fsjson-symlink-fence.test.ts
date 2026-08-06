// The symlink fence on shared/fsjson.ts's guarded primitives (see that file's
// "── The symlink fence ──" header).
//
// THE DEFECT these characterize: every writer under `<project>/.traffic-one/`
// resolved symlinks like any other `fs` call, so a repo that ships a state path
// — or any ancestor of one — as a symlink got the first hook's write delivered to
// the link's TARGET, anywhere on the filesystem. `.traffic-one/runs/x/debug/
// decisions.jsonl` -> `~/.ssh/authorized_keys` is the whole attack, and it lands
// on clone.
//
// Every case below is adversarial in the same shape: a file OUTSIDE the project
// holding bytes we then prove are byte-identical afterwards. Two things make each
// assertion mean something:
//
//   - a CONTROL write to an ordinary sibling path in the same state dir, asserted
//     to succeed. src/build/test-preload.mjs pins TRAFFIC_ONE_ASK_USE_PLUGIN='0'
//     for the whole suite, which holds the CONSENT fence open — without the
//     control, a test would pass identically if the write had been refused for
//     having no recorded consent, which would prove nothing about symlinks;
//   - the refusal is REPORTED, both as `false` to the caller and as a state-write
//     record naming the reason, so a refusal is evidence rather than silence.
//
// The two halves are separated on purpose, because either alone is not a fix:
// O_NOFOLLOW covers the FINAL component atomically and says nothing about
// intermediate ones (measured), while realpath containment covers intermediate
// ones and, on its own, is TOCTOU-racy on the final one.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendTextFile,
  ensureDir,
  movePath,
  readJson,
  readText,
  removePath,
  writeJson,
  writeTextFile,
} from '../fsjson';
import { writeTextIfChanged } from '../fs-text';
import { realPathWithMissingTail } from '../fs-nofollow';
import { drainStateWrites, type StateWriteRecord } from '../state/state-write-log';

const SECRET = 'DO NOT TOUCH\n';

// One teardown for every fixture this file creates. The machine this runs on has
// been at 99% capacity: ~30 leaked trees per run has already caused real
// failures, so nothing here is allowed to outlive the file.
const fixtures: string[] = [];

after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

interface Fixture {
  /** The project root. Deliberately NOT realpath'd: on macOS `os.tmpdir()` is
   *  under `/var`, a symlink to `/private/var`, so every containment check here
   *  is resolving a project root that is itself reached through a link — the
   *  exact shape that a containment test comparing lexical paths would refuse. */
  project: string;
  stateDir: string;
  /** A directory OUTSIDE the project, holding `secret`. */
  outside: string;
  secret: string;
}

function fixture(label: string): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `t1-symlink-fence-${label}-`));
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

/** The consent fence really is open for this project, so anything refused below
 *  was refused for being a symlink and for no other reason. */
function assertFenceOpen(fx: Fixture, label: string): void {
  const control = path.join(fx.stateDir, 'control', `${label}.txt`);
  assert.equal(writeTextFile(control, 'control\n'), true, 'the control write must land, or the fixture proves nothing');
  assert.equal(fs.readFileSync(control, 'utf8'), 'control\n');
  drainStateWrites();
}

function assertSecretIntact(fx: Fixture, what: string): void {
  assert.equal(fs.readFileSync(fx.secret, 'utf8'), SECRET, `${what}: the file outside the project was written through`);
}

/** The refusal reached the decision log's per-invocation collector, with a reason. */
function refusal(op: string): StateWriteRecord {
  const records = drainStateWrites();
  const found = records.find((record) => record.op === op && !record.ok);
  assert.ok(found, `expected a recorded ${op} refusal, got ${JSON.stringify(records)}`);
  return found;
}

// ── (b) the FINAL component: O_NOFOLLOW ──────────────────────────────────────

test('writeJson refuses a state path that is a symlink pointing outside the project', () => {
  const fx = fixture('write-json');
  assertFenceOpen(fx, 'write-json');
  const target = path.join(fx.stateDir, '.one.json');
  fs.symlinkSync(fx.secret, target);

  assert.equal(writeJson(target, { pwned: true }), false, 'the refusal must be reported to the caller');
  assertSecretIntact(fx, 'writeJson');
  assert.equal(refusal('write-json').errno, 'symlink');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the link itself is left exactly as it was');
});

test('writeJson refuses when its atomic TEMP path is the planted symlink', () => {
  const fx = fixture('write-json-tmp');
  assertFenceOpen(fx, 'write-json-tmp');
  // The temp file is a sibling of the destination and its name is derived from
  // this process's pid, so an attacker who can plant a link can plant this one.
  const target = path.join(fx.stateDir, 'state.json');
  fs.symlinkSync(fx.secret, `${target}.${process.pid}.tmp`);

  assert.equal(writeJson(target, { pwned: true }), false);
  assertSecretIntact(fx, 'writeJson via its temp file');
  assert.equal(refusal('write-json').errno, 'ELOOP', 'O_NOFOLLOW is what refuses this one');
  assert.equal(fs.existsSync(target), false, 'nothing landed at the destination either');
});

test('writeTextFile refuses a symlinked state path', () => {
  const fx = fixture('write-text');
  assertFenceOpen(fx, 'write-text');
  const target = path.join(fx.stateDir, 'plan.md');
  fs.symlinkSync(fx.secret, target);

  assert.equal(writeTextFile(target, '# pwned\n'), false);
  assertSecretIntact(fx, 'writeTextFile');
  assert.equal(refusal('write-text').errno, 'symlink');
});

test('appendTextFile refuses a symlinked state path — the decision log\'s own shape', () => {
  const fx = fixture('append-text');
  assertFenceOpen(fx, 'append-text');
  // Verbatim the reported attack: the decision log is append-only and runs on
  // every hook call, so it is the writer that reaches a planted link first.
  const target = path.join(fx.stateDir, 'runs', 'r1', 'debug', 'decisions.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(fx.secret, target);

  assert.equal(appendTextFile(target, '{"decision":"pwned"}\n'), false);
  assertSecretIntact(fx, 'appendTextFile');
  assert.equal(refusal('append-text').errno, 'symlink');
});

test('writeTextIfChanged refuses a symlinked state path (the busiest state writer)', () => {
  const fx = fixture('write-if-changed');
  assertFenceOpen(fx, 'write-if-changed');
  const target = path.join(fx.stateDir, 'AGENTS.local.md');
  fs.symlinkSync(fx.secret, target);

  assert.equal(writeTextIfChanged(target, '# pwned\n'), false);
  assertSecretIntact(fx, 'writeTextIfChanged');
  assert.equal(refusal('write-text').errno, 'symlink');
});

test('ensureDir refuses a state directory that is a symlink out of the project', () => {
  const fx = fixture('ensure-dir');
  assertFenceOpen(fx, 'ensure-dir');
  const target = path.join(fx.stateDir, 'runs');
  fs.symlinkSync(fx.outside, target, 'dir');

  assert.equal(ensureDir(target), false);
  assert.equal(refusal('mkdir').errno, 'symlink');
  assert.deepEqual(fs.readdirSync(fx.outside), ['secret.txt'], 'nothing was created in the link target');
});

test('removePath refuses a symlinked state path instead of deleting through it', () => {
  const fx = fixture('remove');
  assertFenceOpen(fx, 'remove');
  const target = path.join(fx.stateDir, 'debug');
  fs.symlinkSync(fx.outside, target, 'dir');

  assert.equal(removePath(target), false);
  assert.equal(refusal('remove').errno, 'symlink');
  assertSecretIntact(fx, 'removePath');
  assert.ok(fs.existsSync(fx.outside), 'the directory outside the project survives');
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'a planted link is refused, not reclaimed');
});

test('movePath refuses either end being a symlink, and moves nothing', () => {
  const fx = fixture('move');
  assertFenceOpen(fx, 'move');
  const source = path.join(fx.stateDir, 'from.md');
  fs.writeFileSync(source, '# real source\n', 'utf8');
  const dest = path.join(fx.stateDir, 'to.md');
  fs.symlinkSync(fx.secret, dest);

  assert.equal(movePath(source, dest), false, 'a symlinked destination refuses the move');
  assert.equal(refusal('move-to').errno, 'symlink');
  assertSecretIntact(fx, 'movePath destination');
  assert.equal(fs.readFileSync(source, 'utf8'), '# real source\n', 'a refused move leaves the source alone');

  // …and the same in the other direction: a half-move is data loss, not a
  // skipped write, so a refused SOURCE must not create the destination either.
  const linkedSource = path.join(fx.stateDir, 'linked-from.md');
  fs.symlinkSync(fx.secret, linkedSource);
  const cleanDest = path.join(fx.stateDir, 'clean-to.md');
  assert.equal(movePath(linkedSource, cleanDest), false);
  assert.equal(refusal('move-from').errno, 'symlink');
  assert.equal(fs.existsSync(cleanDest), false, 'nothing landed at the destination');
  assertSecretIntact(fx, 'movePath source');
});

// A DANGLING link is the nastier half of the final-component case: plain
// `writeFileSync` does not merely follow it, it CREATES the target (measured), so
// this is how a link plants a file at a path that does not exist yet — an
// `authorized_keys` for a user who has none.
test('a DANGLING symlink never gets its target created', () => {
  const fx = fixture('dangling');
  assertFenceOpen(fx, 'dangling');
  const victim = path.join(fx.outside, 'authorized_keys');
  const target = path.join(fx.stateDir, 'seq.json');
  fs.symlinkSync(victim, target);

  assert.equal(writeJson(target, { seq: 1 }), false);
  assert.equal(writeTextFile(target, 'x\n'), false);
  assert.equal(appendTextFile(target, 'x\n'), false);
  assert.equal(fs.existsSync(victim), false, 'the link target was created out of nothing');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
});

// ── (a) an INTERMEDIATE component: realpath containment ──────────────────────
// O_NOFOLLOW is silent about these — measured, `open('<link>/f.txt', O_CREAT|
// O_NOFOLLOW)` succeeds and the file lands inside the link's target — so this
// half is what the containment invariant exists for, and it is the half that
// redirects a whole SUBTREE rather than one file.

test('an intermediate symlinked directory redirects nothing: every primitive refuses', () => {
  const fx = fixture('intermediate');
  assertFenceOpen(fx, 'intermediate');
  // `.traffic-one/runs` -> outside. Everything below it now resolves out of the
  // project while still LOOKING like a state path, and its own final component
  // is an ordinary name no open flag would object to.
  fs.symlinkSync(fx.outside, path.join(fx.stateDir, 'runs'), 'dir');
  const under = (...rel: string[]): string => path.join(fx.stateDir, 'runs', ...rel);

  assert.equal(writeJson(under('r1', 'run.json'), { pwned: true }), false);
  assert.equal(refusal('write-json').errno, 'escapes-state-dir');
  assert.equal(writeTextFile(under('r1', 'plan.md'), 'pwned\n'), false);
  assert.equal(refusal('write-text').errno, 'escapes-state-dir');
  assert.equal(appendTextFile(under('r1', 'log.jsonl'), 'pwned\n'), false);
  assert.equal(refusal('append-text').errno, 'escapes-state-dir');
  assert.equal(writeTextIfChanged(under('r1', 'x.md'), 'pwned\n'), false);
  assert.equal(refusal('write-text').errno, 'escapes-state-dir');
  assert.equal(ensureDir(under('r1', 'debug')), false);
  assert.equal(refusal('mkdir').errno, 'escapes-state-dir');
  // The irreversible one: `rm` follows an intermediate link and the delete lands
  // on someone else's tree (measured).
  assert.equal(removePath(under('secret.txt')), false);
  assert.equal(refusal('remove').errno, 'escapes-state-dir');
  assert.equal(movePath(under('secret.txt'), path.join(fx.stateDir, 'stolen.txt')), false);
  assert.equal(refusal('move-from').errno, 'escapes-state-dir');

  assertSecretIntact(fx, 'an intermediate symlink');
  assert.deepEqual(fs.readdirSync(fx.outside), ['secret.txt'], 'not one path was created in the link target');
});

test('the state dir ITSELF being the planted link is refused, not declared contained in itself', () => {
  // The containment base is the state dir joined onto the project root's REAL
  // path. Resolving the STATE DIR instead — the obvious implementation — makes
  // `.traffic-one` -> `~/.ssh` resolve the base to `~/.ssh` too, and every path
  // under the link is then trivially "contained".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-symlink-fence-statedir-'));
  fixtures.push(base);
  const project = path.join(base, 'project');
  const outside = path.join(base, 'ssh');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const secret = path.join(outside, 'authorized_keys');
  fs.writeFileSync(secret, SECRET, 'utf8');
  fs.symlinkSync(outside, path.join(project, '.traffic-one'), 'dir');
  drainStateWrites();

  const target = path.join(project, '.traffic-one', 'authorized_keys');
  assert.equal(writeTextFile(target, 'pwned\n'), false);
  assert.equal(writeJson(target, { pwned: true }), false);
  assert.equal(appendTextFile(target, 'pwned\n'), false);
  assert.equal(removePath(target), false);
  assert.equal(fs.readFileSync(secret, 'utf8'), SECRET, 'a symlinked state dir was written through');
});

// ── what must NOT change ─────────────────────────────────────────────────────

test('READS still follow symlinks — the materialize fixtures resolve the plugin catalogs through them', () => {
  const fx = fixture('reads');
  // materialize-writer.test.ts and root-context-takeover.test.ts symlink the
  // plugin root's `rules/`/`skills-catalog/` at the real source trees so the
  // suite exercises the whole ~97-write materialization. A containment or
  // no-follow check applied to the READ side would break every one of those.
  const real = path.join(fx.outside, 'real.json');
  fs.writeFileSync(real, '{"resolved":true}\n', 'utf8');
  const linkedFile = path.join(fx.stateDir, 'linked.json');
  fs.symlinkSync(real, linkedFile);
  const linkedDir = path.join(fx.stateDir, 'linked-dir');
  fs.symlinkSync(fx.outside, linkedDir, 'dir');

  assert.deepEqual(readJson(linkedFile, {}), { resolved: true }, 'readJson must still resolve a symlink');
  assert.equal(readText(path.join(linkedDir, 'real.json')), '{"resolved":true}\n', 'reads through a linked DIRECTORY too');
  assert.deepEqual(drainStateWrites(), [], 'a read is not a state write and records nothing');
});

test('the project root is outside the fence: the intentional CLAUDE.md -> AGENTS.md symlink still gets created', async () => {
  // shared/materialize/render-agents.ts creates that link deliberately and falls
  // back to writeTextIfChanged when symlinkSync throws. The fence is addressed
  // by `.traffic-one/**` and a root file is not in it — hardening the shared
  // writer must not reach the root pair, in either direction.
  const { writeRootAgents, writeRootClaude } = await import('../materialize/render-agents');
  const fx = fixture('root-pair');

  assert.equal(writeRootAgents(fx.project, '# Traffic One\n\n<!-- GENERATED BY traffic-one: project-local active rules -->\n'), true);
  assert.equal(writeRootClaude(fx.project), true, 'the canonical symlink is created');
  const rootClaude = path.join(fx.project, 'CLAUDE.md');
  assert.ok(fs.lstatSync(rootClaude).isSymbolicLink(), 'CLAUDE.md is a symlink, on purpose');
  assert.equal(fs.readlinkSync(rootClaude), 'AGENTS.md');
  // Re-run: recognized as already canonical (the lstat/readlink check), so it is
  // neither rewritten nor replaced by a regular file.
  assert.equal(writeRootClaude(fx.project), false, 'a second run is a no-op, not a rewrite');
  assert.ok(fs.lstatSync(rootClaude).isSymbolicLink(), 'and the link survives it');

  // The fallback writer itself — what writeRootClaude falls back TO on a
  // filesystem that refuses symlinks. Exercised directly rather than by faking
  // an EPERM from symlinkSync, because it is the WRITE that this lane changed and
  // the fallback is one call to it at a project-root path.
  fs.rmSync(rootClaude, { force: true });
  assert.equal(writeTextIfChanged(rootClaude, '# Traffic One Claude Context\n\n@AGENTS.md\n'), true);
  assert.equal(fs.lstatSync(rootClaude).isSymbolicLink(), false, 'the fallback writes a real file');
  assert.match(fs.readFileSync(rootClaude, 'utf8'), /@AGENTS\.md/);
  assert.deepEqual(drainStateWrites(), [], 'a root file is not project state and is not recorded as one');
});

// A deliberate BEHAVIOUR CHANGE, stated as a test so it is a decision and not an
// accident: O_NOFOLLOW is applied to every write these helpers make, not only to
// the ones under `.traffic-one/`. The containment rule stays state-scoped (a root
// file has no state dir to be contained in), but refusing to write THROUGH a link
// costs nothing anywhere and closes the same hole one level up — a root
// `AGENTS.md`/`CLAUDE.md` shipped as a DANGLING symlink, which plain
// `writeFileSync` would follow and CREATE the target of.
test('a project-root file that is a symlink is never written through either', () => {
  const fx = fixture('root-symlink');
  const victim = path.join(fx.outside, 'authorized_keys');
  fs.symlinkSync(victim, path.join(fx.project, 'AGENTS.md'));
  fs.symlinkSync(fx.secret, path.join(fx.project, 'CLAUDE.md'));

  assert.equal(writeTextIfChanged(path.join(fx.project, 'AGENTS.md'), '# pwned\n'), false);
  assert.equal(fs.existsSync(victim), false, 'a dangling root link had its target created');
  assert.equal(writeTextIfChanged(path.join(fx.project, 'CLAUDE.md'), '# pwned\n'), false);
  assertSecretIntact(fx, 'a symlinked root file');
});

// `realPathWithMissingTail` is the shared containment primitive, and the fence is
// only as good as its answer. Tested directly because one of its branches is not
// reachable through the writers: a DANGLING component. For the final component the
// writers refuse first (lstat, then O_NOFOLLOW), and for an intermediate one the
// kernel refuses the write anyway — measured: both `mkdirSync(recursive)` and
// `open(O_CREAT)` through a dangling directory link fail ENOENT rather than
// creating the target. So this branch is not blocking a demonstrated escape; it
// keeps the helper's ANSWER honest for any future caller, since the alternative is
// returning a plausible-looking path the write can never actually reach.
test('realPathWithMissingTail resolves links, keeps a missing tail, and refuses what does not resolve', () => {
  const fx = fixture('realpath-helper');
  const real = fs.realpathSync(fx.stateDir);

  assert.equal(realPathWithMissingTail(path.join(fx.stateDir, 'runs', '7', 'nope.json')),
    path.join(real, 'runs', '7', 'nope.json'), 'a not-yet-existing tail is kept literally');

  fs.mkdirSync(path.join(fx.outside, 'elsewhere'), { recursive: true });
  fs.symlinkSync(path.join(fx.outside, 'elsewhere'), path.join(fx.stateDir, 'runs'), 'dir');
  assert.equal(realPathWithMissingTail(path.join(fx.stateDir, 'runs', 'x.json')),
    path.join(fs.realpathSync(path.join(fx.outside, 'elsewhere')), 'x.json'),
    'an INTERMEDIATE link is resolved to where it really points — the case no open flag can refuse');

  const dangling = path.join(fx.stateDir, 'gone');
  fs.symlinkSync(path.join(fx.outside, 'never-created'), dangling);
  assert.equal(realPathWithMissingTail(dangling), null, 'a dangling link is refused, never stepped over');
  assert.equal(realPathWithMissingTail(path.join(dangling, 'deeper', 'x.json')), null,
    'and refused as an ancestor too, where walking up would otherwise skip straight past it');
});

test('an ordinary state path, and the machine dir\'s own entries, are untouched by any of this', () => {
  const fx = fixture('happy-path');
  const ordinary = path.join(fx.stateDir, 'runs', '1', 'debug', 'decisions.jsonl');
  assert.equal(appendTextFile(ordinary, 'a\n'), true);
  assert.equal(appendTextFile(ordinary, 'b\n'), true);
  assert.equal(fs.readFileSync(ordinary, 'utf8'), 'a\nb\n', 'an append must append, not rewrite from byte 0');
  assert.equal(writeJson(path.join(fx.stateDir, '.one.json'), { mode: 'new-project' }), true);
  assert.equal(ensureDir(path.join(fx.stateDir, 'runs', '2')), true);
  assert.equal(movePath(ordinary, path.join(fx.stateDir, 'moved.jsonl')), true);
  assert.equal(removePath(path.join(fx.stateDir, 'moved.jsonl')), true);
  // Every one of those was recorded for the decision log, and all of them ok.
  const records = drainStateWrites();
  assert.ok(records.length >= 6, `expected the chokepoint to record each write, got ${records.length}`);
  assert.deepEqual(records.filter((record) => !record.ok), [], 'no refusals on the happy path');
});
