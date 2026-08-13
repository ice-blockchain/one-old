// src/shared/__tests__/bounded-read-taxonomy.test.ts
// THE HOSTILE-SHAPE TAXONOMY: every filesystem object that could block a read,
// driven against every function `bounded-read.ts` exports, plus the question
// that decides how much each one matters — can it arrive through `git clone`?
//
// WHY THIS FILE EXISTS. For three rounds the corpus was two shapes: a FIFO, and
// a symlink to /dev/zero. Every bound in this codebase was proved against those
// two and nothing else. The first person who tried a THIRD — a dangling symlink,
// which is one `ln -s` and needs no privilege — found a LIVE SPIN in the
// exhausted-models lock that burned 130.86 s of CPU over 136 s of wall clock,
// 76.9 % of a core, and would have kept going. Two shapes is not a taxonomy; it
// is the example that started the lane. So the space is enumerated here on
// purpose, and it is enumerated as a TEST rather than as a table in a comment,
// because a table in a comment is exactly the instrument this lane keeps
// catching itself using.
//
// THE DEADLINE IS ENFORCED BY THE PARENT, at `spawnSync({ timeout, killSignal:
// 'SIGKILL' })`, and this is not a style choice. It has now been measured in
// three languages that no in-process deadline can interrupt a thread sitting in
// `open(2)`: node's `--test-timeout` is a timer on an event loop the blocking
// read is holding, Python's `signal.alarm` cannot interrupt it either, and the
// DEFAULT SIGTERM `spawnSync` sends is not delivered to a process blocked this
// way — a run under SIGTERM stayed alive for 3 h 47 m in a maintainer's hands.
// SIGKILL is the only one the kernel does not ask the process about.
//
// ONE CHILD PER SHAPE, not per (shape, api). Every leaf function runs inside the
// same child, so a shape that blocks ANY of them takes the child down and reds
// the whole row — which is the property worth asserting. Per-api children would
// cost 84 process spawns to say the same thing more slowly.
//
// NO WALL-CLOCK CEILING IS ASSERTED for a refusing shape, for the reason
// lock-identity-symlink.test.ts gives at its own rows: what these cells are
// about is that the call RETURNS, and for a refusing shape the throw IS the
// return. `run.signal === null` is the whole assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LEAF_MODULE = path.join(__dirname, '..', 'bounded-read.ts');

/** Long enough that a slow machine is not mistaken for a hang, short enough that
 *  fourteen of them do not dominate a suite. The observed spread for a REFUSING
 *  shape is 0–3 ms; the observed spread for a blocking one is unbounded. */
const CHILD_DEADLINE_MS = 8_000;

interface Shape {
  readonly id: string;
  /** Plants the object and returns its path, or null when the platform cannot
   *  make it — an unreachable shape is reported as absent rather than passing
   *  quietly, and the count assertion at the bottom is what makes that visible. */
  readonly plant: (dir: string) => string | null;
  /** Can this shape reach a machine through `git clone`, with no local process?
   *  Git has exactly one non-regular blob mode, 120000 for a symlink, so this is
   *  a property of the shape and not of anyone's threat model. */
  readonly inGit: boolean;
}

function mkfifo(at: string): string | null {
  try {
    execFileSync('mkfifo', [at], { stdio: 'ignore' });
  } catch {
    return null;
  }
  assert.equal(fs.lstatSync(at).isFIFO(), true, `fixture guard: ${at} must really be a FIFO`);
  return at;
}

function link(target: string, at: string): string | null {
  try {
    fs.symlinkSync(target, at);
  } catch {
    return null;
  }
  assert.equal(fs.lstatSync(at).isSymbolicLink(), true, `fixture guard: ${at} must really be a symlink`);
  return at;
}

function existingDevice(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isCharacterDevice() || fs.statSync(candidate).isBlockDevice();
  } catch {
    return false;
  }
}

const SHAPES: readonly Shape[] = [
  {
    id: 'regular file (CONTROL)',
    inGit: true,
    plant: (dir) => {
      const at = path.join(dir, 'regular.txt');
      fs.writeFileSync(at, 'contents');
      return at;
    },
  },
  {
    // The shape the whole lane started from: `open(O_RDONLY)` on a FIFO waits for
    // a writer, and if none ever comes it waits forever.
    id: 'FIFO',
    inGit: false,
    plant: (dir) => mkfifo(path.join(dir, 'fifo')),
  },
  {
    // A HARD link, so `lstat` on the path answers FIFO with no link to notice —
    // which is why O_NOFOLLOW alone would not have saved anybody here, and why
    // the bound has to be O_NONBLOCK plus an fstat on the descriptor.
    id: 'hard link to a FIFO',
    inGit: false,
    plant: (dir) => {
      const source = mkfifo(path.join(dir, 'fifo-source'));
      if (source === null) return null;
      const at = path.join(dir, 'fifo-hardlink');
      try {
        fs.linkSync(source, at);
      } catch {
        return null;
      }
      return at;
    },
  },
  {
    // CLONE-DELIVERABLE. Mode 120000 with the contents `/somewhere/fifo`, and the
    // FIFO can be a path the project already creates for its own reasons.
    id: 'symlink to a FIFO',
    inGit: true,
    plant: (dir) => {
      const source = mkfifo(path.join(dir, 'fifo-target'));
      return source === null ? null : link(source, path.join(dir, 'fifo-link'));
    },
  },
  {
    // The other half of the original corpus: a character device answers a read
    // for as long as anybody keeps asking, so the read returns bytes forever
    // rather than blocking. Different mechanism, same never-finishes.
    id: 'symlink to /dev/zero',
    inGit: true,
    plant: (dir) => (existingDevice('/dev/zero') ? link('/dev/zero', path.join(dir, 'zero-link')) : null),
  },
  { id: '/dev/zero direct', inGit: false, plant: () => (existingDevice('/dev/zero') ? '/dev/zero' : null) },
  {
    // Distinct from /dev/zero on purpose: it can BLOCK on entropy rather than
    // stream, which is a third mechanism again.
    id: '/dev/random direct',
    inGit: false,
    plant: () => (existingDevice('/dev/random') ? '/dev/random' : null),
  },
  {
    // Absent on darwin, present on Linux. Listed because a shape that exists on
    // the CI platform and not on the developer's is exactly the kind that gets
    // discovered in production.
    id: '/dev/full direct',
    inGit: false,
    plant: () => (existingDevice('/dev/full') ? '/dev/full' : null),
  },
  {
    id: 'block device',
    inGit: false,
    plant: () => ['/dev/disk0', '/dev/sda', '/dev/vda'].find((c) => existingDevice(c)) ?? null,
  },
  {
    // CLONE-DELIVERABLE, and the shape that found the spin. Costs nothing to
    // make and needs no cooperating process at all.
    id: 'dangling symlink',
    inGit: true,
    plant: (dir) => link(path.join(dir, 'nothing-here'), path.join(dir, 'dangling')),
  },
  {
    // CLONE-DELIVERABLE. Two blobs pointing at each other; the kernel gives up
    // with ELOOP, which is a RETURN and therefore fine — the point is that the
    // caller must have a branch for it.
    id: 'symlink loop',
    inGit: true,
    plant: (dir) => {
      const a = path.join(dir, 'loop-a');
      const b = path.join(dir, 'loop-b');
      if (link(b, a) === null) return null;
      return link(a, b) === null ? null : a;
    },
  },
  {
    // CLONE-DELIVERABLE, and the one shape here that is legitimately READ rather
    // than refused: a link to a regular file IS a regular file, so following it
    // is the correct answer for the general reader. The owner reader refuses it,
    // because at a lock sentinel a link is itself the answer.
    id: 'symlink to a regular file',
    inGit: true,
    plant: (dir) => {
      const target = path.join(dir, 'chain-target');
      fs.writeFileSync(target, 'contents');
      return link(target, path.join(dir, 'one-link'));
    },
  },
  {
    // CLONE-DELIVERABLE as 41 separate mode-120000 blobs, and past the kernel's
    // per-lookup limit (SYMLOOP_MAX is 32 on darwin), so it resolves to ELOOP
    // even though a regular file sits at the end of it.
    id: 'symlink chain, 41 deep',
    inGit: true,
    plant: (dir) => {
      const target = path.join(dir, 'deep-target');
      fs.writeFileSync(target, 'contents');
      let previous = target;
      for (let i = 0; i < 41; i += 1) {
        const next = path.join(dir, `chain-${i}`);
        if (link(previous, next) === null) return null;
        previous = next;
      }
      return previous;
    },
  },
  {
    // Not clone-deliverable AS A FILE: git can store a tree at the path, but it
    // cannot store a directory where a consumer expects a file without the
    // consumer's own path being a directory, which is a different bug.
    id: 'directory',
    inGit: false,
    plant: (dir) => {
      const at = path.join(dir, 'a-directory');
      fs.mkdirSync(at);
      return at;
    },
  },
  {
    id: 'unix domain socket',
    inGit: false,
    plant: (dir) => {
      const at = path.join(dir, 'socket');
      try {
        // `nc -lU` would leave a child behind; python's socket module binds and
        // exits, leaving only the inode.
        execFileSync('python3', ['-c',
          `import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()`, at],
        { stdio: 'ignore' });
      } catch {
        return null;
      }
      return fs.lstatSync(at).isSocket() ? at : null;
    },
  },
];

/**
 * Every leaf export, run against one path inside one child, under a deadline the
 * PARENT enforces.
 *
 * Returns the per-api outcomes so the assertions can be about WHAT the leaf
 * answered as well as that it answered at all — a function that refuses
 * everything, including the control, is bounded and useless.
 */
function driveShape(dir: string, target: string): Record<string, string> {
  const driver = path.join(dir, 'drive-taxonomy.cjs');
  fs.writeFileSync(driver, [
    'const leaf = require(process.argv[2]);',
    'const target = process.argv[3];',
    'const destination = process.argv[4];',
    'const answers = {};',
    'const describe = (value) => {',
    '  if (value === null) return "null";',
    '  if (typeof value === "number") return "fd";',
    '  if (typeof value === "boolean") return String(value);',
    '  if (Buffer.isBuffer(value)) return `bytes(${value.length})`;',
    '  if (typeof value === "string") return `text(${value.length})`;',
    '  return JSON.stringify(value);',
    '};',
    'const run = (name, fn) => {',
    '  try { answers[name] = describe(fn()); }',
    '  catch (error) { answers[name] = `THREW ${error && error.code ? error.code : String(error && error.message)}`; }',
    '};',
    'run("readRegularFile", () => leaf.readRegularFile(target));',
    'run("readOwnerEntry", () => leaf.readOwnerEntry(target));',
    'run("readRegularFileResult", () => leaf.readRegularFileResult(target));',
    'run("readRegularFileOrThrow", () => leaf.readRegularFileOrThrow(target));',
    'run("readRegularBytesOrThrow", () => leaf.readRegularBytesOrThrow(target));',
    'run("openRegularFd", () => { const fd = leaf.openRegularFd(target); require("fs").closeSync(fd); return fd; });',
    'run("copyRegularFile", () => leaf.copyRegularFile(target, destination));',
    'process.stdout.write(JSON.stringify(answers));',
  ].join('\n'), 'utf8');

  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', driver, LEAF_MODULE, target, path.join(dir, 'copy-destination')],
    { encoding: 'utf8', timeout: CHILD_DEADLINE_MS, killSignal: 'SIGKILL' },
  );

  assert.equal(run.signal, null,
    `the leaf did not RETURN on this shape — the child was killed by ${run.signal} at the ${CHILD_DEADLINE_MS} ms `
    + 'parent deadline, which is what an unbounded read looks like from outside. stderr: '
    + `${(run.stderr || '').slice(0, 400)}`);
  assert.equal(run.status, 0, `the driver itself failed: ${(run.stderr || '').slice(0, 400)}`);
  return JSON.parse(run.stdout) as Record<string, string>;
}

test('every hostile shape RETURNS from every leaf reader, and the control still reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-bounded-taxonomy-'));
  const driven: string[] = [];
  const absent: string[] = [];
  try {
    for (const shape of SHAPES) {
      const dir = path.join(root, shape.id.replace(/[^a-z0-9]+/gi, '-'));
      fs.mkdirSync(dir, { recursive: true });
      const target = shape.plant(dir);
      if (target === null) {
        absent.push(shape.id);
        continue;
      }
      const answers = driveShape(dir, target);
      driven.push(shape.id);

      if (shape.id === 'regular file (CONTROL)') {
        // THE ANTI-VACUITY ARM. Everything else here asserts a refusal, and a
        // leaf that refused unconditionally would satisfy every one of them.
        assert.equal(answers.readRegularFile, 'text(8)', 'CONTROL: the general reader must read a regular file');
        assert.equal(answers.readOwnerEntry, 'text(8)', 'CONTROL: the owner reader must read a regular file');
        assert.equal(answers.openRegularFd, 'fd', 'CONTROL: a regular file must yield a descriptor');
        assert.equal(answers.copyRegularFile, 'true', 'CONTROL: a regular file must copy');
        continue;
      }

      if (shape.id === 'symlink to a regular file') {
        // The one shape that is READ rather than refused, and the one place the
        // two flag sets visibly disagree. BOTH polarities are asserted, because
        // a reader that refused this would also pass every other row here.
        assert.equal(answers.readRegularFile, 'text(8)',
          'a link to a regular file IS a regular file: REGULAR_READ_FLAGS omits O_NOFOLLOW on purpose, because '
          + 'an ordinary config file is allowed to be a symlink and refusing every link breaks projects that '
          + 'did nothing wrong. What bounds it is O_NONBLOCK plus the fstat on the DESCRIPTOR, not the refusal');
        assert.equal(answers.readOwnerEntry, 'THREW ELOOP',
          'the OWNER reader refuses every link — at a lock sentinel a link is already the answer `not-ours`, '
          + 'which is the polarity the exhausted-models lock is stolen on when it is lost');
        continue;
      }

      // Every other shape: the only thing that must be true is that nothing
      // handed back the bytes of a hostile object as if it were a file.
      for (const [api, answer] of Object.entries(answers)) {
        assert.ok(!/^(?:text|bytes)\(/.test(answer) && answer !== 'true' && answer !== 'fd',
          `${shape.id}: ${api} answered ${answer} — a hostile shape must be refused, not consumed`);
      }
    }

    // FIXTURE READBACK. A platform without `mkfifo`, without symlink privilege
    // or without python3 reports a clean LOWER number rather than a pass, and a
    // fixture bug that plants nothing at all is what this catches — every
    // assertion above is inside the loop, so an empty loop is a green suite.
    assert.ok(driven.length >= 10,
      `FIXTURE only ${driven.length} of ${SHAPES.length} shapes could be planted, so this suite proved almost `
      + `nothing. Absent: ${absent.join(', ')}`);
    assert.ok(driven.includes('FIFO') && driven.includes('dangling symlink') && driven.includes('symlink loop'),
      `FIXTURE the three shapes that have actually caused defects must be among those driven: ${driven.join(', ')}`);
    assert.ok(driven.includes('symlink to a regular file'),
      'FIXTURE the READ arm must be among those driven, or every assertion here is a refusal and a leaf that '
      + `refused unconditionally would pass: ${driven.join(', ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLONE-DELIVERABILITY: git carries a symlink and nothing else, so the symlink rows arrive in a pull request', () => {
  // THE QUESTION THAT RANKS EVERY ROW ABOVE, and it is answered against real git
  // rather than from memory. A shape that needs somebody to run `mkfifo` on the
  // machine needs an attacker who already has the machine. A shape that git
  // stores is a shape that arrives in a `git clone` of an ordinary repository,
  // reviewed or not — no local process, no privilege, no prior access.
  //
  // Git has exactly one non-regular blob mode: 120000, a symlink, whose contents
  // are the target path. Everything else in the taxonomy — FIFO, socket, device
  // node — has no representation at all, which is why the symlink rows are
  // ranked above them even where the FIFO rows are the ones that block.
  // THE TABLE IS CHECKED FIRST, and without git, because the git half is
  // environment-gated and this half must not be. A shape mislabelled in `SHAPES`
  // misranks every row above it, and that is a mistake this file can make on its
  // own — no filesystem, no subprocess, no privilege.
  const clonable = SHAPES.filter((shape) => shape.inGit).map((shape) => shape.id).sort();
  assert.deepEqual(clonable, [
    'dangling symlink',
    'regular file (CONTROL)',
    'symlink chain, 41 deep',
    'symlink loop',
    'symlink to /dev/zero',
    'symlink to a FIFO',
    'symlink to a regular file',
  ], 'exactly the symlink shapes plus the regular control are clone-deliverable: git has ONE non-regular blob '
    + 'mode, 120000, and a FIFO, a socket and a device node have no representation in it at all');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-bounded-clone-'));
  try {
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    try {
      git('init', '--quiet');
      git('config', 'user.email', 'taxonomy@example.invalid');
      git('config', 'user.name', 'taxonomy');
    } catch {
      // A sandbox that refuses writes under the pinned TMPDIR cannot create a
      // repository — `git init` fails on `.git/hooks/`. The claim below is about
      // GIT's object model rather than about this tree, so an environment that
      // cannot host a repository leaves it unmeasured rather than false. The
      // table assertion above still ran.
      return;
    }

    fs.writeFileSync(path.join(root, 'regular.txt'), 'contents');
    try {
      fs.symlinkSync('/dev/zero', path.join(root, 'device-link'));
      fs.symlinkSync('nowhere', path.join(root, 'dangling-link'));
    } catch {
      return; // no symlink privilege; the shape is unreachable rather than unpinned
    }
    const fifo = mkfifo(path.join(root, 'fifo'));

    git('add', '--all');
    const staged = git('ls-files', '--stage');
    const modeOf = (name: string): string | null => {
      const row = staged.split('\n').find((line) => line.endsWith(`\t${name}`));
      return row ? row.slice(0, 6) : null;
    };

    assert.equal(modeOf('regular.txt'), '100644', 'FIXTURE a regular file stages as 100644');
    assert.equal(modeOf('device-link'), '120000',
      'a symlink to a CHARACTER DEVICE is an ordinary git blob — this object arrives through `git clone` with '
      + 'no local process, which is why the leaf may not depend on nobody having planted it');
    assert.equal(modeOf('dangling-link'), '120000',
      'and so does a DANGLING symlink, the shape that turned out to spin the exhausted-models lock forever');

    if (fifo !== null) {
      assert.equal(modeOf('fifo'), null,
        'git cannot stage a FIFO, so every FIFO row in the taxonomy needs a local process first. That is the '
        + 'whole difference between "needs the machine" and "arrives in a pull request", and it is why the '
        + 'symlink rows outrank the FIFO rows even though the FIFO rows are the ones that block');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
