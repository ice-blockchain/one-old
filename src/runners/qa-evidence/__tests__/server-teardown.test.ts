// src/runners/qa-evidence/__tests__/server-teardown.test.ts
// The BROWSER lane's long-lived spawns must take their trees with them too.
//
// The process-group work landed on `runBoundedProcess` and stopped there, and the
// incident it cites is not that spawn: the completion gate's record
// (plan-guard/plan-readiness/completion.ts:642) describes "a sweep aimed at a
// leftover PREVIEW SERVER", which is `startCommandServer`. What the runner spawns
// for a dev server is almost never the listener — `npm run dev` is a package
// manager over a script, the script is routinely `node server.js & wait`, and a
// framework wrapper traps SIGTERM to shut down slowly — so a signal to the leader
// alone leaves the process holding the port at `ppid 1`.
//
// Measured against the real `startCommandServer`/`stopOwnedServer` over the four
// wrapper shapes that occur, before this file existed: only the shape where the
// npm script IS the listener tore down cleanly. The other three left a listener
// at `ppid 1` with the upstream port still bound, which is one run's server
// answering the next run's checks — the survivor incident exactly.
//
// So the assertions here are about the LISTENER and the PORT, never about the
// process the runner spawned. A test that watched the leader would have passed
// for the whole life of the defect: in all three broken shapes the leader exited
// promptly and correctly.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { runBoundedCommand } from '../lighthouse';
import { startCommandServer, stopOwnedServer, teardownComplete } from '../server';
import { type OwnedServer, type RunnerArgs } from '../types';

// Process groups, signal semantics and `ps` are POSIX; `detached` on Windows
// creates no signalling group at all, so every assertion here would be about a
// mechanism that does not exist there. Skipped explicitly, as
// __tests__/process-group.test.ts:38 does.
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX process groups' : false };
const TEST_TIMEOUT_MS = 30_000;

/** How long the listener is given to disappear once teardown has returned. */
const TEARDOWN_BUDGET_MS = 5_000;

/**
 * Everything this file has ever started, swept once when the file is done.
 *
 * Every test below already sweeps in its own `finally`, and this exists because
 * a `finally` is exactly what a TIMED-OUT test does not reach: node:test
 * abandons the pending promise and moves on, so the cleanup never runs. That is
 * not a tidiness problem here, and it was measured while mutation-testing this
 * lane: dropping `detached` from the dev-server spawn produced five failing
 * tests and then sat there for five minutes without exiting, twice.
 *
 * The PROXY is what actually held it. `startCommandServer` returns a listening
 * `http.Server` beside the child, and only `stopOwnedServer` closes it — so every
 * test here that fails BEFORE teardown, which is what the `assertServingBefore`
 * guards exist to do, leaves an open server handle in the test process, and node
 * exits when its handles close rather than when its tests finish. The children
 * are the second half: they inherit the runner's stdout, so a leftover holding
 * that pipe keeps it alive too.
 *
 * A regression in this lane has to FAIL the suite, not hang it, and an `after`
 * hook runs where a `finally` inside an abandoned promise does not.
 */
const TRACKED_PIDS = new Set<number>();
const TRACKED_GROUPS = new Set<number>();
const TRACKED_SERVERS = new Set<OwnedServer['server']>();

function track(pids: readonly (number | null | undefined)[], pgid?: number | null, owned?: OwnedServer): void {
  for (const pid of pids) if (typeof pid === 'number' && pid > 1) TRACKED_PIDS.add(pid);
  if (typeof pgid === 'number' && pgid > 1) TRACKED_GROUPS.add(pgid);
  if (owned?.server) TRACKED_SERVERS.add(owned.server);
}

after(() => {
  // Groups first: a group kill reaches the descendants a pid list never learned
  // about. Both are guarded on `> 1` — the round-2 probe defect in this lane was
  // a pid that defaulted to 0, which makes `process.kill` signal the CALLER's
  // own group, and here that is the test runner.
  for (const pgid of TRACKED_GROUPS) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const pid of TRACKED_PIDS) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // `unref` as well as `close`: a `close` waits for the connections already on
  // the socket, and this hook has nowhere to await them.
  for (const server of TRACKED_SERVERS) {
    try { server.unref(); server.close(); } catch { /* already closed */ }
  }
});

const posixTest = (
  name: string,
  options: { timeout?: number },
  fn: () => Promise<void> | void,
): void => { test(name, { ...POSIX_ONLY, ...options }, fn); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the port bindable? The same question `freePort` and the next dev server
 * ask, asked the same way — see `portIsFree` in server.ts for why a bind attempt
 * rather than a connect attempt is the right probe.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => { probe.close(() => resolve(true)); });
  });
}

/**
 * A process's group, or null when `ps` cannot answer.
 *
 * Never allowed to DECIDE a verdict, only to sharpen one: `ps` is a spawn, and
 * where that is not permitted `.stdout` is undefined — which once failed every
 * test in the sibling file for a reason that had nothing to do with orphans
 * (process-group.test.ts:288).
 */
function pgidOf(pid: number): number | null {
  const out = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  const value = Number(typeof out === 'string' ? out.trim() : NaN);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The live members of a process group, ZOMBIES EXCLUDED.
 *
 * The exclusion is not tidiness. The leader of every group here is this process's
 * own child, so between the kill that ended it and the moment node gets a turn to
 * `wait` for it, it is an unreaped entry that `ps` lists with its pgid intact and
 * that `kill(pid, 0)` calls alive — measured, that is exactly what the
 * slow-SIGTERM-trap shape shows the instant teardown returns. A zombie holds no
 * port, no device and no memory; counting one as a leftover would fail this file
 * for a state that is by definition already over.
 */
function groupMembers(pgid: number): number[] | null {
  const out = spawnSync('ps', ['-Ao', 'pid=,pgid=,state='], { encoding: 'utf8' }).stdout;
  if (typeof out !== 'string') return null;
  return out.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 3
      && Number(columns[1]) === pgid
      && Number(columns[0]) > 0
      && !columns[2]!.startsWith('Z'))
    .map((columns) => Number(columns[0]));
}

/**
 * The trip-wire for the round-2 regression, and it is deliberately weaker than
 * the assertions above.
 *
 * `detached` is what makes a group kill possible, and on its own it makes things
 * WORSE: measured then, the leftover used to share the runner's own process
 * group, where a terminal Ctrl-C and a harness's `kill -TERM -<pgid>` both
 * reached it, and `detached` without a group kill on every exit path moved it
 * into a group nothing would ever address. That shipped once. So whatever else
 * is true, a leftover of this runner must be either GONE or still reachable by
 * whoever is reaching for the runner — and today, with the group kills in place
 * on all four paths, there is no leftover at all, which makes this vacuous on
 * the passing path. Vacuous is the point: it is the assertion that fails first
 * if half of this change is ever reverted.
 */
function assertNoUnaddressableLeftover(pgid: number | null | undefined, what: string): void {
  if (typeof pgid !== 'number') return;
  const own = pgidOf(process.pid);
  const members = groupMembers(pgid);
  if (own === null || members === null) return;
  assert.deepEqual(
    members.filter((pid) => pid !== own),
    [],
    `${what}: a leftover must never sit in a process group nothing can address — `
    + `group ${pgid} still holds ${JSON.stringify(members)} while this runner is in group ${own}`,
  );
}

interface Shape {
  /** The argv the runner is told to start, `{LISTENER}`/`{DIR}` substituted. */
  argv: string[];
  /** `package.json` scripts for the shapes that go through a package manager. */
  scripts?: Record<string, string>;
  /** A wrapper that traps SIGTERM and leaves slower than the polite window. */
  slowTrap?: boolean;
}

interface Started {
  owned: OwnedServer;
  dir: string;
  leaderPid: number;
  listenerPid: number;
  targetPort: number;
}

/**
 * A project whose dev server is a plain HTTP listener that announces its pid.
 *
 * The listener never traps anything and never exits on its own: everything under
 * test is about who reaches it, so it must not be able to tidy itself away and
 * make a broken teardown look clean.
 */
function project(dir: string, shape: Shape): { argv: string[]; pidFile: string } {
  fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, 'listener.pid');
  const listener = path.join(dir, 'listener.js');
  fs.writeFileSync(listener, [
    "const http = require('http');",
    "const fs = require('fs');",
    "http.createServer((request, response) => { response.writeHead(200); response.end('ok'); })",
    `  .listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));`,
    'setTimeout(() => {}, 600000);',
    '',
  ].join('\n'));
  if (shape.slowTrap) {
    fs.writeFileSync(path.join(dir, 'wrapper.js'), [
      "const { spawn } = require('child_process');",
      `const kid = spawn(process.execPath, [${JSON.stringify(listener)}], { stdio: 'inherit' });`,
      // Next.js, gradle and anything with a graceful-shutdown hook: the leader
      // acknowledges SIGTERM and takes longer than the polite window to leave.
      "process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 5000); });",
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
  }
  const substitute = (value: string): string => value
    .replace('{LISTENER}', listener)
    .replace('{DIR}', dir);
  if (shape.scripts) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'teardown-probe',
      private: true,
      scripts: Object.fromEntries(Object.entries(shape.scripts).map(([key, value]) => [key, substitute(value)])),
    }));
  }
  return { argv: shape.argv.map(substitute), pidFile };
}

const LOADED_RUN = {
  sourceHash: 'source',
  fingerprint: 'fingerprint',
  manifest: { files: [], manifestHash: 'build', outputRoot: '.' },
} as never;

async function startShape(dir: string, shape: Shape): Promise<Started> {
  const { argv, pidFile } = project(dir, shape);
  const args = {
    command: 'browser',
    projectRoot: dir,
    runId: 'teardown-probe',
    buildDir: 'dist',
    withLighthouse: false,
    timeoutMs: 15_000,
    serverCommandJson: JSON.stringify(argv),
  } as unknown as RunnerArgs;
  const owned = await startCommandServer(args, LOADED_RUN);
  // `startCommandServer` returns once the upstream answers HTTP, which is after
  // the listener has written its pid — but the write and the listen callback are
  // the same tick in the fixture, not the same syscall, so this is polled.
  const deadline = Date.now() + 5_000;
  let listenerPid = 0;
  while (Date.now() < deadline && listenerPid <= 0) {
    try { listenerPid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* not up yet */ }
    if (listenerPid <= 0) await sleep(25);
  }
  assert.ok(listenerPid > 1, 'fixture guard: the dev server never announced its pid');
  assert.ok(typeof owned.targetPort === 'number', 'the pair must carry the upstream port it has to give back');
  track([listenerPid, owned.child?.pid], owned.pgid, owned);
  return {
    owned, dir, listenerPid, targetPort: owned.targetPort!, leaderPid: owned.child!.pid!,
  };
}

/**
 * Everything that must be true before teardown, so that nothing afterwards can
 * pass for the wrong reason.
 *
 * The pgid equality is the load-bearing one. It says the process holding the
 * port is IN the group the pair carries, which is what makes a group kill a fix
 * rather than a hope — and it is false for every one of these shapes if the
 * spawn loses `detached`, or if the pgid is re-derived from a leader that has
 * already exited.
 */
async function assertServingBefore(started: Started): Promise<void> {
  assert.ok(alive(started.listenerPid), 'fixture guard: the dev server must be running before teardown');
  assert.equal(
    await portIsFree(started.targetPort),
    false,
    'fixture guard: the upstream port must be held while the dev server is up',
  );
  const listenerGroup = pgidOf(started.listenerPid);
  if (listenerGroup !== null) {
    assert.equal(
      listenerGroup,
      started.owned.pgid,
      'the process holding the port must be inside the group the pair carries, or no group kill can reach it',
    );
  }
}

async function assertTornDown(started: Started, what: string): Promise<void> {
  const deadline = Date.now() + TEARDOWN_BUDGET_MS;
  while (alive(started.listenerPid) && Date.now() < deadline) await sleep(25);
  assert.equal(
    alive(started.listenerPid),
    false,
    `${what}: the process holding the port outlived teardown — it is an orphan at `
    + `ppid ${spawnSync('ps', ['-o', 'ppid=', '-p', String(started.listenerPid)], { encoding: 'utf8' }).stdout?.trim() || '?'}`,
  );
  assert.equal(
    await portIsFree(started.targetPort),
    true,
    `${what}: the upstream port is still bound, so the next run's checks would answer against this build`,
  );
  assertNoUnaddressableLeftover(started.owned.pgid, what);
}

function sweep(started: Started | null): void {
  if (!started) return;
  // The proxy, first and unconditionally: a test that failed before teardown
  // never closed it, and it is a live handle in THIS process.
  try { started.owned.server.unref(); started.owned.server.close(); } catch { /* already closed */ }
  for (const pid of [started.listenerPid, started.leaderPid]) {
    if (pid > 1 && alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  if (typeof started.owned.pgid === 'number') {
    try { process.kill(-started.owned.pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(started.dir, { recursive: true, force: true });
}

async function shapeTearsDown(shape: Shape, what: string): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-server-'));
  let started: Started | null = null;
  try {
    started = await startShape(dir, shape);
    await assertServingBefore(started);
    const startedAt = Date.now();
    await stopOwnedServer(started.owned);
    const stopMs = Date.now() - startedAt;
    await assertTornDown(started, what);
    return stopMs;
  } finally {
    sweep(started);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The one shape that was already clean, and the reason it has a test of its own:
// it is the control. Everything below it fails without the group kills, so
// without this one a change that simply killed harder — and broke the ordinary
// case — would look like progress.
posixTest('a dev server the package manager forwards to is torn down and gives its port back', { timeout: TEST_TIMEOUT_MS }, async () => {
  await shapeTearsDown(
    { argv: ['npm', 'run', 'dev', '--silent'], scripts: { dev: 'node {LISTENER}' } },
    'a dev server that IS the npm script',
  );
});

// A POSIX shell does not forward a signal to a background job, so the listener
// here never hears about SIGTERM and the shell that did exits without it.
posixTest('a dev server started as a shell background job is torn down and gives its port back', { timeout: TEST_TIMEOUT_MS }, async () => {
  await shapeTearsDown(
    { argv: ['sh', '-c', 'node {LISTENER} & wait'] },
    'a listener left behind by `& wait`',
  );
});

// The wrapper acknowledges SIGTERM and leaves five seconds later, which is past
// the polite window. A leader-only escalation then SIGKILLs the wrapper and the
// listener it started keeps the port.
posixTest('a dev server behind a slow SIGTERM trap is torn down and gives its port back', { timeout: TEST_TIMEOUT_MS }, async () => {
  await shapeTearsDown(
    { argv: ['node', '{DIR}/wrapper.js'], slowTrap: true },
    'a listener behind a wrapper that shuts down slowly',
  );
});

// The everyday monorepo dev script: npm, its shell, and the listener the script
// backgrounded. Three levels, and the port is at the bottom.
posixTest('a dev server backgrounded inside an npm script is torn down and gives its port back', { timeout: TEST_TIMEOUT_MS }, async () => {
  await shapeTearsDown(
    { argv: ['npm', 'run', 'dev', '--silent'], scripts: { dev: 'node {LISTENER} & wait' } },
    'a listener backgrounded by an npm script',
  );
});

// ── the two halves of `teardownComplete`, each with the other satisfied ──────
//
// Every shape above presents both facts TOGETHER: the group dies and the port
// comes back, within one poll of each other. So each of them passes on either
// half alone, and a mutation replacing the port conjunct with `true` survived
// all six tests in this file — a fair report that the group check was carrying
// them, and no evidence at all about the port.
//
// The conjunction is the postcondition, and the two questions differ exactly
// when the port's holder is not in the group the runner created — a `setsid`
// escapee on POSIX, and EVERY WINDOWS RUN, where there is no group to ask about
// and `treeIsGone` degrades to the leader's own exit. The leader on Windows is
// the `cmd /d /s /c` shim, so a leader-only "gone" is the false answer this file
// exists to reject.
//
// Neither row below can be produced by a wrapper shape, because a wrapper cannot
// hold one fact still while the other moves. They are driven straight at
// `teardownComplete` with a small budget, so each asserts the same thing: with
// one half unsatisfied, teardown must NOT report itself complete. Both would
// also fail if their half were deleted outright rather than mutated.
posixTest('teardown does not report itself complete while the port is still held', { timeout: TEST_TIMEOUT_MS }, async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => { holder.listen(0, '127.0.0.1', () => resolve()); });
  const port = (holder.address() as net.AddressInfo).port;
  try {
    // Tree gone by every reading the runner has: no group to ask about, and a
    // leader that has already exited. Only the port is still held.
    const owned = {
      pgid: null,
      child: { exitCode: 0, signalCode: null },
      targetPort: port,
    } as unknown as OwnedServer;
    assert.equal(await portIsFree(port), false, 'fixture guard: the port must be held for this to say anything');
    assert.equal(
      await teardownComplete(owned, 60),
      false,
      'a port the next run cannot bind is not a completed teardown, whatever the group says',
    );
    await new Promise<void>((resolve) => { holder.close(() => resolve()); });
    assert.equal(
      await teardownComplete(owned, 60),
      true,
      'and the same pair must complete the moment the port comes back, or the row above proves only that this always answers false',
    );
  } finally {
    try { holder.close(); } catch { /* already closed */ }
  }
});

posixTest('teardown does not report itself complete while the group still has members', { timeout: TEST_TIMEOUT_MS }, async () => {
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid!;
  track([child.pid], pgid);
  try {
    // The port half is satisfied outright — no upstream port to give back — so
    // only the group can hold this open.
    const owned = { pgid, child, targetPort: undefined } as unknown as OwnedServer;
    assert.equal(
      await teardownComplete(owned, 60),
      false,
      'a live group is a leftover this runner owns, even with no port to wait for',
    );
    process.kill(-pgid, 'SIGKILL');
    const deadline = Date.now() + TEARDOWN_BUDGET_MS;
    while (alive(child.pid!) && Date.now() < deadline) await sleep(25);
    assert.equal(
      await teardownComplete(owned, 60),
      true,
      'and must complete once the group is gone, or the row above proves only that this always answers false',
    );
  } finally {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
});

// THE INTERRUPT DOOR, which the browser lane did not have at all.
//
// `detached` is what makes the group kills addressable and, on its own, what
// stops a Ctrl-C from reaching the tree. Before it, the dev server shared the
// runner's foreground group, so an interrupt reached it BY ACCIDENT; adding
// `detached` without registering a reaper would have closed the teardown leak and
// opened an interrupt leak of the same shape, with a whole dev server behind it.
// Driven through a REAL child runner, because what is under test is a
// `process.on` in a process that is being signalled.
posixTest('an interrupted browser run takes its dev server with it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const module = path.join(repoRoot, 'src/runners/qa-evidence/server.ts');
  assert.ok(fs.existsSync(module), `fixture guard: the driver must import the real module, not ${module}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-server-int-'));
  let listenerPid = 0;
  let pgid = 0;
  try {
    // The background-job shape, which is the cheapest of the three that leak.
    const { argv, pidFile } = project(dir, { argv: ['sh', '-c', 'node {LISTENER} & wait'] });
    const ready = path.join(dir, 'ready.json');
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      "import * as fs from 'fs';",
      `import { startCommandServer } from ${JSON.stringify(module)};`,
      `const owned = await startCommandServer({ projectRoot: ${JSON.stringify(dir)}, runId: 'int', `
        + `timeoutMs: 15000, serverCommandJson: ${JSON.stringify(JSON.stringify(argv))} }, `
        + "{ sourceHash: 's', fingerprint: 'f', manifest: { files: [], manifestHash: 'b', outputRoot: '.' } });",
      `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pgid: owned.pgid, port: owned.targetPort }));`,
      // Never torn down from inside: the interrupt is what has to do it.
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const runner = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    track([runner.pid]);
    let runnerStderr = '';
    runner.stderr?.on('data', (chunk: Buffer) => { runnerStderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
    try {
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(50);
      assert.ok(
        fs.existsSync(ready),
        `fixture guard: the driver never got a dev server up. Its stderr was: ${runnerStderr.trim() || '(none)'}`,
      );
      const started = JSON.parse(fs.readFileSync(ready, 'utf8')) as { pgid: number; port: number };
      pgid = started.pgid;
      listenerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      track([listenerPid], pgid);
      assert.ok(listenerPid > 1 && alive(listenerPid), 'fixture guard: the dev server must be up before the interrupt');
      process.kill(runner.pid!, 'SIGINT');
      await exited;
      // The runner must still DIE from the signal it handled: a reaper that
      // swallowed SIGINT would be a worse bug than the orphan it prevents.
      assert.equal(runner.signalCode, 'SIGINT', `an interrupted runner must not survive its own interrupt handler, exited ${String(runner.exitCode)}`);
      const budget = Date.now() + TEARDOWN_BUDGET_MS;
      while (alive(listenerPid) && Date.now() < budget) await sleep(25);
      assert.equal(alive(listenerPid), false, 'a Ctrl-C during a browser run must take the dev server with it');
      assert.equal(await portIsFree(started.port), true, 'and must leave the port bindable');
      assertNoUnaddressableLeftover(pgid, 'an interrupted browser run');
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    }
  } finally {
    if (listenerPid > 1 && alive(listenerPid)) {
      try { process.kill(listenerPid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (pgid > 1) {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE HEAVIEST SURVIVOR THIS RUNNER CAN LEAVE.
//
// Lighthouse is a Node CLI that launches a Chrome, so its leftover is a browser
// with a renderer and a GPU process behind it, holding a debugging port and a
// profile directory. Structurally it is the same defect as the dev server — the
// process the runner spawned is not the process that matters — and it had the
// same leader-only kill.
//
// The stand-in is `sh` backgrounding a node script, because what makes the defect
// is the SHAPE (the wrapper exits, the browser does not) and not Chrome itself. A
// real Chrome would make this test require a browser download to say anything.
posixTest('a Lighthouse run that exits takes the browser it started with it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-lh-'));
  let chromePid = 0;
  try {
    const pidFile = path.join(dir, 'chrome.pid');
    const chrome = path.join(dir, 'chrome.js');
    fs.writeFileSync(chrome, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
    // The wrapper waits for its browser to announce itself and then exits 0,
    // which is the path that used to reap nothing at all: `runBoundedCommand`
    // resolved on the wrapper's `exit` and killed only on its timeout.
    const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(chrome)} &\n`
      + `while [ ! -s ${JSON.stringify(pidFile)} ]; do sleep 0.02; done\n`;
    await runBoundedCommand('/bin/sh', ['-c', script], dir, 20_000);
    chromePid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(chromePid > 1, 'fixture guard: the stand-in browser never started');
    track([chromePid]);
    const deadline = Date.now() + TEARDOWN_BUDGET_MS;
    while (alive(chromePid) && Date.now() < deadline) await sleep(25);
    assert.equal(
      alive(chromePid),
      false,
      'a Lighthouse audit that finished must not leave its browser running — it holds a debugging port, and '
      + 'the next audit is handed a port by the same allocator',
    );
  } finally {
    if (chromePid > 1 && alive(chromePid)) {
      try { process.kill(chromePid, 'SIGKILL'); } catch { /* gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
