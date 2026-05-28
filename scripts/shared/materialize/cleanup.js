"use strict";
// src/shared/materialize/cleanup.ts
// Previous-manifest load + stale-asset cleanup + legacy migration helpers.
// Ported 1:1 from scripts/hook-runtime/materialize/_helpers.cjs.
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
exports.loadPreviousManifest = loadPreviousManifest;
exports.migrateLegacyMemoryFile = migrateLegacyMemoryFile;
exports.cleanupPrevious = cleanupPrevious;
exports.modeRulesForState = modeRulesForState;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const stacks_1 = require("../stacks");
const generated_1 = require("./generated");
function loadPreviousManifest(cwd) {
    const candidates = [
        path.join(cwd, '.traffic-one', 'manifest.json'),
        path.join(cwd, '.traffic-one', 'rules', 'manifest.json'),
    ];
    for (const manifestPath of candidates) {
        try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (parsed && typeof parsed === 'object')
                return parsed;
        }
        catch {
            // try the next candidate
        }
    }
    return {};
}
function migrateLegacyMemoryFile(cwd, fileName) {
    const legacyPath = path.join(cwd, '.traffic-one', 'rules', fileName);
    const targetPath = path.join(cwd, '.traffic-one', fileName);
    if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isDirectory())
        return false;
    if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.renameSync(legacyPath, targetPath);
        return true;
    }
    if ((0, fsjson_1.readText)(legacyPath) === (0, fsjson_1.readText)(targetPath)) {
        fs.rmSync(legacyPath, { force: true });
        return true;
    }
    return false;
}
function cleanupPrevious(cwd, previous, nextRulePaths, nextSkillNames) {
    let removed = 0;
    const projectMemoryRoot = path.join(cwd, '.traffic-one');
    const legacyActiveRoot = path.join(cwd, '.traffic-one', 'rules', 'active');
    const skillsRoot = path.join(cwd, '.traffic-one', 'skills');
    const prevRules = Array.isArray(previous.rules) ? previous.rules : [];
    for (const relPath of prevRules) {
        if ((0, generated_1.removeGeneratedFile)(path.join(legacyActiveRoot, relPath)))
            removed += 1;
        if (nextRulePaths.has(relPath))
            continue;
        if ((0, generated_1.removeGeneratedFile)(path.join(projectMemoryRoot, relPath)))
            removed += 1;
    }
    if ((0, generated_1.removeGeneratedTree)(legacyActiveRoot))
        removed += 1;
    if ((0, generated_1.removeGeneratedFile)(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md')))
        removed += 1;
    if ((0, generated_1.removeGeneratedManifest)(path.join(cwd, '.traffic-one', 'rules', 'manifest.json')))
        removed += 1;
    if (migrateLegacyMemoryFile(cwd, 'coding.md'))
        removed += 1;
    if (migrateLegacyMemoryFile(cwd, 'security.md'))
        removed += 1;
    const prevSkills = Array.isArray(previous.skills) ? previous.skills : [];
    for (const name of prevSkills) {
        if (nextSkillNames.has(name))
            continue;
        if ((0, generated_1.removeGeneratedSkillDir)(path.join(skillsRoot, name)))
            removed += 1;
    }
    return removed;
}
function modeRulesForState(root, state) {
    const mode = state && typeof state.mode === 'string' ? state.mode : '';
    if (!mode)
        return [];
    const relPath = `rules/modes/${mode}.md`;
    if (!fs.existsSync(path.join(root, (0, stacks_1.templatePath)(relPath))))
        return [];
    return [relPath];
}
