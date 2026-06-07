// src/shared/onboarding-server/flow.ts
// The onboarding wizard's server-side brain: compute the next unresolved step and
// apply a single answer by writing the SAME state the agent used to write. Pure
// state IO (no HTTP, no child_process) so it is unit-testable in isolation. The
// step set + ordering is delegated to the existing predicates (nextOnboardingStep
// for new projects, nextLocalPreferenceStep for already-configured ones); this
// module only maps an answer → a writeState/mergeProjectPrefs call. The code-graph
// install is returned as a `task` signal for the HTTP layer to run out-of-band.

import { classifyPromptForStack, detectMode } from '../detection';
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
import { recommendTierForPlan } from '../model-tiers';
import { effectiveTierForRole, modelForRoleHost, openCodeDelegationActive, teamModeForLevel, type PlanCtx } from '../performance';
import { recommendLevelForPlan } from '../performance-config';
import { stateTimestamp } from '../state/io';
import {
  mergeProjectPrefs,
  readEffectiveState,
  readProjectPrefs,
  readState,
  writeGlobalCodeGraphProvider,
  writeProjectPrefs,
  writeState,
} from '../state';

// The action the wizard should take next: a question id, 'finalize' (new-project,
// all questions answered, commit the canonical state), or null (fully onboarded).
export type WizardStep =
  | 'open-code'
  | 'performance'
  | 'team-confirmation'
  | 'code-graph'
  | 'project-context'
  | 'mobile'
  | 'finalize'
  | null;

export interface StepOption {
  id: string;
  label: string;
  hint?: string;
}

export interface FormField {
  key: string;
  label: string;
  hint?: string;
}

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

export interface StepMeta {
  step: WizardStep;
  kind: 'single_select' | 'form' | 'finalize' | 'done';
  title: string;
  question: string;
  options?: StepOption[];
  fields?: FormField[];
  domainQuestions?: string[];
  team?: TeamMember[];
  performanceLevel?: string;
  recommendedLevel?: string;
  recommendedTier?: string;
  host?: string;
}

// The senior-engineer roster, in the order it should read on screen. Labels +
// one-line blurbs come from the agent definitions (src/modules/senior-*/agent.md);
// the per-role tier/model is resolved from PERFORMANCE_CONFIG at display time.
const TEAM_ROLES: { role: string; label: string; blurb: string }[] = [
  { role: 'senior-architect', label: 'Architect', blurb: 'Plans the build, public contracts & module map' },
  { role: 'senior-frontend', label: 'Frontend', blurb: 'UI — pages, components, design system, accessibility' },
  { role: 'senior-backend', label: 'Backend', blurb: 'APIs, data, auth, migrations, background jobs' },
  { role: 'senior-reviewer', label: 'Reviewer', blurb: 'Read-only audit before every commit' },
  { role: 'senior-tester', label: 'Tester', blurb: 'Unit, integration & end-to-end tests' },
  { role: 'senior-shipper', label: 'Shipper', blurb: 'Deploy & release — only when you ask' },
];

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

// Human-friendly label + placeholder for each PROJECT_CONTEXT_ANSWER_KEY, so the
// wizard form reads like questions instead of camelCase identifiers.
const PROJECT_CONTEXT_FIELDS: FormField[] = [
  { key: 'audience', label: 'Who is it for?', hint: 'Primary users / audience' },
  { key: 'coreFlows', label: 'Core user flows', hint: 'The main things a user does, end to end' },
  { key: 'v1Features', label: 'V1 features', hint: 'What must ship in the first version' },
  { key: 'rolesAuth', label: 'Roles & sign-in', hint: 'User roles and how they authenticate' },
  { key: 'businessModel', label: 'Business model', hint: 'How it makes money — or free / internal' },
  { key: 'payments', label: 'Payments', hint: 'Billing, subscriptions, or checkout?' },
  { key: 'admin', label: 'Admin area', hint: 'What an admin needs to manage' },
  { key: 'dataModel', label: 'Data model', hint: 'Key entities and how they relate' },
  { key: 'contentSource', label: 'Content source', hint: 'Where the data / content comes from' },
  { key: 'integrations', label: 'Integrations', hint: 'Third-party services or APIs to connect' },
  { key: 'engagement', label: 'Engagement', hint: 'Notifications, email, retention' },
  { key: 'successMetrics', label: 'Success metrics', hint: 'How you will measure success' },
  { key: 'constraints', label: 'Constraints', hint: 'Deadlines, budget, tech, compliance' },
  { key: 'domainSpecific', label: 'Anything domain-specific', hint: 'Unique rules or details for this domain' },
];

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
  // The code-graph answer is the last question in BOTH the new-project and the
  // existing-project flows. Answering it kicks the consolidated install task
  // (graph provider + OpenCode) so the wizard can gate "Setup complete" on it.
  task?: { kind: 'onboarding-toolchain' };
}

// ── Step copy (the questions now live in the wizard, not in agent prose) ─────────
const STEP_META: Record<Exclude<WizardStep, null | 'finalize'>, Omit<StepMeta, 'step' | 'domainQuestions'>> = {
  'open-code': {
    kind: 'single_select',
    title: 'OpenCode',
    question: 'Save tokens by delegating coding tasks to OpenCode (a free local agent)?',
    options: [
      { id: 'enable', label: 'Enable OpenCode delegation' },
      { id: 'not_now', label: 'Not now' },
    ],
  },
  performance: {
    kind: 'single_select',
    title: 'Performance',
    question: 'How do you want to run agents for this build?',
    options: [
      { id: 'high', label: 'High', hint: 'A multi-agent senior team' },
      { id: 'balanced', label: 'Balanced', hint: 'Multi-agent team on cheaper tiers' },
      { id: 'low', label: 'Low', hint: 'Single main agent' },
    ],
  },
  'team-confirmation': {
    kind: 'single_select',
    title: 'Your team',
    question: 'Set by your performance choice — this is the senior team that will build. Start when you are ready, or re-pick performance to change it.',
    options: [
      { id: 'approve', label: 'Start the build' },
      { id: 'repick_performance', label: 'Re-pick performance' },
    ],
  },
  'code-graph': {
    kind: 'single_select',
    title: 'Code Graph',
    question: 'Which provider should we use for the codebase graph?',
    options: [
      { id: 'gitnexus', label: 'GitNexus', hint: 'Node CLI' },
      { id: 'graphify', label: 'graphify', hint: 'Python CLI' },
    ],
  },
  mobile: {
    kind: 'single_select',
    title: 'Mobile App',
    question: 'Do you want a mobile app too?',
    options: [
      { id: 'web_only', label: 'Web only', hint: 'Recommended' },
      { id: 'ionic_capacitor', label: 'Ionic + Capacitor' },
      { id: 'react_native_expo', label: 'React Native / Expo' },
    ],
  },
  'project-context': {
    kind: 'form',
    title: 'About the project',
    question: 'Tell me a bit about what you are building. Everything here is optional — fill what is relevant and I will infer the rest from your request.',
    fields: PROJECT_CONTEXT_FIELDS,
  },
};

function metaForStep(step: WizardStep, originalPrompt: string): StepMeta {
  if (step === null) {
    return { step: null, kind: 'done', title: 'All set', question: 'Traffic One setup is complete.' };
  }
  if (step === 'finalize') {
    return { step: 'finalize', kind: 'finalize', title: 'Finishing setup', question: 'Saving your configuration…' };
  }
  const base = STEP_META[step];
  const meta: StepMeta = { step, ...base };
  if (step === 'project-context') meta.domainQuestions = projectContextDomainQuestionLines(originalPrompt);
  return meta;
}

export function effectiveOnboardingState(cwd: string): { state: Rec; mode: string } {
  const state = readEffectiveState(cwd);
  const mode = (typeof state.mode === 'string' && state.mode) || detectMode(cwd);
  return { state: { ...state, mode }, mode };
}

export function computeOnboarding(cwd: string): OnboardingView {
  const { state, mode } = effectiveOnboardingState(cwd);
  const originalPrompt = projectContextOriginalPrompt(state);
  let step: WizardStep;
  let done: boolean;

  if (mode === 'new-project') {
    if (!isNewProjectOnboardingIncomplete(state)) {
      step = null;
      done = true;
    } else {
      const raw = nextOnboardingStep(state);
      step = raw === 'state' ? 'finalize' : (raw as WizardStep);
      done = false;
    }
  } else {
    const raw = nextLocalPreferenceStep(state);
    step = (raw as WizardStep) ?? null;
    done = raw == null;
  }

  const meta = metaForStep(step, originalPrompt);
  if (step === 'team-confirmation') enrichTeamMeta(meta, state);
  if (step === 'performance') enrichPerformanceMeta(meta, state);

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
  const planCtx: PlanCtx = { host, plan: detectHostPlan(host), useOpenCode: openCodeDelegationActive(state) };
  meta.team = buildTeamLineup(level, host, overrides, planCtx);
  meta.performanceLevel = level;
  meta.recommendedTier = recommendTierForPlan(host, planCtx.plan, planCtx.useOpenCode);
  meta.host = host;
}

// Pre-select the wizard's recommended performance level from the detected plan +
// the OpenCode opt-in: move it first and tag its hint "Recommended". Clones the
// option objects so the shared STEP_META copy is never mutated.
function enrichPerformanceMeta(meta: StepMeta, state: Rec): void {
  const host = detectHost();
  const plan = detectHostPlan(host);
  const useOpenCode = openCodeDelegationActive(state);
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

export function applyAnswer(cwd: string, step: string, value: unknown): AnswerOutcome {
  switch (step) {
    case 'open-code': {
      const enabled = value === true || value === 'enable' || value === 'enabled';
      mergeProjectPrefs(cwd, { openCode: { enabled, source: 'prompted', decidedAt: stateTimestamp() } });
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
      // Stack signal: the user's original prompt, falling back to the MVP answers
      // they typed — so the derived stack reflects the actual project even if the
      // prompt wasn't captured.
      const answers = obj((obj(committed.projectContext) || {}).answers) || {};
      const promptSignal = projectContextOriginalPrompt(committed)
        || Object.values(answers).filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('. ');
      const mobile = obj(committed.mobile) || { enabled: false, framework: 'none' };
      const derived = hasStack ? {} : deriveStack(promptSignal, String(mobile.framework || 'none'));
      writeState(cwd, { ...committed, mode: 'new-project', ...derived });
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown step: ${step}` };
  }
}
