"use strict";
// src/shared/text.ts
// The ONE home for time + hash utilities (legacy had nowIso in 6 files and
// crypto.sha256 duplicated for auth-choice digests + project fingerprints).
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowIso = nowIso;
exports.nowIsoNoMs = nowIsoNoMs;
exports.sha256 = sha256;
exports.shortHash = shortHash;
const crypto_1 = require("crypto");
function nowIso() {
    return new Date().toISOString();
}
// Millisecond-stripped ISO (2026-05-28T12:00:00Z). The legacy state + auth
// writers used this on-disk format; keep it so stamped values match.
function nowIsoNoMs() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function sha256(input) {
    return (0, crypto_1.createHash)('sha256').update(input).digest('hex');
}
function shortHash(input, length = 12) {
    return sha256(input).slice(0, length);
}
