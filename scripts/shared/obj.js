"use strict";
// src/shared/obj.ts
// Tiny shared helpers used across the engine: the `Rec` record alias and the
// `obj()` narrowing guard (plain object, not null/array). Consolidated here so
// the same two definitions aren't redeclared in every module.
Object.defineProperty(exports, "__esModule", { value: true });
exports.obj = obj;
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
