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
import { movePath, readJson, readJsonResult, writeJson } from '../fsjson';
import { overrideEvidenceChecks, runQuarantinedByOverrideReconciliation, runUsedOperatorOverride } from '../override';
import { signVerifiedSettlement } from '../override/settlement-mac';
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
import { readRegularFileOrThrow } from '../bounded-read';

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
  if (raw.settlementMac !== undefined && typeof raw.settlementMac !== 'string') return null;
  const { settlementHash: observed, settlementMac: _mac, ...canonical } = raw;
  if (settlementHash(canonical) !== observed) return null;
  if (raw.status === 'verified' && (
    Number(raw.activeClaims) > 0
    || raw.incompleteChecks.length > 0
    || raw.fallback?.state === 'pending'
  )) return null;
  return raw as RunSettlementV2;
}

/**
 * ONE spelling, at both ends. The path helper sanitises (`runDir` →
 * `safeRunId`) and the parser demands the record's `runId` match EXACTLY, so
 * the two used to disagree for any id that is not already canonical: writing a
 * settlement for `"R "` landed it in `runs/R/` carrying the unsanitised `"R "`,
 * after which reading the canonical `"R"` parsed the file, compared the ids and
 * answered `null` — a free way to blank another run's canonical record from
 * anything that can pass a run id. MEASURED at the real writer. Certification
 * fails closed on a missing record, so it was never a bypass on its own; it
 * composed with the refusal above, which reads "exists and does not parse" as a
 * reason to refuse every later write.
 *
 * Sanitising here rather than refusing a non-canonical id keeps both spellings
 * naming the one record instead of turning the second one into a silent
 * "no settlement", which is the reading that fails OPEN at every caller that
 * treats `null` as "nothing was ever settled".
 */
export function readRunSettlement(projectRoot: string, runId: string): RunSettlementV2 | null {
  return readRunSettlementResult(projectRoot, runId).settlement;
}

/**
 * HOW THE READ WENT, which the `| null` above structurally cannot say: it
 * answers "this run never had a canonical settlement" and "this run's canonical
 * settlement is damaged" with the same `null`.
 *
 * That collapse is the one this module already refuses to make one layer down
 * (fsjson's `readJsonResult`), re-made here by the parser: a hash-damaged
 * `verified` record and a legacy/V1 run with no record at all both arrive as
 * `null`, and the doctor rendered BOTH as `(no settlement-v2.json — legacy/V1
 * run)`. MEASURED before this existed: damage the hash of an `active`
 * settlement and `doctor --run R` prints byte-identical output to a run that
 * never had one, while every settlement write for that run is refused. A
 * refusal nobody can see is half a control, and this is the read that lets the
 * report say which of the two it is looking at.
 *
 * FIVE KINDS, not three, because the two damage classes have different causes
 * and only one of them is a permissions problem:
 *
 *   'ok'         — parsed, hash intact, and it names THIS run.
 *   'absent'     — ENOENT. The complete answer, and the common one.
 *   'corrupt'    — bytes are there and are not JSON (a torn write, or the empty
 *                  file an O_TRUNC open leaves when the write never landed).
 *   'malformed'  — valid JSON that is not a settlement FOR THIS RUN: a wrong
 *                  shape, another run's record (what `cp -r` of a run dir
 *                  produces), or a digest that does not match its own contents.
 *   'unreadable' — EACCES/EISDIR/EIO. There are bytes and we were refused.
 */
export type RunSettlementLegibility = 'ok' | 'absent' | 'corrupt' | 'malformed' | 'unreadable';

export interface RunSettlementRead {
  readonly kind: RunSettlementLegibility;
  /** Non-null exactly when `kind === 'ok'`. */
  readonly settlement: RunSettlementV2 | null;
}

/**
 * Can this read be trusted as an account of the run's canonical status?
 * `absent` can — there is nothing there, and every caller already fails closed
 * on a missing record. Nothing else can. Deliberately the same shape (and the
 * same argument) as override/token.ts's `overrideLedgerIllegible`.
 */
export function runSettlementIllegible(kind: RunSettlementLegibility): boolean {
  return kind !== 'ok' && kind !== 'absent';
}

/**
 * The check id a run carries FOREVER once its canonical record was found
 * illegible, and the reason `verified` is refused for it.
 *
 * Carried in `incompleteChecks`, i.e. inside the hashed record, so removing it
 * breaks the digest — which makes the record illegible again and puts it back.
 * That is exactly as strong as everything else here and no stronger: anything
 * that can write the project tree can forge a whole settlement (`settlementHash`
 * is an UNKEYED digest), which is this product's pre-existing evidence-forgery
 * floor. What the marker buys is that DAMAGING a record is no longer a way to
 * launder one — the run comes back drivable and permanently uncertifiable.
 */
export const SETTLEMENT_RECORD_ILLEGIBLE_CHECK = 'settlement-record-illegible';

/** Where illegible bytes are preserved before the record is rebuilt. The same
 *  `.corrupt` spelling state/normalize.ts uses for a torn `.one.json` and
 *  projection.ts uses for a torn `run.json`, so an operator finding one beside a
 *  run directory does not have to learn a third convention. */
export const ILLEGIBLE_SETTLEMENT_SUFFIX = '.corrupt';

export function runSettlementQuarantinePath(projectRoot: string, runId: string): string {
  return `${runSettlementPath(projectRoot, safeRunId(runId))}${ILLEGIBLE_SETTLEMENT_SUFFIX}`;
}

/**
 * BOTH HALVES, wherever a wedged run is printed — the whole of the
 * operator-facing half of the fail-closed writer, and the reason it is a
 * function rather than a sentence typed twice.
 *
 * A wedged run has TWO records, and the escape that was measured out of the
 * wedge repairs only ONE of them: remove `run.json`, re-run `run-status
 * --status failed`, reset. An operator who does exactly that finds every later
 * settlement write still refused, because the damaged `settlement-v2.json` is
 * untouched — and nothing anywhere named it.
 *
 * LIVES HERE, in the module that owns the second record, rather than in the
 * doctor that first printed it: the reset runner refuses on the SAME wedge from
 * the other side ("repair or remove run.json first") and has to say the same
 * thing in the same words. A shared sentence is the only version of "one voice"
 * that survives one of the two being edited.
 */
export function bothRunRecordsRemedy(runId: string): string {
  return 'A wedged run has TWO records and both have to be checked: '
    + `\`.traffic-one/runs/${runId}/run.json\` (the ledger, which decides whether the run can be reset) and `
    + `\`.traffic-one/runs/${runId}/settlement-v2.json\` (the canonical status, which decides whether it can `
    + 'settle). Repairing or removing one and not the other leaves the run stuck in the other half: a '
    + 'repaired ledger over a damaged settlement still refuses to certify, and a repaired settlement under a '
    + 'corrupt ledger still refuses to reset.';
}

export function readRunSettlementResult(projectRoot: string, runId: string): RunSettlementRead {
  const id = safeRunId(runId);
  const read = readJsonResult<unknown>(runSettlementPath(projectRoot, id));
  if (read.kind === 'absent') return { kind: 'absent', settlement: null };
  if (read.kind === 'corrupt') return { kind: 'corrupt', settlement: null };
  if (read.kind === 'unreadable') return { kind: 'unreadable', settlement: null };
  const settlement = parseSettlement(read.value, id);
  return settlement ? { kind: 'ok', settlement } : { kind: 'malformed', settlement: null };
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
 * around it. (`liveRunIds` in the sense of a legible sweep: one whose run caps are
 * SUSPENDED never asks the liveness question at all, so it reports that list
 * empty while keeping every run anyway. Same outcome for this run, reached without
 * the reservation — and no consumer outside retention's own tests reads either
 * field, so the distinction is about reading the report, not about behaviour.)
 * Nothing clears the condition, because the only thing that would
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
  projectRunId: string,
  update: SettlementUpdate,
): RunSettlementV2 | null {
  if (!projectRunId.trim() || /[\\/]/.test(projectRunId)) return null;
  if (!runtimeVersionSatisfies(pluginVersion(), RUN_SETTLEMENT_MIN_RUNTIME_VERSION)) return null;
  // The canonical spelling, and the ONLY one used below — for the directory,
  // for the record's own `runId` field, and for every read this body makes. See
  // readRunSettlement: the path helper sanitises and the parser compares
  // exactly, so a body that mixed the raw id with the derived path wrote a
  // record its own reader could not match.
  const runId = safeRunId(projectRunId);
  if (!runId) return null;
  let written: RunSettlementV2 | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      // A previous record that EXISTS and does not parse is never treated as a
      // blank slate, and this is the one place the distinction between "no
      // settlement" and "a settlement I could not read" is acted on rather than
      // merely noted.
      //
      // WHAT IT CLOSES, measured: the terminal guard below reads `previous`
      // through a parser that answers `null` for any hash or shape damage, so an
      // intact `verified` settlement resisted being overwritten as `failed`
      // while the SAME record with one byte edited was overwritten at revision
      // 1. Immutability that one edit removes is not immutability, and the file
      // is inside the tree the attacker writes.
      //
      // HOW IT CLOSES IT, and the correction of a real cost rather than a
      // tightening of it. The first shape of this guard REFUSED the write
      // outright, which bought the property above at the price of a WEDGE: no
      // writer, including `failed` and `blocked`, could settle that run again.
      // MEASURED across 9 damaged record shapes x 7 ledger states, before and
      // after, at this writer: 32 of the 63 cells lost their canonical terminal
      // status that way — every damaged shape except a DIRECTORY planted at the
      // path (which no writer can replace either way) crossed with a V2 ledger
      // that is active or failed, and with a ledger that is itself corrupt or
      // empty. The escape that existed — remove `run.json`, `run-status --status
      // failed`, reset — worked only because a legacy/V1 ledger short-circuited
      // the sync before it ever reached this function, i.e. because the run
      // reported a status nothing had written. That is the laundering this lane
      // exists to prevent, so it cannot be the recovery story either.
      //
      // RE-MEASURED ACROSS BOTH LEDGER VERSIONS, because the account above was
      // taken on a V2 ledger and the two versions did not agree. One damaged
      // record, `run-status --status failed`, what the command reported and what
      // the canonical record said afterwards:
      //
      //   ledger      refusal-era               now
      //   V2 active   unavailable:settlement-   applied, canonical `failed`
      //               not-failed, canonical none
      //   V1 active   APPLIED, canonical none   applied, canonical `failed`
      //   absent      APPLIED, canonical none   applied, canonical `failed`
      //   corrupt     unavailable:ledger-       unavailable:ledger-corrupt,
      //               corrupt, canonical none   canonical `failed` once the
      //                                         ledger is repaired or removed
      //
      // The two APPLIED rows are the omission: the command reported success
      // having written nothing, which is worse than the refusal it was meant to
      // be measured against. Both versions now reach this writer and both end
      // with a canonical record that says what the operator was told. Whole
      // table, all three arms: 0 cells newly unable to settle or reset against
      // pristine HEAD, 22 that HEAD could not settle now settling.
      //
      // What replaces the refusal keeps the property and drops the wedge. The
      // illegible bytes are PRESERVED beside the record (`.corrupt`, the same
      // convention projection.ts uses for a torn `run.json`), the record is
      // rebuilt from this update, and the run is marked
      // `settlement-record-illegible` — permanently, because the marker is
      // carried forward below and lives inside the hashed record. So the run
      // stays drivable and resettable, and the ONE thing damaging a record could
      // ever have bought — reopening it toward `verified` — is exactly the thing
      // it can no longer buy. A quarantine that FAILS still refuses the write:
      // rebuilding over bytes we could not preserve would destroy the only copy
      // of what the record used to say, which is the same rule
      // `writeLegacyProjection` applies to a corrupt `run.json`.
      const record = readRunSettlementResult(projectRoot, runId);
      const previous = record.settlement;
      const illegibleNow = runSettlementIllegible(record.kind);
      if (illegibleNow && !quarantineIllegibleSettlement(projectRoot, runId)) return;
      // …and once, forever. `previous` is null on the pass that finds the
      // damage, so the marker has to be re-read from the record this writer
      // itself wrote afterwards, or the very next write would certify the run.
      const illegibleRecord = illegibleNow
        || Boolean(previous?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK));
      // Canonical terminal settlements are immutable TO THIS WRITER. A delayed
      // projection/reconciliation pass may have read an older active ledger,
      // but it must never reopen verified, failed, or blocked work.
      //
      // Not immutable to anything holding a text editor, and the qualifier is
      // load-bearing rather than pedantic: `settlementHash` is an UNKEYED digest
      // over the record with sorted keys, so a twenty-line script produces a
      // settlement this parser accepts, in any status it likes. Authenticity of
      // a `verified` certificate is a separate `settlementMac` (override/
      // settlement-mac.ts). What the refusal above adds is that damaging a
      // record no longer converts it into a blank slate. `--unblock` treats an
      // unsigned `verified` as planted.
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
      // …and the half the guard above structurally cannot cover: it reads the
      // ledger, so DELETING the ledger answered it with "no override was ever
      // minted" and the run settled `verified` with `reason=none`. Measured:
      // mint, `rm ~/.traffic-one/overrides/<projectKey>/overrides.jsonl`, green.
      //
      // `overrideEvidenceChecks` asks whether the record can still account for
      // itself — an illegible ledger, a snapshot no vouchable line names, a
      // signed mint counter ahead of the lines that remain (shared/override/
      // integrity.ts). Project-scoped, because none of the three can be pinned
      // to a run without trusting a field the same edit could have chosen.
      //
      // Scoped to CERTIFICATION exactly like the fallback-marker refusal above,
      // and for the same reason: every other status still publishes, the run
      // stays drivable, and only the claim "this run is verified" — a claim
      // about evidence — is refused while the evidence cannot be read.
      if (status === 'verified') {
        const overrideEvidenceGaps = overrideEvidenceChecks(projectRoot);
        if (overrideEvidenceGaps.length > 0) {
          status = 'validating';
          reason = overrideEvidenceGaps[0];
          incompleteChecks.push(...overrideEvidenceGaps);
        }
      }
      // The price of the repair for the two refusals above. An operator can
      // clear an incomplete override record by RECONCILING it — a signed,
      // append-only acknowledgement of the exact anomalous state, minted at a
      // terminal (shared/override/reconcile.ts) — and because an erased ledger
      // line took its runId with it, that acknowledgement names every run in
      // the project at that moment and permanently refuses certification for
      // each. Without it the repair would be the laundering: clear the finding,
      // certify the run the deleted line was hiding.
      //
      // Reported AFTER the gaps so a project with a fresh, repairable gap
      // names the gap rather than the older quarantine.
      if (status === 'verified' && runQuarantinedByOverrideReconciliation(projectRoot, runId)) {
        status = 'validating';
        reason = 'override-reconciliation-quarantined';
        incompleteChecks.push('override-reconciliation-quarantined');
      }
      // The price of no longer wedging on an illegible record, and the reason
      // dropping the refusal costs nothing an attacker wants. This run's
      // canonical record was found damaged at least once; nothing on disk can
      // say what it used to claim, so no later pass may claim it is verified.
      //
      // LAST of the certification refusals, so its `reason` wins: each block
      // above overwrites `reason` when it fires, and this is the only one an
      // operator cannot repair by fixing something else — a reconciliation
      // clears an override gap, and nothing clears this. The remedy is a fresh
      // run, which is what the doctor finding says.
      //
      // Every other status still publishes, exactly like the two override
      // refusals above: the run stays drivable, `failed`/`blocked` still settle,
      // and the reset runner still retires it.
      if (illegibleRecord) {
        incompleteChecks.push(SETTLEMENT_RECORD_ILLEGIBLE_CHECK);
        if (status === 'verified') {
          status = 'validating';
          reason = SETTLEMENT_RECORD_ILLEGIBLE_CHECK;
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
      const hashed: RunSettlementV2 = { ...withoutHash, settlementHash: settlementHash(withoutHash) };
      const settlementMac = hashed.status === 'verified'
        ? signVerifiedSettlement(projectRoot, hashed)
        : null;
      const candidate: RunSettlementV2 = settlementMac
        ? { ...hashed, settlementMac }
        : hashed;
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

/**
 * Move the illegible record aside so the rebuilt one does not destroy it.
 *
 * A RENAME, not a copy: the bytes are preserved without being read, which is
 * the only preservation available for the `unreadable` kind (EACCES, EISDIR) —
 * projection.ts's `.corrupt` copy reads its base first, so it can only preserve
 * `corrupt`, and refuses `unreadable` outright. That difference is why the
 * settlement can recover from a mode-000 record and `run.json` cannot.
 *
 * A SYMLINK at the path is left exactly where it is and refuses the whole
 * write, which is today's behaviour and must stay it: that path is the consent
 * fence's (fsjson.ts), moving the link aside would let this function write
 * through a planted one by clearing it first, and the replay corpus pins the
 * refusal. `movePath` refuses a link at either end for the same reason; the
 * `lstat` here is what keeps the decision explicit rather than incidental.
 *
 * An earlier quarantine IS overwritten, and deliberately: a second damage event
 * is damage to a record this writer already rebuilt, so the newest bytes are
 * the ones an operator is diagnosing. The permanent marker on the record
 * survives either way — it is what says damage happened at all.
 */
function quarantineIllegibleSettlement(projectRoot: string, runId: string): boolean {
  const file = runSettlementPath(projectRoot, runId);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    return movePath(file, runSettlementQuarantinePath(projectRoot, runId));
  } catch {
    // EACCES/ENOSPC on the rename. `movePath` reports a refusal as `false` and
    // rethrows a real errno; either way the bytes are still there and the write
    // above declines rather than replacing them.
    return false;
  }
}

export function digestExists(projectRoot: string, runId: string, names: string[]): boolean {
  return names.some((name) => {
    try {
      return readRegularFileOrThrow(path.join(projectRoot, '.traffic-one', 'digests', safeRunId(runId), name)).trim().length > 0;
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
