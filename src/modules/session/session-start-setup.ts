// src/modules/session/session-start-setup.ts
// Setup-pending banners/directives and the stack-selection helpers shown
// before onboarding completes.

import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';
import { context, mergeResults, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { detectMode, detectStackFromCodebase, reconcileStackFromArtifacts } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { packBundle, packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective, roleSkillsDirective } from '../../shared/skill-filters';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { onboardingDeclineCommand, onboardingSyncSessionId, usePluginQuestion } from '../../shared/onboarding-server/wait-command';
import { formatWizardBanner } from '../../shared/onboarding-server/ensure';
import { windsurfSetupReason } from '../../shared/onboarding-server/windsurf-setup';
import { localFallbackLine, localFallbackSection } from '../../shared/onboarding-server/wizard-links';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { roleScopedRules, STACKS, stackSpecForState } from '../../shared/stacks';
import {
  ensureCurrentRunId,
  hasRunAgentState,
  hookSessionIdentity,
  isMaintenancePhase,
  isSubagentThread,
  legacyRunAgentContext,
  legacyStatePath,
  maintenanceLifecycle,
  normalizeState,
  pruneExpiredPendingClaims,
  readEffectiveState,
  reconcileRunIdentityDrift,
  recordRunStackDrift,
  resolveRunAgentContext,
  runIdentityFrozen,
  runReachedTerminalVerdict,
  type RunAgentContext,
  scrubProjectStateLocalPrefs,
  stackFingerprint,
  statePath,
  stateVersion,
  writeState,
} from '../../shared/state';
import { authEnforced, isLocallyAuthenticated } from '../../shared/auth';
import { ensureAgentTeamsEnv, ensureCodeGraphForExistingProject, ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner } from './session-start-lib';
import { ensureCodexOneMcpServerRegistered } from '../../shared/codex-mcp';
import { ONE_MCP_REGISTRATION } from '../../config/one-mcp';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../shared/run-model-policy';
import { canonicalHost } from '../../shared/model-tiers';
import { capabilityStateForRun } from '../../shared/architecture-contract';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { removeStrayProjectArtifactsFromGlobalDir } from '../../shared/state/traffic-one-paths';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

// Surface the dashboard setup link without bypassing ask-first or the approved
// bootstrap path when a host sandbox cannot write canonical user-local state.
export function setupPendingBanner(ctx: Ctx, cwd: string, banner: string): string {
  // Ask-first: the user has not said yes — never launch the wizard server (or
  // leak its URL) just to decorate the banner. The plain banner is enough.
  if (usePluginQuestionPending(cwd)) return banner;
  const prepared = prepareOnboardingServer(cwd, ctx.host);
  return prepared.kind === 'ready'
    ? formatWizardBanner(
      ctx.host,
      prepared.server.dashboardUrl,
      localFallbackSection(cwd, prepared.server.localWizardUrl, process.env, ctx.host),
      banner,
    )
    : banner;
}

// The prompt that triggered this hook run, when the event carries one (the
// UserPromptSubmit path re-runs the authed SessionStart body with its Ctx).
// SessionStart events have no prompt — the ask-first question is then emitted
// without a seed and the wizard's no-signal floor covers stack derivation.
function ctxPromptText(ctx: Ctx): string {
  return ctx.input.prompt || promptTextFromSubmit(ctx.input.raw) || '';
}

// The agent-facing setup directive. Every host receives either a live wizard URL
// plus waiter, or an exact approved bootstrap command when its hook sandbox cannot
// write the canonical user-local runtime. OpenCode/Kilo/Windsurf keep compact,
// host-safe prose; Claude/Codex/Cursor/Copilot receive the full walkthrough.
export function setupPendingDirective(ctx: Ctx, cwd: string): string {
  // Ask-first: relay the host-chat question — no wizard server, no URL, and no
  // state writes anywhere until the user says whether this project uses Traffic
  // One at all. The triggering prompt rides the yes command as the seed.
  const syncSession = onboardingSyncSessionId(hookSessionIdentity(ctx.input.raw).sessionId);
  if (usePluginQuestionPending(cwd)) return usePluginQuestion(cwd, ctx.host, ctxPromptText(ctx), syncSession);
  const prepared = prepareOnboardingServer(cwd, ctx.host, { syncSession });
  if (prepared.kind !== 'ready') return prepared.reason;
  const { server, waitCommand } = prepared;
  if (!server.dashboardUrl) return block('setup-pending');
  // Hosted link alone while the dashboard is healthy; the loopback wizard is added
  // only when it is genuinely unusable or the probe has not answered yet.
  const localFallback = localFallbackSection(cwd, server.localWizardUrl, process.env, ctx.host);
  // OpenCode/Kilo: keep this factual and compact so their prompt-injection
  // filters do not reject a multi-host walkthrough. The live URL and executable
  // waiter are still present on the first prompt.
  if (ctx.host === 'opencode' || ctx.host === 'kilo') {
    return [
      'Traffic One project setup is required before building.',
      `Setup link: ${server.dashboardUrl}`,
      ...(localFallbackLine(cwd, server.localWizardUrl, process.env, ctx.host) ? [String(localFallbackLine(cwd, server.localWizardUrl, process.env, ctx.host))] : []),
      `Wait command: ${waitCommand}`,
      'Show the setup link, then immediately run the wait command and keep this turn active until setup completes.',
      `If the user does not want Traffic One for this project, run instead: ${onboardingDeclineCommand(cwd, ctx.host)}`,
    ].join('\n\n');
  }
  if (ctx.host === 'windsurf') {
    const vars = { URL: server.dashboardUrl, LOCAL_FALLBACK: localFallback, WAIT_CMD: waitCommand };
    return block('windsurf-server-deny-reason', vars, windsurfSetupReason(server.dashboardUrl, localFallback, waitCommand));
  }
  return block('server-deny-reason', {
    URL: server.dashboardUrl,
    LOCAL_FALLBACK: localFallback,
    WAIT_CMD: waitCommand,
    DECLINE_CMD: onboardingDeclineCommand(cwd, ctx.host),
  });
}
export const STACK_IDS = new Set(Object.keys(STACKS));

export function sessionProjectRoot(ctx: Ctx): string {
  return resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
}

// Build the role-scoped (or fix-cycle) rule context for a subagent whose run claim
// resolved and whose project is already materialized. Shared by the subagent
// SessionStart path and the legacy run-agent fast path.
export function subagentRoleContext(ctx: Ctx, state: Rec, agentContext: RunAgentContext, root: string): HookResult {
  const cwd = sessionProjectRoot(ctx);
  const capabilityState = capabilityStateForRun(cwd, state);
  const role = typeof agentContext.role === 'string' ? agentContext.role : '';
  const runId = String(agentContext.runId ?? '');
  const spawnIndex = agentContext.spawnIndex || 0;

  if (role && spawnIndex > 1) {
    // Fix-cycle: same role re-spawned in the same run → tiny pointer header.
    const { body } = packFixCycleHeader(cwd, role, runId, spawnIndex);
    return context(body);
  }

  const ruleSet = role ? roleScopedRules(role, capabilityState) : null;
  const rules = ruleSet || stackSpecForState(capabilityState).mandatory;
  copyActiveSkills(capabilityState, ctx.host);
  // Role-scoped skills (from the role's agent-doc frontmatter) when the role is
  // known — a senior-frontend spawn lists only frontend skills, not the whole
  // stack catalog plus a 30-name wrong-stack dump.
  const skillDirective = role
    ? roleSkillsDirective(capabilityState, role, listAllSkills(), ctx.host)
    : pruneSkillsDirective(capabilityState, listAllSkills(), ctx.host);
  const { body } = packRuleIndex(root, rules);
  const graphPreview = readGraphPreview(cwd, state.codeGraphProvider);
  const roleLabel = role || 'subagent';
  const header = `═══ traffic-one — ${roleLabel} (run ${runId}) ═══\n`
    + '[subagent] Full rules already loaded by parent session and materialized to '
    + '.traffic-one/rules/. This index lists role-scoped rules; Read them on demand.\n';
  return context(`${header}${skillDirective}${graphPreview}\n${body}`);
}

// A subagent NEVER runs the full session-start hook. The auth gate and onboarding
// belong to the parent/main agent; a subagent only needs its role-scoped rules
// materialized. This path conditionally materializes and returns the role context —
// so a subagent can never re-trigger auth or onboarding mid-build.
export function runSubagentSessionStart(ctx: Ctx): HookResult {
  const cwd = sessionProjectRoot(ctx);
  const root = pluginRoot();
  const raw = ctx.input.raw;
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const team = obj(state.team);
  if (team?.mode === 'subagents') {
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    const policy = runId ? readRunModelPolicy(cwd, runId) : null;
    if (!runId || !policy || policy.host !== canonicalHost(ctx.host)) {
      return context(
        `TRAFFIC_ONE_MODEL_POLICY_BLOCKED_CHILD\nImmutable model-policy.json is missing, corrupt, or belongs to another host for run ${runId || '(missing)'}. `
        + 'Do not use tools or reconstruct it from current preferences/One MCP. Stop this child; the parent must repair the run and respawn it.',
      );
    }
  }

  cleanActiveSkills();
  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // best-effort; the parent already materialized the bundle
  }

  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true, host: ctx.host })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    return subagentRoleContext(ctx, state, agentContext, root);
  }

  // Role/claim not resolved yet — still never onboard. Hand over whatever rules are
  // materialized; if none yet, stay silent and let the parent's materialization land.
  if (hasMaterializedProjectAssets(cwd, state)) {
    const capabilityState = capabilityStateForRun(cwd, state);
    copyActiveSkills(capabilityState, ctx.host);
    const { body } = packRuleIndex(root, stackSpecForState(capabilityState).mandatory);
    return context('═══ traffic-one — subagent ═══\n'
      + '[subagent] Rules already materialized to .traffic-one/rules/; read role-scoped rules on demand.\n'
      + body);
  }
  return noop();
}
