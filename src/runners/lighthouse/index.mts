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

import {
  DEFAULTS,
  type PackageManager,
  classifyBlockedStatus,
  createAuditUrl,
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
      createReadStream(filePath).pipe(res);
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

async function startPreview(packageManager: PackageManager, appDir: string, port: number, kind: 'vite' | 'next' | 'static', staticDir?: string): Promise<PreviewHandle> {
  if (kind === 'static') return startStaticPreview(staticDir || join(appDir, 'out'), port);
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
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  const baseName = reportBaseName(url);
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.skipPreview && !args.url) {
    throw new Error('--skip-preview requires --url');
  }

  const rootPackage = findUp('package.json', process.cwd());
  const rootDir = rootPackage ? resolve(rootPackage, '..') : process.cwd();
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
      previewProcess = await startPreview(packageManager, appDir, port, frontendApp.previewKind, frontendApp.staticDir);
      const baseUrl = `http://${DEFAULTS.host}:${port}/`;
      auditUrl = createAuditUrl(baseUrl, args.route);
      const timeoutMs = frontendApp.previewKind === 'next' && args.timeoutMs === DEFAULTS.timeoutMs ? 90_000 : args.timeoutMs;
      await waitForHttp(auditUrl, timeoutMs);
    }

    if (!auditUrl) {
      throw new Error('No URL to audit. Provide --url or allow the runner to start preview.');
    }

    const outDir = resolve(rootDir, args.outDir);
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
    if (summary.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(watchdog);
    closePreview(previewProcess);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = classifyBlockedStatus(message);
  if (status) {
    process.stdout.write(`${JSON.stringify({ status, error: message }, null, 2)}\n`);
  }
  process.stderr.write(`[traffic-one lighthouse] ${message}\n`);
  process.exitCode = 1;
});
