#!/usr/bin/env node
// Bundled, dependency-free QA evidence runner. It loads Playwright only from the
// target project, owns the served listener (static output or a child command
// behind a runtime proxy), executes a bounded declarative scenario, and writes
// hash-valid evidence consumed by QaReportV2.

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import * as fs from 'fs';
import { createServer, type Server } from 'http';
import * as path from 'path';

import { pluginVersion } from '../../config/plugin-identity';
import { stableContractJson } from '../../shared/architecture-contract';
import { writeJson } from '../../shared/fsjson';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  readLighthouseArtifact,
  type BuildOutputManifestV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { sha256 } from '../../shared/text';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type VerificationContractV2,
} from '../../shared/verification-contract';

type Rec = Record<string, unknown>;

interface ScenarioStep {
  type: 'click' | 'fill' | 'press' | 'check' | 'select' | 'expect-visible' | 'expect-text' | 'expect-url';
  selector?: string;
  value?: string;
}

interface RouteScenario {
  route: string;
  finalPath: string;
  stableSelector: string;
  steps: ScenarioStep[];
}

interface ScenarioV1 {
  schemaVersion: 1;
  routes: RouteScenario[];
}

interface RunnerArgs {
  command: 'manifest' | 'browser' | 'lighthouse' | 'native' | 'help';
  projectRoot: string;
  runId: string;
  buildDir: string;
  scenarioJson?: string;
  scenarioFile?: string;
  serverCommandJson?: string;
  serverCwd?: string;
  nativeCommandJson?: string;
  nativeCwd?: string;
  withLighthouse: boolean;
  artifact?: string;
  lighthouseEvidence?: string;
  out?: string;
  timeoutMs: number;
}

interface LocatorLike {
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(value: string): Promise<void>;
  check(): Promise<void>;
  selectOption(value: string): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
}

interface PageLike {
  on(event: string, listener: (value: unknown) => void): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): { first(): LocatorLike };
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<Buffer>;
}

interface ContextLike {
  tracing: {
    start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(options: { viewport: { width: number; height: number } }): Promise<ContextLike>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launch(options: { headless: boolean }): Promise<BrowserLike>;
  };
}

interface OwnedServer {
  server: Server;
  mode: 'runtime-static' | 'runtime-command';
  url: string;
  port: number;
  startedAt: string;
  servedAssetHashes: Set<string>;
  child?: ChildProcess;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1]!.trim() : '';
}

function parseArgs(argv: readonly string[], cwd: string): RunnerArgs | null {
  const first = argv[0] || '';
  const command = first === 'manifest' || first === 'browser' || first === 'lighthouse' || first === 'native'
    ? first
    : first === 'help' || first === '--help' || first === '-h'
      ? 'help'
      : null;
  if (!command) return null;
  const projectRoot = path.resolve(valueAfter(argv, '--project-root') || cwd);
  const runId = valueAfter(argv, '--run-id');
  const buildDir = valueAfter(argv, '--build-dir');
  const timeoutRaw = Number(valueAfter(argv, '--timeout-ms'));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 300_000
    ? Math.floor(timeoutRaw)
    : 30_000;
  return {
    command,
    projectRoot,
    runId,
    buildDir,
    ...(valueAfter(argv, '--scenario-json') ? { scenarioJson: valueAfter(argv, '--scenario-json') } : {}),
    ...(valueAfter(argv, '--scenario-file') ? { scenarioFile: valueAfter(argv, '--scenario-file') } : {}),
    ...(valueAfter(argv, '--server-command-json')
      ? { serverCommandJson: valueAfter(argv, '--server-command-json') }
      : {}),
    ...(valueAfter(argv, '--server-cwd') ? { serverCwd: valueAfter(argv, '--server-cwd') } : {}),
    ...(valueAfter(argv, '--native-command-json')
      ? { nativeCommandJson: valueAfter(argv, '--native-command-json') }
      : {}),
    ...(valueAfter(argv, '--native-cwd') ? { nativeCwd: valueAfter(argv, '--native-cwd') } : {}),
    withLighthouse: argv.includes('--with-lighthouse'),
    ...(valueAfter(argv, '--artifact') ? { artifact: valueAfter(argv, '--artifact') } : {}),
    ...(valueAfter(argv, '--lighthouse-evidence')
      ? { lighthouseEvidence: valueAfter(argv, '--lighthouse-evidence') }
      : {}),
    ...(valueAfter(argv, '--out') ? { out: valueAfter(argv, '--out') } : {}),
    timeoutMs,
  };
}

function usage(): string {
  return [
    'traffic-one QA evidence runner',
    '',
    'Manifest:',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs manifest --run-id <id> --build-dir <outputRoot>',
    '',
    'Browser (runner serves outputRoot itself; performance contracts run project-local Lighthouse on this listener):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --scenario-json \'<json>\'',
    '  Add --with-lighthouse to request the same live-listener audit when performance is advisory.',
    '',
    'Browser SSR/custom command (runner starts command behind its own proxy; {PORT} is replaced):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --server-command-json \'["pnpm","exec","next","start","-H","127.0.0.1","-p","{PORT}"]\' --scenario-json \'<json>\'',
    '',
    'Lighthouse raw artifact conversion:',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs lighthouse --run-id <id> --build-dir <outputRoot> --artifact .traffic-one/reports/qa/<id>/lighthouse/report.json',
    '  (advanced: the raw artifact must have been captured from the exact report build origin/port while it was live)',
    '',
    'Native simulator/emulator:',
    '  iOS: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["xcodebuild","test","-scheme","App","-destination","platform=iOS Simulator,name=iPhone 16"]\'',
    '  Android: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["./gradlew",":app:connectedDebugAndroidTest"]\'',
    '  Add --native-cwd <project-relative-root> for a nested native project.',
    '  Commands are executed as bounded argv without a shell. PASS requires runtime-parsed xcresulttool summary JSON or Android connected-test JUnit XML.',
    '',
    'Scenario schema:',
    '  {"schemaVersion":1,"routes":[{"route":"/","finalPath":"/","stableSelector":"main","steps":[{"type":"click","selector":"button"},{"type":"expect-visible","selector":"main"}]}]}',
  ].join('\n');
}

function strictRelative(value: string): string | null {
  if (!value
    || path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /[*?[\]{};\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/')
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function ensureProjectDirectory(projectRoot: string, relative: string): string | null {
  const normalized = strictRelative(relative);
  if (!normalized) return null;
  let realProject: string;
  try { realProject = fs.realpathSync(projectRoot); } catch { return null; }
  let current = path.resolve(projectRoot);
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    try {
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      } else {
        fs.mkdirSync(current);
      }
    } catch {
      return null;
    }
  }
  try {
    const real = fs.realpathSync(current);
    const boundary = path.relative(realProject, real);
    return !boundary.startsWith('..') && !path.isAbsolute(boundary) ? real : null;
  } catch {
    return null;
  }
}

function safeProjectRelative(projectRoot: string, value: string): string | null {
  const normalized = strictRelative(value);
  if (!normalized) return null;
  const absolute = path.resolve(projectRoot, normalized);
  const rel = path.relative(projectRoot, absolute);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? normalized : null;
}

function qaDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId);
}

function outputPath(
  args: RunnerArgs,
  defaultName: string,
): { absolute: string; relative: string } | null {
  const base = qaDir(args.projectRoot, args.runId);
  const requested = args.out || defaultName;
  const relative = strictRelative(requested);
  if (!relative) return null;
  const absolute = path.resolve(base, relative);
  const parent = path.dirname(absolute);
  const parentRel = path.relative(args.projectRoot, parent).replace(/\\/g, '/');
  try {
    const realParent = ensureProjectDirectory(args.projectRoot, parentRel);
    const realBase = fs.realpathSync(base);
    if (!realParent) return null;
    const boundary = path.relative(realBase, realParent);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
    if (fs.existsSync(absolute)) {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return null;
      const realTarget = fs.realpathSync(absolute);
      const targetBoundary = path.relative(realBase, realTarget);
      if (targetBoundary.startsWith('..') || path.isAbsolute(targetBoundary)) return null;
    }
  } catch {
    return null;
  }
  return { absolute, relative };
}

function loadRun(
  args: RunnerArgs,
): {
  contract: VerificationContractV2;
  sourceHash: string;
  manifest: BuildOutputManifestV1;
  fingerprint: string;
} | null {
  if (!SAFE_ID_RE.test(args.runId) || !args.buildDir) return null;
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract) return null;
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  const manifest = computeBuildOutputManifest(args.projectRoot, args.buildDir);
  if (!source.complete || !source.hash || !manifest) return null;
  return {
    contract,
    sourceHash: source.hash,
    manifest,
    fingerprint: expectedBuildFingerprint(args.runId, source.hash, manifest.manifestHash),
  };
}

function loadNativeRun(
  args: RunnerArgs,
): {
  contract: VerificationContractV2;
  sourceHash: string;
} | null {
  if (!SAFE_ID_RE.test(args.runId)) return null;
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract || contract.uiImpact !== 'native-ui' || !contract.nativeAdapter) return null;
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  if (!source.complete || !source.hash) return null;
  return { contract, sourceHash: source.hash };
}

function parseStep(value: unknown): ScenarioStep | null {
  if (!isRecord(value)
    || !['click', 'fill', 'press', 'check', 'select', 'expect-visible', 'expect-text', 'expect-url']
      .includes(String(value.type))) return null;
  const type = value.type as ScenarioStep['type'];
  const needsSelector = type !== 'expect-url';
  const needsValue = ['fill', 'press', 'select', 'expect-text', 'expect-url'].includes(type);
  if (needsSelector && (typeof value.selector !== 'string' || !value.selector.trim() || value.selector.length > 1_000)) return null;
  if (needsValue && (typeof value.value !== 'string' || value.value.length > 4_000)) return null;
  if (Object.keys(value).some((key) => !['type', 'selector', 'value'].includes(key))) return null;
  return {
    type,
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}),
    ...(typeof value.value === 'string' ? { value: value.value } : {}),
  };
}

function parseScenario(value: unknown, requiredRoutes: readonly string[]): ScenarioV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.routes)
    || Object.keys(value).some((key) => !['schemaVersion', 'routes'].includes(key))) return null;
  const routes: RouteScenario[] = [];
  for (const raw of value.routes) {
    if (!isRecord(raw)
      || typeof raw.route !== 'string'
      || !raw.route.startsWith('/')
      || raw.route.length > 2_048
      || typeof raw.stableSelector !== 'string'
      || !raw.stableSelector.trim()
      || raw.stableSelector.length > 1_000
      || (raw.finalPath !== undefined
        && (typeof raw.finalPath !== 'string' || !raw.finalPath.startsWith('/') || raw.finalPath.length > 2_048))
      || !Array.isArray(raw.steps)
      || raw.steps.length < 1
      || raw.steps.length > 100
      || Object.keys(raw).some((key) => !['route', 'finalPath', 'stableSelector', 'steps'].includes(key))) return null;
    const steps = raw.steps.map(parseStep);
    if (steps.some((step) => !step)) return null;
    if (!(steps as ScenarioStep[]).some((step) => (
      ['click', 'fill', 'press', 'check', 'select'].includes(step.type)
    ))) return null;
    routes.push({
      route: raw.route,
      finalPath: typeof raw.finalPath === 'string' ? raw.finalPath : raw.route,
      stableSelector: raw.stableSelector,
      steps: steps as ScenarioStep[],
    });
  }
  if (new Set(routes.map((route) => route.route)).size !== routes.length) return null;
  const expected = [...new Set(requiredRoutes)].sort();
  const observed = routes.map((route) => route.route).sort();
  return JSON.stringify(expected) === JSON.stringify(observed)
    ? { schemaVersion: 1, routes }
    : null;
}

function loadScenario(args: RunnerArgs, contract: VerificationContractV2): ScenarioV1 | null {
  let raw = args.scenarioJson || '';
  if (!raw && args.scenarioFile) {
    const rel = safeProjectRelative(args.projectRoot, args.scenarioFile);
    if (!rel) return null;
    try {
      raw = fs.readFileSync(path.join(args.projectRoot, rel), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    return parseScenario(JSON.parse(raw), contract.changedRoutes);
  } catch {
    return null;
  }
}

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
  loaded: NonNullable<ReturnType<typeof loadRun>>,
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

async function startStaticServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
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
    fs.createReadStream(absolute).pipe(response);
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

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

function parseBoundedArgv(raw: string | undefined): string[] | null {
  if (!raw || raw.length > 16_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 64
    || !value.every((entry) => typeof entry === 'string'
      && entry.length > 0
      && entry.length <= 4_096
      && !/[\u0000-\u001f\u007f]/.test(entry))) return null;
  return value as string[];
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

async function startCommandServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): Promise<OwnedServer> {
  const targetPort = await freePort();
  const command = parseServerCommand(args.serverCommandJson, targetPort);
  if (!command) throw new Error('--server-command-json must be a bounded JSON argv array');
  const cwdRel = args.serverCwd ? safeProjectRelative(args.projectRoot, args.serverCwd) : null;
  if (args.serverCwd && !cwdRel) throw new Error('--server-cwd must stay inside the project');
  const child = spawn(command[0]!, command.slice(1), {
    cwd: cwdRel ? path.join(args.projectRoot, cwdRel) : args.projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(targetPort) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  try {
    await waitForHttp(`http://127.0.0.1:${targetPort}/`, args.timeoutMs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  }
  proxyOrigin = `http://127.0.0.1:${listening.port}`;
  identity = identityBody(args, loaded, listening.port, listening.startedAt);
  return {
    server,
    child,
    mode: 'runtime-command',
    url: proxyOrigin,
    port: listening.port,
    startedAt: listening.startedAt,
    servedAssetHashes,
  };
}

async function stopOwnedServer(owned: OwnedServer): Promise<void> {
  await closeServer(owned.server);
  if (owned.child && owned.child.exitCode === null && owned.child.signalCode === null) {
    owned.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolvePromise) => owned.child!.once('exit', () => resolvePromise())),
      new Promise<void>((resolvePromise) => setTimeout(() => {
        owned.child!.kill('SIGKILL');
        resolvePromise();
      }, 1_000)),
    ]);
  }
}

function projectPlaywright(projectRoot: string): { api: PlaywrightLike; version: string } | null {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  for (const packageName of ['@playwright/test', 'playwright']) {
    try {
      const api = projectRequire(packageName) as Partial<PlaywrightLike>;
      const pkg = projectRequire(`${packageName}/package.json`) as { version?: unknown };
      if (typeof api.chromium?.launch === 'function' && typeof pkg.version === 'string') {
        return { api: api as PlaywrightLike, version: pkg.version };
      }
    } catch {
      // try the other local package
    }
  }
  return null;
}

interface LighthouseRunResult {
  status: 'passed' | 'failed' | 'blocked-environment';
  evidencePath?: string;
  blockerSummary?: string;
}

function projectLighthouseBin(args: RunnerArgs): string | null {
  const binName = process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse';
  const roots = [
    args.projectRoot,
    ...(args.serverCwd ? [path.resolve(args.projectRoot, args.serverCwd)] : []),
  ];
  for (const root of roots) {
    const candidate = path.join(root, 'node_modules', '.bin', binName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next project-local location
    }
  }
  return null;
}

function runBoundedCommand(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string => (
      `${current}${chunk.toString('utf8')}`.slice(-1024 * 1024)
    );
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`Lighthouse timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(
        `Lighthouse exited ${code ?? signal ?? 'without status'}: ${stderr || stdout}`,
      ));
    });
  });
}

async function runLighthouseOnOwnedServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
  owned: OwnedServer,
): Promise<LighthouseRunResult> {
  const binary = projectLighthouseBin(args);
  if (!binary) {
    return {
      status: 'blocked-environment',
      blockerSummary:
        'Project-local Lighthouse is unavailable. Install lighthouse as a devDependency for this performance-required run.',
    };
  }
  const rawOut = outputPath({ ...args, out: 'lighthouse.raw.json' }, 'lighthouse.raw.json');
  const evidenceOut = outputPath(
    { ...args, out: 'lighthouse-evidence-v1.json' },
    'lighthouse-evidence-v1.json',
  );
  if (!rawOut || !evidenceOut) {
    return { status: 'failed', blockerSummary: 'Lighthouse output paths are unsafe.' };
  }
  try {
    if (fs.existsSync(rawOut.absolute)) {
      if (fs.lstatSync(rawOut.absolute).isSymbolicLink()) {
        return { status: 'failed', blockerSummary: 'Lighthouse raw output path is a symlink.' };
      }
      fs.unlinkSync(rawOut.absolute);
    }
    const route = loaded.contract.changedRoutes[0] || '/';
    const target = new URL(route, `${owned.url}/`).href;
    await runBoundedCommand(binary, [
      target,
      '--only-categories=performance,accessibility,best-practices,seo',
      '--chrome-flags=--headless --no-sandbox',
      '--output=json',
      `--output-path=${rawOut.absolute}`,
      '--quiet',
    ], args.projectRoot, Math.max(args.timeoutMs, 120_000));
    const summary = readLighthouseArtifact(rawOut.absolute);
    if (!summary) {
      return {
        status: 'failed',
        blockerSummary: 'Project-local Lighthouse did not write a complete four-category JSON artifact.',
      };
    }
    const finalUrl = new URL(summary.finalUrl);
    if (finalUrl.origin !== new URL(owned.url).origin
      || Date.parse(summary.generatedAt) < Date.parse(owned.startedAt)
      || Date.parse(summary.generatedAt) > Date.now() + 1_000) {
      return {
        status: 'failed',
        blockerSummary: 'Lighthouse artifact does not belong to the runner-owned live build listener.',
      };
    }
    const evidence = createQaLighthouseEvidence({
      runId: args.runId,
      verificationContractHash: loaded.contract.contractHash,
      sourceHash: loaded.sourceHash,
      buildHash: loaded.manifest.manifestHash,
      buildFingerprint: loaded.fingerprint,
      generatedAt: summary.generatedAt,
      artifactPath: rawOut.relative,
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
    writeJson(evidenceOut.absolute, evidence);
    return { status: 'passed', evidencePath: evidenceOut.relative };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    return {
      status: /chrome.*(?:not found|missing|launch|executable)|enoent|permission/i.test(message)
        ? 'blocked-environment'
        : 'failed',
      blockerSummary: message,
    };
  }
}

function routeSlug(route: string): string {
  return route === '/' ? 'home' : route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'route';
}

async function executeStep(page: PageLike, step: ScenarioStep, timeoutMs: number): Promise<void> {
  if (step.type === 'expect-url') {
    if (new URL(page.url()).pathname !== step.value) {
      throw new Error(`expected URL path ${step.value}, observed ${new URL(page.url()).pathname}`);
    }
    return;
  }
  const locator = page.locator(step.selector!).first();
  if (step.type === 'expect-visible') {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    if (!await locator.isVisible()) throw new Error(`selector is not visible: ${step.selector}`);
  } else if (step.type === 'expect-text') {
    const text = await locator.textContent();
    if (!text?.includes(step.value!)) throw new Error(`selector ${step.selector} did not contain expected text`);
  } else if (step.type === 'click') {
    await locator.click();
  } else if (step.type === 'fill') {
    await locator.fill(step.value!);
  } else if (step.type === 'press') {
    await locator.press(step.value!);
  } else if (step.type === 'check') {
    await locator.check();
  } else if (step.type === 'select') {
    await locator.selectOption(step.value!);
  }
}

function eventText(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const text = (value as { text?: () => string }).text;
  if (typeof text === 'function') {
    try { return text.call(value).slice(0, 2_000); } catch { return '<unreadable>'; }
  }
  return String(value).slice(0, 2_000);
}

const RUNTIME_PROBE_INIT_SCRIPT = `(() => {
  const probe = {
    documentToken: typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + "-" + String(Math.random()),
    listenerRegistrations: 0
  };
  Object.defineProperty(globalThis, "__trafficOneQaRuntimeV1", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: probe
  });
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  Object.defineProperty(EventTarget.prototype, "addEventListener", {
    configurable: true,
    writable: true,
    value: function trafficOneObservedAddEventListener(...args) {
      probe.listenerRegistrations += 1;
      return Reflect.apply(originalAddEventListener, this, args);
    }
  });
})();`;

function httpNetworkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

async function runViewport(
  browser: BrowserLike,
  owned: OwnedServer,
  contract: VerificationContractV2,
  scenario: RouteScenario,
  width: number,
  outDir: string,
  timeoutMs: number,
): Promise<QaMachineViewportEvidenceV1> {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const traceName = `${routeSlug(scenario.route)}-${width}.trace.zip`;
  const traceAbsolute = path.join(outDir, traceName);
  const screenshotName = `${routeSlug(scenario.route)}-${width}.png`;
  const screenshotAbsolute = path.join(outDir, screenshotName);
  let status: QaMachineViewportEvidenceV1['status'] = 'passed';
  let domAssertionsPassed = false;
  let actionsPassed = false;
  let routingPassed = false;
  let hydrationPassed = false;
  let screenshotPath: string | undefined;
  let screenshotHash: string | undefined;
  let page: PageLike | null = null;
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  try {
    await context.addInitScript(RUNTIME_PROBE_INIT_SCRIPT);
    page = await context.newPage();
    page.on('console', (value) => {
      const type = (value as { type?: () => string }).type;
      if (typeof type === 'function' && type.call(value) === 'error') consoleErrors.push(eventText(value));
    });
    page.on('pageerror', (value) => consoleErrors.push(eventText(value)));
    page.on('requestfailed', (value) => {
      const requestUrl = (value as { url?: () => string }).url;
      if (typeof requestUrl === 'function') {
        try {
          const observed = httpNetworkUrl(requestUrl.call(value));
          if (observed) networkErrors.push(`requestfailed ${observed}`);
        } catch {
          // A malformed event payload is not usable network evidence.
        }
      }
    });
    page.on('response', (value) => {
      const responseUrl = (value as { url?: () => string }).url;
      const statusCode = (value as { status?: () => number }).status;
      if (typeof responseUrl === 'function' && typeof statusCode === 'function') {
        try {
          const statusValue = statusCode.call(value);
          const observed = httpNetworkUrl(responseUrl.call(value));
          if (observed && statusValue >= 400) {
            networkErrors.push(`${statusValue} ${observed}`);
          }
        } catch {
          // A malformed event payload is not usable network evidence.
        }
      }
    });
    const target = new URL(scenario.route, `${owned.url}/`).href;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('load', { timeout: timeoutMs });
    await page.locator(scenario.stableSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    domAssertionsPassed = true;
    const initialRuntimeState = await page.evaluate(`({
      documentToken: String(globalThis.__trafficOneQaRuntimeV1?.documentToken || "")
    })`);
    let interactiveSteps = 0;
    for (const step of scenario.steps) {
      await executeStep(page, step, timeoutMs);
      if (['click', 'fill', 'press', 'check', 'select'].includes(step.type)) interactiveSteps += 1;
    }
    actionsPassed = interactiveSteps > 0;
    await page.waitForTimeout(50);
    routingPassed = new URL(page.url()).pathname === scenario.finalPath;
    const runtimeState = await page.evaluate(`({
      documentReady: document.readyState === "complete" && !!document.body && document.body.childElementCount > 0,
      documentToken: String(globalThis.__trafficOneQaRuntimeV1?.documentToken || ""),
      listenerRegistrations: Number(globalThis.__trafficOneQaRuntimeV1?.listenerRegistrations || 0),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth
        && (!document.body || document.body.scrollWidth <= window.innerWidth)
    })`);
    const documentReplaced = isRecord(initialRuntimeState)
      && typeof initialRuntimeState.documentToken === 'string'
      && initialRuntimeState.documentToken.length > 0
      && isRecord(runtimeState)
      && typeof runtimeState.documentToken === 'string'
      && runtimeState.documentToken.length > 0
      && runtimeState.documentToken !== initialRuntimeState.documentToken;
    hydrationPassed = actionsPassed
      && isRecord(runtimeState)
      && runtimeState.documentReady === true
      && (
        (typeof runtimeState.listenerRegistrations === 'number'
          && runtimeState.listenerRegistrations > 0)
        || documentReplaced
      );
    if (contract.uiImpact === 'visual'
      && (!isRecord(runtimeState) || runtimeState.noHorizontalOverflow !== true)) {
      domAssertionsPassed = false;
      consoleErrors.push('horizontal overflow exceeds the tested viewport');
    }
    if (contract.uiImpact === 'visual') {
      await page.screenshot({ path: screenshotAbsolute, fullPage: true });
      screenshotPath = screenshotName;
      screenshotHash = contentHash(screenshotAbsolute) || undefined;
    }
    if (!domAssertionsPassed
      || !actionsPassed
      || !routingPassed
      || !hydrationPassed
      || consoleErrors.length > 0
      || networkErrors.length > 0
      || (contract.uiImpact === 'visual' && !screenshotHash)) status = 'failed';
  } catch (error) {
    status = 'failed';
    consoleErrors.push(error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000));
    if (page && !screenshotPath) {
      try {
        await page.screenshot({ path: screenshotAbsolute, fullPage: true });
        screenshotPath = screenshotName;
        screenshotHash = contentHash(screenshotAbsolute) || undefined;
      } catch (screenshotError) {
        consoleErrors.push(
          `failure screenshot unavailable: ${
            screenshotError instanceof Error ? screenshotError.message : String(screenshotError)
          }`.slice(0, 2_000),
        );
      }
    }
  } finally {
    await context.tracing.stop({ path: traceAbsolute });
    await context.close();
  }
  const traceHash = contentHash(traceAbsolute);
  if (!traceHash) throw new Error(`Playwright trace was not written: ${traceName}`);
  return {
    width,
    status,
    domAssertionsPassed,
    actionsPassed,
    routingPassed,
    hydrationPassed,
    consoleErrors,
    networkErrors,
    artifactAt: new Date().toISOString(),
    tracePath: traceName,
    traceHash,
    ...(screenshotPath && screenshotHash ? { screenshotPath, screenshotHash } : {}),
  };
}

function reportLighthousePath(args: RunnerArgs): string | null {
  if (!args.lighthouseEvidence) return null;
  return strictRelative(args.lighthouseEvidence);
}

function publishAndValidateReport(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
  owned: OwnedServer,
  machineEvidencePath: string,
  status: QaReportV2['status'],
  routes: QaReportV2['routes'],
  blockerSummary?: string,
  lighthouseEvidencePath?: string,
): { report: QaReportV2; ok: boolean; code?: string; message?: string } {
  const lighthousePath = lighthouseEvidencePath || reportLighthousePath(args);
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks: loaded.contract.requiredChecks.map((id) => ({
      id,
      status: status === 'passed' ? 'passed' : 'failed',
      summary: status === 'passed'
        ? 'Executed by traffic-one-qa-runner.'
        : blockerSummary || 'Runtime QA evidence did not pass.',
    })),
    routes,
    machineEvidencePath,
    build: {
      runId: args.runId,
      sourceHash: loaded.sourceHash,
      outputRoot: loaded.manifest.outputRoot,
      buildHash: loaded.manifest.manifestHash,
      pid: process.pid,
      port: owned.port,
      startedAt: owned.startedAt,
      url: owned.url,
      fingerprint: loaded.fingerprint,
      servedFingerprint: loaded.fingerprint,
    },
    ...(lighthousePath ? { lighthouse: { evidencePath: lighthousePath } } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), report);
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  return validation.ok
    ? { report, ok: true }
    : { report, ok: false, code: validation.code, message: validation.message };
}

async function browserCommand(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): Promise<number> {
  if (!loaded.contract.browserRequired) {
    process.stderr.write('qa-evidence: active VerificationContractV2 does not require browser evidence.\n');
    return 2;
  }
  const scenario = loadScenario(args, loaded.contract);
  const out = outputPath(args, 'machine-evidence-v1.json');
  if (!scenario || !out) {
    process.stderr.write('qa-evidence: scenario/output path is invalid or does not cover changedRoutes exactly.\n');
    return 2;
  }
  fs.mkdirSync(path.dirname(out.absolute), { recursive: true });
  const scenarioHash = sha256(stableContractJson(scenario));
  const owned = args.serverCommandJson
    ? await startCommandServer(args, loaded)
    : await startStaticServer(args, loaded);
  let stopped = false;
  const stopOnce = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopOwnedServer(owned);
  };
  try {
  const startedAt = new Date().toISOString();
  const playwright = projectPlaywright(args.projectRoot);
  if (!playwright) {
    const blockerSummary =
      'Project-local Playwright is unavailable. Install @playwright/test and its browser binary.';
    const evidence = createQaMachineEvidence({
      runnerVersion: pluginVersion(),
      playwrightVersion: 'unavailable',
      runId: args.runId,
      verificationContractHash: loaded.contract.contractHash,
      sourceHash: loaded.sourceHash,
      buildOutputRoot: loaded.manifest.outputRoot,
      buildHash: loaded.manifest.manifestHash,
      buildFingerprint: loaded.fingerprint,
      serverMode: owned.mode,
      serverPid: process.pid,
      serverPort: owned.port,
      serverStartedAt: owned.startedAt,
      serverUrl: owned.url,
      servedAssetHashes: [],
      scenarioHash,
      startedAt,
      generatedAt: new Date().toISOString(),
      status: 'blocked-environment',
      routes: [],
      blockerSummary,
    });
    writeJson(out.absolute, evidence);
    let published: ReturnType<typeof publishAndValidateReport>;
    try {
      published = publishAndValidateReport(
        args,
        loaded,
        owned,
        out.relative,
        'blocked-environment',
        [],
        blockerSummary,
      );
    } finally {
      await stopOnce();
    }
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'blocked-environment',
      reason: 'playwright-missing',
      machineEvidencePath: out.relative,
      reportPath: qaReportV2Path(args.projectRoot, args.runId),
      validation: {
        ok: published.ok,
        ...(published.code ? { code: published.code } : {}),
        ...(published.message ? { message: published.message } : {}),
      },
    })}\n`);
    return 2;
  }

  let browser: BrowserLike | null = null;
  const routes: QaMachineRouteEvidenceV1[] = [];
  let blocker: string | null = null;
  try {
    browser = await playwright.api.chromium.launch({ headless: true });
    const widths = loaded.contract.requiredScreenshotWidths.length > 0
      ? loaded.contract.requiredScreenshotWidths
      : [1440];
    for (const route of scenario.routes) {
      const viewports: QaMachineViewportEvidenceV1[] = [];
      for (const width of widths) {
        viewports.push(await runViewport(
          browser,
          owned,
          loaded.contract,
          route,
          width,
          path.dirname(out.absolute),
          args.timeoutMs,
        ));
      }
      routes.push({ route: route.route, viewports });
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  } finally {
    try { await browser?.close(); } catch { /* best effort */ }
  }
  const browserScenarioFailed = Boolean(blocker)
    || routes.some((route) => route.viewports.some((viewport) => viewport.status !== 'passed'));
  const lighthouseRequested = loaded.contract.performance.required || args.withLighthouse;
  const lighthouse = lighthouseRequested && !browserScenarioFailed
    ? await runLighthouseOnOwnedServer(args, loaded, owned)
    : null;
  const servedAssetHashes = [...owned.servedAssetHashes].sort();
  const failed = browserScenarioFailed
    || servedAssetHashes.length === 0
    || lighthouse?.status === 'failed';
  const browserUnavailable = Boolean(blocker && /browser.*(?:missing|install|executable)|playwright.*install/i.test(blocker));
  const environmentBlocked = browserUnavailable || lighthouse?.status === 'blocked-environment';
  const status = environmentBlocked
    ? 'blocked-environment' as const
    : failed
      ? 'failed' as const
      : 'passed' as const;
  const blockerSummary = blocker
    || lighthouse?.blockerSummary
    || (servedAssetHashes.length === 0
      ? 'Served responses did not match the build output manifest.'
      : undefined);
  const evidence = createQaMachineEvidence({
    runnerVersion: pluginVersion(),
    playwrightVersion: playwright.version,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    buildOutputRoot: loaded.manifest.outputRoot,
    buildHash: loaded.manifest.manifestHash,
    buildFingerprint: loaded.fingerprint,
    serverMode: owned.mode,
    serverPid: process.pid,
    serverPort: owned.port,
    serverStartedAt: owned.startedAt,
    serverUrl: owned.url,
    servedAssetHashes,
    scenarioHash,
    startedAt,
    generatedAt: new Date().toISOString(),
    status,
    routes,
    ...(blockerSummary ? { blockerSummary } : {}),
  });
  writeJson(out.absolute, evidence);
  const reportRoutes = routes.map((route) => ({
    route: route.route,
    viewports: route.viewports.map((viewport) => ({
      width: viewport.width,
      status: viewport.status,
      domAssertionsPassed: viewport.domAssertionsPassed,
      actionsPassed: viewport.actionsPassed,
      routingPassed: viewport.routingPassed,
      hydrationPassed: viewport.hydrationPassed,
      consoleErrors: viewport.consoleErrors,
      networkErrors: viewport.networkErrors,
      artifactAt: viewport.artifactAt,
      ...(viewport.screenshotPath ? { screenshotPath: viewport.screenshotPath } : {}),
    })),
  }));
  let published: ReturnType<typeof publishAndValidateReport>;
  try {
    published = publishAndValidateReport(
      args,
      loaded,
      owned,
      out.relative,
      status,
      reportRoutes,
      evidence.blockerSummary,
      lighthouse?.evidencePath,
    );
  } finally {
    await stopOnce();
  }
  process.stdout.write(`${JSON.stringify({
    ok: published.ok,
    status,
    machineEvidencePath: out.relative,
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: {
      ok: published.ok,
      ...(published.code ? { code: published.code } : {}),
      ...(published.message ? { message: published.message } : {}),
    },
    ...(evidence.blockerSummary ? { blockerSummary: evidence.blockerSummary } : {}),
  })}\n`);
  if (status === 'blocked-environment') return 2;
  return published.ok ? 0 : 1;
  } finally {
    await stopOnce();
  }
}

interface BoundedProcessResult {
  kind: 'completed' | 'unavailable' | 'timeout' | 'output-limit';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface NativeMachineResult {
  parser: 'xcode-xcresult-summary-v1' | 'android-junit-xml-v1';
  summary: QaNativeTestSummaryV1;
  artifacts: QaNativeArtifactV1[];
}

const MAX_NATIVE_PROCESS_OUTPUT = 8 * 1024 * 1024;
const MAX_NATIVE_ARTIFACTS = 25_000;
const MAX_NATIVE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

function runBoundedProcess(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<BoundedProcessResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd,
        env: { ...process.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        kind: 'unavailable',
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let forced: BoundedProcessResult['kind'] | null = null;
    let settled = false;
    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (forced) return;
      bytes += chunk.length;
      if (bytes > MAX_NATIVE_PROCESS_OUTPUT) {
        forced = 'output-limit';
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error: NodeJS.ErrnoException) => finish({
      kind: error.code === 'ENOENT' ? 'unavailable' : 'completed',
      exitCode: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}`,
    }));
    child.once('close', (code) => finish({
      kind: forced || 'completed',
      exitCode: typeof code === 'number' ? code : null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    const timer = setTimeout(() => {
      forced = 'timeout';
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs);
  });
}

function nativeWorkingDirectory(args: RunnerArgs): string | null {
  if (!args.nativeCwd) return fs.realpathSync(args.projectRoot);
  const relative = safeProjectRelative(args.projectRoot, args.nativeCwd);
  if (!relative) return null;
  try {
    const project = fs.realpathSync(args.projectRoot);
    const cwd = fs.realpathSync(path.join(args.projectRoot, relative));
    const boundary = path.relative(project, cwd);
    return !boundary.startsWith('..') && !path.isAbsolute(boundary) && fs.statSync(cwd).isDirectory()
      ? cwd
      : null;
  } catch {
    return null;
  }
}

function configuredNativeCommand(
  args: RunnerArgs,
  adapter: string,
): { command: string[]; cwd: string } | null {
  const command = parseBoundedArgv(args.nativeCommandJson);
  const cwd = nativeWorkingDirectory(args);
  if (!command || !cwd) return null;
  if (adapter === 'xcode-simulator') {
    if (command[0] !== 'xcodebuild'
      || !command.slice(1).some((arg) => arg === 'test' || arg === 'test-without-building')
      || !command.slice(1).some((arg) => /^platform=iOS Simulator(?:,|$)/.test(arg))
      || command.some((arg) => ['-resultBundlePath', '-resultStreamPath'].includes(arg))) return null;
    return { command, cwd };
  }
  if (adapter === 'android-emulator') {
    const executable = command[0];
    const task = command.slice(1).find((arg) => (
      /^(?::[A-Za-z0-9_.-]+)*:?connected[A-Za-z0-9_.-]*AndroidTest$/.test(arg)
    ));
    if (!executable
      || !['./gradlew', 'gradlew.bat'].includes(executable)
      || !task
      || command.some((arg) => [
        '--init-script', '-I', '--project-dir', '-p', '--settings-file', '-c', '--build-file', '-b',
      ].includes(arg))) return null;
    return { command, cwd };
  }
  return null;
}

function nativeArtifact(
  qaRoot: string,
  absolute: string,
  startedAtMs: number,
): QaNativeArtifactV1 | null {
  try {
    const realQa = fs.realpathSync(qaRoot);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1
      || stat.mtimeMs + 1_000 < startedAtMs) return null;
    const real = fs.realpathSync(absolute);
    const boundary = path.relative(realQa, real);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
    const relative = path.relative(realQa, real).replace(/\\/g, '/');
    if (!strictRelative(relative)) return null;
    const sha256Value = contentHash(real);
    if (!sha256Value) return null;
    return {
      path: relative,
      size: stat.size,
      sha256: sha256Value,
      artifactAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function collectNativeArtifacts(
  qaRoot: string,
  root: string,
  startedAtMs: number,
): QaNativeArtifactV1[] | null {
  const artifacts: QaNativeArtifactV1[] = [];
  let bytes = 0;
  const visit = (current: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      const artifact = nativeArtifact(qaRoot, absolute, startedAtMs);
      if (!artifact) return false;
      bytes += artifact.size;
      artifacts.push(artifact);
      if (artifacts.length > MAX_NATIVE_ARTIFACTS || bytes > MAX_NATIVE_ARTIFACT_BYTES) return false;
    }
    return true;
  };
  return visit(root) && artifacts.length > 0 ? artifacts : null;
}

function androidResultRoots(cwd: string): string[] | null {
  const roots: string[] = [];
  let visited = 0;
  const visit = (current: string, depth: number): boolean => {
    if (depth > 8 || visited > 20_000) return false;
    visited += 1;
    const candidate = path.join(current, 'build', 'outputs', 'androidTest-results', 'connected');
    try {
      if (fs.statSync(candidate).isDirectory()) roots.push(fs.realpathSync(candidate));
    } catch {
      // This module has no connected-test result root.
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || ['.git', '.traffic-one', 'node_modules', 'build'].includes(entry.name)) continue;
      if (!visit(path.join(current, entry.name), depth + 1)) return false;
    }
    return true;
  };
  return visit(cwd, 0) ? [...new Set(roots)].sort() : null;
}

function androidResultFiles(roots: readonly string[]): string[] | null {
  const files: string[] = [];
  let visited = 0;
  const visit = (current: string): boolean => {
    if (visited > 50_000) return false;
    visited += 1;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
      } else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
        files.push(absolute);
        if (files.length > MAX_NATIVE_ARTIFACTS) return false;
      }
    }
    return true;
  };
  for (const root of roots) {
    if (!visit(root)) return null;
  }
  return files.sort();
}

function fileSnapshot(files: readonly string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const file of files) {
    try {
      const hash = contentHash(file);
      if (hash) snapshot.set(fs.realpathSync(file), hash);
    } catch { /* incomplete input is ignored */ }
  }
  return snapshot;
}

async function runXcodeNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<{ process: BoundedProcessResult; machine: NativeMachineResult | null; detail: string }> {
  const bundle = path.join(captureRoot, 'result.xcresult');
  const actualCommand = [...command, '-resultBundlePath', bundle];
  const processResult = await runBoundedProcess(actualCommand, cwd, args.timeoutMs);
  if (processResult.kind !== 'completed' || !fs.existsSync(bundle)) {
    return { process: processResult, machine: null, detail: processResult.stderr || processResult.kind };
  }
  const parserResult = await runBoundedProcess([
    'xcrun',
    'xcresulttool',
    'get',
    'test-results',
    'summary',
    '--schema-version',
    '0.1.0',
    '--path',
    bundle,
    '--compact',
  ], cwd, Math.min(args.timeoutMs, 60_000));
  if (parserResult.kind !== 'completed' || parserResult.exitCode !== 0) {
    return {
      process: parserResult,
      machine: null,
      detail: parserResult.stderr || 'xcresulttool could not read the result bundle',
    };
  }
  let raw: unknown;
  try { raw = JSON.parse(parserResult.stdout); } catch { raw = null; }
  const summary = parseXcodeResultSummary(raw);
  if (!summary) {
    return { process: processResult, machine: null, detail: 'xcresulttool summary JSON is unsupported or incomplete' };
  }
  const summaryPath = path.join(captureRoot, 'xcode-result-summary.json');
  writeJson(summaryPath, raw);
  const artifacts = collectNativeArtifacts(qaRoot, captureRoot, startedAtMs);
  if (!artifacts) {
    return { process: processResult, machine: null, detail: 'xcresult artifact scan was incomplete or exceeded bounds' };
  }
  return {
    process: processResult,
    machine: { parser: 'xcode-xcresult-summary-v1', summary, artifacts },
    detail: '',
  };
}

async function runAndroidNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<{ process: BoundedProcessResult; machine: NativeMachineResult | null; detail: string }> {
  const beforeRoots = androidResultRoots(cwd);
  const beforeFiles = beforeRoots ? androidResultFiles(beforeRoots) : null;
  if (!beforeRoots || !beforeFiles) {
    return {
      process: { kind: 'completed', exitCode: null, stdout: '', stderr: '' },
      machine: null,
      detail: 'Android result pre-scan was incomplete',
    };
  }
  const before = fileSnapshot(beforeFiles);
  const processResult = await runBoundedProcess(command, cwd, args.timeoutMs);
  const roots = androidResultRoots(cwd);
  const files = roots ? androidResultFiles(roots) : null;
  if (!roots || !files) {
    return { process: processResult, machine: null, detail: 'Android result scan was incomplete' };
  }
  const fresh = files.filter((file) => {
    try {
      const real = fs.realpathSync(file);
      const stat = fs.lstatSync(real);
      return !stat.isSymbolicLink()
        && stat.isFile()
        && stat.mtimeMs + 1_000 >= startedAtMs
        && before.get(real) !== contentHash(real);
    } catch {
      return false;
    }
  });
  const summaries: QaNativeTestSummaryV1[] = [];
  const copied: string[] = [];
  for (const [index, source] of fresh.entries()) {
    let text = '';
    try { text = fs.readFileSync(source, 'utf8'); } catch { continue; }
    const summary = parseAndroidJUnitXml(text);
    if (!summary) continue;
    const target = path.join(captureRoot, `android-result-${String(index + 1).padStart(4, '0')}.xml`);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    summaries.push(summary);
    copied.push(target);
  }
  const summary = combineNativeSummaries(summaries);
  const artifacts = copied.map((file) => nativeArtifact(qaRoot, file, startedAtMs));
  if (!summary || artifacts.some((artifact) => !artifact)) {
    return {
      process: processResult,
      machine: null,
      detail: 'No fresh supported Android connected-test JUnit XML was produced',
    };
  }
  return {
    process: processResult,
    machine: {
      parser: 'android-junit-xml-v1',
      summary,
      artifacts: artifacts as QaNativeArtifactV1[],
    },
    detail: '',
  };
}

function nativeEnvironmentMissing(adapter: string, result: BoundedProcessResult, detail: string): boolean {
  if (result.kind === 'unavailable' || result.kind === 'timeout') return true;
  const output = `${result.stdout}\n${result.stderr}\n${detail}`;
  return adapter === 'xcode-simulator'
    ? /unable to find a destination|no devices are booted|simulator.{0,40}(?:unavailable|not available)|requires Xcode|xcrun.{0,40}(?:not found|unable)|SDK.{0,40}(?:cannot be located|not found)/i.test(output)
    : /no connected devices|no devices found|device.{0,40}offline|SDK location not found|adb.{0,40}not found|ANDROID_HOME|emulator.{0,40}(?:not found|unavailable)/i.test(output);
}

function boundedNativeSummary(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Native adapter failed without a machine-readable diagnostic.').slice(0, 500);
}

function publishNativeResult(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadNativeRun>>,
  out: { absolute: string; relative: string },
  startedAt: string,
  status: 'passed' | 'failed' | 'blocked-environment',
  blockerSummary: string | undefined,
  commandHash: string | undefined,
  machine: NativeMachineResult | null,
): number {
  const evidence = createQaNativeEvidence({
    runnerVersion: pluginVersion(),
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    adapter: loaded.contract.nativeAdapter!,
    startedAt,
    generatedAt: new Date().toISOString(),
    status,
    ...(commandHash ? { commandHash } : {}),
    ...(machine ? {
      parser: machine.parser,
      summary: machine.summary,
      artifacts: machine.artifacts,
    } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  });
  writeJson(out.absolute, evidence);
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks: loaded.contract.requiredChecks.map((id) => ({
      id,
      status: status === 'passed' ? 'passed' : 'failed',
      ...(blockerSummary ? { summary: blockerSummary } : {}),
    })),
    routes: [],
    native: { evidencePath: out.relative },
    ...(blockerSummary ? { blockerSummary } : {}),
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), report);
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    status,
    nativeEvidencePath: out.relative,
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true }
      : { ok: false, code: validation.code, message: validation.message },
    ...(blockerSummary ? { blockerSummary } : {}),
  })}\n`);
  if (status === 'blocked-environment') return 2;
  return validation.ok ? 0 : 1;
}

async function nativeCommand(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadNativeRun>>,
): Promise<number> {
  const out = outputPath(args, 'native-evidence-v1.json');
  if (!out) {
    process.stderr.write('qa-evidence: native evidence output path is unsafe.\n');
    return 2;
  }
  const startedAt = new Date().toISOString();
  const configured = configuredNativeCommand(args, loaded.contract.nativeAdapter!);
  if (!configured) {
    const blockerSummary =
      `Native adapter ${loaded.contract.nativeAdapter} requires a supported shell-free `
      + '--native-command-json configuration; arbitrary commands and tester-authored artifacts are rejected.';
    return publishNativeResult(
      args,
      loaded,
      out,
      startedAt,
      'blocked-environment',
      blockerSummary,
      undefined,
      null,
    );
  }
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const captureRelative = `native/capture-${Date.now()}-${process.pid}`;
  const captureRoot = ensureProjectDirectory(
    args.projectRoot,
    path.relative(args.projectRoot, path.join(qaRoot, captureRelative)).replace(/\\/g, '/'),
  );
  if (!captureRoot) {
    process.stderr.write('qa-evidence: native capture directory is unsafe.\n');
    return 2;
  }
  const commandHash = sha256(stableContractJson({
    adapter: loaded.contract.nativeAdapter,
    cwd: path.relative(args.projectRoot, configured.cwd).replace(/\\/g, '/') || '.',
    argv: configured.command,
  }));
  const result = loaded.contract.nativeAdapter === 'xcode-simulator'
    ? await runXcodeNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      )
    : await runAndroidNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      );
  const environmentBlocked = nativeEnvironmentMissing(
    loaded.contract.nativeAdapter!,
    result.process,
    result.detail,
  );
  const passed = result.process.kind === 'completed'
    && result.process.exitCode === 0
    && result.machine
    && result.machine.summary.failed === 0
    && result.machine.summary.passed > 0;
  const status = passed ? 'passed' : environmentBlocked ? 'blocked-environment' : 'failed';
  const summary = passed
    ? undefined
    : environmentBlocked
      ? `Native environment unavailable for ${loaded.contract.nativeAdapter}: ${result.detail || result.process.stderr || result.process.kind}`
      : `Native adapter ${loaded.contract.nativeAdapter} failed or produced no valid machine result: ${result.detail || result.process.stderr || `exit ${String(result.process.exitCode)}`}`;
  return publishNativeResult(
    args,
    loaded,
    out,
    startedAt,
    status,
    summary ? boundedNativeSummary(summary) : undefined,
    commandHash,
    result.machine,
  );
}

function lighthouseCommand(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): number {
  if (!args.artifact) {
    process.stderr.write('qa-evidence: --artifact is required for Lighthouse conversion.\n');
    return 2;
  }
  const rel = safeProjectRelative(args.projectRoot, args.artifact);
  const out = outputPath(args, 'lighthouse-evidence-v1.json');
  if (!rel || !out) {
    process.stderr.write('qa-evidence: Lighthouse artifact/output path is unsafe.\n');
    return 2;
  }
  const artifactAbsolute = path.join(args.projectRoot, rel);
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const artifactRel = path.relative(qaRoot, artifactAbsolute).replace(/\\/g, '/');
  const safeArtifactRel = strictRelative(artifactRel);
  let realArtifact = '';
  try {
    const realQa = fs.realpathSync(qaRoot);
    realArtifact = fs.realpathSync(artifactAbsolute);
    const boundary = path.relative(realQa, realArtifact);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('outside QA root');
  } catch {
    // handled by the common unsafe-artifact response below
  }
  if (!safeArtifactRel || !realArtifact) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON must be inside this run QA directory.\n');
    return 2;
  }
  const summary = readLighthouseArtifact(realArtifact);
  if (!summary) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON is incomplete or lacks the four standard categories.\n');
    return 1;
  }
  if (Date.parse(summary.generatedAt) > Date.now() + 1_000) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON has a future fetchTime.\n');
    return 1;
  }
  const evidence = createQaLighthouseEvidence({
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    buildHash: loaded.manifest.manifestHash,
    buildFingerprint: loaded.fingerprint,
    generatedAt: summary.generatedAt,
    artifactPath: safeArtifactRel,
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
  writeJson(out.absolute, evidence);
  const existing = readQaReportV2(args.projectRoot, args.runId);
  const report = existing.report;
  if (!report
    || report.producer !== 'parent-runner'
    || report.runId !== args.runId
    || report.verificationContractHash !== loaded.contract.contractHash
    || report.sourceHash !== loaded.sourceHash
    || report.build?.outputRoot !== loaded.manifest.outputRoot
    || report.build.buildHash !== loaded.manifest.manifestHash
    || report.build.fingerprint !== loaded.fingerprint
    || (loaded.contract.browserRequired && !report.machineEvidencePath)) {
    process.stderr.write(
      'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
    );
    return 1;
  }
  const updated: QaReportV2 = {
    ...report,
    generatedAt: new Date(Math.max(Date.now(), Date.parse(summary.generatedAt))).toISOString(),
    lighthouse: { evidencePath: out.relative },
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), updated);
  const validation = validateQaReportV2(
    updated,
    args.projectRoot,
    args.runId,
    loaded.contract,
  );
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    lighthouse: { evidencePath: out.relative },
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true, advisories: validation.advisories }
      : { ok: false, code: validation.code, message: validation.message },
  })}\n`);
  return validation.ok ? 0 : 1;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  const args = parseArgs(argv, cwd);
  if (!args || args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return args ? 0 : 2;
  }
  if (args.command === 'native') {
    const native = loadNativeRun(args);
    if (!native) {
      process.stderr.write('qa-evidence: native run, VerificationContractV2, or source scan is invalid.\n');
      return 2;
    }
    return nativeCommand(args, native);
  }
  const loaded = loadRun(args);
  if (!loaded) {
    process.stderr.write('qa-evidence: run, VerificationContractV2, source scan, or build output manifest is invalid.\n');
    return 2;
  }
  if (args.command === 'manifest') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      runId: args.runId,
      verificationContractHash: loaded.contract.contractHash,
      sourceHash: loaded.sourceHash,
      outputRoot: loaded.manifest.outputRoot,
      buildHash: loaded.manifest.manifestHash,
      fingerprint: loaded.fingerprint,
      fileCount: loaded.manifest.fileCount,
      totalBytes: loaded.manifest.totalBytes,
    })}\n`);
    return 0;
  }
  if (args.command === 'lighthouse') return lighthouseCommand(args, loaded);
  return browserCommand(args, loaded);
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`qa-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
