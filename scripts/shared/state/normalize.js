"use strict";
// src/shared/state/normalize.ts
// .one.json read/write + partial-state normalization, toolchain seeding, default
// technologies, legacy-stack migration, Supabase add-on gate. Ported 1:1 from
// scripts/hook-runtime/state/normalize.cjs (dead helper setIfMissingOrDifferent
// dropped). Uses shared fsjson; state timestamps keep the legacy ms-stripped form.
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
exports.defaultTechnologiesFor = defaultTechnologiesFor;
exports.statePath = statePath;
exports.legacyStatePath = legacyStatePath;
exports.readState = readState;
exports.writeState = writeState;
exports.normalizeState = normalizeState;
exports.requireAddon = requireAddon;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("../config");
const fsjson_1 = require("../fsjson");
const canonicalize_1 = require("./canonicalize");
const constants_1 = require("./constants");
const io_1 = require("./io");
const local_prefs_1 = require("./local-prefs");
const toolchain_1 = require("./toolchain");
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function defaultMobileState() {
    return { enabled: false, framework: 'none', source: 'none' };
}
function defaultTechnologiesFor(state) {
    const frontend = [];
    const backend = [];
    const mobile = [];
    const frontendValue = (typeof state.frontend === 'string' && state.frontend) || 'none';
    const backendValue = (typeof state.backend === 'string' && state.backend) || 'none';
    const mobileObj = obj(state.mobile);
    const mobileValue = mobileObj ? mobileObj.framework : undefined;
    if (frontendValue === 'react-vite')
        frontend.push('react', 'vite');
    else if (frontendValue && frontendValue !== 'none')
        frontend.push(frontendValue);
    if (backendValue === 'supabase' || backendValue === 'our-fork')
        backend.push('supabase', 'postgres');
    else if (backendValue === 'firebase')
        backend.push('firebase');
    else if (backendValue === 'mongo')
        backend.push('mongo');
    else if (backendValue && backendValue !== 'none' && backendValue !== 'external-api')
        backend.push(backendValue);
    if (mobileValue === 'ionic-capacitor')
        mobile.push('ionic', 'capacitor');
    if (mobileValue === 'react-native-expo')
        mobile.push('react-native', 'expo');
    return { frontend, backend, mobile };
}
function normalizeLegacyStack(state) {
    if (!state.stack)
        return false;
    const original = state.stack;
    if (typeof original !== 'string')
        return false;
    const mapped = config_1.LEGACY_STACK_ALIASES[original];
    if (!mapped)
        return false;
    state.stack = mapped;
    if (!state.legacyStack)
        state.legacyStack = original;
    if (original === 'react-realtime-monorepo') {
        state.frontend = state.frontend || 'react-vite';
        state.backend = state.backend || 'supabase';
    }
    else if (original === 'react-frontend-only') {
        state.frontend = state.frontend || 'react-vite';
        state.backend = state.backend || 'none';
    }
    else if (original === 'react-native-expo-monorepo' || original === 'react-native-expo-app') {
        state.frontend = state.frontend || 'none';
        state.backend = state.backend || 'supabase';
        const existingMobile = obj(state.mobile) || {};
        state.mobile = {
            ...existingMobile,
            enabled: true,
            framework: 'react-native-expo',
            source: existingMobile.source || 'explicit',
        };
    }
    else if (original === 'node-backend') {
        state.frontend = state.frontend || 'none';
        state.backend = state.backend || 'node';
    }
    else if (original === 'framework-web') {
        state.frontend = state.frontend || 'other';
        state.backend = state.backend || 'other';
    }
    return true;
}
function statePath(cwd) {
    return path.join(cwd, config_1.STATE_FILE);
}
function legacyStatePath(cwd) {
    return path.join(cwd, config_1.LEGACY_STATE_FILE);
}
function readState(cwd) {
    const currentPath = statePath(cwd);
    if (fs.existsSync(currentPath))
        return (0, local_prefs_1.stripLocalPreferenceFields)((0, fsjson_1.readJson)(currentPath, {}));
    const oldPath = legacyStatePath(cwd);
    if (fs.existsSync(oldPath)) {
        const legacy = (0, fsjson_1.readJson)(oldPath, {});
        if (legacy && typeof legacy === 'object')
            legacy.legacyStateFile = config_1.LEGACY_STATE_FILE;
        return (0, local_prefs_1.stripLocalPreferenceFields)(legacy);
    }
    const legacyPath = path.join(cwd, config_1.LEGACY_LOCK_FILE);
    const legacy = (0, fsjson_1.readText)(legacyPath);
    if (legacy !== null) {
        return { version: (0, io_1.stateVersion)(), mode: legacy.trim(), stack: null, confirmed: false };
    }
    return {};
}
function writeState(cwd, state) {
    let source = obj(state) ? { ...state } : {};
    delete source.pluginVersion;
    if (source.stack) {
        (0, canonicalize_1.canonicalizeStateShape)(source);
        if (typeof source.stack === 'string') {
            normalizeState(source, (typeof source.mode === 'string' && source.mode) || 'new-project');
        }
    }
    const split = (0, local_prefs_1.splitLocalPreferences)(cwd, source);
    source = split.state;
    (0, fsjson_1.writeJson)(statePath(cwd), { ...source, version: (0, io_1.stateVersion)() });
}
function normalizeState(state, defaultMode) {
    const s = obj(state);
    if (!s)
        return false;
    let changed = (0, canonicalize_1.canonicalizeStateShape)(s);
    if (!s.stack)
        return changed;
    changed = normalizeLegacyStack(s) || changed;
    if (typeof s.stack !== 'string' || !config_1.STACK_IDS.has(s.stack))
        return changed;
    if (!s.mode && defaultMode) {
        s.mode = defaultMode;
        changed = true;
    }
    if (s.confirmed !== true) {
        s.confirmed = true;
        changed = true;
    }
    if (s.onboardingComplete !== true) {
        s.onboardingComplete = true;
        changed = true;
    }
    if (!s.confirmedAt) {
        s.confirmedAt = (0, io_1.stateTimestamp)();
        changed = true;
    }
    if (!s.realtime) {
        s.realtime = 'none';
        changed = true;
    }
    if (!s.frontend) {
        s.frontend = s.stack === 'default' || s.stack === 'custom-backend' ? 'react-vite' : 'none';
        changed = true;
    }
    if (!s.backend) {
        s.backend = s.stack === 'minimal' ? 'none' : 'supabase';
        changed = true;
    }
    const mobile = obj(s.mobile);
    if (!mobile) {
        s.mobile = defaultMobileState();
        changed = true;
    }
    else {
        const frameworkAlias = (0, canonicalize_1.mobileStateFromString)(mobile.framework);
        const normalizedMobile = { ...defaultMobileState(), ...mobile };
        if (frameworkAlias) {
            normalizedMobile.enabled = frameworkAlias.enabled;
            normalizedMobile.framework = frameworkAlias.framework;
            if (!mobile.source)
                normalizedMobile.source = frameworkAlias.source;
        }
        normalizedMobile.source = (0, canonicalize_1.canonicalMobileSource)(normalizedMobile.source);
        if (mobile.enabled !== normalizedMobile.enabled
            || mobile.framework !== normalizedMobile.framework
            || mobile.source !== normalizedMobile.source) {
            s.mobile = normalizedMobile;
            changed = true;
        }
    }
    const technologies = obj(s.technologies);
    if (!technologies) {
        s.technologies = defaultTechnologiesFor(s);
        changed = true;
    }
    else {
        const defaults = defaultTechnologiesFor(s);
        for (const key of ['frontend', 'backend', 'mobile']) {
            if (!Array.isArray(technologies[key])) {
                technologies[key] = defaults[key];
                changed = true;
            }
        }
    }
    const team = obj(s.team);
    if (team) {
        const normalizedTeam = {
            ...team,
            mode: (0, canonicalize_1.canonicalTeamMode)(team.mode),
            source: (0, canonicalize_1.canonicalTeamSource)(team.source || 'prompted'),
        };
        const perf = obj(s.performance);
        const performanceLevel = perf ? (0, canonicalize_1.canonicalPerformanceLevel)(perf.level) : null;
        const normalizedOverrides = (0, canonicalize_1.canonicalTeamOverrides)(team.overrides, performanceLevel);
        if (normalizedOverrides)
            normalizedTeam.overrides = normalizedOverrides;
        else if ('overrides' in normalizedTeam)
            delete normalizedTeam.overrides;
        const mca = normalizedTeam.modeChangeApproval;
        if (normalizedTeam.mode !== 'subagents' && 'modeChangeApproval' in normalizedTeam) {
            delete normalizedTeam.modeChangeApproval;
        }
        else if ('modeChangeApproval' in normalizedTeam && (!mca || typeof mca !== 'object')) {
            delete normalizedTeam.modeChangeApproval;
        }
        if (team.approved === true)
            normalizedTeam.approved = true;
        else if ('approved' in normalizedTeam)
            delete normalizedTeam.approved;
        if (team.mode !== normalizedTeam.mode
            || team.source !== normalizedTeam.source
            || !(0, canonicalize_1.overridesEqual)(team.overrides, normalizedTeam.overrides)
            || team.modeChangeApproval !== normalizedTeam.modeChangeApproval
            || team.approved !== normalizedTeam.approved) {
            s.team = normalizedTeam;
            changed = true;
        }
    }
    const performance = obj(s.performance);
    if (performance) {
        const normalizedPerformance = {
            ...performance,
            level: (0, canonicalize_1.canonicalPerformanceLevel)(performance.level),
            source: typeof performance.source === 'string' ? performance.source : 'prompted',
        };
        if (performance.level !== normalizedPerformance.level || performance.source !== normalizedPerformance.source) {
            s.performance = normalizedPerformance;
            changed = true;
        }
    }
    const openCode = obj(s.openCode);
    if (openCode) {
        const normalizedOpenCode = {
            ...openCode,
            enabled: openCode.enabled === true,
            source: (0, canonicalize_1.canonicalOpenCodeSource)(openCode.source),
        };
        if (typeof normalizedOpenCode.decidedAt !== 'string' || !normalizedOpenCode.decidedAt.trim()) {
            normalizedOpenCode.decidedAt = (0, io_1.stateTimestamp)();
        }
        if (openCode.enabled !== normalizedOpenCode.enabled
            || openCode.source !== normalizedOpenCode.source
            || openCode.decidedAt !== normalizedOpenCode.decidedAt) {
            s.openCode = normalizedOpenCode;
            changed = true;
        }
    }
    const nextToolchain = (0, toolchain_1.initializeToolchainState)(s.toolchain);
    if (JSON.stringify(s.toolchain || {}) !== JSON.stringify(nextToolchain)) {
        s.toolchain = nextToolchain;
        changed = true;
    }
    if (s.backend === 'supabase' || s.backend === 'our-fork') {
        if (s.supabaseFunctionsAutoDeploy === undefined) {
            s.supabaseFunctionsAutoDeploy = 'ask';
            changed = true;
        }
        if (!obj(s.supabaseAddons)) {
            s.supabaseAddons = {};
            changed = true;
        }
    }
    return changed;
}
function requireAddon(state, name) {
    if (!constants_1.KNOWN_ADDONS.has(name)) {
        return { approved: false, skipped: false, status: 'pending', known: false };
    }
    const s = obj(state);
    const addons = (s && obj(s.supabaseAddons)) || {};
    const status = typeof addons[name] === 'string' ? addons[name] : 'pending';
    return { approved: status === 'approved', skipped: status === 'skipped', status, known: true };
}
