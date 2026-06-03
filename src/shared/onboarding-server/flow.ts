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
  PROJECT_CONTEXT_ANSWER_KEYS,
  projectContextDomainQuestionLines,
  projectContextOriginalPrompt,
} from '../onboarding/project-context';
import { teamModeForLevel } from '../performance';
import { stateTimestamp } from '../state/io';
import {
  mergeProjectPrefs,
  readEffectiveState,
  readProjectPrefs,
  readState,
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

export interface StepMeta {
  step: WizardStep;
  kind: 'single_select' | 'form' | 'finalize' | 'done';
  title: string;
  question: string;
  options?: StepOption[];
  fields?: string[];
  domainQuestions?: string[];
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
  task?: { kind: 'code-graph'; provider: 'gitnexus' | 'graphify' };
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
      { id: 'high', label: 'High', hint: 'Recommended — a multi-agent senior team' },
      { id: 'balanced', label: 'Balanced', hint: 'Multi-agent team on cheaper tiers' },
      { id: 'low', label: 'Low', hint: 'Single main agent' },
    ],
  },
  'team-confirmation': {
    kind: 'single_select',
    title: 'Team',
    question: 'Approve the subagent team line-up for this build?',
    options: [
      { id: 'approve', label: 'Approve' },
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
    title: 'Project Context',
    question: 'Answer these MVP-context questions so the build plan is complete.',
    fields: [...PROJECT_CONTEXT_ANSWER_KEYS],
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

  return {
    mode,
    stack: typeof state.stack === 'string' ? state.stack : null,
    step,
    done,
    originalPrompt,
    meta: metaForStep(step, originalPrompt),
  };
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
      if (action === 'approve' || action === 'customise') {
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
      mergeProjectPrefs(cwd, { codeGraphProvider: provider });
      return { ok: true, task: { kind: 'code-graph', provider } };
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
