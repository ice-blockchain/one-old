"use strict";
// src/shared/authoring-root.ts
// Detects the plugin's OWN repo so the gate/materialiser never act on it.
// Ported from scripts/hook-runtime/materialize/{isPluginAuthoringRoot,_helpers}.cjs
// with the hook-runtime marker re-pointed to the surviving entry (scripts/
// hook-runtime.cjs) instead of the legacy handlers/handlers.cjs.
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
exports.hasPluginAuthoringMarkers = hasPluginAuthoringMarkers;
exports.isPluginAuthoringRoot = isPluginAuthoringRoot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("./paths");
function hasPluginAuthoringMarkers(root) {
    try {
        const claudeManifest = path.join(root, '.claude-plugin', 'plugin.json');
        const codexManifest = path.join(root, '.codex-plugin', 'plugin.json');
        const hookRuntime = path.join(root, 'scripts', 'hook-runtime.cjs');
        const authScript = path.join(root, 'scripts', 'traffic-one-auth.cjs');
        if (!fs.existsSync(hookRuntime) || !fs.existsSync(authScript))
            return false;
        const manifestPath = fs.existsSync(claudeManifest) ? claudeManifest : codexManifest;
        if (!fs.existsSync(manifestPath))
            return false;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return Boolean(manifest && manifest.name === 'traffic-one');
    }
    catch {
        return false;
    }
}
function isPluginAuthoringRoot(cwd) {
    const root = path.resolve(cwd);
    return root === path.resolve((0, paths_1.pluginRoot)()) || hasPluginAuthoringMarkers(root);
}
