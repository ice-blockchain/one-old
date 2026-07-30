// src/runners/opencode/maintenance.ts
// Maintenance contract preflight and delegation outcome recording.

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
import { writeJson } from '../../shared/fsjson';
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

function exactMaintenancePaths(value: unknown): string[] | null {
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
  const requested = exactMaintenancePaths(allowedFiles);
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

export function recordMaintenanceDelegationOutcome(
  cwd: string,
  state: Rec,
  runId: string,
  role: string,
  result: DelegateResult,
  startedAt: number,
  fallbackAllowed: boolean,
  publishedBootstrap?: RunBootstrapEnvelopeV2 | null,
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
    writeJson(file, {
      version: 1,
      kind: 'opencode-delegation',
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
    });
    // A preflight rejection is not a lifecycle event for the RUN — nothing was
    // attempted — so it writes no settlement at all. Minting one here would
    // freeze a canonical V2 sidecar (terminal settlements are immutable) for a
    // run the orchestrator must still be able to drive with a paid worker.
    if (!boundContract) return;
    writeRunSettlement(cwd, runId, result.ok
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
