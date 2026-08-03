// Validates runtime-owned HostCapabilityV1 evidence emitted by a dedicated live
// probe. It never promotes the static host registry or an agent transcript into
// preventive proof: the sidecar must be hash-valid, contain the requested
// concrete hook points, and record a real deny outcome where requested.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import {
  HOST_CAPABILITIES,
  readRunHostCapability,
  type TrafficOneHost,
} from '../../shared/host/capabilities';
import { currentHostCapabilityReport } from '../host-capability-report';
import { effState, hostProducedWork, result, str } from './util';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function safeRelativePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized
    || normalized.startsWith('/')
    || normalized.split('/').includes('..')
    || normalized.includes('\0')) return null;
  return normalized;
}

export const assertion: Assertion = {
  id: 'host-enforcement-evidence',
  title: 'Live host enforcement evidence matches the dedicated probe',
  appliesTo: (testCase) => testCase.layer === 'host-e2e',
  run: (ctx) => {
    if (ctx.host === 'pure-node') {
      return result(ctx, 'SKIP', 'Live host enforcement evidence does not apply to pure-node runs.');
    }
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced no live evidence (${ctx.hostResult.status}).`);
    }

    const params = ctx.spec.params ?? {};
    const contract = HOST_CAPABILITIES[ctx.host as TrafficOneHost];
    const requestedPoints = strings(params.observedPoints);
    const deniedPoints = params.denyPrimary === true
      ? [contract.primaryBlockingPoint]
      : strings(params.deniedPoints);
    const requested = [...new Set([...requestedPoints, ...deniedPoints])];
    const invalidPoints = requested.filter((point) => !contract.enforcementPoints.includes(point));
    if (invalidPoints.length > 0) {
      return result(ctx, 'FAIL', `Assertion declares points outside ${ctx.host}'s HostCapabilityV1 contract: ${invalidPoints.join(', ')}.`);
    }

    const invalidPaths: string[] = [];
    const presentPaths: string[] = [];
    for (const rawPath of strings(params.absentPaths)) {
      const rel = safeRelativePath(rawPath);
      if (!rel) {
        invalidPaths.push(rawPath);
      } else if (fs.existsSync(path.join(ctx.cwd, rel))) {
        presentPaths.push(rel);
      }
    }
    if (invalidPaths.length > 0) {
      return result(ctx, 'FAIL', `Assertion contains unsafe project-relative paths: ${invalidPaths.join(', ')}.`);
    }
    if (presentPaths.length > 0) {
      return result(ctx, 'FAIL', `The operation was not prevented; forbidden path(s) exist: ${presentPaths.join(', ')}.`);
    }

    const stateRunId = str(effState(ctx).currentRunId);
    const report = currentHostCapabilityReport(ctx.cwd, ctx.host);
    const capability = stateRunId
      ? readRunHostCapability(ctx.cwd, stateRunId, ctx.host)
      : null;
    if (!stateRunId || !capability || report.evidenceStatus !== 'OBSERVED') {
      const childProbe = params.childProbe === true;
      if (childProbe && ctx.hostConfig?.headlessSubagents === 'unsupported') {
        return result(
          ctx,
          'UNSUPPORTED',
          `The ${ctx.host} headless entrypoint is declared unable to expose subagents; no valid per-run child enforcement evidence was emitted.`,
        );
      }
      return result(ctx, 'FAIL', `No valid HostCapabilityV1 evidence exists for currentRunId=${stateRunId || '(missing)'} (${report.evidenceStatus}).`);
    }

    const missingObserved = requestedPoints.filter((point) => (
      !capability.observedEnforcementPoints.includes(point)
      || !capability.evidence.some((entry) => entry.point === point)
    ));
    const missingDenied = deniedPoints.filter((point) => (
      !capability.observedDeniedEnforcementPoints.includes(point)
      || !capability.evidence.some((entry) => entry.point === point && entry.outcome === 'denied')
    ));
    const authoritativeMissing = params.authoritativeModel === true
      && (
        capability.modelObservation !== 'first-tool-authoritative'
        || !report.authoritativeModelObserved
        || !capability.evidence.some((entry) => (
          entry.point === 'first-tool-model-check'
          && entry.source === 'verified-child-model-gate'
        ))
      );

    if (missingObserved.length > 0 || authoritativeMissing) {
      if (params.childProbe === true && ctx.hostConfig?.headlessSubagents === 'unsupported') {
        const missing = [
          ...missingObserved,
          ...(authoritativeMissing ? ['authoritative first-tool model'] : []),
        ];
        return result(
          ctx,
          'UNSUPPORTED',
          `The live child probe could not exercise ${missing.join(', ')} because ${ctx.host}'s configured headless entrypoint declares subagents unsupported. This is not certification.`,
          {
            expected: requestedPoints,
            actual: capability.observedEnforcementPoints,
          },
        );
      }
      return result(
        ctx,
        'FAIL',
        `Missing live enforcement evidence: ${[
          ...missingObserved,
          ...(authoritativeMissing ? ['authoritative first-tool model'] : []),
        ].join(', ')}.`,
        {
          expected: requestedPoints,
          actual: capability.observedEnforcementPoints,
        },
      );
    }
    if (missingDenied.length > 0) {
      return result(
        ctx,
        'FAIL',
        `The hook was invoked but did not produce the required deny outcome at: ${missingDenied.join(', ')}.`,
        {
          expected: deniedPoints,
          actual: capability.observedDeniedEnforcementPoints,
        },
      );
    }

    return result(
      ctx,
      'PASS',
      `Observed [${requested.join(', ')}]${deniedPoints.length > 0 ? ` with deny at [${deniedPoints.join(', ')}]` : ''}; capabilityHash=${capability.capabilityHash}; evidenceHash=${capability.evidenceHash}.`,
    );
  },
};
