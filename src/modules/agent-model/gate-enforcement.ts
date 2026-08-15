// src/modules/agent-model/gate-enforcement.ts
// The terminal phase of agentModelGate, extracted verbatim: the quick-fix
// cheapest-model pin, materialization/performance/team gates, per-role tier
// and exact-model enforcement, and the one-time advisories. Every ALLOW
// exits through g.allowSpawn.

import * as path from 'path';
import { obj, type Rec } from '../../shared/obj';
import {  deny, noop } from '../../core/result';
import { detectHostPlan } from '../../shared/host/plan';
import {  currentModelForTier } from '../../shared/current-model-tiers';
import { modelForRoleHost, teamModeForLevel } from '../../shared/performance';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import {
  ensureRunAgentClaimResult,
  isNewProjectMode,
  isTeamApproved,
  readEffectiveState,
  retryWhileUnavailable,
  statePath,
} from '../../shared/state';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { architectPhaseIncompleteReasons } from '../plan-guard/plan-readiness';
import { openCodeGlobalAgentName } from '../../shared/materialize/opencode-assets';
import { acceptableSpawnTypes } from '../../shared/host/spawn-types';
import {
  AGENT_MATERIALIZATION_MISSING_FALLBACK,
  SPAWN_CLAIM_UNAVAILABLE_FALLBACK,
  block,
  isPlanBatchGatedRole,
  materializationStampRefusedCause,
} from './handler-prose';
import {
  cursorAgentTypeDeny,
  isBuiltinSubagent,
  kiloGeneralAgentDeny,
  modelParamEnforced,
  modelSatisfiesTier,
  namedOpenCodeAgentDeny,
  spawnAgentType,
} from './spawn-shape';
import {
  recordSpawnParentSession,
} from './spawn-hygiene';
import {
  cursorExactModelDeny,
  degradedToFloorDeny,
  claudeInjectedTaskModel,
  maybeModelAdvisory,
  modelTierDeny,
  preferredModelUnavailableDeny,
} from './model-denies';
import type { HookResult } from '../../core/types';
import type { GateContext } from './gate-context';

function withClaudeModel(g: GateContext, passedModel: string, expected: string): string {
  if (passedModel || !expected) return passedModel;
  const injected = claudeInjectedTaskModel(g.ctx, expected, g.runPolicy, g.role);
  if (!injected) return passedModel;
  g.toolInput.model = injected;
  return injected;
}

/**
 * Mint the spawn's role claim, and refuse the spawn if it could not be RECORDED.
 *
 * This is the enforcement half of state/run-agent/mutation-result.ts's split
 * rule, at the only layer that holds a HookResult. All three claim mints in this
 * file discarded their result, so a contended claims/ledger lock or a refused
 * state write let the spawn through with no claim at all — and a child with no
 * claim resolves to no role, writes as the main agent, is invisible to the
 * duplicate-spawn gate, and is not released by the terminal sweep.
 *
 * `precondition-failed` returns null (spawn proceeds) and that is deliberate:
 * its two causes are a closed run — which the ledger gates already deny, with
 * the resume remedy — and the role's pending claim already existing, where a
 * claim for the role is on disk either way and the child will bind to it. That
 * second case is the Kilo corrective-spawn recovery, which must not be blocked.
 */
function claimMintDeny(g: GateContext, model: string): HookResult | null {
  const { cwd, state, raw, toolName, toolInput, role, roleEvidence, spawnRunId } = g;
  const minted = retryWhileUnavailable(() => ensureRunAgentClaimResult(cwd, state, role, raw, {
    toolName,
    agentType: spawnAgentType(toolInput) || undefined,
    model,
    roleSource: roleEvidence.source,
  }));
  if (minted.outcome !== 'unavailable') return null;
  return deny(block('spawn-claim-unavailable', {
    ROLE: role,
    RUN_ID: spawnRunId,
    REASON: minted.reason,
  }, SPAWN_CLAIM_UNAVAILABLE_FALLBACK), { denyId: 'spawn-claim-unavailable', denyTarget: role });
}

export function modelEnforcementGates(g: GateContext): HookResult {
  const { ctx, cwd, state, raw, toolName, toolInput, role, roleEvidence, spawnRunId, runPolicy, allowSpawn } = g;
  // quick-fix is the post-build maintenance worker: its cheapest-model pin is
  // enforced in EVERY mode — the per-role tier gate below is new-project-scoped,
  // but maintenance triage mostly fires on existing codebases — and the pin is
  // absolute (team.overrides cannot lift it). For Codex the requested parent
  // model is intent only: SubagentStart/child PreToolUse must verify the actual
  // model before any claim or reusable registry row is allowed to exist.
  if (role === 'quick-fix') {
    const expected = runPolicy?.roles['quick-fix']?.preferredModel
      || currentModelForTier('cheapest', ctx.host, detectHostPlan(ctx.host));
    const passedModel = withClaudeModel(g, typeof toolInput.model === 'string' ? toolInput.model.trim() : '', expected ?? '');
    if (modelParamEnforced(ctx.host) && expected && !modelSatisfiesTier(ctx, passedModel, expected, runPolicy, role)) {
      return modelTierDeny(ctx, cwd, role, passedModel, expected, 'maintenance', { policy: runPolicy });
    }
    const exact = modelParamEnforced(ctx.host) && expected
      ? cursorExactModelDeny(ctx, cwd, role, passedModel, expected, 'maintenance', runPolicy)
      : null;
    if (exact) return exact;
    recordSpawnParentSession(cwd, raw);
    if (ctx.host !== 'codex') {
      const unavailable = claimMintDeny(g, passedModel || expected || '');
      if (unavailable) return unavailable;
    }
    return allowSpawn(noop());
  }

  const isNewProject = isNewProjectMode(state);
  if (isNewProject && !isCompletedTrafficOneMaterialization(cwd, state)) {
    // The stamp's own answer, and it deliberately does NOT vote on which deny.
    // The read-back below is strictly stronger for that: it also catches a stamp
    // that landed over incomplete assets, and an already-stamped project whose
    // assets the sweep just restored under a REFUSED re-stamp — that project is
    // complete and owes the re-issue deny, which `stamped` alone would downgrade.
    // What only `stamped` can say is that this deny will REPEAT forever: a
    // refused stamp is durable, so every later spawn re-runs the full sweep and
    // lands here again with nothing on disk to show for it. Carried as the
    // denyTarget — the refused path itself — because that is the channel the
    // per-target deny budget and the decision record already read, and neither
    // deny's prose can name a cause it cannot see.
    //
    // `CAUSE` is the HUMAN-readable half of that same fact, rendered from the
    // same boolean so the two cannot disagree. `denyTarget` is a field: the
    // budget and the decision record read it, nothing says it aloud, so the
    // operator still faced a deny that recurs on every spawn with no reason
    // anywhere in the text. Only THIS arm carries it — the re-issue deny above
    // does not repeat, because its read-back says the project is materialized,
    // so the next spawn's `state` clears the check at the top of this branch and
    // never reaches here.
    const stamped = materializeIfNeeded(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, readEffectiveState(cwd))) return deny(block('agent-materialization-deny'), { denyId: 'agent-materialization-deny' });
    return deny(block('agent-materialization-missing', {
      CAUSE: stamped ? '' : materializationStampRefusedCause(statePath(cwd)),
    }, AGENT_MATERIALIZATION_MISSING_FALLBACK), {
      denyId: 'agent-materialization-missing',
      ...(stamped ? {} : { denyTarget: statePath(cwd) }),
    });
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
    return deny(block('performance-main-agent', { LEVEL: level, ROLE: role }), { denyId: 'performance-main-agent', denyTarget: role });
  }
  if (!isTeamApproved(state.team)) {
    return deny(block('team-confirmation', { LEVEL: level }), { denyId: 'team-confirmation' });
  }

  // Every active subagent run—greenfield or existing-codebase—must bind
  // implementers to the current run's semantic architecture input, runtime
  // compiled contracts, exact assignments, and PLAN_READY digest. A resilient
  // or sibling manifest is never authority for a v2 run.
  if (isPlanBatchGatedRole(role)) {
    const incomplete = architectPhaseIncompleteReasons(cwd, state);
    if (incomplete.length > 0) {
      // The block must LEAD with the exact next action: observed 8c, the
      // orchestrator mis-read this deny as a Step-0 request and burned a second
      // dead spawn. It carried a hand-transcribed copy of that paragraph here
      // until the two drifted; the generated table (shared/skill-fallbacks.generated.ts)
      // now renders the shipped wording on a torn install, so there is one text.
      return deny(block('architect-phase-incomplete', {
        ROLE: role,
        RUN_ID: spawnRunId,
        MISSING: incomplete.join('; '),
      }), { denyId: 'architect-phase-incomplete', denyTarget: role });
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
  const passedModel = withClaudeModel(g, typeof toolInput.model === 'string' ? toolInput.model.trim() : '', expected ?? '');
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
    const unavailable = claimMintDeny(g, passedModel || expected);
    if (unavailable) return unavailable;
    return allowSpawn(noop());
  }
  if (!modelSatisfiesTier(ctx, passedModel, expected, runPolicy, role)) {
    // Wrong `model` arg, or a host that cannot rewrite tool input. Claude
    // missing-model spawns are filled in `withClaudeModel` (updatedInput);
    // Cursor/Codex still land here because they have no rewrite channel.
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
    const unavailable = claimMintDeny(g, passedModel);
    if (unavailable) return unavailable;
  }
  return allowSpawn(advisory ?? noop());
}
