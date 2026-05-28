"use strict";
// src/shared/state/local-prefs.ts
// Per-user, per-project runtime preferences (kept out of the repo-shared
// .one.json). Ported 1:1 from scripts/hook-runtime/state/local-prefs.cjs.
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
exports.LOCAL_PREF_KEYS = void 0;
exports.projectRootHash = projectRootHash;
exports.projectPrefsPath = projectPrefsPath;
exports.normalizeProjectPrefs = normalizeProjectPrefs;
exports.readProjectPrefs = readProjectPrefs;
exports.writeProjectPrefs = writeProjectPrefs;
exports.mergeProjectPrefs = mergeProjectPrefs;
exports.hasLocalPreferenceFields = hasLocalPreferenceFields;
exports.extractProjectPrefs = extractProjectPrefs;
exports.stripLocalPreferenceFields = stripLocalPreferenceFields;
exports.splitLocalPreferences = splitLocalPreferences;
exports.effectiveState = effectiveState;
exports.readEffectiveState = readEffectiveState;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const config_1 = require("../config");
const fsjson_1 = require("../fsjson");
const text_1 = require("../text");
const canonicalize_1 = require("./canonicalize");
const constants_1 = require("./constants");
const io_1 = require("./io");
const toolchain_1 = require("./toolchain");
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function inSet(set, value) {
    return typeof value === 'string' && set.has(value);
}
exports.LOCAL_PREF_KEYS = new Set([
    'openCode', 'codeGraphProvider', 'performance', 'team', 'toolchain',
    'codeGraphAutoRun', 'graphifyAutoRun', 'graphifyLastHintedAt', 'graphifyLastRunAt',
    'graphifyLastErrorAt', 'graphifyLastError', 'gitnexusLastRunAt', 'gitnexusLastErrorAt', 'gitnexusLastError',
]);
function projectRootHash(cwd) {
    let root;
    try {
        root = fs.realpathSync(path.resolve(cwd));
    }
    catch {
        root = path.resolve(cwd);
    }
    return (0, text_1.sha256)(root);
}
function projectPrefsPath(cwd, env = process.env) {
    if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH)
        return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH);
    const base = env.XDG_STATE_HOME
        ? path.join(env.XDG_STATE_HOME, 'traffic-one')
        : path.join(env.HOME || os.homedir(), '.traffic-one');
    return path.join(base, 'projects', projectRootHash(cwd), 'preferences.json');
}
function normalizeProjectPrefs(prefs) {
    const base = obj(prefs);
    if (!base)
        return {};
    const out = { ...base };
    let changed = false;
    const provider = (0, canonicalize_1.codeGraphProviderFromValue)(out.codeGraphProvider);
    if (provider) {
        if (out.codeGraphProvider !== provider)
            changed = true;
        out.codeGraphProvider = provider;
    }
    else if (Object.prototype.hasOwnProperty.call(out, 'codeGraphProvider')) {
        delete out.codeGraphProvider;
        changed = true;
    }
    if (typeof out.performance === 'string') {
        const level = (0, canonicalize_1.canonicalPerformanceLevel)(out.performance);
        if (typeof level === 'string' && constants_1.PERFORMANCE_LEVEL_IDS.has(level)) {
            out.performance = { level, source: 'prompted' };
            changed = true;
        }
        else {
            delete out.performance;
            changed = true;
        }
    }
    const perf = obj(out.performance);
    if (perf) {
        const level = (0, canonicalize_1.canonicalPerformanceLevel)(perf.level);
        const rawSource = typeof perf.source === 'string'
            ? perf.source.trim().toLowerCase().replace(/[_\s]+/g, '-')
            : 'prompted';
        const normalized = { ...perf, level, source: constants_1.PERFORMANCE_SOURCE_IDS.has(rawSource) ? rawSource : 'prompted' };
        if (perf.level !== normalized.level || perf.source !== normalized.source)
            changed = true;
        if (typeof level === 'string' && constants_1.PERFORMANCE_LEVEL_IDS.has(level)) {
            out.performance = normalized;
        }
        else {
            delete out.performance;
            changed = true;
        }
    }
    if (typeof out.team === 'string') {
        const team = (0, canonicalize_1.teamStateFromString)(out.team);
        if (team) {
            out.team = team;
            changed = true;
        }
        else {
            delete out.team;
            changed = true;
        }
    }
    const team = obj(out.team);
    if (team) {
        const perfNow = obj(out.performance);
        const performanceLevel = perfNow ? perfNow.level : null;
        const normalized = {
            ...team,
            mode: (0, canonicalize_1.canonicalTeamMode)(team.mode),
            source: (0, canonicalize_1.canonicalTeamSource)(team.source || 'prompted'),
        };
        const normalizedOverrides = (0, canonicalize_1.canonicalTeamOverrides)(team.overrides, performanceLevel);
        if (normalizedOverrides)
            normalized.overrides = normalizedOverrides;
        else if ('overrides' in normalized)
            delete normalized.overrides;
        if (team.approved === true)
            normalized.approved = true;
        else if ('approved' in normalized)
            delete normalized.approved;
        if (normalized.mode !== 'subagents' && 'modeChangeApproval' in normalized)
            delete normalized.modeChangeApproval;
        if (inSet(constants_1.TEAM_MODE_IDS, normalized.mode) && inSet(constants_1.TEAM_SOURCE_IDS, normalized.source)) {
            if (team.mode !== normalized.mode
                || team.source !== normalized.source
                || team.approved !== normalized.approved
                || !(0, canonicalize_1.overridesEqual)(team.overrides, normalized.overrides)
                || team.modeChangeApproval !== normalized.modeChangeApproval)
                changed = true;
            out.team = normalized;
        }
        else {
            delete out.team;
            changed = true;
        }
    }
    const toolchain = obj(out.toolchain);
    if (toolchain) {
        const normalizedToolchain = (0, toolchain_1.initializeLocalToolchainState)(toolchain);
        if (JSON.stringify(toolchain) !== JSON.stringify(normalizedToolchain))
            changed = true;
        out.toolchain = normalizedToolchain;
    }
    const openCode = obj(out.openCode);
    if (openCode) {
        out.openCode = {
            ...openCode,
            enabled: openCode.enabled === true,
            source: (0, canonicalize_1.canonicalOpenCodeSource)(openCode.source),
            decidedAt: typeof openCode.decidedAt === 'string' && openCode.decidedAt.trim()
                ? openCode.decidedAt
                : (0, io_1.stateTimestamp)(),
        };
    }
    return changed ? { ...out } : out;
}
function readProjectPrefs(cwd, env = process.env) {
    return normalizeProjectPrefs((0, fsjson_1.readJson)(projectPrefsPath(cwd, env), {}));
}
function writeProjectPrefs(cwd, prefs, env = process.env) {
    const normalized = normalizeProjectPrefs(prefs);
    (0, fsjson_1.writeJson)(projectPrefsPath(cwd, env), normalized);
    return normalized;
}
function mergePlainObject(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        return patch;
    if (!current || typeof current !== 'object' || Array.isArray(current))
        return { ...patch };
    return { ...current, ...patch };
}
function mergeProjectPrefsObject(current, patch) {
    const patchObj = obj(patch);
    const next = { ...current, ...(patchObj || {}) };
    if (patchObj) {
        if (Object.prototype.hasOwnProperty.call(patchObj, 'performance')) {
            const p = obj(patchObj.performance);
            next.performance = p && !Object.prototype.hasOwnProperty.call(p, 'level')
                ? mergePlainObject(current.performance, patchObj.performance)
                : patchObj.performance;
        }
        if (Object.prototype.hasOwnProperty.call(patchObj, 'team')) {
            const t = obj(patchObj.team);
            next.team = t && !Object.prototype.hasOwnProperty.call(t, 'mode')
                ? mergePlainObject(current.team, patchObj.team)
                : patchObj.team;
        }
        if (Object.prototype.hasOwnProperty.call(patchObj, 'openCode')) {
            const o = obj(patchObj.openCode);
            next.openCode = o && !Object.prototype.hasOwnProperty.call(o, 'enabled')
                ? mergePlainObject(current.openCode, patchObj.openCode)
                : patchObj.openCode;
        }
        const patchToolchain = obj(patchObj.toolchain);
        if (patchToolchain) {
            const currentToolchain = obj(current.toolchain) || {};
            const merged = { ...currentToolchain };
            for (const [name, stamp] of Object.entries(patchToolchain)) {
                merged[name] = mergePlainObject(currentToolchain[name], stamp);
            }
            next.toolchain = merged;
        }
    }
    return normalizeProjectPrefs(next);
}
function mergeProjectPrefs(cwd, patch, env = process.env) {
    return writeProjectPrefs(cwd, mergeProjectPrefsObject(readProjectPrefs(cwd, env), patch), env);
}
function hasLocalPreferenceFields(value) {
    const v = obj(value);
    if (!v)
        return false;
    if (Object.keys(v).some((key) => exports.LOCAL_PREF_KEYS.has(key) || key === 'codeGraph' || key === 'subagentTeam')) {
        return true;
    }
    const stack = obj(v.stack);
    return Boolean(stack && (Object.prototype.hasOwnProperty.call(stack, 'codeGraph')
        || Object.prototype.hasOwnProperty.call(stack, 'codeGraphProvider')));
}
function extractProjectPrefs(value) {
    const source = obj(value) || {};
    const prefs = {};
    for (const key of exports.LOCAL_PREF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source, key))
            prefs[key] = source[key];
    }
    const stack = obj(source.stack);
    const nestedProvider = (0, canonicalize_1.codeGraphProviderFromValue)(source.codeGraph)
        || (0, canonicalize_1.codeGraphProviderFromValue)(stack ? (stack.codeGraph || stack.codeGraphProvider) : null);
    if (nestedProvider && !prefs.codeGraphProvider)
        prefs.codeGraphProvider = nestedProvider;
    if (!prefs.team && source.subagentTeam !== undefined)
        prefs.team = source.subagentTeam;
    return normalizeProjectPrefs(prefs);
}
function stripLocalPreferenceFields(value) {
    const out = obj(value) ? { ...value } : {};
    for (const key of exports.LOCAL_PREF_KEYS)
        delete out[key];
    delete out.codeGraph;
    delete out.subagentTeam;
    const stack = obj(out.stack);
    if (stack) {
        const nextStack = { ...stack };
        delete nextStack.codeGraph;
        delete nextStack.codeGraphProvider;
        out.stack = nextStack;
    }
    return out;
}
function splitLocalPreferences(cwd, state, env = process.env) {
    const stateRec = obj(state) || {};
    if (!hasLocalPreferenceFields(state)) {
        return { state: stateRec, prefs: readProjectPrefs(cwd, env), changed: false };
    }
    const localPatch = extractProjectPrefs(state);
    try {
        const prefs = mergeProjectPrefs(cwd, localPatch, env);
        return { state: stripLocalPreferenceFields(state), prefs, changed: true };
    }
    catch {
        const prefs = mergeProjectPrefsObject(readProjectPrefs(cwd, env), localPatch);
        return { state: stateRec, prefs, changed: false };
    }
}
function effectiveState(projectState, prefs) {
    const state = obj(projectState) ? { ...projectState } : {};
    const local = normalizeProjectPrefs(prefs);
    for (const key of exports.LOCAL_PREF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(local, key))
            state[key] = local[key];
        else
            delete state[key];
    }
    return state;
}
function readRawState(cwd) {
    const currentPath = path.join(cwd, config_1.STATE_FILE);
    if (fs.existsSync(currentPath))
        return (0, fsjson_1.readJson)(currentPath, {});
    const oldPath = path.join(cwd, config_1.LEGACY_STATE_FILE);
    if (fs.existsSync(oldPath)) {
        const legacy = (0, fsjson_1.readJson)(oldPath, {});
        if (legacy && typeof legacy === 'object')
            legacy.legacyStateFile = config_1.LEGACY_STATE_FILE;
        return legacy;
    }
    // Lazy require breaks the normalize ↔ local-prefs cycle (matches legacy).
    const { readState } = require('./normalize');
    return readState(cwd);
}
function readEffectiveState(cwd, env = process.env) {
    const state = readRawState(cwd);
    const embeddedPrefs = extractProjectPrefs(state);
    const prefs = Object.keys(embeddedPrefs).length > 0
        ? mergeProjectPrefsObject(readProjectPrefs(cwd, env), embeddedPrefs)
        : readProjectPrefs(cwd, env);
    return effectiveState(stripLocalPreferenceFields(state), prefs);
}
