// Charset-safe path segment for currentRunId (and any runs/<id> join).
//
// Leaf module: no imports from normalize, run-paths, local-prefs, or
// project-state-lock — those files cycle through each other. The charset is
// the same as run-agent/run-paths.ts `safePathSegment`; that function delegates
// here so the two cannot drift.

/**
 * Same charset and `.`/`..` rewrite as `safePathSegment`:
 * non `[a-zA-Z0-9._-]` → `_`, slice 160, `.` → `_`, `..` → `__`.
 * Callers that have already trimmed should pass the trimmed string.
 */
export function safeRunIdSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
  if (segment === '.') return '_';
  if (segment === '..') return '__';
  return segment;
}
