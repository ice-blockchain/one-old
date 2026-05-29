"use strict";
// src/modules/session/session-start.ts
// SessionStart handler: auth gate (fail-closed) → multi-project skill sweep +
// digest retention + session materialization → subagent fast path (fix-cycle /
// role-scoped index) → mode routing (onboarded bundle / existing-codebase
// auto-detect / new-project onboarding directive). Ported 1:1 from
// runSessionStart (session-start.cjs). The one-mcp reporter is a Step-5 runner —
// no-op'd here (TODO: wire at Step 5).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSessionStartAuthed = runSessionStartAuthed;
exports.runSessionStart = runSessionStart;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const authoring_root_1 = require("../../shared/authoring-root");
const config_1 = require("../../shared/config");
const detection_1 = require("../../shared/detection");
const materialize_1 = require("../../shared/materialize");
const directives_1 = require("../../shared/directives");
const session_directive_1 = require("../../shared/onboarding/session-directive");
const predicates_1 = require("../../shared/onboarding/predicates");
const local_prefs_1 = require("../../shared/onboarding/local-prefs");
const fallbacks_1 = require("../../shared/onboarding/fallbacks");
const packing_1 = require("../../shared/packing");
const paths_1 = require("../../shared/paths");
const skill_filters_1 = require("../../shared/skill-filters");
const skill_block_1 = require("../../shared/skill-block");
const stacks_1 = require("../../shared/stacks");
const state_1 = require("../../shared/state");
const toolchain_1 = require("../../shared/state/toolchain");
const text_1 = require("../../shared/text");
const auth_choice_1 = require("./auth-choice");
const auth_gate_1 = require("./auth-gate");
const session_start_lib_1 = require("./session-start-lib");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const STACK_IDS = new Set(Object.keys(stacks_1.STACKS));
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function runSessionStartInner(ctx) {
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    const authGate = (0, auth_gate_1.authGateForHook)({ forceRemote: true });
    if (!authGate.authenticated) {
        if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
            return (0, result_1.noop)();
        const writeResult = (0, auth_choice_1.tryWriteAuthChoice)('pending-choice', cwd);
        return (0, auth_gate_1.authRequiredHookResult)('SessionStart', { authChoiceWrite: writeResult });
    }
    return runSessionStartAuthed(ctx);
}
// The post-auth SessionStart body: skill sweep + digest retention + session
// materialization → subagent fast path → mode-routed rule bundle / directive.
// Exported so it can be tested without the forced remote auth probe.
function runSessionStartAuthed(ctx) {
    const cwd = ctx.cwd;
    const root = (0, paths_1.pluginRoot)();
    const raw = ctx.input.raw;
    const state = (0, state_1.readEffectiveState)(cwd);
    // Multi-project safety: reset to the 3-skill baseline before copying THIS
    // project's set. Digest retention sweep. Best-effort session materialization.
    (0, skill_filters_1.cleanActiveSkills)();
    (0, session_start_lib_1.sweepOldDigests)(cwd, 5);
    try {
        (0, session_start_lib_1.ensureSessionMaterialization)(cwd, state);
    }
    catch {
        // best-effort; the full branches below still provide rule context
    }
    // ── Subagent fast path ──
    const agentContext = (0, state_1.resolveRunAgentContext)(cwd, state, raw, { claimPending: true })
        || (!(0, state_1.hasRunAgentState)(cwd, state) ? (0, state_1.legacyRunAgentContext)(state) : null);
    if (agentContext && (0, materialize_1.hasMaterializedProjectAssets)(cwd, state)) {
        const role = typeof agentContext.role === 'string' ? agentContext.role : '';
        const runId = String(agentContext.runId ?? '');
        const spawnIndex = agentContext.spawnIndex || 0;
        if (role && spawnIndex > 1) {
            // Fix-cycle: same role re-spawned in the same run → tiny pointer header.
            const { body } = (0, packing_1.packFixCycleHeader)(cwd, role, runId, spawnIndex);
            return (0, result_1.context)(body);
        }
        const ruleSet = role ? (0, stacks_1.roleScopedRules)(role, state) : null;
        const rules = ruleSet || (0, stacks_1.stackSpecForState)(state).mandatory;
        (0, skill_filters_1.copyActiveSkills)(state);
        const skillDirective = (0, skill_filters_1.pruneSkillsDirective)(state, (0, skill_filters_1.listAllSkills)());
        const { body } = (0, packing_1.packRuleIndex)(root, rules);
        const graphPreview = (0, session_start_lib_1.readGraphPreview)(cwd);
        const roleLabel = role || 'subagent';
        const header = `═══ traffic-one — ${roleLabel} (run ${runId}) ═══\n`
            + '[subagent] Full rules already loaded by parent session and materialized to '
            + '.traffic-one/rules/. This index lists role-scoped rules; Read them on demand.\n';
        return (0, result_1.context)(`${header}${skillDirective}${graphPreview}\n${body}`);
    }
    const mode = state.mode || (0, detection_1.detectMode)(cwd);
    state.mode = mode;
    let stackId = state.stack;
    if (stackId && (0, config_1.isKnownStack)(stackId)) {
        (0, state_1.normalizeState)(state, mode);
        stackId = state.stack;
    }
    const onboardingComplete = Boolean(state.onboardingComplete);
    const onboardingReady = onboardingComplete
        && typeof stackId === 'string' && STACK_IDS.has(stackId)
        && (mode !== 'new-project' || !(0, predicates_1.isNewProjectOnboardingIncomplete)(state));
    // ── Flow 1 — already onboarded → pack the rule bundle ──
    if (onboardingReady) {
        const activeStackId = String(stackId);
        const localPrefs = (0, local_prefs_1.localPreferenceContext)(state, activeStackId, 'session-start', block);
        if (localPrefs) {
            return (0, result_1.context)(localPrefs.context, {
                systemMessage: `traffic-one [${activeStackId}] local preferences required`,
                ...(localPrefs.promptRequest ? { promptRequest: localPrefs.promptRequest } : {}),
            });
        }
        const spec = (0, stacks_1.stackSpecForState)(state);
        const modeRulePath = `rules/modes/${mode}.md`;
        const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
        const { body } = (0, packing_1.packBundle)(root, modeMandatory, spec.optional);
        const copied = (0, skill_filters_1.copyActiveSkills)(state);
        const skillDirective = (0, skill_filters_1.pruneSkillsDirective)(state, (0, skill_filters_1.listAllSkills)());
        stampMaterialization(cwd, state);
        let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
        if (copied > 0)
            header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
        header += (0, session_start_lib_1.tokenEconomyBanner)(cwd);
        if (skillDirective)
            header += skillDirective;
        const graphPreview = (0, session_start_lib_1.readGraphPreview)(cwd);
        (0, state_1.writeState)(cwd, state);
        return (0, result_1.context)(`${header}${graphPreview}\n${body}`);
    }
    // ── Flow 2 — existing project with detectable stack → auto-write + prune ──
    if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
        const detected = (0, detection_1.detectStackFromCodebase)(cwd);
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
            confirmedAt: (0, text_1.nowIsoNoMs)(),
            autoDetected: true,
            evidence: detected.evidence,
        });
        (0, state_1.normalizeState)(state, mode);
        const spec = (0, stacks_1.stackSpecForState)(state);
        const modeRulePath = `rules/modes/${mode}.md`;
        const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
        const { body } = (0, packing_1.packBundle)(root, modeMandatory, spec.optional);
        const copied = (0, skill_filters_1.copyActiveSkills)(state);
        const allSkills = (0, skill_filters_1.listAllSkills)();
        stampMaterialization(cwd, state);
        (0, state_1.writeState)(cwd, state);
        const skillDirective = (0, skill_filters_1.pruneSkillsDirective)(state, allSkills);
        const banner = (0, directives_1.autoDetectedAnnouncement)(detected);
        let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
        if (copied > 0)
            header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
        header += (0, session_start_lib_1.tokenEconomyBanner)(cwd);
        if (skillDirective)
            header += skillDirective;
        const graphPreview = (0, session_start_lib_1.readGraphPreview)(cwd);
        const localPrefs = (0, local_prefs_1.localPreferenceContext)(state, String(state.stack || mode), 'session-start', block);
        if (localPrefs) {
            return (0, result_1.context)(`${banner}\n\n${localPrefs.context}`, {
                systemMessage: `traffic-one [${state.stack || mode}] local preferences required`,
                ...(localPrefs.promptRequest ? { promptRequest: localPrefs.promptRequest } : {}),
            });
        }
        return (0, result_1.context)(`${banner}\n\n${header}${graphPreview}\n${body}`);
    }
    if (mode === 'new-project' && stackId && (0, predicates_1.isNewProjectOnboardingIncomplete)(state)) {
        const localPrefs = (0, local_prefs_1.localPreferenceContext)(state, stackId, 'session-start', block);
        const nextPrompt = localPrefs?.context || [
            `[ACTIVE STACK: ${stackId}]`,
            '',
            (0, fallbacks_1.nextOnboardingStepPrompt)(state, 'user-prompt', block),
        ].join('\n');
        const promptRequest = localPrefs?.promptRequest || (0, fallbacks_1.nextOnboardingPromptRequest)(state, 'user-prompt', block);
        return (0, result_1.context)(nextPrompt, {
            systemMessage: 'traffic-one [onboarding incomplete]',
            ...(promptRequest ? { promptRequest } : {}),
        });
    }
    // ── Flow 3 — new project (or undetectable existing) → onboarding directive ──
    const directive = (0, session_directive_1.onboardingDirectiveNewProject)(block);
    const spec = stacks_1.STACKS.minimal;
    const { body } = (0, packing_1.packBundle)(root, spec.mandatory, spec.optional);
    if (!obj(state.toolchain))
        state.toolchain = (0, toolchain_1.initializeToolchainState)();
    (0, state_1.writeState)(cwd, state);
    return (0, result_1.context)(`${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`);
}
// Stamp materialization fields after a successful copy (best-effort).
function stampMaterialization(cwd, state) {
    try {
        const materialized = (0, materialize_1.materializeProjectAssets)(cwd, state);
        if (!materialized.skipped) {
            state.materializedStack = (0, state_1.stackFingerprint)(state);
            state.materializedAt = (0, text_1.nowIsoNoMs)();
            state.materializedVersion = (0, state_1.stateVersion)();
        }
    }
    catch {
        // best-effort; the in-memory bundle is still provided
    }
}
// Fail-closed: a throw anywhere in SessionStart must never crash the hook. The
// auth instruction / noop still surfaces; core/errors guarantees exit-0.
function runSessionStart(ctx) {
    try {
        return runSessionStartInner(ctx);
    }
    catch {
        return (0, result_1.noop)();
    }
}
