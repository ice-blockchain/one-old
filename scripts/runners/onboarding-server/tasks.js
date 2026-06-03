"use strict";
// src/runners/onboarding-server/tasks.ts
// Per-question deterministic task runner. The code-graph step kicks the chosen
// provider's bootstrap (install + first scan, ~30-60s) which would block the
// single-threaded server if run inline — so it runs as an async child process and
// the wizard polls /task/:id for the loading state. The provider runner CLIs
// bootstrap process.cwd(), so the child's cwd is the project root. Tests inject a
// fast command via TRAFFIC_ONE_ONBOARDING_TASK_CMD ('noop' | 'fail' | <script>).
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
exports.startCodeGraphTask = startCodeGraphTask;
exports.getTask = getTask;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const paths_1 = require("../../shared/paths");
const tasks = new Map();
let counter = 0;
function resolveSpec(provider, cwd, env) {
    const override = env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
    if (override === 'noop')
        return { command: process.execPath, args: ['-e', ''] };
    if (override === 'fail')
        return { command: process.execPath, args: ['-e', 'process.exit(3)'] };
    if (override)
        return { command: process.execPath, args: [override, cwd] };
    return { command: process.execPath, args: [path.join((0, paths_1.pluginRoot)(), 'scripts', `${provider}-runner.cjs`)] };
}
function actionFrom(stdout, provider) {
    try {
        const parsed = JSON.parse(stdout.trim());
        return typeof parsed.action === 'string' ? parsed.action : `${provider}-bootstrap`;
    }
    catch {
        return `${provider}-bootstrap`;
    }
}
function finish(id, status, extra) {
    const current = tasks.get(id);
    if (!current)
        return;
    tasks.set(id, { ...current, status, finishedAt: Date.now(), ...extra });
}
function startCodeGraphTask(provider, cwd, env) {
    const id = `task-${++counter}`;
    tasks.set(id, { id, status: 'running', startedAt: Date.now() });
    const spec = resolveSpec(provider, cwd, env);
    let stdout = '';
    let stderr = '';
    try {
        const child = (0, child_process_1.spawn)(spec.command, spec.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', (err) => finish(id, 'error', { error: err.message }));
        child.on('exit', (code) => {
            if (code === 0)
                finish(id, 'done', { action: actionFrom(stdout, provider) });
            else
                finish(id, 'error', { error: stderr.trim() || `exited ${code}` });
        });
    }
    catch (err) {
        finish(id, 'error', { error: err.message });
    }
    return id;
}
function getTask(id) {
    return tasks.get(id) || null;
}
