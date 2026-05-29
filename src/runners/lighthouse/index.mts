#!/usr/bin/env node
// src/runners/lighthouse/index.mts
// ESM CLI shell for the traffic-one Lighthouse runner (compiles to
// scripts/lighthouse-runner.mjs — ESM is preserved via the .mts extension, the
// same convention as .cts → .cjs for CommonJS entries). Pure logic lives in
// ./lib; this shell owns the async I/O orchestration: build, preview, the
// Lighthouse run, threshold evaluation, and cleanup. Ported 1:1 from
// scripts/lighthouse-runner.mjs.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULTS,
  type PackageManager,
  createAuditUrl,
  detectPackageManager,
  dlxArgs,
  execArgs,
  findReportHtml,
  findReportJson,
  findUp,
  findViteAppDir,
  localLighthouseBin,
  parseArgs,
  parseSummary,
  readJson,
  reportBaseName,
  runScriptArgs,
  usage,
} from './lib.js';

interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'pipe' | Array<'ignore' | 'pipe'>; forwardOutput?: boolean }

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
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.forwardOutput) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.forwardOutput) process.stderr.write(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
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
    const server = createServer();
    server.listen(0, DEFAULTS.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 4173;
      server.close(() => resolvePromise(port));
    });
    server.on('error', rejectPromise);
  });
}

function startPreview(packageManager: PackageManager, appDir: string, port: number): ChildProcess {
  const args = execArgs(packageManager, 'vite', [
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

async function runLighthouse({ appDir, rootDir, packageManager, url, outDir, lighthouseVersion }: {
  appDir: string; rootDir: string; packageManager: PackageManager; url: string; outDir: string; lighthouseVersion: string;
}): Promise<{ jsonPath: string; htmlPath: string | null }> {
  mkdirSync(outDir, { recursive: true });
  const baseName = reportBaseName(url);
  const outputBase = join(outDir, baseName);
  const lighthouseArgs = [
    url,
    '--only-categories=performance',
    '--chrome-flags=--headless --no-sandbox',
    '--output=json',
    '--output=html',
    `--output-path=${outputBase}`,
    '--quiet',
  ];
  const localBin = localLighthouseBin(rootDir, appDir);
  if (localBin) {
    await runCommand(localBin, lighthouseArgs, { cwd: appDir });
  } else {
    await runCommand(packageManager, dlxArgs(packageManager, `lighthouse@${lighthouseVersion}`, lighthouseArgs), {
      cwd: rootDir,
    });
  }

  const jsonPath = findReportJson(outDir, baseName);
  const htmlPath = findReportHtml(outDir, baseName);
  if (!jsonPath) {
    throw new Error(`Lighthouse finished but no JSON report was found in ${outDir}`);
  }
  return { jsonPath, htmlPath };
}

function killPreview(child: ChildProcess | null): void {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill('SIGTERM');
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
  const appDir = findViteAppDir(rootDir);
  const packageManager = detectPackageManager(rootDir);
  let previewProcess: ChildProcess | null = null;

  try {
    if (args.build) {
      await runCommand(packageManager, runScriptArgs(packageManager, 'build'), {
        cwd: existsSync(join(rootDir, 'package.json')) ? rootDir : appDir,
        forwardOutput: true,
      });
    }

    let auditUrl = args.url;
    if (!auditUrl && args.preview) {
      const port = await freePort();
      previewProcess = startPreview(packageManager, appDir, port);
      const baseUrl = `http://${DEFAULTS.host}:${port}/`;
      auditUrl = createAuditUrl(baseUrl, args.route);
      await waitForHttp(auditUrl, args.timeoutMs);
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
    });
    const report = readJson(reportPaths.jsonPath);
    if (!report) {
      throw new Error(`Could not read Lighthouse report: ${reportPaths.jsonPath}`);
    }
    const summary = parseSummary(report, args);
    const output = {
      url: auditUrl,
      buildMode: 'production-preview',
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
    killPreview(previewProcess);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[traffic-one lighthouse] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
