// src/shared/run-id-paths.ts
// Detect a run-id that diverges from `currentRunId` in tool write paths / shell
// commands. The build run-id MUST be the gate-minted epoch-ms `currentRunId`; a
// fabricated id (e.g. a `date -u` ISO string like 2026-06-17T12-09-40Z) splits run
// state across two `.traffic-one/runs/<id>` trees — assignments/digests land under
// the stray id while the run-team/opencode machinery keys off `currentRunId`. This
// powers the plan gate's run-id write-guard.

// Capture the <id> segment of any `.traffic-one/runs/<id>/…` or `…/digests/<id>/…`
// reference, in an absolute OR project-relative path (slashes normalized first).
const RUN_ID_PATH_RE = /\.traffic-one\/(?:runs|digests)\/([^/\s"'`\\]+)/g;

// The first run-id segment found in `text` (a path, a list joined by newlines, or a
// shell command) that is NOT equal to `currentRunId`. Returns null when there is no
// divergence, or when `currentRunId` is empty (nothing minted yet → can't enforce).
export function strayRunIdInText(text: unknown, currentRunId: unknown): string | null {
  const current = String(currentRunId ?? '').trim();
  if (!current) return null;
  const haystack = String(text ?? '').replace(/\\/g, '/');
  RUN_ID_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUN_ID_PATH_RE.exec(haystack)) !== null) {
    const segment = (match[1] || '').trim();
    if (!segment || segment === current) continue;
    // A shell glob/wildcard segment (`runs/*/`, `runs/?`, `runs/[0-9]*`, brace expansion) is an
    // INSPECTION across every run dir — e.g. `cat .traffic-one/runs/*/agents.json` — NOT a
    // fabricated run-id. The guard only exists to stop WRITES stranding state under a stray id;
    // a real run-id (epoch-ms) or even a `date`/ISO string never contains these glob chars, so
    // skipping them drops the read-glob false positive without weakening real-id detection.
    if (/[*?[\]{}]/.test(segment)) continue;
    return segment;
  }
  return null;
}
