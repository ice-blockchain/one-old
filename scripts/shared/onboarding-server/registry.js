"use strict";
// src/shared/onboarding-server/registry.ts
// Per-project runtime record for the local onboarding wizard server. Lives next
// to the per-user project preferences (~/.traffic-one/projects/<hash>/...), so it
// honors TRAFFIC_ONE_PROJECT_PREFS_PATH in tests and is never committed. The
// detached server writes {pid,port,token,url} AFTER it starts listening; the gate's
// ensureOnboardingServer reads it back to decide reuse-vs-relaunch. A separate
// completion sentinel lets the next hook print a positive "setup complete" signal
// without re-deriving the full predicate chain.
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
exports.serverRecordPath = serverRecordPath;
exports.completionSentinelPath = completionSentinelPath;
exports.readServerRecord = readServerRecord;
exports.writeServerRecord = writeServerRecord;
exports.clearServerRecord = clearServerRecord;
exports.serverRecordExists = serverRecordExists;
exports.writeCompletionSentinel = writeCompletionSentinel;
exports.clearCompletionSentinel = clearCompletionSentinel;
exports.completionSentinelExists = completionSentinelExists;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const obj_1 = require("../obj");
const io_1 = require("../state/io");
const local_prefs_1 = require("../state/local-prefs");
function runtimeDir(cwd, env) {
    return path.dirname((0, local_prefs_1.projectPrefsPath)(cwd, env));
}
function serverRecordPath(cwd, env = process.env) {
    return path.join(runtimeDir(cwd, env), 'onboarding-server.json');
}
function completionSentinelPath(cwd, env = process.env) {
    return path.join(runtimeDir(cwd, env), 'onboarding-complete.json');
}
// 0700 dir + 0600 file, matching the auth-choice state writer — the token grants
// access to the wizard, so keep it readable only by the owning user.
function writeSecureJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // best-effort; some filesystems ignore chmod
    }
}
function readServerRecord(cwd, env = process.env) {
    const raw = (0, obj_1.obj)((0, fsjson_1.readJson)(serverRecordPath(cwd, env), null));
    if (!raw)
        return null;
    const pid = Number(raw.pid);
    const port = Number(raw.port);
    const token = typeof raw.token === 'string' ? raw.token : '';
    const url = typeof raw.url === 'string' ? raw.url : '';
    const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : '';
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (!Number.isInteger(port) || port <= 0)
        return null;
    if (!token || !url)
        return null;
    return { pid, port, token, url, startedAt };
}
function writeServerRecord(cwd, record, env = process.env) {
    writeSecureJson(serverRecordPath(cwd, env), record);
}
function clearServerRecord(cwd, env = process.env) {
    try {
        fs.unlinkSync(serverRecordPath(cwd, env));
    }
    catch {
        // already gone
    }
}
function serverRecordExists(cwd, env = process.env) {
    return readServerRecord(cwd, env) != null;
}
function writeCompletionSentinel(cwd, env = process.env) {
    writeSecureJson(completionSentinelPath(cwd, env), { completedAt: (0, io_1.stateTimestamp)() });
}
function clearCompletionSentinel(cwd, env = process.env) {
    try {
        fs.unlinkSync(completionSentinelPath(cwd, env));
    }
    catch {
        // already gone
    }
}
function completionSentinelExists(cwd, env = process.env) {
    return fs.existsSync(completionSentinelPath(cwd, env));
}
