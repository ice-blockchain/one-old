// src/shared/run-settlement-io.ts
// Settlement parse/read, the active-claim scan, and the locked writer that
// also refreshes the legacy projection.

import * as fs from 'fs';
import * as path from 'path';

import { SUBAGENT_STALE_MS } from '../../config/state';
import { ageAttestsLiveness, timestampAgeMs } from '../state/run-agent/session-identity';
import { isMaintenanceTerminal, maintenanceOutcome } from '../maintenance/terminal';
import { paidFallbackCompletionFromMaintenance } from '../maintenance/fallback-proof';
import { pluginVersion } from '../../config/plugin-identity';
import { readJson, readJsonResult, writeJson } from '../fsjson';
import { runUsedOperatorOverride } from '../override';
import { withProjectStateLock } from '../state/project-state-lock';
import { strictRunVerificationEvidence } from '../strict-verification-evidence';

import {
  RUN_RESUME_AUTHORIZATION,
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
        // `superseded/` holds immutable claim-HISTORY snapshots, written by
        // archiveSupersededClaim precisely so replaced claims "never re-enter
        // resolution or the spawn-index count". Each snapshot preserves the
        // claim's status at archive time (usually 'claimed'), and no live agent
        // is ever represented ONLY by a snapshot — the live thread keeps its
        // top-level claim file. Counting archives as active made activeClaims
        // permanently positive after any rebind (observed 14cl: 15 of 19
        // "active" claims were snapshots), so a fully green run could never
        // settle verified even after releaseRunClaims swept the real claims.
        if (entry.name === 'bootstrap' || entry.name === 'transactions' || entry.name === 'superseded') continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (['run.json', 'maintenance.json', 'settlement-v2.json', 'model-policy.json', 'assignments.json'].includes(entry.name)) continue;
      scanned += 1;
      const rec = readJson<Rec | null>(absolute, null);
      if (!rec) continue;
      const status = typeof rec.status === 'string' ? rec.status : '';
      if (status !== 'pending' && status !== 'claimed' && status !== 'active' && status !== 'running') continue;
      // A claim only vetoes settlement while it represents a LIVE agent. Nothing
      // aged one out here, while the rest of the codebase has used
      // SUBAGENT_STALE_MS for exactly this judgement for a long time — so an
      // abandoned run kept `activeClaims > 0` forever, and because a later
      // `verified` is downgraded back to `validating` while that is true, the
      // held claims actively prevented the run from ever certifying. Observed
      // 15cl: `validating` with 4 claims hours after the session ended, poisoning
      // the project for every later run.
      //
      // Safe to relax because `activeClaims` is a VETO layered on top of real
      // evidence: settleTerminalRunLedger still demands reviewer APPROVED, tester
      // TESTS_GREEN and QA evidence, so dropping a stale veto can unblock a run
      // that already earned its verdict but can never manufacture one.
      const touchedAt = [rec.updatedAt, rec.claimedAt, rec.createdAt]
        .find((value) => typeof value === 'string' && value);
      let ageMs = timestampAgeMs(touchedAt);
      if (!Number.isFinite(ageMs)) {
        // No usable timestamp: fall back to the record's own mtime rather than
        // assuming either liveness or staleness.
        try { ageMs = Date.now() - fs.statSync(absolute).mtimeMs; } catch { ageMs = 0; }
      }
      // `ageMs > SUBAGENT_STALE_MS` had no lower bound, and the age it tests is
      // a subtraction: a record stamped AHEAD of now yields a NEGATIVE age,
      // which is not merely fresh but maximally fresh, and it kept vetoing
      // until wall-clock time caught up with the stamp. `writeRunSettlement`
      // downgrades `verified` back to `validating` on `activeClaims > 0`, so a
      // clock that stepped backwards (NTP, a manual change) or one out-of-band
      // edit holds an otherwise-certifiable run at `validating` for the whole
      // size of the step. The mtime fallback above has the same shape.
      //
      // ageAttestsLiveness is the predicate this repo already wrote for exactly
      // this asymmetry (session-identity.ts): a stamp is evidence of a LIVE
      // agent only inside [-STATE_TIMESTAMP_FUTURE_SKEW_MS, maxAge]. Reusing it
      // rather than open-coding a bound keeps the five-minute tolerance in the
      // one place config/state.ts already documents it, and it also drops the
      // `Number.isFinite` special case — an unusable age is not evidence
      // either, and the mtime fallback already guarantees a finite number here.
      if (!ageAttestsLiveness(ageMs, SUBAGENT_STALE_MS)) continue;
      count += 1;
    }
  };
  walk(dir);
  return { count, complete, scanned };
}

export function activeRunClaimCount(projectRoot: string, runId: string): number {
  const scan = activeRunClaimScan(projectRoot, runId);
  // A truncated/unreadable scan returns a conservative sentinel even when no
  // active record occurred in the inspected prefix. That is right for the
  // settlement vetoes below, and NOT unconditionally right for every caller —
  // see the consumer table on `runLiveClaimEvidence`.
  return scan.complete ? scan.count : Math.max(1, scan.count);
}

/**
 * The same scan, three-valued — and the distinction `activeRunClaimCount`
 * structurally cannot make.
 *
 * That sentinel is right for the callers it was written FOR, but they are not
 * every caller. Counted by AST parse rather than by grep (the name also appears
 * as imports, a re-export and in prose), `activeRunClaimCount` has five
 * non-test call sites in three classes:
 *
 *   - VETO (3): run-settle.ts's terminal settle and runCompletionEvidenceAllows,
 *     terminal-verdict.ts. A veto that cannot read the evidence must keep
 *     refusing, so the sentinel is exactly right here. (writeRunSettlement's
 *     `activeClaims` is a fourth veto, but it calls `activeRunClaimScan`
 *     directly and does not read this sentinel.)
 *   - DELETER (1, now migrated off): retention.ts's `runIsLive`, whose `true`
 *     means KEEP THIS RUN FOREVER. The measurement below is why it reads
 *     `runLiveClaimEvidence` instead.
 *   - RUN SELECTION (2): run-paths.ts's `recentAdoptableRunId` and
 *     identity-drift.ts's `reconcileRunIdentityDrift`. Neither is a veto.
 *     run-paths documents its own reason to want the sentinel (a truncated scan
 *     biases toward ADOPTING the run we are already in). identity-drift is the
 *     one site where "conservative" does not hold: the sentinel enrols a run as
 *     a drift CANDIDATE, `live.length < 2` is what otherwise makes that pass a
 *     no-op, and every loser is released and transitioned to `failed`. So one
 *     unreadable claim subdirectory can activate a destructive reconciliation
 *     that would not otherwise have run. Left as found — it needs its own
 *     reasoning, not a fold of this sentinel.
 *
 * MEASURED, on a run holding 2,100 claim records every one of which was 30 days
 * stale: the scan stops at `scanned: 2048` with `count: 0`, the sentinel reports
 * 1, and the sweep files the run under `liveRunIds` — outside the newest-N
 * budget, so it holds a reserved slot permanently while NEWER runs are reclaimed
 * around it. Nothing clears the condition, because the only thing that would
 * remove those 2,048 files is the sweep the sentinel is refusing. The bound is
 * not the only trigger either: a single unreadable SUBDIRECTORY under the run
 * returns `complete: false` with `scanned: 0`, so one EACCES is enough.
 *
 * So the ignorance is reported as ignorance and each class answers for itself:
 *   - `live`    — an active record was actually SEEN. Complete or not, this is
 *                 positive evidence and outranks the truncation.
 *   - `none`    — the scan finished and found nothing. Positive evidence too.
 *   - `unknown` — we could not look, or could not finish looking. Not a verdict.
 *
 * Deliberately NOT folded into `activeRunClaimCount`: flipping that sentinel
 * would hand `unknown` to the three vetoes as `0`, which is the one direction a
 * veto must never move.
 */
export type RunLiveClaimEvidence = 'live' | 'none' | 'unknown';

export function runLiveClaimEvidence(projectRoot: string, runId: string): RunLiveClaimEvidence {
  const scan = activeRunClaimScan(projectRoot, runId);
  if (scan.count > 0) return 'live';
  return scan.complete ? 'none' : 'unknown';
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
      //
      // The single exception is the ledger's own resume edge: transitionRunStatus
      // sets `authorizedResume` only after the run-ledger state machine accepted
      // the exact user-authorized reason. Without it, `writeLegacyProjection`
      // re-projected the STALE blocked settlement over the run.json the ledger
      // had just advanced, silently reverting an authorized resume and stranding
      // every newly spawned child with an unclaimable role (observed 10co).
      // `verified` and `failed` are unreachable from here, and the requested
      // status is pinned to `active`, so this expresses `blocked -> active` and
      // nothing else.
      const authorizedResume = update.authorizedResume === RUN_RESUME_AUTHORIZATION
        && update.status === 'active'
        && previous?.status === 'blocked';
      if (previous && !authorizedResume && ['verified', 'failed', 'blocked'].includes(previous.status)) {
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
      // The paid-fallback evidence, and the ONE thing it is consulted for: may
      // this run be CERTIFIED. `readJson(…, null)` answered an ABSENT marker and
      // an ILLEGIBLE one (unparseable, empty, or unreadable) identically, and
      // that was triaged as erring conservatively — a corrupt marker reads as
      // "no marker", which for a run whose settlement already TRACKS a pending
      // fallback does hold it at `validating`.
      //
      // MEASURED, and the triage is wrong for the case where nothing is tracked
      // yet. A marker recording a valid `fallback-paid` completion with no
      // `previous.fallback` gives `recordsPaidFallback` true and
      // `fallbackCompletionMatch(undefined, marker) === 'marker-missing'`, so a
      // LEGIBLE marker downgrades the run to `validating`. Read as `null` the
      // same run comes out `verified` — both for a torn marker and a mode-000
      // one. The illegible read does not err conservatively there; it turns a
      // HOLD into a CERTIFICATE.
      //
      // So the refusal is scoped to exactly that: certification. `verified` is
      // the only status this file derives from the marker, and a certificate is
      // a claim about evidence — an unreadable ledger of paid work is not
      // evidence that none is owed. Every other status still publishes
      // normally, which is what keeps this from stranding anything: the run
      // stays non-terminal and drivable, the ledger can still settle it `failed`
      // or `blocked`, and `activateRunV2RollbackBarrier`/`writeLegacyProjection`
      // are untouched.
      //
      // It does NOT create the known wedge (a `fallback:pending` debt whose only
      // discharge is a completion record in a file nothing can read, holding the
      // run at `validating` forever) — that wedge already fires today on every
      // run whose settlement tracks the debt, measured. This only extends the
      // same hold to the untracked case, under a name that says which of the two
      // it is: `fallback-marker-missing` means a marker we CAN read cites paid
      // work the settlement never pinned; `fallback-marker-unreadable` means we
      // could not look.
      const maintenanceRead = readJsonResult<Rec>(
        path.join(runDir(projectRoot, runId), 'maintenance.json'),
      );
      const maintenance = maintenanceRead.kind === 'ok' ? maintenanceRead.value : null;
      if (status === 'verified'
        && (maintenanceRead.kind === 'corrupt' || maintenanceRead.kind === 'unreadable')) {
        status = 'validating';
        if (previous?.fallback) fallback = previous.fallback;
        reason = 'fallback-marker-unreadable';
        incompleteChecks.push('fallback-marker-unreadable');
      }
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
      // The operator-override abuse guard: a run somebody unblocked a gate for
      // is PERMANENTLY ineligible for `verified`, and therefore for `shipped`
      // too (writeLegacyProjection only projects the `shipped` outcome onto a
      // `verified` settlement, so one refusal covers both).
      //
      // Read from OUTSIDE the project tree (shared/override/**), never from a
      // flag stamped into run state. An in-project marker would be deletable by
      // the same operator who minted the override — and by the agent — so the
      // evidence and the guard have to be the same out-of-tree artefact. It is
      // also why nothing had to be added to run.json, the claims store or the
      // ledger for this.
      //
      // `validating`, not `blocked`/`failed`: the run is refused CERTIFICATION,
      // not declared dead. It can still be settled failed or blocked through the
      // ordinary paths, and the named incomplete check is what
      // `run-status --status completed --outcome verified` reports back through
      // transitionRunStatusResult's settlement-not-verified refusal.
      //
      // Deliberately TTL-BLIND (runOverrideRecords): if the guard expired with
      // the token, waiting 30 minutes would launder the run.
      if (status === 'verified' && runUsedOperatorOverride(projectRoot, runId)) {
        status = 'validating';
        reason = 'operator-override-used';
        incompleteChecks.push('operator-override-used');
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
      const candidate: RunSettlementV2 = { ...withoutHash, settlementHash: settlementHash(withoutHash) };
      // The `| null` return already existed for the `catch` below; the fence's
      // refusal (fsjson.ts: an unanswered consent question, a planted symlink, a
      // path escaping the state dir) was the one outcome it never carried.
      // `written` was assigned before the write, so a refused settlement came
      // back as a non-null, hash-bearing record — and the projection below then
      // stamped run.json with `settlementHash`/`canonicalStatus` for a
      // settlement-v2.json that does not exist, leaving the compatibility
      // projection describing a canonical record no reader can find. Both stop
      // here: nothing on disk means nothing to project and nothing to report.
      if (!writeJson(runSettlementPath(projectRoot, runId), candidate)) return;
      written = candidate;
      writeLegacyProjection(projectRoot, candidate);
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
