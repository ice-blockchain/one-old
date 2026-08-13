// src/shared/__tests__/emitted-read-bound.test.ts
// THE EMITTED BOUND, DRIVEN — the pin for the reads this repository ships AS
// SOURCE, in launchers and host wrappers that cannot import `bounded-read.ts`.
//
// WHY THIS IS DRIVEN AND NOT READ. `bounded-read-census.test.ts`'s `EMITTED_READS`
// enumerated these files and excused two of them with a sentence — "Same cost
// class as the shim … a foreground command that does not return" — which was
// FALSE: the shim reads `<$HOME>/.traffic-one/windsurf-plugin-root`, which no pull
// request can write, and the wrappers read `<project>/.traffic-one/.one.json`,
// which a `git clone` materialises because git stores a symlink as a mode-120000
// blob. An enumeration cannot tell those apart, and a textual check that the word
// `O_NONBLOCK` appears somewhere in a file cannot either. So the property asserted
// here is the OUTCOME: the emitted source RETURNS on a shape whose read has no
// bound by construction.
//
// EVERY ARM CARRIES ITS OWN NEGATIVE CONTROL, which is what makes it impossible
// for this suite to pass by measuring nothing. The `UNBOUND` variant of the same
// emitted helper — a plain `readFileSync(path)` — is driven against the SAME
// planted object under the same deadline and must be SIGKILLed. If the fixture
// shape were absent or benign (a filesystem that quietly refuses a FIFO, a
// `/dev/zero` that is not there), that arm would return and this suite would RED
// rather than reporting a green bound over an object that could never block
// anything. A survivor on a branch with zero executions is an absent fixture, not
// a bound.
//
// THE DEADLINE IS THE PARENT'S. `spawnSync({ timeout, killSignal: 'SIGKILL' })`
// and `signal` is asserted, because node's own `--test-timeout` is a timer on the
// event loop a blocking `open` is holding, so it cannot fire; and SIGTERM is
// ignorable (measured elsewhere in this lane returning after 20 047 ms against an
// 800 ms ask).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EMITTED_BOUNDED_READ_FN, emittedBoundedReadSource } from '../emitted-bounded-read';
import { OPENCODE_HOOK_TOOL_BEFORE } from '../../config/opencode-host';
import { KILO_HOOK_TOOL_BEFORE } from '../../config/kilo-host';
import { wrapperSource as openCodeWrapper } from '../../runners/opencode-host/wrapper-source';
import { wrapperSource as kiloWrapper } from '../../runners/kilo-host/wrapper-source';

/**
 * Two deadlines, because they price differently. The BOUNDED arms are expected to
 * return in tens of ms, so their deadline is generous — it is only ever paid when
 * the bound is broken, i.e. by a failing suite. The NEGATIVE CONTROLS are expected
 * to hang, so their deadline is paid on EVERY run and is short; a plain
 * `readFileSync` of a FIFO or of a link to `/dev/zero` does not return at all
 * rather than returning slowly, so 1 500 ms distinguishes it from a slow box —
 * and the control writes a REACHED marker before the read, so a child that was
 * merely slow to start cannot be mistaken for one that blocked.
 */
const DEADLINE_MS = 6_000;
const HANG_DEADLINE_MS = 1_500;

type Shape = 'regular' | 'devzero' | 'fifo';

interface Planted {
  readonly planted: boolean;
  /** Why the shape could not be created, for a VISIBLE skip rather than a silent pass. */
  readonly why?: string;
}

/**
 * The object at `target`. `/dev/zero` through a symlink is the shape that needs no
 * local process at all — it is what a pull request delivers — so it is the arm
 * every case below runs; the FIFO is the sharper hang and is skipped VISIBLY where
 * `mkfifo` is unavailable (a bare `return` reports as a pass, which is how a
 * load-bearing arm goes quiet).
 */
function plant(target: string, shape: Shape): Planted {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (shape === 'regular') {
    fs.writeFileSync(target, JSON.stringify({ mode: 'build', owner: 'traffic-one', version: 1 }));
    return { planted: true };
  }
  if (shape === 'devzero') {
    if (!fs.existsSync('/dev/zero')) return { planted: false, why: 'no /dev/zero on this platform' };
    fs.symlinkSync('/dev/zero', target);
    return { planted: true };
  }
  const made = spawnSync('mkfifo', [target], { encoding: 'utf8' });
  if (made.status !== 0 || !fs.existsSync(target)) {
    return { planted: false, why: `mkfifo exited ${made.status ?? 'null'}: ${String(made.stderr || '').trim()}` };
  }
  return { planted: true };
}

interface Ran {
  readonly signal: string | null;
  readonly status: number | null;
  readonly stdout: string;
  readonly elapsedMs: number;
}

function runChild(argv: readonly string[], cwd: string, deadlineMs = DEADLINE_MS): Ran {
  const started = Date.now();
  const run = spawnSync(process.execPath, [...argv], {
    cwd,
    encoding: 'utf8',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
  });
  return {
    signal: run.signal ?? null,
    status: run.status ?? null,
    stdout: String(run.stdout || ''),
    elapsedMs: Date.now() - started,
  };
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-emitted-read-'));
}

test('the EMITTED reader returns on every shape whose read has no bound — and the unbounded twin does not', (t) => {
  // The helper as it is emitted, and the read it replaced, in the same child
  // shape and against the same planted object. `probe` prints one JSON line and
  // exits; a child that never prints is a child still sitting in `open(2)`.
  // The path is INTERPOLATED rather than read from `process.argv`: under `node -e`
  // the first user argument is argv[1], not argv[2], and the off-by-one answers
  // with an empty stdout and a fast exit — which reads exactly like a refusal.
  const program = (target: string, body: (path: string) => string): string => (
    `const fs=require('fs');${body(JSON.stringify(target))}`
  );
  const bounded = (target: string): string => program(target, (p) => `${emittedBoundedReadSource('fs')}`
    + `const r=${EMITTED_BOUNDED_READ_FN}(${p});`
    + 'process.stdout.write(JSON.stringify({kind:r===null?\'refused\':\'text\',bytes:r===null?0:r.length}));');
  // THE NEGATIVE CONTROL: the read this replaces, verbatim, with a durable
  // REACHED marker written before it. The marker is what turns "the parent killed
  // it" into "it reached the read and never came back" — a child that was slow to
  // start looks identical on the signal alone.
  const unbound = (target: string, reached: string): string => program(target, (p) => (
    `fs.writeFileSync(${JSON.stringify(reached)},'reached');`
    + `const r=fs.readFileSync(${p},'utf8');`
    + 'process.stdout.write(JSON.stringify({kind:\'text\',bytes:r.length}));'
  ));

  const root = scratch();
  try {
    for (const shape of ['regular', 'devzero', 'fifo'] as const) {
      const target = path.join(root, shape, '.traffic-one', '.one.json');
      const { planted, why } = plant(target, shape);
      if (!planted) {
        // VISIBLE. `# skipped` moves, so a reviewer asserting counts can see that
        // the arm did not run; a bare `return` here reports as `# pass`.
        t.diagnostic(`shape ${shape} not planted: ${why}`);
        continue;
      }

      const boundedRun = runChild(['-e', bounded(target)], root);
      assert.equal(boundedRun.signal, null,
        `the EMITTED bounded reader did not return on a ${shape} at ${target} — killed by the parent deadline `
        + `after ${boundedRun.elapsedMs} ms. That is the whole class this lane closes: a wrapper that never `
        + 'returns cannot report that it did not.');
      const answer = JSON.parse(boundedRun.stdout || '{}') as { kind?: string; bytes?: number };
      if (shape === 'regular') {
        assert.equal(answer.kind, 'text', 'a REGULAR file must still read — a bound that refuses everything is a break');
        assert.ok((answer.bytes ?? 0) > 0, 'the control must carry the bytes');
      } else {
        assert.equal(answer.kind, 'refused',
          `a ${shape} must answer null (something is there and it is not a regular file), not empty bytes: `
          + 'empty bytes are a licence to replace the file, which is the other half of the FSTAT-DROP finding');
      }

      const reached = path.join(root, `${shape}.reached`);
      const unboundRun = runChild(['-e', unbound(target, reached)], root,
        shape === 'regular' ? DEADLINE_MS : HANG_DEADLINE_MS);
      if (shape === 'regular') {
        assert.equal(unboundRun.signal, null, 'FIXTURE the unbounded twin must return on a regular file');
        continue;
      }
      assert.equal(fs.existsSync(reached), true,
        `ANTI-VACUITY: the ${shape} negative control never reached its read (no REACHED marker), so its SIGKILL `
        + 'says nothing about the shape — it says the child was killed before it got there. Raise '
        + 'HANG_DEADLINE_MS rather than trusting the signal.');
      assert.equal(unboundRun.signal, 'SIGKILL',
        `ANTI-VACUITY: a plain readFileSync of the planted ${shape} RETURNED in ${unboundRun.elapsedMs} ms, so the `
        + 'object cannot block and the bounded arm above proved nothing. Fix the fixture, do not relax the '
        + 'assertion — a survivor on a branch with zero executions is an absent fixture, not a bound.');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The two host wrappers, END TO END: emit the wrapper, plant the shape at the
 * PROJECT path the wrapper walks to, and drive the real `tool.execute.before`
 * hook.
 *
 * Not a text assertion about the emitted string, because the sentence this
 * replaces was a text assertion of exactly that kind. The wrapper resolves its
 * project root before it does anything else, so the read is on the path of every
 * hook the host fires — which is why the peer's measurement was a hang at HOST
 * PLUGIN LOAD rather than in some optional branch.
 */
const WRAPPERS = [
  { id: 'opencode', emit: openCodeWrapper, hook: OPENCODE_HOOK_TOOL_BEFORE },
  { id: 'kilo', emit: kiloWrapper, hook: KILO_HOOK_TOOL_BEFORE },
] as const;

test('both emitted HOST WRAPPERS return when a project plants a hostile .one.json', (t) => {
  for (const wrapper of WRAPPERS) {
    const root = scratch();
    try {
      const project = path.join(root, 'project');
      const { planted, why } = plant(path.join(project, '.traffic-one', '.one.json'), 'devzero');
      if (!planted) { t.diagnostic(`${wrapper.id}: ${why}`); continue; }

      // A plugin root that EXISTS but holds no runtime: the wrapper's spawn of the
      // hook runtime then fails fast, so what is being measured is the root
      // resolution — the read — and not a hook run.
      const pluginRoot = path.join(root, 'plugin');
      fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
      const module = path.join(root, `${wrapper.id}-wrapper.mjs`);
      fs.writeFileSync(module, wrapper.emit(pluginRoot, '2026-01-01T00:00:00.000Z'));

      const driver = path.join(root, 'drive.mjs');
      fs.writeFileSync(driver, `const mod = await import(${JSON.stringify(module)});\n`
        + `const hooks = await mod.TrafficOne({ directory: ${JSON.stringify(project)}, worktree: ${JSON.stringify(project)} });\n`
        + `try { await hooks[${JSON.stringify(wrapper.hook)}]({ tool_name: 'read', cwd: ${JSON.stringify(project)} }, {}); }\n`
        + 'catch (error) { /* a deny is an ANSWER; the property under test is that it answers */ }\n'
        + 'process.stdout.write(\'returned\');\n');

      const run = runChild([driver], root);
      assert.equal(run.signal, null,
        `the emitted ${wrapper.id} wrapper never returned with a symlink to /dev/zero at `
        + `<project>/.traffic-one/.one.json — killed after ${run.elapsedMs} ms. Git stores a symlink as mode `
        + '120000, so that object arrives through an ordinary pull request and materialises on clone with no '
        + 'local process; the read is on the path of every hook the host fires.');
      assert.equal(run.stdout.trim(), 'returned',
        `FIXTURE the ${wrapper.id} driver must reach its own last line (stdout: ${JSON.stringify(run.stdout)})`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
