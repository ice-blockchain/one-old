"use strict";
// src/runners/doctor/probes.ts
// Environment + project + Codex-session probes for the traffic-one doctor.
// Ported 1:1 from scripts/doctor/{probeNode,probeNvm,probeGitnexus,probeProject,
// probeCodexHooks,probeMcpAuth,probeSessionDiagnostics,analyzeCodexSessionFile,
// resolveCodexSession}.cjs. All reads; no writes.
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
exports.probeNode = probeNode;
exports.probeNvm = probeNvm;
exports.probeGitnexus = probeGitnexus;
exports.probeProject = probeProject;
exports.probeCodexHooks = probeCodexHooks;
exports.probeMcpAuth = probeMcpAuth;
exports.analyzeCodexSessionFile = analyzeCodexSessionFile;
exports.resolveCodexSession = resolveCodexSession;
exports.probeSessionDiagnostics = probeSessionDiagnostics;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const state_1 = require("../../shared/state");
const gitnexus_1 = require("../gitnexus");
const lib_1 = require("./lib");
function probeNode() {
    return {
        runningMajor: (0, gitnexus_1.currentNodeMajor)(),
        runningVersion: process.versions.node,
        onPath: (0, lib_1.which)('node'),
        requiredMajor: gitnexus_1.GITNEXUS_MIN_NODE_MAJOR,
    };
}
function probeNvm() {
    const home = process.env.HOME || '';
    const installed = (0, gitnexus_1.nvmPresent)();
    if (!installed)
        return { installed: false };
    const nvmRoot = path.join(home, '.nvm');
    const defaultAlias = ((0, lib_1.safeRead)(path.join(nvmRoot, 'alias', 'default')) || '').trim();
    let versions = [];
    try {
        versions = fs.readdirSync(path.join(nvmRoot, 'versions', 'node'))
            .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
            .sort();
    }
    catch { /* empty */ }
    const nvm22 = (0, gitnexus_1.findNvmNode22)();
    return {
        installed: true,
        root: nvmRoot,
        defaultAlias,
        installedVersions: versions,
        hasV22: !!nvm22,
        v22Paths: nvm22,
        installCommand: nvm22 ? null : (0, gitnexus_1.nvmInstallCommand)(),
    };
}
function probeGitnexus() {
    const fromPath = (0, lib_1.which)('gitnexus');
    const nvm22 = (0, gitnexus_1.findNvmNode22)();
    return {
        onPath: fromPath,
        absoluteV22: nvm22 ? nvm22.gitnexus : null,
        // A pre-existing gitnexus living inside an OLDER nvm Node folder is the
        // "installed via --force, will crash" landmine. Flag it.
        crashRiskInOldNvm: !!(fromPath && /\/\.nvm\/versions\/node\/v(?!22)[\d.]+\/bin\/gitnexus$/.test(fromPath)),
    };
}
function probeProject(cwd) {
    const trafficOne = (0, lib_1.safeRead)(path.join(cwd, '.traffic-one', '.one.json'));
    let state = null;
    if (trafficOne) {
        try {
            state = JSON.parse(trafficOne);
        }
        catch {
            state = null;
        }
    }
    let normalizedState = null;
    let localPreferences = {};
    let localPreferencesPath = null;
    if (state && typeof state === 'object') {
        localPreferencesPath = (0, state_1.projectPrefsPath)(cwd);
        localPreferences = (0, state_1.readProjectPrefs)(cwd);
        normalizedState = (0, state_1.effectiveState)((0, state_1.stripLocalPreferenceFields)(state), localPreferences);
        (0, state_1.normalizeState)(normalizedState, (typeof normalizedState.mode === 'string' && normalizedState.mode)
            || (typeof normalizedState.projectMode === 'string' && normalizedState.projectMode)
            || 'new-project');
    }
    const nvmrcRaw = (0, lib_1.safeRead)(path.join(cwd, '.nvmrc'));
    const gitDir = (0, lib_1.safeStat)(path.join(cwd, '.git'));
    const gitnexusOut = (0, lib_1.safeStat)(path.join(cwd, '.gitnexus'));
    const graphifyOut = (0, lib_1.safeStat)(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'));
    return {
        cwd,
        hasState: !!state,
        state,
        localPreferences,
        localPreferencesPath,
        hasLocalPreferences: Object.keys(localPreferences || {}).length > 0,
        normalizedState,
        nvmrc: nvmrcRaw === null ? null : nvmrcRaw.trim(),
        hasGit: !!gitDir && gitDir.isDirectory(),
        artefacts: {
            gitnexus: gitnexusOut ? { mtimeMs: gitnexusOut.mtimeMs } : null,
            graphify: graphifyOut ? { mtimeMs: graphifyOut.mtimeMs } : null,
        },
    };
}
function probeCodexHooks(cwd, env = process.env) {
    const configPath = (0, lib_1.codexConfigPath)(env);
    const text = configPath ? (0, lib_1.safeRead)(configPath) : null;
    if (!text) {
        return { host: 'codex', configPath, configExists: false, cwd: path.resolve(cwd) };
    }
    const sections = (0, lib_1.parseCodexConfigToml)(text);
    const pluginSection = sections['plugins."traffic-one@traffic-one-local"'] || null;
    const hookSections = Object.entries(sections)
        .filter(([section]) => section.startsWith('hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:'));
    const hookEvents = new Set();
    let hookStateEnabledCount = 0;
    let hookStateTrustedHashCount = 0;
    for (const [section, values] of hookSections) {
        const eventMatch = section.match(/hooks\/hooks\.json:([^:]+):/);
        if (eventMatch && eventMatch[1] !== undefined)
            hookEvents.add(eventMatch[1]);
        if (values && values.enabled === true)
            hookStateEnabledCount += 1;
        if (values && typeof values.trusted_hash === 'string' && values.trusted_hash.startsWith('sha256:')) {
            hookStateTrustedHashCount += 1;
        }
    }
    const requiredHookEvents = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use'];
    const missingHookEvents = requiredHookEvents.filter((event) => !hookEvents.has(event));
    const trustedProject = (0, lib_1.trustedProjectForCwd)(cwd, sections);
    return {
        host: 'codex',
        configPath,
        configExists: true,
        cwd: path.resolve(cwd),
        pluginEnabled: pluginSection ? pluginSection.enabled === true : null,
        hookStateEntryCount: hookSections.length,
        hookStateEnabledCount,
        hookStateTrustedHashCount,
        hookEvents: [...hookEvents].sort(),
        missingHookEvents,
        trustCovered: Boolean(trustedProject),
        trustedProject,
    };
}
function probeMcpAuth(env = process.env) {
    const configPath = (0, lib_1.mcpConfigPath)();
    const raw = (0, lib_1.safeRead)(configPath);
    const config = raw ? (0, lib_1.safeJsonParse)(raw, null) : null;
    const servers = config && config.mcpServers && typeof config.mcpServers === 'object'
        ? config.mcpServers
        : null;
    const server = servers && servers['mcp-auth'] && typeof servers['mcp-auth'] === 'object'
        ? servers['mcp-auth']
        : null;
    return {
        configPath,
        configExists: Boolean(raw),
        configured: Boolean(server),
        type: server && typeof server.type === 'string' ? server.type : null,
        url: server && typeof server.url === 'string' ? server.url : null,
        credentialPath: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH || null,
    };
}
function analyzeCodexSessionFile(filePath, env = process.env) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
    const diagnostics = {
        id: (0, lib_1.sessionIdFromFile)(filePath),
        jsonl: filePath,
        cwd: null,
        startedAt: null,
        hookPayloadCount: 0,
        promptRequestCount: 0,
        permissionDecisionCount: 0,
        trafficOneAuthPromptCount: 0,
        trafficOneInstructionInjected: false,
        baseInstructionsMentionTrafficOne: false,
        toolCallCount: 0,
        mutatingToolCallCount: 0,
        firstAuthGateAt: null,
        firstMutatingToolAt: null,
        mutatingToolBeforeAuthGate: false,
        authState: null,
    };
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const parsed = (0, lib_1.safeJsonParse)(line, null);
        if (!parsed)
            continue;
        const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
        const serialized = JSON.stringify(parsed);
        if (serialized.includes('hookSpecificOutput'))
            diagnostics.hookPayloadCount += 1;
        if (serialized.includes('promptRequest'))
            diagnostics.promptRequestCount += 1;
        if (serialized.includes('permissionDecision'))
            diagnostics.permissionDecisionCount += 1;
        if (serialized.includes('traffic-one.auth.choice')) {
            diagnostics.trafficOneAuthPromptCount += 1;
            if (!diagnostics.firstAuthGateAt)
                diagnostics.firstAuthGateAt = timestamp;
        }
        if (parsed.type === 'session_meta') {
            const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
            diagnostics.id = typeof payload.id === 'string' ? payload.id : diagnostics.id;
            diagnostics.cwd = typeof payload.cwd === 'string' ? payload.cwd : diagnostics.cwd;
            diagnostics.startedAt = (typeof payload.timestamp === 'string' ? payload.timestamp : null) || timestamp || diagnostics.startedAt;
            const instructionText = (0, lib_1.getPayloadText)(payload);
            diagnostics.baseInstructionsMentionTrafficOne = /Traffic One|traffic-one|\.traffic-one/.test(instructionText);
            diagnostics.trafficOneInstructionInjected = /Traffic One Codex Instructions|\.traffic-one\/rules\/common\/auth-gate\.md|Authenticate with the `mcp-auth` server/.test(instructionText);
            continue;
        }
        if (parsed.type !== 'response_item')
            continue;
        const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call')
            continue;
        const name = typeof payload.name === 'string' ? payload.name : '';
        diagnostics.toolCallCount += 1;
        const rawArgs = payload.arguments || payload.input || '';
        if ((0, lib_1.commandLooksMutating)(name, rawArgs)) {
            diagnostics.mutatingToolCallCount += 1;
            if (!diagnostics.firstMutatingToolAt)
                diagnostics.firstMutatingToolAt = timestamp;
        }
    }
    diagnostics.authState = (0, lib_1.authProbeForSession)(diagnostics.startedAt, env);
    diagnostics.mutatingToolBeforeAuthGate = Boolean(diagnostics.firstMutatingToolAt
        && (!diagnostics.firstAuthGateAt
            || diagnostics.firstMutatingToolAt < diagnostics.firstAuthGateAt));
    return diagnostics;
}
function resolveCodexSession(sessionId, env = process.env) {
    const root = (0, lib_1.codexSessionsDir)(env);
    const files = (0, lib_1.walkJsonlFiles)(root);
    const direct = files.find((filePath) => path.basename(filePath).includes(sessionId));
    if (direct)
        return direct;
    for (const filePath of files) {
        const first = (0, lib_1.readFirstJsonlObject)(filePath);
        const payload = first && first.payload && typeof first.payload === 'object' ? first.payload : {};
        if (payload.id === sessionId)
            return filePath;
    }
    return null;
}
function probeSessionDiagnostics(sessionId, env = process.env) {
    if (!sessionId)
        return null;
    const filePath = resolveCodexSession(sessionId, env);
    if (!filePath) {
        return { id: sessionId, found: false, sessionsDir: (0, lib_1.codexSessionsDir)(env) };
    }
    const analyzed = analyzeCodexSessionFile(filePath, env);
    if (!analyzed)
        return { id: sessionId, found: false, sessionsDir: (0, lib_1.codexSessionsDir)(env) };
    return { found: true, ...analyzed };
}
