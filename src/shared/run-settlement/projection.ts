// src/shared/run-settlement-projection.ts
// Legacy run.json projection + the v2 rollback barrier: how a v2 settlement
// is mirrored into the legacy fields old runtimes still read.

import * as fs from 'fs';
import * as path from 'path';
import { pluginVersion } from '../../config/plugin-identity';
import { readJsonResult, writeJson, writeJsonSet, writeTextFile, type JsonWrite } from '../fsjson';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  runDir,
  runtimeVersionSatisfies,
  settlementHash,
  type CanonicalRunStatus,
  type Rec,
  type RunSettlementV2,
  type RunV2RollbackBarrierProjection,
} from './types';

export function effectiveLegacyRunStatus(
  value: unknown,
  runtimeVersion = pluginVersion(),
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const rec = value as Rec;
  const guard = rec.runtimeV2RollbackGuard && typeof rec.runtimeV2RollbackGuard === 'object'
    ? rec.runtimeV2RollbackGuard as Rec
    : null;
  const minimum = typeof guard?.minimumRuntimeVersion === 'string'
    ? guard.minimumRuntimeVersion
    : '';
  const canonical = typeof guard?.canonicalStatus === 'string' ? guard.canonicalStatus : '';
  if (!minimum || !canonical || !runtimeVersionSatisfies(runtimeVersion, minimum)) {
    return typeof rec.status === 'string' ? rec.status : '';
  }
  if (canonical === 'planned') return 'planned';
  if (canonical === 'verified') return 'completed';
  if (canonical === 'failed') return 'failed';
  if (canonical === 'blocked') return 'blocked';
  return 'active';
}

export function effectiveLegacyRunOutcome(
  value: unknown,
  runtimeVersion = pluginVersion(),
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const rec = value as Rec;
  const effectiveStatus = effectiveLegacyRunStatus(rec, runtimeVersion);
  if (effectiveStatus === 'active' || effectiveStatus === 'planned') return '';
  const guard = rec.runtimeV2RollbackGuard && typeof rec.runtimeV2RollbackGuard === 'object'
    ? rec.runtimeV2RollbackGuard as Rec
    : null;
  const minimum = typeof guard?.minimumRuntimeVersion === 'string'
    ? guard.minimumRuntimeVersion
    : '';
  if (minimum
    && runtimeVersionSatisfies(runtimeVersion, minimum)
    && effectiveStatus === 'blocked') {
    return typeof guard?.canonicalOutcome === 'string'
      ? guard.canonicalOutcome
      : 'environment-blocked';
  }
  return typeof rec.outcome === 'string' ? rec.outcome : '';
}

export function projectRunLedgerForV2Rollback(
  value: unknown,
  canonicalStatus: CanonicalRunStatus,
  canonicalOutcome?: string,
  minimumRuntimeVersion = RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
): Rec {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : {};
  const projection = legacyProjection(canonicalStatus, true);
  const guarded = !['verified', 'failed'].includes(canonicalStatus);
  const next: Rec = {
    ...source,
    ...projection,
    canonicalStatus,
    runtimeV2RollbackGuard: guarded
      ? {
          minimumRuntimeVersion,
          canonicalStatus,
          ...(canonicalStatus === 'blocked'
            ? { canonicalOutcome: canonicalOutcome || 'environment-blocked' }
            : {}),
        }
      : undefined,
  };
  if (!next.runtimeV2RollbackGuard) delete next.runtimeV2RollbackGuard;
  if (!projection.outcome) delete next.outcome;
  return next;
}

// Activate the V2 lifecycle before publishing the first V2-only sidecar.
//
// Runtime 1.0.19 reads the physical legacy projection and therefore sees an
// irreversible failed run. (`blocked` is insufficient: 1.0.19 permits an
// explicitly authorized blocked -> active transition.) Current runtimes
// understand the immutable rollback guard and recover its canonical in-flight
// status. Keeping this as a separate atomic write closes the crash window where
// verification-v2.json existed while run.json still looked resumable.
export function activateRunV2RollbackBarrier(
  projectRoot: string,
  runId: string,
  canonicalStatus: 'active' | 'code-delivered' | 'validating' = 'active',
): RunV2RollbackBarrierProjection | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  if (!runtimeVersionSatisfies(pluginVersion(), RUN_SETTLEMENT_MIN_RUNTIME_VERSION)) return null;
  let written: RunV2RollbackBarrierProjection | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      const file = path.join(runDir(projectRoot, runId), 'run.json');
      // The terminal-status check below is this function's ENTIRE safety
      // property, and it is decided from these bytes. `readJson(file, {})`
      // answered a corrupt, an EMPTY (the signature of an O_TRUNC open whose
      // write never landed) and an UNREADABLE ledger with the same `{}` — whose
      // effective status is '' and therefore not terminal — so the one check
      // that exists to refuse a finished run was bypassed, and the record was
      // then rebuilt from nothing: a fresh `createdAt`, a fabricated
      // `kind: 'orchestration'`, an emptied `transitionHistory`, no `finishedAt`
      // and `canonicalStatus: 'active'`. A settled run came back resumable to
      // `runLedgerAdmitsClaims`, to `writeRunLedgerTransition`'s legality check
      // and to `recentAdoptableRunId` — which only skips a terminal run, and
      // whose `qaContractVersion !== 2` guard this write satisfies on its way
      // past. Measured on all three inputs; under mode-000 the previous bytes
      // were destroyed with no throw, because a temp+rename never opens the
      // destination for reading.
      //
      // REFUSING, not healing. The status this function must preserve lives in
      // the bytes it cannot read, so unlike writeState's whole-file replacement
      // there is nothing honest to put in their place — the same reason
      // patchState refuses a base it cannot see. It needs no new channel: `|
      // null` already carries the fence's refusal and plan-readiness, the only
      // production caller, already blocks the run on it. And it destroys
      // nothing, which is why the bytes are left where they are rather than
      // quarantined: they are still the only copy of the run's history.
      const read = readJsonResult<Rec>(file);
      if (read.kind === 'corrupt' || read.kind === 'unreadable') return;
      const existing = read.kind === 'ok' ? read.value : {};
      const effectiveStatus = effectiveLegacyRunStatus(existing);
      if (['completed', 'failed', 'blocked'].includes(effectiveStatus)) return;
      const now = new Date().toISOString();
      const createdAt = typeof existing.createdAt === 'string' && existing.createdAt
        ? existing.createdAt
        : now;
      const canonical: Rec = {
        ...existing,
        version: Math.max(typeof existing.version === 'number' ? existing.version : 1, 2),
        runId,
        kind: typeof existing.kind === 'string' && existing.kind
          ? existing.kind
          : 'orchestration',
        qaContractVersion: 2,
        qaContractActivatedAt: typeof existing.qaContractActivatedAt === 'string'
          && existing.qaContractActivatedAt
          ? existing.qaContractActivatedAt
          : now,
        createdAt,
        statusUpdatedAt: typeof existing.statusUpdatedAt === 'string'
          && existing.statusUpdatedAt
          ? existing.statusUpdatedAt
          : createdAt,
        transitionHistory: Array.isArray(existing.transitionHistory)
          ? existing.transitionHistory
          : [],
        updatedAt: now,
      };
      const next = projectRunLedgerForV2Rollback(
        canonical,
        canonicalStatus,
      ) as RunV2RollbackBarrierProjection;
      // Same `| null` channel the `catch` uses, for the other way this fails:
      // the fence refuses the write (fsjson.ts) and returns `false`. That was
      // dropped, so a barrier that never landed reported itself activated — and
      // plan-readiness went on to publish verification-v2.json behind a run.json
      // an older runtime still reads as resumable, which is exactly the crash
      // window this separate atomic write exists to close.
      if (!writeJson(file, next)) return;
      written = next;
    });
  } catch {
    return null;
  }
  return written;
}


/**
 * The legacy `status`/`outcome` pair written into `run.json` for runtimes older
 * than the v2 settlement. `canonicalStatus` is the truth; these two are a
 * compatibility projection of it.
 *
 * READ THIS BEFORE DIAGNOSING A RUN. Under the rollback barrier this reports
 * `failed`/`agent-failed` over a run that is alive and progressing — which looks
 * exactly like a dead run to anyone reading the file. It has now cost two
 * separate investigations a full diagnosis cycle, and in 16co it sat next to
 * `canonicalStatus: "active"` on a run that went on to finish `verified`.
 *
 * Do NOT "fix" this by renaming the keys to `legacyStatus`/`legacyOutcome`: the
 * barrier works precisely because an OLD runtime reads `status` and refuses to
 * reopen the run. Renaming makes it read a missing field and proceed, which is
 * the failure the barrier exists to prevent. Every current reader already goes
 * through `effectiveLegacyRunStatus`.
 */
function legacyProjection(
  status: CanonicalRunStatus,
  rollbackProtected: boolean,
): { status: string; outcome?: string } {
  if (status === 'verified') return { status: 'completed', outcome: 'verified' };
  if (status === 'failed') return { status: 'failed', outcome: 'agent-failed' };
  if (rollbackProtected) {
    // Runtime 1.0.19 permits `blocked -> active` after a special resume reason.
    // `failed` is the only legacy terminal state that cannot be reopened.
    return { status: 'failed', outcome: 'agent-failed' };
  }
  if (status === 'blocked') return { status: 'blocked', outcome: 'environment-blocked' };
  if (status === 'planned') return { status: 'planned' };
  return { status: 'active' };
}

const BLOCKED_OUTCOMES = ['review-cycle-cap', 'test-cycle-cap', 'environment-blocked'];

const TERMINAL_LEGACY_STATUS: Partial<Record<CanonicalRunStatus, string>> = {
  verified: 'completed',
  failed: 'failed',
  blocked: 'blocked',
};
const PROJECTED_TRANSITION_HISTORY_LIMIT = 32;

// Deliberately the same spelling state/normalize.ts preserves a torn `.one.json`
// under, so an operator finding one of these beside a run directory does not have
// to learn a second convention. Not imported from there: that suffix is private
// to the state writer, and a shared constant would couple two files that only
// happen to agree.
const CORRUPT_LEDGER_SUFFIX = '.corrupt';

// `writeLegacyProjection` is the only writer of run.json that does NOT go
// through the run-ledger state machine, and `reconcileRunSettlement` can derive
// a terminal canonical status the ledger never transitioned to (a terminal
// maintenance result, or strict V2 verification evidence). When that happened,
// run.json ended up carrying a terminal `canonicalStatus` while
// `transitionHistory` still stopped at `planned -> active` and `statusUpdatedAt`
// stayed frozen at that moment — only `updatedAt` moved on. The lifecycle record
// has to be single-sourced: whichever writer moves the run to a terminal state
// records the transition, exactly as `writeRunLedgerTransition` does.
function recordProjectedTerminalTransition(
  existing: Rec,
  next: Rec,
  settlement: RunSettlementV2,
): void {
  const terminal = TERMINAL_LEGACY_STATUS[settlement.status];
  if (!terminal) return;
  const previous = effectiveLegacyRunStatus(existing);
  if (previous === terminal) return;
  const at = settlement.updatedAt;
  // Read the outcome back off the finished projection so the entry records the
  // CANONICAL outcome, not the `agent-failed` mask the rollback barrier writes
  // into the raw `status`/`outcome` pair.
  const outcome = effectiveLegacyRunOutcome(next);
  const history = (Array.isArray(existing.transitionHistory) ? existing.transitionHistory : [])
    .filter((entry): entry is Rec => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  history.push({
    from: previous || null,
    to: terminal,
    at,
    ...(outcome ? { outcome } : {}),
    reason: 'settlement-projection',
  });
  next.transitionHistory = history.slice(-PROJECTED_TRANSITION_HISTORY_LIMIT);
  next.statusUpdatedAt = at;
  next.finishedAt = typeof existing.finishedAt === 'string' && existing.finishedAt
    ? existing.finishedAt
    : at;
}

/**
 * Mirror a settlement into the legacy `run.json` fields, and into the same two
 * fields on `maintenance.json` when that sidecar exists.
 *
 * `void` is deliberate, and it is only honest because of where this sits: the
 * canonical record is `settlement-v2.json`, and `writeRunSettlement` (io.ts) now
 * establishes that it is on disk BEFORE calling this. So a refused mirror leaves
 * legacy readers on the previous consistent projection rather than an invented
 * one, and nothing above has to revise a claim it already made. Returning a
 * boolean here would only add one more droppable value — its three call sites
 * have nothing they could do with it.
 *
 * ── the pair, and why ordering was only half of it ───────────────────────────
 * Two writes to two paths carry the same `canonicalStatus`/`settlementHash`, so
 * either one landing alone leaves the two files citing different settlements.
 * Ordering them and consuming the primary's boolean closed ONE direction: a
 * refused `run.json` no longer lets the sidecar advance past the file every
 * legacy reader consults through `effectiveLegacyRunStatus`.
 *
 * The other direction stayed open, and no ordering can close it — a refused
 * SIDECAR left `run.json` already advanced, stamped with a settlement the
 * sidecar has never heard of. Both are now one `writeJsonSet`, which decides
 * every member's fence verdict before it stages anything, so neither half can
 * land without the other. That is also what makes the `void` above honest for
 * the first time: the docblock has always claimed a refused mirror "leaves
 * legacy readers on the previous consistent projection", and until the set that
 * was true of one direction and aspirational in the other.
 *
 * The set is ordered primary-first deliberately. Its guarantee against a REFUSAL
 * is all-or-nothing, but against a crash it is a bounded window over the commit
 * loop (see `writeJsonSet`), and a prefix landing in this order is `run.json`
 * alone — exactly the ordered-writes behaviour it replaces, never worse.
 *
 * An ILLEGIBLE sidecar is not a member at all rather than a refusal of the set:
 * there is nothing honest to merge into, `run.json` is unaffected by that, and
 * holding the primary back over it would be the inversion this ordering exists
 * to avoid.
 */
export function writeLegacyProjection(projectRoot: string, settlement: RunSettlementV2): void {
  const dir = runDir(projectRoot, settlement.runId);
  const file = path.join(dir, 'run.json');
  const read = readJsonResult<Rec>(file);
  // `unreadable` (EACCES/EISDIR/EIO) gets the OPPOSITE answer to `corrupt`, for
  // the reason it is a separate kind: there are bytes there we cannot copy, so
  // replacing the file would destroy content nothing ever saw. Measured — a
  // mode-000 run.json was overwritten here with no throw.
  if (read.kind === 'unreadable') return;
  // A corrupt base is preserved beside the file BEFORE it is replaced, and a
  // failed preservation refuses the whole pass — the same order and the same
  // `.corrupt` convention state/normalize.ts uses for `.one.json`. Everything
  // the `...existing` spread below carries and the settlement does not is
  // forensic and unrecoverable: `createdAt`, `kind`, `transitionHistory`,
  // `finishedAt`, `qaContractVersion`.
  if (read.kind === 'corrupt' && !writeTextFile(`${file}${CORRUPT_LEDGER_SUFFIX}`, read.text)) return;
  const existing = read.kind === 'ok' ? read.value : {};
  // …and then it HEALS, where activateRunV2RollbackBarrier refuses. The
  // asymmetry is the whole judgement: the docblock above is only honest about
  // `void` because a refused mirror "leaves legacy readers on the previous
  // consistent projection", and a corrupt run.json is not one — every reader
  // going through `effectiveLegacyRunStatus` already gets '' from it, which
  // ledger.ts reads as `planned` and therefore as claimable. The authoritative
  // content here comes from `settlement-v2.json`, which io.ts has already put on
  // disk, so this is a whole-file REPLACEMENT of a derived file (writeState's
  // case) and not a patch against a base (patchState's, and the barrier's).
  //
  // What must NOT collapse with the base is the PROTECTION. `qaContractVersion`
  // is unreadable exactly when the file is, so an illegible base used to fall
  // through to the unprotected branch and strip the rollback guard outright:
  // measured, a blocked settlement over a corrupt base published a bare
  // `status: 'blocked'`, which runtime 1.0.19 permits reopening after a resume
  // reason — the one thing the barrier exists to prevent. So an illegible base
  // is treated as protected. That is sound rather than merely conservative: this
  // function is only ever reached from io.ts with a settlement that is on disk,
  // and reconcile.ts already counts that settlement's existence as the run
  // having activated the V2 lifecycle. For `verified` and `failed` the two
  // branches project identically anyway.
  const legibleBase = read.kind === 'ok' || read.kind === 'absent';
  const rollbackProtected = !legibleBase
    || existing.qaContractVersion === 2
    || fs.existsSync(path.join(dir, 'verification-v2.json'));
  const effectiveExistingOutcome = effectiveLegacyRunOutcome(existing);
  // `settlement-v2.json` is the canonical, hash-protected record; `run.json` is
  // only its projection. So the settlement's own `reason` outranks anything
  // derived from the projection. Without this, projecting a blocked settlement
  // while `run.json` is transiently non-blocked makes
  // `effectiveLegacyRunOutcome` short-circuit to '' (it returns '' for
  // active/planned), `canonicalOutcome` becomes undefined, and
  // `projectRunLedgerForV2Rollback` defaults it to `environment-blocked` —
  // silently rewriting a `review-cycle-cap` run as an environment failure
  // (observed 10co).
  //
  // An ILLEGIBLE base reaches this clause by the same route — '' out of
  // `effectiveLegacyRunOutcome`, measured — so the settlement's reason already
  // covers it whenever a cap was what blocked the run, which is the case that
  // matters. The residue, stated rather than papered over: a blocked settlement
  // whose `reason` is free text over a base we could not read still projects
  // `environment-blocked`, because the legacy vocabulary has no "unknown" —
  // `outcomeAllowedForStatus` (ledger.ts) requires blocked to carry one of the
  // three. The real prior outcome is in the `.corrupt` copy preserved above and
  // the real reason is in `settlement-v2.json`; the projection is the only thing
  // that gets coarser.
  const settlementBlockedOutcome = settlement.status === 'blocked'
    && BLOCKED_OUTCOMES.includes(String(settlement.reason || ''))
    ? settlement.reason
    : undefined;
  const canonicalOutcome = settlement.status === 'verified' && effectiveExistingOutcome === 'shipped'
    ? 'shipped'
    : settlementBlockedOutcome
      ?? (settlement.status === 'blocked'
        && BLOCKED_OUTCOMES.includes(effectiveExistingOutcome)
        ? effectiveExistingOutcome
        : undefined);
  const projection = rollbackProtected
    ? projectRunLedgerForV2Rollback(
        existing,
        settlement.status,
        canonicalOutcome,
        settlement.minimumRuntimeVersion,
      )
    : {
        ...existing,
        ...legacyProjection(settlement.status, false),
        canonicalStatus: settlement.status,
        // An unprotected projection publishes its status raw, so a leftover
        // guard from an earlier barrier activation would make
        // `effectiveLegacyRunStatus` keep reporting the STALE canonical status
        // and contradict the `canonicalStatus` written right here.
        runtimeV2RollbackGuard: undefined,
      };
  if (settlement.status === 'verified' && canonicalOutcome === 'shipped') {
    projection.outcome = 'shipped';
  }
  const next: Rec = {
    ...projection,
    version: Math.max(typeof existing.version === 'number' ? existing.version : 1, 2),
    runId: settlement.runId,
    canonicalStatus: settlement.status,
    settlementHash: settlement.settlementHash,
    settlementUpdatedAt: settlement.updatedAt,
    updatedAt: settlement.updatedAt,
  };
  if (!next.runtimeV2RollbackGuard) delete next.runtimeV2RollbackGuard;
  if (!next.outcome) delete next.outcome;
  recordProjectedTerminalTransition(existing, next, settlement);
  const updates: JsonWrite[] = [{ path: file, value: next }];

  const maintenanceFile = path.join(dir, 'maintenance.json');
  if (fs.existsSync(maintenanceFile)) {
    // The sidecar mirror is a FIELD MERGE, not a projection: two settlement
    // fields onto a record whose real content — the per-unit delegation ledger,
    // `overallOutcome`, the WorkUnit/allowlist hashes a pending paid fallback is
    // pinned by — this function cannot derive from anything. `readJson(…, {})`
    // made a corrupt or unreadable sidecar merge into `{}`, and the write then
    // replaced the whole ledger with those two fields alone: measured, a
    // `fallback-pending` debt and its hashes were annihilated, and the
    // unparseable bytes that recorded them went with it. `fallbackCompletionMatch`
    // then reads back a file with no marker at all and holds the run at
    // `validating`.
    //
    // So this half refuses, where the run.json half heals — a patch against a
    // base that is not there has nothing honest to publish (patchState's answer),
    // and the settlement carries no `units` to rebuild it from. `existsSync` was
    // just true, so `absent` here is a concurrent delete and refusing is right
    // for that too. run.json is still published on its own in that case; what is
    // lost is only the convenience stamp on the sidecar, and nothing derives a
    // run's status from it (`effectiveLegacyRunStatus` reads run.json).
    const maintenance = readJsonResult<Rec>(maintenanceFile);
    if (maintenance.kind === 'ok') {
      updates.push({
        path: maintenanceFile,
        value: {
          ...maintenance.value,
          canonicalStatus: settlement.status,
          settlementHash: settlement.settlementHash,
        },
      });
    }
  }
  writeJsonSet(updates);
}

