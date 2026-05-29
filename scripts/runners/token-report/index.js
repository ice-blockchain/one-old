"use strict";
// src/runners/token-report/index.ts
// CLI entry for the token-usage report (compiles to scripts/token-report.cjs).
// Ported 1:1 from scripts/token-report.cjs + parseArgs/selectTargetSessions
// (_helpers.cjs). Selects Claude / Codex sessions for the cwd/project, aggregates,
// and renders markdown (or --json) to --out or stdout.
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
exports.parseArgs = parseArgs;
exports.selectTargetSessions = selectTargetSessions;
exports.main = main;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const aggregate_1 = require("./aggregate");
const aggregateCodexSession_1 = require("./aggregateCodexSession");
const discovery_1 = require("./discovery");
const projectSlugFromCwd_1 = require("./projectSlugFromCwd");
const render_1 = require("./render");
function parseArgs(argv) {
    const out = { json: false, all: false, source: 'auto' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json')
            out.json = true;
        else if (arg === '--all')
            out.all = true;
        else if (arg === '--codex')
            out.source = 'codex';
        else if (arg === '--claude')
            out.source = 'claude';
        else if (arg === '--source') {
            out.source = argv[i + 1] || 'auto';
            i += 1;
        }
        else if (arg === '--session') {
            out.session = argv[i + 1];
            i += 1;
        }
        else if (arg === '--project') {
            out.project = argv[i + 1];
            i += 1;
        }
        else if (arg === '--out') {
            out.out = argv[i + 1];
            i += 1;
        }
        else if (arg === '--cwd') {
            out.cwd = argv[i + 1];
            i += 1;
        }
    }
    return out;
}
function selectTargetSessions(sessions, args, label) {
    if (args.session) {
        const match = sessions.find((s) => (s.id === args.session || path.basename(String(s.jsonl || s.parentJsonl || '')) === args.session));
        if (!match) {
            const list = sessions.slice(0, 5).map((s) => `  - ${s.id}`).join('\n');
            process.stderr.write(`Session ${args.session} not found in ${label}. Recent sessions:\n${list}\n`);
            process.exit(1);
        }
        return [match];
    }
    if (args.all)
        return sessions;
    return sessions.length > 0 ? [sessions[0]] : [];
}
function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const cwd = args.cwd || process.cwd();
    const projectSlug = args.project || (0, projectSlugFromCwd_1.projectSlugFromCwd)(cwd);
    const source = ['auto', 'claude', 'codex'].includes(args.source) ? args.source : 'auto';
    let reports = [];
    if (source === 'auto') {
        const mixedSessions = [
            ...(0, discovery_1.findSessionsForProject)(projectSlug).map((session) => ({ ...session, sourceType: 'claude' })),
            ...(0, discovery_1.findCodexSessionsForCwd)(cwd).map((session) => ({ ...session, sourceType: 'codex' })),
        ].sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (mixedSessions.length > 0) {
            reports = selectTargetSessions(mixedSessions, args, 'Claude Code or Codex Desktop transcripts').map(aggregate_1.aggregateBySource);
        }
    }
    else if (source === 'claude') {
        const claudeSessions = (0, discovery_1.findSessionsForProject)(projectSlug);
        if (claudeSessions.length > 0) {
            reports = selectTargetSessions(claudeSessions, args, 'Claude Code transcripts').map((s) => (0, aggregate_1.aggregateSession)(s));
        }
    }
    else if (source === 'codex') {
        const codexSessions = (0, discovery_1.findCodexSessionsForCwd)(cwd);
        if (codexSessions.length > 0) {
            reports = selectTargetSessions(codexSessions, args, 'Codex Desktop transcripts').map((s) => (0, aggregateCodexSession_1.aggregateCodexSession)(s));
        }
    }
    if (reports.length === 0) {
        const looked = source === 'codex'
            ? `Looked in: ${(0, discovery_1.findCodexSessionsDir)()}`
            : source === 'claude'
                ? `Looked in: ${path.join((0, discovery_1.findClaudeProjectsDir)(), projectSlug)}`
                : `Looked in: ${path.join((0, discovery_1.findClaudeProjectsDir)(), projectSlug)} and ${(0, discovery_1.findCodexSessionsDir)()}`;
        const label = source === 'auto' ? 'Claude Code or Codex Desktop' : source;
        const message = `No ${label} transcripts found for cwd: ${cwd}\n${looked}`;
        process.stdout.write(args.json ? `${JSON.stringify({ ok: false, error: message })}\n` : `${message}\n`);
        return;
    }
    const body = args.json ? `${JSON.stringify(reports, null, 2)}\n` : reports.map(render_1.renderMarkdown).join('\n---\n\n');
    if (args.out) {
        try {
            fs.mkdirSync(path.dirname(args.out), { recursive: true });
            fs.writeFileSync(args.out, body, 'utf8');
            process.stderr.write(`Report written to: ${args.out}\n`);
        }
        catch (err) {
            process.stderr.write(`Failed to write to ${args.out}: ${err.message}\n`);
            process.exit(1);
        }
    }
    else {
        process.stdout.write(body);
    }
}
if (require.main === module)
    main();
