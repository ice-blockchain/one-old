// src/modules/session/session-start.ts
// SessionStart handler: auth gate (fail-closed) → multi-project skill sweep +
// digest retention + session materialization → subagent fast path (fix-cycle /
// role-scoped index) → mode routing (onboarded bundle / existing-codebase
// auto-detect / new-project onboarding directive). Ported 1:1 from
// runSessionStart (session-start.cjs). The one-mcp reporter is a Step-5 runner —
// no-op'd here (TODO: wire at Step 5).

import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { BUDGET_CHARS, isKnownStack } from '../../shared/config';
import { detectMode, detectStackFromCodebase } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { autoDetectedAnnouncement } from '../../shared/directives';
import { onboardingDirectiveNewProject } from '../../shared/onboarding/session-directive';
import type { OnboardingBlock } from '../../shared/onboarding/fallbacks';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { packBundle, packFixCycleHeader, packRuleIndex } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective } from '../../shared/skill-filters';
import { makeSkillBlock } from '../../shared/skill-block';
import { roleScopedRules, STACKS, stackSpecForState } from '../../shared/stacks';
import {
  hasRunAgentState,
  legacyRunAgentContext,
  normalizeState,
  readEffectiveState,
  resolveRunAgentContext,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { nowIsoNoMs } from '../../shared/text';
import { authChoiceAllowsContinue, tryWriteAuthChoice } from './auth-choice';
import { authGateForHook, authRequiredHookResult } from './auth-gate';
import { ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner } from './session-start-lib';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const STACK_IDS = new Set(Object.keys(STACKS));

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function runSessionStartInner(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();

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

  // ── Subagent fast path ──
  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
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
    const spec = stackSpecForState(state);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

    const copied = copyActiveSkills(state);
    const skillDirective = pruneSkillsDirective(state, listAllSkills());
    stampMaterialization(cwd, state);

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    if (dropped.length > 0) header += `[${dropped.length} rule file(s) deferred to path-scoped attach]\n`;
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
    const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

    const copied = copyActiveSkills(state);
    const allSkills = listAllSkills();
    stampMaterialization(cwd, state);
    writeState(cwd, state);
    const skillDirective = pruneSkillsDirective(state, allSkills);

    const banner = autoDetectedAnnouncement(detected as never);
    let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    if (dropped.length > 0) header += `[${dropped.length} rule file(s) deferred]\n`;
    header += tokenEconomyBanner(cwd);
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd);
    return context(`${banner}\n\n${header}${graphPreview}\n${body}`);
  }

  // ── Flow 3 — new project (or undetectable existing) → onboarding directive ──
  const directive = onboardingDirectiveNewProject(block);
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional, Math.floor(BUDGET_CHARS / 2));
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
// auth instruction / noop still surfaces; core/errors guarantees exit-0.
export function runSessionStart(ctx: Ctx): HookResult {
  try {
    return runSessionStartInner(ctx);
  } catch {
    return noop();
  }
}
