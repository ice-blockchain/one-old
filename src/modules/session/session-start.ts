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
import { detectMode, detectStackFromCodebase } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { autoDetectedAnnouncement } from '../../shared/directives';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { packBundle, packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { ORCHESTRATOR_SKILLS } from '../../config/skill-filters';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective } from '../../shared/skill-filters';
import { makeSkillBlock } from '../../shared/skill-block';
import { ORCHESTRATOR_RULES, roleScopedRules, STACKS, stackSpecForState } from '../../shared/stacks';
import {
  hasRunAgentState,
  hookSessionIdentity,
  legacyRunAgentContext,
  normalizeState,
  readEffectiveState,
  resolveRunAgentContext,
  resolvedTeamMode,
  type RunAgentContext,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { nowIsoNoMs } from '../../shared/text';
import { authChoiceAllowsContinue, tryWriteAuthChoice } from './auth-choice';
import { authGateForHook, authRequiredHookResult } from './auth-gate';
import { ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner } from './session-start-lib';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);
const STACK_IDS = new Set(Object.keys(STACKS));

const ORCHESTRATOR_HEADER = '[orchestrator] subagents mode — implementation rules & skills are delegated to '
  + 'role agents; this context is orchestration-only.\n';

// Build the main-agent rule bundle + skill directive for an onboarded session.
// In team.mode="subagents" the main agent is a pure orchestrator: it is shown only
// ORCHESTRATOR_RULES + the orchestration skill, never the implementation/stack
// rules & skills — those are delegated to the role subagents and stay materialized
// on disk for them (copyActiveSkills still writes the FULL set every session).
function mainAgentBundle(
  root: string,
  state: Rec,
  modeMandatory: readonly string[],
  optional: readonly string[],
): { body: string; skillDirective: string; copied: number; orchestrating: boolean } {
  const orchestrating = resolvedTeamMode(state) === 'subagents';
  const mandatory = orchestrating ? ORCHESTRATOR_RULES : modeMandatory;
  const { body } = packBundle(root, mandatory, orchestrating ? [] : optional);
  const copied = copyActiveSkills(state);
  const skillDirective = pruneSkillsDirective(state, listAllSkills(), orchestrating ? ORCHESTRATOR_SKILLS : undefined);
  return { body, skillDirective, copied, orchestrating };
}

// Build the role-scoped (or fix-cycle) rule context for a subagent whose run claim
// resolved and whose project is already materialized. Shared by the subagent
// SessionStart path and the legacy run-agent fast path.
function subagentRoleContext(ctx: Ctx, state: Rec, agentContext: RunAgentContext, root: string): HookResult {
  const cwd = ctx.cwd;
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
  const skillDirective = pruneSkillsDirective(state, listAllSkills());
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
  const cwd = ctx.cwd;
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
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();

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

  return runSessionStartAuthed(ctx);
}

// The post-auth SessionStart body: skill sweep + digest retention + session
// materialization → subagent fast path → mode-routed rule bundle / directive.
// Exported so it can be tested without the forced remote auth probe.
export function runSessionStartAuthed(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  const root = pluginRoot();
  const raw = ctx.input.raw;

  const state = readEffectiveState(cwd);

  // Multi-project safety: reset to the 3-skill baseline before copying THIS
  // project's set. Digest retention sweep. Best-effort session materialization.
  cleanActiveSkills();
  sweepOldDigests(cwd, 5);
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
  if (stackId && isKnownStack(stackId)) {
    normalizeState(state, mode);
    stackId = state.stack as string;
  }

  const onboardingComplete = Boolean(state.onboardingComplete);
  const onboardingReady = onboardingComplete
    && typeof stackId === 'string' && STACK_IDS.has(stackId)
    && (mode !== 'new-project' || !isNewProjectOnboardingIncomplete(state));

  // ── Flow 1 — already onboarded → pack the rule bundle ──
  if (onboardingReady) {
    const activeStackId = String(stackId);
    if (nextLocalPreferenceStep(state)) {
      return context(`[ACTIVE STACK: ${activeStackId}]\n\n${block('setup-pending')}`, {
        systemMessage: `traffic-one [${activeStackId}] setup required`,
      });
    }

    const spec = stackSpecForState(state);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body, skillDirective, copied, orchestrating } = mainAgentBundle(root, state, modeMandatory, spec.optional);
    stampMaterialization(cwd, state);

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (orchestrating) header += ORCHESTRATOR_HEADER;
    else if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
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
    });
    normalizeState(state, mode);

    const spec = stackSpecForState(state);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body, skillDirective, copied, orchestrating } = mainAgentBundle(root, state, modeMandatory, spec.optional);
    stampMaterialization(cwd, state);
    writeState(cwd, state);

    const banner = autoDetectedAnnouncement(detected as never);
    let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (orchestrating) header += ORCHESTRATOR_HEADER;
    else if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd);
    if (nextLocalPreferenceStep(state)) {
      return context(`${banner}\n\n${block('setup-pending')}`, {
        systemMessage: `traffic-one [${state.stack || mode}] setup required`,
      });
    }
    return context(`${banner}\n\n${header}${graphPreview}\n${body}`);
  }

  if (mode === 'new-project' && stackId && isNewProjectOnboardingIncomplete(state)) {
    return context(`[ACTIVE STACK: ${stackId}]\n\n${block('setup-pending')}`, {
      systemMessage: 'traffic-one [setup required]',
    });
  }

  // ── Flow 3 — new project (or undetectable existing) → point at the setup wizard ──
  const directive = block('setup-pending');
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional);
  if (!obj(state.toolchain)) state.toolchain = initializeToolchainState();
  writeState(cwd, state);
  return context(`${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`);
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
