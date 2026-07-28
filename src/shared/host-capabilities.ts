import * as fs from 'fs';
import * as path from 'path';

import type { HostModelKey } from '../config/model-tiers';
import type { HookInput } from '../core/types';
import { readJson, writeJson } from './fsjson';
import { obj } from './obj';
import { withProjectStateLock } from './state/project-state-lock';
import { sha256 } from './text';

export const HOST_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type TrafficOneHost =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'kilo'
  | 'copilot'
  | 'windsurf';

export type HostModelObservation =
  | 'first-tool-authoritative'
  | 'spawn-request-only'
  | 'unavailable';

export interface HostCapabilityContractV1 {
  schemaVersion: typeof HOST_CAPABILITY_SCHEMA_VERSION;
  host: TrafficOneHost;
  enforcementPoints: string[];
  primaryBlockingPoint: string;
  requiredBlockingPoints: string[];
  prevention: 'pre-tool' | 'completion-only';
  certification: 'contract+live-auto' | 'contract+manual-e2e';
  typedSubagents: boolean;
  /**
   * Kept separate from structural before-tool prevention. A host can block a
   * write while still exposing only the model requested at spawn, not the model
   * that actually executed the child's first tool.
   */
  modelObservation: HostModelObservation;
}

export interface HostCapabilityEvidenceV1 {
  point: string | null;
  event: string;
  source: string;
  sessionId: string | null;
  outcome: 'invoked' | 'allowed' | 'denied';
  observedAt: string;
}

export interface HostCapabilityV1 extends HostCapabilityContractV1 {
  runId: string;
  observedEnforcementPoints: string[];
  observedDeniedEnforcementPoints: string[];
  primaryBlockingPointObserved: boolean;
  primaryBlockingPointDenied: boolean;
  requiredBlockingPointsObserved: boolean;
  hostVersion: string | null;
  evidence: HostCapabilityEvidenceV1[];
  createdAt: string;
  updatedAt: string;
  /**
   * Stable identity of the runtime-owned host contract for this run. Mutable
   * observations never change this value, so a published child bootstrap can
   * safely pin it across sessions.
   */
  capabilityHash: string;
  /** Full tamper-evidence hash, including observations and timestamps. */
  evidenceHash: string;
}

export const HOST_CAPABILITIES = {
  claude: {
    schemaVersion: 1,
    host: 'claude',
    enforcementPoints: ['PreToolUse', 'SubagentStart', 'native-bootstrap'],
    primaryBlockingPoint: 'PreToolUse',
    requiredBlockingPoints: ['PreToolUse', 'SubagentStart', 'native-bootstrap'],
    prevention: 'pre-tool',
    certification: 'contract+live-auto',
    typedSubagents: true,
    modelObservation: 'spawn-request-only',
  },
  codex: {
    schemaVersion: 1,
    host: 'codex',
    enforcementPoints: ['PreToolUse', 'SubagentStart', 'first-tool-model-check'],
    primaryBlockingPoint: 'PreToolUse',
    requiredBlockingPoints: ['PreToolUse', 'SubagentStart', 'first-tool-model-check'],
    prevention: 'pre-tool',
    certification: 'contract+live-auto',
    typedSubagents: false,
    modelObservation: 'first-tool-authoritative',
  },
  cursor: {
    schemaVersion: 1,
    host: 'cursor',
    enforcementPoints: [
      'preToolUse',
      'beforeShellExecution',
      'beforeReadFile',
      'beforeMCPExecution',
      'afterFileEdit',
    ],
    primaryBlockingPoint: 'preToolUse',
    requiredBlockingPoints: [
      'preToolUse',
      'beforeShellExecution',
      'beforeReadFile',
      'beforeMCPExecution',
    ],
    prevention: 'pre-tool',
    certification: 'contract+live-auto',
    typedSubagents: true,
    modelObservation: 'spawn-request-only',
  },
  opencode: {
    schemaVersion: 1,
    host: 'opencode',
    enforcementPoints: ['tool.execute.before'],
    primaryBlockingPoint: 'tool.execute.before',
    requiredBlockingPoints: ['tool.execute.before'],
    prevention: 'pre-tool',
    certification: 'contract+manual-e2e',
    typedSubagents: true,
    modelObservation: 'spawn-request-only',
  },
  kilo: {
    schemaVersion: 1,
    host: 'kilo',
    enforcementPoints: ['tool.execute.before', 'permission.ask', 'event'],
    primaryBlockingPoint: 'tool.execute.before',
    requiredBlockingPoints: ['tool.execute.before'],
    prevention: 'pre-tool',
    certification: 'contract+manual-e2e',
    typedSubagents: false,
    modelObservation: 'spawn-request-only',
  },
  copilot: {
    schemaVersion: 1,
    host: 'copilot',
    enforcementPoints: ['PreToolUse'],
    primaryBlockingPoint: 'PreToolUse',
    requiredBlockingPoints: ['PreToolUse'],
    prevention: 'pre-tool',
    certification: 'contract+manual-e2e',
    typedSubagents: false,
    modelObservation: 'spawn-request-only',
  },
  windsurf: {
    schemaVersion: 1,
    host: 'windsurf',
    enforcementPoints: ['pre_write_code', 'pre_run_command', 'pre_mcp_tool_use'],
    primaryBlockingPoint: 'pre_write_code',
    requiredBlockingPoints: ['pre_write_code', 'pre_run_command', 'pre_mcp_tool_use'],
    prevention: 'pre-tool',
    certification: 'contract+manual-e2e',
    typedSubagents: false,
    modelObservation: 'spawn-request-only',
  },
} satisfies Readonly<Record<TrafficOneHost, HostCapabilityContractV1>>;

export function hostCapability(
  host: HostModelKey | string,
  observedBlockingPoints?: readonly string[],
  observedDeniedBlockingPoints: readonly string[] = [],
): HostCapabilityContractV1 | null {
  const capability = HOST_CAPABILITIES[host as TrafficOneHost];
  if (!capability) return null;
  if (observedBlockingPoints
    && (
      !capability.requiredBlockingPoints.every((point) => observedBlockingPoints.includes(point))
      || !observedDeniedBlockingPoints.includes(capability.primaryBlockingPoint)
    )) {
    return { ...capability, prevention: 'completion-only' };
  }
  return capability;
}

// Write-side retention cap: the ~1 KB capability contract was dragging a ~15 KB
// evidence log behind it. 16 keeps every load-bearing row via the protections
// below. The parse-side ACCEPT ceiling stays at the historical 64 so a sidecar
// written by an older runtime still parses (a parse null here can never be
// repaired — ensureRunHostCapability refuses to replace a published-but-invalid
// file — so lowering the accept ceiling would hard-wedge existing runs); the
// next observation rewrite trims it to the retention cap.
const MAX_HOST_CAPABILITY_EVIDENCE = 16;
const MAX_HOST_CAPABILITY_EVIDENCE_ACCEPT = 64;

function retainCapabilityEvidence(
  evidence: readonly HostCapabilityEvidenceV1[],
): HostCapabilityEvidenceV1[] {
  if (evidence.length <= MAX_HOST_CAPABILITY_EVIDENCE) return [...evidence];
  const protectedIndexes = new Set<number>();
  const latestPoint = new Map<string, number>();
  const latestDeniedPoint = new Map<string, number>();
  const latestModelGatePoint = new Map<string, number>();
  for (const [index, entry] of evidence.entries()) {
    if (!entry.point) continue;
    latestPoint.set(entry.point, index);
    if (entry.outcome === 'denied') latestDeniedPoint.set(entry.point, index);
    // e2e host-enforcement certification requires a verified-child-model-gate
    // row (host-enforcement-evidence.assert.ts); with a small cap it must be
    // protected explicitly, not incidentally.
    if (entry.source === 'verified-child-model-gate') latestModelGatePoint.set(entry.point, index);
  }
  for (const index of latestPoint.values()) protectedIndexes.add(index);
  for (const index of latestDeniedPoint.values()) protectedIndexes.add(index);
  for (const index of latestModelGatePoint.values()) protectedIndexes.add(index);
  for (
    let index = evidence.length - 1;
    index >= 0 && protectedIndexes.size < MAX_HOST_CAPABILITY_EVIDENCE;
    index -= 1
  ) {
    protectedIndexes.add(index);
  }
  return [...protectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => evidence[index]!);
}

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function capabilityHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function stableCapabilityContractHash(
  contract: HostCapabilityContractV1,
  runId: string,
): string {
  return capabilityHash({
    schemaVersion: contract.schemaVersion,
    host: contract.host,
    enforcementPoints: contract.enforcementPoints,
    primaryBlockingPoint: contract.primaryBlockingPoint,
    requiredBlockingPoints: contract.requiredBlockingPoints,
    prevention: contract.prevention,
    certification: contract.certification,
    typedSubagents: contract.typedSubagents,
    modelObservation: contract.modelObservation,
    runId,
  });
}

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

export interface HostCapabilityObservation {
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
