// src/runners/qa-evidence/__tests__/server-command-shim.test.ts
// WHICH FILE `startCommandServer` hands to `spawn` for a dev server whose
// command begins with a package-manager wrapper.
//
// The runner's own usage line (cli.ts:135) and the browser-qa skill both tell a
// caller to pass `["pnpm","exec","next","start","-H","127.0.0.1","-p","{PORT}"]`,
// and node refuses BOTH Windows spellings of that first element before a child
// exists. `pnpm.cmd` is answered with UV_EINVAL in src/process_wrap.cc, whose
// `IsWindowsBatchFile` (src/util-inl.h) matches any last extension `cmd` or
// `bat` and never consults the shell option — and `shell: false` is what this
// spawn passes anyway. A bare `pnpm` never reaches that check and dies one layer
// down: libuv's PATH search appends only `.com` and `.exe` and deliberately
// ignores PATHEXT (deps/uv/src/win/process.c, `path_search_walk_ext`).
//
// Neither failure is a timeout, and neither is caught. This spawn attaches no
// `error` listener, so the refusal arrives as an UNCAUGHT `spawn pnpm ENOENT`
// that ends the runner mid-run — the dev server being the thing that holds the
// port every later check answers against.
//
// Reachable from POSIX the way __tests__/spawn-plan.test.ts and
// __tests__/bounded-command-shim.test.ts reach the same branch for the native
// path and for the audit: the platform is a parameter, so the plan can be built
// for win32 from darwin. What is proved here is the half those two cannot — that
// the SPAWN uses the plan, read off a server that really came up — and it is
// read from `child.spawnfile`, which is the file libuv was handed.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { escapeCmdArgument, escapeCmdCommand } from '../../../shared/spawn-tool';
import { spawnPlan } from '../native-process';
import { startCommandServer, stopOwnedServer } from '../server';
import { type OwnedServer, type RunnerArgs } from '../types';

/**
 * The shell this host would name, restored in the `after` hook below as well as
 * in every row's `finally` — because a row that is ABANDONED (an uncaught spawn
 * error, which is precisely what the routing prevents) never reaches its own
 * cleanup, and the rows here point ComSpec at a stand-in.
 */
const ORIGINAL_COMSPEC = process.env.ComSpec;

/**
 * The live rows need a POSIX shell to stand in for cmd.exe and a process group
 * to tear down, exactly as __tests__/server-teardown.test.ts:40 does. The win32
 * BRANCH is still exercised on every machine that runs this file — that is what
 * the platform parameter is for — and the row below that needs no child runs
 * everywhere.
 */
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX shells and process groups' : false };
const TEST_TIMEOUT_MS = 30_000;

const TRACKED_PIDS = new Set<number>();
const TRACKED_GROUPS = new Set<number>();
const TRACKED_SERVERS = new Set<OwnedServer['server']>();

// Same reason as __tests__/server-teardown.test.ts:77 — a timed-out test never
// reaches its own `finally`, and the proxy this returns is a live handle in the
// test process, so a regression here has to fail the suite rather than hang it.
after(() => {
  for (const pgid of TRACKED_GROUPS) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const pid of TRACKED_PIDS) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const server of TRACKED_SERVERS) {
    try { server.unref(); server.close(); } catch { /* already closed */ }
  }
  if (ORIGINAL_COMSPEC === undefined) delete process.env.ComSpec;
  else process.env.ComSpec = ORIGINAL_COMSPEC;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bindable? The question `portIsFree` in server.ts asks, asked the same way. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => { probe.close(() => resolve(true)); });
  });
}

interface Fixture {
  dir: string;
  /** The stand-in for cmd.exe: a shell that records its argv and serves. */
  comspec: string;
  argvFile: string;
  pidFile: string;
  /** The absolute batch shim the runner is told to start. Never exists. */
  shim: string;
}

/**
 * A project whose dev server announces its pid, plus a stand-in cmd.exe.
 *
 * The stand-in reproduces the SHAPE Windows will have after the fix rather than
 * cmd.exe's parsing: the spawned leader is a shell, the listener is its child,
 * and the argv the shell was handed is recorded verbatim so the assertions can
 * be about what the process RECEIVED and not only about what node was asked
 * for. It ignores `/d /s /c` and the assembled line for the same reason the
 * teardown fixtures ignore what a real dev server does — the subject is who
 * reaches the listener, not what a batch file means.
 */
function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-srv-shim-'));
  const pidFile = path.join(dir, 'listener.pid');
  const argvFile = path.join(dir, 'shell-argv.txt');
  const listener = path.join(dir, 'listener.js');
  const comspec = path.join(dir, 'stand-in-cmd.sh');
  fs.writeFileSync(listener, [
    "const http = require('http');",
    "const fs = require('fs');",
    "http.createServer((request, response) => { response.writeHead(200); response.end('ok'); })",
    `  .listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));`,
    'setTimeout(() => {}, 600000);',
    '',
  ].join('\n'));
  fs.writeFileSync(comspec, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
    `${JSON.stringify(process.execPath)} ${JSON.stringify(listener)} &`,
    'wait',
    '',
  ].join('\n'));
  fs.chmodSync(comspec, 0o755);
  return {
    dir,
    comspec,
    argvFile,
    pidFile,
    // Absolute with nothing behind it, so the win32 resolver keeps the name it
    // was given — its own branches are spawn-tool's, pinned there.
    shim: path.join(dir, 'node_modules', '.bin', 'dev.cmd'),
  };
}

interface Started {
  owned: OwnedServer;
  listenerPid: number;
  targetPort: number;
  shellArgv: string[];
}

const LOADED_RUN = {
  sourceHash: 'source',
  fingerprint: 'fingerprint',
  manifest: { files: [], manifestHash: 'build', outputRoot: '.' },
} as never;

async function start(
  fix: Fixture,
  argv: readonly string[],
  platform: NodeJS.Platform,
): Promise<Started> {
  const args = {
    command: 'browser',
    projectRoot: fix.dir,
    runId: 'server-shim-probe',
    buildDir: 'dist',
    withLighthouse: false,
    timeoutMs: 15_000,
    serverCommandJson: JSON.stringify(argv),
  } as unknown as RunnerArgs;
  const owned = await startCommandServer(args, LOADED_RUN, platform);
  TRACKED_SERVERS.add(owned.server);
  if (typeof owned.pgid === 'number') TRACKED_GROUPS.add(owned.pgid);
  if (typeof owned.child?.pid === 'number') TRACKED_PIDS.add(owned.child.pid);
  const deadline = Date.now() + 5_000;
  let listenerPid = 0;
  while (Date.now() < deadline && listenerPid <= 0) {
    try { listenerPid = Number(fs.readFileSync(fix.pidFile, 'utf8')); } catch { /* not up yet */ }
    if (listenerPid <= 0) await sleep(25);
  }
  assert.ok(listenerPid > 1, 'fixture guard: the dev server never announced its pid');
  TRACKED_PIDS.add(listenerPid);
  assert.ok(typeof owned.targetPort === 'number', 'the pair must carry the upstream port it has to give back');
  return {
    owned,
    listenerPid,
    targetPort: owned.targetPort!,
    shellArgv: fs.existsSync(fix.argvFile)
      ? fs.readFileSync(fix.argvFile, 'utf8').replace(/\n$/, '').split('\n')
      : [],
  };
}

function sweep(fix: Fixture, started: Started | null): void {
  if (started) {
    try { started.owned.server.unref(); started.owned.server.close(); } catch { /* already closed */ }
    for (const pid of [started.listenerPid, started.owned.child?.pid ?? 0]) {
      if (pid > 1 && alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    if (typeof started.owned.pgid === 'number') {
      try { process.kill(-started.owned.pgid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  fs.rmSync(fix.dir, { recursive: true, force: true });
}

/**
 * THE BRANCH, read off a server that really started.
 *
 * `spawnfile` is the file libuv was handed, so it separates the two claims
 * __tests__/spawn-plan.test.ts cannot: that the plan is right, and that this
 * spawn uses it. A shim reaching `spawn` unwrapped leaves `dev.cmd` here — and
 * on Windows leaves no child at all.
 */
test('on win32 a batch-shim dev server is handed to the shell, never spawned as itself', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = fixture();
  const previousComspec = process.env.ComSpec;
  let started: Started | null = null;
  try {
    // The stand-in is named through ComSpec because that is where `spawnPlan`
    // reads the shell from, on Windows and here alike.
    process.env.ComSpec = fix.comspec;
    const argv = [fix.shim, 'start', '--port', '{PORT}', '--flags=--headless --no-sandbox'];
    started = await start(fix, argv, 'win32');

    assert.equal(started.owned.child?.spawnfile, fix.comspec, 'the spawned file must be the shell');
    assert.notEqual(
      started.owned.child?.spawnfile,
      fix.shim,
      'a .cmd must never be the spawned file — node answers UV_EINVAL for one, whatever shell says',
    );
    // What the shell actually received, not what node was asked for: `/d` skips
    // AutoRun, `/s` strips the outer quote pair, `/c` runs and exits, and the
    // whole command must arrive as ONE argument.
    assert.deepEqual(started.shellArgv.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(started.shellArgv.length, 4, 'the command line must reach cmd.exe as a single token');
    // Compared against spawn-tool's own escaping, because the claim is
    // "identical to what that module already executes on Windows"; a literal
    // typed here could only pin a copy of it. The space inside the last flag is
    // the silent half: unescaped, cmd.exe would hand the dev server a
    // `--no-sandbox` it never asked for.
    const planned = [
      escapeCmdCommand(fix.shim),
      ...['start', '--port', String(started.targetPort), '--flags=--headless --no-sandbox']
        .map((arg) => escapeCmdArgument(arg)),
    ].join(' ');
    assert.equal(started.shellArgv[3], `"${planned}"`);
    assert.ok(
      !started.shellArgv[3]!.includes('--headless --no-sandbox'),
      'the space inside the flag must be escaped, or it arrives as two arguments',
    );
    // `{PORT}` is substituted BEFORE the plan is built, so the allocated port
    // has to survive the escaping as a literal — a dev server told to listen
    // somewhere else is a proxy pointed at nothing.
    assert.match(started.shellArgv[3]!, new RegExp(String(started.targetPort)));
    // And the whole pair works: the proxy in front of a shell-led dev server
    // serves, which is what a routed spawn has to keep true.
    assert.equal((await fetch(`${started.owned.url}/`)).status, 200);
  } finally {
    if (previousComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComspec;
    sweep(fix, started);
  }
});

/**
 * The teardown the fix makes REACHABLE for the first time.
 *
 * On Windows this spawn was refused before a leader existed, so
 * `stopOwnedServer` never ran for a command server there and its port-release
 * poll was dead code on that platform. Routed, the leader is the SHELL and the
 * listener is its child — the shape `killWindowsTree` exists for — so the poll
 * is now the only thing standing between a torn-down run and the next run's
 * checks answering against this port. Asserted here in its POSIX form, which is
 * the one this machine can run: teardown must return with the port BINDABLE and
 * the listener gone, not merely with the leader reaped.
 */
test('a shell-led dev server gives its upstream port back before teardown returns', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = fixture();
  const previousComspec = process.env.ComSpec;
  let started: Started | null = null;
  try {
    process.env.ComSpec = fix.comspec;
    started = await start(fix, [fix.shim, 'start', '--port', '{PORT}'], 'win32');
    assert.equal(
      await portIsFree(started.targetPort),
      false,
      'fixture guard: the upstream port must be held while the dev server is up',
    );
    await stopOwnedServer(started.owned);
    assert.equal(
      await portIsFree(started.targetPort),
      true,
      'teardown returned with the upstream port still bound, so the next run would answer against this build',
    );
    assert.equal(
      alive(started.listenerPid),
      false,
      'the listener behind the shell outlived teardown — a leader-only kill reaches the shell and stops there',
    );
  } finally {
    if (previousComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComspec;
    sweep(fix, started);
  }
});

/**
 * The POSIX side, unchanged — and asserted, so the rows above cannot pass for a
 * reason that has nothing to do with the platform.
 *
 * `spawnPlan` is a passthrough off win32, so the file spawned is the command's
 * own first element: byte-identical to the `spawn(command[0], command.slice(1))`
 * this did before the branch existed, which is the whole safety argument for
 * adding it. ComSpec is deliberately left pointing at the stand-in, so a plan
 * that reached the shell here would be visible.
 */
test('off win32 the dev-server command is spawned exactly as it came in', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = fixture();
  const previousComspec = process.env.ComSpec;
  let started: Started | null = null;
  try {
    process.env.ComSpec = fix.comspec;
    started = await start(fix, ['/bin/sh', fix.comspec], process.platform);
    assert.equal(started.owned.child?.spawnfile, '/bin/sh', 'off Windows nothing may be rewritten');
    // The stand-in runs here too — as the script `/bin/sh` was given, with no
    // arguments of its own — so what must be absent is the cmd.exe argv, not
    // the recording.
    assert.deepEqual(
      started.shellArgv.filter(Boolean),
      [],
      'no cmd.exe run-and-exit argv may be assembled off Windows',
    );
  } finally {
    if (previousComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComspec;
    sweep(fix, started);
  }
});

/**
 * The SHIPPED shape, planned without spawning anything — the argv cli.ts's usage
 * line and the browser-qa skill both hand a caller, resolved the way a Windows
 * PATHEXT lookup resolves it.
 *
 * This is the input the defect was reported against, and it runs on every
 * platform because it starts no child.
 */
test('the documented pnpm dev-server argv plans onto cmd.exe with its port intact', () => {
  const shipped = ['pnpm', 'exec', 'next', 'start', '-H', '127.0.0.1', '-p', '4173'];
  const plan = spawnPlan(shipped, 'win32', () => 'C:\\Users\\dev\\AppData\\Roaming\\npm\\pnpm.cmd');
  // ComSpec read at call time, as spawn-plan.test.ts reads it: the claim is
  // that the plan names THE SHELL, not a particular host's path to one.
  assert.equal(
    plan.file,
    process.env.ComSpec || 'cmd.exe',
    'a package-manager wrapper resolves to a .cmd, which cannot be the spawned file',
  );
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.verbatim, true, 'a pre-assembled command line must not be re-quoted by libuv');
  assert.match(plan.args[3]!, /4173/, 'the substituted port must reach the shell line');
});
