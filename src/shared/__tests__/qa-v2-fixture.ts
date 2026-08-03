// Shared QaReportV2 evidence fixture: a temp project with a compiled
// architecture + verification contract, a real local HTTP build-identity
// server, and helpers that produce hash-consistent reports, machine evidence,
// screenshots, and Lighthouse artifacts. Extracted from qa-report-v2.test.ts
// so settlement/run-status suites can reconstruct full green-evidence run
// shapes (e.g. the 14cl artifact shape) with the same real writers.
//
// NOT a test file on purpose: the `.test.ts` glob must not collect it.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateSync } from 'zlib';

import {
  compileArchitecture,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  computeBuildOutputManifest,
  contentHash,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  readLighthouseArtifact,
} from '../qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  type QaBuildIdentityV2,
  type QaReportV2,
} from '../qa-report-v2';
import {
  compileVerificationContract,
  currentVerificationSourceHash,
  type VerificationCompileOptions,
  type VerificationContractV2,
} from '../verification-contract';

export async function withProject(fn: (cwd: string) => Promise<void> | void): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-v2-'));
  try { await fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

export const STATE = {
  mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'none', mobile: { framework: 'none' },
};

export const BUILD_OUTPUT_ROOT = 'apps/web/dist';

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

export function validPng(width: number, height = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let pixel = 0; pixel < width; pixel += 1) row[1 + pixel * 4 + 3] = 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const BUILD_SERVER_SOURCE = String.raw`
const http = require('http');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
let reportIdentity;
const server = http.createServer((request, response) => {
  if (request.url !== ${JSON.stringify(QA_BUILD_IDENTITY_PROBE_PATH)}) {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<main>temporary QA server</main>');
    return;
  }
  const servedIdentity = {
    ...reportIdentity,
    pid: input.servedPid || reportIdentity.pid,
    startedAt: input.servedStartedAt || reportIdentity.startedAt,
    fingerprint: input.servedFingerprint || reportIdentity.fingerprint,
  };
  response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(servedIdentity));
});
server.on('error', (error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exit(1);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port;
  reportIdentity = {
    schemaVersion: 1,
    runId: input.runId,
    sourceHash: input.sourceHash,
    buildHash: input.buildHash,
    pid: process.pid,
    port: address.port,
    startedAt: processStartedAt,
    url,
    fingerprint: input.fingerprint,
  };
  process.stdout.write(JSON.stringify(reportIdentity) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

export interface RunningBuild {
  child: ChildProcess;
  build: QaBuildIdentityV2;
}

export interface ServedBuildOverrides {
  servedFingerprint?: string;
  servedStartedAt?: string;
  servedPid?: number;
}

export async function startBuildServer(
  cwd: string,
  contract: VerificationContractV2,
  overrides: ServedBuildOverrides = {},
): Promise<RunningBuild> {
  const sourceHash = currentVerificationSourceHash(cwd, contract).hash;
  const buildDir = path.join(cwd, BUILD_OUTPUT_ROOT);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'index.html'), '<main>temporary QA server</main>\n');
  const manifest = computeBuildOutputManifest(cwd, BUILD_OUTPUT_ROOT);
  assert.ok(manifest);
  const buildHash = manifest.manifestHash;
  const fingerprint = expectedBuildFingerprint('R', sourceHash, buildHash);
  const input = Buffer.from(JSON.stringify({
    runId: 'R',
    sourceHash,
    buildHash,
    fingerprint,
    ...overrides,
  })).toString('base64url');
  const child = spawn(process.execPath, ['-e', BUILD_SERVER_SOURCE, input], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const chunk = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout!.off('data', onData);
    };
    const onData = (value: Buffer): void => {
      cleanup();
      resolve(value);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`temporary build server exited before listening (${code ?? 'signal'})`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error('temporary build server did not listen within 3 seconds'));
    }, 3_000);
    child.stdout!.once('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  const served = JSON.parse(chunk.toString('utf8')) as QaBuildIdentityV2;
  return {
    child,
    build: {
      runId: served.runId,
      sourceHash: served.sourceHash,
      outputRoot: BUILD_OUTPUT_ROOT,
      buildHash: served.buildHash,
      pid: served.pid,
      port: served.port,
      startedAt: served.startedAt,
      url: served.url,
      fingerprint: served.fingerprint,
      servedFingerprint: served.fingerprint,
    },
  };
}

export async function stopBuildServer(running: RunningBuild): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill('SIGTERM');
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), 1_000);
  try { await once(running.child, 'exit'); } finally { clearTimeout(timeout); }
}

export async function withBuildServer(
  cwd: string,
  contract: VerificationContractV2,
  fn: (build: QaBuildIdentityV2) => Promise<void> | void,
  overrides: ServedBuildOverrides = {},
): Promise<void> {
  const running = await startBuildServer(cwd, contract, overrides);
  try { await fn(running.build); } finally { await stopBuildServer(running); }
}

export function setup(
  cwd: string,
  input: ArchitectureInputV1,
  options: VerificationCompileOptions,
  files: Record<string, string>,
): VerificationContractV2 {
  for (const dir of ['apps/web/src/pages', 'apps/web/src/features', 'apps/web/src/lib', 'apps/web/src/components']) {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19', vite: '7' } }));
  const architecture = compileArchitecture(cwd, 'R', STATE, input);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  }
  return compileVerificationContract(cwd, 'R', STATE, architecture, options);
}

export function setupNative(cwd: string): VerificationContractV2 {
  fs.writeFileSync(path.join(cwd, 'Package.swift'), '// swift-tools-version:6.2\n');
  const nativeState = {
    mode: 'new-project', stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'swift-native' },
  };
  const architecture = compileArchitecture(cwd, 'R', nativeState, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
  });
  fs.mkdirSync(path.join(cwd, 'Features'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'Features', 'HomeView.swift'), 'struct HomeView {}\n');
  return compileVerificationContract(cwd, 'R', nativeState, architecture, {
    changedPaths: ['Features/HomeView.swift'],
  });
}

export function reportFor(
  cwd: string,
  contract: VerificationContractV2,
  widths: number[],
  opts: {
    screenshots?: boolean;
    screenshotWidthOverride?: number;
    truncatedScreenshot?: boolean;
    machineEvidence?: boolean;
    servedAssetHashes?: string[];
    status?: QaReportV2['status'];
    lighthouse?: QaReportV2['lighthouse'];
    build?: QaBuildIdentityV2;
    native?: QaReportV2['native'];
  } = {},
): QaReportV2 {
  const sourceHash = currentVerificationSourceHash(cwd, contract).hash;
  const base = Date.now() + 50;
  // The Lighthouse helper runs immediately before this report helper. Under a
  // loaded full-suite process, more than 5 ms can elapse between the two calls;
  // anchoring listener start at `base + 5` then falsely places that real
  // Lighthouse fixture before the listener lifetime. The listener actually
  // started with the run-owned build, so model that stable ordering directly.
  const buildStartedAt = opts.build ? Date.parse(opts.build.startedAt) : Number.NaN;
  const machineStartedAt = new Date(
    Number.isFinite(buildStartedAt)
      ? Math.max(buildStartedAt + 1, Date.now() - 1_000)
      : base + 5,
  ).toISOString();
  const artifactAt = new Date(base + 10).toISOString();
  const machineGeneratedAt = new Date(base + 15).toISOString();
  const generatedAt = new Date(base + 100).toISOString();
  const screenshotDir = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const viewports = widths.map((width) => {
    const screenshotPath = `home-${width}.png`;
    if (opts.screenshots) {
      fs.writeFileSync(
        path.join(screenshotDir, screenshotPath),
        opts.truncatedScreenshot
          ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : validPng(opts.screenshotWidthOverride || width),
      );
    }
    return {
      width,
      status: 'passed' as const,
      domAssertionsPassed: true,
      actionsPassed: true,
      routingPassed: true,
      hydrationPassed: true,
      consoleErrors: [],
      networkErrors: [],
      artifactAt,
      ...(opts.screenshots ? { screenshotPath } : {}),
    };
  });
  const routes = contract.browserRequired
    ? contract.changedRoutes.map((route) => ({ route, viewports }))
    : [];
  let machineEvidencePath: string | undefined;
  if (contract.browserRequired
    && opts.status !== 'blocked-environment'
    && opts.machineEvidence !== false
    && opts.build) {
    const tracePath = 'playwright.trace.zip';
    fs.writeFileSync(path.join(screenshotDir, tracePath), Buffer.from('PK\u0003\u0004runtime trace evidence'));
    const manifest = computeBuildOutputManifest(cwd, opts.build.outputRoot);
    assert.ok(manifest);
    const evidence = createQaMachineEvidence({
      runnerVersion: 'test-runtime',
      playwrightVersion: '1.55.0',
      runId: 'R',
      verificationContractHash: contract.contractHash,
      sourceHash,
      buildOutputRoot: opts.build.outputRoot,
      buildHash: opts.build.buildHash,
      buildFingerprint: opts.build.fingerprint,
      serverMode: 'runtime-static',
      serverPid: opts.build.pid,
      serverPort: opts.build.port,
      serverStartedAt: opts.build.startedAt,
      serverUrl: opts.build.url,
      servedAssetHashes: opts.servedAssetHashes || [manifest.files[0]!.sha256],
      scenarioHash: 'a'.repeat(64),
      startedAt: machineStartedAt,
      generatedAt: machineGeneratedAt,
      status: 'passed',
      routes: routes.map((route) => ({
        route: route.route,
        viewports: route.viewports.map((viewport) => ({
          ...viewport,
          tracePath,
          traceHash: contentHash(path.join(screenshotDir, tracePath))!,
          ...(viewport.screenshotPath
            ? {
                screenshotPath: viewport.screenshotPath,
                screenshotHash: contentHash(path.join(screenshotDir, viewport.screenshotPath))!,
              }
            : {}),
        })),
      })),
    });
    machineEvidencePath = 'machine-evidence-v1.json';
    fs.writeFileSync(path.join(screenshotDir, machineEvidencePath), JSON.stringify(evidence));
  }
  return {
    schemaVersion: 2,
    runId: 'R',
    verificationContractHash: contract.contractHash,
    generatedAt,
    producer: 'senior-tester',
    status: opts.status || 'passed',
    sourceHash,
    checks: contract.requiredChecks.map((id) => ({ id, status: 'passed' })),
    routes,
    ...(machineEvidencePath ? { machineEvidencePath } : {}),
    ...(opts.build ? { build: opts.build } : {}),
    ...(opts.native ? { native: opts.native } : {}),
    ...(opts.lighthouse ? { lighthouse: opts.lighthouse } : {}),
    ...(opts.status === 'blocked-environment' ? { blockerSummary: 'Chromium is unavailable in this environment.' } : {}),
  };
}

export function lighthouseFor(
  cwd: string,
  contract: VerificationContractV2,
  build: QaBuildIdentityV2,
  values: {
    performance?: number;
    accessibility?: number;
    bestPractices?: number;
    seo?: number;
    lcpMs?: number;
    cls?: number;
    inpMs?: number;
    generatedAt?: string;
    finalUrl?: string;
  } = {},
): QaReportV2['lighthouse'] {
  const qa = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
  fs.mkdirSync(qa, { recursive: true });
  const generatedAt = values.generatedAt || new Date(Date.now() + 60).toISOString();
  const rawPath = path.join(qa, 'lighthouse.raw.json');
  fs.writeFileSync(rawPath, JSON.stringify({
    lighthouseVersion: '13.2.0',
    fetchTime: generatedAt,
    finalDisplayedUrl: values.finalUrl || `${build.url}/`,
    categories: {
      performance: { score: (values.performance ?? 96) / 100 },
      accessibility: { score: (values.accessibility ?? 97) / 100 },
      'best-practices': { score: (values.bestPractices ?? 98) / 100 },
      seo: { score: (values.seo ?? 99) / 100 },
    },
    audits: {
      'largest-contentful-paint': { numericValue: values.lcpMs ?? 1_200 },
      'cumulative-layout-shift': { numericValue: values.cls ?? 0.02 },
      ...(values.inpMs === undefined
        ? {}
        : { 'interaction-to-next-paint': { numericValue: values.inpMs } }),
    },
  }));
  const summary = readLighthouseArtifact(rawPath);
  assert.ok(summary);
  const evidence = createQaLighthouseEvidence({
    runId: 'R',
    verificationContractHash: contract.contractHash,
    sourceHash: currentVerificationSourceHash(cwd, contract).hash,
    buildHash: build.buildHash,
    buildFingerprint: build.fingerprint,
    generatedAt: summary.generatedAt,
    artifactPath: 'lighthouse.raw.json',
    artifactHash: summary.artifactHash,
    finalUrl: summary.finalUrl,
    performance: summary.performance,
    accessibility: summary.accessibility,
    bestPractices: summary.bestPractices,
    seo: summary.seo,
    lcpMs: summary.lcpMs,
    cls: summary.cls,
    ...(summary.inpMs === undefined ? {} : { inpMs: summary.inpMs }),
  });
  fs.writeFileSync(path.join(qa, 'lighthouse-evidence-v1.json'), JSON.stringify(evidence));
  return { evidencePath: 'lighthouse-evidence-v1.json' };
}
