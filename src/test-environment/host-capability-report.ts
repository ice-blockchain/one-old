import * as fs from 'fs';
import * as path from 'path';

import {
  HOST_CAPABILITIES,
  readRunHostCapability,
  runHostCapabilityPath,
  type TrafficOneHost,
} from '../shared/host/capabilities';
import { readJson } from '../shared/fsjson';
import type {
  HostCapabilityEvidenceStatus,
  HostCapabilityReport,
  HostId,
} from './core/types';

// What `observedBlockingPoint: null` reads as. Lives here, beside the field it
// describes, because two renderers spell it — the markdown report and the
// console summary — and they had drifted: one said "no primary blocking point"
// and the other "no observed primary blocking point", which also repeated the
// word its own label already supplied ("observed unknown (no observed primary
// blocking point)"). One fact, one spelling.
export const NO_OBSERVED_BLOCKING_POINT = 'no primary blocking point';

function runIdFromState(projectRoot: string): string {
  const state = readJson<Record<string, unknown> | null>(
    path.join(projectRoot, '.traffic-one', '.one.json'),
    null,
  );
  const value = state?.currentRunId;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return '';
}

export function unobservedHostCapabilityReport(
  host: HostId,
  evidenceStatus: Exclude<HostCapabilityEvidenceStatus, 'OBSERVED'>,
  detail: string,
  runId: string | null = null,
): HostCapabilityReport {
  const contract = HOST_CAPABILITIES[host as TrafficOneHost];
  return {
    evidenceStatus,
    runId,
    contractExpectedPrevention: contract.prevention,
    contractPrimaryBlockingPoint: contract.primaryBlockingPoint,
    contractRequiredBlockingPoints: [...contract.requiredBlockingPoints],
    modelObservation: contract.modelObservation,
    authoritativeModelObserved: false,
    observedPrevention: 'unknown',
    observedBlockingPoint: null,
    observedEnforcementPoints: [],
    observedDeniedEnforcementPoints: [],
    primaryBlockingPointObserved: false,
    primaryBlockingPointDenied: false,
    requiredBlockingPointsObserved: false,
    capabilityHash: null,
    evidenceHash: null,
    hostVersion: null,
    preventionCertified: false,
    detail,
  };
}

export function hostCapabilityReportForRun(
  projectRoot: string,
  runId: string,
  host: HostId,
): HostCapabilityReport {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return unobservedHostCapabilityReport(host, 'NO_RUN', 'project has no current run id');
  }
  const capability = readRunHostCapability(projectRoot, normalizedRunId, host);
  if (!capability) {
    const sidecar = runHostCapabilityPath(projectRoot, normalizedRunId);
    return unobservedHostCapabilityReport(
      host,
      fs.existsSync(sidecar) ? 'INVALID' : 'MISSING',
      fs.existsSync(sidecar)
        ? 'per-run HostCapabilityV1 sidecar is invalid or does not match this host'
        : 'per-run HostCapabilityV1 sidecar is missing',
      normalizedRunId,
    );
  }
  const preventive = capability.prevention === 'pre-tool'
    && capability.requiredBlockingPointsObserved
    && capability.primaryBlockingPointDenied;
  const authoritativeModelObserved = capability.modelObservation === 'first-tool-authoritative'
    && capability.observedEnforcementPoints.includes('first-tool-model-check');
  return {
    evidenceStatus: 'OBSERVED',
    runId: normalizedRunId,
    contractExpectedPrevention: HOST_CAPABILITIES[host].prevention,
    contractPrimaryBlockingPoint: capability.primaryBlockingPoint,
    contractRequiredBlockingPoints: [...capability.requiredBlockingPoints],
    modelObservation: capability.modelObservation,
    authoritativeModelObserved,
    observedPrevention: capability.prevention,
    observedBlockingPoint: capability.primaryBlockingPointObserved
      ? capability.primaryBlockingPoint
      : null,
    observedEnforcementPoints: [...capability.observedEnforcementPoints],
    observedDeniedEnforcementPoints: [...capability.observedDeniedEnforcementPoints],
    primaryBlockingPointObserved: capability.primaryBlockingPointObserved,
    primaryBlockingPointDenied: capability.primaryBlockingPointDenied,
    requiredBlockingPointsObserved: capability.requiredBlockingPointsObserved,
    capabilityHash: capability.capabilityHash,
    evidenceHash: capability.evidenceHash,
    hostVersion: capability.hostVersion,
    preventionCertified: preventive,
    detail: preventive
      ? 'every required blocking point was observed and the primary point produced a deny outcome'
      : capability.requiredBlockingPointsObserved
        ? 'hook coverage is complete, but no deny outcome was observed at the primary blocking point'
        : 'sidecar is valid, but one or more required blocking points were not observed',
  };
}

export function currentHostCapabilityReport(
  projectRoot: string,
  host: HostId,
): HostCapabilityReport {
  const runId = runIdFromState(projectRoot);
  return runId
    ? hostCapabilityReportForRun(projectRoot, runId, host)
    : unobservedHostCapabilityReport(host, 'NO_RUN', 'project has no current run id');
}
