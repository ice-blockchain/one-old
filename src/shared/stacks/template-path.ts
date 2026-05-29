// src/shared/stacks/template-path.ts
// Logical rule namespace → on-disk source path. The source pool dir is `rules/`
// (renamed from the former `rules-templates/`), so logical `rules/foo.md` maps to
// itself — this is now identity. Kept as a function so callers stay stable and a
// future relocation only touches this one place.

export function templatePath(relPath: string): string {
  return relPath;
}
