#!/usr/bin/env node
// src/runners/lighthouse/index.mts
// ESM CLI shell for the traffic-one Lighthouse runner (compiles to
// scripts/lighthouse-runner.mjs — ESM is preserved via the .mts extension, the
// same convention as .cts → .cjs for CommonJS entries). Pure logic lives in
// ./lib; this shell owns the async I/O orchestration: build, preview, the
// Lighthouse run, threshold evaluation, and cleanup. Ported 1:1 from
// scripts/lighthouse-runner.mjs.

import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openRegularFd } from './bounded-read.js';
import {
  DEFAULTS,
  applyContractThresholds,
  type PackageManager,
  buildFingerprintTag,
  classifyRunnerFailure,
  createAuditUrl,
  runScopedOutDir,
  detectPackageManager,
  dlxArgs,
  execArgs,
  findReportHtml,
  findReportJson,
  findFrontendApp,
  findUp,
  lighthouseMissingMessage,
  localLighthouseBin,
  parseArgs,
  parseSummary,
  previewCommandMissingMessage,
  readJson,
  reportBaseName,
  runScriptArgs,
  usage,
} from './lib.js';

interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'pipe' | Array<'ignore' | 'pipe'>; forwardOutput?: boolean; timeoutMs?: number }
type PreviewHandle = ChildProcess | Server;

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // A hung child (headless Chrome that never exits) would otherwise leave
    // this Promise pending forever — the observed indefinite runner hang.
    let timedOut = false;
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.forwardOutput) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.forwardOutput) process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} failed with exit ${code}\n${stderr || stdout}`));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.listen(0, DEFAULTS.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 4173;
      server.close(() => resolvePromise(port));
    });
    server.on('error', rejectPromise);
  });
}

function ensurePreviewBuildArtifacts(appDir: string, kind: 'vite' | 'next' | 'static', staticDir?: string): void {
  if (kind === 'next' && !existsSync(join(appDir, '.next', 'BUILD_ID'))) {
    throw new Error(`Next production build metadata is missing at ${join(appDir, '.next', 'BUILD_ID')}; run the build before Lighthouse preview.`);
  }
  if (kind === 'static') {
    const outDir = staticDir || join(appDir, 'out');
    if (!existsSync(outDir)) {
      throw new Error(`Next static export output is missing at ${outDir}; run the build before Lighthouse preview.`);
    }
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function resolveStaticFile(rootDir: string, requestPath: string): string | null {
  const pathname = decodeURIComponent(requestPath.split('?')[0] || '/');
  const normalized = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const requested = resolve(rootDir, `.${normalized.startsWith('/') ? normalized : `/${normalized}`}`);
  if (requested !== rootDir && !requested.startsWith(`${rootDir}${sep}`)) return null;
  const candidates = [requested];
  try {
    if (statSync(requested).isDirectory()) candidates.unshift(join(requested, 'index.html'));
  } catch {
    if (!extname(requested)) {
      candidates.push(`${requested}.html`, join(requested, 'index.html'));
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function startStaticPreview(staticDir: string, port: number): Promise<Server> {
  const rootDir = resolve(staticDir);
  const server = createHttpServer((req, res) => {
    try {
      const filePath = resolveStaticFile(rootDir, req.url || '/');
      if (!filePath) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('content-type', contentType(filePath));
      // STREAMED FROM A DESCRIPTOR THIS PROCESS PROVED REGULAR, not from the
      // path again. `resolveStaticFile` above already asked `statSync(candidate)
      // .isFile()`, and that answer belongs to the object that was there WHEN IT
      // ASKED: a name swapped for a FIFO between the two calls opens a stream
      // that waits for a writer forever, wedging one libuv threadpool thread per
      // request until file I/O in this process stops entirely. DRIVEN through
      // this server with a swapper flipping the name: 10 of the first 40 requests
      // never answered (aborted at a 5 000 ms deadline, one at 11 210 ms), while
      // the same 60 requests against a stable file answered in 19 ms at worst.
      // `openRegularFd` decides on the DESCRIPTOR, so there is nothing left to
      // substitute; a non-regular shape throws in front of the stream and lands
      // in the 500 below, which is the honest answer — something is there and it
      // is not a page. A file that vanished is still the 404 above.
      createReadStream(filePath, { fd: openRegularFd(filePath) }).pipe(res);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, DEFAULTS.host, () => {
      server.off('error', rejectPromise);
      resolvePromise(server);
    });
  });
}

interface StartedPreview {
  handle: PreviewHandle;
  /**
   * The refusal, once the operating system has delivered one — null on every
   * healthy run, and on the static branch, which needs no child at all.
   *
   * Read by the readiness wait rather than thrown from here, because a spawn that
   * cannot be executed reports it AFTER this function has already returned its
   * handle. See the listener below.
   */
  refused: () => Error | null;
}

async function startPreview(packageManager: PackageManager, appDir: string, port: number, kind: 'vite' | 'next' | 'static', staticDir?: string): Promise<StartedPreview> {
  if (kind === 'static') {
    return { handle: await startStaticPreview(staticDir || join(appDir, 'out'), port), refused: () => null };
  }
  const args = kind === 'next'
    ? execArgs(packageManager, 'next', ['start', '-H', DEFAULTS.host, '-p', String(port)])
    : execArgs(packageManager, 'vite', [
      'preview',
      '--host',
      DEFAULTS.host,
      '--port',
      String(port),
      '--strictPort',
    ]);
  const child = spawn(packageManager, args, {
    cwd: appDir,
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The package manager is named BARE — `pnpm`, `npm`, `yarn`, `bun` — so a host
  // that has not installed the one this project declares refuses this spawn, and
  // node delivers that refusal as an `'error'` EVENT rather than throwing it. With
  // no listener that was an uncaught exception, and this runner's whole contract
  // is that it never exits without a final JSON status line: measured before this
  // listener existed, with `pnpm` off PATH, exit 1 with an unhandled
  // `spawn pnpm ENOENT` on stderr and stdout EMPTY — so the page-speed hook, which
  // parses that line out of stdout, had nothing at all to report.
  //
  // Attached HERE, in the same synchronous block as the spawn, because the
  // alternative rests on queue semantics that are not what they are assumed to
  // be. `spawn` already knows the outcome — `pid` is undefined the moment it
  // returns — but publishes it a turn later, and measured on darwin the event
  // lands after the first microtask checkpoint and before the first
  // `process.nextTick` callback queued beside the spawn, with `exitCode` set to
  // the raw negative errno (-2). A caller attaching the listener after
  // `await startPreview(...)` therefore happens to be in time here and would not
  // be if either half of that ordering moved. Owning the failure channel in the
  // function that owns the spawn needs no such argument.
  let refusal: Error | null = null;
  child.on('error', (error: NodeJS.ErrnoException) => {
    refusal = refusal || new Error(previewCommandMissingMessage(packageManager, error.message), { cause: error });
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  return { handle: child, refused: () => refusal };
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  /**
   * Consulted between polls: a reason this wait can never succeed, which ends it
   * at once rather than spending the whole budget proving what is already known.
   *
   * Threaded in rather than raced against the wait, and the difference is
   * measurable rather than aesthetic: `delay` here is a REF'D timer, so a race
   * that rejected early would leave this loop polling a port nothing will ever
   * bind — up to 90 s for a Next preview — and the runner would print its status
   * line and then refuse to exit. Asking here costs one poll interval on a
   * failure that has already given up.
   */
  giveUp: () => Error | null = () => null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fatal = giveUp();
    if (fatal) throw fatal;
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Retry until the preview server is ready.
    }
    await delay(250);
  }
  throw new Error(`Preview did not become ready within ${timeoutMs}ms: ${url}`);
}

async function runLighthouse({ appDir, rootDir, packageManager, url, outDir, lighthouseVersion, lighthouseTimeoutMs, localOnly }: {
  appDir: string; rootDir: string; packageManager: PackageManager; url: string; outDir: string; lighthouseVersion: string; lighthouseTimeoutMs: number; localOnly: boolean;
}): Promise<{ jsonPath: string; htmlPath: string | null }> {
  mkdirSync(outDir, { recursive: true });
  // Run-scoped directory + build-stamped file name: an artefact must say which
  // run and which build it measured, or a stale score gets quoted as this one.
  const baseName = reportBaseName(url, buildFingerprintTag(rootDir, appDir));
  const outputBase = join(outDir, baseName);
  const lighthouseArgs = [
    url,
    // All four default categories: the perf trace dominates audit time anyway,
    // and accessibility/best-practices/seo scores ride the same run for free —
    // restricting to performance made their summary fields permanently null.
    '--only-categories=performance,accessibility,best-practices,seo',
    '--chrome-flags=--headless --no-sandbox',
    '--output=json',
    '--output=html',
    `--output-path=${outputBase}`,
    '--quiet',
  ];
  const localBin = localLighthouseBin(rootDir, appDir);
  if (localBin) {
    await runCommand(localBin, lighthouseArgs, { cwd: appDir, timeoutMs: lighthouseTimeoutMs });
  } else if (localOnly) {
    // Structured refusal instead of a network install: approval layers that deny
    // registry-download execution (Codex Desktop guardian) deny the whole runner
    // when the dlx branch is reachable — surface the devDependency remedy.
    throw new Error(lighthouseMissingMessage(packageManager, lighthouseVersion));
  } else {
    await runCommand(packageManager, dlxArgs(packageManager, `lighthouse@${lighthouseVersion}`, lighthouseArgs), {
      cwd: rootDir,
      timeoutMs: lighthouseTimeoutMs,
    });
  }

  const jsonPath = findReportJson(outDir, baseName);
  const htmlPath = findReportHtml(outDir, baseName);
  if (!jsonPath) {
    throw new Error(`Lighthouse finished but no JSON report was found in ${outDir}`);
  }
  return { jsonPath, htmlPath };
}

function closePreview(preview: PreviewHandle | null): void {
  if (!preview) {
    return;
  }
  try {
    if ('kill' in preview) {
      if (!preview.killed) preview.kill('SIGTERM');
    } else {
      preview.close();
    }
  } catch {
    // The parent environment may own the process; best-effort cleanup.
  }
}

async function main(): Promise<void> {
  let args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.skipPreview && !args.url) {
    throw new Error('--skip-preview requires --url');
  }

  const rootPackage = findUp('package.json', process.cwd());
  const rootDir = rootPackage ? resolve(rootPackage, '..') : process.cwd();
  // The run's verification contract outranks this CLI's own defaults, so the
  // tester and the final gate judge the same audit against the same budget.
  args = applyContractThresholds(args, rootDir, process.argv.slice(2));
  const frontendApp = findFrontendApp(rootDir);
  const appDir = frontendApp.appDir;
  const packageManager = detectPackageManager(rootDir);
  let previewProcess: PreviewHandle | null = null;
  // Last-resort watchdog: even if some await below never settles, the runner
  // must NEVER exit without one final JSON status line — a silently hung run
  // used to be killed externally with a 0-byte output file. Unref'd so a fast
  // successful run is never kept alive (or exited non-zero) by it.
  const watchdog = setTimeout(() => {
    const line = `${JSON.stringify({ status: 'blocked:timeout', error: `Lighthouse runner exceeded ${args.maxRuntimeMs}ms budget; aborting to avoid a silent hang.` }, null, 2)}\n`;
    closePreview(previewProcess);
    process.stderr.write('[traffic-one lighthouse] hard runtime budget exceeded; aborting\n');
    // Exit from the write callback so the status line is flushed first; the
    // unref'd fallback covers stdout pipe backpressure.
    process.stdout.write(line, () => process.exit(1));
    setTimeout(() => process.exit(1), 500).unref();
  }, args.maxRuntimeMs);
  watchdog.unref();

  try {
    if (args.build) {
      await runCommand(packageManager, runScriptArgs(packageManager, 'build'), {
        cwd: existsSync(join(rootDir, 'package.json')) ? rootDir : appDir,
        forwardOutput: true,
      });
    }

    let auditUrl = args.url;
    if (!auditUrl && args.preview) {
      ensurePreviewBuildArtifacts(appDir, frontendApp.previewKind, frontendApp.staticDir);
      const port = await freePort();
      const started = await startPreview(packageManager, appDir, port, frontendApp.previewKind, frontendApp.staticDir);
      // Assigned even when the spawn was refused, so the `finally` below owns
      // whatever `spawn` handed back. `closePreview` is written for that case: a
      // refused child has no pid and `killed` false, and `kill` on a closed
      // handle answers false rather than throwing.
      previewProcess = started.handle;
      const baseUrl = `http://${DEFAULTS.host}:${port}/`;
      auditUrl = createAuditUrl(baseUrl, args.route);
      const timeoutMs = frontendApp.previewKind === 'next' && args.timeoutMs === DEFAULTS.timeoutMs ? 90_000 : args.timeoutMs;
      await waitForHttp(auditUrl, timeoutMs, started.refused);
    }

    if (!auditUrl) {
      throw new Error('No URL to audit. Provide --url or allow the runner to start preview.');
    }

    const outDir = resolve(rootDir, runScopedOutDir(rootDir, args.outDir, process.argv.slice(2)));
    const reportPaths = await runLighthouse({
      appDir,
      rootDir,
      packageManager,
      url: auditUrl,
      outDir,
      lighthouseVersion: args.lighthouseVersion,
      lighthouseTimeoutMs: args.lighthouseTimeoutMs,
      localOnly: args.localOnly
        || ['1', 'true'].includes(String(process.env.TRAFFIC_ONE_LIGHTHOUSE_LOCAL_ONLY || '').toLowerCase()),
    });
    const report = readJson(reportPaths.jsonPath);
    if (!report) {
      throw new Error(`Could not read Lighthouse report: ${reportPaths.jsonPath}`);
    }
    const summary = parseSummary(report, args);
    const output = {
      url: auditUrl,
      buildMode: 'production-preview',
      previewKind: frontendApp.previewKind,
      appDir: appDir === rootDir ? '.' : appDir.slice(rootDir.length + 1),
      reports: {
        json: reportPaths.jsonPath,
        html: reportPaths.htmlPath,
      },
      ...summary,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    // The measured verdict. Claiming the latch keeps a late listener error from
    // printing a failure status after it and overwriting a real audit.
    verdictLineWritten = true;
    if (summary.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(watchdog);
    closePreview(previewProcess);
  }
}

// The failure path is TOTAL: no error leaves this file without one JSON status
// line on stdout. That is the same promise the watchdog above keeps for a hang,
// and this path used to break it — the line was printed only when the classifier
// recognised the message, so an unrecognised error exited with EMPTY stdout. The
// page-speed hook parses that line and has no other channel, so a silent exit
// reads to it as "no Lighthouse result was mentioned" rather than as a failed
// audit, and page speed goes unreported instead of UNVERIFIED. Recognising the
// message is now the classifier's problem, not a condition on printing.
//
// Exactly ONE such line per process, and the FIRST one written wins. The hook
// reads the LAST JSON object on stdout, so a second line silently replaces the
// verdict — which is how a completed audit could be reported as a crash by an
// error that arrived after its summary had already been printed.
let verdictLineWritten = false;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLine(message: string): string {
  return `${JSON.stringify({ status: classifyRunnerFailure(message), error: message }, null, 2)}\n`;
}

// An error thrown from an event listener rather than from an awaited call never
// reaches `main`'s rejection, so without this it takes node's default route: die
// with a stack on stderr and nothing on stdout. That is the hole a missing spawn
// `error` listener fell through, and closing it here means the contract no longer
// depends on every future listener remembering to be careful.
//
// It exits rather than setting `exitCode` because an unhandled error usually
// leaves a ref'd handle behind (the preview child, an open socket). Returning
// would keep the loop alive until the unref'd watchdog fired a SECOND status line
// — and the hook reads the LAST JSON object on stdout, so a crash would be
// reported as `blocked:timeout`. Exiting immediately can orphan a preview child,
// exactly as node's own crash did before this handler existed.
function reportUncaught(error: unknown): void {
  const message = failureMessage(error);
  process.stderr.write(`[traffic-one lighthouse] ${message}\n`);
  if (verdictLineWritten) {
    process.exit(1);
    return;
  }
  verdictLineWritten = true;
  // Exit from the write callback so the line is flushed first, with the same
  // unref'd fallback the watchdog uses for stdout pipe backpressure.
  process.stdout.write(statusLine(message), () => process.exit(1));
  setTimeout(() => process.exit(1), 500).unref();
}

process.on('uncaughtException', reportUncaught);
process.on('unhandledRejection', reportUncaught);

main().catch((error: unknown) => {
  const message = failureMessage(error);
  verdictLineWritten = true;
  process.stdout.write(statusLine(message));
  process.stderr.write(`[traffic-one lighthouse] ${message}\n`);
  process.exitCode = 1;
});
