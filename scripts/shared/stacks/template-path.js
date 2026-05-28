"use strict";
// src/shared/stacks/template-path.ts
// Logical rule namespace → on-disk source path. 'rules/foo.md' → 'rules-templates/foo.md'.
// Ported 1:1 from scripts/hook-runtime/stacks/templatePath.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.templatePath = templatePath;
function templatePath(relPath) {
    return relPath.replace(/^rules\//, 'rules-templates/');
}
