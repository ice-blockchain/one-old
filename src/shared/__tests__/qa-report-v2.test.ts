import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
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
  createQaNativeEvidence,
  readLighthouseArtifact,
} from '../qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  qaAcceptanceAttestationPath,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaBuildIdentityV2,
  type QaReportV2,
} from '../qa-report-v2';
import {
  compileVerificationContract,
  currentVerificationSourceHash,
  type VerificationCompileOptions,
  type VerificationContractV2,
} from '../verification-contract';
import { writeRunSettlement } from '../run-settlement';

async function withProject(fn: (cwd: string) => Promise<void> | void): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-v2-'));
  try { await fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const STATE = {
  mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'none', mobile: { framework: 'none' },
};

const BUILD_OUTPUT_ROOT = 'apps/web/dist';

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

function validPng(width: number, height = 2): Buffer {
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

interface RunningBuild {
  child: ChildProcess;
  build: QaBuildIdentityV2;
}

interface ServedBuildOverrides {
  servedFingerprint?: string;
  servedStartedAt?: string;
  servedPid?: number;
}

async function startBuildServer(
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

async function stopBuildServer(running: RunningBuild): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill('SIGTERM');
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), 1_000);
  try { await once(running.child, 'exit'); } finally { clearTimeout(timeout); }
}

async function withBuildServer(
  cwd: string,
  contract: VerificationContractV2,
  fn: (build: QaBuildIdentityV2) => Promise<void> | void,
  overrides: ServedBuildOverrides = {},
): Promise<void> {
  const running = await startBuildServer(cwd, contract, overrides);
  try { await fn(running.build); } finally { await stopBuildServer(running); }
}

function setup(
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

function setupNative(cwd: string): VerificationContractV2 {
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

function reportFor(
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

function lighthouseFor(
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

test('none/nonvisual verification passes without a browser or screenshots', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    }, { changedPaths: ['apps/web/src/lib/Mapper.ts'] }, {
      'apps/web/src/lib/Mapper.ts': 'export const map = (x:string) => x;\n',
    });
    assert.equal(contract.uiImpact, 'nonvisual');
    const result = validateQaReportV2(reportFor(cwd, contract, []), cwd, 'R', contract);
    assert.equal(result.ok, true);
  });
});

test('axe-when-dom accepts a justified no-DOM N/A but otherwise still requires pass', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    }, { changedPaths: ['apps/web/src/lib/Mapper.ts'] }, {
      'apps/web/src/lib/Mapper.ts': 'export const map = (x:string) => x;\n',
    });
    const noDom = reportFor(cwd, contract, []);
    noDom.checks = noDom.checks.map((check) => check.id === 'axe-when-dom'
      ? { ...check, status: 'not-applicable', summary: 'No DOM is rendered by this mapper-only change.' }
      : check);
    assert.equal(validateQaReportV2(noDom, cwd, 'R', contract).ok, true);

    const unjustified = reportFor(cwd, contract, []);
    unjustified.checks = unjustified.checks.map((check) => check.id === 'axe-when-dom'
      ? { ...check, status: 'not-applicable', summary: 'Accessibility was not run.' }
      : check);
    const rejected = validateQaReportV2(unjustified, cwd, 'R', contract);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, 'required-check-failed');

    const domCase = reportFor(cwd, contract, []);
    domCase.checks = domCase.checks.map((check) => check.id === 'axe-when-dom'
      ? { ...check, status: 'not-applicable', summary: 'Axe was not run although DOM output exists.' }
      : check);
    const domRejected = validateQaReportV2(domCase, cwd, 'R', contract);
    assert.equal(domRejected.ok, false);
    if (!domRejected.ok) assert.equal(domRejected.code, 'required-check-failed');
  });
});

test('behavioral browser QA passes headless with a live local build identity server', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes = [];\n',
    });
    assert.equal(contract.uiImpact, 'behavioral');
    assert.deepEqual(contract.requiredScreenshotWidths, []);
    await withBuildServer(cwd, contract, (build) => {
      assert.equal(validateQaReportV2(reportFor(cwd, contract, [1440], { build }), cwd, 'R', contract).ok, true);
    });
  });
});

test('accepted live QA survives preview shutdown through a tamper-evident attestation', async () => {
  await withProject(async (cwd) => {
    const sourcePath = 'apps/web/src/features/routing/index.ts';
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: [sourcePath] }, {
      [sourcePath]: 'export const routes=[];\n',
    });
    const running = await startBuildServer(cwd, contract);
    const report = reportFor(cwd, contract, [1440], { build: running.build });
    const reportPath = qaReportV2Path(cwd, 'R');
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.equal(validateQaReportV2(report, cwd, 'R', contract).ok, true);
    const attestationPath = qaAcceptanceAttestationPath(cwd, 'R');
    const originalAttestation = fs.readFileSync(attestationPath, 'utf8');
    await stopBuildServer(running);

    assert.equal(readQaReportV2(cwd, 'R').ok, true, 'server liveness is required at acceptance, not reconciliation');
    const digests = path.join(cwd, '.traffic-one', 'digests', 'R');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
    assert.equal(
      writeRunSettlement(cwd, 'R', { status: 'verified' })?.status,
      'verified',
      'settlement reconciliation must consume the durable acceptance after preview shutdown',
    );

    const machinePath = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'machine-evidence-v1.json');
    const originalMachineEvidence = fs.readFileSync(machinePath, 'utf8');
    const tamperedMachineEvidence = JSON.parse(originalMachineEvidence);
    tamperedMachineEvidence.servedAssetHashes = ['f'.repeat(64)];
    fs.writeFileSync(machinePath, JSON.stringify(tamperedMachineEvidence));
    const tampered = readQaReportV2(cwd, 'R');
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, 'machine-evidence-invalid');
    fs.writeFileSync(machinePath, originalMachineEvidence);
    fs.writeFileSync(attestationPath, originalAttestation);

    fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/Unexpected.ts'), 'export const unexpected=true;\n');
    const extraPath = readQaReportV2(cwd, 'R');
    assert.equal(extraPath.ok, false);
    if (!extraPath.ok) {
      assert.equal(extraPath.code, 'scan-incomplete');
      assert.match(extraPath.message, /outside verification contract.*Unexpected/);
    }
    fs.rmSync(path.join(cwd, 'apps/web/src/lib/Unexpected.ts'));

    fs.writeFileSync(path.join(cwd, sourcePath), 'export const routes=[\"changed-after-qa\"];\n');
    const changedSource = readQaReportV2(cwd, 'R');
    assert.equal(changedSource.ok, false);
    if (!changedSource.ok) assert.equal(changedSource.code, 'source-mismatch');
  });
});

test('visual QA fails without fresh 390/1440 screenshots and passes with them', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    }, { changedPaths: ['apps/web/src/pages/Home.tsx'] }, {
      'apps/web/src/pages/Home.tsx': 'export const Home=()=> <main/>;\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const missing = validateQaReportV2(reportFor(cwd, contract, [390, 1440], { build }), cwd, 'R', contract);
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.code, 'screenshot-invalid');
      const lighthouse = lighthouseFor(cwd, contract, build);
      const passed = validateQaReportV2(reportFor(cwd, contract, [390, 1440], {
        screenshots: true,
        lighthouse,
        build,
      }), cwd, 'R', contract);
      assert.equal(passed.ok, true);
    });
  });
});

test('corrupt, truncated, and wrong-width screenshots cannot satisfy visual evidence', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    }, { changedPaths: ['apps/web/src/pages/Home.tsx'] }, {
      'apps/web/src/pages/Home.tsx': 'export const Home=()=> <main/>;\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      for (const screenshotOptions of [
        { truncatedScreenshot: true },
        { screenshotWidthOverride: 777 },
      ]) {
        const report = reportFor(cwd, contract, [390, 1440], {
          screenshots: true,
          ...screenshotOptions,
          build,
        });
        const result = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'machine-evidence-invalid');
      }
    });
  });
});

test('artifact paths reject dot segments, traversal syntax, globs, and symlink escapes', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      for (const unsafe of [
        './machine-evidence-v1.json',
        'nested/../machine-evidence-v1.json',
        'machine-*.json',
      ]) {
        const report = reportFor(cwd, contract, [1440], { build });
        report.machineEvidencePath = unsafe;
        const result = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'invalid-schema');
      }

      const qa = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
      const report = reportFor(cwd, contract, [1440], { build });
      const outside = path.join(os.tmpdir(), `t1-outside-trace-${process.pid}-${Date.now()}.zip`);
      try {
        fs.writeFileSync(outside, Buffer.from('PK\u0003\u0004outside trace'));
        fs.rmSync(path.join(qa, 'playwright.trace.zip'));
        fs.symlinkSync(outside, path.join(qa, 'playwright.trace.zip'));
        const escaped = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(escaped.ok, false);
        if (!escaped.ok) assert.equal(escaped.code, 'machine-evidence-invalid');
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });
});

test('browser absence is blocked-environment for behavioral UI, not a code failure or verified pass', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    const result = validateQaReportV2(reportFor(cwd, contract, [], { status: 'blocked-environment' }), cwd, 'R', contract);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'blocked-environment');
  });
});

test('self-reported browser booleans without bundled machine evidence are rejected', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const report = reportFor(cwd, contract, [1440], {
        build,
        machineEvidence: false,
      });
      const result = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /runtime Playwright evidence is required/);
      }
    });
  });
});

test('report build PID, port, URL, and fingerprint cannot diverge from runner evidence', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const unboundPort = build.port === 65_535 ? 65_534 : build.port + 1;
      const report = reportFor(cwd, contract, [1440], { build });
      report.build = {
        ...build,
        pid: 2_147_483_647,
        port: unboundPort,
        url: `http://127.0.0.1:${unboundPort}`,
        fingerprint: 'f'.repeat(64),
        servedFingerprint: 'f'.repeat(64),
      };
      const result = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /identity mismatch/);
      }
    });
  });
});

test('an arbitrary echo server cannot pass without serving a build-manifest response body', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const result = validateQaReportV2(reportFor(cwd, contract, [1440], {
        build,
        servedAssetHashes: ['f'.repeat(64)],
      }), cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /did not serve any response body/);
      }
    });
  });
});

test('mutating the build output invalidates both runtime evidence and prior acceptance', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const report = reportFor(cwd, contract, [1440], { build });
      assert.equal(validateQaReportV2(report, cwd, 'R', contract).ok, true);
      fs.writeFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'), '<main>changed build</main>\n');
      const result = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /build output manifest/);
      }
    });
  });
});

test('native UI rejects arbitrary fresh files and remains blocked without a supported machine adapter', async () => {
  await withProject((cwd) => {
    const contract = setupNative(cwd);
    assert.equal(contract.uiImpact, 'native-ui');
    const missing = validateQaReportV2(reportFor(cwd, contract, []), cwd, 'R', contract);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'native-evidence-invalid');

    const qaDir = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
    const artifactPath = path.join(qaDir, 'simulator.log');
    fs.writeFileSync(artifactPath, 'simulator passed\n');
    const arbitrary = validateQaReportV2(reportFor(cwd, contract, [], {
      native: { evidencePath: 'simulator.log' },
    }), cwd, 'R', contract);
    assert.equal(arbitrary.ok, false);
    if (!arbitrary.ok) {
      assert.equal(arbitrary.code, 'native-evidence-invalid');
      assert.match(arbitrary.message, /sidecar.*hash-invalid/i);
    }

    const startedAt = new Date().toISOString();
    const blockedEvidence = createQaNativeEvidence({
      runnerVersion: 'test',
      runId: 'R',
      verificationContractHash: contract.contractHash,
      sourceHash: currentVerificationSourceHash(cwd, contract).hash,
      adapter: contract.nativeAdapter!,
      startedAt,
      generatedAt: new Date().toISOString(),
      status: 'blocked-environment',
      blockerSummary: 'No adapter-specific machine-result parser is installed.',
    });
    fs.writeFileSync(
      path.join(qaDir, 'native-evidence-v1.json'),
      JSON.stringify(blockedEvidence),
    );
    const blockedCannotPass = validateQaReportV2(reportFor(cwd, contract, [], {
      native: { evidencePath: 'native-evidence-v1.json' },
    }), cwd, 'R', contract);
    assert.equal(blockedCannotPass.ok, false);
    if (!blockedCannotPass.ok) {
      assert.equal(blockedCannotPass.code, 'native-evidence-invalid');
      assert.match(blockedCannotPass.message, /machine-result parser/i);
    }
  });
});

test('explicit Lighthouse thresholds are exact; implicit SEO is advisory with 3% tolerance', async () => {
  await withProject(async (cwd) => {
    const input: ArchitectureInputV1 = {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    };
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const exact = setup(cwd, input, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { seoMin: 95, lcpMaxMs: 2_500 },
    }, files);
    await withBuildServer(cwd, exact, (build) => {
      const evidence = lighthouseFor(cwd, exact, build, {
        seo: 92,
        lcpMs: 3_500,
      });
      const failed = validateQaReportV2(reportFor(cwd, exact, [1440], { lighthouse: evidence, build }), cwd, 'R', exact);
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, 'lighthouse-threshold-failed');
    });

    const advisory = compileVerificationContract(cwd, 'R', STATE, {
      ...compileArchitecture(cwd, 'R', STATE, input),
    }, {
      changedPaths: Object.keys(files),
      advisoryLighthouse: { seoMin: 95 },
    });
    await withBuildServer(cwd, advisory, (build) => {
      const evidence = lighthouseFor(cwd, advisory, build, {
        seo: 92,
        lcpMs: 3_500,
      });
      const advisoryResult = validateQaReportV2(reportFor(cwd, advisory, [1440], { lighthouse: evidence, build }), cwd, 'R', advisory);
      assert.equal(advisoryResult.ok, true);
      if (advisoryResult.ok) assert.ok(advisoryResult.advisories.some((item) => item.includes('seo')));
    });
  });
});

test('timestamp-only Lighthouse claims and stale, mismatched, or non-local artifacts are rejected', async () => {
  await withProject(async (cwd) => {
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { performanceMin: 90 },
    }, files);
    await withBuildServer(cwd, contract, (build) => {
      const timestampOnly = reportFor(cwd, contract, [1440], { build });
      (timestampOnly as unknown as { lighthouse: unknown }).lighthouse = {
        generatedAt: new Date().toISOString(),
        performance: 100,
        accessibility: 100,
        bestPractices: 100,
        seo: 100,
      };
      const handClaim = validateQaReportV2(timestampOnly, cwd, 'R', contract);
      assert.equal(handClaim.ok, false);
      if (!handClaim.ok) assert.equal(handClaim.code, 'invalid-schema');

      const staleEvidence = lighthouseFor(cwd, contract, build, {
        generatedAt: new Date(Date.parse(build.startedAt) - 10_000).toISOString(),
      });
      const stale = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: staleEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(stale.ok, false);
      if (!stale.ok) assert.equal(stale.code, 'lighthouse-threshold-failed');

      const mismatchedEvidence = lighthouseFor(cwd, contract, build);
      const rawPath = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'lighthouse.raw.json');
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      raw.categories.performance.score = 0.01;
      fs.writeFileSync(rawPath, JSON.stringify(raw));
      const mismatched = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: mismatchedEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(mismatched.ok, false);
      if (!mismatched.ok) {
        assert.equal(mismatched.code, 'lighthouse-threshold-failed');
        assert.match(mismatched.message, /raw Lighthouse artifact/);
      }

      const reusedPortEvidence = lighthouseFor(cwd, contract, build, {
        generatedAt: new Date(Date.now() + 500).toISOString(),
      });
      const reusedPortReport = reportFor(cwd, contract, [1440], {
        build,
        lighthouse: reusedPortEvidence,
      });
      reusedPortReport.generatedAt = new Date(Date.now() + 900).toISOString();
      const reusedPort = validateQaReportV2(reusedPortReport, cwd, 'R', contract);
      assert.equal(reusedPort.ok, false);
      if (!reusedPort.ok) {
        assert.equal(reusedPort.code, 'lighthouse-threshold-failed');
        assert.match(reusedPort.message, /runner-owned listener lifetime/);
      }

      const foreignEvidence = lighthouseFor(cwd, contract, build, {
        finalUrl: 'http://127.0.0.1:65534/',
      });
      const foreign = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: foreignEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(foreign.ok, false);
      if (!foreign.ok) {
        assert.equal(foreign.code, 'lighthouse-threshold-failed');
        assert.match(foreign.message, /different served build origin or port/);
      }
    });
  });
});
