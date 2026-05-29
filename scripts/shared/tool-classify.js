"use strict";
// src/shared/tool-classify.ts
// Tool-name + command + state-file classification used by the onboarding/
// post-stack gates. Ported 1:1 from the helpers in
// scripts/hook-runtime/handlers/_helpers.cjs.
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
exports.normalizedToolName = normalizedToolName;
exports.isShellToolName = isShellToolName;
exports.isWriteLikeToolName = isWriteLikeToolName;
exports.commandFromToolInput = commandFromToolInput;
exports.isStateFilePath = isStateFilePath;
exports.hasStateFile = hasStateFile;
exports.existingStateFilePath = existingStateFilePath;
exports.patchTextFromToolInput = patchTextFromToolInput;
exports.isStateFileOnlyPatch = isStateFileOnlyPatch;
exports.isMutatingPreToolUse = isMutatingPreToolUse;
exports.isReadOnlyOrientationToolUse = isReadOnlyOrientationToolUse;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const state_1 = require("./state");
function normalizedToolName(toolName) {
    const raw = String(toolName || '');
    return raw.includes('.') ? raw.split('.').pop() : raw;
}
function isShellToolName(toolName = '') {
    return /^(Bash|exec_command)$/i.test(normalizedToolName(toolName));
}
function isWriteLikeToolName(toolName = '') {
    return /^(Write|Edit|MultiEdit|apply_patch)$/i.test(normalizedToolName(toolName));
}
function commandFromToolInput(toolInput) {
    if (!toolInput || typeof toolInput !== 'object')
        return '';
    const ti = toolInput;
    if (typeof ti.command === 'string')
        return ti.command;
    if (typeof ti.cmd === 'string')
        return ti.cmd;
    return '';
}
function isStateFilePath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const stateFile = config_1.STATE_FILE.split(path.sep).join('/');
    return normalized === stateFile
        || normalized.endsWith(`/${stateFile}`)
        || normalized === config_1.LEGACY_STATE_FILE
        || normalized.endsWith(`/${config_1.LEGACY_STATE_FILE}`);
}
function hasStateFile(cwd) {
    return fs.existsSync(path.join(cwd, config_1.STATE_FILE)) || fs.existsSync(path.join(cwd, config_1.LEGACY_STATE_FILE));
}
function existingStateFilePath(cwd) {
    const nextPath = (0, state_1.statePath)(cwd);
    return fs.existsSync(nextPath) ? nextPath : (0, state_1.legacyStatePath)(cwd);
}
function patchTextFromToolInput(toolInput) {
    if (typeof toolInput === 'string')
        return toolInput;
    if (!toolInput || typeof toolInput !== 'object')
        return '';
    const ti = toolInput;
    for (const key of ['patch', 'input', 'content', 'text']) {
        if (typeof ti[key] === 'string')
            return ti[key];
    }
    return '';
}
function patchTouchedFiles(patchText) {
    const files = [];
    for (const line of String(patchText || '').split(/\r?\n/)) {
        const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/);
        if (match)
            files.push(match[1].trim());
    }
    return files;
}
function isStateFileOnlyPatch(toolName, toolInput) {
    if (!/^apply_patch$/i.test(normalizedToolName(toolName)))
        return false;
    const files = patchTouchedFiles(patchTextFromToolInput(toolInput));
    return files.length > 0 && files.every((f) => isStateFilePath(f));
}
function isMutatingPreToolUse(toolName, toolInput) {
    const ti = toolInput && typeof toolInput === 'object' ? toolInput : null;
    const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
    if (isWriteLikeToolName(name))
        return true;
    if (ti && ('content' in ti || 'new_string' in ti || 'old_string' in ti || 'edits' in ti))
        return true;
    if (!isShellToolName(name))
        return false;
    const command = commandFromToolInput(toolInput);
    return /(^|[\s;&|])(mkdir|touch|rm|mv|cp|tee|npm\s+(install|i|add|create)|pnpm\s+(install|add|create)|yarn\s+(install|add|create)|bun\s+(install|add|create)|npx|git\s+(init|add|commit)|sed\s+-i)\b/.test(command)
        || />{1,2}/.test(command);
}
function isReadOnlyOrientationToolUse(toolName, toolInput) {
    const ti = toolInput && typeof toolInput === 'object' ? toolInput : null;
    const name = String(toolName || (ti && (ti.tool_name || ti.toolName)) || '');
    if (!name)
        return false;
    if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name)))
        return true;
    if (isShellToolName(name) && !isMutatingPreToolUse(name, toolInput))
        return true;
    return false;
}
