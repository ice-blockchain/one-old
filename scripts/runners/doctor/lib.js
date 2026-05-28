"use strict";
// src/runners/doctor/lib.ts
// Helpers for the traffic-one doctor (compiles into scripts/doctor.cjs).
// Ported 1:1 from scripts/doctor/_helpers.cjs. Pure reads + parsing only —
// doctor never writes to the project, never installs, never mutates state.
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
exports.codeGraphProviderFromValue = exports.which = void 0;
exports.safeRead = safeRead;
exports.safeStat = safeStat;
exports.safeJsonParse = safeJsonParse;
exports.parseArgs = parseArgs;
exports.codexConfigPath = codexConfigPath;
exports.parseTomlScalar = parseTomlScalar;
exports.parseCodexConfigToml = parseCodexConfigToml;
exports.trustedProjectForCwd = trustedProjectForCwd;
exports.mcpConfigPath = mcpConfigPath;
exports.codexSessionsDir = codexSessionsDir;
exports.walkJsonlFiles = walkJsonlFiles;
exports.readFirstJsonlObject = readFirstJsonlObject;
exports.sessionIdFromFile = sessionIdFromFile;
exports.getPayloadText = getPayloadText;
exports.commandLooksMutating = commandLooksMutating;
exports.authProbeForSession = authProbeForSession;
exports.normalizedProjectState = normalizedProjectState;
exports.rawStateHasLegacyShape = rawStateHasLegacyShape;
exports.onboardingStateIssues = onboardingStateIssues;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const auth_1 = require("../../shared/auth");
const config_1 = require("../../shared/config");
const exec_1 = require("../../shared/exec");
const paths_1 = require("../../shared/paths");
const performance_1 = require("../../shared/performance");
const state_1 = require("../../shared/state");
Object.defineProperty(exports, "codeGraphProviderFromValue", { enumerable: true, get: function () { return state_1.codeGraphProviderFromValue; } });
exports.which = exec_1.exec.which;
function safeRead(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function safeStat(p) {
    try {
        return fs.statSync(p);
    }
    catch {
        return null;
    }
}
function safeJsonParse(text, fallback = null) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
function parseArgs(argv = process.argv.slice(2)) {
    const out = { session: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--session' && argv[index + 1]) {
            out.session = argv[index + 1] ?? null;
            index += 1;
        }
    }
    return out;
}
function codexConfigPath(env = process.env) {
    const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : '');
    return codexHome ? path.join(codexHome, 'config.toml') : null;
}
function parseTomlScalar(value) {
    const trimmed = String(value || '').trim();
    if (trimmed === 'true')
        return true;
    if (trimmed === 'false')
        return false;
    const quoted = trimmed.match(/^"((?:\\"|[^"])*)"$/);
    if (quoted && quoted[1] !== undefined)
        return quoted[1].replace(/\\"/g, '"');
    return trimmed;
}
function parseCodexConfigToml(text) {
    const sections = {};
    let current = '';
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch && sectionMatch[1] !== undefined) {
            current = sectionMatch[1];
            sections[current] = sections[current] || {};
            continue;
        }
        const keyMatch = line.match(/^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/);
        if (!keyMatch || keyMatch[1] === undefined || keyMatch[2] === undefined || !current)
            continue;
        const key = keyMatch[1].replace(/^"|"$/g, '');
        const section = sections[current] || (sections[current] = {});
        section[key] = parseTomlScalar(keyMatch[2]);
    }
    return sections;
}
function trustedProjectForCwd(cwd, sections) {
    const resolvedCwd = path.resolve(cwd);
    let best = null;
    for (const [section, values] of Object.entries(sections || {})) {
        const match = section.match(/^projects\."(.+)"$/);
        if (!match || match[1] === undefined)
            continue;
        if (!values || values.trust_level !== 'trusted')
            continue;
        const projectRoot = path.resolve(match[1]);
        const covered = resolvedCwd === projectRoot || resolvedCwd.startsWith(`${projectRoot}${path.sep}`);
        if (!covered)
            continue;
        if (!best || projectRoot.length > best.length)
            best = projectRoot;
    }
    return best;
}
function mcpConfigPath() {
    return path.join((0, paths_1.pluginRoot)(), '.mcp.json');
}
function codexSessionsDir(env = process.env) {
    const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : path.join(os.homedir(), '.codex'));
    return path.join(codexHome, 'sessions');
}
function walkJsonlFiles(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.'))
            continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsonlFiles(fullPath, out);
        }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            out.push(fullPath);
        }
    }
    return out;
}
function readFirstJsonlObject(filePath) {
    let text = '';
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(256 * 1024);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            text = buffer.subarray(0, bytes).toString('utf8');
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return null;
    }
    const line = text.split(/\r?\n/, 1)[0] ?? '';
    return safeJsonParse(line, null);
}
function sessionIdFromFile(filePath) {
    const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match && match[1] !== undefined
        ? match[1]
        : path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}
function getPayloadText(payload) {
    if (!payload || typeof payload !== 'object')
        return '';
    const p = payload;
    const pick = (v) => {
        const obj = v && typeof v === 'object' ? v : null;
        return obj && typeof obj.text === 'string' ? obj.text : undefined;
    };
    return [pick(p.base_instructions), pick(p.instructions), pick(p.user_instructions)]
        .filter((value) => typeof value === 'string')
        .join('\n');
}
function commandLooksMutating(name, rawArgs) {
    if (name === 'apply_patch')
        return true;
    if (name === 'request_plugin_install' || name === 'automation_update')
        return true;
    if (name !== 'exec_command')
        return false;
    const args = safeJsonParse(typeof rawArgs === 'string' ? rawArgs : '', {}) ?? {};
    const command = typeof args.cmd === 'string' ? args.cmd : String(rawArgs || '');
    return /\b(apply_patch|npm\s+install|pnpm\s+(install|add|approve-builds|rebuild)|yarn\s+(install|add)|bun\s+(install|add)|npx\s+create-|mkdir\b|touch\b|rm\b|mv\b|cp\b|rsync\b|git\s+(init|checkout|reset|clean)|tee\b|cat\s*>|>\s*[^&])/.test(command);
}
function authProbeForSession(sessionStartedAt, env = process.env) {
    const filePath = (0, auth_1.authStatePath)(env);
    const state = (0, auth_1.readAuthState)(env);
    const startedMs = Date.parse(sessionStartedAt || '');
    const expiresMs = Date.parse(state && typeof state.expiresAt === 'string' ? state.expiresAt : '');
    const expiredAtSessionStart = Boolean(state
        && Number.isFinite(startedMs)
        && Number.isFinite(expiresMs)
        && expiresMs <= startedMs);
    return {
        filePath,
        present: Boolean(state),
        expiresAt: state && typeof state.expiresAt === 'string' ? state.expiresAt : null,
        expiredAtSessionStart,
    };
}
function normalizedProjectState(project) {
    if (project.normalizedState && typeof project.normalizedState === 'object') {
        return project.normalizedState;
    }
    if (!project.state || typeof project.state !== 'object')
        return null;
    const cloned = JSON.parse(JSON.stringify(project.state));
    (0, state_1.normalizeState)(cloned, (typeof cloned.mode === 'string' && cloned.mode)
        || (typeof cloned.projectMode === 'string' && cloned.projectMode)
        || 'new-project');
    return cloned;
}
function rawStateHasLegacyShape(state) {
    if (!state || typeof state !== 'object')
        return false;
    const s = state;
    return Boolean(Object.prototype.hasOwnProperty.call(s, 'projectMode')
        || Object.prototype.hasOwnProperty.call(s, 'subagentTeam')
        || Object.prototype.hasOwnProperty.call(s, 'codeGraph')
        || (s.stack && typeof s.stack === 'object' && !Array.isArray(s.stack)));
}
function onboardingStateIssues(rawState, state) {
    const issues = [];
    if (!state || typeof state !== 'object')
        return ['state file is not a JSON object'];
    const mode = state.mode || rawState?.projectMode;
    if (mode !== 'new-project')
        return issues;
    const persistedState = rawState && typeof rawState === 'object' ? rawState : state;
    if (state.mode !== 'new-project')
        issues.push('mode');
    if (typeof state.stack !== 'string' || !config_1.STACK_IDS.has(state.stack))
        issues.push('stack');
    if (state.codeGraphProvider !== 'gitnexus' && state.codeGraphProvider !== 'graphify') {
        issues.push('codeGraphProvider');
    }
    if (!(0, state_1.hasValidPerformanceState)(state.performance))
        issues.push('performance');
    if (!(0, state_1.hasValidProjectContext)(state.projectContext))
        issues.push('projectContext');
    if (!(0, state_1.hasValidTeamState)(state.team)) {
        issues.push('team');
    }
    else if ((0, state_1.hasValidPerformanceState)(state.performance)) {
        const performance = state.performance;
        const team = state.team;
        const expectedTeamMode = (0, performance_1.teamModeForLevel)(String(performance.level));
        if (team.mode !== expectedTeamMode) {
            issues.push('team.mode');
        }
        if (expectedTeamMode === 'subagents'
            && team.source !== 'unavailable'
            && !(0, state_1.isTeamApproved)(team)) {
            issues.push('team.approved (Team Confirmation)');
        }
    }
    if (persistedState.confirmed !== true)
        issues.push('confirmed');
    if (persistedState.onboardingComplete !== true)
        issues.push('onboardingComplete');
    if (typeof persistedState.confirmedAt !== 'string' || persistedState.confirmedAt.trim() === '')
        issues.push('confirmedAt');
    return [...new Set(issues)];
}
