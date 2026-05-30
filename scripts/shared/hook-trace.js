"use strict";
// src/shared/hook-trace.ts
// Off-by-default diagnostic. When TRAFFIC_ONE_HOOK_TRACE is set, append one JSON
// line per hook invocation capturing exactly what the host piped in (stdin), the
// parsed canonical input, the run-agent identity the plugin resolves, the
// effective team.mode / performance.level, the run-claim files on disk, and a
// filtered slice of env. Purpose: determine what identity signal Codex actually
// delivers to per-tool-call hooks (subagent thread id / parent / env var) before
// committing to an identity-recovery mechanism — see the Phase 0 plan.
//
// Contract: never throws (preserves the always-exit-0 hook contract) and never
// captures secrets (env is allowlisted by name and value-truncated).
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
exports.maybeTraceHook = maybeTraceHook;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const obj_1 = require("./obj");
const paths_1 = require("./paths");
const text_1 = require("./text");
const state_1 = require("./state");
const run_agent_1 = require("./state/run-agent");
const ENV_ALLOW_RE = /(CODEX|THREAD|AGENT|SESSION|PARENT|NICK|FORK|SUBAGENT|ROLLOUT)/i;
const ENV_DENY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE)/i;
function filteredEnv(env) {
    const out = {};
    for (const [name, value] of Object.entries(env)) {
        if (typeof value !== 'string')
            continue;
        if (!ENV_ALLOW_RE.test(name) || ENV_DENY_RE.test(name))
            continue;
        out[name] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
    }
    return out;
}
// Best-effort list of run-claim files (pending + claimed) so the trace shows what
// the resolver had to match against at write time. Capped to keep lines small.
function runClaimFiles(projectRoot) {
    const root = path.join(projectRoot, '.traffic-one', 'runs');
    const found = [];
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (found.length >= 50)
                return;
            if (entry.isDirectory())
                walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
            else if (entry.name.endsWith('.json'))
                found.push(`${rel}${entry.name}`);
        }
    };
    try {
        for (const run of fs.readdirSync(root, { withFileTypes: true })) {
            if (run.isDirectory())
                walk(path.join(root, run.name), `${run.name}/`);
        }
    }
    catch {
        // no runs dir yet — fine
    }
    return found;
}
// Enabled by either the env var (TRAFFIC_ONE_HOOK_TRACE) or a per-project marker
// file (.traffic-one/debug/trace.on) — the marker avoids having to inject env into a
// host (e.g. Codex Desktop) that does not forward shell env to hook subprocesses.
function traceEnabled(projectRoot, env) {
    if (env.TRAFFIC_ONE_HOOK_TRACE)
        return true;
    try {
        return fs.existsSync(path.join(projectRoot, '.traffic-one', 'debug', 'trace.on'));
    }
    catch {
        return false;
    }
}
function maybeTraceHook(input, stdin, env = process.env) {
    try {
        const projectRoot = paths_1.paths.projectRoot(input);
        if (!traceEnabled(projectRoot, env))
            return;
        let identity;
        try {
            identity = (0, run_agent_1.hookSessionIdentity)(input.raw);
        }
        catch {
            identity = 'ERR';
        }
        let teamMode = null;
        let level = null;
        try {
            const state = (0, obj_1.obj)((0, state_1.readEffectiveState)(projectRoot)) || {};
            teamMode = ((0, obj_1.obj)(state.team) || {}).mode ?? null;
            level = ((0, obj_1.obj)(state.performance) || {}).level ?? null;
        }
        catch {
            // best-effort
        }
        const record = {
            at: (0, text_1.nowIso)(),
            event: input.event,
            host: input.host,
            cwd: input.cwd,
            projectRoot,
            tool: input.tool
                ? { rawName: input.tool.rawName, class: input.tool.class, filePath: input.tool.filePath ?? null }
                : null,
            identity,
            teamMode,
            level,
            runClaims: runClaimFiles(projectRoot),
            env: filteredEnv(env),
            stdin: stdin.length > 8192 ? `${stdin.slice(0, 8192)}…[${stdin.length}B]` : stdin,
        };
        const dir = path.join(projectRoot, '.traffic-one', 'debug');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'hook-trace.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    }
    catch {
        // Diagnostics must never affect the hook outcome.
    }
}
