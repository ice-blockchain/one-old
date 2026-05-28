"use strict";
// src/modules/session/auth-choice.ts
// The per-project "continue without" / global "authenticate" choice state.
// Ported 1:1 from the auth-choice cluster in scripts/hook-runtime/handlers/auth.cjs.
// Secure-write semantics (0o700 dir / 0o600 file) preserved.
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
exports.AUTH_CHOICE_CONTINUE_TTL_MS = exports.AUTH_CHOICE_STATE_VERSION = void 0;
exports.authChoiceStatePath = authChoiceStatePath;
exports.authChoiceStatePaths = authChoiceStatePaths;
exports.authChoiceStateExists = authChoiceStateExists;
exports.deleteAuthChoiceState = deleteAuthChoiceState;
exports.normalizeAuthChoiceState = normalizeAuthChoiceState;
exports.readAuthChoiceState = readAuthChoiceState;
exports.writeAuthChoiceState = writeAuthChoiceState;
exports.readAuthChoice = readAuthChoice;
exports.authChoiceStatus = authChoiceStatus;
exports.writeAuthChoice = writeAuthChoice;
exports.tryWriteAuthChoice = tryWriteAuthChoice;
exports.authChoiceAllowsContinue = authChoiceAllowsContinue;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const auth_1 = require("../../shared/auth");
const fsjson_1 = require("../../shared/fsjson");
const text_1 = require("../../shared/text");
exports.AUTH_CHOICE_STATE_VERSION = 3;
exports.AUTH_CHOICE_CONTINUE_TTL_MS = 4 * 60 * 60 * 1000;
function authChoiceStatePath(env = process.env) {
    if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH)
        return path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH);
    return path.join(path.dirname((0, auth_1.authStatePath)(env)), 'auth-choice.json');
}
function authChoiceFallbackStatePath(env = process.env) {
    if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH)
        return null;
    const digest = (0, text_1.sha256)((0, auth_1.authStatePath)(env)).slice(0, 16);
    return path.join(os.tmpdir(), 'traffic-one', `auth-choice-${digest}.json`);
}
function authChoiceStatePaths(env = process.env) {
    const primary = authChoiceStatePath(env);
    const fallback = authChoiceFallbackStatePath(env);
    return fallback && fallback !== primary ? [primary, fallback] : [primary];
}
// Whether any auth-choice state file is present (primary or tmpdir fallback).
function authChoiceStateExists(env = process.env) {
    return authChoiceStatePaths(env).some((filePath) => fs.existsSync(filePath));
}
// Clear the auth-choice state (both primary + fallback). Returns false if any
// removal threw. Called by the auth CLI on login (a fresh session supersedes a
// prior "continue without" choice) and on logout.
function deleteAuthChoiceState(env = process.env) {
    let ok = true;
    for (const filePath of authChoiceStatePaths(env)) {
        try {
            fs.rmSync(filePath, { force: true });
        }
        catch {
            ok = false;
        }
    }
    return ok;
}
function normalizeAuthChoiceState(state) {
    const empty = () => ({ version: exports.AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} });
    if (!state || typeof state !== 'object')
        return empty();
    const s = state;
    if (s.version === exports.AUTH_CHOICE_STATE_VERSION) {
        return {
            version: exports.AUTH_CHOICE_STATE_VERSION,
            globalChoice: s.globalChoice && typeof s.globalChoice === 'object' ? s.globalChoice : null,
            choices: s.choices && typeof s.choices === 'object' ? s.choices : {},
        };
    }
    if (s.choice && typeof s.choice === 'object') {
        const choice = s.choice;
        const migrated = empty();
        if (choice.status === 'authenticate') {
            migrated.globalChoice = { ...choice, scope: 'global' };
        }
        else if (typeof choice.cwd === 'string' && choice.cwd.trim()) {
            migrated.choices[path.resolve(choice.cwd)] = { ...choice, scope: 'project', cwd: path.resolve(choice.cwd) };
        }
        return migrated;
    }
    if (s.choices && typeof s.choices === 'object') {
        const choices = {};
        let globalChoice = null;
        for (const [key, raw] of Object.entries(s.choices)) {
            if (!raw || typeof raw !== 'object')
                continue;
            const record = raw;
            if (typeof record.status !== 'string')
                continue;
            const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : key;
            if (record.status === 'authenticate') {
                if (!globalChoice || Date.parse(record.updatedAt || '') > Date.parse(globalChoice.updatedAt || '')) {
                    globalChoice = { ...record, scope: 'global' };
                }
                continue;
            }
            choices[path.resolve(cwd)] = { ...record, scope: 'project', cwd: path.resolve(cwd) };
        }
        return { version: exports.AUTH_CHOICE_STATE_VERSION, globalChoice, choices };
    }
    return empty();
}
function readAuthChoiceState(env = process.env) {
    for (const filePath of authChoiceStatePaths(env)) {
        if (!fs.existsSync(filePath))
            continue;
        const state = (0, fsjson_1.readJson)(filePath, null);
        if (state && typeof state === 'object')
            return normalizeAuthChoiceState(state);
    }
    return { version: exports.AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
}
function writeAuthChoiceState(state, env = process.env) {
    const paths = authChoiceStatePaths(env);
    const errors = [];
    for (const filePath of paths) {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            try {
                fs.chmodSync(filePath, 0o600);
            }
            catch {
                // best-effort; some filesystems ignore chmod
            }
            return { ok: true, filePath, fallback: filePath !== paths[0] };
        }
        catch (error) {
            errors.push({ filePath, error: error });
        }
    }
    const first = errors[0]?.error ?? new Error('auth choice state write failed');
    throw first;
}
function readAuthChoice(cwd = process.cwd(), env = process.env) {
    const state = readAuthChoiceState(env);
    const key = path.resolve(cwd || process.cwd());
    const projectChoice = state.choices[key] && typeof state.choices[key] === 'object' ? state.choices[key] : null;
    if (projectChoice && projectChoice.status === 'continue-without-traffic-one') {
        const expires = Date.parse(projectChoice.expiresAt || '');
        if (!Number.isFinite(expires) || expires <= Date.now()) {
            return state.globalChoice || projectChoice;
        }
        return projectChoice;
    }
    if (state.globalChoice && state.globalChoice.status === 'authenticate')
        return state.globalChoice;
    return projectChoice || state.globalChoice || null;
}
function authChoiceStatus(cwd = process.cwd(), env = process.env) {
    const record = readAuthChoice(cwd, env);
    return record && typeof record.status === 'string' ? record.status : null;
}
function writeAuthChoice(status, cwd = process.cwd(), env = process.env) {
    const state = readAuthChoiceState(env);
    const now = Date.now();
    const key = path.resolve(cwd || process.cwd());
    const record = {
        status,
        scope: status === 'authenticate' ? 'global' : 'project',
        ...(status === 'authenticate' ? {} : { cwd: key }),
        updatedAt: (0, text_1.nowIsoNoMs)(),
    };
    if (status === 'continue-without-traffic-one') {
        record.expiresAt = new Date(now + exports.AUTH_CHOICE_CONTINUE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    if (status === 'authenticate') {
        state.globalChoice = record;
        delete state.choices[key];
    }
    else {
        state.choices[key] = record;
    }
    return writeAuthChoiceState(state, env);
}
function tryWriteAuthChoice(status, cwd = process.cwd(), env = process.env) {
    try {
        return { ...writeAuthChoice(status, cwd, env), ok: true };
    }
    catch (error) {
        const err = error;
        return { ok: false, code: err && err.code ? String(err.code) : null, message: (err && err.message) || 'auth choice state write failed' };
    }
}
function authChoiceAllowsContinue(cwd = process.cwd(), env = process.env, nowMs = Date.now()) {
    const record = readAuthChoice(cwd, env);
    if (!record || record.status !== 'continue-without-traffic-one')
        return false;
    const expires = Date.parse(record.expiresAt || '');
    return Number.isFinite(expires) && expires > nowMs;
}
