// Dependency-free, runtime-owned QA evidence primitives. The bundled QA runner
// uses these helpers to hash the actual build output, emit Playwright evidence,
// and derive Lighthouse evidence from the raw Lighthouse JSON artifact. The
// verifier recomputes every hash from disk; QaReportV2 booleans are never enough.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { inflateSync } from 'zlib';

export const QA_MACHINE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_NATIVE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const QA_BUILD_MANIFEST_MAX_FILES = 25_000;
export const QA_BUILD_MANIFEST_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

type Rec = Record<string, unknown>;

export interface BuildManifestFileV1 {
  path: string;
  size: number;
  sha256: string;
}

export interface BuildOutputManifestV1 {
  schemaVersion: typeof QA_BUILD_MANIFEST_SCHEMA_VERSION;
  outputRoot: string;
  fileCount: number;
  totalBytes: number;
  files: BuildManifestFileV1[];
  manifestHash: string;
}

export interface QaMachineViewportEvidenceV1 {
  width: number;
  status: 'passed' | 'failed';
  domAssertionsPassed: boolean;
  actionsPassed: boolean;
  routingPassed: boolean;
  hydrationPassed: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  artifactAt: string;
  tracePath: string;
  traceHash: string;
  screenshotPath?: string;
  screenshotHash?: string;
}

export interface QaMachineRouteEvidenceV1 {
  route: string;
  viewports: QaMachineViewportEvidenceV1[];
}

export interface QaMachineEvidenceV1 {
  schemaVersion: typeof QA_MACHINE_EVIDENCE_SCHEMA_VERSION;
  producer: 'traffic-one-qa-runner';
  runnerVersion: string;
  playwrightVersion: string;
  runId: string;
  verificationContractHash: string;
  sourceHash: string;
  buildOutputRoot: string;
  buildHash: string;
  buildFingerprint: string;
  serverMode: 'runtime-static' | 'runtime-command';
  serverPid: number;
  serverPort: number;
  serverStartedAt: string;
  serverUrl: string;
  servedAssetHashes: string[];
  scenarioHash: string;
  startedAt: string;
  generatedAt: string;
  status: 'passed' | 'failed' | 'blocked-environment';
  routes: QaMachineRouteEvidenceV1[];
  blockerSummary?: string;
  evidenceHash: string;
}

export interface LighthouseArtifactSummaryV1 {
  generatedAt: string;
  finalUrl: string;
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  lcpMs: number;
  cls: number;
  inpMs?: number;
  artifactHash: string;
}

export interface QaLighthouseEvidenceV1 {
  schemaVersion: typeof QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION;
  producer: 'traffic-one-qa-runner';
  runId: string;
  verificationContractHash: string;
  sourceHash: string;
  buildHash: string;
  buildFingerprint: string;
  generatedAt: string;
  artifactPath: string;
  artifactHash: string;
  finalUrl: string;
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  lcpMs: number;
  cls: number;
  inpMs?: number;
  evidenceHash: string;
}

export type QaNativeMachineParserV1 =
  | 'xcode-xcresult-summary-v1'
  | 'android-junit-xml-v1';

export interface QaNativeTestSummaryV1 {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface QaNativeArtifactV1 {
  path: string;
  size: number;
  sha256: string;
  artifactAt: string;
}

/**
 * Native PASS evidence is created only by the runtime runner after it launches
 * an allowlisted simulator/emulator command without a shell and parses a
 * supported machine result. The verifier reparses the captured artifacts and
 * recomputes their hashes; arbitrary tester-authored logs are not evidence.
 */
export interface QaNativeEvidenceV1 {
  schemaVersion: typeof QA_NATIVE_EVIDENCE_SCHEMA_VERSION;
  producer: 'traffic-one-qa-runner';
  runnerVersion: string;
  runId: string;
  verificationContractHash: string;
  sourceHash: string;
  adapter: string;
  startedAt: string;
  generatedAt: string;
  status: 'passed' | 'failed' | 'blocked-environment';
  commandHash?: string;
  parser?: QaNativeMachineParserV1;
  summary?: QaNativeTestSummaryV1;
  artifacts?: QaNativeArtifactV1[];
  blockerSummary?: string;
  evidenceHash: string;
}

export interface DecodedImageInfo {
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
  contentHash: string;
}

function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && SAFE_TEXT_RE.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === 'string'
    && ISO_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Rec)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function normalizeRelative(value: string): string | null {
  const normalized = value;
  if (!normalized
    || normalized.includes('\\')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || /[*?[\]{};]/.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function safeRelativePath(value: unknown, max = 4_096): value is string {
  return safeText(value, max)
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && normalizeRelative(value) === value;
}

function inside(candidate: string, boundary: string): boolean {
  const rel = path.relative(boundary, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hashFile(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function computeBuildOutputManifest(
  projectRoot: string,
  outputRoot: string,
): BuildOutputManifestV1 | null {
  const normalizedRoot = normalizeRelative(outputRoot);
  if (!normalizedRoot
    || /(^|\/)(?:\.traffic-one|node_modules)(?:\/|$)/.test(normalizedRoot)) return null;
  let realProject: string;
  let realOutput: string;
  try {
    realProject = fs.realpathSync(projectRoot);
    realOutput = fs.realpathSync(path.resolve(projectRoot, normalizedRoot));
    if (!inside(realOutput, realProject) || !fs.statSync(realOutput).isDirectory()) return null;
  } catch {
    return null;
  }

  const files: BuildManifestFileV1[] = [];
  const stack = [realOutput];
  let totalBytes = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return null;
      if (entry.isDirectory()) {
        if (entry.name === 'cache' && /(^|\/)\.next\/cache$/.test(
          path.relative(realProject, absolute).replace(/\\/g, '/'),
        )) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= QA_BUILD_MANIFEST_MAX_FILES) return null;
      let stat: fs.Stats;
      try {
        const real = fs.realpathSync(absolute);
        if (!inside(real, realOutput)) return null;
        stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
      } catch {
        return null;
      }
      totalBytes += stat.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > QA_BUILD_MANIFEST_MAX_BYTES) return null;
      const rel = path.relative(realOutput, absolute).replace(/\\/g, '/');
      if (!normalizeRelative(rel)) return null;
      files.push({ path: rel, size: stat.size, sha256: hashFile(absolute) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) return null;
  const canonical = {
    schemaVersion: QA_BUILD_MANIFEST_SCHEMA_VERSION,
    outputRoot: normalizedRoot,
    fileCount: files.length,
    totalBytes,
    files,
  };
  return { ...canonical, manifestHash: sha256Bytes(stableJson(canonical)) };
}

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

function decodePng(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let ihdr = false;
  let iend = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) return null;
    const type = buffer.subarray(offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([type, data])) !== expectedCrc) return null;
    const name = type.toString('ascii');
    if (!ihdr && name !== 'IHDR') return null;
    if (name === 'IHDR') {
      if (ihdr || length !== 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
      if (!width || !height || width > 20_000 || height > 100_000) return null;
      ihdr = true;
    } else if (name === 'IDAT') {
      if (!ihdr || iend) return null;
      compressed.push(data);
    } else if (name === 'IEND') {
      if (length !== 0 || !ihdr || compressed.length === 0) return null;
      iend = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
  }
  if (!ihdr || !iend || offset !== buffer.length || interlace !== 0) return null;
  const channels = colorType === 0 ? 1
    : colorType === 2 ? 3
      : colorType === 3 ? 1
        : colorType === 4 ? 2
          : colorType === 6 ? 4
            : 0;
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) return null;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 512 * 1024 * 1024) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes + 1 });
  } catch {
    return null;
  }
  if (raw.length !== expectedBytes) return null;
  for (let row = 0; row < height; row += 1) {
    if (raw[row * (rowBytes + 1)]! > 4) return null;
  }
  return { width, height };
}

function decodeJpeg(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 12
    || buffer[0] !== 0xff
    || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff
    || buffer[buffer.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length - 2) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1]!;
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1]!;
    }
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (length < 8) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function decodeWebp(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
    || buffer.readUInt32LE(4) + 8 > buffer.length) return null;
  const kind = buffer.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

export function decodeImageFile(filePath: string): DecodedImageInfo | null {
  let buffer: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 12 || stat.size > 256 * 1024 * 1024) return null;
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const decoded = decodePng(buffer);
  if (decoded) return { format: 'png', ...decoded, contentHash: sha256Bytes(buffer) };
  const jpeg = decodeJpeg(buffer);
  if (jpeg) return { format: 'jpeg', ...jpeg, contentHash: sha256Bytes(buffer) };
  const webp = decodeWebp(buffer);
  if (webp) return { format: 'webp', ...webp, contentHash: sha256Bytes(buffer) };
  return null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)
    || !value.every((entry) => typeof entry === 'string' && entry.length <= 2_000)) return null;
  return [...value] as string[];
}

function parseMachineViewport(value: unknown): QaMachineViewportEvidenceV1 | null {
  if (!isRecord(value)
    || !Number.isInteger(value.width)
    || Number(value.width) < 240
    || Number(value.width) > 4_000
    || !['passed', 'failed'].includes(String(value.status))
    || typeof value.domAssertionsPassed !== 'boolean'
    || typeof value.actionsPassed !== 'boolean'
    || typeof value.routingPassed !== 'boolean'
    || typeof value.hydrationPassed !== 'boolean'
    || !iso(value.artifactAt)
    || !safeRelativePath(value.tracePath)
    || !SHA256_RE.test(String(value.traceHash))
    || (value.screenshotPath !== undefined && !safeRelativePath(value.screenshotPath))
    || (value.screenshotHash !== undefined && !SHA256_RE.test(String(value.screenshotHash)))
    || ((value.screenshotPath === undefined) !== (value.screenshotHash === undefined))) return null;
  const consoleErrors = stringArray(value.consoleErrors);
  const networkErrors = stringArray(value.networkErrors);
  if (!consoleErrors || !networkErrors) return null;
  return {
    width: Number(value.width),
    status: value.status as QaMachineViewportEvidenceV1['status'],
    domAssertionsPassed: value.domAssertionsPassed,
    actionsPassed: value.actionsPassed,
    routingPassed: value.routingPassed,
    hydrationPassed: value.hydrationPassed,
    consoleErrors,
    networkErrors,
    artifactAt: value.artifactAt,
    tracePath: value.tracePath,
    traceHash: value.traceHash as string,
    ...(typeof value.screenshotPath === 'string'
      ? { screenshotPath: value.screenshotPath, screenshotHash: value.screenshotHash as string }
      : {}),
  };
}

function parseMachineRoute(value: unknown): QaMachineRouteEvidenceV1 | null {
  // `*` is the compiled catch-all identity, not a URL; the runner probes it via
  // a concrete `startPath` and files the evidence under the pattern.
  if (!isRecord(value)
    || !safeText(value.route, 2_048)
    || !(String(value.route) === '*' || String(value.route).startsWith('/'))
    || !Array.isArray(value.viewports)) return null;
  const viewports = value.viewports.map(parseMachineViewport);
  if (viewports.some((viewport) => !viewport)) return null;
  return { route: value.route, viewports: viewports as QaMachineViewportEvidenceV1[] };
}

function machineEvidenceHash(
  value: Omit<QaMachineEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

export function createQaMachineEvidence(
  value: Omit<QaMachineEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaMachineEvidenceV1 {
  const canonical = {
    schemaVersion: QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: machineEvidenceHash(canonical) };
}

export function parseQaMachineEvidence(value: unknown): QaMachineEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_MACHINE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runnerVersion, 128)
    || !safeText(value.playwrightVersion, 128)
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !safeRelativePath(value.buildOutputRoot)
    || !SHA256_RE.test(String(value.buildHash))
    || !SHA256_RE.test(String(value.buildFingerprint))
    || !['runtime-static', 'runtime-command'].includes(String(value.serverMode))
    || !Number.isSafeInteger(value.serverPid)
    || Number(value.serverPid) <= 0
    || !Number.isSafeInteger(value.serverPort)
    || Number(value.serverPort) < 1
    || Number(value.serverPort) > 65_535
    || !iso(value.serverStartedAt)
    || !safeText(value.serverUrl, 2_048)
    || !Array.isArray(value.servedAssetHashes)
    || !value.servedAssetHashes.every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))
    || !SHA256_RE.test(String(value.scenarioHash))
    || !iso(value.startedAt)
    || !iso(value.generatedAt)
    || !['passed', 'failed', 'blocked-environment'].includes(String(value.status))
    || (value.status === 'passed' && value.servedAssetHashes.length === 0)
    || !Array.isArray(value.routes)
    || (value.blockerSummary !== undefined && !safeText(value.blockerSummary, 500))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const routes = value.routes.map(parseMachineRoute);
  if (routes.some((route) => !route)) return null;
  const candidate: QaMachineEvidenceV1 = {
    schemaVersion: QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner',
    runnerVersion: value.runnerVersion,
    playwrightVersion: value.playwrightVersion,
    runId: value.runId,
    verificationContractHash: value.verificationContractHash as string,
    sourceHash: value.sourceHash as string,
    buildOutputRoot: value.buildOutputRoot,
    buildHash: value.buildHash as string,
    buildFingerprint: value.buildFingerprint as string,
    serverMode: value.serverMode as QaMachineEvidenceV1['serverMode'],
    serverPid: Number(value.serverPid),
    serverPort: Number(value.serverPort),
    serverStartedAt: value.serverStartedAt,
    serverUrl: value.serverUrl,
    servedAssetHashes: [...value.servedAssetHashes] as string[],
    scenarioHash: value.scenarioHash as string,
    startedAt: value.startedAt,
    generatedAt: value.generatedAt,
    status: value.status as QaMachineEvidenceV1['status'],
    routes: routes as QaMachineRouteEvidenceV1[],
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
    evidenceHash: value.evidenceHash as string,
  };
  const { evidenceHash, ...withoutHash } = candidate;
  return machineEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}

function nativeEvidenceHash(
  value: Omit<QaNativeEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseNativeSummary(value: unknown): QaNativeTestSummaryV1 | null {
  if (!isRecord(value)
    || !nonNegativeInteger(value.total)
    || !nonNegativeInteger(value.passed)
    || !nonNegativeInteger(value.failed)
    || !nonNegativeInteger(value.skipped)
    || Number(value.total) < 1
    || Number(value.passed) + Number(value.failed) + Number(value.skipped) !== Number(value.total)) {
    return null;
  }
  return {
    total: Number(value.total),
    passed: Number(value.passed),
    failed: Number(value.failed),
    skipped: Number(value.skipped),
  };
}

function parseNativeArtifact(value: unknown): QaNativeArtifactV1 | null {
  if (!isRecord(value)
    || !safeRelativePath(value.path)
    || !nonNegativeInteger(value.size)
    || Number(value.size) < 1
    || !SHA256_RE.test(String(value.sha256))
    || !iso(value.artifactAt)
    || Object.keys(value).some((key) => !['path', 'size', 'sha256', 'artifactAt'].includes(key))) {
    return null;
  }
  return {
    path: value.path,
    size: Number(value.size),
    sha256: value.sha256 as string,
    artifactAt: value.artifactAt,
  };
}

/**
 * Parse the stable JSON shape emitted by:
 *   xcrun xcresulttool get test-results summary --path <bundle> --format json
 */
export function parseXcodeResultSummary(value: unknown): QaNativeTestSummaryV1 | null {
  if (!isRecord(value)
    || !nonNegativeInteger(value.totalTestCount)
    || !nonNegativeInteger(value.passedTests)
    || !nonNegativeInteger(value.failedTests)
    || !nonNegativeInteger(value.skippedTests)
    || (value.expectedFailures !== undefined && !nonNegativeInteger(value.expectedFailures))
    || typeof value.result !== 'string') return null;
  const total = Number(value.totalTestCount);
  const passed = Number(value.passedTests) + Number(value.expectedFailures || 0);
  const failed = Number(value.failedTests);
  const skipped = Number(value.skippedTests);
  if (total < 1
    || passed + failed + skipped !== total
    || !['Passed', 'Failed', 'Skipped', 'Expected Failure'].includes(value.result)
    || (['Passed', 'Expected Failure'].includes(value.result) && failed !== 0)
    || (value.result === 'Failed' && failed === 0)) return null;
  return { total, passed, failed, skipped };
}

function xmlInteger(attributes: string, name: string, fallback?: number): number | null {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([0-9]+)"|'([0-9]+)')`, 'i').exec(attributes);
  if (!match) return fallback === undefined ? null : fallback;
  const value = Number(match[1] || match[2]);
  return nonNegativeInteger(value) ? value : null;
}

/**
 * Parse the bounded JUnit XML files emitted by Android Gradle Plugin connected
 * tests. DTD/entity input and prose-only XML are rejected.
 */
export function parseAndroidJUnitXml(value: string): QaNativeTestSummaryV1 | null {
  if (typeof value !== 'string'
    || value.length < 20
    || value.length > 64 * 1024 * 1024
    || /<!DOCTYPE|<!ENTITY/i.test(value)
    || !/<testcase\b/i.test(value)) return null;
  const suites = [...value.matchAll(/<testsuite\b([^>]*)>/gi)];
  if (suites.length < 1 || suites.length > 100_000) return null;
  let total = 0;
  let failed = 0;
  let skipped = 0;
  for (const suite of suites) {
    const attributes = suite[1] || '';
    const tests = xmlInteger(attributes, 'tests');
    const failures = xmlInteger(attributes, 'failures', 0);
    const errors = xmlInteger(attributes, 'errors', 0);
    const omitted = xmlInteger(attributes, 'skipped', 0);
    const disabled = xmlInteger(attributes, 'disabled', 0);
    if (tests === null
      || failures === null
      || errors === null
      || omitted === null
      || disabled === null
      || failures + errors + omitted + disabled > tests) return null;
    total += tests;
    failed += failures + errors;
    skipped += omitted + disabled;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed) || !Number.isSafeInteger(skipped)) return null;
  }
  if (total < 1) return null;
  return { total, passed: total - failed - skipped, failed, skipped };
}

export function combineNativeSummaries(
  values: readonly QaNativeTestSummaryV1[],
): QaNativeTestSummaryV1 | null {
  if (values.length < 1) return null;
  const summary = values.reduce<QaNativeTestSummaryV1>((out, value) => ({
    total: out.total + value.total,
    passed: out.passed + value.passed,
    failed: out.failed + value.failed,
    skipped: out.skipped + value.skipped,
  }), { total: 0, passed: 0, failed: 0, skipped: 0 });
  return parseNativeSummary(summary);
}

export function createQaNativeEvidence(
  value: Omit<QaNativeEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaNativeEvidenceV1 {
  const canonical = {
    schemaVersion: QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: nativeEvidenceHash(canonical) };
}

export function parseQaNativeEvidence(value: unknown): QaNativeEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_NATIVE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runnerVersion, 128)
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !safeText(value.adapter, 128)
    || !iso(value.startedAt)
    || !iso(value.generatedAt)
    || !['passed', 'failed', 'blocked-environment'].includes(String(value.status))
    || (value.commandHash !== undefined && !SHA256_RE.test(String(value.commandHash)))
    || (value.parser !== undefined && ![
      'xcode-xcresult-summary-v1',
      'android-junit-xml-v1',
    ].includes(String(value.parser)))
    || (value.blockerSummary !== undefined && !safeText(value.blockerSummary, 500))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const summary = value.summary === undefined ? undefined : parseNativeSummary(value.summary);
  const artifacts = value.artifacts === undefined
    ? undefined
    : Array.isArray(value.artifacts) && value.artifacts.length <= 25_000
      ? value.artifacts.map(parseNativeArtifact)
      : null;
  if ((value.summary !== undefined && !summary)
    || (value.artifacts !== undefined && (!artifacts || artifacts.some((artifact) => !artifact)))
    || (value.status === 'passed' && (
      !value.commandHash
      || !value.parser
      || !summary
      || !artifacts
      || artifacts.length < 1
      || summary.failed !== 0
      || summary.passed < 1
      || value.blockerSummary !== undefined
    ))
    || (value.status === 'blocked-environment' && !safeText(value.blockerSummary, 500))
    || (value.parser === 'xcode-xcresult-summary-v1' && value.adapter !== 'xcode-simulator')
    || (value.parser === 'android-junit-xml-v1' && value.adapter !== 'android-emulator')) return null;
  const candidate: QaNativeEvidenceV1 = {
    schemaVersion: QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner',
    runnerVersion: value.runnerVersion,
    runId: value.runId,
    verificationContractHash: value.verificationContractHash as string,
    sourceHash: value.sourceHash as string,
    adapter: value.adapter,
    startedAt: value.startedAt,
    generatedAt: value.generatedAt,
    status: value.status as QaNativeEvidenceV1['status'],
    ...(typeof value.commandHash === 'string' ? { commandHash: value.commandHash } : {}),
    ...(typeof value.parser === 'string'
      ? { parser: value.parser as QaNativeMachineParserV1 }
      : {}),
    ...(summary ? { summary } : {}),
    ...(artifacts ? { artifacts: artifacts as QaNativeArtifactV1[] } : {}),
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
    evidenceHash: value.evidenceHash as string,
  };
  const { evidenceHash, ...withoutHash } = candidate;
  return nativeEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}

function numericScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value * 100
    : null;
}

function auditNumeric(audits: Rec, names: string[]): number | null {
  for (const name of names) {
    const audit = isRecord(audits[name]) ? audits[name] as Rec : null;
    const value = audit?.numericValue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function readLighthouseArtifact(filePath: string): LighthouseArtifactSummaryV1 | null {
  let buffer: Buffer;
  let parsed: unknown;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100 || stat.size > 128 * 1024 * 1024) return null;
    buffer = fs.readFileSync(filePath);
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || !safeText(parsed.lighthouseVersion, 64)
    || !iso(parsed.fetchTime)
    || !safeText(parsed.finalDisplayedUrl || parsed.finalUrl, 2_048)
    || !isRecord(parsed.categories)
    || !isRecord(parsed.audits)) return null;
  const category = (name: string): number | null => {
    const value = isRecord((parsed.categories as Rec)[name])
      ? ((parsed.categories as Rec)[name] as Rec).score
      : null;
    return numericScore(value);
  };
  const performance = category('performance');
  const accessibility = category('accessibility');
  const bestPractices = category('best-practices');
  const seo = category('seo');
  const lcpMs = auditNumeric(parsed.audits, ['largest-contentful-paint']);
  const cls = auditNumeric(parsed.audits, ['cumulative-layout-shift']);
  const inpMs = auditNumeric(parsed.audits, [
    'interaction-to-next-paint',
    'experimental-interaction-to-next-paint',
  ]);
  if (performance === null
    || accessibility === null
    || bestPractices === null
    || seo === null
    || lcpMs === null
    || cls === null) return null;
  return {
    generatedAt: parsed.fetchTime,
    finalUrl: String(parsed.finalDisplayedUrl || parsed.finalUrl),
    performance,
    accessibility,
    bestPractices,
    seo,
    lcpMs,
    cls,
    ...(inpMs === null ? {} : { inpMs }),
    artifactHash: sha256Bytes(buffer),
  };
}

function lighthouseEvidenceHash(
  value: Omit<QaLighthouseEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

export function createQaLighthouseEvidence(
  value: Omit<QaLighthouseEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaLighthouseEvidenceV1 {
  const canonical = {
    schemaVersion: QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: lighthouseEvidenceHash(canonical) };
}

export function parseQaLighthouseEvidence(value: unknown): QaLighthouseEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !SHA256_RE.test(String(value.buildHash))
    || !SHA256_RE.test(String(value.buildFingerprint))
    || !iso(value.generatedAt)
    || !safeRelativePath(value.artifactPath)
    || !SHA256_RE.test(String(value.artifactHash))
    || !safeText(value.finalUrl, 2_048)
    || !['performance', 'accessibility', 'bestPractices', 'seo', 'lcpMs', 'cls']
      .every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0)
    || ['performance', 'accessibility', 'bestPractices', 'seo']
      .some((key) => Number(value[key]) > 100)
    || (value.inpMs !== undefined
      && (typeof value.inpMs !== 'number' || !Number.isFinite(value.inpMs) || value.inpMs < 0))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const candidate = value as unknown as QaLighthouseEvidenceV1;
  const { evidenceHash, ...withoutHash } = candidate;
  return lighthouseEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function contentHash(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return hashFile(filePath);
  } catch {
    return null;
  }
}
