"use strict";
// src/shared/onboarding-server/ensure.ts
// Idempotent launcher for the detached onboarding wizard server, called from the
// synchronous PreToolUse gate. Reuse path: a recorded pid that is still alive ⇒
// return its URL (no spawn). Otherwise spawn the detached server (same pattern as
// the one-mcp report worker: detached + unref) and block-poll the registry file
// for the child to publish its {port,url} after listen(). The wait is a short
// synchronous Atomics sleep so the hook stays a plain sync function.
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
exports.processAlive = processAlive;
exports.ensureOnboardingServer = ensureOnboardingServer;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const paths_1 = require("../paths");
const registry_1 = require("./registry");
function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // ESRCH ⇒ no such process; EPERM ⇒ exists but not ours (still alive).
        return err.code === 'EPERM';
    }
}
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
    }
    catch {
        // SharedArrayBuffer disabled — re-poll immediately rather than busy-spin.
    }
}
function defaultLaunch(cwd, env) {
    const entry = env.TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY
        || path.join((0, paths_1.pluginRoot)(), 'scripts', 'onboarding-server.cjs');
    const child = (0, child_process_1.spawn)(process.execPath, [entry, cwd], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...env },
    });
    child.unref();
    return typeof child.pid === 'number' ? child.pid : -1;
}
function ensureOnboardingServer(cwd, options = {}) {
    const env = options.env || process.env;
    const isAlive = options.isAlive || processAlive;
    const launch = options.launch || defaultLaunch;
    const existing = (0, registry_1.readServerRecord)(cwd, env);
    if (existing && isAlive(existing.pid)) {
        return { url: existing.url, port: existing.port, token: existing.token, started: false };
    }
    // Test/CI guard (mirrors TRAFFIC_ONE_ONE_MCP_NO_SPAWN): never spawn a real
    // detached server. Reuse a pre-seeded record if present, else hand back a
    // placeholder URL so the gate can still render its deny prose deterministically.
    if (env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN === '1') {
        if (existing)
            return { url: existing.url, port: existing.port, token: existing.token, started: false };
        return { url: 'http://127.0.0.1:0/?t=pending', port: 0, token: '', started: false };
    }
    if (existing)
        (0, registry_1.clearServerRecord)(cwd, env);
    const childPid = launch(cwd, env);
    const deadline = Date.now() + (options.readyTimeoutMs ?? 4000);
    for (;;) {
        const rec = (0, registry_1.readServerRecord)(cwd, env);
        if (rec && (childPid <= 0 || rec.pid === childPid)) {
            return { url: rec.url, port: rec.port, token: rec.token, started: true };
        }
        if (Date.now() >= deadline) {
            if (rec)
                return { url: rec.url, port: rec.port, token: rec.token, started: true };
            throw new Error('traffic-one onboarding server did not become ready');
        }
        sleepSync(50);
    }
}
