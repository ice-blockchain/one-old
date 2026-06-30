// src/shared/onboarding-server/flow.ts
// The onboarding wizard's server-side brain: compute the next unresolved step and
// apply a single answer by writing the SAME state the agent used to write. Pure
// state IO (no HTTP, no child_process) so it is unit-testable in isolation. The
// step set + ordering is delegated to the existing predicates (nextOnboardingStep
// for new projects, nextLocalPreferenceStep for already-configured ones); this
// module only maps an answer → a writeState/mergeProjectPrefs call. The code-graph
// install is returned as a `task` signal for the HTTP layer to run out-of-band.

import { classifyPromptForStack, detectMode, promptHasStackSignal, reconcileStackFromArtifacts } from '../detection';
import * as fs from 'fs';
import { obj, type Rec } from '../obj';
import { isNewProjectOnboardingIncomplete } from '../onboarding/predicates';
import { nextOnboardingStep } from '../onboarding/prompts';
import { nextLocalPreferenceStep } from '../onboarding/local-prefs';
import {
  projectContextDomainQuestionLines,
  projectContextOriginalPrompt,
} from '../onboarding/project-context';
import { detectHost } from '../host';
import { detectHostPlan } from '../host-plan';
import { PERFORMANCE_CONFIG } from '../../config/performance';
import { STEP_COPY, TEAM_ROLES, type StepCopy, type WizardStepId } from '../../config/onboarding';
import { TIER_IDS } from '../../config/model-tiers';
import { recommendTierForPlan, resolveModel } from '../model-tiers';
import { effectiveTierForRole, modelForRoleHost, openCodeDelegationActive, teamModeForLevel, type PlanCtx } from '../performance';
import { recommendLevelForPlan } from '../performance-config';
import { stateTimestamp } from '../state/io';
import {
  applyGlobalCodeGraphProvider,
  effectiveState,
  mergeProjectPrefs,
  projectPrefsPath,
  readEffectiveState,
  readGlobalCodeGraphProvider,
  readProjectPrefs,
  readState,
  writeGlobalCodeGraphProvider,
  writeProjectPrefs,
  writeState,
} from '../state';

// The action the wizard should take next: a question id, 'finalize' (new-project,
// all questions answered, commit the canonical state), or null (fully onboarded).
export type WizardStep = WizardStepId | 'finalize' | null;

// Re-exported so existing importers keep resolving these leaf types from flow.ts;
// the definitions (and the static step copy) now live in config/onboarding.ts.
export type { StepOption, FormField } from '../../config/onboarding';

// One subagent in the team-confirmation line-up: a role, what it does, the
// capability tier it runs at for the chosen performance level, and the concrete
// model id resolved for the active host (opus/sonnet/haiku, gpt-5.x, …).
export interface TeamMember {
  role: string;
  label: string;
  blurb: string;
  tier: string;
  model: string;
}

// The static step copy (kind/title/question/options/fields) is owned by
// config/onboarding.ts (STEP_COPY); StepMeta layers on the fields flow.ts
// resolves at display time.
export interface StepMeta extends StepCopy {
  step: WizardStep;
  domainQuestions?: string[];
  team?: TeamMember[];
  performanceLevel?: string;
  recommendedLevel?: string;
  recommendedTier?: string;
  host?: string;
  // The model choices offered per agent on the team step: the detected host's
  // capability tiers (highest/balanced/cheapest) resolved to concrete model ids
  // (opus/sonnet/haiku, gpt-5.x, …). The wizard renders one <select> per role
  // from this list; the chosen tier is sent back as a team.overrides entry.
  modelChoices?: { tier: string; model: string }[];
}

// Build the per-role line-up for a performance level + host. Empty for levels with
// no subagent team (low / main-agent) or an unknown level.
export function buildTeamLineup(level: string, host: string, overrides?: Rec | null, planCtx?: PlanCtx | null): TeamMember[] {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || cfg.teamMode !== 'subagents') return [];
  const out: TeamMember[] = [];
  for (const r of TEAM_ROLES) {
    const tier = effectiveTierForRole(level, r.role, overrides || null, planCtx || null);
    if (!tier) continue;
    const model = modelForRoleHost(level, r.role, host, overrides || null, planCtx || null) || tier;
    out.push({ role: r.role, label: r.label, blurb: r.blurb, tier, model });
  }
  return out;
}

export interface OnboardingView {
  mode: string;
  stack: string | null;
  step: WizardStep;
  done: boolean;
  meta: StepMeta;
  originalPrompt: string;
}

export interface AnswerOutcome {
  ok: boolean;
  error?: string;
  // The code-graph answer kicks the consolidated install task (graph provider +
  // OpenCode) so the wizard can gate "Setup complete" on it. When that step is
  // SKIPPED (codeGraphProvider already set machine-wide by an earlier project),
  // the flow's terminal answer fires the same task instead — otherwise OpenCode
  // stays unstamped in this project's prefs and delegation silently never
  // activates for the whole first build (observed 2026-06-12 on Codex).
  task?: { kind: 'onboarding-toolchain' };
}

function metaForStep(step: WizardStep, originalPrompt: string): StepMeta {
  if (step === null) {
    return { step: null, kind: 'done', title: 'All set', question: 'Traffic One setup is complete.' };
  }
  if (step === 'finalize') {
    return { step: 'finalize', kind: 'finalize', title: 'Finishing setup', question: 'Saving your configuration…' };
  }
  const base = STEP_COPY[step];
  const meta: StepMeta = { step, ...base };
  if (step === 'project-context') meta.domainQuestions = projectContextDomainQuestionLines(originalPrompt);
  return meta;
}

export function effectiveOnboardingState(cwd: string): { state: Rec; mode: string } {
  const state = readEffectiveState(cwd);
  const mode = (typeof state.mode === 'string' && state.mode) || detectMode(cwd);
  return { state: { ...state, mode }, mode };
}

// Fail closed: shared .one.json can show onboardingComplete while per-user prefs
// never landed on disk (observed on OpenCode/Electron when ~/.traffic-one is not
// writable). Require the prefs file + effective fields before reporting done.
function lacksDurableOnboardingState(cwd: string, state: Rec, host: string): boolean {
  // Sparse existing projects may have no stack yet — local prefs are not required then.
  if (typeof state.stack !== 'string' || !state.stack.trim()) return false;
  let prefsFileExists = false;
  try {
    prefsFileExists = fs.existsSync(projectPrefsPath(cwd));
  } catch {
    prefsFileExists = false;
  }
  const prefs = readProjectPrefs(cwd);
  if (!prefsFileExists && Object.keys(prefs).length === 0) return true;
  const effective = applyGlobalCodeGraphProvider(effectiveState(state, prefs), process.env, cwd);
  if (isNewProjectOnboardingIncomplete(effective, host)) return true;
  if (nextLocalPreferenceStep(effective, host) != null) return true;
  const provider = readGlobalCodeGraphProvider() || (typeof effective.codeGraphProvider === 'string' ? effective.codeGraphProvider : null);
  return provider !== 'gitnexus' && provider !== 'graphify';
}

function stepWhenDurablePrefsMissing(cwd: string, state: Rec, mode: string, host: string): WizardStep {
  if (mode === 'new-project') {
    if (isNewProjectOnboardingIncomplete(state, host)) {
      const raw = nextOnboardingStep(state, host);
      return raw === 'state' ? 'finalize' : (raw as WizardStep);
    }
    const raw = nextLocalPreferenceStep(state, host);
    return (raw as WizardStep) ?? 'performance';
  }
  const raw = nextLocalPreferenceStep(state, host);
  return (raw as WizardStep) ?? 'performance';
}

function enrichStepMeta(meta: StepMeta, step: WizardStep, state: Rec): StepMeta {
  if (step === 'team-confirmation') enrichTeamMeta(meta, state);
  if (step === 'performance') enrichPerformanceMeta(meta, state);
  return meta;
}

export function computeOnboarding(cwd: string): OnboardingView {
  const { state, mode } = effectiveOnboardingState(cwd);
  const originalPrompt = projectContextOriginalPrompt(state);
  const host = detectHost();
  let step: WizardStep;
  let done: boolean;

  if (mode === 'new-project') {
    if (isNewProjectOnboardingIncomplete(state, host)) {
      const raw = nextOnboardingStep(state, host);
      step = raw === 'state' ? 'finalize' : (raw as WizardStep);
      done = false;
    } else {
      const raw = nextLocalPreferenceStep(state, host);
      step = (raw as WizardStep) ?? null;
      done = raw == null;
    }
  } else {
    const raw = nextLocalPreferenceStep(state, host);
    step = (raw as WizardStep) ?? null;
    done = raw == null;
  }

  if (done && lacksDurableOnboardingState(cwd, state, host)) {
    done = false;
    step = stepWhenDurablePrefsMissing(cwd, state, mode, host);
  }
  const meta = enrichStepMeta(metaForStep(step, originalPrompt), step, state);

  return {
    mode,
    stack: typeof state.stack === 'string' ? state.stack : null,
    step,
    done,
    originalPrompt,
    meta,
  };
}

// Attach the resolved subagent line-up (role → tier → host model) so the wizard's
// team step can SHOW who will build, instead of asking for a blind approval.
function enrichTeamMeta(meta: StepMeta, state: Rec): void {
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  const team = obj(state.team);
  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const host = detectHost();
  const planCtx: PlanCtx = { host, plan: detectHostPlan(host), useOpenCode: openCodeDelegationActive(state, host) };
  meta.team = buildTeamLineup(level, host, overrides, planCtx);
  meta.performanceLevel = level;
  meta.recommendedTier = recommendTierForPlan(host, planCtx.plan, planCtx.useOpenCode);
  meta.host = host;
  // The per-agent model menu: each tier resolved to the detected host's model id,
  // so the wizard can offer real model names (and the user's pick maps straight
  // back to a tier override the spawn gate already understands).
  meta.modelChoices = TIER_IDS.map((tier) => ({ tier, model: resolveModel(tier, host, planCtx.plan) || tier }));
}

// Pre-select the wizard's recommended performance level from the detected plan +
// the OpenCode opt-in: move it first and tag its hint "Recommended". Clones the
// option objects so the shared STEP_META copy is never mutated.
function enrichPerformanceMeta(meta: StepMeta, state: Rec): void {
  const host = detectHost();
  const plan = detectHostPlan(host);
  const useOpenCode = openCodeDelegationActive(state, host);
  const recommended = recommendLevelForPlan(host, plan, useOpenCode);
  const options = (meta.options || []).map((o) => ({ ...o }));
  for (const o of options) {
    if (o.id === recommended) o.hint = o.hint ? `Recommended — ${o.hint}` : 'Recommended';
  }
  options.sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0));
  meta.options = options;
  meta.recommendedLevel = recommended;
  meta.recommendedTier = recommendTierForPlan(host, plan, useOpenCode);
  meta.host = host;
}

// ── Answer application ──────────────────────────────────────────────────────────
function patchSharedState(cwd: string, patch: Rec): void {
  writeState(cwd, { ...readState(cwd), ...patch });
}

function clearPrefKeys(cwd: string, keys: string[]): void {
  const prefs = readProjectPrefs(cwd);
  for (const key of keys) delete prefs[key];
  writeProjectPrefs(cwd, prefs);
}

function mobileFromChoice(value: unknown): { enabled: boolean; framework: string } | null {
  switch (String(value)) {
    case 'web_only':
      return { enabled: false, framework: 'none' };
    case 'ionic_capacitor':
      return { enabled: true, framework: 'ionic-capacitor' };
    case 'react_native_expo':
      return { enabled: true, framework: 'react-native-expo' };
    default:
      return null;
  }
}

function deriveStack(originalPrompt: string, mobileFramework: string): { stack: string; frontend: string; backend: string } {
  const cls = classifyPromptForStack(originalPrompt);
  let { stack, frontend, backend } = cls;
  if (mobileFramework === 'react-native-expo') {
    frontend = 'none';
    if (stack === 'minimal') stack = 'custom-frontend';
    if (backend === 'none') backend = 'supabase';
  } else if (mobileFramework === 'ionic-capacitor') {
    if (frontend === 'none') frontend = 'react-vite';
    if (stack === 'minimal') stack = 'default';
    if (backend === 'none') backend = 'supabase';
  }
  return { stack, frontend, backend };
}

// True when a tool the user opted into still has no per-project toolchain stamp:
// OpenCode enabled but unstamped, or a chosen graph provider unstamped. Drives
// the terminal-answer install-task fallback below — the stamp lives in this
// project's prefs, so a machine-wide provider choice from an earlier project
// does NOT mean this project's toolchain is ready.
function toolchainInstallPending(state: Rec, host: string): boolean {
  const tc = obj(state.toolchain);
  const stamped = (tool: string): boolean => {
    const entry = tc ? obj(tc[tool]) : null;
    return typeof entry?.installedVersion === 'string' && entry.installedVersion.length > 0;
  };
  if (host !== 'opencode' && obj(state.openCode)?.enabled === true && !stamped('opencode')) return true;
  const provider = state.codeGraphProvider;
  if ((provider === 'gitnexus' || provider === 'graphify') && !stamped(provider)) return true;
  return false;
}

// The install task normally fires from the code-graph answer. On a machine where
// codeGraphProvider is already set (any project after the first), that step is
// skipped entirely, so the task must fire from the flow's terminal answer:
// 'finalize' for new projects, the last unresolved local-preference answer for
// existing ones. Idempotent — the runner stamps present bins and exits fast when
// everything is already installed, and a fresh-machine flow that already ran the
// task from code-graph is stamped by the time finalize lands here.
function attachPendingInstallTask(cwd: string, step: string, outcome: AnswerOutcome): AnswerOutcome {
  if (!outcome.ok || outcome.task) return outcome;
  const state = readEffectiveState(cwd);
  const host = detectHost();
  // Terminal = 'finalize' (new project; it just committed the stack) or, for an
  // already-onboarded project (stack present), the answer that resolved the last
  // local preference. Mid-wizard answers in a NEW project have no stack yet and
  // must never fire the install — it would block the wizard's next question on a
  // potentially minutes-long managed install.
  const hasStack = typeof state.stack === 'string' && state.stack.trim() !== '';
  const terminal = step === 'finalize' || (hasStack && nextLocalPreferenceStep(state, host) == null);
  if (!terminal || !toolchainInstallPending(state, host)) return outcome;
  return { ...outcome, task: { kind: 'onboarding-toolchain' } };
}

export function applyAnswer(cwd: string, step: string, value: unknown): AnswerOutcome {
  return attachPendingInstallTask(cwd, step, applyAnswerStep(cwd, step, value));
}

function applyAnswerStep(cwd: string, step: string, value: unknown): AnswerOutcome {
  switch (step) {
    case 'open-code': {
      const enabled = value === true || value === 'enable' || value === 'enabled';
      mergeProjectPrefs(cwd, { openCode: { enabled, source: 'prompted', decidedAt: stateTimestamp() } });
      // Record the consent as a DURABLE AUTHORIZATION in committed project state
      // (.traffic-one/.one.json), not just per-user prefs. Hosts with an
      // action-level safety reviewer (Codex) reject the opencode_delegate tool
      // call as "external delegation … not explicitly authorized" unless the
      // user's authorization is visible at call time — this field is that
      // machine-readable record, cited by the spawn gate's deny message so
      // delegation never re-asks the user for approval.
      patchSharedState(cwd, {
        openCodeDelegation: { approved: enabled, source: 'onboarding', decidedAt: stateTimestamp() },
      });
      return { ok: true };
    }
    case 'performance': {
      const level = String(value);
      if (level !== 'high' && level !== 'balanced' && level !== 'low') {
        return { ok: false, error: 'invalid performance level' };
      }
      mergeProjectPrefs(cwd, {
        performance: { level, source: 'prompted' },
        team: { mode: teamModeForLevel(level), source: 'prompted' },
      });
      return { ok: true };
    }
    case 'team-confirmation': {
      const v = obj(value);
      const action = (v && typeof v.action === 'string' ? v.action : String(value));
      // "Start the build" confirms the line-up shown for the chosen performance.
      // This is the SINGLE team confirmation — once set, the agent auto-runs the
      // team and never re-asks (see senior-engineer-team rules). "Re-pick
      // performance" clears performance + team to choose again.
      if (action === 'approve' || action === 'continue' || action === 'customise') {
        const overrides = v && obj(v.overrides);
        mergeProjectPrefs(cwd, {
          team: { mode: 'subagents', source: 'prompted', approved: true, ...(overrides ? { overrides } : {}) },
        });
        return { ok: true };
      }
      if (action === 'repick_performance' || action === 'repick') {
        clearPrefKeys(cwd, ['performance', 'team']);
        return { ok: true };
      }
      return { ok: false, error: 'invalid team-confirmation action' };
    }
    case 'code-graph': {
      const provider = String(value);
      if (provider !== 'gitnexus' && provider !== 'graphify') return { ok: false, error: 'invalid code-graph provider' };
      // The provider is machine-wide (one.json), not a per-project pref — once set
      // it is reused across projects. OpenCode was decided at the first step, so the
      // consolidated install task can read the final choices from the effective state.
      writeGlobalCodeGraphProvider(provider);
      return { ok: true, task: { kind: 'onboarding-toolchain' } };
    }
    case 'project-context': {
      const v = obj(value) || {};
      const answers = obj(v.answers) || {};
      const originalPrompt = projectContextOriginalPrompt(readState(cwd)) || String(v.originalPrompt || '').trim();
      const summary = String(v.summary || '').trim()
        || originalPrompt
        || String(answers.audience || '').trim()
        || 'MVP';
      patchSharedState(cwd, {
        mode: 'new-project',
        projectContext: { source: 'prompted', originalPrompt, summary, answers, collectedAt: stateTimestamp() },
      });
      return { ok: true };
    }
    case 'mobile': {
      const mobile = mobileFromChoice(value);
      if (!mobile) return { ok: false, error: 'invalid mobile choice' };
      patchSharedState(cwd, { mode: 'new-project', mobile: { ...mobile, source: 'prompted' } });
      return { ok: true };
    }
    case 'finalize': {
      const committed = readState(cwd);
      // Preserve an already-committed stack (a second user reopening the wizard
      // only needs their local prefs/toolchain seeded — don't re-derive and risk
      // overwriting the first user's choices). Derive only when stack is unset.
      const hasStack = typeof committed.stack === 'string' && committed.stack.trim() !== '';
      // Stack signal: the user's original prompt MERGED WITH the MVP answers they
      // typed — not a short-circuit on the first non-empty value. A present-but-thin
      // originalPrompt (e.g. a later "ok build it" that became the seed) classifies
      // to `minimal` on its own; folding in the answers recovers the real signal.
      // Concatenation is monotonic for classifyPromptForStack — extra keywords only
      // add signal, so a rich originalPrompt is never downgraded.
      const answers = obj((obj(committed.projectContext) || {}).answers) || {};
      const answerSignal = Object.values(answers).filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('. ');
      const promptSignal = [projectContextOriginalPrompt(committed), answerSignal]
        .filter((s) => s.trim() !== '')
        .join('. ');
      const mobile = obj(committed.mobile) || { enabled: false, framework: 'none' };
      // No-signal floor: reaching finalize on a new-project onboarding means a build
      // WAS intended, but the prompt can be LOST before it is ever seeded (observed on
      // Cursor 9b: the user-prompt-submit hook no-ops when the host payload carries no
      // prompt text, so seedOriginalPrompt never runs; the wizard form has no prompt
      // field, so promptSignal === ''). deriveStack('') collapses to `minimal/none/none`,
      // silently scaffolding the wrong (empty) stack. So when there is NO stack signal at
      // all, floor to the default build seed instead of minimal. An EXPLICIT minimal
      // request ("landing page", "static site") carries promptHasStackSignal===true, so it
      // classifies normally and is preserved — only a truly signal-less build is floored.
      const stackSeed = promptHasStackSignal(promptSignal) ? promptSignal : 'app with users and an admin dashboard';
      const derived = hasStack ? {} : deriveStack(stackSeed, String(mobile.framework || 'none'));
      const next = { ...committed, mode: 'new-project', ...derived };
      reconcileStackFromArtifacts(cwd, next);
      writeState(cwd, next);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown step: ${step}` };
  }
}
