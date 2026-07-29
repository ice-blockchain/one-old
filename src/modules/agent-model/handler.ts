// src/modules/agent-model/handler.ts
// The agent-model gate: agentModelGate walks spawn shape, run policy,
// reuse/replace, claims, and model enforcement. Deny builders and spawn
// parsing live in the sibling modules.

import { asString } from '../../adapters/coerce';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { detectHostPlan } from '../../shared/host/plan';
import { canonicalHost } from '../../shared/model-tiers';
import { currentAcceptableModels, currentModelForTier } from '../../shared/current-model-tiers';
import { exhaustedModelsForRole, isApiUsageLimitText, markModelExhaustionTerminal, modelIsExhausted, recordExhaustedModel } from './exhausted-models';
import { modelForRoleHost, teamModeForLevel, type PlanCtx } from '../../shared/performance';
import { recordOpenCodeFallback } from '../../shared/opencode-queue';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import {
  markOpenCodeGateDenied,
  openCodeGateDenied,
  openCodePlanBatchComplete,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  pendingOpenCodePlanRoles,
  roleHasQueuedUnits,
  shouldBlockImplementerForPlanBatch,
  shouldRunRoleOnOpenCode,
} from '../../shared/opencode-roles';
import {
  captureClaimDebug,
  ensureCurrentRunId,
  ensureRunAgentClaim,
  continuationAgentId,
  type CodexLiveAgentValidation,
  hookSessionIdentity,
  isMaintenancePhase,
  isTeamApproved,
  liveRunAgent,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  refreshCursorRunAgentFromTranscriptCache,
  readEffectiveState,
  readRunAssignmentsResilient,
  REPLACE_AGENT_MARKER,
  retireUnverifiedCodexRunAgent,
  subagentContinuationAvailable,
  validateCodexLiveRunAgent,
  verdictAgentConflict,
} from '../../shared/state';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { hasRunIdPlaceholder, strayRunIdInText, substituteRunIdPlaceholder } from '../../shared/run-id-paths';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';
import {
  correlatedCursorFailureGate,
  CURSOR_FAILURE_BLOCK_FALLBACKS,
} from './cursor-failures';
import { cursorAgentPresumedDead } from './cursor-liveness';
import { buildOpenCodePlanBatchDenyContext } from '../../shared/opencode-plan/directive';
import { architectPhaseIncompleteReasons } from '../plan-guard/plan-readiness';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from '../../shared/materialize/opencode-assets';
import { acceptableSpawnTypes, canonicalHostAgentType, hostSpawnType } from '../../shared/host/spawn-types';
import {
  cursorRunPolicyMissingTiers,
  ensureRunModelPolicy,
  policyModelsForExpected,
  readRunModelPolicy,
  resolveRunPolicyFallback,
  runModelPolicyPath,
  type RunModelPolicyV1,
} from '../../shared/run-model-policy';
import {
  boundedMaintenanceSourceScope,
  ensureRunBootstrap,
  readActiveRunBootstrap,
} from '../../shared/run-bootstrap-policy';
import { readRunHostCapability } from '../../shared/host/capabilities';

import {
  ARCHITECT_PHASE_INCOMPLETE_FALLBACK,
  CURSOR_MODELS_CAPTURE_FALLBACK,
  block,
  isPlanBatchGatedRole,
} from './handler-prose';
import {
  cursorAgentTypeDeny,
  isBuiltinSubagent,
  kiloGeneralAgentDeny,
  modelParamEnforced,
  modelSatisfiesTier,
  namedOpenCodeAgentDeny,
  quickFixScopeFromSpawn,
  spawnAgentType,
} from './spawn-shape';
import {
  absoluteTrafficOnePathDeny,
  absoluteTrafficOnePathsOutsideProject,
  continuationRecipe,
  recordSpawnParentSession,
} from './spawn-hygiene';
import {
  exhaustedModelRotationDeny,
  replacementJustified,
} from './model-rotation';
import {
  cursorExactModelDeny,
  degradedToFloorDeny,
  maybeModelAdvisory,
  modelTierDeny,
  preferredModelUnavailableDeny,
} from './model-denies';
import type { GateContext } from './gate-context';
import { openCodeFirstGates } from './gate-opencode-first';
import { reuseReplaceGates } from './gate-reuse';
import { modelEnforcementGates } from './gate-enforcement';

export function agentModelGate(ctx: Ctx): HookResult {
  if (pluginUseDeclined(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  // Normalize a host namespace (Codex `multi_agent_v1.spawn_agent`) to the bare name
  // before matching, so the gate can't silently bail on a qualified spawn tool.
  if (toolName && !/^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const roleResolution = inferTrafficOneSpawnRoleEvidence(toolInput);
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  // The plugin's own repo / a generated tree is never an end-user project: no run
  // ids, no model policy, no spawn gating. Mirrors the write-guard stand-down.
  if (isNonProjectRoot(cwd)) return noop();
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  if (!state || typeof state !== 'object') return noop();
  if (roleResolution.kind === 'conflict') {
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
    const conflictCandidates = Array.from(new Map(
      roleResolution.candidates.map(({ role, source }) => [
        `${role}\u0000${source}`,
        { role, source },
      ]),
    ).values()).slice(0, 8);
    const candidateList = conflictCandidates
      .map(({ role, source }) => `\`${role}\` (${source})`)
      .join(', ');
    captureClaimDebug(cwd, runId, 'spawn-role-conflict', {
      host: ctx.host,
      candidates: conflictCandidates,
    });
    return deny(block('spawn-role-conflict', { CANDIDATES: candidateList },
      `Traffic One spawn identity gate: this spawn carries conflicting valid Traffic One role evidence in the same highest-priority tier: ${candidateList}. The spawn was blocked before a child started. Do not retry it unchanged and do not guess which role won. Correct or remove the stale identity field or marker so every valid item in that tier agrees on exactly one canonical role, then retry the same task. On Codex, keep one exact canonical task_name and ensure higher-tier agent_path/agent_type metadata, when present, names the same role.`));
  }
  if (roleResolution.kind !== 'evidence') return noop();
  const roleEvidence = roleResolution.evidence;
  const role = roleEvidence.role;

  // A role spawn is imminent → make sure the version-stable runner shims exist
  // BEFORE any subagent runs prose that references ~/.traffic-one/bin. This is
  // the reliable cross-host site: Codex executes PreToolUse but not the
  // SessionStart injection path. Idempotent, ~1ms when already current.
  ensureRunnerShims();

  // Run-id integrity at the spawn boundary. The run-id is `currentRunId` (a
  // gate-minted epoch-ms digit string). Models STILL fabricate a `date`/ISO id in the spawn
  // prompt despite the pre-mint + announce + prose (observed: composer-2.5 typing an
  // ISO timestamp it never read from `.one.json`). A wrong id splits run state —
  // assignments under one id, the gate's run-claims/OpenCode markers under another —
  // and strands digest handoffs (implementers READ a `digests/<id>/` path the write-
  // guard redirected elsewhere). Refuse a spawn whose prompt references ANY other
  // run-id, naming the correct one, so the orchestrator rebuilds the prompt. The
  // plan-write guard is the write-side backstop; this fixes the prompt's read/handoff
  // paths the write-guard can't reach.
  const spawnIdentity = hookSessionIdentity(raw);
  const stateRunId = typeof state.currentRunId === 'string' && state.currentRunId.trim()
    ? state.currentRunId.trim()
    : null;
  if (spawnIdentity.isSubagent && !stateRunId) {
    return deny(
      'traffic-one — spawn blocked: a child cannot mint the parent run id or model policy. '
      + 'The parent must start the run, acknowledge Performance, and freeze model-policy.json before spawning children.',
    );
  }
  const spawnRunId = ensureCurrentRunId(cwd, state);
  // ensureCurrentRunId now fails closed rather than minting a sibling run over
  // an unreadable `.one.json` — a fabricated id strands every live child.
  if (!spawnRunId) {
    return deny(
      'traffic-one — spawn blocked: .traffic-one/.one.json exists but could not be parsed, so no run id '
      + 'could be resolved. Do NOT mint one or hand-write the file: repair or restore .one.json '
      + '(a backup may exist under .traffic-one/backups/) and retry the spawn.',
    );
  }
  const configuredSubagentTeam = obj(state.team)?.mode === 'subagents';
  const existingRunPolicy = readRunModelPolicy(cwd, spawnRunId);
  if (!existingRunPolicy && fs.existsSync(runModelPolicyPath(cwd, spawnRunId))) {
    return deny(
      `traffic-one — spawn blocked: immutable model-policy.json is corrupt for run ${spawnRunId}. `
      + 'Do not reconstruct it from the current plan, One MCP cache, or project availableModels; start a repaired parent run.',
    );
  }
  if (existingRunPolicy && existingRunPolicy.host !== ctx.host) {
    return deny(
      `traffic-one — spawn blocked: run ${spawnRunId} is frozen for host ${existingRunPolicy.host}, `
      + `not ${ctx.host}. Start a new parent run for the active host; do not rebase model-policy.json.`,
    );
  }
  if (spawnIdentity.isSubagent && !existingRunPolicy) {
    return deny(
      `traffic-one — spawn blocked: a child cannot create or rebase immutable model-policy.json for run ${spawnRunId}. `
      + 'The parent must repair the run before spawning or retrying a child.',
    );
  }
  const subagentTeam = configuredSubagentTeam || Boolean(existingRunPolicy);
  const cursorMissingTiers = configuredSubagentTeam && ctx.host === 'cursor' && !existingRunPolicy
    ? cursorRunPolicyMissingTiers(
      cwd,
      ctx.host,
      state,
      { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
    )
    : null;
  if (cursorMissingTiers?.length) {
    return deny(block('cursor-models-capture', {
      RUN_ID: spawnRunId,
      MISSING_TIERS: cursorMissingTiers.join(', '),
      CAPTURE_CMD: modelCaptureCommand(cwd, 'cursor'),
    }, CURSOR_MODELS_CAPTURE_FALLBACK));
  }
  const runPolicy = existingRunPolicy
    || (configuredSubagentTeam
      ? ensureRunModelPolicy(
        cwd,
        spawnRunId,
        ctx.host,
        state,
        { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
      )
      : null);
  if (subagentTeam && !runPolicy) {
    return deny(
      `traffic-one — spawn blocked: immutable model-policy.json is unavailable for run ${spawnRunId}. `
      + 'The parent must complete/acknowledge Performance and freeze the active host catalog before any child starts.',
    );
  }
  // The spawn's prompt across every host field — reused by the run-id guard here AND
  // the agent-reuse marker check below (single source of the field list).
  const spawnPromptFields = ['prompt', 'message', 'task', 'description'] as const;
  const spawnPromptText = spawnPromptFields.map((field) => toolInput[field])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const badTrafficOnePaths = absoluteTrafficOnePathsOutsideProject(spawnPromptText, cwd);
  if (badTrafficOnePaths.length > 0) {
    return absoluteTrafficOnePathDeny(badTrafficOnePaths, cwd);
  }
  // Placeholder-tolerant run-id check: the orchestrator templates ship
  // `runs/<run-id>/…` paths with the literal `<run-id>` placeholder, and a
  // template-faithful prompt must not be denied for it (observed 6c: the FIRST
  // architect spawn of the run died on the placeholder as "Couldn't start").
  // Normalize the placeholder to the current run id in the CHECKED text only —
  // a genuinely fabricated id (`date`/ISO, foreign epoch) still denies, and the
  // plan-gate WRITE guard still rejects literal `<run-id>` write paths.
  const strayRunId = strayRunIdInText(substituteRunIdPlaceholder(spawnPromptText, spawnRunId), spawnRunId);
  if (strayRunId) {
    // SELF-HEALING deny: hand back the spawn prompt with the run-id ALREADY corrected so a weak
    // orchestrator can copy-paste it verbatim, instead of being told to "rebuild" it (composer-2.5
    // read "rebuild the prompt" as an impossible task and fell back to an inline single-model build
    // — observed in 21b). Loop the detector so a SECOND fabricated id can't survive into the echoed
    // prompt and re-deny the retry. Echo only when the prompt is paste-sized; otherwise give the
    // exact substitution. This deny has NO once-marker — it is self-correcting, so it can fire as
    // many times as needed without tripping the no-deadlock budget.
    let fixed = substituteRunIdPlaceholder(spawnPromptText, spawnRunId);
    for (let i = 0; i < 8; i++) {
      const s = strayRunIdInText(fixed, spawnRunId);
      if (!s) break;
      fixed = fixed.split(s).join(spawnRunId);
    }
    const action = fixed.length <= 2000
      ? `RE-ISSUE THE SAME Task spawn — same subagent_type, same model — with this exact prompt (run-id already corrected), copied VERBATIM:\n----\n${fixed}\n----`
      : `RE-ISSUE THE SAME Task spawn — same subagent_type, same model — after replacing EVERY \`${strayRunId}\` with \`${spawnRunId}\` in your prompt (it appears in the "Run ID:" line and the \`.traffic-one/runs/\` and \`digests/\` paths).`;
    return deny(`traffic-one — run-id gate: your spawn prompt used run-id \`${strayRunId}\`, but the ONLY valid run-id is \`currentRunId\` = \`${spawnRunId}\` (read from .traffic-one/.one.json — never \`date\`/ISO/UTC). ${action}`);
  }

  // Claude can rewrite a tool call's input from PreToolUse (updatedInput — a
  // FULL tool_input replacement), so when the allowed prompt still carries the
  // literal `<run-id>` placeholder, hand the child fully substituted paths
  // instead of leaving it the placeholder to resolve. Other hosts can only
  // allow/deny; there the child resolves `<run-id>` itself (Run ID header +
  // .one.json), with the plan-gate write guard as the backstop. Every ALLOW
  // exit below this point must flow through allowSpawn().
  const placeholderPromptFields = ctx.host === 'claude' && spawnRunId
    ? spawnPromptFields.filter((field) => typeof toolInput[field] === 'string'
      && hasRunIdPlaceholder(toolInput[field]))
    : [];
  const allowSpawn = (result: HookResult): HookResult => {
    if (result.kind === 'deny') return result;
    const updatedToolInput: Record<string, unknown> = { ...toolInput };
    for (const field of placeholderPromptFields) {
      updatedToolInput[field] = substituteRunIdPlaceholder(toolInput[field] as string, spawnRunId);
    }
    let changed = placeholderPromptFields.length > 0;
    if (subagentTeam && runPolicy) {
      const rawAgentType = spawnAgentType(toolInput, { includeRoleAlias: false }).trim();
      const capability = readRunHostCapability(cwd, spawnRunId, ctx.host);
      if (!capability) {
        return deny(
          `traffic-one — spawn blocked: per-run host capability evidence is missing or corrupt for ${ctx.host}. `
          + 'No child was started. Repair the parent run and retry.',
        );
      }
      // A spawn that fell back to the host's built-in generic worker (because this
      // session's accepted-type set predates the materialized agent files) is the
      // SAME work unit as the typed spawn. Canonicalize it so both paths resolve
      // the bootstrap the parent already published for this role.
      const hostAgentType = canonicalHostAgentType(
        ctx.host,
        role,
        rawAgentType,
        capability?.typedSubagents === true,
        cwd,
      );
      const activeRoleBootstrap = readActiveRunBootstrap(cwd, spawnRunId, role);
      const activeBoundedMaintenance = activeRoleBootstrap
        && (
          (role === 'quick-fix' && activeRoleBootstrap.workUnit.unitId === 'quick-fix:bootstrap')
          || activeRoleBootstrap.workUnit.unitId === `${role}:bounded-maintenance`
        )
        ? activeRoleBootstrap
        : null;
      const requestedQuickFixScope = role === 'quick-fix'
        ? quickFixScopeFromSpawn(toolInput, spawnPromptText)
        : null;
      const explicitQuickFixScope = requestedQuickFixScope?.present
        ? (requestedQuickFixScope.valid ? requestedQuickFixScope : null)
        : null;
      const boundedMaintenanceOutputs = explicitQuickFixScope?.outputs
        || (!requestedQuickFixScope?.present && activeBoundedMaintenance
          ? boundedMaintenanceSourceScope(
              spawnRunId,
              role,
              activeBoundedMaintenance.workUnit.outputs,
            )
          : undefined)
        || null;
      const envelope = ensureRunBootstrap(cwd, spawnRunId, role, state, {
        host: canonicalHost(ctx.host),
        hostAgentType,
        evidenceSource: roleEvidence.source,
        modelPolicyId: runPolicy.policyId,
        ...(boundedMaintenanceOutputs
          ? {
              boundedOutputs: boundedMaintenanceOutputs,
              boundedAllowlist: explicitQuickFixScope?.allowlist
                || (activeBoundedMaintenance
                  ? boundedMaintenanceSourceScope(
                      spawnRunId,
                      role,
                      activeBoundedMaintenance.workUnit.allowlist,
                    )
                  : undefined)
                || boundedMaintenanceOutputs,
              boundedAllowlistExclude: explicitQuickFixScope?.exclude
                || activeBoundedMaintenance?.workUnit.allowlistExclude
                || [],
            }
          : {}),
      });
      if (!envelope) {
        return deny(
          `traffic-one — spawn blocked: parent could not resolve and atomically publish the role/rule/skill bootstrap `
          + `for ${role} in run ${spawnRunId}. No child was started. Repair the parent materialization/policy and retry.`,
        );
      }
      // The immutable envelope is the bootstrap transport shared by all hosts.
      // Host-specific prompt/agent renderers already inject the role contract;
      // returning updated tool input here would turn an otherwise plain allow
      // into a host-dependent context result and is not supported uniformly.
    }
    if (!changed) return result;
    return result.kind === 'context'
      ? { ...result, updatedToolInput }
      : context('', { updatedToolInput });
  };

  const gateCtx: GateContext = {
    ctx, cwd, state, raw, toolName, toolInput, role, roleEvidence,
    spawnRunId, runPolicy, subagentTeam, spawnPromptText, allowSpawn,
  };
  const openCodeFirst = openCodeFirstGates(gateCtx);
  if (openCodeFirst) return openCodeFirst;
  const reuse = reuseReplaceGates(gateCtx);
  if (reuse) return reuse;
  return modelEnforcementGates(gateCtx);
}

export { ARCHITECT_PHASE_INCOMPLETE_FALLBACK, CURSOR_MODELS_CAPTURE_FALLBACK } from './handler-prose';
