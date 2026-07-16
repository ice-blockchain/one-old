// src/modules/agent-model/choice-reply.ts
// Late model-choice reply sweep (Cursor). The user's enable/fallback reply is
// parsed by session prompt-submit at priority 0 — but the pending state that
// recording requires may only be ARMED by the failure reconcile at priority 35
// on the SAME UserPromptSubmit event (an async child failure is classified
// there, which is when `model-choice-prompted` gets written). Without this
// sweep the FIRST reply is dropped and the user has to repeat it (the
// tests/cursor/13 dropped-fallback bug). Runs after the reconcile (priority
// 45): if a definite enable/fallback reply is still unrecorded but the choice
// is pending by now, record it here. Same fail-closed parser as prompt-submit;
// questions and diagnostics never record.

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { pluginRoot } from '../../shared/paths';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { clearExhaustedModels } from './exhausted-models';
import { modelChoiceReplyPending, parseModelChoice, writeModelChoice } from './model-choice';

const skillBlock = makeSkillBlock(pluginRoot);

// Record a pending enable/fallback reply for the current run. Returns the
// recorded-context result, or null when there is nothing to record (no run,
// nothing pending — modelChoiceReplyPending is false once a choice exists —
// or the prompt is not a definite choice). Shared by session prompt-submit
// (fast path) and the post-reconcile sweep below.
export function recordPendingModelChoiceReply(cwd: string, promptText: string): HookResult | null {
  const state = readEffectiveState(cwd);
  const runId = typeof state.currentRunId === 'string' && state.currentRunId.trim()
    ? state.currentRunId.trim() : '';
  if (!runId) return null;
  if (!modelChoiceReplyPending(cwd, state as Record<string, unknown>)) return null;
  const modelChoice = parseModelChoice(promptText);
  if (!modelChoice) return null;
  writeModelChoice(cwd, runId, modelChoice);
  // "enable" means the user fixed the budget / re-enabled the model — the
  // run's exhausted-model condemnations are stale by definition. Clearing
  // them lets the restored model actually be retried; keeping them would
  // immediately re-rotate the role off the model the user just restored.
  if (modelChoice === 'enable-retry') clearExhaustedModels(cwd, runId);
  const recordedBlock = modelChoice === 'enable-retry' ? 'model-choice-recorded-enable' : 'model-choice-recorded-fallback';
  return context(skillBlock('agent-model', recordedBlock, {}), { systemMessage: 'traffic-one: model choice recorded' });
}

export function modelChoiceReplySweep(ctx: Ctx): HookResult {
  if (ctx.host !== 'cursor') return noop();
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd) || pluginUseDeclined(cwd)) return noop();
  const promptText = ctx.input.prompt || promptTextFromSubmit(ctx.input.raw);
  if (!promptText) return noop();
  return recordPendingModelChoiceReply(cwd, promptText) || noop();
}
