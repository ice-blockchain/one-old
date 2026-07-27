// src/modules/session/session-start.ts
// SessionStart handler: auth gate (fail-closed) → multi-project skill sweep +
// digest retention + session materialization → subagent fast path (fix-cycle /
// role-scoped index) → mode routing (onboarded bundle / existing-codebase
// auto-detect / new-project onboarding directive). Ported 1:1 from
// runSessionStart (session-start.cjs). The one-mcp first-look report fires from
// the PostToolUse post-stack-setup handler (first tool use / architect
// PLAN_READY), so SessionStart materialization intentionally does not report.

import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';

import { context, mergeResults, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { isKnownStack } from '../../shared/config';
import { detectMode, detectStackFromCodebase, reconcileStackFromArtifacts } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { autoDetectedAnnouncement } from '../../shared/directives';
import { buildOrchestrationDirective } from '../../shared/build-orchestration-directive';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { packBundle, packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective, roleSkillsDirective } from '../../shared/skill-filters';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { onboardingDeclineCommand, onboardingSyncSessionId, usePluginQuestion } from '../../shared/onboarding-server/wait-command';
import { formatWizardBanner } from '../../shared/onboarding-server/ensure';
import { windsurfSetupReason } from '../../shared/onboarding-server/windsurf-setup';
import { commitWizardLinksShown } from '../../shared/onboarding-server/wizard-links';
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
  resolveRunAgentContext,
  runReachedTerminalVerdict,
  type RunAgentContext,
  scrubProjectStateLocalPrefs,
  stackFingerprint,
  statePath,
  stateVersion,
  writeState,
} from '../../shared/state';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { nowIsoNoMs } from '../../shared/text';
import { authEnforced, isLocallyAuthenticated } from '../../shared/auth';
import { ensureAgentTeamsEnv, ensureCodeGraphForExistingProject, ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner } from './session-start-lib';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { sweepTrafficOneRetention } from '../../shared/retention';
import {
  oneMcpSessionWarning,
  syncOneMcpForSession,
  syncOneMcpOnce,
  type SessionOneMcpSync,
} from './one-mcp-sync';
import { ensureCodexOneMcpServerRegistered } from '../../shared/codex-mcp';
import { oneMcpRegistrationEnabled } from '../../config/one-mcp';
import { sessionPerformanceContext } from '../../shared/session-performance-context';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../shared/run-model-policy';
import { detectHostPlan } from '../../shared/host-plan';
import { canonicalHost } from '../../shared/model-tiers';
import { finalizePaidMaintenanceFallback } from '../../shared/maintenance-fallback';
import { reconcileRunSettlement } from '../../shared/run-settlement';
import { legacyCustomBackendMigration } from '../../shared/architecture-contract';
import { capabilityStateForRun } from '../../shared/architecture-contract';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { removeStrayProjectArtifactsFromGlobalDir } from '../../shared/state/traffic-one-paths';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

// Surface the dashboard setup link without bypassing ask-first or the approved
// bootstrap path when a host sandbox cannot write canonical user-local state.
function setupPendingBanner(ctx: Ctx, cwd: string, banner: string): string {
  // Ask-first: the user has not said yes — never launch the wizard server (or
  // leak its URL) just to decorate the banner. The plain banner is enough.
  if (usePluginQuestionPending(cwd)) return banner;
  const prepared = prepareOnboardingServer(cwd, ctx.host);
  return prepared.kind === 'ready'
    ? formatWizardBanner(ctx.host, prepared.server.dashboardUrl, prepared.server.localWizardUrl, banner)
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
function setupPendingDirective(ctx: Ctx, cwd: string): string {
  // Ask-first: relay the host-chat question — no wizard server, no URL, and no
  // state writes anywhere until the user says whether this project uses Traffic
  // One at all. The triggering prompt rides the yes command as the seed.
  const syncSession = onboardingSyncSessionId(hookSessionIdentity(ctx.input.raw).sessionId);
  if (usePluginQuestionPending(cwd)) return usePluginQuestion(cwd, ctx.host, ctxPromptText(ctx), syncSession);
  const prepared = prepareOnboardingServer(cwd, ctx.host, { syncSession });
  if (prepared.kind !== 'ready') return prepared.reason;
  const { server, waitCommand } = prepared;
  if (!server.dashboardUrl) return block('setup-pending');
  let directive: string;
  // OpenCode/Kilo: keep this factual and compact so their prompt-injection
  // filters do not reject a multi-host walkthrough. The live URL and executable
  // waiter are still present on the first prompt.
  if (ctx.host === 'opencode' || ctx.host === 'kilo') {
    directive = [
      'Traffic One project setup is required before building.',
      `Setup link: ${server.dashboardUrl}`,
      `Direct local fallback: ${server.localWizardUrl}`,
      `Wait command: ${waitCommand}`,
      'Show the setup link, then immediately run the wait command and keep this turn active until setup completes.',
      `If the user does not want Traffic One for this project, run instead: ${onboardingDeclineCommand(cwd, ctx.host)}`,
    ].join('\n\n');
  } else if (ctx.host === 'windsurf') {
    const vars = { URL: server.dashboardUrl, LOCAL_URL: server.localWizardUrl, WAIT_CMD: waitCommand };
    directive = block('windsurf-server-deny-reason', vars, windsurfSetupReason(server.dashboardUrl, server.localWizardUrl, waitCommand));
  } else {
    directive = block('server-deny-reason', {
      URL: server.dashboardUrl,
      LOCAL_URL: server.localWizardUrl,
      WAIT_CMD: waitCommand,
      DECLINE_CMD: onboardingDeclineCommand(cwd, ctx.host),
    });
  }
  commitWizardLinksShown(cwd, server.token, directive, server.dashboardUrl, server.localWizardUrl, syncSession);
  return directive;
}
const STACK_IDS = new Set(Object.keys(STACKS));

function sessionProjectRoot(ctx: Ctx): string {
  return resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
}

// Build the role-scoped (or fix-cycle) rule context for a subagent whose run claim
// resolved and whose project is already materialized. Shared by the subagent
// SessionStart path and the legacy run-agent fast path.
function subagentRoleContext(ctx: Ctx, state: Rec, agentContext: RunAgentContext, root: string): HookResult {
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

function runSessionStartInner(ctx: Ctx): HookResult {
  // Self-heal machines the pre-guard bug touched: project artifacts materialized
  // into the machine dir (session cwd = $HOME) are never legitimate there.
  // Deletes only never-legitimate names; runs before the stand-down guard so a
  // $HOME session still heals itself.
  removeStrayProjectArtifactsFromGlobalDir();
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = sessionProjectRoot(ctx);
  initializeTrafficOneEnv(cwd, ctx.host);
  // Codex registration is machine-global but deliberately inert: the managed
  // server is appended disabled with both tools disabled. Do this independently
  // of per-project pluginUse so installs are deterministic; never rewrite an
  // existing same-name table owned by the user.
  if (ctx.host === 'codex' && oneMcpRegistrationEnabled(process.env)) {
    ensureCodexOneMcpServerRegistered({ ...process.env, TRAFFIC_ONE_HOST: 'codex' });
  }
  // The user chose not to use Traffic One for this project — stay silent.
  // (UserPromptSubmit offers re-enabling when the user explicitly names it.)
  if (pluginUseDeclined(cwd)) return noop();

  // A subagent must never run the full session-start hook (auth gate + onboarding +
  // mode routing). Onboarding belongs to the parent/main agent; the subagent only
  // needs its role-scoped rules. Intercept BEFORE auth + onboarding so a subagent
  // can never re-trigger onboarding while the team is building.
  if (isSubagentThread(ctx.input.raw)) {
    return runSubagentSessionStart(ctx);
  }

  const oneMcpWarning = syncOneMcpAtSessionStart(cwd, ctx.host, ctx.input.raw);
  const withOneMcpWarning = (result: HookResult): HookResult => oneMcpWarning
    ? mergeResults([context(oneMcpWarning), result])
    : result;

  // Auth gate: a pure local boolean read — no per-session remote check. When auth
  // is enforced but the API key isn't entered yet, point at the wizard (the
  // same setup-pending surface onboarding uses). The wizard shows the api-key page
  // because computeOnboarding returns the 'api-key' step while unauthenticated —
  // covering both a fresh project and an already-onboarded one a 401 invalidated.
  if (authEnforced() && !isLocallyAuthenticated()) {
    return withOneMcpWarning(context(setupPendingDirective(ctx, cwd), {
      systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [authentication required]'),
    }));
  }

  // Defer brand-new-project activation to the first prompt. SessionStart fires
  // before any prompt exists, so eagerly writing state + emitting the setup
  // directive here would trip the onboarding gate even for a non-coding question
  // — and Codex opens a fresh scratch dir per task, so EVERY session would look
  // like a new project. Leave a pristine dir untouched and stay silent; the
  // UserPromptSubmit coding-intent guard activates Traffic One only when the
  // first prompt is actually a coding/implementation request (it re-runs this
  // authed body then). An existing codebase still auto-detects below, because its
  // mode is existing-codebase, not new-project.
  const pristine = !fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd));
  if (pristine && detectMode(cwd) === 'new-project') return withOneMcpWarning(noop());

  return withOneMcpWarning(runSessionStartAuthed(ctx));
}

// OpenCode/Kilo can invoke their SessionStart-compatible system transform more
// than once per chat. Consent and the runtime switch are checked BEFORE writing
// the per-session marker; payloads without a stable session id deliberately run
// every time because duplicates are safe and guessing an identity is not.
export function syncOneMcpAtSessionStart(
  cwd: string,
  host: unknown,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  sync: SessionOneMcpSync = syncOneMcpForSession,
  featureEnabled?: boolean,
): string | null {
  const sessionId = onboardingSyncSessionId(hookSessionIdentity(raw).sessionId);
  if (!syncOneMcpOnce(cwd, host, sessionId, env, sync, featureEnabled)) return null;
  return oneMcpSessionWarning(host, env);
}

// The post-auth SessionStart body: skill sweep + digest retention + session
// materialization → subagent fast path → mode-routed rule bundle / directive.
// Exported so its post-gate behavior can be tested directly.
export function runSessionStartAuthed(ctx: Ctx): HookResult {
  const cwd = sessionProjectRoot(ctx);
  initializeTrafficOneEnv(cwd, ctx.host);
  const root = pluginRoot();
  const raw = ctx.input.raw;

  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const legacyMigration = legacyCustomBackendMigration(cwd, state);
  if (legacyMigration.changed) {
    Object.assign(state, legacyMigration.state);
    writeState(cwd, state);
  }
  const settlementRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  // Reconcile only unresolved work. A completed legacy ledger predates the V2
  // evidence sidecars; reopening it as `validating` during a read-only session
  // start would resume/upgrade historical work instead of preserving backward
  // compatibility. New prompt-boundary work receives a fresh strict run.
  if (settlementRunId) {
    const fallback = finalizePaidMaintenanceFallback(cwd, settlementRunId);
    if (fallback.status !== 'completed'
      && !runReachedTerminalVerdict(cwd, settlementRunId)) {
      reconcileRunSettlement(cwd, settlementRunId);
    }
  }

  // Multi-project safety: reset to the 3-skill baseline before copying THIS
  // project's set. Digest retention sweep. Best-effort session materialization.
  cleanActiveSkills();
  sweepOldDigests(cwd, 5);
  pruneExpiredPendingClaims(cwd);
  sweepTrafficOneRetention(cwd, { dryRun: false });
  // Deterministic self-heal: strip any machine-local preference fields (team, toolchain
  // with absolute binPaths, performance, …) a stale runner may have left in the committed
  // .one.json, routing them to the per-user preferences.json. .one.json is not gitignored.
  scrubProjectStateLocalPrefs(cwd);
  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // best-effort; the full branches below still provide rule context
  }

  // ── Subagent fast path (legacy run-agent contexts; detected subagents are
  // already intercepted before auth in runSessionStartInner) ──
  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true, host: ctx.host })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    return subagentRoleContext(ctx, state, agentContext, root);
  }

  const mode = (state.mode as string) || detectMode(cwd);
  state.mode = mode;
  let stackId = state.stack as string | undefined;
  if (mode === 'new-project' && reconcileStackFromArtifacts(cwd, state)) {
    normalizeState(state, mode);
    writeState(cwd, state);
    try {
      ensureSessionMaterialization(cwd, state);
    } catch {
      // best-effort; the normal materialization branch below still provides context
    }
    stackId = state.stack as string | undefined;
  }
  if (stackId && isKnownStack(stackId)) {
    normalizeState(state, mode);
    stackId = state.stack as string;
  }

  const onboardingComplete = Boolean(state.onboardingComplete);
  const onboardingReady = onboardingComplete
    && typeof stackId === 'string' && STACK_IDS.has(stackId)
    && (mode !== 'new-project' || !isNewProjectOnboardingIncomplete(state, ctx.host));
  // Preference acknowledgements are keyed by the canonical project root. Never
  // let a nested package or the hook process cwd select another project's hash.
  const localPreferenceTarget = currentLocalPreferenceTarget(
    ctx.host,
    { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
    cwd,
  );

  // ── Flow 1 — already onboarded → pack the rule bundle ──
  if (onboardingReady) {
    const activeStackId = String(stackId);
    if (nextLocalPreferenceStep(state, ctx.host, localPreferenceTarget)) {
      return context(`[ACTIVE STACK: ${activeStackId}]\n\n${setupPendingDirective(ctx, cwd)}`, {
        systemMessage: setupPendingBanner(ctx, cwd, `traffic-one [${activeStackId}] setup required`),
      });
    }

    const capabilityState = capabilityStateForRun(cwd, state);
    const spec = stackSpecForState(capabilityState);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;

    const copied = copyActiveSkills(capabilityState, ctx.host);
    const skillDirective = pruneSkillsDirective(capabilityState, listAllSkills(), ctx.host);
    stampMaterialization(cwd, state);
    // The materialized project AGENTS.md/CLAUDE.md (just re-stamped) carries the
    // same Active Rule Index and is auto-loaded by every host — re-listing the
    // paths here duplicates ~400-500 tokens per session. Emit the full bundle
    // only when the mirror is missing.
    const body = hasMaterializedProjectAssets(cwd, state)
      ? 'Active rules are indexed in the project AGENTS.md / CLAUDE.md (read rule bodies on demand from `.traffic-one/rules/**`).\n'
      : packBundle(root, modeMandatory, spec.optional).body;
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the code graph if an existing project is missing it

    // Freeze the model catalog before any parent-side spawn map is emitted. The
    // run snapshot is create-once; a later machine-global One MCP update affects
    // the next run, never children already pinned to this one.
    const team = obj(state.team);
    const existingRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    // SessionStart runs before the prompt is known. Do not pre-mint a maintenance
    // run here: runtime-only prompts must remain parent-only and create no run.
    // Worker-routing/model gates freeze policy when an implementation prompt
    // actually starts work. Existing runs still get their immutable policy read.
    if (team?.mode === 'subagents' && (!isMaintenancePhase(state, mode) || existingRunId)) {
      const runId = ensureCurrentRunId(cwd, state);
      const policy = ensureRunModelPolicy(
        cwd,
        runId,
        ctx.host,
        state,
        { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
      );
      if (!policy) {
        if (ctx.host === 'cursor'
          && freshCursorModels(cwd, detectHostPlan('cursor')).length === 0) {
          return context(
            `TRAFFIC_ONE_CURSOR_MODELS_REQUIRED\nBefore run ${runId} can be frozen, enumerate the exact model ids in Cursor's Task picker and run:\n`
            + `${modelCaptureCommand(cwd, 'cursor')}\n`
            + 'Then retry the parent action. Traffic One will create model-policy.json only after those exact runnable slugs are available.',
            { systemMessage: 'traffic-one: capture Cursor subagent models before starting the immutable run' },
          );
        }
        return context(
          `TRAFFIC_ONE_MODEL_POLICY_BLOCKED\nThe acknowledged Performance target could not be frozen for run ${runId}. `
          + 'Do not spawn a child. Reopen Performance and retry this parent session after the active host/plan target is acknowledged.',
          { systemMessage: 'traffic-one: subagent spawning paused until the immutable run model policy can be created' },
        );
      }
    }

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    header += sessionPerformanceContext(state, ctx.host, process.env, cwd);
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd, state.codeGraphProvider);
    const orchestration = buildOrchestrationDirective(cwd, ctx.host, state);
    if (orchestration) header += `${orchestration}\n`;
    writeState(cwd, state);
    return context(`${header}${graphPreview}\n${body}`);
  }

  // ── Flow 2 — existing project with detectable stack → auto-write + prune ──
  if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
    // Ask-first: the user has not said whether this project uses Traffic One.
    // Emit ONLY the question — no auto-detected state write, no materialization,
    // no code graph — so a "no" leaves the repo byte-identical.
    if (usePluginQuestionPending(cwd)) {
      return context(setupPendingDirective(ctx, cwd), {
        systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
      });
    }
    const detected = detectStackFromCodebase(cwd);
    if (!detected.stack) {
      detected.stack = 'minimal';
      detected.backend = detected.backend || 'other';
      detected.realtime = detected.realtime || 'none';
      detected.evidence.push('existing codebase detected → apply minimal stack baseline');
    }
    Object.assign(state, {
      mode,
      stack: detected.stack,
      backend: detected.backend || 'other',
      frontend: detected.frontend || 'none',
      ...(detected.mobile ? { mobile: detected.mobile } : {}),
      realtime: detected.realtime || 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: nowIsoNoMs(),
      autoDetected: true,
      evidence: detected.evidence,
      // An existing codebase is already built → maintenance phase from first
      // detection, so post-build triage applies to the user's first prompt.
      lifecycle: maintenanceLifecycle('existing-detected'),
    });
    normalizeState(state, mode);

    const capabilityState = capabilityStateForRun(cwd, state);
    const spec = stackSpecForState(capabilityState);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body } = packBundle(root, modeMandatory, spec.optional);

    const copied = copyActiveSkills(capabilityState, ctx.host);
    const allSkills = listAllSkills();
    stampMaterialization(cwd, state);
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the graph for a freshly auto-detected existing project
    writeState(cwd, state);
    const skillDirective = pruneSkillsDirective(capabilityState, allSkills, ctx.host);

    const banner = autoDetectedAnnouncement(detected as never);
    let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    header += sessionPerformanceContext(state, ctx.host, process.env, cwd);
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd, state.codeGraphProvider);
    if (nextLocalPreferenceStep(state, ctx.host, localPreferenceTarget)) {
      return context(`${banner}\n\n${setupPendingDirective(ctx, cwd)}`, {
        systemMessage: setupPendingBanner(ctx, cwd, `traffic-one [${state.stack || mode}] setup required`),
      });
    }
    return context(`${banner}\n\n${header}${graphPreview}\n${body}`);
  }

  if (mode === 'new-project' && stackId && isNewProjectOnboardingIncomplete(state, ctx.host)) {
    return context(`[ACTIVE STACK: ${stackId}]\n\n${setupPendingDirective(ctx, cwd)}`, {
      systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
    });
  }

  // ── Flow 3 — new project (or undetectable existing) → point at the setup wizard ──
  // On Cursor the directive carries the live URL + "post the link FIRST" recipe in the
  // agent-facing channel (additional_context); other hosts keep the plain note.
  const directive = setupPendingDirective(ctx, cwd);
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional);
  // Ask-first: no writes until the user answers — the yes command (`--use`)
  // creates the project state; a no leaves the project untouched. Otherwise
  // stamp the stub state (mode + toolchain skeleton) exactly as before.
  if (!usePluginQuestionPending(cwd)) {
    if (!obj(state.toolchain)) state.toolchain = initializeToolchainState();
    writeState(cwd, state);
  }
  return context(`${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`, {
    systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
  });
}

// Stamp materialization fields after a successful copy (best-effort).
function stampMaterialization(cwd: string, state: Rec): void {
  try {
    const materialized = materializeProjectAssets(cwd, state);
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIsoNoMs();
      state.materializedVersion = stateVersion();
    }
  } catch {
    // best-effort; the in-memory bundle is still provided
  }
}

// Fail-closed: a throw anywhere in SessionStart must never crash the hook. The
// auth instruction / noop still surfaces; the try/catch below guarantees exit-0.
export function runSessionStart(ctx: Ctx): HookResult {
  try {
    return runSessionStartInner(ctx);
  } catch {
    return noop();
  }
}
