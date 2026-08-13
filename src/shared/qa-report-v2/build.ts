// src/shared/qa-report-v2-build.ts
// Served-build identity: the bounded HTTP probe (child process running the
// inline script below) plus build validation against the manifest.

import { spawnSync } from 'child_process';
import {
  computeBuildOutputManifest,
  type QaMachineEvidenceV1,
} from '../qa-evidence-runtime';
import {
  type VerificationContractV2,
} from '../verification-contract';

import {
  BUILD_START_TOLERANCE_MS,
  QA_BUILD_IDENTITY_PROBE_PATH,
  expectedBuildFingerprint,
  isRecord,
  parseServedBuild,
  type QaReportV2,
  type QaServedBuildIdentityV1,
} from './schema';

const HTTP_PROBE_TIMEOUT_MS = 1_000;
/**
 * The whole synchronous stretch this module can produce, named because the QA
 * run lock's staleness window is sized against it.
 *
 * `spawnSync` blocks the caller's event loop outright, and the caller here may
 * be holding the run lock, whose renewal is a timer on that same loop
 * (qa-evidence/lock.ts). The inner probe gives up at `HTTP_PROBE_TIMEOUT_MS`;
 * the extra 500 ms is the grace for a child that has answered but not yet
 * exited, so this — not the inner bound — is what the lock's margin is computed
 * from. `qa-evidence/__tests__/renewal-premise.test.ts` reads it.
 */
export const HTTP_PROBE_SPAWN_TIMEOUT_MS = HTTP_PROBE_TIMEOUT_MS + 500;
const HTTP_PROBE_MAX_BYTES = 16 * 1024;
const HTTP_PROBE_SOURCE = String.raw`
const target = new URL(process.argv[1]);
const client = require(target.protocol === 'https:' ? 'https' : 'http');
let settled = false;
function fail() {
  if (settled) return;
  settled = true;
  process.exitCode = 2;
}
const request = client.get(target, {
  agent: false,
  headers: { accept: 'application/json', connection: 'close' },
  rejectUnauthorized: false,
}, (response) => {
  if (response.statusCode !== 200) {
    response.resume();
    fail();
    return;
  }
  const chunks = [];
  let bytes = 0;
  response.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > ${HTTP_PROBE_MAX_BYTES}) {
      request.destroy();
      fail();
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    if (settled) return;
    settled = true;
    process.stdout.write(Buffer.concat(chunks).toString('utf8'));
  });
  response.on('error', fail);
});
request.setTimeout(${HTTP_PROBE_TIMEOUT_MS}, () => request.destroy());
request.on('error', fail);
`;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

export function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function probeServedBuild(buildUrl: URL): QaServedBuildIdentityV1 | null {
  const probeUrl = new URL(QA_BUILD_IDENTITY_PROBE_PATH, buildUrl);
  const result = spawnSync(process.execPath, ['-e', HTTP_PROBE_SOURCE, probeUrl.href], {
    encoding: 'utf8',
    timeout: HTTP_PROBE_SPAWN_TIMEOUT_MS,
    maxBuffer: HTTP_PROBE_MAX_BYTES + 1_024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || !result.stdout) return null;
  try {
    return parseServedBuild(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

export function validateBuild(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
  machineEvidence?: QaMachineEvidenceV1 | null,
): string | null {
  const build = report.build;
  if (!build) return 'build identity is required';
  if (build.runId !== report.runId || build.sourceHash !== sourceHash) return 'build identity run/source hash mismatch';
  const manifest = computeBuildOutputManifest(projectRoot, build.outputRoot);
  if (!manifest) return 'build output manifest is missing, unsafe, empty, or incomplete';
  if (manifest.manifestHash !== build.buildHash) {
    return 'build hash does not match the runtime-computed output manifest';
  }
  const expected = expectedBuildFingerprint(report.runId, sourceHash, build.buildHash);
  if (build.fingerprint !== expected || build.servedFingerprint !== expected) return 'served build fingerprint mismatch';
  let url: URL;
  try { url = new URL(build.url); } catch { return 'build URL is invalid'; }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    || url.username
    || url.password
    || url.hash
    || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== build.port) {
    return 'build URL is not the recorded local server/port';
  }
  const startedAt = Date.parse(build.startedAt);
  const baselineAt = Math.max(
    Date.parse(contract.baseline.capturedAt),
    Date.parse(contract.generatedAt),
  );
  const reportAt = Date.parse(report.generatedAt);
  if (startedAt < baselineAt || startedAt > reportAt) return 'server start time is stale or after the report';
  // The bundled runner owns the listener, serves/spawns it after computing the
  // build manifest, records Playwright traces, and proves at least one response
  // body belongs to that manifest. It normally tears the listener down before
  // the tester writes report-v2, so its hash-valid evidence is the durable
  // server/port attestation. Non-browser Lighthouse-only flows retain the live
  // probe below.
  if (machineEvidence) return null;
  if (!processExists(build.pid)) return 'recorded build PID does not exist';

  const served = probeServedBuild(url);
  if (!served) return `build URL did not serve ${QA_BUILD_IDENTITY_PROBE_PATH}`;
  if (served.runId !== report.runId
    || served.sourceHash !== sourceHash
    || served.buildHash !== build.buildHash) {
    return 'served build run/source/build hash mismatch';
  }
  if (served.pid !== build.pid) return 'served build PID does not match the recorded process';
  if (served.port !== build.port
    || normalizedUrl(served.url) !== normalizedUrl(build.url)) {
    return 'served build URL/port mismatch';
  }
  if (Math.abs(Date.parse(served.startedAt) - startedAt) > BUILD_START_TOLERANCE_MS) {
    return 'served build start time does not match the recorded process';
  }
  if (served.fingerprint !== expected || build.servedFingerprint !== served.fingerprint) {
    return 'served build fingerprint mismatch';
  }
  return null;
}
