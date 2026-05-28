"use strict";
// src/runners/one-mcp-report/collectTechnologies.ts
// Technology list from declared state.technologies + dependency scan + file
// extensions. Ported 1:1 from one-mcp-report/collectTechnologies.cjs.
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
exports.collectTechnologies = collectTechnologies;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const lib_1 = require("./lib");
function collectTechnologies(cwd, state, fileExtensions) {
    const techs = new Set();
    const s = state && typeof state === 'object' ? state : {};
    const stateTech = s.technologies && typeof s.technologies === 'object' ? s.technologies : {};
    for (const values of Object.values(stateTech)) {
        if (!Array.isArray(values))
            continue;
        for (const value of values) {
            const normalized = String(value || '').trim().toLowerCase();
            if (normalized)
                techs.add(normalized);
        }
    }
    for (const dep of (0, lib_1.dependencyNames)(cwd))
        (0, lib_1.addTechForDependency)(techs, dep);
    if (fileExtensions.ts || fileExtensions.tsx)
        techs.add('typescript');
    if (fileExtensions.js || fileExtensions.jsx || fileExtensions.mjs || fileExtensions.cjs)
        techs.add('javascript');
    if (fileExtensions.go)
        techs.add('go');
    if (fileExtensions.rs)
        techs.add('rust');
    if (fileExtensions.py)
        techs.add('python');
    if (fileExtensions.kt || fileExtensions.kts)
        techs.add('kotlin');
    if (fileExtensions.swift)
        techs.add('swift');
    if (fileExtensions.dart)
        techs.add('dart');
    if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')))
        techs.add('pnpm');
    return [...techs].filter(Boolean).sort().slice(0, 50);
}
