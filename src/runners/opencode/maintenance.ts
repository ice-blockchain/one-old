// src/runners/opencode/maintenance.ts
// Maintenance contract preflight and delegation outcome recording.

import * as fs from 'fs';
import * as path from 'path';
import {
  parseAllowedFiles,
} from '../../shared/opencode-queue';
import { isMaintenancePhase } from '../../shared/state';
import {
  ensureRunBootstrap,
  readActiveRunBootstrap,
  type RunBootstrapEnvelopeV2,
} from '../../shared/run-bootstrap-policy';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { readRunHostCapability } from '../../shared/host/capabilities';
import {
  captureMaintenanceFallbackBaseline,
  fallbackSourcePaths,
  workUnitAllowlistHash,
} from '../../shared/maintenance/fallback';
import { projectMaintenanceMarker } from '../../shared/maintenance/fallback-proof';
import { readJson, writeJson } from '../../shared/fsjson';
import { isMaintenanceTerminal } from '../../shared/maintenance/terminal';
import { writeRunSettlement } from '../../shared/run-settlement';

import {
  T1_DIR,
  type DelegateResult,
  type FailureKind,
  type Rec,
} from './types';

export function classifyFailureKind(action: DelegateResult['action'], error: string | null): FailureKind | undefined {
  if (action === 'delegated') return undefined;
  if (action === 'skipped') return 'skipped';
  if (action === 'no-changes') return 'no-changes';
  const msg = error || '';
  if (/\bETIMEDOUT\b|timed out|stalled/i.test(msg)) return 'provider-timeout';
  // Post-apply VERIFICATION failures are not scope rejections. All three used to
  // fall through to `diff-rejected` — indistinguishable from "wrote outside its
  // allowlist" — while their status was `failed`, so the two fields contradicted
  // each other and a real quality signal read as a policy violation.
  if (/typecheck failed|landed collapsed source|styling system the project does not have|landed an oversized module/i.test(msg)) {
    return 'verification-failed';
  }
  if (/outside|apply|delegated diff|assignment scope|generated\/internal/i.test(msg)) return 'diff-rejected';
  if (/opencode/i.test(msg)) return 'opencode-error';
  return 'environment';
}

function bootstrapRole(role: string): string {
  if (role.startsWith('senior-') || role === 'quick-fix') return role;
  if (role === 'frontend') return 'senior-frontend';
  if (role === 'backend') return 'senior-backend';
  if (role === 'tester') return 'senior-tester';
  if (role === 'docs') return 'senior-architect';
  return role;
}

interface MaintenanceContractPreflight {
  required: boolean;
  bootstrap: RunBootstrapEnvelopeV2 | null;
  error: string | null;
}

function exactMaintenancePaths(
  cwd: string,
  value: unknown,
): string[] | null {
  const parsed = parseAllowedFiles(value);
  if (parsed.length === 0) return null;
  const exact: string[] = [];
  for (const entry of parsed) {
    const normalized = entry.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    if (!normalized
      || normalized.startsWith('/')
      || normalized === '.'
      || normalized.split('/').includes('..')
      || normalized.includes('\0')
      || /[*?[\]{}]/.test(normalized)
      || normalized === '.traffic-one'
      || normalized.startsWith('.traffic-one/')) return null;
    // The preflight's own error text has always said "globs and directories
    // cannot authorize a paid fallback" — but this filter was pure string
    // matching, so a bare DIRECTORY passed. The refusal then landed nine
    // minutes later and one layer deeper: `captureFallbackSourceSnapshot`
    // returns null for a directory, which records overallOutcome 'failed' and
    // freezes an IMMUTABLE failed settlement — a dead run instead of the
    // cheap, non-terminal 'preflight-rejected' this early return produces.
    // (A listed file that does not exist YET is fine and snapshots as
    // `state:"missing"` — only a path that IS a directory on disk is refused.)
    try {
      if (fs.statSync(path.join(cwd, normalized)).isDirectory()) return null;
    } catch {
      // absent path: a legal not-yet-created output
    }
    exact.push(normalized);
  }
  return [...new Set(exact)].sort();
}

export function maintenanceContractPreflight(
  cwd: string,
  state: Rec,
  runId: string,
  roleInput: string,
  allowedFiles: unknown,
): MaintenanceContractPreflight {
  if (!runId || !isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined)) {
    return { required: false, bootstrap: null, error: null };
  }
  const role = bootstrapRole(roleInput);
  const existing = readActiveRunBootstrap(cwd, runId, role);
  const requested = exactMaintenancePaths(cwd, allowedFiles);
  if (!requested) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance delegation requires a nonempty exact-file allowlist; globs and directories cannot authorize a paid fallback.',
    };
  }
  if (existing) {
    const activeSources = fallbackSourcePaths(existing);
    if (activeSources && JSON.stringify(activeSources) === JSON.stringify(requested)) {
      return { required: true, bootstrap: existing, error: null };
    }
  }
  const boundedRole = ['quick-fix', 'senior-frontend', 'senior-backend'].includes(role);
  if (!boundedRole) {
    return {
      required: true,
      bootstrap: null,
      error: `OpenCode maintenance delegation for ${role} has no exact active WorkUnit and this role cannot mint an ad-hoc bounded fallback contract.`,
    };
  }
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy || !policy.roles[role]) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance delegation has no immutable parent model policy for this role.',
    };
  }
  const capability = readRunHostCapability(cwd, runId, policy.host);
  const bootstrap = ensureRunBootstrap(cwd, runId, role, state, {
    host: policy.host,
    hostAgentType: capability?.typedSubagents ? role : null,
    evidenceSource: 'opencode-maintenance-preflight',
    modelPolicyId: policy.policyId,
    boundedOutputs: requested,
    boundedAllowlist: requested,
    boundedAllowlistExclude: [],
  });
  const sources = bootstrap ? fallbackSourcePaths(bootstrap) : null;
  if (!bootstrap || !sources || JSON.stringify(sources) !== JSON.stringify(requested)) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance preflight could not publish the exact bounded WorkUnit before delegation.',
    };
  }
  return { required: true, bootstrap, error: null };
}

/**
 * The per-unit ledger inside `maintenance.json`.
 *
 * The marker used to be a single whole-file record, and `writeJson` below is
 * unconditional in every branch — so on a batch of same-role units each unit's
 * outcome REPLACED the previous unit's entry wholesale. Measured on 16co
 * (three-unit news batch, reproduced end-to-end with controls): unit 1's
 * `fallback-pending` debt was erased 52ms later by unit 2's preflight
 * rejection, which also DISARMED `fallbackContractMatches` — opening the
 * window in which the parent's policy preflight legally republished the
 * full-scope envelope over the bounded one — and unit 3's failure then pinned
 * hashes the active envelope no longer held. One slot, three writes, two
 * defects.
 *
 * `units` keeps every unit's own record; the TOP-LEVEL fields become a
 * projection of it (oldest still-pending debt first, else the latest write),
 * so every existing reader — the finalizer, `isMaintenanceTerminal`,
 * settlement reconcile — sees exactly the single-record shape it always did.
 * A marker without `units` is a legacy single record and stays readable.
 */
type MaintenanceUnitRecord = Rec;

export function recordMaintenanceDelegationOutcome(
  cwd: string,
  state: Rec,
  runId: string,
  role: string,
  result: DelegateResult,
  startedAt: number,
  fallbackAllowed: boolean,
  publishedBootstrap?: RunBootstrapEnvelopeV2 | null,
  unitId?: string | null,
): void {
  if (!runId || !isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined)) return;
  try {
    const file = path.join(cwd, T1_DIR, 'runs', runId, 'maintenance.json');
    const canonicalRole = bootstrapRole(role);
    const bootstrap = publishedBootstrap === undefined
      ? readActiveRunBootstrap(cwd, runId, canonicalRole)
      : publishedBootstrap;
    const boundContract = Boolean(bootstrap);
    const workUnitContractHash = bootstrap?.workUnit.contractHash;
    const allowlistHash = bootstrap ? workUnitAllowlistHash(bootstrap) : undefined;
    const fallbackSourceBaseline = bootstrap && result.ok !== true && fallbackAllowed
      ? captureMaintenanceFallbackBaseline(cwd, bootstrap)
      : null;
    const fallbackBound = boundContract && Boolean(fallbackSourceBaseline);
    // No bound contract means the PREFLIGHT refused before anything ran: no
    // worktree, no diff, no model call. That is a rejected delegation request,
    // not a run outcome, so it must stay NON-terminal — `preflight-rejected` is
    // deliberately absent from MAINTENANCE_TERMINAL_OUTCOMES. Marking it
    // terminal settled the whole run `failed`, and since no ledger transition
    // leaves `failed`, every later role claim was refused and the build
    // deadlocked with the paid fallback still owed. Both `outcome` and
    // `overallOutcome` carry it: maintenanceOutcome() falls back to `outcome`.
    const opencodeOutcome = !boundContract
      ? 'preflight-rejected'
      : result.ok ? 'success' : (result.action === 'skipped' ? 'skipped' : 'failed');
    const overallOutcome = !boundContract
      ? 'preflight-rejected'
      : result.ok
      ? 'code-delivered'
      : fallbackAllowed && fallbackBound
        ? 'fallback-pending'
        : 'failed';
    const terminalOutcome = isMaintenanceTerminal({ overallOutcome });
    const unitRecord: MaintenanceUnitRecord = {
      role: canonicalRole,
      outcome: opencodeOutcome,
      opencodeOutcome,
      overallOutcome,
      ...(boundContract ? {} : { preflightRejected: true }),
      fallbackAllowed: fallbackBound && result.ok !== true && fallbackAllowed,
      ...(workUnitContractHash ? { workUnitContractHash } : {}),
      ...(allowlistHash ? { allowlistHash } : {}),
      ...(fallbackSourceBaseline ? { fallbackSourceBaseline } : {}),
      action: result.action,
      failureKind: result.failureKind ?? null,
      model: result.model ?? null,
      // Keep the SPECIFIC preflight reason (rejected allowlist, missing model
      // policy, unbounded role). Overwriting it with the generic contract line
      // hid which input to fix and sent orchestrators into blind retries.
      error: !boundContract
        ? `${result.error ? String(result.error).slice(0, 400) : 'OpenCode maintenance contract preflight failed closed'} (no parent-published WorkUnitContract; fallback is forbidden)`
        : result.ok !== true && fallbackAllowed && !fallbackSourceBaseline
          ? 'OpenCode maintenance fallback source pre-image could not be captured completely; fallback is forbidden.'
        : result.error
          ? String(result.error).slice(0, 500)
          : null,
      touched: result.touched,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
    };
    // Merge into the per-unit ledger and re-project. A record with no unit id
    // (a whole-role direct delegation) uses the role itself as key — those runs
    // have exactly one delegation per role, which is the legacy single-slot
    // shape. Records for OTHER units survive this write; the debt erasure and
    // the disarm window both lived in the wholesale overwrite this replaces.
    const previous = readJson<Rec | null>(file, null);
    const units: Record<string, MaintenanceUnitRecord> = {
      ...(previous && previous.units && typeof previous.units === 'object'
        ? previous.units as Record<string, MaintenanceUnitRecord>
        : previous && !previous.units && previous.overallOutcome
          // Legacy single record from an older runtime: keep it as a unit row
          // rather than silently dropping whatever debt it may pin.
          ? { [`legacy:${String(previous.role || 'role')}`]: previous }
          : {}),
      [unitId || `direct:${canonicalRole}`]: unitRecord,
    };
    const projected = projectMaintenanceMarker(units) || unitRecord;
    writeJson(file, {
      version: 1,
      kind: 'opencode-delegation',
      ...projected,
      units,
    });
    // A preflight rejection is not a lifecycle event for the RUN — nothing was
    // attempted — so it writes no settlement at all. Minting one here would
    // freeze a canonical V2 sidecar (terminal settlements are immutable) for a
    // run the orchestrator must still be able to drive with a paid worker.
    if (!boundContract) return;
    // The settlement follows the PROJECTION, not this unit's outcome. A sibling
    // unit's success used to write `code-delivered` over a still-owed debt's
    // `fallback-pending`, erasing the only settlement-side track of it — while a
    // debt is pending anywhere in the batch, the run is neither delivered nor
    // terminally failed, it is waiting on the paid fallback.
    const pendingElsewhere = projected.overallOutcome === 'fallback-pending';
    const pendingContract = pendingElsewhere ? String(projected.workUnitContractHash || '') : '';
    const pendingAllowlist = pendingElsewhere ? String(projected.allowlistHash || '') : '';
    writeRunSettlement(cwd, runId, pendingElsewhere && pendingContract && pendingAllowlist
      ? {
          status: 'active',
          reason: 'fallback-pending',
          workUnitContractHash: pendingContract,
          allowlistHash: pendingAllowlist,
          fallback: {
            state: 'pending',
            workUnitContractHash: pendingContract,
            allowlistHash: pendingAllowlist,
          },
          incompleteChecks: ['fallback-pending'],
        }
      : result.ok
        ? {
            status: 'code-delivered',
            workUnitContractHash: workUnitContractHash!,
            allowlistHash: allowlistHash!,
            incompleteChecks: ['verification-not-started'],
          }
        : !terminalOutcome
          ? {
              status: 'active',
              reason: 'fallback-pending',
              workUnitContractHash: workUnitContractHash!,
              allowlistHash: allowlistHash!,
              fallback: {
                state: 'pending',
                workUnitContractHash: workUnitContractHash!,
                allowlistHash: allowlistHash!,
              },
              incompleteChecks: ['fallback-pending'],
            }
          : {
              status: 'failed',
              reason: result.error || 'OpenCode delegation failed and fallback is not allowed',
              workUnitContractHash: workUnitContractHash!,
              allowlistHash: allowlistHash!,
            });
  } catch {
    // best-effort diagnostics; never change delegation behavior
  }
}
