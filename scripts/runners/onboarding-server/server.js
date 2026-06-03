"use strict";
// src/runners/onboarding-server/server.ts
// The local onboarding wizard HTTP server. Binds loopback-only on an ephemeral
// port, guards every request with a 32-byte session token + Host/Origin checks
// (loopback hardening against DNS-rebind), and self-shuts-down on idle or on the
// completion route. In `standalone` mode (the detached production process) it
// publishes its {pid,port,token,url} to the registry after listen() and exits the
// process on shutdown; tests run with standalone:false and drive close() directly.
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
exports.shouldOpenBrowser = shouldOpenBrowser;
exports.startOnboardingServer = startOnboardingServer;
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const http = __importStar(require("http"));
const registry_1 = require("../../shared/onboarding-server/registry");
const io_1 = require("../../shared/state/io");
const routes_1 = require("./routes");
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
// Auto-open the wizard in the OS default browser by DEFAULT so it "just opens"
// rather than only printing a link (the agent additionally opens it inline where it
// has a preview/browser tool). Opt out with TRAFFIC_ONE_OPEN_BROWSER=0|false|no|off
// for headless/CI. Fire-and-forget; never throws — the clickable URL is the final
// fallback regardless.
function shouldOpenBrowser(env) {
    const flag = (env.TRAFFIC_ONE_OPEN_BROWSER || '').trim().toLowerCase();
    return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off');
}
function maybeOpenBrowser(url, env) {
    if (!shouldOpenBrowser(env))
        return;
    const opener = process.platform === 'darwin'
        ? { cmd: 'open', args: [url] }
        : process.platform === 'win32'
            ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
            : { cmd: 'xdg-open', args: [url] };
    try {
        (0, child_process_1.spawn)(opener.cmd, opener.args, { detached: true, stdio: 'ignore' }).unref();
    }
    catch {
        // best-effort; the clickable URL is the real surface
    }
}
function headerValue(value) {
    if (Array.isArray(value))
        return value[0] || '';
    return value || '';
}
function hostnameOf(hostHeader) {
    const trimmed = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
    return trimmed.replace(/^\[|\]$/g, '');
}
function requestHostOk(req) {
    const host = headerValue(req.headers.host);
    return host ? LOOPBACK_HOSTS.has(hostnameOf(host)) : false;
}
function requestOriginOk(req) {
    const origin = headerValue(req.headers.origin);
    if (!origin)
        return true;
    try {
        return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
    }
    catch {
        return false;
    }
}
function startOnboardingServer(options) {
    const env = options.env || process.env;
    const host = options.host || '127.0.0.1';
    const token = options.token || crypto.randomBytes(32).toString('hex');
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    const standalone = options.standalone ?? true;
    const cwd = options.cwd;
    let port = 0;
    let url = '';
    let idleTimer = null;
    let cleaned = false;
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (idleTimer)
                idleTimer.refresh();
            void route(req, res);
        });
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            if (standalone)
                (0, registry_1.clearServerRecord)(cwd, env);
        };
        const finish = () => {
            cleanup();
            server.close();
            // Let the in-flight response flush before the detached process exits.
            setTimeout(() => process.exit(0), 120).unref();
        };
        const close = () => new Promise((res) => {
            cleanup();
            server.close(() => res());
        });
        async function route(req, res) {
            try {
                if (!requestHostOk(req) || !requestOriginOk(req)) {
                    res.writeHead(403, { 'content-type': 'text/plain' });
                    res.end('forbidden');
                    return;
                }
                const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
                // Browsers auto-request /favicon.ico (no token) — answer 204 so it doesn't
                // surface a noisy 403 in the console.
                if (reqUrl.pathname === '/favicon.ico') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                const provided = headerValue(req.headers['x-t1-token']) || reqUrl.searchParams.get('t') || '';
                if (provided !== token) {
                    res.writeHead(403, { 'content-type': 'text/plain' });
                    res.end('forbidden');
                    return;
                }
                const ctx = { cwd, env, token, port, requestShutdown: standalone ? finish : cleanup };
                await (0, routes_1.dispatch)(req, res, reqUrl, ctx);
            }
            catch (err) {
                if (!res.headersSent)
                    res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'server error' }));
            }
        }
        server.on('error', (err) => {
            if (!port)
                reject(err);
        });
        server.listen(options.port ?? 0, host, () => {
            const addr = server.address();
            port = typeof addr === 'object' && addr ? addr.port : 0;
            url = `http://${host}:${port}/?t=${token}`;
            // Idle reaper: close (and, when standalone, exit) after inactivity. The
            // timer is refreshed on every request (see the request handler above).
            idleTimer = setTimeout(standalone ? finish : () => { void close(); }, idleMs);
            if (!standalone)
                idleTimer.unref();
            if (standalone) {
                const record = { pid: process.pid, port, token, url, startedAt: (0, io_1.stateTimestamp)() };
                try {
                    (0, registry_1.writeServerRecord)(cwd, record, env);
                }
                catch {
                    // best-effort; the agent can still be handed the URL from this process
                }
                for (const signal of ['SIGTERM', 'SIGINT']) {
                    process.on(signal, finish);
                }
                maybeOpenBrowser(url, env);
            }
            resolve({ server, host, port, token, url, close });
        });
    });
}
