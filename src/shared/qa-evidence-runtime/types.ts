// src/shared/qa-evidence-runtime-types.ts
// Schema versions, bounds, and every QA evidence interface. Declarations only —
// runtime logic lives in the sibling -core/-images/-evidence modules; the
// public surface is re-exported by qa-evidence-runtime.ts.

export const QA_MACHINE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_NATIVE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const QA_BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const QA_BUILD_MANIFEST_MAX_FILES = 25_000;
export const QA_BUILD_MANIFEST_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type Rec = Record<string, unknown>;

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
  // Playwright step/navigation failures (timeouts, unreachable locators);
  // absent means []. Mirrors QaViewportV2.actionErrors.
  actionErrors?: string[];
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
  fcpMs?: number;
  tbtMs?: number;
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
  // Optional because a partial audit may omit them, and because pre-1.0.39
  // evidence predates the fields. Recorded so a DECLARED `fcpMaxMs`/`tbtMaxMs`
  // budget is judgeable on the canonical path instead of only inside the
  // standalone runner — the split that let 10co pass QA and then fail the gate.
  fcpMs?: number;
  tbtMs?: number;
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
