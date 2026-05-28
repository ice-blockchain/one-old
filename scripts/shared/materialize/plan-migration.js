"use strict";
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
exports.migrateArchitectureDocsToPlan = migrateArchitectureDocsToPlan;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const PLAN_TEMPLATE = `# Traffic One Plan

## Goal
Unverified. Review the migrated legacy plan notes below.

## Stack & rationale
Unverified. Review the migrated legacy plan notes below.

## Module map
Unverified. Review the migrated legacy plan notes below.

## Public contracts
Unverified. Review the migrated legacy plan notes below.

## Risks
- Unverified. Review the migrated legacy plan notes below.

## Cut-list
Unverified. Review the migrated legacy plan notes below.
`;
function toPosix(value) {
    return value.replace(/\\/g, '/');
}
function legacyArchitectureDocs(cwd) {
    const candidates = [
        path.join(cwd, '.traffic-one', 'architecture.md'),
        path.join(cwd, 'architecture.md'),
    ];
    const packagesRoot = path.join(cwd, 'packages');
    if (fs.existsSync(packagesRoot)) {
        for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            candidates.push(path.join(packagesRoot, entry.name, 'architecture.md'));
        }
    }
    return candidates
        .filter((absPath) => fs.existsSync(absPath) && !fs.lstatSync(absPath).isDirectory())
        .map((absPath) => ({
        absPath,
        relPath: toPosix(path.relative(cwd, absPath)),
        content: (0, fsjson_1.readText)(absPath) ?? '',
    }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
}
function migratedBlock(docs, existingPlan) {
    const chunks = docs
        .filter((doc) => !existingPlan.includes(`### ${doc.relPath}`))
        .map((doc) => [
        `### ${doc.relPath}`,
        '',
        doc.content.trim() || '_Empty legacy file._',
        '',
    ].join('\n'));
    if (chunks.length === 0)
        return '';
    return [
        '## Migrated Legacy Plan Notes',
        '',
        'The sections below were migrated from legacy `architecture.md` files. Keep future planning, package responsibilities, and public contracts in this `plan.md` file.',
        '',
        ...chunks,
    ].join('\n').trimEnd();
}
function migrateArchitectureDocsToPlan(cwd) {
    const docs = legacyArchitectureDocs(cwd);
    if (docs.length === 0)
        return null;
    const planPath = path.join(cwd, '.traffic-one', 'plan.md');
    const existingPlan = (0, fsjson_1.readText)(planPath);
    const basePlan = (existingPlan && existingPlan.trim()) ? existingPlan.trimEnd() : PLAN_TEMPLATE.trimEnd();
    const block = migratedBlock(docs, basePlan);
    const nextPlan = block ? `${basePlan}\n\n${block}\n` : `${basePlan}\n`;
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    if (nextPlan !== existingPlan)
        fs.writeFileSync(planPath, nextPlan, 'utf8');
    for (const doc of docs)
        fs.rmSync(doc.absPath, { force: true });
    return {
        changed: nextPlan !== existingPlan || docs.length > 0,
        migrated: docs.map((doc) => doc.relPath),
        planPath,
    };
}
