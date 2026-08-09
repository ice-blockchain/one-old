import * as fs from 'fs';
import * as path from 'path';

import { writeJson } from '../shared/fsjson';
import {
  HOST_CAPABILITIES,
  type TrafficOneHost,
} from '../shared/host/capabilities';
import type { HostCapabilityReport } from './core/types';
import {
  hostCapabilityReportForRun,
  unobservedHostCapabilityReport,
} from './host-capability-report';

export const MANUAL_HOST_CERTIFICATION_SCHEMA_VERSION = 1 as const;
// Every host classified `contract+manual-e2e` in HOST_CAPABILITIES (see
// shared/host/capability-schema.ts): the four uncertified hosts, plus Cursor,
// which is certified but has no scriptable install for release CI to drive
// live — its release evidence is a manual record like the other four's.
export type ManualCertificationHost = 'cursor' | 'opencode' | 'kilo' | 'copilot' | 'windsurf';
export type ManualCertificationResult = 'PASS' | 'FAIL' | 'NOT_RUN';
export type ManualCertificationLoadStatus = 'VALID' | 'MISSING' | 'INVALID';
export type ManualCertificationWaiverStatus = 'NONE' | 'COMPLETE' | 'INVALID';

export const MANUAL_CERTIFICATION_HOSTS: readonly ManualCertificationHost[] = Object.values(
  HOST_CAPABILITIES,
)
  .filter((capability) => capability.certification === 'contract+manual-e2e')
  .map((capability) => capability.host as ManualCertificationHost);

export interface ManualHostCertificationV1 {
  schemaVersion: typeof MANUAL_HOST_CERTIFICATION_SCHEMA_VERSION;
  host: ManualCertificationHost;
  hostVersion: string;
  /**
   * Where the run happened and who drove it. Optional, so a record written
   * before these existed still loads — but absent is NOT the same as covered:
   * a record with no `os` says nothing about which platform was exercised, and
   * PLATFORMS.md's Windows row depends on that distinction being visible
   * rather than assumed. The report prints both, so an omission shows up in
   * the release evidence instead of reading as a claim nobody made.
   */
  os?: string;
  operator?: string;
  installedPluginFingerprint: string;
  installSteps: string[];
  prompt: string;
  artifactPaths: string[];
  result: ManualCertificationResult;
  executedAt: string | null;
  notes: string;
  waiver?: {
    approvedBy: string;
    reason: string;
    approvedAt: string;
  };
}

export interface ManualHostCertificationOutcome {
  host: ManualCertificationHost;
  filePath: string | null;
  expectedPluginFingerprint: string | null;
  loadStatus: ManualCertificationLoadStatus;
  result: ManualCertificationResult | null;
  waiverStatus: ManualCertificationWaiverStatus;
  certified: boolean;
  /**
   * General PASS/waiver certification is distinct from preventive-enforcement
   * proof. This projection is sourced only from a valid per-run sidecar.
   */
  hostCapability: HostCapabilityReport;
  errors: string[];
  record?: ManualHostCertificationV1;
}

const MANUAL_HOSTS = new Set<string>(MANUAL_CERTIFICATION_HOSTS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function declaredResult(value: unknown): ManualCertificationResult | null {
  if (!isObject(value)) return null;
  return value.result === 'PASS' || value.result === 'FAIL' || value.result === 'NOT_RUN'
    ? value.result
    : null;
}

function waiverStatus(value: unknown): ManualCertificationWaiverStatus {
  if (!isObject(value) || value.waiver === undefined) return 'NONE';
  if (
    isObject(value.waiver)
    && isNonEmptyString(value.waiver.approvedBy)
    && isNonEmptyString(value.waiver.reason)
    && isNonEmptyString(value.waiver.approvedAt)
  ) return 'COMPLETE';
  return 'INVALID';
}

function validatePassArtifacts(directory: string, artifactPaths: string[]): string[] {
  const errors: string[] = [];
  let root: string;
  try {
    root = fs.realpathSync(directory);
  } catch (error) {
    return [`certification directory cannot be resolved: ${String(error)}`];
  }

  for (const artifactPath of artifactPaths) {
    if (path.isAbsolute(artifactPath)) {
      errors.push(`PASS artifact must be relative to the certification directory: ${artifactPath}`);
      continue;
    }
    const resolved = path.resolve(root, artifactPath);
    const relative = path.relative(root, resolved);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      errors.push(`PASS artifact escapes the certification directory: ${artifactPath}`);
      continue;
    }

    const segments = relative.split(path.sep).filter(Boolean);
    let current = root;
    let rejected = false;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch {
        errors.push(`PASS artifact is missing: ${artifactPath}`);
        rejected = true;
        break;
      }
      if (stat.isSymbolicLink()) {
        errors.push(`PASS artifact may not use symlinks: ${artifactPath}`);
        rejected = true;
        break;
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        errors.push(`PASS artifact path contains a non-directory: ${artifactPath}`);
        rejected = true;
        break;
      }
      if (index === segments.length - 1 && !stat.isFile()) {
        errors.push(`PASS artifact is not a file: ${artifactPath}`);
        rejected = true;
      }
    }
    if (!rejected && segments.length === 0) {
      errors.push(`PASS artifact is not a file: ${artifactPath}`);
    }
  }
  return errors;
}

export function validateManualHostCertification(
  value: unknown,
): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['record must be a JSON object'];
  const record = value;

  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof record.host !== 'string' || !MANUAL_HOSTS.has(record.host)) {
    errors.push('host is not manual-certification eligible');
  }
  if (!isNonEmptyString(record.hostVersion)) errors.push('hostVersion is required');
  // Optional, but a present key must carry a real value. `os: ""` and
  // `operator: 42` are the shapes that read as filled in and are not, which is
  // worse than omission because the report would render them as an answer.
  for (const field of ['os', 'operator'] as const) {
    if (record[field] !== undefined && !isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string when present`);
    }
  }
  if (!isNonEmptyString(record.installedPluginFingerprint)) errors.push('installedPluginFingerprint is required');
  if (
    !Array.isArray(record.installSteps)
    || record.installSteps.length === 0
    || record.installSteps.some((step) => !isNonEmptyString(step))
  ) errors.push('installSteps are required');
  if (!isNonEmptyString(record.prompt)) errors.push('prompt is required');
  if (
    !Array.isArray(record.artifactPaths)
    || record.artifactPaths.some((artifact) => !isNonEmptyString(artifact))
  ) errors.push('artifactPaths must be an array of non-empty paths');
  if (
    record.result !== 'PASS'
    && record.result !== 'FAIL'
    && record.result !== 'NOT_RUN'
  ) errors.push('result is invalid');
  if (record.result === 'NOT_RUN' && record.executedAt !== null) errors.push('NOT_RUN must have executedAt null');
  if (
    (record.result === 'PASS' || record.result === 'FAIL')
    && !isNonEmptyString(record.executedAt)
  ) errors.push('executedAt is required for PASS/FAIL');
  if (
    record.result === 'PASS'
    && Array.isArray(record.artifactPaths)
    && record.artifactPaths.length === 0
  ) errors.push('PASS requires saved artifacts');
  if (typeof record.notes !== 'string') errors.push('notes must be a string');
  if (waiverStatus(record) === 'INVALID') {
    errors.push('waiver must name maintainer, reason, and approval time');
  }
  return errors;
}

export function manualHostDeclaredCertified(record: unknown): boolean {
  if (validateManualHostCertification(record).length > 0) return false;
  const valid = record as ManualHostCertificationV1;
  return valid.result === 'PASS' || Boolean(valid.waiver);
}

export function selectedManualCertificationHosts(
  selectedHosts: readonly string[],
): ManualCertificationHost[] {
  const selected = new Set(selectedHosts);
  return MANUAL_CERTIFICATION_HOSTS.filter((host) => selected.has(host));
}

export function hostRequiresManualCertification(
  host: string,
): host is ManualCertificationHost {
  const capability = HOST_CAPABILITIES[host as TrafficOneHost];
  return capability?.certification === 'contract+manual-e2e';
}

function unavailableOutcome(
  host: ManualCertificationHost,
  filePath: string | null,
  expectedPluginFingerprint: string | null,
  loadStatus: Exclude<ManualCertificationLoadStatus, 'VALID'>,
  errors: string[],
): ManualHostCertificationOutcome {
  return {
    host,
    filePath,
    expectedPluginFingerprint,
    loadStatus,
    result: null,
    waiverStatus: 'NONE',
    certified: false,
    hostCapability: unobservedHostCapabilityReport(
      host,
      'MISSING',
      errors.join('; '),
    ),
    errors,
  };
}

const CAPABILITY_SIDECAR_RE = /^(.*?)(?:^|\/)\.traffic-one\/runs\/([^/]+)\/host-capability-v1\.json$/;

function capabilityFromManualArtifacts(
  directory: string,
  record: ManualHostCertificationV1,
): HostCapabilityReport {
  if (record.result === 'NOT_RUN') {
    return unobservedHostCapabilityReport(
      record.host,
      'NOT_RUN',
      'manual host execution was not run',
    );
  }
  const match = record.artifactPaths
    .map((artifact) => artifact.replace(/\\/g, '/').match(CAPABILITY_SIDECAR_RE))
    .find((candidate): candidate is RegExpMatchArray => Boolean(candidate));
  if (!match) {
    return unobservedHostCapabilityReport(
      record.host,
      'MISSING',
      'manual record has no per-run HostCapabilityV1 sidecar artifact',
    );
  }
  const relativeRoot = match[1] || '';
  const runId = match[2] || '';
  const projectRoot = path.resolve(directory, relativeRoot || '.');
  const relative = path.relative(path.resolve(directory), projectRoot);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return unobservedHostCapabilityReport(
      record.host,
      'INVALID',
      'manual HostCapabilityV1 project root escapes the certification directory',
      runId,
    );
  }
  return hostCapabilityReportForRun(projectRoot, runId, record.host);
}

export function loadManualHostCertifications(
  directory: string | undefined,
  selectedHosts: readonly string[],
  expectedPluginFingerprint?: string,
  requireExpectedPluginFingerprint = false,
): ManualHostCertificationOutcome[] {
  const hosts = selectedManualCertificationHosts(selectedHosts);
  const expected = expectedPluginFingerprint ?? null;
  if (!directory) {
    return hosts.map((host) => unavailableOutcome(
      host,
      null,
      expected,
      'MISSING',
      ['--manual-cert-dir was not provided'],
    ));
  }

  if (!path.isAbsolute(directory)) {
    return hosts.map((host) => unavailableOutcome(
      host,
      null,
      expected,
      'INVALID',
      ['manual certification directory must be an absolute path'],
    ));
  }

  return hosts.map((host): ManualHostCertificationOutcome => {
    const filePath = path.join(directory, `${host}-manual-e2e.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    } catch (error) {
      const code = isObject(error) && typeof error.code === 'string' ? error.code : '';
      return unavailableOutcome(
        host,
        filePath,
        expected,
        code === 'ENOENT' ? 'MISSING' : 'INVALID',
        [code === 'ENOENT' ? 'record is missing' : `record cannot be read: ${String(error)}`],
      );
    }

    const errors = validateManualHostCertification(raw);
    if (isObject(raw) && raw.host !== host) {
      errors.push(`host must be ${host} for ${path.basename(filePath)}`);
    }
    if (
      expectedPluginFingerprint
      && isObject(raw)
      && raw.installedPluginFingerprint !== expectedPluginFingerprint
    ) {
      errors.push(`installedPluginFingerprint must match current release ${expectedPluginFingerprint}`);
    }
    if (requireExpectedPluginFingerprint && !expectedPluginFingerprint) {
      errors.push('stable release fingerprint is unavailable');
    }
    if (
      isObject(raw)
      && raw.result === 'PASS'
      && Array.isArray(raw.artifactPaths)
      && raw.artifactPaths.every((artifact): artifact is string => typeof artifact === 'string')
    ) {
      errors.push(...validatePassArtifacts(directory, raw.artifactPaths));
    }
    const result = declaredResult(raw);
    const waiver = waiverStatus(raw);
    if (errors.length > 0) {
      return {
        host,
        filePath,
        expectedPluginFingerprint: expected,
        loadStatus: 'INVALID',
        result,
        waiverStatus: waiver,
        certified: false,
        hostCapability: unobservedHostCapabilityReport(
          host,
          'INVALID',
          errors.join('; '),
        ),
        errors,
      };
    }

    const record = raw as ManualHostCertificationV1;
    return {
      host,
      filePath,
      expectedPluginFingerprint: expected,
      loadStatus: 'VALID',
      result: record.result,
      waiverStatus: record.waiver ? 'COMPLETE' : 'NONE',
      certified: manualHostDeclaredCertified(record),
      hostCapability: capabilityFromManualArtifacts(directory, record),
      errors: [],
      record,
    };
  });
}

export function writeManualHostCertification(
  outputDir: string,
  record: ManualHostCertificationV1,
): string {
  const errors = validateManualHostCertification(record);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const file = path.join(outputDir, `${record.host}-manual-e2e.json`);
  writeJson(file, record);
  return file;
}
