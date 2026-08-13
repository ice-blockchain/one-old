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

// The literal placeholder spellings the orchestrator prose ships inside
// `runs/`/`digests/` paths: `<run-id>` in resources/prompt-templates.md,
// `<runId>`/`<currentRunId>` in the SKILL.md continuation/fix-cycle prompts
// (which reach the spawn gate as Task calls on Cursor). The SPAWN gate
// substitutes them with `currentRunId` in the text it CHECKS, so a
// template-faithful prompt is never denied (observed 6c: the first architect
// spawn of the run was denied on the literal placeholder). The plan-gate WRITE
// guard deliberately does NOT: a write to a literal `runs/<run-id>/…` path
// would strand state under a placeholder-named dir — exactly the split this
// module exists to prevent — so it must keep denying there.
const RUN_ID_PLACEHOLDERS = ['<run-id>', '<runId>', '<currentRunId>'] as const;

export function hasRunIdPlaceholder(text: unknown): boolean {
  const haystack = String(text ?? '');
  return RUN_ID_PLACEHOLDERS.some((placeholder) => haystack.includes(placeholder));
}

export function substituteRunIdPlaceholder(text: string, runId: string): string {
  const id = String(runId ?? '').trim();
  if (!id) return text;
  let out = text;
  for (const placeholder of RUN_ID_PLACEHOLDERS) out = out.split(placeholder).join(id);
  return out;
}

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
    // A DOT-PREFIXED segment is not a run id and never was. Run ids are
    // gate-minted epoch-ms numbers; the runs root also holds project-level
    // records that are deliberately NOT under a run — `.resets.json` (the reset
    // ledger, runners/traffic-one-reset/resets.ts) and `.once/` (session
    // markers, shared/once.ts) — and this function was reading both filenames as
    // fabricated run ids.
    //
    // That was not harmless, in either direction. The refusal it produced said
    // "this write targets run-id `.resets.json` … write under
    // `.traffic-one/runs/<currentRunId>/` instead", which is advice no writer of
    // that path can follow: there is no run directory it belongs in. And because
    // it was the ONLY thing refusing that path, the reset record's entire
    // defence was a misparse — conditional on `currentRunId` being set (this
    // function returns null without one), and silently removable by any future
    // author who narrowed this pattern correctly.
    //
    // So the misparse is gone and the record has a real fence instead:
    // `reset-record-owner-gate` (modules/plan-guard/plan-readiness/index.ts plus
    // plan-write/reset-record-shell.ts), which reads no run pointer and is
    // driven at the gate by __tests__/reset-record-fence.test.ts. What `.once/`
    // loses is an accidental refusal whose absence is fail-SAFE: a deleted
    // once-marker makes an advisory block emit AGAIN (shared/once.ts), so
    // nothing is unlocked by removing one.
    //
    // `.` and `..` keep their refusal: those are traversal rather than a name,
    // and `runs/../…` escaping the run tree is exactly the write-path split this
    // guard exists for.
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') continue;
    return segment;
  }
  return null;
}
