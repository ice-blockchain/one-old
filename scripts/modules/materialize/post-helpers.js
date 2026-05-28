"use strict";
// src/modules/materialize/post-helpers.ts
// Path/detection helpers for the PostToolUse dispatcher: resolve the project
// root a tool write targets (from file/command hints or a state-file path), and
// classify project-memory writes. Pure (fs reads only). Ported 1:1 from
// post.cjs + _helpers.cjs. The materialize-from-write convergence + the handler
// assembly land next.
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
exports.PROJECT_PATH_TOKEN_RE = exports.PROJECT_COMMAND_HINT_FIELDS = exports.PROJECT_ROOT_HINT_FIELDS = exports.DIGEST_HARD_BYTES = exports.DIGEST_PATH_RE = exports.FUNCTION_PATH_RE = void 0;
exports.projectRootForPathHint = projectRootForPathHint;
exports.projectRootsFromToolInputHints = projectRootsFromToolInputHints;
exports.projectRootFromStateFilePath = projectRootFromStateFilePath;
exports.isProjectMemoryWritePath = isProjectMemoryWritePath;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tool_classify_1 = require("../../shared/tool-classify");
// PostToolUse dispatch route patterns.
exports.FUNCTION_PATH_RE = /\/supabase\/functions\/([^/]+)\/(index|deno)\.(ts|tsx|mts|js)$/;
exports.DIGEST_PATH_RE = /(?:^|\/)\.traffic-one\/digests\/[^/]+\/(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
exports.DIGEST_HARD_BYTES = 3 * 1024; // warn over 3 KB; target is ≤2 KB
exports.PROJECT_ROOT_HINT_FIELDS = ['file_path', 'path', 'cwd', 'workdir'];
exports.PROJECT_COMMAND_HINT_FIELDS = ['command', 'cmd', 'shell_command'];
exports.PROJECT_PATH_TOKEN_RE = /(?:^|[\s"'`=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+(?:[A-Za-z0-9_.@-]+)?)(?=$|[\s"'`,;|&])/g;
// Walk up from a path hint to the nearest dir that carries a .traffic-one state
// file. Returns null for flags, URLs, var-expansions, or no enclosing project.
function projectRootForPathHint(cwd, hintPath) {
    const raw = String(hintPath || '').trim();
    if (!raw || raw.startsWith('-') || raw.includes('://'))
        return null;
    const cleaned = raw.replace(/^["'`]+|["'`,;]+$/g, '').replace(/\\ /g, ' ');
    if (!cleaned || cleaned.startsWith('-') || cleaned.includes('$'))
        return null;
    const absPath = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
    let current = absPath;
    if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) {
        current = path.dirname(current);
    }
    for (;;) {
        if ((0, tool_classify_1.hasStateFile)(current))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
// All distinct project roots referenced by a tool input's path/command hints.
function projectRootsFromToolInputHints(cwd, toolInput) {
    const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
    const roots = new Set();
    const addHint = (hint) => {
        const root = projectRootForPathHint(cwd, hint);
        if (root)
            roots.add(root);
    };
    for (const field of exports.PROJECT_ROOT_HINT_FIELDS) {
        if (typeof ti[field] === 'string')
            addHint(ti[field]);
    }
    for (const field of exports.PROJECT_COMMAND_HINT_FIELDS) {
        const command = typeof ti[field] === 'string' ? ti[field] : '';
        if (!command)
            continue;
        for (const match of command.matchAll(exports.PROJECT_PATH_TOKEN_RE))
            addHint(match[1]);
    }
    return [...roots];
}
// The project root that owns a `.traffic-one/.one.json` (or its parent dir).
function projectRootFromStateFilePath(filePath) {
    const absolute = path.resolve(filePath);
    const parent = path.dirname(absolute);
    if (path.basename(absolute) === '.one.json' && path.basename(parent) === '.traffic-one') {
        return path.dirname(parent);
    }
    return parent;
}
// True for writes into .traffic-one/ project memory (NOT digests/reports/backups/
// rules/skills/manifest — those are generated, not user memory).
function isProjectMemoryWritePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized.startsWith('.traffic-one/'))
        return false;
    if (normalized.startsWith('.traffic-one/digests/'))
        return false;
    if (normalized.startsWith('.traffic-one/reports/'))
        return false;
    if (normalized.startsWith('.traffic-one/backups/'))
        return false;
    if (normalized.startsWith('.traffic-one/rules/'))
        return false;
    if (normalized.startsWith('.traffic-one/skills/'))
        return false;
    return normalized !== '.traffic-one/manifest.json';
}
