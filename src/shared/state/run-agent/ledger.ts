// src/shared/state/run-agent/ledger.ts
// The run-ledger state machine: statuses/outcomes, transition legality,
// the ledger lock, and canonical settlement sync.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { parseJson, readJson, readText, writeJson } from '../../fsjson';
import { stateTimestamp } from '../io';
import {
  activeAgentRole,
  getSpawnIndex,
  isSubagentSession,
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
} from '../materialization';
import {
  activeRunClaimCount,
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
} from './locks';
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
  if (from === 'blocked') return to === 'active' && reason === 'user-authorized-extra-cycle';
  return false;
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

function writeRunLedgerTransition(
  cwd: string,
  id: string,
  patch: Rec,
  options: { requireValidTransition: boolean },
): Rec | null {
  const now = stateTimestamp();
  const existing = obj(readJson(runLedgerFile(cwd, id), null)) || {};
  const isNew = Object.keys(existing).length === 0;
  const effectiveStatus = effectiveLegacyRunStatus(existing);
  const currentStatus = isRunLedgerStatus(effectiveStatus) ? effectiveStatus : 'planned';
  const requestedStatus = isRunLedgerStatus(patch.status) ? patch.status : currentStatus;
  const reason = typeof patch.reason === 'string' ? patch.reason : undefined;
  if (options.requireValidTransition && !runLedgerTransitionAllowed(currentStatus, requestedStatus, reason)) return null;

  const effectiveOutcome = effectiveLegacyRunOutcome(existing);
  const priorOutcome = isRunLedgerOutcome(effectiveOutcome) ? effectiveOutcome : undefined;
  const requestedOutcome = isRunLedgerOutcome(patch.outcome)
    ? patch.outcome
    : (requestedStatus === currentStatus ? priorOutcome : undefined);
  if (options.requireValidTransition && !outcomeAllowedForStatus(requestedStatus, requestedOutcome)) return null;
  if (options.requireValidTransition
    && requestedStatus === currentStatus
    && !terminalOutcomeTransitionAllowed(requestedStatus, priorOutcome, requestedOutcome)) return null;
  if (options.requireValidTransition && requestedStatus === 'completed') {
    const idempotentTerminal = currentStatus === 'completed' && requestedOutcome === priorOutcome;
    if (!idempotentTerminal && !runCompletionEvidenceAllows(cwd, id, requestedOutcome)) return null;
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
    fs.mkdirSync(runDir(cwd, id), { recursive: true });
    writeJson(runLedgerFile(cwd, id), persisted);
    invalidateRunLedgerFingerprint(cwd, id);
    return next;
  } catch {
    invalidateRunLedgerFingerprint(cwd, id);
    return null;
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
  const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
  if (!ledger) return false;
  const status = effectiveLegacyRunStatus(ledger);
  return status === 'planned' || status === 'active';
}

const RUN_STACK_DRIFT_HISTORY_LIMIT = 8;

// Record that detection now reports a different identity than the one this run
// froze. Never rewrites `stackFingerprint` — the whole point is that the run
// keeps the identity it was minted with. The entry is diagnostic and tells the
// next run what to mint with.
export function recordRunStackDrift(cwd: string, state: unknown, observed: string): boolean {
  if (isNonProjectRoot(cwd)) return false;
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId.trim() : '';
  if (!runId || !observed || observed === UNKNOWN_STACK_FINGERPRINT) return false;
  const frozen = runLedgerFingerprint(cwd, runId);
  if (!frozen || frozen === observed) return false;
  let wrote = false;
  withRunLedgerLock(cwd, runId, () => {
    const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
    if (!ledger) return;
    const history = Array.isArray(ledger.stackDriftHistory)
      ? ledger.stackDriftHistory.filter(obj)
      : [];
    const last = history[history.length - 1] as Rec | undefined;
    if (last && last.observed === observed) return; // already recorded
    history.push({ from: frozen, observed, at: stateTimestamp() });
    try {
      writeJson(runLedgerFile(cwd, runId), {
        ...ledger,
        stackDriftHistory: history.slice(-RUN_STACK_DRIFT_HISTORY_LIMIT),
      });
      invalidateRunLedgerFingerprint(cwd, runId);
      wrote = true;
    } catch {
      // Diagnostic only — never fail a session on it.
    }
  });
  return wrote;
}

export function ensureRunLedger(cwd: string, runId: unknown, patch: Rec = {}): Rec | null {
  if (isNonProjectRoot(cwd)) return null;
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const id = runId.trim();
  let result: Rec | null = null;
  const locked = withRunLedgerLock(cwd, id, () => {
    result = writeRunLedgerTransition(cwd, id, patch, { requireValidTransition: true });
  });
  if (!locked || !result) return null;
  syncCanonicalSettlementFromLedger(cwd, id, result, isRunLedgerStatus(patch.status));
  return result;
}

// The single status-mutation entry point for orchestration settlement. Replaying
// the same terminal transition is idempotent; a blocked run may become active only
// after the parent records the exact user-authorized resume reason.
export function transitionRunStatus(
  cwd: string,
  runId: unknown,
  options: RunLedgerTransitionOptions,
): Rec | null {
  if (isNonProjectRoot(cwd)) return null;
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const id = runId.trim();
  let result: Rec | null = null;
  const locked = withRunLedgerLock(cwd, id, () => {
    result = writeRunLedgerTransition(cwd, id, options as unknown as Rec, { requireValidTransition: true });
  });
  if (!locked || !result) return null;
  const settlement = syncCanonicalSettlementFromLedger(cwd, id, result, true);
  if (options.status === 'completed' && settlement !== 'verified') return null;
  return result;
}

function syncCanonicalSettlementFromLedger(
  cwd: string,
  runId: string,
  ledger: Rec,
  explicitStatus: boolean,
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
    incompleteChecks,
  });
  return settlement?.status || null;
}

