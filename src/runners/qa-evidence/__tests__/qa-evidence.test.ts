import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  type ArchitectureInputV1,
} from '../../../shared/architecture-contract';
import {
  computeBuildOutputManifest,
  decodeImageFile,
  parseAndroidJUnitXml,
  parseQaMachineEvidence,
  parseQaNativeEvidence,
  parseXcodeResultSummary,
  readJsonFile,
} from '../../../shared/qa-evidence-runtime';
import {
  qaAcceptanceAttestationPath,
  qaReportV2Path,
  readQaReportV2,
} from '../../../shared/qa-report-v2';
import {
  compileVerificationContract,
  type VerificationContractV2,
} from '../../../shared/verification-contract';
import { main } from '../index';
import { loadRun } from '../run-context';
import { type RunnerArgs } from '../types';
import { resolveStackCommand } from '../stack';

const STATE = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

function runnerArgs(cwd: string, overrides: Partial<RunnerArgs> = {}): RunnerArgs {
  return {
    command: 'manifest',
    projectRoot: cwd,
    runId: 'R',
    buildDir: 'dist',
    withLighthouse: false,
    timeoutMs: 30_000,
    ...overrides,
  };
}

test('every load failure names its own precondition instead of listing all four', async () => {
  await withProject(async (cwd) => {
    // No contract on disk yet.
    const noContract = loadRun(runnerArgs(cwd));
    assert.equal(noContract.ok, false);
    assert.match(
      noContract.ok ? '' : noContract.reason,
      /VerificationContractV2 for run R is missing, malformed/,
    );

    // An unsafe run id must not be confused with a missing contract.
    const badId = loadRun(runnerArgs(cwd, { runId: '../escape' }));
    assert.equal(badId.ok, false);
    assert.match(badId.ok ? '' : badId.reason, /run id is not a safe identifier/);

    // A missing --build-dir is its own, separately actionable cause.
    const noBuildDir = loadRun(runnerArgs(cwd, { buildDir: '' }));
    assert.equal(noBuildDir.ok, false);
    assert.match(noBuildDir.ok ? '' : noBuildDir.reason, /no --build-dir was provided/);

    // With a valid contract, an unauthorized changed path must surface the
    // offending path itself — this is the message two roles never saw.
    setupProject(cwd);
    fs.writeFileSync(path.join(cwd, 'stray-host-file.json'), '{}\n');
    const strayPath = loadRun(runnerArgs(cwd));
    assert.equal(strayPath.ok, false);
    assert.match(
      strayPath.ok ? '' : strayPath.reason,
      /changed paths outside verification contract:.*stray-host-file\.json/,
    );

    // And a clean tree with no build output blames the manifest, not the scan.
    fs.rmSync(path.join(cwd, 'stray-host-file.json'));
    const noManifest = loadRun(runnerArgs(cwd));
    assert.equal(noManifest.ok, false);
    assert.match(noManifest.ok ? '' : noManifest.reason, /build output manifest could not be computed/);
  });
});

async function withProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-runner-'));
  try {
    await fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function setupProject(
  cwd: string,
  options: { visual?: boolean; performanceMin?: number } = {},
): VerificationContractV2 {
  fs.mkdirSync(path.join(cwd, 'apps/web/src/features/routing'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0' },
  }));
  const input: ArchitectureInputV1 = options.visual
    ? {
        schemaVersion: 1,
        routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
        modules: [{ id: 'home', name: 'Home', kind: 'page' }],
      }
    : {
        schemaVersion: 1,
        routes: [],
        modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
      };
  const architecture = compileArchitecture(cwd, 'R', STATE, input);
  const changedPath = options.visual
    ? 'apps/web/src/pages/Home.tsx'
    : 'apps/web/src/features/routing/index.ts';
  fs.writeFileSync(
    path.join(cwd, changedPath),
    options.visual
      ? 'export const Home=()=> <main><button>Open</button></main>;\n'
      : 'export const navigate = () => window.history.pushState({}, "", "/");\n',
  );
  const contract = compileVerificationContract(cwd, 'R', STATE, architecture, {
    changedPaths: [changedPath],
    ...(options.performanceMin === undefined
      ? {}
      : {
          explicitLighthouse: {
            performanceMin: options.performanceMin,
            accessibilityMin: 90,
            bestPracticesMin: 90,
            lcpMaxMs: 2_500,
            clsMax: 0.1,
          },
        }),
  });
  const buildDir = path.join(cwd, 'apps/web/dist');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(
    path.join(buildDir, 'index.html'),
    '<!doctype html><html><body><main><button>Open</button></main></body></html>\n',
  );
  return contract;
}

function setupNativeProject(cwd: string): VerificationContractV2 {
  fs.writeFileSync(path.join(cwd, 'Package.swift'), '// swift-tools-version:6.2\n');
  const state = {
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'none',
    backend: 'none',
    mobile: { framework: 'swift-native' },
  };
  const architecture = compileArchitecture(cwd, 'R', state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
  });
  fs.mkdirSync(path.join(cwd, 'Features'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'Features/HomeView.swift'), 'struct HomeView {}\n');
  return compileVerificationContract(cwd, 'R', state, architecture, {
    changedPaths: ['Features/HomeView.swift'],
  });
}

function setupAndroidNativeProject(cwd: string): VerificationContractV2 {
  fs.mkdirSync(path.join(cwd, 'app/src/main/kotlin'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'settings.gradle.kts'), 'rootProject.name = "NativeApp"\ninclude(":app")\n');
  fs.writeFileSync(path.join(cwd, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }\n');
  fs.writeFileSync(path.join(cwd, 'app/src/main/kotlin/HomeScreen.kt'), 'class HomeScreen\n');
  const gradlew = path.join(cwd, 'gradlew');
  fs.writeFileSync(gradlew, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const result = path.join(process.cwd(), 'app/build/outputs/androidTest-results/connected/debug');
fs.mkdirSync(result, { recursive: true });
fs.writeFileSync(path.join(result, 'TEST-device.xml'), '<?xml version="1.0"?><testsuite name="connected" tests="2" failures="0" errors="0" skipped="0"><testcase name="launch"/><testcase name="navigate"/></testsuite>');
`);
  fs.chmodSync(gradlew, 0o755);
  const state = {
    mode: 'existing-codebase',
    stack: 'custom-frontend',
    frontend: 'none',
    backend: 'none',
    mobile: { framework: 'kotlin-android' },
  };
  const architecture = compileArchitecture(cwd, 'R', state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
  });
  return compileVerificationContract(cwd, 'R', state, architecture, {
    changedPaths: ['app/src/main/kotlin/HomeScreen.kt'],
  });
}

function installFakeXcodeTools(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-tools-'));
  const xcodebuild = path.join(bin, 'xcodebuild');
  const xcrun = path.join(bin, 'xcrun');
  fs.writeFileSync(xcodebuild, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const index = process.argv.indexOf('-resultBundlePath');
if (index < 0 || !process.argv[index + 1]) process.exit(7);
const bundle = process.argv[index + 1];
fs.mkdirSync(bundle, { recursive: true });
fs.writeFileSync(path.join(bundle, 'Data'), 'machine-owned-xcresult');
`);
  fs.writeFileSync(xcrun, `#!${process.execPath}
process.stdout.write(JSON.stringify({
  totalTestCount: 2,
  passedTests: 2,
  failedTests: 0,
  skippedTests: 0,
  result: 'Passed'
}));
`);
  fs.chmodSync(xcodebuild, 0o755);
  fs.chmodSync(xcrun, 0o755);
  return bin;
}

function installFakePlaywright(
  cwd: string,
  options: {
    failVisible?: boolean;
    overflow?: boolean;
    runtimeListeners?: number;
    documentChanged?: boolean;
    crossOriginStatus?: number;
    crossOriginRequestFailed?: boolean;
    nonNetworkNoise?: boolean;
  } = {},
): void {
  const moduleDir = path.join(cwd, 'node_modules', 'playwright');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({
    name: 'playwright',
    version: '1.55.0-test',
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(moduleDir, 'index.js'), `
const fs = require('fs');
const zlib = require('zlib');
function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
function png(width) {
  const height = 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(row)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
exports.chromium = {
  async launch() {
    return {
      async newContext({ viewport }) {
        let currentUrl = '';
        let runtimeEvaluation = 0;
        const listeners = {};
        return {
          tracing: {
            async start() {},
            // Real Playwright discards the trace when stop() gets no path —
            // the v2 runner does exactly that on a PASSED viewport.
            async stop(options) { if (options && options.path) fs.writeFileSync(options.path, Buffer.from('PK\\\\x03\\\\x04fake trace')); },
          },
          async addInitScript() {},
          async newPage() {
            return {
              on(name, listener) { listeners[name] = listener; },
              async goto(url) {
                currentUrl = url;
                const response = await fetch(url);
                if (listeners.response) listeners.response({
                  url: () => url,
                  status: () => response.status,
                });
                if (${options.crossOriginStatus !== undefined} && listeners.response) listeners.response({
                  url: () => 'https://api.example.test/data',
                  status: () => ${options.crossOriginStatus ?? 200},
                });
                if (${options.crossOriginRequestFailed === true} && listeners.requestfailed) listeners.requestfailed({
                  url: () => 'https://cdn.example.test/runtime.js',
                });
                if (${options.nonNetworkNoise === true}) {
                  if (listeners.response) listeners.response({
                    url: () => 'data:text/plain,not-a-network-response',
                    status: () => 500,
                  });
                  if (listeners.requestfailed) listeners.requestfailed({
                    url: () => 'blob:http://127.0.0.1/not-a-network-request',
                  });
                }
                await response.text();
              },
              async waitForLoadState() {},
              async waitForTimeout() {},
              locator() {
                return { first() {
                  return {
                    async waitFor() {
                      if (${options.failVisible === true}) throw new Error('expected element was not visible');
                    },
                    async click() {},
                    async fill() {},
                    async press() {},
                    async check() {},
                    async selectOption() {},
                    async isVisible() { return true; },
                    async textContent() { return 'Open'; },
                  };
                }};
              },
              url() { return currentUrl; },
              async evaluate() {
                runtimeEvaluation += 1;
                return {
                  documentReady: true,
                  documentToken: runtimeEvaluation > 1 && ${options.documentChanged === true}
                    ? 'document-2'
                    : 'document-1',
                  listenerRegistrations: ${options.runtimeListeners ?? 1},
                  noHorizontalOverflow: ${options.overflow !== true},
                };
              },
              async screenshot({ path }) {
                const bytes = png(viewport.width);
                fs.writeFileSync(path, bytes);
                return bytes;
              },
            };
          },
          async close() {},
        };
      },
      async close() {},
    };
  },
};
`);
}

function installFakeLighthouse(
  cwd: string,
  options: { performance?: number; finalUrl?: string } = {},
): void {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, 'lighthouse');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs');
const target = process.argv[2];
const output = process.argv.find((value) => value.startsWith('--output-path=')).slice('--output-path='.length);
fs.writeFileSync(output, JSON.stringify({
  lighthouseVersion: '13.2.0-test',
  fetchTime: new Date().toISOString(),
  finalDisplayedUrl: ${JSON.stringify(options.finalUrl || '')} || target,
  categories: {
    performance: { score: ${options.performance ?? 0.96} },
    accessibility: { score: 0.97 },
    'best-practices': { score: 0.98 },
    seo: { score: 0.99 },
  },
  audits: {
    'largest-contentful-paint': { numericValue: 1200 },
    'cumulative-layout-shift': { numericValue: 0.02 },
    'interaction-to-next-paint': { numericValue: 100 },
  },
}));
`);
  fs.chmodSync(executable, 0o755);
}

function scenario(interactive = true): string {
  return JSON.stringify({
    schemaVersion: 1,
    routes: [{
      route: '/',
      finalPath: '/',
      stableSelector: 'main',
      steps: interactive
        ? [
            { type: 'click', selector: 'button' },
            { type: 'expect-visible', selector: 'main' },
          ]
        : [{ type: 'expect-visible', selector: 'main' }],
    }],
  });
}

test('browser CLI owns the listener, runs Playwright and Lighthouse, then verifies after process exit', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd, { performanceMin: 90 });
    installFakePlaywright(cwd);
    installFakeLighthouse(cwd);
    const code = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(code, 0);
    assert.equal(readQaReportV2(cwd, 'R').ok, true);
    const report = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, 'R'), 'utf8'));
    assert.equal(report.producer, 'parent-runner');
    assert.equal(report.lighthouse.evidencePath, 'lighthouse-evidence-v1.json');
    assert.equal(report.machineEvidencePath, 'machine-evidence-v1.json');
    // Evidence v2: a fully green run leaves ZERO trace zips on disk — the
    // diagnostic is discarded at emit time (measured 9co: ~6 MB per green run).
    const qaDir = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
    assert.deepEqual(fs.readdirSync(qaDir).filter((name) => name.endsWith('.trace.zip')), []);
    const machine = JSON.parse(fs.readFileSync(path.join(qaDir, 'machine-evidence-v1.json'), 'utf8'));
    assert.equal(machine.schemaVersion, 2);
    for (const route of machine.routes) {
      for (const viewport of route.viewports) {
        assert.equal(viewport.status, 'passed');
        assert.equal(viewport.tracePath, undefined, 'green viewports record no trace');
      }
    }
    assert.equal(await main([
      'lighthouse',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--artifact', '.traffic-one/reports/qa/R/lighthouse.raw.json',
    ], cwd), 0, 'the production converter accepts the raw artifact captured on the attested live listener');
    assert.equal(readQaReportV2(cwd, 'R').ok, true);

    // A post-acceptance rebuild of the output tree does NOT revoke the
    // runner's own accepted verdict (observed 14cl: the reviewer's probe
    // build bricked a fully green run) — the evidence, report, contract, and
    // source stay hash-pinned by the acceptance attestation. Without that
    // attestation, the same drifted tree fails closed exactly as before.
    fs.writeFileSync(path.join(cwd, 'apps/web/dist/index.html'), '<main>mutated after QA</main>\n');
    assert.equal(readQaReportV2(cwd, 'R').ok, true, 'a durable acceptance survives an output-tree rebuild');
    fs.rmSync(qaAcceptanceAttestationPath(cwd, 'R'));
    const stale = readQaReportV2(cwd, 'R');
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'machine-evidence-invalid');
  });
});

test('browser CLI fails exact Lighthouse thresholds and rejects another localhost listener', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd, { performanceMin: 90 });
    installFakePlaywright(cwd);
    installFakeLighthouse(cwd, { performance: 0.5 });
    const thresholdCode = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(thresholdCode, 1);
    const threshold = readQaReportV2(cwd, 'R');
    assert.equal(threshold.ok, false);
    if (!threshold.ok) assert.equal(threshold.code, 'lighthouse-threshold-failed');
  });

  await withProject(async (cwd) => {
    setupProject(cwd, { performanceMin: 90 });
    installFakePlaywright(cwd);
    installFakeLighthouse(cwd, { finalUrl: 'http://127.0.0.1:65534/' });
    const wrongListenerCode = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(wrongListenerCode, 1);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.equal(machine?.status, 'failed');
    assert.match(machine?.blockerSummary || '', /runner-owned live build listener/);
  });
});

// 6co: the contract legitimately carries `*` and `/courses/:courseSlug`, but the
// runner required every scenario route to start with `/` and then navigated to
// it verbatim. QA became unsatisfiable for a catch-all (the architect rewrote
// the product's 404 to a literal `/404` to get a passing sweep, shipping an app
// with no reachable not-found route) and silently false-passed `:param` routes
// by visiting the literal `/courses/:courseSlug`.
function setupPatternRoutesProject(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0' },
  }));
  const architecture = compileArchitecture(cwd, 'R', STATE, {
    schemaVersion: 1,
    routes: [
      { id: 'home-route', path: '/', moduleId: 'home' },
      { id: 'course-route', path: '/courses/:courseSlug', moduleId: 'course-detail' },
      { id: 'not-found-route', path: '*', moduleId: 'not-found' },
    ],
    modules: [
      { id: 'home', name: 'Home', kind: 'page' },
      { id: 'course-detail', name: 'Course Detail', kind: 'page' },
      { id: 'not-found', name: 'Not Found', kind: 'page' },
    ],
  });
  const changedPath = 'apps/web/src/pages/Home.tsx';
  fs.writeFileSync(
    path.join(cwd, changedPath),
    'export const Home=()=> <main><button>Open</button></main>;\n',
  );
  compileVerificationContract(cwd, 'R', STATE, architecture, {
    changedPaths: [changedPath],
    explicitLighthouse: {
      performanceMin: 90,
      accessibilityMin: 90,
      bestPracticesMin: 90,
      lcpMaxMs: 2_500,
      clsMax: 0.1,
    },
  });
  const buildDir = path.join(cwd, 'apps/web/dist');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(
    path.join(buildDir, 'index.html'),
    '<!doctype html><html><body><main><button>Open</button></main></body></html>\n',
  );
}

test('browser CLI probes catch-all and parameterized routes through startPath, keyed by the contract pattern', async () => {
  await withProject(async (cwd) => {
    setupPatternRoutesProject(cwd);
    installFakePlaywright(cwd);
    installFakeLighthouse(cwd);
    const steps = [
      { type: 'click', selector: 'button' },
      { type: 'expect-visible', selector: 'main' },
    ];
    const routeEntry = (
      route: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({ route, stableSelector: 'main', steps, ...extra });
    const run = async (routes: Array<Record<string, unknown>>): Promise<number> => main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', JSON.stringify({ schemaVersion: 1, routes }),
    ], cwd);

    // A pattern with no concrete probe is unusable — fail closed rather than
    // fetching the literal `:courseSlug`.
    assert.equal(await run([
      routeEntry('/'),
      routeEntry('/courses/:courseSlug'),
      routeEntry('*', { startPath: '/does-not-exist' }),
    ]), 2);

    // A probe that does not satisfy its own pattern proves nothing.
    assert.equal(await run([
      routeEntry('/'),
      routeEntry('/courses/:courseSlug', { startPath: '/dashboard' }),
      routeEntry('*', { startPath: '/does-not-exist' }),
    ]), 2);

    // A catch-all probed with a URL another declared route claims exercises the
    // sibling route, not the 404.
    assert.equal(await run([
      routeEntry('/'),
      routeEntry('/courses/:courseSlug', { startPath: '/courses/html-css' }),
      routeEntry('*', { startPath: '/courses/html-css' }),
    ]), 2);

    // Concrete probes for both patterns: the sweep runs and the report stays
    // indexed by the contract identity, not by the URL that was visited.
    assert.equal(await run([
      routeEntry('/'),
      routeEntry('/courses/:courseSlug', { startPath: '/courses/html-css' }),
      routeEntry('*', { startPath: '/does-not-exist' }),
    ]), 0);
    const report = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, 'R'), 'utf8'));
    assert.deepEqual(
      report.routes.map((route: { route: string }) => route.route).sort(),
      ['*', '/', '/courses/:courseSlug'],
    );
  });
});

test('browser CLI requires an interactive action and records a behavioral failure screenshot', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd);
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(false),
    ], cwd), 2);
    assert.equal(fs.existsSync(qaReportV2Path(cwd, 'R')), false);

    installFakePlaywright(cwd, { failVisible: true });
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd), 1);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    const viewport = machine?.routes[0]?.viewports[0];
    assert.equal(viewport?.status, 'failed');
    assert.ok(viewport?.screenshotPath);
    assert.equal(fs.existsSync(path.join(
      cwd,
      '.traffic-one/reports/qa/R',
      viewport!.screenshotPath!,
    )), true);
  });
});

test('browser CLI requires page runtime listeners or an observed document replacement', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd, { runtimeListeners: 0 });
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd), 1);
    const withoutListeners = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.equal(withoutListeners?.routes[0]?.viewports[0]?.actionsPassed, true);
    assert.equal(withoutListeners?.routes[0]?.viewports[0]?.hydrationPassed, false);
  });

  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd, { runtimeListeners: 0, documentChanged: true });
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd), 0);
    const withNavigationActivity = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.equal(withNavigationActivity?.routes[0]?.viewports[0]?.actionsPassed, true);
    assert.equal(withNavigationActivity?.routes[0]?.viewports[0]?.hydrationPassed, true);
  });
});

test('browser CLI records HTTP failures from every origin and ignores non-network schemes', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd, {
      crossOriginStatus: 503,
      crossOriginRequestFailed: true,
      nonNetworkNoise: true,
    });
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd), 1);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    const errors = machine?.routes[0]?.viewports[0]?.networkErrors || [];
    assert.deepEqual(errors, [
      '503 https://api.example.test/data',
      'requestfailed https://cdn.example.test/runtime.js',
    ]);
  });

  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd, { nonNetworkNoise: true });
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd), 0);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.deepEqual(machine?.routes[0]?.viewports[0]?.networkErrors, []);
  });
});

test('browser CLI reports a missing project-local Playwright runtime as blocked-environment', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd);
    const code = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(code, 2);
    const result = readQaReportV2(cwd, 'R');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'blocked-environment');
    assert.equal(fs.existsSync(qaReportV2Path(cwd, 'R')), true);
  });
});

test('native CLI is blocked without a supported shell-free adapter command', async () => {
  await withProject(async (cwd) => {
    const contract = setupNativeProject(cwd);
    assert.equal(contract.nativeAdapter, 'xcode-simulator');
    const code = await main(['native', '--run-id', 'R'], cwd);
    assert.equal(code, 2);

    const result = readQaReportV2(cwd, 'R');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'blocked-environment');
    const evidence = parseQaNativeEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/native-evidence-v1.json',
    )));
    assert.equal(evidence?.status, 'blocked-environment');
    assert.equal(evidence?.adapter, 'xcode-simulator');
    assert.match(evidence?.blockerSummary || '', /shell-free.*command/i);
  });
});

test('native CLI runs xcodebuild without a shell and verifies xcresulttool machine JSON', async () => {
  await withProject(async (cwd) => {
    const contract = setupNativeProject(cwd);
    const bin = installFakeXcodeTools();
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
    try {
      const code = await main([
        'native',
        '--run-id', 'R',
        '--native-command-json', JSON.stringify([
          'xcodebuild',
          'test',
          '-scheme', 'NativeApp',
          '-destination', 'platform=iOS Simulator,name=iPhone 16',
        ]),
      ], cwd);
      assert.equal(code, 0);
      const result = readQaReportV2(cwd, 'R');
      assert.equal(result.ok, true);
      const evidence = parseQaNativeEvidence(readJsonFile(path.join(
        cwd,
        '.traffic-one/reports/qa/R/native-evidence-v1.json',
      )));
      assert.equal(evidence?.status, 'passed');
      assert.equal(evidence?.adapter, contract.nativeAdapter);
      assert.equal(evidence?.parser, 'xcode-xcresult-summary-v1');
      assert.deepEqual(evidence?.summary, {
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      });
      assert.ok(evidence?.artifacts?.some((artifact) => artifact.path.includes('.xcresult/')));
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

test('native CLI reports a missing simulator destination as blocked-environment', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-tools-'));
    const xcodebuild = path.join(bin, 'xcodebuild');
    fs.writeFileSync(xcodebuild, `#!${process.execPath}
process.stderr.write('Unable to find a destination matching the provided destination specifier');
process.exit(70);
`);
    fs.chmodSync(xcodebuild, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const code = await main([
        'native',
        '--run-id', 'R',
        '--native-command-json', JSON.stringify([
          'xcodebuild',
          'test',
          '-scheme', 'NativeApp',
          '-destination', 'platform=iOS Simulator,name=Unavailable',
        ]),
      ], cwd);
      assert.equal(code, 2);
      const result = readQaReportV2(cwd, 'R');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'blocked-environment');
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

test('native CLI runs Android connected tests through Gradle Wrapper and reparses fresh JUnit XML', async () => {
  await withProject(async (cwd) => {
    const contract = setupAndroidNativeProject(cwd);
    assert.equal(contract.nativeAdapter, 'android-emulator');
    const code = await main([
      'native',
      '--run-id', 'R',
      '--native-command-json', JSON.stringify([
        './gradlew',
        ':app:connectedDebugAndroidTest',
      ]),
    ], cwd);
    assert.equal(code, 0);
    const result = readQaReportV2(cwd, 'R');
    assert.equal(result.ok, true);
    const evidence = parseQaNativeEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/native-evidence-v1.json',
    )));
    assert.equal(evidence?.status, 'passed');
    assert.equal(evidence?.parser, 'android-junit-xml-v1');
    assert.deepEqual(evidence?.summary, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.ok(evidence?.artifacts?.every((artifact) => artifact.path.endsWith('.xml')));
    const rawArtifact = evidence!.artifacts![0]!;
    fs.appendFileSync(
      path.join(cwd, '.traffic-one/reports/qa/R', rawArtifact.path),
      '\n<!-- tampered -->\n',
    );
    const tampered = readQaReportV2(cwd, 'R');
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, 'native-evidence-invalid');
  });
});

test('native parsers reject prose, entities, inconsistent totals, and unsupported commands', async () => {
  assert.equal(parseAndroidJUnitXml('<testsuite>simulator passed</testsuite>'), null);
  assert.equal(parseAndroidJUnitXml(
    '<!DOCTYPE x [<!ENTITY pass "yes">]><testsuite tests="1"><testcase name="x"/></testsuite>',
  ), null);
  assert.equal(parseXcodeResultSummary({
    totalTestCount: 2,
    passedTests: 2,
    failedTests: 1,
    skippedTests: 0,
    result: 'Passed',
  }), null);
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    const code = await main([
      'native',
      '--run-id', 'R',
      '--native-command-json', JSON.stringify([
        process.execPath,
        '-e',
        'process.stdout.write("passed")',
      ]),
    ], cwd);
    assert.equal(code, 2);
    const evidence = parseQaNativeEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/native-evidence-v1.json',
    )));
    assert.equal(evidence?.status, 'blocked-environment');
    assert.equal(evidence?.artifacts, undefined);
  });
});

test('runtime manifest paths are strict and a proxied echo-only server cannot attest the build', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd);
    installFakePlaywright(cwd);
    assert.equal(computeBuildOutputManifest(cwd, './apps/web/dist'), null);
    assert.equal(computeBuildOutputManifest(cwd, 'apps/web/../web/dist'), null);
    assert.equal(computeBuildOutputManifest(cwd, 'apps/web/d*'), null);
    assert.equal(await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
      '--out', './machine-evidence-v1.json',
    ], cwd), 2);

    const fakeServer = path.join(cwd, 'node_modules', 'echo-server.js');
    fs.writeFileSync(fakeServer, `
const http = require('http');
const port = Number(process.argv[2]);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<main><button>Open</button></main>');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
    const code = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
      '--server-command-json', JSON.stringify([process.execPath, fakeServer, '{PORT}']),
    ], cwd);
    assert.equal(code, 1);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.equal(machine?.status, 'failed');
    assert.match(machine?.blockerSummary || '', /did not match the build output manifest/);
  });
});

test('visual browser CLI treats horizontal overflow as a functional failure', async () => {
  await withProject(async (cwd) => {
    setupProject(cwd, { visual: true });
    installFakePlaywright(cwd);
    installFakeLighthouse(cwd);
    const code = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(code, 0);
    assert.equal(readQaReportV2(cwd, 'R').ok, true);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    const viewports = machine?.routes[0]?.viewports || [];
    assert.deepEqual(viewports.map((viewport) => viewport.width), [390, 1440]);
    for (const viewport of viewports) {
      assert.ok(viewport.screenshotPath);
      assert.equal(
        decodeImageFile(path.join(
          cwd,
          '.traffic-one/reports/qa/R',
          viewport.screenshotPath!,
        ))?.width,
        viewport.width,
      );
    }
  });

  await withProject(async (cwd) => {
    setupProject(cwd, { visual: true });
    installFakePlaywright(cwd, { overflow: true });
    const code = await main([
      'browser',
      '--run-id', 'R',
      '--build-dir', 'apps/web/dist',
      '--scenario-json', scenario(),
    ], cwd);
    assert.equal(code, 1);
    const machine = parseQaMachineEvidence(readJsonFile(path.join(
      cwd,
      '.traffic-one/reports/qa/R/machine-evidence-v1.json',
    )));
    assert.ok(machine?.routes[0]?.viewports.every((viewport) => (
      viewport.consoleErrors.some((error) => /horizontal overflow/.test(error))
    )));
  });
});

test('an api-only run reaches a valid settled report', async () => {
  await withProject(async (cwd) => {
    // A Go service: no web surface, no JS build output. Before the `stack`
    // command this run was unfinishable — `stack-test`/`stack-lint` were
    // required and nothing in the repo produced them.
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/api\n\ngo 1.23\n');
    fs.mkdirSync(path.join(cwd, 'internal/api'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'internal/api/handler.go'), 'package api\n');
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-stack',
      frontend: 'none',
      backend: 'golang',
      mobile: { framework: 'none' },
    };
    const architecture = compileArchitecture(cwd, 'R', state, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'api', name: 'Api', kind: 'feature' }],
    });
    const contract = compileVerificationContract(cwd, 'R', state, architecture, {
      changedPaths: ['internal/api/handler.go'],
    });
    assert.equal(contract.uiImpact, 'none', 'fixture guard: no UI surface');
    assert.equal(contract.browserRequired, false);
    assert.ok(contract.requiredChecks.includes('stack-build'));

    // `browser` must now say "not required" cleanly rather than erroring.
    assert.equal(
      await main(['browser', '--project-root', cwd, '--run-id', 'R', '--build-dir', 'dist']),
      0,
      'a no-browser contract is a correct state, not a failure',
    );

    const code = await main(['stack', '--project-root', cwd, '--run-id', 'R']);
    const report = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, 'R'), 'utf8'));
    type Check = { id: string; status: string; summary?: string };
    const byId = new Map<string, Check>(
      (report.checks as Check[]).map((check) => [check.id, check]),
    );
    // `go build ./...` runs for real when Go is installed; when it is not, the
    // check is honestly not-applicable rather than silently green.
    assert.ok(['passed', 'not-applicable'].includes(byId.get('stack-build')!.status));
    for (const id of ['stack-test', 'stack-lint']) {
      const check = byId.get(id)!;
      assert.ok(
        ['passed', 'not-applicable'].includes(check.status),
        `${id} must be honestly reported, was ${check.status}`,
      );
      if (check.status === 'not-applicable') {
        assert.match(String(check.summary), /not run:/, 'a skipped check must state why');
      }
    }
    assert.equal(code, 0, 'the report must validate against the active contract');
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.routes, []);
  });
});

// Regression: validateQaReportV2 deliberately refuses a justified
// `not-applicable` for stack-build — "a backend that does not build is broken,
// and every supported backend has a build form" — but no Python build form was
// resolved, so an api-only Python project could never satisfy the check and
// could never settle. That is the same gap the stack runner closed for Go.
// Byte-compiling IS Python's build: it turns source into the artifact the
// interpreter runs, and it fails on a syntax error anywhere in the tree.
// Found by the run-sim tier's Python shape.
test('resolveStackCommand gives a Python project a real build form', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pystack-'));
  try {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "api"\n');
    const build = resolveStackCommand(dir, 'stack-build');
    assert.ok(!('unavailable' in build), 'a Python project must resolve a build command');
    if ('unavailable' in build) return;
    assert.equal(build.command, 'python3');
    assert.deepEqual(build.args, ['-m', 'compileall', '-q', '.']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project with no Python markers still declares no build command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-nostack-'));
  try {
    // No manifest, no go.mod, no pyproject: the runner must NOT invent one.
    const build = resolveStackCommand(dir, 'stack-build');
    assert.ok('unavailable' in build, 'never invent a command the project does not declare');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
