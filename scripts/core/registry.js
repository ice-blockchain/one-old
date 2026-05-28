"use strict";
// src/core/registry.ts
// Module discovery: readdir the modules dir, read each module.json descriptor,
// and (for runtime modules) load the handlers the module exports. This is what
// makes "add a folder → it's wired in" work, with NO central HANDLERS map to
// edit. Unbundled output is what lets us readdir at runtime (a bundle couldn't).
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
exports.defaultModulesDir = defaultModulesDir;
exports.discoverDescriptors = discoverDescriptors;
exports.loadModules = loadModules;
exports.collectHandlers = collectHandlers;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../shared/fsjson");
function defaultModulesDir() {
    // registry.{ts→js} lives in core/; the modules sit next to core under BOTH
    // src/ (tsx dev/test) and the compiled scripts/ tree. Resolving via __dirname
    // (not pluginRoot/src) keeps discovery layout-agnostic — critical so the
    // compiled runtime loads scripts/modules/*/index.js and never reaches back
    // into src/ (which holds un-runnable .ts). A test may pass an override dir.
    return path.join(__dirname, '..', 'modules');
}
function discoverDescriptors(modulesDir) {
    let entries;
    try {
        entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(modulesDir, entry.name);
        const descriptor = (0, fsjson_1.readJson)(path.join(dir, 'module.json'), null);
        if (descriptor && typeof descriptor.id === 'string') {
            found.push({ descriptor, dir });
        }
    }
    found.sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
    return found;
}
function loadHandlers(dir, descriptor) {
    if (descriptor.kind !== 'runtime')
        return [];
    const entry = descriptor.entry ?? 'index';
    try {
        const mod = require(path.join(dir, entry));
        return Array.isArray(mod.handlers) ? mod.handlers : [];
    }
    catch {
        return [];
    }
}
function loadModules(modulesDir) {
    return discoverDescriptors(modulesDir).map(({ descriptor, dir }) => ({
        descriptor,
        dir,
        handlers: loadHandlers(dir, descriptor),
    }));
}
function collectHandlers(modules) {
    return modules.flatMap((module) => [...module.handlers]);
}
