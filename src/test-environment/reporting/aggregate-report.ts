// src/test-environment/reporting/aggregate-report.ts
// Renders results.md + results.json from all case runs.

import * as fs from 'fs';
import * as path from 'path';

import type {
  AssertionStatus,
  CaseRunResult,
  HostCapabilityReport,
  HostId,
  RootTestConfig,
} from '../core/types';
import type { ManualHostCertificationOutcome } from '../manual-host-certification';
import { NO_OBSERVED_BLOCKING_POINT } from '../host-capability-report';
import {
  HOST_CAPABILITIES,
  type HostModelObservation,
  type TrafficOneHost,
} from '../../shared/host/capabilities';

const STATUS_ICON: Record<AssertionStatus, string> = {
  PASS: '✅', FAIL: '❌', SKIP: '⏭️', INCONCLUSIVE: '❓', UNSUPPORTED: '🚫',
};

export interface ReportSummary {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  inconclusive: number;
  unsupported: number;
  hostTotal: number;
  hostPreventionCertified: number;
  hostUncertified: number;
  automaticHostCertifications: AutomaticHostCertification[];
  manualTotal: number;
  manualCertified: number;
  manualUncertified: number;
  reportPath: string;
}

export interface AutomaticHostCertification {
  host: HostId;
  caseIds: string[];
  resultCount: number;
  contractPrimaryBlockingPoint: string;
  contractRequiredBlockingPoints: string[];
  modelObservation: HostModelObservation;
  authoritativeModelObserved: boolean;
  observedEnforcementPoints: string[];
  observedDeniedEnforcementPoints: string[];
  requiredBlockingPointsObserved: boolean;
  primaryBlockingPointDenied: boolean;
  preventionCertified: boolean;
}

export function aggregateAutomaticHostCertifications(
  results: readonly CaseRunResult[],
): AutomaticHostCertification[] {
  const grouped = new Map<HostId, CaseRunResult[]>();
  for (const result of results) {
    if (result.host === 'pure-node') continue;
    const group = grouped.get(result.host) || [];
    group.push(result);
    grouped.set(result.host, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, hostResults]) => {
      const contract = HOST_CAPABILITIES[host as TrafficOneHost];
      const observedEnforcementPoints = [...new Set(hostResults.flatMap((result) => (
        result.hostResult.hostCapability?.evidenceStatus === 'OBSERVED'
          ? result.hostResult.hostCapability.observedEnforcementPoints
          : []
      )))].sort();
      const observedDeniedEnforcementPoints = [...new Set(hostResults.flatMap((result) => (
        result.hostResult.hostCapability?.evidenceStatus === 'OBSERVED'
          ? result.hostResult.hostCapability.observedDeniedEnforcementPoints
          : []
      )))].sort();
      const requiredBlockingPointsObserved = contract.requiredBlockingPoints.every((point) => (
        observedEnforcementPoints.includes(point)
      ));
      const primaryBlockingPointDenied = observedDeniedEnforcementPoints.includes(
        contract.primaryBlockingPoint,
      );
      const authoritativeModelObserved = contract.modelObservation === 'first-tool-authoritative'
        && observedEnforcementPoints.includes('first-tool-model-check');
      return {
        host,
        caseIds: [...new Set(hostResults.map((result) => result.caseId))].sort(),
        resultCount: hostResults.length,
        contractPrimaryBlockingPoint: contract.primaryBlockingPoint,
        contractRequiredBlockingPoints: [...contract.requiredBlockingPoints],
        modelObservation: contract.modelObservation,
        authoritativeModelObserved,
        observedEnforcementPoints,
        observedDeniedEnforcementPoints,
        requiredBlockingPointsObserved,
        primaryBlockingPointDenied,
        preventionCertified: contract.prevention === 'pre-tool'
          && requiredBlockingPointsObserved
          && primaryBlockingPointDenied,
      };
    });
}

function tableText(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function manualWaiverLabel(outcome: ManualHostCertificationOutcome): string {
  const waiver = outcome.record?.waiver;
  if (!waiver) return outcome.waiverStatus;
  return tableText(`COMPLETE — ${waiver.approvedBy}; ${waiver.reason}; ${waiver.approvedAt}`);
}

function observedCapabilityLabel(capability: HostCapabilityReport | undefined): string {
  if (!capability) return '—';
  if (capability.observedPrevention === 'unknown') {
    return `${capability.evidenceStatus}: unknown`;
  }
  const point = capability.observedBlockingPoint ?? NO_OBSERVED_BLOCKING_POINT;
  const deny = capability.primaryBlockingPointDenied ? 'primary deny observed' : 'no primary deny';
  return `${capability.observedPrevention} — ${point}; ${deny}`;
}

function contractCapabilityLabel(capability: HostCapabilityReport | undefined): string {
  return capability
    ? `${capability.contractExpectedPrevention} — ${capability.contractPrimaryBlockingPoint}`
    : '—';
}

function preventionCertificationLabel(capability: HostCapabilityReport | undefined): string {
  return capability ? (capability.preventionCertified ? 'YES' : 'NO') : '—';
}

function modelObservationLabel(capability: HostCapabilityReport | undefined): string {
  if (!capability) return '—';
  if (capability.modelObservation === 'first-tool-authoritative') {
    return capability.authoritativeModelObserved
      ? 'first-tool-authoritative — observed'
      : 'first-tool-authoritative — not observed';
  }
  return capability.modelObservation;
}

function capabilityHashes(capability: HostCapabilityReport | undefined): string {
  if (!capability?.capabilityHash) return '—';
  return `contract=${capability.capabilityHash}; evidence=${capability.evidenceHash ?? '—'}`;
}

export function writeReport(
  results: CaseRunResult[],
  config: RootTestConfig,
  startedAt: string,
  runDir: string,
  manualCertifications: readonly ManualHostCertificationOutcome[] = [],
  releaseFingerprint = '',
): ReportSummary {
  let pass = 0; let fail = 0; let skip = 0; let inconclusive = 0; let unsupported = 0; let total = 0;
  for (const r of results) {
    for (const a of r.assertions) {
      total++;
      if (a.status === 'PASS') pass++;
      else if (a.status === 'FAIL') fail++;
      else if (a.status === 'SKIP') skip++;
      else if (a.status === 'INCONCLUSIVE') inconclusive++;
      else unsupported++;
    }
  }
  const manualTotal = manualCertifications.length;
  const manualCertified = manualCertifications.filter((outcome) => outcome.certified).length;
  const manualUncertified = manualTotal - manualCertified;
  const automaticHostCertifications = aggregateAutomaticHostCertifications(results);
  const hostTotal = automaticHostCertifications.length;
  const hostPreventionCertified = automaticHostCertifications.filter((result) => (
    result.preventionCertified
  )).length;
  const hostUncertified = hostTotal - hostPreventionCertified;

  const lines: string[] = [];
  lines.push('# Traffic One — Test Environment Report');
  lines.push('');
  lines.push(`- Started: ${startedAt}`);
  lines.push(`- Finished: ${new Date().toISOString()}`);
  lines.push(`- Hosts: ${config.enabledHosts.join(', ')} · Host-E2E: ${config.includeHostE2E ? 'on' : 'off (pure-node only)'}`);
  lines.push(`- Cases run: ${results.length}`);
  lines.push(`- Assertions: ${total} — ${STATUS_ICON.PASS} ${pass} · ${STATUS_ICON.FAIL} ${fail} · ${STATUS_ICON.SKIP} ${skip} · ${STATUS_ICON.INCONCLUSIVE} ${inconclusive} · ${STATUS_ICON.UNSUPPORTED} ${unsupported}`);
  if (hostTotal > 0) {
    lines.push(`- Automatic host prevention certifications: ${hostPreventionCertified}/${hostTotal}`);
  }
  if (releaseFingerprint) lines.push(`- Stable release fingerprint: \`${releaseFingerprint}\``);
  if (manualTotal > 0) {
    lines.push(`- Manual host certifications: ${manualCertified}/${manualTotal} certified`);
  }
  lines.push('- Preventive-enforcement evidence is reported separately and never overrides final assertion/verification failures.');
  lines.push('');

  if (manualTotal > 0) {
    lines.push('## Manual host certification');
    lines.push('');
    lines.push('| Host | Record | Declared result | Waiver | E2E/waiver certified | Contract expectation | Observed enforcement | Model observation | Prevention certified | Capability hashes | Detail |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const outcome of manualCertifications) {
      const detail = [
        outcome.filePath ?? 'no directory supplied',
        outcome.hostCapability.detail,
        ...outcome.errors,
      ].map(tableText).join('; ');
      lines.push(`| ${outcome.host} | ${outcome.loadStatus} | ${outcome.result ?? '—'} | ${manualWaiverLabel(outcome)} | ${outcome.certified ? 'YES' : 'NO'} | ${contractCapabilityLabel(outcome.hostCapability)} | ${observedCapabilityLabel(outcome.hostCapability)} | ${modelObservationLabel(outcome.hostCapability)} | ${preventionCertificationLabel(outcome.hostCapability)} | ${capabilityHashes(outcome.hostCapability)} | ${detail} |`);
    }
    lines.push('');
  }

  if (automaticHostCertifications.length > 0) {
    lines.push('## Automatic host prevention certification');
    lines.push('');
    lines.push('Certification is aggregated once per host across the selected live cases. A business case with no enforcement scenario does not erase valid evidence from a dedicated case.');
    lines.push('');
    lines.push('| Host | Cases | Required points covered | Primary deny observed | Model observation | Observed points | Denied points | Prevention certified |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const certification of automaticHostCertifications) {
      const modelObservation = certification.modelObservation === 'first-tool-authoritative'
        ? `${certification.modelObservation} — ${certification.authoritativeModelObserved ? 'observed' : 'not observed'}`
        : certification.modelObservation;
      lines.push(`| ${certification.host} | ${certification.resultCount} (${certification.caseIds.join(', ')}) | ${certification.requiredBlockingPointsObserved ? 'YES' : 'NO'} | ${certification.primaryBlockingPointDenied ? 'YES' : 'NO'} | ${modelObservation} | ${certification.observedEnforcementPoints.join(', ') || '—'} | ${certification.observedDeniedEnforcementPoints.join(', ') || '—'} | ${certification.preventionCertified ? 'YES' : 'NO'} |`);
    }
    lines.push('');
  }

  lines.push('## Matrix');
  lines.push('');
  lines.push('| Case | Category | Target | Host run | Contract expectation | Observed enforcement | Model observation | Prevention certified | Assertions (P/F/S/I/U) |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const p = r.assertions.filter((a) => a.status === 'PASS').length;
    const f = r.assertions.filter((a) => a.status === 'FAIL').length;
    const s = r.assertions.filter((a) => a.status === 'SKIP').length;
    const i = r.assertions.filter((a) => a.status === 'INCONCLUSIVE').length;
    const u = r.assertions.filter((a) => a.status === 'UNSUPPORTED').length;
    const host = r.host === 'pure-node' ? '—' : `${r.hostResult.status}`;
    lines.push(`| ${r.caseId} | ${r.category} | ${r.host} | ${host} | ${contractCapabilityLabel(r.hostResult.hostCapability)} | ${observedCapabilityLabel(r.hostResult.hostCapability)} | ${modelObservationLabel(r.hostResult.hostCapability)} | ${preventionCertificationLabel(r.hostResult.hostCapability)} | ${p}/${f}/${s}/${i}/${u} |`);
  }
  lines.push('');

  lines.push('## Details');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.caseId} — ${r.host}`);
    if (r.host !== 'pure-node') {
      lines.push(`Host run: **${r.hostResult.status}** (exit ${r.hostResult.exitCode}, ${r.hostResult.durationMs}ms)${r.hostResult.skippedReason ? ` — ${r.hostResult.skippedReason}` : ''}`);
      if (r.hostResult.command) lines.push('`' + r.hostResult.command + '`');
      if (r.hostResult.hostCapability) {
        const capability = r.hostResult.hostCapability;
        lines.push(`Host capability: contract expects **${capability.contractExpectedPrevention}** across ${capability.contractRequiredBlockingPoints.map((point) => `\`${point}\``).join(', ')}; observed **${capability.observedPrevention}** (${capability.observedEnforcementPoints.map((point) => `\`${point}\``).join(', ') || 'no blocking points'}); denied at ${capability.observedDeniedEnforcementPoints.map((point) => `\`${point}\``).join(', ') || 'no blocking point'}; complete required coverage: **${capability.requiredBlockingPointsObserved ? 'YES' : 'NO'}**; primary deny observed: **${capability.primaryBlockingPointDenied ? 'YES' : 'NO'}**; run-local prevention evidence complete: **${capability.preventionCertified ? 'YES' : 'NO'}**.`);
        lines.push(`Child-model observation: **${modelObservationLabel(capability)}**. This is reported separately from structural pre-tool prevention.`);
        lines.push(`Capability hashes: ${capabilityHashes(capability)}. ${capability.detail}`);
      }
    }
    for (const a of r.assertions) {
      lines.push(`- ${STATUS_ICON[a.status]} **${a.id}** — ${a.title}`);
      const detail = a.detail.split('\n').map((d) => `  > ${d}`).join('\n');
      if (detail.trim()) lines.push(detail);
    }
    lines.push('');
  }

  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, 'results.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({
    startedAt,
    releaseFingerprint: releaseFingerprint || null,
    summary: {
      total,
      pass,
      fail,
      skip,
      inconclusive,
      unsupported,
      hostTotal,
      hostPreventionCertified,
      hostUncertified,
      automaticHostCertifications,
      manualTotal,
      manualCertified,
      manualUncertified,
    },
    manualCertifications,
    results,
  }, null, 2), 'utf8');

  return {
    total,
    pass,
    fail,
    skip,
    inconclusive,
    unsupported,
    hostTotal,
    hostPreventionCertified,
    hostUncertified,
    automaticHostCertifications,
    manualTotal,
    manualCertified,
    manualUncertified,
    reportPath,
  };
}
