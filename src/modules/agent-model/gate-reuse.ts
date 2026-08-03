// src/modules/agent-model/gate-reuse.ts
// The reuse/replace phase of agentModelGate, extracted verbatim: correlated
// Cursor failure enforcement, live-agent continuation denies, the
// [t1-replace-agent] escape hatch, and exhausted-model rotation. Returns a
// deny or null to continue.

import { context, deny } from '../../core/result';
import type {  HookResult } from '../../core/types';
import {  isApiUsageLimitText,  modelIsExhausted } from './exhausted-models';
import {
  continuationAgentId,
  type CodexLiveAgentValidation,
  hookSessionIdentity,
  liveRunAgent,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  refreshCursorRunAgentFromTranscriptCache,
  REPLACE_AGENT_MARKER,
  retireUnverifiedCodexRunAgent,
  runLedgerAdmitsClaims,
  runRoleHasBoundClaim,
  subagentContinuationAvailable,
  validateCodexLiveRunAgent,
  verdictAgentConflict,
} from '../../shared/state';
import {
  correlatedCursorFailureGate,
} from './cursor-failures';
import { cursorAgentPresumedDead } from './cursor-liveness';
import {
  block,
} from './handler-prose';
import {
  continuationRecipe,
} from './spawn-hygiene';
import { quickFixScopeFromSpawn } from './spawn-shape';
import {
  readCompiledArchitecture,
  readRuntimeAssignments,
} from '../../shared/architecture-contract';
import {
  ensureRunBootstrap,
  readActiveRunBootstrap,
  roleOwesPendingMaintenanceFallback,
} from '../../shared/run-bootstrap-policy';
import { canonicalHost } from '../../shared/model-tiers';
import {
  exhaustedModelRotationDeny,
  replacementJustified,
} from './model-rotation';
import type { GateContext } from './gate-context';

export function reuseReplaceGates(g: GateContext): HookResult | null {
  const { ctx, cwd, state, raw, toolInput, role, spawnRunId, spawnPromptText } = g;
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
        // A raced retire can still be a scope-widening re-spawn: republish the
        // envelope and point at the CONCURRENT live agent instead.
        const regrant = boundedScopeRegrantDeny(g, runId, role, concurrentResume);
        if (regrant) return regrant;
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
        // The registry records an agent when it is SPAWNED, not when it binds a
        // role, so "live" can name a child that never resolved its role and
        // never will — every write it attempts is denied as the main agent.
        // When that child holds no claim AND the run itself can no longer admit
        // one, replacement is the only move left, and the orchestrator has no
        // failure vocabulary for it: `replacementJustified` looks for exhausted
        // context or API limits, so the marker was refused forever and the
        // build had no exit. BOTH conditions are required — a claimless agent in
        // a healthy run may simply be mid-startup and stays protected.
        const unbindableLive = Boolean(live)
          && !runRoleHasBoundClaim(cwd, runId, role)
          && !runLedgerAdmitsClaims(cwd, runId);
        if (cursorAwaitingResume
          && !cursorAgentPresumedDead(live, { corroborated: markerCorroborated })) {
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
        }
        if (live && !cursorAwaitingResume && !markerJustified && !unbindableLive) {
          if (resumeTarget) {
            const regrant = boundedScopeRegrantDeny(g, runId, role, resumeTarget);
            if (regrant) return regrant;
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
            const regrant = boundedScopeRegrantDeny(g, runId, role, resumeTarget);
            if (regrant) return regrant;
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
  return null;
}

// Scope-REGRANT on a duplicate spawn. A parent re-spawn that carries an
// explicit `[t1-bounded-scope]`/allowedFiles for a bounded-capable role in an
// assignment-less run is not a respawn attempt — it is the sanctioned way to
// WIDEN the live agent's bounded WorkUnit after a write was denied on a
// task-related path the original allowlist missed (observed: senior-backend
// blocked on server/modules/trades/trade.model.js in a maintenance small-tier
// run, with no mechanical way to extend the contract). Republish the envelope
// with the submitted scope, then STILL deny the spawn — pointing at the live
// agent, which retries its write under the new contract. Compiled runs are
// untouched: the architect owns their scope, so published assignments disable
// this path entirely. A pending fallback debt also blocks it (the envelope
// publisher refuses a contract that does not hash-match the debt).
function boundedScopeRegrantDeny(
  g: GateContext,
  runId: string,
  role: string,
  resumeTarget: string,
): HookResult | null {
  if (role !== 'quick-fix' && role !== 'senior-frontend' && role !== 'senior-backend') return null;
  if (!g.runPolicy) return null;
  const scope = quickFixScopeFromSpawn(g.toolInput, g.spawnPromptText);
  if (!scope.present || !scope.valid || scope.outputs.length === 0) return null;
  // "Compiled" is assignments OR compiled architecture — a corrupt sidecar on
  // a compiled run must not let a marker spawn clobber the architect's scope.
  if (readRuntimeAssignments(g.cwd, runId)) return null;
  if (readCompiledArchitecture(g.cwd, runId)) return null;
  // A pending OpenCode fallback pins the contract: fallbackContractMatches
  // refuses any widened set until the debt settles, so ensureRunBootstrap below
  // would fail silently and the parent would loop on the plain continue deny.
  // Name the debt and the real exit instead.
  if (roleOwesPendingMaintenanceFallback(g.cwd, runId, role)) {
    const debtRecipe = continuationRecipe(g.ctx.host, resumeTarget, role);
    return deny(block('agent-reuse-scope-debt', {
      ROLE: role,
      RUN_ID: runId,
      AGENT_ID: resumeTarget,
      PATHS: scope.outputs.join(', '),
      CONTINUE_CALL: debtRecipe.call,
      CONTINUE_TOOL: debtRecipe.tool,
    }, `traffic-one — scope widening BLOCKED by a pending OpenCode fallback: run ${runId} still owes the delegated \`${role}\` unit, and the bounded WorkUnitContract cannot change until that debt settles. Do NOT respawn. A live \`${role}\` agent exists (${resumeTarget}) — continue it via ${debtRecipe.tool}: ${debtRecipe.call} — tell it to finish every deliverable inside its CURRENT contract and report \`BLOCKED: needs scope on ${scope.outputs.join(', ')}\` for anything outside it. After the unit is delivered and settled, start the extra path(s) as their OWN bounded task.`));
  }
  const active = readActiveRunBootstrap(g.cwd, runId, role);
  const envelope = ensureRunBootstrap(g.cwd, runId, role, g.state, {
    host: canonicalHost(g.ctx.host),
    hostAgentType: active?.hostAgentType || null,
    evidenceSource: 'bounded-scope-regrant',
    modelPolicyId: g.runPolicy.policyId,
    boundedOutputs: scope.outputs,
    boundedAllowlist: scope.allowlist,
    boundedAllowlistExclude: scope.exclude,
  });
  if (!envelope) return null;
  const recipe = continuationRecipe(g.ctx.host, resumeTarget, role);
  return deny(block('agent-reuse-scope-regrant', {
    ROLE: role,
    RUN_ID: runId,
    AGENT_ID: resumeTarget,
    PATHS: scope.outputs.join(', '),
    CONTINUE_CALL: recipe.call,
    CONTINUE_TOOL: recipe.tool,
  }, `traffic-one — scope REGRANTED, no spawn needed: the bounded WorkUnit for \`${role}\` in run ${runId} now covers: ${scope.outputs.join(', ')}. A live \`${role}\` agent already exists (${resumeTarget}) — do NOT respawn or replace it. Continue it now via ${recipe.tool}: ${recipe.call} — tell it the scope was widened to include the previously denied path(s), to retry the exact write, then finish the task and its digest.`));
}
