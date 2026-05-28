"use strict";
// src/shared/materialize/graph-preview.ts
// Compact (~500 token) codebase-graph summary written to
// `.traffic-one/graph-preview.md` by the gitnexus/graphify runners, so subagent
// SessionStart bundles can inline a module listing instead of forcing each
// subagent to Read the full graph artefact to scope its work. Ported 1:1 from
// scripts/hook-runtime/materialize/{generateGraphPreview,writeGraphPreview}.cjs.
// (The reader, readGraphPreview, lives in src/modules/session/session-start-lib.)
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
exports.generateGraphPreview = generateGraphPreview;
exports.writeGraphPreview = writeGraphPreview;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const GRAPH_PREVIEW_MAX_BYTES = 2048;
const GRAPH_PREVIEW_MAX_MODULES = 30;
function generateGraphPreview(cwd, provider) {
    const lines = ['## Codebase graph preview', ''];
    if (provider === 'graphify') {
        const reportPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
        if (!fs.existsSync(reportPath))
            return null;
        let text;
        try {
            text = fs.readFileSync(reportPath, 'utf8');
        }
        catch {
            return null;
        }
        const modules = [];
        const headingRe = /^##\s+(.+?)\s*$/gm;
        let m;
        while ((m = headingRe.exec(text)) !== null) {
            const name = m[1];
            if (typeof name === 'string')
                modules.push(name);
        }
        lines.push(`Provider: graphify · ${modules.length} top-level section(s):`);
        for (const name of modules.slice(0, GRAPH_PREVIEW_MAX_MODULES))
            lines.push(`- ${name}`);
        if (modules.length > GRAPH_PREVIEW_MAX_MODULES) {
            lines.push(`- … +${modules.length - GRAPH_PREVIEW_MAX_MODULES} more`);
        }
        lines.push('');
        lines.push('Read `graphify-out/GRAPH_REPORT.md` for module-specific scoping.');
    }
    else if (provider === 'gitnexus') {
        const gnDir = path.join(cwd, '.gitnexus');
        if (!fs.existsSync(gnDir))
            return null;
        const indexPath = path.join(gnDir, 'index.json');
        let listed = false;
        if (fs.existsSync(indexPath)) {
            try {
                const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
                const rawModules = Array.isArray(idx.modules)
                    ? idx.modules.slice(0, GRAPH_PREVIEW_MAX_MODULES)
                    : [];
                if (rawModules.length > 0) {
                    lines.push(`Provider: gitnexus · ${rawModules.length} top-level module(s):`);
                    for (const mod of rawModules) {
                        const rec = mod && typeof mod === 'object' ? mod : null;
                        const label = rec && typeof rec.name === 'string'
                            ? rec.name
                            : rec && typeof rec.path === 'string'
                                ? rec.path
                                : String(mod);
                        lines.push(`- ${label}`);
                    }
                    listed = true;
                }
            }
            catch {
                // fall through to non-listed branch
            }
        }
        if (!listed) {
            lines.push('Provider: gitnexus · graph available at `.gitnexus/`');
        }
        lines.push('');
        lines.push('Read `.gitnexus/` artefacts for module-specific scoping.');
    }
    else {
        return null;
    }
    let body = `${lines.join('\n')}\n`;
    if (body.length > GRAPH_PREVIEW_MAX_BYTES) {
        body = `${body.slice(0, GRAPH_PREVIEW_MAX_BYTES - 80)}\n…[truncated; read the full graph artefact for the complete listing]\n`;
    }
    return body;
}
// Idempotent: writes .traffic-one/graph-preview.md when the graph artefact
// exists. Returns true on successful write, false when no graph or write fails.
function writeGraphPreview(cwd, provider) {
    const body = generateGraphPreview(cwd, provider);
    if (!body)
        return false;
    const dst = path.join(cwd, '.traffic-one', 'graph-preview.md');
    try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, body, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
