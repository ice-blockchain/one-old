// src/modules/session/session-start-setup.ts
// Setup-pending banners/directives and the stack-selection helpers shown
// before onboarding completes.

import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';
import { context,  noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { hasMaterializedProjectAssets } from '../../shared/materialize';
import { hostCapability } from '../../shared/host/capability-schema';
import { hostSpawnType } from '../../shared/host/spawn-types';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { prefsCapableRoot } from '../../shared/state/local-prefs';
import {  packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { readActiveRunBootstrap, type RunBootstrapEnvelopeV2 } from '../../shared/run-bootstrap-policy';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective, roleKernel, roleSkillsDirective } from '../../shared/skill-filters';
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
  hasRunAgentState,
  hookSessionIdentity,
  legacyRunAgentContext,
  readEffectiveState,
  resolveRunAgentContext,
  type RunAgentContext,
} from '../../shared/state';
import {    ensureSessionMaterialization, readGraphPreview } from './session-start-lib';
import {  readRunModelPolicy } from '../../shared/run-model-policy';
import { canonicalHost } from '../../shared/model-tiers';
import { capabilityStateForRun } from '../../shared/architecture-contract';

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
  const resolved = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  return prefsCapableRoot(resolved);
}

// The active envelope, tolerated as absent: header decoration must never fail
// the SessionStart hook. A null envelope omits integration requirements (they
// live only on the envelope). The compact role kernel still rides a fallback
// host (`typedSubagents === false`) so write-gate predicates are not dropped.
function safeActiveEnvelope(cwd: string, runId: string, role: string): RunBootstrapEnvelopeV2 | null {
  try {
    return readActiveRunBootstrap(cwd, runId, role);
  } catch {
    return null;
  }
}

// Hosts with `typedSubagents: false` never deliver the agent doc natively
// (Codex, Kilo, Copilot, Windsurf — HOST_CAPABILITIES). Bootstrap roleSource
// is `plugin-injected-fallback` when `hostAgentType` is null, which is how
// those hosts publish. When the envelope is missing, `typedSubagents === false`
// is the equivalent signal — do not wait for roleSource, and do not treat a
// host-native envelope on a fallback host as missing (envelope wins).
function hostLacksNativeAgentDoc(host: string): boolean {
  return hostCapability(host)?.typedSubagents === false;
}

function shouldInjectRoleKernel(
  host: string,
  envelope: RunBootstrapEnvelopeV2 | null,
  role: string,
): boolean {
  if (!role) return false;
  if (envelope) return envelope.roleSource === 'plugin-injected-fallback';
  return hostLacksNativeAgentDoc(host);
}

function roleContractNotice(
  host: string,
  cwd: string,
  role: string,
  kernel: string | null,
): string {
  if (!role) return '';
  const contractRel = hostSpawnType(host, role, cwd).contractPath;
  if (!contractRel || !fs.existsSync(path.join(cwd, contractRel))) return '';
  return `\nYour FULL role contract is \`${contractRel}\` — Read it once before your first write. `
    + (kernel ? 'The kernel above summarizes it; it does not replace it.\n' : '');
}

function integrationRequirementsSection(envelope: RunBootstrapEnvelopeV2 | null): string {
  if (!envelope?.integrationRequirements?.length) return '';
  return '\n## Integration requirements (deterministic gates verify these)\n'
    + `${envelope.integrationRequirements.map((line) => `- ${line}`).join('\n')}\n`;
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
    // Fallback children (envelope roleSource, or typedSubagents === false when
    // the envelope is missing) still receive the write-gate kernel and any
    // stored integration requirements. Do not append a second T1KERNEL checklist.
    const { body } = packFixCycleHeader(cwd, role, runId, spawnIndex);
    const envelope = runId ? safeActiveEnvelope(cwd, runId, role) : null;
    const inject = shouldInjectRoleKernel(ctx.host, envelope, role);
    const kernel = inject ? roleKernel(role) : null;
    const contract = roleContractNotice(ctx.host, cwd, role, kernel);
    const requirements = inject ? integrationRequirementsSection(envelope) : '';
    return context(`${body}${kernel ? `${kernel}\n` : ''}${contract}${requirements}`);
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
  // The envelope is the delivery surface for per-run contract extras since the
  // per-run context-pack snapshot was removed: integration requirements ride
  // the header (they exist nowhere else readable), and the compact role kernel
  // rides it when the host did not deliver the agent doc natively
  // (roleSource 'plugin-injected-fallback', or typedSubagents === false when
  // the envelope is missing — e.g. Codex spawn_agent children).
  const envelope = role && runId ? safeActiveEnvelope(cwd, runId, role) : null;
  // Write-gate predicates (named exports, no-any, inline style, pages/Expo
  // service placement) live in the implementer T1KERNEL. roleKernel() is the
  // injection — do not append a second checklist. Frontend/backend/quick-fix
  // kernels carry those bullets so a fallback child is bound without Reading
  // the full contract file first.
  const kernel = shouldInjectRoleKernel(ctx.host, envelope, role) ? roleKernel(role) : null;
  // The kernel is a SUMMARY (write-gates excepted — those are already binding).
  // Where the host materializes the full role contract, name the file too —
  // a child that only ever saw the kernel cannot honour the invariants living
  // in the other ~200 lines, and the deny it eventually hits never told it the
  // contract existed. Observed 15co on Codex, whose contract path was null and
  // whose role text has been kernel-only since 9cc08b53.
  const contract = roleContractNotice(ctx.host, cwd, role, kernel);
  const requirements = integrationRequirementsSection(envelope);
  const roleLabel = role || 'subagent';
  const kernelBinding = kernel
    ? 'Read on demand — except write-gate predicates in your kernel, which are already binding. '
    : 'Read on demand. ';
  const header = `═══ traffic-one — ${roleLabel} (run ${runId}) ═══\n`
    + `[subagent] Rules are materialized under \`.traffic-one/rules/\`. ${kernelBinding}`
    + 'This index lists role-scoped rules; Read them ONE file per Read/shell command, '
    + 'never several concatenated (host exec output '
    + 'truncates middle-out and the middle files vanish silently).\n';
  return context(`${header}${kernel ? `${kernel}\n` : ''}${contract}${requirements}${skillDirective}${graphPreview}\n${body}`);
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
