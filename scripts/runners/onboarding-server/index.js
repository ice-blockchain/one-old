"use strict";
// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.
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
exports.startOnboardingServer = void 0;
exports.main = main;
const http = __importStar(require("http"));
const server_1 = require("./server");
var server_2 = require("./server");
Object.defineProperty(exports, "startOnboardingServer", { enumerable: true, get: function () { return server_2.startOnboardingServer; } });
// Does our wizard already answer on this loopback port? (/healthz is token-free.)
function wizardResponds(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}
// Stay alive while the wizard on `port` keeps responding, then exit. Used by the
// preview-pane launcher so it has a managed, live process without binding the port.
function keepAliveWhileUp(port) {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            void wizardResponds(port).then((up) => {
                if (!up) {
                    clearInterval(timer);
                    resolve();
                }
            });
        }, 3000);
    });
}
async function main() {
    const args = process.argv.slice(2);
    const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
    // `--port <n>` lets Claude Code's preview_start launch on the port recorded in
    // .claude/launch.json; default 0 (kernel-assigned ephemeral).
    const portFlag = args.indexOf('--port');
    const port = portFlag >= 0 ? Number.parseInt(args[portFlag + 1] || '', 10) : Number.NaN;
    const hasPort = Number.isInteger(port) && port > 0;
    // `--attach`: when the editor's preview tool runs the launch.json command, the gate
    // has usually already spawned the wizard. Re-binding the port would crash with
    // EADDRINUSE (this is the "preview failed to start" bug). Instead, when the wizard
    // is already serving, stay alive next to it so preview_start has a managed process
    // pointing at the live port; only serve ourselves if nothing is up.
    if (args.includes('--attach') && hasPort && (await wizardResponds(port))) {
        await keepAliveWhileUp(port);
        return;
    }
    await (0, server_1.startOnboardingServer)({ cwd, standalone: true, ...(hasPort ? { port } : {}) });
}
if (require.main === module) {
    main().catch(() => {
        process.exitCode = 0;
    });
}
