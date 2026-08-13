// src/runners/qa-evidence/server.ts
// The owned listener: hash-verified static server, the command-server
// proxy, port allocation, and paired start/stop.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { createServer, type Server } from 'http';
import * as path from 'path';
import {
  contentHash,
} from '../../shared/qa-evidence-runtime';
import {
  QA_BUILD_IDENTITY_PROBE_PATH,
} from '../../shared/qa-report-v2';
import { openRegularFd } from '../../shared/bounded-read';
import { sha256 } from '../../shared/text';

import {
  MAX_PROXY_BODY_BYTES,
  type OwnedServer,
  type Rec,
  type RunnerArgs,
} from './types';
import { parseBoundedArgv } from './bounded-argv';
import { spawnPlan, spawnRefusalKind, type BoundedProcessKind } from './native-process';
import {
  GROUP_KILLS_AVAILABLE,
  groupHasMembers,
  killProcessGroup,
  reapOnInterrupt,
  spawnedGroupId,
} from './process-group';
import {
  type LoadedRun,
  safeProjectRelative,
} from './run-context';

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function listen(server: Server): Promise<{ port: number; startedAt: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPromise(new Error('listener did not expose a TCP port'));
        return;
      }
      resolvePromise({ port: address.port, startedAt: new Date().toISOString() });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function identityBody(
  args: RunnerArgs,
  loaded: LoadedRun,
  port: number,
  startedAt: string,
): Rec {
  return {
    schemaVersion: 1,
    runId: args.runId,
    sourceHash: loaded.sourceHash,
    buildHash: loaded.manifest.manifestHash,
    pid: process.pid,
    port,
    startedAt,
    url: `http://127.0.0.1:${port}`,
    fingerprint: loaded.fingerprint,
  };
}

export async function startStaticServer(
  args: RunnerArgs,
  loaded: LoadedRun,
): Promise<OwnedServer> {
  const outputRoot = path.resolve(args.projectRoot, loaded.manifest.outputRoot);
  const knownFiles = new Map(loaded.manifest.files.map((file) => [file.path, file.sha256]));
  const servedAssetHashes = new Set<string>();
  let identity: Rec | null = null;
  const server = createServer((request, response) => {
    const requested = request.url || '/';
    if (requested.split('?')[0] === QA_BUILD_IDENTITY_PROBE_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(identity));
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(requested, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    const rawRel = pathname.replace(/^\/+/, '') || 'index.html';
    const candidates = [rawRel, `${rawRel}.html`, path.posix.join(rawRel, 'index.html'), 'index.html'];
    const rel = candidates.find((candidate) => knownFiles.has(candidate));
    if (!rel) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    const absolute = path.resolve(outputRoot, rel);
    const boundary = path.relative(outputRoot, absolute);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const expectedHash = knownFiles.get(rel)!;
    if (contentHash(absolute) !== expectedHash) {
      response.writeHead(409);
      response.end('Build output changed after manifest capture');
      return;
    }
    servedAssetHashes.add(expectedHash);
    response.writeHead(200, { 'content-type': contentType(absolute), 'cache-control': 'no-store' });
    // Streamed FROM A DESCRIPTOR the leaf proved regular, not from the path: a
    // FIFO under the served web root made `createReadStream(path)` hang the
    // preview server for as long as anybody kept the connection (DRIVEN,
    // 4 005 ms SIGKILL against a 55 ms control). With the fd in hand the stream
    // never opens anything.
    fs.createReadStream(absolute, { fd: openRegularFd(absolute), autoClose: true }).pipe(response);
  });
  const listening = await listen(server);
  identity = identityBody(args, loaded, listening.port, listening.startedAt);
  return {
    server,
    mode: 'runtime-static',
    url: String(identity.url),
    port: listening.port,
    startedAt: listening.startedAt,
    servedAssetHashes,
  };
}

function freePort(): Promise<number> {
  const server = createServer();
  return listen(server).then(async ({ port }) => {
    await closeServer(server);
    return port;
  });
}

/**
 * How long teardown waits for the port, either side of the escalation.
 *
 * Sized against the run it lengthens, because every browser run pays it. The
 * SIGTERM budget is the 1 s the leader's `exit` was already given, so the polite
 * half costs nothing it did not cost before — and the poll RETURNS AS SOON AS
 * the port binds and the group is gone, so a dev server that lets go promptly
 * pays a poll interval or two rather than the budget. Measured over the four
 * wrapper shapes: 26, 28 and 32 ms for the three that leave promptly, against
 * 1–4 ms before for a leader whose `exit` was the only thing waited on — 28 ms
 * is what this costs a browser run — and 1036 ms for the wrapper that traps
 * SIGTERM and stays, against 1002 ms before for a stop that returned with the
 * listener still running.
 *
 * The SIGKILL budget is the only new ceiling, and it is reached only by a server
 * that both ignored SIGTERM and outlived a group SIGKILL. 500 ms is roughly 100x
 * the port release measured after an in-group SIGKILL, and it is the number
 * `FORCED_KILL_GRACE_MS` picks for the same job on the native path.
 *
 * The interval is a compromise between the two: 25 ms is invisible next to a
 * browser run and still resolves the common case in one hop.
 */
const SERVER_TERM_PORT_BUDGET_MS = 1_000;
const SERVER_KILL_PORT_BUDGET_MS = 500;
const PORT_POLL_INTERVAL_MS = 25;

/**
 * Can this port be BOUND right now? The teardown question, asked exactly the
 * way the next run will ask it.
 *
 * `stopOwnedServer` used to resolve on the leader's `exit`, which says nothing
 * about the port: the whole defect is that the leader exits while the listener
 * it started keeps the port at `ppid 1`, and the incident at
 * plan-guard/plan-readiness/completion.ts:642 is the next run's checks then
 * answering against it. So teardown waits on the resource rather than on the
 * process, and it tests availability by BINDING — the same call, on the same
 * address, that `freePort` and the next dev server will make.
 *
 * A TIME_WAIT socket answers `true` here, and that is correct rather than a
 * gap: libuv sets SO_REUSEADDR on every TCP bind and Node exposes no way to
 * turn it off, so a port held only by TIME_WAIT is one the kernel WILL hand to
 * the next listener. `false` therefore means what teardown needs it to mean —
 * something is still LISTENing. It must stay this way: `freePort` is already
 * TOCTOU (it binds `:0`, closes, and returns the number), and the backstop for
 * a stale server answering on a recycled port is the served-fingerprint check,
 * not this.
 *
 * WINDOWS IS THE EXCEPTION, and routing the spawn above is what made this
 * reachable there at all — before it, no command server ever started on that
 * platform, so no teardown of one ever ran. libuv sets NEITHER SO_REUSEADDR nor
 * SO_EXCLUSIVEADDRUSE on a Windows bind (deps/uv/src/win/tcp.c,
 * `uv__tcp_try_bind`: the first would let a LIVE listener be stolen, the second
 * would reject a port that only TIME_WAIT holds), so the bind gets the platform
 * default and a port still carrying TIME_WAIT entries from the proxy's own
 * requests answers `false` for as long as it holds them. That costs teardown
 * its budget, not its correctness: this wait only gates the SIGKILL escalation,
 * and that escalation is already a no-op on Windows, where the polite phase is
 * a `TerminateProcess` and `killWindowsTree` will not walk from a leader it has
 * already reaped. KNOWN-ISSUES.md §6.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => { probe.close(() => resolvePromise(true)); });
  });
}

/** Nothing of this pair is left running that a host signal could not reach. */
function treeIsGone(owned: OwnedServer): boolean {
  if (typeof owned.pgid === 'number') return !groupHasMembers(owned.pgid);
  // No group to ask about: Windows, or a pair built before there was one. The
  // leader is then the only thing that was ever addressable.
  return !owned.child || owned.child.exitCode !== null || owned.child.signalCode !== null;
}

/**
 * Teardown is TWO facts, and stopping at either one alone leaks.
 *
 * The port is what the next run needs, and it is the one the old code never
 * checked. But a process that released its port and stayed — a wrapper that
 * trapped SIGTERM to shut down slowly, and there is one in the shapes measured —
 * is a leftover in a group that `detached` has put beyond the reach of a
 * terminal Ctrl-C and a harness's `kill -TERM -<pgid>` alike. That is the round-2
 * regression, and waiting on the port alone would reintroduce it for exactly the
 * wrapper shape that motivated this.
 *
 * THE PORT HALF WAS RE-EXAMINED because a mutation replacing `portBack` with
 * `true` survived all six teardown tests, which is a fair report that the group
 * half alone carried every fixture then present. It is KEPT, on two grounds
 * neither of which is the setsid escapee (that one is genuinely marginal — the
 * port cannot be reclaimed from here either way, so all the wait buys there is
 * an honest `false`):
 *
 * 1. `treeIsGone` is only as good as the GROUP. Where `owned.pgid` is null it
 *    degrades to the leader's own exit — which is every Windows run, since
 *    `GROUP_KILLS_AVAILABLE` is false there and the leader is the `cmd /d /s /c`
 *    shim rather than the server. A leader-only "gone" is precisely the false
 *    answer this whole file exists to reject, and on that path the port is the
 *    ONLY evidence that the listener let go.
 * 2. The two halves answer different questions and it is their CONJUNCTION that
 *    is the postcondition: the group answers "is anything we started still
 *    running", the port answers "can the next run bind". They diverge exactly
 *    when the holder is not in our group, which is the case teardown cannot
 *    otherwise see at all.
 *
 * ITS COST IS NOT THE 26-32 ms it was charged with. That figure is the whole
 * teardown wait, and it is one `PORT_POLL_INTERVAL_MS` — spent because the first
 * pass runs microseconds after the SIGTERM, when the TREE is not gone yet, so
 * the group half pays it too and would keep paying it alone. The incremental
 * cost of this conjunct is one loopback bind+close per poll iteration: measured
 * over 300 samples each, 0.032 ms median free / 0.030 ms held (p95 0.089 /
 * 0.058), three orders of magnitude below the interval it sits inside.
 *
 * Both halves are now pinned INDEPENDENTLY in __tests__/server-teardown.test.ts,
 * each with the other's fact satisfied, so neither mutant survives on the
 * other's evidence. Exported for exactly that: the four wrapper shapes drive
 * this through `stopOwnedServer`, but they can only ever present the two facts
 * TOGETHER, which is why a mutation to either half survived all of them.
 */
export async function teardownComplete(owned: OwnedServer, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const portBack = typeof owned.targetPort !== 'number' || await portIsFree(owned.targetPort);
    if (portBack && treeIsGone(owned)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, PORT_POLL_INTERVAL_MS));
  }
}

export async function waitForHttp(
  url: string,
  timeoutMs: number,
  /**
   * Consulted between polls: a reason this wait can NEVER succeed, which ends it
   * at once instead of spending the whole bound proving what is already known.
   *
   * A dev server that was refused by the operating system is the only caller —
   * see `startCommandServer`. Threaded in rather than raced against, because a
   * race leaves this loop polling a port nothing will ever bind for the rest of
   * the bound, on 100 ms timers nobody unrefs: the runner would print its
   * verdict and then hold the process open for up to `--timeout-ms` more. The
   * cost of asking here instead is one poll interval of latency on a failure
   * that has already given up.
   */
  giveUp: () => Error | null = () => null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fatal = giveUp();
    if (fatal) throw fatal;
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // keep waiting for the child listener
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`server command did not listen within ${timeoutMs}ms`);
}

/**
 * A server command the operating system REFUSED, classified as the same
 * rejection the readiness timeout produces.
 *
 * Nothing here used to attach an `error` listener, so the refusal arrived as an
 * UNCAUGHT event that ended the runner mid-run: `main`'s catch never printed a
 * verdict, `browserCommand`'s teardown never ran, and the dev server and its
 * group were never torn down. A caller saw a crashed process where every line
 * of the surrounding code reads an inconclusive one.
 *
 * The RUN LOCK is not part of that, and the sentence that said it was has been
 * removed rather than kept as colour. An uncaught exception does skip `main`'s
 * `finally`, so the lock file really is left on disk — but `lock.ts` reclaims
 * any lock whose holder is not alive, and the holder here is the process that
 * just died, so the next run acquires it. Across processes that claim can only
 * come true through pid recycling, which is not what was measured. What this
 * listener actually fixes is a runner that ends mid-run with no verdict and no
 * teardown, and that is enough.
 *
 * Measured on darwin with an ordinary missing binary, so it was never the
 * Windows-only case the shim routing made it look like: node delivers
 * ENOENT — and EACCES, EAGAIN, EMFILE, ENFILE — asynchronously on the child
 * (internal/child_process.js hands exactly those five to `process.nextTick`),
 * while everything else, the UV_EINVAL a `.cmd` earns among it, is THROWN out of
 * `spawn` and was already caught by this being an async function.
 *
 * `kind` comes from `spawnRefusalKind`, the SAME function
 * `runBoundedProcess`'s own `error` listener calls, so the runner's three
 * long-lived spawns cannot acquire two answers for one state. That agreement
 * used to be asserted here and was false: this path mapped all five errnos to
 * `unavailable` while its sibling mapped ENOENT and called the other four
 * `completed` — "ran to a verdict" — which is the false green round 5 was
 * opened on. A claim of agreement between two files is worth nothing unless one
 * of them cannot answer without the other; now neither can.
 *
 * It rides on the error rather than being returned, because a rejection is this
 * path's only channel to its caller and the timeout uses it too — both failures
 * have to arrive the same way, or the one that crashes is the one nobody
 * classified.
 *
 * The MESSAGE is where the two part, and they part because their repairs do:
 * "never started" is a wrong command — a typo, an uninstalled package manager,
 * a shim — and "never listened" is a server that ran and did not bind.
 * `cause.message` names the file libuv was handed, which on Windows is cmd.exe
 * rather than anything the caller wrote, so `command[0]` is named beside it.
 */
function serverCommandUnavailable(
  command: readonly string[],
  cause: NodeJS.ErrnoException,
): Error & { kind: BoundedProcessKind } {
  const kind = spawnRefusalKind(cause.code);
  const error = new Error(
    `server command could not be executed: ${cause.message} — \`${command[0]}\` never started, `
    + (kind === 'start-failed'
      // The repair is not the command, so the message must not point at it: the
      // operating system refused THIS process a descriptor or a process slot.
      ? 'because this runner was refused the resources to spawn it, so nothing listened and nothing '
        + 'timed out and nothing about the project was measured'
      : 'so nothing listened and nothing timed out'),
    { cause },
  );
  return Object.assign(error, { kind });
}

function parseServerCommand(raw: string | undefined, port: number): string[] | null {
  const value = parseBoundedArgv(raw);
  return value?.map((entry) => entry.replace(/\{PORT\}/g, String(port))) || null;
}

function readRequestBody(request: import('http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) {
        rejectPromise(new Error('proxy request body exceeded the QA bound'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', rejectPromise);
  });
}

export async function startCommandServer(
  args: RunnerArgs,
  loaded: LoadedRun,
  /**
   * The platform this spawn is planned for, a parameter for the reason
   * `spawnPlan`'s and `runBoundedCommand`'s are: the Windows branch below runs
   * on no machine in this repo or in CI, and it fails as a dev server that
   * never came up — which reads as the project's own server being slow.
   */
  platform: NodeJS.Platform = process.platform,
): Promise<OwnedServer> {
  const targetPort = await freePort();
  const command = parseServerCommand(args.serverCommandJson, targetPort);
  if (!command) throw new Error('--server-command-json must be a bounded JSON argv array');
  const cwdRel = args.serverCwd ? safeProjectRelative(args.projectRoot, args.serverCwd) : null;
  if (args.serverCwd && !cwdRel) throw new Error('--server-cwd must stay inside the project');
  // The dev server gets its own process group for the same reason the bounded
  // native command does, and it is the WORSE case of the two: what the runner
  // spawns is almost never the listener. `npm run dev`, `sh -c '... & wait'` and
  // any wrapper that traps SIGTERM all put the process holding the port one or
  // two levels below the leader, so a signal to the leader alone leaves a
  // listener at `ppid 1` with the port still bound — measured on three of four
  // wrapper shapes. That is the incident at
  // plan-guard/plan-readiness/completion.ts:642 verbatim: it names a leftover
  // PREVIEW SERVER, which is this spawn, not the native one.
  const detached = GROUP_KILLS_AVAILABLE;
  // The command reaches the operating system through the plan the native path
  // and the audit use, never as `command[0]` verbatim, because on Windows the
  // first element of a dev-server argv is a package-manager wrapper and node
  // refuses BOTH spellings of one before a child exists. `pnpm.cmd` is answered
  // with UV_EINVAL in src/process_wrap.cc — `IsWindowsBatchFile` matches any
  // last extension `cmd` or `bat`, it does not consult the shell option, and
  // `shell: false` is what this passes anyway — while a bare `pnpm` never
  // reaches that check and dies one layer down instead: libuv's PATH search
  // appends only `.com` and `.exe` and deliberately ignores PATHEXT
  // (deps/uv/src/win/process.c, `path_search_walk_ext`). Neither is a timeout,
  // and the shipped shape is the refused one: `["pnpm","exec","next","start",…]`
  // is what cli.ts's own usage line and the browser-qa skill both tell a caller
  // to pass. `spawnPlan` resolves the shim PATHEXT-aware and hands cmd.exe the
  // assembled line with spawn-tool's escaping; off Windows it is the
  // `(command[0], command.slice(1))` pair this spawned before.
  const plan = spawnPlan(command, platform);
  const child = spawn(plan.file, plan.args, {
    cwd: cwdRel ? path.join(args.projectRoot, cwdRel) : args.projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(targetPort) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  // A refusal is delivered on the child, one tick after `spawn` returned, so it
  // needs a listener rather than a `try`. Attached IMMEDIATELY, and deliberately
  // with `on` rather than `once`: a `child.kill` that answers EPERM emits here
  // too, out of a teardown path this runner is not allowed to crash out of, and
  // that can happen long after the readiness wait has stopped reading.
  let startFailure: (Error & { kind: BoundedProcessKind }) | null = null;
  child.on('error', (error: NodeJS.ErrnoException) => {
    startFailure = startFailure || serverCommandUnavailable(command, error);
  });
  const pgid = spawnedGroupId(child, detached);
  // `detached` is also what takes this tree out of reach of a Ctrl-C, and the
  // browser lane had no interrupt handling at all — it was covered only by the
  // accident of sharing the runner's group, which is exactly what `detached`
  // removes. Registering here rather than in `stopOwnedServer` is deliberate:
  // the window that matters most is the one before the pair is even returned,
  // where `waitForHttp` can sit for the whole `--timeout-ms` with a dev server
  // already up.
  const stopReaping = reapOnInterrupt(() => { killProcessGroup(pgid, child); });
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  try {
    await waitForHttp(`http://127.0.0.1:${targetPort}/`, args.timeoutMs, () => startFailure);
  } catch (error) {
    // Unconditional, where this used to be guarded on the leader being alive.
    // A server command that dies leaving its listener up is the ordinary
    // background-job shape, and it is the one case that guard suppressed the
    // kill in.
    stopReaping();
    killProcessGroup(pgid, child);
    throw error;
  }

  const manifestHashes = new Set(loaded.manifest.files.map((file) => file.sha256));
  const servedAssetHashes = new Set<string>();
  let identity: Rec | null = null;
  let proxyOrigin = '';
  const server = createServer(async (request, response) => {
    if ((request.url || '').split('?')[0] === QA_BUILD_IDENTITY_PROBE_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(identity));
      return;
    }
    try {
      const target = new URL(request.url || '/', `http://127.0.0.1:${targetPort}`);
      const body = ['GET', 'HEAD'].includes(request.method || 'GET')
        ? undefined
        : await readRequestBody(request);
      const requestHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') requestHeaders[key] = value;
        else if (Array.isArray(value)) requestHeaders[key] = value.join(', ');
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers: requestHeaders,
        ...(body ? { body } : {}),
        redirect: 'manual',
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_PROXY_BODY_BYTES) throw new Error('proxy response exceeded the QA bound');
      const observedHash = createHash('sha256').update(bytes).digest('hex');
      if (manifestHashes.has(observedHash)) servedAssetHashes.add(observedHash);
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!['content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });
      const location = headers.location;
      if (location) {
        const resolved = new URL(location, target);
        if (resolved.origin === target.origin) {
          headers.location = `${proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
        }
      }
      response.writeHead(upstream.status, headers);
      response.end(bytes);
    } catch (error) {
      response.writeHead(502);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  let listening: { port: number; startedAt: string };
  try {
    listening = await listen(server);
  } catch (error) {
    stopReaping();
    killProcessGroup(pgid, child);
    throw error;
  }
  proxyOrigin = `http://127.0.0.1:${listening.port}`;
  identity = identityBody(args, loaded, listening.port, listening.startedAt);
  return {
    server,
    child,
    pgid,
    targetPort,
    stopReaping,
    mode: 'runtime-command',
    url: proxyOrigin,
    port: listening.port,
    startedAt: listening.startedAt,
    servedAssetHashes,
  };
}

/**
 * Give the port back, then stop caring about the process.
 *
 * Three things changed together here, and any two of them without the third is
 * a regression rather than a fix.
 *
 * The kills address the GROUP. A leader-only SIGTERM/SIGKILL left a listener at
 * `ppid 1` on three of the four wrapper shapes that occur in practice — the
 * background job (`sh -c 'node listener.js & wait'`, where a POSIX shell does
 * not forward a signal to a background job), the SIGTERM-trapping wrapper that
 * leaves slower than the grace window, and the ordinary monorepo
 * `npm run dev` over `node listener.js & wait`. Only the shape where the npm
 * script IS the listener ever tore down cleanly.
 *
 * SIGTERM stays FIRST, and that is why `killProcessGroup` needed a signal
 * parameter at all. A dev server asked to stop politely flushes and closes its
 * listening socket; one that is SIGKILLed does neither, and while the kernel
 * reclaims the port either way, the difference shows up in the project's own
 * caches and lockfiles. The escalation to SIGKILL is a second SWEEP, so a
 * server that ignored SIGTERM is still gone.
 *
 * And the wait is on the PORT AND THE GROUP, not on the leader's `exit`. `exit`
 * was never evidence of anything teardown cares about: in every one of the three
 * broken shapes the leader exited promptly and the port stayed bound. See
 * `portIsFree` — a bind attempt is the same question the next run asks — and
 * `teardownComplete` for why the port alone is not enough either.
 *
 * The reaper is deregistered here rather than at the kills, so an interrupt that
 * arrives DURING teardown still finds the group registered. Leaving it
 * registered permanently would be the worse bug: `reapOnInterrupt`'s promise is
 * that a settled run owns nothing on this process, and a leaked SIGINT listener
 * turns a Ctrl-C the host would have died from into one it merely handles.
 */
export async function stopOwnedServer(owned: OwnedServer): Promise<void> {
  await closeServer(owned.server);
  try {
    if (!owned.child) return;
    const pgid = owned.pgid ?? null;
    killProcessGroup(pgid, owned.child, 'SIGTERM');
    if (await teardownComplete(owned, SERVER_TERM_PORT_BUDGET_MS)) return;
    // A gone group that still has not given the port back means the holder LEFT
    // the group — a dev server that called `setsid` itself — which no signal
    // here can reach, and a SIGKILL at an id known to be empty would spend a
    // draw at the pid-reuse window for nothing. KNOWN-ISSUES.md §6.
    if (treeIsGone(owned)) return;
    killProcessGroup(pgid, owned.child, 'SIGKILL');
    await teardownComplete(owned, SERVER_KILL_PORT_BUDGET_MS);
  } finally {
    owned.stopReaping?.();
  }
}
