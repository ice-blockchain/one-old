"use strict";
// src/runners/onboarding-server/launch-config.ts
// Register the running wizard in <cwd>/.claude/launch.json so Claude Code's
// preview tool — preview_start with name "traffic-one-setup" — shows it in the
// IN-APP preview pane (no external browser). preview_start reuses a server already
// listening on the configured port, so it attaches to the gate-spawned wizard.
// Best-effort and merge-preserving: the user's own launch configs are untouched,
// and our entry is removed again when the wizard shuts down.
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
exports.writeLaunchConfig = writeLaunchConfig;
exports.removeLaunchConfig = removeLaunchConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("../../shared/paths");
const ENTRY_NAME = 'traffic-one-setup';
function launchPath(cwd) {
    return path.join(cwd, '.claude', 'launch.json');
}
function readLaunch(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    }
    catch {
        // missing or invalid → start fresh
    }
    return { version: '0.0.1', configurations: [] };
}
function wizardScriptPath() {
    const arg = process.argv[1];
    if (typeof arg === 'string' && arg.endsWith('onboarding-server.cjs'))
        return arg;
    return path.join((0, paths_1.pluginRoot)(), 'scripts', 'onboarding-server.cjs');
}
function writeLaunchConfig(cwd, port) {
    if (!Number.isInteger(port) || port <= 0)
        return;
    try {
        const file = launchPath(cwd);
        const data = readLaunch(file);
        const configs = (Array.isArray(data.configurations) ? data.configurations : [])
            .filter((c) => c && c.name !== ENTRY_NAME);
        configs.push({
            name: ENTRY_NAME,
            runtimeExecutable: process.execPath,
            runtimeArgs: [wizardScriptPath(), cwd, '--port', String(port)],
            port,
        });
        data.configurations = configs;
        if (!data.version)
            data.version = '0.0.1';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }
    catch {
        // best-effort; the clickable URL is always the fallback
    }
}
function removeLaunchConfig(cwd) {
    try {
        const file = launchPath(cwd);
        if (!fs.existsSync(file))
            return;
        const data = readLaunch(file);
        if (!Array.isArray(data.configurations))
            return;
        const next = data.configurations.filter((c) => c && c.name !== ENTRY_NAME);
        if (next.length === data.configurations.length)
            return;
        data.configurations = next;
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }
    catch {
        // best-effort
    }
}
