"use strict";
// src/runners/one-mcp-report/hasRealCodebase.ts
// True when the cwd looks like a real project (not a snippet/example/single
// file). Ported 1:1 from one-mcp-report/hasRealCodebase.cjs.
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
exports.hasRealCodebase = hasRealCodebase;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function hasRealCodebase(cwd) {
    const directMarkers = [
        'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml',
        'pom.xml', 'build.gradle', 'pubspec.yaml', 'Package.swift',
    ];
    if (directMarkers.some((name) => fs.existsSync(path.join(cwd, name))))
        return true;
    const workspaceDirs = ['apps', 'packages', 'src', 'app', 'pages', 'supabase'];
    return workspaceDirs.some((name) => fs.existsSync(path.join(cwd, name)));
}
