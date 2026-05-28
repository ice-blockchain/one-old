"use strict";
// src/runners/one-mcp-report/uuidV7.ts
// UUID v7 (time-ordered) for the one-mcp report id. Ported 1:1 from
// one-mcp-report/uuidV7.cjs.
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
exports.uuidV7 = uuidV7;
const crypto = __importStar(require("crypto"));
function uuidV7(date = new Date()) {
    const millis = BigInt(date.getTime()).toString(16).padStart(12, '0').slice(-12);
    const random = crypto.randomBytes(10);
    const r0 = random[0];
    const r1 = random[1];
    const r2 = random[2];
    const r3 = random[3];
    const randA = (((r0 << 8) | r1) & 0x0fff).toString(16).padStart(3, '0');
    const variant = ((r2 & 0x3f) | 0x80).toString(16).padStart(2, '0');
    const tail = Buffer.from(random.subarray(4, 10)).toString('hex');
    return `${millis.slice(0, 8)}-${millis.slice(8)}-7${randA}-${variant}${r3.toString(16).padStart(2, '0')}-${tail}`;
}
