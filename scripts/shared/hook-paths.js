"use strict";
// src/shared/hook-paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.
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
exports.stateRequiresNewProjectMonorepo = stateRequiresNewProjectMonorepo;
exports.findProjectRootForHookFile = findProjectRootForHookFile;
exports.projectRelativeHookPath = projectRelativeHookPath;
exports.packageJsonDeclaresWorkspace = packageJsonDeclaresWorkspace;
const path = __importStar(require("path"));
const state_1 = require("./state");
const tool_classify_1 = require("./tool-classify");
function stateRequiresNewProjectMonorepo(state) {
    if (!state || state.mode !== 'new-project' || (0, state_1.isNativeState)(state))
        return false;
    if (state.stack === 'default' || state.stack === 'react-realtime-monorepo')
        return true;
    return state.frontend === 'react-vite' && state.backend !== 'none';
}
// Walk up from the tool's target file to the nearest dir (within cwd) that has a
// .traffic-one state file — that's the project root for monorepo sub-apps.
function findProjectRootForHookFile(cwd, filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized)
        return cwd;
    const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
    const cwdAbs = path.resolve(cwd);
    let current = path.dirname(absPath);
    while (current.startsWith(cwdAbs)) {
        if ((0, tool_classify_1.hasStateFile)(current))
            return current;
        if (current === cwdAbs)
            break;
        current = path.dirname(current);
    }
    return cwd;
}
function projectRelativeHookPath(cwd, projectRoot, filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized)
        return '';
    const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
    const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    if (relative && !relative.startsWith('..') && relative !== '.')
        return relative;
    return normalized;
}
function packageJsonDeclaresWorkspace(content) {
    if (!content || !content.trim())
        return true;
    try {
        const pkg = JSON.parse(content);
        const workspaces = pkg && pkg.workspaces;
        const hasWorkspaces = Array.isArray(workspaces) || Boolean(workspaces && Array.isArray(workspaces.packages));
        const hasPnpmPackageManager = typeof pkg.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
        return pkg.private === true && hasWorkspaces && hasPnpmPackageManager;
    }
    catch {
        return true;
    }
}
