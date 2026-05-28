"use strict";
// src/shared/fs-text.ts
// Generic text/path fs helpers shared by materialize + the generator (gen).
// Ported from the duplicated copies in materialize/_helpers.cjs + sync-cursor/_helpers.cjs.
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
exports.readText = void 0;
exports.toPosix = toPosix;
exports.writeTextIfChanged = writeTextIfChanged;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("./fsjson");
Object.defineProperty(exports, "readText", { enumerable: true, get: function () { return fsjson_1.readText; } });
function toPosix(filePath) {
    return filePath.split(path.sep).join('/');
}
// Write only when content differs (idempotent generation). Returns true if it wrote.
function writeTextIfChanged(filePath, content) {
    if (fs.existsSync(filePath) && (0, fsjson_1.readText)(filePath) === content)
        return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
}
