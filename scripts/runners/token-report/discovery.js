"use strict";
// src/runners/token-report/discovery.ts
// Session + subagent discovery for the token report: walk ~/.claude/projects
// and ~/.codex/sessions. Ported 1:1 from token-report/_helpers.cjs +
// discoverSubagents/findSessionsForProject/findCodexSessionsForCwd/
// readCodexSessionMeta.
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
exports.readFirstLine = readFirstLine;
exports.pathsRelated = pathsRelated;
exports.findCodexSessionsDir = findCodexSessionsDir;
exports.walkCodexSessionFiles = walkCodexSessionFiles;
exports.findClaudeProjectsDir = findClaudeProjectsDir;
exports.discoverSubagents = discoverSubagents;
exports.findSessionsForProject = findSessionsForProject;
exports.readCodexSessionMeta = readCodexSessionMeta;
exports.findCodexSessionsForCwd = findCodexSessionsForCwd;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const lib_1 = require("./lib");
function readFirstLine(filePath, maxBytes = 4 * 1024 * 1024) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const chunks = [];
        let offset = 0;
        const buffer = Buffer.alloc(64 * 1024);
        while (offset < maxBytes) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (bytesRead <= 0)
                break;
            const chunk = buffer.subarray(0, bytesRead);
            const newline = chunk.indexOf(10);
            if (newline >= 0) {
                chunks.push(chunk.subarray(0, newline));
                break;
            }
            chunks.push(Buffer.from(chunk));
            offset += bytesRead;
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    catch {
        return '';
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* ignore */ }
        }
    }
}
function pathsRelated(left, right) {
    if (!left || !right)
        return false;
    const a = path.resolve(String(left));
    const b = path.resolve(String(right));
    return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
function findCodexSessionsDir() {
    return path.join(os.homedir(), '.codex', 'sessions');
}
function walkCodexSessionFiles(dir, out = []) {
    if (!fs.existsSync(dir))
        return out;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.'))
            continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
            walkCodexSessionFiles(fullPath, out);
        else if (entry.isFile() && entry.name.endsWith('.jsonl'))
            out.push(fullPath);
    }
    return out;
}
function findClaudeProjectsDir() {
    return path.join(os.homedir(), '.claude', 'projects');
}
function discoverSubagents(sessionDir) {
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (!fs.existsSync(subagentsDir))
        return [];
    let entries;
    try {
        entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl'))
            continue;
        const id = e.name.replace(/\.jsonl$/, '');
        const metaPath = path.join(subagentsDir, `${id}.meta.json`);
        let meta = {};
        if (fs.existsSync(metaPath)) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            }
            catch {
                meta = {};
            }
        }
        out.push({
            id,
            jsonl: path.join(subagentsDir, e.name),
            agentType: typeof meta.agentType === 'string' ? meta.agentType : 'unknown',
            description: typeof meta.description === 'string' ? meta.description : '',
        });
    }
    return out;
}
function findSessionsForProject(projectSlug) {
    const projectDir = path.join(findClaudeProjectsDir(), projectSlug);
    if (!fs.existsSync(projectDir))
        return [];
    let entries;
    try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.'))
            continue;
        const id = e.name;
        const parentJsonl = path.join(projectDir, `${id}.jsonl`);
        if (!fs.existsSync(parentJsonl))
            continue;
        let mtime = 0;
        try {
            mtime = fs.statSync(parentJsonl).mtimeMs;
        }
        catch {
            mtime = 0;
        }
        sessions.push({ id, dir: path.join(projectDir, id), parentJsonl, mtimeMs: mtime });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
}
function readCodexSessionMeta(filePath) {
    const line = readFirstLine(filePath).trim();
    if (!line)
        return null;
    try {
        const parsed = JSON.parse(line);
        if (!parsed || parsed.type !== 'session_meta')
            return null;
        const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        const str = (v) => (typeof v === 'string' ? v : undefined);
        return {
            id: str(payload.id) ?? (0, lib_1.codexSessionIdFromFile)(filePath),
            startedAt: (str(payload.timestamp) ?? str(parsed.timestamp)) ?? null,
            cwd: str(payload.cwd) ?? null,
            originator: str(payload.originator) ?? 'Codex Desktop',
            source: str(payload.source) ?? null,
            modelProvider: str(payload.model_provider) ?? null,
            model: str(payload.model) ?? 'codex',
        };
    }
    catch {
        return null;
    }
}
function findCodexSessionsForCwd(cwd, sessionsDir = findCodexSessionsDir()) {
    const sessions = [];
    for (const filePath of walkCodexSessionFiles(sessionsDir)) {
        const meta = readCodexSessionMeta(filePath);
        if (!meta || !pathsRelated(cwd, meta.cwd))
            continue;
        let mtime = 0;
        try {
            mtime = fs.statSync(filePath).mtimeMs;
        }
        catch {
            mtime = 0;
        }
        sessions.push({ ...meta, jsonl: filePath, mtimeMs: mtime });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
}
