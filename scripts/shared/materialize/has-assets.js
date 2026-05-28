"use strict";
// src/shared/materialize/has-assets.ts
// Materialization presence checks. Ported 1:1 from
// scripts/hook-runtime/materialize/{hasMaterializedProjectAssets,isLeanMaterialization}.cjs.
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
exports.hasMaterializedProjectAssets = hasMaterializedProjectAssets;
exports.isLeanMaterialization = isLeanMaterialization;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const generated_1 = require("./generated");
function hasMaterializedProjectAssets(cwd, state) {
    const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
    let manifest;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return false;
        manifest = parsed;
    }
    catch {
        return false;
    }
    if (manifest.generatedBy !== 'traffic-one')
        return false;
    if (state && typeof manifest.stack === 'string' && state.stack && manifest.stack !== state.stack)
        return false;
    const rules = manifest.rules;
    const skills = manifest.skills;
    if (!Array.isArray(rules) || rules.length === 0)
        return false;
    if (!Array.isArray(skills) || skills.length === 0)
        return false;
    if (!fs.existsSync(path.join(cwd, 'AGENTS.md')) || !(0, generated_1.isGenerated)(path.join(cwd, 'AGENTS.md')))
        return false;
    if (!fs.existsSync(path.join(cwd, 'CLAUDE.md')))
        return false;
    for (const relPath of rules) {
        if (!fs.existsSync(path.join(cwd, '.traffic-one', relPath)))
            return false;
    }
    for (const name of skills) {
        if (!fs.existsSync(path.join(cwd, '.traffic-one', 'skills', name, 'SKILL.md')))
            return false;
    }
    return true;
}
function isLeanMaterialization(_cwd, state) {
    if (state && (state.leanMode === false || state.contextMode === 'full' || state.tokenProfile === 'full')) {
        return false;
    }
    return true;
}
