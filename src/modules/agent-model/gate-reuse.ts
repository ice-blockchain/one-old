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
import {
  exhaustedModelRotationDeny,
  replacementJustified,
  structuralReplacementGround,
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
        }, `Agent-reuse gate: run ${runId} has a fresh Codex ${role} registry row for ${codexValidation.entry.agentId}, but Traffic One cannot verify that child's role from line-zero session metadata (${codexValidation.reason}). It will not route continuation to an unverified child or start a duplicate. Retry: the reason above names what is being waited on — a child rollout that has not flushed yet, or a registry row another process held while this hook ran — and both clear without your intervention. Use ${REPLACE_AGENT_MARKER} only when the child is genuinely unusable.`),
          { denyId: 'agent-reuse-await-codex-meta', denyTarget: role });
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
          }), { denyId: 'agent-reuse-await-cursor-id', denyTarget: role });
        }
        const recipe = continuationRecipe('cursor', concurrentResume, role);
        return deny(block('agent-reuse-continue', {
          ROLE: role,
          RUN_ID: runId,
          AGENT_ID: concurrentResume,
          MARKER: REPLACE_AGENT_MARKER,
          CONTINUE_CALL: recipe.call,
          CONTINUE_TOOL: recipe.tool,
        }), { denyId: 'agent-reuse-continue', denyTarget: role });
      };
      const explicitResumeToken = toolInput.agentId ?? toolInput.agent_id ?? (ctx.host === 'cursor' ? toolInput.resume : undefined);
      const resumeToken = explicitResumeToken;
      const isResume = typeof resumeToken === 'string' && resumeToken.trim().length > 0;
      if (isResume) {
        const conflict = verdictAgentConflict(cwd, runId, role, resumeToken);
        if (conflict) {
          return deny(`traffic-one — verifier independence gate: \`${role}\` cannot continue agent \`${String(resumeToken).trim()}\` because that id is already recorded for \`${conflict.role}\` in run \`${runId}\`. Spawn a fresh \`${role}\` verifier, or free a terminal implementer slot if the host active-agent cap is full. Same-role verifier continuation remains allowed.`,
            { denyId: 'verifier-independence-gate', denyTarget: role });
        }
      }
      if (spawnPromptText.includes(REPLACE_AGENT_MARKER)) {
        const live = currentLive();
        const resumeTarget = live ? continuationAgentId(live, ctx.host) : '';
        const markerJustified = replacementJustified(spawnPromptText, ctx.host);
        const currentCodexValidation = codexValidation as CodexLiveAgentValidation | null;
        if (ctx.host === 'codex' && currentCodexValidation?.status === 'unverified') {
          // Deliberately NOT widened to structuralReplacementGround. That
          // predicate keys on `role` — the run's claim slot and this row's
          // recorded model — but `unverified` means Traffic One could not
          // confirm this child IS that role. Admitting it on role-keyed evidence
          // would let one role's closed ledger retire another role's child.
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
        // Facts the RUNTIME recorded about this agent and this run — a claim it
        // can never bind, or a durably condemned model — as opposed to the
        // orchestrator's own prose about itself. This is the authority the
        // marker should rest on; `markerJustified` survives only as the backstop
        // for context exhaustion, which nothing on disk can witness.
        const structuralGround = structuralReplacementGround(cwd, runId, role, live);
        const markerCorroborated = markerJustified
          || durableLiveModelExhaustion
          || structuralGround !== null;
        if (cursorAwaitingResume
          && !cursorAgentPresumedDead(live, { corroborated: markerCorroborated })) {
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }),
            { denyId: 'agent-reuse-await-cursor-id', denyTarget: role });
        }
        if (live && !cursorAwaitingResume && !markerJustified && structuralGround === null) {
          if (resumeTarget) {
            const recipe = continuationRecipe(ctx.host, resumeTarget, role);
            return deny(block('agent-reuse-continue', {
              ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
              CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
            }), { denyId: 'agent-reuse-continue', denyTarget: role });
          }
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }),
            { denyId: 'agent-reuse-await-cursor-id', denyTarget: role });
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
              || structuralReplacementGround(cwd, runId, role, live) !== null;
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
              return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }),
                { denyId: 'agent-reuse-await-cursor-id', denyTarget: role });
            }
          } else {
            const recipe = continuationRecipe(ctx.host, resumeTarget, role);
            return deny(block('agent-reuse-continue', {
              ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
              CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
            }), { denyId: 'agent-reuse-continue', denyTarget: role });
          }
        }
      }
    }
  }
  return null;
}
