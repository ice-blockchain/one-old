// src/shared/host/capabilities.ts
// Host capability persistence + hook-side observation. Schema/hash live
// in capability-schema.ts and are re-exported.

import * as fs from 'fs';
import * as path from 'path';
import type { HostModelKey } from '../../config/model-tiers';
import type { HookInput } from '../../core/types';
import { readJson, writeJson } from '../fsjson';
import { obj } from '../obj';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_SCHEMA_VERSION,
  MAX_HOST_CAPABILITY_EVIDENCE_ACCEPT,
  capabilityHash,
  retainCapabilityEvidence,
  safeRunId,
  stableCapabilityContractHash,
  type HostCapabilityContractV1,
  type HostCapabilityEvidenceV1,
  type HostCapabilityV1,
  type TrafficOneHost,
} from './capability-schema';

export function runHostCapabilityPath(
  projectRoot: string,
  runId: string,
): string {
  return path.join(
    projectRoot,
    '.traffic-one',
    'runs',
    safeRunId(runId),
    'host-capability-v1.json',
  );
}

export const RUN_HOST_CAPABILITY_RELATIVE_FILE = 'host-capability-v1.json';

function sameStrings(left: unknown, right: readonly string[]): left is string[] {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function validEvidence(value: unknown, contract: HostCapabilityContractV1): value is HostCapabilityEvidenceV1 {
  const rec = obj(value);
  return Boolean(
    rec
    && (rec.point === null
      || (typeof rec.point === 'string' && contract.enforcementPoints.includes(rec.point)))
    && typeof rec.event === 'string'
    && typeof rec.source === 'string'
    && (rec.sessionId === null || typeof rec.sessionId === 'string')
    && (rec.outcome === 'invoked' || rec.outcome === 'allowed' || rec.outcome === 'denied')
    && typeof rec.observedAt === 'string'
    && Number.isFinite(Date.parse(rec.observedAt)),
  );
}

function parseRunHostCapability(
  value: unknown,
  runId: string,
  expectedHost?: HostModelKey | string,
): HostCapabilityV1 | null {
  const raw = obj(value);
  const host = typeof raw?.host === 'string' ? raw.host as TrafficOneHost : null;
  const contract = host ? HOST_CAPABILITIES[host] : null;
  if (!raw
    || !contract
    || raw.schemaVersion !== HOST_CAPABILITY_SCHEMA_VERSION
    || raw.runId !== runId
    || (expectedHost && host !== expectedHost)
    || !sameStrings(raw.enforcementPoints, contract.enforcementPoints)
    || !sameStrings(raw.requiredBlockingPoints, contract.requiredBlockingPoints)
    || raw.primaryBlockingPoint !== contract.primaryBlockingPoint
    || raw.certification !== contract.certification
    || raw.typedSubagents !== contract.typedSubagents
    || raw.modelObservation !== contract.modelObservation
    || !Array.isArray(raw.observedEnforcementPoints)
    || !raw.observedEnforcementPoints.every((point) => (
      typeof point === 'string' && contract.enforcementPoints.includes(point)
    ))
    || new Set(raw.observedEnforcementPoints).size !== raw.observedEnforcementPoints.length
    || !Array.isArray(raw.observedDeniedEnforcementPoints)
    || !raw.observedDeniedEnforcementPoints.every((point) => (
      typeof point === 'string' && contract.enforcementPoints.includes(point)
    ))
    || new Set(raw.observedDeniedEnforcementPoints).size !== raw.observedDeniedEnforcementPoints.length
    || !(raw.observedDeniedEnforcementPoints as string[]).every((point) => (
      (raw.observedEnforcementPoints as string[]).includes(point)
    ))
    || typeof raw.primaryBlockingPointObserved !== 'boolean'
    || raw.primaryBlockingPointObserved
      !== raw.observedEnforcementPoints.includes(contract.primaryBlockingPoint)
    || typeof raw.primaryBlockingPointDenied !== 'boolean'
    || raw.primaryBlockingPointDenied
      !== raw.observedDeniedEnforcementPoints.includes(contract.primaryBlockingPoint)
    || typeof raw.requiredBlockingPointsObserved !== 'boolean'
    || raw.requiredBlockingPointsObserved
      !== contract.requiredBlockingPoints.every((point) => (
        (raw.observedEnforcementPoints as string[]).includes(point)
      ))
    || raw.prevention !== (
      raw.requiredBlockingPointsObserved && raw.primaryBlockingPointDenied
        ? 'pre-tool'
        : 'completion-only'
    )
    || !(raw.hostVersion === null || typeof raw.hostVersion === 'string')
    || !Array.isArray(raw.evidence)
    || raw.evidence.length > MAX_HOST_CAPABILITY_EVIDENCE_ACCEPT
    || !raw.evidence.every((entry) => validEvidence(entry, contract))
    || typeof raw.createdAt !== 'string'
    || typeof raw.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(raw.createdAt))
    || !Number.isFinite(Date.parse(raw.updatedAt))
    || typeof raw.capabilityHash !== 'string'
    || typeof raw.evidenceHash !== 'string') return null;
  if (raw.capabilityHash !== stableCapabilityContractHash(contract, runId)) return null;
  const { evidenceHash: observedEvidenceHash, ...evidenceCanonical } = raw;
  if (capabilityHash(evidenceCanonical) !== observedEvidenceHash) return null;
  return raw as unknown as HostCapabilityV1;
}

export function readRunHostCapability(
  projectRoot: string,
  runId: string,
  expectedHost?: HostModelKey | string,
): HostCapabilityV1 | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  return parseRunHostCapability(
    readJson(runHostCapabilityPath(projectRoot, runId), null),
    runId,
    expectedHost,
  );
}

interface HostCapabilityObservation {
  point?: string | null;
  event?: string;
  source?: string;
  sessionId?: string | null;
  outcome?: HostCapabilityEvidenceV1['outcome'];
  hostVersion?: string | null;
  observedAt?: string;
}

export function ensureRunHostCapability(
  projectRoot: string,
  runId: string,
  hostInput: HostModelKey | string,
  observation: HostCapabilityObservation = {},
): HostCapabilityV1 | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  const host = hostInput as TrafficOneHost;
  const contract = HOST_CAPABILITIES[host];
  if (!contract) return null;
  const file = runHostCapabilityPath(projectRoot, runId);
  let result: HostCapabilityV1 | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      const existing = readRunHostCapability(projectRoot, runId, host);
      // Published-but-invalid is evidence loss. Never silently replace it with
      // a static optimistic contract.
      if (!existing && fs.existsSync(file)) return;
      const point = typeof observation.point === 'string'
        && contract.enforcementPoints.includes(observation.point)
        ? observation.point
        : null;
      const observedAt = typeof observation.observedAt === 'string'
        && Number.isFinite(Date.parse(observation.observedAt))
        ? observation.observedAt
        : new Date().toISOString();
      const observedEnforcementPoints = [...new Set([
        ...(existing?.observedEnforcementPoints || []),
        ...(point ? [point] : []),
      ])].sort();
      const outcome = observation.outcome === 'allowed' || observation.outcome === 'denied'
        ? observation.outcome
        : 'invoked';
      const observedDeniedEnforcementPoints = [...new Set([
        ...(existing?.observedDeniedEnforcementPoints || []),
        ...(point && outcome === 'denied' ? [point] : []),
      ])].sort();
      const evidence = [...(existing?.evidence || [])];
      let evidenceChanged = false;
      if (observation.source || observation.event || point) {
        const entry: HostCapabilityEvidenceV1 = {
          point,
          event: observation.event || '',
          source: observation.source || 'runtime',
          sessionId: observation.sessionId || null,
          outcome,
          observedAt,
        };
        const last = evidence[evidence.length - 1];
        if (!last
          || last.point !== entry.point
          || last.event !== entry.event
          || last.source !== entry.source
          || last.sessionId !== entry.sessionId
          || last.outcome !== entry.outcome) {
          evidence.push(entry);
          evidenceChanged = true;
        }
      }
      const primaryBlockingPointObserved = observedEnforcementPoints.includes(contract.primaryBlockingPoint);
      const primaryBlockingPointDenied = observedDeniedEnforcementPoints.includes(contract.primaryBlockingPoint);
      const requiredBlockingPointsObserved = contract.requiredBlockingPoints.every((required) => (
        observedEnforcementPoints.includes(required)
      ));
      const hostVersion = typeof observation.hostVersion === 'string' && observation.hostVersion.trim()
        ? observation.hostVersion.trim().slice(0, 160)
        : existing?.hostVersion || null;
      if (existing
        && !evidenceChanged
        && hostVersion === existing.hostVersion
        && observedEnforcementPoints.length === existing.observedEnforcementPoints.length
        && observedEnforcementPoints.every((value, index) => value === existing.observedEnforcementPoints[index])
        && observedDeniedEnforcementPoints.length === existing.observedDeniedEnforcementPoints.length
        && observedDeniedEnforcementPoints.every((
          value,
          index,
        ) => value === existing.observedDeniedEnforcementPoints[index])) {
        result = existing;
        return;
      }
      const canonical = {
        ...contract,
        runId,
        observedEnforcementPoints,
        observedDeniedEnforcementPoints,
        primaryBlockingPointObserved,
        primaryBlockingPointDenied,
        requiredBlockingPointsObserved,
        prevention: requiredBlockingPointsObserved && primaryBlockingPointDenied
          ? 'pre-tool' as const
          : 'completion-only' as const,
        hostVersion,
        evidence: retainCapabilityEvidence(evidence),
        createdAt: existing?.createdAt || observedAt,
        updatedAt: observedAt,
      };
      const contractHash = stableCapabilityContractHash(contract, runId);
      const evidenceCanonical = {
        ...canonical,
        capabilityHash: contractHash,
      };
      const candidate: HostCapabilityV1 = {
        ...evidenceCanonical,
        evidenceHash: capabilityHash(evidenceCanonical),
      };
      if (existing
        && existing.evidenceHash === candidate.evidenceHash) {
        result = existing;
        return;
      }
      writeJson(file, candidate);
      result = readRunHostCapability(projectRoot, runId, host);
    });
  } catch {
    return null;
  }
  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function hookPoint(input: HookInput): string | null {
  const raw = obj(input.raw);
  const nested = obj(raw?.hook);
  const observed = firstString(
    raw?.hook_event_name,
    raw?.hookEventName,
    raw?.event_name,
    raw?.eventName,
    raw?.event,
    nested?.event,
    nested?.name,
  );
  const contract = HOST_CAPABILITIES[input.host];
  if (input.hostHookPoint && contract.enforcementPoints.includes(input.hostHookPoint)) {
    return input.hostHookPoint;
  }
  if (observed && contract.enforcementPoints.includes(observed)) return observed;
  // These three adapters receive a native, blocking PreToolUse invocation;
  // their canonical event is authoritative even when the host omits the
  // redundant raw hook_event_name field. Wrapper/event hosts must still name
  // their concrete point explicitly.
  if (
    input.event === 'PreToolUse'
    && (input.host === 'claude' || input.host === 'codex' || input.host === 'copilot')
  ) return contract.primaryBlockingPoint;
  return null;
}

function hookHostVersion(input: HookInput, env: NodeJS.ProcessEnv): string | null {
  const raw = obj(input.raw);
  const context = obj(raw?.context);
  const envKey = {
    claude: 'CLAUDE_CODE_VERSION',
    codex: 'CODEX_VERSION',
    cursor: 'CURSOR_VERSION',
    opencode: 'OPENCODE_VERSION',
    kilo: 'KILO_VERSION',
    copilot: 'COPILOT_VERSION',
    windsurf: 'WINDSURF_VERSION',
  }[input.host];
  return firstString(
    raw?.host_version,
    raw?.hostVersion,
    raw?.cli_version,
    raw?.cliVersion,
    context?.hostVersion,
    envKey ? env[envKey] : null,
  );
}

export function observeRunHostCapabilityFromHook(
  projectRoot: string,
  runId: string,
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
  outcome: HostCapabilityEvidenceV1['outcome'] = 'invoked',
): HostCapabilityV1 | null {
  const raw = obj(input.raw);
  const point = hookPoint(input);
  return ensureRunHostCapability(projectRoot, runId, input.host, {
    point,
    event: point || input.event,
    source: point
      ? (outcome === 'invoked' ? 'host-hook-invocation' : 'host-hook-result')
      : (outcome === 'invoked' ? 'host-session-invocation' : 'host-session-result'),
    sessionId: firstString(
      raw?.session_id,
      raw?.sessionId,
      raw?.thread_id,
      raw?.threadId,
      raw?.conversation_id,
    ),
    outcome,
    hostVersion: hookHostVersion(input, env),
  });
}

export function observeCurrentRunHostCapabilityFromHook(
  projectRoot: string,
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
  outcome: HostCapabilityEvidenceV1['outcome'] = 'invoked',
): HostCapabilityV1 | null {
  const state = readJson<Record<string, unknown> | null>(
    path.join(projectRoot, '.traffic-one', '.one.json'),
    null,
  );
  const rawRunId = state?.currentRunId;
  const runId = typeof rawRunId === 'string'
    ? rawRunId.trim()
    : typeof rawRunId === 'number' && Number.isFinite(rawRunId)
      ? String(Math.trunc(rawRunId))
      : '';
  return runId
    ? observeRunHostCapabilityFromHook(projectRoot, runId, input, env, outcome)
    : null;
}
export {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_SCHEMA_VERSION,
  hostCapability,
  type HostCapabilityContractV1,
  type HostCapabilityEvidenceV1,
  type HostCapabilityV1,
  type HostModelObservation,
  type TrafficOneHost,
} from './capability-schema';
