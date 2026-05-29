"use strict";
// src/runners/one-mcp-report/lib.ts
// Low-level helpers for the one-mcp first-look report: constants, file-walk +
// skip rules, dependency scan, technology/component mapping, infra-vendor
// detection, and project-state IO. Ported 1:1 from one-mcp-report/_helpers.cjs
// (the network client + report-id mint live with the orchestration half). The
// legacy "hoisted forwarder" circular-dep workaround is removed: this module
// has no dependency on the collectors or the report-id reader.
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
exports.nowIso = exports.SKIP_FILES = exports.SKIP_DIRS = exports.FAILED_RETRY_MS = exports.QUEUED_RETRY_MS = exports.STATUS_FILE = exports.LEGACY_ID_FILE = exports.ONE_UID_FIELD = exports.DEFAULT_ENDPOINT = void 0;
exports.readText = readText;
exports.readJson = readJson;
exports.writeJson = writeJson;
exports.statePath = statePath;
exports.legacyStatePath = legacyStatePath;
exports.readProjectState = readProjectState;
exports.writeProjectState = writeProjectState;
exports.shouldSkipFile = shouldSkipFile;
exports.walkFiles = walkFiles;
exports.extensionFor = extensionFor;
exports.countLines = countLines;
exports.packageJsonFiles = packageJsonFiles;
exports.dependencyNames = dependencyNames;
exports.addTechForDependency = addTechForDependency;
exports.addComponent = addComponent;
exports.detectInfrastructureVendor = detectInfrastructureVendor;
exports.parseTimestamp = parseTimestamp;
exports.stateForReport = stateForReport;
exports.mcpRequest = mcpRequest;
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const config_1 = require("../../shared/config");
const buildMcpPayload_1 = require("./buildMcpPayload");
exports.DEFAULT_ENDPOINT = 'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/one-mcp';
exports.ONE_UID_FIELD = 'one-uid';
exports.LEGACY_ID_FILE = '.one-mcp-id';
exports.STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
exports.QUEUED_RETRY_MS = 5 * 60 * 1000;
exports.FAILED_RETRY_MS = 60 * 60 * 1000;
exports.SKIP_DIRS = new Set([
    '.cache', '.git', '.gitnexus', '.next', '.nuxt', '.traffic-one', '.turbo',
    'build', 'coverage', 'dist', 'graphify-out', 'node_modules', 'out', 'Pods', 'target', 'vendor',
]);
exports.SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
function readText(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function readJson(filePath, fallback = null) {
    const text = readText(filePath);
    if (text === null)
        return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function statePath(cwd) {
    return path.join(cwd, config_1.STATE_FILE);
}
function legacyStatePath(cwd) {
    return path.join(cwd, config_1.LEGACY_STATE_FILE);
}
function readProjectState(cwd) {
    const nextState = readJson(statePath(cwd), null);
    if (nextState && typeof nextState === 'object')
        return nextState;
    const legacyState = readJson(legacyStatePath(cwd), null);
    return legacyState && typeof legacyState === 'object' ? legacyState : {};
}
function writeProjectState(cwd, state) {
    writeJson(statePath(cwd), state && typeof state === 'object' ? state : {});
}
function shouldSkipFile(relPath, fileName) {
    const normalized = relPath.replace(/\\/g, '/');
    if (exports.SKIP_FILES.has(fileName))
        return true;
    if (/\.(min|bundle)\.(js|css)$/i.test(fileName))
        return true;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(fileName))
        return true;
    if (/\.g\.dart$/i.test(fileName) || /\.pb\.(go|ts|js)$/i.test(fileName))
        return true;
    if (/(^|\/)(__tests__|tests?|fixtures?|vendor)(\/|$)/i.test(normalized))
        return true;
    return false;
}
function walkFiles(cwd, visitor, relDir = '') {
    const dir = path.join(cwd, relDir);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (exports.SKIP_DIRS.has(entry.name))
                continue;
            walkFiles(cwd, visitor, path.join(relDir, entry.name));
            continue;
        }
        if (!entry.isFile())
            continue;
        const relPath = path.join(relDir, entry.name);
        if (shouldSkipFile(relPath, entry.name))
            continue;
        visitor(path.join(cwd, relPath), relPath);
    }
}
function extensionFor(filePath) {
    const base = path.basename(filePath);
    if (base === 'Dockerfile')
        return 'dockerfile';
    const ext = path.extname(base).replace(/^\./, '').toLowerCase();
    return ext && ext.length <= 64 ? ext : null;
}
function countLines(text) {
    if (!text)
        return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}
function packageJsonFiles(cwd) {
    const files = [];
    walkFiles(cwd, (absPath, relPath) => {
        if (path.basename(relPath) === 'package.json')
            files.push(absPath);
    });
    files.sort();
    return files;
}
function dependencyNames(cwd) {
    const names = new Set();
    for (const filePath of packageJsonFiles(cwd)) {
        const pkg = readJson(filePath, {});
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            const deps = pkg && pkg[section] && typeof pkg[section] === 'object' ? pkg[section] : {};
            for (const name of Object.keys(deps))
                names.add(name);
        }
        if (typeof pkg.packageManager === 'string') {
            const manager = pkg.packageManager.split('@')[0].toLowerCase();
            if (manager)
                names.add(`package-manager:${manager}`);
        }
    }
    return names;
}
function addTechForDependency(techs, dep) {
    const map = new Map([
        ['@nestjs/core', 'nestjs'], ['@reduxjs/toolkit', 'redux'], ['@supabase/ssr', 'supabase'],
        ['@supabase/supabase-js', 'supabase'], ['@tanstack/react-query', 'tanstack-query'], ['next', 'next.js'],
        ['posthog-js', 'posthog'], ['prisma', 'prisma'], ['react', 'react'], ['react-native', 'react-native'],
        ['tailwindcss', 'tailwindcss'], ['turbo', 'turborepo'], ['typescript', 'typescript'], ['vite', 'vite'],
        ['zustand', 'zustand'],
    ]);
    if (map.has(dep))
        techs.add(map.get(dep));
    if (dep === 'package-manager:pnpm')
        techs.add('pnpm');
    if (dep === 'package-manager:npm')
        techs.add('npm');
    if (dep === 'package-manager:yarn')
        techs.add('yarn');
}
function addComponent(components, seen, type, name, uses = []) {
    const key = `${type}:${name}`;
    if (seen.has(key))
        return;
    seen.add(key);
    if (type === 'custom_service')
        components.push({ type, name, uses });
    else
        components.push({ type, name });
}
function detectInfrastructureVendor(cwd) {
    const checks = [
        ['vercel.json', 'vercel'], ['netlify.toml', 'netlify'], ['wrangler.toml', 'cloudflare'],
        ['fly.toml', 'fly'], ['render.yaml', 'render'], ['railway.json', 'railway'],
    ];
    for (const [fileName, vendor] of checks) {
        if (fs.existsSync(path.join(cwd, fileName)))
            return vendor;
    }
    return 'unknown';
}
function parseTimestamp(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : 0;
}
// ms-stripped ISO timestamp (matches the legacy nowIso in this runner).
var text_1 = require("../../shared/text");
Object.defineProperty(exports, "nowIso", { enumerable: true, get: function () { return text_1.nowIsoNoMs; } });
function stateForReport(root, options = {}) {
    return options.state && typeof options.state === 'object' ? options.state : readProjectState(root);
}
// Fire-and-forget MCP tools/call POST. Resolves the response body on 2xx,
// rejects on non-2xx / error response / timeout. Ported 1:1 from
// one-mcp-report/_helpers.cjs (mcpRequest).
function mcpRequest(endpoint, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint);
        const body = JSON.stringify((0, buildMcpPayload_1.buildMcpPayload)(payload));
        const req = https.request({
            method: 'POST',
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            port: url.port || 443,
            headers: {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
                    return;
                }
                if (/"error"\s*:/.test(responseBody)) {
                    reject(new Error('MCP error response'));
                    return;
                }
                resolve(responseBody);
            });
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end(body);
    });
}
