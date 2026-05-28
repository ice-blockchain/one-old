"use strict";
// src/shared/paths.ts
// The ONE path layer. pluginRoot resolves the repo/install root (env override →
// __dirname), and the same relative depth holds whether running from src/shared
// (tsx dev) or scripts/shared (compiled). projectRoot is hint-aware: it prefers
// the directory of a tool's target file (PostToolUse materialisation derives the
// project from the edited path, not cwd).
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
exports.paths = void 0;
exports.pluginRoot = pluginRoot;
exports.isManagedPluginCachePath = isManagedPluginCachePath;
exports.isInPluginCache = isInPluginCache;
exports.projectRoot = projectRoot;
exports.stateFile = stateFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const PLUGIN_ROOT_ENV = [
    'TRAFFIC_ONE_PLUGIN_ROOT',
    'CODEX_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_ROOT',
    'CURSOR_PLUGIN_ROOT',
];
function pluginRoot() {
    for (const key of PLUGIN_ROOT_ENV) {
        const value = process.env[key];
        if (value)
            return value;
    }
    // src/shared/paths.ts → ../../ = repo root; scripts/shared/paths.js → ../../ = repo root.
    return path.resolve(__dirname, '..', '..');
}
function isManagedPluginCachePath(root) {
    return [
        `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`,
        `${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`,
    ].some((marker) => root.includes(marker));
}
function isInPluginCache() {
    return isManagedPluginCachePath(pluginRoot());
}
const PROJECT_MARKERS = [
    path.join('.traffic-one', '.one.json'),
    '.traffic-one',
    'package.json',
    'go.mod',
    'pyproject.toml',
    'Cargo.toml',
    'deno.json',
    'deno.jsonc',
    'bun.lockb',
    'pnpm-lock.yaml',
    '.git',
];
function isInsideOrEqual(candidate, boundary) {
    const rel = path.relative(boundary, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function existingDirectoryForHint(absPath) {
    let current = absPath;
    try {
        if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory())
            current = path.dirname(current);
    }
    catch {
        current = path.dirname(current);
    }
    return current;
}
function findUp(startDir, boundary) {
    let dir = startDir;
    for (;;) {
        if (boundary && !isInsideOrEqual(dir, boundary))
            return null;
        for (const marker of PROJECT_MARKERS) {
            try {
                if (fs.existsSync(path.join(dir, marker)))
                    return dir;
            }
            catch {
                // ignore and keep walking
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
function safeRealpath(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return path.resolve(value);
    }
}
function hostBoundary(cwd) {
    return safeRealpath(path.resolve(cwd));
}
function candidateRootFromHint(cwd, hint, boundary, baseDir = cwd) {
    const raw = String(hint || '').trim();
    if (!raw || raw.startsWith('-') || raw.includes('://') || raw.includes('$'))
        return null;
    const cleaned = raw.replace(/^["'`]+|["'`,;]+$/g, '').replace(/\\ /g, ' ');
    if (!cleaned || cleaned.startsWith('-') || cleaned.includes('://') || cleaned.includes('$'))
        return null;
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(baseDir, cleaned);
    const resolved = safeRealpath(existingDirectoryForHint(abs));
    if (!isInsideOrEqual(resolved, boundary))
        return null;
    return findUp(resolved, boundary);
}
function promptPathHints(prompt, cwd) {
    const text = typeof prompt === 'string' ? prompt : '';
    if (!text)
        return [];
    const hints = [];
    const seen = new Set();
    const add = (candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed || seen.has(trimmed))
            return;
        const abs = path.resolve(cwd, trimmed);
        try {
            if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) {
                seen.add(trimmed);
                hints.push(trimmed);
            }
        }
        catch {
            // ignore bad prompt hints
        }
    };
    const quoted = /\b(?:in|inside|under|within|for)\s+["'`]([^"'`]+)["'`]/gi;
    for (const match of text.matchAll(quoted))
        add(match[1] || '');
    const bare = /\b(?:in|inside|under|within|for)\s+((?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)(?=$|[\s,.;:!?])/gi;
    for (const match of text.matchAll(bare))
        add(match[1] || '');
    return hints;
}
function projectRoot(input) {
    const cwd = path.resolve(input.cwd || process.cwd());
    const boundary = hostBoundary(cwd);
    const workdirRoot = input.tool?.workdir
        ? candidateRootFromHint(cwd, input.tool.workdir, boundary)
        : null;
    if (workdirRoot)
        return workdirRoot;
    const fileBase = input.tool?.workdir && !path.isAbsolute(input.tool.workdir)
        ? path.resolve(cwd, input.tool.workdir)
        : input.tool?.workdir || cwd;
    const fileRoot = input.tool?.filePath
        ? candidateRootFromHint(cwd, input.tool.filePath, boundary, fileBase)
        : null;
    if (fileRoot)
        return fileRoot;
    for (const hint of promptPathHints(input.prompt, cwd)) {
        const promptRoot = candidateRootFromHint(cwd, hint, boundary);
        if (promptRoot)
            return promptRoot;
    }
    return findUp(boundary, boundary) ?? cwd;
}
function stateFile(root) {
    return path.join(root, '.traffic-one', '.one.json');
}
exports.paths = { pluginRoot, projectRoot, stateFile };
