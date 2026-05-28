"use strict";
// src/adapters/coerce.ts
// Tiny shared coercion helpers for host adapters parsing untyped wire JSON.
Object.defineProperty(exports, "__esModule", { value: true });
exports.asString = asString;
exports.asRecord = asRecord;
exports.firstString = firstString;
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim())
            return value;
    }
    return '';
}
