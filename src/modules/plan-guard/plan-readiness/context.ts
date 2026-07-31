// src/modules/plan-guard/plan-readiness/context.ts
// Shared shapes for the readiness gates: the Block prose contract, digest
// path regexes, and collapse-scan constants.

import * as fs from 'fs';
import * as path from 'path';

export type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
export type Block = (name: string, fallback: string, vars?: Vars) => string;

export const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
export const ASSIGNMENTS_FILE_RE = /(^|\/)\.traffic-one\/runs\/[^/]+\/assignments\.json$/;
export const ARCHITECTURE_INPUT_RE = /(^|\/)\.traffic-one\/runs\/([^/]+)\/architecture-input-v1\.json$/;
export const RUN_RUNTIME_SIDECAR_RE = /^\.traffic-one\/runs\/([^/]+)\/(.+)$/;
// NOTE: RUN_DIGEST_ARTIFACT_RE deliberately does NOT accept the `opencode-`
// prefix: it feeds the run-artifact OWNERSHIP gate, and edits to a plan-unit
// digest must stay writable by the parent. The COMPLETION regexes below DO
// accept `opencode-` so that ANY canonical verdict written into a plan-unit
// digest runs the full implementer gate battery (observed 8co:
// `opencode-frontend.md` matched no digest regex and bypassed every gate).
// The runner no longer emits a `normalize_to` hint on plan-unit digests — that
// hint was never applied in practice, and the file is now the accumulated
// ledger of ALL delegated units for the role, not the role's verdict — so this
// acceptance is defense in depth rather than the routine path.
export const RUN_DIGEST_ARTIFACT_RE =
  /^\.traffic-one\/digests\/([^/]+)\/(?:senior-)?(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
export const QA_REPORT_ARTIFACT_RE = /^\.traffic-one\/reports\/qa\/([^/]+)\/report-v2\.json$/;
export const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/architect\.md$/;
export const FRONTEND_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?frontend\.md$/;
export const IMPLEMENTER_DIGEST_RE =
  /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?(frontend|backend)\.md$/;
export const REVIEWER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?reviewer\.md$/;
// The orchestrator's verbatim transcription of the reviewer's findings for one
// role's fix cycle (`senior-eng-orchestrator` SKILL.md, "Fix-cycle follow-up"
// step 1). Same content, second surface — the satisfiability gate reads both,
// because the reviewer's digest and this file are the only two places a finding
// becomes a durable order.
export const FIX_CYCLE_CONTEXT_RE =
  /(^|\/)\.traffic-one\/fix-cycles\/([^/]+)\/[^/]+\.md$/;
export const TESTER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?tester\.md$/;
// Collapsed-source delivery guard. A single source line packing an entire
// component/route (observed 16c: apps/web/src/App.tsx held the whole app —
// Catalog, CoursePage, LessonPage, Dashboard, routing, data — as one-line
// functions up to 1722 chars, leaving every scaffolded pages/features/components
// dir empty; the frontend still reported IMPLEMENTED because build/typecheck
// pass on collapsed code). A hand-written code line does not approach this
// length; a long string/URL/data-URI has none of the statement/JSX punctuation
// required below, so the threshold is safe from false positives.
export const COLLAPSE_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|css|scss)$/;
export const COLLAPSE_SKIP_DIR_RE = /(^|\/)(node_modules|dist|build|coverage|out|\.turbo|\.next|\.vite|generated|__generated__)(\/|$)/;
export const COLLAPSE_LINE_CHARS = 500;
export const COLLAPSE_MAX_FILES = 600;

export function exists(projectRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relPath));
}
export function existsAny(projectRoot: string, relPaths: string[]): boolean {
  return relPaths.some((relPath) => exists(projectRoot, relPath));
}
export function readTrimmed(projectRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectRoot, relPath), 'utf8').trim();
  } catch {
    return null;
  }
}
