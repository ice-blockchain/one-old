// src/modules/agent-model/handler.ts
// PreToolUse spawn-agent gate (priority 40): for new-project builds, enforce
// materialization → performance level → team approval → the per-role model
// parameter, then stake a run-agent claim. Ported 1:1 from runCheckAgentModel
// (gates.cjs). Spawn-specific fields (subagent_type, model, …) come from
// ctx.input.raw (the canonical ToolInput doesn't carry them). Deny PROSE → skill.

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { pluginRoot } from '../../shared/paths';
import { detectHostPlan } from '../../shared/host-plan';
import { acceptableModelsFor, modelMatchesAny, resolveModel } from '../../shared/model-tiers';
import {
  cursorModelsCapturePrompted,
  cursorModelsFresh,
  freshCursorModels,
  markCursorModelsCapturePrompted,
  pickCursorSlug,
} from '../../shared/materialize/cursor-models';
import { modelForRoleHost, openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { recordOpenCodeFallback } from '../../shared/opencode-queue';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import { AGENT_ROLES } from '../../config/performance';
import { makeSkillBlock } from '../../shared/skill-block';
import { modelUnavailablePromptRequest } from '../../shared/prompt-request';
import {
  markModelAdvisoryShown,
  markModelChoicePrompted,
  type ModelChoiceStatus,
  modelAdvisoryShown,
  modelChoicePrompted,
  readModelChoice,
} from './model-choice';
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
  ensureCurrentRunId,
  ensureRunAgentClaim,
  continuationAgentId,
  hookSessionIdentity,
  isMaintenancePhase,
  isTeamApproved,
  liveRunAgent,
  markRunAgentReplaced,
  refreshCursorRunAgentFromTranscriptCache,
  readEffectiveState,
  REPLACE_AGENT_MARKER,
  subagentContinuationAvailable,
  verdictAgentConflict,
} from '../../shared/state';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { strayRunIdInText } from '../../shared/run-id-paths';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { inferTrafficOneSpawnRole } from './role-infer';
import { buildOpenCodePlanBatchDenyContext } from '../../shared/opencode-plan-directive';
import { resolveProjectRoot } from '../../shared/hook-paths';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string => skillBlock('agent-model', name, vars);
const PLAN_BATCH_GATED_ROLES = new Set(['senior-frontend', 'senior-backend']);

function isPlanBatchGatedRole(role: string): boolean {
  return PLAN_BATCH_GATED_ROLES.has(role);
}

// A role's tier is satisfied ONLY when the spawn's `model` PARAMETER matches it (family-aware
// + same-class CURSOR_MODEL_ALTERNATES). The passed arg is authoritative on every host —
// INCLUDING Cursor: the earlier design trusted the `.cursor/agents/<role>.md` frontmatter, but
// live evidence proved Cursor does NOT honor that frontmatter when no `model` arg is passed — it
// INHERITS THE PARENT (orchestrator) model (captured: a balanced-override frontend with
// frontmatter `gpt-5.5-medium` ran on the parent's Opus because `subagent_model == parent model`).
// So the per-role model only takes effect when the orchestrator PASSES it in the Task `model`
// arg; the gate must therefore require it (the frontmatter is just the source/hint the
// orchestrator reads, never proof the subagent will run on it).
function modelSatisfiesTier(ctx: Ctx, passedModel: string, expected: string): boolean {
  return modelMatchesAny(passedModel, acceptableModelsFor(expected, ctx.host));
}

function modelParamEnforced(host: string): boolean {
  // Copilot model slugs/frontmatter behavior still needs live validation. The project-local
  // .agent.md files carry the model intent, so do not hard-block a spawn solely on a missing
  // or differently-shaped `model` tool arg.
  return host !== 'copilot';
}

// The per-role model-tier deny. Lists the acceptable same-tier ALTERNATES so the
// orchestrator can pass a model the runner actually offers when a Cursor build does
// not offer the preferred slug (Cursor rejects an unavailable slug as invalid). The
// gate stays strict — a wrong-FAMILY model is still denied; only the maintainer-
// defined accept-set (CURSOR_MODEL_ALTERNATES) widens what satisfies the tier.
// Host-specific "continue the live agent" recipe for the agent-reuse deny. The
// continuation primitive differs per host: Cursor RE-INVOKES the Task tool with
// `resume` (live Cursor builds surface this field; older docs/models may say
// `agentId`), Copilot reuses the background agent id through `task`, Codex uses
// `send_input`, Claude uses `SendMessage`. The agentId is interpolated here so the
// SKILL block stays a single host-agnostic template.
function continuationRecipe(host: string, agentId: string): { call: string; tool: string } {
  if (host === 'cursor') {
    return {
      call: `Re-invoke the \`Task\` tool with \`resume: "${agentId}"\` and \`prompt\` = the NEW task only — Cursor resumes the SAME subagent with full context preserved. If your Cursor build exposes \`agentId\` instead, use the same id there.`,
      tool: 'the Task `resume` continuation',
    };
  }
  if (host === 'codex') {
    return {
      call: `Call \`send_input\` with \`target: "${agentId}"\` and the NEW task as the message.`,
      tool: 'send_input',
    };
  }
  if (host === 'copilot') {
    return {
      call: `Call Copilot's \`task\` tool for the SAME background agent with \`agent_id: "${agentId}"\` and \`prompt\` = the NEW task only. Do NOT substitute \`name: "${agentId}"\`: live Copilot builds treat \`name\` as a fresh background task and respawn the agent. If this Copilot build rejects \`agent_id\` as unsupported, STOP and report that Copilot did not expose a reusable continuation primitive; do not spawn another same-role task.`,
      tool: 'the Copilot `task` background-agent continuation',
    };
  }
  return {
    call: `Call \`SendMessage\` with \`to: "${agentId}"\` and \`message\` = the NEW task.`,
    tool: 'SendMessage',
  };
}

function replacementJustified(prompt: string): boolean {
  return /\b(context exhausted|context limit|agent not found|resume failed|continuation failed|couldn'?t continue|could not continue|unresponsive|dead|stale|closed)\b/i
    .test(prompt);
}

// On Cursor a tier's `expected` is a bare model FAMILY (e.g. claude-opus-4-8). Map it to the
// CONCRETE build slug the user's runner offers — the first captured model whose family matches
// the family or a same-tier alternate — so deny/advisory prose names an EXACT slug Cursor
// accepts. Falls back to the family when nothing is captured (or the build offers nothing in
// the chain); claude/codex pass `family` straight through (their ids are already concrete).
function cursorRealSlug(ctx: Ctx, cwd: string, family: string): string {
  if (ctx.host !== 'cursor' || !family) return family;
  // Only use a FRESH capture (matches the current plan) — a stale list (plan changed) would
  // name a slug from the old plan. detectHostPlan is memoized, so this is cheap.
  const captured = freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length) return family;
  return pickCursorSlug(acceptableModelsFor(family, ctx.host), captured) || family;
}

function modelTierDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string, opts: { suppressAlternates?: boolean } = {}): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}". `
    : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
  // `expected` + alternates are FAMILY anchors; on Cursor name the concrete build slug for each
  // (resolved from the captured list) so the orchestrator passes an exact slug Cursor offers,
  // not a bare family. suppressAlternates: after "enable & retry" we don't advertise fallbacks.
  const shownExpected = cursorRealSlug(ctx, cwd, expected);
  const captured = ctx.host === 'cursor' ? freshCursorModels(cwd, detectHostPlan(ctx.host)) : [];
  const altFamilies = opts.suppressAlternates ? [] : acceptableModelsFor(expected, ctx.host).slice(1);
  const altModels = altFamilies
    .map((f) => (captured.length ? pickCursorSlug([f], captured) : f))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const altNote = altModels.length
    ? ` If this host's subagent runner does NOT offer "${shownExpected}" (it rejects an unavailable slug as invalid), pass instead the FIRST of these same-tier models the runner DOES offer — any of them satisfies the gate: ${altModels.join(', ')}.`
    : '';
  return deny(block('performance-model-param', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: shownExpected, PASSED_NOTE: passedNote, ALTERNATES: altNote }));
}

function cursorExactModelDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string): HookResult | null {
  if (ctx.host !== 'cursor' || !passedModel) return null;
  const captured = freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length || captured.includes(passedModel)) return null;
  const acceptable = acceptableModelsFor(expected, ctx.host);
  if (!modelMatchesAny(passedModel, acceptable)) return null;
  const exact = pickCursorSlug(acceptable, captured) || cursorRealSlug(ctx, cwd, expected);
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
function fallbackModelFor(ctx: Ctx, cwd: string, expected: string): string {
  const altFamilies = acceptableModelsFor(expected, ctx.host).slice(1);
  if (ctx.host === 'cursor') {
    const captured = freshCursorModels(cwd, detectHostPlan(ctx.host));
    if (captured.length) {
      const offered = pickCursorSlug(altFamilies, captured);
      if (offered) return offered;
    }
  }
  const altFamily = altFamilies[0];
  return altFamily ? cursorRealSlug(ctx, cwd, altFamily) : cursorRealSlug(ctx, cwd, expected);
}

// The recommended-model-unavailable choice deny (the budget/disabled CHOICE for the
// degraded-to-Composer path). Names both possible causes (budget exhausted / disabled) and the
// fallback; rides the deny reason on Cursor/Codex and a promptRequest modal on Claude.
function modelChoiceDeny(ctx: Ctx, role: string, level: string, shownExpected: string, fallback: string): HookResult {
  const reason = block('model-unavailable-choice', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: shownExpected, FALLBACK: fallback });
  return deny(reason, { promptRequest: modelUnavailablePromptRequest(shownExpected, fallback, reason) });
}

function modelEnableRetryDeny(ctx: Ctx, role: string, level: string, passedModel: string, expected: string): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}".`
    : 'You passed no `model` parameter, so the subagent would inherit the parent model.';
  return deny(block('model-choice-enable-required', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
}

function isComposerFamily(model: string): boolean {
  return /^composer/i.test(model.trim());
}

function fallbackAlreadyAllowed(cwd: string, runId: string): ModelChoiceStatus | null {
  return readModelChoice(cwd, runId);
}

// A spawn whose model SATISFIES the tier (so it would be allowed) but only via the Composer
// FLOOR while the role's tier wants a stronger family (Opus/Sonnet) = a silent DEGRADATION,
// usually API-budget exhaustion or a disabled model. Surface the choice ONCE per run (visible
// deny) instead of letting the team quietly run the architect/implementers on Composer. Returns
// the deny on the first such spawn, or null to proceed (already asked/answered, free/cheapest
// tier, or genuinely on the recommended model). Mirrors modelUnsatisfiedDeny's no-deadlock guard.
function degradedToFloorDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string): HookResult | null {
  if (ctx.host !== 'cursor' || !runId) return null;
  if (isComposerFamily(expected)) return null; // tier legitimately wants Composer (free / tester / quick-fix)
  // The passed model is authoritative (the gate already required it via modelSatisfiesTier).
  if (!modelMatchesAny(passedModel, ['composer-2.5'])) return null; // not on the floor → running fine
  // Honor the answer precisely: fallback proceeds only after an explicit recorded choice.
  const choice = fallbackAlreadyAllowed(cwd, runId);
  if (choice === 'enable-retry') return modelEnableRetryDeny(ctx, role, level, passedModel, expected);
  if (choice === 'use-fallback') return null;
  markModelChoicePrompted(cwd, runId);
  // The RECOMMENDED model named here is the role's TIER family verbatim (e.g. `claude-4.6-sonnet`)
  // — NOT `cursorRealSlug(expected)`. cursorRealSlug resolves through the captured/available list,
  // which by definition EXCLUDES a disabled model, so it would collapse the recommendation to an
  // available fallback (often the Composer floor) and tell the user to "enable composer" instead
  // of the actually-disabled model they picked. The user must see the exact model to enable in
  // Settings → Models. The FALLBACK is the Composer floor the spawn already degraded to (free,
  // guaranteed available — matches the "no extra cost / available immediately" choice prose).
  return modelChoiceDeny(ctx, role, level, expected, cursorRealSlug(ctx, cwd, 'composer-2.5'));
}

// The role's PREFERRED tier model (the exact one the user picked in the wizard, e.g. the
// balanced `claude-4.6-sonnet`) is NOT in the build's captured/offered model list — it's disabled
// in Settings → Models or not on the plan. Materialization therefore fell back to a same-tier
// ALTERNATE (e.g. `gpt-5.5`), which SATISFIES the tier so the spawn would pass silently. That is
// exactly the "I wasn't asked" gap: degradedToFloorDeny only catches a drop to the Composer FLOOR,
// not a fallback to a valid alternate. Surface the choice ONCE (enable the recommended model & re-
// run, or accept the named fallback) so the user is never silently switched off their pick. Shares
// the model-choice marker with degradedToFloorDeny → at most one model prompt per run (no-deadlock:
// after one ask, proceed on the fallback). Capture-list-driven, so it fires regardless of which
// model the orchestrator passed.
function preferredModelUnavailableDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string): HookResult | null {
  if (ctx.host !== 'cursor' || !runId) return null;
  if (isComposerFamily(expected)) return null; // cheapest tier wants Composer — nothing to enable
  const captured = freshCursorModels(cwd, detectHostPlan(ctx.host));
  if (!captured.length) return null;                 // no fresh capture to judge against (capture gate covers it)
  if (pickCursorSlug([expected], captured)) return null; // the recommended model IS offered → no downgrade
  const choice = fallbackAlreadyAllowed(cwd, runId);
  if (choice === 'enable-retry') return modelEnableRetryDeny(ctx, role, level, passedModel, expected);
  if (choice === 'use-fallback') return null;
  markModelChoicePrompted(cwd, runId);
  return modelChoiceDeny(ctx, role, level, expected, fallbackModelFor(ctx, cwd, expected));
}

// B2 proactive advisory (Cursor, once per run): a pinned model can SILENTLY fall back to
// Composer at runtime (budget exhausted / disabled) with no signal the gate can read, so on the
// FIRST passing spawn name the models the team will use + the budget/enable remedy. Returns a
// HookResult carrying BOTH the detailed agent-facing context AND a user-visible systemMessage
// (→ user_message on Cursor) so the user actually SEES it — not just additional_context, which
// Cursor injects into the agent's context but never shows in chat. null when not applicable.
function maybeModelAdvisory(ctx: Ctx, cwd: string, runId: string, level: string, overrides: Rec | null, planCtx: { host: string; plan: string; useOpenCode: boolean }): HookResult | null {
  if (ctx.host !== 'cursor' || !runId || modelAdvisoryShown(cwd, runId)) return null;
  const models = new Set<string>();
  for (const r of AGENT_ROLES) {
    const fam = modelForRoleHost(level, r, ctx.host, overrides, planCtx);
    if (fam) models.add(cursorRealSlug(ctx, cwd, fam));
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
// passed in tool_input.model, and HOST_MODELS.cursor holds the EXACT Cursor Task-tool
// slugs (claude-opus-4-8-thinking-high / claude-4.6-sonnet-medium-thinking / composer-2.5-fast)
// — so the per-role model-param deny is enforced on all three hosts identically. (This
// replaced an earlier advisory-only stopgap: HOST_MODELS.cursor used to hold Anthropic
// aliases (opus/sonnet/haiku) that Cursor REJECTS, making a hard equality deny
// un-satisfiable. Cursor REJECTS a slug it doesn't offer rather than downgrading, and its
// subagent lineup is account/build-specific, so each cursor tier carries same-tier
// fallbacks (CURSOR_MODEL_ALTERNATES) that the accept-set in modelSatisfiesTier honors.)
// The gate also stakes the run-claim here (subagentStart is a different
// canonical event, so no double-claim), which the subagent-team write gate needs to
// resolve a role on Cursor. Agent REUSE/continuation is ENABLED on Cursor via the
// Task tool's `resume` continuation field (with `agentId` accepted for older
// docs/models); a resume Task call is allowed straight through the reuse gate.
export function agentModelGate(ctx: Ctx): HookResult {
  if (authChoiceAllowsContinue(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  // Normalize a host namespace (Codex `multi_agent_v1.spawn_agent`) to the bare name
  // before matching, so the gate can't silently bail on a qualified spawn tool.
  if (toolName && !/^(Task|Agent|spawn_agent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) return noop();

  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return noop();

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
  const spawnRunId = ensureCurrentRunId(cwd, state);
  // The spawn's prompt across every host field — reused by the run-id guard here AND
  // the agent-reuse marker check below (single source of the field list).
  const spawnPromptText = [toolInput.prompt, toolInput.message, toolInput.task, toolInput.description]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const strayRunId = strayRunIdInText(spawnPromptText, spawnRunId);
  if (strayRunId) {
    // SELF-HEALING deny: hand back the spawn prompt with the run-id ALREADY corrected so a weak
    // orchestrator can copy-paste it verbatim, instead of being told to "rebuild" it (composer-2.5
    // read "rebuild the prompt" as an impossible task and fell back to an inline single-model build
    // — observed in 21b). Loop the detector so a SECOND fabricated id can't survive into the echoed
    // prompt and re-deny the retry. Echo only when the prompt is paste-sized; otherwise give the
    // exact substitution. This deny has NO once-marker — it is self-correcting, so it can fire as
    // many times as needed without tripping the no-deadlock budget.
    let fixed = spawnPromptText;
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
      // (send_input / SendMessage), so spawn_agent/Task normally never carries these.
      const parentSessionId = hookSessionIdentity(raw).sessionId;
      const currentLive = (): ReturnType<typeof liveRunAgent> => {
        const live = liveRunAgent(cwd, runId, role, parentSessionId);
        if (ctx.host !== 'cursor') return live;
        const resumeId = live ? continuationAgentId(live, ctx.host) : '';
        return resumeId
          ? live
          : (refreshCursorRunAgentFromTranscriptCache(cwd, state, raw, runId, role, parentSessionId) || live);
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
        if (live && !replacementJustified(spawnPromptText)) {
          const resumeTarget = continuationAgentId(live, ctx.host);
          if (resumeTarget) {
            const recipe = continuationRecipe(ctx.host, resumeTarget);
            return deny(block('agent-reuse-continue', {
              ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
              CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
            }));
          }
          return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
        }
        markRunAgentReplaced(cwd, runId, role);
      } else if (!isResume) {
        const live = currentLive();
        if (live) {
          const resumeTarget = continuationAgentId(live, ctx.host);
          if (!resumeTarget && ctx.host === 'cursor') {
            return deny(block('agent-reuse-await-cursor-id', { ROLE: role, RUN_ID: runId, MARKER: REPLACE_AGENT_MARKER }));
          }
          const recipe = continuationRecipe(ctx.host, resumeTarget);
          return deny(block('agent-reuse-continue', {
            ROLE: role, RUN_ID: runId, AGENT_ID: resumeTarget, MARKER: REPLACE_AGENT_MARKER,
            CONTINUE_CALL: recipe.call, CONTINUE_TOOL: recipe.tool,
          }));
        }
      }
    }
  }

  // quick-fix is the post-build maintenance worker: its cheapest-model pin is
  // enforced in EVERY mode — the per-role tier gate below is new-project-scoped,
  // but maintenance triage mostly fires on existing codebases — and the pin is
  // absolute (team.overrides cannot lift it). Stake the run claim too, so the
  // run-team write gate can resolve the worker's role on its first write.
  if (role === 'quick-fix') {
    const expected = resolveModel('cheapest', ctx.host);
    const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (modelParamEnforced(ctx.host) && expected && !modelSatisfiesTier(ctx, passedModel, expected)) {
      return modelTierDeny(ctx, cwd, role, passedModel, expected, 'maintenance');
    }
    const exact = modelParamEnforced(ctx.host) && expected ? cursorExactModelDeny(ctx, cwd, role, passedModel, expected, 'maintenance') : null;
    if (exact) return exact;
    ensureRunAgentClaim(cwd, state, role, raw, {
      toolName,
      agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
      model: passedModel || expected || '',
    });
    return noop();
  }

  if (state.mode !== 'new-project') return noop();

  if (!isCompletedTrafficOneMaterialization(cwd, state)) {
    materializeIfNeeded(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, readEffectiveState(cwd))) return deny(block('agent-materialization-deny'));
    return deny(block('agent-materialization-missing'));
  }

  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' && PERFORMANCE_LEVEL_IDS.has(performance.level)
    ? performance.level
    : null;
  if (!level) return noop();

  if (teamModeForLevel(level) === 'main-agent') {
    return deny(block('performance-main-agent', { LEVEL: level, ROLE: role }));
  }
  if (!isTeamApproved(state.team)) {
    return deny(block('team-confirmation', { LEVEL: level }));
  }

  const team = obj(state.team);
  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const planCtx = { host: ctx.host, plan: detectHostPlan(ctx.host), useOpenCode: openCodeDelegationActive(state, ctx.host) };

  // Cursor: the build's actual subagent model set — and its reasoning-variant slugs
  // (`-thinking-max`, `-extra-high`, …) — is plan/build-specific, and only the in-Cursor
  // orchestrator can enumerate it (no plan-scoped API). Require a FRESH capture (matching the
  // CURRENT plan) so materialization pins REAL, build-offered slugs in `.cursor/agents/<role>.md`
  // (else the orchestrator may pass a guessed slug Cursor doesn't offer and silently downgrade). The freshness
  // check is plan-keyed: an upgrade/downgrade makes the old capture stale → this re-prompts, so
  // subagent models stay current. NO-DEADLOCK: ask at most once per run; after that, proceed —
  // the family-aware match below still validates whatever the orchestrator passes.
  if (ctx.host === 'cursor' && !cursorModelsFresh(cwd, planCtx.plan) && !cursorModelsCapturePrompted(cwd, spawnRunId)) {
    markCursorModelsCapturePrompted(cwd, spawnRunId);
    return deny(block('cursor-models-capture', { RUN_ID: spawnRunId, PROJECT_ROOT: cwd }));
  }

  const expected = modelForRoleHost(level, role, ctx.host, overrides, planCtx);
  if (!expected) return noop();

  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  if (!modelParamEnforced(ctx.host)) {
    ensureRunAgentClaim(cwd, state, role, raw, {
      toolName,
      agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
      model: passedModel || expected,
    });
    return noop();
  }
  if (!modelSatisfiesTier(ctx, passedModel, expected)) {
    // No/wrong `model` arg → an orchestrator-actionable "pass model=X" deny (NOT a user-facing
    // budget/disabled choice — that is reserved for degradedToFloorDeny, the real Composer-floor
    // case). This is what unblocks a build that omitted the per-role model.
    return modelTierDeny(ctx, cwd, role, passedModel, expected, level);
  }
  const exact = cursorExactModelDeny(ctx, cwd, role, passedModel, expected, level);
  if (exact) return exact;

  // The model satisfies the tier — but the recommended model the user PICKED may not actually be
  // offered by this build (disabled in Settings → Models / not on plan), in which case the team is
  // about to run on a same-tier FALLBACK. Surface the choice ONCE so the user isn't silently
  // switched off their pick (the "I wasn't asked" gap — degradedToFloorDeny below only catches a
  // drop to the Composer floor, not a fallback to a valid alternate like gpt-5.5).
  const ineligible = preferredModelUnavailableDeny(ctx, cwd, spawnRunId, role, passedModel, expected, level);
  if (ineligible) return ineligible;

  // …and if a highest/balanced role is satisfied ONLY via the Composer floor, that's a silent
  // downgrade (API budget exhausted, or the recommended model disabled). Surface the choice ONCE
  // per run instead of quietly running the architect/implementers on Composer; no-deadlock proceeds.
  const degraded = degradedToFloorDeny(ctx, cwd, spawnRunId, role, passedModel, expected, level);
  if (degraded) return degraded;

  // First passing Cursor spawn of the run → one-time, USER-VISIBLE advisory naming the team's
  // models + the budget/enable remedy (a pinned model can silently fall to Composer at runtime).
  const advisory = maybeModelAdvisory(ctx, cwd, spawnRunId, level, overrides, planCtx);

  ensureRunAgentClaim(cwd, state, role, raw, {
    toolName,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
    model: passedModel,
  });
  return advisory ?? noop();
}
