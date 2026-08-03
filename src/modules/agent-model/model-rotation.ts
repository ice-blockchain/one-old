// src/modules/agent-model/model-rotation.ts
// Exhausted-model rotation and replacement justification.

import * as path from 'path';
import {  type Rec } from '../../shared/obj';
import { context, deny } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { modelMatchesAny } from '../../shared/model-tiers';
import { CURSOR_MODEL_FLOOR } from '../../config/model-tiers';
import { exhaustedModelsForRole, isApiUsageLimitText, markModelExhaustionTerminal, modelIsExhausted, recordExhaustedModel } from './exhausted-models';
import {
  pickCursorSlug,
} from '../../shared/materialize/cursor-models';
import {
  markModelChoicePrompted,
  type ModelChoiceStatus,
  readModelChoice,
} from './model-choice';
import {
  liveRunAgent,
  REPLACE_AGENT_MARKER,
} from '../../shared/state';
import {
  CURSOR_FAILURE_BLOCK_FALLBACKS,
} from './cursor-failures';
import {
  readRunModelPolicy,
  resolveRunPolicyFallback,
} from '../../shared/run-model-policy';

import {
  block,
} from './handler-prose';
import {
  modelParamEnforced,
} from './spawn-shape';

export function exhaustedModelRotationDeny(
  ctx: Ctx,
  cwd: string,
  runId: string,
  role: string,
  live: ReturnType<typeof liveRunAgent>,
  toolInput: Rec,
  spawnPromptText: string,
  state: Rec,
  opts: { requireDurableEvidence?: boolean } = {},
): HookResult | null {
  if (!runId || !modelParamEnforced(ctx.host)) return null;
  // The retired agent's model is the one that actually hit the limit — the only
  // model we KNOW is exhausted. With no live agent (nothing recorded to be dead)
  // there is nothing to rotate off, so a replacement passes normally.
  const anchor = (live && typeof live.model === 'string' ? live.model : '').trim();
  if (!anchor) return null;
  const durableEvidence = modelIsExhausted(cwd, runId, role, anchor);
  if (opts.requireDurableEvidence ? !durableEvidence : !isApiUsageLimitText(spawnPromptText)) return null;
  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  const exhausted = opts.requireDurableEvidence
    ? exhaustedModelsForRole(cwd, runId, role)
    : recordExhaustedModel(cwd, runId, role, anchor);
  if (passedModel && !modelIsExhausted(cwd, runId, role, passedModel)) return null; // already rotated → allow
  // The next model to use: the first tier-row family that is (a) not condemned in
  // the exhaustion ledger and (b) actually OFFERED by this build (captured slug on
  // Cursor). Resolving each family to its OWN slug via pickCursorSlug — NOT
  // cursorRealSlug, which resolves through the whole tier row (that row starts
  // with the exhausted family, so it would hand back the very model we're
  // rotating off).
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy) {
    return deny(
      `traffic-one — model rotation blocked: immutable model-policy.json is missing for run ${runId}. `
      + 'Do not resolve a replacement from mutable machine-global models; start a repaired parent run first.',
    );
  }
  const captured = ctx.host === 'cursor' ? [...(policy.cursorAvailableModels || [])] : [];
  const level = policy.performanceLevel;
  const tier = policy.roles[role]?.tier || (role === 'quick-fix' ? 'cheapest' : null);
  if (!tier) return null;
  const candidate = resolveRunPolicyFallback(policy, {
    tier,
    exhaustedModels: exhausted,
    ...(ctx.host === 'cursor' ? { capturedModels: captured } : {}),
  });
  let fallbackFamily = candidate?.family || '';
  let fallback = candidate?.model || '';
  // A SAME-TIER swap costs no quality, so it rotates automatically. A drop to
  // the Composer FLOOR — or no offered model left at all — is a REAL downgrade
  // the user owns: route it through the SAME enable/fallback choice the
  // pre-spawn guards use (shared once-per-run marker + model-choice.json; the
  // model-choice gate pauses the build until the reply lands). "enable" also
  // clears the exhaustion ledger (prompt-submit), so the restored model is
  // retried instead of re-rotated off.
  if (ctx.host === 'cursor' && isComposerFamily(fallbackFamily) && tier !== 'cheapest') {
    const floorSlug = (captured.length ? pickCursorSlug([CURSOR_MODEL_FLOOR], captured) : '') || CURSOR_MODEL_FLOOR;
    const choice = fallbackAlreadyAllowed(cwd, runId);
    if (choice === 'enable-retry') return modelEnableRetryDeny(ctx, role, level, passedModel, anchor);
    if (choice !== 'use-fallback') {
      markModelChoicePrompted(cwd, runId);
      return deny(block('cursor-api-limit-composer-choice', {
        ROLE: role,
        RECOMMENDED: anchor,
        FALLBACK: floorSlug,
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-composer-choice']));
    }
    fallback = floorSlug; // user already accepted the fallback → prescribe the floor below
  }
  if (!fallbackFamily) {
    const row = policy.tiers[tier];
    const allActuallyLimited = row.length > 0 && row.every((family) => modelIsExhausted(cwd, runId, role, family));
    const composerAccepted = tier === 'cheapest' || fallbackAlreadyAllowed(cwd, runId) === 'use-fallback';
    if (allActuallyLimited && composerAccepted) {
      markModelExhaustionTerminal(cwd, runId, role);
      return deny(block('cursor-api-limit-terminal', {
        ROLE: role,
        TRIED: exhausted.join(', '),
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-terminal']));
    }
    const missing = row.find((family) => !captured.some((slug) => modelMatchesAny(slug, [family]))
      && !modelIsExhausted(cwd, runId, role, family));
    return deny(
      missing
        ? `traffic-one — ${role}'s API-limit retry has no exact captured candidate left in its original ${tier} tier. Model family "${missing}" is absent from Cursor's captured list, so use the model-availability flow (Settings → Models / re-capture); do not mark all models exhausted and do not change tiers.`
        : `traffic-one — ${role}'s API-limit retry has no eligible model left in its original ${tier} tier. Stop retrying until the user restores API budget or enables another exact tier model.`,
    );
  }
  const passedNote = passedModel
    ? `You passed model="${passedModel}", which is exhausted this session.`
    : 'You passed no `model`, so the subagent would inherit the parent model.';
  const fallbackNote = fallback
    ? `Re-send the SAME ${role} task with ${REPLACE_AGENT_MARKER} on the first line and model="${fallback}" (the next same-tier model still available).`
    : `Re-send the SAME ${role} task with ${REPLACE_AGENT_MARKER} on the first line and a DIFFERENT same-tier model — every model in this tier's chain is exhausted, so drop to the next lower tier or ask the user to enable a model.`;
  return deny(
    `traffic-one — model rotation: ${role}'s previous subagent stopped on an API/usage limit, so ${anchor} is exhausted for this session and must not be re-used. ${passedNote} ${fallbackNote} `
    + 'Resume from whatever the stopped agent already completed instead of restarting from scratch.',
  );
}

export function replacementJustified(prompt: string, host = ''): boolean {
  if ((host === 'opencode' || host === 'kilo' || host === 'windsurf')
    && /\b(previous|existing|current)\s+(opencode\s+)?(agent|task|subagent)\s+(completed|finished|returned|ended)\b|\bfix[- ]cycle\b|\bfollow[- ]up\b|\bno\s+resum(?:e|able|able\s+task)\b|\bcontinuation\s+(unavailable|unsupported)\b/i.test(prompt)) {
    return true;
  }
  if (isApiUsageLimitText(prompt)) return true;
  // api/usage-limit vocabulary: a subagent stopped mid-run by provider limits is
  // dead for this session — continuation would re-hit the same limit. The
  // PostToolUse recorder also retires such agents proactively; this keeps the
  // replace path open when the result carried no classifiable text.
  return /\b(context exhausted|context limit|agent not found|resume failed|continuation failed|couldn'?t continue|could not continue|unresponsive|dead|stale|closed|stopped|aborted|interrupted)\b/i
    .test(prompt);
}

// On Cursor a tier's `expected` is a bare model FAMILY (e.g. claude-fable-5). Map it to the
// CONCRETE build slug the user's runner offers — the first captured model whose family matches
// the family or a same-tier alternate — so deny/advisory prose names an EXACT slug Cursor
// accepts. Falls back to the family when nothing is captured (or the build offers nothing in

export function isComposerFamily(model: string): boolean {
  return /^composer/i.test(model.trim());
}
export function fallbackAlreadyAllowed(cwd: string, runId: string): ModelChoiceStatus | null {
  return readModelChoice(cwd, runId);
}
export function modelEnableRetryDeny(ctx: Ctx, role: string, level: string, passedModel: string, expected: string): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}".`
    : 'You passed no `model` parameter, so the subagent would inherit the parent model.';
  return deny(block('model-choice-enable-required', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
}
