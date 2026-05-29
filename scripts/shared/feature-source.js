"use strict";
// src/shared/feature-source.ts
// Feature-source write-ownership helpers used by the plan-write gate:
// which paths count as feature source, which Traffic One role owns a path, and
// how to extract write targets from apply_patch text / shell commands.
// Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FEATURE_SOURCE_RE = void 0;
exports.roleCanWriteFeatureSource = roleCanWriteFeatureSource;
exports.subagentMayWriteFeatureSource = subagentMayWriteFeatureSource;
exports.commandAppearsToWriteFeatureSource = commandAppearsToWriteFeatureSource;
exports.applyPatchTargetPaths = applyPatchTargetPaths;
const state_1 = require("./state");
// Paths the architecture gate treats as "feature source" (monorepo + flat layouts).
exports.FEATURE_SOURCE_RE = /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;
function roleCanWriteFeatureSource(role, filePath) {
    if (role === 'senior-frontend') {
        return /^(apps\/[^/]+\/(src|app)\/|packages\/(ui|i18n|utils)\/src\/)/.test(filePath);
    }
    if (role === 'senior-backend') {
        return /^(packages\/(api-client|ws-client|utils)\/src\/|services\/[^/]+\/src\/|apps\/[^/]+\/src\/(services|store)\/)/.test(filePath);
    }
    return false;
}
// Role ownership check. Prefer the per-agent run claim resolved from the current
// hook session id; fall back to the legacy shared activeAgentRole only for older
// projects that do not have .traffic-one/runs/<runId>/ state yet.
function subagentMayWriteFeatureSource(state, filePath, agentContext = null) {
    if (agentContext && agentContext.role) {
        return roleCanWriteFeatureSource(agentContext.role, filePath);
    }
    if (!(0, state_1.isSubagentSession)(state))
        return false;
    const role = (0, state_1.activeAgentRole)(state);
    if (role && roleCanWriteFeatureSource(role, filePath))
        return true;
    return roleCanWriteFeatureSource('senior-frontend', filePath)
        || roleCanWriteFeatureSource('senior-backend', filePath);
}
function commandAppearsToWriteFeatureSource(command) {
    if (typeof command !== 'string' || !command.trim())
        return false;
    const hasWritePrimitive = /(?:>|>>|\btee\b|\bcat\b[\s\S]*<<|\bpython3?\b|\bnode\b|\bperl\b|\bsed\b[\s\S]*-i)/.test(command);
    const mentionsFeaturePath = /(?:^|[\s'"`])(?:apps\/[^/\s'"`]+\/(?:src|app)\/|packages\/[^/\s'"`]+\/src\/|src\/|services\/[^/\s'"`]+\/src\/)/.test(command);
    return hasWritePrimitive && mentionsFeaturePath;
}
function applyPatchTargetPaths(patchText) {
    if (typeof patchText !== 'string' || !patchText.trim())
        return [];
    const paths = [];
    for (const line of patchText.split(/\r?\n/)) {
        const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
            || line.match(/^\*\*\* Move to: (.+)$/);
        if (match && match[1]) {
            paths.push(match[1].trim().replace(/\\/g, '/').replace(/^\.\//, ''));
        }
    }
    return paths;
}
