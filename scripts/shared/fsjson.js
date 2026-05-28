"use strict";
// src/shared/fsjson.ts
// The ONE JSON/text IO layer (legacy reimplemented readJson/parseJsonText/
// writeJson per runner). Implements the FsJson service consumed via Ctx.
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
exports.fsjson = void 0;
exports.parseJson = parseJson;
exports.readText = readText;
exports.readJson = readJson;
exports.writeJson = writeJson;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function parseJson(text, fallback) {
    try {
        const value = JSON.parse(String(text ?? '').trim() || 'null');
        return value == null ? fallback : value;
    }
    catch {
        return fallback;
    }
}
function readText(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function readJson(filePath, fallback) {
    const text = readText(filePath);
    return text == null ? fallback : parseJson(text, fallback);
}
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
exports.fsjson = { readText, readJson, writeJson };
