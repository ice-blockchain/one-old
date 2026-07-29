// src/runners/opencode/index.ts
// OpenCode delegation entry: delegate() and delegateFromPlan() orchestrate
// the sibling modules; main() is the CLI the shim calls. The safety model
// lives in the sibling headers; see git-sandbox/verify/diff-policy.

import * as fs from 'fs';
import * as path from 'path';
import { OPENCODE_FREE_MODELS } from '../../config/model-tiers';
import { gatewayBreakerMs, maxConsecutiveStalls } from '../../config/opencode-timeouts';
import { ensureInitialCommit } from '../../shared/git-init';
import { resolveProjectRoot } from '../../shared/hook/paths';
import {
  markOpenCodeGatewayOutage,
  markOpenCodeRoleAttempted,
  openCodeGatewayOutageActive,
  recordOpenCodeAttemptOutcome,
} from '../../shared/opencode-roles';
import {
  finalizePlanBatchOnly,
} from '../../shared/opencode-plan/batch';
import {
  recordOpenCodeUnitStatus,
  statusFromDelegateAction,
  unsafeAllowedFilePatterns,
} from '../../shared/opencode-queue';
import {  readEffectiveState } from '../../shared/state';
import {  reconcileManagedToolStamp } from '../toolchain';

import {
  type DelegateOpts,
  type DelegateResult,
  type Rec,
} from './types';
import {
  gatewayUnreachableError,
  opencodeGatewayReachable,
} from './gateway-probe';
import {
  git,
  snapshotWorkingTree,
} from './git-sandbox';
import {
  classifyFailureKind,
  maintenanceContractPreflight,
  recordMaintenanceDelegationOutcome,
} from './maintenance';
import {
  resolveBin,
  resolveModels,
  shouldTryNextModel,
  setFreeChainStart,
} from './models';
import {
  buildDelegatedDiffPolicy,
  delegationBoundaryPrompt,
  validateDelegatedDiff,
} from './diff-policy';
import {
  runModel,
  writeDigest,
  runStamp,
} from './run-model';

export function delegate(cwd: string = process.cwd(), opts: DelegateOpts = {}): DelegateResult {
  cwd = resolveProjectRoot(cwd);
  const state = readEffectiveState(cwd);
  const role = (opts.role || 'opencode').trim() || 'opencode';
  const stateRunId = typeof state.currentRunId === 'string'
    ? state.currentRunId.trim()
    : (typeof state.currentRunId === 'number' && Number.isFinite(state.currentRunId) ? String(Math.trunc(state.currentRunId)) : '');
  const runId = (opts.runId || '').trim() || stateRunId || runStamp();
  const policy = buildDelegatedDiffPolicy(cwd, runId, role, opts.allowedFiles, opts.expectedAssignmentHash);
  const startedAt = Date.now();
  const maintenancePreflight = maintenanceContractPreflight(cwd, state, runId, role, opts.allowedFiles);
  const maintenanceEarlyResult = (result: DelegateResult): DelegateResult => {
    const failureKind = result.failureKind ?? classifyFailureKind(result.action, result.error);
    const enriched: DelegateResult = failureKind ? { ...result, failureKind } : result;
    recordMaintenanceDelegationOutcome(
      cwd,
      state,
      runId,
      role,
      enriched,
      startedAt,
      opts.fallbackAllowed !== false,
      maintenancePreflight.bootstrap,
    );
    return enriched;
  };
  if (maintenancePreflight.required && !maintenancePreflight.bootstrap) {
    return maintenanceEarlyResult({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: maintenancePreflight.error || 'OpenCode maintenance contract preflight failed closed',
      failureKind: 'diff-rejected',
    });
  }
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled !== true) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode delegation is not enabled' });
  }
  const bin = resolveBin();
  if (!bin) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode CLI is not installed' });
  }
  // We resolved a real binary — self-heal a stale/missing toolchain stamp so the
  // orchestrator + tier logic stop treating OpenCode as "not installed" on the
  // next run. Best-effort; never blocks delegation.
  reconcileManagedToolStamp(cwd, 'opencode');
  const task = (opts.task || '').trim();
  if (!task) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'No task provided to delegate' });
  }
  // Reject an allowlist the post-run diff validator can never accept BEFORE
  // paying for a model run. `validateDelegatedDiff` discards the entire diff for
  // one generated/internal path, so a digest listed in `allowedFiles` cost four
  // full delegations and returned nothing (1cu-cursor). The runner writes the
  // handoff digest itself — callers never need it in scope.
  const unsafeAllowed = unsafeAllowedFilePatterns(policy.allowedPatterns);
  if (unsafeAllowed.length > 0) {
    return maintenanceEarlyResult({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: `allowedFiles contains generated/internal path(s) the delegated diff can never include: ${unsafeAllowed.join(', ')}. Remove them and delegate only product files — the runner writes the handoff digest itself.`,
      failureKind: 'diff-rejected',
    });
  }
  // Sandbox requires a committed HEAD to branch the worktree from. Pin the exact
  // sha once: every worktree, reset, and diff below is relative to it.
  let head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    // NEW-PROJECT case: a fresh scaffold has no commit (and may not be a git repo at
    // all) until the build-completion flip — but the orchestrator delegates to
    // OpenCode DURING the build, so declining here forces a paid fallback for the
    // whole build. Self-heal: initialize (new-project only) + initial-commit the
    // scaffold, then retry. Still skips when no HEAD can be produced (a non-git folder
    // outside new-project mode, or nothing to commit) → caller falls back as before.
    ensureInitialCommit(cwd, { initIfNeeded: state.mode === 'new-project' });
    head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) {
      return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'No git HEAD to sandbox the delegation; run a normal subagent' });
    }
  }
  // Sandbox from the CURRENT WORKING TREE — uncommitted tracked changes AND
  // untracked files — not just committed HEAD. Without this, sequential
  // delegations each branch the worktree from a stale base and silently ignore
  // prior uncommitted edits, and any task touching a not-yet-committed file
  // fails on apply with "does not exist in index" (see snapshotWorkingTree).
  const baseSha = snapshotWorkingTree(cwd, head.stdout.trim());

  const { models, fromChain } = resolveModels(state, opts);
  let markedAttempt = false;
  const markCliAttempt = (): void => {
    if (markedAttempt || !runId || !role) return;
    markedAttempt = true;
    markOpenCodeRoleAttempted(cwd, runId, role);
  };
  // Terminal-outcome diagnostics into the attempt marker (append-only JSON lines;
  // the spawn gate only checks existence). Failed delegations were undiagnosable
  // from the 0-byte flag alone.
  const record = (result: DelegateResult): DelegateResult => {
    const failureKind = result.failureKind ?? classifyFailureKind(result.action, result.error);
    const enriched: DelegateResult = failureKind ? { ...result, failureKind } : result;
    recordOpenCodeAttemptOutcome(cwd, runId, role, {
      action: enriched.action,
      model: enriched.model ?? null,
      error: enriched.error,
      failureKind: enriched.failureKind ?? null,
      durationMs: Date.now() - startedAt,
      touched: enriched.touched.length,
    });
    if (opts.unitId) {
      recordOpenCodeUnitStatus(cwd, runId, {
        id: opts.unitId,
        role: normalizePlanRole(role),
        status: statusFromDelegateAction(enriched.action, enriched.error),
        action: enriched.action,
        model: enriched.model ?? null,
        error: enriched.error,
        failureKind: enriched.failureKind ?? null,
        touched: enriched.touched,
        allowedFiles: policy.allowedPatterns,
        assignmentHash: policy.expectedAssignmentHash,
      });
    }
    recordMaintenanceDelegationOutcome(
      cwd,
      state,
      runId,
      role,
      enriched,
      startedAt,
      opts.fallbackAllowed !== false,
      maintenancePreflight.bootstrap,
    );
    return enriched;
  };

  // Gateway-outage circuit breaker: once a delegation in THIS run concluded the
  // free gateway itself is down (maxConsecutiveStalls() back-to-back stalls),
  // later units — and later per-role runner PROCESSES — must not re-burn the
  // unit timeout re-detecting it. Fail instantly with the same provider-timeout
  // contract the stall terminal returns; the attempt marker keeps the spawn
  // gate from denying the paid fallback spawn. Free-chain only: an explicitly
  // pinned model is the user's choice and is never breaker-skipped.
  if (fromChain && openCodeGatewayOutageActive(cwd, runId, gatewayBreakerMs())) {
    markCliAttempt();
    return record({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: 'OpenCode gateway breaker is active for this run (repeated stalls) — skipped the free-model probe; proceed with the paid fallback',
      model: models[0] as string,
      failureKind: 'provider-timeout',
    });
  }

  // Egress preflight (free chain only — a pinned model is the user's explicit
  // choice). A DENIED gateway hangs rather than erroring, so without this every
  // model burns the full unit timeout to rediscover the same blocked host. Trip
  // the run breaker too so sibling units/shards skip even the 4s probe.
  if (fromChain) {
    const probe = opencodeGatewayReachable();
    if (!probe.reachable) {
      // Deliberately do NOT trip the run-scoped gateway breaker here. The probe costs
      // ~120ms, so every sibling unit can afford its own; tripping a 120s run-wide breaker
      // off one cheap signal would silence a chain that a re-probe might find healthy.
      markCliAttempt();
      return record({
        ok: false,
        action: 'failed',
        digest: null,
        touched: [],
        error: gatewayUnreachableError(probe.detail),
        model: models[0] as string,
        failureKind: 'environment',
      });
    }
  }

  // Walk the models: a fresh worktree per model; advance on server/model-side
  // errors (see shouldTryNextModel) AND on per-model stalls (capped at
  // maxConsecutiveStalls()). Environmental failures are terminal.
  const modelErrors: string[] = [];
  let consecutiveStalls = 0;
  let lastModel = models[models.length - 1] as string;
  // Appended AFTER the task (a boundary read first competes with the work itself)
  // and below the MCP task-file layer, so the caller's recorded task text is intact.
  const boundedTask = `${task}\n${delegationBoundaryPrompt(policy)}\n`;
  for (const model of models) {
    lastModel = model;
    const outcome = runModel(cwd, bin, baseSha, model, boundedTask, policy, markCliAttempt);
    if (outcome.kind === 'delegated') {
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        if (idx >= 0) setFreeChainStart(idx);
      }
      const digest = writeDigest(cwd, runId, role, model, outcome.touched, outcome.summary, { planUnit: Boolean(opts.unitId) });
      return record({ ok: true, action: 'delegated', digest, touched: outcome.touched, error: null, model });
    }
    if (outcome.kind === 'try-next' || outcome.kind === 'stalled') {
      modelErrors.push(`${model}: ${outcome.error}`);
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        // Skip the dead/stalling id for the rest of this process (a --from-plan
        // batch must not burn the unit timeout on it per unit), but always keep
        // at least the LAST chain entry tryable so delegation degrades to one
        // failing probe per unit instead of disappearing silently.
        if (idx >= 0) setFreeChainStart(Math.min(idx + 1, OPENCODE_FREE_MODELS.length - 1));
      }
      if (outcome.kind === 'stalled') {
        consecutiveStalls += 1;
        if (consecutiveStalls >= maxConsecutiveStalls()) {
          // Gateway-wide outage concluded — trip the run-scoped breaker so
          // every later unit/role shard in this run fast-fails (see the check
          // above the walk) instead of paying this detection again.
          markOpenCodeGatewayOutage(cwd, runId);
          return record({
            ok: false,
            action: 'failed',
            digest: null,
            touched: [],
            error: `OpenCode models stalled ${consecutiveStalls}x in a row (gateway or network likely down) — ${modelErrors.join('; ')}`,
            model,
          });
        }
      } else {
        consecutiveStalls = 0;
      }
      continue;
    }
    if (outcome.kind === 'no-changes') {
      return record({ ok: false, action: 'no-changes', digest: null, touched: [], error: 'OpenCode produced no file changes', model });
    }
    return record({ ok: false, action: 'failed', digest: null, touched: [], error: outcome.error, model });
  }
  return record({
    ok: false,
    action: 'failed',
    digest: null,
    touched: [],
    error: `no usable OpenCode model — ${modelErrors.join('; ')}`,
    model: lastModel,
  });
}

export {
  delegateFromPlan,
  parsePlanDelegationQueue,
  finalizePlanBatchOnly,
} from './from-plan';
import { delegateFromPlan, parsePlanDelegationQueue } from './from-plan';

export function main(): number {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (args.includes('--finalize-only')) {
    const runId = (get('--run-id') || '').trim();
    if (!runId) {
      process.stderr.write('opencode-runner: --finalize-only requires --run-id\n');
      return 1;
    }
    const summary = finalizePlanBatchOnly(process.cwd(), runId);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  if (args.includes('--from-plan')) {
    const rolesCsv = get('--roles');
    const summary = delegateFromPlan(process.cwd(), {
      runId: get('--run-id'),
      model: get('--model'),
      ...(rolesCsv ? { roles: rolesCsv.split(',').map((r) => r.trim()).filter(Boolean) } : {}),
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0; // batch is best-effort: un-delegated units fall back to subagents, never fail the run
  }

  const taskFile = get('--task-file');
  let task = get('--task');
  if (!task && taskFile && fs.existsSync(taskFile)) task = fs.readFileSync(taskFile, 'utf8');

  const result = delegate(process.cwd(), {
    role: get('--role'),
    task,
    runId: get('--run-id'),
    model: get('--model'),
    allowedFiles: get('--allowed-files'),
    unitId: get('--unit-id'),
    expectedAssignmentHash: get('--expected-assignment-hash'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}

export { postApplyQuality, postApplyTypecheck } from './verify';
export { resetOpenCodeModelMemo } from './models';
export { snapshotWorkingTree, stageExcludePathspecs } from './git-sandbox';
import { normalizePlanRole } from './diff-policy';
export { normalizePlanRole };
