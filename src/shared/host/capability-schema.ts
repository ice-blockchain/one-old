// src/shared/host/capability-schema.ts
// Host capability schema, evidence caps, and hashing.

import type { HostModelKey } from '../../config/model-tiers';
import { sha256 } from '../text';

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
  /**
   * Release-harness E2E methodology: whether the primary blocking point is
   * proven by an unattended, scriptable install→run→verify→settle sequence
   * (`contract+live-auto`) or only by a dated manual certification record
   * (`contract+manual-e2e`, see manual-host-certification.ts). Orthogonal to
   * `tier` below — Cursor is `tier: 'certified'` but `contract+manual-e2e`,
   * because it is certified for END-USER enforcement while having no
   * scriptable install for release CI to drive automatically.
   */
  certification: 'contract+live-auto' | 'contract+manual-e2e';
  typedSubagents: boolean;
  /**
   * Kept separate from structural before-tool prevention. A host can block a
   * write while still exposing only the model requested at spawn, not the model
   * that actually executed the child's first tool.
   */
  modelObservation: HostModelObservation;
  /**
   * Product decision (not derived): can Traffic One reliably enforce its
   * guarantees on this host? `certified` hosts (claude, codex, cursor) get no
   * install friction. An `uncertified` host refuses to install (opt-out via
   * TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST, see shared/host/tiers.ts) and, once
   * running, carries a SessionStart banner. Independent of `certification`
   * above — that axis is about release-harness proof methodology, this one is
   * about the guarantee a user gets.
   */
  tier: 'certified' | 'uncertified';
  /**
   * True when this host's native PreToolUse hook event, by itself, already
   * identifies `primaryBlockingPoint` (claude/codex/copilot: one native
   * blocking PreToolUse invocation, event name redundant). False when the
   * host is a wrapper/event adapter that must name its concrete enforcement
   * point explicitly via `hostHookPoint` (cursor/opencode/kilo/windsurf, each
   * of which multiplexes several distinct hook points onto canonical
   * PreToolUse). See capabilities.ts `hookPoint()`.
   */
  primaryBlockingPointIsImplicit: boolean;
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
    tier: 'certified',
    primaryBlockingPointIsImplicit: true,
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
    tier: 'certified',
    primaryBlockingPointIsImplicit: true,
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
    // Certified for end-user enforcement (tier below), but release CI cannot
    // drive Cursor's install→run→verify→settle sequence unattended: there is
    // no scriptable install (it auto-imports Claude's user-scope bundle via
    // an editor-only `/add-plugin` pointer), so its release evidence is a
    // dated manual certification record — the same slot opencode/kilo/copilot/
    // windsurf use — not a live-auto run.
    certification: 'contract+manual-e2e',
    typedSubagents: true,
    modelObservation: 'spawn-request-only',
    tier: 'certified',
    primaryBlockingPointIsImplicit: false,
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
    tier: 'uncertified',
    primaryBlockingPointIsImplicit: false,
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
    tier: 'uncertified',
    primaryBlockingPointIsImplicit: false,
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
    tier: 'uncertified',
    primaryBlockingPointIsImplicit: true,
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
    tier: 'uncertified',
    primaryBlockingPointIsImplicit: false,
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
export const MAX_HOST_CAPABILITY_EVIDENCE_ACCEPT = 64;

export function retainCapabilityEvidence(
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

export function safeRunId(value: string): string {
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

export function capabilityHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

export function stableCapabilityContractHash(
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
    tier: contract.tier,
    primaryBlockingPointIsImplicit: contract.primaryBlockingPointIsImplicit,
    runId,
  });
}
