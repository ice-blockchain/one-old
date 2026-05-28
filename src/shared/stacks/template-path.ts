// src/shared/stacks/template-path.ts
// Logical rule namespace → on-disk source path. 'rules/foo.md' → 'rules-templates/foo.md'.
// Ported 1:1 from scripts/hook-runtime/stacks/templatePath.cjs.

export function templatePath(relPath: string): string {
  return relPath.replace(/^rules\//, 'rules-templates/');
}
