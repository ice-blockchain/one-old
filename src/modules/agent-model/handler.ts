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

  // New-project Phase 2 invariant: if the architect queued a Step-0
  // `opencode_delegate_from_plan` batch, no implementer may start until that
  // batch has reached a TERMINAL result for every queued role. The older
  // per-role gate below only covers roles configured to run on OpenCode
  // (frontend/tester/quick-fix by default), which let backend start while
  // frontend was blocked. This batch gate catches both implementers first.
  if (isPlanBatchGatedRole(role) && shouldBlockImplementerForPlanBatch(cwd, spawnRunId, state, ctx.host)) {
    const pendingPlanRoles = pendingOpenCodePlanRoles(cwd, spawnRunId, state, ctx.host);
    if (pendingPlanRoles.length > 0) {
      const denyContext = buildOpenCodePlanBatchDenyContext(cwd, spawnRunId, pendingPlanRoles);
      return deny(block('opencode-plan-batch-required', {
        ROLE: role,
        RUN_ID: spawnRunId,
        PROJECT_ROOT: cwd,
        QUEUED_ROLES: pendingPlanRoles.join(', '),
      }), denyContext ? { context: denyContext } : {});
    }
  }

  // OpenCode role delegation (all modes, paid hosts only): a configured role MUST run
  // on OpenCode first when delegation is enabled. Deny its paid spawn until
  // OpenCode has actually reached the CLI for this role in the current run — the
  // runner writes a per-run attempt marker at that point, after which the
  // fallback spawn is allowed. The marker is scoped by currentRunId; mint one
  // when absent so existing-codebase runs (and fresh/interrupted sessions that
  // skipped the orchestrator's Phase 0) still enforce — ensureRunAgentClaim
  // below is reached only on the new-project path. A freshly minted run id has
  // no marker yet, so this denies once (when the role has queued work) before
  // allowing the fallback.
  //
  // NO-DEADLOCK INVARIANT: the gate denies a (runId, role) at most ONCE. If the
  // opencode_delegate tool call can't complete for any reason (tool not yet
  // loaded, transient error), the attempt marker may never be written; without
  // the deny marker the delegate path AND the spawn path would both be blocked
  // forever. After one deny the next spawn attempt goes through as the fallback.
  // …force OpenCode-first only when there is actually work for it: EITHER the
  // architect QUEUED bounded units for this role (build phase — from-plan delivers
  // them → attempt marker → this gate clears) OR we are in MAINTENANCE (no plan queue,
  // but small single-role fixes are delegated ad hoc). A BUILD-phase forced role with
  // NOTHING queued has no batch work, so denying its paid spawn would TRAP it (the
  // batch can never mark it attempted) — let it proceed to the paid implementer.
  if (shouldRunRoleOnOpenCode(role, state, ctx.host)) {
    const runId = ensureCurrentRunId(cwd, state);
    if (runId && (roleHasQueuedUnits(cwd, role, runId) || isMaintenancePhase(state))
      && !openCodeRoleAttempted(cwd, runId, role)
      && !openCodePlanRoleCompleted(cwd, runId, role)
      && !openCodePlanBatchComplete(cwd, runId)
      && !openCodeGateDenied(cwd, runId, role)) {
      markOpenCodeGateDenied(cwd, runId, role);
      return deny(block('opencode-role-delegate', { ROLE: role, RUN_ID: runId, PROJECT_ROOT: cwd }));
    }
  }
  if (shouldRunRoleOnOpenCode(role, state, ctx.host) && spawnRunId
    && (openCodeGateDenied(cwd, spawnRunId, role)
      || openCodeRoleAttempted(cwd, spawnRunId, role)
      || openCodePlanRoleCompleted(cwd, spawnRunId, role)
      || openCodePlanBatchComplete(cwd, spawnRunId))) {
    recordOpenCodeFallback(cwd, spawnRunId, role, { status: 'paid_spawned' });
  }

  // Cursor startup failures can have no Task postToolUse/subagentStop at all.
  // Reconcile the child transcript now and enforce its persisted role-specific
  // retry even when the failed registry entry was already retired and this Task
  // carries no [t1-replace-agent] marker.
  const correlatedFailure = correlatedCursorFailureGate(
    ctx,
    cwd,
    spawnRunId,
    role,
    typeof toolInput.model === 'string' ? toolInput.model.trim() : '',
  );
  if (correlatedFailure) return correlatedFailure;

  // Subagent reuse (hosts with agent continuation): when this run already holds
  // a LIVE agent for the role, a fresh same-role spawn re-loads the entire
  // rules+skills context and re-explores the codebase — measured at 7 frontend
  // spawns in one build where 1 should have served. Deny the duplicate spawn and
  // point the orchestrator at the recorded agent id to continue via the host's
  // continuation primitive.
  // Escape hatch: a spawn prompt carrying REPLACE_AGENT_MARKER retires the
  // recorded agent (context exhausted / SendMessage errored) and passes through,
  // so the recorder can capture the replacement. Entries from another parent
  // session never match (liveRunAgent) — in-process agents die with their
  // session, so a resumed orchestrator spawns fresh without friction.
  if (subagentContinuationAvailable(process.env, ctx.host)) {
    const runId = typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
    if (runId) {
      // A spawn that ALREADY carries a continuation field is a RESUME — never deny
      // it, or the gate would block the very continuation it asks for. Cursor has
      // surfaced this as `resume` in live traces, while older docs/prose/models use
      // `agentId`; accept both. On Codex/Claude the continuation is a different tool
      // (followup_task/send_message / SendMessage), so spawn_agent/Task normally never carries these.
      const parentSessionId = hookSessionIdentity(raw).sessionId;
      let codexValidation: CodexLiveAgentValidation | null = null;
      const currentLive = (): ReturnType<typeof liveRunAgent> => {
        const live = liveRunAgent(cwd, runId, role, parentSessionId);
        if (ctx.host === 'codex' && live) {
          codexValidation = validateCodexLiveRunAgent(cwd, state, raw, runId, role, live);
          return codexValidation.status === 'verified-match' ? codexValidation.entry : null;
        }
        if (ctx.host !== 'cursor') return live;
        const resumeId = live ? continuationAgentId(live, ctx.host) : '';
        return resumeId
          ? live
          : (refreshCursorRunAgentFromTranscriptCache(cwd, state, raw, runId, role, parentSessionId) || live);
      };
      const codexValidationDeny = (): HookResult | null => {
        if (!codexValidation || (codexValidation.status !== 'unverified' && codexValidation.status !== 'conflict')) return null;
        return deny(block('agent-reuse-await-codex-meta', {
          ROLE: role,
          RUN_ID: runId,
          AGENT_ID: codexValidation.entry.agentId,
          REASON: codexValidation.reason,
          MARKER: REPLACE_AGENT_MARKER,
        }, `Agent-reuse gate: run ${runId} has a fresh Codex ${role} registry row for ${codexValidation.entry.agentId}, but Traffic One cannot verify that child's role from line-zero session metadata (${codexValidation.reason}). It will not route continuation to an unverified child or start a duplicate. Retry after the rollout is flushed, or use ${REPLACE_AGENT_MARKER} only when the child is genuinely unusable.`));
      };
      const concurrentCursorReplacementDeny = (): HookResult | null => {
        const concurrent = currentLive();
        if (!concurrent) return null;
        const concurrentResume = continuationAgentId(concurrent, 'cursor');
        if (!concurrentResume) {
          return deny(block('agent-reuse-await-cursor-id', {
            ROLE: role,
            RUN_ID: runId,
            MARKER: REPLACE_AGENT_MARKER,
          }));
        }
        const recipe = continuationRecipe('cursor', concurrentResume, role);
        return deny(block('agent-reuse-continue', {
          ROLE: role,
          RUN_ID: runId,
          AGENT_ID: concurrentResume,
          MARKER: REPLACE_AGENT_MARKER,
          CONTINUE_CALL: recipe.call,
          CONTINUE_TOOL: recipe.tool,
        }));
      };
      const explicitResumeToken = toolInput.agentId ?? toolInput.agent_id ?? (ctx.host === 'cursor' ? toolInput.resume : undefined);
      const resumeToken = explicitResumeToken;
      const isResume = typeof resumeToken === 'string' && resumeToken.trim().length > 0;
      if (isResume) {
        const conflict = verdictAgentConflict(cwd, runId, role, resumeToken);
        if (conflict) {
          return deny(`traffic-one — verifier independence gate: \`${role}\` cannot continue agent \`${String(resumeToken).trim()}\` because that id is already recorded for \`${conflict.role}\` in run \`${runId}\`. Spawn a fresh \`${role}\` verifier, or free a terminal implementer slot if the host active-agent cap is full. Same-role verifier continuation remains allowed.`);
        }
      }
      if (spawnPromptText.includes(REPLACE_AGENT_MARKER)) {
        const live = currentLive();
        const resumeTarget = live ? continuationAgentId(live, ctx.host) : '';
        const markerJustified = replacementJustified(spawnPromptText, ctx.host);
        const currentCodexValidation = codexValidation as CodexLiveAgentValidation | null;
        if (ctx.host === 'codex' && currentCodexValidation?.status === 'unverified') {
          if (!markerJustified || !retireUnverifiedCodexRunAgent(cwd, runId, role, currentCodexValidation.entry)) {
            const validationDeny = codexValidationDeny();
            if (validationDeny) return validationDeny;
          }
          codexValidation = null;
        }
        if (ctx.host === 'codex' && currentCodexValidation?.status === 'conflict') {
          const validationDeny = codexValidationDeny();
          if (validationDeny) return validationDeny;
        }
        const cursorAwaitingResume = ctx.host === 'cursor' && Boolean(live) && !resumeTarget;
        const liveModel = live && typeof live.model === 'string' ? live.model.trim() : '';
        // A retry prompt is orchestrator-authored and therefore can corroborate
        // that a no-resume Cursor child is dead after the 90s grace, but it is
        // not evidence that the named model actually ran or hit a limit. Only a
        // durable result (transcript/PostToolUse) in the per-role ledger may
        // condemn that model and trigger rotation. A marker with no failure
        // signal remains on the conservative 270s hard timer.
        const durableLiveModelExhaustion = cursorAwaitingResume
          && Boolean(liveModel)
          && modelIsExhausted(cwd, runId, role, liveModel);
        const markerCorroborated = markerJustified || durableLiveModelExhaustion;
        if (cursorAwaitingResume
          && !cursorAgentPresumedDead(live, { corroborated: markerCorroborated })) {
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
        }
        if (live && !cursorAwaitingResume && !markerJustified) {
          if (resumeTarget) {
            const recipe = continuationRecipe(ctx.host, resumeTarget, role);
            return deny(block('agent-reuse-continue', {
              ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
              CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
            }));
          }
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
        }
        // API/usage-limit replacement: the retired agent's model is DEAD for this
        // session. When Cursor omits post-Task events, this pre-spawn backstop still
        // forces the respawn onto the next
        // same-tier fallback instead of letting the orchestrator loop on the
        // exhausted model (observed: two senior-backend spawns on the same
        // gpt-5.6-terra-medium before it stumbled to Composer).
        // Resume-capable/structured records (and non-Cursor hosts) retain the
        // prompt backstop. A Cursor tool_<id> record without resume UUID reaches
        // rotation only when durable evidence already condemns its exact model.
        if (!cursorAwaitingResume || durableLiveModelExhaustion) {
          const rotate = exhaustedModelRotationDeny(ctx, cwd, runId, role, live, toolInput, spawnPromptText, state, {
            requireDurableEvidence: cursorAwaitingResume,
          });
          if (rotate) return rotate;
        }
        if (ctx.host === 'cursor' && live) {
          const retired = markRunAgentReplacedIfMatches(
            cwd,
            runId,
            role,
            live.toolCallId || live.agentId,
          );
          if (!retired) {
            const raced = concurrentCursorReplacementDeny();
            if (raced) return raced;
          }
        } else {
          markRunAgentReplaced(cwd, runId, role);
        }
      } else if (!isResume) {
        const live = currentLive();
        if (ctx.host === 'codex') {
          const validationDeny = codexValidationDeny();
          if (validationDeny) return validationDeny;
        }
        if (live) {
          const resumeTarget = continuationAgentId(live, ctx.host);
          if (!resumeTarget && ctx.host === 'cursor') {
            // The dead-agent escape: a Cursor agent that never surfaced a resume id
            // past the grace is presumed dead — retire it and ALLOW this retry to
            // spawn a fresh one, instead of deadlocking on await-cursor-id (which
            // tells the orchestrator to wait for a resume id that will never come).
            // Corroborated (retry names a failure/limit, or the role's exhaustion
            // ledger is non-empty) → 90s grace; a signal-less "continue" retry
            // waits for the hard window before the agent is presumed dead.
            const corroborated = replacementJustified(spawnPromptText, ctx.host)
              || isApiUsageLimitText(spawnPromptText)
              || (typeof live.model === 'string' && live.model.trim().length > 0
                && modelIsExhausted(cwd, runId, role, live.model.trim()));
            if (cursorAgentPresumedDead(live, { corroborated })) {
              const retired = markRunAgentReplacedIfMatches(
                cwd,
                runId,
                role,
                live.toolCallId || live.agentId,
              );
              if (!retired) {
                const raced = concurrentCursorReplacementDeny();
                if (raced) return raced;
              }
            } else {
              return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
            }
          } else {
            const recipe = continuationRecipe(ctx.host, resumeTarget, role);
            return deny(block('agent-reuse-continue', {
              ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
              CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
            }));
          }
        }
      }
    }
  }

  // quick-fix is the post-build maintenance worker: its cheapest-model pin is
  // enforced in EVERY mode — the per-role tier gate below is new-project-scoped,
  // but maintenance triage mostly fires on existing codebases — and the pin is
  // absolute (team.overrides cannot lift it). For Codex the requested parent
  // model is intent only: SubagentStart/child PreToolUse must verify the actual
  // model before any claim or reusable registry row is allowed to exist.
  if (role === 'quick-fix') {
    const expected = runPolicy?.roles['quick-fix']?.preferredModel
      || currentModelForTier('cheapest', ctx.host, detectHostPlan(ctx.host));
    const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (modelParamEnforced(ctx.host) && expected && !modelSatisfiesTier(ctx, passedModel, expected, runPolicy, role)) {
      return modelTierDeny(ctx, cwd, role, passedModel, expected, 'maintenance', { policy: runPolicy });
    }
    const exact = modelParamEnforced(ctx.host) && expected
      ? cursorExactModelDeny(ctx, cwd, role, passedModel, expected, 'maintenance', runPolicy)
      : null;
    if (exact) return exact;
    recordSpawnParentSession(cwd, raw);
    if (ctx.host !== 'codex') {
      ensureRunAgentClaim(cwd, state, role, raw, {
        toolName,
        agentType: spawnAgentType(toolInput) || undefined,
        model: passedModel || expected || '',
        roleSource: roleEvidence.source,
      });
    }
    return allowSpawn(noop());
  }

  const isNewProject = state.mode === 'new-project';
  if (isNewProject && !isCompletedTrafficOneMaterialization(cwd, state)) {
    materializeIfNeeded(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, readEffectiveState(cwd))) return deny(block('agent-materialization-deny'));
    return deny(block('agent-materialization-missing'));
  }

  const performance = obj(state.performance);
  const mutableLevel = performance && typeof performance.level === 'string' && PERFORMANCE_LEVEL_IDS.has(performance.level)
    ? performance.level
    : null;
  const level = runPolicy?.performanceLevel && PERFORMANCE_LEVEL_IDS.has(runPolicy.performanceLevel)
    ? runPolicy.performanceLevel
    : mutableLevel;
  if (!level) return allowSpawn(noop());

  if (teamModeForLevel(level) === 'main-agent') {
    return deny(block('performance-main-agent', { LEVEL: level, ROLE: role }));
  }
  if (!isTeamApproved(state.team)) {
    return deny(block('team-confirmation', { LEVEL: level }));
  }

  // Every active subagent run—greenfield or existing-codebase—must bind
  // implementers to the current run's semantic architecture input, runtime
  // compiled contracts, exact assignments, and PLAN_READY digest. A resilient
  // or sibling manifest is never authority for a v2 run.
  if (isPlanBatchGatedRole(role)) {
    const incomplete = architectPhaseIncompleteReasons(cwd, state);
    if (incomplete.length > 0) {
      return deny(block('architect-phase-incomplete', {
        ROLE: role,
        RUN_ID: spawnRunId,
        MISSING: incomplete.join('; '),
      }, ARCHITECT_PHASE_INCOMPLETE_FALLBACK));
    }
  }

  const team = obj(state.team);
  const overrides = runPolicy
    ? (runPolicy.teamOverrides as Rec)
    : team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const modelSelections = runPolicy
    ? null
    : team && obj(team.modelSelections) ? (team.modelSelections as Rec) : null;
  const planCtx = { host: ctx.host, plan: runPolicy?.plan || detectHostPlan(ctx.host) };

  // Cursor: the build's actual subagent model set — and its reasoning-variant slugs
  // (`-thinking-max`, `-extra-high`, …) — is plan/build-specific, and only the in-Cursor
  // orchestrator can enumerate it (no plan-scoped API). Require a FRESH capture (matching the
  // The immutable policy was created only after the current Cursor picker was
  // captured, so all model checks below use its frozen exact-slug list. A later
  // picker/catalog change affects the next run, never this one.

  const expected = runPolicy?.roles[role]?.preferredModel
    || modelForRoleHost(level, role, ctx.host, overrides, planCtx, process.env, modelSelections);
  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  const agentType = spawnAgentType(toolInput, { includeRoleAlias: false });
  if (ctx.host === 'opencode') {
    const expectedAgent = openCodeGlobalAgentName(cwd, role);
    if (!agentType || agentType !== expectedAgent || isBuiltinSubagent(agentType)) {
      return namedOpenCodeAgentDeny(cwd, role, agentType, expected || 'the configured role model');
    }
  }
  if (ctx.host === 'kilo' && agentType.toLowerCase() !== 'general') return kiloGeneralAgentDeny(role, agentType);
  // Cursor accepts the role's own agent OR the built-in generic worker (the
  // recovery path when this session's type list predates the materialized agent
  // files). A type that is neither is a misroute — the child would bind no role.
  // An ABSENT type stays allowed: some Cursor payloads omit it and the marker is
  // still authoritative.
  if (ctx.host === 'cursor' && agentType) {
    const accepted = acceptableSpawnTypes('cursor', role);
    if (!accepted.some((value) => value.toLowerCase() === agentType.toLowerCase())) {
      return cursorAgentTypeDeny(role, agentType);
    }
  }
  if (!expected) return allowSpawn(noop());
  if (!modelParamEnforced(ctx.host)) {
    recordSpawnParentSession(cwd, raw);
    ensureRunAgentClaim(cwd, state, role, raw, {
      toolName,
      agentType: spawnAgentType(toolInput) || undefined,
      model: passedModel || expected,
      roleSource: roleEvidence.source,
    });
    return allowSpawn(noop());
  }
  if (!modelSatisfiesTier(ctx, passedModel, expected, runPolicy, role)) {
    // No/wrong `model` arg → an orchestrator-actionable "pass model=X" deny (NOT a user-facing
    // budget/disabled choice — that is reserved for degradedToFloorDeny, the real Composer-floor
    // case). This is what unblocks a build that omitted the per-role model.
    return modelTierDeny(ctx, cwd, role, passedModel, expected, level, { policy: runPolicy });
  }
  const exact = cursorExactModelDeny(ctx, cwd, role, passedModel, expected, level, runPolicy);
  if (exact) return exact;

  // The model satisfies the tier — but the recommended model the user PICKED may not actually be
  // offered by this build (disabled in Settings → Models / not on plan), in which case the team is
  // about to run on a same-tier FALLBACK. Surface the choice ONCE so the user isn't silently
  // switched off their pick (the "I wasn't asked" gap — degradedToFloorDeny below only catches a
  // drop to the Composer floor, not a fallback to a valid alternate like Sonnet 5).
  const ineligible = preferredModelUnavailableDeny(ctx, cwd, spawnRunId, role, passedModel, expected, level, runPolicy);
  if (ineligible) return ineligible;

  // …and if a highest/balanced role is satisfied ONLY via the Composer floor, that's a silent
  // downgrade (API budget exhausted, or the recommended model disabled). Surface the choice ONCE
  // per run instead of quietly running the architect/implementers on Composer; no-deadlock proceeds.
  const degraded = degradedToFloorDeny(ctx, cwd, spawnRunId, role, passedModel, expected, level, runPolicy);
  if (degraded) return degraded;

  // First passing Cursor spawn of the run → one-time, USER-VISIBLE advisory naming the team's
  // models + the budget/enable remedy (a pinned model can silently fall to Composer at runtime).
  const advisory = maybeModelAdvisory(
    ctx,
    cwd,
    spawnRunId,
    level,
    overrides,
    modelSelections,
    planCtx,
    runPolicy,
  );

  recordSpawnParentSession(cwd, raw);
  if (ctx.host !== 'codex') {
    ensureRunAgentClaim(cwd, state, role, raw, {
      toolName,
      agentType: spawnAgentType(toolInput) || undefined,
      model: passedModel,
      roleSource: roleEvidence.source,
    });
  }
  return allowSpawn(advisory ?? noop());
}

export { ARCHITECT_PHASE_INCOMPLETE_FALLBACK, CURSOR_MODELS_CAPTURE_FALLBACK } from './handler-prose';
