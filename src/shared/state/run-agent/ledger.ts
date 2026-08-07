// src/shared/state/run-agent/ledger.ts
// The run-ledger state machine: statuses/outcomes, transition legality,
// the ledger lock, and canonical settlement sync.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import {  ensureDir, readJson, readJsonResult,  writeJson } from '../../fsjson';
import { stateTimestamp } from '../io';
import {
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
} from '../materialization';
import {
  RUN_RESUME_AUTHORIZATION,
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
  projectRunLedgerForV2Rollback,
  readRunSettlement,
  writeRunSettlement,
  type CanonicalRunStatus,
} from '../../run-settlement';

import {
  invalidateRunLedgerFingerprint,
  runDir,
  runLedgerFile,
  runLedgerFingerprint,
} from './run-paths';
import {
  withOwnedDirLock,
  withOwnedDirLockResult,
} from './locks';
import {
  applied,
  mutationApplied,
  mutationValue,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';
import { runCompletionEvidenceAllows } from './terminal-verdict';

const RUN_LEDGER_TRANSITION_HISTORY_LIMIT = 32;

export type RunLedgerStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'failed';
export type RunLedgerOutcome =
  | 'verified'
  | 'shipped'
  | 'review-cycle-cap'
  | 'test-cycle-cap'
  | 'environment-blocked'
  | 'agent-failed';

interface RunLedgerTransitionOptions {
  status: RunLedgerStatus;
  outcome?: RunLedgerOutcome;
  reason?: string;
  kind?: string;
  stackFingerprint?: string;
  qaContractVersion?: 1 | 2;
  /** Internal compatibility path for terminal settlement of a pre-ledger run. */
  preserveLegacyQaContract?: boolean;
}

const RUN_LEDGER_STATUSES = new Set<RunLedgerStatus>(['planned', 'active', 'completed', 'blocked', 'failed']);
const RUN_LEDGER_OUTCOMES = new Set<RunLedgerOutcome>([
  'verified',
  'shipped',
  'review-cycle-cap',
  'test-cycle-cap',
  'environment-blocked',
  'agent-failed',
]);
const RUN_LEDGER_LOCK_TIMEOUT_MS = 2_000;
const RUN_LEDGER_LOCK_STALE_MS = 15_000;
const RUN_LEDGER_LOCK_RETRY_MS = 10;
const RUN_LEDGER_WAIT = new Int32Array(new SharedArrayBuffer(4));

export function isRunLedgerStatus(value: unknown): value is RunLedgerStatus {
  return typeof value === 'string' && RUN_LEDGER_STATUSES.has(value as RunLedgerStatus);
}

export function isRunLedgerOutcome(value: unknown): value is RunLedgerOutcome {
  return typeof value === 'string' && RUN_LEDGER_OUTCOMES.has(value as RunLedgerOutcome);
}

function isTerminalRunLedgerStatus(status: RunLedgerStatus): boolean {
  return status === 'completed' || status === 'blocked' || status === 'failed';
}

function runLedgerTransitionAllowed(from: RunLedgerStatus, to: RunLedgerStatus, reason: unknown): boolean {
  if (from === to) return true;
  if (from === 'planned') return to === 'active' || to === 'blocked' || to === 'failed' || to === 'completed';
  if (from === 'active') return to === 'completed' || to === 'blocked' || to === 'failed';
  if (from === 'blocked') return to === 'active' && reason === RUN_RESUME_AUTHORIZATION;
  return false;
}

// Did the record just persisted actually END on a user-authorized
// `blocked -> active` resume? Read from the immutable transition entry rather
// than the caller's request, so only a transition this state machine already
// accepted can unlock the canonical settlement's blocked edge. This works
// because `writeRunLedgerTransition` deletes `next.reason` but keeps it on the
// history entry — the history entry is the only durable proof.
function ledgerRecordsAuthorizedResume(ledger: Rec): boolean {
  const history = Array.isArray(ledger.transitionHistory) ? ledger.transitionHistory : [];
  const last = obj(history[history.length - 1]);
  return last?.from === 'blocked'
    && last?.to === 'active'
    && last?.reason === RUN_RESUME_AUTHORIZATION;
}

/**
 * Can a worker claim be staked in this run RIGHT NOW? Mirrors exactly what
 * ensureRunAgentClaim/claimThreadRole attempt — `ensureRunLedger({status:
 * 'active'})` with no resume reason — so callers can tell "this agent is
 * unusable because the run itself is closed" from "this agent is healthy".
 * A missing ledger reads as `planned`, which admits claims.
 *
 * Three-valued, because the boolean below cannot say the third thing and the
 * mirror it claims is BROKEN for exactly that case. `readJson(…, null)` gave a
 * corrupt or unreadable ledger the same `null` an absent one gets, so the
 * predicate answered `admits` — while the attempt it mirrors returns
 * `unavailable('ledger-corrupt')` from writeRunLedgerTransition's own illegible
 * read. Measured: predicate `true`, attempt `unavailable`, on the same file.
 *
 * The consequence is misrouted DIAGNOSIS, not a stakeable claim. Both prose
 * consumers (codex-child-model.ts, plan-runteam.ts/plan-readiness) probe
 * "closed ledger" FIRST precisely because it is the one cause no respawn can
 * fix; an illegible ledger answers `admits`, falls past that probe, and inherits
 * a RETRY prescription for a condition retrying cannot clear.
 *
 * Both invariants this function has always had are preserved deliberately:
 *   - NO LOCK anywhere in its body, so it can never itself be blocked and can
 *     never convert one answer into the other. `readJsonResult` is a bare
 *     `readFileSync`, exactly as `readJson` was.
 *   - it still reads through `effectiveLegacyRunStatus`, so a barrier-protected
 *     run that is physically `failed` on disk but canonically active is not
 *     misreported as closed.
 */
export type RunLedgerClaimAdmission = 'admits' | 'closed' | 'unknown';

export function runLedgerClaimAdmission(cwd: string, runId: unknown): RunLedgerClaimAdmission {
  if (typeof runId !== 'string' || !runId.trim()) return 'closed';
  const read = readJsonResult<Rec>(runLedgerFile(cwd, runId.trim()));
  if (read.kind === 'corrupt' || read.kind === 'unreadable') return 'unknown';
  const ledger = read.kind === 'ok' ? obj(read.value) : null;
  const effective = effectiveLegacyRunStatus(ledger);
  const status = isRunLedgerStatus(effective) ? effective : 'planned';
  return runLedgerTransitionAllowed(status, 'active', undefined) ? 'admits' : 'closed';
}

// `unknown` keeps admitting, and that is the deliberate half. This boolean's
// consumers are GATES over a child's life — model-rotation.ts condemns a
// claimless agent in a non-admitting run as `unbindable-agent` and replaces it —
// and a gate that strands or destroys a HEALTHY child on a file it merely could
// not read fails in the one direction that is not recoverable. Behaviour is
// therefore byte-identical to the `readJson(…, null)` form this replaced; the
// ignorance is now merely NAMEABLE by a caller in the other class.
export function runLedgerAdmitsClaims(cwd: string, runId: unknown): boolean {
  return runLedgerClaimAdmission(cwd, runId) !== 'closed';
}

function outcomeAllowedForStatus(status: RunLedgerStatus, outcome: RunLedgerOutcome | undefined): boolean {
  if (!outcome) return status === 'planned' || status === 'active';
  if (status === 'completed') return outcome === 'verified' || outcome === 'shipped';
  if (status === 'blocked') {
    return outcome === 'review-cycle-cap' || outcome === 'test-cycle-cap' || outcome === 'environment-blocked';
  }
  return status === 'failed' && outcome === 'agent-failed';
}

function terminalOutcomeTransitionAllowed(
  status: RunLedgerStatus,
  previous: RunLedgerOutcome | undefined,
  requested: RunLedgerOutcome | undefined,
): boolean {
  if (previous === requested || previous === undefined) return true;
  // A verified run may later be shipped without reopening it. Other terminal
  // outcomes are immutable so replay or reconciliation cannot rewrite history.
  return status === 'completed' && previous === 'verified' && requested === 'shipped';
}

function runLedgerHistory(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(obj).slice(-RUN_LEDGER_TRANSITION_HISTORY_LIMIT);
}

function runLedgerLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.run-ledger.lock');
}

export function withRunLedgerLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    runLedgerLockDir(cwd, runId),
    RUN_LEDGER_LOCK_TIMEOUT_MS,
    RUN_LEDGER_LOCK_STALE_MS,
    RUN_LEDGER_LOCK_RETRY_MS,
    RUN_LEDGER_WAIT,
    mutate,
  );
}

export function withRunLedgerLockResult<T>(
  cwd: string,
  runId: string,
  mutate: () => MutationResult<T>,
): MutationResult<T> {
  return withOwnedDirLockResult(
    runLedgerLockDir(cwd, runId),
    RUN_LEDGER_LOCK_TIMEOUT_MS,
    RUN_LEDGER_LOCK_STALE_MS,
    RUN_LEDGER_LOCK_RETRY_MS,
    RUN_LEDGER_WAIT,
    mutate,
  );
}

/**
 * The state machine's own verdict, three-valued. Its `null` used to mean four
 * different things — an illegal transition, a disallowed outcome, missing
 * completion evidence, and a refused/failed write — and only the first three are
 * decisions. The fourth is "we could not record it", which is what a caller has
 * to be able to retry or deny on.
 */
function writeRunLedgerTransition(
  cwd: string,
  id: string,
  patch: Rec,
  options: { requireValidTransition: boolean },
): MutationResult<Rec> {
  const now = stateTimestamp();
  // The `|| {}` this replaces is the load-bearing one: it made a ledger file we
  // could not READ indistinguishable from one that does not EXIST, and the two
  // license opposite things. An absent ledger is genuinely new, so `isNew` and a
  // `planned` current status are true statements about it. For a file that is
  // there and unreadable they are FABRICATIONS, and every guard below is then
  // evaluated against the fabrication: `planned` is the one status
  // `runLedgerTransitionAllowed` lets everything out of, so `completed` and
  // `failed` — the two it lets NOTHING out of — become resumable; `isNew` forces
  // `qaContractVersion: 1`, silently downgrading a V2 run's QA contract; and
  // `{...existing}` then republishes the record with `createdAt`,
  // `transitionHistory`, `outcome` and `finishedAt` gone.
  //
  // Neither kind heals here, and refusing destroys nothing. `unavailable`, not
  // `precondition-failed`: nothing was decided and nothing was written, we
  // simply could not find out — which is the retry-then-deny contract
  // mutation-result.ts prescribes for ledger transitions. The cost is that a run
  // with an unreadable ledger admits no transition until the file is repaired or
  // removed, and a fresh run can always be minted; the cost of the fabrication
  // was a terminal run quietly reopening with its own evidence erased.
  const read = readJsonResult<Rec>(runLedgerFile(cwd, id));
  if (read.kind === 'corrupt' || read.kind === 'unreadable') return unavailable(`ledger-${read.kind}`);
  const existing = (read.kind === 'ok' ? obj(read.value) : null) || {};
  const isNew = Object.keys(existing).length === 0;
  const effectiveStatus = effectiveLegacyRunStatus(existing);
  const currentStatus = isRunLedgerStatus(effectiveStatus) ? effectiveStatus : 'planned';
  const requestedStatus = isRunLedgerStatus(patch.status) ? patch.status : currentStatus;
  const reason = typeof patch.reason === 'string' ? patch.reason : undefined;
  if (options.requireValidTransition && !runLedgerTransitionAllowed(currentStatus, requestedStatus, reason)) {
    return preconditionFailed(`illegal-transition-${currentStatus}-to-${requestedStatus}`);
  }

  const effectiveOutcome = effectiveLegacyRunOutcome(existing);
  const priorOutcome = isRunLedgerOutcome(effectiveOutcome) ? effectiveOutcome : undefined;
  const requestedOutcome = isRunLedgerOutcome(patch.outcome)
    ? patch.outcome
    : (requestedStatus === currentStatus ? priorOutcome : undefined);
  if (options.requireValidTransition && !outcomeAllowedForStatus(requestedStatus, requestedOutcome)) {
    return preconditionFailed(`outcome-not-allowed-for-${requestedStatus}`);
  }
  if (options.requireValidTransition
    && requestedStatus === currentStatus
    && !terminalOutcomeTransitionAllowed(requestedStatus, priorOutcome, requestedOutcome)) {
    return preconditionFailed('terminal-outcome-immutable');
  }
  if (options.requireValidTransition && requestedStatus === 'completed') {
    const idempotentTerminal = currentStatus === 'completed' && requestedOutcome === priorOutcome;
    if (!idempotentTerminal && !runCompletionEvidenceAllows(cwd, id, requestedOutcome)) {
      return preconditionFailed('completion-evidence-missing');
    }
  }

  const createdAt = typeof existing.createdAt === 'string' && existing.createdAt ? existing.createdAt : now;
  const statusChanged = isNew || requestedStatus !== currentStatus;
  const outcomeChanged = requestedOutcome !== priorOutcome;
  const transitionChanged = statusChanged || outcomeChanged;
  const history = runLedgerHistory(existing.transitionHistory);
  if (transitionChanged) {
    history.push({
      from: isNew ? null : currentStatus,
      to: requestedStatus,
      at: now,
      ...(requestedOutcome ? { outcome: requestedOutcome } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  const existingQaContractVersion = existing.qaContractVersion === 2
    ? 2
    : existing.qaContractVersion === 1
      ? 1
      : undefined;
  const requestedQaContractVersion = patch.qaContractVersion === 2
    ? 2
    : patch.qaContractVersion === 1
      ? 1
      : undefined;
  const resumesLegacyRun = !isNew && existingQaContractVersion === undefined && requestedStatus === 'active';
  const preserveLegacyQaContract = isNew && patch.preserveLegacyQaContract === true;
  const qaContractVersion = existingQaContractVersion === 2 || requestedQaContractVersion === 2
    ? 2
    : existingQaContractVersion === 1
      || requestedQaContractVersion === 1
      || (isNew && !preserveLegacyQaContract)
      || resumesLegacyRun
      ? 1
      : undefined;
  const activatesQaContract = qaContractVersion !== undefined && (
    existingQaContractVersion !== qaContractVersion
    || (requestedStatus === 'active' && currentStatus !== 'active')
  );
  const next: Rec = {
    ...existing,
    ...patch,
    version: qaContractVersion === 2
      ? 2
      : (typeof existing.version === 'number' ? existing.version : 1),
    runId: typeof existing.runId === 'string' && existing.runId ? existing.runId : id,
    status: requestedStatus,
    kind: typeof patch.kind === 'string' && patch.kind
      ? patch.kind
      : (typeof existing.kind === 'string' && existing.kind ? existing.kind : 'planned'),
    createdAt,
    statusUpdatedAt: transitionChanged
      ? now
      : (typeof existing.statusUpdatedAt === 'string' && existing.statusUpdatedAt ? existing.statusUpdatedAt : createdAt),
    transitionHistory: history.slice(-RUN_LEDGER_TRANSITION_HISTORY_LIMIT),
    updatedAt: now,
  };
  if (qaContractVersion !== undefined) next.qaContractVersion = qaContractVersion;
  else delete next.qaContractVersion;
  if (qaContractVersion !== undefined) {
    next.qaContractActivatedAt = activatesQaContract
      // Lifecycle timestamps intentionally retain legacy whole-second precision;
      // QA freshness needs milliseconds so evidence created just before a resume
      // in the same second cannot slip past the activation boundary.
      ? new Date().toISOString()
      : (typeof existing.qaContractActivatedAt === 'string' && existing.qaContractActivatedAt
        ? existing.qaContractActivatedAt
        : createdAt);
  } else {
    delete next.qaContractActivatedAt;
  }
  delete next.preserveLegacyQaContract;
  // Resume authorization belongs to the immutable transition entry, not to the
  // ledger's mutable top level where a later write could make it look current.
  delete next.reason;

  if (requestedOutcome) next.outcome = requestedOutcome;
  else delete next.outcome;
  if (isTerminalRunLedgerStatus(requestedStatus)) {
    next.finishedAt = typeof existing.finishedAt === 'string' && existing.finishedAt && !statusChanged
      ? existing.finishedAt
      : now;
  } else {
    delete next.finishedAt;
  }
  const canonicalStatus: CanonicalRunStatus = requestedStatus === 'completed'
    ? 'verified'
    : requestedStatus;
  // Never expose a raw resumable status for a V2 run, even for the brief window
  // between this atomic ledger write and canonical settlement reconciliation.
  // A process crash at the next instruction must still be rollback-safe.
  const persisted = qaContractVersion === 2
    ? projectRunLedgerForV2Rollback(
        next,
        canonicalStatus,
        requestedOutcome,
      )
    : next;
  try {
    // A refused run dir is not an error, but it IS a failed transition, and it
    // must be reported as one: without this branch the function would return
    // `next` — a state machine result no reader can ever load, which is how a
    // run gets announced as active while its ledger does not exist.
    if (!ensureDir(runDir(cwd, id))) {
      invalidateRunLedgerFingerprint(cwd, id);
      return unavailable('run-dir-refused');
    }
    // …and the same hazard one line lower, which the dir check does NOT cover.
    // Its comment used to justify itself by saying writeJson "stands down
    // silently (it returns void)" — true when written, false since writeJson
    // started reporting. A refused FILE with a permitted dir is exactly what a
    // symlink planted at `settlement-v2.json` produces (the consent fence
    // refuses both together, but the symlink fence refuses only the file), and
    // it returned a fully-formed ledger record for a file that was never
    // written.
    if (!writeJson(runLedgerFile(cwd, id), persisted)) {
      invalidateRunLedgerFingerprint(cwd, id);
      return unavailable('ledger-write-refused');
    }
    invalidateRunLedgerFingerprint(cwd, id);
    return applied(next);
  } catch {
    invalidateRunLedgerFingerprint(cwd, id);
    return unavailable('ledger-write-failed');
  }
}

// True while `currentRunId` names a run that is still planned or active. Such a
// run OWNS the project's stack identity: re-detection may refresh materialized
// assets, but it must not re-stamp `stack`/`frontend`/`backend`, because the
// live team's claims are pinned to the identity the run was minted with.
export function runIdentityFrozen(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId.trim() : '';
  if (!runId) return false;
  const read = readJsonResult<Rec>(runLedgerFile(cwd, runId));
  // The SAME ignorance runLedgerClaimAdmission reports, answered the OPPOSITE
  // way, because this caller spends its `false` on permission rather than on a
  // gate. `readJson(…, null)` collapsed corrupt/unreadable into the absent
  // ledger's `null`, so an illegible ledger returned `false` — and the sole
  // consumer (onboarding/detection-stamp.ts) reads `false` as licence to
  // overwrite `stack`/`backend`/`frontend` with a live re-detection, which is
  // precisely the re-stamp the comment above exists to prevent. It also skips
  // `recordRunStackDrift`, so the overwrite leaves no record either.
  //
  // Measured: a run driven to `active`, its `run.json` then truncated mid-write,
  // went from frozen to NOT frozen while the team was still inside it.
  //
  // Refusing costs a re-stamp that can always happen on the next run, and the
  // drift record it would have written is unavailable anyway (recordRunStackDrift
  // reads the same file for the frozen fingerprint and bails with
  // `no-frozen-identity`). An ABSENT ledger is untouched and still reads as not
  // frozen: nothing is on disk to be in flight, which is a true statement.
  if (read.kind === 'corrupt' || read.kind === 'unreadable') return true;
  const ledger = read.kind === 'ok' ? obj(read.value) : null;
  if (!ledger) return false;
  const status = effectiveLegacyRunStatus(ledger);
  return status === 'planned' || status === 'active';
}

const RUN_STACK_DRIFT_HISTORY_LIMIT = 8;

// Record that detection now reports a different identity than the one this run
// froze. Never rewrites `stackFingerprint` — the whole point is that the run
// keeps the identity it was minted with. The entry is diagnostic and tells the
// next run what to mint with.
// ADVISORY (see mutation-result.ts's split rule): a lost drift entry costs the
// NEXT run a hint about what to mint with, and nothing in this run reads it. Its
// caller is a detection pass on the session path, which must never fail a
// session over a diagnostic — so `unavailable` here is reported, never enforced.
export function recordRunStackDriftResult(
  cwd: string,
  state: unknown,
  observed: string,
): MutationResult<void> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId.trim() : '';
  if (!runId || !observed || observed === UNKNOWN_STACK_FINGERPRINT) return preconditionFailed('no-observed-identity');
  const frozen = runLedgerFingerprint(cwd, runId);
  if (!frozen) return preconditionFailed('no-frozen-identity');
  if (frozen === observed) return preconditionFailed('no-drift');
  // Fix #7 of the eleven: this lock result was discarded, so a contended ledger
  // lock and an already-recorded drift both left `wrote` false.
  return withRunLedgerLockResult<void>(cwd, runId, () => {
    const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
    if (!ledger) return preconditionFailed('no-ledger');
    const history = Array.isArray(ledger.stackDriftHistory)
      ? ledger.stackDriftHistory.filter(obj)
      : [];
    const last = history[history.length - 1] as Rec | undefined;
    if (last && last.observed === observed) return preconditionFailed('drift-already-recorded');
    history.push({ from: frozen, observed, at: stateTimestamp() });
    try {
      // Was `wrote = true` regardless of what writeJson answered, so a refused
      // ledger file reported a recorded drift that is not on disk.
      const wrote = writeJson(runLedgerFile(cwd, runId), {
        ...ledger,
        stackDriftHistory: history.slice(-RUN_STACK_DRIFT_HISTORY_LIMIT),
      });
      invalidateRunLedgerFingerprint(cwd, runId);
      return wrote ? applied(undefined) : unavailable('drift-write-refused');
    } catch {
      // Diagnostic only — never fail a session on it.
      return unavailable('drift-write-failed');
    }
  });
}

export function recordRunStackDrift(cwd: string, state: unknown, observed: string): boolean {
  return mutationApplied(recordRunStackDriftResult(cwd, state, observed));
}

export function ensureRunLedgerResult(cwd: string, runId: unknown, patch: Rec = {}): MutationResult<Rec> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  if (typeof runId !== 'string' || !runId.trim()) return preconditionFailed('no-run-id');
  const id = runId.trim();
  const result = withRunLedgerLockResult(cwd, id, () => (
    writeRunLedgerTransition(cwd, id, patch, { requireValidTransition: true })
  ));
  if (result.outcome !== 'applied' || !result.value) return result;
  syncCanonicalSettlementFromLedger(cwd, id, result.value, isRunLedgerStatus(patch.status));
  return result;
}

export function ensureRunLedger(cwd: string, runId: unknown, patch: Rec = {}): Rec | null {
  return mutationValue(ensureRunLedgerResult(cwd, runId, patch));
}

// The single status-mutation entry point for orchestration settlement. Replaying
// the same terminal transition is idempotent; a blocked run may become active only
// after the parent records the exact user-authorized resume reason.
export function transitionRunStatusResult(
  cwd: string,
  runId: unknown,
  options: RunLedgerTransitionOptions,
): MutationResult<Rec> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  if (typeof runId !== 'string' || !runId.trim()) return preconditionFailed('no-run-id');
  const id = runId.trim();
  const written = withRunLedgerLockResult(cwd, id, () => (
    writeRunLedgerTransition(cwd, id, options as unknown as Rec, { requireValidTransition: true })
  ));
  if (written.outcome !== 'applied' || !written.value) return written;
  const result = written.value;
  // Two independent conjuncts: the caller must ASK for the authorized resume,
  // and the persisted ledger must SHOW the state machine granted it. A stale
  // reconciliation pass satisfies neither.
  const resumeAuthorized = options.status === 'active'
    && options.reason === RUN_RESUME_AUTHORIZATION
    && ledgerRecordsAuthorizedResume(result);
  const settlement = syncCanonicalSettlementFromLedger(cwd, id, result, true, resumeAuthorized);
  // The ledger write and the canonical settlement write are two different files.
  // A settlement that did NOT reach the requested canonical status means the run
  // did not advance: writeLegacyProjection has already re-projected run.json from
  // the settlement, so returning the ledger record hands the caller a success the
  // very next read contradicts (observed 10co on an authorized resume).
  //
  // `unavailable`, not `precondition-failed`: the ledger's own state machine
  // ACCEPTED this transition and the ledger file now records it, so nothing here
  // is a decision — the second of two files did not follow, and the run is left
  // internally inconsistent. That is a retry-then-deny case, and reporting it as
  // a precondition would tell a caller the run refused something it did not.
  const requested: CanonicalRunStatus = options.status === 'completed' ? 'verified' : options.status;
  if (settlement !== requested) return unavailable(`settlement-not-${requested}`);
  return applied(result);
}

export function transitionRunStatus(
  cwd: string,
  runId: unknown,
  options: RunLedgerTransitionOptions,
): Rec | null {
  return mutationValue(transitionRunStatusResult(cwd, runId, options));
}

function syncCanonicalSettlementFromLedger(
  cwd: string,
  runId: string,
  ledger: Rec,
  explicitStatus: boolean,
  authorizedResume = false,
): CanonicalRunStatus | null {
  const ledgerStatus = isRunLedgerStatus(ledger.status) ? ledger.status : 'planned';
  const previous = readRunSettlement(cwd, runId);
  let status: CanonicalRunStatus = ledgerStatus === 'completed'
    ? 'verified'
    : ledgerStatus === 'failed'
      ? 'failed'
      : ledgerStatus === 'blocked'
        ? 'blocked'
        : ledgerStatus;

  // Do not silently opt a legacy/V1 ledger into the V2 canonical lifecycle.
  // Those runs retain their historical verification semantics until an
  // explicit V2 contract activation. Newly planned Traffic One runs set
  // qaContractVersion=2 before implementation; existing V2 sidecars continue
  // to reconcile idempotently.
  if (ledger.qaContractVersion !== 2 && !previous) return status;

  // A metadata-only legacy-ledger refresh must not regress a richer canonical
  // lifecycle stage that was already written by the OpenCode runner/verifier.
  // Only `ensureRunLedger` passes `explicitStatus: false`; `transitionRunStatus`
  // always passes true, so its strict post-sync status check never sees a clamp.
  if (!explicitStatus
    && status === 'active'
    && (previous?.status === 'code-delivered' || previous?.status === 'validating')) {
    status = previous.status;
  }

  let fallback = previous?.fallback;
  if (fallback?.state === 'pending' && status === 'verified') {
    fallback = { ...fallback, state: 'completed' };
  } else if (fallback?.state === 'pending' && (status === 'failed' || status === 'blocked')) {
    fallback = { ...fallback, state: 'not-allowed' };
  }

  const incompleteChecks = status === 'verified' || status === 'failed' || status === 'blocked'
    ? []
    : previous?.incompleteChecks || [];
  const outcome = isRunLedgerOutcome(ledger.outcome) ? ledger.outcome : undefined;
  const settlement = writeRunSettlement(cwd, runId, {
    status,
    ...(outcome ? { reason: outcome } : {}),
    ...(previous?.workUnitContractHash ? { workUnitContractHash: previous.workUnitContractHash } : {}),
    ...(previous?.allowlistHash ? { allowlistHash: previous.allowlistHash } : {}),
    ...(fallback ? { fallback } : {}),
    ...(authorizedResume && status === 'active'
      ? { authorizedResume: RUN_RESUME_AUTHORIZATION }
      : {}),
    incompleteChecks,
  });
  return settlement?.status || null;
}

