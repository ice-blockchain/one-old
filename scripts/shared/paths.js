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
const PROJECT_MARKERS = ['.git', 'package.json', '.traffic-one', '.traffic-one.json'];
function findUp(startDir) {
    let dir = startDir;
    for (;;) {
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
function projectRoot(input) {
    const hint = input.tool?.filePath
        ? path.dirname(path.resolve(input.cwd, input.tool.filePath))
        : input.cwd;
    return findUp(hint) ?? findUp(input.cwd) ?? input.cwd;
}
function stateFile(root) {
    return path.join(root, '.traffic-one', '.one.json');
}
exports.paths = { pluginRoot, projectRoot, stateFile };
