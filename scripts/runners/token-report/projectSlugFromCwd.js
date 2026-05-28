"use strict";
// src/runners/token-report/projectSlugFromCwd.ts
// Ported 1:1 from token-report/projectSlugFromCwd.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectSlugFromCwd = projectSlugFromCwd;
function projectSlugFromCwd(cwd) {
    return cwd.replace(/\//g, '-');
}
