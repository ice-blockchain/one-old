// src/runners/token-report/projectSlugFromCwd.ts
// Ported 1:1 from token-report/projectSlugFromCwd.cjs.

export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
