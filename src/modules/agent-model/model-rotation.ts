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
  type RunAgentEntry,
  runLedgerAdmitsClaims,
  runRoleHasBoundClaim,
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
      { denyId: 'model-rotation-policy-missing', denyTarget: runId },
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
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-composer-choice']), { denyId: 'cursor-api-limit-composer-choice', denyTarget: role });
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
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-terminal']), { denyId: 'cursor-api-limit-terminal', denyTarget: role });
    }
    const missing = row.find((family) => !captured.some((slug) => modelMatchesAny(slug, [family]))
      && !modelIsExhausted(cwd, runId, role, family));
    return deny(
      missing
        ? `traffic-one — ${role}'s API-limit retry has no exact captured candidate left in its original ${tier} tier. Model family "${missing}" is absent from Cursor's captured list, so use the model-availability flow (Settings → Models / re-capture); do not mark all models exhausted and do not change tiers.`
        : `traffic-one — ${role}'s API-limit retry has no eligible model left in its original ${tier} tier. Stop retrying until the user restores API budget or enables another exact tier model.`,
      missing
        ? { denyId: 'model-rotation-tier-missing-from-catalog', denyTarget: role }
        : { denyId: 'model-rotation-tier-exhausted', denyTarget: role },
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
    { denyId: 'model-rotation-exhausted-model', denyTarget: role },
  );
}

/**
 * The STRUCTURAL grounds on which `[t1-replace-agent]` is honoured against a
 * live registry row: facts the RUNTIME recorded about the agent and the run,
 * never vocabulary the orchestrator wrote about itself. `replacementJustified`
 * below decides from the caller's own prose, which makes the authority to retire
 * an agent a function of word choice; everything here is disk state written by
 * the recorder, the claim store, or the ledger.
 */
export type StructuralReplacementGround = 'unbindable-agent' | 'condemned-model';

export function structuralReplacementGround(
  cwd: string,
  runId: string,
  role: string,
  live: RunAgentEntry | null,
): StructuralReplacementGround | null {
  if (!live || !runId || !role) return null;
  // The registry records an agent when it is SPAWNED, not when it binds a role,
  // so a live row can name a child that never resolved its role and never will —
  // every write it attempts is denied as the main agent. BOTH conditions are
  // required: a claimless agent in a run that still admits claims may simply be
  // mid-startup, and a PENDING claim already counts as bound, so a child that is
  // binding right now is never replaced out from under itself.
  if (!runRoleHasBoundClaim(cwd, runId, role) && !runLedgerAdmitsClaims(cwd, runId)) {
    return 'unbindable-agent';
  }
  // The role's exhaustion ledger condemns the exact model this agent is running.
  // Continuing it re-issues work on a model already known to be out of budget,
  // which is the loop the rotation deny exists to break. Model-SPECIFIC on
  // purpose: another model condemned for the same role says nothing about the
  // child now running.
  //
  // Do NOT read this ledger as runtime-only evidence. Most writers are durable
  // results (record-agent's stop event, Cursor child-transcript reconciliation),
  // but exhaustedModelRotationDeny ALSO writes it from `isApiUsageLimitText` on
  // the spawn prompt whenever its `requireDurableEvidence` is false — which its
  // single caller sets to `cursorAwaitingResume`, so the prose path is live on
  // every other route. That is deliberate product behaviour, not a leak: Cursor
  // can omit post-Task events entirely, leaving the prompt the only channel
  // carrying an api-limit. The consequence to keep in view is that this ground
  // is reachable from orchestrator prose across two invocations (one to write
  // the ledger, one to read it). It stays sound anyway, because the same prose
  // already grants the same authority directly through the dead-agent escape's
  // own `isApiUsageLimitText` disjunct, and because the verdict it produces —
  // do not keep talking to an agent whose model the run recorded as exhausted —
  // is the correct one whichever channel reported the limit.
  const model = typeof live.model === 'string' ? live.model.trim() : '';
  if (model && modelIsExhausted(cwd, runId, role, model)) return 'condemned-model';
  return null;
}

// Context exhaustion has NO structural signal: the agent is alive, holds its
// claim, and only the orchestrator's reading of its replies reveals that the
// window is full. No ledger, registry row, or transcript records it, so
// structuralReplacementGround cannot cover it and refusing the marker for it
// strands the run with no exit. These patterns are therefore the backstop for
// the failures the runtime cannot observe for itself — deliberately permissive,
// because a refused legitimate replacement costs the whole build while a
// believed illegitimate one costs a re-loaded context.
//
// The old vocabulary accepted `context exhausted` but not `context exhaustion`,
// the exact phrase the gate's own SKILL.md prose prescribes — so an orchestrator
// following the shipped instruction verbatim was refused.
const CONTEXT_EXHAUSTION_RE = new RegExp(
  String.raw`\bcontext\s+(?:exhaust(?:ed|ion)|limit|window\s+(?:full|exceeded))\b`
  + '|' + String.raw`\bexhausted\s+(?:its\s+|the\s+)?context\b`
  + '|' + String.raw`\bout\s+of\s+context\b`,
  'i',
);

// A continuation call that errored. The old vocabulary matched only the
// idealised phrase "agent not found" quoted in SKILL.md, so every realistic
// rendering with an id interpolated ("Agent <uuid> not found") missed it.
const CONTINUATION_FAILURE_RE = new RegExp(
  String.raw`\b(?:resume|resuming|continuation|follow[- ]?up|send[- ]?message)\s+(?:has\s+)?(?:failed|errored)\b`
  + '|' + String.raw`\b(?:couldn'?t|could\s+not|cannot|can'?t|unable\s+to)\s+(?:continue|resume)\b`
  + '|' + String.raw`\bno\s+(?:such\s+)?agent\s+(?:found|exists)\b`
  + '|' + String.raw`\b(?:couldn'?t|could\s+not|unable\s+to)\s+find\s+[^.;\n]{0,20}?\bagent\b`
  + '|' + String.raw`\b(?:sub)?agent\b[^.;\n]{0,60}?\b(?:not\s+found|does\s+not\s+exist|no\s+longer\s+(?:exists|available)|unavailable|unknown)\b`,
  'i',
);

// The agent itself is gone. This arm used to be a list of BARE words — `dead`,
// `stale`, `closed`, `stopped`, `aborted`, `interrupted` — which made
// "Remove the dead code in utils.ts" and "The GitHub issue was closed" both
// sufficient to retire a healthy agent (measured, not inferred). A death word
// with no subject is evidence in neither direction, so require it to be
// predicated of the AGENT; the few words that never occur benignly in build
// prose still stand alone.
const AGENT_DEATH_RE = new RegExp(
  String.raw`\b(?:the\s+|its\s+|that\s+|previous\s+|existing\s+|current\s+|old\s+)*`
  + String.raw`(?:sub)?(?:agent|child|worker|task|thread|it)\s+`
  + String.raw`(?:has\s+|had\s+|is\s+|was\s+|went\s+|gone\s+|already\s+|never\s+)*`
  + String.raw`(?:dead|stale|closed|stopped|aborted|interrupted|unresponsive|hung|frozen|crashed|gone|silent)\b`
  + '|' + String.raw`\b(?:unresponsive|hung|frozen|(?:no\s+longer|stopped)\s+responding)\b`,
  'i',
);

export function replacementJustified(prompt: string, host = ''): boolean {
  if ((host === 'opencode' || host === 'kilo' || host === 'windsurf')
    && /\b(previous|existing|current)\s+(opencode\s+)?(agent|task|subagent)\s+(completed|finished|returned|ended)\b|\bfix[- ]cycle\b|\bfollow[- ]up\b|\bno\s+resum(?:e|able|able\s+task)\b|\bcontinuation\s+(unavailable|unsupported)\b/i.test(prompt)) {
    return true;
  }
  // api/usage-limit vocabulary: a subagent stopped mid-run by provider limits is
  // dead for this session — continuation would re-hit the same limit. The
  // PostToolUse recorder also retires such agents proactively; this keeps the
  // replace path open when the result carried no classifiable text.
  if (isApiUsageLimitText(prompt)) return true;
  return CONTEXT_EXHAUSTION_RE.test(prompt)
    || CONTINUATION_FAILURE_RE.test(prompt)
    || AGENT_DEATH_RE.test(prompt);
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
  return deny(block('model-choice-enable-required', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }),
    { denyId: 'model-choice-enable-required', denyTarget: role });
}
