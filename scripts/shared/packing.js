"use strict";
// src/shared/packing.ts
// SessionStart context bundles — pointer-only (rules are materialized to
// .traffic-one/ and read on demand). Ported 1:1 from scripts/hook-runtime/packing.cjs.
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
exports.packBundle = packBundle;
exports.packRuleIndex = packRuleIndex;
exports.roleDigestName = roleDigestName;
exports.packFixCycleHeader = packFixCycleHeader;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const template_path_1 = require("./stacks/template-path");
function packBundle(root, mandatory, optional) {
    const lines = [
        '## Active rules (read on demand)',
        '',
        'Materialized at `.traffic-one/rules/...` and `.traffic-one/core.md`.',
        'Read specific rules via the Read tool when their guidance applies.',
        '',
        '### Mandatory',
    ];
    const included = [];
    for (const rel of mandatory) {
        if (!fs.existsSync(path.join(root, (0, template_path_1.templatePath)(rel))))
            continue;
        lines.push(`- .traffic-one/${rel}`);
        included.push(rel);
    }
    if (Array.isArray(optional) && optional.length > 0) {
        lines.push('');
        lines.push('### Optional (load when touching matching files)');
        for (const rel of optional) {
            if (!fs.existsSync(path.join(root, (0, template_path_1.templatePath)(rel))))
                continue;
            lines.push(`- .traffic-one/${rel}`);
            included.push(rel);
        }
    }
    return { body: `${lines.join('\n')}\n`, included };
}
function packRuleIndex(root, rules) {
    const lines = [
        '## Active rule index (read on demand)',
        '',
        'Full rule content is materialized at `.traffic-one/<path>`.',
        'Use the Read tool to load a specific rule when its guidance is needed.',
        '',
    ];
    const included = [];
    for (const rel of rules) {
        if (!fs.existsSync(path.join(root, (0, template_path_1.templatePath)(rel))))
            continue;
        lines.push(`- .traffic-one/${rel}`);
        included.push(rel);
    }
    return { body: `${lines.join('\n')}\n`, included };
}
function roleDigestName(role) {
    if (!role || typeof role !== 'string')
        return 'agent';
    const match = /^senior-(.+)$/.exec(role);
    return match && match[1] ? match[1] : role;
}
function packFixCycleHeader(_cwd, role, runId, spawnIndex) {
    const fixCycleFile = `.traffic-one/fix-cycles/${runId}/${role}-fix-${spawnIndex - 1}.md`;
    const digestFile = `.traffic-one/digests/${runId}/${roleDigestName(role)}.md`;
    const lines = [
        `═══ traffic-one — ${role} FIX-CYCLE #${spawnIndex - 1} (run ${runId}) ═══`,
        '',
        '[fix-cycle] You previously ran in this orchestrator run; apply only the targeted fixes below.',
        '',
        '1. Read the fix-cycle context (exact reviewer findings with file:line):',
        `   ${fixCycleFile}`,
        '',
        '2. Recall your prior work from your previous digest:',
        `   ${digestFile}`,
        '',
        '3. Apply ONLY the listed fixes. Do not re-explore the codebase, do not re-read source files except those the fix-cycle context names. Active rules are already loaded; do not re-import them.',
        '',
        `4. Re-emit your digest at ${digestFile} when done.`,
        '',
    ];
    return { body: `${lines.join('\n')}\n`, included: [] };
}
