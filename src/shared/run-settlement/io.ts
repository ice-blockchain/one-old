// src/shared/run-settlement-io.ts
// Settlement parse/read, the active-claim scan, and the locked writer that
// also refreshes the legacy projection.

import * as fs from 'fs';
import * as path from 'path';
import { isMaintenanceTerminal, maintenanceOutcome } from '../maintenance/terminal';
import { paidFallbackCompletionFromMaintenance } from '../maintenance/fallback-proof';
import { pluginVersion } from '../../config/plugin-identity';
import { readJson, writeJson } from '../fsjson';
import { withProjectStateLock } from '../state/project-state-lock';
import { strictRunVerificationEvidence } from '../strict-verification-evidence';

import {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  RUN_SETTLEMENT_SCHEMA_VERSION,
  runDir,
  runSettlementPath,
  runtimeVersionSatisfies,
  settlementHash,
  type Rec,
  type RunSettlementV2,
  type SettlementUpdate,
  safeRunId,
} from './types';
import {
  writeLegacyProjection,
} from './projection';

function parseSettlement(value: unknown, runId: string): RunSettlementV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<RunSettlementV2>;
  if (raw.schemaVersion !== 2
    || raw.runId !== runId
    || typeof raw.runtimeVersion !== 'string'
    || typeof raw.minimumRuntimeVersion !== 'string'
    || !['planned', 'active', 'code-delivered', 'validating', 'verified', 'failed', 'blocked'].includes(String(raw.status))
    || !Number.isInteger(raw.activeClaims)
    || Number(raw.activeClaims) < 0
    || !Array.isArray(raw.incompleteChecks)
    || !raw.incompleteChecks.every((item) => typeof item === 'string')
    || !Number.isInteger(raw.revision)
    || Number(raw.revision) < 1
    || typeof raw.updatedAt !== 'string'
    || typeof raw.settlementHash !== 'string') return null;
  const { settlementHash: observed, ...canonical } = raw;
  if (settlementHash(canonical) !== observed) return null;
  if (raw.status === 'verified' && (
    Number(raw.activeClaims) > 0
    || raw.incompleteChecks.length > 0
    || raw.fallback?.state === 'pending'
  )) return null;
  return raw as RunSettlementV2;
}

export function readRunSettlement(projectRoot: string, runId: string): RunSettlementV2 | null {
  return parseSettlement(readJson(runSettlementPath(projectRoot, runId), null), runId);
}

interface ActiveRunClaimScan {
  count: number;
  complete: boolean;
  scanned: number;
}

export function activeRunClaimScan(projectRoot: string, runId: string): ActiveRunClaimScan {
  const dir = runDir(projectRoot, runId);
  let count = 0;
  let scanned = 0;
  let complete = true;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch {
      if (current !== dir || fs.existsSync(dir)) complete = false;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scanned >= 2_048) {
        complete = false;
        return;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'bootstrap' || entry.name === 'transactions') continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (['run.json', 'maintenance.json', 'settlement-v2.json', 'model-policy.json', 'assignments.json'].includes(entry.name)) continue;
      scanned += 1;
      const rec = readJson<Rec | null>(absolute, null);
      if (!rec) continue;
      const status = typeof rec.status === 'string' ? rec.status : '';
      if (status === 'pending' || status === 'claimed' || status === 'active' || status === 'running') count += 1;
    }
  };
  walk(dir);
  return { count, complete, scanned };
}

export function activeRunClaimCount(projectRoot: string, runId: string): number {
  const scan = activeRunClaimScan(projectRoot, runId);
  // Existing callers use a positive value as a terminal-settlement veto. A
  // truncated/unreadable scan therefore returns a conservative sentinel even
  // when no active record occurred in the inspected prefix.
  return scan.complete ? scan.count : Math.max(1, scan.count);
}

export function writeRunSettlement(
  projectRoot: string,
  runId: string,
  update: SettlementUpdate,
): RunSettlementV2 | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  if (!runtimeVersionSatisfies(pluginVersion(), RUN_SETTLEMENT_MIN_RUNTIME_VERSION)) return null;
  let written: RunSettlementV2 | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      const previous = readRunSettlement(projectRoot, runId);
      // Canonical terminal settlements are immutable for this run. A delayed
      // projection/reconciliation pass may have read an older active ledger,
      // but it must never reopen verified, failed, or blocked work.
      if (previous && ['verified', 'failed', 'blocked'].includes(previous.status)) {
        written = previous;
        writeLegacyProjection(projectRoot, previous);
        return;
      }
      const claimScan = activeRunClaimScan(projectRoot, runId);
      const activeClaims = claimScan.complete ? claimScan.count : Math.max(1, claimScan.count);
      const incompleteChecks = [...new Set([
        ...(update.incompleteChecks || []),
        ...(!claimScan.complete ? ['active-claim-scan-incomplete'] : []),
      ])].sort();
      let status = update.status;
      let reason = update.reason;
      let fallback = update.fallback;
      const maintenance = readJson<Rec | null>(
        path.join(runDir(projectRoot, runId), 'maintenance.json'),
        null,
      );
      if (status === 'verified') {
        const trackedFallback = previous?.fallback;
        if (trackedFallback || recordsPaidFallback(maintenance)) {
          const match = fallbackCompletionMatch(trackedFallback, maintenance);
          const requestedCompletionMatches = trackedFallback?.state !== 'pending'
            || (
              fallback?.state === 'completed'
              && fallback.workUnitContractHash === trackedFallback.workUnitContractHash
              && fallback.allowlistHash === trackedFallback.allowlistHash
            );
          if (match !== 'matched' || !requestedCompletionMatches) {
            status = 'validating';
            fallback = trackedFallback;
            reason = match === 'hash-mismatch'
              ? 'fallback-contract-mismatch'
              : match === 'marker-missing'
                ? 'fallback-marker-missing'
                : 'fallback-pending';
            incompleteChecks.push(match === 'hash-mismatch'
              ? 'fallback-hash-mismatch'
              : match === 'marker-missing'
                ? 'fallback-marker-missing'
                : 'fallback-pending');
          }
        }
      }
      if (status === 'verified') {
        const verification = strictRunVerificationEvidence(projectRoot, runId);
        // A canonical V2 settlement is never certified from legacy digest
        // conventions alone. Legacy ledgers remain readable for compatibility,
        // but adopting them into `verified` requires the runtime-owned
        // VerificationContractV2 and its matching QaReportV2 — including
        // backend/non-UI runs, whose build/test/lint checks live in that report.
        if (!verification.ok || verification.evidenceKind !== 'v2') {
          status = 'validating';
          reason = 'verification-evidence-incomplete';
          incompleteChecks.push(...verification.incompleteChecks);
          if (verification.evidenceKind !== 'v2') {
            incompleteChecks.push('verification-contract-missing-or-invalid');
            incompleteChecks.push('qa-verification-incomplete');
          }
        }
      }
      if (update.status === 'verified' && (
        activeClaims > 0
        || incompleteChecks.length > 0
        || fallback?.state === 'pending'
      )) {
        status = 'validating';
        if (activeClaims > 0) incompleteChecks.push('active-claims');
        if (fallback?.state === 'pending') incompleteChecks.push('fallback-pending');
      }
      const normalizedIncomplete = [...new Set(incompleteChecks)].sort();
      const unchanged = previous
        && previous.status === status
        && previous.runtimeVersion === pluginVersion()
        && previous.minimumRuntimeVersion === RUN_SETTLEMENT_MIN_RUNTIME_VERSION
        && previous.reason === reason
        && previous.workUnitContractHash === update.workUnitContractHash
        && previous.allowlistHash === update.allowlistHash
        && JSON.stringify(previous.fallback || null) === JSON.stringify(fallback || null)
        && previous.activeClaims === activeClaims
        && JSON.stringify(previous.incompleteChecks) === JSON.stringify(normalizedIncomplete);
      if (unchanged) {
        written = previous;
        writeLegacyProjection(projectRoot, previous);
        return;
      }
      const withoutHash = {
        schemaVersion: RUN_SETTLEMENT_SCHEMA_VERSION,
        runId,
        runtimeVersion: pluginVersion(),
        minimumRuntimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
        status,
        ...(reason ? { reason } : {}),
        ...(update.workUnitContractHash ? { workUnitContractHash: update.workUnitContractHash } : {}),
        ...(update.allowlistHash ? { allowlistHash: update.allowlistHash } : {}),
        ...(fallback ? { fallback } : {}),
        activeClaims,
        incompleteChecks: normalizedIncomplete,
        revision: (previous?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      written = { ...withoutHash, settlementHash: settlementHash(withoutHash) };
      writeJson(runSettlementPath(projectRoot, runId), written);
      writeLegacyProjection(projectRoot, written);
    });
  } catch {
    return null;
  }
  return written;
}

export function digestExists(projectRoot: string, runId: string, names: string[]): boolean {
  return names.some((name) => {
    try {
      return fs.readFileSync(path.join(projectRoot, '.traffic-one', 'digests', safeRunId(runId), name), 'utf8').trim().length > 0;
    } catch {
      return false;
    }
  });
}
type FallbackCompletionMatch = 'matched' | 'pending' | 'marker-missing' | 'hash-mismatch';
export function recordsPaidFallback(value: unknown): boolean {
  return Boolean(paidFallbackCompletionFromMaintenance(value));
}
export function rawPaidFallback(value: Rec | null): boolean {
  return [value?.overallOutcome, value?.outcome]
    .some((candidate) => typeof candidate === 'string'
      && candidate.trim().toLowerCase() === 'fallback-paid');
}
export function fallbackCompletionMatch(
  pending: RunSettlementV2['fallback'] | undefined,
  maintenance: Rec | null,
): FallbackCompletionMatch {
  const outcome = maintenanceOutcome(maintenance);
  if (outcome === 'failed' || outcome === 'blocked') return 'pending';
  const rawPaidMarker = rawPaidFallback(maintenance);
  const completion = paidFallbackCompletionFromMaintenance(maintenance);
  if (!rawPaidMarker && !isMaintenanceTerminal(maintenance)) return 'pending';
  if (!pending) return rawPaidMarker ? 'marker-missing' : 'matched';
  const workUnitContractHash = typeof maintenance?.workUnitContractHash === 'string'
    ? maintenance.workUnitContractHash
    : '';
  const allowlistHash = typeof maintenance?.allowlistHash === 'string'
    ? maintenance.allowlistHash
    : '';
  if (!pending.workUnitContractHash
    || !pending.allowlistHash
    || workUnitContractHash !== pending.workUnitContractHash
    || allowlistHash !== pending.allowlistHash) {
    return 'hash-mismatch';
  }
  if (!completion) return 'marker-missing';
  if (pending.state !== 'completed') return 'pending';
  if (completion.workUnitContractHash !== pending.workUnitContractHash
    || completion.allowlistHash !== pending.allowlistHash) {
    return 'hash-mismatch';
  }
  return 'matched';
}
