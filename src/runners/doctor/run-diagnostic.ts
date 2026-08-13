// src/runners/doctor/run-diagnostic.ts
// `doctor --run <id>` probe: everything an operator needs to answer "why is
// this run stuck" without cross-referencing four separate files by hand — live
// agents against their liveness windows, held claims (pending + claimed)
// against theirs, the run ledger's status (raw AND canonical, because the V2
// rollback barrier makes those legitimately disagree — see the warning below),
// and the top repeated deny ids from the decision log.
//
// Read-only, like every other doctor probe (see plugin-root-probe.ts's header):
// this file must never write, prune, or mutate ANYTHING it reads. That rules
// out reusing listPendingClaims (claims-pending.ts) directly — it prunes
// expired pending claims as a side effect of listing them — so pending claims
// are read here with the same file-parsing logic (readClaimFile) but without
// the prune.

import * as fs from 'fs';
import * as path from 'path';

import { isDenyId } from '../../config/deny-ids';
import { PENDING_AGENT_CLAIM_STALE_MS, SUBAGENT_STALE_MS } from '../../config/state';
import { readJson } from '../../shared/fsjson';
import { obj, type Rec } from '../../shared/obj';
import {
  SETTLEMENT_RECORD_ILLEGIBLE_CHECK,
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
  readRunSettlementResult,
  runSettlementIllegible,
  runSettlementQuarantinePath,
  type RunSettlementLegibility,
} from '../../shared/run-settlement';
import { readDecisions, type DecisionRecord } from '../../shared/state/decision-log';
import { listClaimedAgents } from '../../shared/state/run-agent/claims-store';
import { readClaimFile } from '../../shared/state/run-agent/claims-pending';
import { readRunAgentRegistry } from '../../shared/state/run-agent/registry';
import { pendingDir, runDir, runLedgerFile } from '../../shared/state/run-agent/run-paths';
import { timestampAgeMs } from '../../shared/state/run-agent/session-identity';

export interface LiveAgentDiagnostic {
  readonly role: string;
  readonly agentId: string;
  readonly recordedAt: string;
  readonly ageMs: number;
  readonly windowMs: number;
  readonly stale: boolean;
  readonly replaced: boolean;
  readonly parentSessionId: string | null;
}

export type ClaimStateDiagnostic = 'pending' | 'claimed' | 'released' | 'unknown';

export interface ClaimDiagnostic {
  readonly role: string;
  readonly claimId: string | null;
  readonly state: ClaimStateDiagnostic;
  readonly createdAt: string | null;
  readonly ageMs: number;
  readonly windowMs: number;
  readonly stale: boolean;
  readonly parentSessionId: string | null;
}

export interface LedgerDiagnostic {
  readonly exists: boolean;
  readonly rawStatus: string | null;
  readonly rawOutcome: string | null;
  readonly effectiveStatus: string | null;
  readonly effectiveOutcome: string | null;
  readonly canonicalStatus: string | null;
  readonly canonicalReason: string | null;
  // WHY `canonicalStatus` is null, which it structurally cannot say on its own:
  // 'absent' is a legacy/V1 run that never had a canonical record, and every
  // other non-'ok' value is a record that IS there and could not be read. The
  // report printed "(no settlement-v2.json — legacy/V1 run)" for both, so a run
  // whose every settlement write was being refused rendered byte-identically to
  // a healthy legacy one. See run-settlement/io.ts's `RunSettlementLegibility`.
  readonly canonicalLegibility: RunSettlementLegibility;
  // Where this writer preserved the illegible bytes, when they are on disk.
  // Non-null after the writer has rebuilt over a damaged record, which is the
  // state in which `canonicalLegibility` has gone back to 'ok' and the only
  // remaining traces are this file and the marker below.
  readonly canonicalQuarantinePath: string | null;
  // The permanent consequence, read out of the (legible) record itself: this
  // run's canonical settlement was found damaged at least once, so it can never
  // certify. Survives the repair, unlike `canonicalLegibility`.
  readonly canonicalIllegibleOnce: boolean;
  readonly qaContractVersion: number | null;
  readonly statusUpdatedAt: string | null;
  // Non-null only when the V2 rollback barrier is active and the raw/effective
  // status disagrees with the canonical one — the exact trap
  // run-settlement/projection.ts's header warns readers about (a run.json that
  // physically says `failed`/`agent-failed` over a run that is alive).
  readonly rollbackBarrierNote: string | null;
}

/**
 * ABSENT vs ILLEGIBLE, in the operator's terms. `(no settlement-v2.json —
 * legacy/V1 run)` was printed for BOTH: a hash-damaged record and a genuine
 * legacy run rendered byte-identically, while the damaged one had every
 * settlement write refused. The sentence a reader took away from it was the one
 * thing that was false — that there is no file.
 *
 * Spelled per kind (the same shape findings.ts's `describeIllegibleLedger` uses
 * for the override ledger) because the three causes differ and only one of them
 * is a permissions problem.
 *
 * HERE rather than in the renderer, and exported, because the report and the
 * machine-readable finding must say the same thing about the same bytes — the
 * one-voice rule the override findings already follow. A reader who gets a
 * different account from `doctor --run` and `doctor --bundle` has to work out
 * which of the two is stale before they can act on either.
 */
export function describeSettlementLegibility(ledger: LedgerDiagnostic): string {
  if (ledger.canonicalLegibility === 'corrupt') {
    return 'settlement-v2.json IS PRESENT and is not JSON — a torn write, or the empty file an interrupted '
      + 'write leaves behind. This is NOT a legacy/V1 run.';
  }
  if (ledger.canonicalLegibility === 'malformed') {
    return 'settlement-v2.json IS PRESENT, parses as JSON, and is not a valid settlement for this run — a '
      + "wrong shape, another run's record (what copying a run directory produces), or an integrity digest "
      + 'that does not match its own contents. This is NOT a legacy/V1 run.';
  }
  if (ledger.canonicalLegibility === 'unreadable') {
    return 'settlement-v2.json IS PRESENT and could not be read at all (permissions, a directory in its '
      + 'place, or an I/O error). This is NOT a legacy/V1 run.';
  }
  return 'settlement-v2.json parses and names this run.';
}

export interface DenyTally {
  readonly denyId: string;
  readonly count: number;
  readonly recognized: boolean;
  readonly lastSeenAt: string;
  readonly gateIds: string[];
}

export interface RunDiagnosticProbe {
  readonly runId: string;
  readonly runDirExists: boolean;
  readonly liveAgents: LiveAgentDiagnostic[];
  readonly claims: ClaimDiagnostic[];
  readonly ledger: LedgerDiagnostic;
  readonly decisionCount: number;
  readonly denyCount: number;
  readonly topDenies: DenyTally[];
  readonly decisionLogPath: string;
}

function claimAgeAndWindow(createdAt: unknown, windowMs: number): { ageMs: number; stale: boolean } {
  const ageMs = timestampAgeMs(createdAt);
  return { ageMs, stale: ageMs > windowMs };
}

function claimState(claim: Rec, isPendingFile: boolean): ClaimStateDiagnostic {
  if (typeof claim.status === 'string') {
    if (claim.status === 'released') return 'released';
    if (claim.status === 'claimed' || claim.status === 'pending') return claim.status;
  }
  return isPendingFile ? 'pending' : 'unknown';
}

// Mirrors claims-pending.ts's listPendingClaims file-reading logic exactly,
// MINUS the `removePendingClaim` side effect on expiry: doctor reports a
// pending claim as stale rather than deleting it, because deleting state is
// exactly the kind of action a read-only diagnostic must never take (a
// pruned pending claim taken while an operator is mid-diagnosis would erase
// the very evidence doctor was asked to show).
function listPendingClaimsReadOnly(cwd: string, runId: string): Rec[] {
  const dir = pendingDir(cwd, runId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const claim = readClaimFile(path.join(dir, entry.name));
    if (claim) out.push(claim);
  }
  return out;
}

function diagnoseClaims(cwd: string, runId: string): ClaimDiagnostic[] {
  const pending = listPendingClaimsReadOnly(cwd, runId).map((claim) => {
    const { ageMs, stale } = claimAgeAndWindow(claim.createdAt, PENDING_AGENT_CLAIM_STALE_MS);
    return {
      role: typeof claim.role === 'string' ? claim.role : '(unknown role)',
      claimId: typeof claim.claimId === 'string' ? claim.claimId : null,
      state: claimState(claim, true),
      createdAt: typeof claim.createdAt === 'string' ? claim.createdAt : null,
      ageMs,
      windowMs: PENDING_AGENT_CLAIM_STALE_MS,
      stale,
      parentSessionId: typeof claim.parentSessionId === 'string' ? claim.parentSessionId : null,
    };
  });
  const claimed = listClaimedAgents(cwd, runId)
    .filter((claim) => claim.status !== 'released')
    .map((claim) => {
      const { ageMs, stale } = claimAgeAndWindow(claim.createdAt, SUBAGENT_STALE_MS);
      return {
        role: typeof claim.role === 'string' ? claim.role : '(unknown role)',
        claimId: typeof claim.claimId === 'string' ? claim.claimId : null,
        state: claimState(claim, false),
        createdAt: typeof claim.createdAt === 'string' ? claim.createdAt : null,
        ageMs,
        windowMs: SUBAGENT_STALE_MS,
        stale,
        parentSessionId: typeof claim.parentSessionId === 'string' ? claim.parentSessionId : null,
      };
    });
  return [...pending, ...claimed];
}

function diagnoseLiveAgents(cwd: string, runId: string): LiveAgentDiagnostic[] {
  const registry = readRunAgentRegistry(cwd, runId);
  return Object.values(registry).map((entry) => {
    const ageMs = timestampAgeMs(entry.recordedAt);
    return {
      role: entry.role,
      agentId: entry.agentId,
      recordedAt: entry.recordedAt,
      ageMs,
      windowMs: SUBAGENT_STALE_MS,
      stale: entry.replaced || ageMs > SUBAGENT_STALE_MS,
      replaced: entry.replaced,
      parentSessionId: entry.parentSessionId,
    };
  });
}

// See run-settlement/projection.ts's `legacyProjection` doc comment: under the
// V2 rollback barrier, run.json's raw `status`/`outcome` DELIBERATELY reads
// `failed`/`agent-failed` for an in-flight run so an OLD runtime refuses to
// reopen it — but that is exactly the shape a human diagnosing a wedge reads
// as "this run died". Surface the canonical status (from settlement-v2.json,
// the actual source of truth for a V2 run) ALONGSIDE the raw/effective one and
// say explicitly when they disagree, so this probe cannot re-create the two
// investigations that trap already cost.
function diagnoseLedger(cwd: string, runId: string): LedgerDiagnostic {
  // READ BEFORE THE LEDGER IS EVEN CHECKED, because the two damaged halves
  // travel together: the recoverability drill's wedge is a damaged settlement
  // UNDER a corrupt or missing `run.json`, and the early return below used to
  // leave every settlement field null for exactly that pair — the one shape
  // where an operator most needs to be told there are two things to fix.
  const settlementRead = readRunSettlementResult(cwd, runId);
  const settlement = settlementRead.settlement;
  const canonical = {
    canonicalStatus: settlement?.status ?? null,
    canonicalReason: settlement?.reason ?? null,
    canonicalLegibility: settlementRead.kind,
    canonicalQuarantinePath: fs.existsSync(runSettlementQuarantinePath(cwd, runId))
      ? runSettlementQuarantinePath(cwd, runId)
      : null,
    canonicalIllegibleOnce: Boolean(
      settlement?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK)
      || runSettlementIllegible(settlementRead.kind),
    ),
  };
  const raw = obj(readJson(runLedgerFile(cwd, runId), null));
  if (!raw) {
    return {
      exists: false,
      rawStatus: null,
      rawOutcome: null,
      effectiveStatus: null,
      effectiveOutcome: null,
      ...canonical,
      qaContractVersion: null,
      statusUpdatedAt: null,
      rollbackBarrierNote: null,
    };
  }
  const effectiveStatus = effectiveLegacyRunStatus(raw) || null;
  const effectiveOutcome = effectiveLegacyRunOutcome(raw) || null;
  const canonicalStatus = canonical.canonicalStatus;
  const rawStatus = typeof raw.status === 'string' ? raw.status : null;
  const barrierActive = Boolean(raw.runtimeV2RollbackGuard);
  const rollbackBarrierNote = barrierActive && canonicalStatus && canonicalStatus !== effectiveStatus
    ? `V2 rollback barrier active: run.json's status/outcome read "${rawStatus}"/"${effectiveOutcome ?? 'n/a'}" for `
      + `compatibility with older runtimes, but the canonical settlement (settlement-v2.json) says "${canonicalStatus}". `
      + 'Trust canonicalStatus, not rawStatus, for this run.'
    : null;
  return {
    exists: true,
    rawStatus,
    rawOutcome: typeof raw.outcome === 'string' ? raw.outcome : null,
    effectiveStatus,
    effectiveOutcome,
    ...canonical,
    qaContractVersion: typeof raw.qaContractVersion === 'number' ? raw.qaContractVersion : null,
    statusUpdatedAt: typeof raw.statusUpdatedAt === 'string' ? raw.statusUpdatedAt : null,
    rollbackBarrierNote,
  };
}

const TOP_DENY_LIMIT = 10;

// Newest first, for ISO timestamps (lexicographic order is chronological).
function compareDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function tallyDenies(decisions: readonly DecisionRecord[]): DenyTally[] {
  const tallies = new Map<string, { count: number; lastSeenAt: string; gateIds: Set<string> }>();
  for (const record of decisions) {
    if (record.decision !== 'deny' || !record.denyId) continue;
    const existing = tallies.get(record.denyId);
    if (existing) {
      existing.count += 1;
      if (record.ts > existing.lastSeenAt) existing.lastSeenAt = record.ts;
      if (record.gateId) existing.gateIds.add(record.gateId);
    } else {
      tallies.set(record.denyId, {
        count: 1,
        lastSeenAt: record.ts,
        gateIds: new Set(record.gateId ? [record.gateId] : []),
      });
    }
  }
  return [...tallies.entries()]
    .map(([denyId, value]) => ({
      denyId,
      count: value.count,
      recognized: isDenyId(denyId),
      lastSeenAt: value.lastSeenAt,
      gateIds: [...value.gateIds],
    }))
    // Antisymmetric at every level (a three-way compare, never a bare
    // ternary): equal counts AND equal timestamps must return 0, or the sort is
    // not a valid comparator and the order of tied denies is engine-defined.
    // Tie-broken on denyId so the report is byte-stable across runs.
    .sort((a, b) => (b.count - a.count)
      || compareDesc(a.lastSeenAt, b.lastSeenAt)
      || (a.denyId < b.denyId ? -1 : (a.denyId > b.denyId ? 1 : 0)))
    .slice(0, TOP_DENY_LIMIT);
}

export function probeRunDiagnostic(cwd: string, runId: string): RunDiagnosticProbe {
  const decisions = readDecisions(cwd, runId);
  return {
    runId,
    runDirExists: fs.existsSync(runDir(cwd, runId)),
    liveAgents: diagnoseLiveAgents(cwd, runId),
    claims: diagnoseClaims(cwd, runId),
    ledger: diagnoseLedger(cwd, runId),
    decisionCount: decisions.length,
    denyCount: decisions.filter((record) => record.decision === 'deny').length,
    topDenies: tallyDenies(decisions),
    decisionLogPath: path.join(runDir(cwd, runId), 'debug', 'decisions.jsonl'),
  };
}
