"use strict";
// src/shared/onboarding-server/flow.ts
// The onboarding wizard's server-side brain: compute the next unresolved step and
// apply a single answer by writing the SAME state the agent used to write. Pure
// state IO (no HTTP, no child_process) so it is unit-testable in isolation. The
// step set + ordering is delegated to the existing predicates (nextOnboardingStep
// for new projects, nextLocalPreferenceStep for already-configured ones); this
// module only maps an answer → a writeState/mergeProjectPrefs call. The code-graph
// install is returned as a `task` signal for the HTTP layer to run out-of-band.
Object.defineProperty(exports, "__esModule", { value: true });
exports.effectiveOnboardingState = effectiveOnboardingState;
exports.computeOnboarding = computeOnboarding;
exports.applyAnswer = applyAnswer;
const detection_1 = require("../detection");
const obj_1 = require("../obj");
const predicates_1 = require("../onboarding/predicates");
const prompts_1 = require("../onboarding/prompts");
const local_prefs_1 = require("../onboarding/local-prefs");
const project_context_1 = require("../onboarding/project-context");
const performance_1 = require("../performance");
const io_1 = require("../state/io");
const state_1 = require("../state");
// ── Step copy (the questions now live in the wizard, not in agent prose) ─────────
const STEP_META = {
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
        fields: [...project_context_1.PROJECT_CONTEXT_ANSWER_KEYS],
    },
};
function metaForStep(step, originalPrompt) {
    if (step === null) {
        return { step: null, kind: 'done', title: 'All set', question: 'Traffic One setup is complete.' };
    }
    if (step === 'finalize') {
        return { step: 'finalize', kind: 'finalize', title: 'Finishing setup', question: 'Saving your configuration…' };
    }
    const base = STEP_META[step];
    const meta = { step, ...base };
    if (step === 'project-context')
        meta.domainQuestions = (0, project_context_1.projectContextDomainQuestionLines)(originalPrompt);
    return meta;
}
function effectiveOnboardingState(cwd) {
    const state = (0, state_1.readEffectiveState)(cwd);
    const mode = (typeof state.mode === 'string' && state.mode) || (0, detection_1.detectMode)(cwd);
    return { state: { ...state, mode }, mode };
}
function computeOnboarding(cwd) {
    const { state, mode } = effectiveOnboardingState(cwd);
    const originalPrompt = (0, project_context_1.projectContextOriginalPrompt)(state);
    let step;
    let done;
    if (mode === 'new-project') {
        if (!(0, predicates_1.isNewProjectOnboardingIncomplete)(state)) {
            step = null;
            done = true;
        }
        else {
            const raw = (0, prompts_1.nextOnboardingStep)(state);
            step = raw === 'state' ? 'finalize' : raw;
            done = false;
        }
    }
    else {
        const raw = (0, local_prefs_1.nextLocalPreferenceStep)(state);
        step = raw ?? null;
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
function patchSharedState(cwd, patch) {
    (0, state_1.writeState)(cwd, { ...(0, state_1.readState)(cwd), ...patch });
}
function clearPrefKeys(cwd, keys) {
    const prefs = (0, state_1.readProjectPrefs)(cwd);
    for (const key of keys)
        delete prefs[key];
    (0, state_1.writeProjectPrefs)(cwd, prefs);
}
function mobileFromChoice(value) {
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
function deriveStack(originalPrompt, mobileFramework) {
    const cls = (0, detection_1.classifyPromptForStack)(originalPrompt);
    let { stack, frontend, backend } = cls;
    if (mobileFramework === 'react-native-expo') {
        frontend = 'none';
        if (stack === 'minimal')
            stack = 'custom-frontend';
        if (backend === 'none')
            backend = 'supabase';
    }
    else if (mobileFramework === 'ionic-capacitor') {
        if (frontend === 'none')
            frontend = 'react-vite';
        if (stack === 'minimal')
            stack = 'default';
        if (backend === 'none')
            backend = 'supabase';
    }
    return { stack, frontend, backend };
}
function applyAnswer(cwd, step, value) {
    switch (step) {
        case 'open-code': {
            const enabled = value === true || value === 'enable' || value === 'enabled';
            (0, state_1.mergeProjectPrefs)(cwd, { openCode: { enabled, source: 'prompted', decidedAt: (0, io_1.stateTimestamp)() } });
            return { ok: true };
        }
        case 'performance': {
            const level = String(value);
            if (level !== 'high' && level !== 'balanced' && level !== 'low') {
                return { ok: false, error: 'invalid performance level' };
            }
            (0, state_1.mergeProjectPrefs)(cwd, {
                performance: { level, source: 'prompted' },
                team: { mode: (0, performance_1.teamModeForLevel)(level), source: 'prompted' },
            });
            return { ok: true };
        }
        case 'team-confirmation': {
            const v = (0, obj_1.obj)(value);
            const action = (v && typeof v.action === 'string' ? v.action : String(value));
            if (action === 'approve' || action === 'customise') {
                const overrides = v && (0, obj_1.obj)(v.overrides);
                (0, state_1.mergeProjectPrefs)(cwd, {
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
            if (provider !== 'gitnexus' && provider !== 'graphify')
                return { ok: false, error: 'invalid code-graph provider' };
            (0, state_1.mergeProjectPrefs)(cwd, { codeGraphProvider: provider });
            return { ok: true, task: { kind: 'code-graph', provider } };
        }
        case 'project-context': {
            const v = (0, obj_1.obj)(value) || {};
            const answers = (0, obj_1.obj)(v.answers) || {};
            const originalPrompt = (0, project_context_1.projectContextOriginalPrompt)((0, state_1.readState)(cwd)) || String(v.originalPrompt || '').trim();
            const summary = String(v.summary || '').trim()
                || originalPrompt
                || String(answers.audience || '').trim()
                || 'MVP';
            patchSharedState(cwd, {
                mode: 'new-project',
                projectContext: { source: 'prompted', originalPrompt, summary, answers, collectedAt: (0, io_1.stateTimestamp)() },
            });
            return { ok: true };
        }
        case 'mobile': {
            const mobile = mobileFromChoice(value);
            if (!mobile)
                return { ok: false, error: 'invalid mobile choice' };
            patchSharedState(cwd, { mode: 'new-project', mobile: { ...mobile, source: 'prompted' } });
            return { ok: true };
        }
        case 'finalize': {
            const committed = (0, state_1.readState)(cwd);
            // Preserve an already-committed stack (a second user reopening the wizard
            // only needs their local prefs/toolchain seeded — don't re-derive and risk
            // overwriting the first user's choices). Derive only when stack is unset.
            const hasStack = typeof committed.stack === 'string' && committed.stack.trim() !== '';
            // Stack signal: the user's original prompt, falling back to the MVP answers
            // they typed — so the derived stack reflects the actual project even if the
            // prompt wasn't captured.
            const answers = (0, obj_1.obj)(((0, obj_1.obj)(committed.projectContext) || {}).answers) || {};
            const promptSignal = (0, project_context_1.projectContextOriginalPrompt)(committed)
                || Object.values(answers).filter((v) => typeof v === 'string' && v.trim() !== '').join('. ');
            const mobile = (0, obj_1.obj)(committed.mobile) || { enabled: false, framework: 'none' };
            const derived = hasStack ? {} : deriveStack(promptSignal, String(mobile.framework || 'none'));
            (0, state_1.writeState)(cwd, { ...committed, mode: 'new-project', ...derived });
            return { ok: true };
        }
        default:
            return { ok: false, error: `unknown step: ${step}` };
    }
}
