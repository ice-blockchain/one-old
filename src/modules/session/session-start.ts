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

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { isKnownStack } from '../../shared/config';
import { detectMode, detectStackFromCodebase, reconcileStackFromArtifacts } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { autoDetectedAnnouncement } from '../../shared/directives';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { packBundle, packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective, roleSkillsDirective } from '../../shared/skill-filters';
import { ensureOnboardingServer, formatWizardBanner } from '../../shared/onboarding-server/ensure';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import { makeSkillBlock } from '../../shared/skill-block';
import { roleScopedRules, STACKS, stackSpecForState } from '../../shared/stacks';
import {
  hasRunAgentState,
  hookSessionIdentity,
  legacyRunAgentContext,
  legacyStatePath,
  maintenanceLifecycle,
  normalizeState,
  pruneExpiredPendingClaims,
  readEffectiveState,
  resolveRunAgentContext,
  type RunAgentContext,
  scrubProjectStateLocalPrefs,
  stackFingerprint,
  statePath,
  stateVersion,
  writeState,
} from '../../shared/state';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { nowIsoNoMs } from '../../shared/text';
import { authChoiceAllowsContinue, tryWriteAuthChoice } from './auth-choice';
import { authGateForHook, authRequiredHookResult } from './auth-gate';
import { ensureAgentTeamsEnv, ensureCodeGraphForExistingProject, ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner } from './session-start-lib';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { sweepTrafficOneRetention } from '../../shared/retention';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

// Surface the live wizard URL in the setup banner. Host-gated to Cursor (only it
// needs the URL in the user-facing channel — see formatWizardBanner) so we don't spawn
// the server on other hosts; spawning up front is idempotent (the PreToolUse gate
// reuses it). Best-effort: a spawn failure falls back to the plain banner (the
// PreToolUse deny still carries the URL).
function setupPendingBanner(ctx: Ctx, cwd: string, banner: string): string {
  if (ctx.host !== 'cursor') return banner;
  try {
    return formatWizardBanner(ctx.host, ensureOnboardingServer(cwd, { host: ctx.host }).url, banner);
  } catch {
    return banner;
  }
}

// The AGENT-FACING setup directive (additional_context). On Cursor the user-facing
// channel (systemMessage→user_message) is NOT rendered on user-prompt-submit, so the
// URL-less `setup-pending` prose leaves the agent with no link and no instruction to
// post one — the user gets stuck (the 5b first-prompt failure). For Cursor, emit the
// full `server-deny-reason` recipe instead: it carries the live URL AND the explicit
// "post the wizard URL FIRST, before the wait command" instruction. Other hosts keep
// the plain `setup-pending` note (Claude opens via its preview pane, Codex via node_repl
// — both driven by the PreToolUse deny recipe, neither needs the link surfaced in chat).
// Best-effort: a server-spawn failure falls back to the plain note (the PreToolUse deny
// still carries the URL). Single source for every SessionStart/Flow-3 setup-pending path.
function setupPendingDirective(ctx: Ctx, cwd: string): string {
  // OpenCode: the full setup-pending block (with "do NOT…" behavioral overrides)
  // can trigger the model's prompt-injection safety training when injected via
  // system prompt. Use a minimal, factual message instead.
  if (ctx.host === 'opencode') {
    return 'Traffic One project setup is required. A setup wizard will open — share the link with the user when available. Building is blocked until setup completes.';
  }
  if (ctx.host !== 'cursor') return block('setup-pending');
  try {
    const server = ensureOnboardingServer(cwd, { host: ctx.host });
    if (!server.url || server.url.includes(':0/')) return block('setup-pending');
    return block('server-deny-reason', { URL: server.url, WAIT_CMD: onboardingWaitCommand(cwd, ctx.host) });
  } catch {
    return block('setup-pending');
  }
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
  const role = typeof agentContext.role === 'string' ? agentContext.role : '';
  const runId = String(agentContext.runId ?? '');
  const spawnIndex = agentContext.spawnIndex || 0;

  if (role && spawnIndex > 1) {
    // Fix-cycle: same role re-spawned in the same run → tiny pointer header.
    const { body } = packFixCycleHeader(cwd, role, runId, spawnIndex);
    return context(body);
  }

  const ruleSet = role ? roleScopedRules(role, state) : null;
  const rules = ruleSet || stackSpecForState(state).mandatory;
  copyActiveSkills(state);
  // Role-scoped skills (from the role's agent-doc frontmatter) when the role is
  // known — a senior-frontend spawn lists only frontend skills, not the whole
  // stack catalog plus a 30-name wrong-stack dump.
  const skillDirective = role
    ? roleSkillsDirective(state, role, listAllSkills())
    : pruneSkillsDirective(state, listAllSkills());
  const { body } = packRuleIndex(root, rules);
  const graphPreview = readGraphPreview(cwd);
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
  const state = readEffectiveState(cwd);

  cleanActiveSkills();
  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // best-effort; the parent already materialized the bundle
  }

  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    return subagentRoleContext(ctx, state, agentContext, root);
  }

  // Role/claim not resolved yet — still never onboard. Hand over whatever rules are
  // materialized; if none yet, stay silent and let the parent's materialization land.
  if (hasMaterializedProjectAssets(cwd, state)) {
    copyActiveSkills(state);
    const { body } = packRuleIndex(root, stackSpecForState(state).mandatory);
    return context('═══ traffic-one — subagent ═══\n'
      + '[subagent] Rules already materialized to .traffic-one/rules/; read role-scoped rules on demand.\n'
      + body);
  }
  return noop();
}

function runSessionStartInner(ctx: Ctx): HookResult {
  if (isPluginAuthoringRoot(ctx.cwd)) return noop();
  const cwd = sessionProjectRoot(ctx);

  // A subagent must never run the full session-start hook (auth gate + onboarding +
  // mode routing). Onboarding belongs to the parent/main agent; the subagent only
  // needs its role-scoped rules. Intercept BEFORE auth + onboarding so a subagent
  // can never re-trigger onboarding while the team is building.
  if (hookSessionIdentity(ctx.input.raw).isSubagent) {
    return runSubagentSessionStart(ctx);
  }

  const authGate = authGateForHook({ forceRemote: true });
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue(cwd)) return noop();
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('SessionStart', { authChoiceWrite: writeResult });
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
  if (pristine && detectMode(cwd) === 'new-project') return noop();

  return runSessionStartAuthed(ctx);
}

// The post-auth SessionStart body: skill sweep + digest retention + session
// materialization → subagent fast path → mode-routed rule bundle / directive.
// Exported so it can be tested without the forced remote auth probe.
export function runSessionStartAuthed(ctx: Ctx): HookResult {
  const cwd = sessionProjectRoot(ctx);
  const root = pluginRoot();
  const raw = ctx.input.raw;

  const state = readEffectiveState(cwd);

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
  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true })
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

  // ── Flow 1 — already onboarded → pack the rule bundle ──
  if (onboardingReady) {
    const activeStackId = String(stackId);
    if (nextLocalPreferenceStep(state, ctx.host)) {
      return context(`[ACTIVE STACK: ${activeStackId}]\n\n${setupPendingDirective(ctx, cwd)}`, {
        systemMessage: setupPendingBanner(ctx, cwd, `traffic-one [${activeStackId}] setup required`),
      });
    }

    const spec = stackSpecForState(state);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;

    const copied = copyActiveSkills(state);
    const skillDirective = pruneSkillsDirective(state, listAllSkills());
    stampMaterialization(cwd, state);
    // The materialized project AGENTS.md/CLAUDE.md (just re-stamped) carries the
    // same Active Rule Index and is auto-loaded by every host — re-listing the
    // paths here duplicates ~400-500 tokens per session. Emit the full bundle
    // only when the mirror is missing.
    const body = hasMaterializedProjectAssets(cwd, state)
      ? 'Active rules are indexed in the project AGENTS.md / CLAUDE.md (read rule bodies on demand from `.traffic-one/rules/**`).\n'
      : packBundle(root, modeMandatory, spec.optional).body;
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the code graph if an existing project is missing it

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd);
    writeState(cwd, state);
    return context(`${header}${graphPreview}\n${body}`);
  }

  // ── Flow 2 — existing project with detectable stack → auto-write + prune ──
  if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
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

    const spec = stackSpecForState(state);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body } = packBundle(root, modeMandatory, spec.optional);

    const copied = copyActiveSkills(state);
    const allSkills = listAllSkills();
    stampMaterialization(cwd, state);
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the graph for a freshly auto-detected existing project
    writeState(cwd, state);
    const skillDirective = pruneSkillsDirective(state, allSkills);

    const banner = autoDetectedAnnouncement(detected as never);
    let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd);
    if (nextLocalPreferenceStep(state, ctx.host)) {
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
  if (!obj(state.toolchain)) state.toolchain = initializeToolchainState();
  writeState(cwd, state);
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
