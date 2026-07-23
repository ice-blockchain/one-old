// src/modules/agent-model/handler.ts
// PreToolUse spawn-agent gate (priority 40): for new-project builds, enforce
// materialization → performance level → team approval → the per-role model
// parameter, then stake a run-agent claim. Ported 1:1 from runCheckAgentModel
// (gates.cjs). Spawn-specific fields (subagent_type, model, …) come from
// ctx.input.raw (the canonical ToolInput doesn't carry them). Deny PROSE → skill.

import { asString } from '../../adapters/coerce';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { pluginRoot } from '../../shared/paths';
import { detectHostPlan } from '../../shared/host-plan';
import { modelMatchesAny, modelMatchesHostModels } from '../../shared/model-tiers';
import { CURSOR_MODEL_FLOOR } from '../../config/model-tiers';
import { currentAcceptableModels, currentModelForTier } from '../../shared/current-model-tiers';
import { exhaustedModelsForRole, isApiUsageLimitText, markModelExhaustionTerminal, modelIsExhausted, recordExhaustedModel } from './exhausted-models';
import {
  freshCursorModels,
  pickCursorSlug,
} from '../../shared/materialize/cursor-models';
import { modelForRoleHost, teamModeForLevel, type PlanCtx } from '../../shared/performance';
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
import { recordMainOnboardingSession } from '../../shared/onboarding-server/onboarding-session';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';
import {
  correlatedCursorFailureGate,
  CURSOR_FAILURE_BLOCK_FALLBACKS,
} from './cursor-failures';
import { cursorAgentPresumedDead } from './cursor-liveness';
import { buildOpenCodePlanBatchDenyContext } from '../../shared/opencode-plan-directive';
import { architectPhaseIncompleteReasons } from '../plan-guard/plan-readiness';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from '../../shared/materialize/opencode-assets';
import {
  cursorRunPolicyMissingTiers,
  ensureRunModelPolicy,
  policyModelsForExpected,
  readRunModelPolicy,
  resolveRunPolicyFallback,
  runModelPolicyPath,
  type RunModelPolicyV1,
} from '../../shared/run-model-policy';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (
  name: string,
  vars: Record<string, string | number | null | undefined> = {},
  fallback = '',
): string => skillBlock('agent-model', name, vars, fallback);
const PLAN_BATCH_GATED_ROLES = new Set(['senior-frontend', 'senior-backend']);

export const CURSOR_MODELS_CAPTURE_FALLBACK = `Cursor model-capture gate (required before the first team spawn, run {{RUN_ID}}). The spawn is blocked until Traffic One freezes the exact model ids offered by this Cursor build.
Missing captured tiers for this run: {{MISSING_TIERS}}.
Do this once before retrying:
1. List the model ids your \`Task\` tool offers for spawning subagents (the same list Cursor shows when you pick a subagent model).
2. Run \`{{CAPTURE_CMD}}\`, replacing the placeholders with those EXACT ids verbatim (e.g. \`claude-fable-5-thinking-high\`, \`gpt-5.6-terra-medium\`, \`composer-2.5-fast\`, or \`gpt-5.4-mini\`). A valid picker id may or may not include a reasoning suffix; never invent one. Include at least one id per tier the team needs — highest + balanced + cheapest. This internal command writes only your local per-user/project Cursor preferences; do not create \`.traffic-one/cursor-models.json\`.
3. Re-run model-gate, then retry the spawn with the exact role→model value it prints. Project \`.cursor/agents\` contracts remain model-agnostic.
Do not retry with an uncaptured family guess and do not build the project inline because of this gate.`;

// Verbatim mirror of the SKILL.md `architect-phase-incomplete` block, so a
// missing block never softens the gate's prose (observed 8c: the orchestrator
// mis-read this deny as a Step-0 request and burned a second dead spawn — the
// prose must lead with the exact next action).
export const ARCHITECT_PHASE_INCOMPLETE_FALLBACK = `Architect phase gate: \`{{ROLE}}\` cannot start yet — spawn \`senior-architect\` for run \`{{RUN_ID}}\` FIRST, in your next message. Do NOT retry \`{{ROLE}}\` unchanged and do NOT run the OpenCode Step-0 plan batch instead; neither clears this gate.

Missing on disk: {{MISSING}}

The architect must finish the project-memory baseline, \`.traffic-one/runs/{{RUN_ID}}/assignments.json\`, and \`.traffic-one/digests/{{RUN_ID}}/architect.md\` containing \`PLAN_READY\`. Only then retry \`{{ROLE}}\` with the same task. Do not spawn other implementers or patch the coordination artifacts yourself.`;

function isPlanBatchGatedRole(role: string): boolean {
  return PLAN_BATCH_GATED_ROLES.has(role);
}

// A role's tier is satisfied ONLY when the spawn's `model` PARAMETER matches it on hosts
// where Traffic One enforces stable subagent model ids (family-aware against the
// active local snapshot's preferred-first tier array). The passed arg is authoritative there — INCLUDING Cursor:
// the earlier design trusted the `.cursor/agents/<role>.md` frontmatter, but
// live evidence proved Cursor does NOT honor that frontmatter when no `model` arg is passed — it
// INHERITS THE PARENT (orchestrator) model (captured: a balanced-override frontend with
// frontmatter `gpt-5.5-medium` ran on the parent's Opus because `subagent_model == parent model`).
// So the per-role model only takes effect when the orchestrator PASSES it in the Task `model`
// arg; the gate must therefore require it (the frontmatter is just the source/hint the
// orchestrator reads, never proof the subagent will run on it).
function modelSatisfiesTier(
  ctx: Ctx,
  passedModel: string,
  expected: string,
  policy: RunModelPolicyV1 | null = null,
  role?: string,
): boolean {
  const acceptable = policy
    ? (role && policy.roles[role]?.acceptableModels) || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  return ctx.host === 'codex'
    ? acceptable.includes(passedModel)
    : modelMatchesHostModels(passedModel, acceptable, ctx.host);
}

function modelParamEnforced(host: string): boolean {
  // Codex collaboration accepts an explicit model too. Its parent spawn surface
  // is not guaranteed to emit PreToolUse, so SubagentStart/child PreToolUse remain
  // the authoritative runtime check; when the parent hook is present, validate it
  // here as an earlier actionable deny.
  return host === 'claude' || host === 'cursor' || host === 'codex';
}

function spawnAgentType(toolInput: Rec, opts: { includeRoleAlias?: boolean } = {}): string {
  const includeRoleAlias = opts.includeRoleAlias !== false;
  return asString(
    toolInput.agent_type
      ?? toolInput.agentType
      ?? toolInput.subagent_type
      ?? toolInput.subagentType
      ?? toolInput.subagent_profile
      ?? toolInput.subagentProfile
      ?? toolInput.profile
      ?? toolInput.profile_name
      ?? toolInput.profileName
      ?? toolInput.agent
      ?? (includeRoleAlias ? toolInput.role : undefined)
      ?? toolInput.name
      ?? toolInput.agentName
      ?? toolInput.agent_name
      ?? toolInput.type,
  ).trim();
}

function isBuiltinSubagent(agentType: string): boolean {
  return /^(general|explore|scout)$/i.test(agentType.trim());
}

function namedOpenCodeAgentDeny(cwd: string, role: string, agentType: string, expected: string): HookResult {
  const expectedAgent = openCodeGlobalAgentName(cwd, role);
  return deny(block('opencode-named-agent-required', {
    HOST: 'OpenCode',
    ROLE: role,
    AGENT_TYPE: agentType || 'missing',
    EXPECTED_AGENT: expectedAgent,
    AGENT_PATH: openCodeGlobalAgentPath(cwd, role),
    MODEL_NOTE: `Traffic One materialized this project-scoped global agent with \`model: ${expected}\`. OpenCode applies that per-role model only when Task uses \`${expectedAgent}\`; built-in agents inherit the parent session model.`,
  }));
}

function kiloGeneralAgentDeny(role: string, agentType: string): HookResult {
  return deny(block('kilo-general-agent-required', {
    ROLE: role,
    AGENT_TYPE: agentType || 'missing',
    AGENT_PATH: `.kilo/agents/${role}.md`,
  }));
}

function absoluteTrafficOnePathsOutsideProject(prompt: string, cwd: string): string[] {
  if (!prompt) return [];
  const root = path.resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\/[^\s'"`<>)]*?\.traffic-one\/(?:runs|digests|fix-cycles)\/[^\s'"`<>)]*/g;
  for (const match of prompt.matchAll(re)) {
    const value = match[0].replace(/\\/g, '/');
    if (value.startsWith(`${root}/`) || value === root) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function absoluteTrafficOnePathDeny(paths: string[], cwd: string): HookResult {
  return deny(block('absolute-traffic-one-path', {
    PROJECT_ROOT: cwd,
    BAD_PATHS: paths.join(', '),
  }));
}

// OpenCode/Kilo do not emit SubagentStart, so the only pre-child signal is the
// parent's Task spawn. Record that parent before staking its pending role claim.
// Later child writes that lack the first chat.message marker can then be safely
// attributed by their single assignment scope, while parent writes stay denied.
function recordSpawnParentSession(cwd: string, raw: unknown): void {
  const parentSessionId = hookSessionIdentity(raw).sessionId;
  if (parentSessionId) recordMainOnboardingSession(cwd, parentSessionId);
}

// The per-role model-tier deny. Lists the acceptable same-tier ALTERNATES so the
// orchestrator can pass a model the runner actually offers when a Cursor build does
// not offer the preferred slug (Cursor rejects an unavailable slug as invalid). The
// gate stays strict — a wrong-FAMILY model is still denied; only fallback ids in
// the active local snapshot's preferred-first tier array widen what satisfies it.
// Host-specific "continue the live agent" recipe for the agent-reuse deny. The
// continuation primitive differs per host: Cursor RE-INVOKES the Task tool with
// `resume` (live Cursor builds surface this field; older docs/models may say
// `agentId`), Copilot reuses the background agent id through `task`, Codex uses
// collaboration follow-up/message tools, and Claude uses `SendMessage`. The agentId is interpolated here so the
// SKILL block stays a single host-agnostic template.
function continuationRecipe(host: string, agentId: string, role: string): { call: string; tool: string } {
  if (host === 'cursor') {
    return {
      call: `Re-invoke the \`Task\` tool with \`resume: "${agentId}"\` and \`prompt\` = the NEW task only — Cursor resumes the SAME subagent with full context preserved. If your Cursor build exposes \`agentId\` instead, use the same id there.`,
      tool: 'the Task `resume` continuation',
    };
  }
  if (host === 'codex') {
    return {
      call: `Call \`followup_task\` with \`target: "${agentId}"\` and the NEW task as \`message\` to continue the SAME Codex agent. If that agent is still running and this is only an in-flight update, use \`send_message\` with the same target instead.`,
      tool: 'followup_task / send_message',
    };
  }
  if (host === 'copilot') {
    return {
      call: `Call Copilot's \`task\` tool for the SAME background agent with \`agent_id: "${agentId}"\` and \`prompt\` = the NEW task only. Do NOT substitute \`name: "${agentId}"\`: live Copilot builds treat \`name\` as a fresh background task and respawn the agent. If this Copilot build rejects \`agent_id\` as unsupported, STOP and report that Copilot did not expose a reusable continuation primitive; do not spawn another same-role task.`,
      tool: 'the Copilot `task` background-agent continuation',
    };
  }
  if (host === 'windsurf') {
    return {
      call: `Call \`read_subagent\` with agent id \`${agentId}\` while the existing role is running. If it completed and needs a follow-up, call \`run_subagent\` with profile \`subagent_general\`; put \`[t1-role: ${role}]\` on the FIRST line, \`${REPLACE_AGENT_MARKER}\` on the next line, and immediately tell it to read \`.devin/agents/${role}/AGENT.md\`.`,
      tool: 'read_subagent / run_subagent replacement',
    };
  }
  if (host === 'opencode') {
    return {
      call: `OpenCode does not expose a resumable Task field in current Traffic One builds. If the existing task \`${agentId}\` is still running, wait for it. If it has already completed and you need a follow-up/fix, re-spawn the SAME named OpenCode agent with \`${REPLACE_AGENT_MARKER}\` in the prompt, keep \`[t1-role: ${role}]\` as the FIRST line, and include only the new findings/file list inline. Do NOT use \`general\`, do NOT point at a missing fix-cycle file, and do NOT write scratch logs under \`/tmp\`.`,
      tool: 'OpenCode Task replacement',
    };
  }
  if (host === 'kilo') {
    return {
      call: `Kilo does not expose a resumable Task field. If task \`${agentId}\` is still running, wait for it. If it completed and needs a follow-up, call \`task\` with built-in \`general\`; put \`[t1-role: ${role}]\` on the FIRST line, \`${REPLACE_AGENT_MARKER}\` on the next line, immediately read \`.kilo/agents/${role}.md\`, and pass no \`model\` field.`,
      tool: 'Kilo general-task replacement',
    };
  }
  return {
    call: `Call \`SendMessage\` with \`to: "${agentId}"\` and \`message\` = the NEW task.`,
    tool: 'SendMessage',
  };
}

// API/usage-limit replacement handling for the reuse gate. When the orchestrator
// re-spawns a role because its subagent hit a provider limit, the retired model is
// exhausted for the session — record it, then if the new spawn tries to REUSE an
// already-exhausted model (or passes none, which inherits the parent), DENY and name
// the next same-tier fallback that is still untried. Returns null when the failure
// isn't a limit (a plain stop can reuse the same model) or the spawn already picked a
// fresh model (rotation satisfied → proceed). Cursor-and-Claude safe: the store is the
// same ledger the transcript reconciler and PostToolUse recorder write; this retry
// inspection is the backstop when Cursor omits its post-Task lifecycle events.
function performanceLevelFromState(state: Rec): string {
  const performance = obj(state.performance);
  return performance && typeof performance.level === 'string' && PERFORMANCE_LEVEL_IDS.has(performance.level)
    ? performance.level
    : 'current';
}

function exhaustedModelRotationDeny(
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

function replacementJustified(prompt: string, host = ''): boolean {
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
// the chain); claude/codex pass `family` straight through (their ids are already concrete).
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

function modelTierDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string, opts: { suppressAlternates?: boolean; policy?: RunModelPolicyV1 | null } = {}): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}". `
    : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
  // `expected` + alternates are FAMILY anchors; on Cursor name the concrete build slug for each
  // (resolved from the captured list) so the orchestrator passes an exact id Cursor offers,
  // never an uncaptured family guess. suppressAlternates: after "enable & retry" we don't
  // advertise fallbacks. A captured exact id may legitimately equal its family anchor.
  const policy = opts.policy || null;
  const shownExpected = cursorRealSlug(ctx, cwd, expected, policy, role);
  const captured = ctx.host === 'cursor'
    ? (policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, detectHostPlan(ctx.host)))
    : [];
  const acceptable = policy
    ? policy.roles[role]?.acceptableModels || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  const altFamilies = opts.suppressAlternates ? [] : acceptable.slice(1);
  const altModels = altFamilies
    .map((f) => (captured.length ? pickCursorSlug([f], captured) : f))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const altNote = altModels.length
    ? ` If this host's subagent runner does NOT offer "${shownExpected}" (it rejects an unavailable slug as invalid), pass instead the FIRST of these same-tier models the runner DOES offer — any of them satisfies the gate: ${altModels.join(', ')}.`
    : '';
  return deny(block('performance-model-param', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: shownExpected, PASSED_NOTE: passedNote, ALTERNATES: altNote }));
}

function cursorExactModelDeny(ctx: Ctx, cwd: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
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

function modelEnableRetryDeny(ctx: Ctx, role: string, level: string, passedModel: string, expected: string): HookResult {
  const passedNote = passedModel
    ? `You passed model="${passedModel}".`
    : 'You passed no `model` parameter, so the subagent would inherit the parent model.';
  return deny(block('model-choice-enable-required', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
}

// Generation-agnostic on purpose: matches any Composer release, so only the
// CURSOR_MODEL_FLOOR constant needs editing when the floor generation bumps.
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
function degradedToFloorDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
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
function preferredModelUnavailableDeny(ctx: Ctx, cwd: string, runId: string, role: string, passedModel: string, expected: string, level: string, policy: RunModelPolicyV1 | null = null): HookResult | null {
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
function maybeModelAdvisory(
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
// docs/models); a resume Task call is allowed straight through the reuse gate.
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
    if (placeholderPromptFields.length === 0 || result.kind === 'deny') return result;
    const updatedToolInput: Record<string, unknown> = { ...toolInput };
    for (const field of placeholderPromptFields) {
      updatedToolInput[field] = substituteRunIdPlaceholder(toolInput[field] as string, spawnRunId);
    }
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

  // Implementers may not start until the architect phase is complete on disk
  // (scaffold + memory baseline + assignments + digest with PLAN_READY). Checked
  // after team approval so earlier gates (team/materialization) keep their prose.
  // `mode` stays "new-project" for the project's whole life, so in MAINTENANCE
  // this gate stands down when any assignments manifest exists for scope
  // fallback (readRunAssignmentsResilient): task-triage's small tier
  // legitimately routes a feature straight to an implementer with no fresh
  // architect run (observed 8c: two dead "Couldn't start" spawns per
  // maintenance feature before the orchestrator inferred the architect).
  if (isNewProject && isPlanBatchGatedRole(role)
    && !(isMaintenancePhase(state) && readRunAssignmentsResilient(cwd, spawnRunId))) {
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
