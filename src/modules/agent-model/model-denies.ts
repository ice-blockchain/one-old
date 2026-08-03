// src/modules/agent-model/model-denies.ts
// Model tier/choice/advisory deny builders over the frozen run policy.

import * as path from 'path';
import {  type Rec } from '../../shared/obj';
import { context, deny } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { detectHostPlan } from '../../shared/host/plan';
import { modelMatchesAny } from '../../shared/model-tiers';
import { CURSOR_MODEL_FLOOR } from '../../config/model-tiers';
import { currentAcceptableModels } from '../../shared/current-model-tiers';
import {
  freshCursorModels,
  pickCursorSlug,
} from '../../shared/materialize/cursor-models';
import { modelForRoleHost,  type PlanCtx } from '../../shared/performance';
import { AGENT_ROLES } from '../../config/performance';
import { modelUnavailablePromptRequest } from '../../shared/prompt-request';
import {
  markModelAdvisoryShown,
  markModelChoicePrompted,
  modelAdvisoryShown,
} from './model-choice';
import {
  policyModelsForExpected,
  type RunModelPolicyV1,
} from '../../shared/run-model-policy';

import {
  block,
} from './handler-prose';
import {
  modelSatisfiesTier,
} from './spawn-shape';
import { isComposerFamily, fallbackAlreadyAllowed, modelEnableRetryDeny } from './model-rotation';

function cursorRealSlug(
  ctx: Ctx,
  cwd: string,
  family: string,
  policy: RunModelPolicyV1 | null = null,
  role?: string,
): string {
  if (ctx.host !== 'cursor' || !family) return family;
  const captured = policy
    ? [...(policy.cursorAvailableModels || [])]
    : freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length) return family;
  const acceptable = policy
    ? (role && policy.roles[role]?.acceptableModels) || policyModelsForExpected(policy, family)
    : currentAcceptableModels(family, ctx.host, detectHostPlan(ctx.host));
  return pickCursorSlug(acceptable, captured) || family;
}

// Claude Code's Task tool schema accepts ONLY the bare aliases
// (sonnet|opus|haiku|fable) as the `model` parameter — a concrete catalog slug
// like "claude-sonnet-5" fails the host's input validation before any hook
// runs. The catalog rows keep the bare alias at their tail precisely so alias
// spawns are ACCEPTED by the gate; but the deny used to LEAD with the concrete
// slug, and a literal-minded parent obeyed it straight into an
// InputValidationError before reading the alternates clause (observed live:
// ep-new-feature run 1785662486571). Lead with the model the schema can take.
function claudeTaskParamModel(host: string, expected: string, acceptable: readonly string[]): string {
  if (host !== 'claude') return expected;
  const bare = acceptable.find((model) => /^(sonnet|opus|haiku|fable)$/.test(model.trim()));
  if (bare) return bare.trim();
  const lowered = expected.toLowerCase();
  const alias = ['fable', 'opus', 'sonnet', 'haiku'].find((a) => lowered.includes(a));
  return alias || expected;
}

export function modelTierDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string, opts: { suppressAlternates?: boolean; policy?: RunModelPolicyV1 | null } = {}): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}". `
    : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
  // `expected` + alternates are FAMILY anchors; on Cursor name the concrete build slug for each
  // (resolved from the captured list) so the orchestrator passes an exact id Cursor offers,
  // never an uncaptured family guess. suppressAlternates: after "enable & retry" we don't
  // advertise fallbacks. A captured exact id may legitimately equal its family anchor.
  const policy = opts.policy || null;
  const captured = ctx.host === 'cursor'
    ? (policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, detectHostPlan(ctx.host)))
    : [];
  const acceptable = policy
    ? policy.roles[role]?.acceptableModels || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  const shownExpected = claudeTaskParamModel(
    ctx.host,
    cursorRealSlug(ctx, cwd, expected, policy, role),
    acceptable,
  );
  const altFamilies = opts.suppressAlternates ? [] : acceptable.slice(1);
  const altModels = altFamilies
    .map((f) => (captured.length ? pickCursorSlug([f], captured) : f))
    .filter((s): s is string => typeof s === 'string' && s.length > 0 && s !== shownExpected);
  const altNote = altModels.length
    ? ` If this host's subagent runner does NOT offer "${shownExpected}" (it rejects an unavailable slug as invalid), pass instead the FIRST of these same-tier models the runner DOES offer — any of them satisfies the gate: ${altModels.join(', ')}.`
    : '';
  return deny(block('performance-model-param', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: shownExpected, PASSED_NOTE: passedNote, ALTERNATES: altNote }));
}

export function cursorExactModelDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
  if (ctx.host !== 'cursor' || !passedModel) return null;
  const captured = policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length || captured.includes(passedModel)) return null;
  const acceptable = policy
    ? policy.roles[role]?.acceptableModels || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  if (!modelMatchesAny(passedModel, acceptable)) return null;
  const exact = pickCursorSlug(acceptable, captured) || cursorRealSlug(ctx, cwd, expected, policy, role);
  return deny(block('cursor-exact-model-required', {
    LEVEL: level,
    ROLE: role,
    PASSED: passedModel,
    EXPECTED: exact,
    CAPTURED: captured.join(', '),
  }));
}

// The "next eligible" model for a tier: the concrete build slug of the first same-tier
// alternate FAMILY (resolved from the captured list on Cursor), or the resolved expected
// when there is no alternate.
function fallbackModelFor(
  ctx: Ctx,
  cwd: string,
  role: string,
  expected: string,
  policy: RunModelPolicyV1 | null = null,
): string {
  const acceptable = policy
    ? policy.roles[role]?.acceptableModels || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  const altFamilies = acceptable.slice(1);
  if (ctx.host === 'cursor') {
    const captured = policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, detectHostPlan(ctx.host));
    if (captured.length) {
      const offered = pickCursorSlug(altFamilies, captured);
      if (offered) return offered;
    }
  }
  const altFamily = altFamilies[0];
  return altFamily
    ? cursorRealSlug(ctx, cwd, altFamily, policy, role)
    : cursorRealSlug(ctx, cwd, expected, policy, role);
}

// The recommended-model-unavailable choice deny (the budget/disabled CHOICE for the
// degraded-to-Composer path). Names both possible causes (budget exhausted / disabled) and the
// fallback; rides the deny reason on Cursor/Codex and a promptRequest modal on Claude.
function modelChoiceDeny(ctx: Ctx, role: string, level: string, shownExpected: string, fallback: string): HookResult {
  const reason = block('model-unavailable-choice', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: shownExpected, FALLBACK: fallback });
  return deny(reason, { promptRequest: modelUnavailablePromptRequest(shownExpected, fallback, reason) });
}


// Generation-agnostic on purpose: matches any Composer release, so only the
// CURSOR_MODEL_FLOOR constant needs editing when the floor generation bumps.


// A spawn whose model SATISFIES the tier (so it would be allowed) but only via the Composer
// FLOOR while the role's tier wants a stronger family (Opus/Sonnet) = a silent DEGRADATION,
// usually API-budget exhaustion or a disabled model. Surface the choice ONCE per run (visible
// deny) instead of letting the team quietly run the architect/implementers on Composer. Returns
// the deny on the first such spawn, or null to proceed (already asked/answered, free/cheapest
// tier, or genuinely on the recommended model). Mirrors modelUnsatisfiedDeny's no-deadlock guard.
export function degradedToFloorDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
  if (ctx.host !== 'cursor' || !runId) return null;
  if (isComposerFamily(expected)) return null; // tier legitimately wants Composer (free / tester / quick-fix)
  // The passed model is authoritative (the gate already required it via modelSatisfiesTier).
  if (!modelMatchesAny(passedModel, [CURSOR_MODEL_FLOOR])) return null; // not on the floor → running fine
  // Honor the answer precisely: fallback proceeds only after an explicit recorded choice.
  const choice = fallbackAlreadyAllowed(cwd, runId);
  if (choice === 'enable-retry') return modelEnableRetryDeny(ctx, role, level, passedModel, expected);
  if (choice === 'use-fallback') return null;
  markModelChoicePrompted(cwd, runId);
  // The RECOMMENDED model named here is the role's TIER family verbatim (e.g. `gpt-5.6-terra`)
  // — NOT `cursorRealSlug(expected)`. cursorRealSlug resolves through the captured/available list,
  // which by definition EXCLUDES a disabled model, so it would collapse the recommendation to an
  // available fallback (often the Composer floor) and tell the user to "enable composer" instead
  // of the actually-disabled model they picked. The user must see the exact model to enable in
  // Settings → Models. The FALLBACK is the Composer floor the spawn already degraded to (free,
  // guaranteed available — matches the "no extra cost / available immediately" choice prose).
  const captured = policy
    ? [...(policy.cursorAvailableModels || [])]
    : freshCursorModels(cwd, detectHostPlan(ctx.host));
  const floor = (captured.length ? pickCursorSlug([CURSOR_MODEL_FLOOR], captured) : '')
    || CURSOR_MODEL_FLOOR;
  return modelChoiceDeny(ctx, role, level, expected, floor);
}

// The role's PREFERRED tier model (the exact one the user picked in the wizard, e.g. the
// balanced `gpt-5.6-terra`) is NOT in the build's captured/offered model list — it's disabled
// in Settings → Models or not on the plan. Materialization therefore fell back to a same-tier
// ALTERNATE (e.g. `claude-sonnet-5`), which SATISFIES the tier so the spawn would pass silently. That is
// exactly the "I wasn't asked" gap: degradedToFloorDeny only catches a drop to the Composer FLOOR,
// not a fallback to a valid alternate. Surface the choice ONCE (enable the recommended model & re-
// run, or accept the named fallback) so the user is never silently switched off their pick. Shares
// the model-choice marker with degradedToFloorDeny → at most one model prompt per run (no-deadlock:
// after one ask, proceed on the fallback). Capture-list-driven, so it fires regardless of which
// model the orchestrator passed.
export function preferredModelUnavailableDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
  if (ctx.host !== 'cursor' || !runId) return null;
  if (isComposerFamily(expected)) return null; // cheapest tier wants Composer — nothing to enable
  const captured = policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length) return null;                 // no fresh capture to judge against (capture gate covers it)
  if (pickCursorSlug([expected], captured)) return null; // the recommended model IS offered → no downgrade
  const choice = fallbackAlreadyAllowed(cwd, runId);
  if (choice === 'enable-retry') return modelEnableRetryDeny(ctx, role, level, passedModel, expected);
  if (choice === 'use-fallback') return null;
  markModelChoicePrompted(cwd, runId);
  return modelChoiceDeny(ctx, role, level, expected, fallbackModelFor(ctx, cwd, role, expected, policy));
}

// B2 proactive advisory (Cursor, once per run): a pinned model can SILENTLY fall back to
// Composer at runtime (budget exhausted / disabled) with no signal the gate can read, so on the
// FIRST passing spawn name the models the team will use + the budget/enable remedy. Returns a
// HookResult carrying BOTH the detailed agent-facing context AND a user-visible systemMessage
// (→ user_message on Cursor) so the user actually SEES it — not just additional_context, which
// Cursor injects into the agent's context but never shows in chat. null when not applicable.
export function maybeModelAdvisory(
  ctx: Ctx,
  cwd: string,
  runId: string,
  level: string,
  overrides: Rec | null,
  modelSelections: Rec | null,
  planCtx: PlanCtx,
  policy: RunModelPolicyV1 | null = null,
): HookResult | null {
  if (ctx.host !== 'cursor' || !runId || modelAdvisoryShown(cwd, runId)) return null;
  const models = new Set<string>();
  for (const r of AGENT_ROLES) {
    const fam = policy?.roles[r]?.preferredModel
      || modelForRoleHost(level, r, ctx.host, overrides, planCtx, process.env, modelSelections);
    if (fam) models.add(cursorRealSlug(ctx, cwd, fam, policy, r));
  }
  if (models.size === 0) return null;
  markModelAdvisoryShown(cwd, runId);
  const list = Array.from(models).join(', ');
  return context(block('model-availability-advisory', { MODELS: list }), {
    systemMessage: block('model-availability-banner', { MODELS: list }),
  });
}

// NOTE: this gate FIRES and ENFORCES on Cursor — the generic before-tool-use hook
// derives spawn-agent from tool_name=Task (cursor.ts GENERIC_PRE_ADMIT), the model is
// passed in tool_input.model, and HOST_MODELS.cursor holds bare FAMILY anchors
// (claude-fable-5 / gpt-5.6-terra / composer-2.5) — the concrete reasoning-suffixed
// build slug (e.g. claude-sonnet-5-thinking-high) is account/build-specific, so it
// is captured at onboarding (freshCursorModels) and resolved per spawn via
// pickCursorSlug/cursorRealSlug, while modelSatisfiesTier matches family-aware against
// the owning tier row (preferred id + same-tier fallbacks). (This replaced an earlier
// advisory-only stopgap: HOST_MODELS.cursor used to hold Anthropic aliases
// (opus/sonnet/haiku) that Cursor REJECTS rather than downgrading, making a hard
// equality deny un-satisfiable.)
// The gate also stakes the run-claim here (subagentStart is a different
// canonical event, so no double-claim), which the subagent-team write gate needs to
// resolve a role on Cursor. Agent REUSE/continuation is ENABLED on Cursor via the
// Task tool's `resume` continuation field (with `agentId` accepted for older
