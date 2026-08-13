// src/runners/qa-evidence/__tests__/windows-tree-kill.test.ts
// HOW FAR the teardown primitive reaches on Windows, where there is no process
// group to signal.
//
// The POSIX half of this module is pinned by mechanism, against real trees, in
// __tests__/process-group.test.ts, __tests__/server-teardown.test.ts and
// __tests__/bounded-command-surface.test.ts — all three skipped on win32,
// because process groups, `ps` and signal semantics do not exist there. That
// left the Windows path pinned by NOTHING, and what it actually did was the
// defect: `GROUP_KILLS_AVAILABLE` is false there, so every spawn site passes
// `detached: false`, `spawnedGroupId` answers null, the sweep loop is never
// entered, and `killProcessGroup` degrades to `child.kill` — the leader alone.
//
// That became strictly worse when the Lighthouse audit's spawn started routing a
// `.cmd` shim through `cmd /d /s /c` (__tests__/bounded-command-shim.test.ts):
// the spawned leader on Windows is now the SHELL, so a leader-only kill ends
// cmd.exe and leaves the audit's Chrome, its renderers, its profile directory
// and its remote debugging port alive — the survivor incident at
// plan-guard/plan-readiness/completion.ts, in the heaviest shape this runner can
// produce.
//
// Reachable from POSIX the way the two shim files are: the platform is a
// parameter and so is the tree killer, so the argv Windows would be handed is
// assertable from darwin without a Windows box, a `.cmd` or a `taskkill`. What
// that proves is the half a platform cannot fake — WHICH command, against WHOSE
// pid, in WHICH order relative to the leader kill. What it cannot prove is that
// Windows then executes it; that rests on `taskkill /T /F` being the platform's
// own documented tree walk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';

import {
  TREE_KILL_TIMEOUT_MS,
  killProcessGroup,
  type TreeKillSpawn,
} from '../process-group';

/** The tree walk, spelled as the platform spells it. */
const TASKKILL = 'taskkill';
const treeArgv = (pid: number): string[] => ['/PID', String(pid), '/T', '/F'];

interface TreeKillCall {
  file: string;
  args: readonly string[];
  options: { stdio: 'ignore'; timeout: number; windowsHide: true };
  /**
   * Had the leader already been signalled when this ran?
   *
   * The ordering is load-bearing rather than stylistic: `child.kill` is a
   * `TerminateProcess` on Windows, and `taskkill /T` enumerates descendants by
   * parent pid from the RUNNING process list, so a tree walk taken after the
   * leader has been terminated finds nothing to take with it. `killed` is set
   * synchronously by `child.kill`, so reading it here dates the two calls
   * against each other exactly.
   */
  leaderAlreadySignalled: boolean;
}

/** A tree killer that records the call instead of performing it. */
function recorder(child: { killed: boolean }): { calls: TreeKillCall[]; run: TreeKillSpawn } {
  const calls: TreeKillCall[] = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push({ file, args, options, leaderAlreadySignalled: child.killed });
      return null;
    },
  };
}

// Borrowed verbatim in spirit from __tests__/spawn-plan.test.ts's NEVER_CALLED:
// the POSIX rows exist to prove the win32 rows are not vacuous, and the way they
// prove it is by failing if the branch fires where it must not.
const NEVER_CALLED: TreeKillSpawn = (file) => assert.fail(
  `off win32 the primitive must shell out to nothing, and it ran ${file}`,
);

interface Leader {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  signalled: (NodeJS.Signals | undefined)[];
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * A stand-in for the spawned leader, because what is under test is which pid the
 * primitive addresses and in which order — not a kill.
 *
 * A real child cannot answer the matrix below: "the leader has already been
 * reaped" and "the spawn never produced a pid" are states a fixture would have
 * to race for, and they are two of the four rows. The row that does use a real
 * `spawn` is the last one.
 */
function leader(overrides: Partial<Leader> = {}): Leader {
  return {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    killed: false,
    signalled: [],
    kill(signal?: NodeJS.Signals): boolean {
      this.killed = true;
      this.signalled.push(signal);
      return true;
    },
    ...overrides,
  };
}

const asChild = (stub: Leader): ChildProcess => stub as unknown as ChildProcess;

/**
 * THE BRANCH. A Windows teardown must end the TREE, from the leader's pid.
 *
 * Asserted as the whole call — file, argv and options — because each part is a
 * separate way to reach the shell and still leak. `/T` is the tree; `/F` is not
 * optional (without it `taskkill` posts a window message, and every process this
 * runner spawns is a console process with nothing to receive it); and the
 * `timeout` is what keeps a wedged tree walk from holding a SIGINT handler open,
 * since this whole path is synchronous by construction.
 */
test('on win32 teardown ends the tree from the leader pid, before the leader itself', () => {
  const stub = leader({ pid: 8172 });
  const { calls, run } = recorder(stub);

  assert.equal(killProcessGroup(null, asChild(stub), 'SIGKILL', 'win32', run), true);

  assert.equal(calls.length, 1, 'a Windows teardown must reach the tree exactly once');
  assert.equal(calls[0]!.file, TASKKILL);
  assert.deepEqual(calls[0]!.args, treeArgv(8172));
  assert.deepEqual(calls[0]!.options, {
    stdio: 'ignore',
    timeout: TREE_KILL_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(
    calls[0]!.leaderAlreadySignalled,
    false,
    'the tree walk must precede the leader kill — after it, there is no live pid to enumerate children from',
  );
  // And the leader is still killed, so a host with no `taskkill` on PATH is left
  // exactly where it was before this branch existed rather than worse off.
  assert.deepEqual(stub.signalled, ['SIGKILL'], 'the leader-only kill remains the floor under the tree walk');
});

/**
 * EVERY signal, including the polite one — which on Windows is not polite.
 *
 * `stopOwnedServer` sends SIGTERM first so a dev server can flush and release
 * its port, and the SIGKILL that follows is skipped entirely when the leader has
 * gone (`treeIsGone` in server.ts). So a tree kill reserved for SIGKILL would
 * never run for the dev-server site on Windows: the SIGTERM would terminate the
 * leader and the escalation that carried the fix would be short-circuited by the
 * leader's own death. It costs nothing to include, because there is no polite
 * stop on Windows to escalate away from: libuv answers SIGTERM, SIGINT and
 * SIGKILL alike with `TerminateProcess`, so that first phase was already a
 * forced kill of the leader. What changes is only its reach.
 */
test('on win32 a polite teardown reaches the tree too, and keeps its own signal', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL'] as const) {
    const stub = leader({ pid: 2048 });
    const { calls, run } = recorder(stub);
    killProcessGroup(null, asChild(stub), signal, 'win32', run);
    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args]),
      [[TASKKILL, ...treeArgv(2048)]],
      `a ${signal} teardown must reach the tree on Windows, or the dev-server site never does`,
    );
    assert.deepEqual(
      stub.signalled,
      [signal],
      'the signal the caller chose must still be the one the leader is sent',
    );
  }
});

/**
 * A leader that has already been reaped is NOT tree-killed, and this is the one
 * place the Windows path deliberately does less than the POSIX one.
 *
 * `taskkill /T` needs the leader alive to enumerate its descendants, so the walk
 * could not work here — and a Windows pid is immediately recyclable, so a `/F`
 * at a dead one is a forced kill of whatever tree now owns that number. The
 * POSIX residual needs a pid-space wrap AND the recipient to have made itself a
 * group leader (see `killProcessGroup`); this one needs neither, so the two are
 * not comparable and the useless call is not worth the draw.
 *
 * The cost is stated rather than hidden: "leader gone, descendants alive holding
 * the inherited stdout" — the `abandoned` kind, and the case `forceStop` stopped
 * guarding on the leader for — remains unreachable on Windows.
 */
test('a leader already reaped is not tree-killed, at either kind of ending', () => {
  for (const ending of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGKILL' as const }]) {
    const stub = leader({ pid: 6120, ...ending });
    const { calls, run } = recorder(stub);
    assert.equal(killProcessGroup(null, asChild(stub), 'SIGKILL', 'win32', run), true);
    assert.deepEqual(
      calls,
      [],
      `a tree walk from a reaped leader (${JSON.stringify(ending)}) can only reach a recycled pid's tree`,
    );
  }
});

// A spawn that never started has no pid, and `/PID 0` is a syntax error rather
// than a tree. Reachable: `runBoundedProcess` catches a throwing `spawn`, and
// `startCommandServer`'s failure path tears down whatever it got.
test('a spawn that produced no pid is not tree-killed', () => {
  const stub = leader({ pid: undefined });
  const { calls, run } = recorder(stub);
  assert.equal(killProcessGroup(null, asChild(stub), 'SIGKILL', 'win32', run), true);
  assert.deepEqual(calls, []);
});

/**
 * The POSIX side, unchanged — and asserted, so the win32 rows above cannot pass
 * for a reason that has nothing to do with the platform.
 *
 * Byte-identical to what this primitive did before the branch existed: with a
 * null group id there is one `child.kill` and no shell-out at all. The real
 * group-kill behaviour, sweeps and all, is pinned against real trees in the
 * three suites named at the top of this file.
 */
test('off win32 the primitive shells out to nothing and kills exactly as before', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const stub = leader();
    assert.equal(killProcessGroup(null, asChild(stub), 'SIGTERM', platform, NEVER_CALLED), true);
    assert.deepEqual(stub.signalled, ['SIGTERM']);
  }
});

/**
 * THE DEFAULT RUNNER, on a machine with no `taskkill` — because a throw inside a
 * teardown path is worse than the leak it was added to close.
 *
 * Every caller of this primitive is a settling, exit or SIGINT path, and two of
 * them (`forceStop`'s pre-armed grace timer, `interruptReaper`'s re-raise) have
 * work AFTER the kill that a propagating error would skip. This row takes the
 * real `spawnSync` default down the win32 branch: nothing on POSIX resolves
 * `taskkill`, so it fails the way a Windows host with a broken PATH would, and
 * the primitive must still answer. The pid is not a multiple of four, so it
 * cannot name a live process on a real Windows host running this either.
 */
test('the real tree killer cannot throw out of a teardown path', () => {
  const stub = leader({ pid: 999_999 });
  assert.equal(killProcessGroup(null, asChild(stub), 'SIGKILL', 'win32'), true);
  assert.deepEqual(stub.signalled, ['SIGKILL'], 'the leader kill must run whatever the tree walk did');
});

/**
 * And once against a REAL spawned child, because a stub can agree with a wrong
 * reading of `ChildProcess`.
 *
 * The three properties the branch reads — `pid`, `exitCode`, `signalCode` — are
 * read off the node object here rather than off a literal, and the leader really
 * is killed at the end. The recorded call still stands in for `taskkill`: this is
 * darwin, where the command does not exist, and the observable is which pid
 * Windows would be handed.
 */
test('a real live child is addressed by its own pid', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000);'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  try {
    assert.ok(typeof child.pid === 'number' && child.pid > 1, 'fixture guard: the child never started');
    const { calls, run } = recorder(child);
    killProcessGroup(null, child, 'SIGKILL', 'win32', run);
    assert.deepEqual(calls.map((call) => [...call.args]), [treeArgv(child.pid)]);
    assert.equal(calls[0]!.leaderAlreadySignalled, false);
    await exited;
    assert.equal(child.signalCode, 'SIGKILL', 'the leader must still die from the signal it was given');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
